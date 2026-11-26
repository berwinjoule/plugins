import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, continueWithToolResults, createBridgeKit, readSse } from "./testkit.mjs"

function captureStderr() {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = function write(chunk, ...rest) {
    const text = String(chunk)
    if (text.startsWith("[agy-bridge] ")) {
      lines.push(JSON.parse(text.slice("[agy-bridge] ".length)))
      return true
    }
    return original.call(this, chunk, ...rest)
  }
  return { lines, restore: () => { process.stderr.write = original } }
}

function sessionNews(kit) {
  return kit.acpLog.filter((entry) => entry.method === "session/new").length
}

test("a strict prefix of the recorded history stays 503 and does not reclaim the live turn", async () => {
  const kit = await createBridgeKit()
  const err = captureStderr()
  try {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/snap.txt" })
      await agent.text("finished after the prefix retry")
    })
    const opening = baseBody({ messages: [{ role: "user", content: "snapshot prefix" }] })
    const step = await readSse(await kit.request(opening))
    assert.equal(step.stopReason, "tool_use")
    assert.equal(sessionNews(kit), 1)
    const proc = [...kit.module.__agyTestPool.values()][0]
    const turn = proc.turn
    assert.ok(turn)
    assert.ok(proc.expectedMessages.length > opening.messages.length)

    const retry = await kit.request(opening)
    assert.equal(retry.status, 503)
    await retry.text()
    assert.equal(proc.turn, turn)
    assert.equal(proc.retiring, false)
    assert.equal(turn.finalized, false)
    assert.equal(sessionNews(kit), 1)
    assert.ok(
      err.lines.some((line) => line.action === "reject_stale_snapshot" && line.reason === "prefix"),
      JSON.stringify(err.lines.map((line) => [line.action, line.reason])),
    )

    const done = await readSse(await kit.request(continueWithToolResults(opening, step, () => "file text")))
    assert.equal(done.stopReason, "end_turn")
    assert.equal(done.content.find((block) => block.type === "text")?.text, "finished after the prefix retry")
    assert.equal(sessionNews(kit), 1)
  } finally {
    err.restore()
    await kit.dispose()
  }
})

test("a rewritten branch of the same opening is not a stale snapshot and does not keep the pending turn", async () => {
  const kit = await createBridgeKit()
  const err = captureStderr()
  try {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/snap.txt" })
    })
    kit.prompts.push(async (agent) => {
      await agent.text("sibling session")
    })
    const opening = baseBody({ messages: [{ role: "user", content: "snapshot prefix" }] })
    const step = await readSse(await kit.request(opening))
    assert.equal(step.stopReason, "tool_use")
    const branched = {
      ...opening,
      messages: [
        ...opening.messages,
        { role: "user", content: "a different branch, not the recorded prefix" },
      ],
    }
    const next = await readSse(await kit.request(branched))
    assert.equal(next.stopReason, "end_turn")
    assert.equal(next.content.find((block) => block.type === "text")?.text, "sibling session")
    assert.equal(sessionNews(kit), 2)
    assert.equal(
      err.lines.some((line) => line.action === "reject_stale_snapshot"),
      false,
      JSON.stringify(err.lines.filter((line) => line.action === "reject_stale_snapshot")),
    )
  } finally {
    err.restore()
    await kit.dispose()
  }
})

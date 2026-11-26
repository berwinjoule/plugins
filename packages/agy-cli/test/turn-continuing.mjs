import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, continueWithToolResults, createBridgeKit, READ_TOOL, readSse } from "./testkit.mjs"

const EXTRA_TOOL = {
  name: "Glob",
  description: "Find files by pattern.",
  input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for test condition")
    await sleep(5)
  }
}

test("turn.continuing protects the live turn during await proc.updateTools against moved-on and LRU eviction", async () => {
  const kit = await createBridgeKit({
    env: {
      AGY_BRIDGE_MAX_PROCS: "1",
      AGY_BRIDGE_DETACHED_EVICT_MS: "10",
    },
  })
  try {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/relist.txt" })
      await agent.text("resumed after tool relist")
      return { stopReason: "end_turn" }
    })

    const body0 = baseBody({
      tools: [READ_TOOL, EXTRA_TOOL],
      messages: [{ role: "user", content: "start with two tools" }],
    })
    const step1 = await readSse(await kit.request(body0))
    assert.equal(step1.stopReason, "tool_use")
    const c1Id = step1.content.find((block) => block.type === "tool_use").id

    const proc = [...kit.module.__agyTestPool.values()][0]
    const turn = proc.turn
    assert.equal(proc.watchers.size, 1)
    const watcher = [...proc.watchers][0]
    const origWrite = watcher.write
    let releaseRelist = null
    watcher.write = function interceptWrite(data) {
      if (String(data).includes("tools_changed")) {
        releaseRelist = () => origWrite.call(this, data)
        return true
      }
      return origWrite.call(this, data)
    }

    const c1Body = {
      ...continueWithToolResults(body0, step1, () => "relist result"),
      tools: [READ_TOOL],
    }
    const continuingReq = kit.request(c1Body)
    await waitUntil(() => Boolean(releaseRelist) && turn.continuing === true)

    kit.clock.advance(50)
    assert.ok(kit.clock.now() - turn.clientProgressAt >= 10)

    const movedOnBody = {
      ...body0,
      tools: [READ_TOOL],
      messages: [
        ...body0.messages,
        { role: "assistant", content: [{ type: "tool_use", id: c1Id, name: "Read", input: { path: "/relist.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: c1Id, content: "relist result" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "call_foreign_1", name: "Read", input: { path: "/other.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_foreign_1", content: "other" }] },
      ],
    }
    const movedOnRes = await kit.request(movedOnBody)
    assert.equal(movedOnRes.status, 503)
    await movedOnRes.text()
    assert.equal(proc.turn, turn)
    assert.equal(proc.retiring, false)
    assert.equal(turn.finalized, false)

    const intruderRes = await kit.request(baseBody({ messages: [{ role: "user", content: "brand new conversation" }] }))
    assert.equal(intruderRes.status, 503)
    await intruderRes.text()
    assert.equal(proc.turn, turn)
    assert.equal(proc.retiring, false)
    assert.equal(turn.finalized, false)
    assert.equal(turn.continuing, true)
    assert.equal(kit.acpLog.filter((entry) => entry.method === "session/new").length, 1)

    releaseRelist()
    const done = await readSse(await continuingReq)
    assert.equal(done.stopReason, "end_turn")
    assert.equal(done.content.find((block) => block.type === "text")?.text, "resumed after tool relist")
    assert.equal(turn.continuing, false)
    assert.equal(kit.acpLog.filter((entry) => entry.method === "session/new").length, 1)
  } finally {
    await kit.dispose()
  }
})

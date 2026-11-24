// Fork integration regressions for the two defects reproduced against agy-cli 0.1.116.
// Uses the package testkit (fake ACP child, fake MCP sockets). No agy binary, auth, or network.
//
// Defect A: the attached/steering check happens before await updateTools, and the
// winner attaches only after continueWith. A second in-flight result can be
// committed and then rejected with 503.
// Defect B: an identical tool_result retry is compared as raw JSON against the
// notice-enriched call.result, so message_stop + detach still returns a false 409
// instead of replaying the same tool_use step.

import { test } from "node:test"
import assert from "node:assert/strict"
import { READ_TOOL, baseBody, continueWithToolResults, createBridgeKit, readSse, sleep } from "./testkit.mjs"

const EXTRA_TOOL = {
  name: "Glob",
  description: "Find files by pattern.",
  input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
}

async function withKit(options, fn) {
  const kit = await createBridgeKit(options)
  try {
    return await fn(kit)
  } finally {
    await kit.dispose()
  }
}

function promptCount(kit) {
  return kit.acpLog.filter((entry) => entry.method === "session/prompt").length
}

function sseMsgId(parsed) {
  return parsed.events.find((item) => item.event === "message_start")?.data?.message?.id ?? null
}

function assistantBlocks(parsed) {
  return parsed.content.map((block) => block.type === "tool_use"
    ? { type: "tool_use", id: block.id, name: block.name, input: block.input }
    : block.type === "thinking"
      ? { type: "thinking", thinking: block.thinking, signature: block.signature }
      : { type: "text", text: block.text })
}

function oneResult(body, parsed, block, content) {
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: "assistant", content: assistantBlocks(parsed) },
      { role: "user", content: [{ type: "tool_result", tool_use_id: block.id, content }] },
    ],
  }
}

async function waitUntil(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for test condition")
    await sleep(5)
  }
}

function armToolRelistHold(proc) {
  const watcher = [...proc.watchers][0]
  assert.ok(watcher, "expected the fake agy tool watch socket")
  const origWrite = watcher.write
  return new Promise((resolve) => {
    let release = null
    watcher.write = function intercept(data) {
      if (release === null && String(data).includes("tools_changed")) {
        release = () => origWrite.call(watcher, data)
        resolve(release)
        return true
      }
      return origWrite.call(watcher, data)
    }
  })
}

async function drain(response) {
  if (response.body && response.status === 200) {
    try { await response.body.cancel() } catch {}
    return
  }
  try { await response.text() } catch {}
}

test("split concurrent tool results commit only the accepted request", { timeout: 20_000 }, async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tools([["Read", { path: "/a.txt" }], ["Read", { path: "/b.txt" }]])
      await agent.text("both delivered")
      return { stopReason: "end_turn" }
    })
    const body0 = baseBody({ messages: [{ role: "user", content: "two pending tools" }] })
    const first = await readSse(await kit.request(body0))
    const tools = first.content.filter((block) => block.type === "tool_use")
    assert.equal(tools.length, 2)
    const turn = kit.turns[0]
    const bodyA = oneResult(body0, first, tools[0], "result-a")
    const bodyB = oneResult(body0, first, tools[1], "result-b")
    const [resA, resB] = await Promise.all([kit.request(bodyA), kit.request(bodyB)])
    const pair = [
      { res: resA, id: tools[0].id },
      { res: resB, id: tools[1].id },
    ]
    assert.deepEqual(pair.map((item) => item.res.status).sort((a, b) => a - b), [200, 503])
    for (const item of pair) {
      const call = turn.calls.find((candidate) => candidate.id === item.id)
      if (item.res.status === 503) {
        assert.equal(call.result, null, "rejected continuation committed its tool result")
        assert.equal(call.mcpResponded, false, "rejected continuation wrote MCP")
      } else {
        assert.equal(call.mcpResponded, true)
        assert.match(JSON.stringify(call.result), /result-/)
      }
    }
    assert.equal(turn.calls.filter((call) => call.mcpResponded).length, 1)
    assert.equal(kit.acpSpawns.length, 1)
    for (const item of pair) await drain(item.res)
  })
})

test("identical retry after message_stop replays the same tool step with zero usage", { timeout: 20_000 }, async () => {
  await withKit({}, async (kit) => {
    const delivered = []
    kit.prompts.push(async (agent) => {
      delivered.push(await agent.tool("Read", { path: "/notice.txt" }))
      await agent.thought("planning the next read")
      await agent.text("next read")
      await agent.tool("Read", { path: "/next.txt" })
      await agent.text("finished")
      return { stopReason: "end_turn", usage: { inputTokens: 80, outputTokens: 8 } }
    })
    const body0 = baseBody({ messages: [{ role: "user", content: "notice retry" }] })
    const first = await readSse(await kit.request(body0))
    const retryBody = continueWithToolResults(body0, first, () => "raw notice result")
    retryBody.messages.at(-1).content.push({
      type: "text",
      text: "<system-reminder>\nKeep this notice\n</system-reminder>",
    })
    const step = await readSse(await kit.request(retryBody))
    assert.equal(step.stopReason, "tool_use")
    const msgId = sseMsgId(step)
    assert.ok(msgId)
    const prompts = promptCount(kit)
    const replay = await readSse(await kit.request(retryBody))
    assert.equal(replay.stopReason, "tool_use")
    assert.equal(sseMsgId(replay), msgId)
    assert.equal(replay.model, step.model)
    assert.deepEqual(replay.content, step.content)
    assert.deepEqual(replay.usage, { input_tokens: 0, output_tokens: 0 })
    assert.equal(delivered.length, 1)
    assert.equal(promptCount(kit), prompts)
    assert.equal(kit.acpSpawns.length, 1)
    const texts = delivered[0]?.result?.content?.map((part) => part.text) || []
    assert.ok(texts.includes("raw notice result"))
    assert.ok(texts.some((text) => text.includes("Keep this notice")))
  })
})

test("abort during updateTools does not commit", { timeout: 20_000 }, async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/held.txt" })
      await agent.text("should not be reached after abort")
      return { stopReason: "end_turn" }
    })
    const body0 = baseBody({
      tools: [READ_TOOL, EXTRA_TOOL],
      messages: [{ role: "user", content: "abort during relist" }],
    })
    const first = await readSse(await kit.request(body0))
    const proc = [...kit.module.__agyTestPool.values()][0]
    const call = proc.turn.calls.find((item) => item.id === first.content.find((block) => block.type === "tool_use").id)
    const held = armToolRelistHold(proc)
    const controller = new AbortController()
    const shrinking = {
      ...continueWithToolResults(body0, first, () => "ABORT-RESULT"),
      tools: [READ_TOOL],
    }
    const pending = kit.request(shrinking, { signal: controller.signal })
    const release = await held
    controller.abort(new Error("client aborted during updateTools"))
    release()
    const aborted = await pending
    assert.equal(aborted.status, 200)
    await assert.rejects(() => aborted.text(), /client aborted during updateTools/)
    assert.equal(call.result, null, "aborted updateTools still committed")
    assert.equal(call.mcpResponded, false)
  })
})

test("owner retirement during updateTools does not commit", { timeout: 20_000 }, async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/retire.txt" })
      await agent.text("should not be reached after retirement")
      return { stopReason: "end_turn" }
    })
    const body0 = baseBody({
      tools: [READ_TOOL, EXTRA_TOOL],
      messages: [{ role: "user", content: "retire during relist" }],
    })
    const first = await readSse(await kit.request(body0))
    const proc = [...kit.module.__agyTestPool.values()][0]
    const call = proc.turn.calls.find((item) => item.id === first.content.find((block) => block.type === "tool_use").id)
    const held = armToolRelistHold(proc)
    const shrinking = {
      ...continueWithToolResults(body0, first, () => "RETIRE-RESULT"),
      tools: [READ_TOOL],
    }
    const pending = kit.request(shrinking)
    const release = await held
    proc.retiring = true
    release()
    const retired = await pending
    assert.equal(retired.status, 503)
    assert.match(await retired.text(), /no longer accepting results/)
    assert.equal(call.result, null, "retired owner still committed")
    assert.equal(call.mcpResponded, false)
  })
})

test("another user cannot commit the selected owner's tool while that owner is accepting", { timeout: 20_000 }, async () => {
  await withKit({}, async (kit) => {
    const delivered = []
    kit.prompts.push(async (agent) => {
      delivered.push(await agent.tool("Read", { path: "/owner.txt" }))
      await agent.text("owner finished")
      return { stopReason: "end_turn" }
    })
    kit.defaultPrompt = async (agent) => {
      await agent.text("other user fresh")
      return { stopReason: "end_turn" }
    }
    const body0 = baseBody({
      metadata: { user_id: "owner-user" },
      tools: [READ_TOOL, EXTRA_TOOL],
      messages: [{ role: "user", content: "owner task" }],
    })
    const first = await readSse(await kit.request(body0))
    const proc = [...kit.module.__agyTestPool.values()][0]
    const turn = proc.turn
    const call = turn.calls.find((item) => item.id === first.content.find((block) => block.type === "tool_use").id)
    const held = armToolRelistHold(proc)
    const ownerBody = {
      ...continueWithToolResults(body0, first, () => "OWNER-RESULT"),
      tools: [READ_TOOL],
    }
    const ownerReq = kit.request(ownerBody)
    const release = await held
    const seenAtHold = call.clientSeen
    const progressAtHold = turn.clientProgressAt
    const lastUsedAtHold = proc.lastUsed
    const intruder = {
      ...ownerBody,
      metadata: { user_id: "other-user" },
      messages: ownerBody.messages.map((message, index) => index === ownerBody.messages.length - 1
        ? {
          ...message,
          content: message.content.map((block) => block.type === "tool_result"
            ? { ...block, content: "INTRUDER-RESULT" }
            : block),
        }
        : message),
    }
    const intruderRes = await kit.request(intruder)
    assert.equal(call.result, null, "other user committed the owner tool during updateTools")
    assert.equal(call.mcpResponded, false)
    assert.equal(call.clientSeen, seenAtHold)
    assert.equal(turn.clientProgressAt, progressAtHold)
    assert.equal(proc.lastUsed, lastUsedAtHold)
    assert.equal(proc.turn, turn)
    release()
    const ownerDone = await readSse(await ownerReq)
    assert.equal(ownerDone.stopReason, "end_turn")
    assert.equal(delivered.length, 1)
    assert.match(JSON.stringify(delivered[0].result), /OWNER-RESULT/)
    assert.doesNotMatch(JSON.stringify(delivered[0].result), /INTRUDER-RESULT/)
    assert.equal(kit.acpSpawns.filter((spawn) => spawn).length >= 1, true)
    await drain(intruderRes)
  })
})

test("a changed tool_result is a real 409 and a different scope cannot commit the owner", { timeout: 20_000 }, async () => {
  await withKit({}, async (kit) => {
    const delivered = []
    kit.prompts.push(async (agent) => {
      delivered.push(await agent.tool("Read", { path: "/once.txt" }))
      await agent.tool("Read", { path: "/next.txt" })
      await agent.text("kept")
      return { stopReason: "end_turn" }
    })
    const headers = { "x-magpie-session": "scope-owner" }
    const body0 = baseBody({ messages: [{ role: "user", content: "preserve 409" }] })
    const first = await readSse(await kit.request(body0, { headers }))
    const continued = continueWithToolResults(body0, first, () => "original-result")
    const step = await readSse(await kit.request(continued, { headers }))
    assert.equal(step.stopReason, "tool_use")
    const originalId = first.content.find((block) => block.type === "tool_use").id
    const turn = kit.turns[0]
    const original = turn.calls.find((call) => call.id === originalId)
    const conflict = await kit.request(continueWithToolResults(body0, first, () => "changed-result"), { headers })
    assert.equal(conflict.status, 409)
    assert.match(await conflict.text(), /conflicting duplicate result/)
    assert.match(JSON.stringify(original.result), /original-result/)
    assert.equal(delivered.length, 1)

    const spawnsBeforeForeign = kit.acpSpawns.length
    const foreign = await kit.request(continueWithToolResults(continued, step, () => "foreign-scope"), {
      headers: { "x-magpie-session": "scope-other" },
    })
    const pending = turn.calls.find((call) => call.id === step.content.find((block) => block.type === "tool_use").id)
    assert.equal(pending.result, null)
    assert.equal(pending.mcpResponded, false)
    assert.equal(turn.finalized, false)
    assert.equal(turn.proc.dead, false)
    assert.equal(turn.proc.turn, turn)
    await drain(foreign)
    const spawnsAfterForeign = kit.acpSpawns.length
    assert.ok(spawnsAfterForeign >= spawnsBeforeForeign)
    const done = await readSse(await kit.request(continueWithToolResults(continued, step, () => "owner-scope"), { headers }))
    assert.equal(done.content.find((block) => block.type === "text")?.text, "kept")
    assert.equal(kit.acpSpawns.length, spawnsAfterForeign, "the owner's follow-up must stay on its live session")
  })
})

test("two legitimate branches proceed in parallel", { timeout: 20_000 }, async () => {
  await withKit({}, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      const text = (agent.prompt || []).map((part) => part.text || "").join("\n")
      await agent.text(text.includes("branch-a") ? "answer-a" : "answer-b")
      return { stopReason: "end_turn" }
    }
    const [a, b] = await Promise.all([
      readSse(await kit.request(baseBody({ messages: [{ role: "user", content: "branch-a" }] }))),
      readSse(await kit.request(baseBody({ messages: [{ role: "user", content: "branch-b" }] }))),
    ])
    assert.equal(a.content.find((block) => block.type === "text")?.text, "answer-a")
    assert.equal(b.content.find((block) => block.type === "text")?.text, "answer-b")
    assert.equal(kit.acpSpawns.length, 2)
    assert.equal(promptCount(kit), 2)
  })
})

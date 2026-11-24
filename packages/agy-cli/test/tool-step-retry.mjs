// Provenance: magpie-community/plugins#1513 head ffc516f3dd8f04d0055e5592972f8392344cc006
// (shelken:fix/agy-cli-step-receipt). Copied for this fork integration.
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  MESSAGES_URL,
  READ_TOOL,
  baseBody,
  continueWithToolResults,
  createBridgeKit,
  readSse,
  sleep,
  tick,
} from "./testkit.mjs"

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

function signInPayload(email, expiry = "0001-01-01T00:00:00Z") {
  return {
    token: { access_token: "ya29." + email, refresh_token: "1//" + email, expiry },
    auth_method: "consumer",
    id_token_email: email,
  }
}

function keyringOutput(email) {
  return "go-keyring-base64:" + Buffer.from(JSON.stringify(signInPayload(email))).toString("base64") + "\n"
}

function sseMsgId(parsed) {
  return parsed.events.find((item) => item.event === "message_start")?.data?.message?.id ?? null
}

function promptCount(kit) {
  return kit.acpLog.filter((entry) => entry.method === "session/prompt").length
}

async function waitUntil(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for test condition")
    await sleep(5)
  }
}

async function refreshStoredSignIn(kit) {
  const before = kit.execFiles.length
  const probe = await kit.request({ model: "agy-cli/gemini-4-argon[1m]", messages: [] })
  assert.equal(probe.status, 400)
  await probe.text()
  await waitUntil(() => kit.execFiles.length > before)
  await tick()
  await tick()
}

function stillRunningReply(reply) {
  const text = reply?.result?.content?.map((part) => part.text || "").join("") || ""
  return text.includes("still running")
}

// 1. Linux 双未知 + 附文 + deferred 连续双次重放（SSE 与 stream: false）
test("1. Linux default account with companion note and deferred parallel calls replays identically via SSE and non-stream", async () => {
  await withKit({
    platform: "linux",
    storedSignIn: undefined,
    env: { AGY_BRIDGE_IDE_CALL_DEADLINE_MS: "50" },
  }, async (kit) => {
    let c1Deliveries = 0
    let c1ReceivedText = ""
    let c2Replies = null

    kit.prompts.push(async (agent) => {
      const r1 = await agent.tool("Read", { path: "/c1.txt" })
      c1Deliveries++
      c1ReceivedText = r1?.result?.content?.map((part) => part.text || "").join("\n") || ""
      await agent.thought("planning two parallel reads")
      await agent.text("reading c2a and c2b")
      let batch = await agent.tools([["Read", { path: "/c2a.txt" }], ["Read", { path: "/c2b.txt" }]])
      while (batch.some(stillRunningReply)) {
        batch = await agent.tools([["Read", { path: "/c2a.txt" }], ["Read", { path: "/c2b.txt" }]])
      }
      c2Replies = batch
      await agent.text("all done")
      return { stopReason: "end_turn", usage: { inputTokens: 1200, outputTokens: 40 } }
    })

    const body0 = baseBody({ messages: [{ role: "user", content: "run two steps" }] })
    const step1 = await readSse(await kit.request(body0))
    assert.equal(step1.stopReason, "tool_use")
    assert.equal(step1.content.filter((b) => b.type === "tool_use").length, 1)

    // C1 返回时携带 <system-reminder> 附文
    const baseC1 = continueWithToolResults(body0, step1, () => "content of c1")
    const c1Messages = baseC1.messages.slice(0, -1)
    const lastUser = baseC1.messages.at(-1)
    const c1Body = {
      ...baseC1,
      messages: [
        ...c1Messages,
        {
          role: "user",
          content: [
            ...lastUser.content,
            { type: "text", text: "<system-reminder>Keep output concise.</system-reminder>" },
          ],
        },
      ],
    }

    const step2 = await readSse(await kit.request(c1Body))
    assert.equal(step2.stopReason, "tool_use")
    const step2MsgId = sseMsgId(step2)
    assert.ok(step2MsgId)
    const step2Thinking = step2.content.find((b) => b.type === "thinking")
    const step2Text = step2.content.find((b) => b.type === "text")
    const step2Tools = step2.content.filter((b) => b.type === "tool_use")
    assert.ok(step2Thinking?.signature, "expected thinking block with signature")
    assert.equal(step2Text?.text, "reading c2a and c2b")
    assert.equal(step2Tools.length, 2)
    assert.deepEqual(step2Tools.map((t) => t.input), [{ path: "/c2a.txt" }, { path: "/c2b.txt" }])
    assert.equal(c1Deliveries, 1)
    assert.match(c1ReceivedText, /Keep output concise\./)

    const turn = kit.turns[0]
    const c2Calls = step2Tools.map((t) => turn.calls.find((call) => call.id === t.id))
    assert.equal(c2Calls.length, 2)

    // 等待超过 ideCallDeadline 让 C2a/C2b 进入 deferred
    await waitUntil(() => c2Calls.every((call) => call.deferred))
    assert.ok(c2Calls.every((call) => call.deferred && !call.lateDelivered))
    const stepsBeforeReplay = turn.responseSteps.length

    // 第 1 次原样重发 C1（SSE）
    const replay1 = await readSse(await kit.request(c1Body))
    assert.equal(replay1.stopReason, "tool_use")
    assert.equal(sseMsgId(replay1), step2MsgId)
    assert.equal(replay1.model, step2.model)
    assert.deepEqual(replay1.content, step2.content)
    assert.deepEqual(replay1.usage, { input_tokens: 0, output_tokens: 0 })
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptCount(kit), 1)
    assert.equal(c1Deliveries, 1)
    assert.equal(turn.responseSteps.length, stepsBeforeReplay)

    // 第 2 次原样重发 C1（stream: false）
    const replay2Res = await kit.request({ ...c1Body, stream: false })
    assert.equal(replay2Res.status, 200)
    const replay2 = await replay2Res.json()
    assert.equal(replay2.stop_reason, "tool_use")
    assert.equal(replay2.id, step2MsgId)
    assert.equal(replay2.model, step2.model)
    assert.deepEqual(replay2.content, step2.content)
    assert.deepEqual(replay2.usage, { input_tokens: 0, output_tokens: 0 })
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptCount(kit), 1)
    assert.equal(c1Deliveries, 1)
    assert.equal(turn.responseSteps.length, stepsBeforeReplay)

    // 提交 C2a + C2b 结果，在同一个 session/prompt 完成 end_turn
    const c2Body = continueWithToolResults(c1Body, step2, (block) => `result for ${block.input.path}`)
    const finalStep = await readSse(await kit.request(c2Body))
    assert.equal(finalStep.stopReason, "end_turn")
    assert.equal(finalStep.content.find((b) => b.type === "text")?.text, "all done")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptCount(kit), 1)
    assert.equal(c1Deliveries, 1)
    assert.ok(c2Replies && c2Replies.length === 2)
  })
})

// 2. 默认账号 A→B 切换分池隔离（darwin，模拟 keyring who）
test("2. switching default darwin keyring account A to B isolates pools without dropping A's live turn", async () => {
  const options = {
    platform: "darwin",
    storedSignIn: keyringOutput("a@example.com"),
  }
  await withKit(options, async (kit) => {
    let aC1Count = 0
    let aC2Result = ""
    let bPrompts = 0

    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/a-c1.txt" })
      aC1Count++
      const r2 = await agent.tool("Read", { path: "/a-c2.txt" })
      aC2Result = r2?.result?.content?.map((part) => part.text || "").join("") || ""
      await agent.text("account A finished")
      return { stopReason: "end_turn" }
    })
    kit.defaultPrompt = async (agent) => {
      bPrompts++
      await agent.text("account B fresh reply")
      return { stopReason: "end_turn" }
    }

    // 预热 keyring 缓存为 A
    await refreshStoredSignIn(kit)

    const headers = { "x-magpie-session": "shared-scope" }
    const body0 = baseBody({ metadata: { user_id: "same-user" }, messages: [{ role: "user", content: "account task" }] })
    const aStep1 = await readSse(await kit.request(body0, { headers }))
    assert.equal(aStep1.stopReason, "tool_use")

    const c1Body = continueWithToolResults(body0, aStep1, () => "c1 result")
    const aStep2 = await readSse(await kit.request(c1Body, { headers }))
    assert.equal(aStep2.stopReason, "tool_use")
    const aC2Id = aStep2.content.find((b) => b.type === "tool_use").id
    assert.equal(aC1Count, 1)

    const procA = [...kit.module.__agyTestPool.values()][0]
    const turnA = procA.turn
    assert.ok(procA && turnA)
    assert.match(procA.accountPrefix, /^who:[0-9a-f]{32}:$/)

    // 切换 keyring 为 B 并推进时钟 > 30s 刷新缓存
    options.storedSignIn = keyringOutput("b@example.com")
    kit.clock.advance(35_000)
    await refreshStoredSignIn(kit)

    // B 携带与 A 相同的 user_id/scope/C1 历史重试
    const bRes = await readSse(await kit.request(c1Body, { headers }))
    assert.equal(bRes.stopReason, "end_turn")
    assert.equal(bRes.content.find((b) => b.type === "text")?.text, "account B fresh reply")
    assert.equal(bRes.content.some((b) => b.id === aC2Id), false)
    assert.equal(bPrompts, 1)

    // A 的活进程与 Turn 完好无损
    assert.equal(procA.dead, false)
    assert.equal(procA.retiring, false)
    assert.equal(procA.turn, turnA)
    assert.equal(turnA.finalized, false)
    assert.equal(kit.acpSpawns.length, 2)

    // 切回 A 后推进时钟刷新缓存，A 提交 C2 仍在原 procA 完成 end_turn
    options.storedSignIn = keyringOutput("a@example.com")
    kit.clock.advance(35_000)
    await refreshStoredSignIn(kit)

    const aC2Body = continueWithToolResults(c1Body, aStep2, () => "real a-c2 output")
    const aDone = await readSse(await kit.request(aC2Body, { headers }))
    assert.equal(aDone.stopReason, "end_turn")
    assert.equal(aDone.content.find((b) => b.type === "text")?.text, "account A finished")
    assert.equal(aC2Result, "real a-c2 output")
    assert.equal(kit.acpSpawns.length, 2, "account A must not respawn")
    assert.equal(aC1Count, 1)
  })
})

// 3. 同账号异 user_id 直接 C1 与直接 C2 均不碰 A
test("3. another user_id sending A's direct C1 or direct C2 never touches A's live turn", async () => {
  await withKit({}, async (kit) => {
    let aC2Received = ""
    let bPrompts = 0

    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/u-c1.txt" })
      const r2 = await agent.tool("Read", { path: "/u-c2.txt" })
      aC2Received = r2?.result?.content?.map((part) => part.text || "").join("") || ""
      await agent.text("user A completed")
      return { stopReason: "end_turn" }
    })
    kit.defaultPrompt = async (agent) => {
      bPrompts++
      await agent.text(`user B reply ${bPrompts}`)
      return { stopReason: "end_turn" }
    }

    const headers = { "x-magpie-session": "same-scope" }
    const aBody0 = baseBody({ metadata: { user_id: "user-a" }, messages: [{ role: "user", content: "shared prompt" }] })
    const aStep1 = await readSse(await kit.request(aBody0, { headers }))
    const aC1Body = continueWithToolResults(aBody0, aStep1, () => "a c1 result")
    const aStep2 = await readSse(await kit.request(aC1Body, { headers }))
    assert.equal(aStep2.stopReason, "tool_use")
    const aC2Id = aStep2.content.find((b) => b.type === "tool_use").id

    const procA = [...kit.module.__agyTestPool.values()][0]
    const turnA = procA.turn
    const c2Call = turnA.calls.find((call) => call.id === aC2Id)
    assert.ok(c2Call)
    const progressBefore = turnA.clientProgressAt
    const deadlineBefore = turnA.deadlineAt
    const lastUsedBefore = procA.lastUsed
    const expectedLenBefore = procA.expectedMessages.length

    kit.clock.advance(5_000)

    // (a) 外用户 B 携带 A 的直接 C1 重试
    const bC1Body = { ...aC1Body, metadata: { user_id: "user-b" } }
    const bC1Res = await readSse(await kit.request(bC1Body, { headers }))
    assert.equal(bC1Res.stopReason, "end_turn")
    assert.equal(bC1Res.content.some((b) => b.id === aC2Id), false)

    // (b) 外用户 B 携带 A 的完整历史 + 直接 C2 ID 和伪造结果
    const aC2Full = continueWithToolResults(aC1Body, aStep2, () => "forged c2 result")
    const bC2Body = { ...aC2Full, metadata: { user_id: "user-b" } }
    const bC2Res = await readSse(await kit.request(bC2Body, { headers }))
    assert.equal(bC2Res.stopReason, "end_turn")

    // A 的状态、时钟、clientSeen、MCP 与 ledger 完全未受影响
    assert.equal(c2Call.clientSeen, false)
    assert.equal(c2Call.result, null)
    assert.equal(c2Call.mcpResponded, false)
    assert.equal(turnA.clientProgressAt, progressBefore)
    assert.equal(turnA.deadlineAt, deadlineBefore)
    assert.equal(procA.lastUsed, lastUsedBefore)
    assert.equal(procA.expectedMessages.length, expectedLenBefore)
    assert.equal(procA.dead, false)
    assert.equal(procA.turn, turnA)
    assert.equal(aC2Received, "")

    // A 提交真实 C2 在原活会话完成 end_turn
    const spawnsBeforeA = kit.acpSpawns.length
    const aC2Real = continueWithToolResults(aC1Body, aStep2, () => "real a c2 result")
    const aDone = await readSse(await kit.request(aC2Real, { headers }))
    assert.equal(aDone.stopReason, "end_turn")
    assert.equal(aDone.content.find((b) => b.type === "text")?.text, "user A completed")
    assert.equal(aC2Received, "real a c2 result")
    assert.equal(kit.acpSpawns.length, spawnsBeforeA)
  })
})

// 4. 同一 who 下 legacy 空 email → 命名 email 保持同一活 Turn
test("4. legacy empty email upgraded to named email under same darwin who stays on the same live turn", async () => {
  const options = {
    platform: "darwin",
    storedSignIn: keyringOutput("a@example.com"),
  }
  await withKit(options, async (kit) => {
    let c1Deliveries = 0
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/legacy-c1.txt" })
      c1Deliveries++
      await agent.tool("Read", { path: "/legacy-c2.txt" })
      await agent.text("same proc finished")
      return { stopReason: "end_turn" }
    })

    await refreshStoredSignIn(kit)

    const legacyLoader = await kit.plugin.auth.loader(async () => ({ type: "oauth", key: "agy" }))
    const namedLoader = await kit.plugin.auth.loader(async () => ({
      type: "oauth",
      key: "agy",
      metadata: { email: "A@example.com" },
    }))
    const post = (loader, body) => loader.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(body) })

    const body0 = baseBody({ messages: [{ role: "user", content: "upgrade email identity" }] })
    const step1 = await readSse(await post(legacyLoader, body0))
    const c1Body = continueWithToolResults(body0, step1, () => "c1 ok")
    const step2 = await readSse(await post(legacyLoader, c1Body))
    assert.equal(step2.stopReason, "tool_use")
    const step2MsgId = sseMsgId(step2)
    const c2Id = step2.content.find((b) => b.type === "tool_use").id
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(c1Deliveries, 1)

    // 切到带命名 email 的 loader 原样重试 C1 -> 命中同一活 Turn 重放
    const replay = await readSse(await post(namedLoader, c1Body))
    assert.equal(replay.stopReason, "tool_use")
    assert.equal(sseMsgId(replay), step2MsgId)
    assert.equal(replay.content.find((b) => b.type === "tool_use").id, c2Id)
    assert.deepEqual(replay.usage, { input_tokens: 0, output_tokens: 0 })
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptCount(kit), 1)
    assert.equal(c1Deliveries, 1)

    // 用带命名 email 的 loader 继续提交 C2 -> 在同一进程完成 end_turn
    const c2Body = continueWithToolResults(c1Body, step2, () => "c2 ok")
    const done = await readSse(await post(namedLoader, c2Body))
    assert.equal(done.stopReason, "end_turn")
    assert.equal(done.content.find((b) => b.type === "text")?.text, "same proc finished")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptCount(kit), 1)
  })
})

// 5. 工具重列（await proc.updateTools）期间并发保护
test("5. turn.continuing protects the live turn during await proc.updateTools against moved-on and LRU eviction", async () => {
  await withKit({
    env: {
      AGY_BRIDGE_MAX_PROCS: "1",
      AGY_BRIDGE_DETACHED_EVICT_MS: "10",
    },
  }, async (kit) => {
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
    const c1Id = step1.content.find((b) => b.type === "tool_use").id

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

    // 收缩工具列表以触发 await proc.updateTools(tools) 挂起
    const c1Body = {
      ...continueWithToolResults(body0, step1, () => "relist result"),
      tools: [READ_TOOL],
    }
    const continuingReq = kit.request(c1Body)
    await waitUntil(() => Boolean(releaseRelist) && turn.continuing === true)

    // 在 continuing 挂起后推进时钟超过 detachedEvictMs，确保若无 continuing 保护 evictLRU 会立即驱逐该 turn
    kit.clock.advance(50)
    assert.ok(kit.clock.now() - turn.clientProgressAt >= 10)

    // (a) 并发发送同会话 moved-on / unmatched 结果请求 -> 503 且不回收原 Turn
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

    // (b) 满池（MAX_PROCS=1, DETACHED_EVICT_MS=10）下新会话挤占 -> 503 且不驱逐原 Turn
    const intruderBody = baseBody({ messages: [{ role: "user", content: "brand new conversation" }] })
    const intruderRes = await kit.request(intruderBody)
    assert.equal(intruderRes.status, 503)
    await intruderRes.text()
    assert.equal(proc.turn, turn)
    assert.equal(proc.retiring, false)
    assert.equal(turn.finalized, false)
    assert.equal(turn.continuing, true)
    assert.equal(kit.acpSpawns.length, 1)

    // 放行工具重列，原请求正常完成 end_turn
    releaseRelist()
    const done = await readSse(await continuingReq)
    assert.equal(done.stopReason, "end_turn")
    assert.equal(done.content.find((b) => b.type === "text")?.text, "resumed after tool relist")
    assert.equal(turn.continuing, false)
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptCount(kit), 1)
  })
})

// 6. 预取消请求（AbortSignal.abort()）不动时钟且不吞成 502
test("6. pre-aborted retries and C2 requests never advance clocks, mark clientSeen, or swallow abort into 502", async () => {
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/abort-c1.txt" })
      await agent.tool("Read", { path: "/abort-c2.txt" })
      await agent.text("survived pre-aborted requests")
      return { stopReason: "end_turn" }
    })

    const body0 = baseBody({ messages: [{ role: "user", content: "abort check" }] })
    const step1 = await readSse(await kit.request(body0))
    const c1Body = continueWithToolResults(body0, step1, () => "c1 result")
    const step2 = await readSse(await kit.request(c1Body))
    assert.equal(step2.stopReason, "tool_use")
    const step2MsgId = sseMsgId(step2)
    const c2Block = step2.content.find((b) => b.type === "tool_use")

    const turn = kit.turns[0]
    const proc = turn.proc
    const c2Call = turn.calls.find((call) => call.id === c2Block.id)
    const progressBefore = turn.clientProgressAt
    const deadlineBefore = turn.deadlineAt
    const lastUsedBefore = proc.lastUsed

    kit.clock.advance(10_000)

    const abortErr = new Error("client aborted")
    const abortedSignal = AbortSignal.abort(abortErr)

    // (a) 预取消 SSE C1 重试：流读出 abort 错
    const sseAbortedRes = await kit.request(c1Body, { signal: abortedSignal })
    assert.equal(sseAbortedRes.status, 200)
    await assert.rejects(() => sseAbortedRes.text(), /client aborted/)

    // (b) 预取消 stream: false C1 重试：promise reject（绝不返回 502 JSON）
    await assert.rejects(
      () => kit.request({ ...c1Body, stream: false }, { signal: abortedSignal }),
      /client aborted/,
    )

    // (c) 带 C2 的预取消请求（含普通文本与真实 tool_result(C2)）：不提交 MCP、不标记 clientSeen、不动时钟、保留 lastToolStep
    const carryingC2Body = {
      ...c1Body,
      messages: [
        ...c1Body.messages,
        { role: "assistant", content: [{ type: "tool_use", id: c2Block.id, name: c2Block.name, input: c2Block.input }] },
        { role: "user", content: "aborted before tool_result" },
      ],
    }
    const carryingC2Res = await kit.request(carryingC2Body, { signal: abortedSignal })
    assert.equal(carryingC2Res.status, 400)
    await carryingC2Res.text()

    const c2Body = continueWithToolResults(c1Body, step2, () => "c2 result")
    const sseAbortedC2 = await kit.request(c2Body, { signal: abortedSignal })
    assert.equal(sseAbortedC2.status, 200)
    await assert.rejects(() => sseAbortedC2.text(), /client aborted/)
    await assert.rejects(
      () => kit.request({ ...c2Body, stream: false }, { signal: abortedSignal }),
      /client aborted/,
    )

    // 工具目录增长（toolsGrew）的预取消 C2 请求同样不得拆毁活回合或清空 lastToolStep
    const grownToolsC2Body = {
      ...c2Body,
      tools: [
        ...c2Body.tools,
        { name: "ExtraTool", description: "extra", input_schema: { type: "object", properties: {} } },
      ],
    }
    const sseAbortedGrownC2 = await kit.request(grownToolsC2Body, { signal: abortedSignal })
    assert.equal(sseAbortedGrownC2.status, 200)
    await assert.rejects(() => sseAbortedGrownC2.text(), /client aborted/)
    await assert.rejects(
      () => kit.request({ ...grownToolsC2Body, stream: false }, { signal: abortedSignal }),
      /client aborted/,
    )

    assert.equal(c2Call.clientSeen, false)
    assert.equal(c2Call.result, null)
    assert.equal(c2Call.mcpResponded, false)
    assert.ok(turn.lastToolStep, "pre-aborted C2 submission must keep lastToolStep intact")
    assert.equal(proc.turn, turn)
    assert.equal(proc.dead, false)
    assert.equal(turn.finalized, false)
    assert.equal(turn.clientProgressAt, progressBefore)
    assert.equal(turn.deadlineAt, deadlineBefore)
    assert.equal(proc.lastUsed, lastUsedBefore)

    // 随后正常 C1 重试仍成功重放，并由 C2 完成 end_turn
    const replay = await readSse(await kit.request(c1Body))
    assert.equal(replay.stopReason, "tool_use")
    assert.equal(sseMsgId(replay), step2MsgId)
    assert.equal(replay.content.find((b) => b.type === "tool_use").id, c2Block.id)
    assert.deepEqual(replay.usage, { input_tokens: 0, output_tokens: 0 })
    assert.equal(kit.acpSpawns.length, 1)

    const done = await readSse(await kit.request(c2Body))
    assert.equal(done.stopReason, "end_turn")
    assert.equal(done.content.find((b) => b.type === "text")?.text, "survived pre-aborted requests")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptCount(kit), 1)
  })
})

// 7. 无 poll waiter 的 deferred C1 接收后正常推进并发出 C2
test("7. deferred C1 without poll waiters delivers via waitLate, seeds lastToolStep on C2, and replays cleanly", async () => {
  await withKit({
    env: { AGY_BRIDGE_IDE_CALL_DEADLINE_MS: "50" },
  }, async (kit) => {
    let prompt2Text = ""
    let c2Delivered = ""

    // Prompt #1: 发出 C1，超过 deadline 进入 deferred 后直接结束首轮 prompt（不重 poll）
    kit.prompts.push(async (agent) => {
      const reply = await agent.tool("Read", { path: "/late-c1.txt" })
      assert.ok(stillRunningReply(reply), "expected C1 to defer before Prompt #1 ends")
      return { stopReason: "end_turn" }
    })
    // Prompt #2: 收到 late result 后发出 C2，并等待 C2 完成 end_turn
    kit.prompts.push(async (agent) => {
      prompt2Text = (agent.prompt || []).map((part) => part.text || "").join("\n")
      const r2 = await agent.tool("Read", { path: "/late-c2.txt" })
      c2Delivered = r2?.result?.content?.map((part) => part.text || "").join("") || ""
      await agent.text("late chain finished")
      return { stopReason: "end_turn" }
    })

    const body0 = baseBody({ messages: [{ role: "user", content: "start deferred chain" }] })
    const step1 = await readSse(await kit.request(body0))
    assert.equal(step1.stopReason, "tool_use")
    const c1Id = step1.content.find((b) => b.type === "tool_use").id

    const turn = kit.turns[0]
    const c1Call = turn.calls.find((call) => call.id === c1Id)
    // 等待 C1 defer 且 Prompt #1 退出进入 waitLate（此时 awaitCalls 为空、无 poll waiter）
    await waitUntil(() => c1Call.deferred && !turn.promptInFlight && turn.lateWaiters.length > 0)
    assert.equal(turn.awaitCalls.length, 0)

    const c1Body = continueWithToolResults(body0, step1, () => "late c1 real output")
    const step2 = await readSse(await kit.request(c1Body))
    assert.equal(step2.stopReason, "tool_use")
    const step2MsgId = sseMsgId(step2)
    const c2Id = step2.content.find((b) => b.type === "tool_use").id
    assert.match(prompt2Text, /late c1 real output/)
    assert.ok(turn.lastToolStep, "expected lastToolStep to be seeded after waitLate delivery")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptCount(kit), 2)

    // 原样重试 C1 命中重放
    const replay = await readSse(await kit.request(c1Body))
    assert.equal(replay.stopReason, "tool_use")
    assert.equal(sseMsgId(replay), step2MsgId)
    assert.equal(replay.content.find((b) => b.type === "tool_use").id, c2Id)
    assert.deepEqual(replay.usage, { input_tokens: 0, output_tokens: 0 })
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptCount(kit), 2)

    // 提交 C2 结果完成 end_turn
    const c2Body = continueWithToolResults(c1Body, step2, () => "late c2 real output")
    const done = await readSse(await kit.request(c2Body))
    assert.equal(done.stopReason, "end_turn")
    assert.equal(done.content.find((b) => b.type === "text")?.text, "late chain finished")
    assert.equal(c2Delivered, "late c2 real output")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptCount(kit), 2)
  })
})

// 8. 候选路径 409 优先级与负向不误重放
test("8. candidate 409 beats 400 and steer/drop, and mutated config or advanced step never replays stale C2", async () => {
  // 8a & 8b: 修改已提交 C1 结果 + 未闭合 <system-reminder> 或 user steer 文本均返回 409，不破坏活会话
  await withKit({}, async (kit) => {
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/p-c1.txt" })
      await agent.tool("Read", { path: "/p-c2.txt" })
      await agent.tool("Read", { path: "/p-c3.txt" })
      await agent.text("three steps done")
      return { stopReason: "end_turn" }
    })

    const body0 = baseBody({ messages: [{ role: "user", content: "priority check" }] })
    const step1 = await readSse(await kit.request(body0))
    const c1Body = continueWithToolResults(body0, step1, () => "original c1")
    const step2 = await readSse(await kit.request(c1Body))
    assert.equal(step2.stopReason, "tool_use")
    const c1Id = step1.content.find((b) => b.type === "tool_use").id
    const c2Id = step2.content.find((b) => b.type === "tool_use").id

    const proc = [...kit.module.__agyTestPool.values()][0]
    const turn = proc.turn

    // (a) 修改已提交 C1 结果 + 未闭合 <system-reminder> -> 409（不被 400 抢先）
    const unclosedBody = {
      ...c1Body,
      messages: [
        ...c1Body.messages.slice(0, -1),
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: c1Id, content: "mutated c1" },
            { type: "text", text: "<system-reminder>unclosed reminder" },
          ],
        },
      ],
    }
    const unclosedRes = await kit.request(unclosedBody)
    assert.equal(unclosedRes.status, 409)
    assert.match(await unclosedRes.text(), /conflicting duplicate result/)
    assert.equal(proc.turn, turn)
    assert.equal(turn.finalized, false)

    // (b) 修改已提交 C1 结果 + user steer 文本 -> 409（不落入 steer/drop）
    const steerConflictBody = {
      ...c1Body,
      messages: [
        ...c1Body.messages.slice(0, -1),
        {
          role: "user",
          content: [
            { type: "text", text: "stop and do something else" },
            { type: "tool_result", tool_use_id: c1Id, content: "mutated c1 again" },
          ],
        },
      ],
    }
    const steerConflictRes = await kit.request(steerConflictBody)
    assert.equal(steerConflictRes.status, 409)
    assert.match(await steerConflictRes.text(), /conflicting duplicate result/)
    assert.equal(proc.turn, turn)
    assert.equal(turn.finalized, false)
    assert.equal(kit.acpSpawns.length, 1)

    // (c1) 推进 C2 -> C3 后再重发 C1：绝不重放旧 C2
    const c2Body = continueWithToolResults(c1Body, step2, () => "c2 output")
    const step3 = await readSse(await kit.request(c2Body))
    assert.equal(step3.stopReason, "tool_use")
    const c3Id = step3.content.find((b) => b.type === "tool_use").id
    assert.notEqual(c3Id, c2Id)
    assert.equal(kit.acpSpawns.length, 1)

    kit.defaultPrompt = async (agent) => {
      await agent.text("fresh session after stale C1")
      return { stopReason: "end_turn" }
    }
    const staleC1Retry = await readSse(await kit.request(c1Body))
    assert.equal(staleC1Retry.stopReason, "end_turn")
    assert.equal(staleC1Retry.content.some((b) => b.id === c2Id), false)
    assert.equal(kit.acpSpawns.length, 2)
  })

  // 8c2: 改了 output_config / tools / model 均不重放旧 C2
  for (const [label, mutate] of [
    ["output_config", (body) => ({ ...body, output_config: { format: { type: "json_object" } } })],
    ["tools", (body) => ({ ...body, tools: [READ_TOOL, EXTRA_TOOL] })],
    ["model", (body) => ({ ...body, model: "agy-cli/claude-sonnet-5-5" })],
  ]) {
    await withKit({}, async (kit) => {
      kit.prompts.push(async (agent) => {
        await agent.tool("Read", { path: "/neg-c1.txt" })
        await agent.tool("Read", { path: "/neg-c2.txt" })
        await agent.text("original turn")
        return { stopReason: "end_turn" }
      })
      kit.defaultPrompt = async (agent) => {
        await agent.text(`fresh after ${label} change`)
        return { stopReason: "end_turn" }
      }

      const body0 = baseBody({ messages: [{ role: "user", content: `mutate ${label}` }] })
      const step1 = await readSse(await kit.request(body0))
      const c1Body = continueWithToolResults(body0, step1, () => "c1 ok")
      const step2 = await readSse(await kit.request(c1Body))
      assert.equal(step2.stopReason, "tool_use")
      const c2Id = step2.content.find((b) => b.type === "tool_use").id
      assert.equal(kit.acpSpawns.length, 1)

      const mutatedRes = await readSse(await kit.request(mutate(c1Body)))
      assert.equal(mutatedRes.stopReason, "end_turn", `${label} change must not replay old C2`)
      assert.equal(mutatedRes.content.find((b) => b.type === "text")?.text, `fresh after ${label} change`)
      assert.equal(mutatedRes.content.some((b) => b.id === c2Id), false)
      assert.equal(kit.acpSpawns.length, 2)
    })
  }
})

// 9. 改名 ID 唯一跨用户候选不得命中另一用户的活 Turn
test("9. renamed tool_use_id with a single cross-user candidate in the same account never binds to user A's live turn", async () => {
  const options = {
    platform: "darwin",
    storedSignIn: keyringOutput("acct-x@example.com"),
  }
  await withKit(options, async (kit) => {
    let aReceived = ""
    let bFreshPrompts = 0

    // Prompt #1: 账号 X 用户 A 等待 C1
    kit.prompts.push(async (agent) => {
      const r1 = await agent.tool("Read", { path: "/shared.txt" })
      aReceived = r1?.result?.content?.map((part) => part.text || "").join("") || ""
      await agent.text("account X user A secret answer")
      return { stopReason: "end_turn" }
    })
    // Prompt #2: 账号 Y 同时存在同会话范围、同历史、同参数的待答 Turn
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/shared.txt" })
      await agent.text("account Y answer")
      return { stopReason: "end_turn" }
    })
    kit.defaultPrompt = async (agent) => {
      bFreshPrompts++
      await agent.text("account X user B isolated fresh reply")
      return { stopReason: "end_turn" }
    }

    await refreshStoredSignIn(kit)
    const headers = { "x-magpie-session": "same-scope" }
    const bodyA = baseBody({ metadata: { user_id: "user-a" }, messages: [{ role: "user", content: "identical opening" }] })
    const aStep1 = await readSse(await kit.request(bodyA, { headers }))
    assert.equal(aStep1.stopReason, "tool_use")
    const aCallId = aStep1.content.find((b) => b.type === "tool_use").id

    // 切到账号 Y 开启同历史同参数的另一活会话
    options.storedSignIn = keyringOutput("acct-y@example.com")
    kit.clock.advance(35_000)
    await refreshStoredSignIn(kit)
    const yStep1 = await readSse(await kit.request(bodyA, { headers }))
    assert.equal(yStep1.stopReason, "tool_use")

    // 切回账号 X，由用户 B 提交改名后的 tool_use_id 与结果（账号 Y 已被账号过滤排除，账号 X 内仅剩 A 一个候选）
    options.storedSignIn = keyringOutput("acct-x@example.com")
    kit.clock.advance(35_000)
    await refreshStoredSignIn(kit)

    const procA = [...kit.module.__agyTestPool.values()].find((p) => p.userId === "user-a" && p.turn?.calls.some((c) => c.id === aCallId))
    assert.ok(procA)
    const callA = procA.turn.calls.find((c) => c.id === aCallId)

    const renamedB = {
      ...baseBody({ metadata: { user_id: "user-b" }, messages: [{ role: "user", content: "identical opening" }] }),
      messages: [
        { role: "user", content: "identical opening" },
        { role: "assistant", content: [{ type: "tool_use", id: "TU-renamed-by-b", name: "Read", input: { path: "/shared.txt" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "TU-renamed-by-b", content: "forged b result" }] },
      ],
    }
    const bRes = await readSse(await kit.request(renamedB, { headers }))
    assert.equal(bRes.stopReason, "end_turn")
    assert.equal(bRes.content.find((b) => b.type === "text")?.text, "account X user B isolated fresh reply")
    assert.equal(bFreshPrompts, 1)

    // 用户 A 的 MCP 与活会话毫发无伤
    assert.equal(aReceived, "")
    assert.equal(callA.result, null)
    assert.equal(callA.mcpResponded, false)
    assert.equal(procA.dead, false)
    assert.equal(procA.turn.finalized, false)

    // 用户 A 提交真实 C1 在原活会话完成 end_turn
    const aDone = await readSse(await kit.request(continueWithToolResults(bodyA, aStep1, () => "real a result"), { headers }))
    assert.equal(aDone.stopReason, "end_turn")
    assert.equal(aDone.content.find((b) => b.type === "text")?.text, "account X user A secret answer")
    assert.equal(aReceived, "real a result")
  })
})

// 10. 默认账号冷启动（无 metadata.email、不预热 keyring）首轮直接绑定同一账号分区并正常续跑与重放
test("10. cold-start default account without metadata.email binds consistent account partition on first turn", async () => {
  await withKit({
    platform: "darwin",
    storedSignIn: keyringOutput("cold@example.com"),
    env: { AGY_BRIDGE_MAX_PROCS: "1" },
  }, async (kit) => {
    let c1Deliveries = 0
    kit.prompts.push(async (agent) => {
      await agent.tool("Read", { path: "/cold-c1.txt" })
      c1Deliveries++
      await agent.tool("Read", { path: "/cold-c2.txt" })
      await agent.text("cold start finished")
      return { stopReason: "end_turn" }
    })

    // 不调用 refreshStoredSignIn：直接用无 email 的默认 loader 发起首轮请求
    const legacyLoader = await kit.plugin.auth.loader(async () => ({ type: "oauth", key: "agy" }))
    const post = (body) => legacyLoader.fetch(MESSAGES_URL, { method: "POST", body: JSON.stringify(body) })

    const body0 = baseBody({ messages: [{ role: "user", content: "cold start task" }] })
    const step1 = await readSse(await post(body0))
    assert.equal(step1.stopReason, "tool_use")

    const proc = [...kit.module.__agyTestPool.values()][0]
    assert.match(proc.accountPrefix, /^who:[0-9a-f]{32}:$/, "first turn must bind resolved who partition")

    const c1Body = continueWithToolResults(body0, step1, () => "cold c1 output")
    const step2 = await readSse(await post(c1Body))
    assert.equal(step2.stopReason, "tool_use")
    const step2MsgId = sseMsgId(step2)
    assert.equal(c1Deliveries, 1)
    assert.equal(kit.acpSpawns.length, 1)

    // 原样重试 C1 命中重放
    const replay = await readSse(await post(c1Body))
    assert.equal(replay.stopReason, "tool_use")
    assert.equal(sseMsgId(replay), step2MsgId)
    assert.deepEqual(replay.usage, { input_tokens: 0, output_tokens: 0 })
    assert.equal(c1Deliveries, 1)
    assert.equal(kit.acpSpawns.length, 1)

    // 提交 C2 在单槽池同一进程完成 end_turn（不 503、不重开会话）
    const done = await readSse(await post(continueWithToolResults(c1Body, step2, () => "cold c2 output")))
    assert.equal(done.stopReason, "end_turn")
    assert.equal(done.content.find((b) => b.type === "text")?.text, "cold start finished")
    assert.equal(kit.acpSpawns.length, 1)
    assert.equal(promptCount(kit), 1)
  })
})

// 11. 默认账号切换时不得复用另一账号已预热的 spare 进程
test("11. default-account switch never adopts another account's warmed spare", async () => {
  const options = {
    platform: "darwin",
    storedSignIn: keyringOutput("spare-a@example.com"),
    env: { AGY_BRIDGE_SPARE: "1" },
  }
  await withKit(options, async (kit) => {
    kit.defaultPrompt = async (agent) => {
      await agent.text("spare isolation ok")
      return { stopReason: "end_turn" }
    }

    await refreshStoredSignIn(kit)

    const conv1 = baseBody({ messages: [{ role: "user", content: "account A conversation" }] })
    const res1 = await readSse(await kit.request(conv1))
    assert.equal(res1.stopReason, "end_turn")

    // 等待账号 A 的 spare（spawn #1）初始化完成
    await waitUntil(() => kit.initialized === 2)

    const procA = [...kit.module.__agyTestPool.values()][0]
    assert.ok(procA)
    assert.match(procA.accountPrefix, /^who:[0-9a-f]{32}:$/)

    // 切换默认 keyring 账号至 B 并刷新缓存
    options.storedSignIn = keyringOutput("spare-b@example.com")
    kit.clock.advance(35_000)
    await refreshStoredSignIn(kit)

    const conv2 = baseBody({ messages: [{ role: "user", content: "account B fresh conversation" }] })
    const res2 = await readSse(await kit.request(conv2))
    assert.equal(res2.stopReason, "end_turn")

    const sessionNews = kit.acpLog.filter((entry) => entry.method === "session/new")
    assert.equal(sessionNews.length, 2)
    assert.equal(sessionNews[0].spawn, 0)
    assert.notEqual(sessionNews[1].spawn, 1, "account B must not adopt account A's warmed spare")
    assert.notEqual(sessionNews[1].spawn, 0)

    const procB = [...kit.module.__agyTestPool.values()].find((proc) => proc !== procA)
    assert.ok(procB)
    assert.match(procB.accountPrefix, /^who:[0-9a-f]{32}:$/)
    assert.notEqual(procB.accountPrefix, procA.accountPrefix)
  })
})

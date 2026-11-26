import { test } from "node:test"
import assert from "node:assert/strict"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

test("message_stop is enqueued only after the finished turn is recorded and released", async () => {
  const kit = await createBridgeKit()
  const RealReadableStream = globalThis.ReadableStream
  const seen = []
  globalThis.ReadableStream = class ObservedReadableStream extends RealReadableStream {
    constructor(source, strategy) {
      const start = source?.start
      super({
        ...source,
        start(controller) {
          const enqueue = controller.enqueue.bind(controller)
          controller.enqueue = (chunk) => {
            const text = new TextDecoder().decode(chunk)
            if (text.includes("event: message_stop")) {
              const proc = [...kit.module.__agyTestAllProcs][0]
              const last = proc?.expectedMessages?.at(-1)
              seen.push({
                finalized: proc?.turn == null,
                turnFinalized: [...kit.turns].every((turn) => turn.finalized),
                recorded: last?.role === "assistant" && last.content?.some((block) => block.type === "text" && block.text === "done before stop"),
              })
            }
            return enqueue(chunk)
          }
          return start?.call(this, controller)
        },
      }, strategy)
    }
  }
  try {
    kit.prompts.push(async (agent) => {
      await agent.text("done before stop")
      return { stopReason: "end_turn" }
    })
    const parsed = await readSse(await kit.request(baseBody({ messages: [{ role: "user", content: "finish the turn" }] })))
    assert.equal(parsed.stopReason, "end_turn")
    assert.equal(parsed.content.find((block) => block.type === "text")?.text, "done before stop")
    assert.equal(seen.length, 1, JSON.stringify(seen))
    assert.equal(seen[0].finalized, true)
    assert.equal(seen[0].turnFinalized, true)
    assert.equal(seen[0].recorded, true)
  } finally {
    globalThis.ReadableStream = RealReadableStream
    await kit.dispose()
  }
})

import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { baseBody, createBridgeKit, readSse } from "./testkit.mjs"

// agy cut a tool result short and saved the whole of it in its own folder,
// where the client (on another machine than magpie in Docker, Dani Ariyanto
// on Discord) can't read it: the bridge answers that read itself.
function spill(agyDir, text, session = "s1", step = "4") {
  const file = path.join(agyDir, "brain", session, ".system_generated", "steps", step, "output.txt")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
  return file
}

async function readThrough(kit, args) {
  let reply
  kit.prompts.push(async (agent) => {
    const [proc] = [...kit.module.__agyTestAllProcs]
    reply = await agent.tool("Read", args(proc))
    if (reply?.result) await agent.text("read it")
  })
  const result = await readSse(await kit.request(baseBody()))
  return { reply, result }
}

test("a read of agy's own saved output is answered by the bridge, never sent to the client", async () => {
  const kit = await createBridgeKit()
  try {
    const { reply, result } = await readThrough(kit, (proc) => ({ path: spill(proc.agyDir, "alpha\nbeta\ngamma\n", proc.sessionId) }))
    assert.equal(reply.result.isError, false)
    assert.equal(reply.result.content[0].text, "     1\talpha\n     2\tbeta\n     3\tgamma")
    assert.equal(result.content.find((item) => item.type === "tool_use"), undefined)
    assert.equal(result.content.find((item) => item.type === "text")?.text, "read it")
  } finally {
    await kit.dispose()
  }
})

test("offset and limit pick the lines of a saved output", async () => {
  const kit = await createBridgeKit()
  try {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join("\n")
    const { reply } = await readThrough(kit, (proc) => ({ file_path: spill(proc.agyDir, lines, proc.sessionId), offset: 4, limit: 2 }))
    assert.equal(reply.result.content[0].text, "     4\tline 4\n     5\tline 5")
  } finally {
    await kit.dispose()
  }
})

test("any other file, or a link out of agy's folder, still goes to the client", async () => {
  for (const place of ["outside", "link", "not a step"]) {
    const kit = await createBridgeKit()
    try {
      const { reply, result } = await readThrough(kit, (proc) => {
        const dir = proc.agyDir
        if (place === "outside") return { path: spill(path.join(kit.tmp, "elsewhere"), "x") }
        if (place === "not a step") {
          const file = path.join(dir, "brain", proc.sessionId, "notes.txt")
          fs.mkdirSync(path.dirname(file), { recursive: true })
          fs.writeFileSync(file, "x")
          return { path: file }
        }
        const target = path.join(kit.tmp, "secret.txt")
        fs.writeFileSync(target, "secret")
        const file = path.join(dir, "brain", proc.sessionId, ".system_generated", "steps", "4", "output.txt")
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.symlinkSync(target, file)
        return { path: file }
      })
      assert.equal(reply, undefined, `${place}: answered by the bridge`)
      const call = result.content.find((item) => item.type === "tool_use")
      assert.ok(call, `${place}: not sent to the client`)
      assert.equal(call.name, "Read")
    } finally {
      await kit.dispose()
    }
  }
})

test("a tool that isn't a read is never answered from the saved output", async () => {
  const kit = await createBridgeKit()
  try {
    const { result } = await (async () => {
      let reply
      kit.prompts.push(async (agent) => {
        const [proc] = [...kit.module.__agyTestAllProcs]
        reply = await agent.tool("Bash", { command: spill(proc.agyDir, "x", proc.sessionId) })
      })
      const body = baseBody({ tools: [{ name: "Bash", input_schema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } }] })
      return { reply, result: await readSse(await kit.request(body)) }
    })()
    assert.equal(result.content.find((item) => item.type === "tool_use")?.name, "Bash")
  } finally {
    await kit.dispose()
  }
})

// Records filesystem calls made by the loaded bridge, not by the test itself.
function traceFs() {
  const events = []
  const note = (op, file) => events.push([op, String(file)])
  return {
    events,
    mocks: {
      "node:fs": {
        lstatSync(file, opts) { note("lstat", file); return fs.lstatSync(file, opts) },
        realpathSync(file, opts) { note("realpath", file); return fs.realpathSync(file, opts) },
        readFileSync(file, opts) { note("read", file); return fs.readFileSync(file, opts) },
        openSync(file, ...args) { note("open", file); return fs.openSync(file, ...args) },
        readSync(fd, ...args) { note("readSync", fd); return fs.readSync(fd, ...args) },
        writeFileSync(file, ...args) { note("write", file); return fs.writeFileSync(file, ...args) },
        appendFileSync(file, ...args) { note("append", file); return fs.appendFileSync(file, ...args) },
        mkdirSync(file, ...args) { note("mkdir", file); return fs.mkdirSync(file, ...args) },
        chmodSync(file, ...args) { note("chmod", file); return fs.chmodSync(file, ...args) },
        unlinkSync(file) { note("unlink", file); return fs.unlinkSync(file) },
        rmSync(file, ...args) { note("rm", file); return fs.rmSync(file, ...args) },
        copyFileSync(file, dest, ...args) { note("copy", file); return fs.copyFileSync(file, dest, ...args) },
      },
    },
  }
}

function spillTouches(events) {
  return events.filter(([, file]) => String(file).includes(`${path.sep}brain${path.sep}`) || String(file).includes(".system_generated") || String(file).endsWith("output.txt"))
}

function assistantContent(parsed) {
  return parsed.content.map((block) => block.type === "text" ? { type: "text", text: block.text } : block)
}

function nextTurn(body, parsed, text) {
  return {
    ...body,
    messages: [
      ...body.messages,
      { role: "assistant", content: assistantContent(parsed) },
      { role: "user", content: text },
    ],
  }
}

test("only the current session's spilled file is read; another session, a symlink, and a path escape are not opened", async () => {
  const trace = traceFs()
  const kit = await createBridgeKit({ nodeMocks: trace.mocks })
  try {
    const dir = path.join(kit.home, ".gemini", "antigravity-cli")
    const own = spill(dir, "own-line\n", "sess-own", "7")
    const foreign = spill(dir, "foreign-secret\n", "sess-other", "7")
    const before = fs.statSync(foreign)
    const read = kit.module.spilledOutput(dir, "Read", { path: own }, "sess-own")
    assert.equal(read?.content?.[0]?.text, "     1\town-line")
    const mark = trace.events.length
    assert.equal(kit.module.spilledOutput(dir, "Read", { path: foreign }, "sess-own"), null)
    const escaped = path.resolve(dir, "brain", "sess-own", ".system_generated", "steps", "7", "..", "..", "..", "..", "..", "brain", "sess-other", ".system_generated", "steps", "7", "output.txt")
    assert.equal(path.resolve(escaped), path.resolve(foreign))
    assert.equal(kit.module.spilledOutput(dir, "Read", { path: escaped }, "sess-own"), null)
    assert.equal(kit.module.spilledOutput(dir, "view_file", { path: path.join(dir, "brain", "sess-own-extra", ".system_generated", "steps", "7", "output.txt") }, "sess-own"), null)
    assert.equal(kit.module.spilledOutput(dir, "Read", { path: foreign }, "../sess-other"), null)
    assert.equal(kit.module.spilledOutput(dir, "Read", { path: own }, ""), null)
    assert.equal(trace.events.length, mark, JSON.stringify(trace.events.slice(mark)))
    const link = path.join(dir, "brain", "sess-own", ".system_generated", "steps", "8", "output.txt")
    fs.mkdirSync(path.dirname(link), { recursive: true })
    fs.symlinkSync(foreign, link)
    assert.equal(kit.module.spilledOutput(dir, "Read", { path: link }, "sess-own"), null)
    const stepLink = path.join(dir, "brain", "sess-own", ".system_generated", "steps", "9")
    fs.symlinkSync(path.dirname(foreign), stepLink)
    const through = path.join(stepLink, "output.txt")
    assert.equal(kit.module.spilledOutput(dir, "Read", { path: through }, "sess-own"), null)
    const later = trace.events.slice(mark)
    const brainWrites = later.filter(([op, file]) => spillTouches([[op, file]]).length && op !== "lstat" && op !== "realpath")
    assert.equal(brainWrites.length, 0, JSON.stringify(later))
    assert.equal(later.some(([, file]) => String(file).includes("sess-other")), false, JSON.stringify(later))
    const after = fs.statSync(foreign)
    assert.equal(after.mtimeMs, before.mtimeMs)
    assert.equal(after.size, before.size)
  } finally {
    await kit.dispose()
  }
})

test("parallel sessions on one home cannot read each other's spilled output", async () => {
  const trace = traceFs()
  const kit = await createBridgeKit({ nodeMocks: trace.mocks })
  try {
    const bodyA = baseBody({ metadata: { user_id: "user-a" }, messages: [{ role: "user", content: "open A" }] })
    const bodyB = baseBody({ metadata: { user_id: "user-b" }, messages: [{ role: "user", content: "open B" }] })
    const bodyA2 = baseBody({ metadata: { user_id: "user-a" }, messages: [{ role: "user", content: "open A second chat" }] })
    kit.prompts.push(async (agent) => { await agent.text("ready") })
    const parsedA = await readSse(await kit.request(bodyA))
    kit.prompts.push(async (agent) => { await agent.text("ready") })
    const parsedB = await readSse(await kit.request(bodyB))
    kit.prompts.push(async (agent) => { await agent.text("ready") })
    const parsedA2 = await readSse(await kit.request(bodyA2))
    const procs = [...kit.module.__agyTestAllProcs]
    assert.equal(procs.length, 3)
    assert.equal(new Set(procs.map((proc) => proc.agyDir)).size, 1)
    assert.equal(new Set(procs.map((proc) => proc.home ?? null)).size, 1)
    assert.deepEqual([...new Set(procs.map((proc) => proc.userId))].sort(), ["user-a", "user-b"])
    assert.equal(new Set(procs.map((proc) => proc.sessionId)).size, 3)
    for (const proc of procs) spill(proc.agyDir, `secret-${proc.sessionId}\n`, proc.sessionId, "3")
    const bySession = new Map(procs.map((proc) => [proc.sessionId, proc]))
    const mark = trace.events.length
    for (const _ of procs) {
      kit.prompts.push(async (agent) => {
        const self = bySession.get(agent.sessionId)
        const other = procs.find((proc) => proc.sessionId !== self.sessionId)
        const foreign = path.join(self.agyDir, "brain", other.sessionId, ".system_generated", "steps", "3", "output.txt")
        const reply = await agent.tool("Read", { path: foreign })
        const text = reply?.result?.content?.[0]?.text || ""
        assert.equal(text.includes("secret-"), false)
      })
    }
    const responses = await Promise.all([
      kit.request(nextTurn(bodyA, parsedA, "read the other output")),
      kit.request(nextTurn(bodyB, parsedB, "read the other output")),
      kit.request(nextTurn(bodyA2, parsedA2, "read the other output")),
    ])
    const parsed = await Promise.all(responses.map((response) => readSse(response)))
    for (const item of parsed) {
      const text = JSON.stringify(item)
      for (const proc of procs) assert.equal(text.includes(`secret-${proc.sessionId}`), false)
      assert.equal(item.content.some((block) => block.type === "tool_use" && block.name === "Read"), true)
    }
    const later = trace.events.slice(mark)
    assert.equal(spillTouches(later).length, 0, JSON.stringify(spillTouches(later)))
    for (const proc of procs) {
      assert.equal(later.some(([, file]) => String(file).includes(`${path.sep}brain${path.sep}${proc.sessionId}${path.sep}`)), false, JSON.stringify(later))
    }
  } finally {
    await kit.dispose()
  }
})

import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { HOST_VERSION, TOOL } from "../src/host.ts"
import runtime from "../src/index.ts"

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const content = 'Verify the source, preserve "quotes" and \t keep the evidence exact.\n'.repeat(12).trim()
const source = "---\nname: request-procedure\n---\n" + content + "\n"
const procedure = {
  id: "request-procedure", path: ".opencode/skills/request-procedure/SKILL.md",
  sha256: sha256(content), sourceSha256: sha256(source), name: "request-procedure", content,
}
const approvalPath = ".opencode/procedure.json"
const { name: _name, content: _content, ...pin } = procedure
const approval = JSON.stringify(pin)
const projection = "ALG current approved research procedure " + procedure.name + " (SHA-256 " + procedure.sha256 + ")\n" + content
const reference = "[Exact procedure body already supplied in this request under SHA-256 " + procedure.sha256 + ".]"
const runtimeSha256 = createHash("sha256").update(await readFile(new URL("../src/index.ts", import.meta.url))).digest("hex")
const receipt = JSON.stringify({ ok: true, runtimeSha256, procedure })
const native = '<skill_content name="' + procedure.name + '">\n# Skill: ' + procedure.name +
  "\n\n" + content + "\n\nBase directory for this skill: fixture\n</skill_content>"
const ownerId = "ses_owner" as SessionContext["sessionID"]
const owner = "build" as SessionContext["agent"]
const cleanups: Array<() => Promise<unknown>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

function exchange(id: string, value: unknown = receipt, opts: { name?: string; input?: unknown; resultType?: "text" | "json" } = {}):
  [SessionContext["messages"][number], Extract<SessionContext["messages"][number], { role: "tool" }>] {
  const name = opts.name ?? TOOL
  return [
    { role: "assistant", id: "assistant-" + id, content: [
      { type: "text", text: "Unique preamble " + id },
      { type: "tool-call", id, name, input: opts.input ?? { action: "procedure" }, providerExecuted: false },
    ] },
    { role: "tool", id: "tool-" + id, metadata: { unique: id }, content: [
      { type: "tool-result", id, name, providerExecuted: false, result: { type: opts.resultType ?? "text", value } },
    ] },
  ]
}

async function fixture() {
  const directory = await mkdtemp(join(import.meta.dir, ".procedure-history-"))
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  const skillFile = join(directory, procedure.path)
  await mkdir(dirname(skillFile), { recursive: true })
  await writeFile(skillFile, source)
  await writeFile(join(directory, approvalPath), approval)
  const session = { id: ownerId, agent: owner, projectID: "fixture", location: { directory }, parentID: undefined as string | undefined }
  const hooks = new Map<string, (request: SessionContext) => Promise<void>>()
  const permission = { allowed: true }
  const dispose = await runtime.setup({
    app: { version: HOST_VERSION },
    location: { directory, project: { id: session.projectID } },
    options: { approvedProcedure: approvalPath, approvedProcedureSha256: sha256(approval) },
    skill: { async list() {
      return { location: { directory }, data: [{ ...procedure, path: skillFile }] }
    } },
    permission: { async assert() {
      if (!permission.allowed) throw new Error("fixture denial")
    } },
    session: {
      async get() { return session },
      async hook(name: string, callback: (request: SessionContext) => Promise<void>) {
        hooks.set(name, callback)
        return { async dispose() { hooks.delete(name) } }
      },
    },
    tool: { async transform() { return { async dispose() {} } } },
  } as unknown as Plugin.Context)
  cleanups.push(dispose)
  return { async request(messages: SessionContext["messages"], mode = "context", agent = owner) {
    const request: SessionContext = {
      sessionID: ownerId, agent, model: { id: "fixture", providerID: "fixture" } as SessionContext["model"],
      messages, system: [{ type: "text", text: "Existing system instructions." }], options: {}, tools: {},
    }
    await hooks.get(mode)!(request)
    return request
  }, session, permission, revoke: () => writeFile(join(directory, approvalPath), "{}") }
}

function results(request: SessionContext) {
  return request.messages.flatMap(message => message.role === "tool" ? message.content : [])
}

function compactedReceipt() {
  return JSON.stringify({ ok: true, runtimeSha256, procedure: { ...procedure, content: reference } })
}

test("retains one full ALG read and compacts repeats on first appearance without changing the request prefix", async () => {
  const host = await fixture()
  const unique = { citation: { evidence: "one" }, note: "unique metadata" }
  const secondReceipt = JSON.stringify({ ok: true, runtimeSha256, procedure: { ...procedure, note: "separate" }, ...unique })
  const history = [...exchange("first"), ...exchange("native-1", native, { name: "skill", input: { id: procedure.id } }),
    ...exchange("second", secondReceipt), ...exchange("native-2", native, { name: "skill", input: { id: procedure.id } })]
  const snapshot = structuredClone(history)
  const firstOnly = await host.request(history.slice(0, 2))
  const first = await host.request(history)
  const appended = await host.request([...history, ...exchange("third")])

  expect(first.system).toEqual([{ type: "text", text: "Existing system instructions." }, { type: "text", text: projection }])
  expect(appended.system).toEqual(first.system)
  expect(first.messages.slice(0, 2)).toEqual(firstOnly.messages)
  expect(appended.messages.slice(0, history.length)).toEqual(first.messages)
  expect(history).toEqual(snapshot)
  expect(appended.messages[4]).toBe(history[4])
  expect(appended.messages[5]?.metadata).toBe(history[5]?.metadata)
  expect(results(appended).map(part => [part.id, part.name, part.result.value])).toEqual([
    ["first", TOOL, receipt], ["native-1", "skill", native],
    ["second", TOOL, JSON.stringify({ ok: true, runtimeSha256, procedure: { ...procedure, content: reference, note: "separate" }, ...unique })],
    ["native-2", "skill", native], ["third", TOOL, compactedReceipt()],
  ])
})

test("compaction uses the original history and starts a new anchor when the old full read is absent", async () => {
  const host = await fixture()
  const old = [...exchange("old"), ...exchange("old-repeat")]
  expect(results(await host.request(old))[1]?.result.value).toContain(reference)
  const summary = await host.request(old, "compaction")
  expect(summary.messages).toBe(old)
  expect(summary.system.map(part => part.text).join("\n")).not.toContain(content)
  const retained = [old[1]!, ...exchange("new"), ...exchange("new-repeat")]
  const resumed = await host.request(retained)
  expect(results(resumed).map(result => result.id)).toEqual(["old", "new", "new-repeat"])
  expect(results(resumed).map(result => result.result.value)).toEqual([receipt, receipt, compactedReceipt()])
  expect(resumed.system.at(-1)?.text).toBe(projection)
})

test("native assistant compaction resets the full read and call IDs within the visible history", async () => {
  const host = await fixture()
  type AssistantPart = Extract<SessionContext["messages"][number], { role: "assistant" }>["content"][number]
  type CompactionPart = Extract<AssistantPart, { type: "compaction" }>
  const boundary: SessionContext["messages"][number] = {
    role: "assistant", content: [{ type: "compaction", provider: "fixture" as CompactionPart["provider"], text: "Retained summary" }],
  }
  const [pending, orphanedResult] = exchange("pending")
  const original = [...exchange("old"), ...exchange("old-repeat"), pending]
  const first = await host.request(original)
  const resumed = await host.request([...original, boundary, orphanedResult, ...exchange("new"), ...exchange("old")])
  expect(resumed.messages.slice(0, original.length)).toEqual(first.messages)
  expect(results(resumed).map(part => part.result.value)).toEqual([
    receipt, compactedReceipt(), receipt, receipt, compactedReceipt(),
  ])
})

test("preserves unproved wrappers, stale pins, other runtimes, other tools and nonprocedure actions", async () => {
  const host = await fixture()
  const wrong = (fields: Partial<typeof procedure>) => JSON.stringify({ ok: true, runtimeSha256, procedure: { ...procedure, ...fields } })
  const unrelated = [
    ...exchange("plain", content), ...exchange("wrapped", JSON.stringify({ output: receipt })),
    ...exchange("reformatted", " " + receipt), ...exchange("json", JSON.parse(receipt), { resultType: "json" }),
    ...exchange("other-runtime", JSON.stringify({ ok: true, runtimeSha256: sha256("old runtime"), procedure })),
    ...exchange("wrong-source", wrong({ sourceSha256: sha256("other source") })),
    ...exchange("wrong-digest", wrong({ sha256: sha256("other body") })),
    ...exchange("wrong-path", wrong({ path: ".opencode/skills/other/SKILL.md" })),
    ...exchange("wrong-body", wrong({ content: content + "." })),
    ...exchange("other-tool", receipt, { name: "other" }),
    ...exchange("evidence", JSON.stringify({ ok: true, runtimeSha256, procedure, citation: { evidence: "two" } }), { input: { action: "read" } }),
    ...exchange("verdict", receipt, { input: { action: "result" } }),
    exchange("orphan")[1],
  ]
  const history = [...exchange("first"), ...unrelated]
  expect((await host.request(history)).messages).toBe(history)
  const following = await host.request([...unrelated, ...exchange("first-match")])
  expect(results(following).at(-1)?.result.value).toBe(receipt)
})

test("skips other agents and child sessions and keeps history full after denial or revocation", async () => {
  const host = await fixture()
  const history = [...exchange("first"), ...exchange("repeat")]
  expect((await host.request(history, "context", "other" as SessionContext["agent"])).messages).toBe(history)
  host.session.parentID = "ses_parent"
  expect((await host.request(history)).messages).toBe(history)
  host.session.parentID = undefined
  host.permission.allowed = false
  expect((await host.request(history)).messages).toBe(history)
  host.permission.allowed = true
  await host.revoke()
  const revoked = await host.request(history)
  expect(revoked.messages).toBe(history)
  expect(revoked.system.map(part => part.text).join("\n")).not.toContain(content)
})

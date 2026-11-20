import { expect, test } from "bun:test"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CommandDefinition } from "@opencode/plugin/promise/command"
import type { ToolContext, Info } from "@opencode/plugin/promise/tool"
import type { DeliveryHistory } from "../src/delivery.ts"
import { EvidenceReadStore } from "../src/evidence-reads.ts"
import { InvestigationHost } from "../src/host.ts"
import { registerReadOnlyReview, reviewTool } from "../src/read-only-review.ts"

type Context = InvestigationHost["context"]
type Session = Awaited<ReturnType<Context["session"]["get"]>>
type Message = DeliveryHistory[number]
type Assistant = Extract<Message, { type: "assistant" }>
type User = Extract<Message, { type: "user" }>
const file = "samples.json"
const citation = file + "#seal"
const nativeTool = "fixture_source_read"
const good = JSON.stringify([{ id: "seal", pressure: 143 }, { id: "unrelated", value: "private-other-row" }])

function nativeRead(callId: string, time: number, content = good): Assistant {
  return { id: ("msg_" + callId) as Assistant["id"], type: "assistant", agent: "build" as Assistant["agent"],
    model: { id: "fake", providerID: "fake" } as Assistant["model"], finish: "stop",
    time: { created: time, completed: time + 1 }, content: [{
      id: callId, type: "tool", name: nativeTool, time: { created: time, completed: time + 1 },
      state: { status: "completed", input: { path: file },
        content: [{ type: "text", text: JSON.stringify({ path: file, content, receipt: "read-" + callId }) }] },
    }] }
}

async function fixture(cacheSourceBytes: boolean, run: (fixture: Awaited<ReturnType<typeof setup>>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "alg-native-review-"))
  let active: Awaited<ReturnType<typeof setup>> | undefined
  try {
    active = await setup(await realpath(directory), cacheSourceBytes)
    await run(active)
  } finally {
    await active?.review.dispose()
    await rm(directory, { recursive: true, force: true })
  }
}

async function setup(directory: string, cacheSourceBytes: boolean) {
  const owner = { id: "ses_owner", projectID: "project", location: { directory }, agent: "build",
    model: { id: "fake", providerID: "fake" } } as Session
  const sessions = new Map([[owner.id, owner]])
  const history = new Map<Session["id"], Message[]>([[owner.id, [nativeRead("initial", 1)]]])
  const commands = new Map<string, CommandDefinition>()
  const tools = new Map<string, Info>()
  const notices: string[] = []
  const hooks = new Map<string, (event: any) => Promise<void> | void>()
  const permissions: { sessionID: string; action: string; resources: readonly string[] }[] = []
  let providerDenied = false
  let callbackInvocations = 0
  let toolListings = 0
  const registration = { async dispose() {} }
  const register = async (name: string, callback: (event: any) => void | Promise<void>) => {
    hooks.set(name, callback)
    return registration
  }
  const ctx = {
    location: { directory, project: { id: owner.projectID } },
    agent: { async get() { return { data: { id: "checker", mode: "subagent" }, location: { directory } } } },
    session: {
      hook: register,
      async create(input: Session) {
        const child = { ...input, projectID: owner.projectID }
        sessions.set(child.id, child)
        history.set(child.id, [])
        return child
      },
      async get({ sessionID }: { sessionID: Session["id"] }) {
        const session = sessions.get(sessionID)
        if (!session) throw new Error("SESSION_MISSING")
        return session
      },
      async context({ sessionID }: { sessionID: Session["id"] }) { return history.get(sessionID) ?? [] },
      async prompt({ sessionID, id, text, metadata }: { sessionID: Session["id"]; id: User["id"]; text: string; metadata: User["metadata"] }) {
        history.get(sessionID)!.push({ type: "user", id, text, metadata, time: { created: 1 } })
        return { sessionID, id, payload: { text, metadata } }
      },
      async synthetic({ text }: { text: string }) { notices.push(text) },
    },
    permission: {
      hook: register,
      async assert(input: { sessionID: string; action: string; resources: readonly string[] }) {
        permissions.push(input)
        if (providerDenied && input.action === nativeTool) throw new Error("NATIVE_PROVIDER_DENIED")
      },
    },
    command: { async transform(registerCommands: (editor: { add(command: CommandDefinition): void }) => void) {
      registerCommands({ add: command => commands.set(command.name, command) })
      return registration
    } },
    tool: {
      async transform(registerTools: (editor: { get(name: string): Info | undefined; add(tool: Info): void }) => void) {
        registerTools({ get: name => tools.get(name), add: tool => tools.set(tool.name, tool) })
        return registration
      },
      async list() {
        toolListings++
        return [{ id: nativeTool, execute() { callbackInvocations++ } }]
      },
    },
  } as unknown as Context
  const store = new EvidenceReadStore(directory, "review-evidence", { sessionId: owner.id,
    projectId: owner.projectID, tools: [nativeTool], cacheSourceBytes })
  await store.observe(history.get(owner.id)!)
  await store.recordFinding({ id: "pressure", interpretation: "Pressure met 143 kPa.", scope: "Fixture P-42",
    support: [citation], counterevidence: [], falsifier: "A calibrated result below 143 kPa." })
  const review = await registerReadOnlyReview(new InvestigationHost(ctx, directory, "build", "checker"), {
    residualTools: [nativeTool], async current(sessionID) {
      if (sessionID !== owner.id) throw new Error("OWNER_REQUIRED")
      return { owner, store, decisionRevision: 1, closureRequested: true, evidence: await store.observe(history.get(owner.id)!) }
    },
  })
  return {
    owner, history, review, permissions, notices, sessions, hooks,
    async command(text = "", sessionID = owner.id) {
      await commands.get("alg-review")!.execute({
        sessionID: sessionID as Parameters<CommandDefinition["execute"]>[0]["sessionID"], prompt: { text }, delivery: "queue",
      })
    },
    packet() { return [...history.values()].find(rows => rows[0]?.type === "user")?.[0] as User | undefined },
    async submit(sessionID: string, fields: Record<string, unknown>, agent = "checker") {
      return tools.get(reviewTool)!.execute(fields, { sessionID, agent, id: "review-result" } as ToolContext)
    },
    denyProvider() { providerDenied = true },
    calls() { return { callbackInvocations, toolListings } },
  }
}

const supported = { action: "submit", outcome: "supports", citations: [citation], analysis: "The cited row records 143 kPa." }

test("native child submission is bound to one scoped cached row and the current owner revision", async () => fixture(true, async f => {
  await f.command()
  const status = await f.review.status(f.owner.id)
  expect(status?.status).toBe("pending")
  const child = f.sessions.get(status!.workerSessionId as Session["id"])!
  expect(child.parentID).toBe(f.owner.id)
  expect(child.agent).toBe("checker")
  const prompt = f.packet()!.text
  expect(prompt).toContain('"pressure":143')
  expect(prompt).toContain("untrusted-source-data")
  expect(prompt).not.toContain("private-other-row")
  const context = { sessionID: child.id, agent: child.agent, tools: { [reviewTool]: {}, [nativeTool]: {}, bash: {} } }
  await f.hooks.get("context")!(context)
  expect(Object.keys(context.tools)).toEqual([reviewTool])
  const forbidden = { sessionID: child.id, agent: child.agent, action: "tool.use", resources: [nativeTool], effect: "allow" }
  await f.hooks.get("evaluate")!(forbidden)
  expect(forbidden.effect).toBe("deny")
  await expect(f.submit(f.owner.id, supported, "build")).rejects.toThrow("REVIEW_CHILD_REQUIRED")
  await expect(f.submit(child.id, { ...supported, citations: [file + "#unrelated"] })).rejects.toThrow("REVIEW_CITATIONS_INSUFFICIENT")
  await f.submit(child.id, supported)
  await expect(f.submit(child.id, supported)).rejects.toThrow("REVIEW_ALREADY_RECORDED")
  expect(await f.review.status(f.owner.id)).toMatchObject({ status: "recorded", findingId: "pressure", decisionRevision: 1,
    result: { outcome: "supports", citations: [citation], attribution: "independent-model-review" } })
  f.history.get(f.owner.id)!.push(nativeRead("changed", 5, '[{"id":"seal","pressure":10}]'))
  expect((await f.review.status(f.owner.id))?.status).toBe("stale")
}))

test("an approved residual consumes exactly one completed ordinary owner-native call receipt", async () => fixture(false, async f => {
  await f.command("read " + nativeTool + " " + citation)
  expect(f.packet()).toBeUndefined()
  expect(f.notices).toHaveLength(1)
  f.history.get(f.owner.id)!.push(nativeRead("residual", Date.now() + 100))
  await f.command()
  const status = await f.review.status(f.owner.id)
  expect(status?.residualRead).toMatchObject({ reference: citation, tool: nativeTool, path: file,
    callId: "residual", receipt: "read-residual" })
  expect(f.packet()!.text).toContain('"pressure":143')
  expect(f.packet()!.text).not.toContain("private-other-row")
  expect(f.calls()).toEqual({ callbackInvocations: 0, toolListings: 0 })
  await f.submit(status!.workerSessionId, supported)
  expect((await f.review.status(f.owner.id))?.status).toBe("recorded")
}))

test("owner-native permission denial leaves the exact gap and never invokes an original tool callback", async () => fixture(false, async f => {
  await f.command("read " + nativeTool + " " + citation)
  f.denyProvider()
  const row = nativeRead("denied", Date.now() + 100)
  const part = row.content[0]!
  if (part.type !== "tool") throw new Error("FIXTURE_TOOL_MISSING")
  row.content = [{ ...part, state: { status: "error", input: { path: file },
    error: { type: "permission", message: "MCP permission denied" } } }]
  f.history.get(f.owner.id)!.push(row)
  await f.command()
  const status = await f.review.status(f.owner.id)
  expect(status?.residualRead).toBeUndefined()
  expect(f.packet()!.text).toContain('"missing":["' + citation + '"]')
  expect(f.packet()!.text).not.toContain('"pressure":143')
  await expect(f.submit(status!.workerSessionId, supported)).rejects.toThrow("REVIEW_CITATIONS_INSUFFICIENT")
  await f.submit(status!.workerSessionId, { action: "submit", outcome: "missing", citations: [], analysis: "Provider denied read." })
  expect((await f.review.status(f.owner.id))?.result?.outcome).toBe("missing")
  expect(f.calls()).toEqual({ callbackInvocations: 0, toolListings: 0 })
}))

test("two post-approval native calls cannot stand in for the one bounded residual read", async () => fixture(false, async f => {
  await f.command("read " + nativeTool + " " + citation)
  const time = Date.now() + 100
  f.history.get(f.owner.id)!.push(nativeRead("first", time), nativeRead("second", time + 2))
  await f.command()
  const status = await f.review.status(f.owner.id)
  expect(status?.residualRead).toBeUndefined()
  await expect(f.submit(status!.workerSessionId, supported)).rejects.toThrow("REVIEW_CITATIONS_INSUFFICIENT")
}))

import { afterEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { InvestigationMcpPort, InvestigationResult } from "../../../src/investigation/index.ts"
import { createV2InvestigationBridge } from "../core/investigation.ts"
import { canonicalDirectory, InvestigationHost } from "../src/host.ts"
import { RESEARCH_TOOL, registerResearchWorkers, researchRolesSchema } from "../src/research-workers.ts"

const roles = [
  { agent: "coverage-researcher", question: "What coverage can we establish?" },
  { agent: "limits-researcher", question: "What coverage claims are unsupported?" },
]
const deny = [{ action: "*", resource: "*", effect: "deny" as const }]
const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose()
})

type Context = Plugin.Context
type Session = Awaited<ReturnType<Context["session"]["get"]>>
type Message = Awaited<ReturnType<Context["session"]["context"]>>[number]
type Prompt = Parameters<Context["session"]["prompt"]>[0]
type Call = { sessionID: string; agent: string; signal: AbortSignal }
type Execute = (input: object, caller: Call) => Promise<{ content: string }>

async function fixture() {
  const directory = await canonicalDirectory(await mkdtemp(join(import.meta.dir, ".research-")))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const projectID = "project"
  const owner = { projectID, directory, sessionID: "owner" }
  const model = { id: "fixture-model", providerID: "fixture-provider" }
  const sessions = new Map<string, Session>(["owner", "other-owner"].map(id => [
    id, { id, agent: "build", model, projectID, location: { directory }, time: {} } as Session,
  ]))
  const histories = new Map<string, Message[]>()
  const created: string[] = []
  const prompts: Prompt[] = []
  const state = {
    beforeAck: async (_prompt: Prompt) => {},
    beforeContext: async (_sessionID: string) => {},
    result: {
      manifest_ref: "synthetic:PRIVATE_MANIFEST_REF", digest: "a".repeat(64),
      source_versions: ["PRIVATE_SOURCE"], observed_at: "2025-01-01T00:00:00.000Z",
      access_scope: "PRIVATE_SCOPE",
      coverage: {
        synthetic: true, row_count: 52, sample_size: "PRIVATE_VALUE", rows: ["PRIVATE_ROW"],
        cohorts: [{ id: "route_a", inspected: 26, defects: 2 }, { id: "route_b", inspected: 26, defects: 8 }],
      },
    } as InvestigationResult,
    uncertainWork: false,
    unsafeAgent: "",
    reads: 0,
  }
  const operation = "fixture.count"
  const port: InvestigationMcpPort = {
    capabilities: {
      server_id: "fixture", server_revision: "1", tool_id: operation, tool_schema_revision: "1",
      principal_id: "fixture", project_id: projectID, effects: ["read"], qualified: true,
      idempotent_submit: true, lookup_by_submission_id: true, response_limit_bytes: 4096,
    },
    async submit() {
      if (state.uncertainWork) throw new Error("Lost work acknowledgement")
      return { kind: "result", result: state.result, actual_cost: 1 }
    },
    async lookup() { return { kind: "unknown", reason: "Fixture" } },
    async validateResult() { throw new Error("Unexpected validation") },
    async readResult() { state.reads++; throw new Error("Unexpected raw evidence read") },
  }
  const bridge = createV2InvestigationBridge({
    port, approvedJob: { operation, recipe_version: "1", reserved_cost: 1, parameters: {}, query: {} },
  })
  async function complete() {
    bridge.create(owner)
    await bridge.admit(owner)
    expect((await bridge.dispatch(owner)).work?.status).toBe(state.uncertainWork ? "outcome_unknown" : "result_recorded")
  }

  async function batch() {
    const runs = join(directory, ".opencode", "runs")
    const run = (await readdir(runs)).find(id => id.startsWith("v2-research-"))
    return JSON.parse(await readFile(join(runs, run!, "batch.json"), "utf8"))
  }

  async function attach(configured = roles, options?: { cohorts: boolean }) {
    const hooks = new Map<string, (event: any) => void | Promise<void>>()
    const hook = async (name: string, callback: (event: any) => void | Promise<void>) => {
      hooks.set(name, callback)
      return { dispose: async () => { hooks.delete(name) } }
    }
    let execute: Execute | undefined
    const ctx = {
      location: { directory, project: { id: projectID } },
      agent: {
        async get({ agentID }: { agentID: string }) {
          const defaults = [
            { action: "*", resource: "*", effect: "allow" },
            { action: "read", resource: "*.env", effect: "ask" },
            { action: "read", resource: "*.env.*", effect: "ask" },
            { action: "read", resource: "*.env.example", effect: "allow" },
          ]
          const permissions = [
            ...defaults, ...deny, ...deny, { action: "browser", resource: "*", effect: "deny" },
            { action: "skill", resource: "browser", effect: "deny" },
          ]
          if (agentID === state.unsafeAgent) permissions.push({ action: "shell", resource: "*", effect: "allow" })
          return { location: { directory }, data: { id: agentID, mode: "subagent", permissions } }
        },
      },
      session: {
        hook,
        async get({ sessionID }: { sessionID: string }) {
          const session = sessions.get(sessionID)
          if (!session) throw new Error("Unknown fixture session")
          return session
        },
        async create(input: Session) {
          const reserved = await batch()
          expect(reserved.assignments).toHaveLength(configured.length)
          expect(reserved.assignments.some((a: { sessionId: string }) => a.sessionId === input.id)).toBeTrue()
          expect(input.model).toEqual(model)
          expect(input.permissions).toEqual(deny)
          created.push(input.id)
          const child = { ...input, projectID, time: { created: 0, updated: 0 } }
          sessions.set(child.id, child)
          return child
        },
        async prompt(input: Prompt) {
          prompts.push(input)
          histories.set(input.sessionID, [{
            type: "user", id: input.id, text: input.text, metadata: input.metadata, time: { created: 1 },
          } as Message])
          await state.beforeAck(input)
          return { id: input.id, sessionID: input.sessionID, payload: { metadata: input.metadata, text: input.text } }
        },
        async context({ sessionID }: { sessionID: string }) {
          await state.beforeContext(sessionID)
          return histories.get(sessionID) ?? []
        },
      },
      permission: { hook },
      tool: {
        async transform(add: (editor: unknown) => void) {
          add({ get: () => undefined, add: (definition: { name: string; execute: Execute }) => {
            expect(definition.name).toBe(RESEARCH_TOOL)
            execute = definition.execute
          } })
          return { dispose: async () => { execute = undefined } }
        },
      },
    } as unknown as Context
    const host = new InvestigationHost(ctx, directory, "build", "checker")
    const registration = await registerResearchWorkers(ctx, host, bridge, configured, options)
    cleanup.push(registration.dispose)
    async function call(action: string, sessionID = "owner", agent = "build") {
      const output = await execute!({ action }, { sessionID, agent, signal: new AbortController().signal })
      return JSON.parse(output.content)
    }
    return { ...registration, call, hooks }
  }

  function answer(sessionID: string, report: string) {
    const child = sessions.get(sessionID)!
    histories.get(sessionID)!.push(
      { type: "assistant", id: "answer", agent: child.agent, model, time: { created: 2, completed: 3 }, finish: "stop",
        content: [{ type: "text", text: report }] } as Message,
      { type: "idle", id: "idle", time: { created: 4 }, outcome: "succeeded" } as Message,
    )
  }
  return { owner, bridge, state, complete, attach, batch, answer, sessions, histories, created, prompts }
}

test("reserves both assignments before dispatch and admits independent workers in parallel", async () => {
  const f = await fixture()
  await f.complete()
  const first = await f.attach()
  const second = await f.attach()
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  f.state.beforeAck = async () => {
    if (f.prompts.length === 2) entered.resolve()
    await release.promise
  }
  const concurrent = Promise.all([first.call("start"), second.call("start")])
  try {
    const timeout = setTimeout(() => entered.reject(new Error("Worker prompts did not overlap")), 2000)
    try { await entered.promise } finally { clearTimeout(timeout) }
    expect(f.created).toHaveLength(2)
    expect((await f.batch()).assignments.map((a: { promptId: string }) => a.promptId).sort())
      .toEqual(f.prompts.map(p => p.id).sort())
    const payloads = f.prompts.map(p => JSON.parse(p.text!.split("\n").at(-1)!))
    expect(payloads.map(p => p.question).sort()).toEqual(roles.map(r => r.question).sort())
    expect(payloads[0].evidence).toEqual(payloads[1].evidence)
    expect(payloads[0].evidence.coverage).toEqual({ synthetic: true, row_count: 52 })
    expect(JSON.stringify(f.prompts)).not.toContain("PRIVATE_")
    expect(f.state.reads).toBe(0)
  } finally {
    release.resolve()
    await concurrent
  }
  const worker = f.created[0]!
  const event = { sessionID: worker, action: "mcp_raw", effect: "allow" }
  await first.hooks.get("evaluate")!(event)
  expect(event.effect).toBe("deny")
  const context = { sessionID: worker, agent: f.sessions.get(worker)!.agent, tools: { shell: {} } as Record<string, unknown> }
  await first.hooks.get("context")!(context)
  expect(context.tools).toEqual({})
  expect((await first.call("status", worker, f.sessions.get(worker)!.agent)).error).toBeDefined()
  f.answer(worker, "The manifest records 52 rows.")
  expect((await first.call("status")).workers).toContainEqual(expect.objectContaining({
    sessionId: worker, status: "reported", report: "The manifest records 52 rows.",
  }))
})

test("restart never reissues a prompt after a lost acknowledgment, even with visible history", async () => {
  const f = await fixture()
  await f.complete()
  const first = await f.attach()
  f.state.beforeAck = async prompt => {
    if (f.sessions.get(prompt.sessionID)?.agent === roles[0]!.agent) throw new Error("Lost acknowledgment")
  }
  const launched = await first.call("start")
  expect(launched).toMatchObject({ advisory: true })
  expect(launched.workers.map((w: { status: string }) => w.status)).toEqual(["admission_unverified", "admitted"])
  f.answer(launched.workers[0].sessionId, "Unconfirmed")
  f.answer(launched.workers[1].sessionId, "Confirmed")
  await first.dispose()
  const restarted = await f.attach()
  const resumed = await restarted.call("start")
  expect(resumed.advisory).toBeTrue()
  expect(resumed.workers[0]).not.toHaveProperty("report")
  expect(resumed.workers[1].report).toBe("Confirmed")
  expect(f.created).toHaveLength(2)
  expect(f.prompts).toHaveLength(2)
})

test("isolates owners and withholds a report when the host child parent changes", async () => {
  const f = await fixture()
  await f.complete()
  const registration = await f.attach(roles.slice(0, 1))
  const started = await registration.call("start")
  const { sessionId } = started.workers[0]
  f.answer(sessionId, "Owner-only finding")
  expect(await registration.call("status", "other-owner")).toEqual({ status: "not_started" })
  expect((await registration.call("start", "other-owner")).error).toBe("RESEARCH_SETTLED_EVIDENCE_REQUIRED")
  expect((await registration.call("status")).workers[0].report).toBe("Owner-only finding")
  f.sessions.set(sessionId, { ...f.sessions.get(sessionId)!, parentID: "other-owner" } as Session)
  expect((await registration.call("status")).workers[0].status).toBe("worker_unverified")
  expect((await registration.call("status")).workers[0]).not.toHaveProperty("report")
})

test("leaves hooks untouched for a forged research session in another location", async () => {
  const f = await fixture()
  await f.complete()
  const registration = await f.attach(roles.slice(0, 1))
  const { workers: [{ sessionId }] } = await registration.call("start")
  const bound = f.sessions.get(sessionId)!
  const foreignDirectory = await mkdtemp(join(f.owner.directory, "foreign-"))
  f.sessions.set(sessionId, { ...bound, location: { directory: foreignDirectory } } as Session)
  const permission = { sessionID: sessionId, action: "shell", effect: "allow" }
  const retry = { sessionID: sessionId, agent: bound.agent, decision: { retry: true } }
  const context = { sessionID: sessionId, agent: bound.agent, tools: { shell: {} } }
  await registration.hooks.get("evaluate")!(permission)
  await registration.hooks.get("retry")!(retry)
  await registration.hooks.get("context")!(context)
  expect(permission.effect).toBe("allow")
  expect(retry.decision.retry).toBeTrue()
  expect(context.tools).toEqual({ shell: {} })
})

test("shares only reviewed cohorts and keeps reports current across unrelated ledger revisions", async () => {
  const f = await fixture()
  await f.complete()
  const registration = await f.attach(roles, { cohorts: true })
  const started = await registration.call("start")
  const payloads = f.prompts.map(p => JSON.parse(p.text!.split("\n").at(-1)!))
  expect(payloads.map(p => p.evidence.coverage)).toEqual(roles.map(() => ({
    synthetic: true, row_count: 52, cohorts: f.state.result.coverage.cohorts,
  })))
  const { sessionId } = started.workers[0]
  f.answer(sessionId, "Route B recorded more defects with equal inspection counts.")
  const { work_key, manifest_digest, revision } = started.evidence
  await f.bridge.grant(f.owner, { ...f.owner, sessionID: "checker", parentID: "owner" }, { work_key, manifest_digest })
  expect(f.bridge.advisoryEvidence(f.owner)!.revision).toBeGreaterThan(revision)
  expect((await registration.call("status")).workers[0].report).toContain("Route B")
})

test("refuses opted-in cohort material outside the exact aggregate schema", async () => {
  const f = await fixture()
  f.state.result.coverage.cohorts = [{ id: "route_a", inspected: 26, defects: 27, rows: ["PRIVATE_ROW"] }]
  await f.complete()
  const registration = await f.attach(roles, { cohorts: true })
  expect((await registration.call("start")).error).toBe("RESEARCH_SETTLED_EVIDENCE_REQUIRED")
  expect(f.created).toHaveLength(0)
})

test("rechecks the evidence revision after reading reports and preserves the original reservation", async () => {
  const f = await fixture()
  await f.complete()
  const registration = await f.attach(roles.slice(0, 1))
  const started = await registration.call("start")
  const { sessionId } = started.workers[0]
  f.answer(sessionId, "Report for the original revision")
  f.state.beforeContext = async id => {
    if (id !== sessionId) return
    f.state.beforeContext = async () => {}
    await f.bridge.setNextMeasurement(f.owner, { expected_decision_revision: 0, next_action: "Review the new decision." })
  }
  const stale = await registration.call("status")
  expect(stale.status).toBe("unavailable")
  expect(stale.workers[0]).not.toHaveProperty("report")
  expect(await registration.call("start")).toEqual(stale)
  expect(f.prompts).toHaveLength(1)
})

test("rejects unsettled evidence, duplicate assignments and an agent with tool access", async () => {
  expect(researchRolesSchema.safeParse([...roles, { agent: "third", question: "Third?" }]).success).toBeFalse()
  expect(researchRolesSchema.safeParse([roles[0], { ...roles[1], question: roles[0]!.question.toUpperCase() }]).success).toBeFalse()
  expect(researchRolesSchema.safeParse([roles[0], roles[0]]).success).toBeFalse()
  const f = await fixture()
  f.state.uncertainWork = true
  await f.complete()
  const attached = await f.attach()
  expect((await attached.call("start")).error).toBe("RESEARCH_SETTLED_EVIDENCE_REQUIRED")
  f.state.unsafeAgent = roles[1]!.agent
  expect((await attached.call("start")).error).toBe("RESEARCH_AGENT_UNQUALIFIED")
  expect(f.created).toHaveLength(0)
})

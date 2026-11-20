import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { hashObject } from "../../../src/session-memory/store.ts"
import runtime from "../src/index.ts"
import { TOOL } from "../src/host.ts"

const cleanup: Array<() => unknown> = []
afterEach(async () => {
  for (const done of cleanup.splice(0).reverse()) await done()
})

const owner = "ses_owner"
const checkerAgent = "alg-investigation-checker"
const rules = [{ action: "*", resource: "*", effect: "deny" }, { action: TOOL, resource: "*", effect: "allow" }]
const inputSchema = { type: "object" as const, properties: {}, additionalProperties: true }
const schemaHash = hashObject({ inputSchema, outputSchema: null })
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")
const approvalPath = ".opencode/research-procedure.json"
const sourcePath = ".opencode/skills/research/SKILL.md"
const skillId = "native:fixture-research"
const skillBody = "Observe the bounded synthetic result, then state the uncertainty."

async function fixture() {
  const directory = await mkdtemp(join(import.meta.dir, ".host-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const serviceCalls: string[] = []
  const outcomes: { submit?: object; lookup?: object } = {}
  const connections: Server[] = []
  const manifest = {
    manifest_ref: "fixture:manifest", digest: "a".repeat(64), source_versions: ["fixture"],
    coverage: { synthetic: true }, observed_at: new Date().toISOString(), access_scope: "fixture:project",
  }
  const { source_versions: _sourceVersions, observed_at: _observedAt, ...resultScope } = manifest
  const names = ["submit", "lookup", "validate", "read"]
  const service = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const server = new Server({ name: "host-fixture", version: "1" }, { capabilities: { tools: {} } })
      connections.push(server)
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: names.map(name => ({ name, inputSchema })) }))
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        serviceCalls.push(params.name)
        const value = params.name === "validate"
          ? { valid: true, validity_key: params.arguments?.validity_key, access_scope: manifest.access_scope }
          : params.name === "read"
            ? { ...resultScope, cursor: null, next_cursor: null, rows: [{ synthetic_count: 1 }] }
            : outcomes[params.name as keyof typeof outcomes] ?? { kind: "result", result: manifest, actual_cost: 1 }
        return { content: [{ type: "text", text: JSON.stringify(value) }] }
      })
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, enableJsonResponse: true,
      })
      await server.connect(transport)
      return transport.handleRequest(request)
    },
  })
  cleanup.push(async () => {
    service.stop(true)
    await Promise.all(connections.map(connection => connection.close()))
  })
  const tool = (name: string) => ({ name, schemaHash })
  const options = {
    enabled: true,
    adapter: {
      endpoint: `http://127.0.0.1:${service.port}/mcp`,
      serverId: "fixture", serverRevision: "1", principalId: "fixture",
      mcpServerName: "host-fixture", mcpServerVersion: "1",
      profileEvidence: "fixture", verifierId: "fixture", evidenceSha256: "b".repeat(64),
      verifiedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      readOnlyOperations: true, scopeEnforcedByServer: true, idempotentSubmit: true, lookupBySubmissionId: true,
      operations: ["fixture.read"],
      executionLimits: { maxDurationMs: 500, maxBytesScanned: 2048, maxResultBytes: 1024, maxCost: 1 },
      submit: tool("submit"), lookup: tool("lookup"), validateResult: tool("validate"), readResult: tool("read"),
    },
    approvedJob: { operation: "fixture.read", recipe_version: "1", reserved_cost: 1, query: {}, parameters: {} },
  }

  type Session = {
    id: string
    parentID?: string
    agent: string
    projectID: string
    location: { directory: string }
    metadata?: Record<string, unknown>
    permissions?: typeof rules
    model?: { id: string; providerID: string }
    time: Record<string, number>
  }
  type Execute = (input: unknown, caller: { sessionID: string; agent: string; signal: AbortSignal }) =>
    Promise<{ content: string }>
  type Hook = (input: any) => Promise<void> | void
  const sessions = new Map<string, Session>([[owner, {
    id: owner, agent: "build", projectID: "fixture-project", location: { directory },
    model: { id: "fixture", providerID: "synthetic" }, time: {},
  }]])
  const counters = { create: 0, prompt: 0 }
  const entries = new Map<string, Map<string, unknown>>()
  const state = {
    uncertainPrompt: false, checkerDenied: false, effectiveDeny: false,
    afterWorkerCreate: undefined as undefined | (() => Promise<void>),
    afterReload: undefined as undefined | (() => Promise<void>),
  }
  const histories = new Map<string, unknown[]>()
  const catalog = {
    directory, reloads: 0,
    skills: [{ id: skillId, name: "Research Fixture", path: join(directory, sourcePath), content: skillBody },
      { id: "other-skill", name: "Other Skill", path: join(directory, "other.md"), content: "UNSELECTED BODY" }],
  }

  async function installProcedure(content = skillBody, hash = sha256(content)) {
    const raw = "---\nname: Research Fixture\n---\n" + content
    await mkdir(join(directory, ".opencode", "skills", "research"), { recursive: true })
    await writeFile(join(directory, sourcePath), raw)
    const approval = JSON.stringify({ id: skillId, path: sourcePath, sha256: hash, sourceSha256: sha256(raw) }) + "\n"
    await writeFile(join(directory, approvalPath), approval)
    return { ...options, approvedProcedure: approvalPath, approvedProcedureSha256: sha256(approval) }
  }

  async function attach(overrides: Record<string, unknown> = {}) {
    const hooks = new Map<string, Hook>()
    let advertisedInput: { properties: Record<string, unknown> & { action: { enum: string[] } }; required: string[] }
    let execute: Execute | undefined
    const hook = async (kind: string, callback: Hook) => {
      hooks.set(kind, callback)
      return { dispose: async () => { hooks.delete(kind) } }
    }
    const detach = await runtime.setup({
      app: { version: "2.3.2" }, options, ...overrides,
      location: { directory, project: { id: "fixture-project" } },
      agent: {
        async get() {
          const permissions = state.checkerDenied ? [...rules, { action: TOOL, resource: "*", effect: "deny" }] : rules
          return { location: { directory }, data: { id: checkerAgent, mode: "subagent", permissions } }
        },
      },
      skill: {
        async reload() { catalog.reloads++; await state.afterReload?.() },
        async list() { return { location: { directory: catalog.directory }, data: catalog.skills } },
      },
      session: {
        hook,
        instructions: { entry: {
          async list({ sessionID }: { sessionID: string }) {
            return Array.from(entries.get(sessionID) ?? [], ([key, value]) => ({ key, value }))
          },
          async put({ sessionID, key, value }: { sessionID: string; key: string; value: unknown }) {
            const scope = entries.get(sessionID) ?? new Map<string, unknown>()
            scope.set(key, value)
            entries.set(sessionID, scope)
          },
          async remove({ sessionID, key }: { sessionID: string; key: string }) { entries.get(sessionID)?.delete(key) },
        } },
        async get({ sessionID }: { sessionID: string }) {
          const session = sessions.get(sessionID)
          if (!session) throw new Error("unknown")
          return session
        },
        async create(input: Omit<Session, "projectID" | "time">) {
          counters.create++
          const session = { ...input, projectID: "fixture-project", time: {} }
          sessions.set(input.id, session)
          await state.afterWorkerCreate?.()
          return session
        },
        async prompt(input: { sessionID: string; id: string; text: string; metadata: unknown }) {
          counters.prompt++
          if (state.uncertainPrompt) throw new Error("lost acknowledgement")
          histories.set(input.sessionID, [{ ...input, type: "user" }])
          return { ...input, payload: { metadata: input.metadata } }
        },
        async context({ sessionID }: { sessionID: string }) { return histories.get(sessionID) ?? [] },
      },
      permission: { hook, async assert() {
        if (state.effectiveDeny) throw new Error("effective deny")
      } },
      tool: {
        hook,
        async transform(add: (editor: unknown) => void) {
          add({ get: () => undefined, add: (definition: { name: string; execute: Execute; input: typeof advertisedInput }) => {
            expect(definition.name).toBe(TOOL)
            advertisedInput = definition.input
            execute = definition.execute
          } })
          return { dispose: async () => { execute = undefined } }
        },
      },
    } as unknown as Plugin.Context)
    cleanup.push(detach)
    const call = async (action: string, fields = {}, sessionID = owner, agent = "build") => {
      if (!execute) throw new Error("tool missing")
      return JSON.parse((await execute({ action, ...fields }, { sessionID, agent, signal: new AbortController().signal })).content)
    }
    return { call, detach, hooks, get toolInput() { return advertisedInput } }
  }

  return { directory, sessions, histories, attach, counters, serviceCalls, state, catalog, installProcedure, outcomes }
}

async function ready(f: Awaited<ReturnType<typeof fixture>>, options?: unknown) {
  const host = await f.attach(options ? { options } : {})
  expect((await host.call("create")).ok).toBe(true)
  expect((await host.call("admit")).work.status).toBe("reserved")
  expect((await host.call("dispatch")).work.status).toBe("result_recorded")
  return host
}

async function presented(
  host: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["attach"]>>,
  sessionID = owner,
  agent = "build",
  text = "Continue.",
  input = host.toolInput,
) {
  const skill = { description: "Native", input: { type: "object" } }
  const request = { sessionID, agent, system: [], messages: [{ role: "user", content: [{ type: "text", text }] }],
    tools: { [TOOL]: { description: "ALG", input }, skill } }
  await host.hooks.get("context")!(request)
  expect(request.tools.skill).toBe(skill)
  return request.tools[TOOL]?.input
}

test("owner wire actions follow the durable investigation and keep settled reconciliation", async () => {
  const f = await fixture()
  const host = await f.attach({ options: await f.installProcedure() })
  const wire = () => presented(host)
  const actions = async () => (await wire())?.properties.action.enum
  expect(await actions()).toEqual(["create", "status"])
  expect((await host.call("start")).error).toBe("RESULT_MANIFEST_REQUIRED")
  expect(f.counters).toEqual({ create: 0, prompt: 0 })
  const explicit = await presented(host, owner, "build", "Show diagnostics and read the procedure.")
  expect(explicit?.properties.action.enum).toEqual(["create", "status", "diagnostics", "procedure"])
  expect(await host.call("diagnostics")).toMatchObject({ ok: true, enabled: true })
  expect(await host.call("procedure")).toMatchObject({ ok: true, procedure: { id: skillId } })

  await host.call("create")
  expect(await actions()).toEqual(["admit", "status", "set_next_measurement"])
  expect((await wire())?.properties).not.toHaveProperty("refutation")
  await host.call("admit")
  expect(await actions()).toEqual(["admit", "dispatch", "status"])
  expect(Object.keys((await wire())!.properties)).toEqual(["action"])
  f.outcomes.submit = { kind: "running", external_job_id: "fixture-job" }
  expect((await host.call("dispatch")).work.status).toBe("running")
  expect(await actions()).toEqual(["reconcile", "status"])
  f.outcomes.lookup = { kind: "unknown", reason: "Delayed visibility" }
  expect((await host.call("reconcile")).work.status).toBe("outcome_unknown")
  expect(await actions()).toEqual(["reconcile", "status"])
  delete f.outcomes.lookup
  expect((await host.call("reconcile")).work.status).toBe("result_recorded")
  expect(await actions()).toEqual(["reconcile", "status", "set_next_measurement", "start"])
  expect((await wire())?.properties).toHaveProperty("refutation")
  expect(await host.call("reconcile")).toMatchObject({ ok: true, work: { status: "result_recorded" } })
  expect(f.serviceCalls.filter(name => name === "submit")).toEqual(["submit"])
})

test("successful owner setup omits only duplicate lifecycle guidance", async () => {
  const f = await fixture()
  const host = await f.attach()
  for (const action of ["create", "admit", "dispatch", "reconcile"]) {
    const result = await host.call(action)
    const { guidance, worker, ...status } = await host.call("status")
    expect(status.ok).toBe(true)
    expect(guidance).toBe(status.decision.next_action)
    expect(typeof guidance).toBe("string")
    const expected = action === "reconcile" ? { ...status, worker } : status
    expect(result).toEqual(expected)
  }
  const next_action = "Review the settled calibration against an independent source"
  expect(await host.call("set_next_measurement", { expected_decision_revision: 0, next_action }))
    .toMatchObject({ ok: true, decision_revision: 1, decision: { next_action } })
  const status = await host.call("status")
  expect(status.guidance).not.toBe(next_action)
  expect(typeof status.guidance).toBe("string")
  expect(await host.call("reconcile")).toEqual(status)
  expect(f.serviceCalls.filter(name => name === "submit")).toEqual(["submit"])
})

test("checker wire actions follow grant, citation and verdict while execution supports exact retries", async () => {
  const f = await fixture()
  const host = await ready(f, await f.installProcedure())
  expect(await presented(host, owner, checkerAgent)).toBeUndefined()
  const { workerSessionId, runId } = (await host.call("start")).worker
  const workerWire = () => presented(host, workerSessionId, checkerAgent)
  const root = await presented(host)
  expect(root?.properties.action.enum).toEqual(["reconcile", "status", "set_next_measurement", "revoke"])
  expect(root?.properties).not.toHaveProperty("citation")
  expect(await host.call("start")).toMatchObject({ ok: true, worker: { workerSessionId, runId } })
  expect(f.counters).toEqual({ create: 1, prompt: 1 })

  expect((await workerWire())?.properties.action.enum).toEqual(["read"])
  expect((await workerWire())?.required).toEqual(["action", "runId"])
  expect(Object.keys((await workerWire())!.properties)).toEqual(["action", "runId"])
  expect((await presented(host, workerSessionId, checkerAgent, "Show the procedure."))?.properties.action.enum)
    .toEqual(["read", "procedure"])
  f.state.effectiveDeny = true
  expect(await workerWire()).toBeUndefined()
  expect(await host.call("read", { runId }, workerSessionId, checkerAgent)).toMatchObject({
    ok: false, error: "CHECKER_RESULT_PERMISSION_DENIED",
  })
  f.state.effectiveDeny = false
  const { citation } = await host.call("read", { runId }, workerSessionId, checkerAgent)
  expect((await workerWire())?.properties.action.enum).toEqual(["read", "result"])
  const verdict = { runId, citation, result: "pass" }
  expect(await host.call("result", verdict, workerSessionId, checkerAgent)).toMatchObject({ ok: true })
  expect(await workerWire()).toBeUndefined()
  expect(await host.call("result", verdict, workerSessionId, checkerAgent)).toMatchObject({ ok: true })
  expect(await host.call("revoke", { runId })).toMatchObject({ ok: true })
  expect(await workerWire()).toBeUndefined()
  expect(await host.call("result", verdict, workerSessionId, checkerAgent)).toMatchObject({ ok: false })

  expect(host.toolInput.properties.action.enum).toContain("result")
  const modified = { ...host.toolInput, required: ["action", "custom"] }
  expect(await presented(host, owner, "build", "Continue.", modified)).toBe(modified)
  expect(await presented(host, workerSessionId, checkerAgent, "Continue.", modified)).toBe(modified)
  expect((await host.call("read", { runId })).error).toBe("CHECKER_REQUIRED")
})

test("an invalid dispatch returns its exact argument contract before any service call", async () => {
  const f = await fixture()
  const host = await f.attach()
  await host.call("create")
  await host.call("admit")
  const before = f.serviceCalls.length
  const blocked = await host.call("dispatch", { expected_decision_revision: 0 })
  expect(blocked).toMatchObject({ ok: false, error: "UNSUPPORTED_OR_INVALID_ACTION",
    contract: { action: "dispatch", required: [], optional: [] } })
  expect(f.serviceCalls.length).toBe(before)
  expect((await host.call(blocked.contract.action)).work.status).toBe("result_recorded")
  expect(await host.call("set_next_measurement", { unknown_field: "untrusted" })).toMatchObject({
    contract: { required: ["expected_decision_revision", "next_action"], optional: ["refutation"] },
  })
  await host.detach()
})

test("pinned hook integration reattaches one worker, reprojects the decision, and fences checker certification", async () => {
  const f = await fixture()
  const host = await ready(f)
  const diagnostics = await host.call("diagnostics")
  const hash = createHash("sha256").update(await readFile(new URL("../src/index.ts", import.meta.url))).digest("hex")
  expect(diagnostics).toMatchObject({ ok: true, runtimeSha256: hash, hostVersion: "2.3.2" })
  const decision = "Measure the fixture count independently."
  expect(await host.call("set_next_measurement", { expected_decision_revision: 0, next_action: decision }))
    .toMatchObject({ ok: true, decision_revision: 1 })

  await Promise.all([host.call("start"), host.call("start")])
  const launched = await host.call("status")
  expect(launched.worker.status).toBe("prompt_observed")
  const { runId, workerSessionId, promptId } = launched.worker
  expect(f.sessions.get(workerSessionId)).toMatchObject({ parentID: owner, agent: checkerAgent, permissions: rules })
  await host.detach()

  const restarted = await f.attach()
  expect(await restarted.call("shell_gate")).toMatchObject({ ok: false, error: "UNSUPPORTED_OR_INVALID_ACTION" })
  const originalProject = f.sessions.get(owner)!.projectID
  f.sessions.get(owner)!.projectID = "foreign-project"
  expect(await restarted.call("status", { runId })).toMatchObject({ ok: false, error: "OWNER_REQUIRED" })
  f.sessions.get(owner)!.projectID = originalProject
  const attached = await restarted.call("start")
  expect(attached.worker).toMatchObject({ runId, workerSessionId, promptId, status: "prompt_observed" })
  expect(f.counters).toEqual({ create: 1, prompt: 1 })

  for (const name of ["context", "compaction"]) {
    const request = { sessionID: owner, agent: "build", system: [] as { text: string }[], messages: [{ role: "user", content: "Continue." }] }
    await restarted.hooks.get(name)!(request)
    expect(JSON.stringify(request.messages)).toContain(decision)
    expect(request.system[0]?.text).toContain(runId)
    const unrelated = { sessionID: workerSessionId, agent: checkerAgent, system: [], messages: [] }
    await restarted.hooks.get(name)!(unrelated)
    expect(unrelated.system).toEqual([])
  }

  const denied = { sessionID: workerSessionId, agent: checkerAgent, action: "shell", effect: "allow" }
  await restarted.hooks.get("evaluate")!(denied)
  expect(denied.effect).toBe("deny")
  const ask = { sessionID: workerSessionId, agent: checkerAgent, action: TOOL, effect: "ask" }
  await restarted.hooks.get("evaluate")!(ask)
  expect(ask.effect).toBe("deny")
  const activeRetry: { sessionID: string; agent: string; decision: { retry: false } | { retry: true; delay: number } } = {
    sessionID: workerSessionId, agent: checkerAgent, decision: { retry: true, delay: 1 },
  }
  await restarted.hooks.get("retry")!(activeRetry)
  expect(activeRetry.decision).toEqual({ retry: false })
  const liveWorker = f.sessions.get(workerSessionId)!
  const collision = "ses_algv2_forged"
  f.sessions.set(collision, { ...liveWorker, id: collision })
  liveWorker.projectID = "second-project"
  for (const sessionID of [workerSessionId, collision]) {
    const permission = { sessionID, agent: checkerAgent, action: "shell", effect: "allow" }
    const retry = { sessionID, agent: checkerAgent, decision: { retry: true, delay: 1 } }
    await restarted.hooks.get("evaluate")!(permission)
    await restarted.hooks.get("retry")!(retry)
    expect(permission.effect).toBe("allow")
    expect(retry.decision).toEqual({ retry: true, delay: 1 })
  }
  liveWorker.projectID = originalProject
  expect((await restarted.call("read", { runId })).ok).toBe(false)

  f.state.checkerDenied = true
  expect(await restarted.call("read", { runId }, workerSessionId, checkerAgent))
    .toMatchObject({ ok: false, error: "CHECKER_POLICY_UNQUALIFIED" })
  f.state.checkerDenied = false
  f.state.effectiveDeny = true
  expect(await restarted.call("read", { runId }, workerSessionId, checkerAgent))
    .toMatchObject({ ok: false, error: "CHECKER_RESULT_PERMISSION_DENIED" })
  f.state.effectiveDeny = false
  const read = await restarted.call("read", { runId }, workerSessionId, checkerAgent)
  expect(read.page.rows).toEqual([{ synthetic_count: 1 }])
  expect(read.citation.manifest_digest).toBe(read.page.digest)
  for (const citation of [
    { ...read.citation, manifest_digest: "c".repeat(64) },
    { ...read.citation, read_receipt: "00000000-0000-4000-8000-000000000000" },
  ]) {
    expect(await restarted.call("result", { runId, result: "pass", citation }, workerSessionId, checkerAgent))
      .toMatchObject({ ok: false, error: "CHECKER_CITATION_UNVERIFIED" })
  }
  const verdict = { runId, result: "pass", citation: read.citation }
  expect(await restarted.call("result", verdict, workerSessionId, checkerAgent))
    .toMatchObject({ ok: true, worker: { result: "pass" } })
  expect(await restarted.call("revoke", { runId })).toMatchObject({ ok: true, revoked: true })
  expect((await restarted.call("result", verdict, workerSessionId, checkerAgent)).ok).toBe(false)
  expect(await restarted.call("status", { runId }))
    .toMatchObject({ ok: true, worker: { status: "result_authority_unverified" } })
  const directory = f.sessions.get(owner)!.location.directory
  await writeFile(join(directory, ".opencode", "runs", runId, "binding.json"), "{invalid")
  const unavailable = { sessionID: owner, agent: "build", system: [] as { type: "text"; text: string }[], messages: [] }
  await restarted.hooks.get("context")!(unavailable)
  expect(unavailable.system).toEqual([{ type: "text", text: "ALG V2 investigation status unavailable; reconcile." }])
})

test("an unconfirmed prompt stays blocked across plugin restart", async () => {
  const f = await fixture()
  const host = await ready(f)
  f.state.uncertainPrompt = true
  const launched = await host.call("start")
  expect(launched.worker.status).toBe("prompt_outcome_unknown")
  const { runId, workerSessionId } = launched.worker
  await host.detach()

  const restarted = await f.attach()
  expect(await restarted.call("start")).toMatchObject({ ok: true, worker: { runId, workerSessionId, status: "prompt_outcome_unknown" } })
  expect(await restarted.call("read", { runId }, workerSessionId, checkerAgent))
    .toMatchObject({ ok: false, error: "PROMPT_UNVERIFIED" })
  expect(f.counters).toEqual({ create: 1, prompt: 1 })
  expect(f.serviceCalls.filter(call => call === "read")).toEqual([])
})

test("procedure-only install checks the exact native winner and both digests", async () => {
  const f = await fixture()
  const options = await f.installProcedure()
  const host = await f.attach({ options: {
    approvedProcedure: options.approvedProcedure, approvedProcedureSha256: options.approvedProcedureSha256,
  } })
  expect(await host.call("procedure")).toMatchObject({ ok: true, procedure: { id: skillId, name: "Research Fixture", content: skillBody } })
  const current = f.catalog.skills[0]!
  for (const substitute of [
    { ...current, id: "shadow-id" },
    { ...current, path: join(f.directory, "shadow", "SKILL.md") },
    { ...current, content: skillBody + "!" },
  ]) {
    f.catalog.skills[0] = substitute
    expect(await host.call("procedure")).toMatchObject({ ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" })
  }
  f.catalog.skills[0] = current
  f.catalog.skills.push({ ...current, path: join(f.directory, "same-id", "SKILL.md") })
  expect(await host.call("procedure")).toMatchObject({ ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" })
  f.catalog.skills.pop()
  const wrongHash = await f.installProcedure(skillBody, "a".repeat(64))
  const approvedWrongHash = await f.attach({ options: { ...wrongHash, enabled: false } })
  expect(await approvedWrongHash.call("procedure")).toMatchObject({ ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" })
  await expect(f.attach({ options: { approvedProcedure: approvalPath } })).rejects.toThrow("V2_PREVIEW_OPTIONS_UNSUPPORTED")
})

test("a project cannot replace its approval and skill together", async () => {
  const f = await fixture()
  const options = await f.installProcedure()
  const host = await f.attach({ options: { ...options, enabled: false } })
  const original = await readFile(join(f.directory, approvalPath))
  const replacement = "Different instructions."
  await f.installProcedure(replacement)
  f.catalog.skills[0]!.content = replacement
  expect(await host.call("procedure")).toMatchObject({ ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" })

  await f.installProcedure()
  f.catalog.skills[0]!.content = skillBody
  f.state.afterReload = () => rm(join(f.directory, approvalPath))
  expect(await host.call("procedure")).toMatchObject({ ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" })
  await writeFile(join(f.directory, approvalPath), original)
  f.state.afterReload = undefined
  await writeFile(join(f.directory, sourcePath), "---\nname: Research Fixture\ndescription: metadata changed\n---\n" + skillBody)
  expect(await host.call("procedure")).toMatchObject({ ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" })
})

test("a failed refutation leaves the decision revision available for a new approval", async () => {
  const f = await fixture()
  const host = await ready(f, await f.installProcedure())
  const next = {
    expected_decision_revision: 0,
    next_action: "Measure the fixture count.",
    refutation: { id: "fixture", statement: "The fixture contains no rows.", manifest_digest: "f".repeat(64) },
  }
  expect(await host.call("set_next_measurement", next))
    .toMatchObject({ ok: false, error: "INVESTIGATION_OPERATION_REFUSED" })
  expect(await host.call("status")).toMatchObject({ ok: true, decision_revision: 0 })
  await host.detach()

  const replacement = "Count the rows and report the uncertainty."
  const options = await f.installProcedure(replacement)
  f.catalog.skills[0]!.content = replacement
  const reapproved = await f.attach({ options })
  const before = f.catalog.reloads
  expect(await reapproved.call("set_next_measurement", {
    ...next, refutation: { ...next.refutation, manifest_digest: "a".repeat(64) },
  })).toMatchObject({
    ok: true, decision_revision: 1,
    decision: { next_action: next.next_action, hypotheses: [{ id: "fixture", status: "refuted" }] },
  })
  expect(f.catalog.reloads - before).toBe(1)
  await reapproved.detach()

  const restarted = await f.attach({ options })
  const pin = JSON.parse(await readFile(join(f.directory, approvalPath), "utf8"))
  expect(await restarted.call("procedure")).toMatchObject({ ok: true, procedure: { ...pin, content: replacement } })
  const unconfigured = await f.attach()
  expect(await unconfigured.call("set_next_measurement", {
    expected_decision_revision: 1, next_action: "Replace the pinned decision without approval.",
  })).toMatchObject({ ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" })
  const changed = await f.attach({ options: await f.installProcedure() })
  f.catalog.skills[0]!.content = skillBody
  expect(await changed.call("procedure")).toMatchObject({ ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" })
  expect(await changed.call("status")).toMatchObject({ ok: true, procedure_authority: "unavailable",
    decision: { next_action: null, hypotheses: [{ id: "fixture", status: "refuted" }] } })
  await rm(join(f.directory, approvalPath))
  expect(await restarted.call("procedure")).toMatchObject({ ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" })
})

test("decision approval is rechecked after checker creation and before the grant", async () => {
  const f = await fixture()
  const host = await ready(f, await f.installProcedure())
  const next = { expected_decision_revision: 0, next_action: "Measure the fixture count." }
  const original = f.catalog.skills[0]!
  f.catalog.skills[0] = { ...original, path: join(f.directory, "shadow", "SKILL.md") }
  expect(await host.call("set_next_measurement", next)).toMatchObject({ ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" })
  f.catalog.skills[0] = original
  expect(await host.call("set_next_measurement", next)).toMatchObject({ ok: true, decision_revision: 1 })
  f.state.afterWorkerCreate = () => rm(join(f.directory, approvalPath))
  const launch = await host.call("start")
  expect(launch.worker.status).toBe("prompt_not_dispatched")
  expect(f.counters).toEqual({ create: 1, prompt: 0 })
  const { workerSessionId, runId } = launch.worker
  expect(await host.call("read", { runId }, workerSessionId, checkerAgent))
    .toMatchObject({ ok: false, error: "CHECKER_GRANT_REQUIRED" })
})

test("verified procedure survives compaction and restart while revocation fences fresh reads and verdicts", async () => {
  const f = await fixture()
  const options = await f.installProcedure()
  const host = await ready(f, options)
  const { runId, workerSessionId } = (await host.call("start")).worker
  const work = { runId }
  const page = await host.call("read", work, workerSessionId, checkerAgent)
  expect(page.ok).toBe(true)
  await host.detach()
  f.histories.set(workerSessionId, []) // Host context window no longer exposes the admitted prompt.
  const restarted = await f.attach({ options })
  const before = f.catalog.reloads
  for (const [sessionID, agent] of [[owner, "build"], [workerSessionId, checkerAgent]]) {
    const request = { sessionID, agent, system: [] as { text: string }[], messages: [] }
    await restarted.hooks.get("compaction")!(request)
    expect(request.system.map(part => part.text).join("\n")).toContain("Omit its text from the summary.")
    expect(request.system.map(part => part.text).join("\n")).not.toContain(skillBody)
    request.system = []
    await restarted.hooks.get("context")!(request)
    expect(request.system.map(part => part.text).join("\n")).toContain(skillBody)
    expect(request.system.map(part => part.text).join("\n")).not.toContain("UNSELECTED BODY")
  }
  expect(f.catalog.reloads).toBe(before)
  expect(await restarted.call("procedure", work, workerSessionId, checkerAgent)).toMatchObject({ ok: true, procedure: { id: skillId } })
  const verdict = { ...work, citation: page.citation, result: "pass" }
  expect(await restarted.call("result", verdict, workerSessionId, checkerAgent))
    .toMatchObject({ ok: true, worker: { status: "result_recorded" } })
  await rm(join(f.directory, approvalPath))
  const revoked = { sessionID: workerSessionId, agent: checkerAgent, system: [] as { text: string }[], messages: [] }
  await restarted.hooks.get("context")!(revoked)
  expect(revoked.system[0]?.text).toContain("unavailable")
  expect(revoked.system[0]?.text).not.toContain(skillBody)
  const reads = f.serviceCalls.filter(call => call === "read").length
  for (const [action, fields] of [
    ["procedure", work], ["read", work], ["result", verdict],
  ] as const) {
    expect(await restarted.call(action, fields, workerSessionId, checkerAgent))
      .toMatchObject({ ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" })
  }
  expect(await restarted.call("status", work)).toMatchObject({ ok: true, worker: { status: "result_authority_unverified" } })
  expect(f.serviceCalls.filter(call => call === "read")).toHaveLength(reads)
})

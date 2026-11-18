import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
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

async function fixture() {
  const directory = await mkdtemp(join(import.meta.dir, ".host-"))
  cleanup.push(() => rm(directory, { recursive: true, force: true }))
  const serviceCalls: string[] = []
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
            : { kind: "result", result: manifest, actual_cost: 1 }
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
  const state = { uncertainPrompt: false, checkerDenied: false, effectiveDeny: false }
  const histories = new Map<string, unknown[]>()

  async function attach(overrides: Record<string, unknown> = {}) {
    const hooks = new Map<string, Hook>()
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
      session: {
        hook,
        async get({ sessionID }: { sessionID: string }) {
          const session = sessions.get(sessionID)
          if (!session) throw new Error("unknown")
          return session
        },
        async create(input: Omit<Session, "projectID" | "time">) {
          counters.create++
          const session = { ...input, projectID: "fixture-project", time: {} }
          sessions.set(input.id, session)
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
        async transform(add: (editor: unknown) => void) {
          add({ get: () => undefined, add: (definition: { name: string; execute: Execute }) => {
            expect(definition.name).toBe(TOOL)
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
    return { call, detach, hooks }
  }

  return { sessions, attach, counters, serviceCalls, state }
}

async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  const host = await f.attach()
  expect((await host.call("create")).ok).toBe(true)
  expect((await host.call("admit")).work.status).toBe("reserved")
  expect((await host.call("dispatch")).work.status).toBe("result_recorded")
  return host
}

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
    const request = { sessionID: owner, agent: "build", system: [] as { text: string }[] }
    await restarted.hooks.get(name)!(request)
    expect(request.system[0]?.text).toContain(decision)
    expect(request.system[0]?.text).toContain(runId)
    const unrelated = { sessionID: workerSessionId, agent: checkerAgent, system: [] }
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
  const unavailable = { sessionID: owner, agent: "build", system: [] as { type: "text"; text: string }[] }
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

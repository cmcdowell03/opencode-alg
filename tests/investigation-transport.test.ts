import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { hashObject } from "../src/session-memory/store.ts"
import { InvestigationHttpPort } from "../src/investigation-transport.ts"
import { InvestigationStore } from "../src/investigation/index.ts"
import { tempProject, removeProject } from "./helpers.ts"

const inputSchema = { type: "object" as const, properties: {}, additionalProperties: true }
const names = ["submit", "lookup", "validate", "cancel"]
const schemaHash = hashObject({ inputSchema, outputSchema: null })
const live: Array<{ stop: () => void; close: () => Promise<void> }> = []
afterEach(async () => { for (const item of live.splice(0)) { item.stop(); await item.close() } })

async function localServer(options: { name?: string; wrongSchema?: boolean; mode?: "normal" | "redirect" | "oversize"; reply?: (name: string, args: Record<string, unknown>) => unknown } = {}) {
  const seen: Array<Record<string, unknown>> = []
  const servers: Server[] = []
  const handle = async (request: Request) => {
    const server = new Server({ name: options.name ?? "synthetic-mcp", version: "1.0" }, { capabilities: { tools: {} } })
    servers.push(server)
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: names.map((name) => ({
    name, inputSchema: options.wrongSchema && name === "submit"
      ? { type: "object" as const, properties: { changed: { type: "string" } } } : inputSchema,
    })) }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
    seen.push(request.params.arguments ?? {})
    const name = request.params.name
    const value = name === "submit" ? { kind: "running", external_job_id: "job-1" }
      : name === "lookup" ? { kind: "unknown", reason: "pending" }
      : name === "validate" ? { valid: true, validity_key: "a".repeat(64), access_scope: "reader" }
      : { cancelled: true }
    return { content: [{ type: "text", text: JSON.stringify(options.reply ? options.reply(name, request.params.arguments ?? {}) : value) }] }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(request)
  }
  const http = Bun.serve({ port: 0, fetch: (request) => {
    if (options.mode === "redirect") return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:9/other" } })
    if (options.mode === "oversize") return new Response("x".repeat(5000), { status: 200 })
    return handle(request)
  } })
  live.push({ stop: () => http.stop(true), close: async () => { await Promise.all(servers.map((server) => server.close())) } })
  return { endpoint: `http://127.0.0.1:${http.port}/mcp`, seen }
}
function profile(endpoint: string) {
  return { endpoint, serverId: "logical-lake", serverRevision: "deployment-v1",
    mcpServerName: "synthetic-mcp", mcpServerVersion: "1.0", principalId: "service-reader",
    profileEvidence: "operator synthetic server contract", readOnlyOperations: true as const,
    verifierId: "synthetic-verifier", evidenceSha256: "c".repeat(64),
    verifiedAt: new Date(Date.now() - 1000).toISOString(),
    scopeEnforcedByServer: true as const, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotentSubmit: true as const, lookupBySubmissionId: true as const, operations: ["bounded-read"],
    submit: { name: "submit", schemaHash }, lookup: { name: "lookup", schemaHash },
    validateResult: { name: "validate", schemaHash }, cancel: { name: "cancel", schemaHash },
    executionLimits: { maxDurationMs: 1000, maxBytesScanned: 4096, maxResultBytes: 1024, maxCost: 5 },
    timeoutMs: 2000, responseLimitBytes: 4096 }
}

describe("qualified MCP HTTP transport", () => {
  test("local admission failures release both job slots without submitting", async () => {
    const service = await localServer()
    const project = tempProject("alg-pre-submit-")
    try {
      const scope = { project_directory: project, project_id: "p", owner_id: "owner", run_id: "run" }
      const store = InvestigationStore.open(scope, { create: true, costLimit: 10 })
      const regular = new InvestigationHttpPort(profile(service.endpoint), "p")
      const expired = new InvestigationHttpPort({ ...profile(service.endpoint),
        verifiedAt: new Date(Date.now() - 2000).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString() }, "p")
      for (const [i, port] of [regular, expired].entries()) {
        const work = await store.admit({ operation: i ? "bounded-read" : "unlisted", recipe_version: "1",
          query: { i }, parameters: {}, reserved_cost: 5 }, port.capabilities)
        expect((await store.dispatch(work.work_key, port)).status).toBe("failed_known")
      }
      expect(service.seen).toHaveLength(0)
      expect(InvestigationStore.open(scope).status()).toMatchObject({ active_jobs: 0, reserved_cost: 0, cumulative_cost: 0 })
    } finally { removeProject(project) }
  })

  test("official SDK server sees host scope and fixed service limits outside model query", async () => {
    const service = await localServer()
    const port = new InvestigationHttpPort(profile(service.endpoint), "host-project")
    await port.qualify()
    expect(await port.submit({ submission_id: "s1", work_key: "w1", operation: "bounded-read",
      query: { project_id: "injected", execution_limits: { max_cost: 0 }, source: "synthetic" } })).toEqual({
      kind: "running", external_job_id: "job-1" })
    expect(service.seen[0]).toMatchObject({ project_id: "host-project", principal_id: "service-reader",
      execution_limits: { max_duration_ms: 1000, max_bytes_scanned: 4096, max_result_bytes: 1024, max_cost: 5 },
      query: { project_id: "injected" } })
    await expect(port.submit({ submission_id: "s2", work_key: "w2", operation: "arbitrary-sql", query: {} })).rejects.toThrow("operation_not_allowed")
    expect(service.seen).toHaveLength(1)
  })

  test("schema and MCP handshake identity drift fail closed", async () => {
    const wrongSchema = await localServer({ wrongSchema: true })
    await expect(new InvestigationHttpPort(profile(wrongSchema.endpoint), "p").qualify()).rejects.toThrow("unavailable")
    const wrongIdentity = await localServer({ name: "other-server" })
    await expect(new InvestigationHttpPort(profile(wrongIdentity.endpoint), "p").qualify()).rejects.toThrow("unavailable")
  })

  test("redirect and oversized HTTP replies do not escape the endpoint or byte bound", async () => {
    const redirect = await localServer({ mode: "redirect" })
    await expect(new InvestigationHttpPort(profile(redirect.endpoint), "p").qualify()).rejects.toThrow()
    const oversized = await localServer({ mode: "oversize" })
    await expect(new InvestigationHttpPort(profile(oversized.endpoint), "p").qualify()).rejects.toThrow()
  })

  test("profile refuses missing service enforcement and result bound over response bound", async () => {
    const endpoint = "http://127.0.0.1:1/mcp"
    expect(() => new InvestigationHttpPort({ ...profile(endpoint), scopeEnforcedByServer: false }, "p")).toThrow()
    expect(() => new InvestigationHttpPort({ ...profile(endpoint),
      executionLimits: { ...profile(endpoint).executionLimits, maxResultBytes: 5000 } }, "p")).toThrow()
  })
})


test("native MCP bindings translate jobs and host validity without requiring ALG-shaped service output", async () => {
  const service = await localServer({ reply: (name) => name === "submit"
    ? { state: "queued", job: "native-1" } : name === "lookup" ? { state: "absent" }
    : { allowed: true, scope: "reader" } })
  const ptr = (source: "request" | "host", pointer: string) => ({ kind: "pointer" as const, source, pointer })
  const constant = (value: unknown) => ({ kind: "constant" as const, value })
  const native = { ...profile(service.endpoint), submit: { name: "submit", schemaHash, binding: {
    input: { requestId: ptr("request", "/submission_id"), scope: ptr("host", "/project_id"), payload: ptr("request", "/query") },
    responses: { discriminator: "/state", cases: { queued: { kind: constant("running"), external_job_id: { kind: "pointer", pointer: "/job" } } } },
  } }, lookup: { name: "lookup", schemaHash, binding: { input: { requestId: ptr("request", "/submission_id") },
    responses: { discriminator: "/state", cases: { absent: { kind: constant("not_found"), proves_not_accepted: constant(true) } } } } },
    validateResult: { name: "validate", schemaHash, binding: { input: { object: ptr("request", "/manifest_ref") }, output: {
      valid: { kind: "pointer", pointer: "/allowed" }, access_scope: { kind: "pointer", pointer: "/scope" },
      validity_key: { kind: "pointer", source: "request", pointer: "/validity_key" },
    } } } }
  const port = new InvestigationHttpPort(native, "host-project")
  await expect(port.submit({ submission_id: "s1", work_key: "w1", operation: "bounded-read", query: { project_id: "not-authority" } }))
    .resolves.toEqual({ kind: "running", external_job_id: "native-1" })
  expect(service.seen[0]).toEqual({ requestId: "s1", scope: "host-project", payload: { project_id: "not-authority" } })
  await expect(port.lookup("s1")).resolves.toEqual({ kind: "not_found", proves_not_accepted: true })
  const root = tempProject("alg-native-binding-")
  try {
    const store = InvestigationStore.open({ project_directory: root, project_id: "p", owner_id: "o", run_id: "r" }, { create: true, costLimit: 5 })
    const work = await store.admit({ operation: "bounded-read", recipe_version: "1", parameters: {}, query: {}, reserved_cost: 1 }, port.capabilities)
    await expect(port.validateResult({ manifest_ref: "native/object", digest: "d".repeat(64), access_scope: "reader" } as any, work))
      .resolves.toEqual({ valid: true, validity_key: work.validity_key, access_scope: "reader" })
    expect(service.seen[2]).toEqual({ object: "native/object" })
  } finally { removeProject(root) }
  expect(port.capabilities.tool_schema_revision).not.toBe(schemaHash)
})

import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { hashObject } from "../src/session-memory/store.ts"
import { InvestigationHttpPort } from "../src/investigation-transport.ts"

const inputSchema = { type: "object" as const, properties: {}, additionalProperties: true }
const names = ["submit", "lookup", "validate", "cancel"]
const schemaHash = hashObject({ inputSchema, outputSchema: null })
const live: Array<{ stop: () => void; close: () => Promise<void> }> = []
afterEach(async () => { for (const item of live.splice(0)) { item.stop(); await item.close() } })

async function localServer(options: { name?: string; wrongSchema?: boolean; mode?: "normal" | "redirect" | "oversize" } = {}) {
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
    return { content: [{ type: "text", text: JSON.stringify(value) }] }
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
    await expect(port.submit({ submission_id: "s2", work_key: "w2", operation: "arbitrary-sql", query: {} })).rejects.toThrow("outside qualified")
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

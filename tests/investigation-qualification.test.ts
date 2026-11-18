import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { tempProject, removeProject } from "./helpers.ts"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { InvestigationResult, InvestigationWork } from "../src/investigation/index.ts"
import { hashObject } from "../src/session-memory/store.ts"
import { createQualificationFetch, runInventory, runProbe } from "../scripts/qualify-investigation.ts"

const inputSchema = { type: "object" as const, properties: {}, additionalProperties: true }
const names = ["submit", "lookup", "validate", "cancel"]
const schemaHash = hashObject({ inputSchema, outputSchema: null })
const cleanup: Array<() => Promise<void>> = []
function scratch() { const root = tempProject("alg-qualification-test-"); cleanup.push(async () => removeProject(root)); return root }
afterEach(async () => { for (const close of cleanup.splice(0)) await close() })
async function localServer(options: { pageCursor?: boolean } = {}) {
  const servers: Server[] = []
  const handle = async (request: Request) => {
    const server = new Server({ name: "qualification-fixture", version: "fixture-1" }, { capabilities: { tools: {} } })
    servers.push(server)
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: names.map((name) => ({ name, description: "PRIVATE DESCRIPTION MUST NOT BE SAVED", inputSchema })),
      ...(options.pageCursor ? { nextCursor: "next-page" } : {}),
    }))
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = request.params.arguments ?? {}
      const result = {
        manifest_ref: "synthetic://qualification/result-1", digest: "d".repeat(64),
        source_versions: ["synthetic-source-v1"], coverage: { rows: 1 },
        observed_at: new Date().toISOString(), access_scope: "synthetic-reader",
      }
      const value = request.params.name === "submit" ? { kind: "running", external_job_id: "fixture-job" }
        : request.params.name === "lookup" ? { kind: "result", result }
        : request.params.name === "validate" ? { valid: true, validity_key: "a".repeat(64), access_scope: "synthetic-reader" }
        : { cancelled: true }
      return { content: [{ type: "text", text: JSON.stringify(value) }] }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await server.connect(transport)
    return transport.handleRequest(request)
  }
  const close = async () => { await Promise.all(servers.map((server) => server.close())) }
  cleanup.push(close)
  return {
    endpoint: "http://127.0.0.1:9999/mcp",
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => handle(input instanceof Request ? input : new Request(input, init)),
  }
}

function profile(endpoint: string) {
  return {
    endpoint, tokenEnv: "QUALIFICATION_FIXTURE_TOKEN", serverId: "fixture-lake", serverRevision: "fixture-rev",
    principalId: "synthetic-reader", mcpServerName: "qualification-fixture", mcpServerVersion: "fixture-1",
    profileEvidence: "explicit synthetic fixture config", verifierId: "operator-test", evidenceSha256: "c".repeat(64),
    verifiedAt: new Date(Date.now() - 1000).toISOString(), readOnlyOperations: true as const,
    scopeEnforcedByServer: true as const, expiresAt: new Date(Date.now() + 60_000).toISOString(),
    idempotentSubmit: true as const, lookupBySubmissionId: true as const, operations: ["bounded-read"],
    submit: { name: "submit", schemaHash }, lookup: { name: "lookup", schemaHash },
    validateResult: { name: "validate", schemaHash }, cancel: { name: "cancel", schemaHash },
    executionLimits: { maxDurationMs: 1000, maxBytesScanned: 4096, maxResultBytes: 1024, maxCost: 1 },
    timeoutMs: 2000, responseLimitBytes: 4096,
  }
}

describe("operator MCP qualification inventory and probe", () => {
  test("bounded fetch pins the endpoint, rejects redirects, and caps response bytes", async () => {
    let redirectMode: RequestRedirect | undefined
    const bounded = createQualificationFetch("https://lake.example/mcp", { timeoutMs: 1000, responseLimitBytes: 1024 },
      async (_input, init) => { redirectMode = init?.redirect; return new Response("x".repeat(1025)) })
    expect(redirectMode).toBeUndefined()
    const response = await bounded("https://lake.example/mcp")
    expect(redirectMode).toBe("error")
    await expect(response.text()).rejects.toThrow("byte limit")
    await expect(bounded("https://other.example/mcp")).rejects.toThrow("endpoint changed")
  })

  test("inventory stores identities and schema hashes only, and labels pagination and guarantees honestly", async () => {
    const service = await localServer({ pageCursor: true })
    const receipt = await runInventory({ endpoint: service.endpoint, timeoutMs: 2000, responseLimitBytes: 4096,
      fetchImpl: service.fetchImpl })
    const serialized = JSON.stringify(receipt)
    expect(receipt.checks.find((check) => check.id === "inventory_exchange")?.detail).toBeUndefined()
    expect(receipt.mode).toBe("inventory")
    expect(receipt.qualification).toBe("not_established")
    expect(receipt.server).toEqual({ name: "qualification-fixture", version: "fixture-1" })
    expect(receipt.tools).toHaveLength(4)
    expect(receipt.tools.find((tool) => tool.name === "submit")).toEqual({ name: "submit", schema_sha256: schemaHash })
    expect(receipt.checks.find((check) => check.id === "tools_list_page")?.detail).toBe("bounded_first_page_only")
    expect(serialized).not.toContain("PRIVATE DESCRIPTION")
    expect(receipt.checks.filter((check) => ["server_enforcement", "submission_idempotency", "retention", "cancellation"].includes(check.id))
      .every((check) => check.status === "unverified")).toBe(true)
  })

  test("probe sends one synthetic submit, looks up that exact id, validates result, and does not claim enforcement", async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = []
    const result = {
      manifest_ref: "synthetic://qualification/result-1", digest: "d".repeat(64),
      source_versions: ["synthetic-source-v1"], coverage: { rows: 1 }, observed_at: new Date().toISOString(),
      access_scope: "synthetic-reader",
    }
    const port = {
      capabilities: { server_id: "fixture-lake", server_revision: "fixture-rev", tool_id: "submit", tool_schema_revision: schemaHash,
        principal_id: "synthetic-reader", project_id: "fixture-project", effects: ["read"], idempotent_submit: true as const,
        lookup_by_submission_id: true as const, response_limit_bytes: 4096, qualified: true as const },
      submit: async (args: { submission_id: string; query: Record<string, unknown> }) => {
        calls.push({ name: "submit", args })
        return { kind: "running" as const, external_job_id: "fixture-job" }
      },
      lookup: async (submissionId: string) => {
        calls.push({ name: "lookup", args: { submission_id: submissionId } })
        return { kind: "result" as const, result }
      },
      validateResult: async (_result: InvestigationResult, work: InvestigationWork) => {
        calls.push({ name: "validate", args: {} })
        return { valid: true, validity_key: work.validity_key, access_scope: "synthetic-reader" }
      },
    }
    const receipt = await runProbe({ profile: profile("http://127.0.0.1:9999/mcp"), projectId: "fixture-project", port, scratchDirectory: scratch() })
    const submitCalls = calls.filter((call) => call.name === "submit")
    const lookupCalls = calls.filter((call) => call.name === "lookup")
    expect(submitCalls).toHaveLength(1)
    expect(submitCalls[0]?.args).toMatchObject({ query: { qualification_probe: true, synthetic: true, rows: 1 } })
    expect(lookupCalls).toHaveLength(1)
    expect(lookupCalls[0]?.args.submission_id).toBe(submitCalls[0]?.args.submission_id)
    expect(calls.map((call) => call.name)).toEqual(["submit", "lookup", "validate"])
    expect(receipt.checks.find((check) => check.id === "lookup_by_same_submission_id")?.status).toBe("observed")
    expect(receipt.checks.find((check) => check.id === "result_access_validation")?.status).toBe("observed")
    expect(receipt.checks.find((check) => check.id === "duplicate_submit_idempotency")?.status).toBe("unverified")
    expect(receipt.checks.filter((check) => ["retention", "cancellation", "server_enforced_read_scope_and_execution_limits"].includes(check.id))
      .every((check) => check.status === "unverified")).toBe(true)
    expect(receipt.qualification).toBe("not_established")
    expect(JSON.stringify(receipt)).not.toContain("fixture-secret")
    expect(receipt.probe_state?.external_job_id).toBe("fixture-job")
    expect(receipt.probe_state?.submission_id).toBe(String(submitCalls[0]?.args.submission_id))
    expect(existsSync(receipt.probe_state!.directory)).toBe(true)
    expect(JSON.stringify(receipt)).not.toContain("synthetic://qualification/result-1")
  })

  test("an unavailable port yields failed observed work and never a ready profile", async () => {
    const failurePort = {
      capabilities: { server_id: "s", server_revision: "r", tool_id: "t", tool_schema_revision: "0".repeat(64),
        principal_id: "p", project_id: "p", effects: ["read"], idempotent_submit: true as const,
        lookup_by_submission_id: true as const, response_limit_bytes: 4096, qualified: true as const },
      submit: async () => { throw new Error("unavailable") },
      lookup: async () => { throw new Error("unavailable") },
    }
    const receipt = await runProbe({ profile: profile("http://127.0.0.1:1/mcp"), projectId: "fixture-project", port: failurePort, scratchDirectory: scratch() })
    expect(receipt.qualification).toBe("not_established")
    expect(receipt.server).toEqual({ name: null, version: null })
    expect(receipt.tools).toEqual([])
    expect(receipt.checks.find((check) => check.id === "single_synthetic_submission")).toMatchObject({ status: "failed", detail: "outcome_unknown" })
    expect(receipt.checks.find((check) => check.id === "lookup_by_same_submission_id")?.status).toBe("failed")
    expect(receipt.checks.filter((check) => ["duplicate_submit_idempotency", "server_enforced_read_scope_and_execution_limits", "retention", "cancellation"].includes(check.id))
      .every((check) => check.status === "unverified")).toBe(true)
  })
})

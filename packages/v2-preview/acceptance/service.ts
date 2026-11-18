import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { HardBenchmarkService, type QueryJob } from "../../../scripts/hard-benchmark-service.ts"
import { sha256Json } from "../../../src/persistence.ts"
import type { InvestigationAdapter } from "../../../src/operational-options.ts"

const sourceId = "inspection", revision = "fixture-r1", operation = "bounded-measurement"
const principal = "fixture-reader"
const names = ["submit", "lookup", "validate", "read"] as const
type Name = typeof names[number]
const inputSchema = { type: "object" as const, properties: {}, additionalProperties: true }
const limits = { maxDurationMs: 60_000, maxBytesScanned: 8192, maxResultBytes: 8192, maxCost: 24 }
const pageBound = 16
export const approvedJob = {
  operation, recipe_version: "1", query: { source: sourceId, revision }, parameters: {},
  source_dependencies: [`${sourceId}@${revision}`], reserved_cost: limits.maxCost,
}

export type ServiceOperation = {
  name: Name
  submission?: string
  project?: string
  job?: string
  maxRows?: number
  rows?: number
  accepted?: boolean
  response: "pending" | "withheld" | "sent" | "rejected"
}

/** Wrap the durable factory fixture in the real preview MCP wire contract. */
export function startFactory(directory: string, withholdAck = true) {
  const current = `measure-witness-${randomUUID()}`
  const beyondPage = `later-page-${randomUUID()}`
  const rows = Array.from({ length: 24 }, (_, i) =>
    ({ slot: i, recommendation: i === 0 ? current : i >= pageBound ? beyondPage : "replicate-inspection" }))
  const service = new HardBenchmarkService(directory, { sources: [{ sourceId, revision, rows }], maxAcceptedWorkUnits: 24 })
  const audit: ServiceOperation[] = []
  let projectId: string | undefined
  let first: ServiceOperation | undefined
  let releaseAck!: () => void
  const gate = new Promise<void>(resolve => { releaseAck = resolve })
  const manifest = (job: QueryJob) => ({
    manifest_ref: `synthetic:inspection:${job.jobId}`, digest: job.resultDigest, access_scope: principal,
    observed_at: new Date(job.acceptedAt).toISOString(), source_versions: approvedJob.source_dependencies,
    coverage: { rows: job.rowCount },
  })
  const requireScope = (args: Record<string, unknown>) => {
    if (args.project_id !== projectId || !projectId || args.principal_id !== principal ||
        args.operation !== operation || sha256Json(args.query) !== sha256Json(approvedJob.query) ||
        sha256Json(args.execution_limits) !== sha256Json({
          max_duration_ms: limits.maxDurationMs, max_bytes_scanned: limits.maxBytesScanned,
          max_result_bytes: limits.maxResultBytes, max_cost: limits.maxCost,
        })) throw new Error("Synthetic job scope mismatch")
  }
  async function run(name: Name, args: Record<string, unknown>, row: ServiceOperation): Promise<unknown> {
    if (name === "submit" || name === "lookup") {
      if (typeof args.submission_id !== "string" || !/^[a-f0-9-]{36}$/i.test(args.submission_id))
        throw new Error("Invalid submission identity")
      row.submission = args.submission_id
      if (name === "submit") {
        requireScope(args)
        row.project = projectId
      }
      const job = name === "submit" ? await service.submit({
        idempotencyKey: args.submission_id, sourceId, expectedRevision: revision,
      }) : await service.lookup(args.submission_id)
      if (!job) return { kind: "not_found", proves_not_accepted: true }
      row.job = job.jobId
      if (name === "submit" && !first) {
        row.accepted = true
        first = row
        if (withholdAck) {
          row.response = "withheld"
          await gate
          throw new Error("Acknowledgement deliberately withheld after admission")
        }
      }
      return { kind: "result", result: manifest(job), actual_cost: job.workUnits }
    }
    const jobId = typeof args.manifest_ref === "string" ? args.manifest_ref.split(":").at(-1) : undefined
    const job = jobId && await service.status(jobId)
    if (!job || args.manifest_ref !== manifest(job).manifest_ref || args.digest !== job.resultDigest)
      throw new Error("Synthetic manifest mismatch")
    row.job = job.jobId
    if (name === "validate") {
      if (typeof args.validity_key !== "string" || !/^[a-f0-9]{64}$/.test(args.validity_key))
        throw new Error("Invalid synthetic validity key")
      return { valid: true, validity_key: args.validity_key, access_scope: principal }
    }
    if (args.access_scope !== principal || args.cursor !== null ||
        typeof args.max_rows !== "number" || !Number.isInteger(args.max_rows) || args.max_rows < 1 || args.max_rows > pageBound)
      throw new Error("Synthetic evidence read exceeds first-page bound")
    row.maxRows = args.max_rows
    const page = await service.readPage(job.jobId, undefined, args.max_rows, "current")
    row.rows = page.rows.length
    return { manifest_ref: args.manifest_ref, digest: args.digest, access_scope: principal,
      cursor: null, next_cursor: page.nextCursor ?? null, rows: page.rows, coverage: { rows: job.rowCount } }
  }
  const http = Bun.serve({
    hostname: "127.0.0.1", port: 0, development: false, idleTimeout: 65, maxRequestBodySize: 64 * 1024,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/mcp") return new Response(null, { status: 404 })
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } })
      const server = new Server({ name: "fixture-factory", version: "1.0" }, { capabilities: { tools: {} } })
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: names.map(name => ({ name, inputSchema })) }))
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const name = names.find(item => item === params.name)
        if (!name || audit.length >= 64) throw new Error("Synthetic operation bound")
        const row: ServiceOperation = { name, response: "pending" }
        audit.push(row)
        try {
          const result = await run(name, params.arguments ?? {}, row)
          row.response = "sent"
          return { content: [{ type: "text", text: JSON.stringify(result) }] }
        } catch (error) {
          if (row.response !== "withheld") row.response = "rejected"
          return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "Fixture failure" }] }
        }
      })
      try {
        await server.connect(transport)
        return await transport.handleRequest(request)
      } finally { await server.close() }
    },
  })
  const tools = Object.fromEntries(names.map(name => [name, { name, schemaHash: sha256Json({ inputSchema, outputSchema: null }) }]))
  const adapter: InvestigationAdapter = {
    endpoint: `http://127.0.0.1:${http.port}/mcp`,
    serverId: "fixture-factory", serverRevision: revision, principalId: principal,
    mcpServerName: "fixture-factory", mcpServerVersion: "1.0",
    profileEvidence: "synthetic bounded inspection fixture", verifierId: "local-acceptance",
    evidenceSha256: sha256Json({ inputSchema, operations: names, limits }),
    verifiedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    readOnlyOperations: true, scopeEnforcedByServer: true, idempotentSubmit: true, lookupBySubmissionId: true,
    executionLimits: limits, operations: [operation], timeoutMs: 45_000, responseLimitBytes: 16_384,
    submit: tools.submit!, lookup: tools.lookup!, validateResult: tools.validate!, readResult: tools.read!,
  }
  return { adapter, audit, current, beyondPage, pageBound, bindProject: (id: string) => { projectId = id },
    acceptance: () => first?.response === "withheld" ? first : undefined,
    evidence: () => service.evidence(), releaseAck, stop: async () => { releaseAck(); await http.stop(true) } }
}

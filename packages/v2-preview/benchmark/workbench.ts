import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { caseId, evidenceRef, generateFabEvidence, type CaseVariant, type FabEvidence, type Source } from "./case.ts"

const maxPageRows = 24
const maxPages = 4
const sourceNames = ["inspection", "route", "dispatch", "clock-audit", "monitor"] as const
type Scope = "root" | "checker"
const canRead = (source: Source, scope: Scope) => scope === "checker" || (source !== "clock-audit" && source !== "monitor")
type PageRequest = { source: Source; offset: number; limit: number }
type Page = {
  source: Source; evidenceRef: string; offset: number; totalRows: number
  rows: FabEvidence[Source]; nextCursor: string | null
}
type Lookup = { status: "ok"; op: "lookup"; queryId: string; pages: Page[] }
type SourceInfo = { source: Source; evidenceRef: string; totalRows: number; fields: readonly string[] }
type Result = Lookup | {
  status: "ok"; op: "map"; caseId: string; sources: SourceInfo[]; maxPageRows: number; maxPages: number
} | { status: "unavailable"; reason: "source_unavailable" | "budget_exhausted" | "invalid_request" }

export type WorkbenchReceipt = {
  scope: Scope
  outcome: "mapped" | "admitted" | "replay" | "denied"
  queryId: string | null
  evidenceRefs: string[]
  pages: { source: Source; offset: number; rows: number; totalRows: number }[]
}

export type WorkbenchSnapshot = {
  caseId: string; maxAcceptedQueries: number; calls: number; acceptedQueries: number
  deniedQueries: number; receipts: WorkbenchReceipt[]
}

const fields = {
  inspection: ["lot", "wafer", "recordedMinute", "defect"],
  route: ["lot", "wafer", "step", "chamber", "completedMinute", "state"],
  dispatch: ["lot", "chamber", "dispatchedMinute"],
  "clock-audit": ["lot", "wafer", "recordedMinute", "correctedMinute", "status"],
  monitor: ["block", "chamber", "factor", "wafer", "arm", "recipe", "controls", "ringCount", "measuredOffsetMv", "randomized", "blinded"],
} as const

export const evidenceToolNames = ["map_sources", "lookup_pages"] as const
type EvidenceToolName = typeof evidenceToolNames[number]
const [mapSources, lookupPages] = evidenceToolNames

const workbenchTools = [{
  name: mapSources,
  description: "List available synthetic fab evidence sources, field names, row counts, citation refs and page bounds. Call with an empty object.",
  // Keep the empty properties and required lists explicit for the host's function schema.
  inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false },
}, {
  name: lookupPages,
  description: "Fetch bounded pages of read-only synthetic fab evidence. Use map_sources to discover available sources. Use a page's nextCursor to continue that source.",
  inputSchema: {
    type: "object" as const,
    required: ["pages"],
    additionalProperties: false,
    properties: {
      pages: { type: "array", minItems: 1, maxItems: maxPages,
        items: {
          type: "object", required: ["source"], additionalProperties: false,
          properties: {
            source: { type: "string", description: "Source ID from map_sources." },
            limit: { type: ["integer", "null"], minimum: 1, maximum: maxPageRows,
              description: "Maximum rows for this page. Omit or use null for the default." },
            cursor: { type: ["string", "null"], description: "Prior page's nextCursor. Omit or use null for the first page." },
          },
        },
      },
    },
  },
}]

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).every(key => keys.includes(key))
}

export function createWorkbench({ maxAcceptedQueries = 16, variant = "positive" }: { maxAcceptedQueries?: number; variant?: CaseVariant } = {}) {
  if (!Number.isSafeInteger(maxAcceptedQueries) || maxAcceptedQueries < 0) throw new Error("Invalid query admission limit")
  const evidence = generateFabEvidence(variant)
  const receipts: WorkbenchReceipt[] = []
  const accepted = new Map<string, Lookup>()
  const cursors = new Map<string, { scope: Scope; source: Source; offset: number }>()
  let deniedQueries = 0

  function call(name: EvidenceToolName, input: unknown, scope: Scope): Result {
    const append = (outcome: WorkbenchReceipt["outcome"], result?: Lookup) => {
      receipts.push({
        scope, outcome, queryId: result?.queryId ?? null,
        evidenceRefs: result?.pages.map(page => page.evidenceRef) ?? [],
        pages: result?.pages.map(page => ({
          source: page.source, offset: page.offset, rows: page.rows.length, totalRows: page.totalRows,
        })) ?? [],
      })
    }
    const deny = (reason: Extract<Result, { status: "unavailable" }>["reason"]): Result => {
      deniedQueries++
      append("denied")
      return { status: "unavailable", reason }
    }
    const args = record(input)
    if (name === mapSources && args && Object.keys(args).length === 0) {
      append("mapped")
      return { status: "ok", op: "map", caseId: caseId(variant), maxPageRows, maxPages,
        sources: sourceNames.filter(source => canRead(source, scope))
          .map(source => ({ source, evidenceRef: evidenceRef(source, variant), totalRows: evidence[source].length, fields: [...fields[source]] })),
      }
    }
    if (name !== lookupPages || !args || !onlyKeys(args, ["pages"]) || !Array.isArray(args.pages) ||
        args.pages.length < 1 || args.pages.length > maxPages) return deny("invalid_request")

    const requests: PageRequest[] = []
    for (const item of args.pages) {
      const page = record(item)
      if (!page || !onlyKeys(page, ["source", "cursor", "limit"]) || typeof page.source !== "string")
        return deny("invalid_request")
      const source = sourceNames.find(name => name === page.source)
      if (!source || !canRead(source, scope)) return deny("source_unavailable")
      // Provider payloads can materialize omitted optional fields as null.
      const limit = page.limit ?? maxPageRows
      if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > maxPageRows)
        return deny("invalid_request")
      let offset = 0
      if (page.cursor != null) {
        const cursor = typeof page.cursor === "string" ? cursors.get(page.cursor) : undefined
        if (!cursor || cursor.source !== source || cursor.scope !== scope) return deny("invalid_request")
        offset = cursor.offset
      }
      if (requests.some(request => request.source === source && request.offset === offset)) return deny("invalid_request")
      requests.push({ source, offset, limit })
    }
    const key = JSON.stringify([scope, [...requests].sort((a, b) => a.source.localeCompare(b.source) || a.offset - b.offset)])
    const replay = accepted.get(key)
    if (replay) {
      append("replay", replay)
      return structuredClone(replay)
    }
    if (accepted.size >= maxAcceptedQueries) return deny("budget_exhausted")

    const result: Lookup = {
      status: "ok", op: "lookup", queryId: `query-${accepted.size + 1}`,
      pages: requests.map(({ source, offset, limit }) => {
        const rows = evidence[source].slice(offset, offset + limit)
        const next = offset + rows.length
        const nextCursor = next < evidence[source].length ? randomUUID() : null
        if (nextCursor) cursors.set(nextCursor, { scope, source, offset: next })
        return { source, evidenceRef: evidenceRef(source, variant), offset, totalRows: evidence[source].length, rows, nextCursor }
      }),
    }
    accepted.set(key, result)
    append("admitted", result)
    return structuredClone(result)
  }

  return {
    call: (name: EvidenceToolName, input: unknown) => call(name, input, "root"),
    checkerCall: (name: EvidenceToolName, input: unknown) => call(name, input, "checker"),
    snapshot: (): WorkbenchSnapshot => ({
      caseId: caseId(variant), maxAcceptedQueries, calls: receipts.length, acceptedQueries: accepted.size,
      deniedQueries, receipts: structuredClone(receipts),
    }),
  }
}

export function startWorkbench(workbench: ReturnType<typeof createWorkbench>) {
  const endpoints = { root: `/mcp/${randomUUID()}`, checker: `/mcp/${randomUUID()}` }
  const http = Bun.serve({
    hostname: "127.0.0.1", port: 0, development: false, maxRequestBodySize: 16 * 1024,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (path !== endpoints.root && path !== endpoints.checker) return new Response(null, { status: 404 })
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } })
      const server = new Server({ name: "fixture-research", version: "1.0" }, { capabilities: { tools: {} } })
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: workbenchTools }))
      server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const name = evidenceToolNames.find(tool => tool === params.name)
        if (!name) throw new Error("Unknown research tool")
        const call = path === endpoints.checker ? workbench.checkerCall : workbench.call
        return { content: [{ type: "text", text: JSON.stringify(call(name, params.arguments ?? {})) }] }
      })
      try {
        await server.connect(transport)
        return await transport.handleRequest(request)
      } finally { await server.close() }
    },
  })
  const base = `http://127.0.0.1:${http.port}`
  return { endpoint: base + endpoints.root, checkerEndpoint: base + endpoints.checker, stop: () => http.stop(true) }
}

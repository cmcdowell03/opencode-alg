import { randomUUID } from "node:crypto"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { asObject } from "../acceptance/host.ts"
import { sha256 } from "../acceptance/runtime.ts"
import type { DiscoveryCase } from "./discovery-cases.ts"
import { discoveryNativeLimits as limits } from "./native-provider.ts"

export type Scope = "root" | "checker"
export type Source = { path: string; content: string }
export const scopeServer = { root: "sources", checker: "audit" } as const
export const scopedTools = (scope: Scope) => {
  const prefix = scopeServer[scope]
  return { list: prefix + "_discovery_list", read: prefix + "_discovery_read" }
}
const list = "discovery_list", read = "discovery_read"
const definitions = [
  { name: list, description: "List the available read-only investigation sources.",
    inputSchema: { type: "object" as const, properties: {}, required: [], additionalProperties: false } },
  { name: read, description: "Read the entire source at an exact path returned by the source list.",
    inputSchema: { type: "object" as const, properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false } },
]
export const sourceCallCap = 96
export const focusedSourceCallsPerRole = 48

export function startDiscoverySources(sources: readonly Source[], perRoleCap?: number) {
  if (!sources.length || sources.length > 32) throw new Error("Expected a bounded discovery source catalog")
  const contents = new Map(sources.map(({ path, content }) => {
    if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(path) ||
        path.split("/").some(part => part === "." || part === "..") ||
        Buffer.byteLength(content) > 16 * 1024) throw new Error("Invalid discovery source")
    return [path, content]
  }))
  if (contents.size !== sources.length) throw new Error("Duplicate discovery path")
  const paths = [...contents.keys()].sort()
  const endpoints = { root: "/" + randomUUID(), checker: "/" + randomUUID() }
  const receipts: { id: string; scope: Scope; path: string | null; outcome: "listed" | "read" | "denied"; sha256: string | null }[] = []
  let calls = 0
  const callsByScope = { root: 0, checker: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, development: false, maxRequestBodySize: 8192,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      const scope = pathname === endpoints.root ? "root" : pathname === endpoints.checker ? "checker" : null
      if (!scope || request.method !== "POST") return new Response(null, { status: 404 })
      const mcp = new Server({ name: "discovery-sources", version: "1.0" }, { capabilities: { tools: {} } })
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true })
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }))
      mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
        const args = params.arguments ?? {}
        const id = randomUUID()
        calls++
        callsByScope[scope]++
        if (calls > sourceCallCap || (perRoleCap !== undefined && callsByScope[scope] > perRoleCap))
          return { isError: true, content: [{ type: "text", text: "Source call cap reached" }] }
        if (params.name === list && Object.keys(args).length === 0) {
          receipts.push({ id, scope, path: null, outcome: "listed", sha256: null })
          return { content: [{ type: "text", text: JSON.stringify({ paths }) }] }
        }
        const path = typeof args.path === "string" ? args.path : ""
        const content = params.name === read && Object.keys(args).length === 1 ? contents.get(path) : undefined
        if (content === undefined) {
          receipts.push({ id, scope, path: null, outcome: "denied", sha256: null })
          return { isError: true, content: [{ type: "text", text: "Source path unavailable" }] }
        }
        receipts.push({ id, scope, path, outcome: "read", sha256: sha256(content) })
        return { content: [{ type: "text", text: JSON.stringify({ path, content, receipt: id }) }] }
      })
      try {
        await mcp.connect(transport)
        return await transport.handleRequest(request)
      } finally { await mcp.close() }
    },
  })
  return {
    endpoints: { root: server.url.origin + endpoints.root, checker: server.url.origin + endpoints.checker },
    receipts, calls: () => calls, callsByScope: () => ({ ...callsByScope }),
    catalog: paths.map(path => ({ path, sha256: sha256(contents.get(path)!) })),
    stop: () => server.stop(true),
  }
}

export const scriptedModel = { providerID: "paired-benchmark", id: "fixture" }

/** An apparatus exercise. The canned answer is deliberately independent of the case oracle. */
export function startDiscoveryScript(options: {
  firstPath: string; allowedTools: Record<Scope, readonly string[]>; incident?: DiscoveryCase
}) {
  const requests: { id: number; role: Scope; tools: string[]; requestBytes: number; status: number }[] = []
  const counts = { root: 0, checker: 0 }
  let failure: string | null = null
  const focused = options.incident
  const scriptedClaims = focused?.oracle.targets.map(target => ({
    finding: target.finding, scope: target.scope, evidence: target.requiredRefs.slice(),
  })) ?? []
  const scriptedMissingEvidence = focused?.oracle.missingEvidence ?? ["Additional corroborating evidence."]
  function focusedSteps(role: Scope, installed: boolean, incident: DiscoveryCase) {
    const { list, read } = scopedTools(role)
    const paths = [...new Set([incident.focus!.path, ...scriptedClaims.flatMap(row => row.evidence.map(ref => ref.split("#")[0]!))])]
    const unresolved = scriptedClaims.find(row => row.finding === "coverage")
    const decisionRefs = unresolved?.evidence ?? scriptedClaims[0]!.evidence
    const nextAction = unresolved ? "Does the signed tally at " + scriptedMissingEvidence[0] + " establish dispatch for " +
      unresolved.scope + "?" : "Send the reconciled consignment findings for independent review."
    return [
      { name: list, args: {} },
      ...(installed ? [{ name: "alg_investigation", args: { action: "create" } }] : []),
      ...paths.map(path => ({ name: read, args: { path } })),
      ...(installed ? [
        ...scriptedClaims.map((claim, index) => ({ name: "alg_investigation", args: { action: "record_finding",
          expected_decision_revision: 0, finding: { id: "finding-" + (index + 1), scope: claim.scope,
            interpretation: claim.finding, support: claim.evidence, counterevidence: [],
            ...(claim === unresolved && { missingEvidence: scriptedMissingEvidence[0] }) } } })),
        { name: "alg_investigation", args: { action: "set_next_measurement", expected_decision_revision: 0,
          next_action: nextAction, evidence_refs: decisionRefs,
          report_decision: { disposition: scriptedMissingEvidence.length ? "indeterminate" : "resolved",
            missingEvidence: scriptedMissingEvidence } } },
        { name: "alg_investigation", args: { action: "status" } },
        { name: "alg_investigation", args: { action: "render_report", expected_decision_revision: 1 } },
      ] : []),
    ]
  }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, development: false, maxRequestBodySize: limits.requestBytes,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path === "/v1/models")
        return Response.json({ object: "list", data: [{ id: scriptedModel.id, object: "model", owned_by: "fixture" }] })
      if (request.method !== "POST" || path !== "/v1/chat/completions") return new Response(null, { status: 404 })
      const bytes = await request.arrayBuffer()
      const body = asObject(JSON.parse(new TextDecoder().decode(bytes)))
      if (body?.model !== scriptedModel.id || !Array.isArray(body.tools)) return new Response(null, { status: 400 })
      if (requests.length >= limits.calls) {
        failure = "SCRIPTED_PROVIDER_CALL_BUDGET"
        return new Response(null, { status: 429 })
      }
      const tools = body.tools.flatMap(tool => {
        const name = asObject(asObject(tool)?.function)?.name
        return typeof name === "string" ? [name] : []
      })
      const role = tools.includes(scopedTools("checker").read) ? "checker" : "root"
      const own = scopedTools(role)
      const id = requests.length + 1
      if (tools.some(name => !options.allowedTools[role].includes(name)) ||
          !tools.includes(own.read) || !tools.includes(own.list)) {
        failure = "SCRIPTED_TOOL_SCOPE_UNEXPECTED"
        requests.push({ id, role, tools, requestBytes: bytes.byteLength, status: 400 })
        return new Response(null, { status: 400 })
      }
      requests.push({ id, role, tools, requestBytes: bytes.byteLength, status: 200 })
      const turn = counts[role]++
      const tool = focused ? focusedSteps(role, tools.includes("alg_investigation"), focused)[turn] :
        turn === 0 ? { name: own.list, args: {} } :
        turn === 1 ? { name: own.read, args: { path: options.firstPath } } :
        role === "root" && tools.includes("alg_investigation") ?
          turn === 2 ? { name: "alg_investigation", args: { action: "create" } } :
          turn === 3 ? { name: "alg_investigation", args: { action: "set_next_measurement",
            expected_decision_revision: 0, next_action: "Check the observed source against corroborating records before attributing the flags." } } :
          turn === 4 ? { name: "alg_investigation", args: { action: "status" } } : undefined
        : undefined
      const base = { id: "discovery-" + id, created: 1, model: scriptedModel.id, object: "chat.completion.chunk" }
      const delta = tool ? { tool_calls: [{ index: 0, id: base.id, type: "function",
        function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } :
        { content: JSON.stringify({ disposition: scriptedMissingEvidence.length ? "indeterminate" : "resolved",
          claims: scriptedClaims, missingEvidence: scriptedMissingEvidence }) }
      const chunk = (choices: unknown[], usage?: unknown) => "data: " + JSON.stringify({ ...base, choices, usage }) + "\n\n"
      return new Response(chunk([{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }]) +
        chunk([{ index: 0, delta: {}, finish_reason: tool ? "tool_calls" : "stop" }]) +
        chunk([], { prompt_tokens: 400, completion_tokens: 40, total_tokens: 440 }) + "data: [DONE]\n\n",
      { headers: { "content-type": "text/event-stream" } })
    },
  })
  return { url: server.url.origin + "/v1", requests, failure: () => failure, stop: () => server.stop(true) }
}

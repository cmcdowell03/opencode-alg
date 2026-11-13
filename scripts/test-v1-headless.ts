
export function completedReadOutputs(messages: any[]): any[] {
  return messages.flatMap((message) => (message.parts ?? []).filter((part: any) => part?.type === "tool" &&
    part.tool === "alg_investigation" && part.state?.status === "completed" && part.state?.input?.request?.action === "read_result")
    .map((part: any) => { try { return JSON.parse(part.state.output)?.page ?? {} } catch { return {} } }))
}

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash, createHmac, randomUUID } from "node:crypto"
import { constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, extname, isAbsolute, join, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { checkerProbeResponse, runCheckerHeadlessProbe } from "./checker-headless-probe.ts"
import { runTaskAdmissionHostProbe } from "./task-headless-probe.ts"
import { allowanceProbeResponse, startAllowanceHostProbe, finishAllowanceHostProbe } from "./allowance-headless-probe.ts"
import {
  ALG_TOOL_IDS,
  findSourceIdentityLine,
  parseAlgToolIds,
  realUserGlobalConfigRoots,
  snapshotGlobalOpenCodeConfig,
  verificationPluginConfiguration,
  validateOpenCodeVersion,
} from "./live-verify.ts"
import { MemoryStore } from "../src/session-memory/store.ts"
import { terminateProcessTree } from "../src/shell.ts"
import { ALG_LIVE_SOURCE_DIGEST_ENV } from "../src/source-identity.ts"
import { seedVerificationHostDependencies } from "./verification-host-dependencies.ts"
import { hashObject } from "../src/session-memory/store.ts"
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import { TaskContractInputSchema, TaskContractSchema, type TaskContractInput } from "../src/task-contract.ts"

const WAIT_MS = 60_000
const POLL_MS = 150
const PROCESS_WAIT_MS = 7_000
const BODY_LIMIT = 4 * 1024 * 1024
const INITIAL_MARKER = "ALG_HEADLESS_INITIAL_REQUEST_7F2A"
const FOLLOWUP_MARKER = "ALG_HEADLESS_FOLLOWUP_REQUEST_C941"
export const PERSISTED_REFERENCE = "synthetic://alg-headless/manifest/readings-v1"
export const PERSISTED_RESULT = sha256("ALG V1 deterministic local result fixture; no real source data")
const HEADLESS_PLAN_GOAL = "Run bounded synthetic data investigation acceptance"
const HEADLESS_ORIGINAL_CRITERIA = ["Use only deterministic local fixture data"]
export const HEADLESS_TASK_CONTRACT: TaskContractInput = {
  version: 1, kind: "read_only", discovery: "required", phase: "complete",
  deliverables: [{ destination: "response", producer_node: "confirm" }],
  verification: { checker_node: "check", execution: "none" }, preserve_paths: [],
  evidence_plan: [{ criterion: 1, observations: [{ kind: "deliverable", index: 0 }] }],
}
export const HEADLESS_INITIAL_PROMPT = `${INITIAL_MARKER} Check workspace readiness, plan the fixed data-investigation template using the bounded local fixture, then query it with alg_investigation. Declare the task_contract and original criteria from this request. Once accepted, the original criteria are immutable across planning, compaction and restart; do not replace them with later suggestions. Do not claim a result unless the query tool returns one.`

export const EvidenceSchema = z.object({
  task_allowance_probe: z.object({ passed: z.boolean(), run_id: z.string(), task_id: z.string().regex(/^[a-f0-9]{64}$/),
    reserved_before_compaction: z.number().int(), reserved_after_restarts: z.number().int(), reserved_after_checker: z.number().int(),
    additional_dispatches_after_exhaustion: z.number().int(), checker_parent_verified: z.boolean(), scope: z.string().max(512) }).strict().nullable().optional(),
  checker_probe: z.object({ passed: z.boolean(), run_id: z.string(), attempts: z.number().int(), distinct_children: z.number().int(), host_verified_parents: z.number().int(),
    verification_basis_recovered: z.boolean(),
    nodes: z.array(z.object({ id: z.string(), status: z.string(), outcome: z.string().nullable(), failures: z.array(z.string().max(2048)).max(3) })).max(3) }).nullable(),
  task_admission_probe: z.object({ passed: z.boolean(), run_id: z.string(), host_permissions_checked: z.boolean(), criteria_immutable: z.boolean(), incompatible_graph_rejected: z.boolean(), child_calls: z.number().int().nonnegative(), scope: z.string().max(512) }).strict().nullable().optional(),
  schema_version: z.literal(1), kind: z.literal("opencode-alg-v1-headless-acceptance"), generated_at: z.iso.datetime({ offset: true }),
  passed: z.boolean(), failure: z.string().max(2048).nullable(), evidence_path: z.string().min(1),
  task_contract: z.object({
    run_id: z.string().nullable(), input: TaskContractInputSchema.nullable(), original_goal: z.string().nullable(), original_criteria: z.array(z.string().max(2000)).max(100),
    requirements_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), contract_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    persisted_before_compaction: z.boolean(), persisted_after_compaction: z.boolean(), persisted_after_restart: z.boolean(), persisted_after_final_restart: z.boolean(), digests_stable: z.boolean(),
    user_request_captured: z.boolean().optional(), user_request_sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
  }).strict().optional(),
  source: z.object({ package_version: z.string(), root: z.string(), loaded_root: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), node: z.string(), bun: z.string().nullable() }).strict(),
  host: z.object({ executable: z.string(), version: z.string(), platform: z.string(), arch: z.string(), libc: z.string(), starts: z.number().int().min(0).max(3), restarts: z.number().int().min(0).max(2), pids: z.array(z.number().int().positive()).max(3), clean_exits: z.array(z.boolean()).max(3) }).strict(),
  isolation: z.object({ temporary_root: z.string(), project: z.string(), config_home: z.string(), config_path: z.string(), sidecar_path: z.string(), provider_endpoint: z.string(), server_bind_host: z.literal("127.0.0.1"), credentials_inherited: z.boolean(), real_user_config_unchanged: z.boolean(), config_before_sha256: z.string().regex(/^[a-f0-9]{64}$/), config_after_sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  session: z.object({ id: z.string().nullable(), persisted_same_id: z.boolean(), initial_tool_calls: z.array(z.string()).max(8), followup_tool_calls: z.array(z.string()).max(8), tool_registry_ids: z.array(z.string().max(128)).max(64), registry_exact: z.boolean(), plugin_startup_proofs: z.array(z.boolean()).max(3), initial_memory_checkpoint: z.object({ revision: z.number().int().nonnegative(), generation: z.number().int().nonnegative(), result_pins: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(16), result_persisted: z.boolean() }).nullable(), compacted_memory_checkpoint: z.object({ revision: z.number().int().nonnegative(), generation: z.number().int().nonnegative(), same_result_pin: z.boolean() }).nullable(), recovered_compaction_message: z.boolean(), recovered_reference_and_result: z.boolean(), final_memory_checkpoint: z.object({ revision: z.number().int().nonnegative(), generation: z.number().int().nonnegative(), result_persisted: z.boolean() }).nullable() }).strict(),
  synthetic_provider: z.object({ endpoint: z.string(), received_requests: z.number().int().nonnegative(), non_loopback_requests: z.number().int().nonnegative(), phases: z.array(z.string().max(32)).max(32), context_status_seen: z.boolean(), plan_tool_seen: z.boolean(), investigation_query_tool_seen: z.boolean(), query_result_observed_by_model: z.boolean(), compaction_saw_initial_result: z.boolean(), followup_saw_persisted_reference: z.boolean(), no_non_loopback_requests: z.boolean() }).strict(),
  investigation: z.object({ enabled: z.boolean(), mcp_server_name: z.string(), mcp_server_version: z.string(), profile_schema_hashes: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)), submit_calls: z.number().int().nonnegative(), accepted_remote_jobs: z.number().int().nonnegative(), validation_calls: z.number().int().nonnegative(), read_calls: z.number().int().nonnegative(), lookup_calls: z.number().int().nonnegative(), read_result_tool_calls: z.number().int().nonnegative(), query_tool_calls: z.number().int().nonnegative(), same_work_key: z.boolean(), same_result_reference: z.boolean(), result_revalidated_after_restarts: z.boolean(), actual_tool_results: z.array(z.object({ status: z.string(), work_key: z.string().nullable(), manifest_ref: z.string().nullable(), digest: z.string().nullable() }).strict()).max(4) }).strict(),
  cleanup: z.object({ host_processes_stopped: z.boolean(), provider_stopped: z.boolean(), mcp_service_stopped: z.boolean(), temporary_environment_removed: z.boolean(), evidence_persisted_before_environment_removal: z.boolean() }).strict(),
}).strict()
export type HeadlessAcceptanceEvidence = z.infer<typeof EvidenceSchema>

type HostRequestPhase = "initial" | "compaction" | "followup" | "background"
interface ProviderRequestReceipt { phase: HostRequestPhase; tool_names: string[]; called_tools: string[]; saw_initial_reference: boolean; saw_initial_result: boolean; saw_persisted_reference: boolean; saw_query_output: boolean }

function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex") }
function bounded(value: string, max = 2048): string { return value.length <= max ? value : value.slice(-max) }
function wait(ms: number): Promise<void> { return Bun.sleep(ms) }

function resolveHostExecutable(input = process.env.OPENCODE_BIN?.trim()): string {
  const candidates: string[] = []
  if (input) candidates.push(isAbsolute(input) ? input : resolve(input))
  else for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    candidates.push(join(directory, process.platform === "win32" ? "opencode.exe" : "opencode"))
    if (process.platform === "win32" && ["opencode.ps1", "opencode.cmd", "opencode.bat"].some((name) => existsSync(join(directory, name)))) {
      candidates.push(join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe"))
      candidates.push(join(directory, "..", "node_modules", "opencode-ai", "bin", "opencode.exe"))
    }
  }
  const executable = candidates.find((candidate) => existsSync(candidate) && ![".ps1", ".cmd", ".bat"].includes(extname(candidate).toLowerCase()))
  if (!executable) throw new Error("Could not find a directly executable OpenCode binary; set OPENCODE_BIN to an absolute path")
  return realpathSync.native(executable)
}

function requestText(body: any): string {
  return JSON.stringify(body?.messages ?? []).slice(-BODY_LIMIT)
}

function latestUserText(body: any): string {
  const message = [...(Array.isArray(body?.messages) ? body.messages : [])].reverse().find((item: any) => item?.role === "user")
  if (typeof message?.content === "string") return message.content
  if (Array.isArray(message?.content)) return message.content.map((part: any) => typeof part?.text === "string" ? part.text : "").join("\n")
  return ""
}

function toolOutputText(body: any): string {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  return messages.filter((message: any) => message?.role === "tool" || message?.role === "function")
    .map((message: any) => typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? ""))
    .join("\n").slice(-BODY_LIMIT)
}

function queryPayload() {
  return { operation: "bounded-read", recipe_version: "fixture-v1", parameters: { metric: "headless-count" },
    source_dependencies: ["synthetic://alg-headless/source/catalog-v1"], query: { select: "count", limit: 10 } }
}

export function chooseSyntheticResponse(phase: HostRequestPhase, toolStep: number, body: any): { kind: "tool" | "text"; name?: string; args?: Record<string, any>; text?: string; receipt: ProviderRequestReceipt } {
  const messagesText = requestText(body)
  const names = Array.isArray(body?.tools) ? body.tools.map((item: any) => String(item?.function?.name ?? item?.name ?? "")).filter(Boolean) : []
  const outputText = toolOutputText(body)
  const keyText = messagesText.replaceAll('\\"', '"')
  const workKey = keyText.match(/WORK_KEY:([a-f0-9]{64})/)?.[1] ?? keyText.match(/"work_key"\s*:\s*"([a-f0-9]{64})"/)?.[1]
  const keyMarker = workKey ? ` WORK_KEY:${workKey}` : ""
  const calledTools = Array.isArray(body?.messages) ? body.messages.flatMap((message: any) => (message?.tool_calls ?? []).map((call: any) => String(call?.function?.name ?? ""))).filter(Boolean) : []
  const receipt: ProviderRequestReceipt = {
    phase, tool_names: names.slice(0, 32), called_tools: calledTools.slice(0, 16),
    saw_initial_reference: messagesText.includes(PERSISTED_REFERENCE),
    saw_initial_result: messagesText.includes(PERSISTED_RESULT),
    saw_persisted_reference: messagesText.includes(PERSISTED_REFERENCE) && messagesText.includes(PERSISTED_RESULT),
    saw_query_output: outputText.includes(PERSISTED_REFERENCE) && outputText.includes(PERSISTED_RESULT),
  }
  const checkerResponse = checkerProbeResponse(latestUserText(body))
  if (checkerResponse !== undefined) return { kind: "text", text: checkerResponse, receipt }
  const allowanceResponse = allowanceProbeResponse(latestUserText(body))
  if (allowanceResponse !== undefined) return { kind: "text", text: allowanceResponse, receipt }
  if (phase === "initial" && toolStep === 0) return { kind: "tool", name: "alg_context_status", args: { operation: "headless-smoke" }, receipt }
  if (phase === "initial" && toolStep === 1) return { kind: "tool", name: "alg_plan", args: { goal: HEADLESS_PLAN_GOAL, template: "data-investigation", criteria: HEADLESS_ORIGINAL_CRITERIA, task_contract: HEADLESS_TASK_CONTRACT, detail: "compact" }, receipt }
  if (phase === "initial" && toolStep === 2) return { kind: "tool", name: "alg_investigation", args: { request: { action: "admit", input: queryPayload(), node_ids: [] } }, receipt }
  if (phase === "initial" && toolStep === 3) return { kind: "tool", name: "alg_investigation", args: { request: { action: "query", work_key: workKey ?? "0".repeat(64) } }, receipt }
  if (phase === "initial" && toolStep === 4 || phase === "followup" && toolStep === 1)
    return { kind: "tool", name: "alg_investigation", args: { request: { action: "read_result", work_key: workKey ?? "0".repeat(64), max_rows: 5 } }, receipt }
  if (phase === "initial") return { kind: "text", text: receipt.saw_query_output ? `Initial host query completed. ${PERSISTED_REFERENCE} ${PERSISTED_RESULT}${keyMarker}` : "INITIAL_HOST_QUERY_RESULT_NOT_OBSERVED", receipt }
  if (phase === "compaction") {
    const ok = receipt.saw_initial_reference && receipt.saw_initial_result
    return { kind: "text", text: ok ? `Preserved ${PERSISTED_REFERENCE} and ${PERSISTED_RESULT}${keyMarker}` : "COMPACTION_INPUT_MISSING_INITIAL_EVIDENCE", receipt }
  }
  if (phase === "followup" && toolStep === 0) return { kind: "tool", name: "alg_investigation", args: { request: { action: "query", work_key: workKey ?? "0".repeat(64) } }, receipt }
  if (phase === "followup") {
    return { kind: "text", text: receipt.saw_persisted_reference && receipt.saw_query_output ? `Recovered ${PERSISTED_REFERENCE} ${PERSISTED_RESULT}` : "FOLLOWUP_QUERY_OR_CONTEXT_MISSING_PERSISTED_EVIDENCE", receipt }
  }
  return { kind: "text", text: "Synthetic local title", receipt }
}

function readBody(request: IncomingMessage): Promise<any> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = []; let bytes = 0
    request.on("data", (chunk: Buffer) => { bytes += chunk.byteLength; if (bytes > BODY_LIMIT) { reject(new Error("provider request exceeded 4 MiB")); request.destroy(); return } chunks.push(Buffer.from(chunk)) })
    request.on("end", () => { try { resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8"))) } catch { reject(new Error("provider request was not valid JSON")) } })
    request.on("error", reject)
  })
}

function writeChatResponse(response: ServerResponse, body: any, choice: ReturnType<typeof chooseSyntheticResponse>, index: number): void {
  const model = String(body?.model ?? "synthetic")
  const id = `alg-headless-${index}`
  const created = Math.floor(Date.now() / 1000)
  const choiceMessage = choice.kind === "tool"
    ? { role: "assistant", content: null, tool_calls: [{ id: `call-${index}-${choice.name}`, type: "function", function: { name: choice.name, arguments: JSON.stringify(choice.args ?? {}) } }] }
    : { role: "assistant", content: choice.text }
  const finishReason = choice.kind === "tool" ? "tool_calls" : "stop"
  if (body?.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "close" })
    const delta = choice.kind === "tool"
      ? { role: "assistant", tool_calls: [{ index: 0, id: `call-${index}-${choice.name}`, type: "function", function: { name: choice.name, arguments: JSON.stringify(choice.args ?? {}) } }] }
      : { role: "assistant", content: choice.text }
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })}\n\n`)
    response.end("data: [DONE]\n\n")
    return
  }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({ id, object: "chat.completion", created, model, choices: [{ index: 0, message: choiceMessage, finish_reason: finishReason }], usage: { prompt_tokens: 128, completion_tokens: 16, total_tokens: 144 } }))
}

const MCP_SCHEMAS = {
  submit: { type: "object", properties: { submission_id: { type: "string" }, work_key: { type: "string" }, operation: { type: "string" }, query: { type: "object" }, project_id: { type: "string" }, principal_id: { type: "string" }, execution_limits: { type: "object", properties: { max_duration_ms: { type: "integer" }, max_bytes_scanned: { type: "integer" }, max_result_bytes: { type: "integer" }, max_cost: { type: "number" } }, required: ["max_duration_ms", "max_bytes_scanned", "max_result_bytes", "max_cost"], additionalProperties: false } }, required: ["submission_id", "work_key", "operation", "query", "project_id", "principal_id", "execution_limits"], additionalProperties: false },
  lookup: { type: "object", properties: { submission_id: { type: "string" } }, required: ["submission_id"], additionalProperties: false },
  validate: { type: "object", properties: { manifest_ref: { type: "string" }, digest: { type: "string" }, work_key: { type: "string" }, validity_key: { type: "string" }, source_dependencies: { type: "array", items: { type: "string" } } }, required: ["manifest_ref", "digest", "work_key", "validity_key", "source_dependencies"], additionalProperties: false },
  read: { type: "object", properties: { manifest_ref: { type: "string" }, digest: { type: "string" }, access_scope: { type: "string" }, cursor: { type: ["string", "null"] }, max_rows: { type: "integer" } }, required: ["manifest_ref", "digest", "access_scope", "cursor", "max_rows"], additionalProperties: false },
  cancel: { type: "object", properties: { external_job_id: { type: "string" } }, required: ["external_job_id"], additionalProperties: false },
} as const
const MCP_NAMES = { submit: "submit", lookup: "lookup", validate: "validate_result", cancel: "cancel", read: "read_result" } as const

interface SyntheticJob { submission_id: string; work_key: string; result: Record<string, unknown> }
interface SyntheticMcpService {
  endpoint: string
  serverName: string
  serverVersion: string
  profile: Record<string, unknown>
  schemas: Record<string, string>
  submitted: SyntheticJob[]
  bindProject(projectId: string): void
  counters: { submitCalls: number; acceptedRemoteJobs: number; validationCalls: number; lookupCalls: number; readCalls: number; nonLoopbackRequests: number }
  close(): Promise<void>
}

function createSyntheticMcpService(): SyntheticMcpService {
  const serverName = "alg-headless-synthetic"
  const serverVersion = "1.32.2-fixture.1"
  const schemas = Object.fromEntries(Object.entries(MCP_SCHEMAS).map(([key, inputSchema]) => [key, hashObject({ inputSchema, outputSchema: null })]))
  const counters = { submitCalls: 0, acceptedRemoteJobs: 0, validationCalls: 0, lookupCalls: 0, readCalls: 0, nonLoopbackRequests: 0 }
  const submitted: SyntheticJob[] = []
  let expectedProjectId = ""
  const servers = new Set<McpServer>()
  const handle = async (request: Request): Promise<Response> => {
    const ip = httpServer.requestIP(request)?.address
    if (ip !== "127.0.0.1" && ip !== "::1" && ip !== "::ffff:127.0.0.1") {
      counters.nonLoopbackRequests++
      return new Response("loopback only", { status: 403 })
    }
    const mcp = new McpServer({ name: serverName, version: serverVersion }, { capabilities: { tools: {} } })
    servers.add(mcp)
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: Object.entries(MCP_NAMES).map(([key, name]) => ({ name, inputSchema: MCP_SCHEMAS[key as keyof typeof MCP_SCHEMAS] })) }))
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, any>
      const name = request.params.name
      let value: unknown
      if (name === MCP_NAMES.submit) {
        counters.submitCalls++
        const existing = submitted.find((item) => item.submission_id === args.submission_id)
        if (existing && existing.work_key !== args.work_key) throw new Error("submission ID rebound to a different work key")
        if (!expectedProjectId || args.project_id !== expectedProjectId || args.principal_id !== "synthetic-reader" || args.operation !== "bounded-read" ||
          JSON.stringify(args.execution_limits) !== JSON.stringify({ max_duration_ms: 5000, max_bytes_scanned: 65536, max_result_bytes: 4096, max_cost: 2 })) {
          throw new Error("synthetic service rejected out-of-profile scope or limits")
        }
        if (!existing) {
          counters.acceptedRemoteJobs++
          submitted.push({ submission_id: String(args.submission_id), work_key: String(args.work_key), result: {
            manifest_ref: PERSISTED_REFERENCE, digest: PERSISTED_RESULT,
            source_versions: ["synthetic-catalog-v1"], coverage: { rows: 7, bounded: true },
            observed_at: new Date().toISOString(), expires_at: new Date(Date.now() + 25 * 60_000).toISOString(), access_scope: "synthetic-reader",
          } })
        }
        value = { kind: "running", external_job_id: "synthetic-job-1" }
      } else if (name === MCP_NAMES.lookup) {
        counters.lookupCalls++
        const job = submitted.find((item) => item.submission_id === args.submission_id)
        value = job ? counters.lookupCalls === 1 ? { kind: "running", external_job_id: "synthetic-job-1" } : { kind: "result", result: job.result, actual_cost: 0.25 } : { kind: "not_found", proves_not_accepted: true }
      } else if (name === MCP_NAMES.validate) {
        counters.validationCalls++
        const job = submitted.find((item) => item.work_key === args.work_key)
        const valid = Boolean(job && args.manifest_ref === PERSISTED_REFERENCE && args.digest === PERSISTED_RESULT && args.validity_key)
        value = { valid, validity_key: String(args.validity_key ?? ""), access_scope: valid ? "synthetic-reader" : "revoked" }
      } else if (name === MCP_NAMES.read) {
        if (args.manifest_ref !== PERSISTED_REFERENCE || args.digest !== PERSISTED_RESULT || args.access_scope !== "synthetic-reader" ||
          args.cursor !== null || args.max_rows < 1 || args.max_rows > 5) throw new Error("invalid bounded page request")
        counters.readCalls++
        value = { manifest_ref: PERSISTED_REFERENCE, digest: PERSISTED_RESULT, access_scope: "synthetic-reader",
          cursor: null, next_cursor: null, rows: [{ evidence: "synthetic-observation", particles: 7 }], coverage: { synthetic: true, complete: true } }
      } else if (name === MCP_NAMES.cancel) value = { cancelled: true }
      else return { content: [{ type: "text", text: "unknown synthetic tool" }], isError: true }
      return { content: [{ type: "text", text: JSON.stringify(value) }] }
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
    await mcp.connect(transport)
    return transport.handleRequest(request)
  }
  const httpServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle })
  const now = Date.now()
  const profile = {
    endpoint: `http://127.0.0.1:${httpServer.port}/mcp`, serverId: "alg-headless-synthetic", serverRevision: "fixture-rev-1",
    principalId: "synthetic-reader", mcpServerName: serverName, mcpServerVersion: serverVersion,
    profileEvidence: "Deterministic loopback-only MCP fixture; evidence applies to this test service only.",
    verifierId: "alg-headless-fixture-verifier", evidenceSha256: hashObject({ serverName, serverVersion, schemas, policy: "loopback-bounded-read-v1" }),
    verifiedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 25 * 60_000).toISOString(),
    readOnlyOperations: true, scopeEnforcedByServer: true, operations: ["bounded-read"],
    executionLimits: { maxDurationMs: 5000, maxBytesScanned: 65536, maxResultBytes: 4096, maxCost: 2 },
    idempotentSubmit: true, lookupBySubmissionId: true,
    submit: { name: MCP_NAMES.submit, schemaHash: schemas.submit }, lookup: { name: MCP_NAMES.lookup, schemaHash: schemas.lookup },
    readResult: { name: MCP_NAMES.read, schemaHash: schemas.read },
    validateResult: { name: MCP_NAMES.validate, schemaHash: schemas.validate }, cancel: { name: MCP_NAMES.cancel, schemaHash: schemas.cancel },
    timeoutMs: 5000, responseLimitBytes: 8192,
  }
  return { endpoint: profile.endpoint, serverName, serverVersion, profile, schemas, submitted, counters, bindProject(projectId) { expectedProjectId = projectId },
    async close() { httpServer.stop(true); await Promise.all([...servers].map((server) => server.close().catch(() => {}))) } }
}

export function createSyntheticProvider(): { server: Server; readonly endpoint: string; requests: ProviderRequestReceipt[]; nonLoopbackRequests: number; setPhase(phase: HostRequestPhase): void; close(): Promise<void> } {
  const requests: ProviderRequestReceipt[] = []
  let nonLoopbackRequests = 0
  let phase: HostRequestPhase = "background"
  let initialStep = 0, followupStep = 0
  const server = createServer(async (request, response) => {
    const remote = request.socket.remoteAddress
    if (remote !== "127.0.0.1" && remote !== "::1" && remote !== "::ffff:127.0.0.1") { nonLoopbackRequests++; response.writeHead(403).end(); return }
    if (request.method === "GET" && /\/models$/.test(request.url ?? "")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "deterministic", object: "model" }] })); return
    }
    if (request.method !== "POST" || !/\/chat\/completions$/.test(request.url ?? "")) { response.writeHead(404).end(); return }
    try {
      const body = await readBody(request)
      const latest = latestUserText(body)
      let selected: HostRequestPhase = phase
      if (latest.includes(FOLLOWUP_MARKER)) { selected = "followup"; phase = "followup" }
      else if (latest.includes(INITIAL_MARKER) && phase !== "compaction") { selected = "initial"; phase = "initial" }
      const step = selected === "initial" ? initialStep : selected === "followup" ? followupStep : 0
      const choice = chooseSyntheticResponse(selected, step, body)
      requests.push(choice.receipt)
      if (choice.kind === "tool" && selected === "initial") initialStep++
      if (choice.kind === "tool" && selected === "followup") followupStep++
      writeChatResponse(response, body, choice, requests.length)
    } catch (error) {
      response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: bounded(error instanceof Error ? error.message : String(error)) } }))
    }
  })
  return {
    server,
    get endpoint() { const address = server.address(); return address && typeof address !== "string" ? `http://127.0.0.1:${address.port}/v1` : "" },
    requests,
    get nonLoopbackRequests() { return nonLoopbackRequests },
    setPhase(value) { phase = value; if (value === "initial") initialStep = 0; if (value === "followup") followupStep = 0 },
    close: () => new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose())),
  }
}

interface TrackedProcess { child: ChildProcess; stdout: string; stderr: string; exited: boolean; code: number | null; signal: NodeJS.Signals | null }
function launchProcess(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): TrackedProcess {
  const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] })
  const tracked: TrackedProcess = { child, stdout: "", stderr: "", exited: child.exitCode !== null, code: child.exitCode, signal: child.signalCode }
  child.stdout?.on("data", (chunk: Buffer) => { tracked.stdout = bounded(`${tracked.stdout}${chunk.toString("utf8")}`, 64 * 1024) })
  child.stderr?.on("data", (chunk: Buffer) => { tracked.stderr = bounded(`${tracked.stderr}${chunk.toString("utf8")}`, 64 * 1024) })
  child.once("close", (code, signal) => { tracked.exited = true; tracked.code = code; tracked.signal = signal })
  child.once("error", () => { tracked.exited = true })
  return tracked
}

async function waitExit(processInfo: TrackedProcess, timeout = PROCESS_WAIT_MS): Promise<boolean> {
  const end = Date.now() + timeout
  while (!processInfo.exited && processInfo.child.exitCode === null && Date.now() < end) await wait(50)
  return processInfo.exited || processInfo.child.exitCode !== null
}

async function stopProcess(processInfo: TrackedProcess): Promise<boolean> {
  if (await waitExit(processInfo, 1)) return true
  if (process.platform === "win32") {
    try { processInfo.child.kill("SIGTERM") } catch { /* preserve result */ }
    if (await waitExit(processInfo, 2_000)) return true
    try { processInfo.child.kill("SIGKILL") } catch { /* preserve result */ }
  } else {
    try { await terminateProcessTree(processInfo.child as ReturnType<typeof spawn>, { terminationGraceMs: 1_500 }) }
    catch { try { process.kill(-processInfo.child.pid!, "SIGKILL") } catch { /* preserve result */ } }
  }
  return waitExit(processInfo)
}

async function getFreePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolveListen()) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()))
  return port
}

async function jsonRequest<T>(url: string, method = "GET", body?: unknown, timeout = 20_000): Promise<{ status: number; value: T; raw: string }> {
  const response = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeout) })
  const raw = await response.text()
  if (Buffer.byteLength(raw) > BODY_LIMIT) throw new Error(`Host API response exceeds ${BODY_LIMIT} bytes`)
  let value: unknown
  try { value = raw ? JSON.parse(raw) : null } catch { throw new Error(`OpenCode API returned non-JSON HTTP ${response.status}: ${bounded(raw)}`) }
  if (!response.ok) throw new Error(`OpenCode API HTTP ${response.status}: ${bounded(raw)}`)
  return { status: response.status, value: value as T, raw }
}

function findLoadedPluginLine(output: string, plugin: ReturnType<typeof verificationPluginConfiguration>): string | undefined {
  const expected = `alg plugin loaded skill_evolution=disabled tools=${ALG_TOOL_IDS.length} ids=${ALG_TOOL_IDS.join(",")}`
  return output.split(/\r?\n/).find((line) => line.length <= 16_384 && line.includes(expected) &&
    line.includes(`deployment_build=opencode-alg@${plugin.package_version}`) &&
    line.includes(`source_manifest_at_module_load=${plugin.source.digest}`) &&
    line.includes("configuration_source=override configuration_sidecar_present=true"))
}

async function waitToolRegistry(base: string, processInfo: TrackedProcess, project: string, plugin: ReturnType<typeof verificationPluginConfiguration>): Promise<string[]> {
  const url = `${base}/experimental/tool/ids?directory=${encodeURIComponent(project)}`
  const end = Date.now() + WAIT_MS
  let last = "not yet available"
  while (Date.now() < end) {
    if (await waitExit(processInfo, 1)) throw new Error(`OpenCode exited before tool registry readiness: ${bounded(processInfo.stderr)}`)
    try {
      const result = await jsonRequest<unknown>(url, "GET", undefined, 2_000)
      const ids = parseAlgToolIds(JSON.stringify(result.value))
      const combined = `${processInfo.stdout}\n${processInfo.stderr}`
      const sourceIdentity = findSourceIdentityLine(combined, "server", plugin.source)
      const loadedPlugin = findLoadedPluginLine(combined, plugin)
      if (result.status === 200 && ids.length === ALG_TOOL_IDS.length && ALG_TOOL_IDS.every((id) => ids.includes(id)) && sourceIdentity && loadedPlugin) return ids
      last = `HTTP ${result.status}; ids=${ids.join(",")}`
    } catch (error) { last = error instanceof Error ? bounded(error.message) : String(error) }
    await wait(POLL_MS)
  }
  throw new Error(`OpenCode ALG tool registry did not become ready; stderr=${bounded(processInfo.stderr)}; readiness_cause=${last}`)
}

function toolNames(message: any): string[] {
  const entries = Array.isArray(message?.parts) ? message.parts : []
  return entries.filter((part: any) => part?.type === "tool").map((part: any) => String(part.tool ?? "")).filter(Boolean)
}

function transcriptToolNames(messages: any[]): string[] { return messages.flatMap((message) => toolNames(message)).slice(0, 64) }

export function completedInvestigationOutputs(value: any): Array<{ status: string; work_key: string | null; manifest_ref: string | null; digest: string | null }> {
  const messages = Array.isArray(value) ? value : [value]
  const outputs: Array<{ status: string; work_key: string | null; manifest_ref: string | null; digest: string | null }> = []
  for (const message of messages) for (const part of Array.isArray(message?.parts) ? message.parts : []) {
    if (part?.type !== "tool" || part.tool !== "alg_investigation" || part.state?.status !== "completed" || typeof part.state?.output !== "string" || part.state?.input?.request?.action !== "query") continue
    try {
      let value: any = JSON.parse(part.state.output)
      if (typeof value?.output === "string") { try { value = JSON.parse(value.output) } catch { /* output itself is the bounded returned text */ } }
      outputs.push({ status: String(value?.status ?? ""), work_key: typeof value?.work_key === "string" ? value.work_key : null,
        manifest_ref: typeof value?.result?.manifest_ref === "string" ? value.result.manifest_ref : null,
        digest: typeof value?.result?.digest === "string" ? value.result.digest : null })
    } catch { outputs.push({ status: "unparseable", work_key: null, manifest_ref: null, digest: null }) }
  }
  return outputs.slice(0, 4)
}

function hasCompactionWithEvidence(messages: any[]): boolean {
  const assistantMessages = messages.filter((message) => message?.info?.role === "assistant")
  const hasCompactionBoundary = messages.some((message) => message?.info?.summary === true ||
    (message.parts ?? []).some((part: any) => part?.type === "compaction"))
  const transcript = JSON.stringify(messages)
  return hasCompactionBoundary && transcript.includes(PERSISTED_REFERENCE) && transcript.includes(PERSISTED_RESULT)
}

function resultCheckpoint(project: string, sessionId: string): { revision: number; generation: number; result_pins: string[]; result_persisted: boolean } {
  const store = new MemoryStore(project)
  const checkpoint = store.checkpoint(sessionId)
  const pins = checkpoint?.pins ?? []
  const results = pins.filter((id) => {
    try { return store.node(id, sessionId).kind === "result" } catch { return false }
  })
  const resultPersisted = results.some((id) => {
    try {
      const node = store.node(id, sessionId)
      return node.kind === "result" && store.readArtifact(node.payload.artifact).includes(PERSISTED_REFERENCE) && store.readArtifact(node.payload.artifact).includes(PERSISTED_RESULT)
    } catch { return false }
  })
  return { revision: checkpoint?.revision ?? 0, generation: checkpoint?.generation ?? 0, result_pins: results.slice(-16), result_persisted: resultPersisted }
}

interface PersistedTaskContractSnapshot {
  userRequestMatches: boolean
  userRequestSha256: string | null
  runId: string
  goal: string
  criteria: string[]
  input: TaskContractInput | null
  requirementsSha256: string | null
  contractSha256: string | null
  valid: boolean
}

function readPersistedTaskContract(project: string): PersistedTaskContractSnapshot | null {
  const runsDirectory = join(project, ".opencode", "runs")
  if (!existsSync(runsDirectory)) return null
  for (const runId of readdirSync(runsDirectory).slice(0, 128)) {
    const progressPath = join(runsDirectory, runId, "progress.json")
    if (!existsSync(progressPath)) continue
    try {
      const state = JSON.parse(readFileSync(progressPath, "utf8"))
      if (state?.goal !== HEADLESS_PLAN_GOAL || JSON.stringify(state?.criteria) !== JSON.stringify(HEADLESS_ORIGINAL_CRITERIA)) continue
      const parsed = TaskContractSchema.safeParse(state.task_contract)
      return {
        runId, goal: state.goal, criteria: state.criteria,
        input: parsed.success ? parsed.data.input : null,
        requirementsSha256: parsed.success ? parsed.data.requirements_sha256 : null,
        contractSha256: parsed.success ? parsed.data.contract_sha256 : null,
        userRequestMatches: parsed.success && parsed.data.request_snapshot?.status === "captured" &&
          parsed.data.request_snapshot.text === HEADLESS_INITIAL_PROMPT && !parsed.data.request_snapshot.text_transformed &&
          parsed.data.request_snapshot.non_text_parts === 0,
        userRequestSha256: parsed.success && parsed.data.request_snapshot?.status === "captured" ? parsed.data.request_snapshot.text_sha256 : null,
        valid: parsed.success && JSON.stringify(parsed.data.input) === JSON.stringify(HEADLESS_TASK_CONTRACT),
      }
    } catch { /* malformed or unrelated run rows are not evidence */ }
  }
  return null
}

function taskContractPersisted(snapshot: PersistedTaskContractSnapshot | null): snapshot is PersistedTaskContractSnapshot {
  return !!snapshot && snapshot.valid && snapshot.goal === HEADLESS_PLAN_GOAL &&
    JSON.stringify(snapshot.criteria) === JSON.stringify(HEADLESS_ORIGINAL_CRITERIA) &&
    !!snapshot.requirementsSha256 && !!snapshot.contractSha256 && snapshot.userRequestMatches && !!snapshot.userRequestSha256
}

function portNumber(address: string | undefined): number {
  if (!address) throw new Error("local service did not bind a port")
  const port = Number(new URL(address).port)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("local service returned an invalid endpoint")
  return port
}

function childEnvironment(root: string, project: string, configHome: string, configPath: string, sidecarPath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: join(root, "home"), USERPROFILE: join(root, "home"), XDG_CONFIG_HOME: configHome,
    XDG_DATA_HOME: join(root, "xdg-data"), XDG_CACHE_HOME: join(root, "xdg-cache"),
    TMPDIR: join(root, "tmp"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"),
    OPENCODE_CONFIG: configPath, OPENCODE_ALG_CONFIG: sidecarPath,
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_AUTOCOMPACT: "1",
    OPENCODE_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1",
    OPENCODE_ALG_LIVE_SOURCE_SHA256: "",
    [ALG_LIVE_SOURCE_DIGEST_ENV]: verificationPluginConfiguration().source.digest,
    NO_COLOR: "1",
  }
  if (process.platform === "win32") {
    for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key]
    env.APPDATA = join(root, "appdata")
    env.LOCALAPPDATA = join(root, "localappdata")
  }
  return env
}

function writeEvidence(path: string, evidence: HeadlessAcceptanceEvidence): string {
  const parsed = EvidenceSchema.parse(evidence)
  const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8")
  if (bytes.byteLength > 512 * 1024) throw new Error("headless acceptance evidence exceeds 512 KiB")
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 })
  return sha256(bytes)
}

export async function runV1HeadlessAcceptance(outputInput?: string): Promise<{ evidence_path: string; evidence_sha256: string; evidence: HeadlessAcceptanceEvidence }> {
  const checkoutPlugin = verificationPluginConfiguration()
  let plugin = checkoutPlugin
  const executable = resolveHostExecutable()
  const outputRoot = resolve(outputInput ? dirname(resolve(outputInput)) : join(tmpdir(), "opencode-alg-v1-headless-evidence"))
  mkdirSync(outputRoot, { recursive: true })
  const evidencePath = outputInput ? resolve(outputInput) : join(outputRoot, `headless-${plugin.source.digest.slice(0, 16)}-${randomUUID()}.json`)
  if (!isAbsolute(evidencePath) || existsSync(evidencePath)) throw new Error("evidence output must be an absolute, unused file path")
  const roots = realUserGlobalConfigRoots({ ...process.env })
  const hmacKey = cryptoRandomKey()
  const before = snapshotGlobalOpenCodeConfig(roots, hmacKey)
  const temporaryParent = realpathSync.native(tmpdir())
  const temporaryRoot = realpathSync.native(mkdtempSync(join(temporaryParent, "alg-v1-headless-")))
  const removeTemporaryRoot = () => {
    if (dirname(temporaryRoot) !== temporaryParent || !basename(temporaryRoot).startsWith("alg-v1-headless-") ||
      realpathSync.native(temporaryRoot) !== temporaryRoot) throw new Error("temporary cleanup target changed")
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
  const project = join(temporaryRoot, "project")
  const home = join(temporaryRoot, "home")
  const configHome = join(temporaryRoot, "xdg-config")
  const configPath = join(temporaryRoot, "opencode.json")
  const sidecarPath = join(temporaryRoot, "alg-options.json")
  const runtimeSourceRoot = join(temporaryRoot, "runtime-source")
  const provider = createSyntheticProvider()
  const mcpService = createSyntheticMcpService()
  const started: TrackedProcess[] = []
  const exited: boolean[] = []
  let providerStopped = false
  let mcpStopped = false
  let credentialsInherited = true
  let removed = false
  let evidenceSaved = false
  let sessionId: string | null = null
  let ids: string[] = []
  let initialToolCalls: string[] = [], followupToolCalls: string[] = []
  let checkerProbe: Awaited<ReturnType<typeof runCheckerHeadlessProbe>> | null = null
  let taskAdmissionProbe: Awaited<ReturnType<typeof runTaskAdmissionHostProbe>> | null = null
  let allowanceStart: Awaited<ReturnType<typeof startAllowanceHostProbe>> | null = null
  let allowanceProbe: Awaited<ReturnType<typeof finishAllowanceHostProbe>> | null = null
  let initialCheckpoint: HeadlessAcceptanceEvidence["session"]["initial_memory_checkpoint"] = null
  let compactCheckpoint: HeadlessAcceptanceEvidence["session"]["compacted_memory_checkpoint"] = null
  let finalCheckpoint: HeadlessAcceptanceEvidence["session"]["final_memory_checkpoint"] = null
  let taskContractBefore: PersistedTaskContractSnapshot | null = null
  let taskContractCompacted: PersistedTaskContractSnapshot | null = null
  let taskContractAfterRestart: PersistedTaskContractSnapshot | null = null
  let taskContractAfterFinalRestart: PersistedTaskContractSnapshot | null = null
  let sameResultPin = false, recoveredCompaction = false, recoveredSameEvidence = false, sameSession = false
  let failure: string | null = null
  let providerServer: Server | undefined
  const providerStart = provider.server
  const configBeforeSha = before.sha256
  let configAfterSha = before.sha256
  let providerPort = 0
  const actualInvestigationResults: Array<{ status: string; work_key: string | null; manifest_ref: string | null; digest: string | null }> = []
  const actualReadResults: any[] = []
  let sameInvestigationWorkKey = false, sameInvestigationResult = false, investigationRevalidatedAfterRestarts = false
  let investigationQueryToolCalls = 0, planToolSeen = false, queryToolSeen = false
  let validationCountAfterInitial = 0
  let pluginProofs: boolean[] = []
  let hostVersion = ""
  let compactionSawInitial = false
  let followupSawRef = false
  try {
    for (const directory of [project, home, configHome, join(temporaryRoot, "xdg-data"), join(temporaryRoot, "xdg-cache"), join(temporaryRoot, "tmp"), join(temporaryRoot, "appdata"), join(temporaryRoot, "localappdata")]) mkdirSync(directory, { recursive: true, mode: 0o700 })
    seedVerificationHostDependencies(join(configHome, "opencode"), checkoutPlugin.source.root)
    const projectRoot = realpathSync.native(project)
    mcpService.bindProject(new MemoryStore(projectRoot).projectId)
    mkdirSync(runtimeSourceRoot, { recursive: true, mode: 0o700 })
    for (const entry of checkoutPlugin.source.manifest) {
      const relativePath = entry.path.split("/").join(sep)
      const sourcePath = join(checkoutPlugin.source.root, relativePath)
      const destinationPath = join(runtimeSourceRoot, relativePath)
      mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 })
      copyFileSync(sourcePath, destinationPath, constants.COPYFILE_EXCL)
    }
    symlinkSync(join(checkoutPlugin.source.root, "node_modules"), join(runtimeSourceRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir")
    plugin = verificationPluginConfiguration(runtimeSourceRoot)
    if (plugin.source.digest !== checkoutPlugin.source.digest) throw new Error("runtime source changed while the immutable host snapshot was prepared")
    const probeAgents = join(configHome, "opencode", "agents")
    mkdirSync(probeAgents)
    for (const role of ["implementer", "researcher", "checker"]) copyFileSync(join(runtimeSourceRoot, "agents", `${role}.md`), join(probeAgents, `${role}.md`), constants.COPYFILE_EXCL)
    writeFileSync(join(projectRoot, "README.md"), "Synthetic headless host acceptance fixture.\n", { flag: "wx" })
    mkdirSync(join(projectRoot, ".opencode"), { recursive: true, mode: 0o700 })
    seedVerificationHostDependencies(join(projectRoot, ".opencode"), checkoutPlugin.source.root)
    writeFileSync(join(projectRoot, ".opencode", "ALG.workspace.json"), JSON.stringify({ schema_version: 1, operations: [
      { id: "headless-smoke", requirements: [{ id: "fixture-readme", kind: "document", ref: "README.md", intent: "required" }] },
      { id: "data.investigate.read", coverage: "advisory", boundary: "alg_investigation", effects: ["read"], requirements: [] },
    ] }), { flag: "wx" })
    providerServer = provider.server
    await new Promise<void>((resolveListen, reject) => { providerServer!.once("error", reject); providerServer!.listen(0, "127.0.0.1", () => resolveListen()) })
    providerPort = portNumber(providerServer.address() ? `http://127.0.0.1:${(providerServer.address() as any).port}` : undefined)
    const providerEndpoint = `http://127.0.0.1:${providerPort}/v1`
    const config = {
      $schema: "https://opencode.ai/config.json", plugin: [plugin.source.spec], model: "alg-headless/deterministic",
      autoupdate: false,
      provider: { "alg-headless": { npm: "@ai-sdk/openai-compatible", name: "ALG deterministic local test", options: { baseURL: providerEndpoint }, models: { deterministic: { name: "Deterministic", limit: { context: 32768, output: 2048 } } } } },
    }
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    writeFileSync(sidecarPath, JSON.stringify({ taskAllowance: { max_dispatches: 2, verification_reserve: 1 }, sessionMemory: { mode: "assist" }, workspace: { mode: "observe" }, investigation: { enabled: true, costLimit: 10, adapter: mcpService.profile } }), { flag: "wx", mode: 0o600 })
    const env = childEnvironment(temporaryRoot, projectRoot, configHome, configPath, sidecarPath)
    const credentialKeys = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY", "OPENCODE_API_KEY"]
    credentialsInherited = credentialKeys.some((key) => Boolean(env[key]))
    if (credentialsInherited) throw new Error("isolated OpenCode environment unexpectedly contains a credential variable")
    const versionProc = spawn(executable, ["--version"], { cwd: projectRoot, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    let versionOutput = "", versionError = ""
    versionProc.stdout?.on("data", (chunk: Buffer) => { versionOutput = bounded(versionOutput + chunk.toString(), 4096) })
    versionProc.stderr?.on("data", (chunk: Buffer) => { versionError = bounded(versionError + chunk.toString(), 4096) })
    const versionTimer = setTimeout(() => versionProc.kill("SIGKILL"), 15_000)
    let versionCode: number | null
    try { versionCode = await new Promise<number | null>((resolveExit, reject) => { versionProc.once("error", reject); versionProc.once("close", resolveExit) }) }
    finally { clearTimeout(versionTimer) }
    const versionMatch = versionOutput.match(/\b\d+\.\d+\.\d+\b/)?.[0]
    if (versionCode !== 0 || !versionMatch || !validateOpenCodeVersion(versionMatch).compatible) throw new Error(`OpenCode must be compatible V1; version output=${bounded(versionOutput)} ${bounded(versionError)}`)
    hostVersion = versionMatch
    const launchServer = async (): Promise<{ base: string; processInfo: TrackedProcess; pids: number[] }> => {
      const port = await getFreePort()
      const args = ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "INFO"]
      const processInfo = launchProcess(executable, args, projectRoot, env)
      started.push(processInfo)
      if (processInfo.child.pid) pids.push(processInfo.child.pid)
      const base = `http://127.0.0.1:${port}`
      ids = await waitToolRegistry(base, processInfo, projectRoot, plugin)
      const text = `${processInfo.stdout}\n${processInfo.stderr}`
      pluginProofs.push(Boolean(findSourceIdentityLine(text, "server", plugin.source) && findLoadedPluginLine(text, plugin)))
      return { base, processInfo, pids }
    }
    const pids: number[] = []
    let first = await launchServer()
    const query = `directory=${encodeURIComponent(projectRoot)}`
    const created = await jsonRequest<any>(`${first.base}/session?${query}`, "POST", { title: "ALG V1 synthetic headless acceptance" })
    sessionId = typeof created.value?.id === "string" ? created.value.id : null
    if (!sessionId) throw new Error("OpenCode session creation did not return a session ID")
    const initial = await jsonRequest<any>(`${first.base}/session/${encodeURIComponent(sessionId)}/message?${query}`, "POST", {
      model: { providerID: "alg-headless", modelID: "deterministic" },
      parts: [{ type: "text", text: HEADLESS_INITIAL_PROMPT }],
    }, WAIT_MS)
    const initialMessages = (await jsonRequest<any[]>(`${first.base}/session/${encodeURIComponent(sessionId)}/message?${query}&limit=100`, "GET")).value
    if (!Array.isArray(initialMessages) || !initialMessages.length) throw new Error("Initial session transcript did not persist")
    initialToolCalls = [...new Set([...transcriptToolNames(initialMessages), ...toolNames(initial.value)])]
    planToolSeen = initialToolCalls.includes("alg_plan")
    queryToolSeen = initialToolCalls.includes("alg_investigation")
    investigationQueryToolCalls += initialToolCalls.filter((name) => name === "alg_investigation").length
    actualInvestigationResults.push(...completedInvestigationOutputs(initialMessages))
    actualReadResults.push(...completedReadOutputs(initialMessages))
    await wait(350)
    const initialState = resultCheckpoint(projectRoot, sessionId)
    initialCheckpoint = { revision: initialState.revision, generation: initialState.generation, result_pins: initialState.result_pins, result_persisted: initialState.result_persisted }
    if (!initialToolCalls.includes("alg_context_status") || !planToolSeen || !queryToolSeen) {
      throw new Error(`Actual OpenCode session did not invoke the expected ALG tools: ${initialToolCalls.join(",")}`)
    }
    taskContractBefore = readPersistedTaskContract(projectRoot)
    if (!taskContractPersisted(taskContractBefore)) throw new Error("Actual data-investigation plan did not persist its declared contract and original criteria")
    if (!actualInvestigationResults.some((item) => item.status === "reusable" && item.manifest_ref === PERSISTED_REFERENCE && item.digest === PERSISTED_RESULT && item.work_key)) {
      throw new Error("Actual alg_investigation query did not return a completed revalidated synthetic result")
    }
    const firstQueryResult = actualInvestigationResults.find((item) => item.status === "reusable")!
    validationCountAfterInitial = mcpService.counters.validationCalls
    if (!initialState.result_persisted) throw new Error("Session-memory result was not durably captured before compaction")
    const hostAllowance = new MemoryStore(projectRoot).checkpoint(sessionId)?.task_allowance
    if (!hostAllowance || hostAllowance.first_contract_sha256 !== taskContractBefore?.contractSha256 ||
      hostAllowance.policy.max_dispatches !== 2 || hostAllowance.policy.verification_reserve !== 1 || hostAllowance.entries.length !== 0)
      throw new Error("Installed host did not pin the original task's 2/1 allowance before the direct probe")
    allowanceStart = await startAllowanceHostProbe(first.base, projectRoot, sessionId)
    provider.setPhase("compaction")
    compactionSawInitial = provider.requests.some((item) => item.phase === "compaction" && item.saw_initial_reference && item.saw_initial_result)
    await jsonRequest<boolean>(`${first.base}/session/${encodeURIComponent(sessionId)}/summarize?${query}`, "POST", { providerID: "alg-headless", modelID: "deterministic" }, WAIT_MS)
    taskContractCompacted = readPersistedTaskContract(projectRoot)
    if (!taskContractPersisted(taskContractCompacted)) throw new Error("Task contract or original criteria disappeared during host compaction")
    compactionSawInitial = provider.requests.some((item) => item.phase === "compaction" && item.saw_initial_reference && item.saw_initial_result)
    const afterCompactState = resultCheckpoint(projectRoot, sessionId)
    sameResultPin = initialState.result_pins.some((pin) => afterCompactState.result_pins.includes(pin)) && afterCompactState.result_persisted
    compactCheckpoint = { revision: afterCompactState.revision, generation: afterCompactState.generation, same_result_pin: sameResultPin }
    if (!sameResultPin) throw new Error("Host compaction did not preserve the same durable result pin")
    const compactMessages = (await jsonRequest<any[]>(`${first.base}/session/${encodeURIComponent(sessionId)}/message?${query}&limit=100`, "GET")).value
    if (!Array.isArray(compactMessages) || !hasCompactionWithEvidence(compactMessages)) throw new Error("OpenCode did not persist the synthetic compaction summary with its reference and result")
    if (!await stopProcess(first.processInfo)) throw new Error("First OpenCode server process could not be confirmed stopped")
    exited.push(true)
    first = await launchServer()
    sameSession = (await jsonRequest<any[]>(`${first.base}/session?${query}`, "GET")).value.some((item: any) => item?.id === sessionId)
    if (!sameSession) throw new Error("Session ID was not recovered after the first server restart")
    const recoveredMessages = (await jsonRequest<any[]>(`${first.base}/session/${encodeURIComponent(sessionId)}/message?${query}&limit=100`, "GET")).value
    recoveredCompaction = Array.isArray(recoveredMessages) && hasCompactionWithEvidence(recoveredMessages)
    if (!recoveredCompaction) throw new Error("Compaction evidence was not present after the first server restart")
    const afterRestartState = resultCheckpoint(projectRoot, sessionId)
    recoveredSameEvidence = afterRestartState.result_pins.some((pin) => initialState.result_pins.includes(pin)) && afterRestartState.result_persisted
    if (!recoveredSameEvidence) throw new Error("Durable session-memory result reference changed or disappeared after restart")
    taskContractAfterRestart = readPersistedTaskContract(projectRoot)
    if (!taskContractPersisted(taskContractAfterRestart)) throw new Error("Task contract or original criteria disappeared after host restart")
    const runFollowup = async (base: string, round: number): Promise<void> => {
      provider.setPhase("followup")
      const transcriptBefore = (await jsonRequest<any[]>(`${base}/session/${encodeURIComponent(sessionId!)}/message?${query}&limit=100`, "GET")).value
      if (!Array.isArray(transcriptBefore)) throw new Error(`Transcript read before follow-up ${round} failed`)
      const priorMessageIds = new Set(transcriptBefore.map((message: any) => String(message?.info?.id ?? message?.id ?? "")).filter(Boolean))
      const followup = await jsonRequest<any>(`${base}/session/${encodeURIComponent(sessionId!)}/message?${query}`, "POST", {
        model: { providerID: "alg-headless", modelID: "deterministic" },
        parts: [{ type: "text", text: `${FOLLOWUP_MARKER} round ${round}: execute the same bounded-read query on the attached data-investigation. Return its actual reusable manifest reference and digest only.` }],
      }, WAIT_MS)
      const allMessages = (await jsonRequest<any[]>(`${base}/session/${encodeURIComponent(sessionId!)}/message?${query}&limit=100`, "GET")).value
      if (!Array.isArray(allMessages)) throw new Error(`Transcript read after follow-up ${round} failed`)
      const newMessages = allMessages.filter((message: any) => {
        const id = String(message?.info?.id ?? message?.id ?? "")
        return !id || !priorMessageIds.has(id)
      })
      const calls = [...new Set([...transcriptToolNames(newMessages), ...toolNames(followup.value)])]
      followupToolCalls = [...followupToolCalls, ...calls]
      const outputs = completedInvestigationOutputs(newMessages)
      actualInvestigationResults.push(...outputs)
      actualReadResults.push(...completedReadOutputs(newMessages))
      investigationQueryToolCalls += calls.filter((name) => name === "alg_investigation").length
      const last = outputs.at(-1)
      const transcript = JSON.stringify(allMessages)
      followupSawRef ||= provider.requests.some((item) => item.phase === "followup" && item.saw_persisted_reference && item.saw_query_output)
      if (!calls.includes("alg_investigation") || !last || last.status !== "reusable" || last.work_key !== firstQueryResult.work_key ||
        last.manifest_ref !== firstQueryResult.manifest_ref || last.digest !== firstQueryResult.digest ||
        !transcript.includes(PERSISTED_REFERENCE) || !transcript.includes(PERSISTED_RESULT)) {
        throw new Error(`Post-restart follow-up ${round} did not revalidate and return the same query result`)
      }
      if (round === 2) investigationRevalidatedAfterRestarts = true
    }
    await runFollowup(first.base, 1)
    if (!await stopProcess(first.processInfo)) throw new Error("Second OpenCode server process could not be confirmed stopped")
    exited.push(true)
    const third = await launchServer()
    sameSession &&= (await jsonRequest<any[]>(`${third.base}/session?${query}`, "GET")).value.some((item: any) => item?.id === sessionId)
    const finalMessages = (await jsonRequest<any[]>(`${third.base}/session/${encodeURIComponent(sessionId)}/message?${query}&limit=100`, "GET")).value
    recoveredCompaction &&= Array.isArray(finalMessages) && hasCompactionWithEvidence(finalMessages)
    taskContractAfterFinalRestart = readPersistedTaskContract(projectRoot)
    if (!taskContractPersisted(taskContractAfterFinalRestart)) throw new Error("Task contract or original criteria disappeared after final host restart")
    await runFollowup(third.base, 2)
    provider.setPhase("background")
    allowanceProbe = await finishAllowanceHostProbe(third.base, projectRoot, sessionId, allowanceStart!)
    if (!allowanceProbe.passed) throw new Error("Actual child allowance did not survive compaction/restarts or stop exhausted work")
    const probeParent = await jsonRequest<any>(`${third.base}/session?${query}`, "POST", { title: "Isolated checker evidence fixture" })
    if (typeof probeParent.value?.id !== "string") throw new Error("Checker probe parent session was not created")
    checkerProbe = await runCheckerHeadlessProbe(third.base, projectRoot, probeParent.value.id)
    if (!checkerProbe.passed) throw new Error("Actual OpenCode children did not complete the selected-evidence fixture")
    taskAdmissionProbe = await runTaskAdmissionHostProbe(third.base, projectRoot, probeParent.value.id)
    if (!taskAdmissionProbe.passed) throw new Error("Actual OpenCode task-admission qualification failed")
    finalCheckpoint = (() => { const state = resultCheckpoint(projectRoot, sessionId!); return { revision: state.revision, generation: state.generation, result_persisted: state.result_persisted } })()
    if (!sameSession || !recoveredCompaction || !finalCheckpoint.result_persisted) throw new Error("Final server restart did not preserve the session and memory evidence")
    if (!await stopProcess(third.processInfo)) throw new Error("Third OpenCode server process could not be confirmed stopped")
    exited.push(true)
    sameInvestigationWorkKey = actualInvestigationResults.length === 3 && actualInvestigationResults.every((item) => item.work_key === firstQueryResult.work_key)
    sameInvestigationResult = actualInvestigationResults.length === 3 && actualInvestigationResults.every((item) => item.manifest_ref === PERSISTED_REFERENCE && item.digest === PERSISTED_RESULT)
    investigationRevalidatedAfterRestarts &&= mcpService.counters.validationCalls >= validationCountAfterInitial + 2
    if (actualReadResults.length !== 3 || actualReadResults.some((page) => page.digest !== PERSISTED_RESULT ||
      page.rows?.[0]?.evidence !== "synthetic-observation") || mcpService.counters.readCalls !== 1 || mcpService.counters.lookupCalls !== 2)
      throw new Error("Host evidence reads or asynchronous job reuse failed")
    if (mcpService.counters.acceptedRemoteJobs !== 1 || mcpService.counters.submitCalls !== 1 || mcpService.counters.validationCalls < 3 ||
      !sameInvestigationWorkKey || !sameInvestigationResult || !investigationRevalidatedAfterRestarts) {
      throw new Error("Synthetic MCP evidence did not show one accepted job and repeated validation of the same result")
    }
  } catch (error) {
    failure = bounded(error instanceof Error ? error.message : String(error))
  } finally {
    for (const proc of started) if (!proc.exited && proc.child.exitCode === null) exited.push(await stopProcess(proc))
    try { await provider.close(); providerStopped = true } catch { providerStopped = false }
    try { await mcpService.close(); mcpStopped = true } catch { mcpStopped = false }
    try { configAfterSha = snapshotGlobalOpenCodeConfig(roots, hmacKey).sha256 } catch { configAfterSha = "0".repeat(64) }
    const globalConfigUnchanged = configAfterSha === configBeforeSha
    const taskContractSnapshots = [taskContractBefore, taskContractCompacted, taskContractAfterRestart, taskContractAfterFinalRestart]
    const taskContractBaseline = taskContractPersisted(taskContractBefore) ? taskContractBefore : null
    const taskContractDigestsStable = !!taskContractBaseline && taskContractSnapshots.every((snapshot) => taskContractPersisted(snapshot) &&
        snapshot.runId === taskContractBaseline.runId && snapshot.requirementsSha256 === taskContractBaseline.requirementsSha256 &&
        snapshot.contractSha256 === taskContractBaseline.contractSha256 && snapshot.goal === HEADLESS_PLAN_GOAL &&
        JSON.stringify(snapshot.criteria) === JSON.stringify(HEADLESS_ORIGINAL_CRITERIA) && JSON.stringify(snapshot.input) === JSON.stringify(HEADLESS_TASK_CONTRACT))
    const taskContractEvidence: NonNullable<HeadlessAcceptanceEvidence["task_contract"]> = {
      run_id: taskContractBefore?.runId ?? null, input: taskContractBefore?.input ?? null,
      original_goal: taskContractBefore?.goal ?? null, original_criteria: taskContractBefore?.criteria ?? [],
      requirements_sha256: taskContractBefore?.requirementsSha256 ?? null, contract_sha256: taskContractBefore?.contractSha256 ?? null,
      persisted_before_compaction: taskContractPersisted(taskContractBefore), persisted_after_compaction: taskContractPersisted(taskContractCompacted),
      persisted_after_restart: taskContractPersisted(taskContractAfterRestart), persisted_after_final_restart: taskContractPersisted(taskContractAfterFinalRestart),
      digests_stable: taskContractDigestsStable,
      user_request_captured: taskContractBefore?.userRequestMatches === true,
      user_request_sha256: taskContractBefore?.userRequestSha256 ?? null,
    }
    const wasPassed = failure === null && allowanceProbe?.passed === true && checkerProbe?.passed === true && taskAdmissionProbe?.passed === true && taskAdmissionProbe.child_calls === 0 && !credentialsInherited && globalConfigUnchanged && started.length === 3 && exited.filter(Boolean).length === 3 && pluginProofs.length === 3 && pluginProofs.every(Boolean) && taskContractDigestsStable &&
      ids.length === ALG_TOOL_IDS.length && ALG_TOOL_IDS.every((id) => ids.includes(id)) && initialToolCalls.includes("alg_context_status") && initialToolCalls.includes("alg_investigation") &&
      followupToolCalls.filter((name) => name === "alg_investigation").length === 2 && planToolSeen && queryToolSeen && providerStopped && mcpStopped &&
      provider.nonLoopbackRequests === 0 && mcpService.counters.nonLoopbackRequests === 0 && mcpService.counters.submitCalls === 1 && mcpService.counters.acceptedRemoteJobs === 1 &&
      mcpService.counters.validationCalls >= 6 && actualReadResults.length === 3 && mcpService.counters.readCalls === 1 && mcpService.counters.lookupCalls === 2 && sameInvestigationWorkKey && sameInvestigationResult && investigationRevalidatedAfterRestarts &&
      sameResultPin && compactionSawInitial && recoveredCompaction && recoveredSameEvidence && sameSession && followupSawRef
    const evidenceCandidate: HeadlessAcceptanceEvidence = {
      schema_version: 1, kind: "opencode-alg-v1-headless-acceptance", generated_at: new Date().toISOString(), passed: wasPassed,
      checker_probe: checkerProbe,
      task_admission_probe: taskAdmissionProbe,
      task_allowance_probe: allowanceProbe,
      failure: globalConfigUnchanged ? failure : "real-user OpenCode configuration changed during the isolated host run",
      evidence_path: evidencePath, task_contract: taskContractEvidence,
      source: { package_version: plugin.package_version, root: checkoutPlugin.source.root, loaded_root: plugin.source.root, sha256: plugin.source.digest, node: process.versions.node, bun: process.versions.bun ?? null },
      host: { executable, version: hostVersion, platform: process.platform, arch: process.arch, libc: linuxLibc(), starts: started.length, restarts: Math.max(0, started.length - 1), pids: started.map((item) => item.child.pid).filter((pid): pid is number => typeof pid === "number"), clean_exits: exited.slice(0, 3) },
      isolation: { temporary_root: temporaryRoot, project, config_home: configHome, config_path: configPath, sidecar_path: sidecarPath,
        provider_endpoint: providerPort ? `http://127.0.0.1:${providerPort}/v1` : "http://127.0.0.1:0/v1", server_bind_host: "127.0.0.1",
        credentials_inherited: credentialsInherited, real_user_config_unchanged: globalConfigUnchanged, config_before_sha256: configBeforeSha, config_after_sha256: configAfterSha },
      session: { id: sessionId, persisted_same_id: sameSession, initial_tool_calls: initialToolCalls, followup_tool_calls: followupToolCalls,
        tool_registry_ids: ids, registry_exact: ids.length === ALG_TOOL_IDS.length && ALG_TOOL_IDS.every((id) => ids.includes(id)), plugin_startup_proofs: pluginProofs,
        initial_memory_checkpoint: initialCheckpoint, compacted_memory_checkpoint: compactCheckpoint, recovered_compaction_message: recoveredCompaction,
        recovered_reference_and_result: recoveredSameEvidence, final_memory_checkpoint: finalCheckpoint },
      synthetic_provider: { endpoint: providerPort ? `http://127.0.0.1:${providerPort}/v1` : "http://127.0.0.1:0/v1", received_requests: provider.requests.length, non_loopback_requests: provider.nonLoopbackRequests,
        phases: provider.requests.map((item) => item.phase), context_status_seen: provider.requests.some((item) => item.tool_names.includes("alg_context_status")),
        plan_tool_seen: planToolSeen, investigation_query_tool_seen: queryToolSeen, query_result_observed_by_model: provider.requests.some((item) => item.saw_query_output),
        compaction_saw_initial_result: provider.requests.some((item) => item.phase === "compaction" && item.saw_initial_reference && item.saw_initial_result),
        followup_saw_persisted_reference: provider.requests.some((item) => item.phase === "followup" && item.saw_persisted_reference && item.saw_query_output),
        no_non_loopback_requests: provider.nonLoopbackRequests === 0 && mcpService.counters.nonLoopbackRequests === 0 },
      investigation: { enabled: true, mcp_server_name: mcpService.serverName, mcp_server_version: mcpService.serverVersion, profile_schema_hashes: mcpService.schemas,
        submit_calls: mcpService.counters.submitCalls, accepted_remote_jobs: mcpService.counters.acceptedRemoteJobs, validation_calls: mcpService.counters.validationCalls,
        read_calls: mcpService.counters.readCalls, lookup_calls: mcpService.counters.lookupCalls, read_result_tool_calls: actualReadResults.length,
        query_tool_calls: investigationQueryToolCalls, same_work_key: sameInvestigationWorkKey, same_result_reference: sameInvestigationResult,
        result_revalidated_after_restarts: investigationRevalidatedAfterRestarts, actual_tool_results: actualInvestigationResults },
      cleanup: { host_processes_stopped: started.length > 0 && exited.filter(Boolean).length === started.length, provider_stopped: providerStopped, mcp_service_stopped: mcpStopped,
        temporary_environment_removed: false, evidence_persisted_before_environment_removal: false },
    }
    try {
      const bytes = Buffer.from(`${JSON.stringify(EvidenceSchema.parse(evidenceCandidate), null, 2)}\n`, "utf8")
      if (bytes.byteLength > 512 * 1024) throw new Error("headless acceptance evidence exceeds 512 KiB")
      writeFileSync(`${evidencePath}.before-cleanup.json`, bytes, { flag: "wx", mode: 0o600 })
      evidenceSaved = true
      removeTemporaryRoot()
      removed = !existsSync(temporaryRoot)
      const finalEvidence = EvidenceSchema.parse({ ...evidenceCandidate,
        cleanup: { ...evidenceCandidate.cleanup, temporary_environment_removed: removed, evidence_persisted_before_environment_removal: evidenceSaved },
        passed: wasPassed && removed && evidenceSaved,
        ...(removed ? {} : { failure: "owned temporary environment could not be removed after evidence publication" }),
      })
      // Keep the pre-cleanup receipt and publish the final receipt without overwriting.
      const revisedBytes = Buffer.from(`${JSON.stringify(finalEvidence, null, 2)}\n`, "utf8")
      writeFileSync(evidencePath, revisedBytes, { flag: "wx", mode: 0o600 })
    } catch (error) {
      if (!failure) failure = bounded(error instanceof Error ? error.message : String(error))
      // Preserve the owned environment if evidence publication or verified cleanup fails.
    }
  }
  const persisted = EvidenceSchema.parse(JSON.parse(readFileSync(evidencePath, "utf8")))
  return { evidence_path: evidencePath, evidence_sha256: sha256(readFileSync(evidencePath)), evidence: persisted }
}

function cryptoRandomKey(): Buffer { return createHash("sha256").update(randomUUID()).update(randomUUID()).digest() }

function linuxLibc(): string {
  if (process.platform !== "linux") return "not-applicable"
  const header = (process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined)?.header
  return header?.glibcVersionRuntime ? `glibc-${header.glibcVersionRuntime}` : "non-glibc-or-unidentified"
}

function parseArgs(args: string[]): { output?: string } {
  let output: string | undefined
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--output") {
      const value = args[++index]
      if (!value || !isAbsolute(value)) throw new Error("--output requires an absolute evidence file path")
      output = resolve(value)
    } else if (args[index] === "--help" || args[index] === "-h") throw new Error("Usage: bun run scripts/test-v1-headless.ts [--output <absolute-evidence.json>] [OPENCODE_BIN=<path>]")
    else throw new Error(`Unknown headless test option: ${args[index]}`)
  }
  return { output }
}

if (import.meta.main) {
  try {
    const result = await runV1HeadlessAcceptance(parseArgs(process.argv.slice(2)).output)
    console.log(JSON.stringify({ check: "opencode-alg-v1-headless-acceptance", passed: result.evidence.passed, evidence_path: result.evidence_path, evidence_sha256: result.evidence_sha256,
      source_sha256: result.evidence.source.sha256, opencode_version: result.evidence.host.version, server_starts: result.evidence.host.starts,
      server_restarts: result.evidence.host.restarts, tool_registry_count: result.evidence.session.tool_registry_ids.length, initial_tool_calls: result.evidence.session.initial_tool_calls,
      followup_tool_calls: result.evidence.session.followup_tool_calls, compaction_recovered: result.evidence.session.recovered_compaction_message,
      memory_result_persisted: result.evidence.session.final_memory_checkpoint?.result_persisted ?? false, failure: result.evidence.failure }))
    if (!result.evidence.passed) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

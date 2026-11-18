import { randomUUID } from "node:crypto"
import { mkdtempSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { InvestigationAdapterSchema, type InvestigationAdapter } from "../src/operational-options.ts"
import { InvestigationHttpPort } from "../src/investigation-transport.ts"
import { InvestigationResultSchema, InvestigationStore, type InvestigationMcpPort } from "../src/investigation/index.ts"
import { hashObject } from "../src/session-memory/store.ts"

const TOOL_LIMIT = 128
const CONFIG_LIMIT = 65_536
const RECEIPT_LIMIT = 262_144

export type QualificationCheckStatus = "observed" | "failed" | "unverified"
export interface QualificationCheck { id: string; status: QualificationCheckStatus; detail?: string }
export interface QualificationReceipt {
  schema_version: 1
  mode: "inventory" | "probe"
  observed_at: string
  endpoint: { origin: string }
  server: { name: string | null; version: string | null }
  tools: Array<{ name: string; schema_sha256: string }>
  checks: QualificationCheck[]
  qualification: "not_established"
  probe_state?: { directory: string; submission_id?: string; work_key?: string; external_job_id?: string }
}

export interface QualificationBounds { timeoutMs: number; responseLimitBytes: number }
export type QualificationFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export interface InventoryOptions extends QualificationBounds {
  endpoint: string
  tokenEnv?: string
  env?: NodeJS.ProcessEnv
  fetchImpl?: QualificationFetch
}

function checkedEndpoint(value: string): URL {
  const url = new URL(value)
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username || url.password || url.search || url.hash) {
    throw new Error("endpoint must use HTTPS or loopback HTTP and contain no credentials, query, or fragment")
  }
  return url
}

function safeOrigin(url: URL): string { return url.origin }
/** Per-response bytes, request time, endpoint pinning, and redirects are bounded. */
export function createQualificationFetch(endpoint: string, bounds: QualificationBounds, baseFetch: QualificationFetch = fetch): QualificationFetch {
  const expected = new URL(endpoint).href
  if (!Number.isInteger(bounds.timeoutMs) || bounds.timeoutMs < 100 || bounds.timeoutMs > 60_000 ||
    !Number.isInteger(bounds.responseLimitBytes) || bounds.responseLimitBytes < 1024 || bounds.responseLimitBytes > 262_144) {
    throw new Error("qualification bounds are outside the supported range")
  }
  return async (input, init) => {
    if (new URL(String(input)).href !== expected) throw new Error("endpoint changed")
    const signal = init?.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(bounds.timeoutMs)])
      : AbortSignal.timeout(bounds.timeoutMs)
    const response = await baseFetch(input, { ...init, signal, redirect: "error" })
    if (!response.body) return response
    let bytes = 0
    const bounded = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength
        if (bytes > bounds.responseLimitBytes) throw new Error("MCP response exceeds qualification byte limit")
        controller.enqueue(chunk)
      },
    }))
    return new Response(bounded, { status: response.status, statusText: response.statusText, headers: response.headers })
  }
}

function validateInventoryOptions(options: InventoryOptions): { url: URL; token?: string; fetch: QualificationFetch } {
  const url = checkedEndpoint(options.endpoint)
  const env = options.env ?? process.env
  if (options.tokenEnv && !/^[A-Z][A-Z0-9_]{0,127}$/.test(options.tokenEnv)) throw new Error("invalid credential environment reference")
  const token = options.tokenEnv ? env[options.tokenEnv] : undefined
  if (options.tokenEnv && !token) throw new Error("credential environment reference is unavailable")
  return { url, ...(token ? { token } : {}), fetch: createQualificationFetch(options.endpoint, options, options.fetchImpl) }
}

/** Read-only MCP initialize and one bounded tools/list page. Descriptions are never returned or persisted. */
export async function runInventory(options: InventoryOptions): Promise<QualificationReceipt> {
  const { url, token, fetch: boundedFetch } = validateInventoryOptions(options)
  const client = new Client({ name: "opencode-alg-qualification-inventory", version: "1.0.0" }, { capabilities: {} })
  const transport = new StreamableHTTPClientTransport(url, {
    // Bun's global fetch type adds a runtime-only preconnect member. The SDK consumes the standard Fetch signature.
    fetch: boundedFetch as typeof fetch,
    requestInit: { redirect: "error", ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) },
    reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
  })
  let server: QualificationReceipt["server"] = { name: null, version: null }
  let tools: QualificationReceipt["tools"] = []
  const checks: QualificationCheck[] = []
  let stage = "initialize"
  try {
    await client.connect(transport, { timeout: options.timeoutMs })
    const identity = client.getServerVersion()
    if (!identity?.name || !identity.version || identity.name.length > 128 || identity.version.length > 128) {
      throw new Error("MCP initialize identity is missing or out of bounds")
    }
    server = { name: identity.name, version: identity.version }
    checks.push({ id: "mcp_initialize", status: "observed" })
    stage = "tools_list"
    const page = await client.listTools({}, { timeout: options.timeoutMs })
    if (!Array.isArray(page.tools) || page.tools.length > TOOL_LIMIT) throw new Error("MCP tool inventory exceeds the 128-tool bound")
    tools = page.tools.map((tool) => ({
      name: tool.name,
      schema_sha256: hashObject({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema ?? null }),
    })).sort((a, b) => a.name.localeCompare(b.name))
    checks.push({ id: "tools_list_page", status: "observed", detail: page.nextCursor ? "bounded_first_page_only" : "single_page_complete" })
  } catch {
    checks.push({ id: "inventory_exchange", status: "failed", detail: `${stage}_failed_service_unavailable_or_contract_mismatch` })
    if (!checks.some((check) => check.id === "mcp_initialize")) checks.push({ id: "mcp_initialize", status: "unverified" })
    if (!checks.some((check) => check.id === "tools_list_page")) checks.push({ id: "tools_list_page", status: "unverified" })
  } finally { await client.close().catch(() => {}) }
  checks.push(
    { id: "server_enforcement", status: "unverified" },
    { id: "submission_idempotency", status: "unverified" },
    { id: "retention", status: "unverified" },
    { id: "cancellation", status: "unverified" },
  )
  return {
    schema_version: 1, mode: "inventory", observed_at: new Date().toISOString(), endpoint: { origin: safeOrigin(url) },
    server, tools, checks, qualification: "not_established",
  }
}

export interface ProbeOptions {
  profile: unknown; projectId: string; env?: NodeJS.ProcessEnv; port?: InvestigationMcpPort; now?: () => Date; scratchDirectory?: string
}

/** One synthetic submit, lookup by that exact submission ID, and optional typed result validation. */
export async function runProbe(options: ProbeOptions): Promise<QualificationReceipt> {
  const profile = InvestigationAdapterSchema.parse(options.profile)
  const port = options.port ?? new InvestigationHttpPort(profile, options.projectId, options.env)
  const url = checkedEndpoint(profile.endpoint)
  const checks: QualificationCheck[] = []
  let identity: QualificationReceipt["server"] = { name: null, version: null }
  let stage = "initialize_and_schema_check"
  let tools: QualificationReceipt["tools"] = []
  let scratch: string | undefined
  let probeState: QualificationReceipt["probe_state"]
  try {
    if (port instanceof InvestigationHttpPort) {
      await port.qualify()
      identity = { name: profile.mcpServerName, version: profile.mcpServerVersion }
      tools = [profile.submit, profile.lookup, profile.validateResult, ...(profile.cancel ? [profile.cancel] : [])]
        .map((tool) => ({ name: tool.name, schema_sha256: tool.schemaHash }))
        .sort((a, b) => a.name.localeCompare(b.name))
      checks.push({ id: "initialize_and_pinned_tool_schemas", status: "observed" })
    } else checks.push({ id: "initialize_and_pinned_tool_schemas", status: "unverified", detail: "injected_port" })

    const operation = profile.operations[0]
    if (!operation) throw new Error("profile has no permitted operation")
    stage = "admit_synthetic_query"
    scratch = mkdtempSync(join(resolve(options.scratchDirectory ?? process.cwd()), ".alg-investigation-qualification-"))
    probeState = { directory: scratch }
    const scope = {
      project_directory: scratch, project_id: options.projectId,
      owner_id: `qualification-${randomUUID()}`, run_id: `probe-${randomUUID()}`,
    }
    const store = InvestigationStore.open(scope, { create: true, costLimit: profile.executionLimits.maxCost, maxAdmissions: 1 })
    const query = { qualification_probe: true, synthetic: true, rows: 1 }
    const admitted = await store.admit({ operation, recipe_version: "qualification-probe-v1", parameters: { synthetic_probe: true },
      source_dependencies: [], query, reserved_cost: profile.executionLimits.maxCost }, port.capabilities)
    probeState = { directory: scratch, submission_id: admitted.submission_id, work_key: admitted.work_key }
    stage = "single_synthetic_submission"
    const submitted = await store.dispatch(admitted.work_key, port)
    if (submitted.external_job_id) probeState.external_job_id = submitted.external_job_id
    const submissionKind = submitted.status === "running" ? "running" : submitted.status === "result_recorded" ? "result"
      : submitted.status === "failed_known" ? "failed_known" : "outcome_unknown"
    checks.push({ id: "single_synthetic_submission", status: ["running", "result_recorded", "failed_known"].includes(submitted.status) ? "observed" : "failed", detail: submissionKind })
    stage = "lookup_by_same_submission_id"
    const reconciled = await port.lookup(submitted.submission_id)
    checks.push({ id: "lookup_by_same_submission_id", status: ["running", "result", "failed_known"].includes(reconciled.kind) ? "observed" : "failed", detail: reconciled.kind })

    const result = submitted.result ?? (reconciled.kind === "result" ? reconciled.result : undefined)
    if (result) {
      stage = "result_validation"
      const parsed = InvestigationResultSchema.safeParse(result)
      if (!parsed.success) checks.push({ id: "typed_result_shape", status: "failed" })
      else if (!port.validateResult) checks.push({ id: "result_access_validation", status: "unverified", detail: "port_has_no_validator" })
      else {
        const valid = await port.validateResult(parsed.data, submitted)
        checks.push({ id: "result_access_validation", status: valid.valid && valid.validity_key === submitted.validity_key &&
          valid.access_scope === parsed.data.access_scope ? "observed" : "failed" })
      }
    } else checks.push({ id: "result_access_validation", status: "unverified", detail: "no_result_observed" })
  } catch {
    const failedCheck = stage === "initialize_and_schema_check" ? "initialize_and_pinned_tool_schemas"
      : stage === "admit_synthetic_query" ? "synthetic_query_admission"
      : stage === "single_synthetic_submission" ? "single_synthetic_submission"
      : stage === "lookup_by_same_submission_id" ? "lookup_by_same_submission_id" : "result_access_validation"
    if (!checks.some((check) => check.id === failedCheck)) {
      checks.push({ id: failedCheck, status: "failed", detail: `${stage}_failed_service_unavailable_or_contract_mismatch` })
    }
  }
  // Keep the journal even after transport failure: an accepted job must remain addressable.
  checks.push(
    { id: "duplicate_submit_idempotency", status: "unverified", detail: "no_second_submission_sent" },
    { id: "server_enforced_read_scope_and_execution_limits", status: "unverified" },
    { id: "retention", status: "unverified" },
    { id: "cancellation", status: "unverified" },
  )
  return {
    schema_version: 1, mode: "probe", observed_at: (options.now?.() ?? new Date()).toISOString(),
    endpoint: { origin: safeOrigin(url) }, server: identity, tools, checks, qualification: "not_established", probe_state: probeState,
  }
}

export async function writeQualificationReceipt(path: string, receipt: QualificationReceipt): Promise<void> {
  const output = JSON.stringify(receipt, null, 2) + "\n"
  if (Buffer.byteLength(output) > RECEIPT_LIMIT) throw new Error("qualification receipt exceeds local output bound")
  const target = resolve(path)
  await writeFile(target, output, { encoding: "utf8", mode: 0o600, flag: "wx" })
}

async function readProfile(path: string): Promise<unknown> {
  const data = await readFile(resolve(path))
  if (data.byteLength > CONFIG_LIMIT) throw new Error("profile config exceeds 64 KiB")
  return JSON.parse(data.toString("utf8")) as unknown
}

function usage(): string {
  return "usage: bun run scripts/qualify-investigation.ts --mode inventory --endpoint URL --output FILE [--token-env NAME] [--timeout-ms N] [--response-limit-bytes N]\n" +
    "   or: bun run scripts/qualify-investigation.ts --mode probe --config PROFILE.json --project-id ID --output FILE"
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: {
    mode: { type: "string" }, endpoint: { type: "string" }, config: { type: "string" }, "project-id": { type: "string" },
    output: { type: "string" }, "token-env": { type: "string" }, "timeout-ms": { type: "string" }, "response-limit-bytes": { type: "string" },
  }, strict: true })
  if (!values.mode || !values.output) throw new Error(usage())
  let receipt: QualificationReceipt
  if (values.mode === "inventory") {
    if (!values.endpoint || values.config || values["project-id"]) throw new Error("inventory requires --endpoint and forbids --config/--project-id")
    receipt = await runInventory({ endpoint: values.endpoint, ...(values["token-env"] ? { tokenEnv: values["token-env"] } : {}),
      timeoutMs: Number(values["timeout-ms"] ?? 15_000), responseLimitBytes: Number(values["response-limit-bytes"] ?? 65_536) })
  } else if (values.mode === "probe") {
    if (!values.config || !values["project-id"] || values.endpoint || values["token-env"] || values["timeout-ms"] || values["response-limit-bytes"])
      throw new Error("probe requires --config and --project-id; transport bounds and credential reference come from the existing profile")
    receipt = await runProbe({ profile: await readProfile(values.config), projectId: values["project-id"], scratchDirectory: dirname(resolve(values.output)) })
  } else throw new Error("--mode must be inventory or probe")
  await writeQualificationReceipt(values.output, receipt)
  console.log(JSON.stringify({ mode: receipt.mode, qualification: receipt.qualification, receipt: resolve(values.output), checks: receipt.checks }))
}

if (import.meta.main) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "qualification failed"); process.exitCode = 1 })
}

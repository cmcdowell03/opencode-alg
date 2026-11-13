import { createHash, randomBytes, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { isDeepStrictEqual } from "node:util"
import { createRun, hydrateRunFully, loadRun } from "../src/store.ts"
import { ActionEvidenceJournal } from "../src/action-evidence.ts"
import { EvidenceSourcesSchema, evidencePage } from "../src/evidence-retrieval.ts"
import { MechanicalAssessmentSchema, VerificationBasisSchema, criteriaDigest, classifyVerificationEvidenceGap,
  retrievedVerificationEvidence, validateVerification } from "../src/verification.ts"
import { extractJsonDetailed } from "../src/sessions.ts"
import { parseAndValidate } from "../src/schemas.ts"
import { validateOpenCodeVersion, realUserGlobalConfigRoots, snapshotGlobalOpenCodeConfig, verificationPluginConfiguration,
  runVersionCommand, VersionCommandError, type VersionCommandEvidence } from "./live-verify.ts"
import { redactEvolutionText } from "../src/skill-evolution-redaction.ts"
import { resolveOpenCodeExecutable } from "./host-executable.ts"
import { seedVerificationHostDependencies } from "./verification-host-dependencies.ts"
import { compactionReceipt, observeCompactionMarkers } from "./build-benchmark-protocol.ts"

const MAX_RUN_MS = 15 * 60_000
const MAX_TOTAL_MS = 35 * 60_000
const REQUEST_MS = 12_000
const VERSION_PROBE_MS = 30_000
const BODY_LIMIT = 8 * 1024 * 1024
const EARLY_MARKER = "ACTION_EVIDENCE_EARLY_MARKER_V1"
const LATE_MARKER = "ACTION_EVIDENCE_LATE_MARKER_V1"
const PARENT_MARKER = "ACTION_EVIDENCE_HEADLESS_PARENT_V1"
const RESUME_MARKER = "ACTION_EVIDENCE_HEADLESS_RESUME_V1"
const SUMMARY_TEXT = "Local mechanical checkpoint. Await the driver continuation; inspect durable evidence through the assigned tools."
type Json = Record<string, any>

function sha(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex") }
function safeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error"
  const message = error instanceof Error ? error.message : String(error)
  // Receipts intentionally retain only bounded, non-secret diagnostics.
  return `${/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name) ? name : "Error"}: ${message.replace(/https?:\/\/[^\s"']+/g, "[url]").replace(/(?:token|key|secret|password|authorization)=?[^\s,;]+/gi, "[redacted]").slice(0, 500)}`
}
function privateError(error: unknown, secrets: readonly string[]): string {
  return secrets.reduce((message, secret) => secret.length >= 6 ? message.replaceAll(secret, "[redacted]") : message, safeError(error))
}
function collectSecretScalars(value: unknown, output: string[] = []): string[] {
  if (typeof value === "string") { if (value.length >= 6) output.push(value); return output }
  if (Array.isArray(value)) { for (const item of value) collectSecretScalars(item, output); return output }
  if (value && typeof value === "object") for (const item of Object.values(value as Json)) collectSecretScalars(item, output)
  return output
}
function rejectInlineCredentials(value: unknown): void {
  if (Array.isArray(value)) { for (const item of value) rejectInlineCredentials(item); return }
  if (!value || typeof value !== "object") return
  for (const [key, child] of Object.entries(value as Json)) {
    if (/api.?key|access.?token|refresh.?token|secret|password|credential|authorization/i.test(key)) throw new Error("provider config must keep credentials in the selected auth file")
    rejectInlineCredentials(child)
  }
}
function assertDeadline(deadline: number, maximumMs = REQUEST_MS): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error("diagnostic deadline exceeded")
  return Math.min(maximumMs, remaining)
}
function isolatedEnv(root: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key]
  for (const name of ["home", "config", "data", "cache", "state", "tmp"]) mkdirSync(join(root, name), { recursive: true })
  return Object.assign(env, {
    HOME: join(root, "home"), USERPROFILE: join(root, "home"), APPDATA: join(root, "home", "AppData", "Roaming"),
    LOCALAPPDATA: join(root, "home", "AppData", "Local"), XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"), TMPDIR: join(root, "tmp"),
    OPENCODE_CONFIG: join(root, "opencode.json"), OPENCODE_ALG_CONFIG: join(root, "alg-options.json"),
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_TELEMETRY: "1", DO_NOT_TRACK: "1", NO_COLOR: "1",
  })
}
function trackedSpawn(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, detached = false) {
  const child = spawn(exe, args, { cwd, env, detached, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "", stderr = "", exited = child.exitCode !== null
  child.stdout?.on("data", (b: Buffer) => { stdout = (stdout + b.toString("utf8")).slice(-16_384) })
  child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-16_384) })
  child.once("close", () => { exited = true }); child.once("error", () => { exited = true })
  return { child, stdout: () => stdout, stderr: () => stderr, exited: () => exited || child.exitCode !== null,
    exit: () => ({ observed: exited || child.exitCode !== null, code: child.exitCode, signal: child.signalCode }) }
}

/** Private parsed host data, redacted before truncation; never emitted to stdout or supplied to the checker. */
export function boundedPrivateHostEvidence(value: unknown, secrets: readonly string[], maximum = 512 * 1024) {
  const original = JSON.stringify(value)
  const redacted = redactEvolutionText(secrets.reduce((text, secret) => secret.length >= 6
    ? text.replaceAll(secret, "[REDACTED]").replaceAll(JSON.stringify(secret).slice(1, -1), "[REDACTED]") : text, original))
  const bytes = Buffer.from(redacted)
  let end = Math.min(bytes.length, maximum)
  while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--
  return { source_bytes: Buffer.byteLength(original), redacted: redacted !== original, truncated: end < bytes.length,
    retained_bytes: end, retained_sha256: sha(bytes.subarray(0, end)), json_text: bytes.subarray(0, end).toString("utf8") }
}

export function versionProbeDiagnostic(evidence: VersionCommandEvidence, elapsedMs: number) {
  return { timeout_ms: evidence.timeout_ms, elapsed_ms: elapsedMs, exit_code: evidence.exit_code, exit_signal: evidence.exit_signal,
    exit_observed: evidence.exit_observed, cleanup_passed: evidence.cleanup.passed,
    error_category: evidence.timed_out ? "timeout" : evidence.root_pid === null ? "spawn_failure" : !evidence.cleanup.passed ? "cleanup_failure" :
      !evidence.exit_observed ? "exit_unobserved" : evidence.exit_signal ? "signal" : evidence.exit_code !== 0 ? "nonzero_exit" :
        !evidence.passed ? "probe_error" : null }
}

export function hostCleanupStatus(processes: readonly { pid: number | null; exited: boolean }[]) {
  const starts = processes.filter(row => row.pid !== null).length
  return { starts, spawn_attempts: processes.length, host_stopped: starts === 0 ? null : processes.every(row => row.exited),
    host_cleanup_required: starts > 0, host_cleanup_passed: processes.every(row => row.exited) }
}

export function persistDiagnosticOutcome(base: Json, outputPath: string, tempRoot: string): Json {
  mkdirSync(dirname(outputPath), { recursive: true })
  const checkpointPath = `${outputPath}.before-cleanup.json`
  if (existsSync(outputPath) || existsSync(checkpointPath)) throw new Error("refusing to overwrite an existing case receipt")
  const provisional = { ...base, passed: false, evaluation_passed: base.passed,
    cleanup: { ...base.cleanup, temporary_environment_removed: false, retained_failure_workspace: tempRoot } }
  // Publish observations before any removal; refuse reuse of an issued case's receipt.
  writeFileSync(checkpointPath, `${JSON.stringify(provisional, null, 2)}\n`, { flag: "wx", mode: 0o600 })
  let finalizationStage = "workspace_cleanup"
  try {
    if (base.passed === true) rmSync(tempRoot, { recursive: true, force: true })
    finalizationStage = "receipt_publication"
    const removed = !existsSync(tempRoot)
    const completed = { ...base, passed: base.passed === true && removed, cleanup: { ...base.cleanup,
      temporary_environment_removed: removed, retained_failure_workspace: removed ? null : tempRoot } }
    writeFileSync(outputPath, `${JSON.stringify(completed, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    return completed
  } catch (error) {
    // The immutable checkpoint retains every observation even if cleanup or publication fails.
    const code = (error as NodeJS.ErrnoException)?.code
    const removed = !existsSync(tempRoot)
    const failed = { ...provisional, cleanup: { ...provisional.cleanup, temporary_environment_removed: removed,
      retained_failure_workspace: removed ? null : tempRoot }, retained_receipt: checkpointPath,
      finalization_failure: { stage: finalizationStage, code: typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? code : "UNKNOWN" } }
    try { writeFileSync(outputPath, `${JSON.stringify(failed, null, 2)}\n`, { flag: "wx", mode: 0o600 }) } catch { /* immutable checkpoint remains */ }
    return failed
  }
}
async function stopProcess(processInfo: ReturnType<typeof trackedSpawn>): Promise<boolean> {
  if (!processInfo.exited()) {
    try { processInfo.child.kill("SIGTERM") } catch { /* cleanup continues */ }
    const until = Date.now() + 1_500
    while (!processInfo.exited() && Date.now() < until) await delay(30)
    if (!processInfo.exited()) { try { processInfo.child.kill("SIGKILL") } catch { /* cleanup continues */ } }
  }
  const until = Date.now() + 1_000
  while (!processInfo.exited() && Date.now() < until) await delay(30)
  return processInfo.exited()
}
async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => ok()) })
  const port = (server.address() as { port: number }).port
  await new Promise<void>((ok, no) => server.close(error => error ? no(error) : ok()))
  return port
}
function latestUser(messages: any[]): string {
  const message = [...messages].reverse().find(row => row?.role === "user")
  if (typeof message?.content === "string") return message.content
  return Array.isArray(message?.content) ? message.content.map((part: any) => part?.text ?? "").join("\n") : ""
}
function advertisedTools(body: any): any[] { return Array.isArray(body?.tools) ? body.tools.map((row: any) => row?.function ?? row) : [] }
function calledTools(messages: any[]): Array<{ name: string; args: Json }> {
  const found: Array<{ name: string; args: Json }> = []
  for (const message of messages) for (const call of message?.tool_calls ?? []) {
    const fn = call?.function
    if (typeof fn?.name !== "string") continue
    let args: Json = {}
    try { const parsed = JSON.parse(fn.arguments ?? "{}"); if (parsed && typeof parsed === "object") args = parsed } catch { /* provider will not trust malformed history */ }
    found.push({ name: fn.name, args })
  }
  return found
}
function toolResultRows(messages: any[]): unknown[] {
  const rows = messages.filter((message: any) => message?.role === "tool" || message?.tool_call_id)
  return rows.map((row: any) => row.content ?? row.output ?? row.result ?? null)
}
function parseJsonDeep(value: unknown): any[] {
  const out: any[] = []
  const visit = (candidate: unknown, depth: number) => {
    if (depth > 5 || candidate == null) return
    if (typeof candidate === "string") {
      try { visit(JSON.parse(candidate), depth + 1) } catch { /* text fragment */ }
    } else if (Array.isArray(candidate)) for (const item of candidate) visit(item, depth + 1)
    else if (typeof candidate === "object") { out.push(candidate); for (const item of Object.values(candidate as Json)) visit(item, depth + 1) }
  }
  visit(value, 0); return out
}
function toolChoice(body: any, name: string, args: Json): { name: string; args: Json } {
  const tool = advertisedTools(body).find(row => row.name === name)
  if (!tool) throw new Error(`provider did not receive required live tool ${name}`)
  const properties = tool.parameters?.properties ?? tool.inputSchema?.properties ?? {}
  const normalized: Json = { ...args }
  for (const key of tool.parameters?.required ?? tool.inputSchema?.required ?? []) if (!(key in normalized)) {
    if (key === "command") normalized[key] = "node -e \"console.log('ACTION_EVIDENCE_LATE_MARKER_V1')\""
    else if (key === "evidence") normalized[key] = "index"
    else if (properties[key]?.type === "boolean") normalized[key] = false
    else normalized[key] = "headless acceptance"
  }
  return { name, args: normalized }
}
function providerResponse(response: ServerResponse, body: any, choice: { text?: string; tool?: { name: string; args: Json } }): string {
  const model = String(body?.model ?? "local-deterministic"), id = `action-evidence-${randomUUID()}`
  const message = choice.tool
    ? { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: choice.tool.name, arguments: JSON.stringify(choice.tool.args) } }] }
    : { role: "assistant", content: choice.text ?? "Completed." }
  if (body?.stream === true) {
    const created = 1, delta = choice.tool
      ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: choice.tool.name, arguments: JSON.stringify(choice.tool.args) } }] }
      : { role: "assistant", content: choice.text ?? "Completed." }
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "close" })
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: choice.tool ? "tool_calls" : "stop" }] })}\n\n`)
    response.end("data: [DONE]\n\n")
    return id
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, object: "chat.completion", created: 1, model,
    choices: [{ index: 0, message, finish_reason: choice.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
  return id
}
interface ProviderCall { role: "parent" | "implementer" | "checker" | "summary" | "compaction_followup" | "unknown"; tool_names: string[]; calls: string[]; call_count: number }
interface ProviderError { role: ProviderCall["role"]; code: string; message: string }
interface ProviderEmission { role: ProviderCall["role"]; tool: string; call_id: string; run_id: string | null; max_waves: number | null }
function createProvider(caseId: CaseId) {
  const requests: ProviderCall[] = []
  const errors: ProviderError[] = []
  const emissions: ProviderEmission[] = []
  let nonLoopbackRequests = 0
  let forceSummary = false, compacting = false
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(request.socket.remoteAddress ?? "")) { nonLoopbackRequests++; response.writeHead(403).end(); return }
    if (request.method === "GET" && /\/models$/.test(request.url ?? "")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "deterministic" }] })); return
    }
    if (request.method !== "POST" || !/\/chat\/completions$/.test(request.url ?? "")) { response.writeHead(404).end(); return }
    const chunks: Buffer[] = []; let size = 0
    let activeRole: ProviderCall["role"] = "unknown"
    request.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > BODY_LIMIT) { response.writeHead(413).end(); request.destroy(); return } chunks.push(Buffer.from(chunk)) })
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks, size).toString("utf8")), messages = Array.isArray(body.messages) ? body.messages : []
        const prompt = latestUser(messages), tools = advertisedTools(body), names = tools.map(row => String(row.name ?? ""))
        const calls = calledTools(messages), parent = prompt.includes(PARENT_MARKER) || prompt.includes(RESUME_MARKER)
        const role: ProviderCall["role"] = forceSummary ? "summary" : compacting ? "compaction_followup" : parent ? "parent" :
          /^You are the \"implementer\" node/m.test(prompt) ? "implementer" : /^You are a checker in a fresh child session\./m.test(prompt) ? "checker" : "unknown"
        forceSummary = false
        activeRole = role
        const receipt: ProviderCall = { role, tool_names: names.slice(0, 48), calls: calls.map(row => row.name).slice(-24), call_count: calls.length }
        requests.push(receipt)
        let choice: { text?: string; tool?: { name: string; args: Json } }
        if (role === "summary") choice = { text: SUMMARY_TEXT }
        else if (role === "compaction_followup") choice = { text: "Awaiting the explicit driver continuation." }
        else if (role === "parent") {
          // Only this user turn decides whether to dispatch. Pre-compaction calls remain in history.
          const currentTurn = messages.slice(messages.map((message: any) => message?.role).lastIndexOf("user"))
          const tool = prompt.includes(RESUME_MARKER) ? "alg_resume" : "alg_run"
          if (!calledTools(currentTurn).some(call => call.name === tool)) choice = { tool: toolChoice(body, tool, { run_id: RUN_ID, max_waves: tool === "alg_resume" ? 2 : 1 }) }
          else choice = { text: "The requested deterministic ALG wave finished." }
        } else if (role === "implementer") {
          const bashCalls = calls.filter(call => call.name === "bash")
          if (bashCalls.length < 10) {
            const command = bashCalls.length === 0
              ? firstCommand(caseId)
              : `node -e "console.log('${LATE_MARKER}_${String(bashCalls.length).padStart(2, "0")}')"`
            choice = { tool: toolChoice(body, "bash", { command, description: bashCalls.length === 0 ? "Long harmless early marker command" : `Harmless later marker ${bashCalls.length}` }) }
          } else choice = { text: JSON.stringify({ summary: ["Executed ten harmless deterministic node commands."], files_touched: [],
            commands_run: [], risks: [], done: true }) }
        } else if (role === "checker") {
          throw new Error("checker request reached deterministic fixture provider; refusing to simulate a real checker")
        } else throw new Error("provider could not classify the OpenCode request from its live prompt")
        if (choice.tool && emissions.length >= 64) throw new Error("provider tool emission bound exceeded")
        const callId = providerResponse(response, body, choice)
        if (choice.tool) emissions.push({ role, tool: choice.tool.name, call_id: callId,
          run_id: typeof choice.tool.args.run_id === "string" ? choice.tool.args.run_id : null,
          max_waves: typeof choice.tool.args.max_waves === "number" ? choice.tool.args.max_waves : null })
      } catch (error) {
        const message = safeError(error)
        const code = /omitted first intent/.test(message) ? "index_missing_first_intent" :
          /omitted first terminal/.test(message) ? "index_missing_first_terminal" :
            /both actual evidence page citations/.test(message) ? "checker_citations_missing" :
              /required live tool/.test(message) ? "advertised_tool_missing" : "provider_handler_error"
        errors.push({ role: activeRole, code, message })
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: safeError(error) } }))
      }
    })
  })
  return { server, requests, errors, emissions, get nonLoopbackRequests() { return nonLoopbackRequests },
    summaryNext: () => { forceSummary = true; compacting = true },
    resumeNext: () => { forceSummary = false; compacting = false },
    listen: () => new Promise<string>((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as any).port}/v1`)) }),
    close: () => !server.listening ? Promise.resolve() : new Promise<void>((ok, no) => {
      server.close(error => error ? no(error) : ok())
      server.closeAllConnections()
    }) }
}

const OWNER_TITLE = "ALG real-checker action evidence diagnostic parent"
const RUN_ID = "action-evidence-live-regression"
const GOAL = "Execute a fixed harmless command sequence and verify its persisted host evidence."
const FIXTURE_VERSION = "action-evidence-live-v5"
const REPAIR_ALLOWANCE = "v5-schema-or-validated-evidence-unavailable"
const RETRIEVAL_RECIPE = "one index first; complete original intent and terminal pages in either order; optional one canonical manifest first page (possibly partial); at most 4 tools, 3 registered pages and 3 citations; no duplicate reads or citations"
const CRITERION = "The first recorded bash call within the producer attempt has its captured command retained exactly, and its linked host terminal explicitly reports exit code zero."
const LOCAL_PROVIDER = "action-evidence-fixture"
type CaseId = "correct" | "defective"
const CASES: readonly CaseId[] = ["correct", "defective"]

export interface LiveActionEvidenceGradeInput {
  case_id: CaseId
  run: any
  producer: Json
  checker_histories: readonly CheckerAttemptHistory[]
  compaction_completed_at: number
}
export interface CheckerAttemptHistory { attempt: number; session_id: string; messages: readonly any[] }

export function checkerAttemptSnapshot(attempt: unknown, history: readonly any[], secrets: readonly string[] = []) {
  // Invalid JSON is absent from durable attempt.output; retain its original host text as well.
  return boundedPrivateHostEvidence({ attempt, native_history: history }, secrets)
}

/** Evaluator-only source commitments; none of these IDs or recipe rules enter the checker prompt. */
function checkerRetrievalReceipt(runId: string, producer: Json, manifest: any, attempt: any, history: readonly any[]): Json {
  const references = [producer.first_records?.intent, producer.first_records?.terminal, manifest]
  const expected = [producer.canonical_pages?.intent, producer.canonical_pages?.terminal, producer.canonical_pages?.manifest]
  const oracleValid = new Set(references.map(ref => ref?.sha256)).size === 3 && expected.every((page, index) =>
    page && references[index] && isDeepStrictEqual(page.reference, references[index]) && page.offset === 0 &&
    page.length > 0 && page.length <= 8_192 && page.total_bytes === references[index].byte_size &&
    (index === 2 || page.length === page.total_bytes))
  const receipts: any[] = Array.isArray(attempt?.retrieved_evidence) ? attempt.retrieved_evidence : []
  const tools = hostTools(history), indexes = tools.filter(tool => tool.tool === "alg_artifact" && tool.state?.input?.evidence === "index")
  const reads = tools.filter(tool => tool.tool === "alg_artifact" && tool.state?.input?.evidence === "read")
  const findings = attempt?.output?.findings, finding = Array.isArray(findings) && findings.length === 1 ? findings[0] : undefined
  const citations: any[] = Array.isArray(finding?.evidence_ids) ? finding.evidence_ids : []
  const matchesTool = (receipt: any, tool: any) => tool.state?.status === "completed" &&
    tool.state?.input?.record_id === receipt.reference?.sha256 && tool.state?.input?.offset === 0 &&
    parseJsonDeep(tool.state?.output).some(value => {
      if (value.citation_id !== receipt.id || !isDeepStrictEqual(value.receipt, receipt) || typeof value.content !== "string") return false
      try { return isDeepStrictEqual(retrievedVerificationEvidence(receipt.reference, 0, value.content), receipt) } catch { return false }
    })
  const verified = receipts.filter(receipt => oracleValid && expected.some(page => isDeepStrictEqual(page, receipt)) &&
    reads.some(tool => matchesTool(receipt, tool)))
  const wrongSource = receipts.some(receipt => !references.some(ref => ref && isDeepStrictEqual(ref, receipt?.reference))) ||
    reads.some(tool => !references.some(ref => ref && ref.sha256 === tool.state?.input?.record_id)) ||
    [...indexes, ...reads].some(tool => tool.state?.input?.run_id !== undefined && tool.state.input.run_id !== runId)
  const missingOriginal = references.slice(0, 2).some(ref => !ref ||
    !reads.some(tool => tool.state?.input?.record_id === ref.sha256) || !receipts.some(receipt => receipt?.reference?.sha256 === ref.sha256))
  const retrievedOriginals = oracleValid && expected.slice(0, 2).every(page => verified.some(receipt => isDeepStrictEqual(page, receipt)))
  const pagesBound = oracleValid && verified.length === receipts.length && reads.every(tool => verified.some(receipt => matchesTool(receipt, tool)))
  const missingCitations = expected.slice(0, 2).some(page => !page || !citations.includes(page.id))
  const invalidCitations = citations.some(id => typeof id !== "string" || !verified.some(receipt => receipt.id === id))
  const citationsBound = !missingCitations && !invalidCitations
  const recipeIssues = [tools.length > 4 && "tool_limit", reads.length > 3 && "read_limit", receipts.length > 3 && "registered_page_limit",
    citations.length > 3 && "citation_limit", indexes.length !== 1 && "index_count", tools[0] !== indexes[0] && "index_first",
    tools.length !== indexes.length + reads.length && "unexpected_tool",
    tools.some(tool => tool.state?.status !== "completed") && "incomplete_tool",
    reads.some(tool => tool.state?.input?.offset !== 0) && "first_page_only",
    indexes.some(tool => tool.state?.input?.offset !== undefined && tool.state.input.offset !== 0) && "index_offset",
    new Set(reads.map(tool => tool.state?.input?.record_id)).size !== reads.length && "duplicate_read",
    new Set(receipts.map(receipt => receipt?.id)).size !== receipts.length && "duplicate_registered_page",
    new Set(citations).size !== citations.length && "duplicate_citation"].filter(Boolean)
  const manifestRead = !!manifest && reads.some(tool => tool.state?.input?.record_id === manifest.sha256)
  return { passed: retrievedOriginals && pagesBound && citationsBound && !wrongSource && recipeIssues.length === 0,
    retrieved_both_original_pages: retrievedOriginals, citations_bound_to_original_pages: citationsBound,
    canonical_registered_native_reads: pagesBound, wrong_source: wrongSource, missing_original_pages: missingOriginal,
    missing_original_citations: missingCitations, invalid_citation_binding: invalidCitations,
    recipe_valid: recipeIssues.length === 0, recipe_violations: recipeIssues, retrieval_recipe: RETRIEVAL_RECIPE,
    manifest_read: manifestRead, manifest_cited: !!expected[2] && citations.includes(expected[2].id),
    manifest_page_partial: manifestRead && !!expected[2] && expected[2].length < expected[2].total_bytes,
    page_count: receipts.length, tool_call_count: tools.length, receipt_ids: receipts.map(receipt => receipt.id), pages: receipts,
    finding_citation_ids: citations,
    failure_reasons: [!oracleValid && "evaluator canonical source-page commitments are missing or invalid",
      recipeIssues.length > 0 && `retrieval recipe limit or ordering violation: ${recipeIssues.join(", ")}`,
      wrongSource && "read or receipt references a source outside the original intent, terminal and assigned manifest",
      missingOriginal && "required original intent or terminal read/registration is missing",
      !pagesBound && !wrongSource && "page bytes or receipts do not match canonical registered evidence and actual native reads",
      missingCitations && "required original intent or terminal citation is missing",
      invalidCitations && "citation is unregistered, forged or not bound to a canonical native read in the final attempt"].filter(Boolean) }
}

/** Deterministic host-side oracle. It validates provenance and model verdict; it never feeds the oracle to the checker. */
export function gradeLiveActionEvidenceCase(input: LiveActionEvidenceGradeInput): Json {
  const expectedPass = input.case_id === "correct"
  const evidence = input.producer
  const attempt = input.run?.nodes?.work?.attempts?.[0]
  const checker = input.run?.nodes?.check
  const attempts: any[] = Array.isArray(checker?.attempts) ? checker.attempts : []
  const finalAttempt = attempts.at(-1), output = finalAttempt?.output
  const histories = input.checker_histories
  const finalHistory = histories.at(-1)?.messages ?? []
  const countBound = attempts.length >= 1 && attempts.length <= 2 && checker?.current_attempt === attempts.length &&
    input.run?.global_attempts === 1 + attempts.length && attempts.every((row, index) => row.attempt === index + 1)
  const sessionIds = attempts.map(row => row.session_id)
  const freshSessions = sessionIds.every(id => typeof id === "string" && id.length > 0 && id !== attempt?.session_id && id !== input.run?.owner_session_id) &&
    new Set(sessionIds).size === attempts.length
  const historiesBound = histories.length === attempts.length && histories.length > 0 && histories.every((entry, index) => {
    const native = entry.messages, session = attempts[index]?.session_id
    return entry.attempt === attempts[index]?.attempt && entry.session_id === session && native.length > 0 &&
      native.every(message => typeof message?.info?.id === "string" && message.info.sessionID === session &&
        Array.isArray(message.parts) && message.parts.every((part: any) => typeof part.id === "string" &&
          part.sessionID === session && part.messageID === message.info.id)) &&
      new Set(native.map(message => message.info.id)).size === native.length &&
      new Set(native.flatMap(message => message.parts.map((part: any) => part.id))).size === native.flatMap(message => message.parts).length
  })
  const afterCompaction = Number.isFinite(input.compaction_completed_at) && attempts.every((row, index) => {
    const start = Date.parse(row.started_at), end = Date.parse(row.finished_at)
    return start >= input.compaction_completed_at && end >= start && (index === 0 || start >= Date.parse(attempts[index - 1].finished_at))
  })
  const nativeOutputMatches = (row: any, index: number): boolean => {
    const assistant = histories[index]?.messages.filter(message => message?.info?.role === "assistant").at(-1)
    const text = (assistant?.parts ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
    return !!row.output && !assistant?.info?.error && isDeepStrictEqual(extractJsonDetailed(text, "checker").value, row.output)
  }
  const submissionJson = JSON.stringify(attempt?.output)
  const expectedSources = { version: 1, journals: [{ run_id: input.run?.run_id, node_id: "work", attempt: 1,
    child_session_id: attempt?.session_id, reference: attempt?.action_evidence_ref }], omitted: 0, unavailable: 0 }
  const sameAssignment = isDeepStrictEqual(input.run?.criteria, [CRITERION]) && typeof submissionJson === "string" &&
    input.run?.graph?.nodes?.find((node: any) => node.id === "check")?.inputs?.claimed === "work" && attempts.length > 0 && attempts.every(row => {
      const basis = VerificationBasisSchema.safeParse(row.verification_basis), sources = EvidenceSourcesSchema.safeParse(row.action_evidence_sources)
      if (!basis.success || !sources.success || !isDeepStrictEqual(sources.data, expectedSources) ||
        !isDeepStrictEqual(row.verification_basis, attempts[0].verification_basis) ||
        basis.data.criteria_sha256 !== criteriaDigest([CRITERION]) || !isDeepStrictEqual(basis.data.criterion_ids, ["C1"])) return false
      // Host metadata pins the wired claim without granting another E citation or duplicating its content.
      return isDeepStrictEqual(basis.data.claimed_submission, { run_id: input.run.run_id, node_id: "work", reference: "work", attempt: 1,
        json_sha256: sha(submissionJson), json_bytes: Buffer.byteLength(submissionJson) })
    })
  const priorCategories = attempts.slice(0, -1).map((row, index) => {
    if (row.status !== "failed" || row.error || row.shell_ok === false || row.shell_setup_failed === true ||
      !Array.isArray(row.failures) || row.failures.length === 0) return "ineligible"
    if (row.outcome === "schema_invalid" && row.schema_ok === false && row.output === undefined) return "schema_invalid"
    const basis = VerificationBasisSchema.safeParse(row.verification_basis)
    if (row.outcome === "evidence_unavailable" && row.schema_ok === true && parseAndValidate("checker", row.output).ok &&
      basis.success && validateVerification(row.output, basis.data, row.retrieved_evidence ?? []).length === 0 &&
      classifyVerificationEvidenceGap(row.output) && nativeOutputMatches(row, index)) return "evidence_unavailable"
    return "ineligible"
  })
  const priorRepairOnly = priorCategories.every(category => category !== "ineligible")
  const graphNodes = input.run?.graph?.nodes ?? []
  const noFeedback = graphNodes.length === 2 && graphNodes.every((node: any) => node.feedback_to === undefined) &&
    attempts.every(row => row.feedback_applied !== true) && attempt?.feedback_applied !== true
  const allowanceExact = input.run?.graph?.max_global_attempts === 3 && input.run?.graph?.max_concurrency === 1 &&
    graphNodes.find((node: any) => node.id === "work")?.loop?.max_attempts === 1 &&
    graphNodes.find((node: any) => node.id === "check")?.loop?.max_attempts === 2
  const terminalStatus = expectedPass ? "done" : "failed"
  const finalTerminal = finalAttempt?.schema_ok === true && finalAttempt.status === terminalStatus &&
    finalAttempt.outcome === (expectedPass ? "passed" : "substantive_rejection") && checker?.status === terminalStatus &&
    input.run?.status === terminalStatus && input.run?.phase === terminalStatus && !finalAttempt.error && parseAndValidate("checker", output).ok
  const finalOutputBound = !!finalAttempt && nativeOutputMatches(finalAttempt, attempts.length - 1)
  const findings = output?.findings
  const finding = Array.isArray(findings) && findings.length === 1 ? findings[0] : undefined
  const receipts: any[] = Array.isArray(finalAttempt?.retrieved_evidence) ? finalAttempt.retrieved_evidence : []
  const retrieval = checkerRetrievalReceipt(input.run?.run_id, evidence, attempt?.action_evidence_ref, finalAttempt, finalHistory)
  const configuredCheckerObserved = typeof evidence?.checker_provider_id === "string" &&
    typeof evidence?.checker_model_id === "string" && histories.length > 0 && histories.every(entry => {
      const assistants = entry.messages.filter(message => message?.info?.role === "assistant")
      return assistants.length > 0 && assistants.every(message => message.info.providerID === evidence.checker_provider_id &&
        message.info.modelID === evidence.checker_model_id)
    })
  const producerActions = input.run?.nodes?.work?.attempts?.flatMap((row: any) => row?.action_evidence_ref ? [row.action_evidence_ref.sha256] : []) ?? []
  const passedEvidence = typeof evidence?.first_terminal?.exit_code === "number" && evidence.first_terminal.exit_code === 0
  const defectiveEvidence = typeof evidence?.first_terminal?.exit_code === "number" && evidence.first_terminal.exit_code !== 0
  const exactActionCardinality = evidence?.observed_calls === 10 && evidence?.completed === 10 && evidence?.unknown_terminal === 0 &&
    attempt?.action_evidence_ref?.sha256 === evidence?.manifest_sha256 && producerActions.length === 1 &&
    input.run?.nodes?.work?.current_attempt === 1 && input.run?.nodes?.work?.attempts?.length === 1 &&
    input.run?.nodes?.work?.status === "done" && attempt?.attempt === 1 && attempt?.status === "done" && attempt?.schema_ok === true
  const assessment = MechanicalAssessmentSchema.safeParse(finding?.mechanical_assessment)
  const typedAssessmentUsed = finding?.criterion_id === "C1" && assessment.success &&
    assessment.data.intent_id === receipts.find(row => row.reference?.sha256 === evidence?.first_records?.intent?.sha256)?.id &&
    assessment.data.terminal_id === receipts.find(row => row.reference?.sha256 === evidence?.first_records?.terminal?.sha256)?.id &&
    typeof assessment.data.intent_id === "string" && typeof assessment.data.terminal_id === "string"
  // Evaluator-only C1 mapping: captured order, retention, linkage and reported exit; not command correctness.
  const mechanicalC1Covered = typedAssessmentUsed && assessment.success && assessment.data.predicates.length === 4 &&
    ["first_recorded_bash", "complete_command", "linked_pair", "exit_equals"].every(kind =>
      assessment.data.predicates.some(predicate => predicate.kind === kind)) &&
    assessment.data.predicates.some(predicate => predicate.kind === "exit_equals" && predicate.expected === 0)
  const outcomeValid = expectedPass ? finding?.outcome === "supported" : finding?.outcome === "disconfirmed"
  const expectedVerdict = expectedPass
  const verdictAvailable = finalAttempt?.schema_ok === true && parseAndValidate("checker", output).ok && finding?.criterion_id === "C1"
  const verdictCorrect = verdictAvailable ? output.passed === expectedVerdict && outcomeValid : null
  const noReplay = exactActionCardinality && freshSessions && noFeedback
  const repairValid = countBound && allowanceExact && priorRepairOnly && afterCompaction && sameAssignment
  const passed = exactActionCardinality && retrieval.passed && verdictCorrect === true && (expectedPass ? passedEvidence : defectiveEvidence) &&
    noReplay && configuredCheckerObserved && repairValid && historiesBound && finalTerminal && finalOutputBound && mechanicalC1Covered
  return { passed, case_id: input.case_id, expected_verdict: expectedVerdict ? "pass" : "reject", observed_verdict: output?.passed === true ? "pass" : output?.passed === false ? "reject" : "missing",
    exact_action_cardinality: exactActionCardinality, retrieved_both_original_pages: retrieval.retrieved_both_original_pages,
    citations_bound_to_original_pages: retrieval.citations_bound_to_original_pages, retrieval,
    verdict_validity: verdictAvailable ? "available" : "unavailable", verdict_correct: verdictCorrect,
    no_producer_replay: noReplay, configured_real_checker_observed: configuredCheckerObserved,
    checker_attempt_count: attempts.length, final_attempt: finalAttempt?.attempt ?? null,
    repair_allowance: REPAIR_ALLOWANCE, bounded_checker_repair_only: repairValid,
    first_attempt_category: attempts[0]?.outcome ?? null, first_attempt_repair_category: priorCategories[0] ?? "not_used",
    prior_attempts_eligible: priorRepairOnly, prior_attempts_schema_invalid: priorCategories.every(category => category === "schema_invalid"),
    same_criteria_submission_and_sources: sameAssignment, native_histories_bound: historiesBound,
    final_attempt_outcome: finalAttempt?.outcome ?? null,
    all_attempts_after_compaction: afterCompaction, final_schema_and_terminal_valid: finalTerminal, final_output_matches_native_response: finalOutputBound,
    typed_assessment_used: typedAssessmentUsed, mechanical_assessment_covers_c1: mechanicalC1Covered,
    final_mechanical_assessment: finding?.mechanical_assessment ?? null,
    no_feedback_route: noFeedback, retrieval_recipe: RETRIEVAL_RECIPE,
    evidence_consistent_with_case: expectedPass ? passedEvidence : defectiveEvidence,
    failure_reasons: [!exactActionCardinality && "producer action count or immutable manifest identity was not exact",
      ...retrieval.failure_reasons,
      verdictCorrect === false && "checker verdict did not match the case contract",
      !(expectedPass ? passedEvidence : defectiveEvidence) && "recorded original action result did not match the declared case",
      !noReplay && "producer replay, reused child session or substantive-feedback route was observed",
      !repairValid && "checker attempts were outside the bounded schema/evidence-unavailable repair allowance or changed assignment",
      !sameAssignment && "checker criteria, submission pin or original source manifests were missing, changed or misbound",
      !historiesBound && "a checker attempt's native history was missing, foreign or misbound",
      !finalTerminal && "final checker attempt was missing, invalid, exhausted or not in the required terminal state",
      !finalOutputBound && "final validated output did not match the final native assistant response",
      !typedAssessmentUsed && "final C1 did not use a typed mechanical assessment bound to both original pages",
      !mechanicalC1Covered && "final C1 mechanical assessment did not contain exactly its four published predicates and expected exit zero",
      !configuredCheckerObserved && "checker session did not report the separately configured provider/model identity"].filter(Boolean) }
}

function writeConfig(path: string, endpoint: string, pluginSpec: string, providerID: string, modelID: string, providerConfig: Json): void {
  const configuredProviders: Json = { [providerID]: structuredClone(providerConfig[providerID]) }
  configuredProviders[providerID] ??= {}
  const configured = configuredProviders[providerID]
  if (!configured.models || typeof configured.models !== "object" || !(modelID in configured.models))
    throw new Error("provider config must define the selected model under the configured providerID")
  configured.models[modelID] = { ...configured.models[modelID], limit: { ...(configured.models[modelID].limit ?? {}), output: 8_192 } }
  const localModel = `${LOCAL_PROVIDER}/deterministic`
  const config = { $schema: "https://opencode.ai/config.json", plugin: [pluginSpec], model: localModel,
    small_model: localModel, autoupdate: false,
    provider: { ...configuredProviders, [LOCAL_PROVIDER]: { npm: "@ai-sdk/openai-compatible", name: "Local deterministic producer fixture",
      options: { baseURL: endpoint }, models: { deterministic: { name: "Deterministic fixture", limit: { context: 32_768, output: 2_048 } } } } },
    agent: { orchestrator: { mode: "primary", model: localModel, steps: 8 }, implementer: { model: localModel },
      checker: { model: `${providerID}/${modelID}`, steps: 6, permission: { "*": "deny", alg_artifact: "allow" } } },
    permission: { "*": "allow", external_directory: "deny", webfetch: "deny", websearch: "deny", question: "deny" },
    mcp: {}, compaction: { auto: false, prune: false } }
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx", mode: 0o600 })
}
async function readJson(response: Response, maximum = BODY_LIMIT): Promise<any> {
  const raw = await response.text()
  if (Buffer.byteLength(raw) > maximum) throw new Error("OpenCode API response exceeded the bounded response size")
  if (!response.ok) throw new Error(`OpenCode API returned HTTP ${response.status}`)
  return raw ? JSON.parse(raw) : null
}
async function api(base: string, project: string, path: string, method = "GET", body?: unknown, deadline = Date.now() + REQUEST_MS,
  requestTimeoutMs = REQUEST_MS): Promise<any> {
  const url = new URL(path, base); url.searchParams.set("directory", project)
  return readJson(await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(assertDeadline(deadline, requestTimeoutMs)) }))
}
async function startHost(executable: string, project: string, env: NodeJS.ProcessEnv, deadline: number,
  onSpawn: (processInfo: ReturnType<typeof trackedSpawn>) => void) {
  const port = await freePort(), processInfo = trackedSpawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], project, env)
  onSpawn(processInfo)
  const base = `http://127.0.0.1:${port}`
  while (Date.now() < deadline) {
    if (processInfo.exited()) throw new Error("OpenCode exited before readiness")
    try { const health = await api(base, project, "/global/health", "GET", undefined, Math.min(deadline, Date.now() + 1_500)); if (health?.healthy === true || health?.status === "ok") return { base, processInfo } }
    catch { /* poll until the fixed deadline */ }
    await delay(100)
  }
  await stopProcess(processInfo)
  throw new Error("OpenCode did not become ready before the deadline")
}
function copyPluginSnapshot(tempRoot: string) {
  const checkout = verificationPluginConfiguration(), runtimeRoot = join(tempRoot, "runtime-plugin")
  mkdirSync(runtimeRoot, { recursive: true })
  for (const entry of checkout.source.manifest) {
    const rel = entry.path.split("/").join(sep), target = join(runtimeRoot, rel)
    mkdirSync(dirname(target), { recursive: true }); copyFileSync(join(checkout.source.root, rel), target)
  }
  symlinkSync(join(checkout.source.root, "node_modules"), join(runtimeRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  return verificationPluginConfiguration(runtimeRoot)
}
export function firstCommand(caseId: CaseId): string { return caseId === "correct"
  ? `node -e "/*${"x".repeat(3_200)}*/console.log('${EARLY_MARKER}')"`
  : `node -e "/*${"x".repeat(3_200)}*/console.log('${EARLY_MARKER}');process.exit(7)"` }
export function validateEvidence(project: string, run: any, caseId: CaseId): Json {
  const attempt = run.nodes?.work?.attempts?.[0], reference = attempt?.action_evidence_ref
  if (!reference) throw new Error("producer attempt has no persisted action_evidence_ref")
  const journal = new ActionEvidenceJournal(project)
  const identity = { run_id: run.run_id, node_id: "work", attempt: 1 }
  const manifest = journal.readManifest(reference, identity)
  const session = manifest.identity.child_session_id
  const records = manifest.entries.map((entry: any) => journal.readRecord(entry, { ...identity, child_session_id: session }))
  const intents = records.filter((row: any) => row.kind === "intent").sort((a: any, b: any) => a.ordinal - b.ordinal)
  const terminals = records.filter((row: any) => row.kind === "terminal").sort((a: any, b: any) => a.ordinal - b.ordinal)
  const firstIntent = intents.find((row: any) => row.ordinal === 1), firstTerminal = terminals.find((row: any) => row.ordinal === 1)
  const command = firstCommand(caseId)
  if (intents.length !== 10 || manifest.coverage.observed_calls !== 10 || terminals.length !== 10 || manifest.coverage.completed !== 10 || manifest.coverage.unknown_terminal !== 0)
    throw new Error("persisted manifest does not contain ten paired calls")
  if (firstIntent?.kind !== "intent" || firstIntent.command !== command || Buffer.byteLength(firstIntent.command, "utf8") <= 3_000) throw new Error("first long command was not retained byte-exactly")
  if (firstTerminal?.source !== "hook" && firstTerminal?.source !== "history") throw new Error("first terminal source is not a hook/history receipt")
  const exitMatchesCase = Number.isSafeInteger(firstTerminal?.exit_code) &&
    (caseId === "correct" ? firstTerminal?.exit_code === 0 : firstTerminal?.exit_code !== 0)
  if (firstTerminal?.kind !== "terminal" || firstTerminal.call_id_sha256 !== firstIntent.call_id_sha256 ||
    firstTerminal.intent_sha256 !== manifest.entries.find(entry => entry.kind === "intent" && entry.ordinal === 1)?.sha256 ||
    !(firstTerminal?.tool_status === "completed" || caseId === "defective" && firstTerminal?.tool_status === "error") ||
    firstTerminal?.exit_code_status !== "reported" || !exitMatchesCase || !String(firstTerminal?.output ?? "").includes(EARLY_MARKER))
    throw new Error("first terminal receipt does not contain the case's required reported zero/nonzero integer exit")
  const firstReferences = Object.fromEntries(["intent", "terminal"].map(kind => {
    const entry = manifest.entries.find(entry => entry.kind === kind && entry.ordinal === 1)!
    return [kind, { artifact_path: entry.artifact_path, sha256: entry.sha256, byte_size: entry.byte_size }]
  }))
  const canonicalPages = Object.fromEntries(Object.entries({ ...firstReferences, manifest: reference }).map(([kind, ref]) => {
    const page = evidencePage(project, run.run_id, ref, 0)
    if (kind !== "manifest" && page.next_offset !== null) throw new Error("fixed first record unexpectedly needs more than one evidence page")
    return [kind, page.receipt]
  }))
  return { manifest_sha256: reference.sha256, manifest_path: reference.artifact_path, child_session_id: session,
    // readManifest verified every referenced record's bytes before this commitment is computed.
    journal_sha256: sha(JSON.stringify({ manifest: reference, entries: manifest.entries })), first_records: firstReferences,
    canonical_pages: canonicalPages,
    observed_calls: manifest.coverage.observed_calls, completed: manifest.coverage.completed, unknown_terminal: manifest.coverage.unknown_terminal,
    first_command_bytes: Buffer.byteLength(firstIntent.command, "utf8"), first_command_sha256: sha(firstIntent.command),
    first_call_id_sha256: firstIntent.call_id_sha256, declared_node_exit_code: caseId === "correct" ? 0 : 7,
    first_terminal: { source: firstTerminal.source, tool_status: firstTerminal.tool_status, exit_code_status: firstTerminal.exit_code_status,
      exit_code: firstTerminal.exit_code, output_contains_early_marker: String(firstTerminal.output ?? "").includes(EARLY_MARKER) },
    late_commands: intents.slice(1).length }
}

/** Consistency between persisted native host rows and the journal; neither is an independent OS audit. */
export function crosscheckProducerHostHistory(history: readonly any[], producer: Json, caseId: CaseId): Json {
  const tools = hostTools(history), first = tools[0], state = first?.state
  const session = producer.child_session_id
  const callBound = typeof first?.callID === "string" && sha(first.callID) === producer.first_call_id_sha256
  const sessionBound = typeof session === "string" && tools.every(part => part.sessionID === session) &&
    history.every(message => message?.info?.sessionID === session && (message.parts ?? []).every((part: any) =>
      part.sessionID === session && part.messageID === message.info.id))
  const commandBound = state?.input?.command === firstCommand(caseId) &&
    sha(state.input.command) === producer.first_command_sha256
  const statusBound = ["completed", "error"].includes(state?.status) && state.status === producer.first_terminal?.tool_status
  const fields = ["exit_code", "exitCode", "exit"].filter(key => Object.hasOwn(state?.metadata ?? {}, key))
  const exits = fields.map(key => state.metadata[key])
  const exitReported = exits.length > 0 && exits.every(value => Number.isSafeInteger(value) && value === exits[0])
  const nativeExit = exitReported ? exits[0] as number : null
  const exitBound = exitReported && producer.first_terminal?.exit_code_status === "reported" &&
    nativeExit === producer.first_terminal.exit_code
  const exitMatchesCase = exitReported && (caseId === "correct" ? nativeExit === 0 : nativeExit !== 0)
  const actionCount = tools.length === 10 && tools.every(part => part.tool === "bash") &&
    new Set(tools.map(part => part.callID)).size === 10 && new Set(tools.map(part => part.id)).size === 10 &&
    tools.every(part => typeof part.id === "string" && typeof part.callID === "string")
  const markerObserved = typeof state?.output === "string" && state.output.includes(EARLY_MARKER)
  return { passed: actionCount && sessionBound && callBound && commandBound && statusBound && exitBound && exitMatchesCase && markerObserved,
    source: "OpenCode session message tool part", scope: "persisted host/journal consistency; no independent OS audit or exit-normalization cause claim",
    metadata_fields: fields.map(key => `state.metadata.${key}`), session_id: session, message_id: first?.messageID ?? null,
    part_id: first?.id ?? null, call_id_sha256: typeof first?.callID === "string" ? sha(first.callID) : null,
    declared_node_exit_code: caseId === "correct" ? 0 : 7, observed_native_host_exit_code: nativeExit,
    journal_exit_code: producer.first_terminal?.exit_code ?? null, action_count_exact: actionCount,
    session_binding_exact: sessionBound, call_binding_exact: callBound, command_binding_exact: commandBound,
    status_binding_exact: statusBound, exit_reported: exitReported, exit_matches_journal: exitBound,
    exit_matches_case: exitMatchesCase, marker_observed: markerObserved }
}

function loadEvidenceRun(project: string, runId: string) {
  const run = loadRun(project, runId)
  if (!run) throw new Error("owned run is missing")
  return hydrateRunFully(run)
}
function assertProducerBoundary(run: ReturnType<typeof loadEvidenceRun>): void {
  if (run.status !== "blocked" || run.phase !== "wave-limit" || run.global_attempts !== 1 ||
    run.nodes.work?.status !== "done" || run.nodes.work.current_attempt !== 1 || run.nodes.work.attempts.length !== 1 ||
    run.nodes.check?.current_attempt !== 0 || run.nodes.check.attempts.length !== 0)
    throw new Error("compaction boundary requires one completed producer attempt and no checker attempt")
}
async function sessionHistory(base: string, project: string, session: string, deadline: number): Promise<any[]> {
  const history = await api(base, project, `/session/${encodeURIComponent(session)}/message?limit=1000`, "GET", undefined, deadline)
  if (!Array.isArray(history) || history.length >= 1000) throw new Error("bounded host history unavailable or truncated")
  return history
}
function hostTools(history: readonly any[]): any[] {
  return history.flatMap(message => (message.parts ?? []).filter((part: any) => part?.type === "tool"))
}
export function parentDispatchReceipt(before: any[], compacted: any[], resumed: any[], emissions: ProviderEmission[],
  run: ReturnType<typeof loadEvidenceRun>): Json {
  // Incoming provider histories include native task cards. Only responses we emitted are model dispatches.
  const parentEmissions = emissions.filter(row => row.role === "parent")
  const emissionMatch = parentEmissions.length === 2 && parentEmissions[0]?.tool === "alg_run" &&
    parentEmissions[1]?.tool === "alg_resume" && new Set(parentEmissions.map(row => row.call_id)).size === 2 &&
    parentEmissions.every((row, index) => row.run_id === run.run_id && row.max_waves === (index === 0 ? 1 : 2))
  const stage = (history: any[], expectedCount: number) => {
    const parts = hostTools(history), actual = parts.filter(part => part.tool === "alg_run" || part.tool === "alg_resume")
    const matchedDispatches = actual.length === expectedCount && actual.every((part, index) => {
      const emitted = parentEmissions[index]
      return emitted && part.tool === emitted.tool && part.callID === emitted.call_id && part.state?.status === "completed" &&
        isDeepStrictEqual(part.state.input, { run_id: run.run_id, max_waves: emitted.max_waves })
    })
    const cards = parts.filter(part => part.tool === "task" && ["work", "check"].some(nodeId => {
      const node = run.nodes[nodeId]
      const dispatch = actual.find(row => row.tool === (nodeId === "work" ? "alg_run" : "alg_resume"))
      // Exact native projector identity, parent message and child binding; arbitrary task calls fail.
      return node?.attempts.some(attempt => (attempt.status === "done" || nodeId === "check" && attempt.status === "failed") && dispatch &&
        part.callID === `call_alg_${sha(`${run.run_id}\0${nodeId}\0${attempt.attempt}`).slice(0, 24)}` &&
        part.sessionID === run.owner_session_id && part.messageID === dispatch.messageID &&
        part.state?.status === (attempt.status === "done" ? "completed" : "error") &&
        isDeepStrictEqual(part.state.input, { description: attempt.attempt === 1 ? nodeId : `${nodeId} · attempt ${attempt.attempt}`,
          prompt: `ALG run ${run.run_id}, node ${nodeId}, attempt ${attempt.attempt}.`, subagent_type: node!.agent }) &&
        part.state.metadata?.sessionId === attempt.session_id && part.state.metadata?.parentSessionId === run.owner_session_id)
    }))
    const unknown = parts.length - actual.length - cards.length
    return { alg_run: actual.filter(part => part.tool === "alg_run").length,
      alg_resume: actual.filter(part => part.tool === "alg_resume").length, task_cards: cards.length,
      total_tool_parts: parts.length, unexpected_tool_parts: unknown,
      dispatches_match: matchedDispatches,
      passed: matchedDispatches && unknown === 0 && cards.length === (expectedCount === 1 ? 1 : 1 + (run.nodes.check?.attempts.length ?? 0)) &&
        new Set(cards.map(part => part.callID)).size === cards.length &&
        parts.every(part => typeof part.id === "string") && new Set(parts.map(part => part.id)).size === parts.length }
  }
  const beforeCompaction = stage(before, 1), afterCompaction = stage(compacted, 1), afterResume = stage(resumed, 2)
  const checkerCount = run.nodes.check?.attempts.length ?? 0
  const runCountsMatch = [1, 2].includes(checkerCount) && run.global_attempts === 1 + checkerCount && run.nodes.work?.current_attempt === 1 && run.nodes.work?.attempts.length === 1 &&
    run.nodes.work?.status === "done" && run.nodes.check?.current_attempt === checkerCount &&
    ["done", "failed"].includes(run.nodes.check?.status ?? "")
  return { passed: emissionMatch && runCountsMatch && beforeCompaction.passed && afterCompaction.passed && afterResume.passed,
    before_compaction: beforeCompaction, after_compaction: afterCompaction, after_resume: afterResume,
    emitted_parent_tool_calls: parentEmissions.length, emitted_alg_calls: parentEmissions.filter(row => row.tool === "alg_run" || row.tool === "alg_resume").length,
    provider_call_ids_match: emissionMatch && beforeCompaction.dispatches_match && afterCompaction.dispatches_match && afterResume.dispatches_match,
    global_attempts: run.global_attempts,
    producer_attempts: run.nodes.work?.current_attempt, checker_attempts: run.nodes.check?.current_attempt }
}
function validateCheckerRetrieval(run: ReturnType<typeof loadEvidenceRun>, producer: Json, history: readonly any[],
  attempt = run.nodes.check?.attempts.at(-1)): Json {
  return { ...checkerRetrievalReceipt(run.run_id, producer, run.nodes.work?.attempts[0]?.action_evidence_ref, attempt, history),
    checker_attempt_status: attempt?.status ?? null, checker_outcome: attempt?.outcome ?? null, checker_output: attempt?.output ?? null }
}

export interface ActionEvidenceLiveRegressionOptions {
  hostExecutable: string; outputPath: string; providerID: string; modelID: string; providerConfigPath: string; authFile?: string; caseId: CaseId; timeoutMs?: number
}
export async function runActionEvidenceLiveRegressionCase(options: ActionEvidenceLiveRegressionOptions): Promise<Json> {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0))
    throw new Error("timeoutMs must be positive and finite")
  const deadline = Date.now() + Math.min(MAX_RUN_MS, options.timeoutMs ?? MAX_RUN_MS)
  if (![options.hostExecutable, options.outputPath, options.providerConfigPath].every(isAbsolute)) throw new Error("--host, --provider-config, and --output must be absolute paths")
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(options.providerID) || !/^[A-Za-z0-9._-]{1,128}$/.test(options.modelID) || options.providerID === LOCAL_PROVIDER)
    throw new Error("providerID/modelID is invalid or conflicts with the local fixture provider")
  const executable = realpathSync.native(options.hostExecutable), outputPath = resolve(options.outputPath)
  if (!existsSync(executable)) throw new Error("OpenCode host executable does not exist")
  if (existsSync(outputPath)) throw new Error("receipt already exists; choose a new output path to preserve prior qualifications")
  const roots = realUserGlobalConfigRoots({ ...process.env }), hmacKey = randomBytes(32)
  const globalBefore = snapshotGlobalOpenCodeConfig(roots, hmacKey), sourceBefore = verificationPluginConfiguration().source.digest
  // Keep case labels out of checker-visible session/workspace metadata.
  const tempRoot = resolve(mkdtempSync(join(tmpdir(), "alg-action-evidence-live-"))), project = join(tempRoot, "project")
  mkdirSync(project, { recursive: true })
  const env = isolatedEnv(join(tempRoot, "isolated-env")), provider = createProvider(options.caseId)
  let providerConfig: Json = {}, authCopyPath: string | null = null, authSecrets: string[] = []
  let host: Awaited<ReturnType<typeof startHost>> | undefined, providerStopped = false, hostStopped = false
  const hostProcesses: ReturnType<typeof trackedSpawn>[] = []
  const privateHostEvidence: Json = {}
  let versionProbe: ReturnType<typeof versionProbeDiagnostic> | null = null
  let versionProcess: ReturnType<typeof trackedSpawn> | undefined
  const observeHistory = async (label: string, base: string, session: string, until = deadline) => {
    const rows = await sessionHistory(base, project, session, until)
    privateHostEvidence[label] = boundedPrivateHostEvidence(rows, authSecrets)
    return rows
  }
  const captureCheckers = async (run: ReturnType<typeof loadEvidenceRun>, label: string): Promise<CheckerAttemptHistory[]> => {
    const histories: CheckerAttemptHistory[] = []
    for (const attempt of run.nodes.check?.attempts ?? []) {
      const key = `${label}_${attempt.attempt}`
      // Keep metadata even if the host history fetch fails. No checker request is retried here.
      privateHostEvidence[key] = checkerAttemptSnapshot(attempt, [], authSecrets)
      try {
        if (!host || !attempt.session_id) throw new Error("checker native session unavailable")
        const messages = await sessionHistory(host.base, project, attempt.session_id, deadline)
        privateHostEvidence[key] = checkerAttemptSnapshot(attempt, messages, authSecrets)
        histories.push({ attempt: attempt.attempt, session_id: attempt.session_id, messages })
      } catch (error) {
        privateHostEvidence[key].history_error = privateError(error, authSecrets)
      }
    }
    return histories
  }
  let ownerSessionId = "", runId = "", terminalStatus = "unknown", restartVerified = false
  let evidence: Json | null = null, failure: string | null = null, failureRun: Json | null = null
  let compaction: Json | null = null
  const journalCheckpoints: Record<string, string> = {}
  const freezeJournal = (phase: string, observed: Json) => {
    journalCheckpoints[phase] = observed.journal_sha256
    if (Object.values(journalCheckpoints).some(hash => hash !== observed.journal_sha256))
      throw new Error(`producer journal changed at ${phase}`)
  }
  let sourceAfter = sourceBefore, globalAfter = globalBefore, version = "unknown"
  try {
    providerConfig = JSON.parse(readFileSync(options.providerConfigPath, "utf8")) as Json
    if (!providerConfig || typeof providerConfig !== "object" || Array.isArray(providerConfig) || !providerConfig[options.providerID])
      throw new Error("provider config file does not contain the configured providerID")
    rejectInlineCredentials(providerConfig[options.providerID])
    if (options.authFile) {
      if (!isAbsolute(options.authFile)) throw new Error("--auth-file must be an absolute path")
      const savedAuth = JSON.parse(readFileSync(options.authFile, "utf8")) as Json
      const selectedAuth = savedAuth?.[options.providerID]
      if (!selectedAuth || typeof selectedAuth !== "object" || Array.isArray(selectedAuth)) throw new Error("requested provider auth entry is unavailable")
      authSecrets = collectSecretScalars(selectedAuth)
      authCopyPath = join(env.XDG_DATA_HOME!, "opencode", "auth.json")
      mkdirSync(dirname(authCopyPath), { recursive: true })
      writeFileSync(authCopyPath, JSON.stringify({ [options.providerID]: selectedAuth }), { flag: "wx", mode: 0o600 })
    }
    const probeStarted = Date.now(), probeTimeout = assertDeadline(deadline, VERSION_PROBE_MS)
    versionProcess = trackedSpawn(executable, ["--version"], project, env, process.platform !== "win32")
    let probeEvidence: VersionCommandEvidence
    try {
      // Supplying our captured process keeps the existing credential-free environment intact.
      probeEvidence = await runVersionCommand(executable, project, { captured: versionProcess, timeoutMs: probeTimeout })
    } catch (error) {
      if (error instanceof VersionCommandError) versionProbe = versionProbeDiagnostic(error.evidence, Date.now() - probeStarted)
      throw new Error("OpenCode version probe failed; inspect safe version_probe diagnostics")
    }
    versionProbe = versionProbeDiagnostic(probeEvidence, Date.now() - probeStarted)
    if (versionProbe.error_category !== null) throw new Error("OpenCode version probe failed; inspect safe version_probe diagnostics")
    version = `${probeEvidence.stdout} ${probeEvidence.stderr}`.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? "unknown"
    if (version === "unknown" || !validateOpenCodeVersion(version).compatible) throw new Error("OpenCode host version is outside the supported V1 range")
    const checkout = verificationPluginConfiguration()
    seedVerificationHostDependencies(join(env.XDG_CONFIG_HOME!, "opencode"), checkout.source.root)
    const plugin = copyPluginSnapshot(tempRoot)
    const agentRoot = join(env.XDG_CONFIG_HOME!, "opencode", "agents"); mkdirSync(agentRoot, { recursive: true })
    for (const role of ["orchestrator", "implementer", "checker"]) copyFileSync(join(plugin.source.root, "agents", `${role}.md`), join(agentRoot, `${role}.md`))
    mkdirSync(join(project, ".opencode"), { recursive: true })
    seedVerificationHostDependencies(join(project, ".opencode"), checkout.source.root)
    const endpoint = await provider.listen(); writeConfig(env.OPENCODE_CONFIG!, endpoint, plugin.source.spec, options.providerID, options.modelID, providerConfig)
    writeFileSync(env.OPENCODE_ALG_CONFIG!, JSON.stringify({ skillEvolution: { enabled: false }, sessionMemory: { mode: "off" }, workspace: { mode: "observe" } }), { flag: "wx", mode: 0o600 })
    host = await startHost(executable, project, env, deadline, child => hostProcesses.push(child))
    const created = await api(host.base, project, "/session", "POST", { title: OWNER_TITLE }, deadline)
    ownerSessionId = typeof created?.id === "string" ? created.id : ""
    if (!ownerSessionId) throw new Error("OpenCode did not create the parent host session")
    const graph = { name: "action-evidence-headless", max_global_attempts: 3, max_concurrency: 1, nodes: [
      { id: "work", agent: "implementer", depends_on: [], description: "Run the fixed harmless command sequence for action evidence acceptance.", loop: { max_attempts: 1, gate: "schema" } },
      { id: "check", agent: "checker", depends_on: ["work"], inputs: { claimed: "work" }, verification: { version: 1 },
        isolated_check: true, loop: { max_attempts: 2, gate: "schema" } },
    ] }
    const run = createRun({ runId: RUN_ID, projectDirectory: project, ownerSessionId, parentSessionId: ownerSessionId,
      goal: GOAL, criteria: [CRITERION], graph, modelSnapshot: {
        implementer: { providerID: LOCAL_PROVIDER, modelID: "deterministic" },
        checker: { providerID: options.providerID, modelID: options.modelID },
      }, allowFilesystemRoot: true, treatProjectAsFilesystemRoot: true })
    runId = run.run_id
    await api(host.base, project, `/session/${encodeURIComponent(ownerSessionId)}/message`, "POST", {
      model: { providerID: LOCAL_PROVIDER, modelID: "deterministic" }, agent: "orchestrator",
      parts: [{ type: "text", text: `${PARENT_MARKER}\nCall alg_run once for the already-owned run ${runId} with max_waves=1, then stop at the producer boundary.` }],
    }, deadline, MAX_RUN_MS)
    let persisted = loadEvidenceRun(project, runId)
    terminalStatus = persisted.status
    assertProducerBoundary(persisted)
    if (provider.requests.some(row => row.role === "checker")) throw new Error("checker was launched before the compaction boundary")
    const producerHistoryBeforeChecker = await observeHistory("producer_before_checker", host.base, persisted.nodes.work!.attempts[0]!.session_id!)
    evidence = validateEvidence(project, persisted, options.caseId)
    const nativeHostConsistency = crosscheckProducerHostHistory(producerHistoryBeforeChecker, evidence, options.caseId)
    evidence.native_host_consistency = nativeHostConsistency
    if (!nativeHostConsistency.passed) throw new Error("native producer host rows and journal failed the pre-checker consistency gate")
    freezeJournal("before_compaction", evidence)
    const producerFinishedAt = persisted.nodes.work!.attempts[0]!.finished_at
    const producerRequestCount = provider.requests.filter(row => row.role === "implementer").length
    const beforeMessages = await observeHistory("parent_before_compaction", host.base, ownerSessionId)
    if (observeCompactionMarkers(beforeMessages).length !== 0) throw new Error("unexpected compaction before the requested checkpoint")
    const requestId = randomUUID(), requestedAt = new Date().toISOString()
    compaction = { requested_at: requestedAt, completed_summary_count: 0 }
    provider.summaryNext()
    const summaryResponse = await api(host.base, project, `/session/${encodeURIComponent(ownerSessionId)}/summarize`, "POST",
      { providerID: LOCAL_PROVIDER, modelID: "deterministic" }, deadline, MAX_RUN_MS)
    let afterMessages: any[] = [], summaryReceipt: ReturnType<typeof compactionReceipt> | undefined
    const summaryDeadline = Math.min(deadline, Date.now() + 15_000)
    do {
      afterMessages = await observeHistory("parent_after_compaction", host.base, ownerSessionId, summaryDeadline)
      summaryReceipt = compactionReceipt({ requestId, requestedAt, rootSessionId: ownerSessionId, response: summaryResponse,
        beforeMessages, afterMessages, continuation: { status: "not_completed" } })
      if (summaryReceipt.summaryExposureQualified) break
      await delay(100)
    } while (Date.now() < summaryDeadline)
    const markers = observeCompactionMarkers(afterMessages), completedSummaries = markers.filter(marker => marker.summary)
    compaction = { receipt: summaryReceipt, markers, completed_summary_count: completedSummaries.length,
      producer_finished_at: producerFinishedAt, producer_attempts_before: persisted.nodes.work!.current_attempt,
      checker_attempts_before: persisted.nodes.check!.current_attempt }
    const summaryMarker = completedSummaries[0]
    if (!summaryReceipt?.summaryExposureQualified || markers.length !== 1 || completedSummaries.length !== 1 ||
      summaryMarker?.summary?.id !== summaryReceipt.summary.id || !producerFinishedAt ||
      !(Date.parse(producerFinishedAt) <= (summaryMarker.createdAt ?? -1)))
      throw new Error("one completed actual parent compaction was not observed after the producer")
    const summaryMessage = afterMessages.find(message => message.info?.id === summaryReceipt.summary.id)
    const summaryText = (summaryMessage?.parts ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
    if (summaryText !== SUMMARY_TEXT || provider.requests.filter(row => row.role === "summary").length !== 1)
      throw new Error("host summary does not match the fixed content-free provider checkpoint")
    compaction.summary_text_sha256 = sha(summaryText)
    persisted = loadEvidenceRun(project, runId)
    assertProducerBoundary(persisted)
    if (provider.requests.some(row => row.role === "checker") || provider.requests.filter(row => row.role === "implementer").length !== producerRequestCount)
      throw new Error("engine work occurred during parent compaction")
    freezeJournal("after_compaction", validateEvidence(project, persisted, options.caseId))

    provider.resumeNext()
    const resumed = await api(host.base, project, `/session/${encodeURIComponent(ownerSessionId)}/message`, "POST", {
      model: { providerID: LOCAL_PROVIDER, modelID: "deterministic" }, agent: "orchestrator",
      parts: [{ type: "text", text: `${RESUME_MARKER}\nCall alg_resume once for ${runId} with max_waves=2 to run the checker, then stop.` }],
    }, deadline, MAX_RUN_MS)
    persisted = loadEvidenceRun(project, runId)
    terminalStatus = persisted.status
    const checkerHistories = await captureCheckers(persisted, "checker_attempt")
    const checkerAttemptsBeforeRestart = structuredClone(persisted.nodes.check?.attempts ?? [])
    evidence = validateEvidence(project, persisted, options.caseId)
    evidence.native_host_consistency = nativeHostConsistency
    freezeJournal("after_resume", evidence)
    const checkerHistory = checkerHistories.at(-1)?.messages ?? []
    compaction.checker_started_at = checkerAttemptsBeforeRestart.map(attempt => attempt.started_at)
    evidence.checker_provider_id = options.providerID
    evidence.checker_model_id = options.modelID
    evidence.checker_attempts = checkerAttemptsBeforeRestart.map(attempt => ({ ...attempt,
      retrieval: validateCheckerRetrieval(persisted, evidence!,
        checkerHistories.find(entry => entry.attempt === attempt.attempt)?.messages ?? [], attempt) }))
    evidence.complete_checker_history_preservation = checkerAttemptsBeforeRestart.length > 0 && checkerAttemptsBeforeRestart.every(attempt => {
      const snapshot = privateHostEvidence[`checker_attempt_${attempt.attempt}`]
      return snapshot && !snapshot.truncated && !snapshot.history_error
    })
    evidence.checker_retrieval = validateCheckerRetrieval(persisted, evidence, checkerHistory)
    evidence.case_grade = gradeLiveActionEvidenceCase({ case_id: options.caseId, run: persisted, producer: evidence,
      checker_histories: checkerHistories, compaction_completed_at: summaryMarker.summary!.completedAt })
    if (provider.requests.filter(row => row.role === "implementer").length !== producerRequestCount)
      throw new Error("resume repeated deterministic producer work")
    const providerRoles = provider.requests.map(row => row.role)
    if (!providerRoles.includes("parent") || !providerRoles.includes("implementer") || providerRoles.includes("unknown")) throw new Error("deterministic producer/parent provider did not observe the expected roles")
    const history = await observeHistory("parent_after_resume", host.base, ownerSessionId)
    evidence.parent_dispatch = parentDispatchReceipt(beforeMessages, afterMessages, history, provider.emissions, persisted)
    const continuationUser = history.find(message => message.info?.role === "user" &&
      message.parts?.some((part: any) => part.type === "text" && part.text?.includes(RESUME_MARKER)))
    compaction.receipt = compactionReceipt({ requestId, requestedAt, rootSessionId: ownerSessionId, response: summaryResponse,
      beforeMessages, afterMessages, continuationMessages: history, continuation: { status: "completed",
        userMessageID: continuationUser?.info?.id, assistantID: resumed?.info?.id, scorePassed: persisted.status === "done" } })
    if (!compaction.receipt.continuation.completionLinked) throw new Error("parent resume is not linked to the completed compaction")
    const resumedMarkers = observeCompactionMarkers(history)
    compaction.completed_summary_count_after_resume = resumedMarkers.filter(marker => marker.summary).length
    if (!isDeepStrictEqual(resumedMarkers, markers)) throw new Error("unexpected additional or altered compaction after resume")
    const producerHistory = await observeHistory("producer", host.base, evidence.child_session_id), producerTools = hostTools(producerHistory)
    if (producerTools.length !== 10 || producerTools.some((part, index) => part.tool !== "bash" ||
      !(part.state?.status === "completed" || options.caseId === "defective" && index === 0 && part.state?.status === "error")) ||
      producerTools[0]?.state?.input?.command !== firstCommand(options.caseId)) throw new Error("producer host history does not contain exactly the original ten completed commands")
    evidence.host_command_count = producerTools.length
    const globalDuring = snapshotGlobalOpenCodeConfig(roots, hmacKey)
    if (globalDuring.sha256 !== globalBefore.sha256) throw new Error("real-user OpenCode global configuration changed during isolated run")
    const providerRequestsBeforeRestart = provider.requests.length
    hostStopped = await stopProcess(host.processInfo)
    if (!hostStopped) throw new Error("first host did not stop before restart")
    host = undefined
    host = await startHost(executable, project, env, deadline, child => hostProcesses.push(child))
    const restored = await api(host.base, project, `/session/${encodeURIComponent(ownerSessionId)}`, "GET", undefined, deadline)
    persisted = loadEvidenceRun(project, runId)
    if (restored?.id !== ownerSessionId || !["done", "failed"].includes(persisted?.status ?? "")) throw new Error("session/run did not reload after OpenCode server restart")
    const afterRestart = validateEvidence(project, persisted, options.caseId)
    freezeJournal("after_restart", afterRestart)
    if (afterRestart.manifest_sha256 !== evidence.manifest_sha256 || afterRestart.first_command_sha256 !== evidence.first_command_sha256) throw new Error("persisted action evidence changed across server restart")
    const restartedHistories = await captureCheckers(persisted, "checker_after_restart_attempt")
    const restartedChecker = validateCheckerRetrieval(persisted, afterRestart, restartedHistories.at(-1)?.messages ?? [])
    if (!isDeepStrictEqual(restartedChecker, evidence.checker_retrieval) ||
      !isDeepStrictEqual(persisted.nodes.check?.attempts, checkerAttemptsBeforeRestart) ||
      !isDeepStrictEqual(restartedHistories, checkerHistories)) throw new Error("checker attempts, native histories or page receipts changed across server restart")
    const restartedMarkers = observeCompactionMarkers(await observeHistory("parent_after_restart", host.base, ownerSessionId))
    compaction.completed_summary_count_after_restart = restartedMarkers.filter(marker => marker.summary).length
    if (!isDeepStrictEqual(restartedMarkers, markers) || provider.requests.length !== providerRequestsBeforeRestart)
      throw new Error("restart changed compaction identity or issued additional model work")
    if (provider.errors.length !== 0) throw new Error("deterministic provider recorded an error; inspect the safe provider diagnostics")
    restartVerified = true
    evidence = { ...evidence, after_restart: { same_owner_session: true, same_done_run: true, same_manifest_sha256: true,
      same_first_command_sha256: true, same_checker_receipts: true, same_all_checker_attempts_and_native_histories: true } }
    sourceAfter = verificationPluginConfiguration().source.digest
    globalAfter = snapshotGlobalOpenCodeConfig(roots, hmacKey)
    if (sourceAfter !== sourceBefore) throw new Error("plugin source identity changed during headless run")
    if (globalAfter.sha256 !== globalBefore.sha256) throw new Error("real-user OpenCode global configuration changed during headless run")
  } catch (error) {
    failure = privateError(error, authSecrets)
    if (runId) try {
      const failedRun = loadEvidenceRun(project, runId)
      if (failedRun) {
        if (!(failedRun.nodes.check?.attempts ?? []).every(attempt => privateHostEvidence[`checker_attempt_${attempt.attempt}`]))
          await captureCheckers(failedRun, "checker_failure_attempt")
        terminalStatus = failedRun.status
        failureRun = { status: failedRun.status, global_attempts: failedRun.global_attempts,
          nodes: Object.entries(failedRun.nodes).map(([id, node]: [string, any]) => ({ id, status: node.status, current_attempt: node.current_attempt,
            attempts: (node.attempts ?? []).map((attempt: any) => ({ outcome: attempt.outcome ?? null, schema_ok: attempt.schema_ok ?? null,
              execution_error_present: !!attempt.execution_error, action_manifest_sha256: attempt.action_evidence_ref?.sha256 ?? null,
              retrieved_evidence_ids: (attempt.retrieved_evidence ?? []).map((entry: any) => entry.id) })) })) }
      }
    } catch { failureRun = { status: terminalStatus, unavailable: true } }
  }
  finally {
    for (const child of hostProcesses) await stopProcess(child)
    host = undefined
    const hostCleanup = hostCleanupStatus(hostProcesses.map(child => ({ pid: child.child.pid ?? null, exited: child.exited() })))
    hostStopped = hostCleanup.host_cleanup_passed
    if (versionProcess && !versionProcess.exited()) await stopProcess(versionProcess)
    if (versionProcess) privateHostEvidence.version_process = boundedPrivateHostEvidence({ stdout_tail: versionProcess.stdout(), stderr_tail: versionProcess.stderr() }, authSecrets)
    privateHostEvidence.host_processes = boundedPrivateHostEvidence(hostProcesses.map(child => ({ pid: child.child.pid ?? null,
      ...child.exit(), stdout_tail: child.stdout(), stderr_tail: child.stderr() })), authSecrets)
    try { await provider.close(); providerStopped = true } catch { providerStopped = false }
    if (authCopyPath) try { rmSync(authCopyPath, { force: true }) } catch { /* retain safe failure evidence */ }
    try { sourceAfter = verificationPluginConfiguration().source.digest } catch { sourceAfter = "unavailable" }
    try { globalAfter = snapshotGlobalOpenCodeConfig(roots, hmacKey) } catch { globalAfter = { entries: [], sha256: "unavailable" } as any }
    const base = { schema_version: 1, kind: "opencode-alg-v1-action-evidence-headless", generated_at: new Date().toISOString(),
      passed: failure === null && !!evidence && evidence.case_grade?.passed === true &&
        evidence.complete_checker_history_preservation === true &&
        evidence.native_host_consistency?.passed === true &&
        evidence.checker_retrieval?.passed === true && evidence.parent_dispatch?.passed === true &&
        compaction?.completed_summary_count === 1 && compaction?.receipt?.continuation?.completionLinked === true &&
        Object.keys(journalCheckpoints).length === 4 && new Set(Object.values(journalCheckpoints)).size === 1 &&
        restartVerified && hostStopped && providerStopped && (!authCopyPath || !existsSync(authCopyPath)) &&
        provider.nonLoopbackRequests === 0 && sourceAfter === sourceBefore && globalAfter.sha256 === globalBefore.sha256,
      scope: "diagnostic: deterministic local parent/producer, at most two fresh independently configured real checker attempts; no production claim", case_id: options.caseId,
      model: { providerID: options.providerID, modelID: options.modelID, configured_output_limit: 8_192 },
      fixture_version: FIXTURE_VERSION, repair_allowance: REPAIR_ALLOWANCE, retrieval_recipe: RETRIEVAL_RECIPE, criterion_sha256: sha(CRITERION),
      host: { executable, version, platform: process.platform, starts: hostCleanup.starts, spawn_attempts: hostCleanup.spawn_attempts,
      clean_stops: hostCleanup.host_stopped }, version_probe: versionProbe, private_host_evidence: privateHostEvidence,
      run: { run_id: runId || null, owner_session_id: ownerSessionId || null, terminal_status: terminalStatus,
        graph_done: terminalStatus === "done", evidence, failure_state: failureRun }, compaction, journal_checkpoints: journalCheckpoints,
      provider: { producer_endpoint: "loopback-only", checker_provider: options.providerID, request_count: provider.requests.length, requests: provider.requests.slice(0, 64),
        emitted_tools: provider.emissions,
        errors: provider.errors.slice(0, 16), error_log_truncated: provider.errors.length > 16,
        request_log_truncated: provider.requests.length > 64, non_loopback_requests: provider.nonLoopbackRequests,
        fixture_auth_sent: false, isolated_provider_auth_configured: !!options.authFile },
      isolation: { credentials_inherited: false, real_user_global_config_unchanged: globalAfter.sha256 === globalBefore.sha256,
        global_config_before_sha256: globalBefore.sha256, global_config_after_sha256: globalAfter.sha256,
        plugin_source_before_sha256: sourceBefore, plugin_source_after_sha256: sourceAfter },
      cleanup: { ...hostCleanup, provider_stopped: providerStopped, isolated_auth_copy_removed: !authCopyPath || !existsSync(authCopyPath),
        version_process_stopped: !versionProcess || versionProcess.exited(), temporary_environment_removed: false,
        retained_failure_workspace: tempRoot }, failure }
    return persistDiagnosticOutcome(base, outputPath, tempRoot)
  }
}

interface CliOptions { hostExecutable: string; outputPath: string; providerID: string; modelID: string; providerConfigPath: string; authFile?: string }
function parseArgs(args: string[]): CliOptions {
  let hostExecutable = process.env.OPENCODE_BIN?.trim() || "opencode", outputPath = "", providerID = "", modelID = "", providerConfigPath = "", authFile: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host") hostExecutable = args[++i] ?? ""
    else if (args[i] === "--output") outputPath = args[++i] ?? ""
    else if (args[i] === "--provider-id") providerID = args[++i] ?? ""
    else if (args[i] === "--model-id") modelID = args[++i] ?? ""
    else if (args[i] === "--provider-config") providerConfigPath = args[++i] ?? ""
    else if (args[i] === "--auth-file") authFile = args[++i] ?? ""
    else if (args[i] === "--help" || args[i] === "-h") throw new Error("Usage: bun run scripts/action-evidence-live-regression.ts --provider-id <id> --model-id <id> --provider-config <absolute-json> [--auth-file <absolute-auth.json>] --output <absolute-summary.json> [--host <absolute-opencode-executable>|OPENCODE_BIN]")
    else throw new Error(`Unknown option ${args[i]}`)
  }
  if (!hostExecutable) throw new Error("OpenCode host path is empty")
  if (!outputPath || !isAbsolute(outputPath)) throw new Error("--output requires an absolute receipt path")
  if (!providerID || !modelID) throw new Error("--provider-id and --model-id are required")
  if (!providerConfigPath || !isAbsolute(providerConfigPath)) throw new Error("--provider-config requires an absolute JSON path")
  if (authFile && !isAbsolute(authFile)) throw new Error("--auth-file requires an absolute path")
  return { hostExecutable: resolveOpenCodeExecutable(hostExecutable), outputPath: resolve(outputPath), providerID, modelID,
    providerConfigPath: resolve(providerConfigPath), ...(authFile ? { authFile: resolve(authFile) } : {}) }
}

if (import.meta.main) {
  try {
    const config = parseArgs(process.argv.slice(2)), started = Date.now(), suiteDeadline = started + MAX_TOTAL_MS
    const outputs = CASES.map(caseId => `${config.outputPath}.${caseId}.json`)
    const planPath = `${config.outputPath}.plan.json`
    if ([config.outputPath, planPath, ...outputs].some(path => existsSync(path))) throw new Error("refusing to overwrite an existing plan, case or summary receipt")
    const outcomes: Json[] = CASES.map((caseId, index) => ({
      case_id: caseId, status: "issued_not_started", passed: false, receipt: outputs[index],
    }))
    const sourceDigest = verificationPluginConfiguration().source.digest
    const harnessDigest = sha(readFileSync(import.meta.filename))
    const sourceUnchanged = () => verificationPluginConfiguration().source.digest === sourceDigest &&
      sha(readFileSync(import.meta.filename)) === harnessDigest
    let complete = false, haltReason: string | null = null
    const makeSummary = () => ({ schema_version: 1, kind: "opencode-alg-v1-action-evidence-live-regression", generated_at: new Date().toISOString(),
      passed: complete && outcomes.every(row => row.passed === true), complete, issued_case_limit: 2, issued_cases: CASES.length,
      bounds: { per_case_ms: MAX_RUN_MS, total_ms: MAX_TOTAL_MS, output_tokens: 8_192, producer_attempts: 1, checker_max_attempts: 2, resume_max_waves: 2 },
      execution_note: "Producer and parent use deterministic local fixture roles. Each checker is a fresh real configured OpenCode provider/model. Diagnostic only; deterministic producer is disclosed.",
      model: { providerID: config.providerID, modelID: config.modelID }, source_sha256: sourceDigest, harness_sha256: harnessDigest,
      fixture_version: FIXTURE_VERSION, repair_allowance: REPAIR_ALLOWANCE, retrieval_recipe: RETRIEVAL_RECIPE, criterion: CRITERION, criterion_sha256: sha(CRITERION),
      elapsed_ms: Date.now() - started, outcomes })
    mkdirSync(dirname(config.outputPath), { recursive: true })
    writeFileSync(planPath, `${JSON.stringify({ ...makeSummary(), kind: "opencode-alg-v1-action-evidence-live-regression-plan",
      started_at: new Date(started).toISOString(), suite_deadline: new Date(suiteDeadline).toISOString() }, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    writeFileSync(config.outputPath, `${JSON.stringify(makeSummary(), null, 2)}\n`, { flag: "wx", mode: 0o600 })
    const persistSummary = () => {
      const staged = `${config.outputPath}.${randomUUID()}.partial`
      writeFileSync(staged, `${JSON.stringify(makeSummary(), null, 2)}\n`, { flag: "wx", mode: 0o600 })
      renameSync(staged, config.outputPath)
    }
    for (const [index, caseId] of CASES.entries()) {
      const outcome = outcomes[index]!
      const remaining = suiteDeadline - Date.now()
      if (haltReason || remaining <= 0) {
        Object.assign(outcome, { status: haltReason ? "stopped_before_start_harness_failure" : "stopped_before_start_total_deadline",
          failure: haltReason ?? "total_deadline" })
        persistSummary()
        continue
      }
      outcome.status = "running"; persistSummary()
      try {
        if (!sourceUnchanged()) throw new Error("frozen diagnostic source changed before case")
        const result = await runActionEvidenceLiveRegressionCase({ ...config, caseId, outputPath: outputs[index]!, timeoutMs: Math.min(MAX_RUN_MS, remaining) })
        Object.assign(outcome, { status: result.passed ? "completed_pass" : result.failure ? "completed_harness_failure" : "completed_checker_or_grade_failure",
          passed: result.passed, observed_verdict: result.run?.evidence?.case_grade?.observed_verdict ?? "missing", failure: result.failure ?? null })
        if (!sourceUnchanged()) throw new Error("frozen diagnostic source changed during case")
        if (!result.cleanup?.host_cleanup_passed || !result.cleanup?.version_process_stopped || !result.cleanup?.provider_stopped || !result.cleanup?.isolated_auth_copy_removed ||
          result.isolation?.real_user_global_config_unchanged !== true)
          haltReason = "prior_case_isolation_or_cleanup_unresolved"
      } catch (error) {
        haltReason = safeError(error)
        Object.assign(outcome, { status: "completed_harness_failure", passed: false, failure: haltReason })
      }
      persistSummary()
    }
    complete = true; persistSummary()
    const summary = makeSummary()
    console.log(JSON.stringify({ check: "opencode-alg-v1-action-evidence-live-regression", passed: summary.passed,
      output: config.outputPath, cases: outcomes.map(row => ({ case_id: row.case_id, status: row.status, observed_verdict: row.observed_verdict ?? null })) }))
    if (!summary.passed) process.exitCode = 1
  } catch (error) { console.error(safeError(error)); process.exitCode = 1 }
}

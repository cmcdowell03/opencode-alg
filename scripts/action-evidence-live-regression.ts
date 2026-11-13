import { createHash, randomBytes, randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { isDeepStrictEqual } from "node:util"
import { createRun, hydrateRunFully, loadRun } from "../src/store.ts"
import { ActionEvidenceJournal } from "../src/action-evidence.ts"
import { evidencePage } from "../src/evidence-retrieval.ts"
import { validateOpenCodeVersion, realUserGlobalConfigRoots, snapshotGlobalOpenCodeConfig, verificationPluginConfiguration } from "./live-verify.ts"
import { resolveOpenCodeExecutable } from "./host-executable.ts"
import { seedVerificationHostDependencies } from "./verification-host-dependencies.ts"
import { compactionReceipt, observeCompactionMarkers } from "./build-benchmark-protocol.ts"

const MAX_RUN_MS = 15 * 60_000
const MAX_TOTAL_MS = 35 * 60_000
const REQUEST_MS = 12_000
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
function trackedSpawn(exe: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(exe, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = "", stderr = "", exited = child.exitCode !== null
  child.stdout?.on("data", (b: Buffer) => { stdout = (stdout + b.toString("utf8")).slice(-16_384) })
  child.stderr?.on("data", (b: Buffer) => { stderr = (stderr + b.toString("utf8")).slice(-16_384) })
  child.once("close", () => { exited = true }); child.once("error", () => { exited = true })
  return { child, stdout: () => stdout, stderr: () => stderr, exited: () => exited || child.exitCode !== null }
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
          if (!calledTools(currentTurn).some(call => call.name === tool)) choice = { tool: toolChoice(body, tool, { run_id: RUN_ID, max_waves: 1 }) }
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
const CRITERION = "The first long command is retained exactly and its terminal result reports exit code zero."
const LOCAL_PROVIDER = "action-evidence-fixture"
type CaseId = "correct" | "defective"
const CASES: readonly CaseId[] = ["correct", "defective"]

export interface LiveActionEvidenceGradeInput {
  case_id: CaseId
  run: any
  producer: Json
  checker_output: any
  retrieved: readonly any[]
  checker_history: readonly any[]
}

/** Deterministic host-side oracle. It validates provenance and model verdict; it never feeds the oracle to the checker. */
export function gradeLiveActionEvidenceCase(input: LiveActionEvidenceGradeInput): Json {
  const expectedPass = input.case_id === "correct"
  const evidence = input.producer
  const attempt = input.run?.nodes?.work?.attempts?.[0]
  const checker = input.run?.nodes?.check
  const findings = input.checker_output?.findings
  const finding = Array.isArray(findings) && findings.length === 1 ? findings[0] : undefined
  const expectedIds = new Set([evidence?.first_records?.intent?.sha256, evidence?.first_records?.terminal?.sha256])
  const receipts = Array.isArray(input.retrieved) ? input.retrieved : []
  const receiptIds = new Set(receipts.map(row => row?.id))
  const checkerTools = hostTools(input.checker_history)
  const reads = checkerTools.filter(part => part.tool === "alg_artifact")
  const assistantMessages = input.checker_history.filter((message: any) => message?.info?.role === "assistant")
  const configuredCheckerObserved = typeof evidence?.checker_provider_id === "string" &&
    typeof evidence?.checker_model_id === "string" && assistantMessages.length > 0 &&
    assistantMessages.every((message: any) => message.info.providerID === evidence.checker_provider_id &&
      message.info.modelID === evidence.checker_model_id)
  const readHashes = new Set(reads.filter(part => part.state?.input?.evidence === "read").map(part => part.state?.input?.record_id))
  const producerActions = input.run?.nodes?.work?.attempts?.flatMap((row: any) => row?.action_evidence_ref ? [row.action_evidence_ref.sha256] : []) ?? []
  const passedEvidence = typeof evidence?.first_terminal?.exit_code === "number" && evidence.first_terminal.exit_code === 0
  const defectiveEvidence = typeof evidence?.first_terminal?.exit_code === "number" && evidence.first_terminal.exit_code !== 0
  const exactActionCardinality = evidence?.observed_calls === 10 && evidence?.completed === 10 && evidence?.unknown_terminal === 0 &&
    attempt?.action_evidence_ref?.sha256 === evidence?.manifest_sha256 && producerActions.length === 1 &&
    input.run?.nodes?.work?.current_attempt === 1 && input.run?.nodes?.work?.attempts?.length === 1
  const actualPageReads = expectedIds.size === 2 && [...expectedIds].every(id => {
    const receipt = receipts.find(row => row?.reference?.sha256 === id)
    const tool = reads.find(part => part.state?.input?.evidence === "read" && part.state?.input?.record_id === id)
    return !!receipt && receiptIds.has(receipt.id) && !!tool && parseJsonDeep(tool.state?.output).some(value =>
      value.citation_id === receipt.id && isDeepStrictEqual(value.receipt, receipt))
  })
  const retrievedBothPages = actualPageReads && [...expectedIds].every(id => readHashes.has(id)) &&
    checkerTools.length === 3 && reads.length === 3 && reads.every(part => part.state?.status === "completed") &&
    reads[0]?.state?.input?.evidence === "index"
  const citations = Array.isArray(finding?.evidence_ids) ? finding.evidence_ids : []
  const citationsBound = citations.length === 2 && new Set(citations).size === 2 && citations.every((id: unknown) => typeof id === "string" && receiptIds.has(id)) &&
    [...expectedIds].every(id => citations.some((citation: string) => receipts.some(row => row?.id === citation && row?.reference?.sha256 === id)))
  const outcomeValid = expectedPass ? finding?.outcome === "supported" : finding?.outcome === "disconfirmed"
  const expectedVerdict = expectedPass
  const verdictCorrect = input.checker_output?.passed === expectedVerdict && finding?.criterion_id === "C1" &&
    outcomeValid && citationsBound && (expectedPass ? passedEvidence : defectiveEvidence)
  const noReplay = producerActions.length === 1 && checker?.current_attempt === 1 && checker?.attempts?.length === 1 &&
    (checker?.attempts?.[0]?.session_id !== attempt?.session_id)
  const passed = exactActionCardinality && retrievedBothPages && verdictCorrect && noReplay && configuredCheckerObserved
  return { passed, case_id: input.case_id, expected_verdict: expectedVerdict ? "pass" : "reject", observed_verdict: input.checker_output?.passed === true ? "pass" : input.checker_output?.passed === false ? "reject" : "missing",
    exact_action_cardinality: exactActionCardinality, retrieved_both_original_pages: retrievedBothPages, citations_bound_to_original_pages: citationsBound,
    no_producer_replay: noReplay, configured_real_checker_observed: configuredCheckerObserved,
    evidence_consistent_with_case: expectedPass ? passedEvidence : defectiveEvidence,
    failure_reasons: [!exactActionCardinality && "producer action count or immutable manifest identity was not exact",
      !retrievedBothPages && "checker did not retrieve both actual original intent and terminal pages",
      !citationsBound && "checker citations were missing, forged, or not bound to both original pages",
      !verdictCorrect && "checker verdict did not match the recorded action result and case contract",
      !noReplay && "producer replay or unexpected checker retry was observed",
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
async function startHost(executable: string, project: string, env: NodeJS.ProcessEnv, deadline: number) {
  const port = await freePort(), processInfo = trackedSpawn(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], project, env)
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
function firstCommand(caseId: CaseId): string { return caseId === "correct"
  ? `node -e "/*${"x".repeat(3_200)}*/console.log('${EARLY_MARKER}')"`
  : `node -e "/*${"x".repeat(3_200)}*/console.log('${EARLY_MARKER}');process.exit(7)"` }
function validateEvidence(project: string, run: any, caseId: CaseId): Json {
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
  if (firstIntent?.command !== command || Buffer.byteLength(firstIntent.command, "utf8") <= 3_000) throw new Error("first long command was not retained byte-exactly")
  if (firstTerminal?.source !== "hook" && firstTerminal?.source !== "history") throw new Error("first terminal source is not a hook/history receipt")
  const expectedExit = caseId === "correct" ? 0 : 7
  if (!(firstTerminal?.tool_status === "completed" || caseId === "defective" && firstTerminal?.tool_status === "error") ||
    firstTerminal?.exit_code_status !== "reported" || firstTerminal?.exit_code !== expectedExit || !String(firstTerminal?.output ?? "").includes(EARLY_MARKER))
    throw new Error("first terminal receipt does not match the case's actual process result")
  const firstReferences = Object.fromEntries(["intent", "terminal"].map(kind => {
    const entry = manifest.entries.find(entry => entry.kind === kind && entry.ordinal === 1)!
    return [kind, { artifact_path: entry.artifact_path, sha256: entry.sha256, byte_size: entry.byte_size }]
  }))
  return { manifest_sha256: reference.sha256, manifest_path: reference.artifact_path, child_session_id: session,
    // readManifest verified every referenced record's bytes before this commitment is computed.
    journal_sha256: sha(JSON.stringify({ manifest: reference, entries: manifest.entries })), first_records: firstReferences,
    observed_calls: manifest.coverage.observed_calls, completed: manifest.coverage.completed, unknown_terminal: manifest.coverage.unknown_terminal,
    first_command_bytes: Buffer.byteLength(firstIntent.command, "utf8"), first_command_sha256: sha(firstIntent.command),
    first_terminal: { source: firstTerminal.source, tool_status: firstTerminal.tool_status, exit_code_status: firstTerminal.exit_code_status,
      exit_code: firstTerminal.exit_code, output_contains_early_marker: String(firstTerminal.output ?? "").includes(EARLY_MARKER) },
    late_commands: intents.slice(1).length }
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
function parentDispatchReceipt(before: any[], compacted: any[], resumed: any[], emissions: ProviderEmission[],
  run: ReturnType<typeof loadEvidenceRun>): Json {
  // Incoming provider histories include native task cards. Only responses we emitted are model dispatches.
  const parentEmissions = emissions.filter(row => row.role === "parent")
  const emissionMatch = parentEmissions.length === 2 && parentEmissions[0]?.tool === "alg_run" &&
    parentEmissions[1]?.tool === "alg_resume" && new Set(parentEmissions.map(row => row.call_id)).size === 2 &&
    parentEmissions.every(row => row.run_id === run.run_id && row.max_waves === 1)
  const stage = (history: any[], expectedCount: number) => {
    const parts = hostTools(history), actual = parts.filter(part => part.tool === "alg_run" || part.tool === "alg_resume")
    const matchedDispatches = actual.length === expectedCount && actual.every((part, index) => {
      const emitted = parentEmissions[index]
      return emitted && part.tool === emitted.tool && part.callID === emitted.call_id && part.state?.status === "completed" &&
        isDeepStrictEqual(part.state.input, { run_id: run.run_id, max_waves: 1 })
    })
    const cards = parts.filter(part => part.tool === "task" && ["work", "check"].some(nodeId => {
      const node = run.nodes[nodeId], attempt = node?.attempts[0]
      const dispatch = actual.find(row => row.tool === (nodeId === "work" ? "alg_run" : "alg_resume"))
      // Exact native projector identity, completed attempt, parent message and child binding; arbitrary task calls fail.
      return attempt?.attempt === 1 && (attempt.status === "done" || nodeId === "check" && attempt.status === "failed") && dispatch &&
        part.callID === `call_alg_${sha(`${run.run_id}\0${nodeId}\0${attempt.attempt}`).slice(0, 24)}` &&
        part.sessionID === run.owner_session_id && part.messageID === dispatch.messageID && part.state?.status === "completed" &&
        isDeepStrictEqual(part.state.input, { description: nodeId,
          prompt: `ALG run ${run.run_id}, node ${nodeId}, attempt ${attempt.attempt}.`, subagent_type: node!.agent }) &&
        part.state.metadata?.sessionId === attempt.session_id && part.state.metadata?.parentSessionId === run.owner_session_id
    }))
    const unknown = parts.length - actual.length - cards.length
    return { alg_run: actual.filter(part => part.tool === "alg_run").length,
      alg_resume: actual.filter(part => part.tool === "alg_resume").length, task_cards: cards.length,
      total_tool_parts: parts.length, unexpected_tool_parts: unknown,
      passed: matchedDispatches && unknown === 0 && new Set(cards.map(part => part.callID)).size === cards.length &&
        parts.every(part => typeof part.id === "string") && new Set(parts.map(part => part.id)).size === parts.length }
  }
  const beforeCompaction = stage(before, 1), afterCompaction = stage(compacted, 1), afterResume = stage(resumed, 2)
  const runCountsMatch = run.global_attempts === 2 && run.nodes.work?.current_attempt === 1 && run.nodes.work?.attempts.length === 1 &&
    run.nodes.work?.status === "done" && run.nodes.check?.current_attempt === 1 && run.nodes.check?.attempts.length === 1 &&
    ["done", "failed"].includes(run.nodes.check?.status ?? "")
  return { passed: emissionMatch && runCountsMatch && beforeCompaction.passed && afterCompaction.passed && afterResume.passed,
    before_compaction: beforeCompaction, after_compaction: afterCompaction, after_resume: afterResume,
    emitted_parent_tool_calls: parentEmissions.length, emitted_alg_calls: parentEmissions.filter(row => row.tool === "alg_run" || row.tool === "alg_resume").length,
    provider_call_ids_match: emissionMatch && beforeCompaction.passed && afterCompaction.passed && afterResume.passed,
    global_attempts: run.global_attempts,
    producer_attempts: run.nodes.work?.current_attempt, checker_attempts: run.nodes.check?.current_attempt }
}
function validateCheckerRetrieval(project: string, run: ReturnType<typeof loadEvidenceRun>, producer: Json, history: any[]): Json {
  const checker = run.nodes.check
  if (!checker || checker.current_attempt !== 1 || checker.attempts.length !== 1) return { passed: false, issue: "checker_attempt_missing_or_retried", page_count: 0, tool_call_count: 0 }
  const attempt = checker.attempts[0]!, retrieved = attempt.retrieved_evidence ?? []
  const expected = [producer.first_records.intent, producer.first_records.terminal].map(reference => {
    const page = evidencePage(project, run.run_id, reference, 0)
    if (page.next_offset !== null) throw new Error("fixed first record unexpectedly needs more than one evidence page")
    return page.receipt
  })
  const output = attempt.output as any, findings = output?.findings
  const citations = Array.isArray(findings) && findings.length === 1 ? findings[0]?.evidence_ids : undefined
  const tools = hostTools(history).filter(part => part.tool === "alg_artifact")
  let readsExact = tools.length === 3 && tools[0]?.state?.input?.evidence === "index"
  for (const [index, receipt] of expected.entries()) {
    const tool = tools[index + 1], input = tool?.state?.input
    if (input?.evidence !== "read" || input.record_id !== receipt.reference.sha256 || input.offset !== 0 || tool?.state?.status !== "completed" ||
      !parseJsonDeep(tool?.state?.output).some(value => value.citation_id === receipt.id && isDeepStrictEqual(value.receipt, receipt))) readsExact = false
  }
  const retrievedExact = retrieved.length === 2 && expected.every(receipt => retrieved.some(actual => isDeepStrictEqual(actual, receipt)))
  return { passed: retrievedExact && readsExact, page_count: retrieved.length, receipt_ids: retrieved.map((receipt: any) => receipt.id), pages: retrieved,
    finding_citation_ids: citations ?? [], tool_call_count: tools.length, retrieved_exact_original_pages: retrievedExact, host_reads_exact: readsExact,
    checker_attempt_status: attempt.status, checker_outcome: attempt.outcome ?? null, checker_output: output ?? null }
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
  let ownerSessionId = "", runId = "", terminalStatus = "unknown", restartVerified = false
  let evidence: Json | null = null, failure: string | null = null, failureRun: Json | null = null, outputPersisted = false, temporaryRemoved = false
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
    const versionProbe = spawnSync(executable, ["--version"], { cwd: project, env, encoding: "utf8", timeout: 10_000, windowsHide: true })
    if (versionProbe.error || versionProbe.status !== 0) throw new Error("OpenCode version probe failed")
    version = `${versionProbe.stdout ?? ""} ${versionProbe.stderr ?? ""}`.match(/\b\d+\.\d+\.\d+\b/)?.[0] ?? "unknown"
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
    host = await startHost(executable, project, env, deadline)
    const created = await api(host.base, project, "/session", "POST", { title: OWNER_TITLE }, deadline)
    ownerSessionId = typeof created?.id === "string" ? created.id : ""
    if (!ownerSessionId) throw new Error("OpenCode did not create the parent host session")
    const graph = { name: "action-evidence-headless", max_global_attempts: 4, max_concurrency: 1, nodes: [
      { id: "work", agent: "implementer", depends_on: [], description: "Run the fixed harmless command sequence for action evidence acceptance.", loop: { max_attempts: 1, gate: "schema" } },
      { id: "check", agent: "checker", depends_on: ["work"], inputs: { claimed: "work" }, verification: { version: 1 },
        isolated_check: true, loop: { max_attempts: 1, gate: "schema" } },
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
    evidence = validateEvidence(project, persisted, options.caseId)
    freezeJournal("before_compaction", evidence)
    const producerFinishedAt = persisted.nodes.work!.attempts[0]!.finished_at
    const producerRequestCount = provider.requests.filter(row => row.role === "implementer").length
    const beforeMessages = await sessionHistory(host.base, project, ownerSessionId, deadline)
    if (observeCompactionMarkers(beforeMessages).length !== 0) throw new Error("unexpected compaction before the requested checkpoint")
    const requestId = randomUUID(), requestedAt = new Date().toISOString()
    compaction = { requested_at: requestedAt, completed_summary_count: 0 }
    provider.summaryNext()
    const summaryResponse = await api(host.base, project, `/session/${encodeURIComponent(ownerSessionId)}/summarize`, "POST",
      { providerID: LOCAL_PROVIDER, modelID: "deterministic" }, deadline, MAX_RUN_MS)
    let afterMessages: any[] = [], summaryReceipt: ReturnType<typeof compactionReceipt> | undefined
    const summaryDeadline = Math.min(deadline, Date.now() + 15_000)
    do {
      afterMessages = await sessionHistory(host.base, project, ownerSessionId, summaryDeadline)
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
      parts: [{ type: "text", text: `${RESUME_MARKER}\nCall alg_resume once for ${runId} with max_waves=1 to run the checker, then stop.` }],
    }, deadline, MAX_RUN_MS)
    persisted = loadEvidenceRun(project, runId)
    terminalStatus = persisted.status
    evidence = validateEvidence(project, persisted, options.caseId)
    freezeJournal("after_resume", evidence)
    if (persisted.global_attempts !== 2 || persisted.nodes.work?.status !== "done" || persisted.nodes.work.current_attempt !== 1 ||
      persisted.nodes.work.attempts.length !== 1 || persisted.nodes.check?.current_attempt !== 1 || persisted.nodes.check?.attempts.length !== 1 ||
      provider.requests.filter(row => row.role === "implementer").length !== producerRequestCount)
      throw new Error("resume must issue exactly one checker attempt without repeating producer work")
    const checkerAttempt = persisted.nodes.check.attempts[0]!
    if (!(Date.parse(checkerAttempt.started_at) >= summaryMarker.summary!.completedAt))
      throw new Error("checker started before the actual parent summary completed")
    compaction.checker_started_at = checkerAttempt.started_at
    const checkerHistory = await sessionHistory(host.base, project, checkerAttempt.session_id!, deadline)
    evidence.checker_provider_id = options.providerID
    evidence.checker_model_id = options.modelID
    evidence.checker_retrieval = validateCheckerRetrieval(project, persisted, evidence, checkerHistory)
    evidence.case_grade = gradeLiveActionEvidenceCase({ case_id: options.caseId, run: persisted, producer: evidence,
      checker_output: checkerAttempt.output, retrieved: checkerAttempt.retrieved_evidence ?? [], checker_history: checkerHistory })
    const providerRoles = provider.requests.map(row => row.role)
    if (!providerRoles.includes("parent") || !providerRoles.includes("implementer") || providerRoles.includes("unknown")) throw new Error("deterministic producer/parent provider did not observe the expected roles")
    const history = await sessionHistory(host.base, project, ownerSessionId, deadline)
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
    const producerHistory = await sessionHistory(host.base, project, evidence.child_session_id, deadline), producerTools = hostTools(producerHistory)
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
    host = await startHost(executable, project, env, deadline)
    const restored = await api(host.base, project, `/session/${encodeURIComponent(ownerSessionId)}`, "GET", undefined, deadline)
    persisted = loadEvidenceRun(project, runId)
    if (restored?.id !== ownerSessionId || !["done", "failed"].includes(persisted?.status ?? "")) throw new Error("session/run did not reload after OpenCode server restart")
    const afterRestart = validateEvidence(project, persisted, options.caseId)
    freezeJournal("after_restart", afterRestart)
    if (afterRestart.manifest_sha256 !== evidence.manifest_sha256 || afterRestart.first_command_sha256 !== evidence.first_command_sha256) throw new Error("persisted action evidence changed across server restart")
    const restartedChecker = validateCheckerRetrieval(project, persisted, afterRestart,
      await sessionHistory(host.base, project, persisted.nodes.check!.attempts[0]!.session_id!, deadline))
    if (!isDeepStrictEqual(restartedChecker, evidence.checker_retrieval)) throw new Error("checker page receipts changed across server restart")
    const restartedMarkers = observeCompactionMarkers(await sessionHistory(host.base, project, ownerSessionId, deadline))
    compaction.completed_summary_count_after_restart = restartedMarkers.filter(marker => marker.summary).length
    if (!isDeepStrictEqual(restartedMarkers, markers) || provider.requests.length !== providerRequestsBeforeRestart)
      throw new Error("restart changed compaction identity or issued additional model work")
    if (provider.errors.length !== 0) throw new Error("deterministic provider recorded an error; inspect the safe provider diagnostics")
    restartVerified = true
    evidence = { ...evidence, after_restart: { same_owner_session: true, same_done_run: true, same_manifest_sha256: true,
      same_first_command_sha256: true, same_checker_receipts: true } }
    sourceAfter = verificationPluginConfiguration().source.digest
    globalAfter = snapshotGlobalOpenCodeConfig(roots, hmacKey)
    if (sourceAfter !== sourceBefore) throw new Error("plugin source identity changed during headless run")
    if (globalAfter.sha256 !== globalBefore.sha256) throw new Error("real-user OpenCode global configuration changed during headless run")
  } catch (error) {
    failure = privateError(error, authSecrets)
    if (runId) try {
      const failedRun = loadRun(project, runId)
      if (failedRun) {
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
    if (host) { hostStopped = await stopProcess(host.processInfo); host = undefined }
    try { await provider.close(); providerStopped = true } catch { providerStopped = false }
    if (authCopyPath) try { rmSync(authCopyPath, { force: true }) } catch { /* retain safe failure evidence */ }
    try { sourceAfter = verificationPluginConfiguration().source.digest } catch { sourceAfter = "unavailable" }
    try { globalAfter = snapshotGlobalOpenCodeConfig(roots, hmacKey) } catch { globalAfter = { entries: [], sha256: "unavailable" } as any }
    const base = { schema_version: 1, kind: "opencode-alg-v1-action-evidence-headless", generated_at: new Date().toISOString(),
      passed: failure === null && !!evidence && evidence.case_grade?.passed === true &&
        evidence.checker_retrieval?.passed === true && evidence.parent_dispatch?.passed === true &&
        compaction?.completed_summary_count === 1 && compaction?.receipt?.continuation?.completionLinked === true &&
        Object.keys(journalCheckpoints).length === 4 && new Set(Object.values(journalCheckpoints)).size === 1 &&
        restartVerified && hostStopped && providerStopped && provider.nonLoopbackRequests === 0 && sourceAfter === sourceBefore && globalAfter.sha256 === globalBefore.sha256,
      scope: "diagnostic: deterministic local parent/producer, one independently configured real checker; no production claim", case_id: options.caseId,
      model: { providerID: options.providerID, modelID: options.modelID, configured_output_limit: 8_192 },
      host: { executable, version, platform: process.platform, starts: restartVerified ? 2 : 1,
      clean_stops: hostStopped }, run: { run_id: runId || null, owner_session_id: ownerSessionId || null, terminal_status: terminalStatus,
        graph_done: terminalStatus === "done", evidence, failure_state: failureRun }, compaction, journal_checkpoints: journalCheckpoints,
      provider: { producer_endpoint: "loopback-only", checker_provider: options.providerID, request_count: provider.requests.length, requests: provider.requests.slice(0, 64),
        emitted_tools: provider.emissions,
        errors: provider.errors.slice(0, 16), error_log_truncated: provider.errors.length > 16,
        request_log_truncated: provider.requests.length > 64, non_loopback_requests: provider.nonLoopbackRequests,
        fixture_auth_sent: false, isolated_provider_auth_configured: !!options.authFile },
      isolation: { credentials_inherited: false, real_user_global_config_unchanged: globalAfter.sha256 === globalBefore.sha256,
        global_config_before_sha256: globalBefore.sha256, global_config_after_sha256: globalAfter.sha256,
        plugin_source_before_sha256: sourceBefore, plugin_source_after_sha256: sourceAfter },
      cleanup: { host_stopped: hostStopped, provider_stopped: providerStopped, isolated_auth_copy_removed: false, temporary_environment_removed: false,
        retained_failure_workspace: failure ? tempRoot : null }, failure }
    try {
      mkdirSync(dirname(outputPath), { recursive: true })
      const staged = `${outputPath}.${randomUUID()}.partial`
      writeFileSync(staged, `${JSON.stringify(base, null, 2)}\n`, { flag: "wx", mode: 0o600 })
      // Remove only the exclusively-created temporary root, after all owned processes stopped.
      if (!failure && hostStopped && providerStopped) rmSync(tempRoot, { recursive: true, force: true })
      temporaryRemoved = !existsSync(tempRoot)
      const completed = { ...base, passed: base.passed && temporaryRemoved, cleanup: { ...base.cleanup,
        isolated_auth_copy_removed: !authCopyPath || !existsSync(authCopyPath), temporary_environment_removed: temporaryRemoved } }
      const replacement = `${outputPath}.${randomUUID()}.final`
      writeFileSync(replacement, `${JSON.stringify(completed, null, 2)}\n`, { flag: "wx", mode: 0o600 })
      if (existsSync(outputPath)) throw new Error("refusing to overwrite an existing receipt")
      renameSync(replacement, outputPath)
      rmSync(staged, { force: true })
      outputPersisted = true
      return completed
    } catch {
      // A failed cleanup/publication retains the original terminal evidence and owned directory for diagnosis.
    }
  }
  if (!outputPersisted) throw new Error("headless receipt could not be persisted")
  const final = JSON.parse(readFileSync(outputPath, "utf8"))
  return { ...final, cleanup: { ...final.cleanup, isolated_auth_copy_removed: !authCopyPath || !existsSync(authCopyPath), temporary_environment_removed: temporaryRemoved } }
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
      bounds: { per_case_ms: MAX_RUN_MS, total_ms: MAX_TOTAL_MS, output_tokens: 8_192 },
      execution_note: "Producer and parent use deterministic local fixture roles. Each checker is a fresh real configured OpenCode provider/model. Diagnostic only; deterministic producer is disclosed.",
      model: { providerID: config.providerID, modelID: config.modelID }, source_sha256: sourceDigest, harness_sha256: harnessDigest,
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
        if (!result.cleanup?.host_stopped || !result.cleanup?.provider_stopped || !result.cleanup?.isolated_auth_copy_removed ||
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

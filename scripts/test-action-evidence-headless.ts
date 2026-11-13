import { createHash, randomBytes, randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createRun, loadRun } from "../src/store.ts"
import { ActionEvidenceJournal } from "../src/action-evidence.ts"
import { validateOpenCodeVersion, realUserGlobalConfigRoots, snapshotGlobalOpenCodeConfig, verificationPluginConfiguration } from "./live-verify.ts"
import { seedVerificationHostDependencies } from "./verification-host-dependencies.ts"

const MAX_RUN_MS = 180_000
const REQUEST_MS = 12_000
const BODY_LIMIT = 8 * 1024 * 1024
const EARLY_MARKER = "ACTION_EVIDENCE_EARLY_MARKER_V1"
const LATE_MARKER = "ACTION_EVIDENCE_LATE_MARKER_V1"
type Json = Record<string, any>

function sha(value: string | Uint8Array): string { return createHash("sha256").update(value).digest("hex") }
function safeError(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error"
  const message = error instanceof Error ? error.message : String(error)
  // Receipts intentionally retain only bounded, non-secret diagnostics.
  return `${/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(name) ? name : "Error"}: ${message.replace(/https?:\/\/[^\s"']+/g, "[url]").replace(/(?:token|key|secret|password|authorization)=?[^\s,;]+/gi, "[redacted]").slice(0, 500)}`
}
function assertDeadline(deadline: number, maximumMs = REQUEST_MS): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error("overall three-minute deadline exceeded")
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
function providerResponse(response: ServerResponse, body: any, choice: { text?: string; tool?: { name: string; args: Json } }): void {
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
    return
  }
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, object: "chat.completion", created: 1, model,
    choices: [{ index: 0, message, finish_reason: choice.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }))
}
interface ProviderCall { role: "parent" | "implementer" | "checker" | "unknown"; tool_names: string[]; calls: string[]; call_count: number }
interface ProviderError { role: ProviderCall["role"]; code: string; message: string }
function createProvider() {
  const requests: ProviderCall[] = []
  const errors: ProviderError[] = []
  let nonLoopbackRequests = 0
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
        const calls = calledTools(messages), parent = prompt.includes("ACTION_EVIDENCE_HEADLESS_PARENT_V1")
        const role: ProviderCall["role"] = parent ? "parent" : /^You are the \"implementer\" node/m.test(prompt) ? "implementer" : /^You are a checker in a fresh child session\./m.test(prompt) ? "checker" : "unknown"
        activeRole = role
        const receipt: ProviderCall = { role, tool_names: names.slice(0, 48), calls: calls.map(row => row.name).slice(-24), call_count: calls.length }
        requests.push(receipt)
        let choice: { text?: string; tool?: { name: string; args: Json } }
        if (role === "parent") {
          if (!calls.some(call => call.name === "alg_run")) choice = { tool: toolChoice(body, "alg_run", { run_id: RUN_ID }) }
          else choice = { text: "The deterministic local ALG run finished." }
        } else if (role === "implementer") {
          const bashCalls = calls.filter(call => call.name === "bash")
          if (bashCalls.length < 10) {
            const command = bashCalls.length === 0
              ? `node -e "/*${"x".repeat(3_200)}*/console.log('${EARLY_MARKER}')"`
              : `node -e "console.log('${LATE_MARKER}_${String(bashCalls.length).padStart(2, "0")}')"`
            choice = { tool: toolChoice(body, "bash", { command, description: bashCalls.length === 0 ? "Long harmless early marker command" : `Harmless later marker ${bashCalls.length}` }) }
          } else choice = { text: JSON.stringify({ summary: ["Executed ten harmless deterministic node commands."], files_touched: [],
            commands_run: [], risks: [], done: true }) }
        } else if (role === "checker") {
          const evidenceCalls = calls.filter(call => call.name === "alg_artifact")
          if (evidenceCalls.length === 0) choice = { tool: toolChoice(body, "alg_artifact", { evidence: "index" }) }
          else if (evidenceCalls.length === 1) {
            const records = toolResultRows(messages).flatMap(parseJsonDeep).flatMap(value => Array.isArray(value.records) ? value.records : [])
            const intent = records.find((row: any) => row.kind === "intent" && row.ordinal === 1) ?? records.find((row: any) => row.kind === "intent")
            if (!intent?.record_id) throw new Error("actual alg_artifact index omitted first intent record")
            choice = { tool: toolChoice(body, "alg_artifact", { evidence: "read", record_id: intent.record_id, offset: 0 }) }
          } else if (evidenceCalls.length === 2) {
            const records = toolResultRows(messages).flatMap(parseJsonDeep).flatMap(value => Array.isArray(value.records) ? value.records : [])
            const terminal = records.find((row: any) => row.kind === "terminal" && row.ordinal === 1) ?? records.find((row: any) => row.kind === "terminal")
            if (!terminal?.record_id) throw new Error("actual alg_artifact index omitted first terminal record")
            choice = { tool: toolChoice(body, "alg_artifact", { evidence: "read", record_id: terminal.record_id, offset: 0 }) }
          } else {
            const citations = [...new Set(toolResultRows(messages).flatMap(parseJsonDeep).flatMap(value =>
              JSON.stringify(value).match(/R[a-f0-9]{64}/g) ?? []))]
            if (citations.length < 2) throw new Error("checker did not receive both actual evidence page citations")
            choice = { text: JSON.stringify({ passed: true, failures: [], score: 10, notes: "Both retained host pages were read.",
              findings: [{ criterion_id: "C1", outcome: "supported", evidence_ids: citations.slice(0, 2), reason: "The retained intent and terminal page establish the fixed harmless command and its reported successful exit." }] }) }
          }
        } else throw new Error("provider could not classify the OpenCode request from its live prompt")
        providerResponse(response, body, choice)
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
  return { server, requests, errors, get nonLoopbackRequests() { return nonLoopbackRequests },
    listen: () => new Promise<string>((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", () => ok(`http://127.0.0.1:${(server.address() as any).port}/v1`)) }),
    close: () => !server.listening ? Promise.resolve() : new Promise<void>((ok, no) => server.close(error => error ? no(error) : ok())) }
}

const RUN_ID = "action-evidence-headless"
const OWNER_TITLE = "ALG action evidence headless acceptance parent"
const GOAL = "Execute a fixed harmless command sequence and verify its persisted host evidence."
const CRITERION = "The first long command is retained exactly and its terminal result reports exit code zero."

function writeConfig(path: string, endpoint: string, pluginSpec: string): void {
  const config = { $schema: "https://opencode.ai/config.json", plugin: [pluginSpec], model: "action-evidence-headless/deterministic",
    small_model: "action-evidence-headless/deterministic", autoupdate: false,
    provider: { "action-evidence-headless": { npm: "@ai-sdk/openai-compatible", name: "Local deterministic acceptance provider",
      options: { baseURL: endpoint }, models: { deterministic: { name: "Deterministic", limit: { context: 32_768, output: 2_048 } } } } },
    agent: { orchestrator: { mode: "primary", model: "action-evidence-headless/deterministic", steps: 8 } },
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
function firstCommand(): string { return `node -e "/*${"x".repeat(3_200)}*/console.log('${EARLY_MARKER}')"` }
function validateEvidence(project: string, run: any): Json {
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
  const command = firstCommand()
  if (intents.length !== 10 || manifest.coverage.observed_calls !== 10 || terminals.length !== 10 || manifest.coverage.completed !== 10 || manifest.coverage.unknown_terminal !== 0)
    throw new Error("persisted manifest does not contain ten paired calls")
  if (firstIntent?.command !== command || Buffer.byteLength(firstIntent.command, "utf8") <= 3_000) throw new Error("first long command was not retained byte-exactly")
  if (firstTerminal?.source !== "hook" && firstTerminal?.source !== "history") throw new Error("first terminal source is not a hook/history receipt")
  if (firstTerminal?.tool_status !== "completed" || firstTerminal?.exit_code_status !== "reported" || firstTerminal?.exit_code !== 0 || !String(firstTerminal?.output ?? "").includes(EARLY_MARKER))
    throw new Error("first terminal receipt does not prove the fixed marker and reported exit code zero")
  return { manifest_sha256: reference.sha256, manifest_path: reference.artifact_path, child_session_id: session,
    observed_calls: manifest.coverage.observed_calls, completed: manifest.coverage.completed, unknown_terminal: manifest.coverage.unknown_terminal,
    first_command_bytes: Buffer.byteLength(firstIntent.command, "utf8"), first_command_sha256: sha(firstIntent.command),
    first_terminal: { source: firstTerminal.source, tool_status: firstTerminal.tool_status, exit_code_status: firstTerminal.exit_code_status,
      exit_code: firstTerminal.exit_code, output_contains_early_marker: String(firstTerminal.output ?? "").includes(EARLY_MARKER) },
    late_commands: intents.slice(1).length }
}

export interface ActionEvidenceHeadlessOptions { hostExecutable: string; outputPath: string; timeoutMs?: number }
export async function runActionEvidenceHeadless(options: ActionEvidenceHeadlessOptions): Promise<Json> {
  const deadline = Date.now() + Math.min(MAX_RUN_MS, options.timeoutMs ?? MAX_RUN_MS)
  if (!isAbsolute(options.hostExecutable) || !isAbsolute(options.outputPath)) throw new Error("--host and --output must be absolute paths")
  const executable = realpathSync.native(options.hostExecutable), outputPath = resolve(options.outputPath)
  if (!existsSync(executable)) throw new Error("OpenCode host executable does not exist")
  const roots = realUserGlobalConfigRoots({ ...process.env }), hmacKey = randomBytes(32)
  const globalBefore = snapshotGlobalOpenCodeConfig(roots, hmacKey), sourceBefore = verificationPluginConfiguration().source.digest
  const tempRoot = resolve(mkdtempSync(join(tmpdir(), "alg-action-evidence-"))), project = join(tempRoot, "project")
  mkdirSync(project, { recursive: true })
  const env = isolatedEnv(join(tempRoot, "isolated-env")), provider = createProvider()
  let host: Awaited<ReturnType<typeof startHost>> | undefined, providerStopped = false, hostStopped = false
  let ownerSessionId = "", runId = "", terminalStatus = "unknown", restartVerified = false
  let evidence: Json | null = null, failure: string | null = null, failureRun: Json | null = null, outputPersisted = false, temporaryRemoved = false
  let sourceAfter = sourceBefore, globalAfter = globalBefore, version = "unknown"
  try {
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
    const endpoint = await provider.listen(); writeConfig(env.OPENCODE_CONFIG!, endpoint, plugin.source.spec)
    writeFileSync(env.OPENCODE_ALG_CONFIG!, JSON.stringify({ skillEvolution: { enabled: false }, sessionMemory: { mode: "off" }, workspace: { mode: "observe" } }), { flag: "wx", mode: 0o600 })
    host = await startHost(executable, project, env, deadline)
    const created = await api(host.base, project, "/session", "POST", { title: OWNER_TITLE }, deadline)
    ownerSessionId = typeof created?.id === "string" ? created.id : ""
    if (!ownerSessionId) throw new Error("OpenCode did not create the parent host session")
    const graph = { name: "action-evidence-headless", max_global_attempts: 4, max_concurrency: 1, nodes: [
      { id: "work", agent: "implementer", depends_on: [], description: "Run the fixed harmless command sequence for action evidence acceptance.", loop: { max_attempts: 2, gate: "schema" } },
      { id: "check", agent: "checker", depends_on: ["work"], inputs: { claimed: "work" }, verification: { version: 1 },
        feedback_to: "work", isolated_check: true, loop: { max_attempts: 2, gate: "schema" } },
    ] }
    const run = createRun({ runId: RUN_ID, projectDirectory: project, ownerSessionId, parentSessionId: ownerSessionId,
      goal: GOAL, criteria: [CRITERION], graph, modelSnapshot: {
        implementer: { providerID: "action-evidence-headless", modelID: "deterministic" },
        checker: { providerID: "action-evidence-headless", modelID: "deterministic" },
      }, allowFilesystemRoot: true, treatProjectAsFilesystemRoot: true })
    runId = run.run_id
    await api(host.base, project, `/session/${encodeURIComponent(ownerSessionId)}/message`, "POST", {
      model: { providerID: "action-evidence-headless", modelID: "deterministic" }, agent: "orchestrator",
      parts: [{ type: "text", text: `ACTION_EVIDENCE_HEADLESS_PARENT_V1\nRun the already-owned run ${runId} by calling alg_run once. Do not use other tools; stop after its result.` }],
    }, deadline, MAX_RUN_MS)
    let persisted = loadRun(project, runId)
    terminalStatus = persisted?.status ?? "missing"
    if (!persisted) throw new Error("actual alg_run did not persist its owned run")
    evidence = validateEvidence(project, persisted)
    if (persisted.status !== "done" || persisted.nodes?.work?.status !== "done" || persisted.nodes?.check?.status !== "done") throw new Error("actual alg_run did not finish both graph nodes")
    const providerRoles = provider.requests.map(row => row.role)
    if (!providerRoles.includes("parent") || !providerRoles.includes("implementer") || !providerRoles.includes("checker") || providerRoles.includes("unknown")) throw new Error("provider did not observe all expected live model roles")
    const checkerCalls = provider.requests.filter(row => row.role === "checker").flatMap(row => row.calls)
    if (!checkerCalls.includes("alg_artifact") || checkerCalls.some(name => !["alg_artifact"].includes(name))) throw new Error("checker attempted a tool outside assigned evidence retrieval")
    const history = await api(host.base, project, `/session/${encodeURIComponent(ownerSessionId)}/message?limit=1000`, "GET", undefined, deadline)
    if (!Array.isArray(history) || !history.some((message: any) => (message.parts ?? []).some((part: any) => part.type === "tool" && part.tool === "alg_run" && part.state?.status === "completed")))
      throw new Error("parent transcript does not retain the completed actual alg_run tool call")
    const called = provider.requests.filter(row => row.role === "implementer").flatMap(row => row.calls)
    if (called.filter(name => name === "bash").length < 10) throw new Error("implementer transcript did not retain ten actual bash tool calls")
    const globalDuring = snapshotGlobalOpenCodeConfig(roots, hmacKey)
    if (globalDuring.sha256 !== globalBefore.sha256) throw new Error("real-user OpenCode global configuration changed during isolated run")
    await stopProcess(host.processInfo); hostStopped = host.processInfo.exited(); host = undefined
    host = await startHost(executable, project, env, deadline)
    const restored = await api(host.base, project, `/session/${encodeURIComponent(ownerSessionId)}`, "GET", undefined, deadline)
    persisted = loadRun(project, runId)
    if (restored?.id !== ownerSessionId || persisted?.status !== "done") throw new Error("session/run did not reload after OpenCode server restart")
    const afterRestart = validateEvidence(project, persisted)
    if (afterRestart.manifest_sha256 !== evidence.manifest_sha256 || afterRestart.first_command_sha256 !== evidence.first_command_sha256) throw new Error("persisted action evidence changed across server restart")
    restartVerified = true
    evidence = { ...evidence, after_restart: { same_owner_session: true, same_done_run: true, same_manifest_sha256: true, same_first_command_sha256: true } }
    sourceAfter = verificationPluginConfiguration().source.digest
    globalAfter = snapshotGlobalOpenCodeConfig(roots, hmacKey)
    if (sourceAfter !== sourceBefore) throw new Error("plugin source identity changed during headless run")
    if (globalAfter.sha256 !== globalBefore.sha256) throw new Error("real-user OpenCode global configuration changed during headless run")
  } catch (error) {
    failure = safeError(error)
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
    try { sourceAfter = verificationPluginConfiguration().source.digest } catch { sourceAfter = "unavailable" }
    try { globalAfter = snapshotGlobalOpenCodeConfig(roots, hmacKey) } catch { globalAfter = { entries: [], sha256: "unavailable" } as any }
    const base = { schema_version: 1, kind: "opencode-alg-v1-action-evidence-headless", generated_at: new Date().toISOString(),
      passed: failure === null && !!evidence && restartVerified && hostStopped && providerStopped && provider.nonLoopbackRequests === 0 && sourceAfter === sourceBefore && globalAfter.sha256 === globalBefore.sha256,
      scope: "deterministic local mechanical qualification; not a model benchmark", host: { executable, version, platform: process.platform, starts: restartVerified ? 2 : 1,
      clean_stops: hostStopped }, run: { run_id: runId || null, owner_session_id: ownerSessionId || null, terminal_status: terminalStatus,
        graph_done: terminalStatus === "done", evidence, failure_state: failureRun }, provider: { endpoint: "loopback-only", request_count: provider.requests.length, requests: provider.requests.slice(0, 64),
        errors: provider.errors.slice(0, 16), error_log_truncated: provider.errors.length > 16,
        request_log_truncated: provider.requests.length > 64, non_loopback_requests: provider.nonLoopbackRequests, no_auth: true },
      isolation: { credentials_inherited: false, real_user_global_config_unchanged: globalAfter.sha256 === globalBefore.sha256,
        global_config_before_sha256: globalBefore.sha256, global_config_after_sha256: globalAfter.sha256,
        plugin_source_before_sha256: sourceBefore, plugin_source_after_sha256: sourceAfter },
      cleanup: { host_stopped: hostStopped, provider_stopped: providerStopped, temporary_environment_removed: false,
        retained_failure_workspace: failure ? tempRoot : null }, failure }
    try {
      mkdirSync(dirname(outputPath), { recursive: true })
      const staged = `${outputPath}.${randomUUID()}.partial`
      writeFileSync(staged, `${JSON.stringify(base, null, 2)}\n`, { flag: "wx", mode: 0o600 })
      // Remove only the exclusively-created temporary root, after all owned processes stopped.
      if (!failure && hostStopped && providerStopped) rmSync(tempRoot, { recursive: true, force: true })
      temporaryRemoved = !existsSync(tempRoot)
      const completed = { ...base, passed: base.passed && temporaryRemoved, cleanup: { ...base.cleanup, temporary_environment_removed: temporaryRemoved } }
      const replacement = `${outputPath}.${randomUUID()}.final`
      writeFileSync(replacement, `${JSON.stringify(completed, null, 2)}\n`, { flag: "wx", mode: 0o600 })
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
  return { ...final, cleanup: { ...final.cleanup, temporary_environment_removed: temporaryRemoved } }
}

function parseArgs(args: string[]): ActionEvidenceHeadlessOptions {
  let hostExecutable = "", outputPath = ""
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host") hostExecutable = args[++i] ?? ""
    else if (args[i] === "--output") outputPath = args[++i] ?? ""
    else if (args[i] === "--help" || args[i] === "-h") throw new Error("Usage: bun run scripts/test-action-evidence-headless.ts --host <absolute-opencode-executable> --output <absolute-json-path>")
    else throw new Error(`Unknown option ${args[i]}`)
  }
  if (!hostExecutable || !isAbsolute(hostExecutable)) throw new Error("--host requires an absolute executable path")
  if (!outputPath || !isAbsolute(outputPath)) throw new Error("--output requires an absolute receipt path")
  return { hostExecutable, outputPath }
}

if (import.meta.main) {
  try {
    const result = await runActionEvidenceHeadless(parseArgs(process.argv.slice(2)))
    console.log(JSON.stringify({ check: "opencode-alg-v1-action-evidence-headless", passed: result.passed,
      output: resolve(process.argv[process.argv.indexOf("--output") + 1]!), terminal_status: result.run?.terminal_status,
      observed_calls: result.run?.evidence?.observed_calls, checker_retrieval: result.run?.evidence?.checker_retrieval,
      server_restart_verified: result.run?.evidence?.after_restart?.same_manifest_sha256, failure: result.failure }))
    if (!result.passed) process.exitCode = 1
  } catch (error) { console.error(safeError(error)); process.exitCode = 1 }
}

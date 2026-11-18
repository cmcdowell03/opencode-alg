import { createServer } from "node:http"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve, isAbsolute } from "node:path"
import { createRun, loadRun } from "../src/store.ts"
import { createAlgTools } from "../src/tools.ts"
import { ALG_TOOL_IDS } from "../src/types.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { createComparativeCases, contestantView, comparativeIdentity, normalizedParticleReadSha256, particleCsv, scoreParticleAnswer, type ParticleAnswer, type ObservedAccess } from "./comparative-benchmark-fixtures.ts"
import { EXPECTED_QUALIFICATION_CONTROL_COUNT } from "./comparative-benchmark-qualification.ts"
import { initializeComparativeMemory, verifyComparativeMemory } from "./comparative-benchmark-memory.ts"
import { startComparativeJobService } from "./comparative-benchmark-service.ts"
import { freePort, launch, isolatedEnv, initializeBenchmarkWorkspaceGit } from "./build-benchmark.ts"
import { sendBenchmarkPrompt } from "./build-benchmark-transport.ts"
import { verificationPluginConfiguration, stopCapturedProcess } from "./live-verify.ts"
import { seedVerificationHostDependencies } from "./verification-host-dependencies.ts"

type Config = { hostExecutable: string; outputRoot: string; qualificationPath: string; deterministicSmoke: true; orderSeed?: number; trialMs?: number;
  diagnosticSelection?: { blindCaseId: string; arms: Array<"native-build" | "scoped-evidence-skill" | "full-alg"> } }
const sha = (value: unknown) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value as any : JSON.stringify(value)).digest("hex")
const modelDefault = { providerID: "comparative-local", modelID: "deterministic" }
const STAGE = "COMPARATIVE_INITIAL_HANDOFF_V1"
const CONTINUE = "COMPARATIVE_RECOVER_AFTER_HANDOFF_V1"

function toolInfo(body: any) { return (Array.isArray(body?.tools) ? body.tools : []).map((row: any) => row?.function ?? row) }
function argFor(tool: any, field: "read" | "write", values: { path: string; content?: string }) {
  const props = tool.parameters?.properties ?? tool.inputSchema?.properties ?? {}, required = tool.parameters?.required ?? tool.inputSchema?.required ?? []
  const args: Record<string, unknown> = {}
  for (const key of required) {
    if (/path|file/i.test(key)) args[key] = values.path
    else if (/content|text|data/i.test(key)) args[key] = values.content ?? ""
    else if (/description/i.test(key)) args[key] = `Read or write comparative fixture ${field}`
    else args[key] = ""
  }
  for (const key of Object.keys(props)) {
    if (/path|file/i.test(key)) args[key] ??= values.path
    if (/content|text|data/i.test(key)) args[key] ??= values.content ?? ""
    if (/description/i.test(key)) args[key] ??= `Read or write comparative fixture ${field}`
  }
  return args
}
function csvFromMessages(messages: any[]): string | undefined {
  const candidates: string[] = []
  const visit = (value: unknown, depth = 0) => {
    if (depth > 7 || value == null) return
    if (typeof value === "string") { candidates.push(value); try { visit(JSON.parse(value), depth + 1) } catch {} }
    else if (Array.isArray(value)) for (const child of value) visit(child, depth + 1)
    else if (typeof value === "object") for (const child of Object.values(value as Record<string, unknown>)) visit(child, depth + 1)
  }
  visit(messages.filter(message => message.role === "tool"))
  for (const text of candidates) {
    // OpenCode's native read tool wraps file contents and numbers each line.
    const lines = text.split(/\r?\n/).map(line => line.replace(/^\s*\d+: /, ""))
    const header = lines.indexOf("chamber,product,inspection_revision,particles,defects")
    if (header < 0) continue
    const rows = lines.slice(header + 1, header + 9)
    if (rows.length === 8 && rows.every(line => /^[AB],P[12],r[12],\d+,\d+$/.test(line)))
      return [lines[header], ...rows].join("\n")
  }
  return undefined
}
function answerFromCsv(csv: string): ParticleAnswer {
  const rows = csv.trim().split(/\r?\n/).slice(1).map(line => {
    const [chamber, product, inspectionRevision, particles, defects] = line.split(",")
    return { chamber, product, inspectionRevision, particles: Number(particles), defects: Number(defects) }
  })
  const rate = (chamber: string, product?: string, revision?: string) => {
    const group = rows.filter(row => row.chamber === chamber && (!product || row.product === product) && (!revision || row.inspectionRevision === revision))
    return group.reduce((sum, row) => sum + row.defects, 0) / group.reduce((sum, row) => sum + row.particles, 0)
  }
  const strata = { p1r1: rate("A", "P1", "r1") - rate("B", "P1", "r1"), p1r2: rate("A", "P1", "r2") - rate("B", "P1", "r2"),
    p2r1: rate("A", "P2", "r1") - rate("B", "P2", "r1"), p2r2: rate("A", "P2", "r2") - rate("B", "P2", "r2") }
  const p1 = (strata.p1r1 + strata.p1r2) / 2, p2 = (strata.p2r1 + strata.p2r2) / 2, standardized = (p1 + p2) / 2,
      a = rate("A"), b = rate("B"), conclusion = Math.abs(standardized) <= 0.025 ? "inspection_revision_mix_explains_association" :
      Math.abs(standardized) >= 0.075 ? "chamber_effect_persists" : "inconclusive"
  return { raw: { chamberA: a, chamberB: b, difference: a - b }, matched: { standardizedDifference: standardized, p1Difference: p1, p2Difference: p2 },
    matchedStrata: strata, conclusion, nextMeasurement: conclusion === "chamber_effect_persists" ? "balanced_chamber_crossover" : "inspection_revision_validation" }
}

function startDeterministicProvider(publicSkill: string) {
  const calls: any[] = [], errors: string[] = []
  const server = createServer((request, response) => {
    const json = (status: number, value: unknown) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)) }
    if (request.method === "GET" && /\/models$/.test(request.url ?? "")) return json(200, { data: [{ id: "deterministic" }] })
    if (request.method !== "POST" || !/\/chat\/completions$/.test(request.url ?? "")) return json(404, { error: "not_found" })
    const chunks: Buffer[] = []; let length = 0
    request.on("data", chunk => { length += chunk.length; if (length <= 4 * 1024 * 1024) chunks.push(Buffer.from(chunk)) })
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")), messages = body.messages ?? [], lastUserIndex = messages.map((m: any) => m.role).lastIndexOf("user"),
          current = messages.slice(lastUserIndex), user = String(messages[lastUserIndex]?.content ?? ""), tools = toolInfo(body), path = user.match(/data\/[A-Za-z0-9-]+\.csv/)?.[0]
        if (!path) throw Error("deterministic provider could not identify the disclosed data path")
        const callsThisTurn = current.flatMap((message: any) => message.tool_calls ?? []).map((call: any) => call.function?.name)
        const csv = csvFromMessages(current), phase = user.includes(CONTINUE) ? "analysis" : user.includes(STAGE) ? "handoff" : "analysis"
        let selected: any
        if (phase === "analysis" && !callsThisTurn.includes("bash")) {
          const base = user.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0]
          if (!base) throw Error("post-handoff prompt omitted the local accepted-query service endpoint")
          selected = tools.find((tool: any) => tool.name === "bash")
          if (!selected) throw Error("OpenCode did not expose native bash tool for local accepted-query recovery")
          const recoverJob = [
            "async function get(path){const r=await fetch('" + base + "'+path);if(!r.ok)throw Error('job unavailable');return r.json()}",
            "async function recover(){const [pending]=await get('/pending');const job=await get('/lookup?key='+encodeURIComponent(pending.key));",
            "if(job.jobId!==pending.jobId||job.sourceRevision!=='particle-v3')throw Error('lookup mismatch');",
            "const result=await get('/jobs/'+encodeURIComponent(job.jobId));",
            "if(result.jobId!==job.jobId||result.sourceRevision!==job.sourceRevision)throw Error('result mismatch');console.log(JSON.stringify(result))}",
            "recover().catch(()=>{process.exitCode=1})",
          ].join("")
          const command = `node -e "${recoverJob}"`
          const args = argFor(selected, "read", { path })
          const props = selected.parameters?.properties ?? selected.inputSchema?.properties ?? {}
          const field = Object.keys(props).find((name: string) => /command/i.test(name)) ?? "command"
          args[field] = command; selected = { name: "bash", arguments: args }
        } else if (!callsThisTurn.includes("read")) {
          selected = tools.find((tool: any) => tool.name === "read")
          if (!selected) throw Error("OpenCode did not expose native read tool")
          selected = { name: "read", arguments: argFor(selected, "read", { path }) }
        } else if (phase === "handoff" && !callsThisTurn.includes("write")) {
          selected = tools.find((tool: any) => tool.name === "write")
          if (!selected) throw Error("OpenCode did not expose native write tool")
          selected = { name: "write", arguments: argFor(selected, "write", { path: "handoff-note.json", content: JSON.stringify({ status: "inspected", dataset: path }) }) }
        } else if (phase === "analysis" && !callsThisTurn.includes("write")) {
          if (!csv) throw Error("read tool result did not expose fixture CSV to deterministic provider")
          selected = tools.find((tool: any) => tool.name === "write")
          if (!selected) throw Error("OpenCode did not expose native write tool")
          const toolResults = current.filter((message: any) => message.role === "tool")
          const manifestRef = JSON.stringify(toolResults).match(/synthetic:manifest:[a-f0-9-]{36}/)?.[0]
          if (!manifestRef) throw new Error("Accepted result manifest missing from tool responses")
          selected = { name: "write", arguments: argFor(selected, "write", { path: "answer.json", content: JSON.stringify({ ...answerFromCsv(csv), manifestRef }) }) }
        } else selected = null
        const id = `comparative-${randomUUID()}`
        const systemParts = (body.messages ?? []).filter((message: any) => message.role === "system").map((message: any) => message.content)
        const systemText = systemParts.flatMap((part: unknown) =>
          typeof part === "string" ? [part] : Array.isArray(part)
            ? part.filter(entry => entry?.type === "text" && typeof entry.text === "string").map(entry => entry.text)
            : []).join("\n")
        const algToolsAvailable = tools.map((tool: any) => tool.name).filter((name: string) => name.startsWith("alg_")).sort()
        calls.push({ model: body.model, tool: selected?.name ?? null, stage: phase, alg_tools_available: algToolsAvailable,
          dag_tools_available: algToolsAvailable.filter((name: string) => !["alg_memory_search", "alg_memory_read", "alg_context_status", "alg_memory_propose"].includes(name)),
          system_text_observed: systemParts.length > 0, recovery_skill_text_observed: systemText.includes(publicSkill),
          recovery_skill_name_observed: systemText.toLowerCase().includes("evidence-recovery") })
        const message = selected ? { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: selected.name, arguments: JSON.stringify(selected.arguments) } }] }
          : { role: "assistant", content: JSON.stringify({ summary: ["Completed the requested dataset stage."], files_touched: phase === "handoff" ? ["handoff-note.json"] : ["answer.json"], commands_run: [], risks: [], done: true }) }
        const payload = { id, object: "chat.completion", created: 1, model: body.model ?? "deterministic", choices: [{ index: 0, message, finish_reason: selected ? "tool_calls" : "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
        if (body.stream) {
          response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", connection: "close" })
          const delta = selected ? { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: selected.name, arguments: JSON.stringify(selected.arguments) } }] } : { role: "assistant", content: message.content }
          response.end(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: payload.model, choices: [{ index: 0, delta: {}, finish_reason: selected ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`)
        } else json(200, payload)
      } catch (error) { errors.push(/read tool result/.test(String(error)) ? "fixture_read_unavailable" : /required native/.test(String(error)) ? "native_tool_unavailable" : "provider_protocol_error"); json(400, { error: { message: "deterministic fixture provider protocol error" } }) }
    })
  })
  return { server, calls, errors, async listen() { await new Promise<void>((ok, no) => { server.once("error", no); server.listen(0, "127.0.0.1", ok) }); return `http://127.0.0.1:${(server.address() as any).port}/v1` },
    async stop() { await new Promise<void>((ok, no) => server.close(error => error ? no(error) : ok())) } }
}

async function api(base: string, project: string, path: string, password: string, body?: unknown, ms = 15_000) {
  const url = new URL(path, base); url.searchParams.set("directory", project)
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms) })
  const text = await response.text()
  if (!response.ok) throw new Error(`opencode_http_${response.status}:${path}:${text.slice(0, 500)}`)
  return text ? JSON.parse(text) : null
}
async function launchHost(config: Config, dir: string, project: string) {
  const env = isolatedEnv(dir), port = await freePort(), password = randomBytes(24).toString("hex"), base = `http://127.0.0.1:${port}`
  const child = launch(config.hostExecutable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], project, { ...env, OPENCODE_SERVER_PASSWORD: password })
  let ready = false
  for (let i = 0; i < 120; i++) { try { await api(base, project, "/global/health", password, undefined, 500); ready = true; break } catch { await new Promise(r => setTimeout(r, 250)) } }
  if (!ready) {
    const startupText = `${child.stderr()}\n${child.stdout()}`
    const startupCategory = /Cannot find package|Cannot find module|ModuleNotFound/i.test(startupText) ? "missing_module" :
      /plugin.*(fail|error)|failed to load plugin/i.test(startupText) ? "plugin_load" :
      /config.*(invalid|error|parse)|invalid.*config/i.test(startupText) ? "config" :
      /EADDRINUSE|address already in use/i.test(startupText) ? "port_conflict" :
      /EACCES|EPERM|permission denied/i.test(startupText) ? "permission" : startupText.trim() ? "other_output" : "no_output"
    const bootCode = /Cannot find package|Cannot find module|ModuleNotFound/i.test(startupText) ? "host_boot_missing_dependency" :
      /plugin.*(fail|error)|failed to load plugin/i.test(startupText) ? "host_boot_plugin_load_failed" :
      /config.*(invalid|error|parse)|invalid.*config/i.test(startupText) ? "host_boot_config_invalid" :
      child.exit().observed ? "host_boot_process_exited" : "host_boot_health_timeout"
    const cleanup = await stopCapturedProcess(child)
    throw Object.assign(new Error(bootCode), { safeDiagnostic: { category: startupCategory, exit_code: child.exit().code, cleanup } })
  }
  return { env, base, password, child, api: (path: string, body?: unknown, ms?: number) => api(base, project, path, password, body, ms) }
}

function errorCode(error: unknown) {
  if (!(error instanceof Error)) return "unclassified_non_error_throw"
  const explicit = new Map([
    ["selected same model is unavailable in OpenCode", "selected_model_unavailable"],
    ["ALG memory tool registration missing", "alg_memory_tool_registration_missing"],
    ["ALG graph tool registration missing", "alg_graph_tool_registration_missing"],
    ["ALG leaked into native Build arm", "native_arm_alg_tool_leak"],
    ["Build-scoped ALG tool map differs from the memory-only allowlist", "scoped_tool_map_mismatch"],
    ["A treatment continuation lacked emitted hook or observed SYSTEM skill text", "treatment_skill_delivery_not_observed"],
    ["alg_run first wave failed", "alg_initial_wave_failed"],
    ["ALG graph/transfer/model retention receipt mismatch", "alg_graph_retention_mismatch"],
  ]).get(error.message)
  if (explicit) return explicit
  const diagnostic = (error as Error & { safeDiagnostic?: { code?: string } }).safeDiagnostic
  if (diagnostic?.code) return diagnostic.code
  if (/^host_boot_[a-z_]+$/.test(error.message)) return error.message
  return "unclassified_exception"
}

function parseAnswer(project: string): ParticleAnswer {
  const value = JSON.parse(readFileSync(join(project, "answer.json"), "utf8"))
  if (!value || typeof value !== "object") throw new Error("answer.json is not an object")
  return value
}
export function hostAccess(messages: any[], project: string, postHandoffSessions: ReadonlySet<string>): ObservedAccess[] {
  const events: ObservedAccess[] = []
  for (const message of messages) for (const part of message.parts ?? []) if (part?.type === "tool") {
    const input = part.state?.input ?? part.input ?? {}, path = input.filePath ?? input.path ?? input.file_path
    const state = part.state, tool = String(part.tool ?? part.name ?? "unknown")
    const resultObserved = state?.status === "completed" && typeof state.output === "string"
    const sessionId = String(message.info?.sessionID ?? message.sessionID ?? "")
    if (typeof part.sessionID === "string" && part.sessionID !== sessionId) continue
    const absolute = typeof path === "string" ? resolve(project, path) : "", relativePath = absolute ? relative(project, absolute) : ""
    const safePath = relativePath && relativePath !== ".." && !relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(relativePath)
      ? relativePath.replaceAll("\\", "/") : undefined
    events.push({ tool, path: safePath, callId: part.callID ?? part.id, sessionId,
      afterHandoff: postHandoffSessions.has(sessionId), resultObserved,
      startedAtMs: state?.time?.start, completedAtMs: state?.time?.end,
      readContentSha256: resultObserved && tool === "read" ? normalizedParticleReadSha256(state.output) : undefined })
  }
  return events
}

export async function runComparativeOpenCode(config: Config) {
  const outputRoot = resolve(config.outputRoot), repo = resolve(import.meta.dir, ".."), allCases = createComparativeCases(),
    orderSeed = config.orderSeed ?? 20261118, trialMs = config.trialMs ?? 180_000
  const cases = config.diagnosticSelection ? allCases.filter(c => c.blindId === config.diagnosticSelection!.blindCaseId) : allCases
  const requestedArms = config.diagnosticSelection?.arms ?? ["native-build", "scoped-evidence-skill", "full-alg"] as const
  if (config.diagnosticSelection && (cases.length !== 1 || !requestedArms.length || new Set(requestedArms).size !== requestedArms.length))
    throw new Error("diagnosticSelection must identify one known blind case and distinct arms")
  if (existsSync(outputRoot)) throw new Error("outputRoot already exists; refusing overwrite")
  if (!config.hostExecutable) throw new Error("hostExecutable is required")
  if (config.deterministicSmoke !== true) throw new Error("this increment supports deterministic local OpenCode smoke only")
  const providerID = modelDefault.providerID, modelID = modelDefault.modelID
  if (!config.qualificationPath) throw new Error("qualificationPath is required; run the offline qualification first")
  const qualification = JSON.parse(readFileSync(resolve(config.qualificationPath), "utf8"))
  if (qualification.schema !== "alg-comparative-qualification-v2" || qualification.passed !== true ||
    JSON.stringify(qualification.identity) !== JSON.stringify(comparativeIdentity()) || qualification.rows?.length !== EXPECTED_QUALIFICATION_CONTROL_COUNT ||
    qualification.rows.some((row: any) => !row.passed)) throw new Error("comparative scorer qualification is stale, incomplete, or failed")
  for (const file of ["comparative-benchmark-fixtures.ts", "comparative-benchmark-service.ts", "comparative-benchmark-memory.ts", "comparative-benchmark-opencode.ts", "comparative-benchmark-qualification.ts"]) {
    const current = sha(readFileSync(join(repo, "scripts", file)))
    if (qualification.source_hashes?.[file] !== current) throw new Error(`qualification source identity changed: ${file}`)
  }
  mkdirSync(outputRoot, { recursive: true })
  const localProvider = startDeterministicProvider(cases[0]!.recoverySkill)
  let localBase: string | undefined, fatal: string | null = null, fatalStage: string | null = null
  localBase = await localProvider.listen()
  const rows: any[] = cases.flatMap(c => requestedArms.map(arm => ({ blind_case_id: c.blindId, arm, status: "issued_not_started", cleanup_passed: false })))
  const identity = comparativeIdentity(), begun = new Date().toISOString()
  const rowFor = (blindId: string, arm: string) => rows.find(row => row.blind_case_id === blindId && row.arm === arm)!
  let suiteStage = "before_trials"
  const sourceHashes = Object.fromEntries(["comparative-benchmark-opencode.ts", "comparative-benchmark-fixtures.ts", "comparative-benchmark-service.ts"].map(file =>
    [file, sha(readFileSync(join(repo, "scripts", file))) ]))
  try {
    for (const c of cases) {
      const armOrder = [...requestedArms].sort((a, b) => sha(`${orderSeed}:${c.id}:${a}`).localeCompare(sha(`${orderSeed}:${c.id}:${b}`)))
      for (const arm of armOrder) {
        const trialId = `${c.blindId}-${arm}`, dir = join(outputRoot, trialId), project = join(dir, "project")
        const providerCallStart = localProvider.calls.length, providerErrorStart = localProvider.errors.length
        let cleanupPassed = true, setupStage = "project_directory"
        let host: Awaited<ReturnType<typeof launchHost>> | undefined, hostCleanupReceipt: any = null, hostLaunchAttempted = false
        let service: Awaited<ReturnType<typeof startComparativeJobService>> | undefined
        suiteStage = "project_directory"
        try {
        mkdirSync(project, { recursive: true })
        suiteStage = "job_service_start"
        service = await startComparativeJobService(c)
        const activeService = service
        suiteStage = "arm_setup"
        const jobUrl = activeService.url
        const readme = `Local accepted-query API (identical for every arm): GET ${jobUrl}/pending lists the already accepted query; GET ${jobUrl}/lookup?key=<idempotency-key> recovers it; GET ${jobUrl}/jobs/<job-id> reads its result. POST ${jobUrl}/submit is forbidden and records a duplicate attempt. Current dataset revision: particle-v3.`
        mkdirSync(dirname(join(project, c.dataPath)), { recursive: true })
        writeFileSync(join(project, c.dataPath), particleCsv(c), { flag: "wx" })
        writeFileSync(join(project, "README.md"), readme, { flag: "wx" })
        setupStage = "mission"
        writeFileSync(join(project, "mission.json"), JSON.stringify({ task: "Compare crude chamber rates with rates matched by product and inspection revision.", dataset: c.dataPath,
          output: { path: "answer.json", fields: ["raw.chamberA", "raw.chamberB", "raw.difference", "matched.standardizedDifference", "matched.p1Difference", "matched.p2Difference",
            "matchedStrata.p1r1", "matchedStrata.p1r2", "matchedStrata.p2r1", "matchedStrata.p2r2", "conclusion", "nextMeasurement", "manifestRef"] },
          conclusionChoices: ["chamber_effect_persists", "inspection_revision_mix_explains_association", "inconclusive"],
          nextMeasurementChoices: ["balanced_chamber_crossover", "inspection_revision_validation", "repeat_crude_counts"], units: "proportions" }, null, 2) + "\n", { flag: "wx" })
        const view = contestantView(c, arm as any)
        const skillPath = join(project, ".opencode/skills/evidence-recovery/SKILL.md")
        mkdirSync(dirname(skillPath), { recursive: true })
        writeFileSync(skillPath, `---\nname: evidence-recovery\ndescription: Recover scoped evidence after a controller handoff\n---\n${c.recoverySkill}\n`, { flag: "wx" })
        if (arm !== "native-build") {
          writeFileSync(join(project, "handoff-evidence.md"), view.durableEvidence!, { flag: "wx" })
        }
        setupStage = "project_git"
        initializeBenchmarkWorkspaceGit(project)
        const env = isolatedEnv(dir), configRoot = join(env.XDG_CONFIG_HOME!, "opencode")
        setupStage = "host_plugin_configuration"
        seedVerificationHostDependencies(configRoot, repo)
        const plugin = verificationPluginConfiguration(repo), model = `${providerID}/${modelID}`
        setupStage = "agent_config"
        if (arm !== "native-build") for (const role of ["orchestrator", "implementer", "researcher", "checker"]) {
          const target = join(configRoot, "agents", `${role}.md`); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, readFileSync(join(repo, "agents", `${role}.md`)))
        }
        const provider = { [providerID]: { npm: "@ai-sdk/openai-compatible", name: "Local deterministic comparative provider",
          options: { baseURL: localBase }, models: { [modelID]: { name: "Deterministic comparative", limit: { context: 32768, output: 4096 } } } } }
        const scopedMemoryTools = ["alg_memory_search", "alg_memory_read", "alg_context_status", "alg_memory_propose"]
        const pluginEnabled = arm === "scoped-evidence-skill" || arm === "full-alg"
        const agentNames = ["build", "general", "explore", "compaction", "summary", "title", ...(arm === "full-alg" ? ["orchestrator", "implementer", "researcher", "checker"] : [])]
        const agentConfig = Object.fromEntries(agentNames.map(role => [role, { model, ...(role === "orchestrator" ? { steps: 6 } : {}),
          ...(arm === "scoped-evidence-skill" && role === "build" ? { tools: Object.fromEntries(ALG_TOOL_IDS.map(id => [id, scopedMemoryTools.includes(id)])) } : {}) }]))
        const opencodeConfig = { $schema: "https://opencode.ai/config.json", plugin: pluginEnabled ? [plugin.source.spec] : [], autoupdate: false, share: "disabled", snapshot: false,
          model, small_model: model, provider, permission: { "*": "allow", external_directory: "deny", webfetch: "deny", websearch: "deny", question: "deny" }, mcp: {},
          compaction: { auto: true, prune: true }, skills: { paths: [join(project, ".opencode/skills")] }, agent: agentConfig }
        setupStage = "host_config"
        writeFileSync(env.OPENCODE_CONFIG!, JSON.stringify(opencodeConfig, null, 2), { flag: "wx" })
        writeFileSync(env.OPENCODE_ALG_CONFIG!, JSON.stringify({ sessionMemory: { mode: pluginEnabled ? "assist" : "off" }, skillEvolution: { enabled: false } }), { flag: "wx" })
        let status = "failed", failureCode: string | null = null, score: any = null, graphReceipt: any = null
        const postHandoffSessions = new Set<string>()
        const sessions: string[] = [], messageHistories: any[] = [], armStart = Date.now()
        let handoffSequence = 0
        let armStage = "host_launch"
        try {
          hostLaunchAttempted = true
          host = await launchHost(config, dir, project)
          armStage = "provider_selection"
          const providers = await host.api("/provider"), found = providers.all?.find((row: any) => row.id === providerID)?.models?.[modelID]
          if (!found || !providers.connected?.includes(providerID)) throw new Error("selected same model is unavailable in OpenCode")
          armStage = "tool_ids_endpoint"
          const registered = await host.api("/experimental/tool/ids")
          armStage = "tool_ids_validation"
          if (pluginEnabled && !registered.includes("alg_memory_search")) throw new Error("ALG memory tool registration missing")
          if (arm === "full-alg" && !registered.includes("alg_run")) throw new Error("ALG graph tool registration missing")
          const scopedToolMap = arm === "scoped-evidence-skill" ? opencodeConfig.agent.build?.tools : null
          if (arm === "scoped-evidence-skill" && ALG_TOOL_IDS.some(tool => scopedToolMap?.[tool] !== scopedMemoryTools.includes(tool)))
            throw new Error("Build-scoped ALG tool map differs from the memory-only allowlist")
          if (arm === "native-build" && registered.some((tool: string) => tool.startsWith("alg_"))) throw new Error("ALG leaked into native Build arm")
          const sessionA = await host.api("/session", { title: `Comparative ${c.blindId} initial controller` }); sessions.push(sessionA.id)
          let sessionB: any
          if (arm === "full-alg") {
            armStage = "alg_initial_wave"
            const runId = `cmp-${randomUUID().replaceAll("-", "").slice(0, 20)}`
            const run = createRun({ runId, projectDirectory: project, ownerSessionId: sessionA.id, parentSessionId: sessionA.id,
              goal: `Analyze the particle evidence for ${c.title} and preserve the post-handoff continuation.`,
              criteria: ["Read the source dataset.", "Preserve an honest neutral handoff note before continuation.", "On resume, recover accepted job and read result without duplicate submission; calculate and save independently scorable answer.json."],
              graph: { name: "comparative-handoff", max_global_attempts: 2, max_concurrency: 1, nodes: [
                { id: "prepare", agent: "implementer", depends_on: [], description: `Initial controller stage ${STAGE}. Read mission.json and ${c.dataPath} with the native read tool and write handoff-note.json with a neutral status only. Do not calculate or state findings.`, loop: { max_attempts: 1, gate: "schema" } },
                { id: "analyze", agent: "implementer", depends_on: ["prepare"], description: `${CONTINUE}. Continue after transfer. Read mission.json and README.md. Current CSV path: ${c.dataPath}. Use the accepted-job API at ${jobUrl}: list pending, lookup the accepted key, and read its result; never submit. Read the current dataset and recovery resources if present. Compute crude and product × inspection-revision matched numeric results; use public conclusion and nextMeasurement options; write answer.json as JSON.`, loop: { max_attempts: 1, gate: "schema" } },
              ] }, modelSnapshot: { implementer: { providerID, modelID } } })
            const sdk = createOpencodeClient({ baseUrl: host.base, headers: { Authorization: `Basic ${Buffer.from(`opencode:${host.password}`).toString("base64")}` } })
            const pluginContext: any = { client: sdk, directory: project, worktree: project, project: { id: sessionA.projectID } }
            const toolsA = createAlgTools(pluginContext)
            const ctxA: any = { sessionID: sessionA.id, directory: project, worktree: project, abort: AbortSignal.timeout(trialMs),
              metadata: () => undefined, ask: async () => { throw new Error("comparative smoke has no interactive permission prompts") } }
            const first = await toolsA.alg_run.execute({ run_id: run.run_id, max_waves: 1, allow_filesystem_root: false }, ctxA)
            if ((first as any).metadata?.error) throw new Error("alg_run first wave failed")
            const savedBefore = loadRun(project, run.run_id)
            if (!savedBefore) throw new Error("ALG run state missing after first wave")
            if (savedBefore.nodes.prepare?.status !== "done" || savedBefore.nodes.analyze?.status === "done") throw new Error("first graph wave did not stop at the expected handoff boundary")
            handoffSequence = activeService.sequence
            sessionB = await host.api("/session", { title: `Comparative ${c.blindId} recipient controller` }); sessions.push(sessionB.id)
            const transferred = await toolsA.alg_transfer.execute({ run_id: run.run_id, new_owner_session_id: sessionB.id }, ctxA)
            if ((transferred as any).metadata?.error) throw new Error("alg_transfer failed")
            initializeComparativeMemory(project, sessionB.id, view.durableEvidence!)
            const before = activeService.sequence
            const sharedMemory = new SessionMemoryRuntime(project, { mode: "assist" }, [".opencode/skills"], [])
            const toolsB = createAlgTools({ ...pluginContext, project: { id: sessionB.projectID } }, undefined, undefined, { sessionMemory: sharedMemory })
            const resumed = await toolsB.alg_resume.execute({ run_id: run.run_id, max_waves: 1, allow_filesystem_root: false },
              { ...ctxA, sessionID: sessionB.id, abort: AbortSignal.timeout(trialMs) })
            if ((resumed as any).metadata?.error) throw new Error("alg_resume transferred graph failed")
            const savedAfter = loadRun(project, run.run_id)
            if (!savedAfter) throw new Error("ALG run state missing after continuation")
            const transfer = savedAfter.owner_transfers.at(-1), prepareAttempt = savedAfter.nodes.prepare?.attempts.at(-1), analyzeAttempt = savedAfter.nodes.analyze?.attempts.at(-1)
            graphReceipt = { run_id: run.run_id, first_wave_status: savedBefore.status, final_status: savedAfter.status,
              owner_session_id: savedAfter.owner_session_id, owner_transfers: savedAfter.owner_transfers, model_snapshot: savedAfter.model_snapshot,
              transfer, prepare_attempt_session_id: prepareAttempt?.session_id ?? null, analyze_attempt_session_id: analyzeAttempt?.session_id ?? null,
              nodes: Object.fromEntries(Object.entries(savedAfter.nodes).map(([id, node]: any) => [id, { status: node.status, attempts: node.attempts.map((a: any) => ({ session_id: a.session_id, outcome: a.outcome })) }])),
              handoff_job_operation_start_sequence: before }
            postHandoffSessions.add(sessionB.id)
            const memoryDeliveryReceipts = []
            for (const nodeId of ["analyze"]) for (const attempt of savedAfter.nodes[nodeId]?.attempts ?? []) if (attempt.session_id) {
              postHandoffSessions.add(attempt.session_id)
              memoryDeliveryReceipts.push(verifyComparativeMemory(project, attempt.session_id))
            }
            graphReceipt.memory_delivery_receipts = memoryDeliveryReceipts
            if (savedAfter.owner_session_id !== sessionB.id || savedAfter.nodes.prepare?.status !== "done" || savedAfter.nodes.analyze?.status !== "done" ||
              transfer?.from_session_id !== sessionA.id || transfer?.to_session_id !== sessionB.id || !prepareAttempt?.session_id || !analyzeAttempt?.session_id ||
              prepareAttempt.session_id === analyzeAttempt.session_id || prepareAttempt.outcome !== "passed" || analyzeAttempt.outcome !== "passed" ||
              savedAfter.model_snapshot.implementer?.providerID !== providerID || savedAfter.model_snapshot.implementer?.modelID !== modelID) throw new Error("ALG graph/transfer/model retention receipt mismatch")
            graphReceipt.handoff_note_sha256 = sha(readFileSync(join(project, "handoff-note.json")))
          } else {
            armStage = "initial_build_handoff"
            const commonPrompt = `Initial handoff stage ${STAGE}: inspect ${c.dataPath} with OpenCode's read tool and write handoff-note.json containing only a neutral inspected marker. Do not calculate the conclusion. Keep the accepted query for the next controller.`
            const sent = await sendBenchmarkPrompt({ api: (path, body, ms) => host!.api(path, body, ms), sessionID: sessionA.id,
              body: { model: { providerID, modelID }, agent: "build", parts: [{ type: "text", text: commonPrompt }] }, deadline: Date.now() + trialMs, cancelled: () => null })
            if (sent.status !== "completed") throw new Error(`initial_build_stage_${sent.status}`)
            handoffSequence = activeService.sequence
            armStage = "recipient_session"
            sessionB = await host.api("/session", { title: `Comparative ${c.blindId} recipient controller` }); sessions.push(sessionB.id)
            postHandoffSessions.add(sessionB.id)
            if (arm === "scoped-evidence-skill") initializeComparativeMemory(project, sessionB.id, view.durableEvidence!)
            const prompt = `${CONTINUE}\n\n${contestantView(c, arm as any).task}\nCurrent CSV path: ${c.dataPath}. Local service base URL: ${jobUrl}. Read README.md for the same job-service procedure available to every arm. Read the current scoped evidence and skill if provided.`
            armStage = "post_handoff_prompt"
            const sent2 = await sendBenchmarkPrompt({ api: (path, body, ms) => host!.api(path, body, ms), sessionID: sessionB.id,
              body: { model: { providerID, modelID }, agent: "build", parts: [{ type: "text", text: prompt }] }, deadline: Date.now() + Math.max(1, trialMs - (Date.now() - armStart)), cancelled: () => null })
            if (sent2.status !== "completed") throw new Error(`handoff_build_stage_${sent2.status}`)
            if (arm === "scoped-evidence-skill" && localProvider.calls.slice(providerCallStart).some(call =>
              call.dag_tools_available.length || !scopedMemoryTools.every(tool => call.alg_tools_available.includes(tool))))
              throw new Error("Provider observed a scoped Build toolset outside the memory-only allowlist")
            if (arm === "scoped-evidence-skill") graphReceipt = { memory_delivery_receipt: verifyComparativeMemory(project, sessionB.id) }
          }
          armStage = "collect_host_receipts"
          const allSessions = await host.api("/session?limit=10000")
          for (const session of allSessions) {
            const messages = await host.api(`/session/${session.id}/message?limit=10000`).catch(() => [])
            messageHistories.push(...messages.map((message: any) => ({ ...message, sessionID: session.id })))
          }
          armStage = "score"
          const observed = hostAccess(messageHistories, project, postHandoffSessions)
          const treatmentSkillTextObserved = localProvider.calls.slice(providerCallStart).some(call => call.stage === "analysis" && call.recovery_skill_text_observed === true)
          if (arm !== "native-build") {
            const hasHookReceipt = arm === "scoped-evidence-skill"
              ? Boolean(graphReceipt?.memory_delivery_receipt?.delivery_id)
              : Array.isArray(graphReceipt?.memory_delivery_receipts) && graphReceipt.memory_delivery_receipts.length > 0
            if (!hasHookReceipt || !treatmentSkillTextObserved) throw new Error("A treatment continuation lacked emitted hook or observed SYSTEM skill text")
          }
          const answer = parseAnswer(project), jobs = activeService.receipts(handoffSequence)
          score = scoreParticleAnswer(c, answer, observed, jobs)
          const toolReceipts = observed.filter(event => event.tool === "read" || event.tool === "write")
          const handoffReceipt = { source_session_id: sessionA.id, recipient_session_id: sessionB.id, same_project: sessionA.projectID === sessionB.projectID,
            job_operation_boundary_sequence: handoffSequence, observed_job_operations: jobs.operations }
          const result = { schema: "alg-comparative-arm-result-v1", status: score.passed ? "completed" : "scored_incorrect", blind_case_id: c.blindId,
            arm, mode: "local_deterministic_opencode_smoke", provider: providerID, model: modelID,
            duration_ms: Date.now() - armStart, numeric_score: score.score, numeric_checks: score.checks, host_observed_access: score.access,
            accepted_job_receipt: { ...score.job, handoffReceipt }, duplicate_submit_attempts: score.job.duplicate_submissions,
            treatment_skill_delivery: arm === "native-build" ? null : { hook_receipt_present: true, provider_system_skill_text_observed: treatmentSkillTextObserved },
            graph_retention_receipt: graphReceipt, scoped_build_tool_map: scopedToolMap,
            host_tool_events: toolReceipts, deterministic_provider_calls: localProvider.calls.slice(providerCallStart),
            deterministic_provider_error_codes: localProvider.errors.slice(providerErrorStart), source_identity: identity, source_hashes: sourceHashes }
          writeFileSync(join(dir, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" })
          Object.assign(rowFor(c.blindId, arm), result); status = result.status
        } catch (cause) { failureCode = errorCode(cause); status = "failed"; Object.assign(rowFor(c.blindId, arm), { status, error_code: failureCode, failed_stage: armStage,
          provider_calls: localProvider.calls.slice(providerCallStart), provider_error_codes: localProvider.errors.slice(providerErrorStart),
          ...(cause && typeof cause === "object" && "safeDiagnostic" in cause ? { host_boot_diagnostic: (cause as any).safeDiagnostic } : {}), graph_retention_receipt: graphReceipt }) }
        finally {
          if (host) {
            try { const stopped = await stopCapturedProcess(host.child); hostCleanupReceipt = stopped; if (!stopped.passed) { failureCode = "host_cleanup_failed"; cleanupPassed = false } }
            catch {
              cleanupPassed = false; failureCode = "host_cleanup_receipt_failed"
              hostCleanupReceipt = { passed: false, failure_code: "cleanup_receipt_exception" }
              try { if (host.child.child.exitCode === null) host.child.child.kill() } catch {}
            }
          }
        }
        } catch (cause) {
          const diagnostic = cause && typeof cause === "object" && "safeDiagnostic" in cause ? (cause as any).safeDiagnostic : undefined
          if (diagnostic?.cleanup) hostCleanupReceipt = diagnostic.cleanup
          Object.assign(rowFor(c.blindId, arm), { status: "setup_failed", error_code: errorCode(cause), setup_stage: setupStage,
            ...(diagnostic ? { host_boot_diagnostic: { category: diagnostic.category, exit_code: diagnostic.exit_code } } : {}) })
        }
        finally {
          if (hostLaunchAttempted && hostCleanupReceipt?.passed !== true) {
            cleanupPassed = false
            rowFor(c.blindId, arm).host_cleanup_error_code = hostCleanupReceipt ? "host_cleanup_failed" : "host_cleanup_receipt_missing"
          }
          if (service) { try { await service.stop() } catch { cleanupPassed = false; rowFor(c.blindId, arm).service_cleanup_error_code = "local_service_stop_failed" } }
          const row = rowFor(c.blindId, arm)
          if (hostCleanupReceipt) row.host_cleanup_receipt = hostCleanupReceipt
          if (!row.provider_calls) row.provider_calls = localProvider.calls.slice(providerCallStart)
          if (!row.provider_error_codes) row.provider_error_codes = localProvider.errors.slice(providerErrorStart)
          row.cleanup_passed = cleanupPassed; row.mode = "local_deterministic_opencode_smoke"
          try { writeFileSync(join(dir, "result.final.json"), JSON.stringify(row, null, 2) + "\n", { flag: "wx" }); row.result_final_persisted = true }
          catch { row.result_final_persisted = false; row.result_final_error_code = "result_final_write_failed" }
        }
        suiteStage = "between_arms"
      }
    }
  } catch (cause) { fatal = errorCode(cause); fatalStage = suiteStage }
  finally { await localProvider?.stop() }
  const result = { schema: "alg-comparative-opencode-receipt-v1", result_kind: config.diagnosticSelection ? "deterministic_headless_opencode_diagnostic" : "deterministic_headless_opencode_smoke",
    started_at: begun, ended_at: new Date().toISOString(), seed: orderSeed, model: `${providerID}/${modelID}`, identity, source_hashes: sourceHashes,
    issued_arms: rows, fatal, fatal_stage: fatal ? fatalStage : null, summary: Object.fromEntries(["native-build", "scoped-evidence-skill", "full-alg"].map(arm => [arm,
      { issued: rows.filter(row => row.arm === arm && row.status !== "issued_not_started").length, completed: rows.filter(row => row.arm === arm && row.status === "completed").length,
        scored_correct: rows.filter(row => row.arm === arm && row.numeric_score === 1).length }])),
    interpretation: config.diagnosticSelection ? "Selected isolated host diagnostics; not a comparative result." : "Real isolated OpenCode hosts, native tools, local accepted-job API, and ALG child sessions with a deterministic local provider. Feasibility evidence only, not model capability evidence." }
  writeFileSync(join(outputRoot, "result.json"), JSON.stringify(result, null, 2) + "\n", { flag: "wx" })
  return result
}

if (import.meta.main) {
  const args = process.argv.slice(2), at = args.indexOf("--config")
  if (at < 0 || !args[at + 1]) throw new Error("Usage: bun scripts/comparative-benchmark-opencode.ts --config <non-secret-config.json>")
  const config = JSON.parse(readFileSync(resolve(args[at + 1]!), "utf8")) as Config
  const result = await runComparativeOpenCode(config)
  console.log(JSON.stringify({ result_kind: result.result_kind, issued: result.issued_arms.length, fatal: result.fatal, summary: result.summary }))
  const expectedArms = config.diagnosticSelection ? config.diagnosticSelection.arms.length : 6
  if (result.fatal || result.issued_arms.length !== expectedArms || result.issued_arms.some((row: any) => row.status !== "completed" || row.cleanup_passed !== true)) process.exitCode = 1
}

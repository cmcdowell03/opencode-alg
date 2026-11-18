import { createHash, randomBytes, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, renameSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { createLongSessionCases, type LongPhase, type LongCheckpointResult } from "./build-benchmark-long-fixtures.ts"
import { runLongSession, type LongSessionDriver, type LongSessionEvidence } from "./build-benchmark-long-session.ts"
import { freePort, isolatedEnv, launch } from "./build-benchmark.ts"
import { realUserGlobalConfigRoots, snapshotGlobalOpenCodeConfig, validateOpenCodeVersion, verificationPluginConfiguration } from "./live-verify.ts"
import { seedVerificationHostDependencies } from "./verification-host-dependencies.ts"
import { observeCompactionMarkers, compactionReceipt } from "./build-benchmark-protocol.ts"
import { sha256Json } from "../src/persistence.ts"

const MAX_RUN_MS = 10 * 60_000
const REQUEST_MS = 15_000
const BODY_LIMIT = 8 * 1024 * 1024
const FACT = "ALG_L2_SYNTHETIC_CHECKPOINT_FACT_V1"
type Arm = "build" | "alg"
type Json = Record<string, any>
type HostProcess = ReturnType<typeof launch>

export interface LongSessionHeadlessOptions {
  hostExecutable: string
  outputPath: string
  arms?: readonly Arm[]
  timeoutMs?: number
}

interface ToolProof {
  sequence: number; phase: LongPhase; nonce: string; sessionId: string; messageId: string; partId: string | null
  tool: string; input: unknown; artifactSha256: string
}

function hash(value: unknown): string { return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex") }
function bounded(value: string, limit = 4096): string { return value.length > limit ? value.slice(-limit) : value }
function assertWithinDeadline(deadline: number): number {
  const remaining = deadline - Date.now()
  if (remaining <= 0) throw new Error("headless lifecycle exceeded its overall deadline")
  return Math.min(REQUEST_MS, remaining)
}
function safePath(path: string, root: string): boolean {
  const rel = relative(root, resolve(root, path))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

async function readJson(response: Response, maximum = BODY_LIMIT): Promise<any> {
  const reader = response.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []; let size = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximum) { await reader.cancel(); throw new Error(`OpenCode response exceeded ${maximum} bytes`) }
      chunks.push(chunk.value)
    }
  } finally { reader.releaseLock() }
  const bytes = Buffer.concat(chunks, size)
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  if (!response.ok) throw new Error(`OpenCode HTTP ${response.status}: ${bounded(text)}`)
  return text ? JSON.parse(text) : null
}

function latestUser(messages: any[]): string {
  const user = [...messages].reverse().find(message => message?.role === "user")
  if (typeof user?.content === "string") return user.content
  return Array.isArray(user?.content) ? user.content.map((part: any) => part?.text ?? "").join("\n") : ""
}
function toolsAfterLatestUser(messages: any[]): boolean {
  const index = messages.map((message: any) => message?.role).lastIndexOf("user")
  return index >= 0 && messages.slice(index + 1).some((message: any) => message?.role === "tool" || message?.tool_call_id ||
    (Array.isArray(message?.tool_calls) && message.tool_calls.length > 0))
}
function writeTool(body: any): { name: string; args: Json } {
  const entries = Array.isArray(body?.tools) ? body.tools : []
  const tool = entries.map((entry: any) => entry?.function ?? entry).find((candidate: any) =>
    typeof candidate?.name === "string" && (candidate.name === "write" || candidate.name.endsWith("_write")))
  if (!tool) throw new Error(`OpenCode did not advertise its write tool; advertised=${entries.map((entry: any) => (entry?.function ?? entry)?.name).join(",")}`)
  const properties = tool.parameters?.properties ?? tool.inputSchema?.properties ?? {}
  const pathKey = ["filePath", "file_path", "path"].find(key => key in properties) ?? "filePath"
  const textKey = ["content", "text", "body"].find(key => key in properties) ?? "content"
  const prompt = latestUser(body.messages ?? [])
  const match = /LONG_L2_CHECKPOINT phase=(q0|qh|qc|qr) nonce=([a-f0-9]{32})/.exec(prompt)
  if (!match) throw new Error("provider request did not contain the current mechanical checkpoint marker")
  const artifact = { schema: "long-session-headless/v1", fact: FACT, phase: match[1], nonce: match[2] }
  const args: Json = { [pathKey]: `checkpoint-${match[1]}.json`, [textKey]: `${JSON.stringify(artifact, null, 2)}\n` }
  for (const key of tool.parameters?.required ?? tool.inputSchema?.required ?? []) {
    if (!(key in args)) args[key] = typeof properties[key]?.default === "string" ? properties[key].default : "headless-probe"
  }
  return { name: tool.name, args }
}

function providerResponse(response: ServerResponse, body: any, choice: { text?: string; tool?: { name: string; args: Json } }, callId: string): void {
  const model = String(body?.model ?? "deterministic")
  const created = Math.floor(Date.now() / 1000)
  const completionId = `long-l2-${callId}`
  const message = choice.tool
    ? { role: "assistant", content: null, tool_calls: [{ id: callId, type: "function", function: { name: choice.tool.name, arguments: JSON.stringify(choice.tool.args) } }] }
    : { role: "assistant", content: choice.text ?? "Checkpoint observed." }
  const finish = choice.tool ? "tool_calls" : "stop"
  if (body?.stream === true) {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", connection: "close" })
    const delta = choice.tool
      ? { role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name: choice.tool.name, arguments: JSON.stringify(choice.tool.args) } }] }
      : { role: "assistant", content: choice.text ?? "Checkpoint observed." }
    response.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ id: completionId, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`)
    response.end("data: [DONE]\n\n")
    return
  }
  response.writeHead(200, { "content-type": "application/json" })
  response.end(JSON.stringify({ id: completionId, object: "chat.completion", created, model,
    choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 32, completion_tokens: 8, total_tokens: 40 } }))
}

function createProvider(): { server: Server; listen(): Promise<string>; close(): Promise<void>; summaryNext(): void;
  requests: Array<{ kind: string; phase: string | null; tool: string | null }> } {
  const requests: Array<{ kind: string; phase: string | null; tool: string | null }> = []
  let forceSummary = false
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    if (request.socket.remoteAddress !== "127.0.0.1" && request.socket.remoteAddress !== "::1" && request.socket.remoteAddress !== "::ffff:127.0.0.1") {
      response.writeHead(403).end(); return
    }
    if (request.method === "GET" && /\/models$/.test(request.url ?? "")) {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: [{ id: "deterministic", object: "model" }] })); return
    }
    if (request.method !== "POST" || !/\/chat\/completions$/.test(request.url ?? "")) { response.writeHead(404).end(); return }
    const chunks: Buffer[] = []; let size = 0
    request.on("data", (chunk: Buffer) => { size += chunk.byteLength; if (size > BODY_LIMIT) { response.writeHead(413).end(); request.destroy(); return } chunks.push(Buffer.from(chunk)) })
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks, size).toString("utf8"))
        const prompt = latestUser(body.messages ?? [])
        const marker = /LONG_L2_CHECKPOINT phase=(q0|qh|qc|qr) nonce=([a-f0-9]{32})/.exec(prompt)
        const id = randomUUID().replaceAll("-", "")
        let choice: { text?: string; tool?: { name: string; args: Json } }
        if (forceSummary || !marker) {
          forceSummary = false
          choice = { text: `Synthetic summary preserved ${FACT}.` }
          requests.push({ kind: "summary", phase: null, tool: null })
        } else if (toolsAfterLatestUser(body.messages ?? [])) {
          choice = { text: `Checkpoint ${marker[1]} completed.` }
          requests.push({ kind: "completion", phase: marker[1]!, tool: null })
        } else {
          const tool = writeTool(body)
          choice = { tool }
          requests.push({ kind: "tool_call", phase: marker[1]!, tool: tool.name })
        }
        providerResponse(response, body, choice, id)
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: bounded(String(error)) } }))
      }
    })
    request.on("error", () => { if (!response.headersSent) response.writeHead(400).end() })
  })
  return {
    server, requests, summaryNext: () => { forceSummary = true },
    listen: () => new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolveListen(`http://127.0.0.1:${(server.address() as any).port}/v1`)) }),
    close: () => !server.listening ? Promise.resolve() : new Promise((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())),
  }
}

async function request(base: string, project: string, path: string, method = "GET", body?: unknown, deadline = Date.now() + REQUEST_MS): Promise<any> {
  const url = new URL(path, base)
  url.searchParams.set("directory", project)
  const response = await fetch(url, { method, headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(assertWithinDeadline(deadline)) })
  return readJson(response)
}

function copyPluginSnapshot(tempRoot: string) {
  const checkout = verificationPluginConfiguration()
  const runtimeRoot = join(tempRoot, "runtime-plugin")
  mkdirSync(runtimeRoot, { recursive: true })
  for (const entry of checkout.source.manifest) {
    const rel = entry.path.split("/").join(sep), target = join(runtimeRoot, rel)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(join(checkout.source.root, rel), target)
  }
  symlinkSync(join(checkout.source.root, "node_modules"), join(runtimeRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir")
  return verificationPluginConfiguration(runtimeRoot)
}

function writeConfig(configPath: string, providerEndpoint: string, arm: Arm, pluginSpec?: string): void {
  const agent = arm === "build" ? "build" : "orchestrator"
  const configuration = {
    $schema: "https://opencode.ai/config.json", ...(pluginSpec ? { plugin: [pluginSpec] } : { plugin: [] }), model: "long-l2/deterministic",
    small_model: "long-l2/deterministic", autoupdate: false,
    provider: { "long-l2": { npm: "@ai-sdk/openai-compatible", name: "Local synthetic lifecycle provider",
      options: { baseURL: providerEndpoint }, models: { deterministic: { name: "Deterministic", limit: { context: 16_384, output: 1024 } } } } },
    agent: { [agent]: { mode: "primary", model: "long-l2/deterministic", steps: 4 } },
    permission: { "*": "allow", external_directory: "deny", webfetch: "deny", websearch: "deny", question: "deny" },
    mcp: {}, compaction: { auto: false, prune: false },
  }
  writeFileSync(configPath, `${JSON.stringify(configuration, null, 2)}\n`, { flag: "wx", mode: 0o600 })
}

async function startHost(executable: string, project: string, env: NodeJS.ProcessEnv, deadline: number): Promise<{ base: string; process: HostProcess }> {
  const port = await freePort(), processInfo = launch(executable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], project, env)
  const base = `http://127.0.0.1:${port}`
  let last = "not ready"
  try {
    while (Date.now() < deadline) {
      if (processInfo.exit().observed) throw new Error(`OpenCode exited before readiness: ${bounded(processInfo.stderr())}`)
      try {
        const health = await request(base, project, "/global/health", "GET", undefined, Math.min(deadline, Date.now() + 2_000))
        if (health?.healthy === true || health?.status === "ok") return { base, process: processInfo }
        last = JSON.stringify(health)
      } catch (error) { last = bounded(String(error)) }
      await delay(150)
    }
    throw new Error(`OpenCode did not become ready: ${last}; ${bounded(processInfo.stderr())}`)
  } catch (error) {
    await stopHost(processInfo).catch(cleanup => { throw new Error(`host readiness failed and child cleanup failed: ${String(cleanup)}`, { cause: error }) })
    throw error
  }
}

async function stopHost(processInfo: HostProcess): Promise<void> {
  if (processInfo.exit().observed) return
  processInfo.child.kill("SIGTERM")
  const deadline = Date.now() + 3_000
  while (!processInfo.exit().observed && Date.now() < deadline) await delay(50)
  if (!processInfo.exit().observed) processInfo.child.kill("SIGKILL")
  const final = Date.now() + 3_000
  while (!processInfo.exit().observed && Date.now() < final) await delay(50)
  if (!processInfo.exit().observed) throw new Error("OpenCode host process did not stop within the cleanup bound")
}

function checkpointEvent(messages: readonly any[]) {
  const found: Array<{ messageId: string; partId: string | null; tool: string; input: any }> = []
  for (const message of messages) for (const part of Array.isArray(message?.parts) ? message.parts : []) {
    if (part?.type !== "tool" || part.state?.status !== "completed") continue
    const input = part.state.input ?? {}
    if (part.tool === "write" || String(part.tool).endsWith("_write")) found.push({ messageId: String(message.info?.id ?? ""),
      partId: typeof part.id === "string" ? part.id : null, tool: String(part.tool), input })
  }
  return found
}

async function runArm(arm: Arm, executable: string, deadline: number, outputPath: string): Promise<any> {
  const globalRoots = realUserGlobalConfigRoots({ ...process.env }), globalHmacKey = randomBytes(32)
  const globalConfigBefore = snapshotGlobalOpenCodeConfig(globalRoots, globalHmacKey)
  const tempRoot = resolve(join(tmpdir(), `alg-long-l2-${randomUUID()}`)), project = join(tempRoot, "project")
  mkdirSync(project, { recursive: true })
  const env = isolatedEnv(join(tempRoot, "isolated-env"))
  const provider = createProvider()
  let hostProcess: HostProcess | undefined, base = "", currentSession = "", censusOK = false, summaryEvidence: any = null
  const sessions = new Map<string, any>(), histories = new Map<string, any[]>(), proofs: ToolProof[] = [], events: any[] = []
  let censusFailure: string | null = null
  let latestEvidence: LongSessionEvidence | null = null
  let finalReceipt: any = null
  try {
  const configPath = env.OPENCODE_CONFIG!
  let pluginSpec: string | undefined
  if (arm === "alg") {
    const checkout = verificationPluginConfiguration()
    seedVerificationHostDependencies(join(env.XDG_CONFIG_HOME!, "opencode"), checkout.source.root)
    const plugin = copyPluginSnapshot(tempRoot)
    pluginSpec = plugin.source.spec
    const agentRoot = join(env.XDG_CONFIG_HOME!, "opencode", "agents")
    mkdirSync(agentRoot, { recursive: true })
    for (const name of ["orchestrator", "implementer", "researcher", "checker"])
      copyFileSync(join(plugin.source.root, "agents", `${name}.md`), join(agentRoot, `${name}.md`))
    seedVerificationHostDependencies(join(project, ".opencode"), checkout.source.root)
    mkdirSync(join(project, ".opencode"), { recursive: true })
    writeFileSync(join(project, ".opencode", "ALG.workspace.json"), JSON.stringify({ schema_version: 1, operations: [] }), { flag: "wx" })
  }
  const providerEndpoint = await provider.listen()
  writeConfig(configPath, providerEndpoint, arm, pluginSpec)
  writeFileSync(env.OPENCODE_ALG_CONFIG!, JSON.stringify({ skillEvolution: { enabled: false }, sessionMemory: { mode: "off" }, workspace: { mode: "observe" } }), { flag: "wx", mode: 0o600 })
  const caseRecord = createLongSessionCases().find(item => item.cell.handoff && item.cell.compact)!
  const version = spawnSync(executable, ["--version"], { cwd: project, env, encoding: "utf8", timeout: 15_000, windowsHide: true })
  if (version.error || version.status !== 0) throw new Error(`OpenCode version probe failed: status=${version.status}; ${bounded(String(version.error ?? version.stderr))}`)
  const versionText = `${version.stdout ?? ""} ${version.stderr ?? ""}`
  const versionMatch = versionText.match(/\b\d+\.\d+\.\d+\b/)?.[0]
  if (!versionMatch || !validateOpenCodeVersion(versionMatch).compatible) throw new Error(`host is not compatible with OpenCode V1: ${bounded(versionText)}`)
  const transcriptSequence = () => proofs.length
  const collect = async () => {
    assertWithinDeadline(deadline)
    try {
      const listed = await request(base, project, "/session?limit=10000", "GET", undefined, deadline)
      if (!Array.isArray(listed) || listed.length > 128) throw new Error("bounded session census invalid")
      const ids = listed.map((item: any) => item?.id)
      if (ids.some((id: any) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new Error("session census IDs invalid")
      for (const row of listed) {
        const id = row.id
        const history = await request(base, project, `/session/${encodeURIComponent(id)}/message?limit=10000`, "GET", undefined, deadline)
        if (!Array.isArray(history) || history.length > 2000 || history.some((message: any) =>
          typeof message?.info?.id !== "string" || (message.sessionID !== undefined && message.sessionID !== id))) throw new Error(`message census invalid for ${id}`)
        sessions.set(id, row); histories.set(id, history)
      }
      const expected = new Set(ids)
      if ([...sessions.keys()].some(id => !expected.has(id))) throw new Error("cumulative census session disappeared")
      const knownProofs = new Set(proofs.map(proof => `${proof.sessionId}:${proof.messageId}:${proof.partId ?? ""}`))
      for (const [sessionId, history] of histories) for (const found of checkpointEvent(history)) {
        const key = `${sessionId}:${found.messageId}:${found.partId ?? ""}`
        if (knownProofs.has(key)) continue
        const content = found.input.content
        let artifact: any
        try { artifact = typeof content === "string" ? JSON.parse(content) : null } catch { artifact = null }
        if (artifact?.schema !== "long-session-headless/v1" || artifact.fact !== FACT || !["q0", "qh", "qc", "qr"].includes(artifact.phase) || !/^[a-f0-9]{32}$/.test(artifact.nonce)) continue
        const pathValue = found.input.filePath ?? found.input.file_path ?? found.input.path
        if (typeof pathValue !== "string" || !safePath(pathValue, project)) continue
        const actualPath = resolve(project, pathValue)
        const actual = readFileSync(actualPath, "utf8")
        if (actual !== content) continue
        proofs.push({ sequence: proofs.length + 1, phase: artifact.phase, nonce: artifact.nonce, sessionId,
          messageId: found.messageId, partId: found.partId, tool: found.tool, input: found.input, artifactSha256: hash(actual) })
        knownProofs.add(key)
        events.push({ at: Date.now(), kind: "completed_write_tool", sequence: proofs.length, phase: artifact.phase,
          sessionId, messageId: found.messageId, artifactSha256: hash(actual) })
      }
      const status = await request(base, project, "/session/status", "GET", undefined, deadline)
      if (!status || typeof status !== "object" || Array.isArray(status)) throw new Error("session status census invalid")
      if (ids.some((id: string) => status[id] && status[id].type !== "idle")) throw new Error("session census found active work")
      if ([...histories.values()].some(history => history.some((message: any) => message.parts?.some((part: any) =>
        part.type === "tool" && ["pending", "running"].includes(part.state?.status))))) throw new Error("session census found pending tool work")
      censusOK = true; censusFailure = null
    } catch (error) { censusOK = false; censusFailure = bounded(String(error)); throw error }
  }
  const stableCensus = async () => {
    let previous = "", stable = 0
    for (let attempt = 0; attempt < 8; attempt++) {
      await collect()
      const fingerprint = sha256Json({ sessions: [...sessions.keys()].sort(), histories: [...histories].map(([id, rows]) => [id, rows.map(row => row.info.id)]).sort() })
      stable = fingerprint === previous ? stable + 1 : 1; previous = fingerprint
      if (stable >= 2) return
      await delay(100)
    }
    throw new Error("cumulative session census did not stabilize")
  }
  const persist = (evidence: LongSessionEvidence) => {
    latestEvidence = structuredClone(evidence)
    const wrapper = { schema: "opencode-v1-long-session-headless/v1", arm, evidence, proofs,
      census: { complete: censusOK, sessionIds: [...sessions.keys()].sort(), messages: [...histories].map(([id, rows]) => ({ sessionId: id, ids: rows.map(row => row.info.id) })), failure: censusFailure },
      provider: { requests: provider.requests }, updatedAt: new Date().toISOString() }
    const temporary = `${outputPath}.${arm}.partial`
    writeFileSync(temporary, `${JSON.stringify(wrapper, null, 2)}\n`)
    renameSync(temporary, `${outputPath}.${arm}.json`)
    writeFileSync(`${outputPath}.${arm}.events.jsonl`, events.map(event => JSON.stringify(event)).join("\n") + (events.length ? "\n" : ""))
  }
  let driver!: LongSessionDriver
    const initial = await startHost(executable, project, env, deadline)
    hostProcess = initial.process; base = initial.base
    const query = (path: string) => {
      const url = new URL(path, base); url.searchParams.set("directory", project); return url
    }
    const created = await readJson(await fetch(query("/session"), { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: `Long session headless ${arm}` }), signal: AbortSignal.timeout(assertWithinDeadline(deadline)) }))
    currentSession = typeof created?.id === "string" ? created.id : ""
    if (!currentSession) throw new Error("host did not create the root session")
    await collect()
    driver = {
      sessionId: () => currentSession, sequence: transcriptSequence, censusComplete: () => censusOK, auditComplete: () => censusOK,
      send: async (phase, _longPrompt) => {
        const checkpoint = latestEvidence?.checkpoints.at(-1)
        const nextNonce = checkpoint?.nonce
        if (!nextNonce || checkpoint.phase !== phase || checkpoint.status !== "running") throw new Error(`parent driver omitted the nonce for ${phase}`)
        const prompt = `LONG_L2_CHECKPOINT phase=${phase} nonce=${nextNonce}\nUse the write tool to write checkpoint-${phase}.json containing schema long-session-headless/v1, fact ${FACT}, this phase, and this nonce.`
        const result = await request(base, project, `/session/${encodeURIComponent(currentSession)}/message`, "POST", {
          model: { providerID: "long-l2", modelID: "deterministic" }, agent: arm === "build" ? "build" : "orchestrator", parts: [{ type: "text", text: prompt }],
        }, deadline)
        if(result?.info?.error)throw new Error(`synthetic_model_error:${bounded(JSON.stringify(result.info.error))}`)
        await collect()
        return result
      },
      grade: async (phase, nonce, fromSequence): Promise<LongCheckpointResult> => {
        await stableCensus()
        const matches = proofs.filter(proof => proof.sequence > fromSequence && proof.phase === phase && proof.nonce === nonce)
        const proof = matches.length === 1 ? matches[0] : undefined
        const expectedDigest = sha256Json(FACT), observedDigest = proof ? sha256Json(FACT) : null
        return { passed: !!proof && observedDigest === expectedDigest, evidenceDigest: sha256Json({ phase, nonce, proof: proof ?? null }),
          checks: [{ id: "synthetic-phase-artifact-written-by-host-tool", category: "phase", expectedDigest, observedDigest,
            exposed: !!proof, known: !!proof, passed: !!proof && observedDigest === expectedDigest }] }
      },
      reassign: async () => {
        const sourceSession = currentSession
        const recipient = await request(base, project, "/session", "POST", { title: `Long session handoff ${arm}` }, deadline)
        if (typeof recipient?.id !== "string" || recipient.id === sourceSession) throw new Error("host handoff did not create a distinct session")
        currentSession = recipient.id; await collect()
        return { sourceSessionId: sourceSession, recipientSessionId: currentSession, kind: "new_session_only",
          ownershipTransferCoverage: false, at: Date.now() }
      },
      restart: async () => {
        const priorSession = currentSession
        await stopHost(hostProcess!); hostProcess = undefined
        const restarted = await startHost(executable, project, env, deadline)
        hostProcess = restarted.process; base = restarted.base
        const restored = await request(base, project, `/session/${encodeURIComponent(priorSession)}`, "GET", undefined, deadline)
        if (restored?.id !== priorSession) throw new Error("host restart did not restore the same session")
        await collect()
        return { sessionId: priorSession, hostRestarted: true, at: Date.now() }
      },
      compact: async (requestId, requestedAt) => {
        const sessionId = currentSession, before = histories.get(sessionId) ?? []
        provider.summaryNext()
        const response = await request(base, project, `/session/${encodeURIComponent(sessionId)}/summarize`, "POST",
          { providerID: "long-l2", modelID: "deterministic" }, deadline)
        await stableCensus()
        const after = histories.get(sessionId) ?? []
        const receipt = compactionReceipt({ requestId, requestedAt: new Date(requestedAt).toISOString(), rootSessionId: sessionId,
          response, beforeMessages: before, afterMessages: after, continuation: { status: "not_completed" } })
        const marker = observeCompactionMarkers(after).find((item: any) => item.summary?.id === receipt.summary.id)
        if (!receipt.summaryExposureQualified || !marker?.summary) throw new Error("actual host summary marker was not independently observed")
        summaryEvidence = { id: marker.summary.id, completedAt: marker.summary.completedAt, digest: sha256Json(marker) }
        events.push({ at: Date.now(), kind: "manual_summary", sessionId, summaryId: summaryEvidence.id, digest: summaryEvidence.digest })
        void response
      },
      summary: () => summaryEvidence,
      nativeMarkers: () => observeCompactionMarkers([...histories.values()].flat()).filter((marker: any) => marker.auto === true).map((marker: any) => marker.id),
      persist,
    }
    const evidence = await runLongSession(caseRecord, `headless-${arm}-${randomUUID()}`, driver)
    await stableCensus()
    const result = finalReceipt = { arm, passed: evidence.passed && evidence.complete && proofs.length === 4 && censusOK,
      qualificationScope: "mechanical host lifecycle only; no task accuracy, semantic retention, or ownership-transfer claim",
      ownershipTransferCoverage: false, handoffMechanics: "created a distinct OpenCode session; did not invoke alg_transfer or move an owned production run",
      evidence, proofs, census: { complete: censusOK, sessionIds: [...sessions.keys()].sort(), messages: [...histories].map(([id, rows]) => ({ sessionId: id, ids: rows.map(row => row.info.id) })), failure: censusFailure },
      provider: { requests: provider.requests, nonLoopbackOnly: true }, host: { restarts: 1, sameSessionAfterRestart: currentSession },
      summary: summaryEvidence, hostVersion: versionMatch, credentialsInherited: false, tempWorkspaceRetained: false }
    const tempOutput = `${outputPath}.${arm}.partial`
    writeFileSync(tempOutput, `${JSON.stringify(result, null, 2)}\n`)
    renameSync(tempOutput, `${outputPath}.${arm}.json`)
    return result
  } catch (error) {
    const failure = finalReceipt = { arm, passed: false, failure: bounded(error instanceof Error ? `${error.name}: ${error.message}` : String(error)),
      qualificationScope: "mechanical host lifecycle only; no task accuracy, semantic retention, or ownership-transfer claim",
      ownershipTransferCoverage: false, evidence: latestEvidence, proofs,
      census: { complete: censusOK, sessionIds: [...sessions.keys()], failure: censusFailure }, provider: { requests: provider.requests } }
    const temporary = `${outputPath}.${arm}.partial`
    writeFileSync(temporary, `${JSON.stringify(failure, null, 2)}\n`)
    renameSync(temporary, `${outputPath}.${arm}.json`)
    throw Object.assign(new Error(failure.failure), { evidencePath: `${outputPath}.${arm}.json` })
  } finally {
    const cleanupErrors: string[] = []
    if (hostProcess) try { await stopHost(hostProcess) } catch (error) { cleanupErrors.push(`host_stop:${bounded(String(error))}`) }
    try { await provider.close() } catch (error) { cleanupErrors.push(`provider_stop:${bounded(String(error))}`) }
    if (!cleanupErrors.length && existsSync(tempRoot) && basename(tempRoot).startsWith("alg-long-l2-")) {
      try { rmSync(tempRoot, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(`workspace_cleanup:${bounded(String(error))}`) }
    }
    let globalConfigUnchanged = false
    try { globalConfigUnchanged = snapshotGlobalOpenCodeConfig(globalRoots, globalHmacKey).sha256 === globalConfigBefore.sha256 }
    catch (error) { cleanupErrors.push(`global_config_snapshot:${bounded(String(error))}`) }
    if (!globalConfigUnchanged) cleanupErrors.push("global_opencode_config_changed_or_unverifiable")
    finalReceipt ??= { arm, passed: false, evidence: latestEvidence, proofs, failure: "lifecycle ended before terminal receipt" }
    finalReceipt.cleanup = { complete: cleanupErrors.length === 0, errors: cleanupErrors, tempWorkspaceRetained: existsSync(tempRoot) }
    finalReceipt.globalConfigurationUnchanged = globalConfigUnchanged
    finalReceipt.passed = finalReceipt.passed === true && cleanupErrors.length === 0 && globalConfigUnchanged
    const temporary = `${outputPath}.${arm}.partial`
    writeFileSync(temporary, `${JSON.stringify(finalReceipt, null, 2)}\n`)
    renameSync(temporary, `${outputPath}.${arm}.json`)
  }
}

export async function runLongSessionHeadless(options: LongSessionHeadlessOptions) {
  const executable = resolve(options.hostExecutable), outputPath = resolve(options.outputPath)
  if (!isAbsolute(options.hostExecutable) || !isAbsolute(options.outputPath) || !existsSync(executable)) throw new Error("absolute host executable and output path are required")
  if (existsSync(outputPath)) throw new Error("output path must be unused")
  mkdirSync(dirname(outputPath), { recursive: true })
  const arms = options.arms ?? ["build", "alg"]
  if (!arms.length || arms.some(arm => arm !== "build" && arm !== "alg") || new Set(arms).size !== arms.length) throw new Error("arms must be distinct build and/or alg")
  const deadline = Date.now() + Math.min(MAX_RUN_MS, options.timeoutMs ?? MAX_RUN_MS)
  const results: any[] = []; let failure: unknown
  for (const arm of arms) {
    try { results.push(await runArm(arm, executable, deadline, outputPath)) }
    catch (error) { failure ??= error; break }
  }
  const result = { schema: "opencode-v1-long-session-headless/v1", generatedAt: new Date().toISOString(),
    hostExecutable: executable, arms, passed: !failure && results.length === arms.length && results.every(item => item.passed), results,
    failure: failure instanceof Error ? { message: bounded(failure.message), evidencePath: (failure as any).evidencePath ?? null } : null }
  if (!failure && !result.passed) {
    const reason = "one or more actual-host mechanical lifecycle receipts failed"
    failure = new Error(reason)
    ;(result as any).failure = { message: reason, evidencePath: outputPath }
  }
  const temporary = `${outputPath}.partial`
  writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`)
  renameSync(temporary, outputPath)
  if (failure) throw Object.assign(new Error(`long-session headless failed; evidence=${outputPath}`), { cause: failure, evidencePath: outputPath })
  return { evidencePath: outputPath, evidenceSha256: hash(readFileSync(outputPath)), evidence: result }
}

function parseArgs(args: string[]) {
  const values = new Map<string, string>()
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!, value = args[index + 1]
    if (!["--host", "--output", "--arms", "--timeout-ms"].includes(key) || !value || value.startsWith("--") || values.has(key))
      throw new Error("Usage: bun scripts/test-long-session-headless.ts --host <absolute-opencode-path> --output <unused-absolute-json> [--arms build,alg] [--timeout-ms 600000]")
    values.set(key, value); index++
  }
  const arms = (values.get("--arms") ?? "build,alg").split(",") as Arm[]
  return { hostExecutable: values.get("--host") ?? "", outputPath: values.get("--output") ?? "", arms,
    timeoutMs: values.has("--timeout-ms") ? Number(values.get("--timeout-ms")) : MAX_RUN_MS }
}

if (import.meta.main) {
  const result = await runLongSessionHeadless(parseArgs(process.argv.slice(2)))
  console.log(JSON.stringify({ evidencePath: result.evidencePath, evidenceSha256: result.evidenceSha256, passed: result.evidence.passed }))
}

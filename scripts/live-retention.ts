import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, cpSync, copyFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { execFileSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { Database } from "bun:sqlite"
import { freePort, launch, isolatedEnv } from "./build-benchmark.ts"
import { liveRetentionFixture, phaseUpdates, scoreRetentionPhase, expectedRetentionChecks } from "./live-retention-fixture.ts"
import { sendBenchmarkPrompt } from "./build-benchmark-transport.ts"
import { summarizeSessionMetrics } from "./build-benchmark-metrics.ts"
import { compactionReceipt, compactionSummaryExposureIsQualified, observeCompactionMarkers, finalCensus } from "./build-benchmark-protocol.ts"
import { computeAlgSourceIdentity } from "../src/source-identity.ts"
import { seedVerificationHostDependencies } from "./verification-host-dependencies.ts"
import { verificationPluginConfiguration, realUserGlobalConfigRoots, snapshotGlobalOpenCodeConfig, stopCapturedProcess } from "./live-verify.ts"

export const LIVE_LIMITS = Object.freeze({ wallMs: 45 * 60_000, assistantTurns: 120, reportedUsageComponents: 600_000, outputTokens: 4096, requestedCompactions: 6, restartAfterCompactions: [3, 5] })
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))
export function observedStopReason(metric: ReturnType<typeof summarizeSessionMetrics>, now: number, deadline: number): string | null {
  if (now >= deadline) return "wall_deadline"
  if (metric.assistantTurns.total >= LIVE_LIMITS.assistantTurns) return "observed_assistant_turn_threshold"
  if (metric.usage.totalReportedTokens >= LIVE_LIMITS.reportedUsageComponents) return "observed_usage_component_threshold"
  return null
}
export function retentionDelta(before: Awaited<ReturnType<typeof scoreRetentionPhase>>, after: Awaited<ReturnType<typeof scoreRetentionPhase>>) {
  // Only unchanged obligations known to pass before the boundary are eligible for loss.
  const comparable = before.checks.filter(b => b.passed).flatMap(b => {
    const sameId = after.checks.filter(a => a.id === b.id)
    // A changed expectation is a new obligation. A missing or ambiguous old
    // obligation is a measured loss, not a disappearing denominator.
    if (sameId.length === 1 && sameId[0]!.expectedDigest !== b.expectedDigest) return []
    const a = sameId.length === 1 && sameId[0]!.expectedDigest === b.expectedDigest && sameId[0]!.category === b.category ? sameId[0] : null
    return [{ id: b.id, category: b.category, retained: a?.passed === true, beforeDigest: b.observedDigest, afterDigest: a?.observedDigest ?? null,
      status: a ? a.passed ? "retained" : "failed" : "missing_or_ambiguous" }]
  })
  return { comparable, atRisk: comparable.length, retained: comparable.filter(c => c.retained).length,
    observedLosses: comparable.filter(c => !c.retained).length,
    interpretation: "Observable artifact/action compliance with durable files available; not hidden-context recall or a causal effect of compaction." }
}
type SummaryReceipt = { requestAcceptance: string; marker: { matchesRequest: boolean; outcome: string }; summary: { outcome: string }; continuation: { status: string }; summaryExposureQualified?: boolean }
/** Historical diagnostic qualification, including completed continuation. */
export function summaryBoundaryQualified(receipt: SummaryReceipt | undefined) {
  return receipt?.requestAcceptance === "accepted" && receipt.marker.matchesRequest === true &&
    receipt.marker.outcome === "new_and_persisted" && receipt.summary.outcome === "terminal_linked" &&
    receipt.continuation.status === "completed"
}
export function retentionEvidenceQualified(input: { stopped: boolean; phases: number; expectedPhases: number; finalQuiescent: boolean; dbQualified: boolean; receipts: readonly SummaryReceipt[] }) {
  return !input.stopped && input.phases === input.expectedPhases && input.finalQuiescent && input.dbQualified &&
    input.receipts.length === LIVE_LIMITS.requestedCompactions && input.receipts.every(summaryBoundaryQualified)
}
export function aggregateRetention(phases: readonly { phase: number; delta: { atRisk: number; observedLosses: number } | null }[], receipts: readonly SummaryReceipt[]) {
  const boundaries = phases.filter(p => p.phase > 0 && p.delta)
  const qualified = boundaries.filter(p => summaryBoundaryQualified(receipts[p.phase - 1]))
  const sum = (rows: typeof boundaries, key: "atRisk" | "observedLosses") => rows.reduce((total, p) => total + (p.delta?.[key] ?? 0), 0)
  // Count from issued receipts, not only phases with a score: failed/missing
  // continuations cannot erase a completed summary. Do not reinterpret legacy receipts.
  const exposures = receipts.flatMap((receipt, index) => compactionSummaryExposureIsQualified(receipt) ? [index + 1] : [])
  const scoredExposures = exposures.flatMap(phase => {
    const matches = phases.filter(p => p.phase === phase)
    return matches.length === 1 && matches[0]!.delta ? [matches[0]!] : []
  })
  return { qualifiedBoundaries: qualified.length, unqualifiedBoundaries: boundaries.length - qualified.length,
    observedBoundaries: boundaries.length, plannedBoundaries: LIVE_LIMITS.requestedCompactions,
    atRisk: sum(qualified, "atRisk"), observedLosses: sum(qualified, "observedLosses"),
    observedLossRate: sum(qualified, "atRisk") > 0 ? sum(qualified, "observedLosses") / sum(qualified, "atRisk") : null,
    diagnosticAtRisk: sum(boundaries, "atRisk"), diagnosticObservedLosses: sum(boundaries, "observedLosses"),
    summaryExposure: { issuedReceipts: receipts.length, observedBoundaries: exposures.length,
      unqualifiedOrUnmeasuredReceipts: receipts.length - exposures.length, scoredBoundaries: scoredExposures.length,
      missingOrAmbiguousScoreBoundaries: exposures.length - scoredExposures.length,
      atRiskKnown: sum(scoredExposures, "atRisk"), observedLossesKnown: sum(scoredExposures, "observedLosses"),
      basis: "Observed completed summaries, independent of continuation success. Counts may be incomplete; census completeness and pre/post behavioral eligibility require separate evidence. No loss rate is computed here." },
    basis: "Legacy completed-continuation diagnostics, not a summary-exposure denominator. summaryExposure retains failed or missing continuations; diagnostics include all scored phase deltas.",
    causalAttribution: "not_established", latentContextRecall: "not_measured", expensiveSearchRepetition: "not_measured_no_live_MCP" }
}
export function verifyFixtureSkills(discovered: unknown, project: string, files: Record<string, string>) {
  if (!Array.isArray(discovered)) throw Error("fixture_skill_catalog_unavailable")
  const expected = Object.entries(files).filter(([path]) => /^\.opencode\/skills\/[^/]+\/SKILL\.md$/.test(path))
  if (expected.length === 0) throw Error("fixture_skill_missing")
  const identity = (path: string) => process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path)
  for (const [path, text] of expected) {
    const name = path.split("/")[2]!, skill = discovered.find((s: any) => s?.name === name)
    const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trim()
    if (!skill || typeof skill.location !== "string" || identity(skill.location) !== identity(join(project, path)) ||
      typeof skill.content !== "string" || skill.content.trim() !== body) throw Error("fixture_skill_mismatch:" + name)
  }
  return expected.map(([path, text]) => ({ name: path.split("/")[2], path, sha256: sha(text) }))
}
interface Config { outputRoot: string; hostExecutable: string; providerID: string; modelID: string; provider: Record<string, unknown>; authFile: string; preflightOnly?: boolean; resumeFrom?: string }
export function validateDiagnosticContinuation(prior: any, model: string, runtimeDigest: string, now: number) {
  if (prior?.schema !== "alg-live-retention-diagnostic-v1" || prior.status !== "stopped" || prior.stopReason !== "preparation_not_qualified" ||
    prior.model !== model || prior.phases?.length !== 1 || prior.phases[0]?.phase !== 0 || prior.receipts?.length !== 0 ||
    prior.cleanup !== true || prior.authCopyRemoved !== true || prior.sourceUnchanged !== true || prior.dbCensus?.qualified !== true ||
    !Number.isFinite(prior.startedAt) || prior.startedAt <= 0 || now >= prior.startedAt + LIVE_LIMITS.wallMs ||
    typeof prior.rootSession !== "string" || !prior.rootSession || !runtimeDigest) throw Error("continuation_parent_ineligible")
  const stop = observedStopReason(prior.metrics, now, prior.startedAt + LIVE_LIMITS.wallMs)
  if (stop) throw Error("continuation_" + stop)
  return { startedAt: prior.startedAt as number, deadline: prior.startedAt + LIVE_LIMITS.wallMs, rootSession: prior.rootSession as string }
}
export async function runLiveRetention(config: Config) {
  const repo = resolve(import.meta.dir, ".."), root = resolve(config.outputRoot), stateRoot = config.resumeFrom ? resolve(config.resumeFrom) : root, project = join(stateRoot, "project")
  if (existsSync(root)) throw Error("Evidence path exists; no implicit rerun")
  const prior = config.resumeFrom ? JSON.parse(readFileSync(join(stateRoot, "result.json"), "utf8")) : null
  const parentPlan = config.resumeFrom ? JSON.parse(readFileSync(join(stateRoot, "plan.json"), "utf8")) : null
  mkdirSync(root, { recursive: true })
  mkdirSync(project, { recursive: true })
  const fixture = liveRetentionFixture(), source = computeAlgSourceIdentity(repo), plugin = verificationPluginConfiguration(repo)
  const continuation = prior ? validateDiagnosticContinuation(prior, config.providerID + "/" + config.modelID, source.digest, Date.now()) : null
  if (parentPlan && parentPlan.runtimeDigest !== source.digest) throw Error("continuation_runtime_changed")
  if (continuation) {
    const marker = join(stateRoot, "continuation-issued.json")
    let previous: any = null
    if (existsSync(marker)) {
      previous = JSON.parse(readFileSync(marker, "utf8"))
      const stopped = JSON.parse(readFileSync(join(previous.outputRoot, "result.json"), "utf8"))
      // One pre-model apparatus failure may be repaired without replaying a call.
      if (previous.previous || stopped.startedAt !== 0 || stopped.phases?.length !== 0 || stopped.receipts?.length !== 0 ||
        stopped.cleanup !== true || stopped.authCopyRemoved !== true || stopped.stopReason !== "verification dependency destination must be fresh") throw Error("continuation_already_issued")
    }
    writeFileSync(marker, JSON.stringify({ outputRoot: root, at: Date.now(), previous }), { flag: previous ? "w" : "wx" })
    cpSync(project, join(root, "parent-project"), { recursive: true, errorOnExist: true })
    for (const name of ["opencode.db", "opencode.db-wal", "opencode.db-shm"]) {
      const path = join(stateRoot, "data/opencode", name)
      if (existsSync(path)) copyFileSync(path, join(root, "parent-" + name))
    }
  }
  const globals = realUserGlobalConfigRoots(), hmac = randomBytes(32), globalBefore = snapshotGlobalOpenCodeConfig(globals, hmac).sha256
  const secrets: string[] = [], env = isolatedEnv(stateRoot), authCopy = join(stateRoot, "data/opencode/auth.json")
  const scrub = (s: string) => secrets.reduce((s, key) => s.replaceAll(key, "[REDACTED]"), s)
  const json = (path: string, value: unknown) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, scrub(JSON.stringify(value, null, 2)) + "\n") }
  const event = (value: unknown) => appendFileSync(join(root, "progress.jsonl"), scrub(JSON.stringify({ at: new Date().toISOString(), ...value as any })) + "\n")
  const put = (path: string, value: string) => { mkdirSync(dirname(join(project, path)), { recursive: true }); writeFileSync(join(project, path), value) }
  const sessions = new Map<string, any>(), messages = new Map<string, any>(), phases: any[] = [], requests: any[] = [], restarts: any[] = [], samples: any[] = [], hosts: any[] = []
  const phasePromptsIssued = new Set<number>()
  if (continuation) {
    for (const s of JSON.parse(readFileSync(join(stateRoot, "sessions.json"), "utf8"))) sessions.set(s.id, s)
    for (const m of JSON.parse(readFileSync(join(stateRoot, "messages.json"), "utf8"))) messages.set(m.sessionID + ":" + m.info.id, m)
  }
  let server: ReturnType<typeof launch> | undefined, api: (path: string, body?: unknown, ms?: number) => Promise<any>
  let rootSession = "", currentPhase = "setup", stopReason: string | null = null, startedAt = 0, deadline = Infinity, cleanup = true, final: any = null, preflight: any = null
  const rootMessages = () => [...messages.values()].filter(m => m.sessionID === rootSession)
  const collect = async () => {
    const until = Date.now() + Math.min(10_000, Math.max(1, deadline - Date.now()))
    const remaining = () => Math.max(1, until - Date.now())
    const rows = await api("/session?limit=10000", undefined, remaining())
    if (!Array.isArray(rows)) throw Error("session_census_not_array")
    if (rows.length >= 10_000) throw Error("session_census_limit_reached")
    let next = 0
    await Promise.all(Array.from({ length: Math.min(4, rows.length) }, async () => {
      while (next < rows.length) {
        const s = rows[next++]
        if (typeof s?.id !== "string" || !s.id) throw Error("session_census_invalid_id")
        const history = await api("/session/" + encodeURIComponent(s.id) + "/message?limit=10000", undefined, remaining())
        if (!Array.isArray(history)) throw Error("message_census_not_array")
        if (history.length >= 10_000) throw Error("message_census_limit_reached")
        sessions.set(s.id, s)
        for (const m of history) {
          if (typeof m?.info?.id !== "string" || !m.info.id) throw Error("message_census_invalid_id")
          const key = s.id + ":" + m.info.id
          messages.set(key, { ...m, sessionID: s.id, benchmarkPhase: messages.get(key)?.benchmarkPhase ?? currentPhase })
        }
      }
    }))
    const metric = summarizeSessionMetrics([...sessions.values()], [...messages.values()])
    samples.push({ at: Date.now(), assistantTurns: metric.assistantTurns.total, reportedUsageComponents: metric.usage.totalReportedTokens, sessions: sessions.size })
    if (startedAt) stopReason ??= observedStopReason(metric, Date.now(), deadline)
    return metric
  }
  const abort = async () => {
    const fresh = await api("/session?limit=10000", undefined, 2000).catch(() => [])
    for (const s of fresh) sessions.set(s.id, s)
    await Promise.all([...sessions.keys()].map(id => api("/session/" + id + "/abort", {}, 2000).catch(() => null)))
  }
  const bounded = async <T>(label: string, fn: () => Promise<T>): Promise<T> => {
    if (Date.now() >= deadline || stopReason) throw Error(stopReason ?? "wall_deadline")
    event({ event: "start", label }); let done = false, caught: unknown, value: T | undefined
    const pending = fn().then(v => { value = v }, e => { caught = e }).finally(() => { done = true })
    while (!done) {
      await Promise.race([pending, sleep(1000)])
      try { await collect() } catch { stopReason ??= "telemetry_failure" }
      if (stopReason || Date.now() >= deadline) { stopReason ??= "wall_deadline"; await abort(); await Promise.race([pending, sleep(2000)]); throw Error(stopReason) }
    }
    if (caught) throw caught
    await collect()
    if (stopReason) throw Error(stopReason)
    event({ event: "complete", label })
    return value!
  }
  const startHost = async () => {
    const port = await freePort(), password = randomBytes(24).toString("hex")
    const authorization = Buffer.from("opencode:" + password).toString("base64"); secrets.push(password, authorization)
    server = launch(config.hostExecutable, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], project, { ...env, OPENCODE_SERVER_PASSWORD: password })
    const tracked = server; hosts.push({ pid: tracked.child.pid, startAt: Date.now() })
    api = async (path, body, ms = 15_000) => {
      const url = new URL(path, "http://127.0.0.1:" + port); url.searchParams.set("directory", project)
      const response = await fetch(url, { method: body === undefined ? "GET" : "POST", headers: { "Content-Type": "application/json", Authorization: "Basic " + authorization }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(ms) })
      if (!response.ok) throw Error("host_http_" + response.status + ":" + path)
      const text = await response.text(); return text ? JSON.parse(text) : null
    }
    for (let i = 0; i < 150; i++) {
      try { await api("/global/health", undefined, 500); return } catch {}
      if (tracked.exit().observed) throw Error("host_exited_during_start")
      if (Date.now() >= deadline) throw Error("wall_deadline")
      await sleep(200)
    }
    throw Error("host_start_deadline")
  }
  const stopHost = async () => {
    if (!server) return
    const receipt = await stopCapturedProcess(server)
    cleanup &&= receipt.passed
    json(join(root, "host-" + hosts.length + ".json"), { ...hosts.at(-1), stopAt: Date.now(), receipt, stdout: server.stdout(), stderr: server.stderr() })
    server = undefined
    if (!receipt.passed) throw Error("host_cleanup_failed")
  }
  const plan = {
    schema: "alg-live-retention-diagnostic-v1", createdAt: new Date().toISOString(), limits: LIVE_LIMITS, model: config.providerID + "/" + config.modelID,
    sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo }).toString().trim(), runtimeDigest: source.digest,
    hostExecutable: config.hostExecutable, hostExecutableSha256: sha(readFileSync(config.hostExecutable)),
    harnesses: Object.fromEntries(["live-retention.ts", "live-retention-fixture.ts", "build-benchmark.ts", "build-benchmark-protocol.ts", "build-benchmark-transport.ts", "build-benchmark-metrics.ts"].map(name => [name, sha(readFileSync(join(repo, "scripts", name)))])),
    phases: fixture.phases, obligations: fixture.phases.map((_, i) => expectedRetentionChecks(i)),
    fixture: Object.fromEntries(Object.entries(fixture.files).map(([path, text]) => [path, sha(text)])),
    interpretation: "One development diagnostic. No Build comparison, no causal or model-generalization claim. Durable task documents remain available. Requested and native compactions counted separately. Observed stop thresholds can overshoot while calls are in flight. Usage component sums are not provider invoice tokens. No timed padding, implicit retry or cap reset.",
    preflightOnly: !!config.preflightOnly, isolation: "Permission-based workspace isolation, not an adversarial sandbox. External scorer/plan are not copied to contestant."
    ,continuation: prior ? { parent: stateRoot, parentResultSha256: sha(readFileSync(join(stateRoot, "result.json"))), originalStartedAt: prior.startedAt,
      originalUsage: prior.metrics.usage.totalReportedTokens, originalAssistantTurns: prior.metrics.assistantTurns.total,
      reason: "Explicit development apparatus repair: original scorer required undeclared duplicate IDs in prose. Preserve original receipt and prepared state; no phase-0 rerun, no time/turn/usage reset." } : null
  }
  json(join(root, "plan.json"), plan)
  try {
    if (!continuation) {
    for (const [path, text] of Object.entries(fixture.files)) put(path, text)
    execFileSync("git", ["init", "-q"], { cwd: project })
    execFileSync("git", ["add", "."], { cwd: project })
    execFileSync("git", ["-c", "user.name=ALG Diagnostic", "-c", "user.email=local@localhost", "commit", "-qm", "Frozen synthetic mission"], { cwd: project })
    }
    if (!continuation) seedVerificationHostDependencies(join(stateRoot, "config/opencode"), repo)
    const auth = JSON.parse(readFileSync(config.authFile, "utf8"))[config.providerID]
    if (!auth) throw Error("provider_not_connected")
    for (const value of Object.values(auth)) if (typeof value === "string" && value.length > 20) secrets.push(value)
    mkdirSync(dirname(authCopy), { recursive: true }); writeFileSync(authCopy, JSON.stringify({ [config.providerID]: auth }))
    const model = config.providerID + "/" + config.modelID, agents: Record<string, unknown> = {}
    for (const role of ["build", "general", "explore", "compaction", "summary", "title", "orchestrator", "explorer", "researcher", "implementer", "checker"]) agents[role] = { model }
    for (const role of ["orchestrator", "explorer", "researcher", "implementer", "checker"]) {
      const path = join(stateRoot, "config/opencode/agents", role + ".md"); mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, readFileSync(join(repo, "agents", role + ".md")))
    }
    json(join(stateRoot, "opencode.json"), { plugin: [plugin.source.spec], autoupdate: false, share: "disabled", snapshot: false, model, small_model: model,
      permission: { "*": "allow", external_directory: "deny", webfetch: "deny", websearch: "deny", question: "deny" }, mcp: {},
      skills: { paths: [join(project, ".opencode/skills")] }, compaction: { auto: true, prune: true }, provider: config.provider, agent: agents })
    json(join(stateRoot, "alg-options.json"), { skillEvolution: { enabled: false }, sessionMemory: { mode: "assist" }, workspace: { mode: "observe" } })
    await startHost()
    const providers = await api!("/provider"), selected = providers.all.find((p: any) => p.id === config.providerID)?.models?.[config.modelID]
    if (!selected || !providers.connected.includes(config.providerID)) throw Error("selected_model_unavailable")
    if (selected.limit?.output !== LIVE_LIMITS.outputTokens) throw Error("output_limit_mismatch")
    const tools = await api!("/experimental/tool/ids")
    if (!tools.includes("alg_run")) throw Error("alg_not_loaded")
    const discoveredSkills = await api!("/skill")
    const fixtureSkills = verifyFixtureSkills(discoveredSkills, project, fixture.files)
    preflight = { health: await api!("/global/health"), tools, selected: { id: config.modelID, limit: selected.limit }, fixtureSkills }
    json(join(root, "preflight.json"), preflight)
    if (!config.preflightOnly) {
      startedAt = continuation?.startedAt ?? Date.now(); deadline = startedAt + LIVE_LIMITS.wallMs
      rootSession = continuation?.rootSession ?? (await api!("/session", { title: "ALG bounded live retention diagnostic" })).id
      let previousScore: Awaited<ReturnType<typeof scoreRetentionPhase>> | undefined
      if (continuation) {
        await collect()
        if (stopReason) throw Error(stopReason)
        previousScore = await scoreRetentionPhase(project, 0)
        json(join(root, "parent-rescore.json"), { originalScore: prior.phases[0].score, correctedScore: previousScore, paidPhaseRepeated: false })
        if (!previousScore.passed) throw Error("continuation_preparation_still_invalid")
        phases.push({ ...prior.phases[0], score: previousScore, apparatusReassessment: true })
      }
      for (let i = continuation ? 1 : 0; i < fixture.phases.length; i++) {
        currentPhase = fixture.phases[i]!.id
        for (const [path, value] of Object.entries(phaseUpdates(i))) put(path, value)
        let request: any
        if (i > 0) {
          const beforeMessages = structuredClone(rootMessages()), frozenAt = Date.now()
          const frozen = { frozenAt, beforeScore: previousScore, expectedNext: expectedRetentionChecks(i) }
          json(join(root, "boundary-" + i + "-frozen.json"), frozen)
          request = { requestId: randomBytes(16).toString("hex"), requestedAt: new Date().toISOString(), rootSessionId: rootSession, beforeMessages, response: null, afterMessages: [], continuation: { status: "not_completed" } }
          requests.push(request)
          request.response = await bounded("compaction-" + i, () => api!("/session/" + rootSession + "/summarize", { providerID: config.providerID, modelID: config.modelID }, Math.max(1, deadline - Date.now())))
          request.afterMessages = structuredClone(rootMessages())
          if (LIVE_LIMITS.restartAfterCompactions.includes(i)) {
            await stopHost(); const at = Date.now(); await startHost(); await collect()
            const persisted = await api!("/session/" + encodeURIComponent(rootSession), undefined, 2000)
            const sessionPersisted = persisted?.id === rootSession
            restarts.push({ boundary: i, at, rootSession, sessionPersisted })
            if (!sessionPersisted) throw Error("root_session_not_persisted_after_restart")
            if (i === 3) verifyFixtureSkills(await api!("/skill"), project, { ...fixture.files, ...phaseUpdates(i) })
            event({ event: "restart", boundary: i, rootSession })
          }
        }
        const prompt = (i === 0 ? "Complete the staged mission using ALG implement/check graphs. Use the supplied project procedures. Work only inside this workspace; no installs, network or global configuration changes. Keep graph tasks small enough to finish each phase. Preserve the supplied sources and previous outputs.\n\n" : "") + fixture.phases[i]!.prompt
        phasePromptsIssued.add(i)
        const outcome = await bounded(currentPhase, () => sendBenchmarkPrompt({ api: api!, sessionID: rootSession,
          body: { model: { providerID: config.providerID, modelID: config.modelID }, agent: "orchestrator", parts: [{ type: "text", text: prompt }] },
          deadline, cancelled: () => stopReason }))
        const score = await scoreRetentionPhase(project, i), finishedAt = Date.now()
        const phase = { phase: i, finishedAt, outcome: outcome.status, score, delta: previousScore ? retentionDelta(previousScore, score) : null }
        phases.push(phase); json(join(root, "phase-" + i + ".json"), phase)
        if (request) {
          const assistant = "assistant" in outcome ? outcome.assistant as any : null
          request.continuationMessages = structuredClone(rootMessages())
          request.continuation = { status: outcome.status, userMessageID: assistant?.info?.parentID, assistantID: assistant?.info?.id, scorePassed: score.passed }
          json(join(root, "boundary-" + i + ".json"), { receipt: compactionReceipt(request), beforeScore: previousScore, afterScore: score, delta: phase.delta })
        }
        event({ event: "phase_score", phase: i, passed: score.passed, outcome: outcome.status, checks: score.checks.map(c => ({ id: c.id, passed: c.passed })) })
        if (outcome.status !== "completed") throw Error("phase_transport_" + outcome.status)
        if (i === 0 && !score.passed) throw Error("preparation_not_qualified")
        // Later failures remain recorded; do not repeat a failed phase or restate its missed facts.
        previousScore = score
      }
    }
  } catch (error) { stopReason ??= error instanceof Error ? error.message : String(error); event({ event: "stopped", reason: stopReason }) }
  finally {
    if (server) {
      if (stopReason) await abort().catch(() => null)
      final = await finalCensus({ graceMs: 7000, pollMs: 250, census: async () => {
        const metric = await collect(), statuses = await api!("/session/status")
        const active = Object.values(statuses).filter((s: any) => s.type !== "idle").length
        const pending = [...messages.values()].some(m => m.parts?.some((p: any) => p.type === "tool" && ["pending", "running"].includes(p.state?.status)))
        return { metrics: metric, activeSessions: active, pendingWork: pending, quiescent: active === 0 && !pending }
      } })
      if (!final.quiescent) { stopReason ??= "final_census_unresolved"; await abort().catch(() => null) }
      await stopHost().catch(() => { cleanup = false })
    }
    if (existsSync(authCopy)) unlinkSync(authCopy)
    const endedAt = Date.now(), metric = summarizeSessionMetrics([...sessions.values()], [...messages.values()])
    // Preserve useful partial artifacts after cancellation; never promote them
    // into a completed continuation or count absent unfinished work as forgetting.
    let partialArtifactAudit: unknown = null
    const partialIndex = [...phasePromptsIssued].find(i => !phases.some(p => p.phase === i))
    if (partialIndex !== undefined) {
      try {
        const score = await scoreRetentionPhase(project, partialIndex)
        const before = phases.find(p => p.phase === partialIndex - 1)?.score
        partialArtifactAudit = { phase: partialIndex, phaseCompleted: false, score, delta: before ? retentionDelta(before, score) : null,
          interpretation: "Post-stop artifact compliance only. Missing or incorrect unfinished work does not establish compaction loss; this is not a completed workflow." }
      } catch { partialArtifactAudit = { phase: partialIndex, phaseCompleted: false, error: "partial_artifact_audit_unavailable" } }
      json(join(root, "partial-artifact-audit.json"), partialArtifactAudit)
    }
    let dbCensus: any = { qualified: false, reason: "database_not_found" }
    const dbPath = join(stateRoot, "data/opencode/opencode.db")
    if (existsSync(dbPath)) {
      let db: Database | undefined
      try {
        db = new Database(dbPath, { readonly: true })
        const dbSessions = db.query("SELECT id FROM session").all() as { id: string }[]
        const dbMessages = db.query("SELECT id, session_id FROM message").all() as { id: string; session_id: string }[]
        const missingSessions = dbSessions.filter(s => !sessions.has(s.id)).map(s => s.id)
        const missingMessages = dbMessages.filter(m => !messages.has(m.session_id + ":" + m.id)).map(m => m.id)
        dbCensus = { qualified: final?.quiescent === true && missingSessions.length === 0 && missingMessages.length === 0 && dbSessions.length === sessions.size && dbMessages.length === messages.size,
          databaseSessions: dbSessions.length, databaseMessages: dbMessages.length, missingSessions, missingMessages, basis: "Read-only persisted database ID census after host stop; session-reported usage, not provider invoice completeness." }
      } catch { dbCensus = { qualified: false, reason: "database_schema_or_read_unavailable" } } finally { db?.close() }
    }
    const markers = observeCompactionMarkers([...messages.values()])
    const receipts = requests.map(request => compactionReceipt(request))
    const requestedIds = new Set(receipts.map(r => r.marker.id).filter(Boolean))
    const observed = { totalMarkers: markers.length, requestedLinked: markers.filter(m => requestedIds.has(m.id) && m.summary).length,
      nativeLinked: markers.filter(m => m.auto === true && !requestedIds.has(m.id) && m.summary).length,
      unlinked: markers.filter(m => !m.summary).length, unknownOrigin: markers.filter(m => !requestedIds.has(m.id) && m.auto !== true).length }
    const summariesQualified = receipts.length === LIVE_LIMITS.requestedCompactions && receipts.every(summaryBoundaryQualified)
    if (!config.preflightOnly && !stopReason && !summariesQualified) stopReason = "compaction_summaries_unqualified"
    if (!config.preflightOnly && !stopReason && phases.some(p => p.score?.passed !== true)) stopReason = "phase_score_failed"
    const protocolComplete = !config.preflightOnly && retentionEvidenceQualified({ stopped: !!stopReason, phases: phases.length, expectedPhases: fixture.phases.length,
      finalQuiescent: final?.quiescent === true, dbQualified: dbCensus.qualified, receipts })
    const exposureQualified = startedAt > 0 && endedAt > startedAt && final?.quiescent === true && dbCensus.qualified
    const result = { schema: plan.schema, status: config.preflightOnly ? stopReason ? "preflight_failed" : "preflight_passed" : stopReason ? "stopped" : "completed",
      stopReason, startedAt, endedAt, activeWallMs: startedAt ? endedAt - startedAt : null, model: plan.model, rootSession, phases, protocolComplete,
      plannedPhases: fixture.phases.length, observedPhases: phases.length, compactions: observed, receipts, restarts, metrics: metric,
      rates: exposureQualified ? { basis: "observed bounded exposure; partial protocol permitted", requestedPerTaskHour: observed.requestedLinked / ((endedAt - startedAt) / 3_600_000), nativePerTaskHour: observed.nativeLinked / ((endedAt - startedAt) / 3_600_000), nativePer100AssistantTurns: metric.assistantTurns.total ? observed.nativeLinked * 100 / metric.assistantTurns.total : null } : null,
      retention: aggregateRetention(phases, receipts), partialArtifactAudit,
      dbCensus, finalCensus: final, cleanup, authCopyRemoved: !existsSync(authCopy), globalConfigurationUnchanged: snapshotGlobalOpenCodeConfig(globals, hmac).sha256 === globalBefore,
      sourceUnchanged: computeAlgSourceIdentity(repo).digest === source.digest, planSha256: sha(readFileSync(join(root, "plan.json"))),
      limits: LIVE_LIMITS, overshoot: { assistantTurns: Math.max(0, metric.assistantTurns.total - LIVE_LIMITS.assistantTurns), reportedUsageComponents: Math.max(0, metric.usage.totalReportedTokens - LIVE_LIMITS.reportedUsageComponents) },
      unmeasured: ["provider invoice", "hidden context contents", "causal compaction loss", "Build comparison", "multi-hour natural saturation", "MCP search cost"] }
    json(join(root, "messages.json"), [...messages.values()]); json(join(root, "sessions.json"), [...sessions.values()])
    json(join(root, "samples.json"), samples); json(join(root, "markers.json"), markers); json(join(root, "result.json"), result)
    console.log(JSON.stringify({ status: result.status, stopReason, completedPhases: phases.length, compactions: observed, restarts: restarts.length, cleanup, dbCensus: dbCensus.qualified }))
    if (stopReason || !cleanup || !result.authCopyRemoved || !result.globalConfigurationUnchanged || !result.sourceUnchanged) process.exitCode = 1
  }
}
if (import.meta.main) {
  if (!process.argv[2]) throw Error("Usage: bun scripts/live-retention.ts <non-secret-config.json>")
  await runLiveRetention(JSON.parse(readFileSync(resolve(process.argv[2]), "utf8")))
}


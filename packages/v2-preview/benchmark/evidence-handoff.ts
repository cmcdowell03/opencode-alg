import { chmod, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { fixtureProject, hostVersion, owner, receiptsFor, requestOptions, startHost, toolCalls, transcript } from "../acceptance/host.ts"
import { runtimeIdentity, sha256, waitFor } from "../acceptance/runtime.ts"
import { startFactory } from "../acceptance/service.ts"
import { checkedHandoff, checkerPrompt, classifyEvidenceHandoff, continuation, type EvidenceCase, evidenceCases,
  evidenceFixture, evidenceSkill, handoffHeader, initialPrompt, skillId } from "./evidence-handoff-case.ts"
import { evidenceDecisionGrade, evidenceOracle, evidenceWire } from "./evidence-handoff-grade.ts"
import { scriptedEvidenceHandoff } from "./evidence-handoff-script.ts"
import { object } from "./handoff-case.ts"
import { type ArmName, type Host, type Turn, armNames, checkerName, contextWindow, installAlg, observeTurn,
  pluginId, prepareHost, registerSkill, submitTurn } from "./host.ts"
import { startNativeObserver } from "./native-observer.ts"
import { nativeLimits, nativeModel, nativeProviderConfig, stageNativeCredential } from "./native-provider.ts"
import { summaryHash } from "./compaction.ts"
import { inputUsage } from "./input-usage.ts"
import { collectSessionEvidence } from "./session-evidence.ts"
import { maxProviderBytes, maxProviderCalls, startTransport, type Message } from "./transport.ts"
import { createWorkbench, evidenceToolNames, startWorkbench } from "./workbench.ts"

type Options = { binary: string; bundle: string; scenario: EvidenceCase; reverse?: boolean; nativeChildAudit?: boolean
  native?: { model: string; authPath?: string } }
const prefix = "alg-v2-evidence-handoff-"
const fixtureModel = { providerID: "paired-benchmark", id: "fixture" }
const budget = 4

function lookupLimits(turn?: Turn) {
  return toolCalls(turn?.rows ?? []).filter(call => call.name === "evidence_lookup_pages").flatMap(call => {
    const pages = object("input" in call.state && call.state.input)?.pages
    return Array.isArray(pages) && pages.length === 1 && pages[0]?.source === "inspection" && pages[0]?.cursor == null &&
      typeof pages[0]?.limit === "number" ? [pages[0].limit as number] : [-1]
  })
}

async function runArm(arm: ArmName, options: Options, scratch: string, bundleSha256: string) {
  const model = options.native ? nativeModel(options.native.model) : fixtureModel
  const workbench = createWorkbench({ maxAcceptedQueries: budget, fixture: evidenceFixture(options.scenario) })
  const evidence = startWorkbench(workbench)
  const factory = arm === "alg" ? startFactory(join(scratch, "factory"), false) : undefined
  const wires: (ReturnType<typeof evidenceWire> & { id: number; phase: string })[] = []
  let phase = "setup"
  let skill: Awaited<ReturnType<typeof registerSkill>> | undefined
  const classify = (messages: Message[], id: number) => {
    const scope = classifyEvidenceHandoff(messages)
    wires.push({ ...evidenceWire(messages), id, phase })
    return phase === "compact" ? { role: "root" as const, phase } : scope
  }
  const providerOptions = { id: model.id, classify, stale: "unsupported", correction: handoffHeader,
    skill: () => skill?.witness }
  const native = options.native && startNativeObserver(providerOptions)
  const scripted = native ? undefined : startTransport({ ...providerOptions, seed: 103, decide: scriptedEvidenceHandoff })
  const observer = native || scripted!
  observer.releaseSummary()

  type Row = Awaited<ReturnType<typeof transcript>>[number]
  let host: Host | undefined
  let rootId: string | undefined, checkerId: string | undefined
  let rootRows: Row[] | null = null, checkerRows: Row[] | null = null
  let sessionEvidence: Awaited<ReturnType<typeof collectSessionEvidence>> | null = null
  let initial: Turn | undefined, resumed: Turn | undefined, checker: Turn | undefined, final: Turn | undefined
  let compacted: Extract<Row, { type: "compaction"; status: "completed" }> | undefined
  let beforeRestart = workbench.snapshot()
  let restart: { fromPid: number; toPid: number; transcriptStable: boolean } | undefined
  let failure: string | null = null, treatment: string | null = null, correction: string | null = null
  let resumeUserId: string | undefined, initialUserId: string | undefined
  let factoryEvidence: Awaited<ReturnType<NonNullable<typeof factory>["evidence"]>> | null = null
  const started = performance.now()
  try {
    const fixture = await fixtureProject(scratch, "project")
    const project = await prepareHost(scratch, { model, providerUrl: scripted?.url, checkerUrl: evidence.checkerEndpoint,
      evidenceUrl: evidence.endpoint, skill: { name: skillId, content: evidenceSkill },
      providers: native ? nativeProviderConfig(contextWindow, model.id) : undefined, bundle: factory ? options.bundle : undefined })
    project.config.compaction.auto = false
    const env: NodeJS.ProcessEnv = project.settings.env
    env.PATH = dirname(Bun.which("git")!) + delimiter + env.PATH
    if (native) await stageNativeCredential(project.settings.env, options.native?.authPath)
    await writeFile(project.configPath, JSON.stringify(project.config))
    const location = { directory: project.directory }
    const start = () => startHost(options.binary, project.directory, project.settings)
    host = await start()
    skill = await registerSkill(host, project, skillId)
    if (factory || native) {
      await host.process.kill()
      if (native) project.config.plugins.push(await native.stage(join(scratch, "observer")))
      if (factory) await installAlg(project, options.bundle, skill, factory, options.nativeChildAudit
        ? { agent: checkerName, tool: "audit_lookup_pages", source: "clock-audit", scope: "whole-source" } : undefined)
      await writeFile(project.configPath, JSON.stringify(project.config))
      host = await start()
    }
    const root = await host.client.session.create({ location, model, agent: owner, title: "Bounded inspection handoff" }, requestOptions())
    rootId = root.id
    if (root.projectID !== fixture.id || root.agent !== owner || root.model?.providerID !== model.providerID ||
        root.model?.id !== model.id) throw new Error("Fixture owner identity mismatch")
    native && native.bindRoot(root.id)
    factory?.bindProject(root.projectID)
    async function ready() {
      await waitFor(async () => {
        const plugins = (await host!.client.plugin.list({ location }, requestOptions())).data
        const plugin = plugins.find(row => row.id === pluginId)
        treatment = plugin?.state.status ?? null
        if (treatment === "failed" || (!factory && plugin)) throw new Error("Unexpected preview plugin state")
        const mcp = (await host!.client.mcp.list({ location }, requestOptions())).data
        if ((!factory || treatment === "active") && mcp.length === 2 && mcp.every(row => row.status.status === "connected") &&
            (!native || native.ready(host!.info.pid))) return true
      }, 8000, "Installed preview, transport, or scoped evidence unavailable")
    }
    await ready()
    if (native) {
      await waitFor(async () => {
        const [credentials, catalog] = await Promise.all([
          host!.client.credential.list(requestOptions()), host!.client.model.list({ location, types: ["chat"] }, requestOptions()),
        ])
        if (credentials.some(row => row.active && row.integrationID === model.providerID && row.value.type === "oauth") &&
            catalog.data.some(row => row.enabled && row.providerID === model.providerID && (row.id === model.id || row.modelID === model.id))) return true
      }, 6000, "Native OAuth model catalog unavailable")
    }
    async function turn(text: string, session = root.id, record?: (id: string) => void) {
      const id = await submitTurn(host!, session, text)
      record?.(id)
      return waitFor(() => observeTurn(host!, session, id), native ? 85_000 : 30_000, "Host response deadline")
    }
    phase = "initial"
    initial = await turn(initialPrompt, root.id, id => { initialUserId = id })
    beforeRestart = workbench.snapshot()
    phase = "compact"
    const prior = new Set((await transcript(host.client, root.id)).map(row => row.id))
    await host.client.session.compact({ sessionID: root.id, delivery: "queue" }, requestOptions())
    compacted = await waitFor(async () => {
      const rows = await transcript(host!.client, root.id)
      const cut = rows.find(row => row.type === "compaction" && row.reason === "manual" && !prior.has(row.id))
      if (cut?.type === "compaction" && cut.status === "failed") throw new Error("Manual compaction failed")
      if (cut?.type === "compaction" && cut.status === "completed" && rows.at(-1)?.type === "idle") return cut
    }, native ? 65_000 : 20_000, "No completed manual compaction")
    const saved = await transcript(host.client, root.id)
    const fromPid = host.info.pid
    phase = "restart"
    if (!(await host.process.kill()).signalled || !host.process.exited()) throw new Error("Prior host did not stop")
    host = await start()
    const loaded = await host.client.session.get({ sessionID: root.id }, requestOptions())
    const transcriptStable = isDeepStrictEqual(saved, await transcript(host.client, root.id))
    restart = { fromPid, toPid: host.info.pid, transcriptStable }
    if (fromPid === host.info.pid || loaded.id !== root.id || loaded.projectID !== root.projectID ||
        loaded.agent !== root.agent || !transcriptStable ||
        !isDeepStrictEqual(beforeRestart, workbench.snapshot())) throw new Error("Restart did not preserve session, compaction and ledger")
    await ready()
    phase = "resume"
    resumed = await turn(continuation, root.id, id => { resumeUserId = id })
    if (options.scenario === "held-out") {
      phase = "audit"
      const child = await host.client.session.create({ location, model, agent: checkerName, parentID: root.id,
        title: "Independent inspection clock audit" }, requestOptions())
      if (child.id === root.id || child.parentID !== root.id || child.projectID !== root.projectID || child.agent !== checkerName ||
          child.model?.id !== model.id || child.model.providerID !== model.providerID) throw new Error("Fixture checker identity mismatch")
      checkerId = child.id
      native && native.bindChecker(child.id)
      checker = await turn(checkerPrompt, child.id)
      correction = checkedHandoff(checker.text, options.scenario)
      if (correction) {
        phase = "resolve"
        final = await turn(correction)
      }
    }
    phase = "complete"
  } catch (error) {
    failure = native && native.failure() || (error instanceof Error ? error.message : String(error))
  } finally {
    try {
      if (host && !host.process.exited()) {
        if (rootId) sessionEvidence = await collectSessionEvidence(host.client, rootId, checkerId)
        rootRows = rootId ? await transcript(host.client, rootId).catch(() => null) : null
        checkerRows = checkerId ? await transcript(host.client, checkerId).catch(() => null) : null
        await host.process.kill()
      }
      factoryEvidence = factory ? await factory.evidence().catch(() => null) : null
    } finally {
      observer.stop()
      evidence.stop()
      await factory?.stop()
    }
  }
  const status = (turn?: Turn) => receiptsFor(turn?.rows ?? [], "status")
  const ledger = workbench.snapshot()
  const resumedWire = wires.find(row => row.phase === "resume")
  const initialLimits = lookupLimits(initial), resumeLimits = lookupLimits(resumed)
  // A native completion can wake the owner before the benchmark's explicit
  // relay. Include that turn in the assessment, bounded by the graded answer.
  const noticeIndex = rootRows?.findIndex(row => row.type === "synthetic" && row.metadata?.source === "subagent" &&
    row.metadata.childID === checkerId && row.metadata.state === "completed" && row.metadata.agent === checkerName) ?? -1
  const finalIndex = rootRows?.findIndex(row => row.id === final?.id) ?? -1
  const decisionRows = options.nativeChildAudit && noticeIndex >= 0 && finalIndex > noticeIndex
    ? rootRows!.slice(noticeIndex + 1, finalIndex + 1) : final?.rows ?? []
  const grade = evidenceDecisionGrade(options.scenario, arm, {
    initial: initial?.text ?? null, resume: resumed?.text ?? null, final: final?.text ?? null, checkerVerified: !!correction,
    ledger, beforeRestart, initialLimits, resumeLimits, initialStatus: status(initial), resumeStatus: status(resumed),
    finalStatus: receiptsFor(decisionRows, "status"), acknowledgements: receiptsFor(decisionRows, "set_next_measurement"), resumedWire, bundleSha256,
  })
  const indexOf = (id?: string) => rootRows?.findIndex(row => row.id === id) ?? -1
  const summaryRequests = observer.requests.filter(row => row.kind === "summary" && row.role === "root" && row.status === 200)
  const rootRequests = observer.requests.filter(row => row.kind === "ordinary" && row.role === "root")
  const checkerRequests = observer.requests.filter(row => row.kind === "ordinary" && row.role === "checker")
  const toolsIn = (rows: typeof rootRequests, allowed: string, denied: string) => rows.length > 0 && rows.every(row =>
    evidenceToolNames.every(name => row.tools.includes(allowed + "_" + name) && !row.tools.includes(denied + "_" + name)))
  const checks = {
    rootAndCheckerScopes: toolsIn(rootRequests, "evidence", "audit") &&
      (options.scenario === "held-out" ? toolsIn(checkerRequests, "audit", "evidence") : checkerRequests.length === 0),
    verifiedRestart: !!restart && restart.fromPid !== restart.toPid && restart.transcriptStable,
    realCutAfterUnfinishedTurn: !!compacted && summaryRequests.length === 1 &&
      summaryRequests[0]?.summaryResponseSha256 === summaryHash(compacted.summary) &&
      indexOf(initialUserId) >= 0 && indexOf(initial?.id) > indexOf(initialUserId) &&
      indexOf(compacted.id) > indexOf(initial?.id) && indexOf(resumeUserId) > indexOf(compacted.id) &&
      indexOf(resumed?.id) > indexOf(resumeUserId),
    bareContinuation: rootRows?.some(row => row.type === "user" && row.id === resumeUserId && row.text === continuation) === true,
    observedCorrection: correction === null || rootRows?.some(row => row.type === "user" && row.text === correction) === true,
    governedBookkeeping: arm === "build" ? factoryEvidence === null :
      !!factoryEvidence && factoryEvidence.ledger.acceptedComputations === (options.scenario === "held-out" && correction ? 1 : 0) &&
      factoryEvidence.jobs.length === factoryEvidence.ledger.acceptedComputations,
  }
  const usage = inputUsage(observer.requests, !!native, sessionEvidence)
  const uncachedInputTokens = usage.inputTokens === null || usage.cachedInputTokens === null
    ? null : usage.inputTokens - usage.cachedInputTokens
  return { arm, phase, failure, model, treatment, skill: skill && { sha256: skill.sha256, sourceSha256: skill.sourceSha256 },
    passed: !failure && grade.passed && Object.values(checks).every(Boolean), checks, grade,
    ledger, beforeRestart, restart, compactionId: compacted?.id ?? null,
    correction, raw: { root: rootRows, checker: checkerRows }, wires, requests: observer.requests, sessionEvidence,
    inputUsage: { ...usage, uncachedInputTokens },
    limits: { initial: initialLimits, resume: resumeLimits }, factory: factoryEvidence, elapsedMs: performance.now() - started }
}

export async function runEvidenceHandoff(options: Options) {
  const parent = await realpath(tmpdir())
  const scratch = await mkdtemp(join(parent, prefix))
  try {
    if (process.platform !== "win32") await chmod(scratch, 0o700)
    const runtime = await runtimeIdentity(options.binary, options.bundle, await hostVersion(options.binary, join(scratch, "version")))
    const fixture = evidenceFixture(options.scenario)
    const freeze = {
      evidenceSha256: sha256(JSON.stringify([fixture.evidence,
        fixture.pageRows({ source: "inspection", offset: 0, limit: 8 }, fixture.evidence.inspection.slice(0, 8))])),
      oracleSha256: sha256(JSON.stringify(evidenceOracle[options.scenario])),
      graderSha256: sha256((await readFile(new URL("./evidence-handoff-grade.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n")),
      skillSha256: sha256(evidenceSkill), promptsSha256: sha256(JSON.stringify([initialPrompt, checkerPrompt, continuation])),
    }
    const order = options.reverse ? [...armNames].reverse() : [...armNames]
    const arms = {} as Record<ArmName, Awaited<ReturnType<typeof runArm>>>
    for (const arm of order) arms[arm] = await runArm(arm, options, join(scratch, arm), runtime.bundleSha256)
    const { build, alg } = arms
    const scan = (arm: typeof build) => arm.ledger.receipts.filter(row => row.outcome === "admitted")
      .map(({ scope, pages, evidenceRefs }) => ({ scope, pages, evidenceRefs }))
    const parity = {
      model: isDeepStrictEqual(build.model, alg.model),
      skill: !!build.skill && isDeepStrictEqual(build.skill, alg.skill) && build.skill.sourceSha256 === sha256(evidenceSkill),
      treatment: build.treatment === null && alg.treatment === "active",
      budget: build.ledger.maxAcceptedQueries === budget && alg.ledger.maxAcceptedQueries === budget,
      correction: build.correction === alg.correction && (options.scenario !== "held-out" || build.correction !== null),
      work: isDeepStrictEqual(scan(build), scan(alg)),
      runtimeUnchanged: isDeepStrictEqual(runtime, await runtimeIdentity(options.binary, options.bundle, runtime.version)),
    }
    return { schema: 1, caseId: fixture.id, scenario: options.scenario, order, runtime, parity,
      passed: build.passed && alg.passed && Object.values(parity).every(Boolean),
      mode: options.native ? "native-openai-oauth" : "scripted-transport", mechanicsOnly: !options.native,
      freeze, nativeChildAudit: !!options.nativeChildAudit,
      limits: options.native ? nativeLimits : { calls: maxProviderCalls, requestBytes: maxProviderBytes }, arms }
  } finally {
    const real = await realpath(scratch)
    if (dirname(real) !== parent || !basename(real).startsWith(prefix)) throw new Error("Evidence handoff scratch cleanup refused")
    await rm(real, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}

const usage = "Usage: bun packages/v2-preview/benchmark/evidence-handoff.ts --host <OpenCode 2.3.2> --package <staged bundle> --out <new JSON> [--case held-out|exhausted|changed] [--order build-first|alg-first] [--native-child-audit] [--native-model openai/<id> --allow-model-calls [--auth-file <path>]]"
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--help") console.log(usage)
  else {
    const flags = new Map<string, string>()
    const allowed = ["--host", "--package", "--out", "--case", "--order", "--native-model", "--auth-file", "--allow-model-calls", "--native-child-audit"]
    for (let i = 0; i < args.length; i++) {
      const flag = args[i]!, value = ["--allow-model-calls", "--native-child-audit"].includes(flag) ? "true" : args[++i]
      if (!allowed.includes(flag) || flags.has(flag) || !value || value.startsWith("--")) throw new Error(usage)
      flags.set(flag, value)
    }
    const binary = flags.get("--host"), bundle = flags.get("--package"), out = flags.get("--out")
    const scenario = flags.get("--case") ?? "held-out", order = flags.get("--order") ?? "build-first"
    const model = flags.get("--native-model"), authPath = flags.get("--auth-file")
    if (!binary || !bundle || !out || !evidenceCases.includes(scenario as EvidenceCase) ||
        !["build-first", "alg-first"].includes(order) || !!model !== flags.has("--allow-model-calls") ||
        (authPath && !model) || (model && scenario !== "held-out")) throw new Error(usage)
    if (model) nativeModel(model)
    const executable = await realpath(binary), staged = await realpath(bundle)
    const file = await open(resolve(out), "wx")
    try {
      const result = await runEvidenceHandoff({ binary: executable, bundle: staged,
        scenario: scenario as EvidenceCase, reverse: order === "alg-first", nativeChildAudit: flags.has("--native-child-audit"),
        native: model ? { model, authPath: authPath && resolve(authPath) } : undefined })
      await file.writeFile(JSON.stringify(result, null, 2) + "\n")
      await file.sync()
      console.log(JSON.stringify({ passed: result.passed, mode: result.mode, parity: result.parity,
        arms: Object.fromEntries(armNames.map(arm => [arm, { failure: result.arms[arm].failure, checks: result.arms[arm].checks,
          grade: result.arms[arm].grade, inputUsage: result.arms[arm].inputUsage }])) }))
      process.exitCode = result.passed ? 0 : 1
    } finally { await file.close() }
  }
}

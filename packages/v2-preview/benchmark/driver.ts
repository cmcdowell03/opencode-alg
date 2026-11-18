import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { asObject, owner, receiptsFor, requestOptions, startHost, toolCalls, transcript } from "../acceptance/host.ts"
import { startFactory } from "../acceptance/service.ts"
import { sha256, waitFor } from "../acceptance/runtime.ts"
import { researchCase, observationFor, type CaseVariant } from "./case.ts"
import { assessCompaction, summaryHash, type CompactionWitness } from "./compaction.ts"
import { checkerName, contextWindow, installAlg, observeAlgDecision, observeTurn, pluginId, prepareHost, registerSkill, submitTurn,
  type ArmName, type Host, type Turn } from "./host.ts"
import { isWrongRootReturn, type RunObservation } from "./score.ts"
import { applyPrompt, checkpointPrompt, classify, correctionDescription, pressurePrompt, scriptedTurn } from "./script.ts"
import { startTransport } from "./transport.ts"
import { nativeModel, nativeProviderConfig, stageNativeCredential } from "./native-provider.ts"
import { createWorkbench, startWorkbench } from "./workbench.ts"
import { collectSessionEvidence } from "./session-evidence.ts"

export type BenchmarkOptions = {
  binary: string; bundle: string; seed: number; scratch: string; native?: { model: string; authPath?: string }; context?: number; variant?: CaseVariant
}
const turnMs = 35_000
const wait = <T>(read: () => Promise<T | undefined>, ms: number, failure: string) => waitFor(read, ms, failure)
const optional = <T>(read: () => Promise<T | undefined>, ms: number) =>
  wait(read, ms, "Observation deadline").catch(error => {
    if (error instanceof Error && error.message === "Observation deadline") return undefined
    throw error
  })

export async function runArm(arm: ArmName, options: BenchmarkOptions) {
  let started: number | undefined
  let elapsedMs: number | null = null
  let hostEvidence: Awaited<ReturnType<typeof collectSessionEvidence>> | null = null
  const scratch = join(options.scratch, arm)
  const variant = options.variant ?? "positive"
  const researchObservation = observationFor(variant)
  const workbench = createWorkbench({ variant })
  const evidence = startWorkbench(workbench)
  const factory = arm === "alg" ? startFactory(join(scratch, "unused-factory"), false) : undefined
  const model = options.native ? nativeModel(options.native.model) : { providerID: "paired-benchmark", id: "fixture" }
  let skill: Awaited<ReturnType<typeof registerSkill>> | undefined
  const observerOptions = { id: model.id, classify, stale: researchObservation.staleEvidenceRef,
    correction: researchObservation.correctionEvidenceRef, skill: () => skill?.witness }
  const native = options.native ? (await import("./native-observer.ts")).startNativeObserver(observerOptions) : undefined
  const scripted = native ? undefined : startTransport({ ...observerOptions, seed: options.seed, decide: scriptedTurn })
  const transport = native ?? scripted!
  const hosts: Host[] = []
  const w: CompactionWitness = { before: [] }
  let initial: Turn | undefined, independent: Turn | undefined, final: Turn | undefined
  let phase = "prepare", failure: string | undefined
  let sessionId: string | undefined, checkerId: string | undefined, hostPid: number | undefined
  let mcp: Record<string, string> = {}
  let nativeCatalog: { oauth: boolean; modelAvailable: boolean } | null = null
  let plugin: string | null = null, tokens: number | null = null
  let activated = 0
  let checkpointToolOutcomes: {action: string; ok: boolean; error: string | null}[] = []
  let checkpoint: ReturnType<typeof decision> = null, correctedDecision: ReturnType<typeof decision> = null
  let readback: ReturnType<typeof observeAlgDecision> = null
  let decisionSavedAtMs: number | null = null
  const postCorrectionTurns: Turn[] = []
  let correctionMessageId: string | null = null
  let verdictReady = false
  let compactionRows: { id: string; reason: string; status: string; hasStale: boolean; hasCorrection: boolean; sha256: string | null }[] = []

  try {
    const project = await prepareHost(scratch, { model, providerUrl: scripted?.url,
      providers: native ? nativeProviderConfig(options.context ?? contextWindow, model.id) : undefined,
      evidenceUrl: evidence.endpoint, checkerUrl: evidence.checkerEndpoint,
      skill: { name: researchCase.skillName, content: researchCase.skillContent },
      bundle: arm === "alg" ? options.bundle : undefined, context: options.context })
    if (native) {
      phase = "native_credential"
      await stageNativeCredential(project.settings.env, options.native?.authPath)
    }
    phase = "discover_skill"
    let host = await startHost(options.binary, project.directory, project.settings)
    hosts.push(host)
    skill = await registerSkill(host, project, researchCase.skillName)
    if (factory || native) {
      await host.process.kill()
      if (native) project.config.plugins.unshift(await native.stage(join(scratch, "native-observer")))
      if (factory) await installAlg(project, options.bundle, skill, factory)
      else await writeFile(project.configPath, JSON.stringify(project.config))
      host = await startHost(options.binary, project.directory, project.settings)
      hosts.push(host)
    }
    hostPid = host.info.pid
    phase = "runtime_identity"
    const location = { directory: project.directory }
    if (native) {
      phase = "native_catalog"
      await wait(async () => {
        const [credentials, catalog] = await Promise.all([
          host.client.credential.list(requestOptions()), host.client.model.list({ location, types: ["chat"] }, requestOptions()),
        ])
        nativeCatalog = {
          oauth: credentials.some(row => row.active && row.integrationID === model.providerID && row.value.type === "oauth"),
          modelAvailable: catalog.data.some(row => row.enabled && row.providerID === model.providerID &&
            (row.id === model.id || row.modelID === model.id)),
        }
        return nativeCatalog.oauth && nativeCatalog.modelAvailable ? true : undefined
      }, 6000, "Native OAuth model catalog unavailable")
    }
    phase = "create_session"
    const root = await host.client.session.create({ location, model, agent: owner, title: "Research investigation" }, requestOptions())
    sessionId = root.id
    if (native) {
      native.bindRoot(root.id)
      await wait(async () => native.ready(host.info.pid) ? true : undefined, 5000, "Native observer unavailable")
    }
    const listPlugin = async () => (await host.client.plugin.list({ location }, requestOptions())).data.find(p => p.id === pluginId)
    factory?.bindProject(root.projectID)
    await optional(async () => {
      const status = (await host.client.mcp.list({ location }, requestOptions())).data
      mcp = Object.fromEntries(status.map(row => [row.name, row.status.status]))
      return status.length === 2 && status.every(row => row.status.status === "connected") ? true : undefined
    }, 5000)

    async function turn(text: string, id = root.id, ms = native ? 85_000 : turnMs) {
      const input = await submitTurn(host, id, text)
      return wait(() => observeTurn(host, id, input), ms, "Host response deadline")
    }

    phase = "initial"
    started = performance.now()
    // The prompt contains no attachment or hint about procedure selection.
    initial = await turn(researchCase.prompt)
    const activePlugin = arm === "alg" ? await wait(async () => {
      const p = await listPlugin()
      if (p?.state.status === "failed") throw new Error("Installed preview failed")
      return p?.state.status === "active" ? p : undefined
    }, 5000, "Installed preview did not activate") : await listPlugin()
    plugin = activePlugin?.state.status ?? null
    if (arm === "build" && activePlugin) throw new Error("Preview present in the Build control")
    activated += skillCalls(initial, skill.id)
    phase = "checkpoint"
    const first = await turn(checkpointPrompt)
    checkpoint = decision(first)
    checkpointToolOutcomes = ["create", "set_next_measurement"].flatMap(action => receiptsFor(first.rows, action).map(row => ({
      action, ok: row.value.ok === true, error: typeof row.value.error === "string" && /^[A-Z_]+$/.test(row.value.error) ? row.value.error : null,
    })))
    w.before = (await transcript(host.client, root.id)).map(row => row.id)
    phase = "background_pressure"
    const context = options.context ?? contextWindow
    const repeats = native ? Math.min(1024, Math.floor(context / 24)) : 80
    const padding = Array.from({ length: repeats }, (_, i) =>
      `Packet ${i + 1}: reference instrument readback held in the archival queue; channel ${(i + options.seed) % 97} timing and supply voltage remain nominal.`).join("\n")
    const pressure = await submitTurn(host, root.id, pressurePrompt + "\n\n" + padding)
    w.summary = await optional(async () => transport.held(), native ? 45_000 : 7000)
    if (w.summary) {
      // A second ordinary root response, while summary delivery is held, is the positive foreground exclusion.
      const beforeCheck = await optional(() => observeTurn(host, root.id, pressure), native ? 7000 : 4000)
      if (beforeCheck) {
        const probe = await submitTurn(host, root.id, pressurePrompt)
        const observed = await optional(() => observeTurn(host, root.id, probe), native ? 12000 : 3500)
        if (observed) {
          w.concurrentAnswerId = observed.id
          w.concurrentAnswerAtMs = performance.now()
        }
      }
      w.whileHeld = transport.requests.slice().reverse().find(request => request.kind === "ordinary" &&
        request.role === "root" && request.status === 200 && request.startedAtMs > w.summary!.startedAtMs)
    }

    phase = "checker"
    const child = await host.client.session.create({ location, model, agent: checkerName, parentID: root.id,
      title: "Independent evidence check" }, requestOptions())
    if (child.parentID !== root.id || child.projectID !== root.projectID || child.id === root.id ||
        child.agent !== checkerName || child.model?.id !== model.id || child.model.providerID !== model.providerID)
      throw new Error("Unexpected checker identity")
    checkerId = child.id
    native?.bindChecker(child.id)
    independent = await turn(researchCase.checkerPrompt, child.id)
    activated += skillCalls(independent, skill.id)

    phase = "correction"
    const cited = independent.text.includes(researchObservation.correctionEvidenceRef)
    if (cited) {
      const handoff = checkpointPrompt + "\n\n" + correctionDescription + "\n" + independent.text
      const input = await submitTurn(host, root.id, handoff)
      correctionMessageId = input
      const delivered = await optional(async () => (await transcript(host.client, root.id))
        .find(row => row.type === "user" && row.id === input && row.text === handoff), 5000)
      if (delivered) w.correctedAtMs = performance.now()
      const saved = await optional(() => observeTurn(host, root.id, input), native ? 15000 : 5000)
      if (saved) {
        postCorrectionTurns.push(saved)
        correctedDecision = decision(saved)
        if (correctedDecision) decisionSavedAtMs = performance.now()
      }
    }
    transport.releaseSummary()
    phase = "apply_compaction"
    if (w.summary) postCorrectionTurns.push(await turn(applyPrompt))
    phase = "revision"
    final = await turn(researchCase.revisionPrompt)
    w.next = transport.requests.find(request => request.role === "root" && request.phase === "revision" && request.kind === "ordinary")
    w.answerId = final.id
    postCorrectionTurns.push(final)
    activated += skillCalls(final, skill.id)
    if (factory) {
      try { readback = observeAlgDecision(factory, project.directory, root.projectID, root.id) }
      catch { readback = null }
    }
    const finalRows = await transcript(host.client, root.id)
    w.applied = finalRows.find((row): row is NonNullable<CompactionWitness["applied"]> =>
      row.type === "compaction" && row.status === "completed" && row.reason === "auto" &&
      !w.before.includes(row.id) && row.summary.includes(researchObservation.staleEvidenceRef) &&
      !row.summary.includes(researchObservation.correctionEvidenceRef) &&
      summaryHash(row.summary) === w.summary?.summaryResponseSha256)
    if (w.applied) w.appliedAtMs = performance.now()
    elapsedMs = performance.now() - started
    compactionRows = finalRows.flatMap(row => row.type === "compaction" ? [{
      id: row.id, reason: row.reason, status: row.status,
      hasStale: "summary" in row && row.summary.includes(researchObservation.staleEvidenceRef),
      hasCorrection: "summary" in row && row.summary.includes(researchObservation.correctionEvidenceRef),
      sha256: "summary" in row ? summaryHash(row.summary) : null,
    }] : [])
    verdictReady = true
  } catch (error) {
    failure = phase + (error instanceof Error && /^(Expected isolated|OpenCode |Unexpected checker|Installed preview|Host (turn|response)|Preview present)/.test(error.message) ? ": " + error.message : "")
  } finally {
    transport.releaseSummary()
    if (elapsedMs === null && started !== undefined) elapsedMs = performance.now() - started
    const currentHost = hosts.at(-1)
    if (sessionId && currentHost && !currentHost.process.exited())
      hostEvidence = await collectSessionEvidence(currentHost.client, sessionId, checkerId)
    tokens = hostEvidence?.completeRecordedTokens ?? native?.usage() ?? null
    if (native) failure ??= native.failure() ?? undefined
    for (const host of hosts.reverse()) {
      try { if (!host.process.exited()) await host.process.kill() } catch { failure ??= "host_cleanup" }
    }
    transport.stop()
    evidence.stop()
    await factory?.stop()
  }

  const result = assessCompaction(w)
  const wrongRoot = w.correctedAtMs !== undefined && final ? new Set(postCorrectionTurns.filter(turn => isWrongRootReturn(turn.text, variant)).map(turn => turn.id)).size : null
  const delivered = transport.requests.filter(request => request.role === "root" && request.kind === "ordinary" && request.skill)
  const observation: RunObservation = {
    variant, initialAnswer: initial?.text ?? null, checkerAnswer: independent?.text ?? null, finalAnswer: final?.text ?? null,
    skillActions: verdictReady ? activated : null,
    wrongRootReturns: wrongRoot, tokens, elapsedMs, workbench: workbench.snapshot(),
  }
  return {
    observation, hostEvidence, tokenSource: hostEvidence?.completeRecordedTokens != null ? "host_messages" :
      tokens !== null ? "provider_events" : null,
    failure: failure ?? null, model, hostPid: hostPid ?? null, sessionId: sessionId ?? null, checkerId: checkerId ?? null,
    plugin, mcp, nativeCatalog, skill: skill ? { sha256: skill.sha256, sourceSha256: skill.sourceSha256,
      successfulNativeSkillCalls: activated, rootProviderRequestsWithSkill: delivered.map(request => request.id) } : null,
    correctionMessageId, initialAnswerId: initial?.id ?? null, checkerAnswerId: independent?.id ?? null,
    finalAnswerId: final?.id ?? null, nativeObserverFailure: native?.failure() ?? null,
    observedNativeUsage: native ? { requestsWithUsage: native.requests.filter(row => row.usage != null).length,
      tokensFromReportedRequests: native.requests.reduce((sum, row) => sum + (row.usage?.total ?? 0), 0), complete: native.usage() !== null } : null,
    compaction: { ...result, holdBoundary: native ? "native-host-http-hook-before-dispatch" : "loopback-response",
      rows: compactionRows }, requests: transport.requests,
    decision: { checkpointToolOutcomes, initial: checkpoint, corrected: correctedDecision, readback, decisionSavedAtMs,
      savedWhileHeld: decisionSavedAtMs !== null && w.summary?.finishedAtMs != null && decisionSavedAtMs < w.summary.finishedAtMs,
      governedFactoryRequests: factory?.audit.length ?? 0 },
  }
}

function decision(turn: Turn) {
  const last = receiptsFor(turn.rows, "set_next_measurement").at(-1)
  const info = asObject(last?.value.decision)
  return last?.value.ok === true && typeof last.value.decision_revision === "number" && typeof info?.next_action === "string"
    ? { toolId: last.id, revision: last.value.decision_revision, actionSha: sha256(info.next_action),
      runtimeSha256: last.value.runtimeSha256 } : null
}


function skillCalls(turn: Turn, skillId: string) {
  return toolCalls(turn.rows).filter(call => call.name === "skill" && call.state.status === "completed" &&
    asObject(call.state.input)?.id === skillId && call.state.content.some(part => part.type === "text" &&
      part.text.includes("<skill_content"))).length
}

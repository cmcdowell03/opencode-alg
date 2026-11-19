import { chmod, mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { algTool, fixtureProject, hostVersion, owner, receiptsFor, requestOptions, startHost, toolCalls, transcript } from "../acceptance/host.ts"
import { runtimeIdentity, sha256, waitFor } from "../acceptance/runtime.ts"
import { startFactory } from "../acceptance/service.ts"
import { armNames, checkerName, contextWindow, hasScopedEvidenceTools, installAlg, observeAlgDecision, observeTurn, pluginId, prepareHost,
  registerSkill, submitTurn, type ArmName, type Host, type Turn } from "./host.ts"
import { briefKey, checkerInput, classifyHandoff, correctionHeader, finalInput, handoffId, initialInput, scoreHandoff,
  object, refutationId, skillContent, skillName, variants, verifiedCorrection, type HandoffVariant } from "./handoff-case.ts"
import { scriptedHandoff } from "./handoff-script.ts"
import { createLongHandoff, longHandoffPhase, scriptedLongHandoff } from "./long-handoff.ts"
import { scoreRetention } from "./retention.ts"
import { handoffJob, stageGate } from "./handoff-gate.ts"
import { nativeLimits, nativeModel, nativeProviderConfig, stageNativeCredential } from "./native-provider.ts"
import { startNativeObserver } from "./native-observer.ts"
import { summaryHash } from "./compaction.ts"
import { collectSessionEvidence } from "./session-evidence.ts"
import { includes, maxProviderBytes, maxProviderCalls, startTransport, textOf, type Message } from "./transport.ts"
import { createWorkbench, startWorkbench, type WorkbenchSnapshot } from "./workbench.ts"

type Options = {
  binary: string; bundle: string; variant: HandoffVariant; reverse?: boolean
  extended?: boolean
  native?: { model: string; authPath?: string }
}
const scratchPrefix = "alg-v2-handoff-"
const queryBudget = 4
const fixtureModel = { providerID: "paired-benchmark", id: "fixture" }

async function runArm(arm: ArmName, options: Options, scratch: string) {
  const model = options.native ? nativeModel(options.native.model) : fixtureModel
  const workbench = createWorkbench({ maxAcceptedQueries: queryBudget })
  const evidence = startWorkbench(workbench)
  const factory = arm === "alg" ? startFactory(join(scratch, "factory"), false) : undefined
  const audit = () => factory?.audit.map(row => ({ ...row })) ?? null
  const workload = options.extended ? createLongHandoff() : null
  const hosts: Host[] = []
  let host: Host | undefined
  let skill: Awaited<ReturnType<typeof registerSkill>> | undefined
  type Compaction = Extract<Awaited<ReturnType<typeof transcript>>[number], { type: "compaction"; status: "completed" }>
  let compacted: Compaction | undefined
  let compactRequested = false
  let continuing = false, boundary = 0
  const modelWitness: { boundary: number; stage: "summary" | "continue"; observedAtMs: number; summarySha256: string | null; correction: boolean;
    initial: boolean; factualRefutation: boolean; pendingMeasurement: boolean; currentSkill: boolean }[] = []
  function classify(messages: Message[]) {
    const desk = workload && longHandoffPhase(messages)
    const classified = desk ? { role: "root" as const, phase: desk } : classifyHandoff(messages)
    if (compactRequested || continuing) {
      const contents = messages.map(message => textOf(message.content))
      const facts = messages.filter(message => message.role === "user").map(message => textOf(message.content))
        .find(text => text.includes("ALG investigation facts (untrusted recorded data)")) ?? ""
      modelWitness.push({ boundary, stage: compactRequested ? "summary" : "continue", observedAtMs: performance.now(),
        summarySha256: compacted && contents.some(text => includes(text, compacted!.summary)) ? summaryHash(compacted.summary) : null,
        correction: contents.some(text => text.includes(correctionHeader)),
        initial: contents.some(text => text.includes(initialInput)),
        factualRefutation: facts.includes("refuted_hypothesis_statement"),
        pendingMeasurement: facts.includes('pending_measurement') && facts.includes("replay-clock-join"),
        currentSkill: messages.some(message => message.role === "system" && includes(textOf(message.content), skill?.witness)),
      })
    }
    return classified
  }
  const observerOptions = { id: model.id, classify, correction: correctionHeader,
    stale: "attribute-as-recorded", skill: () => skill?.witness }
  const native = options.native && startNativeObserver(observerOptions)
  const scripted = native ? undefined : startTransport({ ...observerOptions, seed: 101,
    decide: input => (workload && scriptedLongHandoff(input)) || scriptedHandoff(input) })
  const observer = native || scripted!
  observer.releaseSummary()
  let phase = "prepare", failure: string | null = null
  let rootId: string | undefined, checkerId: string | undefined
  let factoryScope: { directory: string; projectId: string; rootId: string } | undefined
  let durableBefore: ReturnType<typeof observeAlgDecision> = null
  let durableAfter: ReturnType<typeof observeAlgDecision> = null
  const durableDecision = () => factory && factoryScope ?
    observeAlgDecision(factory, factoryScope.directory, factoryScope.projectId, factoryScope.rootId) : null
  let initial: Turn | undefined, checker: Turn | undefined, final: Turn | undefined, corrected: Turn | undefined
  let correction: string | null = null, finalMessageId: string | undefined, finalObservedAtMs: number | null = null
  let beforeContinue: ReturnType<typeof workbench.snapshot> | null = null
  let afterInitial: WorkbenchSnapshot | null = null
  let initialAudit: ReturnType<typeof audit> = null
  let initialAuthority: boolean | null = null
  let afterCorrection: WorkbenchSnapshot | null = null
  let correctionAudit: ReturnType<typeof audit> = null
  let correctionAuthority: boolean | null = null
  let gatePolicy: Awaited<ReturnType<typeof stageGate>> | null = null
  let briefBefore: unknown = null, briefAfter: unknown = null
  let briefReadError: string | null = null
  const readBrief = async () => {
    const entries = await host!.client.experimental.session.instructions.entry.list({ sessionID: rootId! }, requestOptions())
    return entries.find(entry => entry.key === briefKey)?.value ?? null
  }
  type Checkpoint = {
    index: number
    before: Turn | undefined
    beforeLedger: ReturnType<typeof workbench.snapshot>
    beforeBrief: unknown
    beforeAuthority: boolean | null
    continuationLedger?: ReturnType<typeof workbench.snapshot>
    continuationAudit?: ReturnType<typeof audit>
    afterAudit?: ReturnType<typeof audit>
    afterAuthority?: boolean
    requestOffset: number
    compacted?: Compaction
    afterUserId?: string
    after?: Turn
    afterBrief?: unknown
    afterLedger?: ReturnType<typeof workbench.snapshot>
    observedAtMs?: number
    requestEnd?: number
  }
  const checkpoints: Checkpoint[] = []
  let plugin: string | null = null, skillAvailableAtContinue: boolean | null = null
  let factoryEvidence: Awaited<ReturnType<ReturnType<typeof startFactory>["evidence"]>> | null = null
  let sessionEvidence: Awaited<ReturnType<typeof collectSessionEvidence>> | null = null
  let raw: { root: Awaited<ReturnType<typeof transcript>> | null; checker: Awaited<ReturnType<typeof transcript>> | null } =
    { root: null, checker: null }
  const started = performance.now()
  try {
    const fixture = await fixtureProject(scratch, "project")
    const project = await prepareHost(scratch, { model, providerUrl: scripted?.url,
      providers: native ? nativeProviderConfig(contextWindow, model.id) : undefined,
      evidenceUrl: evidence.endpoint, checkerUrl: evidence.checkerEndpoint,
      skill: { name: skillName, content: skillContent }, bundle: factory ? options.bundle : undefined })
    const git = Bun.which("git")
    if (!git) throw new Error("Git is required for the local handoff fixture")
    const env: NodeJS.ProcessEnv = project.settings.env
    env.PATH = dirname(git) + delimiter + env.PATH
    project.config.compaction.auto = false
    await writeFile(project.configPath, JSON.stringify(project.config))
    const location = { directory: project.directory }
    if (native) {
      phase = "credential"
      await stageNativeCredential(project.settings.env, options.native?.authPath)
    }
    phase = "discover"
    host = await startHost(options.binary, project.directory, project.settings)
    hosts.push(host)
    skill = await registerSkill(host, project, skillName)
    if (factory || native) {
      await host.process.kill()
      if (native) project.config.plugins.unshift(await native.stage(join(scratch, "observer")))
      if (factory) {
        await installAlg(project, options.bundle, skill, factory)
        const { id, sha256, sourceSha256 } = skill
        gatePolicy = await stageGate(git, project.directory, fixture.id, { id, path: project.skillRelative, sha256, sourceSha256 })
        const installed = project.config.plugins.at(-1) as { options: object }
        Object.assign(installed.options, { approvedJob: handoffJob, preQueryPolicy: gatePolicy })
      }
      await writeFile(project.configPath, JSON.stringify(project.config))
      host = await startHost(options.binary, project.directory, project.settings)
      hosts.push(host)
    }
    if (native) {
      phase = "catalog"
      await waitFor(async () => {
        const [credentials, catalog] = await Promise.all([
          host!.client.credential.list(requestOptions()), host!.client.model.list({ location, types: ["chat"] }, requestOptions()),
        ])
        if (credentials.some(row => row.active && row.integrationID === model.providerID && row.value.type === "oauth") &&
          catalog.data.some(row => row.enabled && row.providerID === model.providerID && (row.id === model.id || row.modelID === model.id)))
          return true
      }, 6000, "Native OAuth model catalog unavailable")
    }

    phase = "sessions"
    const root = await host.client.session.create({ location, model, agent: owner, title: "Fab clock handoff" }, requestOptions())
    rootId = root.id
    if (root.projectID !== fixture.id || root.agent !== owner ||
        root.model?.providerID !== model.providerID || root.model.id !== model.id)
      throw new Error("Root session identity mismatch")
    if (factory) {
      factory.bindProject(root.projectID)
      factoryScope = { directory: project.directory, projectId: root.projectID, rootId: root.id }
    }
    if (native) {
      native.bindRoot(root.id)
      await waitFor(async () => native.ready(host!.info.pid) ? true : undefined, 5000, "Native observer unavailable")
    }
    const child = await host.client.session.create({ location, model, agent: checkerName, parentID: root.id,
      title: "Independent clock audit" }, requestOptions())
    if (child.id === root.id || child.parentID !== root.id || child.projectID !== root.projectID ||
        child.agent !== checkerName || child.model?.id !== model.id || child.model.providerID !== model.providerID)
      throw new Error("Independent checker identity mismatch")
    checkerId = child.id
    if (native) native.bindChecker(child.id)
    await waitFor(async () => {
      const status = (await host!.client.mcp.list({ location }, requestOptions())).data
      if (status.length === 2 && status.every(row => row.status.status === "connected")) return true
    }, 5000, "Paired evidence workbench unavailable")

    async function turn(input: string, session = root.id) {
      const id = await submitTurn(host!, session, input)
      if (input === finalInput) finalMessageId = id
      return waitFor(() => observeTurn(host!, session, id), native ? 85_000 : 30_000, "Host response deadline")
    }
    phase = "initial"
    initial = await turn(initialInput)
    afterInitial = workbench.snapshot()
    initialAudit = audit()
    async function procedureAvailable() {
      const catalog = await host!.client.skill.list({ location }, requestOptions())
      return catalog.data.some(entry => entry.id === skill!.id && sha256(entry.content) === skill!.sha256)
    }
    initialAuthority = await procedureAvailable()
    const loaded = async () => (await host!.client.plugin.list({ location }, requestOptions())).data.find(row => row.id === pluginId)
    plugin = arm === "alg" ? await waitFor(async () => {
      const entry = await loaded()
      if (entry?.state.status === "failed") throw new Error("Installed preview failed")
      return entry?.state.status === "active" ? entry.state.status : undefined
    }, 5000, "Installed preview unavailable") : (await loaded())?.state.status ?? null
    if (arm === "build" && plugin) throw new Error("ALG plugin present in Build")

    phase = "independent_correction"
    checker = await turn(checkerInput, child.id)
    correction = verifiedCorrection(checker.text)
    // A wrong checker answer is a scored result. Do not provide oracle evidence in its place.
    if (correction) {
      corrected = await turn(correction)
      afterCorrection = workbench.snapshot()
      correctionAudit = audit()
      correctionAuthority = await procedureAvailable()
    }
    briefBefore = await readBrief()
    durableBefore = durableDecision()
    async function compactAndContinue(before: Turn | undefined) {
      boundary = checkpoints.length + 1
      const cp: Checkpoint = { index: boundary, before, beforeBrief: await readBrief(),
        beforeAuthority: await procedureAvailable(),
        beforeLedger: workbench.snapshot(), requestOffset: observer.requests.length }
      checkpoints.push(cp)
      phase = "compact"
      const prior = new Set((await transcript(host!.client, root.id)).map(row => row.id))
      compactRequested = true
      try {
        await host!.client.session.compact({ sessionID: root.id, delivery: "queue" }, requestOptions())
        cp.compacted = await waitFor(async () => {
          const rows = await transcript(host!.client, root.id)
          const observed = rows.find(row => row.type === "compaction" && row.reason === "manual" && !prior.has(row.id))
          if (observed?.type === "compaction" && observed.status === "failed") throw new Error("Manual compaction failed")
          if (observed?.type === "compaction" && observed.status === "completed" && rows.at(-1)?.type === "idle") return observed
        }, native ? 65_000 : 20_000, "No completed manual compaction in host transcript")
        compacted = cp.compacted
      } finally { compactRequested = false }
      const withdraw = options.variant === "revoked" && boundary === (workload ? 3 : 1)
      if (withdraw) {
        phase = "revoke_skill"
        await rename(project.skillFile, join(scratch, "withdrawn-procedure.md"))
        if (factory) await rename(join(project.directory, ".opencode", "research-procedure.json"), join(scratch, "withdrawn-approval.json"))
      }
      phase = "verify_current_skill"
      skillAvailableAtContinue = await waitFor(async () => {
        const present = await procedureAvailable()
        return present === !withdraw ? present : undefined
      }, 8000, "Native skill catalog did not reflect current availability")
      cp.afterAuthority = skillAvailableAtContinue
      phase = "continue"
      cp.continuationLedger = beforeContinue = workbench.snapshot()
      cp.continuationAudit = audit()
      continuing = true
      finalMessageId = undefined
      try {
        final = await turn(finalInput)
        cp.after = final
        cp.observedAtMs = finalObservedAtMs = performance.now()
        cp.afterBrief = await readBrief()
        return final
      } finally {
        continuing = false
        cp.afterUserId = finalMessageId ?? undefined
        cp.afterLedger = workbench.snapshot()
        cp.afterAudit = audit()
        cp.requestEnd = observer.requests.length
      }
    }
    if (workload) {
      await workload.run({ turn, async compact() {
        // Re-observe the investigation decision after the intervening task to
        // distinguish loss during that task from loss across compaction.
        const priorDecision = await turn(finalInput)
        await compactAndContinue(priorDecision)
        return compacted!
      } })
    } else await compactAndContinue(corrected ?? initial)
    phase = "complete"
  } catch (error) {
    failure = native && native.failure() || (error instanceof Error ? error.message : "Handoff failed")
  } finally {
    if (host && rootId) {
      const client = host.client
      briefAfter = await readBrief().catch(error => {
        briefReadError = error instanceof Error ? error.message : "Host brief read failed"
        return null
      })
      sessionEvidence = await collectSessionEvidence(client, rootId, checkerId)
      const [rootRows, checkerRows] = await Promise.all([
        transcript(client, rootId).catch(() => null),
        checkerId ? transcript(client, checkerId).catch(() => null) : null,
      ])
      raw = { root: rootRows, checker: checkerRows }
    }
    await Promise.allSettled(hosts.filter(item => !item.process.exited()).map(item => item.process.kill()))
    if (factory && factoryScope) {
      try { durableAfter = durableDecision() }
      catch (error) { failure ??= error instanceof Error ? error.message : "Durable decision read failed" }
      factoryEvidence = await factory.evidence().catch(error => {
        failure ??= error instanceof Error ? error.message : "Factory evidence read failed"
        return null
      })
    }
    await factory?.stop()
    evidence.stop()
    observer.stop()
  }

  const ledger = workbench.snapshot()
  const standalone = scoreHandoff({ initial: initial?.text ?? null, final: final?.text ?? null,
    variant: options.variant, ledger, beforeContinue })
  const finalUser = raw.root?.find(row => row.id === finalMessageId && row.type === "user")
  const actualFinalInput = finalUser?.type === "user" ? finalUser.text : null
  const finalRequests = modelWitness.filter(row => row.stage === "continue")
  function measurementReceipts(turn: Turn | undefined) {
    return ["admit", "dispatch", "reconcile", "set_next_measurement"].flatMap(action => receiptsFor(turn?.rows ?? [], action))
  }
  const boundaries = checkpoints.map(cp => {
    const indexOf = (id?: string) => raw.root?.findIndex(row => row.id === id) ?? -1
    const pre = indexOf(cp.before?.id), summary = indexOf(cp.compacted?.id)
    const user = indexOf(cp.afterUserId), answer = indexOf(cp.after?.id)
    const witness = modelWitness.filter(row => row.boundary === cp.index)
    const delivered = witness.filter(row => row.stage === "continue")
    const requests = observer.requests.slice(cp.requestOffset, cp.requestEnd).filter(row => row.kind === "summary")
    const digest = cp.compacted?.summary ? summaryHash(cp.compacted.summary) : null
    const neutral = raw.root?.[user]
    const checks = {
      newCompletedBeforeNeutral: pre >= 0 && pre < summary && summary < user && user < answer &&
        neutral?.type === "user" && neutral.text === finalInput && !!digest,
      providerSummaryResponse: !!digest && requests.length === 1 && requests[0]?.role === "root" &&
        requests[0].status === 200 && requests[0].summaryResponseSha256 === digest &&
        witness.some(row => row.stage === "summary" && (cp.index > 1 || (row.initial && (!correction || row.correction)))),
      summaryExposedBeforeAnswer: !!digest && !!cp.after && delivered.length > 0 &&
        delivered.every(row => row.summarySha256 === digest && row.observedAtMs < (cp.observedAtMs ?? 0)),
    }
    const retention = scoreRetention({
      initial: initial?.text ?? null, corrected: corrected?.text ?? null,
      correction: corrected ? correction : null, final: cp.after?.text ?? null,
      variant: cp.afterAuthority === false ? "revoked" : "active",
      authority: { initial: initialAuthority, corrected: correctionAuthority, final: cp.afterAuthority ?? null },
      preCompaction: { answer: cp.before?.text ?? null, snapshot: cp.beforeLedger, authority: cp.beforeAuthority },
      compactionObserved: pre >= 0 && pre < summary && summary < user && neutral?.type === "user" &&
        neutral.text === finalInput && checks.providerSummaryResponse && delivered.some(row => row.summarySha256 === digest),
      snapshots: { afterInitial, afterCorrection, beforeContinue: cp.continuationLedger ?? null,
        afterContinue: cp.afterLedger ?? null },
      tools: { initial: measurementReceipts(initial), corrected: measurementReceipts(corrected), final: measurementReceipts(cp.after) },
      factory: factory ? { evidence: factoryEvidence, afterInitial: initialAudit, afterCorrection: correctionAudit,
        beforeContinue: cp.continuationAudit ?? null, afterContinue: cp.afterAudit ?? null } : undefined,
      durableBrief: { before: cp.beforeBrief, after: cp.afterBrief },
      exposure: { summary: checks.summaryExposedBeforeAnswer, currentSkill: delivered.some(row => row.currentSkill),
        factualRefutation: delivered.some(row => row.factualRefutation), pendingMeasurement: delivered.some(row => row.pendingMeasurement) },
    })
    const hostStep = sessionEvidence?.sessions.root?.steps.find(row => row.id === cp.compacted?.id)
    return { index: cp.index, id: cp.compacted?.id ?? null, summarySha256: digest, retention,
      summaryTokens: hostStep?.tokens ?? null,
      summaryBytes: cp.compacted ? Buffer.byteLength(cp.compacted.summary) : null,
      beforeAnswerId: cp.before?.id ?? null, afterAnswerId: cp.after?.id ?? null, checks }
  })
  const last = boundaries.at(-1)
  const compaction = { id: last?.id ?? null, reason: compacted?.reason ?? null,
    summarySha256: last?.summarySha256 ?? null, summaryBytes: last?.summaryBytes ?? null,
    hostStep: sessionEvidence?.sessions.root?.steps.find(row => row.id === last?.id) ?? null,
    requests: observer.requests.filter(row => row.kind === "summary"), modelWitness,
    correctedAnswerId: corrected?.id ?? null, finalObservedAtMs, boundaries,
    checks: {
      expectedCount: boundaries.length === (options.extended ? 3 : 1),
      allWitnessed: boundaries.length > 0 && boundaries.every(row => Object.values(row.checks).every(Boolean)),
    } }
  const rootTools = observer.requests.filter(row => row.role === "root" && row.kind === "ordinary")
  const checkerTools = observer.requests.filter(row => row.role === "checker" && row.kind === "ordinary")
  const calls = toolCalls(raw.root ?? [])
  const decisions = { initial: receiptsFor(initial?.rows ?? [], "set_next_measurement"),
    corrected: receiptsFor(corrected?.rows ?? [], "set_next_measurement"),
    final: receiptsFor(final?.rows ?? [], "set_next_measurement"), calls: calls.filter(call => call.name === algTool) }
  const gate = {
    policy: gatePolicy,
    admit: receiptsFor(initial?.rows ?? [], "admit"),
    dispatch: receiptsFor(initial?.rows ?? [], "dispatch"),
    reuse: receiptsFor(initial?.rows ?? [], "reconcile"),
    continuationAdmit: receiptsFor(final?.rows ?? [], "admit"),
  }
  const submitted = factory?.audit.filter(row => row.name === "submit") ?? []
  const preQuery = (value: unknown) => object(object(value)?.preQuery)
  const satisfied = (value: unknown) => object(preQuery(value)?.prerequisite)?.status === "satisfied" &&
    object(preQuery(value)?.skill)?.availability === "verified" && object(preQuery(value)?.skill)?.activation === "observed"
  // A rejected request is retained in the receipt. The admitted service job
  // and its manifest are counted independently of argument-validation retries.
  const dispatch = gate.dispatch.filter(receipt => receipt.value.ok === true)
  const manifest = object(dispatch[0]?.value.work)?.manifest_digest
  const reuse = object(preQuery(gate.reuse[0]?.value)?.reuse)
  const gateChecks = arm === "alg" ? {
    pinnedPrerequisite: gate.admit.length === 1 && gate.admit[0]?.value.ok === true && satisfied(gate.admit[0].value) &&
      object(object(preQuery(gate.admit[0].value)?.prerequisite)?.evidence)?.sha256 === gatePolicy?.prerequisite.sha256,
    dispatchOnce: factoryEvidence?.ledger.acceptedComputations === 1 &&
      factoryEvidence.ledger.acceptedWorkUnits === handoffJob.reserved_cost && factoryEvidence.jobs.length === 1 &&
      factoryEvidence.jobs[0]?.job.resultDigest === manifest && dispatch.length === 1 &&
      satisfied(dispatch[0]!.value) && typeof manifest === "string" &&
      submitted.length === 1 && submitted[0]?.accepted === true && submitted[0].response === "sent",
    settledManifestReused: gate.reuse.length === 1 && gate.reuse[0]?.value.ok === true &&
      satisfied(gate.reuse[0].value) && reuse?.kind === "settled_manifest" && reuse.manifest_digest === manifest &&
      reuse.work_key === object(dispatch[0]?.value.work)?.work_key,
    currentProcedureGate: options.variant === "active" || (gate.continuationAdmit.length === 1 &&
      gate.continuationAdmit[0]?.value.ok === false && gate.continuationAdmit[0].value.error === "RESEARCH_PROCEDURE_UNVERIFIED" &&
      object(preQuery(gate.continuationAdmit[0].value)?.skill)?.availability === "unverified" &&
      object(preQuery(gate.continuationAdmit[0].value)?.prerequisite)?.status === "unchecked" && submitted.length === 1),
    correctedCheckpoint: decisions.initial.length === 1 && decisions.corrected.length === 1 &&
      decisions.initial[0]?.value.ok === true && decisions.corrected[0]?.value.ok === true &&
      decisions.initial[0].value.decision_revision === 1 && decisions.corrected[0].value.decision_revision === 2 &&
      object(decisions.initial[0].value.decision)?.next_action === standalone.observed.initial?.nextAction &&
      object(decisions.corrected[0].value.decision)?.next_action === "replay-clock-join",
    durableCorrectedState: !!durableBefore && !!durableAfter && durableBefore.revision === 2 &&
      durableBefore.actionSha === sha256("replay-clock-join") && durableBefore.procedureSha === skill?.sha256 &&
      durableBefore.governedManifestObserved && JSON.stringify(durableAfter) === JSON.stringify(durableBefore),
  } : null
  const current = object(briefAfter), previous = object(briefBefore)
  const manifestFacts = (value: unknown) => {
    const refutation = object(object(value)?.refuted_hypothesis)
    return refutation?.id === refutationId && refutation.manifest_digest === manifest
  }
  const briefChecks = arm === "alg" ? {
    correctedRevision: previous?.decision_revision === 2 && current?.decision_revision === previous.decision_revision &&
      current.revision === previous.revision,
    factsRetained: manifestFacts(briefBefore) && manifestFacts(briefAfter),
    liveApproval: object(previous?.observed_approval)?.procedure_sha256 === skill?.sha256 &&
      (options.variant === "revoked" ? current?.observed_approval === null :
        object(current?.observed_approval)?.procedure_sha256 === skill?.sha256),
    modelProjection: finalRequests.length > 0 && finalRequests.every(row => row.factualRefutation &&
      row.pendingMeasurement === checkpoints[row.boundary - 1]?.afterAuthority &&
      row.currentSkill === checkpoints[row.boundary - 1]?.afterAuthority),
  } : { noAlgBrief: briefBefore === null && briefAfter === null }
  return {
    arm, phase, failure, model, plugin, rootId, checkerId, skill: skill && { id: skill.id, sha256: skill.sha256, sourceSha256: skill.sourceSha256 },
    skillAvailableAtContinue, actualFinalInput, correction, correctionObserved: !!correction &&
      !!raw.root?.some(row => row.type === "user" && row.text === correction),
    elapsedMs: performance.now() - started, sessionEvidence, requests: observer.requests, raw, ledger, beforeContinue,
    workload: workload?.snapshot({ rows: raw.root, requests: observer.requests, anchorAnswerId: corrected?.id ?? initial?.id,
      finalUserId: finalMessageId ?? undefined }) ?? null,
    decisions: { ...decisions, durableBefore, durableAfter }, gate, gateChecks, compaction, brief: { key: briefKey, before: briefBefore, after: briefAfter, readError: briefReadError, checks: briefChecks },
    factoryAudit: factory?.audit ?? [], factoryEvidence, standalone,
    tools: {
      evidence: hasScopedEvidenceTools(rootTools, checkerTools),
      nativeSkill: rootTools.some(row => row.tools.includes("skill")),
    },
  }
}

export async function runHandoff(options: Options) {
  const parent = await realpath(tmpdir())
  const scratch = await mkdtemp(join(parent, scratchPrefix))
  try {
    if (process.platform !== "win32") await chmod(scratch, 0o700)
    const runtime = await runtimeIdentity(options.binary, options.bundle, await hostVersion(options.binary, join(scratch, "version")))
    const order = options.reverse ? [...armNames].reverse() : [...armNames]
    const arms = {} as Record<ArmName, Awaited<ReturnType<typeof runArm>>>
    for (const arm of order) arms[arm] = await runArm(arm, options, join(scratch, arm))
    const { build, alg } = arms
    const parity = {
      model: build.model.providerID === alg.model.providerID && build.model.id === alg.model.id,
      skill: !!build.skill && build.skill.sha256 === alg.skill?.sha256 && build.skill.sourceSha256 === alg.skill.sourceSha256 &&
        order.every(arm => arms[arm].tools.nativeSkill && arms[arm].skillAvailableAtContinue === (options.variant === "active")),
      evidence: build.tools.evidence && alg.tools.evidence && build.ledger.maxAcceptedQueries === alg.ledger.maxAcceptedQueries,
      correction: !!build.correction && build.correction === alg.correction && build.correctionObserved && alg.correctionObserved,
      finalInput: build.actualFinalInput === finalInput && alg.actualFinalInput === finalInput,
      treatment: build.plugin === null && alg.plugin === "active",
      runtimeUnchanged: JSON.stringify(runtime) === JSON.stringify(await runtimeIdentity(options.binary, options.bundle, runtime.version)),
    }
    const apparatusPassed = order.every(arm => !arms[arm].failure && !arms[arm].brief.readError &&
      (!options.extended || arms[arm].workload?.apparatusPassed) &&
      Object.values(arms[arm].compaction.checks).every(Boolean)) &&
      Object.entries(parity).every(([key, value]) => key === "correction" || value)
    const standalonePassed = parity.correction && order.every(arm => Object.values(arms[arm].standalone.checks).every(Boolean) &&
      (!options.extended || arms[arm].workload?.workPassed))
    const installedBehaviorPassed = Object.values(build.brief.checks).every(Boolean) &&
      Object.values(alg.brief.checks).every(Boolean) && !!alg.gateChecks && Object.values(alg.gateChecks).every(Boolean)
    const qualified = apparatusPassed && standalonePassed && installedBehaviorPassed
    const checks = alg.standalone.checks
    const previewWorkflowPassed = apparatusPassed && alg.correctionObserved && installedBehaviorPassed &&
      checks.retainedFacts && checks.action && checks.prerequisite && checks.boundedSearch &&
      checks.independentAuditAdmission && checks.noDuplicateAdmissions && checks.noRequeryAtContinuation
    return { schema: 2, caseId: handoffId, variant: options.variant, workload: options.extended ? "extended" : "single",
      previewWorkflowPassed, mode: options.native ? "native-openai-oauth" : "scripted-transport",
      mechanicsOnly: !options.native, qualified, apparatusPassed, standalonePassed, installedBehaviorPassed, order, parity, runtime, prompts: { initialSha256: sha256(initialInput),
        checkerSha256: sha256(checkerInput), final: finalInput }, limits: options.native ? nativeLimits :
        { calls: maxProviderCalls, requestBytes: maxProviderBytes }, arms }
  } finally {
    const real = await realpath(scratch)
    if (dirname(real) !== parent || !basename(real).startsWith(scratchPrefix)) throw new Error("Handoff scratch cleanup refused")
    await rm(real, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}

const usage = "Usage: bun packages/v2-preview/benchmark/handoff.ts --host <OpenCode 2.3.2> --package <staged bundle> --out <new JSON> [--variant active|revoked] [--workload single|extended] [--order build-first|alg-first] [--native-model openai/<id> --allow-model-calls [--auth-file <path>]]"

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage)
  } else {
    const flags = new Map<string, string>()
    const allowed = new Set(["--host", "--package", "--out", "--variant", "--workload", "--order", "--native-model", "--auth-file", "--allow-model-calls"])
    for (let i = 0; i < args.length; i++) {
      const key = args[i]!
      const value = key === "--allow-model-calls" ? "true" : args[++i]
      if (!allowed.has(key) || flags.has(key) || !value || value.startsWith("--")) throw new Error(usage)
      flags.set(key, value)
    }
    const host = flags.get("--host"), bundle = flags.get("--package"), out = flags.get("--out")
    const order = flags.get("--order") ?? "build-first", variant = flags.get("--variant") ?? "active"
    const workload = flags.get("--workload") ?? "single"
    const model = flags.get("--native-model"), authFile = flags.get("--auth-file"), allowModels = flags.has("--allow-model-calls")
    if (!host || !bundle || !out || !variants.includes(variant as HandoffVariant) || !["single", "extended"].includes(workload) ||
        (order !== "build-first" && order !== "alg-first") || !!model !== allowModels || (authFile && !model)) throw new Error(usage)
    if (model) nativeModel(model)
    const file = await open(resolve(out), "wx")
    try {
      const result = await runHandoff({ binary: await realpath(host), bundle: await realpath(bundle), reverse: order === "alg-first",
        variant: variant as HandoffVariant, extended: workload === "extended",
        native: model ? { model, authPath: authFile ? resolve(authFile) : undefined } : undefined })
      await file.writeFile(JSON.stringify(result, null, 2) + "\n")
      await file.sync()
      console.log(JSON.stringify({ qualified: result.qualified, apparatusPassed: result.apparatusPassed, standalonePassed: result.standalonePassed,
        installedBehaviorPassed: result.installedBehaviorPassed, mode: result.mode, parity: result.parity,
        build: result.arms.build.failure, alg: result.arms.alg.failure }))
      process.exitCode = result.qualified ? 0 : 1
    } finally { await file.close() }
  }
}

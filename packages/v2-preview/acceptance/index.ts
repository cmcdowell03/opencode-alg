import { randomUUID } from "node:crypto"
import { mkdtemp, open, realpath, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterPrompt, algTool, asObject, checker, checkerRules, fixtureProject, hostSettings, hostVersion,
  model, owner, parseObject, receiptFor, receiptsFor, requestOptions, startHost, toolCalls, transcript } from "./host.ts"
import { startProvider } from "./provider.ts"
import { runtimeIdentity, sha256, waitFor } from "./runtime.ts"
import { containsStaleSummary, recoveryText, scenario } from "./scenario.ts"
import { startFactory } from "./service.ts"
import { prepareTeamReference } from "./team-fixture.ts"

type Host = Awaited<ReturnType<typeof startHost>>
type Grade = "PASS" | "FAIL" | "NOT_OBSERVED"
type Claim = { grade: Grade; observed?: unknown }
type Arm = { claims: Record<string, Claim>; failure?: string; providerCalls?: number; providerErrors?: string[] }
const pluginId = "opencode-alg-v2-preview"
const nativeClaims = ["host_boot", "plugin_absence", "primary_transport", "forced_compaction"]
const previewClaims = [
  "host_boot", "active_runtime", "accepted_ack_withheld_at_kill", "restart_same_session", "single_remote_admission",
  "forced_compaction_stale_checkpoint", "fresh_checker", "checker_bounded_cited_read",
  "revocation_denied_read", "cross_project_denied_read", "current_next_measurement", "end_user_measurement_handoff",
  "team_source_pinned_commit", "two_advisory_researchers", "background_compaction_race",
]
const makeArm = (names: string[]): Arm => ({ claims: Object.fromEntries(names.map(name => [name, { grade: "NOT_OBSERVED" }])) })
function mark(arm: Arm, name: string, passed: boolean, observed: unknown) {
  arm.claims[name] = { grade: passed ? "PASS" : "FAIL", observed }
}
function requireValue<T>(value: T | undefined | null | false, failure: string): T {
  if (value === undefined || value === null || value === false) throw new Error(failure)
  return value
}
const boundedError = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0, 240)
const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)))

async function runArm(binary: string, scratch: string, arm: Arm, runtime?: Awaited<ReturnType<typeof runtimeIdentity>>, bundle?: string) {
  const controller = scenario()
  const provider = startProvider(controller.decide)
  const factory = bundle ? startFactory(join(scratch, "service")) : undefined
  const children: Host[] = []
  let releaseChecker: (() => void) | undefined
  let stage = "isolation"
  try {
    const project = await fixtureProject(scratch, "primary")
    const foreign = bundle ? await fixtureProject(scratch, "foreign") : undefined
    const settings = await hostSettings(join(scratch, "host"), provider.url, bundle, factory?.adapter)
    const team = bundle ? await prepareTeamReference(scratch, project.directory, settings.env.OPENCODE_CONFIG) : undefined
    const launch = async () => {
      const host = await startHost(binary, project.directory, settings)
      children.push(host)
      return host
    }
    stage = "host_boot"
    let host = await launch()
    mark(arm, stage, true, { pid: host.info.pid, version: host.info.version })
    const session = await host.client.session.create({ location: { directory: project.directory }, agent: owner, model }, requestOptions())
    const id = session.id
    if (session.projectID !== project.id) throw new Error("OpenCode did not verify isolated fixture project identity")
    const plugin = async () => (await host.client.plugin.list({ location: { directory: project.directory } }, requestOptions()))
      .data.find(entry => entry.id === pluginId)

    async function prompt(client: Host["client"], sessionID: string, phase: ReturnType<typeof controller.instruction>) {
      await client.session.prompt({ sessionID, text: phase.text, delivery: "queue" }, requestOptions())
    }
    async function turn(action: string, args: Record<string, unknown> = {}, options: {
      sessionID?: string; client?: Host["client"]; observe?: Parameters<typeof controller.instruction>[1]
    } = {}) {
      const client = options.client ?? host.client, sessionID = options.sessionID ?? id
      const phase = controller.instruction({ action, ...args }, options.observe)
      await prompt(client, sessionID, phase)
      const receipt = requireValue(receiptFor(await afterPrompt(client, sessionID, phase.id), action), `Missing host tool receipt for ${action}`)
      if (receipt.value.runtimeSha256 !== runtime?.bundleSha256) throw new Error(`Runtime digest mismatch for ${action}`)
      return receipt.value
    }
    async function compact(expected?: string) {
      const prior = new Set((await transcript(host.client, id)).map(row => row.id))
      const fixture = controller.compaction(expected)
      try {
        await host.client.session.compact({ sessionID: id, delivery: "queue" }, requestOptions())
        const row = await waitFor(async () => {
          const observed = (await transcript(host.client, id)).find(row =>
            !prior.has(row.id) && row.type === "compaction" && row.reason === "manual" && row.status !== "running")
          if (observed?.type === "compaction" && observed.status === "failed") throw new Error(`Manual compaction failed: ${observed.error.message}`)
          return observed
        },
        20_000, "No completed manual compaction in host transcript")
        if (row.type !== "compaction" || row.status !== "completed") throw new Error("Invalid compaction receipt")
        return { id: row.id, reason: row.reason, staleInSummary: !!expected && row.summary.includes(expected),
          staleSeenByProvider: fixture.state.sawExpected }
      } finally { fixture.end() }
    }

    if (!bundle || !factory || !foreign || !runtime) {
      stage = "plugin_absence"
      let toolsSeen: readonly string[] | undefined
      const phase = controller.instruction(undefined, turn => { toolsSeen = turn.tools })
      await prompt(host.client, id, phase)
      const messages = await afterPrompt(host.client, id, phase.id)
      const installed = await plugin()
      mark(arm, stage, !installed && !!toolsSeen && !toolsSeen.includes(algTool),
        { pluginListed: !!installed, algToolVisible: toolsSeen?.includes(algTool) ?? null })
      mark(arm, "primary_transport", messages.some(row => row.type === "assistant" &&
        row.content.some(part => part.type === "text" && part.text === "Fixture turn observed.")),
      { sessionId: id, messageCount: messages.length })
      stage = "forced_compaction"
      mark(arm, stage, true, await compact())
      return
    }

    factory.bindProject(session.projectID)
    stage = "active_runtime"
    const diagnostics = await turn("diagnostics")
    const installed = await waitFor(async () => {
      const entry = await plugin()
      if (entry?.state.status === "failed") throw new Error("OpenCode reported the preview plugin failed")
      return entry?.state.status === "active" ? entry : undefined
    }, 5_000, "Runtime diagnostic succeeded but the location plugin list did not return an active preview")
    mark(arm, stage, installed?.state.status === "active" && diagnostics.ok === true &&
      diagnostics.enabled === true && diagnostics.hostVersion === runtime.version,
    { pluginState: installed?.state.status ?? null, runtimeSha256: diagnostics.runtimeSha256, hostVersion: diagnostics.hostVersion })
    if (team) {
      stage = "team_source_pinned_commit"
      const phase = controller.instruction({ operation: team.operation, source: team.source }, undefined, "alg_team_source")
      await prompt(host.client, id, phase)
      const calls = toolCalls(await afterPrompt(host.client, id, phase.id)).filter(call => call.name === "alg_team_source")
      const state = calls.length === 1 && calls[0]!.state
      const text = state && state.status === "completed" && state.content.find(part => part.type === "text")?.text
      const receipt = text && parseObject(text)
      mark(arm, stage, !!receipt && receipt.source === team.source && receipt.commit === team.commit &&
        receipt.text === team.document && receipt.sha256 === team.digest, { commit: team.commit, digest: team.digest,
          returnedCommittedBytes: !!receipt && receipt.text === team.document })
    }
    const create = await turn("create")
    if (create.ok !== true || typeof create.decision_revision !== "number") throw new Error("Investigation creation failed")
    const stale = `Repeat control inspection ${randomUUID()}`
    const prepared = await turn("set_next_measurement", { expected_decision_revision: create.decision_revision, next_action: stale })
    if (prepared.ok !== true || asObject(prepared.decision)?.next_action !== stale) throw new Error("Stale checkpoint seed was not saved")
    const admit = await turn("admit")
    if (admit.ok !== true || asObject(admit.work)?.status !== "reserved") throw new Error("Local work reservation was not observed")

    stage = "accepted_ack_withheld_at_kill"
    await prompt(host.client, id, controller.instruction({ action: "dispatch" }))
    const accepted = await waitFor(async () => factory.acceptance(), 20_000, "No factory admission with acknowledged response withheld")
    const before = await factory.evidence()
    const stopped = await host.process.kill()
    const ackWithheld = accepted.response === "withheld"
    factory.releaseAck()
    mark(arm, stage, stopped.signalled && !stopped.error && ackWithheld && before.ledger.acceptedComputations === 1,
      { pid: host.info.pid, killed: stopped.signalled, acknowledgement: accepted.response, accepted: before.ledger.acceptedComputations })

    stage = "restart_same_session"
    const oldPid = host.info.pid
    host = await launch()
    const resumed = await host.client.session.get({ sessionID: id }, requestOptions())
    const afterRestart = await turn("status")
    const workBeforeReconcile = asObject(afterRestart.work)
    mark(arm, stage, host.info.pid !== oldPid && resumed.id === id && resumed.projectID === project.id &&
      afterRestart.ok === true && ["submitting", "outcome_unknown"].includes(String(workBeforeReconcile?.status)),
    { oldPid, newPid: host.info.pid, sessionId: resumed.id, workStatus: workBeforeReconcile?.status ?? null })
    const blockedReplay = await turn("dispatch")
    const recovered = await turn("reconcile")
    const manifest = asObject(recovered.work)?.manifest_digest
    stage = "single_remote_admission"
    const service = await factory.evidence()
    const submits = factory.audit.filter(row => row.name === "submit")
    const lookup = factory.audit.find(row => row.name === "lookup" && row.response === "sent" &&
      row.submission === accepted.submission && row.job === accepted.job)
    mark(arm, stage, service.ledger.acceptedComputations === 1 && submits.length === 1 && !!lookup &&
      blockedReplay.ok === false && recovered.ok === true && service.jobs[0]?.job.resultDigest === manifest,
    { submits: submits.length, accepted: service.ledger.acceptedComputations, sameSubmissionLookup: !!lookup,
      replayDenied: blockedReplay.ok === false, reconciliation: recovered.ok === true ? "recorded" :
        typeof recovered.error === "string" && /^[A-Z_]+$/.test(recovered.error) ? recovered.error : "unverified",
      manifestDigest: manifest ?? null })
    if (typeof manifest !== "string") throw new Error("Recovered result has no manifest")

    stage = "forced_compaction_stale_checkpoint"
    const compacted = await compact(stale)
    mark(arm, stage, compacted.staleInSummary && compacted.staleSeenByProvider, compacted)

    stage = "fresh_checker"
    const scripted = controller.checker(manifest)
    releaseChecker = scripted.resume
    const existing = await host.client.session.list({ parentID: id }, requestOptions())
    const started = await turn("start")
    const worker = requireValue(asObject(started.worker), "No host worker identity returned")
    const workerID = worker.workerSessionId, runId = worker.runId
    if (started.ok !== true || typeof workerID !== "string" || typeof runId !== "string") throw new Error("No checker launched")
    const fresh = await host.client.session.get({ sessionID: workerID }, requestOptions())
    const childrenNow = await host.client.session.list({ parentID: id }, requestOptions())
    const ready = await waitFor(async () => {
      const rows = await transcript(host.client, workerID)
      const report = receiptFor(rows, "result")
      return report?.value.ok === true ? { rows, report } : undefined
    }, 20_000, "No checker report acknowledged before revocation")
    const promptRows = ready.rows.filter(row => row.type === "user")
    mark(arm, stage, !existing.data.some(row => row.id === workerID) && existing.data.length === 0 &&
      childrenNow.data.length === 1 && childrenNow.data[0]?.id === workerID && fresh.id !== id && fresh.parentID === id &&
      fresh.agent === checker && fresh.projectID === project.id && fresh.model?.id === model.id &&
      fresh.model?.providerID === model.providerID && promptRows.length === 1 && promptRows[0]?.text.includes(runId) === true &&
      JSON.stringify(fresh.permissions) === JSON.stringify(checkerRules),
    { workerId: workerID, parentId: fresh.parentID, childrenBefore: existing.data.length, childrenAfter: childrenNow.data.length,
      userPrompts: promptRows.length, checker: fresh.agent })

    stage = "cross_project_denied_read"
    const validBeforeForeign = await turn("status", { runId })
    const readsBeforeForeign = factory.audit.filter(row => row.name === "read").length
    const foreignClient = host.clientFor(foreign.directory)
    const other = await foreignClient.session.create({ location: { directory: foreign.directory }, agent: owner, model }, requestOptions())
    const otherChild = await foreignClient.session.create({ location: { directory: foreign.directory },
      parentID: other.id, agent: checker, permissions: [...checkerRules], model }, requestOptions())
    const deniedForeign = await turn("read", { runId }, { client: foreignClient, sessionID: otherChild.id })
    const readsAfterForeign = factory.audit.filter(row => row.name === "read").length
    mark(arm, stage, asObject(validBeforeForeign.worker)?.status === "result_recorded" &&
      otherChild.projectID === foreign.id && otherChild.projectID !== fresh.projectID &&
      otherChild.parentID === other.id && refusal(deniedForeign, runtime.bundleSha256) && readsAfterForeign === readsBeforeForeign,
    { ownerProject: fresh.projectID, foreignProject: otherChild.projectID, refusal: deniedForeign.error ?? null,
      sameProjectResultBeforeDenial: asObject(validBeforeForeign.worker)?.status ?? null,
      serviceReadsBefore: readsBeforeForeign, serviceReadsAfter: readsAfterForeign })

    stage = "revocation_denied_read"
    const readsBeforeRevoke = factory.audit.filter(row => row.name === "read").length
    const revoked = await turn("revoke", { runId })
    scripted.resume()
    const childRows = await afterPrompt(host.client, workerID, runId)
    const [read, denied] = receiptsFor(childRows, "read")
    const afterRevoke = await turn("status", { runId })
    const revokedReads = factory.audit.filter(row => row.name === "read").length
    mark(arm, stage, revoked.ok === true && revoked.revoked === true && refusal(denied?.value, runtime.bundleSha256) &&
      readsBeforeRevoke === revokedReads && asObject(afterRevoke.worker)?.status === "result_authority_unverified",
    { refusal: denied?.value.error ?? null, serviceReadsBefore: readsBeforeRevoke, serviceReadsAfter: revokedReads,
      status: asObject(afterRevoke.worker)?.status ?? null })

    stage = "checker_bounded_cited_read"
    const page = asObject(read?.value.page), citation = asObject(read?.value.citation)
    const report = ready.report
    const workerText = childRows.flatMap(row => row.type === "assistant"
      ? row.content.flatMap(part => part.type === "text" ? [parseObject(part.text)] : []) : [])
      .find(row => row?.manifestDigest === manifest && row.recommendation === factory.current)
    const pages = factory.audit.filter(row => row.name === "read" && row.response === "sent")
    const rowCount = Array.isArray(page?.rows) ? page.rows.length : null
    mark(arm, stage, read?.value.ok === true && read.value.runtimeSha256 === runtime.bundleSha256 &&
      report.value.runtimeSha256 === runtime.bundleSha256 && report.input.result === "pass" &&
      page?.digest === manifest && page.cursor === null && typeof page.next_cursor === "string" &&
      rowCount === factory.pageBound && pages.length === 1 && pages[0]?.job === accepted.job &&
      pages[0]?.maxRows === factory.pageBound && pages[0]?.rows === rowCount &&
      citation?.manifest_digest === manifest && citation.page_sha256 === sha256(JSON.stringify(page)) &&
      typeof citation.read_receipt === "string" && sameRecord(report.input.citation, citation) &&
      !!workerText && !JSON.stringify(childRows).includes(factory.beyondPage) &&
      promptRows.every(row => !row.text.includes(factory.current)) &&
      toolCalls(childRows).every(call => call.name === algTool),
    { jobId: accepted.job, manifestDigest: manifest, pageRows: rowCount, serviceReads: pages.length,
      citedReadReceipt: citation?.read_receipt ?? null, unpromptedValueReported: !!workerText })

    stage = "current_next_measurement"
    const recommendation = workerText?.recommendation
    if (typeof recommendation !== "string") throw new Error("No checker-observed value available to record")
    const verified = await turn("status")
    const next = `Measure oxide thickness at chamber B monitor-wafer site ${recommendation}`
    const recorded = await turn("set_next_measurement", { expected_decision_revision: verified.decision_revision, next_action: next })
    const oldWrite = await turn("set_next_measurement", { expected_decision_revision: verified.decision_revision, next_action: stale })
    let currentSeen = false, staleInProjection = false
    const subsequent = await turn("status", {}, { observe: request => {
      const system = recoveryText(request)
      currentSeen ||= system.includes(next)
      staleInProjection ||= system.includes(stale)
    } })
    mark(arm, stage, compacted.staleInSummary && stale !== next && recorded.ok === true && oldWrite.ok === false &&
      typeof verified.decision_revision === "number" && recorded.decision_revision === verified.decision_revision + 1 &&
      subsequent.ok === true && subsequent.decision_revision === recorded.decision_revision &&
      asObject(subsequent.decision)?.next_action === next && currentSeen && !staleInProjection,
    { revision: subsequent.decision_revision, staleWriteDenied: oldWrite.ok === false,
      currentInSubsequentProviderSystem: currentSeen, staleInCurrentProjection: staleInProjection, nextMeasurement: next })

    stage = "end_user_measurement_handoff"
    let staleSummaryInRequest = false
    const handoff = controller.handoff(request => { staleSummaryInRequest ||= containsStaleSummary(request, stale) })
    await prompt(host.client, id, handoff)
    const handedOff = await afterPrompt(host.client, id, handoff.id)
    const answers = handedOff.flatMap(row => row.type === "assistant"
      ? row.content.flatMap(part => part.type === "text" ? [parseObject(part.text)] : []) : [])
    const answer = answers.length === 1 ? answers[0]?.nextMeasurement : undefined
    const finalAccepted = (await factory.evidence()).ledger.acceptedComputations
    const finalSubmits = factory.audit.filter(row => row.name === "submit").length
    mark(arm, stage, staleSummaryInRequest && answer === next && typeof answer === "string" && answer.includes(factory.current) &&
      !handoff.text.includes(next) && !handoff.text.includes(factory.current) && !handoff.text.includes(stale) &&
      toolCalls(handedOff).length === 0 && finalAccepted === 1 && finalSubmits === 1,
    { staleSummaryInRequest, committedAnswer: answer ?? null, usedCheckerWitness: typeof answer === "string" && answer.includes(factory.current),
      heldRemoteAdmissions: finalAccepted, remoteSubmissions: finalSubmits })
    stage = "two_advisory_researchers"
    const research = async (action: string) => {
      const phase = controller.instruction({ action }, undefined, "alg_research")
      await prompt(host.client, id, phase)
      const call = toolCalls(await afterPrompt(host.client, id, phase.id)).find(call => call.name === "alg_research")
      const content = call?.state.status === "completed" && call.state.content.find(part => part.type === "text")?.text
      return content ? parseObject(content) : undefined
    }
    const batch = await research("start")
    const assignments = Array.isArray(batch?.workers) ? batch.workers.map(asObject) : []
    if (assignments.length !== 2) throw new Error("Host did not return two assigned researchers: " + (batch?.error ?? "missing batch"))
    for (const assignment of assignments) {
      if (typeof assignment?.sessionId !== "string") throw new Error("Missing worker session ID")
      const child = await host.client.session.get({ sessionID: assignment.sessionId }, requestOptions())
      if (child.parentID !== id || child.agent !== assignment.agent) throw new Error("Researcher outside its assigned role")
      await waitFor(async () => (await transcript(host.client, child.id)).some(message => message.type === "idle"),
        12_000, "Researcher did not finish")
    }
    const replay = await research("start")
    const reports = Array.isArray(replay?.workers) ? replay.workers.map(asObject) : []
    const ids = new Set(assignments.map(a => a?.sessionId))
    const allChildren = await host.client.session.list({ parentID: id }, requestOptions())
    mark(arm, stage, ids.size === 2 && reports.length === 2 && replay?.advisory === true &&
      reports.every(r => r?.status === "reported" && typeof r.report === "string" && ids.has(r.sessionId)) &&
      allChildren.data.length === childrenNow.data.length + 2 && (await factory.evidence()).ledger.acceptedComputations === 1,
      { workers: ids.size, reports: reports.map(r => r?.status), totalChildren: allChildren.data.length })
  } catch (error) {
    arm.failure = `${stage}: ${boundedError(error)}`
    if (arm.claims[stage]?.grade === "NOT_OBSERVED") mark(arm, stage, false, { error: boundedError(error) })
  } finally {
    releaseChecker?.()
    arm.providerCalls = provider.calls
    arm.providerErrors = provider.errors
    const cleanup = await Promise.allSettled([
      ...children.filter(host => !host.process.exited()).map(host => host.process.kill()),
      provider.stop(), factory?.stop(),
    ])
    if (cleanup.some(row => row.status === "rejected")) arm.failure ??= "An isolated process or listener failed cleanup"
  }
}

export function refusal(value: Record<string, unknown> | undefined, digest: string) {
  return value?.ok === false && value.runtimeSha256 === digest && typeof value.error === "string" &&
    value.error.length > 0 && Object.keys(value).every(key => ["ok", "runtimeSha256", "error"].includes(key))
}

function sameRecord(left: unknown, right: Record<string, unknown>) {
  const value = asObject(left)
  return !!value && Object.keys(value).length === Object.keys(right).length &&
    Object.entries(right).every(([key, expected]) => value[key] === expected)
}

export async function runAcceptance(binary: string, bundle: string) {
  const native = makeArm(nativeClaims), preview = makeArm(previewClaims)
  preview.claims.background_compaction_race = { grade: "NOT_OBSERVED", observed: "The fixture requests compaction explicitly and waits for durable completion." }
  const scratch = await mkdtemp(join(root, ".v2-acceptance-"))
  let runtime: Awaited<ReturnType<typeof runtimeIdentity>> | undefined
  let failure: string | undefined
  try {
    const version = await hostVersion(binary, join(scratch, "version"))
    runtime = await runtimeIdentity(binary, bundle, version)
    await runArm(binary, scratch + "/native", native)
    await runArm(binary, scratch + "/preview", preview, runtime, bundle)
    const verified = await runtimeIdentity(binary, bundle, version)
    if (JSON.stringify(runtime) !== JSON.stringify(verified)) throw new Error("Staged runtime changed during acceptance")
  } catch (error) { failure = boundedError(error) }
  finally {
    try {
      const target = await realpath(scratch), workspace = await realpath(root)
      if (dirname(target) !== workspace || !basename(target).startsWith(".v2-acceptance-")) throw new Error("Isolated scratch identity mismatch")
      await rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (error) { failure ??= `Scratch cleanup: ${boundedError(error)}` }
  }
  const required = [...Object.values(native.claims), ...Object.entries(preview.claims)
    .filter(([name]) => name !== "background_compaction_race").map(([, claim]) => claim)]
  const passed = !!runtime && !failure && !native.failure && !preview.failure &&
    !native.providerErrors?.length && !preview.providerErrors?.length && required.every(claim => claim.grade === "PASS")
  return { schema: 1, passed, runtime, failure, arms: { native, preview },
    comparison: "Native is a transport, forced-compaction and plugin-absence control. Preview exercises governed recovery and evidence access with a scripted provider." }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length !== 6 || args[0] !== "--host" || args[2] !== "--package" || args[4] !== "--out")
    throw new Error("Usage: bun run packages/v2-preview/acceptance/index.ts --host <native OpenCode 2.3.2> --package <bundle directory> --out <new receipt.json>")
  const binary = await realpath(resolve(args[1]!)), bundle = await realpath(resolve(args[3]!))
  const out = await open(resolve(args[5]!), "wx")
  let status = 1
  try {
    const receipt = await runAcceptance(binary, bundle)
    await out.writeFile(JSON.stringify(receipt, null, 2) + "\n")
    await out.sync()
    await Bun.write(Bun.stdout, JSON.stringify({ passed: receipt.passed, failure: receipt.failure,
      nativeFailure: receipt.arms.native.failure, previewFailure: receipt.arms.preview.failure,
      failed: Object.entries(receipt.arms.preview.claims).filter(([, claim]) => claim.grade === "FAIL").map(([name]) => name) }) + "\n")
    status = receipt.passed ? 0 : 1
  } finally { await out.close() }
  process.exit(status)
}

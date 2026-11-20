import { mkdtemp, open, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import type { McpServer, PluginState, SessionInfo } from "@opencode/client"
import { algTool, hostVersion, owner, receiptsFor, requestOptions, startHost, toolCalls, transcript } from "../acceptance/host.ts"
import { runtimeIdentity, sha256, waitFor } from "../acceptance/runtime.ts"
import { startFactory } from "../acceptance/service.ts"
import { auditWire, childAudit, childTask, childTool, classifyChildAudit, scriptedChildAudit, type Phase } from "./child-audit-script.ts"
import { checkedHandoff, continuation, evidenceFixture, evidenceSkill, handoffHeader, initialPrompt, skillId } from "./evidence-handoff-case.ts"
import { expectedAnswers } from "./evidence-handoff-grade.ts"
import { jsonObject, object } from "./handoff-case.ts"
import { hasScopedEvidenceTools, installAlg, observeTurn, pluginId, prepareHost, registerSkill, submitTurn, type Host } from "./host.ts"
import { maxProviderBytes, maxProviderCalls, startTransport } from "./transport.ts"
import { createWorkbench, evidenceToolNames, startWorkbench } from "./workbench.ts"

type Row = Awaited<ReturnType<typeof transcript>>[number]
type Runtime = Awaited<ReturnType<typeof runtimeIdentity>>
const scenarios = ["lifecycle", "revoked"] as const
type Scenario = typeof scenarios[number]
const scratchPrefix = "alg-child-audit-"
const readinessMs = 20_000
const model = { providerID: "paired-benchmark", id: "fixture" }
const fixtureModel = (actual: SessionInfo["model"]) =>
  actual?.providerID === model.providerID && actual.id === model.id
const fixture = evidenceFixture("held-out")
const expected = expectedAnswers("held-out")
const operatorHandoff = (row: Row) => row.type === "user" && row.text.startsWith(handoffHeader + "\n")
const statusAt = (rows: Row[]) => receiptsFor(rows, "status").at(-1)
const userIds = (rows: Row[]) => rows.filter(row => row.type === "user").map(row => row.id)

function auditReadGate(endpoint: string) {
  let opened = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let held = 0
  const proxy = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 30, maxRequestBodySize: 16 * 1024,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/audit") return new Response(null, { status: 404 })
      const body = await request.text()
      if (!opened && jsonObject(body)?.method === "tools/call") {
        held++
        await gate
      }
      return fetch(endpoint, { method: "POST", headers: request.headers, body, signal: request.signal })
    },
  })
  const openGate = () => { opened = true; release() }
  return { url: "http://127.0.0.1:" + proxy.port + "/audit", held: () => held,
    release: openGate, stop() { openGate(); proxy.stop(true) } }
}

export function nativeWake(rows: Row[], idleId: string, childId: string) {
  const boundary = rows.findIndex(row => row.id === idleId && row.type === "idle" && row.outcome === "succeeded")
  if (boundary < 0 || rows.slice(boundary + 1).some(row => row.type === "user")) return
  const tail = rows.slice(boundary + 1)
  const notices = tail.filter(row => row.type === "synthetic" && row.metadata?.source === "subagent" &&
    row.metadata.childID === childId && row.metadata.agent === childAudit.agent && row.metadata.state === "completed")
  const notice = notices.length === 1 && notices[0]
  if (!notice) return
  const wake = tail.slice(tail.indexOf(notice) + 1)
  const idle = wake.at(-1)
  const answer = wake.find(row => row.type === "assistant" && row.agent === owner && row.finish === "stop" &&
    row.time.completed !== undefined && !row.error)
  if (idle?.type === "idle" && idle.outcome === "succeeded" && answer?.type === "assistant")
    return { notice, wake, idleId: idle.id, answer: answer.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n") }
}

export function sameVerifiedReport(before: ReturnType<typeof statusAt>, after: ReturnType<typeof statusAt>, runtimeSha256: string) {
  return !!before && !!after && before.value.ok === true && after.value.ok === true &&
    before.value.runtimeSha256 === runtimeSha256 && after.value.runtimeSha256 === runtimeSha256 &&
    object(before.value.evidenceReport)?.status === "verified" &&
    before.value.revision === after.value.revision && before.value.decision_revision === after.value.decision_revision &&
    isDeepStrictEqual(before.value.evidenceReport, after.value.evidenceReport) &&
    isDeepStrictEqual(before.value.decision, after.value.decision)
}

export function changeHandoff(handoff: string) {
  const correction = jsonObject(handoff.slice(handoffHeader.length))
  if (!Array.isArray(correction?.auditRows) || !correction.auditRows.length) throw new Error("Expected verified checker rows")
  const changed = correction.auditRows.map(row => {
    const value = object(row)
    return value?.status === "verified" ? { ...value, status: "rejected" } : row
  })
  if (isDeepStrictEqual(changed, correction.auditRows)) throw new Error("Expected changed audit rows")
  return handoffHeader + "\n" + JSON.stringify({ ...correction, auditRows: changed })
}

async function runScenario(binary: string, bundle: string, scratch: string, scenario: Scenario, runtime: Runtime) {
  const workbench = createWorkbench({ fixture, maxAcceptedQueries: 4 })
  const evidence = startWorkbench(workbench)
  const gate = auditReadGate(evidence.checkerEndpoint)
  const factory = startFactory(join(scratch, "factory"), false)
  const wires: (ReturnType<typeof auditWire> & { id: number; phase: string })[] = []
  const checks: Record<string, boolean> = {}
  const restarts: { boundary: string; cutId: string; fromPid: number; toPid: number; transcriptStable: boolean }[] = []
  const readiness: {
    boundary: string; pid: number; elapsedMs: number; ready: boolean; requiresWorkbenches: boolean
    plugin: PluginState | { status: "missing" | "unobserved" }
    workbenches: Record<string, McpServer["status"]>
    catalogErrors: { plugin?: string; mcp?: string }
  }[] = []
  let phase: Phase = "initial"
  let skill: Awaited<ReturnType<typeof registerSkill>> | undefined
  const provider = startTransport({
    id: model.id, seed: 107, stale: "unsupported", correction: handoffHeader, skill: () => skill?.witness,
    classify(messages, id) {
      const scope = classifyChildAudit(messages, phase)
      wires.push({ ...auditWire(messages), id, phase: scope.phase })
      return scope
    },
    decide: input => scriptedChildAudit(input, phase),
  })
  provider.releaseSummary()
  let host: Host | undefined
  let root: SessionInfo | undefined, child: SessionInfo | undefined
  let rootRows: Row[] = [], childRows: Row[] = []
  let wake: ReturnType<typeof nativeWake>
  let nativeStatus: ReturnType<typeof statusAt>, reopenedStatus: ReturnType<typeof statusAt>
  let duplicateStatus: ReturnType<typeof statusAt>, negativeStatus: ReturnType<typeof statusAt>
  let beforeNative = workbench.snapshot()
  let nativeProofReads = workbench.snapshot()
  let failure: string | null = null
  let hostLog: string | null = null
  const startedAt = performance.now()
  function check(name: string, passed: unknown): asserts passed {
    checks[name] = Boolean(passed)
    if (!passed) throw new Error("Acceptance check failed: " + name)
  }
  try {
    const project = await prepareHost(scratch, { model, providerUrl: provider.url,
      evidenceUrl: evidence.endpoint, checkerUrl: gate.url, skill: { name: skillId, content: evidenceSkill }, bundle })
    project.config.compaction.auto = false
    project.config.agents[owner].permissions.push(
      { action: "tool.use", resource: childTool, effect: "allow" },
      { action: childTool, resource: childAudit.agent, effect: "allow" },
    )
    await writeFile(project.configPath, JSON.stringify(project.config))
    const start = () => startHost(binary, project.directory, project.settings)
    host = await start()
    skill = await registerSkill(host, project, skillId)
    check("approvedFixtureSkill", skill.sourceSha256 === sha256(evidenceSkill))
    await host.process.kill()
    await installAlg(project, bundle, skill, factory, childAudit)
    host = await start()
    const location = { directory: project.directory }
    const rootSession = root = await host.client.session.create({ location, model, agent: owner,
      title: "Bounded inspection native audit" }, requestOptions())
    check("ownerIdentity", !root.parentID && root.agent === owner && fixtureModel(root.model))
    factory.bindProject(root.projectID)

    async function ready(boundary: string) {
      const { client, info, process: hostProcess } = host!
      const started = performance.now()
      const requiresWorkbenches = boundary !== "nativeVerified"
      const sample: typeof readiness[number] = {
        boundary, pid: info.pid, elapsedMs: 0, ready: false, requiresWorkbenches,
        plugin: { status: "unobserved" }, workbenches: {}, catalogErrors: {},
      }
      readiness.push(sample)
      try {
        await waitFor(async () => {
          if (hostProcess.exited()) throw new Error("Host exited during readiness")
          const timeout = Math.max(1, Math.min(3000, Math.floor(readinessMs - (performance.now() - started))))
          const [plugins, workbenches] = await Promise.allSettled([
            client.plugin.list({ location }, requestOptions(timeout)),
            requiresWorkbenches ? client.mcp.list({ location }, requestOptions(timeout)) : Promise.resolve(undefined),
          ])
          sample.catalogErrors = {}
          if (plugins.status === "fulfilled")
            sample.plugin = plugins.value.data.find(row => row.id === pluginId)?.state ?? { status: "missing" }
          else sample.catalogErrors.plugin = String(plugins.reason)
          if (workbenches.status === "rejected") sample.catalogErrors.mcp = String(workbenches.reason)
          else if (workbenches.value)
            sample.workbenches = Object.fromEntries(workbenches.value.data.map(row => [row.name, row.status]))
          if (sample.plugin.status === "failed") throw new Error("Installed preview plugin failed")
          const workbenchesReady = !requiresWorkbenches || (Object.keys(sample.workbenches).length === 2 &&
            ["evidence", "audit"].every(name => sample.workbenches[name]?.status === "connected"))
          if (Object.keys(sample.catalogErrors).length === 0 && sample.plugin.status === "active" &&
              workbenchesReady) {
            sample.ready = true
            return true
          }
        }, readinessMs, "Readiness deadline exceeded")
      } catch (error) {
        const endState = JSON.stringify({ plugin: sample.plugin, workbenches: sample.workbenches, catalogErrors: sample.catalogErrors })
        throw new Error(boundary + " readiness: " + (error instanceof Error ? error.message : String(error)) + " " + endState)
      } finally {
        sample.elapsedMs = performance.now() - started
      }
    }
    await ready("installed")
    const role = (await host.client.agent.get({ location, agentID: childAudit.agent }, requestOptions())).data
    check("nativeSubagentRole", role.id === childAudit.agent && role.mode === "subagent" && role.hidden === false &&
      role.permissions.some(row => row.action === childAudit.tool && row.effect === "allow"))

    const rows = () => transcript(host!.client, rootSession.id)
    async function turn(text: string) {
      const id = await submitTurn(host!, rootSession.id, text)
      return waitFor(() => observeTurn(host!, rootSession.id, id), 25_000, "Owner operator turn timed out: " + phase)
    }
    async function compactAndRestart(boundary: "incompletePrefix" | "nativeVerified") {
      phase = "compact"
      const previous = new Set((await rows()).map(row => row.id))
      await host!.client.session.compact({ sessionID: rootSession.id, delivery: "queue" }, requestOptions())
      const cut = await waitFor(async () => {
        const history = await rows()
        const row = history.find(row => row.type === "compaction" && row.reason === "manual" && !previous.has(row.id))
        if (row?.type === "compaction" && row.status === "failed") throw new Error("Compaction failed: " + boundary)
        if (row?.type === "compaction" && row.status === "completed" && history.at(-1)?.type === "idle") return row
      }, 20_000, "No completed compaction: " + boundary)
      const saved = await rows()
      const fromPid = host!.info.pid
      const ledger = workbench.snapshot()
      if (!(await host!.process.kill()).signalled) throw new Error("Prior host did not stop: " + boundary)
      host = await start()
      const loaded = await host.client.session.get({ sessionID: rootSession.id }, requestOptions())
      const transcriptStable = isDeepStrictEqual(saved, await rows())
      restarts.push({ boundary, cutId: cut.id, fromPid, toPid: host.info.pid, transcriptStable })
      check(boundary + "Restart", fromPid !== host.info.pid && loaded.id === rootSession.id &&
        loaded.projectID === rootSession.projectID && loaded.agent === owner && transcriptStable &&
        isDeepStrictEqual(workbench.snapshot(), ledger))
      await ready(boundary)
    }

    const initial = await turn(initialPrompt)
    const initialReport = object(statusAt(initial.rows)?.value.evidenceReport)
    check("incompletePrefix", isDeepStrictEqual(jsonObject(initial.text), expected.initial) &&
      object(initialReport?.obligation)?.kind === "need_page" && object(initialReport?.obligation)?.nextLimit === 8 &&
      workbench.snapshot().calls === 1)
    await compactAndRestart("incompletePrefix")
    phase = "resume"
    const resumed = await turn(continuation)
    const resumedReport = object(statusAt(resumed.rows)?.value.evidenceReport)
    const spawn = toolCalls(resumed.rows).filter(call => call.name === childTool)
    const started = spawn[0]
    check("nativeSpawnFromSelectedCohort", isDeepStrictEqual(jsonObject(resumed.text), expected.resume) &&
      object(resumedReport?.obligation)?.kind === "need_audit" && spawn.length === 1 &&
      started?.state.status === "completed" && started.state.input.agent === childAudit.agent &&
      started.state.input.prompt === childTask.prompt && started.state.input.sessionID == null)
    const children = (await host.client.session.list({ parentID: root.id, limit: 3 }, requestOptions())).data
    child = children[0]
    check("nativeChildIdentity", children.length === 1 && !!child && child.parentID === root.id &&
      child.id !== root.id && child.projectID === root.projectID && child.agent === role.id &&
      fixtureModel(child.model))
    const childId = child!.id
    await waitFor(async () => gate.held() === 1 ? true : undefined, 10_000, "Native child did not reach gated audit lookup")
    const beforeRows = await rows()
    const ownerIdle = beforeRows.at(-1)
    beforeNative = workbench.snapshot()
    check("ownerIdleBeforeChildCompletion", ownerIdle?.type === "idle" && ownerIdle.outcome === "succeeded" &&
      beforeNative.calls === 3 && beforeNative.receipts.every(row => row.scope === "root") &&
      beforeRows.every(row => !operatorHandoff(row) && row.type !== "synthetic"))

    phase = "wake"
    gate.release()
    wake = await waitFor(async () => nativeWake(await rows(), ownerIdle!.id, childId), 25_000,
      "No successful native child-completion wake in owner transcript")
    const afterRows = await rows()
    const settledChild = await host.client.session.get({ sessionID: childId }, requestOptions())
    childRows = await transcript(host.client, childId)
    const childIdle = childRows.at(-1)
    const terminal = childRows.at(-2)
    const checkerText = terminal?.type === "assistant" && terminal.content[0]?.type === "text" ? terminal.content[0].text : ""
    const handoff = checkedHandoff(checkerText, "held-out")
    const calls = toolCalls(childRows)
    const read = calls[0]
    const output = read?.state.status === "completed" && read.state.content[0]?.type === "text"
      ? jsonObject(read.state.content[0].text) : undefined
    const page = Array.isArray(output?.pages) && output.pages.length === 1 ? object(output.pages[0]) : undefined
    check("nativeChildEvidence", settledChild.outcome === "succeeded" && childIdle?.type === "idle" &&
      childIdle.outcome === "succeeded" && terminal?.type === "assistant" && terminal.agent === childAudit.agent &&
      terminal.finish === "stop" && terminal.time.completed !== undefined && !terminal.error && terminal.content.length === 1 &&
      !!handoff && calls.length === 1 && read?.name === childAudit.tool && read.executed !== true &&
      read.state.status === "completed" && read.state.content.length === 1 &&
      output?.status === "ok" && output.op === "lookup" && page?.source === childAudit.source &&
      page.offset === 0 && page.nextCursor === null && page.evidenceRef === jsonObject(checkerText)?.auditRef &&
      Array.isArray(page.rows) && page.rows.length === page.totalRows &&
      isDeepStrictEqual(page.rows, jsonObject(checkerText)?.auditRows) &&
      childIdle.time.created <= wake.notice.time.created && isDeepStrictEqual(userIds(beforeRows), userIds(afterRows)))
    nativeProofReads = workbench.snapshot()
    const admissions = nativeProofReads.receipts.map(row => [row.scope, row.outcome, row.pages[0]?.source, row.pages[0]?.rows])
    check("boundedScopedReads", isDeepStrictEqual(admissions, [
      ["root", "admitted", "inspection", 4], ["root", "admitted", "inspection", 8],
      ["root", "admitted", "inspection", 12], ["checker", "admitted", childAudit.source, 5],
    ]))
    const wakeWires = wires.filter(row => row.phase === "wake")
    check("nativeProjectionBeforeHandoff", wakeWires.length > 0 && wakeWires.every(row => row.explicitHandoffs === 0) &&
      wakeWires.some(row => row.nativeNotices === 1 && row.calculation.projections === 1 &&
        row.calculation.values?.verifiedClockCorrections === expected.final!.verifiedClockCorrections &&
        row.references?.auditRef === expected.final!.auditRef))
    nativeStatus = statusAt(wake.wake)
    const report = object(nativeStatus?.value.evidenceReport)
    const { status: verified, ...fields } = expected.final!
    const acknowledgements = receiptsFor(wake.wake, "set_next_measurement")
    const ack = acknowledgements[0]
    check("nativeVerifiedDecision", verified === "verified" && isDeepStrictEqual(jsonObject(wake.answer), expected.final) &&
      nativeStatus?.value.ok === true && nativeStatus.value.runtimeSha256 === runtime.bundleSha256 &&
      report?.status === verified && isDeepStrictEqual(report.fields, fields) &&
      acknowledgements.length === 1 && ack?.value.ok === true && ack.value.runtimeSha256 === runtime.bundleSha256 &&
      ack.input.next_action === fields.nextAction + "; prerequisite=" + fields.prerequisite &&
      ack.value.decision_revision === report.revision && report.revision === nativeStatus.value.decision_revision)

    const nativeRequestCount = provider.requests.length
    await compactAndRestart("nativeVerified")
    const reopenedChild = await host!.client.session.get({ sessionID: childId }, requestOptions())
    check("childTranscriptReopened", reopenedChild.parentID === root.id && reopenedChild.agent === role.id &&
      isDeepStrictEqual(await transcript(host!.client, childId), childRows))
    const factoryOffset = factory.audit.length
    phase = "probe"
    const probe = await turn(continuation)
    reopenedStatus = statusAt(probe.rows)
    const onlyStatus = (observed: typeof probe) =>
      toolCalls(observed.rows).length === 1 && receiptsFor(observed.rows, "status").length === 1
    check("verifiedAfterRestartBeforeExplicitRows", sameVerifiedReport(nativeStatus, reopenedStatus, runtime.bundleSha256) &&
      onlyStatus(probe) && (await rows()).every(row => !operatorHandoff(row)))
    if (scenario === "lifecycle") {
      phase = "duplicate"
      const duplicate = await turn(handoff!)
      duplicateStatus = statusAt(duplicate.rows)
      check("matchingExplicitArrivalIdempotent", onlyStatus(duplicate) &&
        sameVerifiedReport(reopenedStatus, duplicateStatus, runtime.bundleSha256))
      phase = "conflict"
      const changed = await turn(changeHandoff(handoff!))
      negativeStatus = statusAt(changed.rows)
      const conflict = object(negativeStatus?.value.evidenceReport)
      check("changedExplicitArrivalConflicts", onlyStatus(changed) && negativeStatus?.value.ok === true &&
        negativeStatus.value.runtimeSha256 === runtime.bundleSha256 && conflict?.status === "abstained" &&
        object(conflict.obligation)?.kind === "conflict" &&
        !Object.hasOwn(object(conflict.measurements) ?? {}, "verifiedClockCorrections") && !conflict.fields &&
        wires.filter(row => row.phase === "conflict").every(row =>
          row.calculation.values?.verifiedClockCorrections === undefined && row.references?.auditRef === undefined))
    } else {
      phase = "revoked"
      await rename(join(project.directory, ".opencode", "research-procedure.json"), join(scratch, "withdrawn-approval.json"))
      const revoked = await turn(continuation)
      negativeStatus = statusAt(revoked.rows)
      check("revokedApprovalWithholdsNativeEvidence", onlyStatus(revoked) && negativeStatus?.value.ok === true &&
        negativeStatus.value.runtimeSha256 === runtime.bundleSha256 && negativeStatus.value.procedure_authority === "unavailable" &&
        object(negativeStatus.value.decision)?.next_action === null &&
        isDeepStrictEqual(negativeStatus.value.evidenceReport, { status: "incomplete", reason: "approval_unavailable" }) &&
        wires.filter(row => row.phase === "revoked").every(row => row.calculation.projections === 0))
    }
    const ordinary = provider.requests.slice(0, nativeRequestCount).filter(row => row.kind === "ordinary")
    const reopenedRequests = provider.requests.slice(nativeRequestCount)
    check("providerRoleScopes", hasScopedEvidenceTools(ordinary.filter(row => row.role === "root"),
      ordinary.filter(row => row.role === "checker")) &&
      ordinary.filter(row => row.role === "checker").every(row => !row.tools.includes(algTool) && !row.tools.includes(childTool)) &&
      reopenedRequests.every(row => row.role === "root" && evidenceToolNames.every(name => !row.tools.includes("audit_" + name))))
    const work = await factory.evidence()
    check("noPostWakeEvidenceOrFactoryReads", isDeepStrictEqual(nativeProofReads, workbench.snapshot()) &&
      factory.audit.length === factoryOffset && work.ledger.acceptedComputations === 1 && work.jobs.length === 1)
    check("boundedLocalTransport", provider.requests.length > 0 && provider.requests.every(row => row.status === 200) &&
      provider.requests.length <= maxProviderCalls &&
      provider.requests.every(row => (row.requestBytes ?? Infinity) <= maxProviderBytes))
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    hostLog = host?.process.log() ?? null
  } finally {
    try {
      if (host && !host.process.exited()) {
        if (root) rootRows = await transcript(host.client, root.id).catch(() => rootRows)
        if (child) childRows = await transcript(host.client, child.id).catch(() => childRows)
        await host.process.kill()
      }
    } finally {
      provider.stop()
      gate.stop()
      evidence.stop()
      await factory.stop()
    }
  }
  return { scenario, passed: failure === null, failure, hostLog, checks, restarts, readiness, elapsedMs: performance.now() - startedAt,
    root: root && { id: root.id, projectID: root.projectID, agent: root.agent, model: root.model },
    child: child && { id: child.id, parentID: child.parentID, projectID: child.projectID, agent: child.agent, model: child.model },
    wakeNoticeId: wake?.notice.id, wakeIdleId: wake?.idleId,
    nativeStatus, reopenedStatus, duplicateStatus, negativeStatus, beforeNative, nativeProofReads,
    ledger: workbench.snapshot(), factoryOperations: factory.audit, requests: provider.requests, wires,
    raw: { root: rootRows, child: childRows } }
}

export async function runChildAuditAcceptance(binary: string, bundle: string, selected: readonly Scenario[] = scenarios) {
  const parent = await realpath(tmpdir())
  const scratch = await mkdtemp(join(parent, scratchPrefix))
  try {
    const runtime = await runtimeIdentity(binary, bundle, await hostVersion(binary, join(scratch, "version")))
    const results: Awaited<ReturnType<typeof runScenario>>[] = []
    for (const scenario of selected) results.push(await runScenario(binary, bundle, join(scratch, scenario), scenario, runtime))
    const runtimeUnchanged = isDeepStrictEqual(runtime, await runtimeIdentity(binary, bundle, runtime.version))
    return { schema: 1, caseId: fixture.id, mode: "installed-native-host-loopback-scripted-provider",
      childAudit, runtime, runtimeUnchanged, passed: runtimeUnchanged && results.every(row => row.passed), results }
  } finally {
    const real = await realpath(scratch)
    if (dirname(real) !== parent || !basename(real).startsWith(scratchPrefix)) throw new Error("Child audit scratch cleanup refused")
    await rm(real, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}

const usage = "Usage: bun packages/v2-preview/benchmark/child-audit-acceptance.ts --host <OpenCode 2.3.2> --package <staged bundle> --out <new JSON> [--case lifecycle|revoked]"
if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--help") console.log(usage)
  else {
    const flags = new Map<string, string>()
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i]!, value = args[i + 1]
      if (!["--host", "--package", "--out", "--case"].includes(flag) || flags.has(flag) || !value || value.startsWith("--"))
        throw new Error(usage)
      flags.set(flag, value)
    }
    const binary = flags.get("--host"), bundle = flags.get("--package"), out = flags.get("--out")
    const selected = scenarios.find(scenario => scenario === flags.get("--case"))
    if (!binary || !bundle || !out || (flags.has("--case") && !selected)) throw new Error(usage)
    const [executable, staged] = await Promise.all([realpath(binary), realpath(bundle)])
    const file = await open(out, "wx")
    try {
      const result = await runChildAuditAcceptance(executable, staged, selected ? [selected] : scenarios)
      await file.writeFile(JSON.stringify(result, null, 2) + "\n")
      await file.sync()
      console.log(JSON.stringify({ passed: result.passed, mode: result.mode, results: result.results.map(row =>
        ({ scenario: row.scenario, checks: row.checks, failure: row.failure, restarts: row.restarts.length,
          sourceReads: row.ledger.calls, localProviderRequests: row.requests.length })) }))
      process.exitCode = result.passed ? 0 : 1
    } finally { await file.close() }
  }
}

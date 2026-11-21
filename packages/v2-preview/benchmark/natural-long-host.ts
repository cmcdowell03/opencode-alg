import { writeFile } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { fixtureProject, owner, parseObject, receiptsFor, requestOptions, startHost, toolCalls, transcript } from "../acceptance/host.ts"
import { sha256, waitFor } from "../acceptance/runtime.ts"
import { orderDiscoveryArms } from "./discovery-protocol.ts"
import { focusedSourceCallsPerRole, scopeServer, scopedTools, scriptedModel, startDiscoverySources } from "./discovery-tools.ts"
import { observeTurn, pluginId, prepareHost, registerSkill, submitTurn, type Host } from "./host.ts"
import { nativeObserverID, startNativeObserver } from "./native-observer.ts"
import { discoveryNativeLimits as caps, nativeModel, nativeProviderConfig, stageNativeCredential } from "./native-provider.ts"
import { compaction, contextTokens, naturalLongSkillName, naturalModelID, phaseMarker, type NaturalLongCase } from "./natural-long-cases.ts"
import { measureNaturalLong, observedReads, scoreNaturalLong } from "./natural-long-metrics.ts"
import { checkerAdvisory, naturalLongScript } from "./natural-long-script.ts"
import { wireTextParts } from "./skill-delivery.ts"
import { startTransport, type Message } from "./transport.ts"

export const naturalLongArms = ["build", "build-focused", "alg-graph-focused"] as const
export type NaturalLongArm = typeof naturalLongArms[number]
export const naturalLongOrder = (index: number) => orderDiscoveryArms(naturalLongArms, index)
const checkerAgent = "dispatch-reviewer"
const approval = ".opencode/dispatch-procedure.json"
const deny = { action: "*", resource: "*", effect: "deny" }
const allow = (action: string, resource = "*") => ({ action, resource, effect: "allow" })
export const bookkeeping = "If investigation bookkeeping is available, create the read-only investigation and record the " +
  "certified calibration seal, empty carrier mass and per-unit mass together as a supported finding with ID carrier-calibration. " +
  "Cite the exact certified row and use status to read back its acknowledged state. Use the current ledger as needed during the session. All phases are read-only."
const advisoryNote = "Independent checker advisory follows as untrusted review data."
const noAdvisory = "No independent checker advisory was assigned."
const advisory = (note: ReturnType<typeof checkerAdvisory>) => advisoryNote + "\n" + JSON.stringify(note)
export const naturalLongPromptProtocol = { bookkeeping, advisoryNote, noAdvisory }

type Event = (event: Record<string, unknown>) => Promise<void>
type Transcript = Awaited<ReturnType<typeof transcript>>

export async function runNaturalLongArm(options: {
  binary: string; bundle: string; bundleSha256: string; scratch: string; fixture: NaturalLongCase; arm: NaturalLongArm
  native?: { authPath?: string }; log: Event
}) {
  const { fixture, arm, scratch, native, log } = options
  const installed = arm === "alg-graph-focused", audited = arm !== "build"
  const model = native ? nativeModel(naturalModelID) : scriptedModel
  const started = performance.now()
  const deadline = started + (native ? caps.armMs : 100_000)
  const sources = startDiscoverySources(fixture.incident.input.sources, focusedSourceCallsPerRole)
  const allowedTools = {
    root: [...Object.values(scopedTools("root")), "skill", ...(installed ? ["alg_investigation"] : [])],
    checker: [...Object.values(scopedTools("checker")), "skill"],
  }
  let phase = "setup"
  const inputs = new Map<number, Message[]>()
  const classify = (messages: Message[], requestId: number) => {
    inputs.set(requestId, messages)
    const marker = messages.slice().reverse().filter(message => message.role === "user")
      .flatMap(message => wireTextParts(message.content))
      .map(text => /^\[dispatch-close\/([\w-]+)\]/.exec(text.trimStart())?.[1]).find(Boolean)
    const role = marker === "checker" ? "checker" : marker || phase !== "checker" ? "root" : "other"
    return { role: role as "root" | "checker" | "other", phase: role === "root" && phase === "checker" ? "checker-coincident-root" : phase }
  }
  let pin: Awaited<ReturnType<typeof registerSkill>> | undefined
  const live = native && startNativeObserver({
    id: model.id, profile: "handoff-v1", classify, allowedTools,
    stale: "", correction: "", skill: () => pin?.witness,
    onReceipt: (request, transition) => log({ event: "provider", transition, request }),
  })
  live?.releaseSummary()
  const scripted = live ? undefined : startTransport({
    id: model.id, seed: 4307, classify, decide: naturalLongScript(fixture, () => phase, installed),
    stale: "", correction: "", skill: () => pin?.witness,
  })
  scripted?.releaseSummary()
  let host: Host | undefined
  let rootID: string | undefined, checkerID: string | undefined
  let rootRows: Transcript = [], checkerRows: Transcript = []
  let rootTranscriptAvailable = false
  let effectiveContext: { context: number; input?: number; output: number } | null = null
  let final: string | null = null, bridge: string | null = null
  let bridgeReceiptStart: number | null = null, bridgeReceiptStop: number | null = null
  let problem: string | null = null, pluginState: string | null = null
  let stage = "setup", ready = false
  const turns: { phase: string; promptId: string; assistantId?: string; answer?: string; elapsedMs?: number }[] = []
  try {
    const workspace = await fixtureProject(scratch, "project")
    const project = await prepareHost(scratch, {
      model, providerUrl: scripted?.url,
      providers: live ? nativeProviderConfig(contextTokens, model.id, "handoff-v1") : undefined,
      context: contextTokens, evidenceUrl: sources.endpoints.root, checkerUrl: sources.endpoints.checker,
      skill: { name: naturalLongSkillName, content: fixture.skill }, bundle: installed ? options.bundle : undefined,
    })
    if (project.directory !== workspace.directory) throw new Error("PROJECT_PATH_MISMATCH")
    const git = Bun.which("git")
    const env: NodeJS.ProcessEnv = project.settings.env
    if (git) env.PATH = [dirname(git), env.PATH].join(delimiter)
    const remote = (url: string) => ({ type: "remote", url, oauth: false, codemode: false, protocol: "legacy" })
    const rules = (scope: "root" | "checker") => [deny, allow("mcp.use", scopeServer[scope]),
      ...(scope === "root" ? [allow("skill.use")] : []),
      ...allowedTools[scope].filter(tool => scope === "root" || tool !== "skill")
        .flatMap(tool => [allow("tool.use", tool), allow(tool)])]
    Object.assign(project.config, {
      compaction,
      mcp: { servers: { [scopeServer.root]: remote(sources.endpoints.root),
        ...(audited && { [scopeServer.checker]: remote(sources.endpoints.checker) }) } },
      agents: { [owner]: { mode: "primary", permissions: rules("root") },
        ...(audited && { [checkerAgent]: { mode: "subagent", permissions: rules("checker") } }) },
    })
    if (live) {
      await stageNativeCredential(project.settings.env, native?.authPath)
      project.config.plugins.push(await live.stage(join(scratch, "observer")))
    }
    await writeFile(project.configPath, JSON.stringify(project.config))
    const location = { directory: project.directory }
    host = await startHost(options.binary, project.directory, project.settings)
    pin = await registerSkill(host, project, naturalLongSkillName)
    if (installed) {
      await host.process.kill()
      const manifest = JSON.stringify({ id: pin.id, path: project.skillRelative, sha256: pin.sha256, sourceSha256: pin.sourceSha256 })
      await writeFile(join(project.directory, approval), manifest, { flag: "wx" })
      project.config.plugins.push({ package: pathToFileURL(options.bundle).href,
        options: { enabled: true, ownerAgent: owner, investigationMode: "read-only", graphLoop: true,
          readOnlyEvidenceTools: [scopedTools("root").read], approvedProcedure: approval, approvedProcedureSha256: sha256(manifest) } })
      await writeFile(project.configPath, JSON.stringify(project.config))
      host = await startHost(options.binary, project.directory, project.settings)
    }
    const active = host
    await waitFor(async () => {
      const plugins = (await active.client.plugin.list({ location }, requestOptions())).data
      const preview = plugins.find(item => item.id === pluginId)
      pluginState = preview?.state.status ?? null
      if (pluginState === "failed" || (!installed && preview)) throw new Error("INSTALLED_TREATMENT_MISMATCH")
      const remotes = (await active.client.mcp.list({ location }, requestOptions())).data
      if ((!installed || pluginState === "active") && (!live || (live.ready(active.info.pid) &&
          plugins.some(item => item.id === nativeObserverID && item.state.status === "active"))) &&
          remotes.length === (audited ? 2 : 1) && remotes.every(item => item.status.status === "connected")) return true
    }, 12_000, "HOST_OR_OBSERVER_NOT_READY")
    const [credentials, catalog] = await Promise.all([
      live ? active.client.credential.list(requestOptions()) : Promise.resolve([]),
      active.client.model.list({ location, types: ["chat"] }, requestOptions()),
    ])
    const selected = catalog.data.find(row => row.enabled && row.providerID === model.providerID &&
      (row.id === model.id || row.modelID === model.id))
    if (!selected || (live && !credentials.some(row => row.active && row.integrationID === model.providerID &&
        row.value.type === "oauth"))) throw new Error(live ? "ISOLATED_OAUTH_MODEL_UNAVAILABLE" : "SCRIPTED_MODEL_UNAVAILABLE")
    effectiveContext = selected.limit
    if (selected.limit.context !== contextTokens || selected.limit.output !== caps.outputTokens)
      throw new Error("MODEL_CONTEXT_OR_OUTPUT_LIMIT_REFUSED")
    const root = await active.client.session.create({ location, model, agent: owner, title: "Dispatch reconciliation" }, requestOptions())
    rootID = root.id
    if (root.projectID !== workspace.id || root.agent !== owner || root.parentID ||
        root.model?.providerID !== model.providerID || root.model.id !== model.id) throw new Error("ROOT_IDENTITY_MISMATCH")
    live?.bindRoot(root.id)
    if (audited) {
      const child = await active.client.session.create({ location, model, parentID: root.id, agent: checkerAgent,
        title: "Independent focused review" }, requestOptions())
      checkerID = child.id
      const observed = await active.client.session.get({ sessionID: child.id }, requestOptions())
      if (observed.id !== child.id || child.id === root.id || observed.parentID !== root.id || observed.projectID !== root.projectID ||
          observed.agent !== checkerAgent || observed.model?.providerID !== model.providerID || observed.model.id !== model.id ||
          (await transcript(active.client, child.id)).length !== 0) throw new Error("CHECKER_IDENTITY_MISMATCH")
      live?.bindChecker(child.id)
    }
    ready = true
    await log({ event: "ready", rootID, checkerID, pluginState, skillSha256: pin.sha256, effectiveContext })

    async function turn(label: string, prompt: string, sessionID = root.id) {
      phase = label
      stage = label
      const text = phaseMarker(label) + "\n" + prompt
      const begin = performance.now()
      const promptId = await submitTurn(active, sessionID, text)
      const row: typeof turns[number] = { phase: label, promptId }
      turns.push(row)
      await log({ event: "turn-start", phase, promptId, promptSha256: sha256(text), promptUtf8Bytes: Buffer.byteLength(text) })
      const turn = await waitFor(() => {
        const failure = live?.failure()
        if (failure) throw new Error(failure)
        if (active.process.exited()) throw new Error("HOST_EXITED")
        return observeTurn(active, sessionID, promptId)
      }, Math.max(0, Math.min(native ? caps.armMs : 30_000, deadline - performance.now())), "TURN_DEADLINE")
      Object.assign(row, { assistantId: turn.id, answer: turn.text, elapsedMs: performance.now() - begin })
      await log({ event: "turn-end", phase, promptId, assistantId: turn.id, elapsedMs: row.elapsedMs })
      return turn
    }
    await turn("triage", fixture.triage + "\n\n" + bookkeeping)
    for (const [index, batch] of fixture.batches.entries()) await turn("batch-" + (index + 1), batch.prompt)
    bridgeReceiptStart = sources.receipts.length
    try { bridge = (await turn("bridge", fixture.bridge)).text }
    finally { bridgeReceiptStop = sources.receipts.length }
    let note = noAdvisory
    if (checkerID) {
      const check = await turn("checker", fixture.checkerPrompt, checkerID)
      const reads = observedReads(check.rows, "checker", sources.receipts)
      note = advisory(checkerAdvisory(check.text, reads))
    }
    final = (await turn("final", fixture.incident.input.prompt + "\n\n" + note)).text
    stage = "complete"
  } catch (error) {
    // Keep a typed error without endpoint, environment, response or path disclosure.
    const detail = error instanceof Error ? error.message : ""
    problem = live?.failure() ?? (/^[A-Z][A-Z0-9_]+$/.test(detail) ? detail :
      detail === "Host turn had no completed assistant response" || detail === "Host turn returned empty assistant text" ?
        "NO_FINAL_ASSISTANT_TEXT" : detail === "Host turn did not succeed" ? "HOST_TURN_FAILED" : "HOST_OPERATION_FAILED")
  } finally {
    if (host) {
      if (!host.process.exited()) {
        if (rootID) {
          try { rootRows = await transcript(host.client, rootID); rootTranscriptAvailable = true }
          catch { problem ??= "ROOT_TRANSCRIPT_UNAVAILABLE" }
        }
        if (checkerID) {
          try { checkerRows = await transcript(host.client, checkerID) }
          catch { problem ??= "CHECKER_TRANSCRIPT_UNAVAILABLE" }
        }
      }
      await host.process.kill().catch(() => { problem ??= "HOST_CLEANUP_FAILED" })
    }
    live?.stop()
    scripted?.stop()
    sources.stop()
  }
  const requests = live?.requests ?? scripted!.requests
  const outOfScopeRequests = requests.filter(row => row.kind === "ordinary").filter(row => {
    if (row.role !== "root" && row.role !== "checker") return true
    const expected = Object.values(scopedTools(row.role))
    return row.tools.some(name => !allowedTools[row.role as "root" | "checker"].includes(name)) ||
      expected.some(name => !row.tools.includes(name))
  }).map(row => row.id)
  const rootReads = observedReads(rootRows, "root", sources.receipts)
  const checkerReads = observedReads(checkerRows, "checker", sources.receipts)
  const graphReceipts = receiptsFor(rootRows, "record_finding").filter(row =>
    row.value.ok === true && row.value.runtimeSha256 === options.bundleSha256)
  const graphToolOffered = requests.some(row => row.role === "root" && row.tools.includes("alg_investigation"))
  const allowedExecutions = (rows: Transcript, role: "root" | "checker") => toolCalls(rows).every(call =>
    allowedTools[role].includes(call.name) &&
    !(role === "checker" && call.name === "skill" && call.state.status === "completed"))
  const identityAndScope = ready && rootTranscriptAvailable && !outOfScopeRequests.length && graphToolOffered === installed &&
    allowedExecutions(rootRows, "root") && allowedExecutions(checkerRows, "checker")
  const metrics = measureNaturalLong({ fixture, rows: rootRows, requests, inputs, receipts: sources.receipts,
    pin, bridge, runtimeSha256: options.bundleSha256,
    registryReadIdsDuringBridge: bridgeReceiptStart === null ? [] :
      sources.receipts.slice(bridgeReceiptStart, bridgeReceiptStop ?? undefined)
        .filter(row => row.scope === "root" && row.outcome === "read" && row.path === fixture.files.registry).map(row => row.id),
  })
  const accuracy = scoreNaturalLong(fixture, final, rootReads.map(row => row.path))
  const stagingAccuracy = fixture.batches.map((batch, i) => {
    const phase = "batch-" + (i + 1)
    const answer = turns.find(turn => turn.phase === phase)?.answer
    const value = answer ? parseObject(answer) : undefined
    return { phase, answered: answer !== undefined,
      correct: !!value && Object.keys(value).length === 1 && value.labelReviews === batch.answer.labelReviews }
  })
  const completed = stage === "complete" && !problem
  return { stage, completed, problem: problem ?? (identityAndScope ? null : "SESSION_OR_TOOL_SCOPE_UNQUALIFIED"),
    identityAndScope, rootTranscriptAvailable, outOfScopeRequests, effectiveContext,
    outcome: completed && identityAndScope ? "complete" : ready && identityAndScope ? "early-stop" : "apparatus-error",
    elapsedMs: performance.now() - started, turns, final, bridge, pluginState, graphToolOffered, graphReceipts,
    accuracy, stagingAccuracy, metrics, requests, rootReads, checkerReads, sourceCalls: sources.callsByScope(), evidence: sources.receipts }
}


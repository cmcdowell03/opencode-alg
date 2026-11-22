import { readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { fileDigest, runtimeIdentity, sha256 } from "../acceptance/runtime.ts"
import { compaction, contextTokens, naturalModelID, phaseMarker } from "./natural-long-cases.ts"
import { focusedSourceCallsPerRole, sourceCallCap } from "./discovery-tools.ts"
import { naturalLongOrder, naturalLongPromptProtocol, type runNaturalLongArm } from "./natural-long-host.ts"
import { checkerAdvisory } from "./natural-long-script.ts"
import { discoveryNativeLimits } from "./native-provider.ts"
import { turnRoutingCases } from "./turn-routing-cases.ts"
import { triageBookkeeping } from "./turn-routing-host.ts"

const priorFreezeDigest = "3d6517403f4160057f5c1c0659dd75309f7ef00c18aaecdfce38704c82bd715b"
const priorReportDigest = "24c8e75aaefeee2402f2fb06b390817a44537f9b74d3704792966fb5ef23f9fb"
export const nativeCaps = { ...discoveryNativeLimits, sourceCalls: sourceCallCap, sourceCallsPerRole: focusedSourceCallsPerRole }
const context = { configuredModelContextTokens: contextTokens, configuredOutputTokens: discoveryNativeLimits.outputTokens,
  compaction, manualCallsPlanned: 0, syntheticUsagePressure: false }

export const readJSON = async (path: string) => JSON.parse(await readFile(path, "utf8"))
export const sourceDigest = async (file: string) => sha256((await readFile(file, "utf8")).replace(/\r\n/g, "\n"))
type HistoricalArm = Awaited<ReturnType<typeof runNaturalLongArm>> & { trial: string; incident: string; arm: string }
const { advisoryNote, noAdvisory } = naturalLongPromptProtocol

export const promptIdentity = (phase: string, prompt: string) => {
  const text = phaseMarker(phase) + "\n" + prompt
  return { phase, sha256: sha256(text), utf8Bytes: Buffer.byteLength(text) }
}

export function promptSchedule(fixture: typeof turnRoutingCases[number]) {
  return [
    promptIdentity("triage", fixture.triage + "\n\n" + triageBookkeeping(fixture.id)),
    ...fixture.batches.map((batch, index) => promptIdentity("batch-" + (index + 1), batch.prompt)),
    promptIdentity("bridge", fixture.bridge), promptIdentity("final", fixture.incident.input.prompt),
  ]
}

export async function loadWillowControls(base: string, sourceDirectory: string, binary: string, version: string) {
  const directory = join(base, "natural-long-luna-4a108e6")
  const freezeFile = join(base, "natural-long-frozen-4a108e6.json")
  const reportFile = join(directory, "report.json")
  const privateDir = join(directory, "private")
  if (await fileDigest(freezeFile) !== priorFreezeDigest || await fileDigest(reportFile) !== priorReportDigest)
    throw new Error("Willow Yard prior freeze or terminal report hash mismatch")
  const freeze = await readJSON(freezeFile)
  const report = await readJSON(reportFile)
  const marker = await readJSON(freezeFile + ".started")
  const priorProtocol = await readJSON(join(privateDir, "protocol.json"))
  const willow = turnRoutingCases[0]
  const match = freeze.cases[0]
  const { host: _, ...historicalRuntime } = await runtimeIdentity(binary, join(base, "v2-isolated-hosts/ro-bundle-4a108e6"), version)
  if (freeze.mode !== "native-oauth" || freeze.model !== naturalModelID || !isDeepStrictEqual(freeze.runtime, historicalRuntime) ||
      !isDeepStrictEqual(freeze.caps, nativeCaps) || !isDeepStrictEqual(freeze.context, context) ||
      !isDeepStrictEqual(freeze.finalAdvisoryForm, naturalLongPromptProtocol) ||
      !isDeepStrictEqual(freeze, priorProtocol) || marker.freezeSha256 !== priorFreezeDigest ||
      marker.output !== "natural-long-luna-4a108e6" || report.freezeSha256 !== priorFreezeDigest ||
      report.runtimeUnchanged !== true || report.qualified !== true || match.id !== willow.id ||
      match.fixtureSha256 !== sha256(JSON.stringify(willow)) ||
      !isDeepStrictEqual(match.order, naturalLongOrder(0)) ||
      !isDeepStrictEqual(match.commonRootPromptSchedule, promptSchedule(willow)) ||
      match.checkerPromptSha256 !== promptIdentity("checker", willow.checkerPrompt).sha256)
    throw new Error("Frozen Willow Yard identity, caps, case schedule, or prior qualification differs")
  for (const [file, digest] of Object.entries(freeze.sourceSha256)) {
    // The host now has an opt-in adapter. The archived protocol pins the earlier implementation;
    // exact observed Willow prompts and treatment boundaries are checked independently below.
    if (file === "natural-long-host.ts") continue
    const path = file === "../package-lock.json"
      ? join(base, "v2-isolated-hosts/ro-qualify-windows-4a108e6/checkout/packages/v2-preview/package-lock.json")
      : resolve(sourceDirectory, file)
    if (await sourceDigest(path) !== digest)
      throw new Error("Frozen natural-long source changed: " + file)
  }
  for (const [file, digest] of Object.entries(report.artifactSha256)) {
    if (!/^[\w.-]+$/.test(file) || await fileDigest(join(privateDir, file)) !== digest)
      throw new Error("Prior terminal artifact hash differs: " + file)
  }

  const roster = await readJSON(join(privateDir, "roster.json"))
  const events = (await readFile(join(privateDir, "events.jsonl"), "utf8")).trimEnd().split(/\r?\n/).map(line => JSON.parse(line))
  const arms = ["build", "build-focused"].map(arm => "willow-yard-" + arm)
  const controls = await Promise.all(arms.map(async (trial): Promise<HistoricalArm> => {
    const saved: HistoricalArm = await readJSON(join(privateDir, trial + ".json"))
    const summary = report.arms.find((row: { trial: string }) => row.trial === trial)
    const checkerTurn = saved.turns.find(row => row.phase === "checker")
    const note = checkerTurn ? advisoryNote + "\n" + JSON.stringify(checkerAdvisory(checkerTurn.answer ?? "", saved.checkerReads)) : noAdvisory
    const common = promptSchedule(willow).slice(0, -1)
    const planned = [...common, ...(checkerTurn ? [promptIdentity("checker", willow.checkerPrompt)] : []),
      promptIdentity("final", willow.incident.input.prompt + "\n\n" + note)]
    const trialEvents = events.filter(row => row.trial === trial)
    const actual = trialEvents.filter(row => row.event === "turn-start")
      .map(row => ({ phase: row.phase, sha256: row.promptSha256, utf8Bytes: row.promptUtf8Bytes }))
    if (saved.trial !== trial || saved.incident !== willow.id || saved.outcome !== "complete" || !saved.final ||
        !saved.identityAndScope || saved.graphToolOffered || saved.problem !== null ||
        saved.effectiveContext?.context !== contextTokens || saved.effectiveContext.output !== discoveryNativeLimits.outputTokens ||
        saved.metrics.observedManualCompactions !== 0 || saved.metrics.classification !== "auto-applied" ||
        !saved.requests.length || saved.requests.length > discoveryNativeLimits.calls ||
        saved.metrics.usage.all.missingInputTokenRows !== 0 ||
        summary?.outcome !== "complete" || !summary.identityAndScope || !summary.finalObserved ||
        !roster.some((row: { trial: string; arm: string; incident: string }) =>
          row.trial === trial && row.arm === saved.arm && row.incident === willow.id) ||
        trialEvents.filter(row => row.event === "arm-start").length !== 1 ||
        trialEvents.filter(row => row.event === "arm-end" && row.outcome === "complete").length !== 1 ||
        trialEvents.filter(row => row.event === "turn-end").length !== planned.length ||
        !isDeepStrictEqual(actual, planned) || (saved.arm === "build-focused" ? !checkerTurn || !saved.checkerReads.length : !!checkerTurn))
      throw new Error("Willow control does not satisfy the frozen live protocol: " + trial)
    return saved
  }))
  return {
    identity: { freezeSha256: priorFreezeDigest, reportSha256: priorReportDigest,
      frozenHostSourceSha256: freeze.sourceSha256["natural-long-host.ts"], validatedHostMethod: "pinned prior protocol and exact terminal events; current host uses an explicit adapter",
      artifactSha256: Object.fromEntries(arms.map(trial => [trial, report.artifactSha256[trial + ".json"]])) },
    controls,
  }
}


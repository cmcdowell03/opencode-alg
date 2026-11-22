import { mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual, parseArgs } from "node:util"
import { hostVersion } from "../acceptance/host.ts"
import { fileDigest, runtimeIdentity, sha256 } from "../acceptance/runtime.ts"
import { compaction, contextTokens, naturalModelID } from "./natural-long-cases.ts"
import { naturalLongPromptProtocol } from "./natural-long-host.ts"
import { turnRoutingCases } from "./turn-routing-cases.ts"
import { routedArm, runTurnRoutingArm, turnRoutingOrder } from "./turn-routing-host.ts"
import { loadWillowControls, nativeCaps, promptIdentity, promptSchedule, readJSON, sourceDigest } from "./turn-routing-prior.ts"
import { maxProviderBytes, maxProviderCalls } from "./transport.ts"

const directory = dirname(fileURLToPath(import.meta.url))
const workspace = resolve(directory, "../../../..")
const pinnedBundleDigest = "a7037175ddf39e9d279629528b310dca88526c3a25157d1576ad1cd8d9f94b71"
const defaultBundle = resolve(workspace, "v2-isolated-hosts/ro-bundle-3c9188a")
const defaultHost = resolve(workspace, "v2-isolated-hosts/node_modules/@opencode/cli-windows-x64/bin/opencode.exe")
const sources = [
  "turn-routing-run.ts", "turn-routing-cases.ts", "turn-routing-host.ts", "turn-routing-script.ts", "turn-routing-metrics.ts",
  "turn-routing-prior.ts", "natural-long-host.ts", "natural-long-cases.ts", "natural-long-script.ts", "natural-long-metrics.ts",
  "compaction.ts", "discovery-grade.ts", "discovery-tools.ts", "discovery-protocol.ts", "host.ts", "input-usage.ts",
  "native-observer.ts", "native-provider.ts", "skill-delivery.ts", "transport.ts", "../acceptance/host.ts",
  "../acceptance/runtime.ts", "../acceptance/service.ts", "../package-lock.json",
]
const roster = turnRoutingCases.flatMap((fixture, i) => turnRoutingOrder(i)
  .filter(arm => i !== 0 || arm === routedArm).map(arm => ({ trial: fixture.id + "-" + arm, incident: fixture.id, arm })))
const modeOptions = {
  qualify: { type: "string" }, freeze: { type: "string" }, qualification: { type: "string" },
  frozen: { type: "string" }, out: { type: "string" }, host: { type: "string" }, package: { type: "string" },
  "allow-model-calls": { type: "boolean" }, "auth-file": { type: "string" },
} as const

async function persist(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600)
  try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync() }
  finally { await file.close() }
}

type ArmResult = Awaited<ReturnType<typeof runTurnRoutingArm>>
type History = Awaited<ReturnType<typeof loadWillowControls>>["controls"][number]

function summary(row: ArmResult | History) {
  const routing = "routing" in row ? row.routing : null
  const { accuracy, metrics, stagingAccuracy } = row
  const routeObservation = routing ? {
    ...routing, wire: undefined,
    attribution: "Tool calls and wire fields describe observed behavior. The native trace alone cannot attribute outcome differences to model choice versus routing.",
  } : null
  return { outcome: row.outcome, stage: row.stage, problem: row.problem, identityAndScope: row.identityAndScope, elapsedMs: row.elapsedMs,
    observedModelContext: row.effectiveContext, finalObserved: row.final !== null, accuracy: row.outcome === "complete" && accuracy.correct,
    strictFormat: accuracy.strictFormat, disposition: accuracy.disposition, closureAsserted: accuracy.closureAsserted,
    unsupportedClosure: accuracy.disposition === null ? null : accuracy.unsupportedClosure,
    staging: { answered: stagingAccuracy.filter(item => item.answered).length,
      correct: stagingAccuracy.filter(item => item.correct).length, planned: stagingAccuracy.length },
    bridge: metrics.bridge, routing: routeObservation, checkerVerifiedReads: row.checkerReads.length,
    recordFindingReceipts: row.graphReceipts.length,
    duplicateReads: metrics.repetition.sameRoleDuplicateReads, sourceCalls: row.sourceCalls,
    sourceReadCounts: { root: metrics.repetition.rootReads, checker: metrics.repetition.checkerReads },
    boundary: row.rootTranscriptAvailable ? metrics.classification : "transcript-unavailable",
    automaticCompleted: metrics.automaticCompleted, manual: metrics.observedManualCompactions,
    automaticAppliedCount: metrics.boundaries.filter(item => item.reason === "auto" && item.subsequentRootRequestIds.length > 0).length,
    usage: metrics.usage,
  }
}

function scriptedChecks(row: ArmResult, installed: boolean) {
  const { metrics, routing } = row
  return {
    apparatus: row.outcome === "complete" && row.identityAndScope,
    finalAccuracy: row.accuracy.correct && !row.accuracy.unsupportedClosure,
    staging: row.stagingAccuracy.length === 6 && row.stagingAccuracy.every(item => item.correct),
    automaticBoundary: metrics.classification === "auto-applied" && metrics.observedManualCompactions === 0 && metrics.bridge.afterObservedAuto,
    bridge: metrics.bridge.correctMethodCode && metrics.bridge.correctEarlyCalibrationSeal && metrics.bridge.correctConversion,
    noPaidUsage: metrics.usage.all.observedInputTokenRows === 0,
    ...(installed && {
      attestedGraphRecall: routing.supportedCalibrationWrites > 0 &&
        routing.findingLookups.some(row => row.discoveredInBridge && row.calibratedInterpretation && row.sourceBound) &&
        metrics.bridge.freshRegistryReadsDuringBridge === 0,
      lookupOnly: routing.bridgeVerifiedProcedureReceipts > 0 && routing.lookupGraphRequests === 0,
      activeAndPassive: routing.triageGraphRequests > 0 && routing.stagingRequestCount >= 6 &&
        routing.stagingGraphRequests === 0 && routing.stagingProcedureProjectionRequests === 0 && routing.stagingWorkSchemaRequests === 0,
    }),
  }
}

async function execute(options: { output: string; frozenPath?: string; protocol: object; binary: string; bundle: string;
  runtime: Omit<Awaited<ReturnType<typeof runtimeIdentity>>, "host">; authPath?: string; scratch: string; controls: History[] }) {
  const live = options.frozenPath !== undefined
  const output = resolve(options.output)
  await mkdir(output, { mode: 0o700 })
  const privateDir = join(await realpath(output), "private")
  await mkdir(privateDir, { mode: 0o700 })
  await persist(join(privateDir, "protocol.json"), options.protocol)
  await persist(join(privateDir, "roster.json"), roster)
  const freezeSha256 = options.frozenPath ? await fileDigest(options.frozenPath) : null
  if (options.frozenPath)
    await persist(options.frozenPath + ".started", { freezeSha256, output, reservedAt: new Date().toISOString() })
  const artifacts = ["protocol.json", "roster.json", "events.jsonl"]
  const journal = await open(join(privateDir, "events.jsonl"), "wx", 0o600)
  const log = async (fields: Record<string, unknown>) => {
    await journal.appendFile(JSON.stringify({ ...fields, at: new Date().toISOString() }) + "\n")
    await journal.sync()
  }
  const arms = []
  await log({ event: "run-start", live, assigned: roster.length, freezeSha256 })
  try {
    for (const trial of roster) {
      const { arm, incident } = trial
      const fixture = turnRoutingCases.find(row => row.id === incident)!
      const began = performance.now()
      await log({ ...trial, event: "arm-start" })
      let row: ReturnType<typeof summary> | { outcome: "apparatus-error"; problem: string; elapsedMs: number }
      let checks: ReturnType<typeof scriptedChecks> | null = null
      const filename = trial.trial + ".json"
      let receipt: Record<string, unknown>
      try {
        const result = await runTurnRoutingArm({ binary: options.binary, bundle: options.bundle,
          bundleSha256: options.runtime.bundleSha256, scratch: join(options.scratch, trial.trial), fixture, arm,
          ...(live && { native: { authPath: options.authPath } }), log: event => log({ ...event, ...trial }) })
        row = summary(result)
        checks = live ? null : scriptedChecks(result, arm === routedArm)
        receipt = { ...trial, ...result, scriptedChecks: checks }
      } catch (error) {
        const message = error instanceof Error ? error.message : ""
        row = { outcome: "apparatus-error", problem: /^[A-Z][A-Z0-9_]+$/.test(message) ? message : "ARM_HARNESS_FAILED",
          elapsedMs: performance.now() - began }
        receipt = { ...trial, ...row }
      }
      await persist(join(privateDir, filename), receipt)
      artifacts.push(filename)
      const counted = { ...trial, ...row, scriptedChecks: checks, artifactSha256: await fileDigest(join(privateDir, filename)) }
      arms.push(counted)
      await log({ ...counted, event: "arm-end" })
      console.log(JSON.stringify({ ...trial, outcome: row.outcome, problem: row.problem, scriptedChecks: checks }))
    }
    await log({ event: "run-end", attempted: arms.length })
  } finally {
    await journal.close()
  }
  const qualificationPassed = live ? null : arms.every(row =>
    row.scriptedChecks !== null && Object.values(row.scriptedChecks).every(value => value === true))
  const historicalControls = live ? options.controls.map(row =>
    ({ trial: row.trial, incident: row.incident, arm: row.arm, historical: true, ...summary(row) })) : []
  const { host: _, ...after } = await runtimeIdentity(options.binary, options.bundle, options.runtime.version)
  const report = { mode: live ? "native-oauth" : "local-scripted", freezeSha256,
    assigned: roster.length, attempted: arms.length, historicalControls, arms, qualificationPassed,
    runtimeUnchanged: isDeepStrictEqual(after, options.runtime),
    artifactSha256: Object.fromEntries(await Promise.all(artifacts.map(async file => [file, await fileDigest(join(privateDir, file))]))),
  }
  await persist(join(output, "report.json"), report)
  console.log(JSON.stringify({ event: "terminal-report", output: basename(output), assigned: roster.length, attempted: arms.length,
    completed: arms.filter(row => row.outcome === "complete").length, qualificationPassed, runtimeUnchanged: report.runtimeUnchanged }))
  if (!report.runtimeUnchanged || qualificationPassed === false || arms.some(row => row.outcome === "apparatus-error"))
    process.exitCode = 1
}

export async function runTurnRoutingCLI(args: string[]) {
  const { values } = parseArgs({ args, options: modeOptions })
  const live = values["allow-model-calls"] === true
  const { qualify, freeze, qualification, frozen, out } = values
  if (Number(!!qualify) + Number(!!freeze) + Number(!!frozen) !== 1 || live !== !!frozen ||
      !!out !== live || !!qualification !== !!freeze || (!live && values["auth-file"]))
    throw new Error("Use --qualify NEW_DIR, --freeze NEW_FILE --qualification REPORT, or --frozen FILE --allow-model-calls --out NEW_DIR after GO")
  const binary = await realpath(values.host ?? defaultHost)
  const bundle = await realpath(values.package ?? defaultBundle)
  const temp = await realpath(tmpdir())
  const scratch = await mkdtemp(join(temp, "alg-turn-routing-"))
  try {
    const version = await hostVersion(binary, join(scratch, "version"))
    const { host: _, ...runtime } = await runtimeIdentity(binary, bundle, version)
    if (!qualify && runtime.bundleSha256 !== pinnedBundleDigest) throw new Error("Candidate bundle does not match the supplied PR17 runtime")
    const prior = qualify ? undefined : await loadWillowControls(workspace, directory, binary, version)
    const common = {
      schema: "turn-routing-natural-long-v1", runtime, roster,
      caps: nativeCaps, model: naturalModelID,
      context: { inputLimit: contextTokens, outputLimit: nativeCaps.outputTokens, compaction, manualCallsPlanned: 0 },
      cases: turnRoutingCases.map((fixture, index) => ({
        id: fixture.id, fixtureSha256: sha256(JSON.stringify(fixture)), order: turnRoutingOrder(index),
        commonRootPromptSchedule: promptSchedule(fixture),
        checkerPromptSha256: promptIdentity("checker", fixture.checkerPrompt).sha256,
      })),
      finalAdvisoryForm: naturalLongPromptProtocol,
      scoring: { incident: "Deterministic natural-long strict JSON and cited-source grade, provisional for open-ended claims",
        denominator: "All assigned arms; early stops fail accuracy; unobserved closure remains null",
        usage: "Native provider input tokens including cache; peak is observed maximum; missing rows remain visible",
        attribution: "Paired within each held-out incident; Willow controls are historical, and model decisions can mediate treatment effects",
      },
      sourceSha256: Object.fromEntries(await Promise.all(sources.map(async file =>
        [file, await sourceDigest(join(directory, file))]))),
    }
    const localProtocol = { ...common, mode: "local-scripted", model: "paired-benchmark/fixture",
      caps: { calls: maxProviderCalls, requestBytes: maxProviderBytes, armMs: 100_000, turnMs: 30_000,
        sourceCalls: nativeCaps.sourceCalls, sourceCallsPerRole: nativeCaps.sourceCallsPerRole },
      syntheticUsagePressure: true }
    const nativeProtocol = { ...common, prior: prior?.identity, mode: "native-oauth", syntheticUsagePressure: false }
    if (qualify) {
      await execute({ output: qualify, protocol: localProtocol, binary, bundle, runtime,
        scratch, controls: [] })
    } else if (freeze && qualification) {
      const qualified = await readJSON(qualification)
      const privateDir = join(dirname(resolve(qualification)), "private")
      const local = await readJSON(join(privateDir, "protocol.json"))
      if (!isDeepStrictEqual(local, localProtocol) || qualified.qualificationPassed !== true ||
          qualified.runtimeUnchanged !== true || qualified.attempted !== roster.length ||
          !isDeepStrictEqual(qualified.arms.map(({ trial, incident, arm }: typeof roster[number]) => ({ trial, incident, arm })), roster))
        throw new Error("Local qualification did not pass on this exact protocol and runtime")
      for (const [file, digest] of Object.entries(qualified.artifactSha256)) {
        if (!/^[\w.-]+$/.test(file) || await fileDigest(join(privateDir, file)) !== digest)
          throw new Error("Qualification artifact hash mismatch: " + file)
      }
      const qualifiedReceipt = { reportSha256: await fileDigest(qualification), protocolSha256: await fileDigest(join(privateDir, "protocol.json")) }
      await persist(resolve(freeze), { ...nativeProtocol, qualifiedReceipt })
      console.log(JSON.stringify({ event: "frozen", sha256: await fileDigest(resolve(freeze)), assigned: roster.length, qualifiedReceipt }))
    } else if (frozen && out) {
      const frozenPath = await realpath(frozen)
      const { qualifiedReceipt, ...sealed } = JSON.parse(await readFile(frozenPath, "utf8"))
      if (!/^[a-f0-9]{64}$/.test(qualifiedReceipt?.reportSha256 ?? "") ||
          !/^[a-f0-9]{64}$/.test(qualifiedReceipt?.protocolSha256 ?? "") || !isDeepStrictEqual(sealed, nativeProtocol))
        throw new Error("Frozen runtime, protocol or qualification identity differs")
      await execute({ output: out, frozenPath, protocol: { ...nativeProtocol, qualifiedReceipt }, binary, bundle,
        runtime, authPath: values["auth-file"], scratch, controls: prior!.controls })
    }
  } finally {
    // The resolved scratch is a directory just allocated under OS temp for this invocation.
    if (dirname(await realpath(scratch)) !== temp || !basename(scratch).startsWith("alg-turn-routing-"))
      throw new Error("Unexpected benchmark scratch directory")
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

if (import.meta.main) await runTurnRoutingCLI(process.argv.slice(2))


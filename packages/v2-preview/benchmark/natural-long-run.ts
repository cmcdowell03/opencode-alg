import { mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { hostVersion } from "../acceptance/host.ts"
import { fileDigest, runtimeIdentity, sha256 } from "../acceptance/runtime.ts"
import { buildPreview } from "../build.ts"
import { compaction, contextTokens, naturalLongCases, naturalModelID, phaseMarker } from "./natural-long-cases.ts"
import { naturalLongOrder, naturalLongPromptProtocol, runNaturalLongArm } from "./natural-long-host.ts"
import { focusedSourceCallsPerRole, sourceCallCap } from "./discovery-tools.ts"
import { discoveryNativeLimits } from "./native-provider.ts"
import { maxProviderBytes, maxProviderCalls } from "./transport.ts"

const directory = dirname(fileURLToPath(import.meta.url))
const defaultWinHost = resolve(directory, "../../../../v2-isolated-hosts/node_modules/@opencode/cli-windows-x64/bin/opencode.exe")
const sourceFiles = [
  "natural-long-run.ts", "natural-long-cases.ts", "natural-long-host.ts", "natural-long-metrics.ts", "natural-long-script.ts",
  "compaction.ts", "discovery-grade.ts", "discovery-tools.ts", "discovery-protocol.ts", "host.ts", "input-usage.ts",
  "native-observer.ts", "native-provider.ts", "skill-delivery.ts", "transport.ts", "../acceptance/host.ts", "../acceptance/runtime.ts",
  "../acceptance/service.ts", "../package-lock.json",
]
const usage = [
  "Scripted local qualification: --out NEW_DIR [--host BINARY] [--package STAGED_PREVIEW]",
  "Prepaid protocol freeze: --freeze NEW_JSON --host BINARY --package STAGED_PREVIEW",
  "After installed Windows/Linux qualification and orchestrator release: --frozen FROZEN_JSON --allow-model-calls --out NEW_DIR --host BINARY --package STAGED_PREVIEW [--auth-file PATH]",
].join("\n")
const flagsWithValue = new Set(["--host", "--package", "--out", "--freeze", "--frozen", "--auth-file"])

function parseArgs(args: string[]) {
  const values = new Map<string, string>()
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!
    const value = key === "--allow-model-calls" ? "true" : args[++i]
    if (values.has(key) || (!flagsWithValue.has(key) && key !== "--allow-model-calls") || !value || value.startsWith("--"))
      throw new Error(usage)
    values.set(key, value)
  }
  const freeze = values.get("--freeze"), frozen = values.get("--frozen"), out = values.get("--out")
  const binary = values.get("--host"), bundle = values.get("--package"), authPath = values.get("--auth-file")
  const native = values.has("--allow-model-calls")
  if (Boolean(freeze) === Boolean(out) || (Boolean(frozen) !== native) ||
      (freeze && (frozen || native || authPath)) || (authPath && !native) ||
      ((native || freeze) && (!binary || !bundle))) throw new Error(usage)
  return { freeze, frozen, out, binary, bundle, authPath, native }
}

async function persist(path: string, value: unknown) {
  const file = await open(path, "wx", 0o600)
  try {
    await file.writeFile(JSON.stringify(value, null, 2) + "\n")
    await file.sync()
  } finally { await file.close() }
}

async function protocol(binary: string, bundle: string, version: string, native: boolean) {
  const { host: _, ...runtime } = await runtimeIdentity(binary, bundle, version)
  const cases = naturalLongCases()
  return {
    schema: "natural-long-trio-v1",
    mode: native ? "native-oauth" : "local-scripted",
    model: native ? naturalModelID : "paired-benchmark/fixture",
    runtime,
    context: { configuredModelContextTokens: contextTokens,
      configuredOutputTokens: discoveryNativeLimits.outputTokens,
      compaction, manualCallsPlanned: 0, syntheticUsagePressure: !native },
    caps: { ...(native ? discoveryNativeLimits : { calls: maxProviderCalls, requestBytes: maxProviderBytes,
      armMs: 100_000, turnMs: 30_000 }), sourceCalls: sourceCallCap, sourceCallsPerRole: focusedSourceCallsPerRole },
    cases: cases.map((fixture, index) => ({
      id: fixture.id, fixtureSha256: sha256(JSON.stringify(fixture)), order: naturalLongOrder(index),
      commonRootPromptSchedule: [
        ["triage", fixture.triage + "\n\n" + naturalLongPromptProtocol.bookkeeping],
        ...fixture.batches.map((batch, i) => ["batch-" + (i + 1), batch.prompt]),
        ["bridge", fixture.bridge], ["final", fixture.incident.input.prompt],
      ].map(([phase, prompt]) => {
        const body = phaseMarker(phase!) + "\n" + prompt
        return { phase, sha256: sha256(body), utf8Bytes: Buffer.byteLength(body) }
      }),
      checkerPromptSha256: sha256(phaseMarker("checker") + "\n" + fixture.checkerPrompt),
    })),
    finalAdvisoryForm: naturalLongPromptProtocol,
    scoring: { primary: ["accuracy", "unsupportedClosure"], denominator: "all assigned arms, including early stops",
      missingFinalTreatment: "failed accuracy; closure unobserved", scopeComparison: "paired within incident",
      peakInputUnits: "native response input_tokens including cached input; observed maxima only",
      peakWireUnits: "UTF-8 HTTP request body bytes; includes provider schema",
      syntheticProviderTokenReceipts: "not measured", noAutoTreatment: "report independently; retain arm" },
    sourceDigestMode: "utf8-lf-v1",
    sourceSha256: Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
      [file, sha256((await readFile(resolve(directory, file), "utf8")).replace(/\r\n/g, "\n"))]))),
  }
}

type ArmResult = Awaited<ReturnType<typeof runNaturalLongArm>>
type SummaryArm = {
  trial: string; incident: string; arm: string; attempted: boolean
  outcome: string; problem: string | null; identityAndScope: boolean
  accuracy: boolean; closureAsserted: boolean; unsupportedClosure: boolean; finalObserved: boolean
  disposition: "resolved" | "indeterminate" | null; staging: { answered: number; correct: number; planned: number } | null
  bridge: ArmResult["metrics"]["bridge"] | null; scriptedQualification: boolean | null
  checkerVerifiedReads: number; graphCalibrationReadbackAfterAuto: boolean
  elapsedMs: number; boundary: string; allUsage: ArmResult["metrics"]["usage"]["all"] | null
}

export async function runNaturalLongCLI(args: string[]) {
  const options = parseArgs(args)
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "opencode-natural-long-"))
  try {
    const binaryPath = options.binary ?? (process.platform === "win32"
      ? await realpath(defaultWinHost).catch(() => undefined) : undefined) ?? Bun.which("opencode")
    if (!binaryPath) throw new Error("Provide --host with the native OpenCode 2.3.2 executable")
    const binary = await realpath(binaryPath)
    const bundle = options.bundle ? await realpath(options.bundle) : join(scratch, "preview")
    if (!options.bundle) await buildPreview(bundle)
    const version = await hostVersion(binary, join(scratch, "version"))
    const frozenProtocol = await protocol(binary, bundle, version, Boolean(options.freeze || options.native))
    if (options.freeze) {
      await persist(resolve(options.freeze), frozenProtocol)
      console.log(JSON.stringify({ status: "frozen", sha256: await fileDigest(resolve(options.freeze)),
        cases: frozenProtocol.cases.map(row => row.id), assigned: frozenProtocol.cases.length * 3 }))
      return
    }
    const freezePath = options.frozen ? await realpath(options.frozen) : null
    if (freezePath && !isDeepStrictEqual(frozenProtocol, JSON.parse(await readFile(freezePath, "utf8"))))
      throw new Error("Frozen natural long-session protocol or runtime does not match")
    const output = resolve(options.out!)
    await mkdir(output, { mode: 0o700 })
    const privateDir = join(await realpath(output), "private")
    await mkdir(privateDir, { mode: 0o700 })
    const cases = naturalLongCases()
    const roster = frozenProtocol.cases.flatMap(({ id, order }, index) =>
      order.map(arm => ({ trial: id + "-" + arm, incident: id, arm, fixture: cases[index]! })))
    await persist(join(privateDir, "protocol.json"), frozenProtocol)
    const freezeSha256 = freezePath ? await fileDigest(freezePath) : null
    await persist(join(privateDir, "roster.json"), roster.map(({ fixture: _, ...trial }) => trial))
    if (freezePath) {
      // Reserve the sole live invocation before credential staging or model activity.
      await persist(freezePath + ".started", { freezeSha256, startedAt: new Date().toISOString(), output: basename(output) })
    }
    const journal = await open(join(privateDir, "events.jsonl"), "wx", 0o600)
    const arms: SummaryArm[] = []
    const summaryPaths = ["protocol.json", "roster.json", "events.jsonl"]
    const started = performance.now()
    try {
      for (const { fixture, ...trial } of roster) {
        const log = async (event: Record<string, unknown>) => {
          await journal.appendFile(JSON.stringify({ ...trial, ...event, at: new Date().toISOString() }) + "\n")
          await journal.sync()
        }
        await log({ event: "arm-start" })
        const armStarted = performance.now()
        try {
          const result = await runNaturalLongArm({ binary, bundle, bundleSha256: frozenProtocol.runtime.bundleSha256,
            scratch: join(scratch, trial.trial), fixture, arm: trial.arm,
            ...(options.native && { native: { authPath: options.authPath } }), log })
          const artifact = trial.trial + ".json"
          await persist(join(privateDir, artifact), { ...trial, ...result })
          summaryPaths.push(artifact)
          const graphCalibrationReadbackAfterAuto = result.metrics.postBoundaryInputs
            .some(row => row.phase === "bridge" && row.factInGraph)
          arms.push({ ...trial, attempted: true, outcome: result.outcome, problem: result.problem,
            identityAndScope: result.identityAndScope, accuracy: result.outcome === "complete" && result.accuracy.correct,
            closureAsserted: result.accuracy.closureAsserted, unsupportedClosure: result.accuracy.unsupportedClosure,
            disposition: result.accuracy.disposition,
            staging: { answered: result.stagingAccuracy.filter(stage => stage.answered).length,
              correct: result.stagingAccuracy.filter(stage => stage.correct).length, planned: fixture.batches.length },
            bridge: result.metrics.bridge,
            checkerVerifiedReads: result.checkerReads.length, graphCalibrationReadbackAfterAuto,
            scriptedQualification: options.native ? null : result.outcome === "complete" && result.accuracy.correct &&
              result.stagingAccuracy.every(stage => stage.correct) && result.metrics.bridge.afterObservedAuto &&
              result.metrics.bridge.correctMethodCode && result.metrics.bridge.correctEarlyCalibrationSeal &&
              result.metrics.bridge.correctConversion && (trial.arm === "build" || result.checkerReads.length > 0) &&
              (trial.arm !== "alg-graph-focused" || (result.graphReceipts.length > 0 && graphCalibrationReadbackAfterAuto)),
            finalObserved: result.final !== null, elapsedMs: result.elapsedMs,
            boundary: result.rootTranscriptAvailable ? result.metrics.classification : "transcript-unavailable", allUsage: result.metrics.usage.all })
        } catch {
          arms.push({ ...trial, attempted: true, outcome: "apparatus-error", problem: "ARM_HARNESS_FAILED",
            identityAndScope: false, accuracy: false, closureAsserted: false, unsupportedClosure: false, finalObserved: false,
            disposition: null, staging: null, bridge: null, scriptedQualification: options.native ? null : false,
            checkerVerifiedReads: 0, graphCalibrationReadbackAfterAuto: false,
            boundary: "transcript-unavailable", elapsedMs: performance.now() - armStarted, allUsage: null })
        }
        const summary = arms.at(-1)!
        await log({ event: "arm-end", ...summary })
        console.log(JSON.stringify({ event: "arm-end", ...summary }))
      }
    } finally { await journal.close() }
    const artifactSha256 = Object.fromEntries(await Promise.all(summaryPaths.map(async file =>
      [file, await fileDigest(join(privateDir, file))])))
    const { host: _, ...after } = await runtimeIdentity(binary, bundle, version)
    const runtimeUnchanged = isDeepStrictEqual(frozenProtocol.runtime, after)
    const tally = (rows: SummaryArm[]) => ({
      attempted: rows.length,
      completed: rows.filter(arm => arm.outcome === "complete").length,
      earlyStops: rows.filter(arm => arm.outcome === "early-stop").length,
      apparatusErrors: rows.filter(arm => arm.outcome === "apparatus-error").length,
      finalObserved: rows.filter(arm => arm.finalObserved).length,
      closureUnscorable: rows.filter(arm => arm.disposition == null).length,
      accuracyPasses: rows.filter(arm => arm.accuracy).length,
      resolvedAssertions: rows.filter(arm => arm.closureAsserted).length,
      unsupportedClosures: rows.filter(arm => arm.unsupportedClosure).length,
      autoApplied: rows.filter(arm => arm.boundary === "auto-applied").length,
      allUsageCovered: rows.filter(arm => arm.allUsage && arm.allUsage.calls > 0 && arm.allUsage.missingInputTokenRows === 0).length,
    })
    const totals = { assigned: roster.length, ...tally(arms) }
    const byArm = Object.fromEntries(naturalLongOrder(0).map(label =>
      [label, tally(arms.filter(arm => arm.arm === label))]))
    const qualified = runtimeUnchanged && totals.assigned === totals.attempted &&
      arms.every(arm => arm.identityAndScope && (options.native || arm.scriptedQualification))
    const report = { mode: frozenProtocol.mode, freezeSha256, runtimeUnchanged, qualified, elapsedMs: performance.now() - started,
      totals, byArm, arms, artifactSha256 }
    await persist(join(output, "report.json"), report)
    console.log(JSON.stringify({ mode: report.mode, output: basename(output), qualified, ...totals }))
    if (!qualified) process.exitCode = 1
  } finally {
    // Only the per-run private OS temporary directory is removed, including any staged access credential.
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--help") console.log(usage)
  else await runNaturalLongCLI(args)
}


import assert from "node:assert/strict"
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { hostVersion } from "../acceptance/host.ts"
import { fileDigest, runtimeIdentity, sha256 } from "../acceptance/runtime.ts"
import { compaction, contextTokens, naturalModelID } from "./natural-long-cases.ts"
import { runNaturalLongArm } from "./natural-long-host.ts"
import { nativeCaps, promptIdentity, sourceDigest } from "./turn-routing-prior.ts"
import { fixtureProject, routedArm } from "./turn-routing-host.ts"
import { synthesisPairCases, synthesisPairChange, synthesisPairChangeNotice } from "./synthesis-pair-cases.ts"
import { synthesisPairScript } from "./synthesis-pair-script.ts"
import { measureSynthesisPairTrace, type SynthesisPairTrace } from "./synthesis-pair-trace.ts"

type Stage = "primary" | "conditional"
const bundleHash = "d4bd87f20fcd1aebbb26b3484fb86dc21176686e2ad3611ed5795119c659f4a6"
const hostHash = "5d52d86e2c3fd2c4d51cefc893f64c9ee66bc2e9535332195802f7c646b2a3a3"
const controls = ["build-focused", routedArm] as const
const fixtureFor = (stage: Stage) => synthesisPairCases[stage === "primary" ? 0 : 1]
const serialize = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const load = async (path: string) => JSON.parse(await readFile(path, "utf8"))
const save = (path: string, value: unknown) => writeFile(path, serialize(value), { flag: "wx", mode: 0o600 })
const sourceFiles = [
  "synthesis-pair-run.ts", "synthesis-pair-cases.ts", "synthesis-pair-script.ts", "synthesis-pair-review.ts", "synthesis-pair-trace.ts",
  "synthesis-pair-protocol.md", "turn-routing-review.ts", "turn-routing-review.md", "turn-routing-host.ts", "turn-routing-prior.ts", "natural-long-host.ts", "natural-long-cases.ts",
  "natural-long-script.ts", "natural-long-metrics.ts", "discovery-grade.ts", "discovery-cases.ts", "discovery-protocol.ts",
  "discovery-tools.ts", "compaction.ts", "host.ts", "input-usage.ts", "skill-delivery.ts", "native-observer.ts", "native-provider.ts",
  "transport.ts", "../acceptance/runtime.ts", "../acceptance/host.ts", "../acceptance/service.ts", "../package-lock.json",
]

function trialProtocol(stage: Stage, runtime: Omit<Awaited<ReturnType<typeof runtimeIdentity>>, "host">, sourceSha256: Record<string, string>) {
  const fixture = fixtureFor(stage)
  const arms = stage === "primary" ? controls : [...controls].reverse()
  return {
    schema: "synthesis-pair-v1", mode: "native-oauth", model: naturalModelID, runtime, caps: nativeCaps,
    context: { tokens: contextTokens, compaction, manualBoundaries: 0 }, syntheticUsagePressure: false,
    cases: [{ id: fixture.id, fixtureSha256: sha256(JSON.stringify(fixture)) }],
    roster: arms.map(arm => ({ trial: fixture.id + "-" + arm, incident: fixture.id, arm })),
    promptHashes: [promptIdentity("triage", fixture.triage + "\n\n"),
      ...fixture.batches.map((batch, i) => promptIdentity("batch-" + (i + 1), batch.prompt)),
      promptIdentity("bridge", fixture.bridge), promptIdentity("checker", checkerText(stage)),
      promptIdentity("final", finalText(stage))],
    finalAdvisory: "Append independent checker text capped at 4000 characters and its verified read paths using natural-long-host.",
    sourceChange: stage === "primary" ? null : { phase: "after-bridge", path: synthesisPairChange.path,
      beforeSha256: sha256(synthesisPairChange.before), afterSha256: sha256(synthesisPairChange.after), notice: synthesisPairChangeNotice },
    decisionRule: "Count both assigned arms; missing finals fail. Score supported material findings, disposition, missing evidence and exact row citations blind before inspecting traces. Open the second pair only if routed ALG completes the primary with a passing blinded incident grade and correct bridge units, seal and method.",
    sourceSha256,
  }
}

function checkerText(stage: Stage) {
  return (stage === "conditional" ? synthesisPairChangeNotice + "\n\n" : "") + fixtureFor(stage).checkerPrompt
}
function finalText(stage: Stage) {
  return (stage === "conditional" ? synthesisPairChangeNotice + "\n\n" : "") + fixtureFor(stage).incident.input.prompt
}

type Plan = ReturnType<typeof trialProtocol>
async function runPair(stage: Stage, plan: Plan, binary: string, bundle: string, scratch: string, dir: string,
  native?: { freeze: string; authPath?: string }) {
  const output = join(dir, native ? stage + "-live" : stage + "-local")
  await mkdir(output)
  const priv = join(output, "private")
  await mkdir(priv, { mode: 0o700 })
  const protocol = native ? await load(native.freeze) : { ...plan, mode: "local-scripted", syntheticUsagePressure: true }
  await save(join(priv, "protocol.json"), protocol)
  await save(join(priv, "roster.json"), plan.roster)
  const files = ["protocol.json", "roster.json", "events.jsonl"]
  const events = await open(join(priv, "events.jsonl"), "wx", 0o600)
  const log = async (event: object) => {
    await events.appendFile(JSON.stringify({ ...event, at: new Date().toISOString() }) + "\n")
    await events.sync()
  }
  const arms = []
  const fixture = fixtureFor(stage)
  const frozen = native ? await fileDigest(native.freeze) : null
  try {
    await log({ event: "run-start", freezeSha256: frozen, assigned: plan.roster.length })
    for (const trial of plan.roster) {
      const installed = trial.arm === routedArm
      await log({ event: "arm-start", ...trial })
      let receipt
      try {
        let trace: SynthesisPairTrace | undefined
        const result = await runNaturalLongArm({ binary, bundle, bundleSha256: plan.runtime.bundleSha256,
          fixture: { ...fixture, checkerPrompt: checkerText(stage), incident: { ...fixture.incident,
            input: { ...fixture.incident.input, prompt: finalText(stage) } } },
          arm: installed ? "alg-graph-focused" : "build-focused", scratch: join(scratch, trial.trial),
          native: native && { authPath: native.authPath }, log: row => log({ ...row, ...trial }),
          adapter: { fixtureProject, scripted: synthesisPairScript, triageBookkeeping: "",
            ...(installed && { turnRouting: "routed-compact" }),
            ...(stage === "conditional" && { afterBridgeReplacement: synthesisPairChange }),
            observe: data => { trace = measureSynthesisPairTrace({ ...data, fixture, bundleSha256: plan.runtime.bundleSha256 }) } },
        })
        assert.ok(trace, "Missing observed trace")
        receipt = { ...trial, ...result, trace }
      } catch (error) {
        const message = error instanceof Error ? error.message : ""
        receipt = { ...trial, outcome: "apparatus-error" as const, problem: /^[A-Z_]+$/.test(message) ? message : "HARNESS_FAILED" }
      }
      const filename = trial.trial + ".json"
      files.push(filename)
      await save(join(priv, filename), receipt)
      const scored = "accuracy" in receipt && receipt.outcome === "complete" && receipt.accuracy.correct
      const bridge = "metrics" in receipt && receipt.metrics.bridge
      const recall = !!bridge && bridge.correctMethodCode && bridge.correctConversion && bridge.correctEarlyCalibrationSeal
      const observedCorrection = stage === "primary" || ("rootReads" in receipt &&
        [synthesisPairChange.before, synthesisPairChange.after].every(version => receipt.rootReads.some(read =>
          read.path === synthesisPairChange.path && read.sha256 === sha256(version))))
      const qualified = !native && scored && recall && "metrics" in receipt && receipt.identityAndScope &&
        receipt.metrics.classification === "auto-applied" && receipt.metrics.bridge.afterObservedAuto &&
        receipt.stagingAccuracy.length === 6 && receipt.stagingAccuracy.every(row => row.correct) &&
        receipt.checkerReads.length > 0 && observedCorrection && (!installed || receipt.trace.acceptedSynthesisCalls > 0)
      arms.push({ ...trial, outcome: receipt.outcome, problem: receipt.problem, accuracy: scored, bridgeCorrect: recall,
        ...(native ? {} : { qualified }), artifactSha256: await fileDigest(join(priv, filename)) })
      await log({ event: "arm-end", ...trial, outcome: receipt.outcome })
      console.log(JSON.stringify({ event: "arm-end", trial: trial.trial, outcome: receipt.outcome, problem: receipt.problem }))
      if (receipt.outcome === "apparatus-error") break
    }
    await log({ event: "run-end", attempted: arms.length })
  } finally { await events.close() }
  const { host: _, ...after } = await runtimeIdentity(binary, bundle, plan.runtime.version)
  assert.deepEqual(after, plan.runtime)
  const report = { mode: protocol.mode, assigned: plan.roster.length, attempted: arms.length, arms,
    freezeSha256: frozen, runtimeUnchanged: true, artifactSha256: Object.fromEntries(await Promise.all(
      files.map(async file => [file, await fileDigest(join(priv, file))]))) }
  await save(join(output, "report.json"), report)
  if (arms.length !== 2 || arms.some(row => row.outcome === "apparatus-error" || (!native && !row.qualified))) {
    throw new Error("PAIR_QUALIFICATION_OR_APPARATUS_FAILED")
  }
}

export async function runStudy(args: string[]) {
  const { values } = parseArgs({ args, options: {
    mode: { type: "string" }, stage: { type: "string" }, study: { type: "string" }, host: { type: "string" },
    package: { type: "string" }, "allow-model-calls": { type: "boolean" }, "auth-file": { type: "string" },
  } })
  const { mode, stage } = values
  assert.ok(values.study && values.host && values.package && (mode === "qualify" || mode === "freeze" || mode === "live"))
  assert.ok(mode === "live" ? values["allow-model-calls"] && (stage === "primary" || stage === "conditional") :
    !stage && !values["allow-model-calls"] && !values["auth-file"])
  const study = resolve(values.study)
  const [binary, bundle, temp] = await Promise.all([realpath(values.host), realpath(values.package), realpath(tmpdir())])
  const scratch = await mkdtemp(join(temp, "alg-synthesis-pair-"))
  try {
    const version = await hostVersion(binary, join(scratch, "version"))
    const { host: _, ...runtime } = await runtimeIdentity(binary, bundle, version)
    assert.ok(version === "2.3.2" && runtime.bundleSha256 === bundleHash && runtime.binarySha256 === hostHash)
    const hashes = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, await sourceDigest(join(import.meta.dir, file))])))
    if (mode === "qualify") await mkdir(study)
    for (const phase of ["primary", "conditional"] as const) {
      if (mode === "live" && phase !== stage) continue
      const plan = trialProtocol(phase, runtime, hashes)
      const freeze = join(study, phase + "-freeze.json")
      if (mode === "qualify") { await runPair(phase, plan, binary, bundle, scratch, study); continue }
      const qualified = join(study, phase + "-local")
      const file = join(qualified, "report.json")
      const report = await load(file)
      assert.deepEqual(await load(join(qualified, "private/protocol.json")), { ...plan, mode: "local-scripted", syntheticUsagePressure: true })
      assert.equal(report.arms.length, 2)
      assert.ok(report.runtimeUnchanged && report.arms.every((row: { qualified: boolean }) => row.qualified))
      for (const [name, digest] of Object.entries(report.artifactSha256)) {
        assert.equal(name, basename(name))
        assert.equal(await fileDigest(join(qualified, "private", name)), digest)
      }
      const sealed = { ...plan, qualificationSha256: await fileDigest(file) }
      if (mode === "freeze") { await save(freeze, sealed); continue }
      assert.deepEqual(await load(freeze), sealed)
      if (phase === "conditional") {
        const primaryPath = join(study, "primary-live/report.json")
        const primary = await load(primaryPath)
        const review = await load(join(study, "primary-review.json"))
        assert.equal(review.reportSha256, await fileDigest(primaryPath))
        assert.equal(primary.freezeSha256, await fileDigest(join(study, "primary-freeze.json")))
        assert.ok(primary.arms.some((row: { arm: string; outcome: string; bridgeCorrect: boolean }) =>
          row.arm === routedArm && row.outcome === "complete" && row.bridgeCorrect))
        assert.ok(review.arms.some((row: { arm: string; supplementalPass: boolean }) => row.arm === routedArm && row.supplementalPass))
      }
      await save(freeze + ".started", { sha256: await fileDigest(freeze), started: new Date().toISOString() })
      await runPair(phase, plan, binary, bundle, scratch, study, { freeze, authPath: values["auth-file"] })
    }
  } finally {
    assert.ok(dirname(await realpath(scratch)) === temp && basename(scratch).startsWith("alg-synthesis-pair-"))
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

if (import.meta.main) await runStudy(process.argv.slice(2))

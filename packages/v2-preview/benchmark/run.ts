import { chmod, mkdtemp, open, realpath, rm } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { hostVersion } from "../acceptance/host.ts"
import { runtimeIdentity, sha256 } from "../acceptance/runtime.ts"
import { runArm, type BenchmarkOptions } from "./driver.ts"
import { armNames, contextWindow, hasScopedEvidenceTools } from "./host.ts"
import { researchCase } from "./case.ts"
import { scorePair } from "./score.ts"
import { nativeLimits, nativeModel } from "./native-provider.ts"
import { maxProviderBytes, maxProviderCalls } from "./transport.ts"

const scratchPrefix = "alg-v2-benchmark-"
const usage = "Usage: bun packages/v2-preview/benchmark/run.ts --host <native OpenCode 2.3.2> --package <staged bundle directory> --out <new JSON file> [--seed <integer>] [--variant positive|negative] [--order build-first|alg-first] [--native-model openai/<id> --allow-model-calls [--auth-file <OpenCode OAuth file>] [--context <tokens>]]"

export async function runBenchmark(options: Omit<BenchmarkOptions, "scratch"> & { reverse?: boolean }) {
  const parent = await realpath(tmpdir())
  const scratch = await mkdtemp(join(parent, scratchPrefix))
  if (process.platform !== "win32") await chmod(scratch, 0o700)
  try {
    const version = await hostVersion(options.binary, join(scratch, "version"))
    const runtime = await runtimeIdentity(options.binary, options.bundle, version)
    const order = options.reverse ? [...armNames].reverse() : [...armNames]
    const arms = {} as Record<typeof armNames[number], Awaited<ReturnType<typeof runArm>>>
    for (const arm of order) arms[arm] = await runArm(arm, { ...options, scratch })
    const runtimeUnchanged = JSON.stringify(runtime) === JSON.stringify(await runtimeIdentity(options.binary, options.bundle, version))
    const score = scorePair(arms.build.observation, arms.alg.observation)
    const parity = {
      model: arms.build.model.id === arms.alg.model.id && arms.build.model.providerID === arms.alg.model.providerID,
      skill: !!arms.build.skill && arms.build.skill.sha256 === arms.alg.skill?.sha256 &&
        arms.build.skill.sourceSha256 === arms.alg.skill.sourceSha256,
      treatment: arms.build.plugin === null && arms.alg.plugin === "active",
      runtimeUnchanged,
      evidence: order.every(arm => {
        const requests = arms[arm].requests.filter(row => row.kind === "ordinary")
        const root = requests.filter(row => row.role === "root"), checker = requests.filter(row => row.role === "checker")
        return hasScopedEvidenceTools(root, checker) &&
          arms[arm].decision.governedFactoryRequests === 0
      }),
    }
    const overlap = order.every(arm => arms[arm].compaction.status === "OBSERVED")
    const { initial, corrected, readback, savedWhileHeld } = arms.alg.decision
    const durable = !!initial && !!corrected && !!readback && corrected.revision > initial.revision &&
      initial.actionSha !== corrected.actionSha && corrected.runtimeSha256 === runtime.bundleSha256 &&
      initial.runtimeSha256 === runtime.bundleSha256 && readback.revision === corrected.revision &&
      readback.actionSha === corrected.actionSha && readback.procedureSha === arms.alg.skill?.sha256
    const measured = !order.some(arm => arms[arm].failure) && Object.values(parity).every(Boolean) &&
      score.comparable
    const sciencePassed = score.build.science === "pass" && score.alg.science === "pass"
    const qualified = measured && overlap && durable && savedWhileHeld && sciencePassed
    const correctness = { build: score.build.science, alg: score.alg.science }
    const raceQualified = measured && overlap
    const pass = options.native ? measured : null
    return { schema: 1, mode: options.native ? "native-openai-oauth" : "scripted-transport", pass,
      qualified, measured, raceQualified, correctness, durableDecisionObserved: !!durable, mechanicsOnly: !options.native, runtime, order, parity, overlap, seed: options.seed, upstreamSeed: null,
      limits: { ...(options.native ? nativeLimits : { calls: maxProviderCalls, requestBytes: maxProviderBytes }),
        context: options.context ?? contextWindow },
      caseId: score.caseId, prompts: [researchCase.prompt, researchCase.checkerPrompt, researchCase.revisionPrompt].map(sha256),
      arms, score: options.native && measured ? score : { caseId: score.caseId, build: score.build, alg: score.alg },
    }
  } finally {
    const target = await realpath(scratch)
    if (dirname(target) !== parent || !basename(target).startsWith(scratchPrefix))
      throw new Error("Scratch cleanup refused outside the operating system temporary directory")
    await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}

if (import.meta.main) {
  if (process.argv.slice(2).join(" ") === "--help") { console.log(usage); process.exit(0) }
  const args = process.argv.slice(2)
  const flags = new Map<string, string>()
  const allowed = new Set(["--host", "--package", "--out", "--seed", "--variant", "--order", "--native-model", "--auth-file", "--context", "--allow-model-calls"])
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!
    if (!allowed.has(key) || flags.has(key)) throw new Error(usage)
    const value = key === "--allow-model-calls" ? "true" : args[++i]
    if (!value || value.startsWith("--")) throw new Error(usage)
    flags.set(key, value)
  }
  const host = flags.get("--host"), bundle = flags.get("--package"), destination = flags.get("--out")
  if (!host || !bundle || !destination) throw new Error(usage)
  const seed = Number(flags.get("--seed") ?? 101)
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2_147_483_647) throw new Error("Seed must be a nonnegative 32-bit integer")
  const order = flags.get("--order") ?? "build-first"
  if (order !== "build-first" && order !== "alg-first") throw new Error(usage)
  const variant = flags.get("--variant") ?? "positive"
  if (variant !== "positive" && variant !== "negative") throw new Error(usage)
  const id = flags.get("--native-model"), authPath = flags.get("--auth-file")
  let native: BenchmarkOptions["native"], context: number | undefined
  if (id || authPath || flags.has("--allow-model-calls")) {
    if (!id || !flags.has("--allow-model-calls")) throw new Error(usage)
    nativeModel(id)
    native = { model: id, authPath: authPath ? resolve(authPath) : undefined }
  }
  if (flags.has("--context")) {
    context = Number(flags.get("--context"))
    if (!Number.isSafeInteger(context) || context < 8192 || context > 32768) throw new Error("Context must be between 8192 and 32768")
  }
  const binary = await realpath(resolve(host)), pkg = await realpath(resolve(bundle))
  const out = await open(resolve(destination), "wx")
  try {
    const result = await runBenchmark({ binary, bundle: pkg, seed, context, native, variant, reverse: order === "alg-first" })
    await out.writeFile(JSON.stringify(result, null, 2) + "\n")
    await out.sync()
    console.log(JSON.stringify({ mode: result.mode, measured: result.measured, qualified: result.qualified, overlap: result.overlap,
      build: result.arms.build.failure, alg: result.arms.alg.failure }))
    process.exitCode = (result.mode === "native-openai-oauth" ? result.measured : result.qualified) ? 0 : 1
  } finally { await out.close() }
}

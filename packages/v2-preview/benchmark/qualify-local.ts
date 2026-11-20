import { mkdir, realpath, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { PIN, runtimeIdentity } from "../acceptance/runtime.ts"
import { runHandoff } from "./handoff.ts"
import { longHandoffQualificationPlan } from "./long-handoff.ts"
import { runBenchmark } from "./run.ts"

const usage = "Usage: bun packages/v2-preview/benchmark/qualify-local.ts --host <native OpenCode 2.3.2> --package <staged bundle> --out <new directory>"
const matrix = [
  ...longHandoffQualificationPlan,
  { driver: "handoff", variant: "active", extended: false, reverse: true },
  { driver: "handoff", variant: "revoked", extended: false, reverse: false },
] as const

type Benchmark = Awaited<ReturnType<typeof runBenchmark>>
type Handoff = Awaited<ReturnType<typeof runHandoff>>
type Runtime = Awaited<ReturnType<typeof runtimeIdentity>>

function errorReceipt(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack ?? null }
    : { name: null, message: String(error), stack: null }
}

function benchArm(arm: Benchmark["arms"]["build"], score: Benchmark["score"]["build"]) {
  const steps = arm.hostEvidence?.sessions.root?.steps
  const rows = arm.compaction.rows
  return {
    failure: arm.failure,
    completedBoundaries: steps ? steps.filter(row => row.kind === "compaction" && row.completed).length :
      rows.length ? rows.filter(row => row.status === "completed").length : null,
    witnessedBoundaries: Number(arm.compaction.status === "OBSERVED"),
    score: { status: score.status, science: score.science, revisedRootCause: score.checks.revisedRootCause },
  }
}

function handoffArm(arm: Handoff["arms"]["build"]) {
  const rows = arm.raw.root
  const checks = Object.values(arm.standalone.checks)
  return {
    failure: arm.failure,
    completedBoundaries: rows?.filter(row => row.type === "compaction" && row.status === "completed").length ?? null,
    witnessedBoundaries: arm.compaction.boundaries.filter(row => Object.values(row.checks).every(Boolean)).length,
    skillDelivery: arm.compaction.boundaries.map(({ index, skillDelivery }) => ({
      index, complete: skillDelivery.complete, firstRequestRoles: skillDelivery.complete ? skillDelivery.requests[0]!.roles : null,
      roles: skillDelivery.roles, projectionRoles: skillDelivery.projectionRoles,
    })),
    score: { passed: checks.filter(Boolean).length, total: checks.length },
  }
}

function resultSummary(result: Benchmark | Handoff, expected: Runtime | null) {
  const runtimeMatches = expected !== null && result.parity.runtimeUnchanged &&
    JSON.stringify(result.runtime) === JSON.stringify(expected)
  const qualified = result.qualified && runtimeMatches && result.mode === "scripted-transport" && result.mechanicsOnly
  return {
    status: qualified ? "qualified" : "failed", runtimeMatches, caseId: result.caseId,
    score: "score" in result ? { measured: result.measured, raceQualified: result.raceQualified } : {
      apparatusPassed: result.apparatusPassed, standalonePassed: result.standalonePassed,
      installedBehaviorPassed: result.installedBehaviorPassed, previewWorkflowPassed: result.previewWorkflowPassed,
    },
    arms: "score" in result ? {
      build: benchArm(result.arms.build, result.score.build),
      alg: benchArm(result.arms.alg, result.score.alg),
    } : {
      build: handoffArm(result.arms.build),
      alg: handoffArm(result.arms.alg),
    },
  }
}

async function qualify(binary: string, bundle: string, destination: string) {
  const directory = join(await realpath(dirname(destination)), basename(destination))
  const fromBundle = relative(bundle, directory)
  if (!fromBundle || (!isAbsolute(fromBundle) && fromBundle !== ".." && !fromBundle.startsWith(".." + sep)))
    throw new Error("The receipt directory must be outside the staged package")
  await mkdir(directory)
  const save = (name: string, value: unknown) =>
    writeFile(join(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" })

  // The drivers verify the pinned host version and measure identities for every pair.
  let expectedRuntime: Runtime | null = null
  let identityError: ReturnType<typeof errorReceipt> | null = null
  try { expectedRuntime = await runtimeIdentity(binary, bundle, PIN) }
  catch (error) { identityError = errorReceipt(error) }

  let qualifiedPairs = 0
  const receipts = []
  for (const [index, entry] of matrix.entries()) {
    const workload = entry.driver === "handoff" ? entry.extended ? "extended" : "single" : "near-miss"
    const order = entry.reverse ? "alg-first" : "build-first"
    const label = `${entry.driver}-${workload}-${entry.variant}-${order}`
    const receipt = `${String(index + 1).padStart(2, "0")}-${label}.json`
    const pair = { driver: entry.driver, variant: entry.variant, workload, order }
    console.log(`[${index + 1}/${matrix.length}] ${label}`)
    let result: Benchmark | Handoff
    try {
      // Native model and credential options are deliberately absent from both calls.
      result = entry.driver === "benchmark"
        ? await runBenchmark({ binary, bundle, seed: 101, variant: entry.variant, reverse: entry.reverse })
        : await runHandoff({ binary, bundle, variant: entry.variant, reverse: entry.reverse, extended: entry.extended })
    } catch (error) {
      const failure = { status: "error", error: errorReceipt(error) } as const
      await save(receipt, { pair, ...failure })
      receipts.push({ ...pair, receipt, status: failure.status, error: failure.error.message })
      continue
    }
    await save(receipt, result)
    const summary = resultSummary(result, expectedRuntime)
    if (summary.status === "qualified") qualifiedPairs++
    receipts.push({ ...pair, receipt, ...summary })
  }

  const scriptedMechanicsPassed = qualifiedPairs === matrix.length
  const summary = {
    schema: 1, mode: "scripted-transport", mechanicsOnly: true,
    binary, bundle, expectedRuntime, identityError,
    plannedPairs: matrix.length, qualifiedPairs, scriptedMechanicsPassed,
    releaseStatus: "draft", liveWorkflow: "not_run",
    pairs: receipts,
  }
  await save("summary.json", summary)
  console.log(JSON.stringify({ summary: join(directory, "summary.json"), qualifiedPairs, plannedPairs: matrix.length,
    scriptedMechanicsPassed, releaseStatus: summary.releaseStatus }))
  return scriptedMechanicsPassed
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--help") {
    console.log(usage)
  } else {
    const flags = new Map<string, string>()
    const allowed = new Set(["--host", "--package", "--out"])
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!, value = args[i + 1]
      if (!allowed.has(key) || flags.has(key) || !value || value.startsWith("--")) throw new Error(usage)
      flags.set(key, value)
    }
    const host = flags.get("--host"), bundle = flags.get("--package"), out = flags.get("--out")
    if (!host || !bundle || !out) throw new Error(usage)
    const [binary, staged] = await Promise.all([realpath(resolve(host)), realpath(resolve(bundle))])
    process.exitCode = await qualify(binary, staged, resolve(out)) ? 0 : 1
  }
}

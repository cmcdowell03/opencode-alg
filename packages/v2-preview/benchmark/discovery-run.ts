import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { hostVersion } from "../acceptance/host.ts"
import { fileDigest, runtimeIdentity, sha256 } from "../acceptance/runtime.ts"
import { buildPreview } from "../build.ts"
import { buildDiscoveryCases } from "./discovery-cases.ts"
import { buildDiscoveryReviewPacket, gradeDiscovery, parseDiscoverySubmission } from "./discovery-grade.ts"
import { checkerInstructions, discoveryArms, ledgerInstructions, revisionInstructions, runDiscoveryArm, type DiscoveryArm } from "./discovery-host.ts"
import { discoveryNativeLimits, nativeModel } from "./native-provider.ts"
import { sourceCallCap } from "./discovery-tools.ts"

const usage = [
  "bun --no-install packages/v2-preview/benchmark/discovery-run.ts --out <new-directory> [--host <OpenCode 2.3.2 binary>] [--case all|1|2|3|4|5] [--package <staged-preview>]",
  "For a native pilot, replace --out with --freeze <new-file.json> and add --case 1 --native-model openai/gpt-6-luna.",
  "Execute that freeze with the same --case, --native-model, --host and --package and add --frozen <file.json> --allow-model-calls --out <new-directory> [--auth-file <OpenCode auth.json>].",
].join("\n")

const location = dirname(fileURLToPath(import.meta.url))
const winHost = resolve(location, "../../../../v2-isolated-hosts/node_modules/@opencode/cli-windows-x64/bin/opencode.exe")
const freezeFiles = [
  "discovery-run.ts", "discovery-cases.ts", "discovery-grade.ts", "discovery-host.ts", "discovery-tools.ts",
  "native-observer.ts", "native-provider.ts", "compaction.ts", "input-usage.ts", "skill-delivery.ts", "host.ts",
  "../acceptance/host.ts", "../acceptance/runtime.ts", "../acceptance/service.ts",
]

const optionalFlags = new Set(["--host", "--package", "--case", "--native-model", "--auth-file", "--out", "--freeze", "--frozen"])

function parseArgs(args: string[]) {
  const flags = new Map<string, string>()
  while (args.length) {
    const flag = args.shift()!
    const value = flag === "--allow-model-calls" ? "true" : args.shift()
    if (flags.has(flag) || (flag !== "--allow-model-calls" && !optionalFlags.has(flag)) || !value || value.startsWith("--"))
      throw new Error(usage)
    flags.set(flag, value)
  }
  const native = flags.get("--native-model")
  const freeze = flags.get("--freeze")
  const frozen = flags.get("--frozen")
  const out = flags.get("--out")
  const selector = flags.get("--case") ?? "all"
  const consent = flags.has("--allow-model-calls")
  if (!/^(all|[1-5])$/.test(selector) || Boolean(out) === Boolean(freeze) ||
      (freeze && (!native || consent || frozen)) ||
      (out && native && (!consent || !frozen)) ||
      (!native && (consent || frozen || flags.has("--auth-file"))) ||
      (native && !flags.has("--case")) || (freeze && flags.has("--auth-file"))) throw new Error(usage)
  if (native) nativeModel(native)
  return { selector, native, freeze, frozen, out, host: flags.get("--host"), bundle: flags.get("--package"),
    authPath: flags.get("--auth-file") }
}

async function newPath(value: string) {
  const path = resolve(value)
  const parent = await realpath(dirname(path))
  if (resolve(dirname(path)) !== parent && process.platform !== "win32")
    throw new Error("Output directory parent must use its real path")
  return join(parent, basename(path))
}

async function persist(path: string, value: unknown) {
  const handle = await open(path, "wx", 0o600)
  try {
    await handle.writeFile(JSON.stringify(value, null, 2) + "\n")
    await handle.sync()
  } finally { await handle.close() }
}

const ordered = (arms: readonly DiscoveryArm[], index: number) =>
  arms.slice(index % arms.length).concat(arms.slice(0, index % arms.length))

export async function runDiscoveryCLI(args: string[]) {
  const options = parseArgs([...args])
  const output = await newPath(options.freeze ?? options.out!)
  const cases = buildDiscoveryCases()
  if (cases.length !== 5 || new Set(cases.map(incident => incident.id)).size !== 5)
    throw new Error("Expected five distinct blind discovery cases")
  const indices = options.selector === "all" ? cases.map((_, index) => index) : [Number(options.selector) - 1]
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "opencode-discovery-"))
  try {
    const bundledHost = process.platform === "win32" ? await realpath(winHost).catch(() => undefined) : undefined
    const path = options.host ?? bundledHost ?? Bun.which("opencode")
    if (!path) throw new Error("Provide --host with the native OpenCode 2.3.2 executable")
    const binary = await realpath(path)
    const bundle = options.bundle ? await realpath(options.bundle) : join(scratch, "preview")
    if (!options.bundle) await buildPreview(bundle)
    const runtime = await runtimeIdentity(binary, bundle, await hostVersion(binary, join(scratch, "version")))
    const protocol = {
      schema: "discovery-freeze-v1",
      model: options.native ?? null,
      mode: options.native ? "native-oauth" : "synthetic-scripted",
      host: { version: runtime.version, binarySha256: runtime.binarySha256,
        packageSha256: runtime.packageSha256, bundleSha256: runtime.bundleSha256 },
      caps: { ...discoveryNativeLimits, sourceCalls: sourceCallCap },
      cases: indices.map(index => {
        const incident = cases[index]!
        return { id: incident.id, caseSha256: sha256(JSON.stringify(incident)),
          promptSha256: sha256(incident.input.prompt), order: ordered(discoveryArms, index) }
      }),
      audit: { checkerPromptSha256: sha256(JSON.stringify(checkerInstructions)), revisionPromptSha256: sha256(revisionInstructions) },
      ledgerPromptSha256: sha256(ledgerInstructions),
      sourceDigestMode: "utf8-lf-v1",
      files: Object.fromEntries(await Promise.all(freezeFiles.map(async file =>
        [file, sha256((await readFile(resolve(location, file), "utf8")).replace(/\r\n/g, "\n"))]))),
    }
    if (options.freeze) {
      await persist(output, protocol)
      console.log("Frozen discovery protocol " + output)
      return
    }
    if (options.frozen) {
      const frozen = JSON.parse(await readFile(options.frozen, "utf8"))
      if (!isDeepStrictEqual(frozen, protocol)) throw new Error("Discovery freeze mismatch. Verify protocol and runtime before model calls.")
    }

    // Reserve the output namespace and establish durable metadata before any model prompt is submitted.
    await mkdir(output, { mode: 0o700 })
    await mkdir(join(output, "private"), { mode: 0o700 })
    await mkdir(join(output, "blinded"), { mode: 0o700 })
    const trials = protocol.cases.flatMap(({ id, order }) => order.map(arm => ({ trial: randomUUID(), case: id, arm })))
    await persist(join(output, "private", "protocol.json"), protocol)
    await persist(join(output, "private", "trial-key.json"), trials)
    const journal = await open(join(output, "private", "events.jsonl"), "wx", 0o600)
    type Arm = Awaited<ReturnType<typeof runDiscoveryArm>>
    type Summary = Pick<Arm, "qualified" | "apparatusQualified" | "outcome" | "problem" |
      "auditQualified" | "providerCalls" | "treatment" | "usage">
    const completed: (Summary & { trial: string; case: string; arm: DiscoveryArm;
      grade: ReturnType<typeof gradeDiscovery> })[] = []
    let interrupted: string | null = null
    try {
      for (const trial of trials) {
        const log = async (event: Record<string, unknown>) => {
          await journal.appendFile(JSON.stringify({ trial: trial.trial, ...event }) + "\n")
          await journal.sync()
        }
        await log({ event: "arm-start" })
        const incident = cases.find(row => row.id === trial.case)!
        const result = await runDiscoveryArm({
          binary, bundle, bundleSha256: runtime.bundleSha256, arm: trial.arm, scratch: join(scratch, trial.trial),
          prompt: incident.input.prompt, sources: incident.input.sources,
          native: options.native ? { model: options.native, authPath: options.authPath } : undefined, log,
        })
        const parsed = parseDiscoverySubmission(result.final)
        // The root verifies citations with its own reads after receiving any advisory report.
        const grade = gradeDiscovery(incident, parsed, { verifiedSourcePaths: [...new Set(result.rootReads.map(read => read.path))] })
        const packet = buildDiscoveryReviewPacket(incident, parsed)
        const outcome = result.outcome === "completed" && !grade.validSubmission ? "model-output-failure" : result.outcome
        const qualified = result.qualified && outcome === "completed"
        await persist(join(output, "private", trial.trial + ".json"), { ...trial, ...result, outcome, qualified, grade })
        await persist(join(output, "blinded", trial.trial + ".json"), {
          trial: trial.trial, packet,
        })
        const { apparatusQualified, problem, auditQualified, providerCalls, treatment, usage } = result
        completed.push({ ...trial, qualified, apparatusQualified, outcome, problem, auditQualified, providerCalls, treatment, usage, grade })
        await log({ event: "arm-end", qualified, apparatusQualified, outcome, problem })
        if (options.native && !apparatusQualified) {
          interrupted = "Native apparatus did not qualify. See the private arm receipt."
          break
        }
      }
    } catch (error) {
      interrupted = error instanceof Error ? error.message : String(error)
    } finally { await journal.close() }
    const files = ["private/protocol.json", "private/trial-key.json", "private/events.jsonl",
      ...completed.flatMap(({ trial }) => ["private/" + trial + ".json", "blinded/" + trial + ".json"])]
    const artifactSha256 = Object.fromEntries(await Promise.all(files.map(async file => [file, await fileDigest(join(output, file))])))
    const runtimeUnchanged = isDeepStrictEqual(runtime, await runtimeIdentity(binary, bundle, runtime.version))
    const qualified = !interrupted && runtimeUnchanged && completed.length === trials.length &&
      completed.every(arm => options.native ? arm.apparatusQualified : arm.qualified)
    const allEvidenceQualified = qualified && completed.every(arm => arm.qualified)
    const byPair = (first: DiscoveryArm, second: DiscoveryArm) => protocol.cases.flatMap(({ id }) => {
      const baseline = completed.find(row => row.case === id && row.arm === first)
      const treatment = completed.find(row => row.case === id && row.arm === second)
      return baseline && treatment ? [{ case: id, baseline: baseline.trial, treatment: treatment.trial,
        comparable: Boolean(options.native && runtimeUnchanged && baseline.apparatusQualified && treatment.apparatusQualified &&
          !baseline.grade.reviewRequired && !treatment.grade.reviewRequired),
        baselinePassed: baseline.grade.passed, treatmentPassed: treatment.grade.passed,
        baselineOutcome: baseline.outcome, treatmentOutcome: treatment.outcome,
        baselineTreatment: baseline.treatment, treatmentReceived: treatment.treatment,
        verifiedLedgerInAssignedAlgArms: [baseline, treatment].every(row =>
          row.treatment === "control" || row.treatment === "verified-ledger") }] : []
    })
    await persist(join(output, "private", "report.json"), {
      schema: "discovery-report-v1", mode: protocol.mode, qualified, allEvidenceQualified, interrupted, runtimeUnchanged,
      expected: trials.length, completed, artifactSha256,
      comparisons: {
        stockBuildVsAlgOrdinary: byPair("build", "alg-ordinary"),
        stockBuildVsAlgAdversarial: byPair("build", "alg-adversarial"),
        adversarialVsOrdinaryInAlg: byPair("alg-ordinary", "alg-adversarial"),
        adversarialVsOrdinaryInBuild: byPair("build-ordinary", "build-adversarial"),
        installedAlgWithOrdinaryChecker: byPair("build-ordinary", "alg-ordinary"),
        installedAlgWithAdversarialChecker: byPair("build-adversarial", "alg-adversarial"),
      },
    })
    console.log(JSON.stringify({ output, mode: protocol.mode, qualified, completed: completed.length, expected: trials.length }))
    if (!qualified) process.exitCode = 1
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  if (args.length === 1 && args[0] === "--help") console.log(usage)
  else await runDiscoveryCLI(args)
}

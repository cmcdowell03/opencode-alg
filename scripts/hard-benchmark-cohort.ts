import { createHash } from "node:crypto"
import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, readSync, realpathSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import { z } from "zod"
import { sha256Json } from "../src/persistence.ts"
import type { BenchmarkCase } from "./build-benchmark-fixtures.ts"
import { createHardBenchmarkFixtures, openHardFixtureService, type CreatedHardFixture } from "./hard-benchmark-fixtures.ts"
import { scheduleIssuedPairs, type BenchmarkTrack } from "./build-benchmark-protocol.ts"
import { createHardBenchmarkHttpClient, hardBenchmarkHostUsage, startHardBenchmarkHost } from "./hard-benchmark-host.ts"
import { hardBenchmarkReferenceArm, hardBenchmarkNegativeArm, hardBenchmarkTamperArm, hardBenchmarkExtraFieldArm, qualifyHardBenchmarkDevelopment, scoreHardDevelopmentFixture,
  type HardBenchmarkQualificationResult } from "./hard-benchmark-qualification.ts"
export { scoreHardDevelopmentFixture } from "./hard-benchmark-qualification.ts"

export type BenchmarkLimits = { trialMs: number; assistantTurns: number; reportedComponents: number; outputTokens: number; suiteMs: number }
// Validation ceilings only. There is deliberately no prospective hard protocol default.
export const HardLimitsSchema = z.object({
  trialMs: z.number().int().min(1_000).max(86_400_000),
  assistantTurns: z.number().int().min(1).max(10_000),
  reportedComponents: z.number().int().min(1).max(100_000_000),
  outputTokens: z.number().int().min(1).max(131_072),
  suiteMs: z.number().int().min(1_000).max(604_800_000),
}).strict().refine(limits => limits.suiteMs >= limits.trialMs * 12,
  "hard suiteMs must accommodate all twelve issued arm time envelopes")
const OrderSeedSchema = z.number().int().min(0).max(0xffff_ffff)
export const HARD_ISOLATION = "same-user-development-only-not-os-isolated" as const
export const HARD_INTERPRETATION = "DEVELOPMENT ONLY; same user; NOT OS ISOLATED; unqualified for confirmation. Native auto/prune compaction is enabled prospectively; hard L1 requests no host compaction. Existing telemetry distinguishes observed markers, linked completed summaries and continuation evidence. No forced boundary implies no information-loss estimate, not zero loss. The preseeded service restart is not model compaction."
export interface WorkloadOptions {
  workload?: "controls" | "hard-development"
  caseIds?: string[]
  track?: "default" | "targeted_compatibility"
  hardLimits?: BenchmarkLimits
  orderSeed?: number
  hardQualification?: string
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}
export function needsHardService(fixture: CreatedHardFixture): boolean {
  return ["accepted-query-lost-ack", "partial-investigation-restart"].includes(fixture.contestant.family)
}
export function hardRunnerCase(fixture: CreatedHardFixture): BenchmarkCase {
  const c = fixture.contestant
  return { id: c.id, title: c.request, criteria: [...c.criteria], files: { ...c.files }, protectedPaths: [...c.protectedPaths],
    initialPrompt: c.request + "\n\nOriginal acceptance criteria:\n" + c.criteria.map((text, index) => `${index + 1}. ${text}`).join("\n"),
    followupPrompt: undefined }
}

/** Select and freeze the cases before the existing runner issues any pairs. */
export function prepareBenchmarkWorkload(options: WorkloadOptions, controls: readonly BenchmarkCase[], controlLimits: BenchmarkLimits) {
  const workload = options.workload ?? "controls"
  if (workload !== "controls" && workload !== "hard-development") throw new Error("unknown benchmark workload")
  if (workload === "controls") {
    if (options.hardLimits !== undefined || options.orderSeed !== undefined || options.hardQualification !== undefined)
      throw new Error("hard envelope overrides are forbidden for controls")
    if (options.caseIds && (!options.caseIds.length || new Set(options.caseIds).size !== options.caseIds.length ||
      options.caseIds.some(id => !controls.some(c => c.id === id)))) throw new Error("caseIds must select distinct known cases")
    return { workload, limits: { ...controlLimits }, cases: controls.filter(c => !options.caseIds || options.caseIds.includes(c.id)),
      compaction: { auto: false, prune: false }, hardFixtures: [] as readonly CreatedHardFixture[], orderSeed: undefined, reverseFirstArm: false, planSha256: undefined }
  }
  if (options.caseIds !== undefined) throw new Error("hard-development always selects all six fixtures; caseIds is controls-only")
  if (options.track !== undefined && options.track !== "default") throw new Error("hard-development requires the default Build/ALG pair")
  if (typeof options.hardQualification !== "string" || !options.hardQualification.trim()) throw new Error("hardQualification evidence path is required")
  const limits = HardLimitsSchema.parse(options.hardLimits), orderSeed = OrderSeedSchema.parse(options.orderSeed)
  const hardFixtures = freeze(structuredClone(createHardBenchmarkFixtures()))
  const cases = hardFixtures.map(hardRunnerCase).sort((a, b) => {
    const left = sha256Json({ orderSeed, id: a.id }), right = sha256Json({ orderSeed, id: b.id })
    return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id)
  })
  const reverseFirstArm = (Number.parseInt(sha256Json({ orderSeed, purpose: "first-arm" }).slice(0, 8), 16) & 1) === 1
  const compaction = { auto: true, prune: true }
  const planSha256 = sha256Json({ workload, limits, orderSeed, reverseFirstArm, cases, hardFixtures, compaction })
  return freeze({ workload, limits, cases, hardFixtures, orderSeed, reverseFirstArm, planSha256, compaction })
}

export function scheduleBenchmarkWorkload(selection: ReturnType<typeof prepareBenchmarkWorkload>, track: BenchmarkTrack) {
  return scheduleIssuedPairs(selection.cases, track).map(issue => selection.reverseFirstArm
    ? { ...issue, order: [...issue.order].reverse() } : issue)
}
export function benchmarkTaskPrompt(common: string, prompt: string, serviceUrl?: string): string {
  if (!serviceUrl) return common + "\n\n" + prompt
  return common.replace("or use network services", "or use network services except the supplied fixture HTTP endpoint on 127.0.0.1 using Node fetch") +
    "\n\n" + prompt + "\n\n" + hardBenchmarkHostUsage(serviceUrl)
}
export function terminalHardRows<T extends { status: string }>(rows: readonly T[], reason: string, preflight = false) {
  return rows.map(row => row.status === "issued_not_started" || row.status === "running"
    ? { ...row, status: preflight ? "preflight_failed" : "stopped", passed: false, scored_task_success: false, stopReason: reason }
    : { ...row })
}

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
export const HardIdentitySchema = z.object({ hard_fixtures_sha256: Hash, fixtures_source_sha256: Hash,
  grader_sha256: Hash, service_sha256: Hash, qualification_sha256: Hash, host_sha256: Hash, cohort_sha256: Hash, runner_sha256: Hash }).strict()
export function hardBenchmarkIdentity(repo: string, fixtures: readonly CreatedHardFixture[]) {
  const source = (file: string) => hash(readFileSync(join(repo, "scripts", file)))
  return HardIdentitySchema.parse({ hard_fixtures_sha256: sha256Json(fixtures),
    fixtures_source_sha256: source("hard-benchmark-fixtures.ts"), grader_sha256: source("hard-benchmark-fixtures.ts"),
    service_sha256: source("hard-benchmark-service.ts"), qualification_sha256: source("hard-benchmark-qualification.ts"),
    host_sha256: source("hard-benchmark-host.ts"), cohort_sha256: source("hard-benchmark-cohort.ts"), runner_sha256: source("build-benchmark.ts") })
}

const CheckSchema = z.object({ id: z.string().min(1).max(512), passed: z.boolean(), detail: z.string().max(8192).optional() }).strict()
const GradeSchema = z.object({ passed: z.boolean(), checks: z.array(CheckSchema).min(1).max(8192),
  metrics: z.record(z.string(), z.union([z.string().max(8192), z.number().finite(), z.boolean()])) }).strict()
const QualificationRowSchema = z.object({ fixtureId: z.string().min(1).max(256), family: z.string().min(1).max(128),
  case: z.enum(["positive", "negative", "tamper", "extra-field"]), status: z.enum(["passed", "blocked", "failed"]),
  passed: z.boolean(), expected: z.enum(["accept", "reject"]), grade: GradeSchema, isolation: z.literal(HARD_ISOLATION) }).strict()
const QualificationResultSchema = z.object({ isolation: z.literal(HARD_ISOLATION), results: z.array(QualificationRowSchema).min(1).max(64),
  passed: z.boolean(), caseCount: z.number().int().nonnegative(), acceptedPositive: z.number().int().nonnegative(),
  rejectedNegativeOrTamper: z.number().int().nonnegative(), rejectedExtraField: z.number().int().nonnegative(),
  blockedCases: z.number().int().nonnegative(), failedCases: z.number().int().nonnegative() }).strict()
/** External qualification writes this receipt; the paid runner never manufactures qualification. */
export const HardQualificationSchema = z.object({ schema: z.literal("alg-hard-development-qualification-v2"),
  generated_at: z.iso.datetime({ offset: true }), identities: HardIdentitySchema,
  development: QualificationResultSchema, public_http: QualificationResultSchema }).strict()

export function validateHardQualification(raw: unknown, identities: z.infer<typeof HardIdentitySchema>, fixtures: readonly CreatedHardFixture[]) {
  const evidence = HardQualificationSchema.parse(raw)
  if (sha256Json(evidence.identities) !== sha256Json(identities)) throw new Error("hard qualification runtime identities changed")
  for (const [channel, selected] of [["development", fixtures], ["public_http", fixtures.filter(needsHardService)]] as const) {
    const result = evidence[channel], expected = new Map(selected.map(f => [f.contestant.id, f.contestant.family]))
    const seen = new Set<string>()
    for (const row of result.results) {
      const key = `${row.fixtureId}:${row.case}`
      if (seen.has(key) || expected.get(row.fixtureId) !== row.family) throw new Error(`invalid ${channel} qualification case coverage`)
      seen.add(key)
      const accepted = row.case === "positive"
      if (row.status !== "passed" || row.passed !== true || row.expected !== (accepted ? "accept" : "reject") ||
        row.grade.passed !== accepted || row.grade.passed !== row.grade.checks.every(check => check.passed) ||
        new Set(row.grade.checks.map(check => check.id)).size !== row.grade.checks.length)
        throw new Error(`failed or inconsistent ${channel} qualification receipt`)
    }
    if (seen.size !== selected.length * 4 || !result.passed || result.caseCount !== seen.size ||
      result.acceptedPositive !== selected.length || result.rejectedNegativeOrTamper !== selected.length * 2 ||
      result.rejectedExtraField !== selected.length || result.blockedCases || result.failedCases)
      throw new Error(`incomplete ${channel} qualification`)
  }
  return evidence
}
export function readHardQualification(path: string, identities: z.infer<typeof HardIdentitySchema>, fixtures: readonly CreatedHardFixture[]) {
  const bytes = readDirectBounded(resolve(path), 4 * 1024 * 1024)
  return { evidence: validateHardQualification(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), identities, fixtures), sha256: hash(bytes) }
}

/** Local reference/oracle qualification only: no model, provider, contestant executable, or paid request. */
export async function qualifyHardBenchmarkCohortInputs(repo = resolve(import.meta.dir, "..")) {
  const fixtures = freeze(structuredClone(createHardBenchmarkFixtures())), identities = hardBenchmarkIdentity(repo, fixtures)
  const development = await qualifyHardBenchmarkDevelopment(fixtures)
  const results: HardBenchmarkQualificationResult[] = []
  for (const fixture of fixtures.filter(needsHardService)) {
    for (const [testCase, arm] of [["positive", hardBenchmarkReferenceArm], ["negative", hardBenchmarkNegativeArm],
      ["tamper", hardBenchmarkTamperArm], ["extra-field", hardBenchmarkExtraFieldArm]] as const) {
      const directory = await mkdtemp(join(tmpdir(), "hard-http-qualification-"))
      let host: Awaited<ReturnType<typeof startHardBenchmarkHost>> | undefined
      try {
        const service = await openHardFixtureService(fixture, directory)
        host = await startHardBenchmarkHost(service)
        const submission = await arm({ fixture: freeze(structuredClone(fixture.contestant)), service: createHardBenchmarkHttpClient(host.url) })
        await host.stop()
        const grade = await scoreHardDevelopmentFixture(fixture, submission, { service })
        const passed = grade.passed === (testCase === "positive")
        results.push({ fixtureId: fixture.contestant.id, family: fixture.contestant.family, case: testCase,
          expected: testCase === "positive" ? "accept" : "reject", status: passed ? "passed" : "failed", passed, grade, isolation: HARD_ISOLATION })
      } catch (error) {
        results.push({ fixtureId: fixture.contestant.id, family: fixture.contestant.family, case: testCase,
          expected: testCase === "positive" ? "accept" : "reject", status: "failed", passed: false,
          grade: { passed: false, checks: [{ id: "public-http-execution", passed: false, detail: String(error) }], metrics: {} }, isolation: HARD_ISOLATION })
      } finally {
        const cleanupFailure = (id: string, error: unknown) => {
          const row = results.at(-1)!
          row.passed = false; row.status = "failed"; row.grade.passed = false
          row.grade.checks.push({ id, passed: false, detail: String(error).slice(0, 8192) })
        }
        try { await host?.stop() } catch (error) { cleanupFailure("public-http-cleanup", error) }
        try { await rm(directory, { recursive: true, force: true }) } catch (error) { cleanupFailure("qualification-directory-cleanup", error) }
      }
    }
  }
  if (sha256Json(identities) !== sha256Json(hardBenchmarkIdentity(repo, fixtures))) throw new Error("qualification sources changed during execution")
  return { schema: "alg-hard-development-qualification-v2" as const, generated_at: new Date().toISOString(), identities, development,
    public_http: { isolation: HARD_ISOLATION, results, passed: results.every(row => row.status === "passed"), caseCount: results.length,
      acceptedPositive: results.filter(row => row.case === "positive" && row.grade.passed).length,
      rejectedNegativeOrTamper: results.filter(row => ["negative", "tamper"].includes(row.case) && !row.grade.passed).length,
      rejectedExtraField: results.filter(row => row.case === "extra-field" && !row.grade.passed).length,
      blockedCases: results.filter(row => row.status === "blocked").length, failedCases: results.filter(row => row.status === "failed").length } }
}

function readDirectBounded(path: string, maximum: number): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum || relative(path, realpathSync.native(path)) !== "")
    throw new Error("hard file is redirected, linked, non-regular or exceeds its byte bound")
  const fd = openSync(path, "r")
  try {
    const opened = fstatSync(fd)
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs)
      throw new Error("hard file changed during collection")
    const buffer = Buffer.alloc(stat.size + 1)
    let size = 0, count = 0
    while (size < buffer.length && (count = readSync(fd, buffer, size, buffer.length - size, null)) > 0) size += count
    const after = fstatSync(fd), current = lstatSync(path)
    if (size !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || current.ino !== stat.ino || current.dev !== stat.dev ||
      current.isSymbolicLink() || relative(path, realpathSync.native(path)) !== "") throw new Error("hard file changed during collection")
    return buffer.subarray(0, size)
  } finally { closeSync(fd) }
}

export const HARD_COLLECTION_LIMITS = Object.freeze({ files: 8192, directories: 8192, depth: 32, fileBytes: 2 * 1024 * 1024, totalBytes: 32 * 1024 * 1024 })
export const HARD_PROGRESS_LIMITS = Object.freeze({ runs: 256, fileBytes: 2 * 1024 * 1024, totalBytes: 16 * 1024 * 1024 })
/** Private post-stop diagnostics only. The grader receives collectHardProject instead. */
export function collectHardRunProgress(project: string) {
  const runs = join(resolve(project), ".opencode", "runs")
  if (!existsSync(runs)) return { states: [], coverage: "no_runtime_runs" as const, runDirectories: 0 }
  const directDirectory = (path: string) => {
    const stat = lstatSync(path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(path, realpathSync.native(path)) !== "")
      throw new Error("hard runtime progress directory is redirected")
  }
  directDirectory(runs)
  let runDirectories = 0, totalBytes = 0, archivedAttempts = 0
  const states: Array<{ run_id: unknown; status: unknown; phase: unknown; global_attempts: unknown;
    nodes: Array<{ id: unknown; status: unknown; last_failures: unknown; archived_attempts: number;
      attempts: Array<{ outcome: unknown; failures: unknown; session_id: unknown }> }> }> = []
  const directory = opendirSync(runs)
  try {
    for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
      // These exact runtime namespaces contain owner indexes and native task cards.
      // Other unsafe entries must still fail collection, rather than vanish.
      if (entry.name === "_owners" || entry.name === "_cards") continue
      if (++runDirectories > HARD_PROGRESS_LIMITS.runs) throw new Error("hard runtime progress run bound exceeded")
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.name)) throw new Error("unsafe hard runtime run name")
      const runDirectory = join(runs, entry.name)
      directDirectory(runDirectory)
      const progress = join(runDirectory, "progress.json")
      if (!existsSync(progress)) continue
      const bytes = readDirectBounded(progress, HARD_PROGRESS_LIMITS.fileBytes)
      totalBytes += bytes.length
      if (totalBytes > HARD_PROGRESS_LIMITS.totalBytes) throw new Error("hard runtime progress byte bound exceeded")
      const state = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
      const nodes = Object.values(state.nodes ?? {}) as Array<Record<string, unknown>>
      if (nodes.length > 256 || nodes.some(node => !Array.isArray(node.attempts) || node.attempts.length > 256))
        throw new Error("hard runtime progress node or attempt bound exceeded")
      const projectedNodes = nodes.map(node => {
        const archived = (node.attempt_history_ref as { attempt_count?: number } | undefined)?.attempt_count ?? 0
        if (!Number.isSafeInteger(archived) || archived < 0) throw new Error("invalid hard runtime archived attempt count")
        archivedAttempts += archived
        return { id: node.id, status: node.status, last_failures: node.last_failures, archived_attempts: archived,
          attempts: (node.attempts as Array<Record<string, unknown>>).map(attempt => ({
            outcome: attempt.outcome, failures: attempt.failures, session_id: attempt.session_id,
          })) }
      })
      states.push({ run_id: state.run_id, status: state.status, phase: state.phase, global_attempts: state.global_attempts,
        nodes: projectedNodes })
    }
  } finally { directory.closeSync() }
  return { states, coverage: archivedAttempts ? "inline_recent_with_archived_attempts" as const : "complete_inline" as const,
    runDirectories, archivedAttempts }
}
const privateTrees = [".git", ".opencode/runs", ".opencode/session-memory", ".opencode/skill-evolution", ".opencode/experience", ".opencode/ALG.workspace.json"]
/** Both arms use identical exclusions. Unknown writes and protected evidence remain visible to the grader. */
export function collectHardProject(project: string, fixture: CreatedHardFixture) {
  const root = resolve(project), files: Record<string, string> = Object.create(null)
  const manifest: Array<{ path: string; bytes: number; sha256: string }> = [], excluded: string[] = []
  const frozenPaths = Object.keys(fixture.contestant.files)
  let total = 0, directories = 0, visited = 0
  const direct = (path: string) => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || relative(path, realpathSync.native(path)) !== "") throw new Error("hard project contains a symlink or redirected path")
    return stat
  }
  const walk = (directory: string, prefix: string, depth: number) => {
    if (++directories > HARD_COLLECTION_LIMITS.directories || depth > HARD_COLLECTION_LIMITS.depth) throw new Error("hard project directory bound exceeded")
    const names: string[] = [], dir = opendirSync(directory)
    try {
      for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
        if (++visited > HARD_COLLECTION_LIMITS.files + HARD_COLLECTION_LIMITS.directories) throw new Error("hard project entry bound exceeded")
        names.push(entry.name)
      }
    } finally { dir.closeSync() }
    for (const name of names.sort()) {
      const path = join(directory, name), rel = prefix + name, stat = direct(path)
      if (privateTrees.includes(rel) && !frozenPaths.some(p => p === rel || p.startsWith(rel + "/"))) { excluded.push(rel); continue }
      if (stat.isDirectory()) { walk(path, rel + "/", depth + 1); continue }
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("hard project contains a non-regular or linked file")
      if (manifest.length >= HARD_COLLECTION_LIMITS.files || stat.size > HARD_COLLECTION_LIMITS.fileBytes || total + stat.size > HARD_COLLECTION_LIMITS.totalBytes)
        throw new Error("hard project file or byte bound exceeded")
      const bytes = readDirectBounded(path, Math.min(HARD_COLLECTION_LIMITS.fileBytes, HARD_COLLECTION_LIMITS.totalBytes - total))
      files[rel] = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      manifest.push({ path: rel, bytes: bytes.length, sha256: hash(bytes) }); total += bytes.length
    }
  }
  if (!direct(root).isDirectory()) throw new Error("hard project is not a directory")
  walk(root, "", 0)
  return { files, manifest, excluded, bytes: total, limits: HARD_COLLECTION_LIMITS }
}

/** Reuses the existing host, metering, census, cleanup and result lifecycle. */
export async function runHardBenchmarkCohort(config: import("./build-benchmark.ts").Config) {
  const { runBuildBenchmark } = await import("./build-benchmark.ts")
  return runBuildBenchmark({ ...config, workload: "hard-development" })
}
if (import.meta.main) {
  if (process.argv[2] === "--qualify") {
    if (!process.argv[3]) throw new Error("Usage: bun scripts/hard-benchmark-cohort.ts --qualify <new-evidence.json>")
    const path = resolve(process.argv[3])
    if (existsSync(path)) throw new Error("Qualification evidence destination exists; no implicit overwrite")
    const evidence = await qualifyHardBenchmarkCohortInputs()
    mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" })
    try { validateHardQualification(evidence, evidence.identities, createHardBenchmarkFixtures()) }
    catch (error) { console.error(String(error)); process.exitCode = 1 }
  } else {
    if (!process.argv[2]) throw new Error("Usage: bun scripts/hard-benchmark-cohort.ts <prospective-config.json>")
    await runHardBenchmarkCohort(JSON.parse(readFileSync(resolve(process.argv[2]), "utf8")))
  }
}

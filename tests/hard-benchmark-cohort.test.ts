import { afterEach, describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { BUILD_BENCHMARK_CONTROL_LIMITS } from "../scripts/build-benchmark.ts"
import { BENCHMARK_CASES } from "../scripts/build-benchmark-fixtures.ts"
import { createAcceptedQueryLostAckFixture, createHardBenchmarkFixtures } from "../scripts/hard-benchmark-fixtures.ts"
import { benchmarkTaskPrompt, collectHardProject, collectHardRunProgress, HARD_COLLECTION_LIMITS, HARD_PROGRESS_LIMITS, HARD_ISOLATION, hardBenchmarkIdentity,
  hardRunnerCase, HardLimitsSchema, prepareBenchmarkWorkload, readHardQualification, scheduleBenchmarkWorkload,
  terminalHardRows, validateHardQualification, type WorkloadOptions } from "../scripts/hard-benchmark-cohort.ts"
import { summarizeIssuedArms } from "../scripts/build-benchmark-protocol.ts"
import { sha256Json } from "../src/persistence.ts"

const repo = resolve(import.meta.dir, "..")
const roots: string[] = []
const temporaryRoot = join(repo, ".test-tmp")
function project() {
  const path = join(temporaryRoot, "hard-cohort-unit-" + randomUUID())
  mkdirSync(path, { recursive: true }); roots.push(path); return path
}
afterEach(() => {
  for (const path of roots.splice(0)) {
    const rel = relative(temporaryRoot, path)
    if (!rel || rel.startsWith("..") || rel.includes("/") || rel.includes("\\")) throw new Error("invalid fixture cleanup target")
    rmSync(path, { recursive: true, force: true })
  }
})
function put(root: string, path: string, content: string | Buffer) {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content)
}
const limits = { trialMs: 1_000, assistantTurns: 8, reportedComponents: 1_000, outputTokens: 128, suiteMs: 12_000 }
const hardConfig = (): WorkloadOptions => ({ workload: "hard-development", hardLimits: { ...limits }, orderSeed: 12345, hardQualification: "external-qualification.json" })
const select = (options: WorkloadOptions) => prepareBenchmarkWorkload(options, BENCHMARK_CASES, BUILD_BENCHMARK_CONTROL_LIMITS)

describe("hard development prospective selection", () => {
  test("historic controls retain limits, subset order, arm order and disabled native compaction", () => {
    expect(BUILD_BENCHMARK_CONTROL_LIMITS).toEqual({ trialMs: 480_000, assistantTurns: 40, reportedComponents: 200_000, outputTokens: 4096, suiteMs: 3_300_000 })
    const selected = select({ caseIds: [BENCHMARK_CASES[1]!.id, BENCHMARK_CASES[0]!.id] })
    expect(selected.cases.map(c => c.id)).toEqual([BENCHMARK_CASES[0]!.id, BENCHMARK_CASES[1]!.id])
    expect(selected.limits).toEqual(BUILD_BENCHMARK_CONTROL_LIMITS)
    expect(selected.compaction).toEqual({ auto: false, prune: false })
    expect(scheduleBenchmarkWorkload(selected, "default").map(item => item.order)).toEqual([["build", "alg_default"], ["alg_default", "build"]])
    expect(() => select({ caseIds: [] })).toThrow("caseIds")
    expect(() => select({ caseIds: ["unknown"] })).toThrow("caseIds")
    for (const override of [{ hardLimits: limits }, { orderSeed: 0 }, { hardQualification: "receipt" }])
      expect(() => select(override)).toThrow("forbidden for controls")
  })

  test("hard admission requires explicit bounded limits, seed, qualification and the complete six cases", () => {
    expect(() => select({ workload: "hard-development" })).toThrow()
    for (const key of ["hardLimits", "orderSeed", "hardQualification"] as const) {
      const input = hardConfig(); delete input[key]
      expect(() => select(input)).toThrow()
    }
    for (const orderSeed of [NaN, Infinity, -1, 1.5, 2 ** 32]) expect(() => select({ ...hardConfig(), orderSeed })).toThrow()
    for (const key of Object.keys(limits) as (keyof typeof limits)[]) {
      for (const value of [NaN, Infinity, 0, -1, 1.25])
        expect(HardLimitsSchema.safeParse({ ...limits, [key]: value }).success).toBe(false)
    }
    expect(HardLimitsSchema.safeParse({ ...limits, suiteMs: 11_999 }).success).toBe(false)
    for (const [key, value] of Object.entries({ trialMs: 86_400_001, assistantTurns: 10_001, reportedComponents: 100_000_001,
      outputTokens: 131_073, suiteMs: 604_800_001 })) expect(HardLimitsSchema.safeParse({ ...limits, [key]: value }).success).toBe(false)
    expect(HardLimitsSchema.safeParse({ ...limits, extra: true }).success).toBe(false)
    expect(() => select({ ...hardConfig(), caseIds: ["accepted-query-lost-ack-v1-0"] })).toThrow("all six")
    expect(() => select({ ...hardConfig(), track: "targeted_compatibility" })).toThrow("default")
    const selected = select(hardConfig())
    expect(selected.cases).toHaveLength(6)
    expect(selected.hardFixtures.filter(f => f.contestant.family === "factory-evidence")).toHaveLength(3)
    expect(selected.compaction).toEqual({ auto: true, prune: true })
    expect(selected.cases.every(c => c.followupPrompt === undefined)).toBe(true)
  })

  test("seeded fixture and alternating arm order are bound before all twelve issues", () => {
    const first = select(hardConfig()), again = select(hardConfig())
    expect(first.planSha256).toBe(again.planSha256)
    expect(first.cases.map(c => c.id)).toEqual(again.cases.map(c => c.id))
    const issued = scheduleBenchmarkWorkload(first, "default")
    expect(issued.flatMap(i => i.order)).toHaveLength(12)
    expect(new Set(issued.map(i => i.fixture.id)).size).toBe(6)
    for (let i = 1; i < issued.length; i++) expect(issued[i]!.order).toEqual([...issued[i - 1]!.order].reverse())
    expect(select({ ...hardConfig(), orderSeed: 54321 }).planSha256).not.toBe(first.planSha256)
    expect(Object.isFrozen(first.hardFixtures)).toBe(true)
    expect(Object.isFrozen(first.hardFixtures[0]!.grader)).toBe(true)
    expect(Object.isFrozen(first.cases[0]!.files)).toBe(true)
    expect(() => { first.cases[0]!.files["injected"] = "changed" }).toThrow()
  })

  test("case conversion supplies original criteria and never serializes the grader", () => {
    for (const record of createHardBenchmarkFixtures()) {
      const converted = hardRunnerCase(record)
      expect(converted.initialPrompt.startsWith(record.contestant.request)).toBe(true)
      for (const criterion of record.contestant.criteria) expect(converted.initialPrompt).toContain(criterion)
      expect(converted.files).toEqual(record.contestant.files)
      expect(converted.initialPrompt).not.toContain("protectedHashes")
      expect(converted.initialPrompt).not.toContain("allowedWritePaths")
      expect(converted.followupPrompt).toBeUndefined()
    }
  })

  test("the common service exception and Node fetch usage are identical for both arms", () => {
    const common = "Work locally. Do not install packages or use network services."
    const task = hardRunnerCase(createAcceptedQueryLostAckFixture()).initialPrompt
    const build = benchmarkTaskPrompt(common, task, "http://127.0.0.1:49321")
    const alg = benchmarkTaskPrompt(common, task, "http://127.0.0.1:49321")
    expect(build).toBe(alg)
    expect(build).toContain("except the supplied fixture HTTP endpoint on 127.0.0.1")
    expect(build).toContain("node -e")
    expect(build).toContain("fetch(")
    for (const privateName of [".evidence(", "replaceSource", "service-state.sqlite", "hard-benchmark-fixtures.ts", "protectedHashes"])
      expect(build).not.toContain(privateName)
    expect(benchmarkTaskPrompt(common, task)).toBe(common + "\n\n" + task)
    expect(() => benchmarkTaskPrompt(common, task, "https://example.com")).toThrow()
  })

  test("fatal termination keeps all issued arms with terminal error receipts", () => {
    const rows = scheduleBenchmarkWorkload(select(hardConfig()), "default").flatMap(issue => issue.pair.arms.map(arm => ({ pairId: issue.pair.pairId, arm: arm.arm, status: arm.status as string })))
    rows[0]!.status = "completed"; rows[1]!.status = "running"
    const closed = terminalHardRows(rows, "setup failure")
    expect(closed).toHaveLength(12)
    expect(closed[0]!.status).toBe("completed")
    expect(closed.slice(1).every(row => row.status === "stopped" && "stopReason" in row && row.stopReason === "setup failure")).toBe(true)
    expect(summarizeIssuedArms(closed)).toMatchObject({ issued: 12, completed: 1, stopped: 11, primaryDenominator: 12, complete: true })
    expect(rows[1]!.status).toBe("running")
  })
})

describe("bounded complete hard project collection", () => {
  test("post-stop runtime progress is bounded and remains outside grader input", () => {
    const root = project(), fixture = createAcceptedQueryLostAckFixture()
    put(root, ".opencode/runs/run_a/progress.json", JSON.stringify({ run_id: "run_a", status: "blocked", phase: "task-allowance",
      global_attempts: 1, nodes: { worker: { id: "worker", status: "failed", attempts: [{ outcome: "failed", failures: ["lock contention"], session_id: "child" }] } } }))
    expect(collectHardProject(root, fixture).files[".opencode/runs/run_a/progress.json"]).toBeUndefined()
    expect(collectHardRunProgress(root)).toMatchObject({ coverage: "complete_inline", runDirectories: 1,
      states: [{ run_id: "run_a", phase: "task-allowance", nodes: [{ attempts: [{ failures: ["lock contention"] }] }] }] })
    put(root, ".opencode/runs/run.a/progress.json", JSON.stringify({ run_id: "run.a", status: "blocked", nodes: {
      checker: { id: "checker", status: "failed", attempts: [], attempt_history_ref: { attempt_count: 5 } },
    } }))
    expect(collectHardRunProgress(root)).toMatchObject({ coverage: "inline_recent_with_archived_attempts", archivedAttempts: 5 })
    put(root, ".opencode/runs/run_a/progress.json", "x".repeat(HARD_PROGRESS_LIMITS.fileBytes + 1))
    expect(() => collectHardRunProgress(root)).toThrow("byte bound")
  })

  test("preserves protected evidence and unknown writes while excluding only known runtime metadata", () => {
    const root = project(), fixture = createAcceptedQueryLostAckFixture()
    for (const [path, body] of Object.entries(fixture.contestant.files)) put(root, path, body)
    put(root, "report.json", "{}")
    put(root, "unexpected.txt", "unauthorized")
    put(root, "node_modules/unknown.js", "unexpected code")
    put(root, ".opencode/skills/test/SKILL.md", "visible evidence")
    put(root, ".opencode/unknown.json", "unexpected configuration")
    put(root, ".opencode/runs/run/progress.json", "runtime")
    put(root, ".opencode/session-memory/checkpoint.json", "runtime")
    put(root, ".git/config", "host git state")
    const result = collectHardProject(root, fixture)
    expect(result.files["README.md"]).toBe(fixture.contestant.files["README.md"])
    expect(result.files["unexpected.txt"]).toBe("unauthorized")
    expect(result.files["node_modules/unknown.js"]).toBe("unexpected code")
    expect(result.files[".opencode/skills/test/SKILL.md"]).toBe("visible evidence")
    expect(result.files[".opencode/unknown.json"]).toBe("unexpected configuration")
    expect(result.files[".opencode/runs/run/progress.json"]).toBeUndefined()
    expect(result.excluded).toEqual([".git", ".opencode/runs", ".opencode/session-memory"])
    expect(result.manifest.map(row => row.path)).toEqual(Object.keys(result.files))
  })

  test("a fixture file under a runtime name remains visible with all sibling writes", () => {
    const root = project(), fixture = createAcceptedQueryLostAckFixture()
    fixture.contestant.files = { ...fixture.contestant.files, ".opencode/runs/evidence.txt": "protected" }
    put(root, ".opencode/runs/evidence.txt", "protected"); put(root, ".opencode/runs/extra.txt", "unknown")
    expect(collectHardProject(root, fixture).files).toEqual({ ".opencode/runs/evidence.txt": "protected", ".opencode/runs/extra.txt": "unknown" })
  })

  test("symlinks, oversized and non-UTF8 files reject collection instead of hiding writes", () => {
    const root = project(), target = project(), fixture = createAcceptedQueryLostAckFixture()
    symlinkSync(target, join(root, "redirect"), process.platform === "win32" ? "junction" : "dir")
    expect(() => collectHardProject(root, fixture)).toThrow("symlink")
    const oversized = project()
    put(oversized, "unexpected.bin", Buffer.alloc(HARD_COLLECTION_LIMITS.fileBytes + 1))
    expect(() => collectHardProject(oversized, fixture)).toThrow("bound")
    const binary = project(); put(binary, "unknown.bin", Buffer.from([0xff]))
    expect(() => collectHardProject(binary, fixture)).toThrow()
  })
})

describe("external development qualification evidence", () => {
  const fixtures = createHardBenchmarkFixtures()
  function mockEvidence() {
    const result = (selected: typeof fixtures) => {
      const results = selected.flatMap(f => (["positive", "negative", "tamper"] as const).map(kind => ({
        fixtureId: f.contestant.id, family: f.contestant.family, case: kind, status: "passed" as const, passed: true,
        expected: kind === "positive" ? "accept" as const : "reject" as const, isolation: HARD_ISOLATION,
        grade: { passed: kind === "positive", checks: [{ id: "mock-local-schema-test", passed: kind === "positive" }], metrics: {} },
      })))
      return { isolation: HARD_ISOLATION, results, passed: true, caseCount: results.length, acceptedPositive: selected.length,
        rejectedNegativeOrTamper: selected.length * 2, blockedCases: 0, failedCases: 0 }
    }
    return { schema: "alg-hard-development-qualification-v1" as const, generated_at: "2026-11-12T12:00:00Z",
      identities: hardBenchmarkIdentity(repo, fixtures), development: result(fixtures),
      public_http: result(fixtures.filter(f => ["accepted-query-lost-ack", "partial-investigation-restart"].includes(f.contestant.family))) }
  }
  test("identities bind frozen fixtures and all host, grader, service, qualification and runner inputs", () => {
    const identities = hardBenchmarkIdentity(repo, fixtures)
    expect(identities.hard_fixtures_sha256).toBe(sha256Json(fixtures))
    expect(identities.grader_sha256).toBe(identities.fixtures_source_sha256)
    for (const key of ["cohort_sha256", "host_sha256", "qualification_sha256", "service_sha256", "runner_sha256"] as const)
      expect(identities[key]).toMatch(/^[0-9a-f]{64}$/)
    const altered = structuredClone(fixtures); altered[0]!.contestant.request += " changed"
    expect(hardBenchmarkIdentity(repo, altered).hard_fixtures_sha256).not.toBe(identities.hard_fixtures_sha256)
    expect(readFileSync(join(repo, "scripts/hard-benchmark-host.ts"), "utf8")).not.toBe("")
  })
  test("strict receipt parsing recomputes coverage and grade agreement instead of trusting passed", () => {
    const input = mockEvidence()
    expect(validateHardQualification(input, input.identities, fixtures)).toEqual(input)
    const root = project(), path = join(root, "mock-qualification.json")
    put(root, "mock-qualification.json", JSON.stringify(input))
    expect(readHardQualification(path, input.identities, fixtures).evidence).toEqual(input)
    const missing = structuredClone(input); missing.public_http.results.pop()
    expect(() => validateHardQualification(missing, input.identities, fixtures)).toThrow("incomplete")
    const forgedPass = structuredClone(input); forgedPass.development.results[0]!.grade.checks[0]!.passed = false
    expect(() => validateHardQualification(forgedPass, input.identities, fixtures)).toThrow("inconsistent")
    const duplicated = structuredClone(input); duplicated.public_http.results[1] = duplicated.public_http.results[0]!
    expect(() => validateHardQualification(duplicated, input.identities, fixtures)).toThrow("coverage")
    const drift = { ...input.identities, host_sha256: "0".repeat(64) }
    expect(() => validateHardQualification(input, drift, fixtures)).toThrow("identities changed")
    expect(() => validateHardQualification({ ...input, self_certified: true }, input.identities, fixtures)).toThrow()
  })
})

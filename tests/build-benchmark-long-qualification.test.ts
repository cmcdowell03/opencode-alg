import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { longBenchmarkIdentity, qualifyLongSession, readLongQualification } from "../scripts/build-benchmark-long-qualification.ts"
import { prepareBenchmarkWorkload, scheduleBenchmarkWorkload } from "../scripts/hard-benchmark-cohort.ts"
import { createLongSessionCases } from "../scripts/build-benchmark-long-fixtures.ts"
import { summarizeLongSessionCohort } from "../scripts/build-benchmark-long-report.ts"

test("long schedule contains all eight paired cells with identical data within incident and cumulative limits", () => {
  const cases = createLongSessionCases(), limits = { trialMs: 1000, assistantTurns: 100, reportedComponents: 100000, outputTokens: 4096, suiteMs: 16000 }
  const selection = prepareBenchmarkWorkload({ workload: "long-session", hardLimits: limits, orderSeed: 71, hardQualification: "receipt.json" }, [], limits)
  expect(scheduleBenchmarkWorkload(selection, "default")).toHaveLength(8)
  expect(cases).toHaveLength(8)
  for (const incident of new Set(cases.map(c => c.incident))) {
    const selected = cases.filter(c => c.incident === incident)
    for (const c of selected) expect(c.fixture.contestant.files).toEqual(selected[0]!.fixture.contestant.files)
  }
  expect(() => prepareBenchmarkWorkload({ workload: "long-session", hardLimits: { ...limits, suiteMs: 15999 }, orderSeed: 1, hardQualification: "receipt" }, [], limits)).toThrow()
})

test("HTTP references and negative controls qualify all cases; missing, altered or inconsistent receipts fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "long-receipt-"))
  try {
    const result = await qualifyLongSession(), path = join(directory, "receipt.json")
    expect(result.passed).toBe(true)
    expect(result.rows).toHaveLength(80)
    writeFileSync(path, JSON.stringify(result))
    const identity = longBenchmarkIdentity(resolve(import.meta.dir, ".."))
    expect(readLongQualification(path, identity).evidence.passed).toBe(true)
    const original = readFileSync(path, "utf8")
    for (const change of [
      (r: any) => r.rows.pop(),
      (r: any) => r.rows.push(r.rows[0]),
      (r: any) => r.identity.sources["build-benchmark.ts"] = "f".repeat(64),
      (r: any) => r.rows[0].checks[0].passed = false,
      (r: any) => r.rows[0].control = "unlisted",
    ]) {
      const bad = JSON.parse(original); change(bad); writeFileSync(path, JSON.stringify(bad))
      expect(() => readLongQualification(path, identity)).toThrow()
    }
  } finally { await rm(directory, { recursive: true, force: true }) }
}, 60000)

test("all-issued comparison retains failed and unstarted arms with unavailable retention rates", () => {
  const result = summarizeLongSessionCohort([
    { caseId: "a", arm: "build", status: "completed", scored_task_success: true },
    { caseId: "a", arm: "alg_default", status: "stopped", scored_task_success: false },
    { caseId: "b", arm: "build", status: "issued_not_started" },
    { caseId: "b", arm: "alg_default", status: "issued_not_started" },
  ])
  expect(result.pairs.map(p => p.difference)).toEqual([-1, 0])
  expect(result.byArm.build!.issued).toBe(2)
  expect(result.byArm.alg_default!.behavioral.rate).toBeNull()
  expect(result.commonEligibleCount).toBe(0)
})

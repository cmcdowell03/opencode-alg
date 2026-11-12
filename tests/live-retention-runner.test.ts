import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { LIVE_LIMITS, aggregateRetention, observedStopReason, retentionDelta, retentionEvidenceQualified, summaryBoundaryQualified, verifyFixtureSkills, validateDiagnosticContinuation } from "../scripts/live-retention.ts"
import type { RetentionCheck, RetentionScore } from "../scripts/live-retention-fixture.ts"
import { summarizeSessionMetrics } from "../scripts/build-benchmark-metrics.ts"

const check = (id: string, expectedDigest: string, passed = true): RetentionCheck =>
  ({ id, category: "criteria", expectedDigest, observedDigest: passed ? "observed" : null, passed })
const score = (...checks: RetentionCheck[]): RetentionScore => ({ passed: checks.every(c => c.passed), checks, diagnostics: [] })
const linked = (scorePassed: boolean) => ({ requestAcceptance: "accepted", marker: { matchesRequest: true, outcome: "new_and_persisted" },
  summary: { outcome: "terminal_linked" }, continuation: { status: "completed", scorePassed } })

describe("live retention runner evidence guards", () => {
  test("apparatus continuation cannot reset time or usage or replay already compacted work", () => {
    const prior = { schema: "alg-live-retention-diagnostic-v1", status: "stopped", stopReason: "preparation_not_qualified", model: "test/model",
      phases: [{ phase: 0 }], receipts: [], cleanup: true, authCopyRemoved: true, sourceUnchanged: true, dbCensus: { qualified: true }, startedAt: 1000,
      rootSession: "session", metrics: summarizeSessionMetrics([], []) }
    expect(validateDiagnosticContinuation(prior, "test/model", "digest", 2000)).toEqual({ startedAt: 1000, deadline: 1000 + LIVE_LIMITS.wallMs, rootSession: "session" })
    expect(() => validateDiagnosticContinuation(prior, "test/model", "digest", 1000 + LIVE_LIMITS.wallMs)).toThrow()
    expect(() => validateDiagnosticContinuation({ ...prior, receipts: [{}] }, "test/model", "digest", 2000)).toThrow()
    expect(() => validateDiagnosticContinuation({ ...prior, model: "other" }, "test/model", "digest", 2000)).toThrow()
    prior.metrics.usage.totalReportedTokens = LIVE_LIMITS.reportedUsageComponents
    expect(() => validateDiagnosticContinuation(prior, "test/model", "digest", 2000)).toThrow()
  })
  test("observed stop thresholds include equality and wall expiry", () => {
    const base = summarizeSessionMetrics([], [])
    expect(observedStopReason(base, 99, 100)).toBeNull()
    expect(observedStopReason(base, 100, 100)).toBe("wall_deadline")
    expect(observedStopReason({ ...base, assistantTurns: { ...base.assistantTurns, total: LIVE_LIMITS.assistantTurns } }, 99, 100)).toBe("observed_assistant_turn_threshold")
    expect(observedStopReason({ ...base, usage: { ...base.usage, totalReportedTokens: LIVE_LIMITS.reportedUsageComponents } }, 99, 100)).toBe("observed_usage_component_threshold")
  })

  test("vanished and duplicate checks count as loss; changed expectations leave the denominator", () => {
    const before = score(check("keep", "old"), check("missing", "old"), check("duplicate", "old"), check("updated", "old"), check("never-passed", "old", false))
    const after = score(check("keep", "old"), check("duplicate", "old"), check("duplicate", "old"), check("updated", "new"), check("never-passed", "old"))
    const delta = retentionDelta(before, after)
    expect(delta.atRisk).toBe(3)
    expect(delta.retained).toBe(1)
    expect(delta.observedLosses).toBe(2)
    expect(delta.comparable.find(c => c.id === "missing")?.status).toBe("missing_or_ambiguous")
    expect(delta.comparable.find(c => c.id === "duplicate")?.status).toBe("missing_or_ambiguous")
  })

  test("rates require complete, linked, quiescent, persisted evidence", () => {
    const good = { stopped: false, phases: 7, expectedPhases: 7, finalQuiescent: true, dbQualified: true,
      receipts: Array.from({ length: LIVE_LIMITS.requestedCompactions }, () => linked(true)) }
    expect(retentionEvidenceQualified(good)).toBe(true)
    for (const patch of [{ stopped: true }, { phases: 6 }, { finalQuiescent: false }, { dbQualified: false },
      { receipts: good.receipts.slice(1) }, { receipts: [{ ...linked(true), summary: { outcome: "missing" } }, ...good.receipts.slice(1)] }]) {
      expect(retentionEvidenceQualified({ ...good, ...patch })).toBe(false)
    }
    expect(LIVE_LIMITS.restartAfterCompactions).toEqual([3, 5])
  })

  test("headline retention excludes unqualified summary boundaries but preserves their diagnostic losses", () => {
    const phases = [{ phase: 0, delta: null }, { phase: 1, delta: { atRisk: 3, observedLosses: 1 } },
      { phase: 2, delta: { atRisk: 4, observedLosses: 2 } }]
    expect(summaryBoundaryQualified(linked(false))).toBe(true)
    expect(aggregateRetention(phases, [linked(false), { ...linked(true), summary: { outcome: "missing" } }])).toMatchObject({
      qualifiedBoundaries: 1, unqualifiedBoundaries: 1, observedBoundaries: 2, plannedBoundaries: 6,
      atRisk: 3, observedLosses: 1, observedLossRate: 1 / 3, diagnosticAtRisk: 7, diagnosticObservedLosses: 3,
    })
    expect(aggregateRetention([{ phase: 0, delta: null }], []).observedLossRate).toBeNull()
  })

  test("fixture skill discovery requires exact location and current body", () => {
    const project = join(process.cwd(), "synthetic-project"), path = ".opencode/skills/wafer-retention/SKILL.md"
    const files = { [path]: "---\nname: wafer-retention\n---\n# Current procedure\n" }
    const row = { name: "wafer-retention", location: join(project, path), content: "# Current procedure" }
    expect(verifyFixtureSkills([row], project, files)).toHaveLength(1)
    expect(() => verifyFixtureSkills([{ ...row, content: "# Stale procedure" }], project, files)).toThrow("fixture_skill_mismatch")
    expect(() => verifyFixtureSkills([{ ...row, location: join(project, "other/SKILL.md") }], project, files)).toThrow("fixture_skill_mismatch")
    expect(() => verifyFixtureSkills([], project, {})).toThrow("fixture_skill_missing")
  })
})

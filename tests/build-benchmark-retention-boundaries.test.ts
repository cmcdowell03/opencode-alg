import { describe, expect, test } from "bun:test"
import { measureRetentionBoundaries, retentionFrozenSetDigest, retentionObligationDigest, type RetentionBoundary, type RetentionBoundaryObservation } from "../scripts/build-benchmark-retention-boundaries.ts"

const d = (c: string) => c.repeat(64)
const basis = { phase: "execute", skillId: null, skillVersion: null, sourceRef: "src:v1", evidenceRef: null,
  pendingIntentId: null, budget: 3, nextAction: "verify" }
const obligation = (id = "goal", disposition: "required" | "superseded" | "revoked" = "required") => {
  const value = { obligationId: id, category: "criteria" as const, disposition, expectedDigest: d("a"), basis }
  return { ...value, frozenBy: { provenance: "external_evaluator" as const, evidenceId: `oracle-${id}`, digest: retentionObligationDigest(value) } }
}
function freeze(b: RetentionBoundary) {
  b.frozenSetDigest = retentionFrozenSetDigest(b)
  if (b.summaryEvidence) b.summaryEvidence.frozenSetDigest = b.frozenSetDigest
  return b
}
function boundary(id: string, taskId = "task", sessionId = "s1", start = 10): RetentionBoundary {
  const b: RetentionBoundary = { boundaryId: id, taskId, sessionId, requestId: `request-${id}`, transition: "compaction", compactionMode: "requested", frozenAt: start, transitionAt: start + 1,
    requestAt: start + 1, summaryAt: start + 2, summarySucceeded: true,
    frozenSetDigest: d("e"), summaryEvidence: { eventId: `summary-${id}`, requestId: `request-${id}`, taskId, sessionId, observedAt: start + 2, digest: d("c"), frozenSetDigest: d("e") },
    before: { observedAt: start, complete: true, facts: [{ obligationId: "goal", digest: d("a") }] },
    after: { observedAt: start + 3, complete: true, facts: [{ obligationId: "goal", digest: d("a") }] },
    obligations: [obligation()], boundaryCensusComplete: true, useWindow: null, nextTaskBoundaryAt: null }
  return freeze(b)
}
function observation(boundaryId: string, eventId: string, kind: RetentionBoundaryObservation["kind"], outcome: RetentionBoundaryObservation["outcome"], at: number,
  more: Partial<RetentionBoundaryObservation> = {}): RetentionBoundaryObservation {
  return { eventId, boundaryId, taskId: "task", sessionId: boundaryId === "b2" ? "s2" : "s1", at, obligationId: "goal", kind, outcome,
    digest: null, governedActionExposed: null, independentlyEvaluated: true, workUnits: null, ...more }
}
const payload = (boundaries: RetentionBoundary[], observations: RetentionBoundaryObservation[] = []) => ({
  schema: "build-benchmark-retention-boundaries/v1" as const, boundaries, observations,
})

describe("per-compaction retention boundaries", () => {
  test("completed summaries remain boundaries when later behavior is wrong or unobserved", () => {
    const wrong = boundary("b1", "task", "s1", 10)
    const missing = boundary("b2", "task", "s2", 20)
    const report = measureRetentionBoundaries(payload([wrong, missing], [
      observation("b1", "wrong-answer", "behavior", "incorrect", 13, { digest: d("f") }),
    ]))
    if (report.status !== "measured") throw new Error("expected measurements")
    expect(report.boundaries.map(b => b.valid)).toEqual([true, true])
    expect(report.boundaries.map(b => b.facts[0]?.assessment)).toEqual(["failure_observed", "unknown"])
    expect(report.totals).toEqual({ boundaryCount: 2, obligationCount: 2, measured: 1, unknown: 1, invalidBoundaryCount: 0 })
    // Missing census evidence prevents assessment, but never deletes the boundary.
    wrong.boundaryCensusComplete = false
    const incomplete = measureRetentionBoundaries(payload([wrong, missing], [
      observation("b1", "wrong-answer", "behavior", "incorrect", 13, { digest: d("f") }),
    ]))
    if (incomplete.status !== "measured") throw new Error("expected measurements")
    expect(incomplete.totals).toEqual({ boundaryCount: 2, obligationCount: 2, measured: 0, unknown: 2, invalidBoundaryCount: 1 })
    expect(incomplete.issues.map(issue => issue.code)).toContain("boundary_census_incomplete")
  })

  test("preserves first-boundary failure when the next boundary recovers", () => {
    const first = boundary("b1", "task", "s1", 10)
    const second = boundary("b2", "task", "s2", 20)
    second.compactionMode = "native"
    first.nextTaskBoundaryAt = 21
    const report = measureRetentionBoundaries(payload([first, second], [
      observation("b1", "wrong", "retrieval", "stale", 12, { digest: d("f") }),
      observation("b1", "bad-action", "behavior", "incorrect", 13, { digest: d("f") }),
      observation("b2", "recovered", "behavior", "correct", 23, { digest: d("a") }),
    ]))
    expect(report.status).toBe("measured")
    if (report.status !== "measured") return
    expect(report.boundaries.map(b => b.facts[0]?.assessment)).toEqual(["failure_observed", "no_failure_observed"])
    expect(report.boundaries.map(b => b.compactionMode)).toEqual(["requested", "native"])
    expect(report.totals).toMatchObject({ boundaryCount: 2, obligationCount: 2, measured: 2, unknown: 0 })
    expect(report.interpretation).toContain("No causal effect")
  })

  test("distinguishes durable presence, context omission, retrieval, and behavior", () => {
    const b = boundary("b")
    b.after.facts = []
    const r = measureRetentionBoundaries(payload([b], [
      observation("b", "context-omitted", "context", "absent", 12),
      observation("b", "found", "retrieval", "found", 12, { digest: d("a") }),
      observation("b", "correct", "behavior", "correct", 13, { digest: d("a") }),
    ]))
    if (r.status !== "measured") throw new Error("expected measurements")
    expect(r.boundaries[0]?.facts[0]).toMatchObject({ durablePresent: false, contextProjection: "absent", retrieval: "found", assessment: "no_failure_observed" })
  })

  test("missing or incomplete evidence is unknown rather than a zero or pass", () => {
    const b = boundary("b")
    b.before.complete = false; b.after.complete = false; b.after.facts = []
    const r = measureRetentionBoundaries(payload([b]))
    if (r.status !== "measured") throw new Error("expected measurements")
    expect(r.boundaries[0]?.facts[0]).toMatchObject({ beforePresent: null, durablePresent: null, durableCurrent: null, assessment: "unknown" })
    expect(r.boundaries[0]?.counts).toMatchObject({ measured: 0, unknown: 1, coverage: 0 })
  })

  test("requires actual governed action exposure to assess prohibited or revoked use", () => {
    const b = boundary("b")
    b.obligations = [obligation("old-skill", "revoked")]
    b.before.facts = [{ obligationId: "old-skill", digest: d("a") }]
    b.after.facts = []
    b.useWindow = { startAt: 12, endAt: 13, complete: true }
    freeze(b)
    const unexposed = observation("b", "no-exposure", "use", "used", 12, { obligationId: "old-skill", digest: d("a"), governedActionExposed: false })
    const noExposureReport = measureRetentionBoundaries(payload([b], [unexposed]))
    if (noExposureReport.status !== "measured") throw new Error("expected measurements")
    expect(noExposureReport.boundaries[0]?.facts[0]?.assessment).toBe("unknown")
    const exposed = { ...unexposed, eventId: "exposed", governedActionExposed: true }
    const r = measureRetentionBoundaries(payload([b], [unexposed, exposed]))
    if (r.status !== "measured") throw new Error("expected measurements")
    expect(r.boundaries[0]?.facts[0]).toMatchObject({ governedActionExposed: true, assessment: "failure_observed" })
  })

  test("uses exact snapshots; a complete empty snapshot differs from an absent snapshot", () => {
    const b = boundary("b")
    b.after.facts = []
    const r = measureRetentionBoundaries(payload([b]))
    if (r.status !== "measured") throw new Error("expected measurements")
    expect(r.boundaries[0]?.facts[0]?.durablePresent).toBe(false)
    b.after.complete = false
    const unknown = measureRetentionBoundaries(payload([b]))
    if (unknown.status !== "measured") throw new Error("expected measurements")
    expect(unknown.boundaries[0]?.facts[0]?.durablePresent).toBeNull()
  })

  test("reports stale retrieval even if later behavior is correct", () => {
    const r = measureRetentionBoundaries(payload([boundary("b")], [
      observation("b", "stale", "retrieval", "stale", 12, { digest: d("f") }),
      observation("b", "correct", "behavior", "correct", 13, { digest: d("a") }),
    ]))
    if (r.status !== "measured") throw new Error("expected measurements")
    expect(r.boundaries[0]?.facts[0]).toMatchObject({ retrieval: "stale", assessment: "failure_observed" })
  })

  test("separates reassignment from compaction and scopes unrelated task/session evidence", () => {
    const handoff = boundary("handoff", "task", "new-session", 10)
    handoff.transition = "reassignment"; handoff.compactionMode = null; handoff.transitionAt = 11; handoff.requestAt = null
    handoff.summaryAt = null; handoff.summarySucceeded = false; handoff.summaryEvidence = null
    const foreign = observation("handoff", "foreign", "behavior", "correct", 12, { taskId: "other", sessionId: "elsewhere", digest: d("a") })
    const r = measureRetentionBoundaries(payload([handoff], [foreign]))
    expect(r.status).toBe("measured")
    if (r.status !== "measured") return
    expect(r.boundaries[0]).toMatchObject({ transition: "reassignment", valid: false })
    expect(r.issues.map(i => i.code)).toContain("observation_scope_conflict")
    expect(r.boundaries[0]?.counts.unknown).toBe(1)
  })

  test("flags invalid time order and prevents observations crossing the next task boundary", () => {
    const a = boundary("a", "task", "s1", 10), b = boundary("b", "task", "s2", 20)
    a.summaryAt = 9
    a.after.observedAt = 22
    const r = measureRetentionBoundaries(payload([a, b], [observation("a", "late", "behavior", "correct", 22, { digest: d("a") })]))
    expect(r.status).toBe("measured")
    if (r.status !== "measured") return
    expect(r.boundaries[0]?.valid).toBe(false)
    expect(r.issues.map(i => i.code)).toContain("invalid_compaction_time_order")
    expect(r.issues.map(i => i.code)).toContain("after_crosses_next_boundary")
    expect(r.issues.map(i => i.code)).toContain("observation_time_out_of_scope")
  })

  test("empty input is unavailable, and schema rejects model-authored provenance and unknown fields", () => {
    expect(measureRetentionBoundaries(payload([]))).toMatchObject({ status: "unavailable", availability: "no_boundary_evidence" })
    const b = boundary("b") as RetentionBoundary & { surprise?: string }
    b.obligations[0]!.frozenBy.provenance = "model" as "external_evaluator"
    b.surprise = "ignored is forbidden"
    expect(measureRetentionBoundaries(payload([b])).status).toBe("invalid_input")
  })

  test("flags summary evidence that does not bind the externally frozen obligation set", () => {
    const b = boundary("b")
    b.summaryEvidence!.frozenSetDigest = d("f")
    const r = measureRetentionBoundaries(payload([b]))
    expect(r.status).toBe("measured")
    if (r.status !== "measured") return
    expect(r.boundaries[0]?.valid).toBe(false)
    expect(r.issues.map(i => i.code)).toContain("frozen_obligations_not_bound_to_summary")
  })

  test("matching caller hash fields cannot substitute for canonical frozen values", () => {
    const b = boundary("b")
    b.obligations[0]!.basis.nextAction = "different"
    b.frozenSetDigest = d("f")
    b.summaryEvidence!.frozenSetDigest = d("f")
    const r = measureRetentionBoundaries(payload([b], [observation("b", "correct", "behavior", "correct", 13, { digest: d("a") })]))
    if (r.status !== "measured") throw new Error("expected measurements")
    expect(r.issues.map(i => i.code)).toContain("obligation_digest_mismatch")
    expect(r.issues.map(i => i.code)).toContain("frozen_set_digest_mismatch")
    expect(r.boundaries[0]?.counts.noFailureObserved).toBe(0)
  })

  test("failed summary, partial census, ambiguous identity, and model-only behavior cannot clear retention", () => {
    const variants = [
      (b: RetentionBoundary) => { b.summarySucceeded = false },
      (b: RetentionBoundary) => { b.boundaryCensusComplete = false },
      (b: RetentionBoundary) => { b.summaryEvidence!.sessionId = "elsewhere" },
    ]
    for (const alter of variants) {
      const b = boundary("b"); alter(b)
      const r = measureRetentionBoundaries(payload([b], [observation("b", "correct", "behavior", "correct", 13, { digest: d("a") })]))
      if (r.status !== "measured") throw new Error("expected measurements")
      expect(r.boundaries[0]?.counts).toMatchObject({ measured: 0, unknown: 1, noFailureObserved: 0 })
    }
    const r = measureRetentionBoundaries(payload([boundary("b")], [observation("b", "model", "behavior", "correct", 13,
      { digest: d("a"), independentlyEvaluated: false })]))
    if (r.status !== "measured") throw new Error("expected measurements")
    expect(r.boundaries[0]?.facts[0]).toMatchObject({ independentBehavior: "unknown", assessment: "unknown" })
  })

  test("interleaved tasks cannot hide the next task boundary or union snapshots", () => {
    const first = boundary("first", "task", "s1", 10)
    const other = boundary("other", "other-task", "s1", 15)
    const next = boundary("next", "task", "s2", 20)
    first.after.observedAt = 22
    const r = measureRetentionBoundaries(payload([first, other, next], [
      observation("next", "recovery", "behavior", "correct", 23, { sessionId: "s2", digest: d("a") }),
    ]))
    if (r.status !== "measured") throw new Error("expected measurements")
    expect(r.issues.map(i => i.code)).toContain("after_crosses_next_boundary")
    expect(r.boundaries[0]?.facts[0]?.assessment).toBe("unknown")
    expect(r.boundaries[2]?.facts[0]?.assessment).toBe("no_failure_observed")
  })

  test("global duplicate evidence invalidates every affected report", () => {
    const first = boundary("first", "task-a", "s1", 10)
    const second = boundary("second", "task-b", "s1", 20)
    const r = measureRetentionBoundaries(payload([first, second], [
      observation("first", "same", "behavior", "correct", 13, { taskId: "task-a", digest: d("a") }),
      observation("second", "same", "behavior", "correct", 23, { taskId: "task-b", digest: d("a") }),
    ]))
    if (r.status !== "measured") throw new Error("expected measurements")
    expect(r.issues.map(i => i.code)).toContain("duplicate_event_id")
    expect(r.boundaries.every(b => !b.valid && b.counts.noFailureObserved === 0)).toBe(true)
  })

  test("revoked use needs a complete exposed window to clear, while observed misuse remains a failure", () => {
    const b = boundary("b")
    b.obligations = [obligation("skill", "revoked")]
    b.before.facts = [{ obligationId: "skill", digest: d("a") }]
    b.after.facts = []
    freeze(b)
    const safe = observation("b", "safe", "use", "not_used", 13, { obligationId: "skill", governedActionExposed: true })
    const check = () => {
      const r = measureRetentionBoundaries(payload([b], [safe]))
      if (r.status !== "measured") throw new Error("expected measurements")
      return r.boundaries[0]?.facts[0]?.assessment
    }
    expect(check()).toBe("unknown")
    b.useWindow = { startAt: 12, endAt: 13, complete: false }
    expect(check()).toBe("unknown")
    b.useWindow.complete = true
    expect(check()).toBe("no_failure_observed")
    b.useWindow.startAt = 13
    const partial = measureRetentionBoundaries(payload([b], [safe]))
    if (partial.status !== "measured") throw new Error("expected measurements")
    expect(partial.issues.map(i => i.code)).toContain("partial_use_window")
    expect(partial.boundaries[0]?.facts[0]?.assessment).toBe("unknown")
    b.useWindow.startAt = 12
    const bad = { ...safe, eventId: "bad", outcome: "used" as const, digest: d("a") }
    const r = measureRetentionBoundaries(payload([b], [safe, bad]))
    if (r.status !== "measured") throw new Error("expected measurements")
    expect(r.boundaries[0]?.facts[0]?.assessment).toBe("failure_observed")
  })
})

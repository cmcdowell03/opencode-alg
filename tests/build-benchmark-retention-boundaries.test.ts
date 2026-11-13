import { describe, expect, test } from "bun:test"
import { measureRetentionBoundaries, retentionFrozenSetDigest, retentionObligationDigest, type RetentionBoundary, type RetentionBoundaryObservation, type RetentionPreBehaviorEvent } from "../scripts/build-benchmark-retention-boundaries.ts"

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

function preEvent(b: RetentionBoundary, more: Partial<RetentionPreBehaviorEvent> = {}): RetentionPreBehaviorEvent {
  return { eventId: `pre-${b.boundaryId}`, sessionId: b.sessionId, at: b.frozenAt, obligationId: "goal", kind: "behavior",
    truthDigest: d("a"), outcome: "correct", independentlyEvaluated: true, governedActionExposed: true,
    evidenceId: `grade-pre-${b.boundaryId}`, digest: d("d"), ...more }
}
function withPre(b = boundary("b")): RetentionBoundary {
  b.preBehavior = { startAt: b.frozenAt - 5, endAt: b.transitionAt, complete: true,
    evidenceId: `trace-${b.boundaryId}`, digest: d("d"), events: [preEvent(b)] }
  return b
}
function graded(b: RetentionBoundary, outcome: "correct" | "incorrect" | "inaccessible" | "unknown", more: Partial<RetentionBoundaryObservation> = {}) {
  return observation(b.boundaryId, `post-${b.boundaryId}`, "behavior", outcome, b.after.observedAt, {
    taskId: b.taskId, sessionId: b.lineage?.recipientSessionId ?? b.sessionId,
    digest: outcome === "correct" ? d("a") : d("f"), governedActionExposed: true,
    gradingEvidence: { evidenceId: `grade-post-${b.boundaryId}`, digest: d("d"), truthDigest: d("a") }, ...more,
  })
}
function measured(boundaries: RetentionBoundary[], observations: RetentionBoundaryObservation[] = []) {
  const report = measureRetentionBoundaries(payload(boundaries, observations))
  if (report.status !== "measured") throw new Error(`expected measurements: ${JSON.stringify(report)}`)
  return report
}
function transition(kind: "control" | "prune" | "reassignment" | "restart") {
  const b = withPre()
  b.transition = kind; b.compactionMode = null; b.requestAt = null; b.summaryAt = null
  b.summarySucceeded = false; b.summaryEvidence = null
  return b
}

describe("optional pre/post behavioral regression", () => {
  test("legacy output and frozen hashes do not change when optional evidence is added or absent", () => {
    const b = boundary("b"), obs = observation("b", "old", "behavior", "incorrect", 13, { digest: d("f") })
    const before = measured([b], [obs])
    expect(before.boundaries[0]).not.toHaveProperty("behavioralRegression")
    const setHash = retentionFrozenSetDigest(b), obligationHash = retentionObligationDigest(b.obligations[0]!)
    withPre(b)
    const after = measured([b], [obs])
    const { behavioralRegression, ...legacy } = after.boundaries[0]!
    expect(legacy).toEqual(before.boundaries[0]!)
    expect(after.totals).toEqual(before.totals)
    expect(retentionFrozenSetDigest(b)).toBe(setHash)
    expect(retentionObligationDigest(b.obligations[0]!)).toBe(obligationHash)
    expect(behavioralRegression?.obligations[0]).toMatchObject({ classification: "pre_correct_post_unknown" })
    expect(legacy.facts[0]?.assessment).toBe("failure_observed")
  })

  test("retains failed and missing follow-up in the exposed pre-correct set and missingness bounds", () => {
    const b = withPre()
    b.obligations = [obligation(), obligation("retained"), obligation("missing")]
    b.before.facts = b.after.facts = b.obligations.map(o => ({ obligationId: o.obligationId, digest: o.expectedDigest }))
    b.preBehavior!.events = b.obligations.map(o => preEvent(b, { eventId: `pre-${o.obligationId}`, obligationId: o.obligationId }))
    freeze(b)
    const r = measured([b], [graded(b, "incorrect"), graded(b, "correct", { eventId: "retained", obligationId: "retained" })]).boundaries[0]!
    expect(r.behavioralRegression?.exposure.status).toBe("observed")
    expect(r.behavioralRegression?.obligations.map(o => o.classification)).toEqual([
      "pre_correct_post_failure", "pre_correct_retained", "pre_correct_post_unknown",
    ])
    expect(r.behavioralRegression?.counts).toEqual({ preCorrect: 3, exposedPreCorrect: 3, preIncorrect: 0, preUnknown: 0, regressions: 1, retained: 1, unknownFollowup: 1 })
    expect(r.behavioralRegression?.missingness).toEqual({ eligible: 3, scored: 2, unknown: 1,
      observedRegressionRate: 0.5, lowerBound: 1 / 3, upperBound: 2 / 3 })
    expect(r.facts.map(f => f.assessment)).toEqual(["failure_observed", "no_failure_observed", "unknown"])
    const missing = measured([withPre()]).boundaries[0]!.behavioralRegression!
    expect(missing.missingness).toEqual({ eligible: 1, scored: 0, unknown: 1, observedRegressionRate: null, lowerBound: 0, upperBound: 1 })
  })

  test("failed or missing intervention evidence cannot change frozen pre-correct eligibility", () => {
    const summary = withPre(), handoff = transition("reassignment")
    handoff.lineage = { eventId: "handoff", sourceSessionId: "s1", recipientSessionId: "recipient",
      at: handoff.transitionAt, evidenceId: "transfer", digest: d("d") }
    const cases: Array<{ original: RetentionBoundary; alter: (b: RetentionBoundary) => void }> = [
      { original: summary, alter: b => { b.summarySucceeded = false } },
      { original: summary, alter: b => { b.summaryEvidence = null } },
      { original: summary, alter: b => { b.summaryEvidence!.sessionId = "foreign" } },
      { original: summary, alter: b => { b.summaryAt = null; b.summarySucceeded = false; b.summaryEvidence = null } },
      { original: handoff, alter: b => { delete b.lineage } },
      { original: handoff, alter: b => { b.lineage!.sourceSessionId = "foreign" } },
    ]
    for (const { original, alter } of cases) {
      const before = measured([original], [graded(original, "correct")]).boundaries[0]!.behavioralRegression!
      const failed = structuredClone(original); alter(failed)
      const after = measured([failed], [graded(failed, "incorrect")]).boundaries[0]!.behavioralRegression!
      expect(before.counts).toMatchObject({ preCorrect: 1, exposedPreCorrect: 1, retained: 1 })
      expect(after.obligations[0]!.pre).toEqual(before.obligations[0]!.pre)
      expect(after.obligations[0]!.classification).toBe("pre_correct_post_unknown")
      expect(after.exposure.status).toBe("unknown")
      expect(after.counts).toEqual({ preCorrect: 1, exposedPreCorrect: 0, preIncorrect: 0, preUnknown: 0,
        regressions: 0, retained: 0, unknownFollowup: 1 })
      expect(after.missingness).toEqual({ eligible: 1, scored: 0, unknown: 1, observedRegressionRate: null, lowerBound: 0, upperBound: 1 })
    }
  })

  test("post evidence conflicts keep pre eligibility, while corrupt frozen evidence does not qualify", () => {
    const b = withPre(), post = graded(b, "correct")
    const conflicting = measured([b], [post, post]).boundaries[0]!
    expect(conflicting.valid).toBe(false)
    expect(conflicting.behavioralRegression?.counts).toMatchObject({ preCorrect: 1, exposedPreCorrect: 1, unknownFollowup: 1 })
    for (const alter of [
      (copy: RetentionBoundary) => { copy.frozenSetDigest = d("f") },
      (copy: RetentionBoundary) => { copy.obligations[0]!.frozenBy.digest = d("f") },
    ]) {
      const corrupt = structuredClone(b); alter(corrupt)
      expect(measured([corrupt], [post]).boundaries[0]!.behavioralRegression!.counts).toMatchObject({
        preCorrect: 0, exposedPreCorrect: 0, preUnknown: 1,
      })
    }
  })

  test("uses latest pre behavior, never first observed or last correct, and preserves recovery/relapse", () => {
    for (const outcome of ["incorrect", "inaccessible", "unknown"] as const) {
      const b = withPre()
      b.preBehavior!.events = [preEvent(b, { eventId: "earlier", at: 8 }), preEvent(b, { outcome })]
      const r = measured([b], [graded(b, "incorrect")]).boundaries[0]!.behavioralRegression!
      expect(r.obligations[0]?.classification).toBe(outcome === "unknown" ? "pre_unknown" : "pre_incorrect_post_failure")
      expect(r.counts.regressions).toBe(0)
    }
    const b = withPre()
    b.preBehavior!.events.unshift(preEvent(b, { eventId: "old-failure", at: 8, outcome: "incorrect" }))
    expect(measured([b], [graded(b, "incorrect")]).boundaries[0]!.behavioralRegression!.counts.regressions).toBe(1)
    b.preBehavior!.events.at(-1)!.outcome = "incorrect"
    expect(measured([b], [graded(b, "correct")]).boundaries[0]!.behavioralRegression!.obligations[0]?.classification).toBe("pre_incorrect_recovered")
  })

  test("truth, action, transition, coverage, timing, and grading gaps cannot reuse a stale pre-success", () => {
    const alterations: Array<(b: RetentionBoundary) => void> = [
      b => { b.preBehavior!.complete = false },
      b => { b.preBehavior!.endAt-- },
      b => { b.preBehavior!.startAt = 0 },
      b => { b.preBehavior!.events[0]!.independentlyEvaluated = false },
      b => { b.preBehavior!.events[0]!.truthDigest = d("f") },
      b => { b.preBehavior!.events[0]!.sessionId = "foreign" },
      b => { b.preBehavior!.events.push({ ...b.preBehavior!.events[0]! }) },
      b => { b.preBehavior!.events[0]!.at = b.transitionAt },
      ...(["action", "truth_change", "transition"] as const).map(kind => (b: RetentionBoundary) => {
        b.preBehavior!.events[0]!.at -= 2
        b.preBehavior!.events.push(preEvent(b, { eventId: kind, kind, obligationId: null, outcome: null }))
      }),
      b => { b.preBehavior!.events.push(...[1, 2, 3].map(n => preEvent(b, { eventId: `response-${n}`, kind: "response", obligationId: null }))) },
    ]
    for (const alter of alterations) {
      const b = withPre(boundary("b", "task", "s1", 200_000)); alter(b)
      const r = measured([b], [graded(b, "incorrect")]).boundaries[0]!
      expect(r.behavioralRegression?.obligations[0]?.classification).toBe("pre_unknown")
      expect(r.behavioralRegression?.missingness.observedRegressionRate).toBeNull()
      expect(r.facts[0]?.assessment).toBe("failure_observed")
    }
    const first = boundary("first"), second = withPre(boundary("b2", "task", "s2", 20))
    second.preBehavior!.startAt = 5; second.preBehavior!.events[0]!.at = 10
    expect(measured([first, second], [graded(second, "incorrect")]).boundaries[1]!.behavioralRegression!.obligations[0]?.pre.reason)
      .toBe("pre_behavior_not_current_at_freeze")
  })

  test("negative controls require exposed choices and complete traces; old misuse diagnostics remain", () => {
    const b = withPre()
    b.obligations = [obligation("goal", "revoked")]; freeze(b)
    const bad = graded(b, "incorrect")
    let r = measured([b], [bad]).boundaries[0]!
    expect(r.facts[0]?.assessment).toBe("failure_observed")
    expect(r.behavioralRegression?.obligations[0]?.classification).toBe("pre_correct_post_unknown")
    b.useWindow = { startAt: b.summaryAt!, endAt: b.after.observedAt, complete: true }
    expect(measured([b], [bad]).boundaries[0]!.behavioralRegression!.counts.regressions).toBe(1)
    expect(measured([b], [graded(b, "correct", { governedActionExposed: false })]).boundaries[0]!.behavioralRegression!.counts.unknownFollowup).toBe(1)
    expect(measured([b], [graded(b, "correct")]).boundaries[0]!.behavioralRegression!.counts.retained).toBe(1)
    b.preBehavior!.events[0]!.governedActionExposed = false
    expect(measured([b], [bad]).boundaries[0]!.behavioralRegression!.counts.preUnknown).toBe(1)
  })

  test("post failure survives recovery; ungraded/latest wrong-truth evidence cannot prove retention", () => {
    const b = withPre()
    const early = graded(b, "incorrect", { eventId: "failure", at: b.summaryAt! })
    expect(measured([b], [early, graded(b, "correct")]).boundaries[0]!.behavioralRegression!.counts.regressions).toBe(1)
    for (const patch of [{ gradingEvidence: undefined }, { independentlyEvaluated: false },
      { gradingEvidence: { evidenceId: b.preBehavior!.events[0]!.evidenceId, digest: d("d"), truthDigest: d("a") } },
      { gradingEvidence: { evidenceId: "wrong-truth", digest: d("d"), truthDigest: d("f") } }]) {
      const r = measured([b], [graded(b, "correct", patch)]).boundaries[0]!
      expect(r.behavioralRegression?.counts.unknownFollowup).toBe(1)
      expect(r.facts[0]?.assessment).toBe(patch.independentlyEvaluated === false ? "unknown" : "no_failure_observed")
    }
    b.boundaryCensusComplete = false
    const r = measured([b], [graded(b, "incorrect")]).boundaries[0]!.behavioralRegression!
    expect(r.exposure.status).toBe("observed")
    expect(r.counts).toMatchObject({ preCorrect: 1, unknownFollowup: 1, regressions: 0 })
  })

  test("reassignment grades source before and recipient after without merging session authority", () => {
    const b = transition("reassignment")
    b.lineage = { eventId: "handoff", sourceSessionId: "s1", recipientSessionId: "recipient", at: b.transitionAt, evidenceId: "handoff-receipt", digest: d("d") }
    const r = measured([b], [graded(b, "incorrect")]).boundaries[0]!
    expect(r.valid).toBe(true)
    expect(r.behavioralRegression).toMatchObject({ sourceSessionId: "s1", recipientSessionId: "recipient", counts: { regressions: 1 } })
    const wrong = measured([b], [graded(b, "correct", { sessionId: "s1" })]).boundaries[0]!
    expect(wrong.valid).toBe(false)
    expect(wrong.behavioralRegression?.counts.unknownFollowup).toBe(1)
    b.lineage.sourceSessionId = "foreign"
    expect(measured([b]).boundaries[0]!.behavioralRegression!.exposure.status).toBe("unknown")
    delete b.lineage
    expect(measured([b]).boundaries[0]!.behavioralRegression!.counts).toMatchObject({ preCorrect: 1, exposedPreCorrect: 0, unknownFollowup: 1 })
  })

  test("control and restart are separate checkpoints; observed pruning needs a real receipt, never a summary", () => {
    for (const kind of ["control", "restart"] as const) {
      const b = transition(kind)
      const r = measured([b], [graded(b, "correct")]).boundaries[0]!
      expect(r.valid).toBe(true)
      expect(r.behavioralRegression?.exposure).toEqual({ transition: kind, status: "observed", pruningObservability: "unknown" })
      expect(r.behavioralRegression?.counts.retained).toBe(1)
    }
    const b = transition("prune")
    for (const evidence of [undefined, { observable: false, receipt: null }, { observable: true, receipt: null }]) {
      b.pruneEvidence = evidence
      const unknown = measured([b], [graded(b, "correct")]).boundaries[0]!.behavioralRegression!
      expect(unknown.exposure.status).toBe("unknown")
      expect(unknown.counts).toMatchObject({ preCorrect: 1, exposedPreCorrect: 0, unknownFollowup: 1 })
    }
    b.pruneEvidence = { observable: true, receipt: { eventId: "prune-1", sessionId: "s1", at: b.transitionAt,
      evidenceId: "host-prune", digest: d("d"), affectedMessageIds: ["old-tool-message"], affectedToolIds: [], removedTokens: null } }
    const r = measured([b], [graded(b, "incorrect")]).boundaries[0]!
    expect(r.valid).toBe(true)
    expect(r.behavioralRegression?.exposure).toEqual({ transition: "prune", status: "observed", pruningObservability: "observable" })
    expect(r.behavioralRegression?.counts.regressions).toBe(1)
    b.summarySucceeded = true
    expect(measured([b]).boundaries[0]!.behavioralRegression!.exposure.status).toBe("unknown")
  })

  test("optional evidence stays strict and aggregate row limits include pre-traces", () => {
    const b = withPre()
    const malformed = structuredClone(b) as any
    malformed.preBehavior.events[0].digest = "not-a-hash"
    expect(measureRetentionBoundaries(payload([malformed])).status).toBe("invalid_input")
    const extra = { ...b, preBehavior: { ...b.preBehavior!, forgedAuthority: true } }
    expect(measureRetentionBoundaries(payload([extra])).status).toBe("invalid_input")
    b.preBehavior!.events = Array.from({ length: 5000 }, (_, i) => preEvent(b, { eventId: `e-${i}` }))
    const overflow = measureRetentionBoundaries(payload([b], [graded(b, "correct")]))
    expect(overflow).toMatchObject({ status: "invalid_input", issues: [{ code: "aggregate_limit" }] })
  })
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

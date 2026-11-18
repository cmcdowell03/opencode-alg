import { z } from "zod"
import { createHash } from "node:crypto"

const Id = z.string().min(1).max(256)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const Time = z.number().int().nonnegative().safe()
const MAX_BOUNDARIES = 100
const MAX_ROWS = 5_000

export const RetentionBoundaryObligationSchema = z.object({
  obligationId: Id,
  category: z.enum(["criteria", "phase", "skill", "source", "evidence", "pending_intent", "budget", "next_action"]),
  disposition: z.enum(["required", "superseded", "revoked", "prohibited"]),
  expectedDigest: Digest,
  basis: z.object({
    phase: Id.nullable(), skillId: Id.nullable(), skillVersion: Id.nullable(), sourceRef: Id.nullable(),
    evidenceRef: Id.nullable(), pendingIntentId: Id.nullable(), budget: z.number().finite().nonnegative().nullable(),
    nextAction: Id.nullable(),
  }).strict(),
  frozenBy: z.object({ provenance: z.literal("external_evaluator"), evidenceId: Id, digest: Digest }).strict(),
}).strict()
export type RetentionBoundaryObligation = z.infer<typeof RetentionBoundaryObligationSchema>

const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
/** Stable, order-independent hashes of the actual frozen values, excluding caller hash fields. */
export function retentionObligationDigest(o: Pick<RetentionBoundaryObligation, "obligationId" | "category" | "disposition" | "expectedDigest" | "basis">): string {
  const b = o.basis
  return sha([o.obligationId, o.category, o.disposition, o.expectedDigest,
    b.phase, b.skillId, b.skillVersion, b.sourceRef, b.evidenceRef, b.pendingIntentId, b.budget, b.nextAction])
}
export function retentionFrozenSetDigest(b: Pick<RetentionBoundary, "boundaryId" | "taskId" | "sessionId" | "frozenAt" | "obligations">): string {
  return sha([b.boundaryId, b.taskId, b.sessionId, b.frozenAt,
    b.obligations.map(o => [o.obligationId, retentionObligationDigest(o)]).sort((a, c) => a[0]! < c[0]! ? -1 : a[0]! > c[0]! ? 1 : 0)])
}

const Snapshot = z.object({
  observedAt: Time,
  complete: z.boolean(),
  facts: z.array(z.object({ obligationId: Id, digest: Digest }).strict()).max(MAX_ROWS),
}).strict()

export const RetentionGradingEvidenceSchema = z.object({ evidenceId: Id, digest: Digest, truthDigest: Digest }).strict()
export type RetentionGradingEvidence = z.infer<typeof RetentionGradingEvidenceSchema>

/** All relevant actions, truth changes and transitions must appear, including ungraded ones.
 * A null obligationId applies to every obligation; response rows count controller responses. */
export const RetentionPreBehaviorEventSchema = z.object({
  eventId: Id, sessionId: Id, at: Time, obligationId: Id.nullable(),
  kind: z.enum(["behavior", "action", "truth_change", "transition", "response"]),
  truthDigest: Digest.nullable(), outcome: z.enum(["correct", "incorrect", "inaccessible", "unknown"]).nullable(),
  independentlyEvaluated: z.boolean(), governedActionExposed: z.boolean().nullable(),
  evidenceId: Id, digest: Digest,
}).strict()
export type RetentionPreBehaviorEvent = z.infer<typeof RetentionPreBehaviorEventSchema>
export const RetentionPreBehaviorSchema = z.object({
  startAt: Time, endAt: Time, complete: z.boolean(), evidenceId: Id, digest: Digest,
  events: z.array(RetentionPreBehaviorEventSchema).max(MAX_ROWS),
}).strict()
export type RetentionPreBehavior = z.infer<typeof RetentionPreBehaviorSchema>

/** sessionId/before identify the source; post observations/after identify the recipient. */
export const RetentionLineageSchema = z.object({
  eventId: Id, sourceSessionId: Id, recipientSessionId: Id, at: Time, evidenceId: Id, digest: Digest,
}).strict()
export type RetentionLineage = z.infer<typeof RetentionLineageSchema>
export const RetentionPruneEvidenceSchema = z.object({
  observable: z.boolean(),
  receipt: z.object({ eventId: Id, sessionId: Id, at: Time, evidenceId: Id, digest: Digest,
    affectedMessageIds: z.array(Id).max(MAX_ROWS), affectedToolIds: z.array(Id).max(MAX_ROWS),
    removedTokens: Time.nullable(),
  }).strict().nullable(),
}).strict()
export type RetentionPruneEvidence = z.infer<typeof RetentionPruneEvidenceSchema>

export const RetentionBoundarySchema = z.object({
  boundaryId: Id, taskId: Id, sessionId: Id, requestId: Id,
  transition: z.enum(["compaction", "reassignment", "restart", "control", "prune"]),
  compactionMode: z.enum(["native", "requested", "unknown"]).nullable(),
  frozenAt: Time,
  transitionAt: Time,
  requestAt: Time.nullable(),
  summaryAt: Time.nullable(),
  summarySucceeded: z.boolean(),
  frozenSetDigest: Digest,
  summaryEvidence: z.object({ eventId: Id, requestId: Id, taskId: Id, sessionId: Id, observedAt: Time,
    digest: Digest, frozenSetDigest: Digest }).strict().nullable(),
  before: Snapshot,
  after: Snapshot,
  obligations: z.array(RetentionBoundaryObligationSchema).max(MAX_ROWS),
  boundaryCensusComplete: z.boolean(),
  useWindow: z.object({ startAt: Time, endAt: Time, complete: z.boolean() }).strict().nullable(),
  nextTaskBoundaryAt: Time.nullable().optional(),
  preBehavior: RetentionPreBehaviorSchema.optional(),
  lineage: RetentionLineageSchema.optional(),
  pruneEvidence: RetentionPruneEvidenceSchema.optional(),
}).strict()
export type RetentionBoundary = z.infer<typeof RetentionBoundarySchema>

export const RetentionBoundaryObservationSchema = z.object({
  eventId: Id, boundaryId: Id, taskId: Id, sessionId: Id, at: Time,
  obligationId: Id,
  kind: z.enum(["durable", "context", "retrieval", "use", "behavior", "repeat_work"]),
  outcome: z.enum(["present", "absent", "current", "stale", "found", "missing", "error", "used", "not_used", "correct", "incorrect", "inaccessible", "repeated", "not_repeated", "unknown"]),
  digest: Digest.nullable(),
  governedActionExposed: z.boolean().nullable(),
  independentlyEvaluated: z.boolean(),
  workUnits: z.number().finite().nonnegative().nullable(),
  gradingEvidence: RetentionGradingEvidenceSchema.optional(),
}).strict()
export type RetentionBoundaryObservation = z.infer<typeof RetentionBoundaryObservationSchema>

export const RetentionBoundaryInputSchema = z.object({
  schema: z.literal("build-benchmark-retention-boundaries/v1"),
  boundaries: z.array(RetentionBoundarySchema).max(MAX_BOUNDARIES),
  observations: z.array(RetentionBoundaryObservationSchema).max(MAX_ROWS),
}).strict()
export type RetentionBoundaryInput = z.infer<typeof RetentionBoundaryInputSchema>

type Issue = { code: string; boundaryId?: string; eventId?: string; detail: string }
type Layer = "durable" | "context" | "retrieval" | "use" | "behavior" | "repeat_work"

function distinct(items: string[]): boolean { return new Set(items).size === items.length }

type BehaviorState = { state: "correct" | "incorrect" | "unknown"; reason: string; evidenceId: string | null }
export type RetentionBehavioralClassification = "pre_correct_post_failure" | "pre_correct_retained" | "pre_correct_post_unknown" |
  "pre_incorrect_post_failure" | "pre_incorrect_recovered" | "pre_incorrect_post_unknown" | "pre_unknown"
const unknownBehavior = (reason: string): BehaviorState => ({ state: "unknown", reason, evidenceId: null })

function lineageValid(b: RetentionBoundary): boolean {
  return b.transition === "reassignment" && !!b.lineage && b.lineage.sourceSessionId === b.sessionId &&
    b.lineage.recipientSessionId !== b.sessionId && b.lineage.at === b.transitionAt
}
function transitionObserved(b: RetentionBoundary): boolean {
  if (b.frozenAt > b.transitionAt || retentionFrozenSetDigest(b) !== b.frozenSetDigest) return false
  if (b.transition === "compaction") return b.summarySucceeded && b.requestAt !== null && b.summaryAt !== null &&
    b.frozenAt <= b.requestAt && b.requestAt <= b.transitionAt && b.transitionAt <= b.summaryAt &&
    b.summaryEvidence?.requestId === b.requestId && b.summaryEvidence.taskId === b.taskId &&
    b.summaryEvidence.sessionId === b.sessionId && b.summaryEvidence.observedAt === b.summaryAt &&
    b.summaryEvidence.frozenSetDigest === b.frozenSetDigest
  if (b.requestAt !== null || b.summaryAt !== null || b.summarySucceeded || b.summaryEvidence !== null || b.compactionMode !== null) return false
  if (b.transition === "reassignment") return lineageValid(b)
  if (b.transition === "prune") return b.pruneEvidence?.observable === true &&
    b.pruneEvidence.receipt?.sessionId === b.sessionId && b.pruneEvidence.receipt.at === b.transitionAt
  return true // Explicit control/restart checkpoint, not a claimed context change.
}

function preBehaviorState(b: RetentionBoundary, o: RetentionBoundaryObligation, previous: RetentionBoundary | undefined): BehaviorState {
  const trace = b.preBehavior
  if (!trace) return unknownBehavior("pre_behavior_missing")
  if (!trace.complete || trace.startAt > trace.endAt || b.frozenAt > trace.endAt || trace.endAt !== b.transitionAt ||
    trace.endAt - trace.startAt > 120_000) return unknownBehavior("pre_interval_incomplete_or_out_of_bounds")
  if (!distinct(trace.events.map(e => e.eventId))) return unknownBehavior("pre_event_identity_ambiguous")
  const ids = new Set(b.obligations.map(obligation => obligation.obligationId))
  if (trace.events.some(e => e.sessionId !== b.sessionId || e.at < trace.startAt || e.at >= trace.endAt ||
    (e.obligationId !== null && !ids.has(e.obligationId)))) return unknownBehavior("pre_event_out_of_scope")
  if (trace.events.filter(e => e.kind === "response").length > 2) return unknownBehavior("pre_response_limit")
  const relevant = trace.events.filter(e => e.kind !== "response" && (e.obligationId === null || e.obligationId === o.obligationId))
    .sort((a, c) => a.at - c.at)
  const latest = relevant.at(-1)
  if (!latest) return unknownBehavior("pre_behavior_missing")
  if (relevant.length > 1 && relevant.at(-2)!.at === latest.at) return unknownBehavior("latest_pre_event_ambiguous")
  if (latest.kind !== "behavior" || latest.obligationId !== o.obligationId) return unknownBehavior("pre_action_truth_or_transition_gap")
  if (latest.at > b.frozenAt || (previous && latest.at < (previous.summaryAt ?? previous.transitionAt)))
    return unknownBehavior("pre_behavior_not_current_at_freeze")
  if (!latest.independentlyEvaluated || latest.truthDigest !== o.expectedDigest)
    return unknownBehavior("pre_grade_unverified_or_truth_changed")
  if (o.disposition !== "required" && latest.governedActionExposed !== true) return unknownBehavior("pre_negative_control_unexposed")
  if (latest.outcome === "correct" || latest.outcome === "incorrect" || latest.outcome === "inaccessible")
    return { state: latest.outcome === "correct" ? "correct" : "incorrect", reason: "latest_independent_pre_behavior", evidenceId: latest.evidenceId }
  return unknownBehavior("latest_pre_behavior_unknown")
}

function postBehaviorState(b: RetentionBoundary, o: RetentionBoundaryObligation, rows: RetentionBoundaryObservation[], valid: boolean): BehaviorState {
  if (!valid) return unknownBehavior("post_window_unverified")
  const negative = o.disposition !== "required"
  if (negative && !(b.useWindow?.complete && b.useWindow.startAt === (b.summaryAt ?? b.transitionAt) &&
    b.useWindow.endAt === b.after.observedAt)) return unknownBehavior("post_negative_control_trace_incomplete")
  const actions = rows.filter(r => r.kind === "behavior" || (negative && r.kind === "use"))
  const preEvidenceIds = new Set(b.preBehavior?.events.map(e => e.evidenceId))
  const verified = (r: RetentionBoundaryObservation) => r.independentlyEvaluated && r.gradingEvidence?.truthDigest === o.expectedDigest &&
    !preEvidenceIds.has(r.gradingEvidence.evidenceId) &&
    (!negative || r.governedActionExposed === true)
  // Keep the first verified failure even when later retrieval/behavior recovers.
  const failed = actions.find(r => verified(r) && (["incorrect", "inaccessible"].includes(r.outcome) ||
    (negative && r.kind === "use" && r.outcome === "used" && (o.disposition !== "superseded" || r.digest === o.expectedDigest))))
  if (failed) return { state: "incorrect", reason: "independent_post_failure", evidenceId: failed.gradingEvidence!.evidenceId }
  const latest = actions.at(-1)
  if (!latest) return unknownBehavior("post_behavior_missing")
  if (actions.length > 1 && actions.at(-2)!.at === latest.at) return unknownBehavior("latest_post_event_ambiguous")
  if (!verified(latest)) return unknownBehavior("latest_post_grade_unverified_or_unexposed")
  if ((latest.outcome === "correct" && (negative || latest.digest === o.expectedDigest)) ||
    (negative && latest.kind === "use" && latest.outcome === "not_used"))
    return { state: "correct", reason: "independent_post_correct", evidenceId: latest.gradingEvidence!.evidenceId }
  return unknownBehavior("latest_post_behavior_unknown")
}

function measureBehavioralRegression(b: RetentionBoundary, rows: Map<string, RetentionBoundaryObservation[]>, previous: RetentionBoundary | undefined, valid: boolean, preIdentityValid: boolean) {
  const observed = transitionObserved(b)
  const frozenSetValid = retentionFrozenSetDigest(b) === b.frozenSetDigest
  const obligations = b.obligations.map(o => {
    // Eligibility uses frozen/pre evidence only. Failed or unobserved interventions
    // cannot remove a pre-correct obligation from the paired eligibility set.
    const pre = !preIdentityValid ? unknownBehavior("boundary_identity_ambiguous") : !frozenSetValid
      ? unknownBehavior("frozen_set_digest_mismatch") : retentionObligationDigest(o) !== o.frozenBy.digest
      ? unknownBehavior("obligation_digest_mismatch") : preBehaviorState(b, o, previous)
    const post = postBehaviorState(b, o, rows.get(o.obligationId) ?? [], valid && observed)
    const classification: RetentionBehavioralClassification = pre.state === "unknown" ? "pre_unknown" : pre.state === "correct"
      ? post.state === "incorrect" ? "pre_correct_post_failure" : post.state === "correct" ? "pre_correct_retained" : "pre_correct_post_unknown"
      : post.state === "incorrect" ? "pre_incorrect_post_failure" : post.state === "correct" ? "pre_incorrect_recovered" : "pre_incorrect_post_unknown"
    return { obligationId: o.obligationId, truthDigest: o.expectedDigest, pre, post, classification }
  })
  const counts = {
    preCorrect: obligations.filter(o => o.pre.state === "correct").length,
    exposedPreCorrect: observed ? obligations.filter(o => o.pre.state === "correct").length : 0,
    preIncorrect: obligations.filter(o => o.pre.state === "incorrect").length,
    preUnknown: obligations.filter(o => o.pre.state === "unknown").length,
    regressions: obligations.filter(o => o.classification === "pre_correct_post_failure").length,
    retained: obligations.filter(o => o.classification === "pre_correct_retained").length,
    unknownFollowup: obligations.filter(o => o.classification === "pre_correct_post_unknown").length,
  }
  const scored = counts.regressions + counts.retained
  return { exposure: { transition: b.transition, status: observed ? "observed" as const : "unknown" as const,
      pruningObservability: b.pruneEvidence ? b.pruneEvidence.observable ? "observable" as const : "unobservable" as const : "unknown" as const },
    sourceSessionId: b.sessionId, recipientSessionId: lineageValid(b) ? b.lineage!.recipientSessionId : b.sessionId,
    obligations, counts,
    missingness: { eligible: counts.preCorrect, scored, unknown: counts.unknownFollowup,
      observedRegressionRate: scored ? counts.regressions / scored : null,
      lowerBound: counts.preCorrect ? counts.regressions / counts.preCorrect : null,
      upperBound: counts.preCorrect ? (counts.regressions + counts.unknownFollowup) / counts.preCorrect : null },
    interpretation: "Conditional post-transition behavioral regression, not causal information loss. Eligibility uses frozen/pre evidence; unobserved exposure and unknown follow-up remain in bounds. exposedPreCorrect counts only observed transitions. Pre-incorrect and pre-unknown obligations remain separate." }
}
export type RetentionBehavioralRegression = ReturnType<typeof measureBehavioralRegression>

/**
 * Measure only explicitly supplied boundary snapshots and observations. This is
 * descriptive instrumentation: temporal order does not establish compaction as
 * the cause of any observed failure.
 */
export function measureRetentionBoundaries(raw: unknown) {
  const parsed = RetentionBoundaryInputSchema.safeParse(raw)
  if (!parsed.success) return { status: "invalid_input" as const, issues: parsed.error.issues.map(i => ({ code: "schema", detail: `${i.path.join(".")}: ${i.message}` })) }
  const { boundaries, observations } = parsed.data
  const totalObligations = boundaries.reduce((n, b) => n + b.obligations.length, 0)
  const totalSnapshotFacts = boundaries.reduce((n, b) => n + b.before.facts.length + b.after.facts.length, 0)
  if (totalObligations > MAX_ROWS || totalSnapshotFacts > MAX_ROWS * 2) return {
    status: "invalid_input" as const,
    issues: [{ code: "aggregate_limit", detail: `Aggregate obligations (${totalObligations}) or snapshot facts (${totalSnapshotFacts}) exceed bounded limits.` }],
  }
  const totalBehaviorRows = observations.length + boundaries.reduce((n, b) => n + (b.preBehavior?.events.length ?? 0), 0)
  const totalPruneRefs = boundaries.reduce((n, b) => n + (b.pruneEvidence?.receipt?.affectedMessageIds.length ?? 0) +
    (b.pruneEvidence?.receipt?.affectedToolIds.length ?? 0), 0)
  if (totalBehaviorRows > MAX_ROWS || totalPruneRefs > MAX_ROWS) return { status: "invalid_input" as const,
    issues: [{ code: "aggregate_limit", detail: "Combined pre/post behavior rows or prune references exceed bounded limits." }] }
  const issues: Issue[] = []
  const ids = boundaries.map(b => b.boundaryId)
  const eventIds = observations.map(o => o.eventId)
  if (!distinct(ids)) issues.push({ code: "duplicate_boundary_id", detail: "Boundary ids must be globally unique." })
  if (!distinct(eventIds)) issues.push({ code: "duplicate_event_id", detail: "Observation event ids must be globally unique." })
  const eventIdCounts = new Map<string, number>()
  for (const id of eventIds) eventIdCounts.set(id, (eventIdCounts.get(id) ?? 0) + 1)
  const boundaryIds = new Set(ids)
  for (const o of observations) if (!boundaryIds.has(o.boundaryId))
    issues.push({ code: "observation_unknown_boundary", eventId: o.eventId, detail: "Observation references an unknown boundary." })
  const ordered = [...boundaries].sort((a, b) => a.taskId.localeCompare(b.taskId) || a.transitionAt - b.transitionAt || a.boundaryId.localeCompare(b.boundaryId))
  const nextById = new Map<string, number>()
  const previousById = new Map<string, RetentionBoundary>()
  for (let i = 0; i < ordered.length - 1; i++) if (ordered[i]!.taskId === ordered[i + 1]!.taskId)
    { nextById.set(ordered[i]!.boundaryId, ordered[i + 1]!.transitionAt); previousById.set(ordered[i + 1]!.boundaryId, ordered[i]!) }
  const summaryIds = boundaries.flatMap(b => b.summaryEvidence ? [b.summaryEvidence.eventId] : [])
  if (!distinct(summaryIds)) issues.push({ code: "duplicate_summary_event_id", detail: "Summary event ids must be globally unique." })
  const globalConflict = issues.length > 0

  const obsByBoundary = new Map<string, RetentionBoundaryObservation[]>()
  for (const o of observations) {
    const list = obsByBoundary.get(o.boundaryId) ?? []
    list.push(o); obsByBoundary.set(o.boundaryId, list)
  }
  const reports = boundaries.map(boundary => {
    const b = boundary
    const localIssues: Issue[] = []
    const flag = (code: string, detail: string) => { const item = { code, boundaryId: b.boundaryId, detail }; issues.push(item); localIssues.push(item) }
    if (retentionFrozenSetDigest(b) !== b.frozenSetDigest) flag("frozen_set_digest_mismatch", "Frozen set hash must be recomputed from the canonical obligation values and boundary identity.")
    for (const o of b.obligations) if (retentionObligationDigest(o) !== o.frozenBy.digest)
      flag("obligation_digest_mismatch", `Frozen obligation ${o.obligationId} does not match its canonical value.`)
    if (!b.boundaryCensusComplete) flag("boundary_census_incomplete", "The boundary census must be complete to assess retention.")
    if (b.lineage && !lineageValid(b)) flag("lineage_identity_conflict", "Lineage must link the reassignment source to a distinct recipient at this transition.")
    if (b.pruneEvidence?.receipt && (b.transition !== "prune" || !b.pruneEvidence.observable ||
      b.pruneEvidence.receipt.sessionId !== b.sessionId || b.pruneEvidence.receipt.at !== b.transitionAt))
      flag("prune_identity_conflict", "An observed prune receipt must identify this prune transition and session.")
    const postSessionId = lineageValid(b) ? b.lineage!.recipientSessionId : b.sessionId
    if (b.transition === "compaction") {
      if (b.compactionMode === null) flag("compaction_mode_missing", "Compaction mode must be explicitly native, requested, or unknown.")
      if (b.requestAt === null || b.summaryAt === null || !b.summarySucceeded || b.summaryEvidence === null)
        flag("compaction_not_successfully_linked", "A compaction boundary requires a successful summary and linked summary evidence.")
      if (b.summaryEvidence !== null && (b.summaryEvidence.requestId !== b.requestId || b.summaryEvidence.taskId !== b.taskId ||
        b.summaryEvidence.sessionId !== b.sessionId || b.summaryEvidence.observedAt !== b.summaryAt))
        flag("summary_identity_conflict", "Summary evidence must identify this request, task, session, and summary time exactly.")
      if (b.summaryEvidence !== null && b.summaryEvidence.frozenSetDigest !== b.frozenSetDigest)
        flag("frozen_obligations_not_bound_to_summary", "Successful summary evidence must bind the exact externally frozen obligation set.")
      if (b.requestAt !== null && b.summaryAt !== null && !(b.frozenAt <= b.requestAt && b.requestAt <= b.transitionAt && b.transitionAt <= b.summaryAt && b.summaryAt <= b.after.observedAt))
        flag("invalid_compaction_time_order", "Required order is frozen <= request <= successful summary <= after observation.")
    } else if (b.requestAt !== null || b.summaryAt !== null || b.summarySucceeded || b.summaryEvidence !== null || b.compactionMode !== null) {
      flag("non_compaction_has_summary", "Reassignment/restart is a distinct transition and cannot be counted as compaction.")
    }
    if (b.frozenAt > b.transitionAt || b.before.observedAt > b.frozenAt || b.after.observedAt < b.transitionAt)
      flag("invalid_boundary_time_order", "Frozen/before evidence must not follow the transition; after evidence must not precede it.")
    const previous = previousById.get(b.boundaryId)
    if (previous && b.before.observedAt < previous.transitionAt)
      flag("before_predates_previous_boundary", "Before snapshot must not predate the prior transition for this task.")
    if (b.transition === "compaction" && b.summaryAt !== null && b.after.observedAt < b.summaryAt)
      flag("after_precedes_summary", "After snapshot must be at or after successful summary evidence.")
    const derivedNextAt = nextById.get(b.boundaryId)
    if (b.nextTaskBoundaryAt != null && derivedNextAt !== undefined && b.nextTaskBoundaryAt !== derivedNextAt)
      flag("next_boundary_conflict", "Declared next task boundary disagrees with the observed task timeline.")
    const nextAt = derivedNextAt ?? b.nextTaskBoundaryAt ?? undefined
    if (nextAt !== undefined && nextAt <= b.transitionAt)
      flag("ambiguous_boundary_order", "Transitions for one task must have strictly increasing times.")
    if (nextAt !== undefined && b.after.observedAt >= nextAt)
      flag("after_crosses_next_boundary", "After observations must be before the next boundary for this logical task.")
    if (b.useWindow !== null && (b.useWindow.startAt < (b.summaryAt ?? b.transitionAt) || b.useWindow.endAt > b.after.observedAt ||
      b.useWindow.startAt > b.useWindow.endAt || (nextAt !== undefined && b.useWindow.endAt >= nextAt)))
      flag("invalid_use_window", "Use coverage must be inside this boundary's after-summary window.")
    if (b.useWindow?.complete && (b.useWindow.startAt !== (b.summaryAt ?? b.transitionAt) || b.useWindow.endAt !== b.after.observedAt))
      flag("partial_use_window", "A complete observed-use window must span summary/transition through the after snapshot.")
    const obligationIds = b.obligations.map(o => o.obligationId)
    if (!distinct(obligationIds)) flag("duplicate_obligation_id", "Obligation ids must be unique within a boundary.")
    const obligationSet = new Set(obligationIds)
    const snapshotMaps = new Map<string, Map<string, string>>()
    const checkSnapshot = (name: "before" | "after", snapshot: typeof b.before) => {
      const found = new Set<string>()
      const facts = new Map<string, string>()
      for (const fact of snapshot.facts) {
        if (!obligationSet.has(fact.obligationId)) flag("snapshot_scope_conflict", `${name} snapshot contains undeclared obligation ${fact.obligationId}.`)
        if (found.has(fact.obligationId)) flag("snapshot_duplicate_fact", `${name} snapshot repeats ${fact.obligationId}.`)
        found.add(fact.obligationId)
        facts.set(fact.obligationId, fact.digest)
      }
      snapshotMaps.set(name, facts)
    }
    checkSnapshot("before", b.before); checkSnapshot("after", b.after)
    const localObs = obsByBoundary.get(b.boundaryId) ?? []
    const byObligation = new Map<string, RetentionBoundaryObservation[]>()
    for (const o of localObs) {
      let usable = true
      if ((eventIdCounts.get(o.eventId) ?? 0) > 1) usable = false
      if (o.taskId !== b.taskId || o.sessionId !== postSessionId) { flag("observation_scope_conflict", `Observation ${o.eventId} task/session differs from its boundary.`); usable = false }
      if (!obligationSet.has(o.obligationId)) { flag("observation_scope_conflict", `Observation ${o.eventId} references undeclared obligation ${o.obligationId}.`); usable = false }
      if (o.at < (b.summaryAt ?? b.transitionAt) || o.at > b.after.observedAt || (nextAt !== undefined && o.at >= nextAt)) {
        flag("observation_time_out_of_scope", `Observation ${o.eventId} is outside this boundary's after window.`)
        usable = false
      }
      if (!usable) continue
      const list = byObligation.get(o.obligationId) ?? []; list.push(o); byObligation.set(o.obligationId, list)
    }
    for (const rows of byObligation.values()) rows.sort((a, b) => a.at - b.at || a.eventId.localeCompare(b.eventId))
    const facts = b.obligations.map(obligation => {
      const rows = byObligation.get(obligation.obligationId) ?? []
      const find = (kind: Layer) => rows.filter(r => r.kind === kind)
      const beforeDigest = snapshotMaps.get("before")!.get(obligation.obligationId)
      const afterDigest = snapshotMaps.get("after")!.get(obligation.obligationId)
      const layer = (kind: Layer, independentOnly = false) => {
        const rs = find(kind).filter(r => !independentOnly || r.independentlyEvaluated)
        return rs.length ? rs[rs.length - 1]!.outcome : "unknown"
      }
      const negative = obligation.disposition !== "required"
      const exposed = rows.some(r => r.governedActionExposed === true && r.independentlyEvaluated)
      const eligible = rows.filter(r => r.independentlyEvaluated)
      const prohibitedUse = negative && eligible.some(r => r.kind === "use" && r.outcome === "used" &&
        r.governedActionExposed === true && (obligation.disposition !== "superseded" || r.digest === obligation.expectedDigest))
      const incorrectEarlier = eligible.some(r => r.kind === "behavior" && r.outcome === "incorrect")
      const wrongRetrieval = eligible.some(r => r.kind === "retrieval" && (r.outcome === "stale" || (r.digest !== null && r.digest !== obligation.expectedDigest)))
      const behaviorRows = eligible.filter(r => r.kind === "behavior")
      const latestBehavior = behaviorRows.at(-1)
      const durablePresent = b.after.complete ? afterDigest !== undefined && afterDigest === obligation.expectedDigest : null
      const durableCurrent = b.after.complete && afterDigest !== undefined ? afterDigest === obligation.expectedDigest : null
      let assessment: "failure_observed" | "no_failure_observed" | "unknown" = "unknown"
      if (prohibitedUse || (negative && exposed && incorrectEarlier) || (!negative && (incorrectEarlier || wrongRetrieval))) assessment = "failure_observed"
      else if (obligation.disposition === "required" && latestBehavior?.outcome === "correct" && latestBehavior.digest === obligation.expectedDigest) assessment = "no_failure_observed"
      else if (negative && exposed && b.useWindow?.complete === true && eligible.some(r => r.governedActionExposed === true &&
        r.at >= b.useWindow!.startAt && r.at <= b.useWindow!.endAt &&
        ((r.kind === "use" && r.outcome === "not_used") || (r.kind === "behavior" && r.outcome === "correct")))) assessment = "no_failure_observed"
      return {
        obligationId: obligation.obligationId, category: obligation.category, disposition: obligation.disposition,
        beforePresent: b.before.complete ? beforeDigest !== undefined && beforeDigest === obligation.expectedDigest : null,
        durablePresent, durableCurrent,
        contextProjection: layer("context"), retrieval: layer("retrieval"), observedUse: layer("use"),
        independentBehavior: layer("behavior", true), repeatedWork: layer("repeat_work"),
        repeatedWorkUnits: find("repeat_work").reduce((n, r) => n + (r.outcome === "repeated" ? r.workUnits ?? 0 : 0), 0),
        governedActionExposed: negative ? exposed : null,
        assessment,
      }
    })
    const reportFacts = (globalConflict || localIssues.length) ? facts.map(f => ({ ...f, beforePresent: null, durablePresent: null, durableCurrent: null,
      contextProjection: "unknown" as const, retrieval: "unknown" as const, observedUse: "unknown" as const,
      independentBehavior: "unknown" as const, repeatedWork: "unknown" as const, repeatedWorkUnits: null,
      governedActionExposed: null, assessment: "unknown" as const })) : facts
    const checked = reportFacts.filter(f => f.assessment !== "unknown").length
    const counts = {
      obligations: reportFacts.length, measured: checked, unknown: reportFacts.length - checked,
      failureObserved: reportFacts.filter(f => f.assessment === "failure_observed").length,
      noFailureObserved: reportFacts.filter(f => f.assessment === "no_failure_observed").length,
      coverage: reportFacts.length ? checked / reportFacts.length : null,
    }
    const valid = !globalConflict && localIssues.length === 0
    const extended = b.preBehavior !== undefined || b.lineage !== undefined || b.pruneEvidence !== undefined ||
      b.transition === "control" || b.transition === "prune" || localObs.some(o => o.gradingEvidence !== undefined)
    return { boundaryId: b.boundaryId, taskId: b.taskId, sessionId: b.sessionId, transition: b.transition, compactionMode: b.compactionMode,
      valid, issues: localIssues, counts, facts: reportFacts,
      ...(extended ? { behavioralRegression: measureBehavioralRegression(b, byObligation, previous, valid,
        ids.filter(id => id === b.boundaryId).length === 1 && distinct(obligationIds)) } : {}) }
  })
  return {
    status: (boundaries.length ? "measured" : "unavailable") as "measured" | "unavailable",
    availability: boundaries.length ? "boundary_evidence_supplied" as const : "no_boundary_evidence" as const,
    boundaries: reports,
    totals: { boundaryCount: boundaries.length, obligationCount: reports.reduce((n, b) => n + b.counts.obligations, 0),
      measured: reports.reduce((n, b) => n + b.counts.measured, 0), unknown: reports.reduce((n, b) => n + b.counts.unknown, 0),
      invalidBoundaryCount: reports.filter(b => !b.valid).length },
    issues,
    unavailableReason: boundaries.length ? null : "No per-boundary evidence was supplied; no retention rate or pass/failure result is available.",
    interpretation: "Descriptive boundary measurements only. No causal effect of compaction or comparative superiority is inferred. Missing or incomplete evidence is unknown, never zero or a pass. This function checks internal consistency but cannot authenticate the caller's external-evaluator provenance.",
  }
}

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

export const RetentionBoundarySchema = z.object({
  boundaryId: Id, taskId: Id, sessionId: Id, requestId: Id,
  transition: z.enum(["compaction", "reassignment", "restart"]),
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
      if (o.taskId !== b.taskId || o.sessionId !== b.sessionId) { flag("observation_scope_conflict", `Observation ${o.eventId} task/session differs from its boundary.`); usable = false }
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
    return { boundaryId: b.boundaryId, taskId: b.taskId, sessionId: b.sessionId, transition: b.transition, compactionMode: b.compactionMode,
      valid: !globalConflict && localIssues.length === 0, issues: localIssues, counts, facts: reportFacts }
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

import { z } from "zod"
import { hostTimestamp, messageIdentity, messageSession, observeCompactionMarkers, type compactionReceipt } from "./build-benchmark-protocol.ts"

const ID = z.string().min(1).max(256)
const Digest = z.string().regex(/^[a-f0-9]{64}$/)
const At = z.number().int().nonnegative()
const Base = z.object({ eventId: ID, at: At, taskId: ID, sessionId: ID }).strict()

export const RetentionEventSchema = z.discriminatedUnion("type", [
  Base.extend({ type: z.literal("task_window"), stage: z.enum(["start", "end"]) }),
  Base.extend({ type: z.literal("task_activity"), state: z.enum(["active", "inactive"]) }),
  Base.extend({ type: z.literal("task_activity_coverage"), complete: z.boolean() }),
  Base.extend({ type: z.literal("service_wait"), state: z.enum(["start", "end"]), service: ID }),
  Base.extend({ type: z.literal("service_wait_coverage"), complete: z.boolean() }),
  Base.extend({ type: z.literal("session_lineage"), kind: z.enum(["child", "reassigned", "restarted"]), fromSessionId: ID, toSessionId: ID }),
  Base.extend({ type: z.literal("compaction_census"), complete: z.boolean() }),
  Base.extend({ type: z.literal("assistant_turn"), requestId: ID, role: z.enum(["root", "child", "summary", "compaction", "unknown"]), inputTokens: z.number().int().nonnegative().nullable() }),
  Base.extend({
    type: z.literal("compaction"), mode: z.enum(["native", "requested", "unknown"]), stage: z.enum(["requested", "succeeded", "failed"]), requestId: ID,
    markerId: ID.optional(), summaryAssistantId: ID.optional(), summaryParentId: ID.optional(), summaryTerminal: z.boolean().optional(), summaryErrored: z.boolean().optional(),
  }),
  Base.extend({ type: z.literal("fact_snapshot"), stage: z.enum(["before", "after"]), location: z.enum(["context", "durable"]), facts: z.array(z.object({ factId: ID, digest: Digest }).strict()).max(10_000) }),
  Base.extend({ type: z.literal("fact_retrieval"), factId: ID, outcome: z.enum(["found", "missing", "error"]), observedDigest: Digest.nullable(), freshness: z.enum(["current", "stale", "unknown"]) }),
  Base.extend({ type: z.literal("fact_use"), factId: ID, digest: Digest }),
  Base.extend({ type: z.literal("fact_evaluation"), factId: ID, independent: z.boolean(), outcome: z.enum(["correct", "incorrect", "inaccessible", "unknown"]), expectedDigest: Digest, observedDigest: Digest.nullable() }),
  Base.extend({
    type: z.literal("service_work"), operationId: ID, operation: ID, scopeDigest: Digest, sourceRevision: ID,
    accepted: z.boolean(), acceptedComputation: z.boolean(), workUnits: z.number().nonnegative().nullable(),
    purpose: z.enum(["task_work", "independent_verification", "explicit_refresh", "retry", "unknown"]).optional(),
    duplicateDisposition: z.enum(["avoidable", "legitimate", "unassessed"]).optional(),
  }),
])
export type RetentionEvent = z.infer<typeof RetentionEventSchema>

export const ExpectedFactSchema = z.object({ taskId: ID, factId: ID, digest: Digest,
  category: z.enum(["criteria", "skill", "source", "evidence", "pending_intent", "budget"]), required: z.boolean() }).strict()
export type ExpectedFact = z.infer<typeof ExpectedFactSchema>

/** Convert a bounded host snapshot to passive measurement rows. */
export function hostRetentionEvents(input: {
  taskId: string; sessions: readonly any[]; messages: readonly any[]; startedAt: number; endedAt: number; restarted?: boolean;
  compactionReceipt?: ReturnType<typeof compactionReceipt>; censusComplete: boolean;
}): RetentionEvent[] {
  const events: RetentionEvent[] = []
  let sequence = 0
  const push = (at: number, sessionId: string, type: string, fields: Record<string, unknown> = {}) => {
    events.push({ eventId: `host-${++sequence}`, at: Math.max(0, Math.floor(at)), taskId: input.taskId, sessionId, type, ...fields } as RetentionEvent)
  }
  const sessionParents = new Map<string, string | null>()
  for (const session of input.sessions) if (typeof session?.id === "string" && session.id)
    sessionParents.set(session.id, typeof session.parentID === "string" && session.parentID ? session.parentID : null)
  const receipt = input.compactionReceipt
  const request = receipt?.request
  const rootSession = request?.rootSessionId ?? [...sessionParents].find(([, parent]) => parent === null)?.[0] ?? "session-unknown"
  push(input.startedAt, rootSession, "task_window", { stage: "start" })
  push(input.endedAt, rootSession, "task_window", { stage: "end" })
  for (const [sessionId, parent] of sessionParents) if (parent)
    push(input.endedAt, rootSession, "session_lineage", { kind: "child", fromSessionId: parent, toSessionId: sessionId })
  if (input.restarted) push(input.endedAt, rootSession, "session_lineage", { kind: "restarted", fromSessionId: rootSession, toSessionId: rootSession })

  const latest = new Map<string, (typeof input.messages)[number]>()
  for (const message of input.messages) {
    const id = messageIdentity(message), sessionId = messageSession(message)
    if (id && sessionId) latest.set(JSON.stringify([sessionId, id]), message)
  }
  for (const message of latest.values()) {
    const info = message.info
    if (info.role !== "assistant") continue
    const sessionId = messageSession(message)!
    const at = hostTimestamp(info.time?.completed ?? info.time?.created) ?? input.endedAt
    const role = info.summary === true ? "summary" : message.parts?.some((part: any) => part?.type === "compaction") ? "compaction" :
      sessionParents.get(sessionId) === null ? "root" : sessionParents.has(sessionId) ? "child" : "unknown"
    push(at, sessionId, "assistant_turn", { requestId: info.id, role,
      inputTokens: Number.isSafeInteger(info.tokens?.input) && info.tokens.input >= 0 ? info.tokens.input : null })
  }

  if (request) push(hostTimestamp(request.requestedAt) ?? input.endedAt, rootSession, "compaction", {
    mode: "requested", stage: "requested", requestId: request.id,
  })
  let linkedRequest = false
  for (const marker of observeCompactionMarkers([...latest.values()])) {
    const isRequested = !!request && receipt?.marker.matchesRequest === true &&
      receipt.marker.id === marker.id && receipt.marker.sessionId === marker.sessionId
    const mode = isRequested ? "requested" : marker.auto === true ? "native" : "unknown"
    const requestId = isRequested ? request.id : `marker:${marker.sessionId}:${marker.id}`
    if (isRequested) linkedRequest = true
    else push(marker.createdAt ?? input.endedAt, marker.sessionId, "compaction", { mode, stage: "requested", requestId })
    if (marker.summary) push(marker.summary.completedAt, marker.sessionId, "compaction", {
      mode, stage: "succeeded", requestId, markerId: marker.id, summaryAssistantId: marker.summary.id,
      summaryParentId: marker.id, summaryTerminal: true, summaryErrored: false,
    })
    else if (input.censusComplete) push(input.endedAt, marker.sessionId, "compaction", { mode, stage: "failed", requestId })
  }
  if (request && (receipt?.requestAcceptance === "rejected" ||
    (receipt?.requestAcceptance === "accepted" && input.censusComplete && !linkedRequest))) {
    push(input.endedAt, rootSession, "compaction", { mode: "requested", stage: "failed", requestId: request.id })
  }
  if (events.length >= MAX_EVENTS) return [
    ...events.slice(0, MAX_EVENTS - 1),
    { eventId: `host-${++sequence}`, at: input.endedAt, taskId: input.taskId, sessionId: rootSession, type: "compaction_census", complete: false },
  ]
  push(input.endedAt, rootSession, "compaction_census", { complete: input.censusComplete })
  return events
}

const MAX_EVENTS = 20_000
const MAX_EXPECTED_FACTS = 5_000

function intervalSeconds(intervals: Array<[number, number]>): number {
  const sorted = intervals.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start).sort((a, b) => a[0] - b[0])
  let total = 0, start: number | undefined, end = 0
  for (const [nextStart, nextEnd] of sorted) {
    if (start === undefined) { start = nextStart; end = nextEnd }
    else if (nextStart <= end) end = Math.max(end, nextEnd)
    else { total += end - start; start = nextStart; end = nextEnd }
  }
  if (start !== undefined) total += end - start
  return total / 1000
}

function rates(count: number, turns: number, activeSeconds: number | null, elapsedSeconds: number, knownTokens: number, tokenCoverage: number | null) {
  return {
    per100AssistantTurns: turns > 0 ? count * 100 / turns : null,
    perActiveHour: activeSeconds !== null && activeSeconds > 0 ? count * 3600 / activeSeconds : null,
    perObservedElapsedHour: elapsedSeconds > 0 ? count * 3600 / elapsedSeconds : null,
    perMillionKnownInputTokens: tokenCoverage === 1 && knownTokens > 0 ? count * 1_000_000 / knownTokens : null,
  }
}

interface FactObservation {
  factId: string
  category: ExpectedFact["category"]
  required: boolean
  expectedDigest: string
  contextBefore: boolean | null
  contextAfter: boolean | null
  durableBefore: boolean | null
  durableAfter: boolean | null
  omittedFromContext: boolean
  missingDurable: boolean
  retrievedFactIds: string[]
  usedFactIds: string[]
  wrongOrStaleRetrieval: boolean
  independentlyEvaluated: boolean
  assessment: "demonstrated_loss" | "no_loss_observed" | "uncertain" | "untested"
}

function measureTask(taskId: string, events: RetentionEvent[], expectedFacts: ExpectedFact[]) {
  const ordered = events.map((event, index) => ({ event, index })).sort((a, b) => a.event.at - b.event.at || a.index - b.index).map(item => item.event)
  const sessions = new Set<string>()
  const lineage: Array<{ kind: "child" | "reassigned" | "restarted"; fromSessionId: string; toSessionId: string; at: number }> = []
  const activityIntervals: Array<[number, number]> = [], waitIntervals: Array<[number, number]> = []
  let activeStart: number | undefined
  let taskStart: number | undefined, taskEnd: number | undefined
  let activityCoverageComplete: boolean | undefined, serviceWaitCoverageComplete: boolean | undefined, compactionCensusComplete: boolean | undefined
  const waitStarts = new Map<string, number>()
  for (const event of ordered) {
    sessions.add(event.sessionId)
    if (event.type === "session_lineage") { sessions.add(event.fromSessionId); sessions.add(event.toSessionId); lineage.push({ kind: event.kind, fromSessionId: event.fromSessionId, toSessionId: event.toSessionId, at: event.at }) }
    else if (event.type === "task_window") { if (event.stage === "start") taskStart ??= event.at; else taskEnd = event.at }
    else if (event.type === "task_activity_coverage") activityCoverageComplete = event.complete
    else if (event.type === "service_wait_coverage") serviceWaitCoverageComplete = event.complete
    else if (event.type === "compaction_census") compactionCensusComplete = event.complete
    else if (event.type === "task_activity") {
      if (event.state === "active") activeStart ??= event.at
      else if (activeStart !== undefined) { activityIntervals.push([activeStart, event.at]); activeStart = undefined }
    } else if (event.type === "service_wait") {
      const key = event.service
      if (event.state === "start") waitStarts.set(key, event.at)
      else { const start = waitStarts.get(key); if (start !== undefined) { waitIntervals.push([start, event.at]); waitStarts.delete(key) } }
    }
  }
  const lastAt = taskEnd ?? ordered.at(-1)?.at ?? 0
  const firstAt = taskStart ?? ordered[0]?.at ?? lastAt
  if (activeStart !== undefined) activityIntervals.push([activeStart, lastAt])
  for (const start of waitStarts.values()) waitIntervals.push([start, lastAt])
  const activityWallSeconds = intervalSeconds(activityIntervals)
  const serviceWaitObservedSeconds = intervalSeconds(waitIntervals)
  const taskActiveObservedSeconds = Math.max(0, activityWallSeconds - intervalSeconds(
    // Intersect each active interval with each service wait so waiting is excluded once.
    activityIntervals.flatMap(([a, b]) => waitIntervals.map(([w1, w2]): [number, number] => [Math.max(a, w1), Math.min(b, w2)])),
  ))
  const elapsedWallSeconds = Math.max(0, (lastAt - firstAt) / 1000)
  const activeCoverageComplete = activityCoverageComplete === true && serviceWaitCoverageComplete === true
  const taskActiveWallSeconds = activeCoverageComplete ? taskActiveObservedSeconds : null
  const serviceWaitSeconds = serviceWaitCoverageComplete === true ? serviceWaitObservedSeconds : null

  const turns = ordered.filter((event): event is Extract<RetentionEvent, { type: "assistant_turn" }> => event.type === "assistant_turn")
  const knownInputTokens = turns.reduce((sum, turn) => sum + (turn.inputTokens ?? 0), 0)
  const knownInputTurns = turns.filter(turn => turn.inputTokens !== null).length
  const inputTokenCoverage = turns.length ? knownInputTurns / turns.length : null
  const compactions = new Map<string, { mode: "native" | "requested" | "unknown"; requested: boolean; terminal?: "succeeded" | "failed"; at: number; qualified: boolean }>()
  for (const event of ordered) if (event.type === "compaction") {
    const current = compactions.get(event.requestId) ?? { mode: event.mode, requested: false, at: event.at, qualified: false }
    current.mode = event.mode
    if (event.stage === "requested") current.requested = true
    else {
      current.terminal = event.stage
      current.at = event.at
      current.qualified = event.stage === "succeeded" && !!event.markerId && !!event.summaryAssistantId &&
        event.summaryParentId === event.markerId && event.summaryTerminal === true && event.summaryErrored === false
    }
    compactions.set(event.requestId, current)
  }
  const compactionSummary = { native: { attempts: 0, successful: 0, failed: 0, pending: 0 }, requested: { attempts: 0, successful: 0, failed: 0, pending: 0 }, unknown: { attempts: 0, successful: 0, failed: 0, pending: 0 } }
  const qualifiedCompactionTimes: number[] = []
  for (const item of compactions.values()) {
    const metric = compactionSummary[item.mode]
    metric.attempts++
    if (item.terminal === "failed") metric.failed++
    else if (item.terminal === "succeeded" && item.qualified) { metric.successful++; qualifiedCompactionTimes.push(item.at) }
    else if (item.terminal === "succeeded") metric.failed++
    else metric.pending++
  }
  const totalCompaction = compactionSummary.native.attempts + compactionSummary.requested.attempts + compactionSummary.unknown.attempts
  const compactionRate = (count: number) => compactionCensusComplete === true
    ? rates(count, turns.length, taskActiveWallSeconds, elapsedWallSeconds, knownInputTokens, inputTokenCoverage)
    : rates(count, 0, null, 0, 0, null)
  const compactionRates = {
    attempts: compactionRate(totalCompaction),
    successful: compactionRate(compactionSummary.native.successful + compactionSummary.requested.successful + compactionSummary.unknown.successful),
    failed: compactionRate(compactionSummary.native.failed + compactionSummary.requested.failed + compactionSummary.unknown.failed),
  }

  const snapshots = new Map<string, Map<string, string>>()
  for (const event of ordered) if (event.type === "fact_snapshot") {
    const key = `${event.stage}:${event.location}`, facts = snapshots.get(key) ?? new Map<string, string>()
    for (const fact of event.facts) facts.set(fact.factId, fact.digest)
    snapshots.set(key, facts)
  }
  const factObservations: FactObservation[] = expectedFacts.map(expected => {
    const beforeContext = snapshots.get("before:context"), afterContext = snapshots.get("after:context")
    const beforeDurable = snapshots.get("before:durable"), afterDurable = snapshots.get("after:durable")
    const contextBefore = beforeContext ? beforeContext.get(expected.factId) === expected.digest : null
    const contextAfter = afterContext ? afterContext.get(expected.factId) === expected.digest : null
    const durableBefore = beforeDurable ? beforeDurable.get(expected.factId) === expected.digest : null
    const durableAfter = afterDurable ? afterDurable.get(expected.factId) === expected.digest : null
    const retrievals = ordered.filter((event): event is Extract<RetentionEvent, { type: "fact_retrieval" }> => event.type === "fact_retrieval" && event.factId === expected.factId)
    const uses = ordered.filter((event): event is Extract<RetentionEvent, { type: "fact_use" }> => event.type === "fact_use" && event.factId === expected.factId)
    const evaluations = ordered.filter((event): event is Extract<RetentionEvent, { type: "fact_evaluation" }> => event.type === "fact_evaluation" && event.factId === expected.factId && event.independent)
    const retrievedFactIds = retrievals.filter(event => event.outcome === "found" && event.observedDigest === expected.digest && event.freshness === "current").map(event => event.factId)
    const usedFactIds = uses.filter(event => event.digest === expected.digest).map(event => event.factId)
    const wrongOrStaleRetrieval = retrievals.some(event => event.outcome === "found" &&
      (event.observedDigest !== expected.digest || event.freshness === "stale"))
    const omittedFromContext = contextBefore === true && contextAfter === false
    const missingDurable = durableBefore === true && durableAfter === false
    const failedEvaluation = evaluations.some(event => (event.outcome === "incorrect" || event.outcome === "inaccessible") &&
      event.expectedDigest === expected.digest && qualifiedCompactionTimes.some(at => at <= event.at) &&
      (contextBefore === true || durableBefore === true))
    const correctEvaluation = evaluations.some(event => event.outcome === "correct" && event.expectedDigest === expected.digest && event.observedDigest === expected.digest &&
      qualifiedCompactionTimes.some(at => at <= event.at))
    const assessment: FactObservation["assessment"] = failedEvaluation ? "demonstrated_loss" : correctEvaluation ? "no_loss_observed" :
      evaluations.some(event => event.outcome === "unknown") || retrievals.some(event => event.outcome === "error" || event.freshness === "unknown") ||
      (omittedFromContext || missingDurable || wrongOrStaleRetrieval) ? "uncertain" : "untested"
    return { factId: expected.factId, category: expected.category, required: expected.required, expectedDigest: expected.digest,
      contextBefore, contextAfter, durableBefore, durableAfter, omittedFromContext, missingDurable, retrievedFactIds, usedFactIds,
      wrongOrStaleRetrieval, independentlyEvaluated: evaluations.length > 0, assessment }
  })
  const requiredObservations = factObservations.filter(fact => fact.required)
  const lossClaim = requiredObservations.some(fact => fact.assessment === "demonstrated_loss") ? "demonstrated_loss" :
    requiredObservations.length > 0 && requiredObservations.every(fact => fact.assessment === "no_loss_observed") ? "no_loss_observed" :
      requiredObservations.some(fact => fact.assessment === "uncertain") ? "uncertain" : "untested"

  const serviceEvents = ordered.filter((event): event is Extract<RetentionEvent, { type: "service_work" }> => event.type === "service_work" && event.accepted && event.acceptedComputation)
  const uniqueOperations = new Map<string, Extract<RetentionEvent, { type: "service_work" }>>()
  for (const event of serviceEvents) uniqueOperations.set(event.operationId, event)
  const work = [...uniqueOperations.values()].sort((a, b) => a.at - b.at || a.operationId.localeCompare(b.operationId))
  const serviceKey = (event: Extract<RetentionEvent, { type: "service_work" }>) => JSON.stringify([event.operation, event.scopeDigest, event.sourceRevision])
  const firstOperation = new Map<string, Extract<RetentionEvent, { type: "service_work" }>>()
  const compactionTimes = [...compactions.values()].filter(item => item.terminal === "succeeded" && item.qualified).map(item => item.at)
  const duplicates: Array<{ operationId: string; afterSuccessfulCompaction: boolean; workUnits: number | null }> = []
  for (const operation of work) {
    const key = serviceKey(operation), first = firstOperation.get(key)
    if (first && first.operationId !== operation.operationId) duplicates.push({ operationId: operation.operationId,
      afterSuccessfulCompaction: compactionTimes.some(at => first.at < at && at <= operation.at), workUnits: operation.workUnits })
    else if (!first) firstOperation.set(key, operation)
  }
  const knownDuplicateWorkUnits = duplicates.reduce((sum, item) => sum + (item.workUnits ?? 0), 0)
  const unknownDuplicateWorkUnits = duplicates.filter(item => item.workUnits === null).length
  const repeatedWork = duplicates.map(item => uniqueOperations.get(item.operationId)!)
  const explicitlyAvoidableDuplicates = repeatedWork.filter(event => event.duplicateDisposition === "avoidable")
  const explicitlyLegitimateDuplicates = repeatedWork.filter(event => event.duplicateDisposition === "legitimate" ||
    (event.duplicateDisposition !== "avoidable" && (event.purpose === "independent_verification" || event.purpose === "explicit_refresh")))

  return {
    taskId, sessions: [...sessions].sort(), lineage,
    time: { elapsedWallSeconds, taskActiveWallSeconds, taskActiveObservedWallSeconds: taskActiveObservedSeconds,
      taskActiveCoverage: activeCoverageComplete ? "complete" : "unproven",
      serviceWaitSeconds, serviceWaitObservedSeconds, serviceWaitCoverage: serviceWaitCoverageComplete === true ? "complete" : "unproven" },
    turns: { assistantTurns: turns.length, byRole: Object.fromEntries(["root", "child", "summary", "compaction", "unknown"].map(role => [role, turns.filter(turn => turn.role === role).length])),
      knownInputTokens, inputTokenCoverage, turnsWithKnownInput: knownInputTurns, turnsWithUnknownInput: turns.length - knownInputTurns },
    compactions: { ...compactionSummary, censusComplete: compactionCensusComplete === true,
      countsInterpretation: compactionCensusComplete === true ? "complete_host_census" : "observed_lower_bounds_only_missing_markers_are_not_zero" }, compactionRates,
    facts: { expectedCount: expectedFacts.length, evidenceCoverage: expectedFacts.length ? "expected_facts_provided_but_boundary_attribution_is_task_aggregate" : "unavailable_no_obligation_probes_wired",
      observations: factObservations, lossClaim, granularity: "task_aggregate_no_per_compaction_boundary_attribution",
      rule: "Absence from context alone is not information loss; untested facts support no loss claim." },
    serviceWork: { evidenceCoverage: work.length ? "host_observed" : "unavailable_or_zero_exposure_not_distinguished",
      acceptedComputations: work.length, repeatedAcceptedComputations: duplicates.length, explicitlyAvoidableDuplicateComputations: explicitlyAvoidableDuplicates.length,
      explicitlyLegitimateEquivalentComputations: explicitlyLegitimateDuplicates.length, duplicatesAfterSuccessfulCompaction: duplicates.filter(item => item.afterSuccessfulCompaction).length,
      duplicateWorkUnitsKnown: knownDuplicateWorkUnits, duplicateWorkUnitsUnknownCount: unknownDuplicateWorkUnits,
      duplicateEvents: duplicates, interpretation: "Repeated accepted equivalents and explicitly assessed avoidable duplicates are separate; absent an external duplicate assessment this metric makes no avoidability claim. Temporal association only; it does not attribute duplicate work to compaction." },
  }
}

/** Pure bounded aggregation of host-observed events. It creates no runtime state or policy. */
export function measureBuildBenchmarkRetention(rawEvents: unknown, rawExpectedFacts: unknown) {
  const eventsParsed = z.array(RetentionEventSchema).max(MAX_EVENTS).safeParse(rawEvents)
  if (!eventsParsed.success) throw new Error("retention_events_invalid_or_over_limit")
  const factsParsed = z.array(ExpectedFactSchema).max(MAX_EXPECTED_FACTS).safeParse(rawExpectedFacts)
  if (!factsParsed.success) throw new Error("retention_expected_facts_invalid_or_over_limit")
  if (new Set(eventsParsed.data.map(event => event.eventId)).size !== eventsParsed.data.length) throw new Error("retention_event_ids_must_be_unique")
  const factKeys = factsParsed.data.map(fact => `${fact.taskId}\0${fact.factId}`)
  if (new Set(factKeys).size !== factKeys.length) throw new Error("retention_expected_fact_ids_must_be_unique_per_task")
  const byTask = new Map<string, RetentionEvent[]>()
  for (const event of eventsParsed.data) { const rows = byTask.get(event.taskId) ?? []; rows.push(event); byTask.set(event.taskId, rows) }
  const factsByTask = new Map<string, ExpectedFact[]>()
  for (const fact of factsParsed.data) { const rows = factsByTask.get(fact.taskId) ?? []; rows.push(fact); factsByTask.set(fact.taskId, rows) }
  const taskIds = new Set([...byTask.keys(), ...factsByTask.keys()])
  return { schema: "alg-build-retention-v1", eventCount: eventsParsed.data.length, expectedFactCount: factsParsed.data.length,
    tasks: [...taskIds].sort().map(taskId => measureTask(taskId, byTask.get(taskId) ?? [], factsByTask.get(taskId) ?? [])) }
}

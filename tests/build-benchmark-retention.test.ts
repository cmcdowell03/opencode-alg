import { describe, expect, test } from "bun:test"
import { hostRetentionEvents, measureBuildBenchmarkRetention, type RetentionEvent } from "../scripts/build-benchmark-retention.ts"
import { compactionReceipt } from "../scripts/build-benchmark-protocol.ts"

const taskId = "pair-1:case-a:alg_default"
const digest = (char: string) => char.repeat(64)
const ev = (eventId: string, at: number, type: string, more: Record<string, unknown> = {}, sessionId = "root") =>
  ({ eventId, at, taskId, sessionId, type, ...more }) as RetentionEvent
const run = (events: RetentionEvent[], facts: unknown[] = []) => measureBuildBenchmarkRetention(events, facts).tasks[0]!

describe("build benchmark retention measurement", () => {
  test("aggregates compaction exposure across a stable task and session lineage", () => {
    const events: RetentionEvent[] = [
      ev("start", 0, "task_window", { stage: "start" }),
      ev("turn1", 1_000, "assistant_turn", { requestId: "r1", role: "root", inputTokens: 100 }),
      ev("requested", 2_000, "compaction", { mode: "requested", stage: "requested", requestId: "c1" }),
      ev("compact-ok", 3_000, "compaction", { mode: "requested", stage: "succeeded", requestId: "c1", markerId: "m1", summaryAssistantId: "a1", summaryParentId: "m1", summaryTerminal: true, summaryErrored: false }),
      ev("lineage", 4_000, "session_lineage", { kind: "restarted", fromSessionId: "root", toSessionId: "root-2" }, "root"),
      ev("turn2", 5_000, "assistant_turn", { requestId: "r2", role: "child", inputTokens: null }, "root-2"),
      ev("native-fail", 6_000, "compaction", { mode: "unknown", stage: "failed", requestId: "c2" }, "root-2"),
      ev("end", 10_000, "task_window", { stage: "end" }, "root-2"),
      ev("census", 10_000, "compaction_census", { complete: true }, "root-2"),
    ]
    const measured = run(events)
    expect(measured.sessions).toEqual(["root", "root-2"])
    expect(measured.lineage).toHaveLength(1)
    expect(measured.compactions).toMatchObject({ requested: { attempts: 1, successful: 1 }, unknown: { attempts: 1, failed: 1 }, censusComplete: true })
    expect(measured.compactionRates.attempts.per100AssistantTurns).toBe(100)
    expect(measured.compactionRates.attempts.perObservedElapsedHour).toBe(720)
    expect(measured.compactionRates.attempts.perActiveHour).toBeNull()
    expect(measured.compactionRates.attempts.perMillionKnownInputTokens).toBeNull()
    expect(measured.turns.inputTokenCoverage).toBe(0.5)
    expect(measured.compactionTiming).toMatchObject({ timeToFirstObservedSeconds: 3, turnsToFirstObserved: 1,
      observedIntervalSeconds: [], events: [{ requestId: "c1", requestToSummarySeconds: 1 }, { requestId: "c2", requestToSummarySeconds: null }] })
  })

  test("distinguishes changed criteria, stale skills, pending loss, and retrieval after context omission", () => {
    const facts = [
      { taskId, factId: "criteria", digest: digest("a"), category: "criteria", required: true },
      { taskId, factId: "skill", digest: digest("b"), category: "skill", required: true },
      { taskId, factId: "pending", digest: digest("c"), category: "pending_intent", required: true },
      { taskId, factId: "source", digest: digest("d"), category: "source", required: true },
    ]
    const snapshot = (id: string, stage: "before" | "after", location: "context" | "durable", included: boolean, at: number) =>
      ev(id, at, "fact_snapshot", { stage, location, facts: included ? [{ factId: id.startsWith("criteria") ? "criteria" : id.startsWith("skill") ? "skill" : id.startsWith("pending") ? "pending" : "source", digest: id.startsWith("criteria") ? digest("a") : id.startsWith("skill") ? digest("b") : id.startsWith("pending") ? digest("c") : digest("d") }] : [] })
    const events: RetentionEvent[] = [
      ev("compact", 10, "compaction", { mode: "requested", stage: "succeeded", requestId: "c", markerId: "m", summaryAssistantId: "s", summaryParentId: "m", summaryTerminal: true, summaryErrored: false }),
      snapshot("criteria-before-context", "before", "context", true, 1), snapshot("criteria-after-context", "after", "context", false, 11),
      ev("criteria-incorrect", 12, "fact_evaluation", { factId: "criteria", independent: true, outcome: "incorrect", expectedDigest: digest("a"), observedDigest: digest("e") }),
      snapshot("skill-before-context", "before", "context", true, 1), snapshot("skill-after-context", "after", "context", true, 11),
      ev("skill-stale", 13, "fact_retrieval", { factId: "skill", outcome: "found", observedDigest: digest("f"), freshness: "stale" }),
      ev("skill-wrong", 14, "fact_evaluation", { factId: "skill", independent: true, outcome: "incorrect", expectedDigest: digest("b"), observedDigest: digest("f") }),
      snapshot("pending-before-durable", "before", "durable", true, 1), snapshot("pending-after-durable", "after", "durable", false, 11),
      ev("pending-lost", 15, "fact_evaluation", { factId: "pending", independent: true, outcome: "inaccessible", expectedDigest: digest("c"), observedDigest: null }),
      snapshot("source-before-context", "before", "context", true, 1), snapshot("source-after-context", "after", "context", false, 11),
      ev("source-found", 12, "fact_retrieval", { factId: "source", outcome: "found", observedDigest: digest("d"), freshness: "current" }),
      ev("source-used", 13, "fact_use", { factId: "source", digest: digest("d") }),
      ev("source-correct", 14, "fact_evaluation", { factId: "source", independent: true, outcome: "correct", expectedDigest: digest("d"), observedDigest: digest("d") }),
    ]
    const result = run(events, facts)
    expect(result.facts.lossClaim).toBe("demonstrated_loss")
    expect(result.facts.observations).toMatchObject([
      { factId: "criteria", omittedFromContext: true, assessment: "demonstrated_loss" },
      { factId: "skill", wrongOrStaleRetrieval: true, assessment: "demonstrated_loss" },
      { factId: "pending", missingDurable: true, assessment: "demonstrated_loss" },
      { factId: "source", omittedFromContext: true, retrievedFactIds: ["source"], usedFactIds: ["source"], assessment: "no_loss_observed" },
    ])
    expect(result.facts.granularity).toContain("task_aggregate")
  })

  test("does not infer avoidability from equivalent keys and treats incomplete census as unknown exposure", () => {
    const events: RetentionEvent[] = [
      ev("work1", 1, "service_work", { operationId: "w1", operation: "query", scopeDigest: digest("a"), sourceRevision: "rev1", accepted: true, acceptedComputation: true, workUnits: 4, purpose: "task_work" }),
      ev("work2", 2, "service_work", { operationId: "w2", operation: "query", scopeDigest: digest("a"), sourceRevision: "rev1", accepted: true, acceptedComputation: true, workUnits: 4, purpose: "independent_verification" }),
      ev("work3", 3, "service_work", { operationId: "w3", operation: "query", scopeDigest: digest("a"), sourceRevision: "rev1", accepted: true, acceptedComputation: true, workUnits: 4, duplicateDisposition: "avoidable" }),
    ]
    const result = run(events)
    expect(result.serviceWork).toMatchObject({ acceptedComputations: 3, repeatedAcceptedComputations: 2,
      explicitlyAvoidableDuplicateComputations: 1, explicitlyLegitimateEquivalentComputations: 1 })
    expect(result.compactions.censusComplete).toBe(false)
    expect(result.compactions.countsInterpretation).toContain("lower_bounds")
    expect(result.facts).toMatchObject({ evidenceCoverage: "unavailable_no_obligation_probes_wired", lossClaim: "untested" })
  })

  test("a complete zero-exposure census is zero and incomplete telemetry never fills missing denominators", () => {
    const measured = run([ev("census", 5_000, "compaction_census", { complete: true })])
    expect(measured.compactions.censusComplete).toBe(true)
    expect(measured.compactions.requested.attempts + measured.compactions.native.attempts + measured.compactions.unknown.attempts).toBe(0)
    expect(measured.compactionRates.attempts).toMatchObject({ per100AssistantTurns: null, perObservedElapsedHour: null, perActiveHour: null, perMillionKnownInputTokens: null })
  })

  test("an incomplete census publishes observed counts without rates or assumed failures", () => {
    const messages = [
      { info: { id: "marker", sessionID: "s1", role: "assistant", time: { created: 1_000 } }, parts: [{ type: "compaction", auto: false }] },
      { info: { id: "summary-old", sessionID: "s1", role: "assistant", summary: true, parentID: "marker", time: { completed: 900 } }, parts: [] },
      { info: { id: "summary-wrong-session", sessionID: "s2", role: "assistant", summary: true, parentID: "marker", time: { completed: 1_200 } }, parts: [] },
      { info: { id: "native-marker", sessionID: "s2", role: "assistant", time: { created: 1_300 } }, parts: [{ type: "compaction", auto: true }] },
    ]
    const request = compactionReceipt({ requestId: "request-1", requestedAt: new Date(800_000).toISOString(), rootSessionId: "s1", response: true,
      beforeMessages: [], afterMessages: messages, continuation: { status: "not_completed" } })
    expect(request.summaryExposureQualified).toBe(false)
    const rows = hostRetentionEvents({ taskId, sessions: [{ id: "s1" }, { id: "s2", parentID: "s1" }], messages,
      startedAt: 500_000, endedAt: 2_000_000, restarted: true, censusComplete: false, compactionReceipt: request })
    const measured = run(rows)
    expect(measured.compactions).toMatchObject({ requested: { attempts: 1, failed: 0, pending: 1 }, native: { attempts: 1, failed: 0, pending: 1 }, censusComplete: false })
    expect(measured.compactionRates.attempts).toEqual({ per100AssistantTurns: null, perActiveHour: null, perObservedElapsedHour: null, perMillionKnownInputTokens: null })
    expect(measured.lineage.map(item => item.kind)).toEqual(["child", "restarted"])
  })
})

test("compaction intervals retain one task timeline after reassignment", () => {
  const events = [ev("start", 0, "task_window", { stage: "start" }),
    ev("first", 2_000, "compaction", { mode: "native", stage: "succeeded", requestId: "first", markerId: "m1", summaryAssistantId: "s1", summaryParentId: "m1", summaryTerminal: true, summaryErrored: false }),
    ev("handoff", 3_000, "session_lineage", { kind: "reassigned", fromSessionId: "root", toSessionId: "new" }),
    ev("second", 7_000, "compaction", { mode: "requested", stage: "succeeded", requestId: "second", markerId: "m2", summaryAssistantId: "s2", summaryParentId: "m2", summaryTerminal: true, summaryErrored: false }, "new"),
  ]
  expect(run(events).compactionTiming).toMatchObject({ timeToFirstObservedSeconds: 2, observedIntervalSeconds: [5],
    coverage: "observed_events_only_intervening_events_may_be_missing" })
  expect(run(events).compactionTiming.events.every(event => event.requestToSummarySeconds === null)).toBe(true)
  expect(() => run([...events, ev("conflict", 8_000, "compaction", { mode: "requested", stage: "failed", requestId: "first" }, "unrelated")])).toThrow("retention_compaction_request_session_conflict")
})

test("root and child turns follow session ancestry, and accepted compaction counts despite failed recovery", () => {
  const at = 1_800_000_000_000
  const marker = { info: { id: "m", sessionID: "s1", role: "user", time: { created: at + 100 } }, parts: [{ type: "compaction", auto: false }] }
  const summary = { info: { id: "summary", sessionID: "s1", role: "assistant", summary: true, parentID: "m", time: { completed: (at + 200) / 1000 } }, parts: [] }
  const rootTurn = { info: { id: "turn", role: "assistant", sessionID: "s1", parentID: "user", tokens: { input: 10 } }, parts: [] }
  const childTurn = { ...rootTurn, info: { ...rootTurn.info, sessionID: "s2" } }
  const messages = [marker, summary, rootTurn, rootTurn, childTurn]
  const request = compactionReceipt({ requestId: "r", requestedAt: new Date(at).toISOString(), rootSessionId: "s1", response: true,
    beforeMessages: [], afterMessages: messages, continuation: { status: "not_completed" } })
  expect(request.qualified).toBe(false)
  expect(request.summaryExposureQualified).toBe(true)
  const rows = hostRetentionEvents({ taskId, sessions: [{ id: "s1" }, { id: "s2", parentID: "s1" }], messages,
    startedAt: at, endedAt: at + 1000, compactionReceipt: request, censusComplete: false })
  expect(rows.find(event => event.type === "compaction" && event.stage === "succeeded")?.at).toBe(at + 200)
  const measured = run(rows)
  expect(measured.turns).toMatchObject({ assistantTurns: 3, byRole: { root: 1, child: 1, summary: 1 }, knownInputTokens: 20 })
  expect(measured.compactions.requested).toEqual({ attempts: 1, successful: 1, failed: 0, pending: 0, unverified: 0 })
  expect(measured.compactionRates.successful.per100AssistantTurns).toBeNull()
})

test("a wrong completed answer remains summary exposure with either complete or incomplete census", () => {
  const at = 1_800_000_000_000
  const messages = [
    { info: { id: "marker", sessionID: "s1", role: "user", time: { created: at + 100 } }, parts: [{ type: "compaction", auto: false }] },
    { info: { id: "summary", sessionID: "s1", role: "assistant", parentID: "marker", summary: true, time: { completed: at + 200 } }, parts: [] },
    { info: { id: "user", sessionID: "s1", role: "user", time: { created: at + 300 } }, parts: [] },
    { info: { id: "answer", sessionID: "s1", role: "assistant", parentID: "user", time: { completed: at + 400 } }, parts: [] },
  ]
  const request = compactionReceipt({ requestId: "r", requestedAt: new Date(at).toISOString(), rootSessionId: "s1", response: true,
    beforeMessages: [], afterMessages: messages, continuationMessages: messages,
    continuation: { status: "completed", userMessageID: "user", assistantID: "answer", scorePassed: false } })
  expect(request).toMatchObject({ qualified: false, summaryExposureQualified: true, continuation: { completionLinked: true, linked: false } })
  for (const censusComplete of [false, true]) {
    const measured = run(hostRetentionEvents({ taskId, sessions: [{ id: "s1" }], messages,
      startedAt: at, endedAt: at + 1000, censusComplete, compactionReceipt: request }))
    expect(measured.compactions.requested).toEqual({ attempts: 1, successful: 1, failed: 0, pending: 0, unverified: 0 })
    expect(measured.compactions.censusComplete).toBe(censusComplete)
    expect(measured.compactionRates.successful.per100AssistantTurns).toBe(censusComplete ? 50 : null)
  }
})

test("unlinked success is unverified, not an observed failed summary", () => {
  const measured = run([ev("unlinked", 1, "compaction", { mode: "native", stage: "succeeded", requestId: "c" })])
  expect(measured.compactions.native).toMatchObject({ attempts: 1, successful: 0, failed: 0, unverified: 1 })
  expect(measured.compactionTiming.events[0]?.status).toBe("unverified_summary")
})

test("only repeated accepted work can be a classified duplicate and only cross-boundary repeats count after compaction", () => {
  const work = (id: string, at: number, scope: string, purpose?: string) => ev(id, at, "service_work", {
    operationId: id, operation: "query", scopeDigest: digest(scope), sourceRevision: "rev1", accepted: true,
    acceptedComputation: true, workUnits: 4, purpose,
  })
  const measured = run([
    work("one", 1, "a", "independent_verification"),
    ev("compact", 2, "compaction", { mode: "requested", stage: "succeeded", requestId: "c", markerId: "m",
      summaryAssistantId: "s", summaryParentId: "m", summaryTerminal: true, summaryErrored: false }),
    work("two", 3, "a"),
    work("three", 4, "b"),
    work("four", 5, "b", "independent_verification"),
  ])
  expect(measured.serviceWork).toMatchObject({ acceptedComputations: 4, repeatedAcceptedComputations: 2,
    explicitlyLegitimateEquivalentComputations: 1, duplicatesAfterSuccessfulCompaction: 1 })
})


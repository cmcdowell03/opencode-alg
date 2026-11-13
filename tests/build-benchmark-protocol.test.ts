import { describe, expect, test } from "bun:test"
import type { SessionSummarizeResponses } from "@opencode-ai/sdk/client"
import { benchmarkObservedStop, reconcileHostCensus, compactionIsQualified, compactionSummaryExposureIsQualified, compactionReceipt, eligibility, finalCensus, issuePairs, scheduleIssuedPairs, summarizeIssuedArms } from "../scripts/build-benchmark-protocol.ts"

const followupHistory = (sessionID = "s1", userId = "followup-user", assistantId = "followup-assistant", parentID = userId) => [
  { info: { id: userId, sessionID, role: "user", time: { created: 1_800_000_000_300 } }, parts: [] },
  { info: { id: assistantId, sessionID, role: "assistant", parentID, time: { completed: 1_800_000_000_400 } }, parts: [] },
]

describe("benchmark protocol integrity", () => {
  test("observed cumulative limits stop at equality including maintenance and resumed-phase usage", () => {
    const limits={assistantTurns:40,reportedComponents:200000}, base={now:100,deadline:1000,assistantTurns:39,reportedComponents:199999}
    expect(benchmarkObservedStop(base,limits)).toBeNull()
    expect(benchmarkObservedStop({...base,assistantTurns:40},limits)).toBe("assistant_turn_limit")
    expect(benchmarkObservedStop({...base,reportedComponents:120000+10000+70000},limits)).toBe("reported_component_limit")
    expect(benchmarkObservedStop({...base,now:1000},limits)).toBe("trial_deadline")
    expect(benchmarkObservedStop({...base,reportedComponents:NaN},limits)).toBe("invalid_usage_observation")
  })

  test("database census requires exact session/message IDs, ownership, uniqueness and quiescence", () => {
    const base={storedSessions:["s"],storedMessages:[{id:"m",session_id:"s"}],observedSessions:["s"],observedMessages:[{id:"m",session_id:"s"}],quiescent:true}
    expect(reconcileHostCensus(base).qualified).toBe(true)
    expect(reconcileHostCensus({...base,observedMessages:[]}).qualified).toBe(false)
    expect(reconcileHostCensus({...base,quiescent:false}).qualified).toBe(false)
    expect(reconcileHostCensus({...base,storedMessages:[...base.storedMessages,...base.storedMessages]}).qualified).toBe(false)
    expect(reconcileHostCensus({...base,observedMessages:[{id:"m",session_id:"other"}]}).qualified).toBe(false)
    expect(reconcileHostCensus({...base,storedSessions:[],observedSessions:[]}).qualified).toBe(false)
  })
  test("issues matched default Build/ALG pairs and isolates targeted compatibility as opt-in", () => {
    const cases = [{ id: "a" }, { id: "b" }]
    expect(issuePairs(cases, "default")[0]!.arms.map(row => row.arm)).toEqual(["build", "alg_default"])
    expect(issuePairs(cases, "targeted_compatibility")[0]!.arms.map(row => row.arm)).toEqual(["build", "alg_targeted"])
    expect(issuePairs(cases, "default")[0]!.arms.every(row => row.status === "issued_not_started")).toBe(true)
  })

  test("binds a non-contiguous case subset to its own pairs and execution order", () => {
    const cases = [{ id: "first" }, { id: "middle" }, { id: "third" }, { id: "fourth" }]
    expect(scheduleIssuedPairs([cases[1]!, cases[3]!], "default").map(({ fixture, pair, index, order }) =>
      [fixture.id, pair.caseId, index, order])).toEqual([
        ["middle", "middle", 0, ["build", "alg_default"]],
        ["fourth", "fourth", 1, ["alg_default", "build"]],
      ])
  })

  test("keeps every upfront-issued arm in the denominator when the suite stops before its launch", () => {
    const rows = [{ status: "completed" }, { status: "stopped_before_start_suite_deadline" }]
    expect(summarizeIssuedArms(rows)).toEqual({ issued: 2, unissued: 0, completed: 1, stopped: 1, primaryDenominator: 2, complete: true })
    expect(summarizeIssuedArms([{ status: "completed" }, { status: "issued_not_started" }])).toMatchObject({
      issued: 2, primaryDenominator: 2, complete: false,
    })
  })

  test("separates preflight rows from issued trials and closes a terminal stopped trial", () => {
    expect(summarizeIssuedArms([{ status: "preflight_passed" }, { status: "preflight_failed" }], "preflight")).toEqual({
      issued: 0, unissued: 2, completed: 0, stopped: 0, primaryDenominator: 0, complete: true,
      preflight: { planned: 2, passed: 1, failed: 1, stopped: 0 },
    })
    expect(summarizeIssuedArms([{ status: "completed" }, { status: "stopped" }])).toMatchObject({
      issued: 2, completed: 1, stopped: 1, primaryDenominator: 2, complete: true,
    })
  })

  test("accepts the SDK boolean only with a new marker, linked terminal summary, and scored continuation", () => {
    const sdkResponse: SessionSummarizeResponses[200] = true
    const old = { info: { id: "old-marker", sessionID: "s1", time: { created: 1_800_000_000_000 } }, parts: [{ type: "compaction", auto: false }] }
    const marker = { info: { id: "marker-2", sessionID: "s1", time: { created: 1_800_000_000_100 } }, parts: [{ type: "compaction", auto: false }] }
    const summary = { info: { id: "summary-2", sessionID: "s1", role: "assistant", parentID: "marker-2", summary: true, time: { completed: 1_800_000_000_200 } }, parts: [] }
    const continuation = { status: "completed", userMessageID: "followup-user", assistantID: "followup-assistant", scorePassed: true }
    const input = { requestId: "request-2", requestedAt: "2027-01-15T08:00:00.050Z", rootSessionId: "s1", response: sdkResponse,
      beforeMessages: [old], afterMessages: [old, marker, summary], continuation, continuationMessages: followupHistory() }
    const receipt = compactionReceipt(input)
    expect(receipt).toMatchObject({ qualified: true, summaryExposureQualified: true, continuation: { completionLinked: true, linked: true }, requestAcceptance: "accepted", marker: { outcome: "new_and_persisted", creationTime: "created_after_request" },
      summary: { id: "summary-2", parentID: "marker-2", outcome: "terminal_linked" } })
    expect(compactionIsQualified(receipt)).toBe(true)
    expect(compactionIsQualified({ qualified: true, marker: { outcome: "new_and_persisted" } })).toBe(true)
    expect(compactionIsQualified({ qualified: false, marker: { outcome: "new_and_persisted" } })).toBe(false)
    expect(compactionReceipt({ ...input, continuationMessages: [] }).qualified).toBe(false)
    expect(compactionReceipt({ ...input, continuationMessages: followupHistory("foreign") }).qualified).toBe(false)
    expect(compactionReceipt({ ...input, continuationMessages: followupHistory("s1", "followup-user", "followup-assistant", "wrong") }).qualified).toBe(false)
    expect(compactionReceipt({ ...input, afterMessages: [marker, { ...summary, info: { ...summary.info, id: undefined } }] }).qualified).toBe(false)
    expect(compactionReceipt({ ...input, afterMessages: [marker, summary, { ...marker, info: { ...marker.info, id: "other-manual-marker" } }] }))
      .toMatchObject({ qualified: false, marker: { outcome: "ambiguous" } })
  })

  test("rejects old markers, errored or unlinked summaries, rejected acceptance, and unscored continuation", () => {
    const oldMarker = { info: { id: "old-marker", sessionID: "s1", time: { created: 1_800_000_000_000 } }, parts: [{ type: "compaction", auto: false }] }
    const newMarker = { info: { id: "new-marker", sessionID: "s1", time: { created: 1_800_000_000_100 } }, parts: [{ type: "compaction", auto: false }] }
    const base = { requestId: "request", requestedAt: "2027-01-15T08:00:00.050Z", rootSessionId: "s1", response: true, beforeMessages: [oldMarker],
      continuation: { status: "completed", userMessageID: "u", assistantID: "a", scorePassed: true },
      continuationMessages: followupHistory("s1", "u", "a") }
    const oldOnly = compactionReceipt({ ...base, afterMessages: [oldMarker] })
    expect(oldOnly).toMatchObject({ qualified: false, summaryExposureQualified: false, marker: { outcome: "missing_or_historical_only" } })
    const errored = { info: { id: "summary-error", sessionID: "s1", role: "assistant", parentID: "new-marker", summary: true, error: { name: "SyntheticError" }, time: { completed: 1_800_000_000_200 } }, parts: [] }
    expect(compactionReceipt({ ...base, afterMessages: [oldMarker, newMarker, errored] })).toMatchObject({ qualified: false, summaryExposureQualified: false, summary: { outcome: "missing_errored_or_unlinked" } })
    const unlinked = { ...errored, info: { ...errored.info, id: "summary-unlinked", parentID: "other-marker", error: undefined } }
    expect(compactionReceipt({ ...base, afterMessages: [oldMarker, newMarker, unlinked] })).toMatchObject({ qualified: false, summaryExposureQualified: false, summary: { outcome: "missing_errored_or_unlinked" } })
    const linked = { ...unlinked, info: { ...unlinked.info, parentID: "new-marker" } }
    const predatingMarker = { info: { id: "predating-marker", sessionID: "s1", time: { created: 1_800_000_000_000 } }, parts: [{ type: "compaction", auto: false }] }
    const predatingSummary = { ...linked, info: { ...linked.info, parentID: "predating-marker" } }
    expect(compactionReceipt({ ...base, afterMessages: [oldMarker, predatingMarker, predatingSummary] })).toMatchObject({ qualified: false,
      marker: { id: "predating-marker", outcome: "predates_request", creationTime: "predates_request" } })
    expect(compactionReceipt({ ...base, response: false, afterMessages: [oldMarker, newMarker, linked] })).toMatchObject({ qualified: false, requestAcceptance: "rejected" })
    expect(compactionReceipt({ ...base, continuation: { ...base.continuation, scorePassed: false }, afterMessages: [oldMarker, newMarker, linked] })).toMatchObject({ qualified: false })
  })

  test("completed summaries remain exposure after failed, missing, or wrong continuations", () => {
    const at = 1_800_000_000_000
    const marker = { info: { id: "marker", sessionID: "s1", time: { created: at + 100 } }, parts: [{ type: "compaction", auto: false }] }
    const summary = { info: { id: "summary", sessionID: "s1", role: "assistant", summary: true, parentID: "marker", time: { completed: at + 200 } }, parts: [] }
    const input = { requestId: "request", requestedAt: new Date(at).toISOString(), rootSessionId: "s1", response: true,
      beforeMessages: [], afterMessages: [marker, summary] }
    const completed = { status: "completed", userMessageID: "followup-user", assistantID: "followup-assistant", scorePassed: true }
    const failedHistory = followupHistory().map(message => message.info.role === "assistant"
      ? { ...message, info: { ...message.info, error: { name: "SyntheticError" } } } : message)
    const variants = [
      { continuation: { ...completed, status: "failed" }, continuationMessages: failedHistory, completionLinked: false },
      { continuation: { status: "not_completed" }, continuationMessages: [], completionLinked: false },
      { continuation: { ...completed, scorePassed: false }, continuationMessages: followupHistory(), completionLinked: true },
      { continuation: completed, continuationMessages: [], completionLinked: false },
    ]
    for (const { completionLinked, ...continuation } of variants) {
      const receipt = compactionReceipt({ ...input, ...continuation })
      expect(receipt).toMatchObject({ summaryExposureQualified: true, qualified: false,
        continuation: { completionLinked, linked: false } })
      expect(compactionSummaryExposureIsQualified(receipt)).toBe(true)
      expect(compactionIsQualified(receipt)).toBe(false)
    }
    // An acknowledgement cannot erase independently observed summary completion.
    for (const response of [false, undefined]) {
      const receipt = compactionReceipt({ ...input, response, continuation: completed, continuationMessages: followupHistory() })
      expect(compactionSummaryExposureIsQualified(receipt)).toBe(true)
      expect(compactionIsQualified(receipt)).toBe(false)
    }
    for (const afterMessages of [[], [marker], [marker, { ...summary, info: { ...summary.info, sessionID: "other" } }],
      [marker, summary, { ...marker, info: { ...marker.info, id: "ambiguous" } }]]) {
      expect(compactionSummaryExposureIsQualified(compactionReceipt({ ...input, afterMessages,
        continuation: completed, continuationMessages: followupHistory() }))).toBe(false)
    }
    // Historical control receipts are not silently relabeled as the new measurement.
    expect(compactionIsQualified({ qualified: true })).toBe(true)
    expect(compactionSummaryExposureIsQualified({ qualified: true })).toBe(false)
    expect(compactionSummaryExposureIsQualified({ summaryExposureQualified: "true" })).toBe(false)
    expect(compactionSummaryExposureIsQualified(undefined)).toBe(false)
  })

  test("final census waits within its grace and retains missing or in-flight usage as unknown", async () => {
    let time = 0, n = 0
    const receipt = await finalCensus({ graceMs: 20, pollMs: 5, now: () => time, pause: async ms => { time += ms }, census: async () => {
      n++
      const delayed = n < 4
      return { metrics: { assistantTurns: { total: 1 }, usage: { turns: { complete: delayed ? 0 : 1, partial: 0, unknown: delayed ? 1 : 0 }, components: { input: { reportedTurns: delayed ? 0 : 1 } } } }, activeSessions: n < 3 ? 1 : 0, pendingWork: false, quiescent: n >= 3 }
    } })
    expect(receipt).toMatchObject({ outcome: "quiescent", rounds: 5, stableQuiescentRounds: 2, usage: { completeTurns: 1, unknownTurns: 0 }, activeSessions: 0, inFlightRequests: null })
    const unresolved = await finalCensus({ graceMs: 0, now: () => 0, census: async () => ({ metrics: {}, activeSessions: null, pendingWork: null, quiescent: false }) })
    const noCensus = await finalCensus({ graceMs: 0, now: () => 0, census: async () => { throw Error("synthetic") } })
    expect(unresolved).toMatchObject({ outcome: "grace_expired", activeSessions: null, inFlightRequests: null, quiescent: false })
    expect(noCensus).toMatchObject({ outcome: "census_error", assistantTurns: null, usage: { completeTurns: null, unknownTurns: null, reportedComponents: null } })
  })

  test("census needs two consecutive stable quiet samples with known absence of pending work", async () => {
    const quiet = { metrics: { assistantTurns: { total: 1 } }, activeSessions: 0, pendingWork: false, quiescent: true }
    const once = await finalCensus({ graceMs: 0, now: () => 0, census: async () => quiet })
    expect(once).toMatchObject({ outcome: "grace_expired", stableQuiescentRounds: 1, quiescent: false })
    let time = 0, calls = 0
    const interrupted = await finalCensus({ graceMs: 10, pollMs: 5, now: () => time, pause: async ms => { time += ms }, census: async () => {
      if (++calls === 2) throw Error("synthetic poll failure")
      return quiet
    } })
    expect(interrupted).toMatchObject({ outcome: "grace_expired", rounds: 3, stableQuiescentRounds: 1, quiescent: false })
    time = 0
    const unknown = await finalCensus({ graceMs: 10, pollMs: 5, now: () => time, pause: async ms => { time += ms },
      census: async () => ({ ...quiet, pendingWork: null }) })
    expect(unknown).toMatchObject({ outcome: "grace_expired", stableQuiescentRounds: 0, quiescent: false })
  })

  test("artifact outcome is independent from workflow and operational eligibility", () => {
    const result = eligibility({ artifactPassed: true, workflowComplete: true, sourceIntegrity: true, configIntegrity: true,
      cleanup: true, censusQuiescent: true, isolationQualified: false })
    expect(result).toMatchObject({ artifactOutcome: "passed", workflowEligible: true, operationalEligible: false, comparisonEligible: false,
      reasons: ["service_isolation_unqualified"] })
  })
})

import { expect, test } from "bun:test"
import { createLongSessionCases, type LongPhase } from "../scripts/build-benchmark-long-fixtures.ts"
import { runLongSession, reconcileLongSummary, type LongSessionDriver, type LongSessionEvidence } from "../scripts/build-benchmark-long-session.ts"
import { measureRetentionBoundaries } from "../scripts/build-benchmark-retention-boundaries.ts"
import { sha256Json } from "../src/persistence.ts"

async function exercise(options: { fail?: LongPhase; wrong?: LongPhase; summaryAckLost?: boolean; noSummary?: boolean; nativeDuringTransition?: boolean; native?: boolean; handoff?: boolean; changedTruth?: boolean } = {}) {
  const c = createLongSessionCases().find(c => c.cell.compact && c.cell.handoff === (options.handoff ?? true))!
  let evidence!: LongSessionEvidence, session = "controller-a", phase: LongPhase = "q0", summary: ReturnType<LongSessionDriver["summary"]> = null
  const calls: string[] = [], freezes: LongSessionEvidence[] = [], native: string[] = []
  const driver: LongSessionDriver = {
    sessionId: () => session, sequence: () => 0, censusComplete: () => true, auditComplete: () => true,
    nativeMarkers: () => native, persist(value) { evidence = value; freezes.push(value) },
    async send(p) { phase = p; calls.push(p); if (p === options.fail) throw Error("provider unavailable")
      if (p === "qc" && options.native) native.push("native-during-followup") },
    async grade(p) { const expectedDigest = sha256Json(options.changedTruth && p === "qc" ? "new-truth" : "truth")
      const passed = p !== options.wrong
      return { passed, evidenceDigest: sha256Json({ p, passed }), checks: [{ id: "fact", category: "source", expectedDigest,
        observedDigest: passed ? expectedDigest : sha256Json("wrong"), passed, exposed: true, known: true }] } },
    async reassign() { calls.push("handoff"); session = "controller-b"; return { source: "controller-a", recipient: session } },
    async restart() { calls.push("restart"); return { sameSession: session } },
    async compact() { calls.push("compact"); expect(evidence.retention.boundaries.at(-1)?.summarySucceeded).toBe(false)
      if(options.nativeDuringTransition)native.push("native-during-intervention")
      summary = options.noSummary ? null : { id: "actual-summary", completedAt: Date.now(), digest: sha256Json("summary") }
      if (options.summaryAckLost) throw Error("ack lost") },
    summary: () => summary,
  }
  await runLongSession(c, "task", driver).catch(() => {})
  const report = measureRetentionBoundaries(evidence.retention)
  expect(report.status).not.toBe("invalid_input")
  return { evidence, calls, freezes, report: report as any }
}

test("separates handoff, compaction, and restart; freezes obligations before transition and grades each continuation", async () => {
  const { evidence, calls, report } = await exercise()
  expect(calls).toEqual(["q0", "handoff", "qh", "compact", "qc", "restart", "qr"])
  expect(evidence.complete).toBe(true); expect(evidence.passed).toBe(true)
  expect(report.issues).toEqual([])
  for (const b of report.boundaries) expect(b.behavioralRegression.counts.retained).toBe(1)
  expect(evidence.retention.boundaries[0]!.lineage?.recipientSessionId).toBe("controller-b")
  expect(evidence.retention.boundaries.every(b => b.before.complete === false)).toBe(true)
})

test("a pre-correct obligation can regress despite a completed summary and final restart recovery", async () => {
  const { evidence, report } = await exercise({ wrong: "qc" })
  expect(evidence.complete).toBe(true); expect(evidence.passed).toBe(false)
  expect(report.boundaries[1].behavioralRegression.counts.regressions).toBe(1)
  expect(report.boundaries[2].behavioralRegression.counts.preIncorrect).toBe(1)
})

test("failed continuation remains unknown after exposed summary, with no restart to mask the failure", async () => {
  const { evidence, report, calls } = await exercise({ fail: "qc" })
  expect(evidence.complete).toBe(false); expect(calls).not.toContain("restart")
  expect(report.boundaries[1].behavioralRegression.counts.unknownFollowup).toBe(1)
  expect(report.boundaries[1].behavioralRegression.missingness.upperBound).toBe(1)
})

test("lost summary ACK preserves independently witnessed summary exposure", async () => {
  const { evidence, report } = await exercise({ summaryAckLost: true })
  expect(evidence.retention.boundaries[1]!.summarySucceeded).toBe(true)
  expect(report.boundaries[1].behavioralRegression.exposure.status).toBe("observed")
  expect(report.boundaries[1].behavioralRegression.counts.unknownFollowup).toBe(1)
})

test("intervening native compaction and changed truth cannot manufacture a measured regression", async () => {
  for (const options of [{ native: true, wrong: "qc" as const }, { nativeDuringTransition: true, wrong: "qc" as const }, { changedTruth: true, wrong: "qc" as const }]) {
    const { report } = await exercise(options)
    expect(report.boundaries[1].behavioralRegression.counts.regressions).toBe(0)
    expect(report.boundaries[1].behavioralRegression.counts.unknownFollowup).toBe(1)
  }
})

test("late request-linked summary reconciliation adds exposure without inventing continuation", async () => {
  const { evidence } = await exercise({ noSummary: true })
  const b = evidence.retention.boundaries[1]!
  expect(b.summarySucceeded).toBe(false)
  expect(reconcileLongSummary(evidence, { requestId: "wrong-request", sessionId: b.sessionId, id: "late", completedAt: Date.now(), observedAt: Date.now(), digest: sha256Json("late") })).toBe(false)
  expect(reconcileLongSummary(evidence, { requestId: b.requestId, sessionId: b.sessionId, id: "late", completedAt: Date.now(), observedAt: Date.now(), digest: sha256Json("late") })).toBe(true)
  const report = measureRetentionBoundaries(evidence.retention) as any
  expect(report.issues).toEqual([])
  expect(report.boundaries[1].behavioralRegression.counts.unknownFollowup).toBe(1)
  expect(evidence.passed).toBe(false)
})

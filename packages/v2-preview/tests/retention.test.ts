import { describe, expect, test } from "bun:test"
import { caseId, evidenceRef, generateFabEvidence } from "../benchmark/case.ts"
import { candidates, defectFloor, matchingCorrections, refutationId, verifiedCorrection } from "../benchmark/handoff-case.ts"
import { scoreRetention, type RetentionInput } from "../benchmark/retention.ts"
import type { WorkbenchReceipt, WorkbenchSnapshot } from "../benchmark/workbench.ts"

const evidence = generateFabEvidence()
const size = candidates.find(n => evidence.inspection.slice(0, n).filter(row => row.defect).length >= defectFloor)!
const cohort = evidence.inspection.slice(0, size)
const auditRef = evidenceRef("clock-audit")
const correction = verifiedCorrection(JSON.stringify({ auditRef, auditRows: evidence["clock-audit"] }))!
const initial = {
  cohortSize: size, defects: cohort.filter(row => row.defect).length, inspectionRef: evidenceRef("inspection"),
  verifiedClockCorrections: null, auditRef: null, nextAction: "attribute-as-recorded", prerequisite: "independent-clock-audit",
}
const corrected = {
  ...initial, verifiedClockCorrections: matchingCorrections(cohort, evidence["clock-audit"]),
  auditRef, nextAction: "replay-clock-join", prerequisite: "verified-clock-audit",
}
const inspectionReceipts = candidates.filter(n => n <= size).map((rows, i): WorkbenchReceipt => ({
  scope: "root", outcome: "admitted", queryId: "inspection-" + i, evidenceRefs: [initial.inspectionRef],
  pages: [{ source: "inspection", offset: 0, rows, totalRows: evidence.inspection.length }],
}))
const auditReceipt: WorkbenchReceipt = {
  scope: "checker", outcome: "admitted", queryId: "audit", evidenceRefs: [auditRef],
  pages: [{ source: "clock-audit", offset: 0, rows: evidence["clock-audit"].length, totalRows: evidence["clock-audit"].length }],
}
function snapshot(receipts: WorkbenchReceipt[]): WorkbenchSnapshot {
  return { caseId: caseId("positive"), maxAcceptedQueries: 16, calls: receipts.length,
    acceptedQueries: receipts.filter(row => row.outcome === "admitted").length,
    deniedQueries: receipts.filter(row => row.outcome === "denied").length, receipts }
}
function fixture(): RetentionInput {
  const afterInitial = snapshot(inspectionReceipts)
  const afterCorrection = snapshot([...inspectionReceipts, auditReceipt])
  return {
    variant: "active", initial: JSON.stringify(initial), corrected: JSON.stringify(corrected),
    final: JSON.stringify(corrected), correction, compactionObserved: true,
    authority: { initial: true, corrected: true, final: true },
    snapshots: { afterInitial, afterCorrection, beforeContinue: afterCorrection, afterContinue: afterCorrection },
  }
}
function obligation(boundary: ReturnType<typeof scoreRetention>["continuation"], field: string) {
  return boundary.obligations.find(row => row.field === field)
}

describe("handoff obligation retention", () => {
  test("separates superseded recommendations and newly introduced audit facts from retained fields", () => {
    const score = scoreRetention(fixture())
    expect(score.correction).toMatchObject({ observed: true, eligible: 3, retained: 3, lostWrong: 0, lossBounds: [0, 0] })
    expect(score.correction.obligations.find(row => row.field === "nextAction")).toMatchObject({
      eligibility: "invalidated", invalidatedBy: "correction", current: "supported_correct", outcome: null,
    })
    expect(score.correction.obligations.find(row => row.field === "auditRef")).toMatchObject({
      previous: "inapplicable", current: "supported_correct", eligibility: "baseline_ineligible",
    })
    expect(score.continuation).toMatchObject({ baseline: "corrected", eligible: 7, retained: 7, lostWrong: 0 })
  })

  test("counts explicit wrong values separately from missing fields and missing turns", () => {
    const run = fixture()
    const partial = scoreRetention({ ...run, final: JSON.stringify({ cohortSize: initial.cohortSize, auditRef: null }) })
    expect(partial.continuation).toMatchObject({
      eligible: 7, assessed: 2, retained: 1, lostWrong: 1, unavailable: 5, lossBounds: [1 / 7, 6 / 7],
    })
    expect(obligation(partial.continuation, "auditRef")?.outcome).toBe("lost_wrong")
    expect(obligation(partial.continuation, "inspectionRef")?.outcome).toBe("unavailable")
    for (const final of [null, "No JSON answer."]) {
      const missing = scoreRetention({ ...run, final }).continuation
      expect(missing).toMatchObject({ eligible: 7, assessed: 0, lostWrong: 0, unavailable: 7, lossBounds: [0, 1] })
    }
  })

  test("a later correct value cannot turn a wrong or unsupported pre-boundary answer into retention", () => {
    const run = fixture()
    run.initial = JSON.stringify({ ...initial, defects: 99 })
    run.corrected = JSON.stringify({ ...corrected, inspectionRef: "made-up-citation" })
    const score = scoreRetention(run)
    expect(score.correction.obligations.find(row => row.field === "defects")).toMatchObject({
      previous: "wrong", current: "supported_correct", eligibility: "baseline_ineligible", outcome: null,
    })
    expect(obligation(score.continuation, "inspectionRef")).toMatchObject({
      previous: "wrong", current: "supported_correct", eligibility: "baseline_ineligible", outcome: null,
    })
    run.snapshots.afterInitial = snapshot([])
    expect(scoreRetention(run).correction.obligations.find(row => row.field === "cohortSize")).toMatchObject({
      previous: "correct_unsupported", eligibility: "baseline_ineligible",
    })
  })

  test("does not fall back to an older answer after a delivered correction with a missing response", () => {
    const run = fixture()
    expect(scoreRetention({ ...run, corrected: null }).continuation).toMatchObject({
      observed: true, baseline: "corrected", eligible: 0, lossBounds: null,
    })
    expect(scoreRetention({ ...run, compactionObserved: false }).continuation).toMatchObject({
      observed: false, eligible: 0, lossBounds: null,
    })
    expect(scoreRetention({ ...run, correction: "unverified correction", corrected: null }).correction.observed).toBe(false)
  })

  test("uses the answer adjacent to a later compaction without moving the correction boundary", () => {
    const run = fixture()
    run.preCompaction = {
      answer: JSON.stringify({ ...corrected, cohortSize: 99 }), snapshot: run.snapshots.beforeContinue!, authority: true,
    }
    const score = scoreRetention(run)
    expect(score.correction).toMatchObject({ eligible: 3, retained: 3 })
    expect(score.continuation).toMatchObject({ baseline: "preCompaction", eligible: 6, retained: 6 })
    expect(obligation(score.continuation, "cohortSize")?.outcome).toBeNull()

    run.correction = null
    run.corrected = null
    run.initial = JSON.stringify({ ...initial, cohortSize: 0 })
    run.preCompaction = { ...run.preCompaction, answer: JSON.stringify(initial), authority: null }
    run.final = JSON.stringify(initial)
    const withoutCorrection = scoreRetention(run)
    expect(withoutCorrection.correction.observed).toBe(false)
    expect(withoutCorrection.continuation).toMatchObject({
      baseline: "preCompaction", eligible: 3, retained: 3, revocationObserved: false,
    })
    expect(obligation(withoutCorrection.continuation, "nextAction")?.previous).toBe("inapplicable")
  })

  test("revocation requires observed present-to-absent authority and makes abstention a new obligation", () => {
    const run = fixture()
    run.variant = "revoked"
    run.authority!.final = false
    run.final = JSON.stringify({ ...corrected, nextAction: null, prerequisite: "current-approved-procedure" })
    const { continuation } = scoreRetention(run)
    expect(continuation).toMatchObject({ revocationObserved: true, eligible: 5, retained: 5, lostWrong: 0 })
    expect(obligation(continuation, "nextAction")).toMatchObject({
      invalidatedBy: "revoked", current: "supported_correct", outcome: null,
    })
    const stale = scoreRetention({ ...run, final: JSON.stringify(corrected) }).continuation
    expect(obligation(stale, "nextAction")).toMatchObject({ invalidatedBy: "revoked", current: "wrong", outcome: null })
    expect(scoreRetention({ ...run, authority: { corrected: false, final: false } }).continuation.revocationObserved).toBe(false)
    expect(scoreRetention({ ...run, authority: { corrected: true, final: null } }).continuation.revocationObserved).toBe(false)
    expect(scoreRetention({ ...run, authority: { corrected: true, final: true } }).continuation.revocationObserved).toBe(false)
  })

  test("counts workbench admissions and prior cache hits separately and rejects a rewritten receipt prefix", () => {
    const run = fixture()
    const before = run.snapshots.beforeContinue!
    const previous = inspectionReceipts.at(-1)!
    const fresh = { ...previous, queryId: "fresh", pages: [{ ...previous.pages[0]!, rows: 1 }] }
    run.snapshots.afterContinue = snapshot([...before.receipts, { ...previous, outcome: "replay" },
      fresh, { ...fresh, outcome: "replay" }])
    expect(scoreRetention(run).continuation.workbench).toEqual({
      newQueries: 1, priorCacheReads: 1, newQueryCacheReads: 1, denied: 0, maps: 0,
    })
    run.snapshots.afterContinue.receipts[0] = { ...before.receipts[0]!, evidenceRefs: ["wrong"] }
    expect(scoreRetention(run).continuation.workbench).toBeNull()
  })

  test("binds a freely paraphrased refutation to its settled manifest and separates exposure from scoring", () => {
    const run = fixture()
    const digest = "a".repeat(64)
    const work = { work_key: "work-1", manifest_digest: digest, status: "result_recorded" }
    const statement = "The completed calibration artifact exists in the record."
    const claim = { id: refutationId, manifest_digest: digest, statement }
    const hypothesis = { ...claim, status: "refuted", evidence_refs: [digest] }
    const record = { id: "refute", input: { action: "set_next_measurement", refutation: claim },
      value: { ok: true, work, decision: { hypotheses: [hypothesis] } } }
    const reuse = { id: "reuse", input: { action: "reconcile" }, value: { ok: true,
      preQuery: { reuse: { ...work, kind: "settled_manifest" } } } }
    const brief = { settled_manifest_digest: digest, refuted_hypothesis: { id: refutationId, manifest_digest: digest } }
    run.tools = {
      initial: [{ id: "dispatch", input: { action: "dispatch" }, value: { ok: true, work } }, reuse],
      corrected: [record],
      final: [{ ...reuse, id: "denied", value: { ...reuse.value, ok: false } },
        { ...reuse, id: "wrong", value: { ok: true,
          preQuery: { reuse: { ...work, kind: "settled_manifest", manifest_digest: "b".repeat(64) } } } }],
    }
    run.durableBrief = { before: brief, after: brief }
    run.refutationReview = { receiptId: "refute", verdict: "grounded" }
    const score = scoreRetention({ ...run, final: null, exposure: { summary: true, factualRefutation: true } })
    expect(score.initialManifestReferenceReads).toBe(1)
    expect(score.continuation.manifestReferenceReads).toBe(0)
    expect(score.continuation.retained).toBe(0)
    expect(score.durableRefutation).toMatchObject({
      recorded: true, before: true, after: true, eligible: true, outcome: "retained", semanticVerdict: "grounded",
    })
    expect(score.exposure).toMatchObject({ summary: true, factualRefutation: true })
    expect(scoreRetention({ ...run, durableBrief: { before: brief } }).durableRefutation.outcome).toBe("unavailable")
    expect(scoreRetention({ ...run, durableBrief: { before: brief, after: null } }).durableRefutation.outcome).toBe("lost")
    const wrongReceipt = { ...record, value: { ...record.value, decision: { hypotheses: [{ ...hypothesis, evidence_refs: [] }] } } }
    expect(scoreRetention({ ...run, tools: { ...run.tools, corrected: [wrongReceipt] } }).durableRefutation.recorded).toBe(false)
    expect(scoreRetention({ ...run, tools: { ...run.tools, corrected: [] }, writesBeforeCompaction: [record] })
      .durableRefutation.outcome).toBe("retained")
    expect(scoreRetention({ ...run, writesBeforeCompaction: [] }).durableRefutation.eligible).toBe(false)

    run.factory = {
      evidence: {
        ledger: { acceptedComputations: 2, acceptedWorkUnits: 2, jobs: 2, lostAcknowledgements: 0, sourceChanges: 0 },
        sources: [], unavailableChecks: [],
        jobs: [["original", digest], ["fresh", "b".repeat(64)]].map(([id, resultDigest]) => ({
          job: { jobId: id!, resultDigest: resultDigest!, sourceId: "inspection", sourceRevision: "fixture-r1",
            rowCount: 1, workUnits: 1, status: "complete", acceptedAt: 0 },
          idempotencyKey: id!, scope: { filter: {}, select: null }, lostAcknowledgement: false,
          recoveredByLookup: false, statusChecked: false, lookedUp: false, rowsRead: 1, currentRowsRead: 1,
        })),
      },
      afterInitial: [{ name: "submit", submission: "original", job: "original", response: "sent" }],
      afterCorrection: null, beforeContinue: null, afterContinue: null,
    }
    run.factory.beforeContinue = run.factory.afterInitial
    run.factory.afterContinue = [...run.factory.afterInitial!,
      { name: "validate", job: "original", response: "sent" },
      { name: "read", job: "original", response: "rejected" },
      { name: "read", job: "original", response: "sent" },
      { name: "submit", submission: "original", job: "original", response: "sent" },
      { name: "submit", submission: "fresh", job: "fresh", response: "sent" },
      { name: "read", job: "fresh", response: "sent" },
    ]
    expect(scoreRetention(run).continuation.factory).toEqual({
      submitCalls: 2, newComputations: 1, successfulResultPageReads: 2, settledManifestPageReads: 1,
    })
  })
})

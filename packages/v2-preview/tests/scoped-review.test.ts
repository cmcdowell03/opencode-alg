import { expect, test } from "bun:test"
import type { EvidenceFinding, EvidenceReadView, SourceReceipt } from "../src/evidence-reads.ts"
import { selectReviewQuestion } from "../src/scoped-review.ts"

const cite = (reference: string): SourceReceipt => ({
  id: "a".repeat(64), reference, tool: "source_read", path: "gauge.json",
  sha256: "b".repeat(64), receipt: "r", messageId: "m", callId: "c",
})
const finding: EvidenceFinding = {
  id: "range", interpretation: "The gauge rose during warmup", attribution: "model", scope: "station",
  status: "supported", support: [cite("gauge.json#warm")], counterevidence: [],
}
const view = (findings: EvidenceFinding[]): EvidenceReadView => ({ revision: 1, findings, question: null, sources: [] })

test("ordinary review focuses on uncertainty and carries the recorded falsifier and references", () => {
  const state = view([finding, { ...finding, id: "drift", status: "unresolved",
    falsifier: "A stable independent gauge would rule out a process excursion.", missingEvidence: "calibration log" }])
  expect(selectReviewQuestion(state)).toMatchObject({
    findingId: "drift", mode: "ordinary", support: ["gauge.json#warm"], counterevidence: [],
    wouldChangeConclusion: state.findings[1]!.falsifier, missingEvidence: "calibration log",
  })
  expect(selectReviewQuestion(view([finding]))).toBeNull()
})

test("counterevidence and a closure request trigger a challenge tied to one finding", () => {
  const findingWithConflict: EvidenceFinding = { ...finding, id: "conflict", status: "contested",
    counterevidence: [cite("gauge.json#stable")] }
  const state = view([finding, findingWithConflict])
  expect(selectReviewQuestion(state)).toMatchObject({ findingId: "conflict", mode: "adversarial",
    counterevidence: ["gauge.json#stable"] })
  expect(selectReviewQuestion(view([finding]), true)?.mode).toBe("adversarial")
  state.question = { findingId: finding.id, text: "Does the repeat reading show the same interval?" }
  expect(selectReviewQuestion(state)).toMatchObject({ findingId: "range", mode: "ordinary", question: state.question.text })
  expect(selectReviewQuestion(view([]), true)).toBeNull()
})

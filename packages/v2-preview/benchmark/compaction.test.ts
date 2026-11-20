import { expect, test } from "bun:test"
import { assessCompaction, summaryHash, type CompactionWitness, type RequestObservation } from "./compaction.ts"

const oldSummary = "## Objective\nPreserve the previous result."
function request(id: number, fields: Partial<RequestObservation> = {}): RequestObservation {
  return { id, kind: "ordinary", role: "root", phase: null, startedAtMs: 10, finishedAtMs: 30,
    stale: false, oldSummary: false, correction: false, skill: false, tools: [], status: 200, ...fields }
}
function witness(): CompactionWitness {
  return {
    before: ["msg_prior"],
    summary: request(1, { kind: "summary", stale: true, finishedAtMs: 90, summaryResponseSha256: summaryHash(oldSummary) }),
    whileHeld: request(2, { startedAtMs: 20, finishedAtMs: 40 }),
    concurrentAnswerId: "msg_unblocked", concurrentAnswerAtMs: 45,
    correctedAtMs: 75,
    applied: { id: "msg_auto", time: { created: 100 }, type: "compaction", reason: "auto", status: "completed", summary: oldSummary },
    appliedAtMs: 120,
    next: request(3, { startedAtMs: 105, finishedAtMs: 115, oldSummary: true, correction: true }),
    answerId: "msg_revised",
  }
}

test("qualifies only a correlated background summary, durable correction, and subsequent answer", () => {
  expect(assessCompaction(witness()).status).toBe("OBSERVED")
})

test("a concurrent checker by itself does not distinguish foreground work", () => {
  const input = witness()
  input.whileHeld = request(2, { role: "checker", startedAtMs: 20, finishedAtMs: 40 })
  expect(assessCompaction(input).checks.rootProgressWhileSummaryInFlight).toBe(false)
  expect(assessCompaction(input).status).toBe("NOT_OBSERVED")
})

test("a manual or different summary cannot establish automatic application", () => {
  const input = witness()
  input.applied = { ...input.applied!, reason: "manual" }
  expect(assessCompaction(input).checks.newAutomaticCompactionApplied).toBe(false)
  input.applied = { ...input.applied, reason: "auto", summary: "Different summary." }
  expect(assessCompaction(input).status).toBe("NOT_OBSERVED")
})

test("a late correction or missing actual root answer leaves the overlap unobserved", () => {
  const input = witness()
  expect(assessCompaction({ ...input, correctedAtMs: 95 }).status).toBe("NOT_OBSERVED")
  expect(assessCompaction({ ...input, answerId: undefined }).status).toBe("NOT_OBSERVED")
  expect(assessCompaction({ ...input, next: { ...input.next!, oldSummary: false } }).status).toBe("NOT_OBSERVED")
});

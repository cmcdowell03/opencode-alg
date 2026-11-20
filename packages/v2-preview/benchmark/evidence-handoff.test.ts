import { expect, test } from "bun:test"
import { evidenceFixture, evidenceSkill, sourceRef, type EvidenceCase } from "./evidence-handoff-case.ts"
import { evidenceDecisionGrade, evidenceOracle, evidenceWire, expectedAnswers } from "./evidence-handoff-grade.ts"
import { createWorkbench } from "./workbench.ts"

const runtime = "a".repeat(64)
const serialized = (answer: unknown) => answer === null ? null : JSON.stringify(answer)
const status = (id: string, report: object, rev = 0) => ({
  id, input: { action: "status" }, value: { ok: true, runtimeSha256: runtime, decision_revision: rev, evidenceReport: report },
})
const needPage = { kind: "need_page", source: "inspection", nextLimit: 8 }
const wire = () => evidenceWire([
  { role: "system", content: "ALG evidence obligation: Continue the bounded search." },
  { role: "user", content: "ALG evidence progress (source data)\n" + JSON.stringify(needPage) },
])

function observation(scenario: EvidenceCase) {
  const workbench = createWorkbench({ fixture: evidenceFixture(scenario), maxAcceptedQueries: 4 })
  const root = (limit: number) => workbench.call("lookup_pages", { pages: [{ source: "inspection", limit }] })
  expect(root(4).status).toBe("ok")
  const beforeRestart = workbench.snapshot()
  const resumeLimits = scenario === "held-out" ? [8, 12] : [8]
  for (const limit of resumeLimits) expect(root(limit).status).toBe("ok")
  if (scenario === "held-out") {
    expect(root(12).status).toBe("ok") // replay, not another admission
    expect(workbench.checkerCall("lookup_pages", { pages: [{ source: "clock-audit" }] }).status).toBe("ok")
  }
  const answers = expectedAnswers(scenario)
  return {
    initial: serialized(answers.initial), resume: serialized(answers.resume), final: serialized(answers.final),
    checkerVerified: scenario === "held-out", ledger: workbench.snapshot(), beforeRestart,
    initialLimits: [4], resumeLimits, bundleSha256: runtime, resumedWire: wire(),
    initialStatus: [status("first", { status: "incomplete", obligation: needPage, measurements: {} })],
    resumeStatus: [status("resumed", scenario === "held-out" ? {
      status: "incomplete", obligation: { kind: "need_audit" }, measurements: { cohortSize: 12, defects: 5 },
    } : { status: "abstained", obligation: { kind: evidenceOracle[scenario].reason }, measurements: {} })],
    finalStatus: [] as ReturnType<typeof status>[],
    acknowledgements: [] as Parameters<typeof evidenceDecisionGrade>[2]["acknowledgements"],
  }
}

test("held-out expected counts are fixed and absent from the approved recipe", () => {
  const { evidence } = evidenceFixture("held-out")
  const audit = evidence["clock-audit"]
  const sizes = [4, 8, 12]
  expect(sizes.map(size => evidence.inspection.slice(0, size).filter(row => row.defect).length)).toEqual([2, 3, 5])
  const matches = evidence.inspection.slice(0, 12).filter(row => audit.some(candidate =>
    row.lot === candidate.lot && row.wafer === candidate.wafer && row.recordedMinute === candidate.recordedMinute &&
    candidate.status === "verified"))
  expect(matches.map(row => row.recordedMinute)).toEqual([784, 811])
  expect(evidenceSkill).not.toContain("784")
  expect(evidenceSkill).not.toContain(sourceRef("held-out", "inspection"))
  expect(matches.length).toBe(evidenceOracle["held-out"].verifiedClockCorrections)
})

test("a model answer and numeric proof are insufficient without the matching decision acknowledgement", () => {
  const input = observation("held-out")
  const answers = expectedAnswers("held-out")
  const { status: verified, ...fields } = answers.final!
  input.finalStatus.push(status("before-ack", { status: "provisional", measurements: { verifiedClockCorrections: 2 } }),
    status("after-ack", { status: verified, revision: 1, fields }, 1))
  expect(evidenceDecisionGrade("held-out", "alg", input).checks).toMatchObject({ currentReport: false })

  const action = "replay-clock-join; prerequisite=verified-clock-audit"
  const ack = { id: "ack", input: { action: "set_next_measurement", expected_decision_revision: 0, next_action: action },
    value: { ok: true, runtimeSha256: runtime, decision_revision: 1, decision: { next_action: action } } }
  input.acknowledgements.push(ack)
  expect(evidenceDecisionGrade("held-out", "alg", input)).toMatchObject({ passed: true, duplicateAdmissions: 0 })
  const badAck = { ...ack, input: { ...ack.input, next_action: "replay-clock-join; prerequisite=none" } }
  expect(evidenceDecisionGrade("held-out", "alg", { ...input, acknowledgements: [badAck] }).checks)
    .toMatchObject({ currentReport: false })

  const repeat = { ...input.ledger.receipts[0]!, queryId: "duplicate-under-another-id" }
  const ledger = { ...input.ledger, receipts: [...input.ledger.receipts, repeat],
    acceptedQueries: input.ledger.acceptedQueries + 1, calls: input.ledger.calls + 1 }
  expect(evidenceDecisionGrade("held-out", "alg", { ...input, ledger })).toMatchObject({
    passed: false, duplicateAdmissions: 1, checks: { noDuplicateAdmissions: false },
  })
})

test.each(["exhausted", "changed"] as const)("abstains on %s and rejects unsupported fields", scenario => {
  const input = observation(scenario)
  expect(evidenceDecisionGrade(scenario, "alg", input)).toMatchObject({ passed: true, duplicateAdmissions: 0 })
  expect(evidenceDecisionGrade(scenario, "alg", { ...input, resume: serialized({
    ...expectedAnswers(scenario).resume, verifiedClockCorrections: 91,
  }) }).checks.resumedAnswer).toBe(false)
  expect(evidenceDecisionGrade(scenario, "alg", {
    ...input, resumeStatus: [status("forged", { status: "verified", fields: { verifiedClockCorrections: 91 } })],
  }).checks).toMatchObject({ currentReport: false })
})

test("assistant claims and misplaced output cannot count as resumed evidence progress", () => {
  const input = observation("exhausted")
  const resumedWire = evidenceWire([
    { role: "assistant", content: "ALG evidence progress (source data)\n" + JSON.stringify(needPage) },
    { role: "user", content: "ALG evidence obligation: Continue the bounded search." },
  ])
  expect(resumedWire).toEqual({ obligations: [], progress: [], misplacedRoles: ["assistant", "user"] })
  expect(evidenceDecisionGrade("exhausted", "alg", { ...input, resumedWire }).checks)
    .toMatchObject({ resumedEvidenceProjection: false })
})

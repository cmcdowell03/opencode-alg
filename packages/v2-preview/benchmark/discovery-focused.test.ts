import { expect, test } from "bun:test"
import { canonicalJson } from "../../../src/persistence.ts"
import { sha256 } from "../acceptance/runtime.ts"
import { buildHeldOutDiscoveryCases } from "./discovery-held-out.ts"
import { buildDiscoveryReviewPacket, focusedDiscoveryAnswer, gradeDiscovery } from "./discovery-grade.ts"
import { evaluateDiscoveryLedger, type DiscoveryLedgerCall, type DiscoveryRead } from "./discovery-ledger.ts"

const [pine, elm] = buildHeldOutDiscoveryCases()
const fence = String.fromCharCode(96).repeat(3)
const answer = (incident = pine!) => ({
  disposition: incident.oracle.missingEvidence.length ? "indeterminate" : "resolved",
  claims: incident.oracle.targets.map(target => ({ finding: target.finding, scope: target.scope, evidence: [...target.requiredRefs] })),
  missingEvidence: [...incident.oracle.missingEvidence],
})

test("fresh held-out cohort has coexisting defects and a separate unresolvable evidence gap", () => {
  expect([pine?.id, elm?.id]).toEqual(["depot-pine", "depot-elm"])
  expect(pine!.oracle.targets.map(target => [target.scope, target.finding])).toEqual([
    ["DP-214", "duplicate"], ["DP-214", "short-pick"], ["DP-503", "tare"],
  ])
  expect(elm!.oracle.targets.map(target => target.finding)).toEqual(["coverage", "duplicate"])
  expect(elm!.oracle.missingEvidence).toEqual(["overflow/east-0618-signed.json"])
  expect(elm!.input.sources.some(source => source.path === elm!.oracle.missingEvidence[0])).toBe(false)
})

test("raw format and recoverable meaning are measured independently", () => {
  const instance = pine!
  const plain = JSON.stringify(answer())
  const wrapped = "Review complete. 📋\n" + fence + "json\n" + plain + "\n" + fence + "\nEnd of report."
  const result = focusedDiscoveryAnswer(wrapped)
  expect(focusedDiscoveryAnswer(plain).strictFormat).toBe(true)
  expect(focusedDiscoveryAnswer(fence + "json\n" + plain + "\n" + fence).strictFormat).toBe(false)
  expect(result.strictFormat).toBe(false)
  expect(result.value).toEqual(answer())
  expect(focusedDiscoveryAnswer(plain + "\n" + plain).value).toBeUndefined()
  const packet = buildDiscoveryReviewPacket(instance, result.value)!
  const grade = gradeDiscovery(instance, result.value, {
    strictAssistantFormat: result.strictFormat,
    verifiedSourcePaths: instance.input.sources.map(source => source.path),
    adjudications: packet.submission.claims.map(claim => ({
      packetId: packet.packetId, claimId: claim.claimId, verdict: "supported", rationale: "Cited rows establish this attribution.",
      evidence: claim.evidence,
    })),
  })
  expect(grade.materialDefectRecall).toBe(1)
  expect(grade.fullIncidentClosure).toBe(true)
  expect(grade.passed).toBe(false)
  expect(grade.diagnostics?.formatFailure).toBe(true)
  const unreadable = gradeDiscovery(instance, focusedDiscoveryAnswer("We completed the review.").value, { strictAssistantFormat: false })
  expect(unreadable.diagnostics?.contentScored).toBe(false)
  expect(unreadable.materialDefectRecall).toBeNull()
  expect(unreadable.missedFindings).toEqual([])
})

test("a blind-supported cause can be cited incompletely without becoming an omitted defect", () => {
  const instance = pine!
  const submission = answer()
  submission.claims[0]!.evidence.pop()
  const packet = buildDiscoveryReviewPacket(instance, submission)!
  const grade = gradeDiscovery(instance, submission, {
    verifiedSourcePaths: instance.input.sources.map(source => source.path),
    adjudications: packet.submission.claims.map(claim => ({
      packetId: packet.packetId, claimId: claim.claimId, verdict: "supported", rationale: "Claim and citations support attribution.",
      evidence: claim.evidence,
    })),
  })
  expect(grade.diagnostics?.citationIncompleteFindings).toEqual([{ finding: "duplicate", scope: "DP-214" }])
  expect(grade.diagnostics?.omittedDefects).toEqual([])
  expect(grade.diagnostics?.unsupportedClosure).toBe(true)
})

test("uptake requires an owner-recorded rendered report and exact same-revision readback independently of truth", () => {
  const instance = elm!
  const target = instance.oracle.targets[1]!
  const reference = target.requiredRefs[0]!
  const path = reference.split("#")[0]!
  const read: DiscoveryRead = { tool: "sources_discovery_read", path, receipt: "read-1", messageId: "message-2",
    callId: "call-2", sha256: sha256(instance.input.sources.find(source => source.path === path)!.content) }
  const source = { ...read, reference, id: sha256(reference) }
  const input = { id: "duplicate", interpretation: "duplicate", scope: target.scope, support: [reference], counterevidence: [] }
  const finding = { ...input, attribution: "model", status: "supported", support: [source] }
  const evidence = { revision: 2, sources: [{ ...read, status: "inspected", references: [source] }], findings: [finding] }
  const decision = { next_action: "Close after the reconciliation." }
  const reportDecision = { disposition: "resolved", missingEvidence: [] }
  const decisionEvidence = { sources: [{ id: source.id, reference }], reportDecision: {
    decision: reportDecision, findingsSha256: sha256(canonicalJson([{ ...finding, support: [source.id] }])),
  } }
  const report = { ...reportDecision, claims: [{finding: input.interpretation, scope: input.scope, evidence: [reference]}] }
  const bundleSha256 = sha256("bundle")
  const receipt = (action: string, row: number, input: Record<string, unknown>, value: Record<string, unknown>): DiscoveryLedgerCall => ({
    action, row, input, id: String(row), value: { ok: true, runtimeSha256: bundleSha256, investigationMode: "read-only", work: null, ...value },
  })
  const calls = [
    receipt("create", 1, {}, { decision_revision: 0 }),
    receipt("record_finding", 3, { finding: input }, { decision_revision: 0, evidence_revision: 2, finding }),
    receipt("set_next_measurement", 4, { report_decision: reportDecision, evidence_refs: [reference] },
      { decision_revision: 1, decision, decision_evidence: decisionEvidence }),
    receipt("status", 5, {}, { decision_revision: 1, decision, decision_evidence: decisionEvidence, evidence, report_authority: "owner_recorded" }),
    receipt("render_report", 6, {}, { decision_revision: 1, evidenceRevision: 2, report_authority: "owner_recorded", report }),
  ]
  const options = { calls, reads: [read], bundleSha256, incident: instance, file: null }
  const measured = evaluateDiscoveryLedger(options)
  expect(measured.applied).toBe(true)
  expect(measured.canonicalUnsupportedClosure).toBe(true)
  expect(measured.questionFromUnresolvedEvidence).toBe(false)
  const text = JSON.stringify(report) + "\n"
  const file = { messageId: "native-report", revision: 1, evidenceRevision: 2, path: "reports/decision-1.json",
    sha256: sha256(text), text, sourceCallsDelta: 0, providerCallsDelta: 0, authority: "owner_recorded" as const }
  expect(evaluateDiscoveryLedger({ ...options, file }).commandFileMatches).toBe(true)
  expect(evaluateDiscoveryLedger({ ...options, file: { ...file, providerCallsDelta: 1 } }).commandFileMatches).toBe(false)
  expect(evaluateDiscoveryLedger({ ...options, reads: [] }).applied).toBe(false)
  expect(evaluateDiscoveryLedger({ ...options, calls: calls.filter(row => row.action !== "status") }).applied).toBe(false)
  calls.at(-1)!.value.report_authority = "provisional"
  expect(evaluateDiscoveryLedger(options).applied).toBe(false)
})

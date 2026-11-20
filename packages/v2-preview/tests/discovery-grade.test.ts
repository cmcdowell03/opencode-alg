import { expect, test } from "bun:test"
import { buildDiscoveryCases, type DiscoveryCase } from "../benchmark/discovery-cases.ts"
import {
  buildDiscoveryReviewPacket, gradeDiscovery, parseDiscoverySubmission,
  type DiscoveryAdjudication, type DiscoveryClaim, type DiscoverySubmission,
} from "../benchmark/discovery-grade.ts"

const [clock, noise, uncovered, dual, stale] = buildDiscoveryCases() as [DiscoveryCase, DiscoveryCase, DiscoveryCase, DiscoveryCase, DiscoveryCase]

const lot184 = [
  "dashboard.json#d1", "dashboard.json#d2", "capture-index.json#a1", "catalog.json#c1",
  "reference-gauge.json#r1", "reference-gauge.json#r2", "release-control.json#u1", "schedule.json#w1",
]
const capture = "sync-capture.json#s1"
const claim = (finding: string, evidence: string[], scope = "L-184"): DiscoveryClaim => ({ finding, scope, evidence })
const clockClaim = claim("Clock skew", [...lot184, capture, "catalog.json#c3", "schedule.json#w2"])
const chamberClaim = claim("Chamber overtemperature", [
  "dashboard.json#d3", "dashboard.json#d4", "capture-index.json#a1", "catalog.json#c3", "hold-log.json#h2",
  "reference-gauge.json#r3", "reference-gauge.json#r4", "release-control.json#u2", "schedule.json#w2", capture,
], "L-731")
const noiseClaim = claim("measurement noise", [...lot184, capture, "instrument.json#i1", "instrument.json#i2"])
const staleClaim = claim("stale catalog revision", [...lot184, capture, "catalog.json#c2"])
const coverageClaim = claim("unresolved time alignment", [
  ...lot184, "catalog.json#c3", "release-control.json#u2", "schedule.json#w2",
])

const resolved = (...claims: DiscoveryClaim[]): DiscoverySubmission => ({ disposition: "resolved", claims, missingEvidence: [] })
const abstained: DiscoverySubmission = {
  disposition: "indeterminate", claims: [coverageClaim], missingEvidence: ["sync-capture.json"],
}

test("each incident accepts a report supported entirely by public rows with verified reads", () => {
  for (const [incident, submission, recall] of [
    [clock, resolved(clockClaim), 1],
    [noise, resolved(noiseClaim), null],
    [uncovered, abstained, null],
    [dual, resolved(clockClaim, chamberClaim), 1],
    [stale, resolved(staleClaim), 1],
  ] as const) {
    const grade = gradeDiscovery(incident, parseDiscoverySubmission(JSON.stringify(submission)), {
      verifiedSourcePaths: incident.input.sources.map(source => source.path),
    })
    expect(grade).toMatchObject({
      passed: true, verifiedEvidence: true, materialDefectRecall: recall, fullIncidentClosure: incident !== uncovered,
      correctAbstention: incident === uncovered, supportedClaims: submission.claims.length,
      reviewRequired: false, severeMisses: [], unsupportedCertifications: [],
    })
  }
})

test("one fully supported cause cannot close a two-fault incident", () => {
  const grade = gradeDiscovery(dual, resolved(clockClaim))
  expect(grade).toMatchObject({
    materialDefectRecall: 0.5, fullIncidentClosure: false, supportedClaims: 1, passed: false,
    severeMisses: [{ finding: "chamber", scope: "L-731" }],
  })
  expect(grade.unsupportedCertifications).toHaveLength(1)
})

test("abstention needs a demonstrated ambiguity and its decisive missing source", () => {
  expect(gradeDiscovery(clock, { ...resolved(clockClaim), disposition: "indeterminate" })).toMatchObject({
    correctAbstention: false, passed: false, materialDefectRecall: 1,
  })
  expect(gradeDiscovery(uncovered, { ...abstained, claims: [] }).correctAbstention).toBe(false)
  expect(gradeDiscovery(uncovered, { ...abstained, missingEvidence: ["instrument.json"] }).correctAbstention).toBe(false)
  expect(gradeDiscovery(uncovered, { ...abstained, disposition: "resolved" }).unsupportedCertifications)
    .toContain("Decisive evidence is unavailable")
})

test("known attributions need the specific rows and an audited read when read receipts are supplied", () => {
  const unsupported = gradeDiscovery(dual, resolved(clockClaim, { ...chamberClaim, evidence: clockClaim.evidence }))
  expect(unsupported.supportedClaims).toBe(1)
  expect(unsupported.unsupportedClaims).toEqual(["c2"])
  expect(unsupported.materialDefectRecall).toBe(0.5)
  const inventedRef = { ...clockClaim, evidence: [...clockClaim.evidence, "schedule.json#w99"] }
  expect(gradeDiscovery(clock, resolved(inventedRef)).unsupportedClaims).toEqual(["c1"])
  const verifiedSourcePaths = clock.input.sources.map(source => source.path).filter(path => path !== "sync-capture.json")
  expect(gradeDiscovery(clock, resolved(clockClaim), { verifiedSourcePaths })).toMatchObject({
    verifiedEvidence: false, fullIncidentClosure: true, passed: false,
    unsupportedCertifications: ["Citations lack verified source reads"],
  })
})

test("blind review is anonymous, grounded in public rows, and bound to the original assertion", () => {
  const extra = claim("The approved catalog did not change the P-27 limits", ["catalog.json#c3", "catalog.json#c4"], "L-731")
  const submission = resolved(clockClaim, extra)
  const packet = buildDiscoveryReviewPacket(clock, submission)!
  const pending = gradeDiscovery(clock, submission)
  expect(pending).toMatchObject({ pendingClaims: ["c2"], reviewRequired: true, passed: false, materialDefectRecall: 1 })
  expect(Object.keys(packet).sort()).toEqual(["packetId", "prompt", "schema", "sources", "submission"])
  expect(packet.sources).toEqual(clock.input.sources)
  expect(packet.submission.claims.map(row => row.claimId)).toEqual(["c1", "c2"])
  expect(JSON.stringify(packet)).not.toContain(clock.id)
  expect(JSON.stringify(packet)).not.toMatch(/oracle|requiredRefs|materialDefect|pendingClaims/)
  const review: DiscoveryAdjudication = {
    packetId: packet.packetId, claimId: "c2", verdict: "supported",
    rationale: "Both revisions give P-27 the same lower and upper limits.", evidence: extra.evidence,
  }
  expect(gradeDiscovery(clock, submission, { adjudications: [review] })).toMatchObject({
    supportedClaims: 2, reviewRequired: false, passed: true,
  })
  const revised = resolved(clockClaim, { ...extra, finding: "The approved catalog narrowed the P-27 limits" })
  const revisedPacket = buildDiscoveryReviewPacket(clock, revised)!
  expect(gradeDiscovery(clock, revised, { adjudications: [review] })).toMatchObject({
    reviewRequired: true, adjudicationErrors: ["Invalid adjudication for c2"],
  })
  const negative: DiscoveryAdjudication = {
    ...review, packetId: revisedPacket.packetId, verdict: "contradicted",
    rationale: "P-27 has the same limits in both catalog rows.",
  }
  expect(gradeDiscovery(clock, revised, { adjudications: [negative] })).toMatchObject({
    reviewRequired: false, unsupportedClaims: ["c2"], passed: false,
  })
  expect(gradeDiscovery(clock, submission, { adjudications: [review, review] })).toMatchObject({
    reviewRequired: true, adjudicationErrors: ["Duplicate adjudication for c2"], passed: false,
  })
})

test("a reviewed paraphrase can count toward recall, and unrelated citations cannot", () => {
  const paraphrase = { ...chamberClaim, finding: "An overheated conditioning hold explains the low widths on this lot" }
  const submission = resolved(clockClaim, paraphrase)
  const vote: DiscoveryAdjudication = {
    packetId: buildDiscoveryReviewPacket(dual, submission)!.packetId, claimId: "c2", verdict: "supported",
    rationale: "The paired hold and remeasurements establish the temperature excursion.", evidence: paraphrase.evidence,
    equivalentTo: { finding: "chamber", scope: "L-731" },
  }
  expect(gradeDiscovery(dual, submission, { adjudications: [vote] })).toMatchObject({
    materialDefectRecall: 1, fullIncidentClosure: true, passed: true,
  })
  expect(gradeDiscovery(dual, submission, { adjudications: [{ ...vote, evidence: ["instrument.json#i1"] }] }))
    .toMatchObject({ materialDefectRecall: 0.5, reviewRequired: true, passed: false })

  const invented = resolved(clockClaim, claim("Replace the sealer immediately", []))
  const unsupported: DiscoveryAdjudication = {
    packetId: buildDiscoveryReviewPacket(clock, invented)!.packetId, claimId: "c2", verdict: "unsupported",
    rationale: "The answer cites no evidence for this recommendation.", evidence: [],
  }
  expect(gradeDiscovery(clock, invented, { adjudications: [unsupported] })).toMatchObject({
    unsupportedClaims: ["c2"], supportedClaims: 1, reviewRequired: false, passed: false,
  })
})

test("malformed final text and extra protocol fields cannot certify findings", () => {
  expect(parseDiscoverySubmission("Here is the answer: {}")).toBeUndefined()
  expect(parseDiscoverySubmission("\x60\x60\x60json\n{}\n\x60\x60\x60")).toEqual({})
  expect(buildDiscoveryReviewPacket(clock, { ...resolved(clockClaim), certified: true })).toBeNull()
  expect(gradeDiscovery(clock, undefined)).toMatchObject({
    validSubmission: false, passed: false, fullIncidentClosure: false, correctAbstention: false,
  })
})

test("repeating a finding does not inflate its supported claim count or recall", () => {
  const duplicate = { ...clockClaim, finding: "clock offset" }
  expect(gradeDiscovery(dual, resolved(clockClaim, duplicate))).toMatchObject({
    supportedClaims: 1, materialDefectRecall: 0.5, fullIncidentClosure: false,
  })
})

test("an abstention cannot hide an unsupported scoped certification", () => {
  const claim = { finding: "L-184 is certified in spec under every valid timestamp", scope: "L-184", evidence: coverageClaim.evidence }
  const submission = { ...abstained, claims: [...abstained.claims, claim] }
  const vote: DiscoveryAdjudication = {
    packetId: buildDiscoveryReviewPacket(uncovered, submission)!.packetId,
    claimId: "c2", verdict: "contradicted", certification: true,
    rationale: "The zero-offset interpretation applies P-27 and requires a minimum width of 11.8 mm.",
    evidence: ["capture-index.json#a1", "catalog.json#c3", "dashboard.json#d1", "schedule.json#w2"],
  }
  expect(gradeDiscovery(uncovered, submission, { adjudications: [vote] })).toMatchObject({
    correctAbstention: false, unsupportedClaims: ["c2"], passed: false,
    unsupportedCertifications: ["Claim c2 asserts a certification the sources do not establish"],
  })
})

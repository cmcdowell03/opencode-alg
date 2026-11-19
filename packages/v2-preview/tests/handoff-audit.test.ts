import { expect, test } from "bun:test"
import { sha256 } from "../acceptance/runtime.ts"
import { evidenceRef, generateFabEvidence } from "../benchmark/case.ts"
import { auditHandoff, inspectAnswer } from "../benchmark/handoff-audit.ts"
import { briefKey, finalInput, handoffId, initialInput, refutationId, refutationStatement, skillContent,
  skillName, verifiedCorrection } from "../benchmark/handoff-case.ts"

const action = "replay-clock-join", prerequisite = "verified-clock-audit"
const explicit = action + "; prerequisite=" + prerequisite
const body = skillContent.slice(skillContent.indexOf("\n---\n") + 5)
const pin = { id: skillName, path: ".opencode/skills/" + skillName + "/SKILL.md",
  sha256: sha256(body), sourceSha256: sha256(skillContent) }
const runtime = sha256("test runtime"), manifest = sha256("test manifest")
const work = { work_key: sha256("test work"), manifest_digest: manifest, status: "result_recorded" }
const refutation = { id: refutationId, statement: refutationStatement, manifest_digest: manifest }
const hypothesis = { id: refutationId, statement: refutationStatement, status: "refuted", evidence_refs: [manifest], other_evidence_refs: 0 }
const report = { cohortSize: 8, defects: 7, verifiedClockCorrections: 3, inspectionRef: evidenceRef("inspection"),
  auditRef: evidenceRef("clock-audit"), nextAction: action, prerequisite }
const correction = verifiedCorrection(JSON.stringify({ auditRows: generateFabEvidence()["clock-audit"], auditRef: report.auditRef }))!

const answer = (id: string, text: string) => ({ id, type: "assistant", agent: "build", finish: "stop", content: [{ type: "text", text }] })
const call = (id: string, input: object, result: object) => ({ id, type: "assistant", agent: "build", content: [
  { id, type: "tool", name: "alg_investigation", state: { status: "completed", input,
    content: [{ type: "text", text: JSON.stringify({ runtimeSha256: runtime, ok: true, ...result }) }] } },
] })
function write(revision: number, next: string, claim: typeof refutation | null, hypotheses = [hypothesis]) {
  return call("write-" + revision, { action: "set_next_measurement", expected_decision_revision: revision - 1,
    next_action: next, ...(claim && { refutation: claim }) }, { decision_revision: revision, revision: revision + 10, work,
    decision: { next_action: next, hypotheses } })
}
function fixture(next = explicit) {
  const durable = { revision: 7, actionSha: sha256(next), procedureSha: pin.sha256, governedManifestObserved: true }
  const brief = { schema: 1, revision: 17, decision_revision: 7, status: work.status, settled_manifest_digest: manifest,
    refuted_hypothesis: { id: refutationId, manifest_digest: manifest },
    observed_approval: { procedure_sha256: pin.sha256, revision: sha256(JSON.stringify(pin)) } }
  const beforeAnswer = answer("prior", JSON.stringify(report)), finalAnswer = answer("final", JSON.stringify(report))
  const measured = write(7, next, null), refuted = write(6, "attribute-as-recorded", refutation)
  const read = call("read", { action: "procedure" }, { procedure: { ...pin, content: body } })
  const idle = { type: "idle", outcome: "succeeded" }
  const raw = { root: [
    { type: "user", text: initialInput }, call("dispatch", { action: "dispatch" }, { work }), refuted, measured,
    { type: "user", text: correction }, beforeAnswer, idle, { type: "compaction", reason: "manual", status: "completed", id: "cut" },
    idle, { type: "user", text: finalInput }, read, finalAnswer, idle,
  ] }
  const arm = { raw, skill: pin, gate: { policy: { procedure: pin } },
    factoryEvidence: { ledger: { acceptedComputations: 1 }, jobs: [{ idempotencyKey: "request", job: {
      jobId: "job", resultDigest: manifest, status: "complete" } }] },
    factoryAudit: [{ name: "submit", accepted: true, response: "sent", job: "job", submission: "request" }],
    decisions: { durableBefore: { ...durable }, durableAfter: { ...durable } },
    brief: { before: brief, after: structuredClone(brief), key: briefKey, readError: null },
    compaction: { boundaries: [{ id: "cut", beforeAnswerId: "prior", afterAnswerId: "final" }],
      summarySha256: sha256("summary"), finalObservedAtMs: 12,
      modelWitness: [{ boundary: 1, stage: "continue", summarySha256: sha256("summary"), observedAtMs: 11, currentSkill: false }] } }
  const receipt = { schema: 2, caseId: handoffId, workload: "single", variant: "active", runtime: { bundleSha256: runtime },
    arms: { alg: arm, build: structuredClone(arm) } }
  const audit = () => auditHandoff(Buffer.from(JSON.stringify(receipt))).alg
  return { receipt, arm, raw, measured, refuted, read, finalAnswer, beforeAnswer, audit }
}

test("early separate acknowledgments bind the exact retained span, latest action and both readbacks", () => {
  const f = fixture()
  expect(f.audit()).toMatchObject({ status: "verified_at_both_cuts", beforeCompaction: {
    revision: 7, writeBeforeCorrection: true, actionEvidence: "explicit_pair" }, endOfContinuation: { revision: 7 },
    refutation: { id: refutationId, decisionRevision: 6, sha256: sha256(refutationStatement), judgment: "canonical_fixture" },
    exactProcedureRead: true, systemProjection: "unproven" })
  f.read.content[0]!.state.content[0]!.text = JSON.stringify({ ok: true, runtimeSha256: runtime, procedure: { ...pin, content: body.trim() } })
  expect(f.audit()).toMatchObject({ exactProcedureRead: false, systemProjection: "unproven" })
  f.arm.compaction.modelWitness[0]!.currentSkill = true
  expect(f.audit()).toMatchObject({ exactProcedureRead: false, systemProjection: "witnessed" })
})

test("bare canonical action requires the explicit prerequisite in the strict report at each cut", () => {
  const f = fixture(action)
  expect(f.audit()).toMatchObject({ status: "verified_at_both_cuts", beforeCompaction: { actionEvidence: "contemporaneous_report" } })
  f.finalAnswer.content[0]!.text = JSON.stringify({ ...report, prerequisite: "independent-clock-audit" })
  expect(f.audit()).toMatchObject({ beforeCompaction: { status: "verified" }, endOfContinuation: { status: "undecidable" } })
  f.beforeAnswer.content[0]!.text += " extra prose"
  expect(f.audit()).toMatchObject({ beforeCompaction: { status: "undecidable" } })
  expect(fixture("do not " + explicit).audit().status).toBe("undecidable")
})

test("a later reversal or retraction cannot inherit the earlier success", () => {
  for (const reversed of [true, false]) {
    const f = fixture()
    const next = reversed ? "attribute-as-recorded; prerequisite=independent-clock-audit" : explicit
    f.raw.root.splice(-2, 0, write(8, next, null, reversed ? [hypothesis] : []))
    Object.assign(f.arm.decisions.durableAfter, { revision: 8, actionSha: sha256(next) })
    Object.assign(f.arm.brief.after, { revision: 18, decision_revision: 8 })
    expect(f.audit()).toMatchObject({ status: "undecidable", beforeCompaction: { status: "verified" },
      endOfContinuation: { status: "undecidable" } })
  }
})

test("missing, late, unacknowledged or changed evidence cannot verify the decision", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.arm.decisions.durableAfter.actionSha = sha256("other") },
    (f: ReturnType<typeof fixture>) => { f.arm.decisions.durableBefore.procedureSha = sha256("other") },
    (f: ReturnType<typeof fixture>) => { f.arm.factoryAudit[0]!.job = "different-job" },
    (f: ReturnType<typeof fixture>) => { f.arm.factoryEvidence.jobs[0]!.job.resultDigest = sha256("other") },
    (f: ReturnType<typeof fixture>) => { f.arm.brief.after.refuted_hypothesis.id = "other" },
    (f: ReturnType<typeof fixture>) => { f.refuted.content[0]!.state.status = "error" },
    (f: ReturnType<typeof fixture>) => { Object.assign(f.refuted.content[0]!.state.input, { refutation: { ...refutation, statement: "opposite" } }) },
    (f: ReturnType<typeof fixture>) => { f.raw.root.splice(2, 1); f.raw.root.splice(-2, 0, f.refuted) },
    (f: ReturnType<typeof fixture>) => { f.raw.root.splice(3, 1, write(7, explicit, null, [{ ...hypothesis, statement: "different" }])) },
    (f: ReturnType<typeof fixture>) => { f.arm.compaction.boundaries[0]!.afterAnswerId = "wrong endpoint" },
  ]) {
    const f = fixture()
    mutate(f)
    expect(f.audit().status).not.toBe("verified_at_both_cuts")
  }
})

test("format failure, field disagreement and ambiguous extraction have distinct observations", () => {
  const json = JSON.stringify(report)
  expect(inspectAnswer(json, true)).toEqual({ syntax: "valid_json", observation: "strict_object", mismatchedFields: [] })
  expect(inspectAnswer(json + "\nA short explanation.", true)).toEqual({
    syntax: "invalid_json", observation: "leading_object_only", mismatchedFields: [],
  })
  expect(inspectAnswer(JSON.stringify({ ...report, defects: 0 }), true).mismatchedFields).toEqual(["defects"])
  for (const ambiguous of [json + "\n" + json, json.replace('"defects":7', '"defects":0,"defects":7'),
    json + "\nRevised defects follow.", "Intro\n" + json, "{}", "inconclusive"])
    expect(inspectAnswer(ambiguous, true)).toMatchObject({ observation: "undecidable", mismatchedFields: null })
})

test("independent wording review requires the exact receipt bytes and acknowledged span", () => {
  const f = fixture()
  const span = "The calibration is settled and recorded."
  const text = JSON.stringify(f.receipt).replaceAll(refutationStatement, span)
  const bytes = Buffer.from(text)
  const review = { live: { receipt_sha256: sha256(text) }, secondary_offline_replay: {
    statement_review: "grounded", refutation_id: refutationId, acknowledged_refutation_text_sha256: sha256(span),
  } }
  expect(auditHandoff(bytes, review).alg).toMatchObject({ status: "verified_at_both_cuts", refutation: { judgment: "bound_review" } })
  for (const result of [
    auditHandoff(bytes), auditHandoff(Buffer.from(text + "\n"), review),
    auditHandoff(bytes, { ...review, secondary_offline_replay: { ...review.secondary_offline_replay,
      acknowledged_refutation_text_sha256: sha256("other span") } }),
    auditHandoff(bytes, { ...review, secondary_offline_replay: { ...review.secondary_offline_replay, statement_review: "unclear" } }),
  ]) {
    expect(result.alg).toMatchObject({ status: "undecidable", beforeCompaction: { structurallyVerified: true },
      endOfContinuation: { structurallyVerified: true }, refutation: { judgment: "undecidable", sha256: sha256(span) } })
  }
})

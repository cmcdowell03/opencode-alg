import { expect, test } from "bun:test"
import { sha256 } from "../acceptance/runtime.ts"
import { evidenceRef, generateFabEvidence } from "../benchmark/case.ts"
import { auditHandoff, gradeHandoffDecisions, inspectAnswer } from "../benchmark/handoff-audit.ts"
import { briefKey, checkerInput, finalInput, handoffId, initialInput, refutationId, refutationStatement, skillContent,
  skillName, verifiedCorrection } from "../benchmark/handoff-case.ts"
import { createWorkbench } from "../benchmark/workbench.ts"

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
const checkerResponse = JSON.stringify({ auditRows: generateFabEvidence()["clock-audit"], auditRef: report.auditRef })
const correction = verifiedCorrection(checkerResponse)!

const answer = (id: string, text: string, agent = "build") =>
  ({ id, type: "assistant", agent, finish: "stop", content: [{ type: "text", text }] })
const call = (id: string, input: object, result: object, created = 50) => ({ id, type: "assistant", agent: "build",
  time: { created }, content: [
  { id, type: "tool", name: "alg_investigation", state: { status: "completed", input,
    content: [{ type: "text", text: JSON.stringify({ runtimeSha256: runtime, ok: true, ...result }) }] } },
] })
function write(revision: number, next: string, claim: typeof refutation | null, hypotheses = [hypothesis]) {
  return call("write-" + revision, { action: "set_next_measurement", expected_decision_revision: revision - 1,
    next_action: next, ...(claim && { refutation: claim }) }, { decision_revision: revision, revision: revision + 10, work,
    decision: { next_action: next, hypotheses } })
}
function fixture(next = explicit) {
  const workbench = createWorkbench()
  const lookup = (scope: "root" | "checker", limit: number) => {
    const args = { pages: [{ source: scope === "root" ? "inspection" : "clock-audit", limit }] }
    const result = (scope === "root" ? workbench.call : workbench.checkerCall)("lookup_pages", args)
    const row = call("lookup-" + scope + "-" + limit, args, result)
    row.agent = scope === "root" ? "build" : "research-checker"
    row.content[0]!.name = scope === "root" ? "evidence_lookup_pages" : "audit_lookup_pages"
    return row
  }
  const durable = { revision: 7, actionSha: sha256(next), procedureSha: pin.sha256, governedManifestObserved: true }
  const brief = { schema: 1, revision: 17, decision_revision: 7, status: work.status, settled_manifest_digest: manifest,
    refuted_hypothesis: { id: refutationId, manifest_digest: manifest },
    observed_approval: { procedure_sha256: pin.sha256, revision: sha256(JSON.stringify(pin)) } }
  const beforeAnswer = answer("prior", JSON.stringify(report)), finalAnswer = answer("final", JSON.stringify(report))
  const earlyAnswer = answer("early", JSON.stringify(report))
  const measured = write(7, next, null), refuted = write(6, "attribute-as-recorded", refutation)
  const read = call("read", { action: "procedure" }, { procedure: { ...pin, content: body } })
  const idle = { type: "idle", outcome: "succeeded" }
  const checkerId = "test-checker"
  const synthetic = { type: "synthetic", time: { created: 45 },
    metadata: { source: "subagent", childID: checkerId, agent: "research-checker", state: "completed" },
    text: `<subagent sessionID="${checkerId}" state="completed" description="Independent clock audit">\n${checkerResponse}\n</subagent>` }
  const manualCorrection = { type: "user", text: correction, time: { created: 60 } }
  const raw = {
    root: [
      { type: "user", text: initialInput }, call("dispatch", { action: "dispatch" }, { work }), refuted,
      lookup("root", 4), lookup("root", 8), synthetic, measured, earlyAnswer,
      manualCorrection, beforeAnswer, idle, { type: "compaction", reason: "manual", status: "completed", id: "cut" },
      idle, { type: "user", text: finalInput }, read, finalAnswer, idle,
    ],
    checker: [{ type: "user", text: checkerInput }, lookup("checker", 24),
      answer("checker-answer", checkerResponse, "research-checker"), { ...idle, time: { created: 40 } }],
  }
  const arm = { raw, skill: pin, gate: { policy: { procedure: pin } },
    checkerId, skillAvailableAtContinue: true, ledger: workbench.snapshot(),
    factoryEvidence: { ledger: { acceptedComputations: 1 }, jobs: [{ idempotencyKey: "request", job: {
      jobId: "job", resultDigest: manifest, status: "complete" } }] },
    factoryAudit: [{ name: "submit", accepted: true, response: "sent", job: "job", submission: "request" }],
    decisions: { durableBefore: { ...durable }, durableAfter: { ...durable } },
    brief: { before: brief, after: structuredClone(brief), key: briefKey, readError: null },
    compaction: { boundaries: [{ id: "cut", beforeAnswerId: "prior", afterAnswerId: "final" }] as {
      id: string; beforeAnswerId: string; afterAnswerId: string
      decisionReadback?: { before: { durable: typeof durable; brief: unknown }; after: { durable: typeof durable; brief: unknown } }
    }[],
      summarySha256: sha256("summary"), finalObservedAtMs: 12,
      modelWitness: [{ boundary: 1, stage: "continue", summarySha256: sha256("summary"), observedAtMs: 11, currentSkill: false }] } }
  const receipt = { schema: 2, caseId: handoffId, workload: "single", variant: "active", runtime: { bundleSha256: runtime },
    arms: { alg: arm, build: structuredClone(arm) } }
  const audit = () => auditHandoff(Buffer.from(JSON.stringify(receipt))).alg
  const grade = (variant: "active" | "revoked" = "active") => gradeHandoffDecisions(JSON.parse(JSON.stringify(arm)), runtime, variant)
  return { receipt, arm, raw, measured, refuted, synthetic, manualCorrection, earlyAnswer, read, finalAnswer, beforeAnswer, audit, grade }
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
  expect(f.audit()).toMatchObject({ exactProcedureRead: false, systemProjection: "unproven" })
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

test("parallel acknowledgments are ordered by CAS revision and a rejected retry leaves them intact", () => {
  const f = fixture()
  const rejected = write(9, "attribute-as-recorded", null).content[0]!
  rejected.state.content[0]!.text = JSON.stringify({ ok: false, error: "stale investigation decision revision" })
  const claim = f.refuted.content[0]!
  f.raw.root.splice(f.raw.root.indexOf(f.refuted), 1)
  f.measured.content.push(rejected, claim)
  expect(f.grade()).toMatchObject({ status: "verified_at_both_cuts", refutation: { decisionRevision: 6 },
    beforeCompaction: { revision: 7 }, endOfContinuation: { revision: 7 } })
  const unrelated = write(9, explicit, null)
  f.raw.root.splice(-2, 0, unrelated)
  Object.assign(f.arm.decisions.durableAfter, { revision: 9 })
  Object.assign(f.arm.brief.after, { revision: 19, decision_revision: 9 })
  expect(f.grade()).toMatchObject({ status: "undecidable", endOfContinuation: { boundRevision: false } })
})

test("checker evidence must precede the corrected write and be independently verified", () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => { f.synthetic.metadata.childID = "other-checker" },
    (f: ReturnType<typeof fixture>) => { f.synthetic.text = f.synthetic.text.replace("verified", "unverified") },
    (f: ReturnType<typeof fixture>) => { f.synthetic.time.created = 39 },
    (f: ReturnType<typeof fixture>) => { f.raw.checker[2] = answer("checker-answer", "unverified claim", "research-checker") },
    (f: ReturnType<typeof fixture>) => { f.arm.ledger.receipts.pop() },
    (f: ReturnType<typeof fixture>) => { f.raw.root.splice(4, 1) },
  ]) {
    const f = fixture()
    mutate(f)
    expect(f.grade()).toMatchObject({ checks: { correctedCheckpoint: false, durableCorrectedState: false } })
  }
  const f = fixture()
  f.raw.root.splice(f.raw.root.indexOf(f.synthetic), 1)
  f.raw.root.splice(f.raw.root.indexOf(f.measured), 1)
  f.measured.time.created = 61
  f.raw.root.splice(f.raw.root.indexOf(f.manualCorrection) + 1, 0, f.measured)
  expect(f.grade()).toMatchObject({ status: "verified_at_both_cuts", beforeCompaction: { writeBeforeCorrection: false } })
})

function revokedReport() {
  return JSON.stringify({ ...report, nextAction: null, prerequisite: "current-approved-procedure" })
}

function appendBoundary(f: ReturnType<typeof fixture>, revision: number, next: string, revoked = false) {
  const id = "cut-" + revision
  const beforeAnswerId = id + "-before", afterAnswerId = id + "-after"
  const durable = { ...f.arm.decisions.durableAfter, revision, actionSha: sha256(next) }
  const brief = { ...f.arm.brief.after, decision_revision: revision, revision: revision + 10 }
  const after = { ...brief, observed_approval: revoked ? null : brief.observed_approval }
  const afterCut = { durable: { ...durable }, brief: after }
  f.arm.compaction.boundaries.push({ id, beforeAnswerId, afterAnswerId,
    decisionReadback: { before: { durable, brief }, after: afterCut } })
  const idle = { type: "idle", outcome: "succeeded" }
  f.raw.root.push(write(revision, next, null), answer(beforeAnswerId, JSON.stringify(report)), idle,
    { id, type: "compaction", reason: "manual", status: "completed" }, idle, { type: "user", text: finalInput },
    answer(afterAnswerId, revoked ? revokedReport() : JSON.stringify(report)), idle)
  Object.assign(f.arm.decisions.durableAfter, durable)
  Object.assign(f.arm.brief.after, after)
  f.arm.skillAvailableAtContinue = !revoked
  return afterCut
}

function captureFirstBoundary(f: ReturnType<typeof fixture>) {
  f.arm.compaction.boundaries[0]!.decisionReadback = {
    before: { durable: { ...f.arm.decisions.durableBefore }, brief: structuredClone(f.arm.brief.before) },
    after: { durable: { ...f.arm.decisions.durableAfter }, brief: structuredClone(f.arm.brief.after) },
  }
}

test("extended withdrawal allows writes before the last boundary but rejects a new write after withdrawal", () => {
  const f = fixture()
  captureFirstBoundary(f)
  const recorded = appendBoundary(f, 8, explicit, true)
  expect(f.grade("revoked")).toMatchObject({ boundarySnapshots: "complete", checks: {
    correctedRevision: true, durableCorrectedState: true, refutationVerified: true,
  }, endOfContinuation: { revision: 8, status: "verified" } })
  const forged = write(9, explicit, null)
  f.raw.root.splice(-2, 0, forged)
  Object.assign(recorded.durable, { revision: 9 })
  Object.assign(recorded.brief, { decision_revision: 9, revision: 19 })
  expect(f.grade("revoked")).toMatchObject({ checks: { durableCorrectedState: false },
    endOfContinuation: { boundRevision: true, actionVerified: false } })
})

test("an intermediate supersession remains failed after a later repair", () => {
  const f = fixture()
  captureFirstBoundary(f)
  appendBoundary(f, 8, "attribute-as-recorded")
  appendBoundary(f, 9, explicit)
  expect(f.grade()).toMatchObject({ status: "undecidable", boundarySnapshots: "complete",
    beforeCompaction: { status: "verified" }, endOfContinuation: { status: "verified" },
    checks: { correctedCheckpoint: false, durableCorrectedState: false },
    cuts: [
      { beforeCompaction: { status: "verified" }, endOfContinuation: { status: "verified" } },
      { beforeCompaction: { actionVerified: false }, endOfContinuation: { actionVerified: false } },
      { beforeCompaction: { status: "verified" }, endOfContinuation: { status: "verified" } },
    ],
  })
  const [first, middle, last] = f.arm.compaction.boundaries
  if (!first || !middle || !last) throw new Error("missing test boundaries")
  f.arm.compaction.boundaries = [first, { id: middle.id, beforeAnswerId: middle.beforeAnswerId, afterAnswerId: middle.afterAnswerId }, last]
  expect(f.grade()).toMatchObject({ boundarySnapshots: "incomplete", checks: { durableCorrectedState: false } })
})

test("a manifest-bound but inverted refutation is indeterminate and fails the release gate", () => {
  const f = fixture()
  const raw = JSON.stringify(f.arm).replaceAll(refutationStatement, "The calibration result is missing and was never recorded.")
  const grade = gradeHandoffDecisions(JSON.parse(raw), runtime, "active")
  expect(grade).toMatchObject({ status: "undecidable", checks: {
    correctedRevision: true, factsRetained: true, refutationVerified: false,
  }, refutation: { judgment: "undecidable" } })
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
    (f: ReturnType<typeof fixture>) => { f.raw.root.splice(f.raw.root.indexOf(f.refuted), 1); f.raw.root.splice(-2, 0, f.refuted) },
    (f: ReturnType<typeof fixture>) => { f.raw.root.splice(f.raw.root.indexOf(f.measured), 1, write(7, explicit, null, [{ ...hypothesis, statement: "different" }])) },
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

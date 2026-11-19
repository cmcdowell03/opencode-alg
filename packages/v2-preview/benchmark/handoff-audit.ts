import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { SessionMessageInfo } from "@opencode/client"
import { owner, receiptsFor } from "../acceptance/host.ts"
import { sha256 } from "../acceptance/runtime.ts"
import { evidenceRef, generateFabEvidence } from "./case.ts"
import { briefKey, candidates, correctionHeader, defectFloor, finalInput, handoffId, initialInput,
  matchingCorrections, object, refutationId, refutationStatement, skillContent, skillName, verifiedCorrection } from "./handoff-case.ts"
import type { runHandoff } from "./handoff.ts"

type Receipt = Awaited<ReturnType<typeof runHandoff>>
type Arm = Receipt["arms"]["alg"]
type Write = ReturnType<typeof receiptsFor>[number] & { row: number }
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)
const body = skillContent.slice(skillContent.indexOf("\n---\n") + 5)
const pin = { id: skillName, path: ".opencode/skills/" + skillName + "/SKILL.md",
  sha256: sha256(body), sourceSha256: sha256(skillContent) }
const approval = sha256(JSON.stringify(pin))
const matchesPin = (v: unknown) => Object.entries(pin).every(([k, x]) => object(v)?.[k] === x)

const evidence = generateFabEvidence()
const size = candidates.find(n => evidence.inspection.slice(0, n).filter(x => x.defect).length >= defectFloor)!
const cohort = evidence.inspection.slice(0, size)
function expectedReport(corrected: boolean) {
  return { cohortSize: size, defects: cohort.filter(x => x.defect).length, inspectionRef: evidenceRef("inspection"),
    verifiedClockCorrections: corrected ? matchingCorrections(cohort, evidence["clock-audit"]) : null,
    auditRef: corrected ? evidenceRef("clock-audit") : null, nextAction: corrected ? "replay-clock-join" : "attribute-as-recorded",
    prerequisite: corrected ? "verified-clock-audit" : "independent-clock-audit" }
}

// Only inspect a single leading flat report. Prose cannot supply missing fields or repair the strict answer.
export function inspectAnswer(text: string | undefined, corrected: boolean) {
  const expected = expectedReport(corrected)
  const fields = Object.keys(expected)
  let syntax: "missing" | "valid_json" | "invalid_json" = "missing"
  let candidate: string | undefined
  if (text !== undefined) {
    try { JSON.parse(text); syntax = "valid_json"; candidate = text.trim() }
    catch {
      syntax = "invalid_json"
      const parts = /^\s*(\{[^{}]*\})\s+([^{}\[\]]+)\s*$/.exec(text)
      if (parts && !fields.some(key => parts[2]!.includes(key))) candidate = parts[1]
    }
  }
  let report
  try { report = candidate && object(JSON.parse(candidate)) } catch { /* no unambiguous report */ }
  // Fixture keys are literal identifiers. Reject duplicate keys, escapes and extra fields.
  const keys = candidate?.match(/"[^"\\]*"\s*:/g)
  if (!report || keys?.length !== fields.length || Object.keys(report).length !== fields.length ||
      !fields.every(key => Object.hasOwn(report, key)) || candidate?.includes("\\")) {
    return { syntax, observation: "undecidable" as const, mismatchedFields: null }
  }
  const observed = report
  return { syntax, observation: syntax === "valid_json" ? "strict_object" as const : "leading_object_only" as const,
    mismatchedFields: Object.entries(expected).filter(([key, value]) => observed[key] !== value).map(([key]) => key) }
}

function answerText(row: SessionMessageInfo | undefined) {
  if (row?.type === "assistant" && row.agent === owner && row.finish === "stop")
    return row.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
}

// Single-boundary receipts have independent durable snapshots just before compaction and at run end.
function boundary(arm: Arm) {
  const rows = arm.raw.root ?? []
  const cut = rows.findIndex(row => row.type === "compaction")
  const marker = rows[cut], [record] = arm.compaction.boundaries
  const user = rows.findIndex((row, i) => i > cut && row.type === "user")
  const neutral = rows[user]
  const end = rows.findIndex((row, i) => i > user && row.type === "idle")
  const idle = rows[end], answer = rows[end - 1]
  if (arm.compaction.boundaries.length !== 1 || !record || marker?.type !== "compaction" ||
      marker.reason !== "manual" || marker.status !== "completed" || marker.id !== record.id ||
      rows.filter(row => row.type === "compaction").length !== 1 ||
      neutral?.type !== "user" || neutral.text !== finalInput || idle?.type !== "idle" || idle.outcome !== "succeeded" ||
      end !== rows.length - 1 || !answer || answer.id !== record.afterAnswerId || answerText(answer) === undefined ||
      !rows.slice(cut + 1, user).every(row => row.type === "idle") ||
      rows.slice(user + 1, end).some(row => row.type === "user" || row.type === "synthetic")) return
  const prior = rows.slice(0, cut).map(row => answerText(row) !== undefined).lastIndexOf(true)
  if (prior < 0 || rows[prior]?.id !== record.beforeAnswerId ||
      !rows.slice(prior + 1, cut).every(row => row.type === "idle" && row.outcome === "succeeded")) return
  return { rows, cut, user, end, answer, prior }
}

function calls(rows: SessionMessageInfo[], action: string) {
  return rows.flatMap((message, row) => message.type === "assistant" && message.agent === owner
    ? receiptsFor([message], action).map(call => ({ ...call, row })) : [])
}

function hypothesis(call: Write | undefined) {
  const hypotheses = object(call?.value.decision)?.hypotheses
  if (!Array.isArray(hypotheses)) return
  const matches = hypotheses.map(object).filter(h => h?.id === refutationId)
  return matches.length === 1 ? matches[0] : undefined
}

function auditLedger(arm: Arm, runtime: string, reviewedHash: string | null) {
  const at = boundary(arm)
  if (!at) return { status: "boundary_unverified" } as const
  const { rows, cut, user, end } = at
  const before = rows.slice(0, cut)
  const correction = before.findIndex(row => row.type === "user" && row.text.startsWith(correctionHeader + "\n") &&
    verifiedCorrection(row.text.slice(correctionHeader.length)) === row.text)
  const dispatches = calls(before, "dispatch").filter(x => x.value.ok === true)
  const dispatch = dispatches.length === 1 ? dispatches[0] : undefined
  const work = object(dispatch?.value.work)
  const manifest = work?.manifest_digest
  const jobs = arm.factoryEvidence?.jobs, settled = jobs?.length === 1 ? jobs[0] : undefined
  const submits = arm.factoryAudit.filter(x => x.name === "submit")
  const accepted = submits.length === 1 ? submits[0] : undefined
  const sameJob = !!settled && !!accepted && !!settled.job.jobId && !!settled.idempotencyKey &&
    accepted.accepted === true && accepted.response === "sent" && accepted.job === settled.job.jobId &&
    accepted.submission === settled.idempotencyKey && arm.factoryEvidence?.ledger.acceptedComputations === 1 &&
    settled.job.status === "complete" && digest(manifest) && settled.job.resultDigest === manifest
  function sameWork(value: unknown) {
    const w = object(value)
    return digest(manifest) && digest(work?.work_key) && w?.work_key === work.work_key &&
      w.manifest_digest === manifest && (w.status === "result_recorded" || w.status === "reusable")
  }
  const pinned = matchesPin(arm.gate.policy?.procedure) && arm.skill?.id === pin.id &&
    arm.skill.sha256 === pin.sha256 && arm.skill.sourceSha256 === pin.sourceSha256
  const writes = calls(rows.slice(0, end), "set_next_measurement").filter(call => call.value.ok === true)
  function acknowledged(call: Write) {
    const rev = call.input.expected_decision_revision
    return typeof rev === "number" && Number.isSafeInteger(rev) && rev >= 0 && call.value.decision_revision === rev + 1 &&
      call.value.runtimeSha256 === runtime && typeof call.input.next_action === "string" &&
      call.input.next_action === object(call.value.decision)?.next_action && sameWork(call.value.work)
  }
  const claimWrite = writes.filter(x => x.row < cut && object(x.input.refutation)?.id === refutationId).at(-1)
  const claim = object(claimWrite?.input.refutation)
  const statement = claim?.statement
  function exactSpan(call: Write | undefined) {
    const h = hypothesis(call)
    return typeof statement === "string" && !!statement.trim() && h?.statement === statement && h.status === "refuted" &&
      h.other_evidence_refs === 0 && Array.isArray(h.evidence_refs) && h.evidence_refs.length === 1 && h.evidence_refs[0] === manifest
  }
  const refuted = !!claimWrite && !!dispatch && claimWrite.row > dispatch.row && acknowledged(claimWrite) &&
    claim?.manifest_digest === manifest && exactSpan(claimWrite)
  const statementHash = refuted && typeof statement === "string" ? sha256(statement) : null
  const judgment = statementHash === sha256(refutationStatement) ? "canonical_fixture" :
    statementHash && statementHash === reviewedHash ? "bound_review" : "undecidable"
  function state(through: number, answerRow: number, durable: Arm["decisions"]["durableBefore"], entry: unknown) {
    const history = writes.filter(x => x.row < through)
    const write = history.at(-1)
    const ordered = history.every((x, i) => i === 0 || x.input.expected_decision_revision === history[i - 1]?.value.decision_revision)
    const brief = object(entry), cited = object(brief?.refuted_hypothesis), approved = object(brief?.observed_approval)
    const action = write?.input.next_action
    const actionHash = typeof action === "string" && sha256(action) === durable?.actionSha
    const revision = durable && Number.isSafeInteger(durable.revision) ? durable.revision : null
    const pinMatched = pinned && durable?.procedureSha === pin.sha256 &&
      approved?.procedure_sha256 === pin.sha256 && approved.revision === approval
    const valid = ordered && !!statementHash && digest(runtime) && dispatch?.value.runtimeSha256 === runtime && sameWork(work) && sameJob && correction >= 0 &&
      !!write && acknowledged(write) && actionHash && pinMatched && refuted && exactSpan(write) &&
      durable?.governedManifestObserved === true && revision === write.value.decision_revision &&
      brief?.decision_revision === revision && brief.revision === write.value.revision && brief.schema === 1 &&
      (brief.status === "result_recorded" || brief.status === "reusable") && brief.settled_manifest_digest === manifest &&
      cited?.id === refutationId && cited.manifest_digest === manifest && arm.brief.key === briefKey && arm.brief.readError === null
    const oracle = expectedReport(true)
    const report = inspectAnswer(answerText(rows[answerRow]), true)
    const compared = report.observation === "strict_object" ? report.mismatchedFields : null
    const reportedPair = compared && !compared.includes("nextAction") && !compared.includes("prerequisite")
    let actionEvidence: "explicit_pair" | "contemporaneous_report" | null = null
    if (action === oracle.nextAction + "; prerequisite=" + oracle.prerequisite && reportedPair !== false)
      actionEvidence = "explicit_pair"
    if (action === oracle.nextAction && reportedPair && write && write.row < answerRow)
      actionEvidence = "contemporaneous_report"
    return { status: valid && actionEvidence && judgment !== "undecidable" ? "verified" : "undecidable",
      structurallyVerified: valid, revision, actionHash, pinMatched,
      actionEvidence, acknowledgedRow: write?.row ?? null, writeBeforeCorrection: !!write && correction >= 0 && write.row < correction }
  }
  const prior = state(cut, at.prior, arm.decisions.durableBefore, arm.brief.before)
  const final = state(end, end - 1, arm.decisions.durableAfter, arm.brief.after)
  const continuation = calls(rows.slice(user + 1, end), "procedure")
  const exactProcedureRead = continuation.some(x => {
    const p = object(x.value.procedure)
    return pinned && x.value.ok === true && x.value.runtimeSha256 === runtime && matchesPin(p) && p?.content === body &&
      sha256(p.content) === pin.sha256
  })
  const { finalObservedAtMs, summarySha256 } = arm.compaction
  const projected = pinned && digest(summarySha256) && finalObservedAtMs !== null &&
    arm.compaction.modelWitness.some(row => row.boundary === 1 && row.stage === "continue" &&
      row.summarySha256 === summarySha256 && row.observedAtMs < finalObservedAtMs && row.currentSkill === true)
  return { status: prior.status === "verified" && final.status === "verified" ? "verified_at_both_cuts" : "undecidable",
    beforeCompaction: prior, endOfContinuation: final, sameSettledJobAndManifest: sameJob,
    refutation: statementHash && claimWrite && typeof statement === "string" ? { id: refutationId, writeRow: claimWrite.row,
      decisionRevision: claimWrite.value.decision_revision, utf8Bytes: Buffer.byteLength(statement), sha256: statementHash, judgment } : null,
    exactProcedureRead, systemProjection: projected ? "witnessed" : "unproven" }
}

export function auditHandoff(raw: Uint8Array, review?: unknown) {
  const receipt: Receipt = JSON.parse(Buffer.from(raw).toString("utf8"))
  const receiptSha256 = createHash("sha256").update(raw).digest("hex")
  const external = object(review)
  const replay = object(external?.secondary_offline_replay)
  const reviewedHash = object(external?.live)?.receipt_sha256 === receiptSha256 && replay?.statement_review === "grounded" &&
    replay.refutation_id === refutationId && digest(replay.acknowledged_refutation_text_sha256)
    ? replay.acknowledged_refutation_text_sha256 : null
  if (receipt.schema !== 2 || receipt.caseId !== handoffId || receipt.workload !== "single" || receipt.variant !== "active")
    throw new Error("Expected an active single-boundary handoff receipt")
  const build = receipt.arms.build, rows = build.raw.root ?? []
  const start = rows.findIndex(row => row.type === "user" && row.text === initialInput)
  const first = rows.slice(start + 1).find(row => row.type === "idle" || row.type === "user" || answerText(row) !== undefined)
  return { kind: "secondary_offline_handoff_audit", receiptSha256, alg: auditLedger(receipt.arms.alg, receipt.runtime.bundleSha256, reviewedHash),
    buildInitial: inspectAnswer(start >= 0 ? answerText(first) : undefined, false),
    buildContinuation: inspectAnswer(answerText(boundary(build)?.answer), true) }
}

if (import.meta.main) {
  const [file, flag, review, ...rest] = process.argv.slice(2)
  if (!file || rest.length || (flag !== undefined && (flag !== "--review" || !review)))
    throw new Error("Usage: bun handoff-audit.ts <receipt.json> [--review <review.json>]")
  try {
    const result = auditHandoff(await readFile(file), review ? JSON.parse(await readFile(review, "utf8")) : undefined)
    console.log(JSON.stringify(result, null, 2))
  }
  catch { console.error("Handoff audit could not read a supported receipt"); process.exitCode = 1 }
}

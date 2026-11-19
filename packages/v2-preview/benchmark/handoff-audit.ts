import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { SessionMessageInfo } from "@opencode/client"
import { owner, receiptsFor, toolCalls } from "../acceptance/host.ts"
import { sha256 } from "../acceptance/runtime.ts"
import { evidenceRef, generateFabEvidence } from "./case.ts"
import { briefKey, candidates, checkerInput, correctionHeader, defectFloor, finalInput, handoffId, initialInput,
  jsonObject, matchingCorrections, object, refutationId, refutationStatement, skillContent, skillName,
  verifiedCorrection, type HandoffVariant } from "./handoff-case.ts"
import { checkerName, type observeAlgDecision } from "./host.ts"
import type { startFactory } from "../acceptance/service.ts"
import type { WorkbenchSnapshot } from "./workbench.ts"
import type { runHandoff } from "./handoff.ts"
import { continuationSkillDelivery } from "./skill-delivery.ts"

type Receipt = Awaited<ReturnType<typeof runHandoff>>
type Arm = Receipt["arms"]["alg"]
type Write = ReturnType<typeof receiptsFor>[number] & { row: number }
type Factory = ReturnType<typeof startFactory>
type DurableDecision = ReturnType<typeof observeAlgDecision>
type DecisionReadback = { durable: DurableDecision; brief: unknown }
type DecisionBoundary = {
  id: string | null; beforeAnswerId: string | null; afterAnswerId: string | null
  decisionReadback?: { before?: DecisionReadback; after?: DecisionReadback }
}
type DecisionEvidence = {
  raw: { root: SessionMessageInfo[] | null; checker: SessionMessageInfo[] | null }
  checkerId?: string
  skill?: Omit<typeof pin, "path">
  skillAvailableAtContinue: boolean | null
  ledger: WorkbenchSnapshot
  gate: { policy: { procedure: typeof pin } | null }
  factoryEvidence: Awaited<ReturnType<Factory["evidence"]>> | null
  factoryAudit: Factory["audit"]
  compaction: { boundaries: DecisionBoundary[] }
  decisions: { durableBefore: DurableDecision; durableAfter: DurableDecision }
  brief: { key: string; before: unknown; after: unknown; readError: string | null }
}
const digest = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)
const body = skillContent.slice(skillContent.indexOf("\n---\n") + 5)
const pin = { id: skillName, path: ".opencode/skills/" + skillName + "/SKILL.md",
  sha256: sha256(body), sourceSha256: sha256(skillContent) }
const approval = sha256(JSON.stringify(pin))
const matchesPin = (v: unknown) => Object.entries(pin).every(([k, x]) => object(v)?.[k] === x)

const evidence = generateFabEvidence()
const size = candidates.find(n => evidence.inspection.slice(0, n).filter(x => x.defect).length >= defectFloor)!
const cohort = evidence.inspection.slice(0, size)
function expectedReport(corrected: boolean, revoked = false) {
  return { cohortSize: size, defects: cohort.filter(x => x.defect).length, inspectionRef: evidenceRef("inspection"),
    verifiedClockCorrections: corrected ? matchingCorrections(cohort, evidence["clock-audit"]) : null,
    auditRef: corrected ? evidenceRef("clock-audit") : null,
    nextAction: revoked ? null : corrected ? "replay-clock-join" : "attribute-as-recorded",
    prerequisite: revoked ? "current-approved-procedure" : corrected ? "verified-clock-audit" : "independent-clock-audit" }
}

// Only inspect a single leading flat report. Prose cannot supply missing fields or repair the strict answer.
export function inspectAnswer(text: string | undefined, corrected: boolean, revoked = false) {
  const expected = expectedReport(corrected, revoked)
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

function answerText(row: SessionMessageInfo | undefined, agent: string = owner) {
  if (row?.type === "assistant" && row.agent === agent && row.finish === "stop")
    return row.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
}

function boundary(arm: DecisionEvidence, record = arm.compaction.boundaries[0]) {
  const rows = arm.raw.root ?? []
  if (!record?.id) return
  const cut = rows.findIndex(row => row.type === "compaction" && row.id === record.id)
  const marker = rows[cut]
  const user = rows.findIndex((row, i) => i > cut && row.type === "user")
  const neutral = rows[user]
  const end = rows.findIndex((row, i) => i > user && row.type === "idle")
  const idle = rows[end], answer = rows[end - 1]
  if (marker?.type !== "compaction" || marker.reason !== "manual" || marker.status !== "completed" ||
      neutral?.type !== "user" || neutral.text !== finalInput || idle?.type !== "idle" || idle.outcome !== "succeeded" ||
      answer?.id !== record.afterAnswerId || answerText(answer) === undefined ||
      !rows.slice(cut + 1, user).every(row => row.type === "idle" || row.type === "system") ||
      rows.slice(user + 1, end).some(row => row.type === "user" || row.type === "synthetic" || row.type === "compaction")) return
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

const revisionNumber = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0
const settledStatus = (v: unknown) => v === "result_recorded" || v === "reusable"

function observedLookup(rows: SessionMessageInfo[], agent: string, scope: "root" | "checker",
  source: "inspection" | "clock-audit", count: number, ledger: WorkbenchSnapshot | undefined) {
  const ref = evidenceRef(source)
  const admissions = ledger?.receipts.filter(receipt => receipt.scope === scope && receipt.outcome === "admitted" &&
    receipt.queryId && receipt.pages.length === 1 && receipt.evidenceRefs.length === 1 && receipt.evidenceRefs[0] === ref &&
    receipt.pages[0]?.source === source && receipt.pages[0].offset === 0 && receipt.pages[0].rows === count &&
    receipt.pages[0].totalRows === evidence[source].length)
  return !!admissions?.some(({ queryId }) => rows.some(row => row.type === "assistant" && row.agent === agent &&
    toolCalls([row]).some(call => {
      if (call.name !== (scope === "root" ? "evidence_lookup_pages" : "audit_lookup_pages") ||
          call.state.status !== "completed") return false
      const result = jsonObject(call.state.content.find(part => part.type === "text")?.text ?? "")
      return result?.status === "ok" && result.op === "lookup" && result.queryId === queryId &&
        Array.isArray(result.pages) && result.pages.length === 1 && result.pages.some(value => {
          const page = object(value)
          return page?.source === source && page.evidenceRef === ref && page.offset === 0 &&
            page.totalRows === evidence[source].length && Array.isArray(page.rows) && page.rows.length === count &&
            evidence[source].slice(0, count).every((expected, i) => {
              const actual = object((page.rows as unknown[])[i])
              return actual && Object.keys(actual).length === Object.keys(expected).length &&
                Object.entries(expected).every(([key, val]) => actual[key] === val)
            })
        })
    })))
}

function correctionDelivery(arm: DecisionEvidence, rows: SessionMessageInfo[]) {
  const child = arm.raw.checker ?? []
  const prompt = child[0], idle = child.at(-1), answer = child.at(-2)
  const checkerText = answerText(answer, checkerName)
  const correction = checkerText && verifiedCorrection(checkerText)
  if (!arm.checkerId || !correction || prompt?.type !== "user" || prompt.text !== checkerInput ||
      idle?.type !== "idle" || idle.outcome !== "succeeded" || !revisionNumber(idle.time?.created) ||
      !observedLookup(child.slice(1, -2), checkerName, "checker", "clock-audit", evidence["clock-audit"].length, arm.ledger)) {
    return { explicit: -1, observed: -1 }
  }
  const explicit = rows.findIndex(row => row.type === "user" && row.text === correction && row.time?.created >= idle.time.created)
  const synthetic = rows.findIndex(row => {
    if (row.type !== "synthetic" || !(row.time?.created >= idle.time.created)) return false
    const metadata = object(row.metadata)
    if (metadata?.source !== "subagent" || metadata.childID !== arm.checkerId ||
        metadata.agent !== checkerName || metadata.state !== "completed") return false
    const payload = /^<subagent [^\r\n]*>\r?\n([\s\S]*)\r?\n<\/subagent>$/.exec(row.text)?.[1]
    return !!payload && verifiedCorrection(payload) === correction
  })
  return { explicit, observed: explicit < 0 ? synthetic : synthetic < 0 ? explicit : Math.min(explicit, synthetic) }
}

function pinnedProcedure(arm: DecisionEvidence) {
  return matchesPin(arm.gate.policy?.procedure) && arm.skill?.id === pin.id &&
    arm.skill.sha256 === pin.sha256 && arm.skill.sourceSha256 === pin.sourceSha256
}

function reportedPair(row: SessionMessageInfo | undefined, revoked = false) {
  const report = inspectAnswer(answerText(row), true, revoked)
  if (report.observation !== "strict_object" || !report.mismatchedFields) return null
  return !report.mismatchedFields.includes("nextAction") && !report.mismatchedFields.includes("prerequisite")
}

export function gradeHandoffDecisions(arm: DecisionEvidence, runtime: string, variant: HandoffVariant, reviewedHash: string | null = null) {
  const records = arm.compaction.boundaries
  const locations = records.map(record => boundary(arm, record))
  const first = locations[0], last = locations.at(-1)
  if (!first || !last || last.end !== last.rows.length - 1 ||
      locations.some((at, i) => !at || (i > 0 && at.prior <= (locations[i - 1]?.end ?? -1))) ||
      last.rows.filter(row => row.type === "compaction").length !== locations.length)
    return { status: "boundary_unverified" as const, checks: {
      correctedCheckpoint: false, durableCorrectedState: false, correctedRevision: false,
      factsRetained: false, refutationVerified: false, liveApproval: false,
    } }
  const { rows, cut } = first
  const withdrawalCut = last.cut
  const { explicit, observed } = correctionDelivery(arm, rows.slice(0, cut))
  const dispatches = calls(rows.slice(0, last.end), "dispatch").filter(x => x.value.ok === true)
  const dispatch = dispatches.length === 1 ? dispatches[0] : undefined
  const work = object(dispatch?.value.work)
  const manifest = work?.manifest_digest
  const jobs = arm.factoryEvidence?.jobs, settled = jobs?.length === 1 ? jobs[0] : undefined
  const submits = arm.factoryAudit?.filter(x => x.name === "submit") ?? []
  const accepted = submits.length === 1 ? submits[0] : undefined
  function sameWork(value: unknown) {
    const w = object(value)
    return digest(manifest) && digest(work?.work_key) && w?.work_key === work.work_key &&
      w.manifest_digest === manifest && settledStatus(w.status)
  }
  const sameJob = !!dispatch && dispatch.value.runtimeSha256 === runtime && sameWork(work) &&
    !!settled && !!accepted && !!settled.job.jobId && !!settled.idempotencyKey &&
    accepted.accepted === true && accepted.response === "sent" && accepted.job === settled.job.jobId &&
    accepted.submission === settled.idempotencyKey && arm.factoryEvidence?.ledger.acceptedComputations === 1 &&
    settled.job.status === "complete" && settled.job.resultDigest === manifest

  const ownerCalls = rows.slice(0, last.end)
  // The host may complete parallel calls in a different order from their presentation.
  // Successful CAS revisions determine their serialization within one assistant row.
  const writes = calls(ownerCalls, "set_next_measurement").filter(call => call.value.ok === true).sort((a, b) => {
    const left = a.value.decision_revision, right = b.value.decision_revision
    return a.row - b.row || (revisionNumber(left) && revisionNumber(right) ? left - right : 0)
  })
  const creates = calls(ownerCalls, "create").filter(call => call.value.ok === true)
  const pinned = pinnedProcedure(arm)
  const oracle = expectedReport(true)

  function acknowledged(call: Write) {
    const rev = call.input.expected_decision_revision, nextRev = call.value.decision_revision
    const action = call.input.next_action
    return revisionNumber(rev) && revisionNumber(nextRev) && nextRev === rev + 1 &&
      revisionNumber(call.value.revision) && digest(runtime) && call.value.runtimeSha256 === runtime &&
      typeof action === "string" && !!action.trim() && action === object(call.value.decision)?.next_action
  }

  function state(through: number, answerRow: number, durable: DurableDecision, entry: unknown, revoked: boolean) {
    const history = writes.filter(x => x.row < through)
    const write = history.at(-1)
    const ids = new Set<string>()
    const priorCreate = creates.filter(x => x.row < through).at(-1)
    const ordered = history.every((x, i) => {
      const prior = history[i - 1] ?? priorCreate
      if (!acknowledged(x) || ids.has(x.id) || (prior && (prior.row > x.row || (i === 0 && prior.row === x.row) ||
          prior.value.runtimeSha256 !== runtime || x.input.expected_decision_revision !== prior.value.decision_revision))) return false
      ids.add(x.id)
      return true
    })
    const brief = object(entry), cited = object(brief?.refuted_hypothesis), approved = object(brief?.observed_approval)
    const action = write?.input.next_action
    const actionHash = typeof action === "string" && sha256(action) === durable?.actionSha
    const revision = revisionNumber(durable?.revision) ? durable.revision : null
    const pinMatched = pinned && durable?.procedureSha === pin.sha256 &&
      (revoked ? brief?.observed_approval === null : approved?.procedure_sha256 === pin.sha256 && approved.revision === approval)
    const boundRevision = !!write && ordered && actionHash && revision === write.value.decision_revision &&
      brief?.schema === 1 && brief.decision_revision === revision && revisionNumber(brief.revision) &&
      revisionNumber(write.value.revision) && brief.revision >= write.value.revision &&
      arm.brief.key === briefKey && arm.brief.readError === null

    const afterDelivery = !!write && observed >= 0 && write.row > observed &&
      rows[write.row]!.time?.created >= rows[observed]!.time?.created &&
      candidates.filter(limit => limit <= size).every(limit =>
        observedLookup(rows.slice(0, write.row), owner, "root", "inspection", limit, arm.ledger))
    const pair = reportedPair(rows[answerRow], revoked)
    let actionEvidence: "explicit_pair" | "contemporaneous_report" | null = null
    if (action === oracle.nextAction + "; prerequisite=" + oracle.prerequisite && (revoked ? pair === true : pair !== false))
      actionEvidence = "explicit_pair"
    if (action === oracle.nextAction && pair && write && write.row < answerRow) {
      // A report from a later turn cannot supply the prerequisite omitted by a bare write.
      const sameTurnAnswer = rows.slice(write.row + 1, through).find(row =>
        answerText(row) !== undefined || row.type === "user" || row.type === "synthetic" ||
        row.type === "idle" || row.type === "compaction")
      if (reportedPair(sameTurnAnswer) === true) actionEvidence = "contemporaneous_report"
    }
    const actionVerified = boundRevision && pinMatched && afterDelivery && !!actionEvidence && !!write && write.row < answerRow &&
      (!revoked || write.row < withdrawalCut)

    const claimWrite = history.filter(x => object(x.input.refutation)?.id === refutationId).at(-1)
    const claim = object(claimWrite?.input.refutation), statement = claim?.statement
    const retained = !!claimWrite && typeof statement === "string" && !!statement.trim() &&
      history.slice(history.indexOf(claimWrite)).every(call => {
        const h = hypothesis(call)
        return h?.statement === statement && h.status === "refuted" && h.other_evidence_refs === 0 &&
          Array.isArray(h.evidence_refs) && h.evidence_refs.length === 1 && h.evidence_refs[0] === manifest && sameWork(call.value.work)
      })
    const factsRetained = boundRevision && sameJob && !!dispatch && !!claimWrite && claimWrite.row > dispatch.row &&
      (!revoked || claimWrite.row < withdrawalCut) && claim?.manifest_digest === manifest && retained &&
      durable?.governedManifestObserved === true && settledStatus(brief?.status) && brief?.settled_manifest_digest === manifest &&
      cited?.id === refutationId && cited.manifest_digest === manifest
    const refutation = factsRetained && typeof statement === "string" && claimWrite ? {
      id: refutationId, writeRow: claimWrite.row, decisionRevision: claimWrite.value.decision_revision,
      utf8Bytes: Buffer.byteLength(statement), sha256: sha256(statement),
      judgment: statement === refutationStatement ? "canonical_fixture" as const :
        sha256(statement) === reviewedHash ? "bound_review" as const : "undecidable" as const,
    } : null
    const valid = actionVerified && factsRetained
    return { status: valid && refutation && refutation.judgment !== "undecidable" ? "verified" as const : "undecidable" as const,
      structurallyVerified: valid, revision, actionHash, pinMatched, boundRevision, actionVerified, factsRetained, refutation,
      actionEvidence, acknowledgedRow: write?.row ?? null, writeBeforeCorrection: !!write && explicit >= 0 && write.row < explicit }
  }

  const revoked = variant === "revoked"
  const prior = state(cut, first.prior, arm.decisions.durableBefore, arm.brief.before, false)
  const final = state(last.end, last.end - 1, arm.decisions.durableAfter, arm.brief.after, revoked)
  const cuts = locations.map((at, index) => {
    const readback = records[index]?.decisionReadback
    const isFirst = index === 0, isLast = index === locations.length - 1
    const before = readback?.before, after = readback?.after
    return {
      index: index + 1,
      beforeCompaction: at && before ? state(at.cut, at.prior, before.durable, before.brief, false) : isFirst ? prior : null,
      endOfContinuation: at && after ? state(at.end, at.end - 1, after.durable, after.brief, isLast && revoked) : isLast ? final : null,
    }
  })
  const boundarySnapshots = cuts.every(x => x.beforeCompaction && x.endOfContinuation) ? "complete" : "incomplete"
  const states = cuts.flatMap(x => [x.beforeCompaction, x.endOfContinuation])
  const liveApproval = states.every(x => x?.pinMatched === true) && arm.skillAvailableAtContinue === !revoked
  const refutationVerified = states.every(x => x?.refutation && x.refutation.judgment !== "undecidable")
  const checks = {
    correctedCheckpoint: cuts.every(x => x.beforeCompaction?.actionVerified === true),
    durableCorrectedState: states.every(x => x?.structurallyVerified === true) && liveApproval,
    correctedRevision: states.every(x => x?.actionVerified === true) && liveApproval,
    factsRetained: states.every(x => x?.factsRetained === true),
    refutationVerified,
    liveApproval,
  }
  return { status: states.every(x => x?.status === "verified") && liveApproval ?
    "verified_at_both_cuts" as const : "undecidable" as const,
    beforeCompaction: cuts[0]?.beforeCompaction ?? prior, endOfContinuation: cuts.at(-1)?.endOfContinuation ?? final,
    sameSettledJobAndManifest: sameJob, refutation: cuts[0]?.beforeCompaction?.refutation ?? null, boundarySnapshots, cuts, checks }
}

function auditLedger(arm: Arm, runtime: string, reviewedHash: string | null) {
  const grade = gradeHandoffDecisions(arm, runtime, "active", reviewedHash)
  const at = boundary(arm)
  if (!at || grade.status === "boundary_unverified") return { status: "boundary_unverified" } as const
  const { rows, user, end } = at
  const { beforeCompaction: prior, endOfContinuation: final, sameSettledJobAndManifest: sameJob, refutation } = grade
  const pinned = pinnedProcedure(arm)
  const continuation = calls(rows.slice(user + 1, end), "procedure")
  const exactProcedureRead = continuation.some(x => {
    const p = object(x.value.procedure)
    return pinned && x.value.ok === true && x.value.runtimeSha256 === runtime && matchesPin(p) && p?.content === body &&
      sha256(p.content) === pin.sha256
  })
  const { finalObservedAtMs, summarySha256 } = arm.compaction
  const witnesses = arm.compaction.modelWitness.filter(row => row.boundary === 1 && row.stage === "continue")
  // Old receipts recorded a projection Boolean but discarded the message envelopes.
  const hasRoles = witnesses.length > 0 && witnesses.every(row => Number.isSafeInteger(row.requestId) &&
    row.skillDelivery && Array.isArray(row.skillDelivery.roles) && Array.isArray(row.skillDelivery.projectionRoles))
  const summaries = arm.requests?.filter(row => row.role === "root" && row.kind === "summary")
  const summaryRequest = summaries?.length === 1 && summaries[0]?.summaryResponseSha256 === summarySha256 ? summaries[0] : null
  const delivery = pinned && hasRoles && summaryRequest ? continuationSkillDelivery(witnesses,
    arm.requests.filter(row => row.id > summaryRequest.id), summarySha256, finalObservedAtMs ?? undefined, pin.sha256) : null
  return { status: grade.status, beforeCompaction: prior, endOfContinuation: final, sameSettledJobAndManifest: sameJob, refutation,
    exactProcedureRead, skillDelivery: delivery,
    systemProjection: delivery?.complete && delivery.projectionRoles.includes("system") ? "witnessed" : "unproven" }
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

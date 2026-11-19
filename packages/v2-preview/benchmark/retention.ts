import type { receiptsFor } from "../acceptance/host.ts"
import type { ServiceOperation, startFactory } from "../acceptance/service.ts"
import { caseId, evidenceRef, generateFabEvidence } from "./case.ts"
import { candidates, correctionHeader, defectFloor, jsonObject, matchingCorrections, object,
  refutationId, verifiedCorrection, type HandoffVariant } from "./handoff-case.ts"
import type { Turn } from "./host.ts"
import type { WorkbenchReceipt, WorkbenchSnapshot } from "./workbench.ts"

type Text = Turn["text"] | null
type Receipt = ReturnType<typeof receiptsFor>[number]
type Phase = "initial" | "corrected" | "final"
type Authority = boolean | null
type Snapshot = WorkbenchSnapshot | null
type FactoryEvidence = Awaited<ReturnType<ReturnType<typeof startFactory>["evidence"]>>

export type RetentionInput = {
  variant: HandoffVariant
  initial: Text
  corrected: Text
  final: Text
  /** Canonical verified correction text actually delivered to the root turn. */
  correction: Text
  snapshots: {
    afterInitial: Snapshot
    afterCorrection: Snapshot
    beforeContinue: Snapshot
    afterContinue: Snapshot
  }
  /** Current procedure independently observed at each decision. Null denotes unavailable observation. */
  authority?: Partial<Record<Phase, Authority>>
  /** Use for repeated compactions to supply the actual adjacent pre-compaction answer. */
  preCompaction?: {
    answer: Text
    snapshot: WorkbenchSnapshot
    authority: Authority
  }
  /** Supply only on observing completed compaction before the neutral continuation. */
  compactionObserved?: boolean
  /** Completed host tool receipts scoped to each owner turn, e.g. from receiptsFor. */
  tools?: Partial<Record<Phase, readonly Receipt[]>>
  factory?: {
    evidence: FactoryEvidence | null
    /** Copy at end of initial/corrected turns, before continuation, and after continuation. */
    afterInitial: readonly ServiceOperation[] | null
    afterCorrection: readonly ServiceOperation[] | null
    beforeContinue: readonly ServiceOperation[] | null
    afterContinue: readonly ServiceOperation[] | null
  }
  /** Independently read keyed brief values. Omit an unread value; use null for observed absence. */
  durableBrief?: { before?: unknown; after?: unknown }
  /** Optional offline semantic adjudication of the statement in the identified corrected tool receipt. */
  refutationReview?: { receiptId: string; verdict: "grounded" | "wrong" | "unclear" }
  /** Request-side observations made before the answer. These are exposure measurements only. */
  exposure?: {
    summary?: boolean | null
    factualRefutation?: boolean | null
    pendingMeasurement?: boolean | null
    currentSkill?: boolean | null
  }
}

const evidence = generateFabEvidence()
const size = candidates.find(limit => evidence.inspection.slice(0, limit).filter(row => row.defect).length >= defectFloor)!
const cohort = evidence.inspection.slice(0, size)
const inspectionRef = evidenceRef("inspection")
const auditRef = evidenceRef("clock-audit")
const corrections = matchingCorrections(cohort, evidence["clock-audit"])
const fields = {
  cohortSize: "fact", defects: "fact", verifiedClockCorrections: "fact",
  inspectionRef: "citation", auditRef: "citation", nextAction: "action", prerequisite: "action",
} as const
type Field = keyof typeof fields
const fieldNames = Object.keys(fields) as Field[]
type Value = number | string | null
type Expectation = { value: Value; supported: boolean }
type Assessment = "supported_correct" | "correct_unsupported" | "wrong" | "unavailable" | "inapplicable"
type Invalidation = "correction" | "revoked" | "authority_changed"

function samePages(left: WorkbenchReceipt, right: WorkbenchReceipt) {
  return left.scope === right.scope && left.evidenceRefs.length === right.evidenceRefs.length &&
    left.pages.length === right.pages.length && left.pages.every((page, i) => {
      const other = right.pages[i]
      return other && page.source === other.source && page.offset === other.offset && page.rows === other.rows &&
        page.totalRows === other.totalRows && left.evidenceRefs[i] === right.evidenceRefs[i]
    })
}

function validLedger(snapshot: Snapshot): snapshot is WorkbenchSnapshot {
  if (!snapshot || snapshot.caseId !== caseId("positive") || snapshot.calls !== snapshot.receipts.length) return false
  const admitted = new Map<string, WorkbenchReceipt>()
  let denied = 0
  for (const row of snapshot.receipts) {
    if (row.outcome === "denied") denied++
    if (row.outcome === "admitted") {
      if (!row.queryId || admitted.has(row.queryId)) return false
      admitted.set(row.queryId, row)
    }
    if (row.outcome === "replay") {
      const previous = row.queryId && admitted.get(row.queryId)
      if (!previous || !samePages(previous, row)) return false
    }
  }
  return admitted.size === snapshot.acceptedQueries && admitted.size <= snapshot.maxAcceptedQueries &&
    denied === snapshot.deniedQueries
}

function ledgerDelta(before: Snapshot, after: Snapshot) {
  if (!validLedger(before) || !validLedger(after) || after.maxAcceptedQueries !== before.maxAcceptedQueries ||
      before.calls > after.calls || !before.receipts.every((row, i) => {
        const other = after.receipts[i]!
        return row.outcome === other.outcome && row.queryId === other.queryId && samePages(row, other)
      })) return null
  const rows = after.receipts.slice(before.calls)
  const settled = new Set(before.receipts.filter(row => row.outcome === "admitted").map(row => row.queryId))
  return {
    newQueries: rows.filter(row => row.outcome === "admitted").length,
    priorCacheReads: rows.filter(row => row.outcome === "replay" && settled.has(row.queryId)).length,
    newQueryCacheReads: rows.filter(row => row.outcome === "replay" && !settled.has(row.queryId)).length,
    denied: rows.filter(row => row.outcome === "denied").length,
    maps: rows.filter(row => row.outcome === "mapped").length,
  }
}

function factoryDelta(before: readonly ServiceOperation[] | null, after: readonly ServiceOperation[] | null,
  evidence: FactoryEvidence | null, settledJobId: string | undefined) {
  if (!before || !after || before.length > after.length || !before.every((row, i) => {
    const other = after[i]!
    return row.name === other.name && row.job === other.job && row.project === other.project &&
      row.submission === other.submission && row.response === other.response && row.accepted === other.accepted &&
      row.maxRows === other.maxRows && row.rows === other.rows
  })) return null
  const operations = after.slice(before.length)
  const priorSubmissions = new Set(before.filter(row => row.name === "submit").map(row => row.submission))
  const submissions = new Set(operations.filter(row => row.name === "submit").map(row => row.submission))
  return {
    submitCalls: operations.filter(row => row.name === "submit").length,
    newComputations: evidence?.jobs.filter(row =>
      submissions.has(row.idempotencyKey) && !priorSubmissions.has(row.idempotencyKey)).length ?? null,
    successfulResultPageReads: operations.filter(row => row.name === "read" && row.response === "sent").length,
    settledManifestPageReads: settledJobId === undefined ? null : operations.filter(row =>
      row.name === "read" && row.response === "sent" && row.job === settledJobId).length,
  }
}

function settledManifest(receipts: readonly Receipt[] | undefined) {
  const dispatch = receipts?.filter(row => row.input.action === "dispatch" && row.value.ok === true)
  const work = dispatch?.length === 1 ? object(dispatch[0]!.value.work) : undefined
  if (!work || (work.status !== "result_recorded" && work.status !== "reusable") ||
      typeof work.work_key !== "string" || !work.work_key || typeof work.manifest_digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(work.manifest_digest)) return undefined
  return { workKey: work.work_key, digest: work.manifest_digest }
}

function distinctReceipts(receipts: readonly Receipt[]) {
  return [...new Map(receipts.map(row => [row.id, row])).values()]
}

function manifestReferences(receipts: readonly Receipt[] | undefined, manifest: ReturnType<typeof settledManifest>) {
  if (!receipts || !manifest) return null
  return distinctReceipts(receipts).filter(({ input, value }) => {
    const reuse = object(object(value.preQuery)?.reuse)
    return (input.action === "admit" || input.action === "reconcile") && value.ok === true &&
      reuse?.kind === "settled_manifest" && reuse.manifest_digest === manifest.digest && reuse.work_key === manifest.workKey
  }).length
}

function supportsPage(receipt: WorkbenchReceipt, scope: WorkbenchReceipt["scope"],
  source: "inspection" | "clock-audit", rows: number) {
  const index = receipt.pages.findIndex(page => page.source === source && page.offset === 0 &&
    page.rows === rows && page.totalRows === evidence[source].length)
  return receipt.outcome === "admitted" && receipt.scope === scope && index >= 0 &&
    receipt.evidenceRefs[index] === evidenceRef(source)
}

function expectations(snapshot: Snapshot, audited: boolean, authority: Authority): Record<Field, Expectation | null> {
  const inspection = validLedger(snapshot) && candidates.filter(limit => limit <= size).every(limit =>
    snapshot.receipts.some(row => supportsPage(row, "root", "inspection", limit)))
  const audit = audited && validLedger(snapshot) &&
    snapshot.receipts.some(row => supportsPage(row, "checker", "clock-audit", evidence["clock-audit"].length))
  const actionSupport = inspection && (!audited || audit)
  return {
    cohortSize: { value: size, supported: inspection },
    defects: { value: cohort.filter(row => row.defect).length, supported: inspection },
    inspectionRef: { value: inspectionRef, supported: inspection },
    verifiedClockCorrections: audited ? { value: corrections, supported: inspection && audit } : null,
    auditRef: audited ? { value: auditRef, supported: audit } : null,
    nextAction: authority === null ? null : authority === false ? { value: null, supported: true } :
      { value: audited && corrections > 0 ? "replay-clock-join" : "attribute-as-recorded", supported: actionSupport },
    prerequisite: authority === null ? null : authority === false ? { value: "current-approved-procedure", supported: true } :
      { value: audited && corrections > 0 ? "verified-clock-audit" : "independent-clock-audit", supported: actionSupport },
  }
}

function assess(answer: ReturnType<typeof jsonObject>, field: Field, expected: Expectation | null): Assessment {
  if (!expected) return "inapplicable"
  if (!answer || !Object.hasOwn(answer, field)) return "unavailable"
  if (answer[field] !== expected.value) return "wrong"
  return expected.supported ? "supported_correct" : "correct_unsupported"
}

function scoreBoundary(beforeText: Text, afterText: Text, before: ReturnType<typeof expectations>,
  after: ReturnType<typeof expectations>, observed: boolean, authorityChange: Invalidation | null) {
  const earlier = beforeText === null ? undefined : jsonObject(beforeText)
  const later = afterText === null ? undefined : jsonObject(afterText)
  const obligations = fieldNames.map(field => {
    const previous = assess(earlier, field, before[field])
    const current = assess(later, field, after[field])
    const authorityDependent = fields[field] === "action"
    const invalidatedBy = observed && authorityDependent && previous === "supported_correct" &&
      authorityChange && after[field] && before[field]?.value !== after[field]?.value
      ? authorityChange : null
    const eligibility = !observed ? "boundary_unobserved" : invalidatedBy ? "invalidated" :
      previous !== "supported_correct" ? "baseline_ineligible" : !after[field] ? "postcondition_unverified" : "eligible"
    const outcome = eligibility !== "eligible" ? null : current === "supported_correct" ? "retained" :
      current === "wrong" ? "lost_wrong" : current === "unavailable" ? "unavailable" : "support_unverified"
    return { field, kind: fields[field], previous, current, eligibility, invalidatedBy, outcome }
  })
  const eligible = obligations.filter(row => row.eligibility === "eligible").length
  const retained = obligations.filter(row => row.outcome === "retained").length
  const lostWrong = obligations.filter(row => row.outcome === "lost_wrong").length
  const unavailable = obligations.filter(row => row.outcome === "unavailable").length
  const supportUnverified = obligations.filter(row => row.outcome === "support_unverified").length
  return {
    observed, obligations, eligible, assessed: retained + lostWrong, retained, lostWrong, unavailable, supportUnverified,
    // Partial identification over all eligible items. Missing and unsupported answers leave loss unresolved.
    lossBounds: eligible === 0 ? null : [lostWrong / eligible, (lostWrong + unavailable + supportUnverified) / eligible],
  }
}

function durableRefutation(input: RetentionInput, manifest: ReturnType<typeof settledManifest>, observed: boolean) {
  const prior = input.durableBrief?.before
  const later = input.durableBrief?.after
  const corrected = input.tools?.corrected
  const matchingReceipts = !manifest || !corrected ? null : distinctReceipts(corrected).filter(({ input, value }) => {
    const claim = object(input.refutation)
    const hypotheses = object(value.decision)?.hypotheses
    return input.action === "set_next_measurement" && value.ok === true &&
      object(value.work)?.manifest_digest === manifest.digest && claim?.id === refutationId &&
      typeof claim.statement === "string" && !!claim.statement.trim() && claim.manifest_digest === manifest.digest &&
      Array.isArray(hypotheses) && hypotheses.some(entry => {
        const hypothesis = object(entry)
        return hypothesis?.id === refutationId && hypothesis.statement === claim.statement &&
          hypothesis.status === "refuted" && Array.isArray(hypothesis.evidence_refs) &&
          hypothesis.evidence_refs.includes(manifest.digest)
      })
  })
  function matches(value: unknown) {
    const brief = object(value)
    const refutation = object(brief?.refuted_hypothesis)
    return brief?.settled_manifest_digest === manifest?.digest && refutation?.id === refutationId &&
      refutation.manifest_digest === manifest?.digest
  }
  const before = prior === undefined || !manifest ? null : matches(prior)
  const after = later === undefined || !manifest ? null : matches(later)
  const recorded = matchingReceipts === null ? null : matchingReceipts.length === 1
  const receiptId = recorded ? matchingReceipts![0]!.id : null
  const semanticVerdict = receiptId !== null && input.refutationReview?.receiptId === receiptId ?
    input.refutationReview.verdict : null
  const eligible = observed && recorded === true && before === true
  return { recorded, receiptId, semanticVerdict, before, after, eligible, outcome: !eligible ? null :
    after === null ? "unavailable" : after ? "retained" : "lost" }
}

/** Post-run evaluator. Keep inputs and results on the benchmark side of the prompt boundary. */
export function scoreRetention(input: RetentionInput) {
  const { afterInitial, afterCorrection, beforeContinue, afterContinue } = input.snapshots
  const delivered = input.correction?.startsWith(correctionHeader + "\n") === true &&
    verifiedCorrection(input.correction.slice(correctionHeader.length)) === input.correction
  const hasCorrectionTurn = input.correction !== null || input.corrected !== null
  const initialAuthority = input.authority?.initial ?? null
  const correctedAuthority = input.authority?.corrected ?? null
  const finalAuthority = input.authority?.final ?? null
  const correctionObserved = delivered
  const continuationObserved = input.compactionObserved === true && beforeContinue !== null
  const initialExpected = expectations(afterInitial, false, initialAuthority)
  const correctedExpected = expectations(afterCorrection, delivered, correctedAuthority)
  const finalExpected = expectations(afterContinue, delivered, finalAuthority)
  const manifest = settledManifest(input.tools?.initial)
  const jobs = input.factory?.evidence?.jobs.filter(({ job }) => job.resultDigest === manifest?.digest)
  const jobId = jobs?.length === 1 ? jobs[0]!.job.jobId : undefined
  const preCompaction = input.preCompaction
  const baseline = preCompaction ? "preCompaction" : hasCorrectionTurn ? "corrected" : "initial"
  const baselineAuthority = preCompaction ? preCompaction.authority : baseline === "initial" ? initialAuthority : correctedAuthority
  const baselineExpected = preCompaction ? expectations(preCompaction.snapshot, delivered, preCompaction.authority) :
    baseline === "initial" ? initialExpected : correctedExpected
  const baselineText = preCompaction ? preCompaction.answer : baseline === "initial" ? input.initial : input.corrected
  const baselineLedger = preCompaction ? preCompaction.snapshot : baseline === "initial" ? afterInitial : afterCorrection
  const revoked = continuationObserved && baselineAuthority === true && finalAuthority === false
  const continuationChange = finalAuthority === baselineAuthority ? null : revoked ? "revoked" : "authority_changed"
  const factory = input.factory
  return {
    schema: 1 as const,
    variant: input.variant,
    correction: {
      ...scoreBoundary(input.initial, input.corrected, initialExpected, correctedExpected, correctionObserved,
        correctedAuthority !== initialAuthority && correctedAuthority !== null ? "authority_changed" : "correction"),
      workbench: ledgerDelta(afterInitial, afterCorrection),
      manifestReferenceReads: manifestReferences(input.tools?.corrected, manifest),
      factory: factory ? factoryDelta(factory.afterInitial, factory.afterCorrection, factory.evidence, jobId) : null,
    },
    continuation: {
      ...scoreBoundary(baselineText, input.final, baselineExpected, finalExpected, continuationObserved, continuationChange),
      baseline,
      // The existing probe observes one endpoint after compaction and any revocation.
      revocationObserved: revoked,
      preProbeWorkbench: ledgerDelta(baselineLedger, beforeContinue),
      workbench: ledgerDelta(beforeContinue, afterContinue),
      manifestReferenceReads: manifestReferences(input.tools?.final, manifest),
      factory: factory ? factoryDelta(factory.beforeContinue, factory.afterContinue, factory.evidence, jobId) : null,
    },
    initialManifestReferenceReads: manifestReferences(input.tools?.initial, manifest),
    durableRefutation: durableRefutation(input, manifest, continuationObserved),
    exposure: {
      summary: input.exposure?.summary ?? null,
      factualRefutation: input.exposure?.factualRefutation ?? null,
      pendingMeasurement: input.exposure?.pendingMeasurement ?? null,
      currentSkill: input.exposure?.currentSkill ?? null,
    },
  }
}

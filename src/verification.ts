import { createHash } from "node:crypto"
import { z } from "zod"
import type { CheckerEvidence } from "./checker-evidence.ts"
import type { RunDataReference } from "./types.ts"
import { canonicalJson, sha256Json } from "./persistence.ts"
import { MAX_CHECKER_PROMPT_BYTES } from "./limits.ts"
import type { ActionEvidenceRecord } from "./action-evidence.ts"

/** Opt-in linkage contract. A valid citation is not a guarantee that a claim is true. */
export const VerificationSchema = z.object({ version: z.literal(1), mandate: z.string().trim().min(1).max(2_000).optional() }).strict()
export type Verification = z.infer<typeof VerificationSchema>
/** Closed, host-evaluated recipes. Free text never selects an evaluator. */
export const TaskMechanicalVerificationSchema = z.object({
  version: z.literal(1),
  evaluator: z.literal("task-evidence-v1"),
  criteria: z.array(z.object({
    criterion_id: z.string().regex(/^C[1-9][0-9]{0,2}$/),
    mode: z.enum(["mechanical", "semantic"]),
    recipe: z.literal("pinned_first_bash").optional(),
    expected_command_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    expected_command_bytes: z.number().int().min(0).max(8_192).optional(),
    expected_exit_code: z.number().int().min(-1).max(255).optional(),
  }).strict()).min(1).max(100),
}).strict().superRefine((contract, ctx) => {
  if (contract.criteria.some((row, index) => row.criterion_id !== `C${index + 1}` ||
    ((row.mode === "mechanical") !== (row.recipe !== undefined)) || (row.mode === "mechanical" &&
      (row.recipe !== "pinned_first_bash" || row.expected_command_sha256 === undefined ||
        row.expected_command_bytes === undefined || row.expected_exit_code === undefined))))
    ctx.addIssue({ code: "custom", message: "mechanical criteria must use an ordered supported recipe" })
})
export type TaskMechanicalVerification = z.infer<typeof TaskMechanicalVerificationSchema>
const RetrievedIdSchema = z.string().regex(/^R[a-f0-9]{64}$/)
export const MechanicalAssessmentSchema = z.object({
  version: z.literal(1),
  scope: z.literal("whole_criterion"),
  intent_id: RetrievedIdSchema.optional(),
  terminal_id: RetrievedIdSchema.optional(),
  predicates: z.array(z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("complete_command") }).strict(),
    z.object({ kind: z.literal("linked_pair") }).strict(),
    z.object({ kind: z.literal("exit_equals"), expected: z.number().int() }).strict(),
    z.object({ kind: z.literal("command_equals"), expected_sha256: z.string().regex(/^[a-f0-9]{64}$/), expected_bytes: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal("ordinal_equals"), expected: z.number().int().positive() }).strict(),
    z.object({ kind: z.literal("first_recorded_bash") }).strict(),
  ])).min(1).max(5).refine(items => new Set(items.map(item => item.kind)).size === items.length),
}).strict()
export const FindingSchema = z.object({
  criterion_id: z.string().regex(/^C[1-9][0-9]{0,2}$/),
  outcome: z.enum(["supported", "disconfirmed", "unsupported", "inconclusive"]),
  evidence_ids: z.array(z.string().regex(/^(?:E[1-8]|R[a-f0-9]{64})$/)).max(8),
  // Supported requires observations establishing the criterion; disconfirmed
  // requires cited contradiction. Unsupported requires adequate observations of
  // an unmet requirement. Missing, unavailable, conflicting or non-discriminating
  // required evidence is inconclusive.
  reason: z.string().trim().min(1).max(1_000),
  mechanical_assessment: MechanicalAssessmentSchema.optional(),
}).strict()
export type VerificationFinding = z.infer<typeof FindingSchema>
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const RunDataReferenceSchema = z.object({
  artifact_path: z.string().min(1).max(4_096),
  sha256: digest,
  byte_size: z.number().int().nonnegative(),
}).strict()

/** A checker-requested source slice receipt; page text is deliberately not retained. */
export const RetrievedVerificationEvidenceSchema = z.object({
  id: z.string().regex(/^R[a-f0-9]{64}$/),
  reference: RunDataReferenceSchema,
  value_sha256: digest,
  offset: z.number().int().nonnegative(),
  length: z.number().int().nonnegative().max(8_192),
  total_bytes: z.number().int().nonnegative(),
}).strict().superRefine((entry, ctx) => {
  if (entry.id !== `R${entry.value_sha256}`) {
    ctx.addIssue({ code: "custom", message: "retrieved evidence ID must match its page digest" })
  }
  if (entry.offset + entry.length > entry.total_bytes || entry.total_bytes !== entry.reference.byte_size) {
    ctx.addIssue({ code: "custom", message: "retrieved evidence receipt does not match its bounded reference range" })
  }
})
export type RetrievedVerificationEvidence = Omit<z.infer<typeof RetrievedVerificationEvidenceSchema>, "reference"> & {
  reference: RunDataReference
}

/** Build a compact receipt; the parent must recompute this commitment from the pinned file. */
export function retrievedVerificationEvidence(
  reference: RunDataReference,
  offset: number,
  content: string,
): RetrievedVerificationEvidence {
  const checkedReference = RunDataReferenceSchema.parse(reference)
  const length = Buffer.byteLength(content, "utf8")
  if (!Number.isSafeInteger(offset) || offset < 0 || length > 8_192 || offset + length > checkedReference.byte_size) {
    throw new Error("retrieved evidence slice exceeds its bounded source reference")
  }
  const total_bytes = checkedReference.byte_size
  const value_sha256 = sha256Json({ reference: checkedReference, offset, total_bytes, content })
  return RetrievedVerificationEvidenceSchema.parse({
    id: `R${value_sha256}`, reference: checkedReference, value_sha256, offset, length, total_bytes,
  })
}

const RetrievedVerificationEvidenceListSchema = z.array(RetrievedVerificationEvidenceSchema).max(32)
export const ClaimedSubmissionSchema = z.object({
  run_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  node_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  reference: z.string().min(1).max(4_096),
  attempt: z.number().int().positive().max(10_000),
  json_bytes: z.number().int().nonnegative().max(MAX_CHECKER_PROMPT_BYTES),
  json_sha256: digest,
}).strict()
export type ClaimedSubmission = z.infer<typeof ClaimedSubmissionSchema>
/** Host-owned identity of the actual wired claim; this is not another evidence citation. */
export function pinClaimedSubmission(source: Omit<ClaimedSubmission, "json_bytes" | "json_sha256">, claimed: unknown): ClaimedSubmission {
  const json = JSON.stringify(claimed)
  if (json === undefined) throw new Error("claimed submission is unavailable")
  return ClaimedSubmissionSchema.parse({ ...source, json_bytes: Buffer.byteLength(json),
    json_sha256: createHash("sha256").update(json).digest("hex") })
}
export const VerificationBasisSchema = z.object({
  version: z.literal(1),
  criteria_sha256: digest,
  criterion_ids: z.array(z.string().regex(/^C[1-9][0-9]{0,2}$/)).min(1).max(100),
  claimed_submission: ClaimedSubmissionSchema.optional(),
  evidence: z.array(z.object({
    id: z.string().regex(/^E[1-8]$/),
    port: z.string().min(1).max(64),
    source: z.object({ run_id: z.string().min(1).max(64), kind: z.enum(["node_output", "graph_literal", "run_input", "host_execution", "host_preservation", "host_task"]),
      reference: z.string().min(1).max(4_096).optional(), attempt: z.number().int().nonnegative().optional() }).strict(),
    status: z.enum(["included", "omitted", "unavailable"]),
    json_bytes: z.number().int().nonnegative().optional(),
    json_sha256: digest.optional(),
  }).strict()).max(8),
  omitted_entries: z.number().int().nonnegative().max(1_000),
}).strict().superRefine((basis, ctx) => {
  if (basis.criterion_ids.some((id, i) => id !== `C${i + 1}`) || basis.evidence.some((entry, i) => entry.id !== `E${i + 1}`)) {
    ctx.addIssue({ code: "custom", message: "verification identifiers must be ordered and unique" })
  }
  for (const entry of basis.evidence) {
    if (entry.status !== "unavailable" && (entry.json_sha256 === undefined || entry.json_bytes === undefined)) {
      ctx.addIssue({ code: "custom", message: "available evidence needs a byte commitment" })
    }
  }
})
export type VerificationBasis = z.infer<typeof VerificationBasisSchema>

export interface MechanicalActionObservation {
  reference: RunDataReference
  record: ActionEvidenceRecord
  firstBashOrdinal?: number
  priorGap?: boolean
}
export interface HostMechanicalFindings {
  findings: VerificationFinding[]
  receipts: RetrievedVerificationEvidence[]
  mechanicalCriterionIds: string[]
}

/** Derive closed action findings from authenticated records for the pinned submission only. */
export function evaluateMechanicalActionCriteria(contract: TaskMechanicalVerification | undefined,
  observations: readonly MechanicalActionObservation[]): HostMechanicalFindings | undefined {
  if (!contract?.criteria.some(row => row.mode === "mechanical")) return undefined
  const intents = observations.filter(value => value.record.kind === "intent" && value.record.tool === "bash")
  const firstOrdinal = intents.length ? Math.min(...intents.map(value => value.record.ordinal)) : undefined
  const intentObservation = intents.find(value => value.record.ordinal === firstOrdinal)
  const intentRecord = intentObservation?.record.kind === "intent" ? intentObservation.record : undefined
  const terminalObservation = intentObservation && intentRecord && observations.find(value => value.record.kind === "terminal" &&
    value.record.intent_sha256 === intentObservation.reference.sha256 && value.record.ordinal === intentRecord.ordinal &&
    value.record.call_id_sha256 === intentRecord.call_id_sha256)
  const receipts: RetrievedVerificationEvidence[] = []
  const receiptsByReference = new Map<string, RetrievedVerificationEvidence[]>()
  try {
    // Only the selected first bash intent and its linked terminal need page
    // receipts. The manifest already authenticates unrelated-call ordering.
    const targets = [intentObservation, terminalObservation].filter((value): value is MechanicalActionObservation => !!value)
    for (const observation of targets) {
      const bytes = Buffer.from(canonicalJson(observation.record), "utf8")
      if (bytes.byteLength !== observation.reference.byte_size ||
        createHash("sha256").update(bytes).digest("hex") !== observation.reference.sha256) continue
      const pages: RetrievedVerificationEvidence[] = []
      for (let offset = 0; offset < bytes.byteLength; ) {
        let end = Math.min(bytes.byteLength, offset + 8_192)
        while (end < bytes.byteLength && (bytes[end]! & 0xc0) === 0x80) end--
        if (end <= offset) throw new Error("action evidence page boundary is invalid")
        const page = retrievedVerificationEvidence(observation.reference, offset, bytes.subarray(offset, end).toString("utf8"))
        pages.push(page); receipts.push(page); offset = end
        if (receipts.length > 32) throw new Error("action evidence page cap exceeded")
      }
      receiptsByReference.set(observation.reference.artifact_path, pages)
    }
  } catch { return { findings: contract.criteria.filter(row => row.mode === "mechanical").map(row => ({
    criterion_id: row.criterion_id, outcome: "inconclusive", evidence_ids: [], reason: "Host action evidence is incomplete or exceeds the bounded receipt limit.",
  })), receipts: [], mechanicalCriterionIds: contract.criteria.filter(row => row.mode === "mechanical").map(row => row.criterion_id) } }
  const findings: VerificationFinding[] = []
  for (const row of contract.criteria) {
    if (row.mode !== "mechanical" || row.recipe !== "pinned_first_bash") continue
    const priorGap = intentObservation?.priorGap === true
    const intentRecord = intentObservation?.record
    const terminalRecord = terminalObservation?.record
    const intentReceipts = intentObservation ? receiptsByReference.get(intentObservation.reference.artifact_path) ?? [] : []
    const terminalReceipts = terminalObservation ? receiptsByReference.get(terminalObservation.reference.artifact_path) ?? [] : []
    const intentCovered = covered(intentObservation?.reference.byte_size, intentReceipts)
    const terminalCovered = !terminalObservation || covered(terminalObservation.reference.byte_size, terminalReceipts)
    const commandAvailable = !priorGap && intentRecord?.kind === "intent" && typeof intentRecord.command === "string" &&
      !intentRecord.command_redacted && !intentRecord.command_source_truncated && intentCovered
    const commandMatches = commandAvailable && Buffer.byteLength(intentRecord.command!, "utf8") === row.expected_command_bytes &&
      createHash("sha256").update(intentRecord.command!, "utf8").digest("hex") === row.expected_command_sha256
    const linkAvailable = intentRecord !== undefined && terminalRecord?.kind === "terminal" && terminalCovered &&
      terminalRecord.intent_sha256 === intentObservation!.reference.sha256 &&
      terminalRecord.identity.run_id === intentRecord.identity.run_id && terminalRecord.identity.node_id === intentRecord.identity.node_id &&
      terminalRecord.identity.attempt === intentRecord.identity.attempt && terminalRecord.identity.child_session_id === intentRecord.identity.child_session_id
    const exitAvailable = linkAvailable && terminalRecord?.kind === "terminal" && terminalRecord.tool_status === "completed" &&
      terminalRecord.exit_code_status === "reported" && terminalRecord.exit_code !== undefined
    const values: Array<boolean | undefined> = [
      commandAvailable ? commandMatches : undefined,
      !priorGap && firstOrdinal !== undefined && intentObservation ? intentObservation.record.ordinal === firstOrdinal : undefined,
      !priorGap && exitAvailable ? terminalRecord!.kind === "terminal" && terminalRecord.exit_code === row.expected_exit_code : undefined,
    ]
    const outcome = values.includes(false) ? "disconfirmed" : values.every(value => value === true) ? "supported" : "inconclusive"
    const intentId = intentCovered ? intentReceipts.at(-1)?.id : undefined
    const terminalId = terminalCovered && terminalObservation ? terminalReceipts.at(-1)?.id : undefined
    const evidenceIds = [...new Set([intentId, terminalId].filter((id): id is string => !!id))]
    findings.push({ criterion_id: row.criterion_id, outcome, evidence_ids: evidenceIds,
      reason: "Host comparison of the pinned first bash intent and its linked terminal record.",
      ...(intentId && !priorGap ? { mechanical_assessment: { version: 1 as const, scope: "whole_criterion" as const, intent_id: intentId,
        ...(terminalId ? { terminal_id: terminalId } : {}), predicates: [
          { kind: "complete_command" }, { kind: "linked_pair" },
          { kind: "command_equals", expected_sha256: row.expected_command_sha256!, expected_bytes: row.expected_command_bytes! },
          { kind: "first_recorded_bash" }, { kind: "exit_equals", expected: row.expected_exit_code! },
        ] } } : {}) })
  }
  return { findings, receipts, mechanicalCriterionIds: contract.criteria.filter(row => row.mode === "mechanical").map(row => row.criterion_id) }
}

function covered(total: number | undefined, pages: RetrievedVerificationEvidence[]): boolean {
  if (total === undefined || !pages.length) return false
  let end = 0
  for (const page of [...pages].sort((a, b) => a.offset - b.offset)) {
    if (page.offset > end) return false
    end = Math.max(end, page.offset + page.length)
  }
  return end === total
}

export function effectiveCriteria(criteria: string[]): string[] {
  return criteria.length ? criteria : ["Output must be complete and match the goal."]
}
export function criteriaDigest(criteria: string[]): string {
  return createHash("sha256").update(JSON.stringify(effectiveCriteria(criteria))).digest("hex")
}
export function buildVerificationBasis(criteria: string[], evidence?: CheckerEvidence, claimedSubmission?: ClaimedSubmission): VerificationBasis {
  return VerificationBasisSchema.parse({
    version: 1, criteria_sha256: criteriaDigest(criteria),
    criterion_ids: effectiveCriteria(criteria).map((_, i) => `C${i + 1}`),
    ...(claimedSubmission ? { claimed_submission: claimedSubmission } : {}),
    evidence: (evidence?.entries ?? []).map(({ value: _value, ...entry }, i) => ({ ...entry, id: `E${i + 1}` })),
    omitted_entries: evidence?.omitted_entries ?? 0,
  })
}

/** All diagnostics are code-owned; submitted identifiers/keys/values never enter retry guidance. */
export function validateVerification(
  output: unknown,
  basis: VerificationBasis,
  retrievedEvidence: RetrievedVerificationEvidence[] = [],
  hostEvidence: RetrievedVerificationEvidence[] = [],
  hostCriterionIds: readonly string[] = [],
): string[] {
  const retrieved = RetrievedVerificationEvidenceListSchema.safeParse(retrievedEvidence)
  const host = RetrievedVerificationEvidenceListSchema.safeParse(hostEvidence)
  if (!retrieved.success || !host.success) {
    return ["schema: findings: code=evidence_binding; retrieved evidence receipts must be host-registered and well-formed"]
  }
  const retrievedIds = retrieved.data.map(entry => entry.id)
  const hostIds = host.data.map(entry => entry.id)
  if (new Set([...retrievedIds, ...hostIds]).size !== retrievedIds.length + hostIds.length) {
    return ["schema: findings: code=evidence_binding; retrieved evidence identities must be unique"]
  }
  const verdict = output as { passed?: unknown; findings?: unknown }
  const parsed = z.array(FindingSchema).min(1).max(100).safeParse(verdict?.findings)
  if (!parsed.success) return ["schema: findings: code=verification_contract; return one typed finding per supplied criterion ID"]
  const findings = parsed.data
  const ids = findings.map(finding => finding.criterion_id)
  if (new Set(ids).size !== ids.length || ids.length !== basis.criterion_ids.length || ids.some(id => !basis.criterion_ids.includes(id))) {
    return ["schema: findings: code=criterion_coverage; include each supplied criterion ID exactly once"]
  }
  const available = new Set([
    ...basis.evidence.filter(entry => entry.status === "included" && entry.json_sha256).map(entry => entry.id),
    ...retrievedIds,
  ])
  for (const finding of findings) {
    const hostCriterion = hostCriterionIds.includes(finding.criterion_id)
    const allowed = hostCriterion ? new Set(hostIds) : available
    if (new Set(finding.evidence_ids).size !== finding.evidence_ids.length || finding.evidence_ids.some(id => !allowed.has(id)) ||
      (["supported", "disconfirmed"].includes(finding.outcome) && finding.evidence_ids.length === 0)) {
      return ["schema: findings: code=evidence_binding; cite only supplied included evidence IDs; support or contradiction requires a citation"]
    }
    const assessment = finding.mechanical_assessment
    if (assessment && ([assessment.intent_id, assessment.terminal_id].some(id => id !== undefined &&
      (!finding.evidence_ids.includes(id) || !(hostCriterion ? hostIds : retrievedIds).includes(id))) || finding.outcome === "unsupported")) {
      return ["schema: findings: code=mechanical_binding; mechanical targets require cited registered pages and a supported, disconfirmed or inconclusive outcome"]
    }
  }
  if (verdict.passed !== findings.every(finding => finding.outcome === "supported")) {
    return ["schema: findings: code=verdict_binding; passed must equal every criterion supported; missing or conflicting support cannot pass"]
  }
  return []
}

/** Evidence retrieval is a gap only with an inconclusive finding and no unsupported or disconfirmed finding. */
export function classifyVerificationEvidenceGap(output: unknown): boolean {
  const verdict = output as { findings?: unknown }
  const parsed = z.array(FindingSchema).min(1).max(100).safeParse(verdict?.findings)
  if (!parsed.success) return false
  const outcomes = parsed.data.map(finding => finding.outcome)
  return outcomes.includes("inconclusive") &&
    outcomes.every(outcome => outcome === "supported" || outcome === "inconclusive")
}

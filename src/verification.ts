import { createHash } from "node:crypto"
import { z } from "zod"
import type { CheckerEvidence } from "./checker-evidence.ts"
import type { RunDataReference } from "./types.ts"
import { sha256Json } from "./persistence.ts"

/** Opt-in linkage contract. A valid citation is not a guarantee that a claim is true. */
export const VerificationSchema = z.object({ version: z.literal(1), mandate: z.string().trim().min(1).max(2_000).optional() }).strict()
export type Verification = z.infer<typeof VerificationSchema>
export const FindingSchema = z.object({
  criterion_id: z.string().regex(/^C[1-9][0-9]{0,2}$/),
  outcome: z.enum(["supported", "disconfirmed", "unsupported", "inconclusive"]),
  evidence_ids: z.array(z.string().regex(/^(?:E[1-8]|R[a-f0-9]{64})$/)).max(8),
  // Explain why the cited observations establish, contradict, lack necessary
  // support, or fail to discriminate the criterion. Inconclusive means conflicting
  // or non-discriminating evidence; missing necessary observations are unsupported.
  reason: z.string().trim().min(1).max(1_000),
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
export const VerificationBasisSchema = z.object({
  version: z.literal(1),
  criteria_sha256: digest,
  criterion_ids: z.array(z.string().regex(/^C[1-9][0-9]{0,2}$/)).min(1).max(100),
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

export function effectiveCriteria(criteria: string[]): string[] {
  return criteria.length ? criteria : ["Output must be complete and match the goal."]
}
export function criteriaDigest(criteria: string[]): string {
  return createHash("sha256").update(JSON.stringify(effectiveCriteria(criteria))).digest("hex")
}
export function buildVerificationBasis(criteria: string[], evidence?: CheckerEvidence): VerificationBasis {
  return VerificationBasisSchema.parse({
    version: 1, criteria_sha256: criteriaDigest(criteria),
    criterion_ids: effectiveCriteria(criteria).map((_, i) => `C${i + 1}`),
    evidence: (evidence?.entries ?? []).map(({ value: _value, ...entry }, i) => ({ ...entry, id: `E${i + 1}` })),
    omitted_entries: evidence?.omitted_entries ?? 0,
  })
}

/** All diagnostics are code-owned; submitted identifiers/keys/values never enter retry guidance. */
export function validateVerification(
  output: unknown,
  basis: VerificationBasis,
  retrievedEvidence: RetrievedVerificationEvidence[] = [],
): string[] {
  const retrieved = RetrievedVerificationEvidenceListSchema.safeParse(retrievedEvidence)
  if (!retrieved.success) {
    return ["schema: findings: code=evidence_binding; retrieved evidence receipts must be host-registered and well-formed"]
  }
  const retrievedIds = retrieved.data.map(entry => entry.id)
  if (new Set(retrievedIds).size !== retrievedIds.length) {
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
    if (new Set(finding.evidence_ids).size !== finding.evidence_ids.length || finding.evidence_ids.some(id => !available.has(id)) ||
      (["supported", "disconfirmed"].includes(finding.outcome) && finding.evidence_ids.length === 0)) {
      return ["schema: findings: code=evidence_binding; cite only supplied included evidence IDs; support or contradiction requires a citation"]
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

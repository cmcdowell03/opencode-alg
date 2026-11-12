import { createHash } from "node:crypto"
import { z } from "zod"
import type { CheckerEvidence } from "./checker-evidence.ts"

/** Opt-in linkage contract. A valid citation is not a guarantee that a claim is true. */
export const VerificationSchema = z.object({ version: z.literal(1), mandate: z.string().trim().min(1).max(2_000).optional() }).strict()
export type Verification = z.infer<typeof VerificationSchema>
export const FindingSchema = z.object({
  criterion_id: z.string().regex(/^C[1-9][0-9]{0,2}$/),
  outcome: z.enum(["supported", "disconfirmed", "unsupported", "inconclusive"]),
  evidence_ids: z.array(z.string().regex(/^E[1-8]$/)).max(8),
  reason: z.string().trim().min(1).max(1_000),
}).strict()
export type VerificationFinding = z.infer<typeof FindingSchema>
const digest = z.string().regex(/^[a-f0-9]{64}$/)
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
export function validateVerification(output: unknown, basis: VerificationBasis): string[] {
  const verdict = output as { passed?: unknown; findings?: unknown }
  const parsed = z.array(FindingSchema).min(1).max(100).safeParse(verdict?.findings)
  if (!parsed.success) return ["schema: findings: code=verification_contract; return one typed finding per supplied criterion ID"]
  const findings = parsed.data
  const ids = findings.map(finding => finding.criterion_id)
  if (new Set(ids).size !== ids.length || ids.length !== basis.criterion_ids.length || ids.some(id => !basis.criterion_ids.includes(id))) {
    return ["schema: findings: code=criterion_coverage; include each supplied criterion ID exactly once"]
  }
  const available = new Set(basis.evidence.filter(entry => entry.status === "included" && entry.json_sha256).map(entry => entry.id))
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

import { z } from "zod"
import { FindingSchema, type RetrievedVerificationEvidence } from "./verification.ts"
import type { ActionEvidenceRecord } from "./action-evidence.ts"

/** Material supplied only after store validation of source manifests and exact page receipts. */
export interface VerifiedCheckerRecord {
  record: ActionEvidenceRecord
  // undefined: the persisted basis did not retain a node-output submission pin.
  selectedSubmission: boolean | undefined
  firstBashOrdinal: number | undefined
}
export const MECHANICAL_BINDING_FAILURE = "schema: findings: code=mechanical_binding; use cited records from the pinned producer submission and one captured call"
export const MECHANICAL_CONSISTENCY_FAILURE = "schema: findings: code=mechanical_consistency; reconcile the declared whole-criterion assessment with its cited observations; preserve unknown facts and do not change criteria or repeat actions"

export function hasMechanicalAssessment(output: unknown): boolean {
  const findings = (output as { findings?: unknown } | undefined)?.findings
  return Array.isArray(findings) && findings.some(finding => finding && typeof finding === "object" && "mechanical_assessment" in finding)
}

/** No filesystem reads or semantic interpretation. The caller supplies verified immutable records. */
export function validateCheckerConsistency(output: unknown, receipts: RetrievedVerificationEvidence[],
  records: ReadonlyMap<string, VerifiedCheckerRecord>): string[] {
  if (!hasMechanicalAssessment(output)) return []
  const parsed = z.array(FindingSchema).min(1).max(100).safeParse((output as { findings?: unknown }).findings)
  if (!parsed.success || receipts.length > 32) return [MECHANICAL_BINDING_FAILURE]
  const registered = new Map(receipts.map(receipt => [receipt.id, receipt]))
  if (registered.size !== receipts.length) return [MECHANICAL_BINDING_FAILURE]
  for (const finding of parsed.data) {
    const assessment = finding.mechanical_assessment
    if (!assessment) continue
    let invalid = false
    const resolve = (id: string | undefined, kind: "intent" | "terminal") => {
      if (id === undefined) return undefined
      const receipt = registered.get(id)
      const material = receipt && records.get(receipt.reference.artifact_path)
      if (!receipt || !finding.evidence_ids.includes(id) || !material || material.record.kind !== kind || material.selectedSubmission === false) {
        invalid = true
        return undefined
      }
      if (material.selectedSubmission === undefined) return undefined
      // Coverage uses every registered read in this checker session, not just the
      // at-most-eight citation anchors. Overlaps are valid; interior gaps are not.
      let end = 0
      for (const page of receipts.filter(page => page.reference.artifact_path === receipt.reference.artifact_path &&
        page.reference.sha256 === receipt.reference.sha256 && page.total_bytes === receipt.total_bytes)
        .sort((a, b) => a.offset - b.offset)) {
        if (page.offset > end) return undefined
        end = Math.max(end, page.offset + page.length)
      }
      return end === receipt.total_bytes ? material : undefined
    }
    const intent = resolve(assessment.intent_id, "intent")
    const terminal = resolve(assessment.terminal_id, "terminal")
    const i = intent?.record.kind === "intent" ? intent.record : undefined
    const t = terminal?.record.kind === "terminal" ? terminal.record : undefined
    // Binding is checked even when incomplete reads prevent using a record's
    // facts. A partially read intent cannot nominate an unrelated terminal.
    const intentReceipt = assessment.intent_id ? registered.get(assessment.intent_id) : undefined
    const terminalReceipt = assessment.terminal_id ? registered.get(assessment.terminal_id) : undefined
    const boundIntent = intentReceipt && records.get(intentReceipt.reference.artifact_path)?.record
    const boundTerminal = terminalReceipt && records.get(terminalReceipt.reference.artifact_path)?.record
    if (boundIntent && boundTerminal && boundIntent.kind === "intent" && boundTerminal.kind === "terminal" &&
      (boundTerminal.intent_sha256 !== intentReceipt!.reference.sha256 || boundTerminal.call_id_sha256 !== boundIntent.call_id_sha256 ||
        boundTerminal.ordinal !== boundIntent.ordinal || boundTerminal.identity.run_id !== boundIntent.identity.run_id ||
        boundTerminal.identity.node_id !== boundIntent.identity.node_id || boundTerminal.identity.attempt !== boundIntent.identity.attempt ||
        boundTerminal.identity.child_session_id !== boundIntent.identity.child_session_id)) invalid = true
    if (invalid || finding.outcome === "unsupported") return [MECHANICAL_BINDING_FAILURE]
    const values = assessment.predicates.map((predicate): boolean | undefined => {
      switch (predicate.kind) {
        case "complete_command": return i && typeof i.command === "string" && !i.command_redacted && !i.command_source_truncated ? true : undefined
        case "linked_pair": return i && t ? true : undefined
        case "exit_equals": return t?.exit_code_status === "reported" && t.exit_code !== undefined ? t.exit_code === predicate.expected : undefined
        case "ordinal_equals": return i ? i.ordinal === predicate.expected : undefined
        case "first_recorded_bash": return i && intent?.firstBashOrdinal !== undefined ? i.ordinal === intent.firstBashOrdinal : undefined
      }
    })
    const outcome = values.includes(false) ? "disconfirmed" : values.every(value => value === true) ? "supported" : "inconclusive"
    if (finding.outcome !== outcome) return [MECHANICAL_CONSISTENCY_FAILURE]
  }
  return []
}

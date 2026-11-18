import type { InvestigationCheckpoint } from "./index.ts"

/** Explicit pins take precedence. For older checkpoints prefer shared evidence
 * and last revision time, including hypotheses that were amended in place. */
export function decisionEvidence(checkpoint: InvestigationCheckpoint) {
  const focus = checkpoint.decision_focus
  const resultRefs = new Set(checkpoint.analytical_result?.evidence_refs)
  const related = (refs: string[]) => Number(refs.some(ref => resultRefs.has(ref)))
  const hypotheses = focus
    ? focus.hypothesis_ids.map(id => checkpoint.hypotheses.find(item => item.id === id)!)
    : [...checkpoint.hypotheses].reverse().sort((a, b) => related(b.evidence_refs) - related(a.evidence_refs) ||
      Date.parse(b.updated_at) - Date.parse(a.updated_at)).slice(0, 4)
  const contradictions = focus?.contradictions.length ? focus.contradictions : checkpoint.contradictions
  return {
    selection: focus ? "owner_selected" : "evidence_overlap_then_updated",
    contradiction_selection: focus?.contradictions.length ? "owner_selected" : "recorded_order",
    next_action: checkpoint.next_action,
    hypotheses: hypotheses.map(({ id, statement, status, evidence_refs }) => ({
      id, statement, status, evidence_refs: evidence_refs.slice(0, 4),
      other_evidence_refs: Math.max(0, evidence_refs.length - 4),
    })),
    contradictions: contradictions.slice(0, 4),
    other_contradictions: checkpoint.contradictions.length - Math.min(contradictions.length, 4),
    other_hypotheses: checkpoint.hypotheses.length - hypotheses.length,
  }
}

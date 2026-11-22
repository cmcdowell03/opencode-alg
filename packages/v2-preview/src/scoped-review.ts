import type { EvidenceFinding, EvidenceReadView } from "./evidence-reads.ts"

// A question describes the evidence to challenge. It cannot authorize a tool,
// verify an interpretation, or turn a cited row into a supported conclusion.
export function selectReviewQuestion(view: EvidenceReadView, closureRequested = false) {
  const pinned = view.question && view.findings.find(f => f.id === view.question!.findingId)
  const finding = pinned || view.findings.find(f => f.status === "contested") ||
    view.findings.find(f => f.status === "unresolved") || (closureRequested && view.findings[0])
  if (!finding) return null
  const mode = finding.status === "contested" || closureRequested ? "adversarial" : "ordinary"
  const question = pinned && view.question ? view.question.text :
    mode === "adversarial" ? "Does the cited evidence rule out the strongest competing explanation for this finding?" :
      "What can the cited evidence establish about this finding, and which uncertainty remains?"
  const citations = (receipts: EvidenceFinding["support"]) => receipts.slice(0, 4).map(row => row.reference)
  return {
    findingId: finding.id, scope: finding.scope, interpretation: finding.interpretation,
    question, mode, support: citations(finding.support), counterevidence: citations(finding.counterevidence),
    omittedSupport: Math.max(0, finding.support.length - 4),
    omittedCounterevidence: Math.max(0, finding.counterevidence.length - 4),
    wouldChangeConclusion: finding.falsifier ?? null,
    missingEvidence: finding.missingEvidence ?? null,
    readPolicy: "use_recorded_evidence_first" as const,
  }
}

import { z } from "zod"
import { hashObject } from "./session-memory/store.ts"
import { atomicWriteFile, readNodeArtifactOutput, runContainedPath } from "./store.ts"
import { readSkillEvolutionDirectBounded } from "./skill-evolution-store.ts"
import { InvestigationStore } from "./investigation/index.ts"
import type { RunState } from "./types.ts"

const ReviewSchema = z.object({ schema_version: z.literal(1), basis: z.string().regex(/^[a-f0-9]{64}$/),
  engineer_ref: z.string().min(1).max(256), reviewed_at: z.iso.datetime({ offset: true }),
  decision: z.literal("proceed"), authority: z.literal("application-operator") }).strict()

/** A review is about these completed findings, not permission for future arbitrary graphs. */
export function investigationReviewBasis(run: RunState): string {
  const confirmation = run.graph.nodes.find((node) => node.id === "confirm")
  if (!confirmation || !run.investigation) throw new Error("investigation confirmation boundary unavailable")
  const ids = new Set<string>()
  const visit = (id: string) => { if (ids.has(id)) return; ids.add(id)
    for (const dependency of run.graph.nodes.find((node) => node.id === id)?.depends_on ?? []) visit(dependency) }
  for (const id of confirmation.depends_on ?? []) visit(id)
  const findings = [...ids].sort().map((id) => {
    const state = run.nodes[id]
    if (!state || state.status !== "done") throw new Error("engineer review requires completed initial findings")
    // Projected progress can externalize output and archive old attempts.
    return { id, output: readNodeArtifactOutput(run, id), attempts: state.current_attempt }
  })
  const context = InvestigationStore.open({ project_directory: run.project_directory, project_id: run.investigation.project_id,
    owner_id: run.investigation.owner_id, run_id: run.investigation.run_id }).context
  const { next_action: _next, ...reviewedContext } = context
  return hashObject({ investigation: run.investigation, graph: run.graph, goal: run.goal, criteria: run.criteria,
    findings, reviewedContext })
}
function file(run: RunState) { return runContainedPath(run.project_directory, run.run_id, "investigation", "engineer-review.json") }
export function recordInvestigationReview(run: RunState, engineer: string) {
  const receipt = ReviewSchema.parse({ schema_version: 1, basis: investigationReviewBasis(run), engineer_ref: engineer,
    reviewed_at: new Date().toISOString(), decision: "proceed", authority: "application-operator" })
  atomicWriteFile(file(run), JSON.stringify(receipt))
  return receipt
}
export function requireInvestigationReview(run: RunState) {
  try {
    const receipt = ReviewSchema.parse(JSON.parse(readSkillEvolutionDirectBounded(run.project_directory, file(run), 4096, "engineer review").toString("utf8")))
    if (receipt.basis !== investigationReviewBasis(run) || Date.parse(receipt.reviewed_at) > Date.now()) throw new Error("stale review")
  } catch { throw new Error("engineer_review_required: review current initial findings using the operator investigation CLI before confirmation") }
}

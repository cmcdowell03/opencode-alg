import { z } from "zod"
import { hashObject } from "./session-memory/store.ts"
import { readNodeArtifactOutput, runContainedPath } from "./store.ts"
import { readSkillEvolutionDirectBounded } from "./skill-evolution-store.ts"
import { InvestigationStore, type InvestigationConfirmationReview, type InvestigationLedger, type InvestigationWork } from "./investigation/index.ts"
import type { RunState } from "./types.ts"
import { graphPolicy } from "./graph-policy.ts"

const ReviewV1Schema = z.object({ schema_version: z.literal(1), basis: z.string().regex(/^[a-f0-9]{64}$/),
  engineer_ref: z.string().min(1).max(256), reviewed_at: z.iso.datetime({ offset: true }),
  decision: z.literal("proceed"), authority: z.literal("application-operator") }).strict()
const ReviewV2Schema = ReviewV1Schema.extend({ schema_version: z.literal(2),
  confirmation_work_key: z.string().regex(/^[a-f0-9]{64}$/), confirmation_binding: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const ReviewSchema = z.discriminatedUnion("schema_version", [ReviewV1Schema, ReviewV2Schema])

/** A review is about these completed findings, not permission for future arbitrary graphs. */
function confirmationWorkBinding(run: RunState, workKey: string, supplied?: Readonly<InvestigationWork>, ledger?: Readonly<InvestigationLedger>) {
  if (!run.investigation) throw new Error("investigation confirmation boundary unavailable")
  const stored = ledger ?? (supplied ? undefined : InvestigationStore.open({ project_directory: run.project_directory,
    project_id: run.investigation.project_id, owner_id: run.investigation.owner_id, run_id: run.investigation.run_id }).snapshot)
  const work = supplied?.work_key === workKey ? supplied : stored?.work.find((entry) => entry.work_key === workKey)
  if (!work || !work.authorized_nodes?.includes("confirm")) throw new Error("selected confirmation work order is unavailable")
  if (!work.recipe_version || work.admitted_reservation === undefined)
    throw new Error("legacy confirmation work order lacks inspectable recipe or reservation identity")
  return hashObject({ work_key: work.work_key, submission_id: work.submission_id, operation: work.operation,
    reservation: work.admitted_reservation, recipe_version: work.recipe_version,
    cohort: work.cohort ?? null, preprocessing_revision: work.preprocessing_revision ?? null,
    query: work.query, parameters: work.parameters,
    source_dependencies: work.source_dependencies, purpose: work.purpose, generation: work.generation,
    authorized_nodes: work.authorized_nodes })
}
export function investigationReviewBasis(run: RunState, confirmationWorkKey?: string, supplied?: Readonly<InvestigationWork>,
  ledger?: Readonly<InvestigationLedger>): string {
  const confirmation = run.graph.nodes.find((node) => node.id === graphPolicy(run.graph)?.reviewNode)
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
  const context = ledger?.checkpoint ?? InvestigationStore.open({ project_directory: run.project_directory, project_id: run.investigation.project_id,
    owner_id: run.investigation.owner_id, run_id: run.investigation.run_id }).context
  const { next_action: _next, ...reviewedContext } = context
  const confirmation_binding = confirmationWorkKey ? confirmationWorkBinding(run, confirmationWorkKey, supplied, ledger) : undefined
  return hashObject({ investigation: run.investigation, graph: run.graph, goal: run.goal, criteria: run.criteria,
    findings, reviewedContext, ...(confirmationWorkKey ? { confirmation_work_key: confirmationWorkKey, confirmation_binding } : {}) })
}
function file(run: RunState) { return runContainedPath(run.project_directory, run.run_id, "investigation", "engineer-review.json") }
export function recordInvestigationReview(run: RunState, engineer: string, confirmationWorkKey?: string, expectedBasis?: string) {
  if (!run.investigation || !confirmationWorkKey) throw new Error("new confirmation review requires an exact selected work order")
  const store = InvestigationStore.open({ project_directory: run.project_directory, project_id: run.investigation.project_id,
    owner_id: run.investigation.owner_id, run_id: run.investigation.run_id })
  const snapshot = store.snapshot
  const work = snapshot.work.find((entry) => entry.work_key === confirmationWorkKey)
  if (!work) throw new Error("selected confirmation work order is unavailable")
  // Compute the basis once from one ledger snapshot; the expected revision CAS below prevents drift before commit.
  const basis = investigationReviewBasis(run, confirmationWorkKey, work, snapshot)
  if (expectedBasis !== undefined && basis !== expectedBasis)
    throw new Error("stale operator preview: current review basis differs; preview again before approving")
  const receipt = ReviewV2Schema.parse({ schema_version: 2, basis, confirmation_work_key: confirmationWorkKey,
    confirmation_binding: confirmationWorkBinding(run, confirmationWorkKey, work, snapshot), engineer_ref: engineer,
    reviewed_at: new Date().toISOString(), decision: "proceed", authority: "application-operator" })
  return store.recordConfirmationReviewSync(receipt, snapshot.revision)
}
export function requireInvestigationReview(run: RunState, confirmationWorkKey?: string,
  supplied?: Readonly<InvestigationWork>, authoritativeReceipt?: InvestigationConfirmationReview | null): string | undefined {
  try {
    const stored = run.investigation && InvestigationStore.open({ project_directory: run.project_directory,
      project_id: run.investigation.project_id, owner_id: run.investigation.owner_id, run_id: run.investigation.run_id }).snapshot.confirmation_review
    const raw = authoritativeReceipt !== undefined ? authoritativeReceipt : stored ??
      JSON.parse(readSkillEvolutionDirectBounded(run.project_directory, file(run), 4096, "engineer review").toString("utf8"))
    if (!raw) throw new Error("ledger review missing")
    const receipt = ReviewSchema.parse(raw)
    if (Date.parse(receipt.reviewed_at) > Date.now()) throw new Error("future review")
    if (confirmationWorkKey !== undefined) {
      if (receipt.schema_version !== 2 || receipt.confirmation_work_key !== confirmationWorkKey ||
        receipt.confirmation_binding !== confirmationWorkBinding(run, confirmationWorkKey, supplied) ||
        receipt.basis !== investigationReviewBasis(run, confirmationWorkKey, supplied)) throw new Error("stale or substituted confirmation review")
      return receipt.confirmation_work_key
    }
    if (receipt.schema_version === 2) {
      if (receipt.confirmation_binding !== confirmationWorkBinding(run, receipt.confirmation_work_key) ||
        receipt.basis !== investigationReviewBasis(run, receipt.confirmation_work_key)) throw new Error("stale review")
      return receipt.confirmation_work_key
    }
    if (receipt.basis !== investigationReviewBasis(run)) throw new Error("stale review")
  } catch { throw new Error("engineer_review_required: review current initial findings using the operator investigation CLI before confirmation") }
}

/** Selection projection for the active confirm worker; unlike require, it does not authorize dispatch. */
export function investigationReviewSelection(run: RunState): string | undefined {
  try {
    if (!run.investigation) return undefined
    const ledger = InvestigationStore.open({ project_directory: run.project_directory, project_id: run.investigation.project_id,
      owner_id: run.investigation.owner_id, run_id: run.investigation.run_id }).snapshot
    if (ledger.confirmation_review) return ledger.confirmation_review.confirmation_work_key
    const raw = JSON.parse(readSkillEvolutionDirectBounded(run.project_directory, file(run), 4096, "engineer review").toString("utf8"))
    const receipt = ReviewSchema.parse(raw)
    return receipt.schema_version === 2 ? receipt.confirmation_work_key : undefined
  } catch { return undefined }
}

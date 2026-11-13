import type { RunState } from "./types.ts"
import { truncateUtf8, utf8Bytes } from "./limits.ts"
import { sha256Json } from "./persistence.ts"
import { TASK_DELIVERY_SCOPE_GUIDANCE } from "./task-contract.ts"

export const MAX_COMPACTION_CONTEXT_BYTES = 16 * 1024
export const MAX_COMPACTION_OUTPUT_BYTES = 32 * 1024
export const COMPACTION_GOAL_CHARS = 1_000
export const COMPACTION_CRITERIA_COUNT = 20
export const COMPACTION_CRITERION_CHARS = 300
export const COMPACTION_NODE_COUNT = 32
export const COMPACTION_FAILURE_COUNT = 3
export const COMPACTION_FAILURE_CHARS = 200

const INCOMPLETE_STATUSES = new Set(["planning", "running", "blocked"])

function requestSourcePointer(run: RunState): string[] {
  const source = run.task_contract?.request_snapshot
  return source?.status === "captured" ? [
    `- user_turn_text: ${source.text_sha256}; full source in alg_status(detail=full).task_contract.request_snapshot; current turn only, not complete conversation.`,
  ] : []
}

function allowancePointer(run: RunState): string[] {
  return run.task_allowance ? [
    `- task_allowance: ${run.task_allowance.task_id}; alg_status.task_allowance_status has current remaining dispatches. Replanning, retries and ownership transfer retain this allowance; root/compaction provider usage is outside this limit.`,
  ] : []
}

export function selectCompactionRun(runs: RunState[], sessionId: string): RunState | null {
  return [...runs]
    .filter((run) => run.owner_session_id === sessionId && INCOMPLETE_STATUSES.has(run.status))
    .sort((left, right) =>
      right.updated_at.localeCompare(left.updated_at) || left.run_id.localeCompare(right.run_id),
    )[0] ?? null
}

function cap(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`
}

interface RunSummaryDetail {
  goalChars: number
  criteria: number
  criterionChars: number
  nodes: number
  failures: number
  failureChars: number
}

/** From most to least detail. With an allowance, the first that fits is used. */
const RUN_SUMMARY_DETAIL: readonly RunSummaryDetail[] = [
  { goalChars: 4_000, criteria: 64, criterionChars: 1_000, nodes: 128, failures: 5, failureChars: 600 },
  { goalChars: COMPACTION_GOAL_CHARS, criteria: COMPACTION_CRITERIA_COUNT, criterionChars: COMPACTION_CRITERION_CHARS,
    nodes: COMPACTION_NODE_COUNT, failures: COMPACTION_FAILURE_COUNT, failureChars: COMPACTION_FAILURE_CHARS },
  { goalChars: 400, criteria: 8, criterionChars: 160, nodes: 32, failures: 1, failureChars: 120 },
  { goalChars: 160, criteria: 0, criterionChars: 0, nodes: 12, failures: 0, failureChars: 0 },
]

/** What must survive any allowance comes first: which run, its state, and how to continue it. */
function renderRunSummary(run: RunState, detail: RunSummaryDetail): string {
  const lines = [
    "## ALG active run state (bounded durable summary)",
    "",
    `- run_id: ${run.run_id}`,
    `- status: ${run.status} / phase: ${cap(run.phase, 80)}`,
    ...(run.status === "blocked" && run.summary ? [`- blocker: ${cap(run.summary, 700)}`] : []),
    ...(run.task_contract ? [`- task_contract: ${run.task_contract.contract_sha256}; ALG delivery phase=${run.task_contract.input.phase}; requirements=${run.task_contract.requirements_sha256}`,
      "- Reuse the accepted task via alg_status; advisory findings cannot replace its criteria.",
      `- ${TASK_DELIVERY_SCOPE_GUIDANCE}`] : ["- task_admission: legacy-unqualified"]),
    ...requestSourcePointer(run),
    ...allowancePointer(run),
    ...(run.task_baseline ? [`- task_baseline: ${sha256Json(run.task_baseline)}; immutable before-first-child observations in alg_status(detail=full).task_baseline; do not recapture.`] : []),
    "- continue with alg_resume; alg_status and alg_artifact hold the authoritative details.",
    "- Evidence gaps do not authorize replay. Action journal references and checker retrieval receipts remain in attempt state; recover and inspect them before repeating work. Managed remote jobs retain their original submission IDs and reconciliation rules.",
    `- path: .opencode/runs/${run.run_id}/`,
    "",
    "### Nodes",
  ]
  const definitions = run.graph.nodes.filter((definition) => run.nodes[definition.id])
  for (const definition of definitions.slice(0, detail.nodes)) {
    const node = run.nodes[definition.id]!
    const failures = node.last_failures.slice(0, detail.failures).map((failure) => cap(failure, detail.failureChars))
    lines.push(`- ${node.id} [${node.agent}] ${node.status} attempts=${node.current_attempt}` +
      (failures.length ? ` failures=${failures.join(" | ")}` : ""))
    const latest = node.attempts.at(-1)
    if (latest?.action_evidence_ref) lines.push(`  action_manifest=${latest.action_evidence_ref.sha256}; exact reference in alg_status attempt state`)
    if (latest?.outcome === "evidence_unavailable") lines.push("  evidence_unavailable: inspect retained records; do not replay the producer")
  }
  if (definitions.length > detail.nodes) lines.push(`- (${definitions.length - detail.nodes} more nodes not shown)`)
  lines.push("", `- goal: ${cap(run.goal, detail.goalChars)}`, `- criteria_locked: ${run.criteria_locked}`)
  if (!run.criteria.length) lines.push("- criteria: (none)")
  else if (!detail.criteria) lines.push(`- criteria: ${run.criteria.length} not shown`)
  else {
    lines.push("- criteria:", ...run.criteria.slice(0, detail.criteria).map((criterion) => `  - ${cap(criterion, detail.criterionChars)}`))
    if (run.criteria.length > detail.criteria) lines.push(`  - (${run.criteria.length - detail.criteria} more not shown)`)
  }
  lines.push("", "ALG creates fresh child sessions and does not explicitly forward worker transcripts to checkers.")
  return lines.join("\n")
}

/**
 * Without an allowance this is the long-standing fixed summary. With one (see context-budget.ts) the
 * summary shows as much detail as fits, and what identifies and continues the run is never cut.
 */
export function formatRunPointer(run: RunState): string {
  return `ALG unfinished run ${run.run_id}. Use alg_status, then alg_resume to continue; revalidate permissions and required procedures.`
}

export function formatCompactionContext(run: RunState, maximumBytes?: number): string {
  if (maximumBytes !== undefined) {
    const limit = Number.isFinite(maximumBytes) ? Math.max(0, Math.floor(maximumBytes)) : 0
    if (limit < 256) return ""
    for (const detail of RUN_SUMMARY_DETAIL) {
      const summary = renderRunSummary(run, detail)
      if (utf8Bytes(summary) <= limit) return summary
    }
    const suffix = "\n[ALG compaction summary truncated]"
    return `${truncateUtf8(renderRunSummary(run, RUN_SUMMARY_DETAIL.at(-1)!), Math.max(0, limit - utf8Bytes(suffix)))}${suffix}`
  }
  const lines = [
    "## ALG active run state (bounded durable summary)",
    "",
    "ALG creates fresh child sessions and does not explicitly forward worker transcripts to checkers.",
    "OpenCode SDK project/system context and filesystem/tool access still apply.",
    "",
    `- run_id: ${run.run_id}`,
    `- status: ${run.status} / phase: ${cap(run.phase, 80)}`,
    `- goal: ${cap(run.goal, COMPACTION_GOAL_CHARS)}`,
    `- criteria_locked: ${run.criteria_locked}`,
    ...(run.status === "blocked" && run.summary ? [`- blocker: ${cap(run.summary, 700)}`] : []),
    ...(run.task_contract ? [`- task_contract: ${run.task_contract.contract_sha256}; ALG delivery phase=${run.task_contract.input.phase}; requirements=${run.task_contract.requirements_sha256}`,
      `- ${TASK_DELIVERY_SCOPE_GUIDANCE}`] : ["- task_admission: legacy-unqualified"]),
    ...requestSourcePointer(run),
    ...allowancePointer(run),
    "- criteria:",
    "- Action evidence stays in attempt references. Evidence gaps do not authorize replay or a new remote submission.",
    ...(run.task_baseline ? [`- task_baseline: ${sha256Json(run.task_baseline)}; immutable before-first-child observations in alg_status(detail=full).task_baseline; do not recapture.`] : []),
    ...(run.criteria.length
      ? run.criteria.slice(0, COMPACTION_CRITERIA_COUNT).map((criterion) =>
          `  - ${cap(criterion, COMPACTION_CRITERION_CHARS)}`)
      : ["  (none)"]),
    `- path: .opencode/runs/${run.run_id}/`,
    "",
    "### Nodes",
  ]

  for (const definition of run.graph.nodes.slice(0, COMPACTION_NODE_COUNT)) {
    const node = run.nodes[definition.id]
    if (!node) continue
    const failures = node.last_failures
      .slice(0, COMPACTION_FAILURE_COUNT)
      .map((failure) => cap(failure, COMPACTION_FAILURE_CHARS))
    lines.push(
      `- ${node.id} [${node.agent}] ${node.status} attempts=${node.current_attempt}` +
      (failures.length ? ` failures=${failures.join(" | ")}` : ""),
    )
    const latest = node.attempts.at(-1)
    if (latest?.action_evidence_ref) lines.push(`  action_manifest=${latest.action_evidence_ref.sha256}; exact reference in alg_status attempt state`)
    if (latest?.outcome === "evidence_unavailable") lines.push("  evidence_unavailable: inspect retained records; do not replay the producer")
  }
  lines.push("", "Use alg_status / alg_resume / alg_artifact for authoritative details.")
  const context = lines.join("\n")
  if (utf8Bytes(context) <= MAX_COMPACTION_CONTEXT_BYTES) return context
  const suffix = "\n[ALG compaction summary truncated]"
  return `${truncateUtf8(context, MAX_COMPACTION_CONTEXT_BYTES - utf8Bytes(suffix))}${suffix}`
}

/** A run nobody has touched for this long is mentioned in one short notice instead of a full summary. */
export const STALE_RUN_AGE_MS = 7 * 24 * 60 * 60 * 1_000

export function isStaleRun(run: RunState, now = Date.now()): boolean {
  const updated = Date.parse(run.updated_at)
  return Number.isFinite(updated) && now - updated > STALE_RUN_AGE_MS
}

/**
 * An unfinished run is offered to its session before every model call. One that was abandoned would be
 * described in full forever, so after a week it shrinks to what is needed to pick it up or end it.
 */
export function formatStaleRunNotice(run: RunState): string {
  return [
    "## ALG unfinished run (not updated recently)",
    "",
    `- run_id: ${run.run_id}`,
    `- status: ${run.status}; last updated ${run.updated_at.slice(0, 10)}`,
    "- Continue it with alg_resume, or end it with alg_resume close=true if it will not be continued.",
  ].join("\n")
}

export interface SkillEvolutionCompactionInput {
  pendingKeys: string[]
  runningKeys: string[]
  candidateCount: number
  restartRequired: boolean
  capturedCount?: number
  missingCount?: number
  missingKeys?: string[]
  checkpoint?: string
}

function formatKeyList(keys: string[]): string {
  if (!keys.length) return "(none)"
  const visible = keys.slice(0, 16)
  const omitted = keys.length - visible.length
  return omitted > 0 ? `${visible.join(", ")} (+${omitted})` : visible.join(", ")
}

export function formatSkillEvolutionCompactionContext(input: SkillEvolutionCompactionInput): string {
  const lines = [
    "## ALG skill-evolution state (bounded)",
    "",
    "Live intake ignores summary:true recaps. Post-compact summaries are historical-only.",
    "Capture is best-effort, not a host compaction barrier or a full conversation backup.",
    `- evidence coverage: captured=${input.capturedCount ?? "unknown"} missing=${input.missingCount ?? "unknown"}`,
    `- missing evidence keys (including terminal rows): ${formatKeyList(input.missingKeys ?? [])}`,
    ...(input.missingCount ? ["- DEGRADED: evidence missing; never substitute the compaction summary for the original turn."] : []),
    ...(input.checkpoint ? [`- checkpoint: ${input.checkpoint}`] : []),
    "",
    "- path: .opencode/skill-evolution/",
    `- restart_required: ${input.restartRequired}`,
    `- candidates: ${input.candidateCount}`,
    `- session pending keys: ${formatKeyList(input.pendingKeys)}`,
    `- session running keys: ${formatKeyList(input.runningKeys)}`,
    "",
    "Use alg_skill_evolution_status / alg_skill_evolution_audit for authoritative details.",
  ]
  const context = lines.join("\n")
  if (utf8Bytes(context) <= MAX_COMPACTION_CONTEXT_BYTES) return context
  const suffix = "\n[ALG skill-evolution compaction summary truncated]"
  return `${truncateUtf8(context, MAX_COMPACTION_CONTEXT_BYTES - utf8Bytes(suffix))}${suffix}`
}

/** Only pass ALG-owned chunks here, in recovery-priority order. Never the host's shared array. */
export function capCompactionOutputContext(
  context: string[],
  maximumBytes = MAX_COMPACTION_OUTPUT_BYTES,
): void {
  const limit = Number.isFinite(maximumBytes) ? Math.max(0, Math.floor(maximumBytes)) : 0
  const joined = context.join("\n")
  if (utf8Bytes(joined) <= limit) return
  const suffix = "\n[ALG compaction context truncated]"
  context.length = 0
  if (limit < utf8Bytes(suffix)) return
  const text = `${truncateUtf8(joined, limit - utf8Bytes(suffix))}${suffix}`
  context.push(text)
}

export function appendAlgCompactionContext(shared: string[], owned: string[], maximumBytes = MAX_COMPACTION_OUTPUT_BYTES): void {
  capCompactionOutputContext(owned, maximumBytes)
  shared.push(...owned)
}

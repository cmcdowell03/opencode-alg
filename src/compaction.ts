import type { RunState } from "./types.ts"
import { truncateUtf8, utf8Bytes } from "./limits.ts"

export const MAX_COMPACTION_CONTEXT_BYTES = 16 * 1024
export const COMPACTION_GOAL_CHARS = 1_000
export const COMPACTION_CRITERIA_COUNT = 20
export const COMPACTION_CRITERION_CHARS = 300
export const COMPACTION_NODE_COUNT = 32
export const COMPACTION_FAILURE_COUNT = 3
export const COMPACTION_FAILURE_CHARS = 200

const INCOMPLETE_STATUSES = new Set(["planning", "running", "blocked"])

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

export function formatCompactionContext(run: RunState): string {
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
    "- criteria:",
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
  }
  lines.push("", "Use alg_status / alg_resume / alg_artifact for authoritative details.")
  const context = lines.join("\n")
  if (utf8Bytes(context) <= MAX_COMPACTION_CONTEXT_BYTES) return context
  const suffix = "\n[ALG compaction summary truncated]"
  return `${truncateUtf8(context, MAX_COMPACTION_CONTEXT_BYTES - utf8Bytes(suffix))}${suffix}`
}

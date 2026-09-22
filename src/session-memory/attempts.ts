import type { ExecuteOptions } from "../executor.ts"
import { executeRun } from "../executor.ts"
import { canonicalDirectory } from "../paths.ts"
import { loadRunForOwner } from "../store.ts"
import type { RunState } from "../types.ts"
import { hashObject } from "./store.ts"
import { shellGateHash } from "./preflight.ts"
import type { SessionMemoryRuntime } from "./runtime.ts"
import type { Operation, Checkpoint, RunCitation } from "./schemas.ts"

/** This adapter covers ALG run/resume only, never arbitrary shell/MCP calls. */
export async function executeWithMemory(memory: SessionMemoryRuntime | undefined, run: RunState, options: ExecuteOptions) {
  if (!memory?.enabled) return executeRun(run, options)
  const owner = options.parentSessionId
  let state: Checkpoint, candidates: Checkpoint["skills"]
  try {
    if (canonicalDirectory(options.worktree) !== memory.store.project) throw new Error("memory adapter project mismatch")
    try { state = memory.current(owner) }
    catch { return executeRun(run, options) }
    candidates = state.skills.filter((binding) => {
      const node = memory.store.node(binding.id, owner)
      return node.kind === "skill" && node.payload.operations.includes("alg_execute")
    })
  } catch (error) {
    if (memory.options.mode === "observe") return executeRun(run, options)
    throw error
  }
  // Delegation happens at the actual SDK create->prompt boundary, not in an event observer.
  const delegated: ExecuteOptions = { ...options, beforeChildPrompt: async (child, role) => {
    if (memory.options.mode === "assist") memory.delegate(owner, child, role)
    await options.beforeChildPrompt?.(child, role)
  } }
  if (!candidates.length) return executeRun(run, delegated)
  if (candidates.length !== 1 || !state.environment) {
    if (memory.options.mode === "observe") return executeRun(run, options)
    throw new Error("alg_execute requires exactly one applicable procedure and a reviewed environment")
  }
  // Only adapter-owned, non-secret dimensions; no command, goal, URL or output digest.
  // run and resume intentionally share identity, so changing verbs cannot bypass a failure.
  const operation: Operation = { adapter: "alg", operation: "alg_execute", resource: run.run_id,
    parameters_hash: hashObject({ dry: Boolean(options.dry || run.mode === "dry"), max_waves: options.maxWaves ?? null, max_concurrency: options.maxConcurrency ?? null }),
    environment: state.environment, skill: candidates[0]!.id, purpose: "action" }
  return memory.guarded(owner, operation, () => executeRun(run, delegated), (result) => {
    let run_citation: RunCitation | undefined
    try {
      const committed = loadRunForOwner(memory.store.project, result.run_id, owner)
      if (committed) run_citation = {
        run_id: committed.run_id,
        revision: committed.revision,
        shell_gate_hash: shellGateHash(committed),
        limits_hash: operation.parameters_hash,
      }
    } catch { /* an unreadable run is recorded without a citation and cannot block later */ }
    return {
      outcome: result.status === "done" ? "success" as const : result.status === "failed" ? "failure" as const : "indeterminate" as const,
      receipt: hashObject({ run_id: result.run_id, revision: result.revision, status: result.status,
        attempts: result.global_attempts, nodes: Object.values(result.nodes).map((node) => ({ id: node.id, status: node.status, attempt: node.current_attempt })) }),
      run_citation,
    }
  })
}

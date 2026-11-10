import { getTemplate } from "./templates.ts"
import { validateGraph } from "./graph.ts"
import { hashObject } from "./session-memory/store.ts"
import type { GraphDef, RunState } from "./types.ts"

export interface ManagedGraphPolicy {
  template: string; operation: string; reviewNode: string; investigation: true
}
const policies: Readonly<Record<string, ManagedGraphPolicy>> = Object.freeze({
  "data-investigation": Object.freeze({ template: "data-investigation", operation: "data.investigate.read", reviewNode: "confirm", investigation: true }),
})
/** Compiled policies only; model-authored graphs cannot register new execution authority. */
export function graphPolicy(graph: GraphDef): ManagedGraphPolicy | undefined { return policies[graph.name] }
export function assertManagedGraph(run: RunState, shellGate?: string): ManagedGraphPolicy | undefined {
  const policy = graphPolicy(run.graph)
  if (!policy && !run.investigation) return undefined
  if (!policy || !run.investigation) throw new Error("data-investigation plan has no managed investigation reference or policy")
  if (shellGate || hashObject(run.graph) !== hashObject(validateGraph(getTemplate(policy.template))))
    throw new Error("managed investigation graph and shell gates are fixed for Phase 1")
  return policy
}

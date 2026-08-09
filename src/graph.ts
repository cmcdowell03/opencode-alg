import type { GraphDef, NodeDef, NodeState, RunState } from "./types.ts"
import { parseGraph } from "./schemas.ts"

export class GraphError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "GraphError"
  }
}

/** Parse structural and semantic graph contracts. Always use the returned clone. */
export function validateGraph(raw: unknown): GraphDef {
  try {
    return parseGraph(raw)
  } catch (error) {
    throw new GraphError(error instanceof Error ? error.message : String(error))
  }
}

export function initNodeStates(graph: GraphDef): Record<string, NodeState> {
  const nodes = Object.create(null) as Record<string, NodeState>
  for (const node of graph.nodes) {
    nodes[node.id] = {
      id: node.id,
      agent: node.agent,
      status: "pending",
      attempts: [],
      current_attempt: 0,
      last_failures: [],
    }
  }
  return nodes
}

export function readyNodes(run: RunState): NodeDef[] {
  return run.graph.nodes.filter((definition) => {
    const state = run.nodes[definition.id]
    if (!state || (state.status !== "pending" && state.status !== "ready")) return false
    return definition.depends_on.every((dependency) => run.nodes[dependency]?.status === "done")
  })
}

export function allTerminal(run: RunState): boolean {
  return Object.values(run.nodes).every((node) =>
    node.status === "done" || node.status === "failed" || node.status === "skipped",
  )
}

export function anyFailed(run: RunState): boolean {
  return Object.values(run.nodes).some((node) => node.status === "failed")
}

/** Mark every pending descendant of a terminal failed/skipped dependency. */
export function skipFailedDescendants(run: RunState): boolean {
  let changed = false
  for (const definition of run.graph.nodes) {
    const state = run.nodes[definition.id]
    if (!state || (state.status !== "pending" && state.status !== "ready")) continue
    const terminalDependency = definition.depends_on.find((dependency) => {
      const status = run.nodes[dependency]?.status
      return status === "failed" || status === "skipped"
    })
    if (!terminalDependency) continue
    state.status = "skipped"
    state.last_failures = [`Dependency did not complete: ${terminalDependency}`]
    changed = true
  }
  return changed
}

export function descendantsOf(graph: GraphDef, nodeId: string): Set<string> {
  const descendants = new Set<string>()
  for (const node of graph.nodes) {
    if (node.depends_on.some((dependency) => dependency === nodeId || descendants.has(dependency))) {
      descendants.add(node.id)
    }
  }
  return descendants
}

export function resolveInputValue(expr: string, run: RunState): unknown {
  if (expr === "$goal") return run.goal
  if (expr === "$criteria") return run.criteria
  if (Object.hasOwn(run.nodes, expr)) return run.nodes[expr]?.output

  const dot = expr.indexOf(".")
  if (dot > 0) {
    const nodeId = expr.slice(0, dot)
    const output = run.nodes[nodeId]?.output
    return output === undefined ? undefined : getSafePath(output, expr.slice(dot + 1))
  }
  try {
    return JSON.parse(expr)
  } catch {
    // Graph validation rejects unquoted literals and missing references.
    return undefined
  }
}

function getSafePath(value: unknown, path: string): unknown {
  const parts = path.split(".")
  let current = value
  for (const part of parts) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(part) || part === "__proto__" || part === "constructor") {
      return undefined
    }
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, part)) return undefined
    current = (current as Record<string, unknown>)[part]
  }
  return current
}

export function wireInputs(definition: NodeDef, run: RunState): Record<string, unknown> {
  const inputs = Object.create(null) as Record<string, unknown>
  inputs.goal = run.goal
  inputs.criteria = run.criteria
  if (definition.inputs) {
    for (const [key, expression] of Object.entries(definition.inputs)) {
      inputs[key] = resolveInputValue(expression, run)
    }
  } else {
    for (const dependency of definition.depends_on) {
      inputs[dependency] = run.nodes[dependency]?.output
    }
  }
  return inputs
}

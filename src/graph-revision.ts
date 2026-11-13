import { z } from "zod"
import { sha256Json } from "./persistence.ts"
import { initNodeStates, validateGraph } from "./graph.ts"
import type { GraphDef, NodeDef, NodeState, RunState } from "./types.ts"

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const ChangedNodeDigestSchema = z.object({
  node_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  before_sha256: Sha256.nullable(),
  after_sha256: Sha256.nullable(),
}).strict()

/** Bounded, content-addressed receipt. Full graph versions live in run artifacts. */
export const GraphRevisionReceiptSchema = z.object({
  parent_sha256: Sha256,
  graph_sha256: Sha256,
  requested_by: z.string().min(1).max(256),
  created_at: z.iso.datetime({ offset: true }),
  reason: z.string().trim().min(1).max(500),
  changed_nodes: z.array(ChangedNodeDigestSchema).max(64),
}).strict()

export type GraphRevisionReceipt = z.infer<typeof GraphRevisionReceiptSchema>
export const GraphRevisionReceiptsSchema = z.array(GraphRevisionReceiptSchema).max(16)

export function graphSha256(graph: GraphDef): string {
  return sha256Json(graph)
}

function hasAttemptEvidence(state: NodeState): boolean {
  return state.current_attempt > 0 || state.attempts.length > 0 || state.attempt_history_ref !== undefined ||
    state.output !== undefined || state.output_ref !== undefined
}

function same<T>(left: T, right: T): boolean {
  return sha256Json(left) === sha256Json(right)
}

function nodeMap(graph: GraphDef): Map<string, NodeDef> {
  return new Map(graph.nodes.map((node) => [node.id, node]))
}

function effectiveAttempts(node: NodeDef): number {
  return node.loop?.max_attempts ?? 1
}

export interface GraphRevisionResult {
  graph: GraphDef
  nodes: Record<string, NodeState>
  receipt: GraphRevisionReceipt
}

/** Validate a bounded edit and prepare only graph plus state-map additions. */
export function reviseGraph(input: {
  run: RunState
  graph: unknown
  expectedGraphSha256: string
  requestedBy: string
  reason: string
  createdAt?: string
}): GraphRevisionResult {
  const { run } = input
  if (run.investigation) throw new Error("managed investigation graphs cannot be revised")
  if (run.status !== "planning" && run.status !== "blocked") {
    throw new Error("graph revisions are supported only for planning or blocked runs")
  }
  if (run.global_attempts >= run.graph.max_global_attempts) {
    throw new Error("the original global attempt budget is exhausted; graph revision rejected")
  }
  for (const [id, state] of Object.entries(run.nodes)) {
    if (!["pending", "ready", "running", "done", "failed", "skipped"].includes(state.status)) {
      throw new Error(`unknown node outcome for ${id}; graph revision rejected`)
    }
    if (state.status === "running") throw new Error(`node ${id} is running; graph revision rejected`)
  }

  const currentHash = graphSha256(run.graph)
  if (!/^[a-f0-9]{64}$/.test(input.expectedGraphSha256) || input.expectedGraphSha256 !== currentHash) {
    throw new Error("stale graph revision: expected_graph_sha256 must match the current graph")
  }
  const graph = validateGraph(input.graph)
  if (graph.name !== run.graph.name) throw new Error("graph revision cannot change the original graph identity")
  if (graph.max_global_attempts !== run.graph.max_global_attempts) {
    throw new Error("graph revision cannot change the original global attempt cap")
  }
  if (graph.max_concurrency !== run.graph.max_concurrency) {
    throw new Error("graph revision cannot change the original concurrency cap")
  }

  const oldDefs = nodeMap(run.graph)
  const nextDefs = nodeMap(graph)
  for (const oldNode of run.graph.nodes) {
    const state = run.nodes[oldNode.id]
    if (!state) throw new Error(`missing state for existing graph node ${oldNode.id}`)
    const next = nextDefs.get(oldNode.id)
    const changed = !next || !same(oldNode, next)
    if (changed && state.status !== "pending") {
      throw new Error(`only pending node definitions may change (${oldNode.id})`)
    }
    if (changed && hasAttemptEvidence(state)) {
      throw new Error(`node ${oldNode.id} has attempted evidence and cannot be edited or removed`)
    }
    if (next && oldNode.agent !== next.agent) {
      throw new Error(`graph revision cannot change the worker role for ${oldNode.id}`)
    }
    if (next && effectiveAttempts(next) > effectiveAttempts(oldNode)) {
      throw new Error(`graph revision cannot raise the local attempt cap for ${oldNode.id}`)
    }
    if (next && !same(oldNode.shell_gate ?? null, next.shell_gate ?? null)) {
      throw new Error(`graph revision cannot change the existing shell gate for ${oldNode.id}`)
    }
    if (!next && oldNode.agent === "checker") {
      throw new Error(`existing checker ${oldNode.id} cannot be removed`)
    }
    if (oldNode.agent === "checker" && next && !same(oldNode, next)) {
      throw new Error(`existing checker ${oldNode.id} and its verifier edges are immutable`)
    }
    if (next) {
      const nextDependencies = new Set(next.depends_on)
      if (oldNode.depends_on.some((dependency) => !nextDependencies.has(dependency))) {
        throw new Error(`graph revision cannot remove existing dependency/verifier edges from ${oldNode.id}`)
      }
      if (oldNode.feedback_to !== next.feedback_to) {
        throw new Error(`graph revision cannot change feedback routing for ${oldNode.id}`)
      }
    }
  }

  for (const node of graph.nodes) {
    if (oldDefs.has(node.id)) continue
    if (node.feedback_to) throw new Error(`new node ${node.id} cannot introduce feedback loops`)
  }

  const originalBudget = run.graph.max_global_attempts
  const revisedCapacity = graph.nodes.reduce((sum, node) => sum + effectiveAttempts(node), 0)
  if (revisedCapacity > originalBudget) {
    throw new Error("revised graph node capacity exceeds the original global attempt cap")
  }

  const nodes = { ...run.nodes }
  const initial = initNodeStates(graph)
  for (const node of graph.nodes) {
    if (!oldDefs.has(node.id)) nodes[node.id] = initial[node.id]!
  }
  for (const oldNode of run.graph.nodes) {
    if (!nextDefs.has(oldNode.id)) delete nodes[oldNode.id]
  }

  const changedIds = [...new Set([...oldDefs.keys(), ...nextDefs.keys()])]
    .filter((id) => !same(oldDefs.get(id) ?? null, nextDefs.get(id) ?? null))
    .sort()
  if (!changedIds.length) throw new Error("graph revision contains no changes")
  const createdAt = input.createdAt ?? new Date().toISOString()
  const receipt = GraphRevisionReceiptSchema.parse({
    parent_sha256: currentHash,
    graph_sha256: graphSha256(graph),
    requested_by: input.requestedBy,
    created_at: createdAt,
    reason: input.reason,
    changed_nodes: changedIds.map((node_id) => ({
      node_id,
      before_sha256: oldDefs.has(node_id) ? sha256Json(oldDefs.get(node_id)) : null,
      after_sha256: nextDefs.has(node_id) ? sha256Json(nextDefs.get(node_id)) : null,
    })),
  })
  return { graph, nodes, receipt }
}

import { MemoryStore } from "./store.ts"
import type { Checkpoint, StoredNode } from "./schemas.ts"
import { loadExperience } from "../experience.ts"
import { verifyResolutionEvidence } from "./experience-adapter.ts"

/** Check scope and revocation before inspecting a node's content or following edges. */
export function retrieve(store: MemoryStore, checkpoint: Checkpoint) {
  const nodes: StoredNode[] = [], selected = new Set<string>(), reasons: string[] = []
  const queue = [...checkpoint.pins].reverse().map((id) => ({ id, depth: 0 }))
  let edges = 0, omitted = 0
  while (queue.length) {
    const item = queue.shift()!
    if (selected.has(item.id)) continue
    if (nodes.length >= 24) { omitted += 1 + queue.length; break }
    const node = store.node(item.id, checkpoint.owner)
    if (node.kind === "result") {
      if (node.payload.task_epoch !== checkpoint.task_epoch || node.payload.environment !== checkpoint.environment) { omitted++; continue }
      store.readArtifact(node.payload.artifact)
      if (node.payload.tool_evidence) store.readArtifact(node.payload.tool_evidence)
    }
    if (node.kind === "evidence") loadExperience(store.project, node.payload.experience_id)
    if (node.kind === "resolution") verifyResolutionEvidence(store, checkpoint.owner, node.payload.verification)
    if ((node.kind === "resolution" || node.kind === "attempt") &&
      (Date.parse(node.payload.expires_at) <= Date.now() ||
        (node.kind === "resolution" ? node.payload.environment : node.payload.operation.environment) !== checkpoint.environment ||
        !checkpoint.skills.some((binding) => binding.id === (node.kind === "resolution" ? node.payload.skill : node.payload.operation.skill)))) {
      reasons.push(`stale/inapplicable ${item.id}`); omitted++; continue
    }
    selected.add(item.id); nodes.push(node)
    if (item.depth >= 2) { omitted += node.relations.length; continue }
    for (const edge of node.relations) {
      if (edges++ >= 48) { omitted++; continue }
      queue.push({ id: edge.id, depth: item.depth + 1 })
    }
  }
  return { nodes, omitted, reasons }
}

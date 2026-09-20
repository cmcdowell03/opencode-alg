import { loadExperience } from "../experience.ts"
import { incidentHistory } from "../troubleshooter.ts"
import { MemoryStore } from "./store.ts"

/** Explicit operator import. A reference is not permission to share its source. */
export function importEvidence(store: MemoryStore, owner: string, id: string): string {
  const evidence = loadExperience(store.project, id)
  return store.putNode({ schema_version: 1, project: store.projectId, owner, visibility: "session", created_at: evidence.observed_at,
    kind: "evidence", summary: evidence.summary, relations: [], payload: { experience_id: id } })
}
export function verifyResolutionEvidence(store: MemoryStore, owner: string, reference: string) {
  const node = store.node(reference, owner)
  if (node.kind !== "evidence") throw new Error("resolution requires an evidence reference")
  const evidence = loadExperience(store.project, node.payload.experience_id)
  if (evidence.kind !== "outcome" || evidence.status !== "success" || !evidence.relations.some((edge) => edge.kind === "tests")) {
    throw new Error("resolution requires a successful outcome with a tests relation")
  }
  for (const edge of evidence.relations) loadExperience(store.project, edge.id)
  return evidence
}

/** Explicit import only: history scanning never runs in the per-turn retrieval path. */
export function importIncidentVerification(store: MemoryStore, owner: string, incidentId: string): string {
  const latest = incidentHistory(store.project, incidentId).at(-1)
  if (latest?.source.type !== "incident-resolved" || latest.status !== "success") throw new Error("incident is not currently resolved")
  const verification = latest.relations.filter((edge) => edge.kind === "supports").map((edge) => loadExperience(store.project, edge.id))
    .find((evidence) => evidence.kind === "outcome" && evidence.status === "success" && evidence.group === incidentId && evidence.relations.some((edge) => edge.kind === "tests"))
  if (!verification) throw new Error("incident has no successful verification")
  return importEvidence(store, owner, verification.id)
}

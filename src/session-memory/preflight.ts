import { loadRunForOwner } from "../store.ts"
import type { RunState } from "../types.ts"
import { OperationSchema, type Checkpoint, type Operation, type RunCitation } from "./schemas.ts"
import { MemoryStore, hashObject } from "./store.ts"
import { verifyEnvironment } from "./environment.ts"
import { verifyResolutionEvidence } from "./experience-adapter.ts"

export function operationSignature(raw: Operation): string {
  const { purpose: _purpose, ...identity } = OperationSchema.parse(raw)
  return hashObject(identity)
}

export function shellGateHash(run: RunState): string {
  const gate = run.graph.nodes.find((node) => node.agent === "implementer")?.shell_gate ?? null
  return hashObject(gate)
}

export interface PreflightDecision {
  allowed: boolean
  signature: string
  reason: string
  retry?: string
  gap?: string
}

/** A failure pin blocks only while the committed run still shows that same failure. */
export function committedFailureDecision(store: MemoryStore, owner: string, citation: RunCitation, operation: Operation): PreflightDecision {
  const signature = operationSignature(operation)
  let run: RunState | null
  try {
    run = loadRunForOwner(store.project, citation.run_id, owner)
  } catch {
    return { allowed: true, signature, reason: `committed run ${citation.run_id} is unreadable; retry memory will not block`, gap: `committed run ${citation.run_id} is unreadable; retry memory will not block` }
  }
  if (!run) return { allowed: true, signature, reason: `committed run ${citation.run_id} is unreadable; retry memory will not block`, gap: `committed run ${citation.run_id} is unreadable; retry memory will not block` }
  const reasons: string[] = []
  if (run.revision !== citation.revision) reasons.push("revision moved")
  if (shellGateHash(run) !== citation.shell_gate_hash) reasons.push("shell gate changed")
  if (operation.parameters_hash !== citation.limits_hash) reasons.push("limits changed")
  if (reasons.length) {
    const gap = `committed run ${citation.run_id} ${reasons.join(", ")}; retry memory will not block`
    return { allowed: true, signature, reason: gap, gap }
  }
  return { allowed: false, signature, reason: `unchanged failed attempt on run ${citation.run_id}; operator must authorize a scoped retry or changed conditions` }
}

export function preflight(store: MemoryStore, checkpoint: Checkpoint, raw: Operation): PreflightDecision {
  const operation = OperationSchema.parse(raw)
  verifyEnvironment(store, checkpoint)
  if (operation.environment !== checkpoint.environment || !checkpoint.skills.some((binding) => binding.id === operation.skill)) throw new Error("operation scope differs from active bindings")
  const signature = operationSignature(operation)
  // These purposes are assigned by an integrated adapter, not by model tool arguments.
  if (operation.purpose === "poll" || operation.purpose === "verify") return { allowed: true, signature, reason: `adapter ${operation.purpose}` }
  const retry = checkpoint.pins.map((id) => store.node(id, checkpoint.owner)).find((node) =>
    node.kind === "retry" && node.payload.signature === signature && Date.parse(node.payload.expires_at) > Date.now() && !checkpoint.used_retries.includes(node.id))
  if (retry) return { allowed: true, signature, retry: retry.id, reason: "exact single-use operator retry" }
  if (operation.purpose !== "action") return { allowed: false, signature, reason: "scoped operator retry required" }
  for (const id of [...checkpoint.pins].reverse()) {
    const node = store.node(id, checkpoint.owner)
    if (node.kind === "resolution" && node.payload.signature === signature && Date.parse(node.payload.expires_at) > Date.now()) {
      verifyResolutionEvidence(store, checkpoint.owner, node.payload.verification)
      return { allowed: false, signature, reason: `verified solution ${id}; resume at ${node.payload.next_step}` }
    }
    if (node.kind === "attempt" && node.payload.outcome === "failure" && Date.parse(node.payload.expires_at) > Date.now() &&
      node.payload.operation.adapter === operation.adapter && node.payload.operation.operation === operation.operation &&
      node.payload.operation.resource === operation.resource && node.payload.operation.environment === operation.environment &&
      node.payload.operation.skill === operation.skill) {
      if (!node.payload.run_citation) {
        const gap = `attempt ${id} has no committed-run citation; the limits-only signature is not an unchanged failure`
        return { allowed: true, signature, reason: gap, gap }
      }
      const decision = committedFailureDecision(store, checkpoint.owner, node.payload.run_citation, operation)
      if (!decision.allowed) return { ...decision, reason: `unchanged failed attempt ${id}; operator must authorize a scoped retry or changed conditions` }
      return decision
    }
  }
  return { allowed: true, signature, reason: "no applicable exact repeat" }
}

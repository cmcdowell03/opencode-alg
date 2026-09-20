import { OperationSchema, type Checkpoint, type Operation } from "./schemas.ts"
import { MemoryStore, hashObject } from "./store.ts"
import { verifyEnvironment } from "./environment.ts"
import { verifyResolutionEvidence } from "./experience-adapter.ts"

export function operationSignature(raw: Operation): string {
  const { purpose: _purpose, ...identity } = OperationSchema.parse(raw)
  return hashObject(identity)
}
export function preflight(store: MemoryStore, checkpoint: Checkpoint, raw: Operation) {
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
    if (node.kind === "attempt" && node.payload.signature === signature && node.payload.outcome === "failure" && Date.parse(node.payload.expires_at) > Date.now()) {
      return { allowed: false, signature, reason: `unchanged failed attempt ${id}; operator must authorize a scoped retry or changed conditions` }
    }
  }
  return { allowed: true, signature, reason: "no applicable exact repeat" }
}

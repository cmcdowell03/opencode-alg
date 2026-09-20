import { existsSync } from "node:fs"
import { hostname, platform } from "node:os"
import { EnvironmentSchema, type Checkpoint } from "./schemas.ts"
import { MemoryStore, hashObject } from "./store.ts"

/** Passive hints only; never read mounted tokens, enumerate env values, or probe ports. */
export function localOrigin() {
  return { id: hashObject([platform(), hostname(), existsSync("/.dockerenv"), Boolean(process.env.KUBERNETES_SERVICE_HOST)]), platform: platform(),
    hint: existsSync("/.dockerenv") ? "container-signal" : "unknown", authority: "observation-only" }
}
export function publishEnvironment(store: MemoryStore, raw: unknown): string {
  const payload = EnvironmentSchema.parse(raw)
  const id = store.putNode({ schema_version: 1, project: store.projectId, owner: null, visibility: "project",
    created_at: payload.verified_at, kind: "environment", summary: `Reviewed environment ${payload.name}`, relations: [], payload })
  store.publish(id)
  return id
}
export function verifyEnvironment(store: MemoryStore, checkpoint: Checkpoint, now = Date.now()) {
  if (!checkpoint.environment) return null
  const node = store.node(checkpoint.environment, checkpoint.owner)
  if (node.kind !== "environment") throw new Error("invalid environment binding")
  if (node.payload.origin_fingerprint !== localOrigin().id) throw new Error("execution origin changed; select a newly reviewed environment profile")
  if (Date.parse(node.payload.verified_at) > now || Date.parse(node.payload.expires_at) <= now) throw new Error("environment verification stale; revalidate current permissions")
  return node
}

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { canonicalJson } from "../src/persistence.ts"
import { EnvironmentMemoryEngine } from "../src/environment-memory/index.ts"
import type { Entity, EnvironmentMemoryOperation, Provenance, ReadScope, Relation } from "../src/environment-memory/index.ts"
import { LocalDirectoryObjectStore } from "../src/environment-memory/object-store.ts"
import { replicateEnvironmentMemory, restoreEnvironmentMemory } from "../src/environment-memory/replication.ts"

const roots: string[] = []
function directory() { const root = mkdtempSync(join(tmpdir(), "alg-environment-lifecycle-")); roots.push(root); return root }
afterEach(async () => {
  for (const root of roots.splice(0)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try { rmSync(root, { recursive: true, force: true }); break }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EBUSY" || attempt === 4) throw error
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  }
})

const scope: ReadScope = { namespace: "synthetic-world", project: "lifecycle-project", owner: "session-reader" }
let now = new Date("2026-09-23T12:00:00.000Z")
function evidence(source_ref: string, expires_at: string | null = null): Provenance {
  return { source_type: "synthetic", source_ref, classification: "observed",
    observed_at: "2026-09-23T12:00:00.000Z", verified_at: "2026-09-23T12:00:00.000Z", expires_at }
}
function entity(id: string, kind: Entity["kind"], metadata: Entity["metadata"] = {}): Entity {
  return { id, kind, label: id, metadata, scope: { ...scope, visibility: "project", owner: null },
    provenance: evidence("fixture:world-v1") }
}
function relation(id: string, source_id: string, target_id: string, kind: Relation["kind"],
  principal_ref: string | null = null, provenance = evidence("fixture:world-v1")): Relation {
  return { id, source_id, target_id, kind, scope: { ...scope, visibility: "project", owner: null }, provenance,
    conditions: { principal_ref, restrictions: ["synthetic-only"], valid_from: null, valid_until: null } }
}
async function open(path: string) {
  return EnvironmentMemoryEngine.open({ databasePath: join(path, "memory.sqlite"), namespace: scope.namespace,
    cacheEntries: 32, now: () => now })
}

describe("synthetic environment lifecycle", () => {
  test("compaction-style snapshots, restarts, route change, expiry, revocation, and recovery retain scoped evidence", async () => {
    now = new Date("2026-09-23T12:00:00.000Z")
    const sourceDir = directory()
    let engine = await open(sourceDir)
    const store = await LocalDirectoryObjectStore.open({ directory: directory() })
    let revision = 0
    const append = (operation: EnvironmentMemoryOperation, key: string) => {
      const receipt = engine.append(operation, { expected_revision: revision, idempotency_key: key })
      revision = receipt.revision
    }
    try {
      const world: Entity[] = [
        entity("pc", "host"), entity("pod", "pod"), entity("gateway", "network"),
        entity("api", "api"), entity("docs-api", "api"), entity("replacement-api", "api"),
        entity("repository", "repository"), entity("deployment", "deployment"), entity("database", "database"),
        entity("principal-reader", "principal"), entity("principal-guest", "principal"),
        entity("solution-connect", "resource", { category: "solution", skill_ref: "skill:connect" }),
      ]
      for (const item of world) append({ type: "upsert_entity", entity: item }, "entity:" + item.id)
      const relationships = [
        relation("pod-runs-on-pc", "pod", "pc", "runs-on"),
        relation("pod-routes-gateway", "pod", "gateway", "routes-through"),
        relation("gateway-api-reader", "gateway", "api", "reaches", "principal-reader"),
        relation("api-database-reader", "api", "database", "reads-from", "principal-reader"),
        relation("gateway-docs-guest", "gateway", "docs-api", "reaches", "principal-guest"),
        relation("deployment-source", "deployment", "repository", "deployed-from"),
        relation("deployment-pod", "deployment", "pod", "runs-on"),
        relation("reader-authorized-database", "principal-reader", "database", "authorized-for", "principal-reader"),
        relation("guest-authorized-docs", "principal-guest", "docs-api", "authorized-for", "principal-guest"),
        relation("gateway-temporary", "gateway", "replacement-api", "reaches", "principal-reader",
          evidence("fixture:temporary-route", "2026-09-23T12:01:00.000Z")),
      ]
      for (const item of relationships) append({ type: "upsert_relation", relation: item }, "relation:" + item.id)

      const beforeCompaction = engine.exportSnapshot()
      const beforeQuery = engine.query({ scope, roots: ["gateway"], max_depth: 4, max_nodes: 64, now: now.toISOString() })
      expect(beforeQuery.relations.find((item) => item.id === "gateway-api-reader")?.conditions.principal_ref).toBe("principal-reader")
      expect(beforeQuery.relations.find((item) => item.id === "gateway-docs-guest")?.conditions.principal_ref).toBe("principal-guest")
      const readerAccess = engine.get("reader-authorized-database", scope)
      const guestAccess = engine.get("guest-authorized-docs", scope)
      expect(readerAccess && "conditions" in readerAccess ? readerAccess.conditions.principal_ref : null).toBe("principal-reader")
      expect(guestAccess && "conditions" in guestAccess ? guestAccess.conditions.principal_ref : null).toBe("principal-guest")
      expect(beforeCompaction.entities.find((item) => item.id === "solution-connect")?.metadata.skill_ref).toBe("skill:connect")

      const initialReplication = await replicateEnvironmentMemory(engine, store)
      expect(initialReplication.remote.pending_lag).toBe(0)

      append({ type: "upsert_relation", relation: relation("gateway-replacement-reader", "gateway", "replacement-api", "reaches", "principal-reader") }, "route:replacement")
      append({ type: "revoke", target_type: "relation", target_id: "gateway-api-reader", reason: "synthetic route change",
        provenance: evidence("fixture:route-change") }, "revoke:old-route")
      append({ type: "upsert_entity", entity: entity("solution-after-change", "resource", { category: "solution", skill_ref: "skill:connect" }) }, "solution:post-change")

      for (let cycle = 0; cycle < 3; cycle += 1) {
        const before = canonicalJson(engine.exportSnapshot())
        engine.close()
        engine = await open(sourceDir)
        expect(engine.status().revision).toBe(revision)
        expect(canonicalJson(engine.exportSnapshot())).toBe(before)
      }

      now = new Date("2026-09-23T12:02:00.000Z")
      const afterChange = engine.query({ scope, roots: ["gateway"], max_depth: 4, max_nodes: 64, now: now.toISOString() })
      expect(afterChange.relations.some((item) => item.id === "gateway-api-reader")).toBe(false)
      expect(afterChange.relations.some((item) => item.id === "gateway-replacement-reader")).toBe(true)
      expect(afterChange.relations.some((item) => item.id === "gateway-temporary")).toBe(false)
      expect(afterChange.stale_count).toBeGreaterThan(0)

      let receipt = await replicateEnvironmentMemory(engine, store, { eventLimit: 2 })
      let rounds = 0
      while (receipt.remote.pending_lag > 0 && rounds < 10) {
        receipt = await replicateEnvironmentMemory(engine, store, { eventLimit: 2 })
        rounds += 1
      }
      expect(receipt.remote.pending_lag).toBe(0)

      const recovered = await open(directory())
      try {
        const restored = await restoreEnvironmentMemory(recovered, store)
        expect(restored.revision).toBe(revision)
        const recoveredQuery = recovered.query({ scope, roots: ["gateway"], max_depth: 4, max_nodes: 64, now: now.toISOString() })
        expect(recoveredQuery.relations.some((item) => item.id === "gateway-api-reader")).toBe(false)
        expect(recoveredQuery.relations.some((item) => item.id === "gateway-replacement-reader")).toBe(true)
        expect(recoveredQuery.relations.some((item) => item.id === "gateway-temporary")).toBe(false)
        const recoveredSolution = recovered.get("solution-after-change", scope)
        expect(recoveredSolution && "metadata" in recoveredSolution ? recoveredSolution.metadata.skill_ref : null).toBe("skill:connect")
      } finally { recovered.close() }
    } finally { engine.close() }
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { createHash } from "node:crypto"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EnvironmentMemoryEngine, EnvironmentMemoryError } from "../src/environment-memory/index.ts"
import type { Entity, Provenance, ReadScope, Relation } from "../src/environment-memory/index.ts"
import { canonicalJson } from "../src/persistence.ts"

const roots: string[] = []
function directory() { const root = mkdtempSync(join(tmpdir(), "alg-environment-memory-")); roots.push(root); return root }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const scope: ReadScope = { namespace: "synthetic-world", project: "alg-demo", owner: "session-a" }
let clock = new Date("2026-09-23T12:00:00.000Z")
const provenance = (overrides: Partial<Provenance> = {}): Provenance => ({ source_type: "synthetic", source_ref: "fixture:world-v1",
  classification: "observed", observed_at: "2026-09-23T11:00:00.000Z", verified_at: "2026-09-23T11:00:00.000Z",
  expires_at: null, ...overrides })
const entity = (id: string, overrides: Partial<Entity> = {}): Entity => ({ id, kind: "resource", label: id,
  metadata: {}, scope: { ...scope, visibility: "project", owner: null }, provenance: provenance(), ...overrides })
const relation = (id: string, source_id: string, target_id: string, overrides: Partial<Relation> = {}): Relation => ({
  id, source_id, target_id, kind: "reaches", scope: { ...scope, visibility: "project", owner: null }, provenance: provenance(),
  conditions: { principal_ref: "reader-a", restrictions: ["read-only"], valid_from: null, valid_until: null }, ...overrides,
})
async function open(path: string, extra: Partial<Parameters<typeof EnvironmentMemoryEngine.open>[0]> = {}) {
  return EnvironmentMemoryEngine.open({ databasePath: join(path, "memory.sqlite"), namespace: scope.namespace,
    now: () => clock, ...extra })
}
function append(engine: EnvironmentMemoryEngine, operation: Parameters<EnvironmentMemoryEngine["append"]>[0], revision: number, key: string) {
  return engine.append(operation, { expected_revision: revision, idempotency_key: key })
}
function upsertEntity(engine: EnvironmentMemoryEngine, value: Entity, revision: number, key = `entity:${value.id}`) {
  return append(engine, { type: "upsert_entity", entity: value }, revision, key)
}

describe("environment memory SQLite core", () => {
  test("commits, reopens, detects concurrent revisions, and deduplicates idempotency keys", async () => {
    const root = directory(), first = await open(root), second = await open(root)
    try {
      const receipt = upsertEntity(first, entity("host-a"), 0)
      expect(receipt).toMatchObject({ revision: 1, idempotent: false, durability: "local-sqlite-commit" })
      expect(upsertEntity(first, entity("host-a"), 0).idempotent).toBe(true)
      expect(() => append(first, { type: "upsert_entity", entity: entity("other") }, 0, "other"))
        .toThrow(expect.objectContaining({ code: "CONFLICT" }))
      upsertEntity(second, entity("host-a", { label: "updated" }), 1, "update-host")
      const updated = first.get("host-a", scope)
      expect(updated && "label" in updated ? updated.label : null).toBe("updated")
      first.close()
      const reopened = await open(root)
      try { expect(reopened.get("host-a", scope)).toMatchObject({ label: "updated", revision: 2 }) }
      finally { reopened.close() }
    } finally { second.close(); first.close() }
  })

  test("rolls back dangling relations and enforces globally unique, irreversible identities", async () => {
    const root = directory(), engine = await open(root)
    try {
      upsertEntity(engine, entity("source"), 0)
      expect(() => append(engine, { type: "upsert_relation", relation: relation("bad-edge", "source", "absent") }, 1, "bad-edge"))
        .toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
      expect(engine.status().revision).toBe(1)
      upsertEntity(engine, entity("target"), 1)
      append(engine, { type: "upsert_relation", relation: relation("edge", "source", "target") }, 2, "edge")
      append(engine, { type: "revoke", target_type: "entity", target_id: "target", reason: "synthetic route withdrawn", provenance: provenance() }, 3, "revoke-target")
      expect(engine.get("target", scope)).toBeNull()
      expect(engine.get("edge", scope)).toBeNull()
      expect(() => upsertEntity(engine, entity("target"), 4, "resurrect-target"))
        .toThrow(expect.objectContaining({ code: "CONFLICT" }))
      expect(engine.status()).toMatchObject({ revision: 4, entities: 1, relations: 0 })
    } finally { engine.close() }
  })

  test("isolates owner scope, reevaluates expiry, and keeps principal-specific route evidence", async () => {
    const root = directory(), engine = await open(root)
    try {
      upsertEntity(engine, entity("gateway"), 0)
      upsertEntity(engine, entity("api"), 1)
      append(engine, { type: "upsert_relation", relation: relation("route-reader-a", "gateway", "api") }, 2, "route-a")
      const privateEntity = entity("private", { scope: { ...scope, visibility: "session", owner: "session-a" },
        provenance: provenance({ expires_at: "2026-09-23T12:00:01.000Z" }) })
      upsertEntity(engine, privateEntity, 3)
      expect(engine.get("private", { ...scope, owner: "session-b" })).toBeNull()
      const query = engine.query({ scope, roots: ["gateway"], now: clock.toISOString() })
      expect(query.relations[0]?.conditions).toEqual({ principal_ref: "reader-a", restrictions: ["read-only"], valid_from: null, valid_until: null })
      expect(query.paths).toContainEqual({ root_id: "gateway", entity_ids: ["gateway", "api"], relation_ids: ["route-reader-a"] })
      clock = new Date("2026-09-23T12:00:02.000Z")
      expect(engine.get("private", scope)).toBeNull()
      expect(engine.query({ scope, roots: ["private"], now: clock.toISOString() })).toMatchObject({ stale_count: 1, entities: [] })
    } finally { engine.close(); clock = new Date("2026-09-23T12:00:00.000Z") }
  })

  test("bounds the LRU and traversal and reports capacity failures", async () => {
    const root = directory(), engine = await open(root, { cacheEntries: 1, maxRecordBytes: 1024, maxSnapshotBytes: 2048 })
    try {
      upsertEntity(engine, entity("a"), 0)
      upsertEntity(engine, entity("b"), 1)
      engine.get("a", scope); engine.get("b", scope)
      expect(engine.status().cache).toMatchObject({ entries: 1, evictions: 1, capacity: 1 })
      expect(() => upsertEntity(engine, entity("huge", { metadata: { payload: "x".repeat(1500) } }), 2, "huge"))
        .toThrow(expect.objectContaining({ code: "CAPACITY" }))
      expect(engine.query({ scope, roots: ["a"], max_nodes: 1, max_depth: 0 })).toMatchObject({ omitted_count: 0 })
    } finally { engine.close() }
  })

  test("snapshot plus contiguous journal replay reconstructs current state and rejects corruption", async () => {
    const sourceRoot = directory(), targetRoot = directory(), source = await open(sourceRoot), target = await open(targetRoot)
    try {
      upsertEntity(source, entity("host"), 0)
      upsertEntity(source, entity("api"), 1)
      const snapshot = source.exportSnapshot()
      target.restoreSnapshot(snapshot)
      append(source, { type: "upsert_relation", relation: relation("route", "host", "api", { kind: "routes-through" }) }, 2, "route")
      const batch = source.eventsSince(snapshot.revision)!
      expect(batch).toMatchObject({ from_revision: 2, to_revision: 3, previous_hash: snapshot.event_hash })
      const corrupt = structuredClone(batch)
      corrupt.events[0]!.content_hash = "0".repeat(64)
      expect(() => target.replay(corrupt)).toThrow(expect.objectContaining({ code: "CORRUPTION" }))
      target.replay(batch)
      expect(target.exportSnapshot()).toEqual(source.exportSnapshot())
      expect(() => target.restoreSnapshot(snapshot)).toThrow(expect.objectContaining({ code: "CONFLICT" }))
    } finally { target.close(); source.close() }
  })

  test("restored snapshots retain revoked identities and historical idempotency receipts", async () => {
    const source = await open(directory()), destination = await open(directory())
    try {
      const original = entity("retired")
      const first = upsertEntity(source, original, 0)
      append(source, { type: "revoke", target_type: "entity", target_id: "retired", reason: "retired", provenance: provenance() }, 1, "revoke-retired")
      destination.restoreSnapshot(source.exportSnapshot())
      expect(append(destination, { type: "upsert_entity", entity: original }, 0, "entity:retired"))
        .toMatchObject({ revision: first.revision, event_hash: first.event_hash, idempotent: true })
      expect(() => upsertEntity(destination, original, 2, "resurrect-retired"))
        .toThrow(expect.objectContaining({ code: "CONFLICT" }))
      expect(destination.status().revision).toBe(2)
    } finally { source.close(); destination.close() }
  })

  test("snapshot plus invalid replay rolls back together", async () => {
    const source = await open(directory()), destination = await open(directory())
    try {
      upsertEntity(source, entity("source"), 0)
      const snapshot = source.exportSnapshot()
      const input = { schema_version: 1 as const, namespace: scope.namespace, revision: 2, previous_hash: snapshot.event_hash,
        timestamp: clock.toISOString(), idempotency_key: "dangling", operation: { type: "upsert_relation" as const,
          relation: relation("dangling", "source", "missing") } }
      const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex")
      const content_hash = digest(input)
      const event_hash = digest({ content_hash, namespace: input.namespace, revision: input.revision, previous_hash: input.previous_hash })
      const event = { ...input, content_hash, event_hash }
      expect(() => destination.restoreWithReplay(snapshot, [{ schema_version: 1, namespace: scope.namespace,
        from_revision: 1, to_revision: 2, previous_hash: snapshot.event_hash, events: [event] }]))
        .toThrow(expect.objectContaining({ code: "NOT_FOUND" }))
      expect(destination.status()).toMatchObject({ revision: 0, entities: 0, relations: 0 })
      expect(destination.exportSnapshot()).toMatchObject({ identities: [], idempotency: [] })
    } finally { source.close(); destination.close() }
  })

  test("snapshot restore rejects relations that broaden private endpoint visibility", async () => {
    const source = await open(directory()), destination = await open(directory())
    try {
      upsertEntity(source, entity("private", { scope: { ...scope, visibility: "session", owner: "session-a" } }), 0)
      upsertEntity(source, entity("public"), 1)
      append(source, { type: "upsert_relation", relation: relation("private-edge", "private", "public", {
        scope: { ...scope, visibility: "session", owner: "session-a" },
      }) }, 2, "private-edge")
      const snapshot = source.exportSnapshot()
      snapshot.relations[0]!.scope = { ...scope, visibility: "project", owner: null }
      expect(() => destination.restoreSnapshot(snapshot)).toThrow(expect.objectContaining({ code: "CORRUPTION" }))
      expect(destination.status()).toMatchObject({ revision: 0, entities: 0, relations: 0 })
    } finally { source.close(); destination.close() }
  })

  test("direct reads recheck relation time, endpoints and return defensive copies", async () => {
    const engine = await open(directory())
    try {
      upsertEntity(engine, entity("source"), 0)
      upsertEntity(engine, entity("target", { provenance: provenance({ expires_at: "2026-09-23T12:00:03.000Z" }) }), 1)
      append(engine, { type: "upsert_relation", relation: relation("scheduled", "source", "target", {
        conditions: { principal_ref: "reader-a", restrictions: [], valid_from: "2026-09-23T12:00:01.000Z", valid_until: null },
      }) }, 2, "scheduled")
      expect(engine.get("scheduled", scope)).toBeNull()
      clock = new Date("2026-09-23T12:00:02.000Z")
      const found = engine.get("scheduled", scope) as Relation
      expect(found.id).toBe("scheduled")
      found.conditions.restrictions.push("mutated by caller")
      expect((engine.get("scheduled", scope) as Relation).conditions.restrictions).toEqual([])
      clock = new Date("2026-09-23T12:00:04.000Z")
      expect(engine.get("scheduled", scope)).toBeNull()
    } finally { engine.close(); clock = new Date("2026-09-23T12:00:00.000Z") }
  })

  test("a future query horizon cannot activate observations that have not happened", async () => {
    const engine = await open(directory())
    try {
      upsertEntity(engine, entity("future", { provenance: provenance({
        observed_at: "2026-09-23T12:01:00.000Z", verified_at: "2026-09-23T12:01:00.000Z",
      }) }), 0)
      expect(engine.get("future", scope)).toBeNull()
      expect(engine.query({ scope, roots: ["future"], now: "2026-09-23T12:02:00.000Z" }))
        .toMatchObject({ entities: [], stale_count: 1 })
    } finally { engine.close() }
  })

  test("bounded traversal handles parallel paths without exceeding its result schema", async () => {
    const engine = await open(directory())
    try {
      upsertEntity(engine, entity("a"), 0)
      upsertEntity(engine, entity("b"), 1)
      for (let index = 0; index < 12; index++) append(engine,
        { type: "upsert_relation", relation: relation(`edge-${index}`, "a", "b") }, 2 + index, `edge-${index}`)
      const result = engine.query({ scope, roots: ["a"], max_nodes: 2, max_depth: 2 })
      expect(result.entities).toHaveLength(2)
      expect(result.paths.length).toBeLessThanOrEqual(2)
      expect(result.relations.length).toBeLessThanOrEqual(8)
      expect(result.omitted_count).toBeGreaterThan(0)
    } finally { engine.close() }
  })
})

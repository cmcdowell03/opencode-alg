import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { EnvironmentMemoryEngine } from "../src/environment-memory/index.ts"
import type { Entity, Provenance, ReadScope, Relation } from "../src/environment-memory/index.ts"
import {
  LocalDirectoryObjectStore,
  ObjectStoreError,
  openS3ObjectStore,
  type S3ObjectTransport,
} from "../src/environment-memory/object-store.ts"
import { ReplicationError, replicateEnvironmentMemory, restoreEnvironmentMemory } from "../src/environment-memory/replication.ts"

const directories: string[] = []
function directory() { const value = mkdtempSync(join(tmpdir(), "alg-env-replication-")); directories.push(value); return value }
afterEach(() => { for (const value of directories.splice(0)) rmSync(value, { recursive: true, force: true }) })

const scope: ReadScope = { namespace: "replication-world", project: "synthetic", owner: "session-a" }
const provenance: Provenance = { source_type: "synthetic", source_ref: "fixture:replication-v1", classification: "observed",
  observed_at: "2020-01-01T12:00:00.000Z", verified_at: "2020-01-01T12:00:00.000Z", expires_at: null }
const entity = (id: string): Entity => ({ id, kind: "resource", label: id, metadata: {},
  scope: { ...scope, visibility: "project", owner: null }, provenance })
const relation = (id: string, source_id: string, target_id: string): Relation => ({ id, source_id, target_id, kind: "reaches",
  scope: { ...scope, visibility: "project", owner: null }, provenance,
  conditions: { principal_ref: "principal-a", restrictions: ["read-only"], valid_from: null, valid_until: null } })

async function engine(directoryPath: string) {
  return EnvironmentMemoryEngine.open({ databasePath: join(directoryPath, "memory.sqlite"), namespace: scope.namespace })
}
function addEntity(target: EnvironmentMemoryEngine, value: Entity, revision: number) {
  return target.append({ type: "upsert_entity", entity: value }, { expected_revision: revision, idempotency_key: "entity:" + value.id })
}

class MemoryS3Transport implements S3ObjectTransport {
  readonly objects = new Map<string, { bytes: Uint8Array; version: string }>()
  unavailable = false
  puts = 0
  private version = 0

  async getObject(input: { bucket: string; key: string }): Promise<{ body: AsyncIterable<Uint8Array>; contentLength: number; versionToken: string } | null> {
    if (this.unavailable) throw new Error("synthetic offline")
    const value = this.objects.get(input.bucket + "/" + input.key)
    if (!value) return null
    return { body: (async function* () { yield value.bytes.slice(0, 2); yield value.bytes.slice(2) })(),
      contentLength: value.bytes.byteLength, versionToken: value.version }
  }

  async putObject(input: { bucket: string; key: string; bytes: Uint8Array; ifNoneMatch?: "*"; ifMatch?: string }): Promise<{ versionToken: string }> {
    if (this.unavailable) throw new Error("synthetic offline")
    this.puts += 1
    const key = input.bucket + "/" + input.key
    const old = this.objects.get(key)
    if ((input.ifNoneMatch === "*" && old) || (input.ifMatch !== undefined && old?.version !== input.ifMatch)) {
      throw Object.assign(new Error("precondition"), { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } })
    }
    const version = "etag-" + (++this.version)
    this.objects.set(key, { bytes: input.bytes.slice(), version })
    return { versionToken: version }
  }

  remove(key: string) { this.objects.delete("synthetic-bucket/memory/" + key) }
}

describe("environment memory object stores", () => {
  test("local store bounds reads, publishes immutable objects, and compare-and-swaps manifests", async () => {
    const store = await LocalDirectoryObjectStore.open({ directory: directory(), maxObjectBytes: 8 })
    expect(await store.get("objects/missing")).toBeNull()
    expect(await store.putIfAbsent("objects/a", new Uint8Array([1, 2]))).toBe("created")
    expect(await store.putIfAbsent("objects/a", new Uint8Array([1, 2]))).toBe("already-present")
    await expect(store.putIfAbsent("objects/a", new Uint8Array([3]))).rejects.toMatchObject({ code: "conflict" })
    await expect(store.putIfAbsent("../escape", new Uint8Array([1]))).rejects.toMatchObject({ code: "invalid-key" })
    await expect(store.get("../escape")).rejects.toMatchObject({ code: "invalid-key" })
    await expect(store.putIfAbsent("objects/large", new Uint8Array(9))).rejects.toMatchObject({ code: "object-too-large" })

    const contenders = await Promise.allSettled([
      store.replaceManifest("manifest.json", new Uint8Array([4]), null),
      store.replaceManifest("manifest.json", new Uint8Array([5]), null),
    ])
    expect(contenders.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(contenders.filter((result) => result.status === "rejected" && (result.reason as ObjectStoreError).code === "conflict")).toHaveLength(1)
    const head = await store.getManifest("manifest.json")
    expect(head).not.toBeNull()
    await expect(store.replaceManifest("manifest.json", new Uint8Array([6]), "stale-token"))
      .rejects.toMatchObject({ code: "conflict" })
    const updated = await store.replaceManifest("manifest.json", new Uint8Array([7]), head!.version)
    expect((await store.getManifest("manifest.json"))?.version).toBe(updated.version)
  })

  test("injected S3 transport uses conditional requests, bounded streaming, and no credentials", async () => {
    const transport = new MemoryS3Transport()
    const store = await openS3ObjectStore({ bucket: "synthetic-bucket", region: "us-east-1", prefix: "memory", maxObjectBytes: 8 }, transport)
    expect(await store.putIfAbsent("objects/item", new Uint8Array([1, 2, 3]))).toBe("created")
    expect(await store.putIfAbsent("objects/item", new Uint8Array([1, 2, 3]))).toBe("already-present")
    await expect(store.putIfAbsent("objects/item", new Uint8Array([9]))).rejects.toMatchObject({ code: "conflict" })
    const initial = await store.replaceManifest("manifest.json", new Uint8Array([4]), null)
    await expect(store.replaceManifest("manifest.json", new Uint8Array([5]), null)).rejects.toMatchObject({ code: "conflict" })
    expect((await store.getManifest("manifest.json"))?.version).toBe(initial.version)
    const bytes = await store.get("objects/item")
    expect([...bytes!]).toEqual([1, 2, 3])

    const oversized: S3ObjectTransport = {
      getObject: async () => ({ body: (async function* () { yield new Uint8Array(5); yield new Uint8Array(5) })(), versionToken: "v1" }),
      putObject: async () => ({ versionToken: "v2" }),
    }
    const bounded = await openS3ObjectStore({ bucket: "b", region: "r", maxObjectBytes: 8 }, oversized)
    await expect(bounded.get("large")).rejects.toMatchObject({ code: "object-too-large" })
  })
})

describe("environment memory replication and recovery", () => {
  test("replicates bounded contiguous batches and restores a snapshot plus later events", async () => {
    const store = await LocalDirectoryObjectStore.open({ directory: directory() })
    const source = await engine(directory())
    const destination = await engine(directory())
    try {
      addEntity(source, entity("gateway"), 0)
      const first = await replicateEnvironmentMemory(source, store)
      expect(first).toMatchObject({ local: { revision: 1, durability: "local-sqlite-commit" }, remote: { highest_replicated_revision: 1, pending_lag: 0 } })
      source.append({ type: "upsert_entity", entity: entity("api") }, { expected_revision: 1, idempotency_key: "entity:api" })
      source.append({ type: "upsert_relation", relation: relation("gateway-api", "gateway", "api") }, { expected_revision: 2, idempotency_key: "relation:gateway-api" })
      const bounded = await replicateEnvironmentMemory(source, store, { eventLimit: 1 })
      expect(bounded.remote).toMatchObject({ highest_replicated_revision: 2, pending_lag: 1 })
      const complete = await replicateEnvironmentMemory(source, store, { eventLimit: 1 })
      expect(complete.remote).toMatchObject({ highest_replicated_revision: 3, pending_lag: 0 })

      const restored = await restoreEnvironmentMemory(destination, store)
      expect(restored).toMatchObject({ revision: 3, restored_batches: 2, durability: "local-sqlite-commit" })
      expect(destination.get("api", scope)?.revision).toBe(2)
      expect(destination.get("gateway-api", scope)?.revision).toBe(3)
      expect((await replicateEnvironmentMemory(source, store)).uploaded_objects).toBe(0)
    } finally { source.close(); destination.close() }
  })

  test("failed uploads leave the old manifest authoritative; retry recovers; missing segments fail before restore", async () => {
    const transport = new MemoryS3Transport()
    const store = await openS3ObjectStore({ bucket: "synthetic-bucket", region: "us-east-1", prefix: "memory" }, transport)
    const source = await engine(directory())
    try {
      addEntity(source, entity("gateway"), 0)
      transport.unavailable = true
      await expect(replicateEnvironmentMemory(source, store, { maxAttempts: 1 })).rejects.toMatchObject({ code: "REMOTE_UNAVAILABLE" })
      transport.unavailable = false
      expect(await store.getManifest("manifest.json")).toBeNull()
      const receipt = await replicateEnvironmentMemory(source, store)
      expect(receipt.remote.highest_replicated_revision).toBe(1)
      source.append({ type: "upsert_entity", entity: entity("api") }, { expected_revision: 1, idempotency_key: "entity:api" })
      await replicateEnvironmentMemory(source, store)
      const remote = await store.getManifest("manifest.json")
      expect(remote).not.toBeNull()
      const manifest = JSON.parse(new TextDecoder().decode(remote!.bytes)) as { batches: { key: string }[] }
      transport.remove(manifest.batches[0]!.key)
      const destination = await engine(directory())
      try {
        await expect(restoreEnvironmentMemory(destination, store)).rejects.toMatchObject({ code: "CORRUPTION" })
        expect(destination.status().revision).toBe(0)
      } finally { destination.close() }
    } finally { source.close() }
  })

  test("namespace mismatch and cancellation are typed without mutating a destination", async () => {
    const store = await LocalDirectoryObjectStore.open({ directory: directory() })
    const source = await engine(directory())
    addEntity(source, entity("gateway"), 0)
    try {
      await replicateEnvironmentMemory(source, store)
      const wrong = await EnvironmentMemoryEngine.open({ databasePath: join(directory(), "wrong.sqlite"), namespace: "another-world" })
      try {
        await expect(restoreEnvironmentMemory(wrong, store)).rejects.toBeInstanceOf(ReplicationError)
        expect(wrong.status().revision).toBe(0)
      } finally { wrong.close() }

      const controller = new AbortController()
      controller.abort("test")
      await expect(replicateEnvironmentMemory(source, store, { signal: controller.signal })).rejects.toMatchObject({ code: "CANCELLED" })
      const destination = await engine(directory())
      try {
        await expect(restoreEnvironmentMemory(destination, store, { signal: controller.signal }))
          .rejects.toMatchObject({ code: "CANCELLED" })
        expect(destination.status().revision).toBe(0)
      } finally { destination.close() }
    } finally { source.close() }
  })
})

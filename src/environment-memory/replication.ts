import { canonicalJson } from "../persistence.ts"
import {
  EnvironmentMemoryError,
  EventBatchSchema,
  EventSchema,
  SnapshotSchema,
  type EnvironmentMemoryEngineContract,
  type EnvironmentMemoryEvent,
  type EnvironmentMemoryEventBatch,
  type EnvironmentMemorySnapshot,
} from "./schemas.ts"
import { ObjectStoreError, type ObjectStore } from "./object-store.ts"

const MANIFEST_KEY = "manifest.json"
const OBJECT_PREFIX = "objects/sha256"
const MANIFEST_MAX_BYTES = 1024 * 1024
const MAX_MANIFEST_BATCHES = 64
const MAX_RECOVERY_BYTES = 64 * 1024 * 1024
const MAX_RETRIES = 3

type SnapshotReference = { key: string; sha256: string; revision: number; event_hash: string | null }
type BatchReference = { key: string; sha256: string; from_revision: number; to_revision: number; previous_hash: string | null }

export interface EnvironmentMemoryReplicationManifest {
  schema_version: 1
  namespace: string
  generation: number
  revision: number
  event_hash: string | null
  predecessor_sha256: string | null
  snapshot: SnapshotReference
  batches: BatchReference[]
}

export interface ReplicationReceipt {
  namespace: string
  local: { durability: "local-sqlite-commit"; revision: number }
  remote: { durability: "remote-object-store"; highest_replicated_revision: number; pending_lag: number }
  manifest_generation: number
  uploaded_objects: number
  attempts: number
}

export interface RestoreReplicationReceipt {
  namespace: string
  revision: number
  restored_batches: number
  durability: "local-sqlite-commit"
}

export type ReplicationErrorCode = "CONFLICT" | "CORRUPTION" | "REMOTE_UNAVAILABLE" | "CANCELLED" | "CAPACITY" | "NAMESPACE_MISMATCH"

export class ReplicationError extends Error {
  constructor(readonly code: ReplicationErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "ReplicationError"
  }
}

function fail(code: ReplicationErrorCode, message: string, cause?: unknown): never {
  throw new ReplicationError(code, message, cause === undefined ? undefined : { cause })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) fail("CANCELLED", "Replication was cancelled", signal.reason)
}

async function hashBytes(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength)
  input.set(bytes)
  const digest = await globalThis.crypto.subtle.digest("SHA-256", input.buffer)
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("")
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalJson(value))
}

function decode(bytes: Uint8Array): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) }
  catch (cause) { fail("CORRUPTION", "Replication object is not valid UTF-8 JSON", cause) }
}

function isSha256(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }

function parseManifest(bytes: Uint8Array): EnvironmentMemoryReplicationManifest {
  if (bytes.byteLength > MANIFEST_MAX_BYTES) fail("CAPACITY", "Replication manifest exceeds its byte limit")
  const raw = decode(bytes)
  if (canonicalJson(raw) !== new TextDecoder().decode(bytes)) fail("CORRUPTION", "Replication manifest is not canonical JSON")
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("CORRUPTION", "Replication manifest has an invalid shape")
  const value = raw as Record<string, unknown>
  if (value.schema_version !== 1 || typeof value.namespace !== "string" || !value.namespace ||
      !Number.isSafeInteger(value.generation) || (value.generation as number) < 1 ||
      !Number.isSafeInteger(value.revision) || (value.revision as number) < 0 ||
      !(value.event_hash === null || isSha256(value.event_hash)) ||
      !(value.predecessor_sha256 === null || isSha256(value.predecessor_sha256)) ||
      !value.snapshot || typeof value.snapshot !== "object" || Array.isArray(value.snapshot) || !Array.isArray(value.batches)) {
    fail("CORRUPTION", "Replication manifest fields are invalid")
  }
  const snapshot = value.snapshot as Record<string, unknown>
  if (typeof snapshot.key !== "string" || !isSha256(snapshot.sha256) ||
      !Number.isSafeInteger(snapshot.revision) || (snapshot.revision as number) < 0 ||
      !(snapshot.event_hash === null || isSha256(snapshot.event_hash))) fail("CORRUPTION", "Snapshot reference is invalid")
  if (value.batches.length > MAX_MANIFEST_BATCHES) fail("CAPACITY", "Replication manifest has too many journal segments")
  const batches: BatchReference[] = value.batches.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("CORRUPTION", "Journal reference is invalid")
    const batch = entry as Record<string, unknown>
    if (typeof batch.key !== "string" || !isSha256(batch.sha256) ||
        !Number.isSafeInteger(batch.from_revision) || (batch.from_revision as number) < 0 ||
        !Number.isSafeInteger(batch.to_revision) || (batch.to_revision as number) <= (batch.from_revision as number) ||
        !(batch.previous_hash === null || isSha256(batch.previous_hash))) fail("CORRUPTION", "Journal reference fields are invalid")
    return batch as unknown as BatchReference
  })
  return value as unknown as EnvironmentMemoryReplicationManifest
}

async function verifyEventChainAsync(batch: EnvironmentMemoryEventBatch, expectedNamespace: string, expectedRevision: number, expectedHash: string | null): Promise<{ revision: number; hash: string | null }> {
  if (batch.namespace !== expectedNamespace || batch.from_revision !== expectedRevision || batch.previous_hash !== expectedHash) fail("CORRUPTION", "Journal segment does not continue the manifest cursor")
  let revision = expectedRevision
  let previousHash = expectedHash
  for (const eventValue of batch.events) {
    const parsed = EventSchema.safeParse(eventValue)
    if (!parsed.success) fail("CORRUPTION", "Journal event schema is invalid", parsed.error)
    const event = parsed.data as EnvironmentMemoryEvent
    if (event.namespace !== expectedNamespace || event.revision !== revision + 1 || event.previous_hash !== previousHash) fail("CORRUPTION", "Journal event sequence or predecessor is invalid")
    const contentHash = await hashBytes(encode({ schema_version: event.schema_version, namespace: event.namespace, revision: event.revision,
      previous_hash: event.previous_hash, timestamp: event.timestamp, idempotency_key: event.idempotency_key, operation: event.operation }))
    const eventHash = await hashBytes(encode({ content_hash: contentHash, namespace: event.namespace, revision: event.revision, previous_hash: event.previous_hash }))
    if (event.content_hash !== contentHash || event.event_hash !== eventHash) fail("CORRUPTION", "Journal event hash is invalid")
    revision = event.revision
    previousHash = event.event_hash
  }
  if (batch.to_revision !== revision) fail("CORRUPTION", "Journal segment end cursor is invalid")
  return { revision, hash: previousHash }
}

async function readManifest(store: ObjectStore, namespace: string, signal?: AbortSignal) {
  throwIfAborted(signal)
  let head: Awaited<ReturnType<ObjectStore["getManifest"]>>
  try { head = await store.getManifest(MANIFEST_KEY, { signal }) }
  catch (cause) {
    if (cause instanceof ObjectStoreError && cause.code === "aborted") fail("CANCELLED", "Replication was cancelled", cause)
    fail("REMOTE_UNAVAILABLE", "Could not read the remote replication manifest", cause)
  }
  if (!head) return null
  const manifest = parseManifest(head.bytes)
  if (manifest.namespace !== namespace) fail("NAMESPACE_MISMATCH", "Remote manifest belongs to another environment namespace")
  return { manifest, version: head.version, hash: await hashBytes(head.bytes) }
}

async function putImmutable(store: ObjectStore, key: string, bytes: Uint8Array, signal?: AbortSignal): Promise<boolean> {
  if (bytes.byteLength > store.maxObjectBytes) fail("CAPACITY", "Replication object exceeds the configured store limit")
  try { return (await store.putIfAbsent(key, bytes, { signal })) === "created" }
  catch (cause) {
    if (cause instanceof ObjectStoreError && cause.code === "object-too-large") fail("CAPACITY", cause.message, cause)
    if (cause instanceof ObjectStoreError && cause.code === "conflict") fail("CORRUPTION", "Content-addressed object key contains different bytes", cause)
    fail(cause instanceof ObjectStoreError && cause.code === "aborted" ? "CANCELLED" : "REMOTE_UNAVAILABLE", "Could not upload an immutable replication object", cause)
  }
}

async function publishManifest(store: ObjectStore, manifest: EnvironmentMemoryReplicationManifest, expected: string | null, signal?: AbortSignal): Promise<{ version: string; bytes: Uint8Array }> {
  const bytes = encode(manifest)
  if (bytes.byteLength > MANIFEST_MAX_BYTES || bytes.byteLength > store.maxObjectBytes) fail("CAPACITY", "Replication manifest exceeds its byte limit")
  try {
    const result = await store.replaceManifest(MANIFEST_KEY, bytes, expected, { signal })
    return { version: result.version, bytes }
  } catch (cause) {
    if (cause instanceof ObjectStoreError && cause.code === "conflict") fail("CONFLICT", "Another writer advanced the replication manifest", cause)
    if (cause instanceof ObjectStoreError && cause.code === "aborted") fail("CANCELLED", "Replication was cancelled", cause)
    fail("REMOTE_UNAVAILABLE", "Could not publish the remote replication manifest", cause)
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve() }, ms)
    const abort = () => { clearTimeout(timer); reject(new ReplicationError("CANCELLED", "Replication was cancelled", { cause: signal?.reason })) }
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** Replicate one bounded event segment or establish a complete snapshot checkpoint. */
export async function replicateEnvironmentMemory(
  engine: EnvironmentMemoryEngineContract,
  store: ObjectStore,
  options: { eventLimit?: number; maxAttempts?: number; signal?: AbortSignal } = {},
): Promise<ReplicationReceipt> {
  const eventLimit = options.eventLimit ?? 128
  const maxAttempts = options.maxAttempts ?? 2
  if (!Number.isSafeInteger(eventLimit) || eventLimit < 1 || eventLimit > 512) throw new RangeError("eventLimit must be between 1 and 512")
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_RETRIES) throw new RangeError(`maxAttempts must be between 1 and ${MAX_RETRIES}`)
  let lastError: unknown
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted(options.signal)
    try {
      return await replicateAttempt(engine, store, { eventLimit, signal: options.signal, attempts: attempt })
    } catch (error) {
      lastError = error
      if (!(error instanceof ReplicationError) || !["REMOTE_UNAVAILABLE", "CONFLICT"].includes(error.code) || attempt === maxAttempts) throw error
      await delay(Math.min(25 * 2 ** (attempt - 1), 200), options.signal)
    }
  }
  throw lastError
}

async function replicateAttempt(engine: EnvironmentMemoryEngineContract, store: ObjectStore, options: { eventLimit: number; signal?: AbortSignal; attempts: number }): Promise<ReplicationReceipt> {
  const localStatus = engine.status()
  const localRevision = localStatus.revision
  const remote = await readManifest(store, engine.namespace, options.signal)
  if (remote) await validateManifestContents(store, remote.manifest, engine.namespace, options.signal)
  let uploadedObjects = 0
  let snapshotRef: SnapshotReference
  let batchRefs: BatchReference[]
  let generation: number
  let predecessor: string | null
  let expectedVersion: string | null
  let remoteRevision: number
  let remoteHash: string | null

  if (!remote) {
    const snapshot = SnapshotSchema.parse(engine.exportSnapshot())
    if (snapshot.revision !== localRevision || snapshot.event_hash !== localStatus.event_hash) fail("CONFLICT", "Local writer advanced during replication")
    if (snapshot.namespace !== engine.namespace) fail("CORRUPTION", "Engine snapshot namespace is inconsistent")
    const bytes = encode(snapshot)
    if (bytes.byteLength > store.maxObjectBytes) fail("CAPACITY", "Snapshot exceeds the configured object-store limit")
    const digest = await hashBytes(bytes)
    snapshotRef = { key: `${OBJECT_PREFIX}/${digest}.snapshot.json`, sha256: digest, revision: snapshot.revision, event_hash: snapshot.event_hash }
    uploadedObjects += Number(await putImmutable(store, snapshotRef.key, bytes, options.signal))
    batchRefs = []
    generation = 1
    predecessor = null
    expectedVersion = null
    remoteRevision = snapshot.revision
    remoteHash = snapshot.event_hash
  } else {
    const current = remote.manifest
    if (current.revision > localRevision) fail("CONFLICT", "Remote replication cursor is ahead of the local engine")
    const sameCursor = current.revision === localRevision && current.event_hash === localStatus.event_hash
    if (sameCursor) {
      return { namespace: engine.namespace, local: { durability: "local-sqlite-commit", revision: localRevision },
        remote: { durability: "remote-object-store", highest_replicated_revision: current.revision, pending_lag: 0 },
        manifest_generation: current.generation, uploaded_objects: 0, attempts: options.attempts }
    }
    if (current.revision === localRevision) fail("CONFLICT", "Local and remote journals have different hashes at the same revision")
    snapshotRef = current.snapshot
    batchRefs = [...current.batches]
    generation = current.generation + 1
    predecessor = remote.hash
    expectedVersion = remote.version
    remoteRevision = current.revision
    remoteHash = current.event_hash

    if (batchRefs.length >= MAX_MANIFEST_BATCHES) {
      const snapshot = SnapshotSchema.parse(engine.exportSnapshot())
      if (snapshot.revision !== localRevision || snapshot.event_hash !== localStatus.event_hash) fail("CONFLICT", "Local writer advanced during replication")
      const bytes = encode(snapshot)
      const digest = await hashBytes(bytes)
      snapshotRef = { key: `${OBJECT_PREFIX}/${digest}.snapshot.json`, sha256: digest, revision: snapshot.revision, event_hash: snapshot.event_hash }
      uploadedObjects += Number(await putImmutable(store, snapshotRef.key, bytes, options.signal))
      batchRefs = []
      remoteRevision = snapshot.revision
      remoteHash = snapshot.event_hash
    }
  }

  if (remoteRevision < localRevision) {
    let batch: EnvironmentMemoryEventBatch | null
    try { batch = engine.eventsSince(remoteRevision, options.eventLimit) }
    catch (cause) {
      if (cause instanceof EnvironmentMemoryError && cause.code === "CONFLICT") fail("CONFLICT", "Local journal no longer contains the remote cursor", cause)
      throw cause
    }
    if (!batch) fail("CORRUPTION", "Engine has a newer revision but returned no journal events")
    const verified = await verifyEventChainAsync(batch, engine.namespace, remoteRevision, remoteHash)
    const bytes = encode(batch)
    if (bytes.byteLength > store.maxObjectBytes) fail("CAPACITY", "Journal segment exceeds the configured object-store limit")
    const digest = await hashBytes(bytes)
    const key = `${OBJECT_PREFIX}/${digest}.events.json`
    uploadedObjects += Number(await putImmutable(store, key, bytes, options.signal))
    batchRefs.push({ key, sha256: digest, from_revision: batch.from_revision, to_revision: verified.revision, previous_hash: batch.previous_hash })
    remoteRevision = verified.revision
    remoteHash = verified.hash
  }

  const manifest: EnvironmentMemoryReplicationManifest = { schema_version: 1, namespace: engine.namespace,
    generation, revision: remoteRevision, event_hash: remoteHash, predecessor_sha256: predecessor,
    snapshot: snapshotRef, batches: batchRefs }
  await publishManifest(store, manifest, expectedVersion, options.signal)
  return { namespace: engine.namespace, local: { durability: "local-sqlite-commit", revision: localRevision },
    remote: { durability: "remote-object-store", highest_replicated_revision: remoteRevision, pending_lag: localRevision - remoteRevision },
    manifest_generation: generation, uploaded_objects: uploadedObjects, attempts: options.attempts }
}

async function readVerifiedObject(store: ObjectStore, reference: { key: string; sha256: string }, signal?: AbortSignal): Promise<Uint8Array> {
  let bytes: Uint8Array | null
  try { bytes = await store.get(reference.key, { signal }) }
  catch (cause) {
    if (cause instanceof ObjectStoreError && cause.code === "object-too-large") fail("CAPACITY", "Referenced replication object exceeds the configured bound", cause)
    if (cause instanceof ObjectStoreError && cause.code === "aborted") fail("CANCELLED", "Recovery was cancelled", cause)
    fail("REMOTE_UNAVAILABLE", "Could not read a referenced replication object", cause)
  }
  if (!bytes) fail("CORRUPTION", "Manifest references a missing object")
  if (await hashBytes(bytes) !== reference.sha256) fail("CORRUPTION", "Referenced object failed its content hash")
  return bytes
}

async function validateManifestContents(store: ObjectStore, manifest: EnvironmentMemoryReplicationManifest, namespace: string, signal?: AbortSignal) {
  const snapshotBytes = await readVerifiedObject(store, manifest.snapshot, signal)
  let totalBytes = snapshotBytes.byteLength
  const parsedSnapshot = SnapshotSchema.safeParse(decode(snapshotBytes))
  if (!parsedSnapshot.success) fail("CORRUPTION", "Snapshot schema is invalid", parsedSnapshot.error)
  const snapshot = parsedSnapshot.data
  if (canonicalJson(snapshot) !== new TextDecoder().decode(snapshotBytes)) fail("CORRUPTION", "Snapshot is not canonical JSON")
  if (snapshot.namespace !== namespace || snapshot.revision !== manifest.snapshot.revision || snapshot.event_hash !== manifest.snapshot.event_hash) {
    fail("CORRUPTION", "Snapshot cursor does not match its manifest reference")
  }
  let cursor = snapshot.revision
  let hash = snapshot.event_hash
  const batches: EnvironmentMemoryEventBatch[] = []
  for (const reference of manifest.batches) {
    throwIfAborted(signal)
    if (reference.from_revision !== cursor || reference.previous_hash !== hash) fail("CORRUPTION", "Manifest journal references are not contiguous")
    const bytes = await readVerifiedObject(store, reference, signal)
    totalBytes += bytes.byteLength
    if (totalBytes > MAX_RECOVERY_BYTES) fail("CAPACITY", "Recovery payload exceeds the bounded aggregate size")
    const raw = decode(bytes)
    const parsedBatch = EventBatchSchema.safeParse(raw)
    if (!parsedBatch.success) fail("CORRUPTION", "Journal segment schema is invalid", parsedBatch.error)
    const batch = parsedBatch.data
    if (canonicalJson(batch) !== new TextDecoder().decode(bytes)) fail("CORRUPTION", "Journal segment is not canonical JSON")
    if (batch.from_revision !== reference.from_revision || batch.to_revision !== reference.to_revision || batch.previous_hash !== reference.previous_hash) {
      fail("CORRUPTION", "Journal reference does not match its payload")
    }
    const verified = await verifyEventChainAsync(batch, namespace, cursor, hash)
    batches.push(batch)
    cursor = verified.revision
    hash = verified.hash
  }
  if (cursor !== manifest.revision || hash !== manifest.event_hash) fail("CORRUPTION", "Manifest head does not match the verified snapshot and journal")
  return { snapshot, batches }
}

/** Validate every referenced object and event chain before mutating the empty destination. */
export async function restoreEnvironmentMemory(
  engine: EnvironmentMemoryEngineContract,
  store: ObjectStore,
  options: { signal?: AbortSignal } = {},
): Promise<RestoreReplicationReceipt> {
  const remote = await readManifest(store, engine.namespace, options.signal)
  if (!remote) fail("CORRUPTION", "No committed replication manifest exists")
  const manifest = remote.manifest
  if (manifest.namespace !== engine.namespace) fail("NAMESPACE_MISMATCH", "Remote manifest belongs to another environment namespace")
  const { snapshot, batches } = await validateManifestContents(store, manifest, engine.namespace, options.signal)

  throwIfAborted(options.signal)
  let restored: ReturnType<EnvironmentMemoryEngineContract["restoreWithReplay"]>
  try { restored = engine.restoreWithReplay(snapshot, batches) }
  catch (cause) { fail("CORRUPTION", "Local atomic recovery was rejected", cause) }
  return { namespace: engine.namespace, revision: restored.revision, restored_batches: batches.length, durability: "local-sqlite-commit" }
}

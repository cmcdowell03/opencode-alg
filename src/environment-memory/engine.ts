import { createHash } from "node:crypto"
import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { Database } from "bun:sqlite"
import { canonicalJson } from "../persistence.ts"
import { redactEvolutionText } from "../skill-evolution-redaction.ts"
import {
  AppendOptionsSchema, CommittedRevisionSchema, EngineStatusSchema, EntitySchema, EnvironmentMemoryError,
  EventBatchSchema, EventSchema, MEMORY_DEFAULT_CACHE_ENTRIES, MEMORY_MAX_CACHE_ENTRIES,
  MEMORY_MAX_EVENT_BATCH, MEMORY_MAX_QUERY_NODES, MEMORY_MAX_RECORD_BYTES, MEMORY_MAX_SNAPSHOT_BYTES,
  IdentitySchema, IdempotencyReceiptSchema, IdSchema, OperationSchema, QueryOptionsSchema, QueryResultSchema, ReadScopeSchema, RelationSchema,
  RestoreResultSchema, SnapshotSchema, StoredEntitySchema, StoredRelationSchema,
  type AppendOptions, type CommittedRevision, type EngineStatus, type EnvironmentMemoryEngineContract,
  type EnvironmentMemoryEvent, type EnvironmentMemoryEventBatch, type EnvironmentMemoryOperation,
  type EnvironmentMemorySnapshot, type OpenEnvironmentMemoryOptions, type QueryOptions, type QueryResult,
  type ReadScope, type RestoreResult, type StoredEntity, type StoredRelation,
} from "./schemas.ts"

export type EnvironmentMemoryEngineOptions = OpenEnvironmentMemoryOptions

type Cached = { revision: number; value: StoredEntity | StoredRelation | null }
type CacheCounters = { hits: number; misses: number; evictions: number }
type EventHashInput = Pick<EnvironmentMemoryEvent, "schema_version" | "namespace" | "revision" | "previous_hash" | "timestamp" | "idempotency_key" | "operation">

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
const digestJson = (value: unknown) => sha256(canonicalJson(value))
const byteLength = (value: unknown) => Buffer.byteLength(canonicalJson(value), "utf8")
const containsSuspectedSecret = (value: unknown) => redactEvolutionText(canonicalJson(value)).includes("[REDACTED]")
function fail(code: ConstructorParameters<typeof EnvironmentMemoryError>[0], message: string, cause?: unknown): never {
  throw new EnvironmentMemoryError(code, message, cause === undefined ? undefined : { cause })
}

function eventHashes(input: EventHashInput) {
  const content_hash = digestJson(input)
  const event_hash = digestJson({ content_hash, namespace: input.namespace, revision: input.revision, previous_hash: input.previous_hash })
  return { content_hash, event_hash }
}

function fresh(record: { provenance: { observed_at: string; verified_at: string | null; expires_at: string | null } }, now: number): boolean {
  return Date.parse(record.provenance.observed_at) <= now &&
    (record.provenance.verified_at === null || Date.parse(record.provenance.verified_at) <= now) &&
    (record.provenance.expires_at === null || Date.parse(record.provenance.expires_at) > now)
}

function visible(record: { scope: { namespace: string; project: string; visibility: "session" | "project"; owner: string | null } }, scope: ReadScope) {
  return record.scope.namespace === scope.namespace && record.scope.project === scope.project &&
    (record.scope.visibility === "project" || record.scope.owner === scope.owner)
}

function validity(record: StoredRelation, now: number): boolean {
  const { valid_from, valid_until } = record.conditions
  return (valid_from === null || Date.parse(valid_from) <= now) &&
    (valid_until === null || Date.parse(valid_until) > now)
}

/** SQLite is authoritative. This per-connection LRU only caches fully committed values. */
export class EnvironmentMemoryEngine implements EnvironmentMemoryEngineContract {
  readonly namespace: string
  private readonly db: Database
  private readonly cache = new Map<string, Cached>()
  private readonly counters: CacheCounters = { hits: 0, misses: 0, evictions: 0 }
  private readonly cacheEntries: number
  private readonly maxRecordBytes: number
  private readonly maxSnapshotBytes: number
  private readonly now: () => Date
  private closed = false
  private observedRevision = 0

  private constructor(db: Database, options: OpenEnvironmentMemoryOptions) {
    this.db = db
    this.namespace = options.namespace
    this.cacheEntries = options.cacheEntries ?? MEMORY_DEFAULT_CACHE_ENTRIES
    this.maxRecordBytes = options.maxRecordBytes ?? MEMORY_MAX_RECORD_BYTES
    this.maxSnapshotBytes = options.maxSnapshotBytes ?? MEMORY_MAX_SNAPSHOT_BYTES
    this.now = options.now ?? (() => new Date())
    this.initialize()
  }

  static async open(options: OpenEnvironmentMemoryOptions): Promise<EnvironmentMemoryEngine> {
    const namespace = options.namespace
    if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/.test(namespace)) {
      fail("INVALID_OPERATION", "namespace is invalid")
    }
    const cacheEntries = options.cacheEntries ?? MEMORY_DEFAULT_CACHE_ENTRIES
    const maxRecordBytes = options.maxRecordBytes ?? MEMORY_MAX_RECORD_BYTES
    const maxSnapshotBytes = options.maxSnapshotBytes ?? MEMORY_MAX_SNAPSHOT_BYTES
    if (!Number.isInteger(cacheEntries) || cacheEntries < 1 || cacheEntries > MEMORY_MAX_CACHE_ENTRIES ||
        !Number.isInteger(maxRecordBytes) || maxRecordBytes < 1024 || maxRecordBytes > MEMORY_MAX_RECORD_BYTES ||
        !Number.isInteger(maxSnapshotBytes) || maxSnapshotBytes < maxRecordBytes || maxSnapshotBytes > MEMORY_MAX_SNAPSHOT_BYTES) {
      fail("CAPACITY", "configured capacity is outside supported bounds")
    }
    if (typeof options.databasePath !== "string" || options.databasePath.trim() === "") fail("INVALID_OPERATION", "databasePath must name a local database file")
    const databasePath = resolve(options.databasePath)
    if (!databasePath || databasePath === resolve(".")) fail("INVALID_OPERATION", "databasePath must name a local database file")
    mkdirSync(dirname(databasePath), { recursive: true })
    let DatabaseConstructor: typeof import("bun:sqlite").Database
    try {
      const sqlite = await import("bun:sqlite")
      DatabaseConstructor = sqlite.Database
    } catch (cause) {
      fail("UNSUPPORTED_RUNTIME", "Environment memory requires Bun's built-in SQLite module", cause)
    }
    let db: Database
    try {
      db = new DatabaseConstructor(databasePath, { create: true, strict: true })
    } catch (cause) {
      fail("UNSUPPORTED_RUNTIME", "could not open the local SQLite database", cause)
    }
    try {
      return new EnvironmentMemoryEngine(db, { ...options, databasePath })
    } catch (cause) {
      db.close()
      if (cause instanceof EnvironmentMemoryError) throw cause
      fail("CORRUPTION", "could not initialize the environment memory database", cause)
    }
  }

  private initialize() {
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;")
    const version = Number(this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version ?? 0)
    if (version > 1) fail("CORRUPTION", `database schema version ${version} is newer than this engine`)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS engine_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS event_log (
        revision INTEGER PRIMARY KEY, event_json TEXT NOT NULL, content_hash TEXT NOT NULL,
        event_hash TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE, operation_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS idempotency_history (
        idempotency_key TEXT PRIMARY KEY, operation_hash TEXT NOT NULL, revision INTEGER NOT NULL,
        event_hash TEXT NOT NULL, content_hash TEXT NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS identities (
        id TEXT PRIMARY KEY, record_type TEXT NOT NULL CHECK(record_type IN ('entity','relation')),
        revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))
      ) STRICT;
      CREATE TABLE IF NOT EXISTS entities (
        id TEXT PRIMARY KEY REFERENCES identities(id), project TEXT NOT NULL, visibility TEXT NOT NULL,
        owner TEXT, expires_at TEXT, record_json TEXT NOT NULL, revision INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS entities_scope ON entities(project, visibility, owner);
      CREATE INDEX IF NOT EXISTS entities_expiry ON entities(expires_at);
      CREATE TABLE IF NOT EXISTS relations (
        id TEXT PRIMARY KEY REFERENCES identities(id), source_id TEXT NOT NULL, target_id TEXT NOT NULL,
        project TEXT NOT NULL, visibility TEXT NOT NULL, owner TEXT, expires_at TEXT,
        valid_until TEXT, record_json TEXT NOT NULL, revision INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS relations_source ON relations(source_id, project, visibility, owner);
      CREATE INDEX IF NOT EXISTS relations_target ON relations(target_id);
      CREATE INDEX IF NOT EXISTS relations_expiry ON relations(expires_at, valid_until);
      PRAGMA user_version = 1;
    `)
    this.db.exec(`INSERT OR IGNORE INTO idempotency_history(idempotency_key,operation_hash,revision,event_hash,content_hash)
      SELECT idempotency_key,operation_hash,revision,event_hash,content_hash FROM event_log`)
    const storedNamespace = this.db.query<{ value: string }, [string]>("SELECT value FROM engine_meta WHERE key = ?").get("namespace")?.value
    if (storedNamespace !== undefined && storedNamespace !== this.namespace) fail("SCOPE_DENIED", "database belongs to a different namespace")
    if (storedNamespace === undefined) {
      this.db.query("INSERT INTO engine_meta(key,value) VALUES ('namespace',?),('revision','0'),('head_hash',''),('base_revision','0'),('base_hash','')").run(this.namespace)
    }
    this.observedRevision = this.currentRevision()
  }

  private assertOpen() { if (this.closed) fail("CLOSED", "environment memory engine is closed") }
  private currentRevision(): number {
    return Number(this.db.query<{ value: string }, [string]>("SELECT value FROM engine_meta WHERE key = ?").get("revision")?.value ?? 0)
  }
  private headHash(): string | null {
    const value = this.db.query<{ value: string }, [string]>("SELECT value FROM engine_meta WHERE key = ?").get("head_hash")?.value
    return value || null
  }
  private baseRevision(): number {
    return Number(this.db.query<{ value: string }, [string]>("SELECT value FROM engine_meta WHERE key = ?").get("base_revision")?.value ?? 0)
  }
  private baseHash(): string | null {
    const value = this.db.query<{ value: string }, [string]>("SELECT value FROM engine_meta WHERE key = ?").get("base_hash")?.value
    return value || null
  }
  private setMeta(key: string, value: string) { this.db.query("UPDATE engine_meta SET value = ? WHERE key = ?").run(value, key) }
  private begin() { this.db.exec("BEGIN IMMEDIATE") }
  private commit() { this.db.exec("COMMIT") }
  private rollback() { try { this.db.exec("ROLLBACK") } catch { /* original failure wins */ } }
  private readTransaction<T>(read: () => T): T {
    this.db.exec("BEGIN")
    try { const result = read(); this.commit(); return result }
    catch (cause) { this.rollback(); throw cause }
  }
  private invalidateIfChanged() {
    const current = this.currentRevision()
    if (current !== this.observedRevision) { this.cache.clear(); this.observedRevision = current }
    return current
  }
  private validateScope(scope: ReadScope) {
    const parsed = ReadScopeSchema.safeParse(scope)
    if (!parsed.success) fail("SCOPE_DENIED", "read scope is invalid", parsed.error)
    if (scope.namespace !== this.namespace) fail("SCOPE_DENIED", "read scope belongs to another namespace")
  }
  private cacheGet(key: string, revision: number): { found: false } | { found: true; value: StoredEntity | StoredRelation | null } {
    const entry = this.cache.get(key)
    if (!entry || entry.revision !== revision) { this.counters.misses++; return { found: false } }
    this.cache.delete(key); this.cache.set(key, entry); this.counters.hits++
    return { found: true, value: entry.value }
  }
  private cacheSet(key: string, value: StoredEntity | StoredRelation | null, revision: number) {
    if (value === null) return
    this.cache.delete(key); this.cache.set(key, { value, revision })
    if (this.cache.size > this.cacheEntries) { const oldest = this.cache.keys().next().value; if (oldest !== undefined) { this.cache.delete(oldest); this.counters.evictions++ } }
  }

  append(operation: EnvironmentMemoryOperation, options: AppendOptions): CommittedRevision {
    this.assertOpen()
    const parsedOperation = OperationSchema.safeParse(operation)
    const parsedOptions = AppendOptionsSchema.safeParse(options)
    if (!parsedOperation.success) fail("INVALID_OPERATION", "operation is invalid", parsedOperation.error)
    if (!parsedOptions.success) fail("INVALID_OPERATION", "append options are invalid", parsedOptions.error)
    const normalized = parsedOperation.data
    const appendOptions = parsedOptions.data
    const opBytes = byteLength(normalized)
    if (opBytes > this.maxRecordBytes) fail("CAPACITY", "operation exceeds the configured record limit")
    const operationHash = digestJson(normalized)
    this.begin()
    try {
      const duplicate = this.db.query<{ revision: number; event_hash: string; content_hash: string; operation_hash: string }, [string]>(
        "SELECT revision,event_hash,content_hash,operation_hash FROM idempotency_history WHERE idempotency_key = ?").get(appendOptions.idempotency_key)
      if (duplicate) {
        if (duplicate.operation_hash !== operationHash) fail("CONFLICT", "idempotency key was already used for a different operation")
        this.commit()
        return CommittedRevisionSchema.parse({ namespace: this.namespace, revision: duplicate.revision, event_hash: duplicate.event_hash,
          content_hash: duplicate.content_hash, idempotent: true, durability: "local-sqlite-commit" })
      }
      const revision = this.currentRevision()
      if (revision !== appendOptions.expected_revision) fail("CONFLICT", `expected revision ${appendOptions.expected_revision}, current revision is ${revision}`)
      this.applyOperation(normalized, revision + 1)
      const previous_hash = this.headHash()
      const eventInput: EventHashInput = { schema_version: 1, namespace: this.namespace, revision: revision + 1, previous_hash,
        timestamp: this.now().toISOString(), idempotency_key: appendOptions.idempotency_key, operation: normalized }
      const hashes = eventHashes(eventInput)
      const event = EventSchema.parse({ ...eventInput, ...hashes })
      const eventJson = canonicalJson(event)
      this.db.query("INSERT INTO event_log(revision,event_json,content_hash,event_hash,idempotency_key,operation_hash) VALUES (?,?,?,?,?,?)")
        .run(event.revision, eventJson, event.content_hash, event.event_hash, event.idempotency_key, operationHash)
      this.db.query("INSERT INTO idempotency_history(idempotency_key,operation_hash,revision,event_hash,content_hash) VALUES (?,?,?,?,?)")
        .run(event.idempotency_key, operationHash, event.revision, event.event_hash, event.content_hash)
      this.setMeta("revision", String(event.revision)); this.setMeta("head_hash", event.event_hash)
      this.commit()
      this.cache.clear(); this.observedRevision = event.revision
      return CommittedRevisionSchema.parse({ namespace: this.namespace, revision: event.revision, event_hash: event.event_hash,
        content_hash: event.content_hash, idempotent: false, durability: "local-sqlite-commit" })
    } catch (cause) {
      this.rollback()
      if (cause instanceof EnvironmentMemoryError) throw cause
      fail("CORRUPTION", "SQLite transaction failed", cause)
    }
  }

  private applyOperation(operation: EnvironmentMemoryOperation, revision: number) {
    if (containsSuspectedSecret(operation)) fail("INVALID_OPERATION", "suspected credential content is not eligible for environment memory")
    if (operation.type === "upsert_entity") {
      const entity = EntitySchema.parse(operation.entity)
      if (entity.scope.namespace !== this.namespace) fail("SCOPE_DENIED", "entity namespace differs from engine namespace")
      const prior = this.db.query<{ record_type: string; revoked: number }, [string]>("SELECT record_type,revoked FROM identities WHERE id=?").get(entity.id)
      if (prior && (prior.record_type !== "entity" || prior.revoked)) fail("CONFLICT", "entity identity is already used or revoked")
      if (!prior) this.db.query("INSERT INTO identities(id,record_type) VALUES (?, 'entity')").run(entity.id)
      const stored = StoredEntitySchema.parse({ ...entity, revision })
      if (byteLength(stored) > this.maxRecordBytes) fail("CAPACITY", "entity exceeds the configured record limit")
      const s = stored.scope
      this.db.query(`INSERT INTO entities(id,project,visibility,owner,expires_at,record_json,revision) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET project=excluded.project,visibility=excluded.visibility,owner=excluded.owner,
        expires_at=excluded.expires_at,record_json=excluded.record_json,revision=excluded.revision`)
        .run(entity.id, s.project, s.visibility, s.owner, entity.provenance.expires_at, canonicalJson(stored), revision)
      return
    }
    if (operation.type === "upsert_relation") {
      const relation = RelationSchema.parse(operation.relation)
      if (relation.scope.namespace !== this.namespace) fail("SCOPE_DENIED", "relation namespace differs from engine namespace")
      const prior = this.db.query<{ record_type: string; revoked: number }, [string]>("SELECT record_type,revoked FROM identities WHERE id=?").get(relation.id)
      if (prior && (prior.record_type !== "relation" || prior.revoked)) fail("CONFLICT", "relation identity is already used or revoked")
      const source = this.readEntity(relation.source_id), target = this.readEntity(relation.target_id)
      if (!source || !target) fail("NOT_FOUND", "relation endpoints must exist in the current projection")
      const scope = relation.scope
      const relationReader: ReadScope = { namespace: scope.namespace, project: scope.project, owner: scope.owner ?? "" }
      if (!visible(source, relationReader) || !visible(target, relationReader) ||
          (scope.visibility === "project" && (source.scope.visibility !== "project" || target.scope.visibility !== "project"))) {
        fail("SCOPE_DENIED", "relation scope would broaden visibility of an endpoint")
      }
      if (!prior) this.db.query("INSERT INTO identities(id,record_type) VALUES (?, 'relation')").run(relation.id)
      const stored = StoredRelationSchema.parse({ ...relation, revision })
      if (byteLength(stored) > this.maxRecordBytes) fail("CAPACITY", "relation exceeds the configured record limit")
      const s = stored.scope
      this.db.query(`INSERT INTO relations(id,source_id,target_id,project,visibility,owner,expires_at,valid_until,record_json,revision)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,target_id=excluded.target_id,
        project=excluded.project,visibility=excluded.visibility,owner=excluded.owner,expires_at=excluded.expires_at,
        valid_until=excluded.valid_until,record_json=excluded.record_json,revision=excluded.revision`)
        .run(relation.id, relation.source_id, relation.target_id, s.project, s.visibility, s.owner,
          relation.provenance.expires_at, relation.conditions.valid_until, canonicalJson(stored), revision)
      return
    }
    const identity = this.db.query<{ record_type: string; revoked: number }, [string]>(
      "SELECT record_type,revoked FROM identities WHERE id=?").get(operation.target_id)
    if (!identity) fail("NOT_FOUND", "cannot revoke a missing identity")
    if (identity.record_type !== operation.target_type) fail("INVALID_OPERATION", "revocation target type does not match")
    if (identity.revoked) fail("CONFLICT", "identity is already revoked")
    this.db.query("UPDATE identities SET revoked=1 WHERE id=?").run(operation.target_id)
    if (operation.target_type === "entity") {
      const dependent = this.db.query<{ id: string }, [string, string]>(
        "SELECT id FROM relations WHERE source_id=? OR target_id=?").all(operation.target_id, operation.target_id)
      for (const row of dependent) this.db.query("UPDATE identities SET revoked=1 WHERE id=?").run(row.id)
      this.db.query("DELETE FROM relations WHERE source_id=? OR target_id=?").run(operation.target_id, operation.target_id)
      this.db.query("DELETE FROM entities WHERE id=?").run(operation.target_id)
    } else this.db.query("DELETE FROM relations WHERE id=?").run(operation.target_id)
  }

  private readEntity(id: string): StoredEntity | null {
    const row = this.db.query<{ record_json: string }, [string]>("SELECT record_json FROM entities WHERE id=?").get(id)
    return row ? StoredEntitySchema.parse(JSON.parse(row.record_json)) : null
  }

  get(id: string, scope: ReadScope): StoredEntity | StoredRelation | null {
    this.assertOpen(); this.validateScope(scope)
    if (!IdSchema.safeParse(id).success) fail("INVALID_OPERATION", "record id is invalid")
    return this.readTransaction(() => {
    const revision = this.invalidateIfChanged()
    const key = `${scope.namespace}\u0000${scope.project}\u0000${scope.owner}\u0000${id}`
    const cached = this.cacheGet(key, revision)
    if (cached.found) {
      const value = cached.value
      return value && this.readable(value, scope, this.now().getTime()) ? structuredClone(value) : null
    }
    const entity = this.readEntity(id)
    const relationRow = entity ? null : this.db.query<{ record_json: string }, [string]>("SELECT record_json FROM relations WHERE id=?").get(id)
    const value = entity ?? (relationRow ? StoredRelationSchema.parse(JSON.parse(relationRow.record_json)) : null)
    const result = value && this.readable(value, scope, this.now().getTime()) ? value : null
    this.cacheSet(key, result, revision)
    return result ? structuredClone(result) : null
    })
  }

  private readable(value: StoredEntity | StoredRelation, scope: ReadScope, now: number): boolean {
    if (!visible(value, scope) || !fresh(value, now)) return false
    if (!("conditions" in value)) return true
    const source = this.readEntity(value.source_id), target = this.readEntity(value.target_id)
    return validity(value, now) && !!source && !!target &&
      visible(source, scope) && visible(target, scope) && fresh(source, now) && fresh(target, now)
  }

  query(input: QueryOptions): QueryResult {
    this.assertOpen()
    const parsed = QueryOptionsSchema.safeParse(input)
    if (!parsed.success) fail("INVALID_OPERATION", "query options are invalid", parsed.error)
    const options = parsed.data
    this.validateScope(options.scope)
    return this.readTransaction(() => {
    const revision = this.invalidateIfChanged()
    const currentTime = this.now().getTime()
    // A caller may ask for a stricter freshness horizon, but cannot backdate a fact or activate a future relation.
    const freshnessTime = Math.max(currentTime, Date.parse(options.now))
    const entities = new Map<string, StoredEntity>(), relations = new Map<string, StoredRelation>()
    const paths: QueryResult["paths"] = []
    let stale_count = 0, missing_count = 0, omitted_count = 0
    const seenStale = new Set<string>(), seenMissing = new Set<string>()
    const queue: Array<{ id: string; root: string; entityIds: string[]; relationIds: string[] }> = []
    for (const root of options.roots) queue.push({ id: root, root, entityIds: [], relationIds: [] })
    const visited = new Set<string>()
    const queued = new Set(options.roots)
    const addPath = (path: QueryResult["paths"][number]) => {
      if (paths.length < options.max_nodes) paths.push(path)
      else omitted_count++
    }
    while (queue.length) {
      const current = queue.shift()!
      queued.delete(current.id)
      if (current.entityIds.length && visited.has(current.id)) continue
      const entity = this.readEntity(current.id)
      if (!entity) { if (!seenMissing.has(current.id)) { seenMissing.add(current.id); missing_count++ }; continue }
      if (!visible(entity, options.scope)) continue
      if (!fresh(entity, currentTime) || !fresh(entity, freshnessTime)) { if (!seenStale.has(entity.id)) { seenStale.add(entity.id); stale_count++ }; continue }
      if (!entities.has(entity.id) && entities.size >= options.max_nodes) { omitted_count++; continue }
      entities.set(entity.id, entity); visited.add(entity.id)
      addPath({ root_id: current.root, entity_ids: [...current.entityIds, entity.id], relation_ids: current.relationIds })
      if (current.relationIds.length >= options.max_depth) {
        omitted_count += Number(this.db.query<{ count: number }, [string, string, string]>(
          "SELECT count(*) AS count FROM relations WHERE source_id=? AND project=? AND (visibility='project' OR owner=?)")
          .get(entity.id, options.scope.project, options.scope.owner)?.count ?? 0)
        continue
      }
      const relationLimit = options.max_nodes * 4
      const rows = this.db.query<{ record_json: string }, [string, string, string]>(
        `SELECT record_json FROM relations WHERE source_id=? AND project=? AND (visibility='project' OR owner=?)
         AND visibility IN ('project','session') ORDER BY id LIMIT ${relationLimit + 1}`)
        .all(entity.id, options.scope.project, options.scope.owner)
      if (rows.length > relationLimit) {
        const total = Number(this.db.query<{ count: number }, [string, string, string]>(
          "SELECT count(*) AS count FROM relations WHERE source_id=? AND project=? AND (visibility='project' OR owner=?)")
          .get(entity.id, options.scope.project, options.scope.owner)?.count ?? rows.length)
        omitted_count += total - relationLimit
        rows.pop()
      }
      for (const row of rows) {
        const relation = StoredRelationSchema.parse(JSON.parse(row.record_json))
        if (!visible(relation, options.scope)) continue
        if (!fresh(relation, currentTime) || !fresh(relation, freshnessTime) || !validity(relation, currentTime)) { if (!seenStale.has(relation.id)) { seenStale.add(relation.id); stale_count++ }; continue }
        const target = this.readEntity(relation.target_id)
        if (!target) { if (!seenMissing.has(relation.target_id)) { seenMissing.add(relation.target_id); missing_count++ }; continue }
        if (!visible(target, options.scope)) continue
        if (!fresh(target, currentTime) || !fresh(target, freshnessTime)) { if (!seenStale.has(target.id)) { seenStale.add(target.id); stale_count++ }; continue }
        if (!visited.has(target.id) && !queued.has(target.id) && entities.size + queued.size >= options.max_nodes) {
          omitted_count++; continue
        }
        if (!relations.has(relation.id) && relations.size >= options.max_nodes * 4) { omitted_count++; continue }
        relations.set(relation.id, relation)
        if (!visited.has(target.id) && !queued.has(target.id) && queue.length < options.max_nodes) {
          queue.push({ id: target.id, root: current.root,
            entityIds: [...current.entityIds, entity.id], relationIds: [...current.relationIds, relation.id] })
          queued.add(target.id)
        } else addPath({ root_id: current.root, entity_ids: [...current.entityIds, entity.id, target.id],
          relation_ids: [...current.relationIds, relation.id] })
      }
    }
    return QueryResultSchema.parse({ revision, entities: [...entities.values()], relations: [...relations.values()], paths,
      stale_count, missing_count, omitted_count })
    })
  }

  status(): EngineStatus {
    this.assertOpen()
    return this.readTransaction(() => {
    const revision = this.invalidateIfChanged()
    const entities = Number(this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM entities").get()?.count ?? 0)
    const relations = Number(this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM relations").get()?.count ?? 0)
    return EngineStatusSchema.parse({ namespace: this.namespace, revision, event_hash: this.headHash(), entities, relations,
      cache: { entries: this.cache.size, ...this.counters, capacity: this.cacheEntries },
      capacity: { max_record_bytes: this.maxRecordBytes, max_snapshot_bytes: this.maxSnapshotBytes, max_event_batch: MEMORY_MAX_EVENT_BATCH },
      durability: "local-sqlite-commit" })
    })
  }

  exportSnapshot(): EnvironmentMemorySnapshot {
    this.assertOpen(); this.db.exec("BEGIN")
    try {
      const revision = this.currentRevision(), event_hash = this.headHash()
      const entityRows = this.db.query<{ record_json: string }, []>("SELECT record_json FROM entities ORDER BY id").all()
      const relationRows = this.db.query<{ record_json: string }, []>("SELECT record_json FROM relations ORDER BY id").all()
      const identities = this.db.query<{ id: string; record_type: string; revoked: number }, []>(
        "SELECT id,record_type,revoked FROM identities ORDER BY id").all().map((row) =>
        IdentitySchema.parse({ id: row.id, record_type: row.record_type, revoked: row.revoked === 1 }))
      const idempotency = this.db.query<{ idempotency_key: string; operation_hash: string; revision: number; event_hash: string; content_hash: string }, []>(
        "SELECT idempotency_key,operation_hash,revision,event_hash,content_hash FROM idempotency_history ORDER BY revision").all()
        .map((row) => IdempotencyReceiptSchema.parse(row))
      const snapshot = SnapshotSchema.parse({ schema_version: 1, namespace: this.namespace, revision, event_hash,
        identities, idempotency,
        entities: entityRows.map((row) => JSON.parse(row.record_json)), relations: relationRows.map((row) => JSON.parse(row.record_json)) })
      if (byteLength(snapshot) > this.maxSnapshotBytes) fail("CAPACITY", "snapshot exceeds the configured byte limit")
      this.db.exec("COMMIT")
      return snapshot
    } catch (cause) { this.rollback(); if (cause instanceof EnvironmentMemoryError) throw cause; fail("CORRUPTION", "could not export snapshot", cause) }
  }

  eventsSince(revision: number, limit = MEMORY_MAX_EVENT_BATCH): EnvironmentMemoryEventBatch | null {
    this.assertOpen()
    if (!Number.isInteger(revision) || revision < 0 || !Number.isInteger(limit) || limit < 1 || limit > MEMORY_MAX_EVENT_BATCH) {
      fail("INVALID_OPERATION", "event cursor or limit is invalid")
    }
    return this.readTransaction(() => {
    const base = this.baseRevision()
    if (revision < base) fail("CONFLICT", "requested events predate the restored snapshot cursor")
    const current = this.currentRevision()
    if (revision > current) fail("CONFLICT", "requested event cursor is ahead of the local revision")
    const rows = this.db.query<{ event_json: string }, [number, number]>(
      "SELECT event_json FROM event_log WHERE revision>? ORDER BY revision LIMIT ?").all(revision, limit)
    if (!rows.length) return null
    const events = rows.map((row) => EventSchema.parse(JSON.parse(row.event_json)))
    const batch = EventBatchSchema.parse({ schema_version: 1, namespace: this.namespace, from_revision: revision,
      to_revision: events.at(-1)!.revision, previous_hash: this.hashAt(revision), events })
    if (batch.events.length > limit) fail("CORRUPTION", "event query exceeded its requested bound")
    return batch
    })
  }

  private hashAt(revision: number): string | null {
    if (revision === this.baseRevision()) return this.baseHash()
    if (revision === 0) return null
    const value = this.db.query<{ event_hash: string }, [number]>("SELECT event_hash FROM event_log WHERE revision=?").get(revision)?.event_hash
    if (!value) fail("CONFLICT", "event cursor is not retained locally")
    return value
  }

  restoreSnapshot(input: EnvironmentMemorySnapshot): RestoreResult {
    return this.restoreWithReplay(input, [])
  }

  /** Publish a recovered snapshot and all journal segments with one SQLite commit. */
  restoreWithReplay(input: EnvironmentMemorySnapshot, inputs: EnvironmentMemoryEventBatch[]): RestoreResult {
    this.assertOpen()
    const parsed = SnapshotSchema.safeParse(input)
    if (!parsed.success) fail("CORRUPTION", "snapshot schema is invalid", parsed.error)
    const snapshot = parsed.data
    if (snapshot.namespace !== this.namespace) fail("SCOPE_DENIED", "snapshot belongs to another namespace")
    if (byteLength(snapshot) > this.maxSnapshotBytes) fail("CAPACITY", "snapshot exceeds the configured byte limit")
    const batches = inputs.map((input) => {
      const parsed = EventBatchSchema.safeParse(input)
      if (!parsed.success) fail("CORRUPTION", "event batch schema is invalid", parsed.error)
      return parsed.data
    })
    this.begin()
    try {
      this.loadSnapshot(snapshot)
      for (const batch of batches) this.applyBatch(batch)
      const result = this.restoreResult()
      this.commit(); this.cache.clear(); this.observedRevision = result.revision
      return result
    } catch (cause) { this.rollback(); if (cause instanceof EnvironmentMemoryError) throw cause; fail("CORRUPTION", "snapshot restore failed", cause) }
  }

  private loadSnapshot(snapshot: EnvironmentMemorySnapshot) {
    if (this.currentRevision() !== 0 || Number(this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM identities").get()?.count ?? 0) !== 0 ||
        Number(this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM idempotency_history").get()?.count ?? 0) !== 0) {
      fail("CONFLICT", "snapshot restore requires an empty destination")
    }
    const identities = new Map<string, { record_type: "entity" | "relation"; revoked: boolean }>()
    for (const identity of snapshot.identities) {
      if (identities.has(identity.id)) fail("CORRUPTION", "snapshot has duplicate identities")
      identities.set(identity.id, identity)
      this.db.query("INSERT INTO identities(id,record_type,revoked) VALUES (?,?,?)")
        .run(identity.id, identity.record_type, Number(identity.revoked))
    }
    const active = new Set<string>()
    const entities = new Map<string, StoredEntity>()
    for (const entity of snapshot.entities) {
      if (containsSuspectedSecret(entity) || entity.scope.namespace !== this.namespace || entity.revision > snapshot.revision ||
          identities.get(entity.id)?.record_type !== "entity" || identities.get(entity.id)?.revoked || active.has(entity.id)) {
        fail("CORRUPTION", "snapshot entity identity, scope, or content is invalid")
      }
      active.add(entity.id); entities.set(entity.id, entity)
      this.writeRestoredEntity(entity)
    }
    for (const relation of snapshot.relations) {
      const source = entities.get(relation.source_id), target = entities.get(relation.target_id)
      const scope = relation.scope
      const reader: ReadScope = { namespace: scope.namespace, project: scope.project, owner: scope.owner ?? "" }
      if (containsSuspectedSecret(relation) || scope.namespace !== this.namespace || relation.revision > snapshot.revision ||
          identities.get(relation.id)?.record_type !== "relation" || identities.get(relation.id)?.revoked || active.has(relation.id) ||
          !source || !target || !visible(source, reader) || !visible(target, reader) ||
          (scope.visibility === "project" && (source.scope.visibility !== "project" || target.scope.visibility !== "project"))) {
        fail("CORRUPTION", "snapshot relation identity, endpoints, or scope are invalid")
      }
      active.add(relation.id)
      this.writeRestoredRelation(relation)
    }
    if ([...identities.values()].filter((identity) => !identity.revoked).length !== active.size) {
      fail("CORRUPTION", "snapshot has active identities without current records")
    }
    if (snapshot.idempotency.length !== snapshot.revision) fail("CORRUPTION", "snapshot is missing historical idempotency receipts")
    const keys = new Set<string>(), revisions = new Set<number>()
    let hasHead = snapshot.revision === 0
    for (const receipt of snapshot.idempotency) {
      if (keys.has(receipt.idempotency_key) || revisions.has(receipt.revision) || receipt.revision > snapshot.revision) {
        fail("CORRUPTION", "snapshot idempotency history is invalid")
      }
      keys.add(receipt.idempotency_key); revisions.add(receipt.revision)
      if (receipt.revision === snapshot.revision && receipt.event_hash === snapshot.event_hash) hasHead = true
      this.db.query("INSERT INTO idempotency_history(idempotency_key,operation_hash,revision,event_hash,content_hash) VALUES (?,?,?,?,?)")
        .run(receipt.idempotency_key, receipt.operation_hash, receipt.revision, receipt.event_hash, receipt.content_hash)
    }
    if (!hasHead) fail("CORRUPTION", "snapshot head has no matching idempotency receipt")
    this.setMeta("revision", String(snapshot.revision)); this.setMeta("head_hash", snapshot.event_hash ?? "")
    this.setMeta("base_revision", String(snapshot.revision)); this.setMeta("base_hash", snapshot.event_hash ?? "")
  }

  private writeRestoredEntity(entity: StoredEntity) {
    const s = entity.scope
    this.db.query("INSERT INTO entities(id,project,visibility,owner,expires_at,record_json,revision) VALUES (?,?,?,?,?,?,?)")
      .run(entity.id, s.project, s.visibility, s.owner, entity.provenance.expires_at, canonicalJson(entity), entity.revision)
  }
  private writeRestoredRelation(relation: StoredRelation) {
    const s = relation.scope
    this.db.query("INSERT INTO relations(id,source_id,target_id,project,visibility,owner,expires_at,valid_until,record_json,revision) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(relation.id, relation.source_id, relation.target_id, s.project, s.visibility, s.owner, relation.provenance.expires_at,
        relation.conditions.valid_until, canonicalJson(relation), relation.revision)
  }

  replay(input: EnvironmentMemoryEventBatch): RestoreResult {
    this.assertOpen()
    const parsed = EventBatchSchema.safeParse(input)
    if (!parsed.success) fail("CORRUPTION", "event batch schema is invalid", parsed.error)
    const batch = parsed.data
    if (batch.namespace !== this.namespace) fail("SCOPE_DENIED", "event batch belongs to another namespace")
    this.begin()
    try {
      this.applyBatch(batch)
      const result = this.restoreResult()
      this.commit(); this.cache.clear(); this.observedRevision = result.revision
      return result
    } catch (cause) { this.rollback(); if (cause instanceof EnvironmentMemoryError) throw cause; fail("CORRUPTION", "event replay failed", cause) }
  }

  private applyBatch(batch: EnvironmentMemoryEventBatch) {
    const current = this.currentRevision()
    if (batch.namespace !== this.namespace || batch.from_revision !== current || batch.previous_hash !== this.headHash()) {
      fail("CONFLICT", "event batch does not continue the local journal cursor")
    }
    let previous_hash = batch.previous_hash
    for (const event of batch.events) {
      if (event.namespace !== this.namespace || event.revision !== this.currentRevision() + 1 || event.previous_hash !== previous_hash) {
        fail("CORRUPTION", "event sequence or chain link is invalid")
      }
      const hashes = eventHashes({ schema_version: event.schema_version, namespace: event.namespace, revision: event.revision,
        previous_hash: event.previous_hash, timestamp: event.timestamp, idempotency_key: event.idempotency_key, operation: event.operation })
      if (hashes.content_hash !== event.content_hash || hashes.event_hash !== event.event_hash) fail("CORRUPTION", "event content hash is invalid")
      this.applyOperation(event.operation, event.revision)
      const operationHash = digestJson(event.operation)
      this.db.query("INSERT INTO event_log(revision,event_json,content_hash,event_hash,idempotency_key,operation_hash) VALUES (?,?,?,?,?,?)")
        .run(event.revision, canonicalJson(event), event.content_hash, event.event_hash, event.idempotency_key, operationHash)
      this.db.query("INSERT INTO idempotency_history(idempotency_key,operation_hash,revision,event_hash,content_hash) VALUES (?,?,?,?,?)")
        .run(event.idempotency_key, operationHash, event.revision, event.event_hash, event.content_hash)
      this.setMeta("revision", String(event.revision)); this.setMeta("head_hash", event.event_hash)
      previous_hash = event.event_hash
    }
  }

  private restoreResult(): RestoreResult {
    const entities = Number(this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM entities").get()?.count ?? 0)
    const relations = Number(this.db.query<{ count: number }, []>("SELECT count(*) AS count FROM relations").get()?.count ?? 0)
    return RestoreResultSchema.parse({ namespace: this.namespace, revision: this.currentRevision(), entities, relations,
      durability: "local-sqlite-commit" })
  }

  close() { if (!this.closed) { this.db.close(); this.cache.clear(); this.closed = true } }
}

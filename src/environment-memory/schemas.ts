import { z } from "zod"

export const ENVIRONMENT_MEMORY_SCHEMA_VERSION = 1 as const
export const MEMORY_MAX_RECORD_BYTES = 64 * 1024
export const MEMORY_MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024
export const MEMORY_MAX_EVENT_BATCH = 512
export const MEMORY_MAX_QUERY_NODES = 256
export const MEMORY_MAX_QUERY_DEPTH = 8
export const MEMORY_DEFAULT_CACHE_ENTRIES = 512
export const MEMORY_MAX_CACHE_ENTRIES = 8192

const SafeText = z.string().trim().min(1).max(512)
export const IdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/)
const Id = IdSchema
const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const Timestamp = z.iso.datetime({ offset: true })
const JsonScalar = z.union([z.string().max(4096), z.number().finite(), z.boolean(), z.null()])
const Metadata = z.record(z.string().min(1).max(128), JsonScalar).refine((value) =>
  Buffer.byteLength(JSON.stringify(value), "utf8") <= 16 * 1024, "metadata exceeds 16 KiB")

export const EntityKindSchema = z.enum([
  "host", "pod", "resource", "network", "route", "endpoint", "api", "repository",
  "deployment", "database", "dataset", "principal", "credential-provider", "rule",
])
export type EntityKind = z.infer<typeof EntityKindSchema>

export const RelationKindSchema = z.enum([
  "runs-on", "contains", "routes-through", "reaches", "calls", "deployed-from", "reads-from",
  "authenticates-as", "authorized-for", "constrained-by", "owned-by", "depends-on", "observed-at",
])
export type RelationKind = z.infer<typeof RelationKindSchema>

export const ScopeSchema = z.object({
  namespace: Id,
  project: Id,
  visibility: z.enum(["session", "project"]),
  owner: Id.nullable(),
}).strict().refine((scope) => (scope.visibility === "session") === (scope.owner !== null), {
  message: "session scope requires an owner; project scope must not have one",
})
export type MemoryScope = z.infer<typeof ScopeSchema>

export const ReadScopeSchema = z.object({ namespace: Id, project: Id, owner: Id }).strict()
export type ReadScope = z.infer<typeof ReadScopeSchema>

export const ProvenanceSchema = z.object({
  source_type: z.enum(["operator", "import", "session-memory", "environment-profile", "connector", "synthetic", "other"]),
  source_ref: SafeText,
  classification: z.enum(["declared", "observed", "inferred", "unknown"]),
  observed_at: Timestamp,
  verified_at: Timestamp.nullable(),
  expires_at: Timestamp.nullable(),
}).strict().refine((value) => {
  const observed = Date.parse(value.observed_at)
  const verified = value.verified_at === null ? null : Date.parse(value.verified_at)
  const expires = value.expires_at === null ? null : Date.parse(value.expires_at)
  return (verified === null || verified >= observed) && (expires === null || expires > observed)
}, "provenance timestamps are inconsistent")
export type Provenance = z.infer<typeof ProvenanceSchema>

export const EntitySchema = z.object({
  id: Id,
  kind: EntityKindSchema,
  label: SafeText,
  metadata: Metadata.default({}),
  scope: ScopeSchema,
  provenance: ProvenanceSchema,
}).strict()
export type Entity = z.infer<typeof EntitySchema>

export const RelationConditionsSchema = z.object({
  principal_ref: Id.nullable().default(null),
  restrictions: z.array(SafeText).max(16).default([]),
  valid_from: Timestamp.nullable().default(null),
  valid_until: Timestamp.nullable().default(null),
}).strict().refine((value) => value.valid_from === null || value.valid_until === null ||
  Date.parse(value.valid_until) > Date.parse(value.valid_from), "relation validity interval is empty")
export type RelationConditions = z.infer<typeof RelationConditionsSchema>

export const RelationSchema = z.object({
  id: Id,
  source_id: Id,
  target_id: Id,
  kind: RelationKindSchema,
  scope: ScopeSchema,
  provenance: ProvenanceSchema,
  conditions: RelationConditionsSchema.default({ principal_ref: null, restrictions: [], valid_from: null, valid_until: null }),
}).strict()
export type Relation = z.infer<typeof RelationSchema>

export const UpsertOperationSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("upsert_entity"), entity: EntitySchema }).strict(),
  z.object({ type: z.literal("upsert_relation"), relation: RelationSchema }).strict(),
])
export const RevokeOperationSchema = z.object({
  type: z.literal("revoke"), target_type: z.enum(["entity", "relation"]), target_id: Id,
  reason: SafeText, provenance: ProvenanceSchema,
}).strict()
export const OperationSchema = z.union([UpsertOperationSchema, RevokeOperationSchema])
export type EnvironmentMemoryOperation = z.infer<typeof OperationSchema>

export const AppendOptionsSchema = z.object({
  expected_revision: z.number().int().nonnegative(),
  idempotency_key: Id,
}).strict()
export type AppendOptions = z.infer<typeof AppendOptionsSchema>

export const CommittedRevisionSchema = z.object({
  namespace: Id, revision: z.number().int().nonnegative(), event_hash: Sha256,
  content_hash: Sha256, idempotent: z.boolean(), durability: z.literal("local-sqlite-commit"),
}).strict()
export type CommittedRevision = z.infer<typeof CommittedRevisionSchema>

export const EventSchema = z.object({
  schema_version: z.literal(ENVIRONMENT_MEMORY_SCHEMA_VERSION), namespace: Id,
  revision: z.number().int().positive(), previous_hash: Sha256.nullable(), content_hash: Sha256,
  event_hash: Sha256, timestamp: Timestamp, idempotency_key: Id, operation: OperationSchema,
}).strict()
export type EnvironmentMemoryEvent = z.infer<typeof EventSchema>

export const StoredEntitySchema = EntitySchema.extend({ revision: z.number().int().positive() }).strict()
export type StoredEntity = z.infer<typeof StoredEntitySchema>
export const StoredRelationSchema = RelationSchema.extend({ revision: z.number().int().positive() }).strict()
export type StoredRelation = z.infer<typeof StoredRelationSchema>

export const IdentitySchema = z.object({
  id: Id, record_type: z.enum(["entity", "relation"]), revoked: z.boolean(),
}).strict()
export type Identity = z.infer<typeof IdentitySchema>
export const IdempotencyReceiptSchema = z.object({
  idempotency_key: Id, operation_hash: Sha256, revision: z.number().int().positive(),
  event_hash: Sha256, content_hash: Sha256,
}).strict()
export type IdempotencyReceipt = z.infer<typeof IdempotencyReceiptSchema>

export const QueryOptionsSchema = z.object({
  scope: ReadScopeSchema, roots: z.array(Id).min(1).max(32),
  max_depth: z.number().int().min(0).max(MEMORY_MAX_QUERY_DEPTH).default(3),
  max_nodes: z.number().int().min(1).max(MEMORY_MAX_QUERY_NODES).default(64),
  now: Timestamp.default(() => new Date().toISOString()),
}).strict()
export type QueryOptions = z.input<typeof QueryOptionsSchema>

export const QueryPathSchema = z.object({
  root_id: Id, entity_ids: z.array(Id).max(MEMORY_MAX_QUERY_DEPTH + 1),
  relation_ids: z.array(Id).max(MEMORY_MAX_QUERY_DEPTH),
}).strict()
export const QueryResultSchema = z.object({
  revision: z.number().int().nonnegative(),
  entities: z.array(StoredEntitySchema).max(MEMORY_MAX_QUERY_NODES),
  relations: z.array(StoredRelationSchema).max(MEMORY_MAX_QUERY_NODES * 4),
  paths: z.array(QueryPathSchema).max(MEMORY_MAX_QUERY_NODES),
  stale_count: z.number().int().nonnegative(), missing_count: z.number().int().nonnegative(),
  omitted_count: z.number().int().nonnegative(),
}).strict()
export type QueryResult = z.infer<typeof QueryResultSchema>

export const SnapshotSchema = z.object({
  schema_version: z.literal(ENVIRONMENT_MEMORY_SCHEMA_VERSION), namespace: Id,
  revision: z.number().int().nonnegative(), event_hash: Sha256.nullable(),
  identities: z.array(IdentitySchema).max(500_000),
  idempotency: z.array(IdempotencyReceiptSchema).max(500_000),
  entities: z.array(StoredEntitySchema).max(100_000), relations: z.array(StoredRelationSchema).max(400_000),
}).strict().refine((snapshot) => (snapshot.revision === 0) === (snapshot.event_hash === null),
  "snapshot revision and journal hash are inconsistent")
export type EnvironmentMemorySnapshot = z.infer<typeof SnapshotSchema>

export const EventBatchSchema = z.object({
  schema_version: z.literal(ENVIRONMENT_MEMORY_SCHEMA_VERSION), namespace: Id,
  from_revision: z.number().int().nonnegative(), to_revision: z.number().int().nonnegative(),
  previous_hash: Sha256.nullable(), events: z.array(EventSchema).min(1).max(MEMORY_MAX_EVENT_BATCH),
}).strict().refine((batch) => batch.events[0]?.revision === batch.from_revision + 1 &&
  batch.events.at(-1)?.revision === batch.to_revision && batch.to_revision >= batch.from_revision,
"event batch bounds do not match its events")
export type EnvironmentMemoryEventBatch = z.infer<typeof EventBatchSchema>

export const RestoreResultSchema = z.object({
  namespace: Id, revision: z.number().int().nonnegative(), entities: z.number().int().nonnegative(),
  relations: z.number().int().nonnegative(), durability: z.literal("local-sqlite-commit"),
}).strict()
export type RestoreResult = z.infer<typeof RestoreResultSchema>

export const EngineStatusSchema = z.object({
  namespace: Id, revision: z.number().int().nonnegative(), event_hash: Sha256.nullable(), entities: z.number().int().nonnegative(),
  relations: z.number().int().nonnegative(),
  cache: z.object({ entries: z.number().int().nonnegative(), hits: z.number().int().nonnegative(), misses: z.number().int().nonnegative(), evictions: z.number().int().nonnegative(), capacity: z.number().int().positive() }).strict(),
  capacity: z.object({ max_record_bytes: z.number().int().positive(), max_snapshot_bytes: z.number().int().positive(), max_event_batch: z.number().int().positive() }).strict(),
  durability: z.literal("local-sqlite-commit"),
}).strict()
export type EngineStatus = z.infer<typeof EngineStatusSchema>

export interface OpenEnvironmentMemoryOptions {
  databasePath: string
  namespace: string
  cacheEntries?: number
  maxRecordBytes?: number
  maxSnapshotBytes?: number
  /** Injectable clock for deterministic freshness tests. */
  now?: () => Date
}

export type EnvironmentMemoryErrorCode =
  | "CONFLICT" | "STALE_EVIDENCE" | "CAPACITY" | "CORRUPTION" | "UNSUPPORTED_RUNTIME"
  | "NOT_FOUND" | "SCOPE_DENIED" | "INVALID_OPERATION" | "CLOSED"

export class EnvironmentMemoryError extends Error {
  constructor(readonly code: EnvironmentMemoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "EnvironmentMemoryError"
  }
}

export interface EnvironmentMemoryEngineContract {
  readonly namespace: string
  append(operation: EnvironmentMemoryOperation, options: AppendOptions): CommittedRevision
  get(id: string, scope: ReadScope): StoredEntity | StoredRelation | null
  query(options: QueryOptions): QueryResult
  status(): EngineStatus
  exportSnapshot(): EnvironmentMemorySnapshot
  eventsSince(revision: number, limit?: number): EnvironmentMemoryEventBatch | null
  restoreSnapshot(snapshot: EnvironmentMemorySnapshot): RestoreResult
  replay(batch: EnvironmentMemoryEventBatch): RestoreResult
  restoreWithReplay(snapshot: EnvironmentMemorySnapshot, batches: EnvironmentMemoryEventBatch[]): RestoreResult
  close(): void
}

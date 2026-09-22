import { z } from "zod"
import { isSafeId, isSafeProjectRelativePath } from "../paths.ts"

export const Hash = z.string().regex(/^[a-f0-9]{64}$/)
export const Id = z.string().refine(isSafeId)
export const SessionId = z.string().min(1).max(256)
const Text = z.string().min(1).max(2000)
const Time = z.iso.datetime({ offset: true })
export const MemoryOptionsSchema = z.object({
  mode: z.enum(["off", "observe", "assist"]).default("off"),
  maxContextTokens: z.number().int().min(512).max(32768).default(8192),
  contextFraction: z.number().min(0.01).max(0.25).default(0.1),
  fallbackTokens: z.number().int().min(256).max(4096).default(2048),
  responseReserve: z.number().int().min(512).max(65536).default(4096),
  toolReserve: z.number().int().min(512).max(32768).default(2048),
  artifactQuotaBytes: z.number().int().min(1024 * 1024).max(1024 * 1024 * 1024).default(128 * 1024 * 1024),
}).strict()
export type MemoryOptions = z.infer<typeof MemoryOptionsSchema>
export const FileRefSchema = z.object({
  path: z.string().max(512).refine(isSafeProjectRelativePath), sha256: Hash,
  bytes: z.number().int().min(1).max(65536),
}).strict()
export const SkillPayloadSchema = z.object({
  key: Hash, name: Id, source: z.string().min(1).max(512),
  files: z.array(FileRefSchema).min(1).max(10),
  environments: z.array(Id).max(32), operations: z.array(Id).max(32),
}).strict()
export const EnvironmentSchema = z.object({
  name: Id, origin: Id, origin_fingerprint: Hash, target: Id,
  kind: z.enum(["pc", "pod", "server", "api", "unknown"]),
  namespace: Id.nullable(), tenant: Id.nullable(), principal_ref: Id,
  protocol: Id, api_version: z.string().max(128), client_version: z.string().max(128),
  endpoint_refs: z.array(Id).max(32), route_refs: z.array(Id).max(32),
  tools: z.array(Id).max(64), credential_refs: z.array(Id).max(16),
  scopes: z.array(Id).max(32), verified_at: Time, expires_at: Time,
  source_ref: Hash,
}).strict().refine((value) => Date.parse(value.expires_at) > Date.parse(value.verified_at), "environment expiry must follow verification")
export const OperationSchema = z.object({
  adapter: Id, operation: Id, resource: Id, parameters_hash: Hash,
  environment: Hash, skill: Hash,
  purpose: z.enum(["action", "poll", "verify", "refresh", "regression", "transient-retry"]).default("action"),
}).strict()
export type Operation = z.infer<typeof OperationSchema>
export const RunCitationSchema = z.object({
  run_id: Id,
  revision: z.number().int().positive(),
  shell_gate_hash: Hash,
  limits_hash: Hash,
}).strict()
export type RunCitation = z.infer<typeof RunCitationSchema>
const Edge = z.object({ kind: z.enum(["applies-to", "requires", "resolved-by", "attempted-in", "supports", "refutes", "supersedes", "source"]), id: Hash }).strict()
const common = { schema_version: z.literal(1), project: Hash, owner: SessionId.nullable(),
  visibility: z.enum(["session", "project"]), created_at: Time,
  relations: z.array(Edge).max(48), summary: Text }
export const MemoryNodeSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("skill"), payload: SkillPayloadSchema }).strict(),
  z.object({ ...common, kind: z.literal("environment"), payload: EnvironmentSchema }).strict(),
  z.object({ ...common, kind: z.literal("proposal"), payload: z.object({ content: Text }).strict() }).strict(),
  z.object({ ...common, kind: z.literal("result"), payload: z.object({
    validation: z.literal("unverified-assistant-claim"), task_epoch: z.number().int().nonnegative(),
    user_message_id: SessionId, assistant_message_id: SessionId, environment: Hash.nullable(),
    session_id: SessionId.optional(), finish: z.string().min(1).max(64).optional(),
    artifact: Hash, excerpt: z.string().max(2000), bytes_omitted: z.number().int().nonnegative(),
    /** Hash of redacted tool evidence, not proof that the answer was verified. */
    tool_evidence: Hash.nullable(), completed: z.literal("assistant-turn-only"),
  }).strict() }).strict(),
  z.object({ ...common, kind: z.literal("evidence"), payload: z.object({ experience_id: Hash }).strict() }).strict(),
  z.object({ ...common, kind: z.literal("retry"), payload: z.object({
    signature: Hash, expires_at: Time, reason: Text,
  }).strict() }).strict(),
  z.object({ ...common, kind: z.literal("attempt"), payload: z.object({
    signature: Hash, operation: OperationSchema, outcome: z.enum(["success", "failure", "indeterminate"]),
    receipt: Hash, expires_at: Time, run_citation: RunCitationSchema.optional(),
  }).strict() }).strict(),
  z.object({ ...common, kind: z.literal("resolution"), payload: z.object({
    signature: Hash, environment: Hash, skill: Hash, verification: Hash,
    next_step: Text, expires_at: Time,
  }).strict() }).strict(),
]).refine((node) => (node.visibility === "session") === (node.owner !== null), "visibility/owner mismatch")
export type MemoryNode = z.infer<typeof MemoryNodeSchema>
export type StoredNode = MemoryNode & { id: string }
export const BindingSchema = z.object({ id: Hash, key: Hash, name: Id, environment: Hash.nullable() }).strict()
export const CheckpointSchema = z.object({
  schema_version: z.literal(1), project: Hash, owner: SessionId,
  revision: z.number().int().nonnegative(), parent: Hash.nullable(),
  updated_at: Time, task_epoch: z.number().int().nonnegative(), generation: z.number().int().nonnegative(),
  goal: z.string().max(2000), constraints: z.array(Text).max(20),
  environment: Hash.nullable(), skills: z.array(BindingSchema).max(32),
  pins: z.array(Hash).max(64), used_retries: z.array(Hash).max(64), completed: z.array(Id).max(64),
  next_step: z.string().max(2000), gaps: z.array(Text).max(16),
  /** First user sentence seen for this session. Not a committed task goal. */
  observed_opening: z.string().max(2000).optional(),
  source_cursor: z.string().max(256).nullable(), deleted: z.boolean(),
  result_after: z.number().int().nonnegative().optional(),
  delegation: z.object({ parent_owner: SessionId, parent_checkpoint: Hash, role: z.enum(["worker", "checker"]) }).strict().nullable(),
}).strict()
export type Checkpoint = z.infer<typeof CheckpointSchema>
export const ContextReceiptSchema = z.object({
  schema_version: z.literal(1), owner: SessionId, revision: z.number().int().nonnegative(), generation: z.number().int().nonnegative(),
  context_hash: Hash, selected: z.array(Hash).max(128), omitted: z.number().int().nonnegative(),
  budget: z.number().int().nonnegative(), estimated_tokens: z.number().int().nonnegative(),
  estimator: z.literal("utf8-byte-upper-estimate-v1"), total_headroom_known: z.boolean(),
  state: z.enum(["prepared", "blocked", "observed"]), reasons: z.array(z.string().max(256)).max(64),
}).strict()
export type ContextReceipt = z.infer<typeof ContextReceiptSchema>

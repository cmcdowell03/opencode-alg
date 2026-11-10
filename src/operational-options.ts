import { z } from "zod"

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Id = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)

/** Application policy supplied through the existing SDK/sidecar boundary, never by a workspace file. */
export const WorkspaceOptionsSchema = z.object({
  mode: z.enum(["off", "observe", "assist"]).default("off"),
  trustedRegistryHash: Hash.optional(),
  mandatoryOperations: z.array(Id).max(64).default([]),
}).strict()
export type WorkspaceOptions = z.infer<typeof WorkspaceOptionsSchema>

const endpoint = z.string().url().max(2048).refine((value) => {
  const url = new URL(value)
  return !url.username && !url.password && !url.search && !url.hash &&
    (url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
}, "MCP endpoint requires HTTPS or loopback HTTP without embedded credentials")
const ToolSchema = z.object({ name: Id, schemaHash: Hash }).strict()
const ExecutionLimitsSchema = z.object({
  maxDurationMs: z.number().int().min(100).max(86_400_000),
  maxBytesScanned: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxResultBytes: z.number().int().min(1).max(262_144),
  maxCost: z.number().finite().positive().max(1_000_000_000),
}).strict()
export const InvestigationAdapterSchema = z.object({
  endpoint,
  tokenEnv: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/).optional(),
  /** Logical service identity used in work keys; distinct from MCP initialize identity. */
  serverId: Id, serverRevision: Id, principalId: Id,
  mcpServerName: Id, mcpServerVersion: Id,
  profileEvidence: z.string().min(1).max(512),
  /** Operator-controlled qualification receipt; never synthesized from model or registry text. */
  verifierId: Id, evidenceSha256: Hash, verifiedAt: z.iso.datetime({ offset: true }),
  readOnlyOperations: z.literal(true),
  scopeEnforcedByServer: z.literal(true),
  /** Operator-attested server-enforced limits, pinned with the submit schema. A client timeout cannot stop a server job. */
  executionLimits: ExecutionLimitsSchema,
  expiresAt: z.iso.datetime({ offset: true }),
  idempotentSubmit: z.literal(true), lookupBySubmissionId: z.literal(true),
  operations: z.array(Id).min(1).max(32),
  submit: ToolSchema, lookup: ToolSchema, validateResult: ToolSchema, cancel: ToolSchema.optional(),
  timeoutMs: z.number().int().min(100).max(60_000).default(15_000),
  responseLimitBytes: z.number().int().min(1024).max(262_144).default(65_536),
}).strict().refine((value) => value.executionLimits.maxResultBytes <= value.responseLimitBytes,
  "service result limit exceeds response bound")
  .refine((value) => Date.parse(value.verifiedAt) < Date.parse(value.expiresAt),
    "service qualification must expire after verification")
export type InvestigationAdapter = z.infer<typeof InvestigationAdapterSchema>
export const InvestigationOptionsSchema = z.object({
  enabled: z.boolean().default(false),
  costLimit: z.number().finite().positive().max(1_000_000_000).default(100),
  /** Fixed reservation for injected/local ports. Live HTTP uses executionLimits.maxCost. */
  perJobReservation: z.number().finite().positive().max(1_000_000_000).optional(),
  adapter: InvestigationAdapterSchema.optional(),
}).strict()
export type InvestigationOptions = z.infer<typeof InvestigationOptionsSchema>

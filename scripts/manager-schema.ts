import { z } from "zod"

export const MANAGER_VERSION = "0.2.0"
export const MAX_GENERATIONS = 16
export const RECEIPT_FILE = "receipt.json"

const AbsolutePathSchema = z.string().min(1).max(4_096)
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/)
const GitCommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/)
const StableVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/)
const StableTagSchema = z.string().regex(/^v\d+\.\d+\.\d+$/)

export const DurableStateCompatibilitySchema = z.object({
  format: z.literal("alg-run-state"),
  current_schema: z.number().int().positive(),
  compatible_schemas: z.array(z.number().int().positive()).min(1).max(8),
  compatible_package_versions: z.array(StableVersionSchema).min(1).max(16),
}).strict()

export const BUNDLED_AGENT_NAMES = ["checker.md", "explorer.md", "implementer.md", "orchestrator.md", "researcher.md"] as const
export const BundledAgentNameSchema = z.enum(BUNDLED_AGENT_NAMES)

export const GenerationAgentSchema = z.object({
  name: BundledAgentNameSchema,
  source_hash: Sha256Schema,
}).strict()

export const ProductionDependencyIdentitySchema = z.object({
  sha256: Sha256Schema,
  files: z.number().int().nonnegative().max(40_000),
  bytes: z.number().int().nonnegative().max(256 * 1024 * 1024),
}).strict()

export const ManagedExcelMcpConfigSchema = z.object({
  type: z.literal("local"),
  command: z.tuple([AbsolutePathSchema, AbsolutePathSchema]),
  cwd: AbsolutePathSchema,
  environment: z.object({
    ALG_EXCEL_ROOT: AbsolutePathSchema,
    PYTHONDONTWRITEBYTECODE: z.literal("1"),
    PYTHONNOUSERSITE: z.literal("1"),
    PYTHONUTF8: z.literal("1"),
  }).strict(),
  enabled: z.literal(true),
  timeout: z.literal(30_000),
}).strict()

export const ExcelCapabilityReceiptSchema = z.object({
  enabled: z.boolean(),
  root: AbsolutePathSchema.nullable(),
  manifest_hash: Sha256Schema,
  lock_hash: Sha256Schema,
  wrapper_hash: Sha256Schema,
  validator_hash: Sha256Schema,
  env_path: AbsolutePathSchema.nullable(),
  env_hash: Sha256Schema.nullable(),
  env_files: z.number().int().nonnegative().max(80_000).nullable(),
  env_bytes: z.number().int().nonnegative().max(1024 * 1024 * 1024).nullable(),
  config_hash: Sha256Schema.nullable(),
  managed_config: ManagedExcelMcpConfigSchema.nullable(),
}).strict().superRefine((capability, ctx) => {
  const enabledValues = [capability.root, capability.env_path, capability.env_hash, capability.env_files, capability.env_bytes, capability.config_hash, capability.managed_config]
  if (capability.enabled && enabledValues.some((value) => value === null)) {
    ctx.addIssue({ code: "custom", message: "enabled Excel capability requires root, env, config hash, and managed config" })
  }
  if (!capability.enabled && enabledValues.some((value) => value !== null)) {
    ctx.addIssue({ code: "custom", message: "disabled Excel capability must not retain live configuration fields" })
  }
})

export const ReleaseGenerationSchema = z.object({
  id: z.string().regex(/^\d+\.\d+\.\d+-[a-f0-9]{12}$/),
  version: StableVersionSchema,
  tag: StableTagSchema,
  commit: GitCommitSchema,
  package_root: AbsolutePathSchema,
  spec: z.string().url().max(8_192),
  runtime_digest: Sha256Schema,
  lock_digest: Sha256Schema,
  installed_at: z.iso.datetime({ offset: true }),
  activated_at: z.iso.datetime({ offset: true }),
  dependency_manager: z.literal("npm"),
  // Optional only for deliberate v0.1 receipt compatibility; v0.2 requires it below.
  production_dependencies: ProductionDependencyIdentitySchema.optional(),
  agents: z.array(GenerationAgentSchema).max(32),
  durable_state: DurableStateCompatibilitySchema,
  // Optional only for deliberate compatibility with v0.1/no-capability receipts.
  capabilities: z.object({ excel: ExcelCapabilityReceiptSchema }).strict().optional(),
}).strict().superRefine((generation, ctx) => {
  if (generation.version !== "0.1.0" && generation.production_dependencies === undefined) {
    ctx.addIssue({ code: "custom", path: ["production_dependencies"], message: "v0.2+ generation requires production dependency identity" })
  }
})

export const ManagedAgentReceiptSchema = z.object({
  path: AbsolutePathSchema,
  disposition: z.enum(["managed", "custom", "missing"]),
  source_hash: Sha256Schema,
  current_hash: Sha256Schema.nullable(),
  managed_hash: Sha256Schema.nullable(),
  updated_at: z.iso.datetime({ offset: true }),
}).strict().superRefine((agent, ctx) => {
  if (agent.disposition === "managed" && (!agent.current_hash || agent.current_hash !== agent.managed_hash)) {
    ctx.addIssue({ code: "custom", message: "managed agent hashes must be present and equal" })
  }
  if (agent.disposition === "missing" && agent.current_hash !== null) {
    ctx.addIssue({ code: "custom", message: "missing agent must not have a current hash" })
  }
  if (agent.disposition !== "managed" && agent.managed_hash !== null) {
    ctx.addIssue({ code: "custom", message: "only managed agents may carry a managed hash" })
  }
})

const RegistrationSchema = z.object({
  config_path: AbsolutePathSchema,
  spec: z.string().url().max(8_192).nullable(),
}).strict()

export const ManagerReceiptSchema = z.object({
  schema_version: z.literal(1),
  manager_version: z.literal(MANAGER_VERSION),
  installed: z.boolean(),
  config_root: AbsolutePathSchema,
  install_root: AbsolutePathSchema,
  trusted_remote: z.string().min(1).max(8_192),
  channel: z.literal("stable"),
  active_generation: z.string().max(128).nullable(),
  generations: z.array(ReleaseGenerationSchema).max(MAX_GENERATIONS),
  server_registration: RegistrationSchema,
  tui_registration: RegistrationSchema,
  agents: z.record(BundledAgentNameSchema, ManagedAgentReceiptSchema),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  restart_required: z.object({
    pending: z.boolean(),
    since: z.iso.datetime({ offset: true }).nullable(),
    attested_at: z.iso.datetime({ offset: true }).nullable(),
  }).strict(),
}).strict().superRefine((receipt, ctx) => {
  const ids = new Set<string>()
  const knownAgentNames = new Set<string>()
  const foldedAgentNames = new Set<string>()
  for (const generation of receipt.generations) {
    if (ids.has(generation.id)) ctx.addIssue({ code: "custom", path: ["generations"], message: "duplicate generation id" })
    ids.add(generation.id)
    for (const agent of generation.agents) {
      const folded = agent.name.toLowerCase()
      if (foldedAgentNames.has(folded) && !knownAgentNames.has(agent.name)) {
        ctx.addIssue({ code: "custom", path: ["generations", generation.id, "agents"], message: "case-ambiguous bundled agent name" })
      }
      foldedAgentNames.add(folded)
      knownAgentNames.add(agent.name)
    }
  }
  for (const name of Object.keys(receipt.agents)) {
    if (!knownAgentNames.has(name)) ctx.addIssue({ code: "custom", path: ["agents", name], message: "receipt agent is not present in any retained generation" })
  }
  if (receipt.installed !== (receipt.active_generation !== null)) {
    ctx.addIssue({ code: "custom", message: "installed and active_generation disagree" })
  }
  if (receipt.active_generation !== null && !ids.has(receipt.active_generation)) {
    ctx.addIssue({ code: "custom", path: ["active_generation"], message: "active generation is absent from history" })
  }
  const active = receipt.generations.find((item) => item.id === receipt.active_generation)
  if (active) {
    if (receipt.server_registration.spec !== active.spec || receipt.tui_registration.spec !== active.spec) {
      ctx.addIssue({ code: "custom", message: "active registration specs disagree with generation" })
    }
  } else if (receipt.server_registration.spec !== null || receipt.tui_registration.spec !== null) {
    ctx.addIssue({ code: "custom", message: "uninstalled receipt must have null registration specs" })
  }
})

export type DurableStateCompatibility = z.infer<typeof DurableStateCompatibilitySchema>
export type ManagedExcelMcpConfig = z.infer<typeof ManagedExcelMcpConfigSchema>
export type ExcelCapabilityReceipt = z.infer<typeof ExcelCapabilityReceiptSchema>
export type ReleaseGeneration = z.infer<typeof ReleaseGenerationSchema>
export type ProductionDependencyIdentity = z.infer<typeof ProductionDependencyIdentitySchema>
export type ManagedAgentReceipt = z.infer<typeof ManagedAgentReceiptSchema>
export type ManagerReceipt = z.infer<typeof ManagerReceiptSchema>

export const JournalFileSchema = z.object({
  path: AbsolutePathSchema,
  kind: z.enum(["config", "agent"]),
  before_hash: Sha256Schema.nullable(),
  before_identity: z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict().nullable(),
  after_hash: Sha256Schema.nullable(),
  backup: AbsolutePathSchema.nullable(),
  claim: AbsolutePathSchema.nullable(),
  claim_identity: z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict().nullable(),
  prepared: AbsolutePathSchema.nullable(),
  prepared_identity: z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict().nullable(),
}).strict()

export const ManagerJournalSchema = z.object({
  schema_version: z.literal(1),
  transaction_id: z.uuid(),
  revision: z.number().int().min(0).max(256),
  previous_revision_sha256: Sha256Schema.nullable(),
  command: z.enum(["install", "update", "rollback", "uninstall", "restart-acknowledge"]),
  phase: z.enum(["prepared", "writing", "files-claimed", "live-written", "receipt-linked", "receipt-claimed", "receipt-published", "receipt-committed"]),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
  target_generation: z.string().max(128).nullable(),
  receipt_path: AbsolutePathSchema,
  receipt_before_hash: Sha256Schema.nullable(),
  receipt_before_identity: z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict().nullable(),
  receipt_after_hash: Sha256Schema,
  receipt_backup: AbsolutePathSchema.nullable(),
  receipt_backup_identity: z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict().nullable(),
  receipt_claim: AbsolutePathSchema.nullable(),
  receipt_claim_identity: z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict().nullable(),
  receipt_prepared: AbsolutePathSchema,
  receipt_prepared_identity: z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict(),
  files: z.array(JournalFileSchema).max(64),
}).strict()

export type ManagerJournal = z.infer<typeof ManagerJournalSchema>

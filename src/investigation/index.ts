import { createHash, randomUUID } from "node:crypto"
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { z } from "zod"
import { acquireFilesystemMutex, acquireFilesystemMutexAsync } from "../filesystem-mutex.ts"
import { canonicalJson } from "../persistence.ts"
import { atomicWriteFile, ensureDir, runContainedPath } from "../store.ts"

const MAX_WORK = 2_000
const MAX_ATTACHMENTS = 32
const MAX_HISTORY = 256
const MAX_METADATA_BYTES = 16_384
const MAX_BUDGET = 1_000_000_000
const MAX_LEDGER_BYTES = 32 * 1024 * 1024
const MAX_SNAPSHOT_BYTES = 2_000_000
// The result schema permits ~85 KiB of version references, coverage and metadata.
const TERMINAL_RECEIPT_RESERVE_BYTES = 100_000
const DEFAULT_MAX_ADMISSIONS = 100
export const MAX_CONCURRENT_EXPENSIVE_JOBS = 2

export const InvestigationStatusSchema = z.enum([
  "reserved", "submitting", "running", "result_recorded", "reusable", "failed_known",
  "outcome_unknown", "cancel_requested", "stale",
])
export type InvestigationStatus = z.infer<typeof InvestigationStatusSchema>

function hasCredentialMaterial(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasCredentialMaterial)
  if (!value || typeof value !== "object") return typeof value === "string" &&
    /\bBearer\s+\S+|(?:access[_-]?token|api[_-]?key|client[_-]?secret|password|credential)=\S+/i.test(value)
  return Object.entries(value).some(([key, child]) =>
    /(?:password|secret|credential|authorization|access[_-]?token|api[_-]?key)/i.test(key) || hasCredentialMaterial(child))
}
const JsonObjectSchema = z.record(z.string().max(128), z.unknown()).refine((v) =>
  Buffer.byteLength(JSON.stringify(v)) <= MAX_METADATA_BYTES, "metadata too large")
  .refine((v) => !hasCredentialMaterial(v), "credential material cannot be persisted")

export const InvestigationResultSchema = z.object({
  manifest_ref: z.string().min(1).max(2_048).refine((v) => !hasCredentialMaterial(v)),
  digest: z.string().regex(/^[a-f0-9]{64}$/i),
  source_versions: z.array(z.string().max(512)).max(128).refine((v) => !hasCredentialMaterial(v)),
  coverage: JsonObjectSchema,
  observed_at: z.string().datetime({ offset: true }),
  expires_at: z.string().datetime({ offset: true }).nullable().optional(),
  access_scope: z.string().min(1).max(512).refine((v) => !hasCredentialMaterial(v)),
}).strict()
export type InvestigationResult = z.infer<typeof InvestigationResultSchema>

export const InvestigationWorkInputSchema = z.object({
  operation: z.string().min(1).max(128),
  recipe_version: z.string().min(1).max(128),
  parameters: JsonObjectSchema,
  cohort: z.string().max(512).optional(),
  as_of: z.string().max(128).optional(),
  source_dependencies: z.array(z.string().max(512)).max(128).refine((v) => !hasCredentialMaterial(v)).default([]),
  preprocessing_revision: z.string().max(128).optional(),
  purpose: z.enum(["analysis", "independent_verification", "refresh", "recomputation"]).default("analysis"),
  generation: z.number().int().nonnegative().default(0),
  reserved_cost: z.number().finite().nonnegative().max(MAX_BUDGET),
  query: JsonObjectSchema,
}).strict()
export type InvestigationWorkInput = z.input<typeof InvestigationWorkInputSchema>

export interface InvestigationScope {
  project_directory: string
  project_id: string
  owner_id: string
  run_id: string
}
export interface InvestigationReference { schema_version: 1; project_id: string; owner_id: string; run_id: string }
export interface InvestigationHypothesis {
  id: string; statement: string; status: "active" | "supported" | "refuted" | "unresolved"
  evidence_refs: string[]; updated_at: string
}
export interface EngineerContribution {
  id: string; engineer_ref: string; statement: string; scope: string; source_ref?: string
  classification: "reported_knowledge"; received_at: string
}
export interface InvestigationCheckpoint {
  objective: string; scope: Record<string, unknown>; hypotheses: InvestigationHypothesis[]
  contradictions: string[]; completed_tests: string[]; coverage: Record<string, unknown>
  next_action: string; evidence_refs: string[]; engineer_contributions: EngineerContribution[]
}
export interface InvestigationWork {
  work_key: string; submission_id: string; operation: string; status: InvestigationStatus
  query: Record<string, unknown>; parameters: Record<string, unknown>; reserved_cost: number
  actual_cost?: number; external_job_id?: string; result?: InvestigationResult; failure?: string
  source_dependencies: string[]; validity_key: string; created_at: string; updated_at: string
  lease_fence: number; purpose: InvestigationWorkInput["purpose"]; generation: number
}
export interface InvestigationLedger {
  schema_version: 1; revision: number; scope: Omit<InvestigationScope, "project_directory">
  remote_profile?: InvestigationRemoteProfile
  created_at: string; updated_at: string; attachments: Array<{ session_id: string; attached_at: string }>
  cumulative_cost: number; reserved_cost: number; cost_limit: number; max_admissions: number; work: InvestigationWork[]
  checkpoint: InvestigationCheckpoint; history: Array<{ revision: number; at: string; kind: string; ref?: string }>
}
export interface InvestigationStatusView {
  reference: InvestigationReference; revision: number; cumulative_cost: number; reserved_cost: number; cost_limit: number
  max_admissions: number; admission_count: number; active_jobs: number
  work: Array<Pick<InvestigationWork, "work_key" | "operation" | "status" | "created_at" | "updated_at" | "external_job_id" | "failure">>
}

export interface InvestigationMcpCapabilities {
  server_id: string; server_revision: string; tool_id: string; tool_schema_revision: string
  principal_id: string; project_id: string; effects: readonly string[]
  idempotent_submit: true; lookup_by_submission_id: true
  response_limit_bytes: number; qualified: true
}
export interface InvestigationRemoteProfile {
  server_id: string; server_revision: string; tool_id: string; tool_schema_revision: string
  principal_id: string; project_id: string
}
export type InvestigationSubmission =
  | { kind: "running"; external_job_id: string }
  | { kind: "result"; result: InvestigationResult; actual_cost?: number }
  | { kind: "failed_known"; failure: string; actual_cost?: number }
export type InvestigationReconciliation =
  | { kind: "running"; external_job_id: string }
  | { kind: "result"; result: InvestigationResult; actual_cost?: number }
  | { kind: "failed_known"; failure: string; actual_cost?: number }
  | { kind: "not_found"; proves_not_accepted: true }
  | { kind: "unknown"; reason: string }
export interface InvestigationMcpPort {
  capabilities: InvestigationMcpCapabilities
  submit(request: { submission_id: string; work_key: string; operation: string; query: Record<string, unknown> }): Promise<InvestigationSubmission>
  lookup(submission_id: string): Promise<InvestigationReconciliation>
  validateResult?(result: InvestigationResult, work: InvestigationWork): Promise<{ valid: boolean; validity_key: string; access_scope: string; reason?: string }>
  cancel?(external_job_id: string): Promise<void>
}

interface Head { schema_version: 1; revision: number; snapshot_ref: string; sha256: string }
const HeadSchema = z.object({ schema_version: z.literal(1), revision: z.number().int().nonnegative(), snapshot_ref: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
const IsoDate = z.string().datetime({ offset: true })
const HypothesisSchema = z.object({ id: z.string().min(1).max(128), statement: z.string().max(4_000).refine((v) => !hasCredentialMaterial(v)),
  status: z.enum(["active", "supported", "refuted", "unresolved"]), evidence_refs: z.array(z.string().max(2_048)).max(128), updated_at: IsoDate }).strict()
const EngineerSchema = z.object({ id: z.uuid(), engineer_ref: z.string().min(1).max(256), statement: z.string().max(4_000).refine((v) => !hasCredentialMaterial(v)),
  scope: z.string().max(2_000).refine((v) => !hasCredentialMaterial(v)), source_ref: z.string().max(2_048).refine((v) => !hasCredentialMaterial(v)).optional(), classification: z.literal("reported_knowledge"), received_at: IsoDate }).strict()
const WorkSchema = z.object({ work_key: z.string().regex(/^[a-f0-9]{64}$/), submission_id: z.uuid(), operation: z.string().min(1).max(128),
  status: InvestigationStatusSchema, query: JsonObjectSchema, parameters: JsonObjectSchema, reserved_cost: z.number().finite().nonnegative(),
  actual_cost: z.number().finite().nonnegative().optional(), external_job_id: z.string().max(1_024).optional(),
  result: InvestigationResultSchema.optional(), failure: z.string().max(2_000).optional(), source_dependencies: z.array(z.string().max(512)).max(128),
  validity_key: z.string().regex(/^[a-f0-9]{64}$/), created_at: IsoDate, updated_at: IsoDate, lease_fence: z.number().int().nonnegative(),
  purpose: z.enum(["analysis", "independent_verification", "refresh", "recomputation"]), generation: z.number().int().nonnegative() }).strict()
const RemoteProfileSchema = z.object({ server_id: z.string().min(1).max(512), server_revision: z.string().min(1).max(512),
  tool_id: z.string().min(1).max(512), tool_schema_revision: z.string().min(1).max(512),
  principal_id: z.string().min(1).max(512), project_id: z.string().min(1).max(512) }).strict()
const CheckpointSchema = z.object({ objective: z.string().max(4_000), scope: JsonObjectSchema, hypotheses: z.array(HypothesisSchema).max(64),
  contradictions: z.array(z.string().max(2_000)).max(128), completed_tests: z.array(z.string().max(2_000)).max(128), coverage: JsonObjectSchema,
  next_action: z.string().max(2_000), evidence_refs: z.array(z.string().max(2_048)).max(256), engineer_contributions: z.array(EngineerSchema).max(128) }).strict()
const InvestigationLedgerSchema = z.object({ schema_version: z.literal(1), revision: z.number().int().nonnegative(),
  scope: z.object({ project_id: z.string().min(1).max(512), owner_id: z.string().min(1).max(512), run_id: z.string().min(1).max(512) }).strict(),
  remote_profile: RemoteProfileSchema.optional(),
  created_at: IsoDate, updated_at: IsoDate,
  attachments: z.array(z.object({ session_id: z.string().min(1).max(256), attached_at: IsoDate }).strict()).max(MAX_ATTACHMENTS),
  cumulative_cost: z.number().finite().nonnegative(), reserved_cost: z.number().finite().nonnegative(), cost_limit: z.number().finite().nonnegative(),
  max_admissions: z.number().int().positive().max(MAX_WORK), work: z.array(WorkSchema).max(MAX_WORK), checkpoint: CheckpointSchema,
  history: z.array(z.object({ revision: z.number().int().positive(), at: IsoDate, kind: z.string().min(1).max(128), ref: z.string().max(2_048).optional() }).strict()).max(MAX_HISTORY),
}).strict().superRefine((ledger, ctx) => {
  if (ledger.work.length && !ledger.remote_profile) ctx.addIssue({ code: "custom", path: ["remote_profile"], message: "work has no pinned remote profile" })
  if (ledger.cumulative_cost + ledger.reserved_cost > ledger.cost_limit) ctx.addIssue({ code: "custom", path: ["reserved_cost"], message: "investigation budget invariant violated" })
  const keys = new Set<string>(), submissions = new Set<string>()
  let reserved = 0, active = 0
  for (const work of ledger.work) {
    if (keys.has(work.work_key)) ctx.addIssue({ code: "custom", path: ["work"], message: "duplicate work key" })
    if (submissions.has(work.submission_id)) ctx.addIssue({ code: "custom", path: ["work"], message: "duplicate submission id" })
    keys.add(work.work_key); submissions.add(work.submission_id)
    if (["reserved", "submitting", "running", "outcome_unknown", "cancel_requested"].includes(work.status)) reserved += work.reserved_cost
    if (["submitting", "running", "outcome_unknown", "cancel_requested"].includes(work.status)) active++
  }
  if (reserved !== ledger.reserved_cost) ctx.addIssue({ code: "custom", path: ["reserved_cost"], message: "reservation total does not match work ledger" })
  if (active > MAX_CONCURRENT_EXPENSIVE_JOBS) ctx.addIssue({ code: "custom", path: ["work"], message: "concurrent expensive job limit exceeded" })
  if (ledger.work.length > ledger.max_admissions) ctx.addIssue({ code: "custom", path: ["work"], message: "admission count exceeds configured limit" })
})

function digest(text: string): string { return createHash("sha256").update(text).digest("hex") }
function safeJson(value: unknown): string {
  const body = canonicalJson(value)
  if (Buffer.byteLength(body) > MAX_SNAPSHOT_BYTES) throw new Error("investigation snapshot exceeds 2 MB")
  return body
}
function assertTerminalSpace(ledger: InvestigationLedger): void {
  const outstanding = ledger.work.filter((w) => ["reserved", "submitting", "running", "outcome_unknown", "cancel_requested"].includes(w.status)).length
  if (Buffer.byteLength(safeJson(ledger)) + outstanding * TERMINAL_RECEIPT_RESERVE_BYTES > MAX_SNAPSHOT_BYTES) {
    throw new Error("investigation terminal receipt reserve exhausted")
  }
}
function ledgerPaths(scope: InvestigationScope) {
  const root = runContainedPath(scope.project_directory, scope.run_id, "investigation")
  return { root, head: runContainedPath(scope.project_directory, scope.run_id, "investigation", "head.json"),
    lock: runContainedPath(scope.project_directory, scope.run_id, "investigation", "ledger.lock"),
    snapshot: (hash: string) => runContainedPath(scope.project_directory, scope.run_id, "investigation", `ledger-${hash}.json`) }
}
function scopeOnly(scope: InvestigationScope): InvestigationLedger["scope"] {
  if (!scope.project_id || !scope.owner_id || !scope.run_id) throw new Error("project, owner and run identity are required")
  return { project_id: scope.project_id, owner_id: scope.owner_id, run_id: scope.run_id }
}
function remoteProfile(capabilities: InvestigationMcpCapabilities): InvestigationRemoteProfile {
  return RemoteProfileSchema.parse({ server_id: capabilities.server_id, server_revision: capabilities.server_revision,
    tool_id: capabilities.tool_id, tool_schema_revision: capabilities.tool_schema_revision,
    principal_id: capabilities.principal_id, project_id: capabilities.project_id })
}
function workIdentity(scope: InvestigationLedger["scope"], port: InvestigationMcpCapabilities, input: z.infer<typeof InvestigationWorkInputSchema>): { key: string; validity: string } {
  const semantics = { project_id: scope.project_id, principal_id: port.principal_id, server_id: port.server_id,
    server_revision: port.server_revision, tool_id: port.tool_id, tool_schema_revision: port.tool_schema_revision,
    operation: input.operation, recipe_version: input.recipe_version, parameters: input.parameters,
    cohort: input.cohort ?? null, as_of: input.as_of ?? null, source_dependencies: input.source_dependencies,
    preprocessing_revision: input.preprocessing_revision ?? null, purpose: input.purpose, generation: input.generation,
    query: input.query }
  const validity = digest(safeJson({ dependencies: input.source_dependencies, cohort: input.cohort ?? null, as_of: input.as_of ?? null }))
  return { key: digest(safeJson({ version: 1, ...semantics })), validity }
}
function blank(scope: InvestigationScope, costLimit: number, now: string, maxAdmissions = DEFAULT_MAX_ADMISSIONS): InvestigationLedger {
  if (!Number.isFinite(costLimit) || costLimit < 0 || costLimit > MAX_BUDGET) throw new Error("invalid investigation cost limit")
  if (!Number.isSafeInteger(maxAdmissions) || maxAdmissions < 1 || maxAdmissions > MAX_WORK) throw new Error("invalid investigation admission limit")
  return { schema_version: 1, revision: 0, scope: scopeOnly(scope), created_at: now, updated_at: now,
    attachments: [], cumulative_cost: 0, reserved_cost: 0, cost_limit: costLimit, max_admissions: maxAdmissions, work: [],
    checkpoint: { objective: "", scope: {}, hypotheses: [], contradictions: [], completed_tests: [], coverage: {}, next_action: "", evidence_refs: [], engineer_contributions: [] }, history: [] }
}

export class InvestigationStore {
  readonly reference: InvestigationReference
  private readonly paths: ReturnType<typeof ledgerPaths>
  private constructor(readonly scope: InvestigationScope, private ledger: InvestigationLedger,
    private readonly now: () => Date = () => new Date(), private readonly lockWaitMs = 5_000) {
    this.paths = ledgerPaths(scope)
    this.reference = { schema_version: 1, ...scopeOnly(scope) }
  }

  static open(scope: InvestigationScope, options: { create?: boolean; costLimit?: number; maxAdmissions?: number; now?: () => Date; lockWaitMs?: number } = {}): InvestigationStore {
    const paths = ledgerPaths(scope)
    if (!existsSync(paths.head)) {
      if (!options.create) throw new Error("investigation does not exist")
      const store = new InvestigationStore(scope, blank(scope, options.costLimit ?? 0, (options.now ?? (() => new Date()))().toISOString(), options.maxAdmissions), options.now, options.lockWaitMs)
      store.initialize()
      return store
    }
    const store = new InvestigationStore(scope, blank(scope, 0, new Date().toISOString()), options.now, options.lockWaitMs)
    store.ledger = store.readLedger()
    store.assertScope(store.ledger)
    return store
  }

  get snapshot(): InvestigationLedger { return structuredClone(this.refresh()) }
  get context(): InvestigationCheckpoint { return structuredClone(this.refresh().checkpoint) }
  status(): InvestigationStatusView {
    const ledger = this.refresh()
    return { reference: this.reference, revision: ledger.revision, cumulative_cost: ledger.cumulative_cost,
      reserved_cost: ledger.reserved_cost, cost_limit: ledger.cost_limit, max_admissions: ledger.max_admissions,
      admission_count: ledger.work.length,
      active_jobs: ledger.work.filter((w) => ["submitting", "running", "outcome_unknown", "cancel_requested"].includes(w.status)).length,
      work: ledger.work.map(({ work_key, operation, status, created_at, updated_at, external_job_id, failure }) =>
        ({ work_key, operation, status, created_at, updated_at, ...(external_job_id ? { external_job_id } : {}), ...(failure ? { failure } : {}) })) }
  }

  private initialize(): void {
    ensureDir(this.paths.root)
    const held = acquireFilesystemMutex(this.paths.lock, { owner: `investigation-create:${this.scope.run_id}`, leaseMs: 10_000 })
    try {
      if (existsSync(this.paths.head)) { this.ledger = this.readLedger(); this.assertScope(this.ledger); return }
      const body = safeJson(this.ledger), hash = digest(body), file = this.paths.snapshot(hash)
      if (!existsSync(file)) atomicWriteFile(file, body)
      atomicWriteFile(this.paths.head, safeJson({ schema_version: 1, revision: 0, snapshot_ref: file, sha256: hash } satisfies Head))
    } finally { held.release() }
  }
  private assertScope(ledger: InvestigationLedger): void {
    if (safeJson(ledger.scope) !== safeJson(scopeOnly(this.scope))) throw new Error("investigation owner/project/run mismatch")
  }
  private readLedger(): InvestigationLedger {
    const head = HeadSchema.parse(JSON.parse(readFileSync(this.paths.head, "utf8")))
    const file = this.paths.snapshot(head.sha256)
    if (head.snapshot_ref !== file) throw new Error("investigation head references a path outside its contained ledger")
    if (!existsSync(file)) throw new Error("investigation head snapshot missing")
    const body = readFileSync(file, "utf8")
    if (digest(body) !== head.sha256) throw new Error("investigation snapshot integrity failure")
    const value = InvestigationLedgerSchema.parse(JSON.parse(body))
    if (value.schema_version !== 1 || value.revision !== head.revision) throw new Error("unsupported or inconsistent investigation ledger")
    return value
  }
  private refresh(): InvestigationLedger { this.ledger = this.readLedger(); this.assertScope(this.ledger); return this.ledger }

  private async mutate<T>(kind: string, fn: (ledger: InvestigationLedger) => T): Promise<T> {
    // The lock covers local reads/writes only; callers release it before any MCP operation.
    const held = await acquireFilesystemMutexAsync(this.paths.lock, {
      owner: `investigation:${this.scope.run_id}`, leaseMs: 10_000, waitMs: this.lockWaitMs,
    })
    try {
      const current = existsSync(this.paths.head) ? this.readLedger() : structuredClone(this.ledger)
      this.assertScope(current)
      const next = structuredClone(current)
      const result = fn(next)
      next.revision = current.revision + 1
      next.updated_at = this.now().toISOString()
      next.history = [...next.history, { revision: next.revision, at: next.updated_at, kind }].slice(-MAX_HISTORY)
      InvestigationLedgerSchema.parse(next)
      assertTerminalSpace(next)
      const body = safeJson(next), hash = digest(body), file = this.paths.snapshot(hash)
      // A crash may leave an unreferenced snapshot; reclaim it before quota admission.
      this.collectOldSnapshots(HeadSchema.parse(JSON.parse(readFileSync(this.paths.head, "utf8"))).sha256)
      this.ensureDiskBudget(Buffer.byteLength(body))
      if (!existsSync(file)) atomicWriteFile(file, body)
      atomicWriteFile(this.paths.head, safeJson({ schema_version: 1, revision: next.revision, snapshot_ref: file, sha256: hash } satisfies Head))
      this.ledger = next
      this.collectOldSnapshots(hash)
      return result
    } finally { held.release() }
  }
  private ensureDiskBudget(nextBytes: number): void {
    const files = readdirSync(this.paths.root).filter((name) => name.startsWith("ledger-") && name.endsWith(".json"))
    const currentBytes = files.reduce((sum, name) => sum + statSync(runContainedPath(this.scope.project_directory, this.scope.run_id, "investigation", name)).size, 0)
    if (currentBytes + nextBytes > MAX_LEDGER_BYTES) throw new Error("investigation ledger disk quota exhausted")
  }
  private collectOldSnapshots(keepHash: string): void {
    for (const name of readdirSync(this.paths.root)) {
      if (!name.startsWith("ledger-") || !name.endsWith(".json") || name === `ledger-${keepHash}.json`) continue
      rmSync(runContainedPath(this.scope.project_directory, this.scope.run_id, "investigation", name), { force: true })
    }
  }

  async attach(sessionId: string, authorization: { owner_id: string; project_id: string }): Promise<InvestigationReference> {
    if (authorization?.owner_id !== this.scope.owner_id || authorization?.project_id !== this.scope.project_id) {
      throw new Error("investigation attach requires verified owner/project authorization")
    }
    if (!sessionId || sessionId.length > 256) throw new Error("invalid session id")
    await this.mutate("attached", (l) => { if (!l.attachments.some((a) => a.session_id === sessionId)) {
      l.attachments = [...l.attachments, { session_id: sessionId, attached_at: this.now().toISOString() }].slice(-MAX_ATTACHMENTS)
    } })
    return this.reference
  }
  async detach(sessionId: string): Promise<void> { await this.mutate("detached", (l) => { l.attachments = l.attachments.filter((a) => a.session_id !== sessionId) }) }

  async updateCheckpoint(patch: Partial<InvestigationCheckpoint>): Promise<InvestigationCheckpoint> {
    await this.mutate("checkpoint", (l) => {
      l.checkpoint = { ...l.checkpoint, ...structuredClone(patch) }
      if (l.checkpoint.hypotheses.length > 64 || l.checkpoint.engineer_contributions.length > 128) throw new Error("checkpoint limit exceeded")
      if (Buffer.byteLength(safeJson(l.checkpoint)) > MAX_METADATA_BYTES) throw new Error("checkpoint exceeds bounded context limit")
    })
    return this.context
  }
  async recordEngineerContribution(input: Omit<EngineerContribution, "id" | "classification" | "received_at">): Promise<EngineerContribution> {
    const value: EngineerContribution = { ...input, id: randomUUID(), classification: "reported_knowledge", received_at: this.now().toISOString() }
    await this.mutate("engineer_contribution", (l) => { l.checkpoint.engineer_contributions.push(value) })
    return value
  }
  async upsertHypothesis(input: Omit<InvestigationHypothesis, "updated_at">): Promise<InvestigationHypothesis> {
    const value = { ...input, updated_at: this.now().toISOString() }
    await this.mutate("hypothesis", (l) => {
      const i = l.checkpoint.hypotheses.findIndex((h) => h.id === value.id)
      if (i < 0) l.checkpoint.hypotheses.push(value); else l.checkpoint.hypotheses[i] = value
      if (l.checkpoint.hypotheses.length > 64) throw new Error("hypothesis limit exceeded")
    })
    return value
  }

  async admit(inputValue: InvestigationWorkInput, capabilities: InvestigationMcpCapabilities): Promise<InvestigationWork> {
    const input = InvestigationWorkInputSchema.parse(inputValue)
    this.assertCapabilities(capabilities)
    const current = this.refresh(), identity = workIdentity(current.scope, capabilities, input)
    let result!: InvestigationWork
    await this.mutate("work_reserved", (l) => {
      this.assertPinnedProfile(l, capabilities)
      if (!l.remote_profile) l.remote_profile = remoteProfile(capabilities)
      const existing = l.work.find((w) => w.work_key === identity.key)
      if (existing) { result = existing; return }
      if (l.work.length >= Math.min(MAX_WORK, l.max_admissions)) throw new Error("investigation admission count exhausted")
      if (l.cumulative_cost + l.reserved_cost + input.reserved_cost > l.cost_limit) throw new Error("investigation cost quota exhausted")
      const now = this.now().toISOString()
      result = { work_key: identity.key, submission_id: randomUUID(), operation: input.operation, status: "reserved",
        query: input.query, parameters: input.parameters, reserved_cost: input.reserved_cost, source_dependencies: input.source_dependencies,
        validity_key: identity.validity, created_at: now, updated_at: now, lease_fence: l.revision + 1,
        purpose: input.purpose ?? "analysis", generation: input.generation ?? 0 }
      l.work.push(result); l.reserved_cost += input.reserved_cost
    })
    return structuredClone(result)
  }

  private assertCapabilities(c: InvestigationMcpCapabilities): void {
    if (!c || c.qualified !== true || c.idempotent_submit !== true || c.lookup_by_submission_id !== true ||
      !c.server_id || !c.server_revision || !c.tool_id || !c.tool_schema_revision ||
      !c.project_id || !c.principal_id ||
      !Number.isSafeInteger(c.response_limit_bytes) || c.response_limit_bytes <= 0 || c.response_limit_bytes > 10_000_000 ||
      !Array.isArray(c.effects) || c.effects.some((effect) => effect !== "read")) {
      throw new Error("investigation transport capabilities are unqualified or out of scope")
    }
    remoteProfile(c)
  }
  private assertPinnedProfile(ledger: InvestigationLedger, capabilities: InvestigationMcpCapabilities): void {
    if (ledger.work.length && !ledger.remote_profile) throw new Error("investigation remote profile is missing")
    if (ledger.remote_profile && safeJson(ledger.remote_profile) !== safeJson(remoteProfile(capabilities))) {
      throw new Error("investigation remote profile mismatch")
    }
  }
  private async updateWork(key: string, kind: string, fn: (l: InvestigationLedger, w: InvestigationWork) => void, expectedFence?: number): Promise<InvestigationWork> {
    let result!: InvestigationWork
    await this.mutate(kind, (l) => {
      const w = l.work.find((x) => x.work_key === key)
      if (!w) throw new Error("unknown work key")
      if (expectedFence !== undefined && w.lease_fence !== expectedFence) throw new Error("stale investigation work fence")
      fn(l, w); w.lease_fence = l.revision + 1; w.updated_at = this.now().toISOString(); result = structuredClone(w)
    })
    return result
  }

  async dispatch(workKey: string, port: InvestigationMcpPort): Promise<InvestigationWork> {
    this.assertCapabilities(port.capabilities)
    const ledger = this.refresh()
    this.assertPinnedProfile(ledger, port.capabilities)
    const before = ledger.work.find((w) => w.work_key === workKey)
    if (!before) throw new Error("unknown work key")
    if (["submitting", "running", "outcome_unknown", "cancel_requested"].includes(before.status)) return before
    if (before.status !== "reserved") throw new Error(`work cannot dispatch from ${before.status}`)
    const submitting = await this.updateWork(workKey, "submission_intent", (l, w) => {
      this.assertPinnedProfile(l, port.capabilities)
      if (w.status !== "reserved") throw new Error(`work cannot dispatch from ${w.status}`)
      const active = l.work.filter((item) => ["submitting", "running", "outcome_unknown", "cancel_requested"].includes(item.status)).length
      if (active >= MAX_CONCURRENT_EXPENSIVE_JOBS) throw new Error("investigation concurrent job limit reached")
      w.status = "submitting"
    })
    let outcome: InvestigationSubmission
    try {
      outcome = await port.submit({ submission_id: submitting.submission_id, work_key: workKey,
        operation: submitting.operation, query: submitting.query })
      if (Buffer.byteLength(safeJson(outcome)) > port.capabilities.response_limit_bytes) throw new Error("MCP response exceeds qualified response bound")
    } catch (error) {
      return await this.updateWork(workKey, "submission_ambiguous", (_l, w) => { w.status = "outcome_unknown"; w.failure = safeError(error) }, submitting.lease_fence)
    }
    return await this.recordSubmissionOutcome(workKey, outcome, submitting.lease_fence)
  }
  private recordSubmissionOutcome(key: string, outcome: InvestigationSubmission | InvestigationReconciliation, expectedFence?: number): Promise<InvestigationWork> {
    return this.updateWork(key, `submission_${outcome.kind}`, (l, w) => {
      if (!["submitting", "running", "outcome_unknown", "cancel_requested"].includes(w.status)) throw new Error("work is no longer awaiting a remote outcome")
      if (outcome.kind === "running") {
        if (!outcome.external_job_id || outcome.external_job_id.length > 1_024) throw new Error("invalid remote job identity")
        if (w.external_job_id && w.external_job_id !== outcome.external_job_id) throw new Error("remote job identity changed")
        w.external_job_id = outcome.external_job_id
        if (w.status !== "cancel_requested") w.status = "running"
      }
      else if (outcome.kind === "result") { w.status = "result_recorded"; w.result = InvestigationResultSchema.parse(outcome.result); w.actual_cost = outcome.actual_cost }
      else if (outcome.kind === "failed_known") { w.status = "failed_known"; w.failure = safeError(outcome.failure); w.actual_cost = outcome.actual_cost }
      else if (outcome.kind === "not_found" && outcome.proves_not_accepted && !w.external_job_id && w.status !== "cancel_requested") { w.status = "reserved" }
      else if (w.status !== "cancel_requested") { w.status = "outcome_unknown"; w.failure = outcome.kind === "unknown" ? safeError(outcome.reason) : "unrecognized remote state" }
      if (w.status === "result_recorded" || w.status === "failed_known") {
        const cost = w.actual_cost
        if (cost !== undefined && (!Number.isFinite(cost) || cost < 0 || cost > w.reserved_cost)) throw new Error("reported cost exceeds reservation")
        l.reserved_cost -= w.reserved_cost
        l.cumulative_cost += cost ?? w.reserved_cost
        w.reserved_cost = 0
      }
    }, expectedFence)
  }
  async reconcile(workKey: string, port: InvestigationMcpPort): Promise<InvestigationWork> {
    this.assertCapabilities(port.capabilities)
    const ledger = this.refresh()
    this.assertPinnedProfile(ledger, port.capabilities)
    const w = ledger.work.find((x) => x.work_key === workKey)
    if (!w) throw new Error("unknown work key")
    if (!["submitting", "outcome_unknown", "running", "cancel_requested"].includes(w.status)) return w
    let receipt: InvestigationReconciliation
    try {
      receipt = await port.lookup(w.submission_id)
      if (Buffer.byteLength(safeJson(receipt)) > port.capabilities.response_limit_bytes) throw new Error("MCP reconciliation exceeds qualified response bound")
    } catch (error) {
      return await this.updateWork(workKey, "reconcile_unknown", (l, x) => {
        this.assertPinnedProfile(l, port.capabilities)
        if (x.status !== "cancel_requested") x.status = "outcome_unknown"
        x.failure = safeError(error)
      }, w.lease_fence)
    }
    return await this.recordSubmissionOutcome(workKey, receipt, w.lease_fence)
  }
  async reconcileBeforeResume(port: InvestigationMcpPort): Promise<{ ready: boolean; blocked: Array<{ work_key: string; status: InvestigationStatus }> }> {
    const current = this.refresh()
    for (const w of current.work) if (["submitting", "outcome_unknown", "running", "cancel_requested"].includes(w.status)) await this.reconcile(w.work_key, port)
    const blocked = this.refresh().work.filter((w) => ["submitting", "outcome_unknown", "running", "cancel_requested"].includes(w.status))
      .map(({ work_key, status }) => ({ work_key, status }))
    return { ready: blocked.length === 0, blocked }
  }
  async markReusable(workKey: string, port: InvestigationMcpPort): Promise<InvestigationWork> {
    this.assertCapabilities(port.capabilities)
    const ledger = this.refresh()
    this.assertPinnedProfile(ledger, port.capabilities)
    const initial = ledger.work.find((w) => w.work_key === workKey)
    if (!initial?.result || !port.validateResult) throw new Error("fresh remote result validity and access validation are required")
    const validation = await port.validateResult(initial.result, initial)
    const updated = await this.updateWork(workKey, "result_reusable", (l, w) => {
      this.assertPinnedProfile(l, port.capabilities)
      if (w.status !== "result_recorded" && w.status !== "reusable") throw new Error("result is not available")
      if (!w.result || !validation.valid || w.validity_key !== validation.validity_key || w.result.access_scope !== validation.access_scope ||
        (w.result.expires_at && Date.parse(w.result.expires_at) <= this.now().getTime())) {
        w.status = "stale"
        return
      }
      w.status = "reusable"
    }, initial.lease_fence)
    if (updated.status === "stale") throw new Error(`result validity, permission or retention check failed${validation.reason ? `: ${validation.reason}` : ""}`)
    return updated
  }
  recordResultValidity(workKey: string, port: InvestigationMcpPort): Promise<InvestigationWork> {
    return this.markReusable(workKey, port)
  }
  async getReusableResult(workKey: string, port: InvestigationMcpPort): Promise<InvestigationResult> {
    const work = await this.markReusable(workKey, port)
    if (work.status !== "reusable" || !work.result) throw new Error("validated reusable result is unavailable")
    if (Buffer.byteLength(safeJson(work.result)) > port.capabilities.response_limit_bytes) throw new Error("result exceeds qualified response bound")
    return structuredClone(work.result)
  }
  requestCancel(workKey: string): Promise<InvestigationWork> {
    return this.updateWork(workKey, "cancel_requested", (_l, w) => { if (w.status !== "running") throw new Error("only running work can be cancelled"); w.status = "cancel_requested" })
  }
  async cancel(workKey: string, port: InvestigationMcpPort): Promise<InvestigationWork> {
    this.assertCapabilities(port.capabilities)
    this.assertPinnedProfile(this.refresh(), port.capabilities)
    const requested = await this.requestCancel(workKey)
    if (!port.cancel) return requested
    // A cancellation acknowledgement is not proof compute stopped; reconcile the external job before releasing quota.
    try { await port.cancel(requested.external_job_id!) } catch { /* keep cancel_requested and its reservation */ }
    return requested
  }
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/((?:access[_-]?token|api[_-]?key|client[_-]?secret|password|credential)=)[^\s&]+/gi, "$1[redacted]")
    .slice(0, 2_000)
}

/** Read-only managed route. It never exposes credentials or silently qualifies a server. */
export function investigationPortIsQualified(port: InvestigationMcpPort, scope: InvestigationScope): boolean {
  try {
    if (!port || typeof port.submit !== "function" || typeof port.lookup !== "function") return false
    if (!scope.project_id || !scope.owner_id || !scope.run_id) return false
    remoteProfile(port.capabilities)
    return port.capabilities.qualified === true && port.capabilities.idempotent_submit === true &&
      port.capabilities.lookup_by_submission_id === true &&
      Number.isSafeInteger(port.capabilities.response_limit_bytes) && port.capabilities.response_limit_bytes > 0 &&
      port.capabilities.response_limit_bytes <= 10_000_000 && Array.isArray(port.capabilities.effects) &&
      port.capabilities.effects.every((x) => x === "read")
  } catch { return false }
}

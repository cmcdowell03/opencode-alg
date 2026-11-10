import { lstatSync } from "node:fs"
import { createHash } from "node:crypto"
import { canonicalDirectory, resolveContainedPath } from "../paths.ts"
import { readSkillEvolutionDirectBounded } from "../skill-evolution-store.ts"
import { WorkspaceRegistrySchema, type WorkspaceOperation, type WorkspaceRegistry, type WorkspaceRequirement } from "./schema.ts"

export * from "./schema.ts"
export const WORKSPACE_REGISTRY_PATH = ".opencode/ALG.workspace.json"
export const WORKSPACE_REGISTRY_MAX_BYTES = 64 * 1024

export type ReadinessState = "applicable" | "incompatible" | "unknown" | "stale" | "conflict"
export type SkillApprovalState = "approved" | "untrusted" | "missing" | "stale" | "conflict"
export interface SkillApprovalEvidence {
  state: SkillApprovalState
  name: string
  closure_hash?: string
  source_revision?: string
  operations?: string[]
  environments?: string[]
  binding_id?: string
}
export interface WorkspaceFactEvidence {
  state: "known" | "missing" | "stale" | "conflict" | "untrusted"
  value?: string
  source_revision?: string
  observed_at?: string
  expires_at?: string
  source?: string
}
export interface WorkspaceCallerSnapshot {
  caller_id: string
  task_epoch: number
  phase: string
  operation: string
  resource_ids: string[]
  environment_id: string
  role: string
  facts: Record<string, WorkspaceFactEvidence>
  now?: string
}
export interface WorkspaceSkillResolver {
  /** Adapter should resolve the caller's current SkillIndex binding and approval evidence. */
  resolve(ref: string, snapshot: WorkspaceCallerSnapshot): SkillApprovalEvidence | undefined
}
export interface WorkspaceReadinessOptions {
  mode?: "off" | "observe" | "assist"
  trustedRegistryHash?: string
  skills: WorkspaceSkillResolver
  /** Must consult operator controlled routing policy; registry content never establishes this authority. */
  authorizeMandatory?: (operation: WorkspaceOperation, requirement: WorkspaceRequirement, snapshot: WorkspaceCallerSnapshot) => boolean
  /** True only when the named operation is actually admitted and checked at this boundary. */
  boundaryQualified?: (operation: WorkspaceOperation) => boolean
  sourceRevisions?: Record<string, string>
}
export interface RequirementResult {
  id: string
  kind: WorkspaceRequirement["kind"] | "scope"
  ref: string
  state: ReadinessState
  mandatory: boolean
  reason: string
  evidence?: Record<string, string>
}
export interface WorkspaceReadiness {
  status: "ready" | "needs_skill" | "needs_context" | "conflict" | "coverage_unknown"
  operation: string
  mode: "off" | "advisory" | "enforced"
  registry_sha256: string
  requirements: RequirementResult[]
  missing: string[]
  stale: string[]
  conflicts: string[]
  next_discovery: string[]
}
export interface WorkspaceContextProjection {
  status: WorkspaceReadiness["status"]
  operation: string
  mode: WorkspaceReadiness["mode"]
  registry_sha256: string
  requirements: Array<Pick<RequirementResult, "id" | "kind" | "ref" | "state" | "mandatory" | "reason">>
  missing: string[]
  stale: string[]
  conflicts: string[]
  next_discovery: string[]
}
export type WorkspaceRegistryRead =
  | { state: "ready"; registry: WorkspaceRegistry; sha256: string }
  | { state: "missing"; path: typeof WORKSPACE_REGISTRY_PATH }
  | { state: "corrupt"; path: typeof WORKSPACE_REGISTRY_PATH; reason: string }

export function readWorkspaceRegistry(projectDirectory: string): WorkspaceRegistryRead {
  const project = canonicalDirectory(projectDirectory)
  try {
    const path = resolveContainedPath(project, ".opencode", "ALG.workspace.json")
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) return { state: "corrupt", path: WORKSPACE_REGISTRY_PATH, reason: "registry_not_regular_file" }
    if (stat.size > WORKSPACE_REGISTRY_MAX_BYTES) return { state: "corrupt", path: WORKSPACE_REGISTRY_PATH, reason: "registry_exceeds_byte_limit" }
    const bytes = readSkillEvolutionDirectBounded(project, path, WORKSPACE_REGISTRY_MAX_BYTES, "workspace registry")
    const registry = WorkspaceRegistrySchema.parse(JSON.parse(bytes.toString("utf8")))
    return { state: "ready", registry, sha256: createHash("sha256").update(bytes).digest("hex") }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing", path: WORKSPACE_REGISTRY_PATH }
    return { state: "corrupt", path: WORKSPACE_REGISTRY_PATH, reason: error instanceof Error ? error.message.slice(0, 240) : "invalid_registry" }
  }
}

function resolveRequirement(requirement: WorkspaceRequirement, snapshot: WorkspaceCallerSnapshot, options: WorkspaceReadinessOptions, now: number): RequirementResult {
  const base = { id: requirement.id, kind: requirement.kind, ref: requirement.ref, mandatory: false }
  if (requirement.kind === "skill") {
    const skill = options.skills.resolve(requirement.ref, snapshot)
    if (!skill) return { ...base, state: "unknown", reason: "skill_binding_missing" }
    if (skill.name !== requirement.ref) return { ...base, state: "conflict", reason: "skill_identity_mismatch" }
    if (skill.state === "approved" && (!skill.closure_hash || !skill.binding_id)) return { ...base, state: "unknown", reason: "skill_binding_evidence_incomplete" }
    const state: Record<SkillApprovalState, ReadinessState> = { approved: "applicable", untrusted: "unknown", missing: "unknown", stale: "stale", conflict: "conflict" }
    if (skill.state === "approved" && skill.operations && !skill.operations.includes(snapshot.operation)) return { ...base, state: "incompatible", reason: "skill_operation_scope_mismatch" }
    if (skill.state === "approved" && skill.environments && !skill.environments.includes(snapshot.environment_id)) return { ...base, state: "incompatible", reason: "skill_environment_scope_mismatch" }
    if (requirement.source_revision && skill.source_revision !== requirement.source_revision) return { ...base, state: "stale", reason: "skill_source_revision_changed" }
    return { ...base, state: state[skill.state], reason: "skill_" + skill.state,
      evidence: { ...(skill.closure_hash ? { closure_hash: skill.closure_hash } : {}), ...(skill.binding_id ? { binding_id: skill.binding_id } : {}),
        ...(skill.source_revision ? { source_revision: skill.source_revision } : {}) } }
  }
  const fact = snapshot.facts[requirement.kind === "document" ? "document:" + requirement.ref : requirement.ref]
  if (!fact) return { ...base, state: "unknown", reason: requirement.kind === "document" ? "document_evidence_missing" : "fact_missing" }
  if (fact.state === "conflict") return { ...base, state: "conflict", reason: "fact_conflict" }
  if (fact.state === "stale") return { ...base, state: "stale", reason: "fact_stale" }
  if (fact.state !== "known") return { ...base, state: "unknown", reason: "fact_untrusted" }
  if (fact.expires_at) {
    const expiresAt = Date.parse(fact.expires_at)
    if (!Number.isFinite(expiresAt) || expiresAt <= now) return { ...base, state: "stale", reason: "fact_expired" }
  }
  if (requirement.kind === "document" && requirement.sha256 && fact.value !== requirement.sha256) return { ...base, state: "stale", reason: "document_digest_changed" }
  if (requirement.kind === "fact" && requirement.equals !== undefined && fact.value !== requirement.equals) return { ...base, state: "incompatible", reason: "fact_value_mismatch" }
  if (requirement.kind === "fact" && requirement.max_age_seconds !== undefined) {
    const observed = Date.parse(fact.observed_at ?? "")
    if (!Number.isFinite(observed) || observed > now) return { ...base, state: "stale", reason: "fact_observed_in_future" }
    if (now - observed > requirement.max_age_seconds * 1000) return { ...base, state: "stale", reason: "fact_too_old" }
  }
  if (requirement.kind === "fact" && requirement.source_revision && fact.source_revision !== requirement.source_revision) return { ...base, state: "stale", reason: "fact_source_revision_changed" }
  const currentRevision = options.sourceRevisions?.[requirement.ref]
  if (currentRevision && fact.source_revision && currentRevision !== fact.source_revision) return { ...base, state: "stale", reason: "source_revision_changed" }
  return { ...base, state: "applicable", reason: requirement.kind === "document" ? "document_digest_match" : "exact_fact_match",
    evidence: { ...(fact.source ? { source: fact.source } : {}), ...(fact.source_revision ? { source_revision: fact.source_revision } : {}) } }
}

export function resolveWorkspaceReadiness(registryRead: WorkspaceRegistryRead, snapshot: WorkspaceCallerSnapshot, options: WorkspaceReadinessOptions): WorkspaceReadiness {
  const mode = options.mode ?? "observe"
  const empty = (status: WorkspaceReadiness["status"], hash = ""): WorkspaceReadiness => ({ status, operation: snapshot.operation,
    mode: mode === "off" ? "off" : "advisory", registry_sha256: hash, requirements: [], missing: [], stale: [], conflicts: [], next_discovery: [] })
  if (mode === "off") return empty("coverage_unknown")
  if (registryRead.state !== "ready") return empty(registryRead.state === "missing" ? "coverage_unknown" : "conflict")
  const operation = registryRead.registry.operations.find((item) => item.id === snapshot.operation)
  if (!operation) return empty("coverage_unknown", registryRead.sha256)
  const entries: RequirementResult[] = []
  if (operation.phase.length && !operation.phase.includes(snapshot.phase)) entries.push({ id: "operation-phase", kind: "scope", ref: "phase", state: "incompatible", mandatory: false, reason: "phase_mismatch" })
  if (operation.roles.length && !operation.roles.includes(snapshot.role)) entries.push({ id: "operation-role", kind: "scope", ref: "role", state: "incompatible", mandatory: false, reason: "role_mismatch" })
  if (operation.environments.length && !operation.environments.includes(snapshot.environment_id)) entries.push({ id: "operation-environment", kind: "scope", ref: "environment", state: "incompatible", mandatory: false, reason: "environment_mismatch" })
  if (operation.resources.length && snapshot.resource_ids.length === 0) entries.push({ id: "operation-resource", kind: "scope", ref: "resource", state: "unknown", mandatory: false, reason: "resource_identity_missing" })
  else if (operation.resources.length && snapshot.resource_ids.some((resource) => !operation.resources.includes(resource))) entries.push({ id: "operation-resource", kind: "scope", ref: "resource", state: "incompatible", mandatory: false, reason: "resource_scope_mismatch" })
  const now = snapshot.now === undefined ? Date.now() : Date.parse(snapshot.now)
  if (!Number.isFinite(now) || now > Date.now()) {
    entries.push({ id: "snapshot-time", kind: "scope", ref: "now", state: "unknown", mandatory: false, reason: "invalid_or_future_snapshot_time" })
    return { status: "needs_context", operation: operation.id, mode: "advisory", registry_sha256: registryRead.sha256,
      requirements: entries, missing: [], stale: [], conflicts: [], next_discovery: ["scope:valid_snapshot_time"] }
  }
  for (const requirement of operation.requirements) {
    const result = resolveRequirement(requirement, snapshot, options, now)
    const mandatory = requirement.intent === "required" && options.trustedRegistryHash === registryRead.sha256 &&
      options.authorizeMandatory?.(operation, requirement, snapshot) === true
    entries.push({ ...result, mandatory })
  }
  const scopeEntries = entries.filter((entry) => entry.kind === "scope")
  const scopeUnresolved = scopeEntries.some((entry) => entry.state !== "applicable")
  const covered = mode === "assist" && !scopeUnresolved && options.trustedRegistryHash === registryRead.sha256 &&
    operation.coverage === "qualified" && options.boundaryQualified?.(operation) === true
  const blockingEntries = entries.filter((entry) => entry.kind === "scope" || entry.mandatory)
  const blockingConflicts = blockingEntries.filter((entry) => entry.state === "conflict").map((entry) => entry.id)
  const conflicts = entries.filter((entry) => entry.state === "conflict").map((entry) => entry.id)
  const stale = entries.filter((entry) => entry.state === "stale").map((entry) => entry.id)
  const missing = entries.filter((entry) => entry.state === "unknown" && entry.mandatory).map((entry) => entry.id)
  const unresolvedRequired = entries.filter((entry) => entry.mandatory && entry.state !== "applicable")
  const missingRequiredSkill = unresolvedRequired.some((entry) => entry.kind === "skill" && entry.state === "unknown")
  const status: WorkspaceReadiness["status"] = blockingConflicts.length ? "conflict"
    : scopeUnresolved ? "needs_context"
    : unresolvedRequired.length ? (missingRequiredSkill ? "needs_skill" : "needs_context")
    : !covered ? "coverage_unknown" : "ready"
  const enforced = covered && (status === "ready" || status === "needs_skill" || status === "needs_context" || status === "conflict")
  return { status, operation: operation.id, mode: enforced ? "enforced" : "advisory", registry_sha256: registryRead.sha256,
    requirements: entries, missing, stale, conflicts,
    next_discovery: entries.filter((entry) => entry.state === "unknown" || entry.state === "stale" || entry.state === "conflict").map((entry) => entry.kind + ":" + entry.ref).slice(0, 8) }
}

/** Small context-budget projection; full skill content remains with its current owner. */
export function projectWorkspaceContext(readiness: WorkspaceReadiness, maximumRequirements = 16): WorkspaceContextProjection {
  if (!Number.isInteger(maximumRequirements) || maximumRequirements < 1 || maximumRequirements > 32) throw new Error("invalid workspace context bound")
  return { status: readiness.status, operation: readiness.operation, mode: readiness.mode, registry_sha256: readiness.registry_sha256,
    requirements: readiness.requirements.slice(0, maximumRequirements).map(({ id, kind, ref, state, mandatory, reason }) => ({ id, kind, ref, state, mandatory, reason })),
    missing: readiness.missing.slice(0, 8), stale: readiness.stale.slice(0, 8), conflicts: readiness.conflicts.slice(0, 8), next_discovery: readiness.next_discovery.slice(0, 8) }
}

/** Starter references only; the workspace maintainer must bind them to reviewed local sources and facts. */
export const STARTER_WORKSPACE_REGISTRY: WorkspaceRegistry = WorkspaceRegistrySchema.parse({ schema_version: 1, operations: [
  { id: "repo.publish", phase: ["publish"], roles: ["maintainer"], effects: ["read", "write"], requirements: [
    { id: "git-publish-procedure", kind: "skill", ref: "git-publish", intent: "advisory" },
    { id: "repository-identity", kind: "fact", ref: "repository.identity", intent: "required" }] },
  { id: "repo.test", phase: ["verify"], effects: ["read"], requirements: [
    { id: "test-procedure", kind: "skill", ref: "repo-test", intent: "advisory" },
    { id: "test-command", kind: "fact", ref: "test.command", intent: "required" }] },
  { id: "data.migration.prepare", phase: ["prepare"], effects: ["read"], requirements: [
    { id: "migration-procedure", kind: "skill", ref: "migration-preflight", intent: "advisory" },
    { id: "migration-source-revision", kind: "fact", ref: "migration.source_revision", intent: "required" }] },
  { id: "data.investigate.read", phase: ["investigate"], effects: ["discover", "read", "submit"], requirements: [
    { id: "investigation-procedure", kind: "skill", ref: "data-investigation", intent: "advisory" },
    { id: "investigation-resource", kind: "fact", ref: "investigation.resource", intent: "required" }] },
] })

import { createHash } from "node:crypto"
import { resolveContainedPath } from "./paths.ts"
import { readSkillEvolutionDirectBounded } from "./skill-evolution-store.ts"
import { hashObject } from "./session-memory/store.ts"
import { verifyEnvironment } from "./session-memory/environment.ts"
import type { SessionMemoryRuntime } from "./session-memory/runtime.ts"
import { WorkspaceOptionsSchema } from "./operational-options.ts"
import { readWorkspaceRegistry, resolveWorkspaceReadiness, projectWorkspaceContext,
  type WorkspaceCallerSnapshot, type WorkspaceFactEvidence, type WorkspaceReadiness, type SkillApprovalEvidence,
  type WorkspaceOperation } from "./workspace/index.ts"

export interface WorkspaceServiceQualification {
  operation: string
  boundary: string
  verifier_id: string
  evidence_sha256: string
  verified_at: string
  expires_at: string
}
export type WorkspaceServiceQualificationResolver = (operation: WorkspaceOperation) => WorkspaceServiceQualification | undefined
export const INVESTIGATION_WORK_INPUT_VALIDATOR_ID = "investigation-work-v1"
export const INVESTIGATION_PROJECT_RESOURCE_RESOLVER_ID = "investigation-project-v1"
const INVESTIGATION_QUALIFIED_EFFECTS = new Set(["discover", "read", "submit"])

/** One matcher serves initial orientation and the covered execution boundary. */
export class WorkspaceRuntime {
  readonly options: ReturnType<typeof WorkspaceOptionsSchema.parse>
  constructor(readonly memory: SessionMemoryRuntime, options: unknown = {},
    private readonly serviceQualification: WorkspaceServiceQualificationResolver = () => undefined) {
    this.options = WorkspaceOptionsSchema.parse(options)
  }
  get enabled() { return this.options.mode !== "off" }

  evaluate(owner: string, operation: string, phase = "execute", covered = false): WorkspaceReadiness {
    const registry = readWorkspaceRegistry(this.memory.store.project)
    const current = this.memory.current(owner)
    let environment = "unknown"
    try { environment = verifyEnvironment(this.memory.store, current)?.payload.name ?? "unknown" } catch { /* unresolved */ }
    const facts: Record<string, WorkspaceFactEvidence> = {
      platform: { state: "known", value: process.platform, source: "host-platform", observed_at: new Date().toISOString() },
    }
    if (registry.state === "ready") for (const requirement of registry.registry.operations.find((item) => item.id === operation)?.requirements ?? []) {
      if (requirement.kind !== "document") continue
      try {
        const bytes = readSkillEvolutionDirectBounded(this.memory.store.project,
          resolveContainedPath(this.memory.store.project, requirement.ref), 65_536, "workspace document")
        const hash = createHash("sha256").update(bytes).digest("hex")
        facts["document:" + requirement.ref] = { state: "known", value: hash, source_revision: hash,
          source: requirement.ref, observed_at: new Date().toISOString() }
      } catch { facts["document:" + requirement.ref] = { state: "missing" } }
    }
    const snapshot: WorkspaceCallerSnapshot = { caller_id: owner, task_epoch: current.task_epoch, phase, operation,
      resource_ids: [this.memory.store.projectId], environment_id: environment,
      role: current.delegation ? current.delegation.role : "orchestrator", facts }
    return resolveWorkspaceReadiness(registry, snapshot, {
      mode: this.options.mode, trustedRegistryHash: this.options.trustedRegistryHash,
      authorizeMandatory: () => this.options.mandatoryOperations.includes(operation),
      boundaryQualified: (entry) => covered && operation === "data.investigate.read" && this.isServiceQualified(entry),
      skills: { resolve: (name) => this.skill(owner, name) },
    })
  }

  private isServiceQualified(operation: WorkspaceOperation): boolean {
    if (!operation.boundary || !operation.verifier_ids.length ||
      operation.input_validator !== INVESTIGATION_WORK_INPUT_VALIDATOR_ID ||
      operation.resource_resolver !== INVESTIGATION_PROJECT_RESOURCE_RESOLVER_ID ||
      operation.effects.length !== INVESTIGATION_QUALIFIED_EFFECTS.size ||
      operation.effects.some((effect) => !INVESTIGATION_QUALIFIED_EFFECTS.has(effect))) return false
    const proof = this.serviceQualification(operation)
    if (!proof || proof.operation !== operation.id || proof.boundary !== operation.boundary ||
      !operation.verifier_ids.includes(proof.verifier_id) || !/^[a-f0-9]{64}$/.test(proof.evidence_sha256)) return false
    const verifiedAt = Date.parse(proof.verified_at), expiresAt = Date.parse(proof.expires_at), now = Date.now()
    return Number.isFinite(verifiedAt) && Number.isFinite(expiresAt) && verifiedAt <= now && expiresAt > now && expiresAt > verifiedAt
  }

  private skill(owner: string, name: string): SkillApprovalEvidence | undefined {
    const bindings = this.memory.current(owner).skills.filter((binding) => binding.name === name)
    if (!bindings.length) return undefined
    if (bindings.length !== 1) return { state: "conflict", name }
    try {
      const binding = bindings[0]!, node = this.memory.store.node(binding.id, owner)
      if (node.kind !== "skill" || !node.payload.approval) return { state: "untrusted", name }
      this.memory.index.verifiedBodies(node)
      const revision = this.memory.index.preview(binding.key)
      return { state: "approved", name, closure_hash: revision.closure, source_revision: revision.closure,
        binding_id: binding.id, ...(revision.operations.length ? { operations: revision.operations } : {}),
        ...(revision.environments.length ? { environments: revision.environments } : {}) }
    } catch { return { state: "stale", name } }
  }

  /** Load only explicitly trusted workspace requirements under existing delegated skill approval. */
  select(owner: string, operation: string, phase = "execute"): boolean {
    if (this.options.mode !== "assist" || this.memory.options.mode !== "assist" || this.memory.current(owner).delegation ||
      !this.options.mandatoryOperations.includes(operation)) return false
    const registry = readWorkspaceRegistry(this.memory.store.project)
    if (registry.state !== "ready" || registry.sha256 !== this.options.trustedRegistryHash) return false
    const entry = registry.registry.operations.find((item) => item.id === operation)
    if (!entry) return false
    // Check caller and resource scope before creating even an approval receipt.
    // A requirement declaration cannot make a mismatched operation applicable.
    const readiness = this.evaluate(owner, operation, phase, false)
    if (readiness.registry_sha256 !== registry.sha256 ||
      readiness.requirements.some((item) => item.kind === "scope" && item.state !== "applicable")) return false
    const incompatibleSkills = new Set(readiness.requirements.filter((item) => item.kind === "skill" && item.state === "incompatible").map((item) => item.id))
    const current = this.memory.current(owner)
    let currentEnvironment = "unknown"
    try { currentEnvironment = verifyEnvironment(this.memory.store, current)?.payload.name ?? "unknown" } catch { /* unresolved */ }
    let changed = false
    for (const requirement of entry.requirements) {
      if (requirement.kind !== "skill" || requirement.intent !== "required" || incompatibleSkills.has(requirement.id)) continue
      if (this.skill(owner, requirement.ref)?.state === "approved") continue
      const entries = this.memory.index.named(requirement.ref)
      if (!this.memory.index.complete || entries.length !== 1) continue
      try {
        const preview = this.memory.index.preview(entries[0]!.key)
        if (preview.operations.length && !preview.operations.includes(operation)) continue
        if (preview.environments.length && (!currentEnvironment || currentEnvironment === "unknown" || !preview.environments.includes(currentEnvironment))) continue
        if (requirement.source_revision && requirement.source_revision !== preview.closure) continue
        const id = this.memory.approveSkill(owner, entries[0]!.key)
        this.memory.loadSkill(owner, id)
        changed = true
      } catch { /* Keep the gap visible; never broaden policy or repin source drift. */ }
    }
    return changed
  }

  guard(owner: string, operation: string, phase = "execute") {
    if (!this.enabled) return
    if (this.select(owner, operation, phase)) throw new Error("needs_context: required procedures loaded; take a fresh planning step before dispatch")
    const result = this.evaluate(owner, operation, phase, true)
    if (result.mode === "enforced" && result.status !== "ready") throw new Error(`workspace ${result.status}: resolve requirements before this operation`)
    if (this.options.mode === "assist" && this.options.mandatoryOperations.includes(operation) && result.mode !== "enforced") {
      throw new Error("workspace coverage_unknown: trusted registry or qualified operation boundary unavailable")
    }
  }

  status(owner: string, operation?: string) {
    if (!this.enabled) return { mode: "off" }
    const registry = readWorkspaceRegistry(this.memory.store.project)
    const selected = operation ?? this.memory.current(owner).workspace_operation
    return { mode: this.options.mode, registry: registry.state, registry_sha256: registry.state === "ready" ? registry.sha256 : null,
      operation: selected ?? null, operations: registry.state === "ready" ? registry.registry.operations.map((entry) => entry.id) : [],
      readiness: selected ? projectWorkspaceContext(this.evaluate(owner, selected)) : null,
      authority: "configured-application-policy", universal_tool_interception: false }
  }
  render(owner: string, maxBytes = 4096) {
    if (this.options.mode !== "assist" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) return ""
    const prefix = "ALG workspace requirements (references, not permission grants):\n"
    const fits = (value: unknown) => {
      const rendered = prefix + JSON.stringify(value)
      return Buffer.byteLength(rendered) <= maxBytes ? rendered : null
    }
    const value = this.status(owner)
    const complete = fits(value)
    if (complete !== null) return complete
    if (value && typeof value === "object" && "readiness" in value) {
      const status = value as ReturnType<WorkspaceRuntime["status"]> & { readiness?: any; operations?: string[]; operation?: string | null }
      const readiness = status.readiness
      const required = readiness && typeof readiness === "object" && Array.isArray(readiness.requirements)
        ? readiness.requirements.filter((item: any) => item.mandatory === true || item.kind === "scope") : []
      const compact = { mode: status.mode, registry: status.registry, registry_sha256: status.registry_sha256,
        operation: status.operation, operations: status.operation ? [status.operation] : [],
        readiness: readiness ? { status: readiness.status, operation: readiness.operation, mode: readiness.mode,
          requirements: required, missing: readiness.missing, stale: readiness.stale, conflicts: readiness.conflicts } : null,
        authority: status.authority, universal_tool_interception: status.universal_tool_interception }
      const reduced = fits(compact)
      if (reduced !== null) return reduced
      const minimal = "ALG workspace " + (status.operation ?? "status") + ": " + (readiness?.status ?? status.registry)
      if (Buffer.byteLength(minimal) <= maxBytes) return minimal
    }
    return ""
  }
}

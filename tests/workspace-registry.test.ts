import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"
import {
  WORKSPACE_REGISTRY_MAX_BYTES, WorkspaceRegistrySchema, projectWorkspaceContext, readWorkspaceRegistry,
  resolveWorkspaceReadiness, type SkillApprovalEvidence, type WorkspaceCallerSnapshot, type WorkspaceRegistry,
} from "../src/workspace/index.ts"

const roots: string[] = []
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
function project() {
  const root = mkdtempSync(join(tmpdir(), "alg-workspace-"))
  roots.push(root)
  mkdirSync(join(root, ".opencode"))
  return root
}
function registry(requirement: Record<string, unknown> = { id: "test-skill", kind: "skill", ref: "repo-test", intent: "required", source_revision: hash("source-v1") }): WorkspaceRegistry {
  return WorkspaceRegistrySchema.parse({ schema_version: 1, operations: [{ id: "repo.test", phase: ["verify"], coverage: "qualified",
    boundary: "alg_plan", input_validator: "plan-input", resource_resolver: "project-worktree", requirements: [requirement] }] })
}
function save(root: string, value: unknown) {
  writeFileSync(join(root, ".opencode", "ALG.workspace.json"), JSON.stringify(value))
}
function snapshot(overrides: Partial<WorkspaceCallerSnapshot> = {}): WorkspaceCallerSnapshot {
  return { caller_id: "caller-a", task_epoch: 3, phase: "verify", operation: "repo.test", resource_ids: ["repo-a"],
    environment_id: "local", role: "maintainer", facts: {}, now: "2026-11-09T12:00:00.000Z", ...overrides }
}
function skillResolver(evidence: SkillApprovalEvidence | undefined) {
  return { resolve: (_ref: string) => evidence }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("workspace registry loading", () => {
  test("missing registry is an explicit coverage gap", () => {
    const result = readWorkspaceRegistry(project())
    expect(result).toEqual({ state: "missing", path: ".opencode/ALG.workspace.json" })
  })

  test("corrupt JSON and invalid schema fail closed", () => {
    const root = project()
    save(root, "{")
    expect(readWorkspaceRegistry(root).state).toBe("corrupt")
    save(root, { schema_version: 2, operations: [] })
    expect(readWorkspaceRegistry(root).state).toBe("corrupt")
  })

  test("bounded bytes, oversized registry and duplicate identifiers are rejected", () => {
    const root = project()
    writeFileSync(join(root, ".opencode", "ALG.workspace.json"), " ".repeat(WORKSPACE_REGISTRY_MAX_BYTES + 1))
    expect(readWorkspaceRegistry(root)).toMatchObject({ state: "corrupt", reason: "registry_exceeds_byte_limit" })
    expect(WorkspaceRegistrySchema.safeParse({ schema_version: 1, operations: [{ id: "repo.test" }, { id: "repo.test" }] }).success).toBe(false)
  })

  test("registry symlink and missing or redirected .opencode path never load external content", () => {
    const root = project()
    const outside = join(tmpdir(), "alg-workspace-outside.json")
    writeFileSync(outside, JSON.stringify({ schema_version: 1, operations: [] }))
    try {
      try {
        symlinkSync(outside, join(root, ".opencode", "ALG.workspace.json"))
        expect(readWorkspaceRegistry(root).state).toBe("corrupt")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error
      }
    } finally {
      rmSync(outside, { force: true })
    }
    expect(WorkspaceRegistrySchema.safeParse({ schema_version: 1, operations: [{ id: "repo.test", requirements: [
      { id: "outside-doc", kind: "document", ref: "../outside.md", intent: "required" },
    ] }] }).success).toBe(false)
  })
})

describe("workspace applicability and authority", () => {
  test("an exact current approved binding restores applicability; source or closure drift does not", () => {
    const root = project()
    save(root, registry())
    const loaded = readWorkspaceRegistry(root)
    expect(loaded.state).toBe("ready")
    if (loaded.state !== "ready") return
    const current = { state: "approved", name: "repo-test", closure_hash: hash("current closure"), source_revision: hash("source-v1"),
      operations: ["repo.test"], environments: ["local"], binding_id: "binding-7" } satisfies SkillApprovalEvidence
    const common = { mode: "observe" as const, skills: skillResolver(current) }
    const restored = resolveWorkspaceReadiness(loaded, snapshot(), common)
    expect(restored.requirements[0]).toMatchObject({ state: "applicable", reason: "skill_approved", evidence: { closure_hash: current.closure_hash, binding_id: "binding-7" } })

    const wrongBinding = resolveWorkspaceReadiness(loaded, snapshot(), { ...common,
      skills: skillResolver({ ...current, name: "different-skill" }) })
    expect(wrongBinding.requirements[0]).toMatchObject({ state: "conflict", reason: "skill_identity_mismatch" })
    const incompleteBinding = resolveWorkspaceReadiness(loaded, snapshot(), { ...common,
      skills: skillResolver({ ...current, binding_id: undefined }) })
    expect(incompleteBinding.requirements[0]).toMatchObject({ state: "unknown", reason: "skill_binding_evidence_incomplete" })

    const changedManifest = resolveWorkspaceReadiness(loaded, snapshot(), { ...common,
      skills: skillResolver({ ...current, source_revision: hash("source-v2") }) })
    expect(changedManifest.requirements[0]).toMatchObject({ state: "stale", reason: "skill_source_revision_changed" })
    const changedClosure = resolveWorkspaceReadiness(loaded, snapshot(), { ...common,
      skills: skillResolver({ ...current, state: "stale" }) })
    expect(changedClosure.requirements[0]).toMatchObject({ state: "stale", reason: "skill_stale" })
  })

  test("registry required label cannot become mandatory without separately authorized trusted policy", () => {
    const root = project()
    save(root, registry())
    const loaded = readWorkspaceRegistry(root)
    if (loaded.state !== "ready") throw new Error("fixture registry did not load")
    const options = { mode: "assist" as const, trustedRegistryHash: loaded.sha256, skills: skillResolver(undefined),
      boundaryQualified: () => true }
    const untrusted = resolveWorkspaceReadiness(loaded, snapshot(), options)
    expect(untrusted.mode).toBe("enforced")
    expect(untrusted.requirements[0]).toMatchObject({ state: "unknown", mandatory: false })
    const authorized = resolveWorkspaceReadiness(loaded, snapshot(), { ...options, authorizeMandatory: () => true })
    expect(authorized).toMatchObject({ status: "needs_skill", mode: "enforced", missing: ["test-skill"] })
    const wrongHash = resolveWorkspaceReadiness(loaded, snapshot(), { ...options, trustedRegistryHash: hash("other"), authorizeMandatory: () => true })
    expect(wrongHash.mode).toBe("advisory")
    expect(wrongHash.requirements[0]?.mandatory).toBe(false)
  })

  test("required missing facts need context rather than a skill", () => {
    const root = project()
    save(root, registry({ id: "required-fact", kind: "fact", ref: "repository.identity", intent: "required" }))
    const loaded = readWorkspaceRegistry(root)
    if (loaded.state !== "ready") throw new Error("fixture registry did not load")
    const result = resolveWorkspaceReadiness(loaded, snapshot(), { mode: "assist", trustedRegistryHash: loaded.sha256,
      skills: skillResolver(undefined), authorizeMandatory: () => true, boundaryQualified: () => true })
    expect(result).toMatchObject({ status: "needs_context", missing: ["required-fact"] })
  })

  test.each([
    ["phase", { phase: "publish" }, "operation-phase"],
    ["role", { role: "guest" }, "operation-role"],
    ["environment", { environment_id: "remote" }, "operation-environment"],
    ["resource", { resource_ids: ["other-repo"] }, "operation-resource"],
    ["missing resource identity", { resource_ids: [] }, "operation-resource"],
  ] as Array<[string, Partial<WorkspaceCallerSnapshot>, string]>)("operation %s mismatch cannot be ready or enforced", (_label, overrides, entryId) => {
    const root = project()
    const data = WorkspaceRegistrySchema.parse({ schema_version: 1, operations: [{ id: "repo.test", phase: ["verify"], roles: ["maintainer"],
      environments: ["local"], resources: ["repo-a"], coverage: "qualified", boundary: "alg_plan",
      input_validator: "plan-input", resource_resolver: "project-worktree", requirements: [] }] })
    save(root, data)
    const loaded = readWorkspaceRegistry(root)
    if (loaded.state !== "ready") throw new Error("fixture registry did not load")
    const result = resolveWorkspaceReadiness(loaded, snapshot(overrides), { mode: "assist", trustedRegistryHash: loaded.sha256,
      skills: skillResolver(undefined), boundaryQualified: () => true })
    expect(result.status).toBe("needs_context")
    expect(result.mode).toBe("advisory")
    expect(result.requirements.some((entry) => entry.id === entryId && entry.state !== "applicable")).toBe(true)
  })

  test.each(["not-a-date", new Date(Date.now() + 60_000).toISOString()])("invalid or future snapshot time %s blocks evaluation", (now) => {
    const root = project()
    save(root, registry())
    const loaded = readWorkspaceRegistry(root)
    if (loaded.state !== "ready") throw new Error("fixture registry did not load")
    const result = resolveWorkspaceReadiness(loaded, snapshot({ now }), { mode: "assist", trustedRegistryHash: loaded.sha256,
      skills: { resolve: () => { throw new Error("invalid time must stop before skill resolution") } }, boundaryQualified: () => true })
    expect(result).toMatchObject({ status: "needs_context", mode: "advisory", next_discovery: ["scope:valid_snapshot_time"] })
  })

  test("optional incompatibility and unknown evidence remain advisory without blocking covered work", () => {
    const root = project()
    const data = WorkspaceRegistrySchema.parse({ schema_version: 1, operations: [{ id: "repo.test", coverage: "qualified",
      boundary: "alg_plan", input_validator: "plan-input", resource_resolver: "project-worktree", requirements: [
        { id: "optional-mismatch", kind: "fact", ref: "test.command", equals: "bun test", intent: "advisory" },
        { id: "optional-unknown", kind: "fact", ref: "repo.policy", intent: "advisory" },
      ] }] })
    save(root, data)
    const loaded = readWorkspaceRegistry(root)
    if (loaded.state !== "ready") throw new Error("fixture registry did not load")
    const result = resolveWorkspaceReadiness(loaded, snapshot({ facts: { "test.command": { state: "known", value: "npm test" } } }), {
      mode: "assist", trustedRegistryHash: loaded.sha256, skills: skillResolver(undefined), boundaryQualified: () => true,
    })
    expect(result.status).toBe("ready")
    expect(result.mode).toBe("enforced")
    expect(result.requirements.map(({ state }) => state)).toEqual(["incompatible", "unknown"])
    expect(result.next_discovery).toContain("fact:repo.policy")
  })

  test("unknown, stale, conflicting and incompatible facts remain distinct", () => {
    const root = project()
    const data = WorkspaceRegistrySchema.parse({ schema_version: 1, operations: [{ id: "repo.test", requirements: [
      { id: "unknown", kind: "fact", ref: "unknown.fact", intent: "advisory" },
      { id: "stale", kind: "fact", ref: "old.fact", intent: "advisory" },
      { id: "conflict", kind: "fact", ref: "conflict.fact", intent: "advisory" },
      { id: "mismatch", kind: "fact", ref: "wrong.fact", equals: "expected", intent: "advisory" },
    ] }] })
    save(root, data)
    const loaded = readWorkspaceRegistry(root)
    if (loaded.state !== "ready") throw new Error("fixture registry did not load")
    const resolved = resolveWorkspaceReadiness(loaded, snapshot({ facts: {
      "old.fact": { state: "known", value: "x", expires_at: "2026-11-09T11:00:00.000Z" },
      "conflict.fact": { state: "conflict" },
      "wrong.fact": { state: "known", value: "different" },
    } }), { skills: skillResolver(undefined) })
    expect(resolved.requirements.map(({ state }) => state)).toEqual(["unknown", "stale", "conflict", "incompatible"])
    expect(resolved.status).toBe("coverage_unknown")
    expect(resolved.conflicts).toEqual(["conflict"])
  })

  test("scope mismatch, source revision change and compact projection are explicit and bounded", () => {
    const root = project()
    const data = WorkspaceRegistrySchema.parse({ schema_version: 1, operations: [{ id: "repo.test", roles: ["maintainer"], requirements: [
      { id: "repo", kind: "fact", ref: "repo.identity", equals: "repo-v1", intent: "advisory", source_revision: hash("revision-1") },
    ] }] })
    save(root, data)
    const loaded = readWorkspaceRegistry(root)
    if (loaded.state !== "ready") throw new Error("fixture registry did not load")
    const resolved = resolveWorkspaceReadiness(loaded, snapshot({ role: "guest", facts: {
      "repo.identity": { state: "known", value: "repo-v1", source_revision: hash("revision-1") },
    } }), { skills: skillResolver(undefined), sourceRevisions: { "repo.identity": hash("revision-2") } })
    expect(resolved.requirements.map(({ reason }) => reason)).toEqual(["role_mismatch", "source_revision_changed"])
    expect(projectWorkspaceContext(resolved, 1).requirements).toHaveLength(1)
    expect(() => projectWorkspaceContext(resolved, 0)).toThrow("invalid workspace context bound")
  })

  test("off mode does not evaluate skills or registry applicability", () => {
    const root = project()
    save(root, registry())
    const loaded = readWorkspaceRegistry(root)
    if (loaded.state !== "ready") throw new Error("fixture registry did not load")
    const result = resolveWorkspaceReadiness(loaded, snapshot(), { mode: "off", skills: { resolve: () => { throw new Error("must not resolve") } } })
    expect(result).toMatchObject({ mode: "off", status: "coverage_unknown", requirements: [] })
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { INVESTIGATION_PROJECT_RESOURCE_RESOLVER_ID, INVESTIGATION_WORK_INPUT_VALIDATOR_ID, WorkspaceRuntime } from "../src/workspace-runtime.ts"
import { tempProject } from "./helpers.ts"

const projects: string[] = []
afterEach(() => { for (const path of projects.splice(0)) rmSync(path, { recursive: true, force: true }) })
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex")

function fixture(options: { skillOperations?: string[]; skillEnvironments?: string[]; operation?: Record<string, unknown> } = {}) {
  const project = tempProject("alg-workspace-runtime-")
  projects.push(project)
  const skillDirectory = join(project, ".opencode", "skills", "repo-test")
  mkdirSync(skillDirectory, { recursive: true })
  writeFileSync(join(skillDirectory, "SKILL.md"), "---\nname: repo-test\ndescription: Reviewed repository test procedure\n---\nRun the reviewed test gate.\n")
  writeFileSync(join(skillDirectory, "ALG.json"), JSON.stringify({ schema_version: 1,
    ...(options.skillOperations ? { operations: options.skillOperations } : {}),
    ...(options.skillEnvironments ? { environments: options.skillEnvironments } : {}) }))

  const discovery = new SessionMemoryRuntime(project, { mode: "assist" }, [".opencode/skills"], [])
  const key = discovery.index.search("repo-test").skills[0]!.key
  const approvalRule = { id: "team-procedures", revision: "1", source: discovery.index.source(key),
    skills: ["repo-test"], environments: ["*"], operations: ["*"] }
  const policy = { schema_version: 2, project: discovery.store.projectId, rules: [approvalRule] }
  const memory = new SessionMemoryRuntime(project, { mode: "assist", approvalPolicy: policy }, [".opencode/skills"], [])
  mkdirSync(join(project, ".opencode"), { recursive: true })
  const registry = { schema_version: 1, operations: [{
    id: "repo.test", phase: ["execute"], roles: ["orchestrator"], resources: [memory.store.projectId],
    coverage: "qualified", boundary: "alg_investigation", input_validator: "test-request",
    resource_resolver: "project-worktree",
    requirements: [
      { id: "test-procedure", kind: "skill", ref: "repo-test", intent: "required" },
      { id: "test-fixture-fact", kind: "fact", ref: "test.fixture", intent: "required" },
    ],
    ...options.operation,
  }] }
  const registryText = JSON.stringify(registry)
  writeFileSync(join(project, ".opencode", "ALG.workspace.json"), registryText)
  const runtime = new WorkspaceRuntime(memory, { mode: "assist", trustedRegistryHash: sha256(registryText), mandatoryOperations: ["repo.test"] })
  return { project, memory, runtime, approvalRule, policy, registryText }
}

function spyOnSkillMutations(memory: SessionMemoryRuntime) {
  let approvals = 0, loads = 0
  const approve = memory.approveSkill.bind(memory), load = memory.loadSkill.bind(memory)
  memory.approveSkill = ((...args: Parameters<typeof memory.approveSkill>) => { approvals++; return approve(...args) }) as typeof memory.approveSkill
  memory.loadSkill = ((...args: Parameters<typeof memory.loadSkill>) => { loads++; return load(...args) }) as typeof memory.loadSkill
  return { counts: () => ({ approvals, loads }) }
}

describe("workspace runtime selection", () => {
  test.each([
    ["phase", { phase: ["publish"] }, "execute"],
    ["role", { roles: ["worker"] }, "execute"],
    ["resource", { resources: ["another-project"] }, "execute"],
    ["environment", { environments: ["reviewed-dev"] }, "execute"],
  ] as Array<[string, Record<string, unknown>, string]>)("does not approve or load for an incompatible operation %s", (_label, operation, phase) => {
    const f = fixture({ operation }), spy = spyOnSkillMutations(f.memory)
    expect(f.runtime.select("owner", "repo.test", phase)).toBe(false)
    expect(spy.counts()).toEqual({ approvals: 0, loads: 0 })
    expect(f.memory.current("owner").skills).toEqual([])
    const readiness = f.runtime.evaluate("owner", "repo.test", phase)
    expect(readiness.requirements.some((entry) => entry.kind === "scope" && entry.state !== "applicable")).toBe(true)
  })

  test("does not approve an otherwise eligible skill whose own ALG.json scope is incompatible", () => {
    const f = fixture({ skillOperations: ["other.operation"] }), spy = spyOnSkillMutations(f.memory)
    expect(f.runtime.select("owner", "repo.test")).toBe(false)
    expect(spy.counts()).toEqual({ approvals: 0, loads: 0 })
    expect(f.memory.current("owner").skills).toEqual([])
  })

  test("does not approve a skill when its ALG.json environment has not been selected", () => {
    const f = fixture({ skillEnvironments: ["reviewed-dev"] }), spy = spyOnSkillMutations(f.memory)
    expect(f.runtime.select("owner", "repo.test")).toBe(false)
    expect(spy.counts()).toEqual({ approvals: 0, loads: 0 })
    expect(f.memory.current("owner").skills).toEqual([])
  })

  test("diagnostics retain requirement kind and distinguish missing skill from missing fact", () => {
    const f = fixture()
    const readiness = f.runtime.evaluate("owner", "repo.test", "execute")
    expect(readiness.requirements).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "test-procedure", kind: "skill", ref: "repo-test", state: "unknown", reason: "skill_binding_missing", mandatory: true }),
      expect.objectContaining({ id: "test-fixture-fact", kind: "fact", ref: "test.fixture", state: "unknown", reason: "fact_missing", mandatory: true }),
    ]))
    expect(readiness.status).toBe("needs_skill")
  })

  test("resolves a required test command from the local package manifest as evidence", () => {
    const packageText = JSON.stringify({ scripts: { test: "bun test --timeout 60000" } })
    const f = fixture({ operation: { requirements: [
      { id: "test-command", kind: "fact", ref: "test.command", intent: "required", equals: "bun test --timeout 60000" },
    ] } })
    writeFileSync(join(f.project, "package.json"), packageText)
    const readiness = f.runtime.evaluate("owner", "repo.test", "execute")
    expect(readiness.requirements).toEqual([expect.objectContaining({ id: "test-command", state: "applicable", reason: "exact_fact_match", mandatory: true })])
  })

  test("selection delegates approval revalidation to current policy and never silently repins", () => {
    const f = fixture()
    expect(f.runtime.select("owner", "repo.test")).toBe(true)
    const original = f.memory.current("owner").skills[0]!
    expect(original.name).toBe("repo-test")

    const changedPolicy = { ...f.policy, rules: [{ ...f.approvalRule, revision: "2" }] }
    const restarted = new SessionMemoryRuntime(f.project, { mode: "assist", approvalPolicy: changedPolicy }, [".opencode/skills"], [])
    const runtime = new WorkspaceRuntime(restarted, {
      mode: "assist", trustedRegistryHash: sha256(f.registryText), mandatoryOperations: ["repo.test"],
    })
    expect(runtime.evaluate("owner", "repo.test").requirements[0]).toMatchObject({ state: "stale", reason: "skill_stale" })
    expect(runtime.select("owner", "repo.test")).toBe(false)
    expect(restarted.current("owner").skills).toEqual([original])
    expect(() => restarted.loadSkill("owner", original.id)).toThrow(/stale|approval/)
  })

  test("selection requires an operator-authorized mandatory operation", () => {
    const f = fixture()
    const advisory = new WorkspaceRuntime(f.memory, { mode: "assist", trustedRegistryHash: sha256(f.registryText) })
    const spy = spyOnSkillMutations(f.memory)
    expect(advisory.select("owner", "repo.test")).toBe(false)
    expect(spy.counts()).toEqual({ approvals: 0, loads: 0 })
  })

  test("render never exceeds its byte allowance, including zero and tiny limits", () => {
    const f = fixture()
    f.memory.update("owner", (current) => ({ ...current, workspace_operation: "repo.test" }))
    for (const limit of [0, 1, 10, 32, 96, 512, 4096]) {
      const rendered = f.runtime.render("owner", limit)
      expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(limit)
      if (limit === 0 || limit === 1) expect(rendered).toBe("")
    }
  })

  test("render drops optional requirement projection before required readiness", () => {
    const optional = Array.from({ length: 32 }, (_, index) => ({
      id: ("optional-requirement-" + index + "-").padEnd(56, "x"),
      kind: "fact", ref: ("optional.fact." + index + ".").padEnd(56, "y"), intent: "advisory",
    }))
    const f = fixture({ operation: { requirements: [
      { id: "required-skill", kind: "skill", ref: "repo-test", intent: "required" },
      ...optional,
    ] } })
    f.memory.update("owner", (current) => ({ ...current, workspace_operation: "repo.test" }))
    const rendered = f.runtime.render("owner", 1800)
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(1800)
    expect(rendered).toContain("required-skill")
    expect(rendered).not.toContain("optional-requirement")
  })

  test("ordinary readiness stays advisory until an explicit service qualification is supplied", () => {
    const f = fixture({ operation: { id: "data.investigate.read", requirements: [], verifier_ids: ["service-probe-v1"],
      input_validator: INVESTIGATION_WORK_INPUT_VALIDATOR_ID,
      resource_resolver: INVESTIGATION_PROJECT_RESOURCE_RESOLVER_ID, effects: ["discover", "read", "submit"] } })
    const options = { mode: "assist", trustedRegistryHash: sha256(f.registryText), mandatoryOperations: ["data.investigate.read"] }
    const withoutProof = new WorkspaceRuntime(f.memory, options)
    expect(withoutProof.evaluate("owner", "data.investigate.read", "execute", false).mode).toBe("advisory")
    expect(withoutProof.evaluate("owner", "data.investigate.read", "execute", true).mode).toBe("advisory")

    const proof = { operation: "data.investigate.read", boundary: "alg_investigation", verifier_id: "service-probe-v1",
      evidence_sha256: sha256("actual service qualification receipt"),
      verified_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() }
    const qualified = new WorkspaceRuntime(f.memory, options, () => proof)
    expect(qualified.evaluate("owner", "data.investigate.read", "execute", false).mode).toBe("advisory")
    expect(qualified.evaluate("owner", "data.investigate.read", "execute", true)).toMatchObject({ status: "ready", mode: "enforced" })
    expect(() => qualified.guard("owner", "data.investigate.read", "execute")).not.toThrow()
    expect(() => withoutProof.guard("owner", "data.investigate.read", "execute")).toThrow(/coverage_unknown/)
  })

  test.each([
    ["input validator", { input_validator: "arbitrary-validator" }],
    ["resource resolver", { resource_resolver: "arbitrary-resolver" }],
    ["write effect", { effects: ["discover", "read", "submit", "write"] }],
    ["missing required effect", { effects: ["discover", "submit"] }],
  ] as Array<[string, Record<string, unknown>]>)("does not qualify an investigation route with an unsupported %s", (_label, changes) => {
    const f = fixture({ operation: { id: "data.investigate.read", requirements: [], verifier_ids: ["service-probe-v1"],
      input_validator: INVESTIGATION_WORK_INPUT_VALIDATOR_ID,
      resource_resolver: INVESTIGATION_PROJECT_RESOURCE_RESOLVER_ID, effects: ["discover", "read", "submit"], ...changes } })
    const options = { mode: "assist", trustedRegistryHash: sha256(f.registryText), mandatoryOperations: ["data.investigate.read"] }
    let proofResolutions = 0
    const runtime = new WorkspaceRuntime(f.memory, options, () => {
      proofResolutions++
      return { operation: "data.investigate.read", boundary: "alg_investigation", verifier_id: "service-probe-v1",
        evidence_sha256: sha256("actual service qualification receipt"),
        verified_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString() }
    })
    expect(runtime.evaluate("owner", "data.investigate.read", "execute", true).mode).toBe("advisory")
    expect(proofResolutions).toBe(0)
    expect(() => runtime.guard("owner", "data.investigate.read", "execute")).toThrow(/coverage_unknown/)
  })
})

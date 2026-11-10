import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRun, loadRunForOwner } from "../src/store.ts"
import { mutateOwnedRunAsync } from "../src/ownership.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { OperationalRuntime } from "../src/operational-runtime.ts"
import { createOperationalTools } from "../src/operational-tools.ts"
import { getTemplate } from "../src/templates.ts"
import { investigationReviewBasis, recordInvestigationReview, requireInvestigationReview } from "../src/investigation-review.ts"
import { InvestigationStore, type InvestigationMcpPort, type InvestigationWorkInput } from "../src/investigation/index.ts"
import { removeProject, tempProject } from "./helpers.ts"

const projects: string[] = []
afterEach(() => { for (const project of projects.splice(0)) removeProject(project) })
const project = () => { const path = tempProject("alg-operational-"); projects.push(path); return path }
const input: InvestigationWorkInput = {
  operation: "bounded-read", recipe_version: "v1", parameters: {}, query: { source: "synthetic" },
  reserved_cost: 0, source_dependencies: ["snapshot-1"],
}
function fixture(path = project()) {
  const memory = new SessionMemoryRuntime(path, { mode: "assist" })
  memory.beginTask("owner", "Explain synthetic excursion")
  const run = createRun({ goal: "Explain synthetic excursion", criteria: ["cite sources"],
    graph: getTemplate("data-investigation"), projectDirectory: path, ownerSessionId: "owner" })
  let submits = 0
  const capabilities: InvestigationMcpPort["capabilities"] = { server_id: "synthetic", server_revision: "v1",
    tool_id: "submit", tool_schema_revision: "a".repeat(64), principal_id: "service",
    project_id: memory.store.projectId, effects: ["read"], idempotent_submit: true,
    lookup_by_submission_id: true, response_limit_bytes: 65536, qualified: true }
  const port: InvestigationMcpPort = {
    capabilities,
    submit: async () => { submits++; return { kind: "running", external_job_id: "job-1" } },
    lookup: async () => ({ kind: "unknown", reason: "still pending" }),
    validateResult: async () => ({ valid: false, validity_key: "a".repeat(64), access_scope: "none" }),
  }
  const runtime = new OperationalRuntime(memory, {}, { enabled: true, costLimit: 20, perJobReservation: 5, continuation: { waitMs: 0, pollIntervalMs: 100 } }, () => port)
  return { path, memory, run, runtime, port, get submits() { return submits } }
}

describe("operational investigation host", () => {
  test("models cannot manufacture fresh work through purpose or generation", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const first = await f.runtime.query("owner", { ...input, as_of: "2026-11-10" })
    await expect(f.runtime.query("owner", { ...input, generation: 1 })).rejects.toThrow("host-owned")
    for (const purpose of ["independent_verification", "refresh", "recomputation"] as const)
      await expect(f.runtime.query("owner", { ...input, purpose })).rejects.toThrow("host-owned")
    const same = await f.runtime.query("owner", { ...input, as_of: "2026-11-09T18:00:00-06:00",
      parameters: { explanatory_label: "cosmetic" } })
    expect(same.work_key).toBe(first.work_key)
    expect(f.submits).toBe(1)
  })

  test("typed argument diagnostics name safe fields without echoing unknown keys or values", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const tool = createOperationalTools(f.runtime, async () => {}).alg_investigation
    const context = { sessionID: "owner", worktree: f.path, directory: f.path } as never
    const reply = await tool.execute({ request: { action: "admit", input: { ...input,
      recipe_version: 7, "untrusted-private-key": "untrusted-private-value" } } } as never, context)
    if (typeof reply === "string") throw new Error("expected structured tool result")
    expect(JSON.parse(reply.output)).toMatchObject({ error: "invalid_request",
      issues: expect.arrayContaining([{ path: "input.recipe_version", code: "invalid_type" }]) })
    expect(reply.output).not.toContain("untrusted-private")
    expect(f.submits).toBe(0)
  })

  test("restart and compaction reuse the pointer and never duplicate unknown work", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const first = await f.runtime.query("owner", input)
    expect(first.status).toBe("running")
    expect(f.submits).toBe(1)
    const restarted = new OperationalRuntime(new SessionMemoryRuntime(f.path, { mode: "assist" }),
      {}, { enabled: true, costLimit: 20, perJobReservation: 5, continuation: { waitMs: 0, pollIntervalMs: 100 } }, () => f.port)
    for (let i = 0; i < 20; i++) {
      expect(restarted.render("owner", 4096)).toContain(f.run.run_id)
      const again = await restarted.query("owner", input)
      expect(again.work_key).toBe(first.work_key)
      expect(again.submission_id).toBe(first.submission_id)
    }
    expect(f.submits).toBe(1)
    expect(restarted.status("owner")).toMatchObject({ reserved_cost: 5, admission_count: 1 })
    await restarted.detach("owner")
    expect(() => restarted.status("owner")).not.toThrow()
    await expect(restarted.query("owner", input)).rejects.toThrow("no scoped investigation")
    await restarted.attach("owner", f.run.run_id)
    expect((await restarted.query("owner", input)).work_key).toBe(first.work_key)
    expect(f.submits).toBe(1)
    restarted.memory.beginTask("owner", "A new task")
    await expect(restarted.query("owner", input)).rejects.toThrow("no scoped investigation")
  }, 60000)

  test("missed pointer delivery blocks query before admission or remote submission", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    f.memory.deliveryUnavailable.add("owner")
    await expect(f.runtime.query("owner", input)).rejects.toThrow("needs_context")
    expect(f.submits).toBe(0)
    expect(f.runtime.status("owner")).toMatchObject({ admission_count: 0, reserved_cost: 0 })
    f.memory.deliveryUnavailable.delete("owner")
    expect((await f.runtime.query("owner", input)).status).toBe("running")
    expect(f.submits).toBe(1)
  })

  test("new task records ledger detach durably without resetting jobs or budget", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    await f.runtime.query("owner", input)
    const scope = { project_directory: f.path, project_id: f.memory.store.projectId,
      owner_id: "owner", run_id: f.run.run_id }
    expect(InvestigationStore.open(scope).snapshot.attachments).toHaveLength(1)
    const next = f.memory.beginTask("owner", "Unrelated task")
    expect(next.investigation).toBeUndefined()
    expect(next.investigation_detach_pending).toBeUndefined()
    const restarted = new SessionMemoryRuntime(f.path, { mode: "assist" })
    expect(restarted.current("owner").investigation).toBeUndefined()
    expect(InvestigationStore.open(scope).snapshot).toMatchObject({
      attachments: [], reserved_cost: 5, cumulative_cost: 0,
      work: [{ status: "running", external_job_id: "job-1" }],
    })
    const resumed = new OperationalRuntime(restarted, {}, { enabled: true, costLimit: 20, perJobReservation: 5, continuation: { waitMs: 0, pollIntervalMs: 100 } },
      () => f.port)
    await resumed.attach("owner", f.run.run_id)
    expect((await resumed.query("owner", input)).status).toBe("running")
    expect(f.submits).toBe(1)
  })

  test("restart replays a committed detach intent after a crash window", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const scope = { project_directory: f.path, project_id: f.memory.store.projectId,
      owner_id: "owner", run_id: f.run.run_id }
    const ref = f.memory.current("owner").investigation!
    f.memory.update("owner", (state) => ({ ...state, task_epoch: state.task_epoch + 1,
      investigation: undefined, investigation_detach_pending: ref }))
    expect(InvestigationStore.open(scope).snapshot.attachments).toHaveLength(1)
    const restarted = new SessionMemoryRuntime(f.path, { mode: "assist" })
    expect(restarted.current("owner").investigation_detach_pending).toBeUndefined()
    expect(InvestigationStore.open(scope).snapshot.attachments).toHaveLength(0)
    expect(restarted.current("owner").investigation).toBeUndefined()
    const revision = InvestigationStore.open(scope).snapshot.revision
    // Crash after ledger detach but before the memory intent was cleared.
    restarted.update("owner", (state) => ({ ...state, investigation_detach_pending: ref }))
    const replayed = new SessionMemoryRuntime(f.path, { mode: "assist" })
    expect(replayed.current("owner").investigation_detach_pending).toBeUndefined()
    expect(InvestigationStore.open(scope).snapshot.revision).toBe(revision)
  })

  test("child requires current parent pointer, task epoch and its running node attempt", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    f.memory.delegate("owner", "child", "worker")
    await mutateOwnedRunAsync(f.path, f.run.run_id, "owner", (run) => {
      run.status = "running"
      run.phase = "run"
      run.global_attempts = 1
      run.nodes.discover!.status = "running"
      run.nodes.discover!.current_attempt = 1
      run.nodes.discover!.attempts.push({ attempt: 1, status: "running", session_id: "child",
        started_at: new Date().toISOString(), failures: [] })
    })
    const current = loadRunForOwner(f.path, f.run.run_id, "owner")!
    await f.runtime.child(current, "child", current.graph.nodes[0]!)
    expect(f.runtime.status("child")).toMatchObject({ enabled: true, reference: { run_id: f.run.run_id } })
    await expect(f.runtime.admitWork("child", input, ["discover"])).rejects.toThrow("delegated")
    const unassigned = await f.runtime.admitWork("owner", input, [])
    await expect(f.runtime.executeWork("child", unassigned.work_key)).rejects.toThrow("not assigned")
    const assigned = await f.runtime.admitWork("owner", input, ["discover"])
    expect(assigned.work_key).toBe(unassigned.work_key)
    expect((await f.runtime.executeWork("child", assigned.work_key)).status).toBe("running")
    expect(f.submits).toBe(1)
    await expect(f.runtime.note("child", { next_action: "override" })).rejects.toThrow("children")
    await expect(f.runtime.note("child", { analytical_result: { status: "supported",
      claim: "child override", evidence_refs: [], authority: "reported_analysis" } })).rejects.toThrow("children")
    await expect(f.runtime.hypothesis("child", { id: "h", statement: "x", status: "active", evidence_refs: [] })).rejects.toThrow("delegated")
    await f.runtime.detach("owner")
    expect(() => f.runtime.status("child")).toThrow("lost its parent")
    await f.runtime.attach("owner", f.run.run_id)
    f.memory.beginTask("owner", "new task")
    expect(() => f.runtime.status("child")).toThrow("lost its parent")
  })

  test("recorded result is revalidated for each reuse and permission revocation never resubmits", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    let submits = 0, valid = true
    const result = { manifest_ref: "synthetic://manifest/1", digest: "b".repeat(64),
      source_versions: ["snapshot-1"], coverage: { rows: 2 }, observed_at: new Date().toISOString(),
      access_scope: "reader" }
    const port: InvestigationMcpPort = {
      ...f.port,
      submit: async () => { submits++; return { kind: "result", result, actual_cost: 2 } },
      validateResult: async (_result, work) => ({ valid, validity_key: work.validity_key,
        access_scope: valid ? "reader" : "revoked" }),
    }
    const runtime = new OperationalRuntime(f.memory, {}, { enabled: true, costLimit: 20, perJobReservation: 5, continuation: { waitMs: 0, pollIntervalMs: 100 } }, () => port)
    const first = await runtime.query("owner", input)
    expect(first.result).toMatchObject({ manifest_ref: result.manifest_ref })
    expect((await runtime.query("owner", input)).work_key).toBe(first.work_key)
    expect(submits).toBe(1)
    valid = false
    await expect(runtime.query("owner", input)).rejects.toThrow("validity")
    expect(submits).toBe(1)
    await expect(runtime.attach("other", f.run.run_id)).rejects.toThrow()
  })

  test("typed tool rejects model budget controls and reserves the operator configured maximum", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const tool = createOperationalTools(f.runtime, async () => {}).alg_investigation
    const context = { sessionID: "owner", worktree: f.path, directory: f.path } as never
    const rejected = await tool.execute({ request: { action: "admit", input: {
      ...input, reserved_cost: 1000000,
    } } } as never, context)
    if (typeof rejected === "string") throw new Error("expected structured tool result")
    expect(JSON.parse(rejected.output).error).toBe("invalid_request")
    expect(f.submits).toBe(0)
    const args = { request: { action: "admit" as const, node_ids: [], input: {
      operation: input.operation, recipe_version: input.recipe_version, parameters: input.parameters,
      query: input.query, source_dependencies: input.source_dependencies ?? [],
    } } }
    const order = await tool.execute(args, context)
    if (typeof order === "string") throw new Error("expected structured tool result")
    const execute = { request: { action: "query" as const, work_key: JSON.parse(order.output).work_key as string } }
    const first = await tool.execute(execute, context)
    const second = await tool.execute(execute, context)
    if (typeof first === "string" || typeof second === "string") throw new Error("expected structured tool result")
    expect(JSON.parse(first.output).status).toBe("running")
    expect(JSON.parse(second.output).work_key).toBe(JSON.parse(first.output).work_key)
    expect(f.runtime.status("owner")).toMatchObject({ reserved_cost: 5, admission_count: 1 })
    expect(f.submits).toBe(1)
  })

  test("root analytical assessment stays reported and appears in bounded status context", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const tool = createOperationalTools(f.runtime, async () => {}).alg_investigation
    const context = { sessionID: "owner", worktree: f.path, directory: f.path } as never
    const assessment = { status: "unresolved", claim: "Synthetic evidence leaves two explanations open",
      evidence_refs: ["manifest:1"], authority: "reported_analysis" }
    const recorded = await tool.execute({ request: { action: "note", patch: {
      analytical_result: assessment,
    } } } as never, context)
    if (typeof recorded === "string") throw new Error("expected structured tool result")
    expect(JSON.parse(recorded.output).analytical_result).toEqual(assessment)
    expect(f.runtime.status("owner")).toMatchObject({ checkpoint: { analytical_result: assessment } })
    expect(f.runtime.render("owner", 1024)).toContain("reported_analysis")
    const rejected = await tool.execute({ request: { action: "note", patch: {
      analytical_result: { ...assessment, authority: "verified_truth" },
    } } } as never, context)
    if (typeof rejected === "string") throw new Error("expected structured tool result")
    expect(JSON.parse(rejected.output)).toHaveProperty("error")
    expect(f.runtime.status("owner")).toMatchObject({ checkpoint: { analytical_result: assessment } })
  })

  test("workspace mandatory boundary uses only current operator qualification evidence", () => {
    const path = project()
    const memory = new SessionMemoryRuntime(path, { mode: "assist" })
    memory.beginTask("owner", "Synthetic investigation")
    const registry = JSON.stringify({ schema_version: 1, operations: [{
      id: "data.investigate.read", phase: ["execute"], roles: ["orchestrator"],
      resources: [memory.store.projectId], coverage: "qualified", boundary: "alg_investigation",
      input_validator: "investigation-work-v1", resource_resolver: "investigation-project-v1",
      effects: ["discover", "read", "submit"], verifier_ids: ["operator-verifier"], requirements: [],
    }] })
    mkdirSync(join(path, ".opencode"), { recursive: true })
    writeFileSync(join(path, ".opencode", "ALG.workspace.json"), registry)
    const workspace = { mode: "assist", trustedRegistryHash: createHash("sha256").update(registry).digest("hex"),
      mandatoryOperations: ["data.investigate.read"] }
    const adapter = { endpoint: "http://127.0.0.1:1/mcp", serverId: "logical", serverRevision: "v1",
      principalId: "service", mcpServerName: "synthetic-mcp", mcpServerVersion: "1.0",
      profileEvidence: "operator controlled synthetic receipt", verifierId: "operator-verifier",
      evidenceSha256: "a".repeat(64), verifiedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(), readOnlyOperations: true,
      scopeEnforcedByServer: true, executionLimits: { maxDurationMs: 1000, maxBytesScanned: 4096,
        maxResultBytes: 1024, maxCost: 5 }, idempotentSubmit: true, lookupBySubmissionId: true,
      operations: ["bounded-read"], submit: { name: "submit", schemaHash: "b".repeat(64) },
      lookup: { name: "lookup", schemaHash: "b".repeat(64) },
      validateResult: { name: "validate", schemaHash: "b".repeat(64) },
      responseLimitBytes: 4096 }
    const runtime = new OperationalRuntime(memory, workspace, { enabled: true, adapter })
    expect(() => runtime.workspace.guard("owner", "data.investigate.read")).not.toThrow()
    const wrong = new OperationalRuntime(memory, workspace, { enabled: true,
      adapter: { ...adapter, verifierId: "different-verifier" } })
    expect(() => wrong.workspace.guard("owner", "data.investigate.read")).toThrow("coverage_unknown")
    const expired = new OperationalRuntime(memory, workspace, { enabled: true,
      adapter: { ...adapter, expiresAt: new Date(Date.now() - 1).toISOString() } })
    expect(() => expired.workspace.guard("owner", "data.investigate.read")).toThrow("coverage_unknown")
    const absent = new OperationalRuntime(memory, workspace, { enabled: true })
    expect(() => absent.workspace.guard("owner", "data.investigate.read")).toThrow("coverage_unknown")
  })

  test("review binds complete findings and gates confirmation until fresh review", async () => {
    const f = fixture()
    const run = await f.runtime.begin(f.run)
    for (const id of ["discover", "process", "equipment", "metrology", "reconcile"]) {
      run.nodes[id]!.status = "done"
      run.nodes[id]!.current_attempt = 3
      run.nodes[id]!.output = { finding: id, evidence: ["synthetic"] }
    }
    const basis = investigationReviewBasis(run)
    await expect(f.runtime.beforeBatch(run, [run.graph.nodes.find((node) => node.id === "confirm")!]))
      .rejects.toThrow("engineer_review_required")
    recordInvestigationReview(run, "engineer-1")
    expect(() => requireInvestigationReview(run)).not.toThrow()
    await expect(f.runtime.beforeBatch(run, [run.graph.nodes.find((node) => node.id === "confirm")!]))
      .resolves.toBeUndefined()
    await f.runtime.note("owner", { analytical_result: { status: "unresolved",
      claim: "Two explanations remain", evidence_refs: ["manifest:1"], authority: "reported_analysis" } })
    expect(() => requireInvestigationReview(run)).toThrow("engineer_review_required")
    recordInvestigationReview(run, "engineer-1")
    expect(() => requireInvestigationReview(run)).not.toThrow()
    run.nodes.reconcile!.output = { finding: "different", evidence: ["synthetic"] }
    expect(investigationReviewBasis(run)).not.toBe(basis)
    expect(() => requireInvestigationReview(run)).toThrow("engineer_review_required")
    await expect(f.runtime.beforeBatch(run, [run.graph.nodes.find((node) => node.id === "confirm")!]))
      .rejects.toThrow("engineer_review_required")
  })
})


test("reviewed recipe admission normalizes parameters and rejects executable-query substitution", async () => {
  const f = fixture()
  const recipe = { operation: "bounded-read", version: "v1", base_query: { recipe: "fixture" },
    parameters: [{ name: "at", type: "iso_timestamp" as const, required: true }] }
  const runtime = new OperationalRuntime(f.memory, {}, { enabled: true, costLimit: 20, perJobReservation: 5,
    recipes: [recipe], continuation: { waitMs: 0, pollIntervalMs: 100 } }, () => f.port)
  await runtime.begin(f.run)
  const first = await runtime.admitRecipe("owner", "bounded-read", "v1", { at: "2026-11-10T00:00:00Z" }, ["discover"])
  const same = await runtime.admitRecipe("owner", "bounded-read", "v1", { at: "2026-11-09T18:00:00-06:00" }, ["discover"])
  expect(same.work_key).toBe(first.work_key)
  expect(f.submits).toBe(0)
  await expect(runtime.admitRecipe("owner", "bounded-read", "v1", { at: "ambiguous" }, ["discover"])).rejects.toThrow("recipe")
  await expect(runtime.admitWork("owner", input, ["discover"])).rejects.toThrow("recipe")
  expect((await runtime.executeWork("owner", first.work_key)).status).toBe("running")
  expect(f.submits).toBe(1)
})

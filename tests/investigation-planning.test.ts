import { afterEach, describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { createAlgTools } from "../src/tools.ts"
import { createRun, listOwnedRunEnvelopes, loadRunForOwner, projectRunsRoot } from "../src/store.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { OperationalRuntime } from "../src/operational-runtime.ts"
import { InvestigationStore } from "../src/investigation/index.ts"
import { getTemplate } from "../src/templates.ts"
import { inertClient, removeProject, tempProject, testTaskContract } from "./helpers.ts"

const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) removeProject(path) })
function fixture() {
  const path = tempProject("alg-plan-reuse-"); paths.push(path)
  const memory = new SessionMemoryRuntime(path, { mode: "assist" })
  const operations = new OperationalRuntime(memory, {}, { enabled: true, costLimit: 17 })
  const tools = createAlgTools({ directory: path, worktree: path, client: inertClient() } as any,
    () => ({}), () => undefined, { sessionMemory: memory, operations })
  const context = { sessionID: "owner", messageID: "m1", agent: "orchestrator", directory: path, worktree: path,
    abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any
  const args = { goal: "Explain the fixture", criteria: ["Preserve uncertainty"], template: "data-investigation" as const,
    task_contract: testTaskContract({ kind: "read_only", discovery: "required", phase: "complete",
      deliverables: [{ destination: "response", producer_node: "confirm" }],
      verification: { checker_node: "check", execution: "none" }, preserve_paths: [] }) }
  return { path, memory, operations, tools, context, args }
}
function unpack(value: unknown): any { return JSON.parse((value as { output: string }).output) }
function fresh(f: ReturnType<typeof fixture>) {
  const memory = new SessionMemoryRuntime(f.path, { mode: "assist" })
  const operations = new OperationalRuntime(memory, {}, { enabled: true, costLimit: 99 })
  return { memory, operations, tools: createAlgTools({ directory: f.path, worktree: f.path, client: inertClient() } as any,
    () => ({}), () => undefined, { sessionMemory: memory, operations }) }
}

describe("durable investigation planning", () => {
  test("simultaneous retries create one run and ledger; host reconstruction keeps its original budget", async () => {
    const f = fixture()
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => f.tools.alg_plan.execute(f.args, { ...f.context, messageID: "m" + i })))
    const plans = results.map(unpack)
    for (const plan of plans) expect(plan.error).toBeUndefined()
    expect(new Set(plans.map((p) => p.run_id)).size).toBe(1)
    expect(plans.filter((p) => !p.plan_reused)).toHaveLength(1)
    const id = plans[0].run_id
    const again = unpack(await fresh(f).tools.alg_plan.execute({ ...f.args, goal: " Explain the fixture ", mode: "live" }, f.context))
    expect(again).toMatchObject({ run_id: id, plan_reused: true, status: "planning" })
    expect(listOwnedRunEnvelopes(f.path, "owner")).toHaveLength(1)
    const ledger = InvestigationStore.open({ project_directory: f.path, project_id: f.memory.store.projectId, owner_id: "owner", run_id: id })
    expect(ledger.snapshot.cost_limit).toBe(17)
    expect(ledger.snapshot.work).toHaveLength(0)
  })

  test("changed criteria, mode or goal cannot replace the attached investigation", async () => {
    const f = fixture(), first = unpack(await f.tools.alg_plan.execute(f.args, f.context))
    const checkpoint = structuredClone(f.memory.current("owner"))
    for (const changed of [
      { criteria: ["Different"] },
      { mode: "dry" as const },
      { goal: "Paraphrased new plan" },
      { task_contract: { ...f.args.task_contract, phase: "preparation" as const } },
      { task_contract: { ...f.args.task_contract, deliverables: [{ destination: "response" as const, producer_node: "discover" }] } },
    ]) {
      const result = unpack(await f.tools.alg_plan.execute({ ...f.args, ...changed }, f.context))
      expect(result.error).toContain("investigation already admitted")
    }
    expect(f.memory.current("owner").investigation?.run_id).toBe(first.run_id)
    const afterRejections = f.memory.current("owner")
    // The durable task admission and attachment claim must not move on a
    // rejected request; host checkpoint revision metadata may be refreshed.
    expect(afterRejections.investigation).toEqual(checkpoint.investigation)
    expect(afterRejections.investigation_plan).toEqual(checkpoint.investigation_plan)
    expect(afterRejections.task_epoch).toBe(checkpoint.task_epoch)
    expect(afterRejections.goal).toBe(checkpoint.goal)
    expect(afterRejections.workspace_operation).toBe(checkpoint.workspace_operation)
    expect(listOwnedRunEnvelopes(f.path, "owner")).toHaveLength(1)
  })

  test("detach does not reset identity, while explicit task advancement permits an intentional repeat", async () => {
    const f = fixture(), first = unpack(await f.tools.alg_plan.execute(f.args, f.context))
    await f.operations.detach("owner")
    const detached = unpack(await fresh(f).tools.alg_plan.execute(f.args, f.context))
    expect(detached).toMatchObject({ run_id: first.run_id, plan_reused: true })
    expect(f.memory.current("owner").investigation).toBeUndefined()
    expect(detached.investigation_attached).toBe(false)
    expect(detached.next).toContain("action:\"attach\"")
    const altered = unpack(await fresh(f).tools.alg_plan.execute({ ...f.args, criteria: ["Changed after detach"] }, f.context))
    expect(altered.error).toContain("already admitted")
    expect(listOwnedRunEnvelopes(f.path, "owner")).toHaveLength(1)
    f.memory.beginTask("owner", f.args.goal)
    const next = unpack(await fresh(f).tools.alg_plan.execute(f.args, f.context))
    expect(next.error).toBeUndefined()
    expect(next.run_id).not.toBe(first.run_id)
    expect(next.plan_reused).toBe(false)
    expect(loadRunForOwner(f.path, first.run_id, "owner")).not.toBeNull()
  })

  test("legacy attached random-ID plans are reused and other owners remain isolated", async () => {
    const f = fixture()
    const legacy = createRun({ projectDirectory: f.path, executionDirectory: f.path, ownerSessionId: "owner",
      goal: f.args.goal, criteria: f.args.criteria, graph: getTemplate("data-investigation") })
    await f.operations.begin(legacy)
    f.memory.update("owner", (state) => ({ ...state, investigation_plan: undefined })) // Pre-upgrade checkpoint.
    const legacyIntent = { goal: f.args.goal, criteria: f.args.criteria, graph: getTemplate("data-investigation"), directory: f.path, mode: "live" as const }
    const legacyReuse = await f.operations.planInvestigation("owner", legacyIntent, () => { throw new Error("must reuse the legacy run") })
    expect(legacyReuse).toMatchObject({ run: { run_id: legacy.run_id }, reused: true })
    const checkpoint = structuredClone(f.memory.current("owner"))
    const refusedAdoption = unpack(await f.tools.alg_plan.execute(f.args, f.context))
    expect(refusedAdoption.error).toContain("investigation already admitted")
    const afterRefusedAdoption = f.memory.current("owner")
    expect(afterRefusedAdoption.investigation).toEqual(checkpoint.investigation)
    expect(afterRefusedAdoption.investigation_plan).toEqual(checkpoint.investigation_plan)
    expect(afterRefusedAdoption.task_epoch).toBe(checkpoint.task_epoch)
    const other = unpack(await f.tools.alg_plan.execute(f.args, { ...f.context, sessionID: "other" }))
    expect(other.error).toBeUndefined()
    expect(other.run_id).not.toBe(legacy.run_id)
    expect(() => loadRunForOwner(f.path, other.run_id, "owner")).toThrow("does not own")
    await f.operations.detach("owner")
    const legacyDetached = await fresh(f).operations.planInvestigation("owner", legacyIntent, () => { throw new Error("must reuse the legacy run") })
    expect(legacyDetached).toMatchObject({ run: { run_id: legacy.run_id }, reused: true, attached: false })
    await f.operations.attach("owner", legacy.run_id)
    const oldRunResume = unpack(await f.tools.alg_run.execute({ run_id: legacy.run_id, dry: true }, f.context))
    expect(oldRunResume.error).toContain("engineer_review_required")
    const resumedLegacy = loadRunForOwner(f.path, legacy.run_id, "owner")!
    expect(resumedLegacy.task_contract).toBeUndefined()
    const discovered = resumedLegacy.nodes.discover
    expect(discovered).toBeDefined()
    expect(discovered!.status).toBe("done")
    expect(discovered!.current_attempt).toBeGreaterThan(0)
    expect(unpack(await f.tools.alg_plan.execute({ ...f.args, goal: "Changed" }, f.context)).error).toContain("already admitted")
  })

  test("a crash after durable run creation reuses that run rather than creating a second ledger", async () => {
    const f = fixture(), intent = { goal: f.args.goal, criteria: f.args.criteria, graph: getTemplate("data-investigation"), directory: f.path, mode: "live" as const }
    let retained = ""
    await expect(f.operations.planInvestigation("owner", intent, (runId) => {
      retained = createRun({ runId, projectDirectory: f.path, executionDirectory: f.path, ownerSessionId: "owner", ...intent }).run_id
      throw new Error("simulated interruption after create")
    })).rejects.toThrow("simulated interruption")
    await expect(fresh(f).operations.planInvestigation("owner", { ...intent, criteria: ["different retry"] }, () => { throw new Error("must not create") })).rejects.toThrow("already admitted")
    const recovered = await fresh(f).operations.planInvestigation("owner", intent, () => { throw new Error("must not create again") })
    expect(recovered).toMatchObject({ reused: true, run: { run_id: retained } })
    expect(recovered.run.investigation).toBeTruthy()
    expect(listOwnedRunEnvelopes(f.path, "owner")).toHaveLength(1)
    expect(readdirSync(projectRunsRoot(f.path)).filter((n) => /^[a-f0-9]{64}$/.test(n))).toHaveLength(1)
  })

  test("a task change during creation cannot attach an old-task run to the new task", async () => {
    const f = fixture(), intent = { goal: f.args.goal, criteria: f.args.criteria, graph: getTemplate("data-investigation"), directory: f.path, mode: "live" as const }
    await expect(f.operations.planInvestigation("owner", intent, (runId) => {
      const run = createRun({ runId, projectDirectory: f.path, executionDirectory: f.path, ownerSessionId: "owner", ...intent })
      f.memory.beginTask("owner", "new task")
      return run
    })).rejects.toThrow("task changed")
    expect(f.memory.current("owner").investigation).toBeUndefined()
    expect(listOwnedRunEnvelopes(f.path, "owner")).toHaveLength(1)
  })
  test("an attachment interleaved before claim commit is not overwritten", async () => {
    const f = fixture()
    const legacy = createRun({ projectDirectory: f.path, executionDirectory: f.path, ownerSessionId: "owner",
      goal: "Other retained investigation", criteria: [], graph: getTemplate("data-investigation") })
    const initialized = await f.operations.begin(legacy)
    f.memory.update("owner", (state) => ({ ...state, investigation: undefined, investigation_plan: undefined }))
    const original = f.memory.update.bind(f.memory)
    let injected = false
    f.memory.update = (owner, change) => {
      if (!injected) {
        injected = true
        original(owner, (state) => ({ ...state, investigation: initialized.investigation }))
      }
      return original(owner, change)
    }
    const intent = { goal: f.args.goal, criteria: f.args.criteria, graph: getTemplate("data-investigation"), directory: f.path, mode: "live" as const }
    await expect(f.operations.planInvestigation("owner", intent, () => { throw new Error("must not create") })).rejects.toThrow("attachment changed")
    expect(f.memory.current("owner").investigation?.run_id).toBe(legacy.run_id)
    expect(listOwnedRunEnvelopes(f.path, "owner")).toHaveLength(1)
  })

  test("explicit attach cannot replace the task claim with another owned run", async () => {
    const f = fixture(), first = unpack(await f.tools.alg_plan.execute(f.args, f.context))
    const other = createRun({ projectDirectory: f.path, executionDirectory: f.path, ownerSessionId: "owner",
      goal: "Other retained investigation", criteria: [], graph: getTemplate("data-investigation") })
    await expect(f.operations.begin(other)).rejects.toThrow("another investigation")
    expect(f.memory.current("owner").investigation?.run_id).toBe(first.run_id)
    expect(f.memory.current("owner").investigation_plan?.reference.run_id).toBe(first.run_id)
  })

})

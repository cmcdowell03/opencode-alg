import { afterEach, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { createRun, loadRun, persistRun } from "../src/store.ts"
import { validateGraph } from "../src/graph.ts"
import { bindTaskContract } from "../src/task-contract.ts"
import { TaskAllowanceRuntime } from "../src/task-allowance.ts"
import { MemoryStore } from "../src/session-memory/store.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { executeWithMemory } from "../src/session-memory/attempts.ts"
import { transferRunOwnershipAsync } from "../src/ownership.ts"
import { formatCompactionContext } from "../src/compaction.ts"
import { createAlgTools } from "../src/tools.ts"
import { executeContext, inertClient, tempProject, removeProject } from "./helpers.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeProject(root) })
function setup(max = 4, reserve = 1) {
  const root = tempProject("alg-task-allowance-execution-"); roots.push(root)
  const store = new MemoryStore(root)
  const allowance = new TaskAllowanceRuntime(store, { max_dispatches: max, verification_reserve: reserve })
  return { root, store, allowance }
}
async function phase(f: ReturnType<typeof setup>, name: string, owner = "session-owner", gate = false) {
  const graph = validateGraph({ name: "allowance-phase", max_global_attempts: 6, max_concurrency: 1, nodes: [
    { id: "work", agent: "implementer", depends_on: [], loop: { gate: gate ? "all" : "schema", max_attempts: 3 },
      ...(gate ? { shell_gate: { cmd: "test-fixture" } } : {}) },
    { id: "check", agent: "checker", depends_on: ["work"], isolated_check: true, inputs: { claimed: "work" },
      loop: { gate: "schema", max_attempts: 3 } },
  ] })
  const goal = name, criteria = ["Produce output.txt and verify it"]
  const taskContract = bindTaskContract({ version: 1, kind: "project_change", discovery: "not_required", phase: "complete",
    deliverables: [{ destination: "project_file", path: "output.txt", producer_node: "work" }],
    verification: gate ? { checker_node: "check", execution: "shell_gate", execution_node: "work" } : { checker_node: "check", execution: "none" },
    preserve_paths: [], evidence_plan: [{ criterion: 1, observations: [{ kind: "deliverable", index: 0 }] }],
  }, goal, criteria, graph, { session_id: owner, message_id: name })
  const taskAllowance = await f.allowance.admit(owner, taskContract.contract_sha256)
  return createRun({ goal, criteria, graph, taskContract, taskAllowance, projectDirectory: f.root, ownerSessionId: owner })
}
function runner(f: ReturnType<typeof setup>, calls: string[]) {
  return async (opts: { agent: string }) => {
    calls.push(opts.agent)
    if (opts.agent === "implementer") writeFileSync(join(f.root, "output.txt"), "verified result")
    return { session_id: "child-" + calls.length, text: "", parsed: opts.agent === "checker"
      ? { passed: true, score: 10, failures: [] }
      : { summary: ["done"], files_touched: ["output.txt"], commands_run: [], risks: [], done: true } }
  }
}
function entries(f: ReturnType<typeof setup>) { return f.store.checkpoint("session-owner")!.task_allowance!.entries }
function options(f: ReturnType<typeof setup>, calls: string[]) {
  return { ...executeContext(f.root), taskAllowance: f.allowance, sessionRunner: runner(f, calls) }
}

test("phases, beginTask, compaction and a fresh controller share one allowance", async () => {
  const f = setup(), calls: string[] = [], first = await phase(f, "prepare")
  await executeWithMemory(new SessionMemoryRuntime(f.root), first, options(f, calls))
  expect(first.status).toBe("done"); expect(entries(f)).toHaveLength(2)
  const memory = new SessionMemoryRuntime(f.root, { mode: "assist" })
  memory.beginTask("session-owner", "continue the same work")
  f.allowance = new TaskAllowanceRuntime(new MemoryStore(f.root), { max_dispatches: 256, verification_reserve: 1 })
  const second = await phase(f, "complete")
  expect(second.task_allowance).toEqual(first.task_allowance)
  expect(second.task_contract!.contract_sha256).not.toBe(first.task_contract!.contract_sha256)
  expect(formatCompactionContext(second)).toContain(first.task_allowance!.task_id)
  await executeRun(second, options(f, calls))
  expect(second.status).toBe("done"); expect(entries(f)).toHaveLength(4)
  const third = await phase(f, "replanned")
  await executeRun(third, options(f, calls))
  expect(third.status).toBe("blocked"); expect(third.phase).toBe("task-allowance")
  expect(third.global_attempts).toBe(0); expect(calls).toHaveLength(4)
  expect(f.store.checkpoint("session-owner")!.task_allowance!.policy.max_dispatches).toBe(4)
})

test("a saved reservation before attempt persistence is reused, never double charged", async () => {
  const f = setup(2), calls: string[] = [], run = await phase(f, "crash-before-attempt")
  await f.allowance.reserve(run, [{ node: run.graph.nodes[0]!, attempt: 1 }])
  expect(loadRun(f.root, run.run_id)!.global_attempts).toBe(0)
  f.allowance = new TaskAllowanceRuntime(new MemoryStore(f.root))
  await executeRun(loadRun(f.root, run.run_id)!, options(f, calls))
  expect(calls).toHaveLength(2); expect(entries(f)).toHaveLength(2)
})

test("an interrupted committed attempt remains charged while a retry consumes another dispatch", async () => {
  const f = setup(3), calls: string[] = [], run = await phase(f, "uncertain")
  await f.allowance.reserve(run, [{ node: run.graph.nodes[0]!, attempt: 1 }])
  run.status = "running"; run.phase = "execute"; run.global_attempts = 1
  const work = run.nodes.work!
  work.status = "running"; work.current_attempt = 1
  work.attempts.push({ attempt: 1, status: "running", started_at: new Date().toISOString(), failures: [] })
  // Baseline normally precedes this point; retain that actual ordering in this injected crash.
  const { captureTaskBaseline } = await import("../src/task-baseline.ts")
  const original = loadRun(f.root, run.run_id)!
  original.task_baseline = captureTaskBaseline(f.root, original.task_contract!)
  persistRun(original, f.root)
  run.revision = original.revision; run.task_baseline = original.task_baseline
  persistRun(run, f.root)
  const resumed = prepareRunForResume(loadRun(f.root, run.run_id)!)
  await executeRun(resumed, { ...options(f, calls), operation: "resume" })
  expect(resumed.status).toBe("done"); expect(entries(f)).toHaveLength(3)
  expect(calls).toHaveLength(2); expect(resumed.nodes.work!.current_attempt).toBe(2)
})

test("a transferred run and subsequent phase retain the original root ledger", async () => {
  const f = setup(), calls: string[] = [], run = await phase(f, "handoff")
  await executeRun(run, { ...options(f, calls), maxWaves: 1 })
  const moved = await transferRunOwnershipAsync(f.root, run.run_id, "session-owner", "recipient")
  await executeRun(prepareRunForResume(moved), { ...options(f, calls), parentSessionId: "recipient", operation: "resume" })
  expect(moved.task_allowance!.root_owner).toBe("session-owner")
  const next = await phase(f, "next-phase", "recipient")
  expect(next.task_allowance).toEqual(run.task_allowance)
  await executeRun(next, { ...options(f, calls), parentSessionId: "recipient" })
  expect(entries(f)).toHaveLength(4); expect(calls).toHaveLength(4)
})

test("gate-only recovery consumes no child allowance and leaves the final checker reserved", async () => {
  const f = setup(2), calls: string[] = [], run = await phase(f, "gate", "session-owner", true)
  await executeRun(run, { ...options(f, calls), shellRunner: async () => ({
    cwd: f.root, ok: false, exit_code: 125, stdout_tail: "", stderr_tail: "setup unavailable", setup_failed: true,
  }) })
  expect(calls).toEqual(["implementer"]); expect(entries(f)).toHaveLength(1)
  const resumed = prepareRunForResume(loadRun(f.root, run.run_id)!)
  await executeRun(resumed, { ...options(f, calls), operation: "resume", shellRunner: async () => ({
    cwd: f.root, ok: true, exit_code: 0, stdout_tail: "passed", stderr_tail: "",
  }) })
  expect(resumed.status).toBe("done"); expect(calls).toEqual(["implementer", "checker"])
  expect(entries(f)).toHaveLength(2); expect(resumed.global_attempts).toBe(3)
})

test("bound runs fail closed without a controller and their binding cannot be erased", async () => {
  const f = setup(), calls: string[] = [], run = await phase(f, "guard")
  await expect(executeRun(run, { ...executeContext(f.root), sessionRunner: runner(f, calls) })).rejects.toThrow("task_allowance_unavailable")
  expect(calls).toHaveLength(0)
  const changed = loadRun(f.root, run.run_id)!; delete changed.task_allowance
  expect(() => persistRun(changed, f.root)).toThrow("task allowance reference is immutable")
})

test("concurrent real-store runs cannot dispatch past the shared bound", async () => {
  const f = setup(3), calls: string[] = []
  const a = await phase(f, "parallel-a"), b = await phase(f, "parallel-b")
  await Promise.all([executeRun(a, options(f, calls)), executeRun(b, {
    ...options(f, calls), taskAllowance: new TaskAllowanceRuntime(new MemoryStore(f.root)),
  })])
  expect(entries(f)).toHaveLength(3); expect(calls).toHaveLength(3)
  expect([a, b].filter(run => run.status === "done")).toHaveLength(1)
  expect([a, b].filter(run => run.phase === "task-allowance")).toHaveLength(1)
})

test("checkpoint write failure cannot create a run attempt or child", async () => {
  const f = setup(), calls: string[] = [], run = await phase(f, "storage-failure")
  const originalUpdate = f.store.update.bind(f.store)
  f.store.update = () => { throw new Error("Injected checkpoint storage failure") }
  try { await executeRun(run, options(f, calls)) }
  finally { f.store.update = originalUpdate }
  expect(run.phase).toBe("task-allowance"); expect(run.global_attempts).toBe(0)
  expect(calls).toHaveLength(0); expect(entries(f)).toHaveLength(0)
})

test("new tool plans share a task reference with memory disabled and surface its status", async () => {
  const f = setup(), client = inertClient()
  const tools = createAlgTools({ client, directory: f.root, worktree: f.root } as never,
    undefined, undefined, { taskAllowancePolicy: { max_dispatches: 4, verification_reserve: 1 } })
  const context = { sessionID: "tool-owner", messageID: "tool-message", agent: "orchestrator", directory: f.root,
    worktree: f.root, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any
  const task = { version: 1, kind: "project_change", discovery: "not_required", phase: "preparation",
    deliverables: [{ destination: "project_file", path: "output.txt", producer_node: "implement" }],
    verification: { checker_node: "check", execution: "none" }, preserve_paths: [],
    evidence_plan: [{ criterion: 1, observations: [{ kind: "deliverable", index: 0 }] }] } as const
  const plans = []
  for (const goal of ["prepare", "continue"]) plans.push(JSON.parse((await tools.alg_plan.execute({
    goal, criteria: ["write output.txt"], task_contract: structuredClone(task) as any,
  }, context) as { output: string }).output))
  expect(plans.every(p => !p.error)).toBe(true)
  const a = loadRun(f.root, plans[0].run_id)!, b = loadRun(f.root, plans[1].run_id)!
  expect(a.task_allowance).toEqual(b.task_allowance); expect(plans[0].task_allowance_status).toBeDefined()
  const status = JSON.parse((await tools.alg_status.execute({ run_id: a.run_id }, context) as { output: string }).output)
  expect(status.task_allowance_status).toMatchObject({ task_id: a.task_allowance!.task_id, reserved: 0, remaining_total: 4 })
})


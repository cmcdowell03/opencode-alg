import { expect, test } from "bun:test"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { validateGraph } from "../src/graph.ts"
import { createRun, hydrateRunFully, loadRun } from "../src/store.ts"
import { bindTaskContract } from "../src/task-contract.ts"
import { withShellGate } from "../src/tools.ts"
import type { NodePromptOpts } from "../src/sessions.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

const implemented = { summary: ["completed"], files_touched: ["result.json"], commands_run: [], risks: [], done: true }
const checked = { passed: true, score: 10, failures: [] }
const research = { answer: "summary", evidence: [], constraints: [], options: [], acceptance_criteria: ["report"], risks: [] }

function fixture(root: string, options: { local?: number; global?: number; execution?: "none" | "host_command" | "shell_gate"; tail?: boolean; sibling?: boolean; deliverable?: string } = {}) {
  const execution = options.execution ?? "none", gated = execution === "shell_gate"
  const graph = validateGraph({ name: "task-recovery", max_global_attempts: options.global ?? 8, nodes: [
    ...(options.sibling ? [{ id: "independent", agent: "researcher", depends_on: [] }] : []),
    { id: "implement", agent: "implementer", depends_on: [], loop: { gate: gated ? "all" : "schema", max_attempts: options.local ?? 3 },
      ...(gated ? { shell_gate: { cmd: "echo original", cwd: ".", timeout_ms: 1000 } } : {}) },
    { id: "check", agent: "checker", depends_on: ["implement"], isolated_check: true, loop: { gate: "schema", max_attempts: 2 } },
    ...(options.tail ? [{ id: "tail", agent: "researcher", depends_on: ["check"], loop: { gate: "schema", max_attempts: 2 } }] : []),
  ] })
  const goal = "Produce result.json", criteria = ["Create the requested file"], ownerSessionId = "session-owner"
  const taskContract = bindTaskContract({
    version: 1, kind: "project_change", discovery: "not_required", phase: "complete",
    deliverables: [{ destination: "project_file", path: options.deliverable ?? "result.json", producer_node: "implement" }],
    preserve_paths: [], verification: { checker_node: "check", execution, ...(execution === "none" ? {} : { execution_node: "implement" }) },
  }, goal, criteria, graph, { session_id: ownerSessionId, message_id: "accepted" })
  return createRun({ goal, criteria, graph, taskContract, projectDirectory: root, ownerSessionId })
}

function resume(root: string, runId: string) {
  return prepareRunForResume(loadRun(root, runId)!)
}

test("an explicit resume repairs a missing file without rerunning completed unrelated work", async () => {
  const root = tempProject()
  try {
    const run = fixture(root, { sibling: true })
    const calls: string[] = []
    let repair = false
    const sessionRunner = async (opts: NodePromptOpts) => {
      calls.push(opts.agent)
      if (opts.agent === "implementer" && repair) {
        expect(opts.userPrompt).toContain("Host prerequisite repair")
        writeFileSync(join(root, "result.json"), '{"valid":true}')
      }
      return { session_id: opts.title, text: "", parsed: opts.agent === "implementer" ? implemented : opts.agent === "checker" ? checked : research }
    }
    const context = { ...executeContext(root), sessionRunner }
    await expect(executeRun(run, context)).rejects.toThrow("task_deliverable_unavailable")
    expect(run.phase).toBe("task-prerequisite")
    expect(run.global_attempts).toBe(2)
    expect(run.nodes.check!.current_attempt).toBe(0)
    const initial = hydrateRunFully(loadRun(root, run.run_id)!).nodes.implement!.attempts[0]!
    expect(initial.outcome).toBe("passed")

    await expect(executeRun(loadRun(root, run.run_id)!, context)).rejects.toThrow("task_deliverable_unavailable")
    expect(calls.sort()).toEqual(["implementer", "researcher"])
    repair = true
    const recovered = await executeRun(resume(root, run.run_id), { ...context, operation: "resume" })
    expect(recovered.status).toBe("done")
    expect(calls.slice(2)).toEqual(["implementer", "checker"])
    const persisted = hydrateRunFully(loadRun(root, run.run_id)!)
    expect(persisted.global_attempts).toBe(4)
    expect(persisted.criteria).toEqual(run.criteria)
    expect(persisted.nodes.independent!.current_attempt).toBe(1)
    expect(persisted.nodes.implement!.attempts[0]!.outcome).toBe("passed")
    expect(persisted.nodes.implement!.attempts[0]!.started_at).toBe(initial.started_at)
  } finally { removeProject(root) }
})

test("missing native evidence can be repaired by a new scoped producer attempt", async () => {
  const root = tempProject()
  try {
    const run = fixture(root, { execution: "host_command" })
    writeFileSync(join(root, "result.json"), "{}")
    const sessionRunner = async (opts: NodePromptOpts) => {
      const identity = opts.execution_evidence_identity
      const session_id = opts.title
      return { session_id, text: "", parsed: identity ? implemented : checked,
        ...(identity?.attempt === 2 ? { execution_evidence: {
          version: 1 as const, run_id: identity.run_id, node_id: identity.node_id, attempt: identity.attempt, child_session_id: session_id,
          retrieval_status: "available" as const, commands: [{ tool: "bash" as const, command: "bun test",
            tool_status: "completed" as const, exit_code_status: "reported" as const, exit_code: 0,
            output_truncated: false, command_truncated: false, cwd_truncated: false }],
          omitted_commands: 0, window_may_be_incomplete: false, foreign_messages_omitted: 0,
        } } : {}),
      }
    }
    const context = { ...executeContext(root), sessionRunner }
    await expect(executeRun(run, context)).rejects.toThrow("task_execution_unavailable")
    const recovered = await executeRun(resume(root, run.run_id), { ...context, operation: "resume" })
    expect(recovered.status).toBe("done")
    expect(recovered.global_attempts).toBe(3)
    expect(recovered.nodes.implement!.attempts.map(attempt => attempt.outcome)).toEqual(["passed", "passed"])
    expect(recovered.nodes.check!.attempts[0]!.task_evidence_ref).toBeDefined()
  } finally { removeProject(root) }
})

test.each([{ local: 1 }, { global: 2 }])("explicit prerequisite repair respects the original budget %o", async budget => {
  const root = tempProject()
  try {
    const run = fixture(root, budget)
    let calls = 0
    const context = { ...executeContext(root), sessionRunner: async () => { calls++; return { session_id: "implement", text: "", parsed: implemented } } }
    await expect(executeRun(run, context)).rejects.toThrow("task_deliverable_unavailable")
    const blocked = await executeRun(resume(root, run.run_id), { ...context, operation: "resume" })
    expect(blocked.summary).toContain("task_prerequisite_retry_budget_exhausted")
    expect(blocked.status).toBe("blocked")
    expect(blocked.nodes.implement!.status).toBe("done")
    expect(blocked.global_attempts).toBe(1)
    expect(calls).toBe(1)
  } finally { removeProject(root) }
})

test("prerequisite repair refuses a project deliverable redirected outside the worktree", async () => {
  const root = tempProject(), external = tempProject()
  try {
    const run = fixture(root, { deliverable: "delivery/result.json" })
    let calls = 0
    const context = { ...executeContext(root), sessionRunner: async () => { calls++; return { session_id: "implement", text: "", parsed: implemented } } }
    await expect(executeRun(run, context)).rejects.toThrow("task_deliverable_unavailable")
    symlinkSync(external, join(root, "delivery"), "junction")
    const blocked = await executeRun(resume(root, run.run_id), { ...context, operation: "resume" })
    expect(blocked.summary).toContain("task_prerequisite_path_unavailable")
    expect(blocked.global_attempts).toBe(1)
    expect(calls).toBe(1)
  } finally { removeProject(root); removeProject(external) }
})

test("persistent missing evidence does not trigger a producer/checker prompt loop", async () => {
  const root = tempProject()
  try {
    const run = fixture(root)
    let calls = 0
    const context = { ...executeContext(root), sessionRunner: async () => { calls++; return { session_id: "implement", text: "", parsed: implemented } } }
    await expect(executeRun(run, context)).rejects.toThrow("task_deliverable_unavailable")
    await expect(executeRun(resume(root, run.run_id), { ...context, operation: "resume" })).rejects.toThrow("task_deliverable_unavailable")
    expect(calls).toBe(2)
    const blocked = loadRun(root, run.run_id)!
    expect(blocked.global_attempts).toBe(2)
    expect(blocked.nodes.check!.current_attempt).toBe(0)
    expect(blocked.phase).toBe("task-prerequisite")
  } finally { removeProject(root) }
})

test("existing-file drift reopens only the checker and its descendants", async () => {
  const root = tempProject()
  try {
    const run = fixture(root, { tail: true })
    const calls: string[] = []
    const sessionRunner = async ({ agent, title }: NodePromptOpts) => {
      calls.push(agent)
      if (agent === "implementer") writeFileSync(join(root, "result.json"), "original")
      if (agent === "researcher" && calls.filter(role => role === agent).length === 1) writeFileSync(join(root, "result.json"), "changed")
      return { session_id: title, text: "", parsed: agent === "implementer" ? implemented : agent === "checker" ? checked : research }
    }
    const context = { ...executeContext(root), sessionRunner }
    await executeRun(run, context)
    expect(run.phase).toBe("task-evidence")
    expect(run.nodes.implement!.status).toBe("done")
    expect(run.nodes.check!.status).toBe("pending")
    expect(run.nodes.tail!.status).toBe("pending")
    const original = run.nodes.check!.attempts[0]!.task_evidence_ref
    const recovered = await executeRun(resume(root, run.run_id), { ...context, operation: "resume" })
    expect(recovered.status).toBe("done")
    expect(calls).toEqual(["implementer", "checker", "researcher", "checker", "researcher"])
    expect(recovered.nodes.check!.attempts[0]!.task_evidence_ref).toEqual(original!)
    expect(recovered.nodes.check!.attempts[1]!.task_evidence_ref?.sha256).not.toBe(original?.sha256)
  } finally { removeProject(root) }
})

test.each([true, false])("same-command cwd/timeout repair requires an actual setup failure (%s)", async setup_failed => {
  const root = tempProject()
  try {
    mkdirSync(join(root, "repaired"))
    const run = fixture(root, { execution: "shell_gate" })
    const roles: string[] = []
    const sessionRunner = async ({ agent, title }: NodePromptOpts) => {
      roles.push(agent)
      if (agent === "implementer") writeFileSync(join(root, "result.json"), "stable")
      return { session_id: title, text: "", parsed: agent === "implementer" ? implemented : checked }
    }
    const context = { ...executeContext(root), sessionRunner }
    await executeRun(run, { ...context, maxWaves: 1, shellRunner: async () => ({
      ok: false, exit_code: 1, setup_failed, timed_out: false, cwd: root, stdout_tail: "", stderr_tail: "",
    }) })
    const repair = { ...context, operation: "resume" as const, shellGateCwd: "repaired", shellGateTimeoutMs: 2000,
      shellRunner: async (options: { cmd: string; cwd?: string; timeoutMs?: number }) => {
        expect(options).toMatchObject({ cmd: "echo original", cwd: "repaired", timeoutMs: 2000 })
        return { ok: true, exit_code: 0, timed_out: false, cwd: join(root, "repaired"), stdout_tail: "", stderr_tail: "" }
      } }
    await expect(executeRun(resume(root, run.run_id), { ...repair, shellGateCmd: "echo replacement" })).rejects.toThrow("task_contract_locked")
    if (!setup_failed) {
      await expect(executeRun(resume(root, run.run_id), { ...repair, shellGateCmd: "echo original" })).rejects.toThrow("setup-failure receipt")
      expect(roles).toEqual(["implementer"])
      expect(loadRun(root, run.run_id)!.global_attempts).toBe(1)
      return
    }
    const admitted = resume(root, run.run_id)
    admitted.graph = withShellGate(admitted.graph, "echo original", 2000, "repaired")
    const recovered = await executeRun(admitted, { ...repair, shellGateCmd: "echo original" })
    expect(recovered.status).toBe("done")
    expect(roles).toEqual(["implementer", "checker"])
    expect(recovered.graph.nodes[0]!.shell_gate).toEqual({ cmd: "echo original", cwd: ".", timeout_ms: 1000 })
    expect(recovered.nodes.implement!.attempts[1]!.reused_output_from).toBe(1)
  } finally { removeProject(root) }
})


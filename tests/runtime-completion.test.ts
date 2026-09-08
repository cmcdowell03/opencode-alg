import { expect, test } from "bun:test"
import { mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { createRun, loadRun, persistRun, hydrateRunFully } from "../src/store.ts"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { resolveInputValue, validateGraph } from "../src/graph.ts"
import { PersistedFailureListSchema } from "../src/schemas.ts"
import { safeDiagnosticText } from "../src/diagnostics.ts"
import { createAlgTools } from "../src/tools.ts"
import { executeContext, tempProject, removeProject, singleImplementGraph } from "./helpers.ts"

const output = { summary: ["complete"], files_touched: [], commands_run: [], risks: [], done: true }
function newRun(project: string, graph = singleImplementGraph({ maxAttempts: 2 })) {
  return createRun({ goal: "synthetic runtime regression", criteria: ["complete"], graph,
    projectDirectory: project, ownerSessionId: "session-owner" })
}
function disk(project: string, id: string) { return hydrateRunFully(loadRun(project, id)!) }

test("creation validates execution directory before writes and pins it in the initial commit", () => {
  const project = tempProject(), outside = tempProject()
  try {
    const options = { goal: "synthetic initial directory", criteria: ["complete"], graph: singleImplementGraph(), projectDirectory: project, ownerSessionId: "session-owner" }
    expect(() => createRun({ ...options, executionDirectory: outside })).toThrow()
    expect(existsSync(join(project, ".opencode"))).toBe(false)
    const subdir = join(project, "child")
    mkdirSync(subdir)
    const created = createRun({ ...options, executionDirectory: subdir })
    expect(loadRun(project, created.run_id)!.execution_directory).toBe(subdir)
  } finally { removeProject(project); removeProject(outside) }
})

test("plan and status expose the persisted child and relative-gate base", async () => {
  const project = tempProject()
  try {
    const directory = join(project, "subdir")
    mkdirSync(directory)
    const tools = createAlgTools({ client: executeContext(project).client, project: { id: "synthetic" },
      directory, worktree: project } as never)
    const context = { ...executeContext(project).toolContext, sessionID: "session-owner", messageID: "message",
      agent: "orchestrator", directory, worktree: project, metadata: () => {} } as never
    const decode = (result: unknown) => JSON.parse((result as { output: string }).output)
    const plan = decode(await tools.alg_plan.execute({ goal: "cwd", graph_json: JSON.stringify({
      name: "shell-cwd", max_global_attempts: 1, max_concurrency: 1,
      nodes: [{ id: "gate", agent: "shell", depends_on: [], shell_gate: { cmd: "synthetic", cwd: "." } }],
    }) }, context))
    expect(plan.execution_directory).toBe(directory)
    expect(plan.shell_gate_base).toBe(directory)
    const status = decode(await tools.alg_status.execute({ run_id: plan.run_id }, context))
    expect(status.execution_directory).toBe(directory)
    expect(status.shell_gate_base).toBe(directory)
    const run = disk(project, plan.run_id)
    await executeRun(run, { ...executeContext(project), shellRunner: async (opts) => {
      expect(opts.context.directory).toBe(directory)
      expect(opts.cwd).toBe(".")
      return { cwd: directory, exit_code: 0, ok: true, stdout_tail: "", stderr_tail: "" }
    } })
    expect(disk(project, plan.run_id).status).toBe("done")
  } finally { removeProject(project) }
}, 120_000)

test("feedback cancellation preserves successful history and exhausted consumers prevent reopening", async () => {
  for (const exhausted of [false, true]) {
    const project = tempProject()
    try {
      const controller = new AbortController()
      const run = newRun(project, { name: "feedback", max_concurrency: 2, max_global_attempts: 6, nodes: [
        { id: "work", agent: "implementer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } },
        ...(exhausted ? [{ id: "consumer", agent: "implementer" as const, depends_on: ["work"] }] : []),
        { id: "check", agent: "checker", depends_on: ["work"], feedback_to: "work", loop: { max_attempts: 2, gate: "schema" } },
      ] })
      await executeRun(run, { ...executeContext(project, controller.signal), sessionRunner: async (opts) => {
        if (opts.agent === "checker") { controller.abort(); return { session_id: "", text: "",
          parsed: { passed: false, score: 2, failures: ["synthetic missing criterion"] } } }
        return { session_id: "", text: "", parsed: output }
      } })
      const restored = disk(project, run.run_id)
      expect(restored.nodes.work!.attempts[0]!.status).toBe("done")
      expect(restored.nodes.work!.status).toBe(exhausted ? "done" : "pending")
      expect(restored.status).toBe(exhausted ? "failed" : "blocked")
      if (!exhausted) {
        await executeRun(restored, { ...executeContext(project), sessionRunner: async (opts) => ({ session_id: "", text: "",
          parsed: opts.agent === "checker" ? { passed: true, score: 8, failures: [] } : output }) })
        expect(disk(project, run.run_id).status).toBe("done")
      }
    } finally { removeProject(project) }
  }
}, 120_000)

test("checker retries receive schema failure context and explicit score contract", async () => {
  const project = tempProject()
  try {
    const run = newRun(project, { name: "checker-retry", max_concurrency: 1, max_global_attempts: 2,
      nodes: [{ id: "check", agent: "checker", depends_on: [], loop: { max_attempts: 2, gate: "schema" } }] })
    const prompts: string[] = []
    await executeRun(run, { ...executeContext(project), sessionRunner: async (opts) => {
      prompts.push(opts.userPrompt)
      return { session_id: "", text: "", parsed: { passed: true, score: prompts.length === 1 ? 2 : 8, failures: [] } }
    } })
    expect(prompts[1]).toContain("PRIOR ATTEMPT VALIDATION/GATE FAILURES")
    expect(prompts[1]).toContain("schema:")
    expect(prompts[1]).toContain("passed must equal (score >= 7)")
    expect(disk(project, run.run_id).status).toBe("done")
  } finally { removeProject(project) }
}, 120_000)

test("session sidecar persistence failure is not classified or retried as worker work", async () => {
  const project = tempProject()
  try {
    const run = newRun(project)
    let prompts = 0
    await expect(executeRun(run, { ...executeContext(project),
      client: { session: { create: async () => ({ data: { id: "synthetic-child" } }),
        prompt: async () => { prompts++; throw new Error("must not prompt") } } } as never,
      afterSessionSidecar: () => { throw new Error("synthetic persistence boundary") },
    })).rejects.toThrow("persistence boundary")
    const restored = disk(project, run.run_id)
    expect(prompts).toBe(0)
    expect(restored.global_attempts).toBe(1)
    expect(restored.nodes.work!.attempts[0]!.status).toBe("running")
    expect(restored.nodes.work!.attempts[0]!.outcome).toBeUndefined()
  } finally { removeProject(project) }
}, 120_000)

test("diagnostics canonicalize whitespace, redaction, Unicode and truncation", () => {
  for (const raw of ["", "  ", "failure\n", "failure\r\n  ", "password=synthetic-secret\n", "界".repeat(3000)]) {
    const diagnostic = safeDiagnosticText(raw)
    expect(PersistedFailureListSchema.safeParse([diagnostic]).success).toBe(true)
    expect(diagnostic).not.toContain("synthetic-secret")
  }
})

test("JSON literals and safe references agree with graph validation", () => {
  const project = tempProject()
  try {
    const run = newRun(project)
    run.nodes.work!.output = { field: "value" }
    for (const value of ["file.xlsx", 1.25, "https://example.test/a.b", { key: "x.y" }, ["a.b"], true, null]) {
      const expr = JSON.stringify(value)
      validateGraph({ ...run.graph, nodes: [{ ...run.graph.nodes[0], inputs: { literal: expr } }] })
      expect(resolveInputValue(expr, run)).toEqual(value)
    }
    expect(resolveInputValue("work.field", run)).toBe("value")
    expect(resolveInputValue("work", run)).toEqual({ field: "value" })
    for (const expr of ["work.__proto__", "work.constructor", "work.prototype", "work..field"]) {
      expect(() => validateGraph({ ...run.graph, nodes: [run.graph.nodes[0],
        { id: "check", agent: "checker", depends_on: ["work"], inputs: { claimed: expr } }] })).toThrow()
    }
  } finally { removeProject(project) }
})

test("shell failure survives save/load/resume with canonical stderr diagnostics", async () => {
  const project = tempProject()
  try {
    const run = newRun(project, { name: "shell", max_concurrency: 1, max_global_attempts: 2, nodes: [
      { id: "gate", agent: "shell", depends_on: [], shell_gate: { cmd: "synthetic" }, loop: { max_attempts: 2, gate: "shell" } },
    ] })
    await executeRun(run, { ...executeContext(project), maxWaves: 1, shellRunner: async () => ({
      cwd: project, exit_code: 1, ok: false, stdout_tail: "", stderr_tail: "synthetic failure\r\n  ",
    }) })
    const restored = disk(project, run.run_id)
    expect(restored.nodes.gate!.attempts[0]!.outcome).toBe("gate_failure")
    expect(restored.nodes.gate!.attempts[0]!.failures[0]).toBe("shell gate failed (exit 1): synthetic failure")
    await executeRun(prepareRunForResume(restored), { ...executeContext(project), shellRunner: async () => ({
      cwd: project, exit_code: 0, ok: true, stdout_tail: "", stderr_tail: "",
    }) })
    expect(disk(project, run.run_id).status).toBe("done")
  } finally { removeProject(project) }
}, 120_000)

test("rejected workers retry; observer exceptions cannot rewrite DONE", async () => {
  const project = tempProject()
  try {
    const run = newRun(project)
    let calls = 0
    await executeRun(run, { ...executeContext(project), onEvent: () => { throw new Error("observer") },
      sessionRunner: async () => { if (++calls === 1) throw new Error("synthetic SDK error\n")
        return { session_id: "", text: "", parsed: output } },
    })
    const restored = disk(project, run.run_id)
    expect(restored.status).toBe("done")
    expect(restored.nodes.work!.attempts[0]!.outcome).toBe("sdk_error")
    expect(restored.global_attempts).toBe(2)
  } finally { removeProject(project) }
}, 120_000)

test("failed branch with unfinished independent work is durably blocked", async () => {
  const project = tempProject()
  try {
    const run = newRun(project, { name: "branches", max_concurrency: 2, max_global_attempts: 3, nodes: [
      { id: "bad", agent: "implementer", depends_on: [] },
      { id: "good", agent: "implementer", depends_on: [] },
      { id: "later", agent: "implementer", depends_on: ["good"] },
    ] })
    await executeRun(run, { ...executeContext(project), maxWaves: 1, sessionRunner: async (opts) => ({
      session_id: "", text: "", parsed: opts.title.includes("/bad/") ? {} : output,
    }) })
    const restored = disk(project, run.run_id)
    expect(restored.status).toBe("blocked")
    expect(restored.nodes.later!.current_attempt).toBe(0)
    await executeRun(restored, { ...executeContext(project), sessionRunner: async () => ({ session_id: "", text: "", parsed: output }) })
    expect(disk(project, run.run_id).status).toBe("failed")
  } finally { removeProject(project) }
}, 120_000)

test("cancellation between batches reserves no later work and remains resumable", async () => {
  const project = tempProject()
  try {
    const controller = new AbortController()
    const run = newRun(project, { name: "cancel", max_concurrency: 1, max_global_attempts: 2, nodes:
      ["a", "b"].map((id) => ({ id, agent: "implementer", depends_on: [] })) })
    await executeRun(run, { ...executeContext(project, controller.signal), sessionRunner: async () => {
      controller.abort(); return { session_id: "", text: "", parsed: output }
    } })
    const restored = disk(project, run.run_id)
    expect(restored.status).toBe("blocked")
    expect(restored.nodes.a!.status).toBe("done")
    expect(restored.nodes.b!.current_attempt).toBe(0)
    await executeRun(restored, { ...executeContext(project), sessionRunner: async () => ({ session_id: "", text: "", parsed: output }) })
    expect(disk(project, run.run_id).status).toBe("done")
  } finally { removeProject(project) }
}, 120_000)

test("execution cwd remains pinned across subdirectory resumes; legacy uses project root", async () => {
  const project = tempProject()
  try {
    const first = join(project, "first"), second = join(project, "second")
    mkdirSync(first); mkdirSync(second)
    for (const pinned of [first, undefined]) {
      const run = newRun(project)
      run.execution_directory = pinned
      persistRun(run, project)
      const directories: string[] = []
      const runner = async (opts: { directory: string }) => {
        directories.push(opts.directory); return { session_id: "", text: "", parsed: {} }
      }
      await executeRun(run, { ...executeContext(project), directory: first, maxWaves: 1, sessionRunner: runner })
      await executeRun(disk(project, run.run_id), { ...executeContext(project), directory: second, sessionRunner: runner })
      expect(directories).toEqual([pinned ?? project, pinned ?? project])
      expect(disk(project, run.run_id).execution_directory).toBe(pinned ?? project)
    }
    const escaped = newRun(project)
    escaped.execution_directory = join(project, "..")
    await expect(executeRun(escaped, executeContext(project))).rejects.toThrow()
  } finally { removeProject(project) }
}, 120_000)

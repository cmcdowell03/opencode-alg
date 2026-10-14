import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { gateCommandExists, inspectGateCommand, preflightShellGates } from "../src/shell-preflight.ts"
import { createAlgTools, withShellGate } from "../src/tools.ts"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { createRun, hydrateRunFully, loadRun, persistRun, runDir } from "../src/store.ts"
import { prospectiveShellGateHash } from "../src/session-memory/preflight.ts"
import { executeContext, inertClient, removeProject, singleImplementGraph, tempProject } from "./helpers.ts"
import type { GraphDef } from "../src/types.ts"

const implemented = { summary: ["complete"], files_touched: [], commands_run: [], risks: [], done: true }
const inspect = (cmd: string, platform: NodeJS.Platform = "win32", available = true) =>
  inspectGateCommand(cmd, { platform, phase: "execute", commandExists: () => available })
const errors = (cmd: string, platform: NodeJS.Platform = "win32", available = true) =>
  inspect(cmd, platform, available).filter((issue) => issue.severity === "error").map((issue) => issue.code)
const decode = (value: unknown) => JSON.parse((value as { output: string }).output)

function setup(project: string, directory = project) {
  return {
    tools: createAlgTools({ client: inertClient(), project: { id: "synthetic" }, directory, worktree: project } as never),
    context: { ...executeContext(project).toolContext, sessionID: "session-owner", messageID: "message",
      agent: "orchestrator", directory, worktree: project, metadata: () => {} } as never,
  }
}

describe("read-only shell command preflight", () => {
  for (const [cmd, code] of [
    [" ", "command_required"], ["echo \0", "command_not_text"], ["x".repeat(8193), "command_too_long"],
    ["```cmd\necho ok\n```", "prose_or_markdown"], ["Allowed tools: bash | edit | {read}", "prose_or_markdown"],
    ["Run the tests and then summarize the result", "prose_or_markdown"],
    ["| echo ok", "missing_pipeline_command"], ["echo ok |", "missing_pipeline_command"],
    ["echo ok &&", "missing_pipeline_command"], ["echo ok | | echo bad", "missing_pipeline_command"],
  ] as const) test(`rejects ${code}: ${cmd.slice(0, 35)}`, () => expect(errors(cmd)).toContain(code))

  for (const cmd of [
    'python -m pytest tests/unit', 'echo "a | {b} & c"', 'node -e "console.log(1 > 0)"',
    'echo ok | findstr ok', 'echo ok && echo done', '"C:\\Program Files\\Node\\node.exe" -v',
    'echo ok > result.txt 2>&1', 'if exist tests (echo ok)', 'cmd /c "echo ok | echo done"',
    'cd /d "C:\\Repo With Spaces" && python -m pytest tests/unit',
    'echo ^| escaped', 'echo ok\r\necho done', 'echo ok &', 'echo "unterminated',
    'missing-tool || echo fallback',
  ]) test(`preserves Windows command syntax: ${cmd}`, () => expect(errors(cmd)).toEqual([]))

  test("missing tools use the actual shell and PATH, not a POSIX blacklist", () => {
    expect(errors("echo ok | tail -n 1", "win32", false)).toEqual(["posix_command_unavailable"])
    expect(errors("tail -n 1 file", "win32", true)).toEqual([])
    expect(errors("tail -n 1 file", "linux", true)).toEqual([])
    expect(errors("Get-Content file", "win32", false)).toEqual(["command_not_found"])
    expect(inspectGateCommand("missing-tool", { platform: "win32", phase: "plan", commandExists: () => false }))
      .toEqual([{ code: "command_not_found", severity: "warning", command: 1 }])
    expect(errors("missing-tool || echo fallback", "win32", false)).toEqual([])
    expect(errors("'echo' 'a | b' ; printf '%s' ok", "linux", false)).toEqual([])
  })

  test("bounded and conservative for scripts, dynamic commands and directory changes", () => {
    for (const cmd of ["%MY_TEST_COMMAND%", "set PATH=C:\\custom && custom", "path C:\\custom && custom", "cd /d repo && custom",
      "call script.cmd && custom", "echo ok " + "&& echo ok ".repeat(100)]) {
      const issues = inspect(cmd, "win32", false)
      expect(issues.some((issue) => issue.severity === "warning")).toBe(true)
      expect(issues.some((issue) => issue.severity === "error")).toBe(false)
    }
    expect(inspect("echo ok # comment | missing", "linux", false)[0]!.code).toBe("complex_command_review")
    expect(errors(". setup.sh && custom", "linux", false)).toEqual([])
    expect(errors("source setup.sh && custom", "linux", false)).toEqual([])
  })

  test("executable lookup reads files only, honors PATHEXT, and never invokes a command", () => {
    const project = tempProject()
    try {
      if (process.platform === "win32") {
        writeFileSync(join(project, "alg-test.cmd"), "@echo must never execute > executed.txt")
        expect(gateCommandExists("alg-test", project, { PATH: "", PATHEXT: ".CMD" })).toBe(true)
        expect(gateCommandExists("alg-test", project, { PATH: "", PATHEXT: ".EXE" })).toBe(false)
        expect(existsSync(join(project, "executed.txt"))).toBe(false)
      }
      mkdirSync(join(project, "not-an-executable.exe"))
      expect(gateCommandExists("not-an-executable.exe", project, { PATH: project })).toBe(false)
      expect(gateCommandExists("alg-uninstalled-test-tool", project, { PATH: project })).toBe(false)
    } finally { removeProject(project) }
  })
})

test("plan rejects malformed gates before persistence, and reports explicit nested cwd", async () => {
  const project = tempProject()
  try {
    const nested = join(project, "repo with spaces")
    mkdirSync(nested)
    const { tools, context } = setup(project)
    for (const args of [
      { shell_gate: "Allowed tools: bash | edit | {read}" },
      { shell_gate: "echo ok |" },
      { shell_gate: "echo ok", shell_cwd: "missing" },
      { shell_cwd: "repo with spaces" },
    ]) {
      const result = decode(await tools.alg_plan.execute({ goal: "preflight", ...args }, context))
      expect(result.error).toBeDefined()
      expect(existsSync(join(project, ".opencode"))).toBe(false)
    }
    const plan = decode(await tools.alg_plan.execute({ goal: "cwd", shell_gate: "echo ok", shell_cwd: "repo with spaces" }, context))
    expect(plan.shell_gate_preflight.gates[0].cwd).toBe(nested)
    expect(plan.shell_gate_preflight.gates[0].diagnostics).toEqual([])
    const stored = loadRun(project, plan.run_id)!
    expect(stored.graph.nodes.find((node) => node.agent === "implementer")!.shell_gate!.cwd).toBe("repo with spaces")
    const hash = prospectiveShellGateHash(stored)
    expect(prospectiveShellGateHash(stored, { shellGateCmd: "echo ok", shellGateCwd: "." })).not.toBe(hash)
  } finally { removeProject(project) }
})

test("custom graphs are checked; directory escape is rejected; future test files are not required", () => {
  const project = tempProject(), outside = tempProject()
  try {
    const graph: GraphDef = { name: "shell", max_global_attempts: 1, max_concurrency: 1,
      nodes: [{ id: "gate", agent: "shell", depends_on: [], shell_gate: { cmd: "echo tests/not-created-yet" } }] }
    const options = { worktree: project, directory: project, phase: "plan" as const, checkExecutables: true }
    expect(preflightShellGates(graph, options)[0]!.diagnostics).toContainEqual({ code: "implicit_cwd", severity: "warning" })
    graph.nodes[0]!.shell_gate!.cwd = outside
    expect(() => preflightShellGates(graph, options)).toThrow("invalid_cwd")
    graph.nodes[0]!.shell_gate = { cmd: "echo ok |", cwd: "." }
    expect(() => preflightShellGates(graph, options)).toThrow("missing_pipeline_command")
  } finally { removeProject(project); removeProject(outside) }
})

test("legacy missing command blocks before any child or counter and does not echo arguments", async () => {
  const project = tempProject()
  try {
    const run = createRun({ goal: "legacy", criteria: ["done"],
      graph: withShellGate(singleImplementGraph({ maxAttempts: 5 }), "alg-uninstalled-test-tool --password=synthetic-secret"),
      projectDirectory: project, ownerSessionId: "session-owner" })
    const progress = join(runDir(project, run.run_id), "progress.json")
    const before = readFileSync(progress, "utf8")
    let calls = 0
    try {
      await executeRun(run, { ...executeContext(project), sessionRunner: async () => {
        calls++; return { session_id: "", text: "", parsed: implemented }
      } })
      throw new Error("expected preflight rejection")
    } catch (error) {
      expect(String(error)).toContain("command_not_found")
      expect(String(error)).not.toContain("synthetic-secret")
      expect(String(error)).toContain("cwd=")
    }
    expect(calls).toBe(0)
    expect(run.global_attempts).toBe(0)
    expect(readFileSync(progress, "utf8")).toBe(before)
  } finally { removeProject(project) }
}, 60_000)

test("corrected gate resumes with completed sibling intact and no budget reset", async () => {
  const project = tempProject()
  try {
    const graph: GraphDef = { name: "recovery", max_global_attempts: 3, max_concurrency: 1, nodes: [
      { id: "explore", agent: "explorer", depends_on: [] },
      { id: "work", agent: "implementer", depends_on: ["explore"], shell_gate: { cmd: "echo ok" }, loop: { gate: "all", max_attempts: 2 } },
    ] }
    const run = createRun({ goal: "recovery", criteria: ["done"], graph, projectDirectory: project, ownerSessionId: "session-owner" })
    await executeRun(run, { ...executeContext(project), maxWaves: 1, sessionRunner: async () => ({ session_id: "", text: "",
      parsed: { query: "q", map: [{ path: "src", role: "source" }], key_hits: [], next: "implementer" } }) })
    expect(run.nodes.explore!.status).toBe("done")
    const explored = JSON.parse(JSON.stringify(run.nodes.explore))
    run.graph.nodes[1]!.shell_gate!.cmd = "Allowed tools: bash | edit"
    persistRun(run, project)
    const before = run.global_attempts
    await expect(executeRun(prepareRunForResume(run), executeContext(project))).rejects.toThrow("prose_or_markdown")
    expect(loadRun(project, run.run_id)!.global_attempts).toBe(before)
    run.graph = withShellGate(run.graph, "echo repaired", undefined, ".")
    let calls = 0
    await executeRun(run, { ...executeContext(project), sessionRunner: async (options) => {
      calls++; expect(options.agent).toBe("implementer")
      return { session_id: "", text: "", parsed: implemented }
    }, shellRunner: async () => ({ ok: true, exit_code: 0, cwd: project, stdout_tail: "ok", stderr_tail: "" }) })
    expect(calls).toBe(1)
    expect(run.status).toBe("done")
    expect(run.global_attempts).toBe(before + 1)
    expect(JSON.parse(JSON.stringify(run.nodes.explore))).toEqual(explored)
  } finally { removeProject(project) }
}, 60_000)

test("real failing tests still retry; stdout-only failures retain safe shell and cwd diagnostics", async () => {
  const project = tempProject()
  try {
    const run = createRun({ goal: "test failure", criteria: ["done"], graph: withShellGate(singleImplementGraph({ maxAttempts: 2 }), "echo ok"),
      projectDirectory: project, ownerSessionId: "session-owner" })
    let shells = 0, children = 0
    await executeRun(run, { ...executeContext(project), sessionRunner: async () => {
      children++; return { session_id: "", text: "", parsed: implemented }
    }, shellRunner: async () => ({ ok: ++shells === 2, exit_code: shells === 1 ? 255 : 0, cwd: project,
      stdout_tail: "test assertion failed; password=" + "synthetic-secret".repeat(100), stderr_tail: "" }) })
    const history = hydrateRunFully(loadRun(project, run.run_id)!).nodes.work!.attempts
    expect(children).toBe(2)
    expect(run.status).toBe("done")
    expect(history[0]!.outcome).toBe("gate_failure")
    expect(history[0]!.failures[0]).toContain("test assertion failed")
    expect(history[0]!.failures[0]).toContain("output=stdout")
    expect(history[0]!.failures[0]).toContain("cwd=")
    expect(history[0]!.failures[0]).not.toContain("synthetic-secret")
  } finally { removeProject(project) }
}, 60_000)

test("public run and resume repair shell_cwd relative to pinned directory, not current UI directory", async () => {
  const project = tempProject()
  try {
    for (const path of ["pinned", "pinned/repo", "elsewhere"]) mkdirSync(join(project, path), { recursive: true })
    const { tools, context } = setup(project, join(project, "pinned"))
    const plan = decode(await tools.alg_plan.execute({ goal: "repair", mode: "dry", shell_gate: "echo ok" }, context))
    const moved = { ...(context as any), directory: join(project, "elsewhere") }
    const result = decode(await tools.alg_run.execute({ run_id: plan.run_id, dry: true, shell_gate: "echo run", shell_cwd: "repo", max_waves: 1 }, moved))
    expect(result.error).toBeUndefined()
    const resumed = decode(await tools.alg_resume.execute({ run_id: plan.run_id, dry: true, shell_gate: "echo resume", shell_cwd: "." }, moved))
    expect(resumed.error).toBeUndefined()
    const stored = loadRun(project, plan.run_id)!
    expect(stored.execution_directory).toBe(join(project, "pinned"))
    expect(stored.graph.nodes.find((node) => node.agent === "implementer")!.shell_gate!.cwd).toBe(".")
    for (const name of ["alg_run", "alg_resume"] as const) {
      expect(decode(await tools[name].execute({ run_id: plan.run_id, shell_cwd: "repo" }, moved)).error).toBe("shell_cwd requires shell_gate")
    }
  } finally { removeProject(project) }
}, 60_000)

test("empty-output and timeout failures report their limits without guessing a parser defect", async () => {
  const project = tempProject()
  try {
    for (const timedOut of [false, true]) {
      const run = createRun({ goal: "empty diagnostics", criteria: [], graph: { name: "empty-gate", max_global_attempts: 1, max_concurrency: 1,
        nodes: [{ id: "gate", agent: "shell", depends_on: [], shell_gate: { cmd: "echo test" } }] },
        projectDirectory: project, ownerSessionId: "session-owner" })
      await executeRun(run, { ...executeContext(project), shellRunner: async () => ({ ok: false,
        exit_code: timedOut ? 124 : 255, timed_out: timedOut, cwd: project, stdout_tail: "", stderr_tail: "" }) })
      const failure = hydrateRunFully(loadRun(project, run.run_id)!).nodes.gate!.attempts[0]!.failures[0]!
      expect(failure).toContain("No output captured")
      expect(failure).toContain("output=none")
      expect(failure).toContain(timedOut ? "category=timeout" : "category=nonzero_exit")
    }
  } finally { removeProject(project) }
}, 60_000)

test("actual local gate runs in an explicit repository directory with spaces", async () => {
  const project = tempProject()
  try {
    mkdirSync(join(project, "nested repo"))
    writeFileSync(join(project, "nested repo", "marker"), "synthetic")
    const command = `"${process.execPath}" -e "process.exit(require('node:fs').existsSync('marker')?0:1)"`
    const run = createRun({ goal: "real cwd", criteria: [], graph: { name: "real-shell", max_global_attempts: 1, max_concurrency: 1,
      nodes: [{ id: "gate", agent: "shell", depends_on: [], shell_gate: { cmd: command, cwd: "nested repo" } }] },
      projectDirectory: project, ownerSessionId: "session-owner" })
    // Native Windows helper lifecycle tests require a cold per-process cache.
    // Exercise the real runner in its own process rather than warming their cache.
    const script = `
      const { executeRun } = await import(${JSON.stringify(new URL("../src/executor.ts", import.meta.url).href)});
      const { loadRun } = await import(${JSON.stringify(new URL("../src/store.ts", import.meta.url).href)});
      const { executeContext } = await import(${JSON.stringify(new URL("./helpers.ts", import.meta.url).href)});
      const project = ${JSON.stringify(project)};
      const run = loadRun(project, ${JSON.stringify(run.run_id)});
      await executeRun(run, executeContext(project));
      if (run.status !== "done") throw new Error(JSON.stringify(run.nodes.gate.last_failures));
    `
    const child = spawnSync(process.execPath, ["-e", script], { cwd: project, encoding: "utf8", timeout: 30_000, windowsHide: true })
    expect(child.stderr).toBe("")
    expect(child.status).toBe(0)
    const completed = hydrateRunFully(loadRun(project, run.run_id)!)
    expect(completed.nodes.gate!.last_failures).toEqual([])
    expect(completed.status).toBe("done")
  } finally { removeProject(project) }
}, 120_000)

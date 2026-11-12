import { describe, expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { createRun, loadRun, persistRun } from "../src/store.ts"
import type { ExecutionEvidence } from "../src/execution-evidence.ts"
import { executeContext, tempProject, removeProject } from "./helpers.ts"

function fixture(project: string, preservePaths?: string[]) {
  writeFileSync(join(project, "work.txt"), "verified candidate")
  return createRun({ goal: "keep verified work", criteria: ["test passes"],
    projectDirectory: project, ownerSessionId: "session-owner", graph: {
      name: "setup-recovery", max_global_attempts: 5, max_concurrency: 1, nodes: [
        { id: "work", agent: "implementer", depends_on: [], shell_gate: { cmd: "test-fixture" }, loop: { gate: "all", max_attempts: 3 },
          ...(preservePaths ? { inputs: { preserve_paths: JSON.stringify(preservePaths) } } : {}) },
        { id: "check", agent: "checker", depends_on: ["work"], inputs: { claimed: "work" }, loop: { gate: "schema", max_attempts: 2 } },
      ],
    } })
}
const output = { summary: ["done"], files_touched: ["work.txt"], commands_run: [], risks: [], done: true }
const session = async (opts: { agent: string }) => ({ session_id: "child", text: "", parsed: opts.agent === "checker"
  ? { passed: true, score: 10, failures: [] } : output })

describe("gate setup recovery", () => {
  test("runtime setup failure reserves no model or shell attempt and releases preparation", async () => {
    const project = tempProject()
    try {
      const run = fixture(project)
      let calls = 0, released = 0
      await expect(executeRun(run, { ...executeContext(project), sessionRunner: async opts => { calls++; return session(opts) },
        shellRunner: async () => { throw new Error("must not launch") },
        shellPreparer: async () => ({ ok: false, setup_failed: true, stdout_tail: "", stderr_tail: "compiler unavailable",
          release: () => { released++ } }),
      })).rejects.toThrow("before reserving model work")
      expect(calls).toBe(0)
      expect(released).toBe(1)
      expect(loadRun(project, run.run_id)!.global_attempts).toBe(0)
    } finally { removeProject(project) }
  })

  test("native shell gate receipts reach the checker on this platform", async () => {
    const project = tempProject()
    try {
      const run = fixture(project)
      run.graph.nodes[0]!.shell_gate!.cmd = 'node -e "console.log(\'ALG_GATE_OK\')"'
      // Create with the real gate identity instead of mutating persisted graph state.
      const actual = createRun({ goal: "native gate receipt", criteria: ["test passes"], graph: run.graph,
        projectDirectory: project, ownerSessionId: "session-owner" })
      let observed = false
      await executeRun(actual, { ...executeContext(project), sessionRunner: async opts => {
        if (opts.agent === "checker") {
          expect(opts.userPrompt).toContain("ALG_GATE_OK")
          expect(opts.userPrompt).toContain('"exit_code":0')
          expect(opts.userPrompt).toContain("host_execution")
          observed = true
        }
        return session(opts)
      } })
      expect(observed).toBe(true)
      expect(actual.status).toBe("done")
      expect(loadRun(project, actual.run_id)!.nodes.work!.attempts[0]!.gate_evidence?.commands[0]?.exit_code).toBe(0)
    } finally { removeProject(project) }
  }, 120_000)

  test("setup failure stops retries; persisted explicit resume only reruns gate before checker", async () => {
    const project = tempProject()
    try {
      const run = fixture(project)
      let models = 0, gates = 0
      const options = { ...executeContext(project), sessionRunner: async (opts: any) => { models++; return session(opts) },
        shellRunner: async () => { gates++; return { cwd: project, ok: false, exit_code: 125,
          stdout_tail: "", stderr_tail: "setup unavailable", setup_failed: true } } }
      await executeRun(run, options)
      expect(run.status).toBe("blocked")
      expect(models).toBe(1)
      expect(gates).toBe(1)
      expect(run.nodes.work!.attempts[0]!.shell_setup_failed).toBe(true)
      expect(run.nodes.work!.attempts[0]!.gate_recovery).toBeDefined()
      const loaded = prepareRunForResume(loadRun(project, run.run_id)!)
      await executeRun(loaded, { ...options, operation: "resume", shellRunner: async () => {
        gates++; return { cwd: project, ok: true, exit_code: 0, stdout_tail: "passed", stderr_tail: "" }
      } })
      expect(loaded.status).toBe("done")
      expect(models).toBe(2) // original implementer plus fresh checker, no replacement implementation
      expect(gates).toBe(2)
      expect(loaded.nodes.work!.attempts[1]!.reused_output_from).toBe(1)
      expect(loaded.nodes.work!.attempts[1]!.session_id).toBeUndefined()
      expect(loadRun(project, run.run_id)!.global_attempts).toBe(3)
    } finally { removeProject(project) }
  }, 120_000)

  test("repeated setup failures retain the original native receipt for the fresh checker", async () => {
    const project = tempProject()
    try {
      const run = fixture(project)
      const nativeReceipt: ExecutionEvidence = {
        version: 1, run_id: run.run_id, node_id: "work", attempt: 1, child_session_id: "child",
        retrieval_status: "available", omitted_commands: 0, window_may_be_incomplete: false,
        foreign_messages_omitted: 0, commands: [{ tool: "bash", command: "node original-check.cjs",
          tool_status: "completed", exit_code: 0, exit_code_status: "reported",
          output: "ORIGINAL_NATIVE_VERIFICATION", output_truncated: false,
          command_truncated: false, cwd_truncated: false }],
      }
      const modelRoles: string[] = []
      let gates = 0, checkerPrompt = ""
      const options = { ...executeContext(project),
        sessionRunner: async (opts: { agent: string; userPrompt: string }) => {
          modelRoles.push(opts.agent)
          const result = await session(opts)
          if (opts.agent === "implementer") return { ...result, execution_evidence: nativeReceipt }
          checkerPrompt = opts.userPrompt
          return result
        },
        shellRunner: async () => ++gates < 3
          ? { cwd: project, ok: false, exit_code: 125, stdout_tail: "", stderr_tail: "setup", setup_failed: true }
          : { cwd: project, ok: true, exit_code: 0, stdout_tail: "GATE_RECOVERED", stderr_tail: "" },
      }
      await executeRun(run, options)
      const second = prepareRunForResume(loadRun(project, run.run_id)!)
      await executeRun(second, { ...options, operation: "resume" })
      expect(second.status).toBe("blocked")
      expect(second.nodes.work!.attempts[1]).toMatchObject({ shell_setup_failed: true, reused_output_from: 1 })
      expect(modelRoles).toEqual(["implementer"])

      const third = prepareRunForResume(loadRun(project, run.run_id)!)
      await executeRun(third, { ...options, operation: "resume" })
      expect(third.status).toBe("done")
      expect(modelRoles).toEqual(["implementer", "checker"])
      expect(gates).toBe(3)
      const durable = loadRun(project, run.run_id)!
      expect(durable.global_attempts).toBe(4)
      expect(durable.nodes.work!.attempts[2]!.reused_output_from).toBe(1)
      expect(durable.nodes.work!.attempts[2]!.session_id).toBeUndefined()
      expect(durable.nodes.work!.attempts[2]!.execution_evidence).toEqual(nativeReceipt)
      expect(checkerPrompt).toContain("ORIGINAL_NATIVE_VERIFICATION")
      expect(checkerPrompt).toContain("host_execution_work")
      expect(checkerPrompt).toContain("GATE_RECOVERED")
    } finally { removeProject(project) }
  }, 120_000)

  test.each(["file", "gate", "output"])("changed %s refuses reuse before another attempt is reserved", async kind => {
    const project = tempProject()
    try {
      const run = fixture(project)
      const options = { ...executeContext(project), sessionRunner: session,
        shellRunner: async () => ({ cwd: project, ok: false, exit_code: 125, stdout_tail: "", stderr_tail: "setup", setup_failed: true }) }
      await executeRun(run, options)
      if (kind === "file") writeFileSync(join(project, "work.txt"), "different")
      if (kind === "output") run.nodes.work!.attempts[0]!.output = { ...output, summary: ["different"] }
      await expect(executeRun(run, { ...options, operation: "resume", ...(kind === "gate" ? { shellGateCmd: "different" } : {}) })).rejects.toThrow()
      expect(loadRun(project, run.run_id)!.global_attempts).toBe(1)
    } finally { removeProject(project) }
  }, 120_000)

  test("interrupted running recovery retains its original output source across persisted resume", async () => {
    const project = tempProject()
    try {
      const run = fixture(project)
      const modelRoles: string[] = []
      let gates = 0
      const options = { ...executeContext(project), sessionRunner: async (opts: { agent: string }) => {
        modelRoles.push(opts.agent)
        return session(opts)
      } }
      await executeRun(run, { ...options, shellRunner: async () => {
        gates++
        return { cwd: project, ok: false, exit_code: 125, stdout_tail: "", stderr_tail: "setup unavailable", setup_failed: true }
      } })

      // Model a process stopping after its gate-only reservation was committed,
      // before it could publish an outcome. No child session belongs to this attempt.
      const interrupted = loadRun(project, run.run_id)!
      const source = interrupted.nodes.work!.attempts[0]!
      interrupted.nodes.work!.attempts.push({ attempt: 2, status: "running", started_at: new Date().toISOString(),
        failures: [], reused_output_from: 1, gate_recovery: source.gate_recovery! })
      interrupted.nodes.work!.current_attempt = 2
      interrupted.nodes.work!.status = "running"
      interrupted.global_attempts = 2
      interrupted.status = "running"
      interrupted.phase = "execute"
      persistRun(interrupted, project)

      const resumed = prepareRunForResume(loadRun(project, run.run_id)!)
      expect(resumed.nodes.work!.attempts[1]).toMatchObject({ status: "failed", reused_output_from: 1 })
      expect(resumed.nodes.work!.attempts[1]!.outcome).toBeUndefined()
      await executeRun(resumed, { ...options, operation: "resume", shellRunner: async () => {
        gates++
        return { cwd: project, ok: true, exit_code: 0, stdout_tail: "passed", stderr_tail: "" }
      } })

      const durable = loadRun(project, run.run_id)!
      expect(durable.status).toBe("done")
      expect(modelRoles).toEqual(["implementer", "checker"])
      expect(gates).toBe(2)
      expect(durable.global_attempts).toBe(4)
      expect(durable.nodes.work!.attempts[2]).toMatchObject({ outcome: "passed", reused_output_from: 1, shell_ok: true })
      expect(durable.nodes.work!.attempts[2]!.session_id).toBeUndefined()
      expect(durable.nodes.work!.output).toEqual(output)
      expect(durable.nodes.check!.attempts).toHaveLength(1)
    } finally { removeProject(project) }
  }, 120_000)

  test("interrupted gate call persists recovery intent before launch and never retries the implementer", async () => {
    const project = tempProject()
    try {
      const run = fixture(project)
      const modelRoles: string[] = []
      let gates = 0
      const options = { ...executeContext(project), sessionRunner: async (opts: { agent: string }) => {
        modelRoles.push(opts.agent)
        return session(opts)
      } }
      await executeRun(run, { ...options, shellRunner: async () => {
        gates++
        return { cwd: project, ok: false, exit_code: 125, stdout_tail: "", stderr_tail: "setup unavailable", setup_failed: true }
      } })
      const resumed = prepareRunForResume(loadRun(project, run.run_id)!)
      let observedReservation = false
      await executeRun(resumed, { ...options, operation: "resume", shellRunner: async () => {
        gates++
        const reserved = loadRun(project, run.run_id)!
        const latest = reserved.nodes.work!.attempts.at(-1)!
        expect(latest).toMatchObject({ attempt: 2, status: "running", reused_output_from: 1 })
        expect(latest.gate_recovery).toEqual(reserved.nodes.work!.attempts[0]!.gate_recovery)
        expect(latest.session_id).toBeUndefined()
        observedReservation = true
        throw new Error("synthetic gate interruption")
      } })
      expect(observedReservation).toBe(true)
      expect(resumed.status).toBe("blocked")
      expect(modelRoles).toEqual(["implementer"])
      expect(gates).toBe(2)
      expect(resumed.nodes.work!.attempts).toHaveLength(2)
      expect(resumed.nodes.work!.attempts[1]).toMatchObject({ outcome: "sdk_error", reused_output_from: 1 })

      const recovered = prepareRunForResume(loadRun(project, run.run_id)!)
      await executeRun(recovered, { ...options, operation: "resume", shellRunner: async () => {
        gates++
        return { cwd: project, ok: true, exit_code: 0, stdout_tail: "passed", stderr_tail: "" }
      } })
      expect(recovered.status).toBe("done")
      expect(modelRoles).toEqual(["implementer", "checker"])
      expect(gates).toBe(3)
      expect(recovered.global_attempts).toBe(4)
      expect(recovered.nodes.work!.attempts[2]!.reused_output_from).toBe(1)
      expect(recovered.nodes.work!.attempts[2]!.session_id).toBeUndefined()
    } finally { removeProject(project) }
  }, 120_000)

  test("declared-file drift after admission blocks the invocation and preserves gate-only intent", async () => {
    const project = tempProject()
    try {
      const run = fixture(project)
      const modelRoles: string[] = []
      let gates = 0
      const options = { ...executeContext(project), sessionRunner: async (opts: { agent: string }) => {
        modelRoles.push(opts.agent)
        return session(opts)
      } }
      await executeRun(run, { ...options, shellRunner: async () => {
        gates++
        return { cwd: project, ok: false, exit_code: 125, stdout_tail: "", stderr_tail: "setup unavailable", setup_failed: true }
      } })
      const resumed = prepareRunForResume(loadRun(project, run.run_id)!)
      await executeRun(resumed, { ...options, operation: "resume", beforeBatch: async () => {
        writeFileSync(join(project, "work.txt"), "changed after admission")
      }, shellRunner: async () => {
        gates++
        throw new Error("drift must be detected before gate launch")
      } })
      expect(resumed.status).toBe("blocked")
      expect(modelRoles).toEqual(["implementer"])
      expect(gates).toBe(1)
      expect(resumed.nodes.work!.attempts).toHaveLength(2)
      expect(resumed.nodes.work!.attempts[1]).toMatchObject({ outcome: "sdk_error", reused_output_from: 1 })
      expect(resumed.nodes.work!.attempts[1]!.failures.join("\n")).toContain("basis changed after admission")

      const stillChanged = prepareRunForResume(loadRun(project, run.run_id)!)
      await expect(executeRun(stillChanged, { ...options, operation: "resume", shellRunner: async () => {
        gates++
        throw new Error("changed basis must not launch")
      } })).rejects.toThrow("Gate-only recovery refused")
      expect(loadRun(project, run.run_id)!.global_attempts).toBe(2)
      expect(modelRoles).toEqual(["implementer"])
      expect(gates).toBe(1)

      writeFileSync(join(project, "work.txt"), "verified candidate")
      const recovered = prepareRunForResume(loadRun(project, run.run_id)!)
      await executeRun(recovered, { ...options, operation: "resume", shellRunner: async () => {
        gates++
        return { cwd: project, ok: true, exit_code: 0, stdout_tail: "passed", stderr_tail: "" }
      } })
      expect(recovered.status).toBe("done")
      expect(modelRoles).toEqual(["implementer", "checker"])
      expect(gates).toBe(2)
      expect(recovered.global_attempts).toBe(4)
      expect(recovered.nodes.work!.attempts[2]!.reused_output_from).toBe(1)
    } finally { removeProject(project) }
  }, 120_000)

  test("changed preservation paths refuse recovery without replacing the original basis", async () => {
    const project = tempProject()
    try {
      writeFileSync(join(project, "protected.txt"), "original protected input")
      writeFileSync(join(project, "other.txt"), "different input")
      const run = fixture(project, ["protected.txt"])
      let models = 0, gates = 0
      const options = { ...executeContext(project), sessionRunner: async (opts: { agent: string }) => {
        models++
        return session(opts)
      }, shellRunner: async () => {
        gates++
        return { cwd: project, ok: false, exit_code: 125, stdout_tail: "", stderr_tail: "setup unavailable", setup_failed: true }
      } }
      await executeRun(run, options)
      const originalBasis = structuredClone(loadRun(project, run.run_id)!.nodes.work!.attempts[0]!.preservation_evidence)
      expect(originalBasis?.files.map(file => file.path)).toEqual(["protected.txt"])
      const resumed = prepareRunForResume(loadRun(project, run.run_id)!)
      // Exercise the direct executor boundary even if a higher-level graph
      // revision policy would already reject editing an attempted node.
      resumed.graph.nodes[0]!.inputs!.preserve_paths = JSON.stringify(["other.txt"])
      await expect(executeRun(resumed, { ...options, operation: "resume" })).rejects.toThrow("Preservation path set changed")
      const durable = loadRun(project, run.run_id)!
      expect(durable.global_attempts).toBe(1)
      expect(durable.nodes.work!.attempts[0]!.preservation_evidence).toEqual(originalBasis)
      expect(models).toBe(1)
      expect(gates).toBe(1)
    } finally { removeProject(project) }
  }, 120_000)

  test("real test failure still retries implementation", async () => {
    const project = tempProject()
    try {
      const run = fixture(project)
      let models = 0, gates = 0
      await executeRun(run, { ...executeContext(project), sessionRunner: async (opts) => { models++; return session(opts) },
        shellRunner: async () => ({ cwd: project, ok: ++gates > 1, exit_code: gates > 1 ? 0 : 1,
          stdout_tail: gates > 1 ? "pass" : "assertion failed", stderr_tail: "" }) })
      expect(run.status).toBe("done")
      expect(models).toBe(3)
      expect(run.nodes.work!.attempts.every(attempt => !attempt.shell_setup_failed && !attempt.reused_output_from)).toBe(true)
    } finally { removeProject(project) }
  }, 120_000)
})

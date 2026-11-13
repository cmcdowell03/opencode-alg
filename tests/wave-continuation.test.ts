import { expect, test } from "bun:test"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { createRun, loadRun } from "../src/store.ts"
import { createAlgTools } from "../src/tools.ts"
import type { GraphDef, RunState } from "../src/types.ts"
import { executeContext, inertClient, removeProject, tempProject } from "./helpers.ts"

const implemented = { summary: ["work"], files_touched: [], commands_run: [], risks: [], done: true }
const checked = { passed: true, score: 10, failures: [] }
const graph: GraphDef = { name: "wave-recovery", max_global_attempts: 4, max_concurrency: 1, nodes: [
  { id: "work", agent: "implementer", depends_on: [], loop: { gate: "schema", max_attempts: 2 } },
  { id: "check", agent: "checker", depends_on: ["work"], feedback_to: "work", isolated_check: true,
    loop: { gate: "schema", max_attempts: 2 } },
] }
function make(root: string, definition = graph) {
  return createRun({ goal: "finish verification", criteria: ["work is verified"], graph: definition,
    projectDirectory: root, ownerSessionId: "session-owner" })
}
async function status(root: string, run: RunState) {
  const tools = createAlgTools({ client: inertClient(), directory: root, worktree: root } as never)
  return JSON.parse((await tools.alg_status.execute({ run_id: run.run_id }, {
    sessionID: "session-owner", messageID: "status", agent: "orchestrator", directory: root, worktree: root,
    abort: new AbortController().signal, ask: async () => {}, metadata: () => {},
  } as never) as { output: string }).output)
}

test("a bounded checker repair continues the same durable run without replaying or refunding attempts", async () => {
  const root = tempProject()
  try {
    const run = make(root), calls: string[] = []
    let checks = 0
    const options = { ...executeContext(root), maxWaves: 2, sessionRunner: async (o: { agent: string; userPrompt: string }) => {
      calls.push(o.agent)
      if (o.agent === "implementer") {
        if (calls.length > 1) expect(o.userPrompt).toContain("retain the missing evidence")
        return { session_id: "work-" + calls.length, text: "", parsed: implemented }
      }
      return { session_id: "check-" + ++checks, text: "",
        parsed: checks === 1 ? { passed: false, score: 2, failures: ["retain the missing evidence"] } : checked }
    } }
    await executeRun(run, options)
    expect(run).toMatchObject({ status: "blocked", phase: "wave-limit", global_attempts: 2 })
    const first = structuredClone(run.nodes.work!.attempts[0])
    const response = await status(root, run)
    expect(response.next).toContain("continue with alg_resume")
    expect(response.next).toContain(run.run_id)
    expect(response.next).toContain("original attempts")
    const resumed = prepareRunForResume(loadRun(root, run.run_id)!)
    await executeRun(resumed, { ...options, operation: "resume" })
    expect(resumed).toMatchObject({ status: "done", phase: "done", global_attempts: 4 })
    expect(calls).toEqual(["implementer", "checker", "implementer", "checker"])
    expect(resumed.nodes.work!.attempts[0]).toEqual(first)
    expect((await status(root, resumed)).next).toContain("run is complete")
  } finally { removeProject(root) }
})

test.each(["cancel", "sdk", "prerequisite"] as const)("a %s stop is not advertised as a wave pause", async kind => {
  const root = tempProject(), controller = new AbortController()
  try {
    const run = make(root)
    const options = { ...executeContext(root, controller.signal), maxWaves: 1,
      beforeBatch: async () => { if (kind === "prerequisite") throw new Error("unknown remote outcome") },
      sessionRunner: async () => {
        if (kind === "sdk") throw new Error("transport uncertain")
        controller.abort()
        return { session_id: "work", text: "", parsed: implemented }
      } }
    if (kind === "prerequisite") await expect(executeRun(run, options)).rejects.toThrow("unknown remote outcome")
    else await executeRun(run, options)
    expect(run.status).toBe("blocked")
    expect(run.phase).not.toBe("wave-limit")
    expect((await status(root, run)).next).toContain("Resolve its prerequisite")
  } finally { removeProject(root) }
})

test("an exhausted global allowance remains terminal at the wave boundary", async () => {
  const root = tempProject()
  try {
    const run = make(root, { ...graph, max_global_attempts: 1 })
    await executeRun(run, { ...executeContext(root), maxWaves: 1,
      sessionRunner: async () => ({ session_id: "work", text: "", parsed: implemented }) })
    expect(run.status).toBe("failed")
    expect(run.phase).not.toBe("wave-limit")
    expect(run.global_attempts).toBe(1)
  } finally { removeProject(root) }
})

test("a shell setup failure at a wave boundary still requires prerequisite repair", async () => {
  const root = tempProject()
  try {
    const run = make(root, { ...graph, nodes: [
      { ...graph.nodes[0]!, shell_gate: { cmd: "echo ok" }, loop: { gate: "all", max_attempts: 2 } }, graph.nodes[1]!,
    ] })
    await executeRun(run, { ...executeContext(root), maxWaves: 1,
      sessionRunner: async () => ({ session_id: "work", text: "", parsed: implemented }),
      shellRunner: async () => ({ ok: false, exit_code: 125, setup_failed: true, cwd: root, stdout_tail: "", stderr_tail: "setup unavailable" }) })
    expect(run.phase).toBe("blocked")
    expect(run.global_attempts).toBe(1)
    expect((await status(root, run)).next).not.toContain("continue with alg_resume")
  } finally { removeProject(root) }
})

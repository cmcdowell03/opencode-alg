import { expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { validateGraph } from "../src/graph.ts"
import { bindTaskContract } from "../src/task-contract.ts"
import { createRun, hydrateRunFully, loadRun } from "../src/store.ts"
import type { NodePromptOpts } from "../src/sessions.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

const projectFile = "result.txt"
const implemented = { summary: ["created declared file"], files_touched: [projectFile], commands_run: [], risks: [], done: true }
const checked = { passed: true, score: 10, failures: [] }

test("checker task evidence references survive attempt archiving and hydration; tampering fails closed", async () => {
  const root = tempProject("alg-task-evidence-integrity-")
  try {
    const graph = validateGraph({ name: "task-evidence-archive", max_global_attempts: 10, nodes: [
      { id: "implement", agent: "implementer", depends_on: [], loop: { gate: "schema", max_attempts: 1 } },
      { id: "check", agent: "checker", depends_on: ["implement"], isolated_check: true,
        loop: { gate: "schema", max_attempts: 8 } },
    ] })
    const goal = "Create and verify result.txt", criteria = ["The declared file exists"]
    const taskContract = bindTaskContract({ version: 1, kind: "project_change", discovery: "not_required", phase: "complete",
      deliverables: [{ destination: "project_file", path: projectFile, producer_node: "implement" }],
      verification: { checker_node: "check", execution: "none" }, preserve_paths: [],
      evidence_plan: [{ criterion: 1, observations: [{ kind: "deliverable", index: 0 }] }],
    }, goal, criteria, graph, { session_id: "session-owner", message_id: "accepted" })
    const run = createRun({ goal, criteria, graph, taskContract, projectDirectory: root, ownerSessionId: "session-owner" })
    let version = 0
    const sessionRunner = async ({ agent, title }: NodePromptOpts) => {
      expect(loadRun(root, run.run_id)!.task_baseline).toEqual({
        version: 1, contract_sha256: taskContract.contract_sha256,
      })
      if (agent === "implementer") writeFileSync(join(root, projectFile), `revision-${++version}`)
      return { session_id: title, text: "", parsed: agent === "implementer" ? implemented : checked }
    }
    const context = { ...executeContext(root), sessionRunner }

    const initial = await executeRun(run, context)
    expect(initial.status).toBe("done")
    expect(initial.nodes.check!.attempts[0]!.task_evidence_ref).toBeDefined()

    // Each changed file makes the completed checker snapshot stale. Resume first
    // records that boundary, then a second resume runs a fresh checker. Five
    // checker attempts force the first evidence reference into attempt history.
    for (let attempt = 2; attempt <= 5; attempt++) {
      writeFileSync(join(root, projectFile), `revision-${attempt}`)
      const stale = await executeRun(prepareRunForResume(loadRun(root, run.run_id)!), { ...context, operation: "resume" })
      expect(stale.status).toBe("blocked")
      expect(stale.phase).toBe("task-evidence")
      expect(stale.nodes.check!.current_attempt).toBe(attempt - 1)
      const refreshed = await executeRun(prepareRunForResume(loadRun(root, run.run_id)!), { ...context, operation: "resume" })
      expect(refreshed.status).toBe("done")
      expect(refreshed.nodes.implement!.current_attempt).toBe(1)
      expect(refreshed.nodes.check!.current_attempt).toBe(attempt)
    }

    const projected = loadRun(root, run.run_id)!
    expect(projected.nodes.check!.attempt_history_ref).toBeDefined()
    const hydrated = hydrateRunFully(projected)
    expect(hydrated.nodes.check!.attempts).toHaveLength(5)
    const archivedEvidence = hydrated.nodes.check!.attempts[0]!.task_evidence_ref
    expect(archivedEvidence).toBeDefined()
    expect(hydrated.nodes.check!.attempts.slice(1).every(attempt => !!attempt.task_evidence_ref)).toBe(true)

    const evidencePath = join(root, ...archivedEvidence!.artifact_path.split("/"))
    const original = readFileSync(evidencePath, "utf8")
    const tampered = original.replace(/("contract_sha256"\s*:\s*")([a-f0-9])/, (_match, prefix: string, nibble: string) =>
      `${prefix}${nibble === "0" ? "1" : "0"}`)
    expect(tampered).not.toBe(original)
    writeFileSync(evidencePath, tampered)
    expect(() => hydrateRunFully(loadRun(root, run.run_id)!)).toThrow(/task evidence|immutable JSON|reference/i)
  } finally {
    removeProject(root)
  }
})

import { expect, test } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { capturePreservationBasis, finishPreservationEvidence } from "../src/preservation-evidence.ts"
import { executeRun } from "../src/executor.ts"
import { createRun, loadRun } from "../src/store.ts"
import { executeContext, tempProject, removeProject } from "./helpers.ts"

test("preservation observations bind exact bytes and do not hide a changed file", () => {
  const project = tempProject()
  try {
    writeFileSync(join(project, "source.txt"), "original")
    const basis = capturePreservationBasis(project, ["source.txt"])!
    expect(finishPreservationEvidence(project, basis).files[0]!.status).toBe("unchanged")
    writeFileSync(join(project, "source.txt"), "changed")
    expect(finishPreservationEvidence(project, basis).files[0]!.status).toBe("changed")
    expect(() => capturePreservationBasis(project, ["../outside"])).toThrow()
    expect(() => capturePreservationBasis(project, ["missing"])).toThrow()
    writeFileSync(join(project, "large.txt"), Buffer.alloc(1024 * 1024 + 1))
    expect(() => capturePreservationBasis(project, ["large.txt"])).toThrow()
  } finally { removeProject(project) }
})

test("original preservation basis survives implementation retries, persistence and checker handoff", async () => {
  const project = tempProject()
  try {
    writeFileSync(join(project, "protected.txt"), "original")
    const run = createRun({ goal: "do work and preserve source", criteria: ["keep source"], projectDirectory: project,
      ownerSessionId: "session-owner", graph: { name: "preservation", max_global_attempts: 3, max_concurrency: 1, nodes: [
        { id: "work", agent: "implementer", depends_on: [], inputs: { preserve_paths: '["protected.txt"]' }, loop: { gate: "schema", max_attempts: 2 } },
        { id: "check", agent: "checker", depends_on: ["work"], inputs: { claimed: "work" } },
      ] } })
    let workCalls = 0
    await executeRun(run, { ...executeContext(project), sessionRunner: async opts => {
      if (opts.agent === "checker") {
        expect(opts.userPrompt).toContain("host_preservation")
        expect(opts.userPrompt).toContain('"status":"changed"')
        return { session_id: "check", text: "", parsed: { passed: false, failures: ["protected source changed"], score: 0 } }
      }
      workCalls++
      writeFileSync(join(project, "protected.txt"), "modified")
      return { session_id: `work${workCalls}`, text: "", parsed: workCalls === 1 ? {} : {
        summary: ["done"], files_touched: ["protected.txt"], commands_run: [], risks: [], done: true,
      } }
    } })
    expect(run.status).toBe("failed")
    const attempts = loadRun(project, run.run_id)!.nodes.work!.attempts
    expect(attempts[0]!.preservation_evidence!.files[0]!.before_sha256).toBe(attempts[1]!.preservation_evidence!.files[0]!.before_sha256)
    expect(attempts[1]!.preservation_evidence!.files[0]!.status).toBe("changed")
  } finally { removeProject(project) }
}, 120_000)

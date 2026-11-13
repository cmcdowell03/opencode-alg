import { afterEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { validateGraph } from "../src/graph.ts"
import { bindTaskContract, assertEvidencePlan, parseTaskContractInput, type TaskContractInput } from "../src/task-contract.ts"
import { createRun, loadRun, persistRun, hydrateRunFully } from "../src/store.ts"
import { taskEvidence } from "../src/task-evidence.ts"
import { formatCompactionContext } from "../src/compaction.ts"
import { sha256Json } from "../src/persistence.ts"
import { executeContext, tempProject, removeProject } from "./helpers.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeProject(root) })
const implemented = { summary: ["implemented"], files_touched: ["src/result.json"], commands_run: [], risks: [], done: true }
const checked = { passed: true, score: 10, failures: [] }
const researched = { answer: "ready", evidence: [], constraints: [], options: [], acceptance_criteria: ["Produce result"], risks: [] }
function fixture() {
  const root = tempProject("alg-task-baseline-"); roots.push(root)
  mkdirSync(join(root, "src")); writeFileSync(join(root, "src", "keep.ts"), "original")
  writeFileSync(join(root, "policy.md"), "original policy")
  const graph = validateGraph({ name: "baseline-fixture", max_global_attempts: 8, nodes: [
    { id: "research", agent: "researcher", depends_on: [], loop: { gate: "schema", max_attempts: 2 } },
    { id: "implement", agent: "implementer", depends_on: ["research"], inputs: { preserve_paths: '["policy.md"]' }, loop: { gate: "schema", max_attempts: 3 } },
    { id: "check", agent: "checker", depends_on: ["implement"], isolated_check: true, loop: { gate: "schema", max_attempts: 2 } },
  ] })
  const input: TaskContractInput = { version: 1, kind: "project_change", discovery: "required", phase: "complete",
    deliverables: [{ destination: "project_file", path: "src/result.json", producer_node: "implement" }],
    verification: { checker_node: "check", execution: "none" }, preserve_paths: ["policy.md"],
    change_scope: { roots: ["src"], allowed_paths: ["src/result.json"], max_changed_files: 1 },
    evidence_plan: [
      { criterion: 1, observations: [{ kind: "deliverable", index: 0 }, { kind: "review", rationale: "Inspect result semantics" }] },
      { criterion: 2, observations: [{ kind: "preservation", paths: ["policy.md"] }] },
      { criterion: 3, observations: [{ kind: "change_scope" }] },
    ] }
  const goal = "Write result", criteria = ["Produce result", "Keep policy unchanged", "Only result may change in src"]
  const taskContract = bindTaskContract(input, goal, criteria, graph, { session_id: "session-owner", message_id: "user" })
  const run = createRun({ goal, criteria, graph, taskContract, projectDirectory: root, ownerSessionId: "session-owner" })
  return { root, run, input }
}
function runner(root: string, calls: string[], action?: (role: string) => void) {
  return async (opts: { agent: string; userPrompt: string }) => {
    calls.push(opts.agent)
    if (opts.agent === "implementer") writeFileSync(join(root, "src", "result.json"), '{"result":42}')
    action?.(opts.agent)
    return { session_id: `child-${calls.length}`, text: "", parsed: opts.agent === "implementer" ? implemented : opts.agent === "checker" ? checked : researched }
  }
}

test("coverage must cover each criterion and bind actual collection declarations", () => {
  const { input } = fixture()
  expect(() => assertEvidencePlan(input, 3, true)).not.toThrow()
  expect(() => assertEvidencePlan({ ...input, evidence_plan: undefined }, 3, true)).toThrow("required")
  expect(() => assertEvidencePlan(input, 4, true)).toThrow("coverage")
  for (const observations of [[{ kind: "execution" }], [{ kind: "deliverable", index: 1 }], [{ kind: "preservation", paths: ["missing"] }]] as any[])
    expect(() => assertEvidencePlan({ ...input, evidence_plan: [{ criterion: 1, observations }] }, 1, true)).toThrow("binding")
  expect(() => parseTaskContractInput({ ...input, evidence_plan: Array.from({ length: 64 }, (_, i) => ({
    criterion: i + 1, observations: [{ kind: "review", rationale: "r".repeat(500) }],
  })) })).toThrow("task_contract_invalid")
})

test("baseline is durable before discovery, survives compaction/restart, and cannot be replaced", async () => {
  const { root, run } = fixture(), calls: string[] = []
  await executeRun(run, { ...executeContext(root), maxWaves: 1, sessionRunner: runner(root, calls, () => {
    expect(loadRun(root, run.run_id)!.task_baseline).toEqual(run.task_baseline)
  }) })
  expect(calls).toEqual(["researcher"])
  const original = structuredClone(run.task_baseline!)
  expect(original.change_scope!.files.map(f => f.path)).toEqual(["src/keep.ts"])
  expect(formatCompactionContext(run)).toContain(sha256Json(original))
  const resumed = prepareRunForResume(loadRun(root, run.run_id)!)
  await executeRun(resumed, { ...executeContext(root), operation: "resume", sessionRunner: runner(root, calls) })
  expect(resumed.status).toBe("done")
  expect(resumed.task_baseline).toEqual(original)
  const evidence = taskEvidence(resumed)!
  expect(evidence.change_scope).toMatchObject({ status: "within_scope", changed_count: 1,
    changed_sample: [{ path: "src/result.json", kind: "added" }], omitted_changes: 0 })
  expect(hydrateRunFully(loadRun(root, run.run_id)!).status).toBe("done")
  resumed.task_baseline = undefined
  expect(() => persistRun(resumed, root)).toThrow("immutable")
  expect(loadRun(root, run.run_id)!.task_baseline).toEqual(original)
})

test("an unavailable before-work file stops before the first child and attempt", async () => {
  const { root, run } = fixture()
  // Directory where a protected regular file was expected.
  const { unlinkSync } = await import("node:fs")
  unlinkSync(join(root, "policy.md")); mkdirSync(join(root, "policy.md"))
  const calls: string[] = []
  await executeRun(run, { ...executeContext(root), sessionRunner: runner(root, calls) })
  expect(run.status).toBe("blocked"); expect(run.phase).toBe("task-baseline")
  expect(calls).toEqual([]); expect(run.global_attempts).toBe(0); expect(run.task_baseline).toBeUndefined()
})

test("discovery cannot change a protected file before its baseline is collected", async () => {
  const { root, run } = fixture(), calls: string[] = []
  await expect(executeRun(run, { ...executeContext(root), sessionRunner: runner(root, calls, role => {
    if (role === "researcher") writeFileSync(join(root, "policy.md"), "changed early")
  }) })).rejects.toThrow("task_preservation_unverified")
  expect(calls).toEqual(["researcher", "implementer"])
  expect(taskEvidence(run)!.preservation[0]!.status).toBe("changed")
})

test("out-of-scope change blocks checker and resume does not repeat the correct producer", async () => {
  const { root, run } = fixture(), calls: string[] = []
  await expect(executeRun(run, { ...executeContext(root), sessionRunner: runner(root, calls, role => {
    if (role === "implementer") writeFileSync(join(root, "src", "extra.ts"), "unexpected")
  }) })).rejects.toThrow("task_change_scope_unverified")
  expect(calls).toEqual(["researcher", "implementer"])
  expect(taskEvidence(run)!.change_scope).toMatchObject({ status: "violated", changed_count: 2 })
  const resumed = prepareRunForResume(loadRun(root, run.run_id)!)
  await executeRun(resumed, { ...executeContext(root), operation: "resume", sessionRunner: runner(root, calls) })
  expect(resumed.status).toBe("blocked")
  expect(calls).toEqual(["researcher", "implementer"])
})

test("post-check content drift invalidates proof even when changed path count stays identical", async () => {
  const { root, run } = fixture(), calls: string[] = []
  await executeRun(run, { ...executeContext(root), sessionRunner: runner(root, calls, role => {
    if (role === "checker") writeFileSync(join(root, "src", "result.json"), '{"result":"tampered"}')
  }) })
  expect(run.status).toBe("blocked")
  expect(run.phase).toBe("task-evidence")
  expect(run.summary).toContain("task_evidence_changed")
})

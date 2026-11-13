import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assertEvidencePlan, assertTaskGraph, assertTaskHostCapabilities, assertTaskState, bindTaskContract, parseTaskContractInput,
  taskTemplate, uniformCapability, type TaskContractInput } from "../src/task-contract.ts"
import { getTemplate } from "../src/templates.ts"
import { createRun, loadRun, persistRun } from "../src/store.ts"
import { formatCompactionContext } from "../src/compaction.ts"
import { executeRun } from "../src/executor.ts"
import { taskEvidence } from "../src/task-evidence.ts"
import { TaskRequestSnapshotSchema } from "../src/task-request.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

const projects: string[] = []
afterEach(() => { for (const project of projects.splice(0)) removeProject(project) })
function project() { const value = tempProject("alg-contract-"); projects.push(value); return value }
export function contract(overrides: Partial<TaskContractInput> = {}): TaskContractInput {
  return { version: 1, kind: "project_change", discovery: "not_required", phase: "complete",
    deliverables: [{ destination: "project_file", path: "result.json", producer_node: "implement" }],
    verification: { checker_node: "check", execution: "none" }, preserve_paths: [],
    evidence_plan: [{ criterion: 1, observations: [{ kind: "deliverable", index: 0 }] }], ...overrides }
}
function fixture(input = contract()) {
  const root = project(), graph = getTemplate("coding-compact"), goal = "Create the declared result", criteria = ["Produce result.json"]
  const task = bindTaskContract(input, goal, criteria, graph, { session_id: "session-owner", message_id: "accepted" })
  const run = createRun({ goal, criteria, graph, taskContract: task, projectDirectory: root, ownerSessionId: "session-owner" })
  return { root, run, task }
}
const output = { summary: ["done"], files_touched: ["result.json"], commands_run: [], risks: [], done: true }

describe("declared task admission", () => {
  test("host user request survives persistence, compaction and both child handoffs without trusting a shortened summary", async () => {
    const root = project(), graph = getTemplate("coding-compact")
    const text = "Prepare only. The later result requires fields numerator, denominator, rate, window, sources, conflicts, limitations. Do not write the final report yet."
    const snapshot = TaskRequestSnapshotSchema.parse({ status: "captured", session_id: "session-owner", message_id: "user-original",
      text, text_sha256: createHash("sha256").update(text).digest("hex"), text_transformed: false, non_text_parts: 0 })
    if (snapshot.status !== "captured") throw new Error("fixture must capture the request")
    const task = bindTaskContract(contract({ phase: "preparation" }), "Prepare using the required schema", ["Create result.json"], graph,
      { session_id: "session-owner", message_id: "assistant-plan" }, snapshot)
    const run = createRun({ goal: "Prepare using the required schema", criteria: ["Create result.json"], graph,
      taskContract: task, projectDirectory: root, ownerSessionId: "session-owner" })
    const restored = loadRun(root, run.run_id)!
    expect(restored.task_contract?.request_snapshot).toEqual(snapshot)
    const compact = formatCompactionContext(restored, 4096)
    expect(compact).toContain(snapshot.text_sha256)
    expect(compact).not.toContain(text)
    const roles: string[] = []
    await executeRun(restored, { ...executeContext(root), sessionRunner: async opts => {
      roles.push(opts.agent)
      expect(opts.userPrompt).toContain(JSON.stringify(text))
      expect(opts.userPrompt).toContain("later-phase deliverables are not required now")
      if (opts.agent === "implementer") writeFileSync(join(root, "result.json"), "{}")
      return { session_id: "child", text: "", parsed: opts.agent === "checker" ? { passed: true, score: 10, failures: [] } : output }
    } })
    expect(roles).toEqual(["implementer", "checker"])
    const mutated = loadRun(root, run.run_id)!
    mutated.task_contract!.request_snapshot = { status: "unavailable", reason: "no_text" }
    expect(() => assertTaskState(mutated)).toThrow("task_contract_drift")
    expect(() => persistRun(mutated, root)).toThrow()
    expect(loadRun(root, run.run_id)!.task_contract!.request_snapshot).toEqual(snapshot)
  })

  test("project deliverables reject research-only graphs and do not create durable work", () => {
    const root = project(), input = contract({ deliverables: [{ destination: "project_file", path: "preparation.md", producer_node: "research" }] })
    expect(() => bindTaskContract(input, "Prepare", ["Write preparation.md"], getTemplate("research-diamond"),
      { session_id: "owner", message_id: "m" })).toThrow("task_write_capability_missing")
    expect(existsSync(join(root, ".opencode"))).toBe(false)
  })
  test("routing uses declared work and uncertainty, not model/task-name keywords", () => {
    expect(taskTemplate(contract())).toBe("coding-compact")
    expect(taskTemplate(contract({ discovery: "required" }))).toBe("coding-diamond")
    const input = contract({ kind: "read_only", deliverables: [{ destination: "response", producer_node: "research" }] })
    expect(taskTemplate(input)).toBe("research-diamond")
    expect(() => assertTaskGraph(input, getTemplate("research-diamond"))).not.toThrow()
    expect(() => assertTaskGraph(input, getTemplate("coding-compact"))).toThrow("task_read_only_mismatch")
  })
  test("missing checker, disconnected producer, execution and protected paths fail closed", () => {
    const graph = getTemplate("coding-compact")
    const disconnected = structuredClone(graph); disconnected.nodes[1]!.depends_on = []
    expect(() => assertTaskGraph(contract(), disconnected)).toThrow("disconnected")
    const noFresh = structuredClone(graph); noFresh.nodes[1]!.isolated_check = false
    expect(() => assertTaskGraph(contract(), noFresh)).toThrow("checker_required")
    expect(() => assertTaskGraph(contract({ verification: { checker_node: "check", execution: "shell_gate", execution_node: "implement" } }), graph)).toThrow("gate_required")
    expect(() => assertTaskGraph(contract({ preserve_paths: ["source.json"] }), graph)).toThrow("preservation_required")
  })
  test("typed paths cannot conflict or traverse; diagnostics do not echo unknown keys", () => {
    expect(() => parseTaskContractInput(contract({ preserve_paths: ["result.json"] }))).toThrow("task_contract_invalid")
    expect(() => parseTaskContractInput(contract({ deliverables: [{ destination: "project_file", path: "../escape", producer_node: "implement" }] }))).toThrow("task_contract_invalid")
    try { parseTaskContractInput({ ...contract(), "attacker-string": true }); throw Error("expected rejection") }
    catch (e) { expect(String(e)).not.toContain("attacker-string") }
  })
  test("evidence plans cover criteria in order and bind observations to declared inputs", () => {
    const base = contract()
    const withoutEvidence = structuredClone(base)
    delete withoutEvidence.evidence_plan
    expect(() => assertEvidencePlan(withoutEvidence, 1, true)).toThrow("task_evidence_plan_required")
    expect(() => assertEvidencePlan({ ...base, evidence_plan: [
      { criterion: 2, observations: [{ kind: "review", rationale: "fixture review" }] },
    ] }, 1, true)).toThrow("task_evidence_coverage")
    expect(() => assertEvidencePlan({ ...base, evidence_plan: [
      { criterion: 1, observations: [{ kind: "execution" }] },
    ] }, 1, true)).toThrow("task_evidence_binding")
    expect(() => assertEvidencePlan({ ...base, evidence_plan: [
      { criterion: 1, observations: [{ kind: "deliverable", index: 1 }] },
    ] }, 1, true)).toThrow("task_evidence_binding")
    expect(() => parseTaskContractInput({ ...base, evidence_plan: [
      { criterion: 1, observations: [{ kind: "review", rationale: "   " }] },
    ] })).toThrow("task_contract_invalid")
  })
  test("capabilities recognize only uniform host decisions", () => {
    const graph = getTemplate("coding-compact")
    const checker = { name: "checker", tools: { read: true }, permission: { read: "allow" } }
    expect(() => assertTaskHostCapabilities(contract(), graph, [{ name: "implementer", permission: { edit: "allow" } }, checker])).not.toThrow()
    for (const value of ["deny", "ask", undefined]) {
      expect(() => assertTaskHostCapabilities(contract(), graph, [{ name: "implementer", permission: { edit: value } }, checker])).toThrow("task_host_capability")
    }
    expect(uniformCapability([{ permission: "edit", pattern: "*", action: "allow" }], "edit")).toBe("allow")
    expect(uniformCapability([{ permission: "edit", pattern: "*", action: "allow" }, { permission: "edit", pattern: "secret/*", action: "deny" }], "edit")).toBe("unknown")
    const defaults = [{ permission: "*", pattern: "*", action: "allow" },
      { permission: "read", pattern: "*.env", action: "ask" }, { permission: "read", pattern: "*.env.*", action: "ask" }]
    for (const action of ["allow", "deny", "ask"] as const)
      expect(uniformCapability([...defaults, { permission: "read", pattern: "*", action }], "read")).toBe(action)
    expect(uniformCapability([...defaults, { permission: "read", pattern: "*", action: "allow" },
      { permission: "read", pattern: "private/*", action: "deny" }], "read")).toBe("unknown")
    expect(uniformCapability([...defaults, { permission: "read", pattern: "*", action: "allow" },
      { permission: "r*", pattern: "*", action: "deny" }], "read")).toBe("unknown")
    expect(uniformCapability([{ permission: "read", pattern: "file", action: "allow" }], "read")).toBe("unknown")
    expect(uniformCapability([{ permission: "read", pattern: "*", action: "allow" },
      { permission: "READ", pattern: "*", action: "deny" }], "read")).toBe(process.platform === "win32" ? "deny" : "allow")
    expect(() => assertTaskHostCapabilities(contract(), graph, [{ name: "implementer", tools: { edit: false }, permission: { edit: "allow" } }, checker])).toThrow("deny")
  })
  test("original criteria and contract survive persistence and bounded context projection", () => {
    const { root, run, task } = fixture(contract({ phase: "preparation" }))
    expect(loadRun(root, run.run_id)!.task_contract).toEqual(task)
    expect(formatCompactionContext(run, 4096)).toContain(task.contract_sha256)
    expect(formatCompactionContext(run, 4096)).toContain("preparation")
    run.criteria = ["weaker criteria"]
    expect(() => assertTaskState(run)).toThrow("task_contract_drift")
    expect(() => persistRun(run, root)).toThrow()
    expect(loadRun(root, run.run_id)!.criteria).toEqual(["Produce result.json"])
  })
  test("removing an accepted contract cannot silently turn a new run into legacy", () => {
    const { root, run } = fixture(); run.task_contract = undefined
    expect(() => persistRun(run, root)).toThrow("immutable")
    expect(loadRun(root, run.run_id)!.task_contract).toBeDefined()
  })
  test("legacy persisted runs remain readable without invented admission", () => {
    const root = project()
    const run = createRun({ goal: "legacy", criteria: [], graph: getTemplate("coding-compact"), projectDirectory: root, ownerSessionId: "session-owner" })
    expect(loadRun(root, run.run_id)!.task_contract).toBeUndefined()
    expect(formatCompactionContext(run)).toContain("legacy-unqualified")
  })
  test("older directly bound contracts may retain an absent evidence plan", () => {
    const root = project(), input = structuredClone(contract())
    delete input.evidence_plan
    const goal = "Create the declared result", criteria = ["Produce result.json"], graph = getTemplate("coding-compact")
    const task = bindTaskContract(input, goal, criteria, graph, { session_id: "session-owner", message_id: "legacy-direct" })
    const run = createRun({ goal, criteria, graph, taskContract: task, projectDirectory: root, ownerSessionId: "session-owner" })
    expect(loadRun(root, run.run_id)!.task_contract!.input.evidence_plan).toBeUndefined()
  })
})

describe("host-enforced task completion", () => {
  test("passing model verdict cannot certify a missing declared file", async () => {
    const { root, run } = fixture()
    await expect(executeRun(run, { ...executeContext(root), sessionRunner: async opts => ({
      session_id: "child", text: "", parsed: opts.agent === "checker" ? { passed: true, score: 10, failures: [] } : output,
    }) })).rejects.toThrow("task_deliverable_unavailable")
    expect(run.status).toBe("blocked")
    expect(run.nodes.check!.current_attempt).toBe(0)
    expect(run.nodes.implement!.current_attempt).toBe(1)
  })
  test("correct files pass; preparation contract is visible to workers and remains pinned", async () => {
    const { root, run, task } = fixture(contract({ phase: "preparation" }))
    let workerSawContract = false
    await executeRun(run, { ...executeContext(root), sessionRunner: async opts => {
      if (opts.agent === "implementer") { workerSawContract = opts.userPrompt.includes('"phase":"preparation"'); writeFileSync(join(root, "result.json"), '{"answer":42}') }
      else expect(opts.userPrompt).toContain("host_task")
      return { session_id: "child", text: "", parsed: opts.agent === "checker" ? { passed: true, score: 10, failures: [] } : output }
    } })
    expect(run.status).toBe("done"); expect(workerSawContract).toBe(true)
    expect(loadRun(root, run.run_id)!.task_contract!.contract_sha256).toBe(task.contract_sha256)
  })
  test("claimed commands do not satisfy the native command requirement", async () => {
    const { root, run } = fixture(contract({ verification: { checker_node: "check", execution: "host_command", execution_node: "implement" } }))
    writeFileSync(join(root, "result.json"), "{}")
    await expect(executeRun(run, { ...executeContext(root), sessionRunner: async opts => ({
      session_id: "child", text: "", parsed: opts.agent === "checker" ? { passed: true, score: 10, failures: [] } : { ...output, commands_run: [{ cmd: "npm test", outcome: "passed (model claim)" }] },
    }) })).rejects.toThrow("task_execution_unavailable")
    expect(run.status).not.toBe("done")
    expect(run.nodes.implement!.status).toBe("done")
    expect(run.nodes.check!.current_attempt).toBe(0)
    expect(taskEvidence(run)!.failures).toContain("task_execution_unavailable: required successful command evidence is missing; model claims cannot replace it")
  })
  test("accepted verification gate cannot be replaced at run time", async () => {
    const { root, run } = fixture()
    await expect(executeRun(run, { ...executeContext(root), shellGateCmd: "echo pass" })).rejects.toThrow("task_contract_locked")
    expect(loadRun(root, run.run_id)!.global_attempts).toBe(0)
  })
})


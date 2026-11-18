import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { assertEvidencePlan, assertTaskGraph, assertTaskHostCapabilities, assertTaskState, bindTaskContract, parseTaskContractInput,
  taskTemplate, uniformCapability, type TaskContractInput } from "../src/task-contract.ts"
import { getTemplate } from "../src/templates.ts"
import { createRun, loadRun, persistRun } from "../src/store.ts"
import { sha256Json } from "../src/persistence.ts"
import { formatCompactionContext } from "../src/compaction.ts"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { buildCheckerPrompt, buildWorkerPrompt } from "../src/sessions.ts"
import { taskEvidence } from "../src/task-evidence.ts"
import { TaskRequestSnapshotSchema } from "../src/task-request.ts"
import { ActionEvidenceJournal } from "../src/action-evidence.ts"
import { EvidenceRetrieval } from "../src/evidence-retrieval.ts"
import { MemoryStore } from "../src/session-memory/store.ts"
import { TaskAllowanceRuntime } from "../src/task-allowance.ts"
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
  test("the closed action grammar binds only when the complete literal request is exactly admitted criteria", () => {
    const graph = getTemplate("coding-compact")
    const criterion = 'Mechanical action: first recorded bash command is exactly "echo expected"; its linked terminal exit code equals 7.'
    const snapshot = (text: string) => TaskRequestSnapshotSchema.parse({ status: "captured", session_id: "session-owner",
      message_id: "original", text, text_sha256: createHash("sha256").update(text).digest("hex"),
      text_transformed: false, non_text_parts: 0 })
    const bind = (criteria: string[], text: string) => bindTaskContract(contract({ evidence_plan: criteria.map((value, index) =>
      value.startsWith("Mechanical action:")
        ? { criterion: index + 1, observations: [{ kind: "action" as const }] }
        : { criterion: index + 1, observations: [{ kind: "review" as const, rationale: "semantic review" }] }) }),
      "Check action", criteria, graph, { session_id: "session-owner", message_id: "plan" }, snapshot(text))
    expect(bind([criterion], criterion).mechanical_verification).toMatchObject({ evaluator: "task-evidence-v1", criteria: [
      { criterion_id: "C1", mode: "mechanical", recipe: "pinned_first_bash", expected_command_sha256: createHash("sha256").update("echo expected").digest("hex"), expected_command_bytes: 13, expected_exit_code: 7 },
    ] })
    expect(bind([criterion], `Please verify this statement: ${criterion}`).mechanical_verification).toBeUndefined()
    expect(bind([criterion], `${criterion}\nExtra unadmitted requirement`).mechanical_verification).toBeUndefined()
    const bindPlan = (evidence_plan: TaskContractInput["evidence_plan"]) => bindTaskContract(
      contract(evidence_plan === undefined ? {} : { evidence_plan }), "Check action", [criterion], graph,
      { session_id: "session-owner", message_id: "plan" }, snapshot(criterion))
    expect(bindPlan(undefined).mechanical_verification).toBeUndefined()
    expect(bindPlan([{ criterion: 1, observations: [{ kind: "action" }, { kind: "deliverable", index: 0 }] }])
      .mechanical_verification).toBeUndefined()
    const preservationGraph = structuredClone(graph)
    preservationGraph.nodes.find(node => node.agent === "implementer")!.inputs!.preserve_paths = JSON.stringify(["protected.json"])
    expect(bindTaskContract(contract({ preserve_paths: ["protected.json"], evidence_plan: [
      { criterion: 1, observations: [{ kind: "action" }, { kind: "preservation", paths: ["protected.json"] }] },
    ] }), "Check action", [criterion], preservationGraph, { session_id: "session-owner", message_id: "plan" }, snapshot(criterion))
      .mechanical_verification).toBeUndefined()
    expect(bind([criterion, "The result is substantively correct"], `${criterion}\nThe result is substantively correct`)
      .mechanical_verification?.criteria.map(row => row.mode)).toEqual(["mechanical", "semantic"])
    expect(bind([criterion, "Check accuracy"], `${criterion}\r\nCheck accuracy`)
      .mechanical_verification?.criteria.map(row => row.mode)).toEqual(["mechanical", "semantic"])
    expect(bind([criterion], criterion).mechanical_verification?.criteria[0]).not.toHaveProperty("expected_command")
  })

  test("new ordinary semantic contracts bind and reload; unversioned legacy contracts stay unqualified", () => {
    const root = project(), graph = getTemplate("coding-compact"), criterion = "Review the result for substantive correctness."
    const snapshot = TaskRequestSnapshotSchema.parse({ status: "captured", session_id: "session-owner", message_id: "user-original",
      text: criterion, text_sha256: createHash("sha256").update(criterion).digest("hex"), text_transformed: false, non_text_parts: 0 })
    const task = bindTaskContract(contract(), criterion, [criterion], graph,
      { session_id: "session-owner", message_id: "planner" }, snapshot)
    expect(task.verification_contract_version).toBe(1)
    expect(task.mechanical_verification).toBeUndefined()
    const run = createRun({ goal: criterion, criteria: [criterion], graph, taskContract: task, projectDirectory: root,
      ownerSessionId: "session-owner" })
    expect(loadRun(root, run.run_id)!.task_contract).toEqual(task)
    assertTaskState(loadRun(root, run.run_id)!)

    const legacy = structuredClone(task)
    delete legacy.verification_contract_version
    delete legacy.mechanical_verification
    const { contract_sha256: _oldHash, ...legacyBase } = legacy
    legacy.contract_sha256 = sha256Json(legacyBase)
    const legacyRun = structuredClone(run)
    legacyRun.task_contract = legacy
    assertTaskState(legacyRun)

    const recipe = 'Mechanical action: first recorded bash command is exactly "echo x"; its linked terminal exit code equals 0.'
    const recipeSnapshot = TaskRequestSnapshotSchema.parse({ status: "captured", session_id: "session-owner", message_id: "user-original",
      text: recipe, text_sha256: createHash("sha256").update(recipe).digest("hex"), text_transformed: false, non_text_parts: 0 })
    const legacyMechanical = bindTaskContract(contract({ evidence_plan: [{ criterion: 1, observations: [{ kind: "action" }] }] }),
      recipe, [recipe], graph, { session_id: "session-owner", message_id: "planner" }, recipeSnapshot)
    delete legacyMechanical.verification_contract_version
    delete legacyMechanical.mechanical_verification
    const { contract_sha256: _legacyMechanicalHash, ...legacyMechanicalBase } = legacyMechanical
    legacyMechanical.contract_sha256 = sha256Json(legacyMechanicalBase)
    const legacyMechanicalRun = createRun({ goal: recipe, criteria: [recipe], graph, taskContract: legacyMechanical,
      projectDirectory: root, ownerSessionId: "session-owner" })
    assertTaskState(legacyMechanicalRun)
    expect(legacyMechanicalRun.task_contract?.mechanical_verification).toBeUndefined()
  })

  test.each([{ actualExit: 7, outcome: "supported", status: "done" },
    { actualExit: 1, outcome: "disconfirmed", status: "failed" }] as const)(
    "host preserves $outcome from pinned first-bash bytes and linked terminal exit", async ({ actualExit, outcome, status }) => {
    const root = project(), graph = structuredClone(getTemplate("coding-compact"))
    delete graph.nodes.find(node => node.agent === "checker")!.feedback_to
    const criterion = 'Mechanical action: first recorded bash command is exactly "echo expected"; its linked terminal exit code equals 7.'
    const input = contract({ evidence_plan: [{ criterion: 1, observations: [{ kind: "action" }] }] })
    const text = criterion
    const snapshot = TaskRequestSnapshotSchema.parse({ status: "captured", session_id: "session-owner", message_id: "user-original",
      text, text_sha256: createHash("sha256").update(text).digest("hex"), text_transformed: false, non_text_parts: 0 })
    const task = bindTaskContract(input, "Check the recorded action", [criterion], graph, { session_id: "session-owner", message_id: "planner" }, snapshot)
    const run = createRun({ goal: "Check the recorded action", criteria: [criterion], graph, taskContract: task, projectDirectory: root,
      ownerSessionId: "session-owner" })
    const journal = new ActionEvidenceJournal(root), retrieval = new EvidenceRetrieval(root)
    const roles: string[] = []
    const completed = await executeRun(run, { ...executeContext(root), actionEvidence: { journal, retrieval }, sessionRunner: async opts => {
      roles.push(opts.agent)
      if (opts.agent === "implementer") {
        writeFileSync(join(root, "result.json"), "{}")
        const child = "implement-child"
        await opts.onSessionCreated?.(child)
        for (const [index, command] of ["echo expected", "unrelated later call"].entries()) {
          const call = { tool: "bash", sessionID: child, callID: `call-${index}` }
          journal.before(call, { command })
          journal.after(call, { output: "finished", metadata: { exit_code: index === 0 ? actualExit : 0 } })
        }
        return { session_id: child, text: "", parsed: output }
      }
      throw new Error("mechanical checker must not launch a model child")
    } })
    expect(completed.status, JSON.stringify({ summary: completed.summary, attempts: completed.nodes.check!.attempts })).toBe(status)
    expect(roles).toEqual(["implementer"])
    expect(completed.global_attempts).toBe(2)
    expect(completed.nodes.check!.attempts[0]).toMatchObject({ status: status === "done" ? "done" : "failed",
      outcome: status === "done" ? "passed" : "substantive_rejection", task_evidence_ref: expect.anything(),
      verification_basis: { criterion_ids: ["C1"], evidence: [{ source: { kind: "host_task" }, status: "included" }] },
      output: { passed: status === "done", score: status === "done" ? 10 : 0,
        findings: [{ criterion_id: "C1", outcome }] } })
    expect((completed.nodes.check!.attempts[0]!.output as { findings: Array<{ evidence_ids: string[] }> }).findings[0]!.evidence_ids[0])
      .toMatch(/^R[a-f0-9]{64}$/)
    expect(completed.nodes.check!.attempts[0]!.session_id).toBeUndefined()
    expect(loadRun(root, run.run_id)!.nodes.check!.attempts[0]!.output).toEqual(completed.nodes.check!.attempts[0]!.output)
    expect(completed.nodes.check!.attempts[0]!.retrieved_evidence).toBeUndefined()
    expect(completed.nodes.check!.attempts[0]!.host_mechanical_evidence).toHaveLength(2)
  })

  test("dry mechanical verification keeps absent evidence inconclusive without a checker session", async () => {
    const root = project(), graph = getTemplate("coding-compact")
    const criterion = 'Mechanical action: first recorded bash command is exactly "echo expected"; its linked terminal exit code equals 7.'
    const task = bindTaskContract(contract({ evidence_plan: [{ criterion: 1, observations: [{ kind: "action" }] }] }),
      criterion, [criterion], graph, { session_id: "session-owner", message_id: "planner" }, {
        status: "captured", session_id: "session-owner", message_id: "user-original", text: criterion,
        text_sha256: createHash("sha256").update(criterion).digest("hex"), text_transformed: false, non_text_parts: 0,
      })
    const run = createRun({ goal: criterion, criteria: [criterion], graph, taskContract: task,
      mode: "dry", projectDirectory: root, ownerSessionId: "session-owner" })
    const completed = await executeRun(run, { ...executeContext(root), sessionRunner: async () => {
      throw new Error("dry run cannot launch a child")
    } })
    expect(completed.nodes.implement!.current_attempt).toBe(1)
    const restored = loadRun(root, run.run_id)!
    expect(restored.mode).toBe("dry")
    expect(restored.status).toBe("failed")
    const check = restored.nodes.check!.attempts[0]!
    expect(check).toMatchObject({ outcome: "evidence_unavailable", schema_ok: true,
      output: { passed: false, findings: [{ criterion_id: "C1", outcome: "inconclusive", evidence_ids: [] }] } })
    expect(check.session_id).toBeUndefined()
    expect(check.host_mechanical_evidence).toBeUndefined()
    expect(check.action_evidence_sources).toBeUndefined()
  })

  test("host-only verdict cannot bypass the separately declared deliverable gate", async () => {
    const root = project(), graph = getTemplate("coding-compact")
    const criterion = 'Mechanical action: first recorded bash command is exactly "echo expected"; its linked terminal exit code equals 7.'
    const snapshot = TaskRequestSnapshotSchema.parse({ status: "captured", session_id: "session-owner", message_id: "user-original",
      text: criterion, text_sha256: createHash("sha256").update(criterion).digest("hex"), text_transformed: false, non_text_parts: 0 })
    const task = bindTaskContract(contract({ evidence_plan: [{ criterion: 1, observations: [{ kind: "action" }] }] }),
      criterion, [criterion], graph, { session_id: "session-owner", message_id: "planner" }, snapshot)
    const run = createRun({ goal: criterion, criteria: [criterion], graph, taskContract: task, projectDirectory: root,
      ownerSessionId: "session-owner" })
    const roles: string[] = []
    await expect(executeRun(run, { ...executeContext(root), sessionRunner: async opts => {
      roles.push(opts.agent)
      return { session_id: `${opts.agent}-child`, text: "", parsed: output }
    } })).rejects.toThrow("task_deliverable_unavailable")
    expect(roles).toEqual(["implementer"])
    expect(run.nodes.check!.attempts).toHaveLength(0)
  })

  test("missing terminal exit evidence on ordinary resume retries only the checker and spends no new dispatch", async () => {
    const root = project(), graph = getTemplate("coding-compact")
    const criterion = 'Mechanical action: first recorded bash command is exactly "echo expected"; its linked terminal exit code equals 7.'
    const snapshot = TaskRequestSnapshotSchema.parse({ status: "captured", session_id: "session-owner", message_id: "user-original",
      text: criterion, text_sha256: createHash("sha256").update(criterion).digest("hex"), text_transformed: false, non_text_parts: 0 })
    const task = bindTaskContract(contract({ evidence_plan: [{ criterion: 1, observations: [{ kind: "action" }] }] }),
      criterion, [criterion], graph, { session_id: "session-owner", message_id: "planner" }, snapshot)
    const allowance = new TaskAllowanceRuntime(new MemoryStore(root), { max_dispatches: 4, verification_reserve: 1 })
    const taskAllowance = await allowance.admit("session-owner", task.contract_sha256)
    const run = createRun({ goal: criterion, criteria: [criterion], graph, taskContract: task, taskAllowance,
      projectDirectory: root, ownerSessionId: "session-owner" })
    const journal = new ActionEvidenceJournal(root), retrieval = new EvidenceRetrieval(root)
    const roles: string[] = []
    const sessionRunner = async (opts: Parameters<NonNullable<Parameters<typeof executeRun>[1]["sessionRunner"]>>[0]) => {
      roles.push(opts.agent)
      if (opts.agent !== "implementer") throw new Error("mechanical checker must not launch a model child")
      writeFileSync(join(root, "result.json"), "{}")
      const child = "implement-child"
      await opts.onSessionCreated?.(child)
      const call = { tool: "bash", sessionID: child, callID: "missing-exit" }
      journal.before(call, { command: "echo expected" })
      journal.after(call, { output: "finished", metadata: {} })
      return { session_id: child, text: "", parsed: output }
    }
    const first = await executeRun(run, { ...executeContext(root), taskAllowance: allowance,
      actionEvidence: { journal, retrieval }, sessionRunner })
    expect(first.nodes.check!.attempts.at(-1)!.outcome).toBe("evidence_unavailable")
    expect(allowance.status(taskAllowance)).toMatchObject({ reserved: 1, producer_reserved: 1, verification_reserved: 0 })
    const resumed = loadRun(root, run.run_id)!
    prepareRunForResume(resumed)
    const afterResume = await executeRun(resumed, { ...executeContext(root), operation: "resume", taskAllowance: allowance,
      actionEvidence: { journal, retrieval }, sessionRunner })
    expect(afterResume.nodes.implement!.attempts).toHaveLength(1)
    expect(afterResume.nodes.implement!.current_attempt).toBe(1)
    expect(afterResume.nodes.check!.attempts).toHaveLength(2)
    expect(afterResume.nodes.check!.attempts.at(-1)!.outcome).toBe("evidence_unavailable")
    expect(roles).toEqual(["implementer"])
    expect(allowance.status(taskAllowance)).toMatchObject({ reserved: 1, producer_reserved: 1, verification_reserved: 0 })
  })

  test("a mixed mechanical/semantic contract retains the fresh checker", async () => {
    const root = project(), graph = getTemplate("coding-compact")
    const canonical = 'Mechanical action: first recorded bash command is exactly "echo expected"; its linked terminal exit code equals 7.'
    const input = contract({ evidence_plan: [{ criterion: 1, observations: [{ kind: "action" }] },
        { criterion: 2, observations: [{ kind: "review", rationale: "semantic adequacy" }] }] })
    const criteria = [canonical, "The result is substantively correct"]
    const sourceText = criteria.join("\n")
    const snapshot = TaskRequestSnapshotSchema.parse({ status: "captured", session_id: "session-owner", message_id: "user-original",
      text: sourceText, text_sha256: createHash("sha256").update(sourceText).digest("hex"), text_transformed: false, non_text_parts: 0 })
    const task = bindTaskContract(input, "Verify execution and result", criteria, graph,
      { session_id: "session-owner", message_id: "planner" }, snapshot)
    expect(task.mechanical_verification?.criteria.map(row => row.mode)).toEqual(["mechanical", "semantic"])
    const run = createRun({ goal: "Verify execution and result", criteria, graph, taskContract: task,
      projectDirectory: root, ownerSessionId: "session-owner" })
    const roles: string[] = []
    let checkerPrompt = ""
    await executeRun(run, { ...executeContext(root), sessionRunner: async opts => {
      roles.push(opts.agent)
      if (opts.agent === "implementer") {
        writeFileSync(join(root, "result.json"), "{}")
        const child = "implement-child"
        return { session_id: child, text: "", parsed: output, execution_evidence: {
          version: 1, run_id: run.run_id, node_id: "implement", attempt: 1, child_session_id: child,
          retrieval_status: "available", commands: [{ tool: "bash", command: "true", tool_status: "completed",
            exit_code_status: "reported", exit_code: 0, output_truncated: false, command_truncated: false, cwd_truncated: false }],
          omitted_commands: 0, window_may_be_incomplete: false, foreign_messages_omitted: 0,
        } }
      }
      checkerPrompt = opts.userPrompt
      return { session_id: "semantic-checker", text: "", parsed: { passed: true, failures: [], score: 10, findings: [
        { criterion_id: "C2", outcome: "supported", evidence_ids: ["E1"], reason: "semantic assessment" },
      ] } }
    } })
    expect(roles).toEqual(["implementer", "checker"])
    expect(checkerPrompt).toContain("HOST-DERIVED MECHANICAL FINDINGS (fixed criterion IDs")
    expect(checkerPrompt).toContain('"criterion_id":"C1"')
    expect(checkerPrompt).toContain("They do not establish deliverable content, preservation, change scope, semantic correctness, causation")
    expect(checkerPrompt).toContain("Assess only the semantic criteria listed above")
    expect(run.nodes.check!.attempts[0]!.session_id).toBe("semantic-checker")
    expect(run.nodes.check!.attempts[0]!.output).toMatchObject({ passed: false, score: 0, findings: [
      { criterion_id: "C1", outcome: "inconclusive", evidence_ids: [] },
      { criterion_id: "C2", outcome: "supported" },
    ] })
  })

  test("host user request survives persistence, compaction and both child handoffs without trusting a shortened summary", async () => {
    const root = project(), graph = getTemplate("coding-compact")
    const text = 'Prepare only. The later result requires fields numerator, denominator, rate, window, sources, conflicts, limitations. Its project phase field is "qc". Do not write the final report yet.'
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
    expect(compact).toContain("ALG delivery phase=preparation")
    expect(compact).toContain("preparation permits only declared preparation deliverables")
    expect(compact).not.toContain(text)
    const roles: string[] = []
    await executeRun(restored, { ...executeContext(root), sessionRunner: async opts => {
      roles.push(opts.agent)
      expect(opts.userPrompt).toContain(JSON.stringify(text))
      expect(opts.userPrompt).toContain("preparation permits only declared preparation deliverables")
      expect(opts.userPrompt).toContain("It does not set domain phase, stage, or checkpoint fields")
      expect(opts.userPrompt).toContain("Report substantive conflicts with accepted criteria or deliverables")
      if (opts.agent === "implementer") writeFileSync(join(root, "result.json"), "{}")
      return { session_id: "child", text: "", parsed: opts.agent === "checker" ? { passed: true, score: 10, failures: [] } : output }
    } })
    expect(roles).toEqual(["implementer", "checker"])
    const mutated = loadRun(root, run.run_id)!
    expect(mutated.status).toBe("done")
    expect(mutated.task_contract?.input.phase).toBe("preparation")
    expect(JSON.parse(readFileSync(join(root, "result.json"), "utf8"))).toEqual({})
    mutated.task_contract!.request_snapshot = { status: "unavailable", reason: "no_text" }
    expect(() => assertTaskState(mutated)).toThrow("task_contract_drift")
    expect(() => persistRun(mutated, root)).toThrow()
    expect(loadRun(root, run.run_id)!.task_contract!.request_snapshot).toEqual(snapshot)
  })

  test("complete ALG delivery preserves a user's project phase field", async () => {
    const root = project(), graph = getTemplate("coding-compact")
    const text = 'Update the project output and preserve its schema field phase: "qc".'
    const snapshot = TaskRequestSnapshotSchema.parse({ status: "captured", session_id: "session-owner", message_id: "user-original",
      text, text_sha256: createHash("sha256").update(text).digest("hex"), text_transformed: false, non_text_parts: 0 })
    const task = bindTaskContract(contract({ phase: "complete" }), "Update result.json", ["Produce result.json"], graph,
      { session_id: "session-owner", message_id: "assistant-plan" }, snapshot)
    const run = createRun({ goal: "Update result.json", criteria: ["Produce result.json"], graph,
      taskContract: task, projectDirectory: root, ownerSessionId: "session-owner" })
    const roles: string[] = []
    await executeRun(run, { ...executeContext(root), sessionRunner: async opts => {
      roles.push(opts.agent)
      expect(opts.userPrompt).toContain("ALG delivery scope only")
      expect(opts.userPrompt).toContain("complete requires the declared task")
      expect(opts.userPrompt).toContain(JSON.stringify(text))
      if (opts.agent === "implementer") {
        writeFileSync(join(root, "result.json"), '{"phase":"qc"}')
      }
      return { session_id: "child", text: "", parsed: opts.agent === "checker" ? { passed: true, score: 10, failures: [] } : output }
    } })
    expect(roles).toEqual(["implementer", "checker"])
    const restored = loadRun(root, run.run_id)!
    expect(restored.status).toBe("done")
    expect(restored.task_contract).toEqual(task)
    expect(JSON.parse(readFileSync(join(root, "result.json"), "utf8"))).toEqual({ phase: "qc" })
  })

  for (const phase of ["preparation", "complete"] as const) {
    for (const source of ["captured", "unavailable", "legacy"] as const) {
      test(`${phase} delivery scope reaches both roles with ${source} request text`, () => {
        const graph = getTemplate("coding-compact"), goal = "Produce result.json", criteria = [goal]
        const text = 'Use the requested project field phase: "qc".'
        const snapshot = source === "legacy" ? undefined : TaskRequestSnapshotSchema.parse(source === "captured"
          ? { status: "captured", session_id: "session-owner", message_id: "user-original", text,
            text_sha256: createHash("sha256").update(text).digest("hex"), text_transformed: false, non_text_parts: 0 }
          : { status: "unavailable", reason: "no_text" })
        const task = bindTaskContract(contract({ phase }), goal, criteria, graph,
          { session_id: "session-owner", message_id: "accepted" }, snapshot)
        const prompts = [
          buildWorkerPrompt({ taskContract: task, goal, criteria, agent: "implementer", inputs: {}, priorFailures: [] }),
          buildCheckerPrompt({ taskContract: task, criteria, claimed: output }),
        ]
        for (const prompt of prompts) {
          expect(prompt).toContain(JSON.stringify(task.input))
          expect(prompt.match(/task_contract\.phase controls ALG delivery scope only/g)).toHaveLength(1)
          expect(prompt).toContain("preparation permits only declared preparation deliverables")
          expect(prompt).toContain("complete requires the declared task")
          expect(prompt).toContain("It does not set domain phase, stage, or checkpoint fields; preserve their requested values")
          expect(prompt).toContain("Report substantive conflicts with accepted criteria or deliverables; do not widen scope or permissions")
          if (source === "captured") expect(prompt).toContain(JSON.stringify(text))
          else {
            expect(prompt).toContain(`USER REQUEST SOURCE: unavailable (${source === "legacy" ? "legacy" : "no_text"})`)
            expect(prompt).not.toContain("qc")
          }
        }
      })
    }
  }

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


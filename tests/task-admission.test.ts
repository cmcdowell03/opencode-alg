import { afterEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createAlgTools } from "../src/tools.ts"
import { loadRunForOwner } from "../src/store.ts"
import type { TaskContractInput } from "../src/task-contract.ts"
import { removeProject, tempProject } from "./helpers.ts"

const projects: string[] = []
afterEach(() => { for (const project of projects.splice(0)) removeProject(project) })
function fixture() {
  const project = tempProject("alg-admission-tools-"); projects.push(project)
  let edit: "allow" | "deny" = "allow", childCalls = 0, agentLookups = 0
  const client = { app: { log: async () => ({}), agents: async () => { agentLookups++; return {
    data: [
      { name: "implementer", tools: { edit: true, bash: true }, permission: { edit, bash: { "*": "allow" } } },
      { name: "checker", tools: { read: true }, permission: { read: "allow" } },
    ] } } },
    session: { create: async () => { childCalls++; throw Error("unexpected model call") } } }
  const tools = createAlgTools({ client, directory: project, worktree: project } as never)
  const context = { sessionID: "owner", messageID: "message", agent: "orchestrator", directory: project, worktree: project,
    abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any
  const task = { version: 1 as const, kind: "project_change" as const, discovery: "not_required" as const, phase: "preparation" as const,
    deliverables: [{ destination: "project_file" as const, path: "preparation.md", producer_node: "implement" }],
    verification: { checker_node: "check", execution: "none" as const }, preserve_paths: [],
    evidence_plan: [{ criterion: 1, observations: [{ kind: "deliverable" as const, index: 0 }] }] }
  return { project, tools, context, task, client, deny: () => { edit = "deny" }, calls: () => ({ childCalls, agentLookups }) }
}
function data(result: unknown): any { return JSON.parse((result as { output: string }).output) }
describe("tool task contract admission", () => {
  test("planning captures the actual host user turn rather than trusting a lossy planner summary", async () => {
    const f = fixture(), lookups: string[] = []
    const text = "Prepare only. Final schema: numerator, denominator, rate, window, sources, conflicts, limitations."
    Object.assign(f.client.session, { message: async ({ path }: any) => {
      lookups.push(path.messageID)
      return { data: path.messageID === "message"
        ? { info: { id: "message", sessionID: "owner", role: "assistant", parentID: "original-user" }, parts: [] }
        : { info: { id: "original-user", sessionID: "owner", role: "user" }, parts: [{ type: "text", text }] } }
    } })
    const result = data(await f.tools.alg_plan.execute({ goal: "Prepare according to required schema", criteria: ["Write preparation.md"], task_contract: f.task }, f.context))
    expect(result.error).toBeUndefined()
    expect(lookups).toEqual(["message", "original-user"])
    const saved = loadRunForOwner(f.project, result.run_id, "owner")!
    expect(saved.task_contract!.request_snapshot).toMatchObject({ status: "captured", text, message_id: "original-user" })
    expect(result.task_admission.request_source.status).toBe("captured")
    Object.assign(f.client.session, { message: async () => { throw new Error("later source unavailable") } })
    const status = data(await f.tools.alg_status.execute({ run_id: result.run_id, detail: "full" }, f.context))
    expect(status.task_contract.request_snapshot).toEqual(saved.task_contract!.request_snapshot)
    expect(f.calls().childCalls).toBe(0)
  })

  test("new plans cannot silently omit contracts or original criteria", async () => {
    const f = fixture()
    expect(data(await f.tools.alg_plan.execute({ goal: "Write preparation" }, f.context)).error).toContain("task_contract_required")
    expect(data(await f.tools.alg_plan.execute({ goal: "Write preparation", task_contract: f.task }, f.context)).error).toContain("task_criteria_required")
    const withoutEvidence: TaskContractInput = structuredClone(f.task)
    delete withoutEvidence.evidence_plan
    expect(data(await f.tools.alg_plan.execute({ goal: "Write preparation", criteria: ["Create preparation.md"],
      task_contract: withoutEvidence }, f.context)).error).toContain("task_evidence_plan_required")
    expect(f.calls()).toEqual({ childCalls: 0, agentLookups: 0 })
    expect(existsSync(join(f.project, ".opencode", "runs"))).toBe(false)
  })
  test("impossible producer is rejected without effective-permission or child calls", async () => {
    const f = fixture()
    const task = { ...f.task, deliverables: [{ ...f.task.deliverables[0]!, producer_node: "research" }] }
    const result = data(await f.tools.alg_plan.execute({ goal: "Write preparation", criteria: ["Create preparation.md"],
      template: "research-diamond", task_contract: task }, f.context))
    expect(result.error).toContain("task_write_capability_missing")
    expect(f.calls()).toEqual({ childCalls: 0, agentLookups: 0 })
    expect(existsSync(join(f.project, ".opencode", "runs"))).toBe(false)
  })
  test("known writes admit compact work and keep source and contract through status", async () => {
    const f = fixture()
    const result = data(await f.tools.alg_plan.execute({ goal: "Write preparation", criteria: ["Create preparation.md", "Stop before the report"],
      task_contract: { ...f.task, evidence_plan: [
        { criterion: 1, observations: [{ kind: "deliverable", index: 0 }] },
        { criterion: 2, observations: [{ kind: "review", rationale: "The fixture verifies planning stops before report generation." }] },
      ] } }, f.context))
    expect(result.error).toBeUndefined(); expect(result.template).toBe("coding-compact")
    expect(result.task_admission.phase).toBe("preparation")
    expect(result.task_admission.request_source).toEqual({ status: "unavailable", reason: "unsupported" })
    const run = loadRunForOwner(f.project, result.run_id, "owner")!
    expect(run.task_contract?.source).toEqual({ session_id: "owner", message_id: "message", authority: "accepted-planner-declaration" })
    const status = data(await f.tools.alg_status.execute({ run_id: result.run_id }, f.context))
    expect(status.task_admission.contract_sha256).toBe(run.task_contract!.contract_sha256)
    expect(f.calls().childCalls).toBe(0); expect(run.global_attempts).toBe(0)
  })
  test("host denial blocks before creation and changed permissions block before execution", async () => {
    const f = fixture()
    f.deny()
    const denied = data(await f.tools.alg_plan.execute({ goal: "Write preparation", criteria: ["Create preparation.md"], task_contract: f.task }, f.context))
    expect(denied.error).toContain("task_host_capability_deny")
    expect(existsSync(join(f.project, ".opencode", "runs"))).toBe(false)
    const g = fixture()
    const admitted = data(await g.tools.alg_plan.execute({ goal: "Write preparation", criteria: ["Create preparation.md"], task_contract: g.task }, g.context))
    g.deny()
    const result = data(await g.tools.alg_run.execute({ run_id: admitted.run_id }, g.context))
    expect(result.error).toContain("task_host_capability_deny")
    expect(loadRunForOwner(g.project, admitted.run_id, "owner")!.global_attempts).toBe(0)
    expect(g.calls().childCalls).toBe(0)
  })
  test("criteria cannot be weakened by the legacy unlock switch", async () => {
    const f = fixture()
    const admitted = data(await f.tools.alg_plan.execute({ goal: "Write preparation", criteria: ["Create preparation.md"], task_contract: f.task }, f.context))
    const result = data(await f.tools.alg_criteria.execute({ run_id: admitted.run_id, criteria: ["Say done"], lock: false }, f.context))
    expect(result.error).toContain("task_contract_locked")
    expect(loadRunForOwner(f.project, admitted.run_id, "owner")!.criteria).toEqual(["Create preparation.md"])
  })
})


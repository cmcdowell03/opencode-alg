import { createOpencodeClient } from "@opencode-ai/sdk"
import { createAlgTools } from "../src/tools.ts"
import { loadRunForOwner } from "../src/store.ts"
import type { TaskContractInput } from "../src/task-contract.ts"

/** Real host capability lookup through the public ALG tool path; no model call. */
export async function runTaskAdmissionHostProbe(baseUrl: string, project: string, parentSessionId: string) {
  const client = createOpencodeClient({ baseUrl })
  let lookups = 0, childCalls = 0
  const agents = client.app.agents.bind(client.app)
  client.app.agents = (async (...args: Parameters<typeof agents>) => {
    lookups++
    return agents(...args)
  }) as typeof client.app.agents
  client.session.create = (async () => { childCalls++; throw new Error("admission probe must not create a child") }) as typeof client.session.create
  const tools = createAlgTools({ client, directory: project, worktree: project } as any,
    () => ({ implementer: { providerID: "alg-headless", modelID: "deterministic" }, checker: { providerID: "alg-headless", modelID: "deterministic" } }))
  const context = { sessionID: parentSessionId, messageID: "headless-task-admission", agent: "orchestrator", directory: project, worktree: project,
    abort: AbortSignal.timeout(15_000), metadata: () => {}, ask: async () => { throw new Error("admission probe must not request permissions") } } as any
  const task: TaskContractInput = { version: 1, kind: "project_change", discovery: "not_required", phase: "preparation",
    deliverables: [{ destination: "project_file", path: "admission-probe.json", producer_node: "implement" }],
    verification: { checker_node: "check", execution: "host_command", execution_node: "implement" }, preserve_paths: [] }
  const unpack = (result: unknown) => JSON.parse((result as { output: string }).output)
  const criteria = ["Prepare admission-probe.json and execute its validation; do not continue to a final report"]
  const plan = unpack(await tools.alg_plan.execute({ goal: "Synthetic task admission only", criteria, task_contract: task }, context))
  if (plan.error) throw new Error(`Host task admission failed: ${plan.error}`)
  const saved = loadRunForOwner(project, plan.run_id, parentSessionId)!
  const unlock = unpack(await tools.alg_criteria.execute({ run_id: plan.run_id, criteria: ["Weakened"], lock: false }, context))
  const incompatible = unpack(await tools.alg_plan.execute({ goal: "Synthetic incompatible plan", criteria, template: "research-diamond",
    task_contract: { ...task, deliverables: [{ ...task.deliverables[0]!, producer_node: "research" }] } }, context))
  const immutable = unlock.error?.includes("task_contract_locked") === true &&
    JSON.stringify(loadRunForOwner(project, plan.run_id, parentSessionId)!.criteria) === JSON.stringify(criteria)
  const rejected = incompatible.error?.includes("task_write_capability_missing") === true
  return { passed: lookups === 1 && childCalls === 0 && saved.global_attempts === 0 && immutable && rejected && plan.template === "coding-compact",
    run_id: plan.run_id as string, host_permissions_checked: lookups === 1, criteria_immutable: immutable,
    incompatible_graph_rejected: rejected, child_calls: childCalls,
    scope: "Actual host permission lookup and durable planning only; no file creation, command execution or model-quality claim." }
}

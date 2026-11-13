import { z } from "zod"
import { sha256Json } from "./persistence.ts"
import { isSafeId, isSafeProjectRelativePath } from "./paths.ts"
import type { GraphDef, RunState } from "./types.ts"
import { TaskRequestSnapshotSchema, type TaskRequestSnapshot } from "./task-request.ts"
import { ChangeScopeInputSchema } from "./change-scope-evidence.ts"

const id = z.string().min(1).max(64).refine(isSafeId)
const path = z.string().min(1).max(512).refine(value => isSafeProjectRelativePath(value) &&
  !/^\.opencode\/runs(?:\/|$)/i.test(value))
const observation = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("deliverable"), index: z.number().int().min(0).max(15) }).strict(),
  z.object({ kind: z.literal("execution") }).strict(),
  z.object({ kind: z.literal("preservation"), paths: z.array(path).min(1).max(8) }).strict(),
  z.object({ kind: z.literal("change_scope") }).strict(),
  z.object({ kind: z.literal("review"), rationale: z.string().trim().min(1).max(500) }).strict(),
])
const EvidencePlanSchema = z.array(z.object({
  criterion: z.number().int().min(1).max(64),
  observations: z.array(observation).min(1).max(8),
}).strict()).min(1).max(64)
/** Declared scope, not an assertion that the planner understood the user's request. */
export const TaskContractInputSchema = z.object({
  version: z.literal(1),
  kind: z.enum(["read_only", "project_change", "mixed"]),
  discovery: z.enum(["required", "not_required"]),
  phase: z.enum(["preparation", "complete"]),
  deliverables: z.array(z.object({
    destination: z.enum(["response", "run_artifact", "project_file"]),
    producer_node: id,
    path: path.optional(),
  }).strict().superRefine((item, ctx) => {
    if ((item.destination === "project_file") !== (item.path !== undefined))
      ctx.addIssue({ code: "custom", message: "only project_file deliverables require a project-relative path" })
  })).min(1).max(16),
  verification: z.object({
    checker_node: id,
    execution: z.enum(["none", "host_command", "shell_gate"]),
    execution_node: id.optional(),
  }).strict().superRefine((value, ctx) => {
    if ((value.execution !== "none") !== (value.execution_node !== undefined))
      ctx.addIssue({ code: "custom", message: "execution_node is required only for execution evidence" })
  }),
  preserve_paths: z.array(path).max(8),
  // Optional only for compatibility with already admitted runs. New plans require it.
  evidence_plan: EvidencePlanSchema.optional(),
  change_scope: ChangeScopeInputSchema.optional(),
}).strict().superRefine((task, ctx) => {
  if (task.evidence_plan && Buffer.byteLength(JSON.stringify(task), "utf8") > 16 * 1024)
    ctx.addIssue({ code: "custom", message: "new task declaration exceeds 16 KiB; keep the evidence plan bounded" })
  const paths = task.deliverables.flatMap(d => d.path ? [d.path] : [])
  const declaredPaths = [...paths, ...task.preserve_paths].map(item => process.platform === "win32" ? item.toLowerCase() : item)
  if (declaredPaths.some((item, index) => declaredPaths.slice(index + 1)
    .some(other => other === item || other.startsWith(item + "/") || item.startsWith(other + "/")))) {
    ctx.addIssue({ code: "custom", message: "deliverable and protected file paths must be distinct" })
  }
  const artifactProducers = task.deliverables.filter(d => d.destination === "run_artifact").map(d => d.producer_node)
  if (new Set(artifactProducers).size !== artifactProducers.length)
    ctx.addIssue({ code: "custom", message: "one run artifact may be declared per producer" })
  if ((task.kind === "read_only" && paths.length) || (task.kind !== "read_only" && !paths.length))
    ctx.addIssue({ code: "custom", message: "work kind must agree with declared project-file deliverables" })
})
export type TaskContractInput = z.infer<typeof TaskContractInputSchema>
export const TaskContractSchema = z.object({
  version: z.literal(1),
  input: TaskContractInputSchema,
  source: z.object({ session_id: z.string().min(1).max(256), message_id: z.string().min(1).max(256),
    authority: z.literal("accepted-planner-declaration") }).strict(),
  requirements_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contract_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  request_snapshot: TaskRequestSnapshotSchema.optional(),
}).strict().superRefine((task, ctx) => {
  if (task.request_snapshot?.status === "captured" && task.request_snapshot.session_id !== task.source.session_id)
    ctx.addIssue({ code: "custom", message: "request snapshot belongs to another session" })
})
export type TaskContract = z.infer<typeof TaskContractSchema>

export function parseTaskContractInput(value: unknown): TaskContractInput {
  const parsed = TaskContractInputSchema.safeParse(value)
  if (!parsed.success) throw new Error("task_contract_invalid: provide kind, discovery, phase, deliverables, verification and preserve_paths; paths must be normalized and distinct")
  return parsed.data
}
export function taskTemplate(input: TaskContractInput): "coding-compact" | "coding-diamond" | "research-diamond" {
  return input.kind === "read_only" ? "research-diamond" : input.discovery === "not_required" ? "coding-compact" : "coding-diamond"
}
function ancestor(graph: GraphDef, source: string, target: string, visited = new Set<string>()): boolean {
  if (visited.has(target)) return false
  visited.add(target)
  return graph.nodes.find(n => n.id === target)?.depends_on.some(id => id === source || ancestor(graph, source, id, visited)) ?? false
}
/** Static role policy never grants host permissions or evaluates wildcard rules. */
export function assertTaskGraph(input: TaskContractInput, graph: GraphDef): void {
  if (input.kind === "read_only" && graph.nodes.some(n => n.agent === "implementer" || n.agent === "shell"))
    throw new Error("task_read_only_mismatch: read-only work cannot admit project-write or shell roles")
  const checker = graph.nodes.find(n => n.id === input.verification.checker_node)
  if (!checker || checker.agent !== "checker" || checker.isolated_check !== true)
    throw new Error("task_checker_required: nominate a fresh checker node")
  for (const deliverable of input.deliverables) {
    const producer = graph.nodes.find(n => n.id === deliverable.producer_node)
    if (!producer || producer.agent === "shell" || producer.agent === "checker")
      throw new Error("task_producer_invalid: nominate a worker node for each deliverable")
    if (!ancestor(graph, producer.id, checker.id)) throw new Error("task_checker_disconnected: checker must depend on every deliverable producer")
    if (deliverable.destination !== "response" && producer.agent !== "implementer")
      throw new Error("task_write_capability_missing: file deliverables require an implementer; choose a coding graph")
  }
  const verifier = input.verification
  if (verifier.execution !== "none") {
    const execution = graph.nodes.find(n => n.id === verifier.execution_node)
    if (!execution || !ancestor(graph, execution.id, checker.id)) throw new Error("task_execution_disconnected: execution evidence must precede the checker")
    if (verifier.execution === "host_command" && execution.agent !== "implementer")
      throw new Error("task_execution_capability_missing: host commands require an implementer")
    if (verifier.execution === "shell_gate" && (!execution.shell_gate ||
      (execution.agent !== "shell" && execution.loop?.gate !== "shell" && execution.loop?.gate !== "all")))
      throw new Error("task_gate_required: nominate a configured shell gate")
  }
  if (input.preserve_paths.length) {
    const snapshots = graph.nodes.filter(n => n.agent === "implementer" && n.inputs?.preserve_paths)
    if (snapshots.length !== 1 || snapshots[0]!.inputs!.preserve_paths !== JSON.stringify(input.preserve_paths) ||
      !ancestor(graph, snapshots[0]!.id, checker.id)) throw new Error("task_preservation_required: bind protected paths to one implementer before checking")
  }
}
export function bindTaskContract(input: TaskContractInput, goal: string, criteria: string[], graph: GraphDef,
  source: { session_id: string; message_id: string }, requestSnapshot?: TaskRequestSnapshot): TaskContract {
  if (!criteria.length) throw new Error("task_criteria_required: supply the original acceptance criteria before planning")
  assertEvidencePlan(input, criteria.length)
  assertTaskGraph(input, graph)
  const base = { version: 1 as const, input, source: { ...source, authority: "accepted-planner-declaration" as const },
    requirements_sha256: sha256Json({ goal, criteria }),
    ...(requestSnapshot ? { request_snapshot: TaskRequestSnapshotSchema.parse(requestSnapshot) } : {}) }
  return TaskContractSchema.parse({ ...base, contract_sha256: sha256Json(base) })
}
export function assertTaskState(run: Pick<RunState, "task_contract" | "goal" | "criteria" | "criteria_locked" | "graph">): void {
  const contract = run.task_contract
  if (!contract) return // Old persisted runs remain explicitly unqualified.
  const { contract_sha256, ...base } = contract
  if (!run.criteria_locked || !run.criteria.length || sha256Json(base) !== contract_sha256 ||
    contract.requirements_sha256 !== sha256Json({ goal: run.goal, criteria: run.criteria }))
    throw new Error("task_contract_drift: original criteria, goal and contract are immutable")
  assertTaskGraph(contract.input, run.graph)
  assertEvidencePlan(contract.input, run.criteria.length)
}

/** Validates declared observation coverage, not the semantic adequacy of that declaration. */
export function assertEvidencePlan(input: TaskContractInput, count: number, required = false): void {
  const plan = input.evidence_plan
  if (!plan) {
    if (required || input.change_scope) throw new Error("task_evidence_plan_required: map each original criterion to observations before planning")
    return
  }
  if (plan.length !== count || plan.some((row, index) => row.criterion !== index + 1))
    throw new Error("task_evidence_coverage: include exactly one ordered row per original criterion")
  for (const row of plan) for (const item of row.observations) {
    if ((item.kind === "deliverable" && !input.deliverables[item.index]) ||
      (item.kind === "execution" && input.verification.execution === "none") ||
      (item.kind === "preservation" && (new Set(item.paths).size !== item.paths.length || item.paths.some(p => !input.preserve_paths.includes(p)))) ||
      (item.kind === "change_scope" && !input.change_scope))
      throw new Error("task_evidence_binding: observation must name a declared deliverable, command, protected path or change scope")
  }
}

export type HostCapability = "allow" | "deny" | "ask" | "unknown"
/** Only uniform host decisions are recognized. Scoped/wildcard decisions stay unknown. */
export function uniformCapability(permission: unknown, name: string): HostCapability {
  const action = (value: unknown): HostCapability => value === "allow" || value === "deny" || value === "ask" ? value : "unknown"
  if (Array.isArray(permission)) {
    if (permission.some(rule => !rule || typeof rule.permission !== "string" ||
      (rule.permission !== "*" && /[*?]/.test(rule.permission)))) return "unknown"
    const relevant = permission.filter(r => r.permission === name || r.permission === "*")
    if (!relevant.length || relevant.some(r => r.pattern !== "*")) return "unknown"
    return action(relevant.at(-1)?.action)
  }
  if (!permission || typeof permission !== "object") return "unknown"
  if (!Object.hasOwn(permission, name)) return "unknown"
  const value = (permission as Record<string, unknown>)[name]
  if (typeof value === "string") return action(value)
  if (value && typeof value === "object" && Object.keys(value).length === 1 && Object.hasOwn(value, "*"))
    return action((value as Record<string, unknown>)["*"])
  return "unknown"
}
export function assertTaskHostCapabilities(input: TaskContractInput, graph: GraphDef, agents: unknown): void {
  const requirements: Array<{ node: string; capability: "edit" | "bash" | "read" | "glob" }> = input.deliverables
    .filter(d => d.destination !== "response").map(d => ({ node: d.producer_node, capability: "edit" }))
  if (input.verification.execution === "host_command") requirements.push({ node: input.verification.execution_node!, capability: "bash" })
  if (input.evidence_plan && (input.deliverables.some(d => d.destination !== "response") ||
    input.preserve_paths.length || input.change_scope))
    requirements.push({ node: input.verification.checker_node, capability: "read" })
  if (input.change_scope) requirements.push({ node: input.verification.checker_node, capability: "glob" })
  for (const requirement of requirements) {
    const role = graph.nodes.find(n => n.id === requirement.node)?.agent
    const matches = Array.isArray(agents) ? agents.filter(a => a && a.name === role) : []
    const agent = matches.length === 1 ? matches[0] : undefined
    const enabled = agent?.tools?.[requirement.capability] !== false
    const result = enabled ? uniformCapability(agent?.permission, requirement.capability) : "deny"
    if (result !== "allow") throw new Error(`task_host_capability_${result}: required ${requirement.capability} capability is not uniformly allowed; resolve the host prerequisite`)
  }
}
export function taskContractSummary(run: Pick<RunState, "task_contract">) {
  const task = run.task_contract
  return task ? { status: "declared-and-admitted", contract_sha256: task.contract_sha256,
    requirements_sha256: task.requirements_sha256, phase: task.input.phase, kind: task.input.kind,
    deliverables: task.input.deliverables, verification: task.input.verification,
    evidence_plan: task.input.evidence_plan ?? "legacy-unqualified",
    change_scope: task.input.change_scope,
    request_source: task.request_snapshot?.status === "captured"
      ? { status: "captured", message_id: task.request_snapshot.message_id, text_sha256: task.request_snapshot.text_sha256,
        text_transformed: task.request_snapshot.text_transformed, non_text_parts: task.request_snapshot.non_text_parts,
        scope: "Current user turn text only; not the full conversation or attachments." }
      : task.request_snapshot ?? { status: "legacy-unavailable" },
    scope: "Planner-declared scope. Host permissions are rechecked at execution; admission is not completion or user-intent certification." }
    : { status: "legacy-unqualified" }
}

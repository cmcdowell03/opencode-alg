import { z } from "zod"
import { sha256Json } from "./persistence.ts"
import { isSafeProjectRelativePath } from "./paths.ts"
import type { RunState } from "./types.ts"
import type { TaskContract } from "./task-contract.ts"
import { projectFileDigest, finishPreservationEvidence } from "./preservation-evidence.ts"

export const MAX_TASK_EVIDENCE_BYTES = 32 * 1024
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const safePath = z.string().max(1_024).refine(isSafeProjectRelativePath)
const TaskEvidenceSchema = z.object({
  contract_sha256: digest,
  requirements_sha256: digest,
  phase: z.enum(["preparation", "complete"]),
  deliverables: z.array(z.object({
    index: z.number().int().nonnegative(),
    destination: z.enum(["response", "project_file", "run_artifact"]),
    producer_node: z.string().min(1).max(64),
    path: safePath.optional(),
    sha256: digest.optional(),
    status: z.enum(["producer_complete", "producer_incomplete", "present", "unavailable"]),
  }).strict()).max(16),
  execution: z.enum(["not_required", "successful_command_observed", "unavailable"]),
  execution_sha256: digest.optional(),
  preservation: z.array(z.object({
    path: safePath, status: z.enum(["pending", "unchanged", "changed", "unavailable"]), sha256: digest.optional(),
  }).strict()).max(8),
  failures: z.array(z.string().max(256)).max(25),
  scope: z.string().max(256),
}).strict()
export type TaskEvidence = z.infer<typeof TaskEvidenceSchema>

const scope = "File digests and command observations. Test relevance and substantive correctness remain checker criteria."

export function assertTaskEvidence(value: unknown, contract: TaskContract, runId: string): void {
  const evidence = TaskEvidenceSchema.parse(value)
  const { input } = contract
  if (evidence.contract_sha256 !== contract.contract_sha256 || evidence.requirements_sha256 !== contract.requirements_sha256 ||
    evidence.phase !== input.phase || evidence.failures.length || evidence.scope !== scope ||
    evidence.deliverables.length !== input.deliverables.length ||
    evidence.deliverables.some((item, index) => {
      const expected = input.deliverables[index]!
      return item.index !== index || item.destination !== expected.destination || item.producer_node !== expected.producer_node ||
        (expected.destination === "response" ? item.status !== "producer_complete" || item.path !== undefined || !item.sha256 :
          item.status !== "present" || !item.sha256 || (expected.destination === "project_file" ? item.path !== expected.path :
            !isDeliverableArtifactPath(runId, item.path)))
    }) ||
    evidence.preservation.length !== input.preserve_paths.length ||
    evidence.preservation.some((item, index) => item.path !== input.preserve_paths[index] || item.status !== "unchanged" || !item.sha256) ||
    (input.verification.execution === "none" ? evidence.execution !== "not_required" || evidence.execution_sha256 !== undefined :
      evidence.execution !== "successful_command_observed" || !evidence.execution_sha256)) {
    throw new Error("task evidence does not bind the accepted contract")
  }
}

function isDeliverableArtifactPath(runId: string, path: unknown): path is string {
  const prefix = `.opencode/runs/${runId}/artifacts/`
  return typeof path === "string" && isSafeProjectRelativePath(path) && path.startsWith(prefix) &&
    !/^task-evidence-|-attempt-\d+(?:-output-[a-f0-9]{64})?\.json$/i.test(path.slice(prefix.length))
}

/** Bounded host observations of the declared requirements. */
export function taskEvidence(run: Pick<RunState, "task_contract" | "graph" | "nodes" | "run_id" | "project_directory">): TaskEvidence | undefined {
  const contract = run.task_contract
  if (!contract) return undefined
  const input = contract.input
  const failures: string[] = []
  const deliverables = input.deliverables.map((item, index): TaskEvidence["deliverables"][number] => {
    const base = { index, destination: item.destination, producer_node: item.producer_node }
    const producer = run.nodes[item.producer_node]
    if (producer?.status !== "done" || producer.output === undefined) {
      failures.push(`task_deliverable_incomplete: deliverable ${index + 1} needs a completed producer`)
      return { ...base, status: "producer_incomplete" }
    }
    if (item.destination === "response") return { ...base, status: "producer_complete", sha256: sha256Json(producer.output) }
    try {
      const path = item.destination === "project_file" ? item.path :
        (producer.output as { artifact_path?: unknown } | undefined)?.artifact_path
      if (typeof path !== "string" || (item.destination === "run_artifact" && !isDeliverableArtifactPath(run.run_id, path)))
        throw new Error("unavailable artifact")
      return { ...base, path, sha256: projectFileDigest(run.project_directory, path), status: "present" }
    } catch {
      failures.push(`task_deliverable_unavailable: deliverable ${index + 1} needs a contained regular file within the 1 MiB evidence limit`)
      return { ...base, status: "unavailable" }
    }
  })
  const verification = input.verification
  let execution: TaskEvidence["execution"] = "not_required"
  let execution_sha256: string | undefined
  if (verification.execution !== "none") {
    const node = run.nodes[verification.execution_node!]
    const attempt = node?.attempts.find(a => a.attempt === node.current_attempt)
    const shell = verification.execution === "shell_gate"
    const receipt = shell ? attempt?.gate_evidence : attempt?.execution_evidence
    const valid = node?.status === "done" && attempt?.status === "done" && receipt?.run_id === run.run_id &&
      receipt.node_id === verification.execution_node && receipt.retrieval_status === "available" &&
      (shell ? receipt.attempt === attempt.attempt && receipt.child_session_id === undefined :
        receipt.attempt === (attempt.reused_output_from ?? attempt.attempt) && !!receipt.child_session_id &&
        (attempt.reused_output_from !== undefined || receipt.child_session_id === attempt.session_id))
    if (valid && receipt.commands.some(c => c.tool === (shell ? "shell_gate" : "bash") &&
      (!shell || c.gate_ok === true) && c.tool_status === "completed" && c.exit_code_status === "reported" &&
      c.exit_code === 0 && !c.timed_out && !c.cancelled && !c.setup_failed && !c.termination_failed)) {
      execution = "successful_command_observed"
      execution_sha256 = sha256Json(receipt)
    } else {
      execution = "unavailable"
      failures.push("task_execution_unavailable: required successful command evidence is missing; model claims cannot replace it")
    }
  }
  const source = run.graph.nodes.find(n => n.agent === "implementer" && n.inputs?.preserve_paths)
  const node = source ? run.nodes[source.id] : undefined
  const receipt = node?.attempts.find(a => a.attempt === node.current_attempt)?.preservation_evidence
  const current = node?.status === "done" && receipt ? finishPreservationEvidence(run.project_directory, receipt).files : []
  const preservation = input.preserve_paths.map((path, index) => {
    const file = current.find(f => f.path === path)
    if (!file || file.status !== "unchanged") failures.push(`task_preservation_unverified: protected file ${index + 1} lacks unchanged host evidence`)
    return { path, status: file?.status ?? "unavailable" as const, ...(file?.after_sha256 ? { sha256: file.after_sha256 } : {}) }
  })
  return { contract_sha256: contract.contract_sha256, requirements_sha256: contract.requirements_sha256,
    phase: input.phase, deliverables, execution, ...(execution_sha256 ? { execution_sha256 } : {}), preservation, failures, scope }
}


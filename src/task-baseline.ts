import { z } from "zod"
import { sha256Json } from "./persistence.ts"
import { PreservationEvidenceSchema, capturePreservationBasis } from "./preservation-evidence.ts"
import { ChangeScopeBasisSchema, captureChangeScopeBasis } from "./change-scope-evidence.ts"
import type { TaskContract } from "./task-contract.ts"

/** One bounded record in the existing transactional run store; never recaptured on retry. */
export const TaskBaselineSchema = z.object({
  version: z.literal(1),
  contract_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  preservation: PreservationEvidenceSchema.optional(),
  change_scope: ChangeScopeBasisSchema.optional(),
}).strict().refine(value => Buffer.byteLength(JSON.stringify(value), "utf8") <= 192 * 1024,
  "task baseline exceeds byte limit")
export type TaskBaseline = z.infer<typeof TaskBaselineSchema>

export function assertTaskBaseline(value: TaskBaseline, contract: TaskContract): void {
  const baseline = TaskBaselineSchema.parse(value), input = contract.input
  if (!input.evidence_plan || baseline.contract_sha256 !== contract.contract_sha256 ||
    JSON.stringify(baseline.preservation?.files.map(f => f.path) ?? []) !== JSON.stringify(input.preserve_paths) ||
    baseline.preservation?.files.some(f => f.status !== "pending") ||
    !!baseline.change_scope !== !!input.change_scope ||
    (input.change_scope && baseline.change_scope?.scope_sha256 !== sha256Json(input.change_scope)))
    throw new Error("task_baseline_invalid: original before-work observations do not bind the contract")
}

export function captureTaskBaseline(root: string, contract: TaskContract): TaskBaseline {
  const input = contract.input
  const value = TaskBaselineSchema.parse({ version: 1, contract_sha256: contract.contract_sha256,
    ...(input.preserve_paths.length ? { preservation: capturePreservationBasis(root, input.preserve_paths) } : {}),
    ...(input.change_scope ? { change_scope: captureChangeScopeBasis(root, input.change_scope) } : {}),
  })
  assertTaskBaseline(value, contract)
  return value
}

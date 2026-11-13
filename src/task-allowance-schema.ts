import { createHash } from "node:crypto"
import { z } from "zod"

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const IsoTime = z.iso.datetime({ offset: true })

// Kept local to avoid importing persistence -> schemas -> this module cycles.
function canonicalJson(value: unknown): string {
  const canonicalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(canonicalize)
    if (input && typeof input === "object") {
      const result: Record<string, unknown> = Object.create(null)
      for (const key of Object.keys(input).sort()) {
        const item = (input as Record<string, unknown>)[key]
        if (item !== undefined) result[key] = canonicalize(item)
      }
      return result
    }
    return input
  }
  const json = JSON.stringify(canonicalize(value))
  if (json === undefined) throw new Error("value is not JSON serializable")
  return json
}

/** Matches persistence.sha256Json while remaining dependency-cycle free. */
export function taskAllowanceSha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")
}

export const TaskAllowancePolicySchema = z.object({
  max_dispatches: z.number().int().min(1).max(256).default(128),
  verification_reserve: z.number().int().min(1).max(256).default(8),
  max_elapsed_ms: z.number().int().min(1_000).max(2_592_000_000).optional(),
}).strict().superRefine((policy, ctx) => {
  if (policy.verification_reserve > policy.max_dispatches)
    ctx.addIssue({ code: "custom", path: ["verification_reserve"], message: "verification reserve cannot exceed max dispatches" })
})
export type TaskAllowancePolicy = z.infer<typeof TaskAllowancePolicySchema>

export const TaskAllowanceReferenceSchema = z.object({
  schema_version: z.literal(1),
  task_id: Hash,
  root_owner: z.string().min(1).max(256),
  policy_sha256: Hash,
}).strict()
export type TaskAllowanceReference = z.infer<typeof TaskAllowanceReferenceSchema>

export const TaskAllowanceEntrySchema = z.object({
  key: Hash,
  kind: z.enum(["producer", "verification"]),
  claimed_at: IsoTime,
}).strict()
export type TaskAllowanceEntry = z.infer<typeof TaskAllowanceEntrySchema>

export const TaskAllowanceStateSchema = z.object({
  reference: TaskAllowanceReferenceSchema,
  policy: TaskAllowancePolicySchema,
  first_contract_sha256: Hash,
  created_at: IsoTime,
  entries: z.array(TaskAllowanceEntrySchema).max(256),
}).strict().superRefine((state, ctx) => {
  if (state.reference.policy_sha256 !== taskAllowanceSha256Json(state.policy))
    ctx.addIssue({ code: "custom", path: ["reference", "policy_sha256"], message: "policy hash does not match pinned policy" })
  const keys = new Set<string>()
  let producers = 0
  let previousTime = Date.parse(state.created_at)
  for (const [index, entry] of state.entries.entries()) {
    if (keys.has(entry.key)) ctx.addIssue({ code: "custom", path: ["entries", index, "key"], message: "duplicate reservation key" })
    keys.add(entry.key)
    const time = Date.parse(entry.claimed_at)
    if (time < Date.parse(state.created_at) || time < previousTime)
      ctx.addIssue({ code: "custom", path: ["entries", index, "claimed_at"], message: "reservations must be chronological and follow creation" })
    previousTime = time
    if (entry.kind === "producer") producers++
  }
  if (state.entries.length > state.policy.max_dispatches)
    ctx.addIssue({ code: "custom", path: ["entries"], message: "reservation count exceeds dispatch bound" })
  if (producers > state.policy.max_dispatches - state.policy.verification_reserve)
    ctx.addIssue({ code: "custom", path: ["entries"], message: "producer reservations exceed the protected verification reserve" })
})
export type TaskAllowanceState = z.infer<typeof TaskAllowanceStateSchema>

type AllowanceCheckpoint = {
  owner: string
  delegation?: { parent_owner: string; role: "worker" | "checker" } | null
  task_allowance_ref?: TaskAllowanceReference
  task_allowance?: TaskAllowanceState
}

/** Guard the checkpoint's allowance fields during every checkpoint transition. */
export function assertTaskAllowanceTransition(prior: AllowanceCheckpoint, next: AllowanceCheckpoint): void {
  const beforeRef = prior.task_allowance_ref && TaskAllowanceReferenceSchema.parse(prior.task_allowance_ref)
  const afterRef = next.task_allowance_ref && TaskAllowanceReferenceSchema.parse(next.task_allowance_ref)
  const beforeState = prior.task_allowance && TaskAllowanceStateSchema.parse(prior.task_allowance)
  const afterState = next.task_allowance && TaskAllowanceStateSchema.parse(next.task_allowance)

  if (beforeRef && !afterRef) throw new Error("task allowance reference is immutable")
  if (beforeState && !afterState) throw new Error("task allowance ledger cannot be removed")
  if (afterState && !afterRef) throw new Error("orphan task allowance ledger")
  if (beforeRef && afterRef && taskAllowanceSha256Json(beforeRef) !== taskAllowanceSha256Json(afterRef))
    throw new Error("task allowance reference cannot be replaced")

  if (afterState) {
    if (!afterRef || taskAllowanceSha256Json(afterState.reference) !== taskAllowanceSha256Json(afterRef))
      throw new Error("task allowance ledger/reference mismatch")
    if (afterState.reference.root_owner !== next.owner)
      throw new Error("delegated owner cannot own a task allowance ledger")
  }
  if (afterRef?.root_owner === next.owner && !afterState)
    throw new Error("task allowance root reference requires its ledger")
  if (beforeState && afterState) {
    if (taskAllowanceSha256Json({ reference: beforeState.reference, policy: beforeState.policy,
      first_contract_sha256: beforeState.first_contract_sha256, created_at: beforeState.created_at }) !==
      taskAllowanceSha256Json({ reference: afterState.reference, policy: afterState.policy,
        first_contract_sha256: afterState.first_contract_sha256, created_at: afterState.created_at }))
      throw new Error("task allowance header is immutable")
    if (afterState.entries.length < beforeState.entries.length ||
      beforeState.entries.some((entry, index) => taskAllowanceSha256Json(entry) !== taskAllowanceSha256Json(afterState.entries[index])))
      throw new Error("task allowance entries are append-only")
  }
  if (afterRef && afterRef.root_owner !== next.owner) {
    if (next.delegation)
      throw new Error("delegated worker/checker cannot receive a task allowance alias")
    if (afterState) throw new Error("delegated owner cannot own a task allowance ledger")
  }
  if (next.delegation && afterRef)
    throw new Error("delegated worker/checker cannot receive a task allowance alias")
}

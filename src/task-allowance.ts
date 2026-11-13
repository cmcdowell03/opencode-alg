import { randomUUID } from "node:crypto"
import type { NodeDef, RunState } from "./types.ts"
import { awaitFirstLock, isLockContention } from "./filesystem-mutex.ts"
import type { MemoryStore } from "./session-memory/store.ts"
import type { Checkpoint } from "./session-memory/schemas.ts"
import {
  assertTaskAllowanceTransition,
  TaskAllowancePolicySchema,
  TaskAllowanceReferenceSchema,
  TaskAllowanceStateSchema,
  taskAllowanceSha256Json,
  type TaskAllowancePolicy,
  type TaskAllowanceReference,
  type TaskAllowanceState,
} from "./task-allowance-schema.ts"

type AllowanceStore = Pick<MemoryStore, "checkpoint" | "empty" | "update">
type Dispatch = { node: NodeDef; attempt: number }
// A crashed writer's unexpired checkpoint lease lasts 30 seconds. This only
// waits for the existing mutex to become eligible; it never takes over early.
const CHECKPOINT_WAIT_MS = 35_000
const CHECKPOINT_WAIT_SLICE_MS = 250

function requireActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("task_allowance_cancelled")
}

/** Retry only when the checkpoint mutation callback has not begun. */
async function waitCheckpointUpdate<T>(operation: (entered: () => void) => T, deadline: number, signal?: AbortSignal): Promise<T> {
  while (true) {
    requireActive(signal)
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("task_allowance_checkpoint_wait_exhausted")
    let entered = false
    let postMutationContention: unknown
    try {
      return await awaitFirstLock(() => {
        try {
          return operation(() => {
            requireActive(signal)
            entered = true
          })
        } catch (error) {
          // The shared waiter retries contention internally. Once mutation has
          // begun, hide that error from it so a possibly committed write cannot
          // run twice; restore the original error at this boundary.
          if (entered && isLockContention(error)) {
            postMutationContention = error
            throw new Error("task_allowance_post_mutation_contention", { cause: error })
          }
          throw error
        }
      }, Math.min(CHECKPOINT_WAIT_SLICE_MS, remaining))
    } catch (error) {
      if (postMutationContention) throw postMutationContention
      // A failure after mutation begins may have committed the head. Never replay it.
      if (entered || !isLockContention(error)) throw error
      if (Date.now() >= deadline) throw new Error("task_allowance_checkpoint_wait_exhausted", { cause: error })
    }
  }
}

function checkPoint(store: AllowanceStore, owner: string): Checkpoint {
  const value = store.checkpoint(owner) ?? store.empty(owner)
  if (value.owner !== owner) throw new Error("task allowance checkpoint owner mismatch")
  if (value.deleted) throw new Error("task allowance owner is deleted")
  return value
}

function assertRootLedger(checkpoint: Checkpoint, reference: TaskAllowanceReference): TaskAllowanceState {
  const parsedRef = TaskAllowanceReferenceSchema.parse(checkpoint.task_allowance_ref)
  const state = TaskAllowanceStateSchema.parse(checkpoint.task_allowance)
  if (checkpoint.owner !== reference.root_owner || checkpoint.delegation ||
    taskAllowanceSha256Json(parsedRef) !== taskAllowanceSha256Json(reference) ||
    taskAllowanceSha256Json(state.reference) !== taskAllowanceSha256Json(reference))
    throw new Error("task allowance root ledger/reference mismatch")
  return state
}

function existingAdmission(store: AllowanceStore, owner: string, checkpoint: Checkpoint): TaskAllowanceReference | undefined {
  if (checkpoint.delegation) throw new Error("delegated owners cannot admit task allowances")
  if (!checkpoint.task_allowance_ref) {
    if (checkpoint.task_allowance) throw new Error("orphan task allowance ledger")
    return undefined
  }
  const reference = TaskAllowanceReferenceSchema.parse(checkpoint.task_allowance_ref)
  if (checkpoint.task_allowance) return assertRootLedger(checkpoint, reference).reference
  if (reference.root_owner === owner) throw new Error("orphan task allowance root reference")
  assertRootLedger(checkPoint(store, reference.root_owner), reference)
  return reference
}

export interface TaskAllowanceStatus {
  task_id: string
  root_owner: string
  policy: TaskAllowancePolicy
  first_contract_sha256: string
  reserved: number
  producer_reserved: number
  verification_reserved: number
  remaining_total: number
  remaining_producer: number
  deadline_at?: string
  elapsed_ms: number
  accounting_note: "reservations_not_exact_provider_calls; provider_root_compaction_usage_unavailable"
}

/** A per-root task dispatch ledger persisted in the existing session checkpoint. */
export class TaskAllowanceRuntime {
  private readonly policy: TaskAllowancePolicy

  constructor(private readonly store: MemoryStore, policy: unknown = {}, private readonly now: () => number = Date.now) {
    this.policy = TaskAllowancePolicySchema.parse(policy)
  }

  async admit(owner: string, contractSha: string, signal?: AbortSignal): Promise<TaskAllowanceReference> {
    if (!/^[a-f0-9]{64}$/.test(contractSha)) throw new Error("invalid first task contract hash")
    let checkpoint = checkPoint(this.store, owner)
    const existing = existingAdmission(this.store, owner, checkpoint)
    if (existing) return existing

    // Generate exactly once outside the retry loop. A revision race cannot mint a second task id.
    const policy = TaskAllowancePolicySchema.parse(this.policy)
    const reference = TaskAllowanceReferenceSchema.parse({ schema_version: 1,
      task_id: taskAllowanceSha256Json({ host_uuid: randomUUID() }), root_owner: owner,
      policy_sha256: taskAllowanceSha256Json(policy) })
    const createdAt = new Date(this.now()).toISOString()
    const state = TaskAllowanceStateSchema.parse({ reference, policy,
      first_contract_sha256: contractSha, created_at: createdAt, entries: [] })
    const deadline = Date.now() + CHECKPOINT_WAIT_MS

    for (let retry = 0; retry < 8; retry++) {
      checkpoint = checkPoint(this.store, owner)
      const admitted = existingAdmission(this.store, owner, checkpoint)
      if (admitted) return admitted
      try {
        await waitCheckpointUpdate((entered) => this.store.update(owner, checkpoint.revision, (current) => {
          entered()
          if (current.delegation || current.deleted) throw new Error("task allowance owner is not an active root")
          if (current.task_allowance_ref || current.task_allowance) throw new Error("task allowance admission raced")
          const next = { ...current, task_allowance_ref: reference, task_allowance: state }
          assertTaskAllowanceTransition(current, next)
          return next
        }), deadline, signal)
        return reference
      } catch (error) {
        if (error instanceof Error && /revision conflict/i.test(error.message)) {
          if (retry < 7) continue
          throw new Error("task_allowance_checkpoint_conflict", { cause: error })
        }
        // A concurrent first admission may have committed before reporting a stale revision.
        const latest = checkPoint(this.store, owner)
        const admitted = existingAdmission(this.store, owner, latest)
        if (admitted) return admitted
        throw error
      }
    }
    throw new Error("task_allowance_checkpoint_conflict")
  }

  async attach(owner: string, reference: TaskAllowanceReference, signal?: AbortSignal): Promise<void> {
    const ref = TaskAllowanceReferenceSchema.parse(reference)
    if (owner === ref.root_owner) {
      assertRootLedger(checkPoint(this.store, ref.root_owner), ref)
      return
    }
    const child = checkPoint(this.store, owner)
    if (child.delegation) throw new Error("delegated worker/checker cannot receive a task allowance alias")
    if (child.task_allowance) throw new Error("task allowance alias cannot own a task allowance ledger")
    if (child.task_allowance_ref && taskAllowanceSha256Json(child.task_allowance_ref) !== taskAllowanceSha256Json(ref))
      throw new Error("continuation already has a different task allowance")
    const root = checkPoint(this.store, ref.root_owner)
    assertRootLedger(root, ref)
    if (child.task_allowance_ref) {
      return
    }
    const deadline = Date.now() + CHECKPOINT_WAIT_MS
    for (let retry = 0; retry < 8; retry++) {
      const current = checkPoint(this.store, owner)
      if (current.delegation) throw new Error("delegated worker/checker cannot receive a task allowance alias")
      if (current.task_allowance) throw new Error("task allowance alias cannot own a task allowance ledger")
      if (current.task_allowance_ref) {
        if (taskAllowanceSha256Json(current.task_allowance_ref) !== taskAllowanceSha256Json(ref))
          throw new Error("continuation already has a different task allowance")
        assertRootLedger(checkPoint(this.store, ref.root_owner), ref)
        return
      }
      try {
        await waitCheckpointUpdate((entered) => this.store.update(owner, current.revision, (value) => {
          entered()
          if (value.deleted || value.delegation || value.task_allowance || value.task_allowance_ref)
            throw new Error("task allowance alias changed during attach")
          const next = { ...value, task_allowance_ref: ref }
          assertTaskAllowanceTransition(value, next)
          return next
        }), deadline, signal)
        assertRootLedger(checkPoint(this.store, ref.root_owner), ref)
        return
      } catch (error) {
        if (error instanceof Error && /revision conflict/i.test(error.message) && retry < 7) continue
        throw error
      }
    }
    throw new Error("task_allowance_checkpoint_conflict")
  }

  async reserve(run: RunState, dispatches: readonly Dispatch[], signal?: AbortSignal): Promise<void> {
    const reference = TaskAllowanceReferenceSchema.parse(run.task_allowance)
    if (!dispatches.length) return
    const owner = run.owner_session_id
    const ownerCheckpoint = checkPoint(this.store, owner)
    if (ownerCheckpoint.delegation || !ownerCheckpoint.task_allowance_ref ||
      taskAllowanceSha256Json(ownerCheckpoint.task_allowance_ref) !== taskAllowanceSha256Json(reference))
      throw new Error("run owner is not attached to the same task allowance")
    if (owner !== reference.root_owner && ownerCheckpoint.task_allowance)
      throw new Error("task allowance alias cannot own a task allowance ledger")

    const checkerId = run.task_contract?.input.verification.checker_node
    const pending = new Map<string, "producer" | "verification">()
    for (const { node, attempt } of dispatches) {
      // Shell/gate execution is not a model dispatch and has no provider allowance cost.
      if (node.agent === "shell") continue
      const nodeState = run.nodes[node.id]
      if (!nodeState || !Number.isInteger(attempt) || attempt !== nodeState.current_attempt + 1)
        throw new Error(`task allowance dispatch attempt is not prospective for ${node.id}`)
      const key = taskAllowanceSha256Json({ run_id: run.run_id, node_id: node.id, attempt })
      const kind = node.id === checkerId && node.agent === "checker" && node.isolated_check === true ? "verification" : "producer"
      const previous = pending.get(key)
      if (previous && previous !== kind) throw new Error("duplicate reservation key has conflicting kinds")
      pending.set(key, kind)
    }
    const claims = [...pending].map(([key, kind]) => ({ key, kind }))
    if (!claims.length) return
    const deadline = Date.now() + CHECKPOINT_WAIT_MS

    for (let retry = 0; retry < 8; retry++) {
      const root = checkPoint(this.store, reference.root_owner)
      try {
        await waitCheckpointUpdate((entered) => this.store.update(reference.root_owner, root.revision, (current) => {
          entered()
          const state = assertRootLedger(current, reference)
          const timestamp = this.now()
          const lastTime = state.entries.length ? Date.parse(state.entries[state.entries.length - 1]!.claimed_at) : Date.parse(state.created_at)
          if (timestamp < lastTime || timestamp < Date.parse(state.created_at))
            throw new Error("task allowance clock moved before the last reservation")
          if (state.policy.max_elapsed_ms !== undefined && timestamp - Date.parse(state.created_at) >= state.policy.max_elapsed_ms)
            throw new Error("task allowance elapsed-time limit exhausted")

          const known = new Map(state.entries.map((entry) => [entry.key, entry.kind]))
          for (const claim of claims) {
            const kind = known.get(claim.key)
            if (kind && kind !== claim.kind) throw new Error("task_allowance_reservation_kind_mismatch")
          }
          const fresh = claims.filter((claim) => !known.has(claim.key))
          if (state.entries.length + fresh.length > state.policy.max_dispatches)
            throw new Error("task_allowance_exhausted")
          const existingProducers = state.entries.filter((entry) => entry.kind === "producer").length
          const newProducers = fresh.filter((claim) => claim.kind === "producer").length
          if (existingProducers + newProducers > state.policy.max_dispatches - state.policy.verification_reserve)
            throw new Error("task_allowance_verification_reserved")
          const entries = [...state.entries, ...fresh.map((claim) => ({ ...claim, claimed_at: new Date(timestamp).toISOString() }))]
          const nextState = TaskAllowanceStateSchema.parse({ ...state, entries })
          const next = { ...current, task_allowance: nextState }
          assertTaskAllowanceTransition(current, next)
          return next
        }), deadline, signal)
        return
      } catch (error) {
        if (error instanceof Error && /revision conflict/i.test(error.message)) {
          if (retry < 7) continue
          throw new Error("task_allowance_checkpoint_conflict", { cause: error })
        }
        throw error
      }
    }
    throw new Error("task_allowance_checkpoint_conflict")
  }

  status(reference: TaskAllowanceReference): TaskAllowanceStatus {
    const ref = TaskAllowanceReferenceSchema.parse(reference)
    const state = assertRootLedger(checkPoint(this.store, ref.root_owner), ref)
    const producer = state.entries.filter((entry) => entry.kind === "producer").length
    const verification = state.entries.length - producer
    const timestamp = this.now()
    const elapsed = Math.max(0, timestamp - Date.parse(state.created_at))
    return {
      task_id: ref.task_id, root_owner: ref.root_owner, policy: state.policy,
      first_contract_sha256: state.first_contract_sha256, reserved: state.entries.length,
      producer_reserved: producer, verification_reserved: verification,
      remaining_total: state.policy.max_dispatches - state.entries.length,
      remaining_producer: Math.min(state.policy.max_dispatches - state.entries.length,
        state.policy.max_dispatches - state.policy.verification_reserve - producer),
      ...(state.policy.max_elapsed_ms === undefined ? {} : { deadline_at: new Date(Date.parse(state.created_at) + state.policy.max_elapsed_ms).toISOString() }),
      elapsed_ms: elapsed,
      accounting_note: "reservations_not_exact_provider_calls; provider_root_compaction_usage_unavailable",
    }
  }
}

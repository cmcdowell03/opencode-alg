import { describe, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { acquireFilesystemMutex, FilesystemMutexContentionError, FilesystemMutexRecordSchema } from "../src/filesystem-mutex.ts"
import type { MemoryStore } from "../src/session-memory/store.ts"
import { MemoryStore as FileMemoryStore } from "../src/session-memory/store.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import type { NodeDef, RunState } from "../src/types.ts"
import { assertTaskAllowanceTransition, TaskAllowancePolicySchema, TaskAllowanceStateSchema } from "../src/task-allowance-schema.ts"
import { TaskAllowanceRuntime } from "../src/task-allowance.ts"
import { taskAllowanceSha256Json } from "../src/task-allowance-schema.ts"

type FakeCheckpoint = {
  owner: string; revision: number; deleted: boolean
  delegation: { parent_owner: string; parent_checkpoint: string; role: "worker" | "checker" } | null
  task_allowance_ref?: any; task_allowance?: any
}

class CheckpointHarness {
  readonly values = new Map<string, FakeCheckpoint>()
  checkpoint(owner: string) { return structuredClone(this.values.get(owner) ?? null) }
  empty(owner: string): FakeCheckpoint { return { owner, revision: 0, deleted: false, delegation: null } }
  update(owner: string, revision: number, mutate: (value: any) => any) {
    const prior = this.values.get(owner) ?? this.empty(owner)
    if (prior.revision !== revision) throw new Error("checkpoint revision conflict")
    const candidate = mutate(structuredClone(prior)) as FakeCheckpoint
    assertTaskAllowanceTransition(prior, candidate)
    const next = { ...candidate, owner, revision: revision + 1 }
    this.values.set(owner, structuredClone(next))
    return structuredClone(next)
  }
  seed(value: FakeCheckpoint) { this.values.set(value.owner, structuredClone(value)) }
  store() { return this as unknown as MemoryStore }
}

const sha = (value: string) => taskAllowanceSha256Json(value)
function node(id: string, agent: NodeDef["agent"], isolated_check = false): NodeDef {
  return { id, agent, depends_on: [], isolated_check }
}
function run(owner: string, reference: any, nodes: NodeDef[], checker = "check"): RunState {
  return {
    schema_version: 2, revision: 1, run_id: "run-1", owner_session_id: owner, parent_session_id: owner,
    owner_transfers: [], project_directory: ".", goal: "goal", criteria: ["done"], criteria_locked: true,
    graph: { name: "g", nodes, max_global_attempts: 10, max_concurrency: 4 }, status: "running", phase: "execute",
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, { id: entry.id, agent: entry.agent, status: "ready",
      attempts: [], current_attempt: 0, last_failures: [] }])), global_attempts: 0, created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(), mode: "live", model_snapshot: {}, session_isolation: "sdk-child-session",
    task_contract: { input: { verification: { checker_node: checker } } } as never,
    task_allowance: reference,
  } as unknown as RunState
}

describe("bounded task allowance", () => {
  test("policy defaults, strict keys, and reserve equality", () => {
    expect(TaskAllowancePolicySchema.parse({})).toEqual({ max_dispatches: 128, verification_reserve: 8 })
    expect(TaskAllowancePolicySchema.parse({ max_dispatches: 1, verification_reserve: 1 })).toEqual({ max_dispatches: 1, verification_reserve: 1 })
    expect(TaskAllowancePolicySchema.safeParse({ extra: true }).success).toBe(false)
    expect(TaskAllowancePolicySchema.safeParse({ max_dispatches: 2, verification_reserve: 3 }).success).toBe(false)
  })

  test("admission binds one root task and survives task replan/beginTask transitions", async () => {
    const store = new CheckpointHarness()
    let clock = Date.parse("2026-01-01T00:00:00.000Z")
    const runtime = new TaskAllowanceRuntime(store.store(), { max_dispatches: 4, verification_reserve: 1 }, () => clock)
    const first = await runtime.admit("root", sha("contract-a"))
    const same = await runtime.admit("root", sha("contract-b"))
    expect(same).toEqual(first)
    expect(runtime.status(first).first_contract_sha256).toBe(sha("contract-a"))
    const before = store.checkpoint("root")!
    store.update("root", before.revision, (value) => ({ ...value, task_epoch: 99, goal: "new plan" }))
    expect(runtime.status(first).task_id).toBe(first.task_id)
    expect(store.checkpoint("root")?.task_allowance_ref).toEqual(first)
    clock += 1_000
  })

  test("charges producers while retaining the final checker reserve; batch is all-or-none", async () => {
    const store = new CheckpointHarness()
    const runtime = new TaskAllowanceRuntime(store.store(), { max_dispatches: 3, verification_reserve: 1 })
    const reference = await runtime.admit("root", sha("contract"))
    const producer = node("work", "implementer")
    const checker = node("check", "checker", true)
    const state = run("root", reference, [producer, checker])
    await runtime.reserve(state, [{ node: producer, attempt: 1 }])
    await runtime.reserve(state, [{ node: producer, attempt: 1 }]) // pending receipt reuse is idempotent
    expect(runtime.status(reference)).toMatchObject({ reserved: 1, producer_reserved: 1, remaining_producer: 1 })
    const secondProducer = node("work-2", "implementer")
    const thirdProducer = node("work-3", "implementer")
    const batch = run("root", reference, [producer, checker, secondProducer, thirdProducer])
    await expect(runtime.reserve(batch, [{ node: secondProducer, attempt: 1 }, { node: thirdProducer, attempt: 1 }]))
      .rejects.toThrow("task_allowance_verification_reserved")
    expect(runtime.status(reference).reserved).toBe(1)
    const secondProducerState = run("root", reference, [producer, checker])
    ;(secondProducerState.nodes.work as any).current_attempt = 1
    await runtime.reserve(secondProducerState, [{ node: producer, attempt: 2 }])
    expect(runtime.status(reference)).toMatchObject({ reserved: 2, remaining_producer: 0 })
    await expect(runtime.reserve(state, [{ node: checker, attempt: 1 }])).resolves.toBeUndefined()
    expect(runtime.status(reference)).toMatchObject({ reserved: 3, verification_reserved: 1, remaining_total: 0 })
    await expect(runtime.reserve(state, [{ node: checker, attempt: 1 }])).resolves.toBeUndefined()
    await expect(runtime.reserve(run("root", reference, [node("other", "implementer")], "check"),
      [{ node: node("other", "implementer"), attempt: 1 }])).rejects.toThrow()
    expect(runtime.status(reference).reserved).toBe(3)
  })

  test("original isolated checker is verification even without node.verification; shell is excluded", async () => {
    const store = new CheckpointHarness()
    const runtime = new TaskAllowanceRuntime(store.store(), { max_dispatches: 2, verification_reserve: 1 })
    const reference = await runtime.admit("root", sha("contract"))
    const checker = node("check", "checker", true)
    const shell = node("gate", "shell")
    const state = run("root", reference, [checker, shell])
    await runtime.reserve(state, [{ node: checker, attempt: 1 }, { node: shell, attempt: 1 }])
    expect(runtime.status(reference)).toMatchObject({ reserved: 1, verification_reserved: 1, producer_reserved: 0 })
    const ordinaryChecker = node("other-check", "checker", false)
    const producerRun = run("root", reference, [ordinaryChecker], "check")
    await runtime.reserve(producerRun, [{ node: ordinaryChecker, attempt: 1 }])
    expect(runtime.status(reference).producer_reserved).toBe(1)
  })

  test("concurrent runs serialize against the shared root ledger", async () => {
    const store = new CheckpointHarness()
    const runtime = new TaskAllowanceRuntime(store.store(), { max_dispatches: 4, verification_reserve: 1 })
    const reference = await runtime.admit("root", sha("contract"))
    const worker = node("work", "implementer")
    const a = run("root", reference, [worker], "none")
    const b = { ...run("root", reference, [worker], "none"), run_id: "run-2" }
    await Promise.all([runtime.reserve(a, [{ node: worker, attempt: 1 }]), runtime.reserve(b, [{ node: worker, attempt: 1 }])])
    expect(runtime.status(reference)).toMatchObject({ reserved: 2, producer_reserved: 2 })
  })

  test("continuation attaches one hop, cannot replace allowance, and missing roots fail closed", async () => {
    const store = new CheckpointHarness()
    const runtime = new TaskAllowanceRuntime(store.store())
    const reference = await runtime.admit("root", sha("contract"))
    store.seed({ ...store.empty("child"), revision: 1 })
    await runtime.attach("child", reference)
    expect(store.checkpoint("child")?.task_allowance_ref).toEqual(reference)
    expect(store.checkpoint("child")?.task_allowance).toBeUndefined()
    const other = { ...reference, task_id: sha("replacement-task") }
    await expect(runtime.attach("child", other)).rejects.toThrow("different task allowance")
    expect(await runtime.admit("child", sha("replanned-contract"))).toEqual(reference)
    await runtime.attach("root", reference)
    const delegated = { ...store.empty("delegated"), revision: 1,
      delegation: { parent_owner: "root", parent_checkpoint: sha("parent"), role: "worker" as const } }
    store.seed(delegated)
    await expect(runtime.attach("delegated", reference)).rejects.toThrow("delegated worker/checker")
    store.values.delete("root")
    await expect(runtime.attach("new-child", reference)).rejects.toThrow()
  })

  test("delegated and deleted roots cannot admit; mode-off storage needs no other database", async () => {
    const store = new CheckpointHarness()
    store.seed({ ...store.empty("delegated"), revision: 1,
      delegation: { parent_owner: "parent", parent_checkpoint: sha("parent"), role: "checker" } })
    store.seed({ ...store.empty("deleted"), revision: 1, deleted: true })
    const runtime = new TaskAllowanceRuntime(store.store())
    await expect(runtime.admit("delegated", sha("contract"))).rejects.toThrow("delegated")
    await expect(runtime.admit("deleted", sha("contract"))).rejects.toThrow("deleted")
    const reference = await runtime.admit("memory-off-owner", sha("contract"))
    expect(runtime.status(reference).reserved).toBe(0)
  })

  test("elapsed limits and backwards clocks reject without changing reservations", async () => {
    const store = new CheckpointHarness()
    let clock = Date.parse("2026-03-01T00:00:00.000Z")
    const runtime = new TaskAllowanceRuntime(store.store(), { max_dispatches: 3, verification_reserve: 1, max_elapsed_ms: 1_000 }, () => clock)
    const reference = await runtime.admit("root", sha("contract"))
    const worker = node("work", "implementer")
    const state = run("root", reference, [worker], "none")
    clock += 1_000
    await expect(runtime.reserve(state, [{ node: worker, attempt: 1 }])).rejects.toThrow("elapsed-time")
    expect(runtime.status(reference).reserved).toBe(0)

    const noDeadline = new TaskAllowanceRuntime(store.store(), {}, () => clock)
    // A fresh root admits at the current wall-clock, then a rollback is refused.
    const second = await noDeadline.admit("another", sha("contract"))
    const anotherRun = run("another", second, [worker], "none")
    clock -= 1
    await expect(noDeadline.reserve(anotherRun, [{ node: worker, attempt: 1 }])).rejects.toThrow("clock moved")
    expect(noDeadline.status(second).reserved).toBe(0)
  })

  test("state bounds, unique keys, immutable headers, and append-only entries", async () => {
    const store = new CheckpointHarness()
    const runtime = new TaskAllowanceRuntime(store.store(), { max_dispatches: 2, verification_reserve: 1 })
    const reference = await runtime.admit("root", sha("contract"))
    const prior = store.checkpoint("root")!
    const state = prior.task_allowance!
    const entry = { key: sha("entry"), kind: "producer" as const, claimed_at: state.created_at }
    expect(TaskAllowanceStateSchema.safeParse({ ...state, entries: [entry, entry] }).success).toBe(false)
    expect(() => assertTaskAllowanceTransition(prior, { ...prior,
      task_allowance: { ...state, first_contract_sha256: sha("changed-contract") } })).toThrow("header")
    expect(() => assertTaskAllowanceTransition(prior, { ...prior, task_allowance_ref: { ...reference, task_id: sha("replacement") } })).toThrow("replaced")
    const oneEntry = { ...state, entries: [entry] }
    expect(() => assertTaskAllowanceTransition({ ...prior, task_allowance: oneEntry },
      { ...prior, task_allowance: undefined })).toThrow("cannot be removed")
    expect(() => assertTaskAllowanceTransition({ ...prior, task_allowance: oneEntry },
      { ...prior, task_allowance: { ...oneEntry, entries: [] } })).toThrow("append-only")
  })

  test("replay cannot change a charged reservation from producer to verification", async () => {
    const store = new CheckpointHarness()
    const runtime = new TaskAllowanceRuntime(store.store(), { max_dispatches: 3, verification_reserve: 1 })
    const reference = await runtime.admit("root", sha("contract"))
    const review = node("review", "checker", false)
    await runtime.reserve(run("root", reference, [review]), [{ node: review, attempt: 1 }])
    const verified = node("review", "checker", true)
    await expect(runtime.reserve(run("root", reference, [verified], "review"), [{ node: verified, attempt: 1 }]))
      .rejects.toThrow("task_allowance_reservation_kind_mismatch")
    expect(runtime.status(reference)).toMatchObject({ reserved: 1, producer_reserved: 1, verification_reserved: 0 })
  })

  test("real MemoryStore persists root and alias ledgers through task replan", async () => {
    const project = join(process.cwd(), ".test-tmp", `task-allowance-${randomUUID()}`)
    mkdirSync(project, { recursive: true })
    try {
      const store = new FileMemoryStore(project)
      const runtime = new TaskAllowanceRuntime(store, { max_dispatches: 3, verification_reserve: 1 })
      const reference = await runtime.admit("root", sha("first-contract"))
      await runtime.attach("root", reference) // Root execution needs no delegated checkpoint.
      const memory = new SessionMemoryRuntime(project, { mode: "assist" })
      memory.beginTask("root", "same task, next plan")
      expect(memory.store.checkpoint("root")?.task_allowance_ref).toEqual(reference)
      expect(memory.store.checkpoint("root")?.task_allowance?.first_contract_sha256).toBe(sha("first-contract"))

      await runtime.attach("recipient", reference)
      expect(await runtime.admit("recipient", sha("replanned-contract"))).toEqual(reference)
      expect(store.checkpoint("recipient")?.task_allowance).toBeUndefined()
      const worker = node("work", "implementer")
      await runtime.reserve(run("recipient", reference, [worker], "none"), [{ node: worker, attempt: 1 }])
      expect(runtime.status(reference)).toMatchObject({ reserved: 1, producer_reserved: 1 })
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("an unexpired dead writer remains protected until its short lease expires", async () => {
    const project = join(process.cwd(), ".test-tmp", `task-allowance-lease-${randomUUID()}`)
    mkdirSync(project, { recursive: true })
    try {
      const store = new FileMemoryStore(project)
      const runtime = new TaskAllowanceRuntime(store, { max_dispatches: 2, verification_reserve: 1 })
      const reference = await runtime.admit("root", sha("contract"))
      const path = store.path(["writer.lock"], true)
      const now = Date.now()
      const dead = FilesystemMutexRecordSchema.parse({ version: 1, owner: "crashed-writer", token: randomUUID(),
        pid: 999_999_999, host: hostname(), resource: path,
        acquired_at: new Date(now - 500).toISOString(), expires_at: new Date(now + 800).toISOString() })
      writeFileSync(path, JSON.stringify(dead))
      const worker = node("work", "implementer")
      const state = run("root", reference, [worker])
      await runtime.reserve(state, [{ node: worker, attempt: 1 }])
      expect(runtime.status(reference)).toMatchObject({ reserved: 1, producer_reserved: 1 })
      await runtime.reserve(state, [{ node: worker, attempt: 1 }])
      expect(runtime.status(reference).reserved).toBe(1)
    } finally { rmSync(project, { recursive: true, force: true }) }
  }, 10_000)

  test("live writer cancellation stops waiting without a charge; later retry is idempotent", async () => {
    const project = join(process.cwd(), ".test-tmp", `task-allowance-cancel-${randomUUID()}`)
    mkdirSync(project, { recursive: true })
    try {
      const store = new FileMemoryStore(project)
      const runtime = new TaskAllowanceRuntime(store, { max_dispatches: 2, verification_reserve: 1 })
      const reference = await runtime.admit("root", sha("contract"))
      const worker = node("work", "implementer"), state = run("root", reference, [worker])
      const held = acquireFilesystemMutex(store.path(["writer.lock"], true), { owner: "live-writer", leaseMs: 2_000 })
      try {
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), 80)
        try { await expect(runtime.reserve(state, [{ node: worker, attempt: 1 }], abort.signal)).rejects.toThrow("task_allowance_cancelled") }
        finally { clearTimeout(timer) }
        expect(runtime.status(reference).reserved).toBe(0)
      } finally { held.release() }
      await runtime.reserve(state, [{ node: worker, attempt: 1 }])
      await runtime.reserve(state, [{ node: worker, attempt: 1 }])
      expect(runtime.status(reference).reserved).toBe(1)
    } finally { rmSync(project, { recursive: true, force: true }) }
  }, 10_000)

  test("contention reported after checkpoint mutation is never blindly replayed", async () => {
    const harness = new CheckpointHarness()
    const normal = new TaskAllowanceRuntime(harness.store(), { max_dispatches: 2, verification_reserve: 1 })
    const reference = await normal.admit("root", sha("contract"))
    const worker = node("work", "implementer"), state = run("root", reference, [worker])
    const wrapped = {
      checkpoint: harness.checkpoint.bind(harness), empty: harness.empty.bind(harness),
      update(owner: string, revision: number, mutate: (value: any) => any) {
        harness.update(owner, revision, mutate)
        throw new FilesystemMutexContentionError("injected post-commit contention")
      },
    } as unknown as MemoryStore
    const runtime = new TaskAllowanceRuntime(wrapped, { max_dispatches: 2, verification_reserve: 1 })
    await expect(runtime.reserve(state, [{ node: worker, attempt: 1 }])).rejects.toBeInstanceOf(FilesystemMutexContentionError)
    expect(normal.status(reference).reserved).toBe(1)
    await normal.reserve(state, [{ node: worker, attempt: 1 }])
    expect(normal.status(reference).reserved).toBe(1)
  })
})

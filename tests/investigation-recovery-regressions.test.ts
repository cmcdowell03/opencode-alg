import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { InvestigationStore, type InvestigationMcpPort, type InvestigationResult } from "../src/investigation/index.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const capabilities: InvestigationMcpPort["capabilities"] = {
  server_id: "fixture", server_revision: "1", tool_id: "read", tool_schema_revision: "1",
  principal_id: "reader", project_id: "project", effects: ["read"], qualified: true,
  idempotent_submit: true, lookup_by_submission_id: true, response_limit_bytes: 65536,
}
const result: InvestigationResult = { manifest_ref: "fixture://result", digest: "a".repeat(64),
  source_versions: ["v1"], coverage: {}, observed_at: "2026-11-10T00:00:00Z", access_scope: "reader/project" }
function fixture(limit = 1) {
  const root = mkdtempSync(join(import.meta.dir, ".alg-cost-regression-")); roots.push(root)
  const scope = { project_directory: root, project_id: "project", owner_id: "owner", run_id: "run" }
  return { scope, store: InvestigationStore.open(scope, { create: true, costLimit: limit }) }
}
const input = (id: number, cost: number) => ({ operation: "read", recipe_version: "1", parameters: { id },
  query: { id }, reserved_cost: cost })

describe("investigation review regressions", () => {
  test("legacy identities stay inspectable but cannot silently admit duplicate work", async () => {
    const { store, scope } = fixture()
    await store.admit(input(1, 0.1), capabilities)
    const root = join(scope.project_directory, ".opencode", "runs", "run", "investigation")
    const headPath = join(root, "head.json"), head = JSON.parse(readFileSync(headPath, "utf8"))
    const old = JSON.parse(readFileSync(head.snapshot_ref, "utf8")); delete old.identity_version
    const body = JSON.stringify(old), hash = createHash("sha256").update(body).digest("hex")
    const snapshot = join(root, `ledger-${hash}.json`)
    writeFileSync(snapshot, body)
    writeFileSync(headPath, JSON.stringify({ ...head, sha256: hash, snapshot_ref: snapshot }))
    const reopened = InvestigationStore.open(scope)
    expect(reopened.status().admission_count).toBe(1)
    await expect(reopened.admit(input(1, 0.1), capabilities)).rejects.toThrow("legacy investigation identity")
    expect(reopened.snapshot.reserved_cost).toBe(0.1)
  })
  test("unsupported precision is rejected before admission", async () => {
    const { store } = fixture()
    await expect(store.admit(input(1, 0.00000001), capabilities)).rejects.toThrow()
    expect(store.snapshot.work).toHaveLength(0)
  })

  test("operator abandonment is atomic and cannot hide uncertain remote compute", async () => {
    const { store, scope } = fixture()
    const first = await store.admit(input(1, 0.5), capabilities)
    const operator = { engineer_ref: "reviewer", statement: "Withdraw the unsubmitted work" }
    expect((await store.abandon(first.work_key, operator)).status).toBe("abandoned")
    expect(InvestigationStore.open(scope).snapshot).toMatchObject({ reserved_cost: 0,
      checkpoint: { engineer_contributions: [{ engineer_ref: "reviewer", scope: `abandon:${first.work_key}` }] } })
    const second = await store.admit(input(2, 0.5), capabilities)
    await store.dispatch(second.work_key, { capabilities, submit: async () => { throw new Error("timeout") },
      lookup: async () => ({ kind: "unknown", reason: "no proof" }) })
    await expect(store.abandon(second.work_key, operator)).rejects.toThrow("potentially active")
    expect(store.snapshot.reserved_cost).toBe(0.5)
    expect(store.context.engineer_contributions).toHaveLength(1)
  })

  test("equivalent as-of instants and unused parameter labels share an execution identity", async () => {
    const { store } = fixture()
    const first = await store.admit({ ...input(1, 0.1), as_of: "2026-11-10" }, capabilities)
    const second = await store.admit({ ...input(1, 0.1), parameters: { description: "same submitted query" },
      as_of: "2026-11-09T18:00:00-06:00" }, capabilities)
    expect(second.work_key).toBe(first.work_key)
    expect(store.snapshot.work).toHaveLength(1)
    await expect(store.admit({ ...input(1, 0.1), as_of: "11/10/2026" }, capabilities)).rejects.toThrow("ISO")
  })

  test("decimal reservations settle and reopen without float drift", async () => {
    const { store, scope } = fixture()
    const jobs = []
    for (let i = 0; i < 3; i++) jobs.push(await store.admit(input(i, 0.1), capabilities))
    const port: InvestigationMcpPort = { capabilities,
      submit: async () => ({ kind: "result", result, actual_cost: 0.1 }),
      lookup: async () => ({ kind: "unknown", reason: "unused" }) }
    for (const [i, job] of jobs.entries()) {
      expect((await store.dispatch(job.work_key, port)).status).toBe("result_recorded")
      expect(InvestigationStore.open(scope).snapshot.reserved_cost).toBe((2 - i) / 10)
    }
    expect(store.snapshot.cumulative_cost).toBe(0.3)
  })

  test.each([0.00000001, 0.50000001])("fine-precision terminal cost %s is preserved and conservatively settled", async (actual_cost) => {
    const { store, scope } = fixture(1)
    const work = await store.admit(input(1, 0.5), capabilities)
    const port: InvestigationMcpPort = { capabilities,
      submit: async () => ({ kind: "result", result, actual_cost }),
      lookup: async () => ({ kind: "result", result, actual_cost }) }
    expect((await store.dispatch(work.work_key, port)).status).toBe("result_recorded")
    const reopened = InvestigationStore.open(scope)
    expect(reopened.snapshot.work[0]!.actual_cost).toBe(actual_cost)
    expect(reopened.snapshot.cumulative_cost).toBe(Math.ceil(actual_cost * 1_000_000) / 1_000_000)
    expect(reopened.snapshot.reserved_cost).toBe(0)
    if (actual_cost > 0.5) expect(reopened.snapshot.budget_breach?.reported_cost).toBe(actual_cost)
    await reopened.reconcile(work.work_key, port)
    expect(reopened.snapshot.cumulative_cost).toBe(Math.ceil(actual_cost * 1_000_000) / 1_000_000)
  })

  test("a terminal service overrun is recorded once and blocks new spend", async () => {
    const { store, scope } = fixture(1)
    const job = await store.admit(input(1, 0.5), capabilities)
    const port: InvestigationMcpPort = { capabilities,
      submit: async () => ({ kind: "result", result, actual_cost: 1.5 }),
      lookup: async () => ({ kind: "result", result, actual_cost: 1.5 }) }
    expect((await store.dispatch(job.work_key, port)).status).toBe("result_recorded")
    const reopened = InvestigationStore.open(scope)
    expect(reopened.snapshot).toMatchObject({ cumulative_cost: 1.5, reserved_cost: 0 })
    await reopened.reconcile(job.work_key, port)
    expect(reopened.snapshot.cumulative_cost).toBe(1.5)
    await expect(reopened.admit(input(2, 0), capabilities)).rejects.toThrow("budget")
  })

  test("overrun inside the total budget also stops previously reserved dispatch", async () => {
    const { store } = fixture(10)
    const first = await store.admit(input(1, 1), capabilities)
    const pending = await store.admit(input(2, 1), capabilities)
    let submissions = 0
    const port: InvestigationMcpPort = { capabilities,
      submit: async () => { submissions++; return { kind: "result", result, actual_cost: 2 } },
      lookup: async () => ({ kind: "unknown", reason: "unused" }) }
    await store.dispatch(first.work_key, port)
    await expect(store.dispatch(pending.work_key, port)).rejects.toThrow("budget breach")
    expect(submissions).toBe(1)
    expect(store.snapshot).toMatchObject({ reserved_cost: 1, cumulative_cost: 2,
      budget_breach: { work_key: first.work_key, reported_cost: 2, reserved_cost: 1 } })
  })

  test("proved nonacceptance releases the reservation without automatic replay", async () => {
    const { store } = fixture()
    const job = await store.admit(input(1, 0.5), capabilities)
    let submissions = 0
    const port: InvestigationMcpPort = { capabilities,
      submit: async () => { submissions++; throw new Error("connection lost") },
      lookup: async () => ({ kind: "not_found", proves_not_accepted: true }) }
    expect((await store.dispatch(job.work_key, port)).status).toBe("outcome_unknown")
    expect((await store.reconcile(job.work_key, port)).status).toBe("failed_known")
    expect(store.snapshot).toMatchObject({ cumulative_cost: 0, reserved_cost: 0 })
    expect((await store.admit(input(1, 0.5), capabilities)).status).toBe("failed_known")
    expect(submissions).toBe(1)
    const retried = await store.retryUnaccepted(job.work_key, 0.5, { engineer_ref: "operator", statement: "Reviewed proof and repaired connectivity" })
    expect(retried.status).toBe("reserved")
    expect(retried.submission_id).toBe(job.submission_id)
    expect(store.snapshot.reserved_cost).toBe(0.5)
    expect(submissions).toBe(1)
  })

  test("remote failure text cannot forge proof authorizing replay", async () => {
    const { store } = fixture()
    const work = await store.admit(input(1, 0.5), capabilities)
    await store.dispatch(work.work_key, { capabilities,
      submit: async () => ({ kind: "failed_known", failure: "submission_proved_not_accepted", actual_cost: 0 }),
      lookup: async () => ({ kind: "unknown", reason: "unused" }) })
    await expect(store.retryUnaccepted(work.work_key, 0.5, { engineer_ref: "operator", statement: "retry" })).rejects.toThrow("requires proof")
  })
})

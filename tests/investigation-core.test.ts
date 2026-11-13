import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { InvestigationStore, investigationPortIsQualified, type InvestigationMcpPort, type InvestigationSubmission } from "../src/investigation/index.ts"

const roots: string[] = []
const scope = (project_directory: string) => ({ project_directory, project_id: "project-a", owner_id: "owner-a", run_id: "run-a" })
function root() { const value = mkdtempSync(join(import.meta.dir, ".alg-investigation-")); roots.push(value); return value }
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }) })
const capabilities = { server_id: "lake", server_revision: "rev-4", tool_id: "bounded_query", tool_schema_revision: "schema-2",
  principal_id: "owner-a", project_id: "project-a", effects: ["read"], idempotent_submit: true as const,
  lookup_by_submission_id: true as const, response_limit_bytes: 100_000, qualified: true as const }
const workInput = { operation: "query.recipe", recipe_version: "3", parameters: { table: "lot_summary", limit: 50 },
  source_dependencies: ["snapshot:lot-7"], reserved_cost: 10, query: { recipe: "lot_summary", limit: 50 } }
const result = { manifest_ref: "lake-result:abc", digest: "a".repeat(64), source_versions: ["snapshot:lot-7"],
  coverage: { pages: 1, complete: true }, observed_at: "2026-11-09T12:00:00.000Z", access_scope: "owner-a/project-a" }

function fakePort(submit: (request: { submission_id: string; work_key: string; operation: string; query: Record<string, unknown> }) => Promise<InvestigationSubmission>,
  lookup: InvestigationMcpPort["lookup"] = async () => ({ kind: "unknown", reason: "fixture has no lookup" })) {
  return { capabilities, submit, lookup } satisfies InvestigationMcpPort
}

describe("durable investigation core", () => {
  test("oversized persisted metadata is rejected before parsing", () => {
    const location = scope(root())
    InvestigationStore.open(location, { create: true, costLimit: 10 })
    const headPath = join(location.project_directory, ".opencode", "runs", location.run_id, "investigation", "head.json")
    const original = readFileSync(headPath)
    writeFileSync(headPath, Buffer.alloc(8193, 32))
    expect(() => InvestigationStore.open(location)).toThrow("head exceeds size limit")
    writeFileSync(headPath, original)
    writeFileSync(JSON.parse(original.toString()).snapshot_ref, Buffer.alloc(2_000_001, 32))
    expect(() => InvestigationStore.open(location)).toThrow("snapshot exceeds size limit")
  })

  test("source dependency order does not repeat work, but changed source versions do", async () => {
    const store = InvestigationStore.open(scope(root()), { create: true, costLimit: 100 })
    const first = await store.admit({ ...workInput, source_dependencies: ["source-a:1", "source-b:1"] }, capabilities)
    const repeated = await store.admit({ ...workInput, source_dependencies: ["source-b:1", "source-a:1", "source-a:1"] }, capabilities)
    expect(repeated.submission_id).toBe(first.submission_id)
    expect(repeated.validity_key).toBe(first.validity_key)
    const changed = await store.admit({ ...workInput, source_dependencies: ["source-a:2", "source-b:1"] }, capabilities)
    expect(changed.work_key).not.toBe(first.work_key)
    expect(store.snapshot.work).toHaveLength(2)
    expect(store.snapshot.reserved_cost).toBe(20)
  })

  test("survives twenty compaction-style reconstructions and two independent stores", async () => {
    const directory = root(), s = scope(directory)
    let store = InvestigationStore.open(s, { create: true, costLimit: 100 })
    await store.attach("session-a", { owner_id: "owner-a", project_id: "project-a" })
    await store.updateCheckpoint({ objective: "Find excursion source", next_action: "Check lot genealogy" })
    for (let i = 0; i < 20; i++) {
      store = InvestigationStore.open(s)
      await store.updateCheckpoint({ completed_tests: [...store.context.completed_tests, `test-${i}`] })
    }
    const second = InvestigationStore.open(s)
    expect(store.snapshot.revision).toBe(second.snapshot.revision)
    expect(second.context.completed_tests).toHaveLength(20)
    expect(second.snapshot.attachments).toHaveLength(1)
    expect(second.snapshot.scope).toEqual({ project_id: "project-a", owner_id: "owner-a", run_id: "run-a" })
  })

  test("deduplicates concurrent callers and reserves budget once", async () => {
    const s = scope(root()), a = InvestigationStore.open(s, { create: true, costLimit: 10 }), b = InvestigationStore.open(s)
    const [left, right] = await Promise.all([a.admit(workInput, capabilities), b.admit(workInput, capabilities)])
    expect(left.work_key).toBe(right.work_key)
    expect(left.submission_id).toBe(right.submission_id)
    expect(InvestigationStore.open(s).snapshot.work).toHaveLength(1)
    expect(InvestigationStore.open(s).snapshot.reserved_cost).toBe(10)
  })

  test("serializes stale store writers and keys executable query content", async () => {
    const s = scope(root()), first = InvestigationStore.open(s, { create: true, costLimit: 100 }), stale = InvestigationStore.open(s)
    const forkedQuery = { ...workInput, query: { recipe: "different-executable-query", limit: 50 } }
    const [a, b] = await Promise.all([first.admit(workInput, capabilities), stale.admit(forkedQuery, capabilities)])
    expect(a.work_key).not.toBe(b.work_key)
    const [one, two] = await Promise.all([
      first.updateCheckpoint({ completed_tests: ["writer-one"] }),
      stale.updateCheckpoint({ contradictions: ["writer-two"] }),
    ])
    expect(one.completed_tests).toEqual(["writer-one"])
    expect(two.contradictions).toEqual(["writer-two"])
    expect(InvestigationStore.open(s).snapshot.work).toHaveLength(2)
    expect(InvestigationStore.open(s).context).toMatchObject({ completed_tests: ["writer-one"], contradictions: ["writer-two"] })
  })

  test("caps concurrent expensive jobs at two and caps zero-cost admissions", async () => {
    const s = scope(root()), store = InvestigationStore.open(s, { create: true, costLimit: 100, maxAdmissions: 3 })
    const items = await Promise.all([0, 1, 2].map((i) => store.admit({ ...workInput, query: { query: i }, reserved_cost: 0 }, capabilities)))
    expect(await store.dispatch(items[0]!.work_key, fakePort(async () => ({ kind: "running", external_job_id: "j1" })))).toMatchObject({ status: "running" })
    expect(await store.dispatch(items[1]!.work_key, fakePort(async () => ({ kind: "running", external_job_id: "j2" })))).toMatchObject({ status: "running" })
    await expect(store.dispatch(items[2]!.work_key, fakePort(async () => ({ kind: "running", external_job_id: "j3" })))).rejects.toThrow("concurrent")
    await expect(store.admit({ ...workInput, query: { query: 3 }, reserved_cost: 0 }, capabilities)).rejects.toThrow("admission count")
  })

  test("admission preserves space for durable terminal receipts", async () => {
    const store = InvestigationStore.open(scope(root()), { create: true, costLimit: 0 })
    let admitted = 0
    for (let i = 0; i < 100; i++) {
      try { await store.admit({ ...workInput, query: { query: i }, reserved_cost: 0 }, capabilities); admitted++ }
      catch (error) { expect(String(error)).toContain("terminal receipt reserve exhausted"); break }
    }
    expect(admitted).toBeGreaterThan(0)
    expect(admitted).toBeLessThan(100)
    expect(store.snapshot.work).toHaveLength(admitted)
  })

  test("accepted submit with lost response becomes unknown and resume reconciles before proceeding", async () => {
    const s = scope(root()), store = InvestigationStore.open(s, { create: true, costLimit: 10 })
    const admitted = await store.admit(workInput, capabilities)
    let sends = 0, lookups = 0
    const port = fakePort(async () => { sends++; throw new Error("connection lost after server acceptance") }, async (id) => {
      lookups++; expect(id).toBe(admitted.submission_id); return { kind: "running", external_job_id: "job-17" }
    })
    expect((await store.dispatch(admitted.work_key, port)).status).toBe("outcome_unknown")
    expect(await store.reconcileBeforeResume(port)).toEqual({ ready: false, blocked: [{ work_key: admitted.work_key, status: "running" }] })
    expect(sends).toBe(1); expect(lookups).toBe(1)
    const completed = fakePort(async () => { throw new Error("must not dispatch") }, async () => ({ kind: "result", result }))
    expect((await store.reconcile(admitted.work_key, completed)).status).toBe("result_recorded")
    expect(sends).toBe(1)
  })

  test("late submit callback cannot overwrite the newer reconciled result", async () => {
    const s = scope(root()), store = InvestigationStore.open(s, { create: true, costLimit: 10 })
    const item = await store.admit(workInput, capabilities)
    let resolveSubmit!: (value: InvestigationSubmission) => void
    const port = fakePort(() => new Promise<InvestigationSubmission>((resolve) => { resolveSubmit = resolve }),
      async () => ({ kind: "result", result }))
    const dispatch = store.dispatch(item.work_key, port)
    while (!resolveSubmit) await new Promise((resolve) => setTimeout(resolve, 1))
    expect((await store.reconcile(item.work_key, port)).status).toBe("result_recorded")
    resolveSubmit({ kind: "running", external_job_id: "late-job" })
    await expect(dispatch).rejects.toThrow("stale investigation work fence")
    expect(InvestigationStore.open(s).snapshot.work[0]).toMatchObject({ status: "result_recorded", result: { digest: result.digest } })
  })

  test("unknown lookup blocks automatic resend and unqualified transport fails closed", async () => {
    const s = scope(root()), store = InvestigationStore.open(s, { create: true, costLimit: 10 })
    const item = await store.admit(workInput, capabilities)
    let sends = 0
    const ambiguous = fakePort(async () => { sends++; throw new Error("timeout") })
    await store.dispatch(item.work_key, ambiguous)
    expect((await store.reconcile(item.work_key, ambiguous)).status).toBe("outcome_unknown")
    expect((await store.dispatch(item.work_key, ambiguous)).status).toBe("outcome_unknown")
    expect(sends).toBe(1)
    await expect(store.admit(workInput, { ...capabilities, qualified: false } as unknown as typeof capabilities)).rejects.toThrow()
    await expect(store.admit({ ...workInput, parameters: { access_token: "do-not-store" } }, capabilities)).rejects.toThrow("credential")
  })

  test("pins remote service identity separately from the host session identity", async () => {
    const s = scope(root()), store = InvestigationStore.open(s, { create: true, costLimit: 10 })
    const remote = { ...capabilities, principal_id: "service-principal", project_id: "remote-project" }
    const item = await store.admit(workInput, remote)
    const port = { ...fakePort(async () => ({ kind: "result", result })), capabilities: remote,
      validateResult: async () => ({ valid: true, validity_key: item.validity_key, access_scope: result.access_scope }) }
    expect(investigationPortIsQualified(port, s)).toBe(true)
    expect(store.snapshot.remote_profile).toMatchObject({ principal_id: "service-principal", project_id: "remote-project" })
    const different = { ...port, capabilities: { ...remote, principal_id: "different-principal" } }
    await expect(store.dispatch(item.work_key, different)).rejects.toThrow("remote profile mismatch")
    expect((await store.dispatch(item.work_key, port)).status).toBe("result_recorded")
    await expect(store.reconcile(item.work_key, different)).rejects.toThrow("remote profile mismatch")
    await expect(store.getReusableResult(item.work_key, different)).rejects.toThrow("remote profile mismatch")
    await expect(store.admit({ ...workInput, query: { recipe: "new" } }, different.capabilities)).rejects.toThrow("remote profile mismatch")
    expect((await store.getReusableResult(item.work_key, port)).digest).toBe(result.digest)
  })

  test("a late validation cannot restore a result revoked by another caller", async () => {
    const s = scope(root()), store = InvestigationStore.open(s, { create: true, costLimit: 10 })
    const item = await store.admit(workInput, capabilities)
    await store.dispatch(item.work_key, fakePort(async () => ({ kind: "result", result })))
    let resolveValidation!: (value: { valid: boolean; validity_key: string; access_scope: string }) => void
    const delayed = { ...fakePort(async () => { throw new Error("no submit") }),
      validateResult: () => new Promise<{ valid: boolean; validity_key: string; access_scope: string }>((resolve) => { resolveValidation = resolve }) }
    const pending = store.markReusable(item.work_key, delayed)
    while (!resolveValidation) await new Promise((resolve) => setTimeout(resolve, 1))
    const revoked = { ...delayed, validateResult: async () => ({ valid: false, validity_key: item.validity_key, access_scope: "revoked" }) }
    await expect(store.markReusable(item.work_key, revoked)).rejects.toThrow("validity")
    resolveValidation({ valid: true, validity_key: item.validity_key, access_scope: result.access_scope })
    await expect(pending).rejects.toThrow("stale investigation work fence")
    expect(store.snapshot.work[0]?.status).toBe("stale")
  })

  test("uncertain reconciliation preserves cancellation and its budget reservation", async () => {
    const s = scope(root()), store = InvestigationStore.open(s, { create: true, costLimit: 10 })
    const item = await store.admit(workInput, capabilities)
    await store.dispatch(item.work_key, fakePort(async () => ({ kind: "running", external_job_id: "job-1" })))
    await store.requestCancel(item.work_key)
    const port = fakePort(async () => { throw new Error("no submit") }, async () => ({ kind: "unknown", reason: "lookup unavailable" }))
    expect((await store.reconcile(item.work_key, port)).status).toBe("cancel_requested")
    expect(store.snapshot.reserved_cost).toBe(10)
  })

  test("failed worker output does not erase a durable result and permissions/expiry gate reuse", async () => {
    const s = scope(root()), store = InvestigationStore.open(s, { create: true, costLimit: 10 })
    const item = await store.admit(workInput, capabilities)
    const port = { ...fakePort(async () => ({ kind: "result", result })),
      validateResult: async () => ({ valid: true, validity_key: item.validity_key, access_scope: result.access_scope }) }
    await store.dispatch(item.work_key, port)
    // Worker output is deliberately unrelated to the independently recorded query receipt.
    const reopened = InvestigationStore.open(s)
    expect(reopened.snapshot.work[0]?.result?.digest).toBe(result.digest)
    const reusable = await reopened.markReusable(item.work_key, port)
    expect(reusable.status).toBe("reusable")
    const revoked = { ...port, validateResult: async () => ({ valid: false, validity_key: item.validity_key, access_scope: "revoked", reason: "revoked" }) }
    await expect(reopened.markReusable(item.work_key, revoked)).rejects.toThrow()
  })

  test("engineer input is provenance-labelled reported knowledge, not verified evidence", async () => {
    const store = InvestigationStore.open(scope(root()), { create: true, costLimit: 0 })
    const contribution = await store.recordEngineerContribution({ engineer_ref: "person:eng-4", statement: "clean occurred early", scope: "tool-9 shift-B", source_ref: "log:pending" })
    expect(contribution).toMatchObject({ classification: "reported_knowledge", engineer_ref: "person:eng-4", source_ref: "log:pending" })
    expect(InvestigationStore.open(store.scope).context.engineer_contributions).toContainEqual(contribution)
    await expect(store.attach("session-b", { owner_id: "other-owner", project_id: "project-a" })).rejects.toThrow()
  })
})

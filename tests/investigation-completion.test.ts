import { afterEach, describe, expect, test } from "bun:test"
import { InvestigationStore, type InvestigationMcpPort } from "../src/investigation/index.ts"
import { waitForInvestigation } from "../src/investigation-wait.ts"
import { removeProject, tempProject } from "./helpers.ts"

const projects: string[] = []
afterEach(() => { for (const root of projects.splice(0)) removeProject(root) })
const operator = { engineer_ref: "reviewer", statement: "Reviewed the replacement service contract and retained results" }
async function fixture(running = false) {
  const project = tempProject("alg-completion-"); projects.push(project)
  const scope = { project_directory: project, project_id: "p", owner_id: "owner", run_id: "r" }
  const store = InvestigationStore.open(scope, { create: true, costLimit: 10 })
  const counters = { submits: 0, reads: 0, validates: 0, lookups: 0 }
  const result = { manifest_ref: "fixture://result", digest: "a".repeat(64), access_scope: "reader/p",
    source_versions: ["s1"], observed_at: new Date().toISOString(), coverage: { complete: false } }
  const port: InvestigationMcpPort = {
    capabilities: { server_id: "lake", server_revision: "1", tool_id: "read", tool_schema_revision: "1",
      principal_id: "reader", project_id: "p", effects: ["read"], qualified: true, idempotent_submit: true,
      lookup_by_submission_id: true, response_limit_bytes: 65536 },
    submit: async () => { counters.submits++; return running ? { kind: "running", external_job_id: "job" } : { kind: "result", result, actual_cost: 1 } },
    lookup: async () => { counters.lookups++; return counters.lookups < 3 ? { kind: "running", external_job_id: "job" } : { kind: "result", result, actual_cost: 1 } },
    validateResult: async (r, w) => { counters.validates++; return { valid: true, validity_key: w.validity_key, access_scope: r.access_scope } },
    readResult: async (r, request) => { counters.reads++; return { manifest_ref: r.manifest_ref, digest: r.digest,
      access_scope: r.access_scope, cursor: request.cursor, next_cursor: request.cursor === null ? "next" : null,
      rows: [{ chamber: "C1", particles: 12 }], coverage: { complete: false, source: "s1" } } },
  }
  const work = await store.admit({ operation: "read", recipe_version: "1", parameters: {}, query: { recipe: "synthetic" }, reserved_cost: 2 }, port.capabilities)
  await store.dispatch(work.work_key, port)
  return { scope, store, port, counters, work, result }
}

describe("bounded evidence and job continuation", () => {
  test("reopened readers reuse durable pages while rechecking current access", async () => {
    const f = await fixture()
    expect((await f.store.readResultPage(f.work.work_key, f.port)).rows).toEqual([{ chamber: "C1", particles: 12 }])
    const reopened = InvestigationStore.open(f.scope)
    await reopened.readResultPage(f.work.work_key, f.port)
    expect(f.counters).toMatchObject({ submits: 1, reads: 1, validates: 2 })
    await reopened.readResultPage(f.work.work_key, f.port, "next")
    expect(f.counters.reads).toBe(2)
    expect(reopened.snapshot.cumulative_cost).toBe(1)
    f.port.validateResult = async (_r, w) => ({ valid: false, validity_key: w.validity_key, access_scope: "reader/p" })
    await expect(reopened.readResultPage(f.work.work_key, f.port)).rejects.toThrow("validity")
    expect(f.counters.reads).toBe(2)
    expect(reopened.snapshot.work[0]).toMatchObject({ status: "stale", result_pages: [] })
  })

  test("parallel reads publish one immutable page after a later validity check", async () => {
    const f = await fixture()
    const original = f.port.readResult!
    let entered = 0, notify!: () => void, release!: () => void
    const enteredTwice = new Promise<void>((resolve) => { notify = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    f.port.readResult = async (result, request) => {
      if (++entered === 2) notify()
      await gate
      return original(result, request)
    }
    const first = f.store.readResultPage(f.work.work_key, f.port)
    // The first read has passed validation before the second begins.
    while (entered === 0) await new Promise((resolve) => setTimeout(resolve, 1))
    const second = InvestigationStore.open(f.scope).readResultPage(f.work.work_key, f.port)
    await enteredTwice
    release()
    const pages = await Promise.all([first, second])
    expect(pages[0]).toEqual(pages[1])
    expect(f.store.snapshot.work[0]?.result_pages).toHaveLength(1)
  })

  test.each(["digest", "access_scope", "cursor"] as const)("rejects a mismatched page %s without publishing it", async (field) => {
    const f = await fixture(), original = f.port.readResult!
    f.port.readResult = async (result, request) => ({ ...await original(result, request), [field]: field === "digest" ? "b".repeat(64) : "foreign" })
    await expect(f.store.readResultPage(f.work.work_key, f.port)).rejects.toThrow("mismatch")
    expect(f.store.snapshot.work[0]?.result_pages).toBeUndefined()
  })

  test("bounds content bytes, rows, cursors and cache capacity", async () => {
    const f = await fixture()
    await expect(f.store.readResultPage(f.work.work_key, f.port, null, 101)).rejects.toThrow("bounded")
    const original = f.port.readResult!
    f.port.readResult = async (r, request) => ({ ...await original(r, request), rows: [{ text: "x".repeat(17000) }] })
    await expect(f.store.readResultPage(f.work.work_key, f.port)).rejects.toThrow()
    f.port.readResult = async (r, request) => ({ ...await original(r, request), next_cursor: request.cursor + "-next" })
    for (let i = 0; i < 8; i++) await f.store.readResultPage(f.work.work_key, f.port, String(i))
    const reads = f.counters.reads
    await expect(f.store.readResultPage(f.work.work_key, f.port, "9")).rejects.toThrow("cache is full")
    expect(f.counters.reads).toBe(reads)
  })

  test("known jobs finish inside host waiting without another submission or model turn", async () => {
    const f = await fixture(true)
    let now = 0, sleeps = 0
    const outcome = await waitForInvestigation(f.store, f.port, { waitMs: 1000, pollIntervalMs: 100 },
      { now: () => now, sleep: async (ms) => { sleeps++; now += ms } })
    expect(outcome.ready).toBe(true)
    expect(f.counters).toMatchObject({ submits: 1, lookups: 3 })
    expect(sleeps).toBe(2)
    expect(InvestigationStore.open(f.scope).snapshot.work[0]).toMatchObject({ status: "result_recorded", lookup_count: 3 })
    expect(f.store.snapshot.reserved_cost).toBe(0)
  })

  test("timeout retains live reservation and restart continues the same job", async () => {
    const f = await fixture(true)
    const first = await waitForInvestigation(f.store, f.port, { waitMs: 0, pollIntervalMs: 100 })
    expect(first.ready).toBe(false)
    expect(f.store.snapshot.reserved_cost).toBe(2)
    const next = await waitForInvestigation(InvestigationStore.open(f.scope), f.port,
      { waitMs: 1000, pollIntervalMs: 100 }, { now: () => 0, sleep: async () => {} })
    expect(next.ready).toBe(true)
    expect(f.counters.submits).toBe(1)
  })

  test("unknown outcome is not repeatedly polled and abort spends no lookup", async () => {
    const f = await fixture(true)
    f.port.lookup = async () => { f.counters.lookups++; return { kind: "unknown", reason: "unavailable" } }
    const outcome = await waitForInvestigation(f.store, f.port, { waitMs: 10000, pollIntervalMs: 100 })
    expect(outcome.ready).toBe(false)
    expect(f.counters.lookups).toBe(1)
    const controller = new AbortController(); controller.abort()
    await expect(waitForInvestigation(f.store, f.port, { waitMs: 10000, pollIntervalMs: 100, signal: controller.signal })).rejects.toThrow("aborted")
    expect(f.counters.lookups).toBe(1)
  })

  test("wait checks identity, bounds, deadline and abort after lookup", async () => {
    const f = await fixture(true)
    await expect(waitForInvestigation(f.store, f.port, { waitMs: 1, pollIntervalMs: 0 })).rejects.toThrow("bounds")
    await expect(waitForInvestigation(f.store, f.port, { waitMs: 1, pollIntervalMs: 1, workKey: "missing" })).rejects.toThrow("unknown work key")
    await expect(waitForInvestigation(f.store, f.port, { waitMs: 1, pollIntervalMs: 1, workKey: "" })).rejects.toThrow("unknown work key")
    expect(f.counters.lookups).toBe(0)
    const other = await f.store.admit({ operation: "read", recipe_version: "1", parameters: {}, query: { recipe: "other" }, reserved_cost: 2 }, f.port.capabilities)
    await f.store.dispatch(other.work_key, f.port)
    let now = 0
    f.port.lookup = async () => { f.counters.lookups++; now += 10; return { kind: "running", external_job_id: "job" } }
    const timed = await waitForInvestigation(f.store, f.port, { waitMs: 0, pollIntervalMs: 1 },
      { now: () => now, sleep: async () => { throw new Error("unexpected sleep") } })
    expect(timed.ready).toBe(false)
    expect(f.counters.lookups).toBe(1)
    const controller = new AbortController()
    f.port.lookup = async () => { f.counters.lookups++; controller.abort(); return { kind: "result", result: f.result, actual_cost: 1 } }
    await expect(waitForInvestigation(f.store, f.port, { waitMs: 100, pollIntervalMs: 1, signal: controller.signal })).rejects.toThrow("aborted")
    expect(f.counters.lookups).toBe(2)
    expect(f.store.snapshot.work[0]?.status).toBe("result_recorded")
  })

  test("explicit service migration revalidates retained results and keeps accounting", async () => {
    const f = await fixture()
    await f.store.readResultPage(f.work.work_key, f.port)
    const replacement = { ...f.port, capabilities: { ...f.port.capabilities, server_revision: "2", tool_schema_revision: "2" } }
    await f.store.migrateProfile(replacement, operator)
    expect(f.store.snapshot).toMatchObject({ cumulative_cost: 1, reserved_cost: 0,
      remote_profile: { server_revision: "2" }, work: [{ status: "reusable", result_pages: [] }] })
    expect(f.store.context.engineer_contributions).toHaveLength(1)
    await expect(f.store.getReusableResult(f.work.work_key, f.port)).rejects.toThrow("profile mismatch")
    expect((await f.store.getReusableResult(f.work.work_key, replacement)).digest).toBe(f.result.digest)
    expect(f.counters.submits).toBe(1)
  })

  test("migration cannot transfer uncertain jobs or change principal", async () => {
    const f = await fixture(true)
    await expect(f.store.migrateProfile({ ...f.port, capabilities: { ...f.port.capabilities, server_revision: "2" } }, operator)).rejects.toThrow("active work")
    await expect(f.store.migrateProfile({ ...f.port, capabilities: { ...f.port.capabilities, principal_id: "other" } }, operator)).rejects.toThrow("authority")
    expect(f.store.context.engineer_contributions).toHaveLength(0)
    expect(f.store.snapshot.reserved_cost).toBe(2)
  })

  test("migration cannot revive a stale result", async () => {
    const f = await fixture()
    f.port.validateResult = async (_r, w) => ({ valid: false, validity_key: w.validity_key, access_scope: f.result.access_scope })
    await expect(f.store.getReusableResult(f.work.work_key, f.port)).rejects.toThrow("validity")
    const replacement = { ...f.port, capabilities: { ...f.port.capabilities, server_revision: "2" },
      validateResult: async (_r: typeof f.result, w: typeof f.work) => ({ valid: true, validity_key: w.validity_key, access_scope: f.result.access_scope }) }
    await f.store.migrateProfile(replacement, operator)
    expect(f.store.snapshot.work[0]?.status).toBe("stale")
    await expect(f.store.getReusableResult(f.work.work_key, replacement)).rejects.toThrow("available")
  })
})

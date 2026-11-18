import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
  InvestigationStore,
  type InvestigationMcpPort,
  type InvestigationResult,
  type InvestigationWorkInput,
} from "../../../src/investigation/index.ts"
import { createV2InvestigationBridge } from "../core/investigation.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const approvedJob: InvestigationWorkInput = {
  operation: "fixture.count",
  recipe_version: "fixture-v1",
  parameters: {},
  query: { fixture: "read-only-synthetic" },
  reserved_cost: 1,
}
const result: InvestigationResult = {
  manifest_ref: "synthetic:fixture-count",
  digest: "a".repeat(64),
  source_versions: ["fixture-v1"],
  coverage: { fixture: true },
  observed_at: "2025-01-01T00:00:00.000Z",
  access_scope: "synthetic:fixture-project",
}

function fixture() {
  const directory = mkdtempSync(join(import.meta.dir, ".investigation-"))
  roots.push(directory)
  const owner = { projectID: "project", directory, sessionID: "owner", parentID: null }
  const checker = { ...owner, sessionID: "checker", parentID: owner.sessionID }
  const submissions: string[] = []
  const lookups: string[] = []
  const calls = { validations: 0, reads: 0 }
  const state = { lostAck: false, lookupUnknown: false, valid: true }
  function ledger() {
    const [run_id] = readdirSync(join(directory, ".opencode", "runs"))
    return InvestigationStore.open({
      project_directory: directory, project_id: owner.projectID, owner_id: owner.sessionID, run_id: run_id!,
    })
  }
  const port: InvestigationMcpPort = {
    capabilities: {
      server_id: "fixture", server_revision: "1", tool_id: approvedJob.operation, tool_schema_revision: "1",
      principal_id: "fixture-principal", project_id: owner.projectID, effects: ["read"], qualified: true,
      idempotent_submit: true, lookup_by_submission_id: true, response_limit_bytes: 4096,
    },
    async submit(request) {
      const durable = ledger().snapshot
      expect(durable.history.at(-1)?.kind).toBe("submission_intent")
      expect(durable.work[0]).toMatchObject({ status: "submitting", submission_id: request.submission_id })
      expect(request.query).toEqual(approvedJob.query)
      submissions.push(request.submission_id)
      if (state.lostAck) throw new Error("synthetic lost acknowledgment")
      return { kind: "result", result, actual_cost: 1 }
    },
    async lookup(id) {
      lookups.push(id)
      if (state.lookupUnknown) return { kind: "unknown", reason: "synthetic delayed visibility" }
      if (id !== submissions[0]) throw new Error("incorrect original submission identity")
      return { kind: "result", result, actual_cost: 1 }
    },
    async validateResult(value, work) {
      calls.validations++
      return { valid: state.valid, validity_key: work.validity_key, access_scope: value.access_scope }
    },
    async readResult(value, request) {
      calls.reads++
      expect(request).toEqual({ cursor: null, max_rows: 16 })
      return {
        manifest_ref: value.manifest_ref, digest: value.digest, access_scope: value.access_scope,
        cursor: null, next_cursor: null, rows: [{ synthetic_count: 1 }], coverage: { fixture: true },
      }
    },
  }
  const bridge = () => createV2InvestigationBridge({ port, approvedJob })
  return { owner, checker, port, state, submissions, lookups, calls, bridge, ledger }
}

async function completed(f: ReturnType<typeof fixture>) {
  const bridge = f.bridge()
  bridge.create(f.owner)
  await bridge.admit(f.owner)
  const view = await bridge.dispatch(f.owner)
  return { bridge, selection: { work_key: view.work!.work_key, manifest_digest: result.digest } }
}

test("journals one approved submission and reconciles its original ID after lost acknowledgment", async () => {
  const f = fixture()
  const bridge = f.bridge()
  f.state.lostAck = true
  f.state.lookupUnknown = true
  expect(bridge.primary(f.owner)).toBeNull()
  bridge.create(f.owner)
  const admission = await bridge.admit(f.owner)
  expect(await bridge.admit(f.owner)).toEqual(admission)
  const decision = await bridge.setNextMeasurement(f.owner, {
    expected_decision_revision: 0, next_action: "Review the coverage when the original fixture result is recorded.",
  })
  const unknown = await bridge.dispatch(f.owner)
  expect(unknown.work?.status).toBe("outcome_unknown")
  expect(unknown.guidance).toContain("Writes and replay are blocked")
  expect(unknown.decision.next_action).toBe(decision.decision.next_action)
  expect(unknown.decision_revision).toBe(decision.decision_revision)

  const resumed = f.bridge()
  expect(resumed.primary(f.owner)).toEqual(unknown)
  await expect(resumed.dispatch(f.owner)).rejects.toThrow("reconcile the original submission")
  await expect(resumed.admit(f.owner)).rejects.toThrow("reconcile the original submission")
  await expect(resumed.setNextMeasurement(f.owner, { expected_decision_revision: 1, next_action: "Review the fixture." }))
    .rejects.toThrow("reconcile the original submission")
  await expect(resumed.grant(f.owner, f.checker, {
    work_key: admission.work!.work_key, manifest_digest: result.digest,
  })).rejects.toThrow("reconcile the original submission")
  expect(resumed.create(f.owner)).toEqual(unknown)
  expect((await resumed.reconcile(f.owner)).work?.status).toBe("outcome_unknown")
  expect(f.ledger().snapshot.reserved_cost).toBe(1)

  f.state.lookupUnknown = false
  const resultView = await resumed.reconcile(f.owner)
  expect(resultView.work).toMatchObject({ status: "result_recorded", manifest_digest: result.digest })
  expect(await resumed.dispatch(f.owner)).toEqual(resultView)
  expect(f.submissions).toHaveLength(1)
  expect(f.lookups).toEqual([f.submissions[0]!, f.submissions[0]!])
  expect(f.ledger().snapshot.work).toHaveLength(1)
  expect(f.ledger().snapshot.cumulative_cost).toBe(1)
})

test("rejects a changed approval and serializes concurrent dispatch and reconcile", async () => {
  const f = fixture()
  const bridge = f.bridge()
  bridge.create(f.owner)
  await bridge.admit(f.owner)
  const changed = createV2InvestigationBridge({
    port: f.port, approvedJob: { ...approvedJob, query: { fixture: "a-different-fixture" } },
  })
  await expect(changed.admit(f.owner)).rejects.toThrow("job changed")
  await expect(changed.dispatch(f.owner)).rejects.toThrow("incomplete or changed")
  expect(f.submissions).toHaveLength(0)

  let release!: () => void
  let notify!: () => void
  const submitted = new Promise<void>((resolve) => { notify = resolve })
  const barrier = new Promise<void>((resolve) => { release = resolve })
  const submit = f.port.submit
  f.port.submit = async (request) => {
    notify()
    await barrier
    return submit(request)
  }
  const pending = bridge.dispatch(f.owner)
  await submitted
  const reconciliation = f.bridge().reconcile(f.owner)
  expect(bridge.primary(f.owner)?.work?.status).toBe("submitting")
  expect(f.lookups).toHaveLength(0)
  release()
  await pending
  expect((await reconciliation).work?.status).toBe("result_recorded")
  expect(f.submissions).toHaveLength(1)
  expect(f.lookups).toHaveLength(0)
})

test("an exact grant belongs to one verified direct child and revocation fences cached reads", async () => {
  const f = fixture()
  const { bridge, selection } = await completed(f)
  const grant = await bridge.grant(f.owner, f.checker, selection)
  expect(await bridge.grant(f.owner, f.checker, selection)).toEqual(grant)
  const anotherChild = { ...f.checker, sessionID: "other-checker" }
  await expect(bridge.checkerRead(anotherChild, grant)).rejects.toThrow("active exact checker result grant")
  await expect(bridge.checkerRead(f.checker, { ...grant, manifest_digest: "b".repeat(64) }))
    .rejects.toThrow("active exact checker result grant")
  expect(f.calls).toEqual({ validations: 0, reads: 0 })
  expect(bridge.primary(f.checker)).toBeNull()
  expect((await bridge.checkerRead(f.checker, grant)).rows).toEqual([{ synthetic_count: 1 }])
  expect(await bridge.withCheckerGrant(f.checker, grant, () => "published")).toBe("published")
  await expect(bridge.revoke(f.owner, { ...grant, checker_node: "different" }))
    .rejects.toThrow("active exact checker result grant")
  await bridge.revoke(f.owner, grant)
  await expect(f.bridge().checkerRead(f.checker, grant)).rejects.toThrow("active exact checker result grant")
  let published = false
  await expect(bridge.withCheckerGrant(f.checker, grant, () => { published = true }))
    .rejects.toThrow("active exact checker result grant")
  expect(published).toBe(false)
  const renewed = await bridge.grant(f.owner, f.checker, selection)
  expect(renewed.grant_id).not.toBe(grant.grant_id)
  await expect(bridge.checkerRead(f.checker, grant)).rejects.toThrow("active exact checker result grant")
  expect((await bridge.checkerRead(f.checker, renewed)).rows).toHaveLength(1)
  expect(f.calls).toEqual({ validations: 2, reads: 1 })
})

test("stale remote validity denies grant reuse even with a cached page", async () => {
  const f = fixture()
  const { bridge, selection } = await completed(f)
  const grant = await bridge.grant(f.owner, f.checker, selection)
  await bridge.checkerRead(f.checker, grant)
  f.state.valid = false
  await expect(bridge.checkerRead(f.checker, grant)).rejects.toThrow("validity, permission or retention")
  expect(bridge.primary(f.owner)?.work?.status).toBe("stale")
  expect(bridge.primary(f.owner)?.work?.manifest_digest).toBeUndefined()
  expect(f.calls.reads).toBe(1)
})

test("revocation during a page fetch prevents publication", async () => {
  const f = fixture()
  const { bridge, selection } = await completed(f)
  const grant = await bridge.grant(f.owner, f.checker, selection)
  const readResult = f.port.readResult!
  f.port.readResult = async (value, request) => {
    await bridge.revoke(f.owner, grant)
    return readResult(value, request)
  }
  await expect(bridge.checkerRead(f.checker, grant)).rejects.toThrow("grant changed during result read")
  expect(f.ledger().snapshot.work[0]?.result_pages).toBeUndefined()
})

test("isolates project, on-disk project root, and owner authority", async () => {
  const f = fixture()
  const { bridge, selection } = await completed(f)
  const grant = await bridge.grant(f.owner, f.checker, selection)
  const foreignProject = { ...f.checker, projectID: "other-project" }
  await expect(bridge.checkerRead(foreignProject, grant)).rejects.toThrow("verified project required")
  const foreignRoot = join(f.owner.directory, "other-root")
  mkdirSync(foreignRoot)
  await expect(bridge.checkerRead({ ...f.checker, directory: foreignRoot }, grant)).rejects.toThrow("does not exist")
  await expect(bridge.grant(f.owner, { ...f.checker, directory: foreignRoot }, selection)).rejects.toThrow("verified project")
  await expect(bridge.grant(f.owner, { ...f.checker, parentID: "other-owner" }, selection)).rejects.toThrow("direct child")
  await expect(bridge.admit(f.checker)).rejects.toThrow("owner session required")
  expect(bridge.primary({ ...f.owner, sessionID: "other-owner" })).toBeNull()
  expect(f.calls.reads).toBe(0)
})

test("a refuted hypothesis and its next measurement survive restart together", async () => {
  const f = fixture()
  const { bridge, selection } = await completed(f)
  const input = { expected_decision_revision: 0, next_action: "Compare monitor wafers by exposure.",
    refutation: { id: "chamber-a", statement: "Chamber A explains the shift.", manifest_digest: selection.manifest_digest } }
  await expect(bridge.setNextMeasurement(f.owner, { ...input, refutation: { ...input.refutation, manifest_digest: "f".repeat(64) } }))
    .rejects.toThrow("current recorded manifest")
  expect(bridge.primary(f.owner)?.decision_revision).toBe(0)
  const recorded = await bridge.setNextMeasurement(f.owner, input)
  expect(f.bridge().primary(f.owner)?.projection).toBe(recorded.projection)
  expect(recorded.decision.hypotheses[0]).toMatchObject({ id: "chamber-a", status: "refuted", evidence_refs: [selection.manifest_digest] })
  expect(recorded.decision.next_action).toBe(input.next_action)
  await expect(bridge.setNextMeasurement(f.owner, input)).rejects.toThrow("stale investigation decision")
})

test("each primary request projects the latest durable decision under the hard byte bound", async () => {
  const f = fixture()
  const bridge = f.bridge()
  const created = bridge.create(f.owner)
  const action = "Review the synthetic coverage."
  const updated = await bridge.setNextMeasurement(f.owner, {
    expected_decision_revision: created.decision_revision, next_action: action,
  })
  const restarted = f.bridge()
  expect(restarted.primary(f.owner)).toEqual(updated)
  expect(updated.decision_revision).toBe(1)
  await expect(restarted.setNextMeasurement(f.owner, { expected_decision_revision: 0, next_action: "Stale update." }))
    .rejects.toThrow("stale investigation decision")
  await expect(restarted.setNextMeasurement(f.owner, { expected_decision_revision: 1, next_action: "\u0000".repeat(200) }))
    .rejects.toThrow("1024-byte JSON budget")
  await expect(restarted.setNextMeasurement(f.checker, { expected_decision_revision: 1, next_action: "Child update." }))
    .rejects.toThrow("owner session required")
  expect(restarted.primary(f.owner)).toEqual(updated)

  await f.ledger().updateCheckpoint({ contradictions: ["Fixture omitted the counterexample row."] })
  const fresh = restarted.primary(f.owner)!
  expect(fresh.revision).toBeGreaterThan(created.revision)
  expect(fresh.decision.next_action).toBe(action)
  expect(JSON.parse(fresh.projection).decision.contradictions).toEqual(["Fixture omitted the counterexample row."])

  await f.ledger().updateCheckpoint({ contradictions: ["界".repeat(1000), "Additional counterevidence"] })
  const bounded = bridge.primary(f.owner)!
  expect(bounded.revision).toBeGreaterThan(fresh.revision)
  expect(Buffer.byteLength(bounded.projection)).toBeLessThanOrEqual(3072)
  expect(JSON.parse(bounded.projection).decision.other_contradictions).toBe(2)
  expect(JSON.parse(bounded.projection).decision.next_action).toBe(action)
  expect(bounded.decision_revision).toBe(1)
})

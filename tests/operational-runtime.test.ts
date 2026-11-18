import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { createRun, loadRunForOwner } from "../src/store.ts"
import { mutateOwnedRunAsync } from "../src/ownership.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { OperationalRuntime } from "../src/operational-runtime.ts"
import { createOperationalTools } from "../src/operational-tools.ts"
import { decisionEvidence } from "../src/investigation/decision.ts"
import server from "../src/index.ts"
import { getTemplate } from "../src/templates.ts"
import { investigationReviewBasis, recordInvestigationReview, requireInvestigationReview } from "../src/investigation-review.ts"
import { InvestigationStore, type InvestigationMcpPort, type InvestigationWorkInput } from "../src/investigation/index.ts"
import { removeProject, tempProject } from "./helpers.ts"

const projects: string[] = []
afterEach(() => { for (const project of projects.splice(0)) removeProject(project) })
const project = () => { const path = tempProject("alg-operational-"); projects.push(path); return path }
const input: InvestigationWorkInput = {
  operation: "bounded-read", recipe_version: "v1", parameters: {}, query: { source: "synthetic" },
  reserved_cost: 0, source_dependencies: ["snapshot-1"],
}
function fixture(path = project()) {
  const memory = new SessionMemoryRuntime(path, { mode: "assist" })
  memory.beginTask("owner", "Explain synthetic excursion")
  const run = createRun({ goal: "Explain synthetic excursion", criteria: ["cite sources"],
    graph: getTemplate("data-investigation"), projectDirectory: path, ownerSessionId: "owner" })
  let submits = 0
  const capabilities: InvestigationMcpPort["capabilities"] = { server_id: "synthetic", server_revision: "v1",
    tool_id: "submit", tool_schema_revision: "a".repeat(64), principal_id: "service",
    project_id: memory.store.projectId, effects: ["read"], idempotent_submit: true,
    lookup_by_submission_id: true, response_limit_bytes: 65536, qualified: true }
  const port: InvestigationMcpPort = {
    capabilities,
    submit: async () => { submits++; return { kind: "running", external_job_id: "job-1" } },
    lookup: async () => ({ kind: "unknown", reason: "still pending" }),
    validateResult: async () => ({ valid: false, validity_key: "a".repeat(64), access_scope: "none" }),
  }
  const runtime = new OperationalRuntime(memory, {}, { enabled: true, costLimit: 20, perJobReservation: 5, continuation: { waitMs: 0, pollIntervalMs: 100 } }, () => port)
  return { path, memory, run, runtime, port, get submits() { return submits } }
}

describe("operational investigation host", () => {
  test("legacy decisions rank shared evidence first and disclose omitted contrary observations", () => {
    const hypotheses = Array.from({ length: 8 }, (_, i) => ({ id: String(i), statement: "Test " + i,
      status: "active" as const, evidence_refs: i === 0 ? ["result-A"] : [],
      updated_at: "2026-11-17T12:00:00Z" }))
    const checkpoint = { hypotheses, objective: "", scope: {}, completed_tests: [], coverage: {}, evidence_refs: [],
      next_action: "Check product mix", engineer_contributions: [], contradictions: ["a", "b", "c", "d", "e"],
      analytical_result: { status: "unresolved" as const, claim: "Possible chamber effect", evidence_refs: ["result-A"],
        authority: "reported_analysis" as const } }
    const recovered = decisionEvidence(checkpoint)
    expect(recovered.hypotheses.map(item => item.id)).toEqual(["0", "7", "6", "5"])
    expect(recovered).toMatchObject({ other_hypotheses: 4, other_contradictions: 1,
      contradiction_selection: "recorded_order" })
    expect(checkpoint.hypotheses.map(item => item.id)).toEqual(["0", "1", "2", "3", "4", "5", "6", "7"])
  })
  test("restart recovers the selected older counterevidence and fences decision pagination", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const contrary = "Within the matched product the chamber effect disappears."
    for (let i = 0; i <= 10; i++) {
      await f.runtime.hypothesis("owner", { id: "h" + i, statement: "Hypothesis " + i,
        status: "active", evidence_refs: [] })
    }
    await f.runtime.note("owner", {
      next_action: "Compare matched inspection strata",
      contradictions: [contrary, ...Array.from({ length: 10 }, (_, i) => "Other observation " + i)],
      decision_focus: { hypothesis_ids: ["h0"], contradictions: [contrary] },
      coverage: { notes: "x".repeat(1000) },
    })
    const restored = new OperationalRuntime(new SessionMemoryRuntime(f.path, { mode: "assist" }), {},
      { enabled: true, perJobReservation: 5 }, () => f.port)
    const recovered = restored.render("owner", 850)
    expect(Buffer.byteLength(recovered)).toBeLessThanOrEqual(850)
    expect(recovered).toContain(contrary)
    expect(recovered).toContain("Hypothesis 0")
    expect(recovered).not.toContain("Hypothesis 10")
    const hooks = await server({ directory: f.path, worktree: f.path, project: { id: "fixture" }, client: {
      session: { get: async () => ({ data: { id: "owner", projectID: "fixture", directory: f.path } }),
        messages: async () => ({ data: [] }) }, app: { log: async () => ({}) },
    } } as any, { sessionMemory: { mode: "assist" }, investigation: { enabled: true }, skillEvolution: { enabled: false } } as any)
    try {
      const normal = { system: [] as string[] }, compacted = { context: [] as string[] }
      await hooks["experimental.chat.system.transform"]!({ sessionID: "owner", model: { limit: { context: 32000, output: 4096 } } } as any, normal)
      await hooks["experimental.session.compacting"]!({ sessionID: "owner" }, compacted)
      expect(normal.system.join("\n")).toContain(contrary)
      expect(compacted.context.join("\n")).toContain(contrary)
    } finally { await hooks.dispose?.() }
    const refs = ["one", "two", "three", "four", "contrary-observation-source"]
    await restored.hypothesis("owner", { id: "h0", statement: "A🔬".repeat(1100), status: "active", evidence_refs: refs })
    expect(restored.render("owner", 850)).toContain("alg_investigation decision")
    const first = restored.decision("owner", 0)
    expect(first.next_page).toBe(1)
    const second = restored.decision("owner", 1, first.revision)
    const decision = JSON.parse(first.text + second.text)
    expect(decision.contradictions).toEqual([contrary])
    expect(decision.hypotheses[0].evidence_refs).toEqual(refs)
    expect(decision.hypotheses[0].statement).toEqual("A🔬".repeat(1100))
    await expect(restored.note("owner", { contradictions: ["different"] })).rejects.toThrow()
    expect(restored.decision("owner", 0).revision).toBe(first.revision)
    await restored.note("owner", { next_action: "Review a different comparison" })
    expect(() => restored.decision("owner", 1, first.revision)).toThrow("revision")
    expect(restored.status("owner")).toMatchObject({ checkpoint: { next_action: "Review a different comparison" } })
  }, 60_000)
  test("models cannot manufacture fresh work through purpose or generation", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const first = await f.runtime.query("owner", { ...input, as_of: "2026-11-10" })
    await expect(f.runtime.query("owner", { ...input, generation: 1 })).rejects.toThrow("host-owned")
    for (const purpose of ["independent_verification", "refresh", "recomputation"] as const)
      await expect(f.runtime.query("owner", { ...input, purpose })).rejects.toThrow("host-owned")
    const same = await f.runtime.query("owner", { ...input, as_of: "2026-11-09T18:00:00-06:00",
      parameters: { explanatory_label: "cosmetic" } })
    expect(same.work_key).toBe(first.work_key)
    expect(f.submits).toBe(1)
  })

  test("typed argument diagnostics name safe fields without echoing unknown keys or values", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const tool = createOperationalTools(f.runtime, async () => {}).alg_investigation
    const context = { sessionID: "owner", worktree: f.path, directory: f.path } as never
    const reply = await tool.execute({ request: { action: "admit", input: { ...input,
      recipe_version: 7, "untrusted-private-key": "untrusted-private-value" } } } as never, context)
    if (typeof reply === "string") throw new Error("expected structured tool result")
    expect(JSON.parse(reply.output)).toMatchObject({ error: "invalid_request",
      issues: expect.arrayContaining([{ path: "input.recipe_version", code: "invalid_type" }]) })
    expect(reply.output).not.toContain("untrusted-private")
    expect(f.submits).toBe(0)
  })

  test("restart and compaction reuse the pointer and never duplicate unknown work", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const first = await f.runtime.query("owner", input)
    expect(first.status).toBe("running")
    expect(f.submits).toBe(1)
    const restarted = new OperationalRuntime(new SessionMemoryRuntime(f.path, { mode: "assist" }),
      {}, { enabled: true, costLimit: 20, perJobReservation: 5, continuation: { waitMs: 0, pollIntervalMs: 100 } }, () => f.port)
    for (let i = 0; i < 20; i++) {
      expect(restarted.render("owner", 4096)).toContain(f.run.run_id)
      const again = await restarted.query("owner", input)
      expect(again.work_key).toBe(first.work_key)
      expect(again.submission_id).toBe(first.submission_id)
    }
    expect(f.submits).toBe(1)
    expect(restarted.status("owner")).toMatchObject({ reserved_cost: 5, admission_count: 1 })
    await restarted.detach("owner")
    expect(() => restarted.status("owner")).not.toThrow()
    await expect(restarted.query("owner", input)).rejects.toThrow("no scoped investigation")
    await restarted.attach("owner", f.run.run_id)
    expect((await restarted.query("owner", input)).work_key).toBe(first.work_key)
    expect(f.submits).toBe(1)
    restarted.memory.beginTask("owner", "A new task")
    await expect(restarted.query("owner", input)).rejects.toThrow("no scoped investigation")
  }, 60000)

  test("missed pointer delivery blocks query before admission or remote submission", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    f.memory.deliveryUnavailable.add("owner")
    await expect(f.runtime.query("owner", input)).rejects.toThrow("needs_context")
    expect(f.submits).toBe(0)
    expect(f.runtime.status("owner")).toMatchObject({ admission_count: 0, reserved_cost: 0 })
    f.memory.deliveryUnavailable.delete("owner")
    expect((await f.runtime.query("owner", input)).status).toBe("running")
    expect(f.submits).toBe(1)
  })

  test("new task records ledger detach durably without resetting jobs or budget", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    await f.runtime.query("owner", input)
    const scope = { project_directory: f.path, project_id: f.memory.store.projectId,
      owner_id: "owner", run_id: f.run.run_id }
    expect(InvestigationStore.open(scope).snapshot.attachments).toHaveLength(1)
    const next = f.memory.beginTask("owner", "Unrelated task")
    expect(next.investigation).toBeUndefined()
    expect(next.investigation_detach_pending).toBeUndefined()
    const restarted = new SessionMemoryRuntime(f.path, { mode: "assist" })
    expect(restarted.current("owner").investigation).toBeUndefined()
    expect(InvestigationStore.open(scope).snapshot).toMatchObject({
      attachments: [], reserved_cost: 5, cumulative_cost: 0,
      work: [{ status: "running", external_job_id: "job-1" }],
    })
    const resumed = new OperationalRuntime(restarted, {}, { enabled: true, costLimit: 20, perJobReservation: 5, continuation: { waitMs: 0, pollIntervalMs: 100 } },
      () => f.port)
    await resumed.attach("owner", f.run.run_id)
    expect((await resumed.query("owner", input)).status).toBe("running")
    expect(f.submits).toBe(1)
  })

  test("restart replays a committed detach intent after a crash window", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const scope = { project_directory: f.path, project_id: f.memory.store.projectId,
      owner_id: "owner", run_id: f.run.run_id }
    const ref = f.memory.current("owner").investigation!
    f.memory.update("owner", (state) => ({ ...state, task_epoch: state.task_epoch + 1,
      investigation: undefined, investigation_detach_pending: ref }))
    expect(InvestigationStore.open(scope).snapshot.attachments).toHaveLength(1)
    const restarted = new SessionMemoryRuntime(f.path, { mode: "assist" })
    expect(restarted.current("owner").investigation_detach_pending).toBeUndefined()
    expect(InvestigationStore.open(scope).snapshot.attachments).toHaveLength(0)
    expect(restarted.current("owner").investigation).toBeUndefined()
    const revision = InvestigationStore.open(scope).snapshot.revision
    // Crash after ledger detach but before the memory intent was cleared.
    restarted.update("owner", (state) => ({ ...state, investigation_detach_pending: ref }))
    const replayed = new SessionMemoryRuntime(f.path, { mode: "assist" })
    expect(replayed.current("owner").investigation_detach_pending).toBeUndefined()
    expect(InvestigationStore.open(scope).snapshot.revision).toBe(revision)
  })

  test("child requires current parent pointer, task epoch and its running node attempt", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    f.memory.delegate("owner", "child", "worker")
    await mutateOwnedRunAsync(f.path, f.run.run_id, "owner", (run) => {
      run.status = "running"
      run.phase = "run"
      run.global_attempts = 1
      run.nodes.discover!.status = "running"
      run.nodes.discover!.current_attempt = 1
      run.nodes.discover!.attempts.push({ attempt: 1, status: "running", session_id: "child",
        started_at: new Date().toISOString(), failures: [] })
    })
    const current = loadRunForOwner(f.path, f.run.run_id, "owner")!
    await f.runtime.child(current, "child", current.graph.nodes[0]!)
    expect(f.runtime.status("child")).toMatchObject({ enabled: true, reference: { run_id: f.run.run_id } })
    await expect(f.runtime.admitWork("child", input, ["discover"])).rejects.toThrow("delegated")
    const unassigned = await f.runtime.admitWork("owner", input, [])
    await expect(f.runtime.executeWork("child", unassigned.work_key)).rejects.toThrow("not assigned")
    const assigned = await f.runtime.admitWork("owner", input, ["discover"])
    expect(assigned.work_key).toBe(unassigned.work_key)
    expect((await f.runtime.executeWork("child", assigned.work_key)).status).toBe("running")
    expect(f.submits).toBe(1)
    await expect(f.runtime.note("child", { next_action: "override" })).rejects.toThrow("children")
    await expect(f.runtime.note("child", { analytical_result: { status: "supported",
      claim: "child override", evidence_refs: [], authority: "reported_analysis" } })).rejects.toThrow("children")
    await expect(f.runtime.hypothesis("child", { id: "h", statement: "x", status: "active", evidence_refs: [] })).rejects.toThrow("delegated")
    await f.runtime.detach("owner")
    expect(() => f.runtime.status("child")).toThrow("lost its parent")
    await f.runtime.attach("owner", f.run.run_id)
    f.memory.beginTask("owner", "new task")
    expect(() => f.runtime.status("child")).toThrow("lost its parent")
  })

  test("checker reads only the owner-granted exact upstream result and cannot execute or duplicate it", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    let submits = 0, reads = 0, validations = 0
    let signalReadStarted!: () => void, completeRead!: () => void
    let signalValidationStarted!: () => void, completeValidation!: () => void, holdValidation = false
    const readStarted = new Promise<void>((resolve) => { signalReadStarted = resolve })
    const releaseRead = new Promise<void>((resolve) => { completeRead = resolve })
    const validationStarted = new Promise<void>((resolve) => { signalValidationStarted = resolve })
    const releaseValidation = new Promise<void>((resolve) => { completeValidation = resolve })
    const port: InvestigationMcpPort = {
      ...f.port,
      submit: async (request) => { submits++; const result = { manifest_ref: `synthetic://producer/${request.operation}`,
        digest: (submits === 1 ? "c" : "d").repeat(64), source_versions: ["snapshot-1"], coverage: { rows: 1 },
        observed_at: new Date().toISOString(), access_scope: "reader" }; return { kind: "result", result, actual_cost: 1 } },
      validateResult: async (result, work) => { validations++; if (holdValidation) { holdValidation = false; signalValidationStarted(); await releaseValidation }
        return { valid: true, validity_key: work.validity_key, access_scope: result.access_scope } },
      readResult: async (result, request) => { reads++; if (request.cursor === "race") { signalReadStarted(); await releaseRead }
        return { manifest_ref: result.manifest_ref, digest: result.digest,
          access_scope: result.access_scope, cursor: request.cursor, next_cursor: null,
          rows: [{ producer_record: result.digest[0] === "c" ? "original one" : "original two" }], coverage: { rows: 1 } } },
    }
    const runtime = new OperationalRuntime(f.memory, {}, { enabled: true, costLimit: 20, perJobReservation: 5,
      continuation: { waitMs: 0, pollIntervalMs: 100 } }, () => port)
    const producerOrder = await runtime.admitWork("owner", input, ["reconcile"])
    await runtime.executeWork("owner", producerOrder.work_key)
    const secondOrder = await runtime.admitWork("owner", { ...input, operation: "second-result" }, ["reconcile"])
    await runtime.executeWork("owner", secondOrder.work_key)
    const firstDigest = "c".repeat(64), secondDigest = "d".repeat(64)
    const ownerStatus = runtime.status("owner")
    if (!("work" in ownerStatus)) throw new Error("expected attached owner status")
    expect(ownerStatus.work).toEqual(expect.arrayContaining([
      expect.objectContaining({ work_key: producerOrder.work_key, manifest_digest: firstDigest }),
      expect.objectContaining({ work_key: secondOrder.work_key, manifest_digest: secondDigest }),
    ]))

    f.memory.delegate("owner", "checker-session", "checker")
    await mutateOwnedRunAsync(f.path, f.run.run_id, "owner", (run) => {
      run.status = "running"
      run.phase = "run"
      run.global_attempts = 1
      run.nodes.check!.status = "running"
      run.nodes.check!.current_attempt = 1
      run.nodes.check!.attempts.push({ attempt: 1, status: "running", session_id: "checker-session",
        started_at: new Date().toISOString(), failures: [] })
    })
    const current = loadRunForOwner(f.path, f.run.run_id, "owner")!
    await runtime.child(current, "checker-session", current.graph.nodes.find((node) => node.id === "check")!)

    const grant = { work_key: producerOrder.work_key, manifest_digest: firstDigest, producer_node: "reconcile", checker_node: "check" }
    await expect(runtime.readResult("checker-session", producerOrder.work_key)).rejects.toThrow("not assigned")
    await expect(runtime.grantCheckerResult("checker-session", grant)).rejects.toThrow("delegated")
    await expect(runtime.grantCheckerResult("owner", { ...grant, manifest_digest: secondDigest })).rejects.toThrow("exact recorded result")
    await expect(runtime.grantCheckerResult("owner", { ...grant, producer_node: "check" })).rejects.toThrow("exact recorded result")
    const tool = createOperationalTools(runtime, async () => {}).alg_investigation
    const grantReply = await tool.execute({ request: { action: "grant_checker_result", ...grant } } as never,
      { sessionID: "owner", worktree: f.path, directory: f.path } as never)
    if (typeof grantReply === "string") throw new Error("expected structured grant result")
    const issued = JSON.parse(grantReply.output)
    expect(issued).toMatchObject({ ...grant, granted_by: "owner" })
    holdValidation = true
    const beforeFetch = runtime.readResult("checker-session", producerOrder.work_key, "pre-fetch")
    await validationStarted
    const revokeBeforeFetch = await tool.execute({ request: { action: "revoke_checker_result", ...grant,
      grant_id: issued.grant_id } } as never,
      { sessionID: "owner", worktree: f.path, directory: f.path } as never)
    if (typeof revokeBeforeFetch === "string") throw new Error("expected structured revoke result")
    completeValidation()
    await expect(beforeFetch).rejects.toThrow("checker result grant changed")
    expect(reads).toBe(0)
    const reissuedBeforeFetch = await runtime.grantCheckerResult("owner", grant)
    expect(reissuedBeforeFetch.grant_id).not.toBe(issued.grant_id)
    const page = await runtime.readResult("checker-session", producerOrder.work_key, null, 10)
    expect(page).toMatchObject({ evidence_only: true, page: { rows: [{ producer_record: "original one" }] } })
    await expect(runtime.readResult("checker-session", secondOrder.work_key)).rejects.toThrow("not assigned")
    const checkerStatus = runtime.status("checker-session")
    if (!("work" in checkerStatus)) throw new Error("expected attached checker status")
    expect(checkerStatus.work.find((entry) => entry.work_key === producerOrder.work_key)).toMatchObject({ manifest_digest: firstDigest })
    expect(checkerStatus.work.find((entry) => entry.work_key === secondOrder.work_key)?.manifest_digest).toBeUndefined()
    expect(JSON.stringify(checkerStatus)).not.toContain(secondDigest)
    expect(checkerStatus.checker_result_grants ?? []).toHaveLength(1)
    const inFlight = runtime.readResult("checker-session", producerOrder.work_key, "race")
    await readStarted
    await expect(runtime.revokeCheckerResult("checker-session", { ...grant, grant_id: reissuedBeforeFetch.grant_id })).rejects.toThrow("delegated")
    const revokeReply = await tool.execute({ request: { action: "revoke_checker_result", ...grant,
      grant_id: reissuedBeforeFetch.grant_id } } as never,
      { sessionID: "owner", worktree: f.path, directory: f.path } as never)
    if (typeof revokeReply === "string") throw new Error("expected structured revoke result")
    expect(JSON.parse(revokeReply.output)).toMatchObject({ revoked_by: "owner" })
    const reissued = await runtime.grantCheckerResult("owner", grant)
    expect(reissued.grant_id).not.toBe(issued.grant_id)
    completeRead()
    await expect(inFlight).rejects.toThrow("checker result grant changed")
    const ledgerAfterRace = InvestigationStore.open({ project_directory: f.path, project_id: f.memory.store.projectId,
      owner_id: "owner", run_id: f.run.run_id }).snapshot
    expect(ledgerAfterRace.work.find((entry) => entry.work_key === producerOrder.work_key)?.result_pages).toHaveLength(1)
    expect(await runtime.readResult("checker-session", producerOrder.work_key, "race")).toMatchObject({
      page: { rows: [{ producer_record: "original one" }] },
    })
    await expect(runtime.executeWork("checker-session", producerOrder.work_key)).rejects.toThrow("not assigned")
    await runtime.revokeCheckerResult("owner", { ...grant, grant_id: reissued.grant_id })
    await expect(runtime.readResult("checker-session", producerOrder.work_key)).rejects.toThrow("not assigned")
    const afterRevoke = runtime.status("checker-session")
    if (!("work" in afterRevoke)) throw new Error("expected attached checker status after revoke")
    expect(afterRevoke.work.find((entry) => entry.work_key === producerOrder.work_key)?.manifest_digest).toBeUndefined()
    expect(runtime.render("checker-session", 8192)).not.toContain("synthetic://producer/bounded-read")
    expect({ submits, reads, validations }).toEqual({ submits: 2, reads: 3, validations: 11 })
  }, 30_000)

  test("recorded result is revalidated for each reuse and permission revocation never resubmits", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    let submits = 0, valid = true
    const result = { manifest_ref: "synthetic://manifest/1", digest: "b".repeat(64),
      source_versions: ["snapshot-1"], coverage: { rows: 2 }, observed_at: new Date().toISOString(),
      access_scope: "reader" }
    const port: InvestigationMcpPort = {
      ...f.port,
      submit: async () => { submits++; return { kind: "result", result, actual_cost: 2 } },
      validateResult: async (_result, work) => ({ valid, validity_key: work.validity_key,
        access_scope: valid ? "reader" : "revoked" }),
    }
    const runtime = new OperationalRuntime(f.memory, {}, { enabled: true, costLimit: 20, perJobReservation: 5, continuation: { waitMs: 0, pollIntervalMs: 100 } }, () => port)
    const first = await runtime.query("owner", input)
    expect(first.result).toMatchObject({ manifest_ref: result.manifest_ref })
    expect((await runtime.query("owner", input)).work_key).toBe(first.work_key)
    expect(submits).toBe(1)
    valid = false
    await expect(runtime.query("owner", input)).rejects.toThrow("validity")
    expect(submits).toBe(1)
    await expect(runtime.attach("other", f.run.run_id)).rejects.toThrow()
  })

  test("typed tool rejects model budget controls and reserves the operator configured maximum", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const tool = createOperationalTools(f.runtime, async () => {}).alg_investigation
    const context = { sessionID: "owner", worktree: f.path, directory: f.path } as never
    const rejected = await tool.execute({ request: { action: "admit", input: {
      ...input, reserved_cost: 1000000,
    } } } as never, context)
    if (typeof rejected === "string") throw new Error("expected structured tool result")
    expect(JSON.parse(rejected.output).error).toBe("invalid_request")
    expect(f.submits).toBe(0)
    const args = { request: { action: "admit" as const, node_ids: [], input: {
      operation: input.operation, recipe_version: input.recipe_version, parameters: input.parameters,
      query: input.query, source_dependencies: input.source_dependencies ?? [],
    } } }
    const order = await tool.execute(args, context)
    if (typeof order === "string") throw new Error("expected structured tool result")
    const execute = { request: { action: "query" as const, work_key: JSON.parse(order.output).work_key as string } }
    const first = await tool.execute(execute, context)
    const second = await tool.execute(execute, context)
    if (typeof first === "string" || typeof second === "string") throw new Error("expected structured tool result")
    expect(JSON.parse(first.output).status).toBe("running")
    expect(JSON.parse(second.output).work_key).toBe(JSON.parse(first.output).work_key)
    expect(f.runtime.status("owner")).toMatchObject({ reserved_cost: 5, admission_count: 1 })
    expect(f.submits).toBe(1)
  })

  test("root analytical assessment stays reported and appears in bounded status context", async () => {
    const f = fixture()
    await f.runtime.begin(f.run)
    const tool = createOperationalTools(f.runtime, async () => {}).alg_investigation
    const context = { sessionID: "owner", worktree: f.path, directory: f.path } as never
    const assessment = { status: "unresolved", claim: "Synthetic evidence leaves two explanations open",
      evidence_refs: ["manifest:1"], authority: "reported_analysis" }
    const recorded = await tool.execute({ request: { action: "note", patch: {
      analytical_result: assessment,
    } } } as never, context)
    if (typeof recorded === "string") throw new Error("expected structured tool result")
    expect(JSON.parse(recorded.output).analytical_result).toEqual(assessment)
    expect(f.runtime.status("owner")).toMatchObject({ checkpoint: { analytical_result: assessment } })
    expect(f.runtime.render("owner", 1024)).toContain("reported_analysis")
    const rejected = await tool.execute({ request: { action: "note", patch: {
      analytical_result: { ...assessment, authority: "verified_truth" },
    } } } as never, context)
    if (typeof rejected === "string") throw new Error("expected structured tool result")
    expect(JSON.parse(rejected.output)).toHaveProperty("error")
    expect(f.runtime.status("owner")).toMatchObject({ checkpoint: { analytical_result: assessment } })
  })

  test("workspace mandatory boundary uses only current operator qualification evidence", () => {
    const path = project()
    const memory = new SessionMemoryRuntime(path, { mode: "assist" })
    memory.beginTask("owner", "Synthetic investigation")
    const registry = JSON.stringify({ schema_version: 1, operations: [{
      id: "data.investigate.read", phase: ["execute"], roles: ["orchestrator"],
      resources: [memory.store.projectId], coverage: "qualified", boundary: "alg_investigation",
      input_validator: "investigation-work-v1", resource_resolver: "investigation-project-v1",
      effects: ["discover", "read", "submit"], verifier_ids: ["operator-verifier"], requirements: [],
    }] })
    mkdirSync(join(path, ".opencode"), { recursive: true })
    writeFileSync(join(path, ".opencode", "ALG.workspace.json"), registry)
    const workspace = { mode: "assist", trustedRegistryHash: createHash("sha256").update(registry).digest("hex"),
      mandatoryOperations: ["data.investigate.read"] }
    const adapter = { endpoint: "http://127.0.0.1:1/mcp", serverId: "logical", serverRevision: "v1",
      principalId: "service", mcpServerName: "synthetic-mcp", mcpServerVersion: "1.0",
      profileEvidence: "operator controlled synthetic receipt", verifierId: "operator-verifier",
      evidenceSha256: "a".repeat(64), verifiedAt: new Date(Date.now() - 1000).toISOString(),
      expiresAt: new Date(Date.now() + 60000).toISOString(), readOnlyOperations: true,
      scopeEnforcedByServer: true, executionLimits: { maxDurationMs: 1000, maxBytesScanned: 4096,
        maxResultBytes: 1024, maxCost: 5 }, idempotentSubmit: true, lookupBySubmissionId: true,
      operations: ["bounded-read"], submit: { name: "submit", schemaHash: "b".repeat(64) },
      lookup: { name: "lookup", schemaHash: "b".repeat(64) },
      validateResult: { name: "validate", schemaHash: "b".repeat(64) },
      responseLimitBytes: 4096 }
    const runtime = new OperationalRuntime(memory, workspace, { enabled: true, adapter })
    expect(() => runtime.workspace.guard("owner", "data.investigate.read")).not.toThrow()
    const wrong = new OperationalRuntime(memory, workspace, { enabled: true,
      adapter: { ...adapter, verifierId: "different-verifier" } })
    expect(() => wrong.workspace.guard("owner", "data.investigate.read")).toThrow("coverage_unknown")
    const expired = new OperationalRuntime(memory, workspace, { enabled: true,
      adapter: { ...adapter, expiresAt: new Date(Date.now() - 1).toISOString() } })
    expect(() => expired.workspace.guard("owner", "data.investigate.read")).toThrow("coverage_unknown")
    const absent = new OperationalRuntime(memory, workspace, { enabled: true })
    expect(() => absent.workspace.guard("owner", "data.investigate.read")).toThrow("coverage_unknown")
  })

  test("review binds complete findings and gates confirmation until fresh review", async () => {
    const f = fixture()
    const run = await f.runtime.begin(f.run)
    for (const id of ["discover", "process", "equipment", "metrology", "reconcile"]) {
      run.nodes[id]!.status = "done"
      run.nodes[id]!.current_attempt = 3
      run.nodes[id]!.output = { finding: id, evidence: ["synthetic"] }
    }
    const basis = investigationReviewBasis(run)
    const selected = await f.runtime.admitWork("owner", { ...input, cohort: "affected", source_dependencies: ["catalog:r7"] }, ["confirm"])
    const substitute = await f.runtime.admitWork("owner", { ...input, cohort: "comparison", source_dependencies: ["catalog:r8"] }, ["confirm"])
    const recipeSubstitute = await f.runtime.admitWork("owner", { ...input, recipe_version: "v2", cohort: "affected",
      source_dependencies: ["catalog:r7"] }, ["confirm"])
    const querySubstitute = await f.runtime.admitWork("owner", { ...input, cohort: "affected", query: { source: "other" },
      source_dependencies: ["catalog:r7"] }, ["confirm"])
    await expect(f.runtime.beforeBatch(run, [run.graph.nodes.find((node) => node.id === "confirm")!]))
      .rejects.toThrow("engineer_review_required")
    recordInvestigationReview(run, "engineer-1", selected.work_key)
    expect(() => requireInvestigationReview(run, selected.work_key)).not.toThrow()
    expect(() => requireInvestigationReview(run, substitute.work_key)).toThrow("engineer_review_required")
    expect(() => requireInvestigationReview(run, recipeSubstitute.work_key)).toThrow("engineer_review_required")
    expect(() => requireInvestigationReview(run, querySubstitute.work_key)).toThrow("engineer_review_required")
    await expect(f.runtime.beforeBatch(run, [run.graph.nodes.find((node) => node.id === "confirm")!]))
      .resolves.toBeUndefined()
    await f.runtime.note("owner", { analytical_result: { status: "unresolved",
      claim: "Two explanations remain", evidence_refs: ["manifest:1"], authority: "reported_analysis" } })
    expect(() => requireInvestigationReview(run, selected.work_key)).toThrow("engineer_review_required")
    recordInvestigationReview(run, "engineer-1", selected.work_key)
    expect(() => requireInvestigationReview(run, selected.work_key)).not.toThrow()
    run.nodes.reconcile!.output = { finding: "different", evidence: ["synthetic"] }
    expect(investigationReviewBasis(run)).not.toBe(basis)
    expect(() => requireInvestigationReview(run, selected.work_key)).toThrow("engineer_review_required")
    await expect(f.runtime.beforeBatch(run, [run.graph.nodes.find((node) => node.id === "confirm")!]))
      .rejects.toThrow("engineer_review_required")
  })
})


test("reviewed recipe admission normalizes parameters and rejects executable-query substitution", async () => {
  const f = fixture()
  const recipe = { operation: "bounded-read", version: "v1", base_query: { recipe: "fixture" },
    parameters: [{ name: "at", type: "iso_timestamp" as const, required: true }] }
  const runtime = new OperationalRuntime(f.memory, {}, { enabled: true, costLimit: 20, perJobReservation: 5,
    recipes: [recipe], continuation: { waitMs: 0, pollIntervalMs: 100 } }, () => f.port)
  await runtime.begin(f.run)
  const first = await runtime.admitRecipe("owner", "bounded-read", "v1", { at: "2026-11-10T00:00:00Z" }, ["discover"])
  const same = await runtime.admitRecipe("owner", "bounded-read", "v1", { at: "2026-11-09T18:00:00-06:00" }, ["discover"])
  expect(same.work_key).toBe(first.work_key)
  expect(f.submits).toBe(0)
  await expect(runtime.admitRecipe("owner", "bounded-read", "v1", { at: "ambiguous" }, ["discover"])).rejects.toThrow("recipe")
  await expect(runtime.admitWork("owner", input, ["discover"])).rejects.toThrow("recipe")
  expect((await runtime.executeWork("owner", first.work_key)).status).toBe("running")
  expect(f.submits).toBe(1)
})

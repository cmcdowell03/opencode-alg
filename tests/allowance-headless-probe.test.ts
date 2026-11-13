/** Local recorder calibration with mock children; actual-host qualification is run separately. */
import { afterEach, expect, test } from "bun:test"
import { allowanceProbePlanArgs, allowanceProbeResponse, observeScopeBeforeChild, readScopeHookEvidence,
  AllowanceScopeEvidenceSchema, ScopeViolationEvidenceSchema, startAllowanceHostProbe, finishAllowanceHostProbe,
  runScopeViolationHostProbe } from "../scripts/allowance-headless-probe.ts"
import { EvidenceSchema, chooseSyntheticResponse } from "../scripts/test-v1-headless.ts"
import { validateGraph } from "../src/graph.ts"
import { bindTaskContract, parseTaskContractInput } from "../src/task-contract.ts"
import { createRun, loadRun } from "../src/store.ts"
import { TaskAllowanceRuntime } from "../src/task-allowance.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { ContextDelivery } from "../src/session-memory/delivery.ts"
import { executeWithMemory } from "../src/session-memory/attempts.ts"
import type { NodePromptOpts } from "../src/sessions.ts"
import { taskEvidence } from "../src/task-evidence.ts"
import { hashObject } from "../src/session-memory/store.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) removeProject(root) })

test("probe declares bounded root-wide scope in every phase and keeps its fresh checker", () => {
  for (const phase of ["initial", "next-phase-after-exhaustion"]) {
    const plan = allowanceProbePlanArgs(phase)
    expect(parseTaskContractInput(plan.task_contract).change_scope).toEqual({ roots: ["."], allowed_paths: [], max_changed_files: 0 })
    expect(plan.task_contract.evidence_plan[0]!.observations).toContainEqual({ kind: "change_scope" })
    const graph = validateGraph(JSON.parse(plan.graph_json))
    expect(graph.max_global_attempts).toBe(2)
    expect(graph.nodes.find(node => node.id === "check")).toMatchObject({ agent: "checker", isolated_check: true })
    expect(() => bindTaskContract(parseTaskContractInput(plan.task_contract), plan.goal, [...plan.criteria], graph,
      { session_id: "session-owner", message_id: "probe" })).not.toThrow()
  }
})

test("both scope cases use the existing local synthetic response before phase-specific behavior", () => {
  const plan = allowanceProbePlanArgs()
  expect(allowanceProbeResponse("unrelated")).toBeUndefined()
  const response = allowanceProbeResponse(plan.goal)!
  const missing = `You are a checker in a fresh child session.\n${plan.goal}`
  expect(JSON.parse(allowanceProbeResponse(missing)!)).toMatchObject({ passed: false })
  expect(JSON.parse(allowanceProbeResponse(`${missing}\n${response}`)!)).toMatchObject({ passed: true })
  for (const phase of ["initial", "background", "followup"] as const)
    expect(chooseSyntheticResponse(phase, 0, { messages: [{ role: "user", content: plan.goal }] })).toMatchObject({ kind: "text", text: response })
})

async function fixture(deliver: "system" | "compaction" | "absent" = "system") {
  const root = tempProject("alg-headless-scope-recorder-"); roots.push(root)
  const owner = "session-owner", plan = allowanceProbePlanArgs(), graph = validateGraph(JSON.parse(plan.graph_json))
  const memory = new SessionMemoryRuntime(root, { mode: "assist" }, [], [])
  const taskContract = bindTaskContract(parseTaskContractInput(plan.task_contract), plan.goal, [...plan.criteria], graph, { session_id: owner, message_id: "probe" })
  const allowance = new TaskAllowanceRuntime(memory.store, { max_dispatches: 2, verification_reserve: 1 })
  const taskAllowance = await allowance.admit(owner, taskContract.contract_sha256)
  const run = createRun({ goal: plan.goal, criteria: [...plan.criteria], graph, taskContract, taskAllowance,
    projectDirectory: root, ownerSessionId: owner })
  expect(() => observeScopeBeforeChild(root, run.run_id, owner)).toThrow("before SDK child creation")
  const before: Partial<Record<"work" | "check", ReturnType<typeof observeScopeBeforeChild>>> = {}
  const publisher = new ContextDelivery(memory)
  const sessionRunner = async (opts: NodePromptOpts) => {
    const node = opts.agent === "checker" ? "check" : "work", child = `child-${node}`
    before[node] = observeScopeBeforeChild(root, run.run_id, owner)
    await opts.onSessionCreated!(child)
    if (deliver !== "absent") {
      const pack = memory.prepare(child)
      await publisher.replace(child, deliver, [], async (parts, prepare) => {
        parts.push(pack.text); await prepare(pack.receipt!, pack.text)
      })
      expect(memory.store.delivery(child)!.value.state).toBe("emitted")
    }
    return { session_id: child, text: "", parsed: JSON.parse(allowanceProbeResponse(opts.userPrompt)!) }
  }
  await executeWithMemory(memory, run, { ...executeContext(root), taskAllowance: allowance, sessionRunner })
  expect(run.status).toBe("done")
  return { root, run, memory, owner, before }
}

test("recorder binds real persisted baseline, child delegation and emitted delivery receipt", async () => {
  const f = await fixture()
  const producer = readScopeHookEvidence(f.root, f.run.run_id, f.owner, "work", f.before.work!)
  const checker = readScopeHookEvidence(f.root, f.run.run_id, f.owner, "check", f.before.check!)
  expect(producer.passed).toBe(true); expect(checker.passed).toBe(true)
  expect(checker.child_session_id).not.toBe(producer.child_session_id)
  expect(producer.before_child.baseline_sha256).toBe(checker.before_child.baseline_sha256)
  expect(checker.delivery_sha256).toBe(f.memory.store.delivery(checker.child_session_id)!.id)
  expect(checker.checkpoint_sha256).toBe(f.memory.store.delivery(checker.child_session_id)!.value.checkpoint)
  const observed = taskEvidence(f.run)!
  expect(observed.change_scope!.status).toBe("within_scope")
  const persisted = loadRun(f.root, f.run.run_id)!
  expect(persisted.nodes.check!.attempts[0]!.task_evidence_ref!.sha256).toBe(hashObject(observed))
  expect(AllowanceScopeEvidenceSchema.safeParse({ passed: true, baseline_sha256: hashObject(f.run.task_baseline),
    exclusion_policy_version: 2, exclusions: f.run.task_baseline!.change_scope!.exclusions, producer_hook: producer, checker_hook: checker,
    final_status: "within_scope", changed_count: 0, checker_evidence_matches: true }).success).toBe(true)
})

test("scope success alone cannot attest absent host delivery writes", async () => {
  const f = await fixture("absent")
  expect(readScopeHookEvidence(f.root, f.run.run_id, f.owner, "work", f.before.work!)).toMatchObject({
    passed: false, baseline_retained: true, hook_emitted_after_baseline: false, delivery_sha256: null,
  })
})

test("compaction delivery is not mislabeled as a child's system hook", async () => {
  const f = await fixture("compaction")
  expect(readScopeHookEvidence(f.root, f.run.run_id, f.owner, "check", f.before.check!)).toMatchObject({
    passed: false, delivery_state: "emitted", delivery_hook: "compaction", hook_emitted_after_baseline: false,
  })
})

test("recorder rejects an older delivery or a different baseline identity", async () => {
  const f = await fixture()
  const later = { ...f.before.work!, observed_at: new Date(Date.now() + 60000).toISOString() }
  expect(readScopeHookEvidence(f.root, f.run.run_id, f.owner, "work", later)).toMatchObject({ passed: false, hook_emitted_after_baseline: false })
  expect(readScopeHookEvidence(f.root, f.run.run_id, f.owner, "work", { ...f.before.work!, baseline_sha256: "0".repeat(64) }))
    .toMatchObject({ passed: false, baseline_retained: false })
})

test("report accepts old receipts without new fields and validates new bounded fields when present", () => {
  const old = { passed: true, run_id: "legacy", task_id: "a".repeat(64), reserved_before_compaction: 1,
    reserved_after_restarts: 1, reserved_after_checker: 2, additional_dispatches_after_exhaustion: 0,
    checker_parent_verified: true, scope: "Historic allowance-only evidence" }
  expect(EvidenceSchema.shape.task_allowance_probe.parse(old)).toEqual(old)
  expect(EvidenceSchema.shape.task_allowance_probe.safeParse({ ...old, scope_regression: { passed: true } }).success).toBe(false)
  expect(EvidenceSchema.shape.task_scope_violation_probe.isOptional()).toBe(true)
  expect(ScopeViolationEvidenceSchema.safeParse({ passed: true }).success).toBe(false)
  expect(ScopeViolationEvidenceSchema.shape.additional_sdk_creates.safeParse(-1).success).toBe(false)
})

test("SDK transport calibration retains 2/1 exhaustion and independently blocks user drift without a fourth prompt", async () => {
  const project = tempProject("alg-scope-probe-positive-"), negative = tempProject("alg-scope-probe-negative-")
  roots.push(project, negative)
  const sessions = new Map<string, { id: string; parentID?: string; directory: string }>()
  const prompted: string[] = [], unexpected: string[] = []
  // Deliberately a local transport fixture, not OpenCode. It invokes the production
  // memory publisher to calibrate the probe's SDK wiring and receipt predicates.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url), parts = url.pathname.split("/").filter(Boolean)
    if (url.pathname === "/agent") return Response.json([{ name: "checker", tools: { read: true, glob: true }, permission: { read: "allow", glob: "allow" } }])
    if (url.pathname === "/log" || request.method === "PATCH") return Response.json(true)
    if (url.pathname === "/session" && request.method === "POST") {
      const body = await request.json() as { parentID?: string }
      const session = { id: `local-session-${sessions.size + 1}`, ...(body.parentID ? { parentID: body.parentID } : {}), directory: url.searchParams.get("directory")! }
      sessions.set(session.id, session)
      return Response.json(session)
    }
    const session = parts[0] === "session" ? sessions.get(parts[1]!) : undefined
    if (session && parts.length === 2 && request.method === "GET") return Response.json(session)
    if (session && parts[2] === "children") return Response.json([...sessions.values()].filter(child => child.parentID === session.id))
    if (session && parts[2] === "message" && parts.length === 4) return Response.json({ error: "fixture message absent" }, { status: 404 })
    if (session && parts[2] === "message" && request.method === "GET") return Response.json([])
    if (session && parts[2] === "message" && request.method === "POST") {
      prompted.push(session.id)
      const body = await request.json() as { parts: Array<{ text: string }> }
      const memory = new SessionMemoryRuntime(session.directory, { mode: "assist" }, [], [])
      const pack = memory.prepare(session.id)
      await new ContextDelivery(memory).replace(session.id, "system", [], async (working, prepare) => {
        working.push(pack.text); await prepare(pack.receipt!, pack.text)
      })
      return Response.json({ info: { id: `reply-${session.id}`, sessionID: session.id, role: "assistant" },
        parts: [{ type: "text", text: allowanceProbeResponse(body.parts.map(part => part.text).join("\n")) }] })
    }
    unexpected.push(`${request.method} ${url.pathname}`)
    return Response.json({ error: "unexpected fixture route" }, { status: 404 })
  } })
  try {
    const base = `http://127.0.0.1:${server.port}`
    const root = await (await fetch(`${base}/session?directory=${encodeURIComponent(project)}`, { method: "POST", body: "{}" })).json() as { id: string }
    const start = await startAllowanceHostProbe(base, project, root.id)
    const positive = await finishAllowanceHostProbe(base, project, root.id, start)
    expect(positive).toMatchObject({ passed: true, reserved_before_compaction: 1, reserved_after_restarts: 1,
      reserved_after_checker: 2, additional_dispatches_after_exhaustion: 0, scope_regression: { passed: true, final_status: "within_scope" } })
    const violation = await runScopeViolationHostProbe(base, negative, project, root.id)
    expect(violation).toMatchObject({ passed: true, distinct_task: true, max_dispatches: 2, verification_reserve: 1,
      baseline_retained: true, scope_status: "violated", changed_count: 1, run_phase: "task-prerequisite", scope_error_observed: true,
      attempts_before: 1, attempts_after: 1, checker_attempts: 0, additional_sdk_creates: 0, additional_sdk_prompts: 0,
      reserved_before: 1, reserved_after: 1, ledger_unchanged: true, positive_ledger_unchanged: true })
    expect(violation.host_children_after).toEqual(violation.host_children_before)
    expect(prompted).toHaveLength(3)
    expect(unexpected).toEqual([])
    expect(EvidenceSchema.shape.task_scope_violation_probe.safeParse(violation).success).toBe(true)
    expect(EvidenceSchema.shape.task_allowance_probe.safeParse(positive).success).toBe(true)
  } finally { await server.stop(true) }
}, 60000)

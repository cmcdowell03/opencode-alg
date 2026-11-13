import { afterEach, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { platform } from "node:process"
import {
  CHANGE_SCOPE_EXCLUSIONS, CHANGE_SCOPE_RUNTIME_EXCLUSIONS, LEGACY_CHANGE_SCOPE_EXCLUSIONS,
  ChangeScopeBasisSchema, captureChangeScopeBasis, finishChangeScopeEvidence,
} from "../src/change-scope-evidence.ts"
import { assertTaskBaseline, captureTaskBaseline } from "../src/task-baseline.ts"
import { assertTaskEvidence, taskEvidence } from "../src/task-evidence.ts"
import { prepareRunForResume } from "../src/executor.ts"
import { validateGraph } from "../src/graph.ts"
import { sha256Json } from "../src/persistence.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { ContextDelivery } from "../src/session-memory/delivery.ts"
import { executeWithMemory } from "../src/session-memory/attempts.ts"
import type { NodePromptOpts } from "../src/sessions.ts"
import { createRun, hydrateRunFully, loadRun, persistRun } from "../src/store.ts"
import { bindTaskContract } from "../src/task-contract.ts"
import { TaskAllowanceRuntime } from "../src/task-allowance.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

const projects: string[] = []
afterEach(() => { for (const root of projects.splice(0)) removeProject(root) })
function project() { const root = tempProject("alg-scope-runtime-"); projects.push(root); return root }
function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text)
}
const scope = { roots: ["."], allowed_paths: ["report.json"], max_changed_files: 1 }
const skill = ".opencode/skills/local/SKILL.md"
const config = ".opencode/ALG.workspace.json"
const unknown = ".opencode/user-notes.txt"

test("new bounded policy excludes only root runtime stores, retaining skills, config and unknown paths", () => {
  const root = project()
  const visible = [skill, config, unknown, ".opencode/session-memory-user.txt", "nested/.opencode/session-memory/user.txt"]
  for (const path of visible) write(root, path, "original")
  // Larger than the scope file bound, but confined to the known host store.
  for (let i = 0; i < 257; i++) write(root, `.opencode/session-memory/checkpoints/${i}.json`, "host metadata")
  for (const path of CHANGE_SCOPE_RUNTIME_EXCLUSIONS) write(root, `${path}/host.json`, "before")
  const basis = captureChangeScopeBasis(root, scope)
  expect(basis.version).toBe(2)
  expect(basis.exclusions).toEqual([...CHANGE_SCOPE_EXCLUSIONS])
  expect(basis.files.map(f => f.path)).toEqual(visible.sort())
  for (const path of CHANGE_SCOPE_RUNTIME_EXCLUSIONS) write(root, `${path}/host.json`, "after")
  expect(finishChangeScopeEvidence(root, scope, basis)).toMatchObject({ status: "within_scope", changed: [], after_sha256: sha256Json(basis) })
  write(root, config, "changed config")
  rmSync(join(root, skill))
  write(root, ".opencode/new-user-file.txt", "unexpected")
  expect(finishChangeScopeEvidence(root, scope, basis)).toMatchObject({ status: "violated", changed: [
    { path: config, kind: "modified" }, { path: ".opencode/new-user-file.txt", kind: "added" }, { path: skill, kind: "deleted" },
  ] })
})

test("explicit runtime descendants in roots or allowed paths stay observed, including siblings", () => {
  for (const runtime of CHANGE_SCOPE_RUNTIME_EXCLUSIONS) {
    for (const explicitRoot of [false, true]) {
      const root = project(), path = `${runtime}/requested.json`, sibling = `${runtime}/other.json`
      write(root, path, "original"); write(root, sibling, "original")
      const input = { roots: explicitRoot ? [runtime] : ["."], allowed_paths: [path], max_changed_files: 1 }
      const basis = captureChangeScopeBasis(root, input)
      expect(basis.exclusions).not.toContain(runtime)
      expect(basis.files.map(f => f.path)).toEqual([sibling, path])
      write(root, path, "allowed")
      expect(finishChangeScopeEvidence(root, input, basis).status).toBe("within_scope")
      write(root, sibling, "unexpected")
      expect(finishChangeScopeEvidence(root, input, basis).status).toBe("violated")
      expect(finishChangeScopeEvidence(root, input, { ...basis, exclusions: [...CHANGE_SCOPE_EXCLUSIONS] }).failure).toBe("invalid_baseline")
    }
  }
})

test("Windows casing cannot erase an explicitly declared runtime path", () => {
  if (platform !== "win32") return
  const root = project(), path = ".OpenCode/Session-Memory/user.txt"
  write(root, path, "original")
  const input = { ...scope, allowed_paths: [path] }, basis = captureChangeScopeBasis(root, input)
  expect(basis.exclusions).not.toContain(".opencode/session-memory")
  write(root, path, "allowed")
  expect(finishChangeScopeEvidence(root, input, basis).status).toBe("within_scope")
})

function declaration(preserve: string[] = [], destination = "report.json") {
  const graph = validateGraph({ name: "runtime-scope", max_global_attempts: 4, max_concurrency: 1, nodes: [
    { id: "work", agent: "implementer", depends_on: [], loop: { gate: "schema", max_attempts: 2 },
      ...(preserve.length ? { inputs: { preserve_paths: JSON.stringify(preserve) } } : {}) },
    { id: "check", agent: "checker", depends_on: ["work"], isolated_check: true, loop: { gate: "schema", max_attempts: 2 } },
  ] })
  const goal = "Write and independently check report.json", criteria = ["Write the report", "Only declared project files change"]
  const taskContract = bindTaskContract({ version: 1, kind: "project_change", discovery: "not_required", phase: "complete",
    deliverables: [{ destination: "project_file", path: destination, producer_node: "work" }],
    verification: { checker_node: "check", execution: "none" }, preserve_paths: preserve, change_scope: scope,
    evidence_plan: [
      { criterion: 1, observations: [{ kind: "deliverable", index: 0 }] },
      { criterion: 2, observations: [{ kind: "change_scope" }, ...(preserve.length ? [{ kind: "preservation" as const, paths: preserve }] : [])] },
    ],
  }, goal, criteria, graph, { session_id: "session-owner", message_id: "accepted" })
  return { graph, goal, criteria, taskContract }
}

test("task baseline protects explicitly preserved and deliverable paths inside runtime stores", () => {
  for (const preserved of [false, true]) {
    const root = project(), path = ".opencode/session-memory/user.txt"
    write(root, path, "original")
    const { taskContract } = preserved ? declaration([path]) : declaration([], path)
    const baseline = captureTaskBaseline(root, taskContract)
    expect(baseline.change_scope!.exclusions).not.toContain(".opencode/session-memory")
    expect(baseline.change_scope!.files.map(f => f.path)).toContain(path)
    write(root, path, "changed")
    expect(finishChangeScopeEvidence(root, scope, baseline.change_scope).status).toBe("violated")
    expect(() => assertTaskBaseline({ ...baseline, change_scope: { ...baseline.change_scope!, exclusions: [...CHANGE_SCOPE_EXCLUSIONS] } }, taskContract))
      .toThrow("task_baseline_invalid")
  }
})

// Reconstruct the historical scanner's fixed-list manifest BEFORE work; never migrate a live baseline.
function legacyBasis(root: string) {
  return ChangeScopeBasisSchema.parse({ ...captureChangeScopeBasis(root, scope, CHANGE_SCOPE_RUNTIME_EXCLUSIONS),
    version: 1, exclusions: [...LEGACY_CHANGE_SCOPE_EXCLUSIONS] })
}

test("v1 comparison retains exact provenance and detects runtime and user changes without migration", () => {
  const root = project(), checkpoint = ".opencode/session-memory/checkpoints/original.json"
  write(root, checkpoint, "before"); write(root, skill, "before")
  const basis = legacyBasis(root), before = sha256Json(basis)
  expect(finishChangeScopeEvidence(root, scope, basis)).toMatchObject({ status: "within_scope", before_sha256: before, after_sha256: before })
  write(root, checkpoint, "updated checkpoint"); write(root, skill, "changed user skill")
  expect(finishChangeScopeEvidence(root, scope, basis)).toMatchObject({ status: "violated", before_sha256: before, changed: [
    { path: checkpoint, kind: "modified" }, { path: skill, kind: "modified" },
  ] })
  expect(sha256Json(basis)).toBe(before)
  expect(ChangeScopeBasisSchema.safeParse({ ...basis, exclusions: [...CHANGE_SCOPE_EXCLUSIONS] }).success).toBe(false)
  expect(ChangeScopeBasisSchema.safeParse({ ...basis, version: 2, exclusions: [...CHANGE_SCOPE_EXCLUSIONS].reverse() }).success).toBe(false)
})

async function fixture(mode: "assist" | "off" = "assist") {
  const root = project(), declared = declaration(), memory = new SessionMemoryRuntime(root, { mode }, [], [])
  const delivery = new ContextDelivery(memory)
  const publish = async (owner: string, hook: "system" | "compaction") => {
    const pack = memory.prepare(owner)
    expect(pack.receipt).not.toBeNull()
    // The production hook's own publisher writes and settles the real delivery journal.
    await delivery.replace(owner, hook, [], async (working, prepare) => {
      working.push(pack.text); await prepare(pack.receipt!, pack.text)
    })
    expect(memory.store.delivery(owner)!.value.state).toBe("emitted")
  }
  for (const path of [skill, config, unknown]) write(root, path, "original user file")
  if (memory.enabled) { memory.beginTask("session-owner", declared.goal); memory.prepare("session-owner") }
  const allowance = new TaskAllowanceRuntime(memory.store, { max_dispatches: 4, verification_reserve: 1 })
  const taskAllowance = await allowance.admit("session-owner", declared.taskContract.contract_sha256)
  const run = createRun({ ...declared, taskAllowance, projectDirectory: root, ownerSessionId: "session-owner" })
  const calls: string[] = [], children: string[] = [], initialRevision = memory.store.checkpoint("session-owner")!.revision
  const options = (action?: (agent: string) => void) => ({ ...executeContext(root), taskAllowance: allowance,
    sessionRunner: async (opts: NodePromptOpts) => {
      calls.push(opts.agent)
      const child = `child-${calls.length}`; children.push(child)
      const durable = loadRun(root, run.run_id)!
      expect(durable.task_baseline).toEqual(run.task_baseline)
      // Actual create->prompt callback invokes executeWithMemory's real delegation write.
      await opts.onSessionCreated!(child)
      if (memory.enabled) {
        expect(memory.current(child).delegation?.role).toBe(opts.agent === "checker" ? "checker" : "worker")
        memory.update("session-owner", current => ({ ...current, next_step: `dispatch-${calls.length}` }))
        await publish("session-owner", "system")
        await publish(child, "system")
        memory.compact("session-owner")
        await publish("session-owner", "compaction")
      }
      if (opts.agent === "implementer") write(root, "report.json", '{"answer":42}')
      action?.(opts.agent)
      return { session_id: child, text: "", parsed: opts.agent === "checker" ? { passed: true, score: 10, failures: [] }
        : { summary: ["report written"], files_touched: ["report.json"], commands_run: [], risks: [], done: true } }
    },
  })
  return { root, memory, allowance, run, calls, children, initialRevision, options }
}

for (const mode of ["assist", "off"] as const) {
  test(`real MemoryStore writes after baseline permit fresh checker and durable proof (memory ${mode})`, async () => {
    const f = await fixture(mode)
    await executeWithMemory(f.memory, f.run, f.options())
    expect(f.run.status).toBe("done")
    expect(f.calls).toEqual(["implementer", "checker"])
    expect(new Set(f.children).size).toBe(2)
    expect(f.run.nodes.check!.current_attempt).toBe(1)
    expect(f.memory.store.checkpoint("session-owner")!.revision).toBeGreaterThan(f.initialRevision)
    expect(f.memory.store.checkpoint("session-owner")!.task_allowance!.entries.map(e => e.kind)).toEqual(["producer", "verification"])
    const evidence = taskEvidence(f.run)!
    expect(evidence.change_scope).toMatchObject({ status: "within_scope", changed_count: 1,
      changed_sample: [{ path: "report.json", kind: "added" }], exclusions: [...CHANGE_SCOPE_EXCLUSIONS], exclusion_policy_version: 2 })
    expect(f.run.task_baseline!.change_scope!.files.map(f => f.path)).toEqual([config, unknown, skill].sort())
    expect(f.run.nodes.check!.attempts[0]!.task_evidence_ref).toBeDefined()
    expect(hydrateRunFully(loadRun(f.root, f.run.run_id)!).status).toBe("done")
    const checkpoint = f.memory.store.checkpoint("session-owner")!
    // Even memory-off still uses the real checkpoint store for mandatory allowance state.
    f.memory.store.update(checkpoint.owner, checkpoint.revision, value => ({ ...value, generation: value.generation + 1 }))
    expect(taskEvidence(f.run)).toEqual(evidence)
    expect(() => assertTaskEvidence(evidence, f.run.task_contract!, f.run.run_id, f.run.task_baseline)).not.toThrow()
    const forged = structuredClone(evidence); forged.change_scope!.exclusions = [...LEGACY_CHANGE_SCOPE_EXCLUSIONS]
    expect(() => assertTaskEvidence(forged, f.run.task_contract!, f.run.run_id, f.run.task_baseline)).toThrow("identity mismatch")
  })
}

for (const path of [skill, config, unknown]) {
  test(`real memory writes do not hide user violation at ${path} or reset baseline on resume`, async () => {
    const f = await fixture()
    await expect(executeWithMemory(f.memory, f.run, f.options(agent => {
      if (agent === "implementer") write(f.root, path, "unpermitted change")
    }))).rejects.toThrow("task_change_scope_unverified")
    expect(f.calls).toEqual(["implementer"])
    expect(f.run.nodes.check!.current_attempt).toBe(0)
    expect(taskEvidence(f.run)!.change_scope).toMatchObject({ status: "violated", changed_count: 2 })
    const baseline = structuredClone(f.run.task_baseline)
    const resumed = prepareRunForResume(loadRun(f.root, f.run.run_id)!)
    await executeWithMemory(f.memory, resumed, { ...f.options(), operation: "resume" })
    expect(resumed.status).toBe("blocked"); expect(resumed.task_baseline).toEqual(baseline)
    expect(f.calls).toEqual(["implementer"])
    resumed.task_baseline = captureTaskBaseline(f.root, resumed.task_contract!)
    expect(() => persistRun(resumed, f.root)).toThrow("immutable")
    expect(loadRun(f.root, f.run.run_id)!.task_baseline).toEqual(baseline)
  })
}

for (const path of ["report.json", skill]) {
  test(`fresh checker cannot bless post-snapshot user drift at ${path}`, async () => {
    const f = await fixture()
    await executeWithMemory(f.memory, f.run, f.options(agent => {
      if (agent === "checker") write(f.root, path, "post-snapshot drift")
    }))
    expect(f.calls).toEqual(["implementer", "checker"])
    expect(f.run.status).toBe("blocked"); expect(f.run.phase).toBe("task-evidence")
    expect(f.run.summary).toMatch(/task_evidence_changed|task_change_scope_unverified/)
  })
}

test("legacy admitted run remains fail-closed on runtime drift and retains its original baseline on resume", async () => {
  const f = await fixture()
  f.run.task_baseline = { version: 1, contract_sha256: f.run.task_contract!.contract_sha256, change_scope: legacyBasis(f.root) }
  persistRun(f.run, f.root)
  const baseline = structuredClone(f.run.task_baseline)
  await expect(executeWithMemory(f.memory, f.run, f.options())).rejects.toThrow("task_change_scope_unverified")
  expect(f.calls).toEqual(["implementer"])
  expect(f.run.nodes.check!.current_attempt).toBe(0)
  expect(taskEvidence(f.run)!.change_scope!.exclusions).toEqual([...LEGACY_CHANGE_SCOPE_EXCLUSIONS])
  expect(taskEvidence(f.run)!.change_scope!.exclusion_policy_version).toBeUndefined()
  const resumed = prepareRunForResume(loadRun(f.root, f.run.run_id)!)
  await executeWithMemory(f.memory, resumed, { ...f.options(), operation: "resume" })
  expect(resumed.status).toBe("blocked"); expect(f.calls).toEqual(["implementer"])
  expect(loadRun(f.root, f.run.run_id)!.task_baseline).toEqual(baseline)
})

test("completed v1 evidence retains its original projection identity across load and resume", async () => {
  const root = project(), declared = declaration()
  const run = createRun({ ...declared, projectDirectory: root, ownerSessionId: "session-owner" })
  run.task_baseline = { version: 1, contract_sha256: declared.taskContract.contract_sha256, change_scope: legacyBasis(root) }
  persistRun(run, root)
  const calls: string[] = []
  const options = { ...executeContext(root), sessionRunner: async (opts: NodePromptOpts) => {
    calls.push(opts.agent)
    if (opts.agent === "implementer") write(root, "report.json", '{"answer":42}')
    return { session_id: `legacy-${calls.length}`, text: "", parsed: opts.agent === "checker" ? { passed: true, score: 10, failures: [] }
      : { summary: ["done"], files_touched: ["report.json"], commands_run: [], risks: [], done: true } }
  } }
  await executeWithMemory(undefined, run, options)
  expect(run.status).toBe("done")
  const evidence = taskEvidence(run)!
  expect(evidence.change_scope!.exclusions).toEqual([...LEGACY_CHANGE_SCOPE_EXCLUSIONS])
  expect(Object.hasOwn(evidence.change_scope!, "exclusion_policy_version")).toBe(false)
  expect(evidence.change_scope!.after_sha256).toBe(sha256Json(legacyBasis(root)))
  expect(run.nodes.check!.attempts[0]!.task_evidence_ref!.sha256).toBe(sha256Json(evidence))
  const resumed = prepareRunForResume(hydrateRunFully(loadRun(root, run.run_id)!))
  await executeWithMemory(undefined, resumed, { ...options, operation: "resume" })
  expect(resumed.status).toBe("done"); expect(calls).toEqual(["implementer", "checker"])
  expect(taskEvidence(resumed)).toEqual(evidence)
})

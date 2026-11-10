import { afterEach, describe, expect, test } from "bun:test"
import server from "../src/index.ts"
import { executeRun } from "../src/executor.ts"
import { InvestigationStore } from "../src/investigation/index.ts"
import { mutateOwnedRun } from "../src/ownership.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { createRun, findLatestRunForSession, loadRunForOwner } from "../src/store.ts"
import { getTemplate } from "../src/templates.ts"
import { executeContext, removeProject, singleImplementGraph, tempProject } from "./helpers.ts"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) removeProject(dir) })
function fixture() { const path = tempProject("alg-investigation-hooks-"); dirs.push(path); return path }
function plugin(path: string) {
  return { directory: path, worktree: path, project: { id: "fixture-project" }, client: {
    app: { log: async () => ({ data: true }) }, session: {
      get: async (request: any) => ({ data: { id: request.path.id, projectID: "fixture-project", directory: path, title: "owner" } }),
      messages: async () => ({ data: [] }),
      create: async () => { throw new Error("unexpected child creation") },
      prompt: async () => { throw new Error("unexpected model call") },
    },
  } } as any
}
function context(path: string) { return { sessionID: "owner", messageID: "m1", agent: "orchestrator", directory: path,
  worktree: path, abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as any }
function output(value: unknown) { return JSON.parse((value as { output: string }).output) }

describe("investigation host boundaries", () => {
  test("fixed template planning fails closed when disabled and rejects graph or gate overrides", async () => {
    const path = fixture(), hooks = await server(plugin(path), { sessionMemory: { mode: "assist" },
      investigation: { enabled: false }, skillEvolution: { enabled: false } } as any)
    try {
      const plan = hooks.tool!.alg_plan!
      expect(output(await plan.execute({ goal: "Investigate particles", template: "data-investigation" }, context(path))).error).toContain("enabled configuration")
      expect(findLatestRunForSession(path, "owner")).toBeNull()
      expect(output(await plan.execute({ goal: "Investigate particles", template: "data-investigation", graph_json: JSON.stringify(getTemplate("data-investigation")) }, context(path))).error).toContain("unmodified fixed")
      expect(output(await plan.execute({ goal: "Investigate particles", graph_json: JSON.stringify(getTemplate("data-investigation")) }, context(path))).error).toContain("built-in")
      expect(output(await plan.execute({ goal: "Investigate particles", template: "data-investigation", shell_gate: "echo changed" }, context(path))).error).toContain("unmodified fixed")
      expect(findLatestRunForSession(path, "owner")).toBeNull()
      expect(output(await plan.execute({ goal: "Ordinary work", template: "coding-diamond" }, context(path))).run_id).toBeTruthy()
    } finally { await hooks.dispose?.() }
  })

  test("actual plan seals the normalized graph and managed run blocks criterion and gate mutation", async () => {
    const path = fixture(), hooks = await server(plugin(path), { sessionMemory: { mode: "assist" },
      investigation: { enabled: true }, skillEvolution: { enabled: false } } as any)
    try {
      const planned = output(await hooks.tool!.alg_plan!.execute({ goal: "Investigate particles", template: "data-investigation",
        criteria: ["Keep causal claims bounded"] }, context(path)))
      expect(planned.error).toBeUndefined()
      const id = planned.run_id as string
      expect(loadRunForOwner(path, id, "owner")?.investigation).toBeTruthy()
      expect(output(await hooks.tool!.alg_criteria!.execute({ run_id: id, criteria: ["Changed"] }, context(path))).error).toContain("criteria are fixed")
      expect(output(await hooks.tool!.alg_run!.execute({ run_id: id, shell_gate: "echo changed" }, context(path))).error).toContain("fixed")
      expect(output(await hooks.tool!.alg_resume!.execute({ run_id: id, shell_gate: "echo changed" }, context(path))).error).toContain("fixed")
      expect(loadRunForOwner(path, id, "owner")?.global_attempts).toBe(0)
    } finally { await hooks.dispose?.() }
  })

  test("an orphan investigation graph cannot execute and resume guard runs before reopening attempts", async () => {
    const path = fixture(), hooks = await server(plugin(path), { sessionMemory: { mode: "assist" },
      investigation: { enabled: true }, skillEvolution: { enabled: false } } as any)
    try {
      const run = createRun({ projectDirectory: path, ownerSessionId: "owner", goal: "orphan", criteria: [], graph: getTemplate("data-investigation") })
      expect(output(await hooks.tool!.alg_run!.execute({ run_id: run.run_id }, context(path))).error).toContain("no managed investigation reference")
      await expect(executeRun(run, { ...executeContext(path), parentSessionId: "owner" })).rejects.toThrow("no managed investigation reference")
      const memory = new SessionMemoryRuntime(path, { mode: "assist" })
      mutateOwnedRun(path, run.run_id, "owner", (fresh) => { fresh.investigation = {
        schema_version: 1, project_id: memory.store.projectId, owner_id: "owner", run_id: run.run_id } })
      await expect(executeRun(loadRunForOwner(path, run.run_id, "owner")!, { ...executeContext(path), parentSessionId: "owner" })).rejects.toThrow("reconciliation guard")
      expect(output(await hooks.tool!.alg_resume!.execute({ run_id: run.run_id }, context(path))).error).toContain("explicitly attach")
      expect(loadRunForOwner(path, run.run_id, "owner")).toMatchObject({ status: "planning", global_attempts: 0 })
    } finally { await hooks.dispose?.() }
  })

  test("batch guard fails before any child or attempt reservation", async () => {
    const path = fixture()
    const run = createRun({ projectDirectory: path, ownerSessionId: "session-owner", goal: "guard", criteria: [], graph: singleImplementGraph() })
    let sawGuard = false
    await expect(executeRun(run, { ...executeContext(path), beforeBatch: async (current, nodes) => {
      expect(nodes.map((node) => node.id)).toEqual(["work"])
      expect(current.global_attempts).toBe(0)
      expect(current.nodes.work?.attempts).toHaveLength(0)
      sawGuard = true
      throw new Error("reconciliation blocks batch")
    } })).rejects.toThrow("reconciliation blocks batch")
    expect(sawGuard).toBe(true)
    expect(loadRunForOwner(path, run.run_id, "session-owner")).toMatchObject({ status: "blocked", global_attempts: 0 })
  })

  test("normal and compaction hooks retain the durable pointer within the context ceiling", async () => {
    const path = fixture(), hooks = await server(plugin(path), { sessionMemory: { mode: "assist" },
      investigation: { enabled: true }, skillEvolution: { enabled: false } } as any)
    try {
      const memory = new SessionMemoryRuntime(path, { mode: "assist" })
      const run = createRun({ projectDirectory: path, ownerSessionId: "owner", goal: "pointer", criteria: [], graph: getTemplate("data-investigation") })
      const store = InvestigationStore.open({ project_directory: path, project_id: memory.store.projectId, owner_id: "owner", run_id: run.run_id }, { create: true, costLimit: 100 })
      mutateOwnedRun(path, run.run_id, "owner", (fresh) => { fresh.investigation = store.reference })
      memory.update("owner", (state) => ({ ...state, investigation: store.reference }))
      const normal = { system: ["foreign"] }
      await hooks["experimental.chat.system.transform"]!({ sessionID: "owner", model: { limit: { context: 4_000, output: 1_000 } } } as any, normal)
      expect(normal.system.join("\n")).toContain(`ALG investigation run ${run.run_id}`)
      const compact = { context: ["foreign"] }
      await hooks["experimental.session.compacting"]!({ sessionID: "owner" }, compact)
      expect(compact.context.join("\n")).toContain(`ALG investigation run ${run.run_id}`)
      const tiny = { system: ["foreign"] }
      await hooks["experimental.chat.system.transform"]!({ sessionID: "owner", model: { limit: { context: 128, output: 64 } } } as any, tiny)
      expect(tiny.system[0]).toBe("foreign")
      expect(tiny.system.join("\n")).not.toContain(`ALG investigation run ${run.run_id}`)
      expect(output(await hooks.tool!.alg_run!.execute({ run_id: run.run_id }, context(path))).error).toContain("needs_context")
      expect(loadRunForOwner(path, run.run_id, "owner")?.global_attempts).toBe(0)
    } finally { await hooks.dispose?.() }
  })
})


test("a simple host tool call records an advisory workspace operation without model-supplied operation", async () => {
  const path = fixture(), hooks = await server(plugin(path), { sessionMemory: { mode: "assist" },
    workspace: { mode: "observe" }, skillEvolution: { enabled: false } } as any)
  try {
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "owner", callID: "t1" }, { args: { command: "bun test" } })
    expect(new SessionMemoryRuntime(path, { mode: "assist" }).current("owner").workspace_operation).toBe("repo.test")
    await hooks["tool.execute.before"]!({ tool: "bash", sessionID: "owner", callID: "t2" }, { args: { command: "echo git status" } })
    expect(new SessionMemoryRuntime(path, { mode: "assist" }).current("owner").workspace_operation).toBe("repo.test")
  } finally { await hooks.dispose?.() }
})

import { describe, expect, test } from "bun:test"
import { createAlgTools } from "../src/tools.ts"
import { runNodeSession } from "../src/sessions.ts"
import { createRun, persistRun } from "../src/store.ts"
import { ALG_TOOL_IDS, type GraphDef } from "../src/types.ts"
import { removeProject, tempProject } from "./helpers.ts"

const success = JSON.stringify({ summary: ["done"], files_touched: [], commands_run: [], risks: [], done: true })

function context(project: string, abort = new AbortController().signal) {
  return { sessionID: "owner", messageID: "msg_parent", agent: "orchestrator", directory: project, worktree: project,
    abort, ask: async () => {}, metadata: () => {} } as any
}

function planned(project: string, nodes: GraphDef["nodes"], runId: string) {
  const run = createRun({ goal: "worker launch", criteria: [], graph: { name: "launch", nodes, max_global_attempts: nodes.length, max_concurrency: 8 },
    projectDirectory: project, ownerSessionId: "owner", runId, mode: "live" })
  persistRun(run, project)
}

describe("worker launch", () => {
  test("a cancelled run aborts each running child session before the tool returns", async () => {
    const project = tempProject("alg-launch-cancel-")
    const controller = new AbortController()
    const events: string[] = []
    let created = 0, started = 0
    let bothStarted!: () => void
    const both = new Promise<void>((resolve) => { bothStarted = resolve })
    const client = {
      session: {
        create: async () => ({ data: { id: `child-${++created}` }, error: undefined }),
        // Like the real host, cancelling the request does not stop the session: only session.abort does.
        prompt: (request: any) => new Promise((resolve) => {
          if (++started === 2) bothStarted()
          request.signal?.addEventListener("abort", () => resolve({ data: undefined, error: { name: "AbortError", message: "request aborted" } }), { once: true })
        }),
        abort: async (request: any) => {
          events.push(`abort-start:${request.path.id}:${request.query.directory === project}`)
          await Bun.sleep(30)
          events.push(`abort-done:${request.path.id}`)
          return { data: true, error: undefined }
        },
      },
    }
    try {
      planned(project, [
        { id: "left", agent: "implementer", depends_on: [] },
        { id: "right", agent: "implementer", depends_on: [] },
      ], "cancel-children")
      const tools = createAlgTools({ client, project: { id: "project" }, directory: project, worktree: project } as never)
      const call = tools.alg_run.execute({ run_id: "cancel-children" }, context(project, controller.signal))
      await both
      controller.abort()
      await call
      events.push("tool-returned")
      expect(events.filter((event) => event.startsWith("abort-start")).sort()).toEqual(["abort-start:child-1:true", "abort-start:child-2:true"])
      expect(events.filter((event) => event.startsWith("abort-done")).sort()).toEqual(["abort-done:child-1", "abort-done:child-2"])
      expect(events.at(-1)).toBe("tool-returned")
    } finally { removeProject(project) }
  })

  test("a child that finishes normally is not aborted, and an unreachable host cannot hang cancellation", async () => {
    const aborts: string[] = []
    const finished = await runNodeSession({
      client: { session: {
        create: async () => ({ data: { id: "child-ok" }, error: undefined }),
        prompt: async () => ({ data: { parts: [{ type: "text", text: success }] }, error: undefined }),
        abort: async (request: any) => { aborts.push(request.path.id); return { data: true } },
      } } as never,
      parentSessionId: "owner", agent: "implementer", title: "run/node/a1", userPrompt: "work", directory: "/project",
    })
    expect(finished).toMatchObject({ session_id: "child-ok", parsed: { done: true } })
    expect(aborts).toEqual([])

    const controller = new AbortController()
    const started = Date.now()
    const cancelled = runNodeSession({
      client: { session: {
        create: async () => ({ data: { id: "child-stuck" }, error: undefined }),
        prompt: (request: any) => new Promise((resolve) => request.signal.addEventListener("abort", () => resolve({ data: undefined, error: { message: "aborted" } }))),
        abort: async () => { throw new Error("host unreachable") },
      } } as never,
      parentSessionId: "owner", agent: "implementer", title: "run/node/a1", userPrompt: "work", directory: "/project", abort: controller.signal,
    })
    await Bun.sleep(10)
    controller.abort()
    expect(await cancelled).toMatchObject({ session_id: "child-stuck", parsed: null })
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  test("workers are titled like native subagents and cannot see ALG's own tools", async () => {
    const project = tempProject("alg-launch-tools-")
    const creates: any[] = [], prompts: any[] = []
    const client = { session: {
      create: async (request: any) => { creates.push(request); return { data: { id: `child-${creates.length}` }, error: undefined } },
      prompt: async (request: any) => { prompts.push(request); return { data: { parts: [{ type: "text", text: success }] }, error: undefined } },
    } }
    try {
      planned(project, [{ id: "work", agent: "implementer", depends_on: [] }], "worker-tools")
      const tools = createAlgTools({ client, project: { id: "project" }, directory: project, worktree: project } as never)
      const result = await tools.alg_run.execute({ run_id: "worker-tools" }, context(project)) as { metadata: Record<string, unknown> }
      expect(result.metadata).toMatchObject({ status: "done" })
      // The "alg:" prefix keeps skill-evolution and memory exclusions working; the suffix is what OpenCode's footer reads.
      expect(creates[0].body).toEqual({ parentID: "owner", title: "alg:worker-tools/work/a1 (@implementer subagent)" })
      expect(prompts[0].body.tools).toEqual(Object.fromEntries(ALG_TOOL_IDS.map((id) => [id, false])))
      expect(Object.keys(prompts[0].body.tools)).toHaveLength(19)
    } finally { removeProject(project) }
  })

  test("session memory keeps its tools available to workers", async () => {
    const project = tempProject("alg-launch-memory-tools-")
    const prompts: any[] = []
    const client = { session: {
      create: async () => ({ data: { id: "child-1" }, error: undefined }),
      prompt: async (request: any) => { prompts.push(request); return { data: { parts: [{ type: "text", text: success }] }, error: undefined } },
    } }
    try {
      planned(project, [{ id: "work", agent: "implementer", depends_on: [] }], "memory-tools")
      // Only the enabled flag matters here; the adapter falls back to plain execution when no checkpoint exists.
      const sessionMemory = { enabled: true, options: { mode: "observe" }, store: { project }, current: () => { throw new Error("no checkpoint") } }
      const tools = createAlgTools({ client, project: { id: "project" }, directory: project, worktree: project } as never,
        undefined, undefined, { sessionMemory } as never)
      await tools.alg_run.execute({ run_id: "memory-tools" }, context(project))
      const hidden = Object.keys(prompts[0].body.tools)
      expect(hidden).toContain("alg_run")
      expect(hidden).toContain("alg_skill_evolution_promote")
      for (const id of ["alg_memory_search", "alg_memory_read", "alg_context_status", "alg_memory_propose"]) expect(hidden).not.toContain(id)
      expect(hidden).toHaveLength(15)
    } finally { removeProject(project) }
  })
})

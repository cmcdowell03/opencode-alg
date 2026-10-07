import { describe, expect, test } from "bun:test"
import { createAlgTools } from "../src/tools.ts"
import { executeRun } from "../src/executor.ts"
import { createRun, persistRun } from "../src/store.ts"
import { parseRunProgress } from "../src/run-progress.ts"
import type { GraphDef } from "../src/types.ts"
import { executeContext, inertClient, removeProject, tempProject } from "./helpers.ts"

const success = JSON.stringify({ summary: ["done"], files_touched: [], commands_run: [], risks: [], done: true })

function graph(nodes: GraphDef["nodes"], maxGlobalAttempts = nodes.length): GraphDef {
  return { name: "progress-test", nodes, max_global_attempts: maxGlobalAttempts, max_concurrency: 8 }
}

function context(project: string, metadata: (input: any) => unknown = () => {}) {
  return {
    sessionID: "owner",
    messageID: "message",
    agent: "orchestrator",
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    ask: async () => {},
    metadata,
  } as any
}

function toolsFor(project: string, client: unknown) {
  return createAlgTools({
    client,
    project: { id: "project" },
    directory: project,
    worktree: project,
  } as never)
}

function planned(project: string, definition: GraphDef, runId: string) {
  const run = createRun({
    goal: "integration progress",
    criteria: [],
    graph: definition,
    projectDirectory: project,
    ownerSessionId: "owner",
    runId,
    mode: "live",
  })
  persistRun(run, project)
  return run
}

function resultMetadata(result: unknown): Record<string, unknown> {
  return (result as { metadata: Record<string, unknown> }).metadata
}

describe("live progress tool integration", () => {
  test("publishes both parallel child IDs before either prompt completes and retains final metadata", async () => {
    const project = tempProject("alg-run-progress-parallel-")
    const snapshots: any[] = []
    let created = 0
    let promptsStarted = 0
    let bothPrompts!: () => void
    let releasePrompts!: () => void
    const bothStarted = new Promise<void>((resolve) => { bothPrompts = resolve })
    const release = new Promise<void>((resolve) => { releasePrompts = resolve })
    try {
      const client = {
        session: {
          create: async () => ({ data: { id: `child-${++created}` }, error: undefined, request: {}, response: {} }),
          prompt: async () => {
            promptsStarted++
            if (promptsStarted === 2) bothPrompts()
            await release
            return { data: { parts: [{ type: "text", text: success }] }, error: undefined, request: {}, response: {} }
          },
        },
      }
      planned(project, graph([
        { id: "left", agent: "implementer", depends_on: [] },
        { id: "right", agent: "implementer", depends_on: [] },
      ]), "parallel-progress")
      const tools = toolsFor(project, client)
      const call = tools.alg_run.execute({ run_id: "parallel-progress" }, context(project, (input) => {
        if (input.metadata?.alg_progress) snapshots.push(input.metadata.alg_progress)
      }))
      await bothStarted

      const live = snapshots.find((snapshot) => snapshot.counts.running === 2 &&
        snapshot.nodes.filter((node: any) => node.status === "running" && node.session_id).length === 2)
      expect(live).toBeDefined()
      expect(live.nodes.map((node: any) => node.session_id).sort()).toEqual(["child-1", "child-2"])
      releasePrompts()

      const result = await call
      const finalProgress = resultMetadata(result).alg_progress as any
      expect(finalProgress).toMatchObject({ status: "done", counts: { done: 2, running: 0 } })
      expect(parseRunProgress(finalProgress, "owner")).toEqual(finalProgress)
      expect((result as { output: string }).output).not.toContain("alg_progress")
    } finally {
      releasePrompts()
      removeProject(project)
    }
  })

  test("records retry count, resumes the next wave, and describes dry progress", async () => {
    const project = tempProject("alg-run-progress-modes-")
    try {
      let promptCount = 0
      const client = {
        session: {
          create: async () => ({ data: { id: `attempt-${promptCount + 1}` }, error: undefined, request: {}, response: {} }),
          prompt: async () => {
            promptCount++
            const text = promptCount === 1 ? "not-json" : success
            return { data: { parts: [{ type: "text", text }] }, error: undefined, request: {}, response: {} }
          },
        },
      }
      const retryRun = planned(project, graph([{
        id: "retry",
        agent: "implementer",
        depends_on: [],
        loop: { max_attempts: 2, gate: "schema" },
      }], 2), "retry-progress")
      const snapshots: any[] = []
      const tools = toolsFor(project, client)
      const first = await tools.alg_run.execute({ run_id: retryRun.run_id }, context(project, (input) => {
        if (input.metadata?.alg_progress) snapshots.push(input.metadata.alg_progress)
      }))
      expect(resultMetadata(first).alg_progress).toMatchObject({
        status: "done",
        nodes: [{ id: "retry", status: "done", attempt: 2, retries: 1 }],
      })
      expect(snapshots.some((snapshot) => snapshot.nodes.some((node: any) => node.attempt === 2 && node.retries === 1)))
        .toBe(true)

      const resumeRun = planned(project, graph([
        { id: "first", agent: "implementer", depends_on: [] },
        { id: "second", agent: "implementer", depends_on: ["first"] },
      ]), "resume-progress")
      const limited = await tools.alg_run.execute({ run_id: resumeRun.run_id, max_waves: 1 }, context(project))
      expect(resultMetadata(limited).alg_progress).toMatchObject({ status: "blocked", counts: { done: 1, ready: 1 } })
      const resumed = await tools.alg_resume.execute({ run_id: resumeRun.run_id }, context(project))
      expect(resultMetadata(resumed).alg_progress).toMatchObject({ status: "done", counts: { done: 2 } })

      const dryRun = planned(project, graph([{ id: "dry", agent: "implementer", depends_on: [] }]), "dry-progress")
      const dryResult = await toolsFor(project, inertClient()).alg_run.execute(
        { run_id: dryRun.run_id, dry: true }, context(project),
      )
      expect(resultMetadata(dryResult).alg_progress).toMatchObject({ mode: "dry", status: "done", counts: { done: 1 } })
    } finally {
      removeProject(project)
    }
  })

  test("sync throws and asynchronous metadata rejection do not change the verdict", async () => {
    const project = tempProject("alg-run-progress-observer-")
    try {
      const run = planned(project, graph([{ id: "dry", agent: "implementer", depends_on: [] }]), "observer-progress")
      let calls = 0
      const observerContext = context(project, () => {
        calls++
        if (calls === 1) throw new Error("observer sync failure")
        return Promise.reject(new Error("observer async failure"))
      })
      const result = await toolsFor(project, inertClient()).alg_run.execute(
        { run_id: run.run_id, dry: true }, observerContext,
      )
      expect(resultMetadata(result).alg_progress).toMatchObject({ status: "done", mode: "dry" })
      expect(JSON.parse((result as { output: string }).output).status).toBe("done")
    } finally {
      removeProject(project)
    }
  })

  test("does not notify progress when child-session persistence fails", async () => {
    const project = tempProject("alg-run-progress-persist-failure-")
    try {
      const run = planned(project, graph([{ id: "work", agent: "implementer", depends_on: [] }]), "persist-failure")
      const progress: any[] = []
      let rejected = false
      try {
        await executeRun(run, {
          ...executeContext(project),
          parentSessionId: "owner",
          sessionRunner: async (options) => {
            await options.onSessionCreated?.("child-persist-failure")
            return { session_id: "child-persist-failure", parsed: JSON.parse(success), text: success }
          },
          afterSessionSidecar: () => { throw new Error("injected persistence boundary failure") },
          onProgress: (savedRun) => progress.push(savedRun.revision),
        })
      } catch {
        rejected = true
      }
      expect(rejected).toBe(true)
      // Initial running state and reserved attempt were durable; the failed child-id save emitted nothing.
      expect(progress).toHaveLength(2)
    } finally {
      removeProject(project)
    }
  })
})

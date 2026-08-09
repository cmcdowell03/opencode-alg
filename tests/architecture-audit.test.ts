import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getTemplate } from "../src/templates.ts"
import { validateGraph } from "../src/graph.ts"
import {
  ExploreOut,
  ImplementOut,
  parseAndValidate,
} from "../src/schemas.ts"
import {
  MAX_CHECKER_PROMPT_BYTES,
  MAX_WORKER_PROMPT_BYTES,
  utf8Bytes,
} from "../src/limits.ts"
import {
  buildCheckerPrompt,
  buildWorkerPrompt,
  runNodeSession,
} from "../src/sessions.ts"
import { createRun, listRuns, loadRun, persistRun, runDir, writeJson } from "../src/store.ts"
import { executeRun } from "../src/executor.ts"
import { createAlgTools, withShellGate } from "../src/tools.ts"
import {
  configuredAgentModels,
  saveModelSettings,
} from "../src/models.ts"
import {
  formatCompactionContext,
  MAX_COMPACTION_CONTEXT_BYTES,
  selectCompactionRun,
} from "../src/compaction.ts"
import serverModule from "../src/server.ts"
import { executeContext, inertClient, removeProject, tempProject } from "./helpers.ts"

function toolContext(project: string, sessionID = "owner") {
  return {
    sessionID,
    messageID: "message",
    agent: "orchestrator",
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    ask: async () => {},
    metadata: () => {},
  } as any
}

function toolOutput(result: unknown): any {
  return JSON.parse((result as { output: string }).output)
}

function snapshotDirectory(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {}
  const visit = (directory: string, prefix = "") => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const relative = prefix ? `${prefix}/${name}` : name
      if (statSync(path).isDirectory()) visit(path, relative)
      else snapshot[relative] = readFileSync(path).toString("base64")
    }
  }
  visit(root)
  return snapshot
}

describe("architecture audit remediation", () => {
  test("aggregate output and worker/checker prompt payloads have byte caps", async () => {
    const oversizedExplore = {
      query: "q",
      map: Array.from({ length: 100 }, (_, index) => ({
        path: `${index}-${"p".repeat(1_795)}`,
        role: "r".repeat(1_800),
      })),
      key_hits: [],
      next: "none",
    }
    expect(ExploreOut.safeParse(oversizedExplore).success).toBe(false)
    expect(parseAndValidate("explorer", oversizedExplore)).toMatchObject({ ok: false })

    expect(() => buildWorkerPrompt({
      goal: "aggregate dependencies",
      criteria: [],
      agent: "implementer",
      inputs: {
        first: "a".repeat(200 * 1024),
        second: "b".repeat(200 * 1024),
      },
      priorFailures: [],
    })).toThrow(/worker prompt exceeds/)
    expect(() => buildCheckerPrompt({
      criteria: ["bounded"],
      claimed: { first: "a".repeat(200 * 1024), second: "b".repeat(200 * 1024) },
    })).toThrow(/checker prompt exceeds/)

    let creates = 0
    const client = {
      session: {
        create: async () => {
          creates++
          return { data: { id: "unexpected" }, error: undefined }
        },
      },
    } as never
    const result = await runNodeSession({
      client,
      parentSessionId: "parent",
      agent: "explorer",
      title: "oversize",
      userPrompt: "x".repeat(MAX_WORKER_PROMPT_BYTES + 1),
      directory: tempProject(),
    })
    expect(result.error).toContain("prompt exceeds")
    expect(creates).toBe(0)
    expect(MAX_CHECKER_PROMPT_BYTES).toBeLessThan(5 * 1024 * 1024)
  })

  test("structured incomplete implementer output validates but never completes a node", async () => {
    const incomplete = {
      summary: ["partial implementation"],
      files_touched: ["src/file.ts"],
      commands_run: [],
      risks: [],
      done: false,
      blockers: ["dependency unavailable"],
      artifact_path: ".opencode/runs/run/artifacts/implement.json",
    }
    expect(ImplementOut.safeParse(incomplete).success).toBe(true)
    expect(ImplementOut.safeParse({ ...incomplete, blockers: undefined }).success).toBe(false)

    const project = tempProject()
    try {
      const run = createRun({
        goal: "incomplete",
        criteria: ["complete"],
        graph: {
          name: "incomplete-implementer",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "worker-any-name", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      const contextualIncomplete = {
        ...incomplete,
        artifact_path: `.opencode/runs/${run.run_id}/artifacts/implementation.md`,
      }
      const updated = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async () => ({ session_id: "mock", text: "", parsed: contextualIncomplete }),
      })
      expect(updated.status).toBe("failed")
      expect(updated.nodes["worker-any-name"]!.status).toBe("failed")
      expect(updated.nodes["worker-any-name"]!.attempts[0]!.schema_ok).toBe(true)
      expect(updated.nodes["worker-any-name"]!.last_failures).toContain(
        "implementer incomplete: dependency unavailable",
      )
    } finally {
      removeProject(project)
    }
  })

  test("executor rejects a safe artifact path belonging to another run", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "cross-run artifact",
        criteria: [],
        graph: {
          name: "cross-run-artifact",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      const updated = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async () => ({
          session_id: "child",
          text: "",
          parsed: {
            summary: ["done"],
            files_touched: [],
            commands_run: [],
            risks: [],
            done: true,
            artifact_path: ".opencode/runs/other-run/artifacts/implementation.md",
          },
        }),
      })
      expect(updated.status).toBe("failed")
      expect(updated.nodes.work!.output).toBeUndefined()
      expect(updated.nodes.work!.last_failures).toContain(`schema: artifact_path must belong to run ${run.run_id}`)
    } finally {
      removeProject(project)
    }
  })

  test("session sidecar is atomically bound before progress child-id persistence", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "child id crash fence",
        criteria: [],
        graph: {
          name: "child-id-crash",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      let observedGap = false
      await executeRun(run, {
        ...executeContext(project),
        client: {
          session: {
            create: async () => ({ data: { id: "created-before-crash" }, error: undefined }),
            prompt: async () => { throw new Error("prompt must not run after injected persistence crash") },
          },
        } as never,
        afterSessionSidecar() {
          const sidecar = JSON.parse(readFileSync(
            join(runDir(project, run.run_id), "sessions", "work-a1.json"),
            "utf8",
          ))
          expect(sidecar).toMatchObject({
            schema_version: 1,
            run_id: run.run_id,
            owner_session_id: "session-owner",
            project_directory: project,
            node_id: "work",
            attempt: 1,
            session_id: "created-before-crash",
          })
          const progress = JSON.parse(readFileSync(join(runDir(project, run.run_id), "progress.json"), "utf8"))
          expect(progress.nodes.work.attempts[0].session_id).toBeUndefined()
          observedGap = true
          throw new Error("injected crash between sidecar and progress")
        },
      })
      expect(observedGap).toBe(true)
    } finally {
      removeProject(project)
    }
  })

  test("checker feedback targets only arbitrary direct dependencies", () => {
    const direct = {
      name: "direct-feedback",
      max_global_attempts: 3,
      max_concurrency: 1,
      nodes: [
        { id: "root-any-name", agent: "explorer", depends_on: [] },
        {
          id: "middle-any-name",
          agent: "researcher",
          depends_on: ["root-any-name"],
          inputs: { source: "root-any-name" },
        },
        {
          id: "audit-any-name",
          agent: "checker",
          depends_on: ["middle-any-name"],
          feedback_to: "middle-any-name",
        },
      ],
    }
    expect(() => validateGraph(direct)).not.toThrow()
    const ancestor = structuredClone(direct)
    ancestor.nodes[2]!.feedback_to = "root-any-name"
    expect(() => validateGraph(ancestor)).toThrow(/direct dependency/)
  })

  test("tight global retry allocation is graph-ordered regardless failure completion speed", async () => {
    const allocations: number[][] = []
    for (const delays of [{ first: 80, second: 5 }, { first: 5, second: 80 }]) {
      const project = tempProject()
      try {
        const run = createRun({
          goal: "deterministic retries",
          criteria: [],
          graph: {
            name: "ordered-retries",
            max_global_attempts: 3,
            max_concurrency: 2,
            nodes: [
              { id: "first", agent: "implementer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } },
              { id: "second", agent: "implementer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } },
            ],
          },
          projectDirectory: project,
          ownerSessionId: "session-owner",
        })
        const updated = await executeRun(run, {
          ...executeContext(project),
          sessionRunner: async (options) => {
            const node = options.title.includes("/first/") ? "first" : "second"
            await Bun.sleep(delays[node])
            return { session_id: `${node}-child`, text: "", parsed: null, error: `${node} failed` }
          },
        })
        allocations.push([updated.nodes.first!.current_attempt, updated.nodes.second!.current_attempt])
      } finally {
        removeProject(project)
      }
    }
    expect(allocations).toEqual([[2, 1], [2, 1]])
  }, 15_000)

  test("compaction selects exact-owner active state and formats deterministic bounded text", () => {
    const project = tempProject()
    try {
      const active = createRun({
        goal: `active-${"g".repeat(10_000)}`,
        criteria: Array.from({ length: 100 }, (_, i) => `${i}-${"c".repeat(1_000)}`),
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      active.status = "blocked"
      active.updated_at = "2026-08-08T01:00:00.000Z"
      active.nodes.research!.last_failures = Array.from(
        { length: 20 },
        (_, i) => `${i}-${"f".repeat(1_000)}`,
      )
      const completed = structuredClone(active)
      completed.run_id = "completed-newer"
      completed.status = "done"
      completed.updated_at = "2026-08-08T03:00:00.000Z"
      const otherOwner = structuredClone(active)
      otherOwner.run_id = "other-owner"
      otherOwner.owner_session_id = "other"
      otherOwner.updated_at = "2026-08-08T04:00:00.000Z"

      expect(selectCompactionRun([completed, otherOwner, active], "owner")?.run_id).toBe(active.run_id)
      const first = formatCompactionContext(active)
      const second = formatCompactionContext(active)
      expect(first).toBe(second)
      expect(utf8Bytes(first)).toBeLessThanOrEqual(MAX_COMPACTION_CONTEXT_BYTES)
      expect(first).toContain("does not explicitly forward worker transcripts")
      expect(first).not.toContain("f".repeat(500))
      expect(selectCompactionRun([completed], "owner")).toBeNull()
    } finally {
      removeProject(project)
    }
  })

  test("listing, explicit access, and compaction never mutate another owner's runs", async () => {
    const project = tempProject()
    try {
      const alice = createRun({
        goal: "alice valid run",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "alice",
      })
      const aliceCorrupt = createRun({
        goal: "alice corrupt run",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "alice",
      })
      const bob = createRun({
        goal: "bob active run",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "bob",
      })

      const aliceDirectory = runDir(project, alice.run_id)
      writeFileSync(join(aliceDirectory, "graph.json"), "ALICE-MISMATCHED-MIRROR", "utf8")
      writeFileSync(join(aliceDirectory, "artifacts", "stale.json"), "ALICE-STALE-ARTIFACT", "utf8")
      const corruptDirectory = runDir(project, aliceCorrupt.run_id)
      writeFileSync(join(corruptDirectory, "progress.json"), "{ALICE-CORRUPT", "utf8")
      const beforeAlice = snapshotDirectory(aliceDirectory)
      const beforeCorrupt = snapshotDirectory(corruptDirectory)

      const hooks = await serverModule.server({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)
      const list = await hooks.tool!.alg_status!.execute({ list: true }, toolContext(project, "bob"))
      expect(toolOutput(list)).toEqual([{
        run_id: bob.run_id,
        status: "planning",
        goal: "bob active run",
        updated_at: bob.updated_at,
      }])
      const denied = await hooks.tool!.alg_status!.execute(
        { run_id: alice.run_id },
        toolContext(project, "bob"),
      )
      expect((denied as { metadata: { error?: boolean } }).metadata.error).toBe(true)
      const corruptDenied = await hooks.tool!.alg_status!.execute(
        { run_id: aliceCorrupt.run_id },
        toolContext(project, "bob"),
      )
      expect((corruptDenied as { metadata: { error?: boolean } }).metadata.error).toBe(true)

      const output = { context: [] as string[] }
      await hooks["experimental.session.compacting"]!({ sessionID: "bob" } as never, output as never)
      expect(output.context).toHaveLength(1)
      expect(output.context[0]).toContain(bob.run_id)
      expect(snapshotDirectory(aliceDirectory)).toEqual(beforeAlice)
      expect(snapshotDirectory(corruptDirectory)).toEqual(beforeCorrupt)
    } finally {
      removeProject(project)
    }
  })

  test("merged config role models are snapped once and project overrides win", async () => {
    const project = tempProject()
    try {
      saveModelSettings(project, {
        checker: { providerID: "project", modelID: "checker-model" },
      })
      expect(configuredAgentModels({
        model: "global/base/model",
        agent: { explorer: { model: "role/explorer/model" } },
      })).toMatchObject({
        explorer: { providerID: "role", modelID: "explorer/model" },
        researcher: { providerID: "global", modelID: "base/model" },
      })

      const plugin = {
        client: { app: { log: async () => ({ data: true, error: undefined }) } },
        project: { id: "project-id" },
        directory: project,
        worktree: project,
      } as never
      const hooks = await serverModule.server(plugin)
      await hooks.config!({
        model: "global/base-model",
        agent: { explorer: { model: "role/explorer-model" } },
      } as never)
      const planned = await hooks.tool!.alg_plan!.execute({
        goal: "snapshot",
        criteria: [],
        mode: "dry",
      }, toolContext(project))
      const runId = toolOutput(planned).run_id
      const initial = loadRun(project, runId)!
      expect(initial.model_snapshot).toMatchObject({
        explorer: { providerID: "role", modelID: "explorer-model" },
        researcher: { providerID: "global", modelID: "base-model" },
        implementer: { providerID: "global", modelID: "base-model" },
        checker: { providerID: "project", modelID: "checker-model" },
      })
      await hooks.config!({ model: "later/changed" } as never)
      expect(loadRun(project, runId)!.model_snapshot).toEqual(initial.model_snapshot)
      expect(configuredAgentModels({})).toEqual({})
    } finally {
      removeProject(project)
    }
  })

  test("transfer tool validates target session fields before ownership mutation", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "transfer target",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      let response: any = { data: undefined, error: { message: "not found" } }
      let request: any
      let targetGets = 0
      const plugin = {
        client: {
          session: {
            get: async (options: any) => {
              targetGets += 1
              request = options
              return response
            },
          },
        },
        project: { id: "project-id" },
        directory: project,
        worktree: project,
      } as never
      const tools = createAlgTools(plugin)
      const nonOwner = await tools.alg_transfer.execute({
        run_id: run.run_id,
        new_owner_session_id: "target",
      }, toolContext(project, "intruder"))
      expect(toolOutput(nonOwner).error).toContain("does not own")
      expect(targetGets).toBe(0)
      expect(request).toBeUndefined()

      const denied = await tools.alg_transfer.execute({
        run_id: run.run_id,
        new_owner_session_id: "target",
      }, toolContext(project))
      expect(toolOutput(denied).error).toContain("target session lookup failed")
      expect(targetGets).toBe(1)
      expect(loadRun(project, run.run_id)!.owner_session_id).toBe("owner")

      response = {
        data: {
          id: "target",
          projectID: "different-project",
          directory: project,
        },
        error: undefined,
      }
      const wrongProject = await tools.alg_transfer.execute({
        run_id: run.run_id,
        new_owner_session_id: "target",
      }, toolContext(project))
      expect(toolOutput(wrongProject).error).toContain("different project")

      response.data.projectID = "project-id"
      const transferred = await tools.alg_transfer.execute({
        run_id: run.run_id,
        new_owner_session_id: "target",
      }, toolContext(project))
      expect(toolOutput(transferred).owner_session_id).toBe("target")
      expect(request).toMatchObject({
        path: { id: "target" },
        query: { directory: project },
        responseStyle: "fields",
        throwOnError: false,
      })
    } finally {
      removeProject(project)
    }
  })

  test("shell command timeout overrides preserve cwd across helper, run, and resume", async () => {
    const project = tempProject()
    mkdirSync(join(project, "sub"))
    try {
      const graph = getTemplate("coding-diamond")
      const implementer = graph.nodes.find((node) => node.agent === "implementer")!
      implementer.shell_gate = { cmd: "old", cwd: "sub", timeout_ms: 1_000 }
      implementer.loop = { max_attempts: 5, gate: "all" }
      const overridden = withShellGate(graph, "new", 2_000)
      expect(overridden.nodes.find((node) => node.agent === "implementer")!.shell_gate).toEqual({
        cmd: "new",
        cwd: "sub",
        timeout_ms: 2_000,
      })

      const plugin = {
        client: inertClient(),
        project: { id: "project-id" },
        directory: project,
        worktree: project,
      } as never
      const tools = createAlgTools(plugin)
      const plannedResult = await tools.alg_plan.execute({
        goal: "shell overrides",
        graph_json: JSON.stringify(graph),
        mode: "dry",
      }, toolContext(project))
      const runId = toolOutput(plannedResult).run_id
      await tools.alg_run.execute({
        run_id: runId,
        dry: true,
        shell_gate: "run-command",
        shell_timeout_ms: 3_000,
      }, toolContext(project))
      expect(loadRun(project, runId)!.graph.nodes.find((node) => node.agent === "implementer")!.shell_gate).toEqual({
        cmd: "run-command",
        cwd: "sub",
        timeout_ms: 3_000,
      })
      await tools.alg_resume.execute({
        run_id: runId,
        dry: true,
        shell_gate: "resume-command",
        shell_timeout_ms: 4_000,
      }, toolContext(project))
      expect(loadRun(project, runId)!.graph.nodes.find((node) => node.agent === "implementer")!.shell_gate).toEqual({
        cmd: "resume-command",
        cwd: "sub",
        timeout_ms: 4_000,
      })
    } finally {
      removeProject(project)
    }
  }, 15_000)

  test("criteria requires a planned run and lock=false replaces while leaving unlocked", async () => {
    const project = tempProject()
    try {
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project-id" },
        directory: project,
        worktree: project,
      } as never)
      const missing = await tools.alg_criteria.execute({ criteria: ["orphan"] }, toolContext(project))
      expect(toolOutput(missing).error).toContain("Call alg_plan first")
      expect(listRuns(project, "owner")).toHaveLength(0)

      const planned = await tools.alg_plan.execute({
        goal: "criteria",
        criteria: ["original"],
        mode: "dry",
      }, toolContext(project))
      const runId = toolOutput(planned).run_id
      const locked = await tools.alg_criteria.execute({
        run_id: runId,
        criteria: ["replacement"],
      }, toolContext(project))
      expect(toolOutput(locked).error).toContain("locked")
      await tools.alg_criteria.execute({
        run_id: runId,
        criteria: ["replacement"],
        lock: false,
      }, toolContext(project))
      expect(loadRun(project, runId)).toMatchObject({
        criteria: ["replacement"],
        criteria_locked: false,
      })
      await tools.alg_criteria.execute({
        run_id: runId,
        criteria: ["final"],
      }, toolContext(project))
      expect(loadRun(project, runId)).toMatchObject({ criteria: ["final"], criteria_locked: true })
    } finally {
      removeProject(project)
    }
  })

  test("persistence deletes stale derived artifacts when node output is absent", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "artifact cleanup",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const stale = join(runDir(project, run.run_id), "artifacts", "explore_a.json")
      writeJson(stale, { stale: true })
      expect(existsSync(stale)).toBe(true)
      persistRun(run, project)
      expect(existsSync(stale)).toBe(false)
    } finally {
      removeProject(project)
    }
  })
})

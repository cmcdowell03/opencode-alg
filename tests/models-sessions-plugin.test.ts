import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { createAlgTools } from "../src/tools.ts"
import serverModule from "../src/server.ts"
import directPlugin from "../src/index.ts"
import {
  acquireModelSettingsLock,
  configuredAgentModels,
  loadModelSettings,
  modelSettingsLockPath,
  modelSettingsPath,
  saveModelSettings,
  setAgentModelVariant,
  snapshotModels,
} from "../src/models.ts"
import { extractJson, runNodeSession } from "../src/sessions.ts"
import { createRun, loadRun, persistRun, runContainedPath } from "../src/store.ts"
import { executeRun } from "../src/executor.ts"
import { ModelRefSchema, ProjectModelSettingsSchema } from "../src/schemas.ts"
import { executeContext, inertClient, removeProject, tempProject } from "./helpers.ts"

function toolContext(project: string) {
  return {
    sessionID: "owner",
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

describe("models, SDK propagation, and registration", () => {
  test("JSON extraction accepts only a whole object or one anchored fence", () => {
    expect(extractJson(' {"ok":true} ')).toEqual({ ok: true })
    expect(extractJson(' \n```json\n{"ok":true}\n```\n ')).toEqual({ ok: true })
    expect(extractJson('```\n{"ok":true}\n```')).toEqual({ ok: true })
    expect(extractJson('Here you go: {"ok":true}')).toBeNull()
    expect(extractJson('Here you go:\n```json\n{"ok":true}\n```')).toBeNull()
    expect(extractJson('```json\n{"one":1}\n```\n```json\n{"two":2}\n```')).toBeNull()
    expect(extractJson('[{"not":"an object response"}]')).toBeNull()
  })

  test("strict project model settings persist and snapshot independently", () => {
    const project = tempProject()
    try {
      const saved = saveModelSettings(project, {
        explorer: { providerID: "provider-a", modelID: "model-a" },
        checker: { providerID: "provider-b", modelID: "model-b" },
      })
      expect(saved.revision).toBe(1)
      const snapshot = snapshotModels(project)
      expect(() => {
        snapshot.explorer!.modelID = "mutated"
      }).toThrow()
      expect(loadModelSettings(project).models.explorer?.modelID).toBe("model-a")
      expect(() => saveModelSettings(project, { shell: { providerID: "x", modelID: "y" } } as any)).toThrow()
    } finally {
      removeProject(project)
    }
  })

  test("model-only settings stay valid while variants are trimmed, bounded, and strict", () => {
    const legacy = {
      schema_version: 1 as const,
      revision: 4,
      models: { explorer: { providerID: "provider", modelID: "model" } },
      updated_at: "2026-08-09T00:00:00.000Z",
    }
    expect(ProjectModelSettingsSchema.parse(legacy)).toEqual(legacy)
    expect(ModelRefSchema.parse({ providerID: "p", modelID: "m", variant: "  exact-key  " }))
      .toEqual({ providerID: "p", modelID: "m", variant: "exact-key" })
    for (const variant of ["", "   ", "x".repeat(129), 7, null]) {
      expect(ModelRefSchema.safeParse({ providerID: "p", modelID: "m", variant }).success).toBe(false)
    }
    expect(ModelRefSchema.safeParse({ providerID: "p", modelID: "m", variant: "high", extra: true }).success)
      .toBe(false)
  })

  test("alg_models supports full set, variant-only update, clear_variant, clear, CAS, and rejects incompatible args", async () => {
    const project = tempProject()
    try {
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)
      const context = toolContext(project)

      const setDefault = toolOutput(await tools.alg_models.execute({
        agent: "explorer",
        provider_id: "provider",
        model_id: "model",
      }, context))
      expect(setDefault.models.explorer).toEqual({ providerID: "provider", modelID: "model" })

      const setFull = toolOutput(await tools.alg_models.execute({
        agent: "explorer",
        provider_id: "provider-2",
        model_id: "model-2",
        variant: "  exact-effort  ",
        revision: setDefault.revision,
      }, context))
      expect(setFull.models.explorer).toEqual({
        providerID: "provider-2",
        modelID: "model-2",
        variant: "exact-effort",
      })

      const variantOnly = toolOutput(await tools.alg_models.execute({
        agent: "explorer",
        variant: "other-effort",
        revision: setFull.revision,
      }, context))
      expect(variantOnly.models.explorer).toEqual({
        providerID: "provider-2",
        modelID: "model-2",
        variant: "other-effort",
      })

      const stale = toolOutput(await tools.alg_models.execute({
        agent: "explorer",
        variant: "stale",
        revision: setFull.revision,
      }, context))
      expect(stale.error).toContain("changed concurrently")

      const clearedVariant = toolOutput(await tools.alg_models.execute({
        agent: "explorer",
        clear_variant: true,
        revision: variantOnly.revision,
      }, context))
      expect(clearedVariant.models.explorer).toEqual({ providerID: "provider-2", modelID: "model-2" })

      const resetWithoutVariant = toolOutput(await tools.alg_models.execute({
        agent: "explorer",
        provider_id: "provider-3",
        model_id: "model-3",
        revision: clearedVariant.revision,
      }, context))
      expect(resetWithoutVariant.models.explorer.variant).toBeUndefined()

      const cleared = toolOutput(await tools.alg_models.execute({
        agent: "explorer",
        clear: true,
        revision: resetWithoutVariant.revision,
      }, context))
      expect(cleared.models.explorer).toBeUndefined()
      expect(toolOutput(await tools.alg_models.execute({ agent: "explorer", variant: "x" }, context)).error)
        .toContain("no project model selection")
      expect(() => setAgentModelVariant(project, "explorer", "x")).toThrow(/no project model selection/)

      const incompatible = [
        { variant: "x" },
        { agent: "explorer" },
        { agent: "explorer", provider_id: "p" },
        { agent: "explorer", model_id: "m" },
        { agent: "explorer", clear: true, variant: "x" },
        { agent: "explorer", clear: true, clear_variant: true },
        { agent: "explorer", clear_variant: true, provider_id: "p", model_id: "m" },
        { agent: "explorer", provider_id: "p", variant: "x" },
      ]
      for (const args of incompatible) {
        expect(typeof toolOutput(await tools.alg_models.execute(args as never, context)).error).toBe("string")
      }
      expect(typeof toolOutput(await tools.alg_models.execute({
        agent: "explorer",
        provider_id: "p",
        model_id: "m",
        variant: " ",
      }, context)).error).toBe("string")
    } finally {
      removeProject(project)
    }
  })

  test("session prompt splits exact structured model and top-level variant", async () => {
    const project = tempProject()
    let promptOptions: any
    try {
      const client = {
        session: {
          create: async (options: any) => {
            expect(options.responseStyle).toBe("fields")
            return { data: { id: "child-session" }, error: undefined, request: {}, response: {} }
          },
          prompt: async (options: any) => {
            promptOptions = options
            return {
              data: { parts: [{ type: "text", text: '{"passed":true,"failures":[],"score":10}' }] },
              error: undefined,
              request: {},
              response: {},
            }
          },
        },
      } as never
      const model = { providerID: "provider-id", modelID: "model-id", variant: "catalog-effort" }
      const result = await runNodeSession({
        client,
        parentSessionId: "parent",
        agent: "checker",
        title: "test",
        userPrompt: "check",
        directory: project,
        model,
      })
      expect(result.session_id).toBe("child-session")
      expect(result.parsed).toEqual({ passed: true, failures: [], score: 10 })
      expect(promptOptions.body.model).toEqual({ providerID: "provider-id", modelID: "model-id" })
      expect(promptOptions.body.variant).toBe("catalog-effort")
      expect(Object.keys(promptOptions.body).sort()).toEqual(["agent", "model", "parts", "variant"])
      expect(promptOptions.responseStyle).toBe("fields")
    } finally {
      removeProject(project)
    }
  })

  test("session prompt omits both model and variant when unset and only variant when model has none", async () => {
    const bodies: Array<Record<string, unknown>> = []
    const client = {
      session: {
        create: async () => ({ data: { id: `child-${bodies.length}` }, error: undefined }),
        prompt: async (options: { body: Record<string, unknown> }) => {
          bodies.push(options.body)
          return { data: { parts: [] }, error: undefined }
        },
      },
    } as never
    const base = {
      client,
      parentSessionId: "parent",
      agent: "explorer" as const,
      title: "test",
      userPrompt: "map",
      directory: tempProject(),
    }
    await runNodeSession(base)
    await runNodeSession({ ...base, model: { providerID: "p", modelID: "m" } })
    expect(Object.hasOwn(bodies[0]!, "model")).toBe(false)
    expect(Object.hasOwn(bodies[0]!, "variant")).toBe(false)
    expect(bodies[1]!.model).toEqual({ providerID: "p", modelID: "m" })
    expect(Object.hasOwn(bodies[1]!, "variant")).toBe(false)
  })

  test("executor propagates each snapshotted role variant through retries", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "variant propagation",
        criteria: ["valid"],
        graph: {
          name: "variant-roles",
          max_global_attempts: 5,
          max_concurrency: 4,
          nodes: [
            { id: "explore", agent: "explorer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } },
            { id: "research", agent: "researcher", depends_on: [] },
            { id: "implement", agent: "implementer", depends_on: [] },
            { id: "check", agent: "checker", depends_on: [] },
          ],
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
        modelSnapshot: {
          explorer: { providerID: "p", modelID: "explore", variant: "explore-effort" },
          researcher: { providerID: "p", modelID: "research", variant: "research-effort" },
          implementer: { providerID: "p", modelID: "implement", variant: "implement-effort" },
          checker: { providerID: "p", modelID: "check", variant: "check-effort" },
        },
      })
      const seen: Record<string, string[]> = {}
      let explorerAttempts = 0
      const completed = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          ;(seen[options.agent] ??= []).push(options.model?.variant ?? "missing")
          if (options.agent === "explorer" && explorerAttempts++ === 0) {
            return { session_id: "explore-1", text: "", parsed: null, error: "retry" }
          }
          const parsed = options.agent === "explorer"
            ? { query: "q", map: [{ path: "x", role: "r" }], key_hits: [], next: "none" }
            : options.agent === "researcher"
              ? { answer: "a", evidence: [], constraints: [], options: [], acceptance_criteria: ["valid"], risks: [] }
              : options.agent === "implementer"
                ? { summary: ["done"], files_touched: [], commands_run: [], risks: [], done: true }
                : { passed: true, failures: [], score: 10 }
          return { session_id: `${options.agent}-ok`, text: "", parsed }
        },
      })
      expect(completed.status).toBe("done")
      expect(seen).toEqual({
        explorer: ["explore-effort", "explore-effort"],
        researcher: ["research-effort"],
        implementer: ["implement-effort"],
        checker: ["check-effort"],
      })
    } finally {
      removeProject(project)
    }
  })

  test("configured role variants require an explicit valid role model and project selections replace them", () => {
    expect(configuredAgentModels({
      model: "fallback/base",
      agent: {
        explorer: { model: "role/explorer", variant: " role-effort " },
        researcher: { variant: "must-not-follow-fallback" },
        implementer: { model: "invalid", variant: "ignored" },
      },
    })).toEqual({
      explorer: { providerID: "role", modelID: "explorer", variant: "role-effort" },
      researcher: { providerID: "fallback", modelID: "base" },
      implementer: { providerID: "fallback", modelID: "base" },
      checker: { providerID: "fallback", modelID: "base" },
    })
  })

  test("SDK field errors are returned instead of being mistaken for data", async () => {
    const client = {
      session: {
        create: async () => ({ data: undefined, error: { message: "bad request" }, request: {}, response: {} }),
      },
    } as never
    const result = await runNodeSession({
      client,
      parentSessionId: "parent",
      agent: "explorer",
      title: "test",
      userPrompt: "map",
      directory: tempProject(),
    })
    expect(result.error).toContain("session.create failed")
  })

  test("dedicated server default is PluginModule and registers every tool", async () => {
    const project = tempProject()
    try {
      expect(serverModule.id).toBe("opencode-alg")
      expect(typeof serverModule.server).toBe("function")
      expect(typeof directPlugin).toBe("function")
      const context = {
        client: { app: { log: async () => ({ data: true, error: undefined }) } },
        directory: project,
        worktree: project,
      } as never
      const hooks = await serverModule.server(context)
      const names = Object.keys(hooks.tool ?? {}).sort()
      expect(names).toEqual([
        "alg_artifact",
        "alg_criteria",
        "alg_models",
        "alg_plan",
        "alg_resume",
        "alg_run",
        "alg_status",
        "alg_templates",
        "alg_transfer",
      ])
      expect(Object.keys(createAlgTools(context))).toEqual(expect.arrayContaining(names))
    } finally {
      removeProject(project)
    }
  })

  test("project model settings serialize writers and fail closed on stale/malformed locks", () => {
    const project = tempProject()
    try {
      const initial = saveModelSettings(project, {
        explorer: { providerID: "p", modelID: "one" },
      })
      const held = acquireModelSettingsLock(project)
      expect(() => saveModelSettings(project, {
        explorer: { providerID: "p", modelID: "blocked" },
      }, initial.revision)).toThrow(/locked by another writer/)
      held.release()

      const winner = saveModelSettings(project, {
        explorer: { providerID: "p", modelID: "winner" },
      }, initial.revision)
      expect(winner.revision).toBe(initial.revision + 1)
      expect(() => saveModelSettings(project, {
        explorer: { providerID: "p", modelID: "stale" },
      }, initial.revision)).toThrow(/changed concurrently/)
      expect(loadModelSettings(project).models.explorer?.modelID).toBe("winner")

      const lockPath = modelSettingsLockPath(project)
      writeFileSync(lockPath, '{"malformed":true}', "utf8")
      const malformed = readFileSync(lockPath, "utf8")
      expect(() => saveModelSettings(project, {})).toThrow(/malformed or unverifiable/)
      expect(readFileSync(lockPath, "utf8")).toBe(malformed)
    } finally {
      removeProject(project)
    }
  })

  test("model settings lock releases in finally when validation fails", () => {
    const project = tempProject()
    try {
      expect(() => saveModelSettings(project, {
        shell: { providerID: "x", modelID: "y" },
      } as any)).toThrow()
      expect(existsSync(modelSettingsLockPath(project))).toBe(false)
    } finally {
      removeProject(project)
    }
  })

  test("failed model quarantine rename honestly reports manual recovery", () => {
    const project = tempProject()
    try {
      saveModelSettings(project, {})
      const path = modelSettingsPath(project)
      writeFileSync(path, "{corrupt-models", "utf8")
      expect(() => loadModelSettings(project, {
        renameCorruptFile() { throw new Error("injected model rename denial") },
      })).toThrow(/corrupt file remains in place.*manual action.*injected model rename denial/)
      expect(readFileSync(path, "utf8")).toBe("{corrupt-models")
    } finally {
      removeProject(project)
    }
  })

  test("live alg_run persists child session ids and returns matching session links", async () => {
    const project = tempProject()
    let plannedRunId = ""
    try {
      const client = {
        session: {
          create: async () => ({
            data: { id: "child-implementer" },
            error: undefined,
            request: {},
            response: {},
          }),
          prompt: async () => {
            expect(JSON.parse(readFileSync(
              runContainedPath(project, plannedRunId, "progress.json"),
              "utf8",
            )).nodes.work.attempts[0].session_id).toBe("child-implementer")
            expect(JSON.parse(readFileSync(
              runContainedPath(project, plannedRunId, "sessions", "work-a1.json"),
              "utf8",
            )).session_id).toBe("child-implementer")
            throw new Error("injected prompt fault after session creation")
          },
        },
      } as never
      const tools = createAlgTools({
        client,
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)
      const context = {
        sessionID: "owner",
        messageID: "message",
        agent: "orchestrator",
        directory: project,
        worktree: project,
        abort: new AbortController().signal,
        ask: async () => {},
        metadata: () => {},
      } as any
      const planned = await tools.alg_plan.execute({
        goal: "session persistence",
        graph_json: JSON.stringify({
          name: "single-child",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        }),
      }, context)
      const runId = JSON.parse((planned as { output: string }).output).run_id
      plannedRunId = runId
      const result = await tools.alg_run.execute({ run_id: runId }, context)
      const output = JSON.parse((result as { output: string }).output)
      expect(output.nodes.work.session_ids).toEqual(["child-implementer"])
      const reloaded = loadRun(project, runId)!
      expect(reloaded.nodes.work!.attempts[0]!.session_id).toBe("child-implementer")
      const sidecar = JSON.parse(await Bun.file(
        runContainedPath(project, runId, "sessions", "work-a1.json"),
      ).text())
      expect(sidecar).toMatchObject({
        node_id: "work",
        attempt: 1,
        session_id: "child-implementer",
      })
    } finally {
      removeProject(project)
    }
  })

  test("alg_resume exposes preserved and newly-created child session ids", async () => {
    const project = tempProject()
    try {
      const client = {
        session: {
          create: async () => ({ data: { id: "child-after-resume" }, error: undefined, request: {}, response: {} }),
          prompt: async () => ({
            data: { parts: [{
              type: "text",
              text: '{"summary":["resumed"],"files_touched":[],"commands_run":[],"risks":[],"done":true}',
            }] },
            error: undefined,
            request: {},
            response: {},
          }),
        },
      } as never
      const tools = createAlgTools({
        client,
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)
      const context = {
        sessionID: "owner",
        messageID: "message",
        agent: "orchestrator",
        directory: project,
        worktree: project,
        abort: new AbortController().signal,
        ask: async () => {},
        metadata: () => {},
      } as any
      const planned = await tools.alg_plan.execute({
        goal: "resume session history",
        graph_json: JSON.stringify({
          name: "resume-child",
          max_global_attempts: 2,
          max_concurrency: 1,
          nodes: [{
            id: "work",
            agent: "implementer",
            depends_on: [],
            loop: { max_attempts: 2, gate: "schema" },
          }],
        }),
      }, context)
      const runId = JSON.parse((planned as { output: string }).output).run_id
      const interrupted = loadRun(project, runId)!
      interrupted.status = "running"
      interrupted.phase = "execute"
      interrupted.global_attempts = 1
      interrupted.nodes.work!.status = "running"
      interrupted.nodes.work!.current_attempt = 1
      interrupted.nodes.work!.attempts = [{
        attempt: 1,
        status: "running",
        session_id: "child-before-resume",
        started_at: new Date().toISOString(),
        failures: [],
      }]
      persistRun(interrupted, project)

      const result = await tools.alg_resume.execute({ run_id: runId }, context)
      const output = JSON.parse((result as { output: string }).output)
      expect(output.nodes.work.session_ids).toEqual(["child-before-resume", "child-after-resume"])
      expect(loadRun(project, runId)!.nodes.work!.attempts.map((attempt) => attempt.session_id))
        .toEqual(["child-before-resume", "child-after-resume"])
    } finally {
      removeProject(project)
    }
  })
})

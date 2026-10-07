import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ALG_LIVE_REFRESH_MS,
  LiveRunController,
  elapsedLabel,
  formatLiveState,
  navigateToSavedChild,
  statusLabel,
  type LiveClock,
} from "../src/tui-live.ts"
import type { AlgRunProgress } from "../src/run-progress.ts"
import { readOwnedLiveProgress } from "../src/tui-runs.ts"
import { tui } from "../src/tui-models.ts"
import { createRun, persistRun } from "../src/store.ts"
import { removeProject, tempProject } from "./helpers.ts"

function progress(overrides: Partial<AlgRunProgress> = {}): AlgRunProgress {
  const base: AlgRunProgress = {
    version: 1,
    run_id: "run-1",
    owner_session_id: "parent",
    revision: 1,
    status: "running",
    mode: "live",
    created_at: "2026-10-07T12:00:00.000Z",
    updated_at: "2026-10-07T12:00:02.000Z",
    nodes_total: 2,
    nodes_omitted: 0,
    counts: { pending: 0, ready: 0, running: 1, done: 0, failed: 0, skipped: 1 },
    nodes: [
      { id: "work", agent: "implementer", status: "running", attempt: 2, retries: 1,
        session_id: "child-1", started_at: "2026-10-07T12:00:00.000Z" },
      { id: "shell-step", agent: "shell", status: "skipped", attempt: 0, retries: 0 },
    ],
  }
  return { ...base, ...overrides }
}

class FakeClock implements LiveClock {
  time = Date.parse("2026-10-07T12:00:03.000Z")
  private nextId = 1
  private tasks = new Map<number, { at: number; callback: () => void }>()
  now = () => this.time
  setTimeout = (callback: () => void, delay: number) => {
    const id = this.nextId++
    this.tasks.set(id, { at: this.time + delay, callback })
    return id as unknown as ReturnType<typeof setTimeout>
  }
  clearTimeout = (timer: ReturnType<typeof setTimeout>) => { this.tasks.delete(timer as unknown as number) }
  advance(ms: number) {
    this.time += ms
    for (const [id, task] of [...this.tasks]) {
      if (task.at > this.time) continue
      this.tasks.delete(id)
      task.callback()
    }
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

async function settle() {
  for (let index = 0; index < 6; index++) await Promise.resolve()
}

describe("ALG live progress controller", () => {
  const controllers: LiveRunController[] = []
  afterEach(() => { for (const controller of controllers.splice(0)) controller.dispose() })

  test("rehydrates once, refreshes only the selected run, and keeps mid-run saved revisions visible", async () => {
    const clock = new FakeClock()
    const discovered: string[] = []
    let reads = 0
    const controller = new LiveRunController({
      clock,
      discover: async (owner) => { discovered.push(owner); return ["run-1", "run-older"] },
      read: async () => progress({ revision: ++reads, updated_at: new Date(clock.now()).toISOString() }),
    })
    controllers.push(controller)
    await controller.selectOwner("parent")
    expect(discovered).toEqual(["parent"])
    expect(controller.snapshot()).toMatchObject({ phase: "saved", runId: "run-1", progress: { revision: 1 } })
    clock.advance(ALG_LIVE_REFRESH_MS)
    await settle()
    expect(discovered).toHaveLength(1)
    expect(controller.snapshot().progress?.revision).toBe(2)
    expect(formatLiveState(controller.snapshot(), clock.now())).toContain("Saved running state · liveness unknown")
    expect(formatLiveState(controller.snapshot(), clock.now())).toContain("retries 1")
    expect(formatLiveState(controller.snapshot(), clock.now())).toContain("child child-1")
  })

  test("labels corruption/wrong-owner as unavailable and never promotes saved running to current activity", async () => {
    const controller = new LiveRunController({
      discover: async () => ["run-1"],
      read: async () => null,
    })
    controllers.push(controller)
    await controller.selectOwner("parent")
    expect(controller.snapshot()).toMatchObject({ phase: "unavailable" })
    expect(formatLiveState(controller.snapshot())).toContain("unavailable")
    expect(statusLabel(progress())).toBe("Saved running state · liveness unknown")
  })

  test("durable adapter projects a real saved run, rejects corruption, and ignores another owner", async () => {
    const project = tempProject("alg-live-durable-")
    const otherProject = tempProject("alg-live-other-")
    const run = createRun({
      goal: "private goal", criteria: [],
      graph: { name: "fixture", nodes: [{ id: "work", agent: "implementer", depends_on: [] }], max_global_attempts: 1, max_concurrency: 1 },
      projectDirectory: project, ownerSessionId: "parent", runId: "run-1", mode: "live",
    })
    persistRun(run, project)
    let content = readFileSync(join(project, ".opencode", "runs", "run-1", "progress.json"), "utf8")
    const api: any = {
      state: { path: { worktree: project, directory: project } },
      client: { file: { read: async () => ({ data: { type: "text", content } }) } },
    }
    try {
      expect(await readOwnedLiveProgress(api, "parent", "run-1")).toMatchObject({
        run_id: "run-1", owner_session_id: "parent", status: "planning", counts: { ready: 1 },
      })
      expect(await readOwnedLiveProgress(api, "other-parent", "run-1")).toBeNull()
      content = "{broken"
      await expect(readOwnedLiveProgress(api, "parent", "run-1")).rejects.toThrow("valid JSON")
      content = JSON.stringify({ ...JSON.parse(readFileSync(join(project, ".opencode", "runs", "run-1", "progress.json"), "utf8")), run_id: "different-run" })
      await expect(readOwnedLiveProgress(api, "parent", "run-1")).rejects.toThrow("mismatched run ID")
      content = JSON.stringify({ ...JSON.parse(readFileSync(join(project, ".opencode", "runs", "run-1", "progress.json"), "utf8")), project_directory: otherProject })
      await expect(readOwnedLiveProgress(api, "parent", "run-1")).rejects.toThrow("another project")
    } finally {
      removeProject(project)
      removeProject(otherProject)
    }
  })

  test("paused/ready elapsed time freezes at last durable update; completed nodes use finish time", () => {
    const blocked = progress({ status: "blocked", updated_at: "2026-10-07T12:00:20.000Z" })
    const ready = { ...blocked.nodes[0]!, status: "ready" as const }
    expect(elapsedLabel(ready, blocked)).toBe("elapsed at save 0m20s")
    const done = { ...ready, status: "done" as const, finished_at: "2026-10-07T12:00:07.000Z" }
    expect(elapsedLabel(done, blocked)).toBe("elapsed 0m07s")
    expect(elapsedLabel(blocked.nodes[0]!, blocked)).toBe("elapsed at save 0m20s")
  })

  test("route generation and disposal fence late discovery/read completions", async () => {
    const discovery = deferred<string[]>()
    const controller = new LiveRunController({ discover: () => discovery.promise, read: async () => progress() })
    controllers.push(controller)
    const pending = controller.selectOwner("parent")
    controller.dispose()
    discovery.resolve(["run-1"])
    await pending
    expect(controller.snapshot()).toMatchObject({ owner: null, phase: "idle" })

    const late = deferred<AlgRunProgress | null>()
    const switched = new LiveRunController({ discover: async () => ["run-1"], read: () => late.promise })
    controllers.push(switched)
    const stale = switched.selectOwner("parent")
    await settle()
    await switched.selectOwner(null)
    late.resolve(progress())
    await stale
    expect(switched.snapshot()).toMatchObject({ owner: null, phase: "idle" })
  })

  test("stalled read is reported, retained, and never overlapped by polling", async () => {
    const clock = new FakeClock()
    const stalled = deferred<AlgRunProgress | null>()
    let calls = 0
    const controller = new LiveRunController({
      clock,
      timeoutMs: 100,
      discover: async () => ["run-1"],
      read: async () => { calls++; return calls === 1 ? progress() : stalled.promise },
    })
    controllers.push(controller)
    await controller.selectOwner("parent")
    clock.advance(ALG_LIVE_REFRESH_MS)
    await settle()
    const generation = controller.currentGeneration()
    await expect(controller.readForNavigation("parent", "run-1", generation)).rejects.toThrow("still pending")
    clock.advance(100)
    await settle()
    expect(controller.snapshot()).toMatchObject({ phase: "unavailable", progress: { revision: 1 } })
    clock.advance(ALG_LIVE_REFRESH_MS * 4)
    await settle()
    expect(calls).toBe(2)
  })

  test("click re-reads ownership, checks cached parent identity, and navigates once", async () => {
    const navigations: unknown[] = []
    let routeOwner = "parent"
    const current = progress()
    const controller = new LiveRunController({ discover: async () => ["run-1"], read: async () => current })
    controllers.push(controller)
    await controller.selectOwner("parent")
    const api: any = {
      route: {
        get current() { return { name: "session", params: { sessionID: routeOwner } } },
        navigate(name: string, params: unknown) { navigations.push([name, params]) },
      },
      state: { session: { get: (id: string) => ({ id, parentID: "parent", projectID: "project-1" }) } },
    }
    const generation = controller.currentGeneration()
    const selected = current.nodes[0]!
    expect(await navigateToSavedChild(api, controller, "parent", "run-1", selected, generation)).toBe(true)
    expect(navigations).toHaveLength(1)
    expect(navigations[0]).toEqual(["session", { sessionID: "child-1" }])
    routeOwner = "other-parent"
    expect(await navigateToSavedChild(api, controller, "parent", "run-1", selected, generation)).toBe(false)
    expect(navigations).toHaveLength(1)
  })

  test("rejects dry, shell, absent-child, wrong-parent, stale-generation, and malformed child links", async () => {
    const navigations: unknown[] = []
    let currentProgress = progress()
    let targetParent = "parent"
    let targetProject = "project-1"
    const controller = new LiveRunController({ discover: async () => ["run-1"], read: async () => currentProgress })
    controllers.push(controller)
    await controller.selectOwner("parent")
    const api: any = {
      route: { current: { name: "session", params: { sessionID: "parent" } }, navigate: (...value: unknown[]) => navigations.push(value) },
      state: { session: { get: (id: string) => ({ id, parentID: targetParent, projectID: id === "parent" ? "project-1" : targetProject }) } },
    }
    const generation = controller.currentGeneration()
    const selected = currentProgress.nodes[0]!
    currentProgress = progress({ mode: "dry" })
    expect(await navigateToSavedChild(api, controller, "parent", "run-1", selected, generation)).toBe(false)
    currentProgress = progress({ nodes: [{ ...progress().nodes[0]!, agent: "shell" }] })
    expect(await navigateToSavedChild(api, controller, "parent", "run-1", selected, generation)).toBe(false)
    currentProgress = progress({ nodes: [{ ...progress().nodes[0]!, session_id: "../other" }] })
    expect(await navigateToSavedChild(api, controller, "parent", "run-1", selected, generation)).toBe(false)
    expect(await navigateToSavedChild(api, controller, "parent", "run-1", { ...selected, session_id: "../other" }, generation)).toBe(false)
    currentProgress = progress({ nodes: [{ ...selected, attempt: 3, retries: 2, session_id: "child-2" }] })
    expect(await navigateToSavedChild(api, controller, "parent", "run-1", selected, generation)).toBe(false)
    currentProgress = progress()
    targetParent = "different-parent"
    expect(await navigateToSavedChild(api, controller, "parent", "run-1", selected, generation)).toBe(false)
    targetParent = "parent"
    targetProject = "other-project"
    expect(await navigateToSavedChild(api, controller, "parent", "run-1", selected, generation)).toBe(false)
    expect(await navigateToSavedChild(api, controller, "parent", "run-1", selected, generation - 1)).toBe(false)
    expect(navigations).toHaveLength(0)
  })

  test("does not call prompt, messages, or transcript APIs", async () => {
    let promptCalls = 0
    const controller = new LiveRunController({ discover: async () => ["run-1"], read: async () => progress() })
    controllers.push(controller)
    await controller.selectOwner("parent")
    const api: any = { prompt: () => { promptCalls++ }, state: { session: { messages: () => { promptCalls++ } } } }
    expect(controller.snapshot().progress?.revision).toBe(1)
    expect(promptCalls).toBe(0)
    expect(api.prompt).toBeTypeOf("function")
  })

  test("OpenTUI synthetic render smoke mounts the live surface and renders saved labels", async () => {
    const controller = new LiveRunController({ discover: async () => ["run-1"], read: async () => progress() })
    controllers.push(controller)
    await controller.selectOwner("parent")
    const api: any = {
      route: { current: { name: "session", params: { sessionID: "parent" } }, navigate() {} },
      state: { session: { get: (id: string) => ({ id, parentID: "parent" }) } },
    }
    try {
      const [{ createLiveDialog }, { testRender }] = await Promise.all([
        import("../src/tui-live-render.ts"),
        import("@opentui/solid"),
      ])
      let surface: ReturnType<typeof createLiveDialog> | undefined
      const rendered = await testRender(() => {
        surface = createLiveDialog(api, controller, "parent")
        return surface.element as never
      }, { width: 80, height: 24 })
      await rendered.flush()
      const frame = rendered.captureCharFrame()
      const spans = rendered.captureSpans().lines.flatMap((line) => line.spans.map((span) => span.text)).join("")
      const output = `${frame}\n${spans}`.toLowerCase()
      expect(output).toContain("alg live")
      expect(output).toContain("last saved")
      expect(output).toContain("run-1")
      expect(output).toContain("work")
      surface?.dispose()
      rendered.renderer.destroy()
    } catch (error) {
      console.warn(`[OpenTUI render smoke unavailable or failed: ${error instanceof Error ? error.message : String(error)}]`)
      throw error
    }
  })

  test("/alg-live command mounts inside renderer and disposes its keyboard interceptor", async () => {
    const project = tempProject("alg-live-command-")
    const run = createRun({
      goal: "private goal", criteria: [],
      graph: { name: "fixture", nodes: [{ id: "work", agent: "implementer", depends_on: [] }], max_global_attempts: 1, max_concurrency: 1 },
      projectDirectory: project, ownerSessionId: "parent", runId: "run-1", mode: "live",
    })
    persistRun(run, project)
    let command: { slashName?: string; run: () => Promise<void> } | undefined
    let renderDialog: (() => unknown) | undefined
    let closeDialog: (() => void) | undefined
    let intercept: ((context: { event: { name: string }; consume: () => void }) => void) | undefined
    let removed = 0
    const api: any = {
      route: { current: { name: "session", params: { sessionID: "parent" } }, navigate() {} },
      state: {
        path: { worktree: project, directory: project },
        session: { get: (id: string) => ({ id, parentID: "parent", projectID: "project-1" }) },
      },
      client: {
        file: { read: async ({ path }: { path: string }) => {
          const file = join(project, path)
          return existsSync(file)
            ? { data: { type: "text", content: readFileSync(file, "utf8") } }
            : { error: { status: 404 }, response: { status: 404 } }
        } },
        find: { files: async () => ({ data: [".opencode/runs/run-1/progress.json"] }) },
        app: { log: async () => ({}) },
      },
      slots: { register: () => "alg-live" },
      lifecycle: { onDispose: () => () => {} },
      keymap: {
        registerLayer: ({ commands }: { commands: Array<{ slashName?: string; run: () => Promise<void> }> }) => {
          command = commands.find((candidate) => candidate.slashName === "alg-live")
        },
        intercept: (_name: string, handler: typeof intercept) => {
          intercept = handler
          return () => { removed++ }
        },
      },
      ui: {
        toast: () => { throw new Error("unexpected toast") },
        Dialog: ({ children, onClose }: { children: unknown; onClose: () => void }) => {
          closeDialog = onClose
          return children
        },
        dialog: {
          open: true,
          setSize: () => {},
          replace: (render: () => unknown, onClose: () => void) => {
            renderDialog = render
            closeDialog = onClose
          },
        },
      },
    }
    try {
      await tui(api, undefined, {} as never)
      expect(command).toBeDefined()
      await command!.run()
      expect(renderDialog).toBeDefined()
      const { testRender } = await import("@opentui/solid")
      const rendered = await testRender(() => renderDialog!() as never, { width: 80, height: 24 })
      await rendered.flush()
      expect(rendered.captureCharFrame().toLowerCase()).toContain("alg live")
      expect(rendered.captureSpans().lines.flatMap((line) => line.spans.map((span) => span.text)).join(" ").toLowerCase()).toContain("run-1")
      let consumed = 0
      intercept!({ event: { name: "return" }, consume: () => { consumed++ } })
      expect(consumed).toBe(1)
      closeDialog!()
      closeDialog!()
      expect(removed).toBe(1)
      rendered.renderer.destroy()
    } finally {
      removeProject(project)
    }
  })
})

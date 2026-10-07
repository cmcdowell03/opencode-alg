import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AlgNodeProgress, AlgRunProgress } from "./run-progress.ts"
import { parseRunProgress } from "./run-progress.ts"
import { discoverOwnedRunIds, readOwnedLiveProgress } from "./tui-runs.ts"

export const ALG_LIVE_REFRESH_MS = 2_000
export const ALG_LIVE_READ_TIMEOUT_MS = 5_000
const MAX_LIVE_DISCOVERY_IDS = 128

export interface LiveViewState {
  owner: string | null
  runId?: string
  progress?: AlgRunProgress
  phase: "idle" | "loading" | "saved" | "unavailable"
  message?: string
  observedAt?: number
}

export interface LiveClock {
  now(): number
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}

export interface LiveControllerDependencies {
  discover(owner: string): Promise<string[]>
  read(owner: string, runId: string): Promise<AlgRunProgress | null>
  clock?: LiveClock
  refreshMs?: number
  timeoutMs?: number
}

function defaultClock(): LiveClock {
  return {
    now: () => Date.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: (timer) => clearTimeout(timer),
  }
}

/** A single-flight, owner-fenced controller for one selected durable run. */
export class LiveRunController {
  private readonly clock: LiveClock
  private readonly refreshMs: number
  private readonly timeoutMs: number
  private readonly listeners = new Set<(state: LiveViewState) => void>()
  private state: LiveViewState = { owner: null, phase: "idle" }
  private timer?: ReturnType<typeof setTimeout>
  private generation = 0
  private disposed = false
  private timedOut = false
  private inFlight?: Promise<unknown>

  constructor(private readonly dependencies: LiveControllerDependencies) {
    this.clock = dependencies.clock ?? defaultClock()
    this.refreshMs = dependencies.refreshMs ?? ALG_LIVE_REFRESH_MS
    this.timeoutMs = dependencies.timeoutMs ?? ALG_LIVE_READ_TIMEOUT_MS
  }

  snapshot(): LiveViewState {
    return this.state
  }

  subscribe(listener: (state: LiveViewState) => void): () => void {
    this.listeners.add(listener)
    listener(this.state)
    return () => this.listeners.delete(listener)
  }

  private publish(next: LiveViewState): void {
    this.state = next
    for (const listener of this.listeners) listener(next)
  }

  async selectOwner(owner: string | null): Promise<void> {
    const generation = ++this.generation
    this.timedOut = false
    this.clearTimer()
    if (this.disposed || !owner) {
      this.publish({ owner: null, phase: "idle" })
      return
    }
    this.publish({ owner, phase: "loading" })
    try {
      const runIds = await this.request(() => this.dependencies.discover(owner), generation)
      if (!this.isCurrent(owner, generation)) return
      const selected = runIds.slice(0, MAX_LIVE_DISCOVERY_IDS)[0]
      if (!selected) {
        this.publish({ owner, phase: "saved", message: "No saved ALG runs for this parent." })
        return
      }
      await this.readSelected(owner, selected, generation)
    } catch (error) {
      if (!this.isCurrent(owner, generation)) return
      this.publish({ owner, phase: "unavailable", message: `Live progress unavailable: ${messageOf(error)}` })
    }
  }

  /** Recheck route ownership and generation before using a child link. */
  isCurrent(owner: string, generation: number): boolean {
    return !this.disposed && this.generation === generation && this.state.owner === owner
  }

  currentGeneration(): number {
    return this.generation
  }

  async readForNavigation(owner: string, runId: string, generation: number): Promise<AlgRunProgress | null> {
    if (!this.isCurrent(owner, generation)) return null
    return this.request(() => this.dependencies.read(owner, runId), generation)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation++
    this.clearTimer()
    this.listeners.clear()
    this.state = { owner: null, phase: "idle" }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  private async withTimeout<Value>(promise: Promise<Value>, generation: number): Promise<Value> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = this.clock.setTimeout(() => {
            if (this.generation === generation) this.timedOut = true
            reject(new Error("read timed out; retaining last saved state"))
          }, this.timeoutMs)
        }),
      ])
    } finally {
      if (timer !== undefined) this.clock.clearTimeout(timer)
    }
  }

  private request<Value>(start: () => Promise<Value>, generation: number): Promise<Value> {
    if (this.inFlight) return Promise.reject(new Error("another bounded progress read is still pending"))
    const operation = Promise.resolve().then(start)
    this.inFlight = operation
    void operation.then(
      () => { if (this.inFlight === operation) this.inFlight = undefined },
      () => { if (this.inFlight === operation) this.inFlight = undefined },
    )
    return this.withTimeout(operation, generation)
  }

  private async readSelected(owner: string, runId: string, generation: number): Promise<void> {
    if (!this.isCurrent(owner, generation)) return
    try {
      const progress = await this.request(() => this.dependencies.read(owner, runId), generation)
      if (!this.isCurrent(owner, generation)) return
      if (!progress) throw new Error("saved progress is not owned by the current parent")
      this.publish({ owner, runId, progress, phase: "saved", observedAt: this.clock.now() })
      if (progress.status === "running" && !this.timedOut) {
        this.timer = this.clock.setTimeout(() => {
          this.timer = undefined
          if (this.isCurrent(owner, generation)) void this.readSelected(owner, runId, generation)
        }, this.refreshMs)
      }
    } catch (error) {
      if (!this.isCurrent(owner, generation)) return
      const previous = this.state.progress
      this.publish({
        owner,
        runId,
        ...(previous ? { progress: previous } : {}),
        phase: "unavailable",
        message: `Last saved snapshot${previous ? ` ${previous.updated_at}` : " unavailable"}; refresh unavailable: ${messageOf(error)}`,
        ...(this.state.observedAt ? { observedAt: this.state.observedAt } : {}),
      })
    }
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const controllers = new WeakMap<object, LiveRunController>()

function controllerFor(api: TuiPluginApi): LiveRunController {
  let controller = controllers.get(api)
  if (!controller) {
    controller = new LiveRunController({
      discover: (owner) => discoverOwnedRunIds(api, owner),
      read: (owner, runId) => readOwnedLiveProgress(api, owner, runId),
    })
    controllers.set(api, controller)
    api.lifecycle?.onDispose(() => controller?.dispose())
  }
  return controller
}

export function currentTuiOwner(api: TuiPluginApi): string | null {
  const route = api.route.current
  return route.name === "session" && typeof route.params?.sessionID === "string"
    ? route.params.sessionID
    : null
}

export function statusLabel(progress: AlgRunProgress): string {
  switch (progress.status) {
    case "planning": return "Waiting for plan"
    case "running": return "Saved running state · liveness unknown"
    case "blocked": return "Blocked"
    case "failed": return "Failed"
    case "done": return "Completed"
  }
}

export function elapsedLabel(node: AlgNodeProgress, progress: AlgRunProgress): string {
  if (!node.started_at) return "elapsed n/a"
  const started = Date.parse(node.started_at)
  const ended = Date.parse(node.finished_at ?? progress.updated_at)
  if (!Number.isFinite(started) || !Number.isFinite(ended) || ended < started) return "elapsed n/a"
  const seconds = Math.floor((ended - started) / 1_000)
  const prefix = node.finished_at ? "elapsed" : "elapsed at save"
  return `${prefix} ${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`
}

export function formatLiveState(state: LiveViewState, now = Date.now(), includeNodes = true): string {
  if (state.phase === "idle") return "ALG live\nOpen a parent session to view saved run progress."
  if (state.phase === "loading") return "ALG live\nLoading last-saved progress…"
  if (!state.progress) return `ALG live\n${state.message ?? "Saved progress unavailable."}`
  const progress = state.progress
  const age = Math.max(0, Math.floor((now - Date.parse(progress.updated_at)) / 1_000))
  const lines = [
    `ALG live · ${progress.run_id} · ${statusLabel(progress)}`,
    `Last saved ${age}s ago · revision ${progress.revision} · ${progress.mode}`,
    `Nodes ${progress.nodes_total} · running ${progress.counts.running} · ready ${progress.counts.ready} · failed ${progress.counts.failed} · done ${progress.counts.done}`,
  ]
  for (const node of includeNodes ? progress.nodes : []) {
    const nodeStatus = node.status === "ready" ? "Waiting / ready" : node.status
    const ageText = elapsedLabel(node, progress)
    const link = progress.mode === "live" && node.agent !== "shell" && node.session_id
      ? ` · child ${node.session_id}`
      : ""
    lines.push(`${node.id} · ${node.agent} · ${nodeStatus} · retries ${node.retries} · ${ageText}${link}`)
  }
  if (progress.nodes_omitted) lines.push(`${progress.nodes_omitted} node(s) omitted from bounded live summary`)
  if (state.phase === "unavailable" && state.message) lines.push(state.message)
  return lines.join("\n")
}

export async function navigateToSavedChild(
  api: TuiPluginApi,
  controller: LiveRunController,
  owner: string,
  runId: string,
  selected: Pick<AlgNodeProgress, "id" | "attempt" | "session_id">,
  generation: number,
): Promise<boolean> {
  if (!controller.isCurrent(owner, generation) || currentTuiOwner(api) !== owner) return false
  if (!selected.session_id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(selected.session_id)) return false
  const freshValue = await controller.readForNavigation(owner, runId, generation).catch(() => null)
  const fresh = freshValue ? parseRunProgress(freshValue, owner) : null
  if (!controller.isCurrent(owner, generation) || currentTuiOwner(api) !== owner ||
    !fresh || fresh.mode !== "live" || fresh.run_id !== runId || fresh.owner_session_id !== owner) return false
  const node = fresh.nodes.find((candidate) => candidate.id === selected.id)
  if (!node?.session_id || node.agent === "shell" ||
    node.attempt !== selected.attempt || node.session_id !== selected.session_id) return false
  const parent = api.state.session.get(owner)
  const target = api.state.session.get(selected.session_id)
  if (!parent?.projectID || !target || target.id !== selected.session_id ||
    target.parentID !== owner || target.projectID !== parent.projectID) return false
  api.route.navigate("session", { sessionID: selected.session_id })
  return true
}

export async function openAlgLive(api: TuiPluginApi): Promise<void> {
  const owner = currentTuiOwner(api)
  if (!owner) {
    api.ui.toast({ variant: "info", title: "ALG live unavailable", message: "Open a parent session first.", duration: 8_000 })
    return
  }
  try {
    const controller = controllerFor(api)
    if (controller.snapshot().owner !== owner) await controller.selectOwner(owner)
    if (currentTuiOwner(api) !== owner) return
    const { createLiveDialog } = await import("./tui-live-render.ts")
    api.ui.dialog.setSize("large")
    let cleanup = () => {}
    api.ui.dialog.replace(() => {
      cleanup()
      const surface = createLiveDialog(api, controller, owner)
      let removeKeys = () => {}
      let closed = false
      cleanup = () => {
        if (closed) return
        closed = true
        removeKeys()
        surface.dispose()
      }
      try {
        removeKeys = api.keymap.intercept("key", (context) => {
          if (!api.ui.dialog.open || currentTuiOwner(api) !== owner) return
          const key = (context.event as unknown as { name?: string }).name
          if (typeof key === "string" && surface.handleKey(key)) context.consume()
        })
        return api.ui.Dialog({ onClose: cleanup, children: surface.element as never })
      } catch (error) {
        cleanup()
        throw error
      }
    }, () => cleanup())
  } catch (error) {
    api.ui.toast({
      variant: "warning",
      title: "ALG live view unavailable",
      message: `The live panel could not be mounted: ${messageOf(error)}`,
      duration: 8_000,
    })
  }
}

export async function installAlgLiveSidebar(api: TuiPluginApi): Promise<boolean> {
  if (!api.slots?.register) return false
  const controller = controllerFor(api)
  const { createLiveSidebarElement } = await import("./tui-live-render.ts")
  api.slots.register({
    slots: {
      sidebar_content: (_context, props) => createLiveSidebarElement(api, controller, props.session_id) as never,
    },
  })
  return true
}

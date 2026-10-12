import { createHash, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { resolveContainedPath } from "./paths.ts"
import type { RunState } from "./types.ts"

/**
 * Mirrors ALG worker attempts into the parent transcript as native OpenCode `task` tool parts, so the
 * host draws every child session with its own subagent card (spinner, live tool line, click-through).
 *
 * This is display only. ALG's executor still creates, runs, validates, and persists every attempt; a card
 * is derived from durable run state after a successful save and can never change an outcome. Any transport
 * failure disables the projector for the rest of the call and the run continues with the plain tool line.
 */

export type SubagentCardMode = "native" | "off"

export const MAX_RUN_CARDS = 64
const CARD_SIDECAR_DIRECTORY = "_cards"
const MAX_SIDECAR_BYTES = 256 * 1_024
const MAX_CONSECUTIVE_FAILURES = 2
const ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

type CardInput = { description: string; prompt: string; subagent_type: string }
type CardMetadata = { sessionId: string; parentSessionId: string }
type CardState =
  | { status: "running"; input: CardInput; title: string; metadata: CardMetadata; time: { start: number } }
  | { status: "completed"; input: CardInput; title: string; metadata: CardMetadata; output: string; time: { start: number; end: number } }
  | { status: "error"; input: CardInput; metadata: CardMetadata; error: string; time: { start: number; end: number } }

export interface RunCardPart {
  id: string
  sessionID: string
  messageID: string
  type: "tool"
  callID: string
  tool: "task"
  state: CardState
}

/** Adds or replaces one part on a parent assistant message. Must reject when the host refuses it. */
export interface RunCardTransport {
  upsert(part: RunCardPart): Promise<void>
}

let lastIdTimestamp = 0
let idCounter = 0

/** Same layout as OpenCode's ascending identifiers, so a card sorts after the tool call that created it. */
export function ascendingPartId(now = Date.now()): string {
  if (now !== lastIdTimestamp) { lastIdTimestamp = now; idCounter = 0 }
  idCounter++
  const value = BigInt(now) * 0x1000n + BigInt(idCounter)
  const time = Array.from({ length: 6 }, (_, index) => Number((value >> BigInt(40 - 8 * index)) & 0xffn).toString(16).padStart(2, "0")).join("")
  return `prt_${time}${Array.from(randomBytes(14), (byte) => ID_CHARS[byte % 62]).join("")}`
}

/** The plugin's SDK client carries the host transport; older or fake clients simply have no card support. */
export function runCardTransport(client: unknown, directory: string): RunCardTransport | null {
  const raw = (client as { _client?: { patch?: (options: Record<string, unknown>) => Promise<unknown> } } | null | undefined)?._client
  if (!raw || typeof raw.patch !== "function") return null
  return {
    async upsert(part) {
      const result = await raw.patch!({
        url: "/session/{sessionID}/message/{messageID}/part/{partID}",
        path: { sessionID: part.sessionID, messageID: part.messageID, partID: part.id },
        query: { directory },
        body: part,
        headers: { "Content-Type": "application/json" },
        throwOnError: false,
      }) as { error?: unknown; response?: { ok?: boolean; status?: number } } | undefined
      if (!result || result.error !== undefined || result.response?.ok === false) {
        throw new Error(`host rejected the subagent card (${result?.response?.status ?? "no response"})`)
      }
    },
  }
}

function sidecarPath(project: string, runId: string): string {
  return resolveContainedPath(project, ".opencode", "runs", CARD_SIDECAR_DIRECTORY, `${runId}.json`)
}

function readSidecar(path: string): RunCardPart[] {
  try {
    if (!existsSync(path)) return []
    const text = readFileSync(path, "utf8")
    if (Buffer.byteLength(text, "utf8") > MAX_SIDECAR_BYTES) return []
    const value = JSON.parse(text) as { schema_version?: unknown; cards?: unknown }
    if (value.schema_version !== 1 || !Array.isArray(value.cards)) return []
    return value.cards.filter((card): card is RunCardPart => Boolean(card) && typeof card === "object" &&
      typeof (card as RunCardPart).id === "string" && (card as RunCardPart).tool === "task" && (card as RunCardPart).state?.status === "running")
  } catch { return [] }
}

function interrupted(part: RunCardPart, reason: string, now: number): RunCardPart {
  return { ...part, state: { status: "error", input: part.state.input, metadata: part.state.metadata, error: reason,
    time: { start: part.state.time.start, end: Math.max(now, part.state.time.start) } } }
}

interface Card { part: RunCardPart; chain: Promise<void> }

export interface RunCardProjectorOptions {
  transport: RunCardTransport
  project: string
  runId: string
  parentSessionId: string
  /** The assistant message that contains the running alg_run / alg_resume tool call. */
  messageId: string
  now?: () => number
  log?: (message: string) => void
}

export class RunCardProjector {
  private readonly cards = new Map<string, Card>()
  private readonly baseline = new Map<string, number>()
  private readonly now: () => number
  private readonly sidecar: string
  private pending: Promise<void> = Promise.resolve()
  private failures = 0
  private disabled = false
  private settled = false

  constructor(private readonly options: RunCardProjectorOptions) {
    this.now = options.now ?? Date.now
    this.sidecar = sidecarPath(options.project, options.runId)
  }

  get active(): boolean { return !this.disabled }

  /**
   * Call once with the loaded run before execution. Attempts that already exist belong to an earlier tool
   * call and keep their own cards; cards a crashed process left running are closed as interrupted.
   */
  prime(run: RunState): void {
    for (const node of Object.values(run.nodes)) this.baseline.set(node.id, node.current_attempt)
    const stale = readSidecar(this.sidecar)
    for (const part of stale) this.send(interrupted(part, "ALG run stopped before this attempt finished.", this.now()))
    if (stale.length) this.writeSidecar()
  }

  /** Synchronous and best-effort: schedules host updates for attempts whose saved state changed. */
  observe(run: RunState): void {
    if (this.disabled || this.settled) return
    try {
      let changed = false
      for (const definition of run.graph.nodes) {
        if (definition.agent === "shell") continue
        const node = run.nodes[definition.id]
        if (!node) continue
        for (const attempt of node.attempts) {
          const child = attempt.session_id
          if (!child || child.startsWith("dry-") || attempt.attempt <= (this.baseline.get(definition.id) ?? 0)) continue
          const key = `${definition.id}#${attempt.attempt}`
          const existing = this.cards.get(key)
          if (!existing && this.cards.size >= MAX_RUN_CARDS) continue
          const description = attempt.attempt > 1 ? `${definition.id} · attempt ${attempt.attempt}` : definition.id
          const input: CardInput = {
            description,
            // The parent model sees this argument in its history; never copy the worker prompt here.
            prompt: `ALG run ${run.run_id}, node ${definition.id}, attempt ${attempt.attempt}.`,
            subagent_type: definition.agent,
          }
          const metadata: CardMetadata = { sessionId: child, parentSessionId: this.options.parentSessionId }
          const start = existing?.part.state.time.start ?? (Date.parse(attempt.started_at) || this.now())
          const end = () => Math.max(Date.parse(attempt.finished_at ?? "") || this.now(), start)
          const state: CardState = attempt.status === "done"
            ? { status: "completed", input, title: description, metadata, time: { start, end: end() },
                output: `ALG node ${definition.id} attempt ${attempt.attempt}: passed. The alg tool result has the validated output.` }
            : attempt.status === "failed"
              ? { status: "error", input, metadata, time: { start, end: end() },
                  error: `ALG node ${definition.id} attempt ${attempt.attempt} failed (${attempt.outcome ?? "failed"}). The alg tool result has the details.` }
              : { status: "running", input, title: description, metadata, time: { start } }
          if (existing && existing.part.state.status === state.status) continue
          if (existing && existing.part.state.status !== "running") continue
          const part: RunCardPart = existing
            ? { ...existing.part, state }
            : { id: ascendingPartId(this.now()), sessionID: this.options.parentSessionId, messageID: this.options.messageId, type: "tool",
                callID: `call_alg_${createHash("sha256").update(`${run.run_id}\0${definition.id}\0${attempt.attempt}`).digest("hex").slice(0, 24)}`,
                tool: "task", state }
          this.cards.set(key, { part, chain: existing?.chain ?? Promise.resolve() })
          this.send(part, key)
          changed = true
        }
      }
      if (changed) this.writeSidecar()
    } catch (error) {
      this.disable(error)
    }
  }

  /** Closes cards still shown as running and waits briefly for the host. Never throws. */
  async settle(reason = "ALG run stopped before this attempt finished.", timeoutMs = 3_000): Promise<void> {
    if (this.settled) return
    this.settled = true
    try {
      if (!this.disabled) {
        for (const [key, card] of this.cards) {
          if (card.part.state.status !== "running") continue
          card.part = interrupted(card.part, reason, this.now())
          this.send(card.part, key)
        }
      }
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.pending, new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs) })])
      if (timer) clearTimeout(timer)
      this.writeSidecar()
    } catch { /* display only */ }
  }

  private send(part: RunCardPart, key?: string): void {
    const card = key ? this.cards.get(key) : undefined
    const run = async () => {
      if (this.disabled) return
      try {
        await this.options.transport.upsert(part)
        this.failures = 0
      } catch (error) {
        if (++this.failures >= MAX_CONSECUTIVE_FAILURES) this.disable(error)
      }
    }
    const next = (card?.chain ?? Promise.resolve()).then(run, run)
    if (card) card.chain = next
    this.pending = Promise.allSettled([this.pending, next]).then(() => undefined)
  }

  private disable(error: unknown): void {
    if (this.disabled) return
    this.disabled = true
    try { this.options.log?.(`ALG subagent cards disabled for this call: ${error instanceof Error ? error.message : String(error)}`) } catch { /* optional */ }
  }

  /** Records cards still shown as running so a later call can close them after a crash. */
  private writeSidecar(): void {
    try {
      const running = [...this.cards.values()].map((card) => card.part).filter((part) => part.state.status === "running")
      if (!running.length || this.disabled) { rmSync(this.sidecar, { force: true }); return }
      mkdirSync(dirname(this.sidecar), { recursive: true })
      const temporary = `${this.sidecar}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ schema_version: 1, cards: running })}\n`, "utf8")
      renameSync(temporary, this.sidecar)
    } catch { /* display only */ }
  }
}

/** Returns null when cards are off, the client cannot reach the host, or the call has no parent message. */
export function createRunCardProjector(mode: SubagentCardMode | undefined, client: unknown, options: {
  project: string; directory: string; runId: string; parentSessionId: string; messageId: string | undefined
  log?: (message: string) => void
}): RunCardProjector | null {
  if (mode === "off" || !options.messageId) return null
  const transport = runCardTransport(client, options.directory)
  if (!transport) return null
  try {
    return new RunCardProjector({ transport, project: options.project, runId: options.runId,
      parentSessionId: options.parentSessionId, messageId: options.messageId, log: options.log })
  } catch { return null }
}

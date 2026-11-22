import type { SessionContext } from "@opencode/plugin/promise/session"
import type { DeliveryHistory } from "./delivery.ts"
import { TOOL } from "./host.ts"

export type TurnMode = "passive" | "lookup" | "active"

export type TurnRoute = {
  readonly mode: TurnMode
  readonly promptId?: string
  readonly compactionId?: string
}

export type TurnGuidance = "project" | "restore" | "yield" | "none"

export type TurnGuidanceInput = {
  revision: string | number | readonly number[]
  action: string
  pending: boolean
}

type RouteOptions = { ownerAgent: string; runtimeSha256: string; compacting?: boolean }
type Request = Pick<SessionContext, "sessionID" | "agent">
type Assistant = Extract<DeliveryHistory[number], { type: "assistant" }>
type Cut = { id: string; mode: TurnMode }
type Guidance = {
  revision: string
  cutId?: string
  actions: Map<string, Exclude<TurnGuidance, "none">>
}
type Turn = {
  promptId: string
  cut?: Cut
  pendingCut?: Cut
  guidance?: Guidance
}
type SessionTurn = {
  ownerAgent: string
  runtimeSha256: string
  turn?: Turn
  route?: TurnRoute
}

const passive: TurnRoute = { mode: "passive" }
const maxSessions = 256
const maxActionsPerRevision = 64

function successfulAction(part: Assistant["content"][number], runtimeSha256: string): TurnMode | "synthesis" {
  if (part.type !== "tool" || part.name !== TOOL || part.executed === true ||
      part.state.status !== "completed" || part.time.completed === undefined) return "passive"
  const action = part.state.input.action
  if (!["status", "procedure", "render_report", "create", "record_finding", "set_next_measurement"].some(name => name === action)) {
    return "passive"
  }
  const [result] = part.state.content
  if (part.state.content.length !== 1 || result?.type !== "text") return "passive"
  try {
    const receipt = JSON.parse(result.text)
    if (receipt?.ok !== true || receipt.runtimeSha256 !== runtimeSha256) return "passive"
    if (action === "status" && part.state.input.synthesis && receipt.synthesis) return "synthesis"
    if (action === "status" || action === "procedure" || action === "render_report") return "lookup"
    if (receipt.outcome === "recorded" || (action === "create" && receipt.outcome === undefined)) return "active"
  } catch {
    // Truncated or malformed result data does not convey participation.
  }
  return "passive"
}

export class TurnParticipation {
  private readonly sessions = new Map<string, SessionTurn>()

  /**
   * Call after native owner verification. The assembled prompt is mutable and can contain
   * synthetic user-shaped messages, so only the native window supplies turn and call identity.
   */
  async route(request: Request, history: () => DeliveryHistory | Promise<DeliveryHistory>,
    { ownerAgent, runtimeSha256, compacting = false }: RouteOptions): Promise<TurnRoute> {
    const { sessionID } = request
    if (request.agent !== ownerAgent) {
      this.sessions.delete(sessionID)
      return passive
    }
    const previous = this.sessions.get(sessionID)
    const session: SessionTurn = {
      ownerAgent, runtimeSha256,
      turn: previous?.ownerAgent === ownerAgent && previous.runtimeSha256 === runtimeSha256 ? previous.turn : undefined,
    }
    this.sessions.delete(sessionID)
    this.sessions.set(sessionID, session)
    if (this.sessions.size > maxSessions) {
      const oldest = this.sessions.keys().next()
      if (!oldest.done) this.sessions.delete(oldest.value)
    }
    let window: DeliveryHistory
    try {
      window = await history()
    } catch {
      return passive
    }
    if (this.sessions.get(sessionID) !== session) return passive

    let promptId: string | undefined
    let cutId: string | undefined
    let start = 0
    for (let index = window.length - 1; index >= 0; index--) {
      const row = window[index]!
      if (row.type === "idle") {
        this.sessions.delete(sessionID)
        return passive
      }
      // The SDK stores genuine prompts as User and programmatic notes as Synthetic.
      if (row.type === "user") {
        promptId = row.id
        start = Math.max(index + 1, start)
        break
      }
      if (row.type === "compaction" && row.status === "completed" && cutId === undefined) {
        cutId = row.id
        start = index + 1
      }
    }

    // A retained cut may carry a turn only if this instance bound the same native ID
    // while it had evidence for that turn.
    const prior = session.turn
    const carried = cutId === undefined ? undefined :
      prior?.pendingCut?.id === cutId ? prior.pendingCut :
      prior?.cut?.id === cutId ? prior.cut : undefined
    if (cutId !== undefined && (!carried || (promptId !== undefined && promptId !== prior?.promptId))) {
      this.sessions.delete(sessionID)
      return { mode: "passive", compactionId: cutId }
    }
    promptId ??= carried && prior?.promptId
    if (promptId === undefined) {
      this.sessions.delete(sessionID)
      return passive
    }
    const turn: Turn = prior?.promptId === promptId ? prior : { promptId }
    let mode = carried && turn === prior ? carried.mode : "passive"
    // The newest acknowledged write/create or synthesis determines the mode.
    // Walk backwards so long active turns do not reparse all prior tool results.
    actions: for (let index = window.length - 1; index >= start; index--) {
      const row = window[index]!
      if (row.type !== "assistant" || row.agent !== ownerAgent || row.error) continue
      for (let part = row.content.length - 1; part >= 0; part--) {
        const action = successfulAction(row.content[part]!, runtimeSha256)
        if (action === "synthesis" || action === "active") {
          mode = action === "synthesis" ? "lookup" : "active"
          break actions
        }
        if (action === "lookup" && mode === "passive") mode = "lookup"
      }
    }

    const last = window.at(-1)
    turn.cut = turn === prior ? carried : undefined
    if (compacting && last?.type === "compaction" && last.status === "running") {
      turn.pendingCut = { id: last.id, mode }
    } else {
      turn.pendingCut = undefined
    }
    const result: TurnRoute = { mode, promptId, compactionId: turn.pendingCut?.id ?? cutId }
    session.route = compacting ? undefined : result
    session.turn = turn
    return result
  }

  /**
   * A current revision/action receives one projection. A native cut can restore
   * that pending action once, after which the same work yields until progress.
   */
  decide(sessionID: string, route: TurnRoute, { revision, action, pending }: TurnGuidanceInput): TurnGuidance {
    const session = this.sessions.get(sessionID)
    const turn = session?.turn
    if (!turn || session.route !== route || route.mode !== "active") return "none"

    const revisionKey = JSON.stringify(revision)
    const prior = turn.guidance
    const cutId = turn.cut?.mode === "active" && route.compactionId === turn.cut.id ? turn.cut.id : undefined
    const afterCut = cutId !== undefined && cutId !== prior?.cutId
    const guidance: Guidance = prior?.revision === revisionKey ? prior : { revision: revisionKey, actions: new Map() }
    const previous = guidance.actions.get(action)
    if (previous === undefined && guidance.actions.size >= maxActionsPerRevision) return "yield"
    let decision: Exclude<TurnGuidance, "none">
    if (previous === "restore" || previous === "yield") decision = "yield"
    else if (afterCut && (previous === "project" || prior === undefined)) decision = pending ? "restore" : "yield"
    else decision = previous === "project" ? "yield" : "project"
    guidance.actions.set(action, decision)
    guidance.cutId = cutId
    turn.guidance = guidance
    return decision
  }
}

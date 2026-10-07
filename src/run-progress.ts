import { ALG_AGENTS } from "./types.ts"
import type { AlgAgent, NodeStatus, RunState, RunStatus } from "./types.ts"

export const MAX_LIVE_NODES = 32

export interface AlgNodeProgress {
  id: string
  agent: AlgAgent
  status: NodeStatus
  attempt: number
  retries: number
  session_id?: string
  started_at?: string
  finished_at?: string
}

export interface AlgRunProgress {
  version: 1
  run_id: string
  owner_session_id: string
  revision: number
  status: RunStatus
  mode: "live" | "dry"
  created_at: string
  updated_at: string
  nodes_total: number
  nodes_omitted: number
  counts: Record<NodeStatus, number>
  nodes: AlgNodeProgress[]
}

const NODE_STATUSES: readonly NodeStatus[] = ["pending", "ready", "running", "done", "failed", "skipped"]
const RUN_STATUSES: readonly RunStatus[] = ["planning", "running", "done", "failed", "blocked"]
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional])
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key))
}

function safeText(value: unknown, maximum: number, pattern?: RegExp): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= maximum &&
    !/[\u0000-\u001f\u007f-\u009f]/u.test(value) && (!pattern || pattern.test(value))
}

function safeDate(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64 || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function statusOrPending(value: unknown): NodeStatus {
  return NODE_STATUSES.includes(value as NodeStatus) ? value as NodeStatus : "pending"
}

function latestAttempt(node: RunState["nodes"][string]) {
  return node.attempts.at(-1)
}

function priority(status: NodeStatus): number {
  switch (status) {
    case "running": return 0
    case "ready": return 1
    case "pending": return 2
    default: return 3
  }
}

/** Produce a compact, privacy-limited snapshot suitable for tool metadata. */
export function buildRunProgress(run: RunState): AlgRunProgress {
  const definitions = Array.isArray(run.graph?.nodes) ? run.graph.nodes : []
  const nodeStates = isRecord(run.nodes) ? run.nodes : {}
  const all = definitions.map((definition, index) => {
    const rawId = typeof definition?.id === "string" ? definition.id : ""
    const id = ID.test(rawId) ? rawId : `node-${index + 1}`
    const source = nodeStates[rawId] as RunState["nodes"][string] | undefined
    const storedStatus = statusOrPending(source?.status)
    const ready = storedStatus === "pending" && Array.isArray(definition?.depends_on) &&
      definition.depends_on.every((dependency) => {
        const dependencyState = nodeStates[dependency]
        return isRecord(dependencyState) && dependencyState.status === "done"
      })
    const status = ready ? "ready" : storedStatus
    const attempt = source && Array.isArray(source.attempts) ? latestAttempt(source) : undefined
    const agent = ALG_AGENTS.includes(definition?.agent as AlgAgent) ? definition.agent as AlgAgent : "explorer"
    const currentAttempt = isInteger(source?.current_attempt) ? source.current_attempt : 0
    const row: AlgNodeProgress = {
      id,
      agent,
      status,
      attempt: currentAttempt,
      retries: Math.max(0, currentAttempt - 1),
    }
    if (safeText(attempt?.session_id, 256)) row.session_id = attempt!.session_id
    if (safeDate(attempt?.started_at)) row.started_at = attempt!.started_at
    if (safeDate(attempt?.finished_at)) row.finished_at = attempt!.finished_at
    return { row, order: index }
  })

  const counts = Object.fromEntries(NODE_STATUSES.map((status) => [status, 0])) as Record<NodeStatus, number>
  for (const { row } of all) counts[row.status]++
  const chosen = [...all]
    .sort((left, right) => priority(left.row.status) - priority(right.row.status) || left.order - right.order)
    .slice(0, MAX_LIVE_NODES)
    .map(({ row }) => row)

  const candidate: AlgRunProgress = {
    version: 1,
    run_id: safeText(run.run_id, 64, ID) ? run.run_id : "unknown",
    owner_session_id: safeText(run.owner_session_id, 256) ? run.owner_session_id : "unknown",
    revision: isInteger(run.revision) ? run.revision : 0,
    status: RUN_STATUSES.includes(run.status) ? run.status : "blocked",
    mode: run.mode === "dry" ? "dry" : "live",
    created_at: safeDate(run.created_at) ? run.created_at : new Date(0).toISOString(),
    updated_at: safeDate(run.updated_at) ? run.updated_at : new Date(0).toISOString(),
    nodes_total: all.length,
    nodes_omitted: all.length - chosen.length,
    counts,
    nodes: chosen,
  }
  return parseRunProgress(candidate, candidate.owner_session_id) ?? {
    ...candidate,
    nodes: [],
    nodes_omitted: all.length,
  }
}

/** Validate ownership first, reject unknown fields, and return a fresh safe projection. */
export function parseRunProgress(value: unknown, owner: string): AlgRunProgress | null {
  if (!isRecord(value) || typeof owner !== "string" || value.owner_session_id !== owner) return null
  const topKeys = ["version", "run_id", "owner_session_id", "revision", "status", "mode", "created_at",
    "updated_at", "nodes_total", "nodes_omitted", "counts", "nodes"]
  if (!exactKeys(value, topKeys) || value.version !== 1 || !safeText(value.run_id, 64, ID) ||
    !safeText(value.owner_session_id, 256) || !isInteger(value.revision) ||
    !RUN_STATUSES.includes(value.status as RunStatus) ||
    (value.mode !== "live" && value.mode !== "dry") || !safeDate(value.created_at) ||
    !safeDate(value.updated_at) || !isInteger(value.nodes_total) || !isInteger(value.nodes_omitted) ||
    !Array.isArray(value.nodes) || value.nodes.length > MAX_LIVE_NODES ||
    value.nodes.length + value.nodes_omitted !== value.nodes_total || !isRecord(value.counts)) return null

  const countKeys = [...NODE_STATUSES]
  const rawCounts = value.counts as Record<string, unknown>
  if (!exactKeys(rawCounts, countKeys) || !countKeys.every((status) => isInteger(rawCounts[status]))) return null
  const counts = Object.fromEntries(countKeys.map((status) => [status, rawCounts[status]])) as Record<NodeStatus, number>
  if (Object.values(counts).reduce((sum, count) => sum + count, 0) !== value.nodes_total) return null

  const nodes: AlgNodeProgress[] = []
  const seen = new Set<string>()
  for (const raw of value.nodes) {
    if (!isRecord(raw) || !exactKeys(raw,
      ["id", "agent", "status", "attempt", "retries"], ["session_id", "started_at", "finished_at"]) ||
      !safeText(raw.id, 64, ID) || seen.has(raw.id) || !ALG_AGENTS.includes(raw.agent as AlgAgent) ||
      !NODE_STATUSES.includes(raw.status as NodeStatus) || !isInteger(raw.attempt) || !isInteger(raw.retries) ||
      raw.retries !== Math.max(0, raw.attempt - 1) ||
      (Object.hasOwn(raw, "session_id") && !safeText(raw.session_id, 256)) ||
      (Object.hasOwn(raw, "started_at") && !safeDate(raw.started_at)) ||
      (Object.hasOwn(raw, "finished_at") && !safeDate(raw.finished_at))) return null
    seen.add(raw.id)
    nodes.push({
      id: raw.id,
      agent: raw.agent as AlgAgent,
      status: raw.status as NodeStatus,
      attempt: raw.attempt,
      retries: raw.retries,
      ...(typeof raw.session_id === "string" ? { session_id: raw.session_id } : {}),
      ...(typeof raw.started_at === "string" ? { started_at: raw.started_at } : {}),
      ...(typeof raw.finished_at === "string" ? { finished_at: raw.finished_at } : {}),
    })
  }
  return {
    version: 1,
    run_id: value.run_id,
    owner_session_id: value.owner_session_id,
    revision: value.revision,
    status: value.status as RunStatus,
    mode: value.mode,
    created_at: value.created_at,
    updated_at: value.updated_at,
    nodes_total: value.nodes_total,
    nodes_omitted: value.nodes_omitted,
    counts,
    nodes,
  }
}

/** Agents + Loops + Graphs — durable and runtime contracts. */

export const ALG_AGENTS = [
  "explorer",
  "researcher",
  "implementer",
  "checker",
  "shell",
] as const

export const MODEL_AGENTS = [
  "explorer",
  "researcher",
  "implementer",
  "checker",
] as const

export type AlgAgent = (typeof ALG_AGENTS)[number]
export type ModelAgent = (typeof MODEL_AGENTS)[number]

export type NodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "done"
  | "failed"
  | "skipped"

export type RunStatus = "planning" | "running" | "done" | "failed" | "blocked"
export type GateKind = "schema" | "shell" | "all"

export interface ModelRef {
  providerID: string
  modelID: string
  /** OpenCode model-specific variant/catalog key (for example, reasoning effort). */
  variant?: string
}

export type AgentModelMap = Partial<Record<ModelAgent, ModelRef>>

export interface ProjectModelSettings {
  schema_version: 1
  revision: number
  models: AgentModelMap
  updated_at: string
}

export interface NodeLoop {
  max_attempts: number
  gate: GateKind
}

export interface ShellGateDef {
  cmd: string
  cwd?: string
  timeout_ms?: number
}

export interface NodeDef {
  id: string
  agent: AlgAgent
  depends_on: string[]
  /** Map field → "$goal" | "$criteria" | dependency/path | JSON literal. */
  inputs?: Record<string, string>
  description?: string
  loop?: NodeLoop
  shell_gate?: ShellGateDef
  /** A checker always receives a fresh child session, not the worker session. */
  isolated_check?: boolean
  /** Explicit node to reopen with this checker's failures. */
  feedback_to?: string
}

export interface GraphDef {
  name: string
  description?: string
  nodes: NodeDef[]
  max_global_attempts: number
  max_concurrency: number
}

export interface NodeAttempt {
  attempt: number
  status: NodeStatus
  session_id?: string
  started_at: string
  finished_at?: string
  output?: unknown
  failures: string[]
  score?: number
  shell_ok?: boolean
  schema_ok?: boolean
  error?: string
  feedback_applied?: boolean
}

export interface NodeState {
  id: string
  agent: AlgAgent
  status: NodeStatus
  attempts: NodeAttempt[]
  current_attempt: number
  output?: unknown
  last_failures: string[]
}

export interface OwnerTransfer {
  from_session_id: string
  to_session_id: string
  by_session_id: string
  transferred_at: string
}

export interface RunLockRecord {
  version: 1
  token: string
  holder: string
  project_directory: string
  run_id: string
  acquired_at: string
  expires_at: string
}

export interface RunState {
  schema_version: 2
  revision: number
  run_id: string
  owner_session_id: string
  /** Immutable creator/original owner; retained as parent_session_id for schema-v2 compatibility. */
  parent_session_id: string
  owner_transfers: OwnerTransfer[]
  project_directory: string
  goal: string
  criteria: string[]
  criteria_locked: boolean
  graph: GraphDef
  status: RunStatus
  phase: string
  nodes: Record<string, NodeState>
  global_attempts: number
  created_at: string
  updated_at: string
  mode: "live" | "dry"
  model_snapshot: AgentModelMap
  /** SDK child sessions isolate history, not project/system policy or filesystem access. */
  session_isolation: "sdk-child-session"
  summary?: string
}

export const ALG_PLUGIN_ID = "opencode-alg"
export const ALG_SCHEMA_VERSION = 2 as const
export const ALG_MODEL_SETTINGS_VERSION = 1 as const

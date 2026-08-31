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

/** Roles reported in model-resolution snapshots, including non-graph/default roles. */
export const MODEL_ROLES = [
  "planner",
  "explorer",
  "researcher",
  "implementer",
  "checker",
  "repair",
  "default",
] as const

/** Ordered public server registration contract shared by startup and live proof. */
export const ALG_TOOL_IDS = [
  "alg_templates",
  "alg_models",
  "alg_criteria",
  "alg_plan",
  "alg_run",
  "alg_status",
  "alg_resume",
  "alg_artifact",
  "alg_transfer",
  "alg_skill_evolution_status",
  "alg_skill_evolution_audit",
  "alg_skill_evolution_review",
  "alg_skill_evolution_promote",
  "alg_skill_evolution_rollback",
] as const

export function algServerStartupMessage(skillEvolutionEnabled: boolean): string {
  return `alg plugin loaded skill_evolution=${skillEvolutionEnabled ? "enabled" : "disabled"} ` +
    `tools=${ALG_TOOL_IDS.length} ids=${ALG_TOOL_IDS.join(",")}`
}

export type AlgAgent = (typeof ALG_AGENTS)[number]
export type ModelAgent = (typeof MODEL_AGENTS)[number]
export type ModelRole = (typeof MODEL_ROLES)[number]

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

export type ModelResolutionSource =
  | "alg-project-override"
  | "opencode-role-config"
  | "opencode-top-level-default"
  | "inherited-sdk-default"
  | "legacy-unknown"

export interface ModelResolution {
  source: ModelResolutionSource
  providerID?: string
  modelID?: string
  variant?: string
}

export type ModelResolutionMap = Record<ModelRole, ModelResolution>

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

/** Integrity-bound reference to a run-contained JSON sidecar. */
export interface RunDataReference {
  artifact_path: string
  sha256: string
  byte_size: number
}

/** Ref-independent commitment to one canonical, complete failure array. */
export interface FailureListCommitment {
  algorithm: "sha256"
  sha256: string
  entry_count: number
}

export type AttemptOutcome =
  | "passed"
  | "schema_invalid"
  | "sdk_error"
  | "substantive_rejection"
  | "incomplete"
  | "gate_failure"

/** Exact outcome distribution for a validated archived attempt prefix. */
export interface AttemptOutcomeCounts {
  passed: number
  schema_invalid: number
  sdk_error: number
  substantive_rejection: number
  incomplete: number
  gate_failure: number
  legacy_unknown: number
}

export interface AttemptHistoryReference extends RunDataReference {
  attempt_count: number
  output_count: number
  /** Exact archived child-session count; absent on compatible legacy references. */
  session_count?: number
  failure_entries_omitted: number
  failure_texts_truncated: number
  error_bytes_omitted: number
  /** Exact committed-attempt count; absent on compatible legacy archives. */
  failure_commitment_count?: number
  /** Exact archived outcome distribution; absent on compatible legacy references. */
  outcome_counts?: AttemptOutcomeCounts
  /** Exact archived feedback-routing count; absent on compatible legacy references. */
  feedback_applied_count?: number
}

export interface FilesystemRootAuthorizationCounts {
  plan: number
  run: number
  resume: number
}

/** Integrity-bound complete authorization history used when progress keeps only a tail. */
export interface FilesystemRootAuthorizationReference extends RunDataReference {
  authorization_count: number
  operation_counts: FilesystemRootAuthorizationCounts
}

export interface NodeAttempt {
  attempt: number
  status: NodeStatus
  session_id?: string
  started_at: string
  finished_at?: string
  output?: unknown
  /** Complete typed output is externalized here in projected progress state. */
  output_ref?: RunDataReference
  /** Complete pre-projection attempt record (including diagnostics) is externalized here. */
  detail_ref?: RunDataReference
  failures: string[]
  /** Commitment to the complete list, independent of mutable detail_ref identity. */
  failures_commitment?: FailureListCommitment
  failures_omitted?: number
  failure_texts_truncated?: number
  score?: number
  shell_ok?: boolean
  schema_ok?: boolean
  error?: string
  error_bytes_omitted?: number
  feedback_applied?: boolean
  /** Classified routing result; optional for persisted schema-v2 compatibility. */
  outcome?: AttemptOutcome
}

export interface NodeState {
  id: string
  agent: AlgAgent
  status: NodeStatus
  attempts: NodeAttempt[]
  /** Archived prefix of attempt metadata; absent on legacy and hydrated runtime state. */
  attempt_history_ref?: AttemptHistoryReference
  current_attempt: number
  output?: unknown
  /** Complete latest typed output; optional so legacy inline states still load. */
  output_ref?: RunDataReference
  last_failures: string[]
  /** Commitment to the complete list, independent of mutable last_failures_ref identity. */
  last_failures_commitment?: FailureListCommitment
  /** Complete unprojected current failure aggregate. */
  last_failures_ref?: RunDataReference
  last_failures_omitted?: number
  last_failure_texts_truncated?: number
}

export interface StateProjectionMetadata {
  outputs_externalized: number
  attempts_archived: number
  failure_entries_omitted: number
  failure_texts_truncated: number
  error_bytes_omitted: number
  root_authorizations_omitted: number
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

export interface FilesystemRootAuthorization {
  operation: "plan" | "run" | "resume"
  by_session_id: string
  authorized_at: string
  /** Present on newly written entries; absent on compatible legacy entries. */
  authorized?: true
  /** Canonical audited root path; absent on compatible legacy entries. */
  path?: string
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
  /** Effective role/default model provenance; absent on legacy schema-v2 runs. */
  model_resolution?: ModelResolutionMap
  /** Explicit per-call filesystem-root approvals; absent on legacy/non-root runs. */
  filesystem_root_authorizations?: FilesystemRootAuthorization[]
  /** Complete immutable history when the inline authorization list is projected. */
  filesystem_root_authorizations_ref?: FilesystemRootAuthorizationReference
  filesystem_root_authorizations_omitted?: number
  /** SDK child sessions isolate history, not project/system policy or filesystem access. */
  session_isolation: "sdk-child-session"
  summary?: string
  /** Truthful aggregate metadata for bounded progress-state projection. */
  state_projection?: StateProjectionMetadata
}

export const ALG_PLUGIN_ID = "opencode-alg"
export const ALG_SCHEMA_VERSION = 2 as const
export const ALG_MODEL_SETTINGS_VERSION = 1 as const

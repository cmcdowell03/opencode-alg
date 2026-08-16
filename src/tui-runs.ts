import type { TuiDialogSelectOption, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import { formatSdkError, safeDiagnosticText } from "./diagnostics.ts"
import {
  AGENT_OUTPUT_BYTE_LIMITS,
  MAX_ATTEMPT_HISTORY_BYTES,
  MAX_PROJECTED_ATTEMPT_FAILURES,
  MAX_PROJECTED_ERROR_BYTES,
  MAX_PROJECTED_FAILURE_BYTES,
  MAX_STATE_BYTES,
  serializedBytes,
  truncateUtf8,
  utf8Bytes,
} from "./limits.ts"
import {
  attemptOutcomeCounts,
  canonicalJson,
  failureListCommitment,
  isFullShaImmutableReference,
  sha256Json,
} from "./persistence.ts"
import {
  AlgAgentSchema,
  parseCanonicalAgentOutput,
  parseGraph,
  parsePersistedAttemptDetail,
  parsePersistedNodeAttempt,
  schemaForAgent,
} from "./schemas.ts"
import type { AttemptOutcomeCounts, GraphDef, NodeAttempt, RunDataReference } from "./types.ts"
import {
  MAX_OWNER_INDEX_BYTES,
  MAX_OWNER_INDEX_ENTRIES,
  OWNER_INDEX_DIRECTORY,
  ownerIndexRelativePath,
  parseOwnerRunIndex,
} from "./owner-index.ts"
import { isSafeProjectRelativePath } from "./paths.ts"

const MAX_RECENT_RUNS = 20
const MAX_READ_CONCURRENCY = 8
const MAX_PROGRESS_BYTES = 5 * 1024 * 1024
const MAX_LEGACY_FALLBACK_READS = MAX_OWNER_INDEX_ENTRIES
const MAX_LEGACY_DATED_RESULTS = 16
const MAX_LEGACY_GENERIC_RESULTS = MAX_LEGACY_FALLBACK_READS - (2 * MAX_LEGACY_DATED_RESULTS)
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MISSING_INDEX_NOTICE = `Owner run index is missing; using bounded legacy discovery capped at ${MAX_LEGACY_FALLBACK_READS} candidate progress files.`
export const MAX_TUI_NODE_OPTIONS = 64
export const MAX_TUI_ATTEMPT_OPTIONS = 100
export const MAX_TUI_ARCHIVED_ATTEMPT_PAGE_SIZE = 32
export const MAX_TUI_TITLE_BYTES = 512
export const MAX_TUI_DESCRIPTION_BYTES = 768
export const MAX_TUI_ID_PREVIEW_BYTES = 96
export const MAX_TUI_TOAST_TITLE_BYTES = 128
export const MAX_TUI_TOAST_MESSAGE_BYTES = 1_024
export const MAX_TUI_SERIALIZED_DIALOG_BYTES = 256 * 1024
const MAX_TUI_MODEL_ENTRIES = 16
const MAX_SDK_SESSION_ID_BYTES = 256

interface TuiTruncation {
  fields: number
  nodes_omitted: number
  attempts_omitted: number
  graph_nodes_omitted: number
  model_entries_omitted: number
}

interface TuiAttempt {
  attempt: number
  status: string
  session_id?: string
  navigation_session_id?: string
  /** Retained outside dialog values for strict click-time validation. */
  persisted_attempt?: unknown
  authoritative_projection?: true
  legacy_reference_integrity?: true
}

interface TuiNode {
  id: string
  agent: string
  status: string
  attempts: TuiAttempt[]
  attempts_total: number
  attempts_archived: number
  attempts_visible: number
  attempt_history_ref?: TuiAttemptHistoryReference
  requires_shell: boolean
}

interface TuiAttemptHistoryReference {
  artifact_path: string
  sha256: string
  byte_size: number
  attempt_count: number
  output_count: number
  session_count?: number
  failure_entries_omitted: number
  failure_texts_truncated: number
  error_bytes_omitted: number
  failure_commitment_count?: number
  outcome_counts?: AttemptOutcomeCounts
  feedback_applied_count?: number
  legacy_fixed_path?: true
}

interface TuiRun {
  run_id: string
  owner_session_id: string
  status: string
  mode?: "live" | "dry"
  updated_at: string
  nodes: Record<string, TuiNode>
  graph: GraphDef
  model_snapshot?: Record<string, { providerID?: string; modelID?: string; variant?: string }>
  model_resolution?: Record<string, { source?: string; providerID?: string; modelID?: string; variant?: string }>
  nodes_total: number
  truncation: TuiTruncation
}

interface ValidatedOutput {
  value: unknown
  byte_size: number
  sha256?: string
  legacy_fixed_path: boolean
  kind: "output" | "detail"
}

type OutputValidationCache = Map<string, Promise<ValidatedOutput>>
const legacyIntegrityWarnings = new WeakMap<OutputValidationCache, Set<string>>()

function bounded(value: string, maximum: number): string {
  if (utf8Bytes(value) <= maximum) return value
  const suffix = "…"
  return `${truncateUtf8(value, maximum - utf8Bytes(suffix))}${suffix}`
}

function title(value: string): string {
  return bounded(value, MAX_TUI_TITLE_BYTES)
}

function description(value: string): string {
  return bounded(value, MAX_TUI_DESCRIPTION_BYTES)
}

function idPreview(value: string): string {
  return bounded(value, MAX_TUI_ID_PREVIEW_BYTES)
}

function toast(api: TuiPluginApi, variant: "info" | "warning" | "error", title: string, message: string): void {
  api.ui.toast({
    variant,
    title: bounded(title, MAX_TUI_TOAST_TITLE_BYTES),
    message: bounded(message, MAX_TUI_TOAST_MESSAGE_BYTES),
    duration: 8_000,
  })
}

function currentParentSession(api: TuiPluginApi): string | null {
  const route = api.route.current
  return route.name === "session" && typeof route.params?.sessionID === "string"
    ? route.params.sessionID
    : null
}

function projectDirectory(api: TuiPluginApi): string {
  return api.state.path.worktree || api.state.path.directory
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function previewField(value: string, maximum: number, truncation: TuiTruncation): string {
  const preview = bounded(value, maximum)
  if (preview !== value) truncation.fields++
  return preview
}

function parseModelMap(
  value: unknown,
  truncation: TuiTruncation,
): TuiRun["model_snapshot"] {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new Error("invalid model metadata")
  const result = Object.create(null) as NonNullable<TuiRun["model_snapshot"]>
  let entries = 0
  for (const role in value) {
    if (!Object.hasOwn(value, role)) continue
    entries++
    if (entries > MAX_TUI_MODEL_ENTRIES) continue
    const model = value[role]
    if (!isRecord(model) ||
      (model.providerID !== undefined && typeof model.providerID !== "string") ||
      (model.modelID !== undefined && typeof model.modelID !== "string") ||
      (model.variant !== undefined && typeof model.variant !== "string") ||
      (model.source !== undefined && typeof model.source !== "string")) {
      throw new Error("invalid model metadata")
    }
    const safeRole = previewField(role, MAX_TUI_ID_PREVIEW_BYTES, truncation)
    result[safeRole] = {
      ...(typeof model.providerID === "string"
        ? { providerID: previewField(model.providerID, MAX_TUI_ID_PREVIEW_BYTES, truncation) }
        : {}),
      ...(typeof model.modelID === "string"
        ? { modelID: previewField(model.modelID, MAX_TUI_ID_PREVIEW_BYTES, truncation) }
        : {}),
      ...(typeof model.variant === "string"
        ? { variant: previewField(model.variant, MAX_TUI_ID_PREVIEW_BYTES, truncation) }
        : {}),
      ...(typeof model.source === "string"
        ? { source: previewField(model.source, MAX_TUI_ID_PREVIEW_BYTES, truncation) }
        : {}),
    }
  }
  truncation.model_entries_omitted += Math.max(0, entries - MAX_TUI_MODEL_ENTRIES)
  return result
}

function parseAttemptHistoryReference(
  value: unknown,
  runId: string,
  nodeId: string,
): TuiAttemptHistoryReference | undefined {
  if (value === undefined) return undefined
  const allowedKeys = new Set([
    "artifact_path", "sha256", "byte_size", "attempt_count", "output_count", "session_count",
    "failure_entries_omitted", "failure_texts_truncated", "error_bytes_omitted",
    "failure_commitment_count", "outcome_counts", "feedback_applied_count",
  ])
  if (!isRecord(value) || Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    typeof value.artifact_path !== "string" ||
    typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !Number.isInteger(value.byte_size) || (value.byte_size as number) < 0 ||
    (value.byte_size as number) > MAX_ATTEMPT_HISTORY_BYTES ||
    !Number.isInteger(value.attempt_count) || (value.attempt_count as number) < 1 ||
    (value.attempt_count as number) > MAX_TUI_ATTEMPT_OPTIONS ||
    !Number.isInteger(value.output_count) || (value.output_count as number) < 0 ||
    (value.output_count as number) > (value.attempt_count as number) ||
    !Number.isInteger(value.failure_entries_omitted) || (value.failure_entries_omitted as number) < 0 ||
    !Number.isInteger(value.failure_texts_truncated) || (value.failure_texts_truncated as number) < 0 ||
    !Number.isInteger(value.error_bytes_omitted) || (value.error_bytes_omitted as number) < 0 ||
    (value.session_count !== undefined &&
      (!Number.isInteger(value.session_count) || (value.session_count as number) < 0 ||
        (value.session_count as number) > (value.attempt_count as number))) ||
    (value.failure_commitment_count !== undefined &&
      (!Number.isInteger(value.failure_commitment_count) || (value.failure_commitment_count as number) < 0 ||
        (value.failure_commitment_count as number) > (value.attempt_count as number))) ||
    (value.feedback_applied_count !== undefined &&
      (!Number.isInteger(value.feedback_applied_count) || (value.feedback_applied_count as number) < 0 ||
        (value.feedback_applied_count as number) > (value.attempt_count as number))) ||
    (value.outcome_counts !== undefined && !validOutcomeCounts(value.outcome_counts, value.attempt_count as number))) {
    throw new Error(`Run ${runId} progress has invalid attempt history metadata for node ${nodeId}`)
  }
  const base = `.opencode/runs/${runId}/history/${nodeId}-attempts`
  const legacyFixedPath = `${base}.json`
  const immutablePath = `${base}-${value.sha256}.json`
  if (!isSafeProjectRelativePath(value.artifact_path) ||
    (value.artifact_path !== legacyFixedPath && value.artifact_path !== immutablePath)) {
    throw new Error(`Run ${runId} progress has mismatched attempt history kind/path for node ${nodeId}`)
  }
  return {
    artifact_path: value.artifact_path,
    sha256: value.sha256,
    byte_size: value.byte_size as number,
    attempt_count: value.attempt_count as number,
    output_count: value.output_count as number,
    ...(typeof value.session_count === "number" ? { session_count: value.session_count } : {}),
    failure_entries_omitted: value.failure_entries_omitted as number,
    failure_texts_truncated: value.failure_texts_truncated as number,
    error_bytes_omitted: value.error_bytes_omitted as number,
    ...(typeof value.failure_commitment_count === "number"
      ? { failure_commitment_count: value.failure_commitment_count }
      : {}),
    ...(value.outcome_counts !== undefined
      ? { outcome_counts: value.outcome_counts as unknown as AttemptOutcomeCounts }
      : {}),
    ...(typeof value.feedback_applied_count === "number"
      ? { feedback_applied_count: value.feedback_applied_count }
      : {}),
    ...(value.artifact_path === legacyFixedPath ? { legacy_fixed_path: true as const } : {}),
  }
}

function validOutcomeCounts(value: unknown, attemptCount: number): value is AttemptOutcomeCounts {
  if (!isRecord(value)) return false
  const keys = [
    "passed", "schema_invalid", "sdk_error", "substantive_rejection", "incomplete", "gate_failure",
    "legacy_unknown",
  ] as const
  if (Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key as typeof keys[number]))) {
    return false
  }
  let total = 0
  for (const key of keys) {
    const count = value[key]
    if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > attemptCount) return false
    total += count as number
  }
  return total === attemptCount
}

function parseStrictGraph(value: unknown, runId: string, truncation: TuiTruncation): GraphDef {
  try {
    const graph = parseGraph(value)
    truncation.graph_nodes_omitted = Math.max(0, graph.nodes.length - MAX_TUI_NODE_OPTIONS)
    return graph
  } catch (error) {
    throw new Error(`Run ${runId} progress has invalid strict graph metadata: ${formatSdkError(error)}`)
  }
}

function parseOwnedRun(value: unknown, owner: string, directoryRunId: string): TuiRun | null {
  if (!isRecord(value)) throw new Error(`Run ${directoryRunId} progress is not an object`)
  // Ownership is the first discriminator: malformed data belonging to another
  // parent is neither displayed nor diagnosed to the current parent.
  if (typeof value.owner_session_id === "string" && value.owner_session_id !== owner) return null

  const validIdentity = value.owner_session_id === owner && value.run_id === directoryRunId &&
    typeof value.run_id === "string" && SAFE_ID.test(value.run_id) &&
    typeof value.status === "string" && value.status.length > 0 &&
    typeof value.updated_at === "string" && value.updated_at.length <= 128 && Number.isFinite(Date.parse(value.updated_at))
  if (!validIdentity || !isRecord(value.nodes)) {
    throw new Error(`Run ${directoryRunId} progress has invalid identity, ownership, status, timestamp, or nodes`)
  }

  const truncation: TuiTruncation = {
    fields: 0,
    nodes_omitted: 0,
    attempts_omitted: 0,
    graph_nodes_omitted: 0,
    model_entries_omitted: 0,
  }
  const graph = parseStrictGraph(value.graph, directoryRunId, truncation)
  const graphById = new Map(graph.nodes.map((definition) => [definition.id, definition]))
  const stateIds = Object.keys(value.nodes)
  if (stateIds.length !== graphById.size || stateIds.some((id) => !graphById.has(id)) ||
    graph.nodes.some((definition) => !Object.hasOwn(value.nodes as object, definition.id))) {
    throw new Error(`Run ${directoryRunId} progress graph/node identities do not match exactly`)
  }
  const nodes = Object.create(null) as Record<string, TuiNode>
  let nodeCount = 0
  for (const nodeId in value.nodes) {
    if (!Object.hasOwn(value.nodes, nodeId)) continue
    nodeCount++
    const node = value.nodes[nodeId]
    const definition = graphById.get(nodeId)
    if (!SAFE_ID.test(nodeId) || !isRecord(node) || node.id !== nodeId ||
      !definition || node.agent !== definition.agent ||
      typeof node.agent !== "string" || typeof node.status !== "string" || !Array.isArray(node.attempts)) {
      throw new Error(`Run ${directoryRunId} progress has an invalid node ${nodeId}`)
    }
    const attemptHistoryReference = parseAttemptHistoryReference(
      node.attempt_history_ref,
      directoryRunId,
      nodeId,
    )
    const archivedAttempts = attemptHistoryReference?.attempt_count ?? 0
    const currentAttempt = node.current_attempt === undefined && !attemptHistoryReference
      ? node.attempts.length
      : node.current_attempt
    if (!Number.isInteger(currentAttempt) || (currentAttempt as number) < 0 ||
      currentAttempt !== archivedAttempts + node.attempts.length) {
      throw new Error(`Run ${directoryRunId} progress has inconsistent attempt counts for node ${nodeId}`)
    }
    const attempts: TuiAttempt[] = []
    truncation.attempts_omitted += Math.max(0, node.attempts.length - MAX_TUI_ATTEMPT_OPTIONS)
    for (const [index, attempt] of node.attempts.entries()) {
      let parsed: NodeAttempt
      try {
        parsed = parsePersistedNodeAttempt(attempt, {
          agent: definition.agent,
          run_id: directoryRunId,
          node_id: nodeId,
          expected_attempt: archivedAttempts + index + 1,
          mode: value.mode === "live" || value.mode === "dry" ? value.mode : undefined,
          requires_shell: definition.agent === "shell" || definition.loop?.gate === "shell" ||
            definition.loop?.gate === "all",
        })
      } catch (error) {
        throw new Error(
          `Run ${directoryRunId} progress has an invalid persisted attempt in node ${nodeId}: ${formatSdkError(error)}`,
        )
      }
      const rawSession = parsed.session_id
      const navigationSession = rawSession && rawSession === rawSession.trim() &&
          rawSession.length <= MAX_SDK_SESSION_ID_BYTES && utf8Bytes(rawSession) <= MAX_SDK_SESSION_ID_BYTES
        ? rawSession
        : undefined
      if (index >= MAX_TUI_ATTEMPT_OPTIONS) continue
      attempts.push({
        attempt: parsed.attempt,
        status: previewField(parsed.status, MAX_TUI_ID_PREVIEW_BYTES, truncation),
        ...(rawSession
          ? { session_id: previewField(rawSession, MAX_TUI_ID_PREVIEW_BYTES, truncation) }
          : {}),
        ...(navigationSession ? { navigation_session_id: navigationSession } : {}),
        persisted_attempt: parsed,
        authoritative_projection: true,
      })
    }
    if (nodeCount > MAX_TUI_NODE_OPTIONS) continue
    nodes[nodeId] = {
      id: nodeId,
      agent: previewField(node.agent, MAX_TUI_ID_PREVIEW_BYTES, truncation),
      status: previewField(node.status, MAX_TUI_ID_PREVIEW_BYTES, truncation),
      attempts,
      attempts_total: currentAttempt as number,
      attempts_archived: archivedAttempts,
      attempts_visible: node.attempts.length,
      requires_shell: definition.agent === "shell" || definition.loop?.gate === "shell" ||
        definition.loop?.gate === "all",
      ...(attemptHistoryReference ? { attempt_history_ref: attemptHistoryReference } : {}),
    }
  }
  truncation.nodes_omitted = Math.max(0, nodeCount - MAX_TUI_NODE_OPTIONS)

  let modelSnapshot: TuiRun["model_snapshot"]
  let modelResolution: TuiRun["model_resolution"]
  try {
    modelSnapshot = parseModelMap(value.model_snapshot, truncation)
    modelResolution = parseModelMap(value.model_resolution, truncation)
  } catch {
    throw new Error(`Run ${directoryRunId} progress has invalid model metadata`)
  }
  return {
    run_id: directoryRunId,
    owner_session_id: owner,
    status: previewField(value.status as string, MAX_TUI_ID_PREVIEW_BYTES, truncation),
    ...(value.mode === "live" || value.mode === "dry" ? { mode: value.mode } : {}),
    updated_at: previewField(value.updated_at as string, MAX_TUI_ID_PREVIEW_BYTES, truncation),
    nodes,
    nodes_total: nodeCount,
    truncation,
    graph,
    ...(modelSnapshot ? { model_snapshot: modelSnapshot } : {}),
    ...(modelResolution ? { model_resolution: modelResolution } : {}),
  }
}

async function readProgress(api: TuiPluginApi, owner: string, runId: string): Promise<TuiRun | null> {
  const response = await api.client.file.read({
    directory: projectDirectory(api),
    path: `.opencode/runs/${runId}/progress.json`,
  })
  if (response.error) throw new Error(`Could not read run ${runId}: ${formatSdkError(response.error)}`)
  if (response.data?.type !== "text" || typeof response.data.content !== "string") {
    throw new Error(`Run ${runId} progress is not readable text`)
  }
  const content = response.data.content
  if (new TextEncoder().encode(content).byteLength > MAX_PROGRESS_BYTES) {
    throw new Error(`Run ${runId} progress exceeds the bounded TUI read limit`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    throw new Error(`Run ${runId} progress is not valid JSON`)
  }
  return parseOwnedRun(parsed, owner, runId)
}

function sdkStatus(error: unknown, depth = 0): number | undefined {
  if (!isRecord(error) || depth > 4) return undefined
  for (const key of ["status", "statusCode"]) {
    const value = error[key]
    if (typeof value === "number") return value
  }
  for (const key of ["response", "cause", "error"]) {
    const found = sdkStatus(error[key], depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function sdkResultDiagnostic(response: { error?: unknown; response?: { status?: number } }): string {
  return formatSdkError({
    error: response.error,
    response: { status: response.response?.status },
  })
}

async function indexedRunIds(
  api: TuiPluginApi,
  owner: string,
): Promise<{ ids: string[] | null; issue?: string; notice?: string }> {
  const path = ownerIndexRelativePath(owner)
  let response: Awaited<ReturnType<TuiPluginApi["client"]["file"]["read"]>>
  try {
    response = await api.client.file.read({
      directory: projectDirectory(api),
      path,
    })
  } catch (error) {
    return { ids: null, issue: `Could not read bounded owner run index: ${formatSdkError(error)}` }
  }
  if ("error" in response && response.error) {
    if (sdkStatus(response.error) === 404 || response.response?.status === 404) {
      return { ids: null, notice: MISSING_INDEX_NOTICE }
    }
    return { ids: null, issue: `Could not read bounded owner run index: ${sdkResultDiagnostic(response)}` }
  }
  if (response.data?.type !== "text" || typeof response.data.content !== "string") {
    return { ids: null, issue: "Owner run index is not readable text" }
  }
  if (new TextEncoder().encode(response.data.content).byteLength > MAX_OWNER_INDEX_BYTES) {
    return { ids: null, issue: `Owner run index exceeds ${MAX_OWNER_INDEX_BYTES} bytes` }
  }
  try {
    const index = parseOwnerRunIndex(JSON.parse(response.data.content), owner)
    return { ids: index.runs.map((entry) => entry.run_id) }
  } catch (error) {
    return { ids: null, issue: `Malformed owner run index: ${formatSdkError(error)}` }
  }
}

function utcDatePrefix(daysAgo: number): string {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1_000)
  return date.toISOString().slice(0, 10).replaceAll("-", "")
}

function legacySearches(): Array<{ query: string; limit: number }> {
  return [
    // Standard ALG run IDs contain their UTC creation date. These first two
    // bounded fuzzy queries favor current migrations without claiming that the
    // SDK's relevance ranking is a globally authoritative recency order.
    { query: `.opencode/runs/${utcDatePrefix(0)}/progress.json`, limit: MAX_LEGACY_DATED_RESULTS },
    { query: `.opencode/runs/${utcDatePrefix(1)}/progress.json`, limit: MAX_LEGACY_DATED_RESULTS },
    { query: ".opencode/runs/progress.json", limit: MAX_LEGACY_GENERIC_RESULTS },
  ]
}

function legacyRunId(path: unknown): string | null {
  if (typeof path !== "string") return null
  const normalized = path.replaceAll("\\", "/")
  const match = /^\.opencode\/runs\/([^/]+)\/progress\.json$/.exec(normalized)
  const runId = match?.[1]
  if (!runId || runId === OWNER_INDEX_DIRECTORY || !SAFE_ID.test(runId)) return null
  return runId
}

async function legacyFallbackRunIds(api: TuiPluginApi): Promise<string[]> {
  const selected: string[] = []
  const seen = new Set<string>()
  for (const search of legacySearches()) {
    const response = await api.client.find.files({
      directory: projectDirectory(api),
      query: search.query,
      type: "file",
      limit: search.limit,
    })
    if (response.error) {
      throw new Error(`Could not find ALG progress files for bounded legacy fallback: ${formatSdkError(response.error)}`)
    }
    if (!Array.isArray(response.data)) throw new Error("Bounded legacy fallback returned an invalid file result")
    // Enforce the advertised response bound locally as well, even against a
    // malformed/mocked server, and retain only exact project-relative paths.
    for (const path of response.data.slice(0, search.limit)) {
      const runId = legacyRunId(path)
      if (!runId || seen.has(runId)) continue
      seen.add(runId)
      selected.push(runId)
      if (selected.length >= MAX_LEGACY_FALLBACK_READS) return selected
    }
  }
  return selected
}

export async function recentOwnedRuns(api: TuiPluginApi, owner: string): Promise<TuiRun[]> {
  const index = await indexedRunIds(api, owner)
  let ids: string[]
  try {
    ids = index.ids ?? await legacyFallbackRunIds(api)
  } catch (error) {
    const prefix = index.issue ? `${index.issue}; ` : ""
    throw new Error(`${prefix}${error instanceof Error ? error.message : formatSdkError(error)}`)
  }
  const issues = [index.notice, index.issue].filter((issue): issue is string => Boolean(issue))
  const settled: PromiseSettledResult<TuiRun | null>[] = []
  // The durable projection and legacy fallback each cap ids before any progress
  // reads; fixed batches independently cap SDK request fan-out.
  for (let offset = 0; offset < ids.length; offset += MAX_READ_CONCURRENCY) {
    settled.push(...await Promise.allSettled(
      ids.slice(offset, offset + MAX_READ_CONCURRENCY).map((id) => readProgress(api, owner, id)),
    ))
  }
  const failed = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected")
  if (failed.length) issues.push(...failed.slice(0, 3).map((result) => formatSdkError(result.reason)))
  const runs = settled.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [])
  if (!runs.length && failed.length && !index.issue) throw failed[0]!.reason
  const fieldTruncations = runs.reduce((sum, run) => sum + run.truncation.fields, 0)
  const nodesOmitted = runs.reduce((sum, run) => sum + run.truncation.nodes_omitted, 0)
  const attemptsOmitted = runs.reduce((sum, run) => sum + run.truncation.attempts_omitted, 0)
  const graphNodesOmitted = runs.reduce((sum, run) => sum + run.truncation.graph_nodes_omitted, 0)
  const modelEntriesOmitted = runs.reduce((sum, run) => sum + run.truncation.model_entries_omitted, 0)
  if (fieldTruncations || nodesOmitted || attemptsOmitted || graphNodesOmitted || modelEntriesOmitted) {
    issues.push(
      `Bounded ALG previews truncated ${fieldTruncations} rendered fields and omitted ` +
      `${nodesOmitted} nodes, ${attemptsOmitted} attempts, ${graphNodesOmitted} graph entries, ` +
      `and ${modelEntriesOmitted} model entries.`,
    )
  }
  if (issues.length) {
    toast(
      api,
      "warning",
      index.notice ? "Using bounded legacy ALG discovery" : "Some ALG runs unavailable",
      issues.join("; "),
    )
  }
  return runs
    .sort((left, right) => Date.parse(right.updated_at) - Date.parse(left.updated_at) || left.run_id.localeCompare(right.run_id))
    .slice(0, MAX_RECENT_RUNS)
}

function archiveSession(value: unknown, runId: string, nodeId: string, attempt: number): {
  session_id?: string
  navigation_session_id?: string
} {
  if (value === undefined) return {}
  if (typeof value !== "string" || !value) {
    throw new Error(`Archived attempt ${runId}/${nodeId}/${attempt} has an invalid child session`)
  }
  const navigable = value === value.trim() && value.length <= MAX_SDK_SESSION_ID_BYTES &&
    utf8Bytes(value) <= MAX_SDK_SESSION_ID_BYTES
  return {
    session_id: bounded(value, MAX_TUI_ID_PREVIEW_BYTES),
    ...(navigable ? { navigation_session_id: value } : {}),
  }
}

function nestedAttemptReferenceKind(
  reference: RunDataReference,
  runId: string,
  nodeId: string,
  attempt: number,
  kind: "output" | "detail",
  allowLegacyFixed: boolean,
): { legacy_fixed_path: boolean; expected_path: string } {
  const directory = kind === "output" ? "artifacts" : "history"
  const suffix = kind === "output" ? `-output-${reference.sha256}` : `-detail-${reference.sha256}`
  const base = `.opencode/runs/${runId}/${directory}/${nodeId}-attempt-${attempt}`
  const fixedPath = `${base}.json`
  const immutablePath = `${base}${suffix}.json`
  if (!isSafeProjectRelativePath(reference.artifact_path)) {
    throw new Error(`Archived attempt ${runId}/${nodeId}/${attempt} ${kind} reference is not project-relative`)
  }
  if (reference.artifact_path === immutablePath && isFullShaImmutableReference(reference)) {
    return { legacy_fixed_path: false, expected_path: immutablePath }
  }
  if (allowLegacyFixed && reference.artifact_path === fixedPath) {
    return { legacy_fixed_path: true, expected_path: fixedPath }
  }
  throw new Error(
    `Archived attempt ${runId}/${nodeId}/${attempt} ${kind} reference has invalid contained run/node/attempt/kind path`,
  )
}

/** Match the store's finite allowance for formatted fixed-path JSON. */
function legacyReferenceReadLimit(logicalBytes: number): number {
  return Math.min(MAX_STATE_BYTES, Math.max(logicalBytes * 2 + 8_192, 16_384))
}

function parseArchivedAttemptForNode(
  value: unknown,
  run: TuiRun,
  node: TuiNode,
  expected: number,
  allowLegacyFixedNestedReferences: boolean,
): TuiAttempt {
  const label = `${run.run_id}/${node.id}/${expected}`
  let parsed
  try {
    parsed = parsePersistedNodeAttempt(value, {
      agent: node.agent,
      run_id: run.run_id,
      node_id: node.id,
      expected_attempt: expected,
      mode: run.mode,
      requires_shell: node.requires_shell,
    })
  } catch (error) {
    throw new Error(`Archived attempt ${label} violates the authoritative attempt schema: ${formatSdkError(error)}`)
  }
  if (parsed.status === "running") {
    throw new Error(`Archived attempt ${label} violates the authoritative attempt schema: archived prefixes cannot contain a running attempt`)
  }
  const runId = run.run_id
  const nodeId = node.id
  const outputKind = parsed.output_ref
    ? nestedAttemptReferenceKind(
        parsed.output_ref,
        runId,
        nodeId,
        expected,
        "output",
        allowLegacyFixedNestedReferences,
      )
    : undefined
  const detailKind = parsed.detail_ref
    ? nestedAttemptReferenceKind(
        parsed.detail_ref,
        runId,
        nodeId,
        expected,
        "detail",
        allowLegacyFixedNestedReferences,
      )
    : undefined
  const session = archiveSession(parsed.session_id, runId, nodeId, expected)
  return {
    attempt: expected,
    status: bounded(parsed.status, MAX_TUI_ID_PREVIEW_BYTES),
    ...session,
    persisted_attempt: parsed,
    authoritative_projection: true,
    ...(outputKind?.legacy_fixed_path || detailKind?.legacy_fixed_path
      ? { legacy_reference_integrity: true as const }
      : {}),
  }
}

async function readArchivedAttempts(api: TuiPluginApi, run: TuiRun, node: TuiNode): Promise<{
  attempts: TuiAttempt[]
  legacy_weaker_integrity: boolean
}> {
  const reference = node.attempt_history_ref
  if (!reference) return { attempts: [], legacy_weaker_integrity: false }
  const immutablePath = `.opencode/runs/${run.run_id}/history/${node.id}-attempts-${reference.sha256}.json`
  const legacyPath = `.opencode/runs/${run.run_id}/history/${node.id}-attempts.json`
  const legacy = reference.legacy_fixed_path === true
  const expectedPath = legacy ? legacyPath : immutablePath
  if (!isSafeProjectRelativePath(reference.artifact_path) || reference.artifact_path !== expectedPath) {
    throw new Error(`Archived attempts for ${run.run_id}/${node.id} have an invalid contained run/node/kind path`)
  }
  const response = await api.client.file.read({
    directory: projectDirectory(api),
    path: reference.artifact_path,
  })
  if (response.error) {
    throw new Error(`Could not read archived attempts for ${run.run_id}/${node.id}: ${formatSdkError(response.error)}`)
  }
  if (response.data?.type !== "text" || typeof response.data.content !== "string") {
    throw new Error(`Archived attempts for ${run.run_id}/${node.id} are not readable text`)
  }
  const content = response.data.content
  const rawBytes = utf8Bytes(content)
  const rawReadLimit = legacy ? legacyReferenceReadLimit(reference.byte_size) : reference.byte_size
  if (rawBytes > rawReadLimit) {
    throw new Error(`Archived attempts for ${run.run_id}/${node.id} exceed the bounded read limit`)
  }
  if (!legacy && rawBytes !== reference.byte_size) {
    throw new Error(`Archived attempts for ${run.run_id}/${node.id} have an immutable raw-size mismatch`)
  }
  let value: unknown
  try {
    value = JSON.parse(content)
  } catch {
    throw new Error(`Archived attempts for ${run.run_id}/${node.id} are not valid JSON`)
  }
  const canonicalBytes = serializedBytes(value)
  if (canonicalBytes !== reference.byte_size) {
    throw new Error(`Archived attempts for ${run.run_id}/${node.id} failed logical-size integrity validation`)
  }
  if (!legacy) {
    const digest = createHash("sha256").update(content, "utf8").digest("hex")
    if (digest !== reference.sha256) {
      throw new Error(`Archived attempts for ${run.run_id}/${node.id} failed immutable raw-byte/hash integrity validation`)
    }
  }
  const keys = isRecord(value) ? Object.keys(value) : []
  const legacyV1 = legacy && isRecord(value) && value.schema_version === 1 &&
    keys.length === 4 && keys.every((key) => ["schema_version", "run_id", "node_id", "attempts"].includes(key))
  const currentV2 = isRecord(value) && value.schema_version === 2 && value.kind === "attempt_history" &&
    value.owner_session_id === run.owner_session_id && keys.length === 6 &&
    keys.every((key) => [
      "schema_version", "kind", "owner_session_id", "run_id", "node_id", "attempts",
    ].includes(key))
  if ((!legacy && !currentV2) || (legacy && !legacyV1 && !currentV2) ||
    !isRecord(value) || value.run_id !== run.run_id || value.node_id !== node.id ||
    !Array.isArray(value.attempts) || value.attempts.length !== reference.attempt_count) {
    throw new Error(`Archived attempts for ${run.run_id}/${node.id} have an owner/run/node/kind/schema mismatch`)
  }
  const attempts = value.attempts.map((attempt, index) =>
    parseArchivedAttemptForNode(attempt, run, node, index + 1, legacyV1))
  const sessions = attempts.filter((attempt) => attempt.session_id !== undefined).length
  const rawAttempts = value.attempts as Array<Record<string, unknown>>
  const outputCount = rawAttempts.filter((attempt) => attempt.output_ref !== undefined).length
  const failureEntriesOmitted = rawAttempts.reduce(
    (sum, attempt) => sum + (typeof attempt.failures_omitted === "number" ? attempt.failures_omitted : 0),
    0,
  )
  const failureTextsTruncated = rawAttempts.reduce(
    (sum, attempt) => sum + (typeof attempt.failure_texts_truncated === "number" ? attempt.failure_texts_truncated : 0),
    0,
  )
  const errorBytesOmitted = rawAttempts.reduce(
    (sum, attempt) => sum + (typeof attempt.error_bytes_omitted === "number" ? attempt.error_bytes_omitted : 0),
    0,
  )
  const failureCommitments = rawAttempts.filter((attempt) => attempt.failures_commitment !== undefined).length
  const outcomes = attemptOutcomeCounts(attempts.map((attempt) => attempt.persisted_attempt as NodeAttempt))
  const feedbackApplied = rawAttempts.filter((attempt) => attempt.feedback_applied === true).length
  if ((reference.session_count !== undefined && sessions !== reference.session_count) ||
    outputCount !== reference.output_count || failureEntriesOmitted !== reference.failure_entries_omitted ||
    failureTextsTruncated !== reference.failure_texts_truncated || errorBytesOmitted !== reference.error_bytes_omitted ||
    (reference.failure_commitment_count !== undefined &&
      failureCommitments !== reference.failure_commitment_count) ||
    (reference.outcome_counts !== undefined && !isDeepStrictEqual(outcomes, reference.outcome_counts)) ||
    (reference.feedback_applied_count !== undefined && feedbackApplied !== reference.feedback_applied_count)) {
    throw new Error(`Archived attempts for ${run.run_id}/${node.id} have aggregate metadata mismatch`)
  }
  return { attempts, legacy_weaker_integrity: legacy }
}

function warnLegacyArchiveIntegrity(
  api: TuiPluginApi,
  cache: OutputValidationCache,
  run: TuiRun,
  node: TuiNode,
): void {
  const key = `${run.run_id}/${node.id}`
  let warned = legacyIntegrityWarnings.get(cache)
  if (!warned) {
    warned = new Set()
    legacyIntegrityWarnings.set(cache, warned)
  }
  if (warned.has("legacy-integrity")) return
  warned.add("legacy-integrity")
  toast(
    api,
    "warning",
    "Weaker legacy archive integrity",
    `Legacy fixed-path data for ${idPreview(key)} uses exact contained-path, bounded-read, strict schema/identity, and canonical logical-size checks; nested sidecars are checked lazily before navigation and no SHA integrity is claimed.`,
  )
}

function attemptValidationContext(run: TuiRun, node: TuiNode, attempt: number) {
  return {
    agent: node.agent,
    run_id: run.run_id,
    node_id: node.id,
    expected_attempt: attempt,
    mode: run.mode,
    requires_shell: node.requires_shell,
  }
}

function parseAttemptForNavigation(run: TuiRun, node: TuiNode, attempt: TuiAttempt): NodeAttempt {
  const raw = attempt.persisted_attempt
  try {
    return parsePersistedNodeAttempt(raw, attemptValidationContext(run, node, attempt.attempt))
  } catch (error) {
    throw new Error(
      `Attempt ${run.run_id}/${node.id}/${attempt.attempt} violates the authoritative attempt schema: ${formatSdkError(error)}`,
    )
  }
}

async function readValidatedNestedReference(
  api: TuiPluginApi,
  run: TuiRun,
  node: TuiNode,
  attempt: NodeAttempt,
  reference: RunDataReference,
  cache: OutputValidationCache,
  kind: "output" | "detail",
  maximumLogicalBytes: number,
  allowLegacyFixed: boolean,
): Promise<ValidatedOutput> {
  const identity = nestedAttemptReferenceKind(
    reference,
    run.run_id,
    node.id,
    attempt.attempt,
    kind,
    allowLegacyFixed,
  )
  if (reference.byte_size > maximumLogicalBytes) {
    throw new Error(`Attempt ${kind} ${run.run_id}/${node.id}/${attempt.attempt} exceeds its logical-size limit`)
  }

  let pending = cache.get(reference.artifact_path)
  if (!pending) {
    pending = (async (): Promise<ValidatedOutput> => {
      const response = await api.client.file.read({
        directory: projectDirectory(api),
        path: reference.artifact_path,
      })
      if (response.error) {
        throw new Error(`Could not read attempt ${kind} ${reference.artifact_path}: ${formatSdkError(response.error)}`)
      }
      if (response.data?.type !== "text" || typeof response.data.content !== "string") {
        throw new Error(`Attempt ${kind} is not readable text: ${reference.artifact_path}`)
      }
      const content = response.data.content
      const rawBytes = utf8Bytes(content)
      const readLimit = identity.legacy_fixed_path
        ? legacyReferenceReadLimit(reference.byte_size)
        : reference.byte_size
      if (rawBytes > readLimit || (!identity.legacy_fixed_path && rawBytes !== reference.byte_size)) {
        throw new Error(`Attempt ${kind} has a bounded raw-size mismatch: ${reference.artifact_path}`)
      }
      let rawDigest: string | undefined
      if (!identity.legacy_fixed_path) {
        rawDigest = createHash("sha256").update(content, "utf8").digest("hex")
        if (rawDigest !== reference.sha256) {
          throw new Error(`Attempt ${kind} failed immutable raw-byte/hash validation: ${reference.artifact_path}`)
        }
      }
      let value: unknown
      try {
        value = JSON.parse(content)
      } catch {
        throw new Error(`Attempt ${kind} is not valid JSON: ${reference.artifact_path}`)
      }
      const byteSize = serializedBytes(value)
      if (byteSize !== reference.byte_size) {
        throw new Error(`Attempt ${kind} failed canonical logical-size validation: ${reference.artifact_path}`)
      }
      if (!identity.legacy_fixed_path && sha256Json(value) !== reference.sha256) {
        throw new Error(`Attempt ${kind} failed immutable canonical hash validation: ${reference.artifact_path}`)
      }
      return {
        value,
        byte_size: byteSize,
        ...(rawDigest ? { sha256: rawDigest } : {}),
        legacy_fixed_path: identity.legacy_fixed_path,
        kind,
      }
    })()
    cache.set(reference.artifact_path, pending)
  }
  const validated = await pending
  if (validated.byte_size !== reference.byte_size || validated.kind !== kind ||
    validated.legacy_fixed_path !== identity.legacy_fixed_path ||
    (!identity.legacy_fixed_path && validated.sha256 !== reference.sha256)) {
    throw new Error(`Attempt ${kind} cache identity mismatch: ${reference.artifact_path}`)
  }
  return validated
}

async function readValidatedAttemptOutput(
  api: TuiPluginApi,
  run: TuiRun,
  node: TuiNode,
  attempt: NodeAttempt,
  reference: RunDataReference,
  cache: OutputValidationCache,
  allowLegacyFixed: boolean,
): Promise<unknown> {
  const knownAgent = AlgAgentSchema.safeParse(node.agent)
  if (!knownAgent.success) throw new Error(`Attempt output has an unknown agent identity: ${idPreview(node.agent)}`)
  const validated = await readValidatedNestedReference(
    api,
    run,
    node,
    attempt,
    reference,
    cache,
    "output",
    AGENT_OUTPUT_BYTE_LIMITS[knownAgent.data],
    allowLegacyFixed,
  )
  const parsed = schemaForAgent(knownAgent.data).safeParse(validated.value)
  if (!parsed.success) {
    throw new Error(`Attempt output violates the strict ${knownAgent.data} schema: ${reference.artifact_path}`)
  }
  if (validated.legacy_fixed_path) return parsed.data
  try {
    return parseCanonicalAgentOutput(knownAgent.data, validated.value)
  } catch (error) {
    throw new Error(
      `Attempt output is non-canonical and cannot hydrate immutable content: ${reference.artifact_path}: ${formatSdkError(error)}`,
    )
  }
}

const ATTEMPT_DETAIL_IDENTITY_FIELDS = [
  "attempt",
  "status",
  "session_id",
  "started_at",
  "finished_at",
  "score",
  "shell_ok",
  "schema_ok",
  "feedback_applied",
  "outcome",
] as const satisfies readonly (keyof NodeAttempt)[]

async function readValidatedAttemptDetail(
  api: TuiPluginApi,
  run: TuiRun,
  node: TuiNode,
  projected: NodeAttempt,
  reference: RunDataReference,
  cache: OutputValidationCache,
  allowLegacyFixed: boolean,
): Promise<NodeAttempt> {
  const validated = await readValidatedNestedReference(
    api,
    run,
    node,
    projected,
    reference,
    cache,
    "detail",
    MAX_ATTEMPT_HISTORY_BYTES,
    allowLegacyFixed,
  )
  let detail: NodeAttempt
  try {
    detail = parsePersistedAttemptDetail(
      validated.value,
      attemptValidationContext(run, node, projected.attempt),
    )
  } catch (error) {
    throw new Error(
      `Attempt detail ${run.run_id}/${node.id}/${projected.attempt} violates the strict authoritative schema: ${formatSdkError(error)}`,
    )
  }
  for (const key of ATTEMPT_DETAIL_IDENTITY_FIELDS) {
    if (!isDeepStrictEqual(projected[key], detail[key])) {
      throw new Error(`Attempt detail ${String(key)} identity mismatch: ${reference.artifact_path}`)
    }
  }
  if (projected.output !== undefined && !isDeepStrictEqual(projected.output, detail.output)) {
    throw new Error(`Attempt detail output mismatch: ${reference.artifact_path}`)
  }
  const expectedFailures = detail.failures.slice(0, MAX_PROJECTED_ATTEMPT_FAILURES)
    .map((failure) => safeDiagnosticText(failure, MAX_PROJECTED_FAILURE_BYTES))
  const expectedFailuresOmitted = Math.max(0, detail.failures.length - expectedFailures.length)
  const expectedFailureTruncations = detail.failures
    .filter((failure) => utf8Bytes(failure) > MAX_PROJECTED_FAILURE_BYTES).length
  const expectedError = detail.error === undefined
    ? undefined
    : safeDiagnosticText(detail.error, MAX_PROJECTED_ERROR_BYTES)
  const expectedErrorOmitted = detail.error === undefined
    ? 0
    : Math.max(0, utf8Bytes(detail.error) - utf8Bytes(expectedError!))
  const completeDiagnostics = isDeepStrictEqual(projected.failures, detail.failures) &&
    projected.failures_omitted === undefined && projected.failure_texts_truncated === undefined &&
    projected.error === detail.error && projected.error_bytes_omitted === undefined
  const projectedDiagnostics = isDeepStrictEqual(projected.failures, expectedFailures) &&
    (projected.failures_omitted ?? 0) === expectedFailuresOmitted &&
    (projected.failure_texts_truncated ?? 0) === expectedFailureTruncations &&
    projected.error === expectedError && (projected.error_bytes_omitted ?? 0) === expectedErrorOmitted
  if (!completeDiagnostics && !projectedDiagnostics) {
    throw new Error(`Attempt detail diagnostic projection mismatch: ${reference.artifact_path}`)
  }
  if (projected.failures_commitment !== undefined &&
    !isDeepStrictEqual(projected.failures_commitment, failureListCommitment(detail.failures))) {
    throw new Error(`Attempt detail failure commitment mismatch: ${reference.artifact_path}`)
  }
  return detail
}

function navigateValidatedAttempt(
  api: TuiPluginApi,
  run: TuiRun,
  node: TuiNode,
  attempt: TuiAttempt,
  cache: OutputValidationCache,
): void {
  const sessionId = attempt.navigation_session_id
  if (!sessionId) {
    toast(api, "info", "Child session unavailable", "This attempt did not create a child session.")
    return
  }

  let projected: NodeAttempt
  try {
    projected = parseAttemptForNavigation(run, node, attempt)
  } catch (error) {
    toast(api, "error", "ALG attempt unavailable", formatSdkError(error))
    return
  }
  if (!projected.output_ref && !projected.detail_ref) {
    api.ui.dialog.clear()
    api.route.navigate("session", { sessionID: sessionId })
    return
  }

  const allowLegacyFixed = attempt.legacy_reference_integrity === true
  void Promise.resolve()
    .then(async () => {
      const complete = projected.detail_ref
        ? await readValidatedAttemptDetail(
            api,
            run,
            node,
            projected,
            projected.detail_ref,
            cache,
            allowLegacyFixed,
          )
        : projected
      const output = projected.output_ref
        ? await readValidatedAttemptOutput(
            api,
            run,
            node,
            projected,
            projected.output_ref,
            cache,
            allowLegacyFixed,
          )
        : complete.output
      if (projected.output_ref && complete.output !== undefined &&
        (serializedBytes(complete.output) !== projected.output_ref.byte_size ||
          !isDeepStrictEqual(complete.output, output))) {
        throw new Error(`Inline attempt output does not match its referenced content: ${projected.output_ref.artifact_path}`)
      }
      try {
        parsePersistedNodeAttempt(
          { ...projected, output },
          attemptValidationContext(run, node, attempt.attempt),
        )
      } catch (error) {
        throw new Error(
          `Attempt output relationships are invalid for ${run.run_id}/${node.id}/${attempt.attempt}: ${formatSdkError(error)}`,
        )
      }
      api.ui.dialog.clear()
      api.route.navigate("session", { sessionID: sessionId })
    })
    .catch((error) => {
      toast(api, "error", "ALG attempt unavailable", formatSdkError(error))
    })
}

function orderedNodes(run: TuiRun): TuiNode[] {
  const order: TuiNode[] = []
  const known = new Set<string>()
  for (const definition of run.graph?.nodes ?? []) {
    if (typeof definition.id !== "string" || known.has(definition.id)) continue
    const node = run.nodes[definition.id]
    if (!node) continue
    known.add(node.id)
    order.push(node)
  }
  return [...order, ...Object.values(run.nodes).filter((node) => !known.has(node.id))]
}

function modelLabel(run: TuiRun, role: string): string {
  const resolution = run.model_resolution?.[role]
  const legacy = run.model_snapshot?.[role]
  const provider = resolution?.providerID ?? legacy?.providerID
  const model = resolution?.modelID ?? legacy?.modelID
  const variant = resolution?.variant ?? legacy?.variant
  const source = resolution?.source ?? "legacy-unknown"
  return description(`${provider && model ? `${provider}/${model}` : "SDK default (unknown)"}` +
    ` · variant ${variant ?? "model default/unknown"} · ${source}`)
}

function showVisibleNodeAttempts(
  api: TuiPluginApi,
  run: TuiRun,
  node: TuiNode,
  outputCache: OutputValidationCache,
): void {
  const attempts = Array.isArray(node.attempts) ? node.attempts : []
  if (!attempts.length) {
    toast(api, "info", "No ALG attempts", `Node ${idPreview(node.id)} has no attempts yet.`)
    return
  }
  const visible = attempts.slice(0, MAX_TUI_ATTEMPT_OPTIONS)
  const attemptsTotal = node.attempts_total ?? attempts.length
  if (attemptsTotal > visible.length) {
    toast(
      api,
      "warning",
      "ALG attempt list truncated",
      `Node ${idPreview(node.id)} has ${attemptsTotal} attempts; showing the first ${visible.length} persisted attempts.`,
    )
  }
  const options: TuiDialogSelectOption<string | null>[] = visible.map((attempt) => ({
    title: title(`attempt ${attempt.attempt} · ${idPreview(attempt.status)} · session ${attempt.session_id ?? "unavailable"}`),
    value: attempt.navigation_session_id ?? null,
    description: description(`${idPreview(node.id)} · ${idPreview(node.agent)} · ${modelLabel(run, node.agent)} · child session ${attempt.session_id ?? "not created"}`),
    category: idPreview(attempt.status),
    disabled: !attempt.navigation_session_id,
  }))
  const attemptByOption = new Map(options.map((option, index) => [option, visible[index]!]))
  api.ui.dialog.setSize("xlarge")
  api.ui.dialog.replace(() => api.ui.DialogSelect<string | null>({
    title: title(`ALG run ${idPreview(run.run_id)} · ${idPreview(node.id)} · choose an attempt`),
    placeholder: "Search attempt, status, model, or child session ID",
    options,
    onSelect(option) {
      if (!option.value) {
        toast(api, "info", "Child session unavailable", "This attempt did not create a child session.")
        return
      }
      const attempt = attemptByOption.get(option)
      if (attempt) navigateValidatedAttempt(api, run, node, attempt, outputCache)
    },
  }))
}

type ArchivedAttemptSelection =
  | { kind: "session"; session_id?: string }
  | { kind: "page"; page: number }

function showArchivedAttemptPage(
  api: TuiPluginApi,
  run: TuiRun,
  node: TuiNode,
  attempts: TuiAttempt[],
  page: number,
  outputCache: OutputValidationCache,
): void {
  const pageCount = Math.max(1, Math.ceil(attempts.length / MAX_TUI_ARCHIVED_ATTEMPT_PAGE_SIZE))
  const boundedPage = Math.max(0, Math.min(page, pageCount - 1))
  const start = boundedPage * MAX_TUI_ARCHIVED_ATTEMPT_PAGE_SIZE
  const selected = attempts.slice(start, start + MAX_TUI_ARCHIVED_ATTEMPT_PAGE_SIZE)
  const options: TuiDialogSelectOption<ArchivedAttemptSelection>[] = selected.map((attempt) => ({
    title: title(`attempt ${attempt.attempt} · ${idPreview(attempt.status)} · session ${attempt.session_id ?? "unavailable"}`),
    value: { kind: "session", ...(attempt.navigation_session_id ? { session_id: attempt.navigation_session_id } : {}) },
    description: description(
      `${idPreview(node.id)} · ${idPreview(node.agent)} · ${modelLabel(run, node.agent)} · ` +
      `child session ${attempt.session_id ?? "not created"}`,
    ),
    category: idPreview(attempt.status),
    disabled: !attempt.navigation_session_id,
  }))
  const attemptByOption = new Map(options.map((option, index) => [option, selected[index]!]))
  if (boundedPage > 0) {
    options.unshift({
      title: `← Previous attempts (page ${boundedPage}/${pageCount})`,
      value: { kind: "page", page: boundedPage - 1 },
      category: "Pagination",
    })
  }
  if (boundedPage + 1 < pageCount) {
    options.push({
      title: `Next attempts → (page ${boundedPage + 2}/${pageCount})`,
      value: { kind: "page", page: boundedPage + 1 },
      category: "Pagination",
    })
  }
  api.ui.dialog.setSize("xlarge")
  api.ui.dialog.replace(() => api.ui.DialogSelect<ArchivedAttemptSelection>({
    title: title(
      `ALG run ${idPreview(run.run_id)} · ${idPreview(node.id)} · attempts page ${boundedPage + 1}/${pageCount}`,
    ),
    placeholder: "Search this bounded attempt page or choose pagination",
    options,
    onSelect(option) {
      if (option.value.kind === "page") {
        showArchivedAttemptPage(api, run, node, attempts, option.value.page, outputCache)
        return
      }
      if (!option.value.session_id) {
        toast(api, "info", "Child session unavailable", "This attempt did not create a child session.")
        return
      }
      const attempt = attemptByOption.get(option)
      if (attempt) navigateValidatedAttempt(api, run, node, attempt, outputCache)
    },
  }))
}

function showNodeAttempts(
  api: TuiPluginApi,
  run: TuiRun,
  node: TuiNode,
  outputCache: OutputValidationCache,
): void {
  if (!node.attempt_history_ref) {
    showVisibleNodeAttempts(api, run, node, outputCache)
    return
  }
  void readArchivedAttempts(api, run, node).then((archive) => {
    if (archive.legacy_weaker_integrity) warnLegacyArchiveIntegrity(api, outputCache, run, node)
    const merged = [...archive.attempts, ...node.attempts]
    if (merged.length !== node.attempts_total ||
      merged.some((attempt, index) => attempt.attempt !== index + 1) ||
      new Set(merged.map((attempt) => attempt.attempt)).size !== merged.length) {
      throw new Error(`Archived and visible attempts for ${run.run_id}/${node.id} do not form one contiguous history`)
    }
    showArchivedAttemptPage(api, run, node, merged, 0, outputCache)
  }).catch((error) => {
    toast(api, "error", "ALG archived attempts unavailable", formatSdkError(error))
  })
}

export function showRunAttempts(
  api: TuiPluginApi,
  run: TuiRun,
  outputCache: OutputValidationCache = new Map(),
): void {
  const allNodes = orderedNodes(run)
  const nodes = allNodes.slice(0, MAX_TUI_NODE_OPTIONS)
  const nodesTotal = run.nodes_total ?? allNodes.length
  if (nodesTotal > nodes.length) {
    toast(
      api,
      "warning",
      "ALG node list truncated",
      `Run ${idPreview(run.run_id)} has ${run.nodes_total ?? allNodes.length} nodes; showing the first ${nodes.length} persisted nodes.`,
    )
  }
  if (!nodes.some((node) => node.attempts_total > 0)) {
    toast(api, "info", "No ALG attempts", `Run ${idPreview(run.run_id)} has no node attempts yet.`)
    return
  }
  const options: TuiDialogSelectOption<TuiNode>[] = nodes.map((node) => ({
    title: title(
      `${idPreview(node.id)} · ${idPreview(node.agent)} · ${idPreview(node.status)} · ` +
      `${node.attempts_total} attempts (${node.attempts_archived} archived, ${node.attempts_visible} visible)`,
    ),
    // A bounded selection token preserves the legacy value shape without
    // embedding every attempt in every option.
    value: { ...node, attempts: node.attempts.slice(0, 1) },
    description: description(
      `${modelLabel(run, node.agent)} · ${node.attempts_total} total · ` +
      `${node.attempts_archived} archived · ${node.attempts_visible} visible`,
    ),
    category: idPreview(node.status),
  }))
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => api.ui.DialogSelect<TuiNode>({
    title: title(`ALG run ${idPreview(run.run_id)} · choose a node`),
    placeholder: "Search node, role, status, or attempt count",
    options,
    onSelect(option) {
      const node = run.nodes[option.value.id]
      if (node) showNodeAttempts(api, run, node, outputCache)
    },
  }))
}

export async function openAlgRuns(api: TuiPluginApi): Promise<void> {
  const owner = currentParentSession(api)
  if (!owner) {
    toast(api, "info", "ALG runs unavailable", "Open a parent session before using /alg-runs.")
    return
  }
  try {
    const outputCache: OutputValidationCache = new Map()
    const runs = await recentOwnedRuns(api, owner)
    if (!runs.length) {
      toast(api, "info", "No ALG runs", "No recent ALG runs are owned by this parent session.")
      return
    }
    api.ui.dialog.setSize("large")
    const runsById = new Map(runs.map((run) => [run.run_id, run]))
    api.ui.dialog.replace(() => api.ui.DialogSelect<Pick<TuiRun, "run_id">>({
      title: "ALG runs · choose a recent owned run",
      placeholder: "Search run ID, template, or status",
      options: runs.map((run) => ({
        title: title(`${idPreview(run.run_id)} · ${idPreview(run.status)}`),
        value: { run_id: run.run_id },
        description: description(`${run.graph?.name ?? "custom"} · ${Object.values(run.nodes).reduce((sum, node) => sum + (node.attempts_total ?? node.attempts?.length ?? 0), 0)} attempts · ${idPreview(run.updated_at)}`),
        category: "ALG",
      })),
      onSelect(option) {
        const run = runsById.get(option.value.run_id)
        if (run) showRunAttempts(api, run, outputCache)
      },
    }))
  } catch (error) {
    toast(api, "error", "ALG runs unavailable", formatSdkError(error))
  }
}

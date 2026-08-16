import { createHash } from "node:crypto"
import type {
  AttemptHistoryReference,
  AttemptOutcomeCounts,
  FilesystemRootAuthorization,
  FilesystemRootAuthorizationCounts,
  FilesystemRootAuthorizationReference,
  FailureListCommitment,
  NodeAttempt,
  RunDataReference,
  RunState,
  StateProjectionMetadata,
} from "./types.ts"
import {
  MAX_INLINE_ATTEMPTS_PER_NODE,
  MAX_PROJECTED_ATTEMPT_FAILURES,
  MAX_PROJECTED_ERROR_BYTES,
  MAX_PROJECTED_FAILURE_BYTES,
  MAX_PROJECTED_NODE_FAILURES,
  MAX_PROJECTED_NODE_FAILURE_BYTES,
  MAX_PROJECTED_ROOT_AUTHORIZATIONS,
  serializedBytes,
  utf8Bytes,
} from "./limits.ts"
import { safeDiagnosticText } from "./diagnostics.ts"

export interface AttemptHistoryDocument {
  schema_version: 1 | 2
  /** Present on newly published archives; schema-v1 archives remain loadable. */
  kind?: "attempt_history"
  owner_session_id?: string
  run_id: string
  node_id: string
  attempts: NodeAttempt[]
}

export interface RootAuthorizationHistoryDocument {
  schema_version: 1
  kind: "filesystem_root_authorizations"
  run_id: string
  owner_session_id: string
  authorizations: FilesystemRootAuthorization[]
}

export interface ProjectedRunState {
  state: RunState
  histories: Map<string, AttemptHistoryDocument>
  rootAuthorizations?: RootAuthorizationHistoryDocument
}

export function canonicalJson(value: unknown): string {
  const canonicalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map((item) => canonicalize(item))
    if (candidate && typeof candidate === "object") {
      const sorted: Record<string, unknown> = {}
      for (const key of Object.keys(candidate).sort()) {
        const field = (candidate as Record<string, unknown>)[key]
        if (field !== undefined) sorted[key] = canonicalize(field)
      }
      return sorted
    }
    return candidate
  }
  const serialized = JSON.stringify(canonicalize(value))
  if (serialized === undefined) throw new Error("value is not JSON serializable")
  return serialized
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")
}

export function failureListCommitment(values: readonly string[]): FailureListCommitment {
  return {
    algorithm: "sha256",
    sha256: sha256Json(values),
    entry_count: values.length,
  }
}

export function referenceForJson(artifactPath: string, value: unknown): RunDataReference {
  return {
    artifact_path: artifactPath,
    sha256: sha256Json(value),
    byte_size: serializedBytes(value),
  }
}

/** Newly published immutable JSON references bind their full digest in the filename. */
export function isFullShaImmutableReference(reference: RunDataReference): boolean {
  return reference.artifact_path.endsWith(`-${reference.sha256}.json`)
}

export function attemptArtifactPath(
  runId: string,
  nodeId: string,
  attempt: number,
  sha256: string,
): string {
  return `.opencode/runs/${runId}/artifacts/${nodeId}-attempt-${attempt}-output-${sha256}.json`
}

export function nodeArtifactPath(runId: string, nodeId: string, sha256: string): string {
  return `.opencode/runs/${runId}/artifacts/${nodeId}-output-${sha256}.json`
}

export function nodeOutputReference(runId: string, nodeId: string, output: unknown): RunDataReference {
  const sha256 = sha256Json(output)
  return {
    artifact_path: nodeArtifactPath(runId, nodeId, sha256),
    sha256,
    byte_size: serializedBytes(output),
  }
}

export function attemptHistoryPath(runId: string, nodeId: string, sha256: string): string {
  return `.opencode/runs/${runId}/history/${nodeId}-attempts-${sha256}.json`
}

export function attemptDetailPath(
  runId: string,
  nodeId: string,
  attempt: number,
  sha256: string,
): string {
  return `.opencode/runs/${runId}/history/${nodeId}-attempt-${attempt}-detail-${sha256}.json`
}

export function nodeFailuresPath(runId: string, nodeId: string, sha256: string): string {
  return `.opencode/runs/${runId}/history/${nodeId}-failures-${sha256}.json`
}

export function rootAuthorizationsPath(runId: string, sha256: string): string {
  return `.opencode/runs/${runId}/history/filesystem-root-authorizations-${sha256}.json`
}

export function rootAuthorizationCounts(
  authorizations: readonly FilesystemRootAuthorization[],
): FilesystemRootAuthorizationCounts {
  const counts: FilesystemRootAuthorizationCounts = { plan: 0, run: 0, resume: 0 }
  for (const authorization of authorizations) counts[authorization.operation]++
  return counts
}

export function attemptOutcomeCounts(attempts: readonly NodeAttempt[]): AttemptOutcomeCounts {
  const counts: AttemptOutcomeCounts = {
    passed: 0,
    schema_invalid: 0,
    sdk_error: 0,
    substantive_rejection: 0,
    incomplete: 0,
    gate_failure: 0,
    legacy_unknown: 0,
  }
  for (const attempt of attempts) counts[attempt.outcome ?? "legacy_unknown"]++
  return counts
}

function rootAuthorizationReference(
  run: RunState,
  document: RootAuthorizationHistoryDocument,
): FilesystemRootAuthorizationReference {
  const integrity = contentAddressedReference(
    document,
    (sha256) => rootAuthorizationsPath(run.run_id, sha256),
  )
  return {
    ...integrity,
    authorization_count: document.authorizations.length,
    operation_counts: rootAuthorizationCounts(document.authorizations),
  }
}

function contentAddressedReference(
  value: unknown,
  pathForHash: (sha256: string) => string,
): RunDataReference {
  const sha256 = sha256Json(value)
  return {
    artifact_path: pathForHash(sha256),
    sha256,
    byte_size: serializedBytes(value),
  }
}

/** Remove projection-only fields so an attempt detail never references itself. */
export function attemptDetailDocument(attempt: NodeAttempt): NodeAttempt {
  const {
    output_ref: _outputRef,
    detail_ref: _detailRef,
    failures_omitted: _failuresOmitted,
    failure_texts_truncated: _failureTextsTruncated,
    failures_commitment: _failuresCommitment,
    error_bytes_omitted: _errorBytesOmitted,
    ...complete
  } = attempt
  return complete
}

export function attemptHasCompleteDetail(attempt: NodeAttempt): boolean {
  if (attempt.detail_ref === undefined) return true
  return attempt.failures_omitted === undefined &&
    attempt.failure_texts_truncated === undefined &&
    attempt.error_bytes_omitted === undefined &&
    (attempt.output_ref === undefined || attempt.output !== undefined)
}

function projectFailures(
  values: readonly string[],
  previousOmitted: number | undefined,
  previousTruncated: number | undefined,
  maximum: number,
  maximumBytes: number,
): { values: string[]; omitted: number; truncated: number } {
  const selected = values.slice(0, maximum)
  const projected = selected.map((value) => safeDiagnosticText(value, maximumBytes))
  const newlyTruncated = values.filter((value) => utf8Bytes(value) > maximumBytes).length
  return {
    values: projected,
    omitted: (previousOmitted ?? 0) + Math.max(0, values.length - selected.length),
    truncated: (previousTruncated ?? 0) + newlyTruncated,
  }
}

function projectError(error: string | undefined, previousOmitted: number | undefined): {
  error?: string
  omitted: number
} {
  if (error === undefined) return { omitted: previousOmitted ?? 0 }
  const projected = safeDiagnosticText(error, MAX_PROJECTED_ERROR_BYTES)
  return {
    error: projected,
    omitted: (previousOmitted ?? 0) + Math.max(0, utf8Bytes(error) - utf8Bytes(projected)),
  }
}

function projectAttempt(run: RunState, nodeId: string, attempt: NodeAttempt): NodeAttempt {
  const failures = projectFailures(
    attempt.failures,
    attempt.failures_omitted,
    attempt.failure_texts_truncated,
    MAX_PROJECTED_ATTEMPT_FAILURES,
    MAX_PROJECTED_FAILURE_BYTES,
  )
  const error = projectError(attempt.error, attempt.error_bytes_omitted)
  const outputRef = attempt.output === undefined
    ? attempt.output_ref
    : contentAddressedReference(
        attempt.output,
        (sha256) => attemptArtifactPath(run.run_id, nodeId, attempt.attempt, sha256),
      )
  const detailRef = attemptHasCompleteDetail(attempt)
    ? contentAddressedReference(
        attemptDetailDocument(attempt),
        (sha256) => attemptDetailPath(run.run_id, nodeId, attempt.attempt, sha256),
      )
    : attempt.detail_ref
  const projected: NodeAttempt = {
    attempt: attempt.attempt,
    status: attempt.status,
    ...(attempt.session_id ? { session_id: attempt.session_id } : {}),
    started_at: attempt.started_at,
    ...(attempt.finished_at ? { finished_at: attempt.finished_at } : {}),
    ...(outputRef ? { output_ref: outputRef } : {}),
    ...(detailRef ? { detail_ref: detailRef } : {}),
    failures: failures.values,
    failures_commitment: failureListCommitment(attempt.failures),
    ...(failures.omitted ? { failures_omitted: failures.omitted } : {}),
    ...(failures.truncated ? { failure_texts_truncated: failures.truncated } : {}),
    ...(attempt.score !== undefined ? { score: attempt.score } : {}),
    ...(attempt.shell_ok !== undefined ? { shell_ok: attempt.shell_ok } : {}),
    ...(attempt.schema_ok !== undefined ? { schema_ok: attempt.schema_ok } : {}),
    ...(error.error !== undefined ? { error: error.error } : {}),
    ...(error.omitted ? { error_bytes_omitted: error.omitted } : {}),
    ...(attempt.feedback_applied !== undefined ? { feedback_applied: attempt.feedback_applied } : {}),
    ...(attempt.outcome !== undefined ? { outcome: attempt.outcome } : {}),
  }
  return projected
}

function historyReference(
  run: RunState,
  nodeId: string,
  document: AttemptHistoryDocument,
): AttemptHistoryReference {
  const attempts = document.attempts
  const integrity = contentAddressedReference(
    document,
    (sha256) => attemptHistoryPath(run.run_id, nodeId, sha256),
  )
  return {
    ...integrity,
    attempt_count: attempts.length,
    output_count: attempts.filter((attempt) => attempt.output_ref !== undefined).length,
    session_count: attempts.filter((attempt) => attempt.session_id !== undefined).length,
    failure_entries_omitted: attempts.reduce((sum, attempt) => sum + (attempt.failures_omitted ?? 0), 0),
    failure_texts_truncated: attempts.reduce((sum, attempt) => sum + (attempt.failure_texts_truncated ?? 0), 0),
    error_bytes_omitted: attempts.reduce((sum, attempt) => sum + (attempt.error_bytes_omitted ?? 0), 0),
    failure_commitment_count: attempts.filter((attempt) => attempt.failures_commitment !== undefined).length,
    outcome_counts: attemptOutcomeCounts(attempts),
    feedback_applied_count: attempts.filter((attempt) => attempt.feedback_applied === true).length,
  }
}

/**
 * Deterministically externalize complete outputs and old attempt metadata.
 * The returned object is the only representation written to progress.json;
 * callers retain their hydrated runtime object for dependency/checker routing.
 */
export function projectRunState(run: RunState): ProjectedRunState {
  const histories = new Map<string, AttemptHistoryDocument>()
  const nodes = Object.create(null) as RunState["nodes"]

  for (const definition of run.graph.nodes) {
    const node = run.nodes[definition.id]!
    const projectedAttempts = node.attempts.map((attempt) => projectAttempt(run, node.id, attempt))
    let attemptHistoryRef = node.attempt_history_ref
    let visibleAttempts = projectedAttempts
    if (projectedAttempts.length > MAX_INLINE_ATTEMPTS_PER_NODE) {
      if (attemptHistoryRef) {
        throw new Error(`node ${node.id} attempt history must be hydrated before appending further attempts`)
      }
      const archived = projectedAttempts.slice(0, -MAX_INLINE_ATTEMPTS_PER_NODE)
      const document: AttemptHistoryDocument = {
        schema_version: 2,
        kind: "attempt_history",
        owner_session_id: run.owner_session_id,
        run_id: run.run_id,
        node_id: node.id,
        attempts: archived,
      }
      histories.set(node.id, document)
      attemptHistoryRef = historyReference(run, node.id, document)
      visibleAttempts = projectedAttempts.slice(-MAX_INLINE_ATTEMPTS_PER_NODE)
    }

    const lastFailures = projectFailures(
      node.last_failures,
      node.last_failures_omitted,
      node.last_failure_texts_truncated,
      MAX_PROJECTED_NODE_FAILURES,
      MAX_PROJECTED_NODE_FAILURE_BYTES,
    )
    const outputRef = node.output === undefined
      ? node.output_ref
      : nodeOutputReference(run.run_id, node.id, node.output)
    const hasCompleteLastFailures = node.last_failures_ref === undefined ||
      (node.last_failures_omitted === undefined && node.last_failure_texts_truncated === undefined)
    const lastFailuresRef = node.last_failures.length
      ? hasCompleteLastFailures
        ? contentAddressedReference(
            node.last_failures,
            (sha256) => nodeFailuresPath(run.run_id, node.id, sha256),
          )
        : node.last_failures_ref
      : undefined
    nodes[node.id] = {
      id: node.id,
      agent: node.agent,
      status: node.status,
      attempts: visibleAttempts,
      ...(attemptHistoryRef ? { attempt_history_ref: attemptHistoryRef } : {}),
      current_attempt: node.current_attempt,
      ...(outputRef ? { output_ref: outputRef } : {}),
      last_failures: lastFailures.values,
      last_failures_commitment: failureListCommitment(node.last_failures),
      ...(lastFailuresRef ? { last_failures_ref: lastFailuresRef } : {}),
      ...(lastFailures.omitted ? { last_failures_omitted: lastFailures.omitted } : {}),
      ...(lastFailures.truncated ? { last_failure_texts_truncated: lastFailures.truncated } : {}),
    }
  }

  const authorizations = run.filesystem_root_authorizations ?? []
  const visibleAuthorizations = authorizations.slice(-MAX_PROJECTED_ROOT_AUTHORIZATIONS)
  const priorRootAuthorizationsOmitted = run.filesystem_root_authorizations_omitted ?? 0
  let rootAuthorizationsRef = run.filesystem_root_authorizations_ref
  let rootAuthorizations: RootAuthorizationHistoryDocument | undefined
  if (!rootAuthorizationsRef && priorRootAuthorizationsOmitted === 0 &&
    authorizations.length > MAX_PROJECTED_ROOT_AUTHORIZATIONS) {
    rootAuthorizations = {
      schema_version: 1,
      kind: "filesystem_root_authorizations",
      run_id: run.run_id,
      owner_session_id: run.owner_session_id,
      authorizations,
    }
    rootAuthorizationsRef = rootAuthorizationReference(run, rootAuthorizations)
  }
  const rootAuthorizationsOmitted = rootAuthorizationsRef
    ? rootAuthorizationsRef.authorization_count - visibleAuthorizations.length
    : priorRootAuthorizationsOmitted + Math.max(0, authorizations.length - visibleAuthorizations.length)

  const state = {
    ...run,
    nodes,
    ...(authorizations.length || run.filesystem_root_authorizations !== undefined
      ? { filesystem_root_authorizations: visibleAuthorizations }
      : {}),
    ...(rootAuthorizationsRef ? { filesystem_root_authorizations_ref: rootAuthorizationsRef } : {}),
    ...(rootAuthorizationsOmitted
      ? { filesystem_root_authorizations_omitted: rootAuthorizationsOmitted }
      : {}),
  } as RunState

  let outputsExternalized = 0
  let attemptsArchived = 0
  let failureEntriesOmitted = 0
  let failureTextsTruncated = 0
  let errorBytesOmitted = 0
  for (const node of Object.values(nodes)) {
    if (node.output_ref) outputsExternalized++
    if (node.attempt_history_ref) {
      outputsExternalized += node.attempt_history_ref.output_count
      attemptsArchived += node.attempt_history_ref.attempt_count
      failureEntriesOmitted += node.attempt_history_ref.failure_entries_omitted
      failureTextsTruncated += node.attempt_history_ref.failure_texts_truncated
      errorBytesOmitted += node.attempt_history_ref.error_bytes_omitted
    }
    failureEntriesOmitted += node.last_failures_omitted ?? 0
    failureTextsTruncated += node.last_failure_texts_truncated ?? 0
    for (const attempt of node.attempts) {
      if (attempt.output_ref) outputsExternalized++
      failureEntriesOmitted += attempt.failures_omitted ?? 0
      failureTextsTruncated += attempt.failure_texts_truncated ?? 0
      errorBytesOmitted += attempt.error_bytes_omitted ?? 0
    }
  }
  state.state_projection = {
    outputs_externalized: outputsExternalized,
    attempts_archived: attemptsArchived,
    failure_entries_omitted: failureEntriesOmitted,
    failure_texts_truncated: failureTextsTruncated,
    error_bytes_omitted: errorBytesOmitted,
    root_authorizations_omitted: rootAuthorizationsOmitted,
  } satisfies StateProjectionMetadata
  return { state, histories, ...(rootAuthorizations ? { rootAuthorizations } : {}) }
}

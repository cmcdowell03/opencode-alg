import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join } from "node:path"
import { randomUUID } from "node:crypto"
import { isDeepStrictEqual, types as utilTypes } from "node:util"
import { z } from "zod"
import type {
  AgentModelMap,
  FilesystemRootAuthorization,
  GraphDef,
  ModelResolutionMap,
  NodeAttempt,
  RunDataReference,
  RunLockRecord,
  RunState,
} from "./types.ts"
import { ALG_SCHEMA_VERSION } from "./types.ts"
import { initNodeStates, validateGraph } from "./graph.ts"
import {
  parsePersistedNodeAttempt,
  parsePersistedAttemptDetail,
  PersistedFailureListSchema,
  parseRunState,
  parseRunStateForProjection,
  RunLockSchema,
  parseCanonicalAgentOutput,
  schemaForAgent,
} from "./schemas.ts"
import {
  acquireFilesystemMutex,
  FilesystemMutexContentionError,
  type FilesystemMutex,
} from "./filesystem-mutex.ts"
import {
  assertSafeId,
  assertFilesystemRootAuthorized,
  canonicalDirectory,
  isContained,
  isSafeId,
  isSafeProjectRelativePath,
  isSafeRunArtifactPath,
  resolveContainedPath,
} from "./paths.ts"
import {
  type AttemptHistoryDocument,
  type RootAuthorizationHistoryDocument,
  attemptArtifactPath,
  attemptDetailDocument,
  attemptHasCompleteDetail,
  attemptHistoryPath,
  attemptOutcomeCounts,
  canonicalJson,
  failureListCommitment,
  isFullShaImmutableReference,
  nodeFailuresPath,
  projectRunState,
  rootAuthorizationCounts,
  sha256Json,
} from "./persistence.ts"
import {
  MAX_ATTEMPT_HISTORY_BYTES,
  MAX_PERSISTED_STATE_BYTES,
  MAX_PROJECTED_ATTEMPT_FAILURES,
  MAX_PROJECTED_ERROR_BYTES,
  MAX_PROJECTED_FAILURE_BYTES,
  MAX_PROJECTED_NODE_FAILURES,
  MAX_PROJECTED_NODE_FAILURE_BYTES,
  MAX_PROJECTED_ROOT_AUTHORIZATIONS,
  MAX_STATE_BYTES,
  serializedBytes,
  utf8Bytes,
} from "./limits.ts"
import { safeDiagnosticText } from "./diagnostics.ts"
import {
  MAX_OWNER_INDEX_BYTES,
  MAX_OWNER_INDEX_ENTRIES,
  OWNER_INDEX_DIRECTORY,
  OWNER_INDEX_SCHEMA_VERSION,
  ownerIndexKey,
  parseOwnerRunIndex,
  sortOwnerRunEntries,
  type OwnerRunIndex,
  type OwnerRunIndexEntry,
} from "./owner-index.ts"

export { MAX_STATE_BYTES }
const DEFAULT_LOCK_LEASE_MS = 60 * 60 * 1_000
const OWNER_INDEX_UPDATE_ATTEMPTS = 5
export const MAX_OWNED_RUN_DIRECTORY_SCAN = 4_096

function exactPersistedString(minimum: number, maximum: number, label: string) {
  return z.string().min(minimum).max(maximum)
    .refine((value) => value === value.trim(), `${label} must not have surrounding whitespace`)
}

export class StoreError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "StoreError"
  }
}

export class RunLockedError extends StoreError {
  constructor(runId: string, detail = "already executing") {
    super(`run ${runId} is ${detail}`)
    this.name = "RunLockedError"
  }
}

export class RevisionConflictError extends StoreError {
  constructor(runId: string, expected: number, actual: number) {
    super(`run ${runId} revision conflict: expected ${expected}, found ${actual}`)
    this.name = "RevisionConflictError"
  }
}

export class CommittedStateSynchronizationError extends StoreError {
  readonly committed = true
  readonly committed_state: RunState

  constructor(runId: string, committedState: RunState, cause: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : ""
    super(
      `run ${runId} committed revision ${committedState.revision}, but caller object synchronization failed${detail}`,
      { cause },
    )
    this.name = "CommittedStateSynchronizationError"
    this.committed_state = committedState
  }
}

class DerivedReferenceError extends StoreError {
  constructor(runId: string, cause: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : ""
    super(`run ${runId} state is valid but derived-file reconciliation failed${detail}`, { cause })
    this.name = "DerivedReferenceError"
  }
}

export interface RunEnvelope {
  schema_version: 2
  revision: number
  run_id: string
  owner_session_id: string
  project_directory: string
  status: RunState["status"]
  goal: string
  updated_at: string
}

const RunEnvelopeSchema: z.ZodType<RunEnvelope> = z
  .object({
    schema_version: z.literal(2),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    run_id: z.string().min(1).max(64),
    owner_session_id: exactPersistedString(1, 256, "owner session id"),
    project_directory: exactPersistedString(1, 4_096, "project directory"),
    status: z.enum(["planning", "running", "done", "failed", "blocked"]),
    goal: exactPersistedString(1, 20_000, "goal"),
    updated_at: z.iso.datetime({ offset: true }),
  })
  .passthrough()
  .transform((value) => ({
    schema_version: value.schema_version,
    revision: value.revision,
    run_id: value.run_id,
    owner_session_id: value.owner_session_id,
    project_directory: value.project_directory,
    status: value.status,
    goal: value.goal,
    updated_at: value.updated_at,
  }))

const SessionLinkSchema = z
  .object({
    schema_version: z.literal(1),
    run_id: z.string().min(1).max(64),
    owner_session_id: exactPersistedString(1, 256, "owner session id"),
    project_directory: exactPersistedString(1, 4_096, "project directory"),
    node_id: z.string().min(1).max(64),
    attempt: z.number().int().positive().max(10_000),
    session_id: exactPersistedString(1, 256, "session id"),
    linked_at: z.iso.datetime({ offset: true }),
  })
  .strict()

function acquireMirrorLock(projectDirectory: string, runId: string): FilesystemMutex {
  const project = canonicalDirectory(projectDirectory)
  assertSafeId(runId, "run_id")
  const path = runContainedPath(project, runId, "mirror.lock")
  return acquireFilesystemMutex(path, {
    owner: `mirror:${runId}`,
    leaseMs: 30_000,
    waitMs: 250,
  })
}

function nowIso(): string {
  return new Date().toISOString()
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "task"
}

export function projectRunsRoot(projectDirectory: string): string {
  return resolveContainedPath(canonicalDirectory(projectDirectory), ".opencode", "runs")
}

export function ownerIndexPath(projectDirectory: string, ownerSessionId: string): string {
  return resolveContainedPath(
    projectRunsRoot(projectDirectory),
    OWNER_INDEX_DIRECTORY,
    `${ownerIndexKey(ownerSessionId)}.json`,
  )
}

export function runDir(projectDirectory: string, runId: string): string {
  assertSafeId(runId, "run_id")
  return resolveContainedPath(canonicalDirectory(projectDirectory), ".opencode", "runs", runId)
}

/** Resolve every run-local path through existing-component realpath containment. */
export function runContainedPath(
  projectDirectory: string,
  runId: string,
  ...segments: string[]
): string {
  return resolveContainedPath(runDir(projectDirectory, runId), ...segments)
}

/** Bind lexical artifact metadata to this run's actual, realpath-contained artifact tree. */
export function assertRunArtifactPathContained(
  projectDirectory: string,
  runId: string,
  artifactPath: string,
): void {
  const parts = artifactPath.split("/")
  if (!isSafeRunArtifactPath(artifactPath) || parts[2] !== runId) {
    throw new StoreError(`artifact_path must belong to run ${runId}`)
  }
  try {
    const artifactsRoot = runContainedPath(projectDirectory, runId, "artifacts")
    resolveContainedPath(artifactsRoot, ...parts.slice(4))
  } catch (error) {
    throw new StoreError(`artifact_path must resolve within run ${runId} artifacts`, { cause: error })
  }
}

export function assertProjectFilePathContained(projectDirectory: string, filePath: string): void {
  if (!isSafeProjectRelativePath(filePath)) {
    throw new StoreError("files_touched path must be normalized and project-relative")
  }
  try {
    resolveContainedPath(canonicalDirectory(projectDirectory), ...filePath.split("/"))
  } catch (error) {
    throw new StoreError(`files_touched path must resolve within the project: ${filePath}`, { cause: error })
  }
}

function assertInlineAgentOutputMetadataContained(state: RunState, projectDirectory: string): void {
  for (const node of Object.values(state.nodes)) {
    if (node.agent !== "implementer") continue
    const outputs = [node.output, ...node.attempts.map((attempt) => attempt.output)]
    for (const output of outputs) {
      if (
        output &&
        typeof output === "object" &&
        typeof (output as { artifact_path?: unknown }).artifact_path === "string"
      ) {
        assertRunArtifactPathContained(
          projectDirectory,
          state.run_id,
          (output as { artifact_path: string }).artifact_path,
        )
      }
      if (output && typeof output === "object" && Array.isArray((output as { files_touched?: unknown }).files_touched)) {
        for (const filePath of (output as { files_touched: unknown[] }).files_touched) {
          if (typeof filePath === "string") assertProjectFilePathContained(projectDirectory, filePath)
        }
      }
    }
  }
}

function assertRunArtifactMetadataContained(state: RunState, projectDirectory: string): void {
  if (state.filesystem_root_authorizations_ref) {
    try {
      localReferencePath(state, state.filesystem_root_authorizations_ref)
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : ""
      throw new StoreError(`derived reference must resolve within run ${state.run_id}${detail}`, { cause: error })
    }
  }
  for (const node of Object.values(state.nodes)) {
    for (const reference of [
      node.output_ref,
      node.attempt_history_ref,
      node.last_failures_ref,
      ...node.attempts.map((attempt) => attempt.output_ref),
      ...node.attempts.map((attempt) => attempt.detail_ref),
    ]) {
      if (!reference) continue
      try {
        localReferencePath(state, reference)
      } catch (error) {
        const detail = error instanceof Error ? `: ${error.message}` : ""
        throw new StoreError(`derived reference must resolve within run ${state.run_id}${detail}`, { cause: error })
      }
    }
  }
  assertInlineAgentOutputMetadataContained(state, projectDirectory)
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export function createRunId(goal: string): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
  return `${slugify(goal)}-${timestamp}-${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

export interface AtomicWriteFileHooks {
  /** Deterministic test seam immediately before the authoritative replacement. */
  beforeCurrentRename?: (temporary: string, current: string) => void
  /** Synchronous fence after the test seam and immediately before replacement. */
  commitBoundaryFence?: () => void
  /** Synchronous, precomputed caller copyback immediately after replacement. */
  afterCurrentRename?: () => void
  /** Deterministic test seam after commit but before rolling-backup replacement. */
  beforeBackupRename?: (stagedPrevious: string, backup: string) => void
}

/** Same-directory fsynced write; backup advances only after current commits. */
export function atomicWriteFile(
  path: string,
  data: string,
  backup = false,
  hooks: AtomicWriteFileHooks = {},
): void {
  ensureDir(dirname(path))
  const suffix = `${process.pid}-${randomUUID()}`
  const temporary = resolveContainedPath(dirname(path), `.${basename(path)}.${suffix}.tmp`)
  let stagedPrevious: string | undefined
  let fd: number | undefined
  let committed = false
  const cleanup = (candidate: string | undefined): void => {
    if (!candidate) return
    try { rmSync(candidate, { force: true }) } catch { /* best effort */ }
  }
  try {
    fd = openSync(temporary, "wx", 0o600)
    writeFileSync(fd, data, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined

    if (backup && existsSync(path)) {
      stagedPrevious = resolveContainedPath(dirname(path), `${basename(path)}.${suffix}.previous.tmp`)
      copyFileSync(path, stagedPrevious)
      const previousFd = openSync(stagedPrevious, "r+")
      try { fsyncSync(previousFd) } finally { closeSync(previousFd) }
    }
    // Evaluate the test-only backup-maintenance seam before the authoritative
    // boundary. Its failure is remembered and still has the same externally
    // visible result (the commit succeeds and the prior backup is preserved),
    // but no caller callback can run after the exact commit boundary.
    let skipBackupRename = false
    if (stagedPrevious) {
      const backupPath = resolveContainedPath(dirname(path), `${basename(path)}.bak`)
      try { hooks.beforeBackupRename?.(stagedPrevious, backupPath) } catch { skipBackupRename = true }
    }
    hooks.beforeCurrentRename?.(temporary, path)
    hooks.commitBoundaryFence?.()
    renameSync(temporary, path)
    committed = true
    hooks.afterCurrentRename?.()

    if (stagedPrevious && !skipBackupRename) {
      const backupPath = resolveContainedPath(dirname(path), `${basename(path)}.bak`)
      try {
        renameSync(stagedPrevious, backupPath)
        stagedPrevious = undefined
      } catch {
        // progress.json is already authoritative. A rolling-backup maintenance
        // failure must preserve that commit and the prior backup unchanged.
        cleanup(stagedPrevious)
        stagedPrevious = undefined
      }
    }
    if (stagedPrevious && skipBackupRename) {
      cleanup(stagedPrevious)
      stagedPrevious = undefined
    }
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    cleanup(temporary)
    cleanup(stagedPrevious)
    if (committed) throw error
    throw error
  }
}

export function writeJson(path: string, data: unknown, backup = false): void {
  const serialized = `${JSON.stringify(data, null, 2)}\n`
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
    throw new StoreError(`JSON payload exceeds ${MAX_STATE_BYTES} bytes`)
  }
  atomicWriteFile(path, serialized, backup)
}

/** Publish canonical immutable JSON without ever replacing an existing path. */
function writeImmutableJson(path: string, data: unknown): void {
  const serialized = canonicalJson(data)
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new StoreError(`JSON payload exceeds ${MAX_STATE_BYTES} bytes`)
  }
  ensureDir(dirname(path))
  const temporary = resolveContainedPath(
    dirname(path),
    `.${basename(path)}.${process.pid}-${randomUUID()}.tmp`,
  )
  let fd: number | undefined
  try {
    fd = openSync(temporary, "wx", 0o600)
    writeFileSync(fd, serialized, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    try {
      linkSync(temporary, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      // Another compliant publisher may have won. The caller verifies the
      // pre-existing immutable object before it can be reused.
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
  }
}

function writeProgressJson(
  path: string,
  state: RunState,
  backup = false,
  hooks: AtomicWriteFileHooks = {},
): void {
  const serialized = `${canonicalJson(state)}\n`
  const bytes = Buffer.byteLength(serialized, "utf8")
  if (bytes > MAX_PERSISTED_STATE_BYTES) {
    throw new StoreError(`authoritative run state exceeds ${MAX_PERSISTED_STATE_BYTES} bytes (received ${bytes})`)
  }
  atomicWriteFile(path, serialized, backup, hooks)
}

function readOwnerRunIndex(path: string, ownerSessionId: string): OwnerRunIndex | null {
  if (!existsSync(path)) return null
  try {
    if (statSync(path).size > MAX_OWNER_INDEX_BYTES) return null
    return parseOwnerRunIndex(JSON.parse(readFileSync(path, "utf8")), ownerSessionId)
  } catch {
    // This projection is never authoritative. A later successful run save
    // replaces malformed/stale projection data from the authoritative state.
    return null
  }
}

function updateOwnerRunIndex(
  projectDirectory: string,
  ownerSessionId: string,
  entry: OwnerRunIndexEntry | null,
  removeRunId?: string,
): void {
  const directory = resolveContainedPath(projectRunsRoot(projectDirectory), OWNER_INDEX_DIRECTORY)
  ensureDir(directory)
  const key = ownerIndexKey(ownerSessionId)
  const path = resolveContainedPath(directory, `${key}.json`)
  const lock = acquireFilesystemMutex(resolveContainedPath(directory, `${key}.lock`), {
    owner: `owner-index:${key}`,
    leaseMs: 30_000,
    waitMs: 5_000,
  })
  try {
    const existing = readOwnerRunIndex(path, ownerSessionId)
    if (!existing && entry === null) return
    const byRun = new Map((existing?.runs ?? []).map((run) => [run.run_id, run]))
    if (entry) byRun.set(entry.run_id, entry)
    if (removeRunId) byRun.delete(removeRunId)
    const runs = sortOwnerRunEntries([...byRun.values()])
      .slice(0, MAX_OWNER_INDEX_ENTRIES)
    const index: OwnerRunIndex = {
      schema_version: OWNER_INDEX_SCHEMA_VERSION,
      owner_session_id: ownerSessionId,
      updated_at: new Date().toISOString(),
      runs,
    }
    const serialized = `${JSON.stringify(index, null, 2)}\n`
    if (Buffer.byteLength(serialized, "utf8") > MAX_OWNER_INDEX_BYTES) {
      throw new StoreError(`owner run index exceeds ${MAX_OWNER_INDEX_BYTES} bytes`)
    }
    atomicWriteFile(path, serialized)
  } finally {
    lock.release()
  }
}

function refreshOwnerRunIndex(
  projectDirectory: string,
  ownerSessionId: string,
  entry: OwnerRunIndexEntry | null,
  removeRunId?: string,
): void {
  for (let attempt = 0; attempt < OWNER_INDEX_UPDATE_ATTEMPTS; attempt++) {
    try {
      updateOwnerRunIndex(projectDirectory, ownerSessionId, entry, removeRunId)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code
      const transientFilesystemRace = code === "EACCES" || code === "EPERM" || code === "EBUSY" || code === "ENOENT"
      // Verified contention and common Windows/OneDrive replacement races are
      // safe to retry because every attempt re-acquires the owner mutex and
      // re-reads the complete projection. Malformed/unverifiable locks,
      // containment failures, and other unknown errors remain fail-closed.
      if ((!transientFilesystemRace && !(error instanceof FilesystemMutexContentionError)) ||
        attempt === OWNER_INDEX_UPDATE_ATTEMPTS - 1) return
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (2 ** attempt))
    }
  }
}

export interface QuarantineResult {
  quarantined: boolean
  path?: string
  error?: string
}

export function quarantineCorruptFile(
  path: string,
  renameFile: (source: string, destination: string) => void = renameSync,
): QuarantineResult {
  const quarantined = resolveContainedPath(
    dirname(path),
    `${basename(path, ".json")}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.json`,
  )
  try {
    renameFile(path, quarantined)
    if (!existsSync(quarantined) || existsSync(path)) {
      return { quarantined: false, error: "rename did not produce the expected source/destination state" }
    }
    return { quarantined: true, path: quarantined }
  } catch (error) {
    return { quarantined: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function corruptRunError(runId: string, cause: unknown, result: QuarantineResult): StoreError {
  if (result.quarantined && result.path) {
    return new StoreError(`run ${runId} is corrupt or incompatible; quarantined as ${basename(result.path)}`, { cause })
  }
  return new StoreError(
    `run ${runId} is corrupt or incompatible; corrupt file remains in place and manual action is required (quarantine rename failed: ${result.error ?? "unknown error"})`,
    { cause },
  )
}

function readBoundedJson(path: string): unknown {
  const size = statSync(path).size
  if (size > MAX_STATE_BYTES) throw new StoreError(`state file exceeds ${MAX_STATE_BYTES} bytes`)
  return JSON.parse(readFileSync(path, "utf8"))
}

function verifyInlineAgainstReference(output: unknown, reference: RunDataReference, label: string): void {
  if (serializedBytes(output) !== reference.byte_size || sha256Json(output) !== reference.sha256) {
    throw new StoreError(`${label} does not match its integrity reference`)
  }
}

function parseReferencedAgentOutput(
  agent: string,
  output: unknown,
  reference: RunDataReference,
  label: string,
): unknown {
  const parsed = schemaForAgent(agent).safeParse(output)
  if (!parsed.success) {
    throw new StoreError(`${label} violates ${agent} output schema: ${reference.artifact_path}`)
  }
  if (isFullShaImmutableReference(reference)) {
    try {
      return parseCanonicalAgentOutput(agent, output)
    } catch (error) {
      throw new StoreError(
        `${label} is non-canonical and cannot hydrate immutable content: ${reference.artifact_path}`,
        { cause: error },
      )
    }
  }
  // Fixed/short-hash legacy output references retain compatibility. Their
  // parsed canonical value is republished under a full digest on the next save.
  return parsed.data
}

function verifyFailureCommitment(
  failures: readonly string[],
  commitment: NodeAttempt["failures_commitment"],
  label: string,
): void {
  if (commitment === undefined) return
  if (!isDeepStrictEqual(commitment, failureListCommitment(failures))) {
    throw new StoreError(`${label} failure commitment mismatch`)
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

function persistedAttemptContext(
  state: RunState,
  nodeId: string,
  expectedAttempt: number,
): Parameters<typeof parsePersistedNodeAttempt>[1] {
  const definition = state.graph.nodes.find((candidate) => candidate.id === nodeId)
  if (!definition) throw new StoreError(`attempt belongs to unknown node ${nodeId}`)
  return {
    agent: definition.agent,
    run_id: state.run_id,
    node_id: nodeId,
    expected_attempt: expectedAttempt,
    mode: state.mode,
    requires_shell: definition.agent === "shell" || definition.loop?.gate === "shell" ||
      definition.loop?.gate === "all",
  }
}

function parseAttemptBeforeHydration(state: RunState, nodeId: string, value: unknown, expected: number): NodeAttempt {
  try {
    return parsePersistedNodeAttempt(value, persistedAttemptContext(state, nodeId, expected))
  } catch (error) {
    throw new StoreError(
      `attempt ${nodeId}/${expected} schema mismatch before hydration: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

function hydrateAttemptData(
  state: RunState,
  nodeId: string,
  agent: RunState["nodes"][string]["agent"],
  projected: NodeAttempt,
  retainReferences: boolean,
): NodeAttempt {
  const outputReference = projected.output_ref
  const detailReference = projected.detail_ref
  let complete = structuredClone(projected)

  if (detailReference) {
    const value = readAndVerifyReference(state, detailReference)
    // Parse the referenced record in full before reading or copying any of its
    // fields. In particular, a valid detail object must not erase malformed or
    // unknown projected data during hydration.
    let detail: NodeAttempt
    try {
      detail = parsePersistedAttemptDetail(
        value,
        persistedAttemptContext(state, nodeId, projected.attempt),
      )
    } catch (error) {
      throw new StoreError(
        `attempt detail ${nodeId}/${projected.attempt} schema mismatch before hydration: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      )
    }
    for (const key of ATTEMPT_DETAIL_IDENTITY_FIELDS) {
      if (!isDeepStrictEqual(projected[key], detail[key])) {
        throw new StoreError(`attempt detail ${String(key)} mismatch: ${detailReference.artifact_path}`)
      }
    }
    if (
      detail.output_ref !== undefined || detail.detail_ref !== undefined ||
      detail.failures_commitment !== undefined || detail.failures_omitted !== undefined ||
      detail.failure_texts_truncated !== undefined || detail.error_bytes_omitted !== undefined
    ) {
      throw new StoreError(`attempt detail contains projection-only fields: ${detailReference.artifact_path}`)
    }
    if (projected.output !== undefined && !isDeepStrictEqual(projected.output, detail.output)) {
      throw new StoreError(`attempt detail output mismatch: ${detailReference.artifact_path}`)
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
    const matchesCompleteDiagnostics = isDeepStrictEqual(projected.failures, detail.failures) &&
      projected.failures_omitted === undefined &&
      projected.failure_texts_truncated === undefined &&
      projected.error === detail.error &&
      projected.error_bytes_omitted === undefined
    const matchesProjectedDiagnostics = isDeepStrictEqual(projected.failures, expectedFailures) &&
      (projected.failures_omitted ?? 0) === expectedFailuresOmitted &&
      (projected.failure_texts_truncated ?? 0) === expectedFailureTruncations &&
      projected.error === expectedError &&
      (projected.error_bytes_omitted ?? 0) === expectedErrorOmitted
    if (!matchesCompleteDiagnostics && !matchesProjectedDiagnostics) {
      throw new StoreError(`attempt detail diagnostic projection mismatch: ${detailReference.artifact_path}`)
    }
    verifyFailureCommitment(detail.failures, projected.failures_commitment, `attempt ${nodeId}/${projected.attempt}`)
    complete = detail
  } else if (
    projected.failures_omitted ||
    projected.failure_texts_truncated ||
    projected.error_bytes_omitted
  ) {
    throw new StoreError(`attempt ${nodeId}/${projected.attempt} has truncated detail without a detail reference`)
  }

  if (!detailReference) {
    verifyFailureCommitment(complete.failures, projected.failures_commitment, `attempt ${nodeId}/${projected.attempt}`)
  }

  if (outputReference) {
    const output = readAndVerifyReference(state, outputReference)
    const parsed = parseReferencedAgentOutput(agent, output, outputReference, "attempt artifact")
    if (complete.output !== undefined) {
      verifyInlineAgainstReference(complete.output, outputReference, "attempt output")
    }
    complete.output = parsed
  } else if (complete.output !== undefined && !schemaForAgent(agent).safeParse(complete.output).success) {
    throw new StoreError(`inline attempt output violates ${agent} output schema`)
  }

  complete.failures_omitted = undefined
  complete.failure_texts_truncated = undefined
  complete.error_bytes_omitted = undefined
  if (retainReferences) {
    complete.output_ref = outputReference
    complete.detail_ref = detailReference
  } else {
    complete.output_ref = undefined
    complete.detail_ref = undefined
  }
  complete.failures_commitment = undefined
  return complete
}

function hydrateNodeFailures(state: RunState, nodeId: string): void {
  const node = state.nodes[nodeId]!
  if (!node.last_failures_ref) return
  const reference = node.last_failures_ref
  const rawFailures = readAndVerifyReference(state, reference)
  const parsedFailures = PersistedFailureListSchema.safeParse(rawFailures)
  if (!parsedFailures.success) {
    throw new StoreError(`node failure detail is invalid: ${reference.artifact_path}`)
  }
  const failures = parsedFailures.data
  const expectedFailures = failures.slice(0, MAX_PROJECTED_NODE_FAILURES)
    .map((failure) => safeDiagnosticText(failure, MAX_PROJECTED_NODE_FAILURE_BYTES))
  const expectedOmitted = Math.max(0, failures.length - expectedFailures.length)
  const expectedTruncated = failures
    .filter((failure) => utf8Bytes(failure) > MAX_PROJECTED_NODE_FAILURE_BYTES).length
  const matchesComplete = isDeepStrictEqual(node.last_failures, failures) &&
    node.last_failures_omitted === undefined && node.last_failure_texts_truncated === undefined
  const matchesProjection = isDeepStrictEqual(node.last_failures, expectedFailures) &&
    (node.last_failures_omitted ?? 0) === expectedOmitted &&
    (node.last_failure_texts_truncated ?? 0) === expectedTruncated
  if (!matchesComplete && !matchesProjection) {
    throw new StoreError(`node failure projection mismatch: ${reference.artifact_path}`)
  }
  verifyFailureCommitment(failures, node.last_failures_commitment, `node ${nodeId}`)
  node.last_failures = failures
  node.last_failures_omitted = undefined
  node.last_failure_texts_truncated = undefined
  node.last_failures_commitment = undefined
}

function hydrateVisibleRunData(projected: RunState): RunState {
  const candidate = structuredClone(projected)
  candidate.state_projection = undefined
  for (const definition of candidate.graph.nodes) {
    const node = candidate.nodes[definition.id]!
    for (let index = 0; index < node.attempts.length; index++) {
      node.attempts[index] = hydrateAttemptData(
        candidate,
        definition.id,
        node.agent,
        node.attempts[index]!,
        true,
      )
    }
    if (node.output_ref) {
      const output = readAndVerifyReference(candidate, node.output_ref)
      const parsed = parseReferencedAgentOutput(node.agent, output, node.output_ref, "node artifact")
      if (node.output !== undefined) verifyInlineAgainstReference(node.output, node.output_ref, "node output")
      node.output = parsed
    }
    hydrateNodeFailures(candidate, definition.id)
    // Commitments describe the persisted projection. Runtime callers receive
    // mutable complete lists and a later save deterministically recommits them.
    node.last_failures_commitment = undefined
  }
  verifyRootAuthorizationProjection(candidate)
  return parseRunStateForProjection(candidate)
}

function readAttemptHistoryDocument(
  state: RunState,
  nodeId: string,
  expectedOwnerSessionId = state.owner_session_id,
): AttemptHistoryDocument | null {
  const node = state.nodes[nodeId]!
  const reference = node.attempt_history_ref
  if (!reference) return null
  const value = readAndVerifyReference(state, reference)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoreError(`attempt history is not an object: ${reference.artifact_path}`)
  }
  const document = value as AttemptHistoryDocument
  const legacy = document.schema_version === 1 && document.kind === undefined && document.owner_session_id === undefined
  const current = document.schema_version === 2 && document.kind === "attempt_history" &&
    document.owner_session_id === expectedOwnerSessionId
  const allowedKeys = legacy
    ? ["schema_version", "run_id", "node_id", "attempts"]
    : ["schema_version", "kind", "owner_session_id", "run_id", "node_id", "attempts"]
  if ((!legacy && !current) || document.run_id !== state.run_id ||
    document.node_id !== nodeId || !Array.isArray(document.attempts) ||
    Object.keys(document).some((key) => !allowedKeys.includes(key))) {
    throw new StoreError(`attempt history identity mismatch: ${reference.artifact_path}`)
  }
  const parsedAttempts = document.attempts.map((attempt, index) =>
    parseAttemptBeforeHydration(state, nodeId, attempt, index + 1))
  if (current) {
    for (const attempt of parsedAttempts) {
      if (attempt.output !== undefined || attempt.detail_ref === undefined ||
        attempt.failures.length > MAX_PROJECTED_ATTEMPT_FAILURES ||
        attempt.failures.some((failure) => utf8Bytes(failure) > MAX_PROJECTED_FAILURE_BYTES) ||
        (attempt.error !== undefined && utf8Bytes(attempt.error) > MAX_PROJECTED_ERROR_BYTES)) {
        throw new StoreError(`attempt history contains an impossible projected record: ${reference.artifact_path}`)
      }
    }
  }
  document.attempts = parsedAttempts
  const outputCount = document.attempts.filter((attempt) => attempt.output_ref !== undefined).length
  const sessionCount = document.attempts.filter((attempt) => attempt.session_id !== undefined).length
  const omitted = document.attempts.reduce((sum, attempt) => sum + (attempt.failures_omitted ?? 0), 0)
  const textTruncations = document.attempts.reduce((sum, attempt) => sum + (attempt.failure_texts_truncated ?? 0), 0)
  const errorOmissions = document.attempts.reduce((sum, attempt) => sum + (attempt.error_bytes_omitted ?? 0), 0)
  const failureCommitments = document.attempts.filter((attempt) => attempt.failures_commitment !== undefined).length
  const outcomes = attemptOutcomeCounts(document.attempts)
  const feedbackApplied = document.attempts.filter((attempt) => attempt.feedback_applied === true).length
  if (document.attempts.length !== reference.attempt_count || outputCount !== reference.output_count ||
    (reference.session_count !== undefined && sessionCount !== reference.session_count) ||
    omitted !== reference.failure_entries_omitted || textTruncations !== reference.failure_texts_truncated ||
    errorOmissions !== reference.error_bytes_omitted ||
    (reference.failure_commitment_count !== undefined && failureCommitments !== reference.failure_commitment_count) ||
    (reference.outcome_counts !== undefined && !isDeepStrictEqual(outcomes, reference.outcome_counts)) ||
    (reference.feedback_applied_count !== undefined && feedbackApplied !== reference.feedback_applied_count)) {
    throw new StoreError(`attempt history metadata mismatch: ${reference.artifact_path}`)
  }
  return document
}

function readRootAuthorizationHistoryDocument(
  state: RunState,
  expectedOwnerSessionId = state.owner_session_id,
): RootAuthorizationHistoryDocument | null {
  const reference = state.filesystem_root_authorizations_ref
  if (!reference) return null
  const value = readAndVerifyReference(state, reference)
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StoreError(`filesystem root authorization history is not an object: ${reference.artifact_path}`)
  }
  const parsedDocument = z.object({
    schema_version: z.literal(1),
    kind: z.literal("filesystem_root_authorizations"),
    run_id: exactPersistedString(1, 64, "run id"),
    owner_session_id: exactPersistedString(1, 256, "owner session id"),
    authorizations: z.array(z.object({
      operation: z.enum(["plan", "run", "resume"]),
      by_session_id: exactPersistedString(1, 256, "authorization session id"),
      authorized_at: z.iso.datetime({ offset: true }),
      authorized: z.literal(true).optional(),
      path: exactPersistedString(1, 4_096, "authorization path").refine(isAbsolute).optional(),
    }).strict()).max(10_000),
  }).strict().safeParse(value)
  if (!parsedDocument.success || parsedDocument.data.run_id !== state.run_id ||
    parsedDocument.data.owner_session_id !== expectedOwnerSessionId) {
    throw new StoreError(`filesystem root authorization history identity/kind mismatch: ${reference.artifact_path}`)
  }
  const document = parsedDocument.data as RootAuthorizationHistoryDocument
  if (document.authorizations.some((authorization) =>
    authorization.path !== undefined && authorization.path !== state.project_directory)) {
    throw new StoreError(`filesystem root authorization history path mismatch: ${reference.artifact_path}`)
  }
  if (document.authorizations.length !== reference.authorization_count ||
    !isDeepStrictEqual(rootAuthorizationCounts(document.authorizations), reference.operation_counts)) {
    throw new StoreError(`filesystem root authorization history aggregate mismatch: ${reference.artifact_path}`)
  }
  return document
}

function verifyRootAuthorizationProjection(state: RunState): void {
  const document = readRootAuthorizationHistoryDocument(state)
  if (!document) return
  const complete = document.authorizations
  const retained = complete.slice(-MAX_PROJECTED_ROOT_AUTHORIZATIONS)
  if (!isDeepStrictEqual(state.filesystem_root_authorizations ?? [], retained) ||
    (state.filesystem_root_authorizations_omitted ?? 0) !== complete.length - retained.length) {
    throw new StoreError(
      `filesystem root authorization projection mismatch: ${state.filesystem_root_authorizations_ref!.artifact_path}`,
    )
  }
}

/** Verify archived details/outputs/commitments without returning their entries. */
function verifyArchivedAttemptData(projected: RunState, visible: RunState): void {
  const candidate = structuredClone(visible)
  for (const definition of projected.graph.nodes) {
    const history = readAttemptHistoryDocument(projected, definition.id)
    if (!history) continue
    const archived = history.attempts.map((attempt) => hydrateAttemptData(
      projected,
      definition.id,
      projected.nodes[definition.id]!.agent,
      attempt,
      true,
    ))
    const node = candidate.nodes[definition.id]!
    node.attempts = [...archived, ...node.attempts]
    node.attempt_history_ref = undefined
  }
  candidate.state_projection = undefined
  parseRunStateForProjection(candidate)
}

/** Materialize archived attempt metadata before executor appends and rewrites history. */
export function hydrateRunForExecution(state: RunState): RunState {
  const candidate = hydrateRunFully(state)
  for (const definition of candidate.graph.nodes) {
    const node = candidate.nodes[definition.id]!
    node.output_ref = undefined
    node.last_failures_ref = undefined
    for (const attempt of node.attempts) {
      attempt.output_ref = undefined
      attempt.detail_ref = undefined
    }
  }
  candidate.state_projection = undefined
  return parseRunStateForProjection(candidate)
}

/** Fully hydrate every archived attempt and integrity reference without bounding output. */
export function hydrateRunFully(state: RunState): RunState {
  const candidate = hydrateVisibleRunData(state)
  for (const definition of candidate.graph.nodes) {
    const node = candidate.nodes[definition.id]!
    const history = readAttemptHistoryDocument(candidate, definition.id)
    const archived = history?.attempts ?? []
    const attempts = [...archived, ...node.attempts]
    node.attempts = attempts.map((attempt) => hydrateAttemptData(
      candidate,
      definition.id,
      node.agent,
      attempt,
      true,
    ))
    node.attempt_history_ref = undefined
  }
  const authorizationHistory = readRootAuthorizationHistoryDocument(candidate)
  if (authorizationHistory) {
    const complete = authorizationHistory.authorizations
    const retained = complete.slice(-MAX_PROJECTED_ROOT_AUTHORIZATIONS)
    // hydrateVisibleRunData already verified the exact retained tail and counts.
    void retained
    candidate.filesystem_root_authorizations = complete
    candidate.filesystem_root_authorizations_ref = undefined
    candidate.filesystem_root_authorizations_omitted = undefined
  }
  candidate.state_projection = undefined
  return parseRunStateForProjection(candidate)
}

/** Complete latest typed output for dependency input and alg_artifact detail=full. */
export function readNodeArtifactOutput(state: RunState, nodeId: string): unknown {
  const node = state.nodes[nodeId]
  if (!node) throw new StoreError(`unknown node ${nodeId}`)
  if (node.output !== undefined) return node.output
  if (!node.output_ref) return null
  const output = readAndVerifyReference(state, node.output_ref)
  return parseReferencedAgentOutput(node.agent, output, node.output_ref, "node artifact")
}

export function createRun(options: {
  goal: string
  criteria: string[]
  graph: GraphDef | unknown
  projectDirectory: string
  ownerSessionId: string
  parentSessionId?: string
  mode?: "live" | "dry"
  runId?: string
  modelSnapshot?: AgentModelMap
  modelResolution?: ModelResolutionMap
  allowFilesystemRoot?: boolean
  /** Additive test/path-policy seam; cannot disable actual-root detection. */
  treatProjectAsFilesystemRoot?: boolean
  /** Deterministic test seam after authoritative creation and before return hydration. */
  beforePostCommitHydration?: () => void
}): RunState {
  if (options.parentSessionId && options.parentSessionId !== options.ownerSessionId) {
    throw new StoreError("parentSessionId must equal the creating owner session")
  }
  const projectDirectory = canonicalDirectory(options.projectDirectory)
  const filesystemRoot = assertFilesystemRootAuthorized(
    projectDirectory,
    options.allowFilesystemRoot,
    "plan",
    options.treatProjectAsFilesystemRoot === true,
  )
  const graph = validateGraph(options.graph)
  const runId = options.runId ?? createRunId(options.goal)
  assertSafeId(runId, "run_id")
  ensureDir(projectRunsRoot(projectDirectory))
  const directory = runDir(projectDirectory, runId)
  try {
    mkdirSync(directory, { recursive: false })
  } catch (error) {
    throw new StoreError(`run directory already exists or could not be created: ${runId}`, { cause: error })
  }
  ensureDir(runContainedPath(projectDirectory, runId, "artifacts"))
  ensureDir(runContainedPath(projectDirectory, runId, "checks"))
  ensureDir(runContainedPath(projectDirectory, runId, "history"))
  ensureDir(runContainedPath(projectDirectory, runId, "sessions"))

  const timestamp = nowIso()
  const state = {
    schema_version: ALG_SCHEMA_VERSION,
    revision: 1,
    run_id: runId,
    owner_session_id: options.ownerSessionId,
    parent_session_id: options.parentSessionId ?? options.ownerSessionId,
    owner_transfers: [],
    project_directory: projectDirectory,
    goal: options.goal,
    criteria: options.criteria,
    criteria_locked: options.criteria.length > 0,
    graph,
    status: "planning",
    phase: "plan",
    nodes: initNodeStates(graph),
    global_attempts: 0,
    created_at: timestamp,
    updated_at: timestamp,
    mode: options.mode ?? "live",
    model_snapshot: options.modelSnapshot ?? {},
    ...(options.modelResolution ? { model_resolution: options.modelResolution } : {}),
    ...(filesystemRoot ? {
      filesystem_root_authorizations: [{
        operation: "plan" as const,
        by_session_id: options.ownerSessionId,
        authorized_at: timestamp,
        authorized: true as const,
        path: projectDirectory,
      }],
    } : {}),
    session_isolation: "sdk-child-session",
  } satisfies RunState

  const runtimeValidated = parseRunStateForProjection(state)
  const projection = projectRunState(runtimeValidated)
  const validated = parseRunState(projection.state)
  let committed = false
  try {
    const mirror = acquireMirrorLock(projectDirectory, runId)
    try {
      writeDerivedFiles(runtimeValidated, projection, false)
      writeProgressJson(runContainedPath(projectDirectory, runId, "progress.json"), validated, false)
      committed = true
      runPostCommitGc(runtimeValidated, projection)
      refreshOwnerRunIndex(projectDirectory, validated.owner_session_id, {
        run_id: validated.run_id,
        updated_at: validated.updated_at,
      })
    } finally {
      mirror.release()
    }
    try {
      options.beforePostCommitHydration?.()
      return hydrateVisibleRunData(validated)
    } catch (maintenanceError) {
      // The manifest already committed. Re-read and validate the authoritative
      // tree rather than reporting a false create failure for a transient return
      // hydration problem. A genuinely invalid committed tree still fails.
      const loaded = readAuthoritativeRun(projectDirectory, runId)
      if (!loaded) throw maintenanceError
      return loaded
    }
  } catch (error) {
    if (!committed) rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

function assertStateProject(state: RunState, expectedProjectDirectory: string): string {
  const expected = canonicalDirectory(expectedProjectDirectory)
  const embedded = canonicalDirectory(state.project_directory)
  if (expected !== embedded) {
    throw new StoreError("run state project_directory does not match the caller's project root")
  }
  return expected
}

export interface PersistRunOptions {
  /** Testable fault injection point; production callers leave this unset. */
  beforeDerivedWrite?: (path: string) => void
  afterMirrorLock?: () => void
  beforeProgressCommit?: () => void
  beforeProgressCurrentRename?: AtomicWriteFileHooks["beforeCurrentRename"]
  beforeProgressBackupRename?: AtomicWriteFileHooks["beforeBackupRename"]
  /** Deterministic test seam inside non-authoritative post-commit maintenance. */
  beforePostCommitGc?: () => void
}

interface DerivedEntry {
  value?: unknown
  reference?: RunDataReference
  /** Copy already-verified immutable bytes into an independent convenience mirror. */
  sourceReference?: RunDataReference
}

interface ExpectedDerived {
  artifacts: Map<string, DerivedEntry>
  checks: Map<string, DerivedEntry>
  histories: Map<string, DerivedEntry>
}

function referenceName(reference: RunDataReference): string {
  return reference.artifact_path.split("/").at(-1)!
}

function projectedAttempts(
  projection: ReturnType<typeof projectRunState>,
  nodeId: string,
): NodeAttempt[] {
  const archived = projection.histories.get(nodeId)?.attempts ?? []
  return [...archived, ...projection.state.nodes[nodeId]!.attempts]
}

function expectedDerived(
  runtime: RunState,
  projection: ReturnType<typeof projectRunState>,
): ExpectedDerived {
  const artifacts = new Map<string, DerivedEntry>()
  const checks = new Map<string, DerivedEntry>()
  const histories = new Map<string, DerivedEntry>()
  for (const [id, node] of Object.entries(runtime.nodes)) {
    assertSafeId(id, "node_id")
    const projectedNode = projection.state.nodes[id]!
    if (projectedNode.output_ref) {
      artifacts.set(referenceName(projectedNode.output_ref), {
        ...(node.output !== undefined ? { value: node.output } : {}),
        reference: projectedNode.output_ref,
      })
      if (node.output !== undefined) {
        artifacts.set(`${id}.json`, { value: node.output, sourceReference: projectedNode.output_ref })
      }
    }
    const runtimeByAttempt = new Map(node.attempts.map((attempt) => [attempt.attempt, attempt]))
    for (const attempt of projectedAttempts(projection, id)) {
      const full = runtimeByAttempt.get(attempt.attempt)
      if (attempt.output_ref) {
        artifacts.set(referenceName(attempt.output_ref), {
          ...(full?.output !== undefined ? { value: full.output } : {}),
          reference: attempt.output_ref,
        })
        if (full?.output !== undefined) {
          artifacts.set(`${id}-attempt-${attempt.attempt}.json`, {
            value: full.output,
            sourceReference: attempt.output_ref,
          })
        }
      }
      if (attempt.detail_ref) {
        histories.set(referenceName(attempt.detail_ref), {
          ...(full && attemptHasCompleteDetail(full) ? { value: attemptDetailDocument(full) } : {}),
          reference: attempt.detail_ref,
        })
        if (full && attemptHasCompleteDetail(full)) {
          histories.set(`${id}-attempt-${attempt.attempt}.json`, {
            value: attemptDetailDocument(full),
            sourceReference: attempt.detail_ref,
          })
        }
      }
      if (node.agent === "checker") {
        checks.set(`${id}-attempt-${attempt.attempt}.json`, {
          ...(full ? { value: full.output ?? full } : {}),
        })
      }
    }
    const history = projection.histories.get(id)
    if (history) {
      const reference = projection.state.nodes[id]!.attempt_history_ref!
      histories.set(referenceName(reference), { value: history, reference })
      histories.set(`${id}-attempts.json`, { value: history, sourceReference: reference })
    } else if (projectedNode.attempt_history_ref) {
      histories.set(referenceName(projectedNode.attempt_history_ref), {
        reference: projectedNode.attempt_history_ref,
      })
    }
    if (projectedNode.last_failures_ref) {
      const hasCompleteFailures = node.last_failures_ref === undefined ||
        node.last_failures_ref.artifact_path !== projectedNode.last_failures_ref.artifact_path
      histories.set(referenceName(projectedNode.last_failures_ref), {
        ...(hasCompleteFailures ? { value: node.last_failures } : {}),
        reference: projectedNode.last_failures_ref,
      })
      if (hasCompleteFailures) {
        histories.set(`${id}-failures.json`, {
          value: node.last_failures,
          sourceReference: projectedNode.last_failures_ref,
        })
      }
    }
  }
  if (projection.state.filesystem_root_authorizations_ref) {
    histories.set(referenceName(projection.state.filesystem_root_authorizations_ref), {
      ...(projection.rootAuthorizations ? { value: projection.rootAuthorizations } : {}),
      reference: projection.state.filesystem_root_authorizations_ref,
    })
  }
  return { artifacts, checks, histories }
}

function localReferencePath(state: RunState, reference: RunDataReference): string {
  const parts = reference.artifact_path.split("/")
  if (parts[0] !== ".opencode" || parts[1] !== "runs" || parts[2] !== state.run_id) {
    throw new StoreError("derived reference belongs to a different run")
  }
  return runContainedPath(state.project_directory, state.run_id, ...parts.slice(3))
}

function readAndVerifyReference(state: RunState, reference: RunDataReference): unknown {
  const path = localReferencePath(state, reference)
  const maximumFileBytes = Math.min(MAX_STATE_BYTES, Math.max(reference.byte_size * 2 + 8_192, 16_384))
  let fileBytes: number
  try {
    fileBytes = statSync(path).size
  } catch (error) {
    throw new StoreError(`referenced JSON file is missing or inaccessible: ${reference.artifact_path}`, { cause: error })
  }
  if (fileBytes > maximumFileBytes) throw new StoreError(`referenced JSON file is unexpectedly large: ${reference.artifact_path}`)
  const immutableName = reference.artifact_path.endsWith(`-${reference.sha256}.json`)
  if (immutableName && fileBytes !== reference.byte_size) {
    throw new StoreError(`referenced immutable JSON size mismatch: ${reference.artifact_path}`)
  }
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch (error) {
    throw new StoreError(`referenced JSON is not valid: ${reference.artifact_path}`, { cause: error })
  }
  if (serializedBytes(value) !== reference.byte_size || sha256Json(value) !== reference.sha256) {
    throw new StoreError(`referenced JSON integrity mismatch: ${reference.artifact_path}`)
  }
  return value
}

function runReferences(state: RunState): RunDataReference[] {
  const references: RunDataReference[] = []
  if (state.filesystem_root_authorizations_ref) {
    references.push(state.filesystem_root_authorizations_ref)
  }
  for (const node of Object.values(state.nodes)) {
    for (const reference of [
      node.output_ref,
      node.attempt_history_ref,
      node.last_failures_ref,
      ...node.attempts.flatMap((attempt) => [attempt.output_ref, attempt.detail_ref]),
    ]) {
      if (reference) references.push(reference)
    }
  }
  return references
}

function protectedReferencePaths(
  state: RunState,
  previous?: RunState,
): { paths: Set<string>; uncertainBackup: boolean } {
  const paths = new Set<string>()
  let uncertainBackup = false
  const addManifest = (manifest: RunState): void => {
    for (const reference of runReferences(manifest)) paths.add(reference.artifact_path)
    for (const node of Object.values(manifest.nodes)) {
      if (!node.attempt_history_ref) continue
      try {
        const document = readAttemptHistoryDocument(manifest, node.id)
        if (!document) throw new Error("history is missing")
        for (const attempt of document.attempts) {
          if (attempt.output_ref) paths.add(attempt.output_ref.artifact_path)
          if (attempt.detail_ref) paths.add(attempt.detail_ref.artifact_path)
        }
      } catch {
        uncertainBackup = true
      }
    }
  }
  if (previous) addManifest(previous)
  const backupPath = runContainedPath(state.project_directory, state.run_id, "progress.json.bak")
  if (!existsSync(backupPath)) return { paths, uncertainBackup }
  try {
    const backup = parseRunState(readBoundedJson(backupPath))
    assertStateProject(backup, state.project_directory)
    if (backup.run_id !== state.run_id) throw new StoreError("backup run id mismatch")
    addManifest(backup)
    return { paths, uncertainBackup }
  } catch {
    // An unverifiable recovery manifest disables potentially colliding legacy
    // mirror writes. Publication may continue because immutable references do
    // not reuse those fixed paths; GC is independently deferred below.
    return { paths, uncertainBackup: true }
  }
}

function writeReferencedEntries(
  state: RunState,
  entries: Map<string, DerivedEntry>,
  directory: "artifacts" | "history",
  beforeWrite?: (path: string) => void,
): void {
  for (const [name, entry] of entries) {
    if (!entry.reference) continue
    const path = runContainedPath(state.project_directory, state.run_id, directory, name)
    if (entry.value !== undefined) {
      if (serializedBytes(entry.value) !== entry.reference.byte_size ||
        sha256Json(entry.value) !== entry.reference.sha256) {
        throw new StoreError(`derived value does not match candidate reference: ${entry.reference.artifact_path} ` +
          `(expected ${entry.reference.byte_size}/${entry.reference.sha256}, got ${serializedBytes(entry.value)}/${sha256Json(entry.value)})`)
      }
      if (existsSync(path)) {
        // Content-addressed files are immutable. A mismatched existing object
        // is never repaired in place because an older manifest may reach it.
        readAndVerifyReference(state, entry.reference)
        continue
      }
      beforeWrite?.(path)
      writeImmutableJson(path, entry.value)
      readAndVerifyReference(state, entry.reference)
    } else {
      readAndVerifyReference(state, entry.reference)
    }
  }
}

function couldBeLegacyReference(directory: "artifacts" | "checks" | "history", name: string): boolean {
  if (directory === "checks") return false
  if (directory === "artifacts") return /-attempt-\d+\.json$/.test(name)
  return /(?:-attempt-\d+|-attempts|-failures)\.json$/.test(name)
}

function mirrorHashesForState(state: RunState | undefined): Map<string, string> {
  const hashes = new Map<string, string>()
  if (!state) return hashes
  for (const node of Object.values(state.nodes)) {
    if (node.output_ref) hashes.set(`artifacts/${node.id}.json`, node.output_ref.sha256)
    if (node.attempt_history_ref) {
      hashes.set(`history/${node.id}-attempts.json`, node.attempt_history_ref.sha256)
    }
    if (node.last_failures_ref) {
      hashes.set(`history/${node.id}-failures.json`, node.last_failures_ref.sha256)
    }
    for (const attempt of node.attempts) {
      if (attempt.output_ref) {
        hashes.set(`artifacts/${node.id}-attempt-${attempt.attempt}.json`, attempt.output_ref.sha256)
      }
      if (attempt.detail_ref) {
        hashes.set(`history/${node.id}-attempt-${attempt.attempt}.json`, attempt.detail_ref.sha256)
      }
      if (node.agent === "checker") {
        const reference = attempt.output_ref ?? attempt.detail_ref
        if (reference) hashes.set(`checks/${node.id}-attempt-${attempt.attempt}.json`, reference.sha256)
      }
    }
  }
  return hashes
}

function writeMirrorEntries(
  state: RunState,
  entries: Map<string, DerivedEntry>,
  directory: "artifacts" | "checks" | "history",
  protectedPaths: Set<string>,
  uncertainBackup: boolean,
  previousHashes: Map<string, string>,
  beforeWrite?: (path: string) => void,
): void {
  for (const [name, entry] of entries) {
    if (entry.reference || entry.value === undefined) continue
    const relative = `.opencode/runs/${state.run_id}/${directory}/${name}`
    if (protectedPaths.has(relative) || (uncertainBackup && couldBeLegacyReference(directory, name))) continue
    const path = runContainedPath(state.project_directory, state.run_id, directory, name)
    const expectedHash = sha256Json(entry.value)
    if (existsSync(path)) {
      if (previousHashes.get(`${directory}/${name}`) === expectedHash) continue
      try {
        if (statSync(path).size <= MAX_STATE_BYTES &&
          sha256Json(JSON.parse(readFileSync(path, "utf8"))) === expectedHash) continue
      } catch {
        // A malformed convenience mirror is replaced from authoritative data.
      }
    }
    beforeWrite?.(path)
    const source = entry.sourceReference
      ? localReferencePath(state, entry.sourceReference)
      : undefined
    if (source && existsSync(source)) {
      const temporary = resolveContainedPath(
        dirname(path),
        `.${basename(path)}.${process.pid}-${randomUUID()}.link.tmp`,
      )
      try {
        // Never hard-link a mutable convenience path to immutable content: an
        // external in-place mirror write must not be able to corrupt a hash path.
        copyFileSync(source, temporary)
        renameSync(temporary, path)
      } finally {
        rmSync(temporary, { force: true })
      }
    } else {
      writeJson(path, entry.value)
    }
  }
}

function writeDerivedFiles(
  runtime: RunState,
  projection: ReturnType<typeof projectRunState>,
  backup: boolean,
  beforeWrite?: (path: string) => void,
  previous?: RunState,
  reusePreviousMirrors = true,
  publishReferences = true,
): void {
  const protectedReferences = protectedReferencePaths(runtime, previous)
  const previousMirrorHashes = reusePreviousMirrors ? mirrorHashesForState(previous) : new Map<string, string>()
  const expected = expectedDerived(runtime, projection)

  // Publish and verify every immutable object before any fixed convenience
  // mirror is touched and before progress.json can advance.
  if (publishReferences) {
    writeReferencedEntries(runtime, expected.artifacts, "artifacts", beforeWrite)
    writeReferencedEntries(runtime, expected.histories, "history", beforeWrite)
    if (projection.state.graph.nodes.some((definition) =>
      projection.state.nodes[definition.id]!.attempt_history_ref && !projection.histories.has(definition.id))) {
      // Reused archives indirectly reference attempt details and outputs that
      // are not present in the projected tail. Validate the complete tree
      // before allowing a new authoritative manifest to reuse it.
      hydrateRunFully(projection.state)
    }
  } else {
    // Visible output/detail/failure references were already checked while
    // loading. Validate the one intentionally non-hydrated archive reference
    // without materializing its attempts into compact runtime state.
    for (const node of Object.values(runtime.nodes)) {
      if (node.attempt_history_ref) readAndVerifyReference(runtime, node.attempt_history_ref)
    }
  }
  inspectDerivedDirectoryForContainment(runtime, "artifacts")
  inspectDerivedDirectoryForContainment(runtime, "history")

  const graphPath = runContainedPath(runtime.project_directory, runtime.run_id, "graph.json")
  if (!reusePreviousMirrors || !previous || sha256Json(previous.graph) !== sha256Json(runtime.graph)) {
    let graphMatches = false
    if (existsSync(graphPath)) {
      try {
        graphMatches = statSync(graphPath).size <= MAX_STATE_BYTES &&
          sha256Json(JSON.parse(readFileSync(graphPath, "utf8"))) === sha256Json(runtime.graph)
      } catch {
        graphMatches = false
      }
    }
    if (!graphMatches) {
      beforeWrite?.(graphPath)
      const graphBackup = `${graphPath}.bak`
      let restored = false
      if (existsSync(graphBackup)) {
        try {
          const backupBytes = readFileSync(graphBackup, "utf8")
          if (sha256Json(JSON.parse(backupBytes)) === sha256Json(runtime.graph)) {
            atomicWriteFile(graphPath, backupBytes)
            restored = true
          }
        } catch {
          restored = false
        }
      }
      if (!restored) writeJson(graphPath, runtime.graph, backup)
    }
  }
  const criteriaPath = runContainedPath(runtime.project_directory, runtime.run_id, "criteria.md")
  if (!reusePreviousMirrors || !previous || previous.goal !== runtime.goal || previous.criteria_locked !== runtime.criteria_locked ||
    !isDeepStrictEqual(previous.criteria, runtime.criteria)) {
    const criteria = formatCriteriaMd(runtime)
    if (!existsSync(criteriaPath) || readFileSync(criteriaPath, "utf8") !== criteria) {
      beforeWrite?.(criteriaPath)
      const criteriaBackup = `${criteriaPath}.bak`
      if (existsSync(criteriaBackup) && readFileSync(criteriaBackup, "utf8") === criteria) {
        atomicWriteFile(criteriaPath, readFileSync(criteriaBackup, "utf8"))
      } else {
        atomicWriteFile(criteriaPath, criteria, backup)
      }
    }
  }

  writeMirrorEntries(
    runtime,
    expected.artifacts,
    "artifacts",
    protectedReferences.paths,
    protectedReferences.uncertainBackup,
    previousMirrorHashes,
    beforeWrite,
  )
  writeMirrorEntries(
    runtime,
    expected.checks,
    "checks",
    protectedReferences.paths,
    protectedReferences.uncertainBackup,
    previousMirrorHashes,
    beforeWrite,
  )
  writeMirrorEntries(
    runtime,
    expected.histories,
    "history",
    protectedReferences.paths,
    protectedReferences.uncertainBackup,
    previousMirrorHashes,
    beforeWrite,
  )
}

const MAX_GC_SCAN_ENTRIES = 1_024

function recoveryReachablePaths(state: RunState): Set<string> | null {
  const reachable = new Set<string>()
  const progressPaths = [
    runContainedPath(state.project_directory, state.run_id, "progress.json"),
    runContainedPath(state.project_directory, state.run_id, "progress.json.bak"),
  ]
  for (const [index, path] of progressPaths.entries()) {
    if (!existsSync(path)) {
      if (index === 0) return null
      continue
    }
    let manifest: RunState
    try {
      manifest = parseRunState(readBoundedJson(path))
      assertStateProject(manifest, state.project_directory)
      if (manifest.run_id !== state.run_id) return null
    } catch {
      return null
    }
    for (const reference of runReferences(manifest)) reachable.add(reference.artifact_path)
    for (const [nodeId, node] of Object.entries(manifest.nodes)) {
      if (!node.attempt_history_ref) continue
      try {
        const document = readAttemptHistoryDocument(manifest, nodeId)
        if (!document) return null
        for (const attempt of document.attempts) {
          if (attempt.output_ref) reachable.add(attempt.output_ref.artifact_path)
          if (attempt.detail_ref) reachable.add(attempt.detail_ref.artifact_path)
        }
      } catch {
        return null
      }
    }
  }
  return reachable
}

function inspectDerivedDirectoryForContainment(
  state: RunState,
  directory: "artifacts" | "history",
): void {
  const root = runContainedPath(state.project_directory, state.run_id, directory)
  ensureDir(root)
  const handle = opendirSync(root)
  try {
    for (let scanned = 0; scanned < MAX_GC_SCAN_ENTRIES; scanned++) {
      const entry = handle.readSync()
      if (!entry) break
      // Unknown entries are never deleted, but every observed existing
      // component is still realpath-checked so a nested junction cannot turn
      // later mirror/artifact metadata into an escape route.
      resolveContainedPath(root, entry.name)
    }
  } finally {
    handle.closeSync()
  }
}

function removeStaleDerivedFiles(
  runtime: RunState,
  _projection: ReturnType<typeof projectRunState>,
): void {
  const reachable = recoveryReachablePaths(runtime)
  if (!reachable) return
  // Reachability is proven before this post-commit phase, including nested
  // archive references. Without a durable ownership ledger, however, an
  // unreferenced hash-shaped filename cannot be distinguished from a user
  // file. Defer deletion rather than risk touching unknown content.
  void reachable
  inspectDerivedDirectoryForContainment(runtime, "artifacts")
  inspectDerivedDirectoryForContainment(runtime, "history")
}

function runPostCommitGc(
  runtime: RunState,
  projection: ReturnType<typeof projectRunState>,
  beforeGc?: () => void,
): void {
  try {
    beforeGc?.()
    removeStaleDerivedFiles(runtime, projection)
  } catch {
    // progress.json is already authoritative. GC is conservative,
    // non-authoritative maintenance: an unverifiable candidate is retained and
    // a containment/opendir/realpath/permission failure cannot turn a committed
    // save into a reported failure.
  }
}

function reconcileDerivedFilesUnlocked(state: RunState): void {
  const projection = projectRunState(state)
  writeDerivedFiles(state, projection, false, undefined, state, false, false)
  removeStaleDerivedFiles(state, projection)
}

/**
 * Expand every retained projected reference before publishing a new manifest.
 * This deliberately keeps complete caller-supplied fields authoritative (an
 * executor may have replaced a prior output) while materializing every value
 * that exists only behind a reference. projectRunState can then derive a
 * wholly new full-SHA reference tree, children before parent archives.
 */
function prepareRunForImmutableCommit(candidate: RunState, current: RunState): RunState {
  // `candidate` is already the detached result of the precommit structured-clone
  // guard and schema parsing. It is safe to materialize retained references in
  // place instead of performing another full graph clone.
  const prepared = candidate
  for (const definition of prepared.graph.nodes) {
    const node = prepared.nodes[definition.id]!
    if (node.attempt_history_ref) {
      const history = readAttemptHistoryDocument(prepared, definition.id, current.owner_session_id)
      const archived = history?.attempts ?? []
      const hydratedArchived = archived.map((attempt) => hydrateAttemptData(
        prepared,
        definition.id,
        node.agent,
        attempt,
        false,
      ))
      node.attempts = [...hydratedArchived, ...node.attempts]
      node.attempt_history_ref = undefined
    }
    node.attempts = node.attempts.map((attempt) => {
      const referenceOnlyOutput = attempt.output_ref !== undefined && attempt.output === undefined
      if (!attemptHasCompleteDetail(attempt) || referenceOnlyOutput) {
        return hydrateAttemptData(prepared, definition.id, node.agent, attempt, false)
      }
      return attempt
    })
    if (node.output_ref && node.output === undefined) {
      const output = readAndVerifyReference(prepared, node.output_ref)
      node.output = parseReferencedAgentOutput(node.agent, output, node.output_ref, "node artifact")
      node.output_ref = undefined
    }
    if (node.last_failures_ref &&
      (node.last_failures_omitted !== undefined || node.last_failure_texts_truncated !== undefined)) {
      hydrateNodeFailures(prepared, definition.id)
      node.last_failures_ref = undefined
    }
    // Persist only schema-canonical output. This materializes defaults and any
    // other accepted transforms before references and hashes are derived.
    for (const attempt of node.attempts) {
      if (attempt.output === undefined) continue
      const parsed = schemaForAgent(node.agent).safeParse(attempt.output)
      if (!parsed.success) throw new StoreError(`attempt artifact violates ${node.agent} output schema`)
      attempt.output = parsed.data
    }
    if (node.output !== undefined) {
      const parsed = schemaForAgent(node.agent).safeParse(node.output)
      if (!parsed.success) throw new StoreError(`node artifact violates ${node.agent} output schema`)
      node.output = parsed.data
    }
  }

  if (prepared.filesystem_root_authorizations_ref) {
    const reference = prepared.filesystem_root_authorizations_ref
    const document = readRootAuthorizationHistoryDocument(prepared, current.owner_session_id)!
    const oldTail = document.authorizations.slice(-MAX_PROJECTED_ROOT_AUTHORIZATIONS)
    const retainedAndAppended = prepared.filesystem_root_authorizations ?? []
    if (retainedAndAppended.length < oldTail.length ||
      !isDeepStrictEqual(retainedAndAppended.slice(0, oldTail.length), oldTail) ||
      (prepared.filesystem_root_authorizations_omitted ?? 0) !==
        reference.authorization_count - oldTail.length) {
      throw new StoreError(`filesystem root authorization projection mismatch: ${reference.artifact_path}`)
    }
    prepared.filesystem_root_authorizations = [
      ...document.authorizations,
      ...retainedAndAppended.slice(oldTail.length),
    ]
    prepared.filesystem_root_authorizations_ref = undefined
    prepared.filesystem_root_authorizations_omitted = undefined
  }
  prepared.state_projection = undefined
  return parseRunStateForProjection(prepared)
}

/**
 * Keep the caller's long-lived object aligned with the authoritative save.
 *
 * The caller receives the same hydrated, bounded execution form as loadRun:
 * canonical visible values are materialized alongside only their freshly
 * committed references, while archived attempts/root history remain projected
 * behind those committed references. This is preferable to the compact
 * progress.json projection because an executor can immediately route outputs
 * and continue mutating node state. hydrateVisibleRunData intentionally removes
 * state_projection because its omission counters describe the compact manifest,
 * not this hydrated execution view.
 */
interface ObjectSynchronization {
  target: object
  structure: PersistenceObjectSnapshot
  data: ReadonlyMap<string, unknown>
  label: string
}

interface ArraySynchronization<T> {
  target: T[]
  structure: PersistenceObjectSnapshot
  values: T[]
  label: string
}

interface CommittedExecutionSynchronization {
  mutations: SynchronizationMutation[]
}

type SynchronizationMutation =
  | { kind: "delete"; target: object; key: PropertyKey; label: string }
  | { kind: "define"; target: object; key: string; value: unknown; label: string }
  | { kind: "set"; target: object; key: string; value: unknown; label: string }

interface PersistencePropertySnapshot {
  key: PropertyKey
  value: unknown
  writable: boolean
  enumerable: boolean
  configurable: boolean
}

interface PersistenceObjectSnapshot {
  target: object
  path: string
  prototype: object | null
  array: boolean
  extensible: boolean
  properties: PersistencePropertySnapshot[]
}

interface PersistenceStructuralSnapshot {
  root: unknown
  objects: PersistenceObjectSnapshot[]
  byIdentity: WeakMap<object, PersistenceObjectSnapshot>
}

// This guard runs before schema parsing, so it must impose its own finite work
// bound even on hostile caller objects. Valid persisted state is independently
// capped at five MiB and is far below these structural ceilings.
const MAX_PERSISTENCE_SNAPSHOT_OBJECTS = 500_000
const MAX_PERSISTENCE_SNAPSHOT_PROPERTIES = 2_000_000
const MAX_PERSISTENCE_SNAPSHOT_DEPTH = 512

/**
 * Validate supported caller state exclusively through own-property
 * descriptors. Accessors and custom prototypes are rejected without invoking
 * getters. Independently synchronized caller identities must also be unique so
 * one object can never receive conflicting post-commit copyback plans.
 *
 * Sharing below those mutable synchronization roots (for example, one output
 * value referenced by both its node and latest attempt) is deliberate: those
 * values are read-only inputs to canonicalization and are replaced, not mutated,
 * during copyback.
 */
function snapshotPlainPersistenceData(value: unknown, label = "run"): PersistenceStructuralSnapshot {
  const seen = new WeakSet<object>()
  const active = new WeakSet<object>()
  const synchronizationTargets = new WeakMap<object, string>()
  const byIdentity = new WeakMap<object, PersistenceObjectSnapshot>()
  const objects: PersistenceObjectSnapshot[] = []
  let propertyCount = 0

  const synchronizationPath = (segments: string[]): string | undefined => {
    if (segments.length === 0) return "run"
    if (segments.length === 1 && segments[0] === "nodes") return "run.nodes"
    if (segments.length === 2 && segments[0] === "nodes") {
      return `run.nodes[${JSON.stringify(segments[1])}]`
    }
    if (segments.length === 3 && segments[0] === "nodes" && segments[2] === "attempts") {
      return `run.nodes[${JSON.stringify(segments[1])}].attempts`
    }
    if (segments.length === 4 && segments[0] === "nodes" && segments[2] === "attempts" && /^\d+$/.test(segments[3]!)) {
      return `run.nodes[${JSON.stringify(segments[1])}].attempts[${segments[3]}]`
    }
    return undefined
  }

  const inspect = (candidate: unknown, path: string, segments: string[]): void => {
    if (segments.length > MAX_PERSISTENCE_SNAPSHOT_DEPTH) {
      throw new StoreError(`persistence plain-data validation exceeded the bounded depth limit at ${path}`)
    }
    if (candidate === null || typeof candidate !== "object") {
      if (typeof candidate === "symbol" || typeof candidate === "function") {
        throw new StoreError(`persistence requires plugin-produced plain data: ${path} is unsupported`)
      }
      return
    }
    const synchronizedPath = synchronizationPath(segments)
    if (synchronizedPath) {
      const priorPath = synchronizationTargets.get(candidate)
      if (priorPath && priorPath !== synchronizedPath) {
        throw new StoreError(
          `persistence synchronization targets must not share object identity: ${synchronizedPath} aliases ${priorPath}`,
        )
      }
      synchronizationTargets.set(candidate, synchronizedPath)
    }
    if (active.has(candidate)) {
      throw new StoreError(`persistence requires plugin-produced plain data: ${path} is cyclic`)
    }
    if (seen.has(candidate)) return
    let prototype: object | null
    let keys: PropertyKey[]
    try {
      prototype = Object.getPrototypeOf(candidate)
      keys = Reflect.ownKeys(candidate)
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : ""
      throw new StoreError(`persistence plain-data validation failed before commit at ${path}${detail}`, { cause: error })
    }
    const array = Array.isArray(candidate)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new StoreError(`persistence requires plugin-produced plain data: ${path} has an unsupported prototype`)
    }
    if (objects.length >= MAX_PERSISTENCE_SNAPSHOT_OBJECTS) {
      throw new StoreError("persistence plain-data validation exceeded the bounded object limit")
    }
    propertyCount += keys.length
    if (propertyCount > MAX_PERSISTENCE_SNAPSHOT_PROPERTIES) {
      throw new StoreError("persistence plain-data validation exceeded the bounded property limit")
    }
    let extensible: boolean
    try {
      extensible = Object.isExtensible(candidate)
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : ""
      throw new StoreError(`persistence plain-data validation failed before commit at ${path}${detail}`, { cause: error })
    }
    const objectSnapshot: PersistenceObjectSnapshot = {
      target: candidate,
      path,
      prototype,
      array,
      extensible,
      properties: [],
    }
    objects.push(objectSnapshot)
    byIdentity.set(candidate, objectSnapshot)
    seen.add(candidate)
    active.add(candidate)
    try {
      for (const key of keys) {
        let descriptor: PropertyDescriptor | undefined
        try {
          descriptor = Object.getOwnPropertyDescriptor(candidate, key)
        } catch (error) {
          const detail = error instanceof Error ? `: ${error.message}` : ""
          throw new StoreError(`persistence plain-data validation failed before commit at ${path}.${String(key)}${detail}`, { cause: error })
        }
        if (!descriptor || !("value" in descriptor)) {
          throw new StoreError(`persistence requires plugin-produced plain data: accessor ${path}.${String(key)} is unsupported`)
        }
        objectSnapshot.properties.push({
          key,
          value: descriptor.value,
          writable: descriptor.writable === true,
          enumerable: descriptor.enumerable === true,
          configurable: descriptor.configurable === true,
        })
        if (array && key === "length") {
          continue
        }
        if (typeof key === "symbol") {
          if (descriptor.enumerable) {
            throw new StoreError(`persistence requires plugin-produced plain data: ${path} has a symbol data property`)
          }
          continue
        }
        const stringKey = String(key)
        inspect(descriptor.value, `${path}.${stringKey}`, [...segments, stringKey])
      }
    } finally {
      active.delete(candidate)
    }
  }
  inspect(value, label, [])
  return { root: value, objects, byIdentity }
}

/**
 * Materialize only captured enumerable string data into detached ordinary
 * shells. This lets the required structuredClone operate without touching the
 * caller again: a stateful Proxy trap cannot install an accessor on an earlier
 * parent and trick structuredClone into invoking it.
 */
function materializePersistenceSnapshot(snapshot: PersistenceStructuralSnapshot): unknown {
  if (snapshot.root === null || typeof snapshot.root !== "object") return snapshot.root
  const shells = new WeakMap<object, object>()
  for (const record of snapshot.objects) {
    shells.set(record.target, record.array ? [] : Object.create(record.prototype))
  }
  const detachedValue = (value: unknown): unknown =>
    value !== null && typeof value === "object" ? shells.get(value)! : value
  for (const record of snapshot.objects) {
    const shell = shells.get(record.target)!
    for (const property of record.properties) {
      if (!property.enumerable || typeof property.key !== "string") continue
      Reflect.defineProperty(shell, property.key, {
        value: detachedValue(property.value),
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
    if (record.array) {
      const length = record.properties.find((property) => property.key === "length")
      if (length) Reflect.defineProperty(shell, "length", { value: length.value })
    }
  }
  return shells.get(snapshot.root as object)!
}

function cloneValidatedPersistenceData<T>(snapshot: PersistenceStructuralSnapshot): T {
  try {
    return structuredClone(materializePersistenceSnapshot(snapshot)) as T
  } catch (error) {
    const rawDetail = error instanceof Error ? error.message : String(error)
    const detail = rawDetail.replace(/[\r\n]+/g, " ").slice(0, 512)
    throw new StoreError(
      `persistence structured-clone cloneability guard rejected unsupported caller data before commit${detail ? `: ${detail}` : ""}`,
      { cause: error },
    )
  }
}

function samePropertyKey(left: PropertyKey, right: PropertyKey): boolean {
  return typeof left === "symbol" || typeof right === "symbol"
    ? left === right
    : left === right
}

/**
 * Immediately prove that every captured parent edge, alias, own key, data
 * descriptor, primitive value, and object identity is still exact. Only
 * descriptor APIs are used; no caller getter can execute.
 */
function revalidatePersistenceSnapshot(snapshot: PersistenceStructuralSnapshot): void {
  // Children are checked before parents so a child Proxy trap that mutates its
  // already-visited parent is observed later in this same bounded pass.
  for (let recordIndex = snapshot.objects.length - 1; recordIndex >= 0; recordIndex--) {
    const record = snapshot.objects[recordIndex]!
    let prototype: object | null
    let keys: PropertyKey[]
    let extensible: boolean
    try {
      prototype = Object.getPrototypeOf(record.target)
      keys = Reflect.ownKeys(record.target)
      extensible = Object.isExtensible(record.target)
    } catch (error) {
      const detail = error instanceof Error ? `: ${error.message}` : ""
      throw new StoreError(
        `persistence caller graph changed during descriptor validation at ${record.path}${detail}`,
        { cause: error },
      )
    }
    if (prototype !== record.prototype || extensible !== record.extensible || keys.length !== record.properties.length ||
      keys.some((key, index) => !samePropertyKey(key, record.properties[index]!.key))) {
      throw new StoreError(`persistence caller graph changed during descriptor validation at ${record.path}`)
    }
    for (const expected of record.properties) {
      let descriptor: PropertyDescriptor | undefined
      try {
        descriptor = Object.getOwnPropertyDescriptor(record.target, expected.key)
      } catch (error) {
        const detail = error instanceof Error ? `: ${error.message}` : ""
        throw new StoreError(
          `persistence caller graph changed during descriptor validation at ${record.path}.${String(expected.key)}${detail}`,
          { cause: error },
        )
      }
      if (!descriptor || !("value" in descriptor) || descriptor.writable !== expected.writable ||
        descriptor.enumerable !== expected.enumerable || descriptor.configurable !== expected.configurable ||
        !Object.is(descriptor.value, expected.value)) {
        throw new StoreError(
          `persistence caller graph changed during descriptor validation at ${record.path}.${String(expected.key)}`,
        )
      }
    }
  }
}

function rejectCapturedProxies(snapshot: PersistenceStructuralSnapshot): void {
  const proxy = snapshot.objects.find((record) => utilTypes.isProxy(record.target))
  if (!proxy) return
  throw new StoreError(
    `persistence node:util types.isProxy guard rejected unsupported caller Proxy before commit at ${proxy.path}`,
  )
}

function snapshotForIdentity(
  snapshot: PersistenceStructuralSnapshot,
  target: object,
  label: string,
): PersistenceObjectSnapshot {
  const record = snapshot.byIdentity.get(target)
  if (!record) throw new StoreError(`committed-state synchronization preflight lost captured identity for ${label}`)
  return record
}

function snapshotDataValue(
  snapshot: PersistenceStructuralSnapshot,
  target: object,
  key: string,
  label: string,
  optional = false,
): unknown {
  const record = snapshotForIdentity(snapshot, target, label)
  const property = record.properties.find((candidate) => candidate.key === key)
  if (!property) {
    if (optional) return undefined
    throw new StoreError(
      `committed-state synchronization preflight failed before commit: ${label}.${key} is not a captured own data property`,
    )
  }
  return property.value
}

function canonicalOwnEnumerableStringData(
  source: object,
  label: string,
  overrides: ReadonlyMap<string, unknown> = new Map(),
): Map<string, unknown> {
  const data = new Map<string, unknown>()
  for (const key of Reflect.ownKeys(source)) {
    if (typeof key !== "string") {
      throw new StoreError(`committed-state synchronization source ${label} has a symbol property`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (!descriptor?.enumerable) continue
    if (!descriptor || !("value" in descriptor)) {
      throw new StoreError(
        `committed-state synchronization source ${label}.${key} is not an own enumerable data property`,
      )
    }
    data.set(key, descriptor.value)
  }
  for (const [key, value] of overrides) data.set(key, value)
  return data
}

function synchronizationKey(key: PropertyKey): string {
  return typeof key === "symbol" ? key.toString() : JSON.stringify(key)
}

function planCanonicalProperty(
  mutations: SynchronizationMutation[],
  target: object,
  key: string,
  value: unknown,
  descriptor: PropertyDescriptor | undefined,
  extensible: boolean,
  label: string,
): void {
  if (!descriptor) {
    if (!extensible) {
      throw new StoreError(
        `committed-state synchronization preflight failed before commit: non-extensible ${label} cannot receive ${JSON.stringify(key)}`,
      )
    }
    mutations.push({ kind: "define", target, key, value, label })
    return
  }
  if (!("value" in descriptor)) {
    throw new StoreError(
      `committed-state synchronization preflight failed before commit: canonical accessor ${JSON.stringify(key)} on ${label} is unsupported`,
    )
  }
  if (descriptor.configurable) {
    mutations.push({ kind: "define", target, key, value, label })
    return
  }
  if (descriptor.writable) {
    // JS invariants permit the exact value update without redefining the
    // non-configurable descriptor. Its enumerable/configurable flags stay put.
    mutations.push({ kind: "set", target, key, value, label })
    return
  }
  if (!Object.is(descriptor.value, value)) {
    throw new StoreError(
      `committed-state synchronization preflight failed before commit: non-writable non-configurable canonical property ${JSON.stringify(key)} on ${label} has an incompatible value`,
    )
  }
}

function planObjectSynchronization(
  plan: ObjectSynchronization,
  mutations: SynchronizationMutation[],
): void {
  const prototype = plan.structure.prototype
  if (prototype !== Object.prototype && prototype !== null) {
    throw new StoreError(
      `committed-state synchronization preflight failed before commit: ${plan.label} has an unsupported prototype`,
    )
  }
  const existing = new Set(plan.structure.properties.map((property) => property.key))
  const descriptors = new Map(plan.structure.properties.map((property) => [property.key, property] as const))
  const extensible = plan.structure.extensible
  for (const key of existing) {
    const descriptor = descriptors.get(key)
    if (!descriptor) {
      throw new StoreError(`committed-state synchronization preflight could not inspect ${plan.label}`)
    }
    const retainedCanonicalKey = typeof key === "string" && plan.data.has(key)
    if (!retainedCanonicalKey && !descriptor.configurable) {
      throw new StoreError(
        `committed-state synchronization preflight failed before commit: caller-injected non-configurable extension ${synchronizationKey(key)} on ${plan.label} is unsupported`,
      )
    }
    if (!retainedCanonicalKey) {
      mutations.push({ kind: "delete", target: plan.target, key, label: plan.label })
    }
  }
  for (const [key, value] of plan.data) {
    planCanonicalProperty(
      mutations,
      plan.target,
      key,
      value,
      descriptors.get(key),
      extensible,
      plan.label,
    )
  }
}

function planArraySynchronization(
  plan: ArraySynchronization<NodeAttempt>,
  mutations: SynchronizationMutation[],
): void {
  if (plan.structure.prototype !== Array.prototype || !plan.structure.array) {
    throw new StoreError(
      `committed-state synchronization preflight failed before commit: ${plan.label} has an unsupported prototype`,
    )
  }
  const descriptors = new Map(plan.structure.properties.map((property) => [property.key, property] as const))
  const length = descriptors.get("length")
  if (!length) {
    throw new StoreError(
      `committed-state synchronization preflight failed before commit: ${plan.label} is not mutable`,
    )
  }
  const existingLength = length.value as number
  const desired = new Set(plan.values.map((_, index) => String(index)))
  const extensible = plan.structure.extensible
  const deletions: SynchronizationMutation[] = []
  for (const key of plan.structure.properties.map((property) => property.key)) {
    if (key === "length" || (typeof key === "string" && desired.has(key))) continue
    const descriptor = descriptors.get(key)
    if (!descriptor) {
      throw new StoreError(`committed-state synchronization preflight could not inspect ${plan.label}`)
    }
    if (!descriptor.configurable) {
      throw new StoreError(
        `committed-state synchronization preflight failed before commit: non-configurable extension ${synchronizationKey(key)} on ${plan.label} is unsupported`,
      )
    }
    deletions.push({ kind: "delete", target: plan.target, key, label: plan.label })
  }
  if (length.writable !== true && plan.values.length !== existingLength) {
    throw new StoreError(
      `committed-state synchronization preflight failed before commit: non-writable ${plan.label}.length is incompatible`,
    )
  }
  deletions.sort((left, right) => {
    const a = typeof left.key === "string" && /^\d+$/.test(left.key) ? Number(left.key) : -1
    const b = typeof right.key === "string" && /^\d+$/.test(right.key) ? Number(right.key) : -1
    return b - a
  })
  mutations.push(...deletions)
  for (const [index, value] of plan.values.entries()) {
    const key = String(index)
    planCanonicalProperty(
      mutations,
      plan.target,
      key,
      value,
      descriptors.get(key),
      extensible && (length.writable === true || index < existingLength),
      plan.label,
    )
  }
  planCanonicalProperty(
    mutations,
    plan.target,
    "length",
    plan.values.length,
    length,
    extensible,
    plan.label,
  )
}

function committedExecutionSynchronization(
  snapshot: PersistenceStructuralSnapshot,
  committedExecution: RunState,
  committedFull: RunState,
): CommittedExecutionSynchronization {
  const target = snapshot.root as RunState
  const objects: ObjectSynchronization[] = []
  const arrays: ArraySynchronization<NodeAttempt>[] = []
  const targetNodes = snapshotDataValue(snapshot, target, "nodes", "run") as RunState["nodes"]
  const synchronizedNodes = Object.create(null) as Record<string, RunState["nodes"][string]>

  for (const [nodeId, committedNode] of Object.entries(committedExecution.nodes)) {
    const targetNode = snapshotDataValue(snapshot, targetNodes, nodeId, "nodes map", true) as RunState["nodes"][string] | undefined
    if (!targetNode) {
      synchronizedNodes[nodeId] = committedNode
      continue
    }
    const targetAttemptArray = snapshotDataValue(
      snapshot,
      targetNode,
      "attempts",
      `node ${JSON.stringify(nodeId)}`,
    ) as NodeAttempt[]
    const targetAttempts = new Map<number, NodeAttempt>()
    const targetAttemptLength = snapshotDataValue(
      snapshot,
      targetAttemptArray,
      "length",
      `node ${JSON.stringify(nodeId)} attempts array`,
    ) as number
    for (let index = 0; index < targetAttemptLength; index++) {
      const targetAttempt = snapshotDataValue(
        snapshot,
        targetAttemptArray,
        String(index),
        `node ${JSON.stringify(nodeId)} attempts array`,
      ) as NodeAttempt
      const attemptNumber = snapshotDataValue(
        snapshot,
        targetAttempt,
        "attempt",
        `node ${JSON.stringify(nodeId)} caller attempt ${index}`,
      ) as number
      if (targetAttempts.has(attemptNumber)) {
        throw new StoreError(
          `committed-state synchronization preflight failed before commit: duplicate caller attempt ${nodeId}/${attemptNumber}`,
        )
      }
      targetAttempts.set(attemptNumber, targetAttempt)
    }
    const committedByAttempt = new Map(
      committedFull.nodes[nodeId]!.attempts.map((attempt) => [attempt.attempt, attempt]),
    )
    // Preflight every caller attempt identity, including the prefix that the
    // committed visible tail archives. Detached prefix identities are still
    // replaced with their exact fully hydrated committed archived content.
    for (const [attemptNumber, targetAttempt] of targetAttempts) {
      const committedAttempt = committedByAttempt.get(attemptNumber)
      if (!committedAttempt) {
        throw new StoreError(
          `committed-state synchronization preflight failed before commit: caller attempt ${nodeId}/${attemptNumber} has no committed match`,
        )
      }
      objects.push({
        target: targetAttempt,
        structure: snapshotForIdentity(
          snapshot,
          targetAttempt,
          `node ${JSON.stringify(nodeId)} attempt ${attemptNumber}`,
        ),
        data: canonicalOwnEnumerableStringData(
          committedAttempt,
          `node ${JSON.stringify(nodeId)} attempt ${attemptNumber}`,
        ),
        label: `node ${JSON.stringify(nodeId)} attempt ${attemptNumber}`,
      })
    }
    const synchronizedAttempts = committedNode.attempts.map((committedAttempt) => {
      const targetAttempt = targetAttempts.get(committedAttempt.attempt)
      if (!targetAttempt) return committedAttempt
      return targetAttempt
    })
    arrays.push({
      target: targetAttemptArray,
      structure: snapshotForIdentity(snapshot, targetAttemptArray, `node ${JSON.stringify(nodeId)} attempts array`),
      values: synchronizedAttempts,
      label: `node ${JSON.stringify(nodeId)} attempts array`,
    })
    objects.push({
      target: targetNode,
      structure: snapshotForIdentity(snapshot, targetNode, `node ${JSON.stringify(nodeId)}`),
      data: canonicalOwnEnumerableStringData(
        committedNode,
        `node ${JSON.stringify(nodeId)}`,
        new Map([["attempts", targetAttemptArray]]),
      ),
      label: `node ${JSON.stringify(nodeId)}`,
    })
    synchronizedNodes[nodeId] = targetNode
  }

  objects.push({
    target: targetNodes,
    structure: snapshotForIdentity(snapshot, targetNodes, "nodes map"),
    data: canonicalOwnEnumerableStringData(synchronizedNodes, "nodes map"),
    label: "nodes map",
  })
  objects.push({
    target,
    structure: snapshotForIdentity(snapshot, target, "run"),
    data: canonicalOwnEnumerableStringData(
      committedExecution,
      "run",
      new Map([["nodes", targetNodes]]),
    ),
    label: "run",
  })
  const mutations: SynchronizationMutation[] = []
  for (const object of objects) planObjectSynchronization(object, mutations)
  for (const array of arrays) planArraySynchronization(array, mutations)
  return { mutations }
}

function synchronizeCommittedExecutionState(plan: CommittedExecutionSynchronization): void {
  // Active executor code retains its current node and attempt while a checkpoint
  // is saved (for example, until a child-session callback completes). Preserve
  // those identities while replacing all of their fields, not just a selected
  // copyback list. Every operation and value was fixed before the boundary; no
  // postcommit key enumeration, descriptor inspection, getter, or splice occurs.
  for (const mutation of plan.mutations) {
    let applied: boolean
    if (mutation.kind === "delete") {
      applied = Reflect.deleteProperty(mutation.target, mutation.key)
    } else if (mutation.kind === "set") {
      // Define the captured non-configurable writable data property directly;
      // unlike assignment, this can never invoke a subsequently installed
      // setter on a configurable caller property.
      applied = Reflect.defineProperty(mutation.target, mutation.key, { value: mutation.value })
    } else {
      applied = Reflect.defineProperty(mutation.target, mutation.key, {
        value: mutation.value,
        writable: true,
        enumerable: true,
        configurable: true,
      })
    }
    if (!applied) {
      throw new StoreError(
        `prevalidated committed-state mutation ${mutation.kind} failed for ${synchronizationKey(mutation.key)} on ${mutation.label}`,
      )
    }
  }
}

export function reconcileDerivedFiles(state: RunState): void {
  const mirror = acquireMirrorLock(state.project_directory, state.run_id)
  try {
    const authoritative = readAuthoritativeRun(state.project_directory, state.run_id)
    if (!authoritative) throw new StoreError(`run ${state.run_id} no longer exists`)
    reconcileDerivedFilesUnlocked(authoritative)
  } finally {
    mirror.release()
  }
}

function persistRunInternal(
  state: RunState,
  expectedProjectDirectory: string,
  options: PersistRunOptions = {},
  progressCommitBoundaryFence?: () => void,
): RunState {
  // Capture every descriptor and parent/child identity without getters, clone
  // only the detached descriptor materialization, immediately prove the
  // original graph is unchanged, and explicitly reject every captured Proxy
  // with node:util types.isProxy. Post-validation catches stateful traps that
  // replace a Proxy in its parent or install an accessor on a visited property;
  // structuredClone supplies detached cloneability/data isolation, not Proxy
  // detection.
  // From this point through commit, candidate work uses only safeState; the
  // original is referenced solely by a fully precomputed copyback plan.
  const originalSnapshot = snapshotPlainPersistenceData(state)
  const safeState = cloneValidatedPersistenceData<RunState>(originalSnapshot)
  revalidatePersistenceSnapshot(originalSnapshot)
  rejectCapturedProxies(originalSnapshot)
  assertStateProject(safeState, expectedProjectDirectory)
  const safeValidated = parseRunStateForProjection(safeState)
  const candidate = {
    ...safeValidated,
    revision: safeValidated.revision + 1,
    updated_at: nowIso(),
    state_projection: undefined,
  }
  const runtimeValidated = parseRunStateForProjection(candidate)
  assertRunArtifactMetadataContained(runtimeValidated, expectedProjectDirectory)
  const mirror = acquireMirrorLock(expectedProjectDirectory, safeState.run_id)
  try {
    options.afterMirrorLock?.()
    // Re-read after acquiring the mirror lock so CAS and mirror commit share one order.
    const current = readProjectedAuthoritativeRun(expectedProjectDirectory, safeState.run_id)
    if (!current) throw new StoreError(`run ${safeState.run_id} no longer exists`)
    if (current.revision !== safeState.revision) {
      throw new RevisionConflictError(safeState.run_id, safeState.revision, current.revision)
    }
    const prepared = prepareRunForImmutableCommit(runtimeValidated, current)
    const projection = projectRunState(prepared)
    const validated = parseRunState(projection.state)
    assertRunArtifactMetadataContained(validated, expectedProjectDirectory)
    // Immutable referenced objects are published and verified first; fixed
    // convenience mirrors follow. They must exist before the canonical
    // committed execution view can hydrate them. A pre-commit failure cannot
    // alter any object reachable from current progress or its recovery backup.
    writeDerivedFiles(prepared, projection, true, options.beforeDerivedWrite, current)
    // Build the exact caller-visible form and copyback plan before crossing the
    // commit boundary. This reads only safe/committed data plus the previously
    // captured descriptor snapshot; it performs no new original-state reads.
    const committedExecution = hydrateVisibleRunData(validated)
    const committedFull = hydrateRunFully(validated)
    const pendingSynchronization = committedExecutionSynchronization(
      originalSnapshot,
      committedExecution,
      committedFull,
    )
    options.beforeProgressCommit?.()
    writeProgressJson(
      runContainedPath(validated.project_directory, validated.run_id, "progress.json"),
      validated,
      true,
      {
        beforeCurrentRename(temporary, currentPath) {
          options.beforeProgressCurrentRename?.(temporary, currentPath)
        },
        commitBoundaryFence: progressCommitBoundaryFence,
        afterCurrentRename() {
          try {
            synchronizeCommittedExecutionState(pendingSynchronization)
          } catch (error) {
            throw new CommittedStateSynchronizationError(safeState.run_id, committedExecution, error)
          }
        },
        beforeBackupRename: options.beforeProgressBackupRename,
      },
    )
    // progress.json and the prevalidated caller copyback are now complete.
    runPostCommitGc(prepared, projection, options.beforePostCommitGc)
    refreshOwnerRunIndex(expectedProjectDirectory, validated.owner_session_id, {
      run_id: validated.run_id,
      updated_at: validated.updated_at,
    })
    if (current.owner_session_id !== validated.owner_session_id) {
      refreshOwnerRunIndex(
        expectedProjectDirectory,
        current.owner_session_id,
        null,
        validated.run_id,
      )
    }
    return state
  } finally {
    mirror.release()
  }
}

export function persistRun(
  state: RunState,
  expectedProjectDirectory: string,
  options: PersistRunOptions = {},
): RunState {
  return persistRunInternal(state, expectedProjectDirectory, options)
}

export function persistRunFenced(
  state: RunState,
  expectedProjectDirectory: string,
  lock: RunLock,
  options: PersistRunOptions = {},
): RunState {
  return lock.runCommitFenced(() => persistRunInternal(state, expectedProjectDirectory, {
    ...options,
    beforeProgressCommit() {
      options.beforeProgressCommit?.()
      lock.assertHeld()
    },
  }, lock.assertHeld))
}

function readProjectedAuthoritativeRun(projectDirectory: string, runId: string): RunState | null {
  const expectedProject = canonicalDirectory(projectDirectory)
  const progress = runContainedPath(expectedProject, runId, "progress.json")
  if (!existsSync(progress)) return null
  const state = parseRunState(readBoundedJson(progress))
  assertStateProject(state, expectedProject)
  if (!isContained(projectRunsRoot(expectedProject), runDir(state.project_directory, state.run_id))) {
    throw new StoreError("run path is outside the project run root")
  }
  if (state.run_id !== runId) throw new StoreError("run state id does not match its directory")
  // Inline outputs are accepted only for legacy compatibility. Validate their
  // project/run path claims before hydration can compare them with referenced
  // canonical detail and turn a malformed manifest into a derived-file error.
  assertInlineAgentOutputMetadataContained(state, expectedProject)
  return state
}

function readAuthoritativeRun(projectDirectory: string, runId: string): RunState | null {
  const state = readProjectedAuthoritativeRun(projectDirectory, runId)
  if (!state) return null
  try {
    const visible = hydrateVisibleRunData(state)
    verifyArchivedAttemptData(state, visible)
    return visible
  } catch (error) {
    throw new DerivedReferenceError(runId, error)
  }
}

/** Reload the exact committed compact representation after validating its full reference tree. */
export function loadCommittedRunProjectionForOwner(
  projectDirectory: string,
  runId: string,
  ownerSessionId: string,
): RunState | null {
  const envelope = peekRunEnvelope(projectDirectory, runId)
  if (!envelope) return null
  if (envelope.owner_session_id !== ownerSessionId) throw new StoreError(`session does not own run ${runId}`)
  const mirror = acquireMirrorLock(projectDirectory, runId)
  try {
    const projected = readProjectedAuthoritativeRun(projectDirectory, runId)
    if (!projected) return null
    if (projected.owner_session_id !== ownerSessionId) throw new StoreError(`session does not own run ${runId}`)
    const visible = hydrateVisibleRunData(projected)
    verifyArchivedAttemptData(projected, visible)
    return projected
  } catch (error) {
    if (error instanceof StoreError) throw error
    throw new DerivedReferenceError(runId, error)
  } finally {
    mirror.release()
  }
}

/** Read only the bounded ownership/discovery envelope; never repairs or quarantines. */
export function peekRunEnvelope(projectDirectory: string, runId: string): RunEnvelope | null {
  const project = canonicalDirectory(projectDirectory)
  assertSafeId(runId, "run_id")
  const progress = runContainedPath(project, runId, "progress.json")
  if (!existsSync(progress)) return null
  const envelope = RunEnvelopeSchema.parse(readBoundedJson(progress))
  assertSafeId(envelope.run_id, "run_id")
  if (envelope.run_id !== runId || envelope.project_directory !== project) {
    throw new StoreError("run envelope identity does not match its project/directory")
  }
  return envelope
}

export interface OwnedRunListingError {
  run_id: string
  error: string
}

export interface OwnedRunEnvelopeListing {
  envelopes: RunEnvelope[]
  errors: OwnedRunListingError[]
  directories_scanned: number
  scan_truncated: boolean
}

export interface OwnedRunDirectoryEntry {
  name: string
  isDirectory(): boolean
  isSymbolicLink(): boolean
}

export interface OwnedRunDirectoryHandle {
  readSync(): OwnedRunDirectoryEntry | null
  closeSync(): void
}

export interface OwnedRunDiscoveryOptions {
  /** Injectable streaming enumerator for deterministic bound/close tests. */
  openDirectory?: (root: string) => OwnedRunDirectoryHandle
}

const RunOwnershipProbeSchema = z.object({
  owner_session_id: exactPersistedString(1, 256, "owner session id"),
}).passthrough()

/**
 * Bounded ownership-first discovery. Once a parseable owner differs, no other
 * fields are parsed or reported. Exact-owner malformed envelopes are retained
 * as explicit errors instead of disappearing from strict/full listings.
 */
export function listOwnedRunEnvelopeResults(
  projectDirectory: string,
  sessionId: string,
  options: OwnedRunDiscoveryOptions = {},
): OwnedRunEnvelopeListing {
  const root = projectRunsRoot(projectDirectory)
  if (!existsSync(root)) {
    return { envelopes: [], errors: [], directories_scanned: 0, scan_truncated: false }
  }
  const envelopes: RunEnvelope[] = []
  const errors: OwnedRunListingError[] = []
  let directoriesScanned = 0
  let scanTruncated = false
  const handle = (options.openDirectory ?? ((path) => opendirSync(path)))(root)
  let entriesRead = 0
  try {
    while (true) {
      const entry = handle.readSync()
      if (!entry) break
      entriesRead++
      if (entriesRead > MAX_OWNED_RUN_DIRECTORY_SCAN) {
        scanTruncated = true
        break
      }
      if (entry.isSymbolicLink() || !entry.isDirectory() || !isSafeId(entry.name)) continue
      try {
        const direct = lstatSync(join(root, entry.name))
        if (direct.isSymbolicLink() || !direct.isDirectory()) continue
      } catch {
        continue
      }
      directoriesScanned++
      const progress = runContainedPath(projectDirectory, entry.name, "progress.json")
      if (!existsSync(progress)) continue
      let value: unknown
      try {
        value = readBoundedJson(progress)
      } catch {
        // Without a bounded parseable owner discriminator this candidate cannot
        // safely be attributed to (or disclosed to) the requesting session.
        continue
      }
      const ownership = RunOwnershipProbeSchema.safeParse(value)
      if (!ownership.success || ownership.data.owner_session_id !== sessionId) continue
      try {
        // Ownership has already been established without parsing or disclosing
        // another owner's body. Exact-owner candidates now receive the complete
        // persisted-state parse so compact listings cannot call an omission of a
        // malformed owned run complete.
        const state = parseRunState(value)
        const envelope = RunEnvelopeSchema.parse(value)
        assertSafeId(envelope.run_id, "run_id")
        const project = canonicalDirectory(projectDirectory)
        if (state.run_id !== entry.name || state.project_directory !== project ||
          envelope.run_id !== entry.name || envelope.project_directory !== project) {
          throw new StoreError("run envelope identity does not match its project/directory")
        }
        envelopes.push(envelope)
      } catch (error) {
        errors.push({
          run_id: entry.name,
          error: safeDiagnosticText(error instanceof Error ? error.message : String(error)),
        })
      }
    }
  } finally {
    handle.closeSync()
  }
  envelopes.sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at) || left.run_id.localeCompare(right.run_id))
  errors.sort((left, right) => left.run_id.localeCompare(right.run_id))
  return {
    envelopes,
    errors,
    directories_scanned: directoriesScanned,
    scan_truncated: scanTruncated,
  }
}

export function listOwnedRunEnvelopes(
  projectDirectory: string,
  sessionId: string,
): RunEnvelope[] {
  return listOwnedRunEnvelopeResults(projectDirectory, sessionId).envelopes
}

function reconcileLegacyRunningSessionIds(state: RunState): boolean {
  let changed = false
  for (const node of Object.values(state.nodes)) {
    for (const attempt of node.attempts) {
      if (attempt.status !== "running" || attempt.session_id) continue
      const sidecar = runContainedPath(
        state.project_directory,
        state.run_id,
        "sessions",
        `${node.id}-a${attempt.attempt}.json`,
      )
      if (!existsSync(sidecar)) continue
      try {
        const link = SessionLinkSchema.parse(readBoundedJson(sidecar))
        if (
          link.run_id === state.run_id &&
          link.owner_session_id === state.owner_session_id &&
          link.project_directory === state.project_directory &&
          link.node_id === node.id &&
          link.attempt === attempt.attempt
        ) {
          attempt.session_id = link.session_id
          changed = true
        }
      } catch {
        // Invalid or mismatched legacy evidence never mutates authoritative state.
      }
    }
  }
  return changed
}

/** Verify minimal ownership before any full parse, reconciliation, or quarantine side effect. */
export function loadRunForOwner(
  projectDirectory: string,
  runId: string,
  sessionId: string,
): RunState | null {
  const initial = peekRunEnvelope(projectDirectory, runId)
  if (!initial) return null
  if (initial.owner_session_id !== sessionId) {
    throw new StoreError(`session does not own run ${runId}`)
  }
  const mirror = acquireMirrorLock(projectDirectory, runId)
  let state: RunState | null = null
  let recoveredSessionId = false
  try {
    const latestEnvelope = peekRunEnvelope(projectDirectory, runId)
    if (!latestEnvelope || latestEnvelope.owner_session_id !== sessionId) {
      throw new StoreError(`session does not own run ${runId}`)
    }
    try {
      const loaded = readAuthoritativeRun(projectDirectory, runId)
      if (!loaded) return null
      state = loaded
    } catch (error) {
      if (error instanceof DerivedReferenceError) throw error
      const progress = runContainedPath(canonicalDirectory(projectDirectory), runId, "progress.json")
      throw corruptRunError(runId, error, quarantineCorruptFile(progress))
    }
    if (state.owner_session_id !== sessionId) throw new StoreError(`session does not own run ${runId}`)
    recoveredSessionId = reconcileLegacyRunningSessionIds(state)
    reconcileDerivedFilesUnlocked(state)
  } finally {
    mirror.release()
  }
  if (!state) return null
  return recoveredSessionId ? persistRun(state, projectDirectory) : state
}

function readAuthoritativeOrQuarantine(
  projectDirectory: string,
  runId: string,
  renameCorruptFile: (source: string, destination: string) => void = renameSync,
): RunState | null {
  try {
    return readAuthoritativeRun(projectDirectory, runId)
  } catch (error) {
    if (error instanceof DerivedReferenceError) throw error
    const progress = runContainedPath(canonicalDirectory(projectDirectory), runId, "progress.json")
    throw corruptRunError(runId, error, quarantineCorruptFile(progress, renameCorruptFile))
  }
}

export interface LoadRunOptions {
  /** Testable race barrier after an initial read but before mirror-lock acquisition. */
  afterInitialRead?: (initial: RunState) => void
  renameCorruptFile?: (source: string, destination: string) => void
}

export function loadRun(
  projectDirectory: string,
  runId: string,
  options: LoadRunOptions = {},
): RunState | null {
  const initial = readAuthoritativeOrQuarantine(projectDirectory, runId, options.renameCorruptFile)
  if (!initial) return null
  options.afterInitialRead?.(initial)
  const mirror = acquireMirrorLock(projectDirectory, runId)
  try {
    // A writer may have committed after the initial read; only reconcile its latest revision.
    const latest = readAuthoritativeOrQuarantine(projectDirectory, runId, options.renameCorruptFile)
    if (!latest) return null
    reconcileDerivedFilesUnlocked(latest)
    return latest
  } catch (error) {
    if (error instanceof StoreError && error.message.includes("corrupt or incompatible")) throw error
    throw new StoreError(`run ${runId} state is valid but derived-file reconciliation failed`, {
      cause: error,
    })
  } finally {
    mirror.release()
  }
}

export function listRuns(projectDirectory: string, ownerSessionId: string): RunState[] {
  const runs: RunState[] = []
  for (const envelope of listOwnedRunEnvelopes(projectDirectory, ownerSessionId)) {
    try {
      const state = loadRunForOwner(projectDirectory, envelope.run_id, ownerSessionId)
      if (state) runs.push(state)
    } catch {
      // One invalid owned run never makes another owned run unavailable.
    }
  }
  return runs
}

export function findLatestRunForSession(
  projectDirectory: string,
  sessionId: string,
): RunState | null {
  for (const envelope of listOwnedRunEnvelopes(projectDirectory, sessionId)) {
    try {
      const run = loadRunForOwner(projectDirectory, envelope.run_id, sessionId)
      if (run) return run
    } catch {
      // Skip an invalid owned candidate without touching any other owner's run.
    }
  }
  return null
}

export function findLatestIncompleteRunForSession(
  projectDirectory: string,
  sessionId: string,
): RunState | null {
  const active = new Set<RunState["status"]>(["planning", "running", "blocked"])
  for (const envelope of listOwnedRunEnvelopes(projectDirectory, sessionId)) {
    if (!active.has(envelope.status)) continue
    try {
      const run = loadRunForOwner(projectDirectory, envelope.run_id, sessionId)
      if (run && active.has(run.status)) return run
    } catch {
      // Continue to the next exact-owner candidate.
    }
  }
  return null
}

function formatCriteriaMd(state: RunState): string {
  return [
    `# Criteria — ${state.run_id}`,
    "",
    `Goal: ${state.goal}`,
    "",
    "## Hard criteria",
    ...(state.criteria.length ? state.criteria.map((criterion, i) => `${i + 1}. ${criterion}`) : ["_(none locked yet)_"]),
    "",
    `Locked: ${state.criteria_locked}`,
    `Updated: ${state.updated_at}`,
    "",
  ].join("\n")
}

export function linkSession(
  state: RunState,
  expectedProjectDirectory: string,
  nodeId: string,
  attempt: number,
  sessionId: string,
): void {
  assertStateProject(state, expectedProjectDirectory)
  assertSafeId(nodeId, "node_id")
  const link = SessionLinkSchema.parse({
    schema_version: 1,
    run_id: state.run_id,
    owner_session_id: state.owner_session_id,
    project_directory: state.project_directory,
    node_id: nodeId,
    attempt,
    session_id: sessionId,
    linked_at: nowIso(),
  })
  writeJson(runContainedPath(
    expectedProjectDirectory,
    state.run_id,
    "sessions",
    `${nodeId}-a${attempt}.json`,
  ), link)
}

export interface RunLock {
  path: string
  token: string
  renew(): void
  assertHeld(): void
  runFenced<T>(operation: () => T): T
  /** Fenced commit operation whose authoritative boundary performs its final assertion. */
  runCommitFenced<T>(operation: () => T): T
  release(): void
}

export interface RunLockOptions {
  leaseMs?: number
  heartbeatMs?: number
  now?: () => number
  /** Deterministic race barrier after observing expiry but before guarded takeover. */
  beforeExpiredTakeover?: (observed: RunLockRecord) => void
  /** Deterministic race barrier after the fenced precheck and before its operation. */
  afterFencedPrecheck?: (observed: RunLockRecord) => void
}

function acquireExecutionGuard(projectDirectory: string, runId: string): FilesystemMutex {
  const path = runContainedPath(projectDirectory, runId, "execution.lock.guard")
  try {
    return acquireFilesystemMutex(path, {
      owner: `execution-guard:${runId}`,
      leaseMs: 5_000,
      waitMs: 250,
    })
  } catch (error) {
    throw new RunLockedError(runId, error instanceof Error ? error.message : String(error))
  }
}

function verifiedLock(
  lockPath: string,
  projectDirectory: string,
  runId: string,
): RunLockRecord {
  let parsed: RunLockRecord
  try {
    parsed = RunLockSchema.parse(JSON.parse(readFileSync(lockPath, "utf8")))
  } catch (error) {
    throw new RunLockedError(runId, `locked by a malformed or unverifiable lease (${error instanceof Error ? error.message : String(error)})`)
  }
  if (parsed.project_directory !== projectDirectory || parsed.run_id !== runId) {
    throw new RunLockedError(runId, "locked by a lease with mismatched project/run identity")
  }
  return parsed
}

export function acquireRunLock(
  projectDirectory: string,
  runId: string,
  holder: string,
  leaseOrOptions: number | RunLockOptions = DEFAULT_LOCK_LEASE_MS,
): RunLock {
  const options = typeof leaseOrOptions === "number" ? { leaseMs: leaseOrOptions } : leaseOrOptions
  const leaseMs = options.leaseMs ?? DEFAULT_LOCK_LEASE_MS
  const heartbeatMs = options.heartbeatMs ?? Math.max(25, Math.min(60_000, Math.floor(leaseMs / 3)))
  const now = options.now ?? Date.now
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 100 || leaseMs > 24 * 60 * 60 * 1_000) {
    throw new StoreError("lock lease must be between 100 milliseconds and 24 hours")
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs >= leaseMs) {
    throw new StoreError("lock heartbeat must be at least 10ms and shorter than its lease")
  }
  const canonicalProject = canonicalDirectory(projectDirectory)
  assertSafeId(runId, "run_id")
  const lockPath = runContainedPath(canonicalProject, runId, "execution.lock")
  const token = randomUUID()
  const acquiredMs = now()
  const lock = RunLockSchema.parse({
    version: 1,
    token,
    holder,
    project_directory: canonicalProject,
    run_id: runId,
    acquired_at: new Date(acquiredMs).toISOString(),
    expires_at: new Date(acquiredMs + leaseMs).toISOString(),
  })

  const acquisitionGuard = acquireExecutionGuard(canonicalProject, runId)
  try {
    if (existsSync(lockPath)) {
      const observed = verifiedLock(lockPath, canonicalProject, runId)
      if (Date.parse(observed.expires_at) > now()) throw new RunLockedError(runId)
      options.beforeExpiredTakeover?.(structuredClone(observed))
      // Guard participants cannot renew or release between these reads. The second
      // read also rejects replacement by a non-participating/older process.
      const confirmed = verifiedLock(lockPath, canonicalProject, runId)
      if (confirmed.token !== observed.token || Date.parse(confirmed.expires_at) > now()) {
        throw new RunLockedError(runId)
      }
      renameSync(
        lockPath,
        runContainedPath(canonicalProject, runId, `execution.lock.stale-${Date.now()}-${randomUUID().slice(0, 8)}`),
      )
    }
    let fd: number | undefined
    try {
      fd = openSync(lockPath, "wx", 0o600)
      writeFileSync(fd, `${JSON.stringify(lock, null, 2)}\n`, "utf8")
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      throw error
    }
  } finally {
    acquisitionGuard.release()
  }

  let released = false
  let lost = false
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const assertHeld = () => {
    if (released || lost) throw new RunLockedError(runId, "no longer held by this executor")
    const current = verifiedLock(lockPath, canonicalProject, runId)
    if (current.token !== token || Date.parse(current.expires_at) <= now()) {
      lost = true
      if (heartbeat) clearInterval(heartbeat)
      throw new RunLockedError(runId, "no longer held by this executor")
    }
  }

  const runFenced = <T>(operation: () => T): T => {
    if (released || lost) throw new RunLockedError(runId, "no longer held by this executor")
    const guard = acquireExecutionGuard(canonicalProject, runId)
    try {
      assertHeld()
      options.afterFencedPrecheck?.(verifiedLock(lockPath, canonicalProject, runId))
      const result = operation()
      assertHeld()
      return result
    } finally {
      guard.release()
    }
  }

  const runCommitFenced = <T>(operation: () => T): T => {
    if (released || lost) throw new RunLockedError(runId, "no longer held by this executor")
    const guard = acquireExecutionGuard(canonicalProject, runId)
    try {
      assertHeld()
      options.afterFencedPrecheck?.(verifiedLock(lockPath, canonicalProject, runId))
      // persistRunFenced asserts again immediately before progress replacement.
      // Once that replacement succeeds, lock loss during non-authoritative
      // maintenance must not turn the confirmed commit into a reported failure.
      return operation()
    } finally {
      guard.release()
    }
  }

  const renew = () => {
    if (released || lost) throw new RunLockedError(runId, "no longer held by this executor")
    const guard = acquireExecutionGuard(canonicalProject, runId)
    try {
      const current = verifiedLock(lockPath, canonicalProject, runId)
      if (current.token !== token || Date.parse(current.expires_at) <= now()) {
        lost = true
        throw new RunLockedError(runId, "no longer held by this executor")
      }
      const renewed = RunLockSchema.parse({
        ...current,
        expires_at: new Date(now() + leaseMs).toISOString(),
      })
      atomicWriteFile(lockPath, `${JSON.stringify(renewed, null, 2)}\n`)
    } finally {
      guard.release()
    }
  }

  heartbeat = setInterval(() => {
    try {
      renew()
    } catch {
      lost = true
      if (heartbeat) clearInterval(heartbeat)
    }
  }, heartbeatMs)
  heartbeat.unref?.()

  return {
    path: lockPath,
    token,
    renew,
    assertHeld,
    runFenced,
    runCommitFenced,
    release() {
      if (released) return
      released = true
      if (heartbeat) clearInterval(heartbeat)
      let guard: FilesystemMutex
      try {
        guard = acquireExecutionGuard(canonicalProject, runId)
      } catch {
        // A live or crashed guard fails closed; never remove without serialization.
        return
      }
      try {
        const current = verifiedLock(lockPath, canonicalProject, runId)
        if (current.token === token) rmSync(lockPath, { force: true })
      } catch {
        // Never delete a lock that cannot be proven to be ours.
      } finally {
        guard.release()
      }
    },
  }
}

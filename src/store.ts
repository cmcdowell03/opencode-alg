import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { z } from "zod"
import type { AgentModelMap, GraphDef, RunLockRecord, RunState } from "./types.ts"
import { ALG_SCHEMA_VERSION } from "./types.ts"
import { initNodeStates, validateGraph } from "./graph.ts"
import { parseRunState, RunLockSchema } from "./schemas.ts"
import { acquireFilesystemMutex, type FilesystemMutex } from "./filesystem-mutex.ts"
import {
  assertSafeId,
  canonicalDirectory,
  isContained,
  isSafeProjectRelativePath,
  isSafeRunArtifactPath,
  resolveContainedPath,
} from "./paths.ts"

const MAX_STATE_BYTES = 5 * 1024 * 1024
const DEFAULT_LOCK_LEASE_MS = 60 * 60 * 1_000

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
    owner_session_id: z.string().trim().min(1).max(256),
    project_directory: z.string().min(1).max(4_096),
    status: z.enum(["planning", "running", "done", "failed", "blocked"]),
    goal: z.string().min(1).max(20_000),
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
    owner_session_id: z.string().trim().min(1).max(256),
    project_directory: z.string().min(1).max(4_096),
    node_id: z.string().min(1).max(64),
    attempt: z.number().int().positive().max(10_000),
    session_id: z.string().trim().min(1).max(256),
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

function assertRunArtifactMetadataContained(state: RunState, projectDirectory: string): void {
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

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

export function createRunId(goal: string): string {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
  return `${slugify(goal)}-${timestamp}-${randomUUID().replace(/-/g, "").slice(0, 12)}`
}

/** Same-directory temporary write, fsync, optional rolling backup, then rename. */
export function atomicWriteFile(path: string, data: string, backup = false): void {
  ensureDir(dirname(path))
  const suffix = `${process.pid}-${randomUUID()}`
  const temporary = resolveContainedPath(dirname(path), `.${basename(path)}.${suffix}.tmp`)
  let fd: number | undefined
  try {
    fd = openSync(temporary, "wx", 0o600)
    writeFileSync(fd, data, "utf8")
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined

    if (backup && existsSync(path)) {
      const backupTemporary = resolveContainedPath(dirname(path), `${basename(path)}.${suffix}.bak.tmp`)
      copyFileSync(path, backupTemporary)
      const backupPath = resolveContainedPath(dirname(path), `${basename(path)}.bak`)
      rmSync(backupPath, { force: true })
      renameSync(backupTemporary, backupPath)
    }
    renameSync(temporary, path)
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    rmSync(temporary, { force: true })
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
}): RunState {
  if (options.parentSessionId && options.parentSessionId !== options.ownerSessionId) {
    throw new StoreError("parentSessionId must equal the creating owner session")
  }
  const projectDirectory = canonicalDirectory(options.projectDirectory)
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
    session_isolation: "sdk-child-session",
  } satisfies RunState

  const validated = parseRunState(state)
  try {
    const mirror = acquireMirrorLock(projectDirectory, runId)
    try {
      writeDerivedFiles(validated, false)
      writeJson(runContainedPath(projectDirectory, runId, "progress.json"), validated, false)
      removeStaleDerivedFiles(validated)
    } finally {
      mirror.release()
    }
    return validated
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
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
}

function expectedDerived(state: RunState): {
  artifacts: Map<string, unknown>
  checks: Map<string, unknown>
} {
  const artifacts = new Map<string, unknown>()
  const checks = new Map<string, unknown>()
  for (const [id, node] of Object.entries(state.nodes)) {
    assertSafeId(id, "node_id")
    if (node.output !== undefined) artifacts.set(`${id}.json`, node.output)
    if (node.agent === "checker") {
      for (const attempt of node.attempts) {
        checks.set(`${id}-attempt-${attempt.attempt}.json`, attempt.output ?? attempt)
      }
    }
  }
  return { artifacts, checks }
}

function writeDerivedFiles(
  state: RunState,
  backup: boolean,
  beforeWrite?: (path: string) => void,
): void {
  const graphPath = runContainedPath(state.project_directory, state.run_id, "graph.json")
  beforeWrite?.(graphPath)
  writeJson(graphPath, state.graph, backup)
  const criteriaPath = runContainedPath(state.project_directory, state.run_id, "criteria.md")
  beforeWrite?.(criteriaPath)
  atomicWriteFile(criteriaPath, formatCriteriaMd(state), backup)

  const expected = expectedDerived(state)
  for (const [name, output] of expected.artifacts) {
    const path = runContainedPath(state.project_directory, state.run_id, "artifacts", name)
    beforeWrite?.(path)
    writeJson(path, output)
  }
  for (const [name, output] of expected.checks) {
    const path = runContainedPath(state.project_directory, state.run_id, "checks", name)
    beforeWrite?.(path)
    writeJson(path, output)
  }
}

function removeUnexpectedJson(directory: string, expected: Set<string>): void {
  ensureDir(directory)
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolveContainedPath(directory, entry.name)
    if (entry.isFile() && entry.name.endsWith(".json") && !expected.has(entry.name)) {
      rmSync(entryPath, { force: true })
    }
  }
}

function removeStaleDerivedFiles(state: RunState): void {
  const expected = expectedDerived(state)
  removeUnexpectedJson(
    runContainedPath(state.project_directory, state.run_id, "artifacts"),
    new Set(expected.artifacts.keys()),
  )
  removeUnexpectedJson(
    runContainedPath(state.project_directory, state.run_id, "checks"),
    new Set(expected.checks.keys()),
  )
}

function reconcileDerivedFilesUnlocked(state: RunState): void {
  writeDerivedFiles(state, false)
  removeStaleDerivedFiles(state)
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

export function persistRun(
  state: RunState,
  expectedProjectDirectory: string,
  options: PersistRunOptions = {},
): RunState {
  assertStateProject(state, expectedProjectDirectory)
  const candidate = {
    ...state,
    revision: state.revision + 1,
    updated_at: nowIso(),
  }
  const validated = parseRunState(candidate)
  assertRunArtifactMetadataContained(validated, expectedProjectDirectory)
  const mirror = acquireMirrorLock(expectedProjectDirectory, state.run_id)
  try {
    options.afterMirrorLock?.()
    // Re-read after acquiring the mirror lock so CAS and mirror commit share one order.
    const current = readAuthoritativeRun(expectedProjectDirectory, state.run_id)
    if (!current) throw new StoreError(`run ${state.run_id} no longer exists`)
    if (current.revision !== state.revision) {
      throw new RevisionConflictError(state.run_id, state.revision, current.revision)
    }
    // Derived mirrors are prepared first. If any write fails, progress remains the
    // old authoritative state and loadRun deterministically repairs partial mirrors.
    writeDerivedFiles(validated, true, options.beforeDerivedWrite)
    options.beforeProgressCommit?.()
    writeJson(runContainedPath(validated.project_directory, validated.run_id, "progress.json"), validated, true)
    state.revision = validated.revision
    state.updated_at = validated.updated_at
    removeStaleDerivedFiles(validated)
    return state
  } finally {
    mirror.release()
  }
}

export function persistRunFenced(
  state: RunState,
  expectedProjectDirectory: string,
  lock: RunLock,
  options: PersistRunOptions = {},
): RunState {
  return lock.runFenced(() => persistRun(state, expectedProjectDirectory, {
    ...options,
    beforeProgressCommit() {
      options.beforeProgressCommit?.()
      lock.assertHeld()
    },
  }))
}

function readAuthoritativeRun(projectDirectory: string, runId: string): RunState | null {
  const expectedProject = canonicalDirectory(projectDirectory)
  const progress = runContainedPath(expectedProject, runId, "progress.json")
  if (!existsSync(progress)) return null
  const state = parseRunState(readBoundedJson(progress))
  assertStateProject(state, expectedProject)
  if (!isContained(projectRunsRoot(expectedProject), runDir(state.project_directory, state.run_id))) {
    throw new StoreError("run path is outside the project run root")
  }
  if (state.run_id !== runId) throw new StoreError("run state id does not match its directory")
  assertRunArtifactMetadataContained(state, expectedProject)
  return state
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

export function listOwnedRunEnvelopes(
  projectDirectory: string,
  sessionId: string,
): RunEnvelope[] {
  const root = projectRunsRoot(projectDirectory)
  if (!existsSync(root)) return []
  const envelopes: RunEnvelope[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const envelope = peekRunEnvelope(projectDirectory, entry.name)
      if (envelope?.owner_session_id === sessionId) envelopes.push(envelope)
    } catch {
      // Unverifiable envelopes are skipped without mutation or quarantine.
    }
  }
  return envelopes.sort((left, right) =>
    right.updated_at.localeCompare(left.updated_at) || left.run_id.localeCompare(right.run_id),
  )
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

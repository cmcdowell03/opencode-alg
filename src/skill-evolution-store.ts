import { createHash, randomUUID } from "node:crypto"
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, relative, resolve } from "node:path"
import { acquireFilesystemMutex } from "./filesystem-mutex.ts"
import { atomicWriteFile } from "./store.ts"
import { canonicalJson, sha256Json } from "./persistence.ts"
import { safeDiagnosticText } from "./diagnostics.ts"
import { canonicalDirectory, isContained, isSafeId, isSafeProjectRelativePath, resolveContainedPath } from "./paths.ts"
import { serializedBytes, utf8Bytes } from "./limits.ts"
import {
  SKILL_EVOLUTION_MAX_CONTENT_BYTES,
  SKILL_EVOLUTION_MAX_JSON_BYTES,
  SKILL_EVOLUTION_MAX_REVISIONS,
  SkillCandidateIndexSchema,
  SkillCandidateRevisionSchema,
  SkillEvolutionLedgerSchema,
  SkillEvidenceSchema,
  SkillTransactionJournalSchema,
  type AuditorOutput,
  type CandidateState,
  type SkillCandidateIndex,
  type SkillCandidateRecord,
  type SkillCandidateRevision,
  type SkillCheckerOutput,
  type SkillEvidence,
  type SkillEvolutionLedger,
  type SkillEvolutionOptions,
  type SkillLedgerRecord,
  type SkillTransactionJournal,
} from "./skill-evolution-schemas.ts"

const STORE_RELATIVE = ".opencode/skill-evolution"
const LEDGER_FILE = "ledger.json"
const CANDIDATE_FILE = "candidates.json"
const MAX_CHILDREN = 1_000
const MAX_EVIDENCE_FILE_BYTES = 32_768

function nowIso(): string {
  return new Date().toISOString()
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function assertDirectRegularFile(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`skill-evolution path is not a direct regular file: ${path}`)
  if (!samePath(realpathSync.native(path), path)) throw new Error(`skill-evolution path is redirected: ${path}`)
}

function assertDirectDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`skill-evolution path is not a direct directory: ${path}`)
  if (!samePath(realpathSync.native(path), path)) throw new Error(`skill-evolution directory is redirected: ${path}`)
}

type SkillFileIdentity = { dev: string; ino: string; size: string }

function directDirectoryIdentity(path: string): SkillFileIdentity {
  assertDirectDirectory(path)
  const stat = lstatSync(path, { bigint: true })
  return { dev: stat.dev.toString(), ino: stat.ino.toString(), size: stat.size.toString() }
}

function missingPath(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return true
    throw error
  }
}

/** Reject every existing redirected component instead of accepting an in-project symlink/junction. */
function assertExistingDirectComponents(project: string, path: string, finalKind?: "directory" | "file"): void {
  if (!isContained(project, path)) throw new Error("skill-evolution path escaped project")
  const components = relative(project, path).split(/[\\/]+/).filter(Boolean)
  let current = project
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]!)
    if (missingPath(current)) return
    const stat = lstatSync(current)
    if (stat.isSymbolicLink() || !samePath(realpathSync.native(current), current)) {
      throw new Error(`skill-evolution path traverses a symlink, junction, or reparse redirect: ${current}`)
    }
    const final = index === components.length - 1
    if (!final && !stat.isDirectory()) throw new Error(`skill-evolution parent is not a directory: ${current}`)
    if (finalKind === "directory" && final && !stat.isDirectory()) throw new Error(`skill-evolution path is not a directory: ${current}`)
    if (finalKind === "file" && final && !stat.isFile()) throw new Error(`skill-evolution path is not a regular file: ${current}`)
  }
}

function ensureVerifiedDirectory(project: string, path: string): string {
  const canonicalProject = canonicalDirectory(project)
  if (!isContained(canonicalProject, path)) throw new Error("skill-evolution directory escaped project")
  const rel = relative(canonicalProject, path).split(/[\\/]+/).filter(Boolean)
  let current = canonicalProject
  for (const component of rel) {
    current = join(current, component)
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 })
    assertDirectDirectory(current)
  }
  return current
}

export function skillEvolutionRoot(projectDirectory: string): string {
  const project = canonicalDirectory(projectDirectory)
  const root = resolve(project, ".opencode", "skill-evolution")
  if (!isContained(project, root) || root === project) throw new Error("skill-evolution store escaped project")
  assertExistingDirectComponents(project, root, "directory")
  return root
}

function ensureStore(projectDirectory: string): string {
  const project = canonicalDirectory(projectDirectory)
  const root = skillEvolutionRoot(project)
  ensureVerifiedDirectory(project, root)
  return root
}

function storePath(projectDirectory: string, ...segments: string[]): string {
  return resolveContainedPath(skillEvolutionRoot(projectDirectory), ...segments)
}

function projectRelative(project: string, path: string): string {
  const value = relative(project, path).replaceAll("\\", "/")
  if (!isSafeProjectRelativePath(value)) throw new Error("derived skill-evolution reference is unsafe")
  return value
}

type DirectReadIdentity = { dev: bigint; ino: bigint }

function sameDirectReadIdentity(left: DirectReadIdentity, right: DirectReadIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

/** Bounded descriptor read with direct-component and replacement-race checks. */
function readDirectBounded(project: string, path: string, maximum: number, label: string): Buffer {
  if (!isContained(project, path)) throw new Error(`${label} path escaped project`)
  assertExistingDirectComponents(project, path, "file")
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${label} is not a direct regular file`)
  if (before.size > BigInt(maximum)) throw new Error(`${label} exceeds ${maximum} bytes`)
  const beforeIdentity = { dev: before.dev, ino: before.ino }
  const descriptor = openSync(path, constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0))
  try {
    const opened = fstatSync(descriptor, { bigint: true })
    const openedIdentity = { dev: opened.dev, ino: opened.ino }
    if (!opened.isFile() || !sameDirectReadIdentity(beforeIdentity, openedIdentity)) {
      throw new Error(`${label} was replaced before it was opened`)
    }
    if (opened.size > BigInt(maximum)) throw new Error(`${label} exceeds ${maximum} bytes`)
    if (opened.size !== before.size || opened.mtimeNs !== before.mtimeNs) throw new Error(`${label} changed before reading`)

    const bounded = Buffer.alloc(maximum + 1)
    let length = 0
    while (length < bounded.byteLength) {
      const count = readSync(descriptor, bounded, length, bounded.byteLength - length, null)
      if (count === 0) break
      length += count
    }
    if (length > maximum) throw new Error(`${label} exceeds ${maximum} bytes`)

    const after = fstatSync(descriptor, { bigint: true })
    if (!sameDirectReadIdentity(openedIdentity, { dev: after.dev, ino: after.ino }) ||
      after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || BigInt(length) !== opened.size) {
      throw new Error(`${label} changed while reading`)
    }
    assertExistingDirectComponents(project, path, "file")
    const current = lstatSync(path, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink() ||
      !sameDirectReadIdentity(openedIdentity, { dev: current.dev, ino: current.ino }) ||
      current.size !== opened.size || current.mtimeNs !== opened.mtimeNs) {
      throw new Error(`${label} was replaced while reading`)
    }
    return bounded.subarray(0, length)
  } finally {
    closeSync(descriptor)
  }
}

function readBoundedJson(path: string, maximum = SKILL_EVOLUTION_MAX_JSON_BYTES): unknown {
  const project = canonicalDirectory(resolve(path, "..", "..", ".."))
  return JSON.parse(readDirectBounded(project, path, maximum, "skill-evolution JSON").toString("utf8"))
}

function emptyLedger(): SkillEvolutionLedger {
  return { schema_version: 1, kind: "skill_evolution_ledger", revision: 0, records: [], audit_children: [], updated_at: new Date(0).toISOString() }
}

function emptyCandidates(): SkillCandidateIndex {
  return { schema_version: 1, kind: "skill_evolution_candidates", revision: 0, candidates: [], updated_at: new Date(0).toISOString() }
}

export function loadSkillLedger(projectDirectory: string): SkillEvolutionLedger {
  const path = storePath(projectDirectory, LEDGER_FILE)
  return existsSync(path) ? SkillEvolutionLedgerSchema.parse(readBoundedJson(path)) : emptyLedger()
}

export function loadSkillCandidates(projectDirectory: string): SkillCandidateIndex {
  const path = storePath(projectDirectory, CANDIDATE_FILE)
  return existsSync(path) ? SkillCandidateIndexSchema.parse(readBoundedJson(path)) : emptyCandidates()
}

function saveLedger(project: string, ledger: SkillEvolutionLedger, expectedRevision: number): SkillEvolutionLedger {
  const current = loadSkillLedger(project)
  if (current.revision !== expectedRevision) throw new Error("skill-evolution ledger changed concurrently")
  const next = SkillEvolutionLedgerSchema.parse({ ...ledger, revision: expectedRevision + 1, updated_at: nowIso() })
  if (serializedBytes(next) > SKILL_EVOLUTION_MAX_JSON_BYTES) throw new Error("skill-evolution ledger exceeds aggregate bound")
  atomicWriteFile(storePath(project, LEDGER_FILE), `${JSON.stringify(next, null, 2)}\n`, true)
  return next
}

function saveCandidates(project: string, index: SkillCandidateIndex, expectedRevision: number): SkillCandidateIndex {
  const current = loadSkillCandidates(project)
  if (current.revision !== expectedRevision) throw new Error("skill-evolution candidate index changed concurrently")
  const next = SkillCandidateIndexSchema.parse({ ...index, revision: expectedRevision + 1, updated_at: nowIso() })
  if (serializedBytes(next) > SKILL_EVOLUTION_MAX_JSON_BYTES) throw new Error("skill-evolution candidate index exceeds aggregate bound")
  atomicWriteFile(storePath(project, CANDIDATE_FILE), `${JSON.stringify(next, null, 2)}\n`, true)
  return next
}

export function withSkillEvolutionLock<T>(projectDirectory: string, operation: string, work: () => T): T {
  const root = ensureStore(projectDirectory)
  const lock = acquireFilesystemMutex(resolveContainedPath(root, "mutation.lock"), {
    owner: `skill-evolution:${operation}`,
    leaseMs: 30_000,
    waitMs: 1_000,
  })
  try {
    return work()
  } finally {
    lock.release()
  }
}

export function skillLedgerKey(sessionId: string, messageId: string): string {
  return createHash("sha256").update(sessionId, "utf8").update("\0").update(messageId, "utf8").digest("hex")
}

export interface EnqueueLedgerResult {
  record: SkillLedgerRecord
  enqueued: boolean
  reason: "new" | "retry" | "duplicate" | "overflow"
}

export function enqueueSkillAudit(
  projectDirectory: string,
  sessionId: string,
  messageId: string,
  options: SkillEvolutionOptions,
  force = false,
): EnqueueLedgerResult {
  return withSkillEvolutionLock(projectDirectory, "enqueue", () => {
    const ledger = loadSkillLedger(projectDirectory)
    const key = skillLedgerKey(sessionId, messageId)
    const existing = ledger.records.find((record) => record.key === key)
    if (existing) {
      if (!force) {
        return { record: existing, enqueued: false, reason: "duplicate" }
      }
      if (existing.status !== "failed" && existing.status !== "no-change") {
        throw new Error("forced audit retry is allowed only for an existing failed or no-change record")
      }
      if (existing.attempts >= options.maxAttempts || existing.forced_retries >= options.maxAttempts - 1) {
        return { record: existing, enqueued: false, reason: "duplicate" }
      }
      existing.status = "pending"
      existing.forced_retries++
      existing.updated_at = nowIso()
      delete existing.error
      delete existing.candidate_id
      const saved = saveLedger(projectDirectory, ledger, ledger.revision)
      return { record: saved.records.find((record) => record.key === key)!, enqueued: true, reason: "retry" }
    }
    if (force) throw new Error("forced audit retry requires an existing failed or no-change record")
    if (ledger.records.length >= options.maxLedgerRecords) {
      throw new Error("skill-evolution ledger capacity reached; refusing to discard exactly-once records")
    }
    const pending = ledger.records.filter((record) => record.status === "pending" || record.status === "running").length
    const created = nowIso()
    const record: SkillLedgerRecord = SkillLedgerRecordSchemaCompat({
      key, session_id: sessionId, message_id: messageId,
      status: pending >= options.maxBacklog ? "failed" : "pending",
      attempts: 0, forced_retries: 0, created_at: created, updated_at: created,
      ...(pending >= options.maxBacklog ? { error: "skill-evolution queue backlog limit reached" } : {}),
    })
    ledger.records.push(record)
    const saved = saveLedger(projectDirectory, ledger, ledger.revision)
    const persisted = saved.records.find((candidate) => candidate.key === key)!
    return { record: persisted, enqueued: pending < options.maxBacklog, reason: pending < options.maxBacklog ? "new" : "overflow" }
  })
}

// Keeps construction sites terse while ensuring strict persisted validation.
function SkillLedgerRecordSchemaCompat(value: unknown): SkillLedgerRecord {
  const ledger = SkillEvolutionLedgerSchema.parse({
    ...emptyLedger(),
    records: [value],
  })
  return ledger.records[0]!
}

export function updateSkillLedgerRecord(
  projectDirectory: string,
  key: string,
  mutate: (record: SkillLedgerRecord) => void,
): SkillLedgerRecord {
  return withSkillEvolutionLock(projectDirectory, "ledger-update", () => {
    const ledger = loadSkillLedger(projectDirectory)
    const record = ledger.records.find((candidate) => candidate.key === key)
    if (!record) throw new Error("skill-evolution ledger record not found")
    mutate(record)
    record.updated_at = nowIso()
    const saved = saveLedger(projectDirectory, ledger, ledger.revision)
    return saved.records.find((candidate) => candidate.key === key)!
  })
}

export function beginSkillAudit(projectDirectory: string, key: string, options: SkillEvolutionOptions): SkillLedgerRecord {
  return withSkillEvolutionLock(projectDirectory, "audit-begin", () => {
    const ledger = loadSkillLedger(projectDirectory)
    const record = ledger.records.find((candidate) => candidate.key === key)
    if (!record) throw new Error("skill-evolution ledger record not found")
    // Multiple runtime instances can discover the same durable pending record
    // during startup. Only its first pending->running CAS may execute it.
    if (record.status !== "pending") return record
    if (record.attempts >= options.maxAttempts) {
      record.status = "failed"
      record.error = "skill-evolution attempt limit reached"
    } else {
      record.status = "running"
      record.attempts++
    }
    record.updated_at = nowIso()
    const saved = saveLedger(projectDirectory, ledger, ledger.revision)
    return saved.records.find((candidate) => candidate.key === key)!
  })
}

export function failSkillAudit(projectDirectory: string, key: string, error: unknown): SkillLedgerRecord {
  const diagnostic = safeDiagnosticText(error instanceof Error ? error.message : String(error))
  return updateSkillLedgerRecord(projectDirectory, key, (record) => {
    record.status = "failed"
    record.error = diagnostic
  })
}

export function recoverPendingSkillAudits(projectDirectory: string, options: SkillEvolutionOptions): SkillLedgerRecord[] {
  return withSkillEvolutionLock(projectDirectory, "startup-recovery", () => {
    const ledger = loadSkillLedger(projectDirectory)
    let changed = false
    for (const record of ledger.records) {
      if (record.status !== "running") continue
      changed = true
      if (record.attempts < options.maxAttempts) {
        record.status = "pending"
        record.error = "previous audit process stopped while running; queued for bounded retry"
      } else {
        record.status = "failed"
        record.error = "previous audit process stopped after attempt limit"
      }
      record.updated_at = nowIso()
    }
    let retained = 0
    for (const record of ledger.records) {
      if (record.status !== "pending") continue
      if (retained < options.maxBacklog) {
        retained++
        continue
      }
      changed = true
      record.status = "failed"
      record.error = "skill-evolution queue backlog limit reached during startup recovery"
      record.updated_at = nowIso()
    }
    const saved = changed ? saveLedger(projectDirectory, ledger, ledger.revision) : ledger
    return saved.records.filter((record) => record.status === "pending")
  })
}

export function registerSkillAuditChild(
  projectDirectory: string,
  child: { session_id: string; parent_id: string; title: string; role: "auditor" | "checker" },
): void {
  withSkillEvolutionLock(projectDirectory, "child-register", () => {
    const ledger = loadSkillLedger(projectDirectory)
    const found = ledger.audit_children.find((entry) => entry.session_id === child.session_id)
    if (found) return
    if (ledger.audit_children.length >= MAX_CHILDREN) throw new Error("skill-evolution audit child registry capacity reached")
    ledger.audit_children.push({ ...child, registered_at: nowIso() })
    saveLedger(projectDirectory, ledger, ledger.revision)
  })
}

export function isRegisteredSkillAuditChild(projectDirectory: string, sessionId: string): boolean {
  return loadSkillLedger(projectDirectory).audit_children.some((child) => child.session_id === sessionId)
}

function immutablePathFor(project: string, directory: "evidence" | "revisions" | "backups" | "transactions", filename: string): string {
  const root = ensureStore(project)
  const dir = resolveContainedPath(root, directory)
  ensureVerifiedDirectory(canonicalDirectory(project), dir)
  return resolveContainedPath(dir, filename)
}

function writeImmutable(path: string, value: unknown, maximum = SKILL_EVOLUTION_MAX_JSON_BYTES): { sha256: string; byte_size: number } {
  const serialized = canonicalJson(value)
  const bytes = Buffer.from(serialized, "utf8")
  if (bytes.byteLength > maximum) throw new Error(`immutable skill-evolution object exceeds ${maximum} bytes`)
  if (existsSync(path)) {
    assertDirectRegularFile(path)
    const existing = readFileSync(path)
    if (!existing.equals(bytes)) throw new Error("immutable skill-evolution object path is occupied by different bytes")
    return { sha256: createHash("sha256").update(bytes).digest("hex"), byte_size: bytes.byteLength }
  }
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, "wx", 0o600)
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    throw error
  }
  assertDirectRegularFile(path)
  if (!readFileSync(path).equals(bytes)) throw new Error("immutable skill-evolution publication verification failed")
  return { sha256: createHash("sha256").update(bytes).digest("hex"), byte_size: bytes.byteLength }
}

export function persistSkillEvidence(projectDirectory: string, evidence: SkillEvidence) {
  const project = canonicalDirectory(projectDirectory)
  const parsed = SkillEvidenceSchema.parse(evidence)
  const { evidence_id: evidenceId, ...withoutId } = parsed
  const expectedId = createHash("sha256").update(canonicalJson(withoutId), "utf8").digest("hex")
  if (evidenceId !== expectedId) throw new Error("evidence id does not match canonical evidence bytes")
  const path = immutablePathFor(project, "evidence", `${parsed.evidence_id}.json`)
  const integrity = writeImmutable(path, parsed, parsed.truncation.aggregate_byte_limit)
  if (integrity.sha256 !== createHash("sha256").update(canonicalJson(parsed), "utf8").digest("hex")) {
    throw new Error("evidence immutable hash mismatch")
  }
  return { path: projectRelative(project, path), ...integrity }
}

export function loadEvidenceReference(projectDirectory: string, reference: { path: string; sha256: string; byte_size: number }): SkillEvidence {
  const project = canonicalDirectory(projectDirectory)
  if (!reference.path.startsWith(`${STORE_RELATIVE}/evidence/`) || !isSafeProjectRelativePath(reference.path)) throw new Error("invalid evidence reference path")
  if (!Number.isSafeInteger(reference.byte_size) || reference.byte_size < 0 || reference.byte_size > MAX_EVIDENCE_FILE_BYTES) {
    throw new Error(`evidence reference exceeds ${MAX_EVIDENCE_FILE_BYTES} bytes`)
  }
  const path = resolveContainedPath(project, ...reference.path.split("/"))
  const bytes = readDirectBounded(project, path, MAX_EVIDENCE_FILE_BYTES, "evidence reference")
  if (bytes.byteLength !== reference.byte_size || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
    throw new Error("evidence reference integrity mismatch")
  }
  return SkillEvidenceSchema.parse(JSON.parse(bytes.toString("utf8")))
}

function revisionReference(project: string, revision: SkillCandidateRevision) {
  const hash = sha256Json(revision)
  const path = immutablePathFor(project, "revisions", `${revision.candidate_id}-r${revision.revision}-${hash}.json`)
  const integrity = writeImmutable(path, revision)
  if (integrity.sha256 !== hash) throw new Error("candidate revision hash mismatch")
  return { path: projectRelative(project, path), ...integrity }
}

export function loadCandidateRevision(projectDirectory: string, record: SkillCandidateRecord, revision = record.current_revision): SkillCandidateRevision {
  const reference = record.revision_refs[revision - 1]
  if (!reference) throw new Error("candidate revision reference not found")
  if (!reference.path.startsWith(`${STORE_RELATIVE}/revisions/`) || !isSafeProjectRelativePath(reference.path)) throw new Error("invalid candidate revision path")
  if (!Number.isSafeInteger(reference.byte_size) || reference.byte_size < 0 || reference.byte_size > SKILL_EVOLUTION_MAX_JSON_BYTES) {
    throw new Error(`candidate revision exceeds ${SKILL_EVOLUTION_MAX_JSON_BYTES} bytes`)
  }
  const project = canonicalDirectory(projectDirectory)
  const path = resolveContainedPath(project, ...reference.path.split("/"))
  const bytes = readDirectBounded(project, path, SKILL_EVOLUTION_MAX_JSON_BYTES, "candidate revision")
  if (bytes.byteLength !== reference.byte_size || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
    throw new Error("candidate revision integrity mismatch")
  }
  const loaded = SkillCandidateRevisionSchema.parse(JSON.parse(bytes.toString("utf8")))
  if (loaded.candidate_id !== record.candidate_id || loaded.revision !== revision) throw new Error("candidate revision identity mismatch")
  return loaded
}

export function createSkillCandidate(
  projectDirectory: string,
  ledgerKey: string,
  output: AuditorOutput,
  evidenceRef: { path: string; sha256: string; byte_size: number },
  auditorChildId: string,
  checkerChildId: string | null,
  checker: SkillCheckerOutput | null,
  options: SkillEvolutionOptions,
): SkillCandidateRecord {
  return withSkillEvolutionLock(projectDirectory, "candidate-create", () => {
    const project = canonicalDirectory(projectDirectory)
    const index = loadSkillCandidates(project)
    const candidateId = `se-${ledgerKey.slice(0, 24)}`
    const existing = index.candidates.find((candidate) => candidate.candidate_id === candidateId)
    if (existing) return existing
    if (index.candidates.length >= options.maxCandidates) throw new Error("skill-evolution candidate capacity reached")
    if ((output.decision === "skill_candidate" || output.decision === "skill_revision") &&
      utf8Bytes(output.skill.content) > options.maxCandidateContentBytes) {
      throw new Error("auditor candidate exceeds configured content bound")
    }
    const createdAt = nowIso()
    const passed = checker?.passed === true
    const skillDecision = output.decision === "skill_candidate" || output.decision === "skill_revision"
    if (skillDecision && (!checker || !checkerChildId)) throw new Error("skill candidates require a fresh checker result and child identity")
    if (!skillDecision && (checker || checkerChildId)) throw new Error("memory candidates must not carry checker approval")
    const revision = SkillCandidateRevisionSchema.parse({
      schema_version: 1,
      kind: "skill_evolution_candidate_revision",
      candidate_id: candidateId,
      revision: 1,
      state: passed ? "validated" : "proposed",
      event: skillDecision ? passed ? "checker_passed" : "checker_failed" : "proposed",
      actor_session_id: skillDecision ? checkerChildId : output.provenance.session_id,
      reason: checker === null ? "auditor proposed a memory candidate; memory promotion is unavailable in 0.3" :
        passed ? "fresh checker passed the skill candidate" : "fresh checker rejected the skill candidate",
      created_at: createdAt,
      auditor_output: output,
      ...(checker ? { checker_output: checker } : {}),
    })
    const ref = revisionReference(project, revision)
    const record = SkillCandidateRecordSchemaCompat({
      candidate_id: candidateId,
      type: skillDecision ? "skill" : "memory",
      decision: output.decision,
      state: passed ? "validated" : "proposed",
      current_revision: 1,
      revision_refs: [ref],
      evidence_refs: [evidenceRef],
      provenance: output.provenance,
      target: skillDecision ? output.skill.target : null,
      auditor_child_id: auditorChildId,
      checker_child_id: checkerChildId,
      checker_findings: checker?.findings ?? [],
      created_at: createdAt,
      updated_at: createdAt,
      promoted_hash: null,
      promoted_at: null,
      promoted_root: null,
      backup_ref: null,
    })
    index.candidates.push(record)
    const saved = saveCandidates(project, index, index.revision)
    return saved.candidates.find((candidate) => candidate.candidate_id === candidateId)!
  })
}

function SkillCandidateRecordSchemaCompat(value: unknown): SkillCandidateRecord {
  return SkillCandidateIndexSchema.parse({ ...emptyCandidates(), candidates: [value] }).candidates[0]!
}

export function findSkillCandidate(projectDirectory: string, candidateId: string): SkillCandidateRecord | null {
  return loadSkillCandidates(projectDirectory).candidates.find((candidate) => candidate.candidate_id === candidateId) ?? null
}

export interface CandidateRevisionChange {
  state: CandidateState
  event: SkillCandidateRevision["event"]
  actorSessionId: string
  reason: string
  checkerOutput?: SkillCheckerOutput
  promotion?: SkillCandidateRevision["promotion"]
  update(record: SkillCandidateRecord): void
}

export function appendSkillCandidateRevision(
  projectDirectory: string,
  candidateId: string,
  expectedRevision: number,
  change: CandidateRevisionChange,
): SkillCandidateRecord {
  return withSkillEvolutionLock(projectDirectory, "candidate-revision", () =>
    appendSkillCandidateRevisionLocked(projectDirectory, candidateId, expectedRevision, change))
}

/** Caller must hold the project skill-evolution mutation lock. */
export function appendSkillCandidateRevisionLocked(
  projectDirectory: string,
  candidateId: string,
  expectedRevision: number,
  change: CandidateRevisionChange,
): SkillCandidateRecord {
    const project = canonicalDirectory(projectDirectory)
    const index = loadSkillCandidates(project)
    const record = index.candidates.find((candidate) => candidate.candidate_id === candidateId)
    if (!record) throw new Error("skill-evolution candidate not found")
    if (record.current_revision !== expectedRevision) throw new Error("skill-evolution candidate changed concurrently")
    const current = loadCandidateRevision(project, record)
    if (current.state !== record.state) throw new Error("skill-evolution candidate current revision/state identity mismatch")
    if (record.current_revision >= SKILL_EVOLUTION_MAX_REVISIONS) throw new Error("skill-evolution candidate revision capacity reached")
    const nextRevision = record.current_revision + 1
    const revision = SkillCandidateRevisionSchema.parse({
      schema_version: 1,
      kind: "skill_evolution_candidate_revision",
      candidate_id: candidateId,
      revision: nextRevision,
      state: change.state,
      event: change.event,
      actor_session_id: change.actorSessionId,
      reason: change.reason,
      created_at: nowIso(),
      ...(change.checkerOutput ? { checker_output: change.checkerOutput } : {}),
      ...(change.promotion ? { promotion: change.promotion } : {}),
    })
    const ref = revisionReference(project, revision)
    record.state = change.state
    record.current_revision = nextRevision
    record.revision_refs.push(ref)
    record.updated_at = revision.created_at
    change.update(record)
    const saved = saveCandidates(project, index, index.revision)
    return saved.candidates.find((candidate) => candidate.candidate_id === candidateId)!
}

export function markSkillLedgerOutcome(
  projectDirectory: string,
  key: string,
  outcome: { status: "no-change"; trigger_score: number; trigger_labels: SkillLedgerRecord["trigger_labels"]; evidence_ref?: SkillLedgerRecord["evidence_ref"] } |
    { status: "candidate"; trigger_score: number; trigger_labels: SkillLedgerRecord["trigger_labels"]; evidence_ref: NonNullable<SkillLedgerRecord["evidence_ref"]>; candidate_id: string },
): SkillLedgerRecord {
  return updateSkillLedgerRecord(projectDirectory, key, (record) => {
    record.status = outcome.status
    record.trigger_score = outcome.trigger_score
    record.trigger_labels = outcome.trigger_labels
    if (outcome.evidence_ref) record.evidence_ref = outcome.evidence_ref
    if (outcome.status === "candidate") record.candidate_id = outcome.candidate_id
    delete record.error
  })
}

export function skillContentHash(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex")
}

export interface ParsedSkillFrontmatter { name: string; description: string }

export function validateProposedSkill(content: string, target: string, maximumBytes = SKILL_EVOLUTION_MAX_CONTENT_BYTES): ParsedSkillFrontmatter {
  if (utf8Bytes(content) > Math.min(SKILL_EVOLUTION_MAX_CONTENT_BYTES, maximumBytes)) throw new Error("proposed SKILL.md exceeds configured size")
  if (/\r(?!\n)/.test(content) || content.includes("\0")) throw new Error("proposed SKILL.md contains unsupported control data")
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md$/.test(target)) throw new Error("candidate skill target is unsafe")
  const folder = target.split("/")[0]!
  if (!isSafeId(folder)) throw new Error("candidate skill target uses an unsafe or reserved folder")
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content)
  if (!match) throw new Error("proposed SKILL.md requires YAML frontmatter")
  const lines = match[1]!.split(/\r?\n/)
  const allowed = new Set(["name", "description", "license", "compatibility", "metadata"])
  const values = new Map<string, string>()
  let parent = ""
  for (const line of lines) {
    if (!line.trim() || /^\s*#/.test(line)) continue
    if (/^\s/.test(line)) {
      if (parent !== "metadata" || !/^\s{2,}[A-Za-z0-9_.-]+\s*:\s*\S.*$/.test(line)) {
        throw new Error("proposed SKILL.md contains malformed or unsupported YAML frontmatter")
      }
      continue
    }
    const entry = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line)
    if (!entry || !allowed.has(entry[1]!)) throw new Error("proposed SKILL.md contains malformed or unsupported YAML frontmatter")
    const key = entry[1]!
    if (values.has(key)) throw new Error(`proposed SKILL.md has duplicate ${key} frontmatter`)
    values.set(key, entry[2]!)
    parent = key
  }
  const scalar = (key: string): string | null => {
    const raw = values.get(key)
    if (raw === undefined) return null
    const value = raw.trim()
    if (!value) return null
    if (value.startsWith("\"") || value.startsWith("'")) {
      if (value.length < 2 || value.at(-1) !== value[0]) return null
      return value.slice(1, -1)
    }
    return value
  }
  const name = scalar("name")
  const description = scalar("description")
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 || name !== folder) {
    throw new Error("skill frontmatter name must equal the lowercase-hyphen folder")
  }
  if (!description || description.length > 1_024 || /\b(?:I|me|my|we|our|us)\b/i.test(description)) {
    throw new Error("skill description must be nonempty, bounded, and third-person")
  }
  if (/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----|\b(?:sk|rk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{16,}|\bgh[opusr]_[A-Za-z0-9]{20,}|\bAKIA[A-Z0-9]{16}\b/i.test(content) ||
    /(?:authorization|api[-_ ]?key|token|cookie|secret|password)\s*[:=]\s*["']?(?!\[REDACTED\])\S{8,}/i.test(content)) {
    throw new Error("proposed SKILL.md contains an obvious secret")
  }
  if (/\]\((?:file:\/\/|[A-Za-z]:[\\/]|\/(?!\/))|(?:^|\s)(?:resources?|path)\s*:\s*(?:[A-Za-z]:[\\/]|\/)/im.test(content)) {
    throw new Error("proposed SKILL.md contains an unsupported absolute resource")
  }
  return { name, description }
}

export function configuredSkillTarget(
  projectDirectory: string,
  rootRelative: string,
  target: string,
): { project: string; root: string; target: string; target_relative: string } {
  const project = canonicalDirectory(projectDirectory)
  if (!isSafeProjectRelativePath(rootRelative)) throw new Error("configured skill root is unsafe")
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*\/SKILL\.md$/.test(target)) throw new Error("candidate skill target is unsafe")
  if (!isSafeId(target.split("/")[0]!)) throw new Error("candidate skill target uses an unsafe or reserved folder")
  const root = resolve(project, ...rootRelative.split("/"))
  const path = resolve(root, ...target.split("/"))
  if (!isContained(project, root) || root === project || !isContained(root, path) || !isContained(project, path)) {
    throw new Error("candidate skill target escaped project")
  }
  assertExistingDirectComponents(project, root, "directory")
  assertExistingDirectComponents(project, path, "file")
  return { project, root, target: path, target_relative: `${rootRelative}/${target}` }
}

export function ensureConfiguredSkillRoot(projectDirectory: string, rootRelative: string): string {
  const target = configuredSkillTarget(projectDirectory, rootRelative, "placeholder/SKILL.md")
  return ensureVerifiedDirectory(target.project, target.root)
}

export function directFileHash(path: string): { sha256: string; identity: SkillFileIdentity; bytes: Buffer } {
  assertDirectRegularFile(path)
  const pathBefore = lstatSync(path, { bigint: true })
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const descriptor = openSync(path, constants.O_RDONLY | noFollow)
  try {
    const openedBefore = fstatSync(descriptor, { bigint: true })
    if (!openedBefore.isFile() || openedBefore.size > BigInt(SKILL_EVOLUTION_MAX_CONTENT_BYTES)) {
      throw new Error("skill file exceeds 64 KiB or is not regular")
    }
    if (openedBefore.dev !== pathBefore.dev || openedBefore.ino !== pathBefore.ino || openedBefore.size !== pathBefore.size) {
      throw new Error("skill file identity changed before reading")
    }
    const bytes = readFileSync(descriptor)
    const openedAfter = fstatSync(descriptor, { bigint: true })
    const pathAfter = lstatSync(path, { bigint: true })
    const stable = (left: typeof openedBefore, right: typeof openedBefore) =>
      left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
      left.mode === right.mode && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs
    if (BigInt(bytes.byteLength) !== openedBefore.size || !stable(openedBefore, openedAfter) ||
      !stable(pathBefore, pathAfter) || openedAfter.dev !== pathAfter.dev || openedAfter.ino !== pathAfter.ino ||
      !pathAfter.isFile() || pathAfter.isSymbolicLink() || !samePath(realpathSync.native(path), path)) {
      throw new Error("skill file changed while reading")
    }
    return {
      sha256: skillContentHash(bytes),
      identity: { dev: openedBefore.dev.toString(), ino: openedBefore.ino.toString(), size: openedBefore.size.toString() },
      bytes,
    }
  } finally {
    closeSync(descriptor)
  }
}

export function transactionJournalPath(project: string, transactionId: string): string {
  return immutablePathFor(project, "transactions", `${transactionId}.json`)
}

export function writeSkillTransaction(projectDirectory: string, journal: SkillTransactionJournal): string {
  const parsed = SkillTransactionJournalSchema.parse(journal)
  const path = transactionJournalPath(projectDirectory, parsed.transaction_id)
  writeImmutable(path, parsed, 64 * 1024)
  return path
}

export function removeSkillTransaction(projectDirectory: string, transactionId: string): void {
  const path = transactionJournalPath(projectDirectory, transactionId)
  if (!existsSync(path)) return
  assertDirectRegularFile(path)
  rmSync(path)
}

export function newSkillTransactionId(): string {
  return `tx-${randomUUID().replaceAll("-", "")}`
}

export function listSkillTransactions(projectDirectory: string): SkillTransactionJournal[] {
  const entries = scanSkillTransactions(projectDirectory)
  const invalid = entries.find((entry) => !entry.journal)
  if (invalid) throw new Error(invalid.error)
  return entries.map((entry) => entry.journal!)
}

interface ScannedSkillTransaction {
  name: string
  path: string
  journal?: SkillTransactionJournal
  error?: string
}

function scanSkillTransactions(projectDirectory: string): ScannedSkillTransaction[] {
  const root = ensureStore(projectDirectory)
  const directory = resolveContainedPath(root, "transactions")
  ensureVerifiedDirectory(canonicalDirectory(projectDirectory), directory)
  const children = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
  if (children.length > 128) throw new Error("skill-evolution transaction scan exceeded its bound")
  return children.map((entry) => {
    const path = resolve(directory, entry.name)
    try {
      if (!entry.isFile() || !/^tx-[A-Za-z0-9._-]+\.json$/.test(entry.name) || !isSafeId(entry.name.slice(0, -5))) {
        throw new Error("unexpected transaction entry name or type")
      }
      assertExistingDirectComponents(canonicalDirectory(projectDirectory), path, "file")
      const journal = SkillTransactionJournalSchema.parse(readBoundedJson(path, 64 * 1024))
      if (`${journal.transaction_id}.json` !== entry.name) throw new Error("transaction filename does not match journal identity")
      return { name: entry.name, path, journal }
    } catch (error) {
      return { name: entry.name, path, error: safeDiagnosticText(error instanceof Error ? error.message : String(error)) }
    }
  })
}

function skillBackupPath(projectDirectory: string, candidateId: string, hash: string, transactionId: string): string {
  const project = canonicalDirectory(projectDirectory)
  if (!isSafeId(candidateId) || !isSafeId(transactionId) || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("invalid skill backup identity")
  }
  return immutablePathFor(project, "backups", `${candidateId}-${hash}-${transactionId}.bin`)
}

/** Always creates an independent, exclusive backup; pre-existing names are never reused. */
export function backupSkillBytes(
  projectDirectory: string,
  candidateId: string,
  bytes: Buffer,
  sourceIdentity?: SkillFileIdentity,
  transactionId = newSkillTransactionId(),
) {
  const project = canonicalDirectory(projectDirectory)
  const hash = skillContentHash(bytes)
  const path = skillBackupPath(project, candidateId, hash, transactionId)
  const fd = openSync(path, "wx", 0o600)
  try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
  const captured = directFileHash(path)
  if (captured.sha256 !== hash || !captured.bytes.equals(bytes)) throw new Error("skill backup publication verification failed")
  if (sourceIdentity && isDeepFileIdentity(captured.identity, sourceIdentity)) {
    throw new Error("skill backup must be independent from the public source")
  }
  return { path: projectRelative(project, path), sha256: hash, byte_size: bytes.byteLength }
}

export function readBackupBytes(projectDirectory: string, reference: { path: string; sha256: string; byte_size: number }): Buffer {
  if (!reference.path.startsWith(`${STORE_RELATIVE}/backups/`) || !isSafeProjectRelativePath(reference.path)) throw new Error("invalid skill backup reference")
  const project = canonicalDirectory(projectDirectory)
  const path = resolveContainedPath(project, ...reference.path.split("/"))
  const current = directFileHash(path)
  if (current.sha256 !== reference.sha256 || current.bytes.byteLength !== reference.byte_size) throw new Error("skill backup integrity mismatch")
  return current.bytes
}

function ensureSkillTargetParent(projectDirectory: string, rootRelative: string, targetRelative: string) {
  const selected = configuredSkillTarget(projectDirectory, rootRelative, targetRelative)
  ensureVerifiedDirectory(selected.project, selected.root)
  ensureVerifiedDirectory(selected.project, dirname(selected.target))
  // Re-resolve after creation so every existing component is canonical and contained.
  return configuredSkillTarget(projectDirectory, rootRelative, targetRelative)
}

function createPreparedSkill(path: string, bytes: Buffer): void {
  const descriptor = openSync(path, "wx", 0o600)
  try {
    writeFileSync(descriptor, bytes)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  const verified = directFileHash(path)
  if (!verified.bytes.equals(bytes)) throw new Error("prepared skill bytes changed")
}

function fileHashOrNull(path: string): ReturnType<typeof directFileHash> | null {
  try {
    return directFileHash(path)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return null
    throw error
  }
}

function removeVerifiedFile(path: string, expectedHash: string, expectedIdentity?: SkillFileIdentity): void {
  if (missingPath(path)) return
  const current = directFileHash(path)
  if (current.sha256 !== expectedHash || expectedIdentity && !isDeepFileIdentity(current.identity, expectedIdentity)) {
    throw new Error("transaction-owned file changed; preserving it")
  }
  unlinkSync(path)
}

function candidateProposal(projectDirectory: string, record: SkillCandidateRecord) {
  const initial = loadCandidateRevision(projectDirectory, record, 1)
  const output = initial.auditor_output
  if (!output || (output.decision !== "skill_candidate" && output.decision !== "skill_revision")) {
    throw new Error("candidate has no immutable skill proposal")
  }
  return output.skill
}

function assertCurrentCandidateRevision(projectDirectory: string, record: SkillCandidateRecord): SkillCandidateRevision {
  const current = loadCandidateRevision(projectDirectory, record)
  if (current.state !== record.state) throw new Error("candidate index state does not match its immutable current revision")
  return current
}

function assertCheckerApprovedSkill(projectDirectory: string, record: SkillCandidateRecord): void {
  if (record.type !== "skill" || !record.checker_child_id) throw new Error("skill candidate has no checker provenance")
  const initial = loadCandidateRevision(projectDirectory, record, 1)
  if (initial.checker_output?.passed !== true || initial.checker_output.findings.length !== 0 ||
    initial.event !== "checker_passed" || initial.state !== "validated" ||
    initial.actor_session_id !== record.checker_child_id || record.checker_findings.length !== 0) {
    throw new Error("candidate does not have an immutable passing checker verdict")
  }
}

function promotionRoot(
  projectDirectory: string,
  record: SkillCandidateRecord,
  proposal: ReturnType<typeof candidateProposal>,
  options: SkillEvolutionOptions,
): string {
  if (record.target !== proposal.target) throw new Error("candidate target metadata mismatch")
  if (proposal.operation === "create") {
    for (const root of options.skillRoots) {
      const selected = configuredSkillTarget(projectDirectory, root, proposal.target)
      if (fileHashOrNull(selected.target)) throw new Error("create target is no longer absent from every configured skill root")
    }
    return options.skillRoots[0]!
  }
  const matches = options.skillRoots.filter((root) => {
    const selected = configuredSkillTarget(projectDirectory, root, proposal.target)
    const current = fileHashOrNull(selected.target)
    return current?.sha256 === proposal.basis_sha256
  })
  if (matches.length !== 1) throw new Error("replace basis no longer identifies exactly one configured skill root")
  return matches[0]!
}

export interface SkillPublicationResult {
  candidate: SkillCandidateRecord
  target: string
  before_sha256: string | null
  after_sha256: string
  restart_required: true
}

/** Deterministic failure seams for adversarial transaction/recovery tests. */
export interface SkillPublicationHooks {
  afterJournal?: (journal: SkillTransactionJournal) => void
  afterBackup?: (journal: SkillTransactionJournal) => void
  afterPrepared?: (journal: SkillTransactionJournal) => void
  afterClaim?: (journal: SkillTransactionJournal) => void
  afterUnlink?: (journal: SkillTransactionJournal) => void
  afterPublish?: (journal: SkillTransactionJournal) => void
  beforeStateCommit?: (journal: SkillTransactionJournal) => void
  afterStateCommit?: (journal: SkillTransactionJournal) => void
}

function assertParentIdentity(path: string, expected: SkillFileIdentity): void {
  const current = directDirectoryIdentity(path)
  if (current.dev !== expected.dev || current.ino !== expected.ino) {
    throw new Error("skill target parent identity changed during publication")
  }
}

function assertExactFile(path: string, expected: { sha256: string; identity: SkillFileIdentity; bytes: Buffer }): void {
  const current = directFileHash(path)
  if (current.sha256 !== expected.sha256 || !isDeepFileIdentity(current.identity, expected.identity) ||
    !current.bytes.equals(expected.bytes)) {
    throw new Error("skill target hash, identity, or bytes changed concurrently")
  }
}

/** Identity-checked, create-if-absent publication. Candidate state advances only after target bytes verify. */
export function promoteSkillCandidate(
  projectDirectory: string,
  candidateId: string,
  actorSessionId: string,
  options: SkillEvolutionOptions,
  hooks: SkillPublicationHooks = {},
): SkillPublicationResult {
  // Resolve any prior file-applied/state-not-committed operation before a new one.
  const recovery = recoverSkillTransactions(projectDirectory, options)
  if (recovery.unresolved.length) throw new Error(`skill transaction recovery is unresolved: ${recovery.unresolved[0]}`)
  return withSkillEvolutionLock(projectDirectory, "promote", () => {
    const record = findSkillCandidate(projectDirectory, candidateId)
    if (!record) throw new Error("skill-evolution candidate not found")
    if (record.type !== "skill" || record.state !== "validated") throw new Error("only a validated skill candidate can be promoted")
    assertCurrentCandidateRevision(projectDirectory, record)
    assertCheckerApprovedSkill(projectDirectory, record)
    const proposal = candidateProposal(projectDirectory, record)
    validateProposedSkill(proposal.content, proposal.target, options.maxCandidateContentBytes)
    const rootRelative = promotionRoot(projectDirectory, record, proposal, options)
    const selected = ensureSkillTargetParent(projectDirectory, rootRelative, proposal.target)
    const before = fileHashOrNull(selected.target)
    if (proposal.operation === "create" && before) throw new Error("create target is no longer absent")
    if (proposal.operation === "replace" && before?.sha256 !== proposal.basis_sha256) throw new Error("replace basis hash changed; preserving custom drift")
    const content = Buffer.from(proposal.content, "utf8")
    const afterHash = skillContentHash(content)
    const transactionId = newSkillTransactionId()
    const swap = resolveContainedPath(dirname(selected.target), `.alg-skill-${transactionId}.swap`)
    const prepared = resolveContainedPath(dirname(selected.target), `.alg-skill-${transactionId}.prepared`)
    const parentIdentity = directDirectoryIdentity(dirname(selected.target))
    const plannedBackupPath = before ? skillBackupPath(projectDirectory, candidateId, before.sha256, transactionId) : null
    const journal = SkillTransactionJournalSchema.parse({
      schema_version: 1,
      kind: "skill_evolution_transaction",
      transaction_id: transactionId,
      operation: "promote",
      candidate_id: candidateId,
      candidate_revision: record.current_revision,
      actor_session_id: actorSessionId,
      created_at: nowIso(),
      target_path: selected.target,
      target_relative: selected.target_relative,
      skill_root: selected.root,
      expected_before_sha256: before?.sha256 ?? null,
      expected_after_sha256: afterHash,
      observed_before_identity: before?.identity ?? null,
      target_parent_identity: parentIdentity,
      backup_path: plannedBackupPath,
      backup_sha256: before?.sha256 ?? null,
      backup_byte_size: before?.bytes.byteLength ?? null,
      swap_path: swap,
      prepared_path: prepared,
    })
    writeSkillTransaction(projectDirectory, journal)
    hooks.afterJournal?.(journal)
    let backup: { path: string; sha256: string; byte_size: number } | null = null
    let preparedIdentity: SkillFileIdentity | undefined
    let swapIdentity: SkillFileIdentity | undefined
    try {
      if (before) {
        assertParentIdentity(dirname(selected.target), parentIdentity)
        assertExactFile(selected.target, before)
        backup = backupSkillBytes(projectDirectory, candidateId, before.bytes, before.identity, transactionId)
        if (!samePath(resolveContainedPath(selected.project, ...backup.path.split("/")), plannedBackupPath!)) {
          throw new Error("exclusive backup path differs from its transaction journal")
        }
        assertExactFile(selected.target, before)
      }
      hooks.afterBackup?.(journal)
      createPreparedSkill(prepared, content)
      preparedIdentity = directFileHash(prepared).identity
      assertParentIdentity(dirname(selected.target), parentIdentity)
      hooks.afterPrepared?.(journal)
      if (before) {
        // The claim and publication are both create-if-absent hard links. No
        // auxiliary or public destination is ever overwritten.
        linkSync(selected.target, swap)
        const claimed = directFileHash(swap)
        swapIdentity = claimed.identity
        if (claimed.sha256 !== before.sha256 || !isDeepFileIdentity(claimed.identity, before.identity) || !claimed.bytes.equals(before.bytes)) {
          throw new Error("skill target identity changed at publication claim boundary")
        }
        assertExactFile(selected.target, before)
      }
      hooks.afterClaim?.(journal)
      assertParentIdentity(dirname(selected.target), parentIdentity)
      if (before) {
        assertExactFile(selected.target, before)
        unlinkSync(selected.target)
      } else if (!missingPath(selected.target)) throw new Error("create destination became occupied")
      hooks.afterUnlink?.(journal)
      assertParentIdentity(dirname(selected.target), parentIdentity)
      linkSync(prepared, selected.target)
      const published = directFileHash(selected.target)
      if (published.sha256 !== afterHash || !preparedIdentity ||
        !isDeepFileIdentity(published.identity, preparedIdentity) || !published.bytes.equals(content)) {
        throw new Error("published skill verification failed")
      }
      hooks.afterPublish?.(journal)
      assertParentIdentity(dirname(selected.target), parentIdentity)
      removeVerifiedFile(prepared, afterHash, preparedIdentity)
      if (before) removeVerifiedFile(swap, before.sha256, swapIdentity)
      hooks.beforeStateCommit?.(journal)
      const updated = appendSkillCandidateRevisionLocked(projectDirectory, candidateId, record.current_revision, {
        state: "promoted",
        event: "promoted",
        actorSessionId,
        reason: "explicit validated-candidate promotion",
        promotion: { target: selected.target_relative, before_sha256: before?.sha256 ?? null, after_sha256: afterHash, restart_required: true },
        update(candidate) {
          candidate.promoted_hash = afterHash
          candidate.promoted_at = nowIso()
          candidate.promoted_root = rootRelative
          candidate.backup_ref = backup
        },
      })
      hooks.afterStateCommit?.(journal)
      removeSkillTransaction(projectDirectory, transactionId)
      return { candidate: updated, target: selected.target_relative, before_sha256: before?.sha256 ?? null, after_sha256: afterHash, restart_required: true }
    } catch (error) {
      // The immutable journal is intentionally retained whenever publication or
      // the subsequent candidate-state commit does not complete.
      try { if (!missingPath(prepared)) removeVerifiedFile(prepared, afterHash, preparedIdentity) } catch { /* preserve ambiguous file */ }
      throw error
    }
  })
}

function isDeepFileIdentity(
  left: { dev: string; ino: string; size: string },
  right: { dev: string; ino: string; size: string },
): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
}

export function rollbackSkillCandidate(
  projectDirectory: string,
  candidateId: string,
  actorSessionId: string,
  options: SkillEvolutionOptions,
  hooks: SkillPublicationHooks = {},
): SkillPublicationResult {
  const recovery = recoverSkillTransactions(projectDirectory, options)
  if (recovery.unresolved.length) throw new Error(`skill transaction recovery is unresolved: ${recovery.unresolved[0]}`)
  return withSkillEvolutionLock(projectDirectory, "rollback", () => {
    const record = findSkillCandidate(projectDirectory, candidateId)
    if (!record || record.state !== "promoted" || record.type !== "skill" || !record.promoted_root || !record.promoted_hash) {
      throw new Error("only a promoted skill candidate can be rolled back")
    }
    const promotedRevision = assertCurrentCandidateRevision(projectDirectory, record)
    if (promotedRevision.event !== "promoted" || promotedRevision.promotion?.after_sha256 !== record.promoted_hash) {
      throw new Error("promoted candidate metadata does not match its immutable current revision")
    }
    if (!record.backup_ref) throw new Error("created skills are not deleted; rollback is available only for replaced skills")
    const proposal = candidateProposal(projectDirectory, record)
    const selected = ensureSkillTargetParent(projectDirectory, record.promoted_root, proposal.target)
    const current = directFileHash(selected.target)
    if (current.sha256 !== record.promoted_hash) throw new Error("current skill has custom drift; rollback preserves it")
    const backupBytes = readBackupBytes(projectDirectory, record.backup_ref)
    const backupHash = skillContentHash(backupBytes)
    if (backupHash !== record.backup_ref.sha256 || backupBytes.byteLength !== record.backup_ref.byte_size) {
      throw new Error("immutable rollback backup does not match candidate metadata")
    }
    const transactionId = newSkillTransactionId()
    const swap = resolveContainedPath(dirname(selected.target), `.alg-skill-${transactionId}.swap`)
    const prepared = resolveContainedPath(dirname(selected.target), `.alg-skill-${transactionId}.prepared`)
    const backupPath = resolveContainedPath(selected.project, ...record.backup_ref.path.split("/"))
    const parentIdentity = directDirectoryIdentity(dirname(selected.target))
    const journal = SkillTransactionJournalSchema.parse({
      schema_version: 1,
      kind: "skill_evolution_transaction",
      transaction_id: transactionId,
      operation: "rollback",
      candidate_id: candidateId,
      candidate_revision: record.current_revision,
      actor_session_id: actorSessionId,
      created_at: nowIso(),
      target_path: selected.target,
      target_relative: selected.target_relative,
      skill_root: selected.root,
      expected_before_sha256: current.sha256,
      expected_after_sha256: backupHash,
      observed_before_identity: current.identity,
      target_parent_identity: parentIdentity,
      backup_path: backupPath,
      backup_sha256: backupHash,
      backup_byte_size: backupBytes.byteLength,
      swap_path: swap,
      prepared_path: prepared,
    })
    writeSkillTransaction(projectDirectory, journal)
    hooks.afterJournal?.(journal)
    let preparedIdentity: SkillFileIdentity | undefined
    let swapIdentity: SkillFileIdentity | undefined
    try {
      assertParentIdentity(dirname(selected.target), parentIdentity)
      assertExactFile(selected.target, current)
      hooks.afterBackup?.(journal)
      createPreparedSkill(prepared, backupBytes)
      preparedIdentity = directFileHash(prepared).identity
      hooks.afterPrepared?.(journal)
      assertParentIdentity(dirname(selected.target), parentIdentity)
      linkSync(selected.target, swap)
      const claimed = directFileHash(swap)
      swapIdentity = claimed.identity
      if (claimed.sha256 !== current.sha256 || !isDeepFileIdentity(claimed.identity, current.identity) || !claimed.bytes.equals(current.bytes)) {
        throw new Error("promoted skill identity changed at rollback claim boundary")
      }
      assertExactFile(selected.target, current)
      hooks.afterClaim?.(journal)
      assertParentIdentity(dirname(selected.target), parentIdentity)
      assertExactFile(selected.target, current)
      unlinkSync(selected.target)
      hooks.afterUnlink?.(journal)
      assertParentIdentity(dirname(selected.target), parentIdentity)
      linkSync(prepared, selected.target)
      const published = directFileHash(selected.target)
      if (published.sha256 !== backupHash || !preparedIdentity ||
        !isDeepFileIdentity(published.identity, preparedIdentity) || !published.bytes.equals(backupBytes)) {
        throw new Error("rollback target verification failed")
      }
      hooks.afterPublish?.(journal)
      assertParentIdentity(dirname(selected.target), parentIdentity)
      removeVerifiedFile(prepared, backupHash, preparedIdentity)
      removeVerifiedFile(swap, current.sha256, swapIdentity)
      hooks.beforeStateCommit?.(journal)
      const updated = appendSkillCandidateRevisionLocked(projectDirectory, candidateId, record.current_revision, {
        state: "rolled_back",
        event: "rolled_back",
        actorSessionId,
        reason: "explicit rollback restored the immutable pre-promotion backup",
        promotion: { target: selected.target_relative, before_sha256: current.sha256, after_sha256: backupHash, restart_required: true },
        update() {},
      })
      hooks.afterStateCommit?.(journal)
      removeSkillTransaction(projectDirectory, transactionId)
      return { candidate: updated, target: selected.target_relative, before_sha256: current.sha256, after_sha256: backupHash, restart_required: true }
    } catch (error) {
      try { if (!missingPath(prepared)) removeVerifiedFile(prepared, backupHash, preparedIdentity) } catch { /* preserve ambiguity */ }
      throw error
    }
  })
}

export interface SkillRecoveryReport {
  recovered: string[]
  unresolved: string[]
  pending: number
  file_mutations: number
}

function validateJournalPaths(project: string, journal: SkillTransactionJournal, options: SkillEvolutionOptions, record: SkillCandidateRecord) {
  const proposal = candidateProposal(project, record)
  validateProposedSkill(proposal.content, proposal.target, options.maxCandidateContentBytes)
  if (record.target !== proposal.target) throw new Error("journal candidate target metadata is inconsistent")
  assertCurrentCandidateRevision(project, record)
  let rootRelative: string | null = null
  if (journal.operation === "promote") {
    if (journal.candidate_revision === record.current_revision) {
      if (record.state !== "validated") throw new Error("uncommitted promote journal candidate is not validated")
      assertCheckerApprovedSkill(project, record)
    } else if (journal.candidate_revision + 1 === record.current_revision) {
      const current = loadCandidateRevision(project, record)
      if (record.state !== "promoted" || current.event !== "promoted" ||
        current.promotion?.after_sha256 !== journal.expected_after_sha256) {
        throw new Error("committed promote journal does not match candidate state")
      }
    } else throw new Error("promote journal candidate revision is stale or from the future")
    if (skillContentHash(Buffer.from(proposal.content, "utf8")) !== journal.expected_after_sha256) {
      throw new Error("promote journal after hash does not match immutable proposal bytes")
    }
    if (proposal.operation === "create") {
      if (journal.expected_before_sha256 !== null || journal.observed_before_identity !== null ||
        journal.backup_path !== null || journal.backup_sha256 !== null || journal.backup_byte_size !== null) {
        throw new Error("create journal must have null before and backup fields")
      }
      rootRelative = options.skillRoots[0] ?? null
    } else {
      if (journal.expected_before_sha256 !== proposal.basis_sha256 || !journal.observed_before_identity) {
        throw new Error("replace journal does not match immutable basis hash and identity")
      }
      rootRelative = options.skillRoots.find((root) => samePath(configuredSkillTarget(project, root, proposal.target).root, journal.skill_root)) ?? null
      const expectedBackup = skillBackupPath(project, record.candidate_id, proposal.basis_sha256!, journal.transaction_id)
      if (!journal.backup_path || !samePath(journal.backup_path, expectedBackup) ||
        journal.backup_sha256 !== proposal.basis_sha256 ||
        journal.backup_byte_size !== Number(journal.observed_before_identity.size)) {
        throw new Error("replace journal backup path, hash, or size is not transaction-exact")
      }
    }
  } else {
    if (!record.promoted_root || !record.promoted_hash || !record.backup_ref) {
      throw new Error("rollback journal candidate has no complete promotion metadata")
    }
    if (journal.candidate_revision === record.current_revision) {
      if (record.state !== "promoted") throw new Error("uncommitted rollback journal candidate is not promoted")
    } else if (journal.candidate_revision + 1 === record.current_revision) {
      const current = loadCandidateRevision(project, record)
      if (record.state !== "rolled_back" || current.event !== "rolled_back" ||
        current.promotion?.after_sha256 !== journal.expected_after_sha256) {
        throw new Error("committed rollback journal does not match candidate state")
      }
    } else throw new Error("rollback journal candidate revision is stale or from the future")
    rootRelative = record.promoted_root
    const expectedBackup = resolveContainedPath(project, ...record.backup_ref.path.split("/"))
    if (journal.expected_before_sha256 !== record.promoted_hash || !journal.observed_before_identity ||
      journal.expected_after_sha256 !== record.backup_ref.sha256 || !journal.backup_path ||
      !samePath(journal.backup_path, expectedBackup) || journal.backup_sha256 !== record.backup_ref.sha256 ||
      journal.backup_byte_size !== record.backup_ref.byte_size) {
      throw new Error("rollback journal hashes, identity, or backup reference do not match the promoted candidate")
    }
  }
  if (!rootRelative || !options.skillRoots.includes(rootRelative)) throw new Error("journal skill root is not configured")
  const selected = configuredSkillTarget(project, rootRelative, proposal.target)
  const expectedSwap = resolveContainedPath(dirname(selected.target), `.alg-skill-${journal.transaction_id}.swap`)
  const expectedPrepared = resolveContainedPath(dirname(selected.target), `.alg-skill-${journal.transaction_id}.prepared`)
  if (!samePath(selected.target, journal.target_path) || !samePath(selected.root, journal.skill_root) ||
    selected.target_relative !== journal.target_relative || !samePath(expectedSwap, journal.swap_path) ||
    !samePath(expectedPrepared, journal.prepared_path)) {
    throw new Error("journal paths do not match the exact configured candidate target")
  }
  const parentIdentity = directDirectoryIdentity(dirname(selected.target))
  if (parentIdentity.dev !== journal.target_parent_identity.dev || parentIdentity.ino !== journal.target_parent_identity.ino) {
    throw new Error("journal target parent identity changed")
  }
  return { selected, rootRelative, proposal }
}

function verifiedJournalBackup(project: string, journal: SkillTransactionJournal, required: boolean) {
  if (!journal.backup_path || !journal.backup_sha256 || journal.backup_byte_size === null) {
    if (required) throw new Error("transaction requires an exact backup")
    return null
  }
  const backup = fileHashOrNull(journal.backup_path)
  if (!backup) {
    if (required) throw new Error("transaction backup is absent")
    return null
  }
  if (backup.sha256 !== journal.backup_sha256 || backup.bytes.byteLength !== journal.backup_byte_size ||
    journal.observed_before_identity && isDeepFileIdentity(backup.identity, journal.observed_before_identity)) {
    throw new Error("transaction backup hash, size, or independence is invalid")
  }
  const relativePath = projectRelative(project, journal.backup_path)
  return { path: relativePath, sha256: backup.sha256, byte_size: backup.bytes.byteLength, capture: backup }
}

function cleanAbortedPromotionBackup(project: string, journal: SkillTransactionJournal, record: SkillCandidateRecord): void {
  if (journal.operation !== "promote" || record.current_revision !== journal.candidate_revision || !journal.backup_path) return
  const backup = verifiedJournalBackup(project, journal, false)
  if (backup) removeVerifiedFile(journal.backup_path, backup.sha256, backup.capture.identity)
}

/** Restart/status recovery commits an already-applied exact state or restores an absent target from the exact swap. */
export function recoverSkillTransactions(projectDirectory: string, options: SkillEvolutionOptions): SkillRecoveryReport {
  return withSkillEvolutionLock(projectDirectory, "transaction-recovery", () => {
    const project = canonicalDirectory(projectDirectory)
    const report: SkillRecoveryReport = { recovered: [], unresolved: [], pending: 0, file_mutations: 0 }
    for (const entry of scanSkillTransactions(project)) {
      if (!entry.journal) {
        report.unresolved.push(`${entry.name}: ${entry.error}`)
        continue
      }
      const journal = entry.journal
      try {
        const record = findSkillCandidate(project, journal.candidate_id)
        if (!record) throw new Error("journal candidate is missing")
        const { selected, rootRelative, proposal } = validateJournalPaths(project, journal, options, record)
        const target = fileHashOrNull(selected.target)
        const swap = fileHashOrNull(journal.swap_path)
        const prepared = fileHashOrNull(journal.prepared_path)
        if (swap && (journal.expected_before_sha256 === null || !journal.observed_before_identity ||
          swap.sha256 !== journal.expected_before_sha256 || !isDeepFileIdentity(swap.identity, journal.observed_before_identity))) {
          throw new Error("transaction swap hash or identity is a third state")
        }
        if (prepared && prepared.sha256 !== journal.expected_after_sha256) {
          throw new Error("transaction prepared file is a third state")
        }
        const exactBefore = journal.expected_before_sha256 === null
          ? target === null
          : Boolean(target && target.sha256 === journal.expected_before_sha256 && journal.observed_before_identity &&
            isDeepFileIdentity(target.identity, journal.observed_before_identity))
        if (target?.sha256 === journal.expected_before_sha256 && !exactBefore) {
          throw new Error("public before-state hash matches but identity changed")
        }
        if (!target && swap) {
          // A crash happened after moving the public name but before publishing.
          // Restore exact prior bytes create-if-absent; never continue a guessed write.
          linkSync(journal.swap_path, selected.target)
          const restored = directFileHash(selected.target)
          if (restored.sha256 !== journal.expected_before_sha256 || !journal.observed_before_identity ||
            !isDeepFileIdentity(restored.identity, journal.observed_before_identity)) throw new Error("restored target verification failed")
          removeVerifiedFile(journal.swap_path, journal.expected_before_sha256!, swap.identity)
          if (prepared) removeVerifiedFile(journal.prepared_path, journal.expected_after_sha256, prepared.identity)
          cleanAbortedPromotionBackup(project, journal, record)
          removeSkillTransaction(project, journal.transaction_id)
          report.recovered.push(`${journal.transaction_id}:restored-before-state`)
          report.file_mutations++
          continue
        }
        if (exactBefore) {
          if (swap) removeVerifiedFile(journal.swap_path, journal.expected_before_sha256!, swap.identity)
          if (prepared) removeVerifiedFile(journal.prepared_path, journal.expected_after_sha256, prepared.identity)
          cleanAbortedPromotionBackup(project, journal, record)
          removeSkillTransaction(project, journal.transaction_id)
          report.recovered.push(`${journal.transaction_id}:no-file-change`)
          continue
        }
        if (target?.sha256 !== journal.expected_after_sha256) {
          throw new Error("target is a third state; custom drift is preserved")
        }
        if (record.current_revision === journal.candidate_revision) {
          const backup = verifiedJournalBackup(project, journal,
            journal.operation === "rollback" || journal.operation === "promote" && proposal.operation === "replace")
          const backupRef = journal.operation === "promote" && backup
            ? { path: backup.path, sha256: backup.sha256, byte_size: backup.byte_size }
            : null
          if (journal.operation === "promote" && proposal.operation === "create" && backupRef) {
            throw new Error("create recovery unexpectedly has a backup")
          }
          if (journal.operation === "promote") {
            const expectedBytes = Buffer.from(proposal.content, "utf8")
            if (!target.bytes.equals(expectedBytes)) throw new Error("applied promote bytes differ from immutable proposal")
          } else if (!backup || !target.bytes.equals(backup.capture.bytes)) {
            throw new Error("applied rollback bytes differ from immutable backup")
          }
          appendSkillCandidateRevisionLocked(project, record.candidate_id, record.current_revision, {
            state: journal.operation === "promote" ? "promoted" : "rolled_back",
            event: journal.operation === "promote" ? "promoted" : "rolled_back",
            actorSessionId: journal.actor_session_id,
            reason: `recovered exact file-applied ${journal.operation} transaction`,
            promotion: {
              target: journal.target_relative,
              before_sha256: journal.expected_before_sha256,
              after_sha256: journal.expected_after_sha256,
              restart_required: true,
            },
            update(candidate) {
              if (journal.operation === "promote") {
                candidate.promoted_hash = journal.expected_after_sha256
                candidate.promoted_at = journal.created_at
                candidate.promoted_root = rootRelative
                candidate.backup_ref = backupRef
              }
            },
          })
        } else if (!((journal.operation === "promote" && record.state === "promoted" && record.promoted_hash === journal.expected_after_sha256) ||
          (journal.operation === "rollback" && record.state === "rolled_back"))) {
          throw new Error("candidate revision is a third state")
        }
        if (swap) removeVerifiedFile(journal.swap_path, journal.expected_before_sha256!, swap.identity)
        if (prepared) removeVerifiedFile(journal.prepared_path, journal.expected_after_sha256, prepared.identity)
        removeSkillTransaction(project, journal.transaction_id)
        report.recovered.push(`${journal.transaction_id}:committed-${journal.operation}`)
        report.file_mutations++
      } catch (error) {
        report.unresolved.push(`${journal.transaction_id}: ${safeDiagnosticText(error instanceof Error ? error.message : String(error))}`)
      }
    }
    report.pending = report.unresolved.length
    return report
  })
}

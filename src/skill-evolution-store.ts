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
import { z } from "zod"
import { acquireFilesystemMutex, type FilesystemMutex } from "./filesystem-mutex.ts"
import { atomicWriteFile } from "./store.ts"
import { canonicalJson, sha256Json } from "./persistence.ts"
import { safeDiagnosticText } from "./diagnostics.ts"
import { canonicalDirectory, isContained, isSafeId, isSafeProjectRelativePath, resolveContainedPath } from "./paths.ts"
import { serializedBytes, utf8Bytes } from "./limits.ts"
import {
  SKILL_EVOLUTION_MAX_CONTENT_BYTES,
  SKILL_EVOLUTION_MAX_JSON_BYTES,
  SKILL_EVOLUTION_MAX_REVISIONS,
  HISTORICAL_MAX_CHUNKS_PER_SESSION,
  SkillCandidateIndexSchema,
  SkillCandidateRevisionSchema,
  HistoricalCandidateBindingSchema,
  HistoricalSnapshotReferenceSchema,
  HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES,
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
  type HistoricalCandidateBinding,
  type SkillLedgerRecord,
  type SkillTransactionJournal,
} from "./skill-evolution-schemas.ts"

const STORE_RELATIVE = ".opencode/skill-evolution"
const LEDGER_FILE = "ledger.json"
const CANDIDATE_FILE = "candidates.json"
const MAX_CHILDREN = 1_000
const MAX_EVIDENCE_FILE_BYTES = 32_768
const REVIEW_CLAIMS_FILE = "review-claims.json"
// One confirmed plan can name 32 sessions with 2,000 assistant identities
// each. Keep coordination finite while allowing every accepted plan identity
// to be fenced before any historical model call.
const MAX_REVIEW_CLAIMS = 64_000
const MAX_REVIEW_CLAIMS_BYTES = 128 * 1024 * 1024
const REVIEW_CLAIM_LEASE_MS = 120_000
const REVIEW_CLAIM_RENEW_SAFETY_MS = 5_000
const ACTIVE_HISTORICAL_REVIEW_BLOCK = "temporarily blocked by an active historical review reservation"
const LOST_LIVE_REVIEW_BLOCK = "live review blocked by historical ownership or completed review"
const ReviewClaimSchema = z.object({
  session_id: z.string().min(1).max(256), message_id: z.string().min(1).max(256),
  owner_kind: z.enum(["live", "historical"]), owner_work_id: z.string().min(1).max(256),
  state: z.enum(["active", "completed", "failed"]), fencing_token: z.string().regex(/^[a-f0-9]{64}$/),
  acquired_at: z.iso.datetime({ offset: true }), updated_at: z.iso.datetime({ offset: true }), expires_at: z.iso.datetime({ offset: true }),
}).strict()
type ReviewClaim = z.infer<typeof ReviewClaimSchema>
const ReviewClaimsSchema = z.object({ schema_version: z.literal(1), kind: z.literal("skill_evolution_review_claims"), revision: z.number().int().nonnegative(), claims: z.array(ReviewClaimSchema).max(MAX_REVIEW_CLAIMS), updated_at: z.iso.datetime({ offset: true }) }).strict()

function loadReviewClaims(project: string): z.infer<typeof ReviewClaimsSchema> {
  const path = storePath(project, REVIEW_CLAIMS_FILE)
  if (!existsSync(path)) return { schema_version: 1, kind: "skill_evolution_review_claims", revision: 0, claims: [], updated_at: new Date(0).toISOString() }
  return ReviewClaimsSchema.parse(readBoundedJson(path, MAX_REVIEW_CLAIMS_BYTES))
}

/** Caller holds the project mutation lock. */
function saveReviewClaimsLocked(project: string, value: z.infer<typeof ReviewClaimsSchema>): void {
  const next = ReviewClaimsSchema.parse({ ...value, revision: value.revision + 1, updated_at: nowIso() })
  if (serializedBytes(next) > MAX_REVIEW_CLAIMS_BYTES) throw new Error("review claim coordination exceeds aggregate bound")
  atomicWriteFile(storePath(project, REVIEW_CLAIMS_FILE), `${JSON.stringify(next, null, 2)}\n`, true)
}

function claimActive(claim: ReviewClaim, now = Date.now()): boolean {
  return claim.state === "active" && Date.parse(claim.expires_at) > now
}

function recoverableHistoricalBlock(record: SkillLedgerRecord): boolean {
  return record.status === "failed" &&
    (record.error === ACTIVE_HISTORICAL_REVIEW_BLOCK || record.error === LOST_LIVE_REVIEW_BLOCK)
}

export function liveReviewFencingToken(workId: string): string {
  return createHash("sha256").update(`live\0${workId}`).digest("hex")
}

function upsertLiveClaimLocked(project: string, sessionId: string, messageId: string, workId: string): ReviewClaim | null {
  const claims = loadReviewClaims(project); const now = Date.now()
  const found = claims.claims.find((item) => item.session_id === sessionId && item.message_id === messageId)
  if (found && found.owner_kind === "historical" && claimActive(found, now)) return null
  // An explicit retry of the same live work item may reactivate its completed
  // claim. Completed historical ownership (and ownership by another work
  // identity) remains terminal and cannot be overwritten.
  if (found?.state === "completed" &&
    (found.owner_kind !== "live" || found.owner_work_id !== workId)) return null
  const at = new Date(now).toISOString(); const token = liveReviewFencingToken(workId)
  const next = { session_id: sessionId, message_id: messageId, owner_kind: "live" as const, owner_work_id: workId, state: "active" as const,
    fencing_token: token, acquired_at: found?.acquired_at ?? at, updated_at: at, expires_at: new Date(now + REVIEW_CLAIM_LEASE_MS).toISOString() }
  if (found) Object.assign(found, next); else claims.claims.push(next)
  saveReviewClaimsLocked(project, claims)
  return next
}

export function reserveHistoricalReviewClaims(project: string, planId: string, fencingToken: string, identities: Array<{ session_id: string; message_id: string }>): { reserved: boolean; blocked_by?: string } {
  return withSkillEvolutionLock(project, "historical-review-reserve", () => {
    const claims = loadReviewClaims(project); const ledger = loadSkillLedger(project); const candidates = loadSkillCandidates(project); const now = Date.now()
    const unique = [...new Map(identities.map((item) => [`${item.session_id}\0${item.message_id}`, item])).values()]
    if (unique.length > MAX_REVIEW_CLAIMS) throw new Error("historical review identity coordination exceeds its finite bound")
    const reviewed = new Map<string, ReviewedLiveCandidate>()
    for (const identity of unique) {
      const key = skillLedgerKey(identity.session_id, identity.message_id)
      const ledgerRecord = ledger.records.find((item) => item.key === key && item.session_id === identity.session_id && item.message_id === identity.message_id)
      const candidate = ledgerRecord ? reviewedLiveCandidate(project, candidates, identity.session_id, identity.message_id, ledger) : null
      if (candidate) reviewed.set(key, candidate)
    }
    for (const identity of unique) {
      const claim = claims.claims.find((item) => item.session_id === identity.session_id && item.message_id === identity.message_id)
      const live = ledger.records.find((item) => item.session_id === identity.session_id && item.message_id === identity.message_id)
      // A ledger cursor is not ownership authority by itself. A process may
      // die after persisting pending/running, and an expired fencing claim must
      // be recoverable by one of the intake paths rather than blocking the
      // identity forever.
      if (!reviewed.has(skillLedgerKey(identity.session_id, identity.message_id)) &&
        claim && claim.owner_kind === "live" && claimActive(claim, now) &&
        live && (live.status === "pending" || live.status === "running")) {
        return { reserved: false, blocked_by: skillLedgerKey(identity.session_id, identity.message_id) }
      }
      if (claim && claim.owner_kind === "historical" && claimActive(claim, now) && (claim.owner_work_id !== planId || claim.fencing_token !== fencingToken)) {
        return { reserved: false, blocked_by: claim.owner_work_id }
      }
    }
    const at = new Date(now).toISOString()
    let ledgerChanged = false
    for (const identity of unique) {
      const key = skillLedgerKey(identity.session_id, identity.message_id)
      const found = claims.claims.find((item) => item.session_id === identity.session_id && item.message_id === identity.message_id)
      const staleLive = ledger.records.find((item) => item.session_id === identity.session_id && item.message_id === identity.message_id &&
        (item.status === "pending" || item.status === "running"))
      const reviewedCandidate = reviewed.get(key)
      if (reviewedCandidate) {
        ledgerChanged ||= finalizeReviewedLiveCandidateLocked(ledger, claims, key, reviewedCandidate).ledgerChanged
      } else if (staleLive) {
        staleLive.status = "failed"
        staleLive.error = "expired live review ownership was fenced by historical recovery"
        staleLive.updated_at = at
        ledgerChanged = true
      }
      const next = { ...identity, owner_kind: "historical" as const, owner_work_id: planId, state: "active" as const, fencing_token: fencingToken,
        acquired_at: at, updated_at: at, expires_at: new Date(now + REVIEW_CLAIM_LEASE_MS).toISOString() }
      if (found) Object.assign(found, next); else claims.claims.push(next)
    }
    // Claim publication and stale-live fencing are one lock-protected
    // mutation decision. A live worker that eventually returns is unable to
    // publish because its fencing token no longer matches.
    saveReviewClaimsLocked(project, claims)
    if (ledgerChanged) saveLedger(project, ledger, ledger.revision)
    return { reserved: true }
  })
}

export function validateHistoricalReviewClaims(project: string, planId: string, fencingToken: string, identities: Array<{ session_id: string; message_id: string }>, complete = false, renew = false, minimumValidityMs = 0): void {
  if (!Number.isSafeInteger(minimumValidityMs) || minimumValidityMs < 0) throw new Error("historical review claim renewal bound is invalid")
  if (!complete && !renew) {
    const claims = loadReviewClaims(project); const now = Date.now()
    const unique = [...new Map(identities.map((item) => [`${item.session_id}\0${item.message_id}`, item])).values()]
    for (const identity of unique) {
      const claim = claims.claims.find((item) => item.session_id === identity.session_id && item.message_id === identity.message_id)
      if (!claim || claim.owner_kind !== "historical" || claim.owner_work_id !== planId || claim.fencing_token !== fencingToken || !claimActive(claim, now)) throw new Error("historical review claim ownership was lost")
    }
    return
  }
  withSkillEvolutionLock(project, "historical-review-validate", () => {
    const claims = loadReviewClaims(project); const now = Date.now(); const at = new Date(now).toISOString()
    const unique = [...new Map(identities.map((item) => [`${item.session_id}\0${item.message_id}`, item])).values()]
    const renewalDeadline = now + minimumValidityMs + REVIEW_CLAIM_RENEW_SAFETY_MS
    let changed = complete
    for (const identity of unique) {
      const claim = claims.claims.find((item) => item.session_id === identity.session_id && item.message_id === identity.message_id)
      if (!claim || claim.owner_kind !== "historical" || claim.owner_work_id !== planId || claim.fencing_token !== fencingToken || !claimActive(claim, now)) throw new Error("historical review claim ownership was lost")
      if (complete || Date.parse(claim.expires_at) <= renewalDeadline) {
        claim.state = complete ? "completed" : "active"
        claim.updated_at = at
        claim.expires_at = new Date(now + Math.max(REVIEW_CLAIM_LEASE_MS, minimumValidityMs + REVIEW_CLAIM_RENEW_SAFETY_MS)).toISOString()
        changed = true
      }
    }
    if (changed) saveReviewClaimsLocked(project, claims)
  })
}

export function failHistoricalReviewClaims(project: string, planId: string, fencingToken: string): void {
  withSkillEvolutionLock(project, "historical-review-fail", () => { const claims = loadReviewClaims(project); let changed = false
    for (const claim of claims.claims) if (claim.owner_kind === "historical" && claim.owner_work_id === planId && claim.fencing_token === fencingToken && claim.state === "active") { claim.state = "failed"; claim.updated_at = nowIso(); changed = true }
    if (changed) saveReviewClaimsLocked(project, claims)
  })
}

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
export function readSkillEvolutionDirectBounded(project: string, path: string, maximum: number, label: string): Buffer {
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

const readDirectBounded = readSkillEvolutionDirectBounded

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

/** One project-wide historical executor, shared by every plan and runtime/process. */
export function acquireHistoricalExecutionLease(projectDirectory: string, owner: string): FilesystemMutex {
  const root = ensureStore(projectDirectory)
  return acquireFilesystemMutex(resolveContainedPath(root, "historical-execution.lock"), {
    owner,
    leaseMs: 30_000,
    heartbeatMs: 10_000,
    waitMs: 100,
  })
}

export function skillLedgerKey(sessionId: string, messageId: string): string {
  return createHash("sha256").update(sessionId, "utf8").update("\0").update(messageId, "utf8").digest("hex")
}

export interface EnqueueLedgerResult {
  record: SkillLedgerRecord
  enqueued: boolean
  reason: "new" | "retry" | "duplicate" | "overflow" | "historical"
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
    const claims = loadReviewClaims(projectDirectory)
    const historicalOwner = claims.claims.find((claim) => claim.session_id === sessionId && claim.message_id === messageId &&
      claim.owner_kind === "historical" && claimActive(claim))
    if (historicalOwner) {
      if (existing) return { record: existing, enqueued: false, reason: "historical" }
      if (ledger.records.length >= options.maxLedgerRecords) throw new Error("skill-evolution ledger capacity reached; refusing to discard exactly-once records")
      const created = nowIso()
      const record = SkillLedgerRecordSchemaCompat({ key, session_id: sessionId, message_id: messageId, status: "failed", attempts: 0,
        forced_retries: 0, created_at: created, updated_at: created, error: ACTIVE_HISTORICAL_REVIEW_BLOCK })
      ledger.records.push(record); const saved = saveLedger(projectDirectory, ledger, ledger.revision)
      return { record: saved.records.find((entry) => entry.key === key)!, enqueued: false, reason: "historical" }
    }
    const historicalCovered = isHistoricalAssistantCovered(projectDirectory, sessionId, messageId)
    if (historicalCovered) {
      if (existing) {
        if (existing.status !== "candidate" && existing.status !== "no-change") {
          existing.status = "no-change"
          existing.updated_at = nowIso()
          existing.error = HISTORICAL_COVERAGE_LEDGER_NOTE
          const saved = saveLedger(projectDirectory, ledger, ledger.revision)
          return { record: saved.records.find((entry) => entry.key === key)!, enqueued: false, reason: "historical" }
        }
        return { record: existing, enqueued: false, reason: "historical" }
      }
      if (ledger.records.length >= options.maxLedgerRecords) throw new Error("skill-evolution ledger capacity reached; refusing to discard exactly-once records")
      const created = nowIso()
      const record = SkillLedgerRecordSchemaCompat({ key, session_id: sessionId, message_id: messageId, status: "no-change", attempts: 0,
        forced_retries: 0, created_at: created, updated_at: created, error: HISTORICAL_COVERAGE_LEDGER_NOTE })
      ledger.records.push(record)
      const saved = saveLedger(projectDirectory, ledger, ledger.revision)
      return { record: saved.records.find((entry) => entry.key === key)!, enqueued: false, reason: "historical" }
    }
    if (existing) {
      if (!force && recoverableHistoricalBlock(existing)) {
        const claim = upsertLiveClaimLocked(projectDirectory, sessionId, messageId, key)
        if (!claim) return { record: existing, enqueued: false, reason: "historical" }
        existing.status = "pending"
        existing.updated_at = nowIso()
        delete existing.error
        const saved = saveLedger(projectDirectory, ledger, ledger.revision)
        return { record: saved.records.find((record) => record.key === key)!, enqueued: true, reason: "retry" }
      }
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
      if (!upsertLiveClaimLocked(projectDirectory, sessionId, messageId, key)) {
        existing.status = "failed"
        existing.error = LOST_LIVE_REVIEW_BLOCK
        const saved = saveLedger(projectDirectory, ledger, ledger.revision)
        return { record: saved.records.find((record) => record.key === key)!, enqueued: false, reason: "historical" }
      }
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
    if (persisted.status === "pending") upsertLiveClaimLocked(projectDirectory, sessionId, messageId, key)
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
    const reviewed = reviewedLiveCandidate(projectDirectory, loadSkillCandidates(projectDirectory), record.session_id, record.message_id, ledger)
    if (reviewed) {
      const claims = loadReviewClaims(projectDirectory)
      const finalized = finalizeReviewedLiveCandidateLocked(ledger, claims, key, reviewed)
      if (finalized.claimsChanged) saveReviewClaimsLocked(projectDirectory, claims)
      return saveLedger(projectDirectory, ledger, ledger.revision).records.find((candidate) => candidate.key === key)!
    }
    if (isHistoricalAssistantCovered(projectDirectory, record.session_id, record.message_id)) {
      record.status = "no-change"; record.error = HISTORICAL_COVERAGE_LEDGER_NOTE; record.updated_at = nowIso()
      return saveLedger(projectDirectory, ledger, ledger.revision).records.find((candidate) => candidate.key === key)!
    }
    if (record.attempts >= options.maxAttempts) {
      record.status = "failed"
      record.error = "skill-evolution attempt limit reached"
      const claims = loadReviewClaims(projectDirectory)
      const claim = claims.claims.find((item) => item.owner_kind === "live" && item.owner_work_id === key && item.state === "active")
      if (claim) { claim.state = "failed"; claim.updated_at = nowIso(); saveReviewClaimsLocked(projectDirectory, claims) }
      record.updated_at = nowIso()
      return saveLedger(projectDirectory, ledger, ledger.revision).records.find((candidate) => candidate.key === key)!
    }
    if (!upsertLiveClaimLocked(projectDirectory, record.session_id, record.message_id, key)) {
      record.status = "failed"; record.error = LOST_LIVE_REVIEW_BLOCK
      record.updated_at = nowIso(); const saved = saveLedger(projectDirectory, ledger, ledger.revision)
      return saved.records.find((candidate) => candidate.key === key)!
    }
    record.status = "running"
    record.attempts++
    record.updated_at = nowIso()
    const saved = saveLedger(projectDirectory, ledger, ledger.revision)
    return saved.records.find((candidate) => candidate.key === key)!
  })
}

export function failSkillAudit(projectDirectory: string, key: string, error: unknown): SkillLedgerRecord {
  const diagnostic = safeDiagnosticText(error instanceof Error ? error.message : String(error))
  return withSkillEvolutionLock(projectDirectory, "audit-fail", () => {
    const ledger = loadSkillLedger(projectDirectory); const record = ledger.records.find((candidate) => candidate.key === key)
    if (!record) throw new Error("skill-evolution ledger record not found")
    if (record.status === "candidate" || record.status === "no-change") return record
    const reviewed = reviewedLiveCandidate(projectDirectory, loadSkillCandidates(projectDirectory), record.session_id, record.message_id, ledger)
    if (reviewed) {
      const claims = loadReviewClaims(projectDirectory)
      const finalized = finalizeReviewedLiveCandidateLocked(ledger, claims, key, reviewed)
      if (finalized.claimsChanged) saveReviewClaimsLocked(projectDirectory, claims)
      return saveLedger(projectDirectory, ledger, ledger.revision).records.find((candidate) => candidate.key === key)!
    }
    if (isHistoricalAssistantCovered(projectDirectory, record.session_id, record.message_id)) {
      record.status = "no-change"; record.error = HISTORICAL_COVERAGE_LEDGER_NOTE; record.updated_at = nowIso()
      return saveLedger(projectDirectory, ledger, ledger.revision).records.find((candidate) => candidate.key === key)!
    }
    record.status = "failed"; record.error = diagnostic; record.updated_at = nowIso()
    const claims = loadReviewClaims(projectDirectory); const claim = claims.claims.find((item) => item.owner_kind === "live" && item.owner_work_id === key && item.state === "active")
    if (claim) { claim.state = "failed"; claim.updated_at = nowIso(); saveReviewClaimsLocked(projectDirectory, claims) }
    return saveLedger(projectDirectory, ledger, ledger.revision).records.find((candidate) => candidate.key === key)!
  })
}

export function liveReviewStillOwned(project: string, sessionId: string, messageId: string, workId: string, fencingToken = liveReviewFencingToken(workId)): boolean {
  return withSkillEvolutionLock(project, "live-review-check", () => {
    if (isHistoricalAssistantCovered(project, sessionId, messageId)) return false
    const claims = loadReviewClaims(project); const claim = claims.claims.find((item) => item.session_id === sessionId && item.message_id === messageId)
    // An elapsed lease is recoverable by the same still-running worker when no
    // competing owner replaced it. A historical takeover changes owner/token
    // under the same project lock and therefore remains fenced.
    if (!claim || claim.owner_kind !== "live" || claim.owner_work_id !== workId || claim.fencing_token !== fencingToken || claim.state !== "active") return false
    // Avoid rewriting coordination state at every between-call cancellation
    // check. Renew only in the latter half of the lease; a newly acquired claim
    // therefore covers the bounded get/messages/create/prompt sequence without
    // turning each check into another durable write.
    if (Date.parse(claim.expires_at) <= Date.now() + REVIEW_CLAIM_LEASE_MS / 2) {
      claim.updated_at = nowIso(); claim.expires_at = new Date(Date.now() + REVIEW_CLAIM_LEASE_MS).toISOString(); saveReviewClaimsLocked(project, claims)
    }
    return true
  })
}

export function markLiveSkillLedgerOutcome(project: string, key: string, outcome: Parameters<typeof markSkillLedgerOutcome>[2]): SkillLedgerRecord | null {
  return withSkillEvolutionLock(project, "live-terminal", () => {
    const ledger = loadSkillLedger(project); const record = ledger.records.find((item) => item.key === key)
    if (!record) throw new Error("skill-evolution ledger record not found")
    const claims = loadReviewClaims(project); const claim = claims.claims.find((item) => item.session_id === record.session_id && item.message_id === record.message_id)
    if (isHistoricalAssistantCovered(project, record.session_id, record.message_id) || !claim || claim.owner_kind !== "live" ||
      claim.owner_work_id !== key || claim.fencing_token !== liveReviewFencingToken(key) || claim.state !== "active") return null
    Object.assign(record, outcome); record.updated_at = nowIso(); delete record.error; claim.state = "completed"; claim.updated_at = nowIso()
    saveReviewClaimsLocked(project, claims); return saveLedger(project, ledger, ledger.revision).records.find((item) => item.key === key)!
  })
}

export function recoverPendingSkillAudits(projectDirectory: string, options: SkillEvolutionOptions): SkillLedgerRecord[] {
  return withSkillEvolutionLock(projectDirectory, "startup-recovery", () => {
    const ledger = loadSkillLedger(projectDirectory)
    const candidates = loadSkillCandidates(projectDirectory)
    const claims = loadReviewClaims(projectDirectory)
    let changed = false
    let claimsChanged = false
    // A process can stop after candidates.json is durable but before the live
    // ledger/claim terminal writes. Prove that exact immutable review first,
    // then finish the already-published outcome rather than replaying a model.
    for (const record of ledger.records) {
      if (record.status === "candidate" || record.status === "no-change") continue
      const reviewed = reviewedLiveCandidate(projectDirectory, candidates, record.session_id, record.message_id, ledger)
      if (!reviewed) continue
      const finalized = finalizeReviewedLiveCandidateLocked(ledger, claims, record.key, reviewed)
      changed ||= finalized.ledgerChanged
      claimsChanged ||= finalized.claimsChanged
    }
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
    for (const record of ledger.records) {
      if (!recoverableHistoricalBlock(record)) continue
      if (isHistoricalAssistantCovered(projectDirectory, record.session_id, record.message_id)) {
        record.status = "no-change"
        record.error = HISTORICAL_COVERAGE_LEDGER_NOTE
        record.updated_at = nowIso()
        changed = true
        continue
      }
      if (upsertLiveClaimLocked(projectDirectory, record.session_id, record.message_id, record.key)) {
        record.status = "pending"
        delete record.error
        record.updated_at = nowIso()
        changed = true
      }
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
    if (claimsChanged) saveReviewClaimsLocked(projectDirectory, claims)
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
    if (found) {
      if (found.parent_id !== child.parent_id || found.title !== child.title || found.role !== child.role) {
        throw new Error("skill-evolution audit child identity has a different registered binding")
      }
      return
    }
    if (ledger.audit_children.length >= MAX_CHILDREN) throw new Error("skill-evolution audit child registry capacity reached")
    ledger.audit_children.push({ ...child, registered_at: nowIso() })
    saveLedger(projectDirectory, ledger, ledger.revision)
  })
}

export function isRegisteredSkillAuditChild(projectDirectory: string, sessionId: string): boolean {
  return loadSkillLedger(projectDirectory).audit_children.some((child) => child.session_id === sessionId)
}

function immutablePathFor(project: string, directory: "evidence" | "revisions" | "backups" | "transactions" | "historical-snapshots" | "historical-chunks" | "historical-plans" | "historical-checkpoints", filename: string): string {
  const root = ensureStore(project)
  const dir = resolveContainedPath(root, directory)
  ensureVerifiedDirectory(canonicalDirectory(project), dir)
  return resolveContainedPath(dir, filename)
}

function writeImmutable(project: string, path: string, value: unknown, maximum = SKILL_EVOLUTION_MAX_JSON_BYTES): { sha256: string; byte_size: number } {
  const serialized = canonicalJson(value)
  const bytes = Buffer.from(serialized, "utf8")
  if (bytes.byteLength > maximum) throw new Error(`immutable skill-evolution object exceeds ${maximum} bytes`)
  const expectedHash = createHash("sha256").update(bytes).digest("hex")
  const verifyOccupied = () => {
    const existing = readSkillEvolutionDirectBounded(project, path, bytes.byteLength, "immutable skill-evolution object")
    if (existing.byteLength !== bytes.byteLength || createHash("sha256").update(existing).digest("hex") !== expectedHash || !existing.equals(bytes)) {
      throw new Error("immutable skill-evolution object path is occupied by different bytes")
    }
  }
  if (existsSync(path)) {
    verifyOccupied()
    return { sha256: expectedHash, byte_size: bytes.byteLength }
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
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      verifyOccupied()
      return { sha256: expectedHash, byte_size: bytes.byteLength }
    }
    throw error
  }
  verifyOccupied()
  return { sha256: expectedHash, byte_size: bytes.byteLength }
}

export interface HistoricalImmutableReference { path: string; sha256: string; byte_size: number }

/** Content-addressed, create-only historical object publication. */
export function persistHistoricalImmutable(
  projectDirectory: string,
  kind: "snapshot" | "chunk" | "plan" | "checkpoint",
  value: unknown,
  maximum: number,
): HistoricalImmutableReference {
  if (kind === "snapshot" && maximum > HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES) {
    throw new Error("historical snapshot persistence bound exceeds the dedicated finite cap")
  }
  const project = canonicalDirectory(projectDirectory)
  const serialized = canonicalJson(value)
  const hash = createHash("sha256").update(serialized, "utf8").digest("hex")
  const directory = kind === "snapshot" ? "historical-snapshots" : kind === "chunk" ? "historical-chunks" : kind === "plan" ? "historical-plans" : "historical-checkpoints"
  const path = immutablePathFor(project, directory, `${hash}.json`)
  const integrity = writeImmutable(project, path, value, maximum)
  if (integrity.sha256 !== hash) throw new Error("historical immutable hash mismatch")
  return { path: projectRelative(project, path), ...integrity }
}

/**
 * Create the one execution epoch authority for a confirmed historical plan.
 * Unlike ordinary content-addressed checkpoints, the plan-derived filename
 * makes a second epoch collide with (and be rejected by) the create-only
 * immutable writer instead of giving mutable state a new lifetime to point at.
 */
export function persistHistoricalExecutionEpoch(
  projectDirectory: string,
  planConfirmation: string,
  value: unknown,
): HistoricalImmutableReference {
  if (!/^[a-f0-9]{64}$/.test(planConfirmation)) throw new Error("invalid historical plan confirmation for execution epoch")
  const project = canonicalDirectory(projectDirectory)
  const path = immutablePathFor(project, "historical-checkpoints", `${planConfirmation}-execution-epoch.json`)
  const integrity = writeImmutable(project, path, value, 4_096)
  return { path: projectRelative(project, path), ...integrity }
}

export function loadHistoricalImmutable(
  projectDirectory: string,
  reference: HistoricalImmutableReference,
  kind: "snapshot" | "chunk" | "plan" | "checkpoint",
  maximum: number,
): unknown {
  if (kind === "snapshot") {
    HistoricalSnapshotReferenceSchema.parse(reference)
    maximum = Math.min(maximum, HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES)
  }
  const prefix = `${STORE_RELATIVE}/historical-${kind === "snapshot" ? "snapshots" : kind === "chunk" ? "chunks" : kind === "plan" ? "plans" : "checkpoints"}/`
  if (!reference.path.startsWith(prefix) || !isSafeProjectRelativePath(reference.path) ||
    !/^[a-f0-9]{64}$/.test(reference.sha256) || !Number.isSafeInteger(reference.byte_size) ||
    reference.byte_size <= 0 || reference.byte_size > maximum) throw new Error("invalid historical immutable reference")
  const project = canonicalDirectory(projectDirectory)
  const path = resolveContainedPath(project, ...reference.path.split("/"))
  const bytes = readDirectBounded(project, path, maximum, "historical immutable object")
  if (bytes.byteLength !== reference.byte_size || createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
    throw new Error("historical immutable reference integrity mismatch")
  }
  return JSON.parse(bytes.toString("utf8"))
}

export interface HistoricalMutableIndex {
  schema_version: 1
  kind: "skill_evolution_historical_index"
  revision: number
  plans: unknown[]
  snapshots: HistoricalSnapshotIndexEntry[]
  coverage: HistoricalCoverageEntry[]
  updated_at: string
}

const HISTORICAL_INDEX_FILE = "historical-index.json"
const MAX_HISTORICAL_INDEX_BYTES = 2 * 1024 * 1024
export const MAX_HISTORICAL_SNAPSHOT_STATE_HISTORY = 4_096
export const HISTORICAL_COVERAGE_LEDGER_NOTE = "authoritative assistant identity already covered by completed historical review"
const historicalId = z.string().min(1).max(256).refine((value) => value === value.trim())
const historicalSha = z.string().regex(/^[a-f0-9]{64}$/)
const historicalWorkId = z.string().regex(/^(?:hist-[a-f0-9]{32}|preview-[a-f0-9]{32})$/)
const HistoricalReferenceSchema = z.object({
  path: z.string().min(1).max(1_024), sha256: historicalSha,
  byte_size: z.number().int().positive().max(128 * 1024 * 1024),
}).strict()
export const HistoricalSnapshotDispositionSchema = z.enum([
  "previewed", "queued", "running", "resumable", "cancelled", "failed", "completed",
])
const HistoricalSnapshotIndexEntrySchema = z.object({
  session_id: historicalId,
  commitment: historicalSha,
  snapshot_ref: HistoricalSnapshotReferenceSchema,
  first_known_order: z.number().int().nonnegative().max(16_383),
  predecessor_commitment: historicalSha.optional(),
  assistant_message_ids: z.array(historicalId).max(2_000),
  plan_ids: z.array(historicalWorkId).max(512),
  current_disposition: HistoricalSnapshotDispositionSchema,
  state_history: z.array(z.object({
    disposition: HistoricalSnapshotDispositionSchema,
    plan_id: historicalWorkId,
    at: z.iso.datetime({ offset: true }),
  }).strict()).min(1).max(MAX_HISTORICAL_SNAPSHOT_STATE_HISTORY),
}).strict().superRefine((entry, ctx) => {
  if (new Set(entry.assistant_message_ids).size !== entry.assistant_message_ids.length) {
    ctx.addIssue({ code: "custom", path: ["assistant_message_ids"], message: "assistant message identities must be unique" })
  }
  if (new Set(entry.plan_ids).size !== entry.plan_ids.length) {
    ctx.addIssue({ code: "custom", path: ["plan_ids"], message: "historical plan references must be unique" })
  }
  if (entry.state_history.some((state) => !entry.plan_ids.includes(state.plan_id))) {
    ctx.addIssue({ code: "custom", path: ["state_history"], message: "historical disposition states must reference an indexed plan" })
  }
  if (entry.state_history.at(-1)?.disposition !== entry.current_disposition) {
    ctx.addIssue({ code: "custom", path: ["current_disposition"], message: "current disposition must equal the latest state history" })
  }
})
export type HistoricalSnapshotIndexEntry = z.infer<typeof HistoricalSnapshotIndexEntrySchema>
const HistoricalSnapshotsSchema = z.array(HistoricalSnapshotIndexEntrySchema).max(16_384).superRefine((entries, ctx) => {
  const pairs = new Set<string>()
  entries.forEach((entry, index) => {
    const pair = `${entry.session_id}\0${entry.commitment}`
    if (pairs.has(pair)) ctx.addIssue({ code: "custom", path: [index], message: "historical session commitment entries must be unique" })
    pairs.add(pair)
    if (entry.first_known_order !== index) {
      ctx.addIssue({ code: "custom", path: [index, "first_known_order"], message: "historical snapshot order must be contiguous and immutable" })
    }
    if (entry.predecessor_commitment) {
      const predecessor = [...entries.slice(0, index)].reverse().find((candidate) => candidate.session_id === entry.session_id)
      if (!predecessor || predecessor.commitment !== entry.predecessor_commitment) {
        ctx.addIssue({ code: "custom", path: [index, "predecessor_commitment"], message: "historical predecessor must be the immediately preceding known session commitment" })
      }
    } else if (entries.slice(0, index).some((candidate) => candidate.session_id === entry.session_id)) {
      ctx.addIssue({ code: "custom", path: [index, "predecessor_commitment"], message: "a changed session commitment requires its immediate predecessor" })
    }
  })
})

const HistoricalPlanSessionSchema = z.object({
  session_id: historicalId,
  commitment: historicalSha,
  snapshot_ref: HistoricalSnapshotReferenceSchema,
  chunk_refs: z.array(HistoricalReferenceSchema).max(HISTORICAL_MAX_CHUNKS_PER_SESSION),
  message_count: z.number().int().nonnegative().max(1_000_000),
  part_count: z.number().int().nonnegative().max(10_000_000),
  fragment_count: z.number().int().nonnegative().max(2_048),
  byte_count: z.number().int().nonnegative().max(128 * 1024 * 1024),
  predecessor_commitment: historicalSha.optional(),
  assistant_message_ids: z.array(historicalId).max(2_000),
}).strict().superRefine((entry, ctx) => {
  if (entry.fragment_count !== entry.chunk_refs.length) ctx.addIssue({ code: "custom", path: ["fragment_count"], message: "fragment count must match chunk references" })
  if (new Set(entry.assistant_message_ids).size !== entry.assistant_message_ids.length) ctx.addIssue({ code: "custom", path: ["assistant_message_ids"], message: "assistant message identities must be unique" })
})
const HistoricalCheckpointSchema = z.object({
  stage: z.enum(["chunk", "reduction", "checker", "final"]).optional(),
  key: z.string().max(256).optional(),
  chunk_sha256: historicalSha,
  child_session_id: z.string().max(256),
  issued_at: z.iso.datetime({ offset: true }),
  committed_at: z.iso.datetime({ offset: true }).optional(),
  potentially_replayed: z.boolean().optional(),
  attempts: z.number().int().nonnegative().max(100),
  model_calls: z.number().int().nonnegative().max(1),
  input_bytes: z.number().int().nonnegative().max(128 * 1024 * 1024),
  output_ref: HistoricalReferenceSchema.optional(),
}).strict().superRefine((entry, ctx) => {
  if ((entry.model_calls === 0) !== (entry.input_bytes === 0)) ctx.addIssue({ code: "custom", path: ["input_bytes"], message: "historical child calls and input bytes must advance together" })
})
const HistoricalPlanRecordSchema = z.object({
  plan_id: z.string().regex(/^hist-[a-f0-9]{32}$/),
  plan_ref: HistoricalReferenceSchema,
  confirmation: historicalSha,
  state: z.enum(["previewed", "running", "resumable", "completed", "cancelled"]),
  selected_session_ids: z.array(historicalId).min(1).max(32),
  sessions: z.array(HistoricalPlanSessionSchema).min(1).max(32),
  next_chunk: z.number().int().nonnegative().max(65_536),
  model_calls: z.number().int().nonnegative().max(10_000),
  input_bytes: z.number().int().nonnegative().max(128 * 1024 * 1024),
  execution_epoch_ref: HistoricalReferenceSchema.optional(),
  cancelled: z.boolean(),
  disposition: z.enum(["disabled", "unsupported", "oversized", "unavailable", "unstable", "cross_project", "private_child", "overflow", "confirmation_mismatch", "cancelled", "completed", "discovered", "previewed", "running", "resumable"]),
  checkpoints: z.array(HistoricalCheckpointSchema).max(4_096),
  reduction_ref: HistoricalReferenceSchema.optional(),
  checker_ref: HistoricalReferenceSchema.optional(),
  final_ref: HistoricalReferenceSchema.optional(),
  candidate_id: historicalId.optional(),
  created_at: z.iso.datetime({ offset: true }),
  updated_at: z.iso.datetime({ offset: true }),
}).strict().superRefine((plan, ctx) => {
  if (new Set(plan.selected_session_ids).size !== plan.selected_session_ids.length) ctx.addIssue({ code: "custom", path: ["selected_session_ids"], message: "selected session identities must be unique" })
  if (plan.sessions.length !== plan.selected_session_ids.length || plan.sessions.some((session, index) => session.session_id !== plan.selected_session_ids[index])) {
    ctx.addIssue({ code: "custom", path: ["sessions"], message: "sealed sessions must exactly match selected session order" })
  }
  const total = plan.sessions.reduce((sum, session) => sum + session.chunk_refs.length, 0)
  if (plan.next_chunk > total) ctx.addIssue({ code: "custom", path: ["next_chunk"], message: "next chunk exceeds the sealed plan" })
  if (plan.cancelled !== (plan.state === "cancelled")) ctx.addIssue({ code: "custom", path: ["cancelled"], message: "cancelled flag and state must agree" })
})
const HistoricalPlansSchema = z.array(HistoricalPlanRecordSchema).max(512).superRefine((plans, ctx) => {
  const ids = new Set<string>()
  for (const [index, plan] of plans.entries()) {
    if (ids.has(plan.plan_id)) ctx.addIssue({ code: "custom", path: [index, "plan_id"], message: "historical plan identities must be unique" })
    ids.add(plan.plan_id)
  }
})
const HistoricalCoverageEntrySchema = z.object({
  session_id: historicalId,
  commitment: historicalSha,
  plan_id: z.string().regex(/^hist-[a-f0-9]{32}$/),
  completeness: z.literal("v1_bounded_snapshot"),
  assistant_message_ids: z.array(historicalId).max(2_000),
  completed_at: z.iso.datetime({ offset: true }),
}).strict().superRefine((entry, ctx) => {
  if (new Set(entry.assistant_message_ids).size !== entry.assistant_message_ids.length) {
    ctx.addIssue({ code: "custom", path: ["assistant_message_ids"], message: "covered assistant identities must be unique" })
  }
})
export type HistoricalCoverageEntry = z.infer<typeof HistoricalCoverageEntrySchema>

export function loadHistoricalIndex(projectDirectory: string): HistoricalMutableIndex {
  const path = storePath(projectDirectory, HISTORICAL_INDEX_FILE)
  if (!existsSync(path)) return { schema_version: 1, kind: "skill_evolution_historical_index", revision: 0, plans: [], snapshots: [], coverage: [], updated_at: new Date(0).toISOString() }
  const value = readBoundedJson(path, MAX_HISTORICAL_INDEX_BYTES) as HistoricalMutableIndex
  if (!value || value.schema_version !== 1 || value.kind !== "skill_evolution_historical_index" ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.plans) || value.plans.length > 512 ||
    !Array.isArray(value.snapshots) || value.snapshots.length > 16_384 || !Array.isArray(value.coverage) || value.coverage.length > 16_384 || typeof value.updated_at !== "string") {
    throw new Error("historical index is malformed or exceeds bounds")
  }
  const plans = HistoricalPlansSchema.parse(value.plans)
  const snapshots = HistoricalSnapshotsSchema.parse(value.snapshots)
  const coverage = z.array(HistoricalCoverageEntrySchema).max(16_384).parse(value.coverage)
  return { ...value, plans, snapshots, coverage }
}

export function updateHistoricalIndex(
  projectDirectory: string,
  operation: string,
  mutate: (index: HistoricalMutableIndex) => void,
): HistoricalMutableIndex {
  return withSkillEvolutionLock(projectDirectory, `historical-${operation}`, () => {
    const index = loadHistoricalIndex(projectDirectory)
    const expected = index.revision
    mutate(index)
    if (index.revision !== expected) throw new Error("historical index revision must be changed only by CAS")
    const current = loadHistoricalIndex(projectDirectory)
    if (current.revision !== expected) throw new Error("historical index changed concurrently")
    const next = { ...index, revision: expected + 1, updated_at: nowIso() }
    HistoricalPlansSchema.parse(next.plans)
    HistoricalSnapshotsSchema.parse(next.snapshots)
    z.array(HistoricalCoverageEntrySchema).max(16_384).parse(next.coverage)
    if (serializedBytes(next) > MAX_HISTORICAL_INDEX_BYTES) throw new Error("historical index exceeds aggregate bound")
    atomicWriteFile(storePath(projectDirectory, HISTORICAL_INDEX_FILE), `${JSON.stringify(next, null, 2)}\n`, true)
    return next
  })
}

export function isHistoricalAssistantCovered(projectDirectory: string, sessionId: string, messageId: string): boolean {
  return loadHistoricalIndex(projectDirectory).coverage.some((entry) =>
    entry.session_id === sessionId && entry.assistant_message_ids.includes(messageId))
}

/** Reconciles only retryable work; terminal candidate/no-change outcomes and candidate objects are retained. */
export function reconcileHistoricalCoverage(projectDirectory: string, sessionId: string, assistantMessageIds: string[]): void {
  if (!assistantMessageIds.length) return
  const covered = new Set(assistantMessageIds)
  withSkillEvolutionLock(projectDirectory, "historical-ledger-reconcile", () => {
    const ledger = loadSkillLedger(projectDirectory)
    let changed = false
    for (const record of ledger.records) {
      if (record.session_id !== sessionId || !covered.has(record.message_id) || record.status === "candidate" || record.status === "no-change") continue
      record.status = "no-change"
      record.updated_at = nowIso()
      record.error = HISTORICAL_COVERAGE_LEDGER_NOTE
      changed = true
    }
    if (changed) saveLedger(projectDirectory, ledger, ledger.revision)
  })
}

export function publishHistoricalCoverage(
  projectDirectory: string,
  entry: Omit<HistoricalCoverageEntry, "completed_at"> & { completed_at?: string },
): void {
  const completed = HistoricalCoverageEntrySchema.parse({ ...entry, completed_at: entry.completed_at ?? nowIso() })
  updateHistoricalIndex(projectDirectory, "coverage", (index) => {
    if (!index.coverage.some((value) => value.session_id === completed.session_id && value.commitment === completed.commitment)) {
      index.coverage.push(completed)
    }
  })
  reconcileHistoricalCoverage(projectDirectory, completed.session_id, completed.assistant_message_ids)
}

export function persistSkillEvidence(projectDirectory: string, evidence: SkillEvidence) {
  const project = canonicalDirectory(projectDirectory)
  const parsed = SkillEvidenceSchema.parse(evidence)
  const { evidence_id: evidenceId, ...withoutId } = parsed
  const expectedId = createHash("sha256").update(canonicalJson(withoutId), "utf8").digest("hex")
  if (evidenceId !== expectedId) throw new Error("evidence id does not match canonical evidence bytes")
  const path = immutablePathFor(project, "evidence", `${parsed.evidence_id}.json`)
  const integrity = writeImmutable(project, path, parsed, parsed.truncation.aggregate_byte_limit)
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
  const integrity = writeImmutable(project, path, revision)
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
  if (canonicalJson(loaded.historical_binding ?? null) !== canonicalJson(record.historical_binding ?? null)) {
    throw new Error("candidate revision historical provenance binding mismatch")
  }
  return loaded
}

interface ReviewedLiveCandidate {
  candidate: SkillCandidateRecord
  evidence: SkillEvidence
}

/**
 * Recognize only the deterministic live candidate for this exact assistant
 * identity after proving its immutable evidence, auditor output, and (for a
 * skill) checker verdict/child binding. A merely schema-valid or manually
 * indexed candidate is not authoritative review coverage.
 */
function reviewedLiveCandidate(
  projectDirectory: string,
  index: SkillCandidateIndex,
  sessionId: string,
  messageId: string,
  ledger = loadSkillLedger(projectDirectory),
): ReviewedLiveCandidate | null {
  const key = skillLedgerKey(sessionId, messageId)
  const candidateId = `se-${key.slice(0, 24)}`
  const matchingCandidates = index.candidates.filter((entry) => entry.candidate_id === candidateId)
  if (matchingCandidates.length !== 1) return null
  const candidate = matchingCandidates[0]!
  if (candidate.historical_binding || candidate.provenance.session_id !== sessionId ||
    candidate.provenance.assistant_message_id !== messageId || candidate.evidence_refs.length !== 1) return null
  try {
    const initial = loadCandidateRevision(projectDirectory, candidate, 1)
    const current = loadCandidateRevision(projectDirectory, candidate)
    const evidence = loadEvidenceReference(projectDirectory, candidate.evidence_refs[0]!)
    const output = initial.auditor_output
    const auditorChildren = ledger.audit_children.filter((entry) => entry.session_id === candidate.auditor_child_id &&
      entry.parent_id === sessionId && entry.role === "auditor")
    if (!output || initial.historical_binding || current.state !== candidate.state ||
      auditorChildren.length !== 1 ||
      canonicalJson(output.provenance) !== canonicalJson(candidate.provenance) ||
      canonicalJson(evidence.provenance) !== canonicalJson(candidate.provenance) ||
      output.triggers.some((label) => !evidence.trigger_labels.includes(label)) ||
      initial.created_at !== candidate.created_at || output.decision !== candidate.decision) return null

    const skill = output.decision === "skill_candidate" || output.decision === "skill_revision"
    if (skill) {
      const checker = initial.checker_output
      const passed = checker?.passed === true
      const checkerChildren = ledger.audit_children.filter((entry) => entry.session_id === candidate.checker_child_id &&
        entry.parent_id === sessionId && entry.role === "checker")
      if (candidate.type !== "skill" || candidate.target !== output.skill.target || !candidate.checker_child_id || !checker ||
        checkerChildren.length !== 1 ||
        initial.actor_session_id !== candidate.checker_child_id || initial.state !== (passed ? "validated" : "proposed") ||
        initial.event !== (passed ? "checker_passed" : "checker_failed") ||
        canonicalJson(candidate.checker_findings) !== canonicalJson(checker.findings)) return null
    } else if (output.decision === "memory_candidate") {
      if (candidate.type !== "memory" || candidate.target !== null || candidate.checker_child_id !== null ||
        initial.checker_output || initial.actor_session_id !== sessionId || initial.state !== "proposed" ||
        initial.event !== "proposed" || candidate.checker_findings.length !== 0) return null
    } else return null
    return { candidate, evidence }
  } catch {
    return null
  }
}

export function findReviewedLiveSkillCandidate(projectDirectory: string, sessionId: string, messageId: string): SkillCandidateRecord | null {
  const project = canonicalDirectory(projectDirectory)
  const key = skillLedgerKey(sessionId, messageId)
  const ledger = loadSkillLedger(project)
  if (ledger.records.filter((entry) => entry.key === key && entry.session_id === sessionId && entry.message_id === messageId).length !== 1) return null
  return reviewedLiveCandidate(project, loadSkillCandidates(project), sessionId, messageId, ledger)?.candidate ?? null
}

/** Caller holds the project mutation lock and supplies current mutable records. */
function finalizeReviewedLiveCandidateLocked(
  ledger: SkillEvolutionLedger,
  claims: z.infer<typeof ReviewClaimsSchema>,
  key: string,
  reviewed: ReviewedLiveCandidate,
): { ledgerChanged: boolean; claimsChanged: boolean } {
  const record = ledger.records.find((entry) => entry.key === key)
  if (!record || record.session_id !== reviewed.candidate.provenance.session_id ||
    record.message_id !== reviewed.candidate.provenance.assistant_message_id) {
    throw new Error("review-backed live candidate ledger identity is unavailable")
  }
  const ledgerChanged = record.status !== "candidate" || record.candidate_id !== reviewed.candidate.candidate_id ||
    canonicalJson(record.evidence_ref ?? null) !== canonicalJson(reviewed.candidate.evidence_refs[0]) ||
    record.trigger_score !== reviewed.evidence.trigger_score ||
    canonicalJson(record.trigger_labels ?? null) !== canonicalJson(reviewed.evidence.trigger_labels) || record.error !== undefined
  record.status = "candidate"
  record.candidate_id = reviewed.candidate.candidate_id
  record.evidence_ref = reviewed.candidate.evidence_refs[0]
  record.trigger_score = reviewed.evidence.trigger_score
  record.trigger_labels = reviewed.evidence.trigger_labels
  record.updated_at = nowIso()
  delete record.error

  const claim = claims.claims.find((entry) => entry.session_id === record.session_id && entry.message_id === record.message_id)
  const claimsChanged = Boolean(claim && claim.owner_kind === "live" && claim.owner_work_id === key && claim.state !== "completed")
  if (claim && claim.owner_kind === "live" && claim.owner_work_id === key) {
    claim.state = "completed"
    claim.updated_at = nowIso()
  }
  return { ledgerChanged, claimsChanged }
}

export interface SkillCandidateCreationHooks {
  /** Deterministic crash seam after candidate index durability, before live terminal state. */
  afterCandidatesSave?: (candidate: SkillCandidateRecord) => void
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
  historicalBinding?: HistoricalCandidateBinding,
  liveOutcome?: { session_id: string; message_id: string; trigger_score: number; trigger_labels: SkillLedgerRecord["trigger_labels"] },
  hooks: SkillCandidateCreationHooks = {},
): SkillCandidateRecord {
  return withSkillEvolutionLock(projectDirectory, "candidate-create", () => {
    const project = canonicalDirectory(projectDirectory)
    const index = loadSkillCandidates(project)
    const binding = historicalBinding ? HistoricalCandidateBindingSchema.parse(historicalBinding) : undefined
    if (binding) {
      // Candidate publication and historical cancellation share this project
      // mutation lock. Rechecking the durable plan here makes their ordering
      // atomic: a cancellation committed first suppresses publication, while a
      // cancellation waiting on this lock necessarily occurs afterward.
      const historical = loadHistoricalIndex(project)
      const expectedPlanId = `hist-${binding.plan_confirmation.slice(0, 32)}`
      const plans = historical.plans.filter((plan: any) => plan.plan_id === expectedPlanId && plan.confirmation === binding.plan_confirmation)
      const plan = plans[0] as any
      if (plans.length !== 1 || !plan || plan.cancelled || plan.state !== "running" ||
        canonicalJson(plan.reduction_ref ?? null) !== canonicalJson(binding.reduction_ref) ||
        canonicalJson(plan.checker_ref ?? null) !== canonicalJson(binding.checker_ref)) {
        throw new Error("historical candidate publication suppressed because the confirmed plan is not actively publishable")
      }
    }
    if (liveOutcome) {
      const claims = loadReviewClaims(project)
      const claim = claims.claims.find((item) => item.session_id === liveOutcome.session_id && item.message_id === liveOutcome.message_id)
      const evidence = loadEvidenceReference(project, evidenceRef)
      if (ledgerKey !== skillLedgerKey(liveOutcome.session_id, liveOutcome.message_id) ||
        output.provenance.session_id !== liveOutcome.session_id || output.provenance.assistant_message_id !== liveOutcome.message_id ||
        canonicalJson(evidence.provenance) !== canonicalJson(output.provenance) || evidence.trigger_score !== liveOutcome.trigger_score ||
        canonicalJson(evidence.trigger_labels) !== canonicalJson(liveOutcome.trigger_labels ?? []) ||
        isHistoricalAssistantCovered(project, liveOutcome.session_id, liveOutcome.message_id) || !claim || claim.owner_kind !== "live" ||
        claim.owner_work_id !== ledgerKey || claim.fencing_token !== liveReviewFencingToken(ledgerKey) || claim.state !== "active") {
        throw new Error("live review publication suppressed because ownership was lost")
      }
    }
    const candidateId = binding ? `se-h-${sha256Json(binding).slice(0, 40)}` : `se-${ledgerKey.slice(0, 24)}`
    const existing = index.candidates.find((candidate) => candidate.candidate_id === candidateId)
    if (existing) {
      if (!binding) {
        if (liveOutcome) {
          const ledger = loadSkillLedger(project)
          const reviewed = reviewedLiveCandidate(project, index, liveOutcome.session_id, liveOutcome.message_id, ledger)
          if (!reviewed || reviewed.candidate.candidate_id !== existing.candidate_id) {
            throw new Error("existing live candidate lacks exact durable review provenance")
          }
          const claims = loadReviewClaims(project)
          const finalized = finalizeReviewedLiveCandidateLocked(ledger, claims, ledgerKey, reviewed)
          if (finalized.claimsChanged) saveReviewClaimsLocked(project, claims)
          if (finalized.ledgerChanged) saveLedger(project, ledger, ledger.revision)
        }
        return existing
      }
      const revision = loadCandidateRevision(project, existing, 1)
      const exact = canonicalJson(existing.historical_binding ?? null) === canonicalJson(binding ?? null) &&
        canonicalJson(revision.historical_binding ?? null) === canonicalJson(binding ?? null) &&
        canonicalJson(revision.auditor_output ?? null) === canonicalJson(output) && canonicalJson(revision.checker_output ?? null) === canonicalJson(checker) &&
        canonicalJson(existing.evidence_refs[0] ?? null) === canonicalJson(evidenceRef) && existing.auditor_child_id === auditorChildId &&
        existing.checker_child_id === checkerChildId
      if (!exact) throw new Error("existing historical candidate identity has unequal durable provenance")
      return existing
    }
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
      ...(binding ? { historical_binding: binding } : {}),
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
      ...(binding ? { historical_binding: binding } : {}),
      created_at: createdAt,
      updated_at: createdAt,
      promoted_hash: null,
      promoted_at: null,
      promoted_root: null,
      backup_ref: null,
    })
    index.candidates.push(record)
    const saved = saveCandidates(project, index, index.revision)
    const persisted = saved.candidates.find((candidate) => candidate.candidate_id === candidateId)!
    hooks.afterCandidatesSave?.(persisted)
    if (liveOutcome) {
      const ledger = loadSkillLedger(project)
      const reviewed = reviewedLiveCandidate(project, saved, liveOutcome.session_id, liveOutcome.message_id, ledger)
      if (!reviewed || reviewed.candidate.candidate_id !== candidateId) throw new Error("persisted live candidate lacks exact durable review provenance")
      const claims = loadReviewClaims(project)
      const finalized = finalizeReviewedLiveCandidateLocked(ledger, claims, ledgerKey, reviewed)
      if (finalized.claimsChanged) saveReviewClaimsLocked(project, claims)
      if (finalized.ledgerChanged) saveLedger(project, ledger, ledger.revision)
    }
    return persisted
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
      ...(record.historical_binding ? { historical_binding: record.historical_binding } : {}),
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
  writeImmutable(canonicalDirectory(projectDirectory), path, parsed, 64 * 1024)
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

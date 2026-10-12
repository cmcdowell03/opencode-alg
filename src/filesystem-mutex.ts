import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { randomUUID } from "node:crypto"
import { z } from "zod"

const MIN_LEASE_MS = 100
const MAX_LEASE_MS = 60_000
const DEFAULT_LEASE_MS = 30_000
const MAX_WAIT_MS = 5_000
/** How often a waiter looks again. Waiting is always a timer, never a sleep of the thread. */
const WAIT_STEP_MS = 5
/** How long a holder keeps trying to take the mutation claim to renew or release its own mutex. */
const CLAIM_RETRY_MS = 250
/** Default patience of awaitLock for a short lock held by another process. */
export const LOCK_WAIT_MS = 250

export const FilesystemMutexRecordSchema = z
  .object({
    version: z.literal(1),
    owner: z.string().min(1).max(256),
    token: z.uuid(),
    pid: z.number().int().positive(),
    host: z.string().min(1).max(256),
    resource: z.string().min(1).max(4_096),
    acquired_at: z.iso.datetime({ offset: true }),
    expires_at: z.iso.datetime({ offset: true }),
  })
  .strict()
  .superRefine((record, ctx) => {
    if (Date.parse(record.expires_at) <= Date.parse(record.acquired_at)) {
      ctx.addIssue({ code: "custom", path: ["expires_at"], message: "mutex expiry must follow acquisition" })
    }
  })

export type FilesystemMutexRecord = z.infer<typeof FilesystemMutexRecordSchema>

export class FilesystemMutexError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = "FilesystemMutexError"
  }
}

/** A verified live/unexpired holder may become available within a bounded retry. */
export class FilesystemMutexContentionError extends FilesystemMutexError {
  /** The holder's record, when contention was observed on the mutex itself. */
  readonly observed?: FilesystemMutexRecord
  constructor(message: string, observed?: FilesystemMutexRecord) {
    super(message)
    this.name = "FilesystemMutexContentionError"
    this.observed = observed
  }
}

export interface FilesystemMutex {
  path: string
  token: string
  assertHeld(): void
  renew(): void
  release(): void
}

export interface FilesystemMutexOptions {
  owner: string
  leaseMs?: number
  heartbeatMs?: number
  now?: () => number
  pid?: number
  host?: string
  isPidAlive?: (pid: number) => boolean | null
  /** Deterministic test barrier after renew preparation and before the final CAS read. */
  beforeRenewCommit?: (observed: FilesystemMutexRecord) => void
  /** Deterministic test barrier after release observation and before the final CAS read. */
  beforeReleaseRemove?: (observed: FilesystemMutexRecord) => void
}

export interface FilesystemMutexWaitOptions extends FilesystemMutexOptions {
  /** How long to keep trying while another holder has the mutex (0..5000 ms). */
  waitMs?: number
  /** Deterministic test barrier after observing live contention and before waiting. */
  beforeContentionWait?: (observed: FilesystemMutexRecord) => void
}

let cachedHost: string | undefined
function processHost(): string {
  return cachedHost ??= hostname()
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds) })
}

/** Successful acquisitions by this thread, so a waiter can tell whether a failed attempt held any lock. */
let acquisitions = 0

/**
 * Failures to take the short-lived mutation claim. Whatever their type, they describe a state another
 * writer leaves within microseconds, so a waiter may try again; a caller that does not wait sees the
 * original error unchanged.
 */
const transientClaimFailures = new WeakSet<object>()

function isTransient(error: unknown): boolean {
  return error instanceof FilesystemMutexContentionError ||
    (typeof error === "object" && error !== null && transientClaimFailures.has(error))
}

/** Whether an error, or anything in its cause chain, reports a lock that may be free a moment later. */
export function isLockContention(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 8 && current; depth++) {
    if (isTransient(current)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

function defaultPidAlive(pid: number): boolean | null {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    return null
  }
}

function readVerified(path: string): FilesystemMutexRecord {
  try {
    const record = FilesystemMutexRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")))
    if (record.resource !== path) throw new Error("mutex resource identity mismatch")
    return record
  } catch (error) {
    throw new FilesystemMutexError(`mutex is malformed or unverifiable; failing closed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Identity of a lock file this process just created. Reading a new file back is slow where every first
 * open is scanned, and a save takes several short locks. A path that still names the very file we created
 * still holds our token, because participants only ever create or replace lock files, never rewrite them.
 */
interface CreatedFile { dev: bigint; ino: bigint; size: bigint }

function writeExclusive(path: string, record: FilesystemMutexRecord, durable = true): CreatedFile | null {
  let fd: number | undefined
  try {
    fd = openSync(path, "wx", 0o600)
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    if (durable) fsyncSync(fd)
    let created: CreatedFile | null = null
    try {
      const stats = fstatSync(fd, { bigint: true })
      // Filesystems without stable file ids report zero; those fall back to reading the record.
      if (stats.ino !== 0n) created = { dev: stats.dev, ino: stats.ino, size: stats.size }
    } catch { /* identity is an optimization only */ }
    closeSync(fd)
    fd = undefined
    return created
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    throw error
  }
}

/** Whether path still names the file we created; null when that cannot be told without reading it. */
function stillCreatedFile(path: string, created: CreatedFile | null): boolean | null {
  if (!created) return null
  try {
    const stats = statSync(path, { bigint: true })
    if (stats.ino === 0n) return null
    return stats.dev === created.dev && stats.ino === created.ino && stats.size === created.size
  } catch (error) {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT" ? false : null
  }
}

type MutexDisposition = "held" | "takeover" | "unverifiable"

function mutexDisposition(
  record: FilesystemMutexRecord,
  now: number,
  currentHost: string,
  isPidAlive: (pid: number) => boolean | null,
): MutexDisposition {
  if (Date.parse(record.expires_at) > now) return "held"
  if (record.host !== currentHost) return "unverifiable"
  const alive = isPidAlive(record.pid)
  if (alive === false) return "takeover"
  return alive === true ? "held" : "unverifiable"
}

function canTakeOver(
  record: FilesystemMutexRecord,
  now: number,
  currentHost: string,
  isPidAlive: (pid: number) => boolean | null,
): boolean {
  return mutexDisposition(record, now, currentHost, isPidAlive) === "takeover"
}

function heldOrUnverifiableError(
  disposition: Exclude<MutexDisposition, "takeover">,
  observed?: FilesystemMutexRecord,
): FilesystemMutexError {
  const message = "mutex is held by a live, unexpired, remote, or unverifiable owner"
  return disposition === "held"
    ? new FilesystemMutexContentionError(message, observed)
    : new FilesystemMutexError(message)
}

function acquireTakeoverClaim(
  mutexPath: string,
  currentHost: string,
  isPidAlive: (pid: number) => boolean | null,
): () => void {
  const path = `${mutexPath}.takeover`
  const token = randomUUID()
  const acquired = Date.now()
  const claim = FilesystemMutexRecordSchema.parse({
    version: 1,
    owner: `stale-takeover:${mutexPath}`,
    token,
    pid: process.pid,
    host: currentHost,
    resource: path,
    acquired_at: new Date(acquired).toISOString(),
    expires_at: new Date(acquired + 5_000).toISOString(),
  })
  let created: CreatedFile | null
  while (true) {
    try {
      // This claim is an ephemeral CAS guard. Exclusive creation and token
      // verification serialize mutations; only the durable mutex is fsynced.
      created = writeExclusive(path, claim, false)
      break
    } catch (error) {
      if (!existsSync(path)) throw error
      const observed = readVerified(path)
      const disposition = mutexDisposition(observed, Date.now(), currentHost, isPidAlive)
      if (disposition !== "takeover") {
        const message = "mutex stale-takeover claim is live or unverifiable"
        throw disposition === "held"
          ? new FilesystemMutexContentionError(message)
          : new FilesystemMutexError(message)
      }
      const confirmed = readVerified(path)
      if (confirmed.token !== observed.token || !canTakeOver(confirmed, Date.now(), currentHost, isPidAlive)) {
        throw new FilesystemMutexError("mutex stale-takeover claim changed; failing closed")
      }
      renameSync(path, `${path}.stale-${Date.now()}-${randomUUID().slice(0, 8)}`)
    }
  }
  return () => {
    try {
      if (stillCreatedFile(path, created) ?? readVerified(path).token === token) rmSync(path, { force: true })
    } catch {
      // Never remove a replaced/unverifiable claim.
    }
  }
}

/** One attempt at the mutation claim. A failure is transient by nature and is marked as such. */
function tryMutationClaim(
  mutexPath: string,
  currentHost: string,
  isPidAlive: (pid: number) => boolean | null,
): () => void {
  try {
    return acquireTakeoverClaim(mutexPath, currentHost, isPidAlive)
  } catch (error) {
    if (typeof error === "object" && error !== null) transientClaimFailures.add(error)
    throw error
  }
}

/**
 * Short restart-safe mutex. Expired leases are recoverable only when the same-host
 * owner PID is proven dead. Remote, live, malformed, or unverifiable owners fail closed.
 *
 * This never waits. A mutex held by a live owner is reported at once as
 * FilesystemMutexContentionError, because the only way to wait here would be to sleep the thread and
 * freeze the host. Callers that can wait use acquireFilesystemMutexAsync or awaitLock, which wait on a
 * timer and leave the event loop running.
 */
export function acquireFilesystemMutex(path: string, options: FilesystemMutexOptions): FilesystemMutex {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const heartbeatMs = options.heartbeatMs ?? Math.max(25, Math.floor(leaseMs / 3))
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new FilesystemMutexError(`mutex lease must be ${MIN_LEASE_MS}..${MAX_LEASE_MS} ms`)
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs >= leaseMs) {
    throw new FilesystemMutexError("mutex heartbeat must be at least 10ms and shorter than its lease")
  }
  const now = options.now ?? Date.now
  const pid = options.pid ?? process.pid
  const host = options.host ?? processHost()
  const isPidAlive = options.isPidAlive ?? defaultPidAlive
  const token = randomUUID()
  let record: FilesystemMutexRecord
  let created: CreatedFile | null

  // The mutation claim is needed only when the mutex is absent, stale, or not safely readable.
  // Taking it to look at a verified live mutex could starve the holder's own release.
  if (existsSync(path)) {
    let observed: FilesystemMutexRecord | undefined
    try {
      observed = readVerified(path)
    } catch {
      // Re-check under the mutation claim below. This also handles observing
      // an exclusive create before its record has been completely written.
    }
    if (observed) {
      const disposition = mutexDisposition(observed, now(), host, isPidAlive)
      if (disposition !== "takeover") throw heldOrUnverifiableError(disposition, observed)
      // Serialize the stale takeover under the mutation claim below.
    }
  }

  let releaseClaim: (() => void) | undefined
  try {
    try {
      releaseClaim = tryMutationClaim(path, host, isPidAlive)
    } catch (error) {
      // Another writer may have published the durable mutex while we raced for the claim.
      if (existsSync(path)) {
        throw new FilesystemMutexContentionError("mutex is held by a live, unexpired, remote, or unverifiable owner")
      }
      throw error
    }
    if (existsSync(path)) {
      const observed = readVerified(path)
      const disposition = mutexDisposition(observed, now(), host, isPidAlive)
      if (disposition !== "takeover") throw heldOrUnverifiableError(disposition, observed)
      // All cooperative acquire/renew/release operations hold this same claim.
      // Re-read immediately before mutation to reject outside replacement too.
      const confirmed = readVerified(path)
      if (confirmed.token !== observed.token || !canTakeOver(confirmed, now(), host, isPidAlive)) {
        throw new FilesystemMutexError("mutex changed during stale takeover; failing closed")
      }
      renameSync(path, `${path}.stale-${Date.now()}-${randomUUID().slice(0, 8)}`)
    }
    const acquired = now()
    record = FilesystemMutexRecordSchema.parse({
      version: 1,
      owner: options.owner,
      token,
      pid,
      host,
      resource: path,
      acquired_at: new Date(acquired).toISOString(),
      expires_at: new Date(acquired + leaseMs).toISOString(),
    })
    created = writeExclusive(path, record)
    acquisitions++
  } finally {
    releaseClaim?.()
  }

  let released = false
  let lost = false
  /** The record now at path when it is still ours, otherwise null. Unverifiable content throws. */
  const ownRecord = (): FilesystemMutexRecord | null => {
    const same = stillCreatedFile(path, created)
    if (same !== null) return same ? record : null
    const current = readVerified(path)
    return current.token === token ? current : null
  }
  const renew = () => {
    if (released || lost) throw new FilesystemMutexError("mutex is no longer held")
    const releaseClaim = tryMutationClaim(path, host, isPidAlive)
    const temporary = `${path}.${token}.${randomUUID()}.renew`
    try {
      const current = ownRecord()
      if (!current) {
        lost = true
        throw new FilesystemMutexError("mutex token changed")
      }
      const renewed = FilesystemMutexRecordSchema.parse({
        ...current,
        expires_at: new Date(now() + leaseMs).toISOString(),
      })
      const renewedFile = writeExclusive(temporary, renewed)
      if (options.beforeRenewCommit) {
        options.beforeRenewCommit(structuredClone(current))
        if (readVerified(path).token !== token) {
          lost = true
          throw new FilesystemMutexError("mutex token changed before renew commit")
        }
      }
      renameSync(temporary, path)
      record = renewed
      created = renewedFile
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    } finally {
      releaseClaim()
    }
  }
  // A heartbeat that finds the claim taken for an instant tries again from the event loop; only a
  // changed token, or a claim that stays unavailable, means the mutex is lost.
  const beat = (deadline: number): void => {
    if (released || lost) return
    try {
      renew()
    } catch (error) {
      if (!lost && !released && isTransient(error) && Date.now() < deadline) {
        setTimeout(() => beat(deadline), WAIT_STEP_MS).unref?.()
        return
      }
      lost = true
      clearInterval(heartbeat)
    }
  }
  const heartbeat = setInterval(() => beat(Date.now() + CLAIM_RETRY_MS), heartbeatMs)
  heartbeat.unref?.()

  const remove = (deadline: number): void => {
    let releaseClaim: (() => void) | undefined
    try {
      releaseClaim = tryMutationClaim(path, host, isPidAlive)
    } catch {
      // A writer inspecting this mutex holds the claim for an instant. Finish the release from the
      // event loop; until then the mutex stays held, which is always safe.
      if (Date.now() < deadline) setTimeout(() => remove(deadline), WAIT_STEP_MS)
      return
    }
    try {
      const current = ownRecord()
      if (!current) return
      if (options.beforeReleaseRemove) {
        options.beforeReleaseRemove(structuredClone(current))
        if (readVerified(path).token !== token) return
      }
      rmSync(path, { force: true })
    } catch {
      // Never remove a mutex that cannot be proven to belong to this holder.
    } finally {
      releaseClaim()
    }
  }

  return {
    path,
    token,
    assertHeld() {
      if (released || lost) throw new FilesystemMutexError("mutex is no longer held")
      const current = ownRecord()
      if (!current || Date.parse(current.expires_at) <= now()) {
        lost = true
        throw new FilesystemMutexError("mutex token changed or expired")
      }
    },
    renew,
    release() {
      if (released) return
      released = true
      clearInterval(heartbeat)
      remove(Date.now() + CLAIM_RETRY_MS)
    },
  }
}

function assertWait(waitMs: number): void {
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
    throw new FilesystemMutexError(`mutex wait must be 0..${MAX_WAIT_MS} ms`)
  }
}

/**
 * acquireFilesystemMutex that waits up to waitMs for a live holder to release. The wait is a timer, so
 * the event loop keeps running and the holder may be code in this same process.
 */
export async function acquireFilesystemMutexAsync(
  path: string,
  options: FilesystemMutexWaitOptions,
): Promise<FilesystemMutex> {
  const { waitMs = 0, beforeContentionWait, ...acquire } = options
  assertWait(waitMs)
  const deadline = Date.now() + waitMs
  while (true) {
    try {
      return acquireFilesystemMutex(path, acquire)
    } catch (error) {
      if (!isTransient(error) || Date.now() >= deadline) throw error
      const observed = error instanceof FilesystemMutexContentionError ? error.observed : undefined
      if (observed) beforeContentionWait?.(structuredClone(observed))
      await pause(WAIT_STEP_MS)
    }
  }
}

/**
 * Runs a synchronous operation that takes short locks, and if it reports that a lock is held, runs it
 * again after a timer until it succeeds or waitMs has passed. This is how a lock is waited for without
 * freezing the host.
 *
 * The operation is repeated from the start, so it must be safe to repeat when it fails on a lock: one
 * store transaction, which takes its locks before it changes anything, or a read.
 */
export async function awaitLock<T>(operation: () => T, waitMs = LOCK_WAIT_MS): Promise<T> {
  return waitForLock(operation, waitMs, false)
}

/**
 * awaitLock for an operation made of several locked steps that is not safe to repeat halfway. It is
 * repeated only while the failed attempt had not yet acquired any lock, so nothing it does under a lock
 * can happen twice. Contention at a later step is reported as it is, without waiting.
 */
export async function awaitFirstLock<T>(operation: () => T, waitMs = LOCK_WAIT_MS): Promise<T> {
  return waitForLock(operation, waitMs, true)
}

async function waitForLock<T>(operation: () => T, waitMs: number, onlyBeforeFirstLock: boolean): Promise<T> {
  assertWait(waitMs)
  const deadline = Date.now() + waitMs
  for (let step = WAIT_STEP_MS; ; step = Math.min(step * 2, 40)) {
    const before = acquisitions
    try {
      return operation()
    } catch (error) {
      if (!isLockContention(error) || Date.now() >= deadline) throw error
      if (onlyBeforeFirstLock && acquisitions !== before) throw error
      await pause(step)
    }
  }
}

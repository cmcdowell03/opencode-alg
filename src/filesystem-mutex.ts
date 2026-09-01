import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { hostname } from "node:os"
import { randomUUID } from "node:crypto"
import { z } from "zod"

const MIN_LEASE_MS = 100
const MAX_LEASE_MS = 60_000
const DEFAULT_LEASE_MS = 30_000

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
  constructor(message: string) {
    super(message)
    this.name = "FilesystemMutexContentionError"
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
  waitMs?: number
  now?: () => number
  pid?: number
  host?: string
  isPidAlive?: (pid: number) => boolean | null
  /** Deterministic test barrier after renew preparation and before the final CAS read. */
  beforeRenewCommit?: (observed: FilesystemMutexRecord) => void
  /** Deterministic test barrier after release observation and before the final CAS read. */
  beforeReleaseRemove?: (observed: FilesystemMutexRecord) => void
  /** Deterministic test barrier after observing live contention and before waiting. */
  beforeContentionWait?: (observed: FilesystemMutexRecord) => void
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
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

function writeExclusive(path: string, record: FilesystemMutexRecord, durable = true): void {
  let fd: number | undefined
  try {
    fd = openSync(path, "wx", 0o600)
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8")
    if (durable) fsyncSync(fd)
    closeSync(fd)
    fd = undefined
  } catch (error) {
    if (fd !== undefined) closeSync(fd)
    throw error
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

function heldOrUnverifiableError(disposition: Exclude<MutexDisposition, "takeover">): FilesystemMutexError {
  const message = "mutex is held by a live, unexpired, remote, or unverifiable owner"
  return disposition === "held"
    ? new FilesystemMutexContentionError(message)
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
  while (true) {
    try {
      // This claim is an ephemeral CAS guard. Exclusive creation and token
      // verification serialize mutations; only the durable mutex is fsynced.
      writeExclusive(path, claim, false)
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
      const current = readVerified(path)
      if (current.token !== token) return
      const confirmed = readVerified(path)
      if (confirmed.token === token) rmSync(path, { force: true })
    } catch {
      // Never remove a replaced/unverifiable claim.
    }
  }
}

function acquireMutationClaim(
  mutexPath: string,
  currentHost: string,
  isPidAlive: (pid: number) => boolean | null,
  deadline: number,
  yieldWhenContended?: () => boolean,
): (() => void) | null {
  while (true) {
    try {
      return acquireTakeoverClaim(mutexPath, currentHost, isPidAlive)
    } catch (error) {
      // An acquiring writer may have started waiting before another writer
      // published the durable mutex. Once that happens it no longer needs to
      // compete with the holder's renew/release operation for this claim.
      if (yieldWhenContended?.()) return null
      if (Date.now() >= deadline) throw error
      sleep(5)
    }
  }
}

/**
 * Short restart-safe mutex. Expired leases are recoverable only when the same-host
 * owner PID is proven dead. Remote, live, malformed, or unverifiable owners fail closed.
 */
export function acquireFilesystemMutex(path: string, options: FilesystemMutexOptions): FilesystemMutex {
  const leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
  const heartbeatMs = options.heartbeatMs ?? Math.max(25, Math.floor(leaseMs / 3))
  const waitMs = options.waitMs ?? 0
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_LEASE_MS || leaseMs > MAX_LEASE_MS) {
    throw new FilesystemMutexError(`mutex lease must be ${MIN_LEASE_MS}..${MAX_LEASE_MS} ms`)
  }
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs >= leaseMs) {
    throw new FilesystemMutexError("mutex heartbeat must be at least 10ms and shorter than its lease")
  }
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 5_000) {
    throw new FilesystemMutexError("mutex wait must be 0..5000 ms")
  }
  const now = options.now ?? Date.now
  const pid = options.pid ?? process.pid
  const host = options.host ?? hostname()
  const isPidAlive = options.isPidAlive ?? defaultPidAlive
  const token = randomUUID()
  const deadline = Date.now() + waitMs

  while (true) {
    // A waiter only needs the mutation claim when the mutex is absent, stale,
    // or not safely readable. Polling a verified live mutex while holding the
    // claim can starve the holder's release until its bounded release attempt
    // gives up, leaving an unexpired orphan behind for the rest of the waiters.
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
        if (disposition === "takeover") {
          // Serialize the stale takeover under the mutation claim below.
        } else if (disposition === "held" && Date.now() < deadline) {
          options.beforeContentionWait?.(structuredClone(observed))
          sleep(5)
          continue
        } else {
          throw heldOrUnverifiableError(disposition)
        }
      }
    }

    let releaseClaim: (() => void) | undefined
    try {
      releaseClaim = acquireMutationClaim(
        path,
        host,
        isPidAlive,
        deadline,
        () => existsSync(path),
      ) ?? undefined
      if (!releaseClaim) {
        if (Date.now() < deadline) {
          sleep(5)
          continue
        }
        throw new FilesystemMutexContentionError("mutex is held by a live, unexpired, remote, or unverifiable owner")
      }
      if (existsSync(path)) {
        const observed = readVerified(path)
        const disposition = mutexDisposition(observed, now(), host, isPidAlive)
        if (disposition !== "takeover") {
          if (disposition === "held" && Date.now() < deadline) {
            releaseClaim()
            releaseClaim = undefined
            sleep(5)
            continue
          }
          throw heldOrUnverifiableError(disposition)
        }
        // All cooperative acquire/renew/release operations hold this same claim.
        // Re-read immediately before mutation to reject outside replacement too.
        const confirmed = readVerified(path)
        if (confirmed.token !== observed.token || !canTakeOver(confirmed, now(), host, isPidAlive)) {
          throw new FilesystemMutexError("mutex changed during stale takeover; failing closed")
        }
        renameSync(path, `${path}.stale-${Date.now()}-${randomUUID().slice(0, 8)}`)
      }
      const acquired = now()
      const record = FilesystemMutexRecordSchema.parse({
        version: 1,
        owner: options.owner,
        token,
        pid,
        host,
        resource: path,
        acquired_at: new Date(acquired).toISOString(),
        expires_at: new Date(acquired + leaseMs).toISOString(),
      })
      writeExclusive(path, record)
      break
    } catch (error) {
      if (error instanceof FilesystemMutexError) throw error
      throw error
    } finally {
      releaseClaim?.()
    }
  }

  let released = false
  let lost = false
  const renew = () => {
    if (released || lost) throw new FilesystemMutexError("mutex is no longer held")
    const releaseClaim = acquireMutationClaim(path, host, isPidAlive, Date.now() + 250)
    if (!releaseClaim) throw new FilesystemMutexError("mutex mutation claim was unexpectedly yielded")
    const temporary = `${path}.${token}.${randomUUID()}.renew`
    try {
      const current = readVerified(path)
      if (current.token !== token) {
        lost = true
        throw new FilesystemMutexError("mutex token changed")
      }
      const renewed = FilesystemMutexRecordSchema.parse({
        ...current,
        expires_at: new Date(now() + leaseMs).toISOString(),
      })
      writeExclusive(temporary, renewed)
      options.beforeRenewCommit?.(structuredClone(current))
      const confirmed = readVerified(path)
      if (confirmed.token !== token) {
        lost = true
        throw new FilesystemMutexError("mutex token changed before renew commit")
      }
      renameSync(temporary, path)
    } catch (error) {
      rmSync(temporary, { force: true })
      throw error
    } finally {
      releaseClaim()
    }
  }
  const heartbeat = setInterval(() => {
    try {
      renew()
    } catch {
      lost = true
      clearInterval(heartbeat)
    }
  }, heartbeatMs)
  heartbeat.unref?.()

  return {
    path,
    token,
    assertHeld() {
      if (released || lost) throw new FilesystemMutexError("mutex is no longer held")
      const current = readVerified(path)
      if (current.token !== token || Date.parse(current.expires_at) <= now()) {
        lost = true
        throw new FilesystemMutexError("mutex token changed or expired")
      }
    },
    renew,
    release() {
      if (released) return
      released = true
      clearInterval(heartbeat)
      let releaseClaim: (() => void) | undefined
      try {
        releaseClaim = acquireMutationClaim(path, host, isPidAlive, Date.now() + 250) ?? undefined
        const current = readVerified(path)
        if (current.token !== token) return
        options.beforeReleaseRemove?.(structuredClone(current))
        const confirmed = readVerified(path)
        if (confirmed.token === token) rmSync(path, { force: true })
      } catch {
        // Never remove a mutex that cannot be proven to belong to this holder.
      } finally {
        releaseClaim?.()
      }
    },
  }
}

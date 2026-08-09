import type { RunState } from "./types.ts"
import {
  acquireRunLock,
  findLatestRunForSession,
  loadRunForOwner,
  persistRunFenced,
  type RunLockOptions,
} from "./store.ts"

export class OwnershipError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "OwnershipError"
  }
}

export function assertRunOwner(run: RunState, sessionId: string): void {
  if (run.owner_session_id !== sessionId) {
    throw new OwnershipError(`session does not own run ${run.run_id}`)
  }
}

/** Implicit lookup never falls back to another session's project run. */
export function resolveOwnedRun(
  projectDirectory: string,
  sessionId: string,
  runId?: string,
): RunState | null {
  if (!runId) return findLatestRunForSession(projectDirectory, sessionId)
  const run = loadRunForOwner(projectDirectory, runId, sessionId)
  if (!run) return null
  assertRunOwner(run, sessionId)
  return run
}

/** Serialize an owned mutation with execution, then CAS the freshly loaded revision. */
export function mutateOwnedRun(
  projectDirectory: string,
  runId: string,
  sessionId: string,
  mutate: (fresh: RunState) => void,
  lockOptions?: RunLockOptions,
): RunState {
  const lock = acquireRunLock(projectDirectory, runId, sessionId, lockOptions ?? {})
  try {
    const fresh = loadRunForOwner(projectDirectory, runId, sessionId)
    if (!fresh) throw new OwnershipError(`run ${runId} does not exist`)
    assertRunOwner(fresh, sessionId)
    mutate(fresh)
    return persistRunFenced(fresh, projectDirectory, lock)
  } finally {
    lock.release()
  }
}

export function transferRunOwnership(
  projectDirectory: string,
  runId: string,
  currentSessionId: string,
  newSessionId: string,
  lockOptions?: RunLockOptions,
): RunState {
  const target = newSessionId.trim()
  if (!target || target.length > 256) throw new OwnershipError("new owner session id is invalid")
  if (target === currentSessionId) throw new OwnershipError("new owner is already the current owner")
  return mutateOwnedRun(
    projectDirectory,
    runId,
    currentSessionId,
    (fresh) => {
      fresh.owner_transfers.push({
        from_session_id: currentSessionId,
        to_session_id: target,
        by_session_id: currentSessionId,
        transferred_at: new Date().toISOString(),
      })
      fresh.owner_session_id = target
    },
    lockOptions,
  )
}

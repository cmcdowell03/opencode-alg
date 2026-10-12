import { describe, expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { executeRun } from "../src/executor.ts"
import {
  acquireFilesystemMutex,
  acquireFilesystemMutexAsync,
  awaitFirstLock,
  awaitLock,
  FilesystemMutexContentionError,
  isLockContention,
} from "../src/filesystem-mutex.ts"
import {
  acquireRunLock,
  createRun,
  findLatestIncompleteRunForTurn,
  ownerIndexPath,
  persistRun,
  runDir,
  RunLockedError,
} from "../src/store.ts"
import { parseOwnerRunIndex } from "../src/owner-index.ts"
import type { GraphDef, RunState } from "../src/types.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

const done = { summary: ["done"], files_touched: [], commands_run: [], risks: [], done: true }
const oneNode: GraphDef = { name: "lock-waits", max_global_attempts: 1, max_concurrency: 1, nodes: [{ id: "work", agent: "implementer", depends_on: [] }] }

function planned(project: string, runId: string): RunState {
  return createRun({ goal: "lock waits", criteria: [], graph: oneNode, projectDirectory: project, ownerSessionId: "session-owner", runId, mode: "live" })
}

/** A lock file as another live process on this machine would have written it. */
function heldElsewhere(path: string): void {
  const now = Date.now()
  writeFileSync(path, `${JSON.stringify({ version: 1, owner: "other-process", token: randomUUID(), pid: process.pid, host: hostname(),
    resource: path, acquired_at: new Date(now).toISOString(), expires_at: new Date(now + 30_000).toISOString() }, null, 2)}\n`, "utf8")
}

/** Counts turns of the event loop. A stopped thread cannot tick. */
function ticker() {
  let ticks = 0
  const timer = setInterval(() => { ticks++ }, 5)
  return { get ticks() { return ticks }, stop() { clearInterval(timer) } }
}

describe("locks are never waited for by stopping the thread", () => {
  test("no blocking sleep remains in the plugin or its scripts", () => {
    const offenders: string[] = []
    const scan = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name)
        if (entry.isDirectory()) scan(path)
        else if (entry.name.endsWith(".ts") && /Atomics\s*\.\s*wait\b/.test(readFileSync(path, "utf8"))) offenders.push(path)
      }
    }
    scan(join(import.meta.dir, "..", "src"))
    scan(join(import.meta.dir, "..", "scripts"))
    expect(offenders).toEqual([])
  })

  test("a plain acquisition reports a held lock at once", () => {
    const project = tempProject("alg-wait-plain-")
    try {
      const path = join(project, "resource.lock")
      heldElsewhere(path)
      const started = performance.now()
      expect(() => acquireFilesystemMutex(path, { owner: "second" })).toThrow(FilesystemMutexContentionError)
      expect(performance.now() - started).toBeLessThan(150)
    } finally { removeProject(project) }
  })

  test("an awaited acquisition waits on a timer and takes the lock once this process releases it", async () => {
    const project = tempProject("alg-wait-async-")
    try {
      const path = join(project, "resource.lock")
      const held = acquireFilesystemMutex(path, { owner: "holder" })
      const tick = ticker()
      // Only a running event loop can fire this timer; a sleeping thread would wait out the full limit.
      setTimeout(() => held.release(), 120)
      const started = performance.now()
      const next = await acquireFilesystemMutexAsync(path, { owner: "next", waitMs: 3_000 })
      const waited = performance.now() - started
      tick.stop()
      expect(waited).toBeGreaterThanOrEqual(100)
      expect(waited).toBeLessThan(2_000)
      expect(tick.ticks).toBeGreaterThan(5)
      expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(next.token)
      next.release()
      expect(existsSync(path)).toBe(false)
    } finally { removeProject(project) }
  })

  test("awaitLock gives up after its wait, with the event loop running throughout", async () => {
    const project = tempProject("alg-wait-timeout-")
    try {
      const path = join(project, "resource.lock")
      heldElsewhere(path)
      const tick = ticker()
      const started = performance.now()
      let attempts = 0
      const outcome = await awaitLock(() => { attempts++; return acquireFilesystemMutex(path, { owner: "second" }) }, 200).catch((error) => error)
      const waited = performance.now() - started
      tick.stop()
      expect(outcome).toBeInstanceOf(FilesystemMutexContentionError)
      expect(waited).toBeGreaterThanOrEqual(190)
      expect(attempts).toBeGreaterThan(2)
      expect(tick.ticks).toBeGreaterThan(5)
    } finally { removeProject(project) }
  })

  test("a lock held by another process is waited for without blocking", async () => {
    const project = tempProject("alg-wait-process-")
    try {
      const path = join(project, "resource.lock")
      const mutexUrl = new URL("../src/filesystem-mutex.ts", import.meta.url).href
      const child = Bun.spawn([process.execPath, "-e", [
        `import { acquireFilesystemMutex } from ${JSON.stringify(mutexUrl)};`,
        `const lock = acquireFilesystemMutex(${JSON.stringify(path)}, { owner: "other-process" });`,
        `console.log("held");`,
        `await Bun.sleep(400);`,
        `lock.release();`,
      ].join("\n")], { stdout: "pipe", stderr: "pipe" })
      const reader = child.stdout.getReader()
      let printed = ""
      while (!printed.includes("held")) {
        const chunk = await reader.read()
        if (chunk.done) break
        printed += new TextDecoder().decode(chunk.value)
      }
      expect(printed).toContain("held")
      expect(() => acquireFilesystemMutex(path, { owner: "parent" })).toThrow(FilesystemMutexContentionError)
      const tick = ticker()
      const lock = await awaitLock(() => acquireFilesystemMutex(path, { owner: "parent" }), 5_000)
      tick.stop()
      expect(tick.ticks).toBeGreaterThan(10)
      expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(lock.token)
      lock.release()
      expect({ code: await child.exited, stderr: await new Response(child.stderr).text() }).toEqual({ code: 0, stderr: "" })
    } finally { removeProject(project) }
  }, 30_000)

  test("awaitFirstLock never repeats an operation that already held a lock", async () => {
    const project = tempProject("alg-wait-first-")
    try {
      const first = join(project, "first.lock"), second = join(project, "second.lock")
      heldElsewhere(second)
      const twoSteps = (counter: { runs: number }) => () => {
        counter.runs++
        acquireFilesystemMutex(first, { owner: "step-one" }).release()
        return acquireFilesystemMutex(second, { owner: "step-two" })
      }
      const careful = { runs: 0 }, repeating = { runs: 0 }
      expect(await awaitFirstLock(twoSteps(careful), 200).catch((error) => error)).toBeInstanceOf(FilesystemMutexContentionError)
      expect(careful.runs).toBe(1)
      expect(await awaitLock(twoSteps(repeating), 200).catch((error) => error)).toBeInstanceOf(FilesystemMutexContentionError)
      expect(repeating.runs).toBeGreaterThan(1)

      // Contention on the very first lock is waited for.
      heldElsewhere(first)
      setTimeout(() => { rmSync(first); rmSync(second) }, 60)
      const lock = await awaitFirstLock(twoSteps({ runs: 0 }), 2_000)
      lock.release()
    } finally { removeProject(project) }
  })

  test("a release that meets a busy mutation claim finishes from the event loop", async () => {
    const project = tempProject("alg-wait-release-")
    try {
      const path = join(project, "resource.lock"), claim = `${path}.takeover`
      const lock = acquireFilesystemMutex(path, { owner: "holder" })
      heldElsewhere(claim)
      const started = performance.now()
      lock.release()
      expect(performance.now() - started).toBeLessThan(150)
      // Until the claim is free the mutex simply stays held, which is always safe.
      expect(existsSync(path)).toBe(true)
      expect(() => lock.assertHeld()).toThrow(/no longer held/)
      rmSync(claim)
      await Bun.sleep(80)
      expect(existsSync(path)).toBe(false)
    } finally { removeProject(project) }
  })

  test("a heartbeat that meets a busy mutation claim renews a moment later instead of losing the lock", async () => {
    const project = tempProject("alg-wait-heartbeat-")
    try {
      const path = join(project, "resource.lock"), claim = `${path}.takeover`
      const lock = acquireFilesystemMutex(path, { owner: "holder", leaseMs: 2_000, heartbeatMs: 100 })
      const initial = JSON.parse(readFileSync(path, "utf8")).expires_at
      heldElsewhere(claim)
      await Bun.sleep(160)
      rmSync(claim)
      await Bun.sleep(120)
      lock.assertHeld()
      expect(Date.parse(JSON.parse(readFileSync(path, "utf8")).expires_at)).toBeGreaterThan(Date.parse(initial))
      lock.release()
      expect(existsSync(path)).toBe(false)
    } finally { removeProject(project) }
  })
})

describe("run store operations wait for another process on a timer", () => {
  test("a save that meets a held lock waits, commits, and finishes the run", async () => {
    const project = tempProject("alg-wait-save-")
    try {
      const run = planned(project, "save-waits")
      const mirror = join(runDir(project, run.run_id), "mirror.lock")
      const tick = ticker()
      let lockedAt = 0, releasedAt = 0
      const finished = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          await options.onSessionCreated?.("child")
          // Another process takes this run's mirror lock just before the outcome is saved.
          heldElsewhere(mirror)
          lockedAt = performance.now()
          setTimeout(() => { rmSync(mirror); releasedAt = performance.now() }, 120)
          return { session_id: "child", text: "", parsed: done }
        },
      })
      tick.stop()
      expect(finished.status).toBe("done")
      expect(releasedAt - lockedAt).toBeGreaterThanOrEqual(100)
      expect(tick.ticks).toBeGreaterThan(5)
    } finally { removeProject(project) }
  })

  test("a save whose lock is never released fails as a persistence failure, not a hang", async () => {
    const project = tempProject("alg-wait-save-fail-")
    try {
      const run = planned(project, "save-gives-up")
      const mirror = join(runDir(project, run.run_id), "mirror.lock")
      const started = performance.now()
      const outcome = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          await options.onSessionCreated?.("child")
          heldElsewhere(mirror)
          return { session_id: "child", text: "", parsed: done }
        },
      }).catch((error: Error) => error)
      expect(outcome).toBeInstanceOf(Error)
      expect((outcome as Error).message).toBe("Run persistence boundary failed")
      expect(isLockContention(outcome)).toBe(true)
      expect(performance.now() - started).toBeLessThan(5_000)
      rmSync(mirror)
    } finally { removeProject(project) }
  })

  test("a run lock whose release meets a busy guard is removed from the event loop", async () => {
    const project = tempProject("alg-wait-run-lock-")
    try {
      const run = planned(project, "run-lock-release")
      const lock = acquireRunLock(project, run.run_id, "session-owner")
      const guard = `${lock.path}.guard`
      heldElsewhere(guard)
      const started = performance.now()
      lock.release()
      expect(performance.now() - started).toBeLessThan(150)
      expect(existsSync(lock.path)).toBe(true)

      // Taking it again right now is contention to wait for, not a run that is already executing.
      let refused: unknown
      try { acquireRunLock(project, run.run_id, "session-owner") } catch (error) { refused = error }
      expect(refused).toBeInstanceOf(RunLockedError)
      expect(isLockContention(refused)).toBe(true)

      setTimeout(() => rmSync(guard), 40)
      const again = await awaitLock(() => acquireRunLock(project, run.run_id, "session-owner"), 2_000)
      expect(again.token).not.toBe(lock.token)
      again.release()
      expect(existsSync(lock.path)).toBe(false)
    } finally { removeProject(project) }
  })

  test("a run that really is executing is still refused at once", async () => {
    const project = tempProject("alg-wait-run-busy-")
    try {
      const run = planned(project, "run-lock-busy")
      const lock = acquireRunLock(project, run.run_id, "session-owner")
      const started = performance.now()
      const refused = await awaitLock(() => acquireRunLock(project, run.run_id, "session-owner"), 2_000).catch((error) => error)
      expect(refused).toBeInstanceOf(RunLockedError)
      expect(isLockContention(refused)).toBe(false)
      expect(performance.now() - started).toBeLessThan(500)
      lock.release()
    } finally { removeProject(project) }
  })

  test("the owner projection is refreshed from the event loop when its lock is busy", async () => {
    const project = tempProject("alg-wait-owner-index-")
    try {
      const run = planned(project, "owner-index-deferred")
      const indexPath = ownerIndexPath(project, "session-owner")
      const lockPath = indexPath.replace(/\.json$/, ".lock")
      const read = () => parseOwnerRunIndex(JSON.parse(readFileSync(indexPath, "utf8")), "session-owner").runs[0]!.updated_at
      const before = read()
      heldElsewhere(lockPath)
      run.criteria = ["saved while the projection lock was busy"]
      const started = performance.now()
      persistRun(run, project)
      expect(performance.now() - started).toBeLessThan(1_000)
      // The authoritative save is done; only the projection is still to come.
      expect(run.updated_at).not.toBe(before)
      expect(read()).toBe(before)
      rmSync(lockPath)
      await Bun.sleep(250)
      expect(read()).toBe(run.updated_at)
    } finally { removeProject(project) }
  })

  test("a run whose lock is held for an instant is waited for, not mistaken for no run", async () => {
    const project = tempProject("alg-wait-lookup-")
    try {
      const run = planned(project, "lookup-waits")
      const mirror = join(runDir(project, run.run_id), "mirror.lock")
      const future = () => Date.now() + 60_000
      heldElsewhere(mirror)
      let refused: unknown
      try { findLatestIncompleteRunForTurn(project, "session-owner", { now: future }) } catch (error) { refused = error }
      expect(isLockContention(refused)).toBe(true)
      setTimeout(() => rmSync(mirror), 60)
      const found = await awaitLock(() => findLatestIncompleteRunForTurn(project, "session-owner", { now: future }), 2_000)
      expect(found?.run_id).toBe(run.run_id)
    } finally { removeProject(project) }
  })
})

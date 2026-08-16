import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { getTemplate } from "../src/templates.ts"
import { parseRunState } from "../src/schemas.ts"
import {
  acquireRunLock,
  createRun,
  createRunId,
  linkSession,
  listOwnedRunEnvelopeResults,
  listRuns,
  hydrateRunFully,
  loadRun,
  ownerIndexPath,
  persistRun,
  persistRunFenced,
  runDir,
  MAX_OWNED_RUN_DIRECTORY_SCAN,
} from "../src/store.ts"
import { MAX_OWNER_INDEX_BYTES, parseOwnerRunIndex } from "../src/owner-index.ts"
import { mutateOwnedRun, resolveOwnedRun, transferRunOwnership } from "../src/ownership.ts"
import { executeRun } from "../src/executor.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

describe("safe durable store and ownership", () => {
  test("run ids are collision-resistant and safe", () => {
    const ids = new Set(Array.from({ length: 2_000 }, () => createRunId("Same goal ../../")))
    expect(ids.size).toBe(2_000)
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
  })

  test("atomic persistence creates a usable backup", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "atomic",
        criteria: ["one"],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      run.criteria.push("two")
      persistRun(run, project)
      const progress = join(runDir(project, run.run_id), "progress.json")
      expect(existsSync(`${progress}.bak`)).toBe(true)
      expect(JSON.parse(readFileSync(`${progress}.bak`, "utf8")).criteria).toEqual(["one"])
      expect(loadRun(project, run.run_id)?.criteria).toEqual(["one", "two"])
    } finally {
      removeProject(project)
    }
  })

  test("owner run projections update atomically on create, save, and transfer without becoming authoritative", () => {
    const project = tempProject()
    try {
      const graph = {
        name: "owner-index",
        max_global_attempts: 1,
        max_concurrency: 1,
        nodes: [{ id: "work", agent: "implementer" as const, depends_on: [] }],
      }
      const first = createRun({
        goal: "first indexed run",
        criteria: [],
        graph,
        projectDirectory: project,
        ownerSessionId: "owner-a",
        runId: "indexed-first",
      })
      const second = createRun({
        goal: "second indexed run",
        criteria: [],
        graph,
        projectDirectory: project,
        ownerSessionId: "owner-a",
        runId: "indexed-second",
      })
      const readIndex = (owner: string) => {
        const path = ownerIndexPath(project, owner)
        expect(statSync(path).size).toBeLessThanOrEqual(MAX_OWNER_INDEX_BYTES)
        return parseOwnerRunIndex(JSON.parse(readFileSync(path, "utf8")), owner)
      }
      expect(new Set(readIndex("owner-a").runs.map((entry) => entry.run_id)))
        .toEqual(new Set([first.run_id, second.run_id]))

      first.criteria = ["saved"]
      persistRun(first, project)
      expect(readIndex("owner-a").runs.find((entry) => entry.run_id === first.run_id)?.updated_at)
        .toBe(first.updated_at)

      transferRunOwnership(project, first.run_id, "owner-a", "owner-b")
      expect(readIndex("owner-a").runs.map((entry) => entry.run_id)).toEqual([second.run_id])
      expect(readIndex("owner-b").runs.map((entry) => entry.run_id)).toEqual([first.run_id])
      expect(loadRun(project, first.run_id)?.owner_session_id).toBe("owner-b")
    } finally {
      removeProject(project)
    }
  })

  test("parallel run creators merge the bounded owner projection without lost entries", async () => {
    const project = tempProject()
    try {
      const storeUrl = new URL("../src/store.ts", import.meta.url).href
      const processes = Array.from({ length: 4 }, (_, index) => {
        const script = [
          `import { createRun } from ${JSON.stringify(storeUrl)};`,
          `createRun(${JSON.stringify({
            goal: `parallel ${index}`,
            criteria: [],
            graph: {
              name: "parallel-index",
              max_global_attempts: 1,
              max_concurrency: 1,
              nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
            },
            projectDirectory: project,
            ownerSessionId: "parallel-owner",
            runId: `parallel-${index}`,
          })});`,
        ].join("\n")
        return Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
      })
      const results = await Promise.all(processes.map(async (child) => ({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })))
      expect(results).toEqual(Array.from({ length: 4 }, () => ({ code: 0, stderr: "" })))
      const index = parseOwnerRunIndex(
        JSON.parse(readFileSync(ownerIndexPath(project, "parallel-owner"), "utf8")),
        "parallel-owner",
      )
      expect(new Set(index.runs.map((entry) => entry.run_id)))
        .toEqual(new Set(["parallel-0", "parallel-1", "parallel-2", "parallel-3"]))
    } finally {
      removeProject(project)
    }
  }, 15_000)

  test("an unverifiable projection lock cannot fail authoritative run creation", () => {
    const project = tempProject()
    try {
      const indexPath = ownerIndexPath(project, "projection-blocked-owner")
      mkdirSync(dirname(indexPath), { recursive: true })
      const lockPath = indexPath.replace(/\.json$/, ".lock")
      writeFileSync(lockPath, "{malformed", "utf8")
      const run = createRun({
        goal: "authoritative despite projection failure",
        criteria: [],
        graph: {
          name: "projection-failure",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "projection-blocked-owner",
        runId: "projection-failure-run",
      })
      expect(loadRun(project, run.run_id)?.run_id).toBe(run.run_id)
      expect(existsSync(indexPath)).toBe(false)
      expect(readFileSync(lockPath, "utf8")).toBe("{malformed")
    } finally {
      removeProject(project)
    }
  })

  test("post-commit create hydration failure returns the loadable committed run without cleanup", () => {
    const project = tempProject()
    try {
      let injections = 0
      const run = createRun({
        goal: "committed create survives return hydration failure",
        criteria: [],
        graph: {
          name: "create-hydration-fallback",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "owner",
        runId: "create-hydration-fallback",
        beforePostCommitHydration() {
          injections++
          throw new Error("injected post-commit return hydration failure")
        },
      })
      expect(injections).toBe(1)
      expect(run.revision).toBe(1)
      expect(existsSync(join(runDir(project, run.run_id), "progress.json"))).toBe(true)
      expect(loadRun(project, run.run_id)).toMatchObject({
        run_id: run.run_id,
        revision: 1,
        owner_session_id: "owner",
      })
    } finally {
      removeProject(project)
    }
  })

  test("parallel ownership transfers merge removals from the former owner projection", async () => {
    const project = tempProject()
    try {
      const graph = {
        name: "parallel-transfer-index",
        max_global_attempts: 1,
        max_concurrency: 1,
        nodes: [{ id: "work", agent: "implementer" as const, depends_on: [] }],
      }
      for (const runId of ["transfer-parallel-a", "transfer-parallel-b"]) {
        createRun({
          goal: runId,
          criteria: [],
          graph,
          projectDirectory: project,
          ownerSessionId: "transfer-source",
          runId,
        })
      }
      const ownershipUrl = new URL("../src/ownership.ts", import.meta.url).href
      const children = [
        ["transfer-parallel-a", "transfer-target-a"],
        ["transfer-parallel-b", "transfer-target-b"],
      ].map(([runId, target]) => Bun.spawn([
        process.execPath,
        "-e",
        `import { transferRunOwnership } from ${JSON.stringify(ownershipUrl)}; ` +
          `transferRunOwnership(${JSON.stringify(project)}, ${JSON.stringify(runId)}, "transfer-source", ${JSON.stringify(target)});`,
      ], { stdout: "pipe", stderr: "pipe" }))
      const results = await Promise.all(children.map(async (child) => ({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })))
      expect(results).toEqual(Array.from({ length: 2 }, () => ({ code: 0, stderr: "" })))
      const readRunIds = (owner: string) => parseOwnerRunIndex(
        JSON.parse(readFileSync(ownerIndexPath(project, owner), "utf8")),
        owner,
      ).runs.map((entry) => entry.run_id)
      expect(readRunIds("transfer-source")).toEqual([])
      expect(readRunIds("transfer-target-a")).toEqual(["transfer-parallel-a"])
      expect(readRunIds("transfer-target-b")).toEqual(["transfer-parallel-b"])
    } finally {
      removeProject(project)
    }
  }, 15_000)

  test("exclusive lock rejects overlap and releases for a later executor", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "lock",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const first = acquireRunLock(project, run.run_id, "first", 5_000)
      expect(() => acquireRunLock(project, run.run_id, "second", 5_000)).toThrow(/already executing/)
      first.release()
      const second = acquireRunLock(project, run.run_id, "second", 5_000)
      second.release()
      expect(existsSync(join(runDir(project, run.run_id), "execution.lock"))).toBe(false)
    } finally {
      removeProject(project)
    }
  })

  test("heartbeat renews a short lease and prevents stale takeover", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "renew",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      // Leave enough wall-clock margin for Windows/OneDrive fsync while still
      // waiting beyond the original lease to prove heartbeat renewal.
      const first = acquireRunLock(project, run.run_id, "first", { leaseMs: 3_000, heartbeatMs: 300 })
      await Bun.sleep(4_200)
      first.assertHeld()
      expect(() => acquireRunLock(project, run.run_id, "second", { leaseMs: 3_000, heartbeatMs: 300 })).toThrow(/already executing/)
      first.release()
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("expired-lock takeover cannot rename a lease renewed after observation", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "guarded takeover race",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const now = Date.now()
      const lockPath = join(runDir(project, run.run_id), "execution.lock")
      const expired = {
        version: 1,
        token: randomUUID(),
        holder: "first",
        project_directory: project,
        run_id: run.run_id,
        acquired_at: new Date(now - 2_000).toISOString(),
        expires_at: new Date(now - 1_000).toISOString(),
      }
      let renewedBytes = ""
      writeFileSync(lockPath, `${JSON.stringify(expired, null, 2)}\n`, "utf8")
      expect(() => acquireRunLock(project, run.run_id, "competitor", {
        leaseMs: 1_000,
        heartbeatMs: 100,
        now: () => now,
        beforeExpiredTakeover(observed) {
          const renewed = { ...observed, expires_at: new Date(now + 5_000).toISOString() }
          renewedBytes = `${JSON.stringify(renewed, null, 2)}\n`
          writeFileSync(lockPath, renewedBytes, "utf8")
        },
      })).toThrow(/already executing/)
      expect(readFileSync(lockPath, "utf8")).toBe(renewedBytes)
      expect(readdirSync(runDir(project, run.run_id)).some((name) => name.includes("stale"))).toBe(false)

      const guardPath = join(runDir(project, run.run_id), "execution.lock.guard")
      writeFileSync(guardPath, "{crashed-guard", "utf8")
      expect(() => acquireRunLock(project, run.run_id, "third", 1_000)).toThrow(/mutex is malformed.*failing closed/)
      expect(readFileSync(guardPath, "utf8")).toBe("{crashed-guard")
      expect(readFileSync(lockPath, "utf8")).toBe(renewedBytes)
    } finally {
      removeProject(project)
    }
  })

  test("fenced persistence rejects replacement or expiry in the final current-rename hook without changing recovery", () => {
    for (const failure of ["replacement", "expiry"] as const) {
      const project = tempProject()
      try {
        const run = createRun({
          goal: `fenced boundary ${failure}`,
          criteria: ["initial"],
          graph: getTemplate("research-diamond"),
          projectDirectory: project,
          ownerSessionId: "owner",
          runId: `fenced-boundary-${failure}`,
        })
        const seed = loadRun(project, run.run_id)!
        seed.criteria = ["old-current"]
        persistRun(seed, project)

        let clock = Date.now()
        const lock = acquireRunLock(project, run.run_id, "owner", {
          leaseMs: 1_000,
          heartbeatMs: 900,
          now: () => clock,
        })
        const candidate = loadRun(project, run.run_id)!
        candidate.criteria = ["stale commit must fail"]
        const progress = join(runDir(project, run.run_id), "progress.json")
        const backup = `${progress}.bak`
        const currentBefore = readFileSync(progress)
        const backupBefore = readFileSync(backup)
        let hookRan = false

        expect(() => persistRunFenced(candidate, project, lock, {
          beforeProgressCurrentRename() {
            hookRan = true
            if (failure === "expiry") {
              clock += 2_000
              return
            }
            const current = JSON.parse(readFileSync(lock.path, "utf8"))
            writeFileSync(lock.path, `${JSON.stringify({
              ...current,
              token: randomUUID(),
              holder: "replacement",
              acquired_at: new Date(clock).toISOString(),
              expires_at: new Date(clock + 5_000).toISOString(),
            }, null, 2)}\n`, "utf8")
          },
        }), failure).toThrow(/no longer held/)
        expect(hookRan, failure).toBe(true)
        expect(readFileSync(progress).equals(currentBefore), failure).toBe(true)
        expect(readFileSync(backup).equals(backupBefore), failure).toBe(true)
        expect(loadRun(project, run.run_id), failure).toMatchObject({
          revision: candidate.revision,
          criteria: ["old-current"],
        })
        expect(hydrateRunFully(parseRunState(JSON.parse(backupBefore.toString("utf8")))).criteria, failure)
          .toEqual(["initial"])
        expect(readdirSync(runDir(project, run.run_id)).filter((name) => name.endsWith(".tmp")), failure)
          .toEqual([])
        lock.release()
      } finally {
        removeProject(project)
      }
    }
  })

  test("fenced persistence commits when the final current-rename boundary still holds the lock", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "positive fenced boundary",
        criteria: ["initial"],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
        runId: "positive-fenced-boundary",
      })
      const seed = loadRun(project, run.run_id)!
      seed.criteria = ["old-current"]
      persistRun(seed, project)
      const lock = acquireRunLock(project, run.run_id, "owner", 5_000)
      const candidate = loadRun(project, run.run_id)!
      const priorRevision = candidate.revision
      candidate.criteria = ["held commit"]
      const progress = join(runDir(project, run.run_id), "progress.json")
      const currentBefore = readFileSync(progress)
      let hookRan = false

      const saved = persistRunFenced(candidate, project, lock, {
        beforeProgressCurrentRename() {
          hookRan = true
          expect(JSON.parse(readFileSync(lock.path, "utf8")).token).toBe(lock.token)
        },
      })

      expect(hookRan).toBe(true)
      expect(saved.revision).toBe(priorRevision + 1)
      expect(loadRun(project, run.run_id)).toMatchObject({
        revision: priorRevision + 1,
        criteria: ["held commit"],
      })
      expect(readFileSync(`${progress}.bak`).equals(currentBefore)).toBe(true)
      lock.release()
    } finally {
      removeProject(project)
    }
  })

  test("fenced persistence reports success when expiry or replacement occurs only after commit", () => {
    for (const failure of ["expiry", "replacement"] as const) {
      const project = tempProject()
      try {
        const run = createRun({
          goal: `post-commit lock ${failure}`,
          criteria: ["old"],
          graph: {
            name: `post-commit-${failure}`,
            max_global_attempts: 1,
            max_concurrency: 1,
            nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
          },
          projectDirectory: project,
          ownerSessionId: "owner",
          runId: `post-commit-${failure}`,
        })
        let clock = Date.now()
        const lock = acquireRunLock(project, run.run_id, "owner", {
          leaseMs: 1_000,
          heartbeatMs: 900,
          now: () => clock,
        })
        const candidate = loadRun(project, run.run_id)!
        const priorRevision = candidate.revision
        candidate.criteria = [`committed-${failure}`]
        const saved = persistRunFenced(candidate, project, lock, {
          beforePostCommitGc() {
            if (failure === "expiry") {
              clock += 2_000
              return
            }
            const observed = JSON.parse(readFileSync(lock.path, "utf8"))
            writeFileSync(lock.path, `${JSON.stringify({
              ...observed,
              token: randomUUID(),
              holder: "post-commit-replacement",
              acquired_at: new Date(clock).toISOString(),
              expires_at: new Date(clock + 5_000).toISOString(),
            }, null, 2)}\n`, "utf8")
          },
        })
        expect(saved.revision, failure).toBe(priorRevision + 1)
        expect(loadRun(project, run.run_id), failure).toMatchObject({
          revision: priorRevision + 1,
          criteria: [`committed-${failure}`],
        })
        lock.release()
      } finally {
        removeProject(project)
      }
    }
  })

  test("non-commit fenced callbacks retain their failure-producing postcheck", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "strong ordinary fence",
        criteria: [],
        graph: {
          name: "strong-ordinary-fence",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const lock = acquireRunLock(project, run.run_id, "owner", 5_000)
      expect(() => lock.runFenced(() => {
        const observed = JSON.parse(readFileSync(lock.path, "utf8"))
        writeFileSync(lock.path, `${JSON.stringify({
          ...observed,
          token: randomUUID(),
          holder: "replacement",
        })}\n`, "utf8")
      })).toThrow(/no longer held/)
      lock.release()
    } finally {
      removeProject(project)
    }
  })

  test("owned discovery streams only the scan bound plus one, reports truncation truthfully, closes, and leaks no other-owner content", () => {
    const project = tempProject()
    try {
      const privateRun = createRun({
        goal: "PRIVATE-OTHER-OWNER-CONTENT",
        criteria: [],
        graph: {
          name: "streaming-discovery-root",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "other-owner",
        runId: "private-other-owner-run",
      })
      expect(privateRun.run_id).toBe("private-other-owner-run")

      for (const exceedsBound of [false, true]) {
        let reads = 0
        let closes = 0
        const availableEntries = MAX_OWNED_RUN_DIRECTORY_SCAN + (exceedsBound ? 1 : 0)
        const listing = listOwnedRunEnvelopeResults(project, "owner", {
          openDirectory() {
            return {
              readSync() {
                if (reads >= availableEntries) {
                  reads++
                  return null
                }
                reads++
                if (reads === 1) {
                  return {
                    name: privateRun.run_id,
                    isDirectory: () => true,
                    isSymbolicLink: () => false,
                  }
                }
                return {
                  name: `ignored-${reads}`,
                  isDirectory: () => false,
                  isSymbolicLink: () => false,
                }
              },
              closeSync() { closes++ },
            }
          },
        })
        expect(reads, String(exceedsBound)).toBe(MAX_OWNED_RUN_DIRECTORY_SCAN + 1)
        expect(closes, String(exceedsBound)).toBe(1)
        expect(listing, String(exceedsBound)).toEqual({
          envelopes: [],
          errors: [],
          directories_scanned: 1,
          scan_truncated: exceedsBound,
        })
        expect(JSON.stringify(listing)).not.toContain("PRIVATE-OTHER-OWNER-CONTENT")
        expect(JSON.stringify(listing)).not.toContain(privateRun.run_id)
      }

      let closesAfterFailure = 0
      expect(() => listOwnedRunEnvelopeResults(project, "owner", {
        openDirectory() {
          return {
            readSync(): never { throw new Error("injected enumeration failure") },
            closeSync() { closesAfterFailure++ },
          }
        },
      })).toThrow("injected enumeration failure")
      expect(closesAfterFailure).toBe(1)
    } finally {
      removeProject(project)
    }
  })

  test("owned mutation keeps lease verification and commit inside the takeover guard", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "owned mutation fenced gap",
        criteria: ["old"],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const progress = join(runDir(project, run.run_id), "progress.json")
      const before = readFileSync(progress, "utf8")
      expect(() => mutateOwnedRun(project, run.run_id, "owner", (fresh) => {
        fresh.criteria = ["must not commit"]
      }, {
        leaseMs: 5_000,
        heartbeatMs: 1_000,
        afterFencedPrecheck(observed) {
          writeFileSync(join(runDir(project, run.run_id), "execution.lock"), `${JSON.stringify({
            ...observed,
            token: randomUUID(),
            holder: "takeover",
            acquired_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 5_000).toISOString(),
          }, null, 2)}\n`, "utf8")
        },
      })).toThrow(/no longer held/)
      expect(readFileSync(progress, "utf8")).toBe(before)
      expect(loadRun(project, run.run_id)?.criteria).toEqual(["old"])
    } finally {
      removeProject(project)
    }
  })

  test("malformed and identity-mismatched locks fail closed without takeover", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "strict lock",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const lockPath = join(runDir(project, run.run_id), "execution.lock")
      const malformed = '{"token":"not-enough"}'
      writeFileSync(lockPath, malformed, "utf8")
      expect(() => acquireRunLock(project, run.run_id, "second", 5_000)).toThrow(/malformed or unverifiable/)
      expect(readFileSync(lockPath, "utf8")).toBe(malformed)
      expect(readdirSync(runDir(project, run.run_id)).some((name) => name.includes("stale"))).toBe(false)

      const now = Date.now()
      writeFileSync(lockPath, JSON.stringify({
        version: 1,
        token: randomUUID(),
        holder: "other",
        project_directory: project,
        run_id: "wrong-run",
        acquired_at: new Date(now - 2_000).toISOString(),
        expires_at: new Date(now - 1_000).toISOString(),
      }), "utf8")
      expect(() => acquireRunLock(project, run.run_id, "second", 5_000)).toThrow(/mismatched project\/run identity/)
      expect(readdirSync(runDir(project, run.run_id)).some((name) => name.includes("stale"))).toBe(false)
    } finally {
      removeProject(project)
    }
  })

  test("loaded state cannot select another project root and is quarantined", () => {
    const project = tempProject()
    const other = tempProject()
    try {
      const run = createRun({
        goal: "root",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const progress = join(runDir(project, run.run_id), "progress.json")
      const raw = JSON.parse(readFileSync(progress, "utf8"))
      raw.project_directory = other
      writeFileSync(progress, JSON.stringify(raw), "utf8")
      expect(() => loadRun(project, run.run_id)).toThrow(/corrupt or incompatible/)
      expect(readdirSync(runDir(project, run.run_id)).some((name) => name.startsWith("progress.corrupt-"))).toBe(true)
    } finally {
      removeProject(project)
      removeProject(other)
    }
  })

  test("failed run quarantine rename reports that corrupt progress remains in place", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "honest quarantine",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const progress = join(runDir(project, run.run_id), "progress.json")
      writeFileSync(progress, "{corrupt-progress", "utf8")
      expect(() => loadRun(project, run.run_id, {
        renameCorruptFile() { throw new Error("injected rename denial") },
      })).toThrow(/corrupt file remains in place.*manual action.*injected rename denial/)
      expect(readFileSync(progress, "utf8")).toBe("{corrupt-progress")
      expect(readdirSync(runDir(project, run.run_id)).some((name) => name.startsWith("progress.corrupt-"))).toBe(false)
    } finally {
      removeProject(project)
    }
  })

  test("implicit and explicit access are exact-owner only; transfer is audited", () => {
    const project = tempProject()
    try {
      const alice = createRun({
        goal: "alice",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "alice-session",
      })
      createRun({
        goal: "bob",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "bob-session",
      })
      expect(resolveOwnedRun(project, "nobody")).toBeNull()
      expect(() => resolveOwnedRun(project, "bob-session", alice.run_id)).toThrow(/does not own/)
      transferRunOwnership(project, alice.run_id, "alice-session", "carol-session")
      expect(resolveOwnedRun(project, "alice-session")).toBeNull()
      const transferred = resolveOwnedRun(project, "carol-session", alice.run_id)
      expect(transferred?.owner_transfers).toHaveLength(1)
      expect(transferred?.owner_transfers[0]).toMatchObject({
        from_session_id: "alice-session",
        to_session_id: "carol-session",
        by_session_id: "alice-session",
      })
    } finally {
      removeProject(project)
    }
  })

  test("owner-filtered listRuns preserves another owner's corrupt state and derived metadata", () => {
    const project = tempProject()
    try {
      const alice = createRun({
        goal: "alice listing isolation",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "alice",
      })
      const bob = createRun({
        goal: "bob listing isolation",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "bob",
      })
      const directory = runDir(project, alice.run_id)
      const progress = join(directory, "progress.json")
      const graph = join(directory, "graph.json")
      writeFileSync(progress, "{ALICE-CORRUPT", "utf8")
      writeFileSync(graph, "ALICE-DERIVED-BYTES", "utf8")
      const before = Object.fromEntries([progress, graph].map((path) => [path, {
        bytes: readFileSync(path).toString("base64"),
        mtimeMs: statSync(path).mtimeMs,
      }]))

      expect(listRuns(project, "bob").map((run) => run.run_id)).toEqual([bob.run_id])
      for (const path of [progress, graph]) {
        expect(readFileSync(path).toString("base64")).toBe(before[path]!.bytes)
        expect(statSync(path).mtimeMs).toBe(before[path]!.mtimeMs)
      }
      expect(readdirSync(directory).some((name) => name.startsWith("progress.corrupt-"))).toBe(false)
    } finally {
      removeProject(project)
    }
  })

  test("only a confirmed owner can quarantine envelope-valid corrupt progress", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "owner quarantine",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "alice",
      })
      const directory = runDir(project, run.run_id)
      const progress = join(directory, "progress.json")
      const raw = JSON.parse(readFileSync(progress, "utf8"))
      raw.nodes.explore_a.agent = "implementer"
      const corruptBytes = `${JSON.stringify(raw, null, 2)}\n`
      writeFileSync(progress, corruptBytes, "utf8")

      expect(() => resolveOwnedRun(project, "bob", run.run_id)).toThrow(/does not own/)
      expect(readFileSync(progress, "utf8")).toBe(corruptBytes)
      expect(readdirSync(directory).some((name) => name.startsWith("progress.corrupt-"))).toBe(false)

      expect(() => resolveOwnedRun(project, "alice", run.run_id)).toThrow(/quarantined/)
      expect(existsSync(progress)).toBe(false)
      expect(readdirSync(directory).some((name) => name.startsWith("progress.corrupt-"))).toBe(true)
    } finally {
      removeProject(project)
    }
  })

  test("owned load CAS-reconciles a legacy running attempt from its valid session sidecar", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "legacy child recovery",
        criteria: [],
        graph: {
          name: "legacy-session",
          max_global_attempts: 2,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } }],
        },
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      run.status = "running"
      run.phase = "execute"
      run.global_attempts = 1
      run.nodes.work!.status = "running"
      run.nodes.work!.current_attempt = 1
      run.nodes.work!.attempts = [{
        attempt: 1,
        status: "running",
        started_at: new Date().toISOString(),
        failures: [],
      }]
      persistRun(run, project)
      const beforeRevision = run.revision
      linkSession(run, project, "work", 1, "legacy-child")

      const recovered = resolveOwnedRun(project, "owner", run.run_id)!
      expect(recovered.nodes.work!.attempts[0]!.session_id).toBe("legacy-child")
      expect(recovered.revision).toBe(beforeRevision + 1)
      expect(JSON.parse(readFileSync(join(runDir(project, run.run_id), "progress.json"), "utf8"))
        .nodes.work.attempts[0].session_id).toBe("legacy-child")
    } finally {
      removeProject(project)
    }
  })

  test("CAS rejects stale commits, including stale execution after transfer", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "cas",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "session-owner",
        mode: "dry",
      })
      const staleMutation = loadRun(project, run.run_id)!
      const current = loadRun(project, run.run_id)!
      current.criteria = ["newer"]
      persistRun(current, project)
      staleMutation.criteria = ["stale"]
      expect(() => persistRun(staleMutation, project)).toThrow(/revision conflict/)
      expect(loadRun(project, run.run_id)?.criteria).toEqual(["newer"])

      const staleExecutor = loadRun(project, run.run_id)!
      transferRunOwnership(project, run.run_id, "session-owner", "new-owner")
      await expect(executeRun(staleExecutor, {
        ...executeContext(project),
        dry: true,
      })).rejects.toThrow(/revision conflict/)
      expect(loadRun(project, run.run_id)?.owner_session_id).toBe("new-owner")
    } finally {
      removeProject(project)
    }
  })

  test("transfer uses the execution lock and rechecks ownership inside it", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "locked transfer",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const execution = acquireRunLock(project, run.run_id, "executor", 5_000)
      expect(() => transferRunOwnership(project, run.run_id, "owner", "new-owner")).toThrow(/already executing/)
      execution.release()
      transferRunOwnership(project, run.run_id, "owner", "new-owner")
      expect(() => transferRunOwnership(project, run.run_id, "owner", "third-owner")).toThrow(/does not own/)
    } finally {
      removeProject(project)
    }
  })

  test("derived write failure preserves progress and load reconciles every mirror", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "derived recovery",
        criteria: ["old criterion"],
        graph: getTemplate("coding-diamond"),
        projectDirectory: project,
        ownerSessionId: "session-owner",
        mode: "dry",
      })
      await executeRun(run, { ...executeContext(project), dry: true })
      const authoritative = loadRun(project, run.run_id)!
      const directory = runDir(project, run.run_id)
      const paths = {
        progress: join(directory, "progress.json"),
        graph: join(directory, "graph.json"),
        criteria: join(directory, "criteria.md"),
        artifact: join(directory, "artifacts", "explore.json"),
        check: join(directory, "checks", "check-attempt-1.json"),
      }
      const old: Record<keyof typeof paths, string> = {
        progress: readFileSync(paths.progress, "utf8"),
        graph: readFileSync(paths.graph, "utf8"),
        criteria: readFileSync(paths.criteria, "utf8"),
        artifact: readFileSync(paths.artifact, "utf8"),
        check: readFileSync(paths.check, "utf8"),
      }

      const candidate = loadRun(project, run.run_id)!
      candidate.graph.description = "new graph ahead of progress"
      candidate.criteria = ["new criterion"]
      const exploreOutput = structuredClone(candidate.nodes.explore!.output as any)
      exploreOutput.query = "new artifact ahead of progress"
      candidate.nodes.explore!.output = exploreOutput
      candidate.nodes.explore!.attempts.at(-1)!.output = exploreOutput
      const checkOutput = structuredClone(candidate.nodes.check!.output as any)
      checkOutput.notes = "new check ahead of progress"
      candidate.nodes.check!.output = checkOutput
      candidate.nodes.check!.attempts.at(-1)!.output = checkOutput

      expect(() => persistRun(candidate, project, {
        beforeDerivedWrite(path) {
          if (path.endsWith("check-attempt-1.json")) throw new Error("injected derived failure")
        },
      })).toThrow("injected derived failure")
      expect(readFileSync(paths.progress, "utf8")).toBe(old.progress)

      const staleArtifact = join(directory, "artifacts", "stale.json")
      writeFileSync(staleArtifact, '{"stale":true}', "utf8")
      const recovered = loadRun(project, run.run_id)!
      expect(recovered.revision).toBe(authoritative.revision)
      expect(readFileSync(paths.graph, "utf8")).toBe(old.graph)
      expect(readFileSync(paths.criteria, "utf8")).toBe(old.criteria)
      expect(readFileSync(paths.artifact, "utf8")).toBe(old.artifact)
      expect(readFileSync(paths.check, "utf8")).toBe(old.check)
      expect(existsSync(staleArtifact)).toBe(true)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("stale loader re-reads authoritative revision under the mirror lock", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "mirror race",
        criteria: ["old"],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const newer = loadRun(project, run.run_id)!
      newer.criteria = ["new authoritative criterion"]
      const loaded = loadRun(project, run.run_id, {
        afterInitialRead(initial) {
          expect(initial.revision).toBe(run.revision)
          persistRun(newer, project)
        },
      })!
      expect(loaded.revision).toBe(newer.revision)
      expect(loaded.criteria).toEqual(["new authoritative criterion"])
      expect(readFileSync(join(runDir(project, run.run_id), "criteria.md"), "utf8"))
        .toContain("new authoritative criterion")
    } finally {
      removeProject(project)
    }
  })
})

import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join, relative, isAbsolute } from "node:path"
import { randomUUID } from "node:crypto"
import { executeRun } from "../src/executor.ts"
import {
  createRun,
  findLatestIncompleteRunForSession,
  findLatestIncompleteRunForTurn,
  listOwnedRunEnvelopes,
  loadRun,
  ownerIndexPath,
  persistRun,
} from "../src/store.ts"
import { parseOwnerRunIndex } from "../src/owner-index.ts"
import { acquireFilesystemMutex, FilesystemMutexContentionError } from "../src/filesystem-mutex.ts"
import { isContained, resolveContainedPath, scopeMemo, scopedValue, withContainmentScope } from "../src/paths.ts"
import { isAlgWorkerSession, runNodeSession } from "../src/sessions.ts"
import type { GraphDef, RunState } from "../src/types.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

const done = { summary: ["done"], files_touched: [], commands_run: [], risks: [], done: true }

function graph(nodes: GraphDef["nodes"], attempts = nodes.length): GraphDef {
  return { name: "save-path", nodes, max_global_attempts: attempts, max_concurrency: 8 }
}

function planned(project: string, definition: GraphDef, runId: string, owner = "session-owner"): RunState {
  return createRun({ goal: "save path", criteria: [], graph: definition, projectDirectory: project, ownerSessionId: owner, runId, mode: "live" })
}

function gate() {
  let open!: () => void
  const opened = new Promise<void>((resolve) => { open = resolve })
  return { open, opened }
}

describe("executor saves", () => {
  test("a finished node is durable and reported while its batch sibling is still running", async () => {
    const project = tempProject("alg-save-node-")
    try {
      const run = planned(project, graph([
        { id: "fast", agent: "implementer", depends_on: [] },
        { id: "slow", agent: "implementer", depends_on: [] },
      ]), "node-save")
      const release = gate(), fastSaved = gate()
      const reported: Array<Record<string, string>> = []
      const execution = executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          const node = options.title.split("/")[1]!
          await options.onSessionCreated?.(`child-${node}`)
          if (node === "slow") await release.opened
          return { session_id: `child-${node}`, text: "", parsed: done }
        },
        onProgress: (saved) => {
          reported.push(Object.fromEntries(Object.values(saved.nodes).map((node) => [node.id, node.status])))
          if (saved.nodes.fast!.status === "done" && saved.nodes.slow!.status === "running") fastSaved.open()
        },
      })
      await Promise.race([fastSaved.opened, Bun.sleep(5_000).then(() => { throw new Error("the finished node was not saved before its sibling") })])
      const onDisk = loadRun(project, run.run_id)!
      expect(onDisk.nodes.fast).toMatchObject({ status: "done", output: done })
      expect(onDisk.nodes.slow!.status).toBe("running")
      release.open()
      expect((await execution).status).toBe("done")
      expect(reported.at(-1)).toEqual({ fast: "done", slow: "done" })
    } finally { removeProject(project) }
  })

  test("a one-node run commits five times and never re-saves an unchanged run", async () => {
    const project = tempProject("alg-save-budget-")
    try {
      const run = planned(project, graph([{ id: "work", agent: "implementer", depends_on: [] }]), "save-budget")
      const before = run.revision
      const revisions: number[] = []
      const finished = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          await options.onSessionCreated?.("child-work")
          return { session_id: "child-work", text: "", parsed: done }
        },
        onProgress: (saved) => revisions.push(saved.revision),
      })
      // Running, reserved attempt, child linked, outcome, final status.
      expect(revisions).toEqual([1, 2, 3, 4, 5].map((step) => before + step))
      expect(finished.revision).toBe(before + 5)
      expect(loadRun(project, run.run_id)).toMatchObject({ status: "done", revision: before + 5 })
    } finally { removeProject(project) }
  })

  test("a failed attempt that will be retried is committed once, already rescheduled", async () => {
    const project = tempProject("alg-save-retry-")
    try {
      const run = planned(project, graph([
        { id: "work", agent: "implementer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } },
      ], 2), "save-retry")
      const before = run.revision
      const seen: string[] = []
      let calls = 0
      const finished = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          const child = `child-${++calls}`
          await options.onSessionCreated?.(child)
          return calls === 1
            ? { session_id: child, text: "not json", parsed: null }
            : { session_id: child, text: "", parsed: done }
        },
        onProgress: (saved) => {
          const node = saved.nodes.work!
          seen.push(`${node.status}:${node.attempts.map((attempt) => attempt.status).join(",")}`)
        },
      })
      expect(finished).toMatchObject({ status: "done", nodes: { work: { status: "done", current_attempt: 2 } } })
      // The node is never committed as failed between its two attempts.
      expect(seen).not.toContain("failed:failed")
      expect(seen).toContain("pending:failed")
      // Running + (reserve, link, outcome) per attempt + final status.
      expect(finished.revision).toBe(before + 8)
    } finally { removeProject(project) }
  })

  test("a running run rewrites its owner projection only on a status change or after another writer", async () => {
    const project = tempProject("alg-save-owner-index-")
    try {
      const run = planned(project, graph([
        { id: "first", agent: "implementer", depends_on: [] },
        { id: "second", agent: "implementer", depends_on: ["first"] },
      ]), "owner-projection")
      const indexPath = ownerIndexPath(project, "session-owner")
      const files: string[] = []
      let saves = 0
      const finished = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          const node = options.title.split("/")[1]!
          await options.onSessionCreated?.(`child-${node}`)
          return { session_id: `child-${node}`, text: "", parsed: done }
        },
        onProgress: () => {
          saves++
          files.push(String(statSync(indexPath, { bigint: true }).ino))
          // Another writer replaces the projection after the fifth save; the sixth must restore ours.
          if (saves === 5) {
            const content = readFileSync(indexPath, "utf8")
            rmSync(indexPath)
            writeFileSync(indexPath, content, "utf8")
          }
        },
      })
      expect(finished.status).toBe("done")
      expect(saves).toBe(8)
      // One file from the save that set "running", kept through save five; one rewritten after the other
      // writer; one from the final status change.
      expect(new Set(files.slice(0, 5)).size).toBe(1)
      expect(files[5]).not.toBe(files[4])
      expect(files[6]).toBe(files[5])
      expect(files[7]).not.toBe(files[6])
      const index = parseOwnerRunIndex(JSON.parse(readFileSync(indexPath, "utf8")), "session-owner")
      expect(index.runs).toEqual([{ run_id: run.run_id, updated_at: finished.updated_at }])
    } finally { removeProject(project) }
  })

  test("a direct save still mirrors every change into the owner projection", () => {
    const project = tempProject("alg-save-direct-index-")
    try {
      const run = planned(project, graph([{ id: "work", agent: "implementer", depends_on: [] }]), "direct-projection")
      const read = () => parseOwnerRunIndex(JSON.parse(readFileSync(ownerIndexPath(project, "session-owner"), "utf8")), "session-owner")
      for (const criterion of ["one", "two", "three"]) {
        run.criteria = [criterion]
        persistRun(run, project)
        expect(read().runs).toEqual([{ run_id: run.run_id, updated_at: run.updated_at }])
      }
    } finally { removeProject(project) }
  })
})

describe("per-turn incomplete-run lookup", () => {
  const future = () => Date.now() + 60_000
  const counting = () => {
    const calls = { count: 0 }
    const scan: typeof listOwnedRunEnvelopes = (project, session) => { calls.count++; return listOwnedRunEnvelopes(project, session) }
    return { calls, scan }
  }

  test("scans once, then answers from two stat calls until something changes", async () => {
    const project = tempProject("alg-turn-cache-")
    try {
      for (let index = 0; index < 5; index++) planned(project, graph([{ id: "work", agent: "implementer", depends_on: [] }]), `other-${index}`, `other-owner-${index}`)
      const { calls, scan } = counting()
      for (let turn = 0; turn < 10; turn++) {
        expect(findLatestIncompleteRunForTurn(project, "quiet-session", { scan, now: future })).toBeNull()
      }
      expect(calls.count).toBe(1)

      // A new run for this session is found immediately, and it is loaded fresh on every call.
      const mine = planned(project, graph([{ id: "work", agent: "implementer", depends_on: [] }]), "mine", "quiet-session")
      expect(findLatestIncompleteRunForTurn(project, "quiet-session", { scan, now: future })?.run_id).toBe("mine")
      expect(calls.count).toBe(2)
      mine.criteria = ["changed without a status change"]
      persistRun(mine, project)
      expect(findLatestIncompleteRunForTurn(project, "quiet-session", { scan, now: future })?.criteria).toEqual(["changed without a status change"])

      // Finishing it removes it, and the answer matches the uncached lookup throughout.
      const finished = await executeRun(mine, { ...executeContext(project), parentSessionId: "quiet-session", dry: true })
      expect(finished.status).toBe("done")
      expect(findLatestIncompleteRunForTurn(project, "quiet-session", { scan, now: future })).toBeNull()
      expect(findLatestIncompleteRunForSession(project, "quiet-session")).toBeNull()
    } finally { removeProject(project) }
  })

  test("notices a run created or finished by another process", async () => {
    const project = tempProject("alg-turn-cache-foreign-")
    try {
      const { calls, scan } = counting()
      expect(findLatestIncompleteRunForTurn(project, "shared-session", { scan, now: future })).toBeNull()
      expect(findLatestIncompleteRunForTurn(project, "shared-session", { scan, now: future })).toBeNull()
      expect(calls.count).toBe(1)

      const storeUrl = new URL("../src/store.ts", import.meta.url).href
      const executorUrl = new URL("../src/executor.ts", import.meta.url).href
      const other = async (script: string) => {
        const child = Bun.spawn([process.execPath, "-e", `import { createRun, loadRun } from ${JSON.stringify(storeUrl)};\nimport { executeRun } from ${JSON.stringify(executorUrl)};\n${script}`], { stdout: "pipe", stderr: "pipe" })
        expect({ code: await child.exited, stderr: await new Response(child.stderr).text() }).toEqual({ code: 0, stderr: "" })
      }
      await other(`createRun(${JSON.stringify({ goal: "foreign", criteria: [], graph: graph([{ id: "work", agent: "implementer", depends_on: [] }]), projectDirectory: project, ownerSessionId: "shared-session", runId: "foreign-run", mode: "live" })});`)
      expect(findLatestIncompleteRunForTurn(project, "shared-session", { scan, now: future })?.run_id).toBe("foreign-run")

      await other(`const run = loadRun(${JSON.stringify(project)}, "foreign-run");\n` +
        `const done = await executeRun(run, { client: {}, parentSessionId: "shared-session", directory: ${JSON.stringify(project)}, worktree: ${JSON.stringify(project)}, dry: true, toolContext: { ask: async () => {}, abort: new AbortController().signal } });\n` +
        `if (done.status !== "done") throw new Error("foreign run did not finish");`)
      expect(findLatestIncompleteRunForTurn(project, "shared-session", { scan, now: future })).toBeNull()
    } finally { removeProject(project) }
  }, 30_000)

  test("does not trust a just-modified directory, and rescans after the maximum age", () => {
    const project = tempProject("alg-turn-cache-age-")
    try {
      planned(project, graph([{ id: "work", agent: "implementer", depends_on: [] }]), "elsewhere", "someone-else")
      const { calls, scan } = counting()
      // The runs directory was modified moments ago: its timestamp cannot yet vouch for a later change.
      findLatestIncompleteRunForTurn(project, "aging-session", { scan })
      findLatestIncompleteRunForTurn(project, "aging-session", { scan })
      expect(calls.count).toBe(2)
      findLatestIncompleteRunForTurn(project, "aging-session", { scan, now: future })
      findLatestIncompleteRunForTurn(project, "aging-session", { scan, now: future })
      expect(calls.count).toBe(3)
      findLatestIncompleteRunForTurn(project, "aging-session", { scan, now: () => future() + 6 * 60_000 })
      expect(calls.count).toBe(4)
    } finally { removeProject(project) }
  })

  test("a worker session this process created is answered without any scan", async () => {
    const project = tempProject("alg-turn-cache-worker-")
    try {
      planned(project, graph([{ id: "work", agent: "implementer", depends_on: [] }]), "parent-run", "parent")
      await runNodeSession({
        client: { session: {
          create: async () => ({ data: { id: "worker-child" }, error: undefined }),
          prompt: async () => ({ data: { parts: [{ type: "text", text: JSON.stringify(done) }] }, error: undefined }),
        } } as never,
        parentSessionId: "parent", agent: "implementer", title: "parent-run/work/a1", userPrompt: "work", directory: project,
      })
      expect(isAlgWorkerSession("worker-child")).toBe(true)
      expect(isAlgWorkerSession("parent")).toBe(false)
      const { calls, scan } = counting()
      expect(findLatestIncompleteRunForTurn(project, "worker-child", { scan, sessionCreatedHere: isAlgWorkerSession("worker-child") })).toBeNull()
      expect(calls.count).toBe(0)
      // A session that does own a run is never short-circuited.
      expect(findLatestIncompleteRunForTurn(project, "parent", { scan, sessionCreatedHere: true })?.run_id).toBe("parent-run")
    } finally { removeProject(project) }
  })
})

describe("containment scope", () => {
  test("isContained answers exactly as path.relative does", () => {
    const reference = (root: string, candidate: string) => {
      const rel = relative(root, candidate)
      return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
    }
    const windows = process.platform === "win32"
    const roots = windows
      ? ["C:\\work\\project", "C:\\work\\project\\", "C:\\", "C:", "c:\\WORK\\project", "\\\\server\\share\\dir", "\\work", "", ".", "relative\\dir"]
      : ["/work/project", "/work/project/", "/", "", ".", "relative/dir"]
    const tails = windows
      ? ["", "\\a", "\\a\\b.json", "\\..", "\\..\\project2", "2", "\\a..b", "\\a\\..\\..\\x", "\\.", "\\a\\", "/a", "\\..hidden", "\\x\\..\\y"]
      : ["", "/a", "/a/b.json", "/..", "/../project2", "2", "/a..b", "/a/../../x", "/.", "/a/", "/..hidden", "/x/../y"]
    const others = windows ? ["D:\\work\\project\\a", "C:\\work", "C:\\work\\projectile\\a", "a", "..\\a"] : ["/work", "/work/projectile/a", "a", "../a"]
    let compared = 0
    for (const root of roots) {
      for (const candidate of [...tails.map((tail) => root + tail), ...others]) {
        expect({ root, candidate, contained: isContained(root, candidate) }).toEqual({ root, candidate, contained: reference(root, candidate) })
        compared++
      }
    }
    expect(compared).toBeGreaterThan(80)
  })

  test("remembers within one operation only, including when it throws", () => {
    let computed = 0
    const compute = () => ++computed
    expect(scopeMemo("outside", compute)).toBe(1)
    expect(scopeMemo("outside", compute)).toBe(2)
    withContainmentScope(() => {
      expect(scopeMemo("inside", compute)).toBe(3)
      expect(scopeMemo("inside", compute)).toBe(3)
      withContainmentScope(() => expect(scopeMemo("inside", compute)).toBe(3))
      expect(scopeMemo("inside", compute)).toBe(3)
    })
    expect(scopedValue("inside")).toBeUndefined()
    expect(() => withContainmentScope(() => { scopeMemo("failing", compute); throw new Error("operation failed") })).toThrow("operation failed")
    expect(scopedValue("failing")).toBeUndefined()
    withContainmentScope(() => expect(scopeMemo("inside", compute)).toBe(5))
  })

  test("a directory swapped for a link between operations is always caught", () => {
    const project = tempProject("alg-scope-swap-")
    const outside = tempProject("alg-scope-outside-")
    try {
      const nested = join(project, "nested")
      mkdirSync(nested)
      writeFileSync(join(nested, "file.json"), "{}", "utf8")
      const resolve = () => withContainmentScope(() => {
        resolveContainedPath(project, "nested", "file.json")
        return resolveContainedPath(project, "nested", "file.json")
      })
      expect(resolve()).toBe(resolveContainedPath(project, "nested", "file.json"))
      renameSync(nested, join(project, "nested-moved"))
      try {
        symlinkSync(outside, nested, process.platform === "win32" ? "junction" : "dir")
      } catch {
        return // links are unavailable in this environment
      }
      expect(resolve).toThrow(/escapes its trusted root/)
      expect(() => resolveContainedPath(project, "nested", "file.json")).toThrow(/escapes its trusted root/)
    } finally {
      removeProject(project)
      removeProject(outside)
    }
  })
})

describe("lock ownership without reading the lock back", () => {
  function foreignRecord(path: string) {
    const now = Date.now()
    return { version: 1, owner: "other-writer", token: randomUUID(), pid: process.pid, host: hostname(), resource: path,
      acquired_at: new Date(now).toISOString(), expires_at: new Date(now + 30_000).toISOString() }
  }

  test("a renewed lock is still held, and release removes it", () => {
    const project = tempProject("alg-lock-identity-")
    try {
      const path = join(project, "resource.lock")
      const lock = acquireFilesystemMutex(path, { owner: "holder" })
      lock.assertHeld()
      lock.renew()
      lock.assertHeld()
      expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(lock.token)
      lock.release()
      expect(existsSync(path)).toBe(false)
      expect(() => lock.assertHeld()).toThrow(/no longer held/)
    } finally { removeProject(project) }
  })

  test("a lock replaced by another writer is lost and is never removed by the former holder", () => {
    const project = tempProject("alg-lock-replaced-")
    try {
      const path = join(project, "resource.lock")
      const lock = acquireFilesystemMutex(path, { owner: "holder" })
      renameSync(path, `${path}.stale-test`)
      const replacement = `${JSON.stringify(foreignRecord(path), null, 2)}\n`
      writeFileSync(path, replacement, "utf8")
      expect(() => lock.assertHeld()).toThrow(/token changed or expired/)
      expect(() => lock.renew()).toThrow(/no longer held/)
      lock.release()
      expect(readFileSync(path, "utf8")).toBe(replacement)
    } finally { removeProject(project) }
  })

  test("a lock that disappeared is lost", () => {
    const project = tempProject("alg-lock-missing-")
    try {
      const path = join(project, "resource.lock")
      const lock = acquireFilesystemMutex(path, { owner: "holder" })
      rmSync(path)
      expect(() => lock.assertHeld()).toThrow(/token changed or expired/)
      lock.release()
      expect(existsSync(path)).toBe(false)
    } finally { removeProject(project) }
  })

  test("waiting for a lock this thread holds fails at once instead of freezing for the whole wait", () => {
    const project = tempProject("alg-lock-self-")
    try {
      const path = join(project, "resource.lock")
      const lock = acquireFilesystemMutex(path, { owner: "holder" })
      const started = performance.now()
      expect(() => acquireFilesystemMutex(path, { owner: "second", waitMs: 2_000 })).toThrow(FilesystemMutexContentionError)
      expect(performance.now() - started).toBeLessThan(500)
      lock.release()
      acquireFilesystemMutex(path, { owner: "second", waitMs: 2_000 }).release()
    } finally { removeProject(project) }
  })

  test("another live holder is still waited for, up to the limit", () => {
    const project = tempProject("alg-lock-foreign-")
    try {
      const path = join(project, "resource.lock")
      writeFileSync(path, `${JSON.stringify(foreignRecord(path), null, 2)}\n`, "utf8")
      const started = performance.now()
      expect(() => acquireFilesystemMutex(path, { owner: "second", waitMs: 300 })).toThrow(FilesystemMutexContentionError)
      expect(performance.now() - started).toBeGreaterThanOrEqual(280)
    } finally { removeProject(project) }
  })
})

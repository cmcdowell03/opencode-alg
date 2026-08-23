import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import { spawn } from "node:child_process"
import {
  executeShellGate,
  SHELL_TAIL_BYTES,
  cleanupWindowsShellHelpers,
  windowsJobHelperBuildState,
  windowsJobHelperCachePath,
  windowsShellHelperArtifactSnapshot,
} from "../src/shell.ts"
import { removeProject, tempProject } from "./helpers.ts"

const windowsTest = process.platform === "win32" ? test : test.skip
const posixTest = process.platform === "win32" ? test.skip : test

function shellContext(project: string, options?: { ask?: () => Promise<void>; signal?: AbortSignal }) {
  return {
    ask: options?.ask ?? (async () => {}),
    abort: options?.signal ?? new AbortController().signal,
    worktree: project,
    directory: project,
  }
}

describe("permissioned bounded shell gate", () => {
  test("permission denial happens before spawn", async () => {
    const project = tempProject()
    const marker = join(project, "should-not-exist")
    try {
      const command = `node -e "require('fs').writeFileSync(${JSON.stringify(marker)},'x')"`
      const result = await executeShellGate({
        cmd: command,
        context: shellContext(project, { ask: async () => { throw new Error("denied") } }),
      })
      expect(result.exit_code).toBe(126)
      expect(result.stderr_tail).toContain("permission denied")
      expect(existsSync(marker)).toBe(false)
    } finally {
      removeProject(project)
    }
  })

  windowsTest("failed Windows helper build removes its exact recorded source and executable", async () => {
    const project = tempProject("alg-failed-job-helper-")
    const commandMarker = join(project, "command-must-not-run.txt")
    const compileCountBefore = windowsJobHelperBuildState().compileCount
    let paths: { directory: string; helperPath: string; sourcePath: string; markerPath: string } | undefined
    try {
      const result = await executeShellGate({
        cmd: `echo ran > "${commandMarker}"`,
        context: shellContext(project),
        windowsJobHelperBuildFault(stage, context) {
          if (stage !== "helper-recorded") return
          paths = context
          throw new Error("injected post-compile helper build failure")
        },
      })
      expect(result).toMatchObject({ ok: false, exit_code: 125, termination_failed: true })
      expect(result.stderr_tail).toContain("injected post-compile helper build failure")
      expect(existsSync(commandMarker)).toBe(false)
      expect(paths).toBeDefined()
      expect(existsSync(paths!.sourcePath)).toBe(false)
      expect(existsSync(paths!.helperPath)).toBe(false)
      expect(existsSync(paths!.markerPath)).toBe(false)
      expect(existsSync(paths!.directory)).toBe(false)
      expect(windowsJobHelperBuildState()).toEqual({ compileCount: compileCountBefore + 1 })
    } finally {
      if (paths?.directory) rmSync(paths.directory, { recursive: true, force: true })
      removeProject(project)
    }
  }, 60_000)

  windowsTest("private Windows Job helper ignores a poisoned legacy path and compiles once in-process", async () => {
    const project = tempProject("alg-private-job-")
    const legacy = windowsJobHelperCachePath()
    const compileCountBefore = windowsJobHelperBuildState().compileCount
    try {
      writeFileSync(legacy, "poisoned predictable helper must never execute", "utf8")
      const started = Date.now()
      const result = await executeShellGate({
        cmd: `node -e "process.stdout.write(process.cwd()+'|'+String(process.env.ALG_SECRET));process.stderr.write('cached-stderr');process.exit(7)"`,
        context: shellContext(project),
      })
      expect(Date.now() - started).toBeLessThan(18_000)
      expect(result.ok).toBe(false)
      expect(result.exit_code).toBe(7)
      expect(result.stdout_tail.toLowerCase()).toBe(`${project.toLowerCase()}|undefined`)
      expect(result.stderr_tail).toBe("cached-stderr")
      expect(result.cwd.toLowerCase()).toBe(project.toLowerCase())
      const firstBuild = windowsJobHelperBuildState()
      expect(firstBuild.compileCount).toBe(compileCountBefore + 1)
      expect(firstBuild.helperPath).toBeDefined()
      expect(firstBuild.helperPath!.toLowerCase()).not.toBe(legacy.toLowerCase())
      expect(readFileSync(legacy, "utf8")).toContain("poisoned predictable helper")

      const second = await executeShellGate({ cmd: "echo second-private-helper-run", context: shellContext(project) })
      expect(second.ok).toBe(true)
      expect(windowsJobHelperBuildState()).toEqual(firstBuild)

      const concurrent = await Promise.all([
        executeShellGate({ cmd: "echo concurrent-one", context: shellContext(project) }),
        executeShellGate({ cmd: "echo concurrent-two", context: shellContext(project) }),
      ])
      expect(concurrent.every((value) => value.ok)).toBe(true)
      expect(windowsJobHelperBuildState()).toEqual(firstBuild)
      const ownedDirectory = dirname(firstBuild.helperPath!)
      const markerPath = join(ownedDirectory, ".opencode-alg-owner.json")
      const marker = JSON.parse(readFileSync(markerPath, "utf8"))
      expect(marker).toMatchObject({
        schema: "opencode-alg-windows-helper-owner", schema_version: 1, pid: process.pid,
      })
      const helperName = firstBuild.helperPath!.split(/[\\/]/).at(-1)
      const sourceName = `source-${marker.token}.cs`
      expect(marker.helper.file).toBe(helperName)
      expect(marker.source.file).toBe(sourceName)
      for (const record of [marker.helper, marker.source]) {
        const path = join(ownedDirectory, record.file)
        const stat = lstatSync(path, { bigint: true })
        const bytes = readFileSync(path)
        expect(record).toEqual({
          file: record.file,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          size: bytes.byteLength,
          dev: stat.dev.toString(),
          ino: stat.ino.toString(),
        })
      }
      expect(marker.token).toMatch(/^[0-9a-f-]{36}$/i)
      expect(marker.process_start_identity).toBe(marker.process_start_time)
      expect(windowsShellHelperArtifactSnapshot()).toContain(ownedDirectory)

      const root = dirname(ownedDirectory)
      expect(existsSync(join(root, "opencode-alg-job-control-v2.dll"))).toBe(false)
      const fixtures: string[] = []
      const fixture = (kind: "dead" | "malformed" | "unmarked" | "race" | "mismatch" | "ambiguous") => {
        const token = randomUUID(); const pid = kind === "mismatch" ? process.pid : 2147483640 - fixtures.length
        const directory = join(root, `opencode-alg-job-helper-v13-${pid}-${token}`)
        mkdirSync(directory, { mode: 0o700 }); fixtures.push(directory)
        if (kind !== "unmarked") {
          const identity = kind === "mismatch" ? "2000-01-01T00:00:00.0000000Z" : marker.process_start_identity
          const helperFile = `helper-${token}.exe`
          const sourceFile = `source-${token}.cs`
          writeFileSync(join(directory, helperFile), "fixture helper", { flag: "wx", mode: 0o600 })
          writeFileSync(join(directory, sourceFile), "fixture source", { flag: "wx", mode: 0o600 })
          const owned = (file: string) => {
            const path = join(directory, file)
            const stat = lstatSync(path, { bigint: true })
            const bytes = readFileSync(path)
            return { file, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength, dev: stat.dev.toString(), ino: stat.ino.toString() }
          }
          const value = { ...marker, token, pid, process_start_identity: identity, process_start_time: identity, helper: owned(helperFile), source: owned(sourceFile), created_at: "2000-01-01T00:00:00.000Z" }
          writeFileSync(join(directory, ".opencode-alg-owner.json"), kind === "malformed" ? "{}\n" : `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 })
          try { chmodSync(join(directory, ".opencode-alg-owner.json"), 0o600) } catch {}
        }
        return directory
      }
      const dead = fixture("dead"); const malformed = fixture("malformed"); const unmarked = fixture("unmarked"); const raced = fixture("race"); const mismatch = fixture("mismatch"); const ambiguous = fixture("ambiguous")
      try {
        const cleaned = cleanupWindowsShellHelpers({ candidates: [dead, malformed, unmarked, raced], minimumAgeMs: 0, beforeDelete: (directory) => {
          if (directory !== raced) return
          const path = join(directory, ".opencode-alg-owner.json")
          rmSync(path, { force: true }); writeFileSync(path, "{}\n", { flag: "wx", mode: 0o600 })
        } })
        expect(cleaned.removed).toEqual([dead])
        expect(existsSync(dead)).toBe(false)
        expect(existsSync(malformed)).toBe(true)
        expect(existsSync(unmarked)).toBe(true)
        expect(existsSync(raced)).toBe(true)
        expect(cleanupWindowsShellHelpers({ candidates: [mismatch], minimumAgeMs: 0 }).removed).toEqual([mismatch])
        expect(cleanupWindowsShellHelpers({ candidates: [ambiguous], minimumAgeMs: 0, ownerProcessState: () => ({ state: "ambiguous" }) }).preserved).toEqual([ambiguous])
        expect(cleanupWindowsShellHelpers({ candidates: [ownedDirectory], minimumAgeMs: 0, includeCurrent: false }).preserved).toContain(ownedDirectory)

        for (const [fileKind, replacementKind] of [["helper", "same"], ["helper", "different"], ["source", "same"], ["source", "different"]] as const) {
          const replaced = fixture("dead")
          const replacedMarker = JSON.parse(readFileSync(join(replaced, ".opencode-alg-owner.json"), "utf8"))
          const replacedPath = join(replaced, replacedMarker[fileKind].file)
          const original = readFileSync(replacedPath)
          rmSync(replacedPath)
          const replacement = replacementKind === "same" ? original : Buffer.from(`${fileKind} different replacement\n`)
          writeFileSync(replacedPath, replacement, { flag: "wx", mode: 0o600 })
          expect(cleanupWindowsShellHelpers({ candidates: [replaced], minimumAgeMs: 0 }).removed).toEqual([])
          expect(readFileSync(replacedPath)).toEqual(replacement)
        }

        for (const fileKind of ["source", "helper"] as const) {
          const racedArtifact = fixture("dead")
          const racedMarker = JSON.parse(readFileSync(join(racedArtifact, ".opencode-alg-owner.json"), "utf8"))
          const racedPath = join(racedArtifact, racedMarker[fileKind].file)
          const replacement = Buffer.from(`foreign ${fileKind} cleanup race\n`)
          expect(cleanupWindowsShellHelpers({
            candidates: [racedArtifact], minimumAgeMs: 0,
            beforeFileDelete(path) {
              if (path !== racedPath) return
              rmSync(path)
              writeFileSync(path, replacement, { flag: "wx", mode: 0o600 })
            },
          }).removed).toEqual([])
          expect(readFileSync(racedPath)).toEqual(replacement)
          expect(existsSync(join(racedArtifact, ".opencode-alg-owner.json"))).toBe(true)
          if (fileKind === "source") expect(existsSync(join(racedArtifact, racedMarker.helper.file))).toBe(true)
        }

        for (const fileKind of ["source", "helper"] as const) {
          const inconsistent = fixture("dead")
          const inconsistentMarkerPath = join(inconsistent, ".opencode-alg-owner.json")
          const inconsistentMarker = JSON.parse(readFileSync(inconsistentMarkerPath, "utf8"))
          inconsistentMarker[fileKind].size += 1
          writeFileSync(inconsistentMarkerPath, `${JSON.stringify(inconsistentMarker)}\n`)
          expect(cleanupWindowsShellHelpers({ candidates: [inconsistent], minimumAgeMs: 0 }).removed).toEqual([])
          expect(existsSync(inconsistent)).toBe(true)
          expect(existsSync(join(inconsistent, inconsistentMarker.source.file))).toBe(true)
          expect(existsSync(join(inconsistent, inconsistentMarker.helper.file))).toBe(true)
        }
      } finally {
        for (const directory of fixtures) rmSync(directory, { recursive: true, force: true })
      }

      await Bun.sleep(3_500)
      expect(existsSync(ownedDirectory)).toBe(false)
      expect(windowsJobHelperBuildState().helperPath).toBeUndefined()
    } finally {
      rmSync(legacy, { force: true })
      removeProject(project)
    }
  }, 20_000)

  test("asks with exact command metadata and uses a canonical contained cwd", async () => {
    const project = tempProject()
    const child = join(project, "child")
    mkdirSync(child)
    let request: unknown
    try {
      const result = await executeShellGate({
        cmd: `node -e "process.stdout.write(process.cwd())"`,
        cwd: "child",
        context: {
          ...shellContext(project),
          ask: async (input) => { request = input },
        },
        metadata: { run_id: "r", node_id: "n" },
      })
      expect(result.ok).toBe(true)
      expect(result.cwd.toLowerCase()).toBe(child.toLowerCase())
      expect(result.stdout_tail.toLowerCase()).toBe(child.toLowerCase())
      expect(request).toMatchObject({ permission: "bash", patterns: [`node -e "process.stdout.write(process.cwd())"`], always: [] })
      await expect(executeShellGate({
        cmd: "echo escape",
        cwd: "..",
        context: shellContext(project),
      })).rejects.toThrow(/contained/)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  windowsTest("Windows timeout starts at command-ready after delayed watcher setup", async () => {
    const project = tempProject("alg-delayed-watcher-")
    const script = join(project, "heartbeat.cjs")
    const startMarker = join(project, "command-started.txt")
    const heartbeat = join(project, "command-heartbeat.log")
    try {
      writeFileSync(script, `
const fs = require("node:fs")
const start = Date.now()
fs.writeFileSync(process.argv[2], String(start))
fs.appendFileSync(process.argv[3], String(start) + "\\n")
setInterval(() => fs.appendFileSync(process.argv[3], String(Date.now()) + "\\n"), 10)
`, "utf8")
      const timeoutMs = 5_000
      const setupStarted = performance.now()
      let commandReadyObserved: number | undefined
      const result = await executeShellGate({
        cmd: [process.execPath, script, startMarker, heartbeat].map((part) => `"${part}"`).join(" "),
        timeoutMs,
        windowsJobWatcherReadyDelayMs: 800,
        // executeShellGate evaluates this only after observing the native
        // command-ready marker and immediately before arming the timeout.
        timeoutReadiness: () => {
          commandReadyObserved ??= performance.now()
          return true
        },
        context: shellContext(project),
      })
      const completed = performance.now()
      expect(result.timed_out).toBe(true)
      expect(result.termination_failed).toBeUndefined()
      expect(commandReadyObserved).toBeNumber()
      expect(commandReadyObserved! - setupStarted).toBeGreaterThanOrEqual(650)
      expect(completed - commandReadyObserved!).toBeGreaterThanOrEqual(timeoutMs)
      const commandStarted = Number(readFileSync(startMarker, "utf8"))
      // Parse the append-only observation log instead of racing a child killed
      // during truncate-and-rewrite. Any interrupted trailing record is ignored.
      const heartbeats = readFileSync(heartbeat, "utf8")
        .split(/\r?\n/)
        .filter((line) => /^\d+$/.test(line))
        .map(Number)
      const lastHeartbeat = Math.max(...heartbeats)
      expect(heartbeats.length).toBeGreaterThan(1)
      expect(lastHeartbeat - commandStarted).toBeGreaterThanOrEqual(20)
      expect(lastHeartbeat - commandStarted).toBeLessThan(6_500)
    } finally {
      removeProject(project)
    }
  }, 20_000)

  test("times out and terminates long-running commands", async () => {
    const project = tempProject()
    try {
      const result = await executeShellGate({
        cmd: `node -e "setTimeout(()=>{},5000)"`,
        timeoutMs: 150,
        context: shellContext(project),
      })
      expect(result.ok).toBe(false)
      expect(result.timed_out).toBe(true)
      expect(result.exit_code).toBe(124)
    } finally {
      removeProject(project)
    }
  }, 20_000)

  test("keeps fixed-size byte tails without accumulating full output", async () => {
    const project = tempProject()
    try {
      const result = await executeShellGate({
        cmd: `node -e "process.stdout.write('x'.repeat(50000));process.stderr.write('y'.repeat(50000))"`,
        context: shellContext(project),
      })
      expect(result.ok).toBe(true)
      expect(Buffer.byteLength(result.stdout_tail)).toBeLessThanOrEqual(SHELL_TAIL_BYTES)
      expect(Buffer.byteLength(result.stderr_tail)).toBeLessThanOrEqual(SHELL_TAIL_BYTES)
      expect(result.stdout_tail).toBe("x".repeat(SHELL_TAIL_BYTES))
      expect(result.stderr_tail).toBe("y".repeat(SHELL_TAIL_BYTES))
    } finally {
      removeProject(project)
    }
  }, 20_000)

  test("abort cancellation terminates a spawned command", async () => {
    const project = tempProject()
    const controller = new AbortController()
    try {
      setTimeout(() => controller.abort(), 100)
      const result = await executeShellGate({
        cmd: `node -e "setTimeout(()=>{},5000)"`,
        timeoutMs: 5_000,
        context: shellContext(project, { signal: controller.signal }),
      })
      expect(result.ok).toBe(false)
      expect(result.cancelled).toBe(true)
      expect(result.exit_code).toBe(130)
    } finally {
      removeProject(project)
    }
  }, 20_000)

  test("abort occurring inside spawn is caught by the post-registration recheck", async () => {
    const project = tempProject()
    const controller = new AbortController()
    class RaceChild extends EventEmitter {
      pid = 4343
      stdout = undefined
      stderr = undefined
      kills: Array<string | undefined> = []
      kill(signal?: string) {
        this.kills.push(signal)
        return true
      }
    }
    const child = new RaceChild()
    try {
      const result = await executeShellGate({
        cmd: "abort during spawn",
        timeoutMs: 5_000,
        context: shellContext(project, { signal: controller.signal }),
        spawnProcess: (() => {
          controller.abort()
          return child
        }) as never,
        processControl: {
          terminationPlatform: "win32",
          windowsJobObjectReady: () => true,
          terminationGraceMs: 50,
          runWindowsProcessTreeSnapshot: async () => ({
            confirmed: true,
            processes: [{ pid: child.pid, parent_pid: 0, depth: 0 }],
          }),
          runWindowsTaskkill: async () => {},
          runWindowsProcessTreeFallback: async () => ({ confirmed: true }),
        },
      })
      expect(result.cancelled).toBe(true)
      expect(result.exit_code).toBe(130)
      expect(result.termination_failed).toBeUndefined()
      expect(child.kills).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]))
    } finally {
      removeProject(project)
    }
  })

  test("child error during termination cannot mask failed containment verification", async () => {
    const project = tempProject()
    class TerminatingChild extends EventEmitter {
      pid = 4545
      stdout = undefined
      stderr = undefined
      kill() { return true }
    }
    const child = new TerminatingChild()
    try {
      const result = await executeShellGate({
        cmd: "termination error race",
        timeoutMs: 100,
        context: shellContext(project),
        spawnProcess: (() => child) as never,
        processControl: {
          terminationPlatform: "win32",
          windowsJobObjectReady: () => true,
          terminationGraceMs: 50,
          runWindowsProcessTreeSnapshot: async () => ({
            confirmed: true,
            processes: [{ pid: child.pid, parent_pid: 0, depth: 0 }],
          }),
          runWindowsTaskkill: async () => {},
          runWindowsProcessTreeFallback: async () => {
            setTimeout(() => child.emit("error", new Error("child emitted during termination")), 10)
            await Bun.sleep(40)
            throw new Error("injected verification rejection")
          },
        },
      })
      expect(result.timed_out).toBe(true)
      expect(result.termination_failed).toBe(true)
      expect(result.stderr_tail).toContain("child emitted during termination")
      expect(result.stderr_tail).toContain("injected verification rejection")
    } finally {
      removeProject(project)
    }
  }, 10_000)

  test("Windows taskkill failure or hang is bounded with direct-kill fallback", async () => {
    const project = tempProject()
    class FakeChild extends EventEmitter {
      pid = 4242
      stdout = undefined
      stderr = undefined
      kills: Array<string | undefined> = []
      kill(signal?: string) {
        this.kills.push(signal)
        return false
      }
    }
    try {
      const timeoutChild = new FakeChild()
      const started = Date.now()
      const timed = await executeShellGate({
        cmd: "mock timeout",
        timeoutMs: 100,
        context: shellContext(project),
        spawnProcess: (() => timeoutChild) as never,
        processControl: {
          terminationPlatform: "win32",
          windowsJobObjectReady: () => true,
          terminationGraceMs: 50,
          runWindowsTaskkill: async () => new Promise<void>(() => {}),
          runWindowsProcessTreeSnapshot: async () => ({ confirmed: true, processes: [{ pid: 4242, parent_pid: 0, depth: 0 }] }),
          runWindowsProcessTreeFallback: async () => ({ confirmed: false, detail: "injected unconfirmed tree" }),
        },
      })
      expect(timed.timed_out).toBe(true)
      expect(timed.exit_code).toBe(124)
      expect(Date.now() - started).toBeLessThan(10_000)
      expect(timeoutChild.kills).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]))
      expect(timed.termination_failed).toBe(true)
      expect(timed.stderr_tail).toContain("termination failure")

      const cancelChild = new FakeChild()
      const controller = new AbortController()
      setTimeout(() => controller.abort(), 20)
      const cancelled = await executeShellGate({
        cmd: "mock cancel",
        timeoutMs: 5_000,
        context: shellContext(project, { signal: controller.signal }),
        spawnProcess: (() => cancelChild) as never,
        processControl: {
          terminationPlatform: "win32",
          windowsJobObjectReady: () => true,
          terminationGraceMs: 50,
          runWindowsTaskkill: async () => { throw new Error("taskkill unavailable") },
          runWindowsProcessTreeSnapshot: async () => ({ confirmed: true, processes: [{ pid: 4242, parent_pid: 0, depth: 0 }] }),
          runWindowsProcessTreeFallback: async () => ({ confirmed: false, detail: "injected unconfirmed tree" }),
        },
      })
      expect(cancelled.cancelled).toBe(true)
      expect(cancelled.exit_code).toBe(130)
      expect(cancelChild.kills).toEqual(expect.arrayContaining(["SIGTERM", "SIGKILL"]))
      expect(cancelled.termination_failed).toBe(true)
    } finally {
      removeProject(project)
    }
  }, 15_000)

  windowsTest("Windows fallback kills a real grandchild before its delayed marker write", async () => {
    const project = tempProject("alg-win-tree-")
    const marker = join(project, "grandchild-survived.txt")
    const commandStartedMarker = join(project, "command-started.txt")
    const grandchildArmedMarker = join(project, "grandchild-armed.txt")
    const rootScript = join(project, "root.cjs")
    const childScript = join(project, "child.cjs")
    const grandchildScript = join(project, "grandchild.cjs")
    try {
      writeFileSync(rootScript, `
const { spawn } = require("node:child_process")
require("node:fs").writeFileSync(process.argv[5], String(Date.now()))
spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[4], process.argv[6]], { stdio: "ignore", windowsHide: true })
setInterval(() => {}, 1000)
`, "utf8")
      writeFileSync(childScript, `
const { spawn } = require("node:child_process")
spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[4]], { stdio: "ignore", windowsHide: true })
setInterval(() => {}, 1000)
`, "utf8")
      writeFileSync(grandchildScript, `
const fs = require("node:fs")
fs.writeFileSync(process.argv[3], "armed")
setTimeout(() => fs.writeFileSync(process.argv[2], "survived"), 4500)
setInterval(() => {}, 1000)
`, "utf8")
      const command = [process.execPath, rootScript, childScript, grandchildScript, marker, commandStartedMarker, grandchildArmedMarker]
        .map((part) => `"${part}"`)
        .join(" ")
      let readinessAt: number | undefined
      const result = await executeShellGate({
        cmd: command,
        timeoutMs: 200,
        timeoutReadiness: () => {
          const ready = existsSync(commandStartedMarker) && existsSync(grandchildArmedMarker)
          if (ready && readinessAt === undefined) readinessAt = Date.now()
          return ready
        },
        context: shellContext(project),
        processControl: {
          terminationGraceMs: 1_000,
          runWindowsTaskkill: async () => { throw new Error("injected taskkill failure") },
        },
      })
      expect(result.timed_out).toBe(true)
      expect(result.termination_failed).toBeUndefined()
      expect(readinessAt).toBeDefined()
      expect(Date.now() - readinessAt!).toBeLessThan(20_000)
      expect(existsSync(commandStartedMarker)).toBe(true)
      expect(existsSync(grandchildArmedMarker)).toBe(true)
      const commandStartedAt = Number(await Bun.file(commandStartedMarker).text())
      await Bun.sleep(Math.max(0, commandStartedAt + 4_700 - Date.now()))
      expect(existsSync(marker)).toBe(false)
    } finally {
      removeProject(project)
    }
  }, 70_000)

  windowsTest("Windows helper lifecycle leaves zero net strictly owned TEMP additions", async () => {
    const before = windowsShellHelperArtifactSnapshot()
    const project = tempProject("alg-helper-net-")
    try {
      const result = await executeShellGate({ cmd: "echo lifecycle-snapshot", context: shellContext(project) })
      expect(result).toMatchObject({ ok: true })
      await Bun.sleep(3_500)
      expect(windowsShellHelperArtifactSnapshot()).toEqual(before)
    } finally {
      removeProject(project)
    }
  }, 20_000)

  windowsTest("a next process janitor reclaims a marked helper after its owner is forcibly killed", async () => {
    const project = tempProject("alg-helper-killed-owner-")
    const script = `import { executeShellGate, windowsJobHelperBuildState } from './src/shell.ts'; const context={ask:async()=>{},abort:new AbortController().signal,worktree:${JSON.stringify(project)},directory:${JSON.stringify(project)}}; const result=await executeShellGate({cmd:'echo child-owner',context}); if(!result.ok) throw new Error(result.stderr_tail); console.log(JSON.stringify(windowsJobHelperBuildState())); setInterval(()=>{},1000)`
    const child = spawn(process.execPath, ["-e", script], { cwd: join(import.meta.dir, ".."), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
    try {
      const line = await new Promise<string>((resolveLine, rejectLine) => {
        let output = ""; const timer = setTimeout(() => rejectLine(new Error("child helper path timed out")), 20_000)
        child.stdout!.on("data", (chunk) => { output += chunk.toString(); const found = output.split(/\r?\n/).find((value) => value.startsWith("{")); if (found) { clearTimeout(timer); resolveLine(found) } })
        child.once("error", rejectLine)
      })
      const directory = dirname(JSON.parse(line).helperPath)
      expect(existsSync(directory)).toBe(true)
      child.kill("SIGKILL")
      await new Promise((resolveClose) => child.once("close", resolveClose))
      await Bun.sleep(500)
      const result = cleanupWindowsShellHelpers({ candidates: [directory], minimumAgeMs: 0 })
      expect(result.removed).toEqual([directory])
      expect(existsSync(directory)).toBe(false)
    } finally {
      try { child.kill("SIGKILL") } catch {}
      removeProject(project)
    }
  }, 30_000)

  posixTest("POSIX timeout verifies a real child/grandchild process group is gone", async () => {
    const project = tempProject("alg-posix-tree-")
    const marker = join(project, "grandchild-survived.txt")
    const rootScript = join(project, "root.cjs")
    const childScript = join(project, "child.cjs")
    const grandchildScript = join(project, "grandchild.cjs")
    try {
      writeFileSync(rootScript, `
const { spawn } = require("node:child_process")
spawn(process.execPath, [process.argv[2], process.argv[3], process.argv[4]], { stdio: "ignore" })
setInterval(() => {}, 1000)
`, "utf8")
      writeFileSync(childScript, `
const { spawn } = require("node:child_process")
spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore" })
setInterval(() => {}, 1000)
`, "utf8")
      writeFileSync(grandchildScript, `
const fs = require("node:fs")
setTimeout(() => fs.writeFileSync(process.argv[2], "survived"), 1200)
setInterval(() => {}, 1000)
`, "utf8")
      const command = [process.execPath, rootScript, childScript, grandchildScript, marker]
        .map((part) => `"${part}"`)
        .join(" ")
      const result = await executeShellGate({
        cmd: command,
        timeoutMs: 150,
        context: shellContext(project),
        processControl: { terminationGraceMs: 200 },
      })
      expect(result.timed_out).toBe(true)
      expect(result.termination_failed).toBeUndefined()
      await Bun.sleep(1_300)
      expect(existsSync(marker)).toBe(false)
    } finally {
      removeProject(project)
    }
  }, 10_000)

  posixTest("POSIX normal shell exit terminates redirected-stdio background descendants", async () => {
    const project = tempProject("alg-posix-normal-exit-")
    const launcher = join(project, "launcher.cjs")
    const writer = join(project, "writer.cjs")
    const marker = join(project, "background-survived.txt")
    try {
      writeFileSync(launcher, `
const { spawn } = require("node:child_process")
spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: "ignore" }).unref()
`, "utf8")
      writeFileSync(writer, `
const fs = require("node:fs")
setTimeout(() => fs.writeFileSync(process.argv[2], "survived"), 500)
`, "utf8")
      const command = [process.execPath, launcher, writer, marker].map((part) => `"${part}"`).join(" ")
      const result = await executeShellGate({
        cmd: command,
        timeoutMs: 5_000,
        context: shellContext(project),
        processControl: { terminationGraceMs: 50 },
      })
      expect(result.ok).toBe(true)
      expect(result.termination_failed).toBeUndefined()
      await Bun.sleep(600)
      expect(existsSync(marker)).toBe(false)
    } finally {
      removeProject(project)
    }
  }, 5_000)
})

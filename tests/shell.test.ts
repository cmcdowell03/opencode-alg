import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { EventEmitter } from "node:events"
import {
  executeShellGate,
  SHELL_TAIL_BYTES,
  windowsJobHelperBuildState,
  windowsJobHelperCachePath,
} from "../src/shell.ts"
import { removeProject, tempProject } from "./helpers.ts"

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

  test("private Windows Job helper ignores a poisoned legacy path and compiles once in-process", async () => {
    if (process.platform !== "win32") return
    const project = tempProject("alg-private-job-")
    const legacy = windowsJobHelperCachePath()
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
      expect(firstBuild.compileCount).toBe(1)
      expect(firstBuild.helperPath).toBeDefined()
      expect(firstBuild.helperPath!.toLowerCase()).not.toBe(legacy.toLowerCase())
      expect(readFileSync(legacy, "utf8")).toContain("poisoned predictable helper")

      const second = await executeShellGate({ cmd: "echo second-private-helper-run", context: shellContext(project) })
      expect(second.ok).toBe(true)
      expect(windowsJobHelperBuildState()).toEqual(firstBuild)
    } finally {
      rmSync(legacy, { force: true })
      removeProject(project)
    }
  }, 20_000)

  test("Windows timeout starts at command-ready after delayed watcher setup", async () => {
    if (process.platform !== "win32") return
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

  test("Windows fallback kills a real grandchild before its delayed marker write", async () => {
    if (process.platform !== "win32") {
      console.warn("Windows process-tree integration regression skipped off Windows")
      return
    }
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

  test("POSIX timeout verifies a real child/grandchild process group is gone", async () => {
    if (process.platform === "win32") {
      console.warn("POSIX process-group integration regression skipped on Windows")
      return
    }
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

  test("POSIX normal shell exit terminates redirected-stdio background descendants", async () => {
    if (process.platform === "win32") return
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

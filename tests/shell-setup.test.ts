import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { cleanupWindowsShellHelpers, executeShellGate, prepareShellRuntime, SHELL_TAIL_BYTES, windowsJobHelperBuildState } from "../src/shell.ts"
import { removeProject, tempProject } from "./helpers.ts"

const windowsTest = process.platform === "win32" ? test : test.skip
const posixTest = process.platform === "win32" ? test.skip : test

function nestedTemp(project: string, length: number): string {
  let root = project
  while (root.length < length - 1) root = join(root, "t".repeat(Math.min(32, length - root.length - 1)))
  mkdirSync(root, { recursive: true })
  return root
}

windowsTest("Windows helper compiles and executes under a long isolated TEMP", async () => {
  const project = tempProject("alg-setup-long-")
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP }
  const root = nestedTemp(project, 179)
  cleanupWindowsShellHelpers({ includeCurrent: true, minimumAgeMs: 0 })
  const compileCount = windowsJobHelperBuildState().compileCount
  let preparation: Awaited<ReturnType<typeof prepareShellRuntime>> | undefined
  try {
    process.env.TEMP = root
    process.env.TMP = root
    const before = readdirSync(project)
    preparation = await prepareShellRuntime()
    expect(preparation.stderr_tail).toBe("")
    expect(preparation.ok).toBe(true)
    expect(preparation.compiler).toMatchObject({ exit_code: 0, stdout_tail: "", stderr_tail: "" })
    expect(preparation.compiler!.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(preparation.compiler!.duration_ms).toBeGreaterThan(0)
    expect(readdirSync(project)).toEqual(before)
    const built = windowsJobHelperBuildState()
    expect(built.compileCount).toBe(compileCount + 1)
    const helperDirectory = built.helperPath!.slice(0, -"helper.exe".length)
    const marker = JSON.parse(readFileSync(join(helperDirectory, ".opencode-alg-owner.json"), "utf8"))
    expect(marker.source.file).toBe("source.cs")
    // Same TEMP + the previous layout exceeded 290 characters (the regression).
    expect(join(root, `opencode-alg-job-helper-v13-${process.pid}-${marker.token}`, `helper-${marker.token}.exe`).length).toBeGreaterThan(290)
    expect(built.helperPath!.length).toBeLessThan(260)
    await Bun.sleep(1_700)
    expect(existsSync(built.helperPath!)).toBe(true) // preflight lease survives idle cleanup
    const second = await prepareShellRuntime()
    expect(second.ok).toBe(true)
    second.release()
    expect(cleanupWindowsShellHelpers({ includeCurrent: true, minimumAgeMs: 0 }).preserved).toContain(helperDirectory.slice(0, -1))
    const result = await executeShellGate({
      cmd: "echo long-temp-ready",
      context: { ask: async () => {}, abort: new AbortController().signal, worktree: project, directory: project },
    })
    expect(result.stderr_tail).toBe("")
    expect(result.ok).toBe(true)
    expect(result.stdout_tail).toContain("long-temp-ready")
    expect(windowsJobHelperBuildState()).toEqual(built)
  } finally {
    preparation?.release()
    preparation?.release()
    // executeShellGate may resolve just before its separate watcher closes.
    await Bun.sleep(2_000)
    cleanupWindowsShellHelpers({ includeCurrent: true, minimumAgeMs: 0 })
    for (const name of ["TEMP", "TMP"] as const) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
    removeProject(project)
  }
}, 60_000)

windowsTest("cancellation during compiler startup reaps preparation and never runs a command", async () => {
  cleanupWindowsShellHelpers({ includeCurrent: true, minimumAgeMs: 0 })
  const before = windowsJobHelperBuildState().compileCount
  const controller = new AbortController()
  const timer = setInterval(() => {
    if (windowsJobHelperBuildState().compileCount > before) controller.abort()
  }, 1)
  try {
    const result = await prepareShellRuntime({ signal: controller.signal })
    expect(result).toMatchObject({ ok: false, cancelled: true })
    expect(result.compiler?.cancelled).toBe(true)
    expect(result.setup_failed).toBeUndefined()
    expect(windowsJobHelperBuildState().helperPath).toBeUndefined()
    result.release()
  } finally {
    clearInterval(timer)
  }
}, 60_000)

posixTest("Bash preparation is read-only and unavailable shells fail with sanitized diagnostics", async () => {
  const previous = process.env.SHELL
  try {
    process.env.SHELL = "/bin/bash"
    const result = await prepareShellRuntime()
    expect(result).toMatchObject({ ok: true, stdout_tail: "", stderr_tail: "" })
    expect(result.compiler).toBeUndefined()
    result.release()
    process.env.SHELL = "/nonexistent/api_key=synthetic-do-not-persist"
    const failed = await prepareShellRuntime()
    expect(failed).toMatchObject({ ok: false, setup_failed: true })
    expect(failed.stderr_tail).not.toContain("synthetic-do-not-persist")
    failed.release()
  } finally {
    if (previous === undefined) delete process.env.SHELL
    else process.env.SHELL = previous
  }
})

test("preparation cancellation before start never compiles or launches a command", async () => {
  const controller = new AbortController()
  controller.abort("do not echo arbitrary abort reasons")
  const before = windowsJobHelperBuildState()
  const result = await prepareShellRuntime({ signal: controller.signal })
  expect(result).toMatchObject({ ok: false, cancelled: true, stdout_tail: "" })
  expect(result.setup_failed).toBeUndefined()
  expect(result.stderr_tail).toBe("shell runtime preparation cancelled")
  expect(windowsJobHelperBuildState()).toEqual(before)
  result.release()
})

windowsTest("compiler failure keeps bounded stdout and identity without uncertain command termination", async () => {
  const project = tempProject("alg-setup-diagnostics-")
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP }
  // Beyond even the compact layout's legacy csc limit: fail closed in TEMP.
  const root = nestedTemp(project, 225)
  cleanupWindowsShellHelpers({ includeCurrent: true, minimumAgeMs: 0 })
  try {
    process.env.TEMP = root
    process.env.TMP = root
    const result = await prepareShellRuntime()
    expect(result).toMatchObject({ ok: false, setup_failed: true })
    expect(result.compiler?.exit_code).not.toBe(0)
    expect(result.compiler?.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.stderr_tail).toContain("sha256=")
    expect(result.stdout_tail + result.compiler!.stderr_tail).toMatch(/too long|invalid|path/i)
    for (const tail of [result.stdout_tail, result.stderr_tail, result.compiler!.stdout_tail, result.compiler!.stderr_tail]) {
      expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(SHELL_TAIL_BYTES)
      expect(tail).not.toMatch(/[\x00-\x08\x0b\x0c\x0e-\x1f]/)
    }
    expect(windowsJobHelperBuildState().helperPath).toBeUndefined()
    expect(readdirSync(root)).toEqual([])
    result.release()
  } finally {
    for (const name of ["TEMP", "TMP"] as const) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
    removeProject(project)
  }
}, 60_000)

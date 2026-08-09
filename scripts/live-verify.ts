import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:net"
import { terminateProcessTree } from "../src/shell.ts"

const REQUIRED_VERSION = "1.18.3"
const ALG_TOOL_IDS = [
  "alg_templates",
  "alg_models",
  "alg_criteria",
  "alg_plan",
  "alg_run",
  "alg_status",
  "alg_resume",
  "alg_artifact",
  "alg_transfer",
] as const
const COMMAND_TIMEOUT_MS = 15_000
const SERVER_TIMEOUT_MS = 60_000
const TUI_TIMEOUT_MS = 60_000
const OUTPUT_LIMIT = 256 * 1024
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

interface CapturedProcess {
  child: ChildProcess
  stdout(): string
  stderr(): string
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = `${current}${chunk.toString()}`
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT)
}

function spawnCaptured(command: string, args: string[], cwd: string): CapturedProcess {
  const child = spawn(command, args, {
    cwd,
    env: process.env,
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk: Buffer) => { stdout = appendTail(stdout, chunk) })
  child.stderr?.on("data", (chunk: Buffer) => { stderr = appendTail(stderr, chunk) })
  return { child, stdout: () => stdout, stderr: () => stderr }
}

function resolveOpenCodeExecutable(requested: string): string {
  if (isAbsolute(requested)) {
    if (!existsSync(requested)) throw new Error(`OpenCode executable does not exist: ${requested}`)
    return requested
  }
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""]
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${requested}${extension}`)
      if (!existsSync(candidate)) continue
      if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(candidate)) {
        const packaged = join(dirname(candidate), "node_modules", "opencode-ai", "bin", "opencode.exe")
        if (existsSync(packaged)) return packaged
      }
      return candidate
    }
  }
  throw new Error(`OpenCode executable was not found on PATH: ${requested}`)
}

async function stopProcess(process: CapturedProcess | undefined): Promise<void> {
  if (!process || process.child.exitCode !== null) return
  try {
    await Promise.race([
      terminateProcessTree(process.child as ReturnType<typeof spawn>, { terminationGraceMs: 1_000 }),
      Bun.sleep(7_000).then(() => { throw new Error("cleanup timeout") }),
    ])
  } catch {
    try { process.child.kill("SIGKILL") } catch { /* best effort after bounded tree cleanup */ }
  }
  const deadline = Date.now() + 5_000
  while (process.child.exitCode === null && Date.now() < deadline) await Bun.sleep(50)
}

async function removeTreeWithRetry(path: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      rmSync(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(code ?? '') || Date.now() >= deadline) throw error
      await Bun.sleep(100)
    }
  }
}

async function waitForExit(process: CapturedProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error(`command exceeded ${timeoutMs} ms`)), timeoutMs)
    process.child.once("error", (error) => {
      clearTimeout(timer)
      rejectExit(error)
    })
    process.child.once("close", (code) => {
      clearTimeout(timer)
      resolveExit(code ?? 1)
    })
  })
}

async function runCommand(command: string, args: string[], cwd: string, timeoutMs: number) {
  const process = spawnCaptured(command, args, cwd)
  try {
    const exitCode = await waitForExit(process, timeoutMs)
    return { exitCode, stdout: process.stdout(), stderr: process.stderr() }
  } finally {
    await stopProcess(process)
  }
}

async function unusedPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer()
    server.once("error", rejectPort)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      const port = typeof address === "object" && address ? address.port : 0
      server.close((error) => error ? rejectPort(error) : resolvePort(port))
    })
  })
}

async function fetchToolIds(
  url: string,
  capturedProcess?: CapturedProcess,
): Promise<{ status: number; body: string; ids: string[] }> {
  const deadline = Date.now() + SERVER_TIMEOUT_MS
  let lastError = "server did not respond"
  while (Date.now() < deadline) {
    if (capturedProcess && capturedProcess.child.exitCode !== null) {
      throw new Error(
        `OpenCode server exited ${capturedProcess.child.exitCode} before readiness; ` +
        `stdout=${capturedProcess.stdout().slice(-2_000)}; stderr=${capturedProcess.stderr().slice(-2_000)}`,
      )
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) })
      const body = await response.text()
      return { status: response.status, body, ids: parseAlgToolIds(body) }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      await Bun.sleep(250)
    }
  }
  throw new Error(
    `OpenCode server readiness timeout after ${SERVER_TIMEOUT_MS} ms: ${lastError}; ` +
    `stdout=${capturedProcess?.stdout().slice(-2_000) ?? ""}; stderr=${capturedProcess?.stderr().slice(-2_000) ?? ""}`,
  )
}

export function parseAlgToolIds(body: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(body) } catch { return [] }
  const values = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray((parsed as { tools?: unknown }).tools)
      ? (parsed as { tools: unknown[] }).tools
      : []
  return values
    .filter((value): value is string => typeof value === "string" && value.startsWith("alg_"))
}

async function waitForTuiLog(process: CapturedProcess): Promise<string> {
  const marker = "/alg-models registered"
  const deadline = Date.now() + TUI_TIMEOUT_MS
  while (Date.now() < deadline) {
    const combined = `${process.stdout()}\n${process.stderr()}`
    const line = combined.split(/\r?\n/).find((value) => value.includes(marker))
    if (line) return line
    if (process.child.exitCode !== null) throw new Error(`TUI exited ${process.child.exitCode} before registration evidence`)
    await Bun.sleep(100)
  }
  throw new Error(`TUI registration log not observed within ${TUI_TIMEOUT_MS} ms`)
}

function outputArgument(args: string[]): string {
  const index = args.indexOf("--output")
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || args.length !== 2 || !isAbsolute(value)) {
    throw new Error("usage: bun run scripts/live-verify.ts --output <absolute-evidence.json>")
  }
  return resolve(value)
}

export async function runLiveVerification(outputPath: string): Promise<void> {
  if (!isAbsolute(outputPath)) throw new Error("live verification output path must be absolute")
  outputPath = resolve(outputPath)
  const executable = resolveOpenCodeExecutable(process.env.OPENCODE_BIN?.trim() || "opencode")
  const project = mkdtempSync(join(tmpdir(), "alg-live-verify-"))
  let server: CapturedProcess | undefined
  let tui: CapturedProcess | undefined
  const evidence: Record<string, unknown> = {
    generated_at: new Date().toISOString(),
    no_model_calls: true,
    required_version: REQUIRED_VERSION,
    required_alg_tool_ids: ALG_TOOL_IDS,
    output_path: outputPath,
    passed: false,
  }
  let failure: unknown
  try {
    const version = await runCommand(executable, ["--version"], project, COMMAND_TIMEOUT_MS)
    const versionText = version.stdout.trim()
    evidence.version = { command: [executable, "--version"], ...version, parsed: versionText }
    if (version.exitCode !== 0 || versionText !== REQUIRED_VERSION) {
      throw new Error(`expected OpenCode ${REQUIRED_VERSION}, received ${JSON.stringify(versionText)}`)
    }

    const port = await unusedPort()
    const serverArgs = ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "INFO"]
    server = spawnCaptured(executable, serverArgs, project)
    const endpoint = `http://127.0.0.1:${port}/experimental/tool/ids`
    const http = await fetchToolIds(endpoint, server)
    evidence.server = {
      command: [executable, ...serverArgs],
      endpoint,
      raw_http_status: http.status,
      raw_http_body: http.body,
      parsed_alg_ids: http.ids,
    }
    if (http.status !== 200) throw new Error(`tool endpoint returned HTTP ${http.status}`)
    const missing = ALG_TOOL_IDS.filter((id) => !http.ids.includes(id))
    if (missing.length || http.ids.length !== ALG_TOOL_IDS.length) {
      throw new Error(`ALG tool evidence mismatch; missing=${missing.join(",")}, observed=${http.ids.join(",")}`)
    }
    await stopProcess(server)
    evidence.server = { ...(evidence.server as object), stdout_tail: server.stdout(), stderr_tail: server.stderr() }
    server = undefined

    const tuiArgs = [project, "--print-logs", "--log-level", "INFO"]
    tui = spawnCaptured(executable, tuiArgs, project)
    const registrationLog = await waitForTuiLog(tui)
    evidence.tui = {
      command: [executable, ...tuiArgs],
      registration_log: registrationLog,
      stdout_tail: tui.stdout(),
      stderr_tail: tui.stderr(),
    }
    evidence.passed = true
  } catch (error) {
    failure = error
    evidence.failure = error instanceof Error ? error.message : String(error)
  } finally {
    await stopProcess(tui)
    await stopProcess(server)
    if (server) evidence.server_logs_on_failure = { stdout_tail: server.stdout(), stderr_tail: server.stderr() }
    if (tui) evidence.tui_logs_on_failure = { stdout_tail: tui.stdout(), stderr_tail: tui.stderr() }
    await removeTreeWithRetry(project)
    mkdirSync(dirname(outputPath), { recursive: true })
    writeFileSync(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
  }
  if (failure) throw failure
}

if (import.meta.main) await runLiveVerification(outputArgument(process.argv.slice(2)))

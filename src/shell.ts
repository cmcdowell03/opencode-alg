import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import type { ToolContext } from "@opencode-ai/plugin"
import { canonicalContainedDirectory } from "./paths.ts"

export const DEFAULT_SHELL_TIMEOUT_MS = 60_000
export const MAX_SHELL_TIMEOUT_MS = 600_000
export const SHELL_TAIL_BYTES = 4_096
export const DEFAULT_TERMINATION_GRACE_MS = 1_500
const MAX_CONTROLLED_PATH_CHARS = 12_000
const WINDOWS_JOB_READINESS_TIMEOUT_MS = 45_000

/** Deliberately small inheritance set; graph definitions cannot add environment variables. */
export const ALG_SHELL_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "WINDIR",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "LANG",
  "LC_ALL",
  "TERM",
  "SHELL",
] as const

export interface ShellExecutionContext {
  ask: ToolContext["ask"]
  abort: AbortSignal
  worktree: string
  directory: string
}

export interface ShellExecutionResult {
  ok: boolean
  exit_code: number
  stdout_tail: string
  stderr_tail: string
  timed_out?: boolean
  cancelled?: boolean
  termination_failed?: boolean
  cwd: string
}

export interface WindowsTreeTerminationResult {
  confirmed: boolean
  detail?: string
}

export interface WindowsProcessRecord {
  pid: number
  parent_pid: number
  depth: number
}

export interface WindowsProcessSnapshot extends WindowsTreeTerminationResult {
  processes: WindowsProcessRecord[]
}

export interface ShellProcessControl {
  terminationPlatform?: "win32" | "posix"
  terminationGraceMs?: number
  runWindowsTaskkill?: (pid: number, environment: NodeJS.ProcessEnv) => Promise<void>
  runWindowsProcessTreeSnapshot?: (
    pid: number,
    environment: NodeJS.ProcessEnv,
    helperTimeoutMs: number,
  ) => Promise<WindowsProcessSnapshot>
  runWindowsProcessTreeFallback?: (
    pid: number,
    environment: NodeJS.ProcessEnv,
    helperTimeoutMs: number,
    snapshot?: WindowsProcessRecord[],
  ) => Promise<WindowsTreeTerminationResult>
  /** Test seam; production derives this from the native Job Object readiness file. */
  windowsJobObjectReady?: () => boolean
  runWindowsJobObjectTerminate?: (
    name: string,
    environment: NodeJS.ProcessEnv,
    helperTimeoutMs: number,
  ) => Promise<WindowsTreeTerminationResult>
}

interface WindowsJobObjectProof {
  ready: boolean
  name?: string
  helperPath?: string
  controlRequestPath?: string
  controlResultPath?: string
}

const WINDOWS_JOB_HELPER_SOURCE = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
public static class AlgJobHelper {
  [StructLayout(LayoutKind.Sequential)] public struct Basic { public long A; public long B; public uint Flags; public UIntPtr Min; public UIntPtr Max; public uint Active; public IntPtr Affinity; public uint Priority; public uint Scheduling; }
  [StructLayout(LayoutKind.Sequential)] public struct Io { public ulong A; public ulong B; public ulong C; public ulong D; public ulong E; public ulong F; }
  [StructLayout(LayoutKind.Sequential)] public struct Extended { public Basic Basic; public Io Io; public UIntPtr A; public UIntPtr B; public UIntPtr C; public UIntPtr D; }
  [StructLayout(LayoutKind.Sequential)] public struct Accounting { public long A; public long B; public long C; public long D; public uint Faults; public uint Total; public uint Active; public uint Terminated; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a, string n);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint a, bool i, string n);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr h, int c, IntPtr p, uint l);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr h, uint c);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr h, int c, IntPtr p, uint l, IntPtr r);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static int Fail(Exception e) { Console.Error.WriteLine(e.ToString()); return 125; }
  static int Run(string name, string controlReady, string ready, string script, string cwd) {
    IntPtr job = CreateJobObject(IntPtr.Zero, name); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    Extended info = new Extended(); info.Basic.Flags = 0x00002000; int size = Marshal.SizeOf(typeof(Extended)); IntPtr ptr = Marshal.AllocHGlobal(size);
    try { Marshal.StructureToPtr(info, ptr, false); if (!SetInformationJobObject(job, 9, ptr, (uint)size)) throw new Win32Exception(Marshal.GetLastWin32Error()); } finally { Marshal.FreeHGlobal(ptr); }
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception(Marshal.GetLastWin32Error());
    DateTime watcherEnd = DateTime.UtcNow.AddMilliseconds(45000);
    while (!File.Exists(controlReady)) { if (DateTime.UtcNow >= watcherEnd) throw new TimeoutException("Prepared watcher readiness deadline reached"); Thread.Sleep(10); }
    ProcessStartInfo start = new ProcessStartInfo(Environment.GetEnvironmentVariable("ComSpec")); start.UseShellExecute = false; start.WorkingDirectory = cwd; start.Arguments = "/d /s /c call \"" + script + "\"";
    using (Process child = Process.Start(start)) { File.WriteAllText(ready, "ready"); child.WaitForExit(); return child.ExitCode; }
  }
  static int Terminate(string name, int timeout) {
    IntPtr job = OpenJobObject(0x000C, false, name); if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      int size = Marshal.SizeOf(typeof(Accounting)); IntPtr ptr = Marshal.AllocHGlobal(size);
      try { DateTime end = DateTime.UtcNow.AddMilliseconds(timeout); while (true) { if (!TerminateJobObject(job, 1)) { int e = Marshal.GetLastWin32Error(); throw new Win32Exception(e, "TerminateJobObject failed during verification"); } if (!QueryInformationJobObject(job, 1, ptr, (uint)size, IntPtr.Zero)) { int e = Marshal.GetLastWin32Error(); throw new Win32Exception(e, "QueryInformationJobObject failed during verification"); } Accounting a = (Accounting)Marshal.PtrToStructure(ptr, typeof(Accounting)); if (a.Active == 0) return 0; if (DateTime.UtcNow >= end) throw new TimeoutException("Job Object verification deadline reached with ActiveProcesses=" + a.Active); Thread.Sleep(20); } } finally { Marshal.FreeHGlobal(ptr); }
    } finally { CloseHandle(job); }
  }
  static int Watch(string name, string request, string ready, string result, int readinessDelay) {
    if (readinessDelay > 0) Thread.Sleep(readinessDelay);
    DateTime openEnd = DateTime.UtcNow.AddMilliseconds(45000); IntPtr job = IntPtr.Zero;
    while (job == IntPtr.Zero && DateTime.UtcNow < openEnd) { job = OpenJobObject(0x000C, false, name); if (job == IntPtr.Zero) Thread.Sleep(20); }
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error(), "Watcher could not open Job Object");
    File.WriteAllText(ready, "ready"); DateTime requestEnd = DateTime.UtcNow.AddMilliseconds(620000);
    while (!File.Exists(request)) { if (DateTime.UtcNow >= requestEnd) throw new TimeoutException("Watcher request deadline reached"); Thread.Sleep(20); }
    CloseHandle(job);
    try { int code = Terminate(name, 15000); File.WriteAllText(result, "ok"); return code; }
    catch (Exception e) { File.WriteAllText(result, "error:" + e.ToString()); throw; }
  }
  public static int Main(string[] args) { try { if (args.Length == 6 && args[0] == "run") return Run(args[1], args[2], args[3], args[4], args[5]); if (args.Length == 3 && args[0] == "terminate") return Terminate(args[1], Int32.Parse(args[2])); if (args.Length == 6 && args[0] == "watch") return Watch(args[1], args[2], args[3], args[4], Int32.Parse(args[5])); throw new ArgumentException("invalid helper arguments"); } catch (Exception e) { return Fail(e); } }
}
`

/** Legacy predictable location retained only so regression tests can poison it. */
export function windowsJobHelperCachePath(environment: NodeJS.ProcessEnv = controlledShellEnvironment()): string {
  return join(environment.TEMP || environment.TMP || tmpdir(), "opencode-alg-job-helper-v12.exe")
}

let windowsJobHelperPromise: Promise<string> | undefined
let windowsJobHelperCompileCount = 0
const WINDOWS_HELPER_DIRECTORY = /^opencode-alg-job-helper-v13-(\d{1,10})-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const WINDOWS_HELPER_MARKER = ".opencode-alg-owner.json"
const WINDOWS_HELPER_MARKER_LIMIT = 2_048
const WINDOWS_HELPER_IDLE_MS = 1_500
const WINDOWS_HELPER_JANITOR_AGE_MS = 60_000
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,7}Z$/

interface FileIdentity { dev: string; ino: string }
interface WindowsHelperOwnedFile extends FileIdentity {
  file: string
  sha256: string
  size: number
}
interface WindowsHelperOwnerMarker {
  schema: "opencode-alg-windows-helper-owner"
  schema_version: 1
  token: string
  pid: number
  process_start_identity: string
  process_start_time: string
  created_at: string
  helper: WindowsHelperOwnedFile
  source: WindowsHelperOwnedFile
}
interface WindowsHelperLifecycle {
  directory: string
  directoryIdentity: FileIdentity
  markerPath: string
  markerIdentity: FileIdentity
  markerBytes: Buffer
  marker: WindowsHelperOwnerMarker
  helperPath: string
  sourcePath: string
}

type WindowsHelperBuildStage = "source-recorded" | "helper-recorded" | "marker-recorded"
interface WindowsHelperBuildFaultContext {
  directory: string
  helperPath: string
  sourcePath: string
  markerPath: string
}
type WindowsHelperBuildFault = (stage: WindowsHelperBuildStage, context: WindowsHelperBuildFaultContext) => void

let windowsHelperLifecycle: WindowsHelperLifecycle | undefined
let windowsHelperUsers = 0
let windowsHelperChildren = 0
let windowsHelperIdleTimer: ReturnType<typeof setTimeout> | undefined
let windowsHelperJanitorRan = false
let windowsOwnerStartIdentity: string | undefined

function fileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true })
  return { dev: String(stat.dev), ino: String(stat.ino) }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function helperFileHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function captureWindowsHelperFile(path: string, file = basename(path)): WindowsHelperOwnedFile {
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`Windows helper artifact is redirected or not regular: ${path}`)
  const bytes = readFileSync(path)
  const after = lstatSync(path, { bigint: true })
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino ||
    before.size !== after.size || before.mode !== after.mode || before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs || BigInt(bytes.byteLength) !== before.size) {
    throw new Error(`Windows helper artifact changed during identity capture: ${path}`)
  }
  return {
    file,
    sha256: helperFileHash(bytes),
    size: bytes.byteLength,
    dev: before.dev.toString(),
    ino: before.ino.toString(),
  }
}

function validWindowsHelperOwnedFile(value: unknown): value is WindowsHelperOwnedFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return exactKeys(record, ["file", "sha256", "size", "dev", "ino"]) &&
    typeof record.file === "string" && record.file === basename(record.file) && record.file.length <= 128 &&
    typeof record.sha256 === "string" && /^[a-f0-9]{64}$/.test(record.sha256) &&
    Number.isSafeInteger(record.size) && Number(record.size) >= 0 && Number(record.size) <= 16 * 1024 * 1024 &&
    typeof record.dev === "string" && /^\d+$/.test(record.dev) &&
    typeof record.ino === "string" && /^\d+$/.test(record.ino)
}

function exactWindowsHelperFile(directory: string, expected: WindowsHelperOwnedFile): boolean {
  try {
    const observed = captureWindowsHelperFile(join(directory, expected.file), expected.file)
    return JSON.stringify(observed) === JSON.stringify(expected)
  } catch {
    return false
  }
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort())
}

function processStartIdentity(pid: number, environment: NodeJS.ProcessEnv): { state: "alive" | "dead" | "ambiguous"; identity?: string } {
  if (pid === process.pid && windowsOwnerStartIdentity) return { state: "alive", identity: windowsOwnerStartIdentity }
  try {
    process.kill(pid, 0)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return { state: "dead" }
    return { state: "ambiguous" }
  }
  const systemRoot = environment.SystemRoot || environment.WINDIR || "C:\\Windows"
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  if (!existsSync(powershell)) return { state: "ambiguous" }
  const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($null -eq $p){exit 3}; [Console]::Out.Write($p.StartTime.ToUniversalTime().ToString('o'))`
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, encoding: "utf8", timeout: 5_000, maxBuffer: 4_096, env: environment,
    })
    if (result.status === 3) return { state: "dead" }
    const identity = result.status === 0 ? result.stdout.trim() : ""
    if (identity && ISO_UTC.test(identity)) {
      if (pid === process.pid) windowsOwnerStartIdentity = identity
      return { state: "alive", identity }
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * (attempt + 1))
  }
  return { state: "ambiguous" }
}

function parseOwnedHelper(directory: string): WindowsHelperLifecycle | undefined {
  const match = WINDOWS_HELPER_DIRECTORY.exec(basename(directory))
  if (!match) return undefined
  try {
    const directoryStat = lstatSync(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return undefined
    const markerPath = join(directory, WINDOWS_HELPER_MARKER)
    const markerStat = lstatSync(markerPath, { bigint: true })
    if (!markerStat.isFile() || markerStat.isSymbolicLink() || markerStat.size <= 0n || markerStat.size > BigInt(WINDOWS_HELPER_MARKER_LIMIT)) return undefined
    const markerBytes = readFileSync(markerPath)
    const markerAfter = lstatSync(markerPath, { bigint: true })
    if (markerStat.dev !== markerAfter.dev || markerStat.ino !== markerAfter.ino || markerStat.size !== markerAfter.size ||
      markerStat.mode !== markerAfter.mode || markerStat.mtimeNs !== markerAfter.mtimeNs || markerStat.ctimeNs !== markerAfter.ctimeNs ||
      BigInt(markerBytes.byteLength) !== markerStat.size) return undefined
    const value: unknown = JSON.parse(markerBytes.toString("utf8"))
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const marker = value as Record<string, unknown>
    if (!exactKeys(marker, ["schema", "schema_version", "token", "pid", "process_start_identity", "process_start_time", "created_at", "helper", "source"]) ||
      marker.schema !== "opencode-alg-windows-helper-owner" || marker.schema_version !== 1 ||
      typeof marker.token !== "string" || marker.token.toLowerCase() !== match[2]!.toLowerCase() ||
      !Number.isSafeInteger(marker.pid) || marker.pid !== Number(match[1]) ||
      typeof marker.process_start_identity !== "string" || !ISO_UTC.test(marker.process_start_identity) ||
      typeof marker.process_start_time !== "string" || marker.process_start_time !== marker.process_start_identity ||
      typeof marker.created_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(marker.created_at) ||
      !validWindowsHelperOwnedFile(marker.helper) || marker.helper.file !== `helper-${marker.token}.exe` ||
      !validWindowsHelperOwnedFile(marker.source) || marker.source.file !== `source-${marker.token}.cs`) return undefined
    const typed = marker as unknown as WindowsHelperOwnerMarker
    if (!exactWindowsHelperFile(directory, typed.helper) || !exactWindowsHelperFile(directory, typed.source)) return undefined
    const names = readdirSync(directory).sort()
    if (JSON.stringify(names) !== JSON.stringify([WINDOWS_HELPER_MARKER, typed.helper.file, typed.source.file].sort())) return undefined
    return {
      directory, directoryIdentity: fileIdentity(directory), markerPath, markerIdentity: fileIdentity(markerPath), markerBytes,
      marker: typed, helperPath: join(directory, typed.helper.file), sourcePath: join(directory, typed.source.file),
    }
  } catch {
    return undefined
  }
}

function ownedHelperSnapshot(environment: NodeJS.ProcessEnv = controlledShellEnvironment()): WindowsHelperLifecycle[] {
  const root = environment.TEMP || environment.TMP || tmpdir()
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && WINDOWS_HELPER_DIRECTORY.test(entry.name))
      .map((entry) => parseOwnedHelper(join(root, entry.name)))
      .filter((value): value is WindowsHelperLifecycle => value !== undefined)
      .slice(0, 256)
  } catch {
    return []
  }
}

export function windowsShellHelperArtifactSnapshot(environment: NodeJS.ProcessEnv = controlledShellEnvironment()): string[] {
  return ownedHelperSnapshot(environment).map((value) => value.directory).sort()
}

export interface WindowsShellHelperCleanupOptions {
  environment?: NodeJS.ProcessEnv
  candidates?: string[]
  minimumAgeMs?: number
  includeCurrent?: boolean
  beforeDelete?: (directory: string) => void
  beforeFileDelete?: (path: string) => void
  ownerProcessState?: (pid: number, environment: NodeJS.ProcessEnv) => { state: "alive" | "dead" | "ambiguous"; identity?: string }
}

function exactOwnedLifecycle(value: WindowsHelperLifecycle): boolean {
  try {
    if (!sameFileIdentity(fileIdentity(value.directory), value.directoryIdentity) ||
      !sameFileIdentity(fileIdentity(value.markerPath), value.markerIdentity) ||
      !readFileSync(value.markerPath).equals(value.markerBytes) ||
      !exactWindowsHelperFile(value.directory, value.marker.helper) ||
      !exactWindowsHelperFile(value.directory, value.marker.source)) return false
    const names = readdirSync(value.directory).sort()
    return JSON.stringify(names) === JSON.stringify([WINDOWS_HELPER_MARKER, value.marker.helper.file, value.marker.source.file].sort())
  } catch {
    return false
  }
}

function deleteOwnedLifecycle(
  value: WindowsHelperLifecycle,
  beforeDelete?: (directory: string) => void,
  beforeFileDelete?: (path: string) => void,
): boolean {
  if (!exactOwnedLifecycle(value)) return false
  beforeDelete?.(value.directory)
  if (!exactOwnedLifecycle(value)) return false
  const deadline = Date.now() + 3_000
  let pause = 20
  const remaining = [value.marker.source, value.marker.helper]
  const hooked = new Set<string>()
  let markerRemaining = true
  while (Date.now() <= deadline) {
    try {
      if (!sameFileIdentity(fileIdentity(value.directory), value.directoryIdentity)) return false
      const expectedNames = [
        ...(markerRemaining ? [WINDOWS_HELPER_MARKER] : []),
        ...remaining.map((record) => record.file),
      ].sort()
      if (JSON.stringify(readdirSync(value.directory).sort()) !== JSON.stringify(expectedNames)) return false
      if (markerRemaining && (!sameFileIdentity(fileIdentity(value.markerPath), value.markerIdentity) || !readFileSync(value.markerPath).equals(value.markerBytes))) return false
      if (remaining.some((record) => !exactWindowsHelperFile(value.directory, record))) return false
      const next = remaining[0]
      if (next) {
        const path = join(value.directory, next.file)
        if (!hooked.has(path)) {
          hooked.add(path)
          beforeFileDelete?.(path)
        }
        if (!exactWindowsHelperFile(value.directory, next)) return false
        unlinkSync(path)
        remaining.shift()
        continue
      }
      if (markerRemaining) {
        if (!sameFileIdentity(fileIdentity(value.markerPath), value.markerIdentity) || !readFileSync(value.markerPath).equals(value.markerBytes)) return false
        unlinkSync(value.markerPath)
        markerRemaining = false
        continue
      }
      if (!sameFileIdentity(fileIdentity(value.directory), value.directoryIdentity) || readdirSync(value.directory).length !== 0) return false
      rmdirSync(value.directory)
      return !existsSync(value.directory)
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pause)
      pause = Math.min(320, pause * 2)
    }
  }
  return false
}

/** Bounded, identity-checked cleanup used by idle handling and release verification. */
export function cleanupWindowsShellHelpers(options: WindowsShellHelperCleanupOptions = {}): { removed: string[]; preserved: string[] } {
  if (process.platform !== "win32") return { removed: [], preserved: [] }
  const environment = options.environment ?? controlledShellEnvironment()
  const candidates = options.candidates ? new Set(options.candidates.map((path) => resolve(path))) : undefined
  const minimumAgeMs = options.minimumAgeMs ?? WINDOWS_HELPER_JANITOR_AGE_MS
  const removed: string[] = []; const preserved: string[] = []
  for (const value of ownedHelperSnapshot(environment)) {
    if (candidates && !candidates.has(resolve(value.directory))) continue
    const current = windowsHelperLifecycle?.directory === value.directory
    if (current && (!options.includeCurrent || windowsHelperUsers !== 0 || windowsHelperChildren !== 0)) { preserved.push(value.directory); continue }
    const created = Date.parse(value.marker.created_at)
    if (!Number.isFinite(created) || Date.now() - created < minimumAgeMs) { preserved.push(value.directory); continue }
    if (!current) {
      const owner = (options.ownerProcessState ?? processStartIdentity)(value.marker.pid, environment)
      if (owner.state === "ambiguous" || owner.state === "alive" && owner.identity === value.marker.process_start_identity) { preserved.push(value.directory); continue }
    }
    if (deleteOwnedLifecycle(value, options.beforeDelete, options.beforeFileDelete)) {
      removed.push(value.directory)
      if (current && windowsHelperLifecycle === value || current && windowsHelperLifecycle?.directory === value.directory) {
        windowsHelperLifecycle = undefined
        windowsJobHelperPromise = undefined
      }
    } else preserved.push(value.directory)
  }
  return { removed, preserved }
}

function scheduleWindowsHelperIdleCleanup(): void {
  if (windowsHelperIdleTimer) clearTimeout(windowsHelperIdleTimer)
  if (!windowsHelperLifecycle || windowsHelperUsers !== 0 || windowsHelperChildren !== 0) return
  windowsHelperIdleTimer = setTimeout(() => {
    windowsHelperIdleTimer = undefined
    if (!windowsHelperLifecycle || windowsHelperUsers !== 0 || windowsHelperChildren !== 0) return
    cleanupWindowsShellHelpers({ candidates: [windowsHelperLifecycle.directory], minimumAgeMs: 0, includeCurrent: true })
  }, WINDOWS_HELPER_IDLE_MS)
  windowsHelperIdleTimer.unref?.()
}

function acquireWindowsHelper(): () => void {
  if (windowsHelperIdleTimer) { clearTimeout(windowsHelperIdleTimer); windowsHelperIdleTimer = undefined }
  windowsHelperUsers += 1
  let released = false
  return () => { if (released) return; released = true; windowsHelperUsers -= 1; scheduleWindowsHelperIdleCleanup() }
}

function trackWindowsHelperChild(child: ChildProcess): void {
  windowsHelperChildren += 1
  let done = false
  const finish = () => { if (done) return; done = true; windowsHelperChildren -= 1; scheduleWindowsHelperIdleCleanup() }
  child.once("error", finish)
  child.once("close", finish)
}

function bestEffortWindowsHelperCleanup(): void {
  if (windowsHelperUsers === 0 && windowsHelperChildren === 0 && windowsHelperLifecycle) {
    cleanupWindowsShellHelpers({ candidates: [windowsHelperLifecycle.directory], minimumAgeMs: 0, includeCurrent: true })
  }
}

process.once("beforeExit", bestEffortWindowsHelperCleanup)
process.once("exit", bestEffortWindowsHelperCleanup)

/** Test evidence for same-process compile-once behavior; no stable executable path is accepted as input. */
export function windowsJobHelperBuildState(): { compileCount: number; helperPath?: string } {
  return {
    compileCount: windowsJobHelperCompileCount,
    ...(windowsHelperLifecycle?.helperPath ? { helperPath: windowsHelperLifecycle.helperPath } : {}),
  }
}

function assertCurrentWindowsHelper(path: string): WindowsHelperLifecycle {
  const current = windowsHelperLifecycle
  if (!current || resolve(current.helperPath) !== resolve(path)) throw new Error("Windows Job helper lifecycle is unavailable")
  const observed = parseOwnedHelper(current.directory)
  if (!observed || !sameFileIdentity(observed.directoryIdentity, current.directoryIdentity) ||
    !sameFileIdentity(observed.markerIdentity, current.markerIdentity) || !observed.markerBytes.equals(current.markerBytes) ||
    resolve(observed.helperPath) !== resolve(current.helperPath) || resolve(observed.sourcePath) !== resolve(current.sourcePath)) {
    throw new Error("Windows Job helper manifest, executable, or source identity changed")
  }
  return observed
}

async function ensureWindowsJobHelper(environment: NodeJS.ProcessEnv, buildFault?: WindowsHelperBuildFault): Promise<string> {
  if (!windowsHelperJanitorRan) {
    windowsHelperJanitorRan = true
    cleanupWindowsShellHelpers({ environment })
  }
  if (windowsHelperLifecycle) return assertCurrentWindowsHelper(windowsHelperLifecycle.helperPath).helperPath
  if (windowsJobHelperPromise) {
    const path = await windowsJobHelperPromise
    return assertCurrentWindowsHelper(path).helperPath
  }
  windowsJobHelperPromise = buildWindowsJobHelper(environment, buildFault)
  try {
    const path = await windowsJobHelperPromise
    return assertCurrentWindowsHelper(path).helperPath
  } catch (error) {
    windowsJobHelperPromise = undefined
    throw error
  }
}

function cleanupFailedWindowsHelperBuild(options: {
  directory: string
  directoryIdentity: FileIdentity
  files: WindowsHelperOwnedFile[]
  markerPath: string
  markerIdentity?: FileIdentity
  markerBytes?: Buffer
}): void {
  try {
    if (!sameFileIdentity(fileIdentity(options.directory), options.directoryIdentity)) return
    for (const file of options.files) {
      const path = join(options.directory, file.file)
      if (existsSync(path) && exactWindowsHelperFile(options.directory, file)) unlinkSync(path)
    }
    if (options.markerIdentity && options.markerBytes && existsSync(options.markerPath) &&
      sameFileIdentity(fileIdentity(options.markerPath), options.markerIdentity) &&
      readFileSync(options.markerPath).equals(options.markerBytes)) unlinkSync(options.markerPath)
    if (sameFileIdentity(fileIdentity(options.directory), options.directoryIdentity) && readdirSync(options.directory).length === 0) {
      rmdirSync(options.directory)
    }
  } catch {
    // Any lock, replacement, unexpected entry, or identity ambiguity preserves
    // the remainder for manual inspection; no recursive/force cleanup is used.
  }
}

async function buildWindowsJobHelper(environment: NodeJS.ProcessEnv, buildFault?: WindowsHelperBuildFault): Promise<string> {
  const root = environment.TEMP || environment.TMP || tmpdir()
  const owner = processStartIdentity(process.pid, environment)
  if (owner.state !== "alive" || !owner.identity) throw new Error("Windows Job helper owner process-start identity is unavailable")
  const token = randomUUID()
  const directory = join(root, `opencode-alg-job-helper-v13-${process.pid}-${token}`)
  mkdirSync(directory, { mode: 0o700 })
  try { chmodSync(directory, 0o700) } catch { /* Windows relies on the private TEMP ACL. */ }
  const directoryIdentity = fileIdentity(directory)
  const target = join(directory, `helper-${token}.exe`)
  const sourcePath = join(directory, `source-${token}.cs`)
  const markerPath = join(directory, WINDOWS_HELPER_MARKER)
  const systemRoot = environment.SystemRoot || environment.WINDIR || "C:\\Windows"
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  const recordedFiles: WindowsHelperOwnedFile[] = []
  let markerBytes: Buffer | undefined
  let markerIdentity: FileIdentity | undefined
  const faultContext = { directory, helperPath: target, sourcePath, markerPath }
  try {
    writeFileSync(sourcePath, WINDOWS_JOB_HELPER_SOURCE, { encoding: "utf8", flag: "wx", mode: 0o600 })
    const source = captureWindowsHelperFile(sourcePath)
    recordedFiles.push(source)
    buildFault?.("source-recorded", faultContext)
    const cscCandidates = [
      join(systemRoot, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
      join(systemRoot, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    ]
    const csc = cscCandidates.find((candidate) => existsSync(candidate))
    if (!csc && !existsSync(powershell)) throw new Error("Windows C# compiler is unavailable")
    windowsJobHelperCompileCount += 1
    const compilerCommand = csc ?? powershell
    const compilerArgs = csc
      ? ["/nologo", "/target:exe", `/out:${target}`, sourcePath]
      : ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `Add-Type -Path $env:ALG_JOB_HELPER_SOURCE_PATH -OutputAssembly $env:ALG_JOB_HELPER_OUTPUT -OutputType ConsoleApplication`]
    await new Promise<void>((resolveBuild, rejectBuild) => {
      let settled = false
      const compiler = spawn(compilerCommand, compilerArgs, {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...environment, ALG_JOB_HELPER_SOURCE_PATH: sourcePath, ALG_JOB_HELPER_OUTPUT: target },
      })
      trackWindowsHelperChild(compiler)
      let error = ""
      compiler.stderr?.on("data", (chunk: Buffer) => { error = `${error}${chunk.toString("utf8")}`.slice(-2_000) })
      const finish = (failure?: Error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        failure ? rejectBuild(failure) : resolveBuild()
      }
      const timer = setTimeout(() => {
        void (compiler.pid
          ? defaultWindowsTaskkill(compiler.pid, environment, 2_000)
          : Promise.resolve()).finally(() => finish(new Error("Windows Job helper compilation timed out after 45000 ms")))
      }, 45_000)
      compiler.once("error", (failure) => finish(failure))
      compiler.once("close", (code) => finish(code === 0 && existsSync(target)
        ? undefined
        : new Error(error || `Windows Job helper compiler exited ${code}`)))
    })
    try { chmodSync(target, 0o700) } catch { /* Windows relies on the private TEMP ACL. */ }
    const helper = captureWindowsHelperFile(target)
    recordedFiles.push(helper)
    buildFault?.("helper-recorded", faultContext)
    const marker: WindowsHelperOwnerMarker = {
      schema: "opencode-alg-windows-helper-owner", schema_version: 1, token, pid: process.pid,
      process_start_identity: owner.identity, process_start_time: owner.identity, created_at: new Date().toISOString(),
      helper,
      source,
    }
    markerBytes = Buffer.from(`${JSON.stringify(marker)}\n`)
    writeFileSync(markerPath, markerBytes, { flag: "wx", mode: 0o600 })
    try { chmodSync(markerPath, 0o600) } catch { /* Windows relies on the private TEMP ACL. */ }
    markerIdentity = fileIdentity(markerPath)
    buildFault?.("marker-recorded", faultContext)
    windowsHelperLifecycle = {
      directory,
      directoryIdentity,
      markerPath,
      markerIdentity,
      markerBytes,
      marker,
      helperPath: target,
      sourcePath,
    }
    assertCurrentWindowsHelper(target)
    return target
  } catch (error) {
    if (windowsHelperLifecycle?.directory === directory) windowsHelperLifecycle = undefined
    cleanupFailedWindowsHelperBuild({ directory, directoryIdentity, files: recordedFiles, markerPath, markerIdentity, markerBytes })
    throw error
  }
}

function windowsJobLauncher(
  command: string,
  environment: NodeJS.ProcessEnv,
  helperPath: string,
  cwd: string,
): { executable: string; args: string[]; environment: NodeJS.ProcessEnv; readyPath: string; jobName: string; scriptPath: string; controlRequestPath: string; controlReadyPath: string; controlResultPath: string } {
  assertCurrentWindowsHelper(helperPath)
  const readyPath = join(environment.TEMP || environment.TMP || tmpdir(), `alg-job-${process.pid}-${randomUUID()}.ready`)
  const scriptPath = join(environment.TEMP || environment.TMP || tmpdir(), `alg-command-${process.pid}-${randomUUID()}.cmd`)
  const jobName = `Local\\OpenCodeALG-${randomUUID()}`
  const controlRequestPath = join(environment.TEMP || environment.TMP || tmpdir(), `alg-job-control-${randomUUID()}.request`)
  const controlReadyPath = `${controlRequestPath}.ready`
  const controlResultPath = `${controlRequestPath}.result`
  writeFileSync(scriptPath, `@echo off\r\n${command}\r\n`, "utf8")
  return {
    executable: helperPath,
    args: ["run", jobName, controlReadyPath, readyPath, scriptPath, cwd],
    environment,
    readyPath,
    jobName,
    scriptPath,
    controlRequestPath,
    controlReadyPath,
    controlResultPath,
  }
}

class ByteTail {
  private value: Buffer<ArrayBufferLike> = Buffer.alloc(0)

  push(chunk: Uint8Array | string): void {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (incoming.length >= SHELL_TAIL_BYTES) {
      this.value = incoming.subarray(incoming.length - SHELL_TAIL_BYTES)
      return
    }
    const keep = Math.max(0, SHELL_TAIL_BYTES - incoming.length)
    this.value = Buffer.concat([this.value.subarray(Math.max(0, this.value.length - keep)), incoming])
  }

  text(): string {
    return this.value.toString("utf8")
  }
}

export function controlledShellEnvironment(source = process.env): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  const entries = Object.entries(source)
  for (const allowed of ALG_SHELL_ENV_ALLOWLIST) {
    const match = entries.find(([key]) =>
      process.platform === "win32" ? key.toLowerCase() === allowed.toLowerCase() : key === allowed,
    )
    if (match?.[1] !== undefined) result[allowed] = match[1]
  }
  // Keep command lookup functional without broadening the environment contract.
  // The inherited PATH is allowlisted; prepending the host runtime directory also
  // supports minimal PATH inputs and Bun/Node-adjacent command shims.
  const inheritedPath = result.PATH ?? ""
  const inheritedParts = inheritedPath.split(delimiter).filter(Boolean)
  const systemRoot = result.SystemRoot || result.WINDIR
  const priority = [
    dirname(process.execPath),
    ...(systemRoot ? [join(systemRoot, "System32"), systemRoot] : []),
  ]
  // Bun package scripts can duplicate enough PATH entries to overflow Windows'
  // environment block. Locate essential JS runtimes before applying a hard cap.
  const runtimeNames = process.platform === "win32"
    ? ["node.exe", "npm.cmd", "bun.exe"]
    : ["node", "npm", "bun"]
  for (const part of inheritedParts) {
    if (runtimeNames.some((name) => existsSync(join(part, name)))) priority.push(part)
  }

  const pathParts: string[] = []
  const seen = new Set<string>()
  for (const part of [...priority, ...inheritedParts]) {
    const key = process.platform === "win32" ? part.toLowerCase() : part
    if (seen.has(key) || !existsSync(part)) continue
    const candidate = [...pathParts, part].join(delimiter)
    if (candidate.length > MAX_CONTROLLED_PATH_CHARS) continue
    seen.add(key)
    pathParts.push(part)
  }
  result.PATH = pathParts.join(delimiter)
  return result
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

async function defaultWindowsTaskkill(
  pid: number,
  environment: NodeJS.ProcessEnv,
  graceMs: number,
): Promise<void> {
  const systemRoot = environment.SystemRoot || environment.WINDIR || "C:\\Windows"
  await new Promise<void>((resolveTaskkill) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveTaskkill()
    }
    let killer: ReturnType<typeof spawn>
    try {
      killer = spawn(join(systemRoot, "System32", "taskkill.exe"), ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        env: environment,
      })
    } catch {
      resolveTaskkill()
      return
    }
    const timer = setTimeout(() => {
      try {
        killer.kill("SIGKILL")
      } catch {
        // best effort
      }
      finish()
    }, graceMs)
    killer.once("error", finish)
    killer.once("close", finish)
  })
}

async function defaultWindowsJobObjectTerminate(
  name: string,
  environment: NodeJS.ProcessEnv,
  helperTimeoutMs: number,
  helperPath?: string,
): Promise<WindowsTreeTerminationResult> {
  if (helperPath) {
    return new Promise((resolveResult) => {
      let detail = ""; let settled = false
      let helper: ReturnType<typeof spawn>
      try {
        assertCurrentWindowsHelper(helperPath)
        helper = spawn(helperPath, ["terminate", name, String(Math.max(250, helperTimeoutMs - 250))], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"], env: environment })
      } catch (error) {
        resolveResult({ confirmed: false, detail: error instanceof Error ? error.message : String(error) })
        return
      }
      trackWindowsHelperChild(helper)
      const finish = (result: WindowsTreeTerminationResult) => { if (settled) return; settled = true; clearTimeout(timer); resolveResult(result) }
      helper.stderr?.on("data", (chunk: Buffer) => { detail = `${detail}${chunk.toString("utf8")}`.slice(-2_000) })
      const timer = setTimeout(() => { try { helper.kill("SIGKILL") } catch {} finish({ confirmed: false, detail: "native Windows Job helper timed out" }) }, helperTimeoutMs)
      helper.once("error", (error) => finish({ confirmed: false, detail: error.message }))
      helper.once("close", (code) => finish(code === 0 ? { confirmed: true } : { confirmed: false, detail: detail.trim() || `native Job helper exited ${code}` }))
    })
  }
  const release = acquireWindowsHelper()
  try {
    const ownedHelper = await ensureWindowsJobHelper(environment)
    return await defaultWindowsJobObjectTerminate(name, environment, helperTimeoutMs, ownedHelper)
  } catch (error) {
    return { confirmed: false, detail: `Windows Job Object termination helper is unavailable: ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    release()
  }
}

async function defaultWindowsProcessTreeSnapshot(
  pid: number,
  environment: NodeJS.ProcessEnv,
  helperTimeoutMs: number,
): Promise<WindowsProcessSnapshot> {
  const systemRoot = environment.SystemRoot || environment.WINDIR || "C:\\Windows"
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  if (!existsSync(powershell)) {
    return { confirmed: false, processes: [], detail: "Windows PowerShell process-tree snapshot helper is unavailable" }
  }
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$rootPid = [int]${pid}
$rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$depth = @{}
$depth[$rootPid] = 0
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($row in $rows) {
    $id = [int]$row.ProcessId
    $parent = [int]$row.ParentProcessId
    if ($depth.ContainsKey($parent) -and -not $depth.ContainsKey($id)) {
      $depth[$id] = [int]$depth[$parent] + 1
      $changed = $true
    }
  }
}
$result = @($depth.Keys | ForEach-Object {
  $id = [int]$_
  $row = $rows | Where-Object { [int]$_.ProcessId -eq $id } | Select-Object -First 1
  [pscustomobject]@{ pid = $id; parent_pid = $(if ($row) { [int]$row.ParentProcessId } else { 0 }); depth = [int]$depth[$id] }
})
Write-Output ($result | ConvertTo-Json -Compress)
exit 0
`
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  return new Promise((resolveResult) => {
    let helper: ReturnType<typeof spawn>
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (result: WindowsProcessSnapshot) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(result)
    }
    try {
      helper = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: environment,
      })
    } catch (error) {
      resolveResult({ confirmed: false, processes: [], detail: `snapshot helper spawn failed: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    helper.stdout?.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-64_000) })
    helper.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString("utf8")}`.slice(-2_000) })
    const timer = setTimeout(() => {
      try { helper.kill("SIGKILL") } catch { /* best effort */ }
      finish({ confirmed: false, processes: [], detail: "Windows process-tree snapshot helper timed out" })
    }, helperTimeoutMs)
    helper.once("error", (error) => finish({ confirmed: false, processes: [], detail: error.message }))
    helper.once("close", (code) => {
      if (code !== 0) {
        finish({ confirmed: false, processes: [], detail: stderr.trim() || `snapshot helper exited ${code ?? "unknown"}` })
        return
      }
      try {
        const parsed: unknown = JSON.parse(stdout.trim() || "[]")
        const values = Array.isArray(parsed) ? parsed : [parsed]
        const processes = values.map((value) => {
          const item = value as Record<string, unknown>
          const record = {
            pid: Number(item.pid),
            parent_pid: Number(item.parent_pid),
            depth: Number(item.depth),
          }
          if (!Number.isInteger(record.pid) || record.pid <= 0 || !Number.isInteger(record.parent_pid) || !Number.isInteger(record.depth) || record.depth < 0) {
            throw new Error("snapshot helper returned invalid process metadata")
          }
          return record
        })
        finish({ confirmed: processes.some((record) => record.pid === pid), processes })
      } catch (error) {
        finish({ confirmed: false, processes: [], detail: error instanceof Error ? error.message : String(error) })
      }
    })
  })
}

async function defaultWindowsProcessTreeFallback(
  pid: number,
  environment: NodeJS.ProcessEnv,
  helperTimeoutMs: number,
  snapshot: WindowsProcessRecord[] = [],
): Promise<WindowsTreeTerminationResult> {
  const systemRoot = environment.SystemRoot || environment.WINDIR || "C:\\Windows"
  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  if (!existsSync(powershell)) {
    return { confirmed: false, detail: "Windows PowerShell process-tree helper is unavailable" }
  }
  // CIM exposes Win32_Process parent IDs. Track the complete tree before killing,
  // terminate deepest-first, then re-enumerate/retry and verify every tracked PID.
  const seed = snapshot.length
    ? snapshot.map((record) => `[pscustomobject]@{ Id = [int]${record.pid}; Parent = [int]${record.parent_pid}; Depth = [int]${record.depth} }`).join(",")
    : `[pscustomobject]@{ Id = [int]${pid}; Parent = 0; Depth = 0 }`
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$rootPid = [int]${pid}
$depth = @{}
$tracked = New-Object 'System.Collections.Generic.HashSet[int]'
$seed = @(${seed})
foreach ($item in $seed) {
  $depth[[int]$item.Id] = [int]$item.Depth
  [void]$tracked.Add([int]$item.Id)
}
for ($round = 0; $round -lt 3; $round++) {
  $rows = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $changed = $true
  while ($changed) {
    $changed = $false
    foreach ($row in $rows) {
      $id = [int]$row.ProcessId
      $parent = [int]$row.ParentProcessId
      if ($depth.ContainsKey($parent) -and -not $depth.ContainsKey($id)) {
        $depth[$id] = [int]$depth[$parent] + 1
        [void]$tracked.Add($id)
        $changed = $true
      }
    }
  }
  $targets = @($tracked | ForEach-Object {
    [pscustomobject]@{ Id = [int]$_; Depth = [int]$depth[[int]$_] }
  } | Sort-Object Depth -Descending)
  foreach ($target in $targets) {
    Stop-Process -Id $target.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 100
  $alive = @($tracked | Where-Object { Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue })
  if ($alive.Count -eq 0) { exit 0 }
}
$remaining = @($tracked | Where-Object { Get-Process -Id ([int]$_) -ErrorAction SilentlyContinue })
Write-Error ("process-tree containment unconfirmed; remaining PIDs: " + ($remaining -join ','))
exit 3
`
  const encoded = Buffer.from(script, "utf16le").toString("base64")
  return new Promise((resolveResult) => {
    let helper: ReturnType<typeof spawn>
    let detail = ""
    let settled = false
    const finish = (result: WindowsTreeTerminationResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveResult(result)
    }
    try {
      helper = spawn(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        env: environment,
      })
    } catch (error) {
      resolveResult({ confirmed: false, detail: `process-tree helper spawn failed: ${error instanceof Error ? error.message : String(error)}` })
      return
    }
    helper.stderr?.on("data", (chunk: Buffer) => {
      detail = `${detail}${chunk.toString("utf8")}`.slice(-2_000)
    })
    const timer = setTimeout(() => {
      try {
        helper.kill("SIGKILL")
      } catch {
        // best effort; timeout is still reported as unconfirmed
      }
      finish({ confirmed: false, detail: "Windows process-tree helper timed out" })
    }, helperTimeoutMs)
    helper.once("error", (error) => finish({
      confirmed: false,
      detail: `process-tree helper failed: ${error.message}`,
    }))
    helper.once("close", (code) => finish(code === 0
      ? { confirmed: true }
      : { confirmed: false, detail: detail.trim() || `process-tree helper exited ${code ?? "unknown"}` }))
  })
}

async function terminateViaPreparedJobWatcher(
  proof: WindowsJobObjectProof,
  timeoutMs: number,
): Promise<WindowsTreeTerminationResult> {
  if (!proof.controlRequestPath || !proof.controlResultPath) {
    return { confirmed: false, detail: "prepared Job watcher paths are unavailable" }
  }
  try {
    writeFileSync(proof.controlRequestPath, "terminate", "utf8")
  } catch (error) {
    return { confirmed: false, detail: `Job watcher request failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(proof.controlResultPath)) {
      const result = readFileSync(proof.controlResultPath, "utf8")
      return result === "ok"
        ? { confirmed: true }
        : { confirmed: false, detail: result.startsWith("error:") ? result.slice(6) : `invalid Job watcher result: ${result}` }
    }
    await delay(10)
  }
  return { confirmed: false, detail: "prepared Windows Job watcher timed out" }
}

export async function terminateProcessTree(
  child: ReturnType<typeof spawn>,
  control: ShellProcessControl = {},
  windowsJobObject?: WindowsJobObjectProof,
): Promise<void> {
  if (!child.pid) return
  const graceMs = Math.max(50, Math.min(control.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS, 2_000))
  const platform = control.terminationPlatform ?? (process.platform === "win32" ? "win32" : "posix")
  if (platform === "win32") {
    const environment = controlledShellEnvironment()
    const helperTimeoutMs = Math.max(1_000, Math.min(5_000, graceMs * 3))
    const jobHelperTimeoutMs = Math.max(3_000, Math.min(15_000, graceMs * 15))
    let jobTermination: WindowsTreeTerminationResult
    if (windowsJobObject?.ready && windowsJobObject.name) {
      try {
        const operation = windowsJobObject.controlRequestPath && windowsJobObject.controlResultPath
          ? terminateViaPreparedJobWatcher(windowsJobObject, jobHelperTimeoutMs)
          : control.runWindowsJobObjectTerminate
          ? control.runWindowsJobObjectTerminate(windowsJobObject.name, environment, jobHelperTimeoutMs)
          : defaultWindowsJobObjectTerminate(windowsJobObject.name, environment, jobHelperTimeoutMs, windowsJobObject.helperPath)
        jobTermination = await Promise.race([
          Promise.resolve(operation).catch((error) => ({ confirmed: false, detail: error instanceof Error ? error.message : String(error) })),
          delay(jobHelperTimeoutMs).then(() => ({ confirmed: false, detail: "Windows Job Object termination exceeded its outer time bound" })),
        ])
      } catch (error) {
        jobTermination = { confirmed: false, detail: error instanceof Error ? error.message : String(error) }
      }
      // QueryInformationJobObject reported ActiveProcesses=0. The command and every
      // non-breakaway descendant were members before launch, so no ancestry race remains.
      if (jobTermination.confirmed) return
      try {
        const cleanup = control.runWindowsTaskkill
          ? control.runWindowsTaskkill(child.pid, environment)
          : defaultWindowsTaskkill(child.pid, environment, graceMs)
        await Promise.race([Promise.resolve(cleanup).catch(() => {}), delay(graceMs)])
      } catch {
        // best effort after native proof failed
      }
      try { child.kill("SIGKILL") } catch { /* best effort */ }
      throw new Error(jobTermination.detail || "Windows Job Object termination was not confirmed")
    } else if (!windowsJobObject?.ready) {
      try {
        const cleanup = control.runWindowsTaskkill
          ? control.runWindowsTaskkill(child.pid, environment)
          : defaultWindowsTaskkill(child.pid, environment, graceMs)
        await Promise.race([Promise.resolve(cleanup).catch(() => {}), delay(graceMs)])
      } catch {
        // best effort when setup proof is absent
      }
      try { child.kill("SIGKILL") } catch { /* best effort */ }
      throw new Error("Windows Job Object containment was not established before command launch")
    } else {
      // Unit tests may provide a proven synthetic job while production supplies a native name.
      jobTermination = { confirmed: true }
    }
    let snapshot: WindowsProcessSnapshot
    try {
      const operation = control.runWindowsProcessTreeSnapshot
        ? control.runWindowsProcessTreeSnapshot(child.pid, environment, helperTimeoutMs)
        : defaultWindowsProcessTreeSnapshot(child.pid, environment, helperTimeoutMs)
      snapshot = await Promise.race([
        Promise.resolve(operation).catch((error) => ({
          confirmed: false,
          processes: [],
          detail: error instanceof Error ? error.message : String(error),
        })),
        delay(helperTimeoutMs).then(() => ({
          confirmed: false,
          processes: [],
          detail: "Windows process-tree snapshot exceeded its outer time bound",
        })),
      ])
    } catch (error) {
      snapshot = { confirmed: false, processes: [], detail: error instanceof Error ? error.message : String(error) }
    }
    let taskkill: Promise<void>
    try {
      taskkill = control.runWindowsTaskkill
        ? control.runWindowsTaskkill(child.pid, environment)
        : defaultWindowsTaskkill(child.pid, environment, graceMs)
    } catch {
      taskkill = Promise.resolve()
    }
    // Give taskkill first chance to enumerate the still-live shell and descendants.
    await Promise.race([Promise.resolve(taskkill).catch(() => {}), delay(graceMs)])
    let fallback: WindowsTreeTerminationResult
    try {
      const operation = control.runWindowsProcessTreeFallback
        ? control.runWindowsProcessTreeFallback(child.pid, environment, helperTimeoutMs, snapshot.processes)
        : defaultWindowsProcessTreeFallback(child.pid, environment, helperTimeoutMs, snapshot.processes)
      fallback = await Promise.race([
        Promise.resolve(operation).catch((error) => ({
          confirmed: false,
          detail: error instanceof Error ? error.message : String(error),
        })),
        delay(helperTimeoutMs).then(() => ({
          confirmed: false,
          detail: "Windows process-tree helper exceeded its outer time bound",
        })),
      ])
    } catch (error) {
      fallback = { confirmed: false, detail: error instanceof Error ? error.message : String(error) }
    }
    // Direct root signals are last-resort cleanup only. Descendants were enumerated
    // before the root by the helper so they cannot be silently orphaned first.
    try {
      child.kill("SIGTERM")
    } catch {
      // best effort
    }
    try {
      child.kill("SIGKILL")
    } catch {
      // best effort
    }
    await delay(25)
    if (!jobTermination.confirmed || !snapshot.confirmed || !fallback.confirmed) {
      throw new Error([
        !jobTermination.confirmed ? jobTermination.detail || "Windows Job Object termination was not confirmed" : "",
        !snapshot.confirmed ? snapshot.detail || "pre-taskkill descendant snapshot was not confirmed" : "",
        !fallback.confirmed ? fallback.detail || "Windows process-tree containment could not be confirmed" : "",
      ].filter(Boolean).join("; "))
    }
    return
  }
  try {
    process.kill(-child.pid, "SIGTERM")
  } catch {
    child.kill("SIGTERM")
  }
  await delay(graceMs)
  try {
    process.kill(-child.pid!, "SIGKILL")
  } catch {
    try {
      child.kill("SIGKILL")
    } catch {
      // best effort
    }
  }
  const verificationDeadline = Date.now() + Math.max(250, graceMs)
  while (true) {
    try {
      process.kill(-child.pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return
    }
    if (Date.now() >= verificationDeadline) {
      throw new Error(`POSIX process group ${child.pid} termination could not be confirmed`)
    }
    await delay(25)
  }
}

export async function executeShellGate(options: {
  cmd: string
  cwd?: string
  timeoutMs?: number
  context: ShellExecutionContext
  metadata?: Record<string, unknown>
  processControl?: ShellProcessControl
  spawnProcess?: typeof spawn
  /** Test seam: production omits this and starts timing as soon as the job is ready. */
  timeoutReadiness?: () => boolean
  /** Test-only native handshake delay; production watcher readiness is immediate. */
  windowsJobWatcherReadyDelayMs?: number
  /** Test seam for proving identity-checked cleanup at Windows helper build stages. */
  windowsJobHelperBuildFault?: WindowsHelperBuildFault
}): Promise<ShellExecutionResult> {
  const cmd = options.cmd.trim()
  if (!cmd || cmd.length > 8_192) throw new Error("shell command must be 1..8192 characters")
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHELL_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_SHELL_TIMEOUT_MS) {
    throw new Error(`shell timeout must be between 100 and ${MAX_SHELL_TIMEOUT_MS} ms`)
  }
  const watcherReadyDelayMs = options.windowsJobWatcherReadyDelayMs ?? 0
  if (!Number.isSafeInteger(watcherReadyDelayMs) || watcherReadyDelayMs < 0 || watcherReadyDelayMs >= WINDOWS_JOB_READINESS_TIMEOUT_MS) {
    throw new Error(`Windows Job watcher readiness delay must be 0..${WINDOWS_JOB_READINESS_TIMEOUT_MS - 1} ms`)
  }

  const requested = options.cwd
    ? resolve(options.context.directory, options.cwd)
    : options.context.directory
  const cwd = canonicalContainedDirectory(options.context.worktree, requested)

  try {
    await options.context.ask({
      permission: "bash",
      patterns: [cmd],
      always: [],
      metadata: { alg: true, cwd, timeout_ms: timeoutMs, ...options.metadata },
    })
  } catch (error) {
    return {
      ok: false,
      exit_code: 126,
      stdout_tail: "",
      stderr_tail: `bash permission denied: ${error instanceof Error ? error.message : String(error)}`.slice(-SHELL_TAIL_BYTES),
      cwd,
    }
  }

  if (options.context.abort.aborted) {
    return {
      ok: false,
      exit_code: 130,
      stdout_tail: "",
      stderr_tail: "shell command cancelled before spawn",
      cancelled: true,
      cwd,
    }
  }

  const windows = process.platform === "win32"
  const environment = controlledShellEnvironment()
  let windowsJobHelper: string | undefined
  let releaseWindowsHelper: (() => void) | undefined
  if (windows && !options.spawnProcess) {
    releaseWindowsHelper = acquireWindowsHelper()
    try {
      windowsJobHelper = await ensureWindowsJobHelper(environment, options.windowsJobHelperBuildFault)
    } catch (error) {
      releaseWindowsHelper()
      return {
        ok: false,
        exit_code: 125,
        stdout_tail: "",
        stderr_tail: `Windows Job Object setup failed before command launch: ${error instanceof Error ? error.message : String(error)}`.slice(-SHELL_TAIL_BYTES),
        termination_failed: true,
        cwd,
      }
    }
  }

  return new Promise((resolveResult) => {
    const executable = windows
      ? environment.ComSpec || join(environment.SystemRoot || environment.WINDIR || "C:\\Windows", "System32", "cmd.exe")
      : environment.SHELL || "/bin/sh"
    const job = windows && !options.spawnProcess && windowsJobHelper
      ? windowsJobLauncher(cmd, environment, windowsJobHelper, cwd)
      : null
    const child = options.spawnProcess
      ? options.spawnProcess(cmd, [], {
          shell: executable,
          cwd,
          env: environment,
          windowsHide: true,
          detached: !windows,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : job
        ? spawn(job.executable, job.args, {
            cwd: environment.TEMP || environment.TMP || tmpdir(),
            env: job.environment,
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
        : spawn(cmd, [], {
            shell: executable,
            cwd,
            env: environment,
            windowsHide: true,
            detached: !windows,
            stdio: ["ignore", "pipe", "pipe"],
          })
    const jobController = job
      ? spawn(job.executable, ["watch", job.jobName, job.controlRequestPath, job.controlReadyPath, job.controlResultPath, String(watcherReadyDelayMs)], {
          cwd: environment.TEMP || environment.TMP || tmpdir(),
          env: job.environment,
          windowsHide: true,
          stdio: "ignore",
        })
      : undefined
    if (job) trackWindowsHelperChild(child)
    if (jobController) trackWindowsHelperChild(jobController)
    const stdout = new ByteTail()
    const stderr = new ByteTail()
    let settled = false
    let timedOut = false
    let cancelled = false
    let terminating = false
    let terminationFailed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let terminationChildError: string | undefined
    let terminationCloseCode: number | undefined
    let readinessTimer: ReturnType<typeof setInterval> | undefined

    const jobControlReady = () => options.processControl?.windowsJobObjectReady?.() ?? Boolean(
      job?.controlReadyPath && existsSync(job.controlReadyPath),
    )
    const commandReady = () => job ? existsSync(job.readyPath) : true

    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk))

    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (readinessTimer) clearInterval(readinessTimer)
      options.context.abort.removeEventListener("abort", onAbort)
      if (job?.readyPath) rmSync(job.readyPath, { force: true })
      if (job?.scriptPath) rmSync(job.scriptPath, { force: true })
      if (jobController?.exitCode === null) {
        try { jobController.kill("SIGKILL") } catch { /* best effort */ }
      }
      if (job) {
        rmSync(job.controlRequestPath, { force: true })
        rmSync(job.controlReadyPath, { force: true })
        rmSync(job.controlResultPath, { force: true })
      }
      releaseWindowsHelper?.()
      resolveResult({
        ok: exitCode === 0 && !timedOut && !cancelled && !terminationFailed,
        exit_code: timedOut ? 124 : cancelled ? 130 : exitCode,
        stdout_tail: stdout.text(),
        stderr_tail: stderr.text(),
        ...(timedOut ? { timed_out: true } : {}),
        ...(cancelled ? { cancelled: true } : {}),
        ...(terminationFailed ? { termination_failed: true } : {}),
        cwd,
      })
    }

    const requestTermination = () => {
      if (terminating) return
      terminating = true
      const drainTerminationEvents = async () => {
        const reapDeadline = Date.now() + 750
        while (terminationCloseCode === undefined && child.exitCode === null && Date.now() < reapDeadline) {
          await delay(10)
        }
        // Native Windows termination can be confirmed before cwd/pipe handles are
        // observable as released. Synthetic spawn seams hold no OS cwd handle.
        await delay(windows && !job ? 25 : 1_000)
      }
      const terminateWithProof = async () => {
        if (windows && job && !jobControlReady() && !terminationFailed) {
          const proofDeadline = Date.now() + WINDOWS_JOB_READINESS_TIMEOUT_MS
          while (!jobControlReady() && child.exitCode === null && Date.now() < proofDeadline) await delay(10)
        }
        return terminateProcessTree(child, options.processControl, windows
          ? {
              ready: jobControlReady(),
              ...(job?.jobName ? { name: job.jobName } : {}),
              ...(windowsJobHelper ? { helperPath: windowsJobHelper } : {}),
              ...(job ? {
                controlRequestPath: job.controlRequestPath,
                controlResultPath: job.controlResultPath,
              } : {}),
            }
          : undefined)
      }
      void terminateWithProof().then(
        async () => {
          await drainTerminationEvents()
          if (terminationChildError) stderr.push(`child error during termination: ${terminationChildError}`)
          finish(terminationCloseCode ?? 1)
        },
        async (error) => {
          await drainTerminationEvents()
          terminationFailed = true
          if (terminationChildError) stderr.push(`child error during termination: ${terminationChildError}`)
          stderr.push(`termination failure: ${error instanceof Error ? error.message : String(error)}`)
          finish(1)
        },
      )
    }
    const onAbort = () => {
      cancelled = true
      requestTermination()
    }
    options.context.abort.addEventListener("abort", onAbort, { once: true })
    if (options.context.abort.aborted) onAbort()

    const armTimeout = () => {
      if (terminating || timer) return
      timer = setTimeout(() => {
        timedOut = true
        requestTermination()
      }, timeoutMs)
    }
    const timeoutReady = () => {
      try {
        return options.timeoutReadiness?.() ?? true
      } catch {
        return false
      }
    }
    if (!terminating) {
      // The helper writes command-ready only after the prepared watcher has opened
      // the configured Job and the command has actually been launched.
      if ((!windows || commandReady()) && timeoutReady()) {
        armTimeout()
      } else {
        const readinessDeadline = Date.now() + WINDOWS_JOB_READINESS_TIMEOUT_MS
        readinessTimer = setInterval(() => {
          if ((!windows || commandReady()) && timeoutReady()) {
            clearInterval(readinessTimer)
            readinessTimer = undefined
            armTimeout()
          } else if (Date.now() >= readinessDeadline) {
            clearInterval(readinessTimer)
            readinessTimer = undefined
            timedOut = true
            terminationFailed = true
            stderr.push("Windows Job Object/readiness handshake timed out before timeout countdown")
            requestTermination()
          }
        }, 10)
        readinessTimer.unref?.()
      }
    }

    child.once("error", (error) => {
      if (terminating) {
        terminationChildError = error.message
        return
      }
      stderr.push(error.message)
      finish(1)
    })
    child.once("close", (code) => {
      if (terminating) {
        terminationCloseCode = code ?? 1
        return
      }
      if (windows || !child.pid) {
        finish(code ?? 1)
        return
      }
      // A detached POSIX shell leader may close after spawning redirected-stdio
      // descendants. Success is not returned until its process group is absent.
      terminating = true
      if (timer) clearTimeout(timer)
      if (readinessTimer) clearInterval(readinessTimer)
      void (async () => {
        let groupExists = true
        try {
          process.kill(-child.pid!, 0)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") groupExists = false
        }
        if (groupExists) {
          try {
            await terminateProcessTree(child, options.processControl)
          } catch (error) {
            terminationFailed = true
            stderr.push(`termination failure: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
        finish(code ?? 1)
      })()
    })
  })
}

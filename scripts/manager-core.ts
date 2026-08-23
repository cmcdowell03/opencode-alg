import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  closeSync,
  chmodSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parse as parseJsonc } from "jsonc-parser"
import { z } from "zod"
import {
  encodeConfigText,
  exactBackup,
  parseJsoncObject,
  planManagedMcpConfig,
  planPluginConfig,
  readConfigTextFile,
  readStableRegularFile,
  type TextFilePlan,
} from "../src/config-editor.ts"
import { acquireFilesystemMutex } from "../src/filesystem-mutex.ts"
import {
  canonicalDirectory,
  canonicalRootPath,
  isContained,
  isFilesystemRoot,
  resolveContainedPath,
} from "../src/paths.ts"
import { computeAlgSourceIdentity } from "../src/source-identity.ts"
import { resolveNpmInvocation } from "./npm-invocation.ts"
import {
  BUNDLED_AGENT_NAMES,
  MANAGER_VERSION,
  MAX_GENERATIONS,
  ManagerJournalSchema,
  ManagerReceiptSchema,
  RECEIPT_FILE,
  type DurableStateCompatibility,
  type ExcelCapabilityReceipt,
  type ManagedAgentReceipt,
  type ManagedExcelMcpConfig,
  type ManagerJournal,
  type ManagerReceipt,
  type ProductionDependencyIdentity,
  type ReleaseGeneration,
} from "./manager-schema.ts"

const SERVER_SCHEMA = "https://opencode.ai/config.json"
const TUI_SCHEMA = "https://opencode.ai/tui.json"
const DEFAULT_REMOTE = "https://github.com/cmcdowell03/opencode-alg.git"
const MAX_METADATA_BYTES = 1024 * 1024
const MAX_COMMAND_OUTPUT = 8 * 1024
const EXCEL_CAPABILITY = "excel"
const EXCEL_TIMEOUT_MS = 30_000
const EXCEL_UPSTREAM_VERSION = "0.1.8"
type BundledAgentName = typeof BUNDLED_AGENT_NAMES[number]
const EXCEL_PYPROJECT = `[project]
name = "opencode-alg-excel-capability"
version = "0.2.0"
requires-python = ">=3.10,<4"
dependencies = [
  "excel-mcp-server==0.1.8",
]

[tool.uv]
package = false
`
const EXCEL_TOOLS = [
  "apply_formula", "copy_range", "copy_worksheet", "create_chart", "create_pivot_table",
  "create_table", "create_workbook", "create_worksheet", "delete_range", "delete_sheet_columns",
  "delete_sheet_rows", "delete_worksheet", "format_range", "get_data_validation_info",
  "get_merged_cells", "get_workbook_metadata", "insert_columns", "insert_rows", "merge_cells",
  "read_data_from_excel", "rename_worksheet", "unmerge_cells", "validate_excel_range",
  "validate_formula_syntax", "write_data_to_excel",
] as const

export type ManagerCommand = "install" | "update" | "doctor" | "rollback" | "uninstall"
export type AgentPolicy = "managed" | "skip" | "force"

export interface ManagerOptions {
  command: ManagerCommand
  configDir: string
  installRoot?: string
  source?: string
  remote?: string
  tag?: string
  version?: string
  generation?: string
  dryRun?: boolean
  json?: boolean
  agentPolicy?: AgentPolicy
  removeAgents?: boolean
  repairJournal?: boolean
  ackRestart?: boolean
  enableCapability?: "excel"
  disableCapability?: "excel"
  excelRoot?: string
}

export interface CommandRequest {
  command: string
  args: readonly string[]
  cwd?: string
  env?: Readonly<Record<string, string>>
}

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(request: CommandRequest): CommandResult
}

export interface ManagerFaults {
  beforeLiveWrite?: (path: string, index: number) => void
  afterLiveClaim?: (path: string, index: number) => void
  beforeLiveUnlink?: (path: string, index: number) => void
  afterLiveUnlink?: (path: string, index: number) => void
  beforeLivePublish?: (path: string, index: number) => void
  afterLivePublish?: (path: string, index: number) => void
  /** Test-only crash seam: throwing SimulatedManagerCrashError leaves the journal for doctor recovery. */
  afterLiveWrite?: (path: string, index: number) => void
  beforeReceiptCommit?: (path: string) => void
  afterReceiptClaim?: (path: string) => void
  afterReceiptPublish?: (path: string) => void
  /** Test-only crash seam after the receipt is durable but before the journal records that phase. */
  afterReceiptCommit?: (path: string) => void
  afterJournalPhase?: (phase: ManagerJournal["phase"]) => void
  beforeJournalCleanup?: (path: string) => void
  afterJournalRead?: (path: string) => void
  afterProbeDirectoryCreated?: (path: string) => void
  afterGenerationPackageCreated?: (path: string) => void
  beforeGenerationEntryCreate?: (source: string, destination: string, index: number) => void
  afterGenerationEntryCreate?: (source: string, destination: string, index: number) => void
  beforeGenerationStagingCleanup?: (path: string) => void
  afterPlanning?: (kind: "receipt" | "config" | "agent", path: string) => void
}

export interface ManagerDependencies {
  runner?: CommandRunner
  link?: typeof linkSync
  unlink?: typeof unlinkSync
  faults?: ManagerFaults
  now?: () => Date
}

export interface ManagerResult {
  command: ManagerCommand
  ok: boolean
  changed: boolean
  dry_run: boolean
  summary: string
  generation?: string
  receipt_path?: string
  configs?: Array<{ path: string; changed: boolean; backup?: string }>
  agents?: Array<{ path: string; action: string; backup?: string }>
  issues?: Array<{ code: string; message: string }>
  pending_journals?: string[]
  previous_generation?: string | null
  restart_required?: boolean
  agent_status?: Array<{ name: string; status: "managed" | "custom" | "missing" | "drift"; source_hash: string; current_hash: string | null }>
  capability_status?: {
    name: "excel"
    status: "disabled" | "healthy" | "missing" | "custom" | "drift"
    enabled: boolean
    root: string | null
    manifest: "ok" | "missing" | "drift" | "not-recorded"
    lock: "ok" | "missing" | "drift" | "not-recorded"
    wrapper: "ok" | "missing" | "drift" | "not-recorded"
    environment: "ok" | "missing" | "disabled"
    runtime_check: "ok" | "failed" | "not-run"
    upstream_version: string | null
    tool_count: number | null
  }
}

export const MANAGER_JSON_MAX_BYTES = 256 * 1024

/** Only injected tests should throw this; production faults still receive ordinary rollback. */
export class SimulatedManagerCrashError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SimulatedManagerCrashError"
  }
}

export function managerErrorMessage(error: unknown): string {
  return safeMessage(error instanceof Error ? error.message : String(error))
}

export function serializeManagerJson(value: unknown): string {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text, "utf8") > MANAGER_JSON_MAX_BYTES) {
    throw new Error(`Manager JSON output exceeds ${MANAGER_JSON_MAX_BYTES} bytes`)
  }
  return text
}

interface ManagerPaths {
  configRoot: string
  installRoot: string
  managerRoot: string
  releasesRoot: string
  stagingRoot: string
  transactionsRoot: string
  receiptPath: string
  lockPath: string
  serverConfig: string
  tuiConfig: string
  agentsRoot: string
  capabilityEnvsRoot: string
}

interface BinaryPlan {
  path: string
  kind: "config" | "agent"
  before?: Buffer
  beforeIdentity: FileIdentity | null
  after?: Buffer
  action: string
  backup?: string
}

interface StagedRelease {
  stagingPath: string
  finalPath: string
  generation: ReleaseGeneration
  trustedRemote: string
  stagingIdentity: FileIdentity
  stagingEntries: TreeEntry[]
}

class DefaultCommandRunner implements CommandRunner {
  run(request: CommandRequest): CommandResult {
    const child = spawnSync(request.command, [...request.args], {
      cwd: request.cwd,
      shell: false,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
      env: request.env ? { ...process.env, ...request.env } : process.env,
    })
    if (child.error) throw new Error(`Unable to start ${request.command}: ${safeMessage(child.error.message)}`)
    return {
      exitCode: child.status ?? 1,
      stdout: bounded(child.stdout ?? ""),
      stderr: bounded(child.stderr ?? ""),
    }
  }
}

function bounded(value: string, max = MAX_COMMAND_OUTPUT): string {
  const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?")
  if (Buffer.byteLength(clean, "utf8") <= max) return clean
  const bytes = Buffer.from(clean, "utf8")
  let prefix = bytes.subarray(0, Math.max(0, max - 3)).toString("utf8")
  if (prefix.endsWith("\ufffd")) prefix = prefix.slice(0, -1)
  return `${prefix}...`
}

function safeMessage(value: string): string {
  const redacted = value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/:\/\/([^/\s:@]+):([^@/\s]+)@/g, "://$1:[redacted]@")
    .replace(/(authorization|token|api[-_]?key|password|cookie)\s*(?::|=|\bis\b)?\s*\S+/gi, "$1=[redacted]")
  return bounded(redacted, 2_048)
}

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function fileHash(path: string): string | null {
  return existsSync(path) ? sha256(readFileSync(path)) : null
}

function nowIso(dependencies: ManagerDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString()
}

function normalizedPath(path: string): string {
  const value = resolve(path)
  return process.platform === "win32" ? value.toLowerCase() : value
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right)
}

function assertDirectoryCreated(path: string): void {
  const expected = canonicalRootPath(path)
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const actual = canonicalDirectory(path)
  if (!samePath(expected, actual)) throw new Error(`Directory creation was redirected: ${path}`)
}

function createPaths(paths: ManagerPaths): void {
  for (const path of [
    paths.configRoot,
    paths.managerRoot,
    paths.installRoot,
    paths.releasesRoot,
    paths.stagingRoot,
    paths.transactionsRoot,
  ]) assertDirectoryCreated(path)
}

function assertManagedAgentsRoot(paths: ManagerPaths): void {
  if (!existsSync(paths.agentsRoot)) return
  const stat = lstatSync(paths.agentsRoot)
  if (stat.isSymbolicLink() || !stat.isDirectory() || !samePath(realpathSync.native(paths.agentsRoot), paths.agentsRoot)) {
    throw new Error("Managed agents directory is redirected or not a direct directory")
  }
}

function assertManagedAgentTarget(path: string): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink() || !stat.isFile() || !samePath(realpathSync.native(path), path)) {
    throw new Error(`Managed agent target is redirected or not a regular direct file: ${basename(path)}`)
  }
}

function managerPaths(options: ManagerOptions): ManagerPaths {
  if (!isAbsolute(options.configDir)) throw new Error("--config-dir must be absolute")
  const configRoot = canonicalRootPath(resolve(options.configDir))
  if (isFilesystemRoot(configRoot)) throw new Error("config root must not be a filesystem root")
  const managerRoot = resolveContainedPath(configRoot, ".opencode-alg")
  const defaultInstall = resolveContainedPath(configRoot, "plugins", "opencode-alg")
  const requestedInstall = options.installRoot ? resolve(options.installRoot) : defaultInstall
  if (!isAbsolute(requestedInstall)) throw new Error("--install-root must be absolute")
  const installRoot = canonicalRootPath(requestedInstall)
  if (isFilesystemRoot(installRoot) || samePath(configRoot, installRoot)) {
    throw new Error("install root must be a scoped directory distinct from the config root")
  }
  if (isContained(installRoot, configRoot)) throw new Error("config root must not be contained by install root")
  if (isContained(managerRoot, installRoot) || isContained(installRoot, managerRoot)) {
    throw new Error("install root overlaps manager metadata")
  }
  return {
    configRoot,
    installRoot,
    managerRoot,
    releasesRoot: resolveContainedPath(installRoot, "releases"),
    stagingRoot: resolveContainedPath(installRoot, ".staging"),
    transactionsRoot: resolveContainedPath(managerRoot, "transactions"),
    receiptPath: resolveContainedPath(managerRoot, RECEIPT_FILE),
    lockPath: resolveContainedPath(managerRoot, "manager.lock"),
    serverConfig: resolveContainedPath(configRoot, "opencode.jsonc"),
    tuiConfig: resolveContainedPath(configRoot, "tui.json"),
    agentsRoot: resolveContainedPath(configRoot, "agents"),
    capabilityEnvsRoot: resolveContainedPath(installRoot, "capability-envs", EXCEL_CAPABILITY),
  }
}

function receiptAuxiliaryPaths(paths: ManagerPaths, transactionId: string): { backup: string; claim: string; prepared: string; journal: string } {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId)) throw new Error("Invalid manager transaction id")
  return {
    backup: resolveContainedPath(paths.managerRoot, `${RECEIPT_FILE}.alg-backup-${transactionId}`),
    claim: resolveContainedPath(paths.managerRoot, `${RECEIPT_FILE}.alg-claim-${transactionId}`),
    prepared: resolveContainedPath(paths.managerRoot, `${RECEIPT_FILE}.alg-prepared-${transactionId}`),
    journal: resolveContainedPath(paths.transactionsRoot, `${transactionId}.json`),
  }
}

function liveFileAuxiliaryPaths(path: string, transactionId: string): { claim: string; prepared: string } {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId)) throw new Error("Invalid manager transaction id")
  return {
    claim: resolveContainedPath(dirname(path), `${basename(path)}.alg-claim-${transactionId}`),
    prepared: resolveContainedPath(dirname(path), `${basename(path)}.alg-prepared-${transactionId}`),
  }
}

type FileIdentity = { dev: string; ino: string }

type TreeEntry = {
  relativePath: string
  kind: "directory" | "file" | "symlink"
  identity: FileIdentity
  mode: number
  bytes: number
  hash: string | null
  linkTarget: string | null
}

type CreatedTreeEntry = {
  path: string
  kind: TreeEntry["kind"]
  identity: FileIdentity
  bytes: number
  hash: string | null
  linkTarget: string | null
}

const MAX_GENERATION_TREE_ENTRIES = 100_000
const MAX_GENERATION_TREE_DEPTH = 64
const MAX_GENERATION_FILE_BYTES = 64 * 1024 * 1024
const MAX_GENERATION_TREE_BYTES = 2 * 1024 * 1024 * 1024

function regularFileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || !samePath(realpathSync.native(path), path)) throw new Error(`Path is redirected or not a regular file: ${path}`)
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function filesystemIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true })
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function regularDirectoryIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync.native(path), path)) throw new Error(`Path is redirected or not a direct directory: ${path}`)
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function unlinkOwnedRegularFile(path: string, expectedHash: string, expectedIdentity: FileIdentity, unlink: typeof unlinkSync = unlinkSync): void {
  if (!existsSync(path)) return
  const identity = regularFileIdentity(path)
  if (!sameFileIdentity(identity, expectedIdentity) || fileHash(path) !== expectedHash) throw new Error(`Transaction-owned auxiliary path changed; refusing deletion: ${path}`)
  unlink(path)
}

function probeNoClobberPrimitives(parent: string, transactionId: string, index: number, dependencies: ManagerDependencies): void {
  const link = dependencies.link ?? linkSync
  const unlink = dependencies.unlink ?? unlinkSync
  const directory = resolveContainedPath(parent, `.alg-probe-${transactionId}-${index}`)
  mkdirSync(directory, { recursive: false, mode: 0o700 })
  const directoryIdentity = regularDirectoryIdentity(directory)
  const source = resolveContainedPath(directory, "source")
  const target = resolveContainedPath(directory, "link-target")
  const bytes = Buffer.from(`opencode-alg-probe:${transactionId}:${index}\n`, "utf8")
  writeFileSync(source, bytes, { flag: "wx", mode: 0o600 })
  const sourceIdentity = regularFileIdentity(source)
  let targetIdentity: FileIdentity | null = null
  try {
    dependencies.faults?.afterProbeDirectoryCreated?.(directory)
    link(source, target)
    targetIdentity = regularFileIdentity(target)
    if (!sameFileIdentity(sourceIdentity, targetIdentity) || fileHash(source) !== sha256(bytes) || fileHash(target) !== sha256(bytes)) {
      throw new Error("Private primitive probe hard-link identity differs")
    }
    unlinkOwnedRegularFile(target, sha256(bytes), targetIdentity, unlink)
    unlinkOwnedRegularFile(source, sha256(bytes), sourceIdentity, unlink)
    if (!sameFileIdentity(regularDirectoryIdentity(directory), directoryIdentity) || readdirSync(directory).length !== 0) throw new Error("Private primitive probe directory changed")
    rmdirSync(directory)
  } catch (error) {
    if (targetIdentity && existsSync(target)) {
      try { unlinkOwnedRegularFile(target, sha256(bytes), targetIdentity, unlink) } catch { /* preserve ambiguity */ }
    }
    if (existsSync(source)) {
      try { unlinkOwnedRegularFile(source, sha256(bytes), sourceIdentity, unlink) } catch { /* preserve ambiguity */ }
    }
    if (existsSync(directory)) {
      try {
        if (sameFileIdentity(regularDirectoryIdentity(directory), directoryIdentity) && readdirSync(directory).length === 0) rmdirSync(directory)
      } catch { /* preserve foreign or ambiguous probe evidence */ }
    }
    throw new Error(`Private no-clobber primitive probe failed: ${safeMessage(error instanceof Error ? error.message : String(error))}`)
  }
}

function strictlyMissing(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return true
    throw error
  }
}

function lexicalTreePath(root: string, relativePath: string): string {
  const path = resolve(root, ...relativePath.split("/"))
  if (!isContained(root, path)) throw new Error(`Generation tree path escapes its root: ${relativePath}`)
  return path
}

function snapshotGenerationTree(root: string): TreeEntry[] {
  const canonicalRoot = canonicalDirectory(root)
  if (!samePath(canonicalRoot, root)) throw new Error("Generation staging root is redirected")
  const entries: TreeEntry[] = []
  let totalBytes = 0
  const visit = (directory: string, depth: number): void => {
    if (depth > MAX_GENERATION_TREE_DEPTH) throw new Error(`Generation tree exceeds depth ${MAX_GENERATION_TREE_DEPTH}`)
    if (!samePath(realpathSync.native(directory), directory)) throw new Error(`Generation directory is redirected: ${directory}`)
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name)
      if (!isContained(canonicalRoot, path)) throw new Error(`Generation entry escapes staging: ${path}`)
      const relativePath = relative(canonicalRoot, path).split("\\").join("/")
      const stat = lstatSync(path)
      const identity = filesystemIdentity(path)
      let entry: TreeEntry
      if (stat.isSymbolicLink()) {
        const linkTarget = readlinkSync(path)
        if (isAbsolute(linkTarget)) throw new Error(`Generation symlink target must be relative: ${relativePath}`)
        const lexicalTarget = resolve(dirname(path), linkTarget)
        if (!isContained(canonicalRoot, lexicalTarget)) throw new Error(`Generation symlink escapes staging: ${relativePath}`)
        const resolvedTarget = realpathSync.native(path)
        if (!isContained(canonicalRoot, resolvedTarget) && !samePath(canonicalRoot, resolvedTarget)) {
          throw new Error(`Generation symlink resolves outside staging: ${relativePath}`)
        }
        entry = { relativePath, kind: "symlink", identity, mode: stat.mode & 0o777, bytes: 0, hash: null, linkTarget }
      } else if (stat.isDirectory()) {
        if (!samePath(realpathSync.native(path), path)) throw new Error(`Generation directory is a junction or reparse redirect: ${relativePath}`)
        entry = { relativePath, kind: "directory", identity, mode: stat.mode & 0o777, bytes: 0, hash: null, linkTarget: null }
      } else if (stat.isFile()) {
        if (!samePath(realpathSync.native(path), path)) throw new Error(`Generation file is redirected: ${relativePath}`)
        if (stat.size > MAX_GENERATION_FILE_BYTES) throw new Error(`Generation file exceeds ${MAX_GENERATION_FILE_BYTES} bytes: ${relativePath}`)
        const bytes = readFileSync(path)
        if (bytes.byteLength !== stat.size) throw new Error(`Generation file changed during bounded snapshot: ${relativePath}`)
        totalBytes += bytes.byteLength
        if (totalBytes > MAX_GENERATION_TREE_BYTES) throw new Error(`Generation tree exceeds ${MAX_GENERATION_TREE_BYTES} bytes`)
        entry = { relativePath, kind: "file", identity, mode: stat.mode & 0o777, bytes: bytes.byteLength, hash: sha256(bytes), linkTarget: null }
      } else {
        throw new Error(`Generation tree contains an unsafe filesystem type: ${relativePath}`)
      }
      entries.push(entry)
      if (entries.length > MAX_GENERATION_TREE_ENTRIES) throw new Error(`Generation tree exceeds ${MAX_GENERATION_TREE_ENTRIES} entries`)
      if (entry.kind === "directory") visit(path, depth + 1)
    }
  }
  visit(canonicalRoot, 0)
  return entries
}

function assertTreeEntry(root: string, entry: TreeEntry): string {
  const path = lexicalTreePath(root, entry.relativePath)
  if (strictlyMissing(path) || !sameFileIdentity(filesystemIdentity(path), entry.identity)) {
    throw new Error(`Generation tree entry identity changed: ${entry.relativePath}`)
  }
  const stat = lstatSync(path)
  if ((stat.mode & 0o777) !== entry.mode) throw new Error(`Generation tree entry mode changed: ${entry.relativePath}`)
  if (entry.kind === "directory") {
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync.native(path), path)) throw new Error(`Generation directory changed type: ${entry.relativePath}`)
  } else if (entry.kind === "file") {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || fileHash(path) !== entry.hash || !samePath(realpathSync.native(path), path)) {
      throw new Error(`Generation file changed after snapshot: ${entry.relativePath}`)
    }
  } else if (!stat.isSymbolicLink() || readlinkSync(path) !== entry.linkTarget) {
    throw new Error(`Generation symlink changed after snapshot: ${entry.relativePath}`)
  }
  return path
}

function sameTreeEntries(left: readonly TreeEntry[], right: readonly TreeEntry[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function assertExactTree(root: string, rootIdentity: FileIdentity, entries: readonly TreeEntry[]): void {
  if (!sameFileIdentity(regularDirectoryIdentity(root), rootIdentity)) throw new Error("Generation staging root identity changed")
  const observed = snapshotGenerationTree(root)
  if (!sameTreeEntries(observed, entries)) throw new Error("Generation staging tree changed after validation")
  for (const entry of entries) assertTreeEntry(root, entry)
}

function removeSnapshottedTree(root: string, rootIdentity: FileIdentity, entries: readonly TreeEntry[]): void {
  // Full-tree preflight precedes the first unlink. Each individual unlink is
  // identity-checked again immediately before mutation.
  assertExactTree(root, rootIdentity, entries)
  for (const entry of [...entries].reverse()) {
    const path = assertTreeEntry(root, entry)
    if (entry.kind === "directory") {
      if (readdirSync(path).length !== 0) throw new Error(`Generation staging directory gained foreign content: ${entry.relativePath}`)
      rmdirSync(path)
    } else {
      unlinkSync(path)
    }
  }
  if (!sameFileIdentity(regularDirectoryIdentity(root), rootIdentity) || readdirSync(root).length !== 0) {
    throw new Error("Generation staging root changed before cleanup")
  }
  rmdirSync(root)
}

function removeStagingIfPresent(staged: StagedRelease, dependencies: ManagerDependencies): void {
  if (strictlyMissing(staged.stagingPath)) return
  dependencies.faults?.beforeGenerationStagingCleanup?.(staged.stagingPath)
  removeSnapshottedTree(staged.stagingPath, staged.stagingIdentity, staged.stagingEntries)
}

function assertCreatedEntry(entry: CreatedTreeEntry): void {
  if (strictlyMissing(entry.path) || !sameFileIdentity(filesystemIdentity(entry.path), entry.identity)) {
    throw new Error(`Materialized generation entry identity changed: ${entry.path}`)
  }
  const stat = lstatSync(entry.path)
  if (entry.kind === "directory") {
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(realpathSync.native(entry.path), entry.path)) throw new Error(`Materialized generation directory changed type: ${entry.path}`)
  } else if (entry.kind === "file") {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes || fileHash(entry.path) !== entry.hash || !samePath(realpathSync.native(entry.path), entry.path)) {
      throw new Error(`Materialized generation file changed: ${entry.path}`)
    }
  } else if (!stat.isSymbolicLink() || readlinkSync(entry.path) !== entry.linkTarget) {
    throw new Error(`Materialized generation symlink changed: ${entry.path}`)
  }
}

function cleanupCreatedGeneration(
  created: readonly CreatedTreeEntry[],
  reservationPath: string,
  reservationIdentity: FileIdentity,
): void {
  const errors: unknown[] = []
  for (const entry of [...created].reverse()) {
    try {
      if (entry.kind === "directory" && errors.length) {
        throw new Error(`Ambiguous descendant preserves materialized directory: ${entry.path}`)
      }
      assertCreatedEntry(entry)
      if (entry.kind === "directory") {
        if (readdirSync(entry.path).length !== 0) throw new Error(`Foreign content preserves materialized directory: ${entry.path}`)
        rmdirSync(entry.path)
      } else {
        unlinkSync(entry.path)
      }
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) {
    throw new AggregateError(errors, "generation publication cleanup was incomplete; reservation preserved")
  }
  try {
    if (!sameFileIdentity(regularDirectoryIdentity(reservationPath), reservationIdentity)) throw new Error("Generation reservation identity changed during cleanup")
    if (readdirSync(reservationPath).length !== 0) throw new Error("Foreign or replaced content preserves generation reservation")
    rmdirSync(reservationPath)
  } catch (error) {
    errors.push(error)
  }
  if (errors.length) throw new AggregateError(errors, "generation publication cleanup was incomplete")
}

function materializeGenerationTree(
  staged: StagedRelease,
  packagePath: string,
  reservationIdentity: FileIdentity,
  dependencies: ManagerDependencies,
  created: CreatedTreeEntry[],
): void {
  const link = dependencies.link ?? linkSync
  assertExactTree(staged.stagingPath, staged.stagingIdentity, staged.stagingEntries)
  if (!sameFileIdentity(regularDirectoryIdentity(staged.finalPath), reservationIdentity)) throw new Error("Generation reservation identity changed before package creation")
  mkdirSync(packagePath, { recursive: false, mode: statSync(staged.stagingPath).mode & 0o777 })
  chmodSync(packagePath, statSync(staged.stagingPath).mode & 0o777)
  const packageIdentity = regularDirectoryIdentity(packagePath)
  created.push({ path: packagePath, kind: "directory", identity: packageIdentity, bytes: 0, hash: null, linkTarget: null })
  dependencies.faults?.afterGenerationPackageCreated?.(packagePath)
  for (const [index, entry] of staged.stagingEntries.entries()) {
    const source = assertTreeEntry(staged.stagingPath, entry)
    const destination = lexicalTreePath(packagePath, entry.relativePath)
    if (!sameFileIdentity(regularDirectoryIdentity(staged.finalPath), reservationIdentity) ||
      !sameFileIdentity(regularDirectoryIdentity(packagePath), packageIdentity)) {
      throw new Error("Generation publication parent identity changed")
    }
    dependencies.faults?.beforeGenerationEntryCreate?.(source, destination, index)
    if (entry.kind === "directory") {
      mkdirSync(destination, { recursive: false, mode: entry.mode })
      chmodSync(destination, entry.mode)
    } else if (entry.kind === "file") {
      link(source, destination)
    } else {
      const targetStat = statSync(source)
      symlinkSync(entry.linkTarget!, destination, targetStat.isDirectory() ? "dir" : "file")
    }
    const createdEntry: CreatedTreeEntry = {
      path: destination,
      kind: entry.kind,
      identity: filesystemIdentity(destination),
      bytes: entry.bytes,
      hash: entry.hash,
      linkTarget: entry.linkTarget,
    }
    if (entry.kind === "file" && !sameFileIdentity(createdEntry.identity, entry.identity)) {
      throw new Error(`Materialized hard link identity differs from staging: ${entry.relativePath}`)
    }
    created.push(createdEntry)
    dependencies.faults?.afterGenerationEntryCreate?.(source, destination, index)
    assertCreatedEntry(createdEntry)
  }
  // Recheck every created path after the complete tree exists so contained
  // relative symlinks resolve only inside the final package.
  for (const entry of created) {
    assertCreatedEntry(entry)
    if (entry.kind === "symlink") {
      const resolved = realpathSync.native(entry.path)
      if (!isContained(packagePath, resolved) && !samePath(packagePath, resolved)) throw new Error(`Materialized generation symlink escapes package: ${entry.path}`)
    }
  }
}

function readBounded(path: string): Buffer {
  const size = statSync(path).size
  if (size > MAX_METADATA_BYTES) throw new Error(`Metadata file exceeds ${MAX_METADATA_BYTES} bytes: ${path}`)
  return readFileSync(path)
}

const receiptBaselineHashes = new WeakMap<ManagerReceipt, string>()
const receiptBaselineIdentities = new WeakMap<ManagerReceipt, FileIdentity>()

function readReceipt(paths: ManagerPaths, required = false): ManagerReceipt | undefined {
  if (!existsSync(paths.receiptPath)) {
    if (required) throw new Error(`No managed ALG receipt at ${paths.receiptPath}`)
    return
  }
  let parsed: unknown
  let receiptBytes: Buffer
  let receiptIdentity: FileIdentity
  try {
    const stable = readStableRegularFile(paths.receiptPath)
    receiptBytes = stable.bytes
    receiptIdentity = stable.identity
    if (receiptBytes.byteLength > MAX_METADATA_BYTES) throw new Error(`Metadata file exceeds ${MAX_METADATA_BYTES} bytes: ${paths.receiptPath}`)
    parsed = JSON.parse(receiptBytes.toString("utf8"))
  } catch (error) {
    throw new Error(`Malformed manager receipt: ${safeMessage(error instanceof Error ? error.message : String(error))}`)
  }
  const receipt = ManagerReceiptSchema.parse(parsed)
  const baselineHash = sha256(receiptBytes)
  if (fileHash(paths.receiptPath) !== baselineHash) throw new Error("Receipt changed while it was being read")
  receiptBaselineHashes.set(receipt, baselineHash)
  receiptBaselineIdentities.set(receipt, receiptIdentity!)
  if (!samePath(receipt.config_root, paths.configRoot) || !samePath(receipt.install_root, paths.installRoot)) {
    throw new Error("Receipt roots do not match the requested canonical roots")
  }
  if (!samePath(receipt.server_registration.config_path, paths.serverConfig) ||
    !samePath(receipt.tui_registration.config_path, paths.tuiConfig)) {
    throw new Error("Receipt registration paths do not match the canonical config paths")
  }
  if (!remoteEqual(receipt.trusted_remote, sanitizeRemote(receipt.trusted_remote))) {
    throw new Error("Receipt trusted remote is not canonical")
  }
  for (const generation of receipt.generations) {
    const generationRoot = resolveContainedPath(paths.releasesRoot, generation.id)
    const expectedRoot = resolveContainedPath(generationRoot, "package")
    if (!samePath(generation.package_root, expectedRoot) || generation.id !== `${generation.version}-${generation.commit.slice(0, 12)}` || generation.tag !== `v${generation.version}`) {
      throw new Error(`Receipt generation identity/path is invalid: ${generation.id}`)
    }
    const expectedSpec = pathToFileURL(expectedRoot).href.replace(/\/$/, "")
    if (!specMatches(generation.spec, expectedSpec)) throw new Error(`Receipt generation spec is invalid: ${generation.id}`)
    if (JSON.stringify(generation.agents.map((agent) => agent.name).sort()) !== JSON.stringify(BUNDLED_AGENT_NAMES)) {
      throw new Error(`Receipt generation bundled agent inventory is invalid: ${generation.id}`)
    }
    const excel = generation.capabilities?.excel
    if (excel?.enabled) {
      const expectedCapabilityRoot = resolveContainedPath(expectedRoot, "capabilities", EXCEL_CAPABILITY)
      const expectedWrapper = resolveContainedPath(expectedCapabilityRoot, "wrapper.py")
      const relativeEnv = relative(paths.capabilityEnvsRoot, excel.env_path!).replaceAll("\\", "/").split("/")
      if (relativeEnv.length !== 3 || relativeEnv[0] !== generation.id || relativeEnv[1] !== excel.lock_hash ||
        !/^[0-9a-f-]{36}$/i.test(relativeEnv[2]!)) throw new Error(`Receipt Excel environment path is not activation-specific: ${generation.id}`)
      const expectedInterpreter = excelInterpreter(excel.env_path!)
      const config = excel.managed_config!
      if (!samePath(config.cwd, expectedCapabilityRoot) ||
        !samePath(config.command[0], expectedInterpreter) || !samePath(config.command[1], expectedWrapper) ||
        !samePath(config.environment.ALG_EXCEL_ROOT, excel.root!) || managedConfigHash(config) !== excel.config_hash) {
        throw new Error(`Receipt Excel capability paths/config are invalid: ${generation.id}`)
      }
    }
  }
  assertManagedAgentsRoot(paths)
  for (const [name, agent] of Object.entries(receipt.agents)) {
    const expected = resolveContainedPath(paths.agentsRoot, name)
    if (!samePath(agent.path, expected) || resolve(agent.path) !== resolve(expected)) throw new Error(`Receipt agent path is invalid: ${name}`)
    assertManagedAgentTarget(expected)
  }
  return receipt
}

function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
}

function command(
  runner: CommandRunner,
  executable: string,
  args: readonly string[],
  cwd?: string,
  env?: Readonly<Record<string, string>>,
): CommandResult {
  const raw = runner.run({ command: executable, args, cwd, env })
  const result = { ...raw, stdout: bounded(raw.stdout), stderr: bounded(raw.stderr) }
  if (result.exitCode !== 0) {
    const detail = safeMessage(result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`)
    throw new Error(`${basename(executable)} failed: ${detail}`)
  }
  return result
}

function git(runner: CommandRunner, root: string, args: readonly string[]): string {
  // Validation is read-only. Disable Git's optional index refresh/lock so a
  // status or rev-parse cannot replace a just-materialized hard-linked index.
  return command(runner, "git", ["-C", root, ...args], undefined, { GIT_OPTIONAL_LOCKS: "0" }).stdout.trim()
}

function assertStableTag(tag: string): string {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw new Error(`Stable releases require an exact vMAJOR.MINOR.PATCH tag: ${tag}`)
  return tag
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number)
  const b = right.split(".").map(Number)
  for (let index = 0; index < 3; index++) {
    const difference = a[index]! - b[index]!
    if (difference) return difference
  }
  return 0
}

function requestedTag(options: ManagerOptions): string | undefined {
  if (options.tag && options.version && options.tag !== `v${options.version}`) {
    throw new Error("--tag and --version disagree")
  }
  return options.tag ? assertStableTag(options.tag) : options.version ? assertStableTag(`v${options.version}`) : undefined
}

function sanitizeRemote(value: string): string {
  const remote = value.trim()
  if (!remote || remote.length > 8_192 || remote !== value || /[\u0000-\u001f\u007f]/.test(remote)) throw new Error("Remote is empty, oversized, or contains unsafe characters")
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) {
    const url = new URL(remote)
    if (url.username || url.password || url.search || url.hash) throw new Error("Remote URLs must not contain credentials, query, or fragment")
    if (!new Set(["https:", "ssh:", "file:"]).has(url.protocol)) throw new Error(`Unsupported remote protocol: ${url.protocol}`)
    if (url.protocol === "file:") return pathToFileURL(canonicalDirectory(fileURLToPath(url))).href
    return url.href.replace(/\/$/, "")
  }
  if (/^[^@\s]+@[^:\s]+:.+$/.test(remote)) return remote.replace(/\/$/, "")
  if (existsSync(remote)) return pathToFileURL(canonicalDirectory(resolve(remote))).href
  throw new Error("Remote must be a safe HTTPS/SSH/file URL, SCP-style SSH remote, or existing local directory")
}

function remoteEqual(left: string, right: string): boolean {
  return sanitizeRemote(left) === sanitizeRemote(right)
}

function sourceRemote(runner: CommandRunner, source: string): string {
  const result = runner.run({ command: "git", args: ["-C", source, "config", "--get", "remote.origin.url"] })
  if (result.exitCode === 0 && result.stdout.trim()) return sanitizeRemote(result.stdout.trim())
  return pathToFileURL(source).href
}

function assertCleanRepository(runner: CommandRunner, root: string, label: string): void {
  const status = git(runner, root, ["status", "--porcelain=v1", "--untracked-files=all"])
  if (status) throw new Error(`${label} repository has tracked or untracked changes: ${bounded(status, 512)}`)
}

function parsePackage(root: string): Record<string, any> {
  const path = resolveContainedPath(root, "package.json")
  const value = JSON.parse(readBounded(path).toString("utf8")) as unknown
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid package.json in ${root}`)
  return value as Record<string, any>
}

function packageDurableCompatibility(pkg: Record<string, any>, version: string): DurableStateCompatibility {
  const declaration = pkg.opencodeAlg?.durableState
  if (declaration === undefined && version === "0.1.0") {
    // v0.1 persisted schema-v2 runs and v0.2 explicitly retains that format.
    return {
      format: "alg-run-state",
      current_schema: 2,
      compatible_schemas: [2],
      compatible_package_versions: ["0.1.0", "0.2.0"],
    }
  }
  if (!declaration || declaration.format !== "alg-run-state" ||
    !Number.isSafeInteger(declaration.currentSchema) || declaration.currentSchema < 1 ||
    !Array.isArray(declaration.compatibleSchemas) || !declaration.compatibleSchemas.every((item: unknown) => Number.isSafeInteger(item) && Number(item) > 0) ||
    !Array.isArray(declaration.compatiblePackageVersions) || !declaration.compatiblePackageVersions.every((item: unknown) => typeof item === "string" && /^\d+\.\d+\.\d+$/.test(item))) {
    throw new Error("Package durable-state compatibility declaration is missing or invalid")
  }
  return {
    format: "alg-run-state",
    current_schema: declaration.currentSchema,
    compatible_schemas: [...new Set<number>(declaration.compatibleSchemas)],
    compatible_package_versions: [...new Set<string>(declaration.compatiblePackageVersions)],
  }
}

function validatePackageAndLock(root: string, tag: string): {
  version: string
  lockDigest: string
  dependencies: string[]
  durableState: DurableStateCompatibility
} {
  const pkg = parsePackage(root)
  const version = tag.slice(1)
  if (pkg.name !== "opencode-alg" || pkg.version !== version) throw new Error(`package.json version/name does not agree with ${tag}`)
  const lockPath = resolveContainedPath(root, "package-lock.json")
  const lockBytes = readBounded(lockPath)
  const lock = JSON.parse(lockBytes.toString("utf8")) as any
  if (lock?.name !== "opencode-alg" || lock?.version !== version || lock?.packages?.[""]?.version !== version) {
    throw new Error(`package-lock root version/name does not agree with ${tag}`)
  }
  if (pkg.exports?.["."] !== "./src/index.ts" || pkg.exports?.["./server"] !== "./src/server.ts" || pkg.exports?.["./tui"] !== "./src/tui.ts") {
    throw new Error("Package exports do not expose the required ALG server and TUI entry points")
  }
  if (pkg.opencode?.server !== "./src/server.ts" || pkg.opencode?.tui !== "./src/tui.ts") {
    throw new Error("Package OpenCode entry points are invalid")
  }
  for (const relativePath of ["src/index.ts", "src/server.ts", "src/tui.ts", "agents", "templates"]) {
    const path = resolveContainedPath(root, ...relativePath.split("/"))
    if (!existsSync(path)) throw new Error(`Release is missing required path: ${relativePath}`)
  }
  return {
    version,
    lockDigest: sha256(lockBytes),
    dependencies: Object.keys(pkg.dependencies ?? {}).sort(),
    durableState: packageDurableCompatibility(pkg, version),
  }
}

const ExcelManifestSchema = z.object({
  schema_version: z.literal(1),
  id: z.literal("alg-excel"),
  pack_version: z.literal("0.2.0"),
  upstream: z.object({
    distribution: z.literal("excel-mcp-server"),
    version: z.literal(EXCEL_UPSTREAM_VERSION),
    import: z.literal("excel_mcp.server"),
    release_commit: z.literal("f51340ecd5778952405044b203d3a2d4c8a46833"),
    wheel_sha256: z.literal("c75668094697152b9d749939c071ea02ac418635c8a11636396bd9797609f5a5"),
  }).strict(),
  python: z.object({ requires: z.literal(">=3.10,<4") }).strict(),
  tools: z.array(z.string().max(128)).length(EXCEL_TOOLS.length),
  files: z.object({
    pyproject: z.literal("pyproject.toml"),
    lock: z.literal("uv.lock"),
    policy: z.literal("policy.py"),
    wrapper: z.literal("wrapper.py"),
    validator: z.literal("workbook.py"),
    sha256: z.object({
      pyproject: z.string().regex(/^[a-f0-9]{64}$/),
      lock: z.string().regex(/^[a-f0-9]{64}$/),
      policy: z.string().regex(/^[a-f0-9]{64}$/),
      wrapper: z.string().regex(/^[a-f0-9]{64}$/),
      validator: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict(),
  }).strict(),
  security: z.object({
    root_environment: z.literal("ALG_EXCEL_ROOT"),
    workbook_extension: z.literal(".xlsx"),
    relative_workbook_arguments_only: z.literal(true),
    path_argument_confinement: z.literal(true),
    os_sandbox: z.literal(false),
    ambient_process_permissions: z.literal(true),
    remote_transports: z.literal(false),
    staged_copies: z.literal(true),
    formula_calculation: z.literal(false),
    libreoffice_recalculation: z.literal(false),
  }).strict(),
  runtime: z.object({
    transport: z.literal("stdio"),
    sync: z.tuple([z.literal("uv"), z.literal("sync"), z.literal("--frozen"), z.literal("--no-dev")]),
  }).strict(),
}).strict()

interface ExcelAssets {
  directory: string
  manifestPath: string
  lockPath: string
  wrapperPath: string
  validatorPath: string
  manifestHash: string
  lockHash: string
  wrapperHash: string
  validatorHash: string
}

function excelAssets(root: string, required: boolean): ExcelAssets | undefined {
  const directory = resolveContainedPath(root, "capabilities", EXCEL_CAPABILITY)
  if (!existsSync(directory)) {
    if (required) throw new Error("Release does not contain the Excel capability pack")
    return
  }
  if (!lstatSync(directory).isDirectory() || !samePath(canonicalDirectory(directory), directory)) {
    throw new Error("Excel capability directory is redirected or not a directory")
  }
  const manifestPath = resolveContainedPath(directory, "manifest.json")
  const manifestBytes = readBounded(manifestPath)
  const manifest = ExcelManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")))
  if (JSON.stringify(manifest.tools) !== JSON.stringify(EXCEL_TOOLS)) {
    throw new Error("Excel capability tool inventory is not the exact sorted 25-tool contract")
  }
  const paths = {
    pyproject: resolveContainedPath(directory, manifest.files.pyproject),
    lock: resolveContainedPath(directory, manifest.files.lock),
    policy: resolveContainedPath(directory, manifest.files.policy),
    wrapper: resolveContainedPath(directory, manifest.files.wrapper),
    validator: resolveContainedPath(directory, manifest.files.validator),
  }
  for (const [name, path] of Object.entries(paths)) {
    if (!existsSync(path) || !lstatSync(path).isFile() || !samePath(realpathSync.native(path), path)) {
      throw new Error(`Excel capability ${name} file is missing or redirected`)
    }
    if (fileHash(path) !== manifest.files.sha256[name as keyof typeof manifest.files.sha256]) {
      throw new Error(`Excel capability ${name} hash differs from manifest`)
    }
  }
  const pyproject = readBounded(paths.pyproject).toString("utf8")
  if (pyproject !== EXCEL_PYPROJECT) {
    throw new Error("Excel capability pyproject must contain only the exact excel-mcp-server==0.1.8 project dependency and no extras, groups, markers, ranges, or alternate sources")
  }
  const lock = readBounded(paths.lock).toString("utf8")
  const upstreamBlocks = lock.split("[[package]]").filter((block) => /^\s*name = "excel-mcp-server"\s*$/m.test(block))
  if (upstreamBlocks.length !== 1 || !/^version = "0\.1\.8"\s*$/m.test(upstreamBlocks[0]!) ||
    !upstreamBlocks[0]!.includes("sha256:c75668094697152b9d749939c071ea02ac418635c8a11636396bd9797609f5a5")) {
    throw new Error("Excel capability lock does not bind the exact upstream version and wheel hash")
  }
  return {
    directory,
    manifestPath,
    lockPath: paths.lock,
    wrapperPath: paths.wrapper,
    validatorPath: paths.validator,
    manifestHash: sha256(manifestBytes),
    lockHash: sha256(readFileSync(paths.lock)),
    wrapperHash: sha256(readFileSync(paths.wrapper)),
    validatorHash: sha256(readFileSync(paths.validator)),
  }
}

function disabledExcelReceipt(assets: ExcelAssets): ExcelCapabilityReceipt {
  return {
    enabled: false,
    root: null,
    manifest_hash: assets.manifestHash,
    lock_hash: assets.lockHash,
    wrapper_hash: assets.wrapperHash,
    validator_hash: assets.validatorHash,
    env_path: null,
    env_hash: null,
    env_files: null,
    env_bytes: null,
    config_hash: null,
    managed_config: null,
  }
}

function managedConfigHash(config: ManagedExcelMcpConfig): string {
  return sha256(JSON.stringify(config))
}

function excelInterpreter(envPath: string): string {
  return resolveContainedPath(envPath, ...(process.platform === "win32" ? ["Scripts", "python.exe"] : ["bin", "python"]))
}

function canonicalExcelRoot(value: string, paths: ManagerPaths): string {
  if (!isAbsolute(value)) throw new Error("--excel-root must be absolute")
  const root = canonicalDirectory(resolve(value))
  if (isFilesystemRoot(root)) throw new Error("--excel-root must be a dedicated directory")
  if (isContained(paths.installRoot, root) || isContained(root, paths.installRoot) || samePath(root, paths.configRoot)) {
    throw new Error("--excel-root must not overlap the managed install root or equal the config root")
  }
  return root
}

function parseWrapperCheck(result: CommandResult): { version: string; toolCount: number } {
  let parsed: any
  try {
    parsed = JSON.parse(result.stdout)
  } catch {
    throw new Error("Excel wrapper --check did not emit one bounded JSON object")
  }
  if (parsed?.ok !== true || parsed?.distribution !== "excel-mcp-server" || parsed?.version !== EXCEL_UPSTREAM_VERSION ||
    parsed?.tool_count !== EXCEL_TOOLS.length || JSON.stringify(parsed?.tools) !== JSON.stringify(EXCEL_TOOLS) ||
    parsed?.remote_transports !== false || parsed?.path_policy?.ok !== true || parsed?.path_policy?.path_argument_confinement !== true) {
    throw new Error("Excel wrapper --check failed the exact runtime/version/tool/path contract")
  }
  return { version: parsed.version, toolCount: parsed.tool_count }
}

function runExcelWrapperCheck(
  runner: CommandRunner,
  interpreter: string,
  wrapper: string,
  cwd: string,
  root: string,
): { version: string; toolCount: number } {
  const result = command(runner, interpreter, [wrapper, "--check"], cwd, {
    ALG_EXCEL_ROOT: root,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONUTF8: "1",
  })
  return parseWrapperCheck(result)
}

function prepareExcelCapability(options: {
  packageRoot: string
  configPackageRoot: string
  generationId: string
  root: string
  paths: ManagerPaths
  dependencies: ManagerDependencies
}): ExcelCapabilityReceipt {
  const assets = excelAssets(options.packageRoot, true)!
  const existingConfigAssets = existsSync(options.configPackageRoot)
    ? excelAssets(options.configPackageRoot, true)!
    : undefined
  if (existingConfigAssets && (assets.lockHash !== existingConfigAssets.lockHash || assets.wrapperHash !== existingConfigAssets.wrapperHash ||
    assets.manifestHash !== existingConfigAssets.manifestHash || assets.validatorHash !== existingConfigAssets.validatorHash)) {
      throw new Error("Excel staged and target-generation capability assets disagree")
  }
  const configDirectory = existingConfigAssets?.directory ?? resolveContainedPath(options.configPackageRoot, "capabilities", EXCEL_CAPABILITY)
  const configWrapper = existingConfigAssets?.wrapperPath ?? resolveContainedPath(configDirectory, "wrapper.py")
  const root = canonicalExcelRoot(options.root, options.paths)
  const envPath = resolveContainedPath(options.paths.capabilityEnvsRoot, options.generationId, assets.lockHash, randomUUID())
  const runner = options.dependencies.runner ?? new DefaultCommandRunner()
  command(runner, "uv", ["--version"])
  assertDirectoryCreated(dirname(envPath))
  command(runner, "uv", ["sync", "--frozen", "--no-dev"], assets.directory, {
    UV_PROJECT_ENVIRONMENT: envPath,
    UV_NO_PROGRESS: "1",
  })
  if (!existsSync(envPath) || !samePath(canonicalDirectory(envPath), envPath)) {
    throw new Error("uv did not create the canonical lock-keyed Excel environment")
  }
  const interpreter = excelInterpreter(envPath)
  if (!existsSync(interpreter) || !statSync(interpreter).isFile()) {
    throw new Error("Excel environment interpreter is missing")
  }
  runExcelWrapperCheck(runner, interpreter, assets.wrapperPath, assets.directory, root)
  const environmentIdentity = computeManagedEnvironmentIdentity(envPath)
  const config: ManagedExcelMcpConfig = {
    type: "local",
    command: [interpreter, configWrapper],
    cwd: configDirectory,
    environment: { ALG_EXCEL_ROOT: root, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONUTF8: "1" },
    enabled: true,
    timeout: EXCEL_TIMEOUT_MS,
  }
  return {
    enabled: true,
    root,
    manifest_hash: assets.manifestHash,
    lock_hash: assets.lockHash,
    wrapper_hash: assets.wrapperHash,
    validator_hash: assets.validatorHash,
    env_path: envPath,
    env_hash: environmentIdentity.sha256,
    env_files: environmentIdentity.files,
    env_bytes: environmentIdentity.bytes,
    config_hash: managedConfigHash(config),
    managed_config: config,
  }
}

function dependencyPath(root: string, dependency: string): string {
  return resolveContainedPath(root, ...dependency.split("/"))
}

export interface ProductionDependencyIdentityOptions {
  maxEntries?: number
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
  maxDepth?: number
}

const DEFAULT_DEPENDENCY_IDENTITY_LIMITS = {
  maxEntries: 50_000,
  maxFiles: 40_000,
  maxFileBytes: 16 * 1024 * 1024,
  maxTotalBytes: 256 * 1024 * 1024,
  maxDepth: 64,
} as const

function dependencyHashFrame(hash: ReturnType<typeof createHash>, fields: readonly (string | Uint8Array)[]): void {
  for (const field of fields) {
    const bytes = typeof field === "string" ? Buffer.from(field, "utf8") : Buffer.from(field)
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(bytes.byteLength))
    hash.update(length).update(bytes)
  }
}

/** Same-install identity for every production node_modules entry produced by npm ci. */
export function computeProductionDependencyIdentity(
  root: string,
  expectedDependencies: readonly string[],
  options: ProductionDependencyIdentityOptions = {},
): ProductionDependencyIdentity {
  const limits = {
    maxEntries: options.maxEntries ?? DEFAULT_DEPENDENCY_IDENTITY_LIMITS.maxEntries,
    maxFiles: options.maxFiles ?? DEFAULT_DEPENDENCY_IDENTITY_LIMITS.maxFiles,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_DEPENDENCY_IDENTITY_LIMITS.maxFileBytes,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_DEPENDENCY_IDENTITY_LIMITS.maxTotalBytes,
    maxDepth: options.maxDepth ?? DEFAULT_DEPENDENCY_IDENTITY_LIMITS.maxDepth,
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Production dependency ${name} must be a positive safe integer`)
  }
  const modules = resolveContainedPath(root, "node_modules")
  const hash = createHash("sha256")
  dependencyHashFrame(hash, ["opencode-alg-production-dependencies-v1"])
  if (!existsSync(modules)) {
    if (expectedDependencies.length) throw new Error("Release dependencies are missing")
    return { sha256: hash.digest("hex"), files: 0, bytes: 0 }
  }
  const rootStat = lstatSync(modules)
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !samePath(realpathSync.native(modules), modules)) {
    throw new Error("Release node_modules is redirected or not a directory")
  }
  let entries = 0
  let files = 0
  let bytes = 0
  const ambiguous = new Set<string>()
  const visit = (directory: string, prefix: string, depth: number): void => {
    if (depth > limits.maxDepth) throw new Error(`Production dependency tree exceeds depth ${limits.maxDepth}`)
    const children = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    for (const child of children) {
      if (!child.name || child.name === "." || child.name === ".." || /[\\/\0]/.test(child.name)) {
        throw new Error("Production dependency tree contains an ambiguous path component")
      }
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name
      if (Buffer.byteLength(relativePath, "utf8") > 4_096) throw new Error("Production dependency path exceeds 4096 bytes")
      const ambiguityKey = (process.platform === "win32" ? relativePath.toLowerCase() : relativePath).normalize("NFC")
      if (ambiguous.has(ambiguityKey)) throw new Error(`Production dependency path ambiguity: ${relativePath}`)
      ambiguous.add(ambiguityKey)
      entries++
      if (entries > limits.maxEntries) throw new Error(`Production dependency tree exceeds ${limits.maxEntries} entries`)
      const path = join(directory, child.name)
      const stat = lstatSync(path)
      const mode = String(stat.mode & 0o777)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path)
        if (!target || target.includes("\0")) throw new Error(`Production dependency link target is invalid: ${relativePath}`)
        const canonicalTarget = realpathSync.native(path)
        if (!isContained(modules, canonicalTarget)) throw new Error(`Production dependency link escapes node_modules: ${relativePath}`)
        const targetRelative = relative(modules, canonicalTarget).replaceAll("\\", "/")
        dependencyHashFrame(hash, ["link", relativePath, mode, target.replaceAll("\\", "/"), targetRelative])
        continue
      }
      if (stat.isDirectory()) {
        const canonical = realpathSync.native(path)
        if (!samePath(canonical, path) || !isContained(modules, canonical)) throw new Error(`Production dependency directory is redirected: ${relativePath}`)
        dependencyHashFrame(hash, ["directory", relativePath, mode])
        visit(path, relativePath, depth + 1)
        continue
      }
      if (!stat.isFile()) throw new Error(`Production dependency has unsupported file type: ${relativePath}`)
      if (stat.size > limits.maxFileBytes) throw new Error(`Production dependency file exceeds ${limits.maxFileBytes} bytes: ${relativePath}`)
      if (bytes + stat.size > limits.maxTotalBytes) throw new Error(`Production dependency tree exceeds ${limits.maxTotalBytes} bytes`)
      files++
      if (files > limits.maxFiles) throw new Error(`Production dependency tree exceeds ${limits.maxFiles} files`)
      const canonical = realpathSync.native(path)
      if (!samePath(canonical, path) || !isContained(modules, canonical)) throw new Error(`Production dependency file is redirected: ${relativePath}`)
      const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
      const descriptor = openSync(path, constants.O_RDONLY | noFollow)
      try {
        const opened = fstatSync(descriptor)
        if (!opened.isFile() || opened.size !== stat.size || opened.dev !== stat.dev || opened.ino !== stat.ino) {
          throw new Error(`Production dependency file changed during identity: ${relativePath}`)
        }
        const content = readFileSync(descriptor)
        const after = fstatSync(descriptor)
        if (content.byteLength !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
          throw new Error(`Production dependency file changed during identity: ${relativePath}`)
        }
        dependencyHashFrame(hash, ["file", relativePath, mode, String(content.byteLength), content])
        bytes += content.byteLength
      } finally {
        closeSync(descriptor)
      }
    }
  }
  visit(modules, "", 1)
  for (const dependency of expectedDependencies) {
    const path = dependencyPath(modules, dependency)
    if (!existsSync(path) || (!lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink()) || !isContained(modules, realpathSync.native(path))) {
      throw new Error(`Required dependency is missing or escapes node_modules: ${dependency}`)
    }
  }
  return { sha256: hash.digest("hex"), files, bytes }
}

function computeManagedEnvironmentIdentity(environmentRoot: string): ProductionDependencyIdentity {
  const root = canonicalDirectory(environmentRoot)
  if (!samePath(root, environmentRoot)) throw new Error("Managed capability environment is redirected")
  const hash = createHash("sha256")
  dependencyHashFrame(hash, ["opencode-alg-managed-environment-v1"])
  let entries = 0
  let files = 0
  let bytes = 0
  const ambiguous = new Set<string>()
  const visit = (directory: string, prefix: string, depth: number): void => {
    if (depth > 96) throw new Error("Managed capability environment exceeds depth 96")
    for (const child of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!child.name || child.name === "." || child.name === ".." || /[\\/\0]/.test(child.name)) throw new Error("Managed capability environment has an ambiguous path")
      const relativePath = prefix ? `${prefix}/${child.name}` : child.name
      const key = (process.platform === "win32" ? relativePath.toLowerCase() : relativePath).normalize("NFC")
      if (ambiguous.has(key)) throw new Error(`Managed capability environment path ambiguity: ${relativePath}`)
      ambiguous.add(key)
      if (++entries > 100_000) throw new Error("Managed capability environment exceeds 100000 entries")
      const path = join(directory, child.name)
      const stat = lstatSync(path)
      const mode = String(stat.mode & 0o777)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(path)
        const canonicalTarget = realpathSync.native(path)
        if (!isContained(root, canonicalTarget)) throw new Error(`Managed capability environment link escapes: ${relativePath}`)
        dependencyHashFrame(hash, ["link", relativePath, mode, target.replaceAll("\\", "/"), relative(root, canonicalTarget).replaceAll("\\", "/")])
      } else if (stat.isDirectory()) {
        if (!samePath(realpathSync.native(path), path)) throw new Error(`Managed capability environment directory is redirected: ${relativePath}`)
        dependencyHashFrame(hash, ["directory", relativePath, mode])
        visit(path, relativePath, depth + 1)
      } else if (stat.isFile()) {
        if (stat.size > 64 * 1024 * 1024 || bytes + stat.size > 1024 * 1024 * 1024) throw new Error("Managed capability environment exceeds byte bounds")
        if (++files > 80_000) throw new Error("Managed capability environment exceeds 80000 files")
        if (!samePath(realpathSync.native(path), path)) throw new Error(`Managed capability environment file is redirected: ${relativePath}`)
        const content = readFileSync(path)
        if (content.byteLength !== stat.size || lstatSync(path).mtimeMs !== stat.mtimeMs) throw new Error(`Managed capability environment changed during identity: ${relativePath}`)
        dependencyHashFrame(hash, ["file", relativePath, mode, String(content.byteLength), content])
        bytes += content.byteLength
      } else throw new Error(`Managed capability environment has unsupported type: ${relativePath}`)
    }
  }
  visit(root, "", 1)
  return { sha256: hash.digest("hex"), files, bytes }
}

function validateRecordedExcelEnvironment(
  generation: ReleaseGeneration,
  paths: ManagerPaths,
  dependencies: ManagerDependencies,
  requireLiveOwnership: boolean,
): void {
  const excel = generation.capabilities?.excel
  if (!excel?.enabled) return
  const assets = excelAssets(generation.package_root, true)!
  if (assets.manifestHash !== excel.manifest_hash || assets.lockHash !== excel.lock_hash ||
    assets.wrapperHash !== excel.wrapper_hash || assets.validatorHash !== excel.validator_hash) {
    throw new Error("Recorded Excel capability assets differ from its generation")
  }
  const envPath = excel.env_path!
  const relativeEnv = relative(paths.capabilityEnvsRoot, envPath).replaceAll("\\", "/").split("/")
  if (relativeEnv.length !== 3 || relativeEnv[0] !== generation.id || relativeEnv[1] !== excel.lock_hash ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(relativeEnv[2]!) ||
    !existsSync(envPath) || !samePath(canonicalDirectory(envPath), envPath)) {
    throw new Error("Recorded Excel environment path is missing, redirected, or not activation-specific")
  }
  const identity = computeManagedEnvironmentIdentity(envPath)
  if (identity.sha256 !== excel.env_hash || identity.files !== excel.env_files || identity.bytes !== excel.env_bytes) {
    throw new Error("Recorded Excel environment identity has drifted")
  }
  const interpreter = excelInterpreter(envPath)
  const config = excel.managed_config!
  if (!existsSync(interpreter) || !statSync(interpreter).isFile() || !samePath(config.command[0], interpreter) ||
    !samePath(config.command[1], assets.wrapperPath) || !samePath(config.cwd, assets.directory) ||
    !excel.root || !samePath(config.environment.ALG_EXCEL_ROOT, excel.root) || managedConfigHash(config) !== excel.config_hash) {
    throw new Error("Recorded Excel environment/config identity is invalid")
  }
  runExcelWrapperCheck(dependencies.runner ?? new DefaultCommandRunner(), interpreter, assets.wrapperPath, assets.directory, excel.root)
  if (requireLiveOwnership) {
    const entry = excelConfigEntry(paths.serverConfig)
    if (!entry.present || entry.invalid || !sameJson(entry.value, config)) throw new Error("Active Excel config is missing, custom, or drifted")
  }
}

function agentSources(root: string): ReleaseGeneration["agents"] {
  const directory = resolveContainedPath(root, "agents")
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .sort()
  if (JSON.stringify(names) !== JSON.stringify(BUNDLED_AGENT_NAMES)) throw new Error("Release bundled agent inventory is not exact")
  return (names as BundledAgentName[])
    .map((name) => ({ name, source_hash: sha256(readFileSync(resolveContainedPath(directory, name))) }))
}

function validateReleaseRoot(root: string, tag: string, runner: CommandRunner, expectedCommit?: string): ReleaseGeneration {
  const packageInfo = validatePackageAndLock(root, tag)
  const assets = excelAssets(root, compareVersions(packageInfo.version, "0.2.0") >= 0)
  const commit = git(runner, root, ["rev-parse", "HEAD"]).toLowerCase()
  if (expectedCommit && commit !== expectedCommit) throw new Error("Retained release commit does not match its receipt")
  const tagCommit = git(runner, root, ["rev-parse", `${tag}^{commit}`]).toLowerCase()
  if (tagCommit !== commit) throw new Error("Retained release HEAD does not match its exact tag")
  const identity = computeAlgSourceIdentity(root)
  const productionDependencies = computeProductionDependencyIdentity(root, packageInfo.dependencies)
  const timestamp = new Date().toISOString()
  return {
    id: `${packageInfo.version}-${commit.slice(0, 12)}`,
    version: packageInfo.version,
    tag,
    commit,
    package_root: canonicalDirectory(root),
    spec: pathToFileURL(canonicalDirectory(root)).href.replace(/\/$/, ""),
    runtime_digest: identity.digest,
    lock_digest: packageInfo.lockDigest,
    installed_at: timestamp,
    activated_at: timestamp,
    dependency_manager: "npm",
    production_dependencies: productionDependencies,
    agents: agentSources(root),
    durable_state: packageInfo.durableState,
    capabilities: assets ? { excel: disabledExcelReceipt(assets) } : undefined,
  }
}

function selectTag(runner: CommandRunner, clone: string, options: ManagerOptions, source?: string): string {
  const explicit = requestedTag(options)
  if (explicit) return explicit
  if (source) {
    const pkg = parsePackage(source)
    if (typeof pkg.version !== "string") throw new Error("Local source package version is invalid")
    return assertStableTag(`v${pkg.version}`)
  }
  const tags = git(runner, clone, ["tag", "--list", "v*"])
    .split(/\r?\n/)
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort((left, right) => compareVersions(left.slice(1), right.slice(1)))
  const tag = tags.at(-1)
  if (!tag) throw new Error("Remote has no exact stable vMAJOR.MINOR.PATCH tag")
  return tag
}

function stageRelease(
  options: ManagerOptions,
  paths: ManagerPaths,
  receipt: ManagerReceipt | undefined,
  dependencies: ManagerDependencies,
): StagedRelease {
  const runner = dependencies.runner ?? new DefaultCommandRunner()
  let source: string | undefined
  let trustedRemote: string
  if (options.source) {
    source = canonicalDirectory(resolve(options.source))
    if (isContained(paths.configRoot, source) || isContained(source, paths.configRoot) || isContained(paths.installRoot, source) || isContained(source, paths.installRoot)) {
      throw new Error("Local source overlaps managed config/install roots")
    }
    assertCleanRepository(runner, source, "Local source")
    trustedRemote = sourceRemote(runner, source)
    if (options.remote && !remoteEqual(options.remote, trustedRemote)) throw new Error("--remote does not match local source origin")
  } else {
    trustedRemote = sanitizeRemote(options.remote ?? receipt?.trusted_remote ?? DEFAULT_REMOTE)
  }
  if (receipt && !remoteEqual(receipt.trusted_remote, trustedRemote)) throw new Error("Trusted remote does not match the receipt")

  const transaction = randomUUID()
  const stagingPath = resolveContainedPath(paths.stagingRoot, transaction)
  if (existsSync(stagingPath)) throw new Error("Staging transaction collision")
  const cloneRemote = source ?? trustedRemote
  command(runner, "git", ["clone", "--no-checkout", "--", cloneRemote, stagingPath])
  const stagingIdentity = regularDirectoryIdentity(stagingPath)
  try {
    git(runner, stagingPath, ["remote", "set-url", "origin", trustedRemote])
    const tag = selectTag(runner, stagingPath, options, source)
    const commit = git(runner, stagingPath, ["rev-parse", `${tag}^{commit}`]).toLowerCase()
    if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error(`Unable to resolve exact commit for ${tag}`)
    if (source) {
      const sourceHead = git(runner, source, ["rev-parse", "HEAD"]).toLowerCase()
      if (sourceHead !== commit) throw new Error(`Local source HEAD is not the exact ${tag} commit`)
    }
    git(runner, stagingPath, ["checkout", "--detach", commit])
    assertCleanRepository(runner, stagingPath, "Staged release")
    if (receipt?.installed && options.command === "update") {
      const active = receipt.generations.find((item) => item.id === receipt.active_generation)
      if (!active) throw new Error("Receipt active generation is unavailable")
      const ancestor = runner.run({ command: "git", args: ["-C", stagingPath, "merge-base", "--is-ancestor", active.commit, commit] })
      if (ancestor.exitCode !== 0) throw new Error("Stable update target is not a descendant of the active commit")
    }
    const packageInfo = validatePackageAndLock(stagingPath, tag)
    const beforeLock = packageInfo.lockDigest
    const npm = resolveNpmInvocation()
    command(runner, npm.executable, [...npm.argsPrefix, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stagingPath)
    const afterInfo = validatePackageAndLock(stagingPath, tag)
    if (afterInfo.lockDigest !== beforeLock) throw new Error("Dependency installation modified package-lock.json")
    assertCleanRepository(runner, stagingPath, "Dependency-installed release")
    const productionDependencies = computeProductionDependencyIdentity(stagingPath, afterInfo.dependencies)
    const identity = computeAlgSourceIdentity(stagingPath)
    const assets = excelAssets(stagingPath, compareVersions(afterInfo.version, "0.2.0") >= 0)
    const timestamp = nowIso(dependencies)
    const id = `${afterInfo.version}-${commit.slice(0, 12)}`
    const finalPath = resolveContainedPath(paths.releasesRoot, id)
    const packagePath = resolveContainedPath(finalPath, "package")
    const generation: ReleaseGeneration = {
      id,
      version: afterInfo.version,
      tag,
      commit,
      package_root: packagePath,
      spec: pathToFileURL(packagePath).href.replace(/\/$/, ""),
      runtime_digest: identity.digest,
      lock_digest: afterInfo.lockDigest,
      installed_at: timestamp,
      activated_at: timestamp,
      dependency_manager: "npm",
      production_dependencies: productionDependencies,
      agents: agentSources(stagingPath),
      durable_state: afterInfo.durableState,
      capabilities: assets ? { excel: disabledExcelReceipt(assets) } : undefined,
    }
    const stagingEntries = snapshotGenerationTree(stagingPath)
    return { stagingPath, finalPath, generation, trustedRemote, stagingIdentity, stagingEntries }
  } catch (error) {
    // A failed external staging command may have introduced paths we never
    // created or identity-recorded. Preserve the exclusive tree for doctor and
    // manual inspection rather than snapshotting/adopting then deleting it.
    throw new Error(`Release staging failed; exclusive staging tree preserved for inspection at ${stagingPath}: ${safeMessage(error instanceof Error ? error.message : String(error))}`)
  }
}

function pluginSpec(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  return Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : undefined
}

function pluginSpecs(path: string): string[] {
  if (!existsSync(path)) return []
  const decoded = readConfigTextFile(path)
  const value = parseJsoncObject(decoded.text, path)
  if (value.plugin === undefined) return []
  if (!Array.isArray(value.plugin)) throw new Error(`Expected "plugin" to be an array in ${path}`)
  return value.plugin.map(pluginSpec).filter((item): item is string => item !== undefined)
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

function excelConfigEntry(path: string): { present: boolean; value?: unknown; invalid?: string } {
  if (!existsSync(path)) return { present: false }
  try {
    const decoded = readConfigTextFile(path)
    const value = parseJsoncObject(decoded.text, path)
    if (value.mcp === undefined) return { present: false }
    if (!value.mcp || typeof value.mcp !== "object" || Array.isArray(value.mcp)) {
      return { present: true, value: value.mcp, invalid: "mcp is not an object" }
    }
    const mcp = value.mcp as Record<string, unknown>
    return mcp.alg_excel === undefined ? { present: false } : { present: true, value: mcp.alg_excel }
  } catch (error) {
    return { present: true, invalid: safeMessage(error instanceof Error ? error.message : String(error)) }
  }
}

function normalizedSpec(spec: string): string {
  if (!spec.startsWith("file://")) return spec.replace(/\/$/, "")
  try {
    const path = normalizedPath(fileURLToPath(spec))
    return `file://${path.replaceAll("\\", "/").replace(/\/$/, "")}`
  } catch {
    return spec.replace(/\/$/, "")
  }
}

function specMatches(left: string, right: string): boolean {
  return normalizedSpec(left) === normalizedSpec(right)
}

function sourceKnownSpecs(source: string | undefined): string[] {
  if (!source) return []
  const root = pathToFileURL(source).href.replace(/\/$/, "")
  return [
    root,
    `${root}/`,
    pathToFileURL(join(source, "src", "index.ts")).href,
    pathToFileURL(join(source, "src", "server.ts")).href,
    pathToFileURL(join(source, "src", "tui.ts")).href,
  ]
}

function assertNoUnknownManagedRegistration(path: string, specs: readonly string[], paths: ManagerPaths): void {
  const known = new Set(specs.map(normalizedSpec))
  for (const spec of pluginSpecs(path)) {
    if (known.has(normalizedSpec(spec)) || !spec.startsWith("file://")) continue
    try {
      const candidate = resolve(fileURLToPath(spec))
      if (isContained(paths.releasesRoot, candidate)) {
        throw new Error(`Ambiguous unreceipted ALG release registration in ${path}`)
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Ambiguous")) throw error
    }
  }
}

function validatePlannedRegistration(plan: TextFilePlan, target: string | undefined, known: readonly string[]): void {
  const value = plan.after ? parseJsonc(plan.after) as any : {}
  const specs = Array.isArray(value?.plugin) ? value.plugin.map(pluginSpec).filter(Boolean) as string[] : []
  if (target) {
    if (specs.filter((spec) => specMatches(spec, target)).length !== 1) {
      throw new Error(`Config plan does not contain exactly one target ALG registration: ${plan.path}`)
    }
    for (const spec of specs) {
      if (known.some((item) => specMatches(item, spec)) && !specMatches(spec, target)) {
        throw new Error(`Config plan retained a previous ALG registration: ${plan.path}`)
      }
    }
  } else if (specs.some((spec) => known.some((item) => specMatches(item, spec)))) {
    throw new Error(`Uninstall plan retained an ALG registration: ${plan.path}`)
  }
}

function configPlans(
  paths: ManagerPaths,
  receipt: ManagerReceipt | undefined,
  targetSpec: string | undefined,
  source: string | undefined,
  uninstall: boolean,
  excelDesired?: ManagedExcelMcpConfig,
  excelPrior?: ManagedExcelMcpConfig,
): { plans: TextFilePlan[]; excelStatus: "managed" | "missing" | "custom" } {
  const known = [
    ...(receipt?.generations.map((item) => item.spec) ?? []),
    ...(receipt?.server_registration.spec ? [receipt.server_registration.spec] : []),
    ...(receipt?.tui_registration.spec ? [receipt.tui_registration.spec] : []),
    ...sourceKnownSpecs(source),
    ...(targetSpec ? [targetSpec] : []),
    "opencode-alg",
  ]
  assertNoUnknownManagedRegistration(paths.serverConfig, known, paths)
  assertNoUnknownManagedRegistration(paths.tuiConfig, known, paths)

  if (receipt?.installed) {
    const activeSpec = receipt.server_registration.spec!
    for (const path of [paths.serverConfig, paths.tuiConfig]) {
      const count = pluginSpecs(path).filter((spec) => specMatches(spec, activeSpec)).length
      if (count !== 1) throw new Error(`Managed registration is missing or ambiguous in ${path}`)
    }
  } else {
    for (const path of [paths.serverConfig, paths.tuiConfig]) {
      const count = pluginSpecs(path).filter((spec) => known.some((item) => specMatches(item, spec))).length
      if (count > 1) throw new Error(`Ambiguous ALG registrations in ${path}`)
    }
  }

  const desired = targetSpec ?? receipt?.server_registration.spec ?? "opencode-alg"
  const serverBase = planPluginConfig({
      path: paths.serverConfig,
      desiredSpec: desired,
      knownSpecs: known,
      schema: SERVER_SCHEMA,
      uninstall,
    })
  const excelPlan = planManagedMcpConfig({
    path: paths.serverConfig,
    base: serverBase,
    desired: excelDesired,
    priorManaged: excelPrior,
  })
  const plans = [
    excelPlan.plan,
    planPluginConfig({
      path: paths.tuiConfig,
      desiredSpec: desired,
      knownSpecs: known,
      schema: TUI_SCHEMA,
      uninstall,
    }),
  ]
  for (const plan of plans) validatePlannedRegistration(plan, targetSpec, known)
  return { plans, excelStatus: excelPlan.status }
}

function textToBinary(plan: TextFilePlan): BinaryPlan {
  return {
    path: plan.path,
    kind: "config",
    before: plan.before === undefined ? undefined : encodeConfigText(plan.before, plan.encoding),
    beforeIdentity: plan.expectedIdentity,
    after: plan.changed ? encodeConfigText(plan.after, plan.encoding) : plan.before === undefined ? undefined : encodeConfigText(plan.before, plan.encoding),
    action: plan.changed ? (plan.before === undefined ? "created" : "updated") : "unchanged",
  }
}

function currentAgentReceipt(
  path: string,
  sourceHash: string,
  disposition: ManagedAgentReceipt["disposition"],
  managedHash: string | null,
  timestamp: string,
): ManagedAgentReceipt {
  const current = fileHash(path)
  return {
    path,
    disposition: current === null ? "missing" : disposition,
    source_hash: sourceHash,
    current_hash: current,
    managed_hash: current === null || disposition !== "managed" ? null : managedHash,
    updated_at: timestamp,
  }
}

function planAgents(options: {
  command: ManagerCommand
  policy: AgentPolicy
  removeAgents: boolean
  paths: ManagerPaths
  targetRoot?: string
  targetGeneration?: ReleaseGeneration
  receipt?: ManagerReceipt
  adoptionRoot?: string
  timestamp: string
}): { plans: BinaryPlan[]; receipts: Record<string, ManagedAgentReceipt>; results: NonNullable<ManagerResult["agents"]> } {
  assertManagedAgentsRoot(options.paths)
  const plans: BinaryPlan[] = []
  const receipts: Record<string, ManagedAgentReceipt> = {}
  const results: NonNullable<ManagerResult["agents"]> = []
  const sources = options.targetGeneration?.agents ?? []
  const names = new Set<BundledAgentName>([
    ...sources.map((item) => item.name),
    ...Object.keys(options.receipt?.agents ?? {}) as BundledAgentName[],
  ])
  for (const name of [...names].sort()) {
    const target = resolveContainedPath(options.paths.agentsRoot, name)
    assertManagedAgentTarget(target)
    const source = sources.find((item) => item.name === name)
    const sourceHash = source?.source_hash ?? options.receipt?.agents[name]?.source_hash
    if (!sourceHash) continue
    const stableBefore = existsSync(target) ? readStableRegularFile(target) : undefined
    const before = stableBefore?.bytes
    const beforeHash = before ? sha256(before) : null
    const prior = options.receipt?.agents[name]

    if (options.command === "uninstall") {
      const removable = options.removeAgents && prior?.disposition === "managed" && beforeHash === prior.managed_hash
      if (removable) {
        plans.push({ path: target, kind: "agent", before, beforeIdentity: stableBefore?.identity ?? null, after: undefined, action: "removed" })
        results.push({ path: target, action: "removed" })
        receipts[name] = {
          path: target,
          disposition: "missing",
          source_hash: sourceHash,
          current_hash: null,
          managed_hash: null,
          updated_at: options.timestamp,
        }
      } else {
        const disposition = beforeHash === null ? "missing" : prior?.disposition === "managed" && beforeHash === prior.managed_hash ? "managed" : "custom"
        receipts[name] = currentAgentReceipt(target, sourceHash, disposition, disposition === "managed" ? beforeHash : null, options.timestamp)
        results.push({ path: target, action: beforeHash === null ? "missing" : "unchanged" })
      }
      continue
    }

    if (!source || !options.targetRoot) throw new Error(`Target release does not contain receipt agent ${name}`)
    const sourcePath = resolveContainedPath(options.targetRoot, "agents", name)
    const after = readFileSync(sourcePath)
    if (sha256(after) !== source.source_hash) throw new Error(`Target agent hash changed during preflight: ${name}`)
    const exactTarget = beforeHash === source.source_hash
    let mayUpdate = false
    let adoptedPriorBundle = false
    if (options.command === "rollback") {
      mayUpdate = Boolean(prior?.disposition === "managed" && beforeHash === prior.managed_hash)
    } else if (options.policy === "force") {
      mayUpdate = true
    } else if (options.policy === "managed") {
      mayUpdate = beforeHash === null || Boolean(prior?.disposition === "managed" && beforeHash === prior.managed_hash)
      if (!mayUpdate && options.adoptionRoot && beforeHash) {
        const priorPath = resolveContainedPath(options.adoptionRoot, "agents", name)
        adoptedPriorBundle = existsSync(priorPath) && sha256(readFileSync(priorPath)) === beforeHash
        mayUpdate = adoptedPriorBundle
      }
    }

    if (exactTarget) {
      const mayOwn = options.policy === "force" ||
        (options.policy === "managed" && (
          Boolean(prior?.disposition === "managed" && beforeHash === prior.managed_hash) || adoptedPriorBundle
        ))
      receipts[name] = currentAgentReceipt(
        target,
        source.source_hash,
        mayOwn ? "managed" : "custom",
        mayOwn ? source.source_hash : null,
        options.timestamp,
      )
      results.push({
        path: target,
        action: options.policy === "force" && prior?.disposition !== "managed"
          ? "adopted"
          : prior?.disposition === "managed" && !mayOwn
            ? "ownership-released"
            : mayOwn ? "unchanged" : "skipped",
      })
    } else if (options.policy !== "skip" && mayUpdate) {
      const action = before ? "updated" : "created"
      plans.push({ path: target, kind: "agent", before, beforeIdentity: stableBefore?.identity ?? null, after, action })
      receipts[name] = {
        path: target,
        disposition: "managed",
        source_hash: source.source_hash,
        current_hash: source.source_hash,
        managed_hash: source.source_hash,
        updated_at: options.timestamp,
      }
      results.push({ path: target, action })
    } else {
      const disposition = beforeHash === null ? "missing" : "custom"
      receipts[name] = currentAgentReceipt(target, source.source_hash, disposition, null, options.timestamp)
      results.push({ path: target, action: disposition === "missing" ? "missing" : "skipped" })
    }
  }
  return { plans, receipts, results }
}

function assertBinaryUnchanged(plan: BinaryPlan): void {
  const current = existsSync(plan.path) ? readStableRegularFile(plan.path) : undefined
  if (plan.before === undefined) {
    if (plan.beforeIdentity !== null) throw new Error(`Expected-absent plan has an identity at ${plan.path}`)
    if (current !== undefined) throw new Error(`Concurrent creation detected at ${plan.path}`)
  } else if (plan.beforeIdentity === null || !current?.bytes.equals(plan.before) || !sameFileIdentity(current.identity, plan.beforeIdentity)) {
    throw new Error(`Concurrent byte change detected at ${plan.path}`)
  }
}

const journalRevisionBytes = new WeakMap<ManagerJournal, Buffer>()
const journalArtifactPaths = new WeakMap<ManagerJournal, string[]>()
const journalArtifactIdentities = new WeakMap<ManagerJournal, Map<string, FileIdentity>>()
const journalArtifactHashes = new WeakMap<ManagerJournal, Map<string, string>>()

function journalAnchorPath(path: string): string {
  return basename(dirname(path)) === "transactions"
    ? resolveContainedPath(dirname(dirname(path)), `.journal-${basename(path)}.anchor`)
    : `${path}.anchor`
}

function journalRevisionPath(base: string, revision: number): string {
  return resolveContainedPath(dirname(dirname(base)), `.journal-${basename(base, ".json")}.revision-${String(revision).padStart(3, "0")}.json`)
}

function publishImmutableJournalPair(path: string, bytes: Buffer, dependencies: ManagerDependencies): string[] {
  const link = dependencies.link ?? linkSync
  const unlink = dependencies.unlink ?? unlinkSync
  const temporary = `${path}.tmp-${randomUUID()}`
  const anchor = journalAnchorPath(path)
  writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 })
  const identity = regularFileIdentity(temporary)
  let finalCreated = false
  try {
    link(temporary, path)
    finalCreated = true
    link(temporary, anchor)
    for (const candidate of [path, anchor]) {
      if (fileHash(candidate) !== sha256(bytes) || !sameFileIdentity(regularFileIdentity(candidate), identity)) throw new Error(`Journal pair identity differs: ${candidate}`)
    }
    unlinkOwnedRegularFile(temporary, sha256(bytes), identity, unlink)
    return [path, anchor]
  } catch (error) {
    if (finalCreated && existsSync(path)) {
      try { unlinkOwnedRegularFile(path, sha256(bytes), identity, unlink) } catch { /* preserve ambiguity */ }
    }
    if (existsSync(temporary)) {
      try { unlinkOwnedRegularFile(temporary, sha256(bytes), identity, unlink) } catch { /* preserve ambiguity */ }
    }
    throw new Error(`Journal no-clobber publication failed: ${safeMessage(error instanceof Error ? error.message : String(error))}`)
  }
}

function initializeJournal(path: string, journal: ManagerJournal, dependencies: ManagerDependencies): void {
  const parsed = ManagerJournalSchema.parse(journal)
  const bytes = jsonBytes(parsed)
  const artifacts = publishImmutableJournalPair(path, bytes, dependencies)
  journalRevisionBytes.set(journal, bytes)
  journalArtifactPaths.set(journal, artifacts)
  journalArtifactIdentities.set(journal, new Map(artifacts.map((artifact) => [artifact, regularFileIdentity(artifact)])))
  journalArtifactHashes.set(journal, new Map(artifacts.map((artifact) => [artifact, sha256(bytes)])))
}

function assertJournalArtifactsCurrent(journal: ManagerJournal): void {
  const artifacts = journalArtifactPaths.get(journal)
  const identities = journalArtifactIdentities.get(journal)
  const hashes = journalArtifactHashes.get(journal)
  if (!artifacts || !identities || !hashes) throw new Error("Journal artifact state is unavailable")
  for (const artifact of artifacts) {
    if (!existsSync(artifact)) throw new Error(`Journal artifact disappeared: ${artifact}`)
    const expectedIdentity = identities.get(artifact)
    if (!expectedIdentity || !sameFileIdentity(regularFileIdentity(artifact), expectedIdentity) || fileHash(artifact) !== hashes.get(artifact)) {
      throw new Error(`Journal artifact identity or bytes changed: ${artifact}`)
    }
  }
}

function publishJournalRevision(path: string, journal: ManagerJournal, dependencies: ManagerDependencies): void {
  assertJournalArtifactsCurrent(journal)
  const previous = journalRevisionBytes.get(journal)
  if (!previous) throw new Error("Journal previous revision bytes are unavailable")
  journal.revision += 1
  journal.previous_revision_sha256 = sha256(previous)
  const parsed = ManagerJournalSchema.parse(journal)
  const bytes = jsonBytes(parsed)
  const revisionPath = journalRevisionPath(path, journal.revision)
  const artifacts = publishImmutableJournalPair(revisionPath, bytes, dependencies)
  journalRevisionBytes.set(journal, bytes)
  journalArtifactPaths.set(journal, [...(journalArtifactPaths.get(journal) ?? []), ...artifacts])
  const identities = journalArtifactIdentities.get(journal) ?? new Map<string, FileIdentity>()
  for (const artifact of artifacts) identities.set(artifact, regularFileIdentity(artifact))
  journalArtifactIdentities.set(journal, identities)
  const hashes = journalArtifactHashes.get(journal) ?? new Map<string, string>()
  for (const artifact of artifacts) hashes.set(artifact, sha256(bytes))
  journalArtifactHashes.set(journal, hashes)
}

function setJournalPhase(
  path: string,
  journal: ManagerJournal,
  phase: ManagerJournal["phase"],
  dependencies: ManagerDependencies,
): void {
  journal.phase = phase
  journal.updated_at = nowIso(dependencies)
  publishJournalRevision(path, journal, dependencies)
  dependencies.faults?.afterJournalPhase?.(phase)
  assertJournalArtifactsCurrent(journal)
}

function cleanupJournalArtifacts(path: string, journal: ManagerJournal, dependencies: ManagerDependencies): void {
  const unlink = dependencies.unlink ?? unlinkSync
  const artifacts = journalArtifactPaths.get(journal)
  const identities = journalArtifactIdentities.get(journal)
  const hashes = journalArtifactHashes.get(journal)
  if (!artifacts?.length || !identities || !hashes) throw new Error("Journal artifact identity set is unavailable")
  dependencies.faults?.beforeJournalCleanup?.(path)
  assertJournalArtifactsCurrent(journal)
  const ordered = artifacts.filter((item) => item !== path && item !== journalAnchorPath(path)).reverse()
  ordered.push(journalAnchorPath(path), path)
  for (const artifact of ordered) {
    if (!existsSync(artifact)) continue
    const identity = regularFileIdentity(artifact)
    const expectedIdentity = identities.get(artifact)
    if (!expectedIdentity || !sameFileIdentity(identity, expectedIdentity)) throw new Error(`Journal artifact identity changed: ${artifact}`)
    const peer = [...identities].find(([candidate, candidateIdentity]) => candidate !== artifact && sameFileIdentity(candidateIdentity, expectedIdentity))?.[0]
    if (peer && existsSync(peer) && !sameFileIdentity(identity, regularFileIdentity(peer))) throw new Error(`Journal artifact pair identity changed: ${artifact}`)
    const bytes = readFileSync(artifact)
    if (sha256(bytes) !== hashes.get(artifact)) throw new Error(`Journal artifact bytes changed: ${artifact}`)
    ManagerJournalSchema.parse(JSON.parse(bytes.toString("utf8")))
    unlink(artifact)
  }
}

type JournalFile = ManagerJournal["files"][number]

function observedOwnedAuxiliary(path: string | null, hash: string | null, identity: FileIdentity | null, label: string): FileIdentity | null {
  if (!path || !existsSync(path)) return null
  if (!hash || fileHash(path) !== hash) throw new Error(`${label} auxiliary bytes are ambiguous: ${path}`)
  const observed = regularFileIdentity(path)
  if (identity && !sameFileIdentity(observed, identity)) throw new Error(`${label} auxiliary identity is ambiguous: ${path}`)
  return observed
}

function ownedLiveClaimIdentity(file: JournalFile): FileIdentity | null {
  const observed = observedOwnedAuxiliary(file.claim, file.before_hash, file.claim_identity, "Live claim")
  if (!observed) return null
  if (file.claim_identity) return observed
  if (file.before_hash && existsSync(file.path) && fileHash(file.path) === file.before_hash && sameFileIdentity(regularFileIdentity(file.path), observed)) return observed
  throw new Error(`Live claim ownership is ambiguous: ${file.path}`)
}

function ownedLivePreparedIdentity(file: JournalFile): FileIdentity | null {
  return observedOwnedAuxiliary(file.prepared, file.after_hash, file.prepared_identity, "Live prepared")
}

function classifyJournalPublicFile(file: JournalFile, claimIdentity: FileIdentity | null, preparedIdentity: FileIdentity | null): "before" | "after" | "absent" | "third" {
  if (!existsSync(file.path)) return "absent"
  const hash = fileHash(file.path)
  const identity = regularFileIdentity(file.path)
  const beforeIdentity = claimIdentity ?? file.before_identity
  if (file.before_hash !== null && hash === file.before_hash && beforeIdentity && sameFileIdentity(identity, beforeIdentity)) return "before"
  if (file.after_hash !== null && hash === file.after_hash && preparedIdentity && sameFileIdentity(identity, preparedIdentity)) return "after"
  return "third"
}

function restoreJournalFilesNoClobber(journal: ManagerJournal, dependencies: ManagerDependencies): void {
  const link = dependencies.link ?? linkSync
  const unlink = dependencies.unlink ?? unlinkSync
  assertJournalArtifactsCurrent(journal)
  const states = journal.files.map((file) => {
    const claimIdentity = ownedLiveClaimIdentity(file)
    const preparedIdentity = ownedLivePreparedIdentity(file)
    const state = classifyJournalPublicFile(file, claimIdentity, preparedIdentity)
    if (file.before_hash === null) {
      if (file.claim !== null || file.claim_identity !== null || claimIdentity !== null) throw new Error(`Expected-absent live file has a claim: ${file.path}`)
      if (state !== "absent" && state !== "after") throw new Error(`Third-party live file prevents safe restore: ${file.path}`)
    } else {
      if (!file.claim || (state !== "before" && !claimIdentity)) throw new Error(`Verified live claim is unavailable for restore: ${file.path}`)
      if (state === "third") throw new Error(`Third-party live file prevents safe restore: ${file.path}`)
    }
    return { file, claimIdentity, preparedIdentity, state }
  })
  assertJournalArtifactsCurrent(journal)
  for (const item of [...states].reverse()) {
    const { file, claimIdentity, preparedIdentity } = item
    let state = classifyJournalPublicFile(file, claimIdentity, preparedIdentity)
    if (file.before_hash === null) {
      if (state === "after") {
        const identity = regularFileIdentity(file.path)
        if (!preparedIdentity || fileHash(file.path) !== file.after_hash || !sameFileIdentity(identity, preparedIdentity)) throw new Error(`Live file changed after restore preflight: ${file.path}`)
        unlink(file.path)
      } else if (state !== "absent") throw new Error(`Live file changed after restore preflight: ${file.path}`)
      continue
    }
    if (state === "before") continue
    if (state === "after") {
      const identity = regularFileIdentity(file.path)
      if (!preparedIdentity || fileHash(file.path) !== file.after_hash || !sameFileIdentity(identity, preparedIdentity)) throw new Error(`Live file changed after restore preflight: ${file.path}`)
      unlink(file.path)
      state = "absent"
    }
    if (state !== "absent" || !file.claim || !claimIdentity || fileHash(file.claim) !== file.before_hash || !sameFileIdentity(regularFileIdentity(file.claim), claimIdentity)) {
      throw new Error(`Live claim changed after restore preflight: ${file.path}`)
    }
    link(file.claim, file.path)
    if (fileHash(file.path) !== file.before_hash || !sameFileIdentity(regularFileIdentity(file.path), claimIdentity)) throw new Error(`Restored live file differs from claim: ${file.path}`)
  }
}

function assertJournalFilesAfter(journal: ManagerJournal): void {
  for (const file of journal.files) {
    const claimIdentity = ownedLiveClaimIdentity(file)
    const preparedIdentity = ownedLivePreparedIdentity(file)
    const state = classifyJournalPublicFile(file, claimIdentity, preparedIdentity)
    if (file.after_hash === null ? state !== "absent" : state !== "after") throw new Error(`Live file differs from intended committed state: ${file.path}`)
  }
}

function cleanupJournalFileAuxiliaries(journal: ManagerJournal, dependencies: ManagerDependencies): void {
  const unlink = dependencies.unlink ?? unlinkSync
  for (const file of journal.files) {
    const claimIdentity = ownedLiveClaimIdentity(file)
    const preparedIdentity = ownedLivePreparedIdentity(file)
    if (file.claim && claimIdentity) unlinkOwnedRegularFile(file.claim, file.before_hash!, claimIdentity, unlink)
    if (file.prepared && preparedIdentity) unlinkOwnedRegularFile(file.prepared, file.after_hash!, preparedIdentity, unlink)
  }
}

function commitTransaction(options: {
  command: ManagerJournal["command"]
  paths: ManagerPaths
  plans: BinaryPlan[]
  receiptBefore?: ManagerReceipt
  receiptAfter: ManagerReceipt
  targetGeneration: string | null
  dependencies: ManagerDependencies
}): { configBackups: Map<string, string>; agentBackups: Map<string, string> } {
  const link = options.dependencies.link ?? linkSync
  const unlink = options.dependencies.unlink ?? unlinkSync
  const expectedReceiptBeforeHash = options.receiptBefore === undefined
    ? null
    : receiptBaselineHashes.get(options.receiptBefore)
  const expectedReceiptBeforeIdentity = options.receiptBefore === undefined
    ? null
    : receiptBaselineIdentities.get(options.receiptBefore)
  if (options.receiptBefore !== undefined && (expectedReceiptBeforeHash === undefined || expectedReceiptBeforeIdentity === undefined)) {
    throw new Error("Transaction receipt derivation baseline is unavailable")
  }
  const assertReceiptBaseline = (stage: string) => {
    if (expectedReceiptBeforeHash === null) {
      if (!strictlyMissing(options.paths.receiptPath)) throw new Error(`Receipt changed from the transaction derivation baseline ${stage}`)
      return
    }
    const observed = readStableRegularFile(options.paths.receiptPath)
    if (sha256(observed.bytes) !== expectedReceiptBeforeHash || !sameFileIdentity(observed.identity, expectedReceiptBeforeIdentity!)) {
      throw new Error(`Receipt changed from the transaction derivation baseline ${stage}`)
    }
  }
  const changed = options.plans.filter((plan) => {
    if (plan.before === undefined && plan.after === undefined) return false
    return plan.before === undefined || plan.after === undefined || !plan.before.equals(plan.after)
  })
  if (new Set(changed.map((item) => item.path)).size !== changed.length) throw new Error("Transaction contains duplicate file paths")
  options.dependencies.faults?.afterPlanning?.("receipt", options.paths.receiptPath)
  for (const plan of changed) options.dependencies.faults?.afterPlanning?.(plan.kind, plan.path)
  assertReceiptBaseline("before transaction preflight")
  for (const plan of changed) assertBinaryUnchanged(plan)

  const configBackups = new Map<string, string>()
  const agentBackups = new Map<string, string>()
  for (const plan of changed) {
    if (!plan.before) continue
    const backup = exactBackup(plan.path)
    if (!readFileSync(backup).equals(plan.before)) throw new Error(`Backup bytes do not match preflight bytes: ${plan.path}`)
    assertBinaryUnchanged(plan)
    plan.backup = backup
    ;(plan.kind === "config" ? configBackups : agentBackups).set(plan.path, backup)
  }
  const receiptAfter = ManagerReceiptSchema.parse(options.receiptAfter)
  const receiptAfterBytes = jsonBytes(receiptAfter)
  const receiptAfterHash = sha256(receiptAfterBytes)
  assertReceiptBaseline("before journal creation")
  const transactionId = randomUUID()
  const primitiveParents = [...new Set([options.paths.managerRoot, ...changed.map((plan) => dirname(plan.path))])]
  primitiveParents.forEach((parent, index) => {
    if (!existsSync(parent)) assertDirectoryCreated(parent)
    probeNoClobberPrimitives(parent, transactionId, index, options.dependencies)
  })
  const journalFiles: ManagerJournal["files"] = []
  try {
    for (const [index, plan] of changed.entries()) {
      if (!existsSync(dirname(plan.path))) assertDirectoryCreated(dirname(plan.path))
      const fileAuxiliary = liveFileAuxiliaryPaths(plan.path, transactionId)
      const beforeHash = plan.before ? sha256(plan.before) : null
      const afterHash = plan.after ? sha256(plan.after) : null
      const beforeIdentity = plan.beforeIdentity
      let prepared: string | null = null
      let preparedIdentity: FileIdentity | null = null
      if (plan.after) {
        prepared = fileAuxiliary.prepared
        writeFileSync(prepared, plan.after, { flag: "wx", mode: 0o600 })
        preparedIdentity = regularFileIdentity(prepared)
        if (fileHash(prepared) !== afterHash) throw new Error(`Prepared live bytes differ: ${plan.path}`)
      }
      journalFiles.push({
        path: plan.path,
        kind: plan.kind,
        before_hash: beforeHash,
        before_identity: beforeIdentity,
        after_hash: afterHash,
        backup: plan.backup ?? null,
        claim: plan.before ? fileAuxiliary.claim : null,
        claim_identity: null,
        prepared,
        prepared_identity: preparedIdentity,
      })
    }
  } catch (error) {
    for (const file of journalFiles) {
      if (file.prepared && file.prepared_identity && existsSync(file.prepared)) {
        try { unlinkOwnedRegularFile(file.prepared, file.after_hash!, file.prepared_identity, unlink) } catch { /* retain ambiguous auxiliary */ }
      }
    }
    throw new Error(`Live-file no-clobber publication primitives/preparation failed: ${safeMessage(error instanceof Error ? error.message : String(error))}`)
  }
  const auxiliary = receiptAuxiliaryPaths(options.paths, transactionId)
  const journalPath = auxiliary.journal
  const receiptClaim = expectedReceiptBeforeHash ? auxiliary.claim : null
  const receiptBackup = expectedReceiptBeforeHash ? auxiliary.backup : null
  const receiptPrepared = auxiliary.prepared
  if (receiptBackup) {
    writeFileSync(receiptBackup, readFileSync(options.paths.receiptPath), { flag: "wx", mode: 0o600 })
    if (fileHash(receiptBackup) !== expectedReceiptBeforeHash) throw new Error("Receipt backup does not match derivation bytes")
  }
  assertReceiptBaseline("after receipt backup")
  writeFileSync(receiptPrepared, receiptAfterBytes, { flag: "wx", mode: 0o600 })
  const receiptBackupIdentity = receiptBackup ? regularFileIdentity(receiptBackup) : null
  const receiptPreparedIdentity = regularFileIdentity(receiptPrepared)
  const timestamp = nowIso(options.dependencies)
  const journal: ManagerJournal = ManagerJournalSchema.parse({
    schema_version: 1,
    transaction_id: transactionId,
    revision: 0,
    previous_revision_sha256: null,
    command: options.command,
    phase: "prepared",
    created_at: timestamp,
    updated_at: timestamp,
    target_generation: options.targetGeneration,
    receipt_path: options.paths.receiptPath,
    receipt_before_hash: expectedReceiptBeforeHash,
    receipt_before_identity: expectedReceiptBeforeIdentity,
    receipt_after_hash: receiptAfterHash,
    receipt_backup: receiptBackup,
    receipt_backup_identity: receiptBackupIdentity,
    receipt_claim: receiptClaim,
    receipt_claim_identity: null,
    receipt_prepared: receiptPrepared,
    receipt_prepared_identity: receiptPreparedIdentity,
    files: journalFiles,
  })
  try {
    initializeJournal(journalPath, journal, options.dependencies)
  } catch (error) {
    cleanupJournalFileAuxiliaries(journal, options.dependencies)
    unlinkOwnedRegularFile(receiptPrepared, receiptAfterHash, receiptPreparedIdentity, unlink)
    if (receiptBackup) unlinkOwnedRegularFile(receiptBackup, expectedReceiptBeforeHash!, receiptBackupIdentity!, unlink)
    throw error
  }
  let receiptCommitted = false
  let transactionFinalized = false
  let receiptClaimTaken = false
  let receiptClaimVerified = false
  try {
    assertReceiptBaseline("before live writes")
    setJournalPhase(journalPath, journal, "writing", options.dependencies)
    assertReceiptBaseline("after writing journal phase")
    changed.forEach((plan, index) => {
      const file = journal.files[index]!
      options.dependencies.faults?.beforeLiveWrite?.(plan.path, index)
      assertReceiptBaseline(`before live claim ${index}`)
      assertBinaryUnchanged(plan)
      if (file.before_hash !== null) {
        link(file.path, file.claim!)
        const publicIdentity = regularFileIdentity(file.path)
        const claimIdentity = regularFileIdentity(file.claim!)
        if (!file.before_identity || fileHash(file.path) !== file.before_hash || fileHash(file.claim!) !== file.before_hash ||
          !sameFileIdentity(publicIdentity, file.before_identity) || !sameFileIdentity(publicIdentity, claimIdentity)) {
          throw new Error(`Live-file claim differs from expected bytes or identity: ${file.path}`)
        }
        file.claim_identity = claimIdentity
        journal.updated_at = nowIso(options.dependencies)
        publishJournalRevision(journalPath, journal, options.dependencies)
        options.dependencies.faults?.afterLiveClaim?.(file.path, index)
      } else if (existsSync(file.path)) throw new Error(`Expected-absent live path appeared before publication: ${file.path}`)
    })
    setJournalPhase(journalPath, journal, "files-claimed", options.dependencies)
    journal.files.forEach((file, index) => {
      if (file.before_hash !== null) {
        options.dependencies.faults?.beforeLiveUnlink?.(file.path, index)
        const publicIdentity = regularFileIdentity(file.path)
        const claimIdentity = regularFileIdentity(file.claim!)
        if (!file.claim_identity || fileHash(file.path) !== file.before_hash || fileHash(file.claim!) !== file.before_hash ||
          !sameFileIdentity(publicIdentity, file.claim_identity) || !sameFileIdentity(claimIdentity, file.claim_identity)) {
          throw new Error(`Live file changed before claim unlink: ${file.path}`)
        }
        unlink(file.path)
        options.dependencies.faults?.afterLiveUnlink?.(file.path, index)
      } else if (existsSync(file.path)) throw new Error(`Expected-absent live path appeared before publication: ${file.path}`)
      if (file.after_hash !== null) {
        options.dependencies.faults?.beforeLivePublish?.(file.path, index)
        link(file.prepared!, file.path)
        options.dependencies.faults?.afterLivePublish?.(file.path, index)
        if (!file.prepared_identity || fileHash(file.path) !== file.after_hash ||
          !sameFileIdentity(regularFileIdentity(file.path), file.prepared_identity)) throw new Error(`Published live file differs from prepared identity: ${file.path}`)
      }
      options.dependencies.faults?.afterLiveWrite?.(file.path, index)
    })
    assertJournalFilesAfter(journal)
    assertReceiptBaseline("after live file writes")
    setJournalPhase(journalPath, journal, "live-written", options.dependencies)
    assertJournalFilesAfter(journal)
    assertReceiptBaseline("after live-written journal phase")
    options.dependencies.faults?.beforeReceiptCommit?.(options.paths.receiptPath)
    assertJournalFilesAfter(journal)
    assertReceiptBaseline("immediately before receipt claim")
    if (expectedReceiptBeforeHash) {
      link(options.paths.receiptPath, receiptClaim!)
      receiptClaimTaken = true
      const receiptIdentity = regularFileIdentity(options.paths.receiptPath)
      const claimIdentity = regularFileIdentity(receiptClaim!)
      if (fileHash(receiptClaim!) !== expectedReceiptBeforeHash || fileHash(options.paths.receiptPath) !== expectedReceiptBeforeHash ||
        !sameFileIdentity(receiptIdentity, expectedReceiptBeforeIdentity!) || !sameFileIdentity(receiptIdentity, claimIdentity)) {
        throw new Error("Linked receipt claim differs from transaction derivation baseline or identity")
      }
      journal.receipt_claim_identity = claimIdentity
      setJournalPhase(journalPath, journal, "receipt-linked", options.dependencies)
      const receiptIdentityBeforeUnlink = regularFileIdentity(options.paths.receiptPath)
      const claimIdentityBeforeUnlink = regularFileIdentity(receiptClaim!)
      if (fileHash(options.paths.receiptPath) !== expectedReceiptBeforeHash || fileHash(receiptClaim!) !== expectedReceiptBeforeHash ||
        !sameFileIdentity(receiptIdentityBeforeUnlink, claimIdentityBeforeUnlink) || !sameFileIdentity(claimIdentity, claimIdentityBeforeUnlink)) {
        throw new Error("Receipt identity changed before no-clobber claim unlink")
      }
      unlink(options.paths.receiptPath)
      receiptClaimVerified = true
    } else if (existsSync(options.paths.receiptPath)) {
      throw new Error("Receipt appeared before expected-absent publication")
    }
    setJournalPhase(journalPath, journal, "receipt-claimed", options.dependencies)
    options.dependencies.faults?.afterReceiptClaim?.(options.paths.receiptPath)
    if (existsSync(options.paths.receiptPath)) throw new Error("Receipt path was concurrently created after claim")
    link(receiptPrepared, options.paths.receiptPath)
    receiptCommitted = true
    if (fileHash(options.paths.receiptPath) !== receiptAfterHash || !sameFileIdentity(regularFileIdentity(options.paths.receiptPath), receiptPreparedIdentity)) {
      throw new Error("Published receipt differs from prepared bytes or identity")
    }
    setJournalPhase(journalPath, journal, "receipt-published", options.dependencies)
    options.dependencies.faults?.afterReceiptPublish?.(options.paths.receiptPath)
    options.dependencies.faults?.afterReceiptCommit?.(options.paths.receiptPath)
    assertJournalFilesAfter(journal)
    if (fileHash(options.paths.receiptPath) !== receiptAfterHash || !sameFileIdentity(regularFileIdentity(options.paths.receiptPath), receiptPreparedIdentity)) {
      throw new Error("Published receipt changed bytes or identity before journal completion")
    }
    setJournalPhase(journalPath, journal, "receipt-committed", options.dependencies)
    transactionFinalized = true
    cleanupJournalFileAuxiliaries(journal, options.dependencies)
    if (receiptClaim) unlinkOwnedRegularFile(receiptClaim, expectedReceiptBeforeHash!, journal.receipt_claim_identity!, unlink)
    unlinkOwnedRegularFile(receiptPrepared, receiptAfterHash, receiptPreparedIdentity, unlink)
    if (receiptBackup) unlinkOwnedRegularFile(receiptBackup, expectedReceiptBeforeHash!, receiptBackupIdentity!, unlink)
    cleanupJournalArtifacts(journalPath, journal, options.dependencies)
    return { configBackups, agentBackups }
  } catch (error) {
    if (error instanceof SimulatedManagerCrashError) throw error
    if (/Journal (?:no-clobber publication failed|artifact)/i.test(error instanceof Error ? error.message : String(error))) {
      throw new Error(`Journal publication/identity became ambiguous; transaction evidence was preserved: ${safeMessage(error instanceof Error ? error.message : String(error))}`)
    }
    if (transactionFinalized) throw new Error(`Manager transaction committed but auxiliary cleanup was incomplete; journal retained: ${safeMessage(error instanceof Error ? error.message : String(error))}`)
    const verifiedClaimIdentity = (): FileIdentity => {
      if (!receiptClaim || !journal.receipt_claim_identity || !existsSync(receiptClaim)) throw new Error("Receipt claim is missing or has no recorded identity")
      const observed = regularFileIdentity(receiptClaim)
      if (!sameFileIdentity(observed, journal.receipt_claim_identity) || fileHash(receiptClaim) !== expectedReceiptBeforeHash) {
        throw new Error("Receipt claim bytes or identity changed")
      }
      return observed
    }
    if (receiptCommitted) {
      const current = fileHash(options.paths.receiptPath)
      let restored = false
      if (current === receiptAfterHash && existsSync(options.paths.receiptPath) && sameFileIdentity(regularFileIdentity(options.paths.receiptPath), receiptPreparedIdentity)) {
        const claimIdentity = expectedReceiptBeforeHash ? verifiedClaimIdentity() : null
        unlink(options.paths.receiptPath)
        if (expectedReceiptBeforeHash) link(receiptClaim!, options.paths.receiptPath)
        restored = fileHash(options.paths.receiptPath) === expectedReceiptBeforeHash &&
          (claimIdentity === null || sameFileIdentity(regularFileIdentity(options.paths.receiptPath), claimIdentity))
      }
      if (!restored) {
        throw new Error(`Manager receipt was published but could not be safely restored; journal retained: ${safeMessage(error instanceof Error ? error.message : String(error))}`)
      }
      receiptCommitted = false
    } else if (receiptClaimTaken) {
      const claimHash = fileHash(receiptClaim!)
      if (!receiptClaimVerified || claimHash !== expectedReceiptBeforeHash) {
        throw new Error(`Receipt claim is ambiguous and was preserved with its journal: ${safeMessage(error instanceof Error ? error.message : String(error))}`)
      }
      const claimIdentity = verifiedClaimIdentity()
      if (!existsSync(options.paths.receiptPath)) {
        try {
          link(receiptClaim!, options.paths.receiptPath)
        } catch (restoreError) {
          throw new Error(`Claimed receipt could not be restored without clobbering; journal retained: ${safeMessage(restoreError instanceof Error ? restoreError.message : String(restoreError))}`)
        }
      }
      if (fileHash(options.paths.receiptPath) !== expectedReceiptBeforeHash || !sameFileIdentity(regularFileIdentity(options.paths.receiptPath), claimIdentity)) {
        throw new Error(`Third-party receipt was preserved after claim failure; journal retained: ${safeMessage(error instanceof Error ? error.message : String(error))}`)
      }
    }
    const foreignClaim = !receiptClaimTaken && receiptClaim !== null && existsSync(receiptClaim)
    const rollbackErrors: unknown[] = []
    try {
      restoreJournalFilesNoClobber(journal, options.dependencies)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    if (!rollbackErrors.length && foreignClaim) {
      throw new Error(`Receipt claim destination was already occupied and was preserved with the journal: ${safeMessage(error instanceof Error ? error.message : String(error))}`)
    }
    if (!rollbackErrors.length) {
      cleanupJournalFileAuxiliaries(journal, options.dependencies)
      if (receiptClaimTaken && receiptClaim && existsSync(receiptClaim)) {
        unlinkOwnedRegularFile(receiptClaim, expectedReceiptBeforeHash!, verifiedClaimIdentity(), unlink)
      }
      unlinkOwnedRegularFile(receiptPrepared, receiptAfterHash, receiptPreparedIdentity, unlink)
      if (receiptBackup) unlinkOwnedRegularFile(receiptBackup, expectedReceiptBeforeHash!, receiptBackupIdentity!, unlink)
      cleanupJournalArtifacts(journalPath, journal, options.dependencies)
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "manager transaction failed and rollback was incomplete")
    throw error
  }
}

function generationMatches(left: ReleaseGeneration, right: ReleaseGeneration): boolean {
  const leftExcel = left.capabilities?.excel
  const rightExcel = right.capabilities?.excel
  const excelMatches = leftExcel === undefined || rightExcel === undefined
    ? leftExcel === rightExcel
    : leftExcel.manifest_hash === rightExcel.manifest_hash && leftExcel.lock_hash === rightExcel.lock_hash &&
      leftExcel.wrapper_hash === rightExcel.wrapper_hash && leftExcel.validator_hash === rightExcel.validator_hash
  const dependencyMatches = right.production_dependencies === undefined && right.version === "0.1.0"
    ? true
    : JSON.stringify(left.production_dependencies) === JSON.stringify(right.production_dependencies)
  return left.id === right.id && left.version === right.version && left.tag === right.tag &&
    left.commit === right.commit && left.runtime_digest === right.runtime_digest &&
    left.lock_digest === right.lock_digest && samePath(left.package_root, right.package_root) &&
    specMatches(left.spec, right.spec) &&
    JSON.stringify(left.agents) === JSON.stringify(right.agents) &&
    JSON.stringify(left.durable_state) === JSON.stringify(right.durable_state) && dependencyMatches && excelMatches
}

function promoteStaged(
  staged: StagedRelease,
  dependencies: ManagerDependencies,
): ReleaseGeneration {
  const runner = dependencies.runner ?? new DefaultCommandRunner()
  const packagePath = staged.generation.package_root
  if (existsSync(staged.finalPath)) {
    regularDirectoryIdentity(staged.finalPath)
    if (!existsSync(packagePath)) throw new Error("Occupied generation reservation has no exact package child")
    regularDirectoryIdentity(packagePath)
    assertCleanRepository(runner, packagePath, "Existing generation")
    const existingOrigin = git(runner, packagePath, ["config", "--get", "remote.origin.url"])
    if (!remoteEqual(existingOrigin, staged.trustedRemote)) throw new Error("Existing generation origin differs from the staged trusted remote")
    const observed = validateReleaseRoot(packagePath, staged.generation.tag, runner, staged.generation.commit)
    if (!generationMatches(observed, staged.generation)) throw new Error("Existing generation directory does not match the resolved release")
    removeStagingIfPresent(staged, dependencies)
    return { ...staged.generation, package_root: canonicalDirectory(packagePath), spec: observed.spec }
  }
  mkdirSync(staged.finalPath, { recursive: false, mode: 0o700 })
  const reservationIdentity = regularDirectoryIdentity(staged.finalPath)
  const created: CreatedTreeEntry[] = []
  try {
    probeNoClobberPrimitives(staged.finalPath, randomUUID(), 0, dependencies)
    materializeGenerationTree(staged, packagePath, reservationIdentity, dependencies, created)
    if (!sameFileIdentity(regularDirectoryIdentity(staged.finalPath), reservationIdentity)) throw new Error("Generation reservation identity changed after materialization")
    const canonical = canonicalDirectory(packagePath)
    if (!samePath(canonical, packagePath)) throw new Error("Materialized generation package path was redirected")
    assertCleanRepository(runner, canonical, "Materialized generation")
    const promotedOrigin = git(runner, canonical, ["config", "--get", "remote.origin.url"])
    if (!remoteEqual(promotedOrigin, staged.trustedRemote)) throw new Error("Materialized generation origin differs from the staged trusted remote")
    const observed = validateReleaseRoot(canonical, staged.generation.tag, runner, staged.generation.commit)
    if (!generationMatches(observed, staged.generation)) throw new Error("Materialized generation directory does not match the staged release")
    for (const entry of created) assertCreatedEntry(entry)
    removeStagingIfPresent(staged, dependencies)
    return {
      ...staged.generation,
      package_root: canonical,
      spec: pathToFileURL(canonical).href.replace(/\/$/, ""),
    }
  } catch (error) {
    try {
      cleanupCreatedGeneration(created, staged.finalPath, reservationIdentity)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `generation publication failed and cleanup was incomplete: ${safeMessage(error instanceof Error ? error.message : String(error))}; cleanup: ${safeMessage(cleanupError instanceof Error ? cleanupError.message : String(cleanupError))}`)
    }
    throw error
  }
}

function activatedGenerations(
  receipt: ManagerReceipt | undefined,
  target: ReleaseGeneration,
  timestamp: string,
): ReleaseGeneration[] {
  const existing = receipt?.generations.find((item) => item.id === target.id)
  const activated = {
    ...target,
    installed_at: existing?.installed_at ?? target.installed_at,
    activated_at: timestamp,
  }
  const generations = [...(receipt?.generations ?? []).filter((item) => item.id !== target.id), activated]
  return generations.slice(-MAX_GENERATIONS)
}

function buildReceipt(options: {
  paths: ManagerPaths
  before?: ManagerReceipt
  trustedRemote: string
  generation?: ReleaseGeneration
  agents: Record<string, ManagedAgentReceipt>
  timestamp: string
  installed: boolean
}): ManagerReceipt {
  const generations = options.generation
    ? activatedGenerations(options.before, options.generation, options.timestamp)
    : options.before?.generations ?? []
  const spec = options.installed ? options.generation?.spec ?? null : null
  return ManagerReceiptSchema.parse({
    schema_version: 1,
    manager_version: MANAGER_VERSION,
    installed: options.installed,
    config_root: options.paths.configRoot,
    install_root: options.paths.installRoot,
    trusted_remote: options.trustedRemote,
    channel: "stable",
    active_generation: options.installed ? options.generation?.id ?? null : null,
    generations,
    server_registration: { config_path: options.paths.serverConfig, spec },
    tui_registration: { config_path: options.paths.tuiConfig, spec },
    agents: options.agents,
    created_at: options.before?.created_at ?? options.timestamp,
    updated_at: options.timestamp,
    restart_required: {
      pending: true,
      since: options.before?.restart_required.pending ? options.before.restart_required.since : options.timestamp,
      attested_at: options.before?.restart_required.attested_at ?? null,
    },
  })
}

function adoptionRoot(options: ManagerOptions, receipt: ManagerReceipt | undefined): string | undefined {
  if (receipt || !options.source) return
  const source = canonicalDirectory(resolve(options.source))
  const known = sourceKnownSpecs(source)
  const paths = managerPaths(options)
  const server = pluginSpecs(paths.serverConfig)
  const tui = pluginSpecs(paths.tuiConfig)
  if (server.some((spec) => known.some((item) => specMatches(spec, item))) &&
    tui.some((spec) => known.some((item) => specMatches(spec, item)))) return source
  return
}

function activeGeneration(receipt: ManagerReceipt): ReleaseGeneration {
  const generation = receipt.generations.find((item) => item.id === receipt.active_generation)
  if (!generation) throw new Error("Receipt active generation is missing")
  return generation
}

function activeExcel(receipt: ManagerReceipt | undefined): ExcelCapabilityReceipt | undefined {
  if (!receipt?.installed) return
  return activeGeneration(receipt).capabilities?.excel
}

function validateRetainedActiveGeneration(
  receipt: ManagerReceipt,
  paths: ManagerPaths,
  dependencies: ManagerDependencies,
): ReleaseGeneration {
  const active = activeGeneration(receipt)
  if (!existsSync(active.package_root) || !samePath(canonicalDirectory(active.package_root), active.package_root)) throw new Error("Active generation root is missing or redirected")
  const runner = dependencies.runner ?? new DefaultCommandRunner()
  assertCleanRepository(runner, active.package_root, "Active generation")
  const origin = git(runner, active.package_root, ["config", "--get", "remote.origin.url"])
  if (!remoteEqual(origin, receipt.trusted_remote)) throw new Error("Active generation origin differs from trusted receipt remote")
  const observed = validateReleaseRoot(active.package_root, active.tag, runner, active.commit)
  if (!generationMatches(observed, active)) throw new Error("Active generation identity differs from receipt")
  for (const path of [paths.serverConfig, paths.tuiConfig]) {
    if (pluginSpecs(path).filter((spec) => specMatches(spec, active.spec)).length !== 1) throw new Error("Active generation registration is missing or ambiguous")
  }
  validateRecordedExcelEnvironment(active, paths, dependencies, true)
  assertManagedAgentsRoot(paths)
  for (const [name, agent] of Object.entries(receipt.agents)) {
    const target = resolveContainedPath(paths.agentsRoot, name)
    assertManagedAgentTarget(target)
    if (agent.disposition === "managed" && fileHash(target) !== agent.managed_hash) {
      throw new Error(`Active managed agent has drifted: ${name}`)
    }
  }
  return active
}

function excelActivationIntent(
  options: ManagerOptions & { command: "install" | "update" },
  receipt: ManagerReceipt | undefined,
  paths: ManagerPaths,
): { enabled: false } | { enabled: true; root: string } {
  const prior = activeExcel(receipt)
  if (options.disableCapability === EXCEL_CAPABILITY) return { enabled: false }
  if (options.enableCapability === EXCEL_CAPABILITY) {
    const requested = options.excelRoot ?? (prior?.enabled ? prior.root : null)
    if (!requested) throw new Error("--enable-capability excel requires --excel-root unless preserving an enabled Excel capability")
    return { enabled: true, root: canonicalExcelRoot(requested, paths) }
  }
  if (prior?.enabled) {
    return { enabled: true, root: canonicalExcelRoot(options.excelRoot ?? prior.root!, paths) }
  }
  if (options.excelRoot) throw new Error("--excel-root requires --enable-capability excel or an already-enabled capability preserved by update")
  return { enabled: false }
}

function capabilityIssue(status: "managed" | "missing" | "custom", action: string): ManagerResult["issues"] {
  return status === "custom"
    ? [{ code: "excel-config-custom", message: `Custom or drifted mcp.alg_excel was preserved during ${action}.` }]
    : undefined
}

function sameAgentOwnership(
  before: Record<string, ManagedAgentReceipt>,
  after: Record<string, ManagedAgentReceipt>,
): boolean {
  const project = (value: Record<string, ManagedAgentReceipt>) => Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([name, receipt]) => [name, {
      path: receipt.path,
      disposition: receipt.disposition,
      source_hash: receipt.source_hash,
      current_hash: receipt.current_hash,
      managed_hash: receipt.managed_hash,
    }]),
  )
  return JSON.stringify(project(before)) === JSON.stringify(project(after))
}

function selectRollbackGeneration(receipt: ManagerReceipt, options: ManagerOptions): ReleaseGeneration {
  const current = activeGeneration(receipt)
  let target: ReleaseGeneration | undefined
  if (options.generation) target = receipt.generations.find((item) => item.id === options.generation)
  else if (options.tag || options.version) {
    const tag = requestedTag(options)!
    const matches = receipt.generations.filter((item) => item.tag === tag)
    if (matches.length > 1) throw new Error(`Rollback tag ${tag} is ambiguous; pass --generation`)
    target = matches[0]
  } else {
    target = [...receipt.generations].reverse().find((item) => item.id !== current.id)
  }
  if (!target) throw new Error("No retained rollback generation matches the request")
  if (!existsSync(target.package_root) || !samePath(canonicalDirectory(target.package_root), target.package_root)) {
    throw new Error("Rollback generation package root is missing or redirected")
  }
  if (target.durable_state.format !== current.durable_state.format ||
    !target.durable_state.compatible_schemas.includes(current.durable_state.current_schema) ||
    !current.durable_state.compatible_schemas.includes(target.durable_state.current_schema) ||
    !target.durable_state.compatible_package_versions.includes(current.version) ||
    !current.durable_state.compatible_package_versions.includes(target.version)) {
    throw new Error("Rollback is blocked by the durable-state compatibility declaration")
  }
  return target
}

function transactionResult(
  commandName: ManagerCommand,
  paths: ManagerPaths,
  generation: ReleaseGeneration | undefined,
  configTextPlans: TextFilePlan[],
  agentResults: NonNullable<ManagerResult["agents"]>,
  backups: { configBackups: Map<string, string>; agentBackups: Map<string, string> } | undefined,
  dryRun: boolean,
  issues?: ManagerResult["issues"],
): ManagerResult {
  const configs = configTextPlans.map((plan) => ({
    path: plan.path,
    changed: plan.changed,
    backup: backups?.configBackups.get(plan.path),
  }))
  const agents = agentResults.map((result) => ({ ...result, backup: backups?.agentBackups.get(result.path) }))
  const changed = configs.some((item) => item.changed) || agents.some((item) => ["created", "updated", "removed", "adopted", "ownership-released"].includes(item.action))
  return {
    command: commandName,
    ok: true,
    changed,
    dry_run: dryRun,
    summary: dryRun
      ? `Validated ${commandName} plan without live config, agent, or receipt writes.`
      : `${commandName} transaction completed; quit and restart OpenCode.`,
    generation: generation?.id,
    receipt_path: paths.receiptPath,
    configs,
    agents,
    issues,
    restart_required: !dryRun,
  }
}

function installOrUpdate(
  options: ManagerOptions & { command: "install" | "update" },
  paths: ManagerPaths,
  dependencies: ManagerDependencies,
): ManagerResult {
  const receipt = readReceipt(paths, options.command === "update")
  if (options.command === "update" && !receipt?.installed) throw new Error("Update requires an installed active receipt")
  const excelIntent = excelActivationIntent(options, receipt, paths)
  const policy = options.agentPolicy ?? "managed"
  const staged = stageRelease(options, paths, receipt, dependencies)
  let targetRoot = staged.stagingPath
  let generation = staged.generation
  try {
    if (receipt?.installed && options.command === "install" && receipt.active_generation !== generation.id) {
      throw new Error("A different generation is installed; use update")
    }
    if (receipt?.installed && options.command === "update") {
      const active = activeGeneration(receipt)
      if (active.commit !== generation.commit && compareVersions(generation.version, active.version) <= 0) {
        throw new Error("Stable update version must increase monotonically")
      }
    }
    const retainedActive = receipt?.installed && receipt.active_generation === generation.id
      ? validateRetainedActiveGeneration(receipt, paths, dependencies)
      : undefined
    if (receipt?.installed && receipt.active_generation === generation.id &&
      !options.enableCapability && !options.disableCapability && !options.excelRoot && options.agentPolicy === undefined) {
      removeStagingIfPresent(staged, dependencies)
      return {
        command: options.command,
        ok: true,
        changed: false,
        dry_run: Boolean(options.dryRun),
        summary: `Generation ${generation.id} is already active.`,
        generation: generation.id,
        receipt_path: paths.receiptPath,
        restart_required: receipt.restart_required.pending,
      }
    }
    if (!options.dryRun) {
      if (retainedActive) {
        removeStagingIfPresent(staged, dependencies)
        generation = { ...generation, package_root: retainedActive.package_root, spec: retainedActive.spec }
        targetRoot = retainedActive.package_root
      } else {
        generation = promoteStaged(staged, dependencies)
        targetRoot = generation.package_root
      }
    }
    const priorExcel = activeExcel(receipt)
    const preserveActiveExcel = retainedActive && (
      excelIntent.enabled
        ? priorExcel?.enabled === true && samePath(priorExcel.root!, excelIntent.root)
        : priorExcel?.enabled === false
    )
    if (preserveActiveExcel) {
      generation = { ...generation, capabilities: retainedActive.capabilities }
    } else if (excelIntent.enabled) {
      const excel = prepareExcelCapability({
        packageRoot: targetRoot,
        configPackageRoot: generation.package_root,
        generationId: generation.id,
        root: excelIntent.root,
        paths,
        dependencies,
      })
      generation = { ...generation, capabilities: { excel } }
    } else if (generation.capabilities?.excel) {
      generation = {
        ...generation,
        capabilities: { excel: { ...generation.capabilities.excel, enabled: false, root: null, env_path: null, env_hash: null, env_files: null, env_bytes: null, config_hash: null, managed_config: null } },
      }
    }
    const source = options.source ? canonicalDirectory(resolve(options.source)) : undefined
    const configPlan = configPlans(
      paths,
      receipt,
      generation.spec,
      source,
      false,
      generation.capabilities?.excel.enabled ? generation.capabilities.excel.managed_config! : undefined,
      priorExcel?.enabled ? priorExcel.managed_config! : undefined,
    )
    const timestamp = nowIso(dependencies)
    const agentPlan = planAgents({
      command: options.command,
      policy,
      removeAgents: false,
      paths,
      targetRoot,
      targetGeneration: generation,
      receipt,
      adoptionRoot: adoptionRoot(options, receipt),
      timestamp,
    })
    if (receipt?.installed && receipt.active_generation === generation.id &&
      configPlan.plans.every((plan) => !plan.changed) && agentPlan.plans.length === 0 &&
      sameAgentOwnership(receipt.agents, agentPlan.receipts) &&
      JSON.stringify(activeGeneration(receipt).capabilities) === JSON.stringify(generation.capabilities)) {
      removeStagingIfPresent(staged, dependencies)
      return {
        command: options.command,
        ok: true,
        changed: false,
        dry_run: Boolean(options.dryRun),
        summary: `Generation ${generation.id} and its Excel capability state are already active.`,
        generation: generation.id,
        receipt_path: paths.receiptPath,
        restart_required: receipt.restart_required.pending,
      }
    }
    const after = buildReceipt({
      paths,
      before: receipt,
      trustedRemote: staged.trustedRemote,
      generation,
      agents: agentPlan.receipts,
      timestamp,
      installed: true,
    })
    if (options.dryRun) {
      removeStagingIfPresent(staged, dependencies)
      return transactionResult(
        options.command,
        paths,
        generation,
        configPlan.plans,
        agentPlan.results,
        undefined,
        true,
        options.disableCapability ? capabilityIssue(configPlan.excelStatus, options.command) : undefined,
      )
    }
    const backups = commitTransaction({
      command: options.command,
      paths,
      plans: [...configPlan.plans.map(textToBinary), ...agentPlan.plans],
      receiptBefore: receipt,
      receiptAfter: after,
      targetGeneration: generation.id,
      dependencies,
    })
    return transactionResult(
      options.command,
      paths,
      generation,
      configPlan.plans,
      agentPlan.results,
      backups,
      false,
      options.disableCapability ? capabilityIssue(configPlan.excelStatus, options.command) : undefined,
    )
  } catch (error) {
    try {
      removeStagingIfPresent(staged, dependencies)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `manager operation failed and staging cleanup was incomplete: ${safeMessage(error instanceof Error ? error.message : String(error))}; cleanup: ${safeMessage(cleanupError instanceof Error ? cleanupError.message : String(cleanupError))}`)
    }
    throw error
  }
}

function rollbackManager(
  options: ManagerOptions & { command: "rollback" },
  paths: ManagerPaths,
  dependencies: ManagerDependencies,
): ManagerResult {
  const receipt = readReceipt(paths, true)!
  if (!receipt.installed) throw new Error("Rollback requires an installed active generation")
  if (options.agentPolicy === "force") throw new Error("Rollback never force-overwrites customized agents")
  const target = selectRollbackGeneration(receipt, options)
  const runner = dependencies.runner ?? new DefaultCommandRunner()
  assertCleanRepository(runner, target.package_root, "Rollback generation")
  const observedRemote = git(runner, target.package_root, ["config", "--get", "remote.origin.url"])
  if (!remoteEqual(observedRemote, receipt.trusted_remote)) {
    throw new Error("Rollback generation origin differs from the trusted receipt remote")
  }
  const validated = validateReleaseRoot(target.package_root, target.tag, runner, target.commit)
  if (!generationMatches(validated, target)) throw new Error("Rollback generation no longer matches its receipt")
  const timestamp = nowIso(dependencies)
  let activated = { ...target, production_dependencies: validated.production_dependencies, activated_at: timestamp }
  const targetExcel = target.capabilities?.excel
  if (targetExcel?.enabled) {
    validateRecordedExcelEnvironment(target, paths, dependencies, false)
    activated = { ...activated, capabilities: { excel: targetExcel } }
  }
  const currentExcel = activeExcel(receipt)
  const configPlan = configPlans(
    paths,
    receipt,
    target.spec,
    undefined,
    false,
    targetExcel?.enabled ? targetExcel.managed_config! : undefined,
    currentExcel?.enabled ? currentExcel.managed_config! : undefined,
  )
  const agentPlan = planAgents({
    command: "rollback",
    policy: options.agentPolicy ?? "managed",
    removeAgents: false,
    paths,
    targetRoot: target.package_root,
    targetGeneration: target,
    receipt,
    timestamp,
  })
  const after = buildReceipt({
    paths,
    before: receipt,
    trustedRemote: receipt.trusted_remote,
    generation: activated,
    agents: agentPlan.receipts,
    timestamp,
    installed: true,
  })
  if (options.dryRun) return transactionResult(
    "rollback", paths, activated, configPlan.plans, agentPlan.results, undefined, true,
    capabilityIssue(configPlan.excelStatus, "rollback"),
  )
  const backups = commitTransaction({
    command: "rollback",
    paths,
    plans: [...configPlan.plans.map(textToBinary), ...agentPlan.plans],
    receiptBefore: receipt,
    receiptAfter: after,
    targetGeneration: target.id,
    dependencies,
  })
  return transactionResult(
    "rollback", paths, activated, configPlan.plans, agentPlan.results, backups, false,
    capabilityIssue(configPlan.excelStatus, "rollback"),
  )
}

function uninstallManager(
  options: ManagerOptions & { command: "uninstall" },
  paths: ManagerPaths,
  dependencies: ManagerDependencies,
): ManagerResult {
  const receipt = readReceipt(paths, true)!
  if (!receipt.installed) {
    return { command: "uninstall", ok: true, changed: false, dry_run: Boolean(options.dryRun), summary: "ALG is already uninstalled.", receipt_path: paths.receiptPath, restart_required: receipt.restart_required.pending }
  }
  const active = activeGeneration(receipt)
  const timestamp = nowIso(dependencies)
  const activeCapability = active.capabilities?.excel
  const configPlan = configPlans(
    paths,
    receipt,
    undefined,
    undefined,
    true,
    undefined,
    activeCapability?.enabled ? activeCapability.managed_config! : undefined,
  )
  const agentPlan = planAgents({
    command: "uninstall",
    policy: options.agentPolicy ?? "managed",
    removeAgents: Boolean(options.removeAgents),
    paths,
    targetGeneration: active,
    receipt,
    timestamp,
  })
  const after = buildReceipt({
    paths,
    before: receipt,
    trustedRemote: receipt.trusted_remote,
    agents: agentPlan.receipts,
    timestamp,
    installed: false,
  })
  if (options.dryRun) return transactionResult(
    "uninstall", paths, undefined, configPlan.plans, agentPlan.results, undefined, true,
    capabilityIssue(configPlan.excelStatus, "uninstall"),
  )
  const backups = commitTransaction({
    command: "uninstall",
    paths,
    plans: [...configPlan.plans.map(textToBinary), ...agentPlan.plans],
    receiptBefore: receipt,
    receiptAfter: after,
    targetGeneration: null,
    dependencies,
  })
  return transactionResult(
    "uninstall", paths, undefined, configPlan.plans, agentPlan.results, backups, false,
    capabilityIssue(configPlan.excelStatus, "uninstall"),
  )
}

function journalPaths(paths: ManagerPaths): string[] {
  if (!existsSync(paths.transactionsRoot)) return []
  return readdirSync(paths.transactionsRoot)
    .filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name))
    .sort()
    .slice(0, 64)
    .map((name) => resolveContainedPath(paths.transactionsRoot, name))
}

function readJournalPair(path: string): { journal: ManagerJournal; bytes: Buffer; artifacts: string[]; identities: Map<string, FileIdentity> } {
  const anchor = journalAnchorPath(path)
  if (!existsSync(path) || !existsSync(anchor)) throw new Error(`Journal immutable pair is incomplete: ${basename(path)}`)
  const identity = regularFileIdentity(path)
  const anchorIdentity = regularFileIdentity(anchor)
  if (!sameFileIdentity(identity, anchorIdentity)) throw new Error(`Journal immutable pair identity differs: ${basename(path)}`)
  const bytes = readBounded(path)
  if (!readBounded(anchor).equals(bytes)) throw new Error(`Journal immutable pair bytes differ: ${basename(path)}`)
  return {
    journal: ManagerJournalSchema.parse(JSON.parse(bytes.toString("utf8"))),
    bytes,
    artifacts: [path, anchor],
    identities: new Map([[path, identity], [anchor, anchorIdentity]]),
  }
}

function readJournal(path: string, paths: ManagerPaths): ManagerJournal {
  const base = readJournalPair(path)
  if (base.journal.revision !== 0 || base.journal.previous_revision_sha256 !== null) throw new Error(`Journal base revision is invalid: ${basename(path)}`)
  let journal = base.journal
  let previousBytes = base.bytes
  const artifacts = [...base.artifacts]
  const identities = new Map(base.identities)
  const revisionPattern = new RegExp(`^\\.journal-${journal.transaction_id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.revision-(\\d{3})\\.json$`, "i")
  const revisionRoot = dirname(dirname(path))
  const revisions = readdirSync(revisionRoot).flatMap((name) => {
    const match = revisionPattern.exec(name)
    return match ? [{ revision: Number(match[1]), path: resolveContainedPath(revisionRoot, name) }] : []
  }).sort((a, b) => a.revision - b.revision)
  for (const item of revisions) {
    if (item.revision !== journal.revision + 1) throw new Error(`Journal revision sequence is not contiguous: ${basename(path)}`)
    const pair = readJournalPair(item.path)
    const next = pair.journal
    if (next.transaction_id !== journal.transaction_id || next.revision !== item.revision || next.previous_revision_sha256 !== sha256(previousBytes) ||
      next.command !== journal.command || next.created_at !== journal.created_at || next.receipt_path !== journal.receipt_path ||
      next.receipt_before_hash !== journal.receipt_before_hash || next.receipt_after_hash !== journal.receipt_after_hash ||
      JSON.stringify(next.receipt_before_identity) !== JSON.stringify(journal.receipt_before_identity) ||
      next.receipt_backup !== journal.receipt_backup || next.receipt_claim !== journal.receipt_claim || next.receipt_prepared !== journal.receipt_prepared ||
      JSON.stringify(next.receipt_backup_identity) !== JSON.stringify(journal.receipt_backup_identity) ||
      JSON.stringify(next.receipt_prepared_identity) !== JSON.stringify(journal.receipt_prepared_identity) || next.files.length !== journal.files.length) {
      throw new Error(`Journal revision does not extend immutable transaction state: ${basename(item.path)}`)
    }
    for (let index = 0; index < next.files.length; index++) {
      const before = journal.files[index]!
      const after = next.files[index]!
      for (const key of ["path", "kind", "before_hash", "after_hash", "backup", "claim", "prepared"] as const) {
        if (before[key] !== after[key]) throw new Error(`Journal revision changed immutable live-file state: ${basename(item.path)}`)
      }
      if (JSON.stringify(before.before_identity) !== JSON.stringify(after.before_identity) || JSON.stringify(before.prepared_identity) !== JSON.stringify(after.prepared_identity)) {
        throw new Error(`Journal revision changed immutable live-file identity: ${basename(item.path)}`)
      }
      if (before.claim_identity && JSON.stringify(before.claim_identity) !== JSON.stringify(after.claim_identity)) throw new Error(`Journal revision changed live claim identity: ${basename(item.path)}`)
    }
    if (journal.receipt_claim_identity && JSON.stringify(journal.receipt_claim_identity) !== JSON.stringify(next.receipt_claim_identity)) {
      throw new Error(`Journal revision changed receipt claim identity: ${basename(item.path)}`)
    }
    journal = next
    previousBytes = pair.bytes
    artifacts.push(...pair.artifacts)
    for (const [artifact, identity] of pair.identities) identities.set(artifact, identity)
  }
  journalRevisionBytes.set(journal, previousBytes)
  journalArtifactPaths.set(journal, artifacts)
  journalArtifactIdentities.set(journal, identities)
  journalArtifactHashes.set(journal, new Map(artifacts.map((artifact) => [artifact, fileHash(artifact)!])))
  const expected = receiptAuxiliaryPaths(paths, journal.transaction_id)
  const exactPath = (actual: string, wanted: string) => resolve(actual) === resolve(wanted)
  if (!exactPath(path, expected.journal)) throw new Error(`Journal filename does not match transaction id: ${basename(path)}`)
  if (!exactPath(journal.receipt_path, paths.receiptPath)) throw new Error(`Journal receipt path mismatch: ${basename(path)}`)
  if (!exactPath(journal.receipt_prepared, expected.prepared)) throw new Error(`Journal prepared receipt path is not transaction-exact: ${basename(path)}`)
  if ((journal.receipt_before_hash === null) !== (journal.receipt_before_identity === null)) throw new Error(`Journal receipt baseline hash/identity disagree: ${basename(path)}`)
  if (journal.receipt_before_hash === null) {
    if (journal.receipt_backup !== null || journal.receipt_backup_identity !== null || journal.receipt_claim !== null || journal.receipt_claim_identity !== null) {
      throw new Error(`Expected-absent journal has receipt auxiliary before-state paths: ${basename(path)}`)
    }
  } else if (!journal.receipt_backup || !journal.receipt_backup_identity || !journal.receipt_claim ||
    !exactPath(journal.receipt_backup, expected.backup) || !exactPath(journal.receipt_claim, expected.claim)) {
    throw new Error(`Journal receipt backup/claim paths are not transaction-exact: ${basename(path)}`)
  }
  for (const [candidate, identity] of [
    [journal.receipt_prepared, journal.receipt_prepared_identity],
    [journal.receipt_backup, journal.receipt_backup_identity],
    [journal.receipt_claim, journal.receipt_claim_identity],
  ] as const) {
    if (candidate && existsSync(candidate)) {
      const observed = regularFileIdentity(candidate)
      if (identity && !sameFileIdentity(observed, identity)) throw new Error(`Journal auxiliary identity differs: ${candidate}`)
    }
  }
  assertManagedAgentsRoot(paths)
  for (const file of journal.files) {
    const liveAuxiliary = liveFileAuxiliaryPaths(file.path, journal.transaction_id)
    if (file.kind === "agent") {
      const name = basename(file.path)
      if (!(BUNDLED_AGENT_NAMES as readonly string[]).includes(name) || resolve(file.path) !== resolve(resolveContainedPath(paths.agentsRoot, name))) {
        throw new Error(`Journal contains a non-bundled agent path: ${basename(path)}`)
      }
      assertManagedAgentTarget(file.path)
    } else if (resolve(file.path) !== resolve(paths.serverConfig) && resolve(file.path) !== resolve(paths.tuiConfig)) {
      throw new Error(`Journal contains an out-of-scope config path: ${basename(path)}`)
    }
    if (existsSync(file.path)) regularFileIdentity(file.path)
    if (file.before_hash === null) {
      if (file.before_identity !== null || file.claim !== null || file.claim_identity !== null) throw new Error(`Expected-absent journal file has claim state: ${file.path}`)
    } else if (!file.before_identity || !file.claim || !exactPath(file.claim, liveAuxiliary.claim)) {
      throw new Error(`Journal live claim path/identity is not transaction-exact: ${file.path}`)
    }
    if (file.after_hash === null) {
      if (file.prepared !== null || file.prepared_identity !== null) throw new Error(`Intended-absent journal file has prepared state: ${file.path}`)
    } else if (!file.prepared || !file.prepared_identity || !exactPath(file.prepared, liveAuxiliary.prepared)) {
      throw new Error(`Journal live prepared path/identity is not transaction-exact: ${file.path}`)
    }
    for (const [candidate, identity] of [[file.claim, file.claim_identity], [file.prepared, file.prepared_identity]] as const) {
      if (candidate && existsSync(candidate)) {
        const observed = regularFileIdentity(candidate)
        if (identity && !sameFileIdentity(observed, identity)) throw new Error(`Journal live auxiliary identity differs: ${candidate}`)
      }
    }
    if (file.backup && (
      !samePath(dirname(file.backup), dirname(file.path)) ||
      !basename(file.backup).startsWith(`${basename(file.path)}.alg-backup-`)
    )) throw new Error(`Journal backup path is invalid: ${basename(path)}`)
  }
  return journal
}

function recoverJournal(path: string, paths: ManagerPaths, dependencies: ManagerDependencies): void {
  const journal = readJournal(path, paths)
  dependencies.faults?.afterJournalRead?.(path)
  assertJournalArtifactsCurrent(journal)
  const link = dependencies.link ?? linkSync
  const unlink = dependencies.unlink ?? unlinkSync
  const receiptHash = fileHash(paths.receiptPath)
  const receiptMatchesBefore = journal.receipt_before_hash === null
    ? receiptHash === null
    : receiptHash === journal.receipt_before_hash && existsSync(paths.receiptPath) &&
      sameFileIdentity(regularFileIdentity(paths.receiptPath), journal.receipt_before_identity!)
  if (receiptHash === journal.receipt_before_hash && !receiptMatchesBefore) {
    throw new Error("Receipt has intended before bytes but not the derivation identity; refusing recovery")
  }
  const verifyAuxiliary = (candidate: string | null, expectedHash: string | null, expectedIdentity: FileIdentity | null): FileIdentity | null => {
    if (!candidate || !existsSync(candidate)) return null
    if (expectedHash === null || fileHash(candidate) !== expectedHash) throw new Error(`Journal auxiliary bytes are not transaction-owned: ${candidate}`)
    const observed = regularFileIdentity(candidate)
    if (expectedIdentity && !sameFileIdentity(observed, expectedIdentity)) throw new Error(`Journal auxiliary identity is not transaction-owned: ${candidate}`)
    return observed
  }
  const preparedIdentity = verifyAuxiliary(journal.receipt_prepared, journal.receipt_after_hash, journal.receipt_prepared_identity)
  const backupIdentity = verifyAuxiliary(journal.receipt_backup, journal.receipt_before_hash, journal.receipt_backup_identity)
  const claimObservedIdentity = verifyAuxiliary(journal.receipt_claim, journal.receipt_before_hash, journal.receipt_claim_identity)
  let claimOwnedIdentity: FileIdentity | null = journal.receipt_claim_identity && claimObservedIdentity
    ? journal.receipt_claim_identity
    : null
  if (claimObservedIdentity && !claimOwnedIdentity && receiptMatchesBefore && existsSync(paths.receiptPath)) {
    const receiptIdentity = regularFileIdentity(paths.receiptPath)
    if (sameFileIdentity(receiptIdentity, claimObservedIdentity)) claimOwnedIdentity = claimObservedIdentity
  }
  if (claimObservedIdentity && !claimOwnedIdentity) throw new Error("Journal receipt claim ownership is ambiguous; refusing recovery")
  const receiptMatchesAfter = receiptHash === journal.receipt_after_hash && existsSync(paths.receiptPath) &&
    sameFileIdentity(regularFileIdentity(paths.receiptPath), journal.receipt_prepared_identity)
  if (receiptHash === journal.receipt_after_hash && !receiptMatchesAfter) {
    throw new Error("Receipt has intended after bytes but not the recorded prepared identity; refusing recovery")
  }
  if (receiptMatchesAfter) {
    assertJournalFilesAfter(journal)
    cleanupJournalFileAuxiliaries(journal, dependencies)
    if (journal.receipt_claim && claimOwnedIdentity) unlinkOwnedRegularFile(journal.receipt_claim, journal.receipt_before_hash!, claimOwnedIdentity, unlink)
    if (preparedIdentity) unlinkOwnedRegularFile(journal.receipt_prepared, journal.receipt_after_hash, preparedIdentity, unlink)
    if (journal.receipt_backup && backupIdentity) unlinkOwnedRegularFile(journal.receipt_backup, journal.receipt_before_hash!, backupIdentity, unlink)
    cleanupJournalArtifacts(path, journal, dependencies)
    return
  }
  const claimedBefore = receiptHash === null && journal.receipt_before_hash !== null && journal.receipt_claim !== null &&
    claimOwnedIdentity !== null
  if (!receiptMatchesBefore && !claimedBefore) {
    throw new Error(`Receipt is neither the cryptographic before-state nor intended after-state for pending journal ${basename(path)}; refusing recovery`)
  }
  restoreJournalFilesNoClobber(journal, dependencies)
  if (claimedBefore) {
    assertJournalArtifactsCurrent(journal)
    if (existsSync(paths.receiptPath)) throw new Error("Receipt path appeared during claimed-receipt recovery")
    link(journal.receipt_claim!, paths.receiptPath)
    if (fileHash(paths.receiptPath) !== journal.receipt_before_hash || !sameFileIdentity(regularFileIdentity(paths.receiptPath), claimOwnedIdentity!)) {
      throw new Error("Restored claimed receipt does not match before-state identity")
    }
  }
  cleanupJournalFileAuxiliaries(journal, dependencies)
  if (journal.receipt_claim && claimOwnedIdentity) unlinkOwnedRegularFile(journal.receipt_claim, journal.receipt_before_hash!, claimOwnedIdentity, unlink)
  if (preparedIdentity) unlinkOwnedRegularFile(journal.receipt_prepared, journal.receipt_after_hash, preparedIdentity, unlink)
  if (journal.receipt_backup && backupIdentity) unlinkOwnedRegularFile(journal.receipt_backup, journal.receipt_before_hash!, backupIdentity, unlink)
  cleanupJournalArtifacts(path, journal, dependencies)
}

function capabilityFileStatus(path: string, expected: string): "ok" | "missing" | "drift" {
  if (!existsSync(path)) return "missing"
  return fileHash(path) === expected ? "ok" : "drift"
}

function doctorExcelCapability(
  receipt: ManagerReceipt | undefined,
  paths: ManagerPaths,
  dependencies: ManagerDependencies,
  issues: Array<{ code: string; message: string }>,
): NonNullable<ManagerResult["capability_status"]> {
  const entry = excelConfigEntry(paths.serverConfig)
  const active = receipt?.installed ? activeGeneration(receipt) : undefined
  const excel = active?.capabilities?.excel
  const base: NonNullable<ManagerResult["capability_status"]> = {
    name: "excel",
    status: "disabled",
    enabled: excel?.enabled ?? false,
    root: excel?.root ?? null,
    manifest: excel ? "missing" : "not-recorded",
    lock: excel ? "missing" : "not-recorded",
    wrapper: excel ? "missing" : "not-recorded",
    environment: excel?.enabled ? "missing" : "disabled",
    runtime_check: "not-run",
    upstream_version: null,
    tool_count: null,
  }

  if (!excel?.enabled) {
    if (excel && active) {
      const directory = resolveContainedPath(active.package_root, "capabilities", EXCEL_CAPABILITY)
      base.manifest = capabilityFileStatus(resolveContainedPath(directory, "manifest.json"), excel.manifest_hash)
      base.lock = capabilityFileStatus(resolveContainedPath(directory, "uv.lock"), excel.lock_hash)
      base.wrapper = capabilityFileStatus(resolveContainedPath(directory, "wrapper.py"), excel.wrapper_hash)
      if ([base.manifest, base.lock, base.wrapper].some((status) => status !== "ok")) {
        base.status = "drift"
        issues.push({ code: "excel-assets-drift", message: "Disabled Excel capability assets differ from the generation receipt." })
      }
    }
    if (entry.present) {
      const formerlyManaged = receipt?.generations.some((generation) => {
        const config = generation.capabilities?.excel.managed_config
        return config !== null && config !== undefined && sameJson(entry.value, config)
      }) ?? false
      base.status = formerlyManaged ? "drift" : "custom"
      issues.push({
        code: formerlyManaged ? "excel-config-drift" : "excel-config-custom",
        message: formerlyManaged
          ? "mcp.alg_excel remains configured while the managed capability is disabled."
          : "A custom mcp.alg_excel entry is present and is not manager-owned.",
      })
    }
    return base
  }

  const config = excel.managed_config!
  if (!entry.present) {
    base.status = "missing"
    issues.push({ code: "excel-config-missing", message: "Managed mcp.alg_excel is missing." })
  } else if (entry.invalid || !sameJson(entry.value, config)) {
    base.status = "drift"
    issues.push({ code: "excel-config-drift", message: "Managed mcp.alg_excel is customized or malformed." })
  } else {
    base.status = "healthy"
  }

  const directory = resolveContainedPath(active!.package_root, "capabilities", EXCEL_CAPABILITY)
  base.manifest = capabilityFileStatus(resolveContainedPath(directory, "manifest.json"), excel.manifest_hash)
  base.lock = capabilityFileStatus(resolveContainedPath(directory, "uv.lock"), excel.lock_hash)
  base.wrapper = capabilityFileStatus(resolveContainedPath(directory, "wrapper.py"), excel.wrapper_hash)
  try {
    excelAssets(active!.package_root, true)
  } catch (error) {
    if (base.manifest === "ok") base.manifest = "drift"
    issues.push({ code: "excel-manifest-invalid", message: safeMessage(error instanceof Error ? error.message : String(error)) })
  }
  if ([base.manifest, base.lock, base.wrapper].some((status) => status !== "ok")) {
    if (base.status === "healthy") base.status = base.manifest === "missing" || base.lock === "missing" || base.wrapper === "missing" ? "missing" : "drift"
    issues.push({ code: "excel-assets-drift", message: "Excel manifest, lock, or wrapper differs from the receipt." })
  }
  try {
    if (!excel.root || !samePath(canonicalDirectory(excel.root), excel.root)) throw new Error("workbook root is missing or redirected")
  } catch (error) {
    if (base.status === "healthy") base.status = "missing"
    issues.push({ code: "excel-root-missing", message: safeMessage(error instanceof Error ? error.message : String(error)) })
  }
  const interpreter = excel.env_path ? excelInterpreter(excel.env_path) : ""
  if (excel.env_path && existsSync(excel.env_path) && existsSync(interpreter) && statSync(interpreter).isFile()) {
    try {
      const identity = computeManagedEnvironmentIdentity(excel.env_path)
      if (identity.sha256 !== excel.env_hash || identity.files !== excel.env_files || identity.bytes !== excel.env_bytes) throw new Error("environment identity differs from receipt")
      base.environment = "ok"
    } catch (error) {
      base.environment = "missing"
      if (base.status === "healthy") base.status = "drift"
      issues.push({ code: "excel-environment-drift", message: safeMessage(error instanceof Error ? error.message : String(error)) })
    }
  } else {
    base.environment = "missing"
    if (base.status === "healthy") base.status = "missing"
    issues.push({ code: "excel-environment-missing", message: "The lock-keyed Excel environment or interpreter is missing." })
  }
  if (base.status === "healthy" && base.environment === "ok") {
    try {
      const checked = runExcelWrapperCheck(
        dependencies.runner ?? new DefaultCommandRunner(),
        interpreter,
        config.command[1],
        config.cwd,
        excel.root!,
      )
      base.runtime_check = "ok"
      base.upstream_version = checked.version
      base.tool_count = checked.toolCount
    } catch (error) {
      base.runtime_check = "failed"
      base.status = "drift"
      issues.push({ code: "excel-runtime-check", message: safeMessage(error instanceof Error ? error.message : String(error)) })
    }
  }
  return base
}

function doctorManager(
  options: ManagerOptions & { command: "doctor" },
  paths: ManagerPaths,
  dependencies: ManagerDependencies,
): ManagerResult {
  const issues: Array<{ code: string; message: string }> = []
  const agentStatus: NonNullable<ManagerResult["agent_status"]> = []
  let receipt: ManagerReceipt | undefined
  try {
    receipt = readReceipt(paths, false)
  } catch (error) {
    issues.push({ code: "receipt-invalid", message: safeMessage(error instanceof Error ? error.message : String(error)) })
  }
  const pending = journalPaths(paths)
  if (pending.length) issues.push({ code: "pending-journal", message: `${pending.length} pending manager transaction journal(s) require inspection or --repair-journal.` })
  let previous: string | null = null
  if (!receipt) {
    issues.push({ code: "receipt-missing", message: "No managed install receipt is present." })
  } else {
    const expectedSpec = receipt.installed ? activeGeneration(receipt).spec : undefined
    for (const [kind, path] of [["server", paths.serverConfig], ["tui", paths.tuiConfig]] as const) {
      try {
        const specs = pluginSpecs(path)
        const count = expectedSpec ? specs.filter((spec) => specMatches(spec, expectedSpec)).length : 0
        const stale = receipt.generations.flatMap((item) => specs.filter((spec) => specMatches(spec, item.spec))).length
        if (receipt.installed && count !== 1) issues.push({ code: `${kind}-registration`, message: `${kind} config does not contain exactly one active ALG registration.` })
        if (!receipt.installed && stale !== 0) issues.push({ code: `${kind}-registration`, message: `${kind} config retains a managed ALG registration after uninstall.` })
      } catch (error) {
        issues.push({ code: `${kind}-config-invalid`, message: safeMessage(error instanceof Error ? error.message : String(error)) })
      }
    }
    if (receipt.installed) {
      const active = activeGeneration(receipt)
      previous = [...receipt.generations].reverse().find((item) => item.id !== active.id)?.id ?? null
      try {
        if (!samePath(canonicalDirectory(active.package_root), active.package_root)) throw new Error("active package root is redirected")
        const runner = dependencies.runner ?? new DefaultCommandRunner()
        const observed = validateReleaseRoot(active.package_root, active.tag, runner, active.commit)
        const observedRemote = git(runner, active.package_root, ["config", "--get", "remote.origin.url"])
        if (!remoteEqual(observedRemote, receipt.trusted_remote)) throw new Error("active release remote differs from receipt")
        assertCleanRepository(runner, active.package_root, "Active release")
        if (!generationMatches(observed, active)) throw new Error("active release identity differs from receipt")
      } catch (error) {
        issues.push({ code: "active-release-invalid", message: safeMessage(error instanceof Error ? error.message : String(error)) })
      }
    }
    for (const [name, agent] of Object.entries(receipt.agents).slice(0, 32)) {
      const target = resolveContainedPath(paths.agentsRoot, name)
      const current = fileHash(target)
      const status = agent.disposition === "managed"
        ? current === agent.managed_hash ? "managed" : "drift"
        : current === null ? "missing" : "custom"
      agentStatus.push({ name, status, source_hash: agent.source_hash, current_hash: current })
      if (agent.disposition === "managed" && current !== agent.managed_hash) {
        issues.push({ code: "agent-drift", message: `Managed agent ${name} is missing or customized.` })
      } else if (agent.disposition === "missing" && current !== null) {
        issues.push({ code: "agent-untracked", message: `Previously missing agent ${name} now exists and is custom.` })
      } else if (agent.disposition === "custom" && current === null) {
        issues.push({ code: "agent-missing", message: `Customized agent ${name} is now missing.` })
      }
    }
  }
  const capabilityStatus = doctorExcelCapability(receipt, paths, dependencies, issues)
  return {
    command: "doctor",
    ok: issues.length === 0,
    changed: false,
    dry_run: false,
    summary: issues.length ? `Doctor found ${issues.length} issue(s).` : "Doctor found no managed install issues.",
    receipt_path: paths.receiptPath,
    issues: issues.slice(0, 64),
    pending_journals: pending.map((path) => basename(path)),
    previous_generation: previous,
    restart_required: receipt?.restart_required.pending ?? false,
    agent_status: agentStatus,
    capability_status: capabilityStatus,
  }
}

function acknowledgeRestart(paths: ManagerPaths, dependencies: ManagerDependencies): void {
  const receipt = readReceipt(paths, true)!
  if (journalPaths(paths).length) throw new Error("Cannot acknowledge restart while a transaction journal is pending")
  if (!receipt.restart_required.pending) return
  const beforeHash = receiptBaselineHashes.get(receipt)
  if (!beforeHash) throw new Error("Restart acknowledgement receipt baseline is unavailable")
  const after: ManagerReceipt = ManagerReceiptSchema.parse({
    ...receipt,
    updated_at: nowIso(dependencies),
    restart_required: { pending: false, since: null, attested_at: nowIso(dependencies) },
  })
  commitTransaction({
    command: "restart-acknowledge",
    paths,
    plans: [],
    receiptBefore: receipt,
    receiptAfter: after,
    targetGeneration: receipt.active_generation,
    dependencies,
  })
}

function validateOptionCombinations(options: ManagerOptions): void {
  if (options.tag) assertStableTag(options.tag)
  if (options.version && !/^\d+\.\d+\.\d+$/.test(options.version)) throw new Error("--version requires MAJOR.MINOR.PATCH")
  requestedTag(options)
  if (options.command !== "rollback" && options.generation) throw new Error("--generation is only valid with rollback")
  if (options.command !== "uninstall" && options.removeAgents) throw new Error("--remove-agents is only valid with uninstall")
  if (options.command !== "doctor" && (options.repairJournal || options.ackRestart)) throw new Error("--repair-journal and --ack-restart are doctor-only")
  if (options.command === "doctor" && (options.source || options.remote || options.tag || options.version || options.generation)) {
    throw new Error("Release selection flags are not valid with doctor")
  }
  if (options.command === "rollback" && (options.source || options.remote)) throw new Error("Rollback selects only retained receipt generations")
  if (options.command === "uninstall" && (options.source || options.remote || options.tag || options.version)) throw new Error("Release selection flags are not valid with uninstall")
  if (options.command === "rollback" && options.agentPolicy === "force") throw new Error("Rollback does not support forced agents")
  if (options.dryRun && (options.repairJournal || options.ackRestart)) throw new Error("Dry-run cannot repair or acknowledge state")
  if (options.enableCapability && options.enableCapability !== EXCEL_CAPABILITY) throw new Error("Only --enable-capability excel is supported")
  if (options.disableCapability && options.disableCapability !== EXCEL_CAPABILITY) throw new Error("Only --disable-capability excel is supported")
  if (options.enableCapability && options.disableCapability) throw new Error("Capability enable and disable flags are mutually exclusive")
  if ((options.enableCapability || options.disableCapability || options.excelRoot) &&
    options.command !== "install" && options.command !== "update") {
    throw new Error("Excel capability flags are only valid with install or update")
  }
}

/** Shared manager API. Launchers and tests call the same implementation. */
export function runManager(options: ManagerOptions, dependencies: ManagerDependencies = {}): ManagerResult {
  validateOptionCombinations(options)
  const paths = managerPaths(options)
  const doctorMutation = options.command === "doctor" && (options.repairJournal || options.ackRestart)
  if (options.command === "doctor" && !doctorMutation) return doctorManager(options as ManagerOptions & { command: "doctor" }, paths, dependencies)

  createPaths(paths)
  const mutex = acquireFilesystemMutex(paths.lockPath, { owner: `opencode-alg-manager:${options.command}`, waitMs: 250 })
  try {
    if (options.command === "doctor") {
      if (options.repairJournal) {
        for (const journal of journalPaths(paths)) recoverJournal(journal, paths, dependencies)
      }
      if (options.ackRestart) acknowledgeRestart(paths, dependencies)
      const result = doctorManager(options as ManagerOptions & { command: "doctor" }, paths, dependencies)
      return { ...result, changed: Boolean(options.repairJournal || options.ackRestart) }
    }
    const pending = journalPaths(paths)
    if (pending.length) throw new Error("A pending manager journal blocks mutation; run doctor --repair-journal")
    if (options.ackRestart) throw new Error("--ack-restart is doctor-only")
    if (options.command === "install" || options.command === "update") {
      return installOrUpdate(options as ManagerOptions & { command: "install" | "update" }, paths, dependencies)
    }
    if (options.command === "rollback") return rollbackManager(options as ManagerOptions & { command: "rollback" }, paths, dependencies)
    return uninstallManager(options as ManagerOptions & { command: "uninstall" }, paths, dependencies)
  } finally {
    mutex.release()
  }
}

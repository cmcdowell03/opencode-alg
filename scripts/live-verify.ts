import { spawn, type ChildProcess } from "node:child_process"
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto"
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, isAbsolute, join, parse, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { createServer } from "node:net"
import { z } from "zod"
import { terminateProcessTree } from "../src/shell.ts"
import {
  ALG_LIVE_SOURCE_DIGEST_ENV,
  computeAlgSourceIdentity,
  sourceIdentityMessage,
  type AlgSourceIdentity,
} from "../src/source-identity.ts"
import {
  ALG_TUI_REGISTRATION_SERVICE,
  ALG_TUI_REGISTRATION_TOKEN,
} from "../src/tui-registration.ts"
import { ALG_PLUGIN_ID, ALG_TOOL_IDS, algServerStartupMessage } from "../src/types.ts"
export { ALG_TOOL_IDS } from "../src/types.ts"
// `opencode --version` is the only bounded one-shot command. On Windows the
// packaged executable has repeatedly taken 10-15 seconds to exit after a
// saturated suite/OneDrive workload despite printing the correct version and
// exiting 0. Keep this separate from server/TUI readiness and bounded at 30s;
// runCommand still invokes the same process-tree cleanup on timeout.
const VERSION_COMMAND_TIMEOUT_MS = 30_000
const SERVER_TIMEOUT_MS = 60_000
const TUI_TIMEOUT_MS = 60_000
const OUTPUT_LIMIT = 256 * 1024
export const LIVE_EVIDENCE_LIMIT_BYTES = 512 * 1024
const TUI_REGISTRATION_LINE_LIMIT = 4_096
const PROCESS_TERMINATION_TIMEOUT_MS = 7_000
const PROCESS_EXIT_TIMEOUT_MS = 5_000
export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
export const DEFAULT_LIVE_EVIDENCE_ROOT = join(tmpdir(), "opencode-alg-verification-evidence")
export const APPROVED_WINDOWS_LIVE_EVIDENCE_ROOT = "D:\\Docker\\model-temp\\opencode-alg-verification-evidence"
const ROOT = PLUGIN_ROOT
const SEMVER_COMPONENT = "(0|[1-9]\\d{0,5})"
const STABLE_SEMVER_PATTERN = new RegExp(`^${SEMVER_COMPONENT}\\.${SEMVER_COMPONENT}\\.${SEMVER_COMPONENT}$`)
const GLOBAL_CONFIG_FILES = ["opencode.json", "opencode.jsonc", "tui.json"] as const
const GLOBAL_CONFIG_FILE_LIMIT_BYTES = 1024 * 1024

const LiveShaSchema = z.string().regex(/^[a-f0-9]{64}$/)
const LivePathSchema = z.string().min(1).max(4_096)
const LiveBoundedTextSchema = z.string().max(OUTPUT_LIMIT)
const RuntimeManifestEntrySchema = z.object({ path: z.string().min(1).max(512), bytes: z.number().int().nonnegative() }).strict()
const RuntimeManifestSchema = z.object({
  digest: LiveShaSchema,
  entries: z.array(RuntimeManifestEntrySchema).max(256),
  file_count: z.number().int().nonnegative().max(256),
  total_bytes: z.number().int().nonnegative().max(8 * 1024 * 1024),
  bounds: z.object({ max_files: z.number().int().positive(), max_file_bytes: z.number().int().positive(), max_total_bytes: z.number().int().positive() }).strict(),
}).strict()
const SnapshotEntrySchema = z.object({
  scope: z.string().min(1).max(128), relative_path: z.enum([".", ...GLOBAL_CONFIG_FILES]), state: z.enum(["absent", "directory", "file"]),
  size: z.string().regex(/^\d+$/).nullable(), mtime_ns: z.string().regex(/^\d+$/).nullable(), ctime_ns: z.string().regex(/^\d+$/).nullable(),
  mode: z.number().int().nonnegative().nullable(), content_hmac_sha256: LiveShaSchema.nullable(),
}).strict()
const SnapshotSchema = z.object({ entries: z.array(SnapshotEntrySchema).min(1).max(32), sha256: LiveShaSchema }).strict()
const CleanupSchema = z.object({
  root_pid: z.number().int().positive().nullable(), cleanup_scope: z.enum(["root-process", "posix-process-group"]), exit_observed: z.boolean(),
  exit_code: z.number().int().nullable(), exit_signal: z.string().max(64).nullable(), termination_attempted: z.boolean(),
  termination_result: z.enum(["already-exited", "succeeded", "failed", "timed-out"]), tree_termination_attempted: z.boolean(),
  tree_termination_result: z.enum(["not-required", "succeeded", "failed", "timed-out"]), best_effort_kill_attempted: z.boolean(),
  error: z.string().max(2_048).optional(), passed: z.boolean(),
}).strict()
const VersionEvidenceSchema = z.object({
  executable_path: LivePathSchema, declared_engine_requirement: z.string().min(1).max(64), command: z.tuple([LivePathSchema, z.literal("--version")]),
  root_pid: z.number().int().positive().nullable(), stdout: LiveBoundedTextSchema, stderr: LiveBoundedTextSchema, exit_observed: z.boolean(),
  exit_code: z.number().int().nullable(), exit_signal: z.string().max(64).nullable(), timeout_ms: z.number().int().positive(), timed_out: z.boolean(),
  wait_error: z.string().max(2_048).optional(), cleanup: CleanupSchema, passed: z.boolean(),
  parsed: z.object({ text: z.string().max(64), major: z.number().int().nonnegative(), minor: z.number().int().nonnegative(), patch: z.number().int().nonnegative() }).strict().nullable(),
  reason: z.string().max(2_048),
}).strict()
const ServerEvidenceSchema = z.object({
  command: z.array(z.string().max(4_096)).min(1).max(16), root_pid: z.number().int().positive().nullable(), endpoint: z.string().max(4_096),
  readiness_attempts: z.number().int().nonnegative(), raw_http_status: z.number().int().nullable(), raw_http_body: LiveBoundedTextSchema,
  parsed_alg_ids: z.array(z.string().max(128)).max(64), source_identity_log: z.string().max(8_192).nullable(), last_request_error: z.string().max(2_048).optional(),
  stdout_tail: LiveBoundedTextSchema.optional(), stderr_tail: LiveBoundedTextSchema.optional(), cleanup: CleanupSchema.optional(),
}).strict()
const TuiEvidenceSchema = z.object({
  command: z.array(z.string().max(4_096)).min(1).max(16), root_pid: z.number().int().positive().nullable(), registration_log: z.string().max(8_192).optional(),
  source_identity_log: z.string().max(8_192).nullable().optional(), stdout_tail: LiveBoundedTextSchema.optional(), stderr_tail: LiveBoundedTextSchema.optional(), cleanup: CleanupSchema.optional(),
}).strict()

export const LiveEvidenceSchema = z.object({
  schema_version: z.literal(2), kind: z.literal("opencode-alg-live-verification"), generated_at: z.iso.datetime({ offset: true }), no_model_calls: z.literal(true),
  plugin_source: z.object({
    package_version: z.string().min(1).max(64), canonical_root: LivePathSchema, package_spec: z.string().min(1).max(8_192), sha256: LiveShaSchema,
    runtime_manifest: RuntimeManifestSchema, entry_points: z.object({ server: LivePathSchema, tui: LivePathSchema }).strict(),
    registrations: z.object({ server: z.array(z.string().max(8_192)).length(1), tui: z.array(z.string().max(8_192)).length(1) }).strict(),
  }).strict(),
  isolation: z.object({
    project_config_disabled: z.literal(true), default_plugins_disabled: z.literal(true), external_skills_disabled: z.literal(true), isolated_xdg_config: z.literal(true),
    explicit_server_config: LivePathSchema, isolated_tui_config: LivePathSchema, parent_global_plugin_state_used: z.literal(false), user_global_config_modified: z.boolean(),
    global_config_snapshots: z.object({ algorithm: z.literal("ephemeral-key-hmac-sha256-plus-file-metadata"), allowlisted_relative_paths: z.tuple([z.literal("."), ...GLOBAL_CONFIG_FILES.map((item) => z.literal(item))]), before: SnapshotSchema, after: SnapshotSchema.nullable(), unchanged: z.boolean() }).strict(),
  }).strict(),
  declared_engine_requirement: z.string().min(1).max(64), required_alg_tool_ids: z.array(z.string().max(128)).length(ALG_TOOL_IDS.length), output_path: LivePathSchema,
  temporary_environment_removed: z.boolean(), passed: z.boolean(), reason: z.string().max(2_048), failure: z.string().max(2_048).optional(),
  cleanup_failures: z.array(z.string().max(2_048)).max(2).optional(), version: VersionEvidenceSchema, server: ServerEvidenceSchema.optional(), tui: TuiEvidenceSchema.optional(),
}).strict()

export interface GlobalConfigRoot {
  scope: string
  path: string
}

export interface GlobalConfigSnapshotEntry {
  scope: string
  relative_path: "." | typeof GLOBAL_CONFIG_FILES[number]
  state: "absent" | "directory" | "file"
  size: string | null
  mtime_ns: string | null
  ctime_ns: string | null
  mode: number | null
  content_hmac_sha256: string | null
}

export interface GlobalConfigSnapshot {
  entries: GlobalConfigSnapshotEntry[]
  sha256: string
}

function uniqueGlobalConfigRoots(roots: GlobalConfigRoot[]): GlobalConfigRoot[] {
  const seen = new Set<string>()
  return roots.filter((root) => {
    const path = normalizedPath(root.path)
    if (seen.has(path)) return false
    seen.add(path)
    return true
  })
}

/** Resolve real-user config roots before the child HOME/XDG environment is isolated. */
export function realUserGlobalConfigRoots(
  environment: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): GlobalConfigRoot[] {
  const roots: GlobalConfigRoot[] = []
  const add = (scope: string, base: string | undefined, segments: string[]) => {
    if (!base?.trim()) return
    if (!isAbsolute(base)) throw new Error(`real-user ${scope} config base must be absolute`)
    roots.push({ scope, path: resolve(base, ...segments) })
  }
  add("xdg", environment.XDG_CONFIG_HOME, ["opencode"])
  add("home", environment.HOME ?? environment.USERPROFILE, [".config", "opencode"])
  if (platform === "win32") add("appdata", environment.APPDATA, ["opencode"])
  if (!roots.length) throw new Error("unable to resolve a real-user OpenCode config root")
  return uniqueGlobalConfigRoots(roots)
}

function snapshotEntry(
  root: GlobalConfigRoot,
  relativePath: GlobalConfigSnapshotEntry["relative_path"],
  hmacKey: Uint8Array,
): GlobalConfigSnapshotEntry {
  const path = relativePath === "." ? root.path : join(root.path, relativePath)
  if (!existsSync(path)) {
    return {
      scope: root.scope, relative_path: relativePath, state: "absent",
      size: null, mtime_ns: null, ctime_ns: null, mode: null, content_hmac_sha256: null,
    }
  }
  const stat = lstatSync(path, { bigint: true })
  if (stat.isSymbolicLink()) throw new Error(`real-user OpenCode config allowlist contains a symlink or junction (${root.scope}/${relativePath})`)
  const canonical = realpathSync.native(path)
  if (normalizedPath(canonical) !== normalizedPath(path)) {
    throw new Error(`real-user OpenCode config allowlist is redirected (${root.scope}/${relativePath})`)
  }
  const expectedDirectory = relativePath === "."
  if ((expectedDirectory && !stat.isDirectory()) || (!expectedDirectory && !stat.isFile())) {
    throw new Error(`real-user OpenCode config allowlist has an unexpected file type (${root.scope}/${relativePath})`)
  }
  let contentHmac: string | null = null
  if (!expectedDirectory) {
    if (stat.size > BigInt(GLOBAL_CONFIG_FILE_LIMIT_BYTES)) {
      throw new Error(`real-user OpenCode config file exceeds ${GLOBAL_CONFIG_FILE_LIMIT_BYTES} bytes (${root.scope}/${relativePath})`)
    }
    const bytes = readFileSync(path)
    const after = lstatSync(path, { bigint: true })
    if (after.size !== stat.size || after.mtimeNs !== stat.mtimeNs || after.ctimeNs !== stat.ctimeNs) {
      throw new Error(`real-user OpenCode config changed while it was being snapshotted (${root.scope}/${relativePath})`)
    }
    contentHmac = createHmac("sha256", hmacKey)
      .update(root.scope).update("\0").update(relativePath).update("\0").update(bytes).digest("hex")
  }
  return {
    scope: root.scope,
    relative_path: relativePath,
    state: expectedDirectory ? "directory" : "file",
    size: stat.size.toString(),
    mtime_ns: stat.mtimeNs.toString(),
    ctime_ns: stat.ctimeNs.toString(),
    mode: Number(stat.mode),
    content_hmac_sha256: contentHmac,
  }
}

/** Snapshot only known config files; keyed fingerprints never expose config contents or reusable hashes. */
export function snapshotGlobalOpenCodeConfig(
  roots: GlobalConfigRoot[],
  hmacKey: Uint8Array,
): GlobalConfigSnapshot {
  if (hmacKey.byteLength < 32) throw new Error("global config snapshot HMAC key must contain at least 32 bytes")
  const entries = uniqueGlobalConfigRoots(roots).flatMap((root) => [
    snapshotEntry(root, ".", hmacKey),
    ...GLOBAL_CONFIG_FILES.map((path) => snapshotEntry(root, path, hmacKey)),
  ])
  const serialized = Buffer.from(JSON.stringify(entries), "utf8")
  return { entries, sha256: createHash("sha256").update(serialized).digest("hex") }
}

export interface LiveEvidenceDestinationOptions {
  pluginRoot?: string
  repositoryRoot?: string
  tempEvidenceRoot?: string
  approvedEvidenceRoot?: string | null
}

export interface PreparedLiveEvidenceDestination {
  path: string
  evidence_root: string
  repository_root: string
}

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function pathWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

function assertPlainDirectory(path: string): string {
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    throw new Error(`live evidence destination must not traverse a symlink or junction: ${path}`)
  }
  if (!stat.isDirectory()) throw new Error(`live evidence destination parent is not a directory: ${path}`)
  const canonical = realpathSync.native(path)
  if (normalizedPath(canonical) !== normalizedPath(path)) {
    throw new Error(`live evidence destination parent redirects through a symlink or junction: ${path}`)
  }
  return canonical
}

/** Create missing parents one component at a time and realpath every existing component. */
function createVerifiedDirectory(path: string): string {
  const absolute = resolve(path)
  const parsed = parse(absolute)
  let current = parsed.root
  assertPlainDirectory(current)
  const tail = absolute.slice(parsed.root.length).split(/[\\/]+/).filter(Boolean)
  for (const component of tail) {
    current = join(current, component)
    if (!existsSync(current)) mkdirSync(current)
    assertPlainDirectory(current)
  }
  return realpathSync.native(absolute)
}

export function findContainingRepositoryRoot(start = PLUGIN_ROOT): string {
  let current = realpathSync.native(resolve(start))
  while (true) {
    const marker = join(current, ".git")
    if (existsSync(marker)) {
      const stat = lstatSync(marker)
      if (stat.isSymbolicLink()) throw new Error(`repository marker must not be a symlink or junction: ${marker}`)
      if (!stat.isDirectory() && !stat.isFile()) throw new Error(`invalid repository marker: ${marker}`)
      return current
    }
    const parent = dirname(current)
    if (parent === current) throw new Error(`no containing repository found for live evidence source: ${start}`)
    current = parent
  }
}

/**
 * Constrain retained evidence to a dedicated external root. The portable root
 * is under os.tmpdir(); the additional D: root is available only on Windows.
 */
export function prepareLiveEvidenceDestination(
  outputPath: string,
  options: LiveEvidenceDestinationOptions = {},
): PreparedLiveEvidenceDestination {
  if (!isAbsolute(outputPath)) throw new Error("live verification output path must be absolute")
  const destination = resolve(outputPath)
  const repositoryRoot = realpathSync.native(resolve(
    options.repositoryRoot ?? findContainingRepositoryRoot(options.pluginRoot ?? PLUGIN_ROOT),
  ))
  if (pathWithin(repositoryRoot, destination)) {
    throw new Error("live verification evidence must remain outside the entire containing repository")
  }

  const allowedRoots = [resolve(options.tempEvidenceRoot ?? DEFAULT_LIVE_EVIDENCE_ROOT)]
  const approved = options.approvedEvidenceRoot === undefined
    ? (process.platform === "win32" ? APPROVED_WINDOWS_LIVE_EVIDENCE_ROOT : null)
    : options.approvedEvidenceRoot
  if (approved) allowedRoots.push(resolve(approved))
  const selectedRoot = allowedRoots.find((root) => pathWithin(root, destination) && normalizedPath(root) !== normalizedPath(destination))
  if (!selectedRoot) {
    throw new Error("live verification evidence must be inside a dedicated external evidence root")
  }

  const canonicalEvidenceRoot = createVerifiedDirectory(selectedRoot)
  const canonicalParent = createVerifiedDirectory(dirname(destination))
  if (!pathWithin(canonicalEvidenceRoot, canonicalParent)) {
    throw new Error("live verification evidence parent escapes its dedicated external evidence root")
  }
  if (pathWithin(repositoryRoot, canonicalParent)) {
    throw new Error("live verification evidence parent redirects into the containing repository")
  }
  if (existsSync(destination)) {
    const stat = lstatSync(destination)
    if (stat.isSymbolicLink()) {
      throw new Error("live verification evidence file must not be a symlink or junction")
    }
    if (!stat.isFile()) throw new Error("live verification evidence destination must be a regular file")
    const canonicalDestination = realpathSync.native(destination)
    if (!pathWithin(canonicalEvidenceRoot, canonicalDestination) || pathWithin(repositoryRoot, canonicalDestination)) {
      throw new Error("live verification evidence file redirects outside its dedicated external evidence root")
    }
  }
  return {
    path: destination,
    evidence_root: canonicalEvidenceRoot,
    repository_root: repositoryRoot,
  }
}

export interface VerificationPluginConfiguration {
  source: AlgSourceIdentity
  package_version: string
  entry_points: {
    server: string
    tui: string
  }
  server_config: { $schema: string; plugin: [string] }
  tui_config: { $schema: string; plugin: [string] }
}

export function verificationPluginConfiguration(root = ROOT): VerificationPluginConfiguration {
  const source = computeAlgSourceIdentity(root)
  const packageJson = JSON.parse(readFileSync(join(source.root, "package.json"), "utf8")) as {
    version?: unknown
    exports?: Record<string, unknown>
    opencode?: { server?: unknown; tui?: unknown }
  }
  if (packageJson.exports?.["./server"] !== "./src/server.ts" ||
    packageJson.exports?.["./tui"] !== "./src/tui.ts" ||
    packageJson.opencode?.server !== "./src/server.ts" || packageJson.opencode?.tui !== "./src/tui.ts") {
    throw new Error("reviewed package must expose exact ./src/server.ts and ./src/tui.ts OpenCode entry points")
  }
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    throw new Error("reviewed package must declare a non-empty version")
  }
  return {
    source,
    package_version: packageJson.version,
    entry_points: {
      server: join(source.root, "src", "server.ts"),
      tui: join(source.root, "src", "tui.ts"),
    },
    server_config: { $schema: "https://opencode.ai/config.json", plugin: [source.spec] },
    tui_config: { $schema: "https://opencode.ai/tui.json", plugin: [source.spec] },
  }
}

export function assertVerificationPluginConfiguration(
  configuration: VerificationPluginConfiguration,
  expectedRoot = ROOT,
): void {
  const expected = computeAlgSourceIdentity(expectedRoot)
  if (configuration.source.root !== expected.root || configuration.source.spec !== expected.spec ||
    configuration.source.digest !== expected.digest ||
    configuration.source.file_count !== expected.file_count ||
    configuration.source.total_bytes !== expected.total_bytes ||
    JSON.stringify(configuration.source.manifest) !== JSON.stringify(expected.manifest) ||
    JSON.stringify(configuration.source.bounds) !== JSON.stringify(expected.bounds) ||
    configuration.entry_points.server !== join(expected.root, "src", "server.ts") ||
    configuration.entry_points.tui !== join(expected.root, "src", "tui.ts") ||
    configuration.server_config.plugin.length !== 1 ||
    configuration.server_config.plugin[0] !== expected.spec ||
    configuration.tui_config.plugin.length !== 1 || configuration.tui_config.plugin[0] !== expected.spec) {
    throw new Error("isolated live configuration does not bind both entry points to the reviewed package checkout")
  }
}

export interface StableVersion {
  text: string
  major: number
  minor: number
  patch: number
}

export interface VersionCompatibility {
  compatible: boolean
  requirement: string
  parsed: StableVersion | null
  reason: string
}

function declaredOpenCodeEngineRequirement(): string {
  const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    engines?: { opencode?: unknown }
  }
  const requirement = packageJson.engines?.opencode
  if (typeof requirement !== "string" || !requirement) {
    throw new Error("package.json engines.opencode must be a non-empty string")
  }
  return requirement
}

export function parseStableVersion(text: string): StableVersion | null {
  const match = STABLE_SEMVER_PATTERN.exec(text)
  if (!match) return null
  return {
    text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  }
}

function compareVersions(left: StableVersion, right: StableVersion): number {
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch
}

export const OPENCODE_ENGINE_REQUIREMENT = declaredOpenCodeEngineRequirement()

function minimumVersionForRequirement(requirement: string): StableVersion {
  if (!requirement.startsWith(">=")) {
    throw new Error(`unsupported package.json engines.opencode requirement: ${JSON.stringify(requirement)}`)
  }
  const minimum = parseStableVersion(requirement.slice(2))
  if (!minimum) {
    throw new Error(`engines.opencode must be a stable >=MAJOR.MINOR.PATCH requirement: ${JSON.stringify(requirement)}`)
  }
  return minimum
}

const MINIMUM_OPENCODE_VERSION = minimumVersionForRequirement(OPENCODE_ENGINE_REQUIREMENT)

export function validateOpenCodeVersion(text: string): VersionCompatibility {
  const parsed = parseStableVersion(text)
  if (!parsed) {
    return {
      compatible: false,
      requirement: OPENCODE_ENGINE_REQUIREMENT,
      parsed: null,
      reason: "runtime output is not a stable MAJOR.MINOR.PATCH version",
    }
  }
  if (compareVersions(parsed, MINIMUM_OPENCODE_VERSION) < 0) {
    return {
      compatible: false,
      requirement: OPENCODE_ENGINE_REQUIREMENT,
      parsed,
      reason: `OpenCode ${parsed.text} does not satisfy ${OPENCODE_ENGINE_REQUIREMENT}`,
    }
  }
  return {
    compatible: true,
    requirement: OPENCODE_ENGINE_REQUIREMENT,
    parsed,
    reason: `OpenCode ${parsed.text} satisfies ${OPENCODE_ENGINE_REQUIREMENT}`,
  }
}

function versionLine(stdout: string): string {
  // The CLI writes one version line. Deliberately permit its single line
  // terminator, but reject surrounding whitespace, extra lines, and metadata.
  return stdout.endsWith("\r\n")
    ? stdout.slice(0, -2)
    : stdout.endsWith("\n")
      ? stdout.slice(0, -1)
      : stdout
}

export interface CapturedProcess {
  child: ChildProcess
  stdout(): string
  stderr(): string
  exit(): { observed: boolean; code: number | null; signal: NodeJS.Signals | null }
}

export interface ProcessCleanupEvidence {
  root_pid: number | null
  cleanup_scope: "root-process" | "posix-process-group"
  exit_observed: boolean
  exit_code: number | null
  exit_signal: NodeJS.Signals | null
  termination_attempted: boolean
  termination_result: "already-exited" | "succeeded" | "failed" | "timed-out"
  tree_termination_attempted: boolean
  tree_termination_result: "not-required" | "succeeded" | "failed" | "timed-out"
  best_effort_kill_attempted: boolean
  error?: string
  passed: boolean
}

export interface ProcessCleanupOptions {
  platform?: NodeJS.Platform
  terminationTimeoutMs?: number
  exitTimeoutMs?: number
  pollIntervalMs?: number
  terminateTree?: (child: ChildProcess) => Promise<void>
}

export interface VersionCommandEvidence {
  command: [string, "--version"]
  root_pid: number | null
  stdout: string
  stderr: string
  exit_observed: boolean
  exit_code: number | null
  exit_signal: NodeJS.Signals | null
  timeout_ms: number
  timed_out: boolean
  wait_error?: string
  cleanup: ProcessCleanupEvidence
  passed: boolean
}

export interface VersionCommandOptions {
  timeoutMs?: number
  captured?: CapturedProcess
  cleanupOptions?: ProcessCleanupOptions
  environment?: NodeJS.ProcessEnv
}

export class VersionCommandError extends Error {
  readonly evidence: VersionCommandEvidence

  constructor(message: string, evidence: VersionCommandEvidence, options: ErrorOptions = {}) {
    super(message, options)
    this.name = "VersionCommandError"
    this.evidence = evidence
  }
}

function appendTail(current: string, chunk: Buffer | string): string {
  const next = `${current}${chunk.toString()}`
  return next.length <= OUTPUT_LIMIT ? next : next.slice(-OUTPUT_LIMIT)
}

function isolatedProcessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  // Parent escape hatches must not silently disable or replace the reviewed
  // package selected by this verification run.
  for (const key of [
    "OPENCODE_CONFIG",
    "OPENCODE_CONFIG_CONTENT",
    "OPENCODE_CONFIG_DIR",
    "OPENCODE_PURE",
    ALG_LIVE_SOURCE_DIGEST_ENV,
  ]) delete env[key]
  Object.assign(env, {
    OPENCODE_DISABLE_PROJECT_CONFIG: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    ...overrides,
  })
  return env
}

function spawnCaptured(
  command: string,
  args: string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = {},
): CapturedProcess {
  // Verification creates and configures its own isolated project. Parent
  // project discovery can otherwise make startup depend on unrelated workspace
  // configuration (including this source checkout while it is being edited).
  const child = spawn(command, args, {
    cwd,
    env: isolatedProcessEnvironment(environment),
    windowsHide: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  let stderr = ""
  let exitObserved = child.exitCode !== null
  let observedExitCode = child.exitCode
  let observedExitSignal: NodeJS.Signals | null = child.signalCode
  child.stdout?.on("data", (chunk: Buffer) => { stdout = appendTail(stdout, chunk) })
  child.stderr?.on("data", (chunk: Buffer) => { stderr = appendTail(stderr, chunk) })
  child.once("close", (code, signal) => {
    exitObserved = true
    observedExitCode = code
    observedExitSignal = signal
  })
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    exit: () => ({
      observed: exitObserved || child.exitCode !== null,
      code: observedExitCode ?? child.exitCode,
      signal: observedExitSignal ?? child.signalCode,
    }),
  }
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

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 1_000)
}

async function waitForObservedExit(captured: CapturedProcess, timeoutMs: number, pollIntervalMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (!captured.exit().observed && Date.now() < deadline) await Bun.sleep(pollIntervalMs)
  return captured.exit().observed
}

/**
 * Stop one process with bounded, auditable cleanup evidence. Windows live
 * verification launches the packaged executable directly, so successful
 * evidence is intentionally limited to observing that root process exit; it
 * does not claim Job Object or general descendant containment. POSIX uses the
 * existing process-group terminator and records any failure or outer timeout.
 */
export async function stopCapturedProcess(
  captured: CapturedProcess,
  options: ProcessCleanupOptions = {},
): Promise<ProcessCleanupEvidence> {
  const child = captured.child
  const platform = options.platform ?? process.platform
  const cleanupScope = platform === "win32" ? "root-process" : "posix-process-group"
  const terminationTimeoutMs = Math.max(1, options.terminationTimeoutMs ?? PROCESS_TERMINATION_TIMEOUT_MS)
  const exitTimeoutMs = Math.max(1, options.exitTimeoutMs ?? PROCESS_EXIT_TIMEOUT_MS)
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 25)
  const evidence: ProcessCleanupEvidence = {
    root_pid: child.pid ?? null,
    cleanup_scope: cleanupScope,
    exit_observed: captured.exit().observed,
    exit_code: captured.exit().code,
    exit_signal: captured.exit().signal,
    termination_attempted: false,
    termination_result: captured.exit().observed ? "already-exited" : "failed",
    tree_termination_attempted: false,
    tree_termination_result: "not-required",
    best_effort_kill_attempted: false,
    passed: captured.exit().observed,
  }
  if (evidence.exit_observed) return evidence

  evidence.termination_attempted = true
  // A direct packaged executable on Windows can provide an honest root-exit
  // proof without pretending it was launched in a Job Object. If it does not
  // exit promptly, fall through to the bounded tree terminator; its failure is
  // retained and makes cleanup fail even if the final best-effort kill works.
  if (platform === "win32") {
    try {
      const signalled = child.kill("SIGTERM")
      if (!signalled) throw new Error("root termination signal was not accepted")
      if (await waitForObservedExit(captured, Math.min(2_000, exitTimeoutMs), pollIntervalMs)) {
        evidence.exit_observed = true
        evidence.exit_code = captured.exit().code
        evidence.exit_signal = captured.exit().signal
        evidence.termination_result = "succeeded"
        evidence.passed = true
        return evidence
      }
    } catch (error) {
      evidence.error = boundedError(error)
    }
  }

  evidence.tree_termination_attempted = true
  const terminateTree = options.terminateTree ?? ((target: ChildProcess) =>
    terminateProcessTree(target as ReturnType<typeof spawn>, { terminationGraceMs: 1_000 }))
  const termination = await Promise.race([
    Promise.resolve()
      .then(() => terminateTree(child))
      .then(
        () => ({ result: "succeeded" as const }),
        (error) => ({ result: "failed" as const, error: boundedError(error) }),
      ),
    Bun.sleep(terminationTimeoutMs).then(() => ({
      result: "timed-out" as const,
      error: `process cleanup exceeded ${terminationTimeoutMs} ms`,
    })),
  ])
  evidence.tree_termination_result = termination.result
  if (termination.result !== "succeeded") {
    evidence.error = [evidence.error, termination.error].filter(Boolean).join("; ").slice(0, 1_000)
    evidence.best_effort_kill_attempted = true
    try { child.kill("SIGKILL") } catch { /* evidence remains failed */ }
  }
  evidence.exit_observed = await waitForObservedExit(captured, exitTimeoutMs, pollIntervalMs)
  evidence.exit_code = captured.exit().code
  evidence.exit_signal = captured.exit().signal
  evidence.termination_result = termination.result
  evidence.passed = termination.result === "succeeded" && evidence.exit_observed
  if (!evidence.exit_observed) {
    evidence.error = [evidence.error, `root process exit was not observed within ${exitTimeoutMs} ms`]
      .filter(Boolean).join("; ").slice(0, 1_000)
    if (!evidence.best_effort_kill_attempted) {
      evidence.best_effort_kill_attempted = true
      try { child.kill("SIGKILL") } catch { /* evidence already records failure */ }
    }
  }
  return evidence
}

export interface TemporaryEnvironmentRemovalOptions {
  timeoutMs?: number
  retryDelayMs?: number
  remove?: (path: string) => void
  exists?: (path: string) => boolean
  sleep?: (milliseconds: number) => Promise<void>
}

export interface TemporaryEnvironmentRemovalEvidence {
  removed: boolean
  error?: string
}

export async function removeTemporaryEnvironment(
  path: string,
  options: TemporaryEnvironmentRemovalOptions = {},
): Promise<TemporaryEnvironmentRemovalEvidence> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000)
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? 100)
  const remove = options.remove ?? ((target: string) => rmSync(target, { recursive: true, force: true }))
  const exists = options.exists ?? existsSync
  const sleep = options.sleep ?? Bun.sleep
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      remove(path)
      if (exists(path)) {
        return { removed: false, error: "temporary environment still exists after removal" }
      }
      return { removed: true }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"].includes(code ?? "") || Date.now() >= deadline) {
        return { removed: false, error: boundedError(error) }
      }
      await sleep(retryDelayMs)
    }
  }
}

async function waitForExit(process: CapturedProcess, timeoutMs: number): Promise<number> {
  const observed = process.exit()
  if (observed.observed) return observed.code ?? 1
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

function failedCleanupEvidence(error: unknown, captured?: CapturedProcess): ProcessCleanupEvidence {
  const observed = captured?.exit() ?? { observed: false, code: null, signal: null }
  return {
    root_pid: captured?.child.pid ?? null,
    cleanup_scope: process.platform === "win32" ? "root-process" : "posix-process-group",
    exit_observed: observed.observed,
    exit_code: observed.code,
    exit_signal: observed.signal,
    termination_attempted: false,
    termination_result: observed.observed ? "already-exited" : "failed",
    tree_termination_attempted: false,
    tree_termination_result: "not-required",
    best_effort_kill_attempted: false,
    error: boundedError(error),
    passed: false,
  }
}

async function stopCapturedProcessSafely(captured: CapturedProcess): Promise<ProcessCleanupEvidence> {
  try {
    return await stopCapturedProcess(captured)
  } catch (error) {
    return failedCleanupEvidence(error, captured)
  }
}

export function liveVerificationPassed(input: {
  verificationCompleted: boolean
  failure: unknown
  serverCleanup?: ProcessCleanupEvidence
  tuiCleanup?: ProcessCleanupEvidence
  temporaryEnvironmentRemoved: boolean
  userGlobalConfigUnchanged?: boolean
}): boolean {
  return input.failure === undefined && input.verificationCompleted &&
    input.serverCleanup?.passed === true && input.tuiCleanup?.passed === true &&
    input.temporaryEnvironmentRemoved && input.userGlobalConfigUnchanged !== false
}

const LIVE_EVIDENCE_NAME = /^live-verification-([0-9a-f]{16})-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/

export function uniqueLiveEvidencePath(directory: string, sourceSha256: string, uuid = randomUUID()): string {
  if (!/^[0-9a-f]{64}$/.test(sourceSha256) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid)) {
    throw new Error("live evidence source hash or UUID is invalid")
  }
  return join(resolve(directory), `live-verification-${sourceSha256.slice(0, 16)}-${uuid}.json`)
}

export interface EvidenceFileIdentity {
  dev: string
  ino: string
}

function evidenceFileIdentity(path: string): EvidenceFileIdentity {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || normalizedPath(realpathSync.native(path)) !== normalizedPath(path)) {
    throw new Error(`evidence path is redirected or not a direct regular file: ${path}`)
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function sameEvidenceIdentity(left: EvidenceFileIdentity, right: EvidenceFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function evidencePathMissing(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return true
    throw error
  }
}

function assertEvidenceFile(path: string, identity: EvidenceFileIdentity, bytes: Buffer, label: string): void {
  if (!sameEvidenceIdentity(evidenceFileIdentity(path), identity) || !readFileSync(path).equals(bytes)) {
    throw new Error(`${label} bytes or identity changed: ${path}`)
  }
}

export function persistImmutableLiveEvidence(
  path: string,
  input: Uint8Array,
  options: {
    link?: typeof linkSync
    unlink?: typeof unlinkSync
    afterLink?: (temporary: string, final: string) => void
    afterFinalVerified?: (temporary: string, final: string) => void
  } = {},
): { path: string; sha256: string; bytes: number; identity: EvidenceFileIdentity } {
  const bytes = Buffer.from(input)
  const temporary = `${path}.tmp-${randomUUID()}`
  const link = options.link ?? linkSync
  const unlink = options.unlink ?? unlinkSync
  let temporaryIdentity: EvidenceFileIdentity | undefined
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 })
    temporaryIdentity = evidenceFileIdentity(temporary)
    assertEvidenceFile(temporary, temporaryIdentity, bytes, "live evidence temporary")
    link(temporary, path)
    options.afterLink?.(temporary, path)
    const finalIdentity = evidenceFileIdentity(path)
    if (!sameEvidenceIdentity(finalIdentity, temporaryIdentity)) throw new Error("live evidence final identity differs from its temporary hard link")
    assertEvidenceFile(path, finalIdentity, bytes, "live evidence final")
    options.afterFinalVerified?.(temporary, path)
    assertEvidenceFile(temporary, temporaryIdentity, bytes, "live evidence temporary before cleanup")
    unlink(temporary)
    assertEvidenceFile(path, finalIdentity, bytes, "live evidence final after temporary cleanup")
    return {
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.byteLength,
      identity: finalIdentity,
    }
  } catch (error) {
    let cleanupFailure: unknown
    if (temporaryIdentity && !evidencePathMissing(temporary)) {
      try {
        assertEvidenceFile(temporary, temporaryIdentity, bytes, "live evidence temporary cleanup")
        unlink(temporary)
      } catch (cleanupError) {
        cleanupFailure = cleanupError
      }
    }
    const detail = error instanceof Error ? error.message : String(error)
    const cleanup = cleanupFailure === undefined ? "" : `; temporary preserved: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`
    throw new Error(`live evidence no-clobber publication failed: ${detail}${cleanup}`)
  }
}

export function verifyRetainedLiveEvidenceArtifact(
  path: string,
  expected: { source_sha256: string; sha256?: string; bytes?: number; identity?: EvidenceFileIdentity },
  root = PLUGIN_ROOT,
): { path: string; sha256: string; bytes: number; identity: EvidenceFileIdentity; evidence: Record<string, any> } {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error("retained live evidence path must be absolute and exist")
  const match = LIVE_EVIDENCE_NAME.exec(path.split(/[\\/]/).at(-1) ?? "")
  if (!match || match[1] !== expected.source_sha256.slice(0, 16)) throw new Error("retained live evidence filename is not unique or source-prefixed")
  const identity = evidenceFileIdentity(path)
  if (expected.identity !== undefined && !sameEvidenceIdentity(identity, expected.identity)) throw new Error("retained live evidence identity differs from publication")
  const bytes = readFileSync(path)
  const hash = createHash("sha256").update(bytes).digest("hex")
  if (bytes.byteLength > LIVE_EVIDENCE_LIMIT_BYTES || expected.bytes !== undefined && bytes.byteLength !== expected.bytes ||
    expected.sha256 !== undefined && hash !== expected.sha256) throw new Error("retained live evidence size/hash is invalid")
  const evidence = validateRetainedLiveEvidence(JSON.parse(bytes.toString("utf8")), root)
  if (evidence.plugin_source?.sha256 !== expected.source_sha256) throw new Error("retained live evidence source differs from filename/expectation")
  if (!sameEvidenceIdentity(evidenceFileIdentity(path), identity)) throw new Error("retained live evidence identity changed during verification")
  return { path, sha256: hash, bytes: bytes.byteLength, identity, evidence }
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

/** Strict current-checkout semantic validation for retained live evidence. */
export function validateRetainedLiveEvidence(value: unknown, root = PLUGIN_ROOT): Record<string, any> {
  const evidence = LiveEvidenceSchema.parse(value) as Record<string, any>
  const configuration = verificationPluginConfiguration(root)
  const source = configuration.source
  if (evidence.passed !== true || evidence.no_model_calls !== true || evidence.temporary_environment_removed !== true) {
    throw new Error("live evidence does not prove passed/no-model/temporary cleanup semantics")
  }
  if (evidence.declared_engine_requirement !== OPENCODE_ENGINE_REQUIREMENT ||
    !exactJson(evidence.required_alg_tool_ids, ALG_TOOL_IDS)) throw new Error("live evidence engine/tool requirements differ")
  const plugin = evidence.plugin_source
  if (plugin?.package_version !== configuration.package_version ||
    normalizedPath(plugin?.canonical_root ?? "") !== normalizedPath(source.root) || plugin?.package_spec !== source.spec ||
    plugin?.sha256 !== source.digest || !exactJson(plugin?.entry_points, configuration.entry_points) ||
    !exactJson(plugin?.registrations?.server, configuration.server_config.plugin) ||
    !exactJson(plugin?.registrations?.tui, configuration.tui_config.plugin)) throw new Error("live plugin identity/registration differs from current checkout")
  const manifest = plugin?.runtime_manifest
  if (manifest?.digest !== source.digest || !exactJson(manifest?.entries, source.manifest) ||
    manifest?.file_count !== source.file_count || manifest?.total_bytes !== source.total_bytes ||
    !exactJson(manifest?.bounds, source.bounds)) throw new Error("live runtime manifest differs from current checkout")
  const isolation = evidence.isolation
  for (const field of ["project_config_disabled", "default_plugins_disabled", "external_skills_disabled", "isolated_xdg_config"] as const) {
    if (isolation?.[field] !== true) throw new Error(`live isolation ${field} is not true`)
  }
  if (isolation?.parent_global_plugin_state_used !== false || isolation?.user_global_config_modified !== false) {
    throw new Error("live isolation/global-config claims are invalid")
  }
  const snapshots = isolation?.global_config_snapshots
  if (snapshots?.algorithm !== "ephemeral-key-hmac-sha256-plus-file-metadata" ||
    !exactJson(snapshots?.allowlisted_relative_paths, [".", ...GLOBAL_CONFIG_FILES]) || snapshots?.unchanged !== true) {
    throw new Error("live global-config snapshot contract is invalid")
  }
  const before = snapshots?.before
  const after = snapshots?.after
  if (!Array.isArray(before?.entries) || before.entries.length === 0 || !Array.isArray(after?.entries) ||
    !exactJson(before.entries, after.entries) || before.sha256 !== after.sha256 || !/^[a-f0-9]{64}$/.test(before.sha256 ?? "") ||
    createHash("sha256").update(Buffer.from(JSON.stringify(before.entries), "utf8")).digest("hex") !== before.sha256) {
    throw new Error("live global-config before/after snapshots are empty, malformed, or unequal")
  }
  const keys = new Set<string>()
  const scopes = new Map<string, Set<string>>()
  for (const entry of before.entries) {
    if (!entry || typeof entry !== "object" || typeof entry.scope !== "string" || !entry.scope ||
      !GLOBAL_CONFIG_FILES.includes(entry.relative_path) && entry.relative_path !== "." ||
      !["absent", "directory", "file"].includes(entry.state)) throw new Error("live global-config snapshot entry is malformed")
    const key = `${entry.scope}\0${entry.relative_path}`
    if (keys.has(key)) throw new Error("live global-config snapshot contains duplicate scope/path")
    keys.add(key)
    const paths = scopes.get(entry.scope) ?? new Set<string>()
    paths.add(entry.relative_path)
    scopes.set(entry.scope, paths)
    const absent = entry.state === "absent"
    if (absent !== (entry.size === null && entry.mtime_ns === null && entry.ctime_ns === null && entry.mode === null && entry.content_hmac_sha256 === null)) {
      throw new Error("live global-config snapshot absent metadata is inconsistent")
    }
    if (!absent && (!/^\d+$/.test(entry.size) || !/^\d+$/.test(entry.mtime_ns) || !/^\d+$/.test(entry.ctime_ns) ||
      !Number.isInteger(entry.mode) || (entry.state === "file" ? !/^[a-f0-9]{64}$/.test(entry.content_hmac_sha256 ?? "") : entry.content_hmac_sha256 !== null))) {
      throw new Error("live global-config snapshot present metadata is malformed")
    }
  }
  const allowlist = [".", ...GLOBAL_CONFIG_FILES]
  if (![...scopes.values()].every((paths) => exactJson([...paths], allowlist))) throw new Error("live global-config snapshot scope allowlist differs")
  const version = evidence.version
  const compatibility = validateOpenCodeVersion(version?.parsed?.text ?? "")
  if (version?.passed !== true || version?.declared_engine_requirement !== OPENCODE_ENGINE_REQUIREMENT || !compatibility.compatible ||
    version?.exit_code !== 0 || version?.cleanup?.passed !== true) throw new Error("live OpenCode version evidence is incompatible")
  const server = evidence.server
  let rawIds: string[]
  try { JSON.parse(server?.raw_http_body ?? ""); rawIds = parseAlgToolIds(server.raw_http_body) } catch { throw new Error("live server raw tool body is not JSON") }
  const serverOutput = `${server?.stdout_tail ?? ""}\n${server?.stderr_tail ?? ""}`
  if (server?.raw_http_status !== 200 || !exactJson(rawIds, ALG_TOOL_IDS) || !exactJson(server?.parsed_alg_ids, ALG_TOOL_IDS) ||
    findSourceIdentityLine(server?.source_identity_log ?? "", "server", source) !== server?.source_identity_log ||
    !findServerStartupLine(serverOutput, false) || server?.cleanup?.passed !== true) {
    throw new Error("live server status/tools/source/cleanup semantics are invalid")
  }
  const tui = evidence.tui
  if (findTuiRegistrationLine(tui?.registration_log ?? "") !== tui?.registration_log ||
    findSourceIdentityLine(tui?.source_identity_log ?? "", "tui", source) !== tui?.source_identity_log || tui?.cleanup?.passed !== true) {
    throw new Error("live TUI registration/source/cleanup semantics are invalid")
  }
  return evidence
}

/** Boolean compatibility wrapper; callers needing diagnostics use validateRetainedLiveEvidence. */
export function retainedLiveEvidencePassed(value: unknown, root = PLUGIN_ROOT): boolean {
  try {
    validateRetainedLiveEvidence(value, root)
    return true
  } catch {
    return false
  }
}

function versionCommandEvidence(
  command: string,
  timeoutMs: number,
  captured: CapturedProcess | undefined,
  cleanup: ProcessCleanupEvidence,
  waitError?: unknown,
): VersionCommandEvidence {
  const observed = captured?.exit() ?? { observed: false, code: null, signal: null }
  const waitMessage = waitError === undefined ? undefined : boundedError(waitError)
  return {
    command: [command, "--version"],
    root_pid: captured?.child.pid ?? null,
    stdout: captured?.stdout() ?? "",
    stderr: captured?.stderr() ?? "",
    exit_observed: observed.observed,
    exit_code: observed.code,
    exit_signal: observed.signal,
    timeout_ms: timeoutMs,
    timed_out: waitMessage?.includes(`exceeded ${timeoutMs} ms`) ?? false,
    ...(waitMessage ? { wait_error: waitMessage } : {}),
    cleanup,
    passed: waitError === undefined && cleanup.passed,
  }
}

export async function runVersionCommand(
  command: string,
  cwd: string,
  options: VersionCommandOptions = {},
): Promise<VersionCommandEvidence> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? VERSION_COMMAND_TIMEOUT_MS)
  let captured: CapturedProcess
  try {
    captured = options.captured ?? spawnCaptured(command, ["--version"], cwd, options.environment)
  } catch (error) {
    const cleanup = failedCleanupEvidence(error)
    const evidence = versionCommandEvidence(command, timeoutMs, undefined, cleanup, error)
    throw new VersionCommandError(`version process spawn failed: ${boundedError(error)}`, evidence, { cause: error })
  }
  let waitError: unknown
  try {
    await waitForExit(captured, timeoutMs)
  } catch (error) {
    waitError = error
  }
  let cleanup: ProcessCleanupEvidence
  try {
    cleanup = await stopCapturedProcess(captured, options.cleanupOptions)
  } catch (error) {
    cleanup = failedCleanupEvidence(error, captured)
  }
  const evidence = versionCommandEvidence(command, timeoutMs, captured, cleanup, waitError)
  if (waitError !== undefined || !cleanup.passed) {
    const reasons = [
      waitError === undefined ? undefined : boundedError(waitError),
      !cleanup.passed ? `version process cleanup failed: ${cleanup.error ?? cleanup.termination_result}` : undefined,
    ].filter((reason): reason is string => Boolean(reason))
    throw new VersionCommandError(reasons.join("; "), evidence, { cause: waitError })
  }
  return evidence
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

export interface ToolReadinessEvidence {
  endpoint: string
  attempts: number
  last_http_status: number | null
  last_http_body: string
  parsed_alg_ids: string[]
  source_identity_log: string | null
  last_request_error?: string
}

export interface ToolReadinessOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  requestTimeoutMs?: number
  request?: (url: string, timeoutMs: number) => Promise<{ status: number; text(): Promise<string> }>
}

export class ToolReadinessError extends Error {
  readonly evidence: ToolReadinessEvidence

  constructor(message: string, evidence: ToolReadinessEvidence, options: ErrorOptions = {}) {
    super(message, options)
    this.name = "ToolReadinessError"
    this.evidence = evidence
  }
}

function exactAlgToolSet(ids: readonly string[]): boolean {
  return ids.length === ALG_TOOL_IDS.length && ALG_TOOL_IDS.every((id) => ids.includes(id))
}

export async function fetchToolIds(
  url: string,
  capturedProcess: CapturedProcess,
  identity: AlgSourceIdentity,
  options: ToolReadinessOptions = {},
): Promise<{ status: number; body: string; ids: string[]; sourceIdentityLog: string; attempts: number }> {
  const timeoutMs = Math.max(1, options.timeoutMs ?? SERVER_TIMEOUT_MS)
  const pollIntervalMs = Math.max(1, options.pollIntervalMs ?? 250)
  const requestTimeoutMs = Math.max(1, options.requestTimeoutMs ?? 2_000)
  const request = options.request ?? ((endpoint: string, requestLimitMs: number) =>
    fetch(endpoint, { signal: AbortSignal.timeout(requestLimitMs) }))
  const deadline = Date.now() + timeoutMs
  const evidence: ToolReadinessEvidence = {
    endpoint: url,
    attempts: 0,
    last_http_status: null,
    last_http_body: "",
    parsed_alg_ids: [],
    source_identity_log: null,
  }
  while (Date.now() < deadline) {
    if (capturedProcess.exit().observed) {
      throw new ToolReadinessError(
        `OpenCode server exited ${capturedProcess.exit().code} before readiness; ` +
        `stdout=${capturedProcess.stdout().slice(-2_000)}; stderr=${capturedProcess.stderr().slice(-2_000)}`,
        evidence,
      )
    }
    evidence.attempts++
    try {
      const remainingMs = Math.max(1, deadline - Date.now())
      const attemptTimeoutMs = Math.min(requestTimeoutMs, remainingMs)
      const response = await Promise.race([
        request(url, attemptTimeoutMs).then(async (value) => ({
          status: value.status,
          body: await value.text(),
        })),
        Bun.sleep(attemptTimeoutMs).then(() => {
          throw new Error(`tool endpoint request exceeded ${attemptTimeoutMs} ms`)
        }),
      ])
      const body = response.body
      if (Buffer.byteLength(body, "utf8") > OUTPUT_LIMIT) {
        throw new Error(`tool endpoint response exceeds ${OUTPUT_LIMIT} bytes`)
      }
      evidence.last_http_status = response.status
      evidence.last_http_body = body
      evidence.parsed_alg_ids = parseAlgToolIds(body)
      delete evidence.last_request_error
    } catch (error) {
      evidence.last_request_error = boundedError(error)
    }
    const combined = `${capturedProcess.stdout()}\n${capturedProcess.stderr()}`
    evidence.source_identity_log = findSourceIdentityLine(combined, "server", identity) ?? null
    if (evidence.last_http_status === 200 && exactAlgToolSet(evidence.parsed_alg_ids) && evidence.source_identity_log &&
      findServerStartupLine(combined, false)) {
      return {
        status: evidence.last_http_status,
        body: evidence.last_http_body,
        ids: evidence.parsed_alg_ids,
        sourceIdentityLog: evidence.source_identity_log,
        attempts: evidence.attempts,
      }
    }
    if (capturedProcess.exit().observed) {
      throw new ToolReadinessError(
        `OpenCode server exited ${capturedProcess.exit().code} before readiness; ` +
        `stdout=${capturedProcess.stdout().slice(-2_000)}; stderr=${capturedProcess.stderr().slice(-2_000)}`,
        evidence,
      )
    }
    const sleepMs = Math.min(pollIntervalMs, Math.max(0, deadline - Date.now()))
    if (sleepMs > 0) await Bun.sleep(sleepMs)
  }
  const readiness = evidence.source_identity_log ? "observed" : "missing"
  throw new ToolReadinessError(
    `OpenCode server readiness timeout after ${timeoutMs} ms: source_identity=${readiness}; ` +
    `last_status=${evidence.last_http_status ?? "none"}; observed_alg_ids=${evidence.parsed_alg_ids.join(",")}; ` +
    `last_request_error=${evidence.last_request_error ?? "none"}; ` +
    `stdout=${capturedProcess.stdout().slice(-2_000)}; stderr=${capturedProcess.stderr().slice(-2_000)}`,
    evidence,
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

export function findTuiRegistrationLine(output: string): string | undefined {
  return output.split(/\r?\n/).find((line) => {
    if (!line || line.length > TUI_REGISTRATION_LINE_LIMIT) return false
    if (/\bnot\b/i.test(line)) return false

    // Some log transports preserve structured JSON fields.
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const fields = parsed as Record<string, unknown>
        return fields.service === ALG_TUI_REGISTRATION_SERVICE &&
          fields.message === ALG_TUI_REGISTRATION_TOKEN
      }
    } catch {
      // Continue with the two exact bounded text grammars below.
    }

    // Direct service grammar used by simple line-oriented transports.
    const direct = new RegExp(
      `^(?:INFO\\s+)?service=${ALG_TUI_REGISTRATION_SERVICE}\\s+${ALG_TUI_REGISTRATION_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
    )
    if (direct.test(line)) return true

    // OpenCode's structured text logger renders a finite logfmt prefix and an
    // exact message field. Unknown fields/prose, a conflicting service, or any
    // suffix make the entire line ineligible.
    const message = `message=${JSON.stringify(ALG_TUI_REGISTRATION_TOKEN)}`
    if (!line.endsWith(message)) return false
    const prefix = line.slice(0, -message.length).trim()
    if (!prefix) return true
    const fields = prefix.split(/\s+/)
    let service: string | undefined
    for (const field of fields) {
      if (/^timestamp=\S+$/.test(field) || /^level=INFO$/i.test(field) || /^run=[A-Za-z0-9._:-]+$/.test(field)) {
        continue
      }
      const match = /^service=([A-Za-z0-9._-]+)$/.exec(field)
      if (match) {
        service = match[1]
        continue
      }
      return false
    }
    return service === undefined || service === ALG_TUI_REGISTRATION_SERVICE
  })
}

export function findSourceIdentityLine(
  output: string,
  entry: "server" | "tui",
  identity: AlgSourceIdentity,
): string | undefined {
  const expected = sourceIdentityMessage(entry, identity)
  return output.split(/\r?\n/).find((line) => {
    if (!line || line.length > TUI_REGISTRATION_LINE_LIMIT) return false
    try {
      const parsed = JSON.parse(line) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const fields = parsed as Record<string, unknown>
        return fields.service === ALG_TUI_REGISTRATION_SERVICE && fields.message === expected
      }
    } catch {
      // Continue with exact direct/structured text forms.
    }
    if (line === `INFO service=${ALG_TUI_REGISTRATION_SERVICE} ${expected}` ||
      line === `service=${ALG_TUI_REGISTRATION_SERVICE} ${expected}`) return true
    const message = `message=${JSON.stringify(expected)}`
    if (!line.endsWith(message)) return false
    const prefix = line.slice(0, -message.length).trim()
    if (!prefix) return true
    const fields = prefix.split(/\s+/)
    let service: string | undefined
    for (const field of fields) {
      if (/^timestamp=\S+$/.test(field) || /^level=INFO$/i.test(field) || /^run=[A-Za-z0-9._:-]+$/.test(field)) {
        continue
      }
      const match = /^service=([A-Za-z0-9._-]+)$/.exec(field)
      if (match) {
        service = match[1]
        continue
      }
      return false
    }
    return service === undefined || service === ALG_TUI_REGISTRATION_SERVICE
  })
}

/** Exact startup proof used to bind live verification to disabled skill evolution and all public IDs. */
export function findServerStartupLine(output: string, skillEvolutionEnabled: boolean): string | undefined {
  // Startup proof is intentionally restricted to the real disabled-by-default
  // OpenCode 1.18.x logfmt record. An enabled expectation must never turn an
  // enabled feature record into acceptable release evidence.
  if (skillEvolutionEnabled) return undefined
  const expected = algServerStartupMessage(false)
  const quotedMessage = JSON.stringify(expected).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const quotedJsonString = '"(?:[^"\\\\\u0000-\u001f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))+"'
  const structured = new RegExp(
    `^timestamp=\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z level=INFO ` +
    `run=[A-Za-z0-9._:-]+ message=${quotedMessage} directory=(${quotedJsonString}) ` +
    `skill_evolution_enabled=false$`,
  )
  return output.split(/\r?\n/).find((line) => {
    if (!line || line.length > TUI_REGISTRATION_LINE_LIMIT) return false
    const match = structured.exec(line)
    if (!match) return false
    try {
      const directory = JSON.parse(match[1]!)
      return typeof directory === "string" && directory.length > 0 && directory === directory.trim()
    } catch {
      return false
    }
  })
}

export function assertLoadedCheckoutEvidence(
  serverOutput: string,
  tuiOutput: string,
  identity: AlgSourceIdentity,
): { server: string; tui: string } {
  const server = findSourceIdentityLine(serverOutput, "server", identity)
  const tui = findSourceIdentityLine(tuiOutput, "tui", identity)
  if (!server || !tui) {
    throw new Error("server and TUI did not both prove the reviewed checkout source identity")
  }
  return { server, tui }
}

export async function waitForTuiLog(process: CapturedProcess, timeoutMs = TUI_TIMEOUT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const combined = `${process.stdout()}\n${process.stderr()}`
    const line = findTuiRegistrationLine(combined)
    if (line) return line
    if (process.exit().observed) throw new Error(`TUI exited ${process.exit().code} before registration evidence`)
    await Bun.sleep(100)
  }
  throw new Error(`TUI registration log not observed within ${timeoutMs} ms`)
}

async function waitForSourceIdentityLog(
  process: CapturedProcess,
  entry: "server" | "tui",
  identity: AlgSourceIdentity,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const combined = `${process.stdout()}\n${process.stderr()}`
    const line = findSourceIdentityLine(combined, entry, identity)
    if (line) return line
    if (process.exit().observed) throw new Error(`${entry} exited ${process.exit().code} before source identity evidence`)
    await Bun.sleep(100)
  }
  throw new Error(`${entry} source identity log not observed within ${timeoutMs} ms`)
}

function outputArgument(args: string[]): string {
  const index = args.indexOf("--output")
  const value = index >= 0 ? args[index + 1] : undefined
  if (!value || args.length !== 2 || !isAbsolute(value)) {
    throw new Error("usage: bun run scripts/live-verify.ts --output <absolute-evidence.json>")
  }
  return resolve(value)
}

export async function runLiveVerification(outputPath: string): Promise<{ path: string; sha256: string; bytes: number; identity: EvidenceFileIdentity }> {
  const pluginConfiguration = verificationPluginConfiguration()
  assertVerificationPluginConfiguration(pluginConfiguration)
  outputPath = prepareLiveEvidenceDestination(outputPath).path
  const outputName = outputPath.split(/[\\/]/).at(-1) ?? ""
  const outputMatch = LIVE_EVIDENCE_NAME.exec(outputName)
  if (!outputMatch || outputMatch[1] !== pluginConfiguration.source.digest.slice(0, 16)) {
    throw new Error("live verification output filename must contain the current source prefix and a random UUID")
  }
  const requestedExecutable = process.env.OPENCODE_BIN?.trim() || "opencode"
  const realUserConfigRoots = realUserGlobalConfigRoots({ ...process.env })
  const globalConfigHmacKey = randomBytes(32)
  const globalConfigBefore = snapshotGlobalOpenCodeConfig(realUserConfigRoots, globalConfigHmacKey)
  const temporaryRoot = mkdtempSync(join(tmpdir(), "alg-live-verify-"))
  const project = join(temporaryRoot, "project")
  const configHome = join(temporaryRoot, "xdg-config")
  const configDirectory = join(configHome, "opencode")
  const isolatedHome = join(temporaryRoot, "home")
  const serverConfigPath = join(temporaryRoot, "opencode.json")
  const tuiConfigPath = join(configDirectory, "tui.json")
  for (const directory of [
    project,
    configDirectory,
    isolatedHome,
    join(isolatedHome, "AppData", "Roaming"),
    join(isolatedHome, "AppData", "Local"),
  ]) mkdirSync(directory, { recursive: true })
  writeFileSync(serverConfigPath, `${JSON.stringify(pluginConfiguration.server_config, null, 2)}\n`, "utf8")
  writeFileSync(tuiConfigPath, `${JSON.stringify(pluginConfiguration.tui_config, null, 2)}\n`, "utf8")
  const processEnvironment: NodeJS.ProcessEnv = {
    XDG_CONFIG_HOME: configHome,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: join(isolatedHome, "AppData", "Roaming"),
    LOCALAPPDATA: join(isolatedHome, "AppData", "Local"),
    OPENCODE_CONFIG: serverConfigPath,
    [ALG_LIVE_SOURCE_DIGEST_ENV]: pluginConfiguration.source.digest,
  }
  let executable = requestedExecutable
  let server: CapturedProcess | undefined
  let tui: CapturedProcess | undefined
  let serverCleanup: ProcessCleanupEvidence | undefined
  let tuiCleanup: ProcessCleanupEvidence | undefined
  let verificationCompleted = false
  let globalConfigUnchanged = false
  const evidence: Record<string, unknown> = {
    schema_version: 2,
    kind: "opencode-alg-live-verification",
    generated_at: new Date().toISOString(),
    no_model_calls: true,
    plugin_source: {
      package_version: pluginConfiguration.package_version,
      canonical_root: pluginConfiguration.source.root,
      package_spec: pluginConfiguration.source.spec,
      sha256: pluginConfiguration.source.digest,
      runtime_manifest: {
        digest: pluginConfiguration.source.digest,
        entries: pluginConfiguration.source.manifest,
        file_count: pluginConfiguration.source.file_count,
        total_bytes: pluginConfiguration.source.total_bytes,
        bounds: pluginConfiguration.source.bounds,
      },
      entry_points: pluginConfiguration.entry_points,
      registrations: {
        server: pluginConfiguration.server_config.plugin,
        tui: pluginConfiguration.tui_config.plugin,
      },
    },
    isolation: {
      project_config_disabled: true,
      default_plugins_disabled: true,
      external_skills_disabled: true,
      isolated_xdg_config: true,
      explicit_server_config: serverConfigPath,
      isolated_tui_config: tuiConfigPath,
      parent_global_plugin_state_used: false,
      user_global_config_modified: null,
      global_config_snapshots: {
        algorithm: "ephemeral-key-hmac-sha256-plus-file-metadata",
        allowlisted_relative_paths: [".", ...GLOBAL_CONFIG_FILES],
        before: globalConfigBefore,
        after: null,
        unchanged: false,
      },
    },
    declared_engine_requirement: OPENCODE_ENGINE_REQUIREMENT,
    required_alg_tool_ids: ALG_TOOL_IDS,
    output_path: outputPath,
    temporary_environment_removed: false,
    passed: false,
    reason: "live verification did not complete",
  }
  let failure: unknown
  let publication: { path: string; sha256: string; bytes: number; identity: EvidenceFileIdentity } | undefined
  try {
    try {
      executable = resolveOpenCodeExecutable(requestedExecutable)
    } catch (error) {
      const cleanup = failedCleanupEvidence(error)
      const version = versionCommandEvidence(
        requestedExecutable,
        VERSION_COMMAND_TIMEOUT_MS,
        undefined,
        cleanup,
        error,
      )
      evidence.version = {
        executable_path: requestedExecutable,
        declared_engine_requirement: OPENCODE_ENGINE_REQUIREMENT,
        ...version,
        parsed: null,
        passed: false,
        reason: `version executable resolution failed: ${boundedError(error)}`,
      }
      throw error
    }
    let version: VersionCommandEvidence
    try {
      version = await runVersionCommand(executable, project, {
        timeoutMs: VERSION_COMMAND_TIMEOUT_MS,
        environment: processEnvironment,
      })
    } catch (error) {
      if (error instanceof VersionCommandError) {
        const compatibility = validateOpenCodeVersion(versionLine(error.evidence.stdout))
        evidence.version = {
          executable_path: executable,
          declared_engine_requirement: OPENCODE_ENGINE_REQUIREMENT,
          ...error.evidence,
          parsed: compatibility.parsed,
          passed: false,
          reason: error.message,
        }
      } else {
        const cleanup = failedCleanupEvidence(error)
        evidence.version = {
          executable_path: executable,
          declared_engine_requirement: OPENCODE_ENGINE_REQUIREMENT,
          ...versionCommandEvidence(executable, VERSION_COMMAND_TIMEOUT_MS, undefined, cleanup, error),
          parsed: null,
          passed: false,
          reason: boundedError(error),
        }
      }
      throw error
    }
    const compatibility = validateOpenCodeVersion(versionLine(version.stdout))
    const versionPassed = version.exit_code === 0 && compatibility.compatible && version.passed
    const versionReason = version.exit_code === 0
      ? compatibility.reason
      : `OpenCode version command exited ${version.exit_code}`
    evidence.version = {
      executable_path: executable,
      declared_engine_requirement: OPENCODE_ENGINE_REQUIREMENT,
      ...version,
      parsed: compatibility.parsed,
      passed: versionPassed,
      reason: versionReason,
    }
    if (!versionPassed) throw new Error(versionReason)

    const port = await unusedPort()
    const serverArgs = ["serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "INFO"]
    server = spawnCaptured(executable, serverArgs, project, processEnvironment)
    const endpoint = `http://127.0.0.1:${port}/experimental/tool/ids`
    let http: Awaited<ReturnType<typeof fetchToolIds>>
    try {
      http = await fetchToolIds(endpoint, server, pluginConfiguration.source)
    } catch (error) {
      if (error instanceof ToolReadinessError) {
        evidence.server = {
          command: [executable, ...serverArgs],
          root_pid: server.child.pid ?? null,
          endpoint,
          readiness_attempts: error.evidence.attempts,
          raw_http_status: error.evidence.last_http_status,
          raw_http_body: error.evidence.last_http_body,
          parsed_alg_ids: error.evidence.parsed_alg_ids,
          source_identity_log: error.evidence.source_identity_log,
          ...(error.evidence.last_request_error
            ? { last_request_error: error.evidence.last_request_error }
            : {}),
        }
      }
      throw error
    }
    evidence.server = {
      command: [executable, ...serverArgs],
      root_pid: server.child.pid ?? null,
      endpoint,
      readiness_attempts: http.attempts,
      raw_http_status: http.status,
      raw_http_body: http.body,
      parsed_alg_ids: http.ids,
      source_identity_log: http.sourceIdentityLog,
    }
    if (http.status !== 200) throw new Error(`tool endpoint returned HTTP ${http.status}`)
    const missing = ALG_TOOL_IDS.filter((id) => !http.ids.includes(id))
    if (missing.length || http.ids.length !== ALG_TOOL_IDS.length) {
      throw new Error(`ALG tool evidence mismatch; missing=${missing.join(",")}, observed=${http.ids.join(",")}`)
    }
    serverCleanup = await stopCapturedProcessSafely(server)
    evidence.server = {
      ...(evidence.server as object),
      stdout_tail: server.stdout().slice(-32_768),
      stderr_tail: server.stderr().slice(-32_768),
      cleanup: serverCleanup,
    }
    if (!serverCleanup.passed) {
      throw new Error(`server cleanup was not confirmed: ${serverCleanup.error ?? serverCleanup.termination_result}`)
    }

    const tuiArgs = [project, "--print-logs", "--log-level", "INFO"]
    tui = spawnCaptured(executable, tuiArgs, project, processEnvironment)
    const registrationLog = await waitForTuiLog(tui)
    const tuiSourceLog = await waitForSourceIdentityLog(
      tui,
      "tui",
      pluginConfiguration.source,
      TUI_TIMEOUT_MS,
    )
    assertLoadedCheckoutEvidence(
      `${server.stdout()}\n${server.stderr()}`,
      `${tui.stdout()}\n${tui.stderr()}`,
      pluginConfiguration.source,
    )
    tuiCleanup = await stopCapturedProcessSafely(tui)
    evidence.tui = {
      command: [executable, ...tuiArgs],
      root_pid: tui.child.pid ?? null,
      registration_log: registrationLog,
      source_identity_log: tuiSourceLog,
      stdout_tail: tui.stdout().slice(-32_768),
      stderr_tail: tui.stderr().slice(-32_768),
      cleanup: tuiCleanup,
    }
    if (!tuiCleanup.passed) {
      throw new Error(`TUI cleanup was not confirmed: ${tuiCleanup.error ?? tuiCleanup.termination_result}`)
    }
    verificationCompleted = true
    evidence.reason = `${compatibility.reason}; ALG tools and exact TUI registration verified; server and TUI root cleanup confirmed`
  } catch (error) {
    failure = error
    const reason = boundedError(error)
    evidence.reason = reason
    evidence.failure = reason
  } finally {
    if (tui && !tuiCleanup) tuiCleanup = await stopCapturedProcessSafely(tui)
    if (server && !serverCleanup) serverCleanup = await stopCapturedProcessSafely(server)
    if (server) {
      evidence.server = {
        ...((evidence.server as object | undefined) ?? {}),
        root_pid: server.child.pid ?? null,
        stdout_tail: server.stdout().slice(-32_768),
        stderr_tail: server.stderr().slice(-32_768),
        ...(serverCleanup ? { cleanup: serverCleanup } : {}),
      }
    }
    if (tui) {
      evidence.tui = {
        ...((evidence.tui as object | undefined) ?? {}),
        root_pid: tui.child.pid ?? null,
        stdout_tail: tui.stdout().slice(-32_768),
        stderr_tail: tui.stderr().slice(-32_768),
        ...(tuiCleanup ? { cleanup: tuiCleanup } : {}),
      }
    }
    const cleanupFailures = [
      serverCleanup && !serverCleanup.passed ? `server: ${serverCleanup.error ?? serverCleanup.termination_result}` : undefined,
      tuiCleanup && !tuiCleanup.passed ? `TUI: ${tuiCleanup.error ?? tuiCleanup.termination_result}` : undefined,
    ].filter((value): value is string => Boolean(value))
    if (cleanupFailures.length) {
      evidence.cleanup_failures = cleanupFailures
      if (!failure) failure = new Error(`live process cleanup failed: ${cleanupFailures.join("; ")}`)
      evidence.failure = boundedError(failure)
      evidence.reason = boundedError(failure)
    }
    const temporaryRemoval = await removeTemporaryEnvironment(temporaryRoot)
    evidence.temporary_environment_removed = temporaryRemoval.removed
    if (!temporaryRemoval.removed) {
      const reason = `temporary live project cleanup failed: ${temporaryRemoval.error ?? "removal was not confirmed"}`
      if (!failure) failure = new Error(reason)
      evidence.failure = reason
      evidence.reason = reason
    }
    try {
      const globalConfigAfter = snapshotGlobalOpenCodeConfig(realUserConfigRoots, globalConfigHmacKey)
      globalConfigUnchanged = globalConfigBefore.sha256 === globalConfigAfter.sha256 &&
        JSON.stringify(globalConfigBefore.entries) === JSON.stringify(globalConfigAfter.entries)
      evidence.isolation = {
        ...((evidence.isolation as object | undefined) ?? {}),
        user_global_config_modified: !globalConfigUnchanged,
        global_config_snapshots: {
          algorithm: "ephemeral-key-hmac-sha256-plus-file-metadata",
          allowlisted_relative_paths: [".", ...GLOBAL_CONFIG_FILES],
          before: globalConfigBefore,
          after: globalConfigAfter,
          unchanged: globalConfigUnchanged,
        },
      }
      if (!globalConfigUnchanged) {
        const reason = "real-user OpenCode config metadata changed during live verification"
        failure = new Error(reason)
        evidence.failure = reason
        evidence.reason = reason
      }
    } catch (error) {
      const reason = `real-user OpenCode config post-cleanup snapshot failed: ${boundedError(error)}`
      failure = new Error(reason)
      evidence.failure = reason
      evidence.reason = reason
      evidence.isolation = {
        ...((evidence.isolation as object | undefined) ?? {}),
        user_global_config_modified: true,
      }
    }
    evidence.passed = liveVerificationPassed({
      verificationCompleted,
      failure,
      serverCleanup,
      tuiCleanup,
      temporaryEnvironmentRemoved: temporaryRemoval.removed,
      userGlobalConfigUnchanged: globalConfigUnchanged,
    })
    if (evidence.passed) {
      evidence.reason = `${evidence.reason}; temporary environment removal and real-user global-config preservation confirmed`
    }
    if (!evidence.passed && !failure) {
      failure = new Error("live verification did not produce complete cleanup proof")
      evidence.failure = boundedError(failure)
      evidence.reason = boundedError(failure)
    }
    let serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`
    if (Buffer.byteLength(serializedEvidence, "utf8") > LIVE_EVIDENCE_LIMIT_BYTES) {
      failure ??= new Error(`live evidence exceeds ${LIVE_EVIDENCE_LIMIT_BYTES} bytes`)
      evidence.passed = false
      evidence.failure = boundedError(failure)
      evidence.reason = boundedError(failure)
      for (const section of ["server", "tui"] as const) {
        const value = evidence[section]
        if (!value || typeof value !== "object") continue
        evidence[section] = {
          ...(value as Record<string, unknown>),
          stdout_tail: "[omitted: evidence size limit]",
          stderr_tail: "[omitted: evidence size limit]",
          ...(section === "server" ? { raw_http_body: "[omitted: evidence size limit]" } : {}),
        }
      }
      serializedEvidence = `${JSON.stringify(evidence, null, 2)}\n`
    }
    if (Buffer.byteLength(serializedEvidence, "utf8") > LIVE_EVIDENCE_LIMIT_BYTES) {
      throw new Error(`bounded live evidence could not fit within ${LIVE_EVIDENCE_LIMIT_BYTES} bytes`)
    }
    publication = persistImmutableLiveEvidence(outputPath, Buffer.from(serializedEvidence, "utf8"))
  }
  if (failure) throw failure
  if (!publication) throw new Error("live verification did not complete evidence publication")
  return publication
}

if (import.meta.main) await runLiveVerification(outputArgument(process.argv.slice(2)))

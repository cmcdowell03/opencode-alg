import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { computeAlgSourceIdentity } from "../src/source-identity.ts"
import { cleanupWindowsShellHelpers, windowsShellHelperArtifactSnapshot } from "../src/shell.ts"
import { verifyRetainedLiveEvidenceArtifact, type EvidenceFileIdentity } from "./live-verify.ts"
import { resolveNpmInvocation } from "./npm-invocation.ts"
import { verifyExcelManifest } from "./verify-excel-manifest.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MAX_EVIDENCE_BYTES = 512 * 1024
const MAX_CAPTURE_BYTES = 96 * 1024
const MAX_RETAINED_COMMAND_BYTES = 96 * 1024
const MAX_RETAINED_OUTPUT_TOTAL_BYTES = 320 * 1024
const TAIL_BYTES = 2_048
const Sha = z.string().regex(/^[a-f0-9]{64}$/)
const FileIdentitySchema = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict()
export const RELEASE_COMMAND_IDS = [
  "typecheck", "bun_test", "manager_tests", "smoke", "live_verify", "excel_manifest", "python_tests",
  "uv_sync", "excel_wrapper_check", "excel_wrapper_eof", "npm_pack",
] as const
const CommandIdSchema = z.enum(RELEASE_COMMAND_IDS)

const CommandEvidenceSchema = z.object({
  id: CommandIdSchema,
  argv: z.array(z.string().max(8_192)).min(1).max(32),
  cwd: z.string().max(4_096),
  exit_code: z.number().int(),
  stdout_bytes: z.number().int().nonnegative(),
  stdout_sha256: Sha,
  stdout: z.string().max(MAX_RETAINED_COMMAND_BYTES),
  stderr_bytes: z.number().int().nonnegative(),
  stderr_sha256: Sha,
  stderr: z.string().max(MAX_RETAINED_COMMAND_BYTES),
}).strict()

const PackedFileSchema = z.object({ path: z.string().max(512), size: z.number().int().nonnegative(), mode: z.number().int() }).strict()

export const ReleaseEvidenceSchema = z.object({
  schema_version: z.literal(5),
  kind: z.literal("opencode-alg-release-gate"),
  generated_at: z.iso.datetime({ offset: true }),
  package_version: z.literal("0.3.0"),
  source: z.object({ sha256: Sha, files: z.number().int().positive(), bytes: z.number().int().positive() }).strict(),
  release_inputs: z.object({ sha256: Sha, files: z.number().int().positive(), bytes: z.number().int().positive() }).strict(),
  commands: z.array(CommandEvidenceSchema).length(RELEASE_COMMAND_IDS.length),
  totals: z.object({ bun_pass: z.number().int().nonnegative(), bun_skip: z.number().int().nonnegative(), bun_fail: z.number().int().nonnegative(), bun_total: z.number().int().nonnegative(), bun_assertions: z.number().int().nonnegative(), bun_files: z.number().int().positive(), manager_pass: z.number().int().nonnegative(), manager_skip: z.number().int().nonnegative(), manager_fail: z.number().int().nonnegative(), manager_total: z.number().int().nonnegative(), manager_assertions: z.number().int().nonnegative(), manager_files: z.number().int().positive(), python_run: z.number().int().nonnegative(), python_skipped: z.number().int().nonnegative(), python_ok: z.literal(true) }).strict(),
  excel: z.object({ manifest_sha256: Sha, lock_sha256: Sha, version: z.literal("0.1.8"), tool_count: z.literal(25), eof_stdout_bytes: z.literal(0) }).strict(),
  package: z.object({
    entries: z.number().int().positive(), packed_bytes: z.number().int().positive(), unpacked_bytes: z.number().int().positive(),
    files: z.array(PackedFileSchema).min(1).max(128), inventory_sha256: Sha,
    capability_files: z.array(z.string()).length(6), lock_bytes: z.number().int().positive(),
    tgz_created: z.literal(false),
  }).strict(),
  live: z.object({ passed: z.literal(true), evidence_path: z.string().max(4_096), evidence_sha256: Sha, evidence_bytes: z.number().int().positive(), evidence_identity: FileIdentitySchema, source_sha256: Sha, user_global_config_modified: z.literal(false), global_config_snapshot_sha256: Sha, temporary_environment_removed: z.literal(true) }).strict(),
  cleanup: z.object({
    temporary_excel_environment_removed: z.literal(true), repository_artifacts_absent: z.literal(true),
    helper_owned_before: z.number().int().nonnegative(), helper_owned_after: z.number().int().nonnegative(), helper_net_additions: z.literal(0),
  }).strict(),
  passed: z.literal(true),
}).strict()

export type ReleaseEvidence = z.infer<typeof ReleaseEvidenceSchema>

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex")
}

export function redactReleaseText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/:\/\/([^/\s:@]+):([^@/\s]+)@/g, "://$1:[redacted]@")
    .replace(/(authorization|token|api[-_]?key|password|cookie|secret)\s*(?::|=)\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "?")
}

export function boundedReleaseTail(value: string, maxBytes = TAIL_BYTES): string {
  const clean = redactReleaseText(value)
  const bytes = Buffer.from(clean, "utf8")
  if (bytes.byteLength <= maxBytes) return clean
  let tail = bytes.subarray(bytes.byteLength - maxBytes + 3).toString("utf8")
  if (tail.startsWith("�")) tail = tail.slice(1)
  return `...${tail}`
}

export function repositoryReleaseArtifacts(root: string): string[] {
  const found: string[] = []
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue
      const path = join(directory, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__" || entry.name === ".venv" || entry.name === "venv") found.push(relative(root, path))
        else visit(path)
      } else if (/\.(?:py[co]|tgz)$/i.test(entry.name)) found.push(relative(root, path))
    }
  }
  visit(root)
  return found.sort()
}

const REVIEWED_PACKAGE_SUPPORT_PATHS = [
  "CHANGELOG.md", "DESIGN.md", "README.md",
  "docs/operations.md", "docs/release-verification.md", "docs/upgrades.md",
  "scripts/alg.ps1", "scripts/alg.sh", "scripts/check-live.ts", "scripts/install.ps1", "scripts/install.sh",
  "scripts/installer-core.ts", "scripts/live-verify.ts", "scripts/manager-cli.ts", "scripts/manager-core.ts",
  "scripts/manager-schema.ts", "scripts/npm-invocation.ts", "scripts/release-gate.ts", "scripts/smoke.ts",
  "scripts/verify-excel-manifest.ts",
] as const

const RELEASE_CONTROL_PATHS = [
  ".gitattributes", ".gitignore", ".npmignore", "bun.lock", "package-lock.json", "tsconfig.json",
] as const

export function expectedPackedPaths(root = ROOT): string[] {
  return [...new Set([
    ...computeAlgSourceIdentity(root).manifest.map((entry) => entry.path),
    ...REVIEWED_PACKAGE_SUPPORT_PATHS,
  ])].sort()
}

export interface ReleaseInputIdentity {
  sha256: string
  files: number
  bytes: number
}

function frameReleaseInput(hash: ReturnType<typeof createHash>, fields: readonly (string | Uint8Array)[]): void {
  for (const field of fields) {
    const bytes = typeof field === "string" ? Buffer.from(field, "utf8") : Buffer.from(field)
    const length = Buffer.alloc(8)
    length.writeBigUInt64BE(BigInt(bytes.byteLength))
    hash.update(length).update(bytes)
  }
}

/** Complete bounded local identity for reviewed package, test, and release-control inputs. */
export function computeReleaseInputIdentity(
  root = ROOT,
  packedPaths: readonly string[] = expectedPackedPaths(root),
  controlPaths: readonly string[] = RELEASE_CONTROL_PATHS,
): ReleaseInputIdentity {
  const canonicalRoot = realpathSync.native(resolve(root))
  const testPaths: string[] = []
  const visitTests = (directory: string, prefix: string, depth: number) => {
    if (depth > 12) throw new Error("Release test inputs exceed traversal depth")
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name || entry.name === "." || entry.name === ".." || /[\\/\0]/.test(entry.name)) throw new Error("Release test inputs contain an unsafe path")
      const path = join(directory, entry.name)
      const relativePath = `${prefix}${entry.name}`
      const stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error(`Release test input is a symlink: tests/${relativePath}`)
      if (stat.isDirectory()) {
        if (entry.name === "__pycache__" || !sameResolvedPath(realpathSync.native(path), path)) throw new Error(`Release test input directory is unsafe: tests/${relativePath}`)
        visitTests(path, `${relativePath}/`, depth + 1)
      } else if (stat.isFile() && /\.(?:ts|py|json|jsonc|md|txt|snap)$/i.test(entry.name)) {
        testPaths.push(`tests/${relativePath.replaceAll("\\", "/")}`)
      } else throw new Error(`Release test input type/name is not allowlisted: tests/${relativePath}`)
    }
  }
  const testsRoot = join(canonicalRoot, "tests")
  if (!existsSync(testsRoot) || !lstatSync(testsRoot).isDirectory() || lstatSync(testsRoot).isSymbolicLink()) throw new Error("Release tests root is missing or unsafe")
  visitTests(testsRoot, "", 1)
  const paths = [...new Set([...packedPaths, ...controlPaths, ...testPaths])].sort()
  if (paths.length < packedPaths.length || paths.length > 512) throw new Error("Release input file count is outside bounds")
  const hash = createHash("sha256")
  frameReleaseInput(hash, ["opencode-alg-release-inputs-v1"])
  let totalBytes = 0
  for (const relativePath of paths) {
    if (!relativePath || relativePath.includes("\\") || relativePath.includes("\0") || relativePath.startsWith("/") ||
      relativePath.split("/").some((part) => part === "" || part === "." || part === "..")) throw new Error(`Release input path is unsafe: ${relativePath}`)
    const path = join(canonicalRoot, ...relativePath.split("/"))
    if (!existsSync(path)) throw new Error(`Release input is missing: ${relativePath}`)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || !sameResolvedPath(realpathSync.native(path), path)) throw new Error(`Release input is redirected or not regular: ${relativePath}`)
    if (stat.size > 2 * 1024 * 1024 || totalBytes + stat.size > 16 * 1024 * 1024) throw new Error(`Release input exceeds byte bounds: ${relativePath}`)
    const descriptor = openSync(path, constants.O_RDONLY | (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0))
    try {
      const opened = fstatSync(descriptor)
      const content = readFileSync(descriptor)
      const after = fstatSync(descriptor)
      if (!opened.isFile() || content.byteLength !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        throw new Error(`Release input changed while hashing: ${relativePath}`)
      }
      frameReleaseInput(hash, [relativePath, "regular", String(opened.mode & 0o777), String(content.byteLength), content])
      totalBytes += content.byteLength
    } finally {
      closeSync(descriptor)
    }
  }
  return { sha256: hash.digest("hex"), files: paths.length, bytes: totalBytes }
}

export function validatePackedInventory(
  files: Array<{ path: string; mode: number }>,
  expected = expectedPackedPaths(),
): { paths: string[]; sha256: string } {
  const paths = files.map((file) => file.path)
  if (new Set(paths).size !== paths.length) throw new Error("npm pack inventory contains duplicate paths")
  for (const path of paths) {
    if (!path || path.includes("\\") || path.includes("\0") || path.startsWith("/") || path.split("/").some((part) => part === "" || part === "." || part === "..")) {
      throw new Error(`npm pack inventory contains unsafe path: ${path}`)
    }
  }
  const sorted = [...paths].sort()
  if (JSON.stringify(sorted) !== JSON.stringify(expected)) throw new Error("npm pack inventory differs from the complete reviewed allowlist")
  if (files.some((file) => file.mode !== 420)) throw new Error("npm pack key file modes must all be 0644")
  return { paths: sorted, sha256: sha256(Buffer.from(`${sorted.join("\n")}\n`, "utf8")) }
}

function sameResolvedPath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function exactJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function exactArgs(command: z.infer<typeof CommandEvidenceSchema>, expected: string[], label: string): void {
  if (JSON.stringify(command.argv.slice(1)) !== JSON.stringify(expected)) {
    throw new Error(`Release evidence ${label} command arguments are not exact`)
  }
}

const EXCEL_TOOLS = [
  "apply_formula", "copy_range", "copy_worksheet", "create_chart", "create_pivot_table", "create_table",
  "create_workbook", "create_worksheet", "delete_range", "delete_sheet_columns", "delete_sheet_rows",
  "delete_worksheet", "format_range", "get_data_validation_info", "get_merged_cells", "get_workbook_metadata",
  "insert_columns", "insert_rows", "merge_cells", "read_data_from_excel", "rename_worksheet", "unmerge_cells",
  "validate_excel_range", "validate_formula_syntax", "write_data_to_excel",
] as const

function retainedCommandBytes(command: z.infer<typeof CommandEvidenceSchema>): { stdout: Buffer; stderr: Buffer } {
  const stdout = Buffer.from(command.stdout, "utf8")
  const stderr = Buffer.from(command.stderr, "utf8")
  if (stdout.byteLength !== command.stdout_bytes || sha256(stdout) !== command.stdout_sha256 ||
    stderr.byteLength !== command.stderr_bytes || sha256(stderr) !== command.stderr_sha256) {
    throw new Error(`Release evidence ${command.id} retained output size/hash differs`)
  }
  if (stdout.byteLength > MAX_RETAINED_COMMAND_BYTES || stderr.byteLength > MAX_RETAINED_COMMAND_BYTES) {
    throw new Error(`Release evidence ${command.id} retained output exceeds bounds`)
  }
  return { stdout, stderr }
}

function combinedOutput(command: z.infer<typeof CommandEvidenceSchema>): string {
  return `${command.stdout}\n${command.stderr}`
}

function parsedBunTotals(command: z.infer<typeof CommandEvidenceSchema>) {
  const output = combinedOutput(command)
  const value = (label: string, pattern: RegExp, optional = false): number => {
    const matches = [...output.matchAll(pattern)]
    if (optional && matches.length === 0) return 0
    if (matches.length !== 1) throw new Error(`Retained Bun output lacks one exact ${label} total`)
    const parsed = Number(matches[0]![1])
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Retained Bun output has an invalid ${label} total`)
    return parsed
  }
  const bunPass = value("pass", /^[ \t]*(\d+)[ \t]+pass[ \t]*\r?$/gm)
  const bunSkip = value("skip", /^[ \t]*(\d+)[ \t]+skip[ \t]*\r?$/gm, true)
  const bunFail = value("fail", /^[ \t]*(\d+)[ \t]+fail[ \t]*\r?$/gm)
  const bunAssertions = value("assertion", /^[ \t]*(\d+)[ \t]+expect\(\)[ \t]+calls[ \t]*\r?$/gm)
  const ran = [...output.matchAll(/^[ \t]*Ran[ \t]+(\d+)[ \t]+tests?[ \t]+across[ \t]+(\d+)[ \t]+files?\b[^\r\n]*\r?$/gm)]
  if (ran.length !== 1) throw new Error("Retained Bun output lacks one exact Ran tests/files total")
  const bunTotal = Number(ran[0]![1])
  const bunFiles = Number(ran[0]![2])
  if (!Number.isSafeInteger(bunTotal) || bunTotal < 0 || !Number.isSafeInteger(bunFiles) || bunFiles < 1) {
    throw new Error("Retained Bun output has invalid Ran tests/files totals")
  }
  if (bunTotal !== bunPass + bunSkip + bunFail) throw new Error("Retained Bun output total does not equal pass + skip + fail")
  return { bun_pass: bunPass, bun_skip: bunSkip, bun_fail: bunFail, bun_total: bunTotal, bun_assertions: bunAssertions, bun_files: bunFiles }
}

function parsedPythonTotals(command: z.infer<typeof CommandEvidenceSchema>) {
  const output = combinedOutput(command)
  const run = output.match(/Ran (\d+) tests? /)
  const skipped = output.match(/OK \(skipped=(\d+)\)/)
  const ok = /(?:^|\r?\n)OK(?: \(skipped=\d+\))?(?:\r?\n|$)/.test(output)
  if (!run || !ok) throw new Error("Retained Python output lacks Ran/OK totals")
  return { python_run: Number(run[1]), python_skipped: Number(skipped?.[1] ?? 0), python_ok: true as const }
}

function assertRegularExecutable(path: string, family: RegExp, label: string): void {
  if (!isAbsolute(path) || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() ||
    !sameResolvedPath(realpathSync.native(path), path) || !family.test(basename(path))) throw new Error(`Release evidence ${label} executable identity is invalid`)
}

/** Strict shape plus cross-field/current-checkout semantics for retained evidence. */
export function validateReleaseEvidenceSemantics(value: unknown, root = ROOT): ReleaseEvidence {
  const evidence = ReleaseEvidenceSchema.parse(value)
  const canonicalRoot = realpathSync.native(resolve(root))
  const packageJson = JSON.parse(readFileSync(join(canonicalRoot, "package.json"), "utf8")) as { name?: unknown; version?: unknown }
  if (packageJson.name !== "opencode-alg" || packageJson.version !== evidence.package_version) {
    throw new Error("Release evidence package version differs from the current package")
  }
  const source = computeAlgSourceIdentity(canonicalRoot)
  if (evidence.source.sha256 !== source.digest || evidence.source.files !== source.file_count || evidence.source.bytes !== source.total_bytes) {
    throw new Error("Release evidence source identity differs from the current checkout")
  }
  const releaseInputs = computeReleaseInputIdentity(canonicalRoot)
  if (!exactJson(evidence.release_inputs, releaseInputs)) throw new Error("Release evidence full input identity differs from the current checkout")
  if (!exactJson(evidence.commands.map((item) => item.id), RELEASE_COMMAND_IDS) || new Set(evidence.commands.map((item) => item.id)).size !== RELEASE_COMMAND_IDS.length || evidence.commands.some((item) => item.exit_code !== 0)) {
    throw new Error("Release evidence must contain the exact ten successful commands")
  }
  let retainedTotal = 0
  for (const item of evidence.commands) {
    const bytes = retainedCommandBytes(item)
    retainedTotal += bytes.stdout.byteLength + bytes.stderr.byteLength
  }
  if (retainedTotal > MAX_RETAINED_OUTPUT_TOTAL_BYTES) throw new Error("Release evidence retained command output total exceeds bounds")
  const excelRoot = join(canonicalRoot, "capabilities", "excel")
  const wrapper = join(excelRoot, "wrapper.py")
  for (const [index, item] of evidence.commands.entries()) {
    const expectedCwd = index === 7 ? excelRoot : canonicalRoot
    if (!sameResolvedPath(item.cwd, expectedCwd)) throw new Error(`Release evidence command ${index} cwd differs from the current checkout`)
  }
  exactArgs(evidence.commands[0]!, ["run", "typecheck"], "typecheck")
  exactArgs(evidence.commands[1]!, ["test", "--timeout", "60000"], "test")
  exactArgs(evidence.commands[2]!, ["test", "tests/manager.test.ts", "--timeout", "60000"], "manager test")
  exactArgs(evidence.commands[3]!, ["run", "smoke"], "smoke")
  exactArgs(evidence.commands[4]!, ["run", "check:live"], "live")
  exactArgs(evidence.commands[5]!, ["run", "check:excel-manifest"], "manifest")
  exactArgs(evidence.commands[6]!, ["-m", "unittest", "discover", "-s", "tests/python", "-v"], "Python test")
  exactArgs(evidence.commands[7]!, ["sync", "--frozen", "--no-dev"], "uv sync")
  const canonicalBun = realpathSync.native(process.execPath)
  for (const command of evidence.commands.slice(0, 6)) {
    if (!sameResolvedPath(command.argv[0]!, canonicalBun)) throw new Error("Release evidence Bun executable differs from current Bun")
  }
  assertRegularExecutable(evidence.commands[6]!.argv[0]!, /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i, "Python")
  assertRegularExecutable(evidence.commands[7]!.argv[0]!, /^uv(?:\.exe)?$/i, "uv")
  if (evidence.commands[8]!.argv.length !== 3 || !sameResolvedPath(evidence.commands[8]!.argv[1]!, wrapper) || evidence.commands[8]!.argv[2] !== "--check") {
    throw new Error("Release evidence wrapper check command arguments are not exact")
  }
  if (evidence.commands[9]!.argv.length !== 2 || !sameResolvedPath(evidence.commands[9]!.argv[1]!, wrapper)) {
    throw new Error("Release evidence wrapper EOF command arguments are not exact")
  }
  const wrapperInterpreter = evidence.commands[8]!.argv[0]!
  if (!sameResolvedPath(wrapperInterpreter, evidence.commands[9]!.argv[0]!) || !isAbsolute(wrapperInterpreter) ||
    !/^python(?:3)?(?:\.exe)?$/i.test(basename(wrapperInterpreter)) || !wrapperInterpreter.includes("opencode-alg-excel-release-gate-")) {
    throw new Error("Release evidence wrapper interpreter relationship is invalid")
  }
  const npm = resolveNpmInvocation()
  if (!exactJson(evidence.commands[10]!.argv, [npm.executable, ...npm.argsPrefix, "pack", "--dry-run", "--json"])) {
    throw new Error("Release evidence npm invocation differs from the current safe canonical resolver")
  }
  const bunTotals = parsedBunTotals(evidence.commands[1]!)
  const manager = parsedBunTotals(evidence.commands[2]!)
  const managerTotals = { manager_pass: manager.bun_pass, manager_skip: manager.bun_skip, manager_fail: manager.bun_fail, manager_total: manager.bun_total, manager_assertions: manager.bun_assertions, manager_files: manager.bun_files }
  const pythonTotals = parsedPythonTotals(evidence.commands[6]!)
  if (!exactJson(evidence.totals, { ...bunTotals, ...managerTotals, ...pythonTotals }) || evidence.totals.bun_fail !== 0 || evidence.totals.manager_fail !== 0 || evidence.totals.bun_pass < 1 || evidence.totals.manager_pass < 1 || evidence.totals.python_run < 1) {
    throw new Error("Release evidence test totals do not prove successful Bun and Python suites")
  }
  const manifest = verifyExcelManifest(canonicalRoot)
  const manifestOutput = finalJsonLine(evidence.commands[5]!.stdout)
  if (manifestOutput?.ok !== true || manifestOutput.manifest_sha256 !== manifest.manifest_sha256 || !exactJson(manifestOutput.files, manifest.files) ||
    evidence.excel.manifest_sha256 !== manifest.manifest_sha256 || evidence.excel.lock_sha256 !== manifest.files.lock) {
    throw new Error("Release evidence Excel hashes differ from the current package")
  }
  const wrapperOutput = finalJsonLine(evidence.commands[8]!.stdout)
  if (wrapperOutput?.ok !== true || wrapperOutput.version !== "0.1.8" || wrapperOutput.tool_count !== EXCEL_TOOLS.length ||
    !exactJson(wrapperOutput.tools, EXCEL_TOOLS) || wrapperOutput.remote_transports !== false ||
    wrapperOutput.path_policy?.ok !== true || wrapperOutput.path_policy?.path_argument_confinement !== true ||
    evidence.excel.version !== wrapperOutput.version || evidence.excel.tool_count !== wrapperOutput.tool_count ||
    evidence.commands[9]!.stdout !== "" || evidence.excel.eof_stdout_bytes !== 0) throw new Error("Release evidence wrapper output contract is invalid")
  const expectedPaths = expectedPackedPaths(canonicalRoot)
  let packArray: any
  try { packArray = JSON.parse(evidence.commands[10]!.stdout) } catch { throw new Error("Retained npm output is not JSON") }
  if (!Array.isArray(packArray) || packArray.length !== 1 || !Array.isArray(packArray[0]?.files)) throw new Error("Retained npm output shape is invalid")
  const pack = packArray[0]
  const parsedFiles = pack.files.map((file: any) => ({ path: file.path, size: file.size, mode: file.mode })).sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const parsedUnpackedBytes = parsedFiles.reduce((total: number, file: any) => total + file.size, 0)
  const inventory = validatePackedInventory(parsedFiles, expectedPaths)
  const expectedCapabilities = [
    "capabilities/excel/manifest.json", "capabilities/excel/policy.py", "capabilities/excel/pyproject.toml",
    "capabilities/excel/uv.lock", "capabilities/excel/workbook.py", "capabilities/excel/wrapper.py",
  ]
  if (evidence.package.entries !== parsedFiles.length || evidence.package.entries !== pack.entryCount || pack.unpackedSize !== parsedUnpackedBytes ||
    !exactJson(evidence.package.files, parsedFiles) || evidence.package.packed_bytes !== pack.size || evidence.package.unpacked_bytes !== pack.unpackedSize ||
    evidence.package.inventory_sha256 !== inventory.sha256 ||
    JSON.stringify(evidence.package.capability_files) !== JSON.stringify(expectedCapabilities) ||
    evidence.package.lock_bytes !== statSync(join(excelRoot, "uv.lock")).size) {
    throw new Error("Release evidence package inventory differs from the current reviewed package")
  }
  for (const file of parsedFiles) {
    const current = join(canonicalRoot, ...file.path.split("/"))
    if (!existsSync(current) || !lstatSync(current).isFile() || statSync(current).size !== file.size || file.mode !== 420) {
      throw new Error(`Release evidence packed file metadata differs from current package: ${file.path}`)
    }
  }
  const liveArtifact = verifyRetainedLiveEvidenceArtifact(evidence.live.evidence_path, {
    source_sha256: evidence.live.source_sha256,
    sha256: evidence.live.evidence_sha256,
    bytes: evidence.live.evidence_bytes,
    identity: evidence.live.evidence_identity,
  }, canonicalRoot)
  const live = liveArtifact.evidence
  if (evidence.live.source_sha256 !== source.digest ||
    live.plugin_source?.sha256 !== source.digest ||
    live.isolation?.global_config_snapshots?.before?.sha256 !== evidence.live.global_config_snapshot_sha256 ||
    live.isolation?.global_config_snapshots?.after?.sha256 !== evidence.live.global_config_snapshot_sha256) {
    throw new Error("Release evidence live proof is not semantically bound to the current checkout and config snapshot")
  }
  return evidence
}

export function verifyRetainedReleaseEvidence(
  path: string,
  expected: { sha256?: string; bytes?: number; identity?: EvidenceFileIdentity } = {},
  root = ROOT,
): { path: string; sha256: string; bytes: number; identity: EvidenceFileIdentity; evidence: ReleaseEvidence } {
  if (!isAbsolute(path) || !existsSync(path)) throw new Error("Retained release evidence path must be absolute and exist")
  const identity = releaseEvidenceIdentity(path)
  if (expected.identity !== undefined && !sameEvidenceIdentity(identity, expected.identity)) throw new Error("Retained release evidence identity differs from the generated artifact")
  const bytes = readFileSync(path)
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) throw new Error(`Release evidence exceeds ${MAX_EVIDENCE_BYTES} bytes`)
  const digest = sha256(bytes)
  if (expected.sha256 !== undefined && digest !== expected.sha256) throw new Error("Retained release evidence hash differs from the generated artifact")
  if (expected.bytes !== undefined && bytes.byteLength !== expected.bytes) throw new Error("Retained release evidence size differs from the generated artifact")
  const evidence = validateReleaseEvidenceSemantics(JSON.parse(bytes.toString("utf8")), root)
  const expectedName = new RegExp(`^release-gate-${evidence.release_inputs.sha256.slice(0, 16)}-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.json$`, "i")
  if (!expectedName.test(path.split(/[\\/]/).at(-1) ?? "")) throw new Error("Retained release evidence filename is not the generated release-input/UUID form")
  if (!sameEvidenceIdentity(releaseEvidenceIdentity(path), identity)) throw new Error("Retained release evidence identity changed during verification")
  return { path: resolve(path), sha256: digest, bytes: bytes.byteLength, identity, evidence }
}

interface Captured { evidence: z.infer<typeof CommandEvidenceSchema>; stdout: string; stderr: string }

function run(id: typeof RELEASE_COMMAND_IDS[number], executable: string, args: string[], cwd = ROOT, env?: Record<string, string>, input?: Buffer): Captured {
  const child = spawnSync(executable, args, {
    cwd, env: env ? { ...process.env, ...env } : process.env, input,
    shell: false, windowsHide: true, maxBuffer: MAX_CAPTURE_BYTES,
  })
  if (child.error) throw child.error
  const stdout = redactReleaseText((Buffer.isBuffer(child.stdout) ? child.stdout : Buffer.from(child.stdout ?? "")).toString("utf8"))
  const stderr = redactReleaseText((Buffer.isBuffer(child.stderr) ? child.stderr : Buffer.from(child.stderr ?? "")).toString("utf8"))
  const stdoutBytes = Buffer.from(stdout, "utf8")
  const stderrBytes = Buffer.from(stderr, "utf8")
  if (stdoutBytes.byteLength > MAX_RETAINED_COMMAND_BYTES || stderrBytes.byteLength > MAX_RETAINED_COMMAND_BYTES) {
    throw new Error(`Release command ${id} output exceeds ${MAX_RETAINED_COMMAND_BYTES} retained bytes`)
  }
  return {
    evidence: CommandEvidenceSchema.parse({
      id, argv: [executable, ...args], cwd, exit_code: child.status ?? 1,
      stdout_bytes: stdoutBytes.byteLength, stdout_sha256: sha256(stdoutBytes), stdout,
      stderr_bytes: stderrBytes.byteLength, stderr_sha256: sha256(stderrBytes), stderr,
    }),
    stdout, stderr,
  }
}

function requireSuccess(result: Captured): Captured {
  if (result.evidence.exit_code !== 0) throw new Error(`Release command failed: ${result.evidence.argv[0]} ${result.evidence.argv.slice(1).join(" ")}`)
  return result
}

function finalJsonLine(text: string): any {
  const line = text.trim().split(/\r?\n/).at(-1)
  if (!line) throw new Error("Command emitted no JSON")
  return JSON.parse(line)
}

function pathExecutable(name: string): string {
  for (const directory of (process.env.PATH ?? process.env.Path ?? "").split(process.platform === "win32" ? ";" : ":")) {
    const candidate = join(directory.replace(/^"|"$/g, ""), name)
    if (existsSync(candidate)) return candidate
  }
  return name
}


function externalEvidenceDirectory(value: string): string {
  if (!isAbsolute(value)) throw new Error("--evidence-dir must be absolute")
  mkdirSync(value, { recursive: true, mode: 0o700 })
  const directory = realpathSync.native(value)
  const fromRoot = relative(realpathSync.native(ROOT), directory)
  if (fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))) throw new Error("Evidence directory must be external to the repository")
  return directory
}

function releaseEvidenceIdentity(path: string): EvidenceFileIdentity {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || !sameResolvedPath(realpathSync.native(path), path)) {
    throw new Error(`Release evidence path is redirected or not a direct regular file: ${path}`)
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function sameEvidenceIdentity(left: EvidenceFileIdentity, right: EvidenceFileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function releaseEvidenceMissing(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return true
    throw error
  }
}

function assertReleaseEvidenceFile(path: string, identity: EvidenceFileIdentity, bytes: Buffer, label: string): void {
  if (!sameEvidenceIdentity(releaseEvidenceIdentity(path), identity) || !readFileSync(path).equals(bytes)) {
    throw new Error(`${label} bytes or identity changed: ${path}`)
  }
}

export function writeReleaseEvidence(
  directory: string,
  evidence: ReleaseEvidence,
  options: {
    uuid?: () => string
    link?: typeof linkSync
    unlink?: typeof unlinkSync
    afterLink?: (temporary: string, final: string) => void
    afterFinalVerified?: (temporary: string, final: string) => void
  } = {},
): { path: string; sha256: string; bytes: number; identity: EvidenceFileIdentity } {
  const parsed = ReleaseEvidenceSchema.parse(evidence)
  const bytes = Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, "utf8")
  if (bytes.byteLength > MAX_EVIDENCE_BYTES) throw new Error(`Release evidence exceeds ${MAX_EVIDENCE_BYTES} bytes`)
  const path = join(externalEvidenceDirectory(directory), `release-gate-${parsed.release_inputs.sha256.slice(0, 16)}-${(options.uuid ?? randomUUID)()}.json`)
  const temporary = `${path}.tmp-${randomUUID()}`
  const link = options.link ?? linkSync
  const unlink = options.unlink ?? unlinkSync
  let temporaryIdentity: EvidenceFileIdentity | undefined
  try {
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 })
    temporaryIdentity = releaseEvidenceIdentity(temporary)
    assertReleaseEvidenceFile(temporary, temporaryIdentity, bytes, "Release evidence temporary")
    link(temporary, path)
    options.afterLink?.(temporary, path)
    const finalIdentity = releaseEvidenceIdentity(path)
    if (!sameEvidenceIdentity(finalIdentity, temporaryIdentity)) throw new Error("Generated release evidence final identity differs from its temporary hard link")
    const retained = readFileSync(path)
    const digest = sha256(retained)
    if (!retained.equals(bytes) || digest !== sha256(bytes)) throw new Error("Generated release evidence bytes changed before retention was confirmed")
    assertReleaseEvidenceFile(path, finalIdentity, bytes, "Generated release evidence final")
    options.afterFinalVerified?.(temporary, path)
    assertReleaseEvidenceFile(temporary, temporaryIdentity, bytes, "Generated release evidence temporary before cleanup")
    unlink(temporary)
    assertReleaseEvidenceFile(path, finalIdentity, bytes, "Generated release evidence final after temporary cleanup")
    return { path: resolve(path), sha256: digest, bytes: retained.byteLength, identity: finalIdentity }
  } catch (error) {
    let cleanupFailure: unknown
    if (temporaryIdentity && !releaseEvidenceMissing(temporary)) {
      try {
        assertReleaseEvidenceFile(temporary, temporaryIdentity, bytes, "Generated release evidence temporary cleanup")
        unlink(temporary)
      } catch (cleanupError) {
        cleanupFailure = cleanupError
      }
    }
    const cleanup = cleanupFailure === undefined ? "" : `; temporary preserved: ${cleanupFailure instanceof Error ? cleanupFailure.message : String(cleanupFailure)}`
    throw new Error(`Release evidence no-clobber publication failed: ${error instanceof Error ? error.message : String(error)}${cleanup}`)
  }
}

function argument(args: string[], name: string): string {
  const index = args.indexOf(name)
  if (index < 0 || !args[index + 1]) throw new Error(`Usage: release-gate --evidence-dir <absolute-external-directory>`)
  return args[index + 1]!
}

export function runReleaseGate(args = process.argv.slice(2)): { evidence: ReleaseEvidence; retained: { path: string; sha256: string; bytes: number; identity: EvidenceFileIdentity } } {
  const evidenceDir = argument(args, "--evidence-dir")
  if (repositoryReleaseArtifacts(ROOT).length) throw new Error(`Repository contains generated release artifacts: ${repositoryReleaseArtifacts(ROOT).join(", ")}`)
  const helperArtifactsBefore = windowsShellHelperArtifactSnapshot()
  const releaseInputsBefore = computeReleaseInputIdentity(ROOT)
  const commands: ReleaseEvidence["commands"] = []
  const capture = (result: Captured) => { commands.push(result.evidence); return requireSuccess(result) }
  const bun = process.execPath
  const python = pathExecutable(process.platform === "win32" ? "python.exe" : "python3")
  capture(run("typecheck", bun, ["run", "typecheck"]))
  const tests = capture(run("bun_test", bun, ["test", "--timeout", "60000"]))
  const managerTests = capture(run("manager_tests", bun, ["test", "tests/manager.test.ts", "--timeout", "60000"]))
  capture(run("smoke", bun, ["run", "smoke"]))
  const live = finalJsonLine(capture(run("live_verify", bun, ["run", "check:live"])).stdout)
  const manifest = finalJsonLine(capture(run("excel_manifest", bun, ["run", "check:excel-manifest"])).stdout)
  const pythonTests = capture(run("python_tests", python, ["-m", "unittest", "discover", "-s", "tests/python", "-v"], ROOT, { PYTHONDONTWRITEBYTECODE: "1" }))

  const temp = mkdtempSync(join(tmpdir(), "opencode-alg-excel-release-gate-"))
  const envPath = join(temp, "env")
  const workbookRoot = join(temp, "workbooks")
  mkdirSync(workbookRoot)
  let wrapperCheck: any
  let eofStdoutBytes = -1
  try {
    capture(run("uv_sync", pathExecutable(process.platform === "win32" ? "uv.exe" : "uv"), ["sync", "--frozen", "--no-dev"], join(ROOT, "capabilities", "excel"), {
      UV_PROJECT_ENVIRONMENT: envPath, UV_NO_PROGRESS: "1", PYTHONDONTWRITEBYTECODE: "1",
    }))
    const interpreter = process.platform === "win32" ? join(envPath, "Scripts", "python.exe") : join(envPath, "bin", "python")
    const wrapper = join(ROOT, "capabilities", "excel", "wrapper.py")
    const runtimeEnv = { ALG_EXCEL_ROOT: workbookRoot, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONUTF8: "1" }
    wrapperCheck = finalJsonLine(capture(run("excel_wrapper_check", interpreter, [wrapper, "--check"], ROOT, runtimeEnv)).stdout)
    const eof = capture(run("excel_wrapper_eof", interpreter, [wrapper], ROOT, runtimeEnv, Buffer.alloc(0)))
    eofStdoutBytes = eof.evidence.stdout_bytes
    if (eofStdoutBytes !== 0) throw new Error("Excel wrapper emitted pre-handshake stdout")
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
  const npm = resolveNpmInvocation()
  const pack = JSON.parse(capture(run("npm_pack", npm.executable, [...npm.argsPrefix, "pack", "--dry-run", "--json"])).stdout)[0]
  const packageInventory = validatePackedInventory(pack.files)
  const capabilityFiles = pack.files.filter((file: any) => file.path.startsWith("capabilities/excel/")).map((file: any) => file.path).sort()
  const expectedCapabilityFiles = [
    "capabilities/excel/manifest.json", "capabilities/excel/policy.py", "capabilities/excel/pyproject.toml",
    "capabilities/excel/uv.lock", "capabilities/excel/workbook.py", "capabilities/excel/wrapper.py",
  ]
  if (JSON.stringify(capabilityFiles) !== JSON.stringify(expectedCapabilityFiles)) throw new Error("npm pack capability inventory is not the exact six-file contract")
  const capabilityModes = pack.files.filter((file: any) => file.path.startsWith("capabilities/excel/")).map((file: any) => file.mode)
  if (capabilityModes.some((mode: number) => mode !== 420)) throw new Error("npm pack capability modes must all be 0644")
  const tgzCreated = readdirSync(ROOT).some((name) => name.endsWith(".tgz"))
  if (tgzCreated) throw new Error("npm pack --dry-run created a repository tgz")
  const helperBeforeSet = new Set(helperArtifactsBefore.map((path) => resolve(path)))
  const helperAdditions = windowsShellHelperArtifactSnapshot().filter((path) => !helperBeforeSet.has(resolve(path)))
  cleanupWindowsShellHelpers({ candidates: helperAdditions, minimumAgeMs: 0 })
  const helperArtifactsAfter = windowsShellHelperArtifactSnapshot()
  const helperNetAdditions = helperArtifactsAfter.filter((path) => !helperBeforeSet.has(resolve(path)))
  if (helperNetAdditions.length !== 0) throw new Error(`Release verification left owned Windows helper artifacts: ${helperNetAdditions.join(", ")}`)
  const source = computeAlgSourceIdentity(ROOT)
  const releaseInputsAfter = computeReleaseInputIdentity(ROOT)
  if (!exactJson(releaseInputsBefore, releaseInputsAfter)) throw new Error("Release inputs changed during aggregate command/package verification")
  const bunTotals = parsedBunTotals(tests.evidence)
  const manager = parsedBunTotals(managerTests.evidence)
  const managerTotals = { manager_pass: manager.bun_pass, manager_skip: manager.bun_skip, manager_fail: manager.bun_fail, manager_total: manager.bun_total, manager_assertions: manager.bun_assertions, manager_files: manager.bun_files }
  const pythonTotals = parsedPythonTotals(pythonTests.evidence)
  if (live.passed !== true || live.user_global_config_modified !== false || live.global_config_snapshot_unchanged !== true ||
    !/^[a-f0-9]{64}$/.test(live.global_config_snapshot_sha256 ?? "") || live.temporary_environment_removed !== true) {
    throw new Error("Live evidence did not prove isolated success/measured global-config preservation/cleanup")
  }
  if (live.source_sha256 !== source.digest) throw new Error("Live source digest differs from final release-gate source digest")
  const liveArtifact = verifyRetainedLiveEvidenceArtifact(live.evidence_path, {
    source_sha256: live.source_sha256,
    sha256: live.evidence_sha256,
    bytes: live.evidence_bytes,
    identity: FileIdentitySchema.parse(live.evidence_identity),
  }, ROOT)
  if (!sameEvidenceIdentity(liveArtifact.identity, live.evidence_identity)) throw new Error("Retained live evidence identity differs from live summary")
  const evidence = ReleaseEvidenceSchema.parse({
    schema_version: 5, kind: "opencode-alg-release-gate", generated_at: new Date().toISOString(), package_version: "0.3.0",
    source: { sha256: source.digest, files: source.file_count, bytes: source.total_bytes }, release_inputs: releaseInputsAfter, commands,
    totals: { ...bunTotals, ...managerTotals, ...pythonTotals },
    excel: { manifest_sha256: manifest.manifest_sha256, lock_sha256: manifest.files.lock, version: wrapperCheck.version, tool_count: wrapperCheck.tool_count, eof_stdout_bytes: eofStdoutBytes },
    package: { entries: pack.entryCount, packed_bytes: pack.size, unpacked_bytes: pack.unpackedSize, files: pack.files.map((file: any) => ({ path: file.path, size: file.size, mode: file.mode })).sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), inventory_sha256: packageInventory.sha256, capability_files: capabilityFiles, lock_bytes: pack.files.find((file: any) => file.path.endsWith("uv.lock")).size, tgz_created: tgzCreated },
    live: { passed: live.passed, evidence_path: live.evidence_path, evidence_sha256: live.evidence_sha256, evidence_bytes: live.evidence_bytes, evidence_identity: live.evidence_identity, source_sha256: live.source_sha256, user_global_config_modified: live.user_global_config_modified, global_config_snapshot_sha256: live.global_config_snapshot_sha256, temporary_environment_removed: live.temporary_environment_removed },
    cleanup: { temporary_excel_environment_removed: !existsSync(temp), repository_artifacts_absent: repositoryReleaseArtifacts(ROOT).length === 0, helper_owned_before: helperArtifactsBefore.length, helper_owned_after: helperArtifactsAfter.length, helper_net_additions: 0 },
    passed: true,
  })
  validateReleaseEvidenceSemantics(evidence, ROOT)
  const written = writeReleaseEvidence(evidenceDir, evidence)
  const retained = verifyRetainedReleaseEvidence(written.path, written, ROOT)
  return { evidence: retained.evidence, retained: { path: retained.path, sha256: retained.sha256, bytes: retained.bytes, identity: retained.identity } }
}

if (import.meta.main) {
  try {
    const result = runReleaseGate()
    console.log(JSON.stringify({ passed: true, ...result.retained, source_sha256: result.evidence.source.sha256 }))
  } catch (error) {
    console.error(redactReleaseText(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  }
}

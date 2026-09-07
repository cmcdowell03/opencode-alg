import { createHash, randomUUID } from "node:crypto"
import { spawn } from "node:child_process"
import {
  closeSync, constants, existsSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync,
} from "node:fs"
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { computeAlgSourceIdentity } from "../src/source-identity.ts"
import { cleanupWindowsShellHelpers, windowsShellHelperArtifactSnapshot, terminateProcessTree } from "../src/shell.ts"
import { verifyRetainedLiveEvidenceArtifact, type EvidenceFileIdentity } from "./live-verify.ts"
import { resolveNpmInvocation } from "./npm-invocation.ts"
import { verifyExcelManifest } from "./verify-excel-manifest.ts"
import { DUCKDB_CAPABILITY_FILES, verifyDuckDbManifest } from "./verify-duckdb-manifest.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const MAX_EVIDENCE_BYTES = 512 * 1024
const MAX_CAPTURE_BYTES = 96 * 1024
const MAX_RETAINED_COMMAND_BYTES = 96 * 1024
const MAX_RETAINED_OUTPUT_TOTAL_BYTES = 320 * 1024
const TAIL_BYTES = 2_048
const Sha = z.string().regex(/^[a-f0-9]{64}$/)
const FileIdentitySchema = z.object({ dev: z.string().regex(/^\d+$/), ino: z.string().regex(/^\d+$/) }).strict()
export const RELEASE_COMMAND_IDS = [
  "typecheck", "bun_test", "manager_tests", "smoke", "live_verify", "excel_manifest", "duckdb_manifest",
  "python_tests", "excel_uv_sync", "excel_wrapper_check", "excel_wrapper_eof", "duckdb_uv_sync",
  "duckdb_python_tests", "duckdb_wrapper_preflight", "duckdb_wrapper_eof", "npm_pack",
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
  schema_version: z.literal(6),
  kind: z.literal("opencode-alg-release-gate"),
  generated_at: z.iso.datetime({ offset: true }),
  package_version: z.literal("0.4.0"),
  source: z.object({ sha256: Sha, files: z.number().int().positive(), bytes: z.number().int().positive() }).strict(),
  release_inputs: z.object({ sha256: Sha, files: z.number().int().positive(), bytes: z.number().int().positive() }).strict(),
  commands: z.array(CommandEvidenceSchema).length(RELEASE_COMMAND_IDS.length),
  totals: z.object({ bun_pass: z.number().int().nonnegative(), bun_skip: z.number().int().nonnegative(), bun_fail: z.number().int().nonnegative(), bun_total: z.number().int().nonnegative(), bun_assertions: z.number().int().nonnegative(), bun_files: z.number().int().positive(), manager_pass: z.number().int().nonnegative(), manager_skip: z.number().int().nonnegative(), manager_fail: z.number().int().nonnegative(), manager_total: z.number().int().nonnegative(), manager_assertions: z.number().int().nonnegative(), manager_files: z.number().int().positive(), python_run: z.number().int().nonnegative(), python_skipped: z.number().int().nonnegative(), python_ok: z.literal(true), duckdb_python_run: z.number().int().positive(), duckdb_python_skipped: z.number().int().nonnegative(), duckdb_python_ok: z.literal(true) }).strict(),
  excel: z.object({ manifest_sha256: Sha, lock_sha256: Sha, version: z.literal("0.1.8"), tool_count: z.literal(25), eof_stdout_bytes: z.literal(0) }).strict(),
  duckdb: z.object({ manifest_sha256: Sha, lock_sha256: Sha, version: z.literal("0.1.0"), engine_version: z.literal("1.4.0"), parser_version: z.literal("27.14.0"), tool_count: z.literal(1), eof_stdout_bytes: z.literal(0), contract_sha256: Sha }).strict(),
  package: z.object({
    entries: z.number().int().positive(), packed_bytes: z.number().int().positive(), unpacked_bytes: z.number().int().positive(),
    files: z.array(PackedFileSchema).min(1).max(128), inventory_sha256: Sha,
    capability_files: z.array(z.string()).length(19),
    lock_bytes: z.object({ excel: z.number().int().positive(), duckdb: z.number().int().positive() }).strict(),
    tgz_created: z.literal(false),
  }).strict(),
  live: z.object({ passed: z.literal(true), evidence_path: z.string().max(4_096), evidence_sha256: Sha, evidence_bytes: z.number().int().positive(), evidence_identity: FileIdentitySchema, source_sha256: Sha, user_global_config_modified: z.literal(false), global_config_snapshot_sha256: Sha, temporary_environment_removed: z.literal(true) }).strict(),
  cleanup: z.object({
    temporary_excel_environment_removed: z.literal(true), temporary_duckdb_environment_removed: z.literal(true), repository_artifacts_absent: z.literal(true),
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
  "bun.lock", "npm-shrinkwrap.json",
  "docs/operations.md", "docs/release-verification.md", "docs/upgrades.md",
  "docs/duckdb-query-plane.md",
  "docs/experience-and-data-science.md", "docs/connectors.md", "docs/implementation-status.md",
  "scripts/alg.ps1", "scripts/alg.sh", "scripts/check-live.ts", "scripts/install.ps1", "scripts/install.sh",
  "scripts/installer-core.ts", "scripts/live-verify.ts", "scripts/manager-cli.ts", "scripts/manager-core.ts",
  "scripts/manager-schema.ts", "scripts/npm-invocation.ts", "scripts/release-gate.ts", "scripts/smoke.ts",
  "scripts/verify-duckdb-manifest.ts", "scripts/verify-excel-manifest.ts",
  "scripts/duckdb-project.ts", "scripts/datascience-project.ts",
  "scripts/data-science-cli.ts", "scripts/experience-cli.ts", "scripts/verify-optional-manifests.ts",
  "scripts/synthetic-gate.ts",
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

function parsedPythonTotals(command: z.infer<typeof CommandEvidenceSchema>, prefix = "python") {
  const output = combinedOutput(command)
  const run = output.match(/Ran (\d+) tests? /)
  const skipped = output.match(/OK \(skipped=(\d+)\)/)
  const ok = /(?:^|\r?\n)OK(?: \(skipped=\d+\))?(?:\r?\n|$)/.test(output)
  if (!run || !ok) throw new Error("Retained Python output lacks Ran/OK totals")
  return {
    [`${prefix}_run`]: Number(run[1]),
    [`${prefix}_skipped`]: Number(skipped?.[1] ?? 0),
    [`${prefix}_ok`]: true as const,
  }
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
    throw new Error("Release evidence must contain the exact sixteen successful commands")
  }
  const byId = Object.fromEntries(evidence.commands.map((item) => [item.id, item])) as Record<typeof RELEASE_COMMAND_IDS[number], ReleaseEvidence["commands"][number]>
  let retainedTotal = 0
  for (const item of evidence.commands) {
    const bytes = retainedCommandBytes(item)
    retainedTotal += bytes.stdout.byteLength + bytes.stderr.byteLength
  }
  if (retainedTotal > MAX_RETAINED_OUTPUT_TOTAL_BYTES) throw new Error("Release evidence retained command output total exceeds bounds")
  const excelRoot = join(canonicalRoot, "capabilities", "excel")
  const excelWrapper = join(excelRoot, "wrapper.py")
  const duckdbRoot = join(canonicalRoot, "capabilities", "duckdb")
  const duckdbWrapper = join(duckdbRoot, "wrapper.py")
  const duckdbContract = join(duckdbRoot, "contract.example.json")
  const duckdbTest = join(canonicalRoot, "tests", "python", "test_duckdb_capability.py")
  for (const [index, item] of evidence.commands.entries()) {
    const expectedCwd = item.id === "excel_uv_sync" ? excelRoot : item.id === "duckdb_uv_sync" ? duckdbRoot : canonicalRoot
    if (!sameResolvedPath(item.cwd, expectedCwd)) throw new Error(`Release evidence command ${index} cwd differs from the current checkout`)
  }
  exactArgs(byId.typecheck, ["run", "typecheck"], "typecheck")
  exactArgs(byId.bun_test, ["test", "--timeout", "60000"], "test")
  exactArgs(byId.manager_tests, ["test", "tests/manager.test.ts", "--timeout", "60000"], "manager test")
  exactArgs(byId.smoke, ["run", "smoke"], "smoke")
  exactArgs(byId.live_verify, ["run", "check:live"], "live")
  exactArgs(byId.excel_manifest, ["run", "check:excel-manifest"], "Excel manifest")
  exactArgs(byId.duckdb_manifest, ["run", "check:duckdb-manifest"], "DuckDB manifest")
  exactArgs(byId.python_tests, ["-m", "unittest", "discover", "-s", "tests/python", "-v"], "Python test")
  exactArgs(byId.excel_uv_sync, ["sync", "--frozen", "--no-dev"], "Excel uv sync")
  exactArgs(byId.duckdb_uv_sync, ["sync", "--frozen", "--no-dev"], "DuckDB uv sync")
  exactArgs(byId.duckdb_python_tests, [duckdbTest, "-v"], "DuckDB Python test")
  const canonicalBun = realpathSync.native(process.execPath)
  for (const command of evidence.commands.slice(0, 7)) {
    if (!sameResolvedPath(command.argv[0]!, canonicalBun)) throw new Error("Release evidence Bun executable differs from current Bun")
  }
  assertRegularExecutable(byId.python_tests.argv[0]!, /^python(?:3(?:\.\d+)?)?(?:\.exe)?$/i, "Python")
  assertRegularExecutable(byId.excel_uv_sync.argv[0]!, /^uv(?:\.exe)?$/i, "Excel uv")
  assertRegularExecutable(byId.duckdb_uv_sync.argv[0]!, /^uv(?:\.exe)?$/i, "DuckDB uv")
  if (byId.excel_wrapper_check.argv.length !== 3 || !sameResolvedPath(byId.excel_wrapper_check.argv[1]!, excelWrapper) || byId.excel_wrapper_check.argv[2] !== "--check") {
    throw new Error("Release evidence wrapper check command arguments are not exact")
  }
  if (byId.excel_wrapper_eof.argv.length !== 2 || !sameResolvedPath(byId.excel_wrapper_eof.argv[1]!, excelWrapper)) {
    throw new Error("Release evidence wrapper EOF command arguments are not exact")
  }
  const excelInterpreter = byId.excel_wrapper_check.argv[0]!
  if (!sameResolvedPath(excelInterpreter, byId.excel_wrapper_eof.argv[0]!) || !isAbsolute(excelInterpreter) ||
    !/^python(?:3)?(?:\.exe)?$/i.test(basename(excelInterpreter)) || !excelInterpreter.includes("opencode-alg-excel-release-gate-")) {
    throw new Error("Release evidence wrapper interpreter relationship is invalid")
  }
  const duckdbInterpreter = byId.duckdb_python_tests.argv[0]!
  if (!sameResolvedPath(duckdbInterpreter, byId.duckdb_wrapper_preflight.argv[0]!) ||
    !sameResolvedPath(duckdbInterpreter, byId.duckdb_wrapper_eof.argv[0]!) || !isAbsolute(duckdbInterpreter) ||
    !/^python(?:3)?(?:\.exe)?$/i.test(basename(duckdbInterpreter)) || !duckdbInterpreter.includes("opencode-alg-duckdb-release-gate-")) {
    throw new Error("Release evidence DuckDB interpreter relationship is invalid")
  }
  const example = JSON.parse(readFileSync(duckdbContract, "utf8")) as { contract_sha256?: unknown }
  const contractHash = example.contract_sha256
  if (typeof contractHash !== "string" || !/^[a-f0-9]{64}$/.test(contractHash)) throw new Error("DuckDB example contract hash is invalid")
  if (!exactJson(byId.duckdb_wrapper_preflight.argv.slice(1), [duckdbWrapper, "--preflight", "--contract", duckdbContract, "--hash", contractHash]) ||
    !exactJson(byId.duckdb_wrapper_eof.argv.slice(1), [duckdbWrapper, "--mcp", "--contract", duckdbContract, "--hash", contractHash])) {
    throw new Error("Release evidence DuckDB wrapper command arguments are not exact")
  }
  const npm = resolveNpmInvocation()
  if (!exactJson(byId.npm_pack.argv, [npm.executable, ...npm.argsPrefix, "pack", "--dry-run", "--json"])) {
    throw new Error("Release evidence npm invocation differs from the current safe canonical resolver")
  }
  const bunTotals = parsedBunTotals(byId.bun_test)
  const manager = parsedBunTotals(byId.manager_tests)
  const managerTotals = { manager_pass: manager.bun_pass, manager_skip: manager.bun_skip, manager_fail: manager.bun_fail, manager_total: manager.bun_total, manager_assertions: manager.bun_assertions, manager_files: manager.bun_files }
  const pythonTotals = parsedPythonTotals(byId.python_tests)
  const duckdbPythonTotals = parsedPythonTotals(byId.duckdb_python_tests, "duckdb_python")
  if (!exactJson(evidence.totals, { ...bunTotals, ...managerTotals, ...pythonTotals, ...duckdbPythonTotals }) || evidence.totals.bun_fail !== 0 || evidence.totals.manager_fail !== 0 || evidence.totals.bun_pass < 1 || evidence.totals.manager_pass < 1 || evidence.totals.python_run < 1 || evidence.totals.duckdb_python_run < 1 || evidence.totals.duckdb_python_skipped !== 0) {
    throw new Error("Release evidence test totals do not prove successful Bun, Python, and prepared DuckDB suites")
  }
  const manifest = verifyExcelManifest(canonicalRoot)
  const manifestOutput = finalJsonLine(byId.excel_manifest.stdout)
  if (manifestOutput?.ok !== true || manifestOutput.manifest_sha256 !== manifest.manifest_sha256 || !exactJson(manifestOutput.files, manifest.files) ||
    evidence.excel.manifest_sha256 !== manifest.manifest_sha256 || evidence.excel.lock_sha256 !== manifest.files.lock) {
    throw new Error("Release evidence Excel hashes differ from the current package")
  }
  const duckdbManifest = verifyDuckDbManifest(canonicalRoot)
  const duckdbManifestOutput = finalJsonLine(byId.duckdb_manifest.stdout)
  if (duckdbManifestOutput?.ok !== true || duckdbManifestOutput.manifest_sha256 !== duckdbManifest.manifest_sha256 ||
    !exactJson(duckdbManifestOutput.files, duckdbManifest.files) || evidence.duckdb.manifest_sha256 !== duckdbManifest.manifest_sha256 ||
    evidence.duckdb.lock_sha256 !== duckdbManifest.files["uv.lock"]) {
    throw new Error("Release evidence DuckDB hashes differ from the current package")
  }
  const wrapperOutput = finalJsonLine(byId.excel_wrapper_check.stdout)
  if (wrapperOutput?.ok !== true || wrapperOutput.version !== "0.1.8" || wrapperOutput.tool_count !== EXCEL_TOOLS.length ||
    !exactJson(wrapperOutput.tools, EXCEL_TOOLS) || wrapperOutput.remote_transports !== false ||
    wrapperOutput.path_policy?.ok !== true || wrapperOutput.path_policy?.path_argument_confinement !== true ||
    evidence.excel.version !== wrapperOutput.version || evidence.excel.tool_count !== wrapperOutput.tool_count ||
    byId.excel_wrapper_eof.stdout !== "" || evidence.excel.eof_stdout_bytes !== 0) throw new Error("Release evidence wrapper output contract is invalid")
  const duckdbPreflight = finalJsonLine(byId.duckdb_wrapper_preflight.stdout)
  if (duckdbPreflight?.ok !== true || duckdbPreflight.compatibility?.capability_version !== "0.1.0" ||
    duckdbPreflight.compatibility?.engine_version !== "1.4.0" || duckdbPreflight.compatibility?.parser_version !== "27.14.0" ||
    !exactJson(duckdbPreflight.compatibility?.extensions, []) || !exactJson(duckdbPreflight.compatibility?.attachment_aliases, []) ||
    duckdbPreflight.compatibility?.contract_sha256 !== contractHash || evidence.duckdb.version !== "0.1.0" ||
    evidence.duckdb.engine_version !== duckdbPreflight.compatibility.engine_version ||
    evidence.duckdb.parser_version !== duckdbPreflight.compatibility.parser_version || evidence.duckdb.tool_count !== 1 ||
    evidence.duckdb.contract_sha256 !== contractHash || byId.duckdb_wrapper_eof.stdout !== "" || evidence.duckdb.eof_stdout_bytes !== 0) {
    throw new Error("Release evidence DuckDB wrapper output contract is invalid")
  }
  const expectedPaths = expectedPackedPaths(canonicalRoot)
  let packArray: any
  try { packArray = JSON.parse(byId.npm_pack.stdout) } catch { throw new Error("Retained npm output is not JSON") }
  if (!Array.isArray(packArray) || packArray.length !== 1 || !Array.isArray(packArray[0]?.files)) throw new Error("Retained npm output shape is invalid")
  const pack = packArray[0]
  const parsedFiles = pack.files.map((file: any) => ({ path: file.path, size: file.size, mode: file.mode })).sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  const parsedUnpackedBytes = parsedFiles.reduce((total: number, file: any) => total + file.size, 0)
  const inventory = validatePackedInventory(parsedFiles, expectedPaths)
  const expectedCapabilities = [
    "capabilities/excel/manifest.json", "capabilities/excel/policy.py", "capabilities/excel/pyproject.toml",
    "capabilities/excel/uv.lock", "capabilities/excel/workbook.py", "capabilities/excel/wrapper.py",
    ...[...DUCKDB_CAPABILITY_FILES, "manifest.json"].sort().map((name) => `capabilities/duckdb/${name}`),
  ].sort()
  if (evidence.package.entries !== parsedFiles.length || evidence.package.entries !== pack.entryCount || pack.unpackedSize !== parsedUnpackedBytes ||
    !exactJson(evidence.package.files, parsedFiles) || evidence.package.packed_bytes !== pack.size || evidence.package.unpacked_bytes !== pack.unpackedSize ||
    evidence.package.inventory_sha256 !== inventory.sha256 ||
    JSON.stringify(evidence.package.capability_files) !== JSON.stringify(expectedCapabilities) ||
    !exactJson(evidence.package.lock_bytes, {
      excel: statSync(join(excelRoot, "uv.lock")).size,
      duckdb: statSync(join(duckdbRoot, "uv.lock")).size,
    })) {
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

interface Captured {
  evidence: z.infer<typeof CommandEvidenceSchema>; stdout: string; stderr: string
  supervision: { duration_ms: number; deadline_ms: number; signal: string | null; timed_out: boolean; output_exceeded: boolean; error: string | null; cleanup_error: string | null }
}

export const RELEASE_COMMAND_DEADLINES_MS: Record<typeof RELEASE_COMMAND_IDS[number], number> = {
  typecheck: 300_000, bun_test: 3_600_000, manager_tests: 1_800_000, smoke: 300_000,
  live_verify: 600_000, excel_manifest: 60_000, duckdb_manifest: 60_000, python_tests: 300_000,
  excel_uv_sync: 600_000, excel_wrapper_check: 120_000, excel_wrapper_eof: 60_000,
  duckdb_uv_sync: 600_000, duckdb_python_tests: 600_000, duckdb_wrapper_preflight: 120_000,
  duckdb_wrapper_eof: 60_000, npm_pack: 300_000,
}

export async function runReleaseCommand(id: typeof RELEASE_COMMAND_IDS[number], executable: string, args: string[], cwd = ROOT, env?: Record<string, string>, input?: Buffer, deadlineMs = RELEASE_COMMAND_DEADLINES_MS[id]): Promise<Captured> {
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1) throw new Error("invalid release command deadline")
  const started = performance.now()
  const child = spawn(executable, args, {
    cwd, env: env ? { ...process.env, ...env } : process.env,
    shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: "pipe",
  })
  const chunks = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
  const sizes = { stdout: 0, stderr: 0 }
  let timedOut = false, outputExceeded = false
  let commandError: string | null = null, cleanupError: string | null = null
  let termination: Promise<void> | undefined
  const stop = () => termination ??= terminateProcessTree(child, { terminationGraceMs: 250 }).catch((error) => {
    cleanupError = boundedReleaseTail(String(error)); try { child.kill("SIGKILL") } catch { /* reported above */ }
  })
  for (const stream of ["stdout", "stderr"] as const) child[stream]!.on("data", (data: Buffer) => {
    const remaining = Math.max(0, MAX_CAPTURE_BYTES - sizes[stream])
    if (remaining) chunks[stream].push(Buffer.from(data.subarray(0, remaining)))
    sizes[stream] += data.length
    if (sizes[stream] > MAX_CAPTURE_BYTES) outputExceeded = true
  })
  child.stdin!.on("error", () => { /* exit/error event owns command status */ })
  child.stdin!.end(input ?? Buffer.alloc(0))
  let exitCode: number | null = null, signal: string | null = null
  await new Promise<void>((done) => {
    const timer = setTimeout(() => {
      timedOut = true
      void stop().finally(() => { child.stdout!.destroy(); child.stderr!.destroy(); done() })
    }, deadlineMs)
    child.once("error", (error) => { commandError = boundedReleaseTail(String(error)); clearTimeout(timer); done() })
    child.once("close", (code, observedSignal) => { exitCode = code; signal = observedSignal; clearTimeout(timer); done() })
  })
  if (termination) await termination
  const retainedOutput = (buffers: Buffer[]) => {
    const bytes = Buffer.from(redactReleaseText(Buffer.concat(buffers).toString("utf8")))
    if (bytes.byteLength <= MAX_RETAINED_COMMAND_BYTES) return bytes.toString("utf8")
    outputExceeded = true
    return bytes.subarray(0, MAX_RETAINED_COMMAND_BYTES - 4).toString("utf8")
  }
  const stdout = retainedOutput(chunks.stdout)
  const stderr = retainedOutput(chunks.stderr)
  const stdoutBytes = Buffer.from(stdout, "utf8")
  const stderrBytes = Buffer.from(stderr, "utf8")
  if (stdoutBytes.byteLength > MAX_RETAINED_COMMAND_BYTES || stderrBytes.byteLength > MAX_RETAINED_COMMAND_BYTES) {
    throw new Error(`Release command ${id} output exceeds ${MAX_RETAINED_COMMAND_BYTES} retained bytes`)
  }
  return {
    evidence: CommandEvidenceSchema.parse({
      id, argv: [executable, ...args], cwd, exit_code: timedOut || commandError || cleanupError ? 1 : exitCode ?? 1,
      stdout_bytes: stdoutBytes.byteLength, stdout_sha256: sha256(stdoutBytes), stdout,
      stderr_bytes: stderrBytes.byteLength, stderr_sha256: sha256(stderrBytes), stderr,
    }),
    stdout, stderr,
    supervision: { duration_ms: Math.round(performance.now() - started), deadline_ms: deadlineMs, signal,
      timed_out: timedOut, output_exceeded: outputExceeded, error: commandError, cleanup_error: cleanupError },
  }
}

function requireSuccess(result: Captured): Captured {
  if (result.evidence.exit_code !== 0) throw new Error(`Release command ${result.evidence.id} failed: ${result.supervision.error ?? (result.supervision.timed_out ? "deadline exceeded" : boundedReleaseTail(result.stderr || result.stdout))}`)
  return result
}

/** Failed attempts have a separate bounded format and can never be success evidence. */
export function writeReleaseFailure(directory: string, releaseInputs: ReleaseEvidence["release_inputs"], attempts: Captured[], failure: unknown, cleanupErrors: string[]) {
  const path = join(externalEvidenceDirectory(directory), `release-failed-${releaseInputs.sha256.slice(0, 16)}-${randomUUID()}.json`)
  const record = {
    schema_version: 1, kind: "opencode-alg-release-failed-attempt", passed: false,
    generated_at: new Date().toISOString(), release_inputs: releaseInputs,
    original_failure: boundedReleaseTail(failure instanceof Error ? failure.message : String(failure)),
    attempts: attempts.map(({ evidence, supervision }) => {
      const { stdout, stderr, ...identity } = evidence
      return { ...identity, argv: identity.argv.map(redactReleaseText), supervision,
        stdout_tail: boundedReleaseTail(stdout), stderr_tail: boundedReleaseTail(stderr) }
    }),
    cleanup_errors: cleanupErrors.map((error) => boundedReleaseTail(error)),
  }
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
  if (attempts.length > RELEASE_COMMAND_IDS.length || bytes.byteLength > MAX_EVIDENCE_BYTES) throw new Error("failed release evidence exceeds bounds")
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 })
  const retained = readFileSync(path)
  if (!retained.equals(bytes)) throw new Error("failed release evidence changed during retention")
  return { path, bytes: retained.byteLength, sha256: sha256(retained) }
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

export async function runReleaseGate(args = process.argv.slice(2)): Promise<{ evidence: ReleaseEvidence; retained: { path: string; sha256: string; bytes: number; identity: EvidenceFileIdentity } }> {
  const evidenceDir = externalEvidenceDirectory(argument(args, "--evidence-dir"))
  if (repositoryReleaseArtifacts(ROOT).length) throw new Error(`Repository contains generated release artifacts: ${repositoryReleaseArtifacts(ROOT).join(", ")}`)
  const helperArtifactsBefore = windowsShellHelperArtifactSnapshot()
  const releaseInputsBefore = computeReleaseInputIdentity(ROOT)
  const commands: ReleaseEvidence["commands"] = []
  const attempts: Captured[] = []
  const cleanupErrors: string[] = []
  const capture = (result: Captured) => { attempts.push(result); commands.push(result.evidence); return requireSuccess(result) }
  try {
  const bun = process.execPath
  const python = pathExecutable(process.platform === "win32" ? "python.exe" : "python3")
  capture(await runReleaseCommand("typecheck", bun, ["run", "typecheck"]))
  const tests = capture(await runReleaseCommand("bun_test", bun, ["test", "--timeout", "60000"]))
  const managerTests = capture(await runReleaseCommand("manager_tests", bun, ["test", "tests/manager.test.ts", "--timeout", "60000"]))
  capture(await runReleaseCommand("smoke", bun, ["run", "smoke"]))
  const live = finalJsonLine(capture(await runReleaseCommand("live_verify", bun, ["run", "check:live"])).stdout)
  const manifest = finalJsonLine(capture(await runReleaseCommand("excel_manifest", bun, ["run", "check:excel-manifest"])).stdout)
  const duckdbManifest = finalJsonLine(capture(await runReleaseCommand("duckdb_manifest", bun, ["run", "check:duckdb-manifest"])).stdout)
  const pythonTests = capture(await runReleaseCommand("python_tests", python, ["-m", "unittest", "discover", "-s", "tests/python", "-v"], ROOT, { PYTHONDONTWRITEBYTECODE: "1" }))

  const temp = mkdtempSync(join(tmpdir(), "opencode-alg-excel-release-gate-"))
  const envPath = join(temp, "env")
  const workbookRoot = join(temp, "workbooks")
  mkdirSync(workbookRoot)
  let wrapperCheck: any
  let eofStdoutBytes = -1
  try {
    capture(await runReleaseCommand("excel_uv_sync", pathExecutable(process.platform === "win32" ? "uv.exe" : "uv"), ["sync", "--frozen", "--no-dev"], join(ROOT, "capabilities", "excel"), {
      UV_PROJECT_ENVIRONMENT: envPath, UV_NO_PROGRESS: "1", PYTHONDONTWRITEBYTECODE: "1",
    }))
    const interpreter = process.platform === "win32" ? join(envPath, "Scripts", "python.exe") : join(envPath, "bin", "python")
    const wrapper = join(ROOT, "capabilities", "excel", "wrapper.py")
    const runtimeEnv = { ALG_EXCEL_ROOT: workbookRoot, PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONUTF8: "1" }
    wrapperCheck = finalJsonLine(capture(await runReleaseCommand("excel_wrapper_check", interpreter, [wrapper, "--check"], ROOT, runtimeEnv)).stdout)
    const eof = capture(await runReleaseCommand("excel_wrapper_eof", interpreter, [wrapper], ROOT, runtimeEnv, Buffer.alloc(0)))
    eofStdoutBytes = eof.evidence.stdout_bytes
    if (eofStdoutBytes !== 0) throw new Error("Excel wrapper emitted pre-handshake stdout")
  } finally {
    try { rmSync(temp, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(boundedReleaseTail(String(error))) }
  }

  const duckdbTemp = mkdtempSync(join(tmpdir(), "opencode-alg-duckdb-release-gate-"))
  const duckdbEnvPath = join(duckdbTemp, "env")
  let duckdbPreflight: any
  let duckdbEofStdoutBytes = -1
  let duckdbPythonTests: Captured
  try {
    capture(await runReleaseCommand("duckdb_uv_sync", pathExecutable(process.platform === "win32" ? "uv.exe" : "uv"), ["sync", "--frozen", "--no-dev"], join(ROOT, "capabilities", "duckdb"), {
      UV_PROJECT_ENVIRONMENT: duckdbEnvPath, UV_NO_PROGRESS: "1", PYTHONDONTWRITEBYTECODE: "1",
    }))
    const interpreter = process.platform === "win32" ? join(duckdbEnvPath, "Scripts", "python.exe") : join(duckdbEnvPath, "bin", "python")
    const wrapper = join(ROOT, "capabilities", "duckdb", "wrapper.py")
    const contract = join(ROOT, "capabilities", "duckdb", "contract.example.json")
    const contractHash = JSON.parse(readFileSync(contract, "utf8")).contract_sha256 as string
    const runtimeEnv = { PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONUTF8: "1" }
    duckdbPythonTests = capture(await runReleaseCommand("duckdb_python_tests", interpreter, [join(ROOT, "tests", "python", "test_duckdb_capability.py"), "-v"], ROOT, runtimeEnv))
    duckdbPreflight = finalJsonLine(capture(await runReleaseCommand("duckdb_wrapper_preflight", interpreter, [wrapper, "--preflight", "--contract", contract, "--hash", contractHash], ROOT, runtimeEnv)).stdout)
    const eof = capture(await runReleaseCommand("duckdb_wrapper_eof", interpreter, [wrapper, "--mcp", "--contract", contract, "--hash", contractHash], ROOT, runtimeEnv, Buffer.alloc(0)))
    duckdbEofStdoutBytes = eof.evidence.stdout_bytes
    if (duckdbEofStdoutBytes !== 0) throw new Error("DuckDB wrapper emitted pre-handshake stdout")
  } finally {
    try { rmSync(duckdbTemp, { recursive: true, force: true }) } catch (error) { cleanupErrors.push(boundedReleaseTail(String(error))) }
  }
  if (cleanupErrors.length) throw new Error(`Release environment cleanup failed: ${cleanupErrors.join("; ")}`)
  const npm = resolveNpmInvocation()
  const pack = JSON.parse(capture(await runReleaseCommand("npm_pack", npm.executable, [...npm.argsPrefix, "pack", "--dry-run", "--json"])).stdout)[0]
  const packageInventory = validatePackedInventory(pack.files)
  const capabilityFiles = pack.files.filter((file: any) => /^capabilities\/(?:duckdb|excel)\//.test(file.path)).map((file: any) => file.path).sort()
  const expectedCapabilityFiles = [
    "capabilities/excel/manifest.json", "capabilities/excel/policy.py", "capabilities/excel/pyproject.toml",
    "capabilities/excel/uv.lock", "capabilities/excel/workbook.py", "capabilities/excel/wrapper.py",
    ...[...DUCKDB_CAPABILITY_FILES, "manifest.json"].map((name) => `capabilities/duckdb/${name}`),
  ].sort()
  if (JSON.stringify(capabilityFiles) !== JSON.stringify(expectedCapabilityFiles)) throw new Error("npm pack capability inventory is not the exact reviewed Excel and DuckDB contract")
  const capabilityModes = pack.files.filter((file: any) => /^capabilities\/(?:duckdb|excel)\//.test(file.path)).map((file: any) => file.mode)
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
  const duckdbPythonTotals = parsedPythonTotals(duckdbPythonTests!.evidence, "duckdb_python")
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
    schema_version: 6, kind: "opencode-alg-release-gate", generated_at: new Date().toISOString(), package_version: "0.4.0",
    source: { sha256: source.digest, files: source.file_count, bytes: source.total_bytes }, release_inputs: releaseInputsAfter, commands,
    totals: { ...bunTotals, ...managerTotals, ...pythonTotals, ...duckdbPythonTotals },
    excel: { manifest_sha256: manifest.manifest_sha256, lock_sha256: manifest.files.lock, version: wrapperCheck.version, tool_count: wrapperCheck.tool_count, eof_stdout_bytes: eofStdoutBytes },
    duckdb: { manifest_sha256: duckdbManifest.manifest_sha256, lock_sha256: duckdbManifest.files["uv.lock"], version: duckdbPreflight.compatibility.capability_version, engine_version: duckdbPreflight.compatibility.engine_version, parser_version: duckdbPreflight.compatibility.parser_version, tool_count: 1, eof_stdout_bytes: duckdbEofStdoutBytes, contract_sha256: duckdbPreflight.compatibility.contract_sha256 },
    package: { entries: pack.entryCount, packed_bytes: pack.size, unpacked_bytes: pack.unpackedSize, files: pack.files.map((file: any) => ({ path: file.path, size: file.size, mode: file.mode })).sort((a: any, b: any) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0), inventory_sha256: packageInventory.sha256, capability_files: capabilityFiles, lock_bytes: { excel: statSync(join(ROOT, "capabilities", "excel", "uv.lock")).size, duckdb: statSync(join(ROOT, "capabilities", "duckdb", "uv.lock")).size }, tgz_created: tgzCreated },
    live: { passed: live.passed, evidence_path: live.evidence_path, evidence_sha256: live.evidence_sha256, evidence_bytes: live.evidence_bytes, evidence_identity: live.evidence_identity, source_sha256: live.source_sha256, user_global_config_modified: live.user_global_config_modified, global_config_snapshot_sha256: live.global_config_snapshot_sha256, temporary_environment_removed: live.temporary_environment_removed },
    cleanup: { temporary_excel_environment_removed: !existsSync(temp), temporary_duckdb_environment_removed: !existsSync(duckdbTemp), repository_artifacts_absent: repositoryReleaseArtifacts(ROOT).length === 0, helper_owned_before: helperArtifactsBefore.length, helper_owned_after: helperArtifactsAfter.length, helper_net_additions: 0 },
    passed: true,
  })
  validateReleaseEvidenceSemantics(evidence, ROOT)
  const written = writeReleaseEvidence(evidenceDir, evidence)
  const retained = verifyRetainedReleaseEvidence(written.path, written, ROOT)
  return { evidence: retained.evidence, retained: { path: retained.path, sha256: retained.sha256, bytes: retained.bytes, identity: retained.identity } }
  } catch (error) {
    try {
      const before = new Set(helperArtifactsBefore.map((path) => resolve(path)))
      const additions = windowsShellHelperArtifactSnapshot().filter((path) => !before.has(resolve(path)))
      cleanupWindowsShellHelpers({ candidates: additions, minimumAgeMs: 0 })
      const remaining = windowsShellHelperArtifactSnapshot().filter((path) => !before.has(resolve(path)))
      if (remaining.length) cleanupErrors.push(`Windows helper artifacts remain: ${remaining.join(", ")}`)
    } catch (cleanupError) { cleanupErrors.push(boundedReleaseTail(String(cleanupError))) }
    let failurePath: string
    try {
      failurePath = writeReleaseFailure(evidenceDir, releaseInputsBefore, attempts, error, cleanupErrors).path
    } catch (publicationError) {
      throw new AggregateError([error, publicationError], `Release failed; failure evidence publication also failed: ${boundedReleaseTail(String(error))}`)
    }
    throw new Error(`Release failed; retained diagnostics: ${failurePath}; ${boundedReleaseTail(String(error))}`, { cause: error })
  }
}

if (import.meta.main) {
  try {
    const result = await runReleaseGate()
    console.log(JSON.stringify({ passed: true, ...result.retained, source_sha256: result.evidence.source.sha256 }))
  } catch (error) {
    console.error(redactReleaseText(error instanceof Error ? error.message : String(error)))
    process.exitCode = 1
  }
}

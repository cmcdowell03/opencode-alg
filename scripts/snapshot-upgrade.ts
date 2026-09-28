/**
 * Development-snapshot install/upgrade helper for machines with existing ALG state.
 * Every subcommand is one step of docs/agent-install-upgrade-runbook.md. Only `backup`,
 * `install`, and `repoint` write, and none of them deletes or overwrites existing data.
 */
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, join, parse as parsePath, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { resolveNpmInvocation } from "./npm-invocation.ts"

const STORES = ["runs", "skill-evolution", "session-memory", "experience", "environment-memory"] as const
const HOME = homedir()
const configDir = () => process.env.OPENCODE_CONFIG_DIR ?? join(HOME, ".config", "opencode")
const dataDir = () => join(HOME, ".local", "share")
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
const readJsonc = (path: string): any => {
  const errors: ParseError[] = []
  const value = parseJsonc(readFileSync(path, "utf8").replace(/^﻿/, ""), errors, { allowTrailingComma: true })
  if (errors.length) throw new Error(`${path} does not parse as JSONC`)
  return value
}
const specOf = (entry: unknown) => (Array.isArray(entry) ? entry[0] : entry) as string
function packageNameOf(spec: string): string | null {
  if (!spec.startsWith("file:")) return spec.includes("opencode-alg") ? "opencode-alg" : null
  try { return JSON.parse(readFileSync(join(fileURLToPath(spec), "package.json"), "utf8")).name ?? null } catch { return null }
}
function walkFiles(root: string, visit: (path: string) => void) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) walkFiles(path, visit)
    else if (entry.isFile()) visit(path)
  }
}

function openCodeRunning(): boolean {
  const result = process.platform === "win32"
    ? spawnSync("tasklist", ["/FI", "IMAGENAME eq opencode.exe", "/NH"], { encoding: "utf8" })
    : spawnSync("pgrep", ["-x", "opencode"], { encoding: "utf8" })
  return process.platform === "win32" ? /opencode\.exe/i.test(result.stdout ?? "") : result.status === 0
}

/** ALG binds state to ctx.worktree || directory; OpenCode's global project uses "/", i.e. a drive root. */
async function stateRoots(): Promise<string[]> {
  const candidates = new Set<string>([HOME])
  const db = join(dataDir(), "opencode", "opencode.db")
  if (existsSync(db)) {
    const { Database } = await import("bun:sqlite")
    const handle = new Database(db, { readonly: true })
    try {
      for (const row of handle.query("SELECT DISTINCT directory FROM session").all() as { directory: string }[]) {
        candidates.add(row.directory)
        candidates.add(parsePath(resolve(row.directory)).root)
      }
      for (const row of handle.query("SELECT worktree FROM project").all() as { worktree: string }[]) {
        if (row.worktree && row.worktree !== "/") candidates.add(row.worktree)
      }
    } finally { handle.close() }
  }
  return [...candidates].map((path) => resolve(path)).filter((root, index, all) => all.indexOf(root) === index &&
    (STORES.some((store) => existsSync(join(root, ".opencode", store))) || existsSync(join(root, ".opencode", "alg-models.json")))).sort()
}

async function inventory() {
  const registrations: Record<string, unknown[]> = {}
  for (const name of ["opencode.jsonc", "opencode.json", "tui.json"]) {
    const path = join(configDir(), name)
    if (!existsSync(path)) continue
    registrations[name] = ((readJsonc(path).plugin ?? []) as unknown[]).filter((entry) => packageNameOf(specOf(entry)) === "opencode-alg")
  }
  const roots = await stateRoots()
  const stores = Object.fromEntries(roots.map((root) => [root, Object.fromEntries(STORES.filter((store) => existsSync(join(root, ".opencode", store)))
    .map((store) => { let files = 0; walkFiles(join(root, ".opencode", store), () => files++); return [store, files] }))]))
  const snapshots = join(dataDir(), "opencode-alg", "development")
  return {
    opencode_running: openCodeRunning(), config_dir: configDir(), registrations, state_roots: stores,
    managed_receipt: existsSync(join(configDir(), ".opencode-alg", "receipt.json")),
    development_snapshots: existsSync(snapshots) ? readdirSync(snapshots).sort() : [],
  }
}

type ManifestEntry = { source: string; backup: string; sha256: string }
function backup(target: string, roots: string[]) {
  if (existsSync(target)) throw new Error(`backup target already exists: ${target}`)
  const entries: ManifestEntry[] = []
  const copy = (source: string, destination: string) => {
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(source, destination, { recursive: true, preserveTimestamps: true, errorOnExist: true, force: false })
    const record = (file: string) => entries.push({ source: file, backup: join(destination, file.slice(source.length)), sha256: sha256(readFileSync(file)) })
    if (statSync(source).isDirectory()) walkFiles(source, record); else record(source)
  }
  for (const name of ["opencode.jsonc", "opencode.json", "tui.json"]) {
    if (existsSync(join(configDir(), name))) copy(join(configDir(), name), join(target, "config", name))
  }
  for (const root of roots) {
    const label = root.replace(/[:\\/]+/g, "_").replace(/^_+|_+$/g, "") || "root"
    for (const store of STORES) if (existsSync(join(root, ".opencode", store))) copy(join(root, ".opencode", store), join(target, "state", label, store))
    for (const file of existsSync(join(root, ".opencode")) ? readdirSync(join(root, ".opencode")).filter((name) => name.startsWith("alg-models.json")) : []) {
      copy(join(root, ".opencode", file), join(target, "state", label, file))
    }
  }
  writeFileSync(join(target, "MANIFEST.json"), `${JSON.stringify({ created_at: new Date().toISOString(), roots, entries }, null, 2)}\n`)
  const bad = entries.filter((entry) => sha256(readFileSync(entry.backup)) !== entry.sha256)
  if (bad.length) throw new Error(`backup verification failed for ${bad.length} files`)
  return { backup: target, files: entries.length, verified: true }
}

function checkBackup(target: string) {
  const manifest = JSON.parse(readFileSync(join(target, "MANIFEST.json"), "utf8")) as { roots: string[]; entries: ManifestEntry[] }
  const changed: string[] = [], missing: string[] = []
  for (const entry of manifest.entries) {
    if (!existsSync(entry.source)) missing.push(entry.source)
    else if (sha256(readFileSync(entry.source)) !== entry.sha256) changed.push(entry.source)
  }
  const known = new Set(manifest.entries.map((entry) => resolve(entry.source)))
  const added: string[] = []
  for (const root of manifest.roots) for (const store of STORES) {
    const directory = join(root, ".opencode", store)
    if (existsSync(directory)) walkFiles(directory, (file) => { if (!known.has(resolve(file))) added.push(file) })
  }
  return { files: manifest.entries.length, changed, missing, added: added.length, added_sample: added.slice(0, 10) }
}

async function pack(repo: string, commit: string, out: string) {
  mkdirSync(out, { recursive: true })
  const worktree = mkdtempSync(join(tmpdir(), "alg-pack-"))
  rmSync(worktree, { recursive: true })
  const git = (...args: string[]) => {
    const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" })
    if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`)
    return result.stdout.trim()
  }
  const full = git("rev-parse", "--verify", `${commit}^{commit}`)
  git("worktree", "add", "--detach", worktree, full)
  try {
    const npm = resolveNpmInvocation()
    const packed = spawnSync(npm.executable, [...npm.argsPrefix, "pack", "--ignore-scripts", "--json", "--pack-destination", out], { cwd: worktree, encoding: "utf8" })
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`)
    const meta = JSON.parse(packed.stdout)[0]
    const gate = await import(pathToFileURL(join(repo, "scripts", "release-gate.ts")).href)
    const checked = gate.validatePackedInventory(meta.files, gate.expectedPackedPaths(worktree))
    const tarball = join(out, meta.filename)
    return { commit: full, tarball, tarball_sha256: sha256(readFileSync(tarball)), files: checked.paths.length, inventory_sha256: checked.sha256, version: meta.version }
  } finally { git("worktree", "remove", "--force", worktree) }
}

function install(tarball: string, commit: string, snapshotsRoot = join(dataDir(), "opencode-alg", "development")) {
  const digest = sha256(readFileSync(tarball))
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "")
  const id = `${date}-${digest.slice(0, 12)}`
  const directory = join(snapshotsRoot, id)
  if (existsSync(directory)) throw new Error(`snapshot already exists: ${directory}`)
  mkdirSync(directory, { recursive: true })
  // A relative archive name avoids GNU tar treating a drive letter as a remote host.
  copyFileSync(tarball, join(directory, basename(tarball)))
  const extracted = spawnSync("tar", ["-xzf", basename(tarball)], { cwd: directory, encoding: "utf8" })
  if (extracted.status !== 0) throw new Error(`tar failed: ${extracted.stderr}`)
  const packageRoot = join(directory, "package")
  const npm = resolveNpmInvocation()
  const installed = spawnSync(npm.executable, [...npm.argsPrefix, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: packageRoot, encoding: "utf8" })
  if (installed.status !== 0) throw new Error(`npm ci failed: ${installed.stderr}`)
  const version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version
  writeFileSync(join(directory, "snapshot.json"), `${JSON.stringify({ schema_version: 1, snapshot_id: id, source_commit: commit, package_version: version,
    tarball: basename(tarball), tarball_sha256: digest, dependency_install: "npm ci --omit=dev --ignore-scripts", created_at: new Date().toISOString() }, null, 2)}\n`)
  return { snapshot_id: id, package_root: packageRoot, spec: pathToFileURL(packageRoot).href }
}

async function parseState(packageRoot: string, roots: string[]) {
  const schemas = await import(pathToFileURL(join(packageRoot, "src", "schemas.ts")).href)
  const evolution = await import(pathToFileURL(join(packageRoot, "src", "skill-evolution-schemas.ts")).href)
  const report: Record<string, Record<string, number>> = {}
  const failures: string[] = []
  const check = (root: string, kind: string, file: string, parse: (value: unknown) => unknown) => {
    const counts = (report[root] ??= {})
    try { parse(JSON.parse(readFileSync(file, "utf8"))); counts[`${kind}:ok`] = (counts[`${kind}:ok`] ?? 0) + 1 }
    catch (error) { counts[`${kind}:FAIL`] = (counts[`${kind}:FAIL`] ?? 0) + 1; failures.push(`${file}: ${error instanceof Error ? error.message.slice(0, 200) : error}`) }
  }
  for (const root of roots) {
    const runs = join(root, ".opencode", "runs")
    if (existsSync(runs)) for (const id of readdirSync(runs).filter((name) => !name.startsWith("_"))) {
      const progress = join(runs, id, "progress.json")
      if (existsSync(progress)) check(root, "run", progress, schemas.parseRunStateForProjection)
    }
    const evidence = join(root, ".opencode", "skill-evolution", "evidence")
    if (existsSync(evidence)) for (const file of readdirSync(evidence)) check(root, "evidence", join(evidence, file), (value) => evolution.SkillEvidenceSchema.parse(value))
    const ledger = join(root, ".opencode", "skill-evolution", "ledger.json")
    if (existsSync(ledger)) check(root, "ledger", ledger, (value: any) => value.records.map((record: unknown) => evolution.SkillLedgerRecordSchema.parse(record)))
  }
  return { report, failures: failures.slice(0, 20), ok: failures.length === 0 }
}

/** Compare-and-swap edit: only the plugin spec string changes, and only if each file still matches the backup. */
function repoint(backupDir: string, oldSpec: string, newSpec: string) {
  const changed: string[] = []
  for (const name of ["opencode.jsonc", "opencode.json", "tui.json"]) {
    const path = join(configDir(), name)
    if (!existsSync(path)) continue
    const current = readFileSync(path, "utf8")
    if (!existsSync(join(backupDir, "config", name)) || current !== readFileSync(join(backupDir, "config", name), "utf8")) {
      throw new Error(`${name} is missing from the backup or changed since it was taken`)
    }
    const count = current.split(oldSpec).length - 1
    if (count === 0) continue
    if (count !== 1) throw new Error(`${name}: expected one occurrence of the old spec, found ${count}`)
    const next = current.replace(oldSpec, newSpec)
    const before = parseJsonc(current.replace(/^﻿/, ""), [], { allowTrailingComma: true })
    const errors: ParseError[] = []
    const after = parseJsonc(next.replace(/^﻿/, ""), errors, { allowTrailingComma: true })
    const index = (before.plugin as unknown[] ?? []).findIndex((entry) => specOf(entry) === oldSpec)
    if (errors.length || index < 0 || specOf(after.plugin[index]) !== newSpec) throw new Error(`${name}: the old spec is not a plugin entry`)
    const options = (value: any) => JSON.stringify(Array.isArray(value.plugin[index]) ? value.plugin[index][1] : null)
    const rest = ({ plugin: _plugin, ...value }: any) => JSON.stringify(value)
    if (options(before) !== options(after) || rest(before) !== rest(after)) throw new Error(`${name}: edit would change more than the plugin spec`)
    const temporary = `${path}.alg-repoint-${randomUUID()}.tmp`
    writeFileSync(temporary, next, "utf8")
    renameSync(temporary, path)
    changed.push(name)
  }
  if (!changed.length) throw new Error("no configuration file registers the old spec")
  return { changed, spec: newSpec }
}

/** Starts a throwaway `opencode serve` in an isolated git project and reports what actually loaded. */
async function verify(outFile: string) {
  const project = mkdtempSync(join(tmpdir(), "alg-verify-"))
  spawnSync("git", ["init", "-q"], { cwd: project })
  const port = 40_000 + Math.floor(Math.random() * 9_000)
  const server = spawn("opencode", ["serve", "--port", String(port)], { cwd: project, shell: process.platform === "win32", stdio: "ignore" })
  const base = `http://127.0.0.1:${port}`
  const get = async (path: string) => {
    const response = await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}directory=${encodeURIComponent(project)}`)
    if (!response.ok) throw new Error(`GET ${path} -> ${response.status}`)
    return response.json() as Promise<any>
  }
  try {
    for (let attempt = 0; ; attempt++) {
      try { await get("/config"); break } catch { if (attempt > 120) throw new Error("opencode serve did not become ready"); await Bun.sleep(500) }
    }
    const ids = await get("/experimental/tool/ids") as string[]
    const config = await get("/config")
    const schemas = await get("/experimental/tool?provider=anthropic&model=verification") as any[]
    const alg = schemas.filter((tool) => String(tool.id).startsWith("alg_")).sort((a, b) => String(a.id).localeCompare(String(b.id)))
    const result = {
      alg_tools: ids.filter((id) => id.startsWith("alg_")), total_tools: ids.length,
      alg_registrations: ((config.plugin ?? []) as unknown[]).filter((entry) => packageNameOf(specOf(entry)) === "opencode-alg"),
      alg_schema_sha256: sha256(JSON.stringify(alg.map((tool) => [tool.id, tool.parameters]))),
    }
    writeFileSync(outFile, `${JSON.stringify(result, null, 2)}\n`)
    return result
  } finally {
    if (process.platform === "win32" && server.pid) spawnSync("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" })
    else server.kill()
    await Bun.sleep(500)
    // The server may still hold handles briefly on Windows; a leftover temp project is harmless.
    try { rmSync(project, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }) } catch { /* best effort */ }
  }
}

const USAGE = `ALG development-snapshot upgrade helper (see docs/agent-install-upgrade-runbook.md)

  bun scripts/snapshot-upgrade.ts inventory
  bun scripts/snapshot-upgrade.ts backup <new-backup-dir>
  bun scripts/snapshot-upgrade.ts check-backup <backup-dir>
  bun scripts/snapshot-upgrade.ts pack <repo-dir> <commit> <out-dir>
  bun scripts/snapshot-upgrade.ts install <tarball> <commit> [snapshots-root]
  bun scripts/snapshot-upgrade.ts parse-state <package-root>
  bun scripts/snapshot-upgrade.ts repoint <backup-dir> <old-spec> <new-spec>
  bun scripts/snapshot-upgrade.ts verify <out.json>`

export async function main(argv: string[]): Promise<unknown> {
  const [command, ...args] = argv
  const need = (count: number) => { if (args.length < count) throw new Error(USAGE) }
  switch (command) {
    case "inventory": return inventory()
    case "backup": need(1); return backup(resolve(args[0]!), await stateRoots())
    case "check-backup": need(1); return checkBackup(resolve(args[0]!))
    case "pack": need(3); return pack(resolve(args[0]!), args[1]!, resolve(args[2]!))
    case "install": need(2); return install(resolve(args[0]!), args[1]!, args[2] ? resolve(args[2]) : undefined)
    case "parse-state": need(1); return parseState(resolve(args[0]!), await stateRoots())
    case "repoint": need(3); return repoint(resolve(args[0]!), args[1]!, args[2]!)
    case "verify": need(1); return verify(resolve(args[0]!))
    default: throw new Error(USAGE)
  }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await main(process.argv.slice(2)), null, 2)) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}

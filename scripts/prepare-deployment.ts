import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { computeProductionDependencyIdentity, verifyBundleProductionDependencies } from "./manager-core.ts"
import { currentLibcIdentity, inventoryDeploymentTree, sealBundleManifest, sha256 } from "./deployment.ts"
import { resolveNpmInvocation } from "./npm-invocation.ts"
import { canonicalRootPath } from "../src/paths.ts"

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "unknown error").trim()}`)
  return (result.stdout ?? "").trim()
}

const MAX_SOURCE_BLOB_BYTES = 64 * 1024 * 1024
const MAX_SOURCE_TOTAL_BYTES = 128 * 1024 * 1024
interface CommittedEntry { path: string; oid: string; mode: string; size: number }

function gitBytes(source: string, args: string[], maxBuffer: number, input?: Buffer): Buffer {
  const result = spawnSync("git", ["-C", source, ...args], { cwd: source, input, encoding: "buffer", shell: false, windowsHide: true, maxBuffer })
  if (result.error || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").slice(0, 2048) : result.error?.message ?? "unknown error"
    throw new Error(`Pinned Git object read failed: ${detail.trim()}`)
  }
  return result.stdout
}

function utf8(bytes: Buffer, label: string): string {
  const value = bytes.toString("utf8")
  if (!Buffer.from(value, "utf8").equals(bytes)) throw new Error(`Pinned Git ${label} is not valid UTF-8`)
  return value
}

function committedTree(source: string, commit: string): CommittedEntry[] {
  const output = gitBytes(source, ["ls-tree", "-r", "-l", "-z", "--full-tree", commit], 32 * 1024 * 1024)
  const entries: CommittedEntry[] = []
  let cursor = 0
  while (cursor < output.length) {
    const end = output.indexOf(0, cursor)
    if (end < 0) throw new Error("Pinned Git tree has an unterminated entry")
    const row = output.subarray(cursor, end)
    const tab = row.indexOf(9)
    const header = tab < 0 ? "" : row.subarray(0, tab).toString("ascii")
    const match = /^(100644|100755|120000|160000) (blob|commit) ([a-f0-9]{40,64}) +([0-9]+|-)$/ .exec(header)
    if (!match) throw new Error("Pinned Git tree has an unsupported entry")
    const path = utf8(row.subarray(tab + 1), "tree path")
    if (!path || Buffer.byteLength(path, "utf8") > 4096) throw new Error("Pinned Git tree path is empty or oversized")
    entries.push({ path, mode: match[1]!, oid: match[3]!, size: match[4] === "-" ? -1 : Number(match[4]) })
    if (entries.length > 50_000) throw new Error("Pinned Git tree exceeds 50000 entries")
    cursor = end + 1
  }
  return entries
}

function committedBlob(source: string, entry: CommittedEntry, limit: number): Buffer {
  if (entry.mode === "160000" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limit) {
    throw new Error(`Pinned Git blob is unsupported or oversized: ${entry.path}`)
  }
  const bytes = gitBytes(source, ["cat-file", "blob", entry.oid], limit + 1024)
  if (bytes.length !== entry.size) throw new Error(`Pinned Git blob size changed: ${entry.path}`)
  return bytes
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`))
}

/** Materialize only committed distributable blobs; never read worktree payload bytes. */
function copyCommittedPackage(source: string, commit: string, stage: string): Record<string, any> {
  const tree = committedTree(source, commit)
  const packageEntry = tree.find((entry) => entry.path === "package.json")
  if (!packageEntry || packageEntry.mode !== "100644" && packageEntry.mode !== "100755") throw new Error("Pinned commit has no regular package.json")
  const pkg = JSON.parse(utf8(committedBlob(source, packageEntry, 1024 * 1024), "package.json")) as Record<string, any>
  if (pkg.name !== "opencode-alg" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Source package identity is invalid")
  if (!Array.isArray(pkg.files)) throw new Error("Package files declaration is missing or invalid")
  const declarations = ["package.json", "package-lock.json", "npm-shrinkwrap.json", ...pkg.files]
  const patterns = declarations.map((item: unknown) => {
    if (typeof item !== "string") throw new Error("Package files declaration contains a non-string entry")
    const normalized = item.replace(/^(\.\/)+/, "").replace(/\/$/, "")
    const parts = normalized.split("/")
    if (!normalized || parts.some((part) => !part || part === "." || part === ".." || /[\\\0[\]{}!]/.test(part))) {
      throw new Error("Package files declaration contains an unsafe or unsupported pattern")
    }
    if (!normalized.includes("*") && !normalized.includes("?")) return (path: string) => path === normalized || path.startsWith(normalized + "/")
    const expression = parts.map((part, index) => {
      if (part === "**") return index === parts.length - 1 ? ".*" : "(?:[^/]+/)*"
      const segment = [...part].map((char) => char === "*" ? "[^/]*" : char === "?" ? "[^/]" : char.replace(/[.*+?^$()|\\]/g, "\\$&")).join("")
      return segment + (index === parts.length - 1 ? "" : "/")
    }).join("")
    const pattern = new RegExp("^" + expression + "$")
    return (path: string) => pattern.test(path)
  })
  const selected = tree.filter((entry) => !entry.path.startsWith(".git/") && !entry.path.startsWith("node_modules/") && patterns.some((matches) => matches(entry.path)))
  if (!selected.some((entry) => entry.path === "package-lock.json")) throw new Error("Pinned commit has no package-lock.json")
  const folded = new Set<string>()
  let total = 0
  for (const entry of selected) {
    const parts = entry.path.split("/")
    if (entry.path === "alg-bundle.json" || parts.some((part) => !part || part === "." || part === ".." || /[\\\0]/.test(part))) {
      throw new Error(`Pinned Git tree contains an unsafe bundle path: ${entry.path}`)
    }
    const key = entry.path.normalize("NFC").toLowerCase()
    if (folded.has(key)) throw new Error(`Pinned Git tree contains an ambiguous bundle path: ${entry.path}`)
    folded.add(key)
    if (entry.mode !== "100644" && entry.mode !== "100755" && entry.mode !== "120000") throw new Error(`Pinned Git tree contains an unsupported bundle entry: ${entry.path}`)
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_SOURCE_BLOB_BYTES || (total += entry.size) > MAX_SOURCE_TOTAL_BYTES) {
      throw new Error("Pinned Git distributable blobs exceed source bounds")
    }
  }
  const input = Buffer.from(selected.map((entry) => `${entry.oid}\n`).join(""), "ascii")
  const payload = gitBytes(source, ["cat-file", "--batch"], MAX_SOURCE_TOTAL_BYTES + selected.length * 128 + 1024, input)
  const links: string[] = []
  let cursor = 0
  for (const entry of selected) {
    const headerEnd = payload.indexOf(10, cursor)
    if (headerEnd < 0) throw new Error("Pinned Git batch has a truncated header")
    const header = payload.subarray(cursor, headerEnd).toString("ascii")
    const match = /^([a-f0-9]{40,64}) blob ([0-9]+)$/.exec(header)
    if (!match || match[1] !== entry.oid || Number(match[2]) !== entry.size) throw new Error(`Pinned Git batch identity differs for ${entry.path}`)
    const end = headerEnd + 1 + entry.size
    if (end >= payload.length || payload[end] !== 10) throw new Error(`Pinned Git batch is truncated for ${entry.path}`)
    const bytes = payload.subarray(headerEnd + 1, end)
    cursor = end + 1
    const to = join(stage, ...entry.path.split("/"))
    mkdirSync(dirname(to), { recursive: true })
    if (entry.mode === "120000") {
      const target = utf8(bytes, "symlink target")
      if (!target || target.includes("\0") || target.includes("\\") || isAbsolute(target) || !inside(stage, resolve(dirname(to), target))) {
        throw new Error(`Pinned Git link escapes the bundle: ${entry.path}`)
      }
      symlinkSync(target, to)
      links.push(to)
    } else {
      const mode = entry.mode === "100755" ? 0o755 : 0o644
      writeFileSync(to, bytes, { flag: "wx", mode })
      chmodSync(to, mode)
    }
  }
  if (cursor !== payload.length) throw new Error("Pinned Git batch has unexpected trailing bytes")
  const canonicalStage = realpathSync.native(stage)
  for (const link of links) {
    if (!inside(canonicalStage, realpathSync.native(link))) throw new Error(`Pinned Git link escapes the bundle: ${link}`)
  }
  return pkg
}

/** Move only the preparation-owned child into its otherwise empty output root.
 * This is not the manager's concurrent/no-clobber generation publication path.
 * Renaming preserves file identities and avoids copying npm's complete tree a
 * second time. All package/dependency verification still runs at the output.
 */
export function publishPreparedPackage(stage: string, output: string): void {
  if (!isAbsolute(stage) || !isAbsolute(output) || resolve(stage) !== join(resolve(output), ".package-stage")) {
    throw new Error("Preparation publication requires its own .package-stage child")
  }
  for (const directory of [output, stage]) {
    const stat = lstatSync(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(realpathSync.native(directory), directory) !== "") {
      throw new Error("Preparation publication directory is redirected")
    }
  }
  const outputNames = readdirSync(output)
  if (outputNames.length !== 1 || outputNames[0] !== ".package-stage") {
    throw new Error("Preparation output gained content; preserving the staging tree")
  }
  for (const name of readdirSync(stage)) {
    const destination = join(output, name)
    // The output was newly created for this preparation, never an installed
    // generation. Refuse unexpected content rather than overwrite it.
    try {
      lstatSync(destination)
      throw new Error(`Preparation output entry already exists: ${name}`)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    renameSync(join(stage, name), destination)
  }
  // A failed move or unexpected remaining entry stays available for inspection.
  // Never recursively delete an incomplete preparation tree.
  rmdirSync(stage)
}

export function prepareDeploymentBundle(sourceInput: string, outputInput: string): { output: string; manifestSha256: string; sourceCommit: string; artifactSha256: string } {
  if (!process.versions.bun && Number(process.versions.node.split(".")[0]) < 22) throw new Error("Bundle preparation requires Node.js 22 or newer")
  if (!isAbsolute(sourceInput) || !isAbsolute(outputInput)) throw new Error("Bundle source and output paths must be absolute")
  const source = realpathSync.native(resolve(sourceInput))
  const output = canonicalRootPath(resolve(outputInput))
  const insideSource = relative(source, output)
  const insideOutput = relative(output, source)
  const nested = (value: string) => value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`))
  if (!isAbsolute(output) || output === source || nested(insideSource) || nested(insideOutput)) {
    throw new Error("Bundle output must be an absolute directory outside and separate from the source checkout")
  }
  const status = run("git", ["-C", source, "status", "--porcelain=v1", "--untracked-files=all"], source)
  if (status) throw new Error("Preparation requires a clean source checkout")
  if (realpathSync.native(run("git", ["-C", source, "rev-parse", "--show-toplevel"], source)) !== source) {
    throw new Error("Preparation source must be the root of its own Git checkout")
  }
  const commit = run("git", ["-C", source, "rev-parse", "HEAD"], source).toLowerCase()
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Source checkout did not provide a valid immutable commit identity")
  const repository = run("git", ["-C", source, "config", "--get", "remote.origin.url"], source)
  if (existsSync(output)) throw new Error(`Bundle output already exists; refusing to overwrite: ${output}`)
  mkdirSync(output, { recursive: true })
  const stage = join(output, ".package-stage")
  mkdirSync(stage)
  try {
    const pkg = copyCommittedPackage(source, commit, stage)
    const frozenFiles = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock"]
      .filter((name) => existsSync(join(stage, name)))
      .map((name) => [name, sha256(readFileSync(join(stage, name)))] as const)
    const npm = resolveNpmInvocation()
    run(npm.executable, [...npm.argsPrefix, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage)
    for (const [name, expected] of frozenFiles) {
      if (sha256(readFileSync(join(stage, name))) !== expected) throw new Error(`Preparation dependency install modified frozen input ${name}`)
    }
    // Publish the package at the output root; the directory name is descriptive only.
    publishPreparedPackage(stage, output)
    const identity = computeProductionDependencyIdentity(output, Object.keys(pkg.dependencies ?? {}).sort())
    verifyBundleProductionDependencies(output, Object.keys(pkg.dependencies ?? {}).sort())
    const tree = inventoryDeploymentTree(output)
    const artifactSha256 = sha256(JSON.stringify(tree))
    const npmLockFile = existsSync(join(output, "npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : "package-lock.json"
    const manifest = sealBundleManifest({
      format: "opencode-alg-deployment-bundle", schema_version: 1,
      package: { name: "opencode-alg", version: pkg.version, release_tag: null, source_commit: commit, source_repository: repository, artifact_sha256: artifactSha256 },
      target: { platform: process.platform as "linux" | "win32" | "darwin", arch: process.arch, runtime: process.versions.bun ? "bun" : "node", node_major: process.versions.bun ? null : Number(process.versions.node.split(".")[0]), bun_major: process.versions.bun ? Number(process.versions.bun.split(".")[0]) : null, libc: currentLibcIdentity() },
      dependencies: {
        manager: "npm", mode: "production-offline-ready", npm_lock_file: npmLockFile,
        npm_lock_sha256: sha256(readFileSync(join(output, npmLockFile))),
        package_lock_sha256: sha256(readFileSync(join(output, "package-lock.json"))),
        bun_lock_sha256: existsSync(join(output, "bun.lock")) ? sha256(readFileSync(join(output, "bun.lock"))) : null,
        production_names: Object.keys(pkg.dependencies ?? {}).sort(), production_identity: identity, tree,
      },
      modes: { application: "OpenCode 1", minimum_host: pkg.engines?.opencode ?? ">=1.18.0 <2.0.0", maximum_host_exclusive: "2.0.0", install: "offline-no-install", trust: "explicit-manifest-sha256-approval" },
    })
    writeFileSync(join(output, "alg-bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 })
    return { output, manifestSha256: manifest.manifest_sha256, sourceCommit: commit, artifactSha256 }
  } catch (error) {
    // Leave failed evidence in place for inspection; never silently reuse an incomplete package.
    throw error
  }
}

const thisFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === resolve(thisFile)) {
  try {
    const args = process.argv.slice(2)
    const sourceIndex = args.indexOf("--source")
    const outputIndex = args.indexOf("--output")
    if (sourceIndex < 0 || outputIndex < 0 || !args[sourceIndex + 1] || !args[outputIndex + 1]) {
      throw new Error("Usage: bun run scripts/prepare-deployment.ts --source <clean-checkout> --output <new-absolute-directory>")
    }
    const result = prepareDeploymentBundle(args[sourceIndex + 1]!, args[outputIndex + 1]!)
    console.log(JSON.stringify({ ...result, release_tag: null, trust_note: "Review and retain manifestSha256 outside the bundle; checksum alone is not authentication." }, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

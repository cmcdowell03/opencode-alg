import { createHash } from "node:crypto"
import { constants, existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync, type BigIntStats } from "node:fs"
import { open } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { z } from "zod"

const Sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const Entry = z.discriminatedUnion("kind", [
  z.object({ path: z.string().min(1).max(4096), kind: z.literal("file"), mode: z.number().int(), sha256: Sha256 }).strict(),
  z.object({ path: z.string().min(1).max(4096), kind: z.literal("directory"), mode: z.number().int() }).strict(),
  z.object({ path: z.string().min(1).max(4096), kind: z.literal("symlink"), mode: z.number().int(), target: z.string().min(1).max(4096) }).strict(),
])
export const DeploymentBundleManifestSchema = z.object({
  format: z.literal("opencode-alg-deployment-bundle"), schema_version: z.literal(1),
  package: z.object({ name: z.literal("opencode-alg"), version: z.string().regex(/^\d+\.\d+\.\d+$/), release_tag: z.string().regex(/^v\d+\.\d+\.\d+$/).nullable(), source_commit: z.string().regex(/^[a-f0-9]{40,64}$/), source_repository: z.string().min(1).max(8192), artifact_sha256: Sha256 }).strict(),
  target: z.object({ platform: z.enum(["linux", "win32", "darwin"]), arch: z.string().min(1).max(32), runtime: z.enum(["bun", "node"]), node_major: z.number().int().min(22).nullable(), bun_major: z.number().int().positive().nullable(), libc: z.string().min(1).max(64) }).strict().superRefine((target, ctx) => {
    if (target.runtime === "bun" ? target.bun_major === null || target.node_major !== null : target.node_major === null || target.bun_major !== null) {
      ctx.addIssue({ code: "custom", message: "Bundle target must identify exactly its preparation launcher" })
    }
  }),
  dependencies: z.object({ manager: z.literal("npm"), mode: z.literal("production-offline-ready"), npm_lock_file: z.enum(["npm-shrinkwrap.json", "package-lock.json"]), npm_lock_sha256: Sha256, package_lock_sha256: Sha256, bun_lock_sha256: Sha256.nullable(), production_names: z.array(z.string()).max(256), production_identity: z.object({ sha256: Sha256, files: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }).strict(), tree: z.array(Entry).max(50_000) }).strict(),
  modes: z.object({ application: z.literal("OpenCode 1"), minimum_host: z.string(), maximum_host_exclusive: z.literal("2.0.0"), install: z.literal("offline-no-install"), trust: z.literal("explicit-manifest-sha256-approval") }).strict(),
  manifest_sha256: Sha256,
}).strict()
export type DeploymentBundleManifest = z.infer<typeof DeploymentBundleManifestSchema>

export function sha256(bytes: Uint8Array | string): string { return createHash("sha256").update(bytes).digest("hex") }

export function currentLibcIdentity(): string {
  if (process.platform !== "linux") return "not-applicable"
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined
  const glibc = report?.header?.glibcVersionRuntime
  return typeof glibc === "string" ? `glibc-${glibc}` : "non-glibc-or-unidentified"
}

type InventoryTree = DeploymentBundleManifest["dependencies"]["tree"]
type InventoryFile = { full: string; stat: BigIntStats; entry: Extract<InventoryTree[number], { kind: "file" }> }

/** One policy traversal for synchronous hashing, bounded async hashing, and the post-read census. */
function planInventory(root: string, excludeManifest: boolean, hashFile?: (full: string) => string) {
  const entries: InventoryTree = []
  const files: InventoryFile[] = []
  const identities: Array<[string, BigIntStats]> = [["", lstatSync(root, { bigint: true })]]
  const names = new Set<string>()
  let regularFiles = 0
  let totalBytes = 0
  const visit = (directory: string, prefix = "", depth = 0): void => {
    if (depth > 64) throw new Error("Bundle inventory exceeds directory depth 64")
    for (const child of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (excludeManifest && !prefix && child.name === "alg-bundle.json") continue
      if (!child.name || child.name === "." || child.name === ".." || /[\\/\0]/.test(child.name)) throw new Error("Bundle contains an invalid path component")
      const path = prefix ? `${prefix}/${child.name}` : child.name
      const folded = path.normalize("NFC").toLowerCase()
      if (names.has(folded)) throw new Error(`Bundle contains an ambiguous path: ${path}`)
      names.add(folded)
      const full = join(directory, child.name)
      const stat = lstatSync(full, { bigint: true })
      identities.push([path, stat])
      const mode = Number(stat.mode & 0o777n)
      if (stat.isSymbolicLink()) {
        const target = readlinkSync(full).replaceAll("\\", "/")
        if (!target || !isInside(root, realpathSync.native(full))) throw new Error(`Bundle link escapes its root: ${path}`)
        entries.push({ path, kind: "symlink", mode, target })
      } else if (stat.isDirectory()) {
        entries.push({ path, kind: "directory", mode })
        visit(full, path, depth + 1)
      } else if (stat.isFile()) {
        if (++regularFiles > 40_000 || stat.size > 64n * 1024n * 1024n || totalBytes + Number(stat.size) > 1024 * 1024 * 1024) {
          throw new Error("Bundle exceeds file count or aggregate inventory bounds")
        }
        totalBytes += Number(stat.size)
        const entry = { path, kind: "file" as const, mode, sha256: "" }
        // Preserve the original immediate stat/read ordering for synchronous authority paths.
        if (hashFile) entry.sha256 = hashFile(full)
        entries.push(entry)
        if (!hashFile) files.push({ full, stat, entry })
      }
      else throw new Error(`Bundle has unsupported filesystem entry: ${path}`)
      if (entries.length > 50_000) throw new Error("Bundle inventory exceeds 50000 entries")
    }
  }
  visit(root)
  return { entries, files, identities }
}

/** Canonical, bounded inventory. Links are recorded as links and must resolve inside the bundle. */
export function inventoryDeploymentTree(root: string, excludeManifest = false): InventoryTree {
  return planInventory(root, excludeManifest, full => sha256(readFileSync(full))).entries
}

/** Narrow I/O seam for deterministic interleaving/error tests; all policy checks remain here. */
export interface InventoryReadHandle {
  stat(): Promise<BigIntStats>
  read(buffer: Buffer, length: number, position: number): Promise<number>
  close(): Promise<void>
}
export interface AsyncInventoryOptions {
  concurrency?: number
  open?: (path: string, flags: number) => Promise<InventoryReadHandle>
}

async function openInventoryFile(path: string, flags: number): Promise<InventoryReadHandle> {
  const handle = await open(path, flags)
  return {
    stat: () => handle.stat({ bigint: true }),
    read: async (buffer, length, position) => (await handle.read(buffer, 0, length, position)).bytesRead,
    close: () => handle.close(),
  }
}

function sameInventoryIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

/** Hash every byte with bounded handles/buffers; fail closed on changes across asynchronous reads. */
export async function inventoryDeploymentTreeAsync(root: string, excludeManifest = false, options: AsyncInventoryOptions = {}): Promise<InventoryTree> {
  const concurrency = options.concurrency ?? 4
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("Inventory concurrency must be between 1 and 8")
  if (!lstatSync(root).isDirectory()) throw new Error("Inventory root must be a direct directory")
  const canonicalRoot = realpathSync.native(root)
  const plan = planInventory(canonicalRoot, excludeManifest)
  const openFile = options.open ?? openInventoryFile
  let cursor = 0
  let failed = false
  let failure: unknown
  const fail = (error: unknown): void => { if (!failed) { failed = true; failure = error } }
  const worker = async (): Promise<void> => {
    // One buffer per worker, independent of file size; at most four in the manager.
    const buffer = Buffer.alloc(64 * 1024)
    while (!failed) {
      const file = plan.files[cursor++]
      if (!file) return
      let handle: InventoryReadHandle | undefined
      try {
        if (realpathSync.native(file.full) !== file.full) throw new Error(`Bundle file redirected: ${file.entry.path}`)
        // A file replaced by a FIFO must not block before the descriptor type check.
        handle = await openFile(file.full, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
        const before = await handle.stat()
        if (!before.isFile() || !sameInventoryIdentity(file.stat, before)) throw new Error(`Bundle file changed before read: ${file.entry.path}`)
        const hash = createHash("sha256")
        const size = Number(before.size)
        let position = 0
        for (;;) {
          const length = Math.min(buffer.length, size - position + 1)
          const count = await handle.read(buffer, length, position)
          if (!Number.isInteger(count) || count < 0 || count > length) throw new Error("Invalid inventory read length")
          if (count === 0) break
          position += count
          if (position > size) throw new Error(`Bundle file grew during read: ${file.entry.path}`)
          hash.update(buffer.subarray(0, count))
        }
        if (position !== size || !sameInventoryIdentity(before, await handle.stat()) ||
          !sameInventoryIdentity(before, lstatSync(file.full, { bigint: true })) || realpathSync.native(file.full) !== file.full) {
          throw new Error(`Bundle file changed during read: ${file.entry.path}`)
        }
        file.entry.sha256 = hash.digest("hex")
      } catch (error) {
        fail(error)
      } finally {
        if (handle) {
          try { await handle.close() } catch (error) { fail(error) }
        }
      }
    }
  }
  // Workers never reject early: every started handle is closed before the first error is returned.
  await Promise.all(Array.from({ length: concurrency }, worker))
  if (failed) throw failure
  const final = planInventory(canonicalRoot, excludeManifest)
  if (realpathSync.native(root) !== canonicalRoot || !sameInventoryIdentity(lstatSync(root, { bigint: true }), plan.identities[0]![1]) ||
    final.identities.length !== plan.identities.length || final.identities.some(([path, stat], index) => {
      const prior = plan.identities[index]!
      return path !== prior[0] || !sameInventoryIdentity(stat, prior[1])
    }) || JSON.stringify(final.entries) !== JSON.stringify(plan.entries.map(entry => entry.kind === "file" ? { ...entry, sha256: "" } : entry))) {
    throw new Error("Bundle tree changed during inventory")
  }
  return plan.entries
}

function isInside(root: string, target: string): boolean {
  const rel = relative(realpathSync.native(root), target)
  return rel === "" || (!isAbsolute(rel) && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== "..")
}

export function sealBundleManifest(input: Omit<DeploymentBundleManifest, "manifest_sha256">): DeploymentBundleManifest {
  return DeploymentBundleManifestSchema.parse({ ...input, manifest_sha256: sha256(JSON.stringify(input)) })
}

export function readAndVerifyDeploymentBundle(bundleRoot: string, approvedManifestHash: string): DeploymentBundleManifest {
  if (!/^[a-f0-9]{64}$/.test(approvedManifestHash)) throw new Error("--trust-bundle requires the reviewed 64-character manifest SHA-256")
  const path = join(bundleRoot, "alg-bundle.json")
  if (!existsSync(path)) throw new Error(`Prepared deployment bundle manifest is missing: ${path}`)
  const manifestStat = lstatSync(path)
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 32 * 1024 * 1024) {
    throw new Error("Prepared deployment bundle manifest must be a bounded regular file")
  }
  const parsed = DeploymentBundleManifestSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  const { manifest_sha256: recorded, ...contents } = parsed
  const actualManifestHash = sha256(JSON.stringify(contents))
  if (actualManifestHash !== recorded || recorded !== approvedManifestHash) throw new Error("Bundle manifest checksum differs from the explicitly approved manifest identity")
  if (parsed.target.platform !== process.platform || parsed.target.arch !== process.arch) throw new Error(`Bundle target ${parsed.target.platform}/${parsed.target.arch} does not match this runtime ${process.platform}/${process.arch}`)
  if (parsed.target.libc !== currentLibcIdentity()) throw new Error(`Bundle target libc ${parsed.target.libc} does not match this runtime ${currentLibcIdentity()}`)
  const runtime = process.versions.bun ? "bun" : "node"
  if (parsed.target.runtime !== runtime) throw new Error(`Bundle requires the ${parsed.target.runtime} launcher; current launcher is ${runtime}`)
  const major = Number((runtime === "bun" ? process.versions.bun : process.versions.node)!.split(".")[0])
  if ((runtime === "bun" ? parsed.target.bun_major : parsed.target.node_major) !== major) {
    throw new Error(`Bundle requires ${runtime} major version ${runtime === "bun" ? parsed.target.bun_major : parsed.target.node_major}; current is ${major}`)
  }
  const packageRoot = bundleRoot
  const actual = inventoryDeploymentTree(packageRoot, true)
  if (JSON.stringify(actual) !== JSON.stringify(parsed.dependencies.tree)) throw new Error("Prepared bundle inventory, bytes, links, or modes do not match its manifest")
  if (sha256(JSON.stringify(actual)) !== parsed.package.artifact_sha256) throw new Error("Bundle artifact digest does not match its inventoried package")
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
  if (pkg.name !== parsed.package.name || pkg.version !== parsed.package.version) throw new Error("Bundle package identity differs from its manifest")
  if (JSON.stringify(Object.keys(pkg.dependencies ?? {}).sort()) !== JSON.stringify(parsed.dependencies.production_names)) throw new Error("Bundle production dependency declaration differs from its manifest")
  if (parsed.dependencies.npm_lock_file !== (existsSync(join(packageRoot, "npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : "package-lock.json")) {
    throw new Error("Bundle manifest does not name the active npm lockfile")
  }
  const packageLockHash = sha256(readFileSync(join(packageRoot, "package-lock.json")))
  const npmLockHash = sha256(readFileSync(join(packageRoot, parsed.dependencies.npm_lock_file)))
  if (packageLockHash !== parsed.dependencies.package_lock_sha256 || npmLockHash !== parsed.dependencies.npm_lock_sha256) throw new Error("Bundle npm lockfile identity differs from its manifest")
  const bunLock = join(packageRoot, "bun.lock")
  if ((existsSync(bunLock) ? sha256(readFileSync(bunLock)) : null) !== parsed.dependencies.bun_lock_sha256) throw new Error("Bundle Bun lockfile identity differs from its manifest")
  return parsed
}

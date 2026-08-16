import { createHash } from "node:crypto"
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
} from "node:fs"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

export const ALG_LIVE_SOURCE_DIGEST_ENV = "OPENCODE_ALG_LIVE_SOURCE_DIGEST"
export const ALG_LIVE_SOURCE_MARKER = "OPENCODE_ALG_SOURCE_ID"

export const ALG_SOURCE_MANIFEST_MAX_FILES = 256
export const ALG_SOURCE_MANIFEST_MAX_FILE_BYTES = 1024 * 1024
export const ALG_SOURCE_MANIFEST_MAX_TOTAL_BYTES = 8 * 1024 * 1024

export interface AlgSourceManifestBounds {
  max_files: number
  max_file_bytes: number
  max_total_bytes: number
}

export interface AlgSourceManifestEntry {
  path: string
  bytes: number
}

export interface AlgSourceIdentity {
  root: string
  spec: string
  digest: string
  manifest: readonly AlgSourceManifestEntry[]
  file_count: number
  total_bytes: number
  bounds: AlgSourceManifestBounds
}

export interface AlgSourceIdentityOptions {
  maxFiles?: number
  maxFileBytes?: number
  maxTotalBytes?: number
}

interface CollectedSource {
  path: string
  bytes: Buffer
}

function normalizedForComparison(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function isWithin(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot))
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`)
  return value
}

function sourceBounds(options: AlgSourceIdentityOptions): AlgSourceManifestBounds {
  return {
    max_files: positiveInteger(options.maxFiles ?? ALG_SOURCE_MANIFEST_MAX_FILES, "maxFiles"),
    max_file_bytes: positiveInteger(
      options.maxFileBytes ?? ALG_SOURCE_MANIFEST_MAX_FILE_BYTES,
      "maxFileBytes",
    ),
    max_total_bytes: positiveInteger(
      options.maxTotalBytes ?? ALG_SOURCE_MANIFEST_MAX_TOTAL_BYTES,
      "maxTotalBytes",
    ),
  }
}

function assertUnlinkedPath(root: string, path: string, expected: "directory" | "file"): void {
  if (!isWithin(root, path)) throw new Error(`runtime source path escapes package root: ${path}`)
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error(`runtime source path must not be a symlink or junction: ${path}`)
  if (expected === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`runtime source path must be a regular ${expected}: ${path}`)
  }
  const canonical = realpathSync.native(path)
  if (normalizedForComparison(canonical) !== normalizedForComparison(path) || !isWithin(root, canonical)) {
    throw new Error(`runtime source path must not traverse a symlink or junction: ${path}`)
  }
}

function readBoundedRegularFile(
  root: string,
  absolute: string,
  projectRelative: string,
  collected: readonly CollectedSource[],
  bounds: AlgSourceManifestBounds,
): Buffer {
  assertUnlinkedPath(root, absolute, "file")
  const before = lstatSync(absolute)
  if (before.size > bounds.max_file_bytes) {
    throw new Error(`runtime source file exceeds ${bounds.max_file_bytes} bytes: ${projectRelative}`)
  }
  const aggregateBefore = collected.reduce((total, entry) => total + entry.bytes.byteLength, 0)
  if (aggregateBefore + before.size > bounds.max_total_bytes) {
    throw new Error(`runtime source manifest exceeds ${bounds.max_total_bytes} aggregate bytes`)
  }

  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
  const descriptor = openSync(absolute, constants.O_RDONLY | noFollow)
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new Error(`runtime source file changed while building manifest: ${projectRelative}`)
    }
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    if (bytes.byteLength !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
      throw new Error(`runtime source file changed while building manifest: ${projectRelative}`)
    }
    return bytes
  } finally {
    closeSync(descriptor)
  }
}

function addSourceFile(
  root: string,
  projectRelative: string,
  collected: CollectedSource[],
  bounds: AlgSourceManifestBounds,
): void {
  if (collected.length >= bounds.max_files) {
    throw new Error(`runtime source manifest exceeds ${bounds.max_files} files`)
  }
  const normalized = projectRelative.replaceAll("\\", "/")
  if (normalized.startsWith("/") || normalized.includes("../") || normalized.includes("\0")) {
    throw new Error(`invalid runtime source manifest path: ${projectRelative}`)
  }
  const absolute = join(root, ...normalized.split("/"))
  collected.push({
    path: normalized,
    bytes: readBoundedRegularFile(root, absolute, normalized, collected, bounds),
  })
}

function collectSourceTypeScript(
  root: string,
  directory: string,
  prefix: string,
  collected: CollectedSource[],
  bounds: AlgSourceManifestBounds,
): void {
  assertUnlinkedPath(root, directory, "directory")
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  for (const entry of entries) {
    const path = join(directory, entry.name)
    const projectRelative = `${prefix}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new Error(`runtime source path must not be a symlink or junction: ${projectRelative}`)
    }
    if (entry.isDirectory()) {
      collectSourceTypeScript(root, path, projectRelative, collected, bounds)
      continue
    }
    if (entry.name.endsWith(".ts")) {
      if (!entry.isFile()) throw new Error(`runtime source path must be a regular file: ${projectRelative}`)
      addSourceFile(root, projectRelative, collected, bounds)
    }
  }
}

function collectFlatAssets(
  root: string,
  directoryName: "agents" | "templates",
  extension: ".md" | ".json",
  collected: CollectedSource[],
  bounds: AlgSourceManifestBounds,
): void {
  const directory = join(root, directoryName)
  assertUnlinkedPath(root, directory, "directory")
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
  for (const entry of entries) {
    const projectRelative = `${directoryName}/${entry.name}`
    if (entry.isSymbolicLink()) {
      throw new Error(`runtime source path must not be a symlink or junction: ${projectRelative}`)
    }
    if (!entry.name.endsWith(extension)) continue
    if (!entry.isFile()) throw new Error(`runtime source path must be a regular file: ${projectRelative}`)
    addSourceFile(root, projectRelative, collected, bounds)
  }
}

export function canonicalPluginRoot(root: string): string {
  return realpathSync.native(resolve(root))
}

/**
 * Hash every shipped input that can affect the server/TUI package: package
 * metadata, all TypeScript runtime modules (including untracked modules), and
 * the bundled template/agent assets. Tests, docs, evidence, and scripts are not
 * loaded by those entry points and are intentionally outside this manifest.
 */
export function computeAlgSourceIdentity(
  root: string,
  options: AlgSourceIdentityOptions = {},
): AlgSourceIdentity {
  const canonicalRoot = canonicalPluginRoot(root)
  const bounds = sourceBounds(options)
  const collected: CollectedSource[] = []
  addSourceFile(canonicalRoot, "package.json", collected, bounds)
  collectSourceTypeScript(canonicalRoot, join(canonicalRoot, "src"), "src", collected, bounds)
  collectFlatAssets(canonicalRoot, "templates", ".json", collected, bounds)
  collectFlatAssets(canonicalRoot, "agents", ".md", collected, bounds)
  collected.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)

  const hash = createHash("sha256")
  hash.update("opencode-alg-runtime-source-manifest-v1\0", "utf8")
  for (const entry of collected) {
    const pathBytes = Buffer.from(entry.path, "utf8")
    const framing = Buffer.allocUnsafe(12)
    framing.writeUInt32BE(pathBytes.byteLength, 0)
    framing.writeBigUInt64BE(BigInt(entry.bytes.byteLength), 4)
    hash.update(framing)
    hash.update(pathBytes)
    hash.update(entry.bytes)
  }

  const totalBytes = collected.reduce((total, entry) => total + entry.bytes.byteLength, 0)
  return {
    root: canonicalRoot,
    spec: pathToFileURL(canonicalRoot).href.replace(/\/$/, ""),
    digest: hash.digest("hex"),
    manifest: collected.map((entry) => ({ path: entry.path, bytes: entry.bytes.byteLength })),
    file_count: collected.length,
    total_bytes: totalBytes,
    bounds,
  }
}

export function sourceIdentityMessage(entry: "server" | "tui", identity: AlgSourceIdentity): string {
  const encodedRoot = Buffer.from(identity.root, "utf8").toString("base64url")
  return `${ALG_LIVE_SOURCE_MARKER} entry=${entry} digest=${identity.digest} ` +
    `files=${identity.file_count} bytes=${identity.total_bytes} root=${encodedRoot}`
}

/**
 * Test-only live proof. Normal startup does no source reads and emits no marker.
 * When verification opts in, a mismatched checkout fails before registration.
 */
export function verifiedLiveSourceIdentity(entry: "server" | "tui"): {
  identity: AlgSourceIdentity
  message: string
} | undefined {
  const expected = process.env[ALG_LIVE_SOURCE_DIGEST_ENV]
  if (expected === undefined) return undefined
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new Error(`${ALG_LIVE_SOURCE_DIGEST_ENV} must be one lowercase SHA-256 digest`)
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  const identity = computeAlgSourceIdentity(root)
  if (identity.digest !== expected) {
    throw new Error(`loaded opencode-alg source digest ${identity.digest} does not match reviewed digest ${expected}`)
  }
  return { identity, message: sourceIdentityMessage(entry, identity) }
}

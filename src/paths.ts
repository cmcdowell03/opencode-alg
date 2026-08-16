import { existsSync, lstatSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path"

export const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** Object-prototype names are unsafe map keys; device names are unsafe paths on Windows. */
export const RESERVED_IDS = new Set([
  "__definegetter__",
  "__definesetter__",
  "__lookupgetter__",
  "__lookupsetter__",
  "__proto__",
  "constructor",
  "hasownproperty",
  "isprototypeof",
  "propertyisenumerable",
  "prototype",
  "tolocalestring",
  "tostring",
  "valueof",
])

const WINDOWS_DEVICE_ID = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/

export class PathSafetyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathSafetyError"
  }
}

export interface ContainmentFilesystemOperations {
  lstat(path: string): unknown
  realpath(path: string): string
}

const DEFAULT_CONTAINMENT_FILESYSTEM: ContainmentFilesystemOperations = {
  lstat: (path) => lstatSync(path),
  realpath: (path) => realpathSync.native(path),
}

function missingFilesystemCode(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

/** Missing means only an explicit ENOENT/ENOTDIR; every other error fails closed. */
export function strictlyMissingPath(
  path: string,
  operations: Pick<ContainmentFilesystemOperations, "lstat"> = DEFAULT_CONTAINMENT_FILESYSTEM,
): boolean {
  try {
    operations.lstat(path)
    return false
  } catch (error) {
    if (missingFilesystemCode(error)) return true
    throw error
  }
}

export function isSafeId(value: string): boolean {
  return SAFE_ID_PATTERN.test(value) &&
    value !== "." &&
    value !== ".." &&
    !RESERVED_IDS.has(value.toLowerCase()) &&
    !WINDOWS_DEVICE_ID.test(value)
}

export function assertSafeId(value: string, label = "id"): string {
  if (!isSafeId(value)) {
    throw new PathSafetyError(`${label} is not a safe identifier`)
  }
  return value
}

export function canonicalDirectory(path: string): string {
  if (!isAbsolute(path)) throw new PathSafetyError("directory must be absolute")
  if (!existsSync(path)) throw new PathSafetyError(`directory does not exist: ${path}`)
  return realpathSync.native(path)
}

/** Host-independent filesystem-root detection for POSIX, drive, and UNC roots. */
export function isFilesystemRoot(path: string): boolean {
  if (!path || path.includes("\u0000")) return false
  const windows = win32.normalize(path)
  if (win32.isAbsolute(path) && windows.toLowerCase() === win32.parse(windows).root.toLowerCase()) {
    return true
  }
  const portable = posix.normalize(path)
  return posix.isAbsolute(path) && portable === posix.parse(portable).root
}

export function assertFilesystemRootAuthorized(
  projectDirectory: string,
  allowed: boolean | undefined,
  operation: "plan" | "run" | "resume",
  additionalFilesystemRoot = false,
): boolean {
  // The additive seam lets tests exercise real tool handlers against an
  // isolated backing directory. It can only tighten root policy, never bypass
  // detection of an actual filesystem root.
  const root = additionalFilesystemRoot || isFilesystemRoot(projectDirectory)
  if (root && allowed !== true) {
    throw new PathSafetyError(
      `ALG ${operation} requires a scoped project directory; filesystem root ${projectDirectory} is rejected by default. ` +
      "Pass allow_filesystem_root=true explicitly for this call only.",
    )
  }
  return root
}

/** Canonicalize an existing root or its nearest existing ancestor for safe creation. */
export function canonicalRootPath(path: string): string {
  if (!isAbsolute(path)) throw new PathSafetyError("root path must be absolute")
  if (existsSync(path)) return realpathSync.native(path)
  const missing: string[] = []
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) throw new PathSafetyError(`no existing ancestor for root: ${path}`)
    missing.unshift(current.slice(parent.length).replace(/^[/\\]+/, ""))
    current = parent
  }
  return resolve(realpathSync.native(current), ...missing)
}

export function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** Resolve an existing directory and reject lexical and symlink escapes. */
export function canonicalContainedDirectory(root: string, requested?: string): string {
  const canonicalRoot = canonicalDirectory(root)
  const candidate = requested
    ? isAbsolute(requested)
      ? requested
      : resolve(canonicalRoot, requested)
    : canonicalRoot
  const canonicalCandidate = canonicalDirectory(candidate)
  if (!isContained(canonicalRoot, canonicalCandidate)) {
    throw new PathSafetyError("cwd must be contained by the project worktree")
  }
  return canonicalCandidate
}

/** Join only safe path segments and prove the result remains below root. */
export function containedPath(root: string, ...segments: string[]): string {
  const canonicalRoot = canonicalDirectory(root)
  for (const segment of segments) assertSafeId(segment, "path segment")
  return resolveContainedPath(canonicalRoot, ...segments)
}

export function resolveContainedPath(root: string, ...segments: string[]): string {
  return resolveContainedPathWithOperations(root, segments, DEFAULT_CONTAINMENT_FILESYSTEM)
}

/** Injectable form used to deterministically exercise filesystem race branches. */
export function resolveContainedPathWithOperations(
  root: string,
  segments: readonly string[],
  operations: ContainmentFilesystemOperations,
): string {
  if (!isAbsolute(root)) throw new PathSafetyError("root path must be absolute")
  const missingRootSegments: string[] = []
  let existingRoot = root
  while (strictlyMissingPath(existingRoot, operations)) {
    const parent = dirname(existingRoot)
    if (parent === existingRoot) throw new PathSafetyError(`no existing ancestor for root: ${root}`)
    missingRootSegments.unshift(existingRoot.slice(parent.length).replace(/^[/\\]+/, ""))
    existingRoot = parent
  }
  const canonicalRoot = resolve(operations.realpath(existingRoot), ...missingRootSegments)
  const lexical = resolve(canonicalRoot, ...segments)
  if (!isContained(canonicalRoot, lexical) || lexical === canonicalRoot) {
    throw new PathSafetyError("derived path escaped its root")
  }
  const rel = relative(canonicalRoot, lexical)
  const parts = rel.split(sep).filter(Boolean)
  let current = canonicalRoot
  for (let index = 0; index < parts.length; index++) {
    const next = resolve(current, parts[index]!)
    if (strictlyMissingPath(next, operations)) {
      const result = resolve(current, ...parts.slice(index))
      if (!isContained(canonicalRoot, result)) throw new PathSafetyError("derived path escaped its root")
      return result
    }
    let real: string
    try {
      real = operations.realpath(next)
    } catch (error) {
      // Another process may remove an ephemeral lock after lstat but
      // before realpath. Treat only a now-missing component like the normal
      // not-yet-created case; an extant but unreadable component still fails
      // closed so symlink containment is never bypassed.
      if (!strictlyMissingPath(next, operations)) throw error
      const result = resolve(current, ...parts.slice(index))
      if (!isContained(canonicalRoot, result)) throw new PathSafetyError("derived path escaped its root")
      return result
    }
    if (!isContained(canonicalRoot, real)) {
      // On Windows, realpath can resolve a concurrently deleted file into the
      // NTFS $Extend/$Deleted namespace instead of throwing. Accept that only
      // when the original component is now absent; an extant symlink/junction
      // resolving outside the root still fails closed.
      if (strictlyMissingPath(next, operations)) {
        const result = resolve(current, ...parts.slice(index))
        if (!isContained(canonicalRoot, result)) throw new PathSafetyError("derived path escaped its root")
        return result
      }
      throw new PathSafetyError("existing path component escapes its trusted root")
    }
    current = real
  }
  return current
}

function isSafeMetadataSegment(segment: string): boolean {
  return segment.length > 0 &&
    segment.length <= 255 &&
    segment !== "." &&
    segment !== ".." &&
    !CONTROL_CHARACTER.test(segment) &&
    !segment.includes(":") &&
    !segment.endsWith(" ") &&
    !segment.endsWith(".") &&
    !RESERVED_IDS.has(segment.toLowerCase()) &&
    !WINDOWS_DEVICE_ID.test(segment)
}

/** Portable normalized project-relative metadata path; this does not touch disk. */
export function isSafeProjectRelativePath(value: string): boolean {
  if (!value || value !== value.trim() || CONTROL_CHARACTER.test(value)) return false
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || /^[/\\]{2}/.test(value)) {
    return false
  }
  if (value.endsWith("/") || value.includes("//") || posix.normalize(value) !== value) return false
  return value.split("/").every(isSafeMetadataSegment)
}

export function isSafeRunArtifactPath(value: string): boolean {
  return isSafeRunDerivedPath(value, "artifacts")
}

export function isSafeRunDerivedPath(value: string, directory: "artifacts" | "history" | "checks"): boolean {
  if (!isSafeProjectRelativePath(value)) return false
  const parts = value.split("/")
  return parts.length >= 5 &&
    parts[0] === ".opencode" &&
    parts[1] === "runs" &&
    isSafeId(parts[2]!) &&
    parts[3] === directory
}

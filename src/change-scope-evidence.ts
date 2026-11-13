import { lstatSync, opendirSync } from "node:fs"
import { platform } from "node:process"
import { join } from "node:path"
import { z } from "zod"
import { isSafeProjectRelativePath, resolveContainedPath } from "./paths.ts"
import { projectFileDigest } from "./preservation-evidence.ts"
import { sha256Json } from "./persistence.ts"

/** Persisted v1 policy: never broaden it while comparing an older baseline. */
export const LEGACY_CHANGE_SCOPE_EXCLUSIONS = [".git", "node_modules", ".opencode/runs"] as const
/** Project-root host stores only; skills, workspace configuration and unknown .opencode paths are user scope. */
export const CHANGE_SCOPE_RUNTIME_EXCLUSIONS = [".opencode/session-memory", ".opencode/skill-evolution", ".opencode/experience"] as const
export const CHANGE_SCOPE_EXCLUSIONS = [...LEGACY_CHANGE_SCOPE_EXCLUSIONS, ...CHANGE_SCOPE_RUNTIME_EXCLUSIONS] as const
export const CHANGE_SCOPE_MAX_FILES = 256
export const CHANGE_SCOPE_MAX_FILE_BYTES = 1024 * 1024
export const CHANGE_SCOPE_MAX_TOTAL_BYTES = 16 * 1024 * 1024
export const CHANGE_SCOPE_MAX_CHANGES = 512
export const CHANGE_SCOPE_MAX_ENTRIES = 4096
export const CHANGE_SCOPE_MAX_DEPTH = 32

const safeDirectoryPath = (value: string) => value === "." || isSafeProjectRelativePath(value)
const safeFilePath = (value: string) => value !== "." && isSafeProjectRelativePath(value)

export const ChangeScopeInputSchema = z.object({
  roots: z.array(z.string().min(1).max(512).refine(safeDirectoryPath)).min(1).max(8),
  allowed_paths: z.array(z.string().min(1).max(512).refine(safeFilePath)).max(64),
  max_changed_files: z.number().int().min(0).max(64),
}).strict().superRefine((scope, ctx) => {
  if ([...scope.roots, ...scope.allowed_paths].some(path => excludedPath(path)))
    ctx.addIssue({ code: "custom", message: "declared paths must not be excluded" })
  const roots = scope.roots.map(pathKey)
  for (let i = 0; i < roots.length; i++) {
    for (let j = i + 1; j < roots.length; j++) {
      if (isPathWithin(roots[i]!, roots[j]!) || isPathWithin(roots[j]!, roots[i]!)) {
        ctx.addIssue({ code: "custom", path: ["roots", j], message: "roots must not overlap" })
      }
    }
  }
  const allowed = scope.allowed_paths.map(pathKey)
  if (new Set(allowed).size !== allowed.length) {
    ctx.addIssue({ code: "custom", path: ["allowed_paths"], message: "allowed_paths must be unique" })
  }
  for (let i = 0; i < scope.allowed_paths.length; i++) {
    const path = pathKey(scope.allowed_paths[i]!)
    if (!roots.some(root => root === "." || isPathWithin(root, path))) {
      ctx.addIssue({ code: "custom", path: ["allowed_paths", i], message: "allowed path must be under a root" })
    }
  }
})
export type ChangeScopeInput = z.infer<typeof ChangeScopeInputSchema>

const ScopeFileSchema = z.object({
  path: z.string().min(1).max(512).refine(safeFilePath),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()

export const ChangeScopeExclusionsSchema = z.array(z.enum(CHANGE_SCOPE_EXCLUSIONS))
  .min(LEGACY_CHANGE_SCOPE_EXCLUSIONS.length).max(CHANGE_SCOPE_EXCLUSIONS.length)
  .refine(items => LEGACY_CHANGE_SCOPE_EXCLUSIONS.every((item, index) => items[index] === item) &&
    items.every((item, index) => index === 0 || CHANGE_SCOPE_EXCLUSIONS.indexOf(items[index - 1]!) < CHANGE_SCOPE_EXCLUSIONS.indexOf(item)),
  "exclusions must retain the legacy prefix and ordered runtime subset")

export const ChangeScopeBasisSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  scope_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  files: z.array(ScopeFileSchema).max(CHANGE_SCOPE_MAX_FILES),
  exclusions: ChangeScopeExclusionsSchema,
}).strict().superRefine((basis, ctx) => {
  if (new Set(basis.files.map(file => pathKey(file.path))).size !== basis.files.length) {
    ctx.addIssue({ code: "custom", path: ["files"], message: "duplicate manifest path" })
  }
  if (basis.files.some((file, index) => index > 0 && basis.files[index - 1]!.path >= file.path)) {
    ctx.addIssue({ code: "custom", path: ["files"], message: "manifest paths must be sorted" })
  }
  if (basis.version === 1 && basis.exclusions.length !== LEGACY_CHANGE_SCOPE_EXCLUSIONS.length) {
    ctx.addIssue({ code: "custom", path: ["exclusions"], message: "v1 exclusions must match the original fixed list" })
  }
})
export type ChangeScopeBasis = z.infer<typeof ChangeScopeBasisSchema>

export const ChangeScopeFailureSchema = z.enum([
  "invalid_scope",
  "scope_mismatch",
  "invalid_baseline",
  "missing_root",
  "unsafe_entry",
  "limits_exceeded",
  "recapture_failed",
])
export type ChangeScopeFailure = z.infer<typeof ChangeScopeFailureSchema>

export const ChangeScopeResultSchema = z.object({
  version: z.literal(1),
  scope_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  before_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  after_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  status: z.enum(["within_scope", "violated", "unavailable"]),
  changed: z.array(z.object({
    path: z.string().min(1).max(512).refine(safeFilePath),
    kind: z.enum(["added", "modified", "deleted"]),
  }).strict()).max(CHANGE_SCOPE_MAX_CHANGES),
  failure: ChangeScopeFailureSchema.optional(),
}).strict().superRefine((result, ctx) => {
  if ((result.status === "unavailable") !== (result.failure !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["failure"], message: "failure must be present only for unavailable results" })
  }
  if ((result.status === "unavailable") === (result.after_sha256 !== undefined)) {
    ctx.addIssue({ code: "custom", path: ["after_sha256"], message: "after_sha256 must be present only for available results" })
  }
  if (new Set(result.changed.map(item => pathKey(item.path))).size !== result.changed.length) {
    ctx.addIssue({ code: "custom", path: ["changed"], message: "changed paths must be unique" })
  }
  if (result.changed.some((item, index) => index > 0 && result.changed[index - 1]!.path >= item.path)) {
    ctx.addIssue({ code: "custom", path: ["changed"], message: "changed paths must be sorted" })
  }
})
export type ChangeScopeResult = z.infer<typeof ChangeScopeResultSchema>
export const ChangeScopeEvidenceSchema = ChangeScopeResultSchema
export type ChangeScopeEvidence = ChangeScopeResult

class ScopeCaptureError extends Error {
  constructor(readonly code: ChangeScopeFailure) { super(code) }
}

function pathKey(path: string): string {
  return platform === "win32" ? path.toLowerCase() : path
}

function isPathWithin(root: string, path: string): boolean {
  return root === "." || path === root || path.startsWith(`${root}/`)
}

function excludedPath(path: string, exclusions: readonly string[] = LEGACY_CHANGE_SCOPE_EXCLUSIONS): boolean {
  const parts = path.split("/").map(part => platform === "win32" ? part.toLowerCase() : part)
  return parts.includes(".git") || parts.includes("node_modules") ||
    parts.some((part, index) => part === ".opencode" && parts[index + 1] === "runs") ||
    CHANGE_SCOPE_RUNTIME_EXCLUSIONS.some(root => exclusions.includes(root) && isPathWithin(root, pathKey(path)))
}

/** Pin a bounded policy before work. Explicit descendants opt their whole runtime store back into observation. */
export function changeScopeExclusions(scope: ChangeScopeInput, declaredPaths: readonly string[] = []) {
  // At most 8 preservation paths plus 16 project-file deliverables in a task contract.
  const declaredFiles = z.array(z.string().min(1).max(512).refine(safeFilePath)).max(24).parse(declaredPaths)
  const explicit = [...scope.roots.filter(root => root !== "."), ...scope.allowed_paths, ...declaredFiles].map(pathKey)
  return [...LEGACY_CHANGE_SCOPE_EXCLUSIONS, ...CHANGE_SCOPE_RUNTIME_EXCLUSIONS.filter(root =>
    !explicit.some(path => isPathWithin(root, path)))]
}

function containedEntry(root: string, path: string): string {
  if (path === ".") return root
  resolveContainedPath(root, path)
  // Containment resolution may return a symlink's target. Inspect the lexical entry itself.
  return join(root, path)
}

function readScopeFiles(root: string, scope: ChangeScopeInput, exclusions: readonly string[]): ChangeScopeBasis["files"] {
  let fileCount = 0
  let byteCount = 0
  let entryCount = 0
  const files: ChangeScopeBasis["files"] = []

  const addFile = (relativePath: string, absolutePath: string) => {
    fileCount++
    if (fileCount > CHANGE_SCOPE_MAX_FILES) throw new ScopeCaptureError("limits_exceeded")
    try {
      const stat = lstatSync(absolutePath)
      if (!stat.isFile() || stat.isSymbolicLink()) throw new ScopeCaptureError("unsafe_entry")
      if (stat.size > CHANGE_SCOPE_MAX_FILE_BYTES) throw new ScopeCaptureError("limits_exceeded")
      byteCount += stat.size
      if (byteCount > CHANGE_SCOPE_MAX_TOTAL_BYTES) throw new ScopeCaptureError("limits_exceeded")
      files.push({ path: relativePath, sha256: projectFileDigest(root, relativePath, CHANGE_SCOPE_MAX_FILE_BYTES) })
    } catch (error) {
      if (error instanceof ScopeCaptureError) throw error
      throw new ScopeCaptureError("unsafe_entry")
    }
  }

  const visit = (relativePath: string, depth = 0) => {
    if (depth > CHANGE_SCOPE_MAX_DEPTH) throw new ScopeCaptureError("limits_exceeded")
    if (excludedPath(relativePath, exclusions)) return
    let absolutePath: string
    try { absolutePath = containedEntry(root, relativePath) }
    catch { throw new ScopeCaptureError("unsafe_entry") }
    let stat
    try { stat = lstatSync(absolutePath) }
    catch { throw new ScopeCaptureError("missing_root") }
    if (stat.isSymbolicLink()) throw new ScopeCaptureError("unsafe_entry")
    if (stat.isFile()) {
      addFile(relativePath, absolutePath)
      return
    }
    if (!stat.isDirectory()) throw new ScopeCaptureError("unsafe_entry")
    const entries: string[] = []
    try {
      const directory = opendirSync(absolutePath)
      try {
        let entry
        while ((entry = directory.readSync())) {
          if (++entryCount > CHANGE_SCOPE_MAX_ENTRIES) throw new ScopeCaptureError("limits_exceeded")
          entries.push(entry.name)
        }
      } finally { directory.closeSync() }
      entries.sort()
    } catch (error) {
      if (error instanceof ScopeCaptureError) throw error
      throw new ScopeCaptureError("unsafe_entry")
    }
    for (const entry of entries) {
      const child = relativePath === "." ? entry : `${relativePath}/${entry}`
      if (!isSafeProjectRelativePath(child)) throw new ScopeCaptureError("unsafe_entry")
      if (excludedPath(child, exclusions)) continue
      let childAbsolute: string
      try { childAbsolute = containedEntry(root, child) }
      catch { throw new ScopeCaptureError("unsafe_entry") }
      let childStat
      try { childStat = lstatSync(childAbsolute) }
      catch { throw new ScopeCaptureError("unsafe_entry") }
      if (childStat.isSymbolicLink()) throw new ScopeCaptureError("unsafe_entry")
      if (childStat.isDirectory()) visit(child, depth + 1)
      else if (childStat.isFile()) addFile(child, childAbsolute)
      else throw new ScopeCaptureError("unsafe_entry")
    }
  }

  for (const scopeRoot of scope.roots) {
    // A nested declared root must not bypass an unvisited symlink ancestor.
    if (scopeRoot !== ".") {
      const parts = scopeRoot.split("/")
      for (let index = 1; index < parts.length; index++) {
        try {
          if (lstatSync(containedEntry(root, parts.slice(0, index).join("/"))).isSymbolicLink())
            throw new ScopeCaptureError("unsafe_entry")
        } catch { throw new ScopeCaptureError("unsafe_entry") }
      }
    }
    let absolutePath: string
    try { absolutePath = containedEntry(root, scopeRoot) }
    catch { throw new ScopeCaptureError("unsafe_entry") }
    let stat
    try { stat = lstatSync(absolutePath) }
    catch { throw new ScopeCaptureError("missing_root") }
    if (stat.isSymbolicLink()) throw new ScopeCaptureError("unsafe_entry")
    if (!stat.isDirectory()) throw new ScopeCaptureError("missing_root")
    visit(scopeRoot)
  }
  return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}

/**
 * Captures content digests for a bounded project-relative scope. This is not a
 * snapshot-atomic filesystem view and does not prove permissions, history, or
 * symlink safety against concurrent changes beyond the checks performed while
 * walking and hashing.
 */
export function captureChangeScopeBasis(root: string, rawScope: unknown, declaredPaths: readonly string[] = []): ChangeScopeBasis {
  const scope = ChangeScopeInputSchema.parse(rawScope)
  const exclusions = changeScopeExclusions(scope, declaredPaths)
  try {
    const files = readScopeFiles(root, scope, exclusions)
    return ChangeScopeBasisSchema.parse({ version: 2, scope_sha256: sha256Json(scope), files, exclusions })
  } catch (error) {
    if (error instanceof ScopeCaptureError) throw new Error(`change_scope_${error.code}`)
    throw new Error("change_scope_unsafe_entry")
  }
}

function unavailable(scopeHash: string, beforeHash: string, failure: ChangeScopeFailure): ChangeScopeResult {
  return ChangeScopeResultSchema.parse({ version: 1, scope_sha256: scopeHash, before_sha256: beforeHash,
    status: "unavailable", changed: [], failure })
}

export function finishChangeScopeEvidence(root: string, rawScope: unknown, rawBasis: unknown): ChangeScopeResult {
  const scopeParsed = ChangeScopeInputSchema.safeParse(rawScope)
  const scopeHash = scopeParsed.success ? sha256Json(scopeParsed.data) : "0".repeat(64)
  const baselineHash = (() => { try { return sha256Json(rawBasis) } catch { return "0".repeat(64) } })()
  if (!scopeParsed.success) return unavailable(scopeHash, baselineHash, "invalid_scope")
  const baselineParsed = ChangeScopeBasisSchema.safeParse(rawBasis)
  if (!baselineParsed.success) return unavailable(scopeHash, baselineHash, "invalid_baseline")
  const basis = baselineParsed.data
  if (basis.scope_sha256 !== scopeHash) return unavailable(scopeHash, baselineHash, "scope_mismatch")
  if (basis.version === 2 && basis.exclusions.some(item => !changeScopeExclusions(scopeParsed.data).includes(item)))
    return unavailable(scopeHash, baselineHash, "invalid_baseline")
  if (basis.files.some(file => excludedPath(file.path, basis.exclusions) || !scopeParsed.data.roots.some(root => {
    const rootKey = pathKey(root)
    const fileKey = pathKey(file.path)
    return rootKey === "." || isPathWithin(rootKey, fileKey)
  }))) return unavailable(scopeHash, baselineHash, "invalid_baseline")
  try {
    const current = readScopeFiles(root, scopeParsed.data, basis.exclusions)
    const afterBasis = ChangeScopeBasisSchema.parse({ version: basis.version, scope_sha256: scopeHash, files: current,
      exclusions: [...basis.exclusions] })
    const before = new Map(basis.files.map(file => [pathKey(file.path), file]))
    const after = new Map(current.map(file => [pathKey(file.path), file]))
    const paths = new Set([...before.keys(), ...after.keys()])
    const changed: ChangeScopeResult["changed"] = []
    for (const key of paths) {
      const oldFile = before.get(key)
      const newFile = after.get(key)
      if (!oldFile) changed.push({ path: newFile!.path, kind: "added" })
      else if (!newFile) changed.push({ path: oldFile.path, kind: "deleted" })
      else if (oldFile.sha256 !== newFile.sha256) changed.push({ path: newFile.path, kind: "modified" })
    }
    changed.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    if (changed.length > CHANGE_SCOPE_MAX_CHANGES) return unavailable(scopeHash, baselineHash, "limits_exceeded")
    const allowed = new Set(scopeParsed.data.allowed_paths.map(pathKey))
    const violated = changed.some(item => !allowed.has(pathKey(item.path))) || changed.length > scopeParsed.data.max_changed_files
    return ChangeScopeEvidenceSchema.parse({ version: 1, scope_sha256: scopeHash, before_sha256: baselineHash,
      after_sha256: sha256Json(afterBasis), status: violated ? "violated" : "within_scope", changed })
  } catch (error) {
    const code = error instanceof ScopeCaptureError ? error.code : "recapture_failed"
    return unavailable(scopeHash, baselineHash, code)
  }
}

import { createHash } from "node:crypto"
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs"
import { z } from "zod"
import { isSafeProjectRelativePath, resolveContainedPath } from "./paths.ts"

export const PreservationEvidenceSchema = z.object({
  version: z.literal(1),
  files: z.array(z.object({
    path: z.string().min(1).max(512).refine(isSafeProjectRelativePath),
    before_sha256: z.string().regex(/^[a-f0-9]{64}$/),
    after_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    status: z.enum(["pending", "unchanged", "changed", "unavailable"]),
  }).strict()).max(8),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.files.map(file => file.path)).size !== value.files.length) ctx.addIssue({ code: "custom", message: "duplicate preservation path" })
  for (const file of value.files) {
    if ((file.status === "unchanged" && file.after_sha256 !== file.before_sha256) ||
      (file.status === "changed" && (!file.after_sha256 || file.after_sha256 === file.before_sha256)) ||
      (["pending", "unavailable"].includes(file.status) && file.after_sha256 !== undefined)) {
      ctx.addIssue({ code: "custom", message: "preservation status disagrees with digests" })
    }
  }
})
export type PreservationEvidence = z.infer<typeof PreservationEvidenceSchema>

/** Bounded read of a contained regular file. No contents are persisted. */
export function projectFileDigest(root: string, path: string, maxBytes = 1024 * 1024): string {
  if (!isSafeProjectRelativePath(path)) throw new Error("Invalid evidence path")
  const full = resolveContainedPath(root, path)
  const before = lstatSync(full)
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error("Evidence requires a bounded regular file")
  const fd = openSync(full, "r")
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) throw new Error("Evidence file changed during open")
    const hash = createHash("sha256"), buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1))
    let total = 0, bytes: number
    while ((bytes = readSync(fd, buffer, 0, Math.min(buffer.length, maxBytes + 1 - total), null)) > 0) {
      total += bytes
      if (total > maxBytes) throw new Error("Evidence file exceeds byte cap")
      hash.update(buffer.subarray(0, bytes))
    }
    const after = fstatSync(fd)
    if (total !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error("Evidence file changed during read")
    return hash.digest("hex")
  } finally { closeSync(fd) }
}

export function capturePreservationBasis(root: string, paths: unknown): PreservationEvidence | undefined {
  if (paths === undefined) return undefined
  const parsed = z.array(z.string().min(1).max(512).refine(isSafeProjectRelativePath)).min(1).max(8).parse(paths)
  if (new Set(parsed).size !== parsed.length) throw new Error("Duplicate preservation path")
  return PreservationEvidenceSchema.parse({ version: 1,
    files: parsed.map(path => ({ path, before_sha256: projectFileDigest(root, path), status: "pending" })) })
}

export function finishPreservationEvidence(root: string, basis: PreservationEvidence): PreservationEvidence {
  return PreservationEvidenceSchema.parse({ version: 1, files: basis.files.map(({ path, before_sha256 }) => {
    try {
      const after_sha256 = projectFileDigest(root, path)
      return { path, before_sha256, after_sha256, status: after_sha256 === before_sha256 ? "unchanged" : "changed" }
    } catch { return { path, before_sha256, status: "unavailable" } }
  }) })
}

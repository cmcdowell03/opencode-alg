import { createHash } from "node:crypto"
import { lstatSync } from "node:fs"
import { z } from "zod"
import { canonicalContainedDirectory, isSafeProjectRelativePath, resolveContainedPath } from "./paths.ts"
import { canonicalJson } from "./persistence.ts"
import type { ShellGateDef } from "./types.ts"
import { projectFileDigest } from "./preservation-evidence.ts"
import { resolve } from "node:path"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
export const GateRecoverySchema = z.object({
  version: z.literal(1),
  output_sha256: digest,
  gate_sha256: digest,
  files_sha256: digest,
}).strict()
export type GateRecovery = z.infer<typeof GateRecoverySchema>
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex")

/** Bind only the implementer's declared files, not an assertion about the entire workspace. */
export function gateRecoveryBasis(root: string, directory: string, gate: ShellGateDef, output: unknown): GateRecovery | undefined {
  const paths = (output as { files_touched?: unknown } | undefined)?.files_touched
  if (!Array.isArray(paths) || paths.length > 500) return undefined
  try {
    let bytes = 0
    const files = [...new Set(paths)].sort().map(path => {
      if (typeof path !== "string" || !isSafeProjectRelativePath(path)) throw new Error("invalid path")
      const full = resolveContainedPath(root, path)
      let stat
      try { stat = lstatSync(full) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, absent: true }
        throw error
      }
      if (!stat.isFile() || stat.isSymbolicLink() || (bytes += stat.size) > 32 * 1024 * 1024) throw new Error("unbounded file")
      return { path, sha256: projectFileDigest(root, path, stat.size) }
    })
    return { version: 1, output_sha256: hash(canonicalJson(output)),
      gate_sha256: hash(canonicalJson({ root, directory, gate,
        resolved_cwd: canonicalContainedDirectory(root, gate.cwd ? resolve(directory, gate.cwd) : directory) })),
      files_sha256: hash(canonicalJson(files)) }
  } catch { return undefined }
}

export function sameGateRecovery(a: GateRecovery | undefined, b: GateRecovery | undefined): boolean {
  return !!a && !!b && a.version === b.version && a.output_sha256 === b.output_sha256 &&
    a.gate_sha256 === b.gate_sha256 && a.files_sha256 === b.files_sha256
}

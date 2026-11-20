import { basename } from "node:path"
import { z } from "zod"
import { isSafeProjectRelativePath } from "../../../src/paths.ts"

export const procedureDigestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const projectPathSchema = z.string().max(512).refine(isSafeProjectRelativePath)
export const procedurePinSchema = z.object({
  id: z.string().min(1).max(512),
  path: projectPathSchema.refine(path => basename(path) === "SKILL.md"),
  sha256: procedureDigestSchema,
  sourceSha256: procedureDigestSchema,
}).strict()
export type ProcedurePin = z.infer<typeof procedurePinSchema>

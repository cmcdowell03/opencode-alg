import { z } from "zod"
import { isSafeId, isSafeProjectRelativePath } from "../paths.ts"

const Id = z.string().refine(isSafeId)
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Ref = z.string().min(1).max(160).refine((value) => !/[\u0000-\u001f]/.test(value))

export const WorkspaceRequirementSchema = z.discriminatedUnion("kind", [
  z.object({ id: Id, kind: z.literal("skill"), ref: Id, intent: z.enum(["advisory", "required"]), source_revision: Hash.optional() }).strict(),
  z.object({ id: Id, kind: z.literal("document"), ref: z.string().max(512).refine(isSafeProjectRelativePath), intent: z.enum(["advisory", "required"]), sha256: Hash.optional() }).strict(),
  z.object({ id: Id, kind: z.literal("fact"), ref: Id, intent: z.enum(["advisory", "required"]), equals: Ref.optional(), source_revision: Hash.optional(), max_age_seconds: z.number().int().min(1).max(31_536_000).optional() }).strict(),
])

export const WorkspaceOperationSchema = z.object({
  id: Id, phase: z.array(Id).max(16).default([]), roles: z.array(Id).max(16).default([]),
  environments: z.array(Id).max(32).default([]), resources: z.array(Id).max(32).default([]),
  coverage: z.enum(["advisory", "qualified"]).default("advisory"), boundary: z.string().max(160).optional(),
  input_validator: Id.optional(), resource_resolver: Id.optional(),
  effects: z.array(z.enum(["discover", "read", "submit", "write"])).max(4).default([]),
  verifier_ids: z.array(Id).max(32).default([]),
  authoritative_sources: z.array(z.object({ ref: Ref, revision: Hash.optional() }).strict()).max(32).default([]),
  requirements: z.array(WorkspaceRequirementSchema).max(64).default([]),
}).strict().superRefine((operation, context) => {
  if (new Set(operation.requirements.map((entry) => entry.id)).size !== operation.requirements.length) context.addIssue({ code: "custom", message: "duplicate requirement id" })
  if (operation.coverage === "qualified" && (!operation.boundary || !operation.input_validator || !operation.resource_resolver)) context.addIssue({ code: "custom", message: "qualified coverage requires an explicit boundary, input validator, and resource resolver" })
})

export const WorkspaceRegistrySchema = z.object({ schema_version: z.literal(1), operations: z.array(WorkspaceOperationSchema).max(64) }).strict()
  .superRefine((registry, context) => {
    if (new Set(registry.operations.map((entry) => entry.id)).size !== registry.operations.length) context.addIssue({ code: "custom", message: "duplicate operation id" })
  })

export type WorkspaceRequirement = z.infer<typeof WorkspaceRequirementSchema>
export type WorkspaceOperation = z.infer<typeof WorkspaceOperationSchema>
export type WorkspaceRegistry = z.infer<typeof WorkspaceRegistrySchema>

import { z } from "zod"
import { ContextReceiptSchema, Hash, Id, SessionId } from "./schemas.ts"

const base = z.object({
  schema_version: z.literal(1), kind: z.literal("alg-context-delivery"),
  project: Hash, owner: SessionId, request_id: Id,
  request_correlation: z.literal("plugin_hook_only"),
  hook: z.enum(["system", "compaction"]),
  checkpoint: Hash, task_epoch: z.number().int().nonnegative(),
  context: ContextReceiptSchema,
  created_at: z.iso.datetime({ offset: true }),
})

export const DeliveryReceiptSchema = z.discriminatedUnion("state", [
  base.extend({ state: z.literal("prepared"), prepared_ref: z.null() }).strict(),
  base.extend({ state: z.literal("emitted"), prepared_ref: Hash }).strict(),
  base.extend({ state: z.literal("unknown"), prepared_ref: Hash,
    reason: z.enum(["hook_failed", "publication_conflict", "emission_unconfirmed"]) }).strict(),
]).superRefine((value, ctx) => {
  if (value.context.owner !== value.owner || value.context.state === "observed") {
    ctx.addIssue({ code: "custom", message: "delivery must bind the matching non-observation context" })
  }
})
export type DeliveryReceipt = z.infer<typeof DeliveryReceiptSchema>

export const DeliveryRequestHeadSchema = z.object({
  schema_version: z.literal(1), project: Hash, owner: SessionId,
  request_id: Id, receipt: Hash,
}).strict()
export const DeliveryLatestSchema = DeliveryRequestHeadSchema.omit({ receipt: true })

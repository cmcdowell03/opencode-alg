import { createHash } from "node:crypto"
import { z } from "zod"
import type { PluginInput } from "@opencode-ai/plugin"
import { redactEvolutionText } from "./skill-evolution-redaction.ts"

export const MAX_TASK_REQUEST_TEXT_BYTES = 16_384
export const MAX_TASK_REQUEST_PARTS = 256
export const TASK_REQUEST_LOOKUP_TIMEOUT_MS = 1_500

const identity = z.string().min(1).max(256).refine(value => value.trim() === value)
const digest = z.string().regex(/^[a-f0-9]{64}$/)

export const TaskRequestSnapshotSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("captured"),
    session_id: identity,
    message_id: identity,
    text: z.string().refine(value => value.trim().length > 0),
    text_sha256: digest,
    text_transformed: z.literal(false),
    non_text_parts: z.number().int().min(0).max(MAX_TASK_REQUEST_PARTS),
  }).strict().superRefine((snapshot, ctx) => {
    if (Buffer.byteLength(snapshot.text, "utf8") > MAX_TASK_REQUEST_TEXT_BYTES)
      ctx.addIssue({ code: "custom", message: "task request text exceeds byte limit" })
    if (createHash("sha256").update(snapshot.text, "utf8").digest("hex") !== snapshot.text_sha256)
      ctx.addIssue({ code: "custom", message: "task request text digest mismatch" })
  }),
  z.object({ status: z.literal("unavailable"), reason: z.enum([
    "unsupported", "lookup_failed", "identity_mismatch", "no_text", "oversized", "sensitive_content",
  ]) }).strict(),
])
export type TaskRequestSnapshot = z.infer<typeof TaskRequestSnapshotSchema>

export interface TaskRequestSource {
  sessionID: string
  messageID: string
  directory?: string
  abort?: AbortSignal
}

type MessageLookup = (options: {
  path: { id: string; messageID: string }
  query?: { directory?: string }
  throwOnError: false
  responseStyle: "fields"
  signal: AbortSignal
}) => Promise<unknown>

type UnknownRecord = Record<string, unknown>
const LOOKUP_FAILED = Symbol("task-request-lookup-failed")
function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined
}

function unavailable(reason: Extract<TaskRequestSnapshot, { status: "unavailable" }>['reason']): TaskRequestSnapshot {
  return { status: "unavailable", reason }
}

/** Inspect a bounded decoded copy; never decode or redact the retained task literal.
 * This is a conservative credential heuristic, not a general secret/DLP guarantee.
 */
function sensitiveRequest(text: string): boolean {
  let inspection = text
  for (let pass = 0; pass < 3; pass++) {
    const decoded = inspection.replace(/\\u([a-f0-9]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/(?:%[a-f0-9]{2})+/gi, encoded => { try { return decodeURIComponent(encoded) } catch { return encoded } })
    if (decoded === inspection) break
    inspection = decoded
  }
  // Public type annotations and explicit placeholders are specifications, not
  // supplied credential values. This affects inspection only, never the text.
  inspection = inspection
    .replace(/\b[\w.-]+\??:\s*(?:string|number|integer|boolean|object|array|null|undefined)(?:\[\])?(?=$|[\s,;})])(?!\s*(?:\/\*[\s\S]*?\*\/\s*|\/\/[^\r\n]*(?:\r?\n|$)\s*)*=)/gi, "schema-field")
    .replace(/\b[\w.-]+["']?\s*[:=]\s*["']?(?:<YOUR_[A-Z0-9_]+>|<REDACTED>|\$\{[A-Z][A-Z0-9_]*\})["']?(?=$|[\s,;}])/g, "placeholder-field")
  // Include prefixed environment names, JSON properties, and URL userinfo.
  const assignments = /\b[\w.-]*(?:authorization|api[-_]?key|access[-_]?key|token|cookie|secret|password|passwd|credential|private[-_]?key)[\w.-]*["']?\s*[:=]\s*\S/i
  const userinfo = /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/i
  if (assignments.test(inspection) || userinfo.test(inspection) || redactEvolutionText(inspection) !== inspection) return true
  // Inspect recognizable encoded assignments as well as the shared format detector.
  for (const match of inspection.matchAll(/[A-Za-z0-9+/_-]{24,}={0,2}/g)) {
    const decoded = Buffer.from(match[0], "base64url").toString("utf8")
    if (assignments.test(decoded) || userinfo.test(decoded) || redactEvolutionText(decoded) !== decoded) return true
  }
  return false
}

async function lookup(message: MessageLookup, source: TaskRequestSource, messageID: string): Promise<unknown | undefined | typeof LOOKUP_FAILED> {
  if (source.abort?.aborted) return undefined
  const controller = new AbortController()
  let abortResolve: (() => void) | undefined
  const abortController = () => { controller.abort(); abortResolve?.() }
  source.abort?.addEventListener("abort", abortController, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const result = await Promise.race([
      message({ path: { id: source.sessionID, messageID },
        ...(source.directory !== undefined ? { query: { directory: source.directory } } : {}),
        throwOnError: false, responseStyle: "fields", signal: controller.signal }),
      new Promise<undefined>(resolve => {
        abortResolve = () => resolve(undefined)
        timer = setTimeout(() => { controller.abort(); resolve(undefined) }, TASK_REQUEST_LOOKUP_TIMEOUT_MS)
      }),
    ])
    if (result === undefined) return undefined
    const envelope = record(result)
    if (envelope && (Object.hasOwn(envelope, "data") || Object.hasOwn(envelope, "error"))) {
      if (envelope.error != null || !Object.hasOwn(envelope, "data")) return LOOKUP_FAILED
      return envelope.data
    }
    return result
  } catch {
    return LOOKUP_FAILED
  } finally {
    if (timer) clearTimeout(timer)
    source.abort?.removeEventListener("abort", abortController)
  }
}

/** Capture the exact current message (or its exact user parent) without history search. */
export async function captureTaskRequest(
  client: PluginInput["client"],
  source: TaskRequestSource,
): Promise<TaskRequestSnapshot> {
  if (!identity.safeParse(source.sessionID).success || !identity.safeParse(source.messageID).success)
    return unavailable("identity_mismatch")
  const method = (client.session as unknown as { message?: MessageLookup } | undefined)?.message
  if (typeof method !== "function") return unavailable("unsupported")

  const firstResult = await lookup(method.bind(client.session), source, source.messageID)
  if (firstResult === undefined || firstResult === LOOKUP_FAILED) return unavailable("lookup_failed")
  const first = record(firstResult)
  const firstInfo = record(first?.info)
  if (!first || !firstInfo || firstInfo.sessionID !== source.sessionID || firstInfo.id !== source.messageID ||
    (firstInfo.role !== "user" && firstInfo.role !== "assistant")) return unavailable("identity_mismatch")

  let userMessage = first
  let userMessageId = firstInfo.id as string
  if (firstInfo.role === "assistant") {
    if (typeof firstInfo.parentID !== "string" || !identity.safeParse(firstInfo.parentID).success)
      return unavailable("identity_mismatch")
    const parentResult = await lookup(method.bind(client.session), source, firstInfo.parentID)
    if (parentResult === undefined || parentResult === LOOKUP_FAILED) return unavailable("lookup_failed")
    const parent = record(parentResult)
    const parentInfo = record(parent?.info)
    if (!parent || !parentInfo || parentInfo.sessionID !== source.sessionID || parentInfo.id !== firstInfo.parentID || parentInfo.role !== "user")
      return unavailable("identity_mismatch")
    userMessage = parent
    userMessageId = parentInfo.id as string
  }

  if (!Array.isArray(userMessage.parts)) return unavailable("identity_mismatch")
  if (userMessage.parts.length > MAX_TASK_REQUEST_PARTS) return unavailable("oversized")
  const pieces: string[] = []
  let nonTextParts = 0
  let rawBytes = 0
  for (const value of userMessage.parts) {
    const part = record(value)
    if (!part || part.type !== "text") { nonTextParts++; continue }
    if ((part.sessionID !== undefined && part.sessionID !== source.sessionID) ||
      (part.messageID !== undefined && part.messageID !== userMessageId)) return unavailable("identity_mismatch")
    if (typeof part.text !== "string") return unavailable("identity_mismatch")
    rawBytes += Buffer.byteLength(part.text, "utf8")
    if (rawBytes > MAX_TASK_REQUEST_TEXT_BYTES) return unavailable("oversized")
    pieces.push(part.text)
  }
  if (!pieces.length) return unavailable("no_text")
  const rawText = pieces.join("\n")
  if (!rawText.trim().length) return unavailable("no_text")
  if (Buffer.byteLength(rawText, "utf8") > MAX_TASK_REQUEST_TEXT_BYTES) return unavailable("oversized")
  if (sensitiveRequest(rawText)) return unavailable("sensitive_content")
  return TaskRequestSnapshotSchema.parse({
    status: "captured", session_id: source.sessionID, message_id: userMessageId,
    text: rawText, text_sha256: createHash("sha256").update(rawText, "utf8").digest("hex"),
    text_transformed: false, non_text_parts: nonTextParts,
  })
}

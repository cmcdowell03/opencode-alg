import type { Plugin } from "@opencode/plugin"
import { posix, win32 } from "node:path"
import { z } from "zod"
import { TOOL } from "./host.ts"

export type DeliveryHistory = Readonly<Awaited<ReturnType<Plugin.Context["session"]["context"]>>>
type User = Extract<DeliveryHistory[number], { type: "user" }>
type Assistant = Extract<DeliveryHistory[number], { type: "assistant" }>
type ToolPart = Extract<Assistant["content"][number], { type: "tool" }>

const maxHistory = 512
const maxParts = 2048
const maxTextBytes = 16_384
const maxTotalBytes = 512 * 1024
const maxFields = 24
const id = z.string().min(1).max(256)
const digest = z.string().regex(/^[a-f0-9]{64}$/)
const revision = z.number().int().positive()
const settled = z.enum(["result_recorded", "reusable"])
const bindingSchema = z.strictObject({
  parentJournalPath: z.string().min(1).max(2048).refine(path =>
    !/[\u0000-\u001f]/.test(path) && (posix.isAbsolute(path) || win32.isAbsolute(path))),
  ownerSessionId: id,
  projectId: id,
  ownerAgent: id,
  decision_revision: revision,
  next_action: z.string().min(1).max(1024),
  work: z.strictObject({ work_key: digest, manifest_digest: digest, status: settled }),
  approval: z.strictObject({ revision: digest, procedure_sha256: digest }),
  runtimeSha256: digest,
})

/**
 * Supply the canonical parent journal path and history for the same verified root
 * session. Supply approval only after checking the current decision's durable pin
 * against live approval. The native decision receipt does not expose that pin.
 */
export type DeliveryBinding = z.input<typeof bindingSchema>

const key = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/)
  .refine(name => !["__proto__", "constructor", "prototype"].includes(name))
const token = z.string().max(256).regex(/^[\p{L}\p{N}][\p{L}\p{N}_.:/@#%+?=&~-]*$/u)
const scalar = z.union([z.null(), z.boolean(), z.number().refine(n =>
  Number.isFinite(n) && !Object.is(n, -0) && (!Number.isInteger(n) || Number.isSafeInteger(n))), token])
const fields = z.array(key).min(1).max(maxFields)
const answerSchema = z.record(key, scalar)
const anchorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("user"), messageId: id }),
  z.strictObject({ kind: z.literal("tool"), messageId: id, callId: id }),
])

function conflictsWithAction(value: Record<string, unknown>, action: string): boolean {
  // A recorded action can include structured qualifiers after its identifier.
  const qualified = /^([\w-]+)(?:;\s*[\w-]+=[\w.-]+)+$/.exec(action)
  return ["nextAction", "next_action"].some(name =>
    Object.hasOwn(value, name) && value[name] !== action && value[name] !== qualified?.[1])
}

function refKey(name: string): boolean {
  return /(?:^|[_-])(?:refs?|references?|citations?|sources?|urls?|uris?|links?|digests?|sha256)(?:$|[_-])/i.test(name) ||
    /(?:Refs?|References?|Citations?|Sources?|URLs?|Urls?|URIs?|Uris?|Links?|Digests?|Sha256)$/.test(name)
}

export const deliverySchema = z.strictObject({
  version: z.literal(1),
  binding: bindingSchema,
  compactionMessageId: id.optional(),
  requestMessageId: id,
  decisionMessageId: id,
  decisionCallId: id,
  answerMessageId: id,
  requestedKeys: fields,
  nullableReferences: z.array(key).max(maxFields),
  recordedAnswer: answerSchema,
  recordedReferences: z.record(key, anchorSchema),
}).superRefine((receipt, ctx) => {
  const { requestedKeys, nullableReferences, recordedAnswer, recordedReferences } = receipt
  const refs = requestedKeys.filter(refKey)
  const anchored = refs.filter(name => typeof recordedAnswer[name] === "string")
  if (!sameKeys(requestedKeys, recordedAnswer) || !sameKeys(anchored, recordedReferences) ||
      conflictsWithAction(recordedAnswer, receipt.binding.next_action) ||
      new Set(nullableReferences).size !== nullableReferences.length ||
      nullableReferences.some(name => !refs.includes(name)) ||
      refs.some(name => typeof recordedAnswer[name] !== "string" &&
        !(recordedAnswer[name] === null && nullableReferences.includes(name))) ||
      Object.values(recordedReferences).some(anchor => anchor.messageId === receipt.answerMessageId) ||
      Buffer.byteLength(JSON.stringify(recordedAnswer)) > 4096) {
    ctx.addIssue({ code: "custom", message: "Invalid recorded report or citation coverage" })
  }
})

/** The binding is host-verified. The answer and source references are recorded claims. */
export type DeliveryReceipt = z.output<typeof deliverySchema>
export type DeliveryInspection = { receipt: DeliveryReceipt } | {
  reason: "no_contract" | "invalid_binding" | "stale_revision" | "missing_evidence" | "changed_request" | "oversize"
}

function sameKeys(keys: readonly string[], value: Record<string, unknown>): boolean {
  return new Set(keys).size === keys.length && keys.length === Object.keys(value).length &&
    keys.every(name => Object.hasOwn(value, name))
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function json(text: string): Record<string, unknown> | undefined {
  try { return object(JSON.parse(text)) } catch { return undefined }
}

// Match the entire flat object and use the decoded keys to reject duplicates.
const jsonString = /"(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4}))*"/.source
const jsonScalar = '(?:' + jsonString + '|null|true|false|-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)'
const jsonMember = '(' + jsonString + ')\\s*:\\s*' + jsonScalar
const flatObject = new RegExp('^\\{\\s*' + jsonMember + '(?:\\s*,\\s*' + jsonMember + ')*\\s*\\}$')
function unfence(text: string): string {
  return /^\x60\x60\x60(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\x60\x60\x60$/i.exec(text.trim())?.[1]?.trim() ?? text.trim()
}

function flat(text: string) {
  const body = unfence(text)
  if (Buffer.byteLength(body) > 4096 || !flatObject.test(body)) return undefined
  const value = answerSchema.safeParse(json(body))
  const keys = Array.from(body.matchAll(new RegExp(jsonMember, "g")), match => JSON.parse(match[1]!) as string)
  return value.success && sameKeys(keys, value.data) && fields.safeParse(keys).success ? value.data : undefined
}

function obligation(text: string) {
  const recurring = /\b(?:for\s+(?:each|every)\s+(?:decision|report|update|turn|response|continuation)|(?:on|after)\s+(?:each|every)\s+(?:decision|update|turn|response|continuation)|(?:when(?:ever)?|each time)\s+(?:I\s+(?:ask\s+(?:you\s+)?to\s+)?continue|you\s+continue)|(?:on|upon)\s+(?:continuation|resumption))\b/i
  const format = /\bJSON\s+(?:object|report)\b/i
  const carry = /\b(?:keep|retain|reuse|preserve|repeat|maintain|use)\s+(?:(?:this|the|the same|that|my)\s+)?(?:output contract|(?:JSON\s+)?(?:report|output)\s+format)\b/i
  const clauses = text.split(/[.!?\r\n]+/)
  if (!format.test(text) || !clauses.some(clause => recurring.test(clause) &&
      (format.test(clause) || carry.test(clause)))) return undefined
  const list = /\bJSON\s+(?:object|report)\s+with\s+(?:(?:the\s+)?(?:fields|keys)\s*:?\s+)?([^.!?\r\n]+)/gi
  const declared = [...text.matchAll(list)]
  if (declared.length === 1) {
    const members = declared[0]![1]!.split(/\s*,\s*|\s+and\s+/).map(value =>
      /^(?:and\s+)?[`"]?([\w-]+)[`"]?(?:\s*\((null\b[^()]*)\))?$/i.exec(value.trim()))
    const keys = members.map(member => member?.[1])
    const checked = fields.safeParse(keys)
    if (checked.success && new Set(keys).size === keys.length) {
      return { keys: checked.data, nullable: members.flatMap(m => m?.[2] && refKey(m[1]!) ? [m[1]!] : []) }
    }
    return undefined
  }
  if (declared.length > 1) return undefined
  const examples = [...text.matchAll(/\{[^{}\r\n]*\}|\x60\x60\x60json[^\S\r\n]*\r?\n([\s\S]*?)\r?\n\x60\x60\x60/gi)]
  if (examples.length !== 1) return undefined
  const example = flat(examples[0]![1] ?? examples[0]![0])
  if (example) return { keys: Object.keys(example), nullable: Object.keys(example).filter(k => refKey(k) && example[k] === null) }
}

const bare = /^continue[.!]?$/i
const plainUser = (message: User) => !message.files?.length && !message.agents?.length && !message.skills?.length
const ackSchema = z.object({
  ok: z.literal(true), runtimeSha256: digest, revision, decision_revision: revision,
  decision: z.object({ next_action: z.string() }),
  work: z.object({ work_key: digest, status: z.string(), manifest_digest: digest.optional() }).nullable(),
})

function completedText(part: ToolPart): string | undefined {
  if (part.executed === true || part.state.status !== "completed" || part.time.completed === undefined ||
      part.state.content.length !== 1) return undefined
  const result = part.state.content[0]
  if (result?.type === "text") return result.text
}

type Anchor = z.output<typeof anchorSchema>
function collectReferences(value: unknown, anchor: Anchor, refs: Map<string, Anchor>) {
  const nodes: unknown[] = [value]
  while (nodes.length) {
    const node = nodes.pop()
    if (Array.isArray(node)) nodes.push(...node)
    else for (const [name, field] of Object.entries(object(node) ?? {})) {
      if (refKey(name) && typeof field === "string" && token.safeParse(field).success) refs.set(field, anchor)
      if (field !== null && typeof field === "object") nodes.push(field)
    }
  }
}

function handoff(text: string) {
  // A plain data object, optionally introduced by a single Markdown-style title.
  const title = /^(?:#{1,6} )?[\p{L}\p{N}][\p{L}\p{N} _-]{0,95}\r?\n/u.exec(text)
  const data = json(unfence(title ? text.slice(title[0].length) : text))
  if (!data || !Object.keys(data).length) return undefined
  return data
}

export function inspectDelivery(history: DeliveryHistory, input: DeliveryBinding): DeliveryInspection {
  const missing = { reason: "missing_evidence" } as const
  const oversize = { reason: "oversize" } as const
  const changed = { reason: "changed_request" } as const
  const parsed = bindingSchema.safeParse(input)
  if (!parsed.success) return { reason: "invalid_binding" }
  const binding = parsed.data
  if (history.length > maxHistory) return oversize

  // With a continuation present, use only the prefix preceding its completed
  // compaction. A hook can also pass that prefix directly.
  let end = history.length
  let boundaryId: string | undefined
  const last = history.at(-1)
  if (last?.type === "compaction" && last.status !== "failed") {
    boundaryId = last.id
    end--
  }
  if (last?.type === "user" && plainUser(last) && bare.test(last.text.trim())) {
    let before = end - 2
    while (history[before]?.type === "idle") before--
    const boundary = history[before]
    if (boundary?.type !== "compaction" || boundary.status !== "completed") return missing
    end = before
    boundaryId = boundary.id
  }

  let bytes = 0
  let parts = 0
  const bounded = (text: string) => {
    if (text.length > maxTextBytes) return false
    const size = Buffer.byteLength(text)
    bytes += size
    return size <= maxTextBytes && bytes <= maxTotalBytes
  }
  const refs = new Map<string, Anchor>()
  const messageIds = new Set<string>()
  const callIds = new Set<string>()
  let original: { id: string; format: NonNullable<ReturnType<typeof obligation>> } | undefined
  let turn = -1
  const correctedRefs = new Map<string, string>()
  let ack: { turn: number; messageId: string; callId: string; revision: number; exact: boolean } | undefined
  let repeat: z.output<typeof answerSchema> | undefined
  let answer: { messageId: string; value: z.output<typeof answerSchema>; anchors: Record<string, Anchor> } | undefined

  for (let index = 0; index < end; index++) {
    const message = history[index]!
    if (!id.safeParse(message.id).success || messageIds.has(message.id)) return missing
    messageIds.add(message.id)
    if (message.type === "location-switched") return missing
    if (message.type === "user") {
      if (!bounded(message.text)) return oversize
      if (!plainUser(message)) return changed
      if (bare.test(message.text.trim())) {
        turn = -1
        answer = undefined
        continue
      }
      turn = index
      repeat ??= answer?.value
      answer = undefined
      if (!original) {
        const format = obligation(message.text)
        if (!format) return { reason: "no_contract" }
        original = { id: message.id, format }
      } else {
        const data = handoff(message.text)
        if (!data || obligation(message.text) || Object.keys(data).some(name => original!.format.keys.includes(name) && !refKey(name))) return changed
        const anchor = { kind: "user", messageId: message.id } as const
        const supplied = new Map<string, Anchor>()
        collectReferences(data, anchor, supplied)
        if (!supplied.size) return changed
        for (const [value, source] of supplied) refs.set(value, source)
        for (const name of original.format.keys.filter(refKey)) {
          if (!Object.hasOwn(data, name)) continue
          const value = data[name]
          if (typeof value !== "string" || !supplied.has(value)) return changed
          correctedRefs.set(name, value)
        }
      }
      continue
    }
    if (message.type === "idle" && message.outcome !== "succeeded") answer = undefined
    if (message.type !== "assistant" || !original) continue
    parts += message.content.length
    if (parts > maxParts) return oversize
    let text = ""
    let hasTool = false
    for (const part of message.content) {
      if (part.type === "text") {
        if (!bounded(part.text)) return oversize
        text += part.text
      }
      if (part.type !== "tool") continue
      hasTool = true
      if (!id.safeParse(part.id).success || callIds.has(part.id)) return missing
      callIds.add(part.id)
      const raw = completedText(part)
      if (raw === undefined) continue
      if (!bounded(raw)) return oversize
      const data = json(raw)
      if (part.state.status !== "completed" || message.error || !data) continue
      if (part.name !== TOOL) {
        if (data.ok !== false) collectReferences(data, { kind: "tool", messageId: message.id, callId: part.id }, refs)
        continue
      }
      const args = part.state.input
      if (args.action !== "set_next_measurement" || data.ok !== true) continue
      const checked = ackSchema.safeParse(data)
      if (message.agent !== binding.ownerAgent || !checked.success || JSON.stringify(data) !== raw ||
          checked.data.runtimeSha256 !== binding.runtimeSha256 ||
          args.expected_decision_revision !== checked.data.decision_revision - 1 ||
          args.next_action !== checked.data.decision.next_action ||
          checked.data.revision < checked.data.decision_revision) return missing
      const result = checked.data
      if (ack && ack.revision >= result.decision_revision) return missing
      ack = { turn, messageId: message.id, callId: part.id, revision: result.decision_revision,
        exact: result.decision.next_action === binding.next_action &&
          settled.safeParse(result.work?.status).success && result.work?.work_key === binding.work.work_key &&
          result.work?.manifest_digest === binding.work.manifest_digest }
      repeat = undefined
      answer = undefined
    }
    if (!text.trim() || hasTool || !ack || (ack.turn !== turn && !repeat)) continue
    answer = undefined
    if (message.agent !== binding.ownerAgent || message.error || message.finish !== "stop" ||
        message.time.completed === undefined) continue
    if (Buffer.byteLength(text) > 4096) return oversize
    const value = flat(text)
    if (!value || !sameKeys(original.format.keys, value) ||
        [...correctedRefs].some(([name, corrected]) => value[name] !== corrected) ||
        (ack.turn !== turn && original.format.keys.some(name => !Object.is(value[name], repeat?.[name])))) continue
    const anchors: Record<string, Anchor> = {}
    for (const name of original.format.keys.filter(refKey)) {
      const item = value[name]
      const anchor = typeof item === "string" ? refs.get(item) : undefined
      if (anchor) anchors[name] = anchor
    }
    answer = { messageId: message.id, value, anchors }
  }

  if (ack && ack.revision !== binding.decision_revision) return { reason: "stale_revision" }
  if (!original) return { reason: "no_contract" }
  if (!ack?.exact || !answer) return missing
  const receipt = deliverySchema.safeParse({
    version: 1, binding, ...(boundaryId ? { compactionMessageId: boundaryId } : {}), requestMessageId: original.id,
    decisionMessageId: ack.messageId, decisionCallId: ack.callId, answerMessageId: answer.messageId,
    requestedKeys: original.format.keys, nullableReferences: original.format.nullable,
    recordedAnswer: answer.value, recordedReferences: answer.anchors,
  })
  return receipt.success ? { receipt: receipt.data } : missing
}

export function captureDelivery(history: DeliveryHistory, binding: DeliveryBinding): DeliveryReceipt | undefined {
  const result = inspectDelivery(history, binding)
  return "receipt" in result ? result.receipt : undefined
}

/** Validate a previously captured receipt against live state and the completed native boundary. */
export function validateDelivery(value: unknown, input: DeliveryBinding, compactionMessageId: string): DeliveryReceipt | undefined {
  const receipt = deliverySchema.safeParse(value)
  const binding = bindingSchema.safeParse(input)
  if (receipt.success && binding.success && receipt.data.compactionMessageId === compactionMessageId &&
      JSON.stringify(receipt.data.binding) === JSON.stringify(binding.data)) return receipt.data
}

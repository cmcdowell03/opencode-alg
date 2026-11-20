import { createHash } from "node:crypto"
import { z } from "zod"
import type { DeliveryHistory } from "./delivery.ts"

const maxRows = 1024
const maxBytes = 512 * 1024
const key = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/)
  .refine(name => !["__proto__", "prototype", "constructor"].includes(name))
const token = z.string().min(1).max(256)
const scalar = z.union([z.null(), z.boolean(), z.string().max(4096), z.number().refine(value =>
  Number.isFinite(value) && !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value)))])
type Row = Record<string, z.output<typeof scalar>>
const distinct = (names: readonly string[]) => new Set(names).size === names.length
const fields = z.array(key).min(1).max(8).refine(distinct)
const size = z.number().int().min(0).max(maxRows).refine(value => !Object.is(value, -0))
const limit = size.min(1)
const predicate = z.strictObject({ field: key, equals: scalar })
const operation = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("count") }),
  z.strictObject({ kind: z.literal("filteredCount"), where: predicate }),
  z.strictObject({ kind: z.literal("semijoinCount"), where: predicate, ownerKey: fields, correctionKey: fields }),
])
const policySchema = z.strictObject({
  version: z.literal(1),
  owner: z.strictObject({
    tool: token, source: token, sourceKey: key, referenceKey: key, reportReferenceField: key,
    rowsKey: key, offsetKey: key, limitKey: key, exhaustedKey: key.optional(),
    pagesKey: key.optional(), cursorKey: key.optional(), totalRowsKey: key.optional(), nextCursorKey: key.optional(),
    limits: z.array(limit).min(1).max(16).refine(limits =>
      limits.every((value, index) => index === 0 || value > limits[index - 1]!)),
    rowKey: fields,
    qualify: predicate.extend({ minMatches: limit.optional() }),
  }),
  correction: z.strictObject({
    header: token.refine(header => !/[\r\n]/.test(header) && !/^continue[.!]?$/i.test(header.trim())),
    referenceKey: key, reportReferenceField: key, rowsKey: key, rowKey: fields,
  }),
  operations: z.record(key, operation),
}).refine(({ owner, correction, operations }) => {
  const names = Object.keys(operations)
  return names.length > 0 && names.length <= 24 &&
    distinct([...names, owner.reportReferenceField, correction.reportReferenceField]) &&
    distinct([owner.sourceKey, owner.referenceKey, owner.rowsKey, owner.offsetKey, owner.limitKey,
      owner.exhaustedKey ?? "exhausted", ...(owner.totalRowsKey ? [owner.totalRowsKey] : []),
      ...(owner.nextCursorKey ? [owner.nextCursorKey] : [])]) &&
    (!!owner.exhaustedKey || !!owner.totalRowsKey) &&
    (!owner.cursorKey || distinct([owner.sourceKey, owner.limitKey, owner.cursorKey])) &&
    correction.referenceKey !== correction.rowsKey &&
    Object.values(operations).every(op => op.kind !== "semijoinCount" ||
      op.ownerKey.length === op.correctionKey.length)
})

export type CalculationPolicy = z.output<typeof policySchema>

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]"
  const record = object(value)
  if (!record) return JSON.stringify(value)
  return "{" + Object.keys(record).sort().filter(name => record[name] !== undefined)
    .map(name => JSON.stringify(name) + ":" + canonical(record[name])).join(",") + "}"
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

export function calculationPolicyDigest(policy: CalculationPolicy): string {
  return digest(policy)
}

// Scan keys before JSON.parse can silently replace a duplicate decoded member.
function json(text: string): unknown {
  const token = /[ \t\r\n]*("(?:[^"\\\u0000-\u001f]|\\(?:["\\/bfnrt]|u[\da-fA-F]{4}))*"|[{}\[\]:,]|true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y
  const next = () => token.exec(text)?.[1]
  let current = next()
  function take(expected: string) {
    if (current !== expected) throw new Error("invalid JSON")
    current = next()
  }
  function scan(depth: number) {
    if (depth > 12 || current === undefined) throw new Error("invalid JSON")
    if (current === "{") {
      const names = new Set<string>()
      take("{")
      if (current as string !== "}") {
        do {
          if (!current?.startsWith('"')) throw new Error("invalid member")
          const name = JSON.parse(current) as string
          if (names.has(name)) throw new Error("duplicate member")
          names.add(name)
          current = next()
          take(":")
          scan(depth + 1)
          if (current !== ",") break
          take(",")
        } while (true)
      }
      take("}")
    } else if (current === "[") {
      take("[")
      if (current as string !== "]") {
        do {
          scan(depth + 1)
          if ((current as string) !== ",") break
          take(",")
        } while (true)
      }
      take("]")
    } else {
      if ([",", ":", "]", "}"].includes(current)) throw new Error("invalid value")
      current = next()
    }
  }
  scan(0)
  return JSON.parse(text)
}

/** Parse a single top-level calculation fence from caller-verified approved skill content. */
export function parseCalculationPolicy(skillContent: string): CalculationPolicy | undefined {
  try {
    if (skillContent.length > maxBytes || Buffer.byteLength(skillContent) > maxBytes) return
    const lines = skillContent.split(/\r?\n/)
    let open: { marker: string; length: number; calculation: boolean; start: number } | undefined
    let body: string | undefined
    for (const [index, line] of lines.entries()) {
      const fence = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line)
      if (!fence) continue
      const [, marker = "", info = ""] = fence
      if (!open) {
        const calculation = info.trim() === "alg-calculation"
        if (calculation && body !== undefined) return
        open = { marker: marker[0]!, length: marker.length, calculation, start: index + 1 }
      } else if (open.marker === marker[0] && marker.length >= open.length && !info.trim()) {
        if (open.calculation) body = lines.slice(open.start, index).join("\n")
        open = undefined
      }
    }
    if (body === undefined || open?.calculation || body.length > 16_384) return
    const result = policySchema.safeParse(json(body))
    if (result.success) return result.data
  } catch {
    return undefined
  }
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const sourceEvidence = {
  reference: token, reportReferenceField: key, rowsSha256: sha256, rowCount: size, messageId: token,
}
const receiptPayload = z.strictObject({
  status: z.enum(["verified", "incomplete"]),
  values: z.record(key, size),
  sources: z.strictObject({
    owner: z.strictObject({ ...sourceEvidence, callId: token, source: token, tool: token, agent: token, limit }).optional(),
    correction: z.strictObject(sourceEvidence).optional(),
  }),
  recipeSha256: sha256.nullable(),
})
export const calculationReceiptSchema = receiptPayload.extend({ proofSha256: sha256 }).refine(receipt => {
  const { proofSha256, ...payload } = receipt
  const { owner, correction } = receipt.sources
  const names = Object.keys(receipt.values)
  return names.length <= 24 && (!names.length || !!owner) &&
    (!owner || (!!receipt.recipeSha256 && owner.rowCount <= owner.limit &&
      names.every(name => receipt.values[name]! <= owner.rowCount && name !== owner.reportReferenceField))) &&
    (!correction || (!!owner && receipt.status === "verified" && correction.messageId !== owner.messageId &&
      correction.reference !== owner.reference && correction.reportReferenceField !== owner.reportReferenceField &&
      !names.includes(correction.reportReferenceField))) &&
    (receipt.status !== "verified" || names.length > 0) && proofSha256 === digest(payload)
})

export type CalculationReceipt = z.output<typeof calculationReceiptSchema>

/** Check structural integrity and deterministic identity of a captured receipt. */
export function validateCalculationReceipt(receipt: unknown): receipt is CalculationReceipt {
  try {
    return calculationReceiptSchema.safeParse(receipt).success
  } catch {
    return false
  }
}

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("incomplete evidence")
  return value
}

function field(row: Row, name: string) {
  return required(Object.hasOwn(row, name) ? row[name] : undefined)
}

function tuple(row: Row, keys: readonly string[]): string {
  return canonical(keys.map(name => field(row, name)))
}

function uniqueKeys(rows: Row[], keys: readonly string[]): Set<string> {
  const values = new Set(rows.map(row => tuple(row, keys)))
  if (values.size !== rows.length) throw new Error("duplicate row key")
  return values
}

const rowSchema = z.record(key, scalar)
function readRows(input: unknown, rowKey: string[]): Row[] {
  if (!Array.isArray(input) || input.length > maxRows) throw new Error("invalid rows")
  const rows = input.map(value => {
    const row = required(object(value))
    if (Object.keys(row).length > 64) throw new Error("oversize row")
    return rowSchema.parse(row)
  })
  uniqueKeys(rows, rowKey)
  return rows
}

function matches(row: Row, filter: z.output<typeof predicate>): boolean {
  return field(row, filter.field) === filter.equals
}

type Source = CalculationReceipt["sources"]
type OwnerPage = { position: number; rows: Row[]; evidence: NonNullable<Source["owner"]>; exhausted: boolean; total?: number }
type Audit = { position: number; rows: Row[]; evidence: NonNullable<Source["correction"]> }
const continuation = /^continue[.!]?$/i

/** Calculate using native history from the verified owner session. */
export function calculateFromHistory(
  policy: CalculationPolicy | undefined, history: DeliveryHistory, ownerAgent: string,
): CalculationReceipt {
  let recipeSha256: string | null = null
  const values: Record<string, number> = {}
  const sources: Source = {}
  const finish = (status: CalculationReceipt["status"] = "incomplete"): CalculationReceipt => {
    const payload = { status, values, sources, recipeSha256 }
    return { ...payload, proofSha256: digest(payload) }
  }
  try {
    const checked = policySchema.safeParse(policy)
    if (!checked.success) return finish()
    policy = checked.data
    recipeSha256 = calculationPolicyDigest(policy)
    if (!token.safeParse(ownerAgent).success || history.length > 512) return finish()
    const { owner, correction, operations } = policy
    const pages: OwnerPage[] = []
    const messageIds = new Set<string>()
    const callIds = new Set<string>()
    let active = false
    let corruptedAudit = false
    let corruptedOwner = false
    let audit: Audit | undefined
    let remainingBytes = maxBytes
    let parts = 0
    function decode(raw: string) {
      if (raw.length > remainingBytes) throw new Error("oversize evidence")
      remainingBytes -= Buffer.byteLength(raw)
      if (remainingBytes < 0) throw new Error("oversize evidence")
      return required(object(json(raw)))
    }
    for (const [position, message] of history.entries()) {
      if (!token.safeParse(message.id).success || messageIds.has(message.id)) return finish()
      messageIds.add(message.id)
      if (message.type === "compaction" || message.type === "location-switched") {
        active = false
        pages.length = 0
        audit = undefined
        continue
      }
      if (message.type === "user") {
        const end = message.text.indexOf("\n")
        const header = end < 0 ? message.text : message.text.slice(0, end).replace(/\r$/, "")
        const plain = !message.files?.length && !message.agents?.length && !message.skills?.length
        if (header !== correction.header) {
          if (plain && message.text.length <= 32 && continuation.test(message.text.trim())) continue
          active = true
          pages.length = 0
          audit = undefined
          corruptedOwner = false
          corruptedAudit = false
          continue
        }
        if (!active) continue
        try {
          if (!plain || end < 0 || message.text.length > maxBytes) throw new Error("invalid correction")
          const body = message.text.slice(end + 1).trim()
          const data = decode(/^\x60{3}json[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}$/.exec(body)?.[1] ?? body)
          const rows = readRows(data[correction.rowsKey], correction.rowKey)
          const reference = token.parse(data[correction.referenceKey])
          const rowsSha256 = digest(rows)
          if (audit && (audit.evidence.reference !== reference || audit.evidence.rowsSha256 !== rowsSha256)) {
            throw new Error("conflicting correction")
          }
          audit ??= { rows, position, evidence: { reference, rowsSha256, rowCount: rows.length,
            messageId: message.id, reportReferenceField: correction.reportReferenceField } }
        } catch {
          corruptedAudit = true
        }
        continue
      }
      if (!active || message.type !== "assistant" || message.agent !== ownerAgent) continue
      parts += message.content.length
      if (parts > 2048) return finish()
      for (const part of message.content) {
        if (part.type !== "tool" || part.name !== owner.tool) continue
        if (!token.safeParse(part.id).success || callIds.has(part.id)) return finish()
        callIds.add(part.id)
        if (part.executed === true || part.state.status !== "completed" || part.time.completed === undefined || message.error) continue
        const input = object(part.state.input)
        const request = owner.pagesKey ? input?.[owner.pagesKey] : [input]
        if (!Array.isArray(request) || request.length > 16) continue
        const selected = request.map(object).filter(entry => entry?.[owner.sourceKey] === owner.source)
        if (!selected.length) continue
        try {
          if (selected.length !== 1) throw new Error("ambiguous page request")
          const args = selected[0]!
          // Only a native offset-zero request can establish the selected observed prefix.
          const fromStart = owner.cursorKey ? args[owner.cursorKey] == null &&
            (args[owner.offsetKey] === undefined || args[owner.offsetKey] === 0) : args[owner.offsetKey] === 0
          if (!fromStart) continue
          const output = part.state.content[0]
          if (part.state.content.length !== 1 || output?.type !== "text") throw new Error("invalid tool result")
          const data = decode(output.text)
          if (data.ok === false || (Object.hasOwn(data, "status") && data.status !== "ok")) continue
          const response = owner.pagesKey ? data[owner.pagesKey] : [data]
          if (!Array.isArray(response) || response.length > 16) throw new Error("invalid page response")
          const records = response.map(object).filter(entry => entry?.[owner.sourceKey] === owner.source)
          if (records.length !== 1) throw new Error("changed page source")
          const record = records[0]!
          const requested = limit.parse(args[owner.limitKey])
          if (!owner.limits.includes(requested) || !Object.is(record[owner.offsetKey], 0) ||
              ((owner.exhaustedKey || Object.hasOwn(record, owner.limitKey)) && record[owner.limitKey] !== requested)) {
            throw new Error("unexpected page bounds")
          }
          const rows = readRows(record[owner.rowsKey], owner.rowKey)
          const total = owner.totalRowsKey ? z.number().int().nonnegative().parse(record[owner.totalRowsKey]) : undefined
          const exhaustedKey = owner.exhaustedKey ?? "exhausted"
          const echoed = owner.exhaustedKey || Object.hasOwn(record, exhaustedKey)
            ? z.boolean().parse(record[exhaustedKey]) : undefined
          const exhausted = total === undefined ? required(echoed) : rows.length === total
          if (owner.nextCursorKey) {
            const next = token.nullable().parse(record[owner.nextCursorKey])
            if ((next === null) !== exhausted) throw new Error("contradictory next cursor")
          }
          if ((echoed !== undefined && echoed !== exhausted) || rows.length > requested ||
              (!exhausted && rows.length !== requested) ||
              (total !== undefined && rows.length !== Math.min(total, requested))) {
            throw new Error("invalid exhaustion")
          }
          const reference = token.parse(record[owner.referenceKey])
          pages.push({ position, rows, exhausted, total, evidence: { reference, rowsSha256: digest(rows),
            rowCount: rows.length, messageId: message.id, callId: part.id, source: owner.source, tool: owner.tool, agent: ownerAgent,
            limit: requested, reportReferenceField: owner.reportReferenceField } })
        } catch {
          corruptedOwner = true
        }
      }
    }
    if (!active || corruptedOwner || !pages.length) return finish()
    pages.sort((left, right) => left.evidence.limit - right.evidence.limit)
    const longest = pages.at(-1)!
    const longestRows = longest.rows.map(canonical)
    const limitReferences = new Map<number, string>()
    for (const page of pages) {
      const { reference, limit } = page.evidence
      const prior = limitReferences.get(limit)
      if ((prior !== undefined && prior !== reference) ||
          page.rows.length !== Math.min(limit, longest.rows.length) ||
          page.total !== longest.total ||
          page.exhausted !== (longest.exhausted && page.rows.length === longest.rows.length) ||
          page.rows.some((row, index) => canonical(row) !== longestRows[index])) return finish()
      limitReferences.set(limit, reference)
    }
    let selected: OwnerPage | undefined
    for (const limit of owner.limits) {
      const page = pages.find(page => page.evidence.limit === limit)
      if (!page) return finish()
      if (page.rows.filter(row => matches(row, owner.qualify)).length >= (owner.qualify.minMatches ?? 1)) {
        selected = page
        break
      }
      if (page.exhausted) return finish()
    }
    if (!selected) return finish()
    const base: Record<string, number> = {}
    for (const [name, op] of Object.entries(operations)) {
      if (op.kind === "semijoinCount") continue
      base[name] = op.kind === "count" ? selected.rows.length : selected.rows.filter(row => matches(row, op.where)).length
    }
    sources.owner = selected.evidence
    Object.assign(values, base)
    const joins = Object.entries(operations).filter((entry) => entry[1].kind === "semijoinCount")
    if (!joins.length) return finish("verified")
    if (corruptedAudit || !audit || audit.position <= selected.position || audit.evidence.reference === selected.evidence.reference) {
      return finish()
    }
    const joined: Record<string, number> = {}
    for (const [name, op] of joins) {
      if (op.kind !== "semijoinCount") continue
      uniqueKeys(audit.rows, op.correctionKey)
      const lookup = uniqueKeys(audit.rows.filter(row => matches(row, op.where)), op.correctionKey)
      uniqueKeys(selected.rows, op.ownerKey)
      joined[name] = selected.rows.filter(row => lookup.has(tuple(row, op.ownerKey))).length
    }
    Object.assign(values, joined)
    sources.correction = audit.evidence
    return finish("verified")
  } catch {
    return finish()
  }
}

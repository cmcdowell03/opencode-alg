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
const decision = z.strictObject({ nextAction: token, prerequisite: token })
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
  decisionRules: z.strictObject({
    field: key, minimum: z.number().int().nonnegative(), whenMet: decision, otherwise: decision,
  }).optional(),
}).refine(({ owner, correction, operations, decisionRules }) => {
  const names = Object.keys(operations)
  return names.length > 0 && names.length <= 24 &&
    (!decisionRules || Object.hasOwn(operations, decisionRules.field)) &&
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
const ownerEvidenceSchema = receiptPayload.shape.sources.shape.owner.unwrap()
const correctionEvidenceSchema = receiptPayload.shape.sources.shape.correction.unwrap()
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
type User = Extract<DeliveryHistory[number], { type: "user" }>
type Assistant = Extract<DeliveryHistory[number], { type: "assistant" }>
type Tool = Extract<Assistant["content"][number], { type: "tool" }>
const continuation = /^continue[.!]?$/i
const totalRows = z.number().int().nonnegative()
const ownerCoverage = z.strictObject({ reference: token, rowsSha256: sha256, rowCount: size })

function evidenceDecoder() {
  let remaining = maxBytes
  return (raw: string) => {
    if (raw.length > remaining) throw new Error("oversize evidence")
    remaining -= Buffer.byteLength(raw)
    if (remaining < 0) throw new Error("oversize evidence")
    return required(object(json(raw)))
  }
}

function userMessage(message: User, correction: CalculationPolicy["correction"]) {
  const end = message.text.indexOf("\n")
  const header = end < 0 ? message.text : message.text.slice(0, end).replace(/\r$/, "")
  const plain = !message.files?.length && !message.agents?.length && !message.skills?.length
  const kind = header === correction.header ? "audit" :
    plain && message.text.length <= 32 && continuation.test(message.text.trim()) ? "continue" : "task"
  return { kind, end, plain }
}

function readAudit(message: User, correction: CalculationPolicy["correction"], decode: ReturnType<typeof evidenceDecoder>) {
  const { end, plain } = userMessage(message, correction)
  if (!plain || end < 0 || message.text.length > maxBytes) throw new Error("invalid correction")
  const body = message.text.slice(end + 1).trim()
  const data = decode(/^\x60{3}json[ \t]*\r?\n([\s\S]*?)\r?\n\x60{3}$/.exec(body)?.[1] ?? body)
  const rows = readRows(data[correction.rowsKey], correction.rowKey)
  const reference = token.parse(data[correction.referenceKey])
  return { rows, data, evidence: { reference, rowsSha256: digest(rows), rowCount: rows.length,
    messageId: message.id, reportReferenceField: correction.reportReferenceField } }
}

function readPage(
  message: Assistant, part: Tool, owner: CalculationPolicy["owner"], ownerAgent: string,
  decode: ReturnType<typeof evidenceDecoder>,
): Omit<OwnerPage, "position"> | undefined {
  if (part.executed === true || part.state.status !== "completed" || part.time.completed === undefined || message.error) return
  const input = object(part.state.input)
  const request = owner.pagesKey ? input?.[owner.pagesKey] : [input]
  if (!Array.isArray(request) || request.length > 16) return
  const selected = request.map(object).filter(entry => entry?.[owner.sourceKey] === owner.source)
  if (!selected.length) return
  if (selected.length !== 1) throw new Error("ambiguous page request")
  const args = selected[0]!
  // Only a native offset-zero request can establish the selected observed prefix.
  const fromStart = owner.cursorKey ? args[owner.cursorKey] == null &&
    (args[owner.offsetKey] === undefined || args[owner.offsetKey] === 0) : args[owner.offsetKey] === 0
  if (!fromStart) return
  const output = part.state.content[0]
  if (part.state.content.length !== 1 || output?.type !== "text") throw new Error("invalid tool result")
  const data = decode(output.text)
  if (data.ok === false || (Object.hasOwn(data, "status") && data.status !== "ok")) return
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
  const total = owner.totalRowsKey ? totalRows.parse(record[owner.totalRowsKey]) : undefined
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
  return { rows, exhausted, total, evidence: { reference, rowsSha256: digest(rows),
    rowCount: rows.length, messageId: message.id, callId: part.id, source: owner.source, tool: owner.tool, agent: ownerAgent,
    limit: requested, reportReferenceField: owner.reportReferenceField } }
}

const maxHistory = 512
const maxParts = 2048
/** Compact JSON, including room for the journal's terminating newline. */
export const calculationCheckpointMaxBytes = 2 * 1024 * 1024
const counts = z.record(key, size).refine(values => Object.keys(values).length <= 24)
const projections = z.record(key, z.array(sha256).max(maxRows).refine(distinct))
  .refine(values => Object.keys(values).length <= 24)
const pageSummary = z.strictObject({
  evidence: ownerEvidenceSchema, matches: size, exhausted: z.boolean(), total: totalRows.optional(),
}).refine(({ evidence: { rowCount, limit }, matches, exhausted, total }) =>
  matches <= rowCount && rowCount <= limit && (exhausted || rowCount === limit) &&
  (total === undefined || (rowCount === Math.min(total, limit) && exhausted === (rowCount === total))))
const checkpointPayload = z.strictObject({
  version: z.literal(1),
  recipeSha256: sha256,
  ownerAgent: token,
  task: z.strictObject({ id: token, fingerprint: sha256 }),
  dormant: z.literal(true).optional(),
  messages: z.record(sha256, sha256).refine(messages => Object.keys(messages).length <= maxHistory),
  calls: z.array(sha256).max(maxParts).refine(distinct),
  pages: z.array(pageSummary).max(16),
  selected: z.strictObject({ values: counts, keys: projections.optional() }).optional(),
  earlyAudit: z.strictObject({ evidence: correctionEvidenceSchema, coverage: ownerCoverage, keys: projections }).optional(),
  audit: z.strictObject({ evidence: correctionEvidenceSchema, values: counts }).optional(),
  revalidation: z.boolean(),
  conflict: z.enum(["owner", "audit", "history"]).optional(),
})

/** Bounded journal format. Bind it to the same trusted owner session before loading. */
export const calculationCheckpointSchema = checkpointPayload.extend({ proofSha256: sha256 }).refine(checkpoint => {
  const { proofSha256, pages, selected, earlyAudit, audit, calls, messages, ...rest } = checkpoint
  const last = pages.at(-1)
  const hasMessage = (id: string) => Object.hasOwn(messages, digest(id))
  const hasCall = new Set(calls)
  const messageCount = Object.keys(messages).length
  if (rest.dormant
    ? messageCount || calls.length || last || selected || earlyAudit || audit || rest.revalidation || rest.conflict
    : !messageCount || (!last && !earlyAudit && !rest.revalidation && !rest.conflict)) return false
  if (hasMessage(rest.task.id) || (selected && !last) || (audit && (!selected || selected.keys || rest.revalidation)) ||
      (earlyAudit && (selected || !rest.revalidation)) ||
      !distinct(pages.map(page => page.evidence.callId))) return false
  if (pages.some(({ evidence, matches, total, exhausted }, index) => {
    const previous = pages[index - 1]
    return evidence.agent !== rest.ownerAgent || !hasMessage(evidence.messageId) || !hasCall.has(digest(evidence.callId)) ||
      (!!previous && (previous.exhausted || evidence.limit <= previous.evidence.limit || matches < previous.matches ||
        evidence.reference !== previous.evidence.reference || total !== previous.total ||
        evidence.source !== previous.evidence.source || evidence.tool !== previous.evidence.tool ||
        evidence.reportReferenceField !== previous.evidence.reportReferenceField)) ||
      (exhausted && index !== pages.length - 1)
  })) return false
  if (last && selected && (Object.values(selected.values).some(value => value > last.evidence.rowCount) ||
      Object.values(selected.keys ?? {}).some(keys => keys.length !== last.evidence.rowCount))) return false
  if (earlyAudit && Object.values(earlyAudit.keys).some(keys => keys.length > earlyAudit.evidence.rowCount)) return false
  if (audit && last && (audit.evidence.reference === last.evidence.reference ||
      audit.evidence.messageId === last.evidence.messageId ||
      audit.evidence.reportReferenceField === last.evidence.reportReferenceField ||
      Object.values(audit.values).some(value => value > Math.min(last.evidence.rowCount, audit.evidence.rowCount)))) return false
  if ((earlyAudit && !hasMessage(earlyAudit.evidence.messageId)) || (audit && !hasMessage(audit.evidence.messageId))) return false
  const payload = canonical({ pages, selected, earlyAudit, audit, calls, messages, ...rest })
  // Account for the proof member and final newline.
  return Buffer.byteLength(payload) + 83 <= calculationCheckpointMaxBytes &&
    proofSha256 === createHash("sha256").update(payload).digest("hex")
})

export type CalculationCheckpoint = z.output<typeof calculationCheckpointSchema>
type Progress = Omit<z.output<typeof checkpointPayload>, "dormant">
type Coverage = z.output<typeof ownerCoverage>
type ProgressCounts = { source: string; rowCount: number; matches: number; threshold: number }
export type CalculationObligation =
  | ({ kind: "need_page"; nextLimit: number } & ProgressCounts)
  | ({ kind: "need_audit"; reason: "missing" | "revalidation"; ownerCoverage: Coverage } & ProgressCounts)
  | ({ kind: "exhausted" } & ProgressCounts)
  | ({ kind: "verified" } & ProgressCounts)
  | { kind: "conflict"; reason: "owner" | "audit" | "history" | "checkpoint" }
  | { kind: "unavailable" }
export type CalculationProgress = {
  receipt: CalculationReceipt
  obligation: CalculationObligation
  checkpoint: CalculationCheckpoint | null
}

function joinOperations(policy: CalculationPolicy) {
  return Object.entries(policy.operations).flatMap(([name, op]) =>
    op.kind === "semijoinCount" ? [[name, op] as const] : [])
}

function baseValues(policy: CalculationPolicy, rows: Row[]) {
  const values: Record<string, number> = {}
  for (const [name, op] of Object.entries(policy.operations)) {
    if (op.kind === "count") values[name] = rows.length
    if (op.kind === "filteredCount") values[name] = rows.filter(row => matches(row, op.where)).length
  }
  return values
}

function keyHashes(values: Set<string>) {
  return [...values].map(value => createHash("sha256").update(value).digest("hex"))
}

function ownerKeys(policy: CalculationPolicy, rows: Row[], project = keyHashes) {
  return Object.fromEntries(joinOperations(policy).map(([name, op]) =>
    [name, project(uniqueKeys(rows, op.ownerKey))]))
}

function correctionKeys(policy: CalculationPolicy, rows: Row[], project = keyHashes) {
  return Object.fromEntries(joinOperations(policy).map(([name, op]) => {
    uniqueKeys(rows, op.correctionKey)
    return [name, project(uniqueKeys(rows.filter(row => matches(row, op.where)), op.correctionKey))]
  }))
}

function joinValues(owner: Record<string, string[]>, correction: Record<string, string[]>) {
  return Object.fromEntries(Object.entries(owner).map(([name, keys]) => {
    const lookup = new Set(required(correction[name]))
    return [name, keys.filter(value => lookup.has(value)).length]
  }))
}

function coverageOf({ reference, rowsSha256, rowCount }: NonNullable<Source["owner"]>): Coverage {
  return { reference, rowsSha256, rowCount }
}

function sameCoverage(left: Coverage, right: Coverage) {
  return left.reference === right.reference && left.rowsSha256 === right.rowsSha256 && left.rowCount === right.rowCount
}

function agreesWithPrefix(shorter: Pick<OwnerPage, "evidence" | "exhausted" | "total">, longer: Omit<OwnerPage, "position">) {
  const { rowCount, limit, rowsSha256 } = shorter.evidence
  return shorter.total === longer.total && rowCount === Math.min(limit, longer.rows.length) &&
    shorter.exhausted === (longer.exhausted && rowCount === longer.rows.length) &&
    rowsSha256 === (rowCount === longer.rows.length ? longer.evidence.rowsSha256 : digest(longer.rows.slice(0, rowCount)))
}

function checkpointMatches(policy: CalculationPolicy, state: Progress, agent: string) {
  const { pages, selected, earlyAudit, audit } = state
  const threshold = policy.owner.qualify.minMatches ?? 1
  const last = pages.at(-1)
  const joins = joinOperations(policy).map(([name]) => name)
  const base = Object.keys(policy.operations).filter(name => !joins.includes(name))
  const hasNames = (values: Record<string, unknown> | undefined, names: string[]) =>
    values !== undefined && Object.keys(values).length === names.length &&
    names.every(name => Object.hasOwn(values, name))
  return state.recipeSha256 === calculationPolicyDigest(policy) && state.ownerAgent === agent &&
    pages.every(({ evidence, matches, total }, index) => evidence.limit === policy.owner.limits[index] &&
      evidence.source === policy.owner.source && evidence.tool === policy.owner.tool &&
      evidence.reportReferenceField === policy.owner.reportReferenceField &&
      (total !== undefined) === !!policy.owner.totalRowsKey && (matches < threshold || index === pages.length - 1)) &&
    (!!selected === (!!last && last.matches >= threshold)) &&
    (!selected || (hasNames(selected.values, base) &&
      (audit ? !selected.keys : hasNames(selected.keys, joins)))) &&
    (!earlyAudit || (joins.length > 0 && hasNames(earlyAudit.keys, joins) &&
      earlyAudit.evidence.reportReferenceField === policy.correction.reportReferenceField)) &&
    (!audit || (joins.length > 0 && hasNames(audit.values, joins) &&
      audit.evidence.reportReferenceField === policy.correction.reportReferenceField))
}

function receiptFor(recipeSha256: string | null, status: CalculationReceipt["status"] = "incomplete",
  values: Record<string, number> = {}, sources: Source = {}): CalculationReceipt {
  const payload = { status, values, sources, recipeSha256 }
  return { ...payload, proofSha256: digest(payload) }
}

function sealCheckpoint(payload: z.output<typeof checkpointPayload>): CalculationCheckpoint {
  return { ...payload, proofSha256: digest(payload) }
}

function applyAudit(state: Progress, audit: NonNullable<Progress["earlyAudit"]>) {
  const selected = required(state.selected)
  const owner = required(state.pages.at(-1)).evidence
  if (!sameCoverage(audit.coverage, coverageOf(owner)) || audit.evidence.reference === owner.reference) {
    if (state.audit) state.conflict = "audit"
    else state.revalidation = true
    return
  }
  if (state.audit) {
    const previous = state.audit.evidence
    if (previous.reference !== audit.evidence.reference || previous.rowsSha256 !== audit.evidence.rowsSha256) {
      state.conflict = "audit"
    }
    return
  }
  state.audit = { evidence: audit.evidence, values: joinValues(required(selected.keys), audit.keys) }
  state.revalidation = false
  delete selected.keys
}

function addPage(policy: CalculationPolicy, state: Progress, page: Omit<OwnerPage, "position">) {
  const { rows, evidence, exhausted, total } = page
  const replay = state.pages.find(previous => previous.evidence.limit === evidence.limit)
  if (replay) {
    if (!sameCoverage(replay.evidence, evidence) || replay.exhausted !== exhausted || replay.total !== total) {
      throw new Error("conflicting repeated page")
    }
    return
  }
  const prior = state.pages.at(-1)
  if (prior && (prior.evidence.reference !== evidence.reference || !agreesWithPrefix(prior, page))) {
    throw new Error("changed source prefix")
  }
  if (state.selected || prior?.exhausted) return
  if (evidence.limit !== policy.owner.limits[state.pages.length]) throw new Error("skipped approved limit")
  const count = rows.filter(row => matches(row, policy.owner.qualify)).length
  const qualifies = count >= (policy.owner.qualify.minMatches ?? 1)
  // Compute candidate metrics before committing the page so a bad operand cannot leave a resumable cohort.
  if (qualifies) {
    state.selected = { values: baseValues(policy, rows), keys: ownerKeys(policy, rows) }
  }
  state.pages.push({ evidence, matches: count, exhausted, total })
  if (state.earlyAudit && (qualifies || exhausted || state.pages.length === policy.owner.limits.length)) {
    const audit = state.earlyAudit
    delete state.earlyAudit
    if (qualifies) applyAudit(state, audit)
  }
}

function addAudit(policy: CalculationPolicy, state: Progress, current: ReturnType<typeof readAudit>) {
  const { correction } = policy
  const keys = correctionKeys(policy, current.rows)
  const claimed = correction.referenceKey === "ownerCoverage" || correction.rowsKey === "ownerCoverage" ?
    undefined : current.data.ownerCoverage
  const coverage = claimed === undefined ? undefined : ownerCoverage.parse(claimed)
  if (state.selected) {
    applyAudit(state, { evidence: current.evidence, keys,
      coverage: coverage ?? coverageOf(required(state.pages.at(-1)).evidence) })
    return
  }
  const early = state.earlyAudit
  if (!state.revalidation && coverage) state.earlyAudit = { evidence: current.evidence, keys, coverage }
  state.revalidation = true
  if (early && (!coverage || !sameCoverage(early.coverage, coverage) ||
      early.evidence.reference !== current.evidence.reference || early.evidence.rowsSha256 !== current.evidence.rowsSha256)) {
    delete state.earlyAudit
  }
}

/** Inspect native owner history, or resume from a trusted checkpoint with post-cut native messages.
 * A running compaction may preserve a dormant task anchor before any evidence arrives.
 */
export function inspectCalculationProgress(
  policy: CalculationPolicy | undefined, history: DeliveryHistory, ownerAgent: string,
  checkpoint?: CalculationCheckpoint | null, preserveTask = false,
): CalculationProgress {
  const checked = policySchema.safeParse(policy)
  if (!checked.success || !token.safeParse(ownerAgent).success) {
    return { receipt: receiptFor(null), obligation: { kind: "unavailable" }, checkpoint: null }
  }
  policy = checked.data
  const { owner, correction } = policy
  const recipeSha256 = calculationPolicyDigest(policy)
  let task: Progress["task"] | undefined
  let state: Progress | undefined
  if (checkpoint != null) {
    const loaded = calculationCheckpointSchema.safeParse(checkpoint)
    if (!loaded.success || !checkpointMatches(policy, loaded.data, ownerAgent)) {
      return { receipt: receiptFor(recipeSha256), obligation: { kind: "conflict", reason: "checkpoint" }, checkpoint: null }
    }
    const { proofSha256: _, dormant, ...payload } = loaded.data
    task = payload.task
    if (!dormant) state = payload
  }
  let fault: Progress["conflict"]
  const fail = (reason: NonNullable<Progress["conflict"]>) => {
    if (state) state.conflict ??= reason
    else fault ??= reason
  }
  const emptyProgress = (task: Progress["task"]): Progress => ({
    version: 1, recipeSha256, ownerAgent, task, messages: {}, calls: [], pages: [], revalidation: false,
  })
  const begin = () => state ??= { ...emptyProgress(required(task)), ...(fault ? { conflict: fault } : {}) }
  const remember = (messageId: string, current: string) => {
    const payload = begin()
    if (Object.keys(payload.messages).length >= maxHistory) {
      fail("history")
      throw new Error("too many evidence messages")
    }
    payload.messages[messageId] = current
    return payload
  }
  const decode = evidenceDecoder()
  let parts = 0
  if (history.length > maxHistory) fail("history")
  for (const message of history.length <= maxHistory ? history : []) {
    if (!token.safeParse(message.id).success) {
      fail("history")
      break
    }
    const id = digest(message.id)
    const previous = state?.messages[id]
    const isTaskId = message.id === task?.id
    if (message.type === "user") {
      const { kind, plain } = userMessage(message, correction)
      const fingerprint = digest([kind, message.text, plain])
      if (previous || isTaskId) {
        if (fingerprint !== (previous ?? task?.fingerprint)) fail("history")
        continue
      }
      if (kind === "task") {
        task = { id: message.id, fingerprint }
        state = undefined
        fault = undefined
      }
      if (!task || kind !== "audit" || state?.conflict || !joinOperations(policy).length) continue
      try {
        const existing = state && remember(id, fingerprint)
        const current = readAudit(message, correction, decode)
        // Validate before creating a seed. A header or malformed handoff alone establishes no work.
        if (!existing) {
          const candidate = { ...emptyProgress(task), messages: { [id]: fingerprint } }
          addAudit(policy, candidate, current)
          if (fault) candidate.conflict = fault
          state = candidate
        } else {
          addAudit(policy, existing, current)
        }
      } catch {
        if (state?.audit) fail("audit")
        else if (state) {
          state.revalidation = true
          delete state.earlyAudit
        }
      }
      continue
    }
    if (isTaskId || (previous && (message.type !== "assistant" || message.agent !== ownerAgent))) {
      fail("history")
      continue
    }
    if (message.type === "location-switched") {
      state = undefined
      task = undefined
      fault = undefined
      continue
    }
    if (!task || state?.conflict || message.type !== "assistant" || message.agent !== ownerAgent) continue
    parts += message.content.length
    if (parts > maxParts) {
      fail("history")
      break
    }
    try {
      const pages = message.content.flatMap(part => {
        if (part.type !== "tool" || part.name !== owner.tool) return []
        const page = readPage(message, part, owner, ownerAgent, decode)
        return page ? [page] : []
      })
      const fingerprint = digest(pages.map(({ evidence, exhausted, total }) => [evidence, exhausted, total ?? null]))
      if (previous) {
        if (previous !== fingerprint) fail("history")
        continue
      }
      if (!pages.length) continue
      const current = remember(id, fingerprint)
      const calls = pages.map(page => digest(token.parse(page.evidence.callId)))
      const seen = new Set(current.calls)
      if (current.calls.length + calls.length > maxParts || !distinct(calls) || calls.some(call => seen.has(call))) {
        fail("history")
        continue
      }
      current.calls.push(...calls)
      for (const page of pages) {
        if (current.conflict) break
        addPage(policy, current, page)
      }
    } catch {
      // readPage only throws after the native request claims the configured evidence source.
      if (!state) begin().messages[id] = digest(["malformed owner evidence", message.id])
      fail("owner")
    }
  }
  if (!state) return {
    receipt: receiptFor(recipeSha256),
    obligation: fault ? { kind: "conflict", reason: fault } : { kind: "unavailable" },
    checkpoint: preserveTask && task && !fault ? sealCheckpoint({ ...emptyProgress(task), dormant: true }) : null,
  }
  const saved = sealCheckpoint(state)
  const page = state.pages.at(-1)
  const summary = { source: owner.source, rowCount: page?.evidence.rowCount ?? 0, matches: page?.matches ?? 0,
    threshold: owner.qualify.minMatches ?? 1 }
  const selection = state.selected && page
  const sources: Source = selection ? { owner: page.evidence } : {}
  const base = selection ? state.selected!.values : {}
  const incomplete = receiptFor(recipeSha256, "incomplete", base, sources)
  if (state.conflict) return {
    receipt: state.conflict === "audit" ? incomplete : receiptFor(recipeSha256),
    obligation: { kind: "conflict", reason: state.conflict }, checkpoint: saved,
  }
  if (selection && (state.audit || !joinOperations(policy).length)) return {
    receipt: receiptFor(recipeSha256, "verified", { ...base, ...state.audit?.values },
      state.audit ? { ...sources, correction: state.audit.evidence } : sources),
    obligation: { kind: "verified", ...summary }, checkpoint: saved,
  }
  if (selection) return { receipt: incomplete, checkpoint: saved, obligation: {
    kind: "need_audit", ...summary, reason: state.revalidation ? "revalidation" : "missing",
    ownerCoverage: coverageOf(page.evidence),
  } }
  const nextLimit = owner.limits[state.pages.length]
  return { receipt: incomplete, checkpoint: saved, obligation: page?.exhausted || nextLimit === undefined ?
    { kind: "exhausted", ...summary } : { kind: "need_page", ...summary, nextLimit } }
}

/** Whole-history compatibility for callers that do not have a trusted cut or enforce incremental ordering. */
export function calculateFromHistory(
  policy: CalculationPolicy | undefined, history: DeliveryHistory, ownerAgent: string,
): CalculationReceipt {
  let recipeSha256: string | null = null
  const values: Record<string, number> = {}
  const sources: Source = {}
  const finish = (status: CalculationReceipt["status"] = "incomplete") => receiptFor(recipeSha256, status, values, sources)
  try {
    const checked = policySchema.safeParse(policy)
    if (!checked.success) return finish()
    policy = checked.data
    recipeSha256 = calculationPolicyDigest(policy)
    if (!token.safeParse(ownerAgent).success || history.length > maxHistory) return finish()
    const { owner, correction } = policy
    const pages: OwnerPage[] = []
    const messageIds = new Set<string>()
    const callIds = new Set<string>()
    let active = false
    let corruptedAudit = false
    let corruptedOwner = false
    let audit: Audit | undefined
    const decode = evidenceDecoder()
    let parts = 0
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
        const { kind } = userMessage(message, correction)
        if (kind !== "audit") {
          if (kind === "continue") continue
          active = true
          pages.length = 0
          audit = undefined
          corruptedOwner = false
          corruptedAudit = false
          continue
        }
        if (!active) continue
        try {
          const current = readAudit(message, correction, decode)
          if (audit && (audit.evidence.reference !== current.evidence.reference ||
              audit.evidence.rowsSha256 !== current.evidence.rowsSha256)) {
            throw new Error("conflicting correction")
          }
          audit ??= { ...current, position }
        } catch {
          corruptedAudit = true
        }
        continue
      }
      if (!active || message.type !== "assistant" || message.agent !== ownerAgent) continue
      parts += message.content.length
      if (parts > maxParts) return finish()
      for (const part of message.content) {
        if (part.type !== "tool" || part.name !== owner.tool) continue
        if (!token.safeParse(part.id).success || callIds.has(part.id)) return finish()
        callIds.add(part.id)
        try {
          const page = readPage(message, part, owner, ownerAgent, decode)
          if (page) pages.push({ ...page, position })
        } catch {
          corruptedOwner = true
        }
      }
    }
    if (!active || corruptedOwner || !pages.length) return finish()
    pages.sort((left, right) => left.evidence.limit - right.evidence.limit)
    const longest = pages.at(-1)!
    const limitReferences = new Map<number, string>()
    for (const page of pages) {
      const { reference, limit } = page.evidence
      const prior = limitReferences.get(limit)
      if ((prior !== undefined && prior !== reference) || !agreesWithPrefix(page, longest)) return finish()
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
    const base = baseValues(policy, selected.rows)
    sources.owner = selected.evidence
    Object.assign(values, base)
    if (!joinOperations(policy).length) return finish("verified")
    if (corruptedAudit || !audit || audit.position <= selected.position || audit.evidence.reference === selected.evidence.reference) {
      return finish()
    }
    const tuples = (keys: Set<string>) => [...keys]
    const joined = joinValues(ownerKeys(policy, selected.rows, tuples), correctionKeys(policy, audit.rows, tuples))
    Object.assign(values, joined)
    sources.correction = audit.evidence
    return finish("verified")
  } catch {
    return finish()
  }
}

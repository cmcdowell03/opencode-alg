import { createHash } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { z } from "zod"
import { acquireFilesystemMutexAsync } from "../../../src/filesystem-mutex.ts"
import { atomicWriteFile, runContainedPath } from "../../../src/store.ts"
import type { DeliveryHistory } from "./delivery.ts"
import { readReceipt } from "./journal.ts"

const maxSources = 32
const maxReads = 128
const maxRows = 512
const maxTotalRows = 1024
const maxFindings = 16
const maxLinks = 16
const maxSourceBytes = 16 * 1024
const maxResultBytes = 7 * maxSourceBytes
const maxJournalBytes = 512 * 1024
const maxCacheChars = 176 * 1024
export const reviewSnapshotBytes = 8 * 1024

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const identity = z.string().min(1).max(256)
const token = z.string().regex(/^[\w-]{1,128}$/)
const receiptId = z.string().regex(/^[\w.:-]{1,128}$/)
const path = z.string().max(256).regex(/^[\w.-]+(?:\/[\w.-]+)*$/)
  .refine(value => !value.split("/").some(part => part === "." || part === ".."))
const text = z.string().trim().min(1).max(1024)
const reference = z.string().min(1).max(385)
const scopeSchema = z.strictObject({ projectId: identity, sessionId: identity })
const allowlistSchema = z.array(token).max(16)
const locationSchema = z.strictObject({ tool: token, path, messageId: identity, callId: identity })
const anchorSchema = locationSchema.extend({ sha256: hash, receipt: receiptId })
const attemptSchema = z.union([anchorSchema, locationSchema])
const sourceSchema = anchorSchema.extend({
  rowIds: z.array(token).max(maxRows),
  state: z.enum(["inspected", "changed", "conflicted"]),
  cachedBytes: z.string().max(Math.ceil(maxSourceBytes / 3) * 4).optional(),
})
const questionSchema = z.strictObject({ findingId: token, text })
const findingSchema = z.strictObject({
  id: token, interpretation: text, scope: z.string().trim().min(1).max(256).optional(),
  support: z.array(reference).max(maxLinks),
  counterevidence: z.array(reference).max(maxLinks),
  falsifier: text.optional(),
  missingEvidence: text.optional(),
})
const journalSchema = z.strictObject({
  version: z.literal(1),
  scope: scopeSchema,
  revision: z.number().int().nonnegative(),
  sources: z.array(sourceSchema).max(maxSources),
  reads: z.array(attemptSchema).max(maxReads),
  findings: z.array(findingSchema.extend({ support: z.array(hash).max(maxLinks), counterevidence: z.array(hash).max(maxLinks) }))
    .max(maxFindings),
  question: questionSchema.nullable(),
})

type Journal = z.output<typeof journalSchema>
type Location = z.output<typeof locationSchema>
type Anchor = z.output<typeof anchorSchema>
type Attempt = z.output<typeof attemptSchema>
type Source = z.output<typeof sourceSchema>
export type EvidenceReadScope = z.input<typeof scopeSchema> & { tools: readonly string[]; cacheSourceBytes?: boolean }
export type EvidenceFindingInput = z.input<typeof findingSchema>
export type EvidenceQuestion = z.output<typeof questionSchema>
/** Provenance for content observed in a completed read, tied to that historical snapshot. */
export type SourceReceipt = Anchor & { id: string; reference: string }
export type EvidenceSource = Anchor & { status: Source["state"] | "stale"; references: SourceReceipt[] }
export type EvidenceFinding = Omit<EvidenceFindingInput, "support" | "counterevidence"> & {
  attribution: "model"
  status: "supported" | "contested" | "unresolved"
  support: SourceReceipt[]
  counterevidence: SourceReceipt[]
}
export type EvidenceReadView = {
  revision: number
  sources: EvidenceSource[]
  findings: EvidenceFinding[]
  question: EvidenceQuestion | null
}
export type ReviewSourceData = { kind: "json-row" | "markdown"; data: unknown }
export type NativeReviewSourceSnapshot = Anchor & ReviewSourceData & { reference: string }
export type ReviewSourceSnapshot = {
  revision: number
  trust: "untrusted-source-data"
  evidence: (ReviewSourceData & { source: SourceReceipt })[]
  missing: string[]
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function json(value: string): unknown {
  try { return JSON.parse(value) } catch { return undefined }
}

const inputSchema = z.strictObject({ path })
const outputSchema = z.object({ path, content: z.string(), receipt: receiptId, sha256: hash.optional(),
  ok: z.literal(true).optional(), isError: z.literal(false).optional() })
const rowsSchema = z.array(z.object({ id: token })).max(maxRows)
type Observation = { attempt: Anchor; rowIds: string[] | null; content: string } |
  { attempt: Location; rowIds?: never; content?: never }

export function reviewSourceReference(ref: string): { path: string; rowId?: string } | undefined {
  const [file, rowId, ...extra] = ref.split("#")
  if (extra.length || !path.safeParse(file).success) return
  if (file!.endsWith(".json") && token.safeParse(rowId).success) return { path: file!, rowId }
  if (/\.md$/i.test(file!) && rowId === undefined) return { path: file! }
}

export function extractReviewSourceData(content: string, ref: string): ReviewSourceData | undefined {
  const target = reviewSourceReference(ref)
  if (!target || Buffer.byteLength(content) > maxSourceBytes) return
  if (!target.rowId) return { kind: "markdown", data: content }
  const rows = json(content)
  const ids = sourceRows(target.path, content)
  if (!Array.isArray(rows) || !ids?.includes(target.rowId)) return
  const data = rows.find(row => row?.id === target.rowId)
  return { kind: "json-row", data }
}

function sourceRows(file: string, content: string): string[] | null {
  if (!file.endsWith(".json")) return []
  const rows = rowsSchema.safeParse(json(content))
  if (!rows.success) return null
  const ids = rows.data.map(row => row.id)
  return new Set(ids).size === ids.length ? ids.sort() : null
}

function* observations(history: DeliveryHistory, tools: ReadonlySet<string>): Generator<Observation> {
  if (history.length > 1024) throw new Error("EVIDENCE_READ_HISTORY_LIMIT")
  let parts = 0
  for (const row of history) {
    if (row.type !== "assistant") continue
    parts += row.content.length
    if (parts > 4096) throw new Error("EVIDENCE_READ_HISTORY_LIMIT")
    for (const part of row.content) {
      if (part.type !== "tool" || !tools.has(part.name) || part.executed === true ||
          part.state.status !== "completed" || part.time.completed === undefined) continue
      const input = inputSchema.safeParse(part.state.input)
      if (!input.success) continue
      const location = locationSchema.safeParse({ tool: part.name, path: input.data.path, messageId: row.id, callId: part.id })
      if (!location.success) continue
      const result = part.state.content[0]
      if (part.state.content.length !== 1 || result?.type !== "text" || result.text.length > maxResultBytes ||
          Buffer.byteLength(result.text) > maxResultBytes) {
        yield { attempt: location.data }
        continue
      }
      const output = outputSchema.safeParse(json(result.text))
      if (!output.success || input.data.path !== output.data.path || Buffer.byteLength(output.data.content) > maxSourceBytes) {
        yield { attempt: location.data }
        continue
      }
      const { content, receipt } = output.data
      const digest = sha256(content)
      if (output.data.sha256 !== undefined && output.data.sha256 !== digest) {
        yield { attempt: location.data }
        continue
      }
      yield { attempt: { ...location.data, sha256: digest, receipt }, rowIds: sourceRows(input.data.path, content), content }
    }
  }
}

/** Reconcile one operator-requested read against the ordinary owner-native history. */
export function snapshotNativeReviewRead(history: DeliveryHistory, tool: string, reference: string, after: number):
NativeReviewSourceSnapshot | undefined {
  const target = reviewSourceReference(reference)
  if (!target || history.length > 1024) return
  const matched: DeliveryHistory[number][] = []
  let parts = 0
  for (const row of history) {
    if (row.type !== "assistant") continue
    parts += row.content.length
    if (parts > 4096) return
    for (const part of row.content) {
      if (part.type !== "tool" || part.name !== tool || part.time.created <= after ||
          part.executed === true || !("input" in part.state)) continue
      const input = inputSchema.safeParse(part.state.input)
      if (!input.success || input.data.path !== target.path) continue
      if (matched.length) return
      matched.push({ ...row, content: [part] })
    }
  }
  const observed = observations(matched, new Set([tool])).next()
  if (observed.done || !anchored(observed.value.attempt) || observed.value.content === undefined) return
  const data = extractReviewSourceData(observed.value.content, reference)
  if (data) return { ...observed.value.attempt, reference, ...data }
}

function sameSource(a: Location, b: Location) {
  return a.tool === b.tool && a.path === b.path
}

function anchored(attempt: Attempt): attempt is Anchor {
  return "receipt" in attempt
}

function sameAttempt(a: Attempt, b: Attempt) {
  if (!sameSource(a, b) || a.messageId !== b.messageId || a.callId !== b.callId) return false
  return anchored(a) ? anchored(b) && a.sha256 === b.sha256 && a.receipt === b.receipt : !anchored(b)
}

function cacheSource(journal: Journal, source: Source | undefined, content?: string) {
  if (!source || source.state !== "inspected" || source.cachedBytes !== undefined || content === undefined) return false
  const bytes = Buffer.from(content).toString("base64")
  const used = journal.sources.reduce((total, row) => total + (row.cachedBytes?.length ?? 0), 0)
  if (used + bytes.length > maxCacheChars) return false
  source.cachedBytes = bytes
  return true
}

function observeRead(journal: Journal, { attempt, rowIds, content }: Observation, cache: boolean): boolean {
  const source = journal.sources.find(row => sameSource(row, attempt))
  const preceding = journal.reads.filter(row => row.callId === attempt.callId ||
    (row.tool === attempt.tool && anchored(row) && anchored(attempt) && row.receipt === attempt.receipt))
  if (preceding.some(row => sameAttempt(row, attempt)))
    return cache && anchored(attempt) && source?.sha256 === attempt.sha256 && cacheSource(journal, source, content)

  let changed = false
  const canAppend = journal.reads.length < maxReads
  const hasSourceSlot = canAppend && journal.sources.length < maxSources &&
    journal.sources.reduce((count, row) => count + row.rowIds.length, rowIds?.length ?? 0) <= maxTotalRows
  const invalid = !anchored(attempt) || preceding.length > 0 || rowIds === null
  for (const existing of journal.sources) {
    if (existing.state === "conflicted") continue
    if (preceding.some(prior => sameSource(prior, existing)) ||
        (existing === source && invalid) ||
        (!source && !hasSourceSlot && anchored(attempt) && existing.path === attempt.path && existing.sha256 !== attempt.sha256)) {
      existing.state = "conflicted"
      delete existing.cachedBytes
      changed = true
    } else if (existing === source && existing.state === "inspected" && anchored(attempt) &&
        existing.sha256 !== attempt.sha256) {
      existing.state = "changed"
      delete existing.cachedBytes
      changed = true
    }
  }
  if (!source && hasSourceSlot && anchored(attempt)) {
    const added: Source = { ...attempt, rowIds: rowIds ?? [], state: invalid ? "conflicted" : "inspected" }
    if (cache) cacheSource(journal, added, content)
    journal.sources.push(added)
    changed = true
  }
  if (canAppend) {
    journal.reads.push(attempt)
    changed = true
  }
  return changed
}

/** Capture only history obtained from the host for this verified project/session. */
export class EvidenceReadStore {
  private readonly scope: z.output<typeof scopeSchema>
  private readonly tools: ReadonlySet<string>
  private readonly key: string
  private readonly cache: boolean

  constructor(private readonly directory: string, private readonly runId: string, scope: EvidenceReadScope) {
    this.scope = scopeSchema.parse({ projectId: scope.projectId, sessionId: scope.sessionId })
    this.tools = new Set(allowlistSchema.parse(scope.tools))
    this.key = sha256(JSON.stringify([runId, this.scope]))
    this.cache = scope.cacheSourceBytes === true
  }

  private path(name: string) {
    return runContainedPath(this.directory, this.runId, "source-evidence", this.key, name)
  }

  private async read(): Promise<Journal> {
    const journal = await readReceipt(this.path("journal.json"), journalSchema, maxJournalBytes)
    if (!journal) return { version: 1, scope: this.scope, revision: 0, sources: [], reads: [], findings: [], question: null }
    if (journal.scope.projectId !== this.scope.projectId || journal.scope.sessionId !== this.scope.sessionId)
      throw new Error("EVIDENCE_READ_SCOPE_MISMATCH")
    return journal
  }

  private async update(apply: (journal: Journal) => boolean, expectedRevision?: number) {
    await mkdir(dirname(this.path("journal.lock")), { recursive: true, mode: 0o700 })
    const lock = await acquireFilesystemMutexAsync(this.path("journal.lock"), { owner: this.key, waitMs: 5000 })
    try {
      const journal = await this.read()
      if (expectedRevision !== undefined && journal.revision !== expectedRevision)
        throw new Error("EVIDENCE_READ_STALE_REVISION")
      if (apply(journal)) {
        journal.revision++
        const data = JSON.stringify(journalSchema.parse(journal)) + "\n"
        if (Buffer.byteLength(data) >= maxJournalBytes) throw new Error("EVIDENCE_READ_CAPACITY")
        atomicWriteFile(this.path("journal.json"), data, false, { commitBoundaryFence: () => lock.assertHeld() })
      }
      return this.project(journal)
    } finally { lock.release() }
  }

  private sources(journal: Journal): EvidenceSource[] {
    const inspected = journal.sources.filter(source => this.tools.has(source.tool))
    return journal.sources.map(({ rowIds, state, cachedBytes: _, ...anchor }) => {
      let status: EvidenceSource["status"] = this.tools.has(anchor.tool) ? state : "stale"
      if (status === "inspected" && inspected.some(other =>
        other.path === anchor.path && other.sha256 !== anchor.sha256)) status = "conflicted"
      const refs = /\.md$/i.test(anchor.path) ? [anchor.path] : rowIds.map(id => anchor.path + "#" + id)
      const references = status === "inspected" ? refs.map(reference => ({
        ...anchor, reference, id: sha256(JSON.stringify([this.key, anchor.tool, anchor.sha256, reference])),
      })) : []
      return { ...anchor, status, references }
    })
  }

  private resolve(sources: EvidenceSource[], refs: readonly string[]): SourceReceipt[] {
    return refs.map(ref => {
      const matches = sources.flatMap(source => source.references.filter(row => row.id === ref || row.reference === ref))
      if (matches.length !== 1) throw new Error(matches.length ? "EVIDENCE_READ_AMBIGUOUS_REFERENCE" : "EVIDENCE_READ_UNVERIFIED_REFERENCE")
      return matches[0]!
    })
  }

  private project(journal: Journal): EvidenceReadView {
    const sources = this.sources(journal)
    const verified = new Map(sources.flatMap(source => source.references.map(row => [row.id, row] as const)))
    const links = (ids: string[]) => ids.flatMap(id => verified.get(id) ?? [])
    const findings = journal.findings.map((record): EvidenceFinding => {
      const support = links(record.support)
      const counterevidence = links(record.counterevidence)
      const incomplete = record.missingEvidence || support.length !== record.support.length ||
        counterevidence.length !== record.counterevidence.length
      const status = counterevidence.length ? "contested" : incomplete || !support.length ? "unresolved" : "supported"
      return { ...record, attribution: "model", status, support, counterevidence }
    })
    return { revision: journal.revision, sources, findings, question: journal.question }
  }

  /** Call before a compaction discards the completed native tool parts. */
  async observe(history: DeliveryHistory): Promise<EvidenceReadView> {
    const matches = observations(history, this.tools)
    const first = matches.next()
    if (first.done) return this.view()
    return this.update(journal => {
      let changed = observeRead(journal, first.value, this.cache)
      for (const match of matches) if (observeRead(journal, match, this.cache)) changed = true
      return changed
    })
  }

  async view(): Promise<EvidenceReadView> {
    return this.project(await this.read())
  }

  async checkReferences(refs: readonly string[]): Promise<SourceReceipt[]> {
    const checked = z.array(reference).max(2 * maxLinks).parse(refs)
    return this.resolve(this.sources(await this.read()), checked)
  }

  /** Project only requested, still-valid rows. Cached content is a historical snapshot. */
  async snapshotReferences(refs: readonly string[]): Promise<ReviewSourceSnapshot> {
    const requested = [...new Set(z.array(reference).max(2 * maxLinks).parse(refs))]
    const journal = await this.read()
    const sources = this.sources(journal)
    const result: ReviewSourceSnapshot = { revision: journal.revision, trust: "untrusted-source-data", evidence: [], missing: [] }
    for (const ref of requested) {
      const matches = sources.flatMap(source => source.references.filter(row => row.id === ref || row.reference === ref))
      const source = matches.length === 1 ? matches[0] : undefined
      const encoded = source && this.cache ? journal.sources.find(row => sameSource(row, source))?.cachedBytes : undefined
      const content = encoded === undefined ? undefined : Buffer.from(encoded, "base64").toString("utf8")
      const data = source && content !== undefined && sha256(content) === source.sha256
        ? extractReviewSourceData(content, source.reference) : undefined
      if (source && data) {
        const entry = { source, ...data }
        if (Buffer.byteLength(JSON.stringify([...result.evidence, entry])) <= reviewSnapshotBytes) {
          result.evidence.push(entry)
          continue
        }
      }
      result.missing.push(ref)
    }
    return result
  }

  async recordFinding(input: EvidenceFindingInput, expectedRevision?: number): Promise<EvidenceReadView> {
    const finding = findingSchema.parse(input)
    return this.update(journal => {
      const sources = this.sources(journal)
      const support = this.resolve(sources, finding.support).map(row => row.id)
      const counterevidence = this.resolve(sources, finding.counterevidence).map(row => row.id)
      const unique = new Set([...support, ...counterevidence])
      if (unique.size !== support.length + counterevidence.length) throw new Error("EVIDENCE_READ_CONFLICTING_LINKS")
      const entry = { ...finding, support, counterevidence }
      const index = journal.findings.findIndex(row => row.id === finding.id)
      if (index >= 0) {
        if (JSON.stringify(journal.findings[index]) === JSON.stringify(entry)) return false
        journal.findings[index] = entry
      } else {
        if (journal.findings.length >= maxFindings) throw new Error("EVIDENCE_READ_CAPACITY")
        journal.findings.push(entry)
      }
      return true
    }, expectedRevision)
  }

  async setQuestion(question: EvidenceQuestion | null, expectedRevision?: number): Promise<EvidenceReadView> {
    const checked = questionSchema.nullable().parse(question)
    return this.update(journal => {
      if (checked && !journal.findings.some(row => row.id === checked.findingId))
        throw new Error("EVIDENCE_READ_UNKNOWN_FINDING")
      if (JSON.stringify(journal.question) === JSON.stringify(checked)) return false
      journal.question = checked
      return true
    }, expectedRevision)
  }
}

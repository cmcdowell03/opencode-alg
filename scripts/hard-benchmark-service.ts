import { createHash, randomUUID } from "node:crypto"
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"

type Scalar = string | number | boolean | null
type Row = Readonly<Record<string, unknown>>

export interface RawQuery {
  idempotencyKey: string
  sourceId: string
  expectedRevision?: string
  filter?: Readonly<Record<string, Scalar>>
  select?: readonly string[]
}
export interface QueryScope { filter: Readonly<Record<string, Scalar>>; select: readonly string[] | null }
export interface SourceSnapshot { sourceId: string; revision: string; rows: readonly Row[]; available?: boolean }
export interface JobManifest { jobId: string; sourceId: string; sourceRevision: string; rowCount: number; resultDigest: string; workUnits: number }
export interface QueryJob extends JobManifest { status: "complete"; acceptedAt: number }
export interface ResultPage { jobId: string; sourceRevision: string; rows: readonly Row[]; nextCursor?: string }
export interface ServiceLedger { acceptedComputations: number; acceptedWorkUnits: number; jobs: number; lostAcknowledgements: number; sourceChanges: number }
export interface ServiceFaults {
  loseAcknowledgement?: { idempotencyKey: string }
  changeSource?: { afterAcceptedComputations: number; source: SourceSnapshot }
}
export interface ServiceOptions { sources?: readonly SourceSnapshot[]; faults?: ServiceFaults; maxAcceptedWorkUnits?: number }
export interface ServiceEvidence {
  ledger: ServiceLedger
  sources: readonly { sourceId: string; revision: string; available: boolean }[]
  jobs: readonly {
    job: QueryJob
    idempotencyKey: string
    scope: QueryScope
    lostAcknowledgement: boolean
    recoveredByLookup: boolean
    statusChecked: boolean
    lookedUp: boolean
    rowsRead: number
    currentRowsRead: number
  }[]
  unavailableChecks: readonly { sourceId: string; revision: string }[]
}
interface StoredJob {
  job: QueryJob
  idempotencyKey: string
  scope: QueryScope
  rows: readonly Row[]
  lostAcknowledgement: boolean
  recoveredByLookup: boolean
  statusChecked: boolean
  lookedUp: boolean
  readRanges: [number, number][]
  currentReadRanges: [number, number][]
}
interface State {
  schema: 1
  sources: SourceSnapshot[]
  sourceHistory: { sourceId: string; revision: string }[]
  jobs: StoredJob[]
  faults: ServiceFaults
  maxAcceptedWorkUnits: number
  sourceChanges: number
  faultSourceChanged: boolean
  unavailableChecks: { sourceId: string; revision: string }[]
}

export class LostAcknowledgementError extends Error {
  readonly code = "ACK_LOST_AFTER_ACCEPTANCE"
  constructor(readonly idempotencyKey: string) {
    super("Acknowledgement lost. Look up the caller's idempotency key.")
    this.name = "LostAcknowledgementError"
  }
}
export class StaleSourceError extends Error {
  readonly code = "SOURCE_REVISION_CHANGED"
  constructor(readonly sourceId: string, readonly expected: string, readonly current: string) {
    super(`Source ${sourceId} is at ${current}, not ${expected}.`)
    this.name = "StaleSourceError"
  }
}
export class SourceUnavailableError extends Error {
  readonly code = "SOURCE_UNAVAILABLE"
  constructor(readonly sourceId: string, readonly revision: string) {
    super(`Source ${sourceId} at ${revision} is unavailable.`)
    this.name = "SourceUnavailableError"
  }
}

const maxSources = 16
const maxSourceRows = 20_000
const maxJobs = 32
const maxResultRows = 2_048
const maxResultBytes = 512 * 1024
const maxPageRows = 100
const maxPageRowBytes = 64 * 1024
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

function validName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && value.trim() === value && value.length > 0
}

function validateSource(source: SourceSnapshot): void {
  if (!validName(source.sourceId) || !validName(source.revision) ||
    (source.available !== undefined && typeof source.available !== "boolean") ||
    !Array.isArray(source.rows) || source.rows.length > maxSourceRows ||
    source.rows.some(row => row === null || typeof row !== "object" || Array.isArray(row)) ||
    bytes(source.rows) > 4 * 1024 * 1024) throw new TypeError("invalid or oversized source snapshot")
}

function queryScope(query: RawQuery): QueryScope {
  if (!validName(query.idempotencyKey) || !validName(query.sourceId) ||
    (query.expectedRevision !== undefined && !validName(query.expectedRevision))) throw new TypeError("invalid query identity")
  if (query.filter !== undefined && (query.filter === null || typeof query.filter !== "object" || Array.isArray(query.filter))) {
    throw new TypeError("filter must be an object of scalar values")
  }
  const entries = Object.entries(query.filter ?? {}).sort(([left], [right]) => left < right ? -1 : Number(left > right))
  if (entries.length > 32 || entries.some(([field, value]) => !validName(field) ||
    !(value === null || typeof value === "boolean" || (typeof value === "string" && value.length <= 1024) || Number.isFinite(value)))) {
    throw new TypeError("invalid filter field or value")
  }
  if (query.select !== undefined && (!Array.isArray(query.select) || query.select.length > 32 || !query.select.every(validName))) {
    throw new TypeError("select must contain top-level field names")
  }
  return { filter: Object.fromEntries(entries), select: query.select === undefined ? null : [...new Set(query.select)].sort() }
}

function initialState(options: ServiceOptions): State {
  const sources = options.sources
  if (!sources?.length || sources.length > maxSources) throw new Error("new service requires bounded initial sources")
  for (const source of sources) validateSource(source)
  if (new Set(sources.map(source => source.sourceId)).size !== sources.length) throw new Error("duplicate source identity")
  const maxAcceptedWorkUnits = options.maxAcceptedWorkUnits ?? maxJobs * maxSourceRows
  if (!Number.isSafeInteger(maxAcceptedWorkUnits) || maxAcceptedWorkUnits < 1) throw new TypeError("invalid work budget")
  const faults = options.faults ?? {}
  if (faults.loseAcknowledgement && !validName(faults.loseAcknowledgement.idempotencyKey)) throw new TypeError("invalid lost-ack fault")
  if (faults.changeSource) {
    const { afterAcceptedComputations, source } = faults.changeSource
    validateSource(source)
    if (!Number.isSafeInteger(afterAcceptedComputations) || afterAcceptedComputations < 1 || afterAcceptedComputations > maxJobs ||
      !sources.some(previous => previous.sourceId === source.sourceId && previous.revision !== source.revision)) {
      throw new TypeError("invalid source change fault")
    }
  }
  return {
    schema: 1, sources: [...sources], sourceHistory: sources.map(({ sourceId, revision }) => ({ sourceId, revision })),
    jobs: [], faults, maxAcceptedWorkUnits, sourceChanges: 0, faultSourceChanged: false, unavailableChecks: [],
  }
}

function sourceFor(state: State, sourceId: string): SourceSnapshot {
  const source = state.sources.find(item => item.sourceId === sourceId)
  if (!source) throw new RangeError(`unknown source: ${sourceId}`)
  return source
}

function changeSource(state: State, source: SourceSnapshot): boolean {
  const previous = sourceFor(state, source.sourceId)
  if (previous.revision === source.revision && digest(previous) === digest(source)) return false
  if (state.sourceHistory.some(item => item.sourceId === source.sourceId && item.revision === source.revision)) {
    throw new Error("source revision cannot be reused for different contents or restored after replacement")
  }
  state.sources[state.sources.indexOf(previous)] = source
  state.sourceHistory.push({ sourceId: source.sourceId, revision: source.revision })
  state.sourceChanges++
  return true
}

function getLedger(state: State): ServiceLedger {
  return {
    acceptedComputations: state.jobs.length, jobs: state.jobs.length,
    acceptedWorkUnits: state.jobs.reduce((total, entry) => total + entry.job.workUnits, 0),
    lostAcknowledgements: state.jobs.filter(entry => entry.lostAcknowledgement).length,
    sourceChanges: state.sourceChanges,
  }
}

function markRead(ranges: [number, number][], start: number, end: number): [number, number][] {
  const intervals = [...ranges, [start, end] as [number, number]].sort(([left], [right]) => left - right)
  const merged: [number, number][] = []
  for (const interval of intervals) {
    const last = merged.at(-1)
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1])
    else merged.push(interval)
  }
  return merged
}

const covered = (ranges: [number, number][]) => ranges.reduce((sum, [start, end]) => sum + end - start, 0)

/** Local Bun service. The host owns the database and exposes only the contestant-facing methods. */
export class HardBenchmarkService {
  private readonly statePath: string
  private readonly options: ServiceOptions

  constructor(private readonly stateDirectory: string, options: ServiceOptions = {}) {
    this.statePath = join(stateDirectory, "service-state.sqlite")
    this.options = structuredClone(options)
  }

  private transact<T>(operation: (state: State) => { value: T; changed?: boolean }): T {
    mkdirSync(this.stateDirectory, { recursive: true })
    const db = new Database(this.statePath)
    try {
      db.exec("PRAGMA busy_timeout = 5000")
      db.exec("PRAGMA synchronous = FULL")
      db.exec("CREATE TABLE IF NOT EXISTS benchmark_state (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)")
      return db.transaction(() => {
        const row = db.query<{ body: string }, []>("SELECT body FROM benchmark_state WHERE id = 1").get()
        const state: State = row ? JSON.parse(row.body) : initialState(this.options)
        if (state.schema !== 1) throw new Error("unsupported benchmark service state")
        const { value, changed } = operation(state)
        if (!row || changed) db.query("INSERT OR REPLACE INTO benchmark_state VALUES (1, ?)").run(JSON.stringify(state))
        return value
      }).immediate()
    } finally {
      db.close()
    }
  }

  /** Work is charged by source rows scanned. An accepted empty source still costs one unit. */
  async submit(query: RawQuery): Promise<QueryJob> {
    const scope = queryScope(query)
    const result = this.transact(state => {
      const prior = state.jobs.find(entry => entry.idempotencyKey === query.idempotencyKey)
      if (prior) {
        if (prior.job.sourceId !== query.sourceId || (query.expectedRevision ?? prior.job.sourceRevision) !== prior.job.sourceRevision ||
          digest(prior.scope) !== digest(scope)) throw new Error("idempotency key reused for different query")
        return { value: { job: prior.job, loseAck: false } }
      }
      const source = sourceFor(state, query.sourceId)
      if (query.expectedRevision !== undefined && source.revision !== query.expectedRevision) {
        throw new StaleSourceError(query.sourceId, query.expectedRevision, source.revision)
      }
      if (source.available === false) throw new SourceUnavailableError(source.sourceId, source.revision)
      const workUnits = Math.max(1, source.rows.length)
      if (state.jobs.length >= maxJobs || workUnits > state.maxAcceptedWorkUnits - getLedger(state).acceptedWorkUnits) {
        throw new RangeError("accepted work budget exceeded")
      }
      const filters = Object.entries(scope.filter)
      const rows = source.rows.filter(row => filters.every(([key, value]) => Object.hasOwn(row, key) && row[key] === value))
        .map(row => scope.select === null ? row : Object.fromEntries(scope.select.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])))
      if (rows.length > maxResultRows || bytes(rows) > maxResultBytes || rows.some(row => bytes(row) + 2 > maxPageRowBytes)) {
        throw new RangeError("result exceeds service limits; narrow the query")
      }
      const job: QueryJob = {
        jobId: randomUUID(), sourceId: source.sourceId, sourceRevision: source.revision, rowCount: rows.length,
        resultDigest: digest(rows), workUnits, status: "complete", acceptedAt: Date.now(),
      }
      const loseAck = state.faults.loseAcknowledgement?.idempotencyKey === query.idempotencyKey
      state.jobs.push({ job, scope, idempotencyKey: query.idempotencyKey, rows, lostAcknowledgement: loseAck,
        recoveredByLookup: false, statusChecked: false, lookedUp: false, readRanges: [], currentReadRanges: [] })
      const fault = state.faults.changeSource
      if (fault && !state.faultSourceChanged && state.jobs.length === fault.afterAcceptedComputations) {
        changeSource(state, fault.source)
        state.faultSourceChanged = true
      }
      return { value: { job, loseAck }, changed: true }
    })
    if (result.loseAck) throw new LostAcknowledgementError(query.idempotencyKey)
    return result.job
  }

  async lookup(idempotencyKey: string): Promise<QueryJob | undefined> {
    return this.transact(state => {
      const entry = state.jobs.find(item => item.idempotencyKey === idempotencyKey)
      if (!entry) return { value: undefined }
      const changed = !entry.lookedUp
      entry.lookedUp = true
      if (entry.lostAcknowledgement) entry.recoveredByLookup = true
      return { value: entry.job, changed }
    })
  }

  async status(jobId: string): Promise<QueryJob | undefined> {
    return this.transact(state => {
      const entry = state.jobs.find(item => item.job.jobId === jobId)
      if (!entry) return { value: undefined }
      const changed = !entry.statusChecked
      entry.statusChecked = true
      return { value: entry.job, changed }
    })
  }

  async manifest(jobId: string): Promise<JobManifest | undefined> {
    return this.transact(state => {
      const job = state.jobs.find(item => item.job.jobId === jobId)?.job
      if (!job) return { value: undefined }
      const { jobId: id, sourceId, sourceRevision, rowCount, resultDigest, workUnits } = job
      return { value: { jobId: id, sourceId, sourceRevision, rowCount, resultDigest, workUnits } }
    })
  }

  /** Current reads reject stale jobs. Explicit snapshot reads preserve historical results for inspection. */
  async readPage(jobId: string, cursor: string | undefined, limit: number, consistency: "current" | "snapshot" = "current"): Promise<ResultPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maxPageRows) throw new RangeError("page limit must be 1..100")
    if (consistency !== "current" && consistency !== "snapshot") throw new TypeError("invalid page consistency")
    return this.transact(state => {
      const entry = state.jobs.find(item => item.job.jobId === jobId)
      if (!entry) throw new RangeError(`unknown job: ${jobId}`)
      const { job, rows } = entry
      const source = sourceFor(state, job.sourceId)
      if (consistency === "current" && source.revision !== job.sourceRevision) throw new StaleSourceError(job.sourceId, job.sourceRevision, source.revision)
      if (consistency === "current" && source.available === false) throw new SourceUnavailableError(source.sourceId, source.revision)
      const position = typeof cursor === "string" && cursor.startsWith(`${jobId}:`) ? cursor.slice(jobId.length + 1) : ""
      const offset = cursor === undefined ? 0 : Number(position)
      if (cursor !== undefined && (!/^[1-9]\d*$/.test(position) || !Number.isSafeInteger(offset) || offset >= rows.length)) {
        throw new RangeError("invalid result cursor")
      }
      const page: Row[] = []
      let payloadBytes = 2
      for (const row of rows.slice(offset, offset + limit)) {
        payloadBytes += bytes(row) + Number(page.length > 0)
        if (payloadBytes > maxPageRowBytes) break
        page.push(row)
      }
      const next = offset + page.length
      if (page.length) {
        entry.readRanges = markRead(entry.readRanges, offset, next)
        if (consistency === "current") entry.currentReadRanges = markRead(entry.currentReadRanges, offset, next)
      }
      const value = { jobId, sourceRevision: job.sourceRevision, rows: page, ...(next < rows.length ? { nextCursor: `${jobId}:${next}` } : {}) }
      return { value, changed: page.length > 0 }
    })
  }

  async sourceStatus(sourceId: string): Promise<{ revision: string; available: boolean } | undefined> {
    return this.transact(state => {
      const source = state.sources.find(item => item.sourceId === sourceId)
      if (!source) return { value: undefined }
      const available = source.available !== false
      const changed = !available && !state.unavailableChecks.some(check => check.sourceId === sourceId && check.revision === source.revision)
      if (changed) state.unavailableChecks.push({ sourceId, revision: source.revision })
      return { value: { revision: source.revision, available }, changed }
    })
  }

  async currentRevision(sourceId: string): Promise<string | undefined> {
    return this.transact(state => ({ value: state.sources.find(item => item.sourceId === sourceId)?.revision }))
  }

  async replaceSource(source: SourceSnapshot, review: { approved: true; reason: string }): Promise<void> {
    if (review.approved !== true || typeof review.reason !== "string" || !review.reason.trim()) throw new Error("source refresh requires an explicit review reason")
    validateSource(source)
    this.transact(state => ({ value: undefined, changed: changeSource(state, source) }))
  }

  async ledger(): Promise<ServiceLedger> {
    return this.transact(state => ({ value: getLedger(state) }))
  }

  /** Trusted grader input. Keep this method and replaceSource out of the contestant API. */
  async evidence(): Promise<ServiceEvidence> {
    return this.transact(state => ({ value: {
      ledger: getLedger(state), unavailableChecks: state.unavailableChecks,
      sources: state.sources.map(({ sourceId, revision, available }) => ({ sourceId, revision, available: available !== false })),
      jobs: state.jobs.map(({ job, idempotencyKey, scope, lostAcknowledgement, recoveredByLookup, statusChecked, lookedUp, readRanges, currentReadRanges }) => ({
        job, idempotencyKey, scope, lostAcknowledgement, recoveredByLookup, statusChecked, lookedUp,
        rowsRead: covered(readRanges), currentRowsRead: covered(currentReadRanges),
      })),
    } }))
  }
}


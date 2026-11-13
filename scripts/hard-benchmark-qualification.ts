import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  executeLocalMultiRepo, openHardFixtureService, scoreHardFixture,
  type ContestantFixture, type CreatedHardFixture, type FixtureScore, type FixtureSubmission, type MultiRepoRunner,
} from "./hard-benchmark-fixtures.ts"
import type { HardBenchmarkService, QueryJob, ResultPage } from "./hard-benchmark-service.ts"

/** Methods visible to either benchmark arm. Grader evidence and source mutation are intentionally absent. */
export type HardBenchmarkServiceClient = Pick<HardBenchmarkService,
  "submit" | "lookup" | "status" | "manifest" | "readPage" | "sourceStatus" | "currentRevision" | "ledger">

export interface HardBenchmarkArmContext {
  readonly fixture: ContestantFixture
  readonly service?: HardBenchmarkServiceClient
}

export type HardBenchmarkArm = (context: HardBenchmarkArmContext) => Promise<FixtureSubmission>
export type QualificationCase = "positive" | "negative" | "tamper" | "extra-field"

/** An explicitly unavailable host runner, distinct from candidate code failing execution. */
export class HardBenchmarkRunnerUnavailableError extends Error {}

function isRunnerUnavailableError(error: unknown): boolean {
  if (error instanceof HardBenchmarkRunnerUnavailableError) return true
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined
  return ["EPERM", "EACCES", "ENOENT", "ENOEXEC", "ENOSYS"].includes(String(code))
}

/** Shared live/qualification development scorer. The local child is bounded, not OS isolated. */
export async function scoreHardDevelopmentFixture(fixture: CreatedHardFixture, submission: FixtureSubmission,
  options: { service?: HardBenchmarkService; multiRepoRunner?: MultiRepoRunner | null; compatibilitySeed?: number } = {}) {
  if (fixture.contestant.family !== "multi-repo-compatibility")
    return scoreHardFixture(fixture, submission, { service: options.service })
  const runner = options.multiRepoRunner === undefined ? executeLocalMultiRepo : options.multiRepoRunner
  if (!runner) throw new HardBenchmarkRunnerUnavailableError("hard_multi_repo_runner_unavailable: no runner configured")
  let unavailable = false
  const grade = await scoreHardFixture(fixture, submission, { compatibilitySeed: options.compatibilitySeed,
    multiRepoRunner: async (...args) => {
      try { return await runner(...args) }
      catch (error) { if (isRunnerUnavailableError(error)) unavailable = true; throw error }
    } })
  // The core scorer converts child exceptions into failed execution checks.
  // Missing host facilities are unavailable evidence, not candidate code failures.
  if (unavailable) throw new HardBenchmarkRunnerUnavailableError("hard_multi_repo_runner_unavailable: host runner could not execute")
  return grade
}

export interface HardBenchmarkQualificationResult {
  fixtureId: string
  family: string
  case: QualificationCase
  status: "passed" | "blocked" | "failed"
  passed: boolean
  expected: "accept" | "reject"
  grade: FixtureScore
  /** Same-user execution is development evidence; it is not a blinded or isolated holdout. */
  isolation: "same-user-development-only-not-os-isolated"
}

function json(value: unknown): string { return `${JSON.stringify(value, null, 2)}\n` }
function object(text: string | undefined): Record<string, any> {
  if (text === undefined) return {}
  const value: unknown = JSON.parse(text)
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {}
}

function publicFixture(fixture: CreatedHardFixture): ContestantFixture {
  // This guards the in-process facade only; it does not attest to filesystem write isolation.
  const copy = structuredClone(fixture.contestant)
  Object.freeze(copy.criteria)
  Object.freeze(copy.protectedPaths)
  Object.freeze(copy.files)
  return Object.freeze(copy)
}

function serviceClient(service: HardBenchmarkService): HardBenchmarkServiceClient {
  const client = {
    submit: service.submit.bind(service), lookup: service.lookup.bind(service), status: service.status.bind(service),
    manifest: service.manifest.bind(service), readPage: service.readPage.bind(service),
    sourceStatus: service.sourceStatus.bind(service), currentRevision: service.currentRevision.bind(service),
    ledger: service.ledger.bind(service),
  }
  return Object.freeze(client)
}

async function readAll(service: HardBenchmarkServiceClient, jobId: string) {
  const rows: Readonly<Record<string, unknown>>[] = []
  let cursor: string | undefined
  do {
    const page: ResultPage = await service.readPage(jobId, cursor, 50)
    rows.push(...page.rows)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return rows
}

function particleSummary(rows: readonly Readonly<Record<string, unknown>>[], window: string) {
  const observations = new Map<string, boolean>()
  for (const row of rows) {
    if (row.window !== window) continue
    const key = JSON.stringify([row.lot, row.observation])
    observations.set(key, (observations.get(key) ?? false) || row.affected === true)
  }
  const affectedLots = new Set<string>()
  let numerator = 0
  for (const [key, affected] of observations) if (affected) {
    numerator++
    affectedLots.add(JSON.parse(key)[0])
  }
  return { numerator, denominator: observations.size, rate: numerator / observations.size, affectedLots: [...affectedLots].sort() }
}

async function acceptedQueryReference(fixture: ContestantFixture, service: HardBenchmarkServiceClient): Promise<FixtureSubmission> {
  const request = object(fixture.files["sources/request.json"])
  try {
    await service.submit({ sourceId: request.sourceId, expectedRevision: request.revision,
      idempotencyKey: request.idempotencyKey, filter: { window: request.window } })
  } catch { /* The fixture loses the acknowledgement after committing the job. */ }
  const job = await service.lookup(request.idempotencyKey) as QueryJob
  if (!job) throw new Error("reference could not recover accepted query")
  await service.status(job.jobId)
  const rows = await readAll(service, job.jobId)
  const summary = particleSummary(rows, request.window)
  const report = { ...summary, jobId: job.jobId, sourceRevision: job.sourceRevision, resultDigest: job.resultDigest }
  return { files: { ...fixture.files, "report.json": json(report) } }
}

async function partialRestartReference(fixture: ContestantFixture, service: HardBenchmarkServiceClient): Promise<FixtureSubmission> {
  const checkpoints = JSON.parse(fixture.files["sources/checkpoint.json"]!) as { sourceId: string; idempotencyKey: string }[]
  const jobs = new Map<string, QueryJob>()
  const rowsBySource = new Map<string, readonly Readonly<Record<string, unknown>>[]>()
  for (const checkpoint of checkpoints) {
    const job = await service.lookup(checkpoint.idempotencyKey)
    if (!job) continue
    await service.status(job.jobId)
    jobs.set(checkpoint.sourceId, job)
    try { rowsBySource.set(checkpoint.sourceId, await readAll(service, job.jobId)) } catch { /* stale evidence is not reused */ }
  }
  const particle = checkpoints[0]!.sourceId, maintenance = checkpoints[1]!.sourceId, unavailable = checkpoints[2]!
  const summary = particleSummary(rowsBySource.get(particle) ?? [], "review-shift")
  const overlapRows = rowsBySource.get(maintenance) ?? []
  const overlapLots = summary.affectedLots.filter(lot => overlapRows.some(row => row.lot === lot && row.overlaps === true))
  const current = await service.sourceStatus(unavailable.sourceId)
  const unresolved = { sourceId: unavailable.sourceId, revision: current?.revision ?? "", available: current?.available ?? false }
  const retained = Object.fromEntries([particle, maintenance].map(sourceId => {
    const job = jobs.get(sourceId)
    return [sourceId, job && { jobId: job.jobId, sourceRevision: job.sourceRevision, resultDigest: job.resultDigest }]
  }))
  return { files: { ...fixture.files, "report.json": json({ retained, particle: summary, overlapLots, unresolved, causalIdentified: false }) } }
}

type Wafer = { lot_id: string; wafer_id: string; defect: boolean }
function multiRepoReference(fixture: ContestantFixture): FixtureSubmission {
  const initial = JSON.parse(fixture.files["repos/ingestion/src/export.json"]!).rows as Wafer[]
  const api = `export function summarizeLot(rows) {
  const lots = new Map()
  for (const row of rows) {
    const wafers = lots.get(row.lot_id) ?? new Map()
    wafers.set(row.wafer_id, (wafers.get(row.wafer_id) ?? false) || row.defect === true)
    lots.set(row.lot_id, wafers)
  }
  return [...lots].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([lotId, wafers]) => ({
    lotId, waferCount: wafers.size, defectRate: [...wafers.values()].filter(Boolean).length / wafers.size
  }))
}
export function eventCount(rows) { return rows.length }
`
  const client = `import { summarizeLot } from "@factory/api"
export function render(rows) { return summarizeLot(rows).map(({ lotId, defectRate }) => ({ label: lotId, rate: defectRate })) }
`
  const summary = new Map<string, Map<string, boolean>>()
  for (const row of initial) {
    const wafers = summary.get(row.lot_id) ?? new Map<string, boolean>()
    wafers.set(row.wafer_id, (wafers.get(row.wafer_id) ?? false) || row.defect)
    summary.set(row.lot_id, wafers)
  }
  const apiResult = [...summary].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([lotId, wafers]) => ({
    lotId, waferCount: wafers.size, defectRate: [...wafers.values()].filter(Boolean).length / wafers.size,
  }))
  return { files: { ...fixture.files, "repos/api/src/index.ts": api, "repos/client/src/report.ts": client,
    "validation.json": json({ api: apiResult, client: apiResult.map(row => ({ label: row.lotId, rate: row.defectRate })), eventCount: initial.length }) } }
}

type Cell = { recipe: string; shift: string; C1: { failed: number; total: number }; C2: { failed: number; total: number } }
function factoryReference(fixture: ContestantFixture): FixtureSubmission {
  const files = fixture.files
  const registry = object(files["evidence/registry.json"])
  const catalog = files["catalog/catalog.jsonl"]!.trimEnd().split("\n").map(line => object(line))
  const sourceFiles = Object.fromEntries(["inspections", "assignments", "maintenance"].map(source => {
    const item = catalog.find(entry => entry.source === source && entry.revision === registry[source])
    if (!item) throw new Error(`reference cannot find current ${source}`)
    return [source, JSON.parse(files[item.path]!).rows as Record<string, any>[]]
  })) as Record<string, Record<string, any>[]>
  const incident = object(files["evidence/incident.json"])
  const maint = sourceFiles.maintenance!.filter(row => row.action === "cleaning" && Date.parse(row.endedAt) <= Date.parse(incident.asOf))
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))
  const clean = { C1: maint.find(row => row.chamber === "C1")!, C2: maint.find(row => row.chamber === "C2")! }
  const start = Math.max(Date.parse(clean.C1.endedAt), Date.parse(clean.C2.endedAt)), end = start + incident.hoursAfterClean * 3_600_000
  const events = sourceFiles.inspections!.filter(row => Date.parse(row.inspectedAt) >= start && Date.parse(row.inspectedAt) < end)
  const strata = new Map<string, Cell>()
  for (const assignment of sourceFiles.assignments!) {
    const lotRows = events.filter(event => event.lot === assignment.lot)
    if (!lotRows.length) continue
    const key = JSON.stringify([assignment.recipe, assignment.shift])
    const cell = strata.get(key) ?? { recipe: assignment.recipe, shift: assignment.shift,
      C1: { failed: 0, total: 0 }, C2: { failed: 0, total: 0 } }
    const distinct = new Map<string, boolean>()
    for (const row of lotRows) distinct.set(row.wafer, (distinct.get(row.wafer) ?? false) || row.defect === true)
    cell[assignment.chamber as "C1" | "C2"].total += distinct.size
    cell[assignment.chamber as "C1" | "C2"].failed += [...distinct.values()].filter(Boolean).length
    strata.set(key, cell)
  }
  const cells = [...strata.values()]
  const shared = cells.filter(cell => cell.C1.total > 0 && cell.C2.total > 0)
  const eligible = shared.filter(cell => cell.C1.total >= incident.minimumPerChamber && cell.C2.total >= incident.minimumPerChamber)
  const elevated = eligible.filter(cell => cell.C1.failed / cell.C1.total - cell.C2.failed / cell.C2.total >= incident.minimumRateDifference)
  const kind = shared.length === 0 ? "confounded" : eligible.length === 0 ? "insufficient"
    : elevated.length === eligible.length ? "chamber-effect" : "no-consistent-elevation"
  const nextMeasurement = kind === "insufficient" ? shared.map(cell => ({ recipe: cell.recipe, shift: cell.shift,
    targetPerChamber: incident.minimumPerChamber,
    additional: { C1: Math.max(0, incident.minimumPerChamber - cell.C1.total), C2: Math.max(0, incident.minimumPerChamber - cell.C2.total) },
  }))[0] : null
  const report = { window: { start: new Date(start).toISOString(), endExclusive: new Date(end).toISOString() },
    cleanings: { C1: clean.C1.id, C2: clean.C2.id },
    sources: Object.fromEntries(["inspections", "assignments", "maintenance"].map(source => {
      const entry = catalog.find(item => item.source === source && item.revision === registry[source])!
      return [source, { path: entry.path, revision: entry.revision }]
    })), joinKey: ["lot", "wafer"], strata: cells,
    comparison: { sharedStrata: shared.length, eligibleStrata: eligible.length, elevatedStrata: elevated.length },
    conclusion: { kind, causalIdentified: false }, nextMeasurement }
  return { files: { ...files, "report.json": json(report) } }
}

export const hardBenchmarkReferenceArm: HardBenchmarkArm = async ({ fixture, service }) => {
  switch (fixture.family) {
    case "accepted-query-lost-ack": return acceptedQueryReference(fixture, service!)
    case "partial-investigation-restart": return partialRestartReference(fixture, service!)
    case "multi-repo-compatibility": return multiRepoReference(fixture)
    case "factory-evidence": return factoryReference(fixture)
  }
}

export const hardBenchmarkNegativeArm: HardBenchmarkArm = async context => {
  const good = await hardBenchmarkReferenceArm(context)
  const path = context.fixture.family === "multi-repo-compatibility" ? "validation.json" : "report.json"
  const value = object(good.files[path])
  switch (context.fixture.family) {
    case "accepted-query-lost-ack": value.denominator += 1; break
    case "partial-investigation-restart": value.particle.denominator += 1; break
    case "factory-evidence": value.conclusion.kind = "unsupported-causal-effect"; break
    case "multi-repo-compatibility": value.eventCount += 1; break
  }
  return { files: { ...good.files, [path]: json(value) } }
}

export const hardBenchmarkTamperArm: HardBenchmarkArm = async context => {
  const good = await hardBenchmarkReferenceArm(context)
  if (context.service && (context.service as unknown as { evidence?: unknown }).evidence !== undefined) {
    throw new Error("trusted grader evidence crossed the arm boundary")
  }
  return { files: { ...good.files, "README.md": "tampered" } }
}

/** Starts from the valid reference output and adds one undeclared root property. */
export const hardBenchmarkExtraFieldArm: HardBenchmarkArm = async context => {
  const good = await hardBenchmarkReferenceArm(context)
  const path = context.fixture.family === "multi-repo-compatibility" ? "validation.json" : "report.json"
  const value = object(good.files[path])
  value.__qualificationExtraField = true
  return { files: { ...good.files, [path]: json(value) } }
}

export async function qualifyHardBenchmarkCase(
  fixture: CreatedHardFixture,
  arm: HardBenchmarkArm,
  testCase: QualificationCase,
  options: { multiRepoRunner?: MultiRepoRunner | null; compatibilitySeed?: number } = {},
): Promise<HardBenchmarkQualificationResult> {
  const directory = await mkdtemp(join(tmpdir(), "hard-benchmark-qualification-"))
  try {
    const needsService = fixture.contestant.family === "accepted-query-lost-ack" || fixture.contestant.family === "partial-investigation-restart"
    const service = needsService ? await openHardFixtureService(fixture, directory) : undefined
    const visible = publicFixture(fixture)
    const context = { fixture: visible, ...(service ? { service: serviceClient(service) } : {}) }
    const submission = await arm(context)
    let runnerUnavailable = false
    let grade: FixtureScore
    try { grade = await scoreHardDevelopmentFixture(fixture, submission, { ...options, service }) }
    catch (error) {
      if (!isRunnerUnavailableError(error)) throw error
      runnerUnavailable = true
      grade = { passed: false, checks: [{ id: "runner:available", passed: false, detail: "local runner unavailable" }], metrics: {} }
    }
    const expected = testCase === "positive" ? "accept" : "reject"
    const passed = !runnerUnavailable && grade.passed === (expected === "accept")
    return { fixtureId: fixture.contestant.id, family: fixture.contestant.family, case: testCase,
      status: runnerUnavailable ? "blocked" : passed ? "passed" : "failed", passed, expected, grade,
      isolation: "same-user-development-only-not-os-isolated" }
  } finally { await rm(directory, { recursive: true, force: true }) }
}

export async function qualifyHardBenchmarkDevelopment(fixtures: readonly CreatedHardFixture[]) {
  const rows: HardBenchmarkQualificationResult[] = []
  for (const fixture of fixtures) {
    rows.push(await qualifyHardBenchmarkCase(fixture, hardBenchmarkReferenceArm, "positive"))
    rows.push(await qualifyHardBenchmarkCase(fixture, hardBenchmarkNegativeArm, "negative"))
    rows.push(await qualifyHardBenchmarkCase(fixture, hardBenchmarkTamperArm, "tamper"))
    rows.push(await qualifyHardBenchmarkCase(fixture, hardBenchmarkExtraFieldArm, "extra-field"))
  }
  return { isolation: "same-user-development-only-not-os-isolated" as const,
    results: rows, passed: rows.every(row => row.status === "passed"), caseCount: rows.length,
    acceptedPositive: rows.filter(row => row.case === "positive" && row.grade.passed).length,
    rejectedNegativeOrTamper: rows.filter(row => ["negative", "tamper"].includes(row.case) && !row.grade.passed).length,
    rejectedExtraField: rows.filter(row => row.case === "extra-field" && !row.grade.passed).length,
    blockedCases: rows.filter(row => row.status === "blocked").length,
    failedCases: rows.filter(row => row.status === "failed").length }
}

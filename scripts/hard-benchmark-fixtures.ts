import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { HardBenchmarkService, type ServiceOptions, type SourceSnapshot } from "./hard-benchmark-service.ts"

export type HardBenchmarkFamily = "accepted-query-lost-ack" | "multi-repo-compatibility" | "factory-evidence" | "partial-investigation-restart"
export type FactoryTruth = "true-effect" | "confounded" | "insufficient"
type Files = Readonly<Record<string, string>>
type Scenario =
  | { kind: "accepted-query-lost-ack"; source: SourceSnapshot; key: string; window: string }
  | { kind: "partial-investigation-restart"; sources: readonly [SourceSnapshot, SourceSnapshot, SourceSnapshot]; unavailable: SourceSnapshot }
  | { kind: "multi-repo-compatibility" }
  | { kind: "factory-evidence" }

export interface ContestantFixture {
  id: string
  family: HardBenchmarkFamily
  request: string
  criteria: readonly string[]
  files: Files
  protectedPaths: readonly string[]
}
export interface HardBenchmarkGraderRecord {
  fixtureId: string
  family: HardBenchmarkFamily
  protectedHashes: Files
  allowedWritePaths: readonly string[]
  scenario: Scenario
}
export interface CreatedHardFixture { contestant: ContestantFixture; grader: HardBenchmarkGraderRecord }
export interface FixtureSubmission { files: Files }
export interface FixtureCheck { id: string; passed: boolean; detail?: string }
export interface FixtureScore { passed: boolean; checks: FixtureCheck[]; metrics: Record<string, number | string | boolean> }

const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const report = "report.json"
const apiPath = "repos/api/src/index.ts"
const clientPath = "repos/client/src/report.ts"
const ingestionPath = "repos/ingestion/src/export.json"

function created(id: string, request: string, criteria: string[], files: Files, scenario: Scenario): CreatedHardFixture {
  const family = scenario.kind
  const allowedWritePaths = family === "multi-repo-compatibility" ? [apiPath, clientPath, "validation.json"] : [report]
  const protectedPaths = Object.keys(files).filter(path => !allowedWritePaths.includes(path))
  return {
    contestant: { id, family, request, criteria, files, protectedPaths },
    grader: { fixtureId: id, family, allowedWritePaths, scenario,
      protectedHashes: Object.fromEntries(protectedPaths.map(path => [path, hash(files[path]!)])) },
  }
}

const rawPrimitives = `# Synthetic query service
submit({idempotencyKey, sourceId, expectedRevision?, filter?, select?}) accepts an equality filter and optional top-level projection.
Use lookup(idempotencyKey), status(jobId), manifest(jobId), sourceStatus(sourceId), currentRevision(sourceId), and readPage(jobId, cursor, limit).
Use the returned cursor until there is no nextCursor. Current reads reject stale jobs. Report actual job IDs and result digests where requested.
An acknowledgement can be lost after acceptance. Recover using lookup with the original caller key. Accepted work is charged by scanned source rows; reads and lookups are free.
Output reports must be JSON objects no larger than 65536 UTF-8 bytes. Keep additional explanation in your final response, outside the report.`

function particleRows(window: string, total: number, failures: readonly number[]) {
  const rows = Array.from({ length: total }, (_, index) => ({
    window, lot: `L${1 + index % 4}`, observation: `OBS-${index + 1}`, affected: failures.includes(index),
  }))
  return [
    ...rows.filter((_, index) => index % 2 === 1).reverse(),
    ...rows.filter((_, index) => index % 2 === 0).map(row => row.affected ? { ...row, affected: false } : row),
    ...rows.filter((row, index) => row.affected && index % 2 === 0),
    { ...rows[0]! }, { window: "prior-shift", lot: "L9", observation: "OBS-1", affected: true },
  ]
}

export function createAcceptedQueryLostAckFixture(seed = 0): CreatedHardFixture {
  const window = "review-shift", key = "particle-review", source = {
    sourceId: "particle-map", revision: "r7",
    rows: particleRows(window, 41 + seed % 11, [0, 3, 8, 14, 21, 30 + seed % 7, ...(seed % 2 ? [32] : [])]),
  }
  return created(`accepted-query-lost-ack-v1-${seed}`, "Recover a bounded particle summary after an accepted query loses its acknowledgement. Write report.json at the workspace root as a JSON object with exactly the fields specified in sources/request.json.",
    ["Submit once for the requested window and revision. Recover by lookup, check the job and read its complete result.", "Leave process controls unchanged."], {
      "README.md": rawPrimitives,
      "sources/request.json": json({ sourceId: source.sourceId, revision: source.revision, window, idempotencyKey: key,
        aggregation: "Within the requested window, an observation is identified by (lot, observation) and is affected if any of its rows is affected.",
        reportPath: report,
        reportFields: ["numerator", "denominator", "rate", "affectedLots", "sourceRevision", "jobId", "resultDigest"],
        objectPolicy: "The report object must contain exactly reportFields and no additional properties. Every nested object, if any, must contain exactly its declared keys and no additional properties.",
        reportFormat: { numerator: "Affected observation count as an integer", denominator: "Distinct observation count as an integer",
          rate: "Numerator divided by denominator as a JSON number, without rounding",
          affectedLots: "Sorted distinct affected lot IDs as an array of strings",
          sourceRevision: "Revision string from the recovered job", jobId: "ID string from the recovered job",
          resultDigest: "Digest string from the recovered job" },
        procedure: "Read service data and write only report.json; leave process controls and supplied evidence unchanged" }),
    }, { kind: "accepted-query-lost-ack", source, key, window })
}

export function createPartialInvestigationRestartFixture(): CreatedHardFixture {
  const sources = [
    { sourceId: "particle-window", revision: "p11", rows: particleRows("review-shift", 18, [1, 3, 5, 6, 10]) },
    { sourceId: "maintenance-alignment", revision: "m5", rows: [
      { lot: "L2", overlaps: true }, { lot: "L4", overlaps: false }, { lot: "L2", overlaps: true },
      { lot: "L1", overlaps: true }, { lot: "L3", overlaps: false },
    ] },
    { sourceId: "recipe-check", revision: "r2", rows: [{ lot: "L2", recipe: "legacy", highRisk: true }] },
  ] as const
  const unavailable = { sourceId: "recipe-check", revision: "r3", available: false, rows: [] }
  return created("partial-investigation-restart-v1", "After restart, reconcile completed results against current sources and bound the investigation while the recipe branch is unavailable. Write report.json at the workspace root as a JSON object matching sources/report-contract.json.",
    ["Find the completed jobs by their checkpoint keys. Check current revisions and statuses before reuse.",
      "Deduplicate particle observations by (lot, observation) and report affected observations in review-shift and the affected lots that intersect overlapping maintenance.",
      "Report unresolved recipe status from the current source. Preserve the existing accepted-work ledger."], {
      "README.md": rawPrimitives + "\nThe checkpoint holds caller keys and source IDs. It contains no computed result. The service and checkpoint survive restart.\n",
      "sources/checkpoint.json": json(sources.map(source => ({ sourceId: source.sourceId, idempotencyKey: source.sourceId }))),
      "sources/report-contract.json": json({
        reportFields: ["retained", "particle", "overlapLots", "unresolved", "causalIdentified"],
        objectPolicy: "The report must contain exactly reportFields. Nested objects must contain exactly the keys in their declared shapes. No additional properties; contract metadata itself is not an output field.",
        retained: "{ [sourceId]: { jobId, sourceRevision, resultDigest } } for the two current jobs",
        particle: "{ numerator, denominator, rate, affectedLots }: integer observation counts, rate as numerator/denominator without rounding, and sorted distinct affected lot IDs. An observation is affected if any matching row is affected.",
        overlapLots: "Sorted distinct affected lots with at least one overlaps=true maintenance row",
        unresolved: "{ sourceId, revision, available: false }",
        causalIdentified: false,
      }),
    }, { kind: "partial-investigation-restart", sources, unavailable })
}

/** Host startup and checkpoint seeding. Do not expose this or the grader record to a contestant. */
export async function openHardFixtureService(fixture: CreatedHardFixture, directory: string): Promise<HardBenchmarkService> {
  const scenario = fixture.grader.scenario
  let options: ServiceOptions
  if (scenario.kind === "accepted-query-lost-ack") {
    options = { sources: [scenario.source], faults: { loseAcknowledgement: { idempotencyKey: scenario.key } },
      maxAcceptedWorkUnits: scenario.source.rows.length }
  } else if (scenario.kind === "partial-investigation-restart") {
    options = { sources: scenario.sources, maxAcceptedWorkUnits: scenario.sources.reduce((total, source) => total + source.rows.length, 0),
      faults: { changeSource: { afterAcceptedComputations: scenario.sources.length, source: scenario.unavailable } } }
  } else {
    throw new Error("this fixture has no query service")
  }
  const service = new HardBenchmarkService(directory, options)
  if (scenario.kind === "partial-investigation-restart") {
    for (const source of scenario.sources) {
      await service.submit({ idempotencyKey: source.sourceId, sourceId: source.sourceId, expectedRevision: source.revision })
    }
  }
  await service.ledger()
  return new HardBenchmarkService(directory)
}

type IngestRow = { lot_id: string; wafer_id: string; defect: boolean }
const apiInitial = `export type LotSummary = { lotId: string; waferCount: number; defectRate: number }
export type Inspection = { lot_id: string; wafer_id: string; defect: boolean }
export function summarizeLot(rows: Inspection[]): LotSummary[] { throw new Error("TODO") }
export function eventCount(rows: Inspection[]): number { return rows.length }
`
const clientInitial = `import { summarizeLot, type Inspection } from "@factory/api"
export function render(rows: Inspection[]) {
  return summarizeLot(rows).filter(lot => lot.defectRate).map(lot => ({ label: lot.lotId, rate: lot.defectRate.toFixed(2) }))
}
`

export function createMultiRepoCompatibilityFixture(): CreatedHardFixture {
  return created("multi-repo-compat-v1", "Repair the API and report consumer across the three repository roots. Emit validation.json as an object with exactly these keys and no additional properties: api, client, eventCount. Each api item must have exactly lotId, waferCount, defectRate; each client item must have exactly label, rate. These nested objects allow no additional properties.",
    ["Count each wafer once per lot. A wafer is defective if any row marks it defective.",
      "Return lots in ascending code-unit order as { lotId, waferCount, defectRate }. Preserve numeric precision.",
      "Render every lot, including zero rates, as { label, rate } using the API. Preserve the sibling eventCount export and avoid mutating inputs.",
      "Only edit the API, report consumer and validation.json. Hidden runs will include new inputs.",
      "Each edited source file and validation.json must be at most 65536 UTF-8 bytes. The local validation runner allows five seconds per invocation and at most 131072 stdout bytes; avoid top-level logging. Keep explanations in the final response."], {
      "README.md": "The roots are repos/ingestion, repos/api, and repos/client. The client imports @factory/api.",
      [ingestionPath]: json({ rows: [
        { lot_id: "B", wafer_id: "W1", defect: false },
        { lot_id: "A", wafer_id: "W1", defect: false }, { lot_id: "A", wafer_id: "W1", defect: true },
        { lot_id: "A", wafer_id: "W2", defect: false }, { lot_id: "A", wafer_id: "W3", defect: false },
      ] }),
      "repos/ingestion/CONTRACT.md": "Events use lot_id, wafer_id and defect. A wafer ID can repeat across lots and within a lot.",
      [apiPath]: apiInitial, [clientPath]: clientInitial,
      "repos/client/fixtures/expected.json": json({ input: [], output: [] }),
    }, { kind: "multi-repo-compatibility" })
}

function lotOracle(rows: readonly IngestRow[]) {
  const lotIds = [...new Set(rows.map(row => row.lot_id))].sort()
  const api = lotIds.map(lotId => {
    const inLot = rows.filter(row => row.lot_id === lotId)
    const waferCount = new Set(inLot.map(row => row.wafer_id)).size
    return { lotId, waferCount, defectRate: new Set(inLot.filter(row => row.defect).map(row => row.wafer_id)).size / waferCount }
  })
  return { api, client: api.map(lot => ({ label: lot.lotId, rate: lot.defectRate })), eventCount: rows.length }
}

function compatibilityInputs(visible: IngestRow[], seed: number): IngestRow[][] {
  let state = seed >>> 0
  const next = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) >>> 12
  const hidden = Array.from({ length: 12 }, (_, index) => {
    const wafers = 2 + next() % 17
    return Array.from({ length: 9 + next() % 42 }, () => ({
      lot_id: [`case-${index}-2`, `case-${index}-10`, "Z", "a", "__proto__", "constructor"][next() % 6]!,
      wafer_id: `W-${next() % wafers}`, defect: next() % 7 < index % 6,
    }))
  })
  return [visible, [], [...visible].reverse(), [
    { lot_id: "A", wafer_id: "X", defect: true },
    { lot_id: "A", wafer_id: "X", defect: false },
    { lot_id: "B", wafer_id: "X", defect: false },
  ], ...hidden]
}

export type MultiRepoRunner = (sources: { api: string; client: string }, inputs: readonly IngestRow[][], probeApi: string) => Promise<unknown>
const compatibilityHarness = `import { summarizeLot, eventCount } from "./repos/api/src/index.ts"
import { render } from "./repos/client/src/report.ts"
import inputs from "./inputs.json"
const output = inputs.map(rows => {
  const freeze = () => Object.freeze(rows.map(row => Object.freeze({ ...row })))
  return { api: summarizeLot(freeze()), client: render(freeze()), eventCount: eventCount(freeze()) }
})
process.stdout.write(JSON.stringify(output))
`

const clientProbeLots = [{ lotId: "probe-21", waferCount: 12, defectRate: 5 / 12 }, { lotId: "probe-43", waferCount: 1, defectRate: 0 }]
const clientProbeOutput = clientProbeLots.map(lot => ({ label: lot.lotId, rate: lot.defectRate }))
const clientProbeApi = "export const summarizeLot = () => " + JSON.stringify(clientProbeLots) + "; export const eventCount = rows => rows.length"

/** Local developer runner for trusted code only. Supply a host-isolated runner for contestant code. */
export const executeLocalMultiRepo: MultiRepoRunner = async (sources, inputs, probeApi) => {
  const directory = await mkdtemp(join(tmpdir(), "hard-benchmark-compat-"))
  try {
    await Promise.all([mkdir(join(directory, "repos/api/src"), { recursive: true }), mkdir(join(directory, "repos/client/src"), { recursive: true })])
    await Promise.all([
      writeFile(join(directory, apiPath), sources.api), writeFile(join(directory, clientPath), sources.client),
      writeFile(join(directory, "inputs.json"), json(inputs)), writeFile(join(directory, "verify.ts"), compatibilityHarness),
      writeFile(join(directory, "tsconfig.json"), json({ compilerOptions: { paths: { "@factory/api": ["./repos/api/src/index.ts"] } } })),
    ])
    const cases = await runCompatibilityHarness(directory)
    await writeFile(join(directory, apiPath), probeApi)
    await writeFile(join(directory, "inputs.json"), json([inputs[0]]))
    const probe = await runCompatibilityHarness(directory)
    return { cases, clientProbe: Array.isArray(probe) ? object(probe[0])?.client : undefined }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

async function runCompatibilityHarness(directory: string): Promise<unknown> {
  const processEnv = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}
  const child = Bun.spawn([process.execPath, "run", "verify.ts"], {
    cwd: directory, env: processEnv, stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5_000,
  })
  const decoder = new TextDecoder()
  let output = "", size = 0
  try {
    for await (const chunk of child.stdout) {
      size += chunk.byteLength
      if (size > 128 * 1024) throw new Error("compatibility output exceeded limit")
      output += decoder.decode(chunk, { stream: true })
    }
    if (await child.exited !== 0) throw new Error("compatibility execution failed")
    return JSON.parse(output + decoder.decode())
  } finally {
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}

type Chamber = "C1" | "C2"
type FactoryEvent = { lot: string; wafer: string; inspectedAt: string; defect: boolean }
type Assignment = { lot: string; chamber: Chamber; recipe: string; shift: string }
type Maintenance = { id: string; chamber: Chamber; action: string; endedAt: string }
type EvidenceSource = "inspections" | "assignments" | "maintenance"
type EvidenceRef = { path: string; revision: string }
type FactoryIncident = { asOf: string; hoursAfterClean: number; minimumPerChamber: number; minimumRateDifference: number }
const registryPath = "evidence/registry.json"
const incidentPath = "evidence/incident.json"
const catalogPath = "catalog/catalog.jsonl"
const evidenceSources = ["inspections", "assignments", "maintenance"] as const
const factoryContract = {
  reportFields: ["window", "cleanings", "sources", "joinKey", "strata", "comparison", "conclusion", "nextMeasurement"],
  objectPolicy: "The report must contain exactly reportFields. Nested objects must contain exactly the keys in their declared shapes. No additional properties; contract metadata itself is not an output field. Maximum report size: 65536 UTF-8 bytes. Put extra explanation in the final response.",
  window: "{ start, endExclusive } as UTC ISO strings. Start at the later of the last cleaning end for C1 and C2 at or before asOf.",
  cleanings: "{ C1: cleaning record ID, C2: cleaning record ID }",
  sources: "{ inspections, assignments, maintenance }, each { path, revision } from the current registry and catalog",
  joinKey: ["lot", "wafer"],
  strata: "[{ recipe, shift, C1: { failed, total }, C2: { failed, total } }], one row per observed recipe/shift, including one-sided strata",
  comparison: "{ sharedStrata, eligibleStrata, elevatedStrata } as counts. Shared means both chambers observed. Eligible means both meet the sample floor. Elevated means eligible with C1 minus C2 defect rate at least the specified difference.",
  conclusion: "{ kind, causalIdentified: false }. Confounded if there are no shared strata. Insufficient if there are shared strata but none eligible. Chamber-effect if all eligible strata are elevated. Otherwise no-consistent-elevation.",
  nextMeasurement: "For insufficient, select any shared stratum and give { recipe, shift, targetPerChamber, additional: { C1, C2 } }, using the minimum sample floor and exact extra wafers needed. Otherwise null.",
}

export function createFactoryEvidenceFixture(truth: FactoryTruth = "true-effect", seed = 0): CreatedHardFixture {
  const recipeA = `R-${17 + seed % 21}`, recipeB = `R-${42 + seed % 21}`
  type Cell = [chamber: Chamber, recipe: string, shift: string, failed: number, total: number]
  const worlds: Record<FactoryTruth, Cell[]> = {
    "true-effect": [["C1", recipeA, "day", 9, 12], ["C2", recipeA, "day", 2, 12], ["C1", recipeB, "night", 7, 10], ["C2", recipeB, "night", 1, 10]],
    confounded: [["C1", recipeA, "day", 9, 12], ["C2", recipeB, "day", 2, 12], ["C1", recipeA, "night", 7, 10], ["C2", recipeB, "night", 1, 10]],
    insufficient: [["C1", recipeA, "day", 3, 4], ["C2", recipeA, "day", 1, 4], ["C1", recipeA, "night", 13, 18], ["C2", recipeB, "night", 2, 18]],
  }
  const cleaningTime = Date.parse("2026-05-01T11:00:00Z")
  const events: FactoryEvent[] = [], assignments: Assignment[] = []
  for (const [index, [chamber, recipe, shift, failed, total]] of worlds[truth].entries()) {
    const lot = `LOT-${129 + seed * 7 + index * 3}`
    assignments.push({ lot, chamber, recipe, shift })
    for (let i = 0; i < total + (index >= 2 ? seed % 3 : 0); i++) {
      const inspectedAt = new Date(cleaningTime + i * 9 * 60_000).toISOString()
      const row = { lot, wafer: `W-${i + 1}`, inspectedAt, defect: i < failed }
      events.unshift(row)
      if (i % 4 === 0) events.push({ ...row, defect: false })
    }
    events.push(
      { lot, wafer: "too-early", inspectedAt: "2026-05-01T06:59:59-04:00", defect: true },
      { lot, wafer: "at-end", inspectedAt: "2026-05-01T18:00:00+01:00", defect: true },
    )
  }
  const incident: FactoryIncident = { asOf: "2026-05-01T11:30:00Z", hoursAfterClean: 6, minimumPerChamber: 8, minimumRateDifference: 0.2 }
  const maintenance: Maintenance[] = [
    { id: "M-62", chamber: "C1", action: "cleaning", endedAt: "2026-05-01T06:00:00-05:00" },
    { id: "M-19", chamber: "C2", action: "cleaning", endedAt: "2026-05-01T11:45:00+01:00" },
    { id: "M-58", chamber: "C1", action: "calibration", endedAt: "2026-05-01T11:20:00Z" },
    { id: "M-44", chamber: "C2", action: "cleaning", endedAt: "2026-04-30T15:00:00Z" },
    { id: "M-82", chamber: "C2", action: "cleaning", endedAt: "2026-05-01T12:00:00Z" },
  ]
  const files: Record<string, string> = {
    "README.md": "Use registry revisions to find and follow catalog links. Metadata and stale artifacts are distractors. Join inspections to lot assignments by lot, include only observations within the computed half-open UTC window, and collapse duplicates by (lot, wafer). Any in-window defect makes the wafer defective.",
    [incidentPath]: json(incident),
    "evidence/report-contract.json": json(factoryContract),
  }
  const revisions = { inspections: "evidence-r12", assignments: "recipe-r8", maintenance: "maint-r4" }
  files[registryPath] = json(revisions)
  const catalog = Array.from({ length: 11_000 }, (_, index) => ({
    id: `CAT-${index}`, kind: index % 23 === 0 ? "maintenance-note" : "recipe-metadata", enriched: index % 19 === 0,
  })).map(entry => JSON.stringify(entry))
  for (const [index, [source, rows]] of Object.entries({ inspections: events, assignments, maintenance }).entries()) {
    const revision = revisions[source as EvidenceSource], staleRevision = `${source}-archived`
    for (const [offset, version] of [revision, staleRevision].entries()) {
      const path = `evidence/archive/${hash(`${source}/${version}/${seed}`).slice(0, 10)}.json`
      const archivalRows = source === "inspections" ? events.filter(row => row.defect).slice(0, 9)
        : source === "assignments" ? assignments.map(row => ({ ...row, recipe: "legacy" })) : maintenance.slice(2)
      files[path] = json({ revision: version, rows: offset === 0 ? rows : archivalRows })
      const slot = (2347 + index * 1987 + offset * 397 + (seed >>> 0) % 397) % catalog.length
      catalog[slot] = JSON.stringify({ id: `CAT-${slot}`, source, revision: version, path, enriched: true })
    }
  }
  files[catalogPath] = catalog.join("\n") + "\n"
  return created(`factory-evidence-${hash(`${seed}/${truth}`).slice(0, 12)}-v1`,
    "Investigate whether the post-cleaning observations distinguish chamber elevation from recipe/shift confounding or inadequate coverage. Submit report.json using evidence/report-contract.json.",
    ["Resolve current raw evidence by revision and convert maintenance and inspection timestamps to UTC.",
      "Report deduplicated, joined evidence for every observed stratum and apply the declared coverage and effect rule.",
      "Report a discriminating collection plan for insufficient coverage. Treat the comparison as observational."],
    files, { kind: "factory-evidence" })
}

export function createHardBenchmarkFixtures(): readonly CreatedHardFixture[] {
  return [createAcceptedQueryLostAckFixture(), createMultiRepoCompatibilityFixture(),
    createFactoryEvidenceFixture("true-effect"), createFactoryEvidenceFixture("confounded"),
    createFactoryEvidenceFixture("insufficient"), createPartialInvestigationRestartFixture()]
}

function factoryOracle(files: Files) {
  const registry: Record<EvidenceSource, string> = JSON.parse(files[registryPath]!)
  const incident: FactoryIncident = JSON.parse(files[incidentPath]!)
  const entries = files[catalogPath]!.trimEnd().split("\n").map(line => JSON.parse(line) as EvidenceRef & { source?: string })
  const sources = Object.fromEntries(evidenceSources.map(source => {
    const matches = entries.filter(entry => entry.source === source && entry.revision === registry[source] && entry.path)
    if (matches.length !== 1) throw new Error(`ambiguous current evidence: ${source}`)
    const { path, revision } = matches[0]!
    return [source, { path, revision }]
  })) as Record<EvidenceSource, EvidenceRef>
  function load<T>(source: EvidenceSource): T[] {
    const { path, revision } = sources[source]
    const artifact = JSON.parse(files[path]!)
    if (artifact.revision !== revision || !Array.isArray(artifact.rows)) throw new Error(`invalid evidence artifact: ${source}`)
    return artifact.rows
  }
  const maintenance = load<Maintenance>("maintenance").filter(row => row.action === "cleaning" && Date.parse(row.endedAt) <= Date.parse(incident.asOf))
    .sort((left, right) => Date.parse(right.endedAt) - Date.parse(left.endedAt))
  const c1 = maintenance.find(row => row.chamber === "C1")!, c2 = maintenance.find(row => row.chamber === "C2")!
  const start = Math.max(Date.parse(c1.endedAt), Date.parse(c2.endedAt)), end = start + incident.hoursAfterClean * 3_600_000
  const events = load<FactoryEvent>("inspections").filter(row => Date.parse(row.inspectedAt) >= start && Date.parse(row.inspectedAt) < end)
  const assignments = load<Assignment>("assignments")
  const strata = new Map<string, { recipe: string; shift: string; C1: { failed: number; total: number }; C2: { failed: number; total: number } }>()
  if (new Set(assignments.map(row => row.lot)).size !== assignments.length || events.some(event => !assignments.some(row => row.lot === event.lot))) {
    throw new Error("invalid lot assignment coverage")
  }
  for (const { lot, chamber, recipe, shift } of assignments) {
    const lotEvents = events.filter(event => event.lot === lot)
    if (!lotEvents.length) continue
    const key = JSON.stringify([recipe, shift])
    const stratum = strata.get(key) ?? { recipe, shift, C1: { failed: 0, total: 0 }, C2: { failed: 0, total: 0 } }
    stratum[chamber].total += new Set(lotEvents.map(row => row.wafer)).size
    stratum[chamber].failed += new Set(lotEvents.filter(row => row.defect).map(row => row.wafer)).size
    strata.set(key, stratum)
  }
  const cells = [...strata.values()]
  const shared = cells.filter(cell => cell.C1.total > 0 && cell.C2.total > 0)
  const floor = incident.minimumPerChamber
  const eligible = shared.filter(cell => cell.C1.total >= floor && cell.C2.total >= floor)
  const elevated = eligible.filter(({ C1, C2 }) => C1.failed / C1.total - C2.failed / C2.total >= incident.minimumRateDifference)
  const kind = shared.length === 0 ? "confounded" : eligible.length === 0 ? "insufficient"
    : elevated.length === eligible.length ? "chamber-effect" : "no-consistent-elevation"
  const measurements = kind === "insufficient" ? shared.map(({ recipe, shift, C1, C2 }) => ({
    recipe, shift, targetPerChamber: floor, additional: { C1: Math.max(0, floor - C1.total), C2: Math.max(0, floor - C2.total) },
  })) : [null]
  return {
    window: { start: new Date(start).toISOString(), endExclusive: new Date(end).toISOString() },
    cleanings: { C1: c1.id, C2: c2.id }, sources, joinKey: ["lot", "wafer"], strata: cells,
    comparison: { sharedStrata: shared.length, eligibleStrata: eligible.length, elevatedStrata: elevated.length },
    conclusion: { kind, causalIdentified: false }, measurements,
  }
}


type ScoreContext = { service?: HardBenchmarkService; multiRepoRunner?: MultiRepoRunner; compatibilitySeed?: number }
const same = isDeepStrictEqual
const own = (files: Files, path: string) => Object.hasOwn(files, path) ? files[path] : undefined
const maxOutputFileBytes = 64 * 1024

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function readReport(files: Files, path: string): Record<string, unknown> | undefined {
  const body = own(files, path)
  if (typeof body !== "string" || Buffer.byteLength(body) > maxOutputFileBytes) return undefined
  try { return object(JSON.parse(body)) } catch { return undefined }
}

/** The public contract requires UTC, without fixing fractional-second precision. */
function canonicalUtcTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(?:Z|\+00:00)$/.exec(value)
  if (!match || match[0] !== value) return undefined
  const seconds = match[1]!, parsed = new Date(`${seconds}Z`)
  // Date parsing can roll April 31 into May 1 or 24:00 into the next day.
  // Require exact calendar/time round-trip before comparing representations.
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== seconds) return undefined
  const fraction = (match[2] ?? "").replace(/0+$/, "")
  // Preserve sub-millisecond differences rather than rounding them away.
  return `${seconds}${fraction ? `.${fraction}` : ""}Z`
}

function canonicalUtcWindow(value: unknown): Record<string, string> | undefined {
  const window = object(value)
  if (!window || !same(Object.keys(window).sort(), ["endExclusive", "start"])) return undefined
  const start = canonicalUtcTimestamp(window.start), endExclusive = canonicalUtcTimestamp(window.endExclusive)
  return start && endExclusive ? { start, endExclusive } : undefined
}

function particleOracle(source: SourceSnapshot, window: string) {
  const rows = source.rows.filter(row => row.window === window)
  const affected = rows.filter(row => row.affected === true)
  const distinct = (events: typeof rows) => new Set(events.map(row => JSON.stringify([row.lot, row.observation]))).size
  const numerator = distinct(affected), denominator = distinct(rows)
  return { numerator, denominator, rate: numerator / denominator, affectedLots: [...new Set(affected.map(row => String(row.lot)))].sort() }
}

function jobReference(job: { jobId: string; sourceRevision: string; resultDigest: string }) {
  const { jobId, sourceRevision, resultDigest } = job
  return { jobId, sourceRevision, resultDigest }
}

function unorderedStrata(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return [...value].sort((left: unknown, right: unknown) => {
    const key = (item: unknown) => {
      const cell = object(item)
      return cell && typeof cell.recipe === "string" && typeof cell.shift === "string" ? JSON.stringify([cell.recipe, cell.shift]) : ""
    }
    const a = key(left), b = key(right)
    return a < b ? -1 : Number(a > b)
  })
}

/** The host supplies the complete file snapshot and its own service/runner. */
export async function scoreHardFixture(fixture: CreatedHardFixture, submission: FixtureSubmission, context: ScoreContext = {}): Promise<FixtureScore> {
  const { contestant, grader } = fixture, { scenario } = grader, checks: FixtureCheck[] = []
  if (grader.fixtureId !== contestant.id || grader.family !== contestant.family || scenario.kind !== grader.family) {
    throw new Error("fixture/grader identity mismatch")
  }
  function check(id: string, passed: boolean, detail?: string): void {
    checks.push({ id, passed, ...(passed || !detail ? {} : { detail }) })
  }
  function fields(actual: Record<string, unknown> | undefined, expected: Record<string, unknown>, category: string): void {
    check(`${category}:schema`, !!actual && same(Object.keys(actual).sort(), Object.keys(expected).sort()))
    for (const [key, value] of Object.entries(expected)) check(`${category}:${key}`, same(actual?.[key], value))
  }
  const paths = [...new Set([...Object.keys(contestant.files), ...Object.keys(submission.files)])]
  const changedPaths = paths.filter(path => own(contestant.files, path) !== own(submission.files, path))
  const outsideScope = changedPaths.filter(path => !grader.allowedWritePaths.includes(path))
  for (const [path, expected] of Object.entries(grader.protectedHashes)) {
    const body = own(submission.files, path)
    check(`protected:${path}`, typeof body === "string" && hash(body) === expected)
  }
  check("scope:allowed-write-paths", outsideScope.length === 0)
  const cleanScope = checks.every(result => result.passed)
  const answer = readReport(submission.files, report)

  if (scenario.kind === "accepted-query-lost-ack") {
    const evidence = await context.service?.evidence()
    const entry = evidence?.jobs[0], result = particleOracle(scenario.source, scenario.window)
    check("service:one-accepted-job", evidence?.ledger.acceptedComputations === 1 &&
      evidence.ledger.acceptedWorkUnits === scenario.source.rows.length)
    check("service:recovered-by-lookup", entry?.lostAcknowledgement === true && entry.recoveredByLookup && entry.statusChecked)
    check("service:query-scope", !!entry && entry.idempotencyKey === scenario.key && entry.job.sourceId === scenario.source.sourceId &&
      entry.job.sourceRevision === scenario.source.revision && same(entry.scope.filter, { window: scenario.window }) &&
      (entry.scope.select === null || ["lot", "observation", "affected"].every(key => entry.scope.select?.includes(key))))
    check("service:source-current", evidence?.sources.some(source => source.sourceId === scenario.source.sourceId && source.revision === scenario.source.revision && source.available) === true)
    check("service:read-complete", !!entry && entry.job.rowCount === scenario.source.rows.filter(row => row.window === scenario.window).length &&
      entry.currentRowsRead === entry.job.rowCount)
    fields(answer, { ...result, ...jobReference(entry?.job ?? { jobId: "", sourceRevision: "", resultDigest: "" }) }, "report")
  } else if (scenario.kind === "partial-investigation-restart") {
    const evidence = await context.service?.evidence()
    const [particle, maintenance, stale] = scenario.sources
    const result = particleOracle(particle, "review-shift")
    const overlapLots = result.affectedLots.filter(lot => maintenance.rows.some(row => row.lot === lot && row.overlaps === true))
    check("service:preserved-work", evidence?.ledger.acceptedComputations === scenario.sources.length &&
      evidence.ledger.acceptedWorkUnits === scenario.sources.reduce((sum, source) => sum + source.rows.length, 0) && evidence.ledger.sourceChanges === 1)
    const retained = Object.fromEntries([particle, maintenance].map(source => {
      const entry = evidence?.jobs.find(item => item.idempotencyKey === source.sourceId)
      check(`service:retained:${source.sourceId}`, !!entry && entry.job.sourceId === source.sourceId && entry.job.sourceRevision === source.revision &&
        same(entry.scope, { filter: {}, select: null }) && entry.job.rowCount === source.rows.length &&
        entry.lookedUp && entry.statusChecked && entry.currentRowsRead === entry.job.rowCount &&
        evidence?.sources.some(item => item.sourceId === source.sourceId && item.revision === source.revision && item.available) === true)
      return [source.sourceId, entry ? jobReference(entry.job) : null]
    }))
    const old = evidence?.jobs.find(item => item.idempotencyKey === stale.sourceId)
    check("service:rejected-stale-result", !!old && old.job.sourceId === stale.sourceId && old.job.sourceRevision === stale.revision &&
      old.lookedUp && old.rowsRead === 0)
    const { sourceId, revision } = scenario.unavailable
    check("service:checked-current-unavailability", evidence?.unavailableChecks.some(item => item.sourceId === sourceId && item.revision === revision) === true &&
      evidence.sources.some(item => item.sourceId === sourceId && item.revision === revision && !item.available))
    fields(answer, { retained, particle: result, overlapLots, unresolved: { sourceId, revision, available: false }, causalIdentified: false }, "report")
  } else if (scenario.kind === "factory-evidence") {
    const { measurements, ...expected } = factoryOracle(contestant.files)
    const normalized: Record<string, unknown> | undefined = answer && { ...answer,
      ...(Object.hasOwn(answer, "window") ? { window: canonicalUtcWindow(answer.window) } : {}),
      ...(Object.hasOwn(answer, "strata") ? { strata: unorderedStrata(answer.strata) } : {}) }
    const { nextMeasurement, ...rest } = normalized ?? {}
    fields(normalized && rest, { ...expected, window: canonicalUtcWindow(expected.window), strata: unorderedStrata(expected.strata) }, "report")
    check("report:nextMeasurement", measurements.some(measurement => same(nextMeasurement, measurement)))
  } else {
    const visible: IngestRow[] = JSON.parse(contestant.files[ingestionPath]!).rows
    fields(readReport(submission.files, "validation.json"), lotOracle(visible), "validation")
    const api = own(submission.files, apiPath), client = own(submission.files, clientPath)
    const filesReady = typeof api === "string" && typeof client === "string" &&
      Buffer.byteLength(api) <= maxOutputFileBytes && Buffer.byteLength(client) <= maxOutputFileBytes
    check("code:bounded-sources", filesReady)
    const seed = context.compatibilitySeed ?? 27911
    const inputs = compatibilityInputs(visible, seed)
    let outputs: Record<string, unknown> | undefined
    if (cleanScope && filesReady && context.multiRepoRunner) {
      try { outputs = object(await context.multiRepoRunner({ api, client }, inputs, clientProbeApi)) } catch { /* Execution failures cannot pass. */ }
    }
    const cases = outputs?.cases
    const complete = Array.isArray(cases) && cases.length === inputs.length
    check("code:executed-all-cases", complete, "Requires a successful runner result for every compatibility case")
    if (complete) {
      const expected = inputs.map(lotOracle)
      check("code:api-contract", expected.every((value, index) => same(object(cases[index])?.api, value.api)))
      check("code:client-contract", expected.every((value, index) => same(object(cases[index])?.client, value.client)))
      check("code:sibling-contract", expected.every((value, index) => same(object(cases[index])?.eventCount, value.eventCount)))
    }
    check("code:client-uses-api", same(outputs?.clientProbe, clientProbeOutput))
  }
  const failedChecks = checks.filter(result => !result.passed).length
  return { passed: failedChecks === 0, checks, metrics: { checkCount: checks.length, failedChecks,
    protectedFileCount: Object.keys(grader.protectedHashes).length, changedFileCount: changedPaths.length, contestantFileCount: Object.keys(submission.files).length } }
}


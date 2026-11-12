import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createAcceptedQueryLostAckFixture, createFactoryEvidenceFixture, createHardBenchmarkFixtures,
  createMultiRepoCompatibilityFixture, createPartialInvestigationRestartFixture, executeLocalMultiRepo,
  openHardFixtureService, scoreHardFixture, type CreatedHardFixture, type FactoryTruth,
} from "../scripts/hard-benchmark-fixtures.ts"
import { HardBenchmarkService, LostAcknowledgementError, StaleSourceError, type QueryJob } from "../scripts/hard-benchmark-service.ts"

const json = (value: unknown) => JSON.stringify(value) + "\n"
const submit = (fixture: CreatedHardFixture, path: string, value: unknown) => ({ files: { ...fixture.contestant.files, [path]: json(value) } })
const failed = (score: Awaited<ReturnType<typeof scoreHardFixture>>) => score.checks.filter(check => !check.passed).map(check => check.id)
const reference = ({ jobId, sourceRevision, resultDigest }: QueryJob) => ({ jobId, sourceRevision, resultDigest })

async function withService(fixture: CreatedHardFixture, run: (service: HardBenchmarkService, directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "hard-benchmark-fixture-test-"))
  try { await run(await openHardFixtureService(fixture, directory), directory) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

async function readAll(service: HardBenchmarkService, jobId: string) {
  const rows: Readonly<Record<string, unknown>>[] = []
  let cursor: string | undefined
  do {
    const page = await service.readPage(jobId, cursor, 5)
    rows.push(...page.rows)
    cursor = page.nextCursor
  } while (cursor !== undefined)
  return rows
}

function aggregateParticles(rows: Awaited<ReturnType<typeof readAll>>) {
  const byLot = new Map<string, Map<string, boolean>>()
  for (const row of rows) {
    if (row.window !== "review-shift") continue
    const lot = String(row.lot), id = String(row.observation)
    const observations = byLot.get(lot) ?? new Map()
    observations.set(id, (observations.get(id) ?? false) || row.affected === true)
    byLot.set(lot, observations)
  }
  let numerator = 0, denominator = 0
  const affectedLots: string[] = []
  for (const [lot, observations] of byLot) {
    const count = [...observations.values()].filter(Boolean).length
    numerator += count
    denominator += observations.size
    if (count) affectedLots.push(lot)
  }
  return { numerator, denominator, rate: numerator / denominator, affectedLots: affectedLots.sort() }
}

const apiPath = "repos/api/src/index.ts", clientPath = "repos/client/src/report.ts"
const workingApi = `
export function summarizeLot(rows) {
  const byLot = new Map()
  for (const {lot_id, wafer_id, defect} of rows) {
    const wafers = byLot.get(lot_id) ?? new Map()
    wafers.set(wafer_id, defect || wafers.get(wafer_id) === true)
    byLot.set(lot_id, wafers)
  }
  return [...byLot.keys()].sort().map(lotId => {
    const wafers = byLot.get(lotId)
    return { lotId, waferCount: wafers.size, defectRate: [...wafers.values()].filter(Boolean).length / wafers.size }
  })
}
export function eventCount(rows) { return rows.length }
`
const workingClient = `
import { summarizeLot } from "@factory/api"
export const render = rows => summarizeLot(rows).map(({lotId, defectRate}) => ({rate: defectRate, label: lotId}))
`
const visible = { api: [{ lotId: "A", waferCount: 3, defectRate: 1 / 3 }, { lotId: "B", waferCount: 1, defectRate: 0 }],
  client: [{ label: "A", rate: 1 / 3 }, { label: "B", rate: 0 }], eventCount: 5 }

type Cell = [recipe: string, shift: string, c1Bad: number, c1Total: number, c2Bad: number, c2Total: number]
function factoryReport(fixture: CreatedHardFixture, kind: string, cells: Cell[], comparison: number[], nextMeasurement: unknown = null) {
  const files = fixture.contestant.files
  const registry = JSON.parse(files["evidence/registry.json"]!) as Record<string, string>
  const sources = Object.fromEntries(files["catalog/catalog.jsonl"]!.trim().split("\n").map(line => JSON.parse(line))
    .filter(item => item.source && item.revision === registry[item.source])
    .map(({ source, revision, path }) => [source, { revision, path }]))
  return {
    sources, window: { start: "2026-05-01T11:00:00.000Z", endExclusive: "2026-05-01T17:00:00.000Z" },
    cleanings: { C2: "M-19", C1: "M-62" }, joinKey: ["lot", "wafer"],
    strata: cells.map(([recipe, shift, c1Bad, c1Total, c2Bad, c2Total]) => ({
      shift, recipe, C2: { total: c2Total, failed: c2Bad }, C1: { total: c1Total, failed: c1Bad },
    })).reverse(),
    comparison: { sharedStrata: comparison[0], eligibleStrata: comparison[1], elevatedStrata: comparison[2] },
    conclusion: { causalIdentified: false, kind }, nextMeasurement,
  }
}

describe("hard benchmark grading against raw evidence and executed work", () => {
  test("public fixtures contain raw evidence and contracts with distinct private grader records", () => {
    const fixtures = createHardBenchmarkFixtures()
    expect(fixtures.map(item => item.contestant.family)).toEqual([
      "accepted-query-lost-ack", "multi-repo-compatibility", "factory-evidence", "factory-evidence", "factory-evidence", "partial-investigation-restart",
    ])
    const factory = fixtures[2]!
    expect(factory.contestant.files["catalog/catalog.jsonl"]!.trim().split("\n")).toHaveLength(11_000)
    expect(factory.contestant.id).not.toContain("true-effect")
    expect(Object.keys(factory.contestant.files).some(path => path.includes("grader"))).toBe(false)
    expect(Object.keys(fixtures[0]!.contestant.files)).toEqual(["README.md", "sources/request.json"])
    expect(JSON.parse(fixtures[5]!.contestant.files["sources/checkpoint.json"]!)).toHaveLength(3)
  })

  test.each([0, 7])("derives accepted-query results from paged rows after lost ack (seed %s)", seed => {
    const fixture = createAcceptedQueryLostAckFixture(seed)
    return withService(fixture, async (service, directory) => {
      const request = JSON.parse(fixture.contestant.files["sources/request.json"]!)
      const query = { sourceId: request.sourceId, expectedRevision: request.revision, idempotencyKey: request.idempotencyKey,
        filter: { window: request.window } }
      await expect(service.submit(query)).rejects.toBeInstanceOf(LostAcknowledgementError)
      const resumed = new HardBenchmarkService(directory)
      const fromRetry = await resumed.submit(query)
      const counts = seed === 0 ? [6, 41] : [7, 48]
      const guess = { numerator: counts[0], denominator: counts[1], rate: counts[0]! / counts[1]!,
        affectedLots: ["L1", "L2", "L3", "L4"], ...reference(fromRetry) }
      expect(failed(await scoreHardFixture(fixture, submit(fixture, "report.json", guess), { service: resumed }))).toEqual(expect.arrayContaining([
        "service:recovered-by-lookup", "service:read-complete",
      ]))
      const found = (await resumed.lookup(request.idempotencyKey))!
      await resumed.status(found.jobId)
      const result = aggregateParticles(await readAll(resumed, found.jobId))
      expect([result.numerator, result.denominator]).toEqual(counts)
      const candidate = submit(fixture, "report.json", { ...result, ...reference(found) })
      expect(failed(await scoreHardFixture(fixture, candidate, { service: resumed }))).toEqual([])
      expect((await scoreHardFixture(fixture, candidate)).passed).toBe(false)
      expect(failed(await scoreHardFixture(fixture, submit(fixture, "report.json", { ...result, ...reference(found), jobId: "forged" }), { service: resumed }))).toContain("report:jobId")
    })
  })

  test("irrelevant projection and literal out-of-scope writes cannot earn credit", () => {
    const fixture = createAcceptedQueryLostAckFixture()
    return withService(fixture, async service => {
      await expect(service.submit({ sourceId: "particle-map", idempotencyKey: "particle-review", filter: { window: "review-shift" },
        select: ["window"] })).rejects.toBeInstanceOf(LostAcknowledgementError)
      const found = (await service.lookup("particle-review"))!
      await service.status(found.jobId)
      await readAll(service, found.jobId)
      const candidate = submit(fixture, "report.json", reference(found))
      const score = await scoreHardFixture(fixture, { files: { ...candidate.files, "new-file": "<missing>" } }, { service })
      expect(failed(score)).toEqual(expect.arrayContaining(["service:query-scope", "scope:allowed-write-paths", "report:numerator"]))
    })
  })

  test("executes visible and hidden repo cases and rejects report-only submissions", async () => {
    const fixture = createMultiRepoCompatibilityFixture(), original = submit(fixture, "validation.json", visible)
    const context = { multiRepoRunner: executeLocalMultiRepo, compatibilitySeed: 42013 }
    expect(failed(await scoreHardFixture(fixture, original, context))).toContain("code:executed-all-cases")
    const fixed = { ...original.files, [apiPath]: workingApi, [clientPath]: workingClient }
    expect(failed(await scoreHardFixture(fixture, { files: fixed }, context))).toEqual([])
    expect(failed(await scoreHardFixture(fixture, { files: fixed }))).toContain("code:executed-all-cases")
    const hardcoded = { ...fixed, [apiPath]: `export const summarizeLot = () => ${JSON.stringify(visible.api)}; export const eventCount = rows => rows.length` }
    const staticGrade = await scoreHardFixture(fixture, { files: hardcoded }, context)
    expect(staticGrade.checks.find(check => check.id === "code:executed-all-cases")?.passed).toBe(true)
    expect(failed(staticGrade)).toContain("code:api-contract")
  })

  test("hidden cases reject sibling regressions, reimplemented clients and scope violations", async () => {
    const fixture = createMultiRepoCompatibilityFixture()
    const fixed = { ...submit(fixture, "validation.json", visible).files, [apiPath]: workingApi, [clientPath]: workingClient }
    const context = { multiRepoRunner: executeLocalMultiRepo }
    const brokenSibling = { ...fixed, [apiPath]: workingApi.replace("return rows.length", "return 5") }
    expect(failed(await scoreHardFixture(fixture, { files: brokenSibling }, context))).toEqual(["code:sibling-contract"])
    const independentClient = { ...fixed, [clientPath]: workingApi + workingClient.replace('import { summarizeLot } from "@factory/api"', "") }
    expect(failed(await scoreHardFixture(fixture, { files: independentClient }, context))).toEqual(["code:client-uses-api"])
    let ran = false
    const scopeViolation = { ...fixed, "repos/client/fixtures/expected.json": "{}\n" }
    const score = await scoreHardFixture(fixture, { files: scopeViolation }, { multiRepoRunner: async () => { ran = true } })
    expect(failed(score)).toEqual(expect.arrayContaining(["protected:repos/client/fixtures/expected.json", "scope:allowed-write-paths"]))
    expect(ran).toBe(false)
  })

  const worlds: [FactoryTruth, string, Cell[], number[], unknown][] = [
    ["true-effect", "chamber-effect", [["R-17", "day", 9, 12, 2, 12], ["R-42", "night", 7, 10, 1, 10]], [2, 2, 2], null],
    ["confounded", "confounded", [
      ["R-17", "day", 9, 12, 0, 0], ["R-17", "night", 7, 10, 0, 0], ["R-42", "day", 0, 0, 2, 12], ["R-42", "night", 0, 0, 1, 10],
    ], [0, 0, 0], null],
    ["insufficient", "insufficient", [["R-17", "day", 3, 4, 1, 4], ["R-17", "night", 13, 18, 0, 0], ["R-42", "night", 0, 0, 2, 18]], [1, 0, 0],
      { recipe: "R-17", shift: "day", targetPerChamber: 8, additional: { C1: 4, C2: 4 } }],
  ]
  for (const [truth, kind, cells, comparison, nextMeasurement] of worlds) {
    test(`derives ${truth} from matched evidence despite identical crude totals`, async () => {
      const fixture = createFactoryEvidenceFixture(truth)
      expect(cells.reduce((counts, cell) => counts.map((value, index) => value + Number(cell[index + 2])), [0, 0, 0, 0])).toEqual([16, 22, 3, 22])
      const answer = factoryReport(fixture, kind, cells, comparison, nextMeasurement)
      expect(failed(await scoreHardFixture(fixture, submit(fixture, "report.json", answer)))).toEqual([])
      const overclaim = { ...answer, conclusion: { kind, causalIdentified: true } }
      expect(failed(await scoreHardFixture(fixture, submit(fixture, "report.json", overclaim)))).toContain("report:conclusion")
    })
  }

  test("rejects plausible keywords, stale citations, wrong UTC edges, wrong strata and vague follow-up", async () => {
    const fixture = createFactoryEvidenceFixture("insufficient")
    const [, kind, cells, comparison, nextMeasurement] = worlds[2]!
    const good = factoryReport(fixture, kind, cells, comparison, nextMeasurement)
    const mutation = { ...good, window: { ...good.window, start: "2026-05-01T06:00:00.000Z" },
      sources: { ...good.sources, inspections: { ...good.sources.inspections, revision: "inspections-archived" } },
      strata: good.strata.map(cell => ({ ...cell, C1: { ...cell.C1, total: cell.C1.total + 1 } })),
      conclusion: { kind, rationale: "Sparse and insufficient because recipe confounds chamber." },
      nextMeasurement: "Measure at least twenty additional wafers." }
    expect(failed(await scoreHardFixture(fixture, submit(fixture, "report.json", mutation)))).toEqual(expect.arrayContaining([
      "report:sources", "report:window", "report:strata", "report:conclusion", "report:nextMeasurement",
    ]))
    const other = createFactoryEvidenceFixture("true-effect", 1)
    expect(failed(await scoreHardFixture(other, submit(other, "report.json", factoryReport(other, "chamber-effect",
      [["R-18", "day", 9, 12, 2, 12], ["R-43", "night", 7, 11, 1, 11]], [2, 2, 2]))))).toEqual([])
    expect((await scoreHardFixture(fixture, submit(fixture, "report.json", ["insufficient"]))).passed).toBe(false)
  })

  test("restart preserves only current complete jobs and requires observed unavailability", () => {
    const fixture = createPartialInvestigationRestartFixture()
    return withService(fixture, async service => {
      const checkpoint = JSON.parse(fixture.contestant.files["sources/checkpoint.json"]!)
      const [first, second, third] = await Promise.all(checkpoint.map((entry: { idempotencyKey: string }) => service.lookup(entry.idempotencyKey)))
      const [particle, maintenance, stale] = [first!, second!, third!] as [QueryJob, QueryJob, QueryJob]
      await service.status(particle.jobId)
      await service.status(maintenance.jobId)
      const summary = aggregateParticles(await readAll(service, particle.jobId))
      const overlaps = await readAll(service, maintenance.jobId)
      const unresolved = { sourceId: "recipe-check", revision: "r3", available: false }
      const answer = { retained: { "particle-window": reference(particle), "maintenance-alignment": reference(maintenance) },
        particle: summary, overlapLots: summary.affectedLots.filter(lot => overlaps.some(row => row.lot === lot && row.overlaps === true)),
        unresolved, causalIdentified: false }
      const candidate = submit(fixture, "report.json", answer)
      expect(failed(await scoreHardFixture(fixture, candidate, { service }))).toEqual(["service:checked-current-unavailability"])
      expect(await service.sourceStatus(stale.sourceId)).toEqual({ revision: "r3", available: false })
      await expect(service.readPage(stale.jobId, undefined, 5)).rejects.toBeInstanceOf(StaleSourceError)
      expect(failed(await scoreHardFixture(fixture, candidate, { service }))).toEqual([])
      await service.readPage(stale.jobId, undefined, 5, "snapshot")
      expect(failed(await scoreHardFixture(fixture, candidate, { service }))).toEqual(["service:rejected-stale-result"])
    })
  })
})


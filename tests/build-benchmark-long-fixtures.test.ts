import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createLongSessionCases, gradeLongCheckpoint, longCheckpointPrompt,
  type LongOperation,
} from "../scripts/build-benchmark-long-fixtures.ts"
import { longReferenceCheckpoint } from "../scripts/build-benchmark-long-reference.ts"
import { openHardFixtureService, type CreatedHardFixture } from "../scripts/hard-benchmark-fixtures.ts"
import type { HardBenchmarkServiceClient } from "../scripts/hard-benchmark-qualification.ts"
import type { HardBenchmarkService } from "../scripts/hard-benchmark-service.ts"

const encode = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`

async function withService(fixture: CreatedHardFixture, body: (service: HardBenchmarkService) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "long-fixture-test-"))
  try { await body(await openHardFixtureService(fixture, directory)) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

function auditedClient(service: HardBenchmarkService) {
  const operations: LongOperation[] = []
  let sequence = 0
  const call = <A extends unknown[], R>(path: string, args: (values: A) => Record<string, unknown>, method: (...values: A) => Promise<R>) =>
    async (...values: A): Promise<R> => {
      try {
        const value = await method(...values)
        operations.push({ sequence: ++sequence, path, args: args(values), status: 200, response: { ok: true, value } })
        return value
      } catch (error) {
        const e = error as { code?: string; name?: string; message?: string }
        operations.push({ sequence: ++sequence, path, args: args(values), status: 409,
          response: { ok: false, error: { code: e.code, name: e.name, message: e.message } } })
        throw error
      }
    }
  const client: HardBenchmarkServiceClient = {
    submit: call("/submit", ([query]) => query as unknown as Record<string, unknown>, service.submit.bind(service)),
    lookup: call("/lookup", ([idempotencyKey]) => ({ idempotencyKey }), service.lookup.bind(service)),
    status: call("/status", ([jobId]) => ({ jobId }), service.status.bind(service)),
    manifest: call("/manifest", ([jobId]) => ({ jobId }), service.manifest.bind(service)),
    readPage: call("/readPage", ([jobId, cursor, limit, consistency]) => ({ jobId, cursor, limit, consistency }), service.readPage.bind(service)),
    sourceStatus: call("/sourceStatus", ([sourceId]) => ({ sourceId }), service.sourceStatus.bind(service)),
    currentRevision: call("/currentRevision", ([sourceId]) => ({ sourceId }), service.currentRevision.bind(service)),
    ledger: call("/ledger", () => ({}), service.ledger.bind(service)),
  }
  return { client, operations, lastSequence: () => sequence }
}

describe("disjoint long-session L2 fixtures and checkpoint grader", () => {
  test("creates eight matched cases with shared incident evidence and disjoint outputs", () => {
    const cases = createLongSessionCases()
    expect(cases).toHaveLength(8)
    expect(cases.filter(item => item.incident === "accepted-lost-ack")).toHaveLength(4)
    expect(cases.filter(item => item.incident === "partial-restart")).toHaveLength(4)
    for (const incident of ["accepted-lost-ack", "partial-restart"]) {
      const group = cases.filter(item => item.incident === incident)
      for (const item of group.slice(1)) expect(item.fixture.contestant.files).toEqual(group[0]!.fixture.contestant.files)
    }
    for (const item of cases) {
      expect(item.fixture.contestant.files["mission.json"]).toContain("factory.json")
      expect(item.fixture.contestant.files["skills/current-analysis.md"]).toContain("v2")
      expect(item.fixture.contestant.files["skills/revoked-procedure-v1.md"]).toContain("REVOKED")
      expect(item.fixture.contestant.files["evidence/report-contract.json"]).toBeDefined()
      expect(item.fixture.contestant.files["sources/request.json"] ?? item.fixture.contestant.files["sources/checkpoint.json"]).toBeDefined()
      expect(item.fixture.grader.allowedWritePaths).toEqual(["report.json", "factory.json", "checkpoint.json", "notes.md"])
    }
  })

  test("keeps one original task in q0 and phase-only follow-up prompts", () => {
    const c = createLongSessionCases()[0]!
    const q0 = longCheckpointPrompt(c, "q0", "nonce-q0")
    const qh = longCheckpointPrompt(c, "qh", "nonce-qh")
    expect(q0).toContain("report.json")
    expect(q0).toContain("factory.json")
    expect(q0).toContain("nonce-q0")
    expect(qh).toContain("Phase: qh. Nonce: nonce-qh.")
    expect(qh).not.toContain("procedureVersion")
    expect(qh).not.toContain("currentRevision")
    expect(qh).not.toContain("Numerator")
    expect(() => longCheckpointPrompt(c, "qc", " ")).toThrow()
  })

  test("accepts independently scored reference outputs and actual fresh q0 service operations", async () => {
    const c = createLongSessionCases()[0]!
    await withService(c.base, async service => {
      const audit = auditedClient(service)
      const files = await longReferenceCheckpoint(c, audit.client, "q0", "unique-q0")
      const result = await gradeLongCheckpoint(c, files, { service, operations: audit.operations, auditComplete: true,
        fromSequence: 0, phase: "q0", nonce: "unique-q0" })
      expect(result.checks.filter(item => !item.passed).map(item => item.id)).toEqual([])
      expect(result.checks.filter(item => !item.passed).map(item => item.id)).toEqual([])
      expect(result.checks.every(item => /^[a-f0-9]{64}$/.test(item.expectedDigest))).toBe(true)
      expect(result.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)

      const jobId = (await service.evidence()).jobs[0]!.job.jobId
      let cursor: string | undefined
      do { cursor = (await audit.client.readPage(jobId, cursor, 7, "current")).nextCursor } while (cursor !== undefined)
      await audit.client.readPage(jobId, `${jobId}:7`, 7, "current") // harmless partial reread
      const reread = await gradeLongCheckpoint(c, files, { service, operations: audit.operations, auditComplete: true,
        fromSequence: 0, phase: "q0", nonce: "unique-q0" })
      expect(reread.passed).toBe(true)

      const previous = audit.lastSequence()
      const nextFiles = await longReferenceCheckpoint(c, audit.client, "qh", "unique-qh", files)
      const continuation = await gradeLongCheckpoint(c, nextFiles, { service, operations: audit.operations, auditComplete: true,
        fromSequence: previous, phase: "qh", nonce: "unique-qh" })
      expect(continuation.passed).toBe(true)
      let continuingFiles = nextFiles
      let fromSequence = audit.lastSequence()
      for (const phase of ["qc", "qr"] as const) {
        const nonce = `unique-${phase}`
        continuingFiles = await longReferenceCheckpoint(c, audit.client, phase, nonce, continuingFiles)
        const graded = await gradeLongCheckpoint(c, continuingFiles, { service, operations: audit.operations, auditComplete: true,
          fromSequence, phase, nonce })
        expect(graded.passed).toBe(true)
        fromSequence = audit.lastSequence()
      }
    })
  })

  test("independently grades the partial-restart incident without resubmitting seeded work", async () => {
    const c = createLongSessionCases().find(item => item.incident === "partial-restart")!
    await withService(c.base, async service => {
      const audit = auditedClient(service)
      const files = await longReferenceCheckpoint(c, audit.client, "q0", "partial-q0")
      const result = await gradeLongCheckpoint(c, files, { service, operations: audit.operations, auditComplete: true,
        fromSequence: 0, phase: "q0", nonce: "partial-q0" })
      expect(result.passed).toBe(true)
      expect(audit.operations.filter(item => item.path === "/submit")).toHaveLength(0)
    })
  })

  test("an observed unused service cannot count empty job sets as retained lookups or reads", async () => {
    const c = createLongSessionCases().find(item => item.incident === "accepted-lost-ack")!
    await withService(c.base, async service => {
      expect((await service.evidence()).jobs).toHaveLength(0)
      const result = await gradeLongCheckpoint(c, c.fixture.contestant.files, {
        service, operations: [], auditComplete: true, fromSequence: 0, phase: "q0", nonce: "unused",
      })
      expect(result.checks.find(item => item.id === "trace:complete-current-window")?.passed).toBe(true)
      for (const id of ["pending:lookup-each-accepted-intent", "pending:fresh-current-result-read", "pending:initial-intent-established"]) {
        expect(result.checks.find(item => item.id === id)?.known).toBe(true)
        expect(result.checks.find(item => item.id === id)?.passed).toBe(false)
      }
      expect(result.passed).toBe(false)
    })
  })

  test("the partial-restart contract discloses numeric rates and rejects fraction strings", async () => {
    const c = createLongSessionCases().find(item => item.incident === "partial-restart")!
    expect(c.fixture.contestant.files["sources/report-contract.json"]).toContain("JSON number")
    expect(c.fixture.contestant.files["sources/report-contract.json"]).toContain("not a string or fraction notation")
    await withService(c.base, async service => {
      const audit = auditedClient(service)
      const files = await longReferenceCheckpoint(c, audit.client, "q0", "numeric-rate")
      const context = { service, operations: audit.operations, auditComplete: true, fromSequence: 0, phase: "q0" as const, nonce: "numeric-rate" }
      expect((await gradeLongCheckpoint(c, files, context)).passed).toBe(true)
      const report = JSON.parse(files["report.json"]!)
      expect(typeof report.particle.rate).toBe("number")
      report.particle.rate = `${report.particle.numerator}/${report.particle.denominator}`
      const result = await gradeLongCheckpoint(c, { ...files, "report.json": encode(report) }, context)
      expect(result.checks.find(item => item.id === "task:base-independent-scorer")?.known).toBe(true)
      expect(result.checks.find(item => item.id === "task:base-independent-scorer")?.passed).toBe(false)
      expect(result.passed).toBe(false)
    })
  })

  test("fails closed for replayed phase nonce, incomplete trace, tampering, malformed outputs and duplicate submits", async () => {
    const c = createLongSessionCases()[0]!
    await withService(c.base, async service => {
      const audit = auditedClient(service)
      const files = await longReferenceCheckpoint(c, audit.client, "q0", "nonce-one")
      const context = { service, operations: audit.operations, auditComplete: true, fromSequence: 0, phase: "q0" as const, nonce: "nonce-one" }
      const staleNonce = { ...files, "checkpoint.json": encode({ phase: "q0", nonce: "replayed", procedureVersion: "2", report: "report.json", factory: "factory.json" }) }
      const stale = await gradeLongCheckpoint(c, staleNonce, context)
      expect(stale.checks.find(item => item.id === "checkpoint:exact-current-phase-nonce")?.passed).toBe(false)

      const publicContract = JSON.parse(files["mission.json"]!).checkpointContract
      const checkpoint = JSON.parse(files["checkpoint.json"]!)
      expect(Object.keys(checkpoint).sort()).toEqual(publicContract.required.slice().sort())
      expect(publicContract.additionalProperties).toBe(false)
      const extended = await gradeLongCheckpoint(c, { ...files, "checkpoint.json": encode({ ...checkpoint, acceptedJobs: [] }) }, context)
      expect(extended.checks.find(item => item.id === "checkpoint:exact-current-phase-nonce")?.known).toBe(true)
      expect(extended.checks.find(item => item.id === "checkpoint:exact-current-phase-nonce")?.passed).toBe(false)
      expect(extended.checks.find(item => item.id === "task:base-independent-scorer")?.known).toBe(false)

      const incomplete = await gradeLongCheckpoint(c, files, { ...context, auditComplete: false })
      expect(incomplete.checks.find(item => item.id === "trace:complete-current-window")?.passed).toBe(false)
      expect(incomplete.checks.find(item => item.id === "trace:complete-current-window")?.known).toBe(false)
      expect(incomplete.checks.find(item => item.id === "behavior:current-factory-source-selection")?.exposed).toBe(false)
      expect(stale.checks.find(item => item.id === "task:base-independent-scorer")?.known).toBe(false)
      const empty = await gradeLongCheckpoint(c, files, { ...context, operations: [], fromSequence: audit.lastSequence() })
      expect(empty.checks.find(item => item.id === "trace:complete-current-window")?.known).toBe(false)
      // Unlike a missing prefix, a complete trace ending at the frozen boundary
      // proves that required follow-up calls were omitted.
      const omitted = await gradeLongCheckpoint(c, files, { ...context, fromSequence: audit.lastSequence() })
      expect(omitted.checks.find(item => item.id === "trace:complete-current-window")?.passed).toBe(true)
      for (const id of ["source:fresh-revision-and-availability-checks", "pending:lookup-each-accepted-intent", "pending:fresh-current-result-read"]) {
        expect(omitted.checks.find(item => item.id === id)?.known).toBe(true)
        expect(omitted.checks.find(item => item.id === id)?.passed).toBe(false)
      }
      expect(omitted.passed).toBe(false)
      const neverCalled = await gradeLongCheckpoint(c, files, { ...context, operations: [], fromSequence: 0 })
      expect(neverCalled.checks.find(item => item.id === "trace:complete-current-window")?.passed).toBe(true)
      expect(neverCalled.checks.find(item => item.id === "source:fresh-revision-and-availability-checks")?.known).toBe(true)
      expect(neverCalled.checks.find(item => item.id === "source:fresh-revision-and-availability-checks")?.passed).toBe(false)
      const unobserved = await gradeLongCheckpoint(c, files, { ...context, operations: [], fromSequence: 0, auditComplete: false })
      expect(unobserved.checks.find(item => item.id === "trace:complete-current-window")?.known).toBe(false)
      const gap = await gradeLongCheckpoint(c, files, { ...context, operations: audit.operations.slice(1) })
      expect(gap.checks.find(item => item.id === "trace:complete-current-window")?.known).toBe(false)

      const tampered = { ...files, "evidence/incident.json": "{}\n" }
      expect((await gradeLongCheckpoint(c, tampered, context)).checks.find(item => item.id === "outputs:disclosed-paths-and-bounds")?.passed).toBe(false)
      expect((await gradeLongCheckpoint(c, { ...files, "factory.json": "{}\n" }, context)).passed).toBe(false)
      expect((await gradeLongCheckpoint(c, { ...files, "report.json": "{}\n" }, context)).passed).toBe(false)
      const roundedReport = JSON.parse(files["report.json"]!)
      roundedReport.rate = Number(roundedReport.rate.toFixed(2))
      expect((await gradeLongCheckpoint(c, { ...files, "report.json": encode(roundedReport) }, context)).passed).toBe(false)
      const wrongReport = JSON.parse(files["report.json"]!)
      wrongReport.numerator += 1
      expect((await gradeLongCheckpoint(c, { ...files, "report.json": encode(wrongReport) }, context)).passed).toBe(false)
      expect((await gradeLongCheckpoint(c, { ...files, "extra.txt": "unlisted" }, context)).passed).toBe(false)
      const missing = { ...files }; delete missing["notes.md"]
      expect((await gradeLongCheckpoint(c, missing, context)).passed).toBe(false)

      const duplicate: LongOperation = { sequence: audit.lastSequence() + 1, path: "/submit",
        args: { idempotencyKey: "particle-review", sourceId: "particle-map", expectedRevision: "r7" }, status: 200,
        response: { ok: true, value: null } }
      const duplicateResult = await gradeLongCheckpoint(c, files, { ...context, operations: [...audit.operations, duplicate] })
      expect(duplicateResult.checks.find(item => item.id === "negative:no-duplicate-submission-attempt")?.passed).toBe(false)
      expect(duplicateResult.checks.find(item => item.id === "negative:no-duplicate-accepted-computation")?.passed).toBe(true)
    })
  })
})

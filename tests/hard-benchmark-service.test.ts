import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { Database } from "bun:sqlite"
import {
  HardBenchmarkService, LostAcknowledgementError, SourceUnavailableError, StaleSourceError, type RawQuery, type SourceSnapshot,
} from "../scripts/hard-benchmark-service.ts"

const rows = [
  { wafer: "W1", defect: true, lot: "A" }, { wafer: "W2", defect: false, lot: "A" }, { wafer: "W3", defect: true, lot: "B" },
]
const source = (revision: string, sourceRows: SourceSnapshot["rows"] = rows): SourceSnapshot => ({
  sourceId: "wafer-events", revision, rows: sourceRows,
})
const query = (key: string, expectedRevision = "r1"): RawQuery => ({
  idempotencyKey: key, sourceId: "wafer-events", expectedRevision, filter: { defect: true }, select: ["wafer", "lot"],
})

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "hard-benchmark-service-test-"))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

describe("durable benchmark query service", () => {
  test("commits acceptance and lost-ack receipt before returning the fault, across a process restart", () => withDirectory(async directory => {
    const moduleUrl = pathToFileURL(join(import.meta.dir, "../scripts/hard-benchmark-service.ts")).href
    const script = `import { HardBenchmarkService, LostAcknowledgementError } from ${JSON.stringify(moduleUrl)};
      const service = new HardBenchmarkService(${JSON.stringify(directory)}, ${JSON.stringify({
        sources: [source("r1")], faults: { loseAcknowledgement: { idempotencyKey: "caller-job-17" } },
      })});
      try { await service.submit(${JSON.stringify(query("caller-job-17"))}); }
      catch (error) { process.exit(error instanceof LostAcknowledgementError && !("acceptedJobId" in error) ? 17 : 2); }`
    const child = Bun.spawn([process.execPath, "-e", script], { stderr: "inherit", timeout: 5_000 })
    expect(await child.exited).toBe(17)
    const restarted = new HardBenchmarkService(directory)
    const recovered = (await restarted.lookup("caller-job-17"))!
    expect(recovered.jobId).toBeTruthy()
    expect(await restarted.status(recovered.jobId)).toMatchObject({ sourceRevision: "r1", rowCount: 2, workUnits: 3 })
    expect(await restarted.ledger()).toEqual({ acceptedComputations: 1, acceptedWorkUnits: 3, jobs: 1, lostAcknowledgements: 1, sourceChanges: 0 })
    expect((await restarted.submit(query("caller-job-17"))).jobId).toBe(recovered.jobId)
    expect((await restarted.evidence()).jobs[0]).toMatchObject({ recoveredByLookup: true, statusChecked: true, currentRowsRead: 0 })
  }))

  test("normalizes query identity, rejects collisions and never trusts caller-declared cost", () => withDirectory(async directory => {
    const service = new HardBenchmarkService(directory, { sources: [source("r1")], maxAcceptedWorkUnits: 3 })
    const first = { ...query("__proto__"), filter: { lot: "A", defect: true }, workUnits: 0 }
    const job = await service.submit(first)
    const retry = { ...query("__proto__"), filter: { defect: true, lot: "A" }, select: ["lot", "lot", "wafer"], expectedRevision: undefined }
    expect(await service.submit(retry)).toEqual(job)
    await expect(service.submit({ ...retry, filter: { lot: "B", defect: true } })).rejects.toThrow("idempotency key reused")
    await expect(service.submit({ ...retry, expectedRevision: "r2" })).rejects.toThrow("idempotency key reused")
    await expect(service.submit({ ...retry, select: ["lot"] })).rejects.toThrow("idempotency key reused")
    const restarted = new HardBenchmarkService(directory, { maxAcceptedWorkUnits: 9000 })
    await expect(restarted.submit(query("different"))).rejects.toThrow("work budget exceeded")
    expect((await restarted.ledger()).acceptedWorkUnits).toBe(3)
    expect(await service.lookup("constructor")).toBeUndefined()
    expect(await service.status("__proto__")).toBeUndefined()
  }))

  test("across independent handles, same-key replay shares the one accepted job", () => withDirectory(async directory => {
    const first = new HardBenchmarkService(directory, { sources: [source("r1")] })
    const second = new HardBenchmarkService(directory)
    const jobs = await Promise.all([first.submit(query("shared")), second.submit(query("shared"))])
    expect(jobs[0]).toEqual(jobs[1]!)
    expect(await second.ledger()).toMatchObject({ acceptedComputations: 1, acceptedWorkUnits: 3 })
  }))

  test("a rejected database commit leaves neither a ghost acceptance nor consumed faults", () => withDirectory(async directory => {
    const service = new HardBenchmarkService(directory, { sources: [source("r1")], faults: {
      loseAcknowledgement: { idempotencyKey: "fault" },
      changeSource: { afterAcceptedComputations: 1, source: source("r2", [{ wafer: "W9" }]) },
    } })
    expect((await service.ledger()).jobs).toBe(0)
    const db = new Database(join(directory, "service-state.sqlite"))
    try {
      db.exec("CREATE TRIGGER reject_write BEFORE INSERT ON benchmark_state BEGIN SELECT RAISE(ABORT, 'injected write failure'); END")
      await expect(service.submit(query("fault"))).rejects.toThrow("injected write failure")
      expect(await service.lookup("fault")).toBeUndefined()
      expect(await service.currentRevision("wafer-events")).toBe("r1")
      expect(await service.ledger()).toEqual({ acceptedComputations: 0, acceptedWorkUnits: 0, jobs: 0, lostAcknowledgements: 0, sourceChanges: 0 })
      db.exec("DROP TRIGGER reject_write")
    } finally { db.close() }
    const restarted = new HardBenchmarkService(directory)
    await expect(restarted.submit(query("fault"))).rejects.toBeInstanceOf(LostAcknowledgementError)
    const job = (await restarted.lookup("fault"))!
    expect(job.sourceRevision).toBe("r1")
    expect(await restarted.currentRevision("wafer-events")).toBe("r2")
    expect(await restarted.ledger()).toEqual({ acceptedComputations: 1, acceptedWorkUnits: 3, jobs: 1, lostAcknowledgements: 1, sourceChanges: 1 })
  }))

  test("pins manifests, rejects stale current reads and keeps explicit snapshots available", () => withDirectory(async directory => {
    const service = new HardBenchmarkService(directory, { sources: [source("r1")] })
    const job = await service.submit(query("original"))
    const manifest = await service.manifest(job.jobId)
    const first = await service.readPage(job.jobId, undefined, 1)
    expect(first.rows).toEqual([{ wafer: "W1", lot: "A" }])
    await service.replaceSource(source("r2", [],), { approved: true, reason: "synthetic refresh" })
    await expect(service.replaceSource(source("r2"), { approved: true, reason: "changed data" })).rejects.toThrow("source revision cannot be reused")
    await expect(service.replaceSource(source("r1"), { approved: true, reason: "rollback" })).rejects.toThrow("source revision cannot be reused")
    const restarted = new HardBenchmarkService(directory)
    await expect(restarted.readPage(job.jobId, first.nextCursor, 1)).rejects.toBeInstanceOf(StaleSourceError)
    expect(await restarted.readPage(job.jobId, first.nextCursor, 1, "snapshot")).toEqual({
      jobId: job.jobId, sourceRevision: "r1", rows: [{ wafer: "W3", lot: "B" }],
    })
    expect(await restarted.manifest(job.jobId)).toEqual(manifest!)
    expect(await restarted.submit(query("original"))).toEqual(job)
    await expect(restarted.submit(query("fresh"))).rejects.toBeInstanceOf(StaleSourceError)
    expect((await restarted.evidence()).jobs[0]).toMatchObject({ rowsRead: 2, currentRowsRead: 1 })
  }))

  test("enforces count and byte limits, job-bound cursors, and complete distinct read coverage", () => withDirectory(async directory => {
    const service = new HardBenchmarkService(directory, { sources: [source("r1", Array.from({ length: 4 }, (_, index) => ({
      index, defect: true, body: "é".repeat(15_000),
    })))] })
    const one = await service.submit({ ...query("one"), select: undefined })
    const two = await service.submit({ ...query("two"), select: undefined })
    await expect(service.readPage(one.jobId, undefined, 101)).rejects.toThrow("page limit")
    const first = await service.readPage(one.jobId, undefined, 100)
    expect(first.rows.map(row => row.index)).toEqual([0, 1])
    await expect(service.readPage(two.jobId, first.nextCursor, 10)).rejects.toThrow("invalid result cursor")
    await expect(service.readPage(one.jobId, `${one.jobId}:02`, 10)).rejects.toThrow("invalid result cursor")
    expect(await service.readPage(one.jobId, undefined, 100)).toEqual(first)
    expect((await service.evidence()).jobs[0]?.rowsRead).toBe(2)
    const last = await service.readPage(one.jobId, first.nextCursor, 100)
    expect(last.rows.map(row => row.index)).toEqual([2, 3])
    expect(last.nextCursor).toBeUndefined()
    expect((await service.evidence()).jobs[0]?.rowsRead).toBe(4)
  }))

  test("oversized results and unavailable sources cannot create accepted jobs", () => withDirectory(async directory => {
    const service = new HardBenchmarkService(directory, { sources: [
      source("r1", Array.from({ length: 2049 }, () => ({ defect: true }))),
      { sourceId: "wide", revision: "w1", rows: Array.from({ length: 12 }, () => ({ value: "x".repeat(50_000) })) },
      { sourceId: "huge-row", revision: "h1", rows: [{ value: "x".repeat(65_536) }] },
      { sourceId: "waiting", revision: "r3", available: false, rows: [] },
    ] })
    for (const sourceId of ["wafer-events", "wide", "huge-row"]) {
      await expect(service.submit({ idempotencyKey: sourceId, sourceId })).rejects.toThrow("result exceeds service limits")
      expect(await service.lookup(sourceId)).toBeUndefined()
    }
    expect(await service.sourceStatus("waiting")).toEqual({ revision: "r3", available: false })
    await expect(service.submit({ idempotencyKey: "wait", sourceId: "waiting" })).rejects.toBeInstanceOf(SourceUnavailableError)
    expect((await service.evidence()).unavailableChecks).toEqual([{ sourceId: "waiting", revision: "r3" }])
    expect((await service.ledger()).acceptedComputations).toBe(0)
    const empty = await service.submit({ ...query("narrow"), filter: { defect: false } })
    expect(empty.rowCount).toBe(0)
    expect(empty.workUnits).toBe(2049)
  }))
})


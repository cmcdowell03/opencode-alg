import { describe, expect, test } from "bun:test"
import { once } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { createConnection } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createAcceptedQueryLostAckFixture, createPartialInvestigationRestartFixture, openHardFixtureService,
  scoreHardFixture, type CreatedHardFixture,
} from "../scripts/hard-benchmark-fixtures.ts"
import { hardBenchmarkReferenceArm } from "../scripts/hard-benchmark-qualification.ts"
import {
  createHardBenchmarkHttpClient, HARD_BENCHMARK_HOST_LIMITS, hardBenchmarkHostUsage, startHardBenchmarkHost,
} from "../scripts/hard-benchmark-host.ts"
import {
  HardBenchmarkService, LostAcknowledgementError, SourceUnavailableError, StaleSourceError, type ServiceOptions,
} from "../scripts/hard-benchmark-service.ts"

const rows = [{ observation: "W1", affected: true }, { observation: "W2", affected: false }]
const options: ServiceOptions = { sources: [{ sourceId: "source", revision: "r1", rows }], maxAcceptedWorkUnits: rows.length }
const query = { sourceId: "source", expectedRevision: "r1", idempotencyKey: "caller-key" }
type Host = Awaited<ReturnType<typeof startHardBenchmarkHost>>

async function withDirectory(run: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "hard-benchmark-http-test-"))
  try { await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
async function withService(settings: ServiceOptions, run: (service: HardBenchmarkService, host: Host) => Promise<void>) {
  await withDirectory(async directory => {
    const service = new HardBenchmarkService(directory, settings)
    await service.ledger()
    const host = await startHardBenchmarkHost(service)
    try { await run(service, host) } finally { await host.stop() }
  })
}
const post = (url: string, path: string, body: unknown) => fetch(url + path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
})

describe("hard benchmark public loopback HTTP host (same-user development)", () => {
  const references: [string, () => CreatedHardFixture][] = [
    ["accepted lost ACK", () => createAcceptedQueryLostAckFixture()],
    ["accepted lost ACK alternate seed", () => createAcceptedQueryLostAckFixture(7)],
    ["partial restart with stale evidence", createPartialInvestigationRestartFixture],
  ]
  test.each(references)("healthy public reference passes unchanged scorer: %s", async (_label, make) => {
    await withDirectory(async directory => {
      const fixture = make(), service = await openHardFixtureService(fixture, directory)
      const host = await startHardBenchmarkHost(service)
      try {
        const client = createHardBenchmarkHttpClient(host.url)
        expect(Object.keys(client).sort()).toEqual(["currentRevision", "ledger", "lookup", "manifest", "readPage", "sourceStatus", "status", "submit"])
        const submission = await hardBenchmarkReferenceArm({ fixture: structuredClone(fixture.contestant), service: client })
        const grade = await scoreHardFixture(fixture, submission, { service })
        expect(grade.checks.filter(check => !check.passed)).toEqual([])
        expect(grade.passed).toBe(true)
        expect(await client.ledger()).toEqual(await service.ledger())
      } finally { await host.stop() }
    })
  })

  test("native Node fetch recovers a lost ACK, avoids repeat charges, obeys work limit and produces a passing report", () => withDirectory(async directory => {
    const fixture = createAcceptedQueryLostAckFixture(3), service = await openHardFixtureService(fixture, directory)
    const host = await startHardBenchmarkHost(service)
    try {
      const executable = Bun.which("node")
      expect(executable).not.toBeNull()
      // This child receives only the endpoint and the public request. It imports no service, fixture, scorer or oracle code.
      const script = `
        const assert = require('node:assert/strict');
        const [url, text] = process.argv.slice(1), request = JSON.parse(text);
        async function call(operation, input) {
          const response = await fetch(url+'/'+operation,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});
          return {status:response.status,...await response.json()};
        }
        (async () => {
          const query = {sourceId:request.sourceId,expectedRevision:request.revision,idempotencyKey:request.idempotencyKey,filter:{window:request.window}};
          const lost = await call('submit',query);
          assert.equal(lost.status,503); assert.equal(lost.error.code,'ACK_LOST_AFTER_ACCEPTANCE');
          assert.equal(lost.error.idempotencyKey,request.idempotencyKey); assert.equal(lost.error.acceptedJobId,undefined);
          const job = (await call('lookup',{idempotencyKey:query.idempotencyKey})).value;
          assert.equal((await call('status',{jobId:job.jobId})).value.status,'complete');
          assert.equal((await call('manifest',{jobId:job.jobId})).value.resultDigest,job.resultDigest);
          assert.equal((await call('submit',query)).value.jobId,job.jobId);
          const denied = await call('submit',{...query,idempotencyKey:'unnecessary-new-computation'});
          assert.equal(denied.status,429); assert.equal(denied.error.code,'WORK_BUDGET_EXCEEDED');
          const distinct = new Map(); let cursor;
          do {
            const page = await call('readPage',{jobId:job.jobId,cursor,limit:5}); assert.equal(page.ok,true);
            for(const row of page.value.rows) {
              const key = JSON.stringify([row.lot,row.observation]);
              distinct.set(key,(distinct.get(key)||false)||row.affected===true);
            }
            cursor = page.value.nextCursor;
          } while(cursor!==undefined);
          const affected = [...distinct].filter(([,value])=>value);
          const report = {numerator:affected.length,denominator:distinct.size,rate:affected.length/distinct.size,
            affectedLots:[...new Set(affected.map(([key])=>JSON.parse(key)[0]))].sort(),
            jobId:job.jobId,sourceRevision:job.sourceRevision,resultDigest:job.resultDigest};
          const ledger = (await call('ledger',{})).value; assert.equal(ledger.acceptedComputations,1);
          assert.equal(ledger.acceptedWorkUnits,job.workUnits);
          process.stdout.write(JSON.stringify({report,ledger}));
        })().catch(error=>{console.error(error);process.exitCode=1});`
      const child = Bun.spawn([executable!, "-e", script, host.url, fixture.contestant.files["sources/request.json"]!], {
        cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 10_000,
      })
      let output: string
      try {
        const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
        output = stdout
      } finally { if (child.exitCode === null) child.kill(); await child.exited }
      const result = JSON.parse(output)
      const grade = await scoreHardFixture(fixture, { files: { ...fixture.contestant.files, "report.json": JSON.stringify(result.report) } }, { service })
      expect(grade.checks.filter(check => !check.passed)).toEqual([])
      expect(grade.passed).toBe(true)
      expect(result.ledger).toEqual(await service.ledger())
      const usage = hardBenchmarkHostUsage(host.url)
      expect(usage).toContain("SAME USER DEVELOPMENT ONLY")
      expect(usage).toContain("not an OS isolation boundary")
      expect(usage).toContain(`fetch('${host.url}/lookup'`)
      expect(usage).not.toContain(directory)
      expect(usage).not.toContain("service-state.sqlite")
    } finally { await host.stop() }
  }))

  test("HTTP proxy preserves native lost-ACK, stale-source and unavailable-source errors", () => withService({ ...options,
    faults: { loseAcknowledgement: { idempotencyKey: query.idempotencyKey } },
  }, async (service, host) => {
    const client = createHardBenchmarkHttpClient(host.url)
    await expect(client.submit(query)).rejects.toBeInstanceOf(LostAcknowledgementError)
    const job = (await client.lookup(query.idempotencyKey))!
    expect(await client.status(job.jobId)).toEqual(job)
    expect((await client.readPage(job.jobId, undefined, 1)).rows).toEqual([rows[0]!])
    expect(await client.currentRevision("source")).toBe("r1")
    expect(await client.sourceStatus("source")).toEqual({ revision: "r1", available: true })
    const before = await client.ledger()
    await expect(client.submit({ ...query, filter: { affected: true } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 })
    expect(await client.submit(query)).toEqual(job)
    await expect(client.submit({ ...query, idempotencyKey: "repeat" })).rejects.toMatchObject({ code: "WORK_BUDGET_EXCEEDED", status: 429 })
    expect(await client.ledger()).toEqual(before)
    // Host-side fault injection only; no HTTP route permits this operation.
    await service.replaceSource({ sourceId: "source", revision: "r2", available: false, rows: [] }, { approved: true, reason: "test source drift" })
    await expect(client.readPage(job.jobId, undefined, 1)).rejects.toBeInstanceOf(StaleSourceError)
    await expect(client.readPage(job.jobId, undefined, 1)).rejects.toMatchObject({ code: "SOURCE_REVISION_CHANGED", sourceId: "source", expected: "r1", current: "r2" })
    expect((await client.readPage(job.jobId, undefined, 100, "snapshot")).rows).toEqual(rows)
    expect(await client.sourceStatus("source")).toEqual({ revision: "r2", available: false })
    expect(await client.currentRevision("source")).toBe("r2")
    await expect(client.submit({ ...query, expectedRevision: "r2", idempotencyKey: "fresh" })).rejects.toBeInstanceOf(SourceUnavailableError)
    await expect(client.submit({ ...query, expectedRevision: "r2", idempotencyKey: "fresh" })).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE", revision: "r2" })
    for (const result of [await client.lookup("absent"), await client.status("absent"), await client.manifest("absent"),
      await client.sourceStatus("absent"), await client.currentRevision("absent")]) expect(result).toBeUndefined()
  }))

  test("only exact public POST routes exist and prohibited routes cannot change state", () => withService(options, async (service, host) => {
    const before = await service.evidence()
    for (const path of ["/", "/evidence", "/replaceSource", "/admin", "/stop", "/constructor", "/__proto__", "/ledger/", "/ledger?method=evidence"]) {
      const response = await post(host.url, path, {})
      expect(response.status).toBe(404)
      expect(await response.json()).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } })
    }
    for (const method of ["GET", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS"]) {
      const response = await fetch(host.url + "/ledger", { method })
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("POST")
      await response.text()
    }
    for (const [path, body] of [["/ledger", { method: "evidence" }], ["/submit", { ...query, workUnits: 0 }],
      ["/readPage", { jobId: "absent", limit: 1, admin: true }],
      ["/submit", { ...query, filter: { affected: { nested: true } } }]] as const) {
      expect((await post(host.url, path, body)).status).toBe(400)
    }
    expect(await service.evidence()).toEqual(before)
  }))

  test("malformed, oversized and chunked oversized bodies fail before service work", () => withService(options, async (service, host) => {
    for (const body of ["", "{", "null", "[]", "1", '{"__proto__":{"admin":true}}']) {
      const response = await fetch(host.url + "/submit", { method: "POST", headers: { "content-type": "application/json" }, body })
      expect(response.status).toBe(400)
      expect((await response.json()).ok).toBe(false)
    }
    const unsupportedHeaders: Record<string, string>[] = [{ "content-type": "text/plain" }, { "content-type": "application/json", "content-encoding": "gzip" }]
    for (const headers of unsupportedHeaders) {
      const response = await fetch(host.url + "/ledger", { method: "POST", headers, body: "{}" })
      expect(response.status).toBe(415)
      await response.text()
    }
    const invalidUtf8 = await fetch(host.url + "/ledger", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array([0xff]) })
    expect(invalidUtf8.status).toBe(400)
    expect((await invalidUtf8.json()).error.code).toBe("INVALID_JSON")
    const oversized = JSON.stringify({ idempotencyKey: "€".repeat(30_000) })
    expect(oversized.length).toBeLessThan(HARD_BENCHMARK_HOST_LIMITS.requestBytes)
    const response = await fetch(host.url + "/lookup", { method: "POST", headers: { "content-type": "application/json" }, body: oversized })
    expect(response.status).toBe(413)
    expect((await response.json()).error.code).toBe("REQUEST_TOO_LARGE")
    const stream = new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(" ".repeat(40_000)))
      controller.enqueue(new TextEncoder().encode(" ".repeat(40_000)))
      controller.close()
    } })
    const chunked = await fetch(host.url + "/ledger", { method: "POST", headers: { "content-type": "application/json" },
      body: stream, duplex: "half" } as RequestInit & { duplex: "half" })
    expect(chunked.status).toBe(413)
    expect((await chunked.json()).error.code).toBe("REQUEST_TOO_LARGE")
    expect(await service.ledger()).toMatchObject({ acceptedComputations: 0, acceptedWorkUnits: 0 })
  }))

  test("response limit permits bounded pages and fails closed on oversized or internal host output", () => withService({
    sources: [{ sourceId: "source", revision: "r1", rows: [{ payload: "x".repeat(60_000) }] }],
  }, async (service, host) => {
    const client = createHardBenchmarkHttpClient(host.url), job = await client.submit(query)
    const page = await post(host.url, "/readPage", { jobId: job.jobId, limit: 100 })
    expect(page.status).toBe(200)
    const text = await page.text()
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(HARD_BENCHMARK_HOST_LIMITS.responseBytes)
    expect(Number(page.headers.get("content-length"))).toBe(Buffer.byteLength(text))
    expect(JSON.parse(text).value.rows).toEqual([{ payload: "x".repeat(60_000) }])
    const ledger = await service.ledger()
    service.ledger = async () => ({ ...ledger, oversized: "x".repeat(HARD_BENCHMARK_HOST_LIMITS.responseBytes) })
    const response = await post(host.url, "/ledger", {})
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ ok: false, error: { code: "RESPONSE_TOO_LARGE" } })
    service.ledger = async () => { throw new Error("oracle private database at C:/secret/grader.sqlite") }
    const failed = await post(host.url, "/ledger", {})
    expect(failed.status).toBe(500)
    const error = await failed.text()
    expect(error).not.toContain("secret")
    expect(error).not.toContain("oracle")
    await expect(client.ledger()).rejects.toMatchObject({ code: "INTERNAL_ERROR", status: 500 })
    for (const Failure of [TypeError, RangeError]) {
      service.ledger = async () => { throw new Failure("oracle private database at C:/secret/grader.sqlite") }
      const internal = await post(host.url, "/ledger", {})
      expect(internal.status).toBe(500)
      expect(await internal.text()).not.toContain("grader.sqlite")
    }
  }))

  test("per-arm endpoints keep distinct state; stop is idempotent and closes incomplete requests", () => withService(options, async (_first, a) => {
    await withService(options, async (_second, b) => {
      expect(a.url).not.toBe(b.url)
      expect(new URL(a.url).hostname).toBe("127.0.0.1")
      const clientA = createHardBenchmarkHttpClient(a.url), clientB = createHardBenchmarkHttpClient(b.url)
      await clientA.submit(query)
      expect(await clientB.lookup(query.idempotencyKey)).toBeUndefined()
      expect((await clientB.ledger()).acceptedWorkUnits).toBe(0)
      const socket = createConnection({ host: "127.0.0.1", port: Number(new URL(a.url).port) })
      socket.on("error", () => {})
      await once(socket, "connect")
      socket.resume()
      const closed = new Promise<void>(resolve => socket.once("close", () => resolve()))
      socket.write("POST /lookup HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{")
      const stoppingAt = performance.now()
      await a.stop()
      await closed
      await a.stop()
      expect(performance.now() - stoppingAt).toBeLessThan(3_000)
      await expect(fetch(a.url + "/ledger", { method: "POST", body: "{}", signal: AbortSignal.timeout(1_000) })).rejects.toThrow()
      expect((await clientB.ledger()).acceptedComputations).toBe(0)
    })
  }))
})

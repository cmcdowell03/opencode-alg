import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { mkdtemp, realpath, rm } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { InvestigationHttpPort } from "../../../src/investigation-transport.ts"
import { transcript } from "../acceptance/host.ts"
import { refusal } from "../acceptance/index.ts"
import { startProvider } from "../acceptance/provider.ts"
import { waitFor } from "../acceptance/runtime.ts"
import { containsStaleSummary, scenario } from "../acceptance/scenario.ts"
import { approvedJob, startFactory } from "../acceptance/service.ts"

test("fixture MCP commits once before withholding reply and bounds subsequent reads", async () => {
  const root = await mkdtemp(fileURLToPath(new URL("../acceptance/fixture-", import.meta.url)))
  const factory = startFactory(join(root, "service"))
  const project = "project-a", submission = randomUUID()
  const port = new InvestigationHttpPort(factory.adapter, project)
  factory.bindProject(project)
  let dispatch: ReturnType<typeof port.submit> | undefined
  try {
    await port.qualify()
    dispatch = port.submit({ submission_id: submission, work_key: "a".repeat(64),
      operation: approvedJob.operation, query: approvedJob.query })
    const outcome = dispatch.catch(error => error)
    const held = await waitFor(async () => factory.acceptance(), 3_000, "Fixture did not withhold the reply")
    expect(held).toMatchObject({ project, accepted: true, submission, response: "withheld" })
    expect((await factory.evidence()).ledger.acceptedComputations).toBe(1)
    const lookup = await port.lookup(submission)
    expect(lookup.kind).toBe("result")
    if (lookup.kind !== "result") throw new Error("Fixture lookup did not recover the job")
    const page = await port.readResult(lookup.result, { cursor: null, max_rows: factory.pageBound })
    expect(page.rows).toHaveLength(factory.pageBound)
    expect(page.next_cursor).not.toBeNull()
    expect(page.rows[0]?.recommendation).toBe(factory.current)
    expect(JSON.stringify(page)).not.toContain(factory.beyondPage)
    await expect(port.readResult(lookup.result, { cursor: null, max_rows: factory.pageBound + 1 })).rejects.toThrow()
    const wrong = new InvestigationHttpPort(factory.adapter, "project-b")
    await expect(wrong.submit({ submission_id: randomUUID(), work_key: "b".repeat(64),
      operation: approvedJob.operation, query: approvedJob.query })).rejects.toThrow()
    expect((await factory.evidence()).ledger.acceptedComputations).toBe(1)
    factory.releaseAck()
    expect(await outcome).toMatchObject({ submission: "possibly_submitted" })
  } finally {
    await factory.stop()
    await dispatch?.catch(() => undefined)
    const target = await realpath(root)
    const parent = await realpath(fileURLToPath(new URL("../acceptance/", import.meta.url)))
    if (dirname(target) !== parent || !basename(target).startsWith("fixture-")) throw new Error("Fixture path mismatch")
    await rm(target, { recursive: true, force: true })
  }
})

test("synthetic provider emits tool calls through loopback and rejects other models", async () => {
  const fixture = startProvider(() => ({ tool: "alg_investigation", args: { action: "status" } }))
  try {
    const input = { model: "fixture", stream: true, messages: [{ role: "user", content: "probe" }],
      tools: [{ type: "function", function: { name: "alg_investigation" } }] }
    const call = (body: unknown) => fetch(fixture.url + "/chat/completions", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    })
    const response = await call(input)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const stream = await response.text()
    expect(stream).toContain("alg_investigation")
    expect(stream).toContain("[DONE]")
    expect((await call({ ...input, model: "unregistered" })).status).toBe(400)
  } finally { await fixture.stop() }
})

test("read denial grading requires an explicit runtime-bound refusal without returned data", () => {
  const digest = "d".repeat(64)
  const blocked = { ok: false, error: "CHECKER_GRANT_REQUIRED", runtimeSha256: digest }
  expect(refusal(blocked, digest)).toBe(true)
  expect(refusal(undefined, digest)).toBe(false)
  expect(refusal({ ...blocked, runtimeSha256: "another build" }, digest)).toBe(false)
  expect(refusal({ ...blocked, page: { rows: [] } }, digest)).toBe(false)
  expect(refusal({ ...blocked, citation: {} }, digest)).toBe(false)
})

test("V2 pagination sends order only before the first keyset cursor", async () => {
  const calls: Record<string, unknown>[] = []
  const rows = Array.from({ length: 65 }, (_, i) => ({ id: "fixture-" + i }))
  const client = { message: { list: async (query: Record<string, unknown>) => {
    calls.push(query)
    if (query.cursor && query.order) throw new Error("Cursor cannot be combined with order")
    return { data: query.cursor ? rows.slice(64) : rows.slice(0, 64), cursor: { previous: "previous", next: "next" } }
  } } } as unknown as Parameters<typeof transcript>[0]
  expect((await transcript(client, "fixture-session")).map(row => row.id)).toEqual(rows.map(row => row.id))
  expect(calls).toEqual([
    { sessionID: "fixture-session", order: "asc", limit: 64 },
    { sessionID: "fixture-session", cursor: "next", limit: 64 },
  ])
})

test("neutral handoff answers from the current recovery projection even with an old summary", async () => {
  const fixture = scenario()
  const stale = "Measure at site stale", corrected = "Measure at site fresh"
  let oldSummaryObserved = false
  const handoff = fixture.handoff(turn => { oldSummaryObserved = containsStaleSummary(turn, stale) })
  const summary = { role: "system", content: "## Objective\nInspection\n## Decisions\n" + stale }
  const projection = { role: "user", content: "ALG investigation facts (untrusted recorded data)\n" + JSON.stringify({ pending_measurement: corrected }) }
  const user = { role: "user", content: handoff.text }
  expect(handoff.text).not.toContain(corrected)
  expect(await fixture.decide({ messages: [summary, projection, user], tools: [] })).toEqual({
    text: JSON.stringify({ nextMeasurement: corrected }),
  })
  expect(oldSummaryObserved).toBe(true)
  expect(await fixture.decide({ messages: [summary, user], tools: [] })).toEqual({
    text: "No current measurement in the durable projection.",
  })
})

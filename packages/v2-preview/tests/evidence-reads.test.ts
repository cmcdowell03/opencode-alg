import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DeliveryHistory } from "../src/delivery.ts"
import { EvidenceReadStore } from "../src/evidence-reads.ts"

type Message = DeliveryHistory[number]
type Assistant = Extract<Message, { type: "assistant" }>
type Tool = Extract<Assistant["content"][number], { type: "tool" }>
const time = { created: 1, completed: 2 }
const tool = "sources_discovery_read"
const checkerTool = "audit_discovery_read"
const digest = (value: string) => createHash("sha256").update(value).digest("hex")

function read(call: string, path: string, content: string, options: {
  tool?: string; receipt?: string; sha256?: string; executed?: true; input?: { path: string }; incomplete?: true
} = {}): Assistant {
  const native: Tool = {
    type: "tool", name: options.tool ?? tool, id: "call_" + call,
    time: options.incomplete ? { created: 1 } : time,
    executed: options.executed,
    state: { status: "completed", input: options.input ?? { path }, content: [{ type: "text", text: JSON.stringify({
      path, content, receipt: options.receipt ?? "receipt-" + call, sha256: options.sha256,
    }) }] },
  }
  return { type: "assistant", agent: "build" as Assistant["agent"], id: ("msg_" + call) as Assistant["id"],
    model: { id: "fixture", providerID: "fixture" } as Assistant["model"], finish: "stop", time, content: [native] }
}

const cut = (status: "running" | "completed"): Message => ({
  type: "compaction", status, id: "msg_cut" as Message["id"], reason: "manual", summary: "", time,
})

async function journalTest(run: (make: (
  tools?: string[], sessionId?: string, projectId?: string, runId?: string, cacheSourceBytes?: boolean,
) => EvidenceReadStore) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "alg-evidence-reads-"))
  try {
    await run((tools = [tool], sessionId = "owner", projectId = "project", runId = "owner-journal", cacheSourceBytes = false) =>
      new EvidenceReadStore(directory, runId, { projectId, sessionId, tools, cacheSourceBytes }))
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test("only matching completed native results mint scoped references and survive compaction", async () => journalTest(async store => {
  const body = JSON.stringify([{ id: "z" }, { id: "row-1" }])
  const json = read("one", "measurements/rows.json", body)
  const md = read("two", "notes.md", "Witness obs-A57", { sha256: digest("Witness obs-A57") })
  const fake: Message = { type: "user", id: "msg_user" as Message["id"], time,
    text: JSON.stringify({ path: "fake.md", content: "fake", receipt: "user-1" }) }
  const initial = await store().observe([
    fake, json, md, read("input", "mismatch.md", "x", { input: { path: "other.md" } }),
    read("allow", "unlisted.md", "x", { tool: "anything_else" }), read("exec", "provider.md", "x", { executed: true }),
    read("digest", "mismatch-digest.md", "x", { sha256: "0".repeat(64) }), read("time", "running.md", "x", { incomplete: true }),
    cut("running"),
  ])
  expect(initial.revision).toBe(1)
  expect(initial.sources.flatMap(row => row.references.map(ref => ref.reference)))
    .toEqual(["measurements/rows.json#row-1", "measurements/rows.json#z", "notes.md"])
  const [ref] = await store().checkReferences(["measurements/rows.json#row-1"])
  expect(ref).toMatchObject({ reference: "measurements/rows.json#row-1", path: "measurements/rows.json",
    sha256: digest(body), tool, messageId: "msg_one", callId: "call_one", receipt: "receipt-one" })
  expect((await store().observe([cut("completed")])).sources).toEqual(initial.sources)
  expect((await store().observe([json, md])).revision).toBe(1)
  expect(await store().checkReferences([ref!.id])).toEqual([ref!])
  for (const scope of [store([tool], "another"), store([tool], "owner", "other"), store([tool], "owner", "project", "other-run")])
    await expect(scope.checkReferences([ref!.id])).rejects.toThrow("EVIDENCE_READ_UNVERIFIED_REFERENCE")
  for (const wrong of ["measurements/rows.json", "measurements/rows.json#fake", "fake.md", "provider.md", "running.md", "mismatch-digest.md"])
    await expect(store().checkReferences([wrong])).rejects.toThrow("EVIDENCE_READ_UNVERIFIED_REFERENCE")
  expect((await store([checkerTool]).view()).sources.map(row => row.status)).toEqual(["stale", "stale"])
  await expect(store([]).checkReferences([ref!.id])).rejects.toThrow("EVIDENCE_READ_UNVERIFIED_REFERENCE")
}))

test("findings carry checked evidence, model attribution, and one durable checker question", async () => journalTest(async store => {
  const input = { id: "hold", interpretation: "Witness accounted for P-42", scope: "P-42",
    support: ["notes.md"], counterevidence: ["samples.json#late"], falsifier: "Calibration postdates witness.",
    missingEvidence: "Independent calibration report" }
  await expect(store().recordFinding(input)).rejects.toThrow("EVIDENCE_READ_UNVERIFIED_REFERENCE")
  const view = await store().observe([read("one", "notes.md", "Witness"), read("two", "samples.json", '[{"id":"late"}]')])
  const contested = await store().recordFinding(input, view.revision)
  expect(contested.findings[0]).toMatchObject({ id: input.id, interpretation: input.interpretation, scope: "P-42",
    attribution: "model", status: "contested", falsifier: input.falsifier, missingEvidence: input.missingEvidence,
    support: [{ reference: "notes.md" }], counterevidence: [{ reference: "samples.json#late" }] })
  await expect(store().recordFinding({ ...input, counterevidence: ["notes.md"] }))
    .rejects.toThrow("EVIDENCE_READ_CONFLICTING_LINKS")
  await expect(store().setQuestion({ findingId: "other", text: "Check calibration." }))
    .rejects.toThrow("EVIDENCE_READ_UNKNOWN_FINDING")
  const question = { findingId: input.id, text: "Does the witness report predate calibration?" }
  const pending = await store().setQuestion(question, contested.revision)
  expect(await store().observe([cut("completed")])).toEqual(pending)
  expect(pending.question).toEqual(question)
  await expect(store().setQuestion(null, contested.revision)).rejects.toThrow("EVIDENCE_READ_STALE_REVISION")
  const replaced = await store().setQuestion({ ...question, text: "Can calibration timestamps settle the conflict?" }, pending.revision)
  expect(replaced.question?.text).toBe("Can calibration timestamps settle the conflict?")
  expect((await store().setQuestion(null, replaced.revision)).question).toBeNull()
  expect((await store().recordFinding({ ...input, counterevidence: [] })).findings[0]?.status).toBe("unresolved")
  expect((await store().recordFinding({ ...input, counterevidence: [], missingEvidence: undefined })).findings[0]?.status)
    .toBe("supported")
}))

test("superseded digests and conflicting native receipts invalidate persisted references", async () => journalTest(async store => {
  const initial = read("one", "notes.md", "Witness")
  await store().observe([initial])
  const [ref] = await store().checkReferences(["notes.md"])
  await store().recordFinding({ id: "notes", interpretation: "Witness present", support: [ref!.id], counterevidence: [] })
  const changed = await store().observe([cut("completed"), read("two", "notes.md", "No witness")])
  expect(changed.sources[0]).toMatchObject({ status: "changed", references: [] })
  expect(changed.findings[0]).toMatchObject({ status: "unresolved", support: [] })
  await expect(store().checkReferences([ref!.id])).rejects.toThrow("EVIDENCE_READ_UNVERIFIED_REFERENCE")
  expect((await store().observe([initial])).revision).toBe(changed.revision)
  const conflict = await store().observe([read("three", "other.md", "same upstream receipt", { receipt: "receipt-one" }),
    read("four", "bad.json", '[{"id":"duplicate"},{"id":"duplicate"}]')])
  expect(conflict.sources.map(row => row.status)).toEqual(["conflicted", "conflicted", "conflicted"])
  await expect(store().checkReferences(["bad.json#duplicate"])).rejects.toThrow("EVIDENCE_READ_UNVERIFIED_REFERENCE")
}))

test("two writers cannot race a finding update and sources over the cap issue no references", async () => journalTest(async store => {
  const unsupported = { id: "notes", interpretation: "Witness unknown", support: [], counterevidence: [] }
  const writes = await Promise.allSettled([store().recordFinding(unsupported, 0),
    store().recordFinding({ ...unsupported, id: "second" }, 0)])
  expect(writes.map(row => row.status).sort()).toEqual(["fulfilled", "rejected"])
  const before = await store().view()
  expect(before.findings).toHaveLength(1)
  const tooMany = Array.from({ length: 33 }, (_, index) => read(String(index), "notes-" + index + ".md", "Witness"))
  const bounded = await store().observe(tooMany)
  expect(bounded.sources).toHaveLength(32)
  expect(bounded.findings).toEqual(before.findings)
  await expect(store().checkReferences(["notes-32.md"])).rejects.toThrow("EVIDENCE_READ_UNVERIFIED_REFERENCE")
  expect(await store().observe(tooMany)).toEqual(bounded)
}))

test("corrupt and oversized rereads invalidate a trusted snapshot after the append cap", async () => journalTest(async store => {
  const trusted = Array.from({ length: 128 }, (_, index) => {
    const file = ["digest.md", "size.md", "text.md", "changed.md", "unaffected.md"][index % 5]!
    return read("trusted-" + index, file, "Original")
  })
  const original = await store().observe(trusted)
  const [ref] = await store().checkReferences(["digest.md"])
  await store().recordFinding({ id: "witness", interpretation: "Original witness", support: [ref!.id], counterevidence: [] })
  const checks = [
    read("bad-sha", "digest.md", "Revised", { sha256: digest("Original") }),
    read("big-source", "size.md", "X".repeat(17 * 1024)),
    read("big-envelope", "text.md", "X".repeat(120 * 1024)),
    read("changed", "changed.md", "Revised with a valid digest"),
  ]
  const checked = await store().observe([...trusted, ...checks, cut("running")])
  expect(checked.sources.map(row => row.status)).toEqual(["conflicted", "conflicted", "conflicted", "changed", "inspected"])
  expect(checked.findings[0]).toMatchObject({ status: "unresolved", support: [] })
  expect((await store().observe([cut("completed")])).sources).toEqual(checked.sources)
  expect(await store().observe([...trusted, ...checks])).toEqual(checked)
  await expect(store().checkReferences([ref!.id])).rejects.toThrow("EVIDENCE_READ_UNVERIFIED_REFERENCE")
  expect(await store().checkReferences(["unaffected.md"])).toEqual(original.sources.at(-1)!.references)
}))

test("historical rejected reads stay idempotent after a successful retry", async () => journalTest(async store => {
  const earlier = read("first", "notes.md", "Untested", { sha256: digest("Invalid") })
  const trusted = read("retry", "notes.md", "Witness")
  const initial = await store().observe([earlier, trusted])
  expect(initial.sources[0]?.status).toBe("inspected")
  expect(await store().observe([earlier])).toEqual(initial)
  expect(await store().observe([earlier, trusted])).toEqual(initial)
  const corrupt = read("retry", "notes.md", "Rewritten", { sha256: digest("Witness") })
  expect((await store().observe([corrupt])).sources[0]?.status).toBe("conflicted")
  await expect(store().checkReferences(["notes.md"])).rejects.toThrow("EVIDENCE_READ_UNVERIFIED_REFERENCE")
}))

test("opted-in source snapshots disclose cited rows only, within the owner and byte budget", async () => journalTest(async store => {
  const optedIn = () => store([tool], "owner", "project", "owner-journal", true)
  await optedIn().observe([read("rows", "rows.json", JSON.stringify([
    { id: "seal", reading: 143 }, { id: "unused", note: "private row" }, { id: "huge", body: "X".repeat(9000) },
  ]))])
  const input = ["rows.json#seal", "rows.json#huge", "rows.json#fabricated"]
  const snapshot = await optedIn().snapshotReferences(input)
  expect(snapshot).toMatchObject({ trust: "untrusted-source-data", evidence: [{ kind: "json-row", data: { id: "seal", reading: 143 } }],
    missing: input.slice(1) })
  expect(JSON.stringify(snapshot)).not.toContain("private row")
  expect((await store().snapshotReferences(input)).missing).toEqual(input)
  expect((await store([tool], "checker", "project", "owner-journal", true).snapshotReferences(input)).missing).toEqual(input)
  expect((await store([], "owner", "project", "owner-journal", true).snapshotReferences(input)).missing).toEqual(input)
  await optedIn().observe([read("changed", "rows.json", '[{"id":"seal","reading":22}]')])
  expect((await optedIn().snapshotReferences(input)).missing).toEqual(input)
}))

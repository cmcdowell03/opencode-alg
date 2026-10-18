import { afterEach, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { MemoryStore, hashObject } from "../src/session-memory/store.ts"
import { ContextDelivery } from "../src/session-memory/delivery.ts"
import { tempProject, removeProject } from "./helpers.ts"

const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) removeProject(path) })
function fixture() {
  const path = tempProject("alg-delivery-"); paths.push(path)
  const directory = join(path, ".opencode/skills/procedure")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "SKILL.md"), "---\nname: procedure\ndescription: Test\n---\nExact required instructions.\n")
  const memory = new SessionMemoryRuntime(path, { mode: "assist" }, [".opencode/skills"], [])
  memory.beginTask("owner", "Test continuity")
  memory.bindSkill("owner", memory.index.search("procedure").skills[0]!.key)
  const pack = memory.prepare("owner", { allowanceBytes: 4096 })
  return { path, memory, store: memory.store, context: pack.receipt!, text: pack.text }
}

test("journal survives restart without rewriting checkpoints or legacy context receipts", () => {
  const { path, memory, store, context } = fixture()
  const checkpoint = memory.current("owner"), legacy = store.contextReceipt("owner")
  const prepared = store.prepareDelivery("owner", "one", "system", context)
  expect(new MemoryStore(path).delivery("owner")!.id).toBe(prepared)
  const emitted = store.settleDelivery("owner", "one", prepared, { state: "emitted" })
  expect(new MemoryStore(path).delivery("owner")).toMatchObject({ id: emitted, value: { state: "emitted", prepared_ref: prepared } })
  expect(store.contextReceipt("owner")).toEqual(legacy)
  expect(memory.current("owner")).toEqual(checkpoint)
  expect(memory.status("owner").delivery?.host_confirmation).toBe("NOT_ATTESTED")
})

test("out-of-order settlement cannot replace latest; evicted preparations cannot settle", () => {
  const { store, context } = fixture()
  const first = store.prepareDelivery("owner", "first", "system", context)
  const second = store.prepareDelivery("owner", "second", "system", context)
  store.settleDelivery("owner", "first", first, { state: "emitted" })
  expect(store.delivery("owner")!.id).toBe(second)
  expect(() => store.settleDelivery("owner", "first", first, { state: "emitted" })).toThrow()
  expect(() => store.prepareDelivery("owner", "second", "system", context)).toThrow()
  for (let i = 0; i < 8; i++) store.prepareDelivery("owner", `later-${i}`, "system", context)
  expect(store.delivery("owner", "second")).toBeNull()
  expect(() => store.settleDelivery("owner", "second", second, { state: "emitted" })).toThrow()
  expect(store.delivery("other", "first")).toBeNull()
})

test("stale, observational and corrupt records fail visibly", () => {
  const { memory, store, context } = fixture()
  expect(() => store.prepareDelivery("owner", "observe", "system", { ...context, state: "observed" })).toThrow()
  store.prepareDelivery("owner", "one", "system", context)
  const path = store.path(["delivery-journals", `${hashObject("owner")}.json`])
  const original = readFileSync(path, "utf8"), record = JSON.parse(original)
  record.entries[0].current.request_id = "tampered"
  writeFileSync(path, JSON.stringify(record))
  expect(() => store.delivery("owner")).toThrow()
  expect(memory.status("owner").delivery_error).toBe("unavailable")
  writeFileSync(path, original)
  memory.beginTask("owner", "changed")
  expect(() => store.prepareDelivery("owner", "stale", "system", context)).toThrow("checkpoint conflict")
})

test("legacy delivery buckets are not scanned or changed by new writes", () => {
  const { store, context } = fixture()
  const bucket = store.path(["deliveries", "fixture.json"], true)
  writeFileSync(bucket, "old evidence")
  const calls: string[] = [], census = (store as any).census.bind(store)
  ;(store as any).census = (name: string, ...args: unknown[]) => { calls.push(name); return census(name, ...args) }
  for (let i = 0; i < 20; i++) {
    const ref = store.prepareDelivery("owner", `request-${i}`, "system", context)
    store.settleDelivery("owner", `request-${i}`, ref, { state: "emitted" })
  }
  expect(calls).toEqual(["delivery-journals"])
  expect(readFileSync(bucket, "utf8")).toBe("old evidence")
  expect(readdirSync(store.path(["delivery-journals"]))).toHaveLength(1)
})

test("legacy receipts remain readable and immutable during journal migration", () => {
  const { store, context } = fixture()
  const preparedRef = store.prepareDelivery("owner", "legacy", "system", context)
  const prepared = store.delivery("owner")!.value
  const emittedRef = store.settleDelivery("owner", "legacy", preparedRef, { state: "emitted" })
  const emitted = store.delivery("owner")!.value
  const legacy = [
    [store.path(["deliveries", `${preparedRef}.json`], true), JSON.stringify(prepared)],
    [store.path(["deliveries", `${emittedRef}.json`], true), JSON.stringify(emitted)],
    [store.path(["delivery-requests", `${hashObject(["owner", "legacy"])}.json`], true), JSON.stringify({
      schema_version: 1, project: store.projectId, owner: "owner", request_id: "legacy", receipt: emittedRef })],
    [store.path(["delivery-latest", `${hashObject("owner")}.json`], true), JSON.stringify({
      schema_version: 1, project: store.projectId, owner: "owner", request_id: "legacy" })],
  ] as const
  for (const [path, bytes] of legacy) writeFileSync(path, bytes)
  unlinkSync(store.path(["delivery-journals", `${hashObject("owner")}.json`]))
  expect(store.delivery("owner")).toEqual({ id: emittedRef, value: emitted })
  expect(store.delivery("owner", "legacy")).toEqual({ id: emittedRef, value: emitted })
  store.prepareDelivery("owner", "current", "system", context)
  expect(store.delivery("owner")!.value.request_id).toBe("current")
  expect(store.delivery("owner", "legacy")).toBeNull()
  for (const [path, bytes] of legacy) expect(readFileSync(path, "utf8")).toBe(bytes)
})

test("5100 real delivery transactions stay bounded across restart", () => {
  const { path, context, store: original } = fixture()
  let store = original
  const early: number[] = [], late: number[] = []
  for (let i = 0; i < 5100; i++) {
    if (i === 2500) store = new MemoryStore(path)
    const started = performance.now()
    const request = `turn-${i}`, ref = store.prepareDelivery("owner", request, "system", context)
    store.settleDelivery("owner", request, ref, { state: "emitted" })
    if (i >= 10 && i < 30) early.push(performance.now() - started)
    if (i >= 5080) late.push(performance.now() - started)
  }
  expect(store.delivery("owner")!.value.request_id).toBe("turn-5099")
  expect(store.delivery("owner", "turn-0")).toBeNull()
  const bucket = store.path(["delivery-journals"])
  expect(readdirSync(bucket)).toHaveLength(1)
  const bytes = readFileSync(join(bucket, `${hashObject("owner")}.json`))
  expect(JSON.parse(bytes.toString()).entries).toHaveLength(8)
  expect(bytes.byteLength).toBeLessThan(100000)
  const percentile = (values: number[], fraction: number) => values.sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]
  console.log(JSON.stringify({ benchmark: "delivery-journal-5100", transactions: 5100, journal_bytes: bytes.byteLength,
    early_median_ms: percentile(early, 0.5), early_p95_ms: percentile(early, 0.95),
    late_median_ms: percentile(late, 0.5), late_p95_ms: percentile(late, 0.95) }))
}, 600_000)

test("publication prepares then emits and repeated hooks replace only owned context", async () => {
  const { memory, store, context, text } = fixture(), target = ["foreign"]
  const delivery = new ContextDelivery(memory)
  for (let i = 0; i < 3; i++) {
    await delivery.replace("owner", "system", target, async (working, prepare) => {
      await prepare(context, text); expect(store.delivery("owner")!.value.state).toBe("prepared"); working.push(text)
    })
    expect(target).toEqual(["foreign", text])
    expect(store.delivery("owner")!.value.state).toBe("emitted")
  }
})

test("preparation failure removes stale instructions without failing conversation", async () => {
  const { memory, store, context, text } = fixture(), target = ["foreign"]
  const delivery = new ContextDelivery(memory)
  await delivery.replace("owner", "system", target, async (working, prepare) => { await prepare(context, text); working.push(text) })
  store.prepareDelivery = () => { throw new Error("capacity") }
  await delivery.replace("owner", "system", target, async (working, prepare, limit, _published, recover) => {
    limit(512); recover("ALG run test; use alg_resume")
    try { await prepare(context, text) } catch { /* hook swallowed the failure */ }
    working.push(text)
  })
  expect(target[0]).toBe("foreign")
  expect(target.join("\n")).not.toContain("Exact required instructions.")
  expect(target.join("\n")).toContain("alg_resume")
  expect(memory.status("owner").delivery_error).toBe("unavailable")
})

test("revocation, changed checkpoint and missing pack prevent procedure publication", async () => {
  for (const failure of ["revoked", "checkpoint", "missing-pack"]) {
    const { memory, store, context, text } = fixture(), target = ["foreign"]
    await new ContextDelivery(memory).replace("owner", "system", target, async (working, prepare) => {
      await prepare(context, text)
      if (failure === "revoked") store.revoke(memory.current("owner").skills[0]!.id)
      if (failure === "checkpoint") memory.beginTask("owner", "new")
      if (failure !== "missing-pack") working.push(text)
    })
    expect(target[0]).toBe("foreign")
    expect(target.join("\n")).not.toContain("Exact required instructions.")
    expect(store.delivery("owner")!.value.state).toBe("unknown")
  }
})

test("identical foreign content cannot attest ALG publication", async () => {
  const { memory, store, context, text } = fixture(), target = [text]
  await new ContextDelivery(memory).replace("owner", "system", target, async (_working, prepare) => {
    await prepare(context, text)
  })
  expect(target[0]).toBe(text)
  expect(store.delivery("owner")!.value).toMatchObject({ state: "unknown", reason: "hook_failed" })
  expect(memory.status("owner").delivery_error).toBe("unavailable")
})

test("settlement failure is unknown and accounting reflects the fallback", async () => {
  const { memory, store, context, text } = fixture(), target: string[] = [], counts: number[] = []
  const settle = store.settleDelivery.bind(store)
  store.settleDelivery = (owner, request, ref, outcome) => {
    if (outcome.state === "emitted") throw new Error("disk failure")
    return settle(owner, request, ref, outcome)
  }
  await new ContextDelivery(memory).replace("owner", "system", target, async (working, prepare, _limit, published) => {
    published((bytes) => counts.push(bytes)); await prepare(context, text); working.push(text)
  })
  expect(target.join("\n")).not.toContain("Exact required instructions.")
  expect(counts.at(-1)).toBe(Buffer.byteLength(target.join("\n")))
  expect(store.delivery("owner")!.value).toMatchObject({ state: "unknown", reason: "emission_unconfirmed" })
})

test("UTF8 separators and fallback obey zero and tiny ceilings", async () => {
  const { memory } = fixture(), target = ["foreign"], counts: number[] = [], delivery = new ContextDelivery(memory)
  await delivery.replace("owner", "system", target, async (working, _prepare, limit, published) => {
    limit(4); published((bytes) => counts.push(bytes)); working.push("é", "x")
  })
  expect(counts).toEqual([4])
  for (const cap of [3, 0]) {
    await delivery.replace("owner", "system", target, async (working, _prepare, limit, published) => {
      limit(cap); published((bytes) => counts.push(bytes)); working.push("é", "x")
    })
    expect(target).toEqual(["foreign"]); expect(counts.at(-1)).toBe(0)
  }
})

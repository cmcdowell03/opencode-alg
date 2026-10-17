import { afterEach, expect, test } from "bun:test"
import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { MemoryStore, hashObject } from "../src/session-memory/store.ts"
import { DeliveryReceiptSchema } from "../src/session-memory/delivery-schema.ts"
import { ContextDelivery } from "../src/session-memory/delivery.ts"
import { tempProject, removeProject } from "./helpers.ts"

const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) removeProject(path) })
function fixture() {
  const path = tempProject("alg-delivery-"); paths.push(path)
  const memory = new SessionMemoryRuntime(path, { mode: "assist" }, [], [])
  memory.beginTask("owner", "Keep the approved task scope")
  const pack = memory.prepare("owner", { allowanceBytes: 4096 })
  return { path, memory, store: memory.store, context: pack.receipt!, text: pack.text }
}

test("delivery records survive restart without rewriting legacy context receipts or checkpoints", () => {
  const { path, memory, store, context } = fixture()
  const checkpoint = memory.current("owner")
  const legacyPath = store.path(["receipts", `${hashObject("owner")}.json`])
  const legacy = readFileSync(legacyPath, "utf8")
  const prepared = store.prepareDelivery("owner", "request-one", "system", context)
  expect(new MemoryStore(path).delivery("owner")).toMatchObject({ id: prepared, value: {
    state: "prepared", request_correlation: "plugin_hook_only", request_id: "request-one",
    checkpoint: hashObject(checkpoint), task_epoch: checkpoint.task_epoch, context,
  } })
  const emitted = store.settleDelivery("owner", "request-one", prepared, { state: "emitted" })
  expect(new MemoryStore(path).delivery("owner")).toMatchObject({ id: emitted, value: { state: "emitted", prepared_ref: prepared } })
  expect(readFileSync(legacyPath, "utf8")).toBe(legacy)
  expect(memory.current("owner")).toEqual(checkpoint)
  expect(memory.status("owner")).toMatchObject({ delivery: { state: "emitted", current_checkpoint: true, host_confirmation: "NOT_ATTESTED" } })
  expect(() => DeliveryReceiptSchema.parse({ ...store.delivery("owner")!.value, state: "host_confirmed" })).toThrow()
  memory.beginTask("owner", "Changed task scope")
  expect(memory.status("owner")).toMatchObject({ delivery: { current_checkpoint: false } })
})

test("out of order completion cannot overwrite a newer request and terminal transitions are fenced", () => {
  const { store, context } = fixture()
  const first = store.prepareDelivery("owner", "first", "system", context)
  const second = store.prepareDelivery("owner", "second", "compaction", context)
  store.settleDelivery("owner", "first", first, { state: "emitted" })
  expect(store.delivery("owner")!.id).toBe(second)
  expect(store.delivery("owner", "first")!.value.state).toBe("emitted")
  store.settleDelivery("owner", "second", second, { state: "unknown", reason: "publication_conflict" })
  expect(store.delivery("owner")!.value).toMatchObject({ state: "unknown", reason: "publication_conflict" })
  expect(() => store.settleDelivery("owner", "second", second, { state: "emitted" })).toThrow("transition conflict")
  expect(() => store.prepareDelivery("owner", "second", "system", context)).toThrow("already exists")
  expect(store.delivery("other-owner", "first")).toBeNull()
  expect(() => store.settleDelivery("other-owner", "first", first, { state: "emitted" })).toThrow("transition conflict")
})

test("stale and observational packs cannot become request delivery preparations", () => {
  const { memory, store, context } = fixture()
  expect(() => store.prepareDelivery("owner", "observe", "system", { ...context, state: "observed" })).toThrow()
  expect(store.delivery("owner")).toBeNull()
  memory.beginTask("owner", "A different task")
  expect(() => store.prepareDelivery("owner", "stale", "system", context)).toThrow("checkpoint conflict")
  expect(store.delivery("owner")).toBeNull()
})

test("missing or tampered immutable preparation evidence fails visibly", () => {
  const { store, context } = fixture()
  const prepared = store.prepareDelivery("owner", "request", "system", context)
  store.settleDelivery("owner", "request", prepared, { state: "emitted" })
  const path = store.path(["deliveries", `${prepared}.json`])
  const original = readFileSync(path, "utf8")
  writeFileSync(path, JSON.stringify({ ...JSON.parse(original), task_epoch: 999 }))
  expect(() => store.delivery("owner")).toThrow("preparation mismatch")
  writeFileSync(path, original)
  expect(store.delivery("owner")!.value.state).toBe("emitted")
  unlinkSync(path)
  expect(() => store.delivery("owner")).toThrow()
})

test("hook publication records preparation first and emission only after the exact pack is appended", async () => {
  const { memory, store, context, text } = fixture()
  const delivery = new ContextDelivery(memory), target = ["host policy"]
  await delivery.replace("owner", "system", target, async (working, prepare) => {
    await prepare(context, text)
    expect(store.delivery("owner")!.value.state).toBe("prepared")
    expect(target).toEqual(["host policy"])
    working.push(text)
  })
  expect(target).toEqual(["host policy", text])
  expect(store.delivery("owner")!.value.state).toBe("emitted")
  expect(memory.status("owner")).toMatchObject({ delivery: { request_correlation: "plugin_hook_only", host_confirmation: "NOT_ATTESTED" } })
})

test("identical foreign text cannot prove that ALG emitted its prepared pack", async () => {
  const { memory, store, context, text } = fixture()
  const delivery = new ContextDelivery(memory), target = [text]
  await expect(delivery.replace("owner", "system", target, async (_working, prepare) => {
    await prepare(context, text)
  })).rejects.toThrow("not published intact")
  expect(target).toEqual([text])
  expect(store.delivery("owner")!.value).toMatchObject({ state: "unknown", reason: "hook_failed" })
})

test("checkpoint changes during preparation prevent stale publication", async () => {
  const { memory, store, context, text } = fixture()
  const target = ["host policy"]
  await expect(new ContextDelivery(memory).replace("owner", "system", target, async (working, prepare) => {
    await prepare(context, text)
    memory.beginTask("owner", "New task")
    working.push(text)
  })).rejects.toThrow("checkpoint changed")
  expect(target).toEqual(["host policy"])
  expect(store.delivery("owner")!.value.state).toBe("unknown")
})

test("revocation after preparation is rechecked even when the checkpoint revision is unchanged", async () => {
  const { path } = fixture()
  const directory = join(path, ".opencode", "skills", "revocable")
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "SKILL.md"), "---\nname: revocable\ndescription: Synthetic revocation fixture\n---\nVerify the current route.\n")
  const memory = new SessionMemoryRuntime(path, { mode: "assist" }, [".opencode/skills"], [])
  memory.bindSkill("owner", memory.index.search("revocable").skills[0]!.key)
  const store = memory.store, pack = memory.prepare("owner", { allowanceBytes: 4096 })
  const context = pack.receipt!, text = pack.text
  const checkpoint = memory.current("owner")
  const target = ["host policy"]
  await expect(new ContextDelivery(memory).replace("owner", "system", target, async (working, prepare) => {
    await prepare(context, text)
    store.revoke(checkpoint.skills[0]!.id)
    expect(memory.current("owner")).toEqual(checkpoint)
    working.push(text)
  })).rejects.toThrow("revoked")
  expect(target).toEqual(["host policy"])
  expect(store.delivery("owner")!.value.state).toBe("unknown")
})

test("swallowed preparation failures cannot emit unrecorded instructions", async () => {
  const { memory, store, context, text } = fixture()
  const target = ["host policy"]
  await expect(new ContextDelivery(memory).replace("owner", "system", target, async (working, prepare) => {
    try { await prepare(context, "not the prepared bytes") } catch { /* simulate hook fallback */ }
    working.push(text)
  })).rejects.toThrow("preparation unavailable")
  expect(target).toEqual(["host policy"])
  expect(store.delivery("owner")).toBeNull()
})

test("post-publication receipt failures remain unknown rather than pretending no text was emitted", async () => {
  const { memory, store, context, text } = fixture()
  const settle = store.settleDelivery.bind(store)
  store.settleDelivery = (owner, request, ref, outcome) => {
    if (outcome.state === "emitted") throw new Error("injected receipt write failure")
    return settle(owner, request, ref, outcome)
  }
  const target = ["host policy"]
  await expect(new ContextDelivery(memory).replace("owner", "system", target, async (working, prepare) => {
    await prepare(context, text); working.push(text)
  })).rejects.toThrow("receipt write failure")
  expect(target).toEqual(["host policy", text])
  expect(store.delivery("owner")!.value).toMatchObject({ state: "unknown", reason: "emission_unconfirmed" })
})

test("growing receipt history does not repeat full ancestry validation for every census leaf", () => {
  const { store, context } = fixture()
  for (let index = 0; index < 20; index++) {
    const request = `history-${index}`
    const prepared = store.prepareDelivery("owner", request, "system", context)
    store.settleDelivery("owner", request, prepared, { state: "emitted" })
  }
  let receiptPaths = 0
  const path = store.path.bind(store)
  store.path = (parts, createParents) => {
    if (parts[0] === "deliveries" && parts.length === 2) receiptPaths++
    return path(parts, createParents)
  }
  store.prepareDelivery("owner", "next", "system", context)
  expect(receiptPaths).toBe(1)
})

test("unexpected census entries fail without advancing delivery heads", () => {
  for (const kind of ["unsafe-name", "directory"] as const) {
    const { store, context } = fixture()
    const first = store.prepareDelivery("owner", "first", "system", context)
    const bucket = store.path(["deliveries"])
    if (kind === "unsafe-name") writeFileSync(join(bucket, "unsafe name.txt"), "not a receipt")
    else mkdirSync(join(bucket, "unexpected-directory"))
    expect(() => store.prepareDelivery("owner", "second", "system", context)).toThrow()
    expect(store.delivery("owner")!.id).toBe(first)
    expect(store.delivery("owner", "second")).toBeNull()
  }
})

test("final publication ceiling counts UTF-8 separators and diagnostics, not foreign text", async () => {
  const { memory } = fixture()
  const delivery = new ContextDelivery(memory), target = ["foreign".repeat(100)]
  await delivery.replace("owner", "system", target, async (working, _prepare, limit) => {
    limit(4)
    working.push("é", "x") // two bytes, newline, one byte
  })
  const before = [...target]
  await expect(delivery.replace("owner", "system", target, async (working, _prepare, limit) => {
    limit(3)
    working.push("é", "x")
  })).rejects.toThrow("needs_context")
  expect(target).toEqual(before)
  await expect(delivery.replace("owner", "system", target, async (working, _prepare, limit) => {
    limit(0)
    working.push("fallback unavailable")
  })).rejects.toThrow("needs_context")
  expect(target).toEqual(before)
  await delivery.replace("owner", "system", target, async (_working, _prepare, limit) => { limit(0) })
  expect(target).toEqual([before[0]!])
})

test("over-ceiling prepared context is not clipped or recorded as emitted", async () => {
  const { memory, store, context, text } = fixture()
  const target = ["host policy"]
  await expect(new ContextDelivery(memory).replace("owner", "compaction", target, async (working, prepare, limit) => {
    limit(Buffer.byteLength(text, "utf8"))
    await prepare(context, text)
    working.push(text, "extra diagnostic")
  })).rejects.toThrow("needs_context")
  expect(target).toEqual(["host policy"])
  expect(store.delivery("owner")!.value).toMatchObject({ state: "unknown", reason: "hook_failed" })
})

test("publication accounting runs only after successful replacement with exact contributed bytes", async () => {
  const { memory } = fixture()
  const delivery = new ContextDelivery(memory), target = ["foreign policy"]
  const counts: number[] = []
  await delivery.replace("owner", "system", target, async (working, _prepare, limit, onPublished) => {
    limit(4)
    onPublished((bytes) => { expect(target).toEqual(["foreign policy", "é", "x"]); counts.push(bytes) })
    working.push("é", "x")
    expect(counts).toEqual([])
  })
  expect(counts).toEqual([4])
  await expect(delivery.replace("owner", "system", target, async (working, _prepare, limit, onPublished) => {
    onPublished((bytes) => counts.push(bytes))
    limit(0); working.push("overflow")
  })).rejects.toThrow("needs_context")
  expect(counts).toEqual([4])
  await expect(delivery.replace("owner", "system", target, async (working, _prepare, _limit, onPublished) => {
    onPublished((bytes) => counts.push(bytes))
    target[0] = "concurrent foreign edit"
    working.push("replacement")
  })).rejects.toThrow("foreign context changed")
  expect(counts).toEqual([4])
})

test("receipt failure after publication still accounts for the actual text", async () => {
  const { memory, store, context, text } = fixture()
  const target: string[] = [], counts: number[] = []
  const settle = store.settleDelivery.bind(store)
  store.settleDelivery = (owner, request, ref, outcome) => {
    if (outcome.state === "emitted") throw new Error("injected settlement failure")
    return settle(owner, request, ref, outcome)
  }
  await expect(new ContextDelivery(memory).replace("owner", "system", target, async (working, prepare, _limit, onPublished) => {
    onPublished((bytes) => counts.push(bytes))
    await prepare(context, text)
    working.push(text)
  })).rejects.toThrow("settlement failure")
  expect(target).toEqual([text])
  expect(counts).toEqual([Buffer.byteLength(text, "utf8")])
  expect(store.delivery("owner")!.value.state).toBe("unknown")
})

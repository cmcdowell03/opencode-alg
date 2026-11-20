import { expect, test } from "bun:test"
import {
  calculateFromHistory, calculationPolicyDigest, calculationReceiptSchema,
  parseCalculationPolicy, validateCalculationReceipt, type CalculationPolicy,
} from "../src/calculation.ts"
import type { DeliveryHistory } from "../src/delivery.ts"

const recipe = {
  version: 1,
  owner: {
    tool: "lookup_records", source: "sample", pagesKey: "pages", sourceKey: "source",
    referenceKey: "ref", reportReferenceField: "sampleRef", rowsKey: "records", offsetKey: "offset",
    limitKey: "limit", exhaustedKey: "exhausted", cursorKey: "cursor", totalRowsKey: "total",
    limits: [2, 4, 6], rowKey: ["group", "id"], qualify: { field: "flag", equals: true, minMatches: 2 },
  },
  correction: {
    header: "Independent review", referenceKey: "ref", reportReferenceField: "reviewRef",
    rowsKey: "records", rowKey: ["bucket", "item"],
  },
  operations: {
    total: { kind: "count" },
    flagged: { kind: "filteredCount", where: { field: "flag", equals: true } },
    matched: { kind: "semijoinCount", where: { field: "verified", equals: true },
      ownerKey: ["group", "id"], correctionKey: ["bucket", "item"] },
  },
} satisfies CalculationPolicy
const fence = "\x60".repeat(3)
const skill = (json: string) => fence + "alg-calculation\n" + json + "\n" + fence
const content = skill(JSON.stringify(recipe))
const policy = parseCalculationPolicy(content)!
type Message = DeliveryHistory[number]
type User = Extract<Message, { type: "user" }>
type Assistant = Extract<Message, { type: "assistant" }>
type Tool = Extract<Assistant["content"][number], { type: "tool" }>
const time = { created: 1, completed: 2 }
const calculate = (policy: CalculationPolicy | undefined, history: DeliveryHistory) =>
  calculateFromHistory(policy, history, "owner")
const user = (id: string, text: string): User => ({ type: "user", id: id as User["id"], text, time })
const assistant = (id: string, content: Assistant["content"]): Assistant => ({
  type: "assistant", id: id as Assistant["id"], agent: "owner" as Assistant["agent"],
  model: { id: "synthetic", providerID: "synthetic" } as Assistant["model"], finish: "stop", time, content,
})
const rows = [
  { group: "A", id: 1, flag: true }, { group: "B", id: 1, flag: false },
  { group: "A", id: 2, flag: true }, { group: "A", id: 3, flag: false },
  { group: "A", id: 4, flag: true },
]
type Input = Extract<Tool["state"], { status: "completed" }>["input"]
function page(id: string, n: number, overrides: Record<string, unknown> = {},
  args: Input = { pages: [{ source: "sample", limit: n }] }, tool = recipe.owner.tool, executed = false) {
  return assistant(id, [{
    type: "tool", id: "call-" + id, name: tool, time, executed,
    state: { status: "completed", input: args, content: [{ type: "text", text: JSON.stringify({
      status: "ok", pages: [{
        source: "sample", ref: "sample-1", limit: n, offset: 0, total: rows.length,
        exhausted: n >= rows.length, records: rows.slice(0, n), ...overrides,
      }],
    }) }] },
  }])
}
const start = user("task", "Calculate the requested fields from the records.")
const before = [start, page("short", 2), page("selected", 4), page("long", 6)]
const reviews = [
  { bucket: "A", item: 1, verified: true }, { bucket: "B", item: 1, verified: true },
  { bucket: "A", item: 2, verified: true }, { bucket: "A", item: 3, verified: false },
  { bucket: "B", item: 2, verified: true }, { bucket: "A", item: "3", verified: true },
]
const audit = (records: unknown = reviews, ref = "review-1", id = "audit") =>
  user(id, recipe.correction.header + "\n" + JSON.stringify({ ref, records }))
const fake = assistant("report", [{ type: "text", text: JSON.stringify({
  total: 4, flagged: 2, matched: 4, sampleRef: "review-1", reviewRef: "sample-1",
}) }])

test("verifies base fields before the user correction and computes three matches despite a report of four", () => {
  const base = calculate(policy, [...before, fake])
  expect(base.status).toBe("incomplete")
  expect(base.values).toEqual({ total: 4, flagged: 2 })
  expect(base.sources.correction).toBeUndefined()
  expect(validateCalculationReceipt(base)).toBe(true)

  const full = calculate(policy, [...before, audit(), fake])
  expect(full.status).toBe("verified")
  expect(full.values).toEqual({ total: 4, flagged: 2, matched: 3 })
  expect(full.sources).toMatchObject({
    owner: { reference: "sample-1", reportReferenceField: "sampleRef", rowCount: 4,
      messageId: "selected", callId: "call-selected", limit: 4 },
    correction: { reference: "review-1", reportReferenceField: "reviewRef", rowCount: 6, messageId: "audit" },
  })
  expect(full.recipeSha256).toBe(calculationPolicyDigest(policy))
  expect(calculationReceiptSchema.parse(JSON.parse(JSON.stringify(full)))).toEqual(full)
  expect(calculate(policy, [...before, audit()])).toEqual(full)
  expect(validateCalculationReceipt({ ...full, values: { ...full.values, matched: 4 } })).toBe(false)
  expect(validateCalculationReceipt({
    ...full, sources: {
      owner: { ...full.sources.owner!, reportReferenceField: "reviewRef" },
      correction: { ...full.sources.correction!, reportReferenceField: "sampleRef" },
    },
  })).toBe(false)
})

test("zero is verified and distinct from an absent audit", () => {
  expect(calculate(policy, before).values.matched).toBeUndefined()
  const zero = calculate(policy, [...before, audit([])])
  expect(zero.status).toBe("verified")
  expect(zero.values.matched).toBe(0)
  expect(zero.sources.correction?.rowCount).toBe(0)
})

test("conflicting prefixes, references, duplicate owner keys and invalid page bounds fail closed", () => {
  for (const invalid of [
    page("changed-data", 6, { records: [{ ...rows[0], flag: false }, ...rows.slice(1)] }),
    page("changed-ref", 4, { ref: "different" }),
    page("duplicate-row", 4, { records: [rows[0], rows[0], ...rows.slice(2, 4)] }),
    page("wrong-limit", 4, { limit: 2 }),
    page("wrong-offset", 4, { offset: 1 }),
    page("false-exhaustion", 4, { exhausted: true }),
    page("wrong-source", 4, { source: "different" }),
    page("unexpected-limit", 5),
  ]) {
    const result = calculate(policy, [...before, invalid, audit()])
    expect(result.status).toBe("incomplete")
    expect(result.values).toEqual({})
    expect(validateCalculationReceipt(result)).toBe(true)
  }
})

test("corrupt, ambiguous and synthetic corrections cannot supply a join", () => {
  const wrongHeader = user("wrong-header", " " + audit().text)
  const duplicate = audit([...reviews, reviews[0]])
  const missing = audit([{ bucket: "A", verified: true }])
  const missingFilter = audit([{ bucket: "A", item: 1 }])
  const duplicateField = user("dup-field", 'Independent review\n{"ref":"review-1","records":[],"reco\\u0072ds":[]}')
  const copy = assistant("substitute", [{ type: "text", text: audit().text }])
  for (const messages of [[duplicate], [missing], [missingFilter], [duplicateField], [copy],
    [audit(), audit([], "review-1", "conflict")], [audit(reviews, "sample-1")], [wrongHeader]]) {
    const result = calculate(policy, [...before, ...messages])
    expect(result.status).toBe("incomplete")
    expect(result.values.matched).toBeUndefined()
    expect(result.sources.correction).toBeUndefined()
  }
})

test("requires actual matching offset-zero calls and does not use evidence from a previous task or compaction", () => {
  const unrelated = user("new-task", "Summarize another set of records.")
  const resume = user("resume", "Continue.")
  const compact: Message = { type: "compaction", id: "compacted" as Message["id"],
    status: "completed", reason: "manual", summary: audit().text, time }
  for (const history of [
    [...before, unrelated], [...before, audit(), unrelated], [...before, audit(), compact, resume],
    [start, page("cursor", 4, {}, { pages: [{ source: "sample", cursor: "later", limit: 4 }] })],
    [start, page("tool", 4, {}, undefined, "other_lookup")],
    [start, page("provider", 4, {}, undefined, recipe.owner.tool, true)],
    [start, page("source", 4, {}, { pages: [{ source: "other", limit: 4 }] })],
    [start, fake, audit()],
  ]) {
    const result = calculate(policy, history)
    expect(result.status).toBe("incomplete")
    expect(result.values).toEqual({})
  }
  expect(calculate(policy, [...before, audit(), resume]).status).toBe("verified")
  expect(calculate(policy, [start, audit(), ...before.slice(1)]).values.matched).toBeUndefined()
})

test("parses only one bounded strict recipe and canonicalizes object member order", () => {
  const reordered = parseCalculationPolicy(skill(JSON.stringify({
    correction: recipe.correction, operations: recipe.operations, owner: recipe.owner, version: recipe.version,
  })))
  expect(calculationPolicyDigest(reordered!)).toBe(calculationPolicyDigest(policy))
  const changed = { ...recipe, owner: { ...recipe.owner, source: "another" } }
  expect(calculationPolicyDigest(changed)).not.toBe(calculationPolicyDigest(policy))
  for (const invalid of [content + "\n" + content, content.slice(0, -3), "# No recipe",
    fence + "markdown\n" + content + "\n" + fence,
    skill(JSON.stringify({ ...recipe, extra: 1 })),
    skill(JSON.stringify(recipe).replace('"version":1', '"version":2,"versi\\u006fn":1')),
    skill(" ".repeat(16_385) + JSON.stringify(recipe)),
  ]) expect(parseCalculationPolicy(invalid)).toBeUndefined()
  expect(validateCalculationReceipt(calculate(undefined, before))).toBe(true)
})


test("checks saved page bounds against the native request, total and next cursor", () => {
  const { exhaustedKey: _echo, ...owner } = recipe.owner
  const savedPolicy = parseCalculationPolicy(skill(JSON.stringify({
    ...recipe, owner: { ...owner, nextCursorKey: "nextCursor" },
  })))!
  const raw = (more: Record<string, unknown> = {}) =>
    page("saved", 4, { limit: undefined, exhausted: undefined, nextCursor: "remaining", ...more })
  const small = page("saved-small", 2, { limit: undefined, exhausted: undefined, nextCursor: "more" })
  const observed = calculate(savedPolicy, [start, small, raw(), audit()])
  expect(observed.status).toBe("verified")
  expect(observed.values).toEqual({ total: 4, flagged: 2, matched: 3 })
  expect(calculate(policy, [start, raw(), audit()]).values).toEqual({})
  for (const bad of [
    { total: undefined }, { total: 3 }, { nextCursor: undefined }, { nextCursor: null },
    { limit: 5 }, { exhausted: true },
  ]) expect(calculate(savedPolicy, [start, small, raw(bad), audit()]).values).toEqual({})
  const eof = page("eof", 6, { limit: undefined, exhausted: undefined, nextCursor: null })
  const eofPolicy = { ...savedPolicy, owner: { ...savedPolicy.owner, qualify: { ...savedPolicy.owner.qualify, minMatches: 3 } } }
  expect(calculate(eofPolicy, [start, small, raw(), eof, audit()]).values.total).toBe(5)
  expect(calculate(savedPolicy, [start, raw(), audit()]).values).toEqual({})
})


test("requires every source page to come from the bound owner agent", () => {
  const switched: Assistant = { ...page("switched", 4), agent: "other" as Assistant["agent"] }
  expect(calculate(policy, [start, page("small", 2), switched, audit()]).values).toEqual({})
  expect(calculateFromHistory(policy, before, "other").values).toEqual({})
  expect(calculateFromHistory(policy, before, "").values).toEqual({})
  expect(calculate(policy, [...before, switched, audit()]).status).toBe("verified")
})

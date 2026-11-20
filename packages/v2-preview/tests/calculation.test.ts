import { expect, test } from "bun:test"
import {
  calculateFromHistory, calculationCheckpointSchema, calculationPolicyDigest, calculationReceiptSchema,
  inspectCalculationProgress, parseCalculationPolicy, validateCalculationReceipt,
  type CalculationCheckpoint, type CalculationPolicy,
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

test("the legacy whole-history entry point tolerates out-of-order prefixes and per-page references", () => {
  const result = calculate(policy, [start, page("later", 4, { ref: "sample-4" }),
    page("first", 2, { ref: "sample-2" }), audit()])
  expect(result).toMatchObject({
    status: "verified", values: { total: 4, flagged: 2, matched: 3 },
    sources: { owner: { reference: "sample-4" } },
  })
})

const inspect = (history: DeliveryHistory, checkpoint?: CalculationCheckpoint | null, advertised = policy) =>
  inspectCalculationProgress(advertised, history, "owner", checkpoint)
const reload = (checkpoint: CalculationCheckpoint | null) =>
  calculationCheckpointSchema.parse(JSON.parse(JSON.stringify(checkpoint)))
const withThreshold = (minMatches: number): CalculationPolicy => ({
  ...policy, owner: { ...policy.owner, qualify: { ...policy.owner.qualify, minMatches } },
})
const compact: Message = { type: "compaction", id: "compacted" as Message["id"],
  status: "completed", reason: "manual", summary: audit().text, time }
const resume = user("resume", "Continue.")
const firstPage = page("short", 2)
const laterPage = page("selected", 4)

test("only real recipe work starts obligations, and the ladder stops at the first valid cohort", () => {
  expect(inspect([start, fake, user("header", recipe.correction.header)], null)).toMatchObject({
    obligation: { kind: "unavailable" }, checkpoint: null, receipt: { values: {} },
  })
  expect(inspect([start, page("cursor", 2, {}, { pages: [{ source: "sample", limit: 2, cursor: "opaque" }] })]))
    .toMatchObject({ obligation: { kind: "unavailable" }, checkpoint: null })
  expect(inspect([start, firstPage], undefined, withThreshold(1))).toMatchObject({
    obligation: { kind: "need_audit", reason: "missing", rowCount: 2, matches: 1, threshold: 1 },
    receipt: { values: { total: 2, flagged: 1 } },
  })
  const partial = inspect([start, firstPage])
  expect(partial.obligation).toEqual({ kind: "need_page", source: "sample", nextLimit: 4, rowCount: 2, matches: 1, threshold: 2 })
  expect(partial.receipt.values).toEqual({})
  expect(inspect(before)).toMatchObject({
    obligation: { kind: "need_audit", rowCount: 4, matches: 2, threshold: 2 },
    receipt: { sources: { owner: { limit: 4, messageId: "selected" } } },
  })
  const exhausted = inspect(before, null, withThreshold(4))
  expect(exhausted).toMatchObject({
    obligation: { kind: "exhausted", rowCount: 5, matches: 3, threshold: 4 }, receipt: { values: {} },
  })
  expect(inspect([], reload(exhausted.checkpoint), withThreshold(4))).toEqual(exhausted)
  const capped = { ...withThreshold(4), owner: { ...withThreshold(4).owner, limits: [2, 4] } }
  expect(inspect([start, firstPage, laterPage], null, capped).obligation.kind).toBe("exhausted")
  const countsOnly: CalculationPolicy = { ...policy, operations: { total: { kind: "count" } } }
  expect(inspect(before, null, countsOnly)).toMatchObject({
    obligation: { kind: "verified" }, receipt: { status: "verified", values: { total: 4 } },
  })
})

test("resumes the next limit using only suffix messages and preserves original provenance on replay", () => {
  const partial = inspect([start, firstPage])
  const saved = reload(partial.checkpoint)
  const waiting = inspect([compact, resume, laterPage], saved)
  expect(waiting).toMatchObject({
    obligation: { kind: "need_audit", reason: "missing" },
    receipt: { values: { total: 4, flagged: 2 }, sources: { owner: { messageId: "selected", callId: "call-selected" } } },
  })
  expect(inspect([start, firstPage, compact, resume, laterPage], saved)).toEqual(waiting)
  const repeated = inspect([laterPage, page("fresh-replay", 4), audit()], reload(waiting.checkpoint))
  expect(repeated.obligation.kind).toBe("verified")
  expect(repeated.receipt).toEqual(calculate(policy, [...before, audit()]))
  expect(inspect([compact, resume, audit()], reload(repeated.checkpoint))).toEqual(repeated)
  expect(inspect([audit([])], reload(repeated.checkpoint)).obligation.kind).toBe("conflict")

  const firstWithSecret = page("short", 2, { records: [{ ...rows[0], privateComment: "row secret" }, rows[1]] })
  const checkpoint = JSON.stringify(inspect([start, firstWithSecret]).checkpoint)
  expect(checkpoint).not.toContain("row secret")
  expect(checkpoint).not.toContain("privateComment")
  expect(checkpoint).not.toContain('"records"')
  const waitingJson = JSON.stringify(waiting.checkpoint)
  expect(waitingJson).not.toContain('"A"')
  expect(waitingJson).not.toContain('"group"')
  expect(repeated.checkpoint?.selected?.keys).toBeUndefined()
})

test("a cut before the first lookup preserves a silent task anchor for the post-cut first page", () => {
  const unrelated = page("ordinary-call", 2, {}, undefined, "other_lookup")
  expect(inspect([start, unrelated])).toMatchObject({ checkpoint: null, obligation: { kind: "unavailable" } })
  expect(inspectCalculationProgress(policy, [resume], "owner", null, true).checkpoint).toBeNull()
  const cut = inspectCalculationProgress(policy, [start, unrelated], "owner", null, true)
  expect(cut).toMatchObject({
    obligation: { kind: "unavailable" }, receipt: { status: "incomplete", values: {}, sources: {} },
    checkpoint: { dormant: true, task: { id: start.id }, messages: {}, calls: [], pages: [] },
  })
  const dormant = reload(cut.checkpoint)
  expect(dormant.task.fingerprint).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(dormant)).not.toContain(start.text)
  expect(inspect([compact, resume, unrelated], dormant)).toMatchObject({
    checkpoint: null, obligation: { kind: "unavailable" }, receipt: { values: {} },
  })
  expect(inspectCalculationProgress(policy, [compact, resume], "owner", dormant, true)).toEqual(cut)
  const fresh = user("different-task", "Summarize the unrelated notes.")
  expect(inspect([fresh, unrelated], dormant).obligation).toEqual({ kind: "unavailable" })
  expect(inspectCalculationProgress(policy, [fresh], "owner", dormant, true).checkpoint?.task.id).toBe(fresh.id)
  const first = inspect([compact, resume, firstPage], dormant)
  expect(first.obligation).toMatchObject({ kind: "need_page", nextLimit: 4 })
  expect(first.checkpoint?.dormant).toBeUndefined()
  expect(first).toEqual(inspect([start, firstPage]))
})

test("rejects mutated prefixes, changed snapshots and reused native call identities across restart", () => {
  const saved = reload(inspect([start, firstPage]).checkpoint)
  const reusedCall = { ...laterPage, content: [{ ...laterPage.content[0]!, id: "call-short" }] } as Assistant
  for (const conflicting of [
    page("short", 2, { records: [{ ...rows[0], id: 11 }, rows[1]] }),
    page("changed-prefix", 4, { records: [{ ...rows[0], note: "changed" }, ...rows.slice(1, 4)] }),
    page("changed-snapshot", 4, { ref: "sample-2" }),
    page("changed-total", 4, { total: 6 }),
    page("invalid-echo", 4, { limit: 2 }),
    reusedCall,
  ]) {
    const rejected = inspect([conflicting], saved)
    expect(rejected.obligation.kind).toBe("conflict")
    expect(rejected.receipt.values).toEqual({})
    expect(inspect([laterPage], reload(rejected.checkpoint))).toEqual(rejected)
  }
  expect(inspect([start, laterPage]).obligation).toEqual({ kind: "conflict", reason: "owner" })
  expect(inspect([page("surplus", 6, { ref: "sample-2" })], reload(inspect(before).checkpoint))
    .obligation.kind).toBe("conflict")
})

test("a malformed first native owner response durably conflicts while unrelated requests stay silent", () => {
  const malformed = { records: "invalid evidence" }
  for (const unrelated of [
    page("wrong-tool", 2, malformed, undefined, "other_lookup"),
    page("wrong-source", 2, malformed, { pages: [{ source: "other", limit: 2 }] }),
    page("wrong-offset", 2, malformed, { pages: [{ source: "sample", limit: 2, offset: 1 }] }),
    page("provider-executed", 2, malformed, undefined, recipe.owner.tool, true),
  ]) expect(inspect([start, unrelated])).toMatchObject({ obligation: { kind: "unavailable" }, checkpoint: null })

  const blocked = inspect([start, page("malformed", 2, malformed)])
  expect(blocked).toMatchObject({
    obligation: { kind: "conflict", reason: "owner" }, receipt: { status: "incomplete", values: {} },
    checkpoint: { conflict: "owner", pages: [] },
  })
  expect(inspect([compact, resume, firstPage, laterPage, audit()], reload(blocked.checkpoint))).toEqual(blocked)
  expect(inspect([user("reopened", "Try the same recipe on a new snapshot."), firstPage], reload(blocked.checkpoint))
    .obligation).toMatchObject({ kind: "need_page", nextLimit: 4 })
})

test("an early handoff requires exact snapshot and coverage or a freshly validated audit", () => {
  const waiting = inspect(before)
  if (waiting.obligation.kind !== "need_audit") throw new Error("expected a selected cohort")
  const coverage = waiting.obligation.ownerCoverage
  const bound = (id: string, ownerCoverage: typeof coverage, records = reviews) =>
    user(id, recipe.correction.header + "\n" + JSON.stringify({ ref: "review-1", records, ownerCoverage }))
  const early = inspect([start, firstPage, audit()])
  expect(early.obligation.kind).toBe("need_page")
  const tooEarly = inspect([compact, laterPage, audit()], reload(early.checkpoint))
  expect(tooEarly).toMatchObject({ obligation: { kind: "need_audit", reason: "revalidation" },
    receipt: { status: "incomplete", values: { total: 4, flagged: 2 } } })
  expect(tooEarly.receipt.sources.correction).toBeUndefined()
  expect(inspect([audit(reviews, "review-1", "new-validation")], reload(tooEarly.checkpoint)).receipt.values.matched).toBe(3)

  const attached = inspect([start, bound("early-attested", coverage), firstPage])
  const matched = inspect([compact, laterPage], reload(attached.checkpoint))
  expect(matched).toMatchObject({ obligation: { kind: "verified" },
    receipt: { values: { matched: 3 }, sources: { correction: { messageId: "early-attested" } } } })
  expect(matched.checkpoint?.earlyAudit).toBeUndefined()
  for (const different of [{ ...coverage, reference: "earlier-snapshot" }, { ...coverage, rowCount: 2 },
    { ...coverage, rowsSha256: "0".repeat(64) }]) {
    const previous = inspect([start, firstPage, bound("old-audit", different)])
    const rejected = inspect([laterPage], reload(previous.checkpoint))
    expect(rejected.obligation).toMatchObject({ kind: "need_audit", reason: "revalidation", ownerCoverage: coverage })
    expect(inspect([bound("later-stale-audit", different)], reload(rejected.checkpoint)).obligation)
      .toMatchObject({ kind: "need_audit", reason: "revalidation" })
  }
  const contradictory = inspect([start, firstPage, bound("early-attested", coverage), bound("conflict", coverage, [])])
  expect(inspect([laterPage], reload(contradictory.checkpoint)).obligation)
    .toMatchObject({ kind: "need_audit", reason: "revalidation" })
})

test("fresh task evidence can yield different counts and cannot inherit the previous problem's progress", () => {
  const old = inspect([...before, audit()])
  const startNew = user("genuinely-new", "Inspect a new snapshot of parts.")
  expect(inspect([startNew, fake], reload(old.checkpoint))).toMatchObject({
    checkpoint: null, obligation: { kind: "unavailable" }, receipt: { values: {} },
  })
  const changed = rows.map(row => ({ ...row, group: "new-" + row.group }))
  const newFirst = page("new-first", 2, { ref: "sample-2", records: changed.slice(0, 2) })
  const newLater = page("new-later", 4, { ref: "sample-2", records: changed.slice(0, 4) })
  const current = inspect([startNew, newFirst], reload(old.checkpoint))
  const newAudit = audit(reviews, "review-2", "new-audit")
  const next = inspect([compact, newLater, newAudit], reload(current.checkpoint))
  expect(next).toMatchObject({
    obligation: { kind: "verified" },
    receipt: { values: { total: 4, flagged: 2, matched: 0 }, sources: { owner: { reference: "sample-2" } } },
  })
  expect(next.receipt.proofSha256).not.toBe(old.receipt.proofSha256)
  expect(inspect([user("task", "Different text under old task ID")], reload(old.checkpoint)).obligation)
    .toEqual({ kind: "conflict", reason: "history" })
})

test("strict checkpoint loading rejects oversize, unknown, tampered and misbound evidence", () => {
  const partial = reload(inspect([start, firstPage]).checkpoint)
  const waiting = reload(inspect(before).checkpoint)
  for (const invalid of [
    { ...partial, rawRows: rows },
    { ...partial, pages: [{ ...partial.pages[0]!, rawRows: rows }] },
    { ...partial, version: 2 },
    { ...partial, calls: [...partial.calls, ...partial.calls] },
    { ...partial, calls: Array.from({ length: 2049 }, (_, i) => i.toString(16).padStart(64, "0")) },
    { ...partial, pages: [{ ...partial.pages[0]!, matches: 2 }] },
    { ...waiting, selected: { ...waiting.selected, keys: { matched: ["raw-private-data"] } } },
  ]) {
    expect(calculationCheckpointSchema.safeParse(invalid).success).toBe(false)
    expect(inspect([], invalid as CalculationCheckpoint)).toMatchObject({
      obligation: { kind: "conflict", reason: "checkpoint" }, checkpoint: null,
    })
  }
  expect(inspect([], partial, withThreshold(3)).obligation).toEqual({ kind: "conflict", reason: "checkpoint" })
  expect(inspectCalculationProgress(policy, [], "other", partial).obligation)
    .toEqual({ kind: "conflict", reason: "checkpoint" })
})

test("validates the optional single approved decision rule against a named operation", () => {
  const decisionRules = {
    field: "matched", minimum: 1,
    whenMet: { nextAction: "replay-clock-join", prerequisite: "verified-clock-audit" },
    otherwise: { nextAction: "attribute-as-recorded", prerequisite: "independent-clock-audit" },
  }
  const approved = parseCalculationPolicy(skill(JSON.stringify({ ...recipe, decisionRules })))!
  expect(approved.decisionRules).toEqual(decisionRules)
  expect(calculationPolicyDigest(approved)).not.toBe(calculationPolicyDigest(policy))
  for (const invalid of [[decisionRules], { ...decisionRules, field: "missing" }, { ...decisionRules, minimum: -1 },
    { ...decisionRules, minimum: 1.5 }, { ...decisionRules, minimum: Number.MAX_SAFE_INTEGER + 1 },
    { ...decisionRules, whenMet: { ...decisionRules.whenMet, extra: true } }]) {
    expect(parseCalculationPolicy(skill(JSON.stringify({ ...recipe, decisionRules: invalid })))).toBeUndefined()
  }
})

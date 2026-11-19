import { expect, test } from "bun:test"
import { deriveAnswer, evidenceRef, generateFabEvidence, researchCase, type CaseVariant, type FabEvidence, type Source } from "../benchmark/case.ts"
import { hasScopedEvidenceTools } from "../benchmark/host.ts"
import { scriptedTurn } from "../benchmark/script.ts"
import { isWrongRootReturn, scorePair, scoreRun, type RunObservation } from "../benchmark/score.ts"
import { createWorkbench, startWorkbench } from "../benchmark/workbench.ts"

const publicSources = ["inspection", "route", "dispatch"] as const
const privateSources = ["clock-audit", "monitor"] as const

function collect(call: ReturnType<typeof createWorkbench>["call"], sources: readonly Source[], rows: FabEvidence) {
  const refs = new Map<Source, string>()
  let pages: { source: Source; cursor?: string }[] = sources.map(source => ({ source }))
  while (pages.length) {
    const result = call("lookup_pages", { pages })
    if (result.status !== "ok" || result.op !== "lookup") throw new Error("Missing workbench page")
    pages = []
    for (const page of result.pages) {
      expect(rows[page.source]).toHaveLength(page.offset)
      Object.assign(rows, { [page.source]: [...rows[page.source], ...page.rows] })
      refs.set(page.source, page.evidenceRef)
      if (page.nextCursor) pages.push({ source: page.source, cursor: page.nextCursor })
    }
  }
  return refs
}

function observe(variant: CaseVariant = "positive") {
  const service = createWorkbench({ variant })
  const rows: FabEvidence = { inspection: [], route: [], dispatch: [], "clock-audit": [], monitor: [] }
  const rootRefs = collect(service.call, publicSources, rows)
  const initial = deriveAnswer(rows, "initial", [...rootRefs.values()])
  const checkerRefs = collect(service.checkerCall, privateSources, rows)
  const revised = deriveAnswer(rows, "revised", [...rootRefs.values(), ...checkerRefs.values()])
  const input: RunObservation = {
    variant, initialAnswer: JSON.stringify(initial), finalAnswer: JSON.stringify(revised),
    checkerAnswer: JSON.stringify({ auditRows: rows["clock-audit"], evidenceRef: checkerRefs.get("clock-audit"),
      monitorRows: rows.monitor, monitorEvidenceRef: checkerRefs.get("monitor") }),
    skillActions: 2, wrongRootReturns: 0, crossSessionReads: 0, tokens: 900, elapsedMs: 250, workbench: service.snapshot(),
  }
  return { initial, revised, input, service }
}

test("the neutral prompt leaves discovery and procedure to the shared skill", () => {
  for (const prompt of [researchCase.prompt, researchCase.checkerPrompt, researchCase.revisionPrompt]) {
    expect(prompt).not.toContain(researchCase.skillName)
    expect(prompt).not.toMatch(/ETCH_MAIN|EDGE_BIAS_OFFSET|recorded minute|paired sign test/)
  }
  expect(researchCase.skillContent).toContain("lot and wafer strictly")
})

test("actual joined records refute the dispatch screen and audit reverses the qualified association", () => {
  const { initial, revised, input } = observe()
  expect(initial).toMatchObject({
    inspected: 36, defects: 15, matched: 35, unmatched: 1,
    dispatchChamber: "ETCH-04", qualifiedChamber: "ETCH-07",
    causalStatus: "not_identifiable", confirmedRoot: null, monitorStats: [],
    dispatchStats: [{ chamber: "ETCH-04", inspected: 24, defects: 15 }, { chamber: "ETCH-08", inspected: 12, defects: 0 }],
    qualifiedStats: [{ chamber: "ETCH-02", inspected: 12, defects: 5 }, { chamber: "ETCH-07", inspected: 12, defects: 8 },
      { chamber: "ETCH-09", inspected: 11, defects: 2 }],
  })
  expect(revised).toMatchObject({
    dispatchChamber: "ETCH-04", qualifiedChamber: "ETCH-02", auditRowsApplied: 6,
    qualifiedStats: [{ chamber: "ETCH-02", inspected: 14, defects: 9 }, { chamber: "ETCH-07", inspected: 10, defects: 4 },
      { chamber: "ETCH-09", inspected: 11, defects: 2 }],
    causalStatus: "confirmed_in_fixture", confirmedRoot: { chamber: "ETCH-02", factor: "EDGE_BIAS_OFFSET" },
    monitorStats: [{ reductions: 6, increases: 0, ties: 0, pValue: 1 / 64 },
      { reductions: 1, increases: 2, ties: 3, pValue: 7 / 8 }],
  })
  expect(scoreRun(input)).toMatchObject({ status: "pass", measurement: "valid", science: "pass" })
  expect(scoreRun({ ...input, skillActions: 0 })).toMatchObject({
    measurement: "valid", science: "pass", checks: { skill: "fail" },
  })
  expect(isWrongRootReturn(JSON.stringify(initial))).toBe(true)
  expect(isWrongRootReturn(JSON.stringify(revised))).toBe(false)
  expect(isWrongRootReturn(JSON.stringify({
    ...revised, confirmedRoot: { chamber: revised.dispatchChamber, factor: "unverified" },
  }))).toBe(true)
})

test("the held-out plausible association fails the paired intervention gate", () => {
  const positive = observe()
  const { initial, revised, input } = observe("negative")
  expect(initial.qualifiedStats).toEqual(positive.initial.qualifiedStats)
  expect(revised).toMatchObject({
    qualifiedChamber: positive.revised.qualifiedChamber, confirmedRoot: null, causalStatus: "not_identifiable",
  })
  expect(revised.monitorStats[0]).toMatchObject({ pairs: 6, reductions: 5, increases: 0, ties: 1, pValue: 1 / 32 })
  expect(scoreRun(input).checks.revisedRootCause).toBe("pass")
  const overclaim = { ...revised, causalStatus: "confirmed_in_fixture", confirmedRoot: positive.revised.confirmedRoot }
  expect(scoreRun({ ...input, finalAnswer: JSON.stringify(overclaim) }).checks.revisedRootCause).toBe("fail")
  expect(scorePair(input, positive.input)).toMatchObject({ comparable: false, caseId: null, algMinusBuild: null })
})

test("a monitor pair with mismatched process controls cannot support a causal claim", () => {
  const service = createWorkbench()
  const rows: FabEvidence = { inspection: [], route: [], dispatch: [], "clock-audit": [], monitor: [] }
  const refs = [...collect(service.call, publicSources, rows).values(), ...collect(service.checkerCall, privateSources, rows).values()]
  rows.monitor[0]!.controls = "changed recipe settings"
  const assessment = deriveAnswer(rows, "revised", refs)
  expect(assessment).toMatchObject({ causalStatus: "not_identifiable", confirmedRoot: null })
  expect(assessment.monitorStats[0]).toMatchObject({ pairs: 5, reductions: 5 })
})

test("bounds batches, isolates private pages and counts admitted, cached and denied calls", () => {
  const service = createWorkbench({ maxAcceptedQueries: 3 })
  expect(service.call("map_sources", {})).toMatchObject({ status: "ok", sources: publicSources.map(source => ({ source })) })
  expect(service.call("lookup_pages", { pages: [{ source: "monitor" }] })).toEqual({ status: "unavailable", reason: "source_unavailable" })
  expect(service.call("lookup_pages", { pages: [{ source: "route", limit: 25 }] })).toMatchObject({ reason: "invalid_request" })
  const batch = { pages: [{ source: "inspection" }, { source: "dispatch" }] }
  const first = service.call("lookup_pages", batch)
  expect(service.call("lookup_pages", { ...batch, pages: [...batch.pages].reverse() })).toEqual(first)
  expect(service.call("lookup_pages", { pages: [{ source: "inspection" }] })).toMatchObject({ status: "ok" })
  expect(service.checkerCall("lookup_pages", { pages: [{ source: "clock-audit" }] })).toMatchObject({ status: "ok" })
  expect(service.call("lookup_pages", { pages: [{ source: "route" }] })).toMatchObject({ reason: "budget_exhausted" })
  const snapshot = service.snapshot()
  expect(snapshot).toMatchObject({ calls: 8, acceptedQueries: 3, deniedQueries: 3 })
  expect(scoreRun({ initialAnswer: null, finalAnswer: null, skillActions: null, wrongRootReturns: null,
    tokens: null, elapsedMs: null, workbench: snapshot }).metrics).toMatchObject({ cachedLookups: 1, duplicateAcceptedQueries: 1 })
})

test("fairly observed failures remain comparable and missing evidence never becomes zero", () => {
  const { initial, input } = observe()
  const build = { ...input, finalAnswer: JSON.stringify(initial), skillActions: 0, wrongRootReturns: 1, crossSessionReads: 3 }
  const pair = scorePair(build, input)
  expect(pair).toMatchObject({ comparable: true, build: { measurement: "valid", science: "fail" },
    alg: { science: "pass" }, algMinusBuild: { wrongRootReturns: -1, crossSessionReads: -3, tokens: 0 } })
  expect(scorePair({ ...build, tokens: null }, input)).toMatchObject({
    comparable: false, build: { measurement: "unavailable", metrics: { tokens: null } }, algMinusBuild: { tokens: null },
  })
  expect(scoreRun({ ...input, workbench: { ...input.workbench!, acceptedQueries: 99 } }).measurement).toBe("invalid")
  expect(scorePair({ ...input, workbench: { ...input.workbench!, maxAcceptedQueries: 17 } }, input).comparable).toBe(false)
  expect(scorePair({ ...input, crossSessionReads: null }, input).comparable).toBe(false)
  const honest = scoreRun({ ...input, finalAnswer: JSON.stringify({ status: "unavailable" }) })
  expect(honest).toMatchObject({ measurement: "valid", checks: { revised: "reported_unavailable" }, science: "unavailable" })
  expect(scoreRun({ ...input, checkerAnswer: null, workbench: null })).toMatchObject({
    measurement: "unavailable", metrics: { acceptedQueries: null }, checks: { checker: "unavailable" },
  })
})

test("scripted turns use the split tools for their own role", () => {
  const service = createWorkbench()
  for (const { server, prompt, call, sources } of [
    { server: "evidence", prompt: researchCase.prompt, call: service.call, sources: publicSources },
    { server: "audit", prompt: researchCase.checkerPrompt, call: service.checkerCall, sources: privateSources },
  ]) {
    const tools: [string, string] = [server + "_map_sources", server + "_lookup_pages"]
    const user = { role: "user", content: prompt }
    expect(scriptedTurn({ messages: [user], tools, summary: false })).toEqual({ tool: tools[0], args: {} })
    const map = { role: "tool", content: JSON.stringify(call("map_sources", {})) }
    expect(scriptedTurn({ messages: [user, map], tools, summary: false })).toEqual({
      tool: tools[1], args: { pages: sources.map(source => ({ source, limit: 24 })) },
    })
  }
})

test("parity requires both advertised tools and rejects cross-scope exposure", () => {
  const root = { tools: ["skill", "evidence_map_sources", "evidence_lookup_pages"] }
  const checker = { tools: ["audit_map_sources", "audit_lookup_pages"] }
  expect(hasScopedEvidenceTools([root], [checker])).toBe(true)
  expect(hasScopedEvidenceTools([], [checker])).toBe(false)
  expect(hasScopedEvidenceTools([root], [{ tools: ["audit_lookup_pages"] }])).toBe(false)
  expect(hasScopedEvidenceTools([root, { tools: [] }], [checker])).toBe(false)
  expect(hasScopedEvidenceTools([root], [checker, { tools: [...checker.tools, "evidence_map_sources"] }])).toBe(false)
  expect(hasScopedEvidenceTools([{ tools: [...root.tools, "audit_lookup_pages"] }], [checker])).toBe(false)
})

async function rpc(endpoint: string, method: string, params: unknown = {}) {
  const response = await fetch(endpoint, { method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })
  expect(response.status).toBe(200)
  return (await response.json()) as { result?: { tools?: { name: string; inputSchema: unknown }[]; content?: { text: string }[] }; error?: unknown }
}

async function callTool(endpoint: string, name: string, args?: object) {
  const { result, error } = await rpc(endpoint, "tools/call", { name, arguments: args })
  expect(error).toBeUndefined()
  return JSON.parse(result!.content![0]!.text)
}

test("MCP advertises the same closed schemas to root and checker, with scoped field information", async () => {
  const workbench = createWorkbench({ maxAcceptedQueries: 0 })
  const service = startWorkbench(workbench)
  try {
    const root = await rpc(service.endpoint, "tools/list")
    expect(root).toEqual(await rpc(service.checkerEndpoint, "tools/list"))
    expect(root.result!.tools!.map(({ name }) => name)).toEqual(["map_sources", "lookup_pages"])
    expect(root.result!.tools![0]!.inputSchema).toEqual({
      type: "object", properties: {}, required: [], additionalProperties: false,
    })
    expect(root.result!.tools![1]!.inputSchema).toEqual({
      type: "object", required: ["pages"], additionalProperties: false,
      properties: { pages: { type: "array", minItems: 1, maxItems: 4, items: {
        type: "object", required: ["source"], additionalProperties: false, properties: {
          source: { type: "string", description: expect.any(String) },
          limit: { type: ["integer", "null"], minimum: 1, maximum: 24, description: expect.any(String) },
          cursor: { type: ["string", "null"], description: expect.any(String) },
        },
      } } },
    })
    const evidence = generateFabEvidence()
    for (const [endpoint, sources] of [
      [service.endpoint, publicSources],
      [service.checkerEndpoint, [...publicSources, ...privateSources]],
    ] as const) {
      expect(await callTool(endpoint, "map_sources", {})).toEqual({
        status: "ok", op: "map", caseId: researchCase.id, maxPageRows: 24, maxPages: 4,
        sources: sources.map(source => ({ source, evidenceRef: evidenceRef(source), totalRows: evidence[source].length,
          fields: Object.keys(evidence[source][0]!),
        })),
      })
    }
    const replay = await callTool(service.endpoint, "map_sources", {})
    expect(await callTool(service.endpoint, "map_sources")).toEqual(replay)
    expect(workbench.snapshot()).toMatchObject({ calls: 4, acceptedQueries: 0, deniedQueries: 0,
      receipts: [
        { scope: "root", outcome: "mapped" }, { scope: "checker", outcome: "mapped" },
        { scope: "root", outcome: "mapped" }, { scope: "root", outcome: "mapped" },
      ],
    })
  } finally { await service.stop() }
})

test("MCP rejects multiplexed, flattened and malformed inputs before admission in both scopes", async () => {
  const workbench = createWorkbench()
  const service = startWorkbench(workbench)
  const malformed = [
    ["map_sources", { op: "map" }],
    ["map_sources", { op: "map", pages: null }],
    ["map_sources", { pages: null }],
    ["map_sources", { pages: [] }],
    ["lookup_pages", {}],
    ["lookup_pages", { op: "lookup", pages: [{ source: "inspection" }] }],
    ["lookup_pages", { op: null, pages: [{ source: "inspection", limit: null, cursor: null }] }],
    ["lookup_pages", { source: "inspection", limit: 4 }],
    ["lookup_pages", { pages: { source: "inspection", limit: 4 } }],
    ["lookup_pages", { pages: '[{"source":"inspection","limit":4}]' }],
    ["lookup_pages", { pages: null }],
    ["lookup_pages", { pages: [] }],
    ["lookup_pages", { pages: Array.from({ length: 5 }, () => ({ source: "inspection" })) }],
    ["lookup_pages", { pages: ["inspection"] }],
    ["lookup_pages", { pages: [{ source: null }] }],
    ["lookup_pages", { pages: [{ source: "inspection", offset: 0 }] }],
    ["lookup_pages", { pages: [{ source: "inspection", limit: "4" }] }],
    ["lookup_pages", { pages: [{ source: "inspection", limit: 0 }] }],
    ["lookup_pages", { pages: [{ source: "inspection", limit: 1.5 }] }],
    ["lookup_pages", { pages: [{ source: "inspection", limit: 25 }] }],
    ["lookup_pages", { pages: [{ source: "inspection", cursor: "" }] }],
    ["lookup_pages", { pages: [{ source: "inspection" }, { source: "inspection", limit: 4 }] }],
  ] as const
  try {
    for (const endpoint of [service.endpoint, service.checkerEndpoint]) {
      for (const [name, args] of malformed) {
        expect(await callTool(endpoint, name, args)).toEqual({ status: "unavailable", reason: "invalid_request" })
      }
    }
    expect(workbench.snapshot()).toMatchObject({
      calls: malformed.length * 2, deniedQueries: malformed.length * 2, acceptedQueries: 0,
      receipts: [...malformed.map(() => "root"), ...malformed.map(() => "checker")].map(scope => ({
        scope, outcome: "denied", queryId: null, evidenceRefs: [], pages: [],
      })),
    })
  } finally { await service.stop() }
})

test("MCP normalizes native null optionals without relaxing bounds, replay or cursor scope", async () => {
  const workbench = createWorkbench({ maxAcceptedQueries: 4 })
  const service = startWorkbench(workbench)
  const lookup = (endpoint: string, ...pages: object[]) => callTool(endpoint, "lookup_pages", { pages })
  const denied = { status: "unavailable", reason: "invalid_request" }
  try {
    for (const endpoint of [service.endpoint, service.checkerEndpoint]) {
      const other = endpoint === service.endpoint ? service.checkerEndpoint : service.endpoint
      const first = await lookup(endpoint, { source: "inspection", limit: null, cursor: null })
      expect(first).toMatchObject({ status: "ok", pages: [{ source: "inspection", offset: 0 }] })
      expect(typeof first.pages[0].nextCursor).toBe("string")
      expect(first.pages[0].rows).toHaveLength(24)
      expect(await lookup(endpoint, { source: "inspection" })).toEqual(first)
      const cursor = first.pages[0].nextCursor
      expect(await lookup(other, { source: "inspection", cursor })).toEqual(denied)
      expect(await lookup(endpoint, { source: "route", cursor })).toEqual(denied)
      const next = await lookup(endpoint, { source: "inspection", cursor, limit: null })
      expect(next).toMatchObject({ status: "ok", pages: [{ offset: 24, nextCursor: null }] })
      expect(next.pages[0].rows).toHaveLength(12)
    }
    expect(workbench.snapshot()).toMatchObject({ calls: 10, acceptedQueries: 4, deniedQueries: 4 })
  } finally { await service.stop() }
})

test("shared MCP surface retains per-case admission across reconnect and gates checker evidence", async () => {
  const workbench = createWorkbench({ maxAcceptedQueries: 1 })
  const first = startWorkbench(workbench)
  const lookup = (endpoint: string, source: Source) => callTool(endpoint, "lookup_pages", { pages: [{ source }] })
  try {
    expect(await lookup(first.endpoint, "clock-audit")).toEqual({ status: "unavailable", reason: "source_unavailable" })
    expect(await lookup(first.checkerEndpoint, "clock-audit")).toMatchObject({ status: "ok", queryId: "query-1" })
  } finally { await first.stop() }
  const second = startWorkbench(workbench)
  try {
    expect(await lookup(second.endpoint, "inspection")).toEqual({ status: "unavailable", reason: "budget_exhausted" })
    expect(await lookup(second.checkerEndpoint, "clock-audit")).toMatchObject({ status: "ok", queryId: "query-1" })
    expect(workbench.snapshot()).toMatchObject({ calls: 4, acceptedQueries: 1, deniedQueries: 2 })
  } finally { await second.stop() }
})

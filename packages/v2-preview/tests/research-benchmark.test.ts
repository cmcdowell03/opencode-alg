import { expect, test } from "bun:test"
import { deriveAnswer, researchCase, type CaseVariant, type FabEvidence, type Source } from "../benchmark/case.ts"
import { isWrongRootReturn, scorePair, scoreRun, type RunObservation } from "../benchmark/score.ts"
import { createWorkbench, startWorkbench } from "../benchmark/workbench.ts"

const publicSources = ["inspection", "route", "dispatch"] as const
const privateSources = ["clock-audit", "monitor"] as const

function collect(call: ReturnType<typeof createWorkbench>["call"], sources: readonly Source[], rows: FabEvidence) {
  const refs = new Map<Source, string>()
  let pages: { source: Source; cursor?: string }[] = sources.map(source => ({ source }))
  while (pages.length) {
    const result = call({ op: "lookup", pages })
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
  expect(service.call({ op: "map" })).toMatchObject({ status: "ok", sources: publicSources.map(source => ({ source })) })
  expect(service.call({ op: "lookup", pages: [{ source: "monitor" }] })).toEqual({ status: "unavailable", reason: "source_unavailable" })
  expect(service.call({ op: "lookup", pages: [{ source: "route", limit: 25 }] })).toMatchObject({ reason: "invalid_request" })
  const batch = { op: "lookup", pages: [{ source: "inspection" }, { source: "dispatch" }] }
  const first = service.call(batch)
  expect(service.call({ ...batch, pages: [...batch.pages].reverse() })).toEqual(first)
  expect(service.call({ op: "lookup", pages: [{ source: "inspection" }] })).toMatchObject({ status: "ok" })
  expect(service.checkerCall({ op: "lookup", pages: [{ source: "clock-audit" }] })).toMatchObject({ status: "ok" })
  expect(service.call({ op: "lookup", pages: [{ source: "route" }] })).toMatchObject({ reason: "budget_exhausted" })
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

test("shared MCP surface retains per-case admission across reconnect and gates checker evidence", async () => {
  const workbench = createWorkbench({ maxAcceptedQueries: 1 })
  const first = startWorkbench(workbench)
  const rpc = async (endpoint: string, method: string, params: unknown = {}) => {
    const response = await fetch(endpoint, { method: "POST",
      headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    })
    expect(response.status).toBe(200)
    return (await response.json() as { result: { tools?: unknown[]; content?: { text: string }[] } }).result
  }
  const lookup = async (endpoint: string, source: Source) => {
    const result = await rpc(endpoint, "tools/call", { name: "research_workbench",
      arguments: { op: "lookup", pages: [{ source }] } })
    return JSON.parse(result.content![0]!.text)
  }
  try {
    expect(await rpc(first.endpoint, "tools/list")).toEqual(await rpc(first.checkerEndpoint, "tools/list"))
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

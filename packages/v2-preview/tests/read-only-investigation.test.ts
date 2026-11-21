import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { createV2InvestigationBridge } from "../core/investigation.ts"
import type { DeliveryHistory } from "../src/delivery.ts"
import { TOOL } from "../src/host.ts"
import runtime from "../src/index.ts"

const sessionID = "ses_owner"
const agent = "build"
const projectID = "read-only-test"
const sourceTool = "sources_fixture_read"
type Execute = (input: unknown, call: { sessionID: string; agent: string; signal: AbortSignal }) =>
  Promise<{ content: string }>
type Command = { name: string; execute(input: { sessionID: string; text: string }): Promise<void> }

function sourceResult(id: string, content: string, path = "notes.md"): DeliveryHistory[number] {
  const time = { created: 1, completed: 2 }
  return { type: "assistant", agent: agent as never, id: ("msg_" + id) as never, model: { id: "test", providerID: "test" } as never,
    finish: "tool-calls", time, content: [{
      type: "tool", name: sourceTool, id: "call_" + id, time,
      state: { status: "completed", input: { path }, content: [{
        type: "text", text: JSON.stringify({ path, content, receipt: "read-" + id }),
      }] },
    }] }
}

async function fixture(directory: string, overrides: Record<string, unknown> = {}) {
  let execute: Execute | undefined
  let command: Command | undefined
  let input: { properties: { action: { enum: string[] } } } | undefined
  let history: DeliveryHistory = []
  const hooks = new Map<string, ((request: unknown) => Promise<void>)[]>()
  const entries = new Map<string, unknown>()
  const commandNotices: unknown[] = []
  const options = { enabled: true, investigationMode: "read-only", readOnlyEvidenceTools: [sourceTool], ...overrides }
  let allowSourceRead = true
  let allowed = true
  let allowedNativeUse = true
  const transform = (edit: (editor: unknown) => void) => {
    edit({ get: () => undefined, add: (value: { execute: Execute; input: typeof input }) => {
      execute = value.execute
      input = value.input
    } })
    return { dispose: async () => {} }
  }
  const hook = (key: string, callback: (request: unknown) => Promise<void>) => {
    hooks.set(key, [...hooks.get(key) ?? [], callback])
    return { dispose: async () => {} }
  }
  const detach = await runtime.setup({
    app: { version: "2.3.2" }, options, location: { directory, project: { id: projectID } },
    command: { transform(edit: (editor: unknown) => void) {
      edit({ get: () => undefined, add(value: Command) { if (value.name === "alg-report") command = value } })
      return { dispose: async () => {} }
    } },
    session: {
      get: async ({ sessionID: requested }: { sessionID: string }) => ({
        id: requested, agent, projectID, location: { directory }, time: {},
        ...(requested === sessionID ? {} : { parentID: sessionID }),
      }),
      hook,
      context: async () => history,
      synthetic: async (notice: unknown) => { commandNotices.push(notice) },
      instructions: { entry: {
        list: async () => [...entries].map(([key, value]) => ({ key, value })),
        put: async ({ key, value }: { key: string; value: unknown }) => { entries.set(key, value) },
        remove: async ({ key }: { key: string }) => { entries.delete(key) },
      } },
    },
    permission: { hook, async assert({ action, resources }: { action: string; resources: string[] }) {
      if (!allowed || (!allowedNativeUse && action === "tool.use" && resources.includes(TOOL)) || (action === sourceTool && !allowSourceRead)) throw new Error("PERMISSION_DENIED")
    } },
    tool: { hook, transform },
  } as unknown as Plugin.Context)
  return {
    detach, command: () => command!.execute({ sessionID, text: "" }), commandNotices, input: () => input!,
    history: (messages: DeliveryHistory) => { history = messages },
    revokeSource: () => { allowSourceRead = false },
    revokeALG: () => { allowed = false },
    revokeNativeALG: () => { allowedNativeUse = false },
    async call(action: string, fields = {}, caller = sessionID) {
      return JSON.parse((await execute!({ action, ...fields },
        { sessionID: caller, agent, signal: new AbortController().signal })).content)
    },
    async request(kind = "context", extra: unknown[] = []) {
      const messages = [...extra, { role: "user", content: [{ type: "text", text: "Continue." }] }] as SessionContext["messages"]
      const request = { sessionID, agent, messages,
        system: [] as { type: "text"; text: string }[], tools: { [TOOL]: { description: "", input } } }
      for (const callback of hooks.get(kind) ?? []) await callback(request)
      return request
    },
  }
}

function toolStatus(receipt: unknown) {
  return [
    { role: "assistant", content: [{ type: "tool-call", name: TOOL, id: "status-1", input: { action: "status" } }] },
    { role: "tool", content: [{ type: "tool-result", name: TOOL, id: "status-1", result: { type: "text", value: JSON.stringify(receipt) } }] },
  ]
}

function graphFrame(request: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>["request"]>>, delta = false) {
  const label = delta ? "ALG active question delta " : "ALG active question "
  const text = request.messages.flatMap(message => message.content.flatMap(part => part.type === "text" ? [part.text] : []))
    .find(text => text.startsWith(label + "(untrusted recorded data)\n"))
  return text && JSON.parse(text.slice(text.indexOf("\n") + 1))
}

test("graph loop checks visible status, deltas, compaction and no-progress writes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alg-graph-question-"))
  const host = await fixture(directory, { graphLoop: true })
  try {
    await host.call("create")
    const initial = await host.call("status")
    expect(initial).toMatchObject({ ok: true, active_question: { state: "investigate", decision_revision: 0 } })
    expect(typeof initial.active_question?.question).toBe("string")
    expect(typeof initial.active_question?.next_action).toBe("string")
    expect(initial.evidence).toBeUndefined()
    expect(graphFrame(await host.request())).toEqual(initial.active_question)
    expect(graphFrame(await host.request("context", toolStatus(initial)))).toBeUndefined()
    // Neither a tool result without its native call nor a pre-compaction anchor covers the current request.
    expect(graphFrame(await host.request("context", toolStatus(initial).slice(1)))).toEqual(initial.active_question)
    expect(graphFrame(await host.request("context", [
      ...toolStatus(initial), { role: "assistant", content: [{ type: "compaction" }] },
    ]))).toEqual(initial.active_question)
    expect(graphFrame(await host.request("compaction"))).toBeUndefined()

    host.history([sourceResult("first", "An inspected observation.", "a.md")])
    const before = await host.call("status")
    const update = { expected_decision_revision: 0, next_action: "Inspect the affected interval.", evidence_refs: ["a.md"] }
    expect(await host.call("set_next_measurement", update)).toMatchObject({ ok: true, decision_revision: 1, outcome: "recorded" })
    expect(graphFrame(await host.request("context", toolStatus(before)), true)).toMatchObject({
      set: { decision_revision: 1, question: "Inspect the affected interval." },
    })
    expect(await host.call("set_next_measurement", { ...update, expected_decision_revision: 1 }))
      .toMatchObject({ ok: true, decision_revision: 1, outcome: "reused", reason: "no_progress" })
    expect(await host.call("set_next_measurement", { ...update, expected_decision_revision: 1, next_action: "Check another interval." }))
      .toMatchObject({ ok: true, decision_revision: 2, outcome: "recorded" })
    const after = await host.call("status")
    const restarted = await fixture(directory, { graphLoop: true })
    try {
      expect(graphFrame(await restarted.request())).toEqual(after.active_question)
    } finally { await restarted.detach() }
  } finally {
    await host.detach()
    await rm(directory, { recursive: true, force: true })
  }
})

test("graph loop reuses closure and reopens only the finding linked to a changed source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alg-graph-source-"))
  const host = await fixture(directory, { graphLoop: true, readOnlyCacheSourceBytes: true })
  try {
    const original = [sourceResult("one", "First observation.", "a.md"), sourceResult("two", "Independent observation.", "b.md")]
    host.history(original)
    await host.call("create")
    const finding = (id: string, reference: string) => ({
      expected_decision_revision: 0, finding: { id, scope: "Recorded interval", interpretation: "An observation.",
        support: [reference], counterevidence: [] },
    })
    expect(await host.call("record_finding", finding("affected", "a.md"))).toMatchObject({
      ok: true, finding_id: "affected", finding_status: "supported", outcome: "recorded",
    })
    expect((await host.call("record_finding", finding("affected", "a.md")))).toMatchObject({
      ok: true, finding_id: "affected", outcome: "reused", reason: "no_progress",
    })
    await host.call("record_finding", finding("unaffected", "b.md"))
    expect(await host.call("status")).toMatchObject({ active_question: {
      state: "investigate", next_action: expect.stringContaining("receipt-bound report decision"),
    } })
    const closure = { expected_decision_revision: 0, next_action: "Close the investigation.",
      evidence_refs: ["a.md", "b.md"], report_decision: { disposition: "resolved", missingEvidence: [] } }
    expect(await host.call("set_next_measurement", closure)).toMatchObject({ ok: true, decision_revision: 1 })
    expect(graphFrame(await host.request())).toMatchObject({ state: "reuse", decision_revision: 1 })
    expect(await host.call("set_next_measurement", { ...closure, expected_decision_revision: 1, next_action: "Same closure." }))
      .toMatchObject({ ok: true, decision_revision: 1, outcome: "reused", reason: "current_report" })
    host.history([...original, sourceResult("three", "Unrelated observation.", "c.md")])
    expect(graphFrame(await host.request())).toMatchObject({ state: "reuse", decision_revision: 1 })
    host.history([sourceResult("change", "Revised observation.", "a.md")])
    expect(graphFrame(await host.request())).toMatchObject({
      state: "revalidate", affected_findings: ["affected"], finding: { id: "affected",
        support: [], invalidated_sources: [{ relation: "support", reference: "a.md" }] },
      source_revalidation: [{ path: "a.md", state: "confirm_once" }],
    })
    const explicit = await host.call("status", { finding_id: "unaffected" })
    expect(explicit.evidence.findings).toMatchObject([{ id: "unaffected", status: "supported" }])
    expect(await host.call("status", { snapshot_refs: ["a.md", "b.md"] })).toMatchObject({
      ok: true, evidence_snapshot: { cache_enabled: true, evidence: [{ source: { reference: "b.md" } }], missing: ["a.md"] },
    })
    host.history([sourceResult("confirm", "Revised observation.", "a.md")])
    expect(graphFrame(await host.request())).toMatchObject({
      state: "revalidate", affected_findings: ["affected"], source_revalidation: [{ path: "a.md", state: "confirmed" }],
    })
    expect(await host.call("status", { snapshot_refs: ["a.md"] })).toMatchObject({
      ok: true, evidence_snapshot: { evidence: [{ source: { reference: "a.md" }, data: "Revised observation." }], missing: [] },
    })
    expect(await host.call("record_finding", { ...finding("affected", "a.md"), expected_decision_revision: 1 }))
      .toMatchObject({ ok: true, outcome: "recorded", finding_status: "supported" })
    expect(graphFrame(await host.request())).toMatchObject({ state: "investigate" })
    expect(await host.call("set_next_measurement", { ...closure, expected_decision_revision: 1 }))
      .toMatchObject({ ok: true, outcome: "recorded", decision_revision: 2 })
    expect(graphFrame(await host.request())).toMatchObject({ state: "reuse", decision_revision: 2 })
    host.revokeSource()
    expect(await host.call("status", { snapshot_refs: ["b.md"] })).toMatchObject({ ok: false })
    expect(graphFrame(await host.request())).toBeUndefined()
  } finally {
    await host.detach()
    await rm(directory, { recursive: true, force: true })
  }
})

test("graph loop waits at a recorded gap and allows newly available evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alg-graph-wait-"))
  const host = await fixture(directory, { graphLoop: true })
  try {
    await host.call("create")
    const missing = { id: "gap", interpretation: "The reading is missing.", support: [], counterevidence: [],
      missingEvidence: "A timestamped reading." }
    expect(await host.call("record_finding", { expected_decision_revision: 0, finding: missing })).toMatchObject({ ok: true })
    expect(graphFrame(await host.request())).toMatchObject({ state: "stop", reason: "missing_evidence", decision_revision: 0 })
    host.history([sourceResult("fresh", "A newly available timestamped reading.")])
    expect(graphFrame(await host.request())).toMatchObject({ state: "investigate", decision_revision: 0 })
    expect(await host.call("status", { snapshot_refs: ["notes.md"] })).toMatchObject({
      ok: true, evidence_snapshot: { cache_enabled: false, evidence: [], missing: ["notes.md"] },
    })
  } finally {
    await host.detach()
    await rm(directory, { recursive: true, force: true })
  }
})

test("an acknowledged indeterminate report resumes on an exact missing reference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alg-graph-report-gap-"))
  const options = { graphLoop: true }
  const host = await fixture(directory, options)
  try {
    await host.call("create")
    host.history([sourceResult("basis", "Existing report evidence.", "basis.md")])
    const finding = { id: "gap", interpretation: "The report needs the second reading.", scope: "Second reading",
      support: ["basis.md"], counterevidence: [], missingEvidence: "missing.json#second" }
    expect(await host.call("record_finding", { expected_decision_revision: 0, finding })).toMatchObject({ ok: true })
    expect(await host.call("set_next_measurement", { expected_decision_revision: 0,
      next_action: "Wait for the second reading.", evidence_refs: ["basis.md"],
      report_decision: { disposition: "indeterminate", missingEvidence: ["missing.json#second"] },
    })).toMatchObject({ ok: true, decision_revision: 1 })
    expect(graphFrame(await host.request())).toMatchObject({ state: "stop", reason: "missing_evidence" })

    const second = JSON.stringify([{ id: "second", reading: 15 }])
    host.history([sourceResult("other", second, "unrelated.json")])
    expect(graphFrame(await host.request())).toMatchObject({ state: "stop", reason: "missing_evidence" })
    host.history([sourceResult("wrong", JSON.stringify([{ id: "first", reading: 15 }]), "missing.json")])
    expect(graphFrame(await host.request())).toMatchObject({ state: "stop", reason: "missing_evidence" })
    host.history([sourceResult("changed", second, "missing.json")])
    expect(graphFrame(await host.request())).toMatchObject({ state: "stop", reason: "missing_evidence" })
    host.history([sourceResult("confirmed", second, "missing.json")])
    expect(graphFrame(await host.request())).toMatchObject({
      state: "investigate", reason: "missing_evidence_available", decision_revision: 1,
      available_references: ["missing.json#second"], finding: { id: "gap", status: "unresolved" },
    })
    const restarted = await fixture(directory, options)
    try {
      expect(graphFrame(await restarted.request())).toMatchObject({
        state: "investigate", reason: "missing_evidence_available", decision_revision: 1,
      })
    } finally { await restarted.detach() }
  } finally {
    await host.detach()
    await rm(directory, { recursive: true, force: true })
  }
})

test("read-only actions fence submissions, stale revisions, and receipt-free reports", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alg-read-only-"))
  const host = await fixture(directory)
  try {
    expect(host.input().properties.action.enum).not.toContain("dispatch")
    expect((await host.request()).tools[TOOL]?.input?.properties.action.enum).toEqual(["create", "status"])
    for (const action of ["admit", "dispatch", "reconcile", "start", "read", "result", "revoke"])
      expect(await host.call(action)).toMatchObject({ ok: false, error: "READ_ONLY_ACTION_UNAVAILABLE" })
    expect(await host.call("create")).toMatchObject({ ok: true, investigationMode: "read-only", decision_revision: 0, work: null })
    expect(await host.call("status", {}, "ses_child")).toMatchObject({ ok: false, error: "OWNER_REQUIRED" })
    expect(await host.call("set_next_measurement", { expected_decision_revision: 0, next_action: "Which batch?",
      evidence_refs: ["notes.md"] })).toMatchObject({ ok: false, error: "EVIDENCE_READ_UNVERIFIED_REFERENCE" })
    expect(await host.call("set_next_measurement", { expected_decision_revision: 0, next_action: "Which batch?" }))
      .toMatchObject({ ok: true, decision_revision: 1, decision_authority: "unverified_question" })
    expect(await host.call("render_report")).toMatchObject({ ok: false, error: "REPORT_REQUIRES_RECEIPT_BOUND_DECISION" })
    expect(await host.call("record_finding", { expected_decision_revision: 0, finding: {
      id: "claim", interpretation: "Some interpretation", support: [], counterevidence: [],
    } })).toMatchObject({ ok: false, error: "STALE_INVESTIGATION_DECISION_REVISION" })
    const core = createV2InvestigationBridge({ investigationMode: "read-only" })
    const uncreated = { directory, projectID, sessionID: "ses_uncreated" }
    for (const action of ["admit", "dispatch", "reconcile"] as const) {
      await expect(core[action](uncreated)).rejects.toThrow("READ_ONLY_ACTION_UNAVAILABLE")
    }
    host.revokeALG()
    expect(await host.call("status")).toMatchObject({ ok: false, error: "PERMISSION_DENIED" })
  } finally {
    await host.detach()
    await rm(directory, { recursive: true, force: true })
  }
})

test("an acknowledged missing-source list survives rendering without the finding's explanatory prose", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alg-report-gap-"))
  const host = await fixture(directory)
  try {
    await host.call("create")
    host.history([sourceResult("index", "The calibration index names the unavailable trace.")])
    const reference = "calibration/trace.json"
    const explanation = "The signed trace at " + reference + " would establish whether the measurement drifted."
    const finding = { id: "drift", scope: "Batch A", interpretation: "The cause remains open.",
      support: ["notes.md"], counterevidence: [], missingEvidence: explanation }
    expect(await host.call("record_finding", { expected_decision_revision: 0, finding })).toMatchObject({ ok: true })
    const closed = await host.call("set_next_measurement", { expected_decision_revision: 0,
      next_action: "Obtain the signed calibration trace", evidence_refs: ["notes.md"],
      report_decision: { disposition: "indeterminate", missingEvidence: [reference] } })
    expect(closed).toMatchObject({ ok: true, decision_revision: 1 })
    const rendered = await host.call("render_report", { expected_decision_revision: 1 })
    expect(rendered.report_authority).toBe("owner_recorded")
    expect(JSON.parse(rendered.text).missingEvidence).toEqual([reference])
    expect((await host.call("status")).evidence.findings[0].missingEvidence).toBe(explanation)
  } finally {
    await host.detach()
    await rm(directory, { recursive: true, force: true })
  }
})

test("saved citations survive restart and express disposition stays tied to the exact findings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alg-read-only-"))
  const first = await fixture(directory)
  let restarted: Awaited<ReturnType<typeof fixture>> | undefined
  const finding = { id: "claim", interpretation: "The log lists the event.", scope: "Batch A",
    support: ["notes.md"], counterevidence: [] }
  try {
    await first.call("create")
    first.history([sourceResult("read", "The log lists the event.")])
    const planned = await first.call("set_next_measurement", { expected_decision_revision: 0,
      next_action: "Decide which batch to measure", evidence_refs: ["notes.md"] })
    expect(planned).toMatchObject({ ok: true, decision_revision: 1, decision_authority: "receipt_bound", work: null })
    expect(await first.call("record_finding", { expected_decision_revision: 1, finding })).toMatchObject({
      ok: true, finding: { status: "supported", attribution: "model" },
    })
    const provisional = await first.call("render_report", { expected_decision_revision: 1 })
    expect(provisional).toMatchObject({ ok: true, report_authority: "provisional", provisional_reason: "closure_decision_unrecorded",
      report: { disposition: "indeterminate", claims: [{ finding: finding.interpretation, scope: finding.scope, evidence: ["notes.md"] }],
        missingEvidence: [] } })
    await expect(first.command()).rejects.toThrow("REPORT_REQUIRES_ACKNOWLEDGED_DISPOSITION")
    const closed = await first.call("set_next_measurement", { expected_decision_revision: 1,
      next_action: "Close the owner's review", evidence_refs: ["notes.md"],
      report_decision: { disposition: "resolved", missingEvidence: [] } })
    expect(closed).toMatchObject({ ok: true, decision_revision: 2 })
    const before = await first.call("status")
    expect(before).toMatchObject({ report_authority: "owner_recorded", evidence: { sources: [{ references: [{ reference: "notes.md" }] }] } })
    await first.request("compaction")
    await first.detach()

    restarted = await fixture(directory)
    expect(await restarted.call("status")).toEqual(before)
    const delivered = await restarted.call("render_report")
    expect(delivered).toMatchObject({ ok: true, report_authority: "owner_recorded", report: { disposition: "resolved" } })
    expect(JSON.parse(delivered.text)).toEqual(delivered.report)
    expect(await restarted.call("render_report", { expected_decision_revision: 1 })).toMatchObject({
      ok: false, error: "STALE_INVESTIGATION_DECISION_REVISION",
    })
    await restarted.command()
    expect(restarted.commandNotices).toHaveLength(1)
    expect(restarted.commandNotices[0]).toMatchObject({ metadata: { algReport: { authority: "owner_recorded", revision: 2 } } })
    await restarted.call("record_finding", { expected_decision_revision: 2,
      finding: { ...finding, interpretation: "Another interpretation of the log." } })
    expect(await restarted.call("render_report")).toMatchObject({ ok: true, report_authority: "provisional",
      provisional_reason: "recorded_findings_changed", report: { disposition: "indeterminate" } })
    await expect(restarted.command()).rejects.toThrow("REPORT_REQUIRES_ACKNOWLEDGED_DISPOSITION")
    restarted.history([sourceResult("changed", "The source was amended.")])
    expect(await restarted.call("status")).toMatchObject({ decision_authority: "evidence_unavailable",
      evidence: { sources: [{ status: "changed", references: [] }] } })
    expect(await restarted.call("render_report")).toMatchObject({ ok: false })
    restarted.revokeSource()
    expect(await restarted.call("status")).toMatchObject({ ok: false, error: "PERMISSION_DENIED" })
  } finally {
    await first.detach()
    await restarted?.detach()
    await rm(directory, { recursive: true, force: true })
  }
})


test("status pages every source reference while recovery projects only the index", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alg-read-only-index-"))
  const host = await fixture(directory)
  try {
    await host.call("create")
    const rows = Array.from({ length: 50 }, (_, i) => ({ id: "entry-" + String(i).padStart(2, "0") }))
    host.history([sourceResult("rows", JSON.stringify(rows), "rows.json")])
    const start = await host.call("status")
    const page = start.evidence.sources[0]
    expect(page.references).toHaveLength(32)
    expect(page).toMatchObject({ path: "rows.json", total_references: 50, next_reference_offset: 32 })
    const rest = await host.call("status", { source_path: "rows.json", reference_offset: page.next_reference_offset })
    expect(rest.evidence.sources[0].references.map((source: { reference: string }) => source.reference))
      .toEqual(rows.slice(32).map(row => "rows.json#" + row.id))
    const request = await host.request()
    const context = JSON.stringify(request.messages)
    expect(context).toContain("rows.json")
    expect(context).toContain("omittedReferences")
    expect(context).not.toContain("entry-49")
    expect(context).not.toContain("read-rows")
    expect(await host.call("set_next_measurement", {
      expected_decision_revision: 0, next_action: "Record the unresolved row search",
      evidence_refs: ["rows.json#entry-49"], report_decision: { disposition: "indeterminate", missingEvidence: ["actual-missing.md"] },
    })).toMatchObject({ ok: true })
    host.revokeNativeALG()
    expect(await host.call("status")).toMatchObject({ ok: false, error: "PERMISSION_DENIED" })
    await expect(host.command()).rejects.toThrow("PERMISSION_DENIED")
  } finally {
    await host.detach()
    await rm(directory, { recursive: true, force: true })
  }
})

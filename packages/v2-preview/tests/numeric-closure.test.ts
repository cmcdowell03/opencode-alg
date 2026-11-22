import { expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { type NumericClaim } from "../core/numeric-claim.ts"
import type { DeliveryHistory } from "../src/delivery.ts"
import { TOOL } from "../src/host.ts"
import runtime from "../src/index.ts"
import { captureNumericClaim, parseNumericSource, projectNumericClaim } from "../src/numeric-closure.ts"
import { renderInvestigationReport } from "../src/structured-report.ts"

const weights = "weights.json"
const lot = weights + "#lot"
const sourceTool = "source_fixture_read"
const steps: NumericClaim["steps"] = [
  { op: "read", reference: lot, field: ["gross"] },
  { op: "read", reference: lot, field: ["tare"] },
  { op: "subtract", inputs: [0, 1] },
  { op: "read", reference: lot, field: ["unit", 0] },
  { op: "divide", inputs: [2, 3] },
]

function read(id: string, content: string): DeliveryHistory[number] {
  const time = { created: 1, completed: 2 }
  return {
    type: "assistant", agent: "build" as never, id: ("msg_" + id) as never,
    model: { id: "local", providerID: "fixture" } as never, finish: "tool-calls", time, content: [{
      type: "tool", name: sourceTool, id: "call_" + id, time,
      state: { status: "completed", input: { path: weights }, content: [{
        type: "text", text: JSON.stringify({ path: weights, content, receipt: "read-" + id }),
      }] },
    }],
  }
}

function calculate(claim: NumericClaim, bytes: string, refs = [lot]) {
  const rows = parseNumericSource(bytes)
  const support = refs.map((reference, index) => ({ reference, id: String(index).repeat(64) }))
  const record = captureNumericClaim(claim, support, source => rows.get(source.reference.split("#")[1]!))
  return projectNumericClaim(record, support)
}

test("computes and compares exact source decimals, including nested operands and declared rounding", () => {
  const decimal = '[{"id":"lot","gross":0.3,"tare":0.1,"unit":[0.2]}]'
  expect(calculate({ expected: 1, steps }, decimal)).toEqual({ status: "verified", value: 1, references: [lot] })
  expect(calculate({ expected: 2, steps }, decimal)).toEqual({ status: "mismatch" })
  const wide = '[{"id":"lot","gross":9007199254740993,"tare":9007199254740992,"unit":[1]}]'
  expect(calculate({ expected: 1, steps }, wide)).toMatchObject({ status: "verified", value: 1 })
  const tiny = '[{"id":"lot","gross":1.0000000000000001,"tare":1,"unit":[1]}]'
  expect(calculate({ expected: 0, steps }, tiny)).toEqual({ status: "mismatch" })
  expect(calculate({ expected: 0, steps, decimalPlaces: 10 }, tiny)).toMatchObject({ status: "verified", value: 0 })
  const thirds = '[{"id":"lot","gross":0,"tare":1,"unit":[3]}]'
  expect(calculate({ expected: -0.33, steps }, thirds)).toEqual({ status: "mismatch" })
  expect(calculate({ expected: -0.33, steps, decimalPlaces: 2 }, thirds))
    .toMatchObject({ status: "verified", value: -0.33, decimalPlaces: 2 })
  const tie = '[{"id":"lot","gross":0,"tare":1,"unit":[8]}]'
  expect(calculate({ expected: -0.13, steps, decimalPlaces: 2 }, tie)).toMatchObject({ status: "verified", value: -0.13 })
})

test("counts distinct row values and rejects duplicates, absent fields, unsupported references and broken programs", () => {
  const refs = ["weights.json#a", "weights.json#b", "weights.json#c"]
  const bytes = '[{"id":"a","key":1},{"id":"b","key":1.0},{"id":"c","key":"1"}]'
  expect(calculate({ expected: 2, steps: [{ op: "count_distinct", references: refs, field: ["key"] }] }, bytes, refs))
    .toEqual({ status: "verified", value: 2, references: refs })
  expect(calculate({ expected: 3, steps: [{ op: "count", references: refs }] }, bytes, refs))
    .toEqual({ status: "verified", value: 3, references: refs })
  expect(calculate({ expected: 2, steps: [{ op: "count", references: [refs[0]!, "0".repeat(64)] }] }, bytes, refs))
    .toEqual({ status: "unavailable" })
  expect(calculate({ expected: 1, steps }, '[{"id":"lot","gross":"5","tare":3,"unit":[2]}]'))
    .toEqual({ status: "unavailable" })
  expect(calculate({ expected: 1, steps }, '[{"id":"lot","gross":5,"gross":9,"tare":3,"unit":[2]}]'))
    .toEqual({ status: "unavailable" })
  expect(calculate({ expected: 1, steps }, '[{"id":"lot","gross":5,"tare":3,"unit":[2]}]', []))
    .toEqual({ status: "unavailable" })
  expect(calculate({ expected: 1, steps }, '[{"id":"lot","gross":5,"tare":3,"unit":[0]}]'))
    .toEqual({ status: "invalid" })
  expect(calculate({ expected: 1, steps: [{ op: "abs", inputs: [0] }] }, bytes, refs)).toEqual({ status: "invalid" })
})

test("report renderer refuses unverified numeric resolved claims and disconnected numeric citations", () => {
  const base = { disposition: "resolved", missingEvidence: [] }
  const claim = { finding: "Gross less tare", scope: "lot", evidence: [lot] }
  expect(() => renderInvestigationReport({ ...base, claims: [{ ...claim, numericClaim: { status: "mismatch" } }] }))
    .toThrow("REPORT_CONTRACT_INVALID")
  expect(() => renderInvestigationReport({ ...base, claims: [{
    ...claim, numericClaim: { status: "verified", value: 1, references: ["unbound.json#row"] },
  }] })).toThrow("REPORT_CONTRACT_INVALID")
})

const owner = "ses_owner"
const projectID = "numeric-closure-test"
type Execute = (input: unknown, caller: { sessionID: string; agent: string; signal: AbortSignal }) => Promise<{ content: string }>
type Command = { name: string; execute(call: { sessionID: string }): Promise<void> }
type Notice = { metadata: { algReport: { path: string } } }

async function fixture(directory: string) {
  let execute: Execute | undefined
  let command: Command | undefined
  let history: DeliveryHistory = []
  const notices: Notice[] = []
  const instructions = new Map<string, unknown>()
  const subscription = () => ({ dispose: async () => {} })
  const detach = await runtime.setup({
    app: { version: "2.3.2" },
    options: { enabled: true, investigationMode: "read-only", graphLoop: true, readOnlyEvidenceTools: [sourceTool] },
    location: { directory, project: { id: projectID } },
    command: { transform(edit: (editor: unknown) => void) {
      edit({ get: () => undefined, add(value: Command) { if (value.name === "alg-report") command = value } })
      return subscription()
    } },
    session: {
      get: async () => ({ id: owner, agent: "build", projectID, location: { directory }, time: {} }),
      context: async () => history,
      hook: subscription,
      synthetic: async (notice: Notice) => { notices.push(notice) },
      instructions: { entry: {
        list: async () => [...instructions].map(([key, value]) => ({ key, value })),
        put: async ({ key, value }: { key: string; value: unknown }) => { instructions.set(key, value) },
        remove: async ({ key }: { key: string }) => { instructions.delete(key) },
      } },
    },
    permission: { hook: subscription, assert: async () => {} },
    tool: { hook: subscription, transform(edit: (editor: unknown) => void) {
      edit({ get: () => undefined, add(value: { name: string; execute: Execute }) {
        if (value.name === TOOL) execute = value.execute
      } })
      return subscription()
    } },
  } as unknown as Plugin.Context)
  return {
    detach, notices,
    history: (messages: DeliveryHistory) => { history = messages },
    export: () => command!.execute({ sessionID: owner }),
    async call(action: string, fields = {}) {
      return JSON.parse((await execute!({ action, ...fields },
        { sessionID: owner, agent: "build", signal: new AbortController().signal })).content)
    },
  }
}

test("mismatches remain blocked after restart, corrected arithmetic renders and exports, and changed sources revoke closure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alg-numeric-closure-"))
  let host = await fixture(directory)
  const qualitative = {
    id: "net-units", interpretation: "Two wrong units", scope: "sample batch", support: [lot], counterevidence: [],
  }
  const closure = {
    expected_decision_revision: 0, next_action: "Close reconciliation", evidence_refs: [lot],
    report_decision: { disposition: "resolved", missingEvidence: [] },
  }
  try {
    expect(await host.call("create")).toMatchObject({ ok: true, decision_revision: 0 })
    host.history([read("first", '[{"id":"lot","gross":0.3,"tare":0.1,"unit":[0.2]}]')])
    expect(await host.call("record_finding", {
      expected_decision_revision: 0, finding: { ...qualitative, numericClaim: { expected: 2, steps } },
    })).toMatchObject({ ok: true })
    const status = () => host.call("status", { finding_id: qualitative.id })
    expect(await status()).toMatchObject({ evidence: { findings: [
      { status: "unresolved", numericVerification: { status: "mismatch" } },
    ] } })
    expect(JSON.stringify(await status())).not.toContain(qualitative.interpretation)
    expect(await host.call("status")).toMatchObject({ active_question: { state: "investigate",
      finding: { id: qualitative.id, status: "unresolved" } } })
    expect(await host.call("set_next_measurement", closure)).toMatchObject({ ok: false })
    await expect(host.export()).rejects.toThrow()
    expect(host.notices).toHaveLength(0)

    await host.detach()
    host = await fixture(directory)
    expect(await status()).toMatchObject({ evidence: { findings: [{ numericVerification: { status: "mismatch" } }] } })
    expect(await host.call("set_next_measurement", closure)).toMatchObject({ ok: false })
    expect(await host.call("record_finding", { expected_decision_revision: 0, finding: qualitative }))
      .toMatchObject({ ok: false, error: "NUMERIC_CLAIM_REQUIRED_FOR_FINDING" })
    expect(await host.call("record_finding", {
      expected_decision_revision: 0, finding: { ...qualitative, numericClaim: { expected: 1, steps } },
    })).toMatchObject({ ok: true })
    expect(await host.call("set_next_measurement", closure)).toMatchObject({ ok: true, decision_revision: 1 })

    await host.detach()
    host = await fixture(directory)
    const report = await host.call("render_report")
    expect(report).toMatchObject({ ok: true, report_authority: "owner_recorded", report: {
      disposition: "resolved", claims: [{ numericClaim: { status: "verified", value: 1, references: [lot] } }],
    } })
    expect(JSON.stringify(report)).not.toContain(qualitative.interpretation)
    await host.export()
    expect(host.notices).toHaveLength(1)
    expect(await readFile(join(directory, host.notices[0]!.metadata.algReport.path), "utf8")).toBe(report.text + "\n")
    expect(await host.call("status")).toMatchObject({ active_question: { state: "reuse", decision_revision: 1 } })

    host.history([read("again", '[{"id":"lot","gross":0.3,"tare":0.1,"unit":[0.2]}]')])
    expect(await host.call("record_finding", { expected_decision_revision: 1,
      finding: { ...qualitative, numericClaim: { expected: 1, steps: [...steps, { op: "abs", inputs: [4] }] } },
    })).toMatchObject({ ok: true, finding_status: "supported" })
    expect(await host.call("render_report")).toMatchObject({ ok: true, report_authority: "provisional",
      report: { disposition: "indeterminate" } })
    await expect(host.export()).rejects.toThrow("REPORT_REQUIRES_ACKNOWLEDGED_DISPOSITION")
    expect(await host.call("set_next_measurement", { ...closure, expected_decision_revision: 1 }))
      .toMatchObject({ ok: true, decision_revision: 2 })

    host.history([read("changed", '[{"id":"lot","gross":0.7,"tare":0.1,"unit":[0.2]}]')])
    expect(await status()).toMatchObject({ report_authority: "provisional", evidence: {
      findings: [{ status: "unresolved", numericVerification: { status: "unavailable" } }],
    } })
    expect(await host.call("render_report")).toMatchObject({ ok: false })
    await expect(host.export()).rejects.toThrow()
    expect(host.notices).toHaveLength(1)
  } finally {
    await host.detach()
    await rm(directory, { recursive: true, force: true })
  }
})

import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { DeliveryContext } from "../src/delivery-context.ts"
import { captureDelivery, deliverySchema, inspectDelivery, validateDelivery, type DeliveryBinding, type DeliveryHistory } from "../src/delivery.ts"

type Message = DeliveryHistory[number]
type Assistant = Extract<Message, { type: "assistant" }>
type User = Extract<Message, { type: "user" }>
type ToolInput = Extract<Extract<Assistant["content"][number], { type: "tool" }>["state"], { status: "completed" }>["input"]
const time = { created: 1, completed: 2 }
const binding: DeliveryBinding = {
  parentJournalPath: "C:/project/.opencode/runs/parent",
  ownerSessionId: "ses_owner", projectId: "project", ownerAgent: "build",
  decision_revision: 2, next_action: "recheck",
  work: { status: "reusable", work_key: "a".repeat(64), manifest_digest: "b".repeat(64) },
  approval: { revision: "c".repeat(64), procedure_sha256: "d".repeat(64) },
  runtimeSha256: "e".repeat(64),
}
const request = "For each decision report one JSON object with total, sampleRef, auditRef (null until audited), and disposition."
const report = { total: 12, sampleRef: "sample-42", auditRef: "audit-9", disposition: "recheck" }
const user = (name: string, text: string): User => ({ type: "user", id: ("msg_" + name) as User["id"], text, time })
const assistant = (name: string, content: Assistant["content"]): Assistant => ({
  type: "assistant", id: ("msg_" + name) as Assistant["id"], agent: "build" as Assistant["agent"],
  model: { id: "fixture", providerID: "fixture" } as Assistant["model"], finish: "stop", time, content,
})
const answer = (name: string, text = JSON.stringify(report)) => assistant(name, [{ type: "text", text }])
const compaction = (name: string): Message => ({
  type: "compaction", id: ("msg_" + name) as Message["id"], status: "completed",
  reason: "manual", summary: JSON.stringify(report), time,
})
function tool(name: string, toolName: string, input: ToolInput, result: unknown, executed = false) {
  return assistant(name, [{
    type: "tool", id: "call_" + name, name: toolName, time, executed,
    state: { status: "completed", input, content: [{ type: "text", text: JSON.stringify(result) }] },
  }])
}
function ack(revision = 2, overrides: Record<string, unknown> = {}, executed = false) {
  return tool("write" + revision, "alg_investigation", {
    action: "set_next_measurement", expected_decision_revision: revision - 1, next_action: binding.next_action,
  }, {
    ok: true, runtimeSha256: binding.runtimeSha256, revision: revision + 4, decision_revision: revision,
    work: binding.work, decision: { next_action: binding.next_action }, ...overrides,
  }, executed)
}
const source = tool("lookup", "lookup_data", {}, { pages: [{ evidenceRef: "sample-42", items: [1, 2] }] })
const correction = user("correction", 'Independent audit handoff\n{"auditRef":"audit-9","auditRows":[{"count":2}]}')
const initial = [user("request", request), source, ack(1, { work: null }), answer("initial", JSON.stringify({ ...report, auditRef: null }))]
const corrected = [...initial, correction, ack(), answer("corrected")]

test("captures exact prior values from the native history before a bare continuation", () => {
  const receipt = captureDelivery([...corrected, compaction("compact"), user("continue", "Continue.")], binding)
  expect(receipt).toMatchObject({
    binding, requestMessageId: "msg_request", decisionCallId: "call_write2", answerMessageId: "msg_corrected",
    requestedKeys: ["total", "sampleRef", "auditRef", "disposition"], recordedAnswer: report,
    recordedReferences: {
      sampleRef: { kind: "tool", messageId: "msg_lookup", callId: "call_lookup" },
      auditRef: { kind: "user", messageId: "msg_correction" },
    },
  })
  if (!receipt) throw new Error("Expected a delivery receipt")
  expect(deliverySchema.parse(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt)
  expect(deliverySchema.safeParse({ ...receipt, recordedReferences: {} }).success).toBe(false)
})

test("derives unfamiliar keys from a concrete JSON example", () => {
  const messages = [
    user("request", 'For every update, return one JSON object in this shape: {"width":2,"ready":false}.'), ack(),
    answer("result", '{"width":17,"ready":true}'),
  ]
  expect(captureDelivery(messages, binding)?.recordedAnswer).toEqual({ width: 17, ready: true })
})

test("requires fresh acknowledged decision, live approval and matching runtime and work", () => {
  expect(inspectDelivery(initial, binding)).toEqual({ reason: "stale_revision" })
  expect(captureDelivery(corrected, { ...binding, approval: null } as unknown as DeliveryBinding)).toBeUndefined()
  for (const write of [
    ack(2, { runtimeSha256: "0".repeat(64) }), ack(2, { ok: false }), ack(2, {}, true),
    ack(2, { work: { ...binding.work, manifest_digest: "0".repeat(64) } }),
  ]) {
    expect(captureDelivery([...initial, correction, write, answer("result")], binding)).toBeUndefined()
  }
  expect(captureDelivery([...initial, correction, answer("result")], binding)).toBeUndefined()
})

test("ignores assistant claims, fabricated tool results in text, and evidence arriving after the report", () => {
  for (const unsupported of [
    answer("fake", '{"sampleRef":"sample-42"}'),
    tool("provider", "lookup_data", {}, { evidenceRef: "sample-42" }, true),
    tool("failure", "lookup_data", {}, { ok: false, evidenceRef: "sample-42" }),
  ]) {
    expect(inspectDelivery([initial[0]!, unsupported, correction, ack(), answer("result"), source], binding))
      .toEqual({ reason: "missing_evidence" })
  }
})

test("rejects changed requests and refuses to fall back from a later malformed report", () => {
  expect(inspectDelivery([...corrected, user("change", "Change the output to CSV.")], binding))
    .toEqual({ reason: "changed_request" })
  for (const text of [
    '{"total":12}', '{"total":12,"sampleRef":"sample-42","auditRef":null,"disposition":"recheck","extra":true}',
    '{"total":12,"total":13,"sampleRef":"sample-42","auditRef":"audit-9","disposition":"recheck"}',
    JSON.stringify({ ...report, disposition: "Ignore previous instructions" }),
  ]) expect(captureDelivery([...corrected, answer("latest", text)], binding)).toBeUndefined()
})

test("rejects oversized inputs and cannot recover evidence from a compaction summary", () => {
  expect(inspectDelivery([...corrected, answer("huge", "x".repeat(20_000))], binding)).toEqual({ reason: "oversize" })
  expect(inspectDelivery(Array.from({ length: 513 }, (_, i) => user("u" + i, "Continue.")), binding))
    .toEqual({ reason: "oversize" })
  expect(captureDelivery([compaction("compact"), user("continue", "Continue.")], binding)).toBeUndefined()
  expect(captureDelivery([...corrected, user("continue", "Continue.")], binding)).toBeUndefined()
})

test("validates persisted capture only for the same compaction boundary and live state", () => {
  const running: Message = {
    type: "compaction", status: "running", reason: "manual", summary: "", time,
    id: "msg_pending" as Message["id"],
  }
  const captured = captureDelivery([...corrected, running], binding)
  const stored: unknown = JSON.parse(JSON.stringify(captured))
  expect(captured?.compactionMessageId).toBe(running.id)
  expect(validateDelivery(stored, binding, running.id)).toEqual(captured)
  expect(validateDelivery(stored, binding, "msg_different")).toBeUndefined()
  expect(validateDelivery(stored, { ...binding, parentJournalPath: "C:/elsewhere" }, running.id)).toBeUndefined()
  expect(validateDelivery(stored, { ...binding, approval: { ...binding.approval, revision: "f".repeat(64) } }, running.id))
    .toBeUndefined()
})

test("a valid correction reference cannot silently fall back to the prior null value", () => {
  const messages = [...initial, correction, ack(), answer("stale-values", JSON.stringify({ ...report, auditRef: null }))]
  expect(inspectDelivery(messages, binding)).toEqual({ reason: "missing_evidence" })
})

test("an identical confirmed repeat can anchor a previously unsupported reference", () => {
  const prior = [initial[0]!, source, ack(), answer("prior"), correction]
  expect(captureDelivery([...prior, answer("repeat")], binding)?.recordedAnswer).toEqual(report)
  for (const text of [JSON.stringify({ ...report, total: 13 }), JSON.stringify({ ...report, auditRef: null })]) {
    expect(captureDelivery([...prior, answer("changed", text)], binding)).toBeUndefined()
  }
  expect(captureDelivery(prior, binding)).toBeUndefined()
})

test("unrelated tasks have no report contract", () => {
  expect(inspectDelivery([user("unrelated", "List the files."), ack(), answer("result")], binding))
    .toEqual({ reason: "no_contract" })
})

test("a one-off JSON report already delivered creates no continuation obligation", () => {
  const messages = [
    user("request", 'Return one JSON object with total and disposition.'), ack(),
    answer("result", '{"total":12,"disposition":"recheck"}'),
    compaction("cut"), user("continue", "Continue."),
  ]
  expect(inspectDelivery(messages, binding)).toEqual({ reason: "no_contract" })
  const incidental = user("incidental", "For each decision, check the input. Return one JSON object with total at the end.")
  expect(inspectDelivery([incidental, ...messages.slice(1)], binding)).toEqual({ reason: "no_contract" })
})

test("explicitly preserving the format on continuation creates an obligation", () => {
  const messages = [
    user("request", 'Return one JSON object with total. Keep this output contract when I ask you to continue.'),
    ack(), answer("result", '{"total":12}'),
  ]
  expect(captureDelivery(messages, binding)?.recordedAnswer).toEqual({ total: 12 })
})

test("a restarted owner can carry a report across consecutive cuts only while its task stays current", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alg-delivery-window-"))
  try {
    const runId = "owner-report"
    const live = { ...binding, parentJournalPath: join(directory, ".opencode", "runs", runId) }
    const request = { messages: [{ role: "user", content: [{ type: "text", text: "Continue." }] }], system: [] } as unknown as SessionContext
    const running = (name: string) => ({ ...compaction(name), status: "running" }) as Message
    const prepare = (rows: Message[], compacting: boolean) => new DeliveryContext().prepare(
      request, compacting, directory, runId, async () => rows, async () => live)
    await prepare([...corrected, running("first")], true)
    await prepare([compaction("first"), user("resume", "Continue."), answer("delivered"), running("second")], true)
    await prepare([compaction("second"), running("third")], true)
    await prepare([compaction("third"), user("new", "Inspect the other batch."), running("fourth")], true)
    await prepare([compaction("fourth"), user("resume4", "Continue.")], false)
    expect(request.system).toHaveLength(0)
    await prepare([compaction("third"), user("resume3", "Continue.")], false)
    expect(request.system[0]?.text).toContain("ALG delivery check: ready")
    expect(request.messages).toHaveLength(2)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test("canonical action aliases must agree exactly with the current decision", () => {
  for (const name of ["nextAction", "next_action"]) {
    const prior = [user("request", "For each decision, return one JSON object with " + name + "."), ack()]
    expect(captureDelivery([...prior, answer("matching", JSON.stringify({ [name]: binding.next_action }))], binding)
      ?.recordedAnswer).toEqual({ [name]: binding.next_action })
    for (const value of ["another-action", "RECHECK", null]) {
      expect(inspectDelivery([...prior, answer("conflict", JSON.stringify({ [name]: value }))], binding))
        .toEqual({ reason: "missing_evidence" })
    }
  }
})

test("an action identifier agrees with the same bound action carrying structured qualifiers", () => {
  const qualified = { ...binding, next_action: "recheck; prerequisite=audit-9" }
  const write = tool("qualified", "alg_investigation", {
    action: "set_next_measurement", expected_decision_revision: 1, next_action: qualified.next_action,
  }, {
    ok: true, runtimeSha256: qualified.runtimeSha256, revision: 6, decision_revision: 2,
    work: qualified.work, decision: { next_action: qualified.next_action },
  })
  const prior = [user("request", "For each decision return one JSON object with nextAction."), write]
  expect(captureDelivery([...prior, answer("matching", '{"nextAction":"recheck"}')], qualified)?.recordedAnswer)
    .toEqual({ nextAction: "recheck" })
  expect(captureDelivery([...prior, answer("conflict", '{"nextAction":"audit-9"}')], qualified)).toBeUndefined()
})

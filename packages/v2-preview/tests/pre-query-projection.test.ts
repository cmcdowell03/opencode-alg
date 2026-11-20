import { expect, test } from "bun:test"
import { Message, ProviderID, ToolOutput, ToolResultPart } from "@opencode/ai/effect"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { TOOL } from "../src/host.ts"
import { projectPreQueryReceipts } from "../src/pre-query-projection.ts"

type Messages = SessionContext["messages"]
const runtime = "a".repeat(64)
const manifest = "b".repeat(64)
const workKey = "c".repeat(64)
const pin = {
  id: "procedure-a", path: "skills/procedure-a/SKILL.md",
  sha256: "d".repeat(64), sourceSha256: "e".repeat(64),
}
const evidence = {
  revision: "f".repeat(40), path: "evidence/sample.json", sha256: "1".repeat(64),
  sampled_rows: 128, max_abs_skew_ms: 0.25, tolerance_ms: 0.5,
}

function receipt(status = "reserved") {
  return {
    ok: true, runtimeSha256: runtime, revision: 3, decision_revision: 2,
    work: { status, work_key: workKey, manifest_digest: status === "reusable" ? manifest : null },
    decision: { next_action: "Measure the approved temporal cohort" },
    approval: { revision: "2".repeat(64), procedure_sha256: pin.sha256 },
    preQuery: {
      skill: { pin: { ...pin }, availability: "verified", activation: "observed", catalog: "retained" },
      prerequisite: { status: "satisfied", evidence: { ...evidence }, mode: "recorded" },
      reuse: status === "reusable" ? { kind: "settled_manifest", work_key: workKey, manifest_digest: manifest } : null,
    },
    unknown: ["µ", { key: "keep me" }],
  }
}

function call(id: string, action: string, name = TOOL) {
  return Message.assistant({ type: "tool-call", id, name, input: { action } })
}

function result(id: string, value: unknown = receipt(), name = TOOL) {
  const output = ToolOutput.make({}, [{ type: "text", text: JSON.stringify(value) }])
  return Message.tool(ToolResultPart.make({ id, name, result: ToolOutput.toResultValue(output) }))
}

function exchange(id: string, action: string, value?: unknown) {
  return [call(id, action), result(id, value)] as const
}

function read(message: Messages[number]) {
  if (message.role !== "tool" || message.content[0]?.result.type !== "text") throw new Error("expected text tool result")
  const value = message.content[0].result.value
  if (typeof value !== "string") throw new Error("expected JSON text")
  return JSON.parse(value) as { preQuery: { skill: { pin: unknown }; prerequisite: { evidence: unknown } } }
}

const pinRef = (callId: string) => ({ ref: { callId, field: "preQuery.skill.pin" } })
const evidenceRef = (callId: string) => ({ ref: { callId, field: "preQuery.prerequisite.evidence" } })
const bytes = (messages: Messages) => Buffer.byteLength(JSON.stringify(messages))

test("retains the first full provenance and changes only the duplicate proof fields", () => {
  const latest = receipt("reusable")
  latest.preQuery.skill.activation = "not_observed"
  latest.revision++
  const raw: Messages = [
    Message.user("Continue the investigation"),
    ...exchange("call_admit", "admit"),
    ...exchange("call_dispatch", "dispatch", receipt("running")),
    ...exchange("call_reconcile", "reconcile", latest),
  ]
  for (const message of raw) {
    for (const part of message.content) Object.freeze(part)
    Object.freeze(message.content)
    Object.freeze(message)
  }
  Object.freeze(raw)
  const original = JSON.stringify(raw)
  const projected = projectPreQueryReceipts(raw, runtime)

  expect(projected.slice(0, 4)).toEqual(raw.slice(0, 4))
  expect(projected[5]).toBe(raw[5])
  expect(projected[4]).toEqual(result("call_dispatch", {
    ...receipt("running"),
    preQuery: {
      ...receipt("running").preQuery,
      skill: { ...latest.preQuery.skill, activation: "observed", pin: pinRef("call_admit") },
      prerequisite: { ...latest.preQuery.prerequisite, evidence: evidenceRef("call_admit") },
    },
  }))
  expect(projected[6]).toEqual(result("call_reconcile", {
    ...latest,
    preQuery: {
      ...latest.preQuery,
      skill: { ...latest.preQuery.skill, pin: pinRef("call_admit") },
      prerequisite: { ...latest.preQuery.prerequisite, evidence: evidenceRef("call_admit") },
    },
  }))
  expect(bytes(raw) - bytes(projected)).toBeGreaterThan(400)
  expect(JSON.stringify(raw)).toBe(original)
  expect(projectPreQueryReceipts(projected, runtime)).toBe(projected)
  for (let end = 0; end <= raw.length; end++) {
    expect(projectPreQueryReceipts(raw.slice(0, end), runtime)).toEqual(projected.slice(0, end))
  }
})

test("uses canonical exact equality independently for each proof field", () => {
  const changed = receipt()
  const { sourceSha256, ...rest } = pin
  changed.preQuery.skill.pin = { sourceSha256, ...rest }
  changed.preQuery.prerequisite.evidence.max_abs_skew_ms = 0.25000000000000006
  const raw = [
    ...exchange("first", "admit"),
    ...exchange("changed", "dispatch", changed),
    ...exchange("repeat", "reconcile", changed),
  ]
  const projected = projectPreQueryReceipts(raw, runtime)
  expect(read(projected[3]!).preQuery.skill.pin).toEqual(pinRef("first"))
  expect(read(projected[3]!).preQuery.prerequisite.evidence).toEqual(changed.preQuery.prerequisite.evidence)
  expect(read(projected[5]!).preQuery.prerequisite.evidence).toEqual(evidenceRef("changed"))
})

test("rebuilds anchors from the retained raw window and respects native compaction boundaries", () => {
  const first = exchange("first", "admit")
  const second = exchange("second", "dispatch")
  const third = exchange("third", "reconcile")
  const checkpoint = Message.assistant({
    type: "compaction", provider: ProviderID.make("openai"), encrypted: "opaque",
  })
  for (const raw of [[first[1], ...second, ...third], [...first, checkpoint, ...second, ...third]]) {
    const projected = projectPreQueryReceipts(raw, runtime)
    expect(projected.at(-3)).toBe(second[1])
    expect(read(projected.at(-1)!).preQuery.prerequisite.evidence).toEqual(evidenceRef("second"))
  }
  const onlyLatest = [...third]
  expect(projectPreQueryReceipts(onlyLatest, runtime)).toBe(onlyLatest)
})

test("skips malformed, unverified, unsuccessful, and foreign-runtime receipts as anchors or targets", () => {
  const unchecked = receipt()
  unchecked.preQuery.prerequisite.status = "unchecked"
  const unverified = receipt()
  unverified.preQuery.skill.availability = "unverified"
  const wrongType = Message.tool(ToolResultPart.make({
    id: "bad", name: TOOL, result: receipt(), resultType: "json",
  }))
  const hostError = Message.tool(ToolResultPart.make({
    id: "bad", name: TOOL, result: JSON.stringify(receipt()), resultType: "error",
  }))
  const corrupt = (text: string) => Message.tool(ToolResultPart.make({
    id: "bad", name: TOOL, result: text, resultType: "text",
  }))
  const invalidResults = [
    result("bad", unchecked),
    result("bad", unverified),
    result("bad", { ...receipt(), ok: false, error: "RESEARCH_PROCEDURE_UNVERIFIED" }),
    result("bad", { ...receipt(), runtimeSha256: "0".repeat(64) }),
    corrupt("{"),
    corrupt(JSON.stringify(receipt()).replace('"ok":true', '"ok":false,"ok":true')),
    wrongType,
    hostError,
  ]
  for (const invalid of invalidResults) {
    const asAnchor = [call("bad", "admit"), invalid, ...exchange("good", "dispatch")]
    const asTarget = [...exchange("good", "admit"), call("bad", "dispatch"), invalid]
    expect(projectPreQueryReceipts(asAnchor, runtime)).toBe(asAnchor)
    expect(projectPreQueryReceipts(asTarget, runtime)).toBe(asTarget)
  }
  const raw = [...exchange("first", "admit"), ...exchange("second", "dispatch")]
  expect(projectPreQueryReceipts(raw, "unverified runtime")).toBe(raw)
})

test("preserves unknown or invalid proof fields while still projecting a proven sibling", () => {
  const base = receipt()
  const extended = {
    ...base,
    preQuery: {
      ...base.preQuery,
      skill: { ...base.preQuery.skill, pin: { ...pin, future: "keep" } },
    },
  }
  const raw = [...exchange("first", "admit", extended), ...exchange("second", "dispatch", extended)]
  const projected = projectPreQueryReceipts(raw, runtime)
  expect(read(projected[3]!).preQuery.skill.pin).toEqual(extended.preQuery.skill.pin)
  expect(read(projected[3]!).preQuery.prerequisite.evidence).toEqual(evidenceRef("first"))

  const invalid = receipt()
  invalid.preQuery.prerequisite.evidence.max_abs_skew_ms = 1
  const samples = [...exchange("first", "admit", invalid), ...exchange("second", "dispatch", invalid)]
  expect(read(projectPreQueryReceipts(samples, runtime)[3]!).preQuery.prerequisite.evidence)
    .toEqual(invalid.preQuery.prerequisite.evidence)
})

test("requires one earlier unqualified ALG call and one result per nonempty ID", () => {
  const first = exchange("first", "admit")
  const second = exchange("second", "dispatch")
  const other = "other_investigation"
  const hosted = Message.assistant({ type: "tool-call", id: "first", name: TOOL,
    input: { action: "admit" }, providerExecuted: true })
  const namespaced = Message.assistant({ type: "tool-call", id: "first", name: TOOL,
    input: { action: "admit" }, namespace: "other" })
  const invalidWindows = [
    [first[1], ...second],
    [first[1], first[0], ...second],
    [call("wrong-id", "admit"), first[1], ...second],
    [call("first", "admit", other), first[1], ...second],
    [first[0], result("first", receipt(), other), ...second],
    [call("first", "status"), first[1], ...second],
    [hosted, first[1], ...second],
    [namespaced, first[1], ...second],
    [...exchange("", "admit"), ...second],
    [...first, second[1]],
    [...first, ...second, call("first", "status", other)],
    [...first, ...second, result("second", receipt(), other)],
  ]
  for (const raw of invalidWindows) expect(projectPreQueryReceipts(raw, runtime)).toBe(raw)
})

test("keeps full fields when the reference would increase encoded size", () => {
  const raw = [...exchange("call_" + "x".repeat(512), "admit"), ...exchange("second", "dispatch")]
  expect(projectPreQueryReceipts(raw, runtime)).toBe(raw)
})

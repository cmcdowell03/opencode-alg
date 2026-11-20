import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { algTool } from "../acceptance/host.ts"
import { changeHandoff, nativeWake, sameVerifiedReport } from "./child-audit-acceptance.ts"
import { auditWire, childAudit, classifyChildAudit, scriptedChildAudit } from "./child-audit-script.ts"
import { calculationMarker } from "./delivery-script.ts"
import { checkerPrompt, handoffHeader } from "./evidence-handoff-case.ts"
import type { Message } from "./transport.ts"

const wakeText = '<subagent sessionID="child" state="completed">\n{"verifiedClockCorrections":91}\n</subagent>'
const gotAudit = { measurements: { verifiedClockCorrections: 2 }, references: { auditRef: "child-ref" } }
const projected = { values: gotAudit.measurements, references: gotAudit.references }
const report = (evidenceReport: object) => ({ role: "tool", content: JSON.stringify({ ok: true, evidenceReport }) })
const wake = { role: "user", content: wakeText }
const sourced = { role: "user", content: calculationMarker + JSON.stringify(projected) }
const decide = (messages: Message[]) => scriptedChildAudit({ messages, tools: [algTool], summary: false }, "wake")

test("native wake must obtain plugin-projected data and installed status before decision work", () => {
  const provisional = report({ status: "provisional", ...gotAudit })
  expect(decide([wake])).toEqual({ tool: algTool, args: { action: "status" } })
  expect(decide([wake, provisional])).toEqual({ text: '{"status":"child-evidence-unavailable"}' })
  expect(decide([{ ...sourced, role: "assistant" }, wake, provisional]))
    .toEqual({ text: '{"status":"child-evidence-unavailable"}' })
  expect(decide([sourced, sourced, wake, provisional])).toEqual({ text: '{"status":"child-evidence-unavailable"}' })
  expect(decide([sourced, wake, provisional])).toEqual({ tool: algTool, args: { action: "admit" } })
  expect(decide([sourced, { role: "user", content: handoffHeader + "\n{}" }, wake, provisional]))
    .toEqual({ text: '{"status":"child-evidence-unavailable"}' })
  expect(auditWire([sourced, wake])).toMatchObject({
    calculation: { projections: 1, values: gotAudit.measurements }, references: gotAudit.references, nativeNotices: 1, explicitHandoffs: 0,
  })
})

test("scope classification requires the pinned host's child prompt wrapper in a user message", () => {
  const child = "You are a subagent spawned by another session.\n\n" + checkerPrompt
  expect(classifyChildAudit([{ role: "user", content: child }], "wake")).toEqual({ role: "checker", phase: "audit" })
  expect(classifyChildAudit([{ role: "assistant", content: child }, { role: "user", content: checkerPrompt }], "wake"))
    .toEqual({ role: "root", phase: "wake" })
})

test("only a matching native synthetic notification and a new idle boundary qualify as an autonomous wake", () => {
  type Row = SessionMessageInfo
  const id = (value: string) => ("msg_" + value) as Row["id"]
  const time = { created: 1, completed: 2 }
  const idle: Row = { id: id("before"), type: "idle", outcome: "succeeded", time }
  const notice: Row = { id: id("notice"), type: "synthetic", text: wakeText, time,
    metadata: { source: "subagent", childID: "child", agent: childAudit.agent, state: "completed" } }
  const answer: Row = { id: id("answer"), type: "assistant", agent: "build", finish: "stop", time,
    model: { id: "fixture", providerID: "paired-benchmark" },
    content: [{ type: "text", text: "answer" }] }
  const end: Row = { ...idle, id: id("after") }
  const user: Row = { id: id("operator"), type: "user", text: handoffHeader + "\n{}", time }
  expect(nativeWake([idle, notice, answer, end], idle.id, "child")).toMatchObject({ notice, idleId: end.id, answer: "answer" })
  expect(nativeWake([idle, notice, user, answer, end], idle.id, "child")).toBeUndefined()
  expect(nativeWake([idle, notice, answer, end], idle.id, "other-child")).toBeUndefined()
  expect(nativeWake([idle, notice, notice, answer, end], idle.id, "child")).toBeUndefined()
  expect(nativeWake([idle, notice, answer], idle.id, "child")).toBeUndefined()
})

test("idempotence compares installed report and decision revisions and the perturbation keeps the same reference", () => {
  const status = { id: "status", input: { action: "status" }, value: { ok: true, runtimeSha256: "runtime", revision: 4,
    decision_revision: 1, decision: { next_action: "retry" }, evidenceReport: { status: "verified" } } }
  expect(sameVerifiedReport(status, { ...status, id: "another-call" }, "runtime")).toBe(true)
  expect(sameVerifiedReport(status, { ...status, value: { ...status.value, decision_revision: 2 } }, "runtime")).toBe(false)
  expect(sameVerifiedReport(status, status, "other-runtime")).toBe(false)
  const input = handoffHeader + '\n{"auditRef":"child-ref","auditRows":[{"status":"verified"},{"status":"rejected"}]}'
  expect(changeHandoff(input)).toBe(handoffHeader + '\n{"auditRef":"child-ref","auditRows":[{"status":"rejected"},{"status":"rejected"}]}')
})

import { expect, test } from "bun:test"
import { sha256 } from "../acceptance/runtime.ts"
import type { RequestObservation } from "../benchmark/compaction.ts"
import { nativeBody } from "../benchmark/native-observer.ts"
import { observeSkillDelivery, continuationSkillDelivery } from "../benchmark/skill-delivery.ts"

const witness = 'Check "clock".\nThen compare.'
const pin = { id: "procedure", sha256: sha256(witness), witness }
const projection = "ALG current approved research procedure procedure (SHA-256 " + pin.sha256 + ")\n" + witness
const result = JSON.stringify({ ok: true, procedure: { id: pin.id, sha256: pin.sha256, content: witness } })

test("Responses preserves instruction fields, message roles and both kinds of tool output", () => {
  const body = { model: "offline", stream: true, instructions: projection, input: [
    { type: "message", role: "developer", content: [{ type: "input_text", text: projection }] },
    { type: "custom_tool_call_output", call_id: "1", output: [{ type: "input_text", text: result }] },
    { type: "function_call", name: "ignored", arguments: projection },
    { type: "message", role: "assistant", content: [{ type: "output_text", text: projection }] },
  ] }
  const seen = observeSkillDelivery(nativeBody(JSON.stringify(body), "offline").messages, pin)
  expect(seen.roles).toEqual(["instructions", "developer", "tool", "assistant"])
  expect(seen.projectionRoles).toEqual(["instructions", "developer"])
  for (const type of ["function_call_output", "custom_tool_call_output"]) {
    const wire = { ...body, instructions: "", input: [{ type, role: "system", output: result }] }
    expect(observeSkillDelivery(nativeBody(JSON.stringify(wire), "offline").messages, pin)).toEqual({
      bodySha256: pin.sha256, roles: ["tool"], projectionRoles: [],
    })
  }
})

test("compares the whole body within a text part and keeps echoes separate from host projection", () => {
  const samples = [
    { role: "system", content: [{ type: "text", text: "Check \"clock\"." }, { type: "text", text: "Then compare." }] },
    { role: "developer", content: [{ type: "image_url", text: projection }] },
    { role: "assistant", content: projection },
    { role: "user", content: projection },
    { role: "tool", content: JSON.stringify({ ok: false, procedure: { content: witness } }) },
    { role: "other", content: projection },
  ]
  expect(observeSkillDelivery(samples, pin)).toEqual({ bodySha256: pin.sha256,
    roles: ["assistant", "user", "unclassified"], projectionRoles: [] })
  expect(observeSkillDelivery([{ role: "system", content: witness }], pin).projectionRoles).toEqual([])
  expect(observeSkillDelivery([{ role: "system", content: projection }], undefined).roles).toEqual([])
})

test("binds each role observation to a successful root request with the matched summary before the answer", () => {
  const skillDelivery = observeSkillDelivery([{ role: "system", content: projection }], pin)
  const row = { requestId: 7, stage: "continue" as const, observedAtMs: 11, summarySha256: "sum", skillDelivery }
  const request: RequestObservation = { id: 7, kind: "ordinary", role: "root", phase: "continue", startedAtMs: 10,
    finishedAtMs: 12, status: 200, stale: false, oldSummary: true, correction: false, skill: true, tools: [] }
  const check = (rows = [row], requests = [request]) => continuationSkillDelivery(rows, requests, "sum", 13, pin.sha256)
  expect(check()).toMatchObject({ complete: true, roles: ["system"], projectionRoles: ["system"] })
  expect(check([{ ...row, skillDelivery: observeSkillDelivery([], pin) }])).toMatchObject({ complete: true, roles: [] })
  for (const bad of [check([]), check([row, row]), check([row], [{ ...request, role: "checker" }]),
    check([row], [{ ...request, kind: "summary" }]), check([row], [{ ...request, status: 429 }]),
    check([row], [{ ...request, finishedAtMs: 14 }]), check([{ ...row, observedAtMs: 9 }]),
    check([{ ...row, observedAtMs: 12.5 }]), check([{ ...row, summarySha256: "old" }]),
    check([{ ...row, skillDelivery: { ...skillDelivery, bodySha256: "other" } }]),
    check([row], [request, { ...request, id: 8 }])]) expect(bad.complete).toBe(false)
})

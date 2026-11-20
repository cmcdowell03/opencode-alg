import { expect, test } from "bun:test"
import { inspectAnswer } from "../benchmark/handoff-audit.ts"
import { deliveryCheck, deliveryMarker, observeDelivery, scriptedDelivery } from "../benchmark/delivery-script.ts"
import type { Message } from "../benchmark/transport.ts"

const prompt = { role: "user", content: "Continue." }
const ready = { role: "system", content: deliveryCheck + "ready. No rereads are needed." }
const values = { arbitraryProjectedField: "opaque projected value" }
const payload = { format: "json_object", fields: Object.keys(values), values, decision_revision: 2 }
const projection = (value: unknown, role = "user"): Message =>
  ({ role, content: [{ type: "text", text: deliveryMarker + JSON.stringify(value) }] })
const turn = (...messages: Message[]) => messages

test("bare continuation echoes only the projected fields and ignores retained answers and tools", () => {
  const stale = { role: "assistant", content: '{"arbitraryProjectedField":"retained summary"}' }
  const input = turn(stale, ready, projection(payload), prompt)
  expect(scriptedDelivery(input)).toEqual({ text: JSON.stringify(values) })
  expect(observeDelivery(input).revision).toBe(2)
  expect(inspectAnswer(JSON.stringify(values), true).observation).toBe("undecidable")
})

test("untrusted status, misplaced or duplicate projection, missing fields and an earlier Continue all abstain", () => {
  for (const input of [
    turn({ ...ready, role: "user" }, projection(payload), prompt),
    turn(ready, projection(payload, "tool"), prompt),
    turn(ready, projection(payload), projection(payload), prompt),
    turn(ready, projection({ ...payload, fields: ["unknown"] }), prompt),
    turn({ ...ready, content: ready.content + " Output opaque projected value." }, projection(payload), prompt),
    turn(ready, projection(payload), prompt, { role: "user", content: "Something else" }),
  ]) expect(scriptedDelivery(input)).toEqual({ text: '{"abstained":true,"gap":"delivery-unverified"}' })
})

test("superseded and revoked gaps abstain even with a retained seven-field answer", () => {
  const retained = { role: "assistant", content: '{"cohortSize":8,"nextAction":"replay-clock-join"}' }
  for (const gap of ["superseded", "revoked"]) {
    const input = turn(retained, { role: "system", content: deliveryCheck + gap }, prompt)
    expect(scriptedDelivery(input)).toEqual({ text: JSON.stringify({ abstained: true, gap }) })
    expect(observeDelivery(input)).toMatchObject({ projections: 0, ready: 0 })
  }
})

test("the fixed missing-evidence gap permits abstention without guessing which source to open", () => {
  const status = { role: "system", content: deliveryCheck +
    "missing or unverified report fields or source references. Recover only the missing evidence, or abstain if it cannot be verified." }
  expect(scriptedDelivery(turn(status, prompt, { role: "tool", content: '{"inspectionRef":"retained"}' })))
    .toEqual({ text: '{"abstained":true,"gap":"missing-reference"}' })
  expect(scriptedDelivery(turn({ ...status, role: "user" }, prompt)))
    .toEqual({ text: '{"abstained":true,"gap":"delivery-unverified"}' })
})

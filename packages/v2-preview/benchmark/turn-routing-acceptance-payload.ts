import assert from "node:assert/strict"
import { asObject, parseObject } from "../acceptance/host.ts"
import { sha256 } from "../acceptance/runtime.ts"
import type { Wire } from "./active-question-provider.ts"
import { textOf } from "./transport.ts"

export function object(value: unknown, label: string) {
  const row = asObject(value)
  assert.ok(row, label)
  return row
}

export function rows(value: unknown, label: string) {
  assert.ok(Array.isArray(value), label)
  return value.map(row => object(row, label))
}

export function string(value: unknown, label: string) {
  assert.ok(typeof value === "string" && value.length > 0, label)
  return value
}

export function latestTool(wire: Wire) {
  const message = wire.messages.slice().reverse().find(message => message.role === "tool")
  const text = textOf(message?.content)
  return object(parseObject(text), `Expected native tool receipt: ${text.slice(0, 500)}`)
}

export function scopedFinding(receipt: Record<string, unknown>) {
  assert.equal(receipt.ok, true, JSON.stringify(receipt))
  const [finding, ...rest] = rows(object(receipt.evidence, "Missing scoped evidence").findings, "Missing scoped findings")
  assert.ok(finding && rest.length === 0, "Expected exactly one scoped finding")
  return finding
}

export function savedCalculation(
  prompt: string,
  finding: Record<string, unknown>,
  snapshotReceipt: Record<string, unknown>,
  procedureReceipt: Record<string, unknown>,
) {
  assert.equal(finding.status, "supported")
  assert.equal(snapshotReceipt.ok, true, JSON.stringify(snapshotReceipt))
  assert.equal(procedureReceipt.ok, true, JSON.stringify(procedureReceipt))
  const requested = /raw P-42 reading of (\d+(?:\.\d+)?) kPa/i.exec(prompt)
  assert.ok(requested, "Missing raw reading in the user's current payload")
  const raw = Number(requested[1])
  const [citation, ...otherCitations] = rows(finding.support, "Missing saved finding citation")
  assert.ok(citation && !otherCitations.length, "Expected one saved calibration reference")
  const snapshot = object(snapshotReceipt.evidence_snapshot, "Missing historical snapshot")
  assert.equal(snapshot.cache_enabled, true)
  assert.deepEqual(snapshot.missing, [])
  const [entry, ...otherRows] = rows(snapshot.evidence, "Missing snapshot rows")
  assert.ok(entry && !otherRows.length, "Expected one cached row")
  assert.deepEqual(entry.source, citation, "Cached row differs from the scoped finding's live citation")
  const data = object(entry.data, "Missing cached operands")
  const procedure = object(procedureReceipt.procedure, "Missing live approved procedure")
  const content = string(procedure.content, "Missing live approved procedure body")
  const procedureSha256 = string(procedure.sha256, "Missing live approval hash")
  assert.equal(sha256(content), procedureSha256, "Procedure body and approval hash differ")
  const rule = /^Corrected pressure \(kPa\) = \(raw ([-+]) ([a-z][a-zA-Z0-9_]*)\) \* ([a-z][a-zA-Z0-9_]*)\.$/m.exec(content)
  assert.ok(rule, "Approved procedure omitted the fixture calculation rule")
  const firstField = rule[2]!, secondField = rule[3]!
  const first = data[firstField], second = data[secondField]
  assert.ok(typeof first === "number" && Number.isFinite(first), `Missing numeric operand ${firstField}`)
  assert.ok(typeof second === "number" && Number.isFinite(second), `Missing numeric operand ${secondField}`)
  const value = (rule[1] === "+" ? raw + first : raw - first) * second
  assert.ok(Number.isFinite(value), "Nonfinite corrected pressure")
  const reference = string(citation.reference, "Missing cited row reference")
  const procedurePath = string(procedure.path, "Missing live procedure path")
  return {
    text: `The corrected pressure is ${value.toFixed(2)} kPa. Calibration: [${reference}]. Procedure: [${procedurePath}].`,
    value, raw, operands: { [firstField]: first, [secondField]: second }, rule: rule[0],
    citation, procedure: { path: procedurePath, sha256: procedureSha256 },
  }
}

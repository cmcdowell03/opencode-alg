import { expect, test } from "bun:test"
import { z } from "zod"
import type { EvidenceFinding, EvidenceReadView, SourceReceipt } from "../src/evidence-reads.ts"
import { buildSynthesisReadout, synthesisRequestSchema } from "../src/synthesis.ts"

const digest = "a".repeat(64)
const link: SourceReceipt = {
  id: digest, sha256: digest, tool: "read", path: "rows.json", reference: "rows.json#one",
  messageId: "msg-1", callId: "call-1", receipt: "receipt-1",
}

function view(overrides: Partial<EvidenceFinding> = {}, receipt = link): EvidenceReadView {
  return {
    revision: 1, question: null,
    sources: [{ ...receipt, status: "inspected", references: [receipt] }],
    findings: [{
      id: "claim", attribution: "model", status: "supported", interpretation: "Observed only in the sample.",
      scope: "sample", support: [receipt], counterevidence: [], ...overrides,
    }],
  }
}

test("request is strict, unique, and bounded with validated baseline keys and hashes", () => {
  const tooMany = Array.from({ length: 17 }, (_, i) => "id-" + i)
  for (const input of [
    {}, { claims: [], extra: true }, { claims: ["same", "same"] }, { claims: tooMany },
    { claims: ["with space"] }, { claims: [], baseline: [] }, { claims: [], baseline: { "#row": digest } },
    { claims: [], baseline: { claim: "x".repeat(64) } },
    { claims: [], baseline: Object.fromEntries(tooMany.map(id => [id, digest])) },
  ]) expect(synthesisRequestSchema.safeParse(input).success).toBe(false)
  expect(synthesisRequestSchema.safeParse({ claims: [], baseline: { claim: digest } }).success).toBe(true)
})

test("answers only an explicit complete set with exact accessible citations", () => {
  const evidence = view()
  const readout = buildSynthesisReadout(evidence, { claims: ["claim"] })
  expect(readout).toMatchObject({
    selection: "explicit", coverage: "selected-claims-only", interpretationAttribution: "model",
    nextMove: "answer-selected", truncated: false,
    claims: [{ id: "claim", state: "supported-scoped", scope: "sample", support: [{ id: digest, tool: link.tool, reference: link.reference, sha256: digest }] }],
  })
  expect(buildSynthesisReadout(evidence, { claims: [] })).toMatchObject({
    selection: "all-recorded", coverage: "selected-claims-only", nextMove: "select-claims",
  })
  expect(buildSynthesisReadout(evidence, { claims: ["claim", "unknown"] })).toMatchObject({
    nextMove: "assess-unrecorded", claims: [{ id: "claim" }, { id: "unknown", state: "unknown", signature: null }],
  })
  expect(readout.claims[0]!.support![0]).not.toHaveProperty("callId")
  evidence.sources[0]!.references = [{ ...link, callId: "repeated-native-call" }]
  expect(buildSynthesisReadout(evidence, { claims: ["claim"] })).toEqual(readout)
  evidence.sources[0]!.references = [{ ...link, id: "b".repeat(64) }]
  expect(buildSynthesisReadout(evidence, { claims: [] }).nextMove).toBe("recheck")
  expect(buildSynthesisReadout(evidence, { claims: ["claim"] })).toMatchObject({
    nextMove: "recheck", claims: [{ state: "invalidated", unavailable: [{ relation: "support", reference: link.reference }] }],
  })
})

test("reports open, missing, contested, invalidated and unverified numeric evidence", () => {
  const check = (evidence: EvidenceReadView) => buildSynthesisReadout(evidence, { claims: ["claim"] })
  expect(check(view({ scope: undefined })).claims[0]?.state).toBe("open-unscoped")
  expect(check(view({ missingEvidence: "Sample size is unknown." }))).toMatchObject({
    nextMove: "scoped-indeterminate", claims: [{ state: "missing", missingEvidence: "Sample size is unknown." }],
  })
  const counter = { ...link, id: "b".repeat(64), reference: "rows.json#two" }
  const contested = view({ status: "contested", counterevidence: [counter] })
  contested.sources[0]!.references.push(counter)
  expect(check(contested)).toMatchObject({
    nextMove: "scoped-indeterminate", claims: [{ state: "contested", counterevidence: [{ id: counter.id, tool: counter.tool, reference: counter.reference, sha256: counter.sha256 }] }],
  })
  const invalidated = [{ relation: "counterevidence" as const, reference: counter.reference }]
  expect(check(view({ invalidatedSources: invalidated }))).toMatchObject({
    nextMove: "recheck", claims: [{ state: "invalidated", invalidated }],
  })
  expect(check(view({ numericVerification: { status: "mismatch" } }))).toMatchObject({
    nextMove: "scoped-indeterminate", claims: [{ state: "numeric-unverified", numericVerification: { status: "mismatch" } }],
  })
})

test("compares only selected IDs and hashes logical source facts independently of native receipt churn", () => {
  const original = view({ numericVerification: { status: "verified", value: 1, references: [link.reference] },
    numericEvidenceSha256: digest })
  const prior = buildSynthesisReadout(original, { claims: ["claim"] }).claims[0]!.signature!
  const churn = view({ numericVerification: original.findings[0]!.numericVerification, numericEvidenceSha256: "c".repeat(64) },
    { ...link, id: "b".repeat(64), callId: "new-call", messageId: "new-message", receipt: "new-receipt" })
  churn.revision++
  churn.findings.push({ ...churn.findings[0]!, id: "new" })
  const request = { claims: ["claim", "gone", "new", "never"], baseline: { claim: prior, gone: digest, ignored: digest } }
  expect(buildSynthesisReadout(churn, request).changes).toEqual(["unchanged", "disappeared", "added", "absent"])
  churn.sources[0]!.sha256 = "b".repeat(64)
  expect(buildSynthesisReadout(churn, request).changes?.[0]).toBe("changed")
  churn.sources[0]!.sha256 = link.sha256
  churn.findings[0]!.scope = "another sample"
  expect(buildSynthesisReadout(churn, request).changes?.[0]).toBe("changed")
  const moved = view(original.findings[0]!, { ...link, reference: "rows.json#other" })
  moved.findings[0]!.support = moved.sources[0]!.references
  expect(buildSynthesisReadout(moved, request).changes?.[0]).toBe("changed")
})

test("preserves every ID and state under escaped UTF-8 pressure, with exact omitted detail and full signatures", () => {
  const evidence = view()
  const escapeHeavy = ("\u0000\ud800😀").repeat(256)
  const receipts = Array.from({ length: 16 }, (_, index) => ({
    ...link, id: index.toString(16).padStart(64, "0"), reference: "rows.json#r" + index,
    messageId: escapeHeavy.slice(0, 256), callId: escapeHeavy.slice(0, 256),
    cachedBytes: "SOURCE_BODY_MARKER",
  }))
  evidence.sources[0]!.references = receipts
  evidence.findings = Array.from({ length: 16 }, (_, index) => ({
    ...evidence.findings[0]!, id: String(index).padStart(128, "x"),
    interpretation: escapeHeavy, scope: escapeHeavy.slice(0, 256), support: receipts,
  }))
  const claims = evidence.findings.map(row => row.id)
  const supported = buildSynthesisReadout(evidence, { claims })
  expect(supported).toMatchObject({ nextMove: "read-detail", truncated: true })
  expect(supported.claims.every(row => row.state === "supported-scoped")).toBe(true)
  expect(Buffer.byteLength(JSON.stringify(supported))).toBeLessThanOrEqual(16 * 1024)
  for (const row of supported.claims.filter(row => row.omitted)) {
    expect(row.detail).toEqual({ finding_id: row.id })
  }

  evidence.findings[15]!.missingEvidence = "A deciding observation is absent."
  const first = buildSynthesisReadout(evidence, { claims, baseline: {} })
  const json = JSON.stringify(first)
  expect(Buffer.byteLength(json)).toBeLessThanOrEqual(16 * 1024)
  expect(json).not.toContain("SOURCE_BODY_MARKER")
  expect(buildSynthesisReadout(evidence, { claims, baseline: {} })).toEqual(first)
  expect(first.claims.map(row => row.id)).toEqual(claims)
  expect(first.claims[0]?.state).toBe("supported-scoped")
  expect(first.claims[15]).toMatchObject({ state: "missing", missingEvidence: "A deciding observation is absent.",
    detail: { finding_id: claims[15] } })
  expect(first.nextMove).toBe("scoped-indeterminate")
  expect(first.truncated).toBe(true)
  const omitted = first.claims.find(row => row.omitted?.includes("interpretation"))!
  expect(omitted.detail).toEqual({ finding_id: omitted.id })
  evidence.findings.find(row => row.id === omitted.id)!.interpretation += "changed"
  const next = buildSynthesisReadout(evidence, { claims, baseline: { [omitted.id]: omitted.signature! } })
  expect(next.changes?.[claims.indexOf(omitted.id)]).toBe("changed")
})

test("literal prototype-like finding IDs are preserved and use own baseline entries", () => {
  const evidence = view({ id: "__proto__" })
  const current = buildSynthesisReadout(evidence, { claims: ["__proto__"] }).claims[0]!.signature!
  const request = synthesisRequestSchema.parse({
    claims: ["__proto__", "constructor", "toString"],
    baseline: Object.fromEntries([["__proto__", current], ["constructor", digest]]),
  })
  expect(Object.keys(request.baseline!)).toEqual(["__proto__", "constructor"])
  expect(buildSynthesisReadout(evidence, request).changes).toEqual(["unchanged", "disappeared", "absent"])
  expect(synthesisRequestSchema.safeParse({ claims: [], baseline: Object.fromEntries([["__proto__", "bad"]]) }).success)
    .toBe(false)
  expect(z.toJSONSchema(synthesisRequestSchema).properties?.baseline).toMatchObject({
    type: "object", maxProperties: 16,
  })
})

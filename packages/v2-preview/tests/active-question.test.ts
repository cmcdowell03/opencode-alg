import { expect, test } from "bun:test"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { ActiveQuestionProjection, activeQuestion } from "../src/active-question.ts"
import type { EvidenceFinding, EvidenceReadView, SourceReceipt } from "../src/evidence-reads.ts"

const view = { decision_revision: 2, decisionSources: undefined, decision: {
  next_action: "Check source coverage.",
} }
const approval = { approval: "not_configured" } as const

function request(): Pick<SessionContext, "messages" | "system"> {
  return { messages: [{ role: "user", content: [{ type: "text", text: "Continue." }] }], system: [] }
}

test("the pinned checker question comes with a concrete action", () => {
  const finding: EvidenceFinding = { id: "pinned", interpretation: "A question to check.", status: "unresolved",
    attribution: "model", support: [], counterevidence: [] }
  const evidence = { revision: 1, sources: [], findings: [finding], question: {
    findingId: "pinned", text: "Does the observed coverage include the second shift?",
  } }
  expect(activeQuestion(view, evidence, approval)).toMatchObject({
    state: "investigate", question: evidence.question.text, finding: { id: finding.id },
    next_action: expect.stringContaining("relevant current references"),
  })
  expect(activeQuestion(null, { ...evidence, findings: [], question: null }, approval))
    .toMatchObject({ state: "investigate", reason: "initialize", question: expect.any(String), next_action: expect.any(String) })
})

test("maximum-length valid references keep the active revalidation brief bounded", () => {
  const receipt = (index: number): SourceReceipt => {
    const path = String(index).padStart(251, "x") + ".json"
    return { path, reference: path + "#" + "r".repeat(128), id: String(index).padStart(64, "a"),
      tool: "reader", messageId: "msg", callId: "call", receipt: "receipt", sha256: "c".repeat(64) }
  }
  const summary = "</context>\t👋".repeat(73)
  const findings: EvidenceFinding[] = Array.from({ length: 16 }, (_, index) => ({
    id: String(index).padStart(128, "f"), interpretation: summary, scope: summary.slice(0, 252),
    falsifier: summary, missingEvidence: summary, status: "contested", attribution: "model",
    support: Array.from({ length: 16 }, (_, n) => receipt(n)),
    counterevidence: Array.from({ length: 16 }, (_, n) => receipt(n + 16)),
    invalidatedSources: Array.from({ length: 16 }, (_, n) => ({ relation: "support", reference: receipt(n + 32).reference })),
  }))
  const evidence: EvidenceReadView = { revision: 4, findings, sources: [], question: { findingId: findings[0]!.id, text: summary } }
  const output = request()
  new ActiveQuestionProjection().project(output, activeQuestion(view, evidence, approval), "0".repeat(64), false)
  const part = output.messages[0]!.content[0]
  if (part?.type !== "text") throw new Error("Expected a projected brief")
  expect(Buffer.byteLength(part.text)).toBeLessThan(6144)
  expect(part.text).not.toContain("</context>")
  const brief = JSON.parse(part.text.slice(part.text.indexOf("\n") + 1))
  expect(brief).toMatchObject({ state: "revalidate", omitted_affected_findings: 8,
    finding: { id: findings[0]!.id, support: [receipt(0).reference, receipt(1).reference], omitted_references: 42 } })
})

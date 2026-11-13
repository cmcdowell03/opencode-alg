import { expect, test } from "bun:test"
import { gradeLiveActionEvidenceCase } from "../scripts/action-evidence-live-regression.ts"

function fixture(caseId: "correct" | "defective") {
  const intentHash = "1".repeat(64), terminalHash = "2".repeat(64), manifestHash = "3".repeat(64)
  const refs = [intentHash, terminalHash].map((hash, index) => ({ artifact_path: `.opencode/runs/run/artifacts/${index}-${hash}.json`, sha256: hash, byte_size: 128 }))
  const receipts = refs.map((reference, index) => ({ id: `R${"a".repeat(63)}${index}`, reference, offset: 0, total_bytes: 128,
    content: `record-${index}`, value_sha256: `${index ? "b" : "c"}`.repeat(64) }))
  const tools = [
    { tool: "alg_artifact", state: { status: "completed", input: { evidence: "index" }, output: JSON.stringify({ records: refs.map((reference, index) => ({ record_id: reference.sha256, kind: index ? "terminal" : "intent" })) }) } },
    ...refs.map((reference, index) => ({ tool: "alg_artifact", state: { status: "completed", input: { evidence: "read", record_id: reference.sha256, offset: 0 },
      output: JSON.stringify({ citation_id: receipts[index]!.id, receipt: receipts[index], content: receipts[index]!.content }) } })),
  ]
  const exitCode = caseId === "correct" ? 0 : 7
  const producer = { manifest_sha256: manifestHash, observed_calls: 10, completed: 10, unknown_terminal: 0,
    first_records: { intent: refs[0], terminal: refs[1] }, first_terminal: { exit_code: exitCode },
    checker_provider_id: "openai", checker_model_id: "gpt-6-luna" }
  const output = { passed: caseId === "correct", findings: [{ criterion_id: "C1", outcome: caseId === "correct" ? "supported" : "disconfirmed",
    evidence_ids: receipts.map(row => row.id), reason: "Observed the original intent and terminal result." }] }
  const run = { nodes: {
    work: { current_attempt: 1, attempts: [{ status: "done", action_evidence_ref: { sha256: manifestHash }, session_id: "producer-session" }] },
    check: { current_attempt: 1, attempts: [{ status: caseId === "correct" ? "done" : "failed", session_id: "checker-session" }] },
  } }
  return { case_id: caseId, run, producer, checker_output: output, retrieved: receipts,
    checker_history: [{ info: { role: "assistant", providerID: "openai", modelID: "gpt-6-luna" },
      parts: tools.map((tool, i) => ({ ...tool, type: "tool", id: `tool-${i}` })) }] } as const
}

test("live action-evidence grader accepts the correct original action and the observed defective action", () => {
  expect(gradeLiveActionEvidenceCase(fixture("correct"))).toMatchObject({ passed: true, expected_verdict: "pass",
    retrieved_both_original_pages: true, citations_bound_to_original_pages: true, no_producer_replay: true })
  expect(gradeLiveActionEvidenceCase(fixture("defective"))).toMatchObject({ passed: true, expected_verdict: "reject",
    observed_verdict: "reject", evidence_consistent_with_case: true })
})

test("live action-evidence grader rejects a missing page or an unregistered forged citation", () => {
  const missing = fixture("correct")
  expect(gradeLiveActionEvidenceCase({ ...missing, retrieved: missing.retrieved.slice(0, 1) })).toMatchObject({ passed: false,
    retrieved_both_original_pages: false, citations_bound_to_original_pages: false })

  const forged = fixture("correct")
  const output = structuredClone(forged.checker_output)
  output.findings[0]!.evidence_ids[0] = `R${"f".repeat(64)}`
  expect(gradeLiveActionEvidenceCase({ ...forged, checker_output: output })).toMatchObject({ passed: false,
    citations_bound_to_original_pages: false })
})

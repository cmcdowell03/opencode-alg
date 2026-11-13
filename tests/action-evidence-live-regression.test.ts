import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempProject, removeProject } from "./helpers.ts"
import { gradeLiveActionEvidenceCase, parentDispatchReceipt, boundedPrivateHostEvidence, persistDiagnosticOutcome,
  hostCleanupStatus, versionProbeDiagnostic, crosscheckProducerHostHistory, firstCommand } from "../scripts/action-evidence-live-regression.ts"

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

test("failed synthetic task cards are recognized only with exact dispatch, attempt, state and child bindings", () => {
  const run: any = { run_id: "neutral-run", owner_session_id: "owner", global_attempts: 2, nodes: {
    work: { agent: "implementer", status: "done", current_attempt: 1, attempts: [{ attempt: 1, status: "done", session_id: "worker" }] },
    check: { agent: "checker", status: "failed", current_attempt: 1, attempts: [{ attempt: 1, status: "failed", session_id: "checker" }] },
  } }
  const emissions: any[] = ["alg_run", "alg_resume"].map((tool, i) => ({ role: "parent", tool, call_id: `dispatch-${i}`, run_id: run.run_id, max_waves: 1 }))
  const dispatches = emissions.map((emitted, i) => ({ type: "tool", id: `part-${i}`, tool: emitted.tool, callID: emitted.call_id,
    sessionID: "owner", messageID: `message-${i}`, state: { status: "completed", input: { run_id: run.run_id, max_waves: 1 } } }))
  const cards = ["work", "check"].map((id, i) => ({ type: "tool", id: `card-${i}`, tool: "task", sessionID: "owner", messageID: `message-${i}`,
    callID: `call_alg_${createHash("sha256").update(`${run.run_id}\0${id}\0${1}`).digest("hex").slice(0, 24)}`,
    state: { status: i ? "error" : "completed", input: { description: id, prompt: `ALG run ${run.run_id}, node ${id}, attempt 1.`, subagent_type: run.nodes[id].agent },
      metadata: { sessionId: run.nodes[id].attempts[0].session_id, parentSessionId: "owner" } } }))
  const before = [{ parts: [dispatches[0], cards[0]] }]
  const after = [{ parts: [dispatches[0], cards[0], dispatches[1], cards[1]] }]
  expect(parentDispatchReceipt(before, before, after, emissions, run)).toMatchObject({ passed: true, provider_call_ids_match: true,
    after_resume: { task_cards: 2, unexpected_tool_parts: 0, alg_run: 1, alg_resume: 1 } })
  for (const change of ["child", "state", "call", "parent-message"]) {
    const forged = structuredClone(after), card = forged[0]!.parts[3] as any
    if (change === "child") card.state.metadata.sessionId = "unrelated"
    if (change === "state") card.state.status = "completed"
    if (change === "call") card.callID = "model-issued-task"
    if (change === "parent-message") card.messageID = "unrelated"
    expect(parentDispatchReceipt(before, before, forged, emissions, run)).toMatchObject({ passed: false, provider_call_ids_match: true,
      after_resume: { unexpected_tool_parts: 1 } })
  }
})

test("failed grades and caught failures retain private workspaces and bounded host observations", () => {
  const root = tempProject("alg-live-retention-")
  try {
    for (const failure of [null, "apparatus failure"]) {
      const directory = join(root, failure ? "caught" : "grade"), workspace = join(directory, "workspace"), receipt = join(directory, "receipt.json")
      mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, "journal.json"), "original journal")
      const data = fixture("correct")
      const output = { ...data.checker_output, passed: false, findings: [{ ...data.checker_output.findings[0]!, outcome: "inconclusive" }] }
      const base = { passed: gradeLiveActionEvidenceCase({ ...data, checker_output: output }).passed, failure, cleanup: {},
        private_host_evidence: { checker: boundedPrivateHostEvidence(data.checker_history, []) } }
      const retained = persistDiagnosticOutcome(base, receipt, workspace)
      expect(retained).toMatchObject({ passed: false, cleanup: { temporary_environment_removed: false, retained_failure_workspace: workspace } })
      expect(readFileSync(join(workspace, "journal.json"), "utf8")).toBe("original journal")
      expect(JSON.parse(readFileSync(receipt, "utf8")).private_host_evidence).toEqual(base.private_host_evidence)
      expect(() => persistDiagnosticOutcome({ ...base, passed: true }, receipt, workspace)).toThrow()
      expect(existsSync(workspace)).toBe(true)
    }
    const workspace = join(root, "success"); mkdirSync(workspace)
    expect(persistDiagnosticOutcome({ passed: true, cleanup: {} }, join(root, "success.json"), workspace)).toMatchObject({
      passed: true, cleanup: { temporary_environment_removed: true, retained_failure_workspace: null } })
    expect(existsSync(workspace)).toBe(false)
  } finally { removeProject(root) }
})

test("private evidence is redacted before byte truncation and no-host cleanup is not a failed stop", () => {
  const secret = "synthetic-sensitive-fixture-value"
  const captured = boundedPrivateHostEvidence({ text: `${secret}${"é".repeat(100)}` }, [secret], 32)
  expect(captured.truncated).toBe(true)
  expect(captured.redacted).toBe(true)
  expect(captured.retained_bytes).toBeLessThanOrEqual(32)
  expect(captured.json_text).not.toContain(secret.slice(0, 8))
  expect(hostCleanupStatus([])).toMatchObject({ starts: 0, host_stopped: null, host_cleanup_required: false, host_cleanup_passed: true })
  expect(hostCleanupStatus([{ pid: 42, exited: false }])).toMatchObject({ starts: 1, host_stopped: false, host_cleanup_passed: false })
})

test("version probe diagnostics retain code/signal/category without raw errors or output", () => {
  const probe: any = { timeout_ms: 30_000, root_pid: 42, passed: true, exit_code: 0, exit_signal: null, exit_observed: true,
    cleanup: { passed: true }, stdout: "private output", stderr: "private error", wait_error: "private detail" }
  for (const [patch, category] of [
    [{}, null], [{ timed_out: true }, "timeout"], [{ root_pid: null }, "spawn_failure"],
    [{ exit_code: 7 }, "nonzero_exit"], [{ exit_signal: "SIGTERM" }, "signal"], [{ cleanup: { passed: false } }, "cleanup_failure"],
  ] as const) {
    const receipt = versionProbeDiagnostic({ ...probe, ...patch }, 30_001)
    expect(receipt.error_category).toBe(category)
    expect(receipt.timeout_ms).toBe(30_000)
    expect(JSON.stringify(receipt)).not.toContain("private")
  }
})

function nativeProducerFixture(caseId: "correct" | "defective", exit: number) {
  const session = "assigned-producer", hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const history = Array.from({ length: 10 }, (_, i) => ({ info: { id: `message-${i}`, sessionID: session }, parts: [{
    type: "tool", tool: "bash", id: `part-${i}`, callID: `call-${i}`, messageID: `message-${i}`, sessionID: session,
    state: { status: "completed", input: { command: i === 0 ? firstCommand(caseId) : "node -e harmless" },
      metadata: { exit: i === 0 ? exit : 0 }, output: i === 0 ? "ACTION_EVIDENCE_EARLY_MARKER_V1" : "late" },
  }] }))
  const producer = { child_session_id: session, first_call_id_sha256: hash("call-0"), first_command_sha256: hash(firstCommand(caseId)),
    first_terminal: { tool_status: "completed", exit_code_status: "reported", exit_code: exit } }
  return { history, producer }
}

test("native host consistency accepts positive zero and negative reported one or seven without assuming a normalization cause", () => {
  for (const [caseId, code] of [["correct", 0], ["defective", 1], ["defective", 7]] as const) {
    const data = nativeProducerFixture(caseId, code)
    expect(crosscheckProducerHostHistory(data.history, data.producer, caseId)).toMatchObject({ passed: true,
      observed_native_host_exit_code: code, journal_exit_code: code, declared_node_exit_code: caseId === "correct" ? 0 : 7,
      metadata_fields: ["state.metadata.exit"], session_binding_exact: true, call_binding_exact: true, status_binding_exact: true })
  }
})

test("native host consistency rejects negative zero, absent exit, and mismatched journal/session/call/command/status", () => {
  const zero = nativeProducerFixture("defective", 0)
  expect(crosscheckProducerHostHistory(zero.history, zero.producer, "defective")).toMatchObject({ passed: false, exit_matches_case: false })
  for (const mismatch of ["missing-exit", "journal-exit", "session", "call", "command", "status"]) {
    const data = nativeProducerFixture("defective", 1), first = data.history[0]!.parts[0]!
    if (mismatch === "missing-exit") first.state.metadata = {} as any
    if (mismatch === "journal-exit") data.producer.first_terminal.exit_code = 7
    if (mismatch === "session") first.sessionID = "unrelated"
    if (mismatch === "call") first.callID = "unrelated"
    if (mismatch === "command") first.state.input.command = "node -e different"
    if (mismatch === "status") first.state.status = "error"
    expect(crosscheckProducerHostHistory(data.history, data.producer, "defective").passed).toBe(false)
  }
})

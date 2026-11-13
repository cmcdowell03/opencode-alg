import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { criteriaDigest, retrievedVerificationEvidence } from "../src/verification.ts"
import { gradeLiveActionEvidenceCase, parentDispatchReceipt, boundedPrivateHostEvidence, persistDiagnosticOutcome,
  checkerAttemptSnapshot, hostCleanupStatus, versionProbeDiagnostic, crosscheckProducerHostHistory, firstCommand } from "../scripts/action-evidence-live-regression.ts"

function tempProject(prefix: string) {
  const root = resolve(import.meta.dir, "../../implementation-evidence/qualification-finish")
  mkdirSync(root, { recursive: true })
  return mkdtempSync(join(root, prefix))
}
function removeProject(root: string) { rmSync(root, { recursive: true, force: true }) }
const digest = (text: string) => createHash("sha256").update(text).digest("hex")
const boundary = Date.parse("2026-09-04T12:00:00Z")
const criterion = "The first recorded bash call within the producer attempt has its captured command retained exactly, and its linked host terminal explicitly reports exit code zero."

function fixture(caseId: "correct" | "defective", repair: boolean | "evidence_unavailable" = false): any {
  const contents = [JSON.stringify({ command: firstCommand(caseId) }), JSON.stringify({ exit_code: caseId === "correct" ? 0 : 1 })]
  const manifestHash = "3".repeat(64)
  const manifestReference = { artifact_path: `.opencode/runs/neutral-run/artifacts/manifest-${manifestHash}.json`, sha256: manifestHash, byte_size: 128 }
  const producerOutput = { done: true, summary: "Completed the fixed action sequence.", files_changed: [], blocking_issues: [] }
  const submission = JSON.stringify(producerOutput)
  const basis = { version: 1, criteria_sha256: criteriaDigest([criterion]), criterion_ids: ["C1"], omitted_entries: 0,
    claimed_submission: { run_id: "neutral-run", node_id: "work", reference: "work", attempt: 1,
      json_sha256: digest(submission), json_bytes: Buffer.byteLength(submission) }, evidence: [] }
  const sources = { version: 1, journals: [{ run_id: "neutral-run", node_id: "work", attempt: 1,
    child_session_id: "producer-session", reference: manifestReference }], omitted: 0, unavailable: 0 }
  const refs = contents.map((content, index) => ({ artifact_path: `.opencode/runs/run/artifacts/${index}.json`, sha256: digest(content), byte_size: Buffer.byteLength(content) }))
  const receipts = refs.map((reference, index) => retrievedVerificationEvidence(reference, 0, contents[index]!))
  const tools = [
    { tool: "alg_artifact", state: { status: "completed", input: { evidence: "index" }, output: JSON.stringify({ records: refs.map((reference, index) => ({ record_id: reference.sha256, kind: index ? "terminal" : "intent" })) }) } },
    ...refs.map((reference, index) => ({ tool: "alg_artifact", state: { status: "completed", input: { evidence: "read", record_id: reference.sha256, offset: 0 },
      output: JSON.stringify({ citation_id: receipts[index]!.id, receipt: receipts[index], content: contents[index] }) } })),
  ]
  const exitCode = caseId === "correct" ? 0 : 1
  const producer = { manifest_sha256: manifestHash, observed_calls: 10, completed: 10, unknown_terminal: 0,
    first_records: { intent: refs[0], terminal: refs[1] }, first_terminal: { exit_code: exitCode },
    checker_provider_id: "openai", checker_model_id: "gpt-6-luna" }
  const output = { passed: caseId === "correct", failures: caseId === "correct" ? [] : ["The linked terminal reports a nonzero exit."],
    score: caseId === "correct" ? 10 : 0, findings: [{ criterion_id: "C1", outcome: caseId === "correct" ? "supported" : "disconfirmed",
    evidence_ids: receipts.map(row => row.id), reason: "Observed the original intent and terminal result.",
    mechanical_assessment: { version: 1, scope: "whole_criterion", intent_id: receipts[0]!.id, terminal_id: receipts[1]!.id,
      predicates: [{ kind: "first_recorded_bash" }, { kind: "complete_command" }, { kind: "linked_pair" }, { kind: "exit_equals", expected: 0 }] } }] }
  const count = repair ? 2 : 1, status = caseId === "correct" ? "done" : "failed"
  const gapOutput = { passed: false, failures: ["Evidence remains inconclusive."], score: 0,
    findings: [{ criterion_id: "C1", outcome: "inconclusive", evidence_ids: [], reason: "The available observations did not resolve the criterion." }] }
  const attempts: any[] = Array.from({ length: count }, (_, index) => ({ attempt: index + 1, session_id: `checker-${index + 1}`,
    verification_basis: structuredClone(basis), action_evidence_sources: structuredClone(sources),
    started_at: new Date(boundary + 1_000 + index * 2_000).toISOString(), finished_at: new Date(boundary + 2_000 + index * 2_000).toISOString(),
    ...(index === count - 1 ? { status, outcome: caseId === "correct" ? "passed" : "substantive_rejection", schema_ok: true, output, retrieved_evidence: receipts }
      : repair === "evidence_unavailable" ? { status: "failed", outcome: "evidence_unavailable", schema_ok: true, failures: gapOutput.failures, output: gapOutput, retrieved_evidence: [] }
      : { status: "failed", outcome: "schema_invalid", schema_ok: false, failures: ["schema: missing required output fields"], retrieved_evidence: [] }) }))
  const histories = attempts.map((attempt, index) => {
    const messageID = `message-${index}`, sessionID = attempt.session_id
    const parts = index === count - 1 ? [...tools.map(tool => ({ ...tool, type: "tool" })), { type: "text", text: JSON.stringify(output) }]
      : [{ type: "text", text: repair === "evidence_unavailable" ? JSON.stringify(gapOutput) : '{"passed":true,"invalid_original_output":true}' }]
    return { attempt: attempt.attempt, session_id: sessionID, messages: [{ info: { id: messageID, sessionID, role: "assistant", providerID: "openai", modelID: "gpt-6-luna" },
      parts: parts.map((part, i) => ({ ...part, id: `part-${index}-${i}`, sessionID, messageID })) }] }
  })
  const run = { run_id: "neutral-run", owner_session_id: "owner", status, phase: status, global_attempts: 1 + count, criteria: [criterion],
    graph: { max_global_attempts: 3, max_concurrency: 1, nodes: [{ id: "work", loop: { max_attempts: 1 } }, { id: "check", inputs: { claimed: "work" }, loop: { max_attempts: 2 } }] }, nodes: {
    work: { agent: "implementer", status: "done", current_attempt: 1, attempts: [{ attempt: 1, status: "done", schema_ok: true, output: producerOutput,
      action_evidence_ref: manifestReference, session_id: "producer-session" }] },
    check: { agent: "checker", status, current_attempt: count, attempts },
  } }
  return { case_id: caseId, run, producer, checker_histories: histories, compaction_completed_at: boundary }
}
const finalAttempt = (data: any) => data.run.nodes.check.attempts.at(-1)
function syncNativeOutput(data: any) {
  data.checker_histories.at(-1).messages.at(-1).parts.at(-1).text = JSON.stringify(finalAttempt(data).output)
}

test("live action-evidence grader accepts the correct original action and the observed defective action", () => {
  expect(gradeLiveActionEvidenceCase(fixture("correct"))).toMatchObject({ passed: true, expected_verdict: "pass",
    retrieved_both_original_pages: true, citations_bound_to_original_pages: true, no_producer_replay: true })
  expect(gradeLiveActionEvidenceCase(fixture("defective"))).toMatchObject({ passed: true, expected_verdict: "reject",
    observed_verdict: "reject", evidence_consistent_with_case: true })
})

test("v4 accepts only the last valid attempt after one retained schema repair", () => {
  for (const caseId of ["correct", "defective"] as const) {
    const data = fixture(caseId, true)
    expect(gradeLiveActionEvidenceCase(data)).toMatchObject({ passed: true, checker_attempt_count: 2, final_attempt: 2,
      typed_assessment_used: true, bounded_checker_repair_only: true, prior_attempts_schema_invalid: true,
      first_attempt_repair_category: "schema_invalid", same_criteria_submission_and_sources: true })
    // The failed first attempt has no parsed output or assessment, but its raw host text survives.
    expect(data.run.nodes.check.attempts[0].output).toBeUndefined()
    expect(checkerAttemptSnapshot(data.run.nodes.check.attempts[0], data.checker_histories[0].messages).json_text).toContain("invalid_original_output")
  }
})

test("pre-issuance v4 permits one validated evidence-unavailable repair while reporting the final verdict separately", () => {
  for (const caseId of ["correct", "defective"] as const) {
    const data = fixture(caseId, "evidence_unavailable")
    expect(gradeLiveActionEvidenceCase(data)).toMatchObject({ passed: true, checker_attempt_count: 2, final_attempt: 2,
      first_attempt_category: "evidence_unavailable", first_attempt_repair_category: "evidence_unavailable",
      prior_attempts_schema_invalid: false, prior_attempts_eligible: true, bounded_checker_repair_only: true,
      observed_verdict: caseId === "correct" ? "pass" : "reject", final_attempt_outcome: caseId === "correct" ? "passed" : "substantive_rejection" })
    const snapshot = JSON.parse(checkerAttemptSnapshot(data.run.nodes.check.attempts[0], data.checker_histories[0].messages).json_text)
    expect(snapshot.attempt.output).toEqual(data.run.nodes.check.attempts[0].output)
    expect(snapshot.native_history[0].parts[0].text).toBe(JSON.stringify(snapshot.attempt.output))
  }
})

test("evidence-unavailable repair rejects category/schema/output/native-response mismatches and invalid inconclusive output", () => {
  for (const corruption of ["missing-output", "missing-score", "passed-true", "empty-failures", "empty-findings", "supported-only", "unsupported", "disconfirmed",
    "invalid-outcome", "invalid-mechanical", "forged-citation", "claimed-pin-citation", "schema-invalid-category", "schema-false", "sdk-category", "gate-category", "sdk-error", "gate-metadata", "setup-metadata", "native-mismatch"]) {
    const data = fixture("correct", "evidence_unavailable"), prior = data.run.nodes.check.attempts[0]
    if (corruption === "missing-output") delete prior.output
    if (corruption === "missing-score") delete prior.output.score
    if (corruption === "passed-true") prior.output.passed = true
    if (corruption === "empty-failures") prior.output.failures = []
    if (corruption === "empty-findings") prior.output.findings = []
    if (corruption === "supported-only") prior.output.findings[0].outcome = "supported"
    if (corruption === "unsupported") prior.output.findings[0].outcome = "unsupported"
    if (corruption === "disconfirmed") prior.output.findings[0].outcome = "disconfirmed"
    if (corruption === "invalid-outcome") prior.output.findings[0].outcome = "unknown"
    if (corruption === "invalid-mechanical") prior.output.findings[0].mechanical_assessment = { version: 1 }
    if (corruption === "forged-citation") prior.output.findings[0].evidence_ids = [`R${"f".repeat(64)}`]
    if (corruption === "claimed-pin-citation") prior.output.findings[0].evidence_ids = ["E1"]
    if (corruption === "schema-invalid-category") prior.outcome = "schema_invalid"
    if (corruption === "schema-false") prior.schema_ok = false
    if (corruption === "sdk-category") prior.outcome = "sdk_error"
    if (corruption === "gate-category") prior.outcome = "gate_failure"
    if (corruption === "sdk-error") prior.error = "host error"
    if (corruption === "gate-metadata") prior.shell_ok = false
    if (corruption === "setup-metadata") prior.shell_setup_failed = true
    if (corruption === "native-mismatch") prior.output.notes = "absent from native response"
    else data.checker_histories[0].messages[0].parts[0].text = JSON.stringify(prior.output)
    expect(gradeLiveActionEvidenceCase(data), corruption).toMatchObject({ passed: false, first_attempt_repair_category: "ineligible" })
  }
})

test("both repair categories require unchanged criteria, producer submission pin and original source manifests", () => {
  for (const repair of [true, "evidence_unavailable"] as const) {
    for (const corruption of ["missing-basis", "basis-criteria", "basis-submission", "basis-bytes", "basis-node", "basis-attempt", "basis-run", "basis-reference", "missing-pin",
      "source-session", "source-attempt", "source-manifest", "source-node", "source-run", "missing-source", "criteria", "graph-input", "producer-output", "both-forged-pins"]) {
      const data = fixture("correct", repair), final = finalAttempt(data), basis = final.verification_basis, source = final.action_evidence_sources.journals[0]
      if (corruption === "missing-basis") delete final.verification_basis
      if (corruption === "basis-criteria") basis.criteria_sha256 = "f".repeat(64)
      if (corruption === "basis-submission") basis.claimed_submission.json_sha256 = "f".repeat(64)
      if (corruption === "basis-bytes") basis.claimed_submission.json_bytes++
      if (corruption === "basis-node") basis.claimed_submission.node_id = "other"
      if (corruption === "basis-attempt") basis.claimed_submission.attempt = 2
      if (corruption === "basis-run") basis.claimed_submission.run_id = "foreign"
      if (corruption === "basis-reference") basis.claimed_submission.reference = "other"
      if (corruption === "missing-pin") delete basis.claimed_submission
      if (corruption === "source-session") source.child_session_id = "foreign"
      if (corruption === "source-attempt") source.attempt = 2
      if (corruption === "source-manifest") source.reference.sha256 = "f".repeat(64)
      if (corruption === "source-node") source.node_id = "other"
      if (corruption === "source-run") source.run_id = "foreign"
      if (corruption === "missing-source") delete final.action_evidence_sources
      if (corruption === "criteria") data.run.criteria = ["changed criterion"]
      if (corruption === "graph-input") data.run.graph.nodes[1].inputs.claimed = "other"
      if (corruption === "producer-output") data.run.nodes.work.attempts[0].output.summary = "changed submission"
      if (corruption === "both-forged-pins") for (const attempt of data.run.nodes.check.attempts) attempt.verification_basis.claimed_submission.json_sha256 = "f".repeat(64)
      expect(gradeLiveActionEvidenceCase(data), `${repair}/${corruption}`).toMatchObject({ passed: false, same_criteria_submission_and_sources: false })
    }
  }
})

test("schema and evidence-unavailable repairs share the same two-attempt total and cannot supply the final verdict", () => {
  const data = fixture("correct", "evidence_unavailable"), extra = structuredClone(data.run.nodes.check.attempts[0])
  extra.attempt = 3; data.run.nodes.check.attempts.push(extra); data.run.nodes.check.current_attempt = 3; data.run.global_attempts = 4
  expect(gradeLiveActionEvidenceCase(data)).toMatchObject({ passed: false, bounded_checker_repair_only: false })
  const exhausted = fixture("correct", "evidence_unavailable")
  exhausted.run.nodes.check.attempts[1] = { ...structuredClone(exhausted.run.nodes.check.attempts[0]), attempt: 2, session_id: "checker-2" }
  syncNativeOutput(exhausted)
  expect(gradeLiveActionEvidenceCase(exhausted)).toMatchObject({ passed: false, final_schema_and_terminal_valid: false })
})

test("v4 rejects missing, forged, foreign and earlier-attempt-only citations or page evidence", () => {
  for (const corruption of ["missing", "forged-citation", "forged-page", "foreign-reference", "earlier-only", "extra-read", "wrong-order"]) {
    const data = fixture("correct", true), final = finalAttempt(data), parts = data.checker_histories.at(-1).messages[0].parts
    if (corruption === "missing") final.retrieved_evidence.pop()
    if (corruption === "forged-citation") final.output.findings[0].evidence_ids[0] = `R${"f".repeat(64)}`
    if (corruption === "forged-page") {
      const page = JSON.parse(parts[1].state.output); page.content = "forged"; parts[1].state.output = JSON.stringify(page)
    }
    if (corruption === "foreign-reference") final.retrieved_evidence[0].reference.sha256 = "f".repeat(64)
    if (corruption === "earlier-only") { data.run.nodes.check.attempts[0].retrieved_evidence = final.retrieved_evidence; final.retrieved_evidence = [] }
    if (corruption === "extra-read") parts.splice(3, 0, { ...structuredClone(parts[1]), id: "reread" })
    if (corruption === "wrong-order") [parts[1], parts[2]] = [parts[2], parts[1]]
    syncNativeOutput(data)
    expect(gradeLiveActionEvidenceCase(data).passed, corruption).toBe(false)
  }
})

test("v4 rejects excluded or mismatched prior categories and invalid final exhaustion", () => {
  for (const outcome of ["substantive_rejection", "evidence_unavailable", "sdk_error", "gate_failure", "passed"]) {
    const data = fixture("correct", true); data.run.nodes.check.attempts[0].outcome = outcome
    expect(gradeLiveActionEvidenceCase(data)).toMatchObject({ passed: false, prior_attempts_schema_invalid: false })
  }
  for (const corruption of ["prior-schema", "prior-output", "final-schema", "final-status", "missing-output", "raw-mismatch", "invalid-json-schema"]) {
    const data = fixture("correct", true), final = finalAttempt(data)
    if (corruption === "prior-schema") data.run.nodes.check.attempts[0].schema_ok = true
    if (corruption === "prior-output") data.run.nodes.check.attempts[0].output = { passed: true }
    if (corruption === "final-schema") final.schema_ok = false
    if (corruption === "final-status") final.status = "failed"
    if (corruption === "missing-output") delete final.output
    if (corruption === "raw-mismatch") final.output.notes = "not in native response"
    if (corruption === "invalid-json-schema") { delete final.output.score; syncNativeOutput(data) }
    expect(gradeLiveActionEvidenceCase(data).passed, corruption).toBe(false)
  }
})

test("v4 rejects missing or foreign histories, mixed models, producer replay, feedback, third attempt and early starts", () => {
  for (const corruption of ["missing-history", "foreign-session", "foreign-part", "prior-model", "final-model", "replay", "feedback", "third", "early"]) {
    const data = fixture("correct", true)
    if (corruption === "missing-history") data.checker_histories.shift()
    if (corruption === "foreign-session") data.checker_histories[0].messages[0].info.sessionID = "foreign"
    if (corruption === "foreign-part") data.checker_histories[1].messages[0].parts[0].messageID = "foreign"
    if (corruption === "prior-model") data.checker_histories[0].messages[0].info.modelID = "other"
    if (corruption === "final-model") data.checker_histories[1].messages[0].info.providerID = "other"
    if (corruption === "replay") data.run.nodes.work.attempts.push(structuredClone(data.run.nodes.work.attempts[0]))
    if (corruption === "feedback") data.run.graph.nodes[1].feedback_to = "work"
    if (corruption === "third") { data.run.nodes.check.attempts.push(structuredClone(finalAttempt(data))); data.run.nodes.check.current_attempt = 3; data.run.global_attempts = 4 }
    if (corruption === "early") data.run.nodes.check.attempts[0].started_at = new Date(boundary - 1).toISOString()
    expect(gradeLiveActionEvidenceCase(data).passed, corruption).toBe(false)
  }
})

test("v4 requires final typed assessment and the independent case verdict", () => {
  for (const corruption of ["absent", "foreign-id", "wrong-verdict"]) {
    const data = fixture("correct"), finding = finalAttempt(data).output.findings[0]
    if (corruption === "absent") delete finding.mechanical_assessment
    if (corruption === "foreign-id") finding.mechanical_assessment.intent_id = `R${"f".repeat(64)}`
    if (corruption === "wrong-verdict") {
      Object.assign(finalAttempt(data).output, { passed: false, failures: ["wrong"], score: 0 }); finding.outcome = "disconfirmed"
    }
    syncNativeOutput(data)
    expect(gradeLiveActionEvidenceCase(data).passed, corruption).toBe(false)
  }
})

test("v4 C1 mapping requires exactly the four approved predicates, exit zero and original citation roles, in any order", () => {
  for (const caseId of ["correct", "defective"] as const) {
    const reordered = fixture(caseId)
    finalAttempt(reordered).output.findings[0].mechanical_assessment.predicates.reverse()
    syncNativeOutput(reordered)
    expect(gradeLiveActionEvidenceCase(reordered)).toMatchObject({ passed: true, typed_assessment_used: true, mechanical_assessment_covers_c1: true })
    for (const corruption of ["wrong-exit", "missing-order", "missing-retention", "missing-link", "missing-exit", "extra", "ordinal-substitute", "foreign-terminal", "swapped-roles"]) {
      const data = fixture(caseId), assessment = finalAttempt(data).output.findings[0].mechanical_assessment
      if (corruption === "wrong-exit") assessment.predicates[3].expected = 7
      if (corruption.startsWith("missing-")) assessment.predicates.splice(["missing-order", "missing-retention", "missing-link", "missing-exit"].indexOf(corruption), 1)
      if (corruption === "extra") assessment.predicates.push({ kind: "ordinal_equals", expected: 1 })
      if (corruption === "ordinal-substitute") assessment.predicates[0] = { kind: "ordinal_equals", expected: 1 }
      if (corruption === "foreign-terminal") assessment.terminal_id = `R${"f".repeat(64)}`
      if (corruption === "swapped-roles") [assessment.intent_id, assessment.terminal_id] = [assessment.terminal_id, assessment.intent_id]
      syncNativeOutput(data)
      expect(gradeLiveActionEvidenceCase(data), corruption).toMatchObject({ passed: false, mechanical_assessment_covers_c1: false })
    }
  }
})

test("failed synthetic task cards are recognized only with exact dispatch, attempt, state and child bindings", () => {
  for (const repair of [false, true]) {
  const { run } = fixture("defective", repair)
  const emissions: any[] = ["alg_run", "alg_resume"].map((tool, i) => ({ role: "parent", tool, call_id: `dispatch-${i}`, run_id: run.run_id, max_waves: i + 1 }))
  const dispatches = emissions.map((emitted, i) => ({ type: "tool", id: `part-${i}`, tool: emitted.tool, callID: emitted.call_id,
    sessionID: "owner", messageID: `message-${i}`, state: { status: "completed", input: { run_id: run.run_id, max_waves: emitted.max_waves } } }))
  const cards = ["work", "check"].flatMap((id, i) => run.nodes[id].attempts.map((attempt: any) => ({ type: "tool", id: `card-${i}-${attempt.attempt}`,
    tool: "task", sessionID: "owner", messageID: `message-${i}`, callID: `call_alg_${digest(`${run.run_id}\0${id}\0${attempt.attempt}`).slice(0, 24)}`,
    state: { status: attempt.status === "done" ? "completed" : "error", input: { description: attempt.attempt === 1 ? id : `${id} · attempt ${attempt.attempt}`,
      prompt: `ALG run ${run.run_id}, node ${id}, attempt ${attempt.attempt}.`, subagent_type: run.nodes[id].agent },
      metadata: { sessionId: attempt.session_id, parentSessionId: "owner" } } })))
  const before = [{ parts: [dispatches[0], cards[0]] }]
  const after = [{ parts: [dispatches[0], cards[0], dispatches[1], ...cards.slice(1)] }]
  expect(parentDispatchReceipt(before, before, after, emissions, run)).toMatchObject({ passed: true, provider_call_ids_match: true,
    after_resume: { task_cards: repair ? 3 : 2, unexpected_tool_parts: 0, alg_run: 1, alg_resume: 1 } })
  for (const change of ["child", "state", "call", "parent-message"]) {
    const forged = structuredClone(after), card = forged[0]!.parts[3] as any
    if (change === "child") card.state.metadata.sessionId = "unrelated"
    if (change === "state") card.state.status = "completed"
    if (change === "call") card.callID = "model-issued-task"
    if (change === "parent-message") card.messageID = "unrelated"
    expect(parentDispatchReceipt(before, before, forged, emissions, run)).toMatchObject({ passed: false, provider_call_ids_match: true,
      after_resume: { unexpected_tool_parts: 1 } })
  }
  const missing = structuredClone(after); missing[0]!.parts.pop()
  expect(parentDispatchReceipt(before, before, missing, emissions, run).passed).toBe(false)
  }
})

test("failed grades and caught failures retain private workspaces and bounded host observations", () => {
  const root = tempProject("alg-live-retention-")
  try {
    for (const failure of [null, "apparatus failure"]) {
      const directory = join(root, failure ? "caught" : "grade"), workspace = join(directory, "workspace"), receipt = join(directory, "receipt.json")
      mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, "journal.json"), "original journal")
      const data = fixture("correct")
      finalAttempt(data).output.findings[0].outcome = "inconclusive"
      syncNativeOutput(data)
      const base = { passed: gradeLiveActionEvidenceCase(data).passed, failure, cleanup: {},
        private_host_evidence: { checker: boundedPrivateHostEvidence(data.checker_histories, []) } }
      const retained = persistDiagnosticOutcome(base, receipt, workspace)
      expect(retained).toMatchObject({ passed: false, cleanup: { temporary_environment_removed: false, retained_failure_workspace: workspace } })
      expect(readFileSync(join(workspace, "journal.json"), "utf8")).toBe("original journal")
      expect(JSON.parse(readFileSync(receipt, "utf8")).private_host_evidence).toEqual(base.private_host_evidence)
      expect(() => persistDiagnosticOutcome({ ...base, passed: true }, receipt, workspace)).toThrow()
      expect(existsSync(workspace)).toBe(true)
    }
    const workspace = join(root, "success"); mkdirSync(workspace)
    const repaired = fixture("correct", true), receipt = join(root, "success.json")
    const snapshots = repaired.run.nodes.check.attempts.map((attempt: any, index: number) => checkerAttemptSnapshot(attempt, repaired.checker_histories[index].messages))
    expect(persistDiagnosticOutcome({ passed: gradeLiveActionEvidenceCase(repaired).passed, cleanup: {}, private_host_evidence: snapshots }, receipt, workspace)).toMatchObject({
      passed: true, cleanup: { temporary_environment_removed: true, retained_failure_workspace: null } })
    expect(existsSync(workspace)).toBe(false)
    expect(readFileSync(receipt, "utf8")).toContain("invalid_original_output")
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

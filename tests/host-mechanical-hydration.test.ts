import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ActionEvidenceJournal } from "../src/action-evidence.ts"
import { buildCheckerEvidence } from "../src/checker-evidence.ts"
import { evidencePage } from "../src/evidence-retrieval.ts"
import { validateGraph } from "../src/graph.ts"
import { createRun, evaluatePinnedMechanicalAction, hydrateRunFully, loadRun, persistRun, writeTaskEvidence } from "../src/store.ts"
import { captureTaskBaseline } from "../src/task-baseline.ts"
import { bindTaskContract } from "../src/task-contract.ts"
import { taskEvidence } from "../src/task-evidence.ts"
import type { NodeAttempt, RunDataReference } from "../src/types.ts"
import { buildVerificationBasis, pinClaimedSubmission, type VerificationFinding } from "../src/verification.ts"
import { removeProject } from "./helpers.ts"

const owner = "session-owner"
const criterion = 'Mechanical action: first recorded bash command is exactly "echo expected"; its linked terminal exit code equals 0.'
const produced = { summary: ["Retained the action"], files_touched: ["result.json"], commands_run: [], risks: [], done: true }
const plain = ({ artifact_path, sha256, byte_size }: RunDataReference) => ({ artifact_path, sha256, byte_size })

function withRun<T>(fn: (project: string) => T): T {
  const project = mkdtempSync(fileURLToPath(new URL("./.host-mechanical-", import.meta.url)))
  try { return fn(project) }
  finally { removeProject(project) }
}

function fixture(project: string, first: { command?: string; exit?: number; noTerminal?: boolean } = {}) {
  const graph = validateGraph({ name: "host-mechanical-hydration", max_concurrency: 1, max_global_attempts: 2, nodes: [
    { id: "work", agent: "implementer", depends_on: [] },
    { id: "check", agent: "checker", depends_on: ["work"], inputs: { claimed: "work" }, isolated_check: true },
  ] })
  const task = bindTaskContract({
    version: 1, kind: "project_change", discovery: "not_required", phase: "complete",
    deliverables: [{ destination: "project_file", producer_node: "work", path: "result.json" }],
    verification: { checker_node: "check", execution: "none" }, preserve_paths: [],
    evidence_plan: [{ criterion: 1, observations: [{ kind: "action" }] }],
  }, "Check the recorded action", [criterion], graph, { session_id: owner, message_id: "planner" }, {
    status: "captured", session_id: owner, message_id: "request", text: criterion,
    text_sha256: createHash("sha256").update(criterion).digest("hex"), text_transformed: false, non_text_parts: 0,
  })
  const run = createRun({ projectDirectory: project, ownerSessionId: owner, goal: "Check the recorded action",
    graph, criteria: [criterion], taskContract: task })
  run.task_baseline = captureTaskBaseline(project, task)
  persistRun(run, project)
  writeFileSync(join(project, "result.json"), "{}")
  const started_at = new Date().toISOString()
  const child = "producer-a1"
  const journal = new ActionEvidenceJournal(project)
  journal.bind(child, { run_id: run.run_id, node_id: "work", attempt: 1 })
  journal.before({ tool: "read", sessionID: child, callID: "non-bash" }, {})
  const call = { tool: "bash" as const, sessionID: child, callID: "first" }
  const firstIntent = journal.before(call, { command: first.command ?? "echo expected" })
  if (!first.noTerminal) journal.after(call, { output: "done", metadata: { exit_code: first.exit ?? 0 } })
  const laterCall = { ...call, callID: "later" }
  const laterIntent = journal.before(laterCall, { command: "echo expected" })
  const laterTerminal = journal.after(laterCall, { output: "done", metadata: { exit_code: 0 } })!
  const reference = journal.finish(child)
  Object.assign(run.nodes.work!, { status: "done", current_attempt: 1, output: produced, attempts: [{
    attempt: 1, status: "done", outcome: "passed", schema_ok: true, session_id: child, started_at,
    finished_at: started_at, failures: [], output: produced, action_evidence_ref: reference,
  }] satisfies NodeAttempt[] })

  const taskObservation = taskEvidence(run)!
  const taskRef = writeTaskEvidence(run, "check", 1, taskObservation)
  run.nodes.check!.current_attempt = 1
  const evidence = buildCheckerEvidence(graph.nodes[1]!, run, [], { value: taskObservation, reference: taskRef })
  const pin = pinClaimedSubmission({ run_id: run.run_id, node_id: "work", reference: "work", attempt: 1 }, produced)
  const check: NodeAttempt = { attempt: 1, started_at, status: "running", failures: [], task_evidence_ref: taskRef,
    verification_basis: buildVerificationBasis(run.criteria, evidence, pin) }
  const evaluated = evaluatePinnedMechanicalAction(run, "check", check)!
  const finding = evaluated.findings[0]!
  const passed = finding.outcome === "supported"
  const failures = passed ? [] : ["Host action evidence did not establish the criterion."]
  const output = { passed, score: passed ? 10 : 0, failures, findings: evaluated.findings }
  Object.assign(check, {
    status: passed ? "done" : "failed", schema_ok: true, finished_at: started_at,
    outcome: passed ? "passed" : finding.outcome === "inconclusive" ? "evidence_unavailable" : "substantive_rejection",
    failures, score: output.score, host_mechanical_evidence: evaluated.receipts, output,
  } satisfies Partial<NodeAttempt>)
  Object.assign(run.nodes.check!, { status: check.status, current_attempt: 1, output, last_failures: failures, attempts: [check] })
  Object.assign(run, { status: passed ? "done" : "failed", phase: "done", global_attempts: 2 })
  return { run, check, finding, firstIntent, laterIntent, laterTerminal }
}

test.each([
  { first: {}, outcome: "supported", receipts: 2 },
  { first: { exit: 7 }, outcome: "disconfirmed", receipts: 2 },
  { first: { noTerminal: true }, outcome: "inconclusive", receipts: 1 },
] as const)("pinned host verdict reloads with its original outcome and no checker session: $outcome", ({ first, outcome, receipts }) => {
  withRun(project => {
    const f = fixture(project, first)
    expect(f.finding.outcome).toBe(outcome)
    persistRun(f.run, project)
    const stored = loadRun(project, f.run.run_id)!
    const check = hydrateRunFully(stored).nodes.check!.attempts[0]!
    expect(check.session_id).toBeUndefined()
    expect(check.retrieved_evidence).toBeUndefined()
    expect(check.host_mechanical_evidence).toHaveLength(receipts)
    expect(check.host_mechanical_evidence).toEqual(f.check.host_mechanical_evidence)
    expect(check.output).toEqual(f.check.output)
  })
})

test.each(["missing receipt field", "missing page", "tampered page", "missing predicate", "synthetic session"] as const)(
  "%s fails host mechanical hydration", corruption => {
    withRun(project => {
      const f = fixture(project)
      if (corruption === "missing receipt field") delete f.check.host_mechanical_evidence
      if (corruption === "missing page") f.check.host_mechanical_evidence!.pop()
      if (corruption === "tampered page") f.check.host_mechanical_evidence![0]!.length--
      if (corruption === "missing predicate") delete f.finding.mechanical_assessment
      if (corruption === "synthetic session") f.check.session_id = "fabricated-checker"
      expect(() => hydrateRunFully(f.run)).toThrow(/persisted observations/i)
    })
  },
)

test("valid pages and a passing assessment from a later action cannot replace the pinned first action", () => {
  withRun(project => {
    const f = fixture(project, { command: "echo different" })
    expect(f.finding.outcome).toBe("disconfirmed")
    const [intent, terminal] = [f.laterIntent, f.laterTerminal].map(reference =>
      evidencePage(project, f.run.run_id, plain(reference)).receipt)
    f.check.host_mechanical_evidence = [intent!, terminal!]
    const substituted: VerificationFinding = { ...f.finding, outcome: "supported", evidence_ids: [intent!.id, terminal!.id],
      mechanical_assessment: { ...f.finding.mechanical_assessment!, intent_id: intent!.id, terminal_id: terminal!.id } }
    const verdict = { passed: true, failures: [], score: 10, findings: [substituted] }
    Object.assign(f.check, { status: "done", outcome: "passed", failures: [], score: 10, output: verdict })
    Object.assign(f.run.nodes.check!, { status: "done", output: verdict, last_failures: [] })
    f.run.status = "done"
    expect(() => hydrateRunFully(f.run)).toThrow(/host mechanical|observations/i)
  })
})

test("an inconclusive host finding cannot reload with producer-repair accounting", () => {
  withRun(project => {
    const f = fixture(project, { noTerminal: true })
    expect(f.check.outcome).toBe("evidence_unavailable")
    f.check.outcome = "substantive_rejection"
    expect(() => hydrateRunFully(f.run)).toThrow(/persisted observations/i)
  })
})

test.each(["modified", "deleted"] as const)("loading fails when the original pinned action record is %s", action => {
  withRun(project => {
    const f = fixture(project)
    persistRun(f.run, project)
    const path = join(project, f.firstIntent.artifact_path)
    if (action === "deleted") unlinkSync(path)
    else writeFileSync(path, readFileSync(path, "utf8").replace("echo expected", "echo modified"))
    expect(() => loadRun(project, f.run.run_id)).toThrow(/action.*evidence|journal|reference/i)
  })
})

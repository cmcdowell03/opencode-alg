import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ExecutionEvidenceSchema, MAX_EXECUTION_EVIDENCE_BYTES, fromShellGateEvidence } from "../src/execution-evidence.ts"
import { MAX_ATTEMPT_HISTORY_BYTES, MAX_INLINE_ATTEMPTS_PER_NODE } from "../src/limits.ts"
import { canonicalJson, sha256Json } from "../src/persistence.ts"
import { PreservationEvidenceSchema } from "../src/preservation-evidence.ts"
import { createRun, hydrateRunForExecution, hydrateRunFully, loadRun, persistRun, runDir } from "../src/store.ts"
import type { NodeAttempt, RunState } from "../src/types.ts"
import { buildVerificationBasis } from "../src/verification.ts"
import { removeProject, tempProject } from "./helpers.ts"

function saturatedReceipt(run: RunState, attempt: number) {
  const receipt = ExecutionEvidenceSchema.parse({
    version: 1, run_id: run.run_id, node_id: "work", attempt, child_session_id: `child-${attempt}`,
    retrieval_status: "available", omitted_commands: 0, window_may_be_incomplete: false, foreign_messages_omitted: 0,
    commands: Array.from({ length: 8 }, (_, index) => ({ tool: "bash", command: "node fixture-check.cjs", call_id: `call-${index}`,
      tool_status: "completed", exit_code: 1, exit_code_status: "reported", output: "x".repeat(1100),
      output_truncated: false, command_truncated: false, cwd_truncated: false })),
  })
  for (const command of receipt.commands) {
    const remaining = MAX_EXECUTION_EVIDENCE_BYTES - Buffer.byteLength(JSON.stringify(receipt))
    command.output += "x".repeat(Math.min(1500 - command.output!.length, remaining))
  }
  expect(Buffer.byteLength(JSON.stringify(receipt))).toBe(MAX_EXECUTION_EVIDENCE_BYTES)
  return ExecutionEvidenceSchema.parse(receipt)
}

function attemptFixture(run: RunState, attempt: number, complete = false): NodeAttempt {
  const checker = run.nodes.work!.agent === "checker"
  const verification_basis = checker ? buildVerificationBasis(run.criteria, {
    entries: Array.from({ length: 8 }, (_, index) => ({ port: `evidence_${index}`, status: "included" as const,
      source: { run_id: run.run_id, kind: "node_output" as const, reference: `probe.${"x".repeat(1800)}`, attempt: 1 },
      json_sha256: "a".repeat(64), json_bytes: 2 })), omitted_entries: 0,
  }) : undefined
  const output = checker ? { passed: complete, score: complete ? 10 : 0, failures: complete ? [] : ["criterion not met"],
    findings: run.criteria.map((_, i) => ({ criterion_id: `C${i + 1}`, outcome: complete ? "supported" : "disconfirmed",
      evidence_ids: ["E1"], reason: "synthetic receipt fixture" })) }
    : { summary: ["candidate"], files_touched: [], commands_run: [], risks: [], done: true }
  return {
    attempt, session_id: `child-${attempt}`, started_at: run.created_at, finished_at: run.created_at,
    status: complete ? "done" : "failed", schema_ok: true, output,
    failures: complete ? [] : [checker ? "criterion not met" : "shell gate failed"],
    outcome: complete ? "passed" : checker ? "substantive_rejection" : "gate_failure",
    ...(checker ? { score: complete ? 10 : 0, verification_basis } : {
      shell_ok: complete,
      execution_evidence: saturatedReceipt(run, attempt),
      gate_evidence: fromShellGateEvidence(`node -e "${"x".repeat(8192 - 10)}"`, {
        cwd: `C:/${"x".repeat(3000)}`, ok: complete, exit_code: complete ? 0 : 1,
        stdout_tail: "x".repeat(3000), stderr_tail: "y".repeat(3000),
      }, { run_id: run.run_id, node_id: "work", attempt }),
      preservation_evidence: PreservationEvidenceSchema.parse({ version: 1,
        files: Array.from({ length: 8 }, (_, index) => ({ path: `${"界".repeat(170)}/${"界".repeat(170)}/${"界".repeat(167)}${index}`,
          before_sha256: "a".repeat(64), after_sha256: "a".repeat(64), status: "unchanged" })) }),
    }),
  }
}

function seedRun(project: string, agent: "implementer" | "checker") {
  const run = createRun({ goal: "receipt capacity", criteria: Array.from({ length: 100 }, (_, i) => `criterion ${i + 1}`),
    projectDirectory: project, ownerSessionId: "session-owner", graph: {
      name: "receipt-capacity", max_global_attempts: 100, max_concurrency: 1,
      nodes: [{ id: "work", agent, depends_on: [], loop: { max_attempts: 100, gate: agent === "checker" ? "schema" : "all" },
        ...(agent === "checker" ? { isolated_check: true, verification: { version: 1 as const } } : { shell_gate: { cmd: "node fixture-check.cjs" } }) }],
    } })
  const attempts = Array.from({ length: 99 }, (_, index) => attemptFixture(run, index + 1))
  Object.assign(run, { status: "blocked", phase: "blocked", global_attempts: 99 })
  Object.assign(run.nodes.work!, { status: "pending", current_attempt: 99, attempts,
    output: attempts.at(-1)!.output, last_failures: attempts.at(-1)!.failures })
  return run
}

describe("bounded receipt-bearing attempt archives", () => {
  test.each(["implementer", "checker"] as const)("%s receipts survive persist, reload and attempt 100", agent => {
    const project = tempProject("alg-archive-cap-")
    try {
      const run = seedRun(project, agent)
      const original = structuredClone(run.nodes.work!.attempts)
      persistRun(run, project)
      const loaded = loadRun(project, run.run_id)!
      expect(loaded.nodes.work!.attempts).toHaveLength(MAX_INLINE_ATTEMPTS_PER_NODE)
      const reference = loaded.nodes.work!.attempt_history_ref!
      expect(reference.byte_size).toBeLessThanOrEqual(MAX_ATTEMPT_HISTORY_BYTES)
      expect(reference.attempt_count).toBe(95)
      expect(reference.output_count).toBe(95)
      expect(reference.session_count).toBe(95)
      expect(reference.failure_commitment_count).toBe(95)
      const archive = JSON.parse(readFileSync(join(project, reference.artifact_path), "utf8"))
      expect(archive.schema_version).toBe(3)
      for (const attempt of archive.attempts) {
        expect(attempt.output).toBeUndefined()
        expect(attempt.output_ref).toBeDefined()
        expect(attempt.detail_ref).toBeDefined()
        for (const field of ["execution_evidence", "gate_evidence", "preservation_evidence", "verification_basis"]) {
          expect(attempt[field]).toBeUndefined()
        }
      }
      const resumed = hydrateRunForExecution(loaded)
      for (let i = 0; i < original.length; i++) {
        for (const field of ["output", "execution_evidence", "gate_evidence", "preservation_evidence", "verification_basis", "failures"] as const) {
          expect(resumed.nodes.work!.attempts[i]![field]).toEqual(original[i]![field])
        }
      }
      const next = attemptFixture(resumed, 100, true)
      resumed.nodes.work!.attempts.push(next)
      Object.assign(resumed.nodes.work!, { current_attempt: 100, status: "done", output: next.output, last_failures: [] })
      Object.assign(resumed, { global_attempts: 100, status: "done", phase: "done" })
      persistRun(resumed, project)
      const final = loadRun(project, run.run_id)!
      expect(final.global_attempts).toBe(100)
      expect(final.nodes.work!.attempt_history_ref!.attempt_count).toBe(96)
      expect(final.nodes.work!.attempt_history_ref!.outcome_counts?.[agent === "checker" ? "substantive_rejection" : "gate_failure"]).toBe(96)
      expect(hydrateRunFully(final).nodes.work!.attempts[0]!.output).toEqual(original[0]!.output)
      expect(final.nodes.work!.attempts.at(-1)!.output).toEqual(next.output)

      // The sidecar remains the exact authority: changing receipt bytes cannot hydrate.
      const detailPath = join(project, archive.attempts[0].detail_ref.artifact_path)
      const originalDetail = readFileSync(detailPath, "utf8")
      const detail = JSON.parse(originalDetail)
      detail.failures = ["tampered"]
      writeFileSync(detailPath, JSON.stringify(detail))
      expect(() => hydrateRunFully(final)).toThrow(/integrity|size mismatch/)
      writeFileSync(detailPath, originalDetail)

      // A compact row cannot override the omitted fields even under a new valid archive hash.
      const currentReference = final.nodes.work!.attempt_history_ref!
      const currentArchive = JSON.parse(readFileSync(join(project, currentReference.artifact_path), "utf8"))
      const injectedField = agent === "checker" ? "verification_basis" : "execution_evidence"
      currentArchive.attempts[0][injectedField] = original[0]![injectedField]
      const hash = sha256Json(currentArchive)
      const name = `work-attempts-${hash}.json`
      writeFileSync(join(runDir(project, run.run_id), "history", name), canonicalJson(currentArchive))
      final.nodes.work!.attempt_history_ref = { ...currentReference,
        artifact_path: `.opencode/runs/${run.run_id}/history/${name}`, sha256: hash,
        byte_size: Buffer.byteLength(JSON.stringify(currentArchive)) }
      expect(() => hydrateRunFully(final)).toThrow(/compact.*inline|inline.*compact/)
      const bytes = (value: unknown) => value === undefined ? 0 : Buffer.byteLength(JSON.stringify(value))
      console.info(JSON.stringify({ fixture: agent, seeded_attempts: 99, completed_attempts: final.global_attempts,
        archive_attempts: currentReference.attempt_count, archive_bytes: currentReference.byte_size,
        archive_limit: MAX_ATTEMPT_HISTORY_BYTES, inline_attempts: final.nodes.work!.attempts.length,
        native_receipt_bytes: bytes(original[0]!.execution_evidence), gate_receipt_bytes: bytes(original[0]!.gate_evidence),
        preservation_bytes: bytes(original[0]!.preservation_evidence), basis_bytes: bytes(original[0]!.verification_basis) }))
    } finally { removeProject(project) }
  }, 120_000)
})

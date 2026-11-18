import { expect, test } from "bun:test"
import { formatCompactionContext } from "../src/compaction.ts"
import { createRun } from "../src/store.ts"
import { tempProject, removeProject } from "./helpers.ts"

test("compaction retains action commitments and evidence gaps without copying command text", () => {
  const project = tempProject()
  try {
    const run = createRun({ projectDirectory: project, ownerSessionId: "owner", goal: "Recover evidence without another submission",
      criteria: ["Required observation"], graph: { name: "context-evidence", max_global_attempts: 2, max_concurrency: 1,
        nodes: [{ id: "work", agent: "implementer", depends_on: [] },
          { id: "check", agent: "checker", depends_on: ["work"], inputs: { claimed: "work" } }] } })
    const sha256 = "a".repeat(64)
    run.nodes.work!.attempts.push({ attempt: 1, status: "failed", started_at: new Date().toISOString(), failures: [],
      action_evidence_ref: {
        artifact_path: `.opencode/runs/${run.run_id}/artifacts/action-evidence/session/manifest-${sha256}.json`, sha256, byte_size: 512 },
      execution_evidence: { version: 1, run_id: run.run_id, node_id: "work", attempt: 1, retrieval_status: "available",
        commands: [{ tool: "bash", tool_status: "completed", command: "COMMAND_MUST_STAY_OUT_OF_COMPACTION", exit_code_status: "unavailable",
          command_truncated: false, cwd_truncated: false, output_truncated: false }], omitted_commands: 0,
        foreign_messages_omitted: 0, window_may_be_incomplete: true } })
    run.nodes.check!.attempts.push({ attempt: 1, status: "failed", started_at: new Date().toISOString(),
      failures: ["Required evidence remains unavailable"], outcome: "evidence_unavailable" })
    for (const summary of [formatCompactionContext(run), formatCompactionContext(run, 4096)]) {
      expect(summary).toContain(sha256)
      expect(summary).toContain("do not replay the producer")
      expect(summary).not.toContain("COMMAND_MUST_STAY_OUT_OF_COMPACTION")
    }
    expect(Buffer.byteLength(formatCompactionContext(run, 512))).toBeLessThanOrEqual(512)
  } finally { removeProject(project) }
})

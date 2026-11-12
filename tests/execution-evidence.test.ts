import { describe, expect, test } from "bun:test"
import { buildCheckerEvidence } from "../src/checker-evidence.ts"
import { captureChildExecutionEvidence, ExecutionEvidenceSchema, fromShellGateEvidence } from "../src/execution-evidence.ts"
import type { GraphDef } from "../src/types.ts"

function fakeClient(messages: unknown[], resolveDelay = 0): any {
  return { session: { messages: async () => {
    if (resolveDelay) await new Promise(resolve => setTimeout(resolve, resolveDelay))
    return { data: messages }
  } } }
}

const tool = (overrides: Record<string, unknown> = {}) => ({
  id: "part-1", callID: "call-1", type: "tool", tool: "bash", sessionID: "child", messageID: "message-1",
  state: { status: "completed", input: { command: "npm test", cwd: "C:/work" }, output: "all tests passed", metadata: { exit_code: 0 } },
  ...overrides,
})

describe("host-origin child execution evidence", () => {
  test("captures only host bash tool records and requires exact exit metadata", async () => {
    const evidence = await captureChildExecutionEvidence(fakeClient([
      { info: { id: "assistant-1", role: "assistant" }, parts: [
        { type: "reasoning", text: "DO_NOT_CAPTURE_REASONING" },
        { type: "text", text: "model says npm test passed" },
        tool(),
        tool({ callID: "call-2", state: { status: "completed", input: { command: "bun test" }, output: "exit code 0; passed", metadata: {} } }),
      ] },
    ]), { run_id: "run", node_id: "implement", attempt: 2, child_session_id: "child", directory: "C:/work" })
    expect(evidence.retrieval_status).toBe("available")
    expect(evidence.commands).toHaveLength(2)
    expect(evidence.commands[0]).toMatchObject({ command: "npm test", cwd: "C:/work", call_id: "call-1", message_id: "assistant-1", exit_code: 0, exit_code_status: "reported" })
    expect(evidence.commands[1]).toMatchObject({ exit_code_status: "unavailable" })
    expect(JSON.stringify(evidence)).not.toContain("DO_NOT_CAPTURE_REASONING")
    expect(evidence.commands[1]!.exit_code).toBeUndefined()
  })

  test("reports retrieval timeout and omitted command rows explicitly", async () => {
    const timeout = await captureChildExecutionEvidence(fakeClient([], 80), {
      run_id: "r", node_id: "n", attempt: 1, child_session_id: "child", timeout_ms: 5,
    })
    expect(timeout).toMatchObject({ retrieval_status: "unavailable", unavailable_reason: "timeout", commands: [] })

    const many = Array.from({ length: 11 }, (_, index) => tool({ callID: `c-${index}` }))
    const bounded = await captureChildExecutionEvidence(fakeClient([{ info: { id: "m" }, parts: many }]), {
      run_id: "r", node_id: "n", attempt: 1, child_session_id: "child",
    })
    expect(bounded.commands).toHaveLength(8)
    expect(bounded.omitted_commands).toBeGreaterThanOrEqual(3)
    expect(bounded.window_may_be_incomplete).toBe(false)
    expect(Buffer.byteLength(JSON.stringify(bounded))).toBeLessThanOrEqual(12 * 1024)
  })

  test("sanitizes and bounds command output while marking truncation", async () => {
    const evidence = await captureChildExecutionEvidence(fakeClient([{ info: { id: "m" }, parts: [tool({
      state: { status: "completed", input: { command: "echo TOKEN=private" }, output: `API_KEY=secret\n${"x".repeat(3_000)}`, metadata: {} },
    })] }]), { run_id: "r", node_id: "n", attempt: 1, child_session_id: "child" })
    const command = evidence.commands[0]!
    expect(command.command).toContain("[REDACTED]")
    expect(command.output).not.toContain("secret")
    expect(command.output_truncated).toBe(true)
    expect(Buffer.byteLength(command.output ?? "")).toBeLessThanOrEqual(1_500)
  })

  test("checker evidence attaches only receipts from claimed or selected evidence inputs", () => {
      const graph: GraphDef = { name: "host-receipts", max_global_attempts: 3, max_concurrency: 1, nodes: [
        { id: "work", agent: "implementer", depends_on: [] },
        { id: "sibling", agent: "implementer", depends_on: [] },
        { id: "check", agent: "checker", depends_on: ["work", "sibling"], inputs: { claimed: "work", evidence_note: '"selected"' } },
      ] }
      const run: any = { run_id: "run", graph, nodes: { work: { current_attempt: 1, attempts: [] }, sibling: { current_attempt: 1, attempts: [] } } }
      for (const [id, session] of [["work", "child-work"], ["sibling", "child-sibling"]] as const) {
        run.nodes[id]!.current_attempt = 1
        run.nodes[id]!.attempts.push({ attempt: 1, status: "done", session_id: session, started_at: new Date().toISOString(), failures: [],
          execution_evidence: { version: 1, run_id: run.run_id, node_id: id, attempt: 1, child_session_id: session,
            retrieval_status: "available", commands: [], omitted_commands: 0, window_may_be_incomplete: false, foreign_messages_omitted: 0 } } as any)
      }
      const evidence = buildCheckerEvidence(run.graph.nodes[2]!, run)!
      expect(evidence.entries.filter(entry => entry.source.kind === "host_execution")).toHaveLength(1)
      expect(evidence.entries.find(entry => entry.source.kind === "host_execution")!.source.reference).toBe("work")
      expect(JSON.stringify(evidence)).not.toContain("child-sibling")

      run.nodes.work.attempts[0].gate_evidence = fromShellGateEvidence("npm test", {
        ok: true, exit_code: 0, cwd: "C:/repo", stdout_tail: "PASS", stderr_tail: "",
      }, { run_id: "run", node_id: "work", attempt: 1 })
      const withGate = buildCheckerEvidence(run.graph.nodes[2]!, run)!
      expect(withGate.entries.filter(entry => entry.source.kind === "host_execution")).toHaveLength(2)
      expect(withGate.entries.map(entry => entry.port)).toContain("host_gate_work")
      run.nodes.work.attempts[0].execution_evidence.run_id = "forged-run"
      const identityChecked = buildCheckerEvidence(run.graph.nodes[2]!, run)!
      expect(identityChecked.entries.filter(entry => entry.port === "host_execution_work")).toHaveLength(0)
      expect(identityChecked.entries.map(entry => entry.port)).toContain("host_gate_work")
  })

  test("shell-gate helper retains exact host result, setup and containment flags", () => {
    const evidence = fromShellGateEvidence("npm test", {
      ok: false, exit_code: 125, cwd: "C:/repo", stdout_tail: "compiler diagnostic", stderr_tail: "", setup_failed: true,
      termination_failed: true,
    }, { run_id: "r", node_id: "gate", attempt: 3 })
    expect(evidence).toMatchObject({ retrieval_status: "available", commands: [{ tool: "shell_gate", command: "npm test", cwd: "C:/repo",
      exit_code: 125, gate_ok: false, setup_failed: true, termination_failed: true, output: "stdout:\ncompiler diagnostic" }] })
  })

  test("receipt schema rejects oversized aggregates and foreign-session parts are counted", async () => {
    const command = { tool: "bash", tool_status: "completed", exit_code_status: "unavailable", output: "x".repeat(4_000),
      output_truncated: false, command_truncated: false, cwd_truncated: false }
    expect(ExecutionEvidenceSchema.safeParse({ version: 1, run_id: "r", node_id: "n", attempt: 1, child_session_id: "child",
      retrieval_status: "available", commands: Array.from({ length: 8 }, () => command), omitted_commands: 0,
      window_may_be_incomplete: false, foreign_messages_omitted: 0 }).success).toBe(false)
    const result = await captureChildExecutionEvidence(fakeClient([{ info: { id: "foreign-message", sessionID: "other" }, parts: [tool()] },
      { info: { id: "accepted", sessionID: "child" }, parts: [tool({ sessionID: "child" })] }]), {
      run_id: "r", node_id: "n", attempt: 1, child_session_id: "child",
    })
    expect(result.commands).toHaveLength(1)
    expect(result.foreign_messages_omitted).toBe(1)
  })
})

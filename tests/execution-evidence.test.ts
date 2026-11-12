import { describe, expect, test } from "bun:test"
import { buildCheckerEvidence, type CheckerEvidence } from "../src/checker-evidence.ts"
import { appendHostExecutionEvidence, captureChildExecutionEvidence, ExecutionEvidenceSchema, fromShellGateEvidence } from "../src/execution-evidence.ts"
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
  test("checker projection compacts outputs across commands before omitting rows", async () => {
    const source = ExecutionEvidenceSchema.parse({ version: 1, run_id: "run", node_id: "tests", attempt: 1, child_session_id: "child",
      retrieval_status: "available", commands: Array.from({ length: 8 }, (_, index) => ({ call_id: `call-${index}`, message_id: "message",
        tool: "bash", command: `test-${index}`, cwd: `C:/work/${index}`, tool_status: "completed", exit_code: index === 3 ? 7 : 0,
        exit_code_status: "reported", output: `output-${index}-${"x".repeat(900)}`, output_truncated: false,
        command_truncated: false, cwd_truncated: false })), omitted_commands: 0, window_may_be_incomplete: false, foreign_messages_omitted: 0 })
    const before = JSON.stringify(source)
    const projected = appendHostExecutionEvidence<CheckerEvidence>({ entries: [], omitted_entries: 0 }, source)!
    const entry = projected.entries[0]!
    const value = entry.value as typeof source
    expect(entry.status).toBe("included")
    expect(value.commands).toHaveLength(8)
    expect(value.commands.map(command => command.command)).toEqual(Array.from({ length: 8 }, (_, index) => `test-${index}`))
    expect(value.commands.map(command => command.exit_code)).toEqual([0, 0, 0, 7, 0, 0, 0, 0])
    expect(value.commands.every(command => command.output_truncated && Buffer.byteLength(command.output ?? "") <= 128)).toBe(true)
    expect(entry.json_bytes).toBeLessThanOrEqual(4 * 1024)
    expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(16 * 1024)
    expect(JSON.stringify(source)).toBe(before)
  })

  test("projection keeps exact command and cwd after output trimming, or removes identity entirely", () => {
    const makeSource = (command: string, cwd: string) => ExecutionEvidenceSchema.parse({
      version: 1, run_id: "r", node_id: "n", attempt: 1, child_session_id: "child", retrieval_status: "available",
      commands: [{ tool: "bash", tool_status: "completed", exit_code: 0, exit_code_status: "reported",
        command, cwd, command_truncated: false, cwd_truncated: false,
        output: "🧪".repeat(900), output_truncated: false }],
      omitted_commands: 0, window_may_be_incomplete: false, foreign_messages_omitted: 0,
    })
    const exactCommand = `npm test --filter=${"a".repeat(180)}`
    const exactCwd = `C:/work/${"b".repeat(180)}`
    const source = makeSource(exactCommand, exactCwd)
    const projected = appendHostExecutionEvidence<CheckerEvidence>({ entries: [], omitted_entries: 0 }, source)!
    expect((projected.entries[0]!.value as typeof source).commands[0]).toMatchObject({
      command: exactCommand, cwd: exactCwd, command_truncated: false, cwd_truncated: false, output_truncated: true,
    })
    expect(JSON.stringify(source)).toContain("🧪")

    const longSource = makeSource(`npm test --filter=${"a".repeat(3_850)}`, `C:/work/${"b".repeat(300)}`)
    const compact = appendHostExecutionEvidence<CheckerEvidence>({ entries: [], omitted_entries: 0 }, longSource)!
    const row = (compact.entries[0]!.value as typeof source).commands[0]!
    expect(compact.entries[0]!.status).toBe("included")
    expect(row.command).toBeUndefined()
    expect(row.cwd).toBeUndefined()
    expect(row.command_truncated).toBe(true)
    expect(row.cwd_truncated).toBe(true)
    expect(row.exit_code).toBe(0)
    expect(compact.entries[0]!.json_bytes).toBeLessThanOrEqual(4 * 1024)
    expect(longSource.commands[0]!.command).toContain("npm test --filter=")

    const mixed = ExecutionEvidenceSchema.parse({ ...longSource, commands: [
      longSource.commands[0], { ...longSource.commands[0], command: "bun test", cwd: "C:/repo" },
    ] })
    const mixedProjection = appendHostExecutionEvidence<CheckerEvidence>({ entries: [], omitted_entries: 0 }, mixed)!
    const mixedRows = (mixedProjection.entries[0]!.value as typeof source).commands
    expect(mixedRows).toHaveLength(2)
    expect(mixedRows[0]).toMatchObject({ command_truncated: true, exit_code: 0 })
    expect(mixedRows[0]!.command).toBeUndefined()
    expect(mixedRows[1]).toMatchObject({ command: "bun test", cwd: "C:/repo", command_truncated: false })
  })

  test("captured command normalization is disclosed as loss of exact identity", async () => {
    const source = await captureChildExecutionEvidence(fakeClient([{ info: { id: "m" }, parts: [
      tool({ state: { status: "completed", input: { command: "  npm test  ", cwd: "  C:/repo  " },
        output: "ok", metadata: { exit_code: 0 } } }),
      tool({ callID: "redacted", state: { status: "completed", input: { command: "npm test --token=private-value" },
        output: "ok", metadata: { exit_code: 0 } } }),
    ] }]), { run_id: "r", node_id: "n", attempt: 1, child_session_id: "child" })
    expect(source.commands[0]).toMatchObject({ command: "npm test", command_truncated: true,
      cwd: "C:/repo", cwd_truncated: true, exit_code: 0 })
    expect(source.commands[1]!.command).not.toContain("private-value")
    expect(source.commands[1]!.command_truncated).toBe(true)
  })

  test("projection preserves unavailable and nonzero exit outcomes without inferring success", async () => {
    const source = await captureChildExecutionEvidence(fakeClient([{ info: { id: "m" }, parts: [
      tool({ callID: "unknown", state: { status: "completed", input: { command: "unknown" }, output: "exit code 0", metadata: {} } }),
      tool({ callID: "failed", state: { status: "error", input: { command: "failed", cwd: "C:/repo" }, error: "failed", metadata: { exit_code: 23 } } }),
    ] }]), { run_id: "r", node_id: "n", attempt: 1, child_session_id: "child" })
    const projected = appendHostExecutionEvidence<CheckerEvidence>({ entries: [], omitted_entries: 0 }, source)!
    const commands = (projected.entries[0]!.value as typeof source).commands
    expect(commands[0]).toMatchObject({ exit_code_status: "unavailable", tool_status: "completed", command: "unknown" })
    expect(commands[0]!.exit_code).toBeUndefined()
    expect(commands[1]).toMatchObject({ exit_code_status: "reported", exit_code: 23, tool_status: "error", cwd: "C:/repo" })
  })

  test("projection preserves omission accounting and UTF-8-safe truncation", async () => {
    const source = await captureChildExecutionEvidence(fakeClient([{ info: { id: "m" }, parts: [tool({
      callID: "utf8", state: { status: "completed", input: { command: "echo 🧪".repeat(600), cwd: "C:/🧪/".repeat(600) },
        output: "🧪".repeat(1_000), metadata: { exit_code: 0 } },
    })] }]), { run_id: "r", node_id: "n", attempt: 1, child_session_id: "child" })
    const output = appendHostExecutionEvidence<CheckerEvidence>({ entries: [], omitted_entries: 0 }, source)!
    const value = output.entries[0]!.value as typeof source
    expect(value.commands[0]).toMatchObject({ output_truncated: true, command_truncated: true, cwd_truncated: true })
    expect(() => JSON.parse(JSON.stringify(output))).not.toThrow()
    const full = { entries: Array.from({ length: 8 }, () => ({})), omitted_entries: 2 }
    const capped = appendHostExecutionEvidence(full, source)!
    expect(capped.omitted_entries).toBe(3)
    expect(capped.entries).toBe(full.entries)
    expect(appendHostExecutionEvidence(undefined, source)).toBeUndefined()
    const nearSharedLimit = { entries: [{ value: "x".repeat(16 * 1024 - 128) }], omitted_entries: 4 }
    const sharedCapped = appendHostExecutionEvidence(nearSharedLimit, source)!
    expect(sharedCapped.omitted_entries).toBe(5)
    expect(sharedCapped.entries).toBe(nearSharedLimit.entries)
  })

  test("only drops commands after compact metadata still cannot fit", async () => {
    const hugeIdentity = "i".repeat(255)
    const source = ExecutionEvidenceSchema.parse({ version: 1, run_id: "r", node_id: "n", attempt: 1, child_session_id: "child",
      retrieval_status: "available", commands: Array.from({ length: 8 }, (_, index) => ({
        call_id: `${index}${hugeIdentity}`, message_id: `${index}${hugeIdentity}`, tool: "bash", tool_status: "completed",
        exit_code: index, exit_code_status: "reported", output: "x".repeat(500), output_truncated: false,
        command: `test-${index}`, command_truncated: false, cwd: "C:/repo", cwd_truncated: false,
      })), omitted_commands: 0, window_may_be_incomplete: false, foreign_messages_omitted: 0 })
    const projected = appendHostExecutionEvidence<CheckerEvidence>({ entries: [], omitted_entries: 0 }, source)!
    const entry = projected.entries[0]!
    expect(entry.status).toBe("included")
    const value = entry.value as typeof source
    expect(value.commands.length).toBeGreaterThan(0)
    expect(value.commands.length).toBeLessThan(8)
    expect(value.omitted_commands).toBe(8 - value.commands.length)
    expect(value.commands.every(command => command.exit_code_status === "reported" && command.output_truncated)).toBe(true)
    expect(entry.json_bytes).toBeLessThanOrEqual(4 * 1024)
  })

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

  test.each(["timeout", "aborted"] as const)("retains %s when the SDK rejects immediately on abort", async reason => {
    const controller = new AbortController()
    let requests = 0
    const client = { session: { messages: ({ signal }: { signal: AbortSignal }) => {
      requests++
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true })
      })
    } } } as any
    const pending = captureChildExecutionEvidence(client, {
      run_id: "r", node_id: "n", attempt: 1, child_session_id: "child",
      signal: controller.signal, timeout_ms: reason === "timeout" ? 5 : 1000,
    })
    if (reason === "aborted") controller.abort()
    expect(await pending).toMatchObject({ retrieval_status: "unavailable", unavailable_reason: reason, commands: [] })
    expect(requests).toBe(1)
  })

  test("keeps ordinary SDK rejection distinct from cancellation", async () => {
    const client = { session: { messages: async () => { throw new Error("transport failed") } } } as any
    expect(await captureChildExecutionEvidence(client, {
      run_id: "r", node_id: "n", attempt: 1, child_session_id: "child",
    })).toMatchObject({ retrieval_status: "unavailable", unavailable_reason: "sdk_error", commands: [] })
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

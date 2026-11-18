import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { ActionEvidenceJournal, ACTION_EVIDENCE_MAX_COMMAND_BYTES, ACTION_EVIDENCE_MAX_OUTPUT_BYTES, readActionManifest, readActionRecord, type ActionEvidenceIdentity } from "../src/action-evidence.ts"
import { EvidenceRetrieval, evidencePage } from "../src/evidence-retrieval.ts"
import { tempProject, removeProject } from "./helpers.ts"

const identity: ActionEvidenceIdentity = { run_id: "run-action", node_id: "worker", attempt: 2 }
const call = (sessionID: string, callID: string, tool = "bash") => ({ tool, sessionID, callID })
const hash = (value: string) => createHash("sha256").update(value).digest("hex")
const evidenceDir = (project: string, session: string) => join(project, ".opencode", "runs", identity.run_id, "artifacts", "action-evidence", hash(session))

describe("durable action evidence", () => {
  test.each([
    ["zero", { exit_code: 0 }, "reported", 0],
    ["nonzero", { exit_code: 7 }, "reported", 7],
    ["unavailable", {}, "unavailable", undefined],
  ] as const)("links terminal evidence for %s exit metadata without changing its meaning", (_label, metadata, exitCodeStatus, exitCode) => {
    const project = tempProject("action-evidence-linked-")
    try {
      const journal = new ActionEvidenceJournal(project), session = "child_linked"
      journal.bind(session, identity)
      const row = call(session, "linked-call")
      const intentRef = journal.before(row, { command: "bun test" })!
      const terminalRef = journal.after(row, { output: "finished", metadata })!
      const intent = journal.readRecord(intentRef, { ...identity, child_session_id: session })
      const terminal = journal.readRecord(terminalRef, { ...identity, child_session_id: session })
      expect(intent).toMatchObject({ kind: "intent", ordinal: 1, command: "bun test", command_redacted: false, command_source_truncated: false })
      expect(terminal).toMatchObject({ kind: "terminal", ordinal: 1, intent_sha256: intentRef.sha256,
        call_id_sha256: intent.kind === "intent" ? intent.call_id_sha256 : "", tool_status: "completed", exit_code_status: exitCodeStatus })
      if (terminal.kind === "terminal") expect(terminal.exit_code).toBe(exitCode)
      expect(() => readActionManifest(project, journal.finish(session), identity)).not.toThrow()
    } finally { removeProject(project) }
  })

  test("keeps retrieval index and page scope reminders concise and uncertainty-bounded", () => {
    const project = tempProject("action-evidence-retrieval-scope-")
    try {
      const journal = new ActionEvidenceJournal(project), session = "child_scope"
      journal.bind(session, identity)
      const intent = journal.before(call(session, "scope-call"), { command: "echo observed" })!
      const retrieval = new EvidenceRetrieval(project)
      retrieval.grant("checker_scope", identity.run_id, { version: 1, journals: [], omitted: 0, unavailable: 0 }, [
        { reference: intent, node_id: identity.node_id, attempt: identity.attempt, kind: "intent", ordinal: intent.ordinal },
      ])
      const index = retrieval.execute("checker_scope", { evidence: "index" })
      expect("warning" in index && index.warning).toContain("Linked-pair hashes bind one captured call")
      const page = evidencePage(project, identity.run_id, { artifact_path: intent.artifact_path, sha256: intent.sha256, byte_size: intent.byte_size })
      expect(page.scope).toContain("Retained JSON byte fragment")
      expect(page.scope).toContain("Missing pages, redaction/truncation")
    } finally { removeProject(project) }
  })

  test("writes intent before terminal, retains cwd and exact metadata exit code, and pages through verified references", () => {
    const project = tempProject("action-evidence-")
    try {
      const journal = new ActionEvidenceJournal(project), session = "child_1"
      journal.bind(session, identity)
      expect(journal.has(session)).toBe(true)
      const intent = journal.before({ ...call(session, "call-1"), args: { command: "bun test", cwd: "C:/repo" } }, { command: "bun test", cwd: "C:/repo" })!
      const intentRecord = journal.readRecord(intent, { ...identity, child_session_id: session })
      expect(intentRecord).toMatchObject({ kind: "intent", command: "bun test", cwd: "C:/repo", command_redacted: false })
      const terminal = journal.after({ ...call(session, "call-1"), args: { command: "bun test" } }, { output: "done", metadata: { exit_code: 7 } })!
      expect(journal.readRecord(terminal, { ...identity, child_session_id: session })).toMatchObject({ kind: "terminal", exit_code: 7, exit_code_status: "reported", source: "hook" })
      const ref = journal.finish(session)
      expect(journal.has(session)).toBe(false)
      const manifest = readActionManifest(project, ref, identity)
      expect(manifest.entries.map(entry => entry.kind)).toEqual(["intent", "terminal"])
      expect(manifest.coverage).toMatchObject({ observed_calls: 1, completed: 1, unknown_terminal: 0, complete: false })
      expect(readActionRecord(project, manifest.entries[1]!, { ...identity, child_session_id: session }).kind).toBe("terminal")
    } finally { removeProject(project) }
  })

  test("keeps redacted and source-truncated indicators separate for shell credentials and long commands", () => {
    const project = tempProject("action-evidence-redact-")
    try {
      const journal = new ActionEvidenceJournal(project), session = "child_redact"
      journal.bind(session, identity)
      const raw = `curl https://alice:URLPASS@example.test --password CLI_PASS --token=TOKEN_PASS API_KEY=ASSIGN_PASS ${"x".repeat(ACTION_EVIDENCE_MAX_COMMAND_BYTES + 100)}`
      const intent = journal.before(call(session, "redact"), { command: raw, cwd: "C:/work" })!
      const record = journal.readRecord(intent, { ...identity, child_session_id: session })
      expect(record.kind).toBe("intent")
      if (record.kind === "intent") {
        expect(record.command).not.toContain("URLPASS")
        expect(record.command).not.toContain("CLI_PASS")
        expect(record.command).not.toContain("TOKEN_PASS")
        expect(record.command).not.toContain("ASSIGN_PASS")
        expect(record.command_redacted).toBe(true)
        expect(record.command_source_truncated).toBe(true)
        expect(Buffer.byteLength(record.command ?? "")).toBeLessThanOrEqual(ACTION_EVIDENCE_MAX_COMMAND_BYTES)
      }
      const terminal = journal.after(call(session, "redact"), { output: `Bearer OUT_SECRET ${"y".repeat(ACTION_EVIDENCE_MAX_OUTPUT_BYTES + 12)}`, metadata: { truncated: true } })!
      const output = journal.readRecord(terminal, { ...identity, child_session_id: session })
      expect(output.kind).toBe("terminal")
      if (output.kind === "terminal") expect(output).toMatchObject({ output_redacted: true, output_source_truncated: true, exit_code_status: "unavailable" })
    } finally { removeProject(project) }
  })

  test("records nine calls and does not apply the diagnostic preview cap to retained commands", () => {
    const project = tempProject("action-evidence-nine-")
    try {
      const journal = new ActionEvidenceJournal(project), session = "child_nine"
      journal.bind(session, identity)
      for (let n = 0; n < 9; n++) {
        const cmd = `bun test ${"z".repeat(2_500)} ${n}`
        const row = call(session, `call-${n}`)
        journal.before(row, { command: cmd })
        journal.after(row, { output: `out-${n}`, metadata: { exit_code: n } })
      }
      const manifest = readActionManifest(project, journal.finish(session), identity)
      expect(manifest.coverage).toMatchObject({ observed_calls: 9, completed: 9, unknown_terminal: 0 })
      const retained = manifest.entries.filter(entry => entry.kind === "intent").map(ref => journal.readRecord(ref, { ...identity, child_session_id: session }))
      expect((retained[0] as any).command).toHaveLength(2_511)
    } finally { removeProject(project) }
  })

  test("retains all 256 allowed calls and records a single bounded call-limit gap", () => {
    const project = tempProject("action-evidence-256-")
    try {
      const journal = new ActionEvidenceJournal(project), session = "child_256"
      journal.bind(session, identity)
      for (let n = 0; n < 256; n++) {
        const row = call(session, `full-${n}`)
        journal.before(row, { command: `echo ${n}` })
        journal.after(row, { output: `out-${n}` })
      }
      expect(journal.before(call(session, "overflow"), { command: "must not run" })).toBeUndefined()
      expect(journal.before(call(session, "overflow-again"), { command: "still must not run" })).toBeUndefined()
      const reference = journal.finish(session)
      expect(reference.byte_size).toBeLessThanOrEqual(512 * 1024)
      const manifest = readActionManifest(project, reference, identity)
      expect(manifest.coverage).toMatchObject({ observed_calls: 256, completed: 256, unknown_terminal: 0, capture_gaps: 1 })
      expect(manifest.entries).toHaveLength(513)
    } finally { removeProject(project) }
  }, 30_000) // Fsynced file-count boundary, not a five-second throughput benchmark.

  test("unsupported tools are gaps and do not block the owned tool hook", () => {
    const project = tempProject("action-evidence-gap-")
    try {
      const journal = new ActionEvidenceJournal(project), session = "child_gap"
      journal.bind(session, identity)
      expect(journal.before(call(session, "not-bash", "read"), { arbitraryTranscript: "private text" })).toBeUndefined()
      const row = call(session, "bash-after")
      journal.before(row, { command: "echo safe" })
      journal.after(row, { output: "safe" })
      const manifest = readActionManifest(project, journal.finish(session), identity)
      expect(manifest.coverage).toMatchObject({ observed_calls: 1, completed: 1, unsupported_tools: 1, capture_gaps: 1 })
      expect(JSON.stringify(manifest)).not.toContain("private text")
      expect(manifest.entries.some(entry => entry.kind === "gap")).toBe(true)
    } finally { removeProject(project) }
  })

  test("retention cap emits an explicit incomplete coverage gap and leaves intent unknown", () => {
    const project = tempProject("action-evidence-cap-")
    try {
      const journal = new ActionEvidenceJournal(project, { maxRetainedBytes: 600 }), session = "child_cap"
      journal.bind(session, identity)
      const row = call(session, "cap")
      journal.before(row, { command: "echo x" })
      expect(journal.after(row, { output: "x" })).toBeUndefined()
      const manifest = readActionManifest(project, journal.finish(session), identity)
      expect(manifest.coverage.complete).toBe(false)
      expect(manifest.coverage.unknown_terminal).toBe(1)
      expect(manifest.coverage.capture_gaps).toBeGreaterThan(0)
    } finally { removeProject(project) }
  })

  test("recovery leaves an unterminated intent unknown and does not invent new calls", () => {
    const project = tempProject("action-evidence-recover-")
    try {
      const session = "child_crash", writer = new ActionEvidenceJournal(project)
      writer.bind(session, identity)
      writer.before(call(session, "started"), { command: "long command" })
      const reader = new ActionEvidenceJournal(project)
      const recovered = reader.recover(identity, session)!
      expect(reader.has(session)).toBe(false)
      expect(reader.recover(identity, session)).toEqual(recovered)
      const manifest = readActionManifest(project, recovered, identity)
      expect(manifest.coverage).toMatchObject({ observed_calls: 1, completed: 0, unknown_terminal: 1, complete: false })
      expect(manifest.entries.filter(entry => entry.kind === "terminal")).toHaveLength(0)
      const absent = new ActionEvidenceJournal(project).recover(identity, "never_started")
      expect(absent).toBeUndefined()
    } finally { removeProject(project) }
  })

  test("plain oversized text is source-truncated without claiming redaction", () => {
    const project = tempProject("action-evidence-size-")
    try {
      const journal = new ActionEvidenceJournal(project), session = "child_size"
      journal.bind(session, identity)
      const reference = journal.before(call(session, "size"), { command: "z".repeat(ACTION_EVIDENCE_MAX_COMMAND_BYTES + 16_384) })!
      expect(journal.readRecord(reference, { ...identity, child_session_id: session })).toMatchObject({
        command_redacted: false, command_source_truncated: true,
      })
    } finally { removeProject(project) }
  })

  test("history reconciliation requires matching explicit session and call id", () => {
    const project = tempProject("action-evidence-history-")
    try {
      const session = "child_history", journal = new ActionEvidenceJournal(project)
      journal.bind(session, identity)
      journal.before(call(session, "known"), { command: "echo known" })
      journal.reconcileHistory(session, [
        { info: { sessionID: session }, parts: [{ tool: "bash", callID: "unknown", sessionID: session, state: { status: "completed", output: "invented" } }] },
        { info: { sessionID: "other" }, parts: [{ tool: "bash", callID: "known", sessionID: session, state: { status: "completed", output: "wrong session" } }] },
        { info: { sessionID: session }, parts: [{ tool: "bash", callID: "known", sessionID: session, state: { status: "completed", output: "recovered", metadata: { exit_code: 0 } } }] },
      ])
      const manifest = readActionManifest(project, journal.finish(session), identity)
      expect(manifest.coverage).toMatchObject({ observed_calls: 1, completed: 1, unknown_terminal: 0 })
      const record = manifest.entries.filter(entry => entry.kind === "terminal").map(ref => journal.readRecord(ref, { ...identity, child_session_id: session }))[0]
      expect(record).toMatchObject({ kind: "terminal", source: "history", output: "recovered", exit_code: 0 })
    } finally { removeProject(project) }
  })

  test("rejects forged, cross-run, cross-attempt, and corrupt references", () => {
    const project = tempProject("action-evidence-forge-")
    try {
      const session = "child_forge", journal = new ActionEvidenceJournal(project)
      journal.bind(session, identity)
      journal.before(call(session, "one"), { command: "echo one" })
      const reference = journal.finish(session)
      expect(() => readActionManifest(project, { ...reference, artifact_path: reference.artifact_path.replace(identity.run_id, "other-run") }, identity)).toThrow()
      expect(() => readActionManifest(project, reference, { ...identity, attempt: 3 })).toThrow()
      const corrupt = join(project, reference.artifact_path)
      // The content-addressed file is deliberately modified to exercise exact-byte verification.
      writeFileSync(corrupt, "{}")
      expect(() => readActionManifest(project, reference, identity)).toThrow()
    } finally { removeProject(project) }
  })

  test("rejects a symlink escape before writing an intent", () => {
    const project = tempProject("action-evidence-link-"), outside = tempProject("action-evidence-outside-")
    try {
      const session = "child_link", journal = new ActionEvidenceJournal(project)
      journal.bind(session, identity)
      const directory = evidenceDir(project, session)
      mkdirSync(join(project, ".opencode", "runs", identity.run_id, "artifacts", "action-evidence"), { recursive: true })
      symlinkSync(outside, directory, process.platform === "win32" ? "junction" : "dir")
      expect(() => journal.before(call(session, "escape"), { command: "echo escape" })).toThrow()
      expect(readdirSync(outside)).toEqual([])
    } finally { removeProject(project); removeProject(outside) }
  })
})

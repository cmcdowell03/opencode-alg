import { expect, test } from "bun:test"
import { executeRun } from "../src/executor.ts"
import { validateGraph } from "../src/graph.ts"
import { ActionEvidenceJournal } from "../src/action-evidence.ts"
import { EvidenceRetrieval } from "../src/evidence-retrieval.ts"
import { CheckOut } from "../src/schemas.ts"
import { hydrateRunFully, loadRun, createRun } from "../src/store.ts"
import type { NodePromptOpts } from "../src/sessions.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"
import type { z } from "zod"

type CheckerOutput = z.infer<typeof CheckOut>

const produced = {
  answer: "The requested operation was submitted.", evidence: [], constraints: [], options: [],
  acceptance_criteria: ["Review the recorded submission"], risks: [],
}

function makeRun(root: string, checkerAttempts = 1) {
  const criteria = ["Review the recorded submission"]
  const graph = validateGraph({ name: "action-evidence-runtime", max_global_attempts: 1 + checkerAttempts,
    max_concurrency: 1, nodes: [
      { id: "producer", agent: "researcher", depends_on: [], loop: { gate: "schema", max_attempts: 1 } },
      { id: "checker", agent: "checker", depends_on: ["producer"], inputs: { claimed: "producer", evidence: "producer" },
        verification: { version: 1 }, loop: { gate: "schema", max_attempts: checkerAttempts } },
    ] })
  return createRun({ goal: "Review a retained submission", criteria, graph, projectDirectory: root, ownerSessionId: "session-owner" })
}

function actionCall(sessionID: string, callID: string) {
  return { tool: "bash", sessionID, callID, args: { command: "echo recorded" } }
}

async function captureProducer(opts: NodePromptOpts, journal: ActionEvidenceJournal, commands: string[] = ["echo recorded"]) {
  const session_id = "producer-child"
  await opts.onSessionCreated?.(session_id)
  for (let i = 0; i < commands.length; i++) {
    const call = { tool: "bash", sessionID: session_id, callID: `producer-call-${i + 1}` }
    journal.before(call, { command: commands[i], cwd: opts.directory })
    journal.after(call, { output: `terminal ${i + 1}`, metadata: { exit_code: 0 } })
  }
  return { session_id, text: "", parsed: produced }
}

function citationFromRead(retrieval: EvidenceRetrieval, session: string) {
  const index = retrieval.execute(session, { evidence: "index" })
  if (!("records" in index) || !Array.isArray(index.records)) throw new Error("expected a checker evidence index")
  const record = index.records.find(item => item.kind === "intent")
  if (!record) throw new Error("expected an assigned intent record")
  const page = retrieval.execute(session, { evidence: "read", record_id: record.record_id, offset: 0 })
  if (!("citation_id" in page) || typeof page.citation_id !== "string" || !("content" in page) || typeof page.content !== "string") {
    throw new Error("expected a checker evidence page")
  }
  return { citation_id: page.citation_id, page, record }
}

test("retains a long first command and later calls for the checker to retrieve", async () => {
  const root = tempProject()
  try {
    const run = makeRun(root)
    const journal = new ActionEvidenceJournal(root)
    const retrieval = new EvidenceRetrieval(root)
    const longCommand = `submit --payload ${"x".repeat(2_500)} --commit`
    let inspected = false
    const sessionRunner = async (opts: NodePromptOpts) => {
      if (opts.agent === "researcher") return captureProducer(opts, journal, [longCommand, ...Array.from({ length: 9 }, (_, i) => `echo later-${i + 1}`)])
      const child = "checker-child-1"
      await opts.onSessionCreated?.(child)
      const { citation_id, page } = citationFromRead(retrieval, child)
      expect(page.content).toContain(longCommand)
      inspected = true
      return { session_id: child, text: "", parsed: { passed: true, score: 10, failures: [], findings: [
        { criterion_id: "C1", outcome: "supported", evidence_ids: [citation_id], reason: "The retained intent records the submitted command." },
      ] } }
    }

    const completed = await executeRun(run, { ...executeContext(root), sessionRunner,
      actionEvidence: { journal, retrieval } })
    expect(completed.status).toBe("done")
    expect(inspected).toBe(true)
    const producerAttempt = completed.nodes.producer!.attempts[0]!
    const manifest = journal.readManifest(producerAttempt.action_evidence_ref!, {
      run_id: completed.run_id, node_id: "producer", attempt: 1,
    })
    expect(manifest.coverage).toMatchObject({ observed_calls: 10, completed: 10, unknown_terminal: 0 })
    expect(manifest.entries.filter(entry => entry.kind === "intent")).toHaveLength(10)
  } finally { removeProject(root) }
})

test("an inconclusive retrieval gap retries the checker without rerunning its producer", async () => {
  const root = tempProject()
  try {
    const run = makeRun(root, 2)
    const journal = new ActionEvidenceJournal(root)
    const retrieval = new EvidenceRetrieval(root)
    const calls: string[] = []
    const sessionRunner = async (opts: NodePromptOpts) => {
      calls.push(opts.agent)
      if (opts.agent === "researcher") return captureProducer(opts, journal)
      const child = `checker-child-${calls.filter(agent => agent === "checker").length}`
      await opts.onSessionCreated?.(child)
      if (child === "checker-child-1") return { session_id: child, text: "", parsed: {
        passed: false, score: 3, failures: ["Evidence not inspected"], findings: [
          { criterion_id: "C1", outcome: "inconclusive", evidence_ids: [], reason: "Necessary evidence has not been inspected." },
        ],
      } }
      const { citation_id } = citationFromRead(retrieval, child)
      return { session_id: child, text: "", parsed: { passed: true, score: 10, failures: [], findings: [
        { criterion_id: "C1", outcome: "supported", evidence_ids: [citation_id], reason: "The retrieved intent supports the submission." },
      ] } }
    }

    const completed = await executeRun(run, { ...executeContext(root), sessionRunner,
      actionEvidence: { journal, retrieval } })
    expect(completed.status).toBe("done")
    expect(calls).toEqual(["researcher", "checker", "checker"])
    expect(completed.global_attempts).toBe(3)
    expect(completed.nodes.checker!.attempts.map(attempt => attempt.outcome)).toEqual(["evidence_unavailable", "passed"])
    expect(completed.nodes.producer!.current_attempt).toBe(1)
  } finally { removeProject(root) }
})

test("checker retrieval is frozen to assigned sources and revoked when the session ends", async () => {
  const root = tempProject()
  try {
    const run = makeRun(root)
    const journal = new ActionEvidenceJournal(root)
    const retrieval = new EvidenceRetrieval(root)
    let checkerChild = ""
    let assignedRecordId = ""
    const sessionRunner = async (opts: NodePromptOpts) => {
      if (opts.agent === "researcher") return captureProducer(opts, journal)
      checkerChild = "checker-child-frozen"
      await opts.onSessionCreated?.(checkerChild)
      const index = retrieval.execute(checkerChild, { evidence: "index" })
      if (!("records" in index) || !Array.isArray(index.records)) throw new Error("expected a checker evidence index")
      assignedRecordId = index.records[0]!.record_id
      expect(() => retrieval.execute("unrelated-session", { evidence: "index" })).toThrow("no active checker evidence grant")
      expect(() => retrieval.execute(checkerChild, { evidence: "read", record_id: "f".repeat(64), offset: 0 })).toThrow("record is not assigned")
      expect(() => retrieval.execute(checkerChild, { evidence: "index", run_id: "different-run" })).toThrow("no active checker evidence grant")
      const { citation_id } = citationFromRead(retrieval, checkerChild)
      return { session_id: checkerChild, text: "", parsed: { passed: true, score: 10, failures: [], findings: [
        { criterion_id: "C1", outcome: "supported", evidence_ids: [citation_id], reason: "Assigned retained evidence supports the finding." },
      ] } }
    }

    const completed = await executeRun(run, { ...executeContext(root), sessionRunner,
      actionEvidence: { journal, retrieval } })
    expect(completed.status).toBe("done")
    expect(() => retrieval.execute(checkerChild, { evidence: "read", record_id: assignedRecordId, offset: 0 })).toThrow("no active checker evidence grant")
    const producerAttempt = completed.nodes.producer!.attempts[0]!
    expect(() => journal.before(actionCall("producer-child", "late-call"), { command: "echo late" })).toThrow("no action evidence binding")
    const manifest = journal.readManifest(producerAttempt.action_evidence_ref!, {
      run_id: completed.run_id, node_id: "producer", attempt: 1,
    })
    expect(manifest.coverage.observed_calls).toBe(1)
    expect(manifest.entries).toHaveLength(2)
  } finally { removeProject(root) }
})

test("source references and compact retrieval receipts survive store reload and integrity checks", async () => {
  const root = tempProject()
  try {
    const run = makeRun(root)
    const journal = new ActionEvidenceJournal(root)
    const retrieval = new EvidenceRetrieval(root)
    const sessionRunner = async (opts: NodePromptOpts) => {
      if (opts.agent === "researcher") return captureProducer(opts, journal)
      const child = "checker-child-reload"
      await opts.onSessionCreated?.(child)
      const { citation_id } = citationFromRead(retrieval, child)
      return { session_id: child, text: "", parsed: { passed: true, score: 10, failures: [], findings: [
        { criterion_id: "C1", outcome: "supported", evidence_ids: [citation_id], reason: "The stored page commitment supports the finding." },
      ] } }
    }
    const completed = await executeRun(run, { ...executeContext(root), sessionRunner,
      actionEvidence: { journal, retrieval } })
    const reloaded = hydrateRunFully(loadRun(root, completed.run_id)!)
    const producerAttempt = reloaded.nodes.producer!.attempts[0]!
    const checkerAttempt = reloaded.nodes.checker!.attempts[0]!
    const manifest = journal.readManifest(producerAttempt.action_evidence_ref!, {
      run_id: reloaded.run_id, node_id: "producer", attempt: 1,
    })
    expect(manifest.entries.length).toBeGreaterThan(0)
    expect(checkerAttempt.retrieved_evidence).toHaveLength(1)
    expect(checkerAttempt.retrieved_evidence![0]).not.toHaveProperty("content")
    const checkerOutput = checkerAttempt.output as CheckerOutput
    expect(checkerOutput.findings?.[0]?.evidence_ids).toEqual([checkerAttempt.retrieved_evidence![0]!.id])
    expect(reloaded.status).toBe("done")
  } finally { removeProject(root) }
})

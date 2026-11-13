import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { ActionEvidenceJournal } from "../src/action-evidence.ts"
import { evidencePage } from "../src/evidence-retrieval.ts"
import { executeRun } from "../src/executor.ts"
import { validateGraph } from "../src/graph.ts"
import { parsePersistedNodeAttempt } from "../src/schemas.ts"
import { buildVerificationBasis, retrievedVerificationEvidence } from "../src/verification.ts"
import { createRun, hydrateRunFully, loadRun } from "../src/store.ts"
import type { RunDataReference } from "../src/types.ts"
import type { NodePromptOpts } from "../src/sessions.ts"
import { executeContext, removeProject } from "./helpers.ts"

const tempProject = (label: string) => realpathSync.native(mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), `.${label}`)))

const workOutput = { summary: ["made observation"], files_touched: [], commands_run: [], risks: [], done: true }
const plain = (reference: RunDataReference): RunDataReference => ({ artifact_path: reference.artifact_path,
  sha256: reference.sha256, byte_size: reference.byte_size })

async function evidenceRun(project: string, checkerAttempts = 1, foreign?: { run_id: string; reference: RunDataReference }, forgePage = false) {
  const graph = validateGraph({ name: "action-integrity", max_global_attempts: checkerAttempts + 1, nodes: [
    { id: "work", agent: "implementer", depends_on: [], loop: { gate: "schema", max_attempts: 1 } },
    { id: "check", agent: "checker", depends_on: ["work"], inputs: { claimed: "work" },
      verification: { version: 1 }, isolated_check: true, loop: { gate: "schema", max_attempts: checkerAttempts } },
  ] })
  const run = createRun({ goal: "Review retained action evidence", criteria: ["Observed action is supported"],
    graph, projectDirectory: project, ownerSessionId: "session-owner" })
  const journal = new ActionEvidenceJournal(project)
  let manifest: RunDataReference | undefined
  let record: RunDataReference | undefined
  const sessionRunner = async (options: NodePromptOpts) => {
    const node = options.agent === "checker" ? "check" : "work"
    const attempt = run.nodes[node]!.current_attempt
    const child = `${node}-a${attempt}`
    if (node === "check") {
      run.nodes.check!.attempts.at(-1)!.action_evidence_sources = { version: 1, journals: [
        { run_id: foreign?.run_id ?? run.run_id, node_id: "work", attempt: 1,
          child_session_id: "work-a1", reference: foreign?.reference ?? manifest! },
      ], omitted: 0, unavailable: 0 }
    }
    await options.onSessionCreated?.(child)
    if (node === "work") {
      journal.bind(child, { run_id: run.run_id, node_id: node, attempt })
      record = plain(journal.before({ tool: "bash", sessionID: child, callID: "call-1" }, { command: "printf observed" }))
      journal.after({ tool: "bash", sessionID: child, callID: "call-1" }, {}, { output: "observed", metadata: { exit_code: 0 } })
      manifest = journal.finish(child)
      run.nodes.work!.attempts.at(-1)!.action_evidence_ref = manifest
      return { session_id: child, text: "", parsed: workOutput }
    }
    const page = evidencePage(project, run.run_id, record!, 0)
    const receipt = forgePage ? retrievedVerificationEvidence(record!, 0, "forged page") : page.receipt
    const current = run.nodes.check!.attempts.at(-1)!
    current.retrieved_evidence = [receipt]
    const passed = checkerAttempts === 1
    return { session_id: child, text: "", parsed: { passed, score: passed ? 9 : 2,
      failures: passed ? [] : ["Evidence remains inconclusive"],
      findings: [{ criterion_id: "C1", outcome: passed ? "supported" : "inconclusive",
        evidence_ids: [receipt.id], reason: passed ? "The retained command was observed" : "The observation is insufficient" }] } }
  }
  const result = await executeRun(run, { ...executeContext(project), sessionRunner })
  if (!manifest) throw new Error(`fixture worker did not launch: ${JSON.stringify(result.nodes.work?.last_failures)}`)
  return { run: result, manifest: manifest!, record: record! }
}

test("loads a checker citation only while its assigned journal and exact page survive", async () => {
  const project = tempProject("alg-action-integrity-")
  try {
    const { run, record } = await evidenceRun(project)
    expect(run.status).toBe("done")
    expect(loadRun(project, run.run_id)?.nodes.check?.attempts[0]?.retrieved_evidence).toHaveLength(1)
    const path = join(project, ...record.artifact_path.split("/"))
    const original = readFileSync(path, "utf8")
    writeFileSync(path, original.replace("printf observed", "printf tampered"))
    expect(() => loadRun(project, run.run_id)).toThrow(/action evidence|retrieved evidence|reference/i)
  } finally { removeProject(project) }
})

test("fails closed when an assigned source manifest disappears", async () => {
  const project = tempProject("alg-action-missing-")
  try {
    const { run, manifest } = await evidenceRun(project)
    unlinkSync(join(project, ...manifest.artifact_path.split("/")))
    expect(() => loadRun(project, run.run_id)).toThrow(/action evidence|reference/i)
  } finally { removeProject(project) }
})

test("rejects a checker source from another run before committing its verdict", async () => {
  const project = tempProject("alg-action-cross-run-")
  try {
    const first = await evidenceRun(project)
    await expect(evidenceRun(project, 1, { run_id: first.run.run_id, reference: first.manifest }))
      .rejects.toThrow(/persistence boundary|action evidence source/i)
  } finally { removeProject(project) }
})

test("rejects a self-consistent citation digest that does not match the assigned source bytes", async () => {
  const project = tempProject("alg-action-forged-page-")
  try {
    await expect(evidenceRun(project, 1, undefined, true)).rejects.toThrow(/persistence boundary|retrieved evidence page/i)
  } finally { removeProject(project) }
})

test("archived checker citations retain source and page validation", async () => {
  const project = tempProject("alg-action-archive-")
  try {
    const { run, record } = await evidenceRun(project, 5)
    const projected = loadRun(project, run.run_id)!
    expect(projected.nodes.check!.attempt_history_ref).toBeDefined()
    expect(hydrateRunFully(projected).nodes.check!.attempts[0]!.retrieved_evidence).toHaveLength(1)
    const path = join(project, ...record.artifact_path.split("/"))
    writeFileSync(path, readFileSync(path, "utf8").replace("printf observed", "printf altered"))
    expect(() => loadRun(project, run.run_id)).toThrow(/action evidence|retrieved evidence|reference/i)
  } finally { removeProject(project) }
}, 30_000)

test("legacy inconclusive checker feedback remains loadable without an action source set", () => {
  const output = { passed: false, score: 2, failures: ["Evidence is inconclusive"],
    findings: [{ criterion_id: "C1", outcome: "inconclusive", evidence_ids: [], reason: "Insufficient" }] }
  const attempt = { attempt: 1, status: "failed", session_id: "legacy-child", started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(), failures: output.failures, output, score: output.score, schema_ok: true,
    outcome: "substantive_rejection", verification_basis: buildVerificationBasis(["Required observation"]) }
  expect(parsePersistedNodeAttempt(attempt, { agent: "checker", run_id: "legacy-run", node_id: "check",
    expected_attempt: 1, verification_required: true, verification_criteria: ["Required observation"] }).outcome)
    .toBe("substantive_rejection")
})

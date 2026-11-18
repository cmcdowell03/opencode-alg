import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ActionEvidenceJournal, type ActionEvidenceRecordReference } from "../src/action-evidence.ts"
import { EvidenceRetrieval, type EvidenceSources } from "../src/evidence-retrieval.ts"
import { buildCheckerEvidence } from "../src/checker-evidence.ts"
import { buildVerificationBasis, pinClaimedSubmission, VerificationBasisSchema, validateVerification, type VerificationFinding } from "../src/verification.ts"
import { MECHANICAL_BINDING_FAILURE, MECHANICAL_CONSISTENCY_FAILURE } from "../src/checker-consistency.ts"
import { createRun, hydrateRunFully, loadRun, persistRun, validateCheckerActionConsistency } from "../src/store.ts"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { validateGraph } from "../src/graph.ts"
import { parseAndValidate } from "../src/schemas.ts"
import type { NodeAttempt, RunDataReference } from "../src/types.ts"
import { buildCheckerPrompt, type NodePromptOpts } from "../src/sessions.ts"
import { executeContext, removeProject } from "./helpers.ts"

const evidenceRoot = fileURLToPath(new URL("../../implementation-evidence/qualification-finish/checker-consistency/", import.meta.url))
function project() {
  mkdirSync(evidenceRoot, { recursive: true })
  return realpathSync.native(mkdtempSync(join(evidenceRoot, "synthetic-")))
}
const produced = { answer: "Captured the requested action", evidence: [], constraints: [], options: [], acceptance_criteria: ["Inspect the retained action"], risks: [] }
const plain = ({ artifact_path, sha256, byte_size }: RunDataReference) => ({ artifact_path, sha256, byte_size })
type Assessment = NonNullable<VerificationFinding["mechanical_assessment"]>
const predicates: Assessment["predicates"] = [{ kind: "complete_command" }, { kind: "linked_pair" }, { kind: "exit_equals", expected: 0 }]
function verdict(outcome: VerificationFinding["outcome"], intent?: string, terminal?: string, checks = predicates) {
  const assessment: Assessment = { version: 1, scope: "whole_criterion", predicates: checks,
    ...(intent ? { intent_id: intent } : {}), ...(terminal ? { terminal_id: terminal } : {}) }
  return { passed: outcome === "supported", score: outcome === "supported" ? 9 : 2,
    failures: outcome === "supported" ? [] : ["The criterion is not established"],
    findings: [{ criterion_id: "C1", outcome, reason: "Assessment of retained observations",
      evidence_ids: [intent, terminal].filter((id): id is string => !!id), mechanical_assessment: assessment }] }
}
function graph(checks = 1, feedback = false) {
  return validateGraph({ name: "mechanical-checker", max_global_attempts: checks + 2, max_concurrency: 1, nodes: [
    { id: "work", agent: "researcher", depends_on: [], loop: { gate: "schema", max_attempts: 2 } },
    { id: "check", agent: "checker", depends_on: ["work"], inputs: { claimed: "work", evidence: "work" },
      verification: { version: 1 }, ...(feedback ? { feedback_to: "work" } : {}), loop: { gate: "schema", max_attempts: checks } },
  ] })
}
function fixture(options: { exit?: number; command?: string; missingTerminal?: boolean; nonbash?: boolean; historical?: boolean; twoCalls?: boolean } = {}) {
  const root = project()
  const run = createRun({ projectDirectory: root, ownerSessionId: "session-owner", goal: "Check recorded action",
    criteria: ["The recorded action meets the stated requirements"], graph: graph() })
  const journal = new ActionEvidenceJournal(root)
  const sources: EvidenceSources = { version: 1, journals: [], omitted: 0, unavailable: 0 }
  const pairs: Array<{ intent: ActionEvidenceRecordReference; terminal?: ActionEvidenceRecordReference }> = []
  const records: Parameters<EvidenceRetrieval["grant"]>[3] = []
  for (let attempt = 1; attempt <= (options.historical ? 2 : 1); attempt++) {
    const session = `work-a${attempt}`, identity = { run_id: run.run_id, node_id: "work", attempt }
    journal.bind(session, identity)
    if (options.nonbash) journal.before({ tool: "read", sessionID: session, callID: "read-first" }, {})
    for (let c = 0; c < (options.twoCalls ? 2 : 1); c++) {
      const call = { tool: "bash", sessionID: session, callID: `call-${c}` }
      const intent = journal.before(call, { command: options.command ?? "echo observed" })!
      const terminal = options.missingTerminal ? undefined : journal.after(call, { output: "finished",
        metadata: options.exit === undefined ? {} : { exit_code: options.exit } })
      pairs.push({ intent, terminal })
    }
    const reference = journal.finish(session)
    const manifest = journal.readManifest(reference, identity)
    sources.journals.push({ ...identity, child_session_id: session, reference })
    records.push(...manifest.entries.map(entry => ({ reference: plain(entry), node_id: "work", attempt, kind: entry.kind, ordinal: entry.ordinal })))
    run.nodes.work!.attempts.push({ attempt, status: "done", session_id: session, started_at: new Date().toISOString(),
      failures: [], action_evidence_ref: reference, output: produced })
    run.nodes.work!.current_attempt = attempt
  }
  run.nodes.work!.output = produced
  run.nodes.work!.status = "done"
  const attempt: NodeAttempt = { attempt: 1, status: "running", session_id: "checker-a1", started_at: new Date().toISOString(), failures: [],
    action_evidence_sources: sources, verification_basis: buildVerificationBasis(run.criteria, buildCheckerEvidence(run.graph.nodes[1]!, run)) }
  const retrieval = new EvidenceRetrieval(root)
  retrieval.grant(attempt.session_id!, run.run_id, sources, records)
  const read = (reference: RunDataReference, offset = 0) => {
    const page = retrieval.execute(attempt.session_id!, { evidence: "read", record_id: reference.sha256, offset })
    if (!("citation_id" in page)) throw new Error("expected evidence page")
    return page
  }
  const readAll = (reference: RunDataReference) => {
    let page = read(reference), first = page.citation_id
    while (page.next_offset !== null) page = read(reference, page.next_offset)
    return first
  }
  const sealReads = () => { attempt.retrieved_evidence = retrieval.take(attempt.session_id!) }
  const check = (output: unknown) => {
    const errors = validateVerification(output, attempt.verification_basis!, attempt.retrieved_evidence)
    return errors.length ? errors : validateCheckerActionConsistency(run, "check", attempt, output)
  }
  return { root, run, attempt, pairs, read, readAll, sealReads, check }
}

test.each([0, 7, undefined])("whole-criterion assessment preserves reported exit %s and rejects both contradictory verdict directions", exit => {
  const f = fixture({ exit })
  try {
    const i = f.readAll(f.pairs[0]!.intent), t = f.readAll(f.pairs[0]!.terminal!)
    f.sealReads()
    const actual = exit === undefined ? "inconclusive" : exit === 0 ? "supported" : "disconfirmed"
    expect(f.check(verdict(actual, i, t))).toEqual([])
    for (const wrong of ["supported", "disconfirmed", "inconclusive"] as const) {
      if (wrong !== actual) expect(f.check(verdict(wrong, i, t))).toEqual([MECHANICAL_CONSISTENCY_FAILURE])
    }
  } finally { removeProject(f.root) }
})

test.each(["missing-terminal", "unread-terminal", "redacted", "truncated", "missing-pin"])("%s remains unknown", kind => {
  const f = fixture({ exit: 0, missingTerminal: kind === "missing-terminal",
    command: kind === "redacted" ? "echo --password private" : kind === "truncated" ? "x".repeat(70_000) : undefined })
  try {
    const i = f.readAll(f.pairs[0]!.intent)
    const t = kind === "unread-terminal" || !f.pairs[0]!.terminal ? undefined : f.readAll(f.pairs[0]!.terminal!)
    if (kind === "missing-pin") f.attempt.verification_basis!.evidence = []
    f.sealReads()
    expect(f.check(verdict("inconclusive", i, t))).toEqual([])
    expect(f.check(verdict("supported", i, t))).toEqual([MECHANICAL_CONSISTENCY_FAILURE])
    expect(f.check(verdict("disconfirmed", i, t))).toEqual([MECHANICAL_CONSISTENCY_FAILURE])
  } finally { removeProject(f.root) }
})

test.each([false, true])("all registered pages establish coverage with overlaps, but not an interior gap (gap=%s)", gap => {
  const f = fixture({ command: "x".repeat(25_000) })
  try {
    const ref = f.pairs[0]!.intent, i = f.read(ref).citation_id
    for (const offset of gap ? [16_384, 24_576] : [4_096, 12_288, 20_480]) f.read(ref, offset)
    f.sealReads()
    expect(f.check(verdict(gap ? "inconclusive" : "supported", i, undefined, [{ kind: "complete_command" }]))).toEqual([])
    if (gap) expect(f.check(verdict("supported", i, undefined, [{ kind: "complete_command" }]))).toEqual([MECHANICAL_CONSISTENCY_FAILURE])
    expect(f.attempt.retrieved_evidence!.length).toBeGreaterThan(1)
  } finally { removeProject(f.root) }
})

test("first recorded bash is distinct from ordinal one after a non-bash hook", () => {
  const f = fixture({ nonbash: true })
  try {
    const i = f.readAll(f.pairs[0]!.intent)
    f.sealReads()
    expect(f.check(verdict("supported", i, undefined, [{ kind: "first_recorded_bash" }]))).toEqual([])
    expect(f.check(verdict("disconfirmed", i, undefined, [{ kind: "ordinal_equals", expected: 1 }]))).toEqual([])
    expect(f.check(verdict("supported", i, undefined, [{ kind: "ordinal_equals", expected: 2 }]))).toEqual([])
  } finally { removeProject(f.root) }
})

test("a reported negative conjunct still disconfirms when another fact is unread", () => {
  const f = fixture({ exit: 7, command: "x".repeat(25_000) })
  try {
    const i = f.read(f.pairs[0]!.intent).citation_id, t = f.readAll(f.pairs[0]!.terminal!)
    f.sealReads()
    expect(f.check(verdict("disconfirmed", i, t))).toEqual([])
    expect(f.check(verdict("inconclusive", i, t))).toEqual([MECHANICAL_CONSISTENCY_FAILURE])
  } finally { removeProject(f.root) }
})

test.each(["historical", "wrong-pair", "partial-wrong-pair"])("rejects %s binding even though the cited records are assigned and intact", kind => {
  const f = fixture({ exit: 0, historical: kind === "historical", twoCalls: kind !== "historical",
    command: kind === "partial-wrong-pair" ? "x".repeat(25_000) : undefined })
  try {
    const i = kind === "partial-wrong-pair" ? f.read(f.pairs[0]!.intent).citation_id : f.readAll(f.pairs[0]!.intent)
    const t = f.readAll(f.pairs[kind === "historical" ? 0 : 1]!.terminal!)
    const current = kind === "historical" ? [f.readAll(f.pairs[1]!.intent), f.readAll(f.pairs[1]!.terminal!)] : undefined
    f.sealReads()
    expect(f.check(verdict("supported", i, t))).toEqual([MECHANICAL_BINDING_FAILURE])
    expect(f.check(verdict("disconfirmed", i, t))).toEqual([MECHANICAL_BINDING_FAILURE])
    if (current) expect(f.check(verdict("supported", current[0], current[1]))).toEqual([])
  } finally { removeProject(f.root) }
})

test.each(["tampered", "missing", "cross-run", "cross-attempt", "forged-page"])("%s evidence remains a storage integrity error", kind => {
  const f = fixture({ exit: 0 })
  try {
    const ref = f.pairs[0]!.intent, i = f.readAll(ref), t = f.readAll(f.pairs[0]!.terminal!)
    f.sealReads()
    const path = join(f.root, ref.artifact_path)
    if (kind === "tampered") writeFileSync(path, readFileSync(path, "utf8").replace("echo observed", "echo tampered"))
    if (kind === "missing") unlinkSync(path)
    if (kind === "cross-run") f.attempt.action_evidence_sources!.journals[0]!.run_id = "other-run"
    if (kind === "cross-attempt") f.attempt.action_evidence_sources!.journals[0]!.attempt = 2
    if (kind === "forged-page") f.attempt.retrieved_evidence![0]!.length--
    expect(() => f.check(verdict("supported", i, t))).toThrow(/integrity|binding|unrelated/)
  } finally { removeProject(f.root) }
})

test("unregistered or previous-checker citations have no authority; legacy semantic findings remain accepted", () => {
  const f = fixture({ exit: 0 })
  try {
    const i = f.readAll(f.pairs[0]!.intent), t = f.readAll(f.pairs[0]!.terminal!)
    f.sealReads()
    const ordinary = verdict("disconfirmed", i, t)
    delete (ordinary.findings[0] as { mechanical_assessment?: Assessment }).mechanical_assessment
    expect(f.check(ordinary)).toEqual([])
    f.attempt.retrieved_evidence = []
    expect(f.check(verdict("supported", i, t)).join(" ")).toContain("code=evidence_binding")
  } finally { removeProject(f.root) }
})

test("typed assessment bounds and diagnostics do not echo submitted keys or values", () => {
  const output = verdict("inconclusive")
  Object.assign(output.findings[0]!.mechanical_assessment, { "INJECTED_CHILD_KEY": "INJECTED_CHILD_VALUE" })
  const parsed = parseAndValidate("checker", output)
  expect(parsed.ok).toBe(false)
  if (!parsed.ok) expect(parsed.failures.join(" ")).not.toMatch(/INJECTED_CHILD/)
  for (const checks of [[{ kind: "exit_equals", expected: 0.5 }], [{ kind: "ordinal_equals", expected: 0 }],
    [{ kind: "complete_command" }, { kind: "complete_command" }], [{ kind: "expression", expression: "true" }]]) {
    expect(parseAndValidate("checker", { ...output, findings: [{ ...output.findings[0], mechanical_assessment:
      { version: 1, scope: "whole_criterion", predicates: checks } }] }).ok).toBe(false)
  }
})

async function runtimeCase(options: { exhaust?: boolean; archive?: boolean; restart?: boolean; negative?: boolean; wrongAccept?: boolean;
  noFeedback?: boolean; feedbackRepair?: boolean; semanticOnly?: boolean; unverified?: boolean; inconclusiveFirst?: boolean; mixedRepair?: boolean;
  claimedOnly?: boolean; claimedExpression?: string } = {}) {
  const root = project(), checks = options.archive ? 5 : 2
  const definition = graph(checks, !options.noFeedback && (!!options.feedbackRepair || !options.negative))
  if (options.unverified) delete definition.nodes[1]!.verification
  if (options.claimedOnly) definition.nodes[1]!.inputs = { claimed: "work" }
  if (options.claimedExpression) definition.nodes[1]!.inputs = { claimed: options.claimedExpression }
  const run = createRun({ projectDirectory: root, ownerSessionId: "session-owner", goal: "Check retained action",
    criteria: ["The retained command and its linked terminal report zero exit"],
    graph: definition })
  const journal = new ActionEvidenceJournal(root), retrieval = new EvidenceRetrieval(root), calls: string[] = [], prompts: string[] = []
  const runner = async (opts: NodePromptOpts) => {
    calls.push(opts.agent)
    const a = opts.agent === "checker" ? run.nodes.check!.current_attempt : run.nodes.work!.current_attempt
    const child = `${opts.agent}-${calls.length}`
    await opts.onSessionCreated?.(child)
    if (opts.agent !== "checker") {
      const call = { tool: "bash", sessionID: child, callID: "runtime-call" }
      journal.before(call, { command: "echo retained" })
      journal.after(call, { output: "finished", metadata: { exit_code: options.wrongAccept ||
        (options.negative && (!options.feedbackRepair || a === 1)) ? 7 : 0 } })
      return { session_id: child, text: "", parsed: options.feedbackRepair ? { ...produced, answer: `Submission from producer attempt ${a}` } : produced }
    }
    prompts.push(opts.userPrompt)
    const index = retrieval.execute(child, { evidence: "index" })
    if (!("records" in index) || !Array.isArray(index.records)) throw new Error("expected index")
    const records = index.records
    const anchors = ["intent", "terminal"].map(kind => {
      const ref = records.find(row => row.kind === kind && row.attempt === run.nodes.work!.current_attempt)!
      const page = retrieval.execute(child, { evidence: "read", record_id: ref.record_id })
      if (!("citation_id" in page)) throw new Error("expected page")
      return page.citation_id
    })
    if (a > 1 && !options.archive && !options.negative && !options.inconclusiveFirst) {
      const retry = opts.userPrompt.slice(opts.userPrompt.lastIndexOf("PRIOR OUTPUT CONTRACT FAILURES:"))
      expect(retry).toContain("code=mechanical_consistency")
      expect(retry).not.toContain("The retained command and its linked terminal report zero exit")
      expect(retry).not.toContain("desired verdict")
    }
    const gap = options.archive || (options.inconclusiveFirst && a === 1) || (options.mixedRepair && a === 2)
    const output = verdict(gap ? "inconclusive" : options.wrongAccept ? "supported" : options.negative ?
      (options.feedbackRepair && run.nodes.work!.current_attempt > 1 ? "supported" : "disconfirmed") :
      options.exhaust || a === 1 ? "disconfirmed" : "supported",
      anchors[0], anchors[1], options.archive ? [{ kind: "exit_equals", expected: 0 }, { kind: "linked_pair" }] : predicates)
    // For archive coverage, a real missing fact keeps every attempt schema-valid.
    if (gap) delete output.findings[0]!.mechanical_assessment.terminal_id
    if (options.semanticOnly) delete (output.findings[0] as { mechanical_assessment?: Assessment }).mechanical_assessment
    return { session_id: child, text: "", parsed: output }
  }
  const context = { ...executeContext(root), sessionRunner: runner, actionEvidence: { journal, retrieval } }
  let completed = await executeRun(run, { ...context, ...(options.restart ? { maxWaves: 2 } : {}) })
  if (options.restart) {
    const restored = prepareRunForResume(hydrateRunFully(loadRun(root, run.run_id)!))
    // The resumed runner reads the restored attempt count, not the old object.
    Object.assign(run, restored)
    completed = await executeRun(run, { ...context, operation: "resume" })
  }
  return { root, run: completed, calls, prompts, context }
}

test("standard claimed-only graph pins the actual submitted dependency before launch, without creating E citations", async () => {
  const f = await runtimeCase({ noFeedback: true, claimedOnly: true })
  try {
    expect(f.run.graph.nodes[1]!.inputs).toEqual({ claimed: "work" })
    expect(f.calls).toEqual(["researcher", "checker", "checker"])
    expect(f.run.status).toBe("done")
    const loaded = hydrateRunFully(loadRun(f.root, f.run.run_id)!)
    const attempts = loaded.nodes.check!.attempts
    const json = JSON.stringify(loaded.nodes.work!.attempts[0]!.output)
    expect(attempts[0]!.verification_basis!.claimed_submission).toEqual({ run_id: f.run.run_id, node_id: "work", reference: "work", attempt: 1,
      json_bytes: Buffer.byteLength(json), json_sha256: createHash("sha256").update(json).digest("hex") })
    expect(attempts[1]!.verification_basis).toEqual(attempts[0]!.verification_basis)
    expect(attempts[0]!.verification_basis!.evidence).toEqual([])
    expect(f.prompts[0]).toContain("HOST CLAIMED SUBMISSION PIN")
    expect(f.prompts[0]).toContain(JSON.stringify(attempts[0]!.verification_basis!.claimed_submission))
    const source = attempts[0]!.action_evidence_sources!.journals[0]!
    expect(f.prompts[0]).toContain("HOST ASSIGNED ACTION ORIGIN")
    expect(f.prompts[0]).toContain(JSON.stringify({ run_id: f.run.run_id, node_id: "work", attempt: 1,
      child_session_id: source.child_session_id, manifest_sha256: source.reference.sha256 }))
    expect(f.prompts[0]!.split(produced.answer)).toHaveLength(2)
    attempts[1]!.verification_basis!.claimed_submission!.json_sha256 = "f".repeat(64)
    expect(() => validateCheckerActionConsistency(loaded, "check", attempts[1]!)).toThrow(/claimed submission/)
  } finally { removeProject(f.root) }
}, 30_000)

test("metadata-only submission pin preserves all eight evidence IDs and host-task coverage with a large claim", () => {
  const claim = { answer: `UNIQUE_CLAIM_${"x".repeat(20_000)}` }
  const evidence = { entries: Array.from({ length: 8 }, (_, index) => ({ port: index === 0 ? "host_task" : `evidence_${index}`,
    source: { run_id: "pin-run", kind: index === 0 ? "host_task" as const : "graph_literal" as const },
    status: "included" as const, value: { observation: index }, json_bytes: 17, json_sha256: "a".repeat(64) })), omitted_entries: 0 }
  const old = buildVerificationBasis(["Review observations"], evidence)
  const pin = pinClaimedSubmission({ run_id: "pin-run", node_id: "work", reference: "work", attempt: 2 }, claim)
  const next = buildVerificationBasis(["Review observations"], evidence, pin)
  expect(next.evidence).toEqual(old.evidence)
  expect(next.evidence).toHaveLength(8)
  expect(next.evidence[0]!.source.kind).toBe("host_task")
  expect(VerificationBasisSchema.parse(old)).not.toHaveProperty("claimed_submission")
  const prompt = buildCheckerPrompt({ criteria: ["Review observations"], claimed: claim, evidence, claimedSubmission: pin,
    claimedActionSource: { run_id: "pin-run", node_id: "work", attempt: 1, child_session_id: "original-child",
      reference: { artifact_path: ".opencode/runs/pin-run/artifacts/manifest.json", sha256: "b".repeat(64), byte_size: 100 } }, verification: { version: 1 } })
  expect(prompt.split(claim.answer)).toHaveLength(2)
  expect(prompt).toContain('"manifest_sha256":"' + "b".repeat(64) + '"')
  expect(prompt).toContain("E1, E2, E3, E4, E5, E6, E7, E8")
  const onlyPin = buildVerificationBasis(["Review observations"], undefined, pin)
  expect(validateVerification({ passed: true, findings: [{ criterion_id: "C1", outcome: "supported", evidence_ids: ["E1"], reason: "claim only" }] }, onlyPin)).not.toEqual([])
})

test("missing and non-dependency claims do not invent a submitted dependency pin", async () => {
  for (const claimedExpression of ['"literal claim"', "$goal", "work.absent"]) {
    const f = await runtimeCase({ claimedExpression, semanticOnly: true, noFeedback: true })
    try {
      const loaded = loadRun(f.root, f.run.run_id)!
      expect(loaded.nodes.check!.attempts[0]!.verification_basis).not.toHaveProperty("claimed_submission")
      expect(f.prompts[0]).not.toContain("HOST CLAIMED SUBMISSION PIN (identity only")
      expect(f.prompts[0]).not.toContain("HOST ASSIGNED ACTION ORIGIN")
    } finally { removeProject(f.root) }
  }
}, 30_000)

test.each([false, true])("contradictory rejection retries only the checker, including restart=%s", async restart => {
  const f = await runtimeCase({ restart })
  try {
    expect(f.calls).toEqual(["researcher", "checker", "checker"])
    expect(f.run.status).toBe("done")
    const loaded = hydrateRunFully(loadRun(f.root, f.run.run_id)!)
    expect(loaded.nodes.check!.attempts.map(a => a.outcome)).toEqual(["schema_invalid", "passed"])
    expect(loaded.nodes.check!.attempts[0]!.output).toBeUndefined()
    expect(loaded.nodes.check!.attempts[1]!.retrieved_evidence).toHaveLength(2)
    const changed = structuredClone(loaded)
    const output = changed.nodes.check!.attempts[1]!.output as ReturnType<typeof verdict>
    output.findings[0]!.mechanical_assessment.predicates = [{ kind: "exit_equals", expected: 7 }]
    changed.nodes.check!.output = output
    expect(() => persistRun(changed, f.root)).toThrow(/mechanical/)
  } finally { removeProject(f.root) }
}, 30_000)

test("retry exhaustion cannot pass or replay the producer; a genuine negative keeps substantive rejection", async () => {
  for (const scenario of ["wrong-reject", "wrong-accept", "negative"]) {
    const negative = scenario === "negative"
    const f = await runtimeCase({ exhaust: !negative, negative, wrongAccept: scenario === "wrong-accept" })
    try {
      expect(f.run.status).toBe("failed")
      expect(f.calls.filter(role => role === "researcher")).toHaveLength(1)
      expect(f.calls.filter(role => role === "checker")).toHaveLength(negative ? 1 : 2)
      expect(f.run.nodes.check!.attempts.every(a => a.outcome === (negative ? "substantive_rejection" : "schema_invalid"))).toBe(true)
    } finally { removeProject(f.root) }
  }
}, 30_000)

test("a valid mechanical negative without feedback is terminal after one checker attempt", async () => {
  const f = await runtimeCase({ negative: true, noFeedback: true })
  try {
    expect(f.calls).toEqual(["researcher", "checker"])
    expect(f.run.status).toBe("failed")
    const loaded = hydrateRunFully(loadRun(f.root, f.run.run_id)!)
    expect(loaded.nodes.check!.status).toBe("failed")
    expect(loaded.nodes.check!.attempts.map(a => a.outcome)).toEqual(["substantive_rejection"])
    expect(loaded.nodes.check!.current_attempt).toBeLessThan(loaded.graph.nodes[1]!.loop!.max_attempts)
    const resumed = prepareRunForResume(loaded)
    expect(resumed.nodes.check!.status).toBe("failed")
    await executeRun(resumed, { ...f.context, operation: "resume" })
    expect(f.calls).toEqual(["researcher", "checker"])
    expect(resumed.nodes.check!.current_attempt).toBe(1)
  } finally { removeProject(f.root) }
}, 30_000)

test("schema-invalid findings still use a second checker attempt without feedback routing", async () => {
  const f = await runtimeCase({ noFeedback: true })
  try {
    expect(f.calls).toEqual(["researcher", "checker", "checker"])
    expect(f.run.status).toBe("done")
    expect(f.run.nodes.check!.attempts.map(a => a.outcome)).toEqual(["schema_invalid", "passed"])
  } finally { removeProject(f.root) }
}, 30_000)

test.each([false, true])("a genuine mechanical defect with explicit feedback routes producer repair before review, resume=%s", async restart => {
  const f = await runtimeCase({ negative: true, feedbackRepair: true, restart, claimedOnly: true })
  try {
    expect(f.calls).toEqual(["researcher", "checker", "researcher", "checker"])
    expect(f.run.status).toBe("done")
    expect(f.run.nodes.check!.attempts.map(a => a.outcome)).toEqual(["substantive_rejection", "passed"])
    expect(f.run.nodes.check!.attempts[0]!.feedback_applied).toBe(true)
    const pins = f.run.nodes.check!.attempts.map(a => a.verification_basis!.claimed_submission!)
    expect(pins.map(pin => pin.attempt)).toEqual([1, 2])
    expect(pins[0]!.json_sha256).not.toBe(pins[1]!.json_sha256)
  } finally { removeProject(f.root) }
}, 30_000)

test("a verified semantic rejection also ends review after one attempt", async () => {
  const f = await runtimeCase({ negative: true, noFeedback: true, semanticOnly: true })
  try {
    expect(f.calls).toEqual(["researcher", "checker"])
    expect(f.run.status).toBe("failed")
    expect(f.run.nodes.check!.attempts.map(a => a.outcome)).toEqual(["substantive_rejection"])
    const resumed = prepareRunForResume(loadRun(f.root, f.run.run_id)!)
    await executeRun(resumed, { ...f.context, operation: "resume" })
    expect(f.calls).toEqual(["researcher", "checker"])
  } finally { removeProject(f.root) }
}, 30_000)

test("unverified semantic rejection retains its existing retry behavior", async () => {
  const f = await runtimeCase({ negative: true, noFeedback: true, semanticOnly: true, unverified: true })
  try {
    expect(f.calls).toEqual(["researcher", "checker", "checker"])
    expect(f.run.status).toBe("failed")
    expect(f.run.nodes.check!.attempts.map(a => a.outcome)).toEqual(["substantive_rejection", "substantive_rejection"])
  } finally { removeProject(f.root) }
}, 30_000)

test.each([false, true])("schema and evidence repairs share one total attempt bound (mixed=%s)", async mixed => {
  const f = await runtimeCase({ noFeedback: true, inconclusiveFirst: !mixed, mixedRepair: mixed })
  try {
    expect(f.calls).toEqual(["researcher", "checker", "checker"])
    expect(f.run.nodes.check!.attempts.map(a => a.outcome)).toEqual(mixed ?
      ["schema_invalid", "evidence_unavailable"] : ["evidence_unavailable", "passed"])
    expect(f.run.status).toBe(mixed ? "failed" : "done")
    expect(f.run.nodes.check!.attempts[0]!.schema_ok).toBe(!mixed)
    expect(f.run.nodes.check!.attempts[0]!.output === undefined).toBe(mixed)
  } finally { removeProject(f.root) }
}, 30_000)

test.each([[2, false], [6, false], [3, true]] as const)("gate-only submission %i retains its validated action origin (unrelated=%s)", async (successAttempt, unrelated) => {
  const root = project(), originAttempt = unrelated ? 2 : 1
  try {
    let run = createRun({ projectDirectory: root, ownerSessionId: "session-owner", goal: "Review recovered submission", criteria: ["Recorded action completed with zero exit"],
      graph: { name: "recovered-checker", max_global_attempts: successAttempt + 2, max_concurrency: 1, nodes: [
        { id: "work", agent: "implementer", depends_on: [], shell_gate: { cmd: "echo gate" }, loop: { gate: "all", max_attempts: successAttempt } },
        { id: "check", agent: "checker", depends_on: ["work"], inputs: { claimed: "work" }, verification: { version: 1 }, loop: { gate: "schema", max_attempts: 2 } },
      ] } })
    const journal = new ActionEvidenceJournal(root), retrieval = new EvidenceRetrieval(root), calls: string[] = []
    const output = { summary: ["retained implementation"], files_touched: [], commands_run: [], risks: [], done: true }
    let gates = 0, oldAnchors: string[] = []
    const runner = async (opts: NodePromptOpts) => {
      calls.push(opts.agent)
      const child = opts.agent === "implementer" ? `work-a${run.nodes.work!.current_attempt}` : "recovery-checker"
      await opts.onSessionCreated?.(child)
      if (opts.agent === "implementer") {
        const call = { tool: "bash", sessionID: child, callID: "retained-call" }
        journal.before(call, { command: "echo retained" })
        journal.after(call, { output: "retained", metadata: { exit_code: 0 } })
        return { session_id: child, text: "", parsed: output, execution_evidence: {
          version: 1 as const, run_id: run.run_id, node_id: "work", attempt: run.nodes.work!.current_attempt, child_session_id: child,
          retrieval_status: "available" as const, commands: [{ tool: "bash" as const, command: "echo retained", tool_status: "completed" as const,
            exit_code_status: "reported" as const, exit_code: 0, output_truncated: false, command_truncated: false, cwd_truncated: false }],
          omitted_commands: 0, window_may_be_incomplete: false, foreign_messages_omitted: 0 } }
      }
      const index = retrieval.execute(child, { evidence: "index" })
      if (!("records" in index) || !Array.isArray(index.records)) throw new Error("expected source index")
      const records = index.records
      const lines = opts.userPrompt.split("\n")
      const pin = JSON.parse(lines[lines.findIndex(line => line.startsWith("HOST CLAIMED SUBMISSION PIN (")) + 1]!)
      const hint = JSON.parse(lines[lines.findIndex(line => line.startsWith("HOST ASSIGNED ACTION ORIGIN (")) + 1]!)
      expect(pin.attempt).toBe(successAttempt)
      expect(hint).toMatchObject({ run_id: run.run_id, node_id: "work", attempt: originAttempt, child_session_id: `work-a${originAttempt}` })
      expect(records.find(record => record.record_id === hint.manifest_sha256)).toMatchObject({ kind: "manifest", node_id: "work", attempt: originAttempt })
      expect(opts.userPrompt.split(output.summary[0]!)).toHaveLength(2)
      const anchors = (attempt: number) => ["intent", "terminal"].map(kind => {
        const record = records.find(r => r.kind === kind && r.attempt === attempt)!
        expect(record).toBeDefined()
        const page = retrieval.execute(child, { evidence: "read", record_id: record.record_id })
        if (!("citation_id" in page)) throw new Error("expected page")
        expect(JSON.parse(page.content).identity.attempt).toBe(attempt)
        return page.citation_id
      })
      if (unrelated) oldAnchors = anchors(1)
      const chosen = anchors(hint.attempt)
      return { session_id: child, text: "", parsed: verdict("supported", chosen[0], chosen[1]) }
    }
    const options = { ...executeContext(root), sessionRunner: runner, actionEvidence: { journal, retrieval },
      shellRunner: async () => {
        gates++
        return { cwd: root, ok: gates >= successAttempt, exit_code: gates >= successAttempt ? 0 : 125,
          stdout_tail: "", stderr_tail: "", ...(gates < successAttempt && !(unrelated && gates === 1) ? { setup_failed: true } : {}) }
      } }
    await executeRun(run, options)
    while (run.status === "blocked" && gates < successAttempt) {
      run = prepareRunForResume(loadRun(root, run.run_id)!)
      await executeRun(run, { ...options, operation: "resume" })
    }
    expect(run.status).toBe("done")
    expect(calls).toEqual(unrelated ? ["implementer", "implementer", "checker"] : ["implementer", "checker"])
    const loaded = loadRun(root, run.run_id)!, check = loaded.nodes.check!.attempts[0]!
    if (successAttempt === 6) {
      expect(loaded.nodes.work!.attempt_history_ref).toBeDefined()
      expect(loaded.nodes.work!.attempts.some(a => a.attempt === originAttempt)).toBe(false)
    }
    expect(loaded.nodes.work!.attempts.at(-1)!.reused_output_from).toBe(originAttempt)
    expect(check.verification_basis!.claimed_submission).toMatchObject({ run_id: run.run_id, node_id: "work", reference: "work", attempt: successAttempt })
    expect(check.verification_basis!.evidence.some(e => e.source.kind === "node_output")).toBe(false)
    expect(check.action_evidence_sources!.journals.some(s => s.attempt === originAttempt && s.child_session_id === `work-a${originAttempt}`)).toBe(true)
    expect(validateCheckerActionConsistency(loaded, "check", check)).toEqual([])
    if (unrelated) expect(validateCheckerActionConsistency(loaded, "check", check, verdict("supported", oldAnchors[0], oldAnchors[1]))).toEqual([MECHANICAL_BINDING_FAILURE])
    const full = hydrateRunFully(loaded)
    expect(validateCheckerActionConsistency(full, "check", full.nodes.check!.attempts[0]!)).toEqual([])
    full.nodes.work!.attempts.at(-1)!.gate_recovery!.output_sha256 = "f".repeat(64)
    expect(() => validateCheckerActionConsistency(full, "check", full.nodes.check!.attempts[0]!)).toThrow(/integrity|origin binding/)
  } finally { removeProject(root) }
}, 60_000)

test("archived mechanical findings revalidate after output hydration and retain their own receipts", async () => {
  const f = await runtimeCase({ archive: true })
  try {
    const loaded = loadRun(f.root, f.run.run_id)!
    expect(loaded.nodes.check!.attempt_history_ref).toBeDefined()
    const full = hydrateRunFully(loaded)
    expect(full.nodes.check!.attempts).toHaveLength(5)
    expect(full.nodes.check!.attempts.every(a => a.outcome === "evidence_unavailable" && a.retrieved_evidence?.length === 2)).toBe(true)
    const archived = full.nodes.check!.attempts[0]!
    expect(validateCheckerActionConsistency(full, "check", archived)).toEqual([])
    const output = structuredClone(archived.output) as ReturnType<typeof verdict>
    output.findings[0]!.outcome = "supported"
    expect(validateCheckerActionConsistency(full, "check", archived, output)).toEqual([MECHANICAL_CONSISTENCY_FAILURE])
  } finally { removeProject(f.root) }
}, 30_000)

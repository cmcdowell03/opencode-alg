import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { comparativeIdentity, createComparativeCases, expectedParticleAnswer, scoreParticleAnswer, type JobReceipts } from "./comparative-benchmark-fixtures.ts"

const controls = ["positive", "wrong-crude", "wrong-inspection-match", "wrong-conclusion", "wrong-next-measurement", "missing-query-read", "wrong-revision", "wrong-job-order", "duplicate-submit", "missing-data-tool-read"] as const
export function qualifyComparative(repo = resolve(import.meta.dir, "..")) {
  const identity = comparativeIdentity(), sources = ["comparative-benchmark-fixtures.ts", "comparative-benchmark-service.ts", "comparative-benchmark-memory.ts", "comparative-benchmark-opencode.ts", "comparative-benchmark-qualification.ts"]
  const sourceHashes = Object.fromEntries(sources.map(file => [file, createHash("sha256").update(readFileSync(resolve(repo, "scripts", file))).digest("hex")]))
  const rows = createComparativeCases().flatMap(c => controls.map(control => {
    const answer = expectedParticleAnswer(c), access = [{ tool: "read", path: c.dataPath, sessionId: "post-handoff", afterHandoff: true, callId: "host-control", resultObserved: true }]
    const jobs: JobReceipts = { handoffSequence: 10, operations: [
      { sequence: 11, atMs: 100, action: "pending", key: c.acceptedJob.key, jobId: c.acceptedJob.id, revision: "particle-v3", status: 200 },
      { sequence: 12, atMs: 101, action: "lookup", key: c.acceptedJob.key, jobId: c.acceptedJob.id, revision: "particle-v3", status: 200 },
      { sequence: 13, atMs: 102, action: "read", jobId: c.acceptedJob.id, revision: "particle-v3", status: 200 },
    ] }
    if (control === "wrong-crude") answer.raw.chamberA += 0.1
    if (control === "wrong-inspection-match") answer.matchedStrata.p1r1 += 0.1
    if (control === "wrong-conclusion") answer.conclusion = "inconclusive"
    if (control === "wrong-next-measurement") answer.nextMeasurement = "repeat_crude_counts"
    if (control === "missing-query-read") jobs.operations = jobs.operations.filter(operation => operation.action !== "read")
    if (control === "wrong-revision") jobs.operations.find(operation => operation.action === "read")!.revision = "particle-v2"
    if (control === "wrong-job-order") jobs.operations.find(operation => operation.action === "read")!.sequence = 11
    if (control === "duplicate-submit") jobs.operations.push({ sequence: 1, atMs: 1, action: "submit", key: "different-key", status: 409 })
    if (control === "missing-data-tool-read") access.length = 0
    const grade = scoreParticleAnswer(c, answer, access, jobs), expected = control === "positive"
    return { blind_case_id: c.blindId, control, expected, passed: grade.passed === expected, score: grade.score,
      numeric_checks: grade.checks.map(check => ({ id: check.id, passed: check.passed })), access: grade.access.data_read_after_handoff_observed,
      job: grade.job }
  }))
  return { schema: "alg-comparative-qualification-v2", generated_at: new Date().toISOString(), identity, source_hashes: sourceHashes,
    rows, passed: rows.every(row => row.passed), interpretation: "Local independent scorer/service-receipt controls only; no OpenCode host or model calls." }
}
if (import.meta.main) {
  const target = process.argv[2]
  if (!target) throw new Error("Usage: bun scripts/comparative-benchmark-qualification.ts <new-qualification.json>")
  const receipt = qualifyComparative()
  writeFileSync(resolve(target), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify({ passed: receipt.passed, rows: receipt.rows.length, identity: receipt.identity }))
  if (!receipt.passed) process.exitCode = 1
}

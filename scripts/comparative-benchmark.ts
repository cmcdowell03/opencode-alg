import { createHash, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { comparativeIdentity, COMPARATIVE_ARMS, createComparativeCases, deterministicParticleAnswer, particleSourceSha256, scoreParticleAnswer } from "./comparative-benchmark-fixtures.ts"
import type { JobReceipts } from "./comparative-benchmark-fixtures.ts"

/** Deterministic apparatus check; access rows here are explicitly synthetic and never host evidence. */
export function runDeterministicComparative(seed = 20261118) {
  const cases = createComparativeCases(), rows: unknown[] = []
  for (const c of cases) {
    const order = [...COMPARATIVE_ARMS].sort((a, b) => createHash("sha256").update(`${seed}:${c.id}:${a}`).digest("hex")
      .localeCompare(createHash("sha256").update(`${seed}:${c.id}:${b}`).digest("hex")))
    for (const arm of order) {
      const manifestRef = "synthetic:manifest:fixture-control"
      const jobs: JobReceipts = { handoffSequence: 0, operations: [
        { sequence: 1, atMs: 1, action: "pending", status: 200 },
        { sequence: 2, atMs: 2, action: "lookup", key: c.acceptedJob.key, jobId: c.acceptedJob.id, revision: "particle-v3", status: 200 },
        { sequence: 3, atMs: 3, action: "read", jobId: c.acceptedJob.id, revision: "particle-v3", manifestRef, status: 200 },
      ] }
      const score = scoreParticleAnswer(c, { ...deterministicParticleAnswer(c), manifestRef }, [
        { tool: "read", path: c.dataPath, afterHandoff: true, sessionId: "fixture-recipient", callId: "synthetic-control-read",
          resultObserved: true, readContentSha256: particleSourceSha256(c), startedAtMs: 4, completedAtMs: 5 },
        { tool: "write", path: "answer.json", afterHandoff: true, sessionId: "fixture-recipient", callId: "synthetic-control-write",
          resultObserved: true, startedAtMs: 6, completedAtMs: 7 },
      ], jobs)
      if (!score.passed) throw new Error("Synthetic positive control failed the comparison scorer")
      rows.push({ blind_case_id: c.blindId, arm, mode: "deterministic_fixture_control", status: "completed", numeric_score: score.score,
        numeric_checks: score.checks, synthetic_access_control: score.access.data_read_after_handoff_observed })
    }
  }
  return { schema: "alg-comparative-benchmark-receipt-v2", result_kind: "deterministic_apparatus_only", generated_at: new Date().toISOString(),
    run_id: randomUUID(), seed, identity: comparativeIdentity(), rows,
    interpretation: "Synthetic math/scorer/schedule fixture only. Access is a labeled synthetic control, not observed tool usage; no OpenCode or model executed." }
}

if (import.meta.main) {
  const args = process.argv.slice(2), outputIndex = args.indexOf("--output"), seedIndex = args.indexOf("--seed")
  if (outputIndex < 0 || !args[outputIndex + 1]) throw new Error("Usage: bun scripts/comparative-benchmark.ts --output <new-receipt.json> [--seed u32]")
  const seed = seedIndex < 0 ? 20261118 : Number(args[seedIndex + 1])
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) throw new Error("seed must be u32")
  const output = resolve(args[outputIndex + 1]!)
  const receipt = runDeterministicComparative(seed)
  writeFileSync(output, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify({ result_kind: receipt.result_kind, rows: receipt.rows.length, output }))
}

import { createHash } from "node:crypto"
import { lstatSync, readFileSync, writeFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import { sha256Json } from "../src/persistence.ts"
import { createLongSessionCases, gradeLongCheckpoint, type LongPhase } from "./build-benchmark-long-fixtures.ts"
import { longReferenceCheckpoint } from "./build-benchmark-long-reference.ts"
import { openHardFixtureService } from "./hard-benchmark-fixtures.ts"
import { createHardBenchmarkHttpClient, startHardBenchmarkHost, type HardHostOperation } from "./hard-benchmark-host.ts"

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
const sources = ["build-benchmark.ts", "build-benchmark-protocol.ts", "build-benchmark-metrics.ts", "build-benchmark-transport.ts",
  "build-benchmark-retention.ts", "build-benchmark-retention-boundaries.ts", "build-benchmark-long-session.ts",
  "build-benchmark-long-fixtures.ts", "build-benchmark-long-reference.ts", "build-benchmark-long-qualification.ts", "build-benchmark-long-report.ts",
  "hard-benchmark-host.ts", "hard-benchmark-service.ts", "hard-benchmark-fixtures.ts", "hard-benchmark-qualification.ts", "hard-benchmark-cohort.ts"]
export function longBenchmarkIdentity(repo: string) {
  return { cases: sha256Json(createLongSessionCases()), sources: Object.fromEntries(sources.map(path => [path, hash(readFileSync(join(repo, "scripts", path)))])) }
}
const controls = ["positive", "wrong-report", "stale-nonce", "missing-fresh-actions", "incomplete-audit", "extra-output", "revoked-procedure"] as const
const phases = ["q0", "qh", "qc", "qr"] as const
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Receipt = z.object({ schema: z.literal("alg-long-session-qualification-v1"), generatedAt: z.iso.datetime(),
  identity: z.object({ cases: Hash, sources: z.record(z.string(), Hash) }).strict(),
  rows: z.array(z.object({ caseId: z.string(), phase: z.enum(phases), control: z.enum(controls),
    expected: z.boolean(), passed: z.boolean(), evidenceDigest: Hash,
    checks: z.array(z.object({ id: z.string(), passed: z.boolean() }).strict()).min(1) }).strict()).max(256),
  passed: z.boolean(), interpretation: z.string() }).strict()

export function readLongQualification(path: string, identity: ReturnType<typeof longBenchmarkIdentity>) {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw Error("invalid long qualification file")
  const bytes = readFileSync(path), evidence = Receipt.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
  if (sha256Json(identity) !== sha256Json(evidence.identity)) throw Error("long qualification runtime identities changed")
  const expected = new Set(createLongSessionCases().flatMap(c => phases.flatMap(phase =>
    (phase === "qr" ? controls : ["positive"] as const).map(control => `${c.fixture.contestant.id}:${phase}:${control}`))))
  for (const row of evidence.rows) {
    const key = `${row.caseId}:${row.phase}:${row.control}`
    if (!expected.delete(key) || row.expected !== (row.control === "positive") || row.passed !== row.expected ||
      row.passed !== row.checks.every(check => check.passed) || new Set(row.checks.map(check => check.id)).size !== row.checks.length)
      throw Error("long qualification incomplete or inconsistent")
  }
  if (expected.size || !evidence.passed) throw Error("long qualification did not pass")
  return { evidence, sha256: hash(bytes) }
}

/** Actual public HTTP service/oracle qualification, not a model benchmark or a host-compaction test. */
export async function qualifyLongSession(repo = resolve(import.meta.dir, "..")) {
  const identity = longBenchmarkIdentity(repo), rows: z.infer<typeof Receipt>["rows"] = []
  for (const c of createLongSessionCases()) {
    const directory = await mkdtemp(join(tmpdir(), "alg-long-qual-")), operations: HardHostOperation[] = []
    let host: Awaited<ReturnType<typeof startHardBenchmarkHost>> | undefined
    try {
      const service = await openHardFixtureService(c.base, directory)
      host = await startHardBenchmarkHost(service, { onOperation: operation => { operations.push(operation) } })
      const client = createHardBenchmarkHttpClient(host.url)
      let files: Record<string, string> | undefined
      for (const phase of phases) {
        const fromSequence = operations.at(-1)?.sequence ?? 0, nonce = `qualification-${phase}`
        files = await longReferenceCheckpoint(c, client, phase, nonce, files)
        for (const control of phase === "qr" ? controls : ["positive"] as const) {
          const candidate = { ...files }
          if (control === "wrong-report") candidate["factory.json"] = "{}"
          if (control === "stale-nonce") candidate["checkpoint.json"] = JSON.stringify({ ...JSON.parse(candidate["checkpoint.json"]!), nonce: "old" })
          if (control === "extra-output") candidate["unrequested.json"] = "{}"
          if (control === "revoked-procedure") candidate["checkpoint.json"] = JSON.stringify({ ...JSON.parse(candidate["checkpoint.json"]!), procedureVersion: "1" })
          const result = await gradeLongCheckpoint(c, candidate, { service, phase, nonce,
            operations: control === "missing-fresh-actions" ? [] : operations,
            auditComplete: control !== "incomplete-audit" && host.auditComplete === true, fromSequence })
          rows.push({ caseId: c.fixture.contestant.id, phase, control, expected: control === "positive", passed: result.passed,
            evidenceDigest: result.evidenceDigest, checks: result.checks.map(({ id, passed }) => ({ id, passed })) })
        }
      }
    } finally {
      if (host) await host.stop()
      await rm(directory, { recursive: true, force: true }) // mkdtemp-owned test root only
    }
  }
  if (sha256Json(identity) !== sha256Json(longBenchmarkIdentity(repo))) throw Error("qualification source changed")
  return Receipt.parse({ schema: "alg-long-session-qualification-v1", generatedAt: new Date().toISOString(), identity, rows,
    passed: rows.every(row => row.passed === row.expected),
    interpretation: "Synthetic public HTTP and independent artifact-oracle qualification only. Does not measure model behavior, context loss, long duration, or ALG superiority." })
}
if (import.meta.main) {
  if (!process.argv[2]) throw Error("Usage: bun scripts/build-benchmark-long-qualification.ts <new-receipt.json>")
  const result = await qualifyLongSession()
  writeFileSync(resolve(process.argv[2]), JSON.stringify(result, null, 2) + "\n", { flag: "wx" })
  console.log(JSON.stringify({ passed: result.passed, rows: result.rows.length }))
  if (!result.passed) process.exitCode = 1
}

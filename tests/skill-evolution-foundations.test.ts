import { expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { redactEvolutionValue } from "../src/skill-evolution-redaction.ts"
import { normalizeHistoricalMessages } from "../src/skill-evolution-historical.ts"
import { SkillEvolutionOptionsSchema, SKILL_EVOLUTION_MAX_JSON_BYTES } from "../src/skill-evolution-schemas.ts"
import { acquireHistoricalExecutionLease, beginSkillAudit, enqueueSkillAudit, failSkillAudit, inspectSkillTransactions, liveReviewStillOwned, loadSkillLedger, markLiveSkillLedgerOutcome, recoverPendingSkillAudits, skillEvolutionRoot, updateSkillLedgerRecord } from "../src/skill-evolution-store.ts"
import { tempProject, removeProject } from "./helpers.ts"

const options = SkillEvolutionOptionsSchema.parse({ enabled: true, maxAttempts: 3 })

test("credential canaries are absent from normalized canonical historical bytes and transport representations", () => {
  const token = "sk-proj-SyntheticCanary012345678901234567"
  const password = "synthetic multi word password"
  const pem = "-----BEGIN PRIVATE KEY-----\nSyntheticPemCanary\n-----END PRIVATE KEY-----"
  const data = { nested: [{ password }, { text: `${token}\n${pem}` }], encoded: encodeURIComponent(token), base64: Buffer.from(`password=${password}`).toString("base64"), escaped: token.replace("s", "\\u0073") }
  const raw = [{ info: { id: "m", sessionID: "s", role: "user", time: { created: 1 } }, parts: [{ id: "p", messageID: "m", sessionID: "s", type: "tool", state: { status: "completed", input: data } }] }]
  const normalized = normalizeHistoricalMessages(raw, "s")
  const serialized = JSON.stringify(redactEvolutionValue(data)) + normalized.canonical
  for (const canary of [token, password, "SyntheticPemCanary", encodeURIComponent(token), data.base64]) expect(serialized).not.toContain(canary)
  expect(normalized.byte_count).toBe(Buffer.byteLength(normalized.canonical))
  expect(serialized).toContain("[REDACTED]")
  expect(JSON.stringify(raw)).toContain(password)
})

test("live recovery is fenced across processes by the shared historical lease", async () => {
  const project = tempProject("alg-evolution-process-fence-")
  try {
    const { record } = enqueueSkillAudit(project, "s", "m", options)
    beginSkillAudit(project, record.key, options, "a".repeat(64))
    const lease = acquireHistoricalExecutionLease(project, "live-test")
    try {
      const before = readFileSync(join(skillEvolutionRoot(project), "ledger.json"))
      const script = `import { recoverPendingSkillAudits } from ${JSON.stringify(new URL("../src/skill-evolution-store.ts", import.meta.url).href)}; import { SkillEvolutionOptionsSchema } from ${JSON.stringify(new URL("../src/skill-evolution-schemas.ts", import.meta.url).href)}; try { recoverPendingSkillAudits(${JSON.stringify(project)}, SkillEvolutionOptionsSchema.parse({enabled:true})); process.exit(2) } catch(e) { if (e.name !== 'FilesystemMutexContentionError') throw e; console.log('fenced') }`
      const child = Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" })
      expect(await new Response(child.stdout).text()).toContain("fenced")
      expect(await child.exited).toBe(0)
      expect(readFileSync(join(skillEvolutionRoot(project), "ledger.json"))).toEqual(before)
      expect(() => acquireHistoricalExecutionLease(project, "historical-test")).toThrow()
    } finally { lease.release() }
    expect(recoverPendingSkillAudits(project, options)[0]?.status).toBe("pending")
  } finally { removeProject(project) }
})

test("late live success and failure writes cannot commit after a new attempt takes ownership", () => {
  const project = tempProject("alg-evolution-late-fence-")
  try {
    const { record } = enqueueSkillAudit(project, "s", "m", options)
    const old = "a".repeat(64), current = "b".repeat(64)
    beginSkillAudit(project, record.key, options, old)
    recoverPendingSkillAudits(project, options)
    beginSkillAudit(project, record.key, options, current)
    const before = loadSkillLedger(project)
    expect(liveReviewStillOwned(project, "s", "m", record.key, old)).toBe(false)
    expect(markLiveSkillLedgerOutcome(project, record.key, { status: "no-change", trigger_score: 0, trigger_labels: [] }, old)).toBeNull()
    failSkillAudit(project, record.key, "stale error", old)
    expect(loadSkillLedger(project)).toEqual(before)
    expect(liveReviewStillOwned(project, "s", "m", record.key, current)).toBe(true)
  } finally { removeProject(project) }
})

test("ledger size rejection checks formatted bytes and preserves the previous readable file", () => {
  const project = tempProject("alg-evolution-byte-bound-")
  try {
    enqueueSkillAudit(project, "s", "m", options)
    const ledger = loadSkillLedger(project)
    // Synthetic valid records: compact JSON fits, pretty JSON crosses the reader ceiling.
    ledger.records = Array.from({ length: 4096 }, (_, index) => ({ ...ledger.records[0]!, key: index.toString(16).padStart(64, "0"), session_id: `s${index}`, message_id: `m${index}` }))
    let count = 1
    while (count < ledger.records.length && Buffer.byteLength(JSON.stringify({ ...ledger, records: ledger.records.slice(0, count) }, null, 2) + "\n") <= SKILL_EVOLUTION_MAX_JSON_BYTES - 1500) count++
    ledger.records = ledger.records.slice(0, count - 1)
    const path = join(skillEvolutionRoot(project), "ledger.json")
    writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n")
    const before = readFileSync(path)
    expect(() => updateSkillLedgerRecord(project, ledger.records[0]!.key, (record) => { record.error = "x".repeat(2000) })).toThrow(/aggregate bound/)
    expect(readFileSync(path)).toEqual(before)
    expect(loadSkillLedger(project).records.length).toBe(ledger.records.length)
  } finally { removeProject(project) }
})

test("read-only transaction health leaves an absent store absent", () => {
  const project = tempProject("alg-evolution-health-")
  try {
    expect(inspectSkillTransactions(project)).toEqual({ recovered: [], unresolved: [], pending: 0, file_mutations: 0 })
    expect(existsSync(skillEvolutionRoot(project))).toBe(false)
  } finally { removeProject(project) }
})

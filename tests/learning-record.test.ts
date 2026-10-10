import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { isInformativeSkillTurn } from "../src/skill-catalog.ts"
import { buildSkillEvidence } from "../src/skill-evolution-evidence.ts"
import { SkillEvolutionOptionsSchema } from "../src/skill-evolution-schemas.ts"
import { enqueueSkillAudit, loadSkillLedger, loadSkillLedgerArchive, registerSkillAuditChild, skillLedgerKey } from "../src/skill-evolution-store.ts"
import { removeProject, tempProject } from "./helpers.ts"

const dirs: string[] = []
const project = (label: string) => { const path = tempProject(label); dirs.push(path); return path }
afterEach(() => { dirs.splice(0).forEach(removeProject) })

const DAY = 24 * 60 * 60 * 1_000
const ago = (days: number, offsetSeconds = 0) => new Date(Date.now() - days * DAY + offsetSeconds * 1_000).toISOString()
const store = (path: string) => join(realpathSync.native(path), ".opencode", "skill-evolution")

function record(index: number, status: string, days: number, extra: Record<string, unknown> = {}) {
  return { key: skillLedgerKey("session", `message-${index}`), session_id: "session", message_id: `message-${index}`, user_message_id: `user-${index}`,
    status, attempts: 1, forced_retries: 0, created_at: ago(days, index), updated_at: ago(days, index), ...extra }
}
function child(index: number, days: number, lifecycle: string | undefined = "completed") {
  return { session_id: `child-${index}`, parent_id: "session", title: `alg-private-skill-evolution-audit:${index}`, role: "auditor", registered_at: ago(days, index),
    ...(lifecycle ? { lifecycle } : {}) }
}
function seed(path: string, records: unknown[], children: unknown[] = []) {
  mkdirSync(store(path), { recursive: true })
  writeFileSync(join(store(path), "ledger.json"), JSON.stringify({ schema_version: 1, kind: "skill_evolution_ledger", revision: 1, records, audit_children: children,
    updated_at: new Date().toISOString() }))
}
const segments = (path: string) => existsSync(join(store(path), "ledger-archive")) ? readdirSync(join(store(path), "ledger-archive")).sort() : []
const options = (overrides: Record<string, unknown> = {}) => SkillEvolutionOptionsSchema.parse({ enabled: true, allowBuiltinToolMap: true, mode: "every-turn", ...overrides })

describe("the learning record never fills up", () => {
  test("old settled records move to an archive and the turn still counts as audited", () => {
    const path = project("alg-ledger-archive-")
    const small = options({ maxLedgerRecords: 16 })
    // Twelve of sixteen is the three-quarter mark. All are a week old and settled.
    seed(path, Array.from({ length: 12 }, (_, index) => record(index, index % 3 === 0 ? "failed" : "no-change", 7, index % 3 === 0 ? { error: "auditor output was invalid" } : {})))

    const added = enqueueSkillAudit(path, "session", "message-new", small, false, "user-new")
    expect(added).toMatchObject({ enqueued: true, reason: "new" })
    // Brought back to half (eight), then the new turn was added.
    expect(loadSkillLedger(path).records.map((entry) => entry.message_id)).toEqual(["message-4", "message-5", "message-6", "message-7", "message-8", "message-9", "message-10", "message-11", "message-new"])
    expect(segments(path)).toEqual(["records-000001.json"])
    const archive = loadSkillLedgerArchive(path)
    expect([...archive.records.values()].map((entry) => entry.message_id).sort()).toEqual(["message-0", "message-1", "message-2", "message-3"])

    // Registering an archived turn again is a duplicate, by key and by its user message.
    const before = loadSkillLedger(path).revision
    expect(enqueueSkillAudit(path, "session", "message-1", small, false, "user-1")).toMatchObject({ enqueued: false, reason: "duplicate", record: { status: "no-change" } })
    expect(enqueueSkillAudit(path, "session", "message-1-postprocessed", small, false, "user-1")).toMatchObject({ enqueued: false, reason: "duplicate" })
    expect(loadSkillLedger(path).revision).toBe(before)
    expect(() => enqueueSkillAudit(path, "session", "message-1", small, true)).toThrow(/not available for an archived record/)
  })

  test("it keeps working turn after turn far past the old limit", () => {
    const path = project("alg-ledger-archive-many-")
    const small = options({ maxLedgerRecords: 16 })
    // Sixty turns against a limit of sixteen. Each is settled and aged before the next arrives.
    for (let turn = 0; turn < 60; turn++) {
      expect(enqueueSkillAudit(path, "session", `message-${turn}`, small, false, `user-${turn}`)).toMatchObject({ enqueued: true })
      const ledger = JSON.parse(readFileSync(join(store(path), "ledger.json"), "utf8"))
      for (const entry of ledger.records) if (entry.status === "pending") { entry.status = "no-change"; entry.created_at = ago(3, turn); entry.updated_at = ago(3, turn) }
      writeFileSync(join(store(path), "ledger.json"), JSON.stringify(ledger))
    }
    const live = loadSkillLedger(path).records.length, archived = loadSkillLedgerArchive(path).records.size
    expect(live).toBeLessThanOrEqual(12)
    expect(live + archived).toBe(60)
    expect(enqueueSkillAudit(path, "session", "message-0", small, false, "user-0")).toMatchObject({ enqueued: false, reason: "duplicate" })
  }, 60_000)

  test("recent, unfinished and candidate records never move, and the hard limit still holds", () => {
    const path = project("alg-ledger-archive-keep-")
    const small = options({ maxLedgerRecords: 16 })
    seed(path, [
      ...Array.from({ length: 5 }, (_, index) => record(index, "no-change", 0.1)),
      ...Array.from({ length: 4 }, (_, index) => record(10 + index, "pending", 30)),
      ...Array.from({ length: 3 }, (_, index) => record(20 + index, "running", 30)),
      ...Array.from({ length: 3 }, (_, index) => record(30 + index, "failed", 30, { error: "blocked by an active historical review; retry after historical review releases its claim" })),
    ])
    const beforeKeys = loadSkillLedger(path).records.map((entry) => entry.key)
    enqueueSkillAudit(path, "session", "message-new", small, false, "user-new")
    const after = loadSkillLedger(path).records
    for (const key of beforeKeys.slice(0, 12)) expect(after.some((entry) => entry.key === key)).toBe(true)
    // Nothing above could be archived except possibly the old failed ones; with the limit reached, the
    // ledger still refuses rather than discard a record.
    while (loadSkillLedger(path).records.length < 16) enqueueSkillAudit(path, "session", `filler-${loadSkillLedger(path).records.length}`, small)
    if (loadSkillLedgerArchive(path).records.size === 0) {
      expect(() => enqueueSkillAudit(path, "session", "one-too-many", small)).toThrow(/capacity reached/)
    }
  })

  test("a byte limit alone also moves the older half out", () => {
    const path = project("alg-ledger-archive-bytes-")
    // 200 failed records with long errors: about 460 KB, past three quarters of the 512 KiB bound.
    seed(path, Array.from({ length: 200 }, (_, index) => record(index, "failed", 5, { error: "e".repeat(2_000) })))
    const large = options({ maxLedgerRecords: 4_096 })
    expect(enqueueSkillAudit(path, "session", "message-new", large, false, "user-new")).toMatchObject({ enqueued: true })
    expect(loadSkillLedger(path).records.length).toBe(101)
    expect(loadSkillLedgerArchive(path).records.size).toBe(100)
    expect(segments(path).length).toBe(2)
  })

  test("finished audit children are archived before their registry fills", () => {
    const path = project("alg-ledger-archive-children-")
    seed(path, [], [
      ...Array.from({ length: 700 }, (_, index) => child(index, 10)),
      ...Array.from({ length: 40 }, (_, index) => child(1_000 + index, 10, undefined)),
      ...Array.from({ length: 10 }, (_, index) => child(2_000 + index, 10, "running")),
      ...Array.from({ length: 10 }, (_, index) => child(3_000 + index, 0.1)),
    ])
    registerSkillAuditChild(path, { session_id: "child-new", parent_id: "session", title: "alg-private-skill-evolution-audit:new", role: "auditor" })
    const ledger = loadSkillLedger(path)
    // 760 registered, limit 1,000: brought back to half, oldest finished first; then the new one.
    expect(ledger.audit_children.length).toBe(501)
    expect(ledger.audit_children.filter((entry) => entry.lifecycle === "running").length).toBe(10)
    expect(ledger.audit_children.some((entry) => entry.session_id === "child-3005")).toBe(true)
    expect(loadSkillLedgerArchive(path).audit_children).toBe(260)
  })
})

describe("a command that exits non-zero is a failed command, whatever it printed", () => {
  const turn = (exit: number, output: string) => [
    { info: { id: "u", sessionID: "owner", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "Run the suite and tell me the result." }] },
    { info: { id: "step", parentID: "u", sessionID: "owner", role: "assistant", finish: "tool-calls", time: { created: 2, completed: 3 } }, parts: [
      { type: "tool", tool: "bash", state: { status: "completed", input: { command: "node test.js" }, output, metadata: { exit, output } } },
      { type: "tool", tool: "bash", state: { status: "completed", input: { command: "node tools/prepare.js && node test.js" }, output: "fixtures prepared\n3 tests passed\n", metadata: { exit: 0 } } },
    ] },
    { info: { id: "final", parentID: "u", sessionID: "owner", role: "assistant", finish: "stop", time: { created: 4, completed: 5 } }, parts: [{ type: "text", text: "They pass after the prepare step." }] },
  ]

  test("the turn is scored as a failed command that was then made to work", () => {
    const settings = options()
    // The script printed FAIL, a word none of the keyword rules look for.
    const evidence = buildSkillEvidence(turn(1, "FAIL: fixtures missing.\n"), "owner", "final", settings)
    expect(evidence.tools[0]).toMatchObject({ name: "bash", status: "completed" })
    expect(evidence.tools[0]!.error.excerpt).toBe("exit code 1")
    expect(evidence.tools[1]!.error.excerpt).toBe("")
    expect(evidence.trigger_labels).toContain("failed_tests_or_commands")
    expect(evidence.trigger_labels).toContain("reusable_successful_procedure")
    expect(isInformativeSkillTurn(evidence.trigger_score, evidence.trigger_labels, settings.minimumTriggerScore, settings.mode)).toBe(true)
  })

  test("a turn whose commands all succeeded is scored as before", () => {
    const settings = options()
    const evidence = buildSkillEvidence(turn(0, "3 tests passed\n"), "owner", "final", settings)
    expect(evidence.tools[0]!.error.excerpt).toBe("")
    expect(evidence.trigger_labels).not.toContain("failed_tests_or_commands")
    expect(isInformativeSkillTurn(evidence.trigger_score, evidence.trigger_labels, settings.minimumTriggerScore, settings.mode)).toBe(false)
  })
})

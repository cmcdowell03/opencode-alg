import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendExperience, archiveExperience, experienceCatalog, experienceHash, experienceHealth, importHistoricalPlanExperience, intakeTerminalRunExperience, loadExperience, type ExperienceInput } from "../src/experience.ts"
import { updateHistoricalIndex } from "../src/skill-evolution-store.ts"
import { changeIncident, incidentHistory } from "../src/troubleshooter.ts"
import { evaluateSkill } from "../src/skill-evaluation.ts"

const dirs: string[] = []
function project() { const p = mkdtempSync(join(tmpdir(), "alg-experience-test-")); dirs.push(p); return p }
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }) })
function input(overrides: Partial<ExperienceInput> = {}): ExperienceInput {
  return { kind: "observation", source: { type: "fixture", id: "test", sha256: experienceHash("fixture") },
    observed_at: "2026-09-04T00:00:00Z", retention: "operational", status: "observed", summary: "synthetic observation",
    skill_version: null, group: "task-1", relations: [], metrics: { model_cost: null }, ...overrides }
}

describe("explicit experience foundation", () => {
  test("inspection has no initialization side effects", () => {
    const p = project()
    expect(experienceHealth(p).objects).toBe(0)
    expect(existsSync(join(p, ".opencode"))).toBe(false)
  })
  test("dedupe, integrity, exact project binding and deterministic catalog", () => {
    const p = project(), other = project()
    const first = appendExperience(p, input())
    expect(appendExperience(p, input()).id).toBe(first.id)
    expect(experienceHealth(p).objects).toBe(1)
    expect(loadExperience(p, first.id)).toEqual(first)
    expect(experienceCatalog(p)).toEqual(experienceCatalog(p))
    const second = appendExperience(other, input())
    expect(second.id).not.toBe(first.id)
    expect(() => loadExperience(other, first.id)).toThrow()
    writeFileSync(join(p, ".opencode", "experience", "outbox", `${first.id}.json`), JSON.stringify({ ...first, summary: "tampered" }))
    expect(() => loadExperience(p, first.id)).toThrow("identity")
  })
  test("redacts synthetic credentials and rejects absent references", () => {
    const p = project(), canary = "sk-proj-abcdefghijklmnopqrstuvwx"
    const saved = appendExperience(p, input({ summary: `password=syntheticpass ${canary}` }))
    expect(saved.summary).not.toContain("syntheticpass")
    expect(saved.summary).not.toContain(canary)
    expect(() => appendExperience(p, input({ relations: [{ kind: "supports", id: "a".repeat(64) }] }))).toThrow()
  })
  test("incident transitions are revision-fenced and evidence-gated", () => {
    const p = project()
    const change = (state: string, revision: number, evidence: string[] = [], approved_plan?: string, remediation?: { action: string; rollback: string; verification: string }) => changeIncident(p, {
      incident_id: "incident-1", expected_revision: revision, state, summary: "synthetic diagnosis",
      observed_at: `2026-09-04T00:00:${String(revision).padStart(2, "0")}Z`, evidence,
      ...(approved_plan ? { approved_plan } : {}),
      ...(remediation ? { remediation } : {}),
    })
    change("opened", 0)
    expect(() => change("triaged", 0)).toThrow("revision")
    change("triaged", 1); change("investigating", 2)
    expect(() => change("cause-identified", 3)).toThrow("diagnostic")
    const observation = appendExperience(p, input())
    change("cause-identified", 3, [observation.id])
    const proposals = Object.fromEntries(["action", "rollback", "verification"].map((role) => [role, appendExperience(p, input({ kind: "action", status: "inferred", group: "incident-1", source: { type: `${role}-proposal`, id: role, sha256: experienceHash(role) }, summary: `Synthetic ${role} proposal` })).id])) as { action: string; rollback: string; verification: string }
    expect(() => change("remediation-planned", 4, [proposals.action])).toThrow("rollback")
    const plan = change("remediation-planned", 4, [], undefined, proposals)
    expect(() => change("remediating", 5)).toThrow("confirmation")
    const remediation = change("remediating", 5, [], plan.id)
    change("verifying", 6)
    expect(() => change("resolved", 7)).toThrow("verification")
    const verified = appendExperience(p, input({ kind: "outcome", group: "incident-1", status: "success", observed_at: "2026-09-04T00:00:07Z", relations: [{ kind: "tests", id: remediation.id }] }))
    change("resolved", 7, [verified.id]); change("reopened", 8)
    expect(incidentHistory(p, "incident-1")).toHaveLength(9)
  })
  test("paired evaluation checks application provenance and leakage without auto-promotion", () => {
    const p = project(), baseline = experienceHash("baseline"), candidate = experienceHash("candidate"), environment = experienceHash("environment")
    const env = appendExperience(p, input({ kind: "source_artifact", source: { type: "evaluation-environment", id: "model-1", sha256: environment } }))
    const versions = [baseline, candidate].map((sha256, index) => appendExperience(p, input({ kind: "skill_version", source: { type: "skill", id: `skill-${index}`, sha256 } })))
    const outcomes = versions.map((version, index) => appendExperience(p, input({ kind: "outcome", status: index ? "success" : "failure", skill_version: version.source.sha256,
      relations: [{ kind: "applied", id: version.id }, { kind: "derived_from", id: env.id }] })))
    const request = { id: "evaluation-1", observed_at: "2026-09-04T01:00:00Z", baseline, candidate, environment_sha256: environment, model: "model-1", training: [], pairs: [{ baseline: outcomes[0]!.id, candidate: outcomes[1]!.id }] }
    const result = evaluateSkill(p, request)
    expect(result.eligible_for_review).toBe(true)
    expect(result.automatically_promoted).toBe(false)
    expect(result.record.metrics.candidate_cost).toBe(null)
    expect(() => evaluateSkill(p, { ...request, training: [outcomes[0]!.id] })).toThrow("leakage")
    expect(() => evaluateSkill(p, { ...request, pairs: [...request.pairs, ...request.pairs] })).toThrow("duplicate")
    expect(() => evaluateSkill(p, { ...request, environment_sha256: "f".repeat(64) })).toThrow("provenance")
    const ancestor = appendExperience(p, input({ group: "training-parent", source: { type: "task", id: "train", sha256: experienceHash("training") } }))
    const derived = appendExperience(p, input({ kind: "outcome", status: "success", skill_version: candidate, source: { type: "task", id: "derived", sha256: experienceHash("derived") }, relations: [...outcomes[1]!.relations, { kind: "derived_from", id: ancestor.id }] }))
    expect(() => evaluateSkill(p, { ...request, training: [ancestor.id], pairs: [{ baseline: outcomes[0]!.id, candidate: derived.id }] })).toThrow("leakage")
  })

  test("raw identity fields fail before initialization and archive copies remain deduplicated", () => {
    const p = project()
    expect(() => appendExperience(p, { ...input(), project: "a".repeat(64) })).toThrow()
    expect(existsSync(join(p, ".opencode"))).toBe(false)
    expect(() => appendExperience(p, { ...input(), summary: 12 })).toThrow()
    const record = appendExperience(p, input())
    expect(() => archiveExperience(p, record.id, false)).toThrow("confirmation")
    expect(archiveExperience(p, record.id, true)).toEqual(record)
    expect(appendExperience(p, input()).id).toBe(record.id)
    expect(experienceHealth(p).objects).toBe(1)
    const outbox = join(p, ".opencode", "experience", "outbox", `${record.id}.json`)
    const archive = join(p, ".opencode", "experience", "archive", `${record.id}.json`)
    expect(readFileSync(archive)).toEqual(readFileSync(outbox))
    writeFileSync(archive, "{}")
    expect(() => loadExperience(p, record.id)).toThrow("disagrees")
  })

  test("sealed historical import copies commitments not transcripts and intake stays explicit", () => {
    const p = project()
    const planId = `hist-${"ab".repeat(16)}`
    const confirmation = "c".repeat(64)
    const commitment = "d".repeat(64)
    const snapshot = { path: `.opencode/skill-evolution/historical-snapshots/${commitment}.json`, sha256: commitment, byte_size: 12 }
    expect(intakeTerminalRunExperience(p, "owner-session")).toMatchObject({ imported: 0, skipped: 0, automatic_intake: false })
    expect(existsSync(join(p, ".opencode", "experience"))).toBe(false)
    expect(() => importHistoricalPlanExperience(p, planId)).toThrow("not found")
    updateHistoricalIndex(p, "fixture", (index) => {
      index.plans.push({
        plan_id: planId, plan_ref: snapshot, confirmation, state: "previewed", selected_session_ids: ["selected"],
        sessions: [{
          session_id: "selected", commitment, snapshot_ref: snapshot, chunk_refs: [], message_count: 2, part_count: 2,
          fragment_count: 0, byte_count: 99, assistant_message_ids: ["message-1"],
        }],
        next_chunk: 0, model_calls: 3, input_bytes: 0, cancelled: false, disposition: "previewed", checkpoints: [],
        created_at: "2026-09-05T00:00:00.000Z", updated_at: "2026-09-05T00:00:01.000Z",
      })
    })
    expect(() => importHistoricalPlanExperience(p, planId)).toThrow("completed")
    updateHistoricalIndex(p, "complete", (index) => {
      const plan = index.plans[0] as { state: string; cancelled: boolean; disposition: string }
      plan.state = "completed"; plan.cancelled = false; plan.disposition = "completed"
    })
    const records = importHistoricalPlanExperience(p, planId)
    expect(records).toHaveLength(2)
    const serialized = JSON.stringify(records)
    expect(serialized).not.toContain("canonical_base64")
    expect(serialized).not.toContain("UNTRUSTED FRAGMENT")
    expect(records[1]?.summary).toContain("not copied")
    expect(records[0]).toMatchObject({ kind: "outcome", source: { type: "historical-plan", id: planId, sha256: confirmation } })
    expect(records[1]).toMatchObject({ kind: "source_artifact", source: { type: "historical-sealed", id: commitment, sha256: commitment } })
    expect(records[1]?.metrics.bytes).toBe(99)
    expect(importHistoricalPlanExperience(p, planId).map((row) => row.id)).toEqual(records.map((row) => row.id))
    expect(experienceHealth(p).automatic_intake).toBe(false)
  })
})

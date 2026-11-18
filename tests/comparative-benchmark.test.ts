import { describe, expect, test } from "bun:test"
import { comparativeIdentity, COMPARATIVE_ARMS, contestantView, createComparativeCases, expectedParticleAnswer, particleCsv, scoreParticleAnswer, type JobReceipts } from "../scripts/comparative-benchmark-fixtures.ts"
import { qualifyComparative } from "../scripts/comparative-benchmark-qualification.ts"
import { runDeterministicComparative } from "../scripts/comparative-benchmark.ts"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import server from "../src/index.ts"
import { initializeComparativeMemory, verifyComparativeMemory } from "../scripts/comparative-benchmark-memory.ts"
import { removeProject, tempProject } from "./helpers.ts"

function receipts(c: ReturnType<typeof createComparativeCases>[number]): JobReceipts {
  return { handoffSequence: 2, operations: [
    { sequence: 3, atMs: 300, action: "pending", key: c.acceptedJob.key, jobId: c.acceptedJob.id, revision: "particle-v3", status: 200 },
    { sequence: 4, atMs: 301, action: "lookup", key: c.acceptedJob.key, jobId: c.acceptedJob.id, revision: "particle-v3", status: 200 },
    { sequence: 5, atMs: 302, action: "read", jobId: c.acceptedJob.id, revision: "particle-v3", status: 200 },
  ] }
}
describe("matched particle handoff comparison", () => {
  test("the memory arm requires the recipient's emitted skill and accepted-job context", async () => {
    const project = tempProject("alg-comparative-memory-")
    try {
      const skillDir = join(project, ".opencode", "skills", "evidence-recovery")
      mkdirSync(skillDir, { recursive: true })
      writeFileSync(join(skillDir, "SKILL.md"), "---\nname: evidence-recovery\ndescription: Recover an accepted measurement\n---\nUse the original result.")
      initializeComparativeMemory(project, "recipient", "Accepted measurement job ABC123")
      expect(() => verifyComparativeMemory(project, "recipient")).toThrow("No emitted")
      const hooks = await server({ directory: project, worktree: project, project: { id: "fixture" }, client: {
        session: { get: async () => ({ data: { id: "recipient", projectID: "fixture", directory: project } }),
          messages: async () => ({ data: [] }) }, app: { log: async () => ({}) },
      } } as any, { sessionMemory: { mode: "assist" }, skillEvolution: { enabled: false } } as any)
      try {
        const output = { system: [] as string[] }
        await hooks["experimental.chat.system.transform"]!({ sessionID: "recipient", model: { limit: { context: 32000, output: 4096 } } } as any, output)
        expect(output.system.join("\n")).toContain("Accepted measurement job ABC123")
        expect(output.system.join("\n")).toContain("Use the original result.")
        expect(verifyComparativeMemory(project, "recipient").context_hash).toMatch(/^[a-f0-9]{64}$/)
        expect(() => verifyComparativeMemory(project, "other-session")).toThrow("No emitted")
      } finally { await hooks.dispose?.() }
    } finally { removeProject(project) }
  }, 60_000)
  test("cases share identical crude chamber rates while inspection-matched effect differs", () => {
    const [persists, shift] = createComparativeCases(), p = expectedParticleAnswer(persists!), s = expectedParticleAnswer(shift!)
    expect([p.raw.chamberA, p.raw.chamberB, s.raw.chamberA, s.raw.chamberB]).toEqual([0.3, 0.1, 0.3, 0.1])
    expect(p.matched.standardizedDifference).toBeCloseTo(0.2)
    expect(Object.values(s.matchedStrata)).toEqual([0, 0, 0, 0])
    expect(s.conclusion).toBe("inspection_revision_mix_explains_association")
    expect(p.nextMeasurement).toBe("balanced_chamber_crossover")
    expect(s.nextMeasurement).toBe("inspection_revision_validation")
    expect(particleCsv(shift!)).toContain("inspection_revision")
  })
  test("same task and local job procedure are present; outcome, skill and run metadata do not reveal gold", () => {
    const cases = createComparativeCases()
    for (const c of cases) for (const arm of COMPARATIVE_ARMS) {
      const view = contestantView(c, arm)
      expect(JSON.stringify(view)).not.toContain(c.id)
      expect(JSON.stringify(view)).not.toContain('"expected"')
      expect(view.task).toContain("pending-list")
      expect(view.task).toContain("nextMeasurement")
      expect(view.task).toContain("Never submit")
    }
    expect(contestantView(cases[0]!, "native-build")).not.toHaveProperty("durableEvidence")
    expect(contestantView(cases[0]!, "scoped-evidence-skill").durableEvidence).toContain(cases[0]!.acceptedJob.key)
    expect(contestantView(cases[0]!, "scoped-evidence-skill").recoverySkill).toEqual(contestantView(cases[1]!, "scoped-evidence-skill").recoverySkill)
  })
  test("scores numbers, the next measurement, post-handoff access, job recovery and duplicate submissions separately", () => {
    const c = createComparativeCases()[1]!, answer = expectedParticleAnswer(c), observed = [
      { tool: "read", path: c.dataPath, sessionId: "new-controller", afterHandoff: true, callId: "tool1", resultObserved: true },
    ]
    const good = scoreParticleAnswer(c, answer, observed, receipts(c))
    expect(good.passed).toBe(true)
    expect(good.access.data_read_after_handoff_observed).toBe(true)
    const duplicate = receipts(c); duplicate.operations.push({ sequence: 1, atMs: 100, action: "submit", key: "unrelated-key", status: 409 })
    expect(scoreParticleAnswer(c, answer, observed, duplicate).job.duplicate_submissions).toBe(1)
    const preHandoffOnly = [{ ...observed[0]!, sessionId: "old-controller", afterHandoff: false }]
    expect(scoreParticleAnswer(c, answer, preHandoffOnly, receipts(c)).access.data_read_after_handoff_observed).toBe(false)
    const missingRead = receipts(c); missingRead.operations = missingRead.operations.filter(row => row.action !== "read")
    expect((scoreParticleAnswer(c, answer, observed, missingRead).job as any).passed).toBe(false)
  })
  test("qualification exercises numeric, access, job and duplicate controls; dry run is labeled apparatus only", () => {
    const qualification = qualifyComparative()
    expect(qualification.passed).toBe(true)
    expect(qualification.rows).toHaveLength(20)
    expect(qualification.identity).toEqual(comparativeIdentity())
    const result = runDeterministicComparative(42)
    expect(result.result_kind).toBe("deterministic_apparatus_only")
    expect(result.rows).toHaveLength(6)
    expect(result.interpretation).toContain("not observed tool usage")
  })
})

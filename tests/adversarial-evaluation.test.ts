import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { ADVERSARIAL_CASES, checkSyntheticOracle } from "../scripts/adversarial-cases.ts"
import { runAdversarialEvaluation } from "../scripts/adversarial-evaluation.ts"
import { jsonSchemaHint } from "../src/schemas.ts"

describe("synthetic paired adversarial evaluation", () => {
  test("rejects inconsistent strata, duplicate approval IDs and false duplicate oracle metadata", () => {
    const stratum = structuredClone(ADVERSARIAL_CASES.find(item => item.id === "confounding")!)
    ;(stratum.evidence[0]!.value as any).control.outcomes = 18
    expect(checkSyntheticOracle(stratum)).toBe(false)
    const approvals = structuredClone(ADVERSARIAL_CASES[0]!)
    ;(approvals.evidence[0]!.value as any).approvals[1] = "W01"
    expect(checkSyntheticOracle(approvals)).toBe(false)
    const duplicate = structuredClone(ADVERSARIAL_CASES.find(item => item.id === "misleading-evidence-instruction")!)
    ;(duplicate.oracle.observed_value as any).duplicate_ids = ["R2"]
    expect(checkSyntheticOracle(duplicate)).toBe(false)
  })
  test("all ten frozen cases have deterministic construction-based oracles and include null controls", () => {
    expect(ADVERSARIAL_CASES).toHaveLength(10)
    expect(new Set(ADVERSARIAL_CASES.map(item => item.id)).size).toBe(10)
    expect(ADVERSARIAL_CASES.every(checkSyntheticOracle)).toBe(true)
    expect(ADVERSARIAL_CASES.filter(item => item.expected === "supported").length).toBeGreaterThanOrEqual(3)
    expect(ADVERSARIAL_CASES.some(item => item.expected === "inconclusive")).toBe(true)
    expect(ADVERSARIAL_CASES.some(item => item.expected === "unsupported")).toBe(true)
  })

  test("writes the immutable manifest before inference and runs fixed alternating 40-call pairs", async () => {
    const root = await mkdtemp(join(process.cwd(), ".alg-adversarial-eval-"))
    let calls = 0
    const checkerPrompts: string[] = []
    const report = await runAdversarialEvaluation({
      model: "fixture-model",
      artifactDirectory: root,
      complete: async ({ prompt, maxOutputTokens }) => {
        calls++
        expect(maxOutputTokens).toBe(1024)
        expect(prompt).toContain("OUTPUT CONTRACT (mandatory):")
        expect(prompt).toContain(jsonSchemaHint(prompt.includes("VERIFICATION CONTRACT v1:") ? "checker" : "researcher"))
        if (prompt.includes("VERIFICATION CONTRACT v1:")) {
          checkerPrompts.push(prompt)
          const claimedMatch = prompt.match(/CLAIMED OUTPUT:\n```json\n([\s\S]*?)\n```/)
          expect(claimedMatch).not.toBeNull()
          const claimed = JSON.parse(claimedMatch![1]!) as { claim: string }
          const item = ADVERSARIAL_CASES.find(value => value.claim === claimed.claim)!
          const passed = item.expected === "supported"
          return { text: JSON.stringify({
            passed,
            failures: passed ? [] : ["fixture oracle finding"],
            score: passed ? 9 : 6,
            findings: [{ criterion_id: "C1", outcome: item.expected, evidence_ids: ["E1"], reason: item.rationale }],
          }), actualTokens: 43, durationMs: 120 }
        }
        const manifestFiles = await readdir(join(root, (await readdir(root))[0]!))
        expect(manifestFiles).toContain("manifest.json")
        return { text: JSON.stringify({ answer: "bounded synthetic review", evidence: [], constraints: [], options: [], acceptance_criteria: ["reviewed"], risks: [] }), actualTokens: 21, durationMs: 80 }
      },
    })
    try {
      expect(calls).toBe(40)
      expect(report.calls).toBe(40)
      expect(report.caseCount).toBe(10)
      expect(report.paired).toEqual({ wins: 0, losses: 0, ties: 10 })
      expect(report.schemaFailures).toBe(0)
      expect(report.transportFailures).toBe(0)
      expect(report.arms.ordinary_review.calls).toBe(20)
      expect(report.arms.targeted_falsification.calls).toBe(20)
      expect(report.actualTokens).toBe(1_280)
      const manifest = JSON.parse(await readFile(report.manifestPath, "utf8"))
      expect(manifest.protocol.callsPerModel).toBe(40)
      expect(manifest.protocol.noRetries).toBe(true)
      expect(manifest.cases.map((row: { firstStrategy: string }) => row.firstStrategy)).toEqual([
        "ordinary_review", "targeted_falsification", "ordinary_review", "targeted_falsification", "ordinary_review",
        "targeted_falsification", "ordinary_review", "targeted_falsification", "ordinary_review", "targeted_falsification",
      ])
      expect(checkerPrompts).toHaveLength(20)
      expect(checkerPrompts.every(prompt => prompt.includes("VERIFICATION CONTRACT v1:") && prompt.includes("Evidence IDs correspond"))).toBe(true)
      const events = (await readFile(report.eventsPath, "utf8")).trim().split("\n").map(line => JSON.parse(line))
      expect(events.filter((event: { event: string }) => event.event === "call_completed")).toHaveLength(40)
      expect(events.filter((event: { event: string }) => event.event === "call_started")).toHaveLength(40)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("does not retry transport or schema failures and reports them separately", async () => {
    const root = await mkdtemp(join(process.cwd(), ".alg-adversarial-failures-"))
    let calls = 0
    const report = await runAdversarialEvaluation({
      model: "failure-fixture",
      artifactDirectory: root,
      complete: async () => {
        calls++
        if (calls === 1) throw new Error("synthetic transport break")
        if (calls === 2) return { text: "not JSON", actualTokens: 3, durationMs: 5 }
        // Remaining fixed slots return valid role outputs, so the exercise checks
        // that the two failed calls were recorded without being retried.
        if (calls % 2 === 0) return { text: "{}", actualTokens: 1, durationMs: 1 }
        return { text: JSON.stringify({ answer: "review", evidence: [], constraints: [], options: [], acceptance_criteria: ["x"], risks: [] }), actualTokens: 1, durationMs: 1 }
      },
    })
    try {
      expect(calls).toBe(40)
      expect(report.transportFailures).toBe(1)
      expect(report.schemaFailures).toBeGreaterThan(0)
      const events = await readFile(report.eventsPath, "utf8")
      expect(events).toContain("synthetic transport break")
      expect((await readdir(join(root, report.runId))).sort()).toEqual(["events.jsonl", "manifest.json", "report.json"])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

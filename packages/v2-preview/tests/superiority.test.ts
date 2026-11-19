import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { handoffId } from "../benchmark/handoff-case.ts"
import { evaluateSuperiority, type SuperiorityEvidence, type SuperiorityPlan } from "../benchmark/superiority.ts"

const digest = (label: string) => createHash("sha256").update(label).digest("hex")
const publishedAt = "2026-11-01T00:00:00Z"
const startedAt = "2026-11-02T00:00:00Z"
const fixtures = ["causal-positive", "near-miss", "authority-withdrawal", "extended"] as const
const orders = ["alg-first", "build-first"] as const
const controls = {
  hostSha256: digest("host"), model: "fixture/provider-model", packageSha256: digest("package"),
  budgetSha256: digest("budget"), protocolSha256: digest("protocol"),
}

function study(perStratum = 1) {
  const cases = fixtures.flatMap(caseClass => orders.flatMap(order => Array.from({ length: perStratum }, (_, i) => {
    const incidentId = [caseClass, order, i].join("/")
    return { incidentId, independenceGroup: incidentId, seedFamily: null, caseClass, order, purpose: "held-out" as const,
      evidenceSha256: digest("evidence:" + incidentId), oracleSha256: digest("oracle:" + incidentId) }
  })))
  const plan: SuperiorityPlan = {
    schema: 1, endpoint: "evidence-supported-final-decision", method: "stratified-exact-bonferroni-95", controls, cases,
  }
  const evidence: SuperiorityEvidence = {
    schema: 1, planSha256: "", pairs: cases.map(({ incidentId, independenceGroup, seedFamily, order, evidenceSha256, oracleSha256 }) => {
      const arm = { controls: { ...controls }, evidenceSha256, unauthorizedActions: 0, duplicateAdmissions: 0,
        duplicateExpensiveAdmissions: 0 }
      return { incidentId, independenceGroup, seedFamily, order, oracleSha256, startedAt, purpose: "held-out",
        mode: "live-model", receiptSha256: digest("run:" + incidentId),
        independentAssessmentSha256: digest("assessment:" + incidentId),
        alg: { ...arm, endpoint: "correct" }, build: { ...arm, endpoint: "incorrect" } }
    }),
  }
  function evaluate() {
    const planJson = JSON.stringify(plan)
    const publishedSha256 = digest(planJson)
    evidence.planSha256 = publishedSha256
    return evaluateSuperiority(evidence, { planJson, publishedSha256, publishedAt })
  }
  return { plan, evidence, evaluate }
}

describe("held-out paired superiority", () => {
  test("uses the exact simultaneous bounds on a balanced all-win sample", () => {
    const run = study(16)
    const score = run.evaluate()
    const exactLower = 2 * (0.05 / 32) ** (1 / 16) - 1
    expect(score.status).toBe("superiority_supported")
    expect(score.observed).toMatchObject({ planned: 128, wins: 128, losses: 0, ties: 0, accuracyDifference: 1 })
    expect(score.interval?.lower).toBeCloseTo(exactLower, 12)
    expect(score.interval?.upper).toBe(1)
    for (const pair of run.evidence.pairs) {
      const alg = pair.alg
      pair.alg = pair.build
      pair.build = alg
    }
    const reversed = run.evaluate()
    expect(reversed.status).toBe("not_established")
    expect(reversed.interval?.upper).toBeCloseTo(-exactLower, 12)
    expect(reversed.interval?.lower).toBe(-1)
  })

  test("includes ties in the paired accuracy difference and keeps uncertainty at small sample sizes", () => {
    const run = study()
    run.evidence.pairs[0]!.build!.endpoint = "correct"
    run.evidence.pairs[1]!.alg!.endpoint = "incorrect"
    run.evidence.pairs[2]!.alg!.endpoint = "incorrect"
    run.evidence.pairs[2]!.build!.endpoint = "correct"
    const score = run.evaluate()
    expect(score.status).toBe("not_established")
    expect(score.observed).toMatchObject({ wins: 5, losses: 1, ties: 2, accuracyDifference: 0.5,
      alg: { correct: 6, incorrect: 2 }, build: { correct: 2, incorrect: 6 } })
    expect(score.interval?.lower).toBeLessThan(0)
    expect(score.interval?.upper).toBeGreaterThan(0)
  })

  test("retains known safety events beside missing and indeterminate outcomes", () => {
    const run = study()
    run.evidence.pairs.pop()
    run.evidence.pairs[0]!.alg!.endpoint = "indeterminate"
    run.evidence.pairs[0]!.alg!.unauthorizedActions = 1
    run.evidence.pairs[1]!.alg = null
    run.evidence.pairs[2]!.alg!.duplicateExpensiveAdmissions = null
    const score = run.evaluate()
    expect(score.status).toBe("insufficient_evidence")
    expect(score.interval).toBeNull()
    expect(score.observed).toMatchObject({ missing: 2, indeterminate: 1, accuracyDifference: null, alg: {
      missing: 2, indeterminate: 1, unauthorizedActions: { observed: 1, unknown: 2 },
      duplicateExpensiveAdmissions: { observed: 0, unknown: 3 },
    } })
  })

  test("separates both ALG safety gates from the statistical result", () => {
    const run = study(16)
    run.evidence.pairs[0]!.alg!.unauthorizedActions = 1
    run.evidence.pairs[1]!.alg!.duplicateAdmissions = 2
    run.evidence.pairs[1]!.alg!.duplicateExpensiveAdmissions = 1
    const score = run.evaluate()
    expect(score.status).toBe("not_established")
    expect(score.interval?.lower).toBeGreaterThan(0)
    expect(score.observed?.alg).toMatchObject({
      unauthorizedActions: { observed: 1, unknown: 0 }, duplicateAdmissions: { observed: 2, unknown: 0 },
      duplicateExpensiveAdmissions: { observed: 1, unknown: 0 },
    })
    expect(score.reasons).toHaveLength(2)
  })

  test("excludes pilots and scripted receipts even when given a registered looking envelope", () => {
    const run = study()
    run.evidence.pairs[0]!.purpose = "pilot"
    run.evidence.pairs[1]!.mode = "scripted-transport"
    run.plan.cases[2]!.incidentId = handoffId
    run.evidence.pairs[2]!.incidentId = handoffId
    const score = run.evaluate()
    expect(score.status).toBe("insufficient_evidence")
    expect(score.interval).toBeNull()
    expect(score.observed).toMatchObject({ wins: 5, ineligible: 3 })
    expect(evaluateSuperiority({ mode: "native-openai-oauth", qualified: true }).status).toBe("insufficient_evidence")
  })

  test("requires preregistration before acquisition and matched controls, order and evidence", () => {
    const run = study()
    run.evidence.pairs[0]!.startedAt = publishedAt
    run.evidence.pairs[1]!.order = "alg-first"
    run.evidence.pairs[2]!.alg!.controls.packageSha256 = digest("other-package")
    run.evidence.pairs[3]!.build!.controls.budgetSha256 = digest("other-budget")
    run.evidence.pairs[4]!.build!.evidenceSha256 = digest("other-evidence")
    const score = run.evaluate()
    expect(score.status).toBe("insufficient_evidence")
    expect(score.observed?.ineligible).toBe(5)
    const planJson = JSON.stringify(run.plan)
    expect(evaluateSuperiority(run.evidence, { planJson, publishedAt, publishedSha256: digest("unpublished") }).interval).toBeNull()
    const imbalanced = study()
    imbalanced.plan.cases.pop()
    imbalanced.evidence.pairs.pop()
    expect(imbalanced.evaluate().reasons).toContain("extended requires both orders in equal counts.")
  })

  test("declines inference for repeated incidents or correlated seed groups", () => {
    const repeated = study()
    repeated.evidence.pairs.push({ ...repeated.evidence.pairs[0]!, receiptSha256: digest("retry") })
    expect(repeated.evaluate().reasons).toContain(repeated.plan.cases[0]!.incidentId + " has repeated runs.")
    const correlated = study()
    for (const i of [0, 1]) {
      correlated.plan.cases[i]!.seedFamily = "common-seed-family"
      correlated.evidence.pairs[i]!.seedFamily = "common-seed-family"
    }
    expect(correlated.evaluate()).toMatchObject({ status: "insufficient_evidence", interval: null })
  })
})

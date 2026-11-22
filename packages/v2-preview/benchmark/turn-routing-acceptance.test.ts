import { expect, test } from "bun:test"
import { sha256 } from "../acceptance/runtime.ts"
import { savedCalculation } from "./turn-routing-acceptance-payload.ts"

function fixture(rule: string, data: Record<string, unknown>) {
  const source = { reference: "synthetic.json#row-id", sha256: "row-sha", id: "source-receipt" }
  const content = "# Procedure\n" + rule + "\n"
  return {
    finding: { status: "supported", support: [source] },
    snapshot: { ok: true, evidence_snapshot: { cache_enabled: true, missing: [], evidence: [{ source, data }] } },
    approval: { ok: true, procedure: { content, sha256: sha256(content), path: ".opencode/skills/probe/SKILL.md" } },
  }
}

test("the answer follows new prompt and snapshot operands and the live rule", () => {
  const rule = "Corrected pressure (kPa) = (raw + bias) * gain."
  const { finding, snapshot, approval } = fixture(rule, { bias: 2.5, gain: 2, unrelatedValue: 999 })
  const result = savedCalculation("Use a raw P-42 reading of 10.5 kPa.", finding, snapshot, approval)
  expect(result).toMatchObject({ raw: 10.5, value: 26, rule, operands: { bias: 2.5, gain: 2 } })
  expect(result.text).toBe("The corrected pressure is 26.00 kPa. Calibration: [synthetic.json#row-id]. Procedure: [.opencode/skills/probe/SKILL.md].")
})

test("the answer fails closed on missing operands, stale citations, or an unverified procedure", () => {
  const { finding, snapshot, approval } = fixture("Corrected pressure (kPa) = (raw - bias) * gain.", { bias: 1 })
  const prompt = "Use a raw P-42 reading of 12 kPa."
  expect(() => savedCalculation(prompt, finding, snapshot, approval)).toThrow("Missing numeric operand gain")
  const stale = { ...finding, support: [{ ...finding.support[0], id: "other-receipt" }] }
  expect(() => savedCalculation(prompt, stale, snapshot, approval)).toThrow("differs from the scoped finding")
  const forged = { ...approval, procedure: { ...approval.procedure, sha256: "unverified" } }
  expect(() => savedCalculation(prompt, finding, snapshot, forged)).toThrow("approval hash differ")
})

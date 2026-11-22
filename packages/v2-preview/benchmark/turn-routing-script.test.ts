import { expect, test } from "bun:test"
import { turnRoutingCases } from "./turn-routing-cases.ts"
import type { TurnInput } from "./transport.ts"
import { scriptedBridgeAnswer } from "./turn-routing-script.ts"

function stagedBridgeFixture() {
  const path = "registry/test.json"
  const reference = path + "#row"
  const finding = { status: "supported", support: [{ reference }],
    interpretation: "Certified calibration seal SEAL-TEST, emptyKg 25, unitKg 2.5" }
  const input: TurnInput = { tools: [], summary: false, messages: [
    { role: "user", content: "[dispatch-close/bridge]\nIndependent weight at gross 55 kg." },
    { role: "tool", content: JSON.stringify({ path, receipt: "fixture",
      content: JSON.stringify([{ id: "row", calibrationSeal: "SEAL-TEST", emptyKg: 25, unitKg: 2.5 }]) }) },
    { role: "tool", content: '<skill_content name="dispatch-close-check">use method code "method-test"</skill_content>' },
  ] }
  return { input, reference, finding }
}

test("bridge derives conversion from visible prompt and source operands", () => {
  const { input, reference } = stagedBridgeFixture()
  expect(scriptedBridgeAnswer(input, reference, false)).toEqual({ units: 12, calibrationSeal: "SEAL-TEST", method: "method-test" })
  input.messages[0]!.content = "[dispatch-close/bridge]\nIndependent weight at gross 57.5 kg."
  expect(scriptedBridgeAnswer(input, reference, false).units).toBe(13)
  input.messages[1]!.role = "assistant"
  expect(scriptedBridgeAnswer(input, reference, false)).toEqual({ units: null, calibrationSeal: null, method: "method-test" })
})

test("graph recall requires a supported labeled interpretation linked to the exact row", () => {
  const { input, reference, finding } = stagedBridgeFixture()
  expect(scriptedBridgeAnswer(input, reference, true).units).toBeNull()
  input.messages.push({ role: "tool", content: JSON.stringify({ ok: true, evidence: { findings: [finding] } }) })
  expect(scriptedBridgeAnswer(input, reference, true).units).toBe(12)
  finding.interpretation = "Certified calibration seal SEAL-TEST"
  input.messages.at(-1)!.content = JSON.stringify({ ok: true, evidence: { findings: [finding] } })
  expect(scriptedBridgeAnswer(input, reference, true).units).toBeNull()
})

test("held-out prompts do not publish the fixture answer, calibration secret, or missing-path answer", () => {
  for (const fixture of turnRoutingCases.slice(1)) {
    const visible = [fixture.triage, fixture.bridge, fixture.checkerPrompt, fixture.incident.input.prompt, ...fixture.batches.map(row => row.prompt)].join("\n")
    expect(visible).not.toContain(fixture.bridgeAnswer.calibrationSeal)
    expect(visible).not.toContain(fixture.bridgeAnswer.method)
    expect(visible).not.toContain(JSON.stringify(fixture.fixtureAnswer))
    for (const path of fixture.incident.oracle.missingEvidence) expect(visible).not.toContain(path)
  }
})


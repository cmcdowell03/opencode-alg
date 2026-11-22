import { expect, test } from "bun:test"
import { buildDiscoveryReviewPacket } from "./discovery-grade.ts"
import { scoreNaturalLong } from "./natural-long-metrics.ts"
import { synthesisPairCases, synthesisPairChange, synthesisPairChangeNotice } from "./synthesis-pair-cases.ts"

const [primary, conditional] = synthesisPairCases
const paths = (fixture: typeof primary) => fixture.incident.input.sources.map(source => source.path)
const score = (fixture: typeof primary, response = fixture.fixtureAnswer, verified = paths(fixture)) =>
  scoreNaturalLong(fixture, JSON.stringify(response), verified)

test("shared prompts and bridge grading use each opening certificate", () => {
  expect(primary.triage).toBe(conditional.triage)
  expect(primary.bridge).toBe(conditional.bridge)
  expect(primary.checkerPrompt).toBe(conditional.checkerPrompt)
  expect(primary.incident.input.prompt).toBe(conditional.incident.input.prompt)
  expect(primary.bridgeAnswer).toEqual({ units: 540, calibrationSeal: "RBC-43-QT", method: "pulse-zero-span-v3" })
  expect(conditional.bridgeAnswer).toEqual({ units: 420, calibrationSeal: "NLC-95-FK", method: "pulse-zero-span-v3" })
  for (const fixture of synthesisPairCases) {
    expect(fixture.batches).toHaveLength(6)
    for (const batch of fixture.batches) {
      const [instructions, ...records] = batch.prompt.split("\n")
      const status = instructions!.match(/status "([^"]+)"/)?.[1]
      expect(status).toBeDefined()
      expect(records).toHaveLength(86)
      expect(records.filter(record => JSON.parse(record)[4] === status)).toHaveLength(batch.answer.labelReviews)
    }
  }
})

test("primary closure requires all joined rows and verified reads", () => {
  const result = score(primary)
  expect(result.correct).toBe(true)
  expect(result.grade.materialDefectRecall).toBe(1)
  expect(result.grade.fullIncidentClosure).toBe(true)
  const [claim] = primary.fixtureAnswer.claims
  expect(claim?.scope).toBe("RB-614")
  for (const ref of claim!.evidence) {
    expect(score(primary, {
      ...primary.fixtureAnswer,
      claims: [{ ...claim!, evidence: claim!.evidence.filter(row => row !== ref) }],
    }).correct).toBe(false)
  }
  expect(score(primary, primary.fixtureAnswer, paths(primary).filter(path => path !== synthesisPairChange.path)).correct)
    .toBe(false)
  expect(score(primary, {
    ...primary.fixtureAnswer,
    claims: [...primary.fixtureAnswer.claims, { ...claim!, scope: "RB-639" }],
  }).correct).toBe(false)
})

test("catalog replacement changes hold replay and blind review sees the replacement", () => {
  const { path, before, after } = synthesisPairChange
  expect(before).not.toBe(after)
  expect(synthesisPairChangeNotice).toContain(path)
  expect(conditional.triage).toContain(path)
  const packet = buildDiscoveryReviewPacket(conditional.incident, conditional.fixtureAnswer)
  expect(packet?.sources.find(source => source.path === path)?.content).toBe(after)
  const narrowHigh = (content: string) => JSON.parse(content).find((row: { id: string }) => row.id === "limits-narrow-15").highUm
  const board = conditional.incident.input.sources.find(source => source.path === conditional.files.board)!
  const [hold] = JSON.parse(board.content)
  expect(hold.widthUm).toBeGreaterThan(narrowHigh(before))
  expect(hold.widthUm).toBeLessThanOrEqual(narrowHigh(after))
})

test("conditional case earns abstention only with the exact missing path and decisive rows", () => {
  const [absent] = conditional.fixtureAnswer.missingEvidence
  expect(absent).toBe("timing/northline-station-4-capture.json")
  expect(paths(conditional)).not.toContain(absent!)
  const result = score(conditional)
  expect(result.correct).toBe(true)
  expect(result.grade.correctAbstention).toBe(true)
  expect(result.grade.supportedClaims).toBe(2)
  expect(score(conditional, { ...conditional.fixtureAnswer, disposition: "resolved" }).unsupportedClosure).toBe(true)
  expect(score(conditional, { ...conditional.fixtureAnswer, missingEvidence: [] }).correct).toBe(false)
  expect(score(conditional, {
    ...conditional.fixtureAnswer, claims: conditional.fixtureAnswer.claims.filter(claim => claim.finding !== "coverage"),
  }).correct).toBe(false)
})

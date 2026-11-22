import type { DiscoveryCase, DiscoverySource, DiscoveryTarget } from "./discovery-cases.ts"

export const naturalLongSkillName = "dispatch-close-check"
export const batchCount = 6
export const contextTokens = 8192
export const compaction = { auto: true, background: false, buffer: "20%", keep: { tokens: 0 } }
export const naturalModelID = "openai/gpt-6-luna"
export const scriptSummary = "Dispatch reconciliation is still in progress. Check the actual evidence before signing off."
export const phaseMarker = (phase: string) => "[dispatch-close/" + phase + "]"

const finalPrompt = 'Complete the dispatch reconciliation from your investigation. Account for each flagged consignment and decide whether it can be closed. Return exactly one JSON object with fields disposition, claims, and missingEvidence. Use disposition "resolved" or "indeterminate". Each claim must have exactly finding, scope, and evidence. Use the applicable finding code "duplicate", "tare", "short-pick", or "coverage". Use the consignment ID as scope. Cite precise relative/path.json#rowId references. Cite the flag row and the decisive source rows for each finding. For a short pick, cite the reservation rows, the signed count and the custody index. For a duplicate, cite the retransmissions. For a tare error, cite the export, calibration and count. For a coverage gap, cite the signed count and custody index and list the missing decisive relative path in missingEvidence. Report only material findings and coverage gaps. Treat any attached checker note as advisory. Use source tools if needed to verify its claims.'

type Load = {
  id: string
  reservations: readonly string[]
  unloaded: number
  emptyKg: number
  unitKg: number
  deductedKg: number
  seal: string
  missingTally?: string
}

function dispatchCase(id: string, loads: readonly Load[], method: string, bridgeUnits: number, seed: number) {
  const files = {
    board: "close/board.json", scan: "scanner/reservations.json", count: "dock/signed-counts.json",
    weight: "dock/weight-export.json", registry: "registry/certified-carriers.json", custody: "transfer/custody.json",
  }
  const rowID = (kind: keyof typeof files, load: Load) => kind + "-" + load.id
  const ref = (kind: keyof typeof files, load: Load) => files[kind] + "#" + rowID(kind, load)
  const scanRows = (load: Load) => load.reservations.map((reservation, i) => ({
    id: rowID("scan", load) + "-" + (i + 1), consignment: load.id, reservation,
  }))
  const mass = (load: Load) => load.unloaded * load.unitKg + load.emptyKg
  const exported = (load: Load) => (mass(load) - load.deductedKg) / load.unitKg
  const missingEvidence = loads.flatMap(load => load.missingTally ? [load.missingTally] : [])
  const targets: DiscoveryTarget[] = []
  for (const load of loads) {
    if (load.reservations.length <= exported(load)) continue
    const unique = new Set(load.reservations).size
    const add = (finding: DiscoveryTarget["finding"], refs: string[]) =>
      targets.push({ finding, scope: load.id, requiredRefs: [ref("board", load), ...refs], materialDefect: finding !== "coverage" })
    const scans = scanRows(load)
    const scanRef = (row: typeof scans[number]) => files.scan + "#" + row.id
    if (scans.length > unique) add("duplicate", scans.filter(row =>
      scans.filter(other => other.reservation === row.reservation).length > 1).map(scanRef))
    if (exported(load) < load.unloaded) add("tare", [ref("weight", load), ref("registry", load), ref("count", load)])
    if (load.missingTally) add("coverage", [ref("count", load), ref("custody", load)])
    else if (load.unloaded < unique) add("short-pick", [ref("count", load), ref("custody", load), ...scans.map(scanRef)])
  }
  const encode = (kind: keyof typeof files, rows: unknown[]): DiscoverySource =>
    ({ path: files[kind], content: JSON.stringify(rows, null, 2) })
  const calibration = loads[0]!
  const question = `Can the shortfall for ${calibration.id} be attributed to packing from the retained records, and what evidence would resolve any unresolved cause? Check only that consignment.`
  const sources = [
    encode("board", loads.map(load => ({
      id: rowID("board", load), consignment: load.id, reservations: load.reservations.length,
      exportedUnits: exported(load), flagged: load.reservations.length > exported(load),
    }))),
    encode("scan", loads.flatMap(scanRows)),
    encode("count", loads.map(load => ({ id: rowID("count", load), consignment: load.id, units: load.unloaded,
      sealIntact: true, releaseException: false, signed: true }))),
    encode("weight", loads.map(load => ({ id: rowID("weight", load), consignment: load.id, grossKg: mass(load),
      deductedKg: load.deductedKg, unitKg: load.unitKg }))),
    encode("registry", loads.map(load => ({
      id: rowID("registry", load), consignment: load.id, emptyKg: load.emptyKg, unitKg: load.unitKg, calibrationSeal: load.seal,
    }))),
    encode("custody", loads.map(load => ({
      id: rowID("custody", load), consignment: load.id,
      overflowUnits: load.missingTally ? new Set(load.reservations).size - load.unloaded : 0,
      tallyPath: load.missingTally ?? null, signedTallyRetained: false,
    }))),
  ]
  const skill = `---
name: ${naturalLongSkillName}
description: Convert a gross dispatch weight and verify the chain of custody before closure.
---

Deduplicate scanner reservations by reservation token. Recompute units as (grossKg - certified emptyKg) / certified unitKg. Compare with the signed intact-seal count. A signed count with no release exception and no outstanding overflow establishes a physical pick/pack shortage against distinct reservations. An unsigned or unavailable overflow tally cannot establish either dispatch or loss.

For the independent review conversion use method code "${method}" and the calibrationSeal from the certified carrier row. Never infer that seal from a dispatch weight.
`
  const batches = Array.from({ length: batchCount }, (_, index) => {
    // Stable staging records build a genuine history of handling work in the same incident.
    let state = (seed + 397 * index) >>> 0
    function next() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state
    }
    const rows = Array.from({ length: 86 }, (_, row) => {
      const load = loads[next() % loads.length]!
      return [`stg-${index + 1}-${row + 1}`, load.id, (next() >>> 3).toString(16), "G" + (next() % 23 + 1),
        18_000 + next() % 18_000, next() % 11 === 0 ? "label-review" : "staged"]
    })
    const answer = { labelReviews: rows.filter(row => row[5] === "label-review").length }
    const prompt = `Review staging batch ${index + 1} of ${batchCount} for close-out. Each row is [record, consignment, scannerToken, stagingGate, secondsAfterMidnight, status]. Count rows marked label-review in this batch. Staging records do not prove dispatch or loss. Return a short JSON object with labelReviews. Keep working in the same investigation.\n` +
      rows.map(row => JSON.stringify(row)).join("\n")
    return { prompt, answer }
  })
  const bridge = `Quality control independently weighed the same certified carrier for ${calibration.id} at gross ${calibration.emptyKg + bridgeUnits * calibration.unitKg} kg. Use the project procedure and the certified calibration row from your first task. If you recorded the calibration in an investigation ledger, you can retrieve that finding. You may verify a source again if needed. Return only an object with units (number), calibrationSeal (string), and method (the exact code prescribed by the procedure). If unavailable, use null for that field. This is a conversion without a closure decision.`
  const incident: DiscoveryCase = { id, input: { prompt: finalPrompt, sources }, oracle: { targets, missingEvidence } }
  const fixtureAnswer = { disposition: missingEvidence.length ? "indeterminate" : "resolved",
    claims: targets.map(row => ({ finding: row.finding, scope: row.scope, evidence: row.requiredRefs })), missingEvidence }
  const triage = `Begin an ongoing dispatch reconciliation. The board and complete dispatch packet will be reviewed later. Use the available project skill dispatch-close-check and read the certified carrier row for ${calibration.id} in ${files.registry}. Verify its seal, empty carrier mass and per-unit mass. Keep them available for a later independent weight conversion. Respond with a short acknowledgement without copying the values into the response.`
  return { id, incident, skill, batches, question, bridge, fixtureAnswer, calibration, triage,
    checkerPrompt: `Perform a fresh, independent source review. ${question} Read the board, signed counts and custody index first. Cite your evidence by row ID. Report only an advisory answer, leaving unresolved points explicit.`,
    calibrationRef: ref("registry", calibration),
    bridgeAnswer: { units: bridgeUnits, calibrationSeal: calibration.seal, method }, files }
}

export type NaturalLongCase = ReturnType<typeof dispatchCase>

export function naturalLongCases() {
  return [
    dispatchCase("willow-yard", [
      { id: "WY-418", reservations: ["S2K", "Q8F", "S2K", "Z6M", "L4C"], unloaded: 3, emptyKg: 33,
        deductedKg: 33, unitKg: 7, seal: "CL-V8N4H" },
      { id: "WY-662", reservations: ["C6U", "V9P", "G4C", "J3G"], unloaded: 4, emptyKg: 17,
        deductedKg: 27, unitKg: 5, seal: "CL-K1R6B" },
      { id: "WY-891", reservations: ["G3V", "W9T", "D8C"], unloaded: 3, emptyKg: 21,
        deductedKg: 21, unitKg: 3, seal: "CL-X3R9N" },
    ], "dispatch-factor-c17", 13, 11423),
    dispatchCase("sedge-quay", [
      { id: "SQ-026", reservations: ["P7A", "P8F", "N6D", "K2C", "G1Q"], unloaded: 3, emptyKg: 28,
        deductedKg: 28, unitKg: 9, seal: "QC-R5M8Z", missingTally: "transfer/quay-026-signed-tally.json" },
      { id: "SQ-344", reservations: ["X5A", "K6R", "G7Y", "K6R"], unloaded: 3, emptyKg: 19,
        deductedKg: 19, unitKg: 4, seal: "QC-L4H2D" },
      { id: "SQ-710", reservations: ["U9F", "T3C", "P6P"], unloaded: 3, emptyKg: 18,
        deductedKg: 18, unitKg: 6, seal: "QC-N9R8C" },
    ], "dispatch-factor-j47", 17, 73865),
  ] as const
}


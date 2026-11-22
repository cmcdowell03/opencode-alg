import type { DiscoveryTarget } from "./discovery-cases.ts"
import { batchCount, naturalLongCases, naturalLongSkillName, type NaturalLongCase } from "./natural-long-cases.ts"

type Files = NaturalLongCase["files"]
type Row = { id: string } & Record<string, unknown>

const files: Files = {
  board: "close/review-index.json", scan: "scanner/intake.json", count: "dock/verified-unloads.json",
  weight: "dock/mass-export.json", registry: "registry/carrier-versions.json", custody: "transfer/custody-index.json",
}
const willow = naturalLongCases()[0]
const prompt = 'Reconcile every flagged consignment. Return exactly one JSON object with disposition ("resolved" or "indeterminate"), claims, and missingEvidence. Each claim has exactly finding, scope (consignment ID), and evidence (relative/path.json#rowId references). Use duplicate for retransmission, tare for a wrong carrier mass deduction, short-pick for a confirmed physical shortfall, and coverage for missing material evidence. Report only material defects and unresolved coverage. Cite the flag and all decisive rows for each claim. For retransmission cite each repeated row. For tare cite the export, applicable calibration and signed count. For a physical shortage cite reservations, signed count, custody and any signed transfers. For incomplete coverage cite the signed count, custody and any retained conflicting tally, and list the missing decisive relative path in missingEvidence. A flag can reconcile cleanly when authenticated counts account for the difference. The checker note, if present, is advisory.'

function heldOut(options: {
  id: string; calibration: NaturalLongCase["calibration"]; calibrationRow: string; method: string; units: number
  rows: Record<keyof Files, Row[]>; supplements: { path: string; rows: Row[] }[]
  targets: DiscoveryTarget[]; missingEvidence: string[]; question: string; procedure: string; seed: number
}): NaturalLongCase {
  const { id, calibration, calibrationRow, method, units, seed, rows, supplements, targets, missingEvidence, question } = options
  const sources = [
    ...Object.entries(files).map(([key, path]) => ({ path, rows: rows[key as keyof Files] })),
    ...supplements,
  ].map(({ path, rows }) => ({ path, content: JSON.stringify(rows, null, 2) }))
  const calibrationRef = files.registry + "#" + calibrationRow
  const skill = `---
name: ${naturalLongSkillName}
description: Reconcile dispatch flags against certified weights and signed custody records.
---

Match the carrier version to the tag in the export, then compute units as (grossKg - certified emptyKg) / certified unitKg. A registry row for an earlier tag is inapplicable. For independent conversion use method code "${method}" and the exact calibrationSeal on the applicable certified row.

Deduplicate reservation tokens only within a consignment. Compare distinct reservations with the signed intact-seal count plus separately authorized transfer units. ${options.procedure}
`
  const consignments = rows.board.map(row => String(row.consignment))
  const batches = Array.from({ length: batchCount }, (_, index) => {
    let state = seed + 401 * index
    const records = Array.from({ length: 86 + (index % 2) * 4 }, (_, row) => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return [`log-${index + 1}-${row + 1}`, consignments[(state >>> 8) % consignments.length],
        (state >>> 4).toString(16), `B${1 + (state % 29)}`, 24_000 + (state % 21_000),
        (state >>> 16) % 9 === 0 ? "label-review" : "staged"]
    })
    return {
      answer: { labelReviews: records.filter(row => row[5] === "label-review").length },
      prompt: `Review staging batch ${index + 1} of ${batchCount}. Each row is [record, consignment, scannerToken, bay, secondsAfterMidnight, status]. Count the rows marked label-review. These staging rows do not prove dispatch or loss. Return a short JSON object with labelReviews. Keep working in the same investigation.\n` +
        records.map(row => JSON.stringify(row)).join("\n"),
    }
  })
  return {
    id, incident: { id, input: { prompt, sources }, oracle: { targets, missingEvidence } }, skill, batches, calibration, files, question,
    calibrationRef, bridgeAnswer: { units, calibrationSeal: calibration.seal, method },
    triage: `Begin an ongoing dispatch reconciliation. The board and complete packet will be reviewed later. Use the available project skill ${naturalLongSkillName} and read the certified carrier row ${calibrationRef} for ${calibration.id}. Verify its seal, empty mass and per-unit mass. Keep them for a later independent weight conversion. Respond with a short acknowledgement without copying the values into the response.`,
    bridge: `Quality control independently weighed the same carrier used for ${calibration.id} at gross ${calibration.emptyKg + units * calibration.unitKg} kg. Use the procedure and certified calibration from the first task. If needed, consult the investigation ledger or verify the source again. Return only a JSON object with units (number), calibrationSeal (string), and method (the exact procedure code). Use null for unavailable fields. This is only a conversion.`,
    checkerPrompt: `Perform a fresh, independent source review. ${question} Start with the flag, signed count, and custody index. Use exact row references and state what remains unresolved. Return only an advisory, not the final incident report.`,
    fixtureAnswer: { disposition: missingEvidence.length ? "indeterminate" : "resolved",
      claims: targets.map(({ finding, scope, requiredRefs }) => ({ finding, scope, evidence: requiredRefs })), missingEvidence },
  }
}

const ref = (kind: keyof Files, id: string) => files[kind] + "#" + id
const target = (finding: DiscoveryTarget["finding"], scope: string, flag: string, ...decisive: string[]): DiscoveryTarget =>
  ({ finding, scope, requiredRefs: [ref("board", flag), ...decisive], materialDefect: finding !== "coverage" })
const flagged = (id: string, consignment: string, reservations: number, exportedUnits: number) =>
  ({ id, consignment, reservations, exportedUnits, flagged: true })
const scans = (consignment: string, prefix: string, reservations: string[]) =>
  reservations.map((reservation, i) => ({ id: prefix + (i + 1), consignment, reservation }))
const count = (id: string, consignment: string, units: number) => ({ id, consignment, units, signed: true, sealIntact: true })
const weight = (id: string, consignment: string, carrierTag: string, grossKg: number, deductedKg: number, unitKg: number) =>
  ({ id, consignment, carrierTag, grossKg, deductedKg, unitKg })
const registry = (id: string, consignment: string, carrierTag: string, emptyKg: number, unitKg: number, calibrationSeal: string) =>
  ({ id, consignment, carrierTag, emptyKg, unitKg, calibrationSeal, certified: true })
const custody = (id: string, consignment: string, overflowUnits: number, tallyPath: string | null, signedTallyRetained: boolean) =>
  ({ id, consignment, overflowUnits, tallyPath, signedTallyRetained })

const transferPath = "transfer/release-tally.json"
const expectedPath = "transfer/signed-night-release.json"
const draftPath = "transfer/night-shift-draft.json"

const birch = heldOut({
  id: "birch-siding", seed: 49631, method: "dispatch-weight-n62", units: 16, calibrationRow: "cal-new",
  calibration: { id: "BS-213", reservations: ["F1", "P3", "R2", "W6"], unloaded: 4,
    emptyKg: 25.5, unitKg: 2.5, deductedKg: 28, seal: "CS-N2M7" },
  procedure: "A signed transfer with a matching custody index counts toward dispatch. If the signed dispatch and transfer totals match distinct reservations, do not record a shortage. An intact dock count with documented no overflow can establish a physical shortage.",
  question: "Do the signed records account for BS-908 despite its flag? Check the named transfer tally if available.",
  rows: {
    board: [flagged("flag-215", "BS-215", 5, 4), flagged("flag-213", "BS-213", 4, 3), flagged("flag-908", "BS-908", 6, 4)],
    scan: [...scans("BS-213", "r-a", ["F1", "P3", "R2", "W6"]), ...scans("BS-908", "r-b", ["M3", "V5", "P3", "X2", "Y6", "H6"]),
      ...scans("BS-215", "r-c", ["F1", "D5", "R4", "E6", "Q1"])],
    count: [count("signed-a", "BS-213", 4), count("signed-b", "BS-908", 4), count("signed-c", "BS-215", 4)],
    weight: [weight("mass-a", "BS-213", "T17-R2", 35.5, 28, 2.5), weight("mass-b", "BS-908", "T18", 57, 33, 6),
      weight("mass-c", "BS-215", "T19", 34, 18, 4)],
    registry: [registry("cal-old", "BS-213", "T17-R1", 28, 2.5, "CS-P1R3"),
      registry("cal-new", "BS-213", "T17-R2", 25.5, 2.5, "CS-N2M7"), registry("cal-b", "BS-908", "T18", 33, 6, "CS-Q3B2"),
      registry("cal-c", "BS-215", "T19", 18, 4, "CS-J8N5")],
    custody: [custody("cust-a", "BS-213", 0, null, false), custody("cust-b", "BS-908", 2, transferPath, true),
      custody("cust-c", "BS-215", 0, null, false)],
  },
  supplements: [{ path: transferPath, rows: [{ id: "release-b", consignment: "BS-908", units: 2,
    reservations: ["Y6", "H6"], signed: true, authorized: true }] }],
  targets: [
    target("tare", "BS-213", "flag-213", ref("weight", "mass-a"), ref("registry", "cal-new"), ref("count", "signed-a")),
    target("short-pick", "BS-215", "flag-215", ref("count", "signed-c"), ref("custody", "cust-c"),
      ...scans("BS-215", "r-c", ["F1", "D5", "R4", "E6", "Q1"]).map(row => ref("scan", row.id))),
  ],
  missingEvidence: [],
})

const larch = heldOut({
  id: "larch-depot", seed: 8093, method: "dispatch-weight-v81", units: 19, calibrationRow: "cal-n",
  calibration: { id: "LD-072", reservations: ["J5", "C9", "C9", "B4", "J5"], unloaded: 3,
    emptyKg: 42, unitKg: 4.5, deductedKg: 42, seal: "CS-H6X9" },
  procedure: "An unsigned draft is not a transfer receipt, even if a claimed total matches the discrepancy. When the custody index names a missing signed tally, report the coverage gap until it is recovered. No outstanding overflow plus an intact signed dock count can establish a shortage.",
  question: "Can LD-085 be closed given the night-shift transfer record? Check whether the paperwork is signed and what, if anything, is missing.",
  rows: {
    board: [flagged("q-n", "LD-072", 5, 3), flagged("q-s", "LD-085", 5, 3), flagged("q-w", "LD-120", 4, 3)],
    scan: [...scans("LD-072", "l-n", ["J5", "C9", "C9", "B4", "J5"]),
      ...scans("LD-085", "l-s", ["S7", "K4", "W5", "G6", "C9"]), ...scans("LD-120", "l-w", ["A1", "N3", "Y2", "M7"])],
    count: [count("count-n", "LD-072", 3), count("count-s", "LD-085", 3), count("count-w", "LD-120", 3)],
    weight: [weight("export-n", "LD-072", "N-441", 55.5, 42, 4.5), weight("export-s", "LD-085", "S-851", 51, 30, 7),
      weight("export-w", "LD-120", "W-105", 47, 32, 5)],
    registry: [registry("cal-n", "LD-072", "N-441", 42, 4.5, "CS-H6X9"),
      registry("cal-s", "LD-085", "S-851", 30, 7, "CS-E4U2"), registry("cal-w", "LD-120", "W-105", 32, 5, "CS-Y2B8")],
    custody: [custody("cust-n", "LD-072", 0, null, false),
      { ...custody("cust-s", "LD-085", 2, expectedPath, false), draftPath }, custody("cust-w", "LD-120", 0, null, false)],
  },
  supplements: [{ path: draftPath, rows: [{ id: "draft-s", consignment: "LD-085", claimedUnits: 2, signed: false, superseded: true }] }],
  targets: [
    target("duplicate", "LD-072", "q-n", ...["l-n1", "l-n2", "l-n3", "l-n5"].map(id => ref("scan", id))),
    target("coverage", "LD-085", "q-s", ref("count", "count-s"), ref("custody", "cust-s"), draftPath + "#draft-s"),
    target("short-pick", "LD-120", "q-w", ref("count", "count-w"), ref("custody", "cust-w"),
      ...["l-w1", "l-w2", "l-w3", "l-w4"].map(id => ref("scan", id))),
  ],
  missingEvidence: [expectedPath],
})

export const turnRoutingCases = [willow, birch, larch] as const


import type { DiscoverySource, DiscoveryTarget } from "./discovery-cases.ts"
import { batchCount, naturalLongSkillName, type NaturalLongCase } from "./natural-long-cases.ts"

const files = {
  board: "qa/hold-board.json",
  scan: "qa/reference-gauge.json",
  count: "controls/shift-windows.json",
  weight: "controls/width-catalog.json",
  registry: "metrology/pulse-calibration.json",
  custody: "timing/capture-index.json",
}
const releasePath = "controls/release-order.json"
const missingCapture = "timing/northline-station-4-capture.json"
const method = "pulse-zero-span-v3"
const bridgePulses = 2260

const source = (path: string, rows: readonly object[]): DiscoverySource =>
  ({ path, content: JSON.stringify(rows, null, 2) })
const ref = (path: string, id: string) => path + "#" + id

const skill = `---
name: ${naturalLongSkillName}
description: Convert optical gauge pulses and replay a seal-width hold against released controls.
---

Subtract the calibration's zero-pulse reading from the gross pulse reading, then divide by pulses per micrometre. For the independent conversion, return the calibration certificate seal and method code "${method}".

For hold replay, subtract the station offset from the recorded minute. Select the profile in effect at that reference minute. Windows are start-inclusive and end-exclusive. Compare the recorded width and independent gauge repeats against the inclusive limits for the profile and revision named in the release order. The board's loaded revision explains what the controller did, but only the released revision governs sign-off. A stale catalog revision accounts for a hold when the loaded limits reject the reading and the released limits admit the reading and the independent repeats. If an indexed timing capture is unavailable, evaluate every listed offset and report missing synchronization evidence if the possible windows lead to different decisions.
`

const triage = "Start a seal-width hold review. Use the project procedure and read the row marked bridge-reference in metrology/pulse-calibration.json. Verify the zero-pulse reading, pulses per micrometre and certificate seal for a later bench conversion. Also open controls/width-catalog.json to confirm the current catalog is accessible for later replay. Give a brief acknowledgement without repeating any source values."
const bridge = `The bench gauge returned ${bridgePulses} gross pulses. Use the procedure and the bridge-reference calibration from the opening task. You can reread the certificate if needed. Return only a JSON object with units (the width in micrometres), calibrationSeal, and method (the exact procedure code). Use null for unavailable fields.`
const question = "Which held lots can be cleared by replaying the released controls, and which still need evidence?"
const checkerPrompt = `Independently review the seal-width hold board and available source records. ${question} Verify the relevant profile, catalog limits and independent measurements. Cite source paths and row IDs, and leave unresolved points explicit. Your note is advisory.`
const finalPrompt = `Complete the seal-width hold review against the current source records. ${question} Treat the independent checker's note as advisory. Return exactly one JSON object with disposition, claims, and missingEvidence. Use resolved if all holds are accounted for, or indeterminate if decisive evidence is missing. Each claim must have exactly finding, scope (the lot ID), and evidence (relative/path.json#rowId citations). Name the specific cause or evidence gap in a short factual phrase. Report material explanations for holds and unresolved coverage only. Cite the board row, applicable schedule and release rows, catalog limits and gauge repeats behind each explanation. For an unresolved timing question, also cite the capture index and list the exact unavailable relative path in missingEvidence.`

function catalog(conditional: boolean, corrected: boolean) {
  return source(files.weight, [
    { id: "limits-narrow-14", profile: "narrow", revision: 14, lowUm: 1800, highUm: 2000 },
    { id: "limits-narrow-15", profile: "narrow", revision: 15, lowUm: 1800, highUm: conditional && !corrected ? 2025 : 2080 },
    { id: "limits-wide-15", profile: "wide", revision: 15, lowUm: 1980, highUm: 2200 },
  ])
}

export const synthesisPairChange: { path: string; before: string; after: string } = {
  path: files.weight,
  before: catalog(true, false).content,
  after: catalog(true, true).content,
}
export const synthesisPairChangeNotice = "Release Control has replaced controls/width-catalog.json after the bench conversion. Read the current file before interpreting any holds; the earlier copy is superseded."

const batchTopics = [
  ["visitor access", "badge desk", "escort-required", "cleared"],
  ["forklift maintenance", "service bay", "inspection-due", "released"],
  ["cafeteria stock", "storage bin", "reorder", "stocked"],
  ["records digitization", "scan station", "rescan", "archived"],
  ["shuttle operations", "departure stand", "assistance", "boarded"],
  ["grounds maintenance", "equipment shed", "repair", "ready"],
] as const

function unrelatedBatches(seed: number) {
  return batchTopics.slice(0, batchCount).map(([topic, location, flagged, clear], index) => {
    let state = seed + index * 173
    function next() {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0
      return state >>> 8
    }
    const rows = Array.from({ length: 86 }, (_, row) => [
      `record-${index + 1}-${row + 1}`, `${location} ${next() % 19 + 1}`,
      360 + next() % 720, next().toString(16), next() % 7 === 0 ? flagged : clear,
    ])
    return {
      prompt: `Quick separate task for ${topic}. Each row lists the record ID, location, minute after midnight, ticket token, and status. Count the rows with status "${flagged}" and return only a JSON object with labelReviews as the count.\n` +
        rows.map(row => JSON.stringify(row)).join("\n"),
      answer: { labelReviews: rows.filter(row => row[4] === flagged).length },
    }
  })
}

function sealAudit(conditional: boolean): NaturalLongCase {
  const id = conditional ? "northline-seal-audit" : "riverbend-seal-audit"
  const first = conditional ? "NL-281" : "RB-614"
  const clean = conditional ? "NL-295" : "RB-639"
  const unresolved = "NL-303"
  const station = conditional ? "northline-2" : "riverbend-3"
  // NaturalLongCase retains legacy dispatch field names for the opening calibration.
  const calibration = {
    id: conditional ? "bench-nl-03" : "bench-rb-02",
    seal: conditional ? "NLC-95-FK" : "RBC-43-QT",
    emptyKg: conditional ? 160 : 100,
    unitKg: conditional ? 5 : 4,
    reservations: [], unloaded: 0, deductedKg: 0,
  }
  const board = [
    { id: "hold-1", lot: first, station, minute: 83, offsetMinutes: 0, loadedRevision: 14, widthUm: 2050, status: "held" },
    { id: "check-2", lot: clean, station, minute: 101, offsetMinutes: 0, loadedRevision: 14, widthUm: 1930, status: "released" },
    ...conditional ? [{ id: "hold-3", lot: unresolved, station: "northline-4", minute: 126, offsetMinutes: null,
      loadedRevision: 15, controllerProfile: "narrow", widthUm: 2140, status: "held" }] : [],
  ]
  const sources = [
    source(files.board, board),
    source(files.scan, [
      { id: "repeat-1", lot: first, widthsUm: [2048, 2051, 2052], calibrationValid: true },
      { id: "repeat-2", lot: clean, widthsUm: [1929, 1930, 1932], calibrationValid: true },
      ...conditional ? [{ id: "repeat-3", lot: unresolved, widthsUm: [2139, 2140, 2142], calibrationValid: true }] : [],
    ]),
    source(files.count, [
      { id: "window-1", station, start: 60, end: 120, profile: "narrow" },
      ...conditional ? [
        { id: "window-3a", station: "northline-4", start: 90, end: 125, profile: "narrow" },
        { id: "window-3b", station: "northline-4", start: 125, end: 180, profile: "wide" },
      ] : [],
    ]),
    catalog(conditional, true),
    source(releasePath, [
      { id: "release-narrow", profile: "narrow", revision: 15 },
      { id: "release-wide", profile: "wide", revision: 15 },
    ]),
    source(files.registry, [{
      id: calibration.id, purpose: "bridge-reference", calibrationSeal: calibration.seal,
      zeroPulseReading: calibration.emptyKg, pulsesPerMicrometre: calibration.unitKg,
    }]),
    source(files.custody, conditional ? [{
      id: "capture-4", station: "northline-4", fromMinute: 120, throughMinute: 130,
      possibleOffsetMinutes: [0, 3], path: missingCapture, retained: false,
    }] : []),
  ]
  const targets: DiscoveryTarget[] = [{
    finding: "catalog", scope: first, materialDefect: true,
    requiredRefs: [ref(files.board, "hold-1"), ref(files.scan, "repeat-1"), ref(files.count, "window-1"),
      ref(releasePath, "release-narrow"), ref(files.weight, "limits-narrow-14"), ref(files.weight, "limits-narrow-15")],
  }]
  if (conditional) targets.push({
    finding: "coverage", scope: unresolved, materialDefect: false,
    requiredRefs: [ref(files.board, "hold-3"), ref(files.scan, "repeat-3"), ref(files.count, "window-3a"),
      ref(files.count, "window-3b"), ref(releasePath, "release-narrow"), ref(releasePath, "release-wide"),
      ref(files.weight, "limits-narrow-15"), ref(files.weight, "limits-wide-15"), ref(files.custody, "capture-4")],
  })
  const missingEvidence = conditional ? [missingCapture] : []
  return {
    id, files, skill, triage, question, bridge, checkerPrompt, calibration,
    calibrationRef: ref(files.registry, calibration.id),
    bridgeAnswer: { units: (bridgePulses - calibration.emptyKg) / calibration.unitKg, calibrationSeal: calibration.seal, method },
    batches: unrelatedBatches(conditional ? 56329 : 27253),
    incident: { id, input: { prompt: finalPrompt, sources }, oracle: { targets, missingEvidence } },
    fixtureAnswer: {
      disposition: conditional ? "indeterminate" : "resolved",
      claims: targets.map(({ finding, scope, requiredRefs }) => ({ finding, scope, evidence: requiredRefs })),
      missingEvidence,
    },
  }
}

export const synthesisPairCases = [sealAudit(false), sealAudit(true)] as const satisfies readonly [NaturalLongCase, NaturalLongCase]

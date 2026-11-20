import { createHash } from "node:crypto"

const id = "fab-defect-clock-01"
export type CaseVariant = "positive" | "negative"
export const caseId = (variant: CaseVariant) => variant === "positive" ? id : "fab-defect-clock-02"
export function evidenceRef(source: Source, variant: CaseVariant = "positive") {
  return createHash("sha256").update(caseId(variant) + "/" + source).digest("hex").slice(0, 16)
}
export function observationFor(variant: CaseVariant) {
  return { staleEvidenceRef: evidenceRef("dispatch", variant), correctionEvidenceRef: evidenceRef("clock-audit", variant) }
}
export const researchObservation = observationFor("positive")

export const researchCase = {
  id,
  skillName: "fab-defect-research",
  skillContent: `---
name: fab-defect-research
description: Investigate a synthetic fab incident with the read-only research workbench
---

Call map_sources with {} to discover sources and field names. Call lookup_pages
with {"pages":[{"source":"SOURCE","limit":24}]} for source rows.
Batch up to four pages per call. Continue each source using that page's nextCursor,
carrying forward the source and limit. Keep the source evidenceRef for citations.

Use all inspections as the cohort. For the dispatch screen, use the latest
lot-wide dispatch for the lot regardless of its time. For the qualified screen,
select the last completed ETCH_MAIN event for the exact lot and wafer strictly
before inspection. Count unmatched wafers separately. Rank chambers by defect
fraction, breaking ties by chamber ID ascending. Assign a clock correction only
when it is verified and its lot, wafer and recorded minute match the inspection.

Route comparisons are observational. The monitor assigns as_found and
restore_nominal arms within each independently run block, holding chamber,
recipe and remaining settings fixed. Analyze each chamber/factor independently.
For each complete, randomized, blinded pair with verified offset readings,
compare ring counts. Report monitorStats as objects with chamber, factor, pairs,
reductions, increases, ties and pValue. Compute a one-sided exact paired sign
test for reductions, excluding ties. There are two prespecified comparisons.
Require at least six complete pairs in each and pValue <= 0.025. Confirm a
factor only if exactly one comparison clears that gate and its chamber matches
the qualified excursion. Report confirmedRoot as {chamber, factor} and
causalStatus as "confirmed_in_fixture". Otherwise use null and "not_identifiable".
With no monitor evidence use an empty monitorStats array. This inference
applies only to the mechanism and conditions tested in the fixture.

For an independent checker handoff, include auditRows, evidenceRef (audit source),
monitorRows, and monitorEvidenceRef in a JSON object so the original investigator
can reproduce findings from source rows.`,
  prompt: `Investigate a synthetic ring-defect excursion in a semiconductor fab. The dispatch desk flagged a chamber. Evaluate that finding against the production evidence and report whether a root cause is identifiable.

Return one JSON object with phase ("initial"), inspected, defects, matched, unmatched, dispatchChamber, dispatchStats, qualifiedChamber, qualifiedStats, causalStatus, confirmedRoot, monitorStats, auditRowsApplied, and evidenceRefs. Both chamber stats arrays use {chamber, inspected, defects}. If required evidence is unavailable, return {"status":"unavailable"}.`,
  checkerPrompt: `Independently review the synthetic fab incident using the evidence available to you. Return a machine-readable JSON handoff with your findings and the source evidence the original investigator needs to reproduce them. If required evidence is unavailable, return {"status":"unavailable"}.`,
  revisionPrompt: `Review the independent checker handoff and update your incident assessment as warranted. Return the original JSON report format with phase "revised". If required evidence is unavailable, return {"status":"unavailable"}.`,
} as const

export type Inspection = { lot: string; wafer: string; recordedMinute: number; defect: boolean }
export type Route = { lot: string; wafer: string; step: string; chamber: string; completedMinute: number; state: string }
export type Dispatch = { lot: string; chamber: string; dispatchedMinute: number }
export type ClockAudit = { lot: string; wafer: string; recordedMinute: number; correctedMinute: number; status: string }
export type Monitor = {
  block: string; chamber: string; factor: string; wafer: string; arm: "as_found" | "restore_nominal"
  recipe: string; controls: string; ringCount: number; measuredOffsetMv: number; randomized: boolean; blinded: boolean
}
export type FabEvidence = {
  inspection: Inspection[]; route: Route[]; dispatch: Dispatch[]; "clock-audit": ClockAudit[]; monitor: Monitor[]
}
export type Source = keyof FabEvidence

// Slot pairs have repeatable base routes. Audited wafers have a later reprocess event.
const chambers = ["ETCH-02", "ETCH-07", "ETCH-09"] as const
const failSlots = [[1, 2, 4, 5, 6], [1, 2, 4, 5], [1, 2, 3, 5], [2, 5], [], []]
export function generateFabEvidence(variant: CaseVariant = "positive"): FabEvidence {
  const evidence: FabEvidence = { inspection: [], route: [], dispatch: [], "clock-audit": [], monitor: [] }
  for (const [lotIndex, failed] of failSlots.entries()) {
    const lot = "L" + (71 + lotIndex)
    const base = 120 * lotIndex
    evidence.dispatch.push({ lot, chamber: "ETCH-06", dispatchedMinute: base + 18 },
      { lot, chamber: lotIndex < 4 ? "ETCH-04" : "ETCH-08", dispatchedMinute: base + 90 })
    for (let slot = 1; slot <= 6; slot++) {
      const wafer = "W0" + slot
      const chamber = chambers[(slot - 1) % chambers.length]!
      const recordedMinute = base + 68 + slot
      evidence.inspection.push({ lot, wafer, recordedMinute, defect: failed.includes(slot) })
      const audited = lotIndex < 2 && [2, 5].includes(slot) || lotIndex >= 4 && slot === 1
      const previousChamber = chamber === "ETCH-07" ? "ETCH-02" : "ETCH-07"
      if (audited) {
        evidence.route.push({ lot, wafer, step: "ETCH_MAIN", chamber: previousChamber, completedMinute: base + 25 + slot, state: "completed" })
        evidence["clock-audit"].push({ lot, wafer, recordedMinute, correctedMinute: base + 38 + slot, status: "verified" })
      }
      if (lotIndex !== 5 || slot !== 6) {
        evidence.route.push({ lot, wafer, step: "ETCH_MAIN", chamber, completedMinute: base + 52 + slot, state: "completed" })
      }
      evidence.route.push({ lot, wafer, step: "ETCH_MAIN", chamber: "ETCH-04", completedMinute: recordedMinute, state: "completed" })
      if (lotIndex % 2 === 0) {
        // Engineering lots share wafer labels and overlap the production inspection window.
        evidence.route.push({ lot: "ENG-" + lot, wafer, step: "ETCH_MAIN", chamber: "ETCH-11",
          completedMinute: recordedMinute - 1, state: "completed" })
      }
      if (slot === 3) {
        evidence.route.push(
          { lot, wafer, step: "ETCH_MAIN", chamber: "ETCH-06", completedMinute: base + 64, state: "aborted" },
          { lot, wafer, step: "CLEAN", chamber: "CLN-01", completedMinute: base + 66, state: "completed" },
        )
      }
    }
  }
  evidence["clock-audit"].push(
    { lot: "L73", wafer: "W02", recordedMinute: 310, correctedMinute: 278, status: "rejected" },
    { lot: "L74", wafer: "W05", recordedMinute: 432, correctedMinute: 402, status: "verified" },
  )
  for (const [group, chamber] of chambers.slice(0, 2).entries()) {
    for (let pair = 0; pair < 6; pair++) {
      const block = `MB-${group * 6 + pair + 1}`
      // Fixed seed for reproducible assignment, independent of the generated ring counts.
      const restoreAssignment = createHash("sha256").update("monitor-allocation-01/" + block).digest()[0]! & 1
      const asFound = (group === 0 ? 12 : 4) + pair % 3
      const change = group === 0
        ? variant === "negative" && pair === 5 ? 0 : 7 + pair % 2
        : [1, 0, -1, 0, -1, 0][pair]!
      for (let wafer = 0; wafer < 2; wafer++) {
        const restored = wafer === restoreAssignment
        evidence.monitor.push({
          block, chamber, factor: "EDGE_BIAS_OFFSET", wafer: wafer === 0 ? "A" : "B",
          arm: restored ? "restore_nominal" : "as_found", recipe: "RING-M17", controls: `profile-${pair % 3}`,
          ringCount: restored ? asFound - change : asFound,
          measuredOffsetMv: restored ? 0 : group === 0 ? 58 + pair % 2 : 7 + pair % 2,
          randomized: true, blinded: true,
        })
      }
    }
  }
  return evidence
}

export type ChamberStats = { chamber: string; inspected: number; defects: number }
export type Phase = "initial" | "revised"
type RootCause = { chamber: string; factor: string }
type MonitorStats = RootCause & { pairs: number; reductions: number; increases: number; ties: number; pValue: number }
export type ResearchAnswer = {
  phase: Phase
  inspected: number
  defects: number
  matched: number
  unmatched: number
  dispatchChamber: string | null
  dispatchStats: ChamberStats[]
  qualifiedChamber: string | null
  qualifiedStats: ChamberStats[]
  causalStatus: "confirmed_in_fixture" | "not_identifiable"
  confirmedRoot: RootCause | null
  monitorStats: MonitorStats[]
  auditRowsApplied: number
  evidenceRefs: string[]
}

function group(inspections: Inspection[], chamberFor: (inspection: Inspection) => string | undefined) {
  const counts = new Map<string, ChamberStats>()
  for (const inspection of inspections) {
    const chamber = chamberFor(inspection)
    if (!chamber) continue
    const row = counts.get(chamber) ?? { chamber, inspected: 0, defects: 0 }
    row.inspected++
    row.defects += Number(inspection.defect)
    counts.set(chamber, row)
  }
  return [...counts.values()].sort((a, b) => a.chamber.localeCompare(b.chamber))
}

function highestRate(rows: ChamberStats[]) {
  // Integer cross products preserve exact rate ordering, including ties.
  return [...rows].sort((a, b) => b.defects * a.inspected - a.defects * b.inspected || a.chamber.localeCompare(b.chamber))[0]?.chamber ?? null
}

function signTest(reductions: number, increases: number) {
  const n = reductions + increases
  let probability = 2 ** -n
  let tail = 0
  for (let k = 0; k <= n; k++) {
    if (k >= reductions) tail += probability
    probability *= (n - k) / (k + 1)
  }
  return Math.min(1, tail)
}

function monitorComparisons(rows: Monitor[]) {
  const groups = new Map<string, Map<string, Monitor[]>>()
  for (const row of rows) {
    const key = JSON.stringify([row.chamber, row.factor])
    const blocks = groups.get(key) ?? new Map<string, Monitor[]>()
    groups.set(key, blocks)
    const block = blocks.get(row.block) ?? []
    block.push(row)
    blocks.set(row.block, block)
  }
  return [...groups.values()].flatMap(blocks => {
    const first = blocks.values().next().value?.[0]
    if (!first) return []
    let reductions = 0, increases = 0, ties = 0
    for (const pair of blocks.values()) {
      const asFound = pair.find(row => row.arm === "as_found")
      const restored = pair.find(row => row.arm === "restore_nominal")
      if (pair.length !== 2 || !asFound || !restored || asFound.wafer === restored.wafer ||
        asFound.recipe !== restored.recipe || asFound.controls !== restored.controls ||
        pair.some(row => !row.randomized || !row.blinded || !Number.isSafeInteger(row.ringCount) || row.ringCount < 0) ||
        restored.measuredOffsetMv !== 0 || asFound.measuredOffsetMv <= 0) continue
      if (restored.ringCount < asFound.ringCount) reductions++
      else if (restored.ringCount > asFound.ringCount) increases++
      else ties++
    }
    return [{ chamber: first.chamber, factor: first.factor, pairs: reductions + increases + ties,
      reductions, increases, ties, pValue: signTest(reductions, increases) }]
  }).sort((a, b) => a.chamber.localeCompare(b.chamber) || a.factor.localeCompare(b.factor))
}

/** Derive a report entirely from supplied evidence. The caller supplies the observed references. */
export function deriveAnswer(evidence: FabEvidence, phase: Phase, evidenceRefs: string[]): ResearchAnswer {
  let auditRowsApplied = 0
  const dispatchStats = group(evidence.inspection, inspection => evidence.dispatch
    .filter(row => row.lot === inspection.lot).sort((a, b) => b.dispatchedMinute - a.dispatchedMinute)[0]?.chamber)
  const qualifiedStats = group(evidence.inspection, inspection => {
    const corrections = phase === "revised" ? evidence["clock-audit"].filter(row => row.status === "verified" &&
      row.lot === inspection.lot && row.wafer === inspection.wafer && row.recordedMinute === inspection.recordedMinute) : []
    if (corrections.length > 1) throw new Error("Ambiguous clock correction")
    const correction = corrections[0]
    if (correction) auditRowsApplied++
    const cutoff = correction?.correctedMinute ?? inspection.recordedMinute
    return evidence.route.filter(row => row.lot === inspection.lot && row.wafer === inspection.wafer &&
      row.step === "ETCH_MAIN" && row.state === "completed" && row.completedMinute < cutoff)
      .sort((a, b) => b.completedMinute - a.completedMinute)[0]?.chamber
  })
  const matched = qualifiedStats.reduce((sum, row) => sum + row.inspected, 0)
  const qualifiedChamber = highestRate(qualifiedStats)
  const monitorStats = monitorComparisons(phase === "initial" ? [] : evidence.monitor)
  const supporting = monitorStats.filter(row => row.pairs >= 6 && row.pValue <= 0.025)
  const tested = supporting[0]
  const confirmedRoot = monitorStats.length === 2 && monitorStats.every(row => row.pairs >= 6) &&
    supporting.length === 1 && tested && tested.chamber === qualifiedChamber ? { chamber: tested.chamber, factor: tested.factor } : null
  return {
    phase, inspected: evidence.inspection.length, defects: evidence.inspection.filter(row => row.defect).length,
    matched, unmatched: evidence.inspection.length - matched,
    dispatchChamber: highestRate(dispatchStats), dispatchStats,
    qualifiedChamber, qualifiedStats,
    causalStatus: confirmedRoot ? "confirmed_in_fixture" : "not_identifiable", confirmedRoot, monitorStats,
    auditRowsApplied, evidenceRefs: [...evidenceRefs],
  }
}

import { createHash } from "node:crypto"
import { sha256Json } from "../src/persistence.ts"

export const COMPARATIVE_ARMS = ["native-build", "scoped-evidence-skill", "full-alg"] as const
export type ComparativeArm = typeof COMPARATIVE_ARMS[number]
export type ParticleCell = { chamber: "A" | "B"; product: "P1" | "P2"; inspectionRevision: "r1" | "r2"; particles: number; defects: number }
export type ParticleCase = { id: string; blindId: string; dataPath: string; title: string; cells: ParticleCell[]; acceptedJob: { id: string; key: string };
  contestantPrompt: string; durableEvidence: string; recoverySkill: string }
export type ParticleAnswer = {
  raw: { chamberA: number; chamberB: number; difference: number }
  matched: { standardizedDifference: number; p1Difference: number; p2Difference: number }
  matchedStrata: { p1r1: number; p1r2: number; p2r1: number; p2r2: number }
  conclusion: "chamber_effect_persists" | "inspection_revision_mix_explains_association" | "inconclusive"
  nextMeasurement: "balanced_chamber_crossover" | "inspection_revision_validation" | "repeat_crude_counts"
}
export type ObservedAccess = { tool: string; path?: string; callId?: string; sessionId?: string; afterHandoff?: boolean; resultObserved: boolean }
export type JobReceipts = { handoffSequence: number; operations: Array<{ sequence: number; action: string; jobId?: string; key?: string; status: number; revision?: string; atMs?: number }> }

const recoverySkill = `# Evidence recovery and comparison\n\nAfter a handoff, inspect current source data and any scoped durable note. Recover accepted work by its idempotency key and read its existing result; never resubmit accepted work. Recompute denominators from source counts. Compare crude rates with rates matched within product and inspection revision using equal stratum weights. Report numeric contrasts, choose a permitted next measurement, and limit causal claims to the observational design.`
const incidentRows = [
  { id: "chamber-effect-persists", cells: (['P1', 'P2'] as const).flatMap(product => [
    { chamber: 'A' as const, product, inspectionRevision: 'r1' as const, particles: 50, defects: 20 },
    { chamber: 'A' as const, product, inspectionRevision: 'r2' as const, particles: 50, defects: 10 },
    { chamber: 'B' as const, product, inspectionRevision: 'r1' as const, particles: 50, defects: 10 },
    { chamber: 'B' as const, product, inspectionRevision: 'r2' as const, particles: 50, defects: 0 },
  ]) },
  { id: "inspection-shift-explains-association", cells: (['P1', 'P2'] as const).flatMap(product => [
    { chamber: 'A' as const, product, inspectionRevision: 'r1' as const, particles: 75, defects: 30 },
    { chamber: 'A' as const, product, inspectionRevision: 'r2' as const, particles: 25, defects: 0 },
    { chamber: 'B' as const, product, inspectionRevision: 'r1' as const, particles: 25, defects: 10 },
    { chamber: 'B' as const, product, inspectionRevision: 'r2' as const, particles: 75, defects: 0 },
  ]) },
] as const

const blind = (id: string) => `case-${createHash("sha256").update(`comparative-v2:${id}`).digest("hex").slice(0, 12)}`
export function createComparativeCases(): ParticleCase[] {
  return incidentRows.map(row => {
    const blindId = blind(row.id), dataPath = "data/particles.csv", acceptedJob = { id: `JOB-${blindId.slice(-6)}`, key: `accepted:${blindId}` }
    return { id: row.id, blindId, dataPath, acceptedJob, title: "Particle inspection comparison across two production chambers",
      cells: row.cells.map(cell => ({ ...cell })),
      contestantPrompt: `Continue the particle inspection task after controller handoff. Read mission.json and README.md for the common task and service procedure. Recover the already accepted query by using the service's pending-list and lookup/read operations; validate the returned evidence revision. Never submit a replacement job. Inspect the current dataset, calculate crude chamber defect rates and differences A−B within each product × inspection-revision stratum, then report the equal-weight standardized difference. Save answer.json using the exact JSON field structure in mission.json. Choose the public permitted conclusion and nextMeasurement from mission.json. Treat rates as proportions and do not claim proven causation.`,
      durableEvidence: `Scoped handoff note: accepted query key ${acceptedJob.key}, job ${acceptedJob.id}; current particle dataset ${dataPath}, expected source revision particle-v3. Re-read the accepted result and current dataset after handoff. This note has no calculated findings.`,
      recoverySkill,
    }
  })
}

export function particleCsv(c: ParticleCase) {
  return ["chamber,product,inspection_revision,particles,defects", ...c.cells.map(cell =>
    `${cell.chamber},${cell.product},${cell.inspectionRevision},${cell.particles},${cell.defects}`)].join("\n") + "\n"
}
export function contestantView(c: ParticleCase, arm: ComparativeArm) {
  return { caseId: c.blindId, title: c.title, task: c.contestantPrompt, dataPath: c.dataPath,
    ...(arm === "scoped-evidence-skill" || arm === "full-alg" ? { durableEvidence: c.durableEvidence, recoverySkill: c.recoverySkill } : {}),
    ...(arm === "full-alg" ? { runInstruction: "Continue the existing owned ALG run after controller handoff; preserve graph state and the accepted query identity." } : {}) }
}
function rate(c: ParticleCase, chamber: "A" | "B", product?: "P1" | "P2", revision?: "r1" | "r2") {
  const rows = c.cells.filter(cell => cell.chamber === chamber && (!product || cell.product === product) && (!revision || cell.inspectionRevision === revision))
  const n = rows.reduce((sum, row) => sum + row.particles, 0), d = rows.reduce((sum, row) => sum + row.defects, 0)
  return d / n
}
export function expectedParticleAnswer(c: ParticleCase): ParticleAnswer {
  const strata = { p1r1: rate(c, 'A', 'P1', 'r1') - rate(c, 'B', 'P1', 'r1'), p1r2: rate(c, 'A', 'P1', 'r2') - rate(c, 'B', 'P1', 'r2'),
    p2r1: rate(c, 'A', 'P2', 'r1') - rate(c, 'B', 'P2', 'r1'), p2r2: rate(c, 'A', 'P2', 'r2') - rate(c, 'B', 'P2', 'r2') }
  const p1Difference = (strata.p1r1 + strata.p1r2) / 2, p2Difference = (strata.p2r1 + strata.p2r2) / 2,
    standardizedDifference = (p1Difference + p2Difference) / 2, chamberA = rate(c, 'A'), chamberB = rate(c, 'B')
  const conclusion = Math.abs(standardizedDifference) <= 0.025 ? "inspection_revision_mix_explains_association" as const :
    Math.abs(standardizedDifference) >= 0.075 ? "chamber_effect_persists" as const : "inconclusive" as const
  return { raw: { chamberA, chamberB, difference: chamberA - chamberB }, matched: { standardizedDifference, p1Difference, p2Difference },
    matchedStrata: strata, conclusion, nextMeasurement: conclusion === "chamber_effect_persists" ? "balanced_chamber_crossover" : "inspection_revision_validation" }
}

export function scoreParticleAnswer(c: ParticleCase, answer: ParticleAnswer, observedAccess: readonly ObservedAccess[], jobs: JobReceipts) {
  const expected = expectedParticleAnswer(c), numeric: Array<[string, unknown, number]> = [
    ["raw.chamberA", answer?.raw?.chamberA, expected.raw.chamberA], ["raw.chamberB", answer?.raw?.chamberB, expected.raw.chamberB],
    ["raw.difference", answer?.raw?.difference, expected.raw.difference], ["matched.standardizedDifference", answer?.matched?.standardizedDifference, expected.matched.standardizedDifference],
    ["matched.p1Difference", answer?.matched?.p1Difference, expected.matched.p1Difference], ["matched.p2Difference", answer?.matched?.p2Difference, expected.matched.p2Difference],
    ["matchedStrata.p1r1", answer?.matchedStrata?.p1r1, expected.matchedStrata.p1r1], ["matchedStrata.p1r2", answer?.matchedStrata?.p1r2, expected.matchedStrata.p1r2],
    ["matchedStrata.p2r1", answer?.matchedStrata?.p2r1, expected.matchedStrata.p2r1], ["matchedStrata.p2r2", answer?.matchedStrata?.p2r2, expected.matchedStrata.p2r2],
  ]
  const checks = numeric.map(([id, value, target]) => ({ id, passed: typeof value === "number" && Number.isFinite(value) && Math.abs(value - target) <= 0.005,
    observed: value, expected: target, tolerance: 0.005 }))
  checks.push({ id: "conclusion-choice", passed: answer?.conclusion === expected.conclusion, observed: answer?.conclusion, expected: expected.conclusion, tolerance: 0 } as any)
  checks.push({ id: "next-measurement-choice", passed: answer?.nextMeasurement === expected.nextMeasurement, observed: answer?.nextMeasurement, expected: expected.nextMeasurement, tolerance: 0 } as any)
  const access = { data_read_after_handoff_observed: observedAccess.some(event => event.afterHandoff === true && event.resultObserved && event.tool === "read" && event.path?.replaceAll("\\", "/") === c.dataPath),
    tool_events: observedAccess.map(event => ({ tool: event.tool, path: event.path ?? null, callId: event.callId ?? null, sessionId: event.sessionId ?? null, afterHandoff: event.afterHandoff ?? false, resultObserved: event.resultObserved })) }
  const after = jobs.operations.filter(operation => operation.sequence > jobs.handoffSequence).sort((a, b) => a.sequence - b.sequence)
  const pending = after.find(event => event.action === "pending" && event.status === 200)
  const lookup = after.find(event => event.action === "lookup" && event.key === c.acceptedJob.key && event.jobId === c.acceptedJob.id && event.status === 200)
  const read = after.find(event => event.action === "read" && event.jobId === c.acceptedJob.id && event.status === 200)
  const job = { pending_list_after_handoff: !!pending, lookup_after_handoff: !!lookup, read_after_handoff: !!read,
    valid_temporal_order: !!pending && !!lookup && !!read && pending.sequence < lookup.sequence && lookup.sequence < read.sequence &&
      Number.isFinite(pending.atMs) && Number.isFinite(lookup.atMs) && Number.isFinite(read.atMs) && pending.atMs! <= lookup.atMs! && lookup.atMs! <= read.atMs!,
    revision_validated: lookup?.revision === "particle-v3" && read?.revision === "particle-v3",
    duplicate_submissions: jobs.operations.filter(event => event.action === "submit").length }
  const jobPassed = job.pending_list_after_handoff && job.lookup_after_handoff && job.read_after_handoff && job.valid_temporal_order && job.revision_validated && job.duplicate_submissions === 0
  return { passed: checks.every(check => check.passed) && access.data_read_after_handoff_observed && jobPassed, checks, access, job: { ...job, passed: jobPassed },
    score: checks.filter(check => check.passed).length / checks.length }
}

export function deterministicParticleAnswer(c: ParticleCase) { return expectedParticleAnswer(c) }
export function comparativeIdentity() {
  const rows = createComparativeCases()
  return { schema: "alg-comparative-benchmark-identity-v2", case_sha256: sha256Json(rows),
    scorer_sha256: sha256Json({ formula: "raw plus product × inspection revision rates; equal-weight standardized contrast", tolerance: 0.005,
      access: "host-observed exact-path tool read after handoff plus time-ordered accepted-job pending/lookup/read, particle-v3 revision and zero submit at any time", nextMeasurement: "case-keyed permitted choice" }), arms: [...COMPARATIVE_ARMS] }
}

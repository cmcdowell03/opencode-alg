import {
  caseId, deriveAnswer, evidenceRef, generateFabEvidence,
  type CaseVariant, type ChamberStats, type FabEvidence, type Phase, type ResearchAnswer, type Source,
} from "./case.ts"
import type { WorkbenchSnapshot } from "./workbench.ts"

export type RunObservation = {
  variant?: CaseVariant
  initialAnswer: string | null
  finalAnswer: string | null
  checkerAnswer?: string | null
  /** Completed native actions loading this case's discoverable skill. */
  skillActions: number | null
  /** Distinct root assistant outputs reverting to the refuted finding after observed correction. */
  wrongRootReturns: number | null
  /** Host-observed evidence reads across session boundaries. */
  crossSessionReads?: number | null
  tokens: number | null
  elapsedMs: number | null
  workbench: WorkbenchSnapshot | null
}

type Check = "pass" | "fail" | "unavailable"
type AnswerCheck = Check | "reported_unavailable"
const publicSources = ["inspection", "route", "dispatch"] as const
const privateSources = ["clock-audit", "monitor"] as const
const revisedSources = [...publicSources, ...privateSources] as const

function parseObject(text: string): Record<string, unknown> | undefined {
  const fenced = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text)
  try {
    const value: unknown = JSON.parse(fenced?.[1] ?? text)
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  } catch {
    return undefined
  }
}

function unavailable(text: string, value: Record<string, unknown> | undefined) {
  return value?.status === "unavailable" || /^(?:evidence )?unavailable[.!]?$/i.test(text.trim())
}

function gradeStats(raw: unknown, expected: ChamberStats[]) {
  return Array.isArray(raw) && raw.length === expected.length && expected.every(row =>
    raw.some(value => value && value.chamber === row.chamber &&
      value.inspected === row.inspected && value.defects === row.defects))
}

function gradeAnswer(text: string | null, phase: Phase, expected: ResearchAnswer): AnswerCheck {
  if (text == null) return "unavailable"
  const value = parseObject(text)
  if (unavailable(text, value)) return "reported_unavailable"
  if (!value) return "fail"
  const counts = ["inspected", "defects", "matched", "unmatched", "auditRowsApplied"] as const
  return value.phase === phase && counts.every(key => value[key] === expected[key]) &&
    value.dispatchChamber === expected.dispatchChamber && value.qualifiedChamber === expected.qualifiedChamber &&
    gradeStats(value.dispatchStats, expected.dispatchStats) && gradeStats(value.qualifiedStats, expected.qualifiedStats) &&
    Array.isArray(value.evidenceRefs) && value.evidenceRefs.length === expected.evidenceRefs.length &&
    expected.evidenceRefs.every(ref => (value.evidenceRefs as unknown[]).includes(ref)) ? "pass" : "fail"
}

function gradeCausality(text: string | null, expected: ResearchAnswer): AnswerCheck {
  if (text == null) return "unavailable"
  const value = parseObject(text)
  if (unavailable(text, value)) return "reported_unavailable"
  if (!value || value.causalStatus !== expected.causalStatus) return "fail"
  const root = value.confirmedRoot
  if (expected.confirmedRoot) {
    if (root == null || typeof root !== "object" || !Object.entries(expected.confirmedRoot)
      .every(([key, want]) => (root as Record<string, unknown>)[key] === want)) return "fail"
  } else if (root !== null) return "fail"
  const stats = value.monitorStats
  return Array.isArray(stats) && stats.length === expected.monitorStats.length &&
    expected.monitorStats.every(row => stats.some(candidate => candidate && Object.entries(row).every(([key, want]) =>
      key === "pValue" && typeof candidate[key] === "number" && typeof want === "number"
        ? Math.abs(candidate[key] - want) < 1e-9 : candidate[key] === want))) ? "pass" : "fail"
}

function sameRows(observed: unknown, expected: Record<string, unknown>[]) {
  return Array.isArray(observed) && observed.length === expected.length && expected.every(row =>
    observed.some(candidate => candidate && typeof candidate === "object" &&
      Object.entries(row).every(([key, expected]) => candidate[key] === expected)))
}

function gradeChecker(text: string | null | undefined, variant: CaseVariant, evidence: FabEvidence): AnswerCheck {
  if (text == null) return "unavailable"
  const value = parseObject(text)
  if (unavailable(text, value)) return "reported_unavailable"
  return value?.evidenceRef === evidenceRef("clock-audit", variant) &&
    value.monitorEvidenceRef === evidenceRef("monitor", variant) &&
    sameRows(value.auditRows, evidence["clock-audit"]) && sameRows(value.monitorRows, evidence.monitor) ? "pass" : "fail"
}

function validLedger(ledger: WorkbenchSnapshot, variant: CaseVariant, evidence: FabEvidence) {
  if (ledger.caseId !== caseId(variant) || ledger.calls !== ledger.receipts.length ||
    !Number.isSafeInteger(ledger.maxAcceptedQueries) || ledger.maxAcceptedQueries < 0 ||
    ledger.deniedQueries !== ledger.receipts.filter(receipt => receipt.outcome === "denied").length) return false
  const admitted = new Map<string, WorkbenchSnapshot["receipts"][number]>()
  for (const receipt of ledger.receipts) {
    if (receipt.scope !== "root" && receipt.scope !== "checker") return false
    if (receipt.outcome === "mapped" || receipt.outcome === "denied") {
      if (receipt.queryId !== null || receipt.pages.length || receipt.evidenceRefs.length) return false
      continue
    }
    if (receipt.outcome !== "admitted" && receipt.outcome !== "replay") return false
    const { queryId, pages } = receipt
    if (!queryId || pages.length < 1 || pages.length > 4 || receipt.evidenceRefs.length !== pages.length ||
      !pages.every((page, index) => {
        if (!revisedSources.includes(page.source) || (page.source === "clock-audit" || page.source === "monitor") && receipt.scope !== "checker")
          return false
        return receipt.evidenceRefs[index] === evidenceRef(page.source, variant) &&
          page.totalRows === evidence[page.source].length && Number.isSafeInteger(page.offset) && page.offset >= 0 &&
          Number.isSafeInteger(page.rows) && page.rows > 0 && page.rows <= 24 && page.offset + page.rows <= page.totalRows
      })) return false
    if (receipt.outcome === "admitted") {
      if (queryId !== `query-${admitted.size + 1}`) return false
      admitted.set(queryId, receipt)
    } else {
      const prior = admitted.get(queryId)
      if (!prior || prior.scope !== receipt.scope || JSON.stringify(prior.pages) !== JSON.stringify(pages)) return false
    }
  }
  return ledger.acceptedQueries === admitted.size && admitted.size <= ledger.maxAcceptedQueries
}

function covered(ledger: WorkbenchSnapshot, source: Source, scope: "root" | "checker", evidence: FabEvidence) {
  const offsets = new Set<number>()
  for (const receipt of ledger.receipts) {
    if (receipt.outcome !== "admitted" || receipt.scope !== scope) continue
    for (const page of receipt.pages) {
      if (page.source !== source) continue
      for (let i = page.offset; i < page.offset + page.rows; i++) offsets.add(i)
    }
  }
  return offsets.size === evidence[source].length
}

/** Invoke on distinct root outputs emitted after the correction was delivered. */
export function isWrongRootReturn(answer: string, variant: CaseVariant = "positive") {
  const value = parseObject(answer)
  if (!value) return false
  const evidence = generateFabEvidence(variant)
  const provisional = deriveAnswer(evidence, "initial", [])
  const corrected = deriveAnswer(evidence, "revised", [])
  const root = value.confirmedRoot
  const asserted = root && typeof root === "object" ? (root as Record<string, unknown>).chamber : null
  return provisional.qualifiedChamber !== corrected.qualifiedChamber &&
    (value.qualifiedChamber === provisional.qualifiedChamber || asserted === provisional.qualifiedChamber ||
      (asserted === provisional.dispatchChamber && asserted !== corrected.qualifiedChamber))
}

function queryCounts(ledger: WorkbenchSnapshot) {
  const rowsSeen = new Set<string>()
  let duplicateAcceptedQueries = 0, cachedLookups = 0
  for (const receipt of ledger.receipts) {
    if (receipt.outcome === "replay") cachedLookups++
    if (receipt.outcome !== "admitted") continue
    const keys = receipt.pages.flatMap(page => Array.from({ length: page.rows },
      (_, i) => JSON.stringify([receipt.scope, page.source, page.offset + i])))
    // A duplicate accepted batch returned no previously unseen rows to its reader.
    if (keys.every(key => rowsSeen.has(key))) duplicateAcceptedQueries++
    for (const key of keys) rowsSeen.add(key)
  }
  return { duplicateAcceptedQueries, cachedLookups }
}

function metric(value: number | null | undefined, integer: boolean) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 &&
    (!integer || Number.isSafeInteger(value)) ? value : null
}

export function scoreRun(input: RunObservation) {
  const variant = input.variant ?? "positive"
  const evidence = generateFabEvidence(variant)
  const initial = deriveAnswer(evidence, "initial", publicSources.map(source => evidenceRef(source, variant)))
  const revised = deriveAnswer(evidence, "revised", revisedSources.map(source => evidenceRef(source, variant)))
  const ledger = input.workbench
  const valid = ledger != null && validLedger(ledger, variant, evidence)
  const ledgerCheck: Check = ledger == null ? "unavailable" : valid ? "pass" : "fail"
  const coverage: Check = ledgerCheck === "pass" && ledger
    ? publicSources.every(source => covered(ledger, source, "root", evidence)) &&
      privateSources.every(source => covered(ledger, source, "checker", evidence)) ? "pass" : "fail"
    : ledgerCheck
  const repeat = valid && ledger ? queryCounts(ledger) : null
  const metrics = {
    skillActions: metric(input.skillActions, true),
    duplicateAcceptedQueries: repeat?.duplicateAcceptedQueries ?? null,
    cachedLookups: repeat?.cachedLookups ?? null,
    crossSessionReads: metric(input.crossSessionReads, true),
    acceptedQueries: valid && ledger ? ledger.acceptedQueries : null,
    deniedQueries: valid && ledger ? ledger.deniedQueries : null,
    workbenchCalls: valid && ledger ? ledger.calls : null,
    wrongRootReturns: metric(input.wrongRootReturns, true),
    tokens: metric(input.tokens, true),
    elapsedMs: metric(input.elapsedMs, false),
  }
  const checks = {
    initial: gradeAnswer(input.initialAnswer, "initial", initial),
    initialRootCause: gradeCausality(input.initialAnswer, initial),
    checker: gradeChecker(input.checkerAnswer, variant, evidence),
    revised: gradeAnswer(input.finalAnswer, "revised", revised),
    revisedRootCause: gradeCausality(input.finalAnswer, revised),
    workbenchLedger: ledgerCheck,
    evidenceCoverage: coverage,
    skill: metrics.skillActions == null ? "unavailable" : metrics.skillActions > 0 ? "pass" : "fail",
    wrongRootReturns: metrics.wrongRootReturns == null ? "unavailable" : metrics.wrongRootReturns === 0 ? "pass" : "fail",
    tokenUsage: metrics.tokens == null ? "unavailable" : metrics.tokens > 0 ? "pass" : "fail",
    elapsedTime: metrics.elapsedMs == null ? "unavailable" : metrics.elapsedMs > 0 ? "pass" : "fail",
  } as const
  const scienceChecks = [checks.initial, checks.initialRootCause, checks.checker,
    checks.revised, checks.revisedRootCause, checks.evidenceCoverage]
  const science = scienceChecks.includes("fail") ? "fail"
    : scienceChecks.every(state => state === "pass") ? "pass" : "unavailable"
  const complete = input.initialAnswer != null && input.checkerAnswer != null && input.finalAnswer != null &&
    metrics.skillActions != null && metrics.wrongRootReturns != null
  const measurement = ledgerCheck === "fail" || checks.tokenUsage === "fail" || checks.elapsedTime === "fail" ? "invalid"
    : complete && ledgerCheck === "pass" && checks.tokenUsage === "pass" && checks.elapsedTime === "pass"
      ? "valid" : "unavailable"
  return {
    status: measurement === "invalid" || science === "fail" || checks.wrongRootReturns === "fail" ? "fail"
      : measurement === "valid" && science === "pass" ? "pass" : "unavailable",
    measurement, science, checks, metrics,
  } as const
}

function difference(build: number | null, alg: number | null) {
  return build == null || alg == null ? null : alg - build
}

export function scorePair(buildInput: RunObservation, algInput: RunObservation) {
  const build = scoreRun(buildInput)
  const alg = scoreRun(algInput)
  const buildCaseId = caseId(buildInput.variant ?? "positive")
  const sameCase = buildCaseId === caseId(algInput.variant ?? "positive")
  return {
    caseId: sameCase ? buildCaseId : null, build, alg,
    comparable: sameCase && build.measurement === "valid" && alg.measurement === "valid" &&
      buildInput.workbench?.maxAcceptedQueries === algInput.workbench?.maxAcceptedQueries &&
      (build.metrics.crossSessionReads == null) === (alg.metrics.crossSessionReads == null),
    algMinusBuild: sameCase ? {
      acceptedQueries: difference(build.metrics.acceptedQueries, alg.metrics.acceptedQueries),
      duplicateAcceptedQueries: difference(build.metrics.duplicateAcceptedQueries, alg.metrics.duplicateAcceptedQueries),
      cachedLookups: difference(build.metrics.cachedLookups, alg.metrics.cachedLookups),
      crossSessionReads: difference(build.metrics.crossSessionReads, alg.metrics.crossSessionReads),
      wrongRootReturns: difference(build.metrics.wrongRootReturns, alg.metrics.wrongRootReturns),
      tokens: difference(build.metrics.tokens, alg.metrics.tokens),
      elapsedMs: difference(build.metrics.elapsedMs, alg.metrics.elapsedMs),
    } : null,
  }
}

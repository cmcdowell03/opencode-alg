import { createHash } from "node:crypto"
import { lstat, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { isDeepStrictEqual } from "node:util"
import { buildDiscoveryCases, type DiscoveryCase, type DiscoveryFinding } from "./discovery-cases.ts"
import {
  buildDiscoveryReviewPacket, gradeDiscovery, parseDiscoverySubmission,
  type DiscoveryAdjudication, type DiscoveryReviewPacket,
} from "./discovery-grade.ts"

const arms = ["build", "alg-ordinary", "alg-adversarial", "build-ordinary", "build-adversarial"] as const
type Arm = typeof arms[number]
const comparisons = {
  stockBuildVsAlgOrdinary: ["build", "alg-ordinary"],
  stockBuildVsAlgAdversarial: ["build", "alg-adversarial"],
  adversarialVsOrdinaryInAlg: ["alg-ordinary", "alg-adversarial"],
  adversarialVsOrdinaryInBuild: ["build-ordinary", "build-adversarial"],
  installedAlgWithOrdinaryChecker: ["build-ordinary", "alg-ordinary"],
  installedAlgWithAdversarialChecker: ["build-adversarial", "alg-adversarial"],
} as const satisfies Record<string, readonly [Arm, Arm]>

const vocabulary = {
  "time alignment": "clock",
  "chamber conditioning": "chamber",
  "catalog release": "catalog",
  "measurement scatter": "noise",
  "evidence coverage": "coverage",
} as const satisfies Record<string, DiscoveryFinding>

const sourceFiles = [
  "discovery-run.ts", "discovery-cases.ts", "discovery-grade.ts", "discovery-host.ts", "discovery-tools.ts",
  "native-observer.ts", "native-provider.ts", "compaction.ts", "input-usage.ts", "skill-delivery.ts", "host.ts",
  "../acceptance/host.ts", "../acceptance/runtime.ts", "../acceptance/service.ts",
]
const location = dirname(fileURLToPath(import.meta.url))
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const digest = (value: unknown) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
const identified = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value)
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim()

function check(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(reason)
}

function record(value: unknown, label: string): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), `Invalid ${label}`)
  return value as Record<string, unknown>
}

function rows(value: unknown, label: string) {
  check(Array.isArray(value), `Invalid ${label}`)
  return value.map(row => record(row, label))
}

function match(actual: unknown, expected: unknown, message: string) {
  check(isDeepStrictEqual(actual, expected), message)
}

async function artifact(path: string) {
  check((await lstat(path)).isFile(), `Expected a regular file at ${path}`)
  const bytes = await readFile(path)
  return { text: bytes.toString("utf8"), sha256: sha256(bytes) }
}

function json(content: string, label: string): unknown {
  try { return JSON.parse(content) } catch { throw new Error(`Invalid JSON in ${label}`) }
}

async function freeze(protocol: Record<string, unknown>) {
  check(protocol.schema === "discovery-freeze-v1" &&
    (protocol.mode === "native-oauth" && text(protocol.model) ||
      protocol.mode === "synthetic-scripted" && protocol.model === null), "Invalid discovery freeze")
  const host = record(protocol.host, "frozen host")
  check(host.version === "2.3.2" && digest(host.binarySha256) && digest(host.packageSha256), "Invalid frozen runtime digests")
  const files = record(protocol.files, "frozen file manifest")
  check(protocol.sourceDigestMode === undefined || protocol.sourceDigestMode === "utf8-lf-v1", "Unknown frozen source digest mode")
  match(Object.keys(files).sort(), [...sourceFiles].sort(), "Frozen source file coverage mismatch")
  await Promise.all(sourceFiles.map(async path => {
    const current = await artifact(resolve(location, path))
    const actual = protocol.sourceDigestMode === "utf8-lf-v1" ? sha256(current.text.replace(/\r\n/g, "\n")) : current.sha256
    check(actual === files[path], `Frozen source digest mismatch: ${path}`)
  }))
  const localCases = buildDiscoveryCases()
  const frozenCases = rows(protocol.cases, "frozen cases")
  check(frozenCases.length > 0 && frozenCases.length <= localCases.length, "Invalid frozen case count")
  let lastIndex = -1
  return frozenCases.map(frozen => {
    const index = localCases.findIndex(incident => frozen.id === incident.id)
    check(index > lastIndex, "Unknown, duplicate, or out-of-order frozen case")
    lastIndex = index
    const fixture = localCases[index]!
    check(frozen.caseSha256 === sha256(JSON.stringify(fixture)) && frozen.promptSha256 === sha256(fixture.input.prompt),
      `Frozen fixture digest mismatch: ${fixture.id}`)
    const pivot = index % arms.length
    const order = [...arms.slice(pivot), ...arms.slice(0, pivot)]
    match(frozen.order, order, `Frozen arm order mismatch: ${fixture.id}`)
    return { fixture, order }
  })
}

type Trial = { trial: string; case: string; arm: Arm }
type Grade = ReturnType<typeof gradeDiscovery>
const outcomes = ["completed", "model-output-failure", "budget-exhausted", "apparatus-error"] as const
type Outcome = typeof outcomes[number]
type Attempt = Trial & {
  fixture: DiscoveryCase
  qualified: boolean
  apparatusQualified: boolean
  treatment: unknown
  outcome: Outcome | "uncommitted"
  receiptPresent: boolean
  packet: DiscoveryReviewPacket | null
  raw: Grade
  final: Grade
  submission: unknown
  verifiedSourcePaths: string[]
  reviewed: DiscoveryAdjudication[]
}

function verifiedReads(receipt: Record<string, unknown>, fixture: DiscoveryCase) {
  const sources = new Map(fixture.input.sources.map(({ path, content }) => [path, sha256(content)]))
  const evidence = rows(receipt.evidence, "source evidence receipts")
  const verified = rows(receipt.rootReads, "verified root reads")
  const ids = new Set<string>()
  return verified.map(read => {
    check(text(read.path) && text(read.receipt) && !ids.has(read.receipt) &&
      sources.has(read.path) && sources.get(read.path) === read.sha256 &&
      evidence.filter(row => row.id === read.receipt && row.scope === "root" && row.path === read.path &&
        row.outcome === "read" && row.sha256 === read.sha256).length === 1, "Root read receipt or source digest mismatch")
    ids.add(read.receipt)
    return read.path
  })
}

function reviewDecision(row: Record<string, unknown>): DiscoveryAdjudication {
  check(Object.keys(row).every(key => ["packetId", "claimId", "verdict", "rationale", "evidence", "certification", "equivalentTo"].includes(key)) &&
    typeof row.packetId === "string" && digest(row.packetId) && text(row.claimId) && text(row.rationale) &&
    Array.isArray(row.evidence) && row.evidence.every(text) &&
    (row.verdict === "supported" || row.verdict === "unsupported" || row.verdict === "contradicted") &&
    (row.certification === undefined || typeof row.certification === "boolean"), "Invalid blinded reviewer decision")
  let equivalentTo: DiscoveryAdjudication["equivalentTo"]
  if (row.equivalentTo !== undefined) {
    check(row.verdict === "supported", "equivalentTo requires a supported decision")
    const equivalence = record(row.equivalentTo, "equivalentTo")
    check(Object.keys(equivalence).length === 2 && text(equivalence.finding) && text(equivalence.scope),
      "equivalentTo requires a public finding and lot scope")
    const label = equivalence.finding.trim().toLowerCase()
    const finding = Object.entries(vocabulary).find(([name, key]) => name === label || key === label)?.[1]
    check(finding, `Unknown equivalentTo finding "${label}". See --review-guide.`)
    equivalentTo = { finding, scope: equivalence.scope.trim().toUpperCase() }
  }
  return {
    packetId: row.packetId, claimId: row.claimId, verdict: row.verdict, rationale: row.rationale, evidence: row.evidence,
    ...(equivalentTo && { equivalentTo }), ...(row.certification !== undefined && { certification: row.certification }),
  }
}

async function decisions(path: string, hashes: Record<string, string>) {
  const directory = (await lstat(path)).isDirectory()
  const files = directory ? (await readdir(path)).sort() : [path]
  const entries = new Map<string, DiscoveryAdjudication>()
  for (const file of files) {
    check(file.endsWith(".json"), `Expected a JSON reviewer decision file: ${file}`)
    const input = await artifact(directory ? join(path, file) : file)
    hashes["decisions/" + (directory ? file : "decisions.json")] = input.sha256
    const parsed = json(input.text, file)
    const root = Array.isArray(parsed) ? null : record(parsed, "review envelope")
    if (root) check(root.schema === "discovery-adjudication-v1" && Object.keys(root).length === 2, "Invalid review envelope")
    for (const row of rows(root ? root.decisions : parsed, "review decisions")) {
      const decision = reviewDecision(row)
      const key = decision.packetId + "/" + decision.claimId
      check(!entries.has(key), `Duplicate blind decision: ${key}`)
      entries.set(key, decision)
    }
  }
  return [...entries.values()]
}

type NoncreditedEquivalence = Pick<DiscoveryAdjudication, "packetId" | "claimId"> & {
  equivalentTo: NonNullable<DiscoveryAdjudication["equivalentTo"]>
  reason: "frozen-target-absent" | "original-citations-incomplete"
}

function gradeReviews(attempts: Attempt[], reviews: DiscoveryAdjudication[]) {
  const noncredited = new Map<string, NoncreditedEquivalence>()
  const known = new Map(attempts.flatMap(attempt => attempt.packet ? [[attempt.packet.packetId, attempt.packet] as const] : []))
  const grouped = new Map<string, DiscoveryAdjudication[]>()
  for (const review of reviews) {
    check(known.get(review.packetId)?.submission.claims.some(claim => claim.claimId === review.claimId),
      `Decision refers to an unknown packet or claim: ${review.packetId}/${review.claimId}`)
    const list = grouped.get(review.packetId) ?? []
    list.push(review)
    grouped.set(review.packetId, list)
  }
  for (const attempt of attempts) {
    if (!attempt.packet) {
      attempt.final = { ...attempt.raw, passed: false }
      continue
    }
    const { packet } = attempt
    const all = (grouped.get(packet.packetId) ?? []).map(review => {
      const { equivalentTo, ...decision } = review
      if (!equivalentTo) return review
      const claim = packet.submission.claims.find(row => row.claimId === review.claimId)!
      const target = attempt.fixture.oracle.targets.find(row => row.finding === equivalentTo.finding && row.scope === equivalentTo.scope)
      if (target?.requiredRefs.every(ref => claim.evidence.includes(ref))) return review
      const { packetId, claimId } = review
      noncredited.set(packetId + "/" + claimId, {
        packetId, claimId, equivalentTo, reason: target ? "original-citations-incomplete" : "frozen-target-absent",
      })
      return decision
    })
    const opts = { verifiedSourcePaths: attempt.verifiedSourcePaths }
    // Reviewers can decide every claim without a list of the host grader's pending IDs.
    const validated = gradeDiscovery(attempt.fixture, attempt.submission, { ...opts, adjudications: all })
    check(!validated.adjudicationErrors.length, `Invalid decision evidence in packet ${attempt.packet.packetId}: ${validated.adjudicationErrors.join(", ")}`)
    attempt.reviewed = all.filter(review => attempt.raw.pendingClaims.includes(review.claimId))
    const final = gradeDiscovery(attempt.fixture, attempt.submission, { ...opts, adjudications: attempt.reviewed })
    match(final.verifiedEvidence, attempt.raw.verifiedEvidence, "Adjudication changed verified-read status")
    attempt.final = { ...final, passed: final.passed && attempt.outcome === "completed" }
    check(!attempt.final.reviewRequired, `Missing blind decisions for packet ${attempt.packet.packetId}: ${attempt.final.pendingClaims.join(", ")}`)
  }
  return [...noncredited.values()]
}

const ratio = (numerator: number, denominator: number) => ({ numerator, denominator, rate: denominator ? numerator / denominator : null })

function metrics(attempts: Attempt[], stage: "raw" | "final") {
  const count = (predicate: (grade: Grade, attempt: Attempt) => boolean) =>
    attempts.filter(attempt => predicate(attempt[stage], attempt)).length
  const sum = (value: (grade: Grade, attempt: Attempt) => number) =>
    attempts.reduce((total, attempt) => total + value(attempt[stage], attempt), 0)
  const findings = attempts.flatMap(attempt => attempt.fixture.oracle.targets.map(target => ({
    ...target, found: !attempt[stage].missedFindings.some(missed => missed.finding === target.finding && missed.scope === target.scope),
  })))
  const defect = findings.filter(row => row.materialDefect)
  const byFinding = (Object.values(vocabulary)).map(finding => {
    const eligible = findings.filter(row => row.finding === finding)
    return [finding, ratio(eligible.filter(row => row.found).length, eligible.length)] as const
  })
  const fields = {
    receivedReport: count((_, row) => row.receiptPresent),
    validSubmission: count(grade => grade.validSubmission),
    qualified: count((_, row) => row.qualified),
    apparatusQualified: count((_, row) => row.apparatusQualified),
    passed: count(grade => grade.passed),
    verifiedEvidence: count(grade => grade.verifiedEvidence === true),
    fullIncidentClosure: count(grade => grade.fullIncidentClosure),
    correctAbstention: count(grade => grade.correctAbstention),
    reviewRequired: count(grade => grade.reviewRequired),
    hasSupportedClaims: count(grade => grade.supportedClaims > 0),
    hasUnsupportedClaims: count(grade => grade.unsupportedClaims.length > 0),
    hasSevereMiss: count(grade => grade.severeMisses.length > 0),
    hasUnsupportedCertification: count(grade => grade.unsupportedCertifications.length > 0),
  }
  return {
    attempted: attempts.length,
    fields: Object.fromEntries(Object.entries(fields).map(([key, passed]) => [key, ratio(passed, attempts.length)])),
    materialDefectRecall: ratio(defect.filter(row => row.found).length, defect.length),
    recallByFinding: Object.fromEntries(byFinding),
    eligibleClosure: ratio(fields.fullIncidentClosure, count((_, row) => !row.fixture.oracle.missingEvidence.length)),
    eligibleAbstention: ratio(fields.correctAbstention, count((_, row) => row.fixture.oracle.missingEvidence.length > 0)),
    outcomes: Object.fromEntries([...outcomes, "uncommitted"].map(outcome => [outcome, count((_, row) => row.outcome === outcome)])),
    counts: {
      supportedClaims: sum(grade => grade.supportedClaims),
      unsupportedClaims: sum(grade => grade.unsupportedClaims.length),
      pendingClaims: sum(grade => grade.pendingClaims.length),
      severeMisses: sum(grade => grade.severeMisses.length),
      unsupportedCertifications: sum(grade => grade.unsupportedCertifications.length),
    },
  }
}

function pairedSummary(fixtures: DiscoveryCase[], attempts: Attempt[], nativeComparable: boolean, stage: "raw" | "final") {
  return Object.fromEntries(Object.entries(comparisons).map(([key, [first, second]]) => {
    const pairs = fixtures.map(fixture => {
      const baseline = attempts.find(row => row.case === fixture.id && row.arm === first)
      const treatment = attempts.find(row => row.case === fixture.id && row.arm === second)
      return {
        case: fixture.id, baseline: baseline?.trial ?? null, treatment: treatment?.trial ?? null,
        baselinePassed: baseline?.[stage].passed ?? null, treatmentPassed: treatment?.[stage].passed ?? null,
        baselineOutcome: baseline?.outcome ?? null, treatmentOutcome: treatment?.outcome ?? null,
        comparable: !!(nativeComparable && baseline?.apparatusQualified && treatment?.apparatusQualified &&
          !baseline[stage].reviewRequired && !treatment[stage].reviewRequired),
        verifiedLedgerInAssignedAlgArms: !!baseline && !!treatment && [baseline, treatment].every(row =>
          row.treatment === "control" || row.treatment === "verified-ledger"),
      }
    })
    const summarize = (selected: typeof pairs) => ({
      pairs: selected.length,
      bothPassed: selected.filter(pair => pair.baselinePassed && pair.treatmentPassed).length,
      baselineOnly: selected.filter(pair => pair.baselinePassed && !pair.treatmentPassed).length,
      treatmentOnly: selected.filter(pair => !pair.baselinePassed && pair.treatmentPassed).length,
      neitherPassed: selected.filter(pair => !pair.baselinePassed && !pair.treatmentPassed).length,
    })
    return [key, {
      baselineArm: first, treatmentArm: second, plannedPairs: pairs.length,
      attempted: summarize(pairs.filter(pair => pair.baseline && pair.treatment)),
      comparable: summarize(pairs.filter(pair => pair.comparable)),
      verifiedLedger: summarize(pairs.filter(pair => pair.comparable && pair.verifiedLedgerInAssignedAlgArms)),
      pairs,
    }]
  }))
}

type FinalizeOptions = { privateDir: string; blindedDir?: string; frozen?: string; decisions: string; output: string }

export async function finalizeDiscovery(options: FinalizeOptions) {
  const privateDir = resolve(options.privateDir)
  const blindedDir = resolve(options.blindedDir ?? join(dirname(privateDir), "blinded"))
  const declaredDigests: Record<string, string> = {}
  const read = async (scope: "private" | "blinded", file: string) => {
    const data = await artifact(join(scope === "private" ? privateDir : blindedDir, file))
    declaredDigests[scope + "/" + file] = data.sha256
    return data.text
  }
  const readJson = async (scope: "private" | "blinded", file: string) => json(await read(scope, file), scope + "/" + file)
  const provisional = await artifact(join(privateDir, "report.json"))
  const report = record(json(provisional.text, "report.json"), "provisional report")
  check(report.schema === "discovery-report-v1" && typeof report.runtimeUnchanged === "boolean" &&
    typeof report.qualified === "boolean" && (report.interrupted === null || typeof report.interrupted === "string"),
  "Invalid provisional discovery report")
  const manifest = record(report.artifactSha256, "receipt artifact digests")
  const protocol = record(await readJson("private", "protocol.json"), "receipt protocol")
  check(report.mode === protocol.mode, "Receipt and frozen protocol modes differ")
  let externalFreeze: string | null = null
  if (options.frozen) {
    externalFreeze = (await artifact(options.frozen)).sha256
    check(externalFreeze === declaredDigests["private/protocol.json"], "Independent freeze digest mismatch")
  } else check(protocol.mode !== "native-oauth", "Native finalization requires the original --frozen protocol")
  const cases = await freeze(protocol)
  const planned = cases.flatMap(({ fixture, order }) => order.map(arm => ({ case: fixture.id, arm })))
  const key = rows(await readJson("private", "trial-key.json"), "trial key")
  check(key.length === planned.length && report.expected === planned.length, "Wrong planned trial count")
  const plannedTrials = planned.map((plan, index): Trial => {
    const row = key[index]!
    check(identified(row.trial), "Invalid blinded trial ID")
    const trial = { ...plan, trial: row.trial }
    match(row, trial, "Trial key differs from frozen assignment")
    return trial
  })
  check(new Set(plannedTrials.map(row => row.trial)).size === plannedTrials.length, "Duplicate blinded trial ID")
  const events = (await read("private", "events.jsonl")).split(/\r?\n/).filter(line => line.trim()).map((line, index) =>
    record(json(line, `journal line ${index + 1}`), "journal event"))
  const started: Trial[] = []
  const ended = new Map<string, Record<string, unknown>>()
  let active: Trial | undefined
  for (const event of events) {
    if (event.event === "arm-start") {
      const trial = plannedTrials[started.length]
      check(trial && !active && trial.trial === event.trial, "Out-of-order or duplicate arm start")
      started.push(trial)
      active = trial
    } else {
      check(active && active.trial === event.trial && text(event.event), "Journal event outside its started trial")
      if (event.event === "arm-end") {
        ended.set(active.trial, event)
        active = undefined
      }
    }
  }
  const completed = rows(report.completed, "completed summaries")
  check(completed.length === ended.size || (active && report.interrupted !== null && completed.length === ended.size + 1),
    "Completed summaries differ from journal")
  check(report.interrupted !== null || (!active && started.length === planned.length), "Incomplete journal lacks interruption receipt")
  const fixtureById = new Map(cases.map(({ fixture }) => [fixture.id, fixture]))
  const attempts: Attempt[] = []
  for (const [index, trial] of started.entries()) {
    const fixture = fixtureById.get(trial.case)!
    const summary = completed[index]
    if (!summary) {
      check(!ended.has(trial.trial) && active === trial, "Missing completed arm summary")
      const raw = gradeDiscovery(fixture, undefined, { verifiedSourcePaths: [] })
      attempts.push({ ...trial, fixture, qualified: false, apparatusQualified: false, treatment: null, outcome: "uncommitted", receiptPresent: false,
        packet: null, raw, final: raw, submission: undefined, verifiedSourcePaths: [], reviewed: [] })
      continue
    }
    for (const field of ["trial", "case", "arm"] as const) check(summary[field] === trial[field], "Completed summary trial mismatch")
    const name = trial.trial + ".json"
    const receipt = record(await readJson("private", name), "private trial receipt")
    for (const [field, value] of Object.entries(summary)) match(receipt[field], value, `Trial summary mismatch: ${name}/${field}`)
    const terminal = ended.get(trial.trial)
    for (const field of ["qualified", "apparatusQualified", "outcome", "problem"] as const) {
      if (terminal) match(terminal[field], receipt[field], `Terminal journal mismatch: ${name}/${field}`)
    }
    check(typeof receipt.qualified === "boolean" && typeof receipt.apparatusQualified === "boolean" &&
      (receipt.final === null || typeof receipt.final === "string"), `Invalid private trial data: ${name}`)
    const outcome = outcomes.find(value => value === receipt.outcome)
    check(outcome && (outcome !== "apparatus-error") === receipt.apparatusQualified &&
      (!receipt.qualified || outcome === "completed"), "Invalid trial outcome or qualification")
    const verifiedSourcePaths = verifiedReads(receipt, fixture)
    const submission = parseDiscoverySubmission(receipt.final)
    const packet = buildDiscoveryReviewPacket(fixture, submission)
    const raw = gradeDiscovery(fixture, submission, { verifiedSourcePaths })
    check(outcome !== "completed" || raw.validSubmission, "Completed trial has an invalid report")
    match(receipt.grade, raw, `Provisional grade does not replay: ${name}`)
    match(await readJson("blinded", name), { trial: trial.trial, packet }, `Blinded packet differs from frozen sources or raw answer: ${name}`)
    attempts.push({ ...trial, fixture, qualified: receipt.qualified, apparatusQualified: receipt.apparatusQualified,
      treatment: receipt.treatment, outcome, receiptPresent: true, packet, raw, final: raw, submission, verifiedSourcePaths, reviewed: [] })
  }
  match(declaredDigests, manifest, "Receipt artifact digest or manifest coverage mismatch")
  const committed = attempts.filter(row => row.receiptPresent)
  match(report.qualified, !report.interrupted && report.runtimeUnchanged &&
    committed.length === planned.length && committed.every(row => protocol.mode === "native-oauth" ? row.apparatusQualified : row.qualified),
  "Provisional run qualification disagrees with receipts")
  match(report.allEvidenceQualified, report.qualified && committed.every(row => row.qualified), "Provisional evidence qualification differs from receipts")
  const nativeComparable = protocol.mode === "native-oauth" && report.runtimeUnchanged
  const fixtures = cases.map(({ fixture }) => fixture)
  const rawPairs = pairedSummary(fixtures, attempts, nativeComparable, "raw")
  const rawComparisons = Object.fromEntries(Object.entries(rawPairs).map(([name, summary]) => [name,
    summary.pairs.filter(pair => committed.some(row => row.trial === pair.baseline) && committed.some(row => row.trial === pair.treatment))
      .map(pair => {
        const { case: fixture, baseline, treatment, comparable, baselinePassed, treatmentPassed, baselineOutcome, treatmentOutcome, verifiedLedgerInAssignedAlgArms } = pair
        return { case: fixture, baseline, treatment, comparable, baselinePassed, treatmentPassed, baselineOutcome, treatmentOutcome, verifiedLedgerInAssignedAlgArms,
          baselineTreatment: committed.find(row => row.trial === baseline)!.treatment,
          treatmentReceived: committed.find(row => row.trial === treatment)!.treatment }
      })]))
  match(report.comparisons, rawComparisons, "Provisional pair comparisons disagree with replay")
  const decisionDigests: Record<string, string> = {}
  const reviews = await decisions(options.decisions, decisionDigests)
  const noncreditedEquivalences = gradeReviews(attempts, reviews)
  const aggregate = (stage: "raw" | "final") => ({
    overall: metrics(attempts, stage),
    byArm: Object.fromEntries(arms.map(arm => {
      const selected = attempts.filter(row => row.arm === arm)
      const expected = planned.filter(row => row.arm === arm).length
      return [arm, { planned: expected, notAttempted: expected - selected.length, ...metrics(selected, stage) }]
    })),
    comparisons: stage === "raw" ? rawPairs : pairedSummary(fixtures, attempts, nativeComparable, "final"),
  })
  const output = {
    schema: "discovery-finalization-v1",
    mode: protocol.mode, runtimeUnchanged: report.runtimeUnchanged, qualified: report.qualified, allEvidenceQualified: report.allEvidenceQualified, interrupted: report.interrupted,
    counts: { planned: planned.length, attempted: started.length, committed: committed.length,
      withoutCommittedReceipt: started.length - committed.length, notAttempted: planned.length - started.length },
    sha256: { externalFreeze, provisionalReport: provisional.sha256, artifacts: declaredDigests, decisions: decisionDigests },
    rawProvisional: aggregate("raw"),
    adjudicated: aggregate("final"),
    review: { receipts: reviews, noncreditedEquivalences, applied: attempts.reduce((sum, row) => sum + row.reviewed.length, 0) },
    attempts: attempts.map(row => ({
      trial: row.trial, case: row.case, arm: row.arm, qualified: row.qualified, apparatusQualified: row.apparatusQualified,
      treatment: row.treatment, outcome: row.outcome, receiptPresent: row.receiptPresent, packetId: row.packet?.packetId ?? null,
      rawProvisionalGrade: row.raw, adjudicatedGrade: row.final,
    })),
  }
  await writeFile(options.output, JSON.stringify(output, null, 2) + "\n", { flag: "wx", mode: 0o600 })
  return output
}

const usage = [
  "bun --no-install packages/v2-preview/benchmark/discovery-finalize.ts",
  "  --private <receipts/private> [--blinded <receipts/blinded>] --decisions <json-or-directory> --output <new-report.json>",
  "  [--frozen <original-protocol.json>]  Required for native receipts.",
  "  --review-guide  Print only the public reviewer instructions.",
].join("\n")

const reviewGuide = [
  "Use only the anonymous packet and its sources. Review each claim at the scope given in the packet.",
  'Return { "schema": "discovery-adjudication-v1", "decisions": [ ... ] }.',
  'Each decision has "packetId", "claimId", "verdict" (supported, unsupported, or contradicted), "rationale", and "evidence" (source row IDs as path#id).',
  "A supported decision cites rows in the original claim. A contradicted decision cites refuting rows. An unsupported decision may use an empty evidence array.",
  'Set "certification": true for a claim of definite cause, clearance, or complete coverage.',
  'For a supported attribution expressed as a paraphrase, optionally add "equivalentTo": { "finding": "<category>", "scope": "<lot ID>" }.',
  "Categories (the same for every packet): " + Object.keys(vocabulary).join(", ") + ".",
  "Select a category only when the claim itself states that attribution and its original citations establish it.",
  "Judge support using the public packet. The finalizer independently determines any benchmark credit.",
  "For an identical packet ID appearing more than once, give one decision per claim ID.",
].join("\n")

export async function runDiscoveryFinalizeCLI(args: string[]) {
  if (args.length === 1 && args[0] === "--help") { console.log(usage); return }
  if (args.length === 1 && args[0] === "--review-guide") { console.log(reviewGuide); return }
  const allowed = ["--private", "--blinded", "--frozen", "--decisions", "--output"]
  const flags = new Map<string, string>()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    check(flag && allowed.includes(flag) && !flags.has(flag) && value && !value.startsWith("--"), usage)
    flags.set(flag, value)
  }
  const privateDir = flags.get("--private"), decisionsPath = flags.get("--decisions"), outputPath = flags.get("--output")
  check(privateDir && decisionsPath && outputPath, usage)
  const out = await finalizeDiscovery({ privateDir, decisions: decisionsPath, output: outputPath,
    blindedDir: flags.get("--blinded"), frozen: flags.get("--frozen") })
  console.log(JSON.stringify({ output: resolve(outputPath), ...out.counts }))
}

if (import.meta.main) {
  try { await runDiscoveryFinalizeCLI(process.argv.slice(2)) }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

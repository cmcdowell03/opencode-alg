import { createHash } from "node:crypto"
import type { DiscoveryCase, DiscoveryFinding, DiscoverySource, DiscoveryTarget } from "./discovery-cases.ts"

export type DiscoveryClaim = { finding: string; scope: string; evidence: string[] }
export type DiscoverySubmission = {
  disposition: "resolved" | "indeterminate"
  claims: DiscoveryClaim[]
  missingEvidence: string[]
}

export type DiscoveryReviewPacket = {
  schema: "discovery-review-v1"
  packetId: string
  prompt: string
  sources: readonly DiscoverySource[]
  submission: Omit<DiscoverySubmission, "claims"> & { claims: (DiscoveryClaim & { claimId: string })[] }
}

export type DiscoveryAdjudication = {
  packetId: string
  claimId: string
  verdict: "supported" | "unsupported" | "contradicted"
  rationale: string
  evidence: readonly string[]
  // Mark an explicit claim that certifies a cause, clearance, or complete coverage.
  certification?: boolean
  // A paraphrase may satisfy a target when its original citations establish the same finding and scope.
  equivalentTo?: { finding: DiscoveryFinding; scope: string }
}

type GradeOptions = {
  verifiedSourcePaths?: readonly string[]
  adjudications?: readonly DiscoveryAdjudication[]
}

type ClaimGrade = {
  claimId: string
  status: "supported" | "unsupported" | "contradicted" | "pending"
  target: DiscoveryTarget | null
  reason: string
}

const aliases: Record<DiscoveryFinding, readonly string[]> = {
  clock: ["clock", "clock skew", "clock offset", "clock misalignment", "timestamp misalignment", "clock misjoin",
    "clock join error", "wrong schedule window", "station clock offset"],
  chamber: ["chamber", "chamber fault", "chamber overtemperature", "chamber overheating", "hot chamber", "chamber temperature excursion"],
  catalog: ["catalog", "stale catalog", "stale catalog revision", "outdated catalog", "wrong catalog revision", "stale limits"],
  noise: ["noise", "measurement noise", "instrument noise", "gauge noise", "instrument scatter", "measurement scatter"],
  coverage: ["coverage", "unresolved clock alignment", "unresolved time alignment", "missing synchronization evidence",
    "missing sync capture", "missing decisive source", "indeterminate timing"],
}

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value)
const nonempty = (value: unknown): value is string => typeof value === "string" && !!value.trim()
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(nonempty)
const normalized = (text: string) => text.trim().toLowerCase().replace(/[-_]/g, " ").replace(/\s+/g, " ")
const scopeKey = (scope: string) => scope.trim().toUpperCase()

function readSubmission(value: unknown): DiscoverySubmission | null {
  if (!object(value) || Object.keys(value).length !== 3 ||
    (value.disposition !== "resolved" && value.disposition !== "indeterminate") ||
    !strings(value.missingEvidence) || !Array.isArray(value.claims)) return null
  const claims: DiscoveryClaim[] = []
  for (const claim of value.claims) {
    if (!object(claim) || Object.keys(claim).length !== 3 ||
      !nonempty(claim.finding) || !nonempty(claim.scope) || !strings(claim.evidence)) return null
    claims.push({ finding: claim.finding.trim(), scope: claim.scope.trim(), evidence: claim.evidence.map(ref => ref.trim()) })
  }
  return { disposition: value.disposition, claims, missingEvidence: value.missingEvidence.map(path => path.trim()) }
}

export function parseDiscoverySubmission(text: string | null | undefined): unknown {
  if (typeof text !== "string") return undefined
  const trimmed = text.trim()
  const fenced = /^\x60\x60\x60(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n\x60\x60\x60$/i.exec(trimmed)
  try {
    return JSON.parse(fenced?.[1] ?? trimmed)
  } catch {
    return undefined
  }
}

/** Export only the public evidence and the anonymous answer being reviewed. */
export function buildDiscoveryReviewPacket(incident: DiscoveryCase, value: unknown): DiscoveryReviewPacket | null {
  const submission = readSubmission(value)
  if (!submission) return null
  const { prompt, sources } = incident.input
  const packetId = createHash("sha256").update(JSON.stringify([prompt, sources, submission])).digest("hex")
  return {
    schema: "discovery-review-v1",
    packetId,
    prompt,
    sources: sources.map(({ path, content }) => ({ path, content })),
    submission: {
      ...submission,
      claims: submission.claims.map((claim, index) => ({ ...claim, claimId: `c${index + 1}` })),
    },
  }
}

function rowReferences(sources: readonly DiscoverySource[]) {
  const references = new Map<string, string>()
  for (const source of sources) {
    if (!source.path.endsWith(".json")) continue
    for (const row of JSON.parse(source.content) as { id: string }[]) {
      references.set(`${source.path}#${row.id}`, source.path)
    }
  }
  return references
}

export function gradeDiscovery(incident: DiscoveryCase, value: unknown, options: GradeOptions = {}) {
  const packet = buildDiscoveryReviewPacket(incident, value)
  const submission = packet?.submission
  const { targets, missingEvidence } = incident.oracle
  const references = rowReferences(incident.input.sources)

  const reviews = new Map<string, DiscoveryAdjudication>()
  const adjudicationErrors: string[] = []
  const duplicateReviews = new Set<string>()
  for (const review of options.adjudications ?? []) {
    const claim = submission?.claims.find(item => item.claimId === review?.claimId)
    if (!claim || review.packetId !== packet?.packetId || !nonempty(review.rationale) || !strings(review.evidence) ||
      !["supported", "unsupported", "contradicted"].includes(review.verdict) ||
      (review.certification !== undefined && typeof review.certification !== "boolean") ||
      (review.verdict !== "unsupported" && !review.evidence.length) ||
      review.evidence.some(ref => !references.has(ref)) ||
      (review.verdict === "supported" && review.evidence.some(ref => !claim.evidence.includes(ref))) ||
      (review.equivalentTo !== undefined && (review.verdict !== "supported" ||
        !targets.some(target => target.finding === review.equivalentTo?.finding && target.scope === review.equivalentTo.scope &&
          target.requiredRefs.every(ref => claim.evidence.includes(ref)))))) {
      adjudicationErrors.push(`Invalid adjudication for ${review?.claimId ?? "unknown claim"}`)
      continue
    }
    if (reviews.has(review.claimId) || duplicateReviews.has(review.claimId)) {
      adjudicationErrors.push(`Duplicate adjudication for ${review.claimId}`)
      duplicateReviews.add(review.claimId)
      reviews.delete(review.claimId)
      continue
    }
    reviews.set(review.claimId, review)
  }

  const claims: ClaimGrade[] = (submission?.claims ?? []).map(claim => {
    const { claimId } = claim
    const finding = (Object.keys(aliases) as DiscoveryFinding[]).find(key => aliases[key].includes(normalized(claim.finding)))
    const target = targets.find(row => row.finding === finding && row.scope === scopeKey(claim.scope))
    const citationsValid = claim.evidence.length > 0 && claim.evidence.every(ref => references.has(ref))
    if (target) {
      const supported = citationsValid && target.requiredRefs.every(ref => claim.evidence.includes(ref))
      return { claimId, target, status: supported ? "supported" : "unsupported",
        reason: supported ? "Required source rows establish the finding" : "Missing or invalid supporting source rows" }
    }
    // Keep all open-ended statements reviewable, including those containing invented references.
    const review = reviews.get(claimId)
    if (!review) return { claimId, target: null, status: "pending", reason: "Blinded review required" }
    if (review.verdict === "supported" && !citationsValid) {
      return { claimId, target: null, status: "unsupported", reason: "Missing or invalid supporting source rows" }
    }
    const equivalent = review.equivalentTo
    const equivalentTarget = equivalent ? targets.find(row => row.finding === equivalent.finding && row.scope === equivalent.scope) : undefined
    return { claimId, target: equivalentTarget ?? null, status: review.verdict, reason: review.rationale }
  })

  const supportedTargets = new Set(claims.filter(row => row.status === "supported").map(row => row.target))
  const missedFindings = targets.filter(target => !supportedTargets.has(target))
  const defects = targets.filter(target => target.materialDefect)
  const severeMisses = missedFindings.filter(target => target.materialDefect || target.finding === "coverage")
    .map(({ finding, scope }) => ({ finding, scope }))
  const materialDefectRecall = defects.length ? defects.filter(target => supportedTargets.has(target)).length / defects.length : null
  const supportedClaims = new Set(claims.flatMap(({ status, target }, index) => {
    if (status !== "supported") return []
    const claim = submission!.claims[index]!
    return [JSON.stringify(target ? [target.finding, target.scope] : [normalized(claim.finding), scopeKey(claim.scope)])]
  })).size
  const unsupportedClaims = claims.filter(row => row.status === "unsupported" || row.status === "contradicted").map(row => row.claimId)
  const pendingClaims = claims.filter(row => row.status === "pending").map(row => row.claimId)
  const reviewRequired = pendingClaims.length > 0
  const citesUnavailableEvidence = !!submission && submission.missingEvidence.length === missingEvidence.length &&
    missingEvidence.every(path => submission.missingEvidence.includes(path))
  const expectsAbstention = missingEvidence.length > 0
  const supportComplete = !!submission && missedFindings.length === 0 && unsupportedClaims.length === 0 &&
    !reviewRequired && !adjudicationErrors.length && citesUnavailableEvidence
  const fullIncidentClosure = supportComplete && !expectsAbstention && submission?.disposition === "resolved"
  const correctAbstention = supportComplete && expectsAbstention && submission?.disposition === "indeterminate"
  const verifiedPaths = options.verifiedSourcePaths === undefined ? null : new Set(options.verifiedSourcePaths)
  const verifiedEvidence = verifiedPaths === null ? null : !!submission?.claims.length && submission.claims.every(claim =>
    claim.evidence.length > 0 && claim.evidence.every(ref => {
      const path = references.get(ref)
      return path !== undefined && verifiedPaths.has(path)
    }))
  const unsupportedCertifications = unsupportedClaims
    .filter(claimId => reviews.get(claimId)?.certification === true)
    .map(claimId => "Claim " + claimId + " asserts a certification the sources do not establish")
  if (submission?.disposition === "resolved") {
    if (expectsAbstention) unsupportedCertifications.push("Decisive evidence is unavailable")
    if (missedFindings.length && !reviewRequired) unsupportedCertifications.push("Material findings lack supported closure")
    if (unsupportedClaims.length) unsupportedCertifications.push("Closure relies on unsupported or contradicted claims")
    if (!citesUnavailableEvidence) unsupportedCertifications.push("Reported missing evidence does not match the source inventory")
    if (verifiedEvidence === false) unsupportedCertifications.push("Citations lack verified source reads")
  }
  return {
    passed: (fullIncidentClosure || correctAbstention) && verifiedEvidence !== false,
    validSubmission: !!submission,
    materialDefectRecall,
    fullIncidentClosure,
    correctAbstention,
    supportedClaims,
    unsupportedClaims,
    unsupportedCertifications,
    severeMisses,
    missedFindings: missedFindings.map(({ finding, scope }) => ({ finding, scope })),
    reviewRequired,
    pendingClaims,
    claims,
    adjudicationErrors,
    verifiedEvidence,
  }
}

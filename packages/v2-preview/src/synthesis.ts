import { createHash } from "node:crypto"
import { z } from "zod"
import { EvidenceFindingSchema, type EvidenceReadView, type SourceReceipt } from "./evidence-reads.ts"

const maxClaims = 16
const maxBytes = 16 * 1024
const findingId = EvidenceFindingSchema.shape.id
const signature = z.string().length(64).regex(/^[a-f0-9]+$/)
// Validate own entries without Zod's record projection, which drops "__proto__"
// even when it is an ordinary JSON property and a valid finding ID.
const baselineSchema = z.unknown().refine((value): value is Record<string, string> => {
  if (typeof value !== "object" || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = Reflect.ownKeys(value)
  return keys.length <= maxClaims && keys.every(key =>
    typeof key === "string" && findingId.safeParse(key).success && signature.safeParse(
      Object.getOwnPropertyDescriptor(value, key)?.value,
    ).success)
}, "Expected a bounded map of finding IDs to signatures").meta({
  type: "object",
  maxProperties: maxClaims,
  propertyNames: z.toJSONSchema(findingId),
  additionalProperties: z.toJSONSchema(signature),
}) as z.ZodType<Record<string, string>>

export const synthesisRequestSchema = z.strictObject({
  claims: z.array(findingId).max(maxClaims).refine(ids => new Set(ids).size === ids.length, "Duplicate finding ID"),
  baseline: baselineSchema.optional(),
})

type Request = z.output<typeof synthesisRequestSchema>
type Finding = EvidenceReadView["findings"][number]
type State = "supported-scoped" | "unknown" | "missing" | "open-unscoped" | "contested" | "invalidated" | "numeric-unverified"
type Change = "added" | "changed" | "unchanged" | "disappeared" | "absent"

function citation({ id, reference, tool, sha256 }: SourceReceipt) {
  return { reference, tool, sha256, id }
}

function logicalLink({ tool, path, reference, sha256 }: SourceReceipt) {
  return [tool, path, reference, sha256]
}

function encode(value: unknown) {
  return JSON.stringify(value)
}

function sorted<T>(values: T[]): T[] {
  return values.map(value => [encode(value), value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, value]) => value)
}

function authorityKey(link: SourceReceipt) {
  return encode([link.id, ...logicalLink(link)])
}

function currentAuthority(evidence: EvidenceReadView) {
  const keys = new Set<string>()
  for (const source of evidence.sources) {
    if (source.status !== "inspected") continue
    for (const link of source.references) {
      if (link.tool === source.tool && link.path === source.path && link.sha256 === source.sha256) {
        keys.add(authorityKey(link))
      }
    }
  }
  return keys
}

function inspect(evidence: EvidenceReadView, finding: Finding, authority: ReadonlySet<string>) {
  const { support, counterevidence, scope, missingEvidence, interpretation, falsifier } = finding
  const invalidated = sorted((finding.invalidatedSources ?? []).map(({ relation, reference }) => ({ relation, reference })))
  const links = [...support, ...counterevidence]
  const invalidPaths = new Set(invalidated.map(({ reference }) => reference.split("#", 1)[0]))
  const sources = evidence.sources.filter(source => invalidPaths.has(source.path) ||
    links.some(link => link.tool === source.tool && link.path === source.path))
  const accessible = (link: SourceReceipt) => authority.has(authorityKey(link))
  const currentSupport = support.filter(accessible)
  const currentCounter = counterevidence.filter(accessible)
  const unavailable = (["support", "counterevidence"] as const).flatMap(relation =>
    finding[relation].filter(link => !accessible(link)).map(({ reference }) => ({ relation, reference })))
  const stale = invalidated.length > 0 || unavailable.length > 0
  const numeric = finding.numericVerification
  const arithmetic = numeric?.status === "verified"
    ? { status: numeric.status, value: numeric.value, references: [...numeric.references].sort(), decimalPlaces: numeric.decimalPlaces }
    : numeric && { status: numeric.status }
  let state: State
  if (currentCounter.length || finding.status === "contested") state = "contested"
  else if (stale) state = "invalidated"
  else if (arithmetic && arithmetic.status !== "verified") state = "numeric-unverified"
  else if (missingEvidence || !currentSupport.length) state = "missing"
  else if (!scope?.trim() || finding.status !== "supported") state = "open-unscoped"
  else state = "supported-scoped"

  const details = {
    missingEvidence,
    invalidated,
    unavailable,
    counterevidence: currentCounter.map(citation),
    numericVerification: arithmetic,
    falsifier,
    scope,
    interpretation,
    support: currentSupport.map(citation),
  }
  // Numeric evidence's storage digest includes captured receipt IDs. Hash the
  // projected arithmetic and logical operands instead of that storage digest.
  const logicalSignature = createHash("sha256").update(encode([
    "synthesis-v1", finding.id, state, finding.status, scope, interpretation, falsifier, missingEvidence, arithmetic,
    sorted(support.map(link => [logicalLink(link), accessible(link)])),
    sorted(counterevidence.map(link => [logicalLink(link), accessible(link)])),
    invalidated, sorted(sources.map(source => [source.tool, source.path, source.sha256, source.status])),
  ])).digest("hex")
  return { state, stale, details, logicalSignature }
}

type Details = ReturnType<typeof inspect>["details"]
type Section = keyof Details
type Claim = {
  id: string
  state: State
  signature: string | null
  omitted?: Section[]
  detail?: { finding_id: string }
} & Partial<Details>

export function buildSynthesisReadout(evidence: EvidenceReadView, request: Request) {
  const explicit = request.claims.length > 0
  const ids = explicit ? request.claims : evidence.findings.map(row => row.id).sort()
  const findings = new Map(evidence.findings.map(row => [row.id, row]))
  const authority = currentAuthority(evidence)
  const projected = ids.map(id => {
    const finding = findings.get(id)
    const result = finding && inspect(evidence, finding, authority)
    const row: Claim = { id, state: result?.state ?? "unknown", signature: result?.logicalSignature ?? null }
    const sections = result && (Object.keys(result.details) as Section[]).filter(section => {
      const value = result.details[section]
      return value !== undefined && (!Array.isArray(value) || value.length > 0)
    })
    if (sections?.length) {
      row.omitted = sections
      row.detail = { finding_id: id }
    }
    return { row, result, sections }
  })
  const changes = request.baseline === undefined ? undefined : projected.map(({ row }): Change => {
    const before = Object.hasOwn(request.baseline!, row.id) ? request.baseline![row.id] : undefined
    if (row.signature === null) return before ? "disappeared" : "absent"
    return before === undefined ? "added" : before === row.signature ? "unchanged" : "changed"
  })
  const readout = {
    selection: explicit ? "explicit" as const : "all-recorded" as const,
    coverage: "selected-claims-only" as const,
    authority: "receipt-links-and-recorded-arithmetic" as const,
    interpretationAttribution: "model" as const,
    claims: projected.map(({ row }) => row),
    // Change entries align with claims by index. No out-of-selection baseline keys are emitted.
    changes,
    truncated: true,
    nextMove: "scoped-indeterminate" as "answer-selected" | "scoped-indeterminate" | "recheck" | "select-claims" | "read-detail",
  }

  // Reserve room for the longest nextMove value and every row's omission metadata
  // before allocating detail. Measure UTF-8 after JSON escaping, never by JS length.
  const priority: Section[] = [
    "missingEvidence", "invalidated", "unavailable", "counterevidence", "numericVerification",
    "falsifier", "scope", "interpretation", "support",
  ]
  for (const section of priority) {
    for (const { row, result, sections } of projected) {
      if (!result || !sections?.includes(section)) continue
      Object.assign(row, { [section]: result.details[section] })
      const previous = row.omitted
      const remaining = previous?.filter(item => item !== section)
      row.omitted = remaining?.length ? remaining : undefined
      // JSON "true" is shorter than "false".
      if (Buffer.byteLength(encode(readout)) > maxBytes - 1) {
        delete row[section]
        row.omitted = previous
      }
    }
  }
  for (const row of readout.claims) if (!row.omitted) delete row.detail
  readout.truncated = readout.claims.some(row => row.omitted !== undefined)
  if (projected.some(({ result }) => result?.stale)) readout.nextMove = "recheck"
  else if (!explicit) readout.nextMove = "select-claims"
  else if (readout.claims.every(row => row.state === "supported-scoped")) {
    readout.nextMove = readout.truncated ? "read-detail" : "answer-selected"
  }
  return readout
}

import { createHash } from "node:crypto"
import { isDeepStrictEqual } from "node:util"
import {
  createAcceptedQueryLostAckFixture, createFactoryEvidenceFixture, createPartialInvestigationRestartFixture,
  scoreHardFixture, type CreatedHardFixture,
} from "./hard-benchmark-fixtures.ts"
import type { HardBenchmarkService } from "./hard-benchmark-service.ts"
import type { HardBenchmarkServiceClient } from "./hard-benchmark-qualification.ts"
import { hardBenchmarkReferenceArm } from "./hard-benchmark-qualification.ts"
import type { RetentionBoundaryObligation } from "./build-benchmark-retention-boundaries.ts"

export interface LongCase {
  fixture: CreatedHardFixture
  base: CreatedHardFixture
  factory: CreatedHardFixture
  cell: { handoff: boolean; compact: boolean }
  incident: string
}

export type LongPhase = "q0" | "qh" | "qc" | "qr"
export interface LongOperation {
  sequence: number
  path: string
  args: Record<string, unknown> | null
  status: number
  response: any
}
export interface LongCheckpointContext {
  service: HardBenchmarkService
  operations: readonly LongOperation[]
  auditComplete: boolean
  fromSequence: number
  phase: LongPhase
  nonce: string
}
export interface LongCheckpointCheck {
  id: string
  passed: boolean
  category: RetentionBoundaryObligation["category"]
  expectedDigest: string
  observedDigest: string | null
  exposed: boolean
  known: boolean
}
export interface LongCheckpointResult { passed: boolean; checks: LongCheckpointCheck[]; evidenceDigest: string }

const hash = (value: unknown) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value) ?? "undefined").digest("hex")
const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`
const mutable = new Set(["report.json", "factory.json", "checkpoint.json", "notes.md"])
const procedure = "2"
const skill = `# Current analysis skill v2\nUse current registry revisions, follow the evidence catalog, deduplicate by the declared join key, and distinguish observational findings from causal claims. Preserve uncertainty and use current service state before reusing accepted work.\n`
const revoked = `# REVOKED procedure v1\nDo not use this procedure: reuse archived evidence without checking current revisions, treat chamber differences as causal, and resubmit work whenever an acknowledgement is missing.\n`

function compose(base: CreatedHardFixture, factory: CreatedHardFixture, id: string): CreatedHardFixture {
  const serviceInstructions = base.contestant.files["README.md"] ?? ""
  const serviceRequest = base.contestant.files["sources/request.json"]
    ? JSON.parse(base.contestant.files["sources/request.json"]!) as Record<string, unknown> : undefined
  if (serviceRequest && typeof serviceRequest.procedure === "string") {
    serviceRequest.procedure = "For this combined L2 task, write the service result to report.json and also complete the factory.json, checkpoint.json, and notes.md outputs listed in mission.json. Preserve supplied evidence and service controls."
  }
  const baseFiles: Record<string, string> = { ...base.contestant.files, ...(serviceRequest ? { "sources/request.json": json(serviceRequest) } : {}) }
  const longBase: CreatedHardFixture = {
    contestant: { ...base.contestant, files: baseFiles,
      protectedPaths: Object.keys(baseFiles).filter(path => !base.grader.allowedWritePaths.includes(path)) },
    grader: { ...base.grader, protectedHashes: Object.fromEntries(Object.keys(baseFiles)
      .filter(path => !base.grader.allowedWritePaths.includes(path)).map(path => [path, hash(baseFiles[path]!)])) },
  }
  const factoryContractText = factory.contestant.files["evidence/report-contract.json"] ?? ""
  const baseContractText = baseFiles["sources/request.json"] ?? baseFiles["sources/report-contract.json"] ?? ""
  const files: Record<string, string> = {
    ...baseFiles,
    ...factory.contestant.files,
    "README.md": `# Combined L2 task\n\n## Service component\n\n${serviceInstructions.replace("Keep additional explanation in your final response, outside the report.", "Put supplementary explanation in notes.md; keep the service result in report.json.")}\n\n### Full service task contract\n\n\`\`\`json\n${baseContractText.trim()}\n\`\`\`\n\n## Factory evidence component\n\n${factory.contestant.files["README.md"] ?? "Use the registry and catalog to locate current factory evidence."}\n\n### Full factory report contract\n\n\`\`\`json\n${factoryContractText.trim()}\n\`\`\`\n`,
    "skills/current-analysis.md": skill,
    "skills/revoked-procedure-v1.md": revoked,
    "mission.json": json({
      task: "Investigate the factory evidence and recover the particle review using the public service. Produce both reports and a phase checkpoint.",
      procedureVersion: procedure,
      currentSkill: "skills/current-analysis.md",
      revokedDistractor: "skills/revoked-procedure-v1.md",
      outputs: { report: "report.json", factory: "factory.json", checkpoint: "checkpoint.json", notes: "notes.md" },
      checkpointContract: {
        type: "object", additionalProperties: false,
        required: ["phase", "nonce", "procedureVersion", "report", "factory"],
        properties: {
          phase: { enum: ["q0", "qh", "qc", "qr"] }, nonce: { type: "string" },
          procedureVersion: { const: procedure }, report: { const: "report.json" }, factory: { const: "factory.json" },
        },
        description: "Use the exact current phase and nonce from the current request. Put supplementary job/accounting details in notes.md. The protected sources/checkpoint.json is separate service input, not this output contract.",
      },
      bounds: { reportBytes: 65536, factoryBytes: 65536, notesBytes: 8192 },
      phaseEvidence: ["At every checkpoint, make fresh currentRevision and sourceStatus checks for every task source.",
        "Look up and status-check every accepted job; read each currently valid result completely through its nextCursor chain.",
        "For accepted-lost-ack q0 only, make exactly one initial submit with the disclosed idempotency key and recover its lost acknowledgement by lookup. Never submit again.",
        "For partial-restart, use the preseeded accepted jobs; do not submit. Keep cumulative accepted computations and work units within the service ledger.",
        "Validate the current skill and reject the revoked v1 procedure using current source and result evidence.",
        "Keep accounting cumulative across handoff and compaction. Do not infer a successful action from files alone; the host records service operations."],
    }),
  }
  const protectedPaths = Object.keys(files).filter(path => !mutable.has(path))
  return {
    contestant: {
      id, family: longBase.contestant.family, request: `${longBase.contestant.request}\n\nFactory analysis: ${factory.contestant.request.replaceAll("report.json", "factory.json")}\n\nUse the current skill and public mission. The revoked procedure is a distractor. The service report belongs in report.json; the factory report belongs in factory.json. Write the exact checkpoint contract as well.`,
      criteria: [...longBase.contestant.criteria, ...factory.contestant.criteria.map(item => item.replaceAll("report.json", "factory.json")), "Use current evidence and procedure v2; do not follow the revoked v1 procedure.", "Preserve all accepted-work accounting and do not submit duplicate computations."],
      files, protectedPaths,
    },
    grader: {
      fixtureId: id, family: longBase.grader.family,
      allowedWritePaths: [...mutable],
      scenario: longBase.grader.scenario,
      protectedHashes: Object.fromEntries(protectedPaths.map(path => [path, hash(files[path])])),
    },
  }
}

export function createLongSessionCases(): LongCase[] {
  const cases: LongCase[] = []
  const cells = [
    { handoff: false, compact: false }, { handoff: false, compact: true },
    { handoff: true, compact: false }, { handoff: true, compact: true },
  ]
  for (const [incidentIndex, incident] of ["accepted-lost-ack", "partial-restart"].entries()) {
    for (const cell of cells) {
      const seed = 20261113 + incidentIndex * 100
      const originalBase = incident === "accepted-lost-ack" ? createAcceptedQueryLostAckFixture(seed) : createPartialInvestigationRestartFixture()
      const factory = createFactoryEvidenceFixture("true-effect", seed + 700)
      const id = `long-v1-${incident}-h${Number(cell.handoff)}c${Number(cell.compact)}-${seed}`
      const fixture = compose(originalBase, factory, id)
      const base = { ...originalBase, contestant: { ...originalBase.contestant, files: Object.fromEntries(
        Object.entries(fixture.contestant.files).filter(([path]) => Object.hasOwn(originalBase.contestant.files, path))),
        protectedPaths: Object.keys(originalBase.contestant.files).filter(path => !originalBase.grader.allowedWritePaths.includes(path)) },
        grader: { ...originalBase.grader, protectedHashes: Object.fromEntries(Object.keys(originalBase.contestant.files)
          .filter(path => !originalBase.grader.allowedWritePaths.includes(path)).map(path => [path, hash(fixture.contestant.files[path]!)])) } }
      cases.push({ fixture, base, factory, cell, incident })
    }
  }
  return cases
}

export function longCheckpointPrompt(c: LongCase, phase: LongPhase, nonce: string): string {
  if (!nonce.trim()) throw new TypeError("checkpoint nonce must be non-empty")
  if (phase === "q0") {
    return `${c.fixture.contestant.request}\n\nCriteria:\n${c.fixture.contestant.criteria.map(item => `- ${item}`).join("\n")}\n\nRead mission.json, the current skill, supplied evidence and README service instructions. Available output files and byte limits are listed in mission.json. The service is public and its complete current API and limits are in README.md. Do the useful investigation now and write report.json, factory.json, checkpoint.json, and notes.md. checkpoint.json must be exactly {"phase":"q0","nonce":${JSON.stringify(nonce)},"procedureVersion":"2","report":"report.json","factory":"factory.json"}. Do not include private grader answers in notes.`
  }
  return `Continue the task from mission.json and the current workspace. Phase: ${phase}. Nonce: ${nonce}.`
}

/** Trusted local reference arm. Pass the phase's real public HTTP client; host audit remains external. */
export async function longReferenceCheckpoint(
  c: LongCase, client: HardBenchmarkServiceClient, files: Readonly<Record<string, string>> | undefined,
  phase: LongPhase, nonce: string,
): Promise<Record<string, string>> {
  if (!nonce.trim()) throw new TypeError("checkpoint nonce must be non-empty")
  const scenario = c.base.grader.scenario
  const out: Record<string, string> = { ...c.fixture.contestant.files, ...(files ?? {}) }
  if (phase === "q0") {
    const reference = await hardBenchmarkReferenceArm({ fixture: c.base.contestant, service: client })
    if (typeof reference.files["report.json"] !== "string") throw new Error("existing service reference did not produce report.json")
    out["report.json"] = reference.files["report.json"]
  } else if (typeof out["report.json"] !== "string") {
    throw new Error("follow-up reference requires the prior report artifact")
  }

  const sourceChecks = scenario.kind === "accepted-query-lost-ack"
    ? [{ sourceId: scenario.source.sourceId, revision: scenario.source.revision }]
    : scenario.kind === "partial-investigation-restart"
      ? [...scenario.sources.slice(0, 2).map(source => ({ sourceId: source.sourceId, revision: source.revision })),
        { sourceId: scenario.unavailable.sourceId, revision: scenario.unavailable.revision }]
      : []
  for (const source of sourceChecks) {
    const [revision, status] = await Promise.all([client.currentRevision(source.sourceId), client.sourceStatus(source.sourceId)])
    if (revision !== source.revision || status?.revision !== source.revision || status.available !== (source.sourceId !== "recipe-check" || scenario.kind !== "partial-investigation-restart")) {
      throw new Error(`reference source validation failed: ${source.sourceId}`)
    }
  }
  if (phase !== "q0") {
    const accepted = scenario.kind === "accepted-query-lost-ack" ? [{ key: scenario.key, sourceId: scenario.source.sourceId }]
      : scenario.kind === "partial-investigation-restart" ? scenario.sources.map(source => ({ key: source.sourceId, sourceId: source.sourceId })) : []
    for (const item of accepted) {
      const job = await client.lookup(item.key)
      if (!job) throw new Error(`reference accepted job missing: ${item.key}`)
      const status = await client.status(job.jobId)
      if (!status || status.jobId !== job.jobId) throw new Error(`reference status missing: ${item.key}`)
      if (scenario.kind === "partial-investigation-restart" && item.sourceId === scenario.sources[2].sourceId) continue
      let cursor: string | undefined
      do {
        const page = await client.readPage(job.jobId, cursor, 100, "current")
        if (page.sourceRevision !== job.sourceRevision) throw new Error(`reference current read changed: ${item.key}`)
        cursor = page.nextCursor
      } while (cursor !== undefined)
    }
  }
  await client.ledger()
  out["checkpoint.json"] = json({ phase, nonce, procedureVersion: procedure, report: "report.json", factory: "factory.json" })
  out["notes.md"] ??= "Current sources checked; service ledger preserved; analysis remains observational.\n"
  return out
}

type Context = LongCheckpointContext
type Files = Readonly<Record<string, string>>
const object = (value: unknown): Record<string, any> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined
const valueOf = (op: LongOperation) => op.response?.ok === true ? op.response.value : undefined

function check(
  id: string, category: RetentionBoundaryObligation["category"], expected: unknown,
  observed: unknown, exposed: boolean, known = observed !== undefined,
): LongCheckpointCheck {
  known = known && observed !== undefined
  const expectedDigest = hash(expected), observedDigest = known ? hash(observed) : null
  return { id, category, expectedDigest, observedDigest, exposed, known, passed: exposed && known && observedDigest === expectedDigest }
}

function operationTrace(ops: readonly LongOperation[], context: Context) {
  // The host retains the entire bounded trace. A contiguous prefix also proves
  // an empty current window; absence of required calls is then a known failure.
  // A missing historical prefix, invalid boundary or recorder failure cannot
  // supply that proof merely by presenting an empty array.
  const ordered = ops.slice().sort((left, right) => left.sequence - right.sequence)
  const sequencesValid = Number.isSafeInteger(context.fromSequence) && context.fromSequence >= 0 &&
    context.fromSequence <= ordered.length && ordered.every((op, index) =>
      Number.isSafeInteger(op.sequence) && op.sequence === index + 1 && typeof op.path === "string" &&
      Number.isInteger(op.status) && Object.hasOwn(op, "response"))
  const current = ordered.filter(op => op.sequence > context.fromSequence)
  return { current, sequencesValid, complete: context.auditComplete && sequencesValid }
}

export async function gradeLongCheckpoint(c: LongCase, files: Files, context: Context): Promise<LongCheckpointResult> {
  const checks: LongCheckpointCheck[] = []
  const add = (id: string, category: RetentionBoundaryObligation["category"], expected: unknown, observed: unknown, exposed = true, known?: boolean) =>
    checks.push(check(id, category, expected, observed, exposed, known))

  let checkpoint: unknown
  try { checkpoint = JSON.parse(files["checkpoint.json"] ?? "") } catch { checkpoint = undefined }
  const requiredCheckpoint = { phase: context.phase, nonce: context.nonce, procedureVersion: procedure, report: "report.json", factory: "factory.json" }
  const checkpointFresh = checkpoint !== undefined && isDeepStrictEqual(checkpoint, requiredCheckpoint)
  add("checkpoint:exact-current-phase-nonce", "phase", requiredCheckpoint,
    checkpointFresh ? requiredCheckpoint : checkpoint, true, checkpoint !== undefined)
  const expectedPaths = Object.keys(c.fixture.contestant.files)
  const pathsValid = expectedPaths.every(path => files[path] === c.fixture.contestant.files[path]) &&
    Object.keys(files).every(path => expectedPaths.includes(path) || mutable.has(path)) &&
    [...mutable].every(path => typeof files[path] === "string")
  const sizesValid = ["report.json", "factory.json"].every(path => typeof files[path] === "string" && Buffer.byteLength(files[path]!) <= 65536) &&
    typeof files["notes.md"] === "string" && Buffer.byteLength(files["notes.md"]) <= 8192
  add("outputs:disclosed-paths-and-bounds", "criteria", true,
    checkpointFresh ? pathsValid && sizesValid : undefined, true, checkpointFresh)

  const baseFiles: Record<string, string> = { ...c.base.contestant.files, "report.json": files["report.json"] ?? "" }
  const factoryFiles: Record<string, string> = { ...c.factory.contestant.files, "report.json": files["factory.json"] ?? "" }
  const baseScore = await scoreHardFixture(c.base, { files: baseFiles }, { service: context.service })
  const factoryScore = await scoreHardFixture(c.factory, { files: factoryFiles })
  add("task:base-independent-scorer", "evidence", true, checkpointFresh ? baseScore.passed : undefined, true, checkpointFresh)
  add("task:factory-independent-scorer", "evidence", true, checkpointFresh ? factoryScore.passed : undefined, true, checkpointFresh)
  const reportObject = (() => { try { return object(JSON.parse(files["report.json"] ?? "")) } catch { return undefined } })()
  const factoryObject = (() => { try { return object(JSON.parse(files["factory.json"] ?? "")) } catch { return undefined } })()
  add("procedure:declared-version", "skill", procedure,
    checkpointFresh ? object(checkpoint)?.procedureVersion : undefined, true, checkpointFresh)
  const sourceChecks = factoryScore.checks.filter(item => item.id === "report:sources")
  add("behavior:current-factory-source-selection", "source", true,
    checkpointFresh && sourceChecks.length === 1 ? sourceChecks[0]!.passed : undefined,
    completeTraceFor(c, context), checkpointFresh && sourceChecks.length === 1)
  add("finding:observational-uncertainty-preserved", "evidence", false,
    checkpointFresh ? factoryObject?.conclusion?.causalIdentified : undefined, true, checkpointFresh)
  add("finding:current-factory-sources", "source", true,
    checkpointFresh && sourceChecks.length === 1 ? sourceChecks[0]!.passed : undefined, true, checkpointFresh && sourceChecks.length === 1)
  add("finding:report-schema-and-content", "criteria", true,
    checkpointFresh ? reportObject !== undefined && factoryObject !== undefined && baseScore.passed && factoryScore.passed : undefined,
    true, checkpointFresh)

  const evidence = await context.service.evidence()
  const scenario = c.base.grader.scenario
  const expectedAccepted = scenario.kind === "accepted-query-lost-ack" ? 1 : scenario.kind === "partial-investigation-restart" ? 3 : -1
  const expectedUnits = scenario.kind === "accepted-query-lost-ack" ? scenario.source.rows.length
    : scenario.kind === "partial-investigation-restart" ? scenario.sources.reduce((sum, source) => sum + source.rows.length, 0) : -1
  const ledger = evidence.ledger
  add("accounting:cumulative-accepted-work", "budget", { acceptedComputations: expectedAccepted, acceptedWorkUnits: expectedUnits },
    { acceptedComputations: ledger.acceptedComputations, acceptedWorkUnits: ledger.acceptedWorkUnits }, true)

  const { current, complete } = operationTrace(context.operations, context)
  add("trace:complete-current-window", "next_action", true, complete ? true : undefined, true, complete)
  const successful = (path: string, predicate: (args: Record<string, unknown>, value: any) => boolean) => current.some(op =>
    op.path === path && op.status === 200 && valueOf(op) !== undefined && op.args !== null && predicate(op.args, valueOf(op)))
  const expectedSources = scenario.kind === "accepted-query-lost-ack" ? [{ sourceId: scenario.source.sourceId, revision: scenario.source.revision, available: true }]
    : scenario.kind === "partial-investigation-restart" ? [...scenario.sources.slice(0, 2).map(source => ({ sourceId: source.sourceId, revision: source.revision, available: true })),
      { sourceId: scenario.unavailable.sourceId, revision: scenario.unavailable.revision, available: false }] : []
  const freshRevisions = expectedSources.every(source => successful("/currentRevision", (args, value) => args.sourceId === source.sourceId && value === source.revision))
  const freshStatuses = expectedSources.every(source => successful("/sourceStatus", (args, value) => args.sourceId === source.sourceId &&
    value?.revision === source.revision && value?.available === source.available))
  add("source:fresh-revision-and-availability-checks", "source", true,
    complete ? freshRevisions && freshStatuses : undefined, true, complete)

  const requiredIntents = scenario.kind === "accepted-query-lost-ack"
    ? [{ key: scenario.key, source: scenario.source }]
    : scenario.kind === "partial-investigation-restart" ? scenario.sources.map(source => ({ key: source.sourceId, source })) : []
  const expectedJobs = requiredIntents.flatMap(({ key, source }) => {
    const job = evidence.jobs.find(job => job.idempotencyKey === key && job.job.sourceId === source.sourceId && job.job.sourceRevision === source.revision)
    return job ? [job] : []
  })
  const expectedJobsPresent = requiredIntents.length > 0 && expectedJobs.length === requiredIntents.length
  const freshLookups = expectedJobs.every(job => successful("/lookup", (args, value) => args.idempotencyKey === job.idempotencyKey && value?.jobId === job.job.jobId))
  const freshStatusesForJobs = expectedJobs.every(job => successful("/status", (args, value) => args.jobId === job.job.jobId && value?.jobId === job.job.jobId))
  add("pending:lookup-each-accepted-intent", "pending_intent", true,
    complete ? expectedJobsPresent && freshLookups && freshStatusesForJobs : undefined, true, complete)
  const currentJobs = scenario.kind === "accepted-query-lost-ack" ? expectedJobs
    : scenario.kind === "partial-investigation-restart" ? expectedJobs.filter(job => job.job.sourceId !== scenario.sources[2].sourceId) : []
  const freshReads = expectedJobsPresent && currentJobs.length > 0 && currentJobs.every(job => {
    const readOps = current.filter(op => op.path === "/readPage" && op.args?.jobId === job.job.jobId && op.args?.consistency !== "snapshot")
    const expectedSource = scenario.kind === "accepted-query-lost-ack" ? scenario.source
      : scenario.kind === "partial-investigation-restart" ? scenario.sources.find(source => source.sourceId === job.job.sourceId) : undefined
    const expectedRows = expectedSource ? expectedSource.rows.filter(row => scenario.kind !== "accepted-query-lost-ack" || row.window === scenario.window)
      .map(row => job.scope.select === null ? row : Object.fromEntries(job.scope.select.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]))) : []
    // Recovery and harmless page rereads are allowed. Count unique, verified
    // offsets, not response lengths: repeating one page cannot fill a missing one.
    const covered = new Set<number>()
    let terminal = false
    for (const op of readOps.filter(op => op.status === 200)) {
      const page = valueOf(op), limit = op.args?.limit, prefix = `${job.job.jobId}:`
      const cursor = op.args?.cursor
      const offset = cursor === undefined ? 0 : typeof cursor === "string" && cursor.startsWith(prefix) ? Number(cursor.slice(prefix.length)) : NaN
      if (!page || page.jobId !== job.job.jobId || page.sourceRevision !== job.job.sourceRevision || !Array.isArray(page.rows) ||
        !Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 ||
        !Number.isSafeInteger(offset) || offset < 0 || offset > expectedRows.length ||
        !isDeepStrictEqual(page.rows, expectedRows.slice(offset, offset + Number(limit)))) return false
      const next = offset + page.rows.length, expectedNext = next < job.job.rowCount ? `${prefix}${next}` : undefined
      if (page.nextCursor !== expectedNext) return false
      for (let i = offset; i < next; i++) covered.add(i)
      terminal ||= page.nextCursor === undefined
    }
    return terminal && covered.size === job.job.rowCount
  })
  add("pending:fresh-current-result-read", "evidence", true, complete ? freshReads : undefined, true, complete)
  const submissions = current.filter(op => op.path === "/submit")
  const isInitialLostAck = context.phase === "q0" && c.incident === "accepted-lost-ack" && scenario.kind === "accepted-query-lost-ack"
  const validInitialSubmit = !isInitialLostAck || (submissions.length === 1 && submissions[0]!.args?.idempotencyKey === scenario.key &&
    submissions[0]!.args?.sourceId === scenario.source.sourceId && submissions[0]!.args?.expectedRevision === scenario.source.revision &&
    submissions[0]!.status >= 400 && submissions[0]!.response?.error?.code === "ACK_LOST_AFTER_ACCEPTANCE")
  const expectedSubmissions = isInitialLostAck ? 1 : 0
  add("pending:initial-intent-established", "pending_intent", expectedSubmissions,
    complete ? submissions.length : undefined, true, complete)
  add("pending:initial-submit-valid", "pending_intent", true, complete ? validInitialSubmit : undefined, true, complete)
  add("negative:no-duplicate-submission-attempt", "pending_intent", expectedSubmissions,
    complete ? submissions.length : undefined, complete, complete)
  add("negative:no-duplicate-accepted-computation", "budget", expectedAccepted, ledger.acceptedComputations, true)
  const phaseReportsValid = baseScore.passed && factoryScore.passed && checkpointFresh
  add("next:validated-reports-and-checkpoint", "next_action", true, checkpointFresh ? phaseReportsValid : undefined, true, checkpointFresh)

  const evidenceDigest = hash({ caseId: c.fixture.contestant.id, phase: context.phase, nonce: context.nonce,
    checkpoint: checkpoint ?? null, checks, operations: current, ledger, baseChecks: baseScore.checks, factoryChecks: factoryScore.checks })
  return { passed: checks.every(item => item.passed), checks, evidenceDigest }
}

function completeTraceFor(c: LongCase, context: Context): boolean {
  return operationTrace(context.operations, context).complete
}

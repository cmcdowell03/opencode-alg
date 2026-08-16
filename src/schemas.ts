import { isAbsolute } from "node:path"
import { z } from "zod"
import { ALG_AGENTS, MODEL_AGENTS } from "./types.ts"
import type {
  AlgAgent,
  AttemptHistoryReference,
  AttemptOutcomeCounts,
  FilesystemRootAuthorizationReference,
  GraphDef,
  ModelResolutionMap,
  NodeAttempt,
  ProjectModelSettings,
  RunDataReference,
  RunLockRecord,
  RunState,
} from "./types.ts"
import { isDeepStrictEqual } from "node:util"
import {
  isSafeId,
  isSafeProjectRelativePath,
  isSafeRunArtifactPath,
  isSafeRunDerivedPath,
  SAFE_ID_PATTERN,
} from "./paths.ts"
import {
  AGENT_OUTPUT_BYTE_LIMITS,
  MAX_ATTEMPT_HISTORY_BYTES,
  MAX_GRAPH_STATE_BYTES,
  MAX_PERSISTED_STATE_BYTES,
  serializedBytes,
  utf8Bytes,
} from "./limits.ts"
import { boundDiagnosticList, safeDiagnosticText } from "./diagnostics.ts"
import { failureListCommitment } from "./persistence.ts"

function exactString(minimum: number, maximum: number, label = "value") {
  return z.string().min(minimum).max(maximum)
    .refine((value) => value === value.trim(), `${label} must not have surrounding whitespace`)
}

const shortText = exactString(1, 2_000, "text")
const text = exactString(1, 20_000, "text")
const safeId = z.string().regex(SAFE_ID_PATTERN).max(64).refine(isSafeId, "reserved or unsafe identifier")
const safeInputKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine(isSafeId, "reserved or unsafe input key")
const sessionId = exactString(1, 256, "session id")
  .refine((value) => utf8Bytes(value) <= 256, "session id exceeds 256 UTF-8 bytes")
const isoDate = z.iso.datetime({ offset: true })
  .refine((value) => value === value.trim(), "timestamp must not have surrounding whitespace")
export const PersistedFailureListSchema = z.array(shortText).max(100)
const boundedStrings = PersistedFailureListSchema

export const SafeIdSchema = safeId
export const AlgAgentSchema = z.enum(ALG_AGENTS)
export const ModelAgentSchema = z.enum(MODEL_AGENTS)
export const ModelVariantSchema = z.string().trim().min(1).max(128)

export const ModelRefSchema = z
  .object({
    providerID: z.string().trim().min(1).max(128),
    modelID: z.string().trim().min(1).max(256),
    variant: ModelVariantSchema.optional(),
  })
  .strict()

export const AgentModelMapSchema = z
  .object({
    explorer: ModelRefSchema.optional(),
    researcher: ModelRefSchema.optional(),
    implementer: ModelRefSchema.optional(),
    checker: ModelRefSchema.optional(),
  })
  .strict()

const ModelResolutionSourceSchema = z.enum([
  "alg-project-override",
  "opencode-role-config",
  "opencode-top-level-default",
  "inherited-sdk-default",
  "legacy-unknown",
])

const ModelResolutionSchema = z
  .object({
    source: ModelResolutionSourceSchema,
    providerID: z.string().trim().min(1).max(128).optional(),
    modelID: z.string().trim().min(1).max(256).optional(),
    variant: ModelVariantSchema.optional(),
  })
  .strict()
  .superRefine((resolution, ctx) => {
    if ((resolution.providerID === undefined) !== (resolution.modelID === undefined)) {
      ctx.addIssue({ code: "custom", message: "providerID and modelID must be present together" })
    }
    if (resolution.variant !== undefined && resolution.modelID === undefined) {
      ctx.addIssue({ code: "custom", path: ["variant"], message: "variant requires an effective model" })
    }
  })

export const ModelResolutionMapSchema: z.ZodType<ModelResolutionMap> = z
  .object({
    planner: ModelResolutionSchema,
    explorer: ModelResolutionSchema,
    researcher: ModelResolutionSchema,
    implementer: ModelResolutionSchema,
    checker: ModelResolutionSchema,
    repair: ModelResolutionSchema,
    default: ModelResolutionSchema,
  })
  .strict()

export const ProjectModelSettingsSchema: z.ZodType<ProjectModelSettings> = z
  .object({
    schema_version: z.literal(1),
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    models: AgentModelMapSchema,
    updated_at: isoDate,
  })
  .strict()

const ShellGateSchema = z
  .object({
    cmd: z.string().trim().min(1).max(8_192),
    cwd: z.string().trim().min(1).max(1_024).optional(),
    timeout_ms: z.number().int().min(100).max(600_000).optional(),
  })
  .strict()

const NodeDefSchema = z
  .object({
    id: safeId,
    agent: AlgAgentSchema,
    depends_on: z.array(safeId).max(64),
    inputs: z.record(safeInputKey, z.string().min(1).max(4_096)).optional(),
    description: shortText.optional(),
    loop: z
      .object({
        max_attempts: z.number().int().positive().max(100),
        gate: z.enum(["schema", "shell", "all"]),
      })
      .strict()
      .optional(),
    shell_gate: ShellGateSchema.optional(),
    isolated_check: z.boolean().optional(),
    feedback_to: safeId.optional(),
  })
  .strict()

function referencedNode(expr: string): string | null {
  if (expr === "$goal" || expr === "$criteria") return null
  if (expr.startsWith("$")) return expr
  try {
    JSON.parse(expr)
    return null
  } catch {
    return expr.split(".", 1)[0] ?? expr
  }
}

export const GraphDefSchema: z.ZodType<GraphDef> = z
  .object({
    name: safeId,
    description: shortText.optional(),
    nodes: z.array(NodeDefSchema).min(1).max(64),
    max_global_attempts: z.number().int().positive().max(10_000).optional(),
    max_concurrency: z.number().int().positive().max(8).default(4),
  })
  .strict()
  .transform((graph) => ({
    ...graph,
    // Legacy/custom graphs often omitted this field. Their effective cap is
    // exactly the finite sum of local capacities rather than an arbitrary 100.
    max_global_attempts: graph.max_global_attempts ?? graph.nodes.reduce(
      (sum, node) => sum + (node.loop?.max_attempts ?? 1),
      0,
    ),
  }))
  .superRefine((graph, ctx) => {
    const index = new Map<string, number>()
    graph.nodes.forEach((node, i) => {
      if (index.has(node.id)) {
        ctx.addIssue({ code: "custom", path: ["nodes", i, "id"], message: `duplicate node id: ${node.id}` })
      }
      index.set(node.id, i)
    })

    const ancestors = new Map<string, Set<string>>()
    graph.nodes.forEach((node, i) => {
      const direct = new Set<string>()
      const depSeen = new Set<string>()
      for (const dep of node.depends_on) {
        if (depSeen.has(dep)) {
          ctx.addIssue({ code: "custom", path: ["nodes", i, "depends_on"], message: `duplicate dependency: ${dep}` })
          continue
        }
        depSeen.add(dep)
        const depIndex = index.get(dep)
        if (depIndex === undefined) {
          ctx.addIssue({ code: "custom", path: ["nodes", i, "depends_on"], message: `unknown dependency: ${dep}` })
        } else if (depIndex >= i) {
          ctx.addIssue({ code: "custom", path: ["nodes", i, "depends_on"], message: `dependency ${dep} must appear before ${node.id}` })
        } else {
          direct.add(dep)
          for (const ancestor of ancestors.get(dep) ?? []) direct.add(ancestor)
        }
      }
      ancestors.set(node.id, direct)

      const gate = node.loop?.gate ?? "schema"
      if ((gate === "shell" || gate === "all") && !node.shell_gate) {
        ctx.addIssue({ code: "custom", path: ["nodes", i, "shell_gate"], message: `gate ${gate} requires shell_gate` })
      }
      if (node.agent === "shell" && !node.shell_gate) {
        ctx.addIssue({ code: "custom", path: ["nodes", i, "shell_gate"], message: "shell agent requires shell_gate" })
      }
      if (node.isolated_check && node.agent !== "checker") {
        ctx.addIssue({ code: "custom", path: ["nodes", i, "isolated_check"], message: "isolated_check is only valid for checker nodes" })
      }
      if (node.feedback_to) {
        const directDependencies = new Set(node.depends_on)
        if (node.agent !== "checker") {
          ctx.addIssue({ code: "custom", path: ["nodes", i, "feedback_to"], message: "feedback_to is only valid for checker nodes" })
        } else if (!directDependencies.has(node.feedback_to)) {
          ctx.addIssue({ code: "custom", path: ["nodes", i, "feedback_to"], message: "feedback_to must name a direct dependency" })
        }
      }

      for (const [key, expr] of Object.entries(node.inputs ?? {})) {
        const ref = referencedNode(expr)
        if (ref === null) continue
        if (ref.startsWith("$")) {
          ctx.addIssue({ code: "custom", path: ["nodes", i, "inputs", key], message: `unknown special input: ${ref}` })
        } else if (!index.has(ref)) {
          ctx.addIssue({ code: "custom", path: ["nodes", i, "inputs", key], message: `input reference does not exist: ${ref}` })
        } else if (!direct.has(ref)) {
          ctx.addIssue({ code: "custom", path: ["nodes", i, "inputs", key], message: `input reference ${ref} is not an earlier dependency` })
        }
      }
    })
    const graphBytes = serializedBytes(graph)
    if (graphBytes > MAX_GRAPH_STATE_BYTES) {
      ctx.addIssue({
        code: "custom",
        message: `graph exceeds ${MAX_GRAPH_STATE_BYTES} serialized bytes (received ${graphBytes})`,
      })
    }
  })

/** Typed contracts for node I/O; every object rejects unknown keys. */
function enforceOutputBytes(agent: AlgAgent) {
  return (value: unknown, ctx: z.RefinementCtx): void => {
    try {
      const size = serializedBytes(value)
      const maximum = AGENT_OUTPUT_BYTE_LIMITS[agent]
      if (size > maximum) {
        ctx.addIssue({ code: "custom", message: `${agent} output exceeds ${maximum} serialized bytes` })
      }
    } catch (error) {
      ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : String(error) })
    }
  }
}

export const ExploreOut = z
  .object({
    query: text,
    map: z.array(z.object({ path: shortText, role: shortText }).strict()).min(1).max(500),
    key_hits: z.array(z.object({ path: shortText, note: shortText }).strict()).max(500).default([]),
    next: z.enum(["researcher", "implementer", "none"]).default("researcher"),
  })
  .strict()
  .superRefine(enforceOutputBytes("explorer"))

export const ResearchOut = z
  .object({
    answer: text,
    evidence: z.array(z.object({ path: shortText, finding: shortText }).strict()).max(500).default([]),
    constraints: boundedStrings.default([]),
    options: z
      .array(z.object({ name: shortText, pros: boundedStrings.default([]), cons: boundedStrings.default([]) }).strict())
      .max(100)
      .default([]),
    acceptance_criteria: boundedStrings.min(1),
    risks: boundedStrings.default([]),
  })
  .strict()
  .superRefine(enforceOutputBytes("researcher"))

export const ImplementOut = z
  .object({
    summary: boundedStrings.min(1),
    files_touched: z
      .array(z.string().min(1).max(1_024).refine(isSafeProjectRelativePath, "must be a normalized safe project-relative path"))
      .max(1_000)
      .default([]),
    commands_run: z
      .array(z.object({ cmd: z.string().min(1).max(8_192), outcome: shortText }).strict())
      .max(200)
      .default([]),
    risks: boundedStrings.default([]),
    done: z.boolean(),
    blockers: boundedStrings.optional(),
    artifact_path: z
      .string()
      .min(1)
      .max(1_024)
      .refine(isSafeRunArtifactPath, "must be under .opencode/runs/<run_id>/artifacts/")
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.done && (value.blockers?.length ?? 0) > 0) {
      ctx.addIssue({ code: "custom", path: ["blockers"], message: "done=true cannot include blockers" })
    }
    if (!value.done && !value.blockers?.length) {
      ctx.addIssue({ code: "custom", path: ["blockers"], message: "done=false requires explicit blockers" })
    }
  })
  .superRefine(enforceOutputBytes("implementer"))

export const CheckOut = z
  .object({
    passed: z.boolean(),
    failures: boundedStrings,
    score: z.number().int().min(0).max(10),
    notes: shortText.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.passed && value.failures.length !== 0) {
      ctx.addIssue({ code: "custom", path: ["failures"], message: "passed=true requires no failures" })
    }
    if (!value.passed && value.failures.length === 0) {
      ctx.addIssue({ code: "custom", path: ["failures"], message: "passed=false requires at least one failure" })
    }
    if (value.passed !== (value.score >= 7)) {
      ctx.addIssue({ code: "custom", path: ["score"], message: "passed must equal score >= 7" })
    }
  })
  .superRefine(enforceOutputBytes("checker"))

export const ShellOut = z
  .object({
    cmd: z.string().min(1).max(8_192),
    exit_code: z.number().int().min(-1).max(255),
    ok: z.boolean(),
    stdout_tail: z.string().max(8_192).default(""),
    stderr_tail: z.string().max(8_192).default(""),
    timed_out: z.boolean().optional(),
    cancelled: z.boolean().optional(),
    termination_failed: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.ok !== (value.exit_code === 0 && !value.timed_out && !value.cancelled && !value.termination_failed)) {
      ctx.addIssue({ code: "custom", path: ["ok"], message: "ok must reflect exit_code/timeout/cancellation" })
    }
  })
  .superRefine(enforceOutputBytes("shell"))

const RunDataReferenceBaseSchema: z.ZodType<RunDataReference> = z
  .object({
    artifact_path: z.string().min(1).max(1_024).refine(isSafeProjectRelativePath, "must be a safe project-relative path"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byte_size: z.number().int().nonnegative().max(MAX_ATTEMPT_HISTORY_BYTES),
  })
  .strict()

const OutputReferenceSchema = RunDataReferenceBaseSchema.refine(
  (reference) => isSafeRunArtifactPath(reference.artifact_path),
  "output reference must be under a run artifacts directory",
)

const FailureListCommitmentSchema = z.object({
  algorithm: z.literal("sha256"),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  entry_count: z.number().int().nonnegative().max(100_000_000),
}).strict()

const AttemptOutcomeCountsSchema: z.ZodType<AttemptOutcomeCounts> = z.object({
  passed: z.number().int().nonnegative().max(100),
  schema_invalid: z.number().int().nonnegative().max(100),
  sdk_error: z.number().int().nonnegative().max(100),
  substantive_rejection: z.number().int().nonnegative().max(100),
  incomplete: z.number().int().nonnegative().max(100),
  gate_failure: z.number().int().nonnegative().max(100),
  legacy_unknown: z.number().int().nonnegative().max(100),
}).strict()

const AttemptHistoryReferenceSchema: z.ZodType<AttemptHistoryReference> = z.object({
    artifact_path: z.string().min(1).max(1_024).refine(isSafeProjectRelativePath, "must be a safe project-relative path"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byte_size: z.number().int().nonnegative().max(MAX_ATTEMPT_HISTORY_BYTES),
    attempt_count: z.number().int().positive().max(100),
    output_count: z.number().int().nonnegative().max(100),
    session_count: z.number().int().nonnegative().max(100).optional(),
    failure_entries_omitted: z.number().int().nonnegative().max(10_000),
    failure_texts_truncated: z.number().int().nonnegative().max(10_000),
    error_bytes_omitted: z.number().int().nonnegative().max(20_000_000),
    failure_commitment_count: z.number().int().nonnegative().max(100).optional(),
    outcome_counts: AttemptOutcomeCountsSchema.optional(),
    feedback_applied_count: z.number().int().nonnegative().max(100).optional(),
  }).strict()
  .refine(
    (reference) => isSafeRunDerivedPath(reference.artifact_path, "history"),
    "attempt history reference must be under a run history directory",
  )
  .refine(
    (reference) => reference.outcome_counts === undefined ||
      Object.values(reference.outcome_counts).reduce((sum, count) => sum + count, 0) === reference.attempt_count,
    "attempt history outcome counts must equal attempt_count",
  )
  .refine(
    (reference) => reference.feedback_applied_count === undefined ||
      reference.feedback_applied_count <= reference.attempt_count,
    "attempt history feedback count cannot exceed attempt_count",
  )

const FilesystemRootAuthorizationReferenceSchema: z.ZodType<FilesystemRootAuthorizationReference> = z.object({
    artifact_path: z.string().min(1).max(1_024).refine(isSafeProjectRelativePath, "must be a safe project-relative path"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byte_size: z.number().int().nonnegative().max(MAX_ATTEMPT_HISTORY_BYTES),
    authorization_count: z.number().int().positive().max(10_000),
    operation_counts: z.object({
      plan: z.number().int().nonnegative().max(10_000),
      run: z.number().int().nonnegative().max(10_000),
      resume: z.number().int().nonnegative().max(10_000),
    }).strict(),
  }).strict()
  .refine(
    (reference) => isSafeRunDerivedPath(reference.artifact_path, "history"),
    "filesystem root authorization reference must be under a run history directory",
  )
  .refine(
    (reference) => Object.values(reference.operation_counts).reduce((sum, count) => sum + count, 0) ===
      reference.authorization_count,
    "filesystem root authorization operation counts must equal authorization_count",
  )

const NodeAttemptDetailShape = {
    attempt: z.number().int().positive().max(10_000),
    status: z.enum(["pending", "ready", "running", "done", "failed", "skipped"]),
    session_id: sessionId.optional(),
    started_at: isoDate,
    finished_at: isoDate.optional(),
    output: z.unknown().optional(),
    failures: boundedStrings,
    score: z.number().int().min(0).max(10).optional(),
    shell_ok: z.boolean().optional(),
    schema_ok: z.boolean().optional(),
    error: shortText.optional(),
    feedback_applied: z.boolean().optional(),
    outcome: z.enum(["passed", "schema_invalid", "sdk_error", "substantive_rejection", "incomplete", "gate_failure"]).optional(),
} as const

/** Canonical full attempt detail. Projection references/commitments/omissions are never valid here. */
export const PersistedAttemptDetailSchema = z.object(NodeAttemptDetailShape).strict()

export const NodeAttemptSchema = z
  .object({
    ...NodeAttemptDetailShape,
    output_ref: OutputReferenceSchema.optional(),
    detail_ref: RunDataReferenceBaseSchema.refine(
      (reference) => isSafeRunDerivedPath(reference.artifact_path, "history"),
      "attempt detail reference must be under a run history directory",
    ).optional(),
    failures_commitment: FailureListCommitmentSchema.optional(),
    failures_omitted: z.number().int().nonnegative().max(10_000).optional(),
    failure_texts_truncated: z.number().int().nonnegative().max(10_000).optional(),
    error_bytes_omitted: z.number().int().nonnegative().max(20_000_000).optional(),
  })
  .strict()
  .superRefine((attempt, ctx) => {
    const commitment = attempt.failures_commitment
    if (!commitment) return
    if (commitment.entry_count !== attempt.failures.length + (attempt.failures_omitted ?? 0)) {
      ctx.addIssue({ code: "custom", path: ["failures_commitment", "entry_count"], message: "failure commitment count does not match the inline/omitted projection" })
    }
    if (!(attempt.failures_omitted ?? 0) && !(attempt.failure_texts_truncated ?? 0) &&
      !isDeepStrictEqual(commitment, failureListCommitment(attempt.failures))) {
      ctx.addIssue({ code: "custom", path: ["failures_commitment"], message: "failure commitment does not match the complete inline list" })
    }
  })

const NodeStateSchema = z
  .object({
    id: safeId,
    agent: AlgAgentSchema,
    status: z.enum(["pending", "ready", "running", "done", "failed", "skipped"]),
    attempts: z.array(NodeAttemptSchema).max(10_000),
    attempt_history_ref: AttemptHistoryReferenceSchema.optional(),
    current_attempt: z.number().int().nonnegative().max(10_000),
    output: z.unknown().optional(),
    output_ref: OutputReferenceSchema.optional(),
    last_failures: boundedStrings,
    last_failures_commitment: FailureListCommitmentSchema.optional(),
    last_failures_ref: RunDataReferenceBaseSchema.refine(
      (reference) => isSafeRunDerivedPath(reference.artifact_path, "history"),
      "node failure reference must be under a run history directory",
    ).optional(),
    last_failures_omitted: z.number().int().nonnegative().max(10_000).optional(),
    last_failure_texts_truncated: z.number().int().nonnegative().max(10_000).optional(),
  })
  .strict()
  .superRefine((node, ctx) => {
    const commitment = node.last_failures_commitment
    if (!commitment) return
    if (commitment.entry_count !== node.last_failures.length + (node.last_failures_omitted ?? 0)) {
      ctx.addIssue({ code: "custom", path: ["last_failures_commitment", "entry_count"], message: "failure commitment count does not match the inline/omitted projection" })
    }
    if (!(node.last_failures_omitted ?? 0) && !(node.last_failure_texts_truncated ?? 0) &&
      !isDeepStrictEqual(commitment, failureListCommitment(node.last_failures))) {
      ctx.addIssue({ code: "custom", path: ["last_failures_commitment"], message: "failure commitment does not match the complete inline list" })
    }
  })

function isAttemptHistoryReferencePath(
  reference: RunDataReference,
  runId: string,
  nodeId: string,
): boolean {
  const base = `.opencode/runs/${runId}/history/${nodeId}-attempts`
  return reference.artifact_path === `${base}.json` ||
    reference.artifact_path === `${base}-${reference.sha256}.json`
}

function isAttemptOutputReferencePath(
  reference: RunDataReference,
  runId: string,
  nodeId: string,
  attempt: number,
): boolean {
  const base = `.opencode/runs/${runId}/artifacts/${nodeId}-attempt-${attempt}`
  return reference.artifact_path === `${base}.json` ||
    reference.artifact_path === `${base}-output-${reference.sha256}.json`
}

function isAttemptDetailReferencePath(
  reference: RunDataReference,
  runId: string,
  nodeId: string,
  attempt: number,
): boolean {
  const base = `.opencode/runs/${runId}/history/${nodeId}-attempt-${attempt}`
  return reference.artifact_path === `${base}.json` ||
    reference.artifact_path === `${base}-detail-${reference.sha256}.json`
}

function isNodeOutputReferencePath(
  reference: RunDataReference,
  runId: string,
  nodeId: string,
): boolean {
  const base = `.opencode/runs/${runId}/artifacts/${nodeId}-output-`
  return reference.artifact_path === `${base}${reference.sha256.slice(0, 16)}.json` ||
    reference.artifact_path === `${base}${reference.sha256}.json`
}

function isNodeFailuresReferencePath(
  reference: RunDataReference,
  runId: string,
  nodeId: string,
): boolean {
  const base = `.opencode/runs/${runId}/history/${nodeId}-failures`
  return reference.artifact_path === `${base}.json` ||
    reference.artifact_path === `${base}-${reference.sha256}.json`
}

function isRootAuthorizationsReferencePath(
  reference: RunDataReference,
  runId: string,
): boolean {
  const base = `.opencode/runs/${runId}/history/filesystem-root-authorizations`
  return reference.artifact_path === `${base}.json` ||
    reference.artifact_path === `${base}-${reference.sha256}.json`
}

const OwnerTransferSchema = z
  .object({
    from_session_id: sessionId,
    to_session_id: sessionId,
    by_session_id: sessionId,
    transferred_at: isoDate,
  })
  .strict()

const FilesystemRootAuthorizationSchema = z
  .object({
    operation: z.enum(["plan", "run", "resume"]),
    by_session_id: sessionId,
    authorized_at: isoDate,
    authorized: z.literal(true).optional(),
    path: exactString(1, 4_096, "root authorization path")
      .refine(isAbsolute, "root authorization path must be absolute").optional(),
  })
  .strict()

const StateProjectionMetadataSchema = z.object({
  outputs_externalized: z.number().int().nonnegative().max(20_000),
  attempts_archived: z.number().int().nonnegative().max(10_000),
  failure_entries_omitted: z.number().int().nonnegative().max(100_000_000),
  failure_texts_truncated: z.number().int().nonnegative().max(100_000_000),
  error_bytes_omitted: z.number().int().nonnegative().max(100_000_000),
  root_authorizations_omitted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict()

export const RunLockSchema: z.ZodType<RunLockRecord> = z
  .object({
    version: z.literal(1),
    token: z.uuid(),
    holder: sessionId,
    project_directory: exactString(1, 4_096, "project_directory")
      .refine(isAbsolute, "project_directory must be absolute"),
    run_id: safeId,
    acquired_at: isoDate,
    expires_at: isoDate,
  })
  .strict()
  .superRefine((lock, ctx) => {
    if (Date.parse(lock.expires_at) <= Date.parse(lock.acquired_at)) {
      ctx.addIssue({ code: "custom", path: ["expires_at"], message: "lock expiry must follow acquisition" })
    }
  })

const RunStateCoreSchema: z.ZodType<RunState> = z
  .object({
    schema_version: z.literal(2),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    run_id: safeId,
    owner_session_id: sessionId,
    parent_session_id: sessionId,
    owner_transfers: z.array(OwnerTransferSchema).max(1_000),
    project_directory: exactString(1, 4_096, "project_directory")
      .refine(isAbsolute, "project_directory must be absolute"),
    goal: text,
    criteria: boundedStrings,
    criteria_locked: z.boolean(),
    graph: GraphDefSchema,
    status: z.enum(["planning", "running", "done", "failed", "blocked"]),
    phase: z.string().min(1).max(128),
    nodes: z.record(safeId, NodeStateSchema),
    global_attempts: z.number().int().nonnegative().max(10_000),
    created_at: isoDate,
    updated_at: isoDate,
    mode: z.enum(["live", "dry"]),
    model_snapshot: AgentModelMapSchema,
    model_resolution: ModelResolutionMapSchema.optional(),
    filesystem_root_authorizations: z.array(FilesystemRootAuthorizationSchema).max(10_000).optional(),
    filesystem_root_authorizations_ref: FilesystemRootAuthorizationReferenceSchema.optional(),
    filesystem_root_authorizations_omitted: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
    session_isolation: z.literal("sdk-child-session"),
    summary: z.string().max(50_000).optional(),
    state_projection: StateProjectionMetadataSchema.optional(),
  })
  .strict()
  .superRefine((run, ctx) => {
    const definitions = new Map(run.graph.nodes.map((node) => [node.id, node]))
    const stateKeys = Object.keys(run.nodes)
    if (stateKeys.length !== definitions.size) {
      ctx.addIssue({ code: "custom", path: ["nodes"], message: "node state keys must exactly match graph nodes" })
    }
    let attempts = 0
    for (const definition of run.graph.nodes) {
      if (!Object.hasOwn(run.nodes, definition.id)) {
        ctx.addIssue({ code: "custom", path: ["nodes", definition.id], message: "graph node is missing state" })
      }
    }
    for (const [id, state] of Object.entries(run.nodes)) {
      const def = definitions.get(id)
      if (!def || state.id !== id || state.agent !== def.agent) {
        ctx.addIssue({ code: "custom", path: ["nodes", id], message: "node state identity does not match graph" })
        continue
      }
      const archivedAttempts = state.attempt_history_ref?.attempt_count ?? 0
      attempts += state.current_attempt
      if (state.current_attempt !== archivedAttempts + state.attempts.length) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "current_attempt"], message: "current_attempt must equal preserved attempt history length" })
      }
      if (state.attempt_history_ref) {
        if (!isAttemptHistoryReferencePath(state.attempt_history_ref, run.run_id, id)) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempt_history_ref", "artifact_path"], message: "attempt history reference does not match its run/node" })
        }
      }
      if (state.current_attempt > (def.loop?.max_attempts ?? 1)) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "current_attempt"], message: "node exceeded local attempt limit" })
      }
      state.attempts.forEach((attempt, i) => {
        try {
          parsePersistedNodeAttempt(attempt, {
            agent: def.agent,
            run_id: run.run_id,
            node_id: id,
            expected_attempt: archivedAttempts + i + 1,
            mode: run.mode,
            requires_shell: def.agent === "shell" || def.loop?.gate === "shell" || def.loop?.gate === "all",
          })
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            path: ["nodes", id, "attempts", i],
            message: `persisted attempt invariant failed: ${error instanceof Error ? error.message : String(error)}`,
          })
        }
        if (attempt.attempt !== archivedAttempts + i + 1) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "attempt"], message: "attempt history must be contiguous" })
        }
        if (attempt.status !== "running" && attempt.status !== "done" && attempt.status !== "failed") {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "status"], message: "attempt status must be running, done, or failed" })
        }
        const outputResult = attempt.output === undefined
          ? null
          : schemaForAgent(def.agent).safeParse(attempt.output)
        if (outputResult && !outputResult.success) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "output"], message: `attempt output violates ${def.agent} schema` })
        }
        if (attempt.output_ref) {
          if (!isAttemptOutputReferencePath(attempt.output_ref, run.run_id, id, attempt.attempt)) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "output_ref", "artifact_path"], message: "attempt output reference does not match its run/node/attempt" })
          }
          if (attempt.output_ref.byte_size > AGENT_OUTPUT_BYTE_LIMITS[def.agent]) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "output_ref", "byte_size"], message: "attempt output reference exceeds the agent output limit" })
          }
        }
        if (attempt.detail_ref) {
          if (!isAttemptDetailReferencePath(attempt.detail_ref, run.run_id, id, attempt.attempt)) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "detail_ref", "artifact_path"], message: "attempt detail reference does not match its run/node/attempt" })
          }
        }
        if (
          def.agent === "implementer" &&
          attempt.output &&
          typeof attempt.output === "object" &&
          typeof (attempt.output as { artifact_path?: unknown }).artifact_path === "string" &&
          !(attempt.output as { artifact_path: string }).artifact_path.startsWith(
            `.opencode/runs/${run.run_id}/artifacts/`,
          )
        ) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "output", "artifact_path"], message: "artifact_path belongs to a different run" })
        }
        if ((attempt.output !== undefined || attempt.output_ref !== undefined) && attempt.schema_ok !== true) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "output"], message: "attempt output requires schema_ok=true" })
        }
        if (attempt.status === "running") {
          if (i !== state.attempts.length - 1 || attempt.finished_at || attempt.failures.length || attempt.failures_omitted || attempt.output !== undefined || attempt.output_ref !== undefined || attempt.schema_ok !== undefined) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i], message: "running attempt must be the unfinished final attempt" })
          }
        } else {
          if (!attempt.finished_at) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "finished_at"], message: "terminal attempt requires finished_at" })
          } else if (Date.parse(attempt.finished_at) < Date.parse(attempt.started_at)) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "finished_at"], message: "attempt cannot finish before it starts" })
          }
          if (attempt.schema_ok === undefined) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "schema_ok"], message: "terminal attempt requires a schema verdict" })
          }
        }
        if (attempt.status === "done") {
          if (attempt.schema_ok !== true || (attempt.output === undefined && attempt.output_ref === undefined) || attempt.failures.length || attempt.failures_omitted || attempt.error) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i], message: "done attempt must be a successful schema-valid attempt" })
          }
          if (def.agent === "implementer" && attempt.output !== undefined && (attempt.output as { done?: boolean })?.done !== true) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "output", "done"], message: "incomplete implementer output cannot complete an attempt" })
          }
          if (def.agent === "checker" && attempt.output !== undefined && (attempt.output as { passed?: boolean })?.passed !== true) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "output", "passed"], message: "rejected checker output cannot complete an attempt" })
          }
          const requiresShell = def.agent === "shell" || def.loop?.gate === "shell" || def.loop?.gate === "all"
          if (requiresShell && run.mode !== "dry" && attempt.shell_ok !== true) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "shell_ok"], message: "done gated attempt requires shell_ok=true" })
          }
        }
        if (attempt.outcome === "passed" && attempt.status !== "done") {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "outcome"], message: "passed outcome requires a done attempt" })
        }
        if (attempt.outcome === "schema_invalid" && attempt.schema_ok !== false) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "outcome"], message: "schema_invalid outcome requires schema_ok=false" })
        }
        if (attempt.outcome === "substantive_rejection" &&
          (def.agent !== "checker" || attempt.schema_ok !== true ||
            (attempt.output !== undefined && (attempt.output as { passed?: unknown })?.passed !== false))) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "outcome"], message: "substantive_rejection requires validated passed=false checker output" })
        }
        if (attempt.status === "failed" && attempt.failures.length === 0 && !attempt.failures_omitted) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "failures"], message: "failed attempt requires failures" })
        }
        if (def.agent === "checker" && attempt.output !== undefined) {
          const outputScore = (attempt.output as { score: number }).score
          if (attempt.score !== outputScore) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "score"], message: "checker attempt score must match its output" })
          }
        } else if (attempt.score !== undefined && !(def.agent === "checker" && attempt.output_ref !== undefined)) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "score"], message: "score requires validated checker output" })
        }
      })

      const finalAttempt = state.attempts.at(-1)
      if (state.output !== undefined && !schemaForAgent(def.agent).safeParse(state.output).success) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "output"], message: `node output violates ${def.agent} schema` })
      }
      if (state.output_ref) {
        if (!isNodeOutputReferencePath(state.output_ref, run.run_id, id)) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "output_ref", "artifact_path"], message: "node output reference does not match its run/node" })
        }
        if (state.output_ref.byte_size > AGENT_OUTPUT_BYTE_LIMITS[def.agent]) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "output_ref", "byte_size"], message: "node output reference exceeds the agent output limit" })
        }
      }
      if (state.last_failures_ref) {
        if (!isNodeFailuresReferencePath(state.last_failures_ref, run.run_id, id)) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "last_failures_ref", "artifact_path"], message: "node failure reference does not match its run/node" })
        }
      }
      if (
        def.agent === "implementer" &&
        state.output &&
        typeof state.output === "object" &&
        typeof (state.output as { artifact_path?: unknown }).artifact_path === "string" &&
        !(state.output as { artifact_path: string }).artifact_path.startsWith(
          `.opencode/runs/${run.run_id}/artifacts/`,
        )
      ) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "output", "artifact_path"], message: "artifact_path belongs to a different run" })
      }
      const latestOutputAttempt = [...state.attempts].reverse().find((attempt) =>
        attempt.output !== undefined || attempt.output_ref !== undefined)
      const latestOutput = latestOutputAttempt?.output
      const latestOutputRef = latestOutputAttempt?.output_ref
      if (state.output !== undefined && (latestOutput === undefined || !isDeepStrictEqual(state.output, latestOutput))) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "output"], message: "node output must come from the latest validated attempt output" })
      }
      if (state.output_ref !== undefined && latestOutputRef === undefined && state.output === undefined) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "output_ref"], message: "node output reference must come from the latest visible validated attempt" })
      }
      if (state.status === "running" && finalAttempt?.status !== "running") {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "status"], message: "running node requires a running final attempt" })
      }
      if (state.status !== "running" && finalAttempt?.status === "running") {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "status"], message: "running final attempt requires running node status" })
      }
      if (state.status === "done") {
        const nodeHasOutput = state.output !== undefined || state.output_ref !== undefined
        const finalHasOutput = finalAttempt?.output !== undefined || finalAttempt?.output_ref !== undefined
        const inlineMismatch = state.output !== undefined && finalAttempt?.output !== undefined &&
          !isDeepStrictEqual(state.output, finalAttempt.output)
        if (!finalAttempt || finalAttempt.status !== "done" || !nodeHasOutput || !finalHasOutput || inlineMismatch) {
          ctx.addIssue({ code: "custom", path: ["nodes", id], message: "done node requires a matching successful final attempt and output" })
        }
        for (const dependency of def.depends_on) {
          if (run.nodes[dependency]?.status !== "done") {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "status"], message: `done node requires done dependency ${dependency}` })
          }
        }
      }
      if (state.status === "failed" && finalAttempt && finalAttempt.status !== "failed") {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "status"], message: "failed node requires a failed final attempt" })
      }
      if ((state.status === "failed" || state.status === "skipped") && state.last_failures.length === 0 && !state.last_failures_omitted) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "last_failures"], message: `${state.status} node requires a recorded reason` })
      }
      if (state.status === "done" && (state.last_failures.length !== 0 || state.last_failures_omitted)) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "last_failures"], message: "done node cannot retain failures" })
      }
      if (state.status === "skipped" && !def.depends_on.some((dependency) => {
        const dependencyStatus = run.nodes[dependency]?.status
        return dependencyStatus === "failed" || dependencyStatus === "skipped"
      })) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "status"], message: "skipped node requires a failed or skipped dependency" })
      }
    }
    if (run.global_attempts !== attempts || attempts > run.graph.max_global_attempts) {
      ctx.addIssue({ code: "custom", path: ["global_attempts"], message: "global_attempts must equal history and respect graph limit" })
    }
    if (run.status === "done" && run.graph.nodes.some((definition) => run.nodes[definition.id]?.status !== "done")) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "done run requires every node done" })
    }
    if (run.status === "failed" && !Object.values(run.nodes).some((state) => state.status === "failed")) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "failed run requires a failed node" })
    }
    if (run.status === "failed" && Object.values(run.nodes).some((state) =>
      state.status !== "done" && state.status !== "failed" && state.status !== "skipped")) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "failed run requires all nodes terminal" })
    }
    if (run.status === "planning" && (run.global_attempts !== 0 || Object.values(run.nodes).some((state) => state.status !== "pending"))) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "planning run must have an untouched pending graph" })
    }

    let expectedOwner = run.parent_session_id
    let previousTransferTime = Number.NEGATIVE_INFINITY
    run.owner_transfers.forEach((transfer, index) => {
      const timestamp = Date.parse(transfer.transferred_at)
      if (transfer.by_session_id !== transfer.from_session_id) {
        ctx.addIssue({ code: "custom", path: ["owner_transfers", index, "by_session_id"], message: "transfer actor must equal source owner" })
      }
      if (transfer.from_session_id === transfer.to_session_id) {
        ctx.addIssue({ code: "custom", path: ["owner_transfers", index, "to_session_id"], message: "self-transfer is not allowed" })
      }
      if (transfer.from_session_id !== expectedOwner) {
        ctx.addIssue({ code: "custom", path: ["owner_transfers", index, "from_session_id"], message: "transfer source breaks the ownership chain" })
      }
      if (timestamp < previousTransferTime) {
        ctx.addIssue({ code: "custom", path: ["owner_transfers", index, "transferred_at"], message: "transfer timestamps must be monotonic" })
      }
      expectedOwner = transfer.to_session_id
      previousTransferTime = timestamp
    })
    if (run.owner_session_id !== expectedOwner) {
      ctx.addIssue({ code: "custom", path: ["owner_session_id"], message: "final owner does not match the audited transfer chain" })
    }

    if (run.filesystem_root_authorizations_ref) {
      const reference = run.filesystem_root_authorizations_ref
      if (!isRootAuthorizationsReferencePath(reference, run.run_id)) {
        ctx.addIssue({
          code: "custom",
          path: ["filesystem_root_authorizations_ref", "artifact_path"],
          message: "filesystem root authorization reference does not match its run/kind",
        })
      }
      const retained = run.filesystem_root_authorizations?.length ?? 0
      if (retained > reference.authorization_count ||
        (run.filesystem_root_authorizations_omitted ?? 0) !== reference.authorization_count - retained) {
        ctx.addIssue({
          code: "custom",
          path: ["filesystem_root_authorizations_omitted"],
          message: "filesystem root authorization projection metadata does not match its reference",
        })
      }
    }

    if (run.state_projection) {
      let outputsExternalized = 0
      let attemptsArchived = 0
      let failureEntriesOmitted = 0
      let failureTextsTruncated = 0
      let errorBytesOmitted = 0
      for (const state of Object.values(run.nodes)) {
        if (state.output_ref) outputsExternalized++
        if (state.attempt_history_ref) {
          outputsExternalized += state.attempt_history_ref.output_count
          attemptsArchived += state.attempt_history_ref.attempt_count
          failureEntriesOmitted += state.attempt_history_ref.failure_entries_omitted
          failureTextsTruncated += state.attempt_history_ref.failure_texts_truncated
          errorBytesOmitted += state.attempt_history_ref.error_bytes_omitted
        }
        failureEntriesOmitted += state.last_failures_omitted ?? 0
        failureTextsTruncated += state.last_failure_texts_truncated ?? 0
        for (const attempt of state.attempts) {
          if (attempt.output_ref) outputsExternalized++
          failureEntriesOmitted += attempt.failures_omitted ?? 0
          failureTextsTruncated += attempt.failure_texts_truncated ?? 0
          errorBytesOmitted += attempt.error_bytes_omitted ?? 0
        }
      }
      const expectedProjection = {
        outputs_externalized: outputsExternalized,
        attempts_archived: attemptsArchived,
        failure_entries_omitted: failureEntriesOmitted,
        failure_texts_truncated: failureTextsTruncated,
        error_bytes_omitted: errorBytesOmitted,
        root_authorizations_omitted: run.filesystem_root_authorizations_omitted ?? 0,
      }
      if (!isDeepStrictEqual(run.state_projection, expectedProjection)) {
        ctx.addIssue({ code: "custom", path: ["state_projection"], message: "state projection metadata does not match persisted omissions/references" })
      }
    }
  })
  .transform((run) => {
    const nodes = Object.create(null) as Record<string, (typeof run.nodes)[string]>
    for (const [id, state] of Object.entries(run.nodes)) nodes[id] = state
    return { ...run, nodes }
  })

export const RunStateSchema: z.ZodType<RunState> = RunStateCoreSchema.superRefine((run, ctx) => {
  const bytes = serializedBytes(run)
  if (bytes > MAX_PERSISTED_STATE_BYTES) {
    ctx.addIssue({
      code: "custom",
      message: `run state exceeds ${MAX_PERSISTED_STATE_BYTES} serialized bytes (received ${bytes})`,
    })
  }
})

export function parseGraph(raw: unknown): GraphDef {
  return GraphDefSchema.parse(raw)
}

function freezeRunModelState(run: RunState): RunState {
  for (const model of Object.values(run.model_snapshot)) Object.freeze(model)
  Object.freeze(run.model_snapshot)
  if (run.model_resolution) {
    for (const resolution of Object.values(run.model_resolution)) Object.freeze(resolution)
    Object.freeze(run.model_resolution)
  }
  return run
}

export function parseRunState(raw: unknown): RunState {
  return freezeRunModelState(RunStateSchema.parse(raw))
}

/** Structural/runtime parse before deterministic projection removes inline outputs. */
export function parseRunStateForProjection(raw: unknown): RunState {
  return freezeRunModelState(RunStateCoreSchema.parse(raw))
}

export function schemaForAgent(agent: string): z.ZodTypeAny {
  const known = AlgAgentSchema.safeParse(agent)
  if (!known.success) throw new Error(`unknown ALG agent: ${agent}`)
  const schemas: Record<AlgAgent, z.ZodTypeAny> = {
    explorer: ExploreOut,
    researcher: ResearchOut,
    implementer: ImplementOut,
    checker: CheckOut,
    shell: ShellOut,
  }
  return schemas[known.data]
}

/** Parse an immutable agent-output object without allowing schema transforms. */
export function parseCanonicalAgentOutput(agent: string, raw: unknown): unknown {
  const parsed = schemaForAgent(agent).parse(raw)
  if (!isDeepStrictEqual(raw, parsed)) {
    throw new Error(`${agent} output is non-canonical because schema parsing would transform it`)
  }
  return parsed
}

export interface PersistedAttemptContext {
  agent: string
  run_id: string
  node_id: string
  expected_attempt: number
  mode?: "live" | "dry"
  requires_shell?: boolean
}

/**
 * Parse one persisted attempt with the context-sensitive invariants used by
 * authoritative RunState. Safe for bounded SDK archive readers: no filesystem
 * access and no reference hydration occurs here.
 */
export function parsePersistedNodeAttempt(raw: unknown, context: PersistedAttemptContext): NodeAttempt {
  const attempt = NodeAttemptSchema.parse(raw)
  const issues: string[] = []
  const add = (message: string): void => { issues.push(message) }
  const { agent, run_id: runId, node_id: nodeId, expected_attempt: expected } = context
  const knownAgent = AlgAgentSchema.safeParse(agent)
  if (!knownAgent.success) add(`unknown ALG agent: ${agent}`)
  if (!isSafeId(runId) || !isSafeId(nodeId)) add("run/node identity is unsafe")
  if (attempt.attempt !== expected) add("attempt history is not contiguous")
  if (!(["running", "done", "failed"] as const).includes(attempt.status as "running" | "done" | "failed")) {
    add("attempt status must be running, done, or failed")
  }
  if (attempt.output_ref && !isAttemptOutputReferencePath(attempt.output_ref, runId, nodeId, expected)) {
    add("attempt output reference does not match its run/node/attempt")
  }
  if (attempt.output_ref && knownAgent.success &&
    attempt.output_ref.byte_size > AGENT_OUTPUT_BYTE_LIMITS[knownAgent.data]) {
    add("attempt output reference exceeds the agent output limit")
  }
  if (attempt.detail_ref && !isAttemptDetailReferencePath(attempt.detail_ref, runId, nodeId, expected)) {
    add("attempt detail reference does not match its run/node/attempt")
  }
  if ((attempt.failures_omitted !== undefined || attempt.failure_texts_truncated !== undefined ||
    attempt.error_bytes_omitted !== undefined) && attempt.detail_ref === undefined) {
    add("projected attempt omissions require an attempt detail reference")
  }
  if (attempt.failures_omitted === 0 || attempt.failure_texts_truncated === 0 ||
    attempt.error_bytes_omitted === 0) {
    add("projected attempt omission metadata must be positive when present")
  }
  const projectedFailureCount = attempt.failures.length + (attempt.failures_omitted ?? 0)
  if ((attempt.failure_texts_truncated ?? 0) > projectedFailureCount) {
    add("failure truncation count exceeds the complete projected failure count")
  }
  if (attempt.error_bytes_omitted !== undefined && attempt.error === undefined) {
    add("projected error omission requires an inline error prefix")
  }

  const outputResult = attempt.output === undefined || !knownAgent.success
    ? null
    : schemaForAgent(knownAgent.data).safeParse(attempt.output)
  if (outputResult && !outputResult.success) add(`attempt output violates ${agent} schema`)
  if (knownAgent.success && knownAgent.data === "implementer" && attempt.output &&
    typeof attempt.output === "object" &&
    typeof (attempt.output as { artifact_path?: unknown }).artifact_path === "string" &&
    !(attempt.output as { artifact_path: string }).artifact_path.startsWith(
      `.opencode/runs/${runId}/artifacts/`,
    )) {
    add("artifact_path belongs to a different run")
  }
  if ((attempt.output !== undefined || attempt.output_ref !== undefined) && attempt.schema_ok !== true) {
    add("attempt output requires schema_ok=true")
  }

  if (attempt.status === "running") {
    if (attempt.finished_at || attempt.failures.length || attempt.failures_omitted ||
      attempt.output !== undefined || attempt.output_ref !== undefined || attempt.schema_ok !== undefined) {
      add("running attempt must be unfinished and cannot carry output/failures/schema verdict")
    }
  } else {
    if (!attempt.finished_at) add("terminal attempt requires finished_at")
    else if (Date.parse(attempt.finished_at) < Date.parse(attempt.started_at)) {
      add("attempt cannot finish before it starts")
    }
    if (attempt.schema_ok === undefined) add("terminal attempt requires a schema verdict")
  }

  if (attempt.status === "done") {
    if (attempt.schema_ok !== true || (attempt.output === undefined && attempt.output_ref === undefined) ||
      attempt.failures.length || attempt.failures_omitted || attempt.error) {
      add("done attempt must be a successful schema-valid attempt")
    }
    if (knownAgent.success && knownAgent.data === "implementer" && attempt.output !== undefined &&
      (attempt.output as { done?: boolean })?.done !== true) {
      add("incomplete implementer output cannot complete an attempt")
    }
    if (knownAgent.success && knownAgent.data === "checker" && attempt.output !== undefined &&
      (attempt.output as { passed?: boolean })?.passed !== true) {
      add("rejected checker output cannot complete an attempt")
    }
    if (context.requires_shell && context.mode !== "dry" && attempt.shell_ok !== true) {
      add("done gated attempt requires shell_ok=true")
    }
  }
  if (attempt.status === "failed" && attempt.failures.length === 0 && !attempt.failures_omitted) {
    add("failed attempt requires failures")
  }
  if (attempt.outcome === "passed" && attempt.status !== "done") {
    add("passed outcome requires a done attempt")
  }
  if (attempt.status === "done" && attempt.outcome !== undefined && attempt.outcome !== "passed") {
    add("done attempt requires a passed outcome when outcome is recorded")
  }
  if (attempt.outcome !== undefined && attempt.outcome !== "passed" && attempt.status !== "failed") {
    add("non-passed outcome requires a failed attempt")
  }
  if (attempt.outcome === "schema_invalid" && attempt.schema_ok !== false) {
    add("schema_invalid outcome requires schema_ok=false")
  }
  if (attempt.outcome === "sdk_error" && attempt.error === undefined) {
    add("sdk_error outcome requires an error")
  }
  if (attempt.error !== undefined && attempt.outcome !== undefined && attempt.outcome !== "sdk_error") {
    add("recorded error requires sdk_error outcome")
  }
  if ((attempt.outcome === "substantive_rejection" || attempt.outcome === "incomplete" ||
    attempt.outcome === "gate_failure") && attempt.schema_ok !== true) {
    add(`${attempt.outcome} outcome requires schema_ok=true`)
  }
  const liveShellGate = context.requires_shell === true && context.mode !== "dry"
  if (attempt.outcome === "gate_failure" &&
    (!liveShellGate || attempt.shell_ok !== false)) {
    add("gate_failure outcome requires an actual live shell/all graph gate and shell_ok=false")
  }
  if (attempt.outcome === "incomplete" && (!knownAgent.success || knownAgent.data !== "implementer")) {
    add("incomplete outcome requires implementer output")
  }
  if (attempt.outcome === "substantive_rejection" &&
    (!knownAgent.success || knownAgent.data !== "checker" || attempt.schema_ok !== true ||
      (attempt.output !== undefined && (attempt.output as { passed?: unknown })?.passed !== false))) {
    add("substantive_rejection requires validated passed=false checker output")
  }
  if (knownAgent.success && knownAgent.data === "checker" && attempt.output !== undefined) {
    const checkerPassed = (attempt.output as { passed?: unknown }).passed === true
    const rejected = !checkerPassed
    const shellFailed = liveShellGate && attempt.shell_ok === false
    if (attempt.outcome === "passed" && !checkerPassed) {
      add("passed outcome requires passed=true checker output")
    }
    if (attempt.outcome === "gate_failure" && checkerPassed && !shellFailed) {
      add("passed=true checker gate_failure requires a proved shell gate failure")
    }
    if (rejected && !shellFailed && attempt.error === undefined && attempt.status === "failed" && attempt.outcome !== undefined &&
      attempt.outcome !== "substantive_rejection") {
      add("validated passed=false checker output requires substantive_rejection outcome")
    }
    if (!rejected && attempt.outcome === "substantive_rejection") {
      add("substantive_rejection outcome requires passed=false checker output")
    }
  }
  if (knownAgent.success && knownAgent.data === "implementer" && attempt.output !== undefined) {
    const incomplete = (attempt.output as { done?: unknown }).done === false
    const shellFailed = context.requires_shell === true && context.mode !== "dry" && attempt.shell_ok !== true
    if (incomplete && !shellFailed && attempt.error === undefined && attempt.status === "failed" && attempt.outcome !== undefined &&
      attempt.outcome !== "incomplete") {
      add("validated done=false implementer output requires incomplete outcome")
    }
    if (!incomplete && attempt.outcome === "incomplete") {
      add("incomplete outcome requires done=false implementer output")
    }
  }
  if (knownAgent.success && knownAgent.data === "checker" && attempt.output !== undefined) {
    if (attempt.score !== (attempt.output as { score: number }).score) {
      add("checker attempt score must match its output")
    }
  } else if (attempt.score !== undefined &&
    !(knownAgent.success && knownAgent.data === "checker" && attempt.output_ref !== undefined)) {
    add("score requires validated checker output")
  }
  if (issues.length) throw new Error(issues.join("; "))
  return attempt
}

/** Parse a canonical full detail sidecar before any field can hydrate a projection. */
export function parsePersistedAttemptDetail(raw: unknown, context: PersistedAttemptContext): NodeAttempt {
  const detail = PersistedAttemptDetailSchema.parse(raw)
  return parsePersistedNodeAttempt(detail, context)
}

export function jsonSchemaHint(agent: string): string {
  const schema = schemaForAgent(agent)
  try {
    return JSON.stringify(z.toJSONSchema(schema), null, 2)
  } catch {
    return `{ "agent": ${JSON.stringify(agent)}, "note": "Return the documented strict output object." }`
  }
}

export function parseAndValidate(
  agent: string,
  raw: unknown,
): { ok: true; data: unknown } | { ok: false; failures: string[] } {
  let schema: z.ZodTypeAny
  try {
    schema = schemaForAgent(agent)
  } catch (error) {
    return { ok: false, failures: [error instanceof Error ? error.message : String(error)] }
  }
  const result = schema.safeParse(raw)
  if (result.success) return { ok: true, data: result.data }
  const converted = result.error.issues.map((issue) => safeDiagnosticText(
    `${issue.path.join(".") || "(root)"}: ${issue.message}`,
  ))
  return {
    ok: false,
    failures: boundDiagnosticList(converted, {
      omittedLabel: (count) => `[truncated] ${count} additional schema issues omitted`,
    }),
  }
}

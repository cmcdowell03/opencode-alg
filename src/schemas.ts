import { isAbsolute } from "node:path"
import { z } from "zod"
import { ALG_AGENTS, MODEL_AGENTS } from "./types.ts"
import type {
  AlgAgent,
  GraphDef,
  ProjectModelSettings,
  RunLockRecord,
  RunState,
} from "./types.ts"
import { isDeepStrictEqual } from "node:util"
import {
  isSafeId,
  isSafeProjectRelativePath,
  isSafeRunArtifactPath,
  SAFE_ID_PATTERN,
} from "./paths.ts"
import { AGENT_OUTPUT_BYTE_LIMITS, serializedBytes } from "./limits.ts"

const shortText = z.string().trim().min(1).max(2_000)
const text = z.string().trim().min(1).max(20_000)
const safeId = z.string().regex(SAFE_ID_PATTERN).max(64).refine(isSafeId, "reserved or unsafe identifier")
const safeInputKey = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
  .refine(isSafeId, "reserved or unsafe input key")
const sessionId = z.string().trim().min(1).max(256)
const isoDate = z.iso.datetime({ offset: true })
const boundedStrings = z.array(shortText).max(100)

export const SafeIdSchema = safeId
export const AlgAgentSchema = z.enum(ALG_AGENTS)
export const ModelAgentSchema = z.enum(MODEL_AGENTS)

export const ModelRefSchema = z
  .object({
    providerID: z.string().trim().min(1).max(128),
    modelID: z.string().trim().min(1).max(256),
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
    max_global_attempts: z.number().int().positive().max(10_000).default(100),
    max_concurrency: z.number().int().positive().max(8).default(4),
  })
  .strict()
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

    const localCapacity = graph.nodes.reduce((sum, node) => sum + (node.loop?.max_attempts ?? 1), 0)
    if (graph.max_global_attempts > localCapacity) {
      ctx.addIssue({
        code: "custom",
        path: ["max_global_attempts"],
        message: `max_global_attempts exceeds local attempt capacity (${localCapacity})`,
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

const NodeAttemptSchema = z
  .object({
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
  })
  .strict()

const NodeStateSchema = z
  .object({
    id: safeId,
    agent: AlgAgentSchema,
    status: z.enum(["pending", "ready", "running", "done", "failed", "skipped"]),
    attempts: z.array(NodeAttemptSchema).max(10_000),
    current_attempt: z.number().int().nonnegative().max(10_000),
    output: z.unknown().optional(),
    last_failures: boundedStrings,
  })
  .strict()

const OwnerTransferSchema = z
  .object({
    from_session_id: sessionId,
    to_session_id: sessionId,
    by_session_id: sessionId,
    transferred_at: isoDate,
  })
  .strict()

export const RunLockSchema: z.ZodType<RunLockRecord> = z
  .object({
    version: z.literal(1),
    token: z.uuid(),
    holder: sessionId,
    project_directory: z.string().min(1).max(4_096).refine(isAbsolute, "project_directory must be absolute"),
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

export const RunStateSchema: z.ZodType<RunState> = z
  .object({
    schema_version: z.literal(2),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    run_id: safeId,
    owner_session_id: sessionId,
    parent_session_id: sessionId,
    owner_transfers: z.array(OwnerTransferSchema).max(1_000),
    project_directory: z.string().min(1).max(4_096).refine(isAbsolute, "project_directory must be absolute"),
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
    session_isolation: z.literal("sdk-child-session"),
    summary: z.string().max(50_000).optional(),
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
      attempts += state.attempts.length
      if (state.current_attempt !== state.attempts.length) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "current_attempt"], message: "current_attempt must equal preserved attempt history length" })
      }
      if (state.current_attempt > (def.loop?.max_attempts ?? 1)) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "current_attempt"], message: "node exceeded local attempt limit" })
      }
      state.attempts.forEach((attempt, i) => {
        if (attempt.attempt !== i + 1) {
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
        if (attempt.output !== undefined && attempt.schema_ok !== true) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "output"], message: "attempt output requires schema_ok=true" })
        }
        if (attempt.status === "running") {
          if (i !== state.attempts.length - 1 || attempt.finished_at || attempt.failures.length || attempt.output !== undefined || attempt.schema_ok !== undefined) {
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
          if (attempt.schema_ok !== true || attempt.output === undefined || attempt.failures.length || attempt.error) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i], message: "done attempt must be a successful schema-valid attempt" })
          }
          if (def.agent === "implementer" && (attempt.output as { done?: boolean } | undefined)?.done !== true) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "output", "done"], message: "incomplete implementer output cannot complete an attempt" })
          }
          if (def.agent === "checker" && (attempt.output as { passed?: boolean } | undefined)?.passed !== true) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "output", "passed"], message: "rejected checker output cannot complete an attempt" })
          }
          const requiresShell = def.agent === "shell" || def.loop?.gate === "shell" || def.loop?.gate === "all"
          if (requiresShell && run.mode !== "dry" && attempt.shell_ok !== true) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "shell_ok"], message: "done gated attempt requires shell_ok=true" })
          }
        }
        if (attempt.status === "failed" && attempt.failures.length === 0) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "failures"], message: "failed attempt requires failures" })
        }
        if (def.agent === "checker" && attempt.output !== undefined) {
          const outputScore = (attempt.output as { score: number }).score
          if (attempt.score !== outputScore) {
            ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "score"], message: "checker attempt score must match its output" })
          }
        } else if (attempt.score !== undefined) {
          ctx.addIssue({ code: "custom", path: ["nodes", id, "attempts", i, "score"], message: "score requires validated checker output" })
        }
      })

      const finalAttempt = state.attempts.at(-1)
      if (state.output !== undefined && !schemaForAgent(def.agent).safeParse(state.output).success) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "output"], message: `node output violates ${def.agent} schema` })
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
      const latestOutput = [...state.attempts].reverse().find((attempt) => attempt.output !== undefined)?.output
      if (state.output !== undefined && (latestOutput === undefined || !isDeepStrictEqual(state.output, latestOutput))) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "output"], message: "node output must come from the latest validated attempt output" })
      }
      if (state.status === "running" && finalAttempt?.status !== "running") {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "status"], message: "running node requires a running final attempt" })
      }
      if (state.status !== "running" && finalAttempt?.status === "running") {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "status"], message: "running final attempt requires running node status" })
      }
      if (state.status === "done") {
        if (!finalAttempt || finalAttempt.status !== "done" || state.output === undefined || !isDeepStrictEqual(state.output, finalAttempt.output)) {
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
      if ((state.status === "failed" || state.status === "skipped") && state.last_failures.length === 0) {
        ctx.addIssue({ code: "custom", path: ["nodes", id, "last_failures"], message: `${state.status} node requires a recorded reason` })
      }
      if (state.status === "done" && state.last_failures.length !== 0) {
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
  })
  .transform((run) => {
    const nodes = Object.create(null) as Record<string, (typeof run.nodes)[string]>
    for (const [id, state] of Object.entries(run.nodes)) nodes[id] = state
    return { ...run, nodes }
  })

export function parseGraph(raw: unknown): GraphDef {
  return GraphDefSchema.parse(raw)
}

export function parseRunState(raw: unknown): RunState {
  const run = RunStateSchema.parse(raw)
  for (const model of Object.values(run.model_snapshot)) Object.freeze(model)
  Object.freeze(run.model_snapshot)
  return run
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
  return {
    ok: false,
    failures: result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
  }
}

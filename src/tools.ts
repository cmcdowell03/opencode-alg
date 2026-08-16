import { tool } from "@opencode-ai/plugin"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import { validateGraph } from "./graph.ts"
import { executeRun, prepareRunForResume } from "./executor.ts"
import {
  createRun,
  hydrateRunFully,
  listOwnedRunEnvelopeResults,
  loadCommittedRunProjectionForOwner,
  readNodeArtifactOutput,
  runDir,
} from "./store.ts"
import { getTemplate, listTemplates } from "./templates.ts"
import type { AgentModelMap, GraphDef, ModelResolutionMap, RunState } from "./types.ts"
import { mutateOwnedRun, resolveOwnedRun, transferRunOwnership } from "./ownership.ts"
import {
  loadModelSettings,
  setAgentModel,
  setAgentModelVariant,
  modelResolutionsForRun,
  modelSnapshotFromResolution,
  snapshotModelResolutions,
} from "./models.ts"
import {
  assertFilesystemRootAuthorized,
  canonicalContainedDirectory,
  canonicalDirectory,
  isContained,
  isFilesystemRoot,
} from "./paths.ts"
import { formatSdkError } from "./diagnostics.ts"
import { serializedBytes, truncateUtf8, utf8Bytes } from "./limits.ts"

type Detail = "compact" | "full"
const PREVIEW_BYTES = 2_048
const COMPACT_OUTPUT_BYTES = 64 * 1_024
const COMPACT_TEXT_BYTES = 384
const COMPACT_SUMMARY_BYTES = 1_024
const COMPACT_EVENT_COUNT = 24
const COMPACT_NODE_COUNT = 24
const COMPACT_ATTEMPT_COUNT = 32
const COMPACT_SESSION_COUNT = 32
const COMPACT_ROOT_AUTHORIZATION_COUNT = 8
const COMPACT_LIST_COUNT = 20
const COMPACT_LIST_GOAL_CHARS = 120

function ok(title: string, data: unknown, meta?: Record<string, unknown>) {
  return {
    title,
    output: typeof data === "string" ? data : JSON.stringify(data, null, 2),
    metadata: { alg: true, ...meta },
  }
}

function err(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return {
    title: "alg error",
    output: JSON.stringify({ error: message }, null, 2),
    metadata: { alg: true, error: true },
  }
}

function cap(value: string, maximum = COMPACT_TEXT_BYTES): string {
  if (utf8Bytes(value) <= maximum) return value
  const suffix = "…"
  return `${truncateUtf8(value, maximum - utf8Bytes(suffix))}${suffix}`
}

function rootAuthorization(run: RunState, detail: Detail = "compact") {
  const authorizations = run.filesystem_root_authorizations ?? []
  const reference = run.filesystem_root_authorizations_ref
  const legacyOmitted = reference ? 0 : (run.filesystem_root_authorizations_omitted ?? 0)
  const total = reference?.authorization_count ?? authorizations.length + legacyOmitted
  const retained = authorizations.length
  const visible = detail === "full"
    ? authorizations
    : authorizations.slice(-COMPACT_ROOT_AUTHORIZATION_COUNT)
  const knownOperationCounts = { plan: 0, run: 0, resume: 0 }
  for (const authorization of authorizations) knownOperationCounts[authorization.operation]++
  return {
    filesystem_root: isFilesystemRoot(run.project_directory) || authorizations.some((entry) => entry.authorized === true),
    explicit_per_call: true,
    authorizations: visible,
    authorization_count: total,
    authorizations_retained: retained,
    authorizations_omitted: total - retained,
    authorizations_displayed: visible.length,
    authorizations_display_omitted: retained - visible.length,
    operation_counts: reference?.operation_counts ?? knownOperationCounts,
    operation_counts_complete: Boolean(reference) || legacyOmitted === 0,
    operation_counts_unknown: legacyOmitted,
  }
}

export interface AlgToolRuntime {
  /** Additive root classification for isolated tool-path tests; cannot unmark a real root. */
  additionalFilesystemRoot?: (projectDirectory: string) => boolean
}

function compactModels(run: RunState): ModelResolutionMap {
  return modelResolutionsForRun(run)
}

function compactNodes(run: RunState) {
  const definitions = run.graph.nodes.slice(0, COMPACT_NODE_COUNT)
  const selected = new Map<string, RunState["nodes"][string]["attempts"]>()
  for (const definition of definitions) selected.set(definition.id, [])

  let remainingAttempts = COMPACT_ATTEMPT_COUNT
  for (let offset = 0; remainingAttempts > 0; offset++) {
    let found = false
    for (const definition of definitions) {
      if (remainingAttempts === 0) break
      const node = run.nodes[definition.id]!
      const attempt = node.attempts.at(-(offset + 1))
      if (!attempt) continue
      selected.get(definition.id)!.push(attempt)
      remainingAttempts--
      found = true
    }
    if (!found) break
  }

  let remainingSessions = COMPACT_SESSION_COUNT
  let textFieldsTruncated = 0
  let sessionsShown = 0
  let archivedSessionsUnknown = 0
  const nodes = Object.fromEntries(definitions.map((definition) => {
    const node = run.nodes[definition.id]!
    const attempts = selected.get(definition.id)!.sort((left, right) => left.attempt - right.attempt)
    const latestFailure = node.last_failures[0] ?? null
    if (latestFailure !== null && utf8Bytes(latestFailure) > COMPACT_TEXT_BYTES) textFieldsTruncated++
    const sessionIds: string[] = []
    const attemptHistory = attempts.map((attempt) => {
      let sessionId: string | null = null
      if (attempt.session_id && remainingSessions > 0) {
        if (utf8Bytes(attempt.session_id) > COMPACT_TEXT_BYTES) textFieldsTruncated++
        sessionId = cap(attempt.session_id)
        sessionIds.push(sessionId)
        remainingSessions--
        sessionsShown++
      }
      return {
        attempt: attempt.attempt,
        status: attempt.status,
        outcome: attempt.outcome ?? "legacy-unknown",
        session_id: sessionId,
        ...(attempt.output_ref ? { output_ref: attempt.output_ref } : {}),
        ...(attempt.detail_ref ? { detail_ref: attempt.detail_ref } : {}),
      }
    })
    const visibleSessionCount = node.attempts.filter((attempt) => Boolean(attempt.session_id)).length
    const archivedSessionCount = node.attempt_history_ref?.session_count
    if (node.attempt_history_ref && archivedSessionCount === undefined) {
      archivedSessionsUnknown += node.attempt_history_ref.attempt_count
    }
    const nodeSessionCount = visibleSessionCount + (archivedSessionCount ?? 0)
    return [node.id, {
      role: node.agent,
      status: node.status,
      attempts: node.current_attempt,
      max_attempts: definition.loop?.max_attempts ?? 1,
      latest_failure: latestFailure === null ? null : cap(latestFailure),
      session_ids: sessionIds,
      sessions_omitted: nodeSessionCount - sessionIds.length,
      attempt_history: attemptHistory,
      attempts_omitted: Math.max(0, node.current_attempt - attempts.length),
      ...(node.attempt_history_ref ? { attempt_history_ref: node.attempt_history_ref } : {}),
      ...(node.output_ref ? { output_ref: node.output_ref } : {}),
      has_output: node.output !== undefined || node.output_ref !== undefined,
    }]
  }))
  const allNodes = Object.values(run.nodes)
  const totalAttempts = allNodes.reduce((sum, node) => sum + node.current_attempt, 0)
  const totalSessions = allNodes.reduce(
    (sum, node) => sum + node.attempts.filter((attempt) => Boolean(attempt.session_id)).length +
      (node.attempt_history_ref?.session_count ?? 0),
    0,
  )
  const attemptsShown = [...selected.values()].reduce((sum, attempts) => sum + attempts.length, 0)
  return {
    nodes,
    truncation: {
      nodes_omitted: run.graph.nodes.length - definitions.length,
      attempts_omitted: Math.max(0, totalAttempts - attemptsShown),
      sessions_omitted: totalSessions - sessionsShown,
      archived_sessions_unknown: archivedSessionsUnknown,
      text_fields_truncated: textFieldsTruncated,
    },
  }
}

function failureVerification(run: RunState) {
  let projections = 0
  let committed = 0
  for (const node of Object.values(run.nodes)) {
    projections++
    if (node.last_failures_commitment) committed++
    for (const attempt of node.attempts) {
      projections++
      if (attempt.failures_commitment) committed++
    }
    if (node.attempt_history_ref) {
      projections += node.attempt_history_ref.attempt_count
      committed += node.attempt_history_ref.failure_commitment_count ?? 0
    }
  }
  const legacy = projections - committed
  return {
    algorithm: "sha256",
    projections,
    committed,
    legacy_uncommitted: legacy,
    complete: legacy === 0,
    ...(legacy ? { note: "Legacy failure projections lack a ref-independent complete-list commitment and received weaker compatibility verification." } : {}),
  }
}

function compactPlanNodes(run: RunState) {
  const definitions = run.graph.nodes.slice(0, COMPACT_NODE_COUNT)
  const nodes = definitions.map((node) => {
    const dependsOn = node.depends_on.slice(0, 2)
    return {
      id: node.id,
      role: node.agent,
      depends_on: dependsOn,
      dependencies_omitted: node.depends_on.length - dependsOn.length,
      max_attempts: node.loop?.max_attempts ?? 1,
    }
  })
  const dependencyCount = run.graph.nodes.reduce((sum, node) => sum + node.depends_on.length, 0)
  const shownDependencies = nodes.reduce((sum, node) => sum + node.depends_on.length, 0)
  return {
    nodes,
    truncation: {
      nodes_omitted: run.graph.nodes.length - definitions.length,
      dependencies_omitted: dependencyCount - shownDependencies,
    },
  }
}

function routingSummary(run: RunState) {
  const outcomes = {
    passed: 0,
    schema_invalid: 0,
    sdk_error: 0,
    substantive_rejection: 0,
    incomplete: 0,
    gate_failure: 0,
    legacy_unknown: 0,
  }
  let checkerSchemaInvalid = 0
  let nodeSchemaInvalid = 0
  let feedbackRoutes = 0
  let archivedOutcomesUnknown = 0
  let archivedFeedbackRoutesUnknown = 0
  for (const node of Object.values(run.nodes)) {
    for (const attempt of node.attempts) {
      const outcome = attempt.outcome ?? "legacy_unknown"
      outcomes[outcome]++
      if (outcome === "schema_invalid") {
        if (node.agent === "checker") checkerSchemaInvalid++
        else nodeSchemaInvalid++
      }
      if (attempt.feedback_applied) feedbackRoutes++
    }
    const reference = node.attempt_history_ref
    if (!reference) continue
    if (reference.outcome_counts) {
      for (const outcome of Object.keys(outcomes) as Array<keyof typeof outcomes>) {
        outcomes[outcome] += reference.outcome_counts[outcome]
      }
      if (node.agent === "checker") checkerSchemaInvalid += reference.outcome_counts.schema_invalid
      else nodeSchemaInvalid += reference.outcome_counts.schema_invalid
    } else {
      archivedOutcomesUnknown += reference.attempt_count
    }
    if (reference.feedback_applied_count === undefined) {
      archivedFeedbackRoutesUnknown += reference.attempt_count
    } else {
      feedbackRoutes += reference.feedback_applied_count
    }
  }
  return {
    checker_self_retries: checkerSchemaInvalid,
    node_schema_retries: nodeSchemaInvalid,
    substantive_rejections: outcomes.substantive_rejection,
    feedback_routes: feedbackRoutes,
    sdk_errors: outcomes.sdk_error,
    gate_failures: outcomes.gate_failure,
    incomplete: outcomes.incomplete,
    passed: outcomes.passed,
    legacy_unknown: outcomes.legacy_unknown,
    outcome_counts: outcomes,
    archived_outcomes_unknown: archivedOutcomesUnknown,
    archived_feedback_routes_unknown: archivedFeedbackRoutesUnknown,
    complete: archivedOutcomesUnknown === 0 && archivedFeedbackRoutesUnknown === 0,
  }
}

function nextAction(run: RunState): string {
  if (run.status === "planning") return `Call alg_run with run_id=${run.run_id}; filesystem-root approval, if needed, must be explicit again.`
  if (run.status === "blocked" || run.status === "running") return `Call alg_resume with run_id=${run.run_id} for another bounded synchronous wave set.`
  if (run.status === "done") return "Inspect compact artifacts or request detail=full for complete typed output."
  return "Inspect alg_status/detail=full and failure artifacts; attempt limits require a new run when exhausted."
}

function executionSummary(run: RunState, events: string[]) {
  let startedAt: string | undefined
  let finishedAt: string | undefined
  let childSessions = 0
  for (const node of Object.values(run.nodes)) {
    childSessions += node.attempt_history_ref?.session_count ?? 0
    for (const attempt of node.attempts) {
      if (!startedAt || attempt.started_at < startedAt) startedAt = attempt.started_at
      if (attempt.finished_at && (!finishedAt || attempt.finished_at > finishedAt)) finishedAt = attempt.finished_at
      if (attempt.session_id) childSessions++
    }
  }
  const summary = run.summary
  return {
    persisted_summary: summary ? cap(summary, COMPACT_SUMMARY_BYTES) : null,
    persisted_summary_truncated: Boolean(summary && utf8Bytes(summary) > COMPACT_SUMMARY_BYTES),
    started_at: startedAt ?? null,
    finished_at: finishedAt ?? null,
    child_sessions: childSessions,
    event_count: events.length,
    wave_count: events.filter((event) => /^wave \d+:/.test(event)).length,
  }
}

function finalizeCompact(data: Record<string, unknown>): Record<string, unknown> {
  const truncation = isPlainRecord(data.truncation) ? data.truncation : {}
  const candidate: Record<string, unknown> = {
    ...data,
    truncation: { ...truncation, aggregate_byte_limit: COMPACT_OUTPUT_BYTES },
  }
  const originalBytes = utf8Bytes(JSON.stringify(candidate, null, 2))
  if (originalBytes <= COMPACT_OUTPUT_BYTES) return candidate

  // This defensive reduction is only reached if future fields defeat the
  // explicit node/event/text budgets above. It remains valid JSON and reports
  // exactly why detailed summaries were omitted.
  return {
    run_id: candidate.run_id,
    status: candidate.status,
    phase: candidate.phase,
    mode: candidate.mode,
    template: candidate.template,
    criteria_locked: candidate.criteria_locked,
    criteria_count: candidate.criteria_count,
    global_attempts: candidate.global_attempts,
    project_scope: typeof candidate.project_scope === "string" ? cap(candidate.project_scope, 2_048) : undefined,
    execution_summary: candidate.execution_summary,
    next: candidate.next,
    path: typeof candidate.path === "string" ? cap(candidate.path, 2_048) : undefined,
    truncation: {
      ...truncation,
      aggregate_byte_limit: COMPACT_OUTPUT_BYTES,
      aggregate_reduced: true,
      pre_reduction_bytes: originalBytes,
    },
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function runResponse(run: RunState, events: string[], detail: Detail) {
  if (detail === "full") {
    const full = hydrateRunFully(run)
    const committed = loadCommittedRunProjectionForOwner(
      run.project_directory,
      run.run_id,
      run.owner_session_id,
    ) ?? run
    const visibleEvents = events.slice(-128).map((event) => cap(event))
    return {
      ...full,
      events: visibleEvents,
      events_omitted: Math.max(0, events.length - visibleEvents.length),
      retry_routing: routingSummary(full),
      root_authorization: rootAuthorization(full, "full"),
      failure_verification: failureVerification(committed),
      model_resolution: compactModels(full),
      path: runDir(full.project_directory, full.run_id),
      next: nextAction(full),
    }
  }
  const compacted = compactNodes(run)
  const compactEvents = events.slice(-COMPACT_EVENT_COUNT).map((event) => cap(event))
  const truncatedEvents = events.filter((event) => utf8Bytes(event) > COMPACT_TEXT_BYTES).length
  return finalizeCompact({
    run_id: run.run_id,
    status: run.status,
    phase: run.phase,
    mode: run.mode,
    events: compactEvents,
    execution_summary: executionSummary(run, events),
    global_attempts: `${run.global_attempts}/${run.graph.max_global_attempts}`,
    nodes: compacted.nodes,
    retry_routing: routingSummary(run),
    state_projection: run.state_projection,
    root_authorization: rootAuthorization(run),
    failure_verification: failureVerification(run),
    model_resolution: compactModels(run),
    next: nextAction(run),
    path: runDir(run.project_directory, run.run_id),
    truncation: {
      ...compacted.truncation,
      events_omitted: Math.max(0, events.length - compactEvents.length),
      text_fields_truncated: compacted.truncation.text_fields_truncated + truncatedEvents,
    },
  })
}

function roots(plugin: PluginInput, context: ToolContext): { project: string; directory: string } {
  const project = canonicalDirectory(context.worktree || plugin.worktree || context.directory || plugin.directory)
  const directory = canonicalContainedDirectory(project, context.directory || plugin.directory || project)
  return { project, directory }
}

function ownedRun(
  project: string,
  sessionId: string,
  runId?: string,
): RunState | null {
  return resolveOwnedRun(project, sessionId, runId)
}

export function withShellGate(
  graph: GraphDef,
  command: string,
  timeoutMs?: number,
): GraphDef {
  const clone = structuredClone(graph)
  const implementer = clone.nodes.find((node) => node.agent === "implementer")
  if (!implementer) throw new Error("graph has no implementer node for shell gate")
  implementer.shell_gate = {
    ...implementer.shell_gate,
    cmd: command,
    ...(timeoutMs !== undefined ? { timeout_ms: timeoutMs } : {}),
  }
  implementer.loop = {
    max_attempts: implementer.loop?.max_attempts ?? 1,
    gate: "all",
  }
  return validateGraph(clone)
}

async function validateTransferTarget(
  plugin: PluginInput,
  context: ToolContext,
  project: string,
  directory: string,
  targetSessionId: string,
): Promise<void> {
  const response = await plugin.client.session.get({
    path: { id: targetSessionId },
    query: { directory },
    responseStyle: "fields",
    throwOnError: false,
    signal: context.abort,
  })
  if (response.error) throw new Error(`target session lookup failed: ${formatSdkError(response.error)}`)
  const target = response.data
  if (!target || target.id !== targetSessionId) throw new Error("target session does not exist")
  if (plugin.project?.id && target.projectID !== plugin.project.id) {
    throw new Error("target session belongs to a different project")
  }
  const targetDirectory = canonicalDirectory(target.directory)
  if (!isContained(project, targetDirectory)) {
    throw new Error("target session directory is outside this project")
  }
}

export function createAlgTools(
  plugin: PluginInput,
  configuredModels: () => AgentModelMap = () => ({}),
  configuredResolutions: () => ModelResolutionMap | undefined = () => undefined,
  runtime: AlgToolRuntime = {},
) {
  const { client } = plugin
  const isAdditionalFilesystemRoot = (project: string): boolean =>
    runtime.additionalFilesystemRoot?.(project) === true
  return {
    alg_templates: tool({
      description: "List built-in ALG graph templates.",
      args: {},
      async execute() {
        return ok("alg templates", listTemplates())
      },
    }),

    alg_models: tool({
      description: "View, set, or clear strict project-scoped ALG per-agent model selections and model-specific effort variants.",
      args: {
        agent: tool.schema.enum(["explorer", "researcher", "implementer", "checker"]).optional(),
        provider_id: tool.schema.string().min(1).max(128).optional(),
        model_id: tool.schema.string().min(1).max(256).optional(),
        variant: tool.schema.string().trim().min(1).max(128).describe("Model-specific effort as an exact variant key from that model's catalog.").optional(),
        clear_variant: tool.schema.boolean().optional(),
        clear: tool.schema.boolean().optional(),
        revision: tool.schema.number().int().nonnegative().optional(),
      },
      async execute(args, context) {
        try {
          const { project } = roots(plugin, context)
          const hasProvider = args.provider_id !== undefined
          const hasModel = args.model_id !== undefined
          const hasVariant = args.variant !== undefined
          if (!args.agent) {
            if (hasProvider || hasModel || hasVariant || args.clear || args.clear_variant) {
              throw new Error("agent is required to change a model or variant")
            }
            return ok("alg models", loadModelSettings(project))
          }
          if (args.clear) {
            if (hasProvider || hasModel || hasVariant || args.clear_variant) {
              throw new Error("clear cannot be combined with provider_id, model_id, variant, or clear_variant")
            }
            return ok("alg models", setAgentModel(project, args.agent, null, args.revision))
          }
          if (args.clear_variant) {
            if (hasProvider || hasModel || hasVariant) {
              throw new Error("clear_variant cannot be combined with provider_id, model_id, or variant")
            }
            return ok(
              "alg models",
              setAgentModelVariant(project, args.agent, null, args.revision),
            )
          }
          if (hasProvider !== hasModel) throw new Error("provider_id and model_id are both required")
          if (!hasProvider && hasVariant) {
            return ok(
              "alg models",
              setAgentModelVariant(project, args.agent, args.variant!, args.revision),
            )
          }
          if (!hasProvider) {
            throw new Error("provide provider_id and model_id, variant, clear_variant=true, or clear=true")
          }
          return ok(
            "alg models",
            setAgentModel(
              project,
              args.agent,
              {
                providerID: args.provider_id!,
                modelID: args.model_id!,
                ...(hasVariant ? { variant: args.variant } : {}),
              },
              args.revision,
            ),
          )
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_criteria: tool({
      description: "Update criteria on an owned planned run. Call alg_plan first; normally pass user criteria directly to alg_plan.",
      args: {
        criteria: tool.schema.array(tool.schema.string().min(1).max(2_000)).max(100),
        run_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
        lock: tool.schema.boolean().optional(),
      },
      async execute(args, context) {
        try {
          const { project } = roots(plugin, context)
          let run = ownedRun(project, context.sessionID, args.run_id)
          if (!run) throw new Error("No owned planned run found. Call alg_plan first and pass criteria directly to alg_plan when possible.")
          if (run.status !== "planning") throw new Error("Criteria can only be changed while the run is planning")
          if (run.criteria_locked && run.criteria.length && args.lock !== false) {
            throw new Error(`Criteria are locked on run ${run.run_id}; pass lock=false to replace and leave unlocked.`)
          }
          run = mutateOwnedRun(project, run.run_id, context.sessionID, (fresh) => {
            if (fresh.status !== "planning") throw new Error("Criteria can only be changed while the run is planning")
            if (fresh.criteria_locked && fresh.criteria.length && args.lock !== false) {
              throw new Error(`Criteria are locked on run ${fresh.run_id}; pass lock=false to replace and leave unlocked.`)
            }
            fresh.criteria = args.criteria
            fresh.criteria_locked = args.lock !== false
          })
          return ok("alg criteria", {
            run_id: run.run_id,
            criteria: run.criteria,
            criteria_locked: run.criteria_locked,
            path: runDir(project, run.run_id),
          })
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_plan: tool({
      description: "Create and persist an owned ALG DAG. Compact by default; detail=full includes full criteria and node definitions.",
      args: {
        goal: tool.schema.string().min(1).max(20_000),
        template: tool.schema.enum(["coding-diamond", "research-diamond"]).optional(),
        criteria: tool.schema.array(tool.schema.string().min(1).max(2_000)).max(100).optional(),
        shell_gate: tool.schema.string().min(1).max(8_192).optional(),
        shell_timeout_ms: tool.schema.number().int().min(100).max(600_000).optional(),
        mode: tool.schema.enum(["live", "dry"]).optional(),
        graph_json: tool.schema.string().min(2).max(200_000).optional(),
        allow_filesystem_root: tool.schema.boolean().optional().describe("Explicit one-call approval for planning at a filesystem root; does not authorize run/resume."),
        detail: tool.schema.enum(["compact", "full"]).optional(),
      },
      async execute(args, context) {
        try {
          const { project } = roots(plugin, context)
          // Authorize root scope before model-settings recovery/quarantine or
          // run creation can touch the filesystem.
          const additionalFilesystemRoot = isAdditionalFilesystemRoot(project)
          assertFilesystemRootAuthorized(project, args.allow_filesystem_root, "plan", additionalFilesystemRoot)
          const source: unknown = args.graph_json
            ? JSON.parse(args.graph_json)
            : getTemplate(args.template ?? "coding-diamond")
          let graph = validateGraph(source)
          if (args.shell_timeout_ms !== undefined && !args.shell_gate) {
            throw new Error("shell_timeout_ms requires shell_gate")
          }
          if (args.shell_gate) graph = withShellGate(graph, args.shell_gate, args.shell_timeout_ms)
          const modelResolution = snapshotModelResolutions(
            project,
            configuredResolutions(),
            configuredModels(),
          )
          const run = createRun({
            goal: args.goal,
            criteria: args.criteria ?? [],
            graph,
            projectDirectory: project,
            ownerSessionId: context.sessionID,
            mode: args.mode ?? "live",
            modelSnapshot: modelSnapshotFromResolution(modelResolution),
            modelResolution,
            allowFilesystemRoot: args.allow_filesystem_root,
            treatProjectAsFilesystemRoot: additionalFilesystemRoot,
          })
          const detail = args.detail ?? "compact"
          const fullRun = detail === "full" ? hydrateRunFully(run) : undefined
          const compactedNodes = compactPlanNodes(run)
          const compact = finalizeCompact({
            run_id: run.run_id,
            template: graph.name,
            mode: run.mode,
            criteria_locked: run.criteria_locked,
            criteria_count: run.criteria.length,
            project_scope: run.project_directory,
            root_authorization: rootAuthorization(run),
            model_resolution: compactModels(run),
            nodes: compactedNodes.nodes,
            truncation: compactedNodes.truncation,
            path: runDir(project, run.run_id),
            next: nextAction(run),
          })
          return ok(
            "alg plan",
            detail === "full" ? {
              run_id: run.run_id,
              template: graph.name,
              mode: run.mode,
              criteria_locked: run.criteria_locked,
              criteria_count: run.criteria.length,
              project_scope: run.project_directory,
              root_authorization: rootAuthorization(run, "full"),
              model_resolution: compactModels(run),
              goal: run.goal,
              criteria: run.criteria,
              model_snapshot: run.model_snapshot,
              graph,
              nodes: graph.nodes,
              run: fullRun,
              path: runDir(project, run.run_id),
              next: nextAction(run),
            } : compact,
            { run_id: run.run_id },
          )
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_run: tool({
      description: "Synchronously execute ready ALG waves under an exclusive lease. Compact by default; this call does not live-stream.",
      args: {
        run_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
        dry: tool.schema.boolean().optional(),
        shell_gate: tool.schema.string().min(1).max(8_192).optional(),
        shell_timeout_ms: tool.schema.number().int().min(100).max(600_000).optional(),
        max_waves: tool.schema.number().int().positive().max(1_000).optional(),
        max_concurrency: tool.schema.number().int().positive().max(8).optional(),
        allow_filesystem_root: tool.schema.boolean().optional().describe("Explicit approval for this execution call only."),
        detail: tool.schema.enum(["compact", "full"]).optional(),
      },
      async execute(args, context) {
        try {
          const { project, directory } = roots(plugin, context)
          // loadRunForOwner may recover sidecars, reconcile mirrors, or
          // quarantine corruption, so root authorization must happen first.
          const additionalFilesystemRoot = isAdditionalFilesystemRoot(project)
          assertFilesystemRootAuthorized(project, args.allow_filesystem_root, "run", additionalFilesystemRoot)
          const run = ownedRun(project, context.sessionID, args.run_id)
          if (!run) throw new Error("No owned run found. Call alg_plan first.")
          if (args.shell_gate) {
            run.graph = withShellGate(run.graph, args.shell_gate, args.shell_timeout_ms)
          } else if (args.shell_timeout_ms !== undefined) {
            throw new Error("shell_timeout_ms requires shell_gate")
          }
          const events: string[] = []
          const updated = await executeRun(run, {
            client,
            parentSessionId: context.sessionID,
            directory,
            worktree: project,
            toolContext: context,
            dry: args.dry === true || run.mode === "dry",
            shellGateCmd: args.shell_gate,
            shellGateTimeoutMs: args.shell_timeout_ms,
            maxWaves: args.max_waves,
            maxConcurrency: args.max_concurrency,
            allowFilesystemRoot: args.allow_filesystem_root,
            treatProjectAsFilesystemRoot: additionalFilesystemRoot,
            operation: "run",
            onEvent: (message) => events.push(message),
          })
          return ok(
            "alg run",
            runResponse(
              args.detail === "full"
                ? ownedRun(project, context.sessionID, updated.run_id) ?? updated
                : loadCommittedRunProjectionForOwner(project, updated.run_id, context.sessionID) ?? updated,
              events,
              args.detail ?? "compact",
            ),
            { run_id: updated.run_id, status: updated.status },
          )
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_status: tool({
      description: "Show exactly-owned ALG run status compactly, or detail=full for complete persisted node/attempt state.",
      args: {
        run_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
        list: tool.schema.boolean().optional(),
        detail: tool.schema.enum(["compact", "full"]).optional(),
      },
      async execute(args, context) {
        try {
          const { project } = roots(plugin, context)
          if (args.list) {
            const listing = listOwnedRunEnvelopeResults(project, context.sessionID)
            const owned = listing.envelopes
            const full = args.detail === "full"
            if (full && listing.errors.length) {
              const failure = listing.errors[0]!
              throw new Error(`full status list failed for run ${failure.run_id}: ${failure.error}`)
            }
            if (full && listing.scan_truncated) {
              throw new Error("full status list failed: owned run discovery exceeded its bounded directory scan")
            }
            const visible = full ? owned : owned.slice(0, COMPACT_LIST_COUNT)
            const goalsTruncated = full
              ? 0
              : visible.filter((run) => run.goal.length > COMPACT_LIST_GOAL_CHARS).length
            const runs = full
              ? visible.map((envelope) => {
                  try {
                    const loaded = ownedRun(project, context.sessionID, envelope.run_id)
                    if (!loaded) throw new Error("run disappeared during full status list")
                    const hydrated = hydrateRunFully(loaded)
                    return { ...hydrated, path: runDir(project, hydrated.run_id) }
                  } catch (error) {
                    throw new Error(
                      `full status list failed for run ${envelope.run_id}: ${error instanceof Error ? error.message : String(error)}`,
                    )
                  }
                })
              : visible.map((run) => ({
                  run_id: run.run_id,
                  status: run.status,
                  goal: run.goal.slice(0, COMPACT_LIST_GOAL_CHARS),
                  updated_at: run.updated_at,
                }))
            const ownedErrorCount = listing.errors.length
            const ownedErrors = full ? [] : listing.errors.slice(0, 3)
            const validOmitted = owned.length - runs.length
            const omitted = validOmitted + ownedErrorCount
            return ok("alg runs", {
              runs,
              total: owned.length + ownedErrorCount,
              shown: runs.length,
              omitted,
              valid_runs_omitted: validOmitted,
              owned_error_count: ownedErrorCount,
              owned_errors: ownedErrors,
              owned_errors_omitted: Math.max(0, ownedErrorCount - ownedErrors.length),
              directories_scanned: listing.directories_scanned,
              scan_truncated: listing.scan_truncated,
              complete: omitted === 0 && !listing.scan_truncated,
              truncated_fields: goalsTruncated,
              goals_truncated: goalsTruncated,
              truncated: omitted > 0 || goalsTruncated > 0 || listing.scan_truncated,
            })
          }
          const loaded = ownedRun(project, context.sessionID, args.run_id)
          if (!loaded) throw new Error("No owned run found.")
          const run = args.detail === "full"
            ? loaded
            : loadCommittedRunProjectionForOwner(project, loaded.run_id, context.sessionID) ?? loaded
          const compacted = compactNodes(run)
          const compact = finalizeCompact({
            run_id: run.run_id,
            owner_session_id: run.owner_session_id,
            status: run.status,
            phase: run.phase,
            criteria_locked: run.criteria_locked,
            mode: run.mode,
            revision: run.revision,
            global_attempts: `${run.global_attempts}/${run.graph.max_global_attempts}`,
            updated_at: run.updated_at,
            path: runDir(project, run.run_id),
            root_authorization: rootAuthorization(run),
            failure_verification: failureVerification(run),
            model_resolution: compactModels(run),
            nodes: compacted.nodes,
            retry_routing: routingSummary(run),
            state_projection: run.state_projection,
            execution_summary: executionSummary(run, []),
            next: nextAction(run),
            truncation: compacted.truncation,
          })
          if (args.detail === "full") {
            const full = hydrateRunFully(run)
            return ok("alg status", {
              ...full,
              retry_routing: routingSummary(full),
              root_authorization: rootAuthorization(full, "full"),
              failure_verification: failureVerification(
                loadCommittedRunProjectionForOwner(project, full.run_id, context.sessionID) ?? run,
              ),
              model_resolution: compactModels(full),
              path: runDir(project, full.run_id),
              next: nextAction(full),
            })
          }
          return ok("alg status", compact)
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_resume: tool({
      description: "Synchronously resume an owned incomplete run without resetting attempt history. Compact by default.",
      args: {
        run_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
        dry: tool.schema.boolean().optional(),
        shell_gate: tool.schema.string().min(1).max(8_192).optional(),
        shell_timeout_ms: tool.schema.number().int().min(100).max(600_000).optional(),
        max_waves: tool.schema.number().int().positive().max(1_000).optional(),
        max_concurrency: tool.schema.number().int().positive().max(8).optional(),
        allow_filesystem_root: tool.schema.boolean().optional().describe("Explicit approval for this resume call only."),
        detail: tool.schema.enum(["compact", "full"]).optional(),
      },
      async execute(args, context) {
        try {
          const { project, directory } = roots(plugin, context)
          const additionalFilesystemRoot = isAdditionalFilesystemRoot(project)
          assertFilesystemRootAuthorized(project, args.allow_filesystem_root, "resume", additionalFilesystemRoot)
          const run = ownedRun(project, context.sessionID, args.run_id)
          if (!run) throw new Error("No owned run found to resume.")
          if (args.shell_gate) run.graph = withShellGate(run.graph, args.shell_gate, args.shell_timeout_ms)
          else if (args.shell_timeout_ms !== undefined) throw new Error("shell_timeout_ms requires shell_gate")
          prepareRunForResume(run)
          const events: string[] = []
          const updated = await executeRun(run, {
            client,
            parentSessionId: context.sessionID,
            directory,
            worktree: project,
            toolContext: context,
            dry: args.dry === true || run.mode === "dry",
            shellGateCmd: args.shell_gate,
            shellGateTimeoutMs: args.shell_timeout_ms,
            maxWaves: args.max_waves,
            maxConcurrency: args.max_concurrency,
            allowFilesystemRoot: args.allow_filesystem_root,
            treatProjectAsFilesystemRoot: additionalFilesystemRoot,
            operation: "resume",
            onEvent: (message) => events.push(message),
          })
          return ok("alg resume", runResponse(
            args.detail === "full"
              ? ownedRun(project, context.sessionID, updated.run_id) ?? updated
              : loadCommittedRunProjectionForOwner(project, updated.run_id, context.sessionID) ?? updated,
            events,
            args.detail ?? "compact",
          ))
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_artifact: tool({
      description: "Read compact artifact metadata/preview, or detail=full for complete typed content.",
      args: {
        node_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        run_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
        detail: tool.schema.enum(["compact", "full"]).optional(),
      },
      async execute(args, context) {
        try {
          const { project } = roots(plugin, context)
          const run = ownedRun(project, context.sessionID, args.run_id)
          if (!run) throw new Error("No owned run found.")
          const node = run.nodes[args.node_id]
          if (!node) throw new Error(`Unknown node ${args.node_id}`)
          const output = readNodeArtifactOutput(run, args.node_id)
          const serialized = JSON.stringify(output, null, 2)
          const byteSize = serializedBytes(output)
          const preview = utf8Bytes(serialized) <= PREVIEW_BYTES
            ? serialized
            : `${truncateUtf8(serialized, PREVIEW_BYTES - utf8Bytes("…[truncated]"))}…[truncated]`
          const metadata = {
            run_id: run.run_id,
            node_id: args.node_id,
            role: node.agent,
            status: node.status,
            attempts: node.current_attempt,
            artifact_path: `.opencode/runs/${run.run_id}/artifacts/${args.node_id}.json`,
            available_fields: output && typeof output === "object" && !Array.isArray(output)
              ? Object.keys(output).sort()
              : [],
            byte_size: byteSize,
          }
          return ok("alg artifact", args.detail === "full"
            ? { ...metadata, last_failures: node.last_failures, output }
            : finalizeCompact({
                ...metadata,
                last_failures: node.last_failures.slice(0, 3).map((failure) => cap(failure)),
                preview,
                preview_truncated: utf8Bytes(serialized) > PREVIEW_BYTES,
                truncation: {
                  failures_omitted: Math.max(0, node.last_failures.length - 3),
                  text_fields_truncated: node.last_failures.slice(0, 3)
                    .filter((failure) => utf8Bytes(failure) > COMPACT_TEXT_BYTES).length,
                },
              }))
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_transfer: tool({
      description: "Auditably transfer an exactly-owned run to another OpenCode session id.",
      args: {
        run_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        new_owner_session_id: tool.schema.string().min(1).max(256),
      },
      async execute(args, context) {
        try {
          const { project, directory } = roots(plugin, context)
          const owned = ownedRun(project, context.sessionID, args.run_id)
          if (!owned) throw new Error("No owned run found to transfer.")
          await validateTransferTarget(
            plugin,
            context,
            project,
            directory,
            args.new_owner_session_id,
          )
          const transferred = transferRunOwnership(
            project,
            args.run_id,
            context.sessionID,
            args.new_owner_session_id,
          )
          return ok("alg transfer", {
            run_id: transferred.run_id,
            owner_session_id: transferred.owner_session_id,
            transfer: transferred.owner_transfers.at(-1),
          })
        } catch (error) {
          return err(error)
        }
      },
    }),
  }
}

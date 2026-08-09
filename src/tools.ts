import { tool } from "@opencode-ai/plugin"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import { validateGraph } from "./graph.ts"
import { executeRun, prepareRunForResume } from "./executor.ts"
import { createRun, listOwnedRunEnvelopes, runDir } from "./store.ts"
import { getTemplate, listTemplates } from "./templates.ts"
import type { GraphDef, RunState } from "./types.ts"
import type { AgentModelMap } from "./types.ts"
import { mutateOwnedRun, resolveOwnedRun, transferRunOwnership } from "./ownership.ts"
import { loadModelSettings, setAgentModel, snapshotModels } from "./models.ts"
import { canonicalContainedDirectory, canonicalDirectory, isContained } from "./paths.ts"

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

function sdkError(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return JSON.stringify(error).slice(0, 1_000)
  } catch {
    return String(error).slice(0, 1_000)
  }
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
  if (response.error) throw new Error(`target session lookup failed: ${sdkError(response.error)}`)
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
) {
  const { client } = plugin
  return {
    alg_templates: tool({
      description: "List built-in ALG graph templates.",
      args: {},
      async execute() {
        return ok("alg templates", listTemplates())
      },
    }),

    alg_models: tool({
      description: "View, set, or clear strict project-scoped ALG per-agent model selections.",
      args: {
        agent: tool.schema.enum(["explorer", "researcher", "implementer", "checker"]).optional(),
        provider_id: tool.schema.string().min(1).max(128).optional(),
        model_id: tool.schema.string().min(1).max(256).optional(),
        clear: tool.schema.boolean().optional(),
        revision: tool.schema.number().int().nonnegative().optional(),
      },
      async execute(args, context) {
        try {
          const { project } = roots(plugin, context)
          if (!args.agent) {
            if (args.provider_id || args.model_id || args.clear) throw new Error("agent is required to change a model")
            return ok("alg models", loadModelSettings(project))
          }
          if (args.clear) {
            if (args.provider_id || args.model_id) throw new Error("clear cannot be combined with provider_id/model_id")
            return ok("alg models", setAgentModel(project, args.agent, null, args.revision))
          }
          if (!args.provider_id || !args.model_id) throw new Error("provider_id and model_id are both required")
          return ok(
            "alg models",
            setAgentModel(
              project,
              args.agent,
              { providerID: args.provider_id, modelID: args.model_id },
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
      description: "Create, strictly validate, and persist an owned ALG DAG without executing it.",
      args: {
        goal: tool.schema.string().min(1).max(20_000),
        template: tool.schema.enum(["coding-diamond", "research-diamond"]).optional(),
        criteria: tool.schema.array(tool.schema.string().min(1).max(2_000)).max(100).optional(),
        shell_gate: tool.schema.string().min(1).max(8_192).optional(),
        shell_timeout_ms: tool.schema.number().int().min(100).max(600_000).optional(),
        mode: tool.schema.enum(["live", "dry"]).optional(),
        graph_json: tool.schema.string().min(2).max(200_000).optional(),
      },
      async execute(args, context) {
        try {
          const { project } = roots(plugin, context)
          const source: unknown = args.graph_json
            ? JSON.parse(args.graph_json)
            : getTemplate(args.template ?? "coding-diamond")
          let graph = validateGraph(source)
          if (args.shell_timeout_ms !== undefined && !args.shell_gate) {
            throw new Error("shell_timeout_ms requires shell_gate")
          }
          if (args.shell_gate) graph = withShellGate(graph, args.shell_gate, args.shell_timeout_ms)
          const run = createRun({
            goal: args.goal,
            criteria: args.criteria ?? [],
            graph,
            projectDirectory: project,
            ownerSessionId: context.sessionID,
            mode: args.mode ?? "live",
            modelSnapshot: snapshotModels(project, configuredModels()),
          })
          return ok(
            "alg plan",
            {
              run_id: run.run_id,
              goal: run.goal,
              template: graph.name,
              mode: run.mode,
              criteria: run.criteria,
              model_snapshot: run.model_snapshot,
              nodes: graph.nodes,
              path: runDir(project, run.run_id),
              next: "Call alg_run with this run_id to execute.",
            },
            { run_id: run.run_id },
          )
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_run: tool({
      description: "Execute an exactly-owned ALG run under an exclusive lease.",
      args: {
        run_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
        dry: tool.schema.boolean().optional(),
        shell_gate: tool.schema.string().min(1).max(8_192).optional(),
        shell_timeout_ms: tool.schema.number().int().min(100).max(600_000).optional(),
        max_waves: tool.schema.number().int().positive().max(1_000).optional(),
        max_concurrency: tool.schema.number().int().positive().max(8).optional(),
      },
      async execute(args, context) {
        try {
          const { project, directory } = roots(plugin, context)
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
            onEvent: (message) => events.push(message),
          })
          return ok(
            "alg run",
            {
              run_id: updated.run_id,
              status: updated.status,
              phase: updated.phase,
              mode: updated.mode,
              events,
              summary: updated.summary,
              nodes: Object.fromEntries(Object.values(updated.nodes).map((node) => [node.id, {
                status: node.status,
                attempts: node.current_attempt,
                session_ids: node.attempts.map((attempt) => attempt.session_id).filter(Boolean),
                last_failures: node.last_failures,
                has_output: node.output !== undefined,
              }])),
              path: runDir(project, updated.run_id),
            },
            { run_id: updated.run_id, status: updated.status },
          )
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_status: tool({
      description: "Show exactly-owned ALG run status; list only current-session-owned runs.",
      args: {
        run_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
        list: tool.schema.boolean().optional(),
      },
      async execute(args, context) {
        try {
          const { project } = roots(plugin, context)
          if (args.list) {
            return ok("alg runs", listOwnedRunEnvelopes(project, context.sessionID)
              .slice(0, 20)
              .map((run) => ({ run_id: run.run_id, status: run.status, goal: run.goal.slice(0, 120), updated_at: run.updated_at })))
          }
          const run = ownedRun(project, context.sessionID, args.run_id)
          if (!run) throw new Error("No owned run found.")
          return ok("alg status", {
            run_id: run.run_id,
            owner_session_id: run.owner_session_id,
            owner_transfers: run.owner_transfers,
            status: run.status,
            phase: run.phase,
            goal: run.goal,
            criteria: run.criteria,
            criteria_locked: run.criteria_locked,
            mode: run.mode,
            revision: run.revision,
            global_attempts: run.global_attempts,
            updated_at: run.updated_at,
            path: runDir(project, run.run_id),
            nodes: run.nodes,
            summary: run.summary,
          })
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_resume: tool({
      description: "Resume an exactly-owned incomplete run without resetting attempt history.",
      args: {
        run_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
        dry: tool.schema.boolean().optional(),
        shell_gate: tool.schema.string().min(1).max(8_192).optional(),
        shell_timeout_ms: tool.schema.number().int().min(100).max(600_000).optional(),
      },
      async execute(args, context) {
        try {
          const { project, directory } = roots(plugin, context)
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
            onEvent: (message) => events.push(message),
          })
          return ok("alg resume", {
            run_id: updated.run_id,
            status: updated.status,
            summary: updated.summary,
            events,
            nodes: Object.fromEntries(Object.values(updated.nodes).map((node) => [node.id, {
              status: node.status,
              attempts: node.current_attempt,
              session_ids: node.attempts.map((attempt) => attempt.session_id).filter(Boolean),
              last_failures: node.last_failures,
              has_output: node.output !== undefined,
            }])),
            path: runDir(project, updated.run_id),
          })
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_artifact: tool({
      description: "Read a node artifact from an exactly-owned run.",
      args: {
        node_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        run_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
      },
      async execute(args, context) {
        try {
          const { project } = roots(plugin, context)
          const run = ownedRun(project, context.sessionID, args.run_id)
          if (!run) throw new Error("No owned run found.")
          const node = run.nodes[args.node_id]
          if (!node) throw new Error(`Unknown node ${args.node_id}`)
          return ok("alg artifact", {
            run_id: run.run_id,
            node_id: args.node_id,
            status: node.status,
            attempts: node.current_attempt,
            last_failures: node.last_failures,
            output: node.output ?? null,
          })
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

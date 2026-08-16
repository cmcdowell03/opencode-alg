/**
 * opencode-alg — Agents + Loops + Graphs for OpenCode
 *
 * Talk to the orchestrator agent; it calls alg_* tools.
 * Runtime owns DAG scheduling, loops, schema gates, and fresh child sessions.
 * Durable state: <project>/.opencode/runs/<run_id>/
 * Session tree: each node attempt = child session (parent_id) in OpenCode SQLite.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { ALG_PLUGIN_ID } from "./types.ts"
import { createAlgTools } from "./tools.ts"
import { findLatestIncompleteRunForSession } from "./store.ts"
import { configuredAgentModels, configuredModelResolutions } from "./models.ts"
import type { AgentModelMap, ModelResolutionMap } from "./types.ts"
import { formatCompactionContext } from "./compaction.ts"
import { verifiedLiveSourceIdentity } from "./source-identity.ts"

const server: Plugin = async (ctx) => {
  const { client, directory } = ctx
  let configuredModels: AgentModelMap = {}
  let modelResolutions: ModelResolutionMap = configuredModelResolutions({})

  const liveSource = verifiedLiveSourceIdentity("server")
  if (liveSource) {
    await client.app.log({
      body: {
        service: ALG_PLUGIN_ID,
        level: "info",
        message: liveSource.message,
      },
    })
  }

  try {
    await client.app.log({
      body: {
        service: ALG_PLUGIN_ID,
        level: "info",
        message: "alg plugin loaded (templates/models/criteria/plan/run/status/resume/artifact/transfer)",
        extra: { directory },
      },
    })
  } catch {
    /* log optional */
  }

  const tools = createAlgTools(
    ctx,
    () => structuredClone(configuredModels),
    () => structuredClone(modelResolutions),
  )

  return {
    tool: tools,

    config: async (config) => {
      configuredModels = configuredAgentModels(config)
      modelResolutions = configuredModelResolutions(config)
    },

    "experimental.session.compacting": async (input, output) => {
      try {
        const run = findLatestIncompleteRunForSession(ctx.worktree || directory, input.sessionID)
        if (!run) return
        output.context.push(formatCompactionContext(run))
      } catch {
        /* non-fatal */
      }
    },
  }
}

export default server
export { server, ALG_PLUGIN_ID }
export const OpencodeAlgPlugin = server

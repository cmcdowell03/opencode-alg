/**
 * opencode-alg — Agents + Loops + Graphs for OpenCode
 *
 * Talk to the orchestrator agent; it calls alg_* tools.
 * Runtime owns DAG scheduling, loops, schema gates, and fresh child sessions.
 * Durable state: <project>/.opencode/runs/<run_id>/
 * Session tree: each node attempt = child session (parent_id) in OpenCode SQLite.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { ALG_PLUGIN_ID, ALG_TOOL_IDS, algServerStartupMessage } from "./types.ts"
import { createAlgTools } from "./tools.ts"
import { findLatestIncompleteRunForSession } from "./store.ts"
import { configuredAgentModels, configuredModelResolutions } from "./models.ts"
import type { AgentModelMap, ModelResolutionMap } from "./types.ts"
import { formatCompactionContext } from "./compaction.ts"
import { verifiedLiveSourceIdentity } from "./source-identity.ts"
import { parseSkillEvolutionOptions } from "./skill-evolution-schemas.ts"
import { createSkillEvolutionRuntime } from "./skill-evolution-runtime.ts"
import { createSkillEvolutionTools } from "./skill-evolution-tools.ts"

const server: Plugin = async (ctx, pluginOptions) => {
  const { client, directory } = ctx
  const skillEvolutionOptions = parseSkillEvolutionOptions(pluginOptions)
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

  const tools = createAlgTools(
    ctx,
    () => structuredClone(configuredModels),
    () => structuredClone(modelResolutions),
  )
  const skillEvolution = createSkillEvolutionRuntime(ctx, {
    options: skillEvolutionOptions,
    configuredModels: () => structuredClone(configuredModels),
    configuredResolutions: () => structuredClone(modelResolutions),
  })
  const skillEvolutionTools = createSkillEvolutionTools(skillEvolution)
  const allTools = { ...tools, ...skillEvolutionTools }
  if (JSON.stringify(Object.keys(allTools)) !== JSON.stringify(ALG_TOOL_IDS)) {
    skillEvolution.dispose()
    throw new Error("ALG server tool registration differs from the exact public tool-ID contract")
  }

  try {
    await client.app.log({
      body: {
        service: ALG_PLUGIN_ID,
        level: "info",
        message: algServerStartupMessage(skillEvolutionOptions.enabled),
        extra: { directory, skill_evolution_enabled: skillEvolutionOptions.enabled },
      },
    })
  } catch {
    /* log optional */
  }

  return {
    tool: allTools,

    dispose: async () => {
      skillEvolution.dispose()
    },

    event: async ({ event }) => {
      skillEvolution.handleEvent(event)
    },

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

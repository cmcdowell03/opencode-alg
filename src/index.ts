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
import { appendAlgCompactionContext, formatCompactionContext } from "./compaction.ts"
import { formatSdkError } from "./diagnostics.ts"
import { verifiedLiveSourceIdentity } from "./source-identity.ts"
import { parseSkillEvolutionOptions, AlgPluginOptionsSchema } from "./skill-evolution-schemas.ts"
import { createSkillEvolutionRuntime } from "./skill-evolution-runtime.ts"
import { createSkillEvolutionTools } from "./skill-evolution-tools.ts"
import { observedConfigSkillRoots, SkillGuidance } from "./skill-catalog.ts"
import { SessionMemoryRuntime } from "./session-memory/runtime.ts"
import { createMemoryTools } from "./session-memory/tools.ts"
import { canonicalDirectory, isContained } from "./paths.ts"
import { isCompletedUserTurn } from "./turn-boundary.ts"

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

  const extraSkillRoots = observedConfigSkillRoots()
  const memory = new SessionMemoryRuntime(ctx.worktree || directory, AlgPluginOptionsSchema.parse(pluginOptions ?? {}).sessionMemory,
    skillEvolutionOptions.skillRoots, extraSkillRoots)
  const tools = createAlgTools(ctx, () => structuredClone(configuredModels), () => structuredClone(modelResolutions), { sessionMemory: memory })
  const authorizeMemory = async (owner: string) => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const response = await Promise.race([
        client.session.get({ path: { id: owner }, query: { directory }, signal: controller.signal, responseStyle: "fields", throwOnError: false }),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("memory session validation timed out")) }, 2000) }),
      ])
      const session = response.data
      if (response.error || !session || session.id !== owner || session.projectID !== ctx.project.id ||
        !isContained(memory.store.project, canonicalDirectory(session.directory))) throw new Error("memory session owner/project unavailable")
      if (String(session.title).startsWith("alg-private-")) throw new Error("private learning session is memory-excluded")
    } finally { if (timer) clearTimeout(timer) }
  }
  const skillGuidance = new SkillGuidance(ctx.worktree || directory, skillEvolutionOptions, extraSkillRoots)
  let disposed = false
  const resultCaptures = new Map<string, Promise<void>>()
  const captureResults = (owner: string) => {
    const previous = resultCaptures.get(owner) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(async () => {
      if (disposed) return
      await authorizeMemory(owner)
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const response = await Promise.race([
          client.session.messages({ path: { id: owner }, query: { directory, limit: 101 }, signal: controller.signal, responseStyle: "fields", throwOnError: false }),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("memory result capture timed out")) }, 2000) }),
        ])
        if (disposed) return
        if (response.error || !Array.isArray(response.data) || response.data.length > 100 || Buffer.byteLength(JSON.stringify(response.data)) > 2 * 1024 * 1024) throw new Error("memory result capture unavailable or exceeds bound")
        await authorizeMemory(owner)
        if (!disposed) memory.observe(response.data)
      } finally { if (timer) clearTimeout(timer) }
    }).finally(() => { if (resultCaptures.get(owner) === work) resultCaptures.delete(owner) })
    resultCaptures.set(owner, work)
    return work
  }
  const skillEvolution = createSkillEvolutionRuntime(ctx, {
    options: skillEvolutionOptions,
    extraSkillRoots,
    injectedSkillsForTurn: (sessionId, userMessageId) => skillGuidance.injectedSkillsForTurn(sessionId, userMessageId),
    configuredModels: () => structuredClone(configuredModels),
    configuredResolutions: () => structuredClone(modelResolutions),
  })
  const skillEvolutionTools = createSkillEvolutionTools(skillEvolution)
  const allTools = { ...tools, ...skillEvolutionTools, ...createMemoryTools(memory, authorizeMemory) }
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
      disposed = true
      await skillEvolution.dispose()
    },

    event: async ({ event }) => {
      skillEvolution.handleEvent(event)
      if (memory.enabled && event.type === "message.updated" && isCompletedUserTurn(event.properties.info)) {
        try { await captureResults(event.properties.info.sessionID) }
        catch (error) { try { await client.app.log({ body: { service: ALG_PLUGIN_ID, level: "warn", message: `ALG result capture unavailable: ${formatSdkError(error)}` } }) } catch {} }
      }
      if (memory.enabled && event.type === "session.deleted") {
        const info = event.properties.info
        try {
          if (info.projectID === ctx.project.id && isContained(memory.store.project, canonicalDirectory(info.directory))) memory.delete(info.id)
        } catch { /* deletion event failure cannot break the host event stream */ }
      }
    },

    config: async (config) => {
      configuredModels = configuredAgentModels(config)
      modelResolutions = configuredModelResolutions(config)
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        if (memory.enabled && output.messages.length) {
          const owner = output.messages.at(-1)?.info.sessionID
          if (owner) { await authorizeMemory(owner); memory.observe(output.messages) }
        }
      } catch (error) {
        try { Promise.resolve(client.app.log({ body: { service: ALG_PLUGIN_ID, level: "warn", message: `ALG memory capture unavailable: ${formatSdkError(error)}` } })).catch(() => {}) }
        catch { /* diagnostics must not suppress independent learning capture */ }
      }
      try {
        if (memory.options.mode !== "assist") skillGuidance.observeChatMessages(output.messages)
        await skillEvolution.captureChatMessages(output.messages)
      } catch (error) {
        try {
          Promise.resolve(client.app.log({ body: { service: ALG_PLUGIN_ID, level: "warn", message: `ALG ordinary-turn capture unavailable: ${formatSdkError(error)}` } })).catch(() => {})
        } catch { /* optional logging */ }
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      const appendRecovery = (label: string, read: () => string) => {
        try {
          const context = read()
          if (context) output.system.push(context)
        } catch {
          output.system.push(`ALG ${label} recovery unavailable; consult authoritative records before resuming.`)
        }
      }
      if (input.sessionID) {
        const sessionId = input.sessionID
        const recovery: string[] = []
        const collect = (label: string, read: () => string) => {
          try { const value = read(); if (value) recovery.push(value) }
          catch { recovery.push(`ALG ${label} recovery unavailable; consult authoritative records before resuming.`) }
        }
        collect("run", () => { const run = findLatestIncompleteRunForSession(ctx.worktree || directory, sessionId); return run ? formatCompactionContext(run) : "" })
        collect("evidence", () => skillEvolution.recoveryContext(sessionId))
        if (memory.enabled) {
          try {
            await authorizeMemory(sessionId)
            const pack = memory.prepare(sessionId, { context: input.model.limit.context, output: input.model.limit.output, existingText: output.system.join("\n"), mandatoryContext: recovery })
            if (pack.text) output.system.push(pack.text)
            if (memory.options.mode === "assist" && pack.receipt) return
          } catch {
            if (memory.options.mode === "assist") { output.system.push("ALG session memory unavailable; use alg_context_status before relying on restored procedures."); return }
          }
        }
        output.system.push(...recovery)
      }
      if (memory.options.mode !== "assist") appendRecovery("skill", () => skillGuidance.systemContext(input.sessionID))
    },

    "experimental.session.compacting": async (input, output) => {
      const owned: string[] = []
      if (memory.enabled && memory.options.mode === "assist") {
        try {
          await captureResults(input.sessionID)
          await authorizeMemory(input.sessionID)
          const pack = memory.prepare(input.sessionID)
          if (pack.text) owned.push(pack.text)
        } catch {
          owned.push("ALG working view unavailable; consult authoritative records before resuming.")
        }
        appendAlgCompactionContext(output.context, owned)
        return
      }
      if (memory.enabled) {
        try { await captureResults(input.sessionID); await authorizeMemory(input.sessionID) }
        catch { /* observe/off capture failure stays off the context channel */ }
      }
      const logCompactionFailure = (message: string) => {
        try {
          Promise.resolve(client.app.log({
            body: { service: ALG_PLUGIN_ID, level: "error", message },
          })).catch(() => {})
        } catch {
          /* log optional */
        }
      }
      try {
        const run = findLatestIncompleteRunForSession(ctx.worktree || directory, input.sessionID)
        if (run) owned.push(formatCompactionContext(run))
      } catch (error) {
        logCompactionFailure(`ALG compaction hook failed: ${formatSdkError(error)}`)
      }
      try {
        const context = await skillEvolution.compactSession(input.sessionID)
        if (context) owned.push(context)
      } catch (error) {
        logCompactionFailure(`ALG skill-evolution compaction hook failed: ${formatSdkError(error)}`)
      }
      const skills = memory.options.mode === "assist" ? "" : skillGuidance.compactionContext(input.sessionID)
      if (skills) owned.push(skills)
      appendAlgCompactionContext(output.context, owned)
    },
  }
}

export default server
export { server, ALG_PLUGIN_ID }
export const OpencodeAlgPlugin = server

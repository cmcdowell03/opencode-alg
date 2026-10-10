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
import { findLatestIncompleteRunForSession, findLatestIncompleteRunForTurn } from "./store.ts"
import { isAlgWorkerSession } from "./sessions.ts"
import { awaitLock } from "./filesystem-mutex.ts"
import { ContextBudgetOptionsSchema, SessionWindows, type ContextPart } from "./context-budget.ts"
import { configuredAgentModels, configuredModelResolutions } from "./models.ts"
import type { AgentModelMap, ModelResolutionMap } from "./types.ts"
import { appendAlgCompactionContext, formatCompactionContext, MAX_COMPACTION_OUTPUT_BYTES } from "./compaction.ts"
import { formatSdkError } from "./diagnostics.ts"
import { verifiedLiveSourceIdentity } from "./source-identity.ts"
import { parseSkillEvolutionOptions } from "./skill-evolution-schemas.ts"
import { resolvePluginConfiguration } from "./plugin-configuration.ts"
import { captureRuntimeIdentityAtModuleLoad, inspectRuntimeIdentityNow, runtimeIdentityStartupMessage } from "./runtime-identity.ts"
import { createSkillEvolutionRuntime } from "./skill-evolution-runtime.ts"
import { createSkillEvolutionTools } from "./skill-evolution-tools.ts"
import { observedConfigSkillRoots, SkillGuidance } from "./skill-catalog.ts"
import { SessionMemoryRuntime } from "./session-memory/runtime.ts"
import { createMemoryTools } from "./session-memory/tools.ts"
import { canonicalDirectory, isContained } from "./paths.ts"
import { isCompletedUserTurn } from "./turn-boundary.ts"

const runtimeIdentityAtModuleLoad = captureRuntimeIdentityAtModuleLoad()

const server: Plugin = async (ctx, pluginOptions) => {
  const { client, directory } = ctx
  const resolvedConfiguration = resolvePluginConfiguration(pluginOptions)
  const pluginConfiguration = resolvedConfiguration.options
  const skillEvolutionOptions = parseSkillEvolutionOptions(pluginConfiguration)
  const contextBudgetOptions = ContextBudgetOptionsSchema.parse(pluginConfiguration.contextBudget ?? {})
  // What is known about each session's context window between hooks; sizes everything ALG adds.
  const windows = new SessionWindows(contextBudgetOptions)
  const textBytes = (text: string) => Buffer.byteLength(text, "utf8")
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
  const memory = new SessionMemoryRuntime(ctx.worktree || directory, pluginConfiguration.sessionMemory,
    skillEvolutionOptions.skillRoots, extraSkillRoots)
  const environmentMemory = pluginConfiguration.environmentMemory && pluginConfiguration.environmentMemory.mode !== "off"
    ? await (await import("./environment-memory/runtime.ts")).EnvironmentMemoryRuntime.open({
      ...pluginConfiguration.environmentMemory,
      project: pluginConfiguration.environmentMemory.project ?? ctx.project.id,
    })
    : null
  const tools = createAlgTools(ctx, () => structuredClone(configuredModels), () => structuredClone(modelResolutions), { sessionMemory: memory, subagentCards: pluginConfiguration.subagentCards })
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
        if (!disposed) await awaitLock(() => memory.observe(response.data))
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
  const allTools = { ...tools, ...skillEvolutionTools, ...createMemoryTools(memory, authorizeMemory, environmentMemory ?? undefined,
    () => ({ ...inspectRuntimeIdentityNow(runtimeIdentityAtModuleLoad), configuration_source: resolvedConfiguration.source,
      configuration_sidecar_present: resolvedConfiguration.sidecar_present }),
    (owner) => ({ options: contextBudgetOptions, last_plan: windows.last(owner) })) }
  if (JSON.stringify(Object.keys(allTools)) !== JSON.stringify(ALG_TOOL_IDS)) {
    await skillEvolution.dispose()
    environmentMemory?.close()
    throw new Error("ALG server tool registration differs from the exact public tool-ID contract")
  }

  try {
    await client.app.log({
      body: {
        service: ALG_PLUGIN_ID,
        level: "info",
        message: `${algServerStartupMessage(skillEvolutionOptions.enabled)} ${runtimeIdentityStartupMessage(runtimeIdentityAtModuleLoad)} configuration_source=${resolvedConfiguration.source}`,
        extra: { directory, skill_evolution_enabled: skillEvolutionOptions.enabled, configuration_source: resolvedConfiguration.source,
          configuration_sidecar_present: resolvedConfiguration.sidecar_present, deployment_identity_protocol: runtimeIdentityAtModuleLoad.protocol,
          deployment_build: runtimeIdentityAtModuleLoad.build, source_manifest_at_module_load: runtimeIdentityAtModuleLoad.source_manifest_at_module_load },
      },
    })
  } catch {
    /* log optional */
  }

  return {
    tool: allTools,

    dispose: async () => {
      disposed = true
      try { await skillEvolution.dispose() } finally { environmentMemory?.close() }
    },

    event: async ({ event }) => {
      skillEvolution.handleEvent(event)
      if (memory.enabled && event.type === "message.updated" && isCompletedUserTurn(event.properties.info)) {
        try { await captureResults(event.properties.info.sessionID) }
        catch (error) { try { await client.app.log({ body: { service: ALG_PLUGIN_ID, level: "warn", message: `ALG result capture unavailable: ${formatSdkError(error)}` } }) } catch {} }
      }
      if (event.type === "session.deleted") windows.forget(event.properties.info.id)
      if (memory.enabled && event.type === "session.deleted") {
        const info = event.properties.info
        try {
          if (info.projectID === ctx.project.id && isContained(memory.store.project, canonicalDirectory(info.directory))) await awaitLock(() => memory.delete(info.id))
        } catch { /* deletion event failure cannot break the host event stream */ }
      }
    },

    config: async (config) => {
      configuredModels = configuredAgentModels(config)
      modelResolutions = configuredModelResolutions(config)
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      try {
        // The host's own token counts on these messages say how full the window is.
        const session = output.messages.at(-1)?.info.sessionID
        if (session) windows.observeMessages(session, output.messages)
      } catch { /* sizing falls back to the model's limits alone */ }
      try {
        if (memory.enabled && output.messages.length) {
          const owner = output.messages.at(-1)?.info.sessionID
          if (owner) { await authorizeMemory(owner); await awaitLock(() => memory.observe(output.messages)) }
        }
      } catch (error) {
        try { Promise.resolve(client.app.log({ body: { service: ALG_PLUGIN_ID, level: "warn", message: `ALG memory capture unavailable: ${formatSdkError(error)}` } })).catch(() => {}) }
        catch { /* diagnostics must not suppress independent learning capture */ }
      }
      try {
        if (memory.options.mode !== "assist") await awaitLock(() => skillGuidance.observeChatMessages(output.messages))
        await skillEvolution.captureChatMessages(output.messages)
      } catch (error) {
        try {
          Promise.resolve(client.app.log({ body: { service: ALG_PLUGIN_ID, level: "warn", message: `ALG ordinary-turn capture unavailable: ${formatSdkError(error)}` } })).catch(() => {})
        } catch { /* optional logging */ }
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      /** Pushes the text and returns its size, so the plan knows what the part used. */
      const appendRecovery = async (label: string, read: () => string): Promise<number> => {
        try {
          const context = await awaitLock(read)
          if (context) output.system.push(context)
          return textBytes(context)
        } catch {
          output.system.push(`ALG ${label} recovery unavailable; consult authoritative records before resuming.`)
          return 0
        }
      }
      if (input.sessionID) {
        const sessionId = input.sessionID
        const assist = memory.enabled && memory.options.mode === "assist"
        // Everything below is sized from this model's context window and from what is still free in it.
        // Parts that are switched off are left out, so their share goes to the others.
        windows.observeModel(sessionId, input.model?.limit)
        const parts: ContextPart[] = ["run", ...(assist ? ["memory" as const] : skillEvolutionOptions.enabled ? ["skills" as const] : []),
          ...(environmentMemory?.mode === "assist" ? ["environment" as const] : [])]
        const plan = windows.plan(sessionId, "call", parts)
        try {
          const appendEnvironmentMemory = async () => {
            if (environmentMemory?.mode !== "assist") return
            try {
              await authorizeMemory(sessionId)
              const allowance = plan.allow("environment")
              let context: string
              if (allowance === undefined) {
                const remaining = input.model.limit.context - input.model.limit.output - memory.options.toolReserve - 512 -
                  Buffer.byteLength(output.system.join("\n"), "utf8")
                if (!Number.isFinite(remaining) || remaining <= 0) return
                context = environmentMemory.render(sessionId, remaining)
              } else {
                // Some models report an output limit as large as their whole window; reserving all of it
                // would leave no room for anything. Reserve at most half, as the plan does, and count the
                // system text already present in tokens rather than bytes.
                const limit = input.model.limit
                const room = limit.context - Math.min(limit.output, limit.context / 2) - memory.options.toolReserve - 512 -
                  Math.ceil(textBytes(output.system.join("\n")) / contextBudgetOptions.bytesPerToken)
                if (!Number.isFinite(room) || room <= 0) return
                context = environmentMemory.render(sessionId, Math.min(allowance, Math.floor(room * contextBudgetOptions.bytesPerToken)), true)
              }
              if (context) { output.system.push(context); plan.spend("environment", textBytes(context)) }
            }
            catch { output.system.push("Environment memory unavailable; verify current identity, reachability, and permissions before acting.") }
          }
          const recovery: string[] = []
          const collect = async (label: string, read: () => string) => {
            try { const value = await awaitLock(read); if (value) recovery.push(value) }
            catch { recovery.push(`ALG ${label} recovery unavailable; consult authoritative records before resuming.`) }
          }
          // Runs before every model request of every session, so it must not scan the project's run history.
          await collect("run", () => { const run = findLatestIncompleteRunForTurn(ctx.worktree || directory, sessionId, { sessionCreatedHere: isAlgWorkerSession(sessionId) }); return run ? formatCompactionContext(run, plan.allow("run")) : "" })
          await collect("evidence", () => skillEvolution.recoveryContext(sessionId))
          const recoveryBytes = textBytes(recovery.join("\n"))
          plan.spend("run", recoveryBytes)
          if (memory.enabled) {
            try {
              await authorizeMemory(sessionId)
              // The pack carries the recovery text as well; that was planned under "run", so it is added
              // on top of the memory allowance rather than taken out of it.
              const allowance = plan.allow("memory")
              const pack = await awaitLock(() => memory.prepare(sessionId, { context: input.model.limit.context, output: input.model.limit.output,
                existingText: output.system.join("\n"), mandatoryContext: recovery,
                ...(allowance === undefined ? {} : { allowanceBytes: allowance + recoveryBytes + 64 }) }))
              if (pack.text) { output.system.push(pack.text); plan.spend("memory", Math.max(0, textBytes(pack.text) - recoveryBytes)) }
              if (assist && pack.receipt) {
                // A blocked or empty pack does not contain the recovery text; never lose an unfinished run.
                if (pack.blocked || !pack.text) output.system.push(...recovery)
                await appendEnvironmentMemory()
                return
              }
            } catch {
              if (assist) {
                output.system.push(...recovery, "ALG session memory unavailable; use alg_context_status before relying on restored procedures.")
                return
              }
            }
          }
          output.system.push(...recovery)
          if (!assist) plan.spend("skills", await appendRecovery("skill", () => skillGuidance.systemContext(input.sessionID, plan.allow("skills"))))
          await appendEnvironmentMemory()
        } finally {
          windows.record(sessionId, plan)
        }
      }
      if (!input.sessionID && memory.options.mode !== "assist") await appendRecovery("skill", () => skillGuidance.systemContext(input.sessionID))
    },

    "experimental.session.compacting": async (input, output) => {
      const owned: string[] = []
      const logCompactionFailure = (message: string) => {
        try { Promise.resolve(client.app.log({ body: { service: ALG_PLUGIN_ID, level: "error", message } })).catch(() => {}) }
        catch { /* log optional */ }
      }
      const assist = memory.enabled && memory.options.mode === "assist"
      // A compaction prompt carries the whole conversation, so the window is at its fullest here. The
      // plan uses the window last seen for this session; with none known, the fixed limits apply.
      const plan = windows.plan(input.sessionID, "compaction", [
        ...(assist ? ["memory" as const] : ["run" as const, "skills" as const]),
        ...(environmentMemory?.mode === "assist" ? ["environment" as const] : [])])
      const outputLimit = plan.totalBytes ?? MAX_COMPACTION_OUTPUT_BYTES
      const appendEnvironmentMemory = async () => {
        if (environmentMemory?.mode !== "assist") return
        try {
          await authorizeMemory(input.sessionID)
          const remaining = outputLimit - Buffer.byteLength(owned.join("\n"), "utf8") - 1
          const allowance = plan.allow("environment")
          const context = allowance === undefined
            ? environmentMemory.render(input.sessionID, remaining)
            : environmentMemory.render(input.sessionID, Math.min(remaining, allowance), true)
          if (context) { owned.push(context); plan.spend("environment", textBytes(context)) }
        }
        catch { owned.push("Environment memory unavailable; verify current identity, reachability, and permissions before acting.") }
      }
      if (assist) {
        // The learning snapshot is a durable write, not merely another context paragraph.
        try { await skillEvolution.compactSession(input.sessionID) }
        catch (error) { logCompactionFailure(`ALG skill-evolution compaction hook failed: ${formatSdkError(error)}`) }
        try {
          await captureResults(input.sessionID)
          await authorizeMemory(input.sessionID)
          const allowance = plan.allow("memory")
          const pack = await awaitLock(() => memory.prepare(input.sessionID, allowance === undefined ? {} : { allowanceBytes: allowance }))
          if (pack.text) { owned.push(pack.text); plan.spend("memory", textBytes(pack.text)) }
        } catch {
          owned.push("ALG working view unavailable; consult authoritative records before resuming.")
        }
        await appendEnvironmentMemory()
        appendAlgCompactionContext(output.context, owned, outputLimit)
        windows.record(input.sessionID, plan)
        return
      }
      if (memory.enabled) {
        try { await captureResults(input.sessionID); await authorizeMemory(input.sessionID) }
        catch { /* observe/off capture failure stays off the context channel */ }
      }
      try {
        const run = await awaitLock(() => findLatestIncompleteRunForSession(ctx.worktree || directory, input.sessionID))
        if (run) {
          const summary = formatCompactionContext(run, plan.allow("run"))
          owned.push(summary)
          plan.spend("run", textBytes(summary))
        } else plan.spend("run", 0)
      } catch (error) {
        logCompactionFailure(`ALG compaction hook failed: ${formatSdkError(error)}`)
      }
      try {
        const context = await skillEvolution.compactSession(input.sessionID)
        if (context) { owned.push(context); plan.spend("skills", textBytes(context)) }
      } catch (error) {
        logCompactionFailure(`ALG skill-evolution compaction hook failed: ${formatSdkError(error)}`)
      }
      const skills = await awaitLock(() => skillGuidance.compactionContext(input.sessionID, plan.allow("skills")))
      if (skills) { owned.push(skills); plan.spend("skills", textBytes(skills)) }
      await appendEnvironmentMemory()
      appendAlgCompactionContext(output.context, owned, outputLimit)
      windows.record(input.sessionID, plan)
    },
  }
}

export default server
export { server, ALG_PLUGIN_ID }
export const OpencodeAlgPlugin = server

export interface BenchmarkUsageComponent {
  /** Sum of values explicitly reported by OpenCode; missing values are not imputed. */
  reportedTotal: number
  reportedTurns: number
  unknownTurns: number
}

export interface BenchmarkToolStatusMetrics {
  calls: number
  durationMsReported: number
  durationCalls: number
  unknownDurationCalls: number
}

export interface BenchmarkToolMetrics {
  total: number
  completed: number
  error: number
  pending: number
  durationMsReported: number
  durationCalls: number
  unknownDurationCalls: number
  byStatus: Record<"completed" | "error" | "pending", BenchmarkToolStatusMetrics>
}

export interface SessionMetricsSummary {
  /** Bounded attribution rows; unavailable identity fields use explicit nulls. */
  attribution: { rows: Array<{ sessionID: string; requestID: string | null; role: string | null; phase: string | null; providerID: string | null; modelID: string | null; assistantTurns: number; usageComplete: number; usagePartial: number; usageUnknown: number; reportedComponents: Record<string, number> }>; overflowMessages: number }
  sessions: { total: number; roots: number; children: number }
  assistantTurns: {
    total: number
    finished: number
    unfinished: number
    error: number
    modelIdentities: Array<{ providerID: string; modelID: string; turns: number }>
  }
  usage: {
    components: {
      input: BenchmarkUsageComponent
      output: BenchmarkUsageComponent
      reasoning: BenchmarkUsageComponent
      cacheRead: BenchmarkUsageComponent
      cacheWrite: BenchmarkUsageComponent
    }
    totalReportedTokens: number
    turns: { complete: number; partial: number; unknown: number }
    billing: "not_estimated"
    coverage: "observed_session_fields_only"
  }
  cost: { reportedTotal: number; reportedTurns: number; unknownTurns: number; billing: "not_estimated" }
  tools: {
    total: number
    completed: number
    error: number
    pending: number
    byName: Record<string, BenchmarkToolMetrics>
  }
  repeatedExactToolInputs: Record<string, { distinctRepeatedInputs: number; repeatedCalls: number }>
  skillLoads: Record<string, { attempted: number; successful: number; error: number; pending: number }>
  algTools: {
    alg_plan: { total: number; completed: number; error: number; pending: number }
    alg_run: { total: number; completed: number; error: number; pending: number }
  }
  observedErrors: { deniedTool: number; stepExhaustion: number }
}

type SessionRow = { id: string; parentID?: string }
type MessageRow = { sessionID: string; info: any; parts: any[]; benchmarkPhase?: string }

const COMPONENTS = ["input", "output", "reasoning", "cacheRead", "cacheWrite"] as const
type ComponentName = (typeof COMPONENTS)[number]

function finiteNonnegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

function canonical(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null || typeof value !== "object") {
    try { return JSON.stringify(value) } catch { return undefined }
  }
  if (seen.has(value)) return undefined
  seen.add(value)
  let result: string | undefined
  if (Array.isArray(value)) {
    const items = value.map((item) => canonical(item, seen))
    if (items.every((item) => item !== undefined)) result = `[${items.join(",")}]`
  } else {
    const record = value as Record<string, unknown>
    const fields: string[] = []
    for (const key of Object.keys(record).sort()) {
      const encodedKey = JSON.stringify(key)
      const encodedValue = canonical(record[key], seen)
      if (encodedValue === undefined) return undefined
      fields.push(`${encodedKey}:${encodedValue}`)
    }
    result = `{${fields.join(",")}}`
  }
  seen.delete(value)
  return result
}

function toolStatus(part: any): "completed" | "error" | "pending" {
  const status = part?.state?.status
  if (status === "completed" || status === "success") return "completed"
  if (status === "error") return "error"
  return "pending"
}

function durationMs(part: any): number | undefined {
  const state = part?.state
  const direct = finiteNonnegative(state?.time?.duration ?? state?.duration)
  if (direct !== undefined) return direct
  const start = finiteNonnegative(state?.time?.start)
  const end = finiteNonnegative(state?.time?.end)
  return start !== undefined && end !== undefined && end >= start ? end - start : undefined
}

function fixedErrorSignals(error: unknown): { denied: boolean; exhausted: boolean } {
  const strings: string[] = []
  const visit = (value: unknown, depth: number): void => {
    if (depth > 5 || strings.length > 128) return
    if (typeof value === "string") { strings.push(value); return }
    if (!value || typeof value !== "object") return
    const record = value as Record<string, unknown>
    for (const key of ["name", "code", "message", "type"]) {
      const field = record[key]
      if (typeof field === "string") strings.push(field)
      else if (field && typeof field === "object") visit(field, depth + 1)
    }
  }
  visit(error, 0)
  const text = strings.join("\n").toLowerCase()
  return {
    denied: strings.some((value) => ["ToolDeniedError", "PermissionDeniedError", "tool_denied", "permission_denied"].includes(value)) ||
      /\btool execution denied\b/i.test(text),
    exhausted: strings.some((value) => ["StepLimitError", "max_steps_reached", "step_limit_exceeded"].includes(value)) ||
      /\b(maximum|max) number of steps reached\b/i.test(text),
  }
}

function makeToolMetrics(): BenchmarkToolMetrics {
  const status = (): BenchmarkToolStatusMetrics => ({ calls: 0, durationMsReported: 0, durationCalls: 0, unknownDurationCalls: 0 })
  return {
    total: 0, completed: 0, error: 0, pending: 0, durationMsReported: 0, durationCalls: 0, unknownDurationCalls: 0,
    byStatus: { completed: status(), error: status(), pending: status() },
  }
}

/** Summarize only reported session/message telemetry; this function makes no API calls. */
export function summarizeSessionMetrics(
  sessions: Array<{ id: string; parentID?: string }>,
  messages: Array<{ sessionID: string; info: any; parts: any[] }>,
  options: { phaseBySession?: Readonly<Record<string, string>>; maxAttributionRows?: number } = {},
): SessionMetricsSummary {
  const uniqueSessions = new Map<string, SessionRow>()
  for (const session of sessions) if (typeof session?.id === "string" && session.id) uniqueSessions.set(session.id, session)

  // Poll results may contain earlier versions of a message. Keep the latest row for each stable identity.
  const latestMessages = new Map<string, MessageRow>()
  for (const message of messages) {
    const id = message?.info?.id
    if (typeof message?.sessionID !== "string" || !message.sessionID || (typeof id !== "string" && typeof id !== "number")) continue
    latestMessages.set(JSON.stringify([message.sessionID, id]), message)
  }

  const components = Object.fromEntries(COMPONENTS.map((name) => [name, { reportedTotal: 0, reportedTurns: 0, unknownTurns: 0 }])) as
    Record<ComponentName, BenchmarkUsageComponent>
  const modelIdentities = new Map<string, { providerID: string; modelID: string; turns: number }>()
  const toolsByName: Record<string, BenchmarkToolMetrics> = Object.create(null) as Record<string, BenchmarkToolMetrics>
  const inputCounts = new Map<string, Map<string, number>>()
  const skillLoads: SessionMetricsSummary["skillLoads"] = Object.create(null) as SessionMetricsSummary["skillLoads"]
  const algTools: SessionMetricsSummary["algTools"] = {
    alg_plan: { total: 0, completed: 0, error: 0, pending: 0 },
    alg_run: { total: 0, completed: 0, error: 0, pending: 0 },
  }
  let assistantTotal = 0, finished = 0, unfinished = 0, assistantErrors = 0
  let completeUsageTurns = 0, partialUsageTurns = 0, unknownUsageTurns = 0
  let reportedCost = 0, reportedCostTurns = 0, unknownCostTurns = 0
  let toolTotal = 0, toolCompleted = 0, toolError = 0, toolPending = 0
  let deniedTool = 0, stepExhaustion = 0
  const attribution = new Map<string, SessionMetricsSummary["attribution"]["rows"][number]>()
  let attributionOverflow = 0

  for (const message of latestMessages.values()) {
    const info = message.info ?? {}
    const isAssistant = info.role === "assistant"
    if (isAssistant) {
      assistantTotal++
      const isError = info.error !== undefined && info.error !== null || info.status === "error"
      const isFinished = info.time?.completed !== undefined && info.time?.completed !== null
      if (isError) assistantErrors++
      else if (isFinished) finished++
      else unfinished++

      const providerID = typeof info.providerID === "string" ? info.providerID :
        typeof info.model?.providerID === "string" ? info.model.providerID : undefined
      const modelID = typeof info.modelID === "string" ? info.modelID :
        typeof info.model?.modelID === "string" ? info.model.modelID : undefined
      if (providerID && modelID) {
        const key = JSON.stringify([providerID, modelID])
        const entry = modelIdentities.get(key) ?? { providerID, modelID, turns: 0 }
        entry.turns++
        modelIdentities.set(key, entry)
      }

      const tokenInfo = info.tokens
      let knownComponents = 0
      const reportedValues: Partial<Record<ComponentName, number>> = {
        input: finiteNonnegative(tokenInfo?.input),
        output: finiteNonnegative(tokenInfo?.output),
        reasoning: finiteNonnegative(tokenInfo?.reasoning),
        cacheRead: finiteNonnegative(tokenInfo?.cache?.read),
        cacheWrite: finiteNonnegative(tokenInfo?.cache?.write),
      }
      for (const name of COMPONENTS) {
        const value = reportedValues[name]
        if (value === undefined) components[name].unknownTurns++
        else {
          components[name].reportedTotal += value
          components[name].reportedTurns++
          knownComponents++
        }
      }
      const safe = (value: unknown) => typeof value === "string" && value.length > 0 ? value.slice(0, 128) : null
      const sessionID = message.sessionID.slice(0, 128), requestID = safe(info.parentID), role = safe(info.agent) ?? safe(info.role), phase = safe(message.benchmarkPhase) ?? safe(options.phaseBySession?.[message.sessionID])
      const key = JSON.stringify([sessionID, requestID, role, phase, safe(providerID), safe(modelID)])
      let row = attribution.get(key)
      if (!row && attribution.size < (options.maxAttributionRows ?? 2048)) {
        row = { sessionID, requestID, role, phase, providerID: safe(providerID), modelID: safe(modelID), assistantTurns: 0, usageComplete: 0, usagePartial: 0, usageUnknown: 0, reportedComponents: Object.fromEntries(COMPONENTS.map(name => [name, 0])) }
        attribution.set(key, row)
      }
      if (!row) attributionOverflow++
      else {
        row.assistantTurns++
        if (knownComponents === COMPONENTS.length) row.usageComplete++
        else if (knownComponents === 0) row.usageUnknown++
        else row.usagePartial++
        for (const name of COMPONENTS) row.reportedComponents[name] = (row.reportedComponents[name] ?? 0) + (reportedValues[name] ?? 0)
      }
      if (knownComponents === COMPONENTS.length) completeUsageTurns++
      else if (knownComponents === 0) unknownUsageTurns++
      else partialUsageTurns++

      const cost = finiteNonnegative(info.cost)
      if (cost === undefined) unknownCostTurns++
      else { reportedCost += cost; reportedCostTurns++ }

      const signals = fixedErrorSignals(info.error)
      if (signals.denied) deniedTool++
      if (signals.exhausted) stepExhaustion++
    }

    for (const part of Array.isArray(message.parts) ? message.parts : []) {
      if (part?.type !== "tool") continue
      const nameValue = typeof part.tool === "string" ? part.tool : typeof part.name === "string" ? part.name : undefined
      if (!nameValue) continue
      const name = nameValue
      const status = toolStatus(part)
      const metrics = toolsByName[name] ?? (toolsByName[name] = makeToolMetrics())
      const statusMetrics = metrics.byStatus[status]
      metrics.total++
      metrics[status]++
      statusMetrics.calls++
      toolTotal++
      if (status === "completed") toolCompleted++
      else if (status === "error") toolError++
      else toolPending++

      const duration = durationMs(part)
      if (duration === undefined) {
        metrics.unknownDurationCalls++
        statusMetrics.unknownDurationCalls++
      } else {
        metrics.durationMsReported += duration
        metrics.durationCalls++
        statusMetrics.durationMsReported += duration
        statusMetrics.durationCalls++
      }

      const input = part.state?.input ?? part.input
      const encoded = canonical(input)
      if (encoded !== undefined) {
        const counts = inputCounts.get(name) ?? new Map<string, number>()
        counts.set(encoded, (counts.get(encoded) ?? 0) + 1)
        inputCounts.set(name, counts)
      }
      if (name === "skill") {
        const skillName = typeof input?.name === "string" ? input.name : undefined
        if (skillName) {
          const load = skillLoads[skillName] ?? (skillLoads[skillName] = { attempted: 0, successful: 0, error: 0, pending: 0 })
          load.attempted++
          if (status === "completed") load.successful++
          else if (status === "error") load.error++
          else load.pending++
        }
      }
      if (name === "alg_plan" || name === "alg_run") {
        const count = algTools[name as keyof SessionMetricsSummary["algTools"]]
        count.total++
        count[status]++
      }
      if (status === "error") {
        const errorSignals = fixedErrorSignals(part.state?.error)
        if (errorSignals.denied) deniedTool++
        if (errorSignals.exhausted) stepExhaustion++
      }
    }
  }

  const repeatedExactToolInputs: SessionMetricsSummary["repeatedExactToolInputs"] = Object.create(null) as
    SessionMetricsSummary["repeatedExactToolInputs"]
  for (const [name, counts] of inputCounts) {
    let distinctRepeatedInputs = 0, repeatedCalls = 0
    for (const count of counts.values()) if (count > 1) { distinctRepeatedInputs++; repeatedCalls += count - 1 }
    if (distinctRepeatedInputs) repeatedExactToolInputs[name] = { distinctRepeatedInputs, repeatedCalls }
  }

  const componentTotal = COMPONENTS.reduce((sum, name) => sum + components[name].reportedTotal, 0)
  const roots = [...uniqueSessions.values()].filter((session) => !session.parentID).length
  return {
    attribution: { rows: [...attribution.values()], overflowMessages: attributionOverflow },
    sessions: { total: uniqueSessions.size, roots, children: uniqueSessions.size - roots },
    assistantTurns: {
      total: assistantTotal, finished, unfinished, error: assistantErrors,
      modelIdentities: [...modelIdentities.values()].sort((a, b) => a.providerID.localeCompare(b.providerID) || a.modelID.localeCompare(b.modelID)),
    },
    usage: {
      components,
      totalReportedTokens: componentTotal,
      turns: { complete: completeUsageTurns, partial: partialUsageTurns, unknown: unknownUsageTurns },
      billing: "not_estimated",
      coverage: "observed_session_fields_only",
    },
    cost: { reportedTotal: reportedCost, reportedTurns: reportedCostTurns, unknownTurns: unknownCostTurns, billing: "not_estimated" },
    tools: { total: toolTotal, completed: toolCompleted, error: toolError, pending: toolPending, byName: toolsByName },
    repeatedExactToolInputs,
    skillLoads,
    algTools,
    observedErrors: { deniedTool, stepExhaustion },
  }
}

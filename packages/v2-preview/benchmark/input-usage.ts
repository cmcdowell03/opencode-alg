import type { RequestObservation } from "./compaction.ts"
import { wireTextParts } from "./skill-delivery.ts"
import type { Message } from "./transport.ts"
import type { collectSessionEvidence } from "./session-evidence.ts"

type Sample = Pick<RequestObservation, "kind" | "role" | "phase" | "requestBytes" | "status"> & {
  usage?: { input: number; output: number; total: number } | null
}

export function investigationSchema(tools: unknown) {
  if (!Array.isArray(tools)) return null
  for (const entry of tools) {
    const tool = entry?.function ?? entry
    if (tool?.name !== "alg_investigation") continue
    const actions = tool.parameters?.properties?.action?.enum
    if (!Array.isArray(actions) || actions.length > 32 ||
        !actions.every(action => typeof action === "string" && /^[a-z_]{1,32}$/.test(action))) return null
    return { bytes: Buffer.byteLength(JSON.stringify(tool.parameters)), offersResult: actions.includes("result"),
      offersDispatch: actions.includes("dispatch"), actions: actions as string[] }
  }
  return null
}

/** Count the exact user-role calculation payload seen on the wire, without logging source rows. */
export function calculatedFieldCount(messages: Message[]) {
  const marker = "ALG calculated evidence (source data)\n"
  for (const message of messages) {
    if (message.role !== "user") continue
    for (const part of wireTextParts(message.content)) {
      if (!part.startsWith(marker)) continue
      try {
        const values: unknown = JSON.parse(part.slice(marker.length)).values
        if (values && typeof values === "object" && !Array.isArray(values)) {
          const fields = Object.values(values)
          if (fields.length && fields.every(Number.isFinite)) return fields.length
        }
      } catch { /* A prose mention is insufficient. */ }
    }
  }
  return 0
}

function sumComplete(values: (number | null | undefined)[]) {
  let sum = 0
  for (const value of values) {
    if (value == null || !Number.isSafeInteger(value) || value < 0) return null
    sum += value
  }
  return values.length ? sum : null
}

/** Byte totals cover the whole serialized request. Only real provider usage supplies token counts. */
export function inputUsage(requests: readonly Sample[], live: boolean,
  evidence: Awaited<ReturnType<typeof collectSessionEvidence>> | null) {
  function totals(rows: readonly Sample[]) {
    const complete = live && rows.length > 0 && rows.every(row => row.status === 200 && row.usage &&
      row.usage.total === row.usage.input + row.usage.output)
    return { requests: rows.length, requestBytes: sumComplete(rows.map(row => row.requestBytes)),
      inputTokens: complete ? sumComplete(rows.map(row => row.usage?.input)) : null,
      outputTokens: complete ? sumComplete(rows.map(row => row.usage?.output)) : null }
  }
  const groups = new Map<string, Sample[]>()
  for (const row of requests) {
    const stage = row.role + "/" + (row.kind === "summary" ? "summary" : row.phase ?? "unknown")
    const group = groups.get(stage)
    if (group) group.push(row)
    else groups.set(stage, [row])
  }
  const result = totals(requests)
  const steps = Object.values(evidence?.sessions ?? {}).flatMap(session => session?.steps ?? [])
  const matched = result.inputTokens !== null && result.outputTokens !== null && steps.length === requests.length &&
    evidence?.completeRecordedTokens === result.inputTokens + result.outputTokens
  const cached = matched ? sumComplete(steps.map(step => step.cacheRead)) : null
  return { ...result, cachedInputTokens: cached !== null && cached <= result.inputTokens! ? cached : null,
    byStage: Object.fromEntries([...groups].map(([stage, group]) => [stage, totals(group)])) }
}

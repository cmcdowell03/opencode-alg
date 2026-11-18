import type { SessionMessageInfo } from "@opencode/client"
import { transcript } from "../acceptance/host.ts"

type Role = "root" | "checker"

/** Collect host-persisted steps. Raw prompts, answers, errors and provider response bodies stay in the host. */
export function summarizeSession(rows: readonly SessionMessageInfo[]) {
  const steps = rows.flatMap(row => {
    if (row.type !== "assistant" && row.type !== "compaction") return []
    const recorded = "tokens" in row ? row.tokens : undefined
    const counts = recorded && [recorded.input, recorded.output, recorded.reasoning, recorded.cache.read, recorded.cache.write]
    const total = counts?.every(n => Number.isSafeInteger(n) && n >= 0) ? counts.reduce((a, b) => a + b, 0) : null
    const completed = row.type === "assistant" ? !!row.time.completed : row.status === "completed"
    const status = row.type === "assistant" ? row.finish ?? "unfinished" : row.status
    return [{ id: row.id, kind: row.type, status, completed,
      model: "model" in row && row.model ? { provider: row.model.providerID, id: row.model.id } : null,
      reason: row.type === "compaction" ? row.reason : null,
      httpStatus: "error" in row ? row.error?.status ?? null : null,
      tokens: total !== null && total > 0 ? total : null,
      cacheRead: total !== null && total > 0 ? recorded!.cache.read : null,
      cacheWrite: total !== null && total > 0 ? recorded!.cache.write : null,
      hostCost: "cost" in row && row.cost !== undefined ? row.cost : null }]
  })
  const idle = [...rows].reverse().find(row => row.type === "idle")
  const counted = steps.filter(s => s.tokens !== null)
  const reported = counted.reduce((n, s) => n + s.tokens!, 0)
  return { steps, idle: idle?.type === "idle" ? idle.outcome : null, observedTokens: counted.length ? reported : null,
    complete: !!steps.length && counted.length === steps.length && steps.every(s => s.completed) &&
      rows.at(-1)?.type === "idle" }
}

export async function collectSessionEvidence(client: Parameters<typeof transcript>[0], root: string, checker?: string) {
  const sessions: Partial<Record<Role, ReturnType<typeof summarizeSession> | null>> = {}
  const ids: [Role, string][] = [["root", root]]
  if (checker) ids.push(["checker", checker])
  await Promise.all(ids.map(async ([role, id]) => {
    try { sessions[role] = summarizeSession(await transcript(client, id)) }
    catch { sessions[role] = null }
  }))
  const readings = Object.values(sessions)
  const total = readings.every(s => s?.complete) ? readings.reduce((n, s) => n + s!.observedTokens!, 0) : null
  return { sessions, completeRecordedTokens: total }
}

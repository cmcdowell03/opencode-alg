import { createHash } from "node:crypto"

export const DEFAULT_TRACK_ARMS = ["build", "alg_default"] as const
export const TARGETED_COMPATIBILITY_ARMS = ["build", "alg_targeted"] as const
export type BenchmarkArm = typeof DEFAULT_TRACK_ARMS[number] | "alg_targeted"
export type BenchmarkTrack = "default" | "targeted_compatibility"

export interface PairIssue {
  pairId: string
  caseId: string
  track: BenchmarkTrack
  issuedAt: string
  arms: Array<{ arm: BenchmarkArm; status: "issued_not_started" | "running" | "completed" | "stopped" }>
}

export function issuePairs(cases: readonly { id: string }[], track: BenchmarkTrack, now = new Date()): PairIssue[] {
  const arms: readonly BenchmarkArm[] = track === "default" ? DEFAULT_TRACK_ARMS : TARGETED_COMPATIBILITY_ARMS
  return cases.map(({ id }, index) => ({
    pairId: `pair-${String(index + 1).padStart(4, "0")}-${createHash("sha256").update(`${track}:${id}`).digest("hex").slice(0, 12)}`,
    caseId: id, track, issuedAt: now.toISOString(), arms: arms.map(arm => ({ arm, status: "issued_not_started" })),
  }))
}

/** Plan and execute from the same selected-case/arm bindings, including subset runs. */
export function scheduleIssuedPairs<T extends { id: string }>(cases: readonly T[], track: BenchmarkTrack) {
  return issuePairs(cases, track).map((pair, index) => {
    const order = pair.arms.map(row => row.arm)
    return { fixture: cases[index]!, pair, index, order: index % 2 ? order.reverse() : order }
  })
}

/** Preflight plans do not issue live trials. Every live issue remains in the denominator. */
export function summarizeIssuedArms(rows: readonly { status: string }[], mode: "trial" | "preflight" = "trial") {
  const cutoff = "stopped_before_start_suite_deadline"
  if (mode === "preflight") {
    const passed = rows.filter(row => row.status === "preflight_passed").length
    const failed = rows.filter(row => row.status === "preflight_failed").length
    const stopped = rows.filter(row => row.status === cutoff).length
    return { issued: 0, unissued: rows.length, completed: 0, stopped: 0, primaryDenominator: 0,
      complete: passed + failed + stopped === rows.length, preflight: { planned: rows.length, passed, failed, stopped } }
  }
  const completed = rows.filter(row => row.status === "completed").length
  const stopped = rows.filter(row => row.status === "stopped" || row.status === cutoff).length
  return { issued: rows.length, unissued: 0, completed, stopped, primaryDenominator: rows.length,
    complete: completed + stopped === rows.length }
}

type HostMessage = { info?: any; id?: unknown; sessionID?: unknown; parts?: any[] }
export const messageIdentity = (value: HostMessage) => typeof value?.info?.id === "string" && value.info.id ? value.info.id : undefined
export const messageSession = (value: HostMessage) => typeof value?.info?.sessionID === "string" && value.info.sessionID
  ? value.info.sessionID : typeof value?.sessionID === "string" && value.sessionID ? value.sessionID : undefined
export function hostTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value < 1_000_000_000_000 ? value * 1000 : value
  if (typeof value === "string") { const parsed = Date.parse(value); if (Number.isFinite(parsed) && parsed >= 0) return parsed }
  return undefined
}
function assistantCompleted(message: HostMessage): number | undefined {
  const info = message.info
  if (!messageIdentity(message) || info?.role !== "assistant" || (info.error !== undefined && info.error !== null) ||
    info.status === "error" || message.parts?.some(part => part?.type === "tool" && ["pending", "running"].includes(part?.state?.status))) return undefined
  return hostTimestamp(info.time?.completed)
}

/** Observe marker/summary links independently of workflow recovery or request acceptance. */
export function observeCompactionMarkers(messages: readonly HostMessage[]) {
  const latest = new Map<string, HostMessage>()
  for (const message of messages) {
    const id = messageIdentity(message), sessionId = messageSession(message)
    if (id && sessionId) latest.set(JSON.stringify([sessionId, id]), message)
  }
  const summaries = new Map<string, Array<{ id: string; completedAt: number }>>()
  for (const message of latest.values()) {
    const completedAt = assistantCompleted(message)
    if (message.info?.summary !== true || completedAt === undefined || typeof message.info.parentID !== "string") continue
    const key = JSON.stringify([messageSession(message), message.info.parentID])
    const matches = summaries.get(key) ?? []
    matches.push({ id: messageIdentity(message)!, completedAt })
    summaries.set(key, matches)
  }
  return [...latest.entries()].flatMap(([key, message]) => {
    const part = message.parts?.find(item => item?.type === "compaction")
    if (!part) return []
    const id = messageIdentity(message)!, sessionId = messageSession(message)!
    const createdAt = hostTimestamp(message.info?.time?.created ?? message.info?.time?.start ?? message.info?.createdAt)
    const summary = createdAt === undefined ? undefined : summaries.get(key)
      ?.filter(item => item.id !== id && item.completedAt >= createdAt)
      .sort((a, b) => a.completedAt - b.completedAt).at(-1)
    return [{ id, sessionId, createdAt, auto: typeof part.auto === "boolean" ? part.auto as boolean : undefined, summary }]
  })
}

type Continuation = { status: string; userMessageID?: string; assistantID?: string; scorePassed?: boolean }
export function compactionReceipt(input: {
  requestId: string
  requestedAt: string
  rootSessionId: string
  response: unknown
  beforeMessages: readonly HostMessage[]
  afterMessages: readonly HostMessage[]
  continuationMessages?: readonly HostMessage[]
  continuation: Continuation
}) {
  const before = new Set(input.beforeMessages.filter(message => messageSession(message) === input.rootSessionId).map(messageIdentity))
  const requestedMs = hostTimestamp(input.requestedAt)
  const candidates = observeCompactionMarkers(input.afterMessages).filter(marker => marker.sessionId === input.rootSessionId && !before.has(marker.id))
  const matching = candidates.filter(marker => marker.auto === false && requestedMs !== undefined &&
    marker.createdAt !== undefined && marker.createdAt >= requestedMs)
  const matched = matching.length === 1 ? matching[0] : undefined
  const diagnostic = matched ?? candidates[0]
  const summary = matched?.summary && !before.has(matched.summary.id) ? matched.summary : undefined
  const acceptance = input.response === true ? "accepted" : input.response === false ? "rejected" : "unknown"
  const rootContinuation = (input.continuationMessages ?? []).filter(message => messageSession(message) === input.rootSessionId)
  const user = input.continuation.userMessageID ? rootContinuation.find(message => messageIdentity(message) === input.continuation.userMessageID) : undefined
  const assistant = input.continuation.assistantID ? rootContinuation.find(message => messageIdentity(message) === input.continuation.assistantID) : undefined
  const userAt = hostTimestamp(user?.info?.time?.created)
  const assistantAt = assistant ? assistantCompleted(assistant) : undefined
  const continuationLinked = !!summary && input.continuation.status === "completed" && input.continuation.scorePassed === true &&
    user?.info?.role === "user" && !user.parts?.some(part => part?.type === "compaction") &&
    assistant?.info?.parentID === input.continuation.userMessageID && assistant?.info?.summary !== true &&
    userAt !== undefined && userAt >= summary.completedAt && assistantAt !== undefined && assistantAt >= userAt
  const creationTime = requestedMs === undefined ? "request_time_unverifiable" : diagnostic?.createdAt === undefined ? "timestamp_unavailable"
    : diagnostic.createdAt >= requestedMs ? "created_after_request" : "predates_request"
  return {
    request: { id: input.requestId, requestedAt: input.requestedAt, rootSessionId: input.rootSessionId },
    requestAcceptance: acceptance,
    marker: { id: diagnostic?.id ?? null, sessionId: diagnostic?.sessionId ?? null, matchesRequest: !!matched && acceptance !== "rejected",
      outcome: summary ? "new_and_persisted" : matching.length > 1 ? "ambiguous" : creationTime === "predates_request" ? "predates_request" :
        diagnostic ? "new_but_unlinked" : "missing_or_historical_only", creationTime },
    summary: { id: summary?.id ?? null, parentID: summary ? matched!.id : null,
      outcome: summary ? "terminal_linked" : candidates.length ? "missing_errored_or_unlinked" : "missing" },
    continuation: { ...input.continuation, linked: continuationLinked },
    qualified: acceptance === "accepted" && continuationLinked,
  }
}

/** Runner integration should consume the receipt verdict, never private marker labels. */
export function compactionIsQualified(receipt: unknown): boolean {
  return !!receipt && typeof receipt === "object" && (receipt as { qualified?: unknown }).qualified === true
}

export interface CensusState {
  elapsedMs: number
  rounds: number
  stableQuiescentRounds: number
  quiescent: boolean
  activeSessions: number | null
  pendingWork: boolean | null
  /** Provider request inventory is not exposed by the host API. */
  inFlightRequests: number | null
  assistantTurns: number | null
  usage: { completeTurns: number | null; partialTurns: number | null; unknownTurns: number | null; reportedComponents: number | null }
  outcome: "quiescent" | "grace_expired" | "census_error"
  error?: string
}

/** Bounded final polling. Missing usage and unresolved work stay explicitly unknown. */
export async function finalCensus(options: {
  census: () => Promise<{ metrics: any; activeSessions: number | null; pendingWork: boolean | null; quiescent: boolean }>
  graceMs?: number
  pollMs?: number
  now?: () => number
  pause?: (ms: number) => Promise<void>
}): Promise<CensusState> {
  const now = options.now ?? Date.now, pause = options.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
  const start = now(), deadline = start + (options.graceMs ?? 5_000), poll = options.pollMs ?? 100
  let rounds = 0, stableQuiescentRounds = 0, previousCensus = "", last: Awaited<ReturnType<typeof options.census>> | undefined
  let error: string | undefined
  while (now() <= deadline) {
    rounds++
    try {
      const remaining = Math.max(0, deadline - now())
      let timer: ReturnType<typeof setTimeout> | undefined
      last = await Promise.race([
        options.census(),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("final census grace expired")), remaining) }),
      ]).finally(() => { if (timer) clearTimeout(timer) })
      error = undefined
      const census = JSON.stringify([last.metrics?.sessions ?? null, last.metrics?.assistantTurns ?? null,
        last.metrics?.tools?.total ?? null, last.metrics?.usage ?? null, last.metrics?.cost ?? null])
      if (last.quiescent && last.activeSessions === 0 && last.pendingWork === false) {
        stableQuiescentRounds = census === previousCensus ? stableQuiescentRounds + 1 : 1
        previousCensus = census
        if (stableQuiescentRounds >= 2) break
      } else { stableQuiescentRounds = 0; previousCensus = "" }
    } catch (caught) {
      stableQuiescentRounds = 0
      previousCensus = ""
      error = caught instanceof Error && caught.message === "final census grace expired" ? "final_census_grace_expired" : "final_census_poll_failed"
      if (error === "final_census_grace_expired") break
    }
    if (now() >= deadline) break
    await pause(Math.min(poll, deadline - now()))
  }
  const metrics = last?.metrics
  const quiescent = stableQuiescentRounds >= 2 && !error
  return {
    elapsedMs: Math.max(0, now() - start), rounds, stableQuiescentRounds, quiescent, activeSessions: last?.activeSessions ?? null,
    pendingWork: last?.pendingWork ?? null, inFlightRequests: null,
    assistantTurns: metrics?.assistantTurns?.total ?? null,
    usage: {
      completeTurns: metrics?.usage?.turns?.complete ?? null,
      partialTurns: metrics?.usage?.turns?.partial ?? null,
      unknownTurns: metrics?.usage?.turns?.unknown ?? null,
      reportedComponents: metrics?.usage?.components ? Object.values(metrics.usage.components).reduce((sum: number, row: any) => sum + (row?.reportedTurns ?? 0), 0) : null,
    },
    outcome: error ? "census_error" : quiescent ? "quiescent" : "grace_expired",
    ...(error ? { error } : {}),
  }
}

export function eligibility(input: {
  artifactPassed: boolean
  workflowComplete: boolean
  sourceIntegrity: boolean
  configIntegrity: boolean
  cleanup: boolean
  censusQuiescent: boolean
  isolationQualified: boolean
}): { artifactOutcome: "passed" | "failed"; workflowEligible: boolean; operationalEligible: boolean; comparisonEligible: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (!input.workflowComplete) reasons.push("workflow_incomplete")
  if (!input.sourceIntegrity) reasons.push("source_integrity_failed")
  if (!input.configIntegrity) reasons.push("config_integrity_failed")
  if (!input.cleanup) reasons.push("cleanup_failed")
  if (!input.censusQuiescent) reasons.push("final_census_unresolved")
  if (!input.isolationQualified) reasons.push("service_isolation_unqualified")
  return {
    artifactOutcome: input.artifactPassed ? "passed" : "failed",
    workflowEligible: input.workflowComplete,
    operationalEligible: reasons.length === 0,
    comparisonEligible: reasons.length === 0 && input.artifactPassed,
    reasons,
  }
}

import { sha256 } from "../acceptance/runtime.ts"
import type { SessionMessageInfo } from "@opencode/client"

export const summaryHash = (text: string) => sha256(text.replace(/\s+/g, " ").trim())

export type RequestObservation = {
  id: number
  kind: "summary" | "ordinary"
  role: "root" | "checker" | "other"
  phase: string | null
  startedAtMs: number
  finishedAtMs: number | null
  stale: boolean
  oldSummary: boolean
  correction: boolean
  skill: boolean
  tools: string[]
  /** Actual UTF-8 HTTP request body length. Scripted usage fields do not measure input tokens. */
  requestBytes?: number
  investigationSchema?: { bytes: number; offersResult: boolean; offersDispatch: boolean } | null
  status: number | null
  scriptOutcome?: string
  summaryResponseSha256?: string | null
  summaryReturnsStale?: boolean
}

export type CompactionWitness = {
  before: string[]
  summary?: RequestObservation
  correctedAtMs?: number
  whileHeld?: RequestObservation
  concurrentAnswerId?: string
  concurrentAnswerAtMs?: number
  applied?: Extract<SessionMessageInfo, { type: "compaction"; status: "completed" }>
  appliedAtMs?: number
  next?: RequestObservation
  answerId?: string
}

/** Require an ordinary root response while the prior summary request is still held.
 * A parallel child or an automatic completion row alone can also occur with foreground compaction.
 */
export function assessCompaction(w: CompactionWitness) {
  const { summary, whileHeld, correctedAtMs, applied, appliedAtMs, next, answerId } = w
  const checks = {
    oldInputInFlight: summary?.kind === "summary" && summary.role === "root" && summary.stale && !summary.correction,
    rootProgressWhileSummaryInFlight: !!summary && !!whileHeld && !!w.concurrentAnswerId &&
      w.concurrentAnswerAtMs !== undefined && w.concurrentAnswerAtMs > summary.startedAtMs &&
      (summary.finishedAtMs === null || w.concurrentAnswerAtMs < summary.finishedAtMs) && whileHeld.kind === "ordinary" &&
      whileHeld.role === "root" && whileHeld.status === 200 && whileHeld.finishedAtMs !== null &&
      whileHeld.finishedAtMs > summary.startedAtMs &&
      (summary.finishedAtMs === null || whileHeld.finishedAtMs < summary.finishedAtMs),
    correctionDurableBeforeSummaryResponse: !!summary && correctedAtMs !== undefined &&
      correctedAtMs > summary.startedAtMs && summary.finishedAtMs !== null && correctedAtMs < summary.finishedAtMs,
    newAutomaticCompactionApplied: !!applied && applied.reason === "auto" && !w.before.includes(applied.id) &&
      appliedAtMs !== undefined && summary?.finishedAtMs !== null && summary?.finishedAtMs !== undefined &&
      summary.finishedAtMs <= appliedAtMs && summary.summaryResponseSha256 === summaryHash(applied.summary),
    oldSummaryDeliveredWithCorrection: !!next && next.kind === "ordinary" && next.role === "root" &&
      next.oldSummary && next.correction && !!applied && !!summary &&
      summary.finishedAtMs !== null && summary.finishedAtMs <= next.startedAtMs,
    nextActualAnswer: !!answerId && next?.status === 200 && next.finishedAtMs !== null,
  }
  return {
    status: Object.values(checks).every(Boolean) ? "OBSERVED" as const : "NOT_OBSERVED" as const,
    checks, oldRequest: summary?.id ?? null, correctionAtMs: correctedAtMs ?? null,
    concurrentAnswerId: w.concurrentAnswerId ?? null, concurrentRootRequest: whileHeld?.id ?? null, compactionId: applied?.id ?? null,
    appliedAtMs: appliedAtMs ?? null, answerRequest: next?.id ?? null, answerId: answerId ?? null,
  }
}

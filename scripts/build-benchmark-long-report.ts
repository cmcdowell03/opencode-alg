import { measureRetentionBoundaries } from "./build-benchmark-retention-boundaries.ts"
import type { LongSessionEvidence } from "./build-benchmark-long-session.ts"

type Row = { caseId: string; arm: string; scored_task_success?: boolean; status: string; wall_ms?: number | null;
  live_obligations?: LongSessionEvidence | null }
/** Common eligibility is fixed by pre-state and truth epoch, never by post-outcome. */
export function summarizeLongSessionCohort(rows: readonly Row[]) {
  const arms = ["build", "alg_default"] as const
  const observations = rows.flatMap(row => {
    if (!row.live_obligations) return []
    const result = measureRetentionBoundaries(row.live_obligations.retention)
    if (result.status !== "measured") return []
    return result.boundaries.flatMap((boundary, index) => boundary.behavioralRegression?.obligations.map(o => ({
      caseId: row.caseId, arm: row.arm, key: `${row.caseId}:${index}:${o.obligationId}:${o.truthDigest}`,
      transition: row.live_obligations!.retention.boundaries[index]!.transition,
      ...o,
    })) ?? [])
  })
  const counts = (selected: typeof observations) => {
    const preCorrect = selected.filter(o => o.pre.state === "correct")
    const regressions = preCorrect.filter(o => o.post.state === "incorrect").length
    const retained = preCorrect.filter(o => o.post.state === "correct").length
    const unknown = preCorrect.length - regressions - retained
    return { obligations: selected.length, preCorrect: preCorrect.length,
      preIncorrect: selected.filter(o => o.pre.state === "incorrect").length,
      preUnknown: selected.filter(o => o.pre.state === "unknown").length,
      regressions, retained, unknown, rate: regressions + retained ? regressions / (regressions + retained) : null,
      lowerBound: preCorrect.length ? regressions / preCorrect.length : null,
      upperBound: preCorrect.length ? (regressions + unknown) / preCorrect.length : null }
  }
  const sets = Object.fromEntries(arms.map(arm => [arm, new Set(observations.filter(o => o.arm === arm && o.pre.state === "correct").map(o => o.key))]))
  const common = new Set([...sets.build!].filter(key => sets.alg_default!.has(key)))
  const byArm = Object.fromEntries(arms.map(arm => {
    const issued = rows.filter(row => row.arm === arm), measured = observations.filter(o => o.arm === arm)
    return [arm, { issued: issued.length, scoredTaskSuccess: issued.filter(row => row.scored_task_success === true).length,
      completed: issued.filter(row => row.status === "completed").length,
      milestones: Object.fromEntries(["q0", "qh", "qc", "qr"].map(phase => [phase,
        issued.filter(row => row.live_obligations?.checkpoints.some(c => c.phase === phase && c.status === "completed")).length])),
      requestedSummariesCompleted: issued.reduce((n, row) => n + (row.live_obligations?.retention.boundaries.filter(b => b.transition === "compaction" && b.summarySucceeded).length ?? 0), 0),
      observedWallMs: issued.reduce((n, row) => n + (row.wall_ms ?? 0), 0),
      missingWallTime: issued.filter(row => row.wall_ms == null).length,
      behavioral: counts(measured), commonEligible: counts(measured.filter(o => common.has(o.key))),
      exclusivePreCorrect: [...sets[arm]!].filter(key => !common.has(key)).length,
      byTransition: Object.fromEntries(["control", "reassignment", "compaction", "restart"].map(transition => [transition, counts(measured.filter(o => o.transition === transition))])) }]
  }))
  const pairs = [...new Set(rows.map(row => row.caseId))].map(caseId => {
    const build = rows.find(row => row.caseId === caseId && row.arm === "build")
    const alg = rows.find(row => row.caseId === caseId && row.arm === "alg_default")
    return { caseId, buildStatus: build?.status ?? "missing", algStatus: alg?.status ?? "missing",
      buildSuccess: build?.scored_task_success === true, algSuccess: alg?.scored_task_success === true,
      difference: build && alg ? Number(alg.scored_task_success === true) - Number(build.scored_task_success === true) : null }
  })
  return { schema: "alg-long-session-comparison-v1", byArm, commonEligibleCount: common.size, pairs,
    interpretation: "All issued tasks are primary. Conditional behavioral regressions are not a causal estimate of compaction loss. Common eligibility is selected by pre-behavior. Native pruning, durable/context contents and loss mechanism remain unknown without separate evidence. Short runs do not demonstrate long-duration reliability; no superiority inference from this development batch." }
}

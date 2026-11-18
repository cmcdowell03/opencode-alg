import { randomBytes } from "node:crypto"
import { sha256Json } from "../src/persistence.ts"
import { longCheckpointPrompt, type LongCase, type LongPhase, type LongCheckpointResult } from "./build-benchmark-long-fixtures.ts"
import { retentionFrozenSetDigest, retentionObligationDigest, type RetentionBoundary, type RetentionBoundaryInput } from "./build-benchmark-retention-boundaries.ts"

export interface LongCheckpoint {
  phase: LongPhase; sessionId: string; startedAt: number; completedAt: number | null;
  fromSequence: number; nonce: string; status: "running" | "completed" | "failed";
  grade: LongCheckpointResult | null; error: string | null
  gradedSequence?: number; gradedNativeMarkers?: readonly string[];
}
export interface LongSessionEvidence {
  schema: "alg-live-obligations-v1"; taskId: string; cell: LongCase["cell"];
  checkpoints: LongCheckpoint[]; retention: RetentionBoundaryInput;
  transitions: Array<{ phase: LongPhase; status: "started" | "completed" | "failed"; receipt?: unknown }>;
  passed: boolean; complete: boolean;
}
export interface LongSessionDriver {
  sessionId(): string;
  sequence(): number;
  censusComplete(): boolean;
  auditComplete(): boolean;
  /** Complete current phase; includes the runner's cumulative budget and idle checks. */
  send(phase: LongPhase, prompt: string): Promise<unknown>;
  grade(phase: LongPhase, nonce: string, fromSequence: number): Promise<LongCheckpointResult>;
  reassign(): Promise<unknown>;
  restart(): Promise<unknown>;
  /** Inspect independently even if the summarize request fails or loses its ACK. */
  compact(requestId: string, requestedAt: number): Promise<void>;
  summary(): { id: string; completedAt: number; digest: string } | null;
  nativeMarkers(): readonly string[];
  persist(evidence: LongSessionEvidence): void;
}
const now = () => Date.now()
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 2))
const emptyFacts = (observedAt: number) => ({ observedAt, complete: false, facts: [] })

/** Reconcile a late, request-linked summary from the final bounded host census.
 * This adds exposure only: it cannot invent a continuation or a passing score. */
export function reconcileLongSummary(evidence: LongSessionEvidence, input: {
  requestId: string; sessionId: string; id: string; completedAt: number; digest: string; observedAt: number
}) {
  const b = evidence.retention.boundaries.find(b => b.transition === "compaction" && b.requestId === input.requestId && b.sessionId === input.sessionId)
  if (!b || b.summarySucceeded || b.requestAt === null || input.completedAt < b.requestAt || input.completedAt > input.observedAt) return false
  b.summarySucceeded = true; b.summaryAt = input.completedAt
  b.summaryEvidence = { eventId: input.id, requestId: input.requestId, taskId: b.taskId, sessionId: b.sessionId,
    observedAt: input.completedAt, digest: input.digest, frozenSetDigest: b.frozenSetDigest }
  b.after = emptyFacts(input.observedAt)
  b.useWindow = { startAt: input.completedAt, endAt: input.observedAt, complete: false }
  for (const row of evidence.retention.observations.filter(row => row.boundaryId === b.boundaryId)) {
    row.at = input.observedAt; row.outcome = "unknown"; row.digest = null; row.governedActionExposed = false
  }
  return true
}

/** External observer only. No gold facts or evaluator state are injected into the contestant. */
export async function runLongSession(c: LongCase, taskId: string, driver: LongSessionDriver) {
  const evidence: LongSessionEvidence = { schema: "alg-live-obligations-v1", taskId, cell: c.cell,
    checkpoints: [], retention: { schema: "build-benchmark-retention-boundaries/v1", boundaries: [], observations: [] },
    transitions: [], passed: false, complete: false }
  const save = () => driver.persist(structuredClone(evidence))
  const checkpoint = async (phase: LongPhase) => {
    const row: LongCheckpoint = { phase, sessionId: driver.sessionId(), startedAt: now(), completedAt: null,
      fromSequence: driver.sequence(), nonce: randomBytes(16).toString("hex"), status: "running", grade: null, error: null }
    evidence.checkpoints.push(row); save()
    try {
      await driver.send(phase, longCheckpointPrompt(c, phase, row.nonce))
      row.grade = await driver.grade(phase, row.nonce, row.fromSequence)
      row.gradedSequence = driver.sequence(); row.gradedNativeMarkers = [...driver.nativeMarkers()]
      row.status = "completed"
    } catch (error) {
      row.status = "failed"; row.error = error instanceof Error ? error.message : String(error)
      throw error
    } finally { row.completedAt = now(); save() }
    return row
  }
  save()
  try {
    let pre = await checkpoint("q0")
    for (const phase of ["qh", "qc", "qr"] as const) {
      const transition = phase === "qh" ? c.cell.handoff ? "reassignment" : "control"
        : phase === "qc" ? c.cell.compact ? "compaction" : "control" : "restart"
      await tick() // distinct wall-clock observations, not a context/elapsed-time stimulus
      const at = now(), boundaryId = `${taskId}:${phase}`, requestId = randomBytes(16).toString("hex")
      const obligations = pre.grade!.checks.filter(check => check.category !== "phase").map(check => {
        const o = { obligationId: check.id, category: check.category, disposition: check.id.startsWith("negative:") ? "prohibited" as const : "required" as const,
          expectedDigest: check.expectedDigest,
          basis: { phase: null, skillId: null, skillVersion: null, sourceRef: null, evidenceRef: check.id,
            pendingIntentId: null, budget: null, nextAction: null },
          frozenBy: { provenance: "external_evaluator" as const, evidenceId: `${boundaryId}:freeze:${check.id}`, digest: "" } }
        o.frozenBy.digest = retentionObligationDigest(o)
        return o
      })
      const source = driver.sessionId(), preAt = pre.completedAt!, preEvidence = `${taskId}:${pre.phase}:grade`
      const b: RetentionBoundary = { boundaryId, taskId, sessionId: source, requestId, transition,
        compactionMode: transition === "compaction" ? "requested" : null,
        frozenAt: at, transitionAt: at, requestAt: transition === "compaction" ? at : null,
        summaryAt: null, summarySucceeded: false, summaryEvidence: null, frozenSetDigest: "",
        obligations, before: emptyFacts(preAt), after: emptyFacts(at), boundaryCensusComplete: driver.censusComplete(),
        useWindow: null, pruneEvidence: { observable: false, receipt: null },
        preBehavior: { startAt: preAt, endAt: at, complete: driver.censusComplete() && driver.auditComplete() &&
          pre.gradedSequence === driver.sequence() && sha256Json(pre.gradedNativeMarkers) === sha256Json(driver.nativeMarkers()),
          evidenceId: preEvidence, digest: pre.grade!.evidenceDigest,
          events: pre.grade!.checks.filter(check => check.category !== "phase").map(check => ({
            eventId: `${preEvidence}:${check.id}`, sessionId: source, at: preAt, obligationId: check.id,
            kind: "behavior" as const, truthDigest: check.expectedDigest,
            outcome: !check.known || !check.exposed ? "unknown" as const : check.passed ? "correct" as const : "incorrect" as const,
            independentlyEvaluated: true, governedActionExposed: check.exposed, evidenceId: `${preEvidence}:${check.id}`,
            digest: pre.grade!.evidenceDigest })) } }
      b.frozenSetDigest = retentionFrozenSetDigest(b)
      evidence.retention.boundaries.push(b)
      const receipt: LongSessionEvidence["transitions"][number] = { phase, status: "started" }
      evidence.transitions.push(receipt); save() // durable freeze precedes any intervention
      let post: LongCheckpoint | undefined
      const nativeBefore = [...driver.nativeMarkers()]
      try {
        if (transition === "reassignment") {
          receipt.receipt = await driver.reassign()
          b.lineage = { eventId: `${boundaryId}:handoff`, sourceSessionId: source, recipientSessionId: driver.sessionId(),
            at, evidenceId: `${boundaryId}:transfer`, digest: sha256Json(receipt.receipt) }
        } else if (transition === "restart") receipt.receipt = await driver.restart()
        else if (transition === "compaction") {
          try { await driver.compact(requestId, at) } finally {
            const summary = driver.summary()
            if (summary) { b.summaryAt = summary.completedAt; b.summarySucceeded = true;
              b.summaryEvidence = { eventId: summary.id, requestId, taskId, sessionId: source,
                observedAt: summary.completedAt, digest: summary.digest, frozenSetDigest: b.frozenSetDigest } }
            save()
          }
          if (!b.summarySucceeded) throw new Error("long_session_summary_exposure_unqualified")
        }
        receipt.status = "completed"; save()
        post = await checkpoint(phase)
      } catch (error) {
        if (receipt.status === "started") receipt.status = "failed"
        throw error
      } finally {
        const end = now()
        b.after = emptyFacts(end)
        b.boundaryCensusComplete &&= driver.censusComplete()
        const interveningNative = driver.nativeMarkers().some(id => !nativeBefore.includes(id))
        b.useWindow = { startAt: b.summaryAt ?? at, endAt: end,
          complete: !!post && driver.auditComplete() && driver.censusComplete() && !interveningNative }
        for (const o of obligations) {
          const check = post?.grade?.checks.find(check => check.id === o.obligationId)
          const known = !!check?.known && check.exposed && check.expectedDigest === o.expectedDigest && !interveningNative
          evidence.retention.observations.push({ eventId: `${boundaryId}:post:${o.obligationId}`, boundaryId,
            taskId, sessionId: driver.sessionId(), at: end, obligationId: o.obligationId, kind: "behavior",
            outcome: !known ? "unknown" : check!.passed ? "correct" : "incorrect", digest: known ? check!.observedDigest : null,
            governedActionExposed: check?.exposed ?? false, independentlyEvaluated: true, workUnits: null,
            gradingEvidence: { evidenceId: `${taskId}:${phase}:grade:${o.obligationId}`,
              digest: post?.grade?.evidenceDigest ?? sha256Json({ phase, status: "unknown" }),
              truthDigest: check?.expectedDigest ?? o.expectedDigest } })
        }
        save()
      }
      pre = post!
    }
    evidence.complete = true
    evidence.passed = evidence.checkpoints.every(row => row.status === "completed" && row.grade?.passed === true)
    return evidence
  } finally { save() }
}

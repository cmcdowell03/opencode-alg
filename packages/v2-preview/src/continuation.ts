import { createHash } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { runContainedPath } from "../../../src/store.ts"
import type { V2InvestigationView } from "../core/investigation.ts"
import { citationSchema, publishReceipt, readReceipt, verdictSchema, WorkerJournal } from "./journal.ts"

type SessionAPI = Plugin.Context["session"]
type Session = Awaited<ReturnType<SessionAPI["get"]>>
type SessionID = Session["id"]
type Idle = Extract<Parameters<Parameters<SessionAPI["hook"]>[1]>[0], { readonly background: unknown }>
type Work = NonNullable<V2InvestigationView["work"]>
type View = Pick<V2InvestigationView, "work">
type EvidenceSource = "checker" | "external" | "research"

const checkerSchema = citationSchema.pick({ work_key: true, manifest_digest: true, read_receipt: true })
  .extend({ result: verdictSchema }).strict()
export type CheckerContinuationEvidence = z.infer<typeof checkerSchema>

const lookupReceipt = z.object({ work_key: citationSchema.shape.work_key }).strict()
const watchReceipt = lookupReceipt.extend({ version: z.literal(1), started_at: z.number().int().nonnegative() })
const batchDigest = z.string().regex(/^[a-f0-9]{64}$/)
const outstanding = new Set<Work["status"]>(["submitting", "outcome_unknown", "running", "cancel_requested"])
const resultStatuses = new Set<Work["status"]>(["result_recorded", "reusable"])
const idleBudgetMs = 2_000
const watchSlotsMs = [500, 1_500, 3_500, 7_500] as const
const watchBudgetMs = 12_000
const revisionMetadata = "algV2ContinuationRevision"

export interface OwnerContinuationOptions {
  directory: string
  project: string
  session: Pick<SessionAPI, "synthetic">
  /** Use the runtime's current agent, root-session and canonical location verification. */
  owner: (id: SessionID) => Promise<Session>
  primary: (owner: Session) => View | null
  /** Lookup the original submission only. The bridge owns the durable lookup budget. */
  reconcile: (owner: Session) => Promise<unknown>
  /** Enable bounded host-side observation when the adapter has no completion signal. */
  watchExternal?: boolean
  /** Return the exact durable result only after verifying its worker, citation, and live grant. */
  checkerEvidence: (owner: Session) => Promise<CheckerContinuationEvidence | undefined>
  /** Return a stable SHA-256 digest only for a complete, host-verified advisory batch. */
  researchBatchEvidence?: (owner: Session) => Promise<string | undefined>
}

const noticeText: Record<EvidenceSource, string> = {
  checker: "ALG recorded a verified checker result. Read the current investigation status before deciding your next action.",
  external: "ALG reconciled the original external submission. Read the current investigation status. Do not resubmit it.",
  research: "ALG recorded a complete advisory research batch. Read its verified reports before deciding your next action.",
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function active(session: Session): boolean {
  const { busy, idle } = session.time
  return busy !== undefined && (idle === undefined || busy > idle)
}

function eligible(session: Session): boolean {
  return session.time.archived === undefined && session.time.busy !== undefined &&
    (session.outcome === "succeeded" || (session.outcome === undefined && active(session)))
}

export function createOwnerContinuation(options: OwnerContinuationOptions) {
  const idleInFlight = new Set<SessionID>()
  const watchers = new Set<SessionID>()
  const lifetime = new AbortController()

  function path(id: SessionID, name: string) {
    const { directory, project } = options
    const { runId } = new WorkerJournal(directory, project, id)
    return runContainedPath(directory, runId, "continuation", name + ".json")
  }

  async function owner(id: SessionID, signal: AbortSignal) {
    if (signal.aborted) return
    const session = await options.owner(id)
    if (!signal.aborted && session.id === id && !session.parentID && session.projectID === options.project &&
        eligible(session)) return session
  }

  function lookupPath(id: SessionID, workKey: string) {
    return path(id, "lookup-" + digest(workKey))
  }

  async function externalRevision(session: Session) {
    const work = options.primary(session)?.work
    if (!work) return
    // Ledger revisions also count lookup intents, page reads and decisions. Only a settled
    // observation of the original work is new evidence. Reusable promotion preserves its digest.
    const outcome = work.status === "failed_known" ? ["closed"] :
      resultStatuses.has(work.status) && work.manifest_digest ? ["result", work.manifest_digest] : undefined
    if (!outcome) return
    const lookup = await readReceipt(lookupPath(session.id, work.work_key), lookupReceipt)
    if (lookup?.work_key === work.work_key) return digest(["external", work.work_key, ...outcome])
  }

  async function checkerRevision(session: Session) {
    const evidence = await options.checkerEvidence(session)
    if (!evidence) return
    const { work_key, manifest_digest, read_receipt, result } = checkerSchema.parse(evidence)
    const work = options.primary(session)?.work
    if (work && resultStatuses.has(work.status) && work.work_key === work_key &&
        work.manifest_digest === manifest_digest) {
      return digest(["checker", work_key, manifest_digest, read_receipt, result])
    }
  }

  async function researchRevision(session: Session) {
    const evidence = await options.researchBatchEvidence?.(session)
    if (evidence !== undefined) return digest(["research", batchDigest.parse(evidence)])
  }

  async function notify(
    session: Session,
    revision: string,
    source: EvidenceSource,
    signal: AbortSignal,
    fromIdle = false,
  ) {
    const id = session.id
    const current = await owner(id, signal)
    if (!current || (fromIdle && (!active(current) || current.time.busy !== session.time.busy))) return
    const messageID = ("msg_" + digest([options.project, id, revision]).slice(0, 32)) as
      NonNullable<Parameters<SessionAPI["synthetic"]>[0]["id"]>
    // The claim precedes admission. An ambiguous host reply or crash leaves the claim in
    // place because replay could admit a second turn or resume a subsequently paused owner.
    if (!await publishReceipt(path(id, "wake-" + revision), { version: 1, revision, source, messageID })) return
    const fresh = await owner(id, signal)
    if (!fresh || signal.aborted || (fromIdle && (!active(fresh) || fresh.time.busy !== session.time.busy))) return
    // The SDK has no atomic "admit only if still idle and succeeded" operation.
    // An interrupt racing after this last read can overlap an already-issued admission.
    const admission = await options.session.synthetic({
      sessionID: id,
      id: messageID,
      delivery: "queue",
      // Inside an execution the queued input is consumed by that execution. Do not start
      // another execution if an interrupt wins the race with an in-execution notice.
      resume: !fromIdle && !active(fresh),
      metadata: { [revisionMetadata]: revision },
      text: noticeText[source],
    })
    if (admission.id !== messageID || admission.sessionID !== id ||
        admission.payload.metadata?.[revisionMetadata] !== revision) throw new Error("V2_CONTINUATION_ADMISSION_UNVERIFIED")
  }

  async function observe(id: SessionID, receipt: z.infer<typeof watchReceipt>, operation: AbortSignal) {
    const { work_key: key, started_at: startedAt } = receipt
    const remaining = startedAt + watchBudgetMs - Date.now()
    if (operation.aborted || remaining <= 0 || remaining > watchBudgetMs) return
    const signal = AbortSignal.any([operation, AbortSignal.timeout(remaining)])
    for (const [index, offset] of watchSlotsMs.entries()) {
      const nextOffset = watchSlotsMs[index + 1] ?? watchBudgetMs
      // Skip expired slots on a reload; reconnecting cannot cause a catch-up burst.
      if (Date.now() >= startedAt + nextOffset) continue
      const wait = startedAt + offset - Date.now()
      if (wait > 0) await delay(wait, undefined, { signal, ref: false })
      const current = await owner(id, signal)
      if (!current || signal.aborted) return
      const work = options.primary(current)?.work
      if (work?.work_key !== key || work.status === "cancel_requested") return
      if (outstanding.has(work.status)) {
        if (idleInFlight.has(id) || Date.now() >= startedAt + nextOffset) continue
        const slot = path(id, "watch-slot-" + digest([key, index]))
        if (signal.aborted || !await publishReceipt(slot, { ...receipt, slot: index }) || signal.aborted) continue
        const fresh = await owner(id, signal)
        const latest = fresh && options.primary(fresh)?.work
        if (!fresh || signal.aborted || latest?.work_key !== key || latest.status === "cancel_requested") return
        // The bridge rechecks the same project/owner binding and persists lookup usage.
        // The bound here stops follow-up work; an in-flight call has the bridge's own timeout.
        if (outstanding.has(latest.status)) await options.reconcile(fresh).catch(() => {})
      }
      if (signal.aborted) return
      const latest = options.primary(current)?.work
      if (latest?.work_key !== key || latest.status === "cancel_requested") return
      if (outstanding.has(latest.status)) continue
      const revision = await externalRevision(current)
      if (revision && !signal.aborted) await notify(current, revision, "external", signal)
      return
    }
  }

  /** Register a watcher and return after its durable start is known. */
  async function watchOutstanding(id: SessionID, operation?: AbortSignal): Promise<void> {
    const signal = operation ? AbortSignal.any([operation, lifetime.signal]) : lifetime.signal
    if (!options.watchExternal || signal.aborted || watchers.has(id)) return
    watchers.add(id)
    let started = false
    try {
      const current = await owner(id, signal)
      const work = current && options.primary(current)?.work
      if (!work || !outstanding.has(work.status) || work.status === "cancel_requested" || signal.aborted) return
      const key = work.work_key
      const receiptPath = path(id, "watch-" + digest(key))
      const initial = watchReceipt.parse({ version: 1, work_key: key, started_at: Date.now() })
      const receipt = await publishReceipt(receiptPath, initial) ? initial : await readReceipt(receiptPath, watchReceipt)
      if (receipt?.work_key !== key || signal.aborted || Date.now() >= receipt.started_at + watchBudgetMs) return
      await publishReceipt(lookupPath(id, key), lookupReceipt.parse({ work_key: key }))
      started = true
      void observe(id, receipt, signal).catch(() => {}).finally(() => watchers.delete(id))
    } finally {
      if (!started) watchers.delete(id)
    }
  }

  async function checkIdle(id: SessionID, signal: AbortSignal) {
    const current = await owner(id, signal)
    if (!current || !active(current)) return
    const checker = await checkerRevision(current)
    if (checker && !signal.aborted) await notify(current, checker, "checker", signal, true)
    if (signal.aborted) return
    const research = await researchRevision(current)
    if (research && !signal.aborted) await notify(current, research, "research", signal, true)

    const work = options.primary(current)?.work
    if (signal.aborted) return
    if (work && work.status !== "cancel_requested" && outstanding.has(work.status)) {
      void watchOutstanding(id).catch(() => {})
      const key = work.work_key
      const fresh = await owner(id, signal)
      const latest = fresh && options.primary(fresh)?.work
      if (!fresh || !active(fresh) || fresh.time.busy !== current.time.busy ||
          latest?.work_key !== key || latest.status === "cancel_requested" || !outstanding.has(latest.status)) return
      // Repeated idle callbacks in the same execution and multiple plugin instances share
      // this slot. A later natural wake can look up the same outstanding submission again.
      const slot = path(id, "idle-" + digest([key, current.time.busy]))
      await publishReceipt(lookupPath(id, key), lookupReceipt.parse({ work_key: key }))
      if (signal.aborted || !await publishReceipt(slot, { version: 1, work_key: key, busy: current.time.busy }) ||
          signal.aborted) return
      await options.reconcile(fresh)
    }
    if (signal.aborted) return
    const external = await externalRevision(current)
    if (external && !signal.aborted) await notify(current, external, "external", signal, true)
  }

  async function completed(
    id: SessionID,
    operation: AbortSignal | undefined,
    source: "checker" | "research",
    revisionOf: (session: Session) => Promise<string | undefined>,
  ) {
    const signal = operation ? AbortSignal.any([operation, lifetime.signal]) : lifetime.signal
    const current = await owner(id, signal)
    if (!current) return
    const revision = await revisionOf(current)
    if (revision && !signal.aborted) await notify(current, revision, source, signal)
  }

  return {
    watchOutstanding,

    /** Hook only on the pinned successful-idle transition. Background IDs alone grant no authority. */
    async onIdle(event: Idle): Promise<void> {
      const id = event.sessionID
      if (lifetime.signal.aborted || idleInFlight.has(id)) return
      idleInFlight.add(id)
      const deadline = new AbortController()
      const signal = AbortSignal.any([deadline.signal, lifetime.signal])
      let timer: ReturnType<typeof setTimeout> | undefined
      const bounded = new Promise<void>(resolve => {
        timer = setTimeout(() => { deadline.abort(); resolve() }, idleBudgetMs)
      })
      const work = checkIdle(id, signal).catch(() => {}).finally(() => idleInFlight.delete(id))
      try { await Promise.race([work, bounded]) }
      finally { clearTimeout(timer) }
    },

    async checkerCompleted(id: SessionID, operation?: AbortSignal): Promise<void> {
      await completed(id, operation, "checker", checkerRevision)
    },

    async researchCompleted(id: SessionID, operation?: AbortSignal): Promise<void> {
      if (options.researchBatchEvidence) await completed(id, operation, "research", researchRevision)
    },

    /** Optional notification after an explicit, successful lookup by the runtime. */
    async externalReconciled(id: SessionID, before: View | null, operation?: AbortSignal): Promise<void> {
      const signal = operation ? AbortSignal.any([operation, lifetime.signal]) : lifetime.signal
      const prior = before?.work
      if (!prior || !outstanding.has(prior.status)) return
      const current = await owner(id, signal)
      if (!current || options.primary(current)?.work?.work_key !== prior.work_key) return
      await publishReceipt(lookupPath(id, prior.work_key), lookupReceipt.parse({ work_key: prior.work_key }))
      const revision = await externalRevision(current)
      if (revision && !signal.aborted) await notify(current, revision, "external", signal)
    },

    dispose(): void { lifetime.abort() },
  }
}

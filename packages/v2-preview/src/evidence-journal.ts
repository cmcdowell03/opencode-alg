import { createHash } from "node:crypto"
import { stat } from "node:fs/promises"
import { z } from "zod"
import { runContainedPath } from "../../../src/store.ts"
import type { V2InvestigationView } from "../core/investigation.ts"
import { calculationCheckpointMaxBytes, calculationCheckpointSchema, inspectCalculationProgress, validateCalculationReceipt,
  type CalculationPolicy, type ChildAuditOrigin, type VerifiedChildAudit } from "./calculation.ts"
import type { DeliveryHistory } from "./delivery.ts"
import { publishReceipt, readReceipt } from "./journal.ts"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const cutSchema = z.strictObject({ checkpoint: hash })
const decisionSchema = z.strictObject({ revision: z.number().int().positive(), proof: hash, work: z.string(), manifest: hash, action: z.string() })
export type EvidenceProgress = ReturnType<typeof inspectCalculationProgress>
type VerifiedCalculationReport = {
  status: "verified"
  revision: number
  fields: Record<string, string | number>
}
type UnverifiedCalculationReport = {
  status: "incomplete" | "abstained" | "provisional"
  measurements: EvidenceProgress["receipt"]["values"]
  references: Record<string, string>
  obligation: EvidenceProgress["obligation"]
}
export type CalculationReport = VerifiedCalculationReport | UnverifiedCalculationReport
type Notice = Omit<ChildAuditOrigin, "sourceProof">
export interface ChildEvidenceReader {
  notice(row: DeliveryHistory[number]): Notice | undefined
  resolve(notice: Notice, progress: EvidenceProgress): Promise<VerifiedChildAudit | undefined>
}

/** Re-read authority for an adopted child even if the original notice was compacted. */
export async function revalidateChildEvidence(progress: EvidenceProgress, reader?: ChildEvidenceReader) {
  const origin = progress.receipt.sources.correction?.child
  if (!origin) return
  const verified = await reader?.resolve(origin, progress)
  if (verified?.origin.sourceProof !== origin.sourceProof) throw new Error("CHILD_AUDIT_NO_LONGER_VERIFIED")
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex")

/** Immutable observations and compaction pointers live under the existing owner journal. */
export class EvidenceJournal {
  private readonly prefix: string
  constructor(private readonly directory: string, private readonly runId: string, scope: readonly string[]) {
    this.prefix = digest(scope)
  }

  private path(kind: string, id: string) {
    return runContainedPath(this.directory, this.runId, "evidence", this.prefix, kind, id + ".json")
  }

  async observe(policy: CalculationPolicy, history: DeliveryHistory, agent: string, compacting = false, reader?: ChildEvidenceReader) {
    const last = history.at(-1)
    const cut = compacting && last?.type === "compaction" && last.status === "running" ? last : undefined
    const window = cut ? history.slice(0, -1) : history
    let previous = window.length - 1
    for (; previous >= 0; previous--) {
      const row = window[previous]!
      if (row.type === "compaction" && row.status === "completed") break
    }
    const anchor = window[previous]
    const pointer = anchor && await readReceipt(this.path("cut", digest(anchor.id)), cutSchema)
    const checkpoint = pointer && await readReceipt(this.path("state", pointer.checkpoint), calculationCheckpointSchema, calculationCheckpointMaxBytes + 1)
    if (pointer && checkpoint?.proofSha256 !== pointer.checkpoint) throw new Error("EVIDENCE_CHECKPOINT_INVALID")
    const suffix = previous < 0 ? window : window.slice(previous + 1)
    const audits = new Map<string, VerifiedChildAudit>()
    if (reader) {
      let notices = 0
      for (const [index, row] of suffix.entries()) {
        const notice = reader.notice(row)
        if (!notice) continue
        if (++notices > 16) throw new Error("CHILD_AUDIT_WINDOW_LIMIT")
        const before = inspectCalculationProgress(policy, suffix.slice(0, index), agent, checkpoint, false, audits)
        if (!before.checkpoint?.selected || before.checkpoint.conflict) continue
        const verified = await reader.resolve(notice, before)
        if (verified) audits.set(row.id, verified)
      }
    }
    const progress = inspectCalculationProgress(policy, suffix, agent, checkpoint, !!cut, audits)
    await revalidateChildEvidence(progress, reader)
    if (progress.checkpoint) {
      const id = progress.checkpoint.proofSha256
      const path = this.path("state", id)
      if (pointer?.checkpoint !== id) {
        try { await stat(path) } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
          await publishReceipt(path, progress.checkpoint)
        }
      }
      if (cut) {
        const pinned = this.path("cut", digest(cut.id))
        if (!await publishReceipt(pinned, { checkpoint: id }) && (await readReceipt(pinned, cutSchema))?.checkpoint !== id)
          throw new Error("EVIDENCE_BOUNDARY_CHANGED")
      }
    }
    return progress
  }

  /** Certify only the configured rule over the validated receipt captured before the decision. */
  calculationProof(policy: CalculationPolicy, progress: EvidenceProgress, nextAction: string) {
    return this.choice(policy, progress, nextAction) ? progress.receipt.proofSha256 : undefined
  }

  private choice(policy: CalculationPolicy, progress: EvidenceProgress, nextAction: string) {
    const rule = policy.decisionRules
    const proof = progress.receipt
    if (!rule || progress.obligation.kind !== "verified" || proof.status !== "verified" ||
        !validateCalculationReceipt(proof) || !proof.sources.owner) return
    const value = proof.values[rule.field]
    if (value === undefined) return
    const choice = value >= rule.minimum ? rule.whenMet : rule.otherwise
    // A free-form checkpoint may still be useful, but cannot certify an action/prerequisite pair.
    const [action, qualifier, ...extra] = nextAction.split(";").map(s => s.trim())
    if (extra.length || action !== choice.nextAction || qualifier !== "prerequisite=" + choice.prerequisite) return
    return choice
  }

  private decision(policy: CalculationPolicy, progress: EvidenceProgress, view: V2InvestigationView | null) {
    if (!view?.procedurePin || !view.decision_revision || !view.work?.manifest_digest ||
        !["reusable", "result_recorded"].includes(view.work.status)) return
    const action = view.decision.next_action
    const choice = action && this.choice(policy, progress, action)
    if (!choice) return
    const stamp = { revision: view.decision_revision, proof: progress.receipt.proofSha256, work: view.work.work_key,
      manifest: view.work.manifest_digest, action }
    return { choice, stamp, path: this.path("decision", String(stamp.revision)) }
  }

  /** Only the actual acknowledged decision write may publish this link to already observed evidence. */
  async acknowledged(policy: CalculationPolicy, progress: EvidenceProgress, view: V2InvestigationView) {
    const decision = this.decision(policy, progress, view)
    if (decision) await publishReceipt(decision.path, decision.stamp)
  }

  async report(policy: CalculationPolicy, progress: EvidenceProgress, view: V2InvestigationView | null): Promise<CalculationReport> {
    const { obligation, receipt } = progress
    const measurements = receipt.values
    const references = Object.fromEntries(Object.values(receipt.sources).map(s => [s.reportReferenceField, s.reference]))
    if (obligation.kind !== "verified") {
      const status = obligation.kind === "exhausted" || obligation.kind === "conflict" ? "abstained" : "incomplete"
      return { status, obligation, measurements, references }
    }
    if (["nextAction", "prerequisite"].some(key => Object.hasOwn(measurements, key) || Object.hasOwn(references, key))) {
      return { status: "provisional", measurements, references, obligation }
    }
    if (view?.investigationMode === "read-only") {
      const action = view.decision.next_action
      const choice = action && this.choice(policy, progress, action)
      if (choice && view.decision_revision > 0 && view.procedurePin &&
          view.decisionSources?.calculationProof === receipt.proofSha256) {
        return { status: "verified", revision: view.decision_revision, fields: { ...measurements, ...references, ...choice } }
      }
    } else {
      const decision = this.decision(policy, progress, view)
      if (decision) {
        const saved = await readReceipt(decision.path, decisionSchema)
        if (saved && digest(saved) === digest(decision.stamp))
          return { status: "verified", revision: saved.revision, fields: { ...measurements, ...references, ...decision.choice } }
      }
    }
    return { status: "provisional", measurements, references, obligation }
  }
}

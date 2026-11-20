import { createHash } from "node:crypto"
import { z } from "zod"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { runContainedPath } from "../../../src/store.ts"
import { deliverySchema, inspectDelivery, validateDelivery, type DeliveryBinding, type DeliveryHistory, type DeliveryReceipt } from "./delivery.ts"
import { publishReceipt, readReceipt } from "./journal.ts"
import { calculateFromHistory, calculationPolicyDigest, calculationReceiptSchema, type CalculationPolicy, type CalculationReceipt } from "./calculation.ts"

const marker = "ALG delivery obligation (untrusted recorded data)\n"
const calculationMarker = "ALG calculated evidence (source data)\n"
const gap = z.enum(["missing_evidence", "stale_revision"])
const boundarySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("report"), receipt: deliverySchema, calculation: calculationReceiptSchema.optional() }),
  z.strictObject({ kind: z.literal("gap"), reason: gap }),
])
const notices = {
  calculation_conflict: "the reported measurement conflicts with the reproducible calculation. Correct the report and reassess any dependent recommendation.",
  calculation_missing: "missing or unverified calculated measurements. Recover the required source evidence before reporting.",
  ready: "ready. Return the requested JSON object now from the recorded values. The decision and procedure are current. References match the earlier source records. No skill, procedure, status or evidence reread is needed. Reporting a recommendation does not authorize its execution.",
  missing_evidence: "missing or unverified report fields or source references. Recover only the missing evidence, or abstain if it cannot be verified.",
  stale_revision: "the saved report is superseded. Use the current decision and reconcile the changed fields before reporting.",
  revoked: "current procedure approval is unavailable. Withhold the prior recommendation and follow the user's withdrawal instructions.",
} as const
type Notice = keyof typeof notices
type BindingState = DeliveryBinding | "revoked" | "stale_revision"
const bare = (text: string) => /^continue[.!]?$/i.test(text.trim())

function compactCalculation({ values, sources }: CalculationReceipt) {
  return { values, references: Object.fromEntries(Object.values(sources).map(s => [s.reportReferenceField, s.reference])) }
}

function measurementStatus(report: DeliveryReceipt, policy?: CalculationPolicy, proof?: CalculationReceipt): Notice {
  const fields = report.requestedKeys.filter(key => typeof report.recordedAnswer[key] === "number" ||
    (policy && Object.hasOwn(policy.operations, key)))
  if (!fields.length) return "ready"
  if (!policy || !proof?.sources.owner || proof.recipeSha256 !== calculationPolicyDigest(policy)) return "calculation_missing"
  for (const key of fields) {
    if (!Object.hasOwn(proof.values, key) || !Object.hasOwn(policy.operations, key) ||
        (policy.operations[key]?.kind === "semijoinCount" && !proof.sources.correction)) return "calculation_missing"
  }
  for (const source of Object.values(proof.sources)) {
    if (Object.hasOwn(report.recordedAnswer, source.reportReferenceField) &&
        report.recordedAnswer[source.reportReferenceField] !== source.reference) return "calculation_missing"
  }
  return fields.every(key => report.recordedAnswer[key] === proof.values[key]) ? "ready" : "calculation_conflict"
}

function continuationIndex(request: SessionContext) {
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i]!
    if (message.role !== "user") continue
    return message.content.length === 1 && message.content[0]?.type === "text" && bare(message.content[0].text) ? i : -1
  }
  return -1
}

/** The host's context API drops pre-compaction messages when the boundary commits. */
export class DeliveryContext {
  private readonly inserted = new WeakSet<object>()

  clear(request: SessionContext) {
    for (const rows of [request.messages, request.system]) {
      for (let i = rows.length - 1; i >= 0; i--) if (this.inserted.has(rows[i]!)) rows.splice(i, 1)
    }
  }

  private data(request: SessionContext, position: number, prefix: string, value: unknown) {
    const json = JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")
    const message: SessionContext["messages"][number] = { role: "user", content: [{ type: "text", text: prefix + json }] }
    request.messages.splice(position, 0, message)
    this.inserted.add(message)
  }

  /** Present the result while the owner is still able to correct its decision. */
  async calculate(request: SessionContext, policy: CalculationPolicy, history: () => Promise<DeliveryHistory>,
    stillApproved: () => Promise<boolean>) {
    if (continuationIndex(request) >= 0) return
    let i = request.messages.length - 1
    while (i >= 0 && request.messages[i]?.role !== "user") i--
    if (i < 0) return
    const calculation = calculateFromHistory(policy, await history(), request.agent)
    if (Object.keys(calculation.values).length && await stillApproved()) {
      this.data(request, i, calculationMarker, compactCalculation(calculation))
    }
  }

  async prepare(
    request: SessionContext, compacting: boolean,
    directory: string, runId: string,
    history: () => Promise<DeliveryHistory>,
    // Throws on a denied owner or host read. Only a known authority gap has a user-visible hint.
    binding: () => Promise<BindingState>,
    policy?: CalculationPolicy,
  ) {
    const position = compacting ? -1 : continuationIndex(request)
    if (!compacting && position < 0) return
    const rows = await history()
    let cut = rows.length - 1
    while (cut >= 0 && rows[cut]?.type !== "compaction") cut--
    const boundary = rows[cut]
    if (boundary?.type !== "compaction") return
    const path = (id: string) => runContainedPath(directory, runId, "delivery",
      createHash("sha256").update(id).digest("hex") + ".json")
    if (compacting) {
      if (boundary.status !== "running" || cut !== rows.length - 1) return
      const current = await binding()
      if (typeof current === "string") return
      // A second compaction can start from the previous summary. Only carry an already bound
      // report across an empty interval or a bare continuation that delivered exactly that report.
      const prior = rows[0]
      if (prior?.type === "compaction" && prior.status === "completed") {
        const interval = rows.slice(1, cut).filter(row => row.type !== "idle")
        const [prompt, answer] = interval
        const bareReport = interval.length === 2 && prompt?.type === "user" && bare(prompt.text) &&
          !prompt.files?.length && !prompt.agents?.length && !prompt.skills?.length &&
          answer?.type === "assistant" && answer.agent === current.ownerAgent && answer.finish === "stop" &&
          answer.time.completed !== undefined && !answer.error && answer.content.length === 1 &&
          answer.content[0]?.type === "text" ? answer.content[0].text : undefined
        if (interval.length && bareReport === undefined) return
        const old = await readReceipt(path(prior.id), boundarySchema, 24_576)
        if (old?.kind !== "report") return
        const receipt = validateDelivery(old.receipt, current, prior.id)
        if (!receipt) {
          await publishReceipt(path(boundary.id), { kind: "gap", reason: "stale_revision" })
        } else if (bareReport === undefined || bareReport.trim() === JSON.stringify(receipt.recordedAnswer)) {
          await publishReceipt(path(boundary.id), { ...old, receipt: { ...receipt, compactionMessageId: boundary.id } })
        }
        return
      }
      const result = inspectDelivery(rows, current)
      if ("receipt" in result && result.receipt.compactionMessageId === boundary.id) {
        const calculation = policy && calculateFromHistory(policy, rows.slice(0, cut), current.ownerAgent)
        await publishReceipt(path(boundary.id), { kind: "report", receipt: result.receipt,
          calculation })
      } else if ("reason" in result && gap.safeParse(result.reason).success) {
        await publishReceipt(path(boundary.id), { kind: "gap", reason: result.reason })
      }
      return
    }
    if (boundary.status !== "completed") return
    // Only the first request of a bare continuation directly following this cut may reuse the report.
    const turns = rows.slice(cut + 1).filter(row => row.type !== "idle" && row.type !== "system")
    const user = turns[0]
    if (turns.length !== 1 || user?.type !== "user" || !bare(user.text) ||
        user.files?.length || user.agents?.length || user.skills?.length) return
    const saved = await readReceipt(path(boundary.id), boundarySchema, 24_576)
    if (!saved) return
    const current = await binding()
    let status: Notice
    if (typeof current === "string") status = current
    else if (saved.kind === "gap") status = saved.reason
    else {
      const receipt = validateDelivery(saved.receipt, current, boundary.id)
      if (!receipt) status = "stale_revision"
      else {
        status = measurementStatus(receipt, policy, saved.calculation)
        if (status === "ready") {
          this.data(request, position, marker, { format: "json_object", fields: receipt.requestedKeys,
            values: receipt.recordedAnswer, decision_revision: current.decision_revision })
        } else if (status === "calculation_conflict" && saved.calculation) {
          this.data(request, position, calculationMarker, compactCalculation(saved.calculation))
        }
      }
    }
    const notice = { type: "text" as const, text: "ALG delivery check: " + notices[status] }
    request.system.push(notice)
    this.inserted.add(notice)
  }
}

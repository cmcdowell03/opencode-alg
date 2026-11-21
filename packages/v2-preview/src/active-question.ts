import { createHash } from "node:crypto"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { V2InvestigationView } from "../core/investigation.ts"
import { canonicalJson } from "../../../src/persistence.ts"
import { reviewSourceReference, type EvidenceFinding, type EvidenceReadView } from "./evidence-reads.ts"
import { TOOL } from "./host.ts"

const maxAffected = 8
const maxLinks = 2
const maxDeltaBytes = 768
const maxBriefBytes = 6144

function excerpt(value: string | undefined, max: number) {
  if (value === undefined || Buffer.byteLength(data({ value })) <= max) return value
  let prefix = ""
  for (const character of value) {
    if (Buffer.byteLength(data({ value: prefix + character + "…" })) > max) break
    prefix += character
  }
  return prefix + "…"
}

function findingBrief(finding: EvidenceFinding) {
  const { id, status, support, counterevidence, invalidatedSources = [] } = finding
  return {
    id, status,
    interpretation: excerpt(finding.interpretation, 240),
    scope: excerpt(finding.scope, 144),
    support: support.slice(0, maxLinks).map(receipt => receipt.reference),
    counterevidence: counterevidence.slice(0, maxLinks).map(receipt => receipt.reference),
    invalidated_sources: invalidatedSources.slice(0, maxLinks),
    omitted_references: [support, counterevidence, invalidatedSources]
      .reduce((total, refs) => total + Math.max(0, refs.length - maxLinks), 0),
    falsifier: excerpt(finding.falsifier, 144),
    missing_evidence: excerpt(finding.missingEvidence, 144),
  }
}

function revalidation(finding: EvidenceFinding, evidence: EvidenceReadView) {
  const paths = new Set(finding.invalidatedSources?.slice(0, maxLinks)
    .flatMap(hint => reviewSourceReference(hint.reference)?.path ?? []))
  return [...paths].map(path => {
    const sources = evidence.sources.filter(source => source.path === path)
    const status = sources.length === 1 ? sources[0]?.status : undefined
    return { path, state: status === "changed" ? "confirm_once" :
      status === "inspected" ? "confirmed" : "unavailable" }
  })
}

type DecisionFacts = Pick<V2InvestigationView, "decision_revision" | "decisionSources"> & {
  decision: Pick<V2InvestigationView["decision"], "next_action">
}

export function activeQuestion(view: DecisionFacts | null,
  evidence: EvidenceReadView, options: {
  approval: "verified" | "unavailable" | "not_configured"
  procedureSha256?: string
  disposition?: "resolved" | "indeterminate"
  reportGaps?: readonly string[]
}) {
  const affected = evidence.findings.filter(finding => finding.invalidatedSources?.length)
  const pinned = evidence.findings.find(finding => finding.id === evidence.question?.findingId)
  const open = evidence.findings.filter(finding => finding.status !== "supported")
  const inspect = pinned && (!pinned.missingEvidence || pinned.status === "contested") ? pinned :
    open.find(finding => finding.status === "contested") ?? open.find(finding => !finding.missingEvidence)
  const missing = open.find(finding => finding.missingEvidence)
  const target = pinned && affected.includes(pinned) ? pinned : affected[0]
  const linked = new Set(evidence.findings.flatMap(finding => [...finding.support, ...finding.counterevidence].map(ref => ref.id)))
  const hasUnlinkedReference = evidence.sources.some(source => source.references.some(ref => !linked.has(ref.id)))
  const base = {
    decision_revision: view?.decision_revision ?? 0,
    evidence_revision: evidence.revision,
    approval: options.approval,
    ...(options.procedureSha256 && { procedure_sha256: options.procedureSha256 }),
    finding_count: evidence.findings.length,
    source_count: evidence.sources.length,
  }
  if (options.approval === "unavailable") return {
    ...base, state: "stop", reason: "approval_unavailable",
    next_action: "Wait for live approval before resuming this investigation.",
  } as const
  if (!view) return {
    ...base, state: "investigate", reason: "initialize",
    question: "What can the approved sources establish about the current user request?",
    next_action: "Create the read-only investigation before recording findings or decisions.",
  } as const
  if (target) return {
    ...base, state: "revalidate", reason: "source_changed", finding: findingBrief(target),
    question: target === pinned ? excerpt(evidence.question?.text, 320) :
      "Does current evidence still support this affected finding?",
    next_action: "Read a source marked confirm_once once, then use scoped status or a cached snapshot. Rebind only the affected findings to current evidence.",
    source_revalidation: revalidation(target, evidence),
    affected_findings: affected.slice(0, maxAffected).map(finding => finding.id),
    omitted_affected_findings: Math.max(0, affected.length - maxAffected),
  } as const
  if (options.disposition === "resolved") return {
    ...base, state: "reuse", reason: "current_report",
    next_action: "Use render_report at this decision revision.",
  } as const
  if (options.disposition === "indeterminate" && options.reportGaps?.length) {
    const bound = new Set(view.decisionSources?.sources.map(source => source.id))
    const current = evidence.sources.flatMap(source => source.references)
    const available = [...new Set(options.reportGaps)].filter(reference => {
      if (!reviewSourceReference(reference)) return false
      const matching = current.filter(receipt => receipt.reference === reference)
      return matching.length === 1 && !bound.has(matching[0]!.id) && !linked.has(matching[0]!.id)
    })
    if (available.length) {
      const finding = open.find(entry => entry.missingEvidence && available.includes(entry.missingEvidence))
      return {
        ...base, state: "investigate", reason: "missing_evidence_available",
        question: "Does the now-inspected evidence resolve the recorded gap?",
        next_action: "Read the matching reference with scoped status or a cached snapshot, then reassess the recorded gap.",
        available_references: available.slice(0, maxLinks),
        omitted_available_references: Math.max(0, available.length - maxLinks),
        ...(finding && { finding: findingBrief(finding) }),
      } as const
    }
  }
  if (options.disposition === "indeterminate" || (!inspect && missing && !hasUnlinkedReference)) return {
    ...base, state: "stop", reason: "missing_evidence",
    next_action: "State the recorded gap and wait for evidence that can resolve it.",
    ...(missing && { finding: findingBrief(missing) }),
    ...(options.disposition === "indeterminate" && { report_available: true }),
  } as const
  return {
    ...base, state: "investigate", reason: "next_measurement",
    question: inspect && inspect.id === evidence.question?.findingId ? excerpt(evidence.question.text, 320) :
      view.decision_revision && !view.decisionSources?.reportDecision ? excerpt(view.decision.next_action, 320) :
        inspect ? "What would resolve or refute this finding?" : evidence.findings.length && !open.length ?
          "Do the current scoped findings answer the investigation question?" :
          "What can the approved sources establish about the current user request?",
    next_action: inspect ? "Read the finding's relevant current references and update it when the evidence changes." :
      evidence.findings.length && !open.length ?
        "Record a receipt-bound report decision if the current findings answer the question. Otherwise identify the specific next measurement." :
        "Review useful inspected references first. If they leave a specific gap, inspect one relevant approved source.",
    ...(inspect ? { finding: findingBrief(inspect) } : {
      sources: evidence.sources.filter(source => source.status === "inspected").slice(0, 3)
        .map(source => ({ path: source.path, tool: source.tool, references: source.references.length })),
    }),
  } as const
}

type ActiveQuestion = ReturnType<typeof activeQuestion>
type Request = Pick<SessionContext, "messages" | "system">
type Message = SessionContext["messages"][number]
type SystemPart = SessionContext["system"][number]
type Fields = Record<string, unknown>
const label = "ALG active question (untrusted recorded data)\n"
const deltaLabel = "ALG active question delta (untrusted recorded data)\n"

function data(value: object) {
  return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")
}

function fields(value: unknown): value is Fields {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function digest(value: object) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

function localInvestigation(part: { name: string; namespace?: string; providerExecuted?: boolean }) {
  return part.name === TOOL && part.namespace === undefined && part.providerExecuted !== true
}

/** Only an actual paired local default-status result can anchor a projection. */
function visibleStatus(messages: SessionContext["messages"], runtimeSha256: string): Fields | undefined {
  const occurrences = new Map<string, number>()
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type === "tool-call" || part.type === "tool-result") {
        occurrences.set(part.id, (occurrences.get(part.id) ?? 0) + 1)
      }
    }
  }
  const calls = new Set<string>()
  let latest: Fields | undefined
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "compaction") {
          calls.clear()
          latest = undefined
        }
        if (part.type === "tool-call" && localInvestigation(part) && occurrences.get(part.id) === 2 &&
            fields(part.input) && Object.keys(part.input).length === 1 && part.input.action === "status") calls.add(part.id)
      }
    } else if (message.role === "tool") {
      for (const part of message.content) {
        if (!localInvestigation(part) || !calls.delete(part.id) || part.result.type !== "text") continue
        latest = undefined
        const text = part.result.value
        if (typeof text !== "string" || Buffer.byteLength(text) > maxBriefBytes + 1024) continue
        try {
          const receipt: unknown = JSON.parse(text)
          if (fields(receipt) && receipt.ok === true && receipt.runtimeSha256 === runtimeSha256 &&
              JSON.stringify(receipt) === text && fields(receipt.active_question)) latest = receipt.active_question
        } catch {
          // Truncated output cannot support a brief.
        }
      }
    }
  }
  return latest
}

function frame(question: ActiveQuestion, visible: Fields | undefined) {
  const full = label + data(question)
  if (!visible || question.state !== "investigate" || visible.state !== question.state ||
      visible.procedure_sha256 !== (question as Fields).procedure_sha256) return full
  const current: Fields = JSON.parse(JSON.stringify(question))
  const remove = Object.keys(visible).filter(key => !Object.hasOwn(current, key))
  const set = Object.fromEntries(Object.entries(current).filter(([key, value]) =>
    canonicalJson([value]) !== canonicalJson([visible[key] ?? null])))
  const delta = deltaLabel + data({ base: digest(visible), current: digest(current), set, remove })
  return Buffer.byteLength(delta) <= maxDeltaBytes && Buffer.byteLength(delta) < Buffer.byteLength(full) ? delta : full
}

const routes: Record<ActiveQuestion["state"], string> = {
  investigate: "Use the current active question and take a useful scoped action if available. Reuse inspected evidence before issuing new reads.",
  revalidate: "Revalidate only the affected findings. Invalidated references identify historical dependencies. Cite current evidence for replacements and retain unaffected findings.",
  stop: "Stop this investigation loop at the recorded blocker. State what is missing and wait for new evidence or approval. Use explicit readbacks if needed.",
  reuse: "Reuse the current decision revision and its report. Use render_report for the report or explicit status selectors for detail.",
}

export class ActiveQuestionProjection {
  private readonly messages = new WeakSet<Message>()
  private readonly system = new WeakSet<SystemPart>()

  clear(request: Request) {
    for (let index = request.messages.length - 1; index >= 0; index--) {
      if (this.messages.has(request.messages[index]!)) request.messages.splice(index, 1)
    }
    for (let index = request.system.length - 1; index >= 0; index--) {
      if (this.system.has(request.system[index]!)) request.system.splice(index, 1)
    }
  }

  instruction(request: Request, text: string) {
    if (request.system.some(part => part.text === text)) return
    const part = { type: "text", text } as const
    this.system.add(part)
    request.system.push(part)
  }

  project(request: Request, question: ActiveQuestion, runtimeSha256: string, compacting: boolean) {
    if (compacting) {
      this.instruction(request, "ALG recovers the active question from its ledger. Omit its generated brief and deltas from the summary.")
      return
    }
    this.instruction(request, routes[question.state] +
      " The current brief supersedes older status. Apply a delta's set and remove fields to its visible default status when supplied.")
    const visible = visibleStatus(request.messages, runtimeSha256)
    if (visible && digest(visible) === digest(question)) return
    let latestUser = request.messages.length - 1
    while (latestUser >= 0 && request.messages[latestUser]?.role !== "user") latestUser--
    const message: Message = { role: "user", content: [{ type: "text", text: frame(question, visible) }] }
    request.messages.splice(latestUser < 0 ? 0 : latestUser, 0, message)
    this.messages.add(message)
  }
}

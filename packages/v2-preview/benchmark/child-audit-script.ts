import { algTool } from "../acceptance/host.ts"
import { calculationMarker, observeCalculatedEvidence } from "./delivery-script.ts"
import { checkerPrompt, continuation, handoffHeader } from "./evidence-handoff-case.ts"
import { scriptedEvidenceHandoff } from "./evidence-handoff-script.ts"
import { jsonObject, object } from "./handoff-case.ts"
import { checkerName } from "./host.ts"
import { wireTextParts } from "./skill-delivery.ts"
import type { Completion, Message, TurnInput } from "./transport.ts"

export const childAudit = { agent: checkerName, tool: "audit_lookup_pages", source: "clock-audit", scope: "whole-source" } as const
export const childTool = "subagent"
export const childTask = { agent: childAudit.agent, description: "Independent inspection clock audit", prompt: checkerPrompt }
export type Phase = "initial" | "compact" | "resume" | "wake" | "probe" | "duplicate" | "conflict" | "revoked"

const nativeNotice = (text: string) => /^<subagent(?:\s|>)/.test(text.trimStart())
const childPrompt = (text: string) =>
  text.startsWith("You are a subagent spawned by another session.") && text.trimEnd().endsWith(checkerPrompt)
const reply = (value: object): Completion => ({ text: JSON.stringify(value) })
const useAlg = (action: string, args: object = {}): Completion => ({ tool: algTool, args: { action, ...args } })

export function classifyChildAudit(messages: Message[], phase: Phase) {
  return messages.some(row => row.role === "user" && wireTextParts(row.content).some(childPrompt))
    ? { role: "checker", phase: "audit" } as const : { role: "root", phase } as const
}

export function auditWire(messages: Message[]) {
  const text = messages.flatMap(row => wireTextParts(row.content).map(text => ({ role: row.role, text })))
  const calculation = observeCalculatedEvidence(messages)
  const projected = text.find(row => row.role === "user" && row.text.startsWith(calculationMarker))
  const data = projected && jsonObject(projected.text.slice(calculationMarker.length))
  return {
    calculation, references: calculation.values ? object(data?.references) : undefined,
    nativeNotices: text.filter(row => nativeNotice(row.text)).length,
    explicitHandoffs: text.filter(row => row.role === "user" && row.text.startsWith(handoffHeader + "\n")).length,
  }
}

export function scriptedChildAudit(input: TurnInput, phase: Phase): Completion {
  const { messages, tools, summary } = input
  if (summary || phase === "initial") return scriptedEvidenceHandoff(input)
  if (classifyChildAudit(messages, phase).role === "checker") {
    // Native OpenCode prepends its own instructions to the delegated prompt.
    return scriptedEvidenceHandoff({ ...input, messages: messages.map(message =>
      message.role === "user" && wireTextParts(message.content).some(childPrompt)
        ? { ...message, content: checkerPrompt } : message) })
  }
  if (phase === "resume") {
    const result = scriptedEvidenceHandoff(input)
    const attemptedChild = messages.some(row => row.tool_calls?.some(call => call.function?.name === childTool))
    if (!attemptedChild && "text" in result && jsonObject(result.text)?.status === "provisional")
      return { tool: childTool, args: childTask }
    return result
  }

  const boundary = messages.map(row => wireTextParts(row.content).some(text =>
    phase === "wake" ? nativeNotice(text) :
      row.role === "user" && (phase === "duplicate" || phase === "conflict"
        ? text.startsWith(handoffHeader + "\n") : text === continuation))).lastIndexOf(true)
  if (boundary < 0 || !tools.includes(algTool)) return reply({ status: "fixture-boundary-unavailable" })
  const receipts = messages.slice(boundary + 1).filter(message => message.role === "tool")
    .flatMap(message => wireTextParts(message.content).flatMap(text => {
      const value = jsonObject(text)
      return value ? [value] : []
    }))
  if (receipts.some(row => row.ok !== true)) return reply({ status: "fixture-tool-rejected" })
  const status = receipts.filter(row => object(row.evidenceReport))
  const last = status.at(-1)
  const report = object(last?.evidenceReport)
  if (!last || !report) return useAlg("status")
  if (report.status === "verified") return reply({ status: "verified", ...object(report.fields) })
  if (phase !== "wake" || report.status !== "provisional") return reply({ status: report.status })

  // Only plugin-projected source data and the installed status tool can unlock
  // the decision here. The host's synthetic completion text is a wake signal.
  const { calculation, references, explicitHandoffs } = auditWire(messages)
  const measurements = object(report.measurements)
  const sourceRefs = object(report.references)
  const corrected = measurements?.verifiedClockCorrections
  if (explicitHandoffs || typeof corrected !== "number" || calculation.values?.verifiedClockCorrections !== corrected ||
      typeof sourceRefs?.auditRef !== "string" || sourceRefs.auditRef !== references?.auditRef)
    return reply({ status: "child-evidence-unavailable" })

  const settled = receipts.filter(row => row.work && !row.evidenceReport)
  if (settled.length < 3) return useAlg(["admit", "dispatch", "reconcile"][settled.length]!)
  const action = corrected > 0 ? "replay-clock-join; prerequisite=verified-clock-audit" :
    "attribute-as-recorded; prerequisite=independent-clock-audit"
  if (!receipts.some(row => object(row.decision)?.next_action === action))
    return useAlg("set_next_measurement", { expected_decision_revision: last.decision_revision, next_action: action })
  // A successful write is followed by a fresh status. Stop if that status
  // cannot certify the acknowledged decision.
  return status.length === 1 ? useAlg("status") : reply({ status: "decision-unverified" })
}


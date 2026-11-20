import { algTool } from "../acceptance/host.ts"
import { classifyEvidenceHandoff, continuation, handoffHeader, limits, minimumDefects, skillId } from "./evidence-handoff-case.ts"
import type { ClockAudit, Inspection } from "./case.ts"
import { jsonObject, object } from "./handoff-case.ts"
import { wireTextParts } from "./skill-delivery.ts"
import type { Completion, Message, TurnInput } from "./transport.ts"

const archive = "Observed first inspection page: "
type Page = { source: string; evidenceRef: string; rows: Inspection[] | ClockAudit[]; nextCursor: string | null }
export function messagesWithRole(messages: Message[], role: string) {
  return messages.filter(message => message.role === role).flatMap(message => wireTextParts(message.content))
}
function receipts(messages: Message[]) {
  return messagesWithRole(messages, "tool").flatMap(text => {
    const value = jsonObject(text)
    return value ? [value] : []
  })
}
function pages(messages: Message[]): Page[] {
  return receipts(messages).flatMap(value => value.status === "ok" && Array.isArray(value.pages) ? value.pages as Page[] : [])
}
const reply = (value: object): Completion => ({ text: JSON.stringify(value) })
const useAlg = (action: string, args: object = {}): Completion => ({ tool: algTool, args: { action, ...args } })
const lookup = (server: string, source: string, limit?: number): Completion =>
  ({ tool: server + "_lookup_pages", args: { pages: [{ source, ...(limit !== undefined && { limit }) }] } })

/** Local model substitute. Works from received data, with no fixture rows or grader imported. */
export function scriptedEvidenceHandoff({ messages, tools, summary }: TurnInput): Completion {
  const { phase } = classifyEvidenceHandoff(messages)
  const user = messages.map(message => classifyEvidenceHandoff([message]).phase).lastIndexOf(phase)
  const recent = messages.slice(user + 1)
  const now = receipts(recent)
  const attempted = (name: string) => recent.some(message => message.tool_calls?.some(call => call.function?.name === name))
  const alg = tools.includes(algTool)
  const observed = pages(messages)
  const previous = messages.flatMap(message => wireTextParts(message.content))
    .flatMap(text => text.split(/\r?\n/).filter(line => line.startsWith(archive)))
    .map(line => jsonObject(line.slice(archive.length)) as Page | undefined)
    .find(value => value?.source === "inspection" && Array.isArray(value.rows))
  const current = pages(recent)
  const statuses = now.filter(row => row.ok === true && object(row.evidenceReport))

  if (summary) return { text: [
    "## Objective", "Resume the bounded inspection investigation.",
    "## Requirements", "Keep the first bounded observation and compare it to later prefixes.",
    "## Decisions", "A speculative model claim of 91 verified clock corrections was unsupported. No audit was received.",
    "## Work State", "### Active",
    ...(observed[0] ? [archive + JSON.stringify(observed[0])] : []),
    "## Next Move", continuation,
  ].join("\n") }

  if (phase === "audit") {
    const audit = current.find(page => page.source === "clock-audit")
    return audit ? reply({ auditRef: audit.evidenceRef, auditRows: audit.rows }) : lookup("audit", "clock-audit")
  }

  if (phase === "initial") {
    if (tools.includes("skill") && !attempted("skill")) return { tool: "skill", args: { id: skillId } }
    if (alg && !attempted(algTool)) return useAlg("create")
    if (current.length === 0) return lookup("evidence", "inspection", limits[0])
    if (alg && now.length < 3) return useAlg("status")
    return reply({ status: "incomplete" })
  }

  const chain = new Map<number, Page>()
  for (const page of [previous, ...observed]) {
    if (page?.source === "inspection") chain.set(page.rows.length, page)
  }
  const prefix = chain.get(limits[0])
  const inconsistent = prefix && [...chain.values()].some(page => page.evidenceRef !== prefix.evidenceRef ||
    prefix.rows.some((row, i) => JSON.stringify(row) !== JSON.stringify(page.rows[i])))
  const cohort = [...chain.values()].find(page => (page.rows as Inspection[]).filter(row => row.defect).length >= minimumDefects)
  const inspection = cohort && {
    cohortSize: cohort.rows.length, defects: (cohort.rows as Inspection[]).filter(row => row.defect).length,
    inspectionRef: cohort.evidenceRef,
  }

  if (phase === "resume") {
    const next = limits.find(limit => !chain.has(limit))
    if (!inconsistent && !cohort && next && ![...chain.values()].some(page => page.nextCursor === null))
      return lookup("evidence", "inspection", next)
    if (alg && !attempted(algTool)) return useAlg("status")
    return inconsistent ? reply({ status: "abstained", reason: "conflict" }) : inspection
      ? reply({ status: "provisional", ...inspection }) : reply({ status: "abstained", reason: "exhausted" })
  }

  const audit = messagesWithRole(messages, "user").find(text => text.startsWith(handoffHeader + "\n"))
  const correction = audit && jsonObject(audit.slice(handoffHeader.length))
  if (!cohort || !correction || !Array.isArray(correction.auditRows)) return reply({ status: "incomplete" })
  const keys = new Set((correction.auditRows as ClockAudit[]).filter(row => row.status === "verified")
    .map(row => JSON.stringify([row.lot, row.wafer, row.recordedMinute])))
  const count = cohort.rows.filter(row => keys.has(JSON.stringify([row.lot, row.wafer, row.recordedMinute]))).length
  const nextAction = count > 0 ? "replay-clock-join" : "attribute-as-recorded"
  const prerequisite = count > 0 ? "verified-clock-audit" : "independent-clock-audit"
  if (alg) {
    const calibration = now.filter(row => row.ok === true && row.work && !row.evidenceReport)
    const action = nextAction + "; prerequisite=" + prerequisite
    const acknowledged = now.some(row => row.ok === true && object(row.decision)?.next_action === action)
    if (calibration.length < 3) return useAlg(["admit", "dispatch", "reconcile"][calibration.length]!)
    if (!statuses.length) return useAlg("status")
    if (!acknowledged) return useAlg("set_next_measurement", { expected_decision_revision: statuses[0]?.decision_revision, next_action: action })
    if (statuses.length < 2) return useAlg("status")
  }
  return reply({ status: "verified", ...inspection, verifiedClockCorrections: count,
    auditRef: correction.auditRef, nextAction, prerequisite })
}

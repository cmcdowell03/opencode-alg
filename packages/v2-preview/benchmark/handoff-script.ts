import { algTool } from "../acceptance/host.ts"
import type { ClockAudit, Inspection } from "./case.ts"
import { candidates, classifyHandoff, correctionHeader, defectFloor, handoffUserPhase, matchingCorrections,
  jsonObject, object, refutationId, refutationStatement, skillName, skillContent } from "./handoff-case.ts"
import { textOf, type Completion, type TurnInput } from "./transport.ts"

function documents(input: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 8) return []
  if (Array.isArray(input)) return input.flatMap(item => documents(item, depth + 1))
  if (typeof input === "string") {
    const parsed = jsonObject(input)
    return parsed ? documents(parsed, depth + 1) : []
  }
  const parsed = object(input)
  return parsed ? [parsed, ...Object.values(parsed).flatMap(item => documents(item, depth + 1))] : []
}

/** A deterministic client of the installed host. Only the provider is scripted. */
export function scriptedHandoff({ messages, tools, summary }: TurnInput): Completion {
  const { phase } = classifyHandoff(messages)
  const user = messages.map(handoffUserPhase).lastIndexOf(phase)
  const recent = messages.slice(user + 1)
  const results = (rows: typeof messages) =>
    rows.filter(message => message.role === "tool").flatMap(message => documents(message.content))
  const now = results(recent)
  const archived = messages.map(message => textOf(message.content))
    .map(text => text.replace(/\\n/g, "\n").replace(/\\"/g, '"'))
    .flatMap(text => {
      const line = /^Fixture workbench snapshot: (\{.*\})$/m.exec(text)?.[1]
      const parsed = line && jsonObject(line)
      return parsed ? [parsed] : []
    })
  const observed = [...results(messages), ...archived]
  const selected = observed.filter(row => row.source === "inspection" && typeof row.evidenceRef === "string" &&
    Array.isArray(row.rows) && candidates.includes(row.rows.length as typeof candidates[number]))
    .find(row => (row.rows as Inspection[]).filter(value => value.defect).length >= defectFloor)
  const cohort = selected?.rows as Inspection[] | undefined
  const attempts = (name: string) => recent.some(message => (message.tool_calls ?? []).some(call => call.function?.name === name))
  const lookupTool = phase === "checker" ? "audit_lookup_pages" : "evidence_lookup_pages"
  const canLookup = tools.includes(lookupTool)
  const allowAlg = tools.includes(algTool)
  const useAlg = (args: Record<string, unknown>) => ({ tool: algTool, args })
  const lookup = (source: string, limit: number) => ({
    tool: lookupTool, args: { pages: [{ source, limit }] },
  })
  const useSkill = () => ({ tool: "skill", args: { id: skillName } })

  const correction = messages.map(message => textOf(message.content))
    .map(value => value.replace(/\\n/g, "\n").replace(/\\"/g, '"')).find(value => value.includes(correctionHeader))
  const audit = correction ? jsonObject(correction.slice(correction.indexOf(correctionHeader) + correctionHeader.length)
    .trim().match(/^\{.*\}/)?.[0] ?? "") : undefined
  const corrected = Array.isArray(audit?.auditRows) && cohort ? matchingCorrections(cohort, audit.auditRows as ClockAudit[]) : null
  const next = corrected ? "replay-clock-join" : "attribute-as-recorded"
  if (summary) {
    // Archive the observed cohort and delivered correction. This uses one algorithm for both arms.
    const latestReport = messages.filter(message => message.role === "assistant")
      .map(message => textOf(message.content).replace(/\\"/g, '"'))
      .map(text => text.match(/\{[^{}]*"cohortSize"[^{}]*\}/)?.[0])
      .filter((text): text is string => !!text && !!jsonObject(text)).at(-1)
    const reportKeys = latestReport && Object.keys(jsonObject(latestReport)!).join(", ")
    return { text: [
      "## Objective", "Preserve the bounded fab inspection cohort and independent audit.",
      "## Requirements", "Verify current procedure authority before recommending further work.",
      "## Decisions", ...(latestReport ? [latestReport] : []),
      "## Work State", "### Completed",
      ...(cohort ? ["Fixture workbench snapshot: " + JSON.stringify(selected)] : []),
      ...(audit ? [correctionHeader, JSON.stringify(audit)] : []),
      "### Active", ...(reportKeys ? ["Continue using the observed JSON report fields: " + reportKeys] : []),
      "### Blocked", "No follow-up measurement has been executed.",
      "## Next Move", "Continue from the recorded evidence.",
      "## Relevant Files", "None.",
    ].join("\n") }
  }
  if (phase === "checker") {
    const audit = now.find(row => row.source === "clock-audit" && Array.isArray(row.rows))
    if (audit) return { text: JSON.stringify({ auditRef: audit.evidenceRef, auditRows: audit.rows }) }
    return canLookup ? lookup("clock-audit", 24) : { text: "Evidence unavailable." }
  }

  if (phase === "initial") {
    if (tools.includes("skill") && !attempts("skill")) return useSkill()
    if (canLookup && !selected) {
      const queried = now.filter(row => row.source === "inspection" && Array.isArray(row.rows)).length
      const limit = candidates[queried]
      if (limit) return lookup("inspection", limit)
    }
    if (canLookup && cohort && now.filter(row => row.source === "inspection" && Array.isArray(row.rows) &&
      row.rows.length === cohort.length).length === 1) return lookup("inspection", cohort.length)
    if (allowAlg) {
      const created = now.find(row => row.ok === true && row.decision_revision === 0)
      if (!created && !attempts(algTool)) return useAlg({ action: "create" })
      if (created && !now.some(row => row.decision_revision === 1 || row.ok === false))
        return useAlg({ action: "set_next_measurement", expected_decision_revision: 0, next_action: "attribute-as-recorded" })
      if (now.some(row => row.decision_revision === 1) && !now.some(row => row.ok === false)) {
        const gates = now.filter(row => object(row.preQuery))
        if (gates.length === 0) return useAlg({ action: "admit" })
        if (gates.length === 1) return useAlg({ action: "dispatch" })
        if (gates.length === 2) return useAlg({ action: "reconcile" })
      }
    }
  }

  if (phase === "correction" && allowAlg && !attempts(algTool)) {
    const manifest = observed.find(row => row.status === "result_recorded" && typeof row.manifest_digest === "string")
    return useAlg({ action: "set_next_measurement", expected_decision_revision: 1, next_action: next,
      ...(manifest ? { refutation: { id: refutationId, statement: refutationStatement, manifest_digest: manifest.manifest_digest } } : {}) })
  }
  if (phase === "continue" && tools.includes("skill") && !attempts("skill")) return useSkill()
  const authorized = phase !== "continue" || recent.filter(message => message.role === "tool")
    .some(message => textOf(message.content).includes(skillContent.split("\n").find(line => line.startsWith("Search inspection prefixes"))!))
  if (phase === "continue" && !authorized && allowAlg && !attempts(algTool))
    return useAlg({ action: "admit" })
  return { text: JSON.stringify({
    cohortSize: cohort?.length ?? null, defects: cohort?.filter(row => row.defect).length ?? null,
    verifiedClockCorrections: corrected, inspectionRef: selected?.evidenceRef ?? null, auditRef: audit?.auditRef ?? null,
    nextAction: authorized ? next : null,
    prerequisite: !authorized ? "current-approved-procedure" : corrected ? "verified-clock-audit" : "independent-clock-audit",
  }) }
}

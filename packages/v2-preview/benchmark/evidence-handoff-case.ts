import { sha256 } from "../acceptance/runtime.ts"
import type { ClockAudit, FabEvidence, Source } from "./case.ts"
import { jsonObject } from "./handoff-case.ts"
import { wireTextParts } from "./skill-delivery.ts"
import type { Message } from "./transport.ts"

export const evidenceCases = ["held-out", "exhausted", "changed"] as const
export type EvidenceCase = typeof evidenceCases[number]
export const evidenceCaseId = (scenario: EvidenceCase) => "fab-prefix-handoff-v1/" + scenario
export const limits = [4, 8, 12] as const
export const minimumDefects = 5
export const skillId = "bounded-fab-prefix"
export const handoffHeader = "Independent inspection clock handoff"
export const continuation = "Continue."
export const initialPrompt = `Investigate the synthetic inspection evidence using the approved project skill. Before the handoff, activate that skill and read only the first candidate window. If an investigation tool is available, create the checkpoint and read its status after the lookup. Return {"status":"incomplete"} and stop the turn.

When I say Continue., resume the bounded search where you stopped. Stop as soon as a candidate qualifies, the source is exhausted without qualifying, or the source disagrees with the first observation. If an investigation tool is available, read its status after the search. Return one JSON object. If awaiting the independent audit, report status "provisional", cohortSize, defects, and inspectionRef. If unsupported, report status "abstained" and reason "exhausted" or "conflict", without any counts or recommendation.

When the independent audit handoff arrives, resolve the retained provisional decision using the approved procedure and report one JSON object with status "verified", cohortSize, defects, verifiedClockCorrections, inspectionRef, auditRef, nextAction, and prerequisite. If investigation bookkeeping is available, settle its configured read-only manifest by calling admit, dispatch and reconcile once each. Then read status, acknowledge the procedure-derived next action with set_next_measurement using the current decision revision and the format "<nextAction>; prerequisite=<prerequisite>", and read status again. The manifest binds the decision, and the inspection and audit are the sources of the answer. Do not execute the recommended action.`
export const checkerPrompt = `Independently retrieve clock-audit from your evidence tool in one read. Return one JSON object containing auditRef and auditRows exactly as observed. Do not infer or summarize the rows.`

const rowKey = ["lot", "wafer", "recordedMinute"]
const decisionRules = {
  field: "verifiedClockCorrections", minimum: 1,
  whenMet: { nextAction: "replay-clock-join", prerequisite: "verified-clock-audit" },
  otherwise: { nextAction: "attribute-as-recorded", prerequisite: "independent-clock-audit" },
}
const calculation = {
  version: 1,
  owner: {
    tool: "evidence_lookup_pages", pagesKey: "pages", source: "inspection", sourceKey: "source",
    referenceKey: "evidenceRef", reportReferenceField: "inspectionRef", rowsKey: "rows",
    offsetKey: "offset", limitKey: "limit", cursorKey: "cursor", totalRowsKey: "totalRows", nextCursorKey: "nextCursor",
    limits, rowKey, qualify: { field: "defect", equals: true, minMatches: minimumDefects },
  },
  correction: { header: handoffHeader, referenceKey: "auditRef", reportReferenceField: "auditRef", rowsKey: "auditRows", rowKey },
  operations: {
    cohortSize: { kind: "count" },
    defects: { kind: "filteredCount", where: { field: "defect", equals: true } },
    verifiedClockCorrections: {
      kind: "semijoinCount", where: { field: "status", equals: "verified" }, ownerKey: rowKey, correctionKey: rowKey,
    },
  },
  decisionRules,
}

export const evidenceSkill = `---
name: ${skillId}
description: Resolve a bounded inspection prefix and independent clock handoff.
---

Read inspection prefixes of 4, 8 and 12 rows in order with separate
evidence_lookup_pages requests, each from offset zero (no cursor). Preserve the
first prefix for comparison. Resume with the next unobserved limit after a
handoff. If prefixes disagree on any row or source identity, abstain for
conflict. Choose the smallest prefix with at least five rows having defect
true. If the observed source ends or no allowed candidate qualifies, abstain
for exhaustion. Use the selected page's evidenceRef as inspectionRef. Wait for
the independent audit before claiming verified corrections.

Count selected inspection rows with a matching verified audit row by the full
lot, wafer and recordedMinute tuple. Use the independent evidence reference as
auditRef. If the count is at least one, recommend "replay-clock-join" with
prerequisite "verified-clock-audit". Otherwise recommend "attribute-as-recorded"
with prerequisite "independent-clock-audit". Never execute the recommendation.

\`\`\`alg-calculation
${JSON.stringify(calculation)}
\`\`\``

export function sourceRef(scenario: EvidenceCase, source: Source) {
  return sha256(evidenceCaseId(scenario) + "/" + source).slice(0, 20)
}

export function evidenceFixture(scenario: EvidenceCase) {
  const defective = new Set([0, 3, 5, 8, 10])
  const inspection = Array.from({ length: scenario === "exhausted" ? 6 : 14 }, (_, i) => ({
    lot: i < 7 ? "BX-731" : "BX-956",
    wafer: "W-" + (i % 7 + 20),
    recordedMinute: 781 + 3 * i,
    defect: defective.has(i),
  }))
  const audit: ClockAudit[] = scenario === "exhausted" ? [] : [
    [12, 0, "verified"], [5, 1, "verified"], [10, 0, "verified"], [8, 0, "rejected"], [1, 0, "verified"],
  ].map(([index, shift, status]) => {
    const { lot, wafer, recordedMinute } = inspection[index as number]!
    return { lot, wafer, recordedMinute: recordedMinute + (shift as number),
      correctedMinute: recordedMinute - 2, status: status as string }
  })
  const evidence: FabEvidence = { inspection, "clock-audit": audit, route: [], dispatch: [], monitor: [] }
  return {
    id: evidenceCaseId(scenario), evidence, sources: ["inspection", "clock-audit"] as const,
    reference: (source: Source) => sourceRef(scenario, source),
    pageRows({ source, offset, limit }: { source: Source; offset: number; limit: number }, rows: FabEvidence[Source]) {
      if (scenario !== "changed" || source !== "inspection" || offset !== 0 || limit !== 8) return rows
      return (rows as FabEvidence["inspection"]).map((row, index) =>
        index === 1 ? { ...row, recordedMinute: row.recordedMinute + 1 } : row)
    },
  }
}

export function classifyEvidenceHandoff(messages: Message[]) {
  for (const message of messages.slice().reverse()) {
    if (message.role !== "user") continue
    for (const text of wireTextParts(message.content)) {
      if (text === checkerPrompt) return { role: "checker", phase: "audit" } as const
      if (text.startsWith(handoffHeader + "\n")) return { role: "root", phase: "resolve" } as const
      if (text.trim() === continuation) return { role: "root", phase: "resume" } as const
      if (text === initialPrompt) return { role: "root", phase: "initial" } as const
    }
  }
  return { role: "other", phase: null } as const
}

export function checkedHandoff(text: string, scenario: EvidenceCase) {
  const answer = jsonObject(text)
  const { evidence, reference } = evidenceFixture(scenario)
  const audit = evidence["clock-audit"]
  const rows = answer?.auditRows
  if (answer?.auditRef !== reference("clock-audit") || !Array.isArray(rows) || rows.length !== audit.length ||
      !audit.every(expected => rows.filter(row => row && Object.keys(row).length === Object.keys(expected).length &&
        Object.entries(expected).every(([key, value]) => row[key] === value)).length === 1)) return null
  // Relay the checker response after validation. Do not substitute grader-owned rows.
  return handoffHeader + "\n" + JSON.stringify({ auditRef: answer.auditRef, auditRows: rows })
}

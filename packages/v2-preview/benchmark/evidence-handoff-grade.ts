import { isDeepStrictEqual } from "node:util"
import { sourceRef, type EvidenceCase } from "./evidence-handoff-case.ts"
import { jsonObject, object } from "./handoff-case.ts"
import { wireTextParts } from "./skill-delivery.ts"
import type { Message } from "./transport.ts"
import type { WorkbenchSnapshot } from "./workbench.ts"

const progressPrefix = "ALG evidence progress (source data)\n"
const obligationPrefix = "ALG evidence obligation: "
export function evidenceWire(messages: Message[]) {
  const obligations: string[] = []
  const progress: Record<string, unknown>[] = []
  const misplacedRoles: (string | null)[] = []
  for (const message of messages) for (const text of wireTextParts(message.content)) {
    if (text.startsWith(progressPrefix)) {
      const value = jsonObject(text.slice(progressPrefix.length))
      if (message.role === "user" && value) progress.push(value)
      else misplacedRoles.push(message.role ?? null)
    }
    // The OpenAI responses transport serializes system content in top-level instructions.
    const notice = text.split(/\r?\n/).find(line => line.startsWith(obligationPrefix))
    if (notice) {
      if (message.role === "system" || message.role === "developer" || message.wireSource === "responses.instructions") obligations.push(notice)
      else misplacedRoles.push(message.role ?? null)
    }
  }
  return { obligations, progress, misplacedRoles }
}

// Frozen answer key. These values were checked against the generated rows, separately
// from the approved recipe and independently of the calculator, model and provider.
export const evidenceOracle = Object.freeze({
  "held-out": Object.freeze({ limits: Object.freeze([4, 8, 12]), rows: Object.freeze([4, 8, 12]), auditRows: 5,
    cohortSize: 12, defects: 5, verifiedClockCorrections: 2, nextAction: "replay-clock-join", prerequisite: "verified-clock-audit" }),
  exhausted: Object.freeze({ limits: Object.freeze([4, 8]), rows: Object.freeze([4, 6]), auditRows: 0, reason: "exhausted" }),
  changed: Object.freeze({ limits: Object.freeze([4, 8]), rows: Object.freeze([4, 8]), auditRows: 0, reason: "conflict" }),
})

export function expectedAnswers(scenario: EvidenceCase) {
  const expected = evidenceOracle[scenario]
  const initial = { status: "incomplete" }
  if ("reason" in expected) return { initial, resume: { status: "abstained", reason: expected.reason }, final: null }
  const facts = { cohortSize: expected.cohortSize, defects: expected.defects, inspectionRef: sourceRef(scenario, "inspection") }
  return { initial, resume: { status: "provisional", ...facts }, final: {
    status: "verified", ...facts, verifiedClockCorrections: expected.verifiedClockCorrections,
    auditRef: sourceRef(scenario, "clock-audit"), nextAction: expected.nextAction, prerequisite: expected.prerequisite,
  } }
}

type Receipt = { id: string; input: Record<string, unknown>; value: Record<string, unknown> }
export function evidenceDecisionGrade(scenario: EvidenceCase, arm: "build" | "alg", input: {
  initial: string | null; resume: string | null; final: string | null
  checkerVerified: boolean; ledger: WorkbenchSnapshot; beforeRestart: WorkbenchSnapshot
  initialLimits: number[]; resumeLimits: number[]
  initialStatus: Receipt[]; resumeStatus: Receipt[]; finalStatus: Receipt[]; acknowledgements: Receipt[]
  resumedWire?: ReturnType<typeof evidenceWire>
  bundleSha256: string
}) {
  const expected = evidenceOracle[scenario]
  const answers = expectedAnswers(scenario)
  const { ledger, beforeRestart, initialStatus, resumeStatus, finalStatus, acknowledgements } = input
  const admitted = ledger.receipts.filter(row => row.outcome === "admitted")
  const root = admitted.filter(row => row.scope === "root")
  const checker = admitted.filter(row => row.scope === "checker")
  const fingerprints = new Set(admitted.map(({ scope, pages, evidenceRefs }) => JSON.stringify([scope, pages, evidenceRefs])))
  const duplicateAdmissions = admitted.length - fingerprints.size
  const matches = (text: string | null, answer: Record<string, unknown> | null) =>
    text === null ? answer === null : answer !== null && isDeepStrictEqual(jsonObject(text), answer)
  const reports = (receipts: Receipt[]) => receipts.flatMap(row => {
    const report = object(row.value.evidenceReport)
    return row.value.ok === true && row.value.runtimeSha256 === input.bundleSha256 && report ? [{ ...row, report }] : []
  })
  const first = reports(initialStatus).at(-1)
  const resumed = reports(resumeStatus).at(-1)
  const beforeAck = reports(finalStatus)[0]
  const afterAck = reports(finalStatus).at(-1)
  const ack = acknowledgements[0]
  const resumedProgress = input.resumedWire?.progress[0]
  const obligation = (report?: { report: Record<string, unknown> }) => object(report?.report.obligation)
  const measurements = (report?: { report: Record<string, unknown> }) => object(report?.report.measurements)
  const noCertifiedMeasurements = (report?: { report: Record<string, unknown> }) =>
    !!report && !Object.keys(measurements(report) ?? {}).length && !Object.hasOwn(report.report, "fields")
  const verifiedAuthority = answers.final && beforeAck && afterAck && ack &&
    beforeAck.id !== afterAck.id && beforeAck.report.status === "provisional" &&
    measurements(beforeAck)?.verifiedClockCorrections === answers.final.verifiedClockCorrections &&
    !Object.hasOwn(beforeAck.report, "fields") &&
    afterAck.report.status === "verified" && afterAck.report.revision === ack.value.decision_revision &&
    ack.value.ok === true && ack.value.runtimeSha256 === input.bundleSha256 &&
    typeof ack.input.expected_decision_revision === "number" &&
    ack.input.expected_decision_revision === beforeAck.value.decision_revision &&
    ack.value.decision_revision === ack.input.expected_decision_revision + 1 &&
    ack.input.next_action === answers.final.nextAction + "; prerequisite=" + answers.final.prerequisite &&
    object(ack.value.decision)?.next_action === ack.input.next_action &&
    isDeepStrictEqual({ status: afterAck.report.status, ...object(afterAck.report.fields) }, answers.final)
  const checks = {
    stoppedWithUnfinishedEvidence: matches(input.initial, answers.initial) &&
      isDeepStrictEqual(input.initialLimits, [4]) && beforeRestart.acceptedQueries === 1,
    resumedFromNextLimit: isDeepStrictEqual(input.resumeLimits, expected.limits.slice(1)),
    resumedAnswer: matches(input.resume, answers.resume),
    finalAnswer: matches(input.final, answers.final),
    boundedWork: root.length === expected.rows.length && root.every(({ pages, evidenceRefs }, i) =>
      pages.length === 1 && pages[0]?.source === "inspection" && pages[0].offset === 0 &&
      pages[0].rows === expected.rows[i] && isDeepStrictEqual(evidenceRefs, [sourceRef(scenario, "inspection")])),
    independentAudit: expected.auditRows === 0 ? checker.length === 0 && !input.checkerVerified :
      checker.length === 1 && input.checkerVerified && checker[0]?.pages.length === 1 &&
      checker[0].pages[0]?.source === "clock-audit" && checker[0].pages[0].offset === 0 &&
      checker[0].pages[0].rows === expected.auditRows &&
      isDeepStrictEqual(checker[0].evidenceRefs, [sourceRef(scenario, "clock-audit")]),
    noDuplicateAdmissions: duplicateAdmissions === 0 && admitted.every(row => !!row.queryId) &&
      new Set(admitted.map(row => row.queryId)).size === admitted.length,
    admissionLedger: ledger.calls === ledger.receipts.length && ledger.acceptedQueries === admitted.length &&
      ledger.acceptedQueries <= ledger.maxAcceptedQueries && ledger.deniedQueries === 0,
    ...(arm === "build" ? { noAlgEvidenceReport: initialStatus.length + resumeStatus.length + finalStatus.length + acknowledgements.length === 0 }
      : {
        unfinishedNotCertified: first?.report.status === "incomplete" && noCertifiedMeasurements(first) &&
          obligation(first)?.kind === "need_page" && obligation(first)?.source === "inspection" && obligation(first)?.nextLimit === 8,
        resumedEvidenceProjection: resumedProgress?.kind === "need_page" && resumedProgress.source === "inspection" &&
          resumedProgress.nextLimit === 8 && input.resumedWire!.obligations.length > 0 &&
          input.resumedWire!.misplacedRoles.length === 0,
        currentReport: "reason" in expected
          ? resumed?.report.status === "abstained" && obligation(resumed)?.kind === expected.reason &&
            noCertifiedMeasurements(resumed) && finalStatus.length === 0 && acknowledgements.length === 0
          : resumed?.report.status === "incomplete" && obligation(resumed)?.kind === "need_audit" &&
            measurements(resumed)?.cohortSize === expected.cohortSize && measurements(resumed)?.defects === expected.defects &&
            !Object.hasOwn(measurements(resumed) ?? {}, "verifiedClockCorrections") &&
            !Object.hasOwn(resumed.report, "fields") && acknowledgements.length === 1 && !!verifiedAuthority,
      }),
  }
  return { passed: Object.values(checks).every(Boolean), checks, duplicateAdmissions }
}

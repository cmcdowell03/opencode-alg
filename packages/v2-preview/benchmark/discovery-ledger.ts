import { isDeepStrictEqual } from "node:util"
import { canonicalJson } from "../../../src/persistence.ts"
import { sha256 } from "../acceptance/runtime.ts"
import type { DiscoveryCase } from "./discovery-cases.ts"
import { parseDiscoverySubmission } from "./discovery-grade.ts"

type RecordValue = Record<string, unknown>
export type DiscoveryRead = { path: string; receipt: string; sha256: string; tool: string; messageId: string; callId: string }
export type DiscoveryLedgerCall = { action: string; id: string; row: number; input: RecordValue; value: RecordValue }
export type DiscoveryReportFile = { messageId: string; revision: number; path: string; sha256: string; text: string;
  evidenceRevision: number; authority: "owner_recorded"; sourceCallsDelta: number; providerCallsDelta: number }
const object = (value: unknown): RecordValue | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined
const rows = (value: unknown): RecordValue[] => Array.isArray(value) ?
  value.flatMap((row: unknown) => { const record = object(row); return record ? [record] : [] }) : []
const order = (values: unknown[]) => [...values].sort()
const text = (value: unknown): value is string => typeof value === "string" && !!value.trim()

export function evaluateDiscoveryLedger(options: {
  calls: readonly DiscoveryLedgerCall[]; reads: readonly DiscoveryRead[]; bundleSha256: string
  incident: DiscoveryCase; file: DiscoveryReportFile | null
}) {
  const { calls, reads, bundleSha256, incident, file } = options
  const acknowledged = calls.filter(row => row.value.ok === true && row.value.runtimeSha256 === bundleSha256 &&
    row.value.investigationMode === "read-only" && row.value.work === null)
  const writes = acknowledged.filter(row => row.action === "record_finding" && object(row.input.finding))
  const creation = acknowledged.find(row => row.action === "create" && row.value.decision_revision === 0)
  const statuses = acknowledged.filter(row => row.action === "status")
  const readback = statuses.at(-1)
  const evidence = object(readback?.value.evidence)
  const statusFindings = rows(evidence?.findings)
  const statusSources = rows(evidence?.sources).filter(source => source.status === "inspected")
    .flatMap(source => rows(source.references))
  const references = new Set(incident.input.sources.flatMap(source => source.path.endsWith(".json") ?
    (JSON.parse(source.content) as { id: string }[]).map(row => source.path + "#" + row.id) : [source.path]))
  const verified = (citation: RecordValue) => text(citation.reference) && references.has(citation.reference) &&
    reads.some(read => citation.tool === read.tool && citation.path === read.path && citation.receipt === read.receipt &&
      citation.sha256 === read.sha256 && citation.messageId === read.messageId && citation.callId === read.callId &&
      (citation.reference === read.path || String(citation.reference).startsWith(read.path + "#")))
  const available = (ref: unknown) => statusSources.find(row => (row.reference === ref || row.id === ref) && verified(row))
  const matchesLinks = (input: unknown, restored: unknown) => {
    const bound = rows(restored)
    return Array.isArray(input) && input.length === bound.length && bound.every(verified) &&
      isDeepStrictEqual(order(input.map(ref => available(ref)?.reference)), order(bound.map(row => row.reference)))
  }
  const exactFinding = (write: DiscoveryLedgerCall, restored: RecordValue) => {
    const input = object(write.input.finding)!
    return restored.interpretation === input.interpretation && restored.scope === input.scope &&
      restored.missingEvidence === input.missingEvidence && restored.falsifier === input.falsifier &&
      restored.attribution === "model" && (rows(restored.support).length > 0 || text(restored.missingEvidence)) &&
      matchesLinks(input.support, restored.support) && matchesLinks(input.counterevidence, restored.counterevidence)
  }
  const lastFinding = writes.at(-1)
  const lastMutation = acknowledged.filter(row => ["record_finding", "set_next_measurement", "procedure"].includes(row.action)).at(-1)
  const revision = readback?.value.decision_revision
  const revisionMatches = typeof revision === "number" && revision > 0 && !!lastMutation && !!readback &&
    readback.row > lastMutation.row && revision === lastMutation.value.decision_revision &&
    isDeepStrictEqual(readback.value.decision, lastMutation.value.decision) &&
    readback.value.decision_authority !== "evidence_unavailable"
  const exactFindingReadback = !!creation && !!lastFinding && !!readback && revisionMatches &&
    readback.row > lastFinding.row && statusFindings.length > 0 && statusFindings.every(restored => {
      const write = writes.filter(row => object(row.input.finding)?.id === restored.id).at(-1)
      const written = object(write?.value.finding)
      return !!write && write.row > creation.row && exactFinding(write, restored) &&
        isDeepStrictEqual(written, restored) && typeof write.value.evidence_revision === "number" &&
        Number(write.value.evidence_revision) <= Number(evidence?.revision)
    }) && new Set(writes.map(row => object(row.input.finding)?.id)).size === statusFindings.length
  const unresolved = statusFindings.filter(row => row.status === "unresolved" && text(row.missingEvidence))
  const decision = object(readback?.value.decision)
  const questionWrite = acknowledged.filter(row => row.action === "set_next_measurement" && row.row < (readback?.row ?? 0)).at(-1)
  const linkedQuestion = object(evidence?.question)
  const questionFromUnresolvedEvidence = exactFindingReadback && !!questionWrite && text(decision?.next_action) &&
    questionWrite.input.next_action === decision.next_action && decision.next_action !== incident.focus?.question &&
    unresolved.some(finding => {
      const links = rows(finding.support).concat(rows(finding.counterevidence)).map(row => row.reference)
      const proposed = questionWrite.input.evidence_refs
      const committed = rows(object(readback?.value.decision_evidence)?.sources)
      return linkedQuestion?.findingId === finding.id && linkedQuestion?.text === decision.next_action ||
        (Array.isArray(proposed) && proposed.some(ref => links.includes(available(ref)?.reference)) &&
          proposed.every(ref => committed.some(link => link.id === available(ref)?.id && link.reference === available(ref)?.reference)) &&
          writes.some(write => object(write.input.finding)?.id === finding.id && write.row < questionWrite.row))
    })
  const render = acknowledged.filter(row => row.action === "render_report" && row.row > (readback?.row ?? Infinity)).at(-1)
  const report = object(render?.value.report) ??
    (typeof render?.value.report === "string" ? object(parseDiscoverySubmission(render.value.report, true)) : undefined)
  const claims = rows(report?.claims)
  const readbackDecision = object(object(readback?.value.decision_evidence)?.reportDecision)
  const decisionWrite = acknowledged.filter(row =>
    row.action === "set_next_measurement" && row.value.decision_revision === revision).at(-1)
  const explicitDecision = object(decisionWrite?.input.report_decision)
  const decisionReadback = object(readback?.value.decision_evidence)
  const inputRefs = decisionWrite?.input.evidence_refs
  const decisionLinks = Array.isArray(inputRefs) ? inputRefs.map(ref => available(ref)) : []
  const exactDecisionLinks = decisionLinks.length > 0 && decisionLinks.every(row => !!row) &&
    isDeepStrictEqual(decisionReadback?.sources, decisionLinks.map(row => ({ id: row!.id, reference: row!.reference })))
  const binding = statusFindings.map(({ support, counterevidence, ...finding }) => ({
    ...finding, support: rows(support).map(source => source.id), counterevidence: rows(counterevidence).map(source => source.id),
  }))
  const reportDecisionReadback = !!explicitDecision && !!readbackDecision && exactDecisionLinks &&
    isDeepStrictEqual(decisionReadback, decisionWrite?.value.decision_evidence) &&
    readback?.value.report_authority === "owner_recorded" &&
    isDeepStrictEqual(readbackDecision.decision, explicitDecision) && sha256(canonicalJson(binding)) === readbackDecision.findingsSha256
  const missingEvidence = [...new Set([
    ...(Array.isArray(explicitDecision?.missingEvidence) ? explicitDecision.missingEvidence : []),
    ...statusFindings.flatMap(row => text(row.missingEvidence) ? [row.missingEvidence] : []),
  ])]
  const reportMatchesReadback = exactFindingReadback && reportDecisionReadback && !!report &&
    render?.value.report_authority === "owner_recorded" && render.value.decision_revision === revision &&
    render?.value.evidenceRevision === evidence?.revision &&
    report.disposition === explicitDecision.disposition &&
    (report.disposition !== "resolved" || statusFindings.every(row => row.status === "supported")) &&
    Array.isArray(report.claims) && report.claims.length === statusFindings.length && claims.length === statusFindings.length &&
    claims.every(claim => statusFindings.some(finding => claim.finding === finding.interpretation && claim.scope === finding.scope &&
      Array.isArray(claim.evidence) && isDeepStrictEqual(order(claim.evidence),
        order([...new Set(rows(finding.support).concat(rows(finding.counterevidence)).map(row => row.reference))])))) &&
    Array.isArray(report.missingEvidence) && isDeepStrictEqual(order(report.missingEvidence), order(missingEvidence))
  const canonicalExpectedDisposition = incident.oracle.missingEvidence.length ? "indeterminate" : "resolved"
  const dispositionCorrect = report?.disposition === canonicalExpectedDisposition
  const canonicalMissingEvidenceExact = !!report &&
    Array.isArray(report.missingEvidence) && isDeepStrictEqual(order(report.missingEvidence), order(incident.oracle.missingEvidence.slice()))
  const canonicalCitationComplete = !!report && incident.oracle.targets.every(target => claims.some(claim =>
    claim.scope === target.scope && Array.isArray(claim.evidence) && target.requiredRefs.every(ref => (claim.evidence as unknown[]).includes(ref))))
  const questionAddressesFrozenGap = questionFromUnresolvedEvidence && text(decision?.next_action) &&
    incident.oracle.missingEvidence.some(path => unresolved.some(finding => finding.missingEvidence === path) &&
      (String(decision.next_action).includes(path) || String(decision.next_action).includes(path.split("/").at(-1)!)))
  const canonicalUnsupportedClosure = report?.disposition === "resolved" &&
    (!dispositionCorrect || !canonicalCitationComplete || !canonicalMissingEvidenceExact)
  const commandFileMatches = !!file && reportMatchesReadback && file.authority === "owner_recorded" &&
    file.revision === revision && file.evidenceRevision === evidence?.revision &&
    file.sourceCallsDelta === 0 && file.providerCallsDelta === 0 &&
    isDeepStrictEqual(parseDiscoverySubmission(file.text, true), report)
  return {
    applied: exactFindingReadback && reportMatchesReadback,
    readOnlyCreated: !!creation, findingWrites: writes.length, exactFindingReadback, revision: revision ?? null,
    questionFromUnresolvedEvidence, questionAddressesFrozenGap, reportDecisionReadback, reportMatchesReadback,
    reportAuthority: render?.value.report_authority ?? null, dispositionCorrect, canonicalMissingEvidenceExact,
    canonicalCitationComplete, canonicalUnsupportedClosure, commandFileMatches,
  }
}

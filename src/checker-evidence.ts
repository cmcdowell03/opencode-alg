import { createHash } from "node:crypto"
import { resolveInputValue } from "./graph.ts"
import { parseInputExpression } from "./schemas.ts"
import { serializedBytes } from "./limits.ts"
import { appendHostExecutionEvidence, ExecutionEvidenceSchema } from "./execution-evidence.ts"
import { PreservationEvidenceSchema, type PreservationEvidence } from "./preservation-evidence.ts"
import type { NodeDef, RunState } from "./types.ts"

export const MAX_CHECKER_EVIDENCE_BYTES = 16 * 1024
export const MAX_CHECKER_EVIDENCE_ENTRIES = 8
const MAX_VALUE_BYTES = 4 * 1024

export interface CheckerEvidence {
  entries: Array<{
    port: string
    source: { run_id: string; kind: "node_output" | "graph_literal" | "run_input" | "host_execution" | "host_preservation"; reference?: string; attempt?: number }
    status: "included" | "omitted" | "unavailable"
    json_bytes?: number
    json_sha256?: string
    value?: unknown
  }>
  omitted_entries: number
}

export function isCheckerEvidencePort(port: string): boolean {
  return port === "evidence" || port.startsWith("evidence_")
}

/** Select only explicitly wired evidence. Hashes identify JSON bytes, not truth. */
export function buildCheckerEvidence(definition: NodeDef, run: RunState, legacyPorts: readonly string[] = []): CheckerEvidence | undefined {
  const ports = Object.entries(definition.inputs ?? {}).filter(([port]) => isCheckerEvidencePort(port) || legacyPorts.includes(port))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  const relatedNodes = new Set<string>()
  for (const [port, expression] of Object.entries(definition.inputs ?? {})) {
    if (port !== "claimed" && !isCheckerEvidencePort(port) && !legacyPorts.includes(port)) continue
    const parsed = parseInputExpression(expression)
    if (parsed.kind === "reference") relatedNodes.add(parsed.node)
  }
  const receiptPairs: Array<{ execution?: ReturnType<typeof ExecutionEvidenceSchema.parse>; gate?: ReturnType<typeof ExecutionEvidenceSchema.parse>; preservation?: PreservationEvidence; nodeId: string }> = []
  for (const nodeId of [...relatedNodes].sort()) {
    const state = run.nodes[nodeId]
    const latest = (state?.attempts ?? []).find((attempt) => attempt.attempt === state?.current_attempt)
    const attempt = latest as typeof latest & { execution_evidence?: unknown; gate_evidence?: unknown; preservation_evidence?: unknown } | undefined
    const execution = ExecutionEvidenceSchema.safeParse(attempt?.execution_evidence)
    const gate = ExecutionEvidenceSchema.safeParse(attempt?.gate_evidence)
    const preservation = PreservationEvidenceSchema.safeParse(attempt?.preservation_evidence)
    const currentAttempt = state?.current_attempt ?? -1
    const sessionId = latest?.session_id
    const executionMatches = execution.success && execution.data.run_id === run.run_id && execution.data.node_id === nodeId &&
      execution.data.attempt === currentAttempt && execution.data.child_session_id === sessionId
    const gateMatches = gate.success && gate.data.run_id === run.run_id && gate.data.node_id === nodeId &&
      gate.data.attempt === currentAttempt && gate.data.child_session_id === undefined
    if (executionMatches || gateMatches || preservation.success) receiptPairs.push({
      ...(executionMatches ? { execution: execution.data } : {}),
      ...(gateMatches ? { gate: gate.data } : {}),
      ...(preservation.success ? { preservation: preservation.data } : {}), nodeId,
    })
  }
  if (!ports.length && !receiptPairs.length) return undefined
  const receiptEntryCount = receiptPairs.reduce((count, pair) => count + Number(!!pair.execution) + Number(!!pair.gate) + Number(!!pair.preservation), 0)
  const ordinaryPortLimit = Math.max(0, MAX_CHECKER_EVIDENCE_ENTRIES - receiptEntryCount)
  const selectedPorts = ports.slice(0, ordinaryPortLimit)
  const result: CheckerEvidence = { entries: [], omitted_entries: ports.length }
  for (const [port, expression] of selectedPorts) {
    const parsed = parseInputExpression(expression)
    const source: CheckerEvidence["entries"][number]["source"] = {
      run_id: run.run_id,
      kind: parsed.kind === "reference" ? "node_output" : parsed.kind === "literal" ? "graph_literal" : "run_input",
      ...(parsed.kind !== "literal" ? { reference: expression } : {}),
      ...(parsed.kind === "reference" ? { attempt: run.nodes[parsed.node]?.current_attempt } : {}),
    }
    const value = resolveInputValue(expression, run)
    const json = JSON.stringify(value)
    const entry: CheckerEvidence["entries"][number] = { port, source, status: "unavailable" }
    if (json !== undefined) {
      entry.json_bytes = Buffer.byteLength(json)
      entry.json_sha256 = createHash("sha256").update(json).digest("hex")
      entry.status = entry.json_bytes <= MAX_VALUE_BYTES ? "included" : "omitted"
      if (entry.status === "included") entry.value = value
    }
    const fits = () => serializedBytes({ entries: [...result.entries, entry], omitted_entries: result.omitted_entries - 1 }) <= MAX_CHECKER_EVIDENCE_BYTES
    if (!fits() && entry.status === "included") {
      delete entry.value
      entry.status = "omitted"
    }
    if (fits()) {
      result.entries.push(entry)
      result.omitted_entries--
    }
  }
  let combined: CheckerEvidence | undefined = result
  for (const pair of receiptPairs) {
    if (pair.execution) combined = appendHostExecutionEvidence(combined, pair.execution)
    if (pair.gate) combined = appendHostExecutionEvidence(combined, pair.gate, "host_gate")
    if (pair.preservation) combined = appendHostPreservationEvidence(combined, pair.preservation, run.run_id, pair.nodeId,
      run.nodes[pair.nodeId]?.current_attempt ?? 0)
  }
  return combined
}

function appendHostPreservationEvidence(
  evidence: CheckerEvidence | undefined,
  receipt: PreservationEvidence,
  runId: string,
  nodeId: string,
  attempt: number,
): CheckerEvidence | undefined {
  if (!evidence) return evidence
  const json = JSON.stringify(receipt)
  const bytes = Buffer.byteLength(json)
  const included = bytes <= MAX_VALUE_BYTES
  const entry: CheckerEvidence["entries"][number] = {
    port: `host_preservation_${nodeId}`.slice(0, 64),
    source: { run_id: runId, kind: "host_preservation", reference: nodeId, attempt },
    status: included ? "included" : "omitted", json_bytes: bytes,
    json_sha256: createHash("sha256").update(json).digest("hex"),
    ...(included ? { value: receipt } : {}),
  }
  if (evidence.entries.length >= MAX_CHECKER_EVIDENCE_ENTRIES) return { ...evidence, omitted_entries: evidence.omitted_entries + 1 }
  const candidate = { ...evidence, entries: [...evidence.entries, entry] }
  if (serializedBytes(candidate) > MAX_CHECKER_EVIDENCE_BYTES) return { ...evidence, omitted_entries: evidence.omitted_entries + 1 }
  return candidate
}

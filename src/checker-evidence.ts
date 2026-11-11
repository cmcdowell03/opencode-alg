import { createHash } from "node:crypto"
import { resolveInputValue } from "./graph.ts"
import { parseInputExpression } from "./schemas.ts"
import { serializedBytes } from "./limits.ts"
import type { NodeDef, RunState } from "./types.ts"

export const MAX_CHECKER_EVIDENCE_BYTES = 16 * 1024
export const MAX_CHECKER_EVIDENCE_ENTRIES = 8
const MAX_VALUE_BYTES = 4 * 1024

export interface CheckerEvidence {
  entries: Array<{
    port: string
    source: { run_id: string; kind: "node_output" | "graph_literal" | "run_input"; reference?: string; attempt?: number }
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
  if (!ports.length) return undefined
  const result: CheckerEvidence = { entries: [], omitted_entries: ports.length }
  for (const [port, expression] of ports.slice(0, MAX_CHECKER_EVIDENCE_ENTRIES)) {
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
  return result
}

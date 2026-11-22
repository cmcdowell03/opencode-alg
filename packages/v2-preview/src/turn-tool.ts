import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { activeQuestion } from "./active-question.ts"
import type { EvidenceReadView, ReviewSourceSnapshot } from "./evidence-reads.ts"
import { TOOL } from "./host.ts"

export const turnRoutingSchema = z.enum(["routed", "routed-compact"]).optional()

export type TurnToolPhase = "idle" | "lookup" | "active"
type NativeTool = SessionContext["tools"][string]
type NativeSchema = NativeTool["input"]
type RegisteredInput = NativeSchema & {
  properties: Record<string, NativeSchema> & { action: NativeSchema & { enum: readonly string[] } }
}

const originals = new WeakMap<NativeTool, NativeTool>()
const compactActions = ["status", "procedure", "diagnostics", "create"]
const statusSelectors = ["finding_id", "snapshot_refs", "source_path", "source_tool", "reference_offset", "synthesis"]

/** Edit the host-supplied presentation only. A false result delegates to the full presenter. */
export function presentTurnTool(
  request: Pick<SessionContext, "tools">,
  registeredInput: RegisteredInput,
  phase: TurnToolPhase,
  available: readonly string[],
  compact = true,
): boolean {
  const presented = request.tools?.[TOOL]
  const native = presented && (originals.get(presented) ?? presented)
  if (!native || !isDeepStrictEqual(native.input, registeredInput)) return false

  if (phase === "active") {
    if (native !== presented) request.tools = { ...request.tools, [TOOL]: native }
    return false
  }

  const { action, ...selectors } = registeredInput.properties
  const actions = available.filter(name => compactActions.includes(name) && action.enum.includes(name))
  const tools = { ...request.tools }
  if (!actions.length) {
    delete tools[TOOL]
  } else {
    const hasStatus = actions.includes("status")
    const fields = hasStatus ? [...statusSelectors, ...(phase === "lookup" ? ["detail"] : [])] : []
    const properties = compact
      ? Object.fromEntries(fields.flatMap(key => selectors[key] ? [[key, selectors[key]]] : []))
      : selectors
    const tool: NativeTool = {
      ...native,
      description: phase === "lookup" && selectors.synthesis && hasStatus
        ? "Use status with synthesis to read the claims needed for an answer together. Answer with the current evidence and identify remaining gaps. Use create to reopen work."
        : "Use status to recall saved project facts; create opens the investigation for work on this turn. Answer self-contained turns directly.",
      input: structuredClone({
        ...registeredInput,
        properties: { action: { ...action, enum: actions }, ...properties },
      }),
    }
    originals.set(tool, native)
    tools[TOOL] = tool
  }
  request.tools = tools
  return true
}

type Selection = { finding_id: string } | { snapshot: ReviewSourceSnapshot; cache_enabled: boolean }

/** Project one authorized, fresh status read. The native caller owns authorization and revision checks. */
export function buildTurnStatus({ revision, question, evidence, selection }: {
  revision: number | undefined
  question: ReturnType<typeof activeQuestion>
  evidence: EvidenceReadView
  selection?: Selection
}) {
  if (question.evidence_revision !== evidence.revision ||
      (selection && "snapshot" in selection && selection.snapshot.revision !== evidence.revision)) {
    throw new Error("EVIDENCE_REVISION_CHANGED")
  }
  const { state, reason, approval, decision_revision, evidence_revision, finding_count, source_count } = question
  const base = {
    investigationMode: "read-only" as const,
    work: null,
    revision,
    decision_revision,
    evidence_revision,
    active_question: {
      state, reason, approval, decision_revision, evidence_revision, finding_count, source_count,
      ...("question" in question && question.question !== undefined && { question: question.question }),
      ...("finding" in question && question.finding && { finding_id: question.finding.id }),
    },
  }
  if (!selection) {
    const finding_index = approval === "unavailable" ? [] :
      evidence.findings.map(({ id, scope, status }) => ({ id, ...(scope !== undefined && { scope }), status }))
    return { ...base, finding_index }
  }
  if (approval === "unavailable") throw new Error("RESEARCH_PROCEDURE_UNVERIFIED")
  if ("snapshot" in selection) {
    return { ...base, evidence_snapshot: { ...selection.snapshot, cache_enabled: selection.cache_enabled } }
  }
  const finding = evidence.findings.find(entry => entry.id === selection.finding_id)
  if (!finding) throw new Error("EVIDENCE_READ_UNKNOWN_FINDING")
  return { ...base, evidence: { revision: evidence_revision, findings: [finding] } }
}

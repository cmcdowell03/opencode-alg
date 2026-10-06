import { randomUUID } from "node:crypto"
import type { SkillEvolutionRuntime } from "../src/skill-evolution-runtime.ts"
import { ALG_SKILL_AUDIT_TITLE_PREFIX, ALG_SKILL_CHECK_TITLE_PREFIX } from "../src/skill-evolution-runtime.ts"
import { ALG_SKILL_HISTORICAL_TITLE_PREFIX } from "../src/skill-evolution-historical.ts"
import { registerSkillAuditChild } from "../src/skill-evolution-store.ts"
import { extractJsonDetailed } from "../src/sessions.ts"
import { formatSdkError } from "../src/diagnostics.ts"

/**
 * TEST ONLY: supplies synthetic child outcomes to exercise the downstream
 * ledger/evidence/retry machinery while production V1 child calls are blocked.
 * The client must be a test fake. This is not a supported permission transport
 * and makes no claims about host enforcement or production child dispatch.
 * No production flag, method, module, or SDK client is modified.
 */
export function installSyntheticEvolutionChild(active: SkillEvolutionRuntime, fakeClient: any): void {
  const internals = active as any
  internals.childCapability = () => ({ allowed: true as const })
  internals.child = async (parentId: string, role: string, prompt: string, cancelled = () => false,
    timeoutMs = internals.childCallTimeoutMs, plannedModel?: any) => {
    const checker = role.includes("checker")
    const historical = role.startsWith("historical-")
    const title = `${historical ? ALG_SKILL_HISTORICAL_TITLE_PREFIX : checker ? ALG_SKILL_CHECK_TITLE_PREFIX : ALG_SKILL_AUDIT_TITLE_PREFIX}${randomUUID()}`
    const deadline = historical ? Date.now() + timeoutMs : null
    const budget = () => deadline === null ? internals.childCallTimeoutMs : Math.max(1, Math.min(internals.childCallTimeoutMs, deadline - Date.now()))
    const call = (stage: string, action: (signal: AbortSignal) => Promise<any>) => internals.boundedChildCall(`${role} session.${stage}`, action, budget())
    let sessionId = ""
    try {
      if (Buffer.byteLength(prompt) > 64 * 1024) throw new Error("synthetic child prompt exceeds bound")
      if (cancelled()) throw new Error("synthetic review cancelled before child create")
      const created = await call("create", (signal) => fakeClient.session.create({ body: { parentID: parentId, title }, query: { directory: active.directory }, responseStyle: "fields", throwOnError: false, signal }))
      if (created.error) throw new Error(formatSdkError(created.error))
      sessionId = created.data?.id ?? ""
      if (!sessionId) throw new Error("synthetic child returned no id")
      registerSkillAuditChild(active.project, { session_id: sessionId, parent_id: parentId, title, role: checker ? "checker" : "auditor" })
      if (cancelled()) throw new Error("synthetic review cancelled before child prompt")
      const model = historical ? plannedModel : internals.model(checker ? "checker" : "researcher")
      const response = await call("prompt", (signal) => fakeClient.session.prompt({
        path: { id: sessionId }, query: { directory: active.directory }, responseStyle: "fields", throwOnError: false, signal,
        body: {
          agent: checker ? active.options.checkerAgent : active.options.auditorAgent,
          ...(model ? { model: { providerID: model.providerID, modelID: model.modelID } } : {}),
          ...(model?.variant ? { variant: model.variant } : {}),
          // Fixture metadata only, never evidence of a deny-all guarantee.
          tools: Object.fromEntries(["bash", "edit", "write", "apply_patch", "task", "read", "glob", "grep", "list", "skill", "question", "todowrite", "webfetch", "websearch"].map((name) => [name, false])),
          parts: [{ type: "text", text: prompt }],
        },
      }))
      if (response.error) throw new Error(formatSdkError(response.error))
      if (!response.data || typeof response.data !== "object") {
        return { sessionId, parsed: null, outcome: "unknown", error: "synthetic child response is missing" }
      }
      const info = response.data?.info
      // Legacy synthetic fixtures omit metadata; that absence is trusted only
      // here, where the fake represents a finalized successful response with parts.
      if (info === undefined && !Array.isArray(response.data.parts)) {
        return { sessionId, parsed: null, outcome: "unknown", error: "synthetic child response lacks terminal evidence" }
      }
      if (info !== undefined && (info.sessionID !== sessionId || info.role !== "assistant" || info.error !== undefined ||
        info.summary === true || info.finish !== "stop" || !Number.isSafeInteger(info.time?.completed) || info.time.completed < 0)) {
        return { sessionId, parsed: null, outcome: "unknown", error: "synthetic child response is not a completed terminal turn" }
      }
      const chunks = (response.data?.parts ?? []).filter((part: any) => part.type === "text" && typeof part.text === "string").map((part: any) => part.text)
      const text = chunks.join("\n")
      if (Buffer.byteLength(text, "utf8") > 96 * 1024) {
        return { sessionId, parsed: null, outcome: "completed", output_error: "response_oversized" }
      }
      const extracted = extractJsonDetailed(text)
      return { sessionId, parsed: extracted.value, outcome: "completed",
        ...(extracted.value === null ? { output_error: `response_${extracted.reason ?? "invalid_json"}` } : {}) }
    } catch (error) { return { sessionId, parsed: null, outcome: "unknown", error: formatSdkError(error) } }
  }
}

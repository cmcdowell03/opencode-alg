import type { PluginInput } from "@opencode-ai/plugin"
import { jsonSchemaHint, parseAndValidate } from "./schemas.ts"
import type { AlgAgent, ModelRef } from "./types.ts"
import {
  MAX_AGENT_RESPONSE_TEXT_BYTES,
  MAX_CHECKER_PROMPT_BYTES,
  MAX_WORKER_PROMPT_BYTES,
  assertTextBytes,
} from "./limits.ts"
import { formatSdkDiagnostic, formatSdkError } from "./diagnostics.ts"

export type Client = PluginInput["client"]

// OpenCode 1.18.3's server accepts top-level prompt `variant`, but the legacy
// root SDK declaration used by PluginInput omits it. Keep the compatibility
// surface limited to that one body property rather than widening the client.
type LegacyPromptInput = Parameters<Client["session"]["prompt"]>[0]
type PromptBodyWithVariant = NonNullable<LegacyPromptInput["body"]> & {
  variant?: string
}

export interface NodePromptOpts {
  client: Client
  parentSessionId: string
  agent: Exclude<AlgAgent, "shell">
  title: string
  userPrompt: string
  directory: string
  model?: ModelRef
  abort?: AbortSignal
  onSessionCreated?: (sessionId: string) => void | Promise<void>
}

export interface NodePromptResult {
  session_id: string
  text: string
  parsed: unknown | null
  error?: string
  response_diagnostic?: string
}

export type JsonExtractionReason = "empty" | "no_json" | "truncated" | "oversized" | "too_many" | "invalid_json" | "not_object" | "ambiguous"
export interface JsonExtraction {
  value: unknown | null
  reason?: JsonExtractionReason
  candidate_count: number
}

const MAX_JSON_CANDIDATES = 8
const MAX_JSON_CANDIDATE_BYTES = MAX_AGENT_RESPONSE_TEXT_BYTES

function jsonObjectCandidates(text: string): { candidates: unknown[]; reason?: JsonExtractionReason } {
  if (!text.trim()) return { candidates: [], reason: "empty" }
  if (Buffer.byteLength(text, "utf8") > MAX_JSON_CANDIDATE_BYTES) return { candidates: [], reason: "oversized" }
  const candidates: unknown[] = []
  let scannedCandidates = 0
  let reason: JsonExtractionReason | undefined
  for (let start = 0; start < text.length;) {
    const opener = text[start]
    if (opener !== "{" && opener !== "[") { start++; continue }
    if (scannedCandidates >= MAX_JSON_CANDIDATES) return { candidates, reason: "too_many" }
    scannedCandidates++
    const stack: string[] = []
    let inString = false
    let escaped = false
    let end = start
    for (; end < text.length; end++) {
      const char = text[end]!
      if (inString) {
        if (escaped) escaped = false
        else if (char === "\\") escaped = true
        else if (char === '"') inString = false
        continue
      }
      if (char === '"') { inString = true; continue }
      if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]")
      else if (char === "}" || char === "]") {
        if (stack.pop() !== char) { reason ??= "invalid_json"; end++; break }
        if (stack.length === 0) { end++; break }
      }
    }
    if (stack.length > 0 || inString) {
      reason ??= "truncated"
      break
    }
    const source = text.slice(start, end)
    if (Buffer.byteLength(source, "utf8") > MAX_JSON_CANDIDATE_BYTES) reason ??= "oversized"
    else {
      try {
        const parsed: unknown = JSON.parse(source)
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) candidates.push(parsed)
        else reason ??= "not_object"
      } catch { reason ??= "invalid_json" }
    }
    start = end
  }
  return { candidates, reason: reason ?? (candidates.length ? undefined : "no_json") }
}

/** Converts only fresh response path metadata; all other output fields stay untouched. */
export function normalizeFreshResponsePaths(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const output = { ...(value as Record<string, unknown>) }
  if (Array.isArray(output.files_touched)) {
    output.files_touched = output.files_touched.map((path) => typeof path === "string" ? path.replaceAll("\\", "/") : path)
  }
  if (typeof output.artifact_path === "string") output.artifact_path = output.artifact_path.replaceAll("\\", "/")
  return output
}

export function extractJsonDetailed(text: string, agent?: Exclude<AlgAgent, "shell">): JsonExtraction {
  const result = jsonObjectCandidates(text)
  const candidates = result.candidates.map(normalizeFreshResponsePaths)
  if (result.reason === "too_many" || result.reason === "oversized" || result.reason === "truncated") {
    return { value: null, reason: result.reason, candidate_count: candidates.length }
  }
  if (candidates.length === 1) return { value: candidates[0], candidate_count: 1 }
  if (candidates.length === 0) return { value: null, reason: result.reason, candidate_count: 0 }
  if (agent) {
    const valid = candidates.filter((candidate) => parseAndValidate(agent, candidate).ok)
    if (valid.length === 1) return { value: valid[0], candidate_count: candidates.length }
  }
  return { value: null, reason: "ambiguous", candidate_count: candidates.length }
}

/** Extract one object; multiple candidates are rejected unless a role schema selects one. */
export function extractJson(text: string): unknown | null {
  return extractJsonDetailed(text).value
}

function partsToText(parts: unknown): { text: string; textPartCount: number; oversized: boolean } {
  if (!Array.isArray(parts)) return { text: "", textPartCount: 0, oversized: false }
  const chunks: string[] = []
  let textPartCount = 0
  let bytes = 0
  let oversized = false
  for (const part of parts) {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "text" ||
      typeof (part as { text?: unknown }).text !== "string") continue
    const chunk = (part as { text: string }).text
    if (!oversized) {
      bytes += Buffer.byteLength(chunk, "utf8") + (textPartCount ? 1 : 0)
      if (bytes > MAX_AGENT_RESPONSE_TEXT_BYTES) oversized = true
      else chunks.push(chunk)
    }
    textPartCount++
  }
  return { text: oversized ? "" : chunks.join("\n"), textPartCount, oversized }
}

function finishReason(data: unknown): string | undefined {
  if (!data || typeof data !== "object") return undefined
  const record = data as Record<string, unknown>
  const info = record.info && typeof record.info === "object" ? record.info as Record<string, unknown> : {}
  const raw = info.finishReason ?? info.finish_reason ?? record.finishReason ?? record.finish_reason
  if (typeof raw !== "string") return undefined
  const normalized = raw.toLowerCase()
  return ["stop", "length", "tool_calls", "content_filter", "error", "unknown"].includes(normalized)
    ? normalized
    : "other"
}

/**
 * Uses a fresh SDK child session per attempt. This isolates message history from
 * sibling attempts; OpenCode project/system policy and filesystem access still apply.
 */
export async function runNodeSession(opts: NodePromptOpts): Promise<NodePromptResult> {
  let sessionId = ""
  let callbackFailed = false
  try {
    if (opts.abort?.aborted) throw new Error("Execution cancelled before child launch")
    const promptLimit = opts.agent === "checker" ? MAX_CHECKER_PROMPT_BYTES : MAX_WORKER_PROMPT_BYTES
    assertTextBytes(opts.userPrompt, promptLimit, `${opts.agent} prompt`)
    const fullPrompt = `${opts.userPrompt}

---
OUTPUT CONTRACT (mandatory):
Return a single JSON object matching this strict schema for agent "${opts.agent}".
No prose outside the JSON (markdown fences allowed).

${jsonSchemaHint(opts.agent)}
`
    assertTextBytes(fullPrompt, promptLimit, `${opts.agent} full prompt`)

    const created = await opts.client.session.create({
      body: { parentID: opts.parentSessionId, title: `alg:${opts.title}` },
      query: { directory: opts.directory },
      responseStyle: "fields",
      throwOnError: false,
      signal: opts.abort,
    })
    if (created.error) {
      return { session_id: "", text: "", parsed: null, error: formatSdkDiagnostic("session.create failed: ", created.error) }
    }
    sessionId = created.data?.id ?? ""
    if (!sessionId) {
      return { session_id: "", text: "", parsed: null, error: "session.create returned no session id" }
    }
    try {
      await opts.onSessionCreated?.(sessionId)
    } catch (error) {
      callbackFailed = true
      throw error
    }
    if (opts.abort?.aborted) throw new Error("Execution cancelled before child prompt")

    const body: PromptBodyWithVariant = {
      agent: opts.agent,
      ...(opts.model ? {
        model: {
          providerID: opts.model.providerID,
          modelID: opts.model.modelID,
        },
      } : {}),
      ...(opts.model?.variant ? { variant: opts.model.variant } : {}),
      parts: [{ type: "text", text: fullPrompt }],
    }
    const prompted = await opts.client.session.prompt({
      path: { id: sessionId },
      query: { directory: opts.directory },
      body,
      responseStyle: "fields",
      throwOnError: false,
      signal: opts.abort,
    })
    if (prompted.error) {
      return {
        session_id: sessionId,
        text: "",
        parsed: null,
        error: formatSdkDiagnostic("session.prompt failed: ", prompted.error),
      }
    }
    const parts = (prompted.data as { parts?: unknown } | undefined)?.parts
    const partCount = Array.isArray(parts) ? parts.length : 0
    const { text, textPartCount, oversized } = partsToText(parts)
    const extraction = oversized
      ? { value: null, reason: "oversized" as const, candidate_count: 0 }
      : extractJsonDetailed(text, opts.agent)
    const finish = finishReason(prompted.data)
    const responseDiagnostic = extraction.value === null
      ? `Response parse: ${extraction.reason ?? "no_json"}; error_category=none; parts=${partCount}; text_parts=${textPartCount}; non_text_parts=${partCount - textPartCount}${finish ? `; finish=${finish}` : ""}`
      : undefined
    return { session_id: sessionId, text, parsed: extraction.value, ...(responseDiagnostic ? { response_diagnostic: responseDiagnostic } : {}) }
  } catch (error) {
    if (callbackFailed) throw error
    return {
      session_id: sessionId,
      text: "",
      parsed: null,
      error: formatSdkError(error),
    }
  }
}

export function buildWorkerPrompt(options: {
  goal: string
  runId?: string
  criteria: string[]
  agent: AlgAgent
  inputs: Record<string, unknown>
  priorFailures: string[]
  description?: string
}): string {
  const lines = [
    `You are the "${options.agent}" node in an Agents+Loops+Graphs run.`,
    options.description ? `Node task: ${options.description}` : "",
    "",
    `GOAL:\n${options.goal}`,
    "",
    "HARD CRITERIA:",
    ...(options.criteria.length ? options.criteria.map((criterion, i) => `${i + 1}. ${criterion}`) : ["(none locked)"]),
    "",
    "WIRED INPUTS (validated dependencies):",
    "```json",
    JSON.stringify(options.inputs, null, 2),
    "```",
  ]
  if (options.agent === "implementer" && options.runId) {
    lines.push(
      "",
      `RUN ID: ${options.runId}`,
      "Return files_touched as project-relative paths using forward slashes (for example, src/file.ts).",
      `If you create a report artifact, save it under exactly .opencode/runs/${options.runId}/artifacts/ and return that project-relative path as artifact_path.`,
      "If you did not create an artifact, omit artifact_path.",
    )
  }
  if (options.priorFailures.length) {
    lines.push(
      "",
      "PRIOR VALIDATED CHECKER/GATE FAILURES (address these):",
      ...options.priorFailures.map((failure) => `- ${failure}`),
    )
  }
  lines.push("", "Do the work with your tools, then return the JSON output contract.", "Do not launch nested orchestration graphs.")
  const prompt = lines.filter(Boolean).join("\n")
  assertTextBytes(prompt, MAX_WORKER_PROMPT_BYTES, "worker prompt")
  return prompt
}

/** The checker prompt excludes worker chat/reasoning; SDK/project policy remains active. */
export function buildCheckerPrompt(options: { criteria: string[]; claimed: unknown; priorFailures?: string[] }): string {
  const prompt = [
    "You are a checker in a fresh child session.",
    "ALG's explicit task payload contains bounded claimed output and original hard criteria.",
    "OpenCode SDK/project/system/tool/filesystem context may still apply.",
    "Find reasons to reject. Never improve the work.",
    "",
    "CRITERIA:",
    ...options.criteria.map((criterion, i) => `${i + 1}. ${criterion}`),
    "",
    "CLAIMED OUTPUT:",
    "```json",
    JSON.stringify(options.claimed, null, 2),
    "```",
    "",
    "Return only the CheckOut JSON verdict.",
    "score is an integer 0–10; passed must equal (score >= 7). Pass only when every hard criterion is met, with failures=[]. Otherwise score 0–6 and provide specific failures.",
    ...(options.priorFailures?.length ? [
      "PRIOR ATTEMPT VALIDATION/GATE FAILURES (correct the verdict contract; these are not new acceptance criteria):",
      ...options.priorFailures.map((failure) => `- ${failure}`),
    ] : []),
  ].join("\n")
  assertTextBytes(prompt, MAX_CHECKER_PROMPT_BYTES, "checker prompt")
  return prompt
}

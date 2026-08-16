import type { PluginInput } from "@opencode-ai/plugin"
import { jsonSchemaHint } from "./schemas.ts"
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
}

/** Extract one JSON object from a fenced or raw response. */
export function extractJson(text: string): unknown | null {
  if (!text?.trim()) return null
  const trimmed = text.trim()
  const fence = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n?```$/i)
  const candidate = fence ? fence[1]!.trim() : trimmed
  try {
    const parsed: unknown = JSON.parse(candidate)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null
  } catch {
    return null
  }
}

function partsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return ""
  const text = parts
    .filter((part): part is { type: "text"; text: string } =>
      Boolean(part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string"),
    )
    .map((part) => part.text)
    .join("\n")
  assertTextBytes(text, MAX_AGENT_RESPONSE_TEXT_BYTES, "agent response text")
  return text
}

/**
 * Uses a fresh SDK child session per attempt. This isolates message history from
 * sibling attempts; OpenCode project/system policy and filesystem access still apply.
 */
export async function runNodeSession(opts: NodePromptOpts): Promise<NodePromptResult> {
  let sessionId = ""
  try {
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
    await opts.onSessionCreated?.(sessionId)

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
    const text = partsToText(prompted.data?.parts)
    return { session_id: sessionId, text, parsed: extractJson(text) }
  } catch (error) {
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
export function buildCheckerPrompt(options: { criteria: string[]; claimed: unknown }): string {
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
  ].join("\n")
  assertTextBytes(prompt, MAX_CHECKER_PROMPT_BYTES, "checker prompt")
  return prompt
}

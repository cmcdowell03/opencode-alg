import { createHash } from "node:crypto"
import { canonicalJson } from "./persistence.ts"
import { serializedBytes, truncateUtf8, utf8Bytes } from "./limits.ts"
import {
  SkillEvidenceSchema,
  type SkillEvidence,
  type SkillEvolutionOptions,
  type SkillTriggerLabel,
} from "./skill-evolution-schemas.ts"

type MessageEnvelope = { info: Record<string, any>; parts: Array<Record<string, any>> }

const OBVIOUS_SECRET = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/gi,
  /\b(?:sk|rk|pk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g,
  /\bAKIA[A-Z0-9]{16}\b/g,
] as const
const SENSITIVE_KEY = /(?:authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|cookie|secret|password|passwd|credential|private[-_ ]?key)/i
const CREDENTIAL_ASSIGNMENT = /\b(authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|cookie|secret|password|passwd|credential|private[-_ ]?key)(\s*[:=]\s*)(?:(?:bearer|basic|token)\s+)?(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:[\\/][^\s"'`<>|]+/g
const FILE_ABSOLUTE_PATH = /\bfile:\/{2,3}(?:[A-Za-z]:)?\/(?:[^\s"'`<>|]+\/?)+/gi
const POSIX_ABSOLUTE_PATH = /(^|[\s("'`])\/(?:Users|home|root|tmp|var|etc|opt|srv|private)(?:\/[^\s"'`<>|,;]+)+/g

function redactObviousSecrets(value: string): string {
  let redacted = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "�")
  for (const pattern of OBVIOUS_SECRET) redacted = redacted.replace(pattern, "[REDACTED]")
  redacted = redacted.replace(CREDENTIAL_ASSIGNMENT, (_match, key: string, separator: string) => `${key}${separator}[REDACTED]`)
  redacted = redacted.replace(FILE_ABSOLUTE_PATH, "[REDACTED_PATH]")
  redacted = redacted.replace(WINDOWS_ABSOLUTE_PATH, "[REDACTED_PATH]")
  redacted = redacted.replace(POSIX_ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}[REDACTED_PATH]`)
  return redacted
}

function boundedJsonSummary(value: unknown): string {
  const seen = new WeakSet<object>()
  let serialized: string
  try {
    serialized = JSON.stringify(value, (key, item) => {
      if (SENSITIVE_KEY.test(key)) return "[REDACTED]"
      if (typeof item === "string") return redactObviousSecrets(item)
      if (item && typeof item === "object") {
        if (seen.has(item)) return "[Circular]"
        seen.add(item)
      }
      return item
    }) ?? ""
  } catch {
    serialized = "[Unserializable]"
  }
  return redactObviousSecrets(serialized)
}

export interface BoundedEvidenceText {
  excerpt: string
  original_bytes: number
  retained_bytes: number
  bytes_omitted: number
}

export function redactEvidenceText(value: unknown, maximumBytes = 2_000): BoundedEvidenceText {
  const source = typeof value === "string" ? value : boundedJsonSummary(value)
  const fullyRedacted = redactObviousSecrets(source)
  const originalBytes = utf8Bytes(fullyRedacted)
  const maximum = Math.max(32, Math.min(2_000, maximumBytes))
  const excerpt = originalBytes <= maximum ? fullyRedacted : truncateUtf8(fullyRedacted, maximum)
  const retainedBytes = utf8Bytes(excerpt)
  return {
    excerpt,
    original_bytes: originalBytes,
    retained_bytes: retainedBytes,
    bytes_omitted: Math.max(0, originalBytes - retainedBytes),
  }
}

function isEnvelope(value: unknown): value is MessageEnvelope {
  return Boolean(value && typeof value === "object" &&
    (value as any).info && typeof (value as any).info === "object" &&
    Array.isArray((value as any).parts))
}

function partText(parts: Array<Record<string, any>>): string {
  return parts
    .filter((part) => part.type === "text" && part.ignored !== true && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
}

function toolStatus(value: unknown): "pending" | "running" | "completed" | "error" | "unknown" {
  return value === "pending" || value === "running" || value === "completed" || value === "error" ? value : "unknown"
}

function scoreSignals(
  userText: string,
  assistantText: string,
  parts: Array<Record<string, any>>,
  tools: Array<{ name: string; status: string; input: BoundedEvidenceText; result: BoundedEvidenceText; error: BoundedEvidenceText }>,
): { score: number; labels: SkillTriggerLabel[] } {
  const labels: SkillTriggerLabel[] = []
  let score = 0
  const all = `${userText}\n${assistantText}\n${tools.map((tool) => `${tool.name} ${tool.result.excerpt} ${tool.error.excerpt}`).join("\n")}`
  const add = (label: SkillTriggerLabel, points: number) => {
    if (labels.includes(label)) return
    labels.push(label)
    score += points
  }
  if (/\b(?:no[,;:]?|actually|that(?:'s| is) (?:wrong|incorrect)|you (?:missed|ignored)|not what i (?:asked|meant)|please (?:fix|correct)|instead)\b/i.test(userText)) {
    add("explicit_user_correction", 3)
  }
  const retryParts = parts.filter((part) => part.type === "retry").length
  const errorTools = tools.filter((tool) => tool.status === "error").length
  const failureHits = all.match(/\b(?:failed|failure|error|exception|timed out|rejected)\b/gi)?.length ?? 0
  if (retryParts > 0 || errorTools > 0 || failureHits >= 2) add("repeated_failure_or_error", 2)
  if (/\b(?:tests?|pytest|bun test|npm test|cargo test|go test|command)\b[\s\S]{0,160}\b(?:failed|failure|error|exit (?:code )?[1-9])\b/i.test(all) ||
    /\b(?:failed|failure|error)\b[\s\S]{0,160}\b(?:tests?|command)\b/i.test(all)) {
    add("failed_tests_or_commands", 3)
  }
  const skillLoaded = tools.some((tool) => /skill/i.test(tool.name)) || /\b(?:loaded|using|invoked) (?:the )?[^\n]{0,80}skill\b/i.test(all)
  if (skillLoaded && /\b(?:missing|inadequate|insufficient|outdated|wrong|did not help|could not)\b/i.test(all)) {
    add("loaded_skill_inadequacy", 3)
  }
  if (retryParts >= 1 || /\b(?:second|third|another|repeated) attempt\b|\btried (?:again|twice|multiple)\b/i.test(all)) {
    add("repeated_attempts", 2)
  }
  const completedTools = tools.filter((tool) => tool.status === "completed").length
  if (completedTools >= 2 && /\b(?:passed|succeeded|works|working|repeatable|procedure|steps|workflow)\b/i.test(all)) {
    add("reusable_successful_procedure", 2)
  }
  return { score: Math.min(20, score), labels }
}

function assertTerminalAssistant(info: Record<string, any>, sessionId: string, messageId: string): void {
  if (info.role !== "assistant" || info.sessionID !== sessionId || info.id !== messageId) {
    throw new Error("authoritative assistant message identity mismatch")
  }
  if (!Number.isSafeInteger(info.time?.completed) || info.time.completed < 0) {
    throw new Error("assistant message is incomplete")
  }
  if (info.error !== undefined) throw new Error("error-only assistant messages are ineligible")
}

export function buildSkillEvidence(
  messagesValue: unknown,
  sessionId: string,
  messageId: string,
  options: SkillEvolutionOptions,
  manual = false,
): SkillEvidence {
  if (!Array.isArray(messagesValue)) throw new Error("session messages response is not an array")
  const messages = messagesValue.filter(isEnvelope)
  // SDK post-processing may surface more than one envelope for the same
  // message identity. The final envelope is authoritative.
  const assistant = [...messages].reverse().find((message) => message.info.role === "assistant" && message.info.id === messageId)
  if (!assistant) throw new Error("completed assistant message was deleted or is unavailable")
  assertTerminalAssistant(assistant.info, sessionId, messageId)
  const user = [...messages].reverse().find((message) => message.info.role === "user" && message.info.id === assistant.info.parentID)
  if (!user) throw new Error("assistant parent user message is unavailable")
  if (user.info.sessionID !== sessionId || !Number.isSafeInteger(user.info.time?.created)) {
    throw new Error("authoritative parent user identity mismatch")
  }

  const rawUserText = partText(user.parts)
  const rawAssistantText = partText(assistant.parts)
  const rawTools = assistant.parts.filter((part) => part.type === "tool")
  const maximumTools = Math.min(24, Math.max(1, Math.floor(options.maxEvidenceBytes / 800)))
  let toolsOmitted = Math.max(0, rawTools.length - maximumTools)
  const perField = Math.max(64, Math.min(2_000, Math.floor(options.maxEvidenceBytes / Math.max(4, 2 + maximumTools * 3))))
  let tools = rawTools.slice(0, maximumTools).map((part) => {
    const state = part.state && typeof part.state === "object" ? part.state : {}
    return {
      name: typeof part.tool === "string" && part.tool.trim() ? part.tool.slice(0, 256) : "unknown-tool",
      status: toolStatus(state.status),
      input: redactEvidenceText(state.input ?? "", perField),
      result: redactEvidenceText(state.status === "completed" ? { title: state.title, output: state.output } : "", perField),
      error: redactEvidenceText(state.status === "error" ? state.error : "", perField),
    }
  })
  let userText = redactEvidenceText(rawUserText, Math.min(2_000, Math.floor(options.maxEvidenceBytes / 4)))
  let assistantText = redactEvidenceText(rawAssistantText, Math.min(2_000, Math.floor(options.maxEvidenceBytes / 4)))
  const signals = scoreSignals(rawUserText, rawAssistantText, assistant.parts, tools)
  if (manual && !signals.labels.includes("manual")) signals.labels.push("manual")

  const provenance = {
    session_id: sessionId,
    user_message_id: String(user.info.id),
    assistant_message_id: messageId,
    user_created_at: Number(user.info.time.created),
    assistant_created_at: Number(assistant.info.time?.created),
    assistant_completed_at: Number(assistant.info.time.completed),
  }
  const totalParts = user.parts.length + assistant.parts.length
  const retainedParts = user.parts.filter((part) => part.type === "text" && part.ignored !== true).length +
    assistant.parts.filter((part) => (part.type === "text" && part.ignored !== true) || part.type === "tool").length
  const make = (): Omit<SkillEvidence, "evidence_id"> => {
    const fields = [userText, assistantText, ...tools.flatMap((tool) => [tool.input, tool.result, tool.error])]
    return {
      schema_version: 1,
      kind: "skill_evolution_evidence",
      created_at: new Date().toISOString(),
      provenance,
      assistant: {
        agent: String(assistant.info.mode || "unknown").slice(0, 128),
        provider_id: String(assistant.info.providerID || "unknown").slice(0, 128),
        model_id: String(assistant.info.modelID || "unknown").slice(0, 256),
      },
      user_text: userText,
      assistant_text: assistantText,
      tools,
      trigger_score: signals.score,
      trigger_labels: signals.labels,
      truncation: {
        parts_omitted: Math.max(0, totalParts - retainedParts),
        tools_omitted: toolsOmitted,
        text_fields_truncated: fields.filter((field) => field.bytes_omitted > 0).length,
        bytes_omitted: fields.reduce((sum, field) => sum + field.bytes_omitted, 0),
        aggregate_byte_limit: options.maxEvidenceBytes,
      },
    }
  }

  // Tool evidence is least important. Reduce it until the strict aggregate
  // bound is met, then reduce the two text excerpts if fixed metadata dominates.
  while (tools.length && serializedBytes({ ...make(), evidence_id: "0".repeat(64) }) > options.maxEvidenceBytes) {
    tools.pop()
    toolsOmitted++
  }
  if (serializedBytes({ ...make(), evidence_id: "0".repeat(64) }) > options.maxEvidenceBytes) {
    const smaller = Math.max(32, Math.floor(options.maxEvidenceBytes / 12))
    userText = redactEvidenceText(rawUserText, smaller)
    assistantText = redactEvidenceText(rawAssistantText, smaller)
  }
  const withoutId = make()
  const evidenceId = createHash("sha256").update(canonicalJson(withoutId), "utf8").digest("hex")
  const evidence = SkillEvidenceSchema.parse({ ...withoutId, evidence_id: evidenceId })
  if (serializedBytes(evidence) > options.maxEvidenceBytes) {
    throw new Error("bounded evidence metadata exceeds configured evidence limit")
  }
  return evidence
}

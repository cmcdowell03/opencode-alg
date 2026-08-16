import { truncateUtf8, utf8Bytes } from "./limits.ts"

export const MAX_SDK_DIAGNOSTIC_BYTES = 2_000
export const MAX_PERSISTED_FAILURES = 100

const MAX_DEPTH = 5
const MAX_KEYS = 24
const MAX_ARRAY_ITEMS = 12
const MAX_STRING_CHARS = 320
const REDACTED = "[REDACTED]"
const CIRCULAR = "[Circular]"
const OMIT = Symbol("omit diagnostic field")
const QUOTED_CREDENTIAL_KEY = String.raw`[A-Za-z0-9_. -]*(?:authorization|api[-_ ]?key|token|cookie|secret|password|passwd|credential)[A-Za-z0-9_. -]*`
const BARE_CREDENTIAL_KEY = String.raw`(?:(?:proxy[-_ ]?)?authorization|[A-Za-z0-9_.-]*(?:api[-_ ]?key|token|cookie|secret|password|passwd|credential)[A-Za-z0-9_.-]*)`
const QUOTED_PRIVATE_CONTENT_KEY = String.raw`[A-Za-z0-9_. -]*(?:prompt|contents?|messages|payload|body|input)[A-Za-z0-9_. -]*`
const BARE_PRIVATE_CONTENT_KEY = String.raw`[A-Za-z0-9_.-]*(?:prompt|contents?|messages|payload|body|input)[A-Za-z0-9_.-]*`
const QUOTED_SENSITIVE_KEY = `(?:${QUOTED_CREDENTIAL_KEY}|${QUOTED_PRIVATE_CONTENT_KEY})`
const BARE_SENSITIVE_KEY = `(?:${BARE_CREDENTIAL_KEY}|${BARE_PRIVATE_CONTENT_KEY})`
const SENSITIVE_ASSIGNMENT_PREFIX = new RegExp(
  String.raw`(?:\\*"${QUOTED_SENSITIVE_KEY}\\*"|\\*'${QUOTED_SENSITIVE_KEY}\\*'|\b${BARE_SENSITIVE_KEY})[ \t]*[:=][ \t]*`,
  "gi",
)
const AUTHORIZATION_SCHEME_PREFIX = /\b(?:basic|bearer|token)\b[ \t]+/gi
const SAFE_INLINE_ASSIGNMENT = new RegExp(
  String.raw`(?:[,;][ \t]*|[ \t]+)(?=(?:\\*["'])?(?:name|status(?:_?code)?|error_?code|request_?id|correlation_?id)(?:\\*["'])?[ \t]*[:=])`,
  "gi",
)
// Only these scalar names are copied from SDK errors. Keep aliases explicit so
// spelling normalization cannot turn an arbitrary property into a safe field.
const SAFE_SCALAR_KEYS = [
  "name",
  "message",
  "code",
  "errorCode",
  "error_code",
  "status",
  "statusCode",
  "status_code",
  "requestId",
  "requestID",
  "request_id",
  "_request_id",
  "correlationId",
  "correlationID",
  "correlation_id",
  "_correlation_id",
] as const

// These are the only property names through which structured diagnostics may
// be traversed. `data` is the OpenCode SDK NamedError envelope; `body` is the
// decoded error envelope stored at Error.cause.body by wrapClientError.
const DIAGNOSTIC_CONTAINER_KEYS = ["error", "cause", "response"] as const
const SDK_WRAPPER_CONTAINER_KEYS = ["data", "body"] as const
const APPROVED_CONTAINER_KEYS = [
  ...DIAGNOSTIC_CONTAINER_KEYS,
  ...SDK_WRAPPER_CONTAINER_KEYS,
] as const
const SAFE_SCALAR_KEY_SET = new Set<string>(SAFE_SCALAR_KEYS)
const APPROVED_CONTAINER_KEY_SET = new Set<string>(APPROVED_CONTAINER_KEYS)

function safeProperty(value: object, key: string): unknown {
  try {
    return (value as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function normalizedKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, "").toLowerCase()
}

function isSecretKey(key: string): boolean {
  const normalized = normalizedKey(key)
  return normalized.includes("authorization") || normalized.includes("apikey") ||
    normalized.includes("token") || normalized.includes("cookie") ||
    normalized.includes("secret") || normalized.includes("password") ||
    normalized.includes("passwd") || normalized.includes("credential") ||
    normalized.includes("prompt") || normalized.includes("parts")
}

function isHeadersKey(key: string): boolean {
  return /^(?:headers?|requestheaders|responseheaders)$/.test(normalizedKey(key))
}

function isPrivateContentKey(key: string): boolean {
  return /^(?:content|contents|messages)$/.test(normalizedKey(key))
}

function isRequestContentKey(key: string): boolean {
  const normalized = normalizedKey(key)
  if (SAFE_SCALAR_KEY_SET.has(key)) return false
  if (/^(?:payload|body|request|response|input|data|user)$/.test(normalized)) return true
  const hasContext = /(?:request|user|response)/.test(normalized)
  const hasContent = /(?:content|body|payload|input|prompt|messages)/.test(normalized)
  const components = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  const hasContextualData = components.includes("data") ||
    /(?:request|user|response)data|data(?:request|user|response)/.test(normalized)
  if (hasContext && (hasContent || hasContextualData)) return true
  // Recognize established input/message content names without classifying the
  // approved diagnostic scalar `message` itself as private request content.
  return /^(?:(?:user|request|response|input|message)(?:payload|body|request|response|input|data|content|message)|(?:payload|body|data|content|message)(?:request|response|input|user|message))s?$/.test(normalized)
}

function isRedactedUnknownKey(key: string): boolean {
  return isSecretKey(key) || isHeadersKey(key) || isPrivateContentKey(key) ||
    isRequestContentKey(key)
}

function lineEnd(value: string, start: number): number {
  for (let index = start; index < value.length; index++) {
    if (value[index] === "\r" || value[index] === "\n") return index
  }
  return value.length
}

/**
 * Find the end of an ordinary quoted value or of a quote escaped by an outer
 * serialization layer (for example `\"token\":\"value\"`). Escaped outer
 * delimiters close only on a single backslash plus quote; longer backslash
 * runs are treated as nested/escaped content. Ambiguity fails closed.
 */
function quotedValueEnd(value: string, start: number): number | null {
  let delimiterSlashes = 0
  while (value[start + delimiterSlashes] === "\\") delimiterSlashes++
  const quote = value[start + delimiterSlashes]
  if (quote !== "\"" && quote !== "'") return null

  let index = start + delimiterSlashes + 1
  while (index < value.length) {
    if (value[index] === "\\") {
      const slashStart = index
      while (value[index] === "\\") index++
      if (value[index] !== quote) continue
      const slashCount = index - slashStart
      if ((delimiterSlashes > 0 && slashCount === delimiterSlashes) ||
        (delimiterSlashes === 0 && slashCount % 2 === 0)) {
        return index + 1
      }
      index++
      continue
    }
    if (delimiterSlashes === 0 && value[index] === quote) return index + 1
    index++
  }
  return null
}

function authorizationPayloadStart(value: string, start: number): number | null {
  for (const scheme of ["basic", "bearer", "token"] as const) {
    if (value.slice(start, start + scheme.length).toLowerCase() !== scheme) continue
    let index = start + scheme.length
    if (value[index] !== " " && value[index] !== "\t") continue
    while (value[index] === " " || value[index] === "\t") index++
    return index
  }
  return null
}

function credentialPayloadEnd(value: string, start: number): number {
  const quotedEnd = quotedValueEnd(value, start)
  // A recognized quote without a trustworthy close is private through the
  // rest of its line rather than risking a credential suffix disclosure.
  if (quotedEnd !== null) return quotedEnd
  return lineEnd(value, start)
}

function bareAssignmentValueEnd(value: string, start: number): number {
  SAFE_INLINE_ASSIGNMENT.lastIndex = start
  const next = SAFE_INLINE_ASSIGNMENT.exec(value)
  return next?.index ?? lineEnd(value, start)
}

function assignmentValueEnd(value: string, start: number): number {
  // Redaction is deliberately idempotent: a sanitized scalar can later be
  // embedded in a structured diagnostic and must not consume safe sibling
  // metadata when the aggregate is sanitized again.
  if (value.startsWith(REDACTED, start)) return start + REDACTED.length
  const payloadStart = authorizationPayloadStart(value, start)
  const quotedEnd = quotedValueEnd(value, payloadStart ?? start)
  return quotedEnd ?? bareAssignmentValueEnd(value, payloadStart ?? start)
}

function redactMatchedValues(
  value: string,
  pattern: RegExp,
  preservePrefix: boolean,
  findEnd: (value: string, start: number) => number,
): string {
  let cursor = 0
  let output = ""
  for (const match of value.matchAll(pattern)) {
    const matchStart = match.index
    if (matchStart < cursor) continue
    const valueStart = matchStart + match[0].length
    const valueEnd = Math.max(valueStart, findEnd(value, valueStart))
    output += value.slice(cursor, matchStart)
    if (preservePrefix) output += match[0]
    output += REDACTED
    cursor = valueEnd
  }
  return `${output}${value.slice(cursor)}`
}

function redactInline(value: string): string {
  const assignmentsRedacted = redactMatchedValues(
    value,
    SENSITIVE_ASSIGNMENT_PREFIX,
    true,
    assignmentValueEnd,
  )
  return redactMatchedValues(
    assignmentsRedacted,
    AUTHORIZATION_SCHEME_PREFIX,
    false,
    credentialPayloadEnd,
  )
}

/** Shared redaction and UTF-8 cap for values persisted in 2,000-character fields. */
export function safeDiagnosticText(
  value: string,
  maximumBytes = MAX_SDK_DIAGNOSTIC_BYTES,
): string {
  const maximum = Math.max(32, Math.min(maximumBytes, MAX_SDK_DIAGNOSTIC_BYTES))
  const redacted = redactInline(value)
  return capDiagnosticText(redacted, maximum)
}

function capDiagnosticText(value: string, maximum: number): string {
  if (utf8Bytes(value) <= maximum) return value
  const suffix = "…[truncated]"
  return `${truncateUtf8(value, maximum - utf8Bytes(suffix))}${suffix}`
}

export interface BoundDiagnosticListOptions {
  maximum?: number
  /** Entries that must survive aggregate truncation when present. */
  retain?: readonly string[]
  omittedLabel?: (count: number) => string
}

/**
 * Redact and bound a persisted failure aggregate under the shared schema cap.
 * Retained entries consume ordinary slots, while the final slot records the
 * exact number of entries omitted by truncation.
 */
export function boundDiagnosticList(
  values: readonly string[],
  options: BoundDiagnosticListOptions = {},
): string[] {
  const maximum = Math.max(1, Math.min(
    options.maximum ?? MAX_PERSISTED_FAILURES,
    MAX_PERSISTED_FAILURES,
  ))
  const normalized = values.map((value) => safeDiagnosticText(value))
  if (normalized.length <= maximum) return normalized

  const available = maximum - 1
  const selected = new Set<number>()
  for (const retained of options.retain ?? []) {
    if (selected.size >= available) break
    const safeRetained = safeDiagnosticText(retained)
    const index = normalized.findIndex((value, candidate) =>
      !selected.has(candidate) && value === safeRetained)
    if (index >= 0) selected.add(index)
  }
  for (let index = 0; index < normalized.length && selected.size < available; index++) {
    selected.add(index)
  }

  const kept = [...selected].sort((left, right) => left - right).map((index) => normalized[index]!)
  const omitted = normalized.length - kept.length
  const marker = options.omittedLabel?.(omitted) ??
    `[truncated] ${omitted} additional failure entries omitted`
  return [...kept, safeDiagnosticText(marker)]
}

function boundedString(value: string): string {
  const redacted = redactInline(value)
  return redacted.length <= MAX_STRING_CHARS
    ? redacted
    : `${redacted.slice(0, MAX_STRING_CHARS - 1)}…`
}

function sanitizeDiagnosticScalar(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value
  if (typeof value === "string") return boundedString(value)
  return Array.isArray(value) ? `[REDACTED: ${value.length} items]` : REDACTED
}

function sanitizeObject(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown | typeof OMIT {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return OMIT
  if (depth >= MAX_DEPTH) return "[MaxDepth]"
  if (seen.has(value)) return CIRCULAR
  seen.add(value)

  const result: Record<string, unknown> = {}
  if (value instanceof Error) {
    const name = safeProperty(value, "name")
    const message = safeProperty(value, "message")
    result.name = name === undefined || name === "" ? "Error" : sanitizeDiagnosticScalar(name)
    result.message = message === undefined || message === "" ? "Unknown error" : sanitizeDiagnosticScalar(message)
  }

  // Fetch-style Response and Error fields can be non-enumerable. Read only the
  // exact allowlist rather than recursively searching arbitrary enumerable keys.
  for (const scalarKey of SAFE_SCALAR_KEYS) {
    if (Object.hasOwn(result, scalarKey)) continue
    const field = safeProperty(value, scalarKey)
    if (field !== undefined) result[scalarKey] = sanitizeDiagnosticScalar(field)
  }

  for (const containerKey of APPROVED_CONTAINER_KEYS) {
    const field = safeProperty(value, containerKey)
    if (field === undefined) continue
    const safe = sanitizeContainer(field, depth + 1, seen)
    if (safe !== OMIT) result[containerKey] = safe
  }

  // Unknown properties are never read. Record only a bounded non-content
  // marker for credential/content-shaped names so prior redaction visibility
  // remains without exposing or traversing their values.
  let keys: string[] = []
  try {
    keys = Object.keys(value).sort()
  } catch {
    // Host objects can reject enumeration; the approved fields above suffice.
  }
  let redactedUnknownFields = 0
  for (const property of keys.slice(0, MAX_KEYS)) {
    if (SAFE_SCALAR_KEY_SET.has(property) || APPROVED_CONTAINER_KEY_SET.has(property)) continue
    if (isRedactedUnknownKey(property)) redactedUnknownFields++
  }
  if (redactedUnknownFields > 0) result._redacted = REDACTED
  if (keys.length > MAX_KEYS) result._truncated_keys = keys.length - MAX_KEYS
  if (Object.keys(result).length === 0) return OMIT
  return result
}

function sanitizeContainer(
  value: unknown,
  depth: number,
  seen: WeakSet<object>,
): unknown | typeof OMIT {
  if (value === undefined) return OMIT
  if (value === null || typeof value !== "object") return REDACTED
  if (depth >= MAX_DEPTH) return "[MaxDepth]"
  if (!Array.isArray(value)) return sanitizeObject(value, depth, seen)
  if (seen.has(value)) return CIRCULAR
  seen.add(value)

  const items: unknown[] = []
  for (const item of value.slice(0, MAX_ARRAY_ITEMS)) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      items.push(REDACTED)
      continue
    }
    const safe = sanitizeObject(item, depth + 1, seen)
    items.push(safe === OMIT ? REDACTED : safe)
  }
  if (value.length > MAX_ARRAY_ITEMS) items.push(`[${value.length - MAX_ARRAY_ITEMS} more items]`)
  return items
}

function sanitizeThrownPrimitive(value: unknown): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value
  if (typeof value === "string") return boundedString(value)
  return boundedString(String(value))
}

/** Bounded SDK/throwable diagnostics with recursive redaction and cycle safety. */
export function formatSdkError(
  error: unknown,
  maximumBytes = MAX_SDK_DIAGNOSTIC_BYTES,
): string {
  const maximum = Math.max(128, Math.min(maximumBytes, MAX_SDK_DIAGNOSTIC_BYTES))
  let safe: unknown
  if (error === undefined) safe = { thrown: "undefined" }
  else if (error === null) safe = { thrown: "null" }
  else if (typeof error !== "object") safe = { thrown: sanitizeThrownPrimitive(error) }
  else {
    const sanitized = sanitizeObject(error, 0, new WeakSet())
    safe = sanitized === OMIT
      ? { diagnostic: "[No safe diagnostic fields]" }
      : sanitized
  }

  let serialized: string
  try {
    serialized = JSON.stringify(safe)
  } catch {
    serialized = JSON.stringify({ thrown: "Unserializable SDK error" })
  }
  if (!serialized || serialized === "{}") serialized = JSON.stringify({ thrown: "Unknown SDK error" })
  // Every scalar was already passed through boundedString/redactInline while
  // constructing this allowlisted envelope. Redacting the final JSON again
  // would mistake safe SDK wrapper keys such as `body` for private assignments
  // and could also destroy valid JSON syntax.
  return capDiagnosticText(serialized, maximum)
}

/** Format an SDK error with its caller prefix under one persisted-field cap. */
export function formatSdkDiagnostic(prefix: string, error: unknown): string {
  return safeDiagnosticText(`${prefix}${formatSdkError(error)}`)
}

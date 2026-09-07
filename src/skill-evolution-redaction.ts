/** Version applies only to newly produced evidence; sealed history is never rewritten. */
export const EVOLUTION_REDACTION_POLICY_VERSION = 2
const sensitive = /(?:authorization|api[-_ ]?key|token|cookie|secret|password|passwd|credential|private[-_ ]?key)/i

export function redactEvolutionText(text: string): string {
  // Decode common transport encodings before inspection. Do not recursively
  // expand arbitrary compressed data or interpret executable content.
  let value = text
  for (let pass = 0; pass < 3; pass++) {
    const decoded = value.replace(/\\u([a-f0-9]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/(?:%[a-f0-9]{2})+/gi, (encoded) => { try { return decodeURIComponent(encoded) } catch { return encoded } })
    if (decoded === value) break
    value = decoded
  }
  value = value.replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gi, "[REDACTED]")
    .replace(/\b(?:sk|rk|pk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{16,}\b|\bgh[opusr]_[A-Za-z0-9]{20,}\b|\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]+/gi, "[REDACTED]")
    .replace(/\b(authorization|api[-_ ]?key|(?:access[-_ ]?|refresh[-_ ]?)?token|cookie|secret|password|passwd|credential|private[-_ ]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, "$1=[REDACTED]")
  // Recognized credentials in base64 text must not survive in encoded form.
  return value.replace(/[A-Za-z0-9+/]{24,}={0,2}/g, (encoded) => {
    const decoded = Buffer.from(encoded, "base64").toString("utf8")
    return /(?:password|secret|token|api[_-]?key)["']?\s*[:=]|-----BEGIN .*PRIVATE KEY-----|\b(?:sk|rk|pk)-|\bgh[opusr]_|\bAKIA/.test(decoded) ? "[REDACTED]" : encoded
  })
}

export function redactEvolutionValue(value: unknown): unknown {
  if (typeof value === "string") return redactEvolutionText(value)
  if (Array.isArray(value)) return value.map(redactEvolutionValue)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, sensitive.test(key) ? "[REDACTED]" : redactEvolutionValue(item)]))
  return value
}

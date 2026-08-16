import type { AlgAgent } from "./types.ts"

export const AGENT_OUTPUT_BYTE_LIMITS: Readonly<Record<AlgAgent, number>> = {
  explorer: 256 * 1024,
  researcher: 256 * 1024,
  implementer: 256 * 1024,
  checker: 64 * 1024,
  shell: 32 * 1024,
}

export const MAX_WORKER_PROMPT_BYTES = 384 * 1024
export const MAX_CHECKER_PROMPT_BYTES = 384 * 1024
export const MAX_AGENT_RESPONSE_TEXT_BYTES = 512 * 1024

/** Authoritative progress.json is always smaller than the store's hard read limit. */
export const MAX_STATE_BYTES = 5 * 1024 * 1024
export const STATE_WRITE_HEADROOM_BYTES = 256 * 1024
export const MAX_PERSISTED_STATE_BYTES = MAX_STATE_BYTES - STATE_WRITE_HEADROOM_BYTES
export const MAX_GRAPH_STATE_BYTES = 512 * 1024
export const MAX_ATTEMPT_HISTORY_BYTES = 512 * 1024
export const MAX_INLINE_ATTEMPTS_PER_NODE = 4
export const MAX_PROJECTED_ATTEMPT_FAILURES = 1
export const MAX_PROJECTED_NODE_FAILURES = 3
export const MAX_PROJECTED_FAILURE_BYTES = 128
export const MAX_PROJECTED_NODE_FAILURE_BYTES = 256
export const MAX_PROJECTED_ERROR_BYTES = 128
export const MAX_PROJECTED_ROOT_AUTHORIZATIONS = 64

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8")
}

export function serializedBytes(value: unknown): number {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error("value is not JSON serializable")
  return utf8Bytes(serialized)
}

export function assertSerializedBytes(value: unknown, maximum: number, label: string): void {
  const size = serializedBytes(value)
  if (size > maximum) throw new Error(`${label} exceeds ${maximum} serialized bytes (received ${size})`)
}

export function assertPersistedStateBytes(value: unknown, label = "run state"): void {
  assertSerializedBytes(value, MAX_PERSISTED_STATE_BYTES, label)
}

export function assertTextBytes(value: string, maximum: number, label: string): void {
  const size = utf8Bytes(value)
  if (size > maximum) throw new Error(`${label} exceeds ${maximum} UTF-8 bytes (received ${size})`)
}

export function truncateUtf8(value: string, maximum: number): string {
  if (utf8Bytes(value) <= maximum) return value
  let low = 0
  let high = value.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (utf8Bytes(value.slice(0, middle)) <= maximum) low = middle
    else high = middle - 1
  }
  return value.slice(0, low)
}

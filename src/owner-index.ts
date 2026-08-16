import { createHash } from "node:crypto"

export const OWNER_INDEX_SCHEMA_VERSION = 1 as const
export const MAX_OWNER_INDEX_ENTRIES = 64
export const MAX_OWNER_INDEX_BYTES = 32 * 1_024
export const OWNER_INDEX_DIRECTORY = "_owners"

const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const RESERVED_RUN_IDS = new Set([".", "..", "__proto__", "constructor", "prototype"])

export interface OwnerRunIndexEntry {
  run_id: string
  updated_at: string
}

export interface OwnerRunIndex {
  schema_version: 1
  owner_session_id: string
  updated_at: string
  runs: OwnerRunIndexEntry[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function isRunId(value: unknown): value is string {
  return typeof value === "string" && SAFE_RUN_ID.test(value) &&
    !RESERVED_RUN_IDS.has(value.toLowerCase())
}

/** Stable, fixed-size path component shared by the server store and TUI. */
export function ownerIndexKey(ownerSessionId: string): string {
  return createHash("sha256").update(ownerSessionId, "utf8").digest("hex")
}

/** Project-relative path consumed through the public SDK file API in the TUI. */
export function ownerIndexRelativePath(ownerSessionId: string): string {
  return `.opencode/runs/${OWNER_INDEX_DIRECTORY}/${ownerIndexKey(ownerSessionId)}.json`
}

export function parseOwnerRunIndex(value: unknown, expectedOwner: string): OwnerRunIndex {
  if (!isRecord(value) || value.schema_version !== OWNER_INDEX_SCHEMA_VERSION) {
    throw new Error("owner run index has an unsupported or malformed schema")
  }
  if (value.owner_session_id !== expectedOwner || typeof value.owner_session_id !== "string") {
    throw new Error("owner run index identity does not match the current parent session")
  }
  if (!isTimestamp(value.updated_at) || !Array.isArray(value.runs) || value.runs.length > MAX_OWNER_INDEX_ENTRIES) {
    throw new Error("owner run index timestamp or entry bound is invalid")
  }
  const keys = Object.keys(value).sort()
  if (keys.join(",") !== "owner_session_id,runs,schema_version,updated_at") {
    throw new Error("owner run index contains unexpected fields")
  }

  const seen = new Set<string>()
  const runs: OwnerRunIndexEntry[] = []
  for (const item of value.runs) {
    if (!isRecord(item) || Object.keys(item).sort().join(",") !== "run_id,updated_at" ||
      !isRunId(item.run_id) || !isTimestamp(item.updated_at) || seen.has(item.run_id)) {
      throw new Error("owner run index contains an invalid or duplicate run entry")
    }
    seen.add(item.run_id)
    runs.push({ run_id: item.run_id, updated_at: item.updated_at })
  }
  return {
    schema_version: OWNER_INDEX_SCHEMA_VERSION,
    owner_session_id: expectedOwner,
    updated_at: value.updated_at,
    runs,
  }
}

export function sortOwnerRunEntries(entries: OwnerRunIndexEntry[]): OwnerRunIndexEntry[] {
  return entries.sort((left, right) =>
    Date.parse(right.updated_at) - Date.parse(left.updated_at) ||
    left.run_id.localeCompare(right.run_id))
}

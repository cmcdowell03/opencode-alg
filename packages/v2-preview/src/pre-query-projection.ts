import type { SessionContext } from "@opencode/plugin/promise/session"
import { z } from "zod"
import { canonicalJson } from "../../../src/persistence.ts"
import { procedureDigestSchema, procedurePinSchema, projectPathSchema } from "../core/procedure-pin.ts"
import { TOOL } from "./host.ts"

type Messages = SessionContext["messages"]
type ToolResult = Extract<Messages[number], { role: "tool" }>["content"][number]
type Field = "preQuery.skill.pin" | "preQuery.prerequisite.evidence"
type Anchors = Map<string, string>

const eligibleActions = new Set(["admit", "dispatch", "reconcile"])
const evidenceSchema = z.object({
  revision: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  path: projectPathSchema.refine(path => /^[A-Za-z0-9._/-]+\.json$/.test(path)),
  sha256: procedureDigestSchema,
  sampled_rows: z.number().int().positive(),
  max_abs_skew_ms: z.number().nonnegative(),
  tolerance_ms: z.number().nonnegative(),
}).strict().refine(evidence => evidence.max_abs_skew_ms <= evidence.tolerance_ms)

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function receipt(text: string, runtimeSha256: string) {
  try {
    const value: unknown = JSON.parse(text)
    // ALG emits JSON.stringify text. Require a lossless round trip before editing any field.
    if (record(value) && value.ok === true && value.runtimeSha256 === runtimeSha256 &&
        !Object.hasOwn(value, "error") && JSON.stringify(value) === text) return value
  } catch {
    // Leave malformed or truncated tool output intact.
  }
}

function reference(value: object, callId: string, field: Field, anchors: Anchors) {
  const key = canonicalJson(value)
  const earlier = anchors.get(key)
  if (earlier === undefined) {
    anchors.set(key, callId)
    return
  }
  const ref = { ref: { callId: earlier, field } }
  const full = JSON.stringify(value)
  const compact = JSON.stringify(ref)
  // Check both the tool text and the JSON string used to carry it on the wire.
  if (Buffer.byteLength(compact) < Buffer.byteLength(full) &&
      Buffer.byteLength(JSON.stringify(compact)) < Buffer.byteLength(JSON.stringify(full))) return ref
}

function projectResult(part: ToolResult, runtimeSha256: string, pins: Anchors, evidence: Anchors): ToolResult {
  const { result } = part
  if (result?.type !== "text" || typeof result.value !== "string") return part
  const value = receipt(result.value, runtimeSha256)
  if (!value || !record(value.preQuery)) return part
  const { skill, prerequisite } = value.preQuery
  if (!record(skill) || skill.availability !== "verified" ||
      (skill.activation !== "observed" && skill.activation !== "not_observed") ||
      !record(prerequisite) || prerequisite.status !== "satisfied") return part

  const pin = procedurePinSchema.safeParse(skill.pin)
  const sample = evidenceSchema.safeParse(prerequisite.evidence)
  const pinRef = pin.success ? reference(pin.data, part.id, "preQuery.skill.pin", pins) : undefined
  const evidenceRef = sample.success
    ? reference(sample.data, part.id, "preQuery.prerequisite.evidence", evidence)
    : undefined
  if (!pinRef && !evidenceRef) return part

  const preQuery = {
    ...value.preQuery,
    skill: pinRef ? { ...skill, pin: pinRef } : skill,
    prerequisite: evidenceRef ? { ...prerequisite, evidence: evidenceRef } : prerequisite,
  }
  return { ...part, result: { ...result, value: JSON.stringify({ ...value, preQuery }) } }
}

/**
 * Project from the host's original, assembled request window after any compaction.
 * References address earlier full tool-result fields in that window as historical data.
 */
export function projectPreQueryReceipts(messages: Messages, runtimeSha256: string): Messages {
  if (!procedureDigestSchema.safeParse(runtimeSha256).success) return messages

  // A reused ID is ambiguous even if the conflicting part is from another tool.
  const bindings = new Map<string, { calls: number; results: number }>()
  for (const message of messages) {
    for (const part of message.content) {
      if (part.type !== "tool-call" && part.type !== "tool-result") continue
      const count = bindings.get(part.id) ?? { calls: 0, results: 0 }
      if (part.type === "tool-call") count.calls++
      else count.results++
      bindings.set(part.id, count)
    }
  }

  const calls = new Set<string>()
  const pins: Anchors = new Map()
  const evidence: Anchors = new Map()
  let projected: Messages | undefined
  for (const [index, message] of messages.entries()) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "compaction") {
          calls.clear()
          pins.clear()
          evidence.clear()
        }
        if (part.type !== "tool-call" || !localInvestigation(part) ||
            typeof part.id !== "string" || !part.id || /[\s\p{Cc}]/u.test(part.id) ||
            !record(part.input) || !Object.hasOwn(part.input, "action") || Object.keys(part.input).length !== 1 ||
            typeof part.input.action !== "string" || !eligibleActions.has(part.input.action)) continue
        const count = bindings.get(part.id)
        if (count?.calls === 1 && count.results === 1) calls.add(part.id)
      }
    } else if (message.role === "tool") {
      let changed = false
      const content = message.content.map(part => {
        if (!localInvestigation(part) || !calls.has(part.id)) return part
        const replacement = projectResult(part, runtimeSha256, pins, evidence)
        if (replacement !== part) changed = true
        return replacement
      })
      if (changed) {
        projected ??= messages.slice()
        projected[index] = { ...message, content }
      }
    }
  }
  return projected ?? messages
}

function localInvestigation(part: Pick<ToolResult, "name" | "namespace" | "providerExecuted">) {
  return part.name === TOOL && part.namespace === undefined &&
    (part.providerExecuted === undefined || part.providerExecuted === false)
}

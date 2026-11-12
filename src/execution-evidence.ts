import { createHash } from "node:crypto"
import { z } from "zod"
import type { PluginInput } from "@opencode-ai/plugin"
import { safeDiagnosticText } from "./diagnostics.ts"
import { serializedBytes, truncateUtf8, utf8Bytes } from "./limits.ts"
import type { ShellExecutionResult } from "./shell.ts"

export const MAX_EXECUTION_EVIDENCE_COMMANDS = 8
export const MAX_EXECUTION_EVIDENCE_BYTES = 12 * 1024
export const MAX_EXECUTION_EVIDENCE_OUTPUT_BYTES = 1_500
export const DEFAULT_EXECUTION_EVIDENCE_MESSAGE_LIMIT = 100
export const DEFAULT_EXECUTION_EVIDENCE_TIMEOUT_MS = 1_500

const identity = z.string().trim().min(1).max(256)
const safeText = z.string().max(4_096)

export const ExecutionCommandEvidenceSchema = z.object({
  call_id: identity.optional(),
  message_id: identity.optional(),
  tool: z.enum(["bash", "shell_gate"]),
  command: safeText.optional(),
  cwd: safeText.optional(),
  tool_status: z.enum(["pending", "running", "completed", "error"]),
  exit_code: z.number().int().safe().optional(),
  exit_code_status: z.enum(["reported", "unavailable"]),
  output: safeText.optional(),
  output_truncated: z.boolean(),
  command_truncated: z.boolean(),
  cwd_truncated: z.boolean(),
  gate_ok: z.boolean().optional(),
  timed_out: z.boolean().optional(),
  cancelled: z.boolean().optional(),
  setup_failed: z.boolean().optional(),
  termination_failed: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  if ((value.exit_code_status === "reported") !== (value.exit_code !== undefined)) {
    ctx.addIssue({ code: "custom", message: "exit code status must match exact host metadata" })
  }
})
export type ExecutionCommandEvidence = z.infer<typeof ExecutionCommandEvidenceSchema>

export const ExecutionEvidenceSchema = z.object({
  version: z.literal(1),
  run_id: identity,
  node_id: identity,
  attempt: z.number().int().positive(),
  child_session_id: identity.optional(),
  retrieval_status: z.enum(["available", "unavailable"]),
  unavailable_reason: z.enum(["missing_session", "timeout", "sdk_error", "invalid_response", "aborted"]).optional(),
  commands: z.array(ExecutionCommandEvidenceSchema).max(MAX_EXECUTION_EVIDENCE_COMMANDS),
  omitted_commands: z.number().int().nonnegative(),
  window_may_be_incomplete: z.boolean(),
  foreign_messages_omitted: z.number().int().nonnegative(),
}).strict().superRefine((value, ctx) => {
  if ((value.retrieval_status === "unavailable") !== (value.unavailable_reason !== undefined)) {
    ctx.addIssue({ code: "custom", message: "unavailable retrieval requires an explicit reason" })
  }
  if (serializedBytes(value) > MAX_EXECUTION_EVIDENCE_BYTES) {
    ctx.addIssue({ code: "custom", message: "execution evidence exceeds its serialized byte cap" })
  }
})
export type ExecutionEvidence = z.infer<typeof ExecutionEvidenceSchema>

export interface ExecutionEvidenceIdentity {
  run_id: string
  node_id: string
  attempt: number
  child_session_id?: string
}

type UnknownRecord = Record<string, unknown>
function record(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined
}

function exactInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined
}

/** Only exact host metadata is accepted. In particular, output text is never parsed for an exit code. */
function exitCodeFromMetadata(value: unknown): number | undefined {
  const metadata = record(value)
  if (!metadata) return undefined
  for (const key of ["exit_code", "exitCode", "exit"]) {
    const result = exactInteger(metadata[key])
    if (result !== undefined) return result
  }
  return undefined
}

function safeBounded(value: unknown, cap: number): { text?: string; truncated: boolean } {
  if (typeof value !== "string" || value.length === 0) return { truncated: false }
  // Redact before applying the output cap so secrets outside the retained prefix cannot
  // alter whether the captured prefix is safe. The shared sanitizer also applies a hard cap.
  const sanitized = safeDiagnosticText(value, Math.min(cap, 2_000))
  const truncated = utf8Bytes(value) > cap || sanitized.includes("…[truncated]")
  const text = truncateUtf8(sanitized, cap)
  return { ...(text ? { text } : {}), truncated }
}

function commandEvidence(part: UnknownRecord, messageId: string | undefined): ExecutionCommandEvidence | undefined {
  const tool = typeof part.tool === "string" ? part.tool.toLowerCase() : ""
  if (tool !== "bash") return undefined
  const state = record(part.state)
  if (!state) return undefined
  const status = state.status
  if (status !== "pending" && status !== "running" && status !== "completed" && status !== "error") return undefined
  const input = record(state.input)
  const command = safeBounded(input?.command, 4_096)
  const cwd = safeBounded(input?.cwd ?? input?.directory ?? input?.working_directory, 4_096)
  const metadata = record(state.metadata)
  // OpenCode's generated ToolState types do not promise an exit-code member. Accept only
  // these exact integer metadata fields if a host/backend supplies one at runtime.
  const exitCode = exitCodeFromMetadata(metadata) ?? exitCodeFromMetadata(part.metadata)
  const rawOutput = status === "completed" ? state.output : status === "error" ? state.error : undefined
  const output = safeBounded(rawOutput, MAX_EXECUTION_EVIDENCE_OUTPUT_BYTES)
  return ExecutionCommandEvidenceSchema.parse({
    ...(typeof part.callID === "string" ? { call_id: safeBounded(part.callID, 256).text } : {}),
    ...(messageId ? { message_id: safeBounded(messageId, 256).text } : {}),
    tool: "bash",
    ...(command.text ? { command: command.text } : {}),
    ...(cwd.text ? { cwd: cwd.text } : {}),
    tool_status: status,
    ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
    exit_code_status: exitCode === undefined ? "unavailable" : "reported",
    ...(output.text ? { output: output.text } : {}),
    output_truncated: output.truncated || metadata?.truncated === true || record(part.metadata)?.truncated === true,
    command_truncated: command.truncated,
    cwd_truncated: cwd.truncated,
  })
}

function unavailable(identity: ExecutionEvidenceIdentity, reason: NonNullable<ExecutionEvidence["unavailable_reason"]>): ExecutionEvidence {
  return ExecutionEvidenceSchema.parse({ version: 1, run_id: identity.run_id, node_id: identity.node_id, attempt: identity.attempt,
    ...(identity.child_session_id ? { child_session_id: identity.child_session_id } : {}), retrieval_status: "unavailable",
    unavailable_reason: reason, commands: [], omitted_commands: 0, window_may_be_incomplete: false, foreign_messages_omitted: 0 })
}

/** Read a bounded child-message window after the child turn; this never reads transcript text/reasoning. */
export async function captureChildExecutionEvidence(
  client: PluginInput["client"],
  identity: ExecutionEvidenceIdentity & { directory?: string; timeout_ms?: number; message_limit?: number; signal?: AbortSignal },
): Promise<ExecutionEvidence> {
  const sessionId = identity.child_session_id
  if (!sessionId) return unavailable(identity, "missing_session")
  const timeoutMs = Math.max(1, Math.min(identity.timeout_ms ?? DEFAULT_EXECUTION_EVIDENCE_TIMEOUT_MS, 10_000))
  const messageLimit = Math.max(1, Math.min(Math.floor(identity.message_limit ?? DEFAULT_EXECUTION_EVIDENCE_MESSAGE_LIMIT), 500))
  if (identity.signal?.aborted) return unavailable(identity, "aborted")
  const controller = new AbortController()
  const propagateAbort = () => controller.abort(identity.signal?.reason)
  const resolveAbort = () => { controller.abort(identity.signal?.reason); abortResolve?.("aborted") }
  identity.signal?.addEventListener("abort", propagateAbort, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  let abortResolve: ((value: "aborted") => void) | undefined
  try {
    const response = await Promise.race([
      client.session.messages({ path: { id: sessionId }, query: { ...(identity.directory ? { directory: identity.directory } : {}), limit: messageLimit }, responseStyle: "fields", throwOnError: false, signal: controller.signal }),
      new Promise<"timeout" | "aborted">((resolve) => {
        abortResolve = resolve
        timer = setTimeout(() => { controller.abort(); resolve("timeout") }, timeoutMs)
        identity.signal?.addEventListener("abort", resolveAbort, { once: true })
      }),
    ])
    if (response === "timeout") return unavailable(identity, "timeout")
    if (response === "aborted") return unavailable(identity, "aborted")
    const envelope = record(response)
    if (envelope?.error) return unavailable(identity, "sdk_error")
    const messages = envelope && Array.isArray(envelope.data) ? envelope.data : undefined
    if (!messages) return unavailable(identity, "invalid_response")
    const all: ExecutionCommandEvidence[] = []
    let foreignMessagesOmitted = 0
    for (const messageValue of messages) {
      const message = record(messageValue)
      const info = record(message?.info)
      if (typeof info?.sessionID === "string" && info.sessionID !== sessionId) { foreignMessagesOmitted++; continue }
      const messageId = typeof info?.id === "string" ? info.id : undefined
      const parts = Array.isArray(message?.parts) ? message.parts : []
      for (const partValue of parts) {
        const part = record(partValue)
        if (!part) continue
        if (typeof part.sessionID === "string" && part.sessionID !== sessionId) { foreignMessagesOmitted++; continue }
        const item = commandEvidence(part, messageId)
        if (item) all.push(item)
      }
    }
    let commands = all.slice(-MAX_EXECUTION_EVIDENCE_COMMANDS)
    let omittedCommands = Math.max(0, all.length - commands.length)
    const makeReceipt = () => ({
      version: 1, run_id: identity.run_id, node_id: identity.node_id, attempt: identity.attempt,
      child_session_id: sessionId, retrieval_status: "available", commands,
      omitted_commands: omittedCommands,
      window_may_be_incomplete: messages.length >= messageLimit,
      foreign_messages_omitted: foreignMessagesOmitted,
    })
    while (commands.length && serializedBytes(makeReceipt()) > MAX_EXECUTION_EVIDENCE_BYTES) {
      commands = commands.slice(1)
      omittedCommands++
    }
    return ExecutionEvidenceSchema.parse(makeReceipt())
  } catch {
    return unavailable(identity, "sdk_error")
  } finally {
    if (timer) clearTimeout(timer)
    identity.signal?.removeEventListener("abort", propagateAbort)
    identity.signal?.removeEventListener("abort", resolveAbort)
  }
}

/** Convert the host's shell-gate result into the same durable command-receipt shape. */
export function fromShellGateEvidence(
  cmd: string,
  result: ShellExecutionResult,
  identity: ExecutionEvidenceIdentity & { cwd?: string },
): ExecutionEvidence {
  const command = safeBounded(cmd, 4_096)
  const cwd = safeBounded(result.cwd || identity.cwd, 4_096)
  const stdout = safeBounded(result.stdout_tail, MAX_EXECUTION_EVIDENCE_OUTPUT_BYTES)
  const stderr = safeBounded(result.stderr_tail, MAX_EXECUTION_EVIDENCE_OUTPUT_BYTES)
  const merged = [stdout.text && `stdout:\n${stdout.text}`, stderr.text && `stderr:\n${stderr.text}`].filter(Boolean).join("\n")
  const output = safeBounded(merged, MAX_EXECUTION_EVIDENCE_OUTPUT_BYTES)
  const row = ExecutionCommandEvidenceSchema.parse({
    tool: "shell_gate", ...(command.text ? { command: command.text } : {}), ...(cwd.text ? { cwd: cwd.text } : {}),
    tool_status: result.ok ? "completed" : "error", exit_code: result.exit_code, exit_code_status: "reported",
    ...(output.text ? { output: output.text } : {}), output_truncated: output.truncated || stdout.truncated || stderr.truncated,
    command_truncated: command.truncated, cwd_truncated: cwd.truncated, gate_ok: result.ok,
    ...(result.timed_out ? { timed_out: true } : {}), ...(result.cancelled ? { cancelled: true } : {}),
    ...(result.setup_failed ? { setup_failed: true } : {}), ...(result.termination_failed ? { termination_failed: true } : {}),
  })
  return ExecutionEvidenceSchema.parse({
    version: 1, run_id: identity.run_id, node_id: identity.node_id, attempt: identity.attempt,
    retrieval_status: "available", commands: [row], omitted_commands: 0,
    window_may_be_incomplete: false, foreign_messages_omitted: 0,
  })
}

/** Bind a validated receipt to checker evidence under its shared entry/byte limits. */
export function appendHostExecutionEvidence<T extends { entries: unknown[]; omitted_entries: number }>(
  evidence: T | undefined,
  receipt: ExecutionEvidence,
  portPrefix = "host_execution",
): T | undefined {
  if (!evidence) return evidence
  const existing = evidence.entries
  if (existing.length >= 8) return { ...evidence, omitted_entries: evidence.omitted_entries + 1 }
  const entry = {
    port: `${portPrefix}_${receipt.node_id}`.slice(0, 64),
    source: { run_id: receipt.run_id, kind: "host_execution" as const, reference: receipt.node_id, attempt: receipt.attempt },
    status: "included" as "included" | "omitted",
    json_bytes: 0,
    json_sha256: "",
    value: receipt as ExecutionEvidence | undefined,
  }
  let checkerReceipt = receipt
  let json = JSON.stringify(checkerReceipt)
  while (Buffer.byteLength(json) > 4 * 1024 && checkerReceipt.commands.length) {
    checkerReceipt = { ...checkerReceipt, commands: checkerReceipt.commands.slice(1), omitted_commands: checkerReceipt.omitted_commands + 1 }
    json = JSON.stringify(checkerReceipt)
  }
  entry.json_bytes = Buffer.byteLength(json)
  entry.json_sha256 = createHash("sha256").update(json).digest("hex")
  if (entry.json_bytes <= 4 * 1024) entry.value = checkerReceipt
  else { entry.status = "omitted"; delete entry.value }
  const candidate = { ...evidence, entries: [...existing, entry] }
  if (Buffer.byteLength(JSON.stringify(candidate)) > 16 * 1024) {
    return { ...evidence, omitted_entries: evidence.omitted_entries + 1 }
  }
  return candidate
}

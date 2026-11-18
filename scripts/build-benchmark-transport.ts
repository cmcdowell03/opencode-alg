export type BenchmarkApi = (path: string, body?: unknown, ms?: number) => Promise<unknown>

export interface SendBenchmarkPromptOptions {
  api: BenchmarkApi
  sessionID: string
  body: unknown
  /** Absolute Unix time in milliseconds. */
  deadline: number
  cancelled: () => string | null
  pollIntervalMs?: number
}

export interface BenchmarkMessage {
  info?: Record<string, unknown>
  parts?: unknown[]
}

export type SendBenchmarkPromptResult =
  | { status: "completed"; userMessageID: string; assistant: BenchmarkMessage; acknowledgement: unknown }
  | { status: "model_error"; userMessageID: string; assistant: BenchmarkMessage; error: unknown; acknowledgement: unknown }
  | { status: "incomplete"; userMessageID: string; assistant: BenchmarkMessage; finish: string; acknowledgement: unknown }
  | { status: "deadline"; acknowledgement?: unknown; userMessageID?: string }
  | { status: "cancelled"; reason: string; acknowledgement?: unknown; userMessageID?: string }
  | { status: "dispatch_error"; error: string }
  | { status: "poll_error"; error: string }

const MAX_API_TIMEOUT_MS = 15_000
const DEFAULT_POLL_INTERVAL_MS = 1_000
const CANCELLATION_CHECK_INTERVAL_MS = 250

function asMessages(value: unknown): BenchmarkMessage[] {
  const candidate = Array.isArray(value) ? value :
    value && typeof value === "object" && Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data : []
  return candidate.filter((item): item is BenchmarkMessage => !!item && typeof item === "object" &&
    !!(item as BenchmarkMessage).info && typeof (item as BenchmarkMessage).info === "object")
}

function info(message: BenchmarkMessage): Record<string, unknown> { return message.info ?? {} }

function messageID(message: BenchmarkMessage): string | undefined {
  const id = info(message).id
  return typeof id === "string" && id.length > 0 ? id : undefined
}

function rootUserIDs(messages: readonly BenchmarkMessage[], sessionID: string): Set<string> {
  const ids = new Set<string>()
  for (const message of messages) {
    const value = info(message)
    const id = messageID(message)
    if (id && value.role === "user" && (value.sessionID === undefined || value.sessionID === sessionID)) ids.add(id)
  }
  return ids
}

function isMatchingTerminalAssistant(message: BenchmarkMessage, sessionID: string, userMessageID: string): boolean {
  const value = info(message)
  if (value.role !== "assistant" || value.parentID !== userMessageID) return false
  if (value.sessionID !== undefined && value.sessionID !== sessionID) return false
  if (value.summary === true) return false
  if (value.error !== undefined && value.error !== null) return true
  if (typeof value.time !== "object" || value.time === null || !Number.isFinite((value.time as { completed?: unknown }).completed)) return false
  const finish = typeof value.finish === "string" ? value.finish.toLowerCase().replaceAll("_", "-") : ""
  if (finish === "tool-calls") return false
  const runningTool = (message.parts ?? []).some(part => {
    if (!part || typeof part !== "object" || (part as { type?: unknown }).type !== "tool") return false
    const state = (part as { state?: unknown }).state
    const status = state && typeof state === "object" ? (state as { status?: unknown }).status : undefined
    return status === "pending" || status === "running"
  })
  return !runningTool
}

function cancellationReason(cancelled: () => string | null): string | null {
  try { return cancelled() || null }
  catch (error) { return `cancellation check failed: ${error instanceof Error ? error.message : String(error)}` }
}

function boundedTimeout(deadline: number): number {
  const remaining = deadline - Date.now()
  return remaining > 0 ? Math.min(MAX_API_TIMEOUT_MS, Math.floor(remaining)) : 0
}

async function delayWithCancellation(
  deadline: number,
  pollIntervalMs: number,
  cancelled: () => string | null,
): Promise<{ reason?: string; expired: boolean }> {
  const stopAt = Math.min(deadline, Date.now() + pollIntervalMs)
  while (Date.now() < stopAt) {
    const reason = cancellationReason(cancelled)
    if (reason) return { reason, expired: false }
    const remaining = stopAt - Date.now()
    await new Promise<void>(resolve => setTimeout(resolve, Math.min(CANCELLATION_CHECK_INTERVAL_MS, remaining)))
  }
  const reason = cancellationReason(cancelled)
  if (reason) return { reason, expired: false }
  return { expired: Date.now() >= deadline }
}

/**
 * Dispatch through OpenCode's prompt_async endpoint and poll root messages for
 * the matching terminal assistant. A 204 response only acknowledges dispatch.
 */
export async function sendBenchmarkPrompt(options: SendBenchmarkPromptOptions): Promise<SendBenchmarkPromptResult> {
  const { api, sessionID, body, deadline, cancelled } = options
  if (!sessionID.trim()) throw new Error("sessionID must not be empty")
  if (!Number.isFinite(deadline)) throw new Error("deadline must be an absolute finite timestamp in milliseconds")
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) throw new Error("pollIntervalMs must be positive")

  const sessionPath = `/session/${encodeURIComponent(sessionID)}`
  const listPath = `${sessionPath}/message`
  const dispatchPath = `${sessionPath}/prompt_async`
  let reason = cancellationReason(cancelled)
  if (reason) return { status: "cancelled", reason }
  let timeoutMs = boundedTimeout(deadline)
  if (timeoutMs < 1) return { status: "deadline" }

  let before: BenchmarkMessage[]
  try {
    before = asMessages(await api(listPath, undefined, timeoutMs))
  } catch (error) {
    reason = cancellationReason(cancelled)
    if (reason) return { status: "cancelled", reason }
    return Date.now() >= deadline ? { status: "deadline" } : {
      status: "dispatch_error", error: `message snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  const existingRootIDs = rootUserIDs(before, sessionID)
  reason = cancellationReason(cancelled)
  if (reason) return { status: "cancelled", reason }
  timeoutMs = boundedTimeout(deadline)
  if (timeoutMs < 1) return { status: "deadline" }

  let acknowledgement: unknown
  try {
    acknowledgement = await api(dispatchPath, body, timeoutMs)
  } catch (error) {
    reason = cancellationReason(cancelled)
    if (reason) return { status: "cancelled", reason }
    return Date.now() >= deadline ? { status: "deadline" } : {
      status: "dispatch_error", error: `prompt_async failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  while (true) {
    reason = cancellationReason(cancelled)
    if (reason) return { status: "cancelled", reason, acknowledgement }
    if (Date.now() >= deadline) return { status: "deadline", acknowledgement }

    let messages: BenchmarkMessage[]
    try {
      timeoutMs = boundedTimeout(deadline)
      if (timeoutMs < 1) return { status: "deadline", acknowledgement }
      messages = asMessages(await api(listPath, undefined, timeoutMs))
    } catch (error) {
      reason = cancellationReason(cancelled)
      if (reason) return { status: "cancelled", reason, acknowledgement }
      if (Date.now() >= deadline) return { status: "deadline", acknowledgement }
      return { status: "poll_error", error: `message poll failed after dispatch: ${error instanceof Error ? error.message : String(error)}` }
    }

    reason = cancellationReason(cancelled)
    if (reason) return { status: "cancelled", reason, acknowledgement }
    const newUsers = messages.filter(message => {
      const value = info(message)
      const id = messageID(message)
      return value.role === "user" && id !== undefined && !existingRootIDs.has(id) &&
        (value.sessionID === undefined || value.sessionID === sessionID)
    })
    for (const user of newUsers) {
      const userMessageID = messageID(user)!
      const terminal = messages.find(message => isMatchingTerminalAssistant(message, sessionID, userMessageID))
      if (!terminal) continue
      const terminalInfo = info(terminal)
      if (terminalInfo.error !== undefined && terminalInfo.error !== null) {
        return { status: "model_error", userMessageID, assistant: terminal, error: terminalInfo.error, acknowledgement }
      }
      if(terminalInfo.finish!=="stop")return { status:"incomplete",userMessageID,assistant:terminal,finish:typeof terminalInfo.finish==="string"?terminalInfo.finish:"unknown",acknowledgement }
      return { status: "completed", userMessageID, assistant: terminal, acknowledgement }
    }

    if (Date.now() >= deadline) return { status: "deadline", acknowledgement, userMessageID: newUsers.at(-1) ? messageID(newUsers.at(-1)!) : undefined }
    const delayed = await delayWithCancellation(deadline, pollIntervalMs, cancelled)
    if (delayed.reason) return { status: "cancelled", reason: delayed.reason, acknowledgement,
      ...(newUsers.at(-1) ? { userMessageID: messageID(newUsers.at(-1)!) } : {}) }
    if (delayed.expired) return { status: "deadline", acknowledgement,
      ...(newUsers.at(-1) ? { userMessageID: messageID(newUsers.at(-1)!) } : {}) }
  }
}

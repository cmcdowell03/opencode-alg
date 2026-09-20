/** Host-level completion, independent of provider/model identity. */
export function isCompletedUserTurn(info: any): boolean {
  return info?.role === "assistant" && info.summary !== true && info.error === undefined &&
    info.finish === "stop" && Number.isSafeInteger(info.time?.completed) && info.time.completed >= 0
}

export function mentionsSkill(text: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-z0-9._-])${escaped}($|[^a-z0-9._-])`, "i").test(text)
}

/** Last copy of each message wins. Never mix users, sessions, summaries or future steps. */
export function completedTurn(messages: Array<{ info?: any; parts?: any[] }>, sessionId: string, messageId: string, legacy = false) {
  const unique = [...new Map(messages.map((message) => [message.info?.id, message])).values()]
  const terminal = unique.find((message) => message.info?.id === messageId)
  const info = terminal?.info
  if (!terminal || info?.sessionID !== sessionId || (!isCompletedUserTurn(info) &&
    !(legacy && info?.finish === undefined && info?.role === "assistant" && !info.summary && info.error === undefined && Number.isSafeInteger(info.time?.completed)))) {
    throw new Error("assistant message is not a completed user turn")
  }
  const user = unique.find((message) => message.info?.id === info.parentID && message.info?.role === "user")
  if (!user || user.info?.sessionID !== sessionId) throw new Error("assistant parent user message is unavailable")
  const steps = unique.filter((message) => message.info?.role === "assistant" && message.info.sessionID === sessionId &&
    message.info.parentID === info.parentID && message.info.summary !== true &&
    Number.isSafeInteger(message.info.time?.completed) && message.info.time.completed <= info.time.completed)
    .sort((a, b) => a.info.time.created - b.info.time.created || String(a.info.id).localeCompare(String(b.info.id)))
  return { terminal, user, steps, parts: steps.flatMap((step) => step.parts ?? []) }
}

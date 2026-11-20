import type { SessionContext } from "@opencode/plugin/promise/session"
import { TOOL } from "./host.ts"
import type { ResearchProcedure } from "./procedure.ts"

type Procedure = NonNullable<Awaited<ReturnType<ResearchProcedure["current"]>>>

function compactReceipt(text: string, current: Procedure, runtimeSha256: string, reference: string): string | undefined {
  try {
    const receipt = JSON.parse(text)
    const procedure = receipt?.procedure
    if (receipt?.ok !== true || receipt.runtimeSha256 !== runtimeSha256 ||
        procedure?.id !== current.id || procedure.path !== current.path ||
        procedure.sha256 !== current.sha256 || procedure.sourceSha256 !== current.sourceSha256 ||
        procedure.name !== current.name || procedure.content !== current.content ||
        JSON.stringify(receipt) !== text) return undefined
    // The tool emits canonical JSON. Replacing this one field preserves the rest verbatim.
    return JSON.stringify({ ...receipt, procedure: { ...procedure, content: reference } })
  } catch {
    return undefined
  }
}

/** Called only after the verified full procedure has been projected into this owner request. */
export function compactProcedureReads(request: SessionContext, current: Procedure, runtimeSha256: string): void {
  const reference = "[Exact procedure body already supplied in this request under SHA-256 " + current.sha256 + ".]"
  const calls = new Map<string, boolean>()
  let haveFullRead = false
  let messages: SessionContext["messages"] | undefined
  for (const [messageIndex, message] of request.messages.entries()) {
    if (message.role === "assistant") {
      for (const part of message.content) {
        if (part.type === "compaction") {
          haveFullRead = false
          calls.clear()
        }
        if (part.type !== "tool-call") continue
        calls.set(part.id, !calls.has(part.id) && part.name === TOOL && part.namespace === undefined &&
          part.providerExecuted !== true && typeof part.input === "object" && part.input !== null &&
          Object.hasOwn(part.input, "action") && Reflect.get(part.input, "action") === "procedure")
      }
    }
    if (message.role !== "tool") continue
    let content: typeof message.content[number][] | undefined
    for (const [partIndex, part] of message.content.entries()) {
      if (part.name !== TOOL || part.namespace !== undefined || part.providerExecuted === true ||
          calls.get(part.id) !== true) continue
      calls.set(part.id, false)
      if (part.result.type !== "text" || typeof part.result.value !== "string") continue
      const replacement = compactReceipt(part.result.value, current, runtimeSha256, reference)
      if (replacement === undefined) continue
      if (!haveFullRead) {
        // The first retained read stays full even if the visible window starts after compaction.
        haveFullRead = true
        continue
      }
      if (Buffer.byteLength(replacement) >= Buffer.byteLength(part.result.value)) continue
      content ??= [...message.content]
      content[partIndex] = { ...part, result: { ...part.result, value: replacement } }
    }
    if (content) {
      messages ??= [...request.messages]
      messages[messageIndex] = { ...message, content }
    }
  }
  if (messages) request.messages = messages
}

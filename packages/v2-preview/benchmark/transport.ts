import { summaryHash, type RequestObservation } from "./compaction.ts"
import { calculatedFieldCount, investigationSchema } from "./input-usage.ts"

export const maxProviderCalls = 36
export const maxProviderBytes = 192 * 1024
export type Message = { role?: string; content?: unknown; wireSource?: "responses.instructions"; tool_calls?: { function?: { name?: string } }[] }
export type Completion = { text: string; pressure?: number; reason?: string } | { tool: string; args: Record<string, unknown> }
export type TurnInput = { messages: Message[]; tools: string[]; summary: boolean }
export const summarySignature = /<template>\s*## Objective[\s\S]{0,900}## Decisions[\s\S]{0,900}## Work State/
export const textOf = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value) ?? ""
const normalize = (text: string) => text.replace(/\s+/g, " ").trim()
export const includes = (text: string, witness: string | undefined) =>
  !!witness && normalize(text).includes(normalize(witness))

export function startTransport(options: {
  id: string; seed: number; decide: (turn: TurnInput) => Completion
  classify: (messages: Message[], requestId: number) => Pick<RequestObservation, "role" | "phase">
  stale: string; correction: string; skill: () => string | undefined
}) {
  const requests: RequestObservation[] = []
  let baselineSummary: string | undefined
  let held: RequestObservation | undefined
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let released = false
  const releaseSummary = () => { released = true; release() }
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, development: false, idleTimeout: 120,
    maxRequestBodySize: maxProviderBytes,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: options.id, object: "model", created: 1, owned_by: "benchmark" }] })
      }
      if (request.method !== "POST" || path !== "/v1/chat/completions") return new Response(null, { status: 404 })
      if (requests.length >= maxProviderCalls) return new Response(null, { status: 429 })
      const id = requests.length + 1
      const receipt: RequestObservation = {
        id, kind: "ordinary", role: "other", phase: null, startedAtMs: performance.now(), finishedAtMs: null,
        stale: false, oldSummary: false, correction: false, skill: false, tools: [], status: null,
      }
      requests.push(receipt)
      function respond(response: Response) {
        receipt.status = response.status
        receipt.finishedAtMs = performance.now()
        return response
      }
      try {
        const bytes = await request.arrayBuffer()
        receipt.requestBytes = bytes.byteLength
        const body = JSON.parse(new TextDecoder().decode(bytes)) as {
          model?: string; messages?: Message[]; tools?: { function?: { name?: string }; name?: string }[]
          stream?: boolean; max_tokens?: number; max_completion_tokens?: number
        }
        if (body.model !== options.id || !Array.isArray(body.messages)) return respond(new Response(null, { status: 400 }))
        receipt.tools = (body.tools ?? []).flatMap(tool => tool.function?.name ?? tool.name ?? [])
        receipt.investigationSchema = investigationSchema(body.tools)
        receipt.calculatedFieldCount = calculatedFieldCount(body.messages)
        const content = body.messages.map(message => textOf(message.content))
        const text = content.join("\n")
        const summary = content.some(value => summarySignature.test(value))
        receipt.kind = summary ? "summary" : "ordinary"
        // Only the Responses adapter can identify a top-level instructions field.
        Object.assign(receipt, options.classify(body.messages.map(({ role, content, tool_calls }) => ({ role, content, tool_calls })), id))
        receipt.stale = text.includes(options.stale)
        receipt.correction = text.includes(options.correction)
        receipt.oldSummary = content.some(value => includes(value, baselineSummary))
        receipt.skill = content.some(value => includes(value, options.skill()))
        if (summary && receipt.role === "root" && receipt.stale && !receipt.correction && !held && !released) {
          held = receipt
          await gate
        }
        const completion = options.decide({ messages: body.messages, tools: receipt.tools, summary })
        if (!completion || ("tool" in completion && !receipt.tools.includes(completion.tool)))
          return respond(new Response(null, { status: 400 }))
        if ("text" in completion) {
          receipt.scriptOutcome = completion.reason ?? (completion.pressure ? "pressure_" + completion.pressure : "text")
          if (summary) {
            receipt.summaryResponseSha256 = summaryHash(completion.text)
            receipt.summaryReturnsStale = completion.text.includes(options.stale)
            if (receipt === held) baselineSummary = completion.text
          }
        }
        return respond(scriptedResponse(body.stream, options.id, `bench-${options.seed}-${id}`, completion))
      } catch {
        return respond(new Response(null, { status: 502 }))
      }
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`, requests, held: () => held, releaseSummary,
    observeApplied: (summary: string) => { baselineSummary = summary },
    stop() { releaseSummary(); server.stop(true) },
  }
}

function scriptedResponse(stream: boolean | undefined, model: string, id: string, completion: Completion) {
  const base = { id, created: 1, model }
  const input = ("text" in completion && completion.pressure) || 1100
  const usage = { prompt_tokens: input, completion_tokens: 48, total_tokens: input + 48 }
  const finish_reason = "tool" in completion ? "tool_calls" : "stop"
  const delta = "tool" in completion
    ? { tool_calls: [{ index: 0, id, type: "function", function: { name: completion.tool, arguments: JSON.stringify(completion.args) } }] }
    : { content: completion.text }
  if (!stream) return Response.json({ ...base, object: "chat.completion", usage,
    choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason }] })
  const chunk = (choices: unknown[], tokens?: typeof usage) =>
    `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices, ...(tokens && { usage: tokens }) })}\n\n`
  return new Response(chunk([{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }]) +
    chunk([{ index: 0, delta: {}, finish_reason }]) + chunk([], usage) + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } })
}

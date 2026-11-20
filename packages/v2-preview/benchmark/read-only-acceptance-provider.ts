import { asObject } from "../acceptance/host.ts"
import { maxProviderBytes, summarySignature, textOf, type Completion, type Message } from "./transport.ts"

export const model = { providerID: "read-only-fixture", id: "fixture" }
export const summaryText = "## Objective\nPreserve the investigation checkpoint.\n## Decisions\nRefer to the host ledger.\n## Work State\nAwait a follow-up request."
export const endText = "Fixture turn complete."

export function startReadOnlyProvider() {
  const requests: {
    phase: string; summary: boolean; messages: Message[];
    tools: Map<string, Record<string, unknown>>; completion: Completion;
  }[] = []
  let phase = ""
  let queue: Completion[] = []
  let failure: string | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, development: false, maxRequestBodySize: maxProviderBytes,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path === "/v1/models")
        return Response.json({ object: "list", data: [{ id: model.id, object: "model", created: 1, owned_by: "fixture" }] })
      if (request.method !== "POST" || path !== "/v1/chat/completions")
        return new Response(null, { status: 404 })
      try {
        const body = asObject(await request.json())
        if (body?.model !== model.id || !Array.isArray(body.messages) || requests.length >= 64)
          throw new Error("Unexpected provider request or request budget exhausted")
        const messages = body.messages as Message[]
        const summary = messages.some(message => summarySignature.test(textOf(message.content)))
        const tools = new Map<string, Record<string, unknown>>()
        for (const item of Array.isArray(body.tools) ? body.tools : []) {
          const tool = asObject(asObject(item)?.function)
          const parameters = asObject(tool?.parameters)
          if (typeof tool?.name !== "string" || !parameters || tools.has(tool.name))
            throw new Error("Unexpected model-facing tool schema")
          tools.set(tool.name, parameters)
        }
        if (summary !== (phase === "compaction")) throw new Error("Unexpected generation kind")
        const completion = queue.shift()
        if (!completion) throw new Error(`Unscheduled model generation during ${phase}: ${JSON.stringify({
          tools: [...tools.keys()], messages: messages.map(message => [message.role, textOf(message.content).slice(0, 300)]),
        })}`)
        // Deliberately permit the fixture model to emit unadvertised calls. OpenCode must reject them.
        requests.push({ phase, summary, messages, tools, completion })
        return wireResponse(body.stream === true, requests.length, completion)
      } catch (error) {
        failure ??= String(error)
        return new Response(failure, { status: 409 })
      }
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`, requests,
    plan(label: string, steps: Completion[]) {
      this.assertDone()
      phase = label
      queue = [...steps]
    },
    assertDone() {
      if (failure || queue.length) throw new Error(failure ?? `Unfinished provider plan for ${phase}`)
    },
    assertHealthy() { if (failure) throw new Error(failure) },
    stop() { server.stop(true) },
  }
}

function wireResponse(stream: boolean, sequence: number, completion: Completion) {
  const id = "read-only-fixture-" + sequence
  const base = { id, model: model.id, created: 1 }
  const usage = { prompt_tokens: 1100, completion_tokens: 24, total_tokens: 1124 }
  const finish_reason = "tool" in completion ? "tool_calls" : "stop"
  const delta = "tool" in completion
    ? { tool_calls: [{ index: 0, id, type: "function",
      function: { name: completion.tool, arguments: JSON.stringify(completion.args) } }] }
    : { content: completion.text }
  if (!stream) return Response.json({ ...base, object: "chat.completion", usage,
    choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason }] })
  const chunk = (choices: unknown[], tokens?: typeof usage) =>
    `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices, ...(tokens && { usage: tokens }) })}\n\n`
  return new Response(chunk([{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }]) +
    chunk([{ index: 0, delta: {}, finish_reason }]) + chunk([], usage) + "data: [DONE]\n\n",
  { headers: { "content-type": "text/event-stream" } })
}

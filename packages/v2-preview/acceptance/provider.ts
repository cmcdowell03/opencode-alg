import { randomUUID } from "node:crypto"

type Message = { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }
type Tool = { function?: { name?: string }; name?: string }
type Completion = { tool: string; args: Record<string, unknown> } | { text: string }

export interface ProviderTurn {
  messages: readonly Message[]
  tools: readonly string[]
}

/** Local OpenAI-compatible transport for a scripted exchange. No model runs. */
export function startProvider(decide: (turn: ProviderTurn) => Completion | Promise<Completion>) {
  let calls = 0
  const errors: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    development: false,
    maxRequestBodySize: 512 * 1024,
    idleTimeout: 45,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "fixture", object: "model", created: 1, owned_by: "local" }] })
      }
      if (request.method !== "POST" || path !== "/v1/chat/completions") return new Response(null, { status: 404 })
      if (++calls > 100) return Response.json({ error: { message: "Fixture request bound reached" } }, { status: 429 })
      try {
        const body = await request.json() as { model?: string; messages?: Message[]; tools?: Tool[]; stream?: boolean }
        if (body.model !== "fixture" || !Array.isArray(body.messages)) throw new Error("Unexpected model or messages")
        const tools = body.tools?.flatMap(tool => {
          const name = tool.function?.name ?? tool.name
          return name ? [name] : []
        }) ?? []
        const choice = await decide({ messages: body.messages, tools })
        const id = `fixture-${randomUUID()}`
        const base = { id, created: 1, model: body.model }
        const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
        const finish_reason = "tool" in choice ? "tool_calls" : "stop"
        if ("tool" in choice && !tools.includes(choice.tool)) throw new Error(`Tool unavailable: ${choice.tool}`)
        const delta = "tool" in choice
          ? { tool_calls: [{ index: 0, id, type: "function", function: { name: choice.tool, arguments: JSON.stringify(choice.args) } }] }
          : { content: choice.text }
        if (!body.stream) {
          return Response.json({ ...base, object: "chat.completion", usage,
            choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason }] })
        }
        const chunk = (choices: unknown[], tokens?: typeof usage) =>
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices, ...(tokens && { usage: tokens }) })}\n\n`
        return new Response(
          chunk([{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }]) +
          chunk([{ index: 0, delta: {}, finish_reason }]) + chunk([], usage) + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      } catch (error) {
        const message = (error instanceof Error ? error.message : "Unknown fixture error").slice(0, 160)
        if (errors.length < 10) errors.push(message)
        return Response.json({ error: { message, type: "fixture_protocol" } }, { status: 400 })
      }
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, errors, get calls() { return calls }, stop: () => server.stop(true) }
}

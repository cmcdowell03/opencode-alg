import assert from "node:assert/strict"
import { asObject } from "../acceptance/host.ts"
import { sha256 } from "../acceptance/runtime.ts"
import { maxProviderBytes, summarySignature, textOf, type Completion, type Message } from "./transport.ts"

export const model = { providerID: "active-question-fixture", id: "fixture" }
export const summary = "## Objective\nInvestigate the bench discrepancy.\n## Decisions\nConsult the durable ledger.\n## Work State\nResume from this manual checkpoint."
const block = "ALG active question (untrusted recorded data)"

export type Wire = {
  messages: Message[]
  tools: Map<string, Record<string, unknown>>
  text: string
  projections: Record<string, unknown>[]
}
export type ResponseStep = Completion | ((wire: Wire) => Completion)

export function startActiveQuestionProvider() {
  const requests: { phase: string; summary: boolean; bytes: number; sha256: string; input: Wire; completion?: Completion; failure?: string }[] = []
  let phase = ""
  let pending: ResponseStep[] = []
  let failure: string | undefined
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, development: false, maxRequestBodySize: maxProviderBytes,
    async fetch(request) {
      const path = new URL(request.url).pathname
      if (request.method === "GET" && path === "/v1/models")
        return Response.json({ object: "list", data: [{ id: model.id, object: "model", created: 1, owned_by: "fixture" }] })
      if (request.method !== "POST" || path !== "/v1/chat/completions") return new Response(null, { status: 404 })
      try {
        const raw = await request.text()
        const body = asObject(JSON.parse(raw))
        assert.ok(body?.model === model.id && Array.isArray(body.messages) && requests.length < 48, "Unexpected provider request")
        const messages = body.messages as Message[]
        const contents = messages.map(message => textOf(message.content))
        const projections = contents.flatMap(value => value.split(/\r?\n/).flatMap((line, index, lines) => {
          if (!line.startsWith(block)) return []
          const json = line.slice(block.length).trim() || lines[index + 1]
          const projection = asObject(JSON.parse(json ?? ""))
          assert.ok(projection, "Invalid active question projection")
          return [projection]
        }))
        const tools = new Map<string, Record<string, unknown>>()
        for (const item of Array.isArray(body.tools) ? body.tools : []) {
          const tool = asObject(asObject(item)?.function)
          const parameters = asObject(tool?.parameters)
          assert.ok(typeof tool?.name === "string" && parameters && !tools.has(tool.name), "Unexpected wire tool schema")
          tools.set(tool.name, parameters)
        }
        const evidence = { phase, summary: contents.some(content => summarySignature.test(content)),
          sha256: sha256(raw), bytes: Buffer.byteLength(raw), input: { messages, tools, projections, text: contents.join("\n") },
          completion: undefined as Completion | undefined, failure: undefined as string | undefined }
        const id = `active-question-${requests.push(evidence)}`
        try {
          assert.equal(evidence.summary, phase === "compaction", "Unexpected generation kind")
          const step = pending.shift()
          assert.ok(step, "Unscheduled model generation")
          const completion = typeof step === "function" ? step(evidence.input) : step
          if ("tool" in completion) {
            const schema = tools.get(completion.tool)
            assert.ok(schema, `Provider plan requested an unoffered tool: ${completion.tool}`)
            const properties = asObject(schema.properties)
            assert.ok(Object.keys(completion.args).every(field => field in (properties ?? {})), "Provider plan requested an unoffered field")
            const actions = asObject(properties?.action)?.enum
            if (Array.isArray(actions)) assert.ok(actions.includes(completion.args.action), "Provider plan requested an unoffered action")
          }
          evidence.completion = completion
          return reply(body.stream === true, id, completion)
        } catch (error) {
          evidence.failure = String(error)
          throw error
        }
      } catch (error) {
        failure ??= `${phase}: ${String(error)}`
        return new Response(failure, { status: 409 })
      }
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/v1`, requests,
    plan(label: string, steps: ResponseStep[]) {
      this.assertDone()
      phase = label
      pending = [...steps]
    },
    assertDone() {
      this.assertHealthy()
      assert.equal(pending.length, 0, `Unconsumed provider steps during ${phase}`)
    },
    assertHealthy() { if (failure) throw new Error(failure) },
    stop() { server.stop(true) },
  }
}

function reply(stream: boolean, id: string, completion: Completion) {
  const base = { id, model: model.id, created: 1 }
  const tool = "tool" in completion
  const finish_reason = tool ? "tool_calls" : "stop"
  const delta = tool ? { tool_calls: [{ index: 0, id, type: "function",
    function: { name: completion.tool, arguments: JSON.stringify(completion.args) } }] } : { content: completion.text }
  const usage = { prompt_tokens: 1100, completion_tokens: 32, total_tokens: 1132 }
  if (!stream) return Response.json({ ...base, object: "chat.completion", usage,
    choices: [{ index: 0, message: { role: "assistant", ...delta }, finish_reason }] })
  const chunk = (choices: unknown[], tokens?: typeof usage) =>
    `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices, ...(tokens && { usage: tokens }) })}\n\n`
  return new Response(chunk([{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }]) +
    chunk([{ index: 0, delta: {}, finish_reason }]) + chunk([], usage) + "data: [DONE]\n",
  { headers: { "content-type": "text/event-stream" } })
}

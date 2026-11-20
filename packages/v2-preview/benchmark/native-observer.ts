import { createHash, randomBytes } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { Plugin } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { SessionHttpRequest, SessionHttpResponse } from "@opencode/plugin/promise/session"
import type { RequestObservation } from "./compaction.ts"
import { limitsFor, nativeModel, type NativeProfile } from "./native-provider.ts"
import type { Message } from "./transport.ts"
import { wireTextParts } from "./skill-delivery.ts"
import { calculatedFieldCount, investigationSchema } from "./input-usage.ts"

export const nativeObserverID = "paired-benchmark-native-observer"
const endpoint = "https://chatgpt.com/backend-api/codex/responses"
const normalize = (text: string) => text.replace(/\s+/g, " ").trim()
export const nativeSummaryHash = (text: string) => createHash("sha256").update(normalize(text)).digest("hex")
const hasText = (text: string, witness: string | undefined) => !!witness?.trim() && normalize(text).includes(normalize(witness))
type Usage = { input: number; output: number; total: number; cachedInput?: number | null; reasoningOutput?: number | null }
type NativeObservation = RequestObservation & {
  sessionID: string
  agent?: string
  dispatchAtMs: number | null
  requestBytes: number
  responseBytes: number | null
  httpStatus: number | null
  media: ReturnType<typeof responseMedia> | null
  usage: Usage | null
  summaryResponseSha256: string | null
}
type Beginning = {
  sessionID: string; kind: "primary" | "compaction"; bytes: number
  agent?: string
  messages: Message[]; tools: string[]
  investigationSchema: ReturnType<typeof investigationSchema>
}
type Terminal = { status: number; bytes: number; usage: Usage | null; summary?: string
  httpStatus?: number; media?: ReturnType<typeof responseMedia>; invalidFraming?: boolean; outputBudgetExhausted?: boolean
  streamLimit?: "response-bytes" | "output-delta" }

function responseMedia(headers: Headers) {
  const mime = headers.get("content-type")?.split(";")[0]?.trim().toLowerCase()
  switch (mime) {
    case undefined: case "": return "missing"
    case "text/event-stream": return "sse"
    case "text/plain": return "text"
    case "application/octet-stream": return "binary"
    case "application/json": return "json"
    case "text/html": return "html"
    default: return "other"
  }
}
type Brief = Pick<SessionHttpRequest, "model" | "kind" | "sessionID">

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function responseUsage(value: unknown, profile?: NativeProfile): Usage | null {
  const row = record(value)
  if (!row || !count(row.input_tokens) || !count(row.output_tokens) || !count(row.total_tokens) ||
      row.total_tokens !== row.input_tokens + row.output_tokens || row.total_tokens === 0) return null
  const usage: Usage = { input: row.input_tokens, output: row.output_tokens, total: row.total_tokens }
  if (profile) {
    const cached = record(row.input_tokens_details)?.cached_tokens
    const reasoning = record(row.output_tokens_details)?.reasoning_tokens
    usage.cachedInput = count(cached) && cached <= usage.input ? cached : null
    usage.reasoningOutput = count(reasoning) && reasoning <= usage.output ? reasoning : null
  }
  return usage
}

export function readNativeCompletion(event: unknown, summary: boolean, profile?: NativeProfile) {
  const row = record(event)
  if (row?.type !== "response.completed" && row?.type !== "response.incomplete" &&
      row?.type !== "response.failed" && row?.type !== "error") return undefined
  const response = record(row.response)
  const usage = responseUsage(response?.usage, profile)
  const output = Array.isArray(response?.output) ? response.output : []
  const text = output.flatMap(value => {
    const item = record(value)
    if (item?.type !== "message" || item.role !== "assistant" || !Array.isArray(item.content)) return []
    return item.content.flatMap(part => {
      const entry = record(part)
      return entry?.type === "output_text" && typeof entry.text === "string" ? [entry.text] : []
    })
  }).join("")
  return { status: row.type === "response.completed" && usage ? 200 : 502, usage,
    ...(profile && row.type === "response.incomplete" && record(response?.incomplete_details)?.reason === "max_output_tokens" &&
      { outputBudgetExhausted: true }),
    ...(summary && text ? { summary: text } : {}) }
}

export function nativeBody(text: string, id: string, profile?: NativeProfile) {
  const body = record(JSON.parse(text))
  if (!body || body.model !== id || body.stream !== true || !Array.isArray(body.input) ||
      (body.tools !== undefined && !Array.isArray(body.tools)))
    throw new Error("NATIVE_RESPONSES_SHAPE_UNAVAILABLE")
  const tools = (body.tools ?? []).map((value: unknown) => {
    const tool = record(value)
    if (tool?.type !== "function" || typeof tool.name !== "string") throw new Error("NATIVE_HOSTED_TOOL_BLOCKED")
    return tool.name
  })
  const messages: Message[] = body.input.flatMap(value => {
    const row = record(value)
    if (!row) return []
    const tool = row.type === "function_call_output" || row.type === "custom_tool_call_output"
    if (!tool && row.type !== "message" && row.type !== undefined) return []
    const parts = wireTextParts(tool ? row.output : row.content)
    return [{ role: tool ? "tool" : typeof row.role === "string" ? row.role : undefined,
      content: parts.length === 1 ? parts[0] : parts.map(text => ({ type: "text", text })) }]
  })
  if (typeof body.instructions === "string") messages.unshift({ wireSource: "responses.instructions", content: body.instructions })
  // The pinned OAuth hook removes maxTokens for the Codex endpoint. Keep its wire format.
  const bytes = Buffer.byteLength(text)
  if (bytes > limitsFor(profile).requestBytes) throw new Error("NATIVE_REQUEST_BYTES_EXCEEDED")
  return { bytes, messages, tools, investigationSchema: investigationSchema(body.tools) }
}

export function startNativeObserver(options: {
  id: string; classify: (messages: Message[], requestId: number) => Pick<RequestObservation, "role" | "phase">
  stale: string; correction: string; skill: () => string | undefined
  profile?: NativeProfile
  allowedTools?: { root: readonly string[]; checker: readonly string[] }
  requiredTools?: { root: readonly string[]; checker: readonly string[] }
  allowedAgents?: { root: string; checker: string }
  onReceipt?: (row: Readonly<NativeObservation>, stage: "admission" | "terminal") => Promise<void>
}) {
  nativeModel("openai/" + options.id)
  const limits = limitsFor(options.profile)
  const requests: NativeObservation[] = []
  const key = randomBytes(24).toString("hex")
  const deadline = performance.now() + limits.armMs
  let pending: NativeObservation | undefined, baselineSummary: string | undefined
  let root: string | undefined, checker: string | undefined, problem: string | null = null
  let requestBytes = 0, responseBytes = 0, outputTokens = 0, outstanding = 0
  const readyPids = new Set<number>()
  let released = false
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const releaseSummary = () => { released = true; release() }
  const fail = (why: string) => { problem ??= why; releaseSummary(); return new Response(null, { status: 409 }) }
  const timer = setTimeout(() => { fail("NATIVE_ARM_DEADLINE") }, limits.armMs)
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, idleTimeout: 120, development: false,
    maxRequestBodySize: 2 * limits.requestBytes + limits.responseBytes,
    async fetch(request) {
      if (request.method !== "POST" || request.headers.get("authorization") !== "Bearer " + key)
        return new Response(null, { status: 404 })
      if (performance.now() >= deadline) return fail("NATIVE_ARM_DEADLINE")
      switch (new URL(request.url).pathname) {
        case "/ready": {
          const pid = await request.json()
          if (!count(pid) || pid === 0) return fail("NATIVE_OBSERVER_PID_INVALID")
          readyPids.add(pid)
          return new Response(null, { status: 204 })
        }
        case "/fail": {
          const why = await request.json()
          return fail(typeof why === "string" && /^NATIVE_[A-Z0-9_]+$/.test(why) ? why : "NATIVE_OBSERVER_FAILED")
        }
        case "/begin": {
          const input = await request.json() as Beginning
          if (problem) return fail(problem)
          const role = input.sessionID === root ? "root" : input.sessionID === checker ? "checker" : "other"
          if (role === "other") return fail("NATIVE_UNBOUND_SESSION")
          if (options.allowedAgents && input.agent !== options.allowedAgents[role])
            return fail("NATIVE_AGENT_IDENTITY_MISMATCH")
          if (options.profile && input.kind !== "primary") return fail("NATIVE_DISCOVERY_NONPRIMARY_BLOCKED")
          if (input.kind === "compaction" && role !== "root") return fail("NATIVE_AUXILIARY_COMPACTION_BLOCKED")
          const allowedTools = options.allowedTools?.[role]
          if ((allowedTools && input.tools.some(tool => !allowedTools.includes(tool))) ||
              options.requiredTools?.[role].some(tool => !input.tools.includes(tool)))
            return fail("NATIVE_TOOL_SCOPE_UNEXPECTED")
          if (requests.length >= limits.calls) return fail("NATIVE_PROVIDER_CALL_BUDGET")
          if (outputTokens + (outstanding + 1) * limits.outputTokens > limits.armOutputTokens)
            return fail("NATIVE_OUTPUT_RESERVATION_EXCEEDED")
          if (responseBytes + (outstanding + 1) * limits.responseBytes > limits.armResponseBytes)
            return fail("NATIVE_RESPONSE_RESERVATION_EXCEEDED")
          if (!count(input.bytes) || input.bytes > limits.requestBytes || requestBytes + input.bytes > limits.armRequestBytes)
            return fail("NATIVE_REQUEST_BYTES_EXCEEDED")
          requestBytes += input.bytes
          outstanding++
          const contents = input.messages.map(message => wireTextParts(message.content).join("\n"))
          const text = contents.join("\n")
          const kind = input.kind === "compaction" ? "summary" : "ordinary"
          const startedAtMs = performance.now()
          const row: NativeObservation = {
            id: requests.length + 1, kind, role, phase: options.classify(input.messages, requests.length + 1).phase,
            sessionID: input.sessionID, startedAtMs, dispatchAtMs: null, finishedAtMs: null,
            ...(options.profile && { agent: input.agent }),
            requestBytes: input.bytes, responseBytes: null, httpStatus: null, media: null, usage: null, summaryResponseSha256: null,
            stale: text.includes(options.stale), correction: text.includes(options.correction),
            oldSummary: contents.some(value => hasText(value, baselineSummary)),
            skill: contents.some(value => hasText(value, options.skill())), tools: input.tools, status: null,
            investigationSchema: input.investigationSchema,
            calculatedFieldCount: calculatedFieldCount(input.messages),
          }
          requests.push(row)
          if (kind === "summary" && row.stale && !row.correction && !pending && !released) {
            pending = row
            await gate
          }
          if (problem || request.signal.aborted) return fail(problem ?? "NATIVE_REQUEST_CANCELLED")
          row.dispatchAtMs = performance.now()
          try { await options.onReceipt?.(row, "admission") }
          catch { return fail("NATIVE_ADMISSION_RECEIPT_FAILED") }
          if (options.profile && (problem || request.signal.aborted)) return fail(problem ?? "NATIVE_REQUEST_CANCELLED")
          return Response.json(row.id)
        }
        case "/finish": {
          const { id, terminal } = await request.json() as { id: number; terminal: Terminal }
          const row = requests[id - 1]
          if (!row || row.dispatchAtMs === null || row.finishedAtMs !== null) return fail("NATIVE_REQUEST_CORRELATION")
          row.status = terminal.status
          row.finishedAtMs = performance.now()
          row.responseBytes = terminal.bytes
          row.httpStatus = terminal.httpStatus ?? null
          row.media = terminal.media ?? null
          row.usage = terminal.usage
          responseBytes += terminal.bytes
          outstanding--
          outputTokens += terminal.usage?.output ?? 0
          try { await options.onReceipt?.(row, "terminal") }
          catch { return fail("NATIVE_TERMINAL_RECEIPT_FAILED") }
          if (terminal.summary) {
            row.summaryResponseSha256 = nativeSummaryHash(terminal.summary)
            if (row === pending && row.status === 200) baselineSummary = terminal.summary
          }
          if (responseBytes > limits.armResponseBytes) return fail("NATIVE_RESPONSE_BYTES_EXCEEDED")
          if (outputTokens > limits.armOutputTokens) return fail("NATIVE_ARM_OUTPUT_LIMIT_EXCEEDED")
          if (row.usage && row.usage.output > limits.outputTokens) return fail("NATIVE_PROVIDER_OUTPUT_LIMIT_VIOLATED")
          if (terminal.invalidFraming) return fail("NATIVE_RESPONSES_STREAM_REQUIRED")
          if (terminal.outputBudgetExhausted) return fail("NATIVE_PROVIDER_OUTPUT_EXHAUSTED")
          if (terminal.streamLimit === "response-bytes") return fail("NATIVE_RESPONSE_BYTES_EXCEEDED")
          if (terminal.streamLimit === "output-delta") return fail("NATIVE_OUTPUT_DELTA_BYTES_EXCEEDED")
          if (row.status !== 200) return fail("NATIVE_RESPONSE_" + row.status)
          return new Response(null, { status: 204 })
        }
        default: return new Response(null, { status: 404 })
      }
    },
  })
  const pluginOptions = { endpoint: "http://127.0.0.1:" + server.port, key, id: options.id,
    ...(options.profile && { profile: options.profile }) }
  return {
    setupOptions: pluginOptions,
    async stage(directory: string) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const bundle = await Bun.build({ entrypoints: [fileURLToPath(import.meta.url)], naming: "index.js", target: "bun" })
      if (!bundle.success || bundle.outputs.length !== 1) throw new Error("NATIVE_OBSERVER_BUNDLE_UNAVAILABLE")
      await writeFile(join(directory, "index.js"), await bundle.outputs[0]!.text(), { flag: "wx" })
      await writeFile(join(directory, "package.json"), JSON.stringify({
        name: nativeObserverID, type: "module", exports: "./index.js",
      }), { flag: "wx" })
      return { package: pathToFileURL(directory).href, options: pluginOptions }
    },
    requests, held: () => pending, releaseSummary,
    observeApplied: (_summary: string) => { /* The summary witness comes from the held provider response. */ },
    bindRoot(sessionID: string) { if (root) throw new Error("Native observer root already bound"); root = sessionID },
    bindChecker(sessionID: string) { if (checker || sessionID === root) throw new Error("Invalid native observer checker"); checker = sessionID },
    ready: (pid?: number) => !problem && (pid === undefined ? readyPids.size > 0 : readyPids.has(pid)),
    failure: () => problem,
    usage: () => requests.length && requests.every(row => row.finishedAtMs !== null && row.usage !== null)
      ? requests.reduce((sum, row) => sum + (row.usage?.total ?? 0), 0) : null,
    stop() { clearTimeout(timer); releaseSummary(); server.stop(true) },
  }
}

function wireResponse(response: Response, summary: boolean, signal: AbortSignal,
  finish: (terminal: Terminal) => Promise<unknown>, profile?: NativeProfile) {
  const limits = limitsFor(profile)
  const reader = response.body?.getReader()
  if (!reader) throw new Error("NATIVE_EMPTY_RESPONSE")
  const decoder = new TextDecoder()
  let bytes = 0, outputBytes = 0, text = "", reported = false, framed = false
  const abort = () => { void reader.cancel().catch(() => undefined) }
  signal.addEventListener("abort", abort, { once: true })
  const note = async (result: Omit<Terminal, "bytes">) => {
    if (reported) return
    reported = true
    await finish({ ...result, bytes })
  }
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        signal.throwIfAborted()
        const { value, done } = await reader.read()
        signal.throwIfAborted()
        if (done) {
          if (!reported) await note({ status: 502, usage: null, invalidFraming: !framed })
          signal.removeEventListener("abort", abort)
          controller.close()
          return
        }
        bytes += value.byteLength
        if (bytes > limits.responseBytes) {
          await note({ status: 413, usage: null, ...(profile && { streamLimit: "response-bytes" as const }) })
          throw new Error("NATIVE_RESPONSE_BYTES_EXCEEDED")
        }
        text += decoder.decode(value, { stream: true })
        let end: number
        while ((end = text.indexOf("\n")) !== -1) {
          const line = text.slice(0, end).trimEnd()
          text = text.slice(end + 1)
          if (!line || line.startsWith(":") || /^(event|id|retry):/.test(line)) continue
          if (!line.startsWith("data:")) {
            await note({ status: 502, usage: null, invalidFraming: true })
            throw new Error("NATIVE_RESPONSES_STREAM_REQUIRED")
          }
          framed = true
          if (line.slice(5).trim() === "[DONE]") continue
          const event = record(JSON.parse(line.slice(5)))
          if (typeof event?.delta === "string") outputBytes += Buffer.byteLength(event.delta)
          if (outputBytes > limits.outputDeltaBytes) {
            await note({ status: 413, usage: null, ...(profile && { streamLimit: "output-delta" as const }) })
            throw new Error("NATIVE_OUTPUT_DELTA_BYTES_EXCEEDED")
          }
          const result = readNativeCompletion(event, summary, profile)
          if (result) await note(result)
        }
        controller.enqueue(value)
        if (reported) {
          signal.removeEventListener("abort", abort)
          abort()
          controller.close()
        }
      } catch {
        signal.removeEventListener("abort", abort)
        abort()
        await note({ status: signal.aborted ? 408 : 502, usage: null }).catch(() => undefined)
        controller.error(new Error("NATIVE_RESPONSE_UNAVAILABLE"))
      }
    },
    async cancel() {
      signal.removeEventListener("abort", abort)
      abort()
      await note({ status: 499, usage: null }).catch(() => undefined)
    },
  })
  const headers = new Headers(response.headers)
  headers.set("content-type", "text/event-stream")
  return new Response(stream, { status: response.status, headers })
}

async function setup(ctx: Plugin.Context) {
  const { endpoint: control, key, id, profile } = ctx.options
  if (ctx.app.version !== "2.3.2" || typeof control !== "string" ||
      !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(control) || typeof key !== "string" ||
      !/^[a-f0-9]{48}$/.test(key) || typeof id !== "string" || (profile !== undefined && profile !== "discovery-v1"))
    throw new Error("NATIVE_OBSERVER_OPTIONS_INVALID")
  nativeModel("openai/" + id)

  async function rpc(path: string, value: unknown, signal = AbortSignal.timeout(4000)) {
    const response = await fetch(control + path, {
      method: "POST", body: JSON.stringify(value), redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: "Bearer " + key },
    })
    if (!response.ok) throw new Error("NATIVE_OBSERVER_REFUSED")
    return response
  }

  async function deny(reason: string): Promise<never> {
    await rpc("/fail", reason).catch(() => undefined)
    throw new Error(reason)
  }

  const ids = new WeakMap<Request, { id: number; signal: AbortSignal }>()
  const check = (brief: Brief) => brief.model.providerID === "openai" && brief.model.id === id &&
    (brief.kind === "primary" || brief.kind === "compaction")

  const registrations: Registration[] = []
  try {
    registrations.push(await ctx.session.hook("title", input => { input.result = "Paired benchmark" }))
    registrations.push(await ctx.session.hook("generate", () => deny("NATIVE_AUXILIARY_GENERATION_BLOCKED")))
    registrations.push(await ctx.session.hook("retry", input => { input.decision = { retry: false } }))
    registrations.push(await ctx.session.hook("experimental.ws.handshake", () => deny("NATIVE_WEBSOCKET_BLOCKED")))
    registrations.push(await ctx.session.hook("http.request", async input => {
      const { request } = input
      if (!check(input) || request.url !== endpoint || request.method !== "POST" ||
          !request.headers.has("authorization") || request.headers.has("content-encoding"))
        return deny("NATIVE_OAUTH_RESPONSES_REQUIRED")
      let parsed: ReturnType<typeof nativeBody>
      try { parsed = nativeBody(await request.clone().text(), id, profile) }
      catch (error) {
        return deny(profile && error instanceof Error && error.message === "NATIVE_REQUEST_BYTES_EXCEEDED"
          ? error.message : "NATIVE_REQUEST_SHAPE_OR_BUDGET")
      }
      const admissionSignal = AbortSignal.any([request.signal, AbortSignal.timeout(75_000)])
      const admitted = await rpc("/begin", {
        sessionID: input.sessionID, kind: input.kind, ...parsed, ...(profile && { agent: input.agent }),
      } satisfies Omit<Beginning, "kind"> & { kind: string }, admissionSignal)
      const requestID = await admitted.json()
      if (!count(requestID) || requestID === 0) return deny("NATIVE_REQUEST_CORRELATION")
      const signal = AbortSignal.any([request.signal, AbortSignal.timeout(limitsFor(profile).requestMs)])
      ids.set(request, { id: requestID, signal })
    }))
    registrations.push(await ctx.session.hook("http.response", async (input: SessionHttpResponse) => {
      const binding = ids.get(input.request)
      if (!binding) return deny("NATIVE_REQUEST_CORRELATION")
      const httpStatus = input.response.status, media = responseMedia(input.response.headers)
      const finish = (terminal: Terminal) => rpc("/finish", { id: binding.id, terminal: { ...terminal, httpStatus, media } })
      if (!input.response.ok) {
        void input.response.body?.cancel().catch(() => undefined)
        await finish({ status: input.response.status, bytes: 0, usage: null })
        return
      }
      if (!input.response.body) {
        await finish({ status: 502, bytes: 0, usage: null, invalidFraming: true })
        return
      }
      input.response = wireResponse(input.response, input.kind === "compaction", binding.signal, finish, profile)
    }))
    await rpc("/ready", process.pid)
    return async () => { for (const registration of registrations.reverse()) await registration.dispose() }
  } catch (error) {
    for (const registration of registrations.reverse()) await registration.dispose()
    throw error
  }
}

export default { id: nativeObserverID, setup } satisfies Plugin.Plugin

import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { SessionHooks } from "@opencode/plugin/promise/session"
import observerPlugin, { nativeSummaryHash, startNativeObserver } from "./native-observer.ts"
import { accessOnlyCredential, nativeLimits, nativeModel, nativeProviderConfig } from "./native-provider.ts"

const model = nativeModel("openai/gpt-6-luna")
const modelRef = model as SessionHooks["http.request"]["model"]

test("stages a fresh OpenAI access credential without carrying a refresh token or another provider", () => {
  const expires = 1_000_000
  const signedIn = {
    openai: { type: "oauth", access: "offline-test", refresh: "never-copy", accountId: "workspace_1", expires },
    other: { type: "api", key: "never-copy-either" },
  }
  expect(accessOnlyCredential(signedIn, 0)).toEqual({
    openai: { type: "oauth", access: "offline-test", refresh: "", accountId: "workspace_1", expires },
  })
  expect(() => accessOnlyCredential(signedIn, 100_000)).toThrow("too close to expiry")
  expect(() => nativeModel("other/gpt-6-luna")).toThrow("openai/")
  expect(nativeModel("openai/gpt-6-sol").id).toBe("gpt-6-sol")
  expect(nativeProviderConfig(16384, model.id).openai).toMatchObject({
    settings: { transport: "http", encoding: "none", compaction: { type: "summary" } },
    models: { [model.id]: { limit: { context: 16384, output: nativeLimits.outputTokens } } },
  })
  expect(nativeProviderConfig(16384, model.id).openai.settings).not.toHaveProperty("baseURL")
})

async function fixture() {
  const observer = startNativeObserver({
    id: model.id, classify: messages => ({
      phase: messages.some(message => String(message.content).includes("revise")) ? "revision" : null, role: "other",
    }), stale: "stale-evidence", correction: "corrected-evidence", skill: () => "skill payload",
  })
  const hooks: Partial<{ [Name in keyof SessionHooks]: (input: SessionHooks[Name]) => Promise<void> }> = {}
  const cleanup = await observerPlugin.setup({
    app: { version: "2.3.2" }, options: observer.setupOptions,
    session: { async hook(name: keyof SessionHooks, run: unknown) {
      Object.assign(hooks, { [name]: run })
      return { async dispose() {} }
    } },
  } as unknown as Plugin.Context)
  observer.bindRoot("root")
  observer.bindChecker("checker")
  const request = (kind: "primary" | "compaction", text: string, sessionID = "root") => {
    const input = {
      sessionID, model: modelRef, kind,
      request: new Request("https://chatgpt.com/backend-api/codex/responses", {
        method: "POST", headers: { authorization: "Bearer test-only" },
        body: JSON.stringify({ model: model.id, stream: true, input: [{ role: "user", content: [{ type: "input_text", text }] }] }),
      }),
    } as SessionHooks["http.request"]
    return { input, admission: hooks["http.request"]!(input) }
  }
  const response = async (input: SessionHooks["http.request"], text: string, output = 23, mime = "text/event-stream") => {
    const event = { type: "response.completed", response: {
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 42, output_tokens: output, total_tokens: 42 + output },
    } }
    const frame = "data: " + JSON.stringify(event) + "\r\n\r\n"
    const wire = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode(frame.slice(0, 37)))
      controller.enqueue(new TextEncoder().encode(frame.slice(37)))
      controller.close()
    } })
    const result = { ...input, response: new Response(wire, { headers: { "content-type": mime } }) }
    await hooks["http.response"]!(result)
    return result.response.text()
  }
  return { observer, hooks, request, response, async stop() { await cleanup?.(); observer.stop() } }
}

test("holds an old root summary, records real terminal receipts, and recognizes the archived text on first revision", async () => {
  const f = await fixture()
  try {
    expect(f.observer.ready(process.pid)).toBe(true)
    expect(f.observer.ready(process.pid + 1)).toBe(false)
    const old = f.request("compaction", "stale-evidence")
    await admissionReady(() => f.observer.held())
    expect(f.observer.held()?.dispatchAtMs).toBeNull()
    const progress = f.request("primary", "current response with skill payload")
    await progress.admission
    expect(f.observer.usage()).toBeNull()
    await f.response(progress.input, "sent while held")
    expect(f.observer.requests[1]).toMatchObject({ role: "root", status: 200, skill: true })
    expect(f.observer.held()?.finishedAtMs).toBeNull()
    f.observer.releaseSummary()
    await old.admission
    await f.response(old.input, "Archived stale-evidence")
    expect(f.observer.held()).toMatchObject({ role: "root", kind: "summary", stale: true, correction: false,
      summaryResponseSha256: nativeSummaryHash("Archived stale-evidence"), usage: { input: 42, output: 23, total: 65 } })
    const revision = f.request("primary", "revise: Archived  stale-evidence; corrected-evidence")
    await revision.admission
    expect(f.observer.requests[2]).toMatchObject({ phase: "revision", oldSummary: true, correction: true })
    await f.response(revision.input, "corrected")
    expect(f.observer.usage()).toBe(195)
  } finally { await f.stop() }
})

test("grades native responses by framing and terminal usage and records only a bounded media label", async () => {
  const f = await fixture()
  try {
    const valid = f.request("primary", "first")
    await valid.admission
    await f.response(valid.input, "result", 8, "application/octet-stream")
    expect(f.observer.requests[0]).toMatchObject({ httpStatus: 200, media: "binary", status: 200, usage: { output: 8 } })
    const invalid = f.request("primary", "second")
    await invalid.admission
    const wire = { ...invalid.input, response: new Response("<html></html>", { headers: { "content-type": "text/html" } }) }
    await f.hooks["http.response"]!(wire)
    await expect(wire.response.text()).rejects.toThrow()
    expect(f.observer.requests[1]).toMatchObject({ httpStatus: 200, media: "html", status: 502, usage: null })
    expect(f.observer.failure()).toBe("NATIVE_RESPONSES_STREAM_REQUIRED")
  } finally { await f.stop() }
})

test("fatally blocks auxiliary work and keeps measured over-limit usage visible", async () => {
  const over = await fixture()
  try {
    const step = over.request("primary", "ordinary")
    await step.admission
    await expect(over.response(step.input, "overspent", nativeLimits.outputTokens + 1)).rejects.toThrow()
    expect(over.observer.failure()).toBe("NATIVE_PROVIDER_OUTPUT_LIMIT_VIOLATED")
    expect(over.observer.requests[0]?.usage?.output).toBe(nativeLimits.outputTokens + 1)
    const next = over.request("primary", "retry")
    await expect(next.admission).rejects.toThrow()
    expect(over.observer.requests).toHaveLength(1)
  } finally { await over.stop() }

  const aux = await fixture()
  try {
    const unbound = aux.request("primary", "unbound", "unexpected-child")
    await expect(unbound.admission).rejects.toThrow()
    expect(aux.observer.failure()).toBe("NATIVE_UNBOUND_SESSION")
    expect(aux.observer.requests).toHaveLength(0)
  } finally { await aux.stop() }
})

test("reserves outstanding output against completed usage before dispatch", async () => {
  const f = await fixture()
  try {
    for (let i = 0; i < 10; i++) {
      const step = f.request("primary", "ordinary")
      await step.admission
      await f.response(step.input, "answer", 1000)
    }
    const inFlight = f.request("primary", "ordinary")
    await inFlight.admission
    const blocked = f.request("primary", "would exceed the reservation", "checker")
    await expect(blocked.admission).rejects.toThrow()
    expect(f.observer.failure()).toBe("NATIVE_OUTPUT_RESERVATION_EXCEEDED")
    expect(f.observer.requests).toHaveLength(11)
    expect(f.observer.usage()).toBeNull()
  } finally { await f.stop() }
})

async function admissionReady(read: () => unknown) {
  const end = performance.now() + 3000
  while (!read() && performance.now() < end) await Bun.sleep(10)
  expect(read()).toBeDefined()
}

import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import type { PluginInput } from "@opencode-ai/plugin"
import { captureTaskRequest, MAX_TASK_REQUEST_PARTS, MAX_TASK_REQUEST_TEXT_BYTES, TaskRequestSnapshotSchema,
  type TaskRequestSource } from "../src/task-request.ts"

const source: TaskRequestSource = { sessionID: "session-owner", messageID: "current-message", directory: "C:/project" }
const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex")
function response({ sessionID = source.sessionID, id = source.messageID, role = "user", parentID, parts = [] }: {
  sessionID?: string; id?: string; role?: string; parentID?: string; parts?: unknown[]
} = {}) {
  return { info: { sessionID, id, role, ...(parentID ? { parentID } : {}) }, parts }
}
function clientWith(handler: (options: { path: { id: string; messageID: string }; query?: { directory?: string }; signal: AbortSignal }) => unknown | Promise<unknown>) {
  return { session: { message: handler } } as unknown as PluginInput["client"]
}

describe("host captured current task request", () => {
  test("captures the requested user message and exact project query", async () => {
    let calls = 0
    const client = clientWith(options => {
      calls++
      expect(options.path).toEqual({ id: source.sessionID, messageID: source.messageID })
      expect(options.query).toEqual({ directory: source.directory })
      expect(options.signal).toBeInstanceOf(AbortSignal)
      return response({ parts: [{ type: "text", text: "Do the requested work." }] })
    })
    await expect(captureTaskRequest(client, source)).resolves.toEqual({ status: "captured", session_id: source.sessionID,
      message_id: source.messageID, text: "Do the requested work.", text_sha256: hash("Do the requested work."),
      text_transformed: false, non_text_parts: 0 })
    expect(calls).toBe(1)
  })

  test("resolves only the exact user parent of a requested assistant message", async () => {
    const calls: string[] = []
    const client = clientWith(({ path }) => {
      calls.push(path.messageID)
      return path.messageID === source.messageID
        ? response({ role: "assistant", parentID: "explicit-parent", parts: [{ type: "text", text: "assistant" }] })
        : response({ id: "explicit-parent", parts: [{ type: "text", text: "Original user request" }] })
    })
    const result = await captureTaskRequest(client, source)
    expect(calls).toEqual([source.messageID, "explicit-parent"])
    expect(result).toMatchObject({ status: "captured", message_id: "explicit-parent", text: "Original user request" })
  })

  test("rejects mismatched session, message, and role without guessing history", async () => {
    for (const found of [
      response({ sessionID: "other-session" }), response({ id: "other-message" }), response({ role: "system" }),
      response({ role: "assistant" }),
    ]) {
      const result = await captureTaskRequest(clientWith(() => found), source)
      expect(result).toEqual({ status: "unavailable", reason: "identity_mismatch" })
    }
    let calls = 0
    const result = await captureTaskRequest(clientWith(() => { calls++; return response() }), { ...source, abort: AbortSignal.abort() })
    expect(result).toEqual({ status: "unavailable", reason: "lookup_failed" })
    expect(calls).toBe(0)
  })

  test("maps SDK failures and absent legacy methods to static unavailable reasons", async () => {
    expect(await captureTaskRequest(clientWith(() => { throw new Error("private SDK details") }), source))
      .toEqual({ status: "unavailable", reason: "lookup_failed" })
    expect(await captureTaskRequest({ session: {} } as unknown as PluginInput["client"], source))
      .toEqual({ status: "unavailable", reason: "unsupported" })
    expect(await captureTaskRequest(clientWith(() => ({ error: { message: "private failure" } })), source))
      .toEqual({ status: "unavailable", reason: "lookup_failed" })
  })

  test("collects literal text in order without decoding task requirements", async () => {
    const client = clientWith(() => response({ parts: [
      { type: "text", text: "First %20part\\u0032" }, { type: "file", filename: "private-attachment-name" },
      { type: "text", text: "Keep %2F and \\u0032 unchanged." }, { type: "reasoning", text: "must not be included" },
    ] }))
    const result = await captureTaskRequest(client, source)
    expect(result).toMatchObject({ status: "captured", text: "First %20part\\u0032\nKeep %2F and \\u0032 unchanged.",
      text_transformed: false, non_text_parts: 2 })
    if (result.status !== "captured") throw new Error("expected captured request")
    expect(result.text_sha256).toBe(hash(result.text))
    expect(result.text).not.toContain("private-attachment-name")
    expect(result.text).not.toContain("must not be included")
  })

  test("declines recognized credentials entirely, including prefixed and encoded assignments", async () => {
    const cases = ["secret=hidden-value", "OPENAI_API_KEY=opaque-value", "AWS_SECRET_ACCESS_KEY=opaque-value",
      '"service_accessToken": "opaque-value"', "https://user:private-value@example.invalid/path",
      "Bearer opaque-value", "-----BEGIN PRIVATE KEY-----\nopaque\n-----END PRIVATE KEY-----",
      "OPENAI_API_KEY%3Dopaque-value", "AWS_SECRET_ACCESS_KEY\\u003dopaque-value",
      Buffer.from("OPENAI_API_KEY=opaque-value").toString("base64"),
      "sk-proj-abcdefghijklmnopqrstuv", "const password: string = 'private-value'", "password=string",
      "const password: string\n= 'private-value'", "const password: string /* comment */ = 'private-value'",
      "const password: string // comment\n= 'private-value'"]
    for (const text of cases) {
      expect(await captureTaskRequest(clientWith(() => response({ parts: [{ type: "text", text }] })), source))
        .toEqual({ status: "unavailable", reason: "sensitive_content" })
    }
  })

  test("retains public schema type declarations and explicit credential placeholders", async () => {
    for (const text of ["Add a password: string field", "Document token: string", "type X = { token: string; secret: boolean }",
      "OPENAI_API_KEY=<YOUR_API_KEY>", '"token": "<REDACTED>"', "AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY}"]) {
      expect(await captureTaskRequest(clientWith(() => response({ parts: [{ type: "text", text }] })), source))
        .toMatchObject({ status: "captured", text, text_sha256: hash(text), text_transformed: false })
    }
  })

  test("accepts SDK envelopes with a null error and declines whitespace-only text", async () => {
    const client = clientWith(() => ({ data: response({ parts: [{ type: "text", text: "Exact task" }] }), error: null }))
    expect(await captureTaskRequest(client, source)).toMatchObject({ status: "captured", text: "Exact task" })
    expect(await captureTaskRequest(clientWith(() => response({ parts: [{ type: "text", text: " \n\t" }] })), source))
      .toEqual({ status: "unavailable", reason: "no_text" })
  })

  test("enforces raw and retained byte limits without truncation, including Unicode", async () => {
    const exactUnicode = "é".repeat(MAX_TASK_REQUEST_TEXT_BYTES / 2)
    const accepted = await captureTaskRequest(clientWith(() => response({ parts: [{ type: "text", text: exactUnicode }] })), source)
    expect(accepted).toMatchObject({ status: "captured", text: exactUnicode })
    const tooLargeUnicode = `${exactUnicode}é`
    expect(await captureTaskRequest(clientWith(() => response({ parts: [{ type: "text", text: tooLargeUnicode }] })), source))
      .toEqual({ status: "unavailable", reason: "oversized" })
    expect(await captureTaskRequest(clientWith(() => response({ parts: [
      { type: "text", text: "x".repeat(MAX_TASK_REQUEST_TEXT_BYTES / 2) },
      { type: "text", text: "y".repeat(MAX_TASK_REQUEST_TEXT_BYTES / 2) },
    ] })), source)).toEqual({ status: "unavailable", reason: "oversized" })
  })

  test("bounds part count and distinguishes requests with no text", async () => {
    expect(await captureTaskRequest(clientWith(() => response({ parts: [{ type: "file" }] })), source))
      .toEqual({ status: "unavailable", reason: "no_text" })
    expect(await captureTaskRequest(clientWith(() => response({ parts: Array(MAX_TASK_REQUEST_PARTS + 1).fill({ type: "file" }) })), source))
      .toEqual({ status: "unavailable", reason: "oversized" })
  })

  test("snapshot schema rejects a bad digest and over-limit UTF-8 text", () => {
    const snapshot = { status: "captured" as const, session_id: source.sessionID, message_id: source.messageID,
      text: "safe", text_sha256: hash("safe"), text_transformed: false, non_text_parts: 0 }
    expect(TaskRequestSnapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(TaskRequestSnapshotSchema.safeParse({ ...snapshot, text_transformed: true }).success).toBe(false)
    expect(TaskRequestSnapshotSchema.safeParse({ ...snapshot, text: " ", text_sha256: hash(" ") }).success).toBe(false)
    expect(TaskRequestSnapshotSchema.safeParse({ ...snapshot, text_sha256: hash("different") }).success).toBe(false)
    expect(TaskRequestSnapshotSchema.safeParse({ ...snapshot, text: "é".repeat(MAX_TASK_REQUEST_TEXT_BYTES),
      text_sha256: hash("é".repeat(MAX_TASK_REQUEST_TEXT_BYTES)) }).success).toBe(false)
  })

  test("times out and aborts the SDK signal without exposing rejection details", async () => {
    let observedSignal: AbortSignal | undefined
    const result = await captureTaskRequest(clientWith(({ signal }) => {
      observedSignal = signal
      return new Promise(() => {})
    }), source)
    expect(result).toEqual({ status: "unavailable", reason: "lookup_failed" })
    expect(observedSignal?.aborted).toBe(true)
  }, 4_000)

  test("propagates tool cancellation to an in-flight SDK request", async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const pending = captureTaskRequest(clientWith(({ signal }) => {
      observedSignal = signal
      return new Promise(() => {})
    }), { ...source, abort: controller.signal })
    setTimeout(() => controller.abort(), 5)
    await expect(pending).resolves.toEqual({ status: "unavailable", reason: "lookup_failed" })
    expect(observedSignal?.aborted).toBe(true)
  })
})

import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { summarizeSession } from "../benchmark/session-evidence.ts"

const tokens = { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }
const answer = { id: "a", type: "assistant", model: { providerID: "test", id: "model" }, time: { completed: 1 },
  finish: "stop", content: [{ type: "text", text: "private answer" }], tokens }
const summary = { id: "s", type: "compaction", reason: "auto", status: "completed", tokens, summary: "private summary" }
const idle = { type: "idle", outcome: "succeeded" }
const summarize = (rows: unknown[]) => summarizeSession(rows as SessionMessageInfo[])

test("uses only recorded assistant and compaction usage and excludes the transcript contents", () => {
  const measure = summarize([answer, summary, idle])
  expect(measure).toMatchObject({ observedTokens: 40, complete: true, steps: [
    { id: "a", tokens: 20, cacheRead: 5 }, { id: "s", reason: "auto", tokens: 20 },
  ] })
  expect(JSON.stringify(measure)).not.toContain("private")
})

test("unfinished turns and missing or placeholder usage cannot establish a complete total", () => {
  expect(summarize([answer]).complete).toBe(false)
  expect(summarize([answer, { ...summary, tokens: undefined }, idle])).toMatchObject({ complete: false, observedTokens: 20 })
  expect(summarize([{ ...answer, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }, idle]))
    .toMatchObject({ complete: false, observedTokens: null })
})

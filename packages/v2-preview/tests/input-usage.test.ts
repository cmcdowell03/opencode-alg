import { expect, test } from "bun:test"
import { calculatedFieldCount, inputUsage } from "../benchmark/input-usage.ts"
import { summarizeSession } from "../benchmark/session-evidence.ts"

test("calculated evidence is observed only in a complete user-role wire payload", () => {
  const text = 'ALG calculated evidence (source data)\n{"values":{"rows":0,"matched":3}}'
  expect(calculatedFieldCount([{ role: "user", content: [{ type: "input_text", text }] }])).toBe(2)
  expect(calculatedFieldCount([{ role: "assistant", content: text }, { role: "user", content: "Earlier: " + text }])).toBe(0)
  expect(calculatedFieldCount([{ role: "user", content: text.replace('"rows":0', '"rows":null') }])).toBe(0)
})

const sample = { kind: "ordinary", role: "root", phase: "continue", status: 200, requestBytes: 500,
  usage: { input: 10, output: 5, total: 15 } } as const

test("counts every request and keeps wire size separate from provider token usage", () => {
  const rows = [sample, { ...sample, kind: "summary" as const }]
  expect(inputUsage(rows, false, null)).toMatchObject({ requests: 2, requestBytes: 1000,
    inputTokens: null, outputTokens: null, cachedInputTokens: null })
  expect(inputUsage(rows, true, null)).toMatchObject({ requests: 2, requestBytes: 1000, inputTokens: 20, outputTokens: 10,
    byStage: { "root/continue": { requests: 1 }, "root/summary": { requests: 1 } } })
  expect(inputUsage([sample, { ...sample, status: 502, requestBytes: undefined }], true, null))
    .toMatchObject({ requests: 2, requestBytes: null, inputTokens: null, outputTokens: null })
  expect(inputUsage([], true, null)).toMatchObject({ requestBytes: null, inputTokens: null })
})

test("cache hits are a subset of provider input only when host and provider totals reconcile", () => {
  const session = { ...summarizeSession([]), complete: true, observedTokens: 15,
    steps: [{ id: "step", kind: "assistant", status: "stop", completed: true, model: null, reason: null, httpStatus: null,
      tokens: 15, cacheRead: 8, cacheWrite: 0, hostCost: 0 } as const] }
  const evidence = { sessions: { root: session }, completeRecordedTokens: 15 }
  expect(inputUsage([sample], true, evidence).cachedInputTokens).toBe(8)
  expect(inputUsage([sample], true, { ...evidence, completeRecordedTokens: 14 }).cachedInputTokens).toBeNull()
  expect(inputUsage([sample], false, evidence).cachedInputTokens).toBeNull()
})

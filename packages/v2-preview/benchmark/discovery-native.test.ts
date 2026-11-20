import { expect, test } from "bun:test"
import { classifyDiscoveryFailure } from "./discovery-host.ts"
import { readNativeCompletion, startNativeObserver } from "./native-observer.ts"
import { discoveryNativeLimits, nativeLimits } from "./native-provider.ts"

test("discovery admits exactly 48 recorded primary requests and denies the next before dispatch", async () => {
  const receipts: string[] = []
  const observer = startNativeObserver({
    id: "gpt-6-luna", profile: "discovery-v1", stale: "", correction: "", skill: () => undefined,
    classify: () => ({ role: "root", phase: "initial" }), allowedAgents: { root: "build", checker: "reviewer" },
    onReceipt: async (row, stage) => { receipts.push(stage + ":" + row.id) },
  })
  try {
    expect(nativeLimits.calls).toBe(24)
    expect(discoveryNativeLimits.calls).toBe(48)
    observer.bindRoot("root")
    const rpc = (name: string, value: unknown) => fetch(observer.setupOptions.endpoint + name, {
      method: "POST", headers: { authorization: "Bearer " + observer.setupOptions.key }, body: JSON.stringify(value),
    })
    const input = { sessionID: "root", agent: "build", kind: "primary", bytes: 120,
      messages: [], tools: [], investigationSchema: null }
    for (let id = 1; id <= 48; id++) {
      const begin = await rpc("/begin", input)
      expect(begin.status).toBe(200)
      expect(await begin.json()).toBe(id)
      const terminal = { status: 200, bytes: 30, usage: { input: 20, output: 10, total: 30, cachedInput: 8, reasoningOutput: 2 } }
      expect((await rpc("/finish", { id, terminal })).status).toBe(204)
    }
    expect((await rpc("/begin", input)).status).toBe(409)
    expect(observer.failure()).toBe("NATIVE_PROVIDER_CALL_BUDGET")
    expect(observer.requests.length).toBe(48)
    expect(receipts).toEqual(observer.requests.flatMap(({ id }) => ["admission:" + id, "terminal:" + id]))
  } finally { observer.stop() }
})

test("discovery records provider cache and reasoning counters from Responses usage", () => {
  const event = {
    type: "response.completed", response: { usage: {
      input_tokens: 19, output_tokens: 12, total_tokens: 31,
      input_tokens_details: { cached_tokens: 8 }, output_tokens_details: { reasoning_tokens: 5 },
    } },
  }
  expect(readNativeCompletion(event, false)?.usage).toEqual({ input: 19, output: 12, total: 31 })
  expect(readNativeCompletion(event, false, "discovery-v1")?.usage).toEqual({
    input: 19, output: 12, total: 31, cachedInput: 8, reasoningOutput: 5,
  })
})

test.each([
  ["handoff-v1", "root", "compaction", 200],
  ["handoff-v1", "checker", "compaction", 409],
  ["discovery-v1", "root", "compaction", 409],
  ["handoff-v1", "root", "other", 409],
] as const)("observer %s admits only the declared %s/%s generation", async (profile, sessionID, kind, expected) => {
  const observer = startNativeObserver({ id: "fixture", profile, stale: "obsolete", correction: "updated",
    skill: () => undefined, classify: () => ({ role: "root", phase: "compaction" }) })
  try {
    observer.bindRoot("root")
    observer.bindChecker("checker")
    observer.releaseSummary()
    const result = await fetch(observer.setupOptions.endpoint + "/begin", { method: "POST",
      headers: { authorization: "Bearer " + observer.setupOptions.key },
      body: JSON.stringify({ sessionID, kind, bytes: 100, messages: [], tools: [] }) })
    expect(result.status).toBe(expected)
    expect(observer.requests.length).toBe(expected === 200 ? 1 : 0)
    if (expected === 200) expect(observer.requests[0]?.kind).toBe("summary")
  } finally { observer.stop() }
})

test("observable model and budget failures stay outcomes, while host and transport faults stop paid dispatch", () => {
  expect(classifyDiscoveryFailure("NATIVE_PROVIDER_CALL_BUDGET", true)).toBe("budget-exhausted")
  expect(classifyDiscoveryFailure("NATIVE_ARM_DEADLINE", false)).toBe("apparatus-error")
  expect(classifyDiscoveryFailure("NATIVE_TOOL_SCOPE_UNEXPECTED", true)).toBe("apparatus-error")
  expect(classifyDiscoveryFailure("NATIVE_RESPONSE_503", true)).toBe("apparatus-error")
  expect(classifyDiscoveryFailure("Host turn returned empty assistant text", true)).toBe("model-output-failure")
  const incomplete = { type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }
  expect(readNativeCompletion(incomplete, false, "discovery-v1")?.outputBudgetExhausted).toBe(true)
  expect(readNativeCompletion(incomplete, false)?.outputBudgetExhausted).toBeUndefined()
})

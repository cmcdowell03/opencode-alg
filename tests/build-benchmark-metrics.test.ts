import { describe, expect, test } from "bun:test"
import { summarizeSessionMetrics } from "../scripts/build-benchmark-metrics.ts"

const assistant = (id: string, fields: Record<string, unknown> = {}) => ({
  sessionID: "root", info: { id, role: "assistant", ...fields }, parts: [] as any[],
})
const tool = (name: string, input: unknown, status: string, fields: Record<string, unknown> = {}) => ({
  type: "tool", tool: name, state: { status, input, ...fields },
})

describe("reported session benchmark metrics", () => {
  test("deduplicates polled message updates and aggregates usage, costs, models, sessions and calls", () => {
    const sessions = [
      { id: "root" }, { id: "child-a", parentID: "root" }, { id: "child-b", parentID: "root" },
      { id: "child-a", parentID: "root" },
    ]
    const oldT1 = assistant("turn-1", { providerID: "provider-a", modelID: "model-x" })
    oldT1.parts.push(tool("alg_run", { run_id: "old" }, "pending"))
    const t1 = assistant("turn-1", {
      time: { completed: 150 }, providerID: "provider-a", modelID: "model-x",
      tokens: { input: 10, output: 5, reasoning: 2, cache: { read: 3, write: 1 } }, cost: 0.02,
    })
    t1.parts.push(
      tool("skill", { name: "repo-guide" }, "completed", { time: { start: 10, end: 12 }, output: "PRIVATE TOOL OUTPUT" }),
      tool("alg_plan", { goal: "fixture" }, "completed", { time: { duration: 3 } }),
      tool("search", { query: "same", limit: 2 }, "completed", { time: { start: 100, end: 130 } }),
    )
    const t2 = assistant("turn-2", {
      providerID: "provider-a", modelID: "model-x",
      tokens: { input: 0, output: 4, reasoning: 0 },
    })
    t2.sessionID = "child-a"
    t2.parts.push(
      tool("search", { limit: 2, query: "same" }, "error", { error: { name: "ToolDeniedError" }, time: { duration: 4 } }),
      tool("skill", { name: "private-guide" }, "error", { error: { message: "ordinary skill failure" } }),
    )
    const t3 = assistant("turn-3", {
      providerID: "provider-b", modelID: "model-y", status: "error",
      error: { name: "StepLimitError" }, time: { completed: 300 },
    })
    t3.sessionID = "child-b"
    t3.parts.push(tool("alg_run", { run_id: "pending" }, "running"))

    const result = summarizeSessionMetrics(sessions, [oldT1, t1, t2, t3])
    expect(result.sessions).toEqual({ total: 3, roots: 1, children: 2 })
    expect(result.assistantTurns).toEqual({
      total: 3, finished: 1, unfinished: 1, error: 1,
      modelIdentities: [
        { providerID: "provider-a", modelID: "model-x", turns: 2 },
        { providerID: "provider-b", modelID: "model-y", turns: 1 },
      ],
    })
    expect(result.usage.components).toEqual({
      input: { reportedTotal: 10, reportedTurns: 2, unknownTurns: 1 },
      output: { reportedTotal: 9, reportedTurns: 2, unknownTurns: 1 },
      reasoning: { reportedTotal: 2, reportedTurns: 2, unknownTurns: 1 },
      cacheRead: { reportedTotal: 3, reportedTurns: 1, unknownTurns: 2 },
      cacheWrite: { reportedTotal: 1, reportedTurns: 1, unknownTurns: 2 },
    })
    expect(result.usage).toMatchObject({ totalReportedTokens: 25, turns: { complete: 1, partial: 1, unknown: 1 }, billing: "not_estimated" })
    expect(result.cost).toEqual({ reportedTotal: 0.02, reportedTurns: 1, unknownTurns: 2, billing: "not_estimated" })
    expect(result.tools).toMatchObject({ total: 6, completed: 3, error: 2, pending: 1 })
    expect(result.tools.byName.search!.byStatus).toEqual({
      completed: { calls: 1, durationMsReported: 30, durationCalls: 1, unknownDurationCalls: 0 },
      error: { calls: 1, durationMsReported: 4, durationCalls: 1, unknownDurationCalls: 0 },
      pending: { calls: 0, durationMsReported: 0, durationCalls: 0, unknownDurationCalls: 0 },
    })
    expect(result.repeatedExactToolInputs.search).toEqual({ distinctRepeatedInputs: 1, repeatedCalls: 1 })
    expect(result.skillLoads).toEqual({
      "repo-guide": { attempted: 1, successful: 1, error: 0, pending: 0 },
      "private-guide": { attempted: 1, successful: 0, error: 1, pending: 0 },
    })
    expect(result.algTools).toEqual({
      alg_plan: { total: 1, completed: 1, error: 0, pending: 0 },
      alg_run: { total: 1, completed: 0, error: 0, pending: 1 },
    })
    expect(result.observedErrors).toEqual({ deniedTool: 1, stepExhaustion: 1 })
    expect(JSON.stringify(result)).not.toContain("PRIVATE TOOL OUTPUT")
    expect(result.usage.totalReportedTokens).toBe(
      Object.values(result.usage.components).reduce((sum, component) => sum + component.reportedTotal, 0),
    )
  })

  test("keeps unknown usage and cost distinct from reported zeros and only counts fixed error signals", () => {
    const zero = assistant("zero", { time: { completed: 1 }, tokens: {
      input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 },
    }, cost: 0 })
    const unknown = assistant("unknown", { error: { message: "permission denied opening a file" } })
    unknown.parts.push(
      tool("read", { path: "x" }, "error", { error: { message: "permission denied opening a file" }, output: "tool execution denied" }),
      tool("read", { path: "x" }, "pending"),
    )
    const summary = summarizeSessionMetrics([{ id: "root" }], [zero, unknown])
    expect(summary.usage).toMatchObject({
      totalReportedTokens: 0,
      turns: { complete: 1, partial: 0, unknown: 1 },
      components: {
        input: { reportedTotal: 0, reportedTurns: 1, unknownTurns: 1 },
        cacheRead: { reportedTotal: 0, reportedTurns: 1, unknownTurns: 1 },
      },
    })
    expect(summary.cost).toEqual({ reportedTotal: 0, reportedTurns: 1, unknownTurns: 1, billing: "not_estimated" })
    expect(summary.observedErrors).toEqual({ deniedTool: 0, stepExhaustion: 0 })
    expect(summary.tools.byName.read).toMatchObject({ total: 2, error: 1, pending: 1, unknownDurationCalls: 2 })
  })

  test("counts only exact observed step and denial markers and handles absent model/token fields", () => {
    const first = assistant("turn", { error: { code: "permission_denied" } })
    const repeatedPoll = assistant("turn", { error: { code: "permission_denied" } })
    const another = assistant("other", { error: { message: "Maximum number of steps reached" } })
    const summary = summarizeSessionMetrics([], [first, repeatedPoll, another])
    expect(summary.assistantTurns).toMatchObject({ total: 2, finished: 0, unfinished: 0, error: 2, modelIdentities: [] })
    expect(summary.observedErrors).toEqual({ deniedTool: 1, stepExhaustion: 1 })
    expect(summary.usage.turns).toEqual({ complete: 0, partial: 0, unknown: 2 })
    expect(summary.cost.unknownTurns).toBe(2)
  })
})

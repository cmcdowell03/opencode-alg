import { describe, expect, test } from "bun:test"
import { collectFinalSessionCensus, collectSessionCensus, SessionCensusError } from "../scripts/build-benchmark.ts"
import { finalCensus } from "../scripts/build-benchmark-protocol.ts"

const sessionRows = Array.from({ length: 4 }, (_, index) => ({ id: `session-${index + 1}` }))

describe("bounded fair session census", () => {
  test("covers every session under slow synthetic host responses with identical collection semantics", async () => {
    const sessions = new Map<string, any>(), messages = new Map<string, any>()
    const requests: Array<{ path: string; timeout: number | undefined }> = []
    const api = async (path: string, _body?: unknown, timeout?: number) => {
      requests.push({ path, timeout })
      await new Promise(resolve => setTimeout(resolve, path === "/session?limit=10000" ? 12 : 18))
      if (path === "/session?limit=10000") return sessionRows
      return []
    }
    const result = await collectSessionCensus({ api, sessions, messages, phase: "synthetic", overallBudgetMs: 2_000 })
    expect(result.coverage).toMatchObject({ listedSessions: 4, completedHistories: 4, complete: true, failedEndpoint: null })
    expect(result.metrics.sessions.total).toBe(4)
    expect(requests.map(row => row.path).filter(path => path.includes("/message?")).sort()).toEqual(
      sessionRows.map(row => `/session/${row.id}/message?limit=10000`).sort(),
    )
    expect(requests.every(row => typeof row.timeout === "number" && row.timeout > 0 && row.timeout <= 5_000)).toBe(true)
  })

  test("reports the failing endpoint and preserves partial coverage when one host request stalls", async () => {
    const sessions = new Map<string, any>(), messages = new Map<string, any>()
    const api = async (path: string) => {
      if (path === "/session?limit=10000") return sessionRows.slice(0, 2)
      if (path.includes("session-1")) return new Promise<never>(() => {})
      return []
    }
    let caught: unknown
    try {
      await collectSessionCensus({ api, sessions, messages, phase: "synthetic", overallBudgetMs: 80 })
    } catch (error) { caught = error }
    expect(caught).toBeInstanceOf(SessionCensusError)
    expect(caught).toMatchObject({ census: { listedSessions: 2, completedHistories: 1, complete: false,
      failedEndpoint: "/session/session-1/message?limit=10000" } })
    expect((caught as SessionCensusError).message).toBe("TimeoutError")
  })

  test("requires two complete stable snapshots and stays within the final census cap", async () => {
    let collections = 0
    const sessions = new Map<string, any>(), messages = new Map<string, any>()
    const api = async (path: string) => {
      if (path === "/session?limit=10000") return sessionRows
      if (path === "/session/status") return Object.fromEntries(sessionRows.map(row => [row.id, { type: "idle" }]))
      return []
    }
    const result = await finalCensus({ graceMs: 1_000, pollMs: 1, census: async () => {
      collections++
      const captured = await collectSessionCensus({ api, sessions, messages, phase: "final", overallBudgetMs: 500 })
      return { metrics: captured.metrics, activeSessions: 0, pendingWork: false, quiescent: captured.coverage.complete }
    } })
    expect(result.outcome).toBe("quiescent")
    expect(result.stableQuiescentRounds).toBe(2)
    expect(collections).toBeGreaterThanOrEqual(2)
    expect(result.elapsedMs).toBeLessThan(1_000)
  })

  test("a late stalled final poll is aborted and settled before retry, with its own partial coverage", async () => {
    const sessions = new Map<string, any>(), messages = new Map<string, any>()
    let lists = 0, active = 0, aborted = 0, settled = 0
    const api = async (path: string, _body?: unknown, _ms?: number, signal?: AbortSignal) => {
      if (path === "/session?limit=10000") { lists++; return sessionRows.slice(0, 1) }
      if (path === "/session/status") return { "session-1": { type: "busy" } }
      if (lists === 1) return []
      active++
      try {
        return await new Promise<never>((_, reject) => {
          const cancel = () => { aborted++; reject(signal!.reason) }
          signal!.addEventListener("abort", cancel, { once: true })
          if (signal!.aborted) cancel()
        })
      } finally { active--; settled++ }
    }
    const started = Date.now()
    const result = await collectFinalSessionCensus({ api, sessions, messages, phase: "final", graceMs: 160, pollMs: 35 })
    expect(result.outcome).not.toBe("quiescent")
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(aborted).toBeGreaterThan(0)
    expect(active).toBe(0); expect(settled).toBe(aborted)
    expect(result.coverage).toMatchObject({ complete: false, completedHistories: 0,
      failedEndpoint: "/session/session-1/message?limit=10000" })
    expect(result.failure?.endpoint).toBe("/session/session-1/message?limit=10000")
    const retry = await collectFinalSessionCensus({ sessions, messages, phase: "retry", graceMs: 500, pollMs: 1,
      api: async path => {
        expect(active).toBe(0)
        if (path === "/session?limit=10000") return sessionRows.slice(0, 1)
        return path === "/session/status" ? {} : []
      } })
    expect(retry.outcome).toBe("quiescent")
    expect(retry.coverage?.complete).toBe(true); expect(retry.failure).toBeUndefined()
  })

  test("a later healthy final poll clears an earlier failure and requires stable complete snapshots", async () => {
    let lists = 0
    const result = await collectFinalSessionCensus({ sessions: new Map(), messages: new Map(), phase: "final", graceMs: 500, pollMs: 1,
      api: async path => {
        if (path === "/session?limit=10000") {
          if (++lists === 1) throw new Error("transient host failure")
          return sessionRows.slice(0, 1)
        }
        return path === "/session/status" ? {} : []
      } })
    expect(result.outcome).toBe("quiescent"); expect(result.stableQuiescentRounds).toBe(2)
    expect(lists).toBe(3)
    expect(result.coverage?.complete).toBe(true); expect(result.failure).toBeUndefined()
  })
})

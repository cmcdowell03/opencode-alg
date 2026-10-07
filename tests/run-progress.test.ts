import { describe, expect, test } from "bun:test"
import { buildRunProgress, MAX_LIVE_NODES, parseRunProgress } from "../src/run-progress.ts"
import type { RunState } from "../src/types.ts"

function fixture(count = 3): RunState {
  const nodes = Object.fromEntries(Array.from({ length: count }, (_, index) => {
    const id = `node-${index + 1}`
    return [id, {
      id,
      agent: "implementer",
      status: "done",
      attempts: [{ attempt: 1, status: "done", started_at: "2026-01-01T00:00:00.000Z", failures: [],
        output: { secret: "private output" } }],
      current_attempt: 1,
      last_failures: ["private diagnostic"],
    }]
  }))
  return {
    schema_version: 2,
    revision: 7,
    run_id: "run-safe",
    owner_session_id: "owner-safe",
    parent_session_id: "owner-safe",
    owner_transfers: [],
    project_directory: "/private/project",
    goal: "secret prompt",
    criteria: [],
    criteria_locked: false,
    graph: {
      name: "private graph",
      nodes: Array.from({ length: count }, (_, index) => ({
        id: `node-${index + 1}`,
        agent: "implementer",
        depends_on: [],
        description: "private node description",
      })),
      max_global_attempts: Math.max(1, count),
      max_concurrency: 8,
    },
    status: "running",
    phase: "execute",
    nodes,
    global_attempts: count,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:01.000Z",
    mode: "live",
    model_snapshot: {},
    session_isolation: "sdk-child-session",
  } as RunState
}

describe("live run progress contract", () => {
  test("counts all nodes, caps rows, and prioritizes unfinished nodes deterministically", () => {
    const run = fixture(45)
    run.nodes["node-45"]!.status = "running"
    run.nodes["node-44"]!.status = "ready"
    run.nodes["node-43"]!.status = "pending"
    const progress = buildRunProgress(run)

    expect(progress.nodes).toHaveLength(MAX_LIVE_NODES)
    expect(progress.nodes.slice(0, 3).map((node) => [node.id, node.status])).toEqual([
      ["node-45", "running"], ["node-43", "ready"], ["node-44", "ready"],
    ])
    expect(progress.nodes_total).toBe(45)
    expect(progress.nodes_omitted).toBe(13)
    expect(progress.counts).toEqual({ pending: 0, ready: 2, running: 1, done: 42, failed: 0, skipped: 0 })
    expect(parseRunProgress(progress, "owner-safe")).toEqual(progress)
  })

  test("derives ready state and emits only the privacy-limited projection", () => {
    const run = fixture(2)
    run.nodes["node-1"]!.status = "done"
    run.nodes["node-2"]!.status = "pending"
    run.graph.nodes[1]!.depends_on = ["node-1"]
    run.nodes["node-2"]!.current_attempt = 2
    run.nodes["node-2"]!.attempts = [{
      attempt: 2,
      status: "running",
      session_id: `child-${"é".repeat(130)}`,
      started_at: "2026-01-01T00:00:00.000Z",
      failures: ["diagnostic secret"],
      output: "output secret",
    }]
    const progress = buildRunProgress(run)
    expect(progress.nodes[0]).toMatchObject({ id: "node-2", status: "ready", attempt: 2, retries: 1 })
    expect(progress.nodes[0]!.session_id).toBeUndefined()
    const serialized = JSON.stringify(progress)
    for (const secret of ["secret prompt", "private diagnostic", "output secret", "private graph", "/private/project"])
      expect(serialized).not.toContain(secret)
    expect(Object.keys(progress.nodes[0]!).sort()).toEqual(["agent", "attempt", "id", "retries", "started_at", "status"])

    run.nodes["node-2"]!.attempts[0]!.session_id = "child-safe"
    expect(buildRunProgress(run).nodes[0]!.session_id).toBe("child-safe")
    run.nodes["node-2"]!.attempts[0]!.session_id = "x".repeat(256)
    expect(buildRunProgress(run).nodes[0]!.session_id).toBe("x".repeat(256))
    run.nodes["node-2"]!.attempts[0]!.session_id = "child\u0001unsafe"
    expect(buildRunProgress(run).nodes[0]!.session_id).toBeUndefined()
  })

  test("parser checks owner first, rejects unknown or inconsistent data, and returns a fresh object", () => {
    const progress = buildRunProgress(fixture())
    expect(parseRunProgress({ ...progress, diagnostics: "do not accept" }, "other-owner")).toBeNull()
    expect(parseRunProgress({ ...progress, diagnostics: "do not accept" }, "owner-safe")).toBeNull()
    expect(parseRunProgress({ ...progress, nodes_omitted: 1 }, "owner-safe")).toBeNull()
    expect(parseRunProgress({ ...progress, updated_at: "yesterday" }, "owner-safe")).toBeNull()
    const parsed = parseRunProgress(progress, "owner-safe")!
    expect(parsed).not.toBe(progress)
    expect(parsed.nodes).not.toBe(progress.nodes)
    expect(parsed.nodes[0]).not.toBe(progress.nodes[0])
  })
})

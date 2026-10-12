import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { createAlgTools } from "../src/tools.ts"
import { createRun, persistRun } from "../src/store.ts"
import { ascendingPartId, createRunCardProjector, RunCardProjector, type RunCardPart } from "../src/run-cards.ts"
import type { GraphDef, RunState } from "../src/types.ts"
import { removeProject, tempProject } from "./helpers.ts"

const success = JSON.stringify({ summary: ["done"], files_touched: [], commands_run: [], risks: [], done: true })

function graph(nodes: GraphDef["nodes"], maxGlobalAttempts = nodes.length): GraphDef {
  return { name: "cards-test", nodes, max_global_attempts: maxGlobalAttempts, max_concurrency: 8 }
}

function context(project: string, abort = new AbortController().signal) {
  return { sessionID: "owner", messageID: "msg_parent", agent: "orchestrator", directory: project, worktree: project,
    abort, ask: async () => {}, metadata: () => {} } as any
}

function planned(project: string, definition: GraphDef, runId: string): RunState {
  const run = createRun({ goal: "show native cards", criteria: [], graph: definition, projectDirectory: project,
    ownerSessionId: "owner", runId, mode: "live" })
  persistRun(run, project)
  return run
}

/** A fake host: records every part the plugin writes, the way OpenCode's part-update endpoint would store it. */
class FakeHost {
  readonly writes: Array<{ url: string; path: any; query: any; part: RunCardPart }> = []
  reject = false
  created = 0
  prompt: (request: any) => Promise<any> = async () => ({ data: { parts: [{ type: "text", text: success }] }, error: undefined })
  readonly logs: string[] = []
  client(withTransport = true) {
    return {
      app: { log: async (request: any) => { this.logs.push(request.body.message); return { data: true } } },
      session: {
        create: async () => ({ data: { id: `child-${++this.created}` }, error: undefined }),
        prompt: (request: any) => this.prompt(request),
        abort: async () => ({ data: true, error: undefined }),
      },
      ...(withTransport ? { _client: { patch: async (options: any) => {
        this.writes.push({ url: options.url, path: options.path, query: options.query, part: structuredClone(options.body) })
        return this.reject ? { error: { name: "NotFoundError" }, response: { ok: false, status: 404 } } : { data: options.body, response: { ok: true, status: 200 } }
      } } } : {}),
    }
  }
  /** Latest stored state per part id, in first-seen order. */
  cards(): RunCardPart[] {
    const latest = new Map<string, RunCardPart>()
    for (const write of this.writes) latest.set(write.part.id, write.part)
    return [...latest.values()]
  }
}

function tools(project: string, host: FakeHost, runtime: Record<string, unknown> = {}, withTransport = true) {
  return createAlgTools({ client: host.client(withTransport), project: { id: "project" }, directory: project, worktree: project } as never,
    undefined, undefined, runtime as never)
}

describe("native subagent cards", () => {
  test("a parallel fan-out shows one running task card per child, then completes each", async () => {
    const project = tempProject("alg-cards-parallel-")
    const host = new FakeHost()
    let started = 0
    let bothStarted!: () => void, release!: () => void
    const both = new Promise<void>((resolve) => { bothStarted = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    host.prompt = async () => { if (++started === 2) bothStarted(); await gate; return { data: { parts: [{ type: "text", text: success }] }, error: undefined } }
    try {
      planned(project, graph([
        { id: "left", agent: "implementer", depends_on: [] },
        { id: "right", agent: "implementer", depends_on: [] },
      ]), "parallel-cards")
      const call = tools(project, host).alg_run.execute({ run_id: "parallel-cards" }, context(project))
      await both

      const running = host.cards()
      expect(running.map((card) => card.state.status)).toEqual(["running", "running"])
      expect(running.map((card) => card.state.metadata.sessionId).sort()).toEqual(["child-1", "child-2"])
      for (const card of running) {
        expect(card).toMatchObject({ type: "tool", tool: "task", sessionID: "owner", messageID: "msg_parent",
          state: { input: { subagent_type: "implementer" }, metadata: { parentSessionId: "owner" } } })
        expect(card.id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
        expect(card.callID).toMatch(/^call_alg_[0-9a-f]{24}$/)
        // The parent model reads tool arguments from its history: the worker prompt must never be copied there.
        expect(card.state.input.prompt.length).toBeLessThan(160)
        expect(card.state.input.prompt).not.toContain("OUTPUT CONTRACT")
      }
      expect(new Set(running.map((card) => card.id)).size).toBe(2)
      expect(host.writes[0]).toMatchObject({ url: "/session/{sessionID}/message/{messageID}/part/{partID}",
        path: { sessionID: "owner", messageID: "msg_parent", partID: host.writes[0]!.part.id }, query: { directory: project } })

      release()
      const result = await call as { output: string; metadata: Record<string, unknown> }
      expect(result.metadata).toMatchObject({ status: "done" })
      const finished = host.cards()
      expect(finished.map((card) => card.state.status)).toEqual(["completed", "completed"])
      expect(finished.map((card) => card.id)).toEqual(running.map((card) => card.id))
      for (const card of finished) {
        if (card.state.status !== "completed") throw new Error("unreachable")
        expect(card.state.output.length).toBeLessThan(200)
        expect(card.state.time.end).toBeGreaterThanOrEqual(card.state.time.start)
      }
      expect(existsSync(join(project, ".opencode", "runs", "_cards", "parallel-cards.json"))).toBe(false)
    } finally { removeProject(project) }
  })

  test("a failed attempt becomes a failed card and its retry gets a new card", async () => {
    const project = tempProject("alg-cards-retry-")
    const host = new FakeHost()
    let calls = 0
    host.prompt = async () => ({ data: { parts: [{ type: "text", text: ++calls === 1 ? "not json at all" : success }] }, error: undefined })
    try {
      planned(project, graph([{ id: "work", agent: "implementer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } }], 2), "retry-cards")
      const result = await tools(project, host).alg_run.execute({ run_id: "retry-cards" }, context(project)) as { metadata: Record<string, unknown> }
      expect(result.metadata).toMatchObject({ status: "done" })
      const cards = host.cards()
      expect(cards.map((card) => [card.state.input.description, card.state.status])).toEqual([["work", "error"], ["work · attempt 2", "completed"]])
      expect(cards[0]!.state.status === "error" && cards[0]!.state.error).toContain("attempt 1 failed")
      expect(cards[1]!.id > cards[0]!.id).toBe(true)
    } finally { removeProject(project) }
  })

  test("shell nodes, dry runs, and the off setting create no cards", async () => {
    const project = tempProject("alg-cards-none-")
    try {
      const dry = new FakeHost()
      planned(project, graph([{ id: "work", agent: "implementer", depends_on: [] }]), "dry-cards")
      await tools(project, dry).alg_run.execute({ run_id: "dry-cards", dry: true }, context(project))
      expect(dry.writes).toEqual([])

      const off = new FakeHost()
      planned(project, graph([{ id: "work", agent: "implementer", depends_on: [] }]), "off-cards")
      const result = await tools(project, off, { subagentCards: "off" }).alg_run.execute({ run_id: "off-cards" }, context(project)) as { metadata: Record<string, unknown> }
      expect(result.metadata).toMatchObject({ status: "done" })
      expect(off.writes).toEqual([])

      const plain = new FakeHost()
      planned(project, graph([{ id: "work", agent: "implementer", depends_on: [] }]), "plain-cards")
      const withoutTransport = await tools(project, plain, {}, false).alg_run.execute({ run_id: "plain-cards" }, context(project)) as { metadata: Record<string, unknown> }
      expect(withoutTransport.metadata).toMatchObject({ status: "done" })
    } finally { removeProject(project) }
  })

  test("a host that rejects cards never changes the run and stops being asked", async () => {
    const project = tempProject("alg-cards-rejected-")
    const host = new FakeHost()
    host.reject = true
    try {
      planned(project, graph([
        { id: "one", agent: "implementer", depends_on: [] },
        { id: "two", agent: "implementer", depends_on: ["one"] },
        { id: "three", agent: "implementer", depends_on: ["two"] },
      ]), "rejected-cards")
      const result = await tools(project, host).alg_run.execute({ run_id: "rejected-cards" }, context(project)) as { metadata: Record<string, unknown> }
      expect(result.metadata).toMatchObject({ status: "done" })
      // A healthy run of this graph writes six times; a write already in flight may still land after the second rejection.
      expect(host.writes.length).toBeLessThanOrEqual(3)
      expect(host.logs.some((message) => message.includes("subagent cards disabled"))).toBe(true)
    } finally { removeProject(project) }
  })

  test("cancelling mid-run closes cards that were still running", async () => {
    const project = tempProject("alg-cards-cancel-")
    const host = new FakeHost()
    const controller = new AbortController()
    let started!: () => void
    const promptStarted = new Promise<void>((resolve) => { started = resolve })
    host.prompt = (request: any) => new Promise((resolve) => {
      started()
      request.signal?.addEventListener("abort", () => resolve({ data: undefined, error: { name: "AbortError", message: "aborted" } }), { once: true })
    })
    try {
      planned(project, graph([{ id: "work", agent: "implementer", depends_on: [] }]), "cancel-cards")
      const call = tools(project, host).alg_run.execute({ run_id: "cancel-cards" }, context(project, controller.signal))
      await promptStarted
      expect(host.cards().map((card) => card.state.status)).toEqual(["running"])
      controller.abort()
      await call
      expect(host.cards().map((card) => card.state.status)).toEqual(["error"])
    } finally { removeProject(project) }
  })
})

describe("run card projector", () => {
  function fixture(project: string) {
    const run = createRun({ goal: "projector", criteria: [], graph: graph([{ id: "work", agent: "explorer", depends_on: [] }]),
      projectDirectory: project, ownerSessionId: "owner", runId: "projector-run", mode: "live" })
    const writes: RunCardPart[] = []
    const projector = () => new RunCardProjector({ transport: { upsert: async (part) => { writes.push(structuredClone(part)) } },
      project, runId: run.run_id, parentSessionId: "owner", messageId: "msg_parent" })
    const start = (attempt: number, child: string) => {
      run.nodes.work!.attempts.push({ attempt, status: "running", started_at: new Date().toISOString(), failures: [], session_id: child })
      run.nodes.work!.current_attempt = attempt
      run.nodes.work!.status = "running"
    }
    return { run, writes, projector, start }
  }

  test("cards a crashed process left running are closed by the next call, and earlier attempts are not redrawn", async () => {
    const project = tempProject("alg-cards-stale-")
    try {
      const { run, writes, projector, start } = fixture(project)
      const sidecar = join(project, ".opencode", "runs", "_cards", "projector-run.json")
      const crashed = projector()
      crashed.prime(run)
      start(1, "child-1")
      crashed.observe(run)
      await Bun.sleep(10)
      expect(writes.map((part) => part.state.status)).toEqual(["running"])
      expect(existsSync(sidecar)).toBe(true)

      // The process dies here: no settle. A later resume marks the interrupted attempt failed and starts another.
      run.nodes.work!.attempts[0]!.status = "failed"
      const resumed = projector()
      resumed.prime(run)
      start(2, "child-2")
      resumed.observe(run)
      await resumed.settle()
      expect(writes.map((part) => [part.id === writes[0]!.id, part.state.status])).toEqual([
        [true, "running"], [true, "error"], [false, "running"], [false, "error"],
      ])
      expect(existsSync(sidecar)).toBe(false)
    } finally { removeProject(project) }
  })

  test("observer errors and late calls never throw", async () => {
    const project = tempProject("alg-cards-safe-")
    try {
      const { run, start } = fixture(project)
      const failing = new RunCardProjector({ transport: { upsert: async () => { throw new Error("offline") } },
        project, runId: run.run_id, parentSessionId: "owner", messageId: "msg_parent" })
      failing.prime(run)
      start(1, "child-1")
      expect(() => failing.observe(run)).not.toThrow()
      start(2, "child-2")
      failing.observe(run)
      await failing.settle()
      expect(failing.active).toBe(false)
      expect(() => failing.observe(run)).not.toThrow()
      expect(createRunCardProjector("native", {}, { project, directory: project, runId: "x", parentSessionId: "owner", messageId: "m" })).toBeNull()
      expect(createRunCardProjector("native", { _client: { patch: async () => ({}) } }, { project, directory: project, runId: "x", parentSessionId: "owner", messageId: undefined })).toBeNull()
    } finally { removeProject(project) }
  })

  test("part ids use the host layout and stay ordered within a millisecond", () => {
    const now = Date.now()
    const ids = Array.from({ length: 50 }, () => ascendingPartId(now))
    for (const id of ids) expect(id).toMatch(/^prt_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect([...ids].sort()).toEqual(ids)
    expect(ascendingPartId(now + 1) > ids.at(-1)!).toBe(true)
  })
})

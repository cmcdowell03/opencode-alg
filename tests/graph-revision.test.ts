import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { MAX_GRAPH_STATE_BYTES } from "../src/limits.ts"
import { join } from "node:path"
import { createRun, loadRun, runDir } from "../src/store.ts"
import { graphSha256, GraphRevisionReceiptSchema, reviseGraph } from "../src/graph-revision.ts"
import { createAlgTools } from "../src/tools.ts"
import type { GraphDef, RunState } from "../src/types.ts"
import { inertClient, removeProject, executeContext } from "./helpers.ts"
import { executeRun } from "../src/executor.ts"

function tempProject(label = ".graph-revision-test-"): string {
  return realpathSync.native(mkdtempSync(join(process.cwd(), label)))
}

function toolContext(project: string, sessionID = "owner") {
  return { sessionID, messageID: "m", agent: "orchestrator", directory: project, worktree: project,
    abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as never
}

function graph(nodes: GraphDef["nodes"], global = 4): GraphDef {
  return { name: "bounded", max_global_attempts: global, max_concurrency: 2, nodes }
}

function fixture(definition = graph([
  { id: "work", agent: "implementer", depends_on: [] },
  { id: "review", agent: "researcher", depends_on: ["work"] },
])) {
  const project = tempProject("alg-graph-revision-")
  const run = createRun({ goal: "preserve task", criteria: ["immutable"], graph: definition,
    projectDirectory: project, ownerSessionId: "owner", mode: "dry" })
  return { project, run }
}

describe("bounded V1 graph revisions", () => {
  test("reload and revision retain completed work and spend while adding a bounded probe", async () => {
    const project = tempProject("alg-revision-resume-")
    try {
      const definition = graph([
        { id: "work", agent: "implementer", depends_on: [] },
        { id: "review", agent: "researcher", depends_on: ["work"] },
      ])
      const run = createRun({ goal: "reuse the expensive observation", criteria: ["immutable"], graph: definition,
        projectDirectory: project, ownerSessionId: "owner" })
      let workCalls = 0, otherCalls = 0
      const runner = async (options: { agent: string }) => {
        if (options.agent === "implementer") {
          workCalls++
          return { session_id: "observations", text: "", parsed: { summary: ["PINNED_OBSERVATION"], files_touched: [], commands_run: [], risks: [], done: true } }
        }
        otherCalls++
        return { session_id: `review-${otherCalls}`, text: "", parsed: { answer: "Preserved observation", evidence: [], constraints: [], options: [], acceptance_criteria: ["immutable"], risks: [] } }
      }
      const options = { ...executeContext(project), parentSessionId: "owner", sessionRunner: runner }
      const blocked = await executeRun(run, { ...options, maxWaves: 1 })
      expect(blocked.status).toBe("blocked")
      expect(blocked.global_attempts).toBe(1)
      const tools = createAlgTools({ client: inertClient(), worktree: project, directory: project } as never)
      const candidate = graph([
        definition.nodes[0]!,
        { id: "probe", agent: "researcher", depends_on: ["work"], inputs: { observation: "work" }, description: "Test one alternative using the existing observation" },
        { ...definition.nodes[1]!, depends_on: ["work", "probe"], inputs: { observation: "work", probe: "probe" } },
      ])
      const response = JSON.parse((await tools.alg_plan.execute({ revise_run_id: run.run_id, expected_graph_sha256: graphSha256(definition),
        graph_json: JSON.stringify(candidate), revision_reason: "Add one bounded alternative check" }, toolContext(project)) as { output: string }).output)
      expect(response.error).toBeUndefined()
      const reloaded = loadRun(project, run.run_id)!
      expect(reloaded.global_attempts).toBe(1)
      const completed = await executeRun(reloaded, options)
      expect(completed.status).toBe("done")
      expect(completed.global_attempts).toBe(3)
      expect(completed.graph.max_global_attempts).toBe(4)
      expect(completed.nodes.work!.current_attempt).toBe(1)
      expect(workCalls).toBe(1)
      expect(otherCalls).toBe(2)
    } finally { removeProject(project) }
  })
  test("changes pending nodes and adds bounded work without changing caps or run identity", () => {
    const f = fixture()
    try {
      const revisedGraph = graph([
        { id: "work", agent: "implementer", depends_on: [], description: "clarified pending task" },
        { id: "review", agent: "researcher", depends_on: ["work"] },
        { id: "verify", agent: "checker", depends_on: ["review"] },
      ])
      const result = reviseGraph({ run: f.run, graph: revisedGraph, expectedGraphSha256: graphSha256(f.run.graph),
        requestedBy: "owner", reason: "Clarify the unattempted work", createdAt: "2026-11-11T12:00:00Z" })
      expect(result.graph).toEqual(revisedGraph)
      expect(result.nodes).toEqual({ ...f.run.nodes, verify: expect.objectContaining({ status: "pending", current_attempt: 0 }) })
      expect(result.receipt).toMatchObject({
        parent_sha256: graphSha256(f.run.graph), graph_sha256: graphSha256(revisedGraph), requested_by: "owner",
        reason: "Clarify the unattempted work",
      })
      expect(result.receipt.changed_nodes.map((entry) => entry.node_id)).toEqual(["verify", "work"])
      expect(GraphRevisionReceiptSchema.parse(JSON.parse(JSON.stringify(result.receipt)))).toEqual(result.receipt)
      expect(f.run.goal).toBe("preserve task")
      expect(f.run.criteria).toEqual(["immutable"])
      expect(f.run.mode).toBe("dry")
    } finally { removeProject(f.project) }
  })

  test("rejects stale hashes, raised caps, capacity growth beyond root budget, and feedback loops", () => {
    const f = fixture()
    try {
      const current = f.run.graph
      const base = { run: f.run, expectedGraphSha256: graphSha256(current), requestedBy: "owner", reason: "bounded edit" }
      expect(() => reviseGraph({ ...base, expectedGraphSha256: "0".repeat(64), graph: current })).toThrow(/stale/)
      expect(() => reviseGraph({ ...base, graph: { ...current, max_global_attempts: 5 } })).toThrow(/global attempt cap/)
      expect(() => reviseGraph({ ...base, graph: { ...current, max_concurrency: 3 } })).toThrow(/concurrency cap/)
      expect(() => reviseGraph({ ...base, graph: graph([
        { ...current.nodes[0]!, loop: { max_attempts: 2, gate: "schema" } }, current.nodes[1]!,
      ]) })).toThrow(/local attempt cap/)
      expect(() => reviseGraph({ ...base, graph: graph([
        ...current.nodes,
        { id: "extra", agent: "implementer", depends_on: [], loop: { max_attempts: 3, gate: "schema" } },
      ]) })).toThrow(/original global attempt cap/)
      expect(() => reviseGraph({ ...base, graph: graph([
        ...current.nodes,
        { id: "loop", agent: "checker", depends_on: ["work"], feedback_to: "work" },
      ]) })).toThrow(/feedback loops/)
    } finally { removeProject(f.project) }
  })

  test("preserves attempted definitions, state, history, and output exactly", () => {
    const f = fixture()
    try {
      const run = structuredClone(f.run) as RunState
      run.status = "blocked"
      run.nodes.work!.status = "done"
      run.nodes.work!.current_attempt = 1
      run.nodes.work!.attempts = [{ attempt: 1, status: "done", started_at: "2026-11-11T12:00:00Z",
        finished_at: "2026-11-11T12:00:01Z", output: { committed: true }, failures: [] }]
      run.nodes.work!.output = { committed: true }
      const before = structuredClone(run.nodes.work)
      const revised = graph([
        run.graph.nodes[0]!,
        { id: "review", agent: "researcher", depends_on: ["work"], description: "pending-only adjustment" },
      ])
      const result = reviseGraph({ run, graph: revised, expectedGraphSha256: graphSha256(run.graph),
        requestedBy: "owner", reason: "Adjust pending review" })
      expect(result.nodes.work).toEqual(before)
      expect(() => reviseGraph({ run, graph: graph([
        { ...run.graph.nodes[0]!, description: "altered evidence source" }, run.graph.nodes[1]!,
      ]), expectedGraphSha256: graphSha256(run.graph), requestedBy: "owner", reason: "bad" }))
        .toThrow(/pending node definitions|attempted evidence/)
      const single = fixture(graph([{ id: "work", agent: "implementer", depends_on: [] }]))
      try {
        single.run.nodes.work!.current_attempt = 1
        single.run.nodes.work!.status = "done"
        expect(() => reviseGraph({ run: single.run, graph: graph([{ id: "other", agent: "implementer", depends_on: [] }]),
          expectedGraphSha256: graphSha256(single.run.graph), requestedBy: "owner", reason: "remove attempted" }))
          .toThrow(/pending node definitions|attempted evidence/)
      } finally { removeProject(single.project) }
    } finally { removeProject(f.project) }
  })

  test("rejects running, unknown, terminal, and managed-investigation runs", () => {
    const f = fixture()
    try {
      const base = { graph: f.run.graph, expectedGraphSha256: graphSha256(f.run.graph), requestedBy: "owner", reason: "try" }
      const running = structuredClone(f.run) as RunState
      running.nodes.work!.status = "running"
      expect(() => reviseGraph({ ...base, run: running })).toThrow(/is running/)
      const unknown = structuredClone(f.run) as RunState
      unknown.nodes.work!.status = "mystery" as never
      expect(() => reviseGraph({ ...base, run: unknown })).toThrow(/unknown node outcome/)
      const terminal = { ...f.run, status: "done" } as RunState
      expect(() => reviseGraph({ ...base, run: terminal })).toThrow(/planning or blocked/)
      const managed = { ...f.run, investigation: { schema_version: 1 as const, project_id: "a".repeat(64), owner_id: "owner", run_id: f.run.run_id } }
      expect(() => reviseGraph({ ...base, run: managed })).toThrow(/managed investigation/)
    } finally { removeProject(f.project) }
  })

  test("does not remove or weaken existing checker definitions and dependencies", () => {
    const f = fixture(graph([
      { id: "work", agent: "implementer", depends_on: [] },
      { id: "check", agent: "checker", depends_on: ["work"] },
    ]))
    try {
      const base = { run: f.run, expectedGraphSha256: graphSha256(f.run.graph), requestedBy: "owner", reason: "unsafe" }
      expect(() => reviseGraph({ ...base, graph: graph([f.run.graph.nodes[0]!]) })).toThrow(/checker.*cannot be removed/)
      expect(() => reviseGraph({ ...base, graph: graph([
        f.run.graph.nodes[0]!, { ...f.run.graph.nodes[1]!, depends_on: [] },
      ]) })).toThrow(/existing checker.*immutable/)
      expect(() => reviseGraph({ ...base, graph: graph([
        { ...f.run.graph.nodes[0]!, depends_on: ["check"] }, f.run.graph.nodes[1]!,
      ]) })).toThrow()
    } finally { removeProject(f.project) }
  })

  test("uses immutable content-addressed run artifacts for graph-version retrieval", async () => {
    const f = fixture()
    try {
      // alg_plan writes the initial content-addressed version; the digest makes
      // retrieval independent of mutable graph.json projections.
      const tools = createAlgTools({ client: inertClient(), project: { id: "project" }, directory: f.project, worktree: f.project } as never)
      const result = tools.alg_plan.execute({ goal: "persist root graph", mode: "dry" }, toolContext(f.project))
      const response = await result
      const output = JSON.parse((response as { output: string }).output)
      expect(output.error).toBeUndefined()
      const digest = output.graph_sha256
      expect(digest).toMatch(/^[a-f0-9]{64}$/)
      expect(readFileSync(join(runDir(f.project, output.run_id), "artifacts", `graph-${digest}.json`), "utf8")).toContain('"name":"coding-diamond"')
    } finally { removeProject(f.project) }
  })

  test("revises through alg_plan with ownership, CAS, persisted receipts, status digest, and historical artifact retrieval", async () => {
    const project = tempProject()
    try {
      const tools = createAlgTools({ client: inertClient(), project: { id: "project" }, directory: project, worktree: project } as never)
      const planned = JSON.parse((await tools.alg_plan.execute({
        goal: "revise pending graph", mode: "dry", graph_json: JSON.stringify(graph([
          { id: "work", agent: "implementer", depends_on: [] },
        ])),
      }, toolContext(project)) as { output: string }).output)
      const initialHash = planned.graph_sha256 as string
      const runId = planned.run_id as string
      const revisionGraph = graph([
        { id: "work", agent: "implementer", depends_on: [], description: "clarified" },
        { id: "probe", agent: "researcher", depends_on: ["work"] },
      ])
      const stale = await tools.alg_plan.execute({ revise_run_id: runId, expected_graph_sha256: "0".repeat(64),
        revision_reason: "stale", graph_json: JSON.stringify(revisionGraph) }, toolContext(project))
      expect(JSON.parse((stale as { output: string }).output).error).toContain("stale")
      const wrongOwner = await tools.alg_plan.execute({ revise_run_id: runId, expected_graph_sha256: initialHash,
        revision_reason: "wrong owner", graph_json: JSON.stringify(revisionGraph) }, toolContext(project, "stranger"))
      expect(JSON.parse((wrongOwner as { output: string }).output).error).toContain("does not own")
      const accepted = JSON.parse((await tools.alg_plan.execute({ revise_run_id: runId, expected_graph_sha256: initialHash,
        revision_reason: "Add a bounded evidence probe", graph_json: JSON.stringify(revisionGraph) }, toolContext(project)) as { output: string }).output)
      const nextGraph = graph([
        ...revisionGraph.nodes,
        { id: "probe2", agent: "researcher", depends_on: ["probe"] },
      ])
      const second = JSON.parse((await tools.alg_plan.execute({ revise_run_id: runId,
        expected_graph_sha256: accepted.graph_sha256, revision_reason: "Add one final bounded probe",
        graph_json: JSON.stringify(nextGraph) }, toolContext(project)) as { output: string }).output)
      const persisted = loadRun(project, runId)!
      expect(persisted.graph_revisions).toHaveLength(2)
      expect(persisted.graph_revisions![0]).toEqual(accepted.graph_revision)
      expect(persisted.graph_revisions![1]).toEqual(second.graph_revision)
      expect(persisted.graph_revisions![1]!.parent_sha256).toBe(persisted.graph_revisions![0]!.graph_sha256)
      expect(graphSha256(persisted.graph)).toBe(second.graph_sha256)
      expect(JSON.parse(readFileSync(join(runDir(project, runId), "artifacts", `graph-${second.graph_sha256}.json`), "utf8")))
        .toEqual(persisted.graph)
      const status = JSON.parse((await tools.alg_status.execute({ run_id: runId }, toolContext(project)) as { output: string }).output)
      expect(status.graph_sha256).toBe(second.graph_sha256)
      const historical = JSON.parse((await tools.alg_artifact.execute({ run_id: runId, graph_sha256: initialHash, detail: "full" },
        toolContext(project)) as { output: string }).output)
      expect(historical.graph_sha256).toBe(initialHash)
      expect(historical.graph.name).toBe("bounded")
      const orphan = graphSha256({ ...persisted.graph, description: "uncommitted proposal" })
      const refused = JSON.parse((await tools.alg_artifact.execute({ run_id: runId, graph_sha256: orphan }, toolContext(project)) as { output: string }).output)
      expect(refused.error).toContain("not an accepted revision")
      writeFileSync(join(runDir(project, runId), "artifacts", `graph-${initialHash}.json`), " ".repeat(MAX_GRAPH_STATE_BYTES + 1))
      const oversized = JSON.parse((await tools.alg_artifact.execute({ run_id: runId, graph_sha256: initialHash }, toolContext(project)) as { output: string }).output)
      expect(oversized.error).toContain("byte limit")
    } finally { removeProject(project) }
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import server from "../src/index.ts"
import { formatStaleRunNotice, isStaleRun, STALE_RUN_AGE_MS } from "../src/compaction.ts"
import { closeRun } from "../src/executor.ts"
import { createAlgTools } from "../src/tools.ts"
import { createRun, findLatestIncompleteRunForSession, loadRun, persistRun, runDir } from "../src/store.ts"
import type { GraphDef } from "../src/types.ts"
import { removeProject, tempProject } from "./helpers.ts"

const dirs: string[] = []
const project = (label: string) => { const path = tempProject(label); dirs.push(path); return path }
afterEach(() => { dirs.splice(0).forEach(removeProject) })

const success = JSON.stringify({ summary: ["done"], files_touched: [], commands_run: [], risks: [], done: true })
const twoSteps: GraphDef = { name: "close", max_global_attempts: 4, max_concurrency: 1, nodes: [
  { id: "first", agent: "implementer", depends_on: [] }, { id: "second", agent: "implementer", depends_on: ["first"] }] }

function context(path: string) {
  return { sessionID: "owner", messageID: "msg_parent", agent: "orchestrator", directory: path, worktree: path,
    abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } as any
}
function tools(path: string) {
  let created = 0
  const client = { session: {
    create: async () => ({ data: { id: `child-${++created}` }, error: undefined }),
    prompt: async () => ({ data: { parts: [{ type: "text", text: success }] }, error: undefined }),
  } }
  return createAlgTools({ client, project: { id: "project" }, directory: path, worktree: path } as never)
}
const output = (result: unknown) => JSON.parse((result as { output: string }).output)

describe("ending a run that will not be continued", () => {
  test("alg_resume close=true fails the unfinished nodes, keeps what finished, and stops offering the run", async () => {
    const path = project("alg-close-")
    const run = createRun({ goal: "close me", criteria: [], graph: twoSteps, projectDirectory: path, ownerSessionId: "owner", runId: "to-close", mode: "live" })
    const alg = tools(path)
    expect(output(await alg.alg_run.execute({ run_id: run.run_id, max_waves: 1 }, context(path))).status).toBe("blocked")
    expect(findLatestIncompleteRunForSession(path, "owner")?.run_id).toBe("to-close")

    const closed = output(await alg.alg_resume.execute({ run_id: run.run_id, close: true, close_reason: "superseded by a different approach" }, context(path)))
    expect(closed).toMatchObject({ run_id: "to-close", closed: true, status: "failed", nodes: { done: 1, failed: 1, skipped: 0 } })

    const saved = loadRun(path, run.run_id)!
    expect(saved.status).toBe("failed")
    expect(saved.nodes.first).toMatchObject({ status: "done", current_attempt: 1 })
    expect(saved.nodes.second!.status).toBe("failed")
    expect(saved.nodes.second!.last_failures).toEqual(["Run closed by its owner: superseded by a different approach"])
    expect(saved.nodes.second!.attempts).toHaveLength(0)
    expect(findLatestIncompleteRunForSession(path, "owner")).toBeNull()

    // A closed run is finished: it cannot be closed twice.
    const again = await alg.alg_resume.execute({ run_id: run.run_id, close: true }, context(path)) as { output: string }
    expect(again.output).toContain("already failed")
  })

  test("a run left mid-attempt by a crashed process closes cleanly", () => {
    const path = project("alg-close-crashed-")
    const run = createRun({ goal: "crashed", criteria: [], graph: twoSteps, projectDirectory: path, ownerSessionId: "owner", runId: "crashed", mode: "live" })
    run.status = "running"
    run.phase = "execute"
    run.global_attempts = 1
    run.nodes.first!.status = "running"
    run.nodes.first!.current_attempt = 1
    run.nodes.first!.attempts.push({ attempt: 1, status: "running", started_at: new Date().toISOString(), failures: [] })
    persistRun(run, path)

    const fresh = loadRun(path, "crashed")!
    closeRun(fresh, "it will not be continued")
    persistRun(fresh, path)
    const saved = loadRun(path, "crashed")!
    expect(saved.status).toBe("failed")
    expect(saved.nodes.first!.attempts[0]).toMatchObject({ status: "failed" })
    expect(saved.nodes.first!.status).toBe("failed")
    expect(saved.nodes.second!.status).toBe("failed")
    expect(saved.nodes.second!.last_failures[0]).toContain("Run closed by its owner")
  })

  test("close_reason alone is refused, and a finished run is not closed", async () => {
    const path = project("alg-close-refuse-")
    const run = createRun({ goal: "finish me", criteria: [], graph: twoSteps, projectDirectory: path, ownerSessionId: "owner", runId: "finished", mode: "live" })
    const alg = tools(path)
    const refused = await alg.alg_resume.execute({ run_id: run.run_id, close_reason: "typo" }, context(path)) as { output: string }
    expect(refused.output).toContain("close_reason requires close=true")
    expect(output(await alg.alg_run.execute({ run_id: run.run_id }, context(path))).status).toBe("done")
    const done = await alg.alg_resume.execute({ run_id: run.run_id, close: true }, context(path)) as { output: string }
    expect(done.output).toContain("already done")
    expect(loadRun(path, run.run_id)!.status).toBe("done")
  })
})

describe("a run nobody has touched for a week", () => {
  test("is offered as a short notice instead of a full summary", async () => {
    const path = project("alg-stale-run-")
    const run = createRun({ goal: "Old work. ".repeat(80).trim(), criteria: ["one", "two", "three"], graph: twoSteps, projectDirectory: path, ownerSessionId: "owner", runId: "old-run", mode: "live" })
    expect(isStaleRun(run)).toBe(false)
    expect(isStaleRun(run, Date.now() + STALE_RUN_AGE_MS + 60_000)).toBe(true)
    const notice = formatStaleRunNotice(run)
    expect(notice).toContain("- run_id: old-run")
    expect(notice).toContain("alg_resume close=true")
    expect(Buffer.byteLength(notice)).toBeLessThan(400)

    const plugin = { directory: path, worktree: path, project: { id: "fixture-project" }, client: {
      app: { log: async () => ({ data: true }) }, session: {
        get: async (request: any) => ({ data: { id: request.path.id, projectID: "fixture-project", directory: path, title: "normal" } }),
        messages: async () => ({ data: [] }), create: async () => { throw new Error("no model sessions here") }, prompt: async () => { throw new Error("no model calls here") },
      } } } as any
    const hooks = await server(plugin, { skillEvolution: { enabled: false } })
    try {
      const call = async () => {
        const system = { system: ["host policy"] }
        await hooks["experimental.chat.system.transform"]!({ sessionID: "owner", model: { limit: { context: 200_000, output: 8_000 } } } as any, system)
        return system.system.slice(1).join("\n")
      }
      const fresh = await call()
      expect(fresh).toContain("## ALG active run state")
      expect(fresh).toContain("### Nodes")

      // Age the saved run by eight days, as if the session had been left alone.
      const file = join(runDir(path, run.run_id), "progress.json")
      const saved = JSON.parse(readFileSync(file, "utf8"))
      saved.updated_at = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000).toISOString()
      writeFileSync(file, `${JSON.stringify(saved)}\n`)
      const stale = await call()
      expect(stale).toContain("## ALG unfinished run (not updated recently)")
      expect(stale).toContain("- run_id: old-run")
      expect(stale).not.toContain("### Nodes")
      expect(Buffer.byteLength(stale)).toBeLessThan(400)
    } finally { await hooks.dispose?.() }
  })
})

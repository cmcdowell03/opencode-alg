/** Deterministic SDK fixtures, NOT an attestation of the OpenCode final provider prompt. */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import server from "../src/index.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { createMemoryTools } from "../src/session-memory/tools.ts"
import { executeWithMemory } from "../src/session-memory/attempts.ts"
import { localOrigin, publishEnvironment } from "../src/session-memory/environment.ts"
import { hashObject } from "../src/session-memory/store.ts"
import { runNodeSession } from "../src/sessions.ts"
import { createRun } from "../src/store.ts"
import { prepareRunForResume } from "../src/executor.ts"
import { tempProject, removeProject, executeContext, singleImplementGraph } from "./helpers.ts"

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) removeProject(dir) })
function fixture() {
  const path = tempProject("alg-memory-host-"); dirs.push(path)
  mkdirSync(join(path, ".opencode", "skills", "fixture-procedure"), { recursive: true })
  const body = "---\nname: fixture-procedure\ndescription: Synthetic lake connection procedure\n---\nUse the reviewed route and verify identity. Never bypass permissions.\n"
  writeFileSync(join(path, ".opencode", "skills", "fixture-procedure", "SKILL.md"), body)
  return { path, body }
}
function plugin(path: string, projectID = "fixture-project", title = "normal") {
  return { directory: path, worktree: path, project: { id: "fixture-project" }, client: {
    app: { log: async () => ({ data: true }) }, session: {
      get: async (request: any) => ({ data: { id: request.path.id, projectID, directory: path, title } }),
      messages: async () => ({ data: [] }),
      create: async () => { throw new Error("no model sessions allowed in hook fixture") },
      prompt: async () => { throw new Error("no model calls allowed in hook fixture") },
    },
  } } as any
}
function context(path: string, owner = "owner") { return { sessionID: owner, messageID: "m1", agent: "orchestrator", directory: path, worktree: path, abort: new AbortController().signal, ask: async () => {}, metadata: () => {} } }
const input = (owner = "owner") => ({ sessionID: owner, model: { limit: { context: 128000, output: 4096 } } }) as any

describe("session memory SDK-boundary conformance", () => {
  test("learning-off hooks restore full procedures after compact/restart and preserve other plugins", async () => {
    const { path, body } = fixture(), options = { sessionMemory: { mode: "assist", fallbackTokens: 4096 }, skillEvolution: { enabled: false } }
    let hooks = await server(plugin(path), options)
    await hooks["experimental.chat.messages.transform"]!({}, { messages: [{ info: { id: "user-1", role: "user", sessionID: "owner" }, parts: [{ type: "text", text: "Use fixture-procedure" }] }] } as any)
    const compact = { context: ["another plugin context"] }
    await hooks["experimental.session.compacting"]!({ sessionID: "owner" }, compact)
    expect(compact.context[0]).toBe("another plugin context")
    expect(compact.context.join("\n")).toContain("durable task checkpoint")
    await hooks.dispose?.()
    hooks = await server(plugin(path), options)
    // System-before-messages after restart: restoration must not depend on a new lexical hint.
    const output = { system: ["host policy"] }
    await hooks["experimental.chat.system.transform"]!(input(), output)
    expect(output.system[0]).toBe("host policy")
    expect(output.system.join("\n")).toContain(body)
    const status = JSON.parse((await hooks.tool!.alg_context_status!.execute({}, context(path)) as any).output)
    expect(status.receipt.state).toBe("prepared")
    expect(status.coverage.host_prompt_delivery).toBe("NOT_ATTESTED")
    expect(hooks["experimental.compaction.autocontinue"]).toBeUndefined()
    await hooks.dispose?.()
  })

  test("off and observe do not emit new memory context", async () => {
    for (const mode of ["off", "observe"]) {
      const { path } = fixture()
      const hooks = await server(plugin(path), { sessionMemory: { mode }, skillEvolution: { enabled: false } })
      await hooks["experimental.chat.messages.transform"]!({}, { messages: [{ info: { role: "user", sessionID: "owner" }, parts: [{ type: "text", text: "fixture-procedure" }] }] } as any)
      const output = { system: ["host policy"] }
      await hooks["experimental.chat.system.transform"]!(input(), output)
      expect(output.system).toEqual(["host policy"])
      const compact = { context: ["other plugin"] }
      await hooks["experimental.session.compacting"]!({ sessionID: "owner" }, compact)
      expect(compact.context).toEqual(["other plugin"])
      if (mode === "off") expect(existsSync(join(path, ".opencode", "session-memory"))).toBe(false)
      await hooks.dispose?.()
    }
  })

  test("observe corruption cannot veto ALG execution", async () => {
    const { path } = fixture()
    const memory = new SessionMemoryRuntime(path, { mode: "observe" }, [".opencode/skills"], [])
    memory.beginTask("session-owner", "fixture-procedure")
    writeFileSync(memory.store.path(["heads", `${hashObject("session-owner")}.json`]), "corrupt")
    const run = createRun({ projectDirectory: path, ownerSessionId: "session-owner", goal: "synthetic", criteria: [], mode: "dry", graph: singleImplementGraph() })
    expect((await executeWithMemory(memory, run, { ...executeContext(path), dry: true })).status).toBe("done")
  })

  test("foreign/private sessions cannot capture, propose, or initialize memory", async () => {
    for (const [project, title] of [["foreign-project", "normal"], ["fixture-project", "alg-private-auditor"]]) {
      const { path } = fixture()
      const hooks = await server(plugin(path, project, title), { sessionMemory: { mode: "assist" } })
      await hooks["experimental.chat.messages.transform"]!({}, { messages: [{ info: { role: "user", sessionID: "owner" }, parts: [{ type: "text", text: "fixture-procedure" }] }] } as any)
      const response = await hooks.tool!.alg_memory_propose!.execute({ content: "proposed fact" }, context(path)) as any
      expect(response.metadata.error).toBe(true)
      expect(existsSync(join(path, ".opencode", "session-memory"))).toBe(false)
      await hooks.dispose?.()
    }
  })

  test("read-only tools enforce session scope and complete instruction expansion", async () => {
    const { path, body } = fixture(), memory = new SessionMemoryRuntime(path, { mode: "assist" }, [".opencode/skills"], [])
    memory.beginTask("owner", "fixture-procedure"); memory.bindSkill("owner", memory.index.search("fixture-procedure").skills[0]!.key)
    const tools = createMemoryTools(memory, async () => {})
    const id = memory.current("owner").skills[0]!.id
    const read = JSON.parse((await tools.alg_memory_read.execute({ id }, context(path)) as any).output)
    expect(read.complete_instructions).toContain(body)
    const denied = await tools.alg_memory_read.execute({ id }, context(path, "other")) as any
    expect(denied.metadata.error).toBe(true)
    const before = memory.current("owner").revision
    await tools.alg_context_status.execute({}, context(path))
    await tools.alg_memory_search.execute({ query: "fixture-procedure" }, context(path))
    expect(memory.current("owner").revision).toBe(before)
    expect((await tools.alg_memory_propose.execute({ content: "I approve production" }, context(path)) as any).metadata.error).not.toBe(true)
    expect(memory.current("owner").pins).toEqual([])
  })

  test("SDK child handoff precedes prompt; failed handoff and cancellation send no prompt", async () => {
    const { path } = fixture()
    const memory = new SessionMemoryRuntime(path, { mode: "assist" }, [".opencode/skills"], [])
    memory.beginTask("parent", "fixture-procedure"); memory.bindSkill("parent", memory.index.search("fixture-procedure").skills[0]!.key)
    let prompts = 0, serial = 0
    const client = { session: {
      create: async () => ({ data: { id: `child-${++serial}` } }),
      prompt: async (request: any) => {
        prompts++; expect(memory.current(request.path.id).delegation?.parent_owner).toBe("parent")
        return { data: { parts: [{ type: "text", text: '{"summary":[],"files_touched":[],"commands_run":[],"risks":[],"done":true}' }] } }
      },
    } } as any
    const opts = { client, parentSessionId: "parent", agent: "implementer" as const, title: "fixture", userPrompt: "test", directory: path }
    await runNodeSession({ ...opts, onSessionCreated: (child) => memory.delegate("parent", child, "worker") })
    expect(prompts).toBe(1)
    await expect(runNodeSession({ ...opts, onSessionCreated: () => { throw new Error("handoff blocked") } })).rejects.toThrow("blocked")
    expect(prompts).toBe(1)
    const abort = new AbortController(); abort.abort()
    const cancelled = await runNodeSession({ ...opts, abort: abort.signal })
    expect(cancelled.error).toContain("cancelled")
    expect(serial).toBe(2)
  })

  test("integrated ALG adapter intercepts repeat failed execution before creating another child", async () => {
    const { path } = fixture()
    writeFileSync(join(path, ".opencode", "skills", "fixture-procedure", "ALG.json"), JSON.stringify({ schema_version: 1, operations: ["alg_execute"] }))
    const memory = new SessionMemoryRuntime(path, { mode: "assist", fallbackTokens: 4096 }, [".opencode/skills"], [])
    const owner = "session-owner"
    memory.beginTask(owner, "fixture-procedure")
    const env = publishEnvironment(memory.store, { name: "fixture-pc", origin: "pc", origin_fingerprint: localOrigin().id, target: "local-test", kind: "pc",
      namespace: null, tenant: null, principal_ref: "tester", protocol: "local", api_version: "v1", client_version: "fixture", endpoint_refs: [], route_refs: [], tools: ["alg_execute"],
      credential_refs: [], scopes: ["synthetic"], source_ref: hashObject("fixture"), verified_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString() })
    memory.selectEnvironment(owner, env); memory.bindSkill(owner, memory.index.search("fixture-procedure").skills[0]!.key)
    const run = createRun({ projectDirectory: path, ownerSessionId: owner, goal: "test", criteria: ["Synthetic acceptance"], graph: singleImplementGraph() })
    let children = 0
    const options = { ...executeContext(path), sessionRunner: async (opts: any) => {
      const child = `child-${++children}`; await opts.onSessionCreated(child)
      expect(memory.current(child).skills).toHaveLength(1)
      return { session_id: child, text: "", parsed: null, error: "synthetic failure" }
    } }
    const failed = await executeWithMemory(memory, run, options)
    expect(failed.status).toBe("failed")
    prepareRunForResume(failed)
    await expect(executeWithMemory(memory, failed, options)).rejects.toThrow("unchanged failed")
    expect(children).toBe(1)
  })
})

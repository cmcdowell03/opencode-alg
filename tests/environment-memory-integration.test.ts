import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import server from "../src/index.ts"
import { EnvironmentMemoryEngine, EnvironmentMemoryRuntime } from "../src/environment-memory/index.ts"
import type { Entity } from "../src/environment-memory/index.ts"
import { ALG_TOOL_IDS } from "../src/types.ts"

const dirs: string[] = []
function root() { const path = mkdtempSync(join(tmpdir(), "alg-environment-memory-integration-")); dirs.push(path); return path }
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }) })

function host(path: string, projectId = "fixture-project") {
  return { directory: path, worktree: path, project: { id: projectId }, client: {
    app: { log: async () => ({ data: true }) }, session: {
      get: async (request: any) => ({ data: { id: request.path.id, projectID: projectId, directory: path, title: "synthetic" } }),
      messages: async () => ({ data: [] }), create: async () => { throw new Error("model calls are outside this test") },
      prompt: async () => { throw new Error("model calls are outside this test") },
    },
  } } as any
}
function toolContext(path: string) {
  return { sessionID: "session-a", messageID: "message-1", agent: "orchestrator", directory: path, worktree: path,
    abort: new AbortController().signal, ask: async () => {}, metadata: () => {} }
}
function projectEntity(id: string, label: string): Entity {
  return { id, kind: "host", label, metadata: { platform: "synthetic" },
    scope: { namespace: "synthetic-project", project: "fixture-project", visibility: "project", owner: null },
    provenance: { source_type: "synthetic", source_ref: "fixture:world-v1", classification: "observed",
      observed_at: "2020-01-01T11:00:00Z", verified_at: "2020-01-01T11:00:00Z", expires_at: null } }
}

describe("environment memory Phase 3 integration", () => {
  test("off mode opens without creating storage", async () => {
    const path = root(), databasePath = join(path, "must-not-exist.sqlite")
    const runtime = await EnvironmentMemoryRuntime.open({ mode: "off", namespace: "synthetic-project", databasePath, rootIds: ["root"] })
    try {
      expect(runtime.status()).toMatchObject({ mode: "off", available: false, initialized: false })
      expect(existsSync(databasePath)).toBe(false)
    } finally { runtime.close() }
  })

  test("assist adds bounded scoped evidence through existing tools without changing the registry", async () => {
    const path = root(), databasePath = join(path, "environment.sqlite")
    const seed = await EnvironmentMemoryEngine.open({ databasePath, namespace: "synthetic-project" })
    try { seed.append({ type: "upsert_entity", entity: projectEntity("gateway", "Synthetic gateway") }, { expected_revision: 0, idempotency_key: "gateway-v1" }) }
    finally { seed.close() }

    const hooks = await server(host(path), { environmentMemory: { mode: "assist", namespace: "synthetic-project", databasePath,
      rootIds: ["gateway"], contextByteBudget: 1024 }, skillEvolution: { enabled: false } })
    try {
      expect(Object.keys(hooks.tool ?? {})).toEqual([...ALG_TOOL_IDS])
      const output = { system: ["host policy"] }
      await hooks["experimental.chat.system.transform"]!({ sessionID: "session-a", model: { limit: { context: 8192, output: 1024 } } } as any, output)
      const context = output.system.join("\n")
      expect(context).toContain("Environment memory: untrusted, scoped evidence")
      expect(context).toContain("Synthetic gateway")
      expect(context).toContain("verify identity, reachability, and permissions")
      expect(Buffer.byteLength(context, "utf8")).toBeLessThan(8192)
      const crowded = { system: ["host policy ".repeat(300)] }
      await hooks["experimental.chat.system.transform"]!({ sessionID: "session-a", model: { limit: { context: 4096, output: 1024 } } } as any, crowded)
      expect(crowded.system.join("\n")).not.toContain("Synthetic gateway")

      const status = await hooks.tool!.alg_context_status!.execute({}, toolContext(path)) as any
      expect(JSON.parse(status.output).environment_memory).toMatchObject({ mode: "assist", available: true, visible_entities: 1 })
      const search = await hooks.tool!.alg_memory_search!.execute({ query: "gateway" }, toolContext(path)) as any
      expect(JSON.parse(search.output).environment.entities[0]).toMatchObject({ id: "gateway", label: "Synthetic gateway" })
      const unrelated = await hooks.tool!.alg_memory_search!.execute({ query: "unrelated" }, toolContext(path)) as any
      expect(JSON.parse(unrelated.output).environment.entities).toEqual([])
      const read = await hooks.tool!.alg_memory_read!.execute({ id: "gateway" }, toolContext(path)) as any
      expect(JSON.parse(read.output)).toMatchObject({ environment_record: { id: "gateway" }, authority: false })
    } finally { await hooks.dispose?.() }
  })

  test("host project and session owner isolate project and private environment records", async () => {
    const path = root(), databasePath = join(path, "environment.sqlite")
    const seed = await EnvironmentMemoryEngine.open({ databasePath, namespace: "synthetic-project" })
    try {
      seed.append({ type: "upsert_entity", entity: projectEntity("gateway", "Visible gateway") },
        { expected_revision: 0, idempotency_key: "gateway" })
      seed.append({ type: "upsert_entity", entity: { ...projectEntity("private", "Private gateway"),
        scope: { namespace: "synthetic-project", project: "fixture-project", visibility: "session", owner: "session-a" } } },
        { expected_revision: 1, idempotency_key: "private" })
    } finally { seed.close() }
    const options = { environmentMemory: { mode: "assist", namespace: "synthetic-project", databasePath,
      rootIds: ["gateway", "private"], contextByteBudget: 2048 }, skillEvolution: { enabled: false } }
    const own = await server(host(path), options)
    const foreign = await server(host(path, "other-project"), options)
    try {
      const ownOutput = { system: ["host policy"] }
      await own["experimental.chat.system.transform"]!({ sessionID: "session-a", model: { limit: { context: 8192, output: 1024 } } } as any, ownOutput)
      expect(ownOutput.system.join("\n")).toContain("Private gateway")
      const otherOwner = { system: ["host policy"] }
      await own["experimental.chat.system.transform"]!({ sessionID: "session-b", model: { limit: { context: 8192, output: 1024 } } } as any, otherOwner)
      expect(otherOwner.system.join("\n")).not.toContain("Private gateway")
      const otherProject = { system: ["host policy"] }
      await foreign["experimental.chat.system.transform"]!({ sessionID: "session-a", model: { limit: { context: 8192, output: 1024 } } } as any, otherProject)
      expect(otherProject.system.join("\n")).not.toContain("Visible gateway")
      expect(otherProject.system.join("\n")).not.toContain("Private gateway")
    } finally { await own.dispose?.(); await foreign.dispose?.() }
  })

  test("observe mode reports diagnostics but adds no environment context", async () => {
    const path = root(), databasePath = join(path, "environment.sqlite")
    mkdirSync(join(path, ".opencode"), { recursive: true })
    writeFileSync(join(path, ".opencode", "keep.txt"), "unrelated")
    const hooks = await server(host(path), { environmentMemory: { mode: "observe", namespace: "synthetic-project", databasePath,
      rootIds: ["missing-root"] }, skillEvolution: { enabled: false } })
    try {
      const output = { system: ["host policy"] }
      await hooks["experimental.chat.system.transform"]!({ sessionID: "session-a", model: { limit: { context: 8192, output: 1024 } } } as any, output)
      expect(output.system).toEqual(["host policy"])
      const status = await hooks.tool!.alg_context_status!.execute({}, toolContext(path)) as any
      expect(JSON.parse(status.output).environment_memory).toMatchObject({ mode: "observe", available: true, missing: 1 })
    } finally { await hooks.dispose?.() }
  })
})

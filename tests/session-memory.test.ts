import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, readdirSync } from "node:fs"
import { join } from "node:path"
import fc from "fast-check"
import { tempProject, removeProject } from "./helpers.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { MemoryStore, hashObject, hashText } from "../src/session-memory/store.ts"
import { MemoryOptionsSchema, type Operation } from "../src/session-memory/schemas.ts"
import { contextBudget, estimateTokens } from "../src/session-memory/context.ts"
import { localOrigin, publishEnvironment } from "../src/session-memory/environment.ts"
import { preflight } from "../src/session-memory/preflight.ts"
import { retrieve } from "../src/session-memory/retrieval.ts"
import { importEvidence } from "../src/session-memory/experience-adapter.ts"
import { appendExperience } from "../src/experience.ts"
import { runMemoryCommand } from "../scripts/memory-cli.ts"

const projects: string[] = []
afterEach(() => { for (const path of projects.splice(0)) removeProject(path) })
function project() { const path = tempProject("alg-memory-test-"); projects.push(path); return path }
function skill(path: string, name = "connect-lake", body = "Use the reviewed route. Never search for credentials.", manifest?: unknown) {
  const dir = join(path, ".opencode", "skills", name)
  mkdirSync(dir, { recursive: true })
  const full = `---\nname: ${name}\ndescription: Procedure ${name}\n---\n${body}\n`
  writeFileSync(join(dir, "SKILL.md"), full)
  if (manifest) writeFileSync(join(dir, "ALG.json"), JSON.stringify(manifest))
  return { dir, full }
}
function runtime(path: string, mode = "assist") { return new SessionMemoryRuntime(path, { mode, fallbackTokens: 4096 }, [".opencode/skills"], []) }
function profile(name = "lake-pc", changes = {}) {
  return { name, origin: "workstation", origin_fingerprint: localOrigin().id, target: "synthetic-api", kind: "api",
    namespace: null, tenant: "test-tenant", principal_ref: "test-reader", protocol: "https", api_version: "v1", client_version: "test",
    endpoint_refs: ["lake-endpoint"], route_refs: ["reviewed-route"], tools: ["alg_execute"], credential_refs: ["credential-provider-ref"],
    scopes: ["read-only"], verified_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 3600000).toISOString(),
    source_ref: hashObject("operator-reviewed-synthetic-profile"), ...changes }
}
function bound(path: string, name = "connect-lake") {
  skill(path, name)
  const memory = runtime(path)
  memory.beginTask("owner", "Diagnose synthetic lake connectivity", ["Read-only operations only"])
  memory.selectEnvironment("owner", publishEnvironment(memory.store, profile()))
  memory.bindSkill("owner", memory.index.search(name).skills[0]!.key)
  return memory
}
function operation(memory: SessionMemoryRuntime): Operation {
  const state = memory.current("owner")
  return { adapter: "synthetic", operation: "connect", resource: "dataset-one", parameters_hash: hashObject({ timeout: 100 }),
    environment: state.environment!, skill: state.skills[0]!.id, purpose: "action" }
}
const expiry = () => new Date(Date.now() + 600000).toISOString()
const budget = { context: 128000, output: 4096, knownInputTokens: 1000 }

describe("durable session memory", () => {
  test("off and read-only status do not initialize storage", () => {
    const path = project(), memory = new SessionMemoryRuntime(path)
    memory.observe([{ info: { sessionID: "owner", role: "user" }, parts: [{ type: "text", text: "continue" }] }])
    expect(memory.status("owner")).toEqual({ mode: "off", initialized: false })
    expect(() => memory.beginTask("owner", "no")).toThrow("disabled")
    expect(existsSync(join(path, ".opencode"))).toBe(false)
    expect(runtime(path).status("owner").initialized).toBe(false)
    expect(existsSync(join(path, ".opencode"))).toBe(false)
  })

  test("exact names do not activate prefix neighbors and pinned restore skips discovery", () => {
    const path = project(); skill(path, "skill-8"); skill(path, "skill-87")
    const memory = runtime(path)
    expect(memory.index.search("Use skill-87").skills.map((entry) => entry.name)).toEqual(["skill-87"])
    memory.beginTask("owner", "skill-87"); memory.bindSkill("owner", memory.index.search("skill-87").skills[0]!.key)
    const restarted = runtime(path)
    restarted.index.refresh = () => { throw new Error("catalog scan must not occur during pinned restoration") }
    expect(restarted.prepare("owner", budget).blocked).toBe(false)
  })

  test("successful current-turn skill tool loads survive generic continue; old and failed loads do not", () => {
    const path = project(); skill(path, "current-skill"); skill(path, "older-skill"); skill(path, "failed-skill")
    const memory = runtime(path)
    const load = (name: string, status: string) => ({ type: "tool", tool: "skill", state: { status, input: { name } } })
    memory.observe([
      { info: { role: "user", sessionID: "owner" }, parts: [{ type: "text", text: "Previous unrelated task" }] },
      { info: { role: "assistant", sessionID: "owner" }, parts: [load("older-skill", "completed")] },
      { info: { role: "user", sessionID: "owner" }, parts: [{ type: "text", text: "continue" }] },
      { info: { role: "assistant", sessionID: "owner" }, parts: [load("current-skill", "completed"), load("failed-skill", "error")] },
    ])
    expect(memory.current("owner").skills.map((entry) => entry.name)).toEqual(["current-skill"])
    expect(runtime(path).prepare("owner", budget).text).toContain("Procedure current-skill")
  })

  test("duplicate skill names require reviewed exact-source binding instead of mixing procedures", () => {
    const path = project()
    skill(path, "duplicate", "Project procedure")
    const other = join(path, "alternate", "duplicate")
    mkdirSync(other, { recursive: true })
    writeFileSync(join(other, "SKILL.md"), "---\nname: duplicate\ndescription: Alternative procedure\n---\nDifferent operating environment\n")
    const memory = new SessionMemoryRuntime(path, { mode: "assist", fallbackTokens: 4096 }, [".opencode/skills", "alternate"], [])
    memory.observe([{ info: { role: "user", sessionID: "owner" }, parts: [{ type: "text", text: "Use duplicate" }] }])
    expect(memory.current("owner").skills).toEqual([])
    expect(memory.current("owner").gaps[0]).toContain("ambiguous")
    const exact = memory.index.search("duplicate").skills.find((entry) => entry.root === ".opencode/skills")!
    memory.bindSkill("owner", exact.key)
    expect(memory.current("owner").gaps).toEqual([])
    expect(memory.prepare("owner", budget).text).toContain("Project procedure")
    expect(memory.prepare("owner", budget).text).not.toContain("Different operating environment")
  })

  test("golden: skill 87/100, verified solution, 20 compactions, restart, continue", () => {
    const path = project()
    let selected = ""
    for (let i = 0; i < 100; i++) { const item = skill(path, `skill-${String(i).padStart(3, "0")}`); if (i === 87) selected = item.full }
    let memory = runtime(path)
    memory.observe([{ info: { id: "u1", sessionID: "owner", role: "user" }, parts: [{ type: "text", text: "Use skill-087" }] }])
    expect(memory.index.search("").total).toBe(100)
    expect(memory.index.search("", 0, 64).next).toBe(64)
    memory.selectEnvironment("owner", publishEnvironment(memory.store, profile()))
    memory.bindSkill("owner", memory.index.search("skill-087").skills[0]!.key)
    const op = operation(memory), receipt = hashObject("typed successful connection receipt")
    memory.recordAttempt("owner", op, "success", receipt, expiry())
    const action = appendExperience(path, { kind: "action", source: { type: "fixture", id: "connect", sha256: receipt }, observed_at: new Date().toISOString(),
      retention: "operational", status: "observed", summary: "Connection attempt", skill_version: op.skill, group: "task-one", relations: [], metrics: {} })
    const checked = appendExperience(path, { kind: "outcome", source: { type: "fixture-verification", id: "connect-check", sha256: receipt }, observed_at: new Date().toISOString(),
      retention: "operational", status: "success", summary: "Synthetic acceptance verified", skill_version: op.skill, group: "task-one", relations: [{ kind: "tests", id: action.id }], metrics: {} })
    const reference = importEvidence(memory.store, "owner", checked.id)
    const until = expiry()
    const resolution = memory.resolve("owner", op, reference, "Continue dataset quality checks; connection setup is complete.", until)
    expect(memory.resolve("owner", op, reference, "Continue dataset quality checks; connection setup is complete.", until)).toBe(resolution)
    memory.update("owner", (value) => ({ ...value, completed: ["connection-check"] }))
    for (let i = 0; i < 20; i++) memory.compact("owner")
    memory = runtime(path)
    memory.observe([{ info: { id: "u2", sessionID: "owner", role: "user" }, parts: [{ type: "text", text: "continue" }] }])
    const pack = memory.prepare("owner", budget)
    expect(pack.blocked).toBe(false)
    expect(pack.text).toContain(selected)
    expect(pack.text).not.toContain("Procedure skill-086")
    expect(pack.text).toContain("connection setup is complete")
    expect(memory.current("owner").skills).toHaveLength(1)
    expect(memory.current("owner").generation).toBeGreaterThanOrEqual(20)
    expect(preflight(memory.store, memory.current("owner"), op).allowed).toBe(false)
    expect(memory.status("owner").coverage?.host_prompt_delivery).toBe("NOT_ATTESTED")
    expect(existsSync(join(path, ".opencode", "skill-evolution"))).toBe(false)
  }, 60000)

  test("declared dependencies stay whole; drift and review are explicit", () => {
    const path = project(), dependency = "Check the exact host. Never use a production credential."
    const item = skill(path, "connect-lake", "Follow the complete prerequisite below.", { schema_version: 1, requires: [{ path: "route.md", sha256: hashText(dependency) }] })
    writeFileSync(join(item.dir, "route.md"), dependency)
    const memory = runtime(path), key = memory.index.search("connect-lake").skills[0]!.key
    memory.beginTask("owner", "connect-lake"); memory.bindSkill("owner", key)
    expect(memory.prepare("owner", budget).text).toContain(dependency)
    writeFileSync(join(item.dir, "route.md"), "Changed route; review required.")
    expect(memory.prepare("owner", budget).blocked).toBe(true)
    expect(() => memory.bindSkill("owner", key, true)).toThrow("dependency drift")
    writeFileSync(join(item.dir, "ALG.json"), JSON.stringify({ schema_version: 1, requires: [{ path: "route.md", sha256: hashText("Changed route; review required.") }] }))
    expect(() => memory.bindSkill("owner", key)).toThrow("reviewed repin")
    memory.bindSkill("owner", key, true)
    expect(runtime(path).prepare("owner", budget).text).toContain("Changed route; review required.")
    memory.store.revoke(memory.current("owner").skills[0]!.id)
    expect(memory.prepare("owner", budget).blocked).toBe(true)
  })

  test("environment revision, expiry and origin invalidate old procedures", () => {
    const path = project(), memory = bound(path)
    const other = publishEnvironment(memory.store, profile("lake-pod", { origin: "pod", origin_fingerprint: hashObject("other-pod") }))
    expect(() => memory.selectEnvironment("owner", other)).toThrow("origin changed")
    const stale = publishEnvironment(memory.store, profile("expired", { verified_at: new Date(Date.now() - 3000).toISOString(), expires_at: new Date(Date.now() - 1000).toISOString() }))
    expect(() => memory.selectEnvironment("owner", stale)).toThrow("stale")
    const second = publishEnvironment(memory.store, profile("lake-other-tenant", { tenant: "another-tenant", principal_ref: "different-reader" }))
    memory.selectEnvironment("owner", second)
    expect(memory.current("owner").skills).toEqual([])
    expect(memory.current("owner").pins).toEqual([])
    skill(path, "pc-only", "This procedure only applies to lake-pc.", { schema_version: 1, environments: ["lake-pc"] })
    expect(() => memory.bindSkill("owner", memory.index.search("pc-only").skills[0]!.key)).toThrow("matching reviewed")
  })

  test("unchanged failures block; polling/verification and one exact reviewed retry work", async () => {
    const memory = bound(project()), op = operation(memory)
    let executions = 0
    const execute = async () => { executions++; return "synthetic result" }
    const classify = () => ({ outcome: "failure" as const, receipt: hashObject("adapter-safe receipt") })
    await memory.guarded("owner", op, execute, classify)
    await expect(memory.guarded("owner", op, execute, classify)).rejects.toThrow("unchanged failed")
    expect(executions).toBe(1)
    expect(preflight(memory.store, memory.current("owner"), { ...op, purpose: "poll" }).allowed).toBe(true)
    expect(preflight(memory.store, memory.current("owner"), { ...op, purpose: "verify" }).allowed).toBe(true)
    expect(preflight(memory.store, memory.current("owner"), { ...op, purpose: "transient-retry" }).allowed).toBe(false)
    const retry = memory.allowRetry("owner", op, "The synthetic transient condition was removed", expiry())
    expect(preflight(memory.store, memory.current("owner"), { ...op, resource: "other-dataset", purpose: "transient-retry" }).allowed).toBe(false)
    await memory.guarded("owner", op, execute, classify)
    expect(memory.current("owner").used_retries).toContain(retry)
    await expect(memory.guarded("owner", op, execute, classify)).rejects.toThrow("unchanged failed")
    expect(executions).toBe(2)
    expect(preflight(memory.store, memory.current("owner"), { ...op, parameters_hash: hashObject("different approved nonsecret parameters") }).allowed).toBe(true)
  })

  test("observe mode never changes action results or injects context", async () => {
    const path = project(), original = bound(path), op = operation(original)
    original.recordAttempt("owner", op, "failure", hashObject("failure"), expiry())
    const memory = runtime(path, "observe")
    expect(memory.prepare("owner", budget).text).toBe("")
    expect(memory.store.contextReceipt("owner")?.state).toBe("observed")
    expect(await memory.guarded("owner", op, async () => 12, () => ({ outcome: "success", receipt: hashObject("observed-success") }))).toBe(12)
  })

  test("failed adapter calls cannot persist exception secrets", async () => {
    const memory = bound(project()), op = operation(memory)
    await expect(memory.guarded("owner", op, async () => { throw new Error("password=synthetic-secret") }, () => ({ outcome: "success", receipt: hashObject("unused") }))).rejects.toThrow()
    const id = memory.current("owner").pins.at(-1)!
    expect(JSON.stringify(memory.store.node(id, "owner"))).not.toContain("synthetic-secret")
    expect(memory.store.node(id, "owner").kind).toBe("attempt")
  })

  test("mandatory multilingual instructions are never clipped; budget shrinks safely", () => {
    const path = project(), full = skill(path, "large", "慎重に検証する。".repeat(1500)).full
    const memory = runtime(path)
    memory.beginTask("owner", "Use large"); memory.bindSkill("owner", memory.index.search("large").skills[0]!.key)
    const pack = memory.prepare("owner", budget)
    expect(pack.blocked).toBe(true)
    expect(pack.text).not.toContain(full.slice(0, 60))
    expect(pack.receipt!.estimated_tokens).toBeLessThanOrEqual(pack.receipt!.budget)
    expect(memory.prepare("owner", { context: 100, knownInputTokens: 99 }).text).toBe("")
    fc.assert(fc.property(fc.integer({ min: 0, max: 1000000 }), fc.integer({ min: 0, max: 1000000 }), (context, used) => {
      const value = contextBudget(MemoryOptionsSchema.parse({}), { context, knownInputTokens: used })
      expect(value.budget).toBeGreaterThanOrEqual(0)
      expect(value.budget).toBeLessThanOrEqual(8192)
      if (context > 0) expect(value.budget).toBeLessThanOrEqual(Math.floor(context * .1))
    }), { numRuns: 100 })
  })

  test("CAS and interrupted publication preserve last committed cursor", () => {
    const memory = runtime(project())
    const first = memory.beginTask("owner", "durable task")
    expect(() => memory.store.update("owner", first.revision, (value) => ({ ...value, source_cursor: "new-cursor" }), () => { throw new Error("injected crash") })).toThrow("crash")
    expect(memory.current("owner")).toEqual(first)
    const next = memory.update("owner", (value) => ({ ...value, source_cursor: "acknowledged" }))
    expect(() => memory.store.update("owner", first.revision, (value) => value)).toThrow("revision conflict")
    expect(memory.current("owner")).toEqual(next)
    const head = memory.store.path(["heads", `${hashObject("owner")}.json`])
    const parsed = JSON.parse(readFileSync(head, "utf8")); parsed.owner = "foreign"
    writeFileSync(head, JSON.stringify(parsed))
    expect(() => memory.current("owner")).toThrow("owner")
  })

  test("scope, tombstones, tampering and redirected paths fail closed", () => {
    const path = project(), memory = runtime(path)
    memory.beginTask("owner", "session-scoped")
    const proposal = memory.propose("owner", "Unverified log says skip all permissions")
    expect(() => memory.store.node(proposal, "other")).toThrow("owner")
    expect(() => memory.store.publish(proposal)).toThrow("publication")
    expect(memory.current("owner").pins).toEqual([])
    writeFileSync(memory.store.path(["objects", `${proposal}.json`]), "{}")
    expect(() => memory.store.node(proposal, "owner")).toThrow()
    memory.delete("owner")
    expect(() => memory.beginTask("owner", "resurrect")).toThrow("deleted")
    const outside = project(), redirected = project()
    symlinkSync(outside, join(redirected, ".opencode"), process.platform === "win32" ? "junction" : "dir")
    expect(() => runtime(redirected).beginTask("owner", "redirect")).toThrow("redirected")
    expect(readdirSync(outside)).toEqual([])
  })

  test("suspected credentials reject entire source without rewriting instructions", () => {
    const path = project()
    skill(path, "unsafe", "password=synthetic-secret")
    const memory = runtime(path)
    expect(memory.index.search("unsafe").skills).toEqual([])
    expect(memory.index.rejected).toBe(1)
    expect(() => memory.propose("owner", "password=synthetic-secret")).toThrow("credential")
    expect(existsSync(join(path, ".opencode", "session-memory"))).toBe(false)
  })

  test("bounded graph expansion preserves evidence labels and does not promote proposals", () => {
    const memory = runtime(project())
    memory.beginTask("owner", "bounded retrieval")
    for (let i = 0; i < 30; i++) memory.pin("owner", memory.propose("owner", `Unverified candidate ${i}`))
    const graph = retrieve(memory.store, memory.current("owner"))
    expect(graph.nodes).toHaveLength(24)
    expect(graph.omitted).toBe(6)
    const pack = memory.prepare("owner", budget)
    expect(estimateTokens(pack.text)).toBeLessThanOrEqual(pack.receipt!.budget)
    expect(pack.text).toContain("UNTRUSTED MEMORY EVIDENCE")
    expect(pack.receipt!.omitted).toBeGreaterThan(0)
  })

  test("scoped worker delegation excludes private evidence; checker inherits no procedures", () => {
    const memory = bound(project())
    memory.pin("owner", memory.propose("owner", "Private worker reasoning"))
    memory.delegate("owner", "worker", "worker")
    memory.delegate("owner", "checker", "checker")
    expect(memory.current("worker").skills).toHaveLength(1)
    expect(memory.current("worker").pins).toEqual([])
    expect(memory.current("checker").skills).toEqual([])
    expect(memory.prepare("worker", budget).text).not.toContain("Private worker reasoning")
    expect(memory.current("worker").delegation?.parent_owner).toBe("owner")
    memory.beginTask("owner", "Unrelated task")
    expect(memory.current("owner").skills).toEqual([])
  })

  test("operator CLI uses strict reviewed requests and never modifies legacy state", () => {
    const path = project(), request = join(path, "task.json")
    writeFileSync(request, JSON.stringify({ goal: "CLI task", constraints: ["synthetic only"] }))
    expect((runMemoryCommand(["task", path, "owner", request]) as any).goal).toBe("CLI task")
    writeFileSync(request, JSON.stringify({ goal: "CLI task", constraints: [], approve: true }))
    expect(() => runMemoryCommand(["task", path, "owner", request])).toThrow()
    expect(() => runMemoryCommand(["task", path, "owner", "relative.json"])).toThrow("absolute")
    expect(existsSync(join(path, ".opencode", "skill-evolution"))).toBe(false)
  })
})

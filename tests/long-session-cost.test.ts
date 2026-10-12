import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { executeRun } from "../src/executor.ts"
import { awaitLock, isLockContention } from "../src/filesystem-mutex.ts"
import { runNodeSession } from "../src/sessions.ts"
import { loadSkillCatalog, SkillGuidance } from "../src/skill-catalog.ts"
import { createSkillEvolutionRuntime } from "../src/skill-evolution-runtime.ts"
import { SkillEvolutionOptionsSchema } from "../src/skill-evolution-schemas.ts"
import { loadSessionRecovery, loadSkillLedger } from "../src/skill-evolution-store.ts"
import { createRun } from "../src/store.ts"
import type { GraphDef } from "../src/types.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

const dirs: string[] = []
const project = (label: string) => { const path = tempProject(label); dirs.push(path); return path }
afterEach(() => { dirs.splice(0).forEach(removeProject) })

const options = SkillEvolutionOptionsSchema.parse({ enabled: true, allowBuiltinToolMap: true, mode: "every-turn" })

function writeSkill(path: string, name: string, description: string, body: string): string {
  const directory = join(path, ".opencode", "skills", name)
  mkdirSync(directory, { recursive: true })
  const file = join(directory, "SKILL.md")
  writeFileSync(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`)
  return file
}

/** The project's skill-evolution store lock, as another live process on this machine would hold it. */
function holdStoreLock(path: string): string {
  const directory = join(realpathSync.native(path), ".opencode", "skill-evolution")
  mkdirSync(directory, { recursive: true })
  const lock = join(directory, "mutation.lock")
  const now = Date.now()
  writeFileSync(lock, `${JSON.stringify({ version: 1, owner: "other-process", token: randomUUID(), pid: process.pid, host: hostname(),
    resource: lock, acquired_at: new Date(now).toISOString(), expires_at: new Date(now + 30_000).toISOString() }, null, 2)}\n`, "utf8")
  return lock
}

describe("the cost of a model call does not grow with the session", () => {
  const turn = (index: number) => [
    { info: { id: `u${index}`, sessionID: "owner", role: "user", time: { created: index * 10 + 1 } }, parts: [{ type: "text", text: `Question ${index}` }] },
    { info: { id: `a${index}`, parentID: `u${index}`, sessionID: "owner", role: "assistant", finish: "stop", time: { created: index * 10 + 2, completed: index * 10 + 3 } },
      parts: [{ type: "text", text: `Answer ${index}` }] },
  ]
  function fixture(path: string) {
    let serial = 0
    const sdk: any = { app: { log: async () => ({ data: true }) }, session: {
      get: async ({ path: target }: any) => ({ data: { id: target.id, projectID: "p", directory: path, title: "normal" } }),
      messages: async () => ({ data: [] }),
      create: async () => ({ data: { id: `child-${++serial}` } }),
      prompt: async (request: any) => {
        const prompt = request.body.parts[0].text
        const evidence = JSON.parse(prompt.split("UNTRUSTED EVIDENCE JSON:\n")[1].split("\n\nReturn one strict JSON")[0])
        return { data: { parts: [{ type: "text", text: JSON.stringify({ decision: "no_change", rationale: "Already covered", confidence: "high", triggers: evidence.trigger_labels, provenance: evidence.provenance }) }] } }
      },
      abort: async () => ({ data: true }),
      status: async () => ({ data: {} }),
    } }
    return { client: sdk, project: { id: "p" }, directory: path, worktree: path } as any
  }
  async function settled(runtime: ReturnType<typeof createSkillEvolutionRuntime>) {
    for (let i = 0; i < 400; i++) {
      await Bun.sleep(10)
      const status = runtime.status()
      if (!status.queue.active && !status.queue.in_memory) return
    }
    throw new Error("queue did not settle")
  }

  test("turns already captured are not registered again on later model calls", async () => {
    const path = project("alg-cost-capture-")
    const runtime = createSkillEvolutionRuntime(fixture(path), { options })
    try {
      const window = [...turn(1), ...turn(2), ...turn(3)]
      await runtime.captureChatMessages(window)
      await settled(runtime)
      expect(loadSkillLedger(path).records.map((record) => record.message_id).sort()).toEqual(["a1", "a2", "a3"])

      // Another process now holds the store lock. A window of known turns needs no lock at all.
      const lock = holdStoreLock(path)
      const started = performance.now()
      await runtime.captureChatMessages(window)
      expect(performance.now() - started).toBeLessThan(400)

      // A new turn does need the lock: it is waited for on a timer and then registered once.
      setTimeout(() => rmSync(lock), 120)
      await runtime.captureChatMessages([...window, ...turn(4)])
      await settled(runtime)
      expect(loadSkillLedger(path).records.map((record) => record.message_id).sort()).toEqual(["a1", "a2", "a3", "a4"])
    } finally { await runtime.dispose() }
  }, 30_000)
})

describe("the skill catalog is scanned once and still never stale", () => {
  test("an edited or added SKILL.md is seen on the very next read", () => {
    const path = project("alg-cost-catalog-")
    const file = writeSkill(path, "alpha-notes", "Use when writing alpha notes.", "First version.")
    writeSkill(path, "beta-notes", "Use when writing beta notes.", "Only version.")
    const first = loadSkillCatalog(path, options)
    expect(first.skills.map((skill) => skill.name)).toEqual(["alpha-notes", "beta-notes"])

    writeFileSync(file, readFileSync(file, "utf8").replace("First version.", "Second version, noticeably longer."))
    const edited = loadSkillCatalog(path, options)
    expect(edited.skills[0]!.sha256).not.toBe(first.skills[0]!.sha256)
    expect(edited.skills[0]!.readContent!()).toContain("Second version")

    writeSkill(path, "gamma-notes", "Use when writing gamma notes.", "New skill.")
    expect(loadSkillCatalog(path, options).skills.map((skill) => skill.name)).toEqual(["alpha-notes", "beta-notes", "gamma-notes"])
  })

  test("an unchanged tree is not read again, and a body is always checked against its catalog hash", () => {
    const path = project("alg-cost-catalog-reuse-")
    const file = writeSkill(path, "alpha-notes", "Use when writing alpha notes.", "Version AAAA.")
    const fixed = new Date("2026-01-01T00:00:00.000Z")
    utimesSync(file, fixed, fixed)
    const first = loadSkillCatalog(path, options)
    // Same size, same modification time, different bytes: indistinguishable without reading the file.
    writeFileSync(file, readFileSync(file, "utf8").replace("Version AAAA.", "Version BBBB."))
    utimesSync(file, fixed, fixed)
    const second = loadSkillCatalog(path, options)
    expect(second.skills[0]!.sha256).toBe(first.skills[0]!.sha256)
    expect(() => second.skills[0]!.readContent!()).toThrow(/skill changed during catalog selection/)
  })

  test("recording nothing new takes no lock, and a held lock is passed on to be waited for", async () => {
    const path = project("alg-cost-guidance-")
    writeSkill(path, "alpha-notes", "Use when writing alpha notes with alg_duckdb_query.", "Always call `alg_duckdb_query`.")
    const guidance = new SkillGuidance(path, options)
    guidance.observeChatMessages([
      { info: { id: "u1", sessionID: "owner", role: "user" }, parts: [{ type: "text", text: "Please follow alpha-notes for this query." }] },
      { info: { id: "a1", sessionID: "owner", role: "assistant" }, parts: [{ type: "tool", tool: "alg_duckdb_query", state: { status: "completed", input: {} } }] },
    ])

    // The first call has a skill reference to record, which needs the store lock.
    const lock = holdStoreLock(path)
    let refused: unknown
    try { guidance.systemContext("owner") } catch (error) { refused = error }
    expect(isLockContention(refused)).toBe(true)
    setTimeout(() => rmSync(lock), 80)
    const text = await awaitLock(() => guidance.systemContext("owner"), 2_000)
    expect(text).toContain("### Active skill: alpha-notes (complete body)")
    expect(loadSessionRecovery(path, "owner")?.skills.map((skill) => skill.name)).toEqual(["alpha-notes"])

    // Every later call for the same skill has nothing to record and never touches the lock.
    const written = statSync(join(realpathSync.native(path), ".opencode", "skill-evolution", "session-recovery")).mtimeMs
    holdStoreLock(path)
    for (let call = 0; call < 3; call++) expect(guidance.systemContext("owner")).toContain("### Active skill: alpha-notes (complete body)")
    expect(statSync(join(realpathSync.native(path), ".opencode", "skill-evolution", "session-recovery")).mtimeMs).toBe(written)
  })
})

describe("a worker whose model call failed says why", () => {
  const reply = (data: unknown) => ({ session: {
    create: async () => ({ data: { id: "child" }, error: undefined }),
    prompt: async () => ({ data, error: undefined }),
  } }) as never

  test("the provider error replaces the empty-response diagnosis", async () => {
    const path = project("alg-cost-provider-error-")
    const result = await runNodeSession({
      client: reply({ info: { providerID: "xai", modelID: "grok-4.6", error: { name: "UnknownError", data: { message: "xAI token refresh failed (400): invalid_grant" } } }, parts: [] }),
      parentSessionId: "parent", agent: "implementer", title: "run/work/a1", userPrompt: "work", directory: path,
    })
    expect(result.parsed).toBeNull()
    // The sanitizer may redact the provider's wording; the model that was called is always named.
    expect(result.error).toContain("child model call failed (xai/grok-4.6)")
    expect(result.error).toContain("UnknownError")
    expect(result.response_diagnostic).toContain("error_category=UnknownError")

    const graph: GraphDef = { name: "provider-error", max_global_attempts: 1, max_concurrency: 1, nodes: [{ id: "work", agent: "implementer", depends_on: [] }] }
    const run = createRun({ goal: "work", criteria: [], graph, projectDirectory: path, ownerSessionId: "session-owner" })
    const failed = await executeRun(run, { ...executeContext(path), sessionRunner: async () => result })
    expect(failed.nodes.work!.attempts.at(-1)).toMatchObject({ outcome: "sdk_error" })
    expect(failed.nodes.work!.last_failures.join(" ")).toContain("child model call failed (xai/grok-4.6)")
  })

  test("a usable answer is kept even when the host also recorded an error", async () => {
    const path = project("alg-cost-provider-partial-")
    const answer = JSON.stringify({ summary: ["done"], files_touched: [], commands_run: [], risks: [], done: true })
    const result = await runNodeSession({
      client: reply({ info: { error: { name: "MessageOutputLengthError", data: {} } }, parts: [{ type: "text", text: answer }] }),
      parentSessionId: "parent", agent: "implementer", title: "run/work/a1", userPrompt: "work", directory: path,
    })
    expect(result.parsed).toMatchObject({ done: true })
    expect(result.error).toBeUndefined()
    expect(result.response_diagnostic).toBeUndefined()
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import server from "../src/index.ts"
import { formatCompactionContext, MAX_COMPACTION_CONTEXT_BYTES } from "../src/compaction.ts"
import { ContextBudgetOptionsSchema, estimateUsedTokens, planContext, SessionWindows } from "../src/context-budget.ts"
import { contextBudget } from "../src/session-memory/context.ts"
import { MemoryOptionsSchema } from "../src/session-memory/schemas.ts"
import { formatSkillSystemContext, loadSkillCatalog } from "../src/skill-catalog.ts"
import { SkillEvolutionOptionsSchema } from "../src/skill-evolution-schemas.ts"
import { createRun } from "../src/store.ts"
import type { GraphDef, RunState } from "../src/types.ts"
import { removeProject, tempProject } from "./helpers.ts"

const dirs: string[] = []
const project = (label: string) => { const path = tempProject(label); dirs.push(path); return path }
afterEach(() => { dirs.splice(0).forEach(removeProject) })

const defaults = ContextBudgetOptionsSchema.parse({})
const bytes = (text: string) => Buffer.byteLength(text, "utf8")

function largeRun(path: string, owner = "owner"): RunState {
  const graph: GraphDef = { name: "budget", max_global_attempts: 40, max_concurrency: 4,
    nodes: Array.from({ length: 40 }, (_, index) => ({ id: `node-${index}`, agent: "implementer" as const, depends_on: index ? [`node-${index - 1}`] : [] })) }
  return createRun({ goal: "Migrate the reporting service. ".repeat(120).trim(), criteria: Array.from({ length: 50 }, (_, index) => `Criterion ${index}: ${"detail ".repeat(60).trim()}`),
    graph, projectDirectory: path, ownerSessionId: owner, runId: "budget-run" })
}

describe("context plan", () => {
  test("an unknown window keeps every fixed limit", () => {
    const plan = planContext(defaults, {}, "call")
    expect(plan.dynamic).toBe(false)
    expect(plan.totalBytes).toBeUndefined()
    expect(plan.allow("run")).toBeUndefined()
    expect(plan.describe()).toMatchObject({ dynamic: false, limited_by: "fixed" })
  })

  test("the allowance is a share of the window, whatever its size", () => {
    const total = (context: number) => planContext(defaults, { context }, "call").totalBytes
    // 5% of the window, at three bytes a token.
    expect(total(32_000)).toBe(4_800)
    expect(total(200_000)).toBe(30_000)
    expect(total(1_000_000)).toBe(150_000)
    expect(planContext(ContextBudgetOptionsSchema.parse({ perCall: 0.1 }), { context: 200_000 }, "call").totalBytes).toBe(60_000)
    expect(planContext(ContextBudgetOptionsSchema.parse({ compaction: 0.02 }), { context: 200_000 }, "compaction").totalBytes).toBe(12_000)
  })

  test("it shrinks as the window fills, down to a floor for the essentials", () => {
    const window = { context: 200_000, output: 8_000 }
    expect(planContext(defaults, { ...window, usedTokens: 20_000 }, "call").describe()).toMatchObject({ total_bytes: 30_000, limited_by: "share" })
    // 4,000 tokens are free; half of that, at three bytes a token.
    expect(planContext(defaults, { ...window, usedTokens: 188_000 }, "call").describe()).toMatchObject({ total_bytes: 6_000, limited_by: "available", available_tokens: 4_000 })
    expect(planContext(defaults, { ...window, usedTokens: 195_000 }, "call").describe()).toMatchObject({ total_bytes: defaults.floorBytes, limited_by: "floor" })
  })

  test("parts split the allowance by weight, leave out what is off, and pass on what they do not use", () => {
    const all = planContext(defaults, { context: 200_000 }, "call")
    expect([all.allow("run"), all.allow("skills"), all.allow("memory"), all.allow("environment")]).toEqual([6_000, 10_500, 10_500, 3_000])

    // Memory and environment switched off: their share goes to the two parts in use.
    const plan = planContext(defaults, { context: 200_000 }, "call", ["run", "skills"])
    expect(plan.allow("memory")).toBeUndefined()
    expect(plan.allow("run")).toBe(10_909)
    expect(plan.allow("skills")).toBe(19_090)
    // The run summary needed little, so the skills get the rest.
    plan.spend("run", 909)
    expect(plan.allow("skills")).toBe(29_090)
    plan.spend("skills", 20_000)
    expect(plan.allow("skills")).toBe(9_090)
    expect(plan.spentBytes()).toBe(20_909)

    // A part that had to exceed its share is paid for by the parts after it.
    const tight = planContext(defaults, { context: 200_000 }, "call", ["run", "skills"])
    tight.spend("run", 12_909)
    expect(tight.allow("skills")).toBe(17_090)
  })
})

describe("how full the window is", () => {
  const assistant = (tokens: object, extra: object = {}) => ({ info: { role: "assistant", tokens, ...extra }, parts: [{ type: "text", text: "reply" }] })
  const user = (text: string) => ({ info: { role: "user" }, parts: [{ type: "text", text }] })

  test("uses the host's own measurement and estimates only what came after it", () => {
    expect(estimateUsedTokens([], 3)).toBeUndefined()
    const tail = user("x".repeat(3_000))
    const tailTokens = Math.ceil(bytes(JSON.stringify(tail.parts)) / 3)
    expect(estimateUsedTokens([user("first"), assistant({ input: 40_000, output: 500, cache: { read: 9_000, write: 1_000 } }), tail], 3)).toBe(50_500 + tailTokens)
    // With no measured reply yet, everything is estimated from its length.
    expect(estimateUsedTokens([tail], 3)).toBe(tailTokens)
  })

  test("a compaction summary counts for its own size, not for the conversation it replaced", () => {
    expect(estimateUsedTokens([assistant({ input: 180_000, output: 1_200 }, { summary: true })], 3)).toBe(1_200)
  })

  test("what ALG added last time is not counted against it again", () => {
    const windows = new SessionWindows(defaults)
    windows.observeModel("s", { context: 200_000, output: 8_000 })
    windows.observeMessages("s", [assistant({ input: 100_000, output: 0 })])
    const first = windows.plan("s", "call", ["run", "skills"])
    first.spend("skills", 30_000)
    windows.record("s", first)
    expect(windows.window("s")).toEqual({ context: 200_000, output: 8_000, usedTokens: 90_000 })
    expect(windows.last("s")).toMatchObject({ dynamic: true, total_bytes: 30_000 })
    windows.forget("s")
    expect(windows.window("s")).toEqual({})
  })
})

describe("what each part does with its allowance", () => {
  test("the run summary keeps what identifies and continues the run at any size", () => {
    const run = largeRun(project("alg-budget-run-"))
    const legacy = formatCompactionContext(run)
    expect(bytes(legacy)).toBeLessThanOrEqual(MAX_COMPACTION_CONTEXT_BYTES)
    for (const allowance of [300, 1_200, 4_000, 12_000, 60_000]) {
      const summary = formatCompactionContext(run, allowance)
      expect(bytes(summary)).toBeLessThanOrEqual(allowance)
      if (allowance >= 600) {
        expect(summary).toContain("- run_id: budget-run")
        expect(summary).toContain("- status: planning")
        expect(summary).toContain("alg_resume")
      }
    }
    // More room shows more: every criterion and node, where the fixed summary stops at 20 and 32.
    const roomy = formatCompactionContext(run, 60_000)
    expect(roomy).toContain("Criterion 49:")
    expect(roomy).toContain("- node-39 ")
    expect(legacy).not.toContain("Criterion 49:")
    const tight = formatCompactionContext(run, 1_200)
    expect(tight).toContain("- criteria: 50 not shown")
    expect(tight).toContain("more nodes not shown")
  })

  test("a skill body is included whole when it fits the allowance and never clipped", () => {
    const path = project("alg-budget-skills-")
    const directory = join(path, ".opencode", "skills", "long-procedure")
    mkdirSync(directory, { recursive: true })
    const body = `---\nname: long-procedure\ndescription: Use when following the long procedure.\n---\n\n${"Step: do the thing carefully.\n".repeat(700)}`
    writeFileSync(join(directory, "SKILL.md"), body)
    const catalog = loadSkillCatalog(path, SkillEvolutionOptionsSchema.parse({ enabled: true }))
    const hint = { userText: "please follow long-procedure", assistantText: "", tools: [], loadedSkills: [] }
    expect(bytes(body)).toBeGreaterThan(16 * 1024)
    // The fixed limits never include a body over 6 KiB.
    expect(formatSkillSystemContext(catalog, hint)).toContain("requires_full_load")
    const roomy = formatSkillSystemContext(catalog, hint, [], 64 * 1024)
    expect(roomy).toContain("### Active skill: long-procedure (complete body)")
    expect(roomy).toContain(body)
    const tight = formatSkillSystemContext(catalog, hint, [], 4 * 1024)
    expect(tight).toContain("requires_full_load")
    expect(tight).not.toContain("Step: do the thing carefully.")
    expect(bytes(tight)).toBeLessThanOrEqual(4 * 1024)
  })

  test("the memory pack takes the planned allowance instead of its fixed fallback", () => {
    const options = MemoryOptionsSchema.parse({ mode: "assist" })
    expect(contextBudget(options, { context: 200_000, output: 8_000 })).toEqual({ budget: 2_048, known: false })
    expect(contextBudget(options, { context: 200_000, output: 8_000, allowanceBytes: 19_000 })).toEqual({ budget: 19_000, known: true })
  })
})

describe("the hooks size what they add from the model's window", () => {
  function plugin(path: string) {
    return { directory: path, worktree: path, project: { id: "fixture-project" }, client: {
      app: { log: async () => ({ data: true }) }, session: {
        get: async (request: any) => ({ data: { id: request.path.id, projectID: "fixture-project", directory: path, title: "normal" } }),
        messages: async () => ({ data: [] }),
        create: async () => { throw new Error("no model sessions in this fixture") },
        prompt: async () => { throw new Error("no model calls in this fixture") },
      },
    } } as any
  }
  const toolContext = (path: string) => ({ sessionID: "owner", messageID: "m1", agent: "orchestrator", directory: path, worktree: path, abort: new AbortController().signal, ask: async () => {}, metadata: () => {} }) as any
  const added = (system: { system: string[] }) => bytes(system.system.slice(1).join("\n"))

  test("a small window gets a short run summary, a large one gets the detail, and neither exceeds its share", async () => {
    const path = project("alg-budget-hooks-")
    largeRun(path)
    const hooks = await server(plugin(path), { skillEvolution: { enabled: false } })
    try {
      const call = async (context: number) => {
        const system = { system: ["host policy"] }
        await hooks["experimental.chat.system.transform"]!({ sessionID: "owner", model: { limit: { context, output: 4_096 } } } as any, system)
        return system
      }
      const small = await call(32_000)
      expect(small.system.join("\n")).toContain("- run_id: budget-run")
      expect(small.system.join("\n")).toContain("alg_resume")
      expect(added(small)).toBeLessThanOrEqual(4_800)

      const large = await call(1_000_000)
      expect(large.system.join("\n")).toContain("Criterion 49:")
      expect(added(large)).toBeGreaterThan(added(small) * 3)
      expect(added(large)).toBeLessThanOrEqual(150_000)

      const status = JSON.parse((await hooks.tool!.alg_context_status!.execute({}, toolContext(path)) as any).output)
      expect(status.context_budget.options).toMatchObject({ perCall: 0.05, compaction: 0.05 })
      expect(status.context_budget.last_plan).toMatchObject({ dynamic: true, kind: "call", context_tokens: 1_000_000, total_bytes: 150_000, limited_by: "share" })
      expect(status.context_budget.last_plan.parts.run.spent_bytes).toBe(added(large))
    } finally { await hooks.dispose?.() }
  })

  test("a nearly full window leaves only the essentials, and compaction uses the same window", async () => {
    const path = project("alg-budget-hooks-full-")
    largeRun(path)
    const hooks = await server(plugin(path), { skillEvolution: { enabled: false }, contextBudget: { perCall: 0.1, compaction: 0.1 } })
    try {
      const model = { limit: { context: 100_000, output: 4_000 } }
      const firstCall = { system: ["host policy"] }
      await hooks["experimental.chat.system.transform"]!({ sessionID: "owner", model } as any, firstCall)
      expect(added(firstCall)).toBeGreaterThan(8_000)
      expect(added(firstCall)).toBeLessThanOrEqual(30_000)

      // The host now reports a conversation that fills all but 2,000 tokens of the window.
      await hooks["experimental.chat.messages.transform"]!({}, { messages: [
        { info: { id: "u1", role: "user", sessionID: "owner" }, parts: [{ type: "text", text: "continue" }] },
        { info: { id: "a1", role: "assistant", sessionID: "owner", tokens: { input: 94_000 + Math.ceil(added(firstCall) / 3), output: 0 } }, parts: [{ type: "text", text: "ok" }] },
      ] } as any)
      const fullCall = { system: ["host policy"] }
      await hooks["experimental.chat.system.transform"]!({ sessionID: "owner", model } as any, fullCall)
      expect(added(fullCall)).toBeLessThanOrEqual(3_000)
      expect(fullCall.system.join("\n")).toContain("- run_id: budget-run")
      expect(fullCall.system.join("\n")).toContain("alg_resume")

      const compact = { context: ["another plugin context"] }
      await hooks["experimental.session.compacting"]!({ sessionID: "owner" } as any, compact)
      expect(compact.context[0]).toBe("another plugin context")
      expect(bytes(compact.context.slice(1).join("\n"))).toBeLessThanOrEqual(3_000)
      expect(compact.context.join("\n")).toContain("- run_id: budget-run")
    } finally { await hooks.dispose?.() }
  })

  test("a session whose model window is unknown keeps the fixed limits", async () => {
    const path = project("alg-budget-hooks-unknown-")
    const run = largeRun(path)
    const hooks = await server(plugin(path), { skillEvolution: { enabled: false } })
    try {
      const compact = { context: [] as string[] }
      await hooks["experimental.session.compacting"]!({ sessionID: "owner" } as any, compact)
      expect(compact.context.join("\n")).toBe(formatCompactionContext(run))
    } finally { await hooks.dispose?.() }
  })
})

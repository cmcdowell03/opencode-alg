import { afterEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempProject, removeProject } from "./helpers.ts"
import { SkillEvolutionOptionsSchema } from "../src/skill-evolution-schemas.ts"
import { buildSkillEvidence } from "../src/skill-evolution-evidence.ts"
import { loadSkillCatalog } from "../src/skill-catalog.ts"
import { createSkillEvolutionRuntime } from "../src/skill-evolution-runtime.ts"
import { loadSkillLedger, enqueueSkillAudit, persistSkillEvidence, attachSkillEvidenceRef } from "../src/skill-evolution-store.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { createMemoryTools } from "../src/session-memory/tools.ts"
import { isCompletedUserTurn } from "../src/turn-boundary.ts"
import server from "../src/index.ts"

const dirs: string[] = []
const project = () => { const path = tempProject("alg-neutral-"); dirs.push(path); return path }
afterEach(() => { dirs.splice(0).forEach(removeProject) })
const options = SkillEvolutionOptionsSchema.parse({ enabled: true, allowBuiltinToolMap: true, mode: "every-turn" })
const info = (id: string, finish = "stop", parentID = "u") => ({ id, parentID, sessionID: "owner", role: "assistant", finish,
  time: { created: id === "step" ? 2 : 4, completed: id === "step" ? 3 : 5 } })
const transcript = () => [
  { info: { id: "u", sessionID: "owner", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "Use synthetic-revenue; fix the missing paging procedure." }] },
  { info: info("step", "tool-calls"), parts: [
    { type: "tool", tool: "skill", state: { status: "completed", input: { name: "synthetic-revenue" }, output: "loaded" } },
    { type: "tool", tool: "read", state: { status: "completed", input: { file: "orders.json" }, output: "page_size=50; 120 unique records; passed" } },
  ] },
  { info: info("final"), parts: [{ type: "text", text: "Net revenue 220, 5 unique orders. Paging passed; page_size=50. Never retry the rejected route." }] },
]
function skill(path: string, name: string, description = "Unrelated revenue troubleshooting vocabulary", long = false) {
  const dir = join(path, ".opencode/skills", name); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${long ? "Unrelated procedure. ".repeat(150) : "Use the reviewed route."}\n`)
}
function fixture(path: string, messages = transcript()) {
  let serial = 0
  const calls = { creates: 0, prompts: 0, aborts: [] as string[], promptsText: [] as string[] }
  const sdk: any = { app: { log: async () => ({ data: true }) }, session: {
    get: async ({ path: target }: any) => ({ data: { id: target.id, projectID: "p", directory: path, title: "normal" } }),
    messages: async () => ({ data: messages }),
    create: async () => { calls.creates++; return { data: { id: `child-${++serial}` } } },
    prompt: async (request: any) => {
      calls.prompts++; calls.promptsText.push(request.body.parts[0].text)
      const prompt = request.body.parts[0].text
      const evidence = JSON.parse(prompt.split("UNTRUSTED EVIDENCE JSON:\n")[1].split("\n\nReturn one strict JSON")[0])
      return { data: { parts: [{ type: "text", text: JSON.stringify({ decision: "no_change", rationale: "Already covered", confidence: "high", triggers: evidence.trigger_labels, provenance: evidence.provenance }) }] } }
    },
    abort: async ({ path: target }: any) => { calls.aborts.push(target.id); return { data: true } },
    status: async () => ({ data: {} }),
  } }
  return { calls, sdk, plugin: { client: sdk, project: { id: "p" }, directory: path, worktree: path } as any }
}
async function settled(runtime: ReturnType<typeof createSkillEvolutionRuntime>) {
  for (let i = 0; i < 300; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10))
    const status = runtime.status()
    if (!status.queue.active && !status.queue.in_memory) return
  }
  throw new Error("queue did not settle")
}

test("host finish semantics reject intermediate, truncated, failed and summary turns for every provider", () => {
  for (const providerID of ["provider-a", "provider-b", "local"]) {
    for (const finish of ["tool-calls", "length", "unknown", "content-filter"]) expect(isCompletedUserTurn({ ...info("a", finish), providerID })).toBe(false)
    expect(isCompletedUserTurn({ ...info("a"), providerID })).toBe(true)
  }
  expect(isCompletedUserTurn({ ...info("a"), summary: true })).toBe(false)
  expect(isCompletedUserTurn({ ...info("a"), error: {} })).toBe(false)
})
test("whole-turn evidence retains tool steps, final result and loaded skill after rank 32", () => {
  const path = project()
  for (let i = 0; i < 99; i++) skill(path, `catalog-${String(i).padStart(3, "0")}`)
  skill(path, "synthetic-revenue")
  const catalog = loadSkillCatalog(path, options, [])
  expect(catalog.skills).toHaveLength(100)
  expect(catalog.skills.every((entry) => entry.content === "")).toBe(true)
  const evidence = buildSkillEvidence(transcript(), "owner", "final", options, false, 2, catalog)
  expect(evidence.tools.map((tool) => tool.name)).toEqual(["skill", "read"])
  expect(evidence.assistant_text.excerpt).toContain("220")
  expect(evidence.catalog?.skills[0]).toMatchObject({ name: "synthetic-revenue", loaded: true })
  expect(evidence.catalog?.omitted).toBe(84)
  expect(() => buildSkillEvidence(transcript(), "owner", "step", options)).toThrow("completed user turn")
})
test("event plus replay queue one finished-turn audit, with whole evidence", async () => {
  const path = project(), f = fixture(path), runtime = createSkillEvolutionRuntime(f.plugin, { options })
  try {
    runtime.handleEvent({ type: "message.updated", properties: { info: info("step", "tool-calls") } } as any)
    expect(loadSkillLedger(path).records).toHaveLength(0)
    runtime.handleEvent({ type: "message.updated", properties: { info: info("final") } } as any)
    await runtime.captureChatMessages(transcript()); await settled(runtime)
    await runtime.captureChatMessages(transcript()); await settled(runtime)
    expect(f.calls.prompts).toBe(1)
    expect(loadSkillLedger(path).records).toHaveLength(1)
    expect(f.calls.promptsText[0]).toContain("page_size=50")
    runtime.handleEvent({ type: "message.updated", properties: { info: info("post-processed-final") } } as any)
    await settled(runtime)
    expect(loadSkillLedger(path).records).toHaveLength(1)
  } finally { runtime.dispose() }
})
test("weak keyword neighbors never bind or block the complete selected procedure", () => {
  const path = project()
  for (let i = 0; i < 99; i++) skill(path, `catalog-${String(i).padStart(3, "0")}`, undefined, true)
  skill(path, "synthetic-revenue")
  const memory = new SessionMemoryRuntime(path, { mode: "assist", fallbackTokens: 4096 }, undefined, [])
  memory.observe([transcript()[0]!])
  expect(memory.current("owner").skills.map((entry) => entry.name)).toEqual(["synthetic-revenue"])
  expect(memory.prepare("owner").blocked).toBe(false)
})
test("reported values survive lossy compact and restart without acquiring verification authority", () => {
  const path = project(); skill(path, "synthetic-revenue")
  let memory = new SessionMemoryRuntime(path, { mode: "assist", fallbackTokens: 4096 }, undefined, [])
  memory.observe(transcript()); const revision = memory.current("owner").revision
  memory.observe(transcript()); expect(memory.current("owner").revision).toBe(revision)
  for (let i = 0; i < 2; i++) { memory.compact("owner"); memory = new SessionMemoryRuntime(path, { mode: "assist", fallbackTokens: 4096 }, undefined, []) }
  const pack = memory.prepare("owner")
  expect(pack.blocked).toBe(false); expect(pack.text).toContain("220"); expect(pack.text).toContain("5 unique orders")
  expect(pack.text).toContain("unverified-assistant-claim"); expect(memory.current("owner").completed).toEqual([])
  expect(pack.text).toContain("Use it when asked what was previously reported")
  memory.beginTask("owner", "new task"); memory.observe(transcript())
  expect(memory.prepare("owner").text).not.toContain("220")
})
test("completed event captures results even when learning is off and before compaction", async () => {
  const path = project(), f = fixture(path)
  const hooks = await server(f.plugin, { sessionMemory: { mode: "assist", fallbackTokens: 4096 } })
  try {
    await hooks.event!({ event: { type: "message.updated", properties: { info: info("final") } } } as any)
    const memory = new SessionMemoryRuntime(path, { mode: "assist", fallbackTokens: 4096 }, undefined, [])
    expect(memory.current("owner").source_cursor).toBe("final")
    expect(memory.current("owner").pins).toHaveLength(1)
  } finally { await hooks.dispose?.() }
})
test("memory off status is usable and disabled operations advise no retry", async () => {
  const path = project(), memory = new SessionMemoryRuntime(path), tools = createMemoryTools(memory, async () => {})
  const ctx = { worktree: path, directory: path, sessionID: "owner" } as any
  expect(JSON.parse((await tools.alg_context_status.execute({}, ctx) as any).output)).toEqual({ mode: "off", initialized: false })
  const search = await tools.alg_memory_search.execute({ query: "revenue" }, ctx) as any
  expect(search.metadata.error).toBeUndefined(); expect(JSON.parse(search.output).available).toBe(false)
  expect(tools.alg_memory_search.description).toContain("DISABLED")
})
test("real child timeout aborts the owned host session; uncertain cancellation blocks next create", async () => {
  const path = project(), f = fixture(path)
  f.sdk.session.prompt = async () => new Promise(() => {})
  f.sdk.session.abort = async ({ path: target }: any) => { f.calls.aborts.push(target.id); return { data: false } }
  const runtime = createSkillEvolutionRuntime(f.plugin, { options, childCallTimeoutMs: 1000 })
  try {
    const first = await (runtime as any).child("owner", "auditor", "test")
    expect(first.error).toContain("timed out"); expect(first.error).toContain("uncertain")
    expect(f.calls.aborts).toEqual(["child-1"])
    expect(loadSkillLedger(path).audit_children[0]?.lifecycle).toBe("uncertain")
    const second = await (runtime as any).child("owner", "auditor", "test")
    expect(second.error).toContain("retry blocked"); expect(f.calls.creates).toBe(1)
  } finally { runtime.dispose() }
})
test("disposal still sends host abort on an active child", async () => {
  const path = project(), f = fixture(path)
  f.sdk.session.prompt = async () => new Promise(() => {})
  const runtime = createSkillEvolutionRuntime(f.plugin, { options })
  const work = (runtime as any).child("owner", "auditor", "test")
  await new Promise((resolve) => setTimeout(resolve, 100)); runtime.dispose(); await work
  expect(f.calls.aborts).toEqual(["child-1"])
  expect(loadSkillLedger(path).audit_children[0]?.lifecycle).toBe("aborted")
})

test("foreign turns, failed loads and duplicate envelopes cannot contaminate evidence", () => {
  const messages = transcript()
  messages.splice(2, 0, { info: { ...info("foreign", "tool-calls"), sessionID: "other" }, parts: [{ type: "tool", tool: "forbidden", state: { status: "completed" } }] } as any)
  messages.splice(2, 0, { ...messages[1]!, parts: [{ type: "tool", tool: "read", state: { status: "completed", output: "final tool envelope" } }] } as any)
  const evidence = buildSkillEvidence(messages, "owner", "final", options)
  expect(evidence.tools.map((tool) => tool.name)).toEqual(["read"])
  expect(evidence.tools[0]?.result.excerpt).toContain("final tool envelope")
})
test("secret-bearing answers never become retained result claims", () => {
  const path = project(), memory = new SessionMemoryRuntime(path, { mode: "assist" }, undefined, [])
  const messages = transcript(); messages[2]!.parts = [{ type: "text", text: 'api_key="sk-test-123456789012345678901234567890"' }]
  expect(() => memory.observe(messages)).toThrow("credential")
  expect(memory.current("owner").pins).toEqual([])
})

test("legacy immutable per-message evidence requires manual review rather than automatic replay", async () => {
  const path = project(), values = transcript(); delete (values[2]!.info as any).finish
  const f = fixture(path, values)
  const queued = enqueueSkillAudit(path, "owner", "final", options)
  const evidence = buildSkillEvidence(values, "owner", "final", options)
  expect(evidence.turn_scope).toBeUndefined()
  attachSkillEvidenceRef(path, queued.record.key, persistSkillEvidence(path, evidence))
  const runtime = createSkillEvolutionRuntime(f.plugin, { options })
  try {
    await settled(runtime)
    expect(f.calls.creates).toBe(0)
    expect(loadSkillLedger(path).records[0]?.error).toContain("manual review required")
    await runtime.manualAudit({ actorSessionId: "owner", messageId: "final", force: true }); await settled(runtime)
    expect(f.calls.creates).toBe(1)
  } finally { await runtime.dispose() }
})

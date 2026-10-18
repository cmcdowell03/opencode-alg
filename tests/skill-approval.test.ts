import { afterEach, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { tempProject, removeProject } from "./helpers.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { hashText } from "../src/session-memory/store.ts"
import { createMemoryTools } from "../src/session-memory/tools.ts"

const projects: string[] = []
afterEach(() => { for (const path of projects.splice(0)) removeProject(path) })
function fixture() {
  const path = tempProject("alg-approval-"); projects.push(path)
  const dir = join(path, ".opencode/skills/procedure")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), "---\nname: procedure\ndescription: Test procedure\n---\nUse the exact prerequisite.\n")
  writeFileSync(join(dir, "guide.md"), "Complete prerequisite instructions.")
  writeFileSync(join(dir, "ALG.json"), JSON.stringify({ schema_version: 1, requires: [{ path: "guide.md", sha256: hashText("Complete prerequisite instructions.") }] }))
  const legacy = new SessionMemoryRuntime(path, { mode: "assist" }, [".opencode/skills"], [])
  const key = legacy.index.search("procedure").skills[0]!.key
  const policy = { schema_version: 1 as const, revision: "v1", project: legacy.store.projectId, rules: [legacy.index.preview(key)] }
  const runtime = (approvalPolicy: unknown = policy) => new SessionMemoryRuntime(path, { mode: "assist", ...(approvalPolicy ? { approvalPolicy } : {}) }, [".opencode/skills"], [])
  return { path, dir, key, policy, legacy, runtime }
}
const budget = { context: 128000, output: 4096, knownInputTokens: 1000 }

test("public tool authorizes every operation and keeps approval separate from loading", async () => {
  const f = fixture(), memory = f.runtime()
  const context = { sessionID: "owner", messageID: "m", agent: "orchestrator", directory: f.path, worktree: f.path,
    abort: new AbortController().signal, ask: async () => {}, metadata: () => {} }
  let calls = 0
  const tools = createMemoryTools(memory, async () => { calls++ })
  const call = async (action: "preview" | "approve" | "load", id: string) => JSON.parse((await tools.alg_skill.execute({ action, id }, context) as any).output)
  expect((await call("preview", f.key)).state).toBe("candidate")
  const approved = await call("approve", f.key)
  expect(approved.loaded).toBe(false)
  expect(memory.current("owner").skills).toEqual([])
  expect((await call("load", approved.id)).complete_instructions).toContain("Complete prerequisite instructions.")
  expect(calls).toBe(3)
  const denied = createMemoryTools(memory, async () => { throw new Error("denied") })
  for (const action of ["preview", "approve", "load"] as const) {
    expect((await denied.alg_skill.execute({ action, id: f.key }, context) as any).metadata.error).toBe(true)
  }
})

test("preview is read-only; approval is separate from activation and survives restart", () => {
  const f = fixture(), memory = f.runtime()
  expect(memory.store.checkpoint("owner")).toBeNull()
  memory.index.preview(f.key)
  expect(memory.store.checkpoint("owner")).toBeNull()
  const id = memory.approveSkill("owner", f.key)
  expect(memory.current("owner").skills).toEqual([])
  expect(memory.store.node(id, "owner")).toMatchObject({ payload: { approval: { basis: "policy-approved", revision: "v1" } } })
  memory.loadSkill("owner", id)
  expect(f.runtime().prepare("owner", budget).text).toContain("Complete prerequisite instructions.")
  expect(memory.status("owner").coverage?.approval_boundary).toBe("APPLICATION_POLICY")
})
test("approval fails without policy and for foreign project, scope, or revision", () => {
  const f = fixture()
  expect(() => f.legacy.approveSkill("owner", f.key)).toThrow("outside")
  for (const policy of [ { ...f.policy, project: "a".repeat(64) }, { ...f.policy, rules: [] },
    { ...f.policy, rules: [{ ...f.policy.rules[0]!, operations: ["write"] }] },
    { ...f.policy, rules: [{ ...f.policy.rules[0]!, closure: "a".repeat(64) }] } ]) {
    expect(() => f.runtime(policy).approveSkill("owner", f.key)).toThrow("outside")
  }
})
test("policy removal or revision change cannot downgrade an approved binding", () => {
  const f = fixture(), memory = f.runtime(), id = memory.approveSkill("owner", f.key)
  memory.loadSkill("owner", id)
  for (const changed of [f.runtime(null), f.runtime({ ...f.policy, revision: "v2" })]) {
    expect(() => changed.loadSkill("owner", id)).toThrow()
    expect(changed.prepare("owner", budget).text).not.toContain("Complete prerequisite instructions.")
  }
})
test("legacy bindings are not approvals; source drift and revocation fail closed", () => {
  const f = fixture()
  f.legacy.bindSkill("legacy", f.key)
  expect(() => f.runtime().loadSkill("legacy", f.legacy.current("legacy").skills[0]!.id)).toThrow("approval")
  const memory = f.runtime(), id = memory.approveSkill("owner", f.key)
  expect(() => memory.loadSkill("foreign", id)).toThrow()
  memory.loadSkill("owner", id)
  memory.store.revoke(id)
  expect(() => memory.loadSkill("owner", id)).toThrow()
  expect(() => memory.approveSkill("owner", f.key)).toThrow()
  writeFileSync(join(f.dir, "guide.md"), "Changed instructions.")
  expect(() => memory.approveSkill("owner", f.key)).toThrow("drift")
})
test("twenty restores retain approved complete closure with restart and no learning", () => {
  const f = fixture(); let memory = f.runtime()
  memory.beginTask("owner", "Continue procedure")
  memory.loadSkill("owner", memory.approveSkill("owner", f.key))
  for (let index = 0; index < 20; index++) {
    if (index === 10) memory = f.runtime()
    const text = memory.prepare("owner", budget).text
    expect(text.split("Complete prerequisite instructions.")).toHaveLength(2)
    expect(text.split("Use the exact prerequisite.")).toHaveLength(2)
  }
})

test("workers inherit policy-checked procedures but cannot issue approvals", () => {
  const f = fixture(), memory = f.runtime()
  memory.beginTask("owner", "Apply procedure")
  memory.loadSkill("owner", memory.approveSkill("owner", f.key))
  memory.delegate("owner", "worker", "worker")
  memory.delegate("owner", "checker", "checker")
  expect(memory.prepare("worker", budget).text).toContain("Complete prerequisite instructions.")
  expect(memory.prepare("checker", budget).text).not.toContain("Complete prerequisite instructions.")
  expect(() => memory.approveSkill("worker", f.key)).toThrow("delegated")
})

import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync, unlinkSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  catalogTriggerLabels,
  formatSkillCompactionContext,
  formatSkillSystemContext,
  hintFromMessages,
  isInformativeSkillTurn,
  loadSkillCatalog,
  matchSkills,
  SkillGuidance,
} from "../src/skill-catalog.ts"
import { buildSkillEvidence } from "../src/skill-evolution-evidence.ts"
import { SkillEvolutionOptionsSchema } from "../src/skill-evolution-schemas.ts"
import { removeProject, tempProject } from "./helpers.ts"
import { loadSessionRecovery, sessionRecoveryRelativePath, updateSessionRecovery } from "../src/skill-evolution-store.ts"
import { appendAlgCompactionContext, MAX_COMPACTION_OUTPUT_BYTES } from "../src/compaction.ts"

const options = SkillEvolutionOptionsSchema.parse({ enabled: true })

function writeSkill(project: string, name: string, description: string, body: string) {
  const directory = join(project, ".opencode", "skills", name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`)
}

describe("skill catalog", () => {
  test("lists managed SKILL.md files and skips invalid or duplicate names", () => {
    const project = tempProject("alg-skill-catalog-")
    try {
      writeSkill(project, "duckdb-lake", "Use when running project-local DuckDB lake queries through alg_duckdb_query.", "Call `alg_duckdb_query` with alias-qualified columns.")
      mkdirSync(join(project, ".opencode", "skills", "mismatched"), { recursive: true })
      writeFileSync(join(project, ".opencode", "skills", "mismatched", "SKILL.md"), "---\nname: other-name\ndescription: Use when names do not match.\n---\n\n# Other\n")
      mkdirSync(join(project, ".opencode", "skills", "empty"), { recursive: true })
      const catalog = loadSkillCatalog(project, options)
      expect(catalog.skills.map((skill) => skill.name)).toEqual(["duckdb-lake"])
      expect(catalog.skills[0]).toMatchObject({
        managed: true,
        target: "duckdb-lake/SKILL.md",
        root: ".opencode/skills",
      })
      expect(catalog.skills[0]!.tools).toContain("alg_duckdb_query")
    } finally {
      removeProject(project)
    }
  })

  test("matches unused related tools and formats system plus compaction context", () => {
    const project = tempProject("alg-skill-match-")
    try {
      writeSkill(project, "duckdb-lake", "Use when running project-local DuckDB lake queries through alg_duckdb_query.", "Always call `alg_duckdb_query`.")
      const catalog = loadSkillCatalog(project, options)
      const hint = {
        userText: "query the session events replica",
        assistantText: "",
        tools: ["alg_duckdb_query"],
        loadedSkills: [],
      }
      const matched = matchSkills(catalog, hint)
      expect(matched[0]).toMatchObject({ name: "duckdb-lake", applicable: true, loaded: false })
      expect(catalogTriggerLabels(catalog, hint)).toEqual(["applicable_skill_unused"])
      const system = formatSkillSystemContext(catalog, hint)
      expect(system).toContain("Active skill: duckdb-lake")
      expect(system).toContain("alg_duckdb_query")
      expect(formatSkillCompactionContext(catalog, catalog.skills)).toContain("duckdb-lake")
    } finally {
      removeProject(project)
    }
  })

  test("evidence records catalog coverage and unused-skill triggers", () => {
    const project = tempProject("alg-skill-evidence-catalog-")
    try {
      writeSkill(project, "duckdb-lake", "Use when running project-local DuckDB lake queries through alg_duckdb_query.", "Call `alg_duckdb_query`.")
      const catalog = loadSkillCatalog(project, options)
      const evidence = buildSkillEvidence([
        {
          info: { id: "user-2", sessionID: "session", role: "user", time: { created: 20 } },
          parts: [{ type: "text", text: "query the lake" }],
        },
        {
          info: {
            id: "assistant-2",
            parentID: "user-2",
            sessionID: "session",
            role: "assistant",
            mode: "orchestrator",
            providerID: "xai",
            modelID: "grok",
            time: { created: 21, completed: 22 },
          },
          parts: [{
            type: "tool",
            tool: "alg_duckdb_query",
            state: {
              status: "completed",
              input: { sql: "SELECT e.id FROM session.main.events e" },
              output: "{\"ok\":true,\"columns\":[\"id\"],\"rows\":[[1]],\"truncated\":false}",
            },
          }],
        },
      ], "session", "assistant-2", options, false, 2, catalog)
      expect(evidence.catalog?.skills[0]).toMatchObject({
        name: "duckdb-lake",
        managed: true,
        applicable: true,
        loaded: false,
      })
      expect(evidence.trigger_labels).toContain("applicable_skill_unused")
      expect(isInformativeSkillTurn(evidence.trigger_score, evidence.trigger_labels, 3)).toBe(true)
      expect(isInformativeSkillTurn(evidence.trigger_score, evidence.trigger_labels, 3, "triggered")).toBe(false)
    } finally {
      removeProject(project)
    }
  })

  test("SkillGuidance does not inject catalog text when evolution is disabled", () => {
    const project = tempProject("alg-skill-disabled-inject-")
    try {
      writeSkill(project, "duckdb-lake", "Use when running project-local DuckDB lake queries through alg_duckdb_query.", "Call `alg_duckdb_query`.")
      const disabled = new SkillGuidance(project, SkillEvolutionOptionsSchema.parse({ enabled: false }))
      disabled.observeChatMessages([
        { info: { role: "user", sessionID: "session" }, parts: [{ type: "text", text: "query the lake" }] },
      ])
      expect(disabled.systemContext("session")).toBe("")
      expect(disabled.compactionContext()).toBe("")
    } finally {
      removeProject(project)
    }
  })

  test("hint extraction reads skill tool names from chat messages", () => {
    const hint = hintFromMessages([
      { info: { role: "user", sessionID: "s", text: "ignored" }, parts: [{ type: "text", text: "query duckdb" }] },
      {
        info: { role: "assistant", sessionID: "s" },
        parts: [{ type: "tool", tool: "skill", state: { status: "completed", input: { name: "duckdb-lake" } } }],
      },
    ])
    expect(hint).toMatchObject({ userText: "query duckdb", loadedSkills: ["duckdb-lake"], tools: ["skill"] })
  })
})

describe("session continuity regressions", () => {
  test("recovery updates preserve independent fields and reject substituted owners", () => {
    const project = tempProject("alg-checkpoint-owner-")
    try {
      writeSkill(project, "duckdb-lake", "Query lake datasets", "Use alias-qualified columns.")
      updateSessionRecovery(project, "alice", (current) => ({ ...current, capture: { captured: 2, missing: 1, missing_keys: ["a".repeat(64)] } }))
      const guidance = new SkillGuidance(project, options)
      guidance.observeChatMessages([{ info: { role: "user", sessionID: "alice", id: "u1" }, parts: [{ type: "text", text: "duckdb-lake" }] }])
      guidance.systemContext("alice")
      expect(loadSessionRecovery(project, "alice")?.capture?.missing).toBe(1)
      expect(loadSessionRecovery(project, "alice")?.skills).toHaveLength(1)
      const path = join(project, sessionRecoveryRelativePath("alice"))
      const bytes = readFileSync(path, "utf8")
      writeFileSync(join(project, sessionRecoveryRelativePath("bob")), bytes)
      expect(() => loadSessionRecovery(project, "bob")).toThrow("owner mismatch")
      expect(guidance.systemContext("bob")).toContain("checkpoint unavailable")
      expect(guidance.systemContext("bob")).not.toContain("Use alias-qualified columns.")
      writeFileSync(path, "{broken")
      expect(guidance.compactionContext("alice")).toContain("could not be verified")
    } finally { removeProject(project) }
  })

  test("complete system injection counts as loaded only for its source user turn", () => {
    const project = tempProject("alg-injection-evidence-")
    try {
      writeSkill(project, "duckdb-lake", "Query lake datasets using alg_duckdb_query", "Use `alg_duckdb_query`.")
      const guidance = new SkillGuidance(project, options)
      guidance.observeChatMessages([{ info: { role: "user", sessionID: "alice", id: "u1" }, parts: [{ type: "text", text: "duckdb-lake" }] }])
      guidance.systemContext("alice")
      const envelopes = [
        { info: { role: "user", sessionID: "alice", id: "u1", time: { created: 1 } }, parts: [{ type: "text", text: "duckdb-lake" }] },
        { info: { role: "assistant", sessionID: "alice", id: "a1", parentID: "u1", time: { created: 2, completed: 3 } },
          parts: [{ type: "tool", tool: "alg_duckdb_query", state: { status: "completed", input: {}, output: "{}" } }] },
      ]
      const evidence = buildSkillEvidence(envelopes, "alice", "a1", options, false, 2, guidance.catalog(), guidance.injectedSkillsForTurn("alice", "u1"))
      expect(evidence.catalog?.skills[0]?.loaded).toBe(true)
      expect(evidence.trigger_labels).not.toContain("applicable_skill_unused")
      expect(guidance.injectedSkillsForTurn("bob", "u1")).toEqual([])
      expect(guidance.injectedSkillsForTurn("alice", "u2")).toEqual([])
      writeSkill(project, "duckdb-lake", "Query lake datasets", "Revised procedure")
      expect(guidance.injectedSkillsForTurn("alice", "u1")).toEqual([])
    } finally { removeProject(project) }
  })

  test("no hint or no match does not activate arbitrary skills", () => {
    const project = tempProject("alg-skill-nomatch-")
    try {
      writeSkill(project, "database-admin", "Database maintenance administration", "NEVER_MODIFY_PRODUCTION")
      const catalog = loadSkillCatalog(project, options)
      for (const hint of [undefined, { userText: "hello", assistantText: "", tools: [], loadedSkills: [] }]) {
        const context = formatSkillSystemContext(catalog, hint)
        expect(context).not.toContain("Active skill:")
        expect(context).not.toContain("NEVER_MODIFY_PRODUCTION")
        expect(context).toContain("discovery metadata")
      }
    } finally { removeProject(project) }
  })

  test("oversized Unicode bodies are omitted whole, with hash and reload status", () => {
    const project = tempProject("alg-skill-whole-")
    try {
      for (const name of ["lake-a", "lake-b", "lake-c"]) {
        writeSkill(project, name, "Database maintenance", "界".repeat(2400) + "\nNEVER_MODIFY_PRODUCTION")
      }
      const catalog = loadSkillCatalog(project, options)
      const context = formatSkillSystemContext(catalog, { userText: "lake-a lake-b lake-c", assistantText: "", tools: [], loadedSkills: [] })
      expect(context).not.toContain("界")
      expect(context).not.toContain("Active skill:")
      expect(context.match(/requires_full_load/g)).toHaveLength(3)
      for (const entry of catalog.skills) expect(context).toContain(entry.sha256)
      expect(Buffer.byteLength(context)).toBeLessThanOrEqual(12 * 1024)
    } finally { removeProject(project) }
  })

  test("complete bodies fit atomically within the combined budget", () => {
    const project = tempProject("alg-skill-budget-")
    try {
      for (const name of ["lake-a", "lake-b", "lake-c"]) writeSkill(project, name, "Database maintenance", "x".repeat(4000) + "\nTAIL_CONSTRAINT")
      const catalog = loadSkillCatalog(project, options)
      const included: any[] = []
      const context = formatSkillSystemContext(catalog, { userText: "lake-a lake-b lake-c", assistantText: "", tools: [], loadedSkills: [] }, included)
      expect(included.length).toBeGreaterThan(0)
      expect(context.match(/TAIL_CONSTRAINT/g)?.length).toBe(included.length)
      for (const entry of included) expect(context).toContain(catalog.skills.find((skill) => skill.name === entry.name)!.content)
      expect(Buffer.byteLength(context)).toBeLessThanOrEqual(12 * 1024)
    } finally { removeProject(project) }
  })

  test("late-alphabet active skill survives restart, with owner isolation and drift detection", () => {
    const project = tempProject("alg-skill-restart-")
    try {
      for (let index = 0; index < 20; index++) writeSkill(project, `skill-${String(index).padStart(2, "0")}`, "Specialized procedure", "ORIGINAL_BODY")
      const first = new SkillGuidance(project, options)
      first.observeChatMessages([{ info: { role: "user", sessionID: "alice", id: "user-alice" }, parts: [{ type: "text", text: "skill-19" }] }])
      expect(first.systemContext("alice")).toContain("Active skill: skill-19")
      expect(first.injectedSkillsForTurn("alice", "user-alice")).toEqual(["skill-19"])
      expect(first.injectedSkillsForTurn("alice", "different-turn")).toEqual([])
      const before = loadSessionRecovery(project, "alice")!
      const restarted = new SkillGuidance(project, options)
      expect(restarted.systemContext("alice")).toContain(before.skills[0]!.sha256)
      expect(restarted.compactionContext("alice")).toContain("skill-19")
      expect(restarted.compactionContext("alice")).not.toContain("skill-00")
      expect(restarted.compactionContext("bob")).not.toContain("skill-19")
      writeSkill(project, "skill-19", "Specialized procedure", "CHANGED_BODY")
      expect(restarted.compactionContext("alice")).toContain("state=changed")
      restarted.observeChatMessages([{ info: { role: "user", sessionID: "alice" }, parts: [{ type: "text", text: "skill-19" }] }])
      expect(restarted.systemContext("alice")).not.toContain("CHANGED_BODY")
      unlinkSync(join(project, ".opencode", "skills", "skill-19", "SKILL.md"))
      expect(restarted.compactionContext("alice")).toContain("missing_or_not_catalogued")
      expect(restarted.compactionContext("alice")).toContain(sessionRecoveryRelativePath("alice"))
    } finally { removeProject(project) }
  })

  test("active reference truncation is explicit and failed skill tools are not loaded", () => {
    const project = tempProject("alg-skill-active-budget-")
    try {
      for (let index = 0; index < 32; index++) writeSkill(project, `skill-${index}`, "Specialized procedure", "Body")
      const catalog = loadSkillCatalog(project, options)
      const context = formatSkillCompactionContext(catalog, catalog.skills, "checkpoint.json")
      expect(Buffer.byteLength(context)).toBeLessThanOrEqual(4096)
      expect(context).toMatch(/active references omitted: [1-9]/)
      expect(hintFromMessages([{ info: { role: "assistant" }, parts: [{ type: "tool", tool: "skill", state: { status: "error", input: { name: "skill-0" } } }] }]).loadedSkills).toEqual([])
    } finally { removeProject(project) }
  })

  test("ALG budgeting preserves foreign plugin chunks and prioritizes recovery", () => {
    const foreign = "FOREIGN".repeat(6000)
    const shared = [foreign]
    appendAlgCompactionContext(shared, ["ALG_RECOVERY_POINTER", "x".repeat(40000)])
    expect(shared[0]).toBe(foreign)
    expect(shared.slice(1).join("\n")).toContain("ALG_RECOVERY_POINTER")
    expect(Buffer.byteLength(shared.slice(1).join("\n"))).toBeLessThanOrEqual(MAX_COMPACTION_OUTPUT_BYTES)
    const disabled = [foreign]
    appendAlgCompactionContext(disabled, [])
    expect(disabled).toEqual([foreign])
  })
})

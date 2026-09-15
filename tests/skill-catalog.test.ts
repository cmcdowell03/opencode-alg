import { describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  catalogTriggerLabels,
  formatSkillCompactionContext,
  formatSkillSystemContext,
  hintFromMessages,
  isInformativeSkillTurn,
  loadSkillCatalog,
  matchSkills,
} from "../src/skill-catalog.ts"
import { buildSkillEvidence } from "../src/skill-evolution-evidence.ts"
import { SkillEvolutionOptionsSchema } from "../src/skill-evolution-schemas.ts"
import { removeProject, tempProject } from "./helpers.ts"

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
      expect(formatSkillCompactionContext(catalog)).toContain("duckdb-lake")
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

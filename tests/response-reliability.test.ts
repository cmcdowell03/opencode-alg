import { describe, expect, test } from "bun:test"
import { executeRun } from "../src/executor.ts"
import { parseAndValidate } from "../src/schemas.ts"
import { extractJsonDetailed, runNodeSession } from "../src/sessions.ts"
import { createRun } from "../src/store.ts"
import type { GraphDef } from "../src/types.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

describe("model-agnostic response reliability", () => {
  test("extractor is bounded, escape-aware, and does not salvage nested objects", () => {
    expect(extractJsonDetailed('Preface ```json\n{"text":"escaped \\\" and } {"}\n``` trailing').value)
      .toEqual({ text: 'escaped " and } {' })
    expect(extractJsonDetailed('A [{"nested":true}] B')).toMatchObject({ value: null, reason: "not_object" })
    expect(extractJsonDetailed('A {"broken": } only')).toMatchObject({ value: null, reason: "invalid_json" })
    expect(extractJsonDetailed('Malformed parent {broken: {"passed":true,"failures":[],"score":9}}', "checker"))
      .toMatchObject({ value: null, reason: "invalid_json" })
    expect(extractJsonDetailed('{"unterminated": "text')).toMatchObject({ value: null, reason: "truncated" })
    expect(extractJsonDetailed('{"passed":true,"failures":[],"score":9} {"unfinished":', "checker"))
      .toMatchObject({ value: null, reason: "truncated", candidate_count: 1 })
    const tooMany = Array.from({ length: 9 }, (_, index) => `{"n":${index}}`).join(" ")
    expect(extractJsonDetailed(tooMany)).toMatchObject({ value: null, reason: "too_many", candidate_count: 8 })
    expect(extractJsonDetailed(`{"large":"${"x".repeat(600_000)}"}`)).toMatchObject({ value: null, reason: "oversized" })
  })

  test("role selection normalizes path metadata before schema filtering and rejects two valid objects", () => {
    const valid = (artifactPath: string) => JSON.stringify({
      summary: ["done"], files_touched: ["src\\work.ts"], commands_run: [], risks: [], done: true,
      artifact_path: artifactPath,
    })
    const selected = extractJsonDetailed(`{"note":"draft"}\n${valid(".opencode\\runs\\run-a\\artifacts\\result.md")}`, "implementer")
    expect(selected.value).toMatchObject({ files_touched: ["src/work.ts"], artifact_path: ".opencode/runs/run-a/artifacts/result.md" })
    expect(extractJsonDetailed(`${valid(".opencode/runs/run-a/artifacts/result.md")}\n${valid(".opencode/runs/run-b/artifacts/result.md")}`, "implementer"))
      .toMatchObject({ value: null, reason: "ambiguous", candidate_count: 2 })
  })

  test("schema diagnostics name safe fields and expected types without echoing values or unknown keys", () => {
    const result = parseAndValidate("checker", {
      passed: "submitted-secret-value",
      failures: [],
      score: 10,
      "private-submitted-key": "another-secret",
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    const joined = result.failures.join("\n")
    expect(joined).toContain("passed: code=invalid_type expected=boolean")
    expect(joined).not.toContain("submitted-secret-value")
    expect(joined).not.toContain("private-submitted-key")
    expect(joined).not.toContain("another-secret")
  })

  test("worker prompt and executor accept normalized Windows metadata only within this run", async () => {
    const project = tempProject()
    try {
      const graph: GraphDef = {
        name: "path-response",
        max_global_attempts: 1,
        max_concurrency: 1,
        nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
      }
      const run = createRun({ goal: "write report", criteria: [], graph, projectDirectory: project, ownerSessionId: "session-owner" })
      let prompt = ""
      const completed = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          prompt = options.userPrompt
          return {
            session_id: "worker",
            text: "",
            parsed: {
              summary: ["report written"],
              files_touched: ["src\\generated.ts"],
              commands_run: [],
              risks: [],
              done: true,
              artifact_path: `.opencode\\runs\\${run.run_id}\\artifacts\\report.md`,
            },
          }
        },
      })
      expect(completed.status).toBe("done")
      expect(completed.nodes.work?.output).toMatchObject({
        files_touched: ["src/generated.ts"],
        artifact_path: `.opencode/runs/${run.run_id}/artifacts/report.md`,
      })
      expect(prompt).toContain(`RUN ID: ${run.run_id}`)
      expect(prompt).toContain(`.opencode/runs/${run.run_id}/artifacts/`)
      expect(prompt).toContain("If you did not create an artifact, omit artifact_path.")

      for (const badPath of [
        `.opencode\\runs\\other-run\\artifacts\\report.md`,
        `.opencode\\runs\\${run.run_id}\\artifacts\\..\\history\\report.md`,
        `C:\\private\\report.md`,
      ]) {
        const attempt = createRun({ goal: "reject path", criteria: [], graph, projectDirectory: project, ownerSessionId: "session-owner" })
        const failed = await executeRun(attempt, {
          ...executeContext(project),
          sessionRunner: async () => ({
            session_id: "worker",
            text: "",
            parsed: { summary: ["no"], files_touched: [], commands_run: [], risks: [], done: true, artifact_path: badPath },
          }),
        })
        expect(failed.status).toBe("failed")
        expect(failed.nodes.work?.attempts.at(-1)?.schema_ok).toBe(false)
      }
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("empty tool-only SDK output records bounded metadata without inferring a step limit", async () => {
    const project = tempProject()
    try {
    const client = {
      session: {
        create: async () => ({ data: { id: "child" }, error: undefined }),
        prompt: async () => ({
          data: { parts: [{ type: "tool", name: "read" }], info: { finishReason: "length" } },
          error: undefined,
        }),
      },
    } as never
    const result = await runNodeSession({
      client,
      parentSessionId: "parent",
      agent: "explorer",
      title: "empty-tool-turn",
      userPrompt: "inspect",
      directory: project,
    })
    expect(result.parsed).toBeNull()
    expect(result.error).toBeUndefined()
    expect(result.response_diagnostic).toContain("empty; error_category=none; parts=1; text_parts=0; non_text_parts=1; finish=length")
    expect(result.response_diagnostic).not.toContain("step limit")
    const graph: GraphDef = { name: "empty-response", max_global_attempts: 1, max_concurrency: 1,
      nodes: [{ id: "explore", agent: "explorer", depends_on: [] }] }
    const run = createRun({ goal: "inspect", criteria: [], graph, projectDirectory: project, ownerSessionId: "session-owner" })
    const failed = await executeRun(run, { ...executeContext(project), sessionRunner: async () => result })
    expect(failed.nodes.explore?.attempts.at(-1)).toMatchObject({ outcome: "schema_invalid", schema_ok: false })
    expect(failed.nodes.explore?.attempts.at(-1)?.error).toBeUndefined()
    } finally { removeProject(project) }
  })

  test("oversized SDK text is a bounded response failure, not an SDK error", async () => {
    const project = tempProject()
    try {
      const client = { session: {
        create: async () => ({ data: { id: "child" }, error: undefined }),
        prompt: async () => ({ data: { parts: [{ type: "text", text: "x".repeat(600_000) }] }, error: undefined }),
      } } as never
      const result = await runNodeSession({ client, parentSessionId: "parent", agent: "explorer",
        title: "oversized-response", userPrompt: "inspect", directory: project })
      expect(result).toMatchObject({ parsed: null, text: "" })
      expect(result.error).toBeUndefined()
      expect(result.response_diagnostic).toContain("Response parse: oversized")
      const graph: GraphDef = { name: "oversized-response", max_global_attempts: 1, max_concurrency: 1,
        nodes: [{ id: "explore", agent: "explorer", depends_on: [] }] }
      const run = createRun({ goal: "inspect", criteria: [], graph, projectDirectory: project, ownerSessionId: "session-owner" })
      const failed = await executeRun(run, { ...executeContext(project), sessionRunner: async () => result })
      expect(failed.nodes.explore?.attempts.at(-1)).toMatchObject({ outcome: "schema_invalid", schema_ok: false })
      expect(failed.nodes.explore?.attempts.at(-1)?.error).toBeUndefined()
    } finally { removeProject(project) }
  })
})

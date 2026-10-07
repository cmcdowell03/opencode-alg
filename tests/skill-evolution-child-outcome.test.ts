import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createSkillEvolutionRuntime } from "../src/skill-evolution-runtime.ts"
import { SkillEvolutionOptionsSchema } from "../src/skill-evolution-schemas.ts"
import { removeProject, tempProject } from "./helpers.ts"

type PromptCase = { data?: unknown; error?: unknown; never?: boolean; createError?: unknown; abortUncertain?: boolean }

function runtimeFor(project: string, promptCase: PromptCase, timeoutMs = 5_000) {
  const sdk = {
    app: { log: async () => ({ data: true }) },
    session: {
      create: async () => promptCase.createError
        ? ({ data: undefined, error: promptCase.createError })
        : ({ data: { id: "child-owned" } }),
      prompt: async () => {
        if (promptCase.never) return new Promise(() => {})
        return { data: promptCase.data, error: promptCase.error }
      },
      abort: async () => promptCase.abortUncertain ? ({ data: false }) : ({ data: true }),
      status: async () => ({ data: {} }),
    },
  }
  const active = createSkillEvolutionRuntime({
    client: sdk as never,
    project: { id: "synthetic-project" },
    directory: project,
    worktree: project,
  } as never, {
    options: SkillEvolutionOptionsSchema.parse({ enabled: true, allowBuiltinToolMap: true }),
    childCallTimeoutMs: timeoutMs,
  })
  return { active, sdk }
}

const terminal = (sessionID = "child-owned", overrides: Record<string, unknown> = {}) => ({
  id: "terminal-message",
  sessionID,
  role: "assistant",
  finish: "stop",
  time: { created: 1, completed: 2 },
  ...overrides,
})

async function invoke(promptCase: PromptCase, timeoutMs?: number) {
  const project = tempProject("alg-child-outcome-")
  const { active } = runtimeFor(project, promptCase, timeoutMs)
  try {
    return await (active as any).child("parent", "historical-auditor", "trusted test prompt")
  } finally {
    await active.dispose()
    removeProject(project)
  }
}

describe("private skill-evolution child response boundary", () => {
  test("completed terminal output distinguishes extraction failure from transport uncertainty", async () => {
    const malformed = await invoke({ data: { info: terminal(), parts: [{ type: "text", text: "RAW_CANARY { broken" }] } })
    expect(malformed).toMatchObject({ sessionId: "child-owned", parsed: null, outcome: "completed", output_error: "response_truncated" })
    expect(JSON.stringify(malformed)).not.toContain("RAW_CANARY")

    const schemaInvalid = await invoke({ data: { info: terminal(), parts: [{ type: "text", text: '{"unrecognized":"shape"}' }] } })
    expect(schemaInvalid).toMatchObject({ sessionId: "child-owned", parsed: { unrecognized: "shape" }, outcome: "completed" })

    const valid = await invoke({ data: { info: terminal(), parts: [{ type: "text", text: 'preface {"passed":true,"findings":[]} suffix' }] } })
    expect(valid).toMatchObject({ sessionId: "child-owned", parsed: { passed: true, findings: [] }, outcome: "completed" })

    const array = await invoke({ data: { info: terminal(), parts: [{ type: "text", text: '[{"passed":true}]' }] } })
    expect(array).toMatchObject({ parsed: null, outcome: "completed", output_error: "response_not_object" })

    const ambiguous = await invoke({ data: { info: terminal(), parts: [{ type: "text", text: '{"one":1} {"two":2}' }] } })
    expect(ambiguous).toMatchObject({ parsed: null, outcome: "completed", output_error: "response_ambiguous" })

    const missingText = await invoke({ data: { info: terminal(), parts: [] } })
    expect(missingText).toMatchObject({ parsed: null, outcome: "completed", output_error: "response_empty" })

    const oversized = await invoke({ data: { info: terminal(), parts: [{ type: "text", text: "x".repeat(96 * 1024 + 1) }] } })
    expect(oversized).toMatchObject({ parsed: null, outcome: "completed", output_error: "response_oversized" })
  })

  test("only successful terminal metadata bound to the created child is completed", async () => {
    const cases: Array<[string, PromptCase]> = [
      ["create error", { createError: { message: "synthetic create failure" } }],
      ["prompt error", { error: { message: "synthetic transport failure" } }],
      ["abort uncertainty", { error: { message: "synthetic transport failure" }, abortUncertain: true }],
      ["tool continuation", { data: { info: terminal("child-owned", { finish: "tool-calls" }), parts: [] } }],
      ["incomplete", { data: { info: terminal("child-owned", { time: { created: 1 } }), parts: [] } }],
      ["missing terminal metadata", { data: { parts: [{ type: "text", text: "{}" }] } }],
      ["wrong child identity", { data: { info: terminal("other-child"), parts: [{ type: "text", text: "{}" }] } }],
      ["missing child identity", { data: { info: terminal(undefined as never, { sessionID: undefined }), parts: [] } }],
      ["terminal error", { data: { info: terminal("child-owned", { error: { name: "ProviderError" } }), parts: [] } }],
      ["timeout", { never: true }],
    ]
    for (const [label, promptCase] of cases) {
      const result = await invoke(promptCase, label === "timeout" ? 15 : undefined)
      expect(result.outcome, label).toBe("unknown")
      expect(result.parsed, label).toBeNull()
    }
  })

  test("trusted private contract is conditional and ordinary agent contracts remain present", () => {
    const researcher = readFileSync(new URL("../agents/researcher.md", import.meta.url), "utf8")
    const checker = readFileSync(new URL("../agents/checker.md", import.meta.url), "utf8")
    for (const agent of [researcher, checker]) {
      expect(agent).toContain("Only when the trusted top-level task directly identifies itself as a private")
      expect(agent).toContain("never infer the task or its output contract")
      expect(agent).toContain("trusted task instructions are absent")
    }
    expect(researcher).toContain("Return a structured report with: executive answer, evidence, options, risks/unknowns")
    expect(checker).toContain("Return **only** this JSON object:")
  })
})

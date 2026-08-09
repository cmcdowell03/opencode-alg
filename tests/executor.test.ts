import { describe, expect, test } from "bun:test"
import type { GraphDef } from "../src/types.ts"
import { createRun } from "../src/store.ts"
import { executeRun } from "../src/executor.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

describe("executor semantics", () => {
  test("global attempts are enforced and zero is rejected by graph validation", async () => {
    const project = tempProject()
    try {
      const graph: GraphDef = {
        name: "global-limit",
        max_global_attempts: 2,
        max_concurrency: 3,
        nodes: ["a", "b", "c"].map((id) => ({
          id,
          agent: "explorer" as const,
          depends_on: [],
          loop: { max_attempts: 2, gate: "schema" as const },
        })),
      }
      const run = createRun({
        goal: "global",
        criteria: [],
        graph,
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      const updated = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async () => ({ session_id: "mock", text: "{}", parsed: {} }),
      })
      expect(updated.global_attempts).toBe(2)
      expect(updated.status).toBe("failed")
      expect(Object.values(updated.nodes).every((node) => node.status === "failed")).toBe(true)
      expect(() => createRun({
        goal: "zero",
        criteria: [],
        graph: { ...graph, max_global_attempts: 0 },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })).toThrow()
    } finally {
      removeProject(project)
    }
  })

  test("terminal failed dependencies deterministically skip descendants", async () => {
    const project = tempProject()
    try {
      const graph: GraphDef = {
        name: "failed-dependency",
        max_global_attempts: 2,
        max_concurrency: 2,
        nodes: [
          { id: "work", agent: "implementer", depends_on: [] },
          { id: "check", agent: "checker", depends_on: ["work"] },
        ],
      }
      const run = createRun({
        goal: "fail",
        criteria: ["done"],
        graph,
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      const updated = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async () => ({
          session_id: "mock",
          text: "",
          parsed: { summary: ["partial"], files_touched: [], commands_run: [], risks: [], done: false },
        }),
      })
      expect(updated.nodes.work!.status).toBe("failed")
      expect(updated.nodes.check!.status).toBe("skipped")
      expect(updated.status).toBe("failed")
      expect(updated.status).not.toBe("blocked")
    } finally {
      removeProject(project)
    }
  })

  test("explicit checker metadata routes generic feedback without resetting history", async () => {
    const project = tempProject()
    const prompts: string[] = []
    try {
      const graph: GraphDef = {
        name: "generic-feedback",
        max_global_attempts: 4,
        max_concurrency: 2,
        nodes: [
          {
            id: "builder-any-name",
            agent: "implementer",
            depends_on: [],
            loop: { max_attempts: 2, gate: "schema" },
          },
          {
            id: "audit-any-name",
            agent: "checker",
            depends_on: ["builder-any-name"],
            inputs: { claimed: "builder-any-name", criteria: "$criteria" },
            feedback_to: "builder-any-name",
            isolated_check: true,
            loop: { max_attempts: 2, gate: "schema" },
          },
        ],
      }
      let implementCalls = 0
      let checkerCalls = 0
      const run = createRun({
        goal: "feedback",
        criteria: ["pass audit"],
        graph,
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      const updated = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          prompts.push(options.userPrompt)
          if (options.agent === "implementer") {
            implementCalls++
            return {
              session_id: `impl-${implementCalls}`,
              text: "",
              parsed: { summary: [`version ${implementCalls}`], files_touched: [], commands_run: [], risks: [], done: true },
            }
          }
          checkerCalls++
          return checkerCalls === 1
            ? { session_id: "check-1", text: "", parsed: { passed: false, failures: ["fix generic issue"], score: 2 } }
            : { session_id: "check-2", text: "", parsed: { passed: true, failures: [], score: 10 } }
        },
      })
      expect(updated.status).toBe("done")
      expect(updated.nodes["builder-any-name"]!.attempts).toHaveLength(2)
      expect(updated.nodes["audit-any-name"]!.attempts).toHaveLength(2)
      expect(updated.nodes["audit-any-name"]!.attempts[0]!.feedback_applied).toBe(true)
      expect(prompts.filter((prompt) => prompt.includes("fix generic issue"))).toHaveLength(1)
      expect(updated.global_attempts).toBe(4)
    } finally {
      removeProject(project)
    }
  }, 15_000)
})

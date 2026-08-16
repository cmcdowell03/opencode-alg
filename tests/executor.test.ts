import { describe, expect, test } from "bun:test"
import type { GraphDef } from "../src/types.ts"
import { createRun, loadRun } from "../src/store.ts"
import { executeRun, MAX_RUN_SUMMARY_CHARS } from "../src/executor.ts"
import { MAX_SDK_DIAGNOSTIC_BYTES } from "../src/diagnostics.ts"
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
  // Four fenced checkpoints recursively verify the complete immutable tree;
  // retain the routing assertions while allowing durable Windows I/O.
  }, 120_000)

  test("schema-valid checker pass with a failed shell gate retries only the checker", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "route checker gate failures exactly",
        criteria: ["pass"],
        graph: {
          name: "checker-gate-routing",
          max_global_attempts: 4,
          max_concurrency: 1,
          nodes: [
            { id: "work", agent: "implementer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } },
            {
              id: "check",
              agent: "checker",
              depends_on: ["work"],
              inputs: { claimed: "work" },
              feedback_to: "work",
              isolated_check: true,
              shell_gate: { cmd: "checker-gate" },
              loop: { max_attempts: 2, gate: "all" },
            },
          ],
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      let workers = 0
      let checkers = 0
      let shellCalls = 0
      const completed = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          if (options.agent === "implementer") {
            workers++
            return { session_id: `worker-${workers}`, text: "", parsed: { summary: ["done"], files_touched: [], commands_run: [], risks: [], done: true } }
          }
          checkers++
          return { session_id: `checker-${checkers}`, text: "", parsed: { passed: true, failures: [], score: 10 } }
        },
        shellRunner: async () => {
          shellCalls++
          return {
            exit_code: shellCalls === 1 ? 1 : 0,
            ok: shellCalls !== 1,
            cwd: project,
            stdout_tail: "",
            stderr_tail: shellCalls === 1 ? "gate failed" : "",
          }
        },
      })

      expect(completed.status).toBe("done")
      expect(workers).toBe(1)
      expect(checkers).toBe(2)
      expect(shellCalls).toBe(2)
      expect(completed.nodes.check!.attempts.map((attempt) => attempt.outcome))
        .toEqual(["gate_failure", "passed"])
      expect(completed.nodes.check!.attempts[0]!.feedback_applied).toBeUndefined()
      expect(completed.nodes.work!.attempts).toHaveLength(1)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("exactly 100 checker failures plus a shell failure persist within the cap and retry only the checker", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "persist and route a full checker failure aggregate",
        criteria: ["pass"],
        graph: {
          name: "checker-failure-aggregate",
          max_global_attempts: 3,
          max_concurrency: 1,
          nodes: [
            { id: "work", agent: "implementer", depends_on: [] },
            {
              id: "check",
              agent: "checker",
              depends_on: ["work"],
              inputs: { claimed: "work" },
              feedback_to: "work",
              isolated_check: true,
              shell_gate: { cmd: "checker-gate" },
              loop: { max_attempts: 2, gate: "all" },
            },
          ],
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      let workers = 0
      let checkers = 0
      let shellCalls = 0
      let persistedBetweenAttempts: ReturnType<typeof loadRun>
      const checkerFailures = Array.from({ length: 100 }, (_, index) =>
        `checker failure ${index.toString().padStart(3, "0")}`)
      const completed = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          if (options.agent === "implementer") {
            workers++
            return { session_id: "worker", text: "", parsed: { summary: ["done"], files_touched: [], commands_run: [], risks: [], done: true } }
          }
          checkers++
          if (checkers === 2) persistedBetweenAttempts = loadRun(project, run.run_id)
          return checkers === 1
            ? { session_id: "checker-1", text: "", parsed: { passed: false, failures: checkerFailures, score: 0 } }
            : { session_id: "checker-2", text: "", parsed: { passed: true, failures: [], score: 10 } }
        },
        shellRunner: async () => {
          shellCalls++
          return {
            exit_code: shellCalls === 1 ? 1 : 0,
            ok: shellCalls !== 1,
            cwd: project,
            stdout_tail: "",
            stderr_tail: shellCalls === 1 ? "shell sentinel" : "",
          }
        },
      })

      const firstAttempt = completed.nodes.check!.attempts[0]!
      const persistedFirst = persistedBetweenAttempts!.nodes.check!.attempts[0]!
      expect(completed.status).toBe("done")
      expect(workers).toBe(1)
      expect(checkers).toBe(2)
      expect(shellCalls).toBe(2)
      expect(firstAttempt.outcome).toBe("gate_failure")
      expect(firstAttempt.feedback_applied).toBeUndefined()
      expect(firstAttempt.failures).toHaveLength(100)
      expect(firstAttempt.failures.some((failure) => failure.includes("shell sentinel"))).toBe(true)
      expect(firstAttempt.failures.some((failure) => failure.includes("checker failure 000"))).toBe(true)
      expect(firstAttempt.failures.at(-1)).toBe("[truncated] 2 additional failure entries omitted")
      expect(persistedFirst.failures).toEqual(firstAttempt.failures)
      expect(persistedBetweenAttempts!.nodes.check!.last_failures).toEqual(firstAttempt.failures)
      expect(completed.nodes.work!.attempts).toHaveLength(1)
      expect(loadRun(project, completed.run_id)?.status).toBe("done")
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("maximum valid graph and failure history reaches a bounded final save and reload", async () => {
    const project = tempProject()
    try {
      const nodes = Array.from({ length: 64 }, (_, index) => ({
        id: `node-${index.toString().padStart(2, "0")}`,
        agent: "explorer" as const,
        depends_on: [],
      }))
      const run = createRun({
        goal: "g".repeat(20_000),
        criteria: [],
        graph: {
          name: "maximum-summary-stress",
          max_global_attempts: 64,
          max_concurrency: 8,
          nodes,
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      const completed = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async () => ({
          session_id: "",
          text: "",
          parsed: {
            query: "invalid",
            map: Array.from({ length: 100 }, () => ({ path: "", role: "" })),
            key_hits: [],
            next: "none",
          },
        }),
      })
      const persisted = loadRun(project, completed.run_id)!
      expect(persisted.status).toBe("failed")
      expect(Object.values(persisted.nodes)).toHaveLength(64)
      expect(Object.values(persisted.nodes).every((node) => node.attempts[0]?.failures.length === 100)).toBe(true)
      expect(persisted.summary).toContain("chars/")
      expect(persisted.summary).toContain("failure_entries_omitted=99")
      expect(persisted.summary!.length).toBeLessThanOrEqual(MAX_RUN_SUMMARY_CHARS)
      expect(Buffer.byteLength(persisted.summary!, "utf8")).toBeLessThanOrEqual(MAX_RUN_SUMMARY_CHARS)
    } finally {
      removeProject(project)
    }
  // This maximum graph performs batched running/terminal checkpoints while
  // each commit re-verifies all previously reachable sidecars. The longer
  // timeout preserves the 64-node/100-failure stress workload and assertions.
  }, 300_000)

  test("maximum executor error is prefixed within the persisted field cap", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "persist maximum executor error",
        criteria: [],
        graph: {
          name: "maximum-executor-error",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "explorer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      const maximum = Object.assign(new Error("m".repeat(10_000)), {
        code: "c".repeat(1_000),
        errorCode: "e".repeat(1_000),
        error_code: "d".repeat(1_000),
        requestId: "r".repeat(1_000),
        correlationId: "i".repeat(1_000),
      })
      const completed = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async () => { throw maximum },
      })
      const persisted = loadRun(project, completed.run_id)!
      const failure = persisted.nodes.work!.attempts[0]!.failures[0]!
      expect(persisted.status).toBe("failed")
      expect(failure).toStartWith("Executor error: ")
      expect(Buffer.byteLength(failure, "utf8")).toBe(MAX_SDK_DIAGNOSTIC_BYTES)
      expect(failure.length).toBeLessThanOrEqual(2_000)
      expect(persisted.nodes.work!.last_failures).toEqual([failure])
    } finally {
      removeProject(project)
    }
  }, 15_000)
})

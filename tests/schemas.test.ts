import { describe, expect, test } from "bun:test"
import { getTemplate } from "../src/templates.ts"
import { validateGraph } from "../src/graph.ts"
import {
  CheckOut,
  ImplementOut,
  NodeAttemptSchema,
  parseAndValidate,
  parsePersistedNodeAttempt,
  parseRunState,
} from "../src/schemas.ts"
import { assertSafeId } from "../src/paths.ts"
import { createRun } from "../src/store.ts"
import { executeRun } from "../src/executor.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

describe("strict contracts", () => {
  test("persisted attempt session IDs reject surrounding whitespace instead of normalizing it", () => {
    expect(NodeAttemptSchema.safeParse({
      attempt: 1,
      status: "running",
      session_id: " child-session ",
      started_at: "2026-08-11T12:00:00.000Z",
      failures: [],
    }).success).toBe(false)
  })

  test("checker pass/failure/score invariants reject contradictions", () => {
    expect(CheckOut.safeParse({ passed: true, failures: [], score: 9 }).success).toBe(true)
    expect(CheckOut.safeParse({ passed: true, failures: ["bad"], score: 9 }).success).toBe(false)
    expect(CheckOut.safeParse({ passed: false, failures: [], score: 2 }).success).toBe(false)
    expect(CheckOut.safeParse({ passed: false, failures: ["bad"], score: 8 }).success).toBe(false)
    expect(CheckOut.safeParse({ passed: true, failures: [], score: 9.5 }).success).toBe(false)
  })

  test("checker outcomes require matching passed semantics and proved graph shell gates", () => {
    const timestamp = "2026-08-11T12:00:00.000Z"
    const passedGateFailure = {
      attempt: 1,
      status: "failed" as const,
      started_at: timestamp,
      finished_at: timestamp,
      output: { passed: true, failures: [], score: 9 },
      failures: ["shell failed"],
      score: 9,
      shell_ok: false,
      schema_ok: true,
      outcome: "gate_failure" as const,
    }
    const context = {
      agent: "checker",
      run_id: "run",
      node_id: "check",
      expected_attempt: 1,
      mode: "live" as const,
    }
    expect(() => parsePersistedNodeAttempt(passedGateFailure, {
      ...context,
      requires_shell: true,
    })).not.toThrow()
    expect(() => parsePersistedNodeAttempt(passedGateFailure, {
      ...context,
      requires_shell: false,
    })).toThrow(/actual live shell\/all graph gate/)
    expect(() => parsePersistedNodeAttempt({ ...passedGateFailure, shell_ok: true }, {
      ...context,
      requires_shell: true,
    })).toThrow(/shell_ok=false|proved shell gate failure/)
    expect(() => parsePersistedNodeAttempt({ ...passedGateFailure, shell_ok: undefined }, {
      ...context,
      requires_shell: true,
    })).toThrow(/shell_ok=false|proved shell gate failure/)

    const rejected = {
      ...passedGateFailure,
      output: { passed: false, failures: ["substantive"], score: 3 },
      failures: ["substantive"],
      score: 3,
      shell_ok: undefined,
      outcome: "substantive_rejection" as const,
    }
    expect(() => parsePersistedNodeAttempt(rejected, {
      ...context,
      requires_shell: false,
    })).not.toThrow()
    expect(() => parsePersistedNodeAttempt({
      ...rejected,
      output: passedGateFailure.output,
      score: 9,
    }, {
      ...context,
      requires_shell: false,
    })).toThrow(/substantive_rejection.*passed=false/)
    expect(() => parsePersistedNodeAttempt({
      ...rejected,
      status: "done",
      failures: [],
      outcome: "passed",
    }, {
      ...context,
      requires_shell: false,
    })).toThrow(/passed=true|rejected checker output/)
  })

  test("implementer requires done=true and strict fields", () => {
    const base = { summary: ["changed"], files_touched: [], commands_run: [], risks: [] }
    expect(ImplementOut.safeParse({ ...base, done: true }).success).toBe(true)
    expect(ImplementOut.safeParse({ ...base, done: false }).success).toBe(false)
    expect(ImplementOut.safeParse({ ...base, done: true, surprise: 1 }).success).toBe(false)
  })

  test("implementer path metadata is normalized, project-relative, and traversal-safe", () => {
    const valid = {
      summary: ["changed"],
      files_touched: ["src/file.ts", "docs/a file.md", ".github/workflows/check.yml"],
      commands_run: [],
      risks: [],
      done: true,
      artifact_path: ".opencode/runs/safe-run/artifacts/implementation.md",
    }
    expect(ImplementOut.safeParse(valid).success).toBe(true)
    for (const path of [
      "/etc/passwd",
      "C:/Windows/file",
      "C:\\Windows\\file",
      "\\\\server\\share\\file",
      "../escape",
      "src/../escape",
      "src//file",
      "src/./file",
      "src/__proto__/file",
      "src/constructor/file",
      "src/control\u0000file",
    ]) {
      expect(ImplementOut.safeParse({ ...valid, files_touched: [path] }).success).toBe(false)
    }
    for (const artifactPath of [
      "artifacts/implementation.md",
      ".opencode/runs/../artifacts/x",
      ".opencode/runs/safe-run/output.txt",
      ".opencode/runs/__proto__/artifacts/x",
      "/.opencode/runs/safe-run/artifacts/x",
    ]) {
      expect(ImplementOut.safeParse({ ...valid, artifact_path: artifactPath }).success).toBe(false)
    }
  })

  test("unknown agents are rejected instead of receiving a permissive record", () => {
    expect(parseAndValidate("attacker", { arbitrary: true })).toEqual({
      ok: false,
      failures: ["unknown ALG agent: attacker"],
    })
  })

  test("graph rejects unknown agents, zero attempts, extra fields, and unordered refs", () => {
    const graph = getTemplate("coding-diamond") as unknown as Record<string, unknown>
    const unknownAgent = structuredClone(graph) as any
    unknownAgent.nodes[0].agent = "root"
    expect(() => validateGraph(unknownAgent)).toThrow()

    const zero = structuredClone(graph) as any
    zero.nodes[1].loop.max_attempts = 0
    expect(() => validateGraph(zero)).toThrow()

    const extra = structuredClone(graph) as any
    extra.nodes[0].unexpected = true
    expect(() => validateGraph(extra)).toThrow()

    const unordered = structuredClone(graph) as any
    unordered.nodes[0].inputs = { stolen: "implement" }
    expect(() => validateGraph(unordered)).toThrow(/not an earlier dependency/)
  })

  test("legacy omitted global cap receives local capacity while explicit bounded caps are preserved", () => {
    const legacy = validateGraph({
      name: "legacy-one-node",
      nodes: [{
        id: "work",
        agent: "implementer",
        depends_on: [],
        loop: { max_attempts: 3, gate: "schema" },
      }],
    })
    expect(legacy.max_global_attempts).toBe(3)
    expect(legacy.max_concurrency).toBe(4)

    const oneAttempt = validateGraph({
      name: "legacy-one-attempt",
      nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
    })
    expect(oneAttempt.max_global_attempts).toBe(1)

    const explicit = validateGraph({
      name: "explicit-global-cap",
      max_global_attempts: 73,
      max_concurrency: 1,
      nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
    })
    expect(explicit.max_global_attempts).toBe(73)
    expect(() => validateGraph({ ...explicit, max_global_attempts: 10_001 })).toThrow()
  })

  test("traversal and prototype-shaped ids are rejected", () => {
    for (const id of ["../x", "..", ".", "a/b", "a\\b", "__proto__", "constructor", " x", "x%2fy"]) {
      expect(() => assertSafeId(id)).toThrow()
    }
    for (const id of ["a", "run-1", "node.name", "A_2"]) expect(assertSafeId(id)).toBe(id)
  })

  test("run state validates exact graph/state identity and null-prototype maps", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "validate state",
        criteria: ["strict"],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
        mode: "dry",
      })
      const parsed = parseRunState(JSON.parse(JSON.stringify(run)))
      expect(Object.getPrototypeOf(parsed.nodes)).toBeNull()
      const bad = JSON.parse(JSON.stringify(run))
      bad.nodes.research.agent = "checker"
      expect(() => parseRunState(bad)).toThrow(/identity/)
      bad.nodes.research.agent = "researcher"
      bad.global_attempts = 1
      expect(() => parseRunState(bad)).toThrow(/global_attempts/)
    } finally {
      removeProject(project)
    }
  }, 120_000)

  test("run state rejects forged outputs, attempts, statuses, and dependency completion", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "cross invariants",
        criteria: ["strict"],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const timestamp = new Date().toISOString()

      const doneWithoutAttempt = JSON.parse(JSON.stringify(run))
      doneWithoutAttempt.status = "running"
      doneWithoutAttempt.nodes.explore_a.status = "done"
      doneWithoutAttempt.nodes.explore_a.output = { arbitrary: true }
      expect(() => parseRunState(doneWithoutAttempt)).toThrow(/successful final attempt/)

      const invalidAttemptOutput = JSON.parse(JSON.stringify(run))
      invalidAttemptOutput.status = "failed"
      invalidAttemptOutput.phase = "failed"
      invalidAttemptOutput.global_attempts = 1
      invalidAttemptOutput.nodes.explore_a = {
        ...invalidAttemptOutput.nodes.explore_a,
        status: "failed",
        current_attempt: 1,
        output: { arbitrary: true },
        last_failures: ["bad output"],
        attempts: [{
          attempt: 1,
          status: "failed",
          started_at: timestamp,
          finished_at: timestamp,
          output: { arbitrary: true },
          failures: ["bad output"],
          schema_ok: true,
        }],
      }
      expect(() => parseRunState(invalidAttemptOutput)).toThrow(/output violates explorer schema/)

      const doneBeforeDependency = JSON.parse(JSON.stringify(run))
      const researchOutput = {
        answer: "answer",
        evidence: [],
        constraints: [],
        options: [],
        acceptance_criteria: ["criterion"],
        risks: [],
      }
      doneBeforeDependency.status = "running"
      doneBeforeDependency.global_attempts = 1
      doneBeforeDependency.nodes.research = {
        ...doneBeforeDependency.nodes.research,
        status: "done",
        current_attempt: 1,
        output: researchOutput,
        attempts: [{
          attempt: 1,
          status: "done",
          started_at: timestamp,
          finished_at: timestamp,
          output: researchOutput,
          failures: [],
          schema_ok: true,
        }],
      }
      expect(() => parseRunState(doneBeforeDependency)).toThrow(/requires done dependency/)

      const runningMismatch = JSON.parse(JSON.stringify(run))
      runningMismatch.status = "running"
      runningMismatch.global_attempts = 1
      runningMismatch.nodes.explore_a.current_attempt = 1
      runningMismatch.nodes.explore_a.attempts = [{
        attempt: 1,
        status: "running",
        started_at: timestamp,
        failures: [],
      }]
      expect(() => parseRunState(runningMismatch)).toThrow(/running final attempt requires running node/)
    } finally {
      removeProject(project)
    }
  })

  test("forged rejected checker output cannot support done attempt/node/run", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "checker forgery",
        criteria: ["pass"],
        graph: getTemplate("coding-diamond"),
        projectDirectory: project,
        ownerSessionId: "session-owner",
        mode: "dry",
      })
      const completed = await executeRun(run, { ...executeContext(project), dry: true })
      const forged = JSON.parse(JSON.stringify(completed))
      const rejected = { passed: false, failures: ["rejected"], score: 2 }
      const checker = forged.nodes.check
      checker.output = rejected
      checker.attempts.at(-1).output = rejected
      checker.attempts.at(-1).score = 2
      expect(() => parseRunState(forged)).toThrow(/rejected checker output cannot complete/)
    } finally {
      removeProject(project)
    }
  }, 120_000)

  test("ownership transfer history is a strict creator-rooted monotonic chain", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "ownership chain",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "alice",
      })
      const valid = JSON.parse(JSON.stringify(run))
      valid.owner_transfers = [
        {
          from_session_id: "alice",
          to_session_id: "bob",
          by_session_id: "alice",
          transferred_at: "2026-08-08T01:00:00.000Z",
        },
        {
          from_session_id: "bob",
          to_session_id: "carol",
          by_session_id: "bob",
          transferred_at: "2026-08-08T02:00:00.000Z",
        },
      ]
      valid.owner_session_id = "carol"
      expect(() => parseRunState(valid)).not.toThrow()

      const cases: Array<[string, (state: any) => void]> = [
        ["actor", (state) => { state.owner_transfers[0].by_session_id = "mallory" }],
        ["self", (state) => { state.owner_transfers[0].to_session_id = "alice" }],
        ["first-source", (state) => { state.owner_transfers[0].from_session_id = "mallory" }],
        ["chain", (state) => { state.owner_transfers[1].from_session_id = "mallory" }],
        ["time", (state) => { state.owner_transfers[1].transferred_at = "2026-08-08T00:00:00.000Z" }],
        ["final", (state) => { state.owner_session_id = "bob" }],
      ]
      for (const [, mutate] of cases) {
        const forged = structuredClone(valid)
        mutate(forged)
        expect(() => parseRunState(forged)).toThrow()
      }
      const noHistoryForgery = JSON.parse(JSON.stringify(run))
      noHistoryForgery.owner_session_id = "mallory"
      expect(() => parseRunState(noHistoryForgery)).toThrow(/final owner/)
    } finally {
      removeProject(project)
    }
  })

  test("persisted checker attempt scores reject fractions and scores without output", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "score forgery",
        criteria: [],
        graph: {
          name: "score-forgery",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "audit", agent: "checker", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const timestamp = new Date().toISOString()
      const rejected = { passed: false, failures: ["rejected"], score: 2 }
      const base = JSON.parse(JSON.stringify(run))
      base.status = "failed"
      base.phase = "failed"
      base.global_attempts = 1
      base.nodes.audit = {
        ...base.nodes.audit,
        status: "failed",
        current_attempt: 1,
        output: rejected,
        last_failures: ["rejected"],
        attempts: [{
          attempt: 1,
          status: "failed",
          started_at: timestamp,
          finished_at: timestamp,
          output: rejected,
          failures: ["rejected"],
          schema_ok: true,
          score: 2,
        }],
      }
      const fractional = structuredClone(base)
      fractional.nodes.audit.attempts[0].score = 2.5
      expect(() => parseRunState(fractional)).toThrow()

      const orphan = structuredClone(base)
      delete orphan.nodes.audit.output
      delete orphan.nodes.audit.attempts[0].output
      orphan.nodes.audit.attempts[0].schema_ok = false
      expect(() => parseRunState(orphan)).toThrow(/score requires validated checker output/)
    } finally {
      removeProject(project)
    }
  })

  test("loaded implementer artifacts must belong to the current run id", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "artifact binding",
        criteria: [],
        graph: getTemplate("coding-diamond"),
        projectDirectory: project,
        ownerSessionId: "session-owner",
        mode: "dry",
      })
      const completed = await executeRun(run, { ...executeContext(project), dry: true })
      const forged = JSON.parse(JSON.stringify(completed))
      forged.nodes.implement.output.artifact_path = ".opencode/runs/other-run/artifacts/implementation.md"
      forged.nodes.implement.attempts.at(-1).output.artifact_path = ".opencode/runs/other-run/artifacts/implementation.md"
      expect(() => parseRunState(forged)).toThrow(/artifact_path belongs to a different run/)
    } finally {
      removeProject(project)
    }
  }, 60_000)
})

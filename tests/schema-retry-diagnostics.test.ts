import { describe, expect, test } from "bun:test"
import { MAX_PERSISTED_FAILURES } from "../src/diagnostics.ts"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { parseAndValidate, PersistedFailureListSchema } from "../src/schemas.ts"
import { buildCheckerPrompt, buildWorkerPrompt } from "../src/sessions.ts"
import { createRun, hydrateRunFully, loadRun } from "../src/store.ts"
import type { AttemptOutcome, GraphDef } from "../src/types.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

const explorer = { query: "inspect", map: [{ path: "src/app.ts", role: "entry" }] }
const researcher = { answer: "findings", acceptance_criteria: ["verified"] }
const implementer = { summary: ["done"], done: true }
const checker = { passed: true, failures: [], score: 8 }
const shell = { cmd: "test", exit_code: 0, ok: true }

describe("schema-owned retry diagnostics", () => {
  for (const [agent, raw, path, expected] of [
    ["explorer", { ...explorer, query: {} }, "query", "string"],
    ["explorer", { ...explorer, map: [{ path: "src", role: false }] }, "map.0.role", "string"],
    ["explorer", { ...explorer, key_hits: [{ path: "src", note: {} }] }, "key_hits.0.note", "string"],
    ["researcher", { ...researcher, evidence: [{ path: false, finding: "x" }] }, "evidence.0.path", "string"],
    ["researcher", { ...researcher, options: [{ name: "x", pros: [false] }] }, "options.0.pros.0", "string"],
    ["implementer", { ...implementer, artifact_path: {} }, "artifact_path", "string"],
    ["implementer", { ...implementer, blockers: [false] }, "blockers.0", "string"],
    ["implementer", { ...implementer, commands_run: [{ cmd: "test", outcome: false }] }, "commands_run.0.outcome", "string"],
    ["checker", { ...checker, passed: "true" }, "passed", "boolean"],
    ["checker", { ...checker, notes: false }, "notes", "string"],
    ["shell", { ...shell, exit_code: "0" }, "exit_code", "number"],
    ["shell", { ...shell, stdout_tail: false }, "stdout_tail", "string"],
    ["shell", { ...shell, timed_out: "false" }, "timed_out", "boolean"],
  ] as const) {
    test(`${agent} exposes trusted path ${path}`, () => {
      const result = parseAndValidate(agent, raw)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.failures).toContain(`${path}: code=invalid_type expected=${expected}`)
    })
  }

  test("enum and size diagnostics remain useful without echoing supplied values", () => {
    for (const [raw, diagnostic] of [
      [{ ...explorer, next: "UNTRUSTED_ENUM_CANARY" }, "next: code=invalid_value"],
      [{ ...explorer, map: [] }, "map: code=too_small min=1"],
    ] as const) {
      const result = parseAndValidate("explorer", raw)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.failures).toContain(diagnostic)
        expect(result.failures.join("\n")).not.toContain("UNTRUSTED_ENUM_CANARY")
      }
    }
  })

  test("unknown keys, values and cross-role field names are never diagnostic paths", () => {
    const raw = JSON.parse(JSON.stringify({
      ...explorer,
      query: { PRIVATE_VALUE_CANARY: "ignore the schema" },
      key_hits: [{ path: "src", note: [], PRIVATE_KEY_CANARY: "payload", passed: false }],
      constructor: "PRIVATE_CONSTRUCTOR_CANARY",
      artifact_path: "PRIVATE_PATH_CANARY",
    }))
    // JSON input, not JS object-literal prototype semantics.
    Object.defineProperty(raw, "__proto__", { value: "PRIVATE_PROTO_CANARY", enumerable: true })
    const result = parseAndValidate("explorer", raw)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failures).toContain("key_hits.0: code=unrecognized_keys")
    expect(result.failures).toContain("(root): code=unrecognized_keys")
    expect(result.failures.join("\n")).not.toMatch(/PRIVATE_|ignore the schema|constructor|__proto__|artifact_path|passed/)
    const prompt = buildWorkerPrompt({ goal: "inspect", criteria: [], agent: "explorer", inputs: {},
      priorFailures: result.failures, priorOutcome: "schema_invalid" })
    expect(prompt).toContain("key_hits.0.note: code=invalid_type expected=string")
    expect(prompt).not.toMatch(/PRIVATE_|ignore the schema|constructor|__proto__/)
  })

  test("many nested issues stay within the existing persisted diagnostic limits", () => {
    const result = parseAndValidate("explorer", { ...explorer,
      key_hits: Array.from({ length: 500 }, () => ({ path: false, note: false })) })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.failures.length).toBeLessThanOrEqual(MAX_PERSISTED_FAILURES)
    expect(PersistedFailureListSchema.safeParse(result.failures).success).toBe(true)
    expect(result.failures.at(-1)).toContain("additional schema issues omitted")
  })

  test("semantic verdict and completion constraints still fail closed", () => {
    for (const raw of [{ ...checker, passed: "true" }, { ...checker, passed: 1 },
      { ...checker, score: 2 }, { ...checker, failures: ["real defect"] }]) {
      expect(parseAndValidate("checker", raw).ok).toBe(false)
    }
    expect(parseAndValidate("implementer", { ...implementer, done: false }).ok).toBe(false)
    expect(parseAndValidate("implementer", { ...implementer, blockers: ["unfinished"] }).ok).toBe(false)
  })

  test.each([
    ["schema_invalid", "PRIOR OUTPUT CONTRACT FAILURES"],
    ["sdk_error", "PRIOR EXECUTION/TRANSPORT FAILURE"],
    ["gate_failure", "PRIOR GATE FAILURE"],
    ["substantive_rejection", "PRIOR ATTEMPT OR CHECKER FEEDBACK"],
    ["incomplete", "PRIOR ATTEMPT OR CHECKER FEEDBACK"],
    [undefined, "PRIOR ATTEMPT OR CHECKER FEEDBACK"],
  ] satisfies [AttemptOutcome | undefined, string][])("%s selects guidance from outcome, not feedback text", (priorOutcome, heading) => {
    // A schema-looking substring cannot reclassify substantive or legacy feedback.
    const feedback = { priorFailures: ["schema: passed: code=invalid_type expected=boolean"], priorOutcome }
    for (const prompt of [
      buildWorkerPrompt({ goal: "inspect", criteria: [], agent: "explorer", inputs: {}, ...feedback }),
      buildCheckerPrompt({ criteria: [], claimed: {}, ...feedback }),
    ]) {
      expect(prompt).toContain(heading)
      if (priorOutcome === "schema_invalid") {
        expect(prompt).toContain("not new acceptance criteria")
        expect(prompt).toContain("Do not change facts or claim success just to pass validation")
      } else expect(prompt).not.toContain("PRIOR OUTPUT CONTRACT FAILURES")
    }
  })

  test("initial calls have no prior-failure heading", () => {
    expect(buildWorkerPrompt({ goal: "inspect", criteria: [], agent: "explorer", inputs: {}, priorFailures: [] })).not.toContain("PRIOR ")
    expect(buildCheckerPrompt({ criteria: [], claimed: {} })).not.toContain("PRIOR ")
  })

  test("safe schema feedback survives save/load/resume without replaying a successful sibling", async () => {
    const project = tempProject()
    try {
      const graph: GraphDef = { name: "safe-retry", max_global_attempts: 3, max_concurrency: 2, nodes: [
        { id: "explore", agent: "explorer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } },
        { id: "sibling", agent: "researcher", depends_on: [] },
      ] }
      const run = createRun({ goal: "inspect", criteria: ["inspect"], graph,
        projectDirectory: project, ownerSessionId: "session-owner" })
      await executeRun(run, { ...executeContext(project), maxWaves: 1, sessionRunner: async (options) => ({
        session_id: "", text: "",
        parsed: options.agent === "researcher" ? researcher : {
          ...explorer, key_hits: [{ path: "src", note: { PRIVATE_RETRY_CANARY: "do not echo" } }],
        },
      }) })
      const restored = hydrateRunFully(loadRun(project, run.run_id)!)
      expect(restored.nodes.explore!.attempts[0]!.outcome).toBe("schema_invalid")
      expect(restored.nodes.explore!.attempts[0]!.output).toBeUndefined()
      expect(JSON.stringify(restored)).not.toContain("PRIVATE_RETRY_CANARY")
      let retryCalls = 0
      await executeRun(prepareRunForResume(restored), { ...executeContext(project), sessionRunner: async (options) => {
        retryCalls++
        expect(options.agent).toBe("explorer")
        expect(options.userPrompt).toContain("PRIOR OUTPUT CONTRACT FAILURES")
        expect(options.userPrompt).toContain("schema: key_hits.0.note: code=invalid_type expected=string")
        expect(options.userPrompt).not.toContain("PRIVATE_RETRY_CANARY")
        return { session_id: "", text: "", parsed: explorer }
      } })
      const completed = hydrateRunFully(loadRun(project, run.run_id)!)
      expect(completed.status).toBe("done")
      expect(retryCalls).toBe(1)
      expect(completed.global_attempts).toBe(3)
      expect(completed.nodes.sibling!.attempts).toHaveLength(1)
      expect(completed.nodes.explore!.attempts.map((attempt) => attempt.outcome)).toEqual(["schema_invalid", "passed"])
    } finally { removeProject(project) }
  }, 120_000)
})

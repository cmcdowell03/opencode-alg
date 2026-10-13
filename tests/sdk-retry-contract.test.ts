import { expect, test } from "bun:test"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import type { Client } from "../src/sessions.ts"
import { createRun, hydrateRunFully, loadRun } from "../src/store.ts"
import type { AlgAgent } from "../src/types.ts"
import { executeContext, removeProject, tempProject } from "./helpers.ts"

const implemented = { summary: ["complete"], done: true }
const explored = { query: "inspect", map: [{ path: "src", role: "entry" }] }
const cases: {
  name: string
  agent: Exclude<AlgAgent, "shell">
  parts: unknown[]
  diagnostic: string
  valid: unknown
}[] = [
  { name: "custom-rule rejection", agent: "implementer",
    parts: [{ type: "text", text: JSON.stringify({ summary: ["PRIVATE_SUMMARY_CANARY"], done: false }) }],
    diagnostic: "rule=blockers_required_when_incomplete", valid: implemented },
  { name: "prose-wrapped nested-field rejection with non-text parts", agent: "explorer",
    parts: [{ type: "tool", output: "PRIVATE_TOOL_CANARY" }, { type: "text",
      text: ["Findings:", "```json", JSON.stringify({ ...explored,
        key_hits: [{ path: "src", note: { PRIVATE_VALUE_CANARY: "not a string" } }] }), "```"].join("\n") }],
    diagnostic: "schema: key_hits.0.note: code=invalid_type expected=string", valid: explored },
  { name: "malformed JSON", agent: "implementer",
    parts: [{ type: "text", text: 'PRIVATE_PROSE_CANARY {"summary": }' }],
    diagnostic: "Response parse: invalid_json", valid: implemented },
  { name: "tool-only reply", agent: "implementer",
    parts: [{ type: "tool", output: "PRIVATE_TOOL_CANARY" }],
    diagnostic: "Response parse: empty", valid: implemented },
]

for (const scenario of cases) {
  test(`SDK response -> persisted failure -> fresh retry: ${scenario.name}`, async () => {
    const project = tempProject()
    try {
      const run = createRun({ goal: "synthetic SDK retry", criteria: ["complete"], ownerSessionId: "session-owner",
        projectDirectory: project, graph: { name: "sdk-retry", max_global_attempts: 2, max_concurrency: 1,
          nodes: [{ id: "work", agent: scenario.agent, depends_on: [], loop: { max_attempts: 2, gate: "schema" } }] } })
      const childIds: string[] = [], prompts: string[] = []
      const client = { session: {
        create: async () => {
          const id = `sdk-child-${childIds.length + 1}`
          childIds.push(id)
          return { data: { id }, error: undefined }
        },
        prompt: async (request: { path: { id: string }; body: { parts: { type: string; text: string }[] } }) => {
          expect(request.path.id).toBe(childIds.at(-1)!)
          prompts.push(request.body.parts[0]!.text)
          return { data: { parts: prompts.length === 1 ? scenario.parts : [
            { type: "text", text: JSON.stringify(scenario.valid) },
          ] }, error: undefined }
        },
      } } as unknown as Client
      // No sessionRunner seam: exercise the production response-parts adapter,
      // JSON extraction, validator, session sidecars and durable attempt writes.
      await executeRun(run, { ...executeContext(project), client, maxWaves: 1 })
      const failed = hydrateRunFully(loadRun(project, run.run_id)!)
      expect(failed.nodes.work!.attempts[0]!.outcome).toBe("schema_invalid")
      expect(failed.nodes.work!.attempts[0]!.output).toBeUndefined()
      expect(failed.nodes.work!.last_failures.join("\n")).toContain(scenario.diagnostic)
      expect(JSON.stringify(failed)).not.toContain("PRIVATE_")

      await executeRun(prepareRunForResume(loadRun(project, run.run_id)!), { ...executeContext(project), client })
      const complete = hydrateRunFully(loadRun(project, run.run_id)!)
      expect(complete.status).toBe("done")
      expect(complete.global_attempts).toBe(2)
      expect(childIds).toEqual(["sdk-child-1", "sdk-child-2"])
      expect(complete.nodes.work!.attempts.map((attempt) => attempt.session_id)).toEqual(childIds)
      expect(complete.nodes.work!.attempts.map((attempt) => attempt.outcome)).toEqual(["schema_invalid", "passed"])
      expect(prompts).toHaveLength(2)
      expect(prompts[0]).not.toContain("PRIOR OUTPUT CONTRACT FAILURES")
      expect(prompts[1]).toContain("PRIOR OUTPUT CONTRACT FAILURES")
      expect(prompts[1]).toContain(scenario.diagnostic)
      expect(prompts[1]).toContain("OUTPUT CONTRACT (mandatory)")
      expect(prompts[1]).not.toContain("PRIVATE_")
    } finally { removeProject(project) }
  }, 120_000)
}

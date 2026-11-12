import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { executeRun } from "../src/executor.ts"
import { validateGraph, wireInputs } from "../src/graph.ts"
import { createRun, listOwnedRunEnvelopes, loadRunForOwner } from "../src/store.ts"
import { CODING_COMPACT, getTemplate, listTemplates } from "../src/templates.ts"
import { createAlgTools, withShellGate } from "../src/tools.ts"
import { executeContext, inertClient, removeProject, tempProject } from "./helpers.ts"

const projects: string[] = []
afterEach(() => { for (const project of projects.splice(0)) removeProject(project) })
function fixture() {
  const project = tempProject("alg-plan-guidance-")
  projects.push(project)
  const tools = createAlgTools({ directory: project, worktree: project, client: inertClient() } as never)
  const context = { sessionID: "owner", messageID: "plan", agent: "orchestrator", directory: project,
    worktree: project, abort: new AbortController().signal, metadata: () => {}, ask: async () => {} } as any
  return { project, tools, context }
}
function output(value: unknown): any { return JSON.parse((value as { output: string }).output) }

describe("plan execution intent", () => {
  for (const detail of ["compact", "full"] as const) {
    test(`${detail} live plan directs requested artifacts to bounded execution without executing during planning`, async () => {
      const f = fixture()
      const criteria = ["Write preparation.md", "Stop before creating report.json"]
      const plan = output(await f.tools.alg_plan.execute({ goal: "Create the preparation artifact", criteria, detail }, f.context))
      expect(plan).toMatchObject({ status: "planning", mode: "live", plan_reused: false, template: "coding-diamond" })
      expect(plan.next).toContain("has not executed the requested work")
      expect(plan.next).toContain(`call alg_run with run_id=${plan.run_id} before your final response`)
      expect(plan.next).toContain("bounded max_waves")
      expect(plan.next).toContain("explicit plan-only request")
      expect(plan.next).toContain("per-call filesystem-root approval")
      expect(plan.next).toContain("do not automatically retry")
      const run = loadRunForOwner(f.project, plan.run_id, "owner")!
      expect(run.criteria).toEqual(criteria)
      expect(run.global_attempts).toBe(0)
      expect(Object.values(run.nodes).every((node) => node.status === "pending" && node.attempts.length === 0)).toBe(true)
    })

    test(`${detail} dry plan keeps live execution out of its next action`, async () => {
      const f = fixture()
      const plan = output(await f.tools.alg_plan.execute({ goal: "Dry smoke of a small change", template: "coding-compact", mode: "dry", detail }, f.context))
      expect(plan.error).toBeUndefined()
      expect(plan.next).toContain("This is a dry plan")
      expect(plan.next).toContain("if a dry smoke was requested")
      expect(plan.next).toContain("dry=true")
      expect(plan.next).not.toContain("before your final response")
      expect(loadRunForOwner(f.project, plan.run_id, "owner")!.global_attempts).toBe(0)
    })
  }

  test("explicit plan-only goals remain unexecuted and receive a stop-at-planning exception", async () => {
    const f = fixture()
    const plan = output(await f.tools.alg_plan.execute({ goal: "Plan only: describe a small count fix; do not implement", template: "coding-compact" }, f.context))
    expect(plan.next).toContain("Stop at planning for an explicit plan-only request")
    expect(loadRunForOwner(f.project, plan.run_id, "owner")!.global_attempts).toBe(0)
    // Intent is guidance, not a heuristic that rewrites the user's goal or criteria.
    expect(loadRunForOwner(f.project, plan.run_id, "owner")!.goal).toBe("Plan only: describe a small count fix; do not implement")
  })
})

describe("opt-in coding-compact workflow", () => {
  test("ships one matching, registered, schema-valid graph without changing the default", async () => {
    const f = fixture()
    const shipped = JSON.parse(readFileSync(join(import.meta.dir, "..", "templates", "coding-compact.json"), "utf8"))
    expect(validateGraph(shipped)).toEqual(CODING_COMPACT)
    expect(getTemplate("coding-compact")).toEqual(shipped)
    expect(listTemplates().find((entry) => entry.name === "coding-compact")?.nodes).toBe(2)
    expect(output(await f.tools.alg_templates.execute({}, f.context)).some((entry: any) => entry.name === "coding-compact")).toBe(true)
    expect(f.tools.alg_plan.args.template.parse("coding-compact")).toBe("coding-compact")
    const cloned = getTemplate("coding-compact")
    cloned.nodes[0]!.description = "caller mutation"
    expect(getTemplate("coding-compact").nodes[0]!.description).not.toBe("caller mutation")
  })

  test("preserves original criteria, bounds attempts and keeps the independent checker when a shell gate is supplied", async () => {
    const f = fixture()
    const criteria = ["Count distinct IDs", "Preserve the visible test file"]
    const plan = output(await f.tools.alg_plan.execute({ goal: "Small known count fix", criteria,
      template: "coding-compact", shell_gate: "node --version", mode: "dry" }, f.context))
    expect(plan.error).toBeUndefined()
    const run = loadRunForOwner(f.project, plan.run_id, "owner")!
    expect(run.graph).toMatchObject({ max_global_attempts: 4, max_concurrency: 1 })
    expect(run.graph.nodes.map((node) => node.agent)).toEqual(["implementer", "checker"])
    const [implement, check] = run.graph.nodes
    expect(implement!.loop).toEqual({ max_attempts: 2, gate: "all" })
    expect(implement!.shell_gate?.cmd).toBe("node --version")
    expect(check).toMatchObject({ depends_on: ["implement"], isolated_check: true, feedback_to: "implement",
      inputs: { criteria: "$criteria", claimed: "implement" }, loop: { max_attempts: 2, gate: "schema" } })
    expect(check!.shell_gate).toBeUndefined()
    expect(wireInputs(implement!, run).criteria).toEqual(criteria)
    expect(wireInputs(check!, run).criteria).toEqual(criteria)
    expect(run.criteria).toEqual(criteria)
    expect(run.global_attempts).toBe(0)
    expect(withShellGate(getTemplate("coding-compact"), "node --version").max_global_attempts).toBe(4)
  })

  for (const finalPass of [true, false]) {
    test(`fresh checker feedback stays within the original four-attempt cap (${finalPass ? "repaired" : "rejected"})`, async () => {
      const f = fixture()
      const run = createRun({ goal: "Small known change", criteria: ["Original user requirement"],
        graph: getTemplate("coding-compact"), projectDirectory: f.project, ownerSessionId: "owner" })
      const calls: string[] = []
      let checkCount = 0
      const completed = await executeRun(run, {
        ...executeContext(f.project), parentSessionId: "owner",
        sessionRunner: async (prompt) => {
          calls.push(prompt.agent)
          const session = `fresh-${calls.length}`
          await prompt.onSessionCreated?.(session)
          expect(prompt.userPrompt).toContain("Original user requirement")
          const checker = prompt.agent === "checker"
          if (checker) {
            checkCount++
            expect(prompt.userPrompt).not.toContain("PRIVATE_WORKER_TRANSCRIPT")
          }
          const passed = finalPass && checkCount === 2
          return { session_id: session, text: checker ? "" : "PRIVATE_WORKER_TRANSCRIPT", parsed: checker
            ? { passed, failures: passed ? [] : ["Original requirement remains unmet"], score: passed ? 10 : 2 }
            : { summary: ["Implementation result"], files_touched: [], commands_run: [], risks: [], done: true } }
        },
      })
      expect(calls).toEqual(["implementer", "checker", "implementer", "checker"])
      expect(completed.global_attempts).toBe(4)
      expect(completed.graph.max_global_attempts).toBe(4)
      expect(completed.nodes.implement!.attempts).toHaveLength(2)
      expect(completed.nodes.check!.attempts).toHaveLength(2)
      expect(new Set(Object.values(completed.nodes).flatMap((node) => node.attempts.map((attempt) => attempt.session_id))).size).toBe(4)
      expect(completed.status).toBe(finalPass ? "done" : "failed")
      expect(completed.criteria).toEqual(["Original user requirement"])
    }, 120_000)
  }
})

describe("optional plan preservation inputs", () => {
  for (const detail of ["compact", "full"] as const) {
    test(`${detail} validates project-relative files and requests snapshots without adding criteria`, async () => {
      const f = fixture()
      mkdirSync(join(f.project, "tests"))
      mkdirSync(join(f.project, "nested"))
      writeFileSync(join(f.project, "tests", "visible.cjs"), "unchanged fixture")
      const criteria = ["Preserve tests/visible.cjs"]
      const paths = ["tests/visible.cjs"]
      const plan = output(await f.tools.alg_plan.execute({ goal: "Small change", template: "coding-compact", criteria,
        preserve_paths: paths, detail }, { ...f.context, directory: join(f.project, "nested") }))
      expect(plan.error).toBeUndefined()
      expect(plan.preservation_request).toMatchObject({ node_id: "implement", paths })
      expect(plan.preservation_request.scope).toContain("Planning validates paths only")
      const run = loadRunForOwner(f.project, plan.run_id, "owner")!
      expect(run.graph.nodes[0]!.inputs!.preserve_paths).toBe(JSON.stringify(paths))
      expect(wireInputs(run.graph.nodes[0]!, run).preserve_paths).toEqual(paths)
      expect(run.graph.nodes[1]!.inputs).not.toHaveProperty("preserve_paths")
      expect(run.criteria).toEqual(criteria)
      expect(run.global_attempts).toBe(0)
      expect(readFileSync(join(f.project, "tests", "visible.cjs"), "utf8")).toBe("unchanged fixture")
    })
  }

  test("omission is opt-in and custom graph augmentation retains dependency inputs on only the first implementer", async () => {
    const f = fixture()
    const ordinary = output(await f.tools.alg_plan.execute({ goal: "No preservation requested", template: "coding-compact" }, f.context))
    expect(ordinary).not.toHaveProperty("preservation_request")
    expect(loadRunForOwner(f.project, ordinary.run_id, "owner")!.graph.nodes[0]!.inputs).not.toHaveProperty("preserve_paths")
    writeFileSync(join(f.project, "keep.txt"), "original")
    const graph = { name: "dependency-context", max_global_attempts: 3, max_concurrency: 1, nodes: [
      { id: "research", agent: "researcher", depends_on: [] },
      { id: "first", agent: "implementer", depends_on: ["research"] },
      { id: "second", agent: "implementer", depends_on: ["first"] },
    ] }
    const planned = output(await f.tools.alg_plan.execute({ goal: "Keep existing context", graph_json: JSON.stringify(graph),
      preserve_paths: ["keep.txt"] }, f.context))
    expect(planned.error).toBeUndefined()
    const run = loadRunForOwner(f.project, planned.run_id, "owner")!
    expect(run.graph.nodes[1]!.inputs).toEqual({ research: "research", preserve_paths: '["keep.txt"]' })
    expect(run.graph.nodes[2]!.inputs).toBeUndefined()
    run.nodes.research!.output = { answer: "Existing dependency context" }
    expect(wireInputs(run.graph.nodes[1]!, run).research).toEqual(run.nodes.research!.output)
    expect(run.criteria).toEqual([])
  })

  test("enforces count, path length, normalization, existence and regular files before creating a run", async () => {
    const f = fixture()
    mkdirSync(join(f.project, "directory"))
    writeFileSync(join(f.project, "keep.txt"), "original")
    const invalid = [
      [], ["keep.txt", "keep.txt"], Array(9).fill("keep.txt"), ["a".repeat(513)], [""], ["../keep.txt"], ["./keep.txt"],
      ["/keep.txt"], ["C:/keep.txt"], ["directory\\keep.txt"], ["keep.txt:stream"],
      ["directory//keep.txt"], ["keep.txt\u0000"], ["NUL"], ["missing.txt"], ["directory"],
    ]
    for (const preserve_paths of invalid) {
      const plan = output(await f.tools.alg_plan.execute({ goal: "Invalid preservation input", template: "coding-compact", preserve_paths }, f.context))
      expect(plan.error).toBeString()
    }
    expect(listOwnedRunEnvelopes(f.project, "owner")).toHaveLength(0)
    const longest = ["a".repeat(170), "b".repeat(170), "c".repeat(170)].join("/")
    expect(longest.length).toBe(512)
    expect(f.tools.alg_plan.args.preserve_paths.safeParse([longest]).success).toBe(true)
    expect(f.tools.alg_plan.args.preserve_paths.safeParse([longest + "c"]).success).toBe(false)
    const eight = Array.from({ length: 8 }, (_, i) => `keep-${i}.txt`)
    for (const path of eight) writeFileSync(join(f.project, path), "original")
    const accepted = output(await f.tools.alg_plan.execute({ goal: "Eight explicit files", template: "coding-compact", preserve_paths: eight }, f.context))
    expect(accepted.error).toBeUndefined()
    expect(accepted.preservation_request.paths).toEqual(eight)
  })

  test("rejects a symlink or junction escape even when the target is a regular file", async () => {
    const f = fixture(), outside = tempProject("alg-preserve-outside-")
    projects.push(outside)
    writeFileSync(join(outside, "keep.txt"), "outside")
    symlinkSync(outside, join(f.project, "link"), process.platform === "win32" ? "junction" : "dir")
    const plan = output(await f.tools.alg_plan.execute({ goal: "Invalid escaped file", template: "coding-compact",
      preserve_paths: ["link/keep.txt"] }, f.context))
    expect(plan.error).toContain("escapes")
    expect(listOwnedRunEnvelopes(f.project, "owner")).toHaveLength(0)
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("outside")
  })

  test("rejects graphs without implementers and preserves the revision argument boundary", async () => {
    const f = fixture()
    writeFileSync(join(f.project, "keep.txt"), "original")
    const absent = output(await f.tools.alg_plan.execute({ goal: "Research only", template: "research-diamond",
      preserve_paths: ["keep.txt"] }, f.context))
    expect(absent.error).toContain("no implementer node")
    const planned = output(await f.tools.alg_plan.execute({ goal: "Original plan", template: "coding-compact" }, f.context))
    const revision = output(await f.tools.alg_plan.execute({ revise_run_id: planned.run_id,
      expected_graph_sha256: planned.graph_sha256, revision_reason: "Attempt to add a new plan argument",
      graph_json: JSON.stringify(getTemplate("coding-compact")), preserve_paths: ["keep.txt"] }, f.context))
    expect(revision.error).toContain("graph revision changes only graph_json")
    expect(loadRunForOwner(f.project, planned.run_id, "owner")!.graph.nodes[0]!.inputs).not.toHaveProperty("preserve_paths")
  })
})

/**
 * Offline smoke test — graph validate + dry execute (no OpenCode server).
 * Run: bun run scripts/smoke.ts
 */
import { validateGraph } from "../src/graph.ts"
import { getTemplate, listTemplates } from "../src/templates.ts"
import { parseAndValidate } from "../src/schemas.ts"
import { createRun, loadRun, runDir } from "../src/store.ts"
import { executeRun } from "../src/executor.ts"
import { extractJson } from "../src/sessions.ts"
import { mkdtempSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

console.log("templates:", listTemplates())

const g = getTemplate("coding-diamond")
validateGraph(g)
console.log("coding-diamond: valid,", g.nodes.length, "nodes")

const cycle = structuredClone(g)
cycle.nodes[0]!.depends_on = ["check"]
let threw = false
try {
  validateGraph(cycle)
} catch {
  threw = true
}
assert(threw, "expected cycle detection")

const v = parseAndValidate("checker", {
  passed: true,
  failures: [],
  score: 9,
})
assert(v.ok, "checker schema")

const parsed = extractJson('  ```json\n{"passed":false,"failures":["x"],"score":2}\n```  ')
assert((parsed as { score: number }).score === 2, "extractJson")

const dir = mkdtempSync(join(tmpdir(), "alg-smoke-"))
const run = createRun({
  goal: "Smoke test rate limit",
  criteria: ["schema valid", "dry run completes"],
  graph: getTemplate("coding-diamond"),
  projectDirectory: dir,
  ownerSessionId: "sess-smoke",
  mode: "dry",
})

const mockClient = {
  session: {
    create: async () => ({ data: { id: "never" } }),
    prompt: async () => ({ data: { parts: [] } }),
  },
  app: { log: async () => true },
} as never

const updated = await executeRun(run, {
  client: mockClient,
  parentSessionId: "sess-smoke",
  directory: dir,
  worktree: dir,
  toolContext: {
    ask: async () => {},
    abort: new AbortController().signal,
  },
  dry: true,
  onEvent: (m) => console.log(" ", m),
})

assert(updated.status === "done", `expected done, got ${updated.status}`)
assert(updated.nodes.explore!.status === "done", "explore done")
assert(updated.nodes.check!.status === "done", "check done")

const reloaded = loadRun(dir, run.run_id)
assert(reloaded?.status === "done", "persist/load")
console.log("run path:", runDir(dir, run.run_id))
console.log("SMOKE OK")

import { describe, expect, test } from "bun:test"
import { chooseSyntheticResponse, completedInvestigationOutputs, PERSISTED_REFERENCE, PERSISTED_RESULT } from "../scripts/test-v1-headless.ts"

describe("headless synthetic provider contract", () => {
  test("query evidence excludes admission but retains failed query outputs", () => {
    const part = (action: string, output: unknown) => ({ type: "tool", tool: "alg_investigation",
      state: { status: "completed", input: { request: { action } }, output: JSON.stringify(output) } })
    const outputs = completedInvestigationOutputs([{ parts: [
      part("admit", { status: "reserved", work_key: "a".repeat(64) }),
      part("query", { error: "invalid_request" }),
      part("query", { status: "reusable", work_key: "a".repeat(64), result: { manifest_ref: "m", digest: "d" } }),
    ] }])
    expect(outputs).toHaveLength(2)
    expect(outputs[0]?.status).toBe("")
    expect(outputs[1]?.status).toBe("reusable")
  })
  test("drives the host through workspace, investigation plan, and query tools", () => {
    const context = chooseSyntheticResponse("initial", 0, { tools: [] })
    const plan = chooseSyntheticResponse("initial", 1, { tools: [] })
    const investigation = chooseSyntheticResponse("initial", 2, { tools: [] })
    expect(context).toMatchObject({ kind: "tool", name: "alg_context_status", args: { operation: "headless-smoke" } })
    expect(plan).toMatchObject({ kind: "tool", name: "alg_plan", args: { template: "data-investigation" } })
    expect(investigation).toMatchObject({ kind: "tool", name: "alg_investigation", args: { request: { action: "admit" } } })
    const workKey = "a".repeat(64)
    const execute = chooseSyntheticResponse("initial", 3, { messages: [{ role: "tool", content: JSON.stringify({ work_key: workKey }) }] })
    expect(execute).toMatchObject({ args: { request: { action: "query", work_key: workKey } } })
  })

  test("compaction only repeats references observed in the host request", () => {
    const incomplete = chooseSyntheticResponse("compaction", 0, { messages: [{ role: "user", content: PERSISTED_REFERENCE }] })
    const complete = chooseSyntheticResponse("compaction", 0, { messages: [{ role: "assistant", content: `${PERSISTED_REFERENCE} ${PERSISTED_RESULT}` }] })
    expect(incomplete.text).toBe("COMPACTION_INPUT_MISSING_INITIAL_EVIDENCE")
    expect(complete.text).toBe(`Preserved ${PERSISTED_REFERENCE} and ${PERSISTED_RESULT}`)
  })

  test("follow-up claims recovery only when both persisted markers are in context", () => {
    const missing = chooseSyntheticResponse("followup", 2, { messages: [{ role: "assistant", content: `${PERSISTED_REFERENCE} ${PERSISTED_RESULT}` }, { role: "tool", content: PERSISTED_REFERENCE }] })
    const recovered = chooseSyntheticResponse("followup", 2, { messages: [{ role: "assistant", content: `${PERSISTED_REFERENCE} ${PERSISTED_RESULT}` }, { role: "tool", content: `${PERSISTED_REFERENCE} ${PERSISTED_RESULT}` }] })
    expect(missing.text).toBe("FOLLOWUP_QUERY_OR_CONTEXT_MISSING_PERSISTED_EVIDENCE")
    expect(recovered.text).toBe(`Recovered ${PERSISTED_REFERENCE} ${PERSISTED_RESULT}`)
  })
})


test("isolated host dependency setup uses the pinned SDK and refuses an existing target", async () => {
  const { seedVerificationHostDependencies } = await import("../scripts/verification-host-dependencies.ts")
  const { tempProject, removeProject } = await import("./helpers.ts")
  const { existsSync, readFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const root = tempProject("alg-host-deps-")
  try {
    const { fileURLToPath } = await import("node:url")
    seedVerificationHostDependencies(root, fileURLToPath(new URL("..", import.meta.url)))
    expect(existsSync(join(root, "node_modules", "@opencode-ai", "plugin", "package.json"))).toBe(true)
    const saved = readFileSync(join(root,"package.json"), "utf8")
    expect(() => seedVerificationHostDependencies(root, root)).toThrow("fresh")
    expect(readFileSync(join(root,"package.json"), "utf8")).toBe(saved)
  } finally { removeProject(root) }
})

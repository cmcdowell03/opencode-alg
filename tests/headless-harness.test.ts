import { describe, expect, test } from "bun:test"
import { chooseSyntheticResponse, PERSISTED_REFERENCE, PERSISTED_RESULT } from "../scripts/test-v1-headless.ts"

describe("headless synthetic provider contract", () => {
  test("drives the host through workspace, investigation plan, and query tools", () => {
    const context = chooseSyntheticResponse("initial", 0, { tools: [] })
    const plan = chooseSyntheticResponse("initial", 1, { tools: [] })
    const investigation = chooseSyntheticResponse("initial", 2, { tools: [] })
    expect(context).toMatchObject({ kind: "tool", name: "alg_context_status", args: { operation: "headless-smoke" } })
    expect(plan).toMatchObject({ kind: "tool", name: "alg_plan", args: { template: "data-investigation" } })
    expect(investigation).toMatchObject({ kind: "tool", name: "alg_investigation", args: { action: "query" } })
  })

  test("compaction only repeats references observed in the host request", () => {
    const incomplete = chooseSyntheticResponse("compaction", 0, { messages: [{ role: "user", content: PERSISTED_REFERENCE }] })
    const complete = chooseSyntheticResponse("compaction", 0, { messages: [{ role: "assistant", content: `${PERSISTED_REFERENCE} ${PERSISTED_RESULT}` }] })
    expect(incomplete.text).toBe("COMPACTION_INPUT_MISSING_INITIAL_EVIDENCE")
    expect(complete.text).toBe(`Preserved ${PERSISTED_REFERENCE} and ${PERSISTED_RESULT}`)
  })

  test("follow-up claims recovery only when both persisted markers are in context", () => {
    const missing = chooseSyntheticResponse("followup", 1, { messages: [{ role: "assistant", content: `${PERSISTED_REFERENCE} ${PERSISTED_RESULT}` }, { role: "tool", content: PERSISTED_REFERENCE }] })
    const recovered = chooseSyntheticResponse("followup", 1, { messages: [{ role: "assistant", content: `${PERSISTED_REFERENCE} ${PERSISTED_RESULT}` }, { role: "tool", content: `${PERSISTED_REFERENCE} ${PERSISTED_RESULT}` }] })
    expect(missing.text).toBe("FOLLOWUP_QUERY_OR_CONTEXT_MISSING_PERSISTED_EVIDENCE")
    expect(recovered.text).toBe(`Recovered ${PERSISTED_REFERENCE} ${PERSISTED_RESULT}`)
  })
})

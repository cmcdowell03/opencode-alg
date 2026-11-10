import { describe, expect, test } from "bun:test"
import { initNodeStates, readyNodes, validateGraph, wireInputs } from "../src/graph.ts"
import { DATA_INVESTIGATION, getTemplate, listTemplates } from "../src/templates.ts"
import type { RunState } from "../src/types.ts"

describe("data-investigation fixed V1 template", () => {
  test("is registered, cloned, expanded, and valid under the existing graph schema", () => {
    const graph = getTemplate("data-investigation")
    expect(listTemplates().map(({ name }) => name)).toContain("data-investigation")
    expect(validateGraph(graph)).toEqual(DATA_INVESTIGATION)
    expect(graph).not.toBe(DATA_INVESTIGATION)
    graph.nodes[0]!.description = "caller mutation"
    expect(getTemplate("data-investigation").nodes[0]!.description).not.toBe("caller mutation")

    const states = initNodeStates(DATA_INVESTIGATION)
    const run = { graph: DATA_INVESTIGATION, nodes: states, goal: "Explain the excursion", criteria: "Use source-backed evidence" } as unknown as RunState
    expect(readyNodes(run).map(({ id }) => id)).toEqual(["discover"])
    const discoverInputs = wireInputs(DATA_INVESTIGATION.nodes[0]!, run)
    expect(discoverInputs.goal).toBe("Explain the excursion")
    expect(String(discoverInputs.investigation_policy)).toContain("alg_investigation actions query, status, note, and hypothesis")
    run.nodes.discover!.output = { answer: "Scoped sources", evidence: [], constraints: [], options: [], acceptance_criteria: ["Pin source versions"], risks: [] }
    const processInputs = wireInputs(DATA_INVESTIGATION.nodes[1]!, run)
    expect(processInputs.discovery).toEqual(run.nodes.discover!.output)
    expect(String(processInputs.branch)).toContain("process branch")
  })

  test("has exactly three bounded specialist branches and the required reconcile-confirm-check chain", () => {
    const graph = validateGraph(getTemplate("data-investigation"))
    const byId = Object.fromEntries(graph.nodes.map((node) => [node.id, node]))
    expect(graph.nodes.map(({ id }) => id)).toEqual([
      "discover", "process", "equipment", "metrology", "reconcile", "confirm", "check",
    ])
    expect(["process", "equipment", "metrology"].map((id) => byId[id]!.depends_on)).toEqual([
      ["discover"], ["discover"], ["discover"],
    ])
    expect(byId.reconcile!.depends_on).toEqual(["process", "equipment", "metrology"])
    expect(byId.confirm!.depends_on).toEqual(["reconcile"])
    expect(byId.confirm!.id).toBe("confirm")
    expect(byId.check!.depends_on).toEqual(["confirm"])
    expect(byId.check!.agent).toBe("checker")
    expect(byId.check!.isolated_check).toBe(true)
    expect(byId.check!.feedback_to).toBe("confirm")
    expect(graph.nodes).toHaveLength(7)
  })

  test("bounds topology and uses only existing roles and managed investigation actions", () => {
    const graph = getTemplate("data-investigation")
    expect(graph.max_concurrency).toBeLessThanOrEqual(3)
    expect(graph.max_global_attempts).toBe(14)
    expect(graph.nodes.every((node) => (node.loop?.max_attempts ?? 1) <= 2)).toBe(true)
    expect(new Set(graph.nodes.map(({ agent }) => agent))).toEqual(new Set(["explorer", "researcher", "checker"]))
    expect(graph.nodes.some(({ agent }) => agent.includes("orchestrator"))).toBe(false)

    const instructions = JSON.stringify(graph).toLowerCase()
    for (const action of ["alg_investigation", "query", "status", "note", "hypothesis"]) expect(instructions).toContain(action)
    for (const evidenceTerm of ["source versions", "coverage", "negative findings", "unknowns", "evidence references"]) {
      expect(instructions).toContain(evidenceTerm)
    }
    expect(instructions).toContain("causal")
    expect(instructions).toContain("inherited criteria")
    expect(instructions).toContain("write freeform/synthetic sql")
    expect(instructions).toContain("alg-v1-phase-one-investigation-plan.md")
    expect(instructions).toContain("alg-v1-large-data-investigation-design.md")
  })
})

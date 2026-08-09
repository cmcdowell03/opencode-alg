import type { GraphDef } from "./types.ts"

/** Built-in graphs. Prefer real data deps; serial implement by default. */

export const CODING_DIAMOND: GraphDef = {
  name: "coding-diamond",
  description:
    "Explore → research → implement (with test loop) → fresh-child checker",
  max_global_attempts: 13,
  max_concurrency: 4,
  nodes: [
    {
      id: "explore",
      agent: "explorer",
      depends_on: [],
      description: "Map relevant files and symbols",
      inputs: { goal: "$goal" },
    },
    {
      id: "research",
      agent: "researcher",
      depends_on: ["explore"],
      description: "Constraints + hard acceptance criteria",
      inputs: {
        goal: "$goal",
        explore: "explore",
      },
      loop: { max_attempts: 2, gate: "schema" },
    },
    {
      id: "implement",
      agent: "implementer",
      depends_on: ["research"],
      description: "Code + tests for the goal",
      inputs: {
        goal: "$goal",
        criteria: "$criteria",
        constraints: "research.constraints",
        acceptance_criteria: "research.acceptance_criteria",
      },
      loop: { max_attempts: 5, gate: "schema" },
      // shell_gate left optional; set via alg_plan or project config
    },
    {
      id: "check",
      agent: "checker",
      depends_on: ["implement"],
      description: "Fresh-child quality gate — bounded criteria + claimed-output task payload",
      isolated_check: true,
      feedback_to: "implement",
      inputs: {
        criteria: "$criteria",
        claimed: "implement",
      },
      loop: { max_attempts: 5, gate: "schema" },
    },
  ],
}

export const RESEARCH_DIAMOND: GraphDef = {
  name: "research-diamond",
  description: "Parallel explore lanes → synthesis research → fresh-child checker",
  max_global_attempts: 6,
  max_concurrency: 4,
  nodes: [
    {
      id: "explore_a",
      agent: "explorer",
      depends_on: [],
      description: "Map surface A",
      inputs: { goal: "$goal", lane: "\"A\"" },
    },
    {
      id: "explore_b",
      agent: "explorer",
      depends_on: [],
      description: "Map surface B",
      inputs: { goal: "$goal", lane: "\"B\"" },
    },
    {
      id: "research",
      agent: "researcher",
      depends_on: ["explore_a", "explore_b"],
      description: "Synthesize findings + criteria",
      inputs: {
        goal: "$goal",
        explore_a: "explore_a",
        explore_b: "explore_b",
      },
      loop: { max_attempts: 2, gate: "schema" },
    },
    {
      id: "check",
      agent: "checker",
      depends_on: ["research"],
      isolated_check: true,
      feedback_to: "research",
      inputs: {
        criteria: "$criteria",
        claimed: "research",
      },
      loop: { max_attempts: 2, gate: "schema" },
    },
  ],
}

export const TEMPLATES: Record<string, GraphDef> = {
  "coding-diamond": CODING_DIAMOND,
  "research-diamond": RESEARCH_DIAMOND,
}

export function listTemplates(): Array<{ name: string; description?: string; nodes: number }> {
  return Object.values(TEMPLATES).map((g) => ({
    name: g.name,
    description: g.description,
    nodes: g.nodes.length,
  }))
}

export function getTemplate(name: string): GraphDef {
  const g = TEMPLATES[name]
  if (!g) {
    throw new Error(
      `Unknown template "${name}". Available: ${Object.keys(TEMPLATES).join(", ")}`,
    )
  }
  // deep clone so mutations don't taint template
  return structuredClone(g)
}

import type { GraphDef } from "./types.ts"

/** Built-in graphs. Prefer real data deps; serial implement by default. */

export const CODING_DIAMOND: GraphDef = {
  name: "coding-diamond",
  description:
    "Explore → research → implement (with test loop) → fresh-child checker",
  max_global_attempts: 14,
  max_concurrency: 4,
  nodes: [
    {
      id: "explore",
      agent: "explorer",
      depends_on: [],
      description: "Map relevant files and symbols",
      inputs: { goal: "$goal" },
      loop: { max_attempts: 2, gate: "schema" },
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
  max_global_attempts: 8,
  max_concurrency: 4,
  nodes: [
    {
      id: "explore_a",
      agent: "explorer",
      depends_on: [],
      description: "Map surface A",
      inputs: { goal: "$goal", lane: "\"A\"" },
      loop: { max_attempts: 2, gate: "schema" },
    },
    {
      id: "explore_b",
      agent: "explorer",
      depends_on: [],
      description: "Map surface B",
      inputs: { goal: "$goal", lane: "\"B\"" },
      loop: { max_attempts: 2, gate: "schema" },
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

export const SPREADSHEET_DIAMOND: GraphDef = {
  name: "spreadsheet-diamond",
  description: "Plan a staged-copy spreadsheet change → implement through alg_excel → deterministic validation → fresh-child checker",
  max_global_attempts: 10,
  max_concurrency: 2,
  nodes: [
    {
      id: "research",
      agent: "researcher",
      depends_on: [],
      description: "Plan changes for a relative staged .xlsx copy; never operate on or overwrite the source workbook",
      inputs: {
        goal: "$goal",
        spreadsheet_policy: "\"Use only relative staged .xlsx copies through alg_excel. Never overwrite the source. openpyxl stores formulas but does not recalculate them.\"",
      },
      loop: { max_attempts: 2, gate: "schema" },
    },
    {
      id: "implement",
      agent: "implementer",
      depends_on: ["research"],
      description: "Edit only the staged relative .xlsx through alg_excel, then run the user-supplied deterministic workbook validator shell gate",
      inputs: {
        goal: "$goal",
        criteria: "$criteria",
        plan: "research",
        spreadsheet_policy: "\"Do not use absolute workbook arguments. Do not overwrite the source. Formulas are not recalculated; report that limitation.\"",
      },
      loop: { max_attempts: 4, gate: "schema" },
      // Optional at load; alg_plan injects the caller's validator command.
    },
    {
      id: "check",
      agent: "checker",
      depends_on: ["implement"],
      description: "Fresh-child review of the staged-copy result and deterministic validator evidence",
      isolated_check: true,
      feedback_to: "implement",
      inputs: { criteria: "$criteria", claimed: "implement" },
      loop: { max_attempts: 4, gate: "schema" },
    },
  ],
}

const INVESTIGATION_TOOL_POLICY = `Use only the managed alg_investigation actions query, status, and reconcile. Check status before proposing more work. Submit a typed request with action query and only the work_key of a parent-admitted order assigned to this graph node; the host ledger enforces the shared cost and concurrency limits. If no assigned order exists, report the missing prerequisite. Returned manifest metadata is not the result contents; without a qualified reader or supplied evidence, report that analysis is blocked. Return evidence references, exact source versions, coverage, negative findings, contradictions, unknowns, and proposed hypothesis changes in your existing typed node output. Only the parent orchestrator reconciles these findings into shared checkpoint notes and hypotheses. Never call a data service directly, invent tool schemas or table names, or write freeform/synthetic SQL. Treat missing capability or coverage as unknown. Preserve the original criteria and make conservative causal claims; correlation alone does not establish cause.`

const INVESTIGATION_DISCOVERY = `${INVESTIGATION_TOOL_POLICY} Establish the incident scope from the goal and inherited criteria. Use status to inspect the ledger and rely on approved source/map details supplied in context plus already admitted work orders. Identify only available candidate sources, source-version/identity gaps, coverage limits, and the next bounded question. If source or capability details are absent, record that gap rather than inventing a query. Follow the fixed graph: report next as researcher when the schema asks, and do not request another node, implementer, or subagent. Do not assume a catalog, source, join, SQL dialect, or query capability that the managed route has not exposed.`

function investigationBranch(branch: "process" | "equipment" | "metrology"): string {
  const purpose = {
    process: "Trace process route, rework, recipe/exposure windows, and material-batch alternatives for affected and comparison cohorts.",
    equipment: "Compare bounded equipment sensor, alarm, maintenance, clean, and recipe-change windows; distinguish event time from ingestion time where available.",
    metrology: "Check inspection coverage, classification/calibration revisions, missingness, duplicate ingestion, and pipeline/transformation changes that could explain the observed signal.",
  }[branch]
  return `${INVESTIGATION_TOOL_POLICY} Work only the ${branch} branch. ${purpose} Use discovered sources and already admitted work orders, retain source versions and coverage, and report scoped negative findings and unresolved identity/join issues. Return no causal assertion beyond the evidence.`
}

const INVESTIGATION_RECONCILE = `${INVESTIGATION_TOOL_POLICY} Reconcile the process, equipment, and metrology branch evidence. Preserve source references and versions, common-source dependence, contradictions, negative findings, coverage gaps, and unknowns. Propose hypothesis updates with both supporting and refuting evidence in the existing node output. Select at most the predefined bounded confirmatory question that best distinguishes surviving alternatives under the inherited criteria and remaining host-ledger budget. Do not spawn branches or rewrite the graph.`

const INVESTIGATION_CONFIRM = `${INVESTIGATION_TOOL_POLICY} Execute only the bounded confirmatory work order selected at reconciliation and admitted by the host. The parent executor controls the required operator engineer-review checkpoint before this node becomes eligible; do not claim review occurred unless its result is supplied. Record the admitted query, source versions, result references, coverage, and any failed or indeterminate check. Preserve uncertainty and stop if the work order, source identity, permission, or budget is unavailable.`

const INVESTIGATION_CHECK = `${INVESTIGATION_TOOL_POLICY} Adversarially review the reconciled and confirmatory evidence against the inherited criteria. Check evidence references, source versions, coverage, negative findings, contradictions, missing alternatives, and whether the conclusion overstates causality. Accept an honestly unresolved or blocked analytical conclusion when evidence is insufficient; do not convert DAG completion into a causal finding.`

/** Fixed V1 investigation DAG. Engineer-review enforcement belongs to the parent executor before `confirm`. */
export const DATA_INVESTIGATION: GraphDef = {
  name: "data-investigation",
  description: "Fixed bounded data investigation: discover → process/equipment/metrology → reconcile → confirm → independent check (Phase 1b; see alg-v1-phase-one-investigation-plan.md and alg-v1-large-data-investigation-design.md)",
  max_global_attempts: 14,
  max_concurrency: 3,
  nodes: [
    {
      id: "discover", agent: "explorer", depends_on: [],
      description: "Scope the incident and discover available sources, map gaps, and bounded work orders",
      inputs: { goal: "$goal", criteria: "$criteria", investigation_policy: JSON.stringify(INVESTIGATION_DISCOVERY) },
      loop: { max_attempts: 2, gate: "schema" },
    },
    {
      id: "process", agent: "researcher", depends_on: ["discover"],
      description: "Investigate process route, rework, exposure windows, and material alternatives",
      inputs: { goal: "$goal", criteria: "$criteria", discovery: "discover", branch: JSON.stringify(investigationBranch("process")) },
      loop: { max_attempts: 2, gate: "schema" },
    },
    {
      id: "equipment", agent: "researcher", depends_on: ["discover"],
      description: "Investigate bounded equipment, sensor, alarm, maintenance, and event timelines",
      inputs: { goal: "$goal", criteria: "$criteria", discovery: "discover", branch: JSON.stringify(investigationBranch("equipment")) },
      loop: { max_attempts: 2, gate: "schema" },
    },
    {
      id: "metrology", agent: "researcher", depends_on: ["discover"],
      description: "Investigate metrology coverage, measurement changes, and pipeline alternatives",
      inputs: { goal: "$goal", criteria: "$criteria", discovery: "discover", branch: JSON.stringify(investigationBranch("metrology")) },
      loop: { max_attempts: 2, gate: "schema" },
    },
    {
      id: "reconcile", agent: "researcher", depends_on: ["process", "equipment", "metrology"],
      description: "Reconcile source-backed findings, alternatives, contradictions, and coverage before confirmation",
      inputs: { goal: "$goal", criteria: "$criteria", process: "process", equipment: "equipment", metrology: "metrology",
        reconciliation_policy: JSON.stringify(INVESTIGATION_RECONCILE) },
      loop: { max_attempts: 2, gate: "schema" },
    },
    {
      id: "confirm", agent: "researcher", depends_on: ["reconcile"],
      description: "Run the admitted bounded discriminating check after parent-enforced engineer review",
      inputs: { goal: "$goal", criteria: "$criteria", reconciled: "reconcile", confirmation_policy: JSON.stringify(INVESTIGATION_CONFIRM) },
      loop: { max_attempts: 2, gate: "schema" },
    },
    {
      id: "check", agent: "checker", depends_on: ["confirm"], isolated_check: true, feedback_to: "confirm",
      description: "Fresh-child check of the evidence chain, uncertainty, and bounded causal claims",
      inputs: { criteria: "$criteria", claimed: "confirm", reconciliation: "reconcile",
        review_policy: JSON.stringify(INVESTIGATION_CHECK) },
      loop: { max_attempts: 2, gate: "schema" },
    },
  ],
}

export const TEMPLATES: Record<string, GraphDef> = {
  "coding-diamond": CODING_DIAMOND,
  "research-diamond": RESEARCH_DIAMOND,
  "spreadsheet-diamond": SPREADSHEET_DIAMOND,
  "data-investigation": DATA_INVESTIGATION,
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

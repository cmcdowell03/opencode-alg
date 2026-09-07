/** Evidence-backed incident history; this API never executes a remediation. */
import { z } from "zod"
import { isSafeId } from "./paths.ts"
import { appendExperience, experienceHash, listExperience, loadExperience, withExperienceOperation, type Experience } from "./experience.ts"

export const IncidentState = z.enum(["opened", "triaged", "investigating", "cause-identified", "remediation-planned", "remediating", "verifying", "resolved", "blocked", "reopened"])
type State = z.infer<typeof IncidentState>
const transitions: Record<State, readonly State[]> = {
  opened: ["triaged", "blocked"], triaged: ["investigating", "blocked"],
  investigating: ["investigating", "cause-identified", "blocked"],
  "cause-identified": ["investigating", "remediation-planned", "blocked"],
  "remediation-planned": ["remediating", "investigating", "blocked"],
  remediating: ["verifying", "blocked"], verifying: ["resolved", "reopened", "blocked"],
  resolved: ["reopened"], blocked: ["reopened"], reopened: ["triaged", "investigating", "blocked"],
}

export function incidentHistory(project: string, incidentId: string): Experience[] {
  if (!isSafeId(incidentId)) throw new Error("unsafe incident ID")
  const rows = listExperience(project).filter((e) => e.kind === "incident" && e.source.id === incidentId)
    .sort((a, b) => (a.metrics.revision ?? -1) - (b.metrics.revision ?? -1))
  rows.forEach((row, index) => {
    IncidentState.parse(row.source.type.replace(/^incident-/, ""))
    if (row.metrics.revision !== index + 1 || (index > 0 && !row.relations.some((r) => r.kind === "supersedes" && r.id === rows[index - 1]!.id))) {
      throw new Error("incident has a fork or missing revision")
    }
  })
  return rows
}

export const IncidentChangeSchema = z.object({
  incident_id: z.string().refine(isSafeId),
  expected_revision: z.number().int().nonnegative(),
  state: IncidentState,
  summary: z.string().min(1).max(2000),
  observed_at: z.iso.datetime({ offset: true }),
  evidence: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(32),
  // Exact prior plan digest, not a generic yes/no; invocation intent, not human authentication.
  approved_plan: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  remediation: z.object({
    action: z.string().regex(/^[a-f0-9]{64}$/), rollback: z.string().regex(/^[a-f0-9]{64}$/), verification: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().optional(),
}).strict()

export function changeIncident(project: string, raw: unknown): Experience {
  const change = IncidentChangeSchema.parse(raw)
  return withExperienceOperation(project, "incidents", () => {
    const history = incidentHistory(project, change.incident_id)
    const previous = history.at(-1)
    const priorState = previous ? IncidentState.parse(previous.source.type.replace(/^incident-/, "")) : undefined
    if (change.expected_revision !== history.length) throw new Error("incident revision conflict")
    if ((!priorState && change.state !== "opened") || (priorState && !transitions[priorState].includes(change.state))) {
      throw new Error("invalid incident transition")
    }
    const evidence = change.evidence.map((id) => loadExperience(project, id))
    if (new Set(change.evidence).size !== change.evidence.length) throw new Error("duplicate incident evidence")
    if (change.remediation && change.state !== "remediation-planned") throw new Error("remediation details belong only to the planning transition")
    if (change.approved_plan && change.state !== "remediating") throw new Error("plan confirmation belongs only to remediation")
    if (change.state === "cause-identified" && !evidence.some((e) => e.kind === "observation" && e.status === "observed")) {
      throw new Error("cause identification requires an observed diagnostic, not only an inference")
    }
    if (change.state === "remediation-planned") {
      if (!change.remediation || new Set(Object.values(change.remediation)).size !== 3) throw new Error("remediation plan requires distinct action, rollback and verification proposals")
      for (const role of ["action", "rollback", "verification"] as const) {
        const step = loadExperience(project, change.remediation[role])
        if (step.kind !== "action" || step.status !== "inferred" || step.group !== change.incident_id || step.source.type !== `${role}-proposal`) throw new Error(`invalid ${role} proposal for this incident`)
        if (!evidence.some((item) => item.id === step.id)) evidence.push(step)
      }
    }
    if (change.state === "remediating" && change.approved_plan !== previous?.id) {
      throw new Error("remediation requires confirmation of the exact current plan")
    }
    if (change.state === "resolved") {
      const remediation = [...history].reverse().find((e) => e.source.type === "incident-remediating")
      const used = new Set(history.filter((e) => e !== previous).flatMap((e) => e.relations.map((r) => r.id)))
      if (!remediation || !evidence.some((e) => e.kind === "outcome" && e.status === "success" &&
        e.group === change.incident_id && Date.parse(e.observed_at) <= Date.parse(change.observed_at) &&
        Date.parse(e.observed_at) > Date.parse(remediation.observed_at) && !used.has(e.id) &&
        e.relations.some((r) => r.kind === "tests" && r.id === remediation.id))) {
        throw new Error("resolution requires a fresh successful verification linked to this remediation")
      }
    }
    if (previous && Date.parse(change.observed_at) < Date.parse(previous.observed_at)) throw new Error("incident time moved backwards")
    return appendExperience(project, {
      kind: "incident", source: { type: `incident-${change.state}`, id: change.incident_id, sha256: experienceHash(change) },
      observed_at: change.observed_at, retention: "operational", status: change.state === "resolved" ? "success" : "indeterminate",
      summary: change.summary, skill_version: null, group: change.incident_id,
      relations: [...(previous ? [{ kind: "supersedes" as const, id: previous.id }] : []), ...evidence.map(({ id }) => ({ kind: "supports" as const, id }))],
      metrics: { revision: history.length + 1 },
    })
  })
}

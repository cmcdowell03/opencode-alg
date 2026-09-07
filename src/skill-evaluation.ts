/** Paired observed outcomes, not reviewer scores, drive this explicit evaluation gate. */
import { z } from "zod"
import { appendExperience, experienceHash, loadExperience, type Experience } from "./experience.ts"
import { isSafeId } from "./paths.ts"

const Hash = z.string().regex(/^[a-f0-9]{64}$/)
export const EvaluationRequestSchema = z.object({
  id: z.string().refine(isSafeId), observed_at: z.iso.datetime({ offset: true }),
  candidate: Hash, baseline: Hash,
  environment_sha256: Hash, model: z.string().refine(isSafeId),
  training: z.array(Hash).max(1000),
  pairs: z.array(z.object({ baseline: Hash, candidate: Hash }).strict()).min(1).max(30),
}).strict()

export function evaluateSkill(project: string, raw: unknown) {
  const request = EvaluationRequestSchema.parse(raw)
  if (request.candidate === request.baseline) throw new Error("candidate and baseline must be distinct versions")
  if (new Set(request.training).size !== request.training.length) throw new Error("duplicate training evidence")
  const lineage = (ids: string[]): Experience[] => {
    const visited = new Map<string, Experience>(), pending = [...ids]
    while (pending.length) {
      const id = pending.pop()!
      if (visited.has(id)) continue
      if (visited.size >= 1000) throw new Error("evaluation lineage exceeds bound")
      const row = loadExperience(project, id)
      visited.set(id, row)
      // Shared model/skill metadata is not task evidence. Follow evidence lineage only.
      for (const relation of row.relations) {
        if (!["derived_from", "supports", "refutes", "tests", "supersedes"].includes(relation.kind)) continue
        const parent = loadExperience(project, relation.id)
        if (parent.kind !== "skill_version" && parent.source.type !== "evaluation-environment") pending.push(parent.id)
      }
    }
    return [...visited.values()]
  }
  const training = lineage(request.training)
  const trainingGroups = new Set(training.map((e) => e.group))
  const trainingSources = new Set(training.map((e) => e.source.sha256))
  const seen = new Set<string>()
  const pairs = request.pairs.map((pair) => {
    const baseline = loadExperience(project, pair.baseline)
    const candidate = loadExperience(project, pair.candidate)
    for (const [row, version] of [[baseline, request.baseline], [candidate, request.candidate]] as const) {
      if (row.kind !== "outcome" || row.skill_version !== version || !["success", "failure", "abstained", "indeterminate"].includes(row.status)) {
        throw new Error("evaluation requires observed outcomes with the exact applied skill version")
      }
      if (!row.relations.some((r) => {
        const skill = loadExperience(project, r.id)
        return r.kind === "applied" && skill.kind === "skill_version" && skill.source.sha256 === version
      })) {
        throw new Error("outcome lacks applied skill provenance")
      }
      if (lineage([row.id]).some((item) => trainingGroups.has(item.group) || trainingSources.has(item.source.sha256))) throw new Error("training/evaluation leakage")
      if (Date.parse(row.observed_at) > Date.parse(request.observed_at)) throw new Error("evaluation predates an outcome")
      if (row.metrics.model_cost !== null && row.metrics.model_cost !== undefined && row.metrics.model_cost < 0) throw new Error("model cost cannot be negative")
      if (!row.relations.some((r) => {
        const artifact = loadExperience(project, r.id)
        return r.kind === "derived_from" && artifact.kind === "source_artifact" &&
          artifact.source.type === "evaluation-environment" && artifact.source.id === request.model && artifact.source.sha256 === request.environment_sha256
      })) throw new Error("outcome lacks the declared model/environment provenance")
      if (seen.has(row.id)) throw new Error("duplicate evaluation outcome")
      seen.add(row.id)
    }
    if (baseline.group !== candidate.group) throw new Error("paired outcomes must cover the same task group")
    return { baseline, candidate }
  })
  if (new Set(pairs.map((p) => p.baseline.group)).size !== pairs.length) throw new Error("duplicate task group")
  const regressions = pairs.filter((p) => p.baseline.status === "success" && p.candidate.status !== "success").length
  const improvements = pairs.filter((p) => p.baseline.status !== "success" && p.candidate.status === "success").length
  const unknown = pairs.filter((p) => [p.baseline.status, p.candidate.status].some((s) => s === "indeterminate" || s === "abstained")).length
  const sumCost = (rows: Experience[]) => rows.every((r) => typeof r.metrics.model_cost === "number") ? rows.reduce((sum, r) => sum + r.metrics.model_cost!, 0) : null
  const metrics = { pairs: pairs.length, regressions, improvements, abstained_or_indeterminate_pairs: unknown,
    baseline_successes: pairs.filter((p) => p.baseline.status === "success").length,
    candidate_successes: pairs.filter((p) => p.candidate.status === "success").length,
    baseline_cost: sumCost(pairs.map((p) => p.baseline)), candidate_cost: sumCost(pairs.map((p) => p.candidate)) }
  const eligible = regressions === 0 && improvements > 0 && unknown === 0
  const record = appendExperience(project, {
    kind: "evaluation", source: { type: "paired-evaluation-v1", id: request.id, sha256: experienceHash(request) },
    observed_at: request.observed_at, retention: "evaluation", status: eligible ? "success" : unknown ? "indeterminate" : "failure",
    summary: `Paired evaluation: ${improvements} improvements, ${regressions} regressions; publication remains an explicit separate review.`,
    skill_version: request.candidate, group: request.id,
    relations: [...seen].map((id) => ({ kind: "evaluates", id })), metrics,
  })
  return { record, eligible_for_review: eligible, automatically_promoted: false }
}

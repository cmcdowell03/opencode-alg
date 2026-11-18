import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { readFileSync } from "node:fs"
import { InvestigationHttpPort } from "../src/investigation-transport.ts"
import { loadRunForOwner } from "../src/store.ts"
import { mutateOwnedRunAsync } from "../src/ownership.ts"
import { investigationReviewBasis, recordInvestigationReview } from "../src/investigation-review.ts"
import { InvestigationStore } from "../src/investigation/index.ts"
import { MemoryStore } from "../src/session-memory/store.ts"

/** Operator surface, deliberately not registered as an agent tool. Same-account shell is not an OS security boundary. */
async function main() {
  const { values } = parseArgs({ options: { project: { type: "string" }, owner: { type: "string" }, run: { type: "string" },
    engineer: { type: "string" }, statement: { type: "string" }, scope: { type: "string" }, "source-ref": { type: "string" }, proceed: { type: "boolean" },
    "work-key": { type: "string" }, "expected-basis": { type: "string" }, preview: { type: "boolean" },
    "abandon-work": { type: "string" }, "retry-unaccepted": { type: "string" }, "reserve-cost": { type: "string" }, "migrate-profile": { type: "string" } } })
  if (!values.project || !values.owner || !values.run) throw new Error("required: --project PATH --owner SESSION --run RUN [--engineer REF] [--preview [--work-key SHA256]] [--statement TEXT --scope TEXT] [--proceed --work-key SHA256 [--expected-basis SHA256]]")
  const project = resolve(values.project), run = loadRunForOwner(project, values.run, values.owner)
  if (!run?.investigation) throw new Error("owned investigation not found")
  const store = InvestigationStore.open({ project_directory: project, project_id: new MemoryStore(project).projectId, owner_id: values.owner, run_id: values.run })
  if (values.preview) {
    if (values.proceed || values["expected-basis"] || values.statement || values["abandon-work"] || values["retry-unaccepted"] || values["migrate-profile"] || values["reserve-cost"])
      throw new Error("--preview is read-only and cannot be combined with review or recovery actions")
    const candidates = store.snapshot.work.filter((work) => work.authorized_nodes?.includes("confirm") &&
      (!values["work-key"] || work.work_key === values["work-key"]))
    if (values["work-key"] && candidates.length !== 1) throw new Error("selected confirmation work order was not found")
    const preview = candidates.map((work) => ({ work_key: work.work_key, submission_id: work.submission_id,
      status: work.status, operation: work.operation,
      recipe_version: work.recipe_version ?? null, cohort: work.cohort ?? null,
      preprocessing_revision: work.preprocessing_revision ?? null,
      source_dependencies: work.source_dependencies, query: work.query, parameters: work.parameters,
      reservation: work.admitted_reservation ?? null, reserved_cost_current: work.reserved_cost,
      purpose: work.purpose, generation: work.generation,
      authorized_nodes: work.authorized_nodes ?? [],
      result_source_versions: work.result?.source_versions ?? null,
      basis_sha256: work.recipe_version && work.admitted_reservation !== undefined
        ? investigationReviewBasis(run, work.work_key) : null,
      inspectable: Boolean(work.recipe_version && work.admitted_reservation !== undefined) }))
    console.log(JSON.stringify({ read_only: true, run_id: values.run, confirmation_work: preview }))
    return
  }
  const recoveryActions = [values["abandon-work"], values["retry-unaccepted"], values["migrate-profile"]].filter(Boolean)
  if (recoveryActions.length > 1) throw new Error("choose one operator recovery action")
  const recovery = recoveryActions[0]
  if (values.proceed && !values["work-key"]) throw new Error("confirmation approval requires --work-key for the selected admitted work order")
  if (values.proceed && !values["expected-basis"]) throw new Error("confirmation approval requires --expected-basis from a fresh --preview")
  if (values.proceed && values.statement) throw new Error("record engineer contributions separately before approving confirmation")
  if (!values.proceed && values["expected-basis"]) throw new Error("--expected-basis is only valid with --proceed")
  if (values["expected-basis"] && !/^[a-f0-9]{64}$/.test(values["expected-basis"]))
    throw new Error("--expected-basis must be a lowercase SHA-256 digest")
  if (!values.proceed && !values.preview && values["work-key"]) throw new Error("--work-key is only valid with --proceed or --preview")
  if (values["work-key"]) {
    const selected = store.snapshot.work.find((work) => work.work_key === values["work-key"])
    if (!selected || !selected.authorized_nodes?.includes("confirm")) throw new Error("work-key must identify an admitted order assigned to confirm")
  }
  if ((values.proceed || values.statement || recovery) && !values.engineer) throw new Error("--engineer is required for review, contribution, or recovery actions")
  if (recovery && (values.proceed || !values.statement || values["abandon-work"] && values["retry-unaccepted"]))
    throw new Error("choose one recovery action with a statement; recovery cannot also approve confirmation")
  if (values["reserve-cost"] !== undefined && !values["retry-unaccepted"]) throw new Error("reserve-cost is only valid with retry-unaccepted")
  if (values["retry-unaccepted"] && !values["reserve-cost"]) throw new Error("retry-unaccepted requires the reviewed service maximum via reserve-cost")
  if (values.proceed) {
    if (values.engineer!.length < 1 || values.engineer!.length > 256) throw new Error("engineer reference must be 1-256 characters")
  }
  if (values["migrate-profile"]) {
    const profileBytes = readFileSync(resolve(values["migrate-profile"]))
    if (profileBytes.byteLength > 65_536) throw new Error("profile exceeds bound")
    const port = new InvestigationHttpPort(JSON.parse(profileBytes.toString("utf8")), store.scope.project_id)
    await port.qualify()
    await store.migrateProfile(port, { engineer_ref: values.engineer!, statement: values.statement! })
  }
  if (values["retry-unaccepted"]) await store.retryUnaccepted(values["retry-unaccepted"], Number(values["reserve-cost"]), { engineer_ref: values.engineer!, statement: values.statement! })
  if (values["abandon-work"]) await store.abandon(values["abandon-work"], { engineer_ref: values.engineer!, statement: values.statement! })
  if (values.statement && !recovery) await store.recordEngineerContribution({ engineer_ref: values.engineer!, statement: values.statement,
    scope: values.scope ?? "initial investigation review", ...(values["source-ref"] ? { source_ref: values["source-ref"] } : {}) })
  if (values.proceed) await mutateOwnedRunAsync(project, values.run, values.owner, (fresh) => {
    recordInvestigationReview(fresh, values.engineer!, values["work-key"]!, values["expected-basis"]!)
  })
  console.log(JSON.stringify({ recorded: Boolean(values.statement), reviewed: Boolean(values.proceed), abandoned_work: values["abandon-work"] ?? null,
    retried_work: values["retry-unaccepted"] ?? null, migrated_profile: Boolean(values["migrate-profile"]), run_id: values.run }))
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "operator review failed"); process.exitCode = 1 })

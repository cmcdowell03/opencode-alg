import { parseArgs } from "node:util"
import { resolve } from "node:path"
import { loadRunForOwner } from "../src/store.ts"
import { mutateOwnedRunAsync } from "../src/ownership.ts"
import { recordInvestigationReview } from "../src/investigation-review.ts"
import { InvestigationStore } from "../src/investigation/index.ts"
import { MemoryStore } from "../src/session-memory/store.ts"

/** Operator surface, deliberately not registered as an agent tool. Same-account shell is not an OS security boundary. */
async function main() {
  const { values } = parseArgs({ options: { project: { type: "string" }, owner: { type: "string" }, run: { type: "string" },
    engineer: { type: "string" }, statement: { type: "string" }, scope: { type: "string" }, "source-ref": { type: "string" }, proceed: { type: "boolean" },
    "abandon-work": { type: "string" }, "retry-unaccepted": { type: "string" }, "reserve-cost": { type: "string" } } })
  if (!values.project || !values.owner || !values.run || !values.engineer) throw new Error("required: --project PATH --owner SESSION --run RUN --engineer REF [--statement TEXT --scope TEXT] [--proceed]")
  const project = resolve(values.project), run = loadRunForOwner(project, values.run, values.owner)
  if (!run?.investigation) throw new Error("owned investigation not found")
  const store = InvestigationStore.open({ project_directory: project, project_id: new MemoryStore(project).projectId, owner_id: values.owner, run_id: values.run })
  const recovery = values["abandon-work"] || values["retry-unaccepted"]
  if (recovery && (values.proceed || !values.statement || values["abandon-work"] && values["retry-unaccepted"]))
    throw new Error("choose one recovery action with a statement; recovery cannot also approve confirmation")
  if (values["reserve-cost"] !== undefined && !values["retry-unaccepted"]) throw new Error("reserve-cost is only valid with retry-unaccepted")
  if (values["retry-unaccepted"] && !values["reserve-cost"]) throw new Error("retry-unaccepted requires the reviewed service maximum via reserve-cost")
  if (values["retry-unaccepted"]) await store.retryUnaccepted(values["retry-unaccepted"], Number(values["reserve-cost"]), { engineer_ref: values.engineer, statement: values.statement! })
  if (values["abandon-work"]) await store.abandon(values["abandon-work"], { engineer_ref: values.engineer, statement: values.statement! })
  if (values.statement && !recovery) await store.recordEngineerContribution({ engineer_ref: values.engineer, statement: values.statement,
    scope: values.scope ?? "initial investigation review", ...(values["source-ref"] ? { source_ref: values["source-ref"] } : {}) })
  if (values.proceed) await mutateOwnedRunAsync(project, values.run, values.owner, (fresh) => { recordInvestigationReview(fresh, values.engineer!) })
  console.log(JSON.stringify({ recorded: Boolean(values.statement), reviewed: Boolean(values.proceed), abandoned_work: values["abandon-work"] ?? null,
    retried_work: values["retry-unaccepted"] ?? null, run_id: values.run }))
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "operator review failed"); process.exitCode = 1 })

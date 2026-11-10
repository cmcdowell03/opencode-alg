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
    engineer: { type: "string" }, statement: { type: "string" }, scope: { type: "string" }, "source-ref": { type: "string" }, proceed: { type: "boolean" } } })
  if (!values.project || !values.owner || !values.run || !values.engineer) throw new Error("required: --project PATH --owner SESSION --run RUN --engineer REF [--statement TEXT --scope TEXT] [--proceed]")
  const project = resolve(values.project), run = loadRunForOwner(project, values.run, values.owner)
  if (!run?.investigation) throw new Error("owned investigation not found")
  const store = InvestigationStore.open({ project_directory: project, project_id: new MemoryStore(project).projectId, owner_id: values.owner, run_id: values.run })
  if (values.statement) await store.recordEngineerContribution({ engineer_ref: values.engineer, statement: values.statement,
    scope: values.scope ?? "initial investigation review", ...(values["source-ref"] ? { source_ref: values["source-ref"] } : {}) })
  if (values.proceed) await mutateOwnedRunAsync(project, values.run, values.owner, (fresh) => { recordInvestigationReview(fresh, values.engineer!) })
  console.log(JSON.stringify({ recorded: Boolean(values.statement), reviewed: Boolean(values.proceed), run_id: values.run }))
}
main().catch((error) => { console.error(error instanceof Error ? error.message : "operator review failed"); process.exitCode = 1 })

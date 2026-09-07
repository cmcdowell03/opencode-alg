import { readFileSync, statSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { appendExperience, archiveExperience, experienceCatalog, experienceHealth, importHistoricalPlanExperience, importRunExperience, importDatasetExperience, intakeTerminalRunExperience } from "../src/experience.ts"
import { changeIncident, incidentHistory } from "../src/troubleshooter.ts"
import { evaluateSkill } from "../src/skill-evaluation.ts"
import { safeDiagnosticText } from "../src/diagnostics.ts"

export function runExperienceCommand(args: string[]): unknown {
  const [command, project, ...rest] = args
  if (!project || !isAbsolute(project)) throw new Error("usage: experience <health|catalog|record|import-run|import-historical|intake-runs|incident|incident-history|evaluate> <absolute-project> [args]")
  const request = () => {
    if (rest.length !== 1 || !rest[0] || !isAbsolute(rest[0])) throw new Error("provide one absolute JSON request path")
    if (statSync(rest[0]).size > 128 * 1024) throw new Error("request exceeds 128 KiB")
    const bytes = readFileSync(rest[0])
    if (bytes.length > 128 * 1024) throw new Error("request grew beyond 128 KiB")
    return JSON.parse(bytes.toString("utf8"))
  }
  if (command === "record") {
    const value = request()
    if (["incident", "evaluation", "dataset"].includes(value?.kind)) throw new Error("use the typed incident, evaluate or import-dataset command for managed records")
    return appendExperience(project, value)
  }
  if (command === "incident") return changeIncident(project, request())
  if (command === "evaluate") return evaluateSkill(project, request())
  if (command === "import-run" && rest.length === 2) return importRunExperience(project, rest[0]!, rest[1]!)
  if (command === "import-historical" && rest.length === 1) return importHistoricalPlanExperience(project, rest[0]!)
  if (command === "intake-runs" && rest.length === 1) return intakeTerminalRunExperience(project, rest[0]!)
  if (command === "import-dataset" && rest.length === 2) return importDatasetExperience(project, rest[0]!, rest[1]!)
  if (command === "archive-copy" && rest.length === 2 && rest[1] === "--confirm") return archiveExperience(project, rest[0]!, true)
  if (command === "incident-history" && rest.length === 1) return incidentHistory(project, rest[0]!)
  if (command === "catalog-build" && rest.length === 1) {
    if (!isAbsolute(rest[0]!)) throw new Error("catalog-build requires an absolute prepared Python interpreter")
    const snapshot = JSON.stringify(experienceCatalog(project))
    if (Buffer.byteLength(snapshot) > 8 * 1024 * 1024) throw new Error("catalog snapshot exceeds bounded build size")
    const runner = fileURLToPath(new URL("../capabilities/datascience/runner.py", import.meta.url))
    const result = spawnSync(rest[0]!, ["-I", "-B", runner, "--catalog-worker", "--project", project], {
      input: snapshot, encoding: "utf8", timeout: 30_000, maxBuffer: 128 * 1024, windowsHide: true,
      env: Object.fromEntries(["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"].filter((key) => process.env[key]).map((key) => [key, process.env[key]!])),
    })
    if (result.error || result.status !== 0) throw new Error("bounded catalog build failed; source experience is unchanged")
    return JSON.parse(result.stdout)
  }
  if (rest.length) throw new Error("unexpected command arguments")
  if (command === "health") return experienceHealth(project)
  if (command === "catalog") return experienceCatalog(project)
  throw new Error("unknown experience command")
}

if (import.meta.main || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  try { console.log(JSON.stringify(runExperienceCommand(process.argv.slice(2)))) }
  catch (error) { console.error(JSON.stringify({ ok: false, error: safeDiagnosticText(error instanceof Error ? error.message : String(error)) })); process.exitCode = 1 }
}

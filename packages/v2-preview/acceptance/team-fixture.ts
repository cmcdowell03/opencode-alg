import { execFile } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { sha256 } from "./runtime.ts"

export async function prepareTeamReference(root: string, project: string, hostConfig: string) {
  const reference = join(root, "team-contracts")
  await mkdir(reference)
  const git = (...args: string[]) => promisify(execFile)("git", ["-c", "user.name=fixture",
    "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false",
    "-c", "core.hooksPath=/dev/null", ...args], { cwd: reference, windowsHide: true })
  const document = "Inspection contract: compare events strictly before wafer inspection.\n"
  const path = join(reference, "contract.md")
  await writeFile(path, document, { flag: "wx" })
  await git("init", "-q")
  await git("add", "--", "contract.md")
  await git("commit", "-q", "-m", "Fixture contract")
  const commit = (await git("rev-parse", "HEAD")).stdout.trim()
  await writeFile(path, "Uncommitted edit outside the approved revision.\n")
  const ref = "reference:contracts/contract.md"
  const operation = "compare-inspections"
  const registry = JSON.stringify({ schema_version: 1, operations: [{ id: operation,
    authoritative_sources: [{ ref, revision: sha256(document) }] }] })
  await mkdir(join(project, ".opencode"), { recursive: true })
  await writeFile(join(project, ".opencode", "ALG.workspace.json"), registry, { flag: "wx" })
  const cfg = JSON.parse(await readFile(hostConfig, "utf8"))
  cfg.plugins[0].options.teamSourcesRegistrySha256 = sha256(registry)
  cfg.references = { contracts: { path: reference } }
  cfg.plugins[0].options.researchRoles = [
    { agent: "equipment-research", question: "What equipment evidence would distinguish two chambers?" },
    { agent: "metrology-research", question: "What metrology evidence would locate the clock discrepancy?" },
  ]
  for (const { agent } of cfg.plugins[0].options.researchRoles)
    cfg.agents[agent] = { mode: "subagent", permissions: [{ action: "*", resource: "*", effect: "deny" }] }
  cfg.agents.build.permissions.push(...["alg_team_source", "alg_research", "read", "external_directory"].map(action =>
    ({ action, resource: "*", effect: "allow" })))
  await writeFile(hostConfig, JSON.stringify(cfg))
  return { operation, source: ref, document, commit, digest: sha256(document) }
}

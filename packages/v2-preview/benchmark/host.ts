import { randomBytes } from "node:crypto"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import type { SessionMessageInfo } from "@opencode/client"
import { owner, requestOptions, startHost, transcript } from "../acceptance/host.ts"
import { isolate, sha256, waitFor } from "../acceptance/runtime.ts"
import { approvedJob, startFactory } from "../acceptance/service.ts"
import { createV2InvestigationBridge } from "../core/investigation.ts"
import { evidenceToolNames } from "./workbench.ts"
import { InvestigationHttpPort } from "../../../src/investigation-transport.ts"

export const pluginId = "opencode-alg-v2-preview"
export const armNames = ["build", "alg"] as const
export type ArmName = typeof armNames[number]
export type Host = Awaited<ReturnType<typeof startHost>>
export const checkerName = "research-checker"
export const contextWindow = 16384
export const outputLimit = 4096
const approval = ".opencode/research-procedure.json"
const deny = { action: "*", resource: "*", effect: "deny" } as const
const allow = (action: string, resource = "*") => ({ action, resource, effect: "allow" as const })

export function hasScopedEvidenceTools(
  root: readonly { tools: readonly string[] }[], checker: readonly { tools: readonly string[] }[],
) {
  const names = (server: string) => evidenceToolNames.map(tool => server + "_" + tool)
  const matches = (rows: typeof root, own: string[], other: string[]) =>
    rows.length > 0 && rows.every(row =>
      own.every(tool => row.tools.includes(tool)) && other.every(tool => !row.tools.includes(tool)))
  const evidence = names("evidence"), audit = names("audit")
  return matches(root, evidence, audit) && matches(checker, audit, evidence)
}

export async function prepareHost(root: string, options: {
  model: { providerID: string; id: string }; providerUrl?: string; providers?: Record<string, unknown>; evidenceUrl: string; checkerUrl: string
  skill: { name: string; content: string }; bundle?: string; context?: number
}) {
  const directory = join(root, "project")
  const skillRelative = `.opencode/skills/${options.skill.name}/SKILL.md`
  if (!/^[a-z][a-z0-9-]*$/.test(options.skill.name)) throw new Error("Invalid project skill name")
  const skillFile = join(directory, skillRelative)
  await mkdir(dirname(skillFile), { recursive: true })
  await writeFile(skillFile, options.skill.content, { flag: "wx" })
  const env = await isolate(join(root, "host"))
  delete env.OPENCODE_DISABLE_PROJECT_CONFIG
  delete env.OPENCODE_DISABLE_FILEWATCHER

  const password = randomBytes(24).toString("hex")
  const remote = (url: string) => ({ type: "remote", url, oauth: false, codemode: false, protocol: "legacy" })
  const rules = (server: string, installed = false) => [
    deny, allow("mcp.use", server),
    ...evidenceToolNames.flatMap(tool => {
      const name = server + "_" + tool
      return [allow("tool.use", name), allow(name)]
    }),
    allow("skill.use"), allow("tool.use", "skill"), allow("skill"), ...(installed ? [allow("alg_investigation"), allow("tool.use", "alg_investigation")] : []),
  ]
  const config = {
    model: `${options.model.providerID}/${options.model.id}`, default_agent: owner,
    update: "disable", share: "disabled", snapshots: false, warming: false,
    compaction: { auto: true, background: true, buffer: "20%", keep: { tokens: 0 } },
    providers: options.providers ?? {
      [options.model.providerID]: {
        package: "@opencode/ai/providers/openai-compatible", name: "Paired benchmark provider",
        settings: { baseURL: options.providerUrl, compaction: { type: "summary" } },
        models: { [options.model.id]: { name: options.model.id, type: "chat",
          limit: { context: options.context ?? contextWindow, output: outputLimit }, capabilities: { tools: true } } },
      },
    },
    skills: [join(directory, ".opencode", "skills")], mcp: { servers: { evidence: remote(options.evidenceUrl), audit: remote(options.checkerUrl) } },
    permissions: [deny],
    agents: {
      [owner]: { mode: "primary", permissions: rules("evidence", !!options.bundle) },
      [checkerName]: { mode: "subagent", permissions: rules("audit") },
    },
    plugins: [] as object[],

  }
  const configPath = join(root, "opencode.json")
  await writeFile(configPath, JSON.stringify(config), { flag: "wx" })
  return {
    directory: await realpath(directory), skillRelative, skillFile, config, configPath,
    settings: { env: { ...env, OPENCODE_CONFIG: configPath,
      OPENCODE_CONFIG_DIR: env.XDG_CONFIG_HOME, OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password },
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } },
  }
}

export async function registerSkill(host: Host, project: Awaited<ReturnType<typeof prepareHost>>, name: string) {
  const expectedPath = await realpath(project.skillFile)
  const skill = await waitFor(async () => {
    const catalog = await host.client.skill.list({ location: { directory: project.directory } }, requestOptions())
    const candidate = catalog.data.find(entry => entry.name === name || entry.id === name)
    return candidate && await realpath(candidate.path) === expectedPath ? candidate : undefined
  }, 5000, "Expected isolated project skill unavailable")
  const sha = sha256(skill.content)
  const sourceSha256 = sha256(await Bun.file(project.skillFile).text())

  return { id: skill.id, sha256: sha, sourceSha256, witness: skill.content }
}

export type Turn = { id: string; text: string; rows: SessionMessageInfo[] }

export async function submitTurn(host: Host, sessionID: string, text: string) {
  const result = await host.client.session.prompt({ sessionID, text, delivery: "queue" }, requestOptions())
  return result.id
}
export async function observeTurn(host: Host, sessionID: string, id: string): Promise<Turn | undefined> {
  const rows = await transcript(host.client, sessionID)
  const start = rows.findIndex(row => row.type === "user" && row.id === id)
  if (start < 0) return
  const end = rows.findIndex((row, i) => i > start && (row.type === "idle" || row.type === "user"))
  if (end < 0) return
  const idle = rows[end]
  if (idle?.type !== "idle" || idle.outcome !== "succeeded") throw new Error("Host turn did not succeed")
  const turn = rows.slice(start + 1, end)
  const answer = turn.slice().reverse().find(row => row.type === "assistant" && row.finish === "stop")
  if (answer?.type !== "assistant" || !answer.time.completed) throw new Error("Host turn had no completed assistant response")
  const text = answer.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
  if (!text.trim()) throw new Error("Host turn returned empty assistant text")
  return { id: answer.id, text, rows: turn }
}

export async function installAlg(project: Awaited<ReturnType<typeof prepareHost>>, bundle: string,
  skill: Awaited<ReturnType<typeof registerSkill>>, factory: ReturnType<typeof startFactory>) {
  const body = JSON.stringify({ id: skill.id, path: project.skillRelative, sha256: skill.sha256, sourceSha256: skill.sourceSha256 })
  await writeFile(join(project.directory, approval), body, { flag: "wx" })
  project.config.plugins.push({
    package: pathToFileURL(bundle).href,
    options: { enabled: true, ownerAgent: owner, adapter: factory.adapter, approvedJob,
      checkerAgent: "alg-investigation-checker", approvedProcedure: approval, approvedProcedureSha256: sha256(body) },
  })
  await writeFile(project.configPath, JSON.stringify(project.config))
}







export function observeAlgDecision(factory: ReturnType<typeof startFactory>, directory: string, projectID: string, sessionID: string) {
  const port = new InvestigationHttpPort(factory.adapter, projectID)
  const view = createV2InvestigationBridge({ port, approvedJob }).primary({ directory, projectID, sessionID })
  if (!view?.decision.next_action) return null
  return {
    revision: view.decision_revision, actionSha: sha256(view.decision.next_action),
    procedureSha: view.procedurePin?.sha256 ?? null, governedManifestObserved: !!view.work?.manifest_digest,
  }
}

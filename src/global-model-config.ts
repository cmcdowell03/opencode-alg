import { existsSync } from "node:fs"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ModelAgent } from "./types.ts"
import {
  commitTextPlans,
  parseJsoncObject,
  planDeleteJsoncPath,
  readConfigTextFile,
  type TextFilePlan,
} from "./config-editor.ts"
import { canonicalRootPath, resolveContainedPath } from "./paths.ts"

type GlobalConfig = TuiPluginApi["state"]["config"]
type Client = TuiPluginApi["client"]

export interface GlobalModelSaveResult {
  method: "api" | "local-jsonc"
  changed: boolean
  backups: string[]
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message
  }
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

export function configuredGlobalModel(config: GlobalConfig, agent: ModelAgent): string | undefined {
  const model = config.agent?.[agent]?.model
  return typeof model === "string" && model.length ? model : undefined
}

export async function getGlobalConfig(client: Client): Promise<GlobalConfig> {
  const response = await client.global.config.get()
  if (response.error) throw new Error(`Could not read global OpenCode config: ${errorMessage(response.error)}`)
  return response.data ?? {}
}

export function clearLocalGlobalAgentModel(configDir: string, agent: ModelAgent): GlobalModelSaveResult {
  const root = canonicalRootPath(configDir)
  const files = ["config.json", "opencode.json", "opencode.jsonc"].map((name) =>
    resolveContainedPath(root, name))
  const plans: TextFilePlan[] = []
  for (const file of files) {
    const plan = planDeleteJsoncPath(file, ["agent", agent, "model"])
    if (plan) plans.push(plan)
  }
  const committed = commitTextPlans(plans, { backups: true })
  return {
    method: "local-jsonc",
    changed: committed.length > 0,
    backups: committed.flatMap((item) => item.backup ? [item.backup] : []),
  }
}

export async function saveGlobalAgentModel(options: {
  client: Client
  configDir: string
  agent: ModelAgent
  model: string | null
  currentConfig: GlobalConfig
}): Promise<GlobalModelSaveResult> {
  if (options.model !== null) {
    const response = await options.client.global.config.update({
      config: { agent: { [options.agent]: { model: options.model } } },
    })
    if (response.error) throw new Error(`Could not save global OpenCode config: ${errorMessage(response.error)}`)
    return { method: "api", changed: true, backups: [] }
  }

  // OpenCode 1.18.3 PATCH deep-merges objects and its schema rejects null, so it
  // cannot delete agent.<role>.model. A guarded local JSONC edit is the only safe
  // deletion alternative; attached/remote TUIs fail clearly instead of writing a
  // path that is not locally available.
  const hadModel = configuredGlobalModel(options.currentConfig, options.agent) !== undefined
  const result = clearLocalGlobalAgentModel(options.configDir, options.agent)
  if (hadModel && !result.changed) {
    throw new Error(
      "Inherit could not be saved locally. This appears to be an attached/remote TUI; remove agent." +
      `${options.agent}.model on the server and restart OpenCode.`,
    )
  }
  return result
}

export function findConfiguredModelFiles(configDir: string, agent: ModelAgent): string[] {
  const root = canonicalRootPath(configDir)
  return ["config.json", "opencode.json", "opencode.jsonc"].flatMap((name) => {
    const file = resolveContainedPath(root, name)
    if (!existsSync(file)) return []
    const data = parseJsoncObject(readConfigTextFile(file).text, file)
    const agents = data.agent
    if (!agents || typeof agents !== "object" || Array.isArray(agents)) return []
    const role = (agents as Record<string, unknown>)[agent]
    if (!role || typeof role !== "object" || Array.isArray(role)) return []
    return typeof (role as Record<string, unknown>).model === "string" ? [file] : []
  })
}

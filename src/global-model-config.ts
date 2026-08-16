import { existsSync } from "node:fs"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { ModelAgent } from "./types.ts"
import {
  commitTextPlans,
  parseJsoncObject,
  planUpdateJsoncPaths,
  readConfigTextFile,
  type JsoncPathUpdate,
  type TextFilePlan,
} from "./config-editor.ts"
import { canonicalRootPath, resolveContainedPath } from "./paths.ts"
import { formatSdkError } from "./diagnostics.ts"

type GlobalConfig = TuiPluginApi["state"]["config"]
type Client = TuiPluginApi["client"]

export interface GlobalConfigRead {
  config: GlobalConfig
  /** Actual response URL from the same global.config.get request. */
  responseUrl?: string
}

export interface GlobalModelSaveResult {
  method: "api" | "local-jsonc"
  changed: boolean
  backups: string[]
}

interface LocalRoleFields {
  candidate: boolean
  model: unknown
  variant: unknown
}

function errorMessage(error: unknown): string {
  return formatSdkError(error)
}

export function configuredGlobalModel(config: GlobalConfig, agent: ModelAgent): string | undefined {
  const model = config.agent?.[agent]?.model
  return typeof model === "string" && model.length ? model : undefined
}

export function configuredGlobalVariant(config: GlobalConfig, agent: ModelAgent): string | undefined {
  const variant = config.agent?.[agent]?.variant
  return typeof variant === "string" && variant.length ? variant : undefined
}

export async function getGlobalConfig(client: Client): Promise<GlobalConfigRead> {
  const response = await client.global.config.get()
  if (response.error) throw new Error(`Could not read global OpenCode config: ${errorMessage(response.error)}`)
  return {
    config: response.data ?? {},
    ...(response.response.url ? { responseUrl: response.response.url } : {}),
  }
}

function globalConfigFiles(configDir: string): string[] {
  const root = canonicalRootPath(configDir)
  return ["config.json", "opencode.json", "opencode.jsonc"].map((name) =>
    resolveContainedPath(root, name))
}

function roleFields(data: Record<string, unknown>, agent: ModelAgent): LocalRoleFields {
  const agents = data.agent
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    return { candidate: false, model: undefined, variant: undefined }
  }
  const role = (agents as Record<string, unknown>)[agent]
  if (!role || typeof role !== "object" || Array.isArray(role)) {
    return { candidate: false, model: undefined, variant: undefined }
  }
  const record = role as Record<string, unknown>
  return {
    candidate: Object.hasOwn(record, "model") || Object.hasOwn(record, "variant"),
    model: record.model,
    variant: record.variant,
  }
}

function isLoopbackResponseUrl(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "")
    return hostname === "localhost" || hostname === "[::1]" || hostname === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(hostname)
  } catch {
    return false
  }
}

function localEditError(agent: ModelAgent, detail: string): Error {
  return new Error(
    `Global role deletion failed closed (${detail}). This appears to be an attached/remote or ambiguous config; ` +
    `edit agent.${agent}.model/variant on the server and restart OpenCode.`,
  )
}

/**
 * Prove this TUI is local and identify one unambiguous source file whose role
 * model/variant exactly match the merged values from the same API read.
 */
function selectLocalGlobalConfig(options: {
  configDir: string
  agent: ModelAgent
  currentConfig: GlobalConfig
  configResponseUrl?: string
}): string {
  if (!isLoopbackResponseUrl(options.configResponseUrl)) {
    throw localEditError(options.agent, options.configResponseUrl ? "non-loopback response URL" : "response URL unavailable")
  }

  const candidates = globalConfigFiles(options.configDir).flatMap((path) => {
    if (!existsSync(path)) return []
    const decoded = readConfigTextFile(path)
    const fields = roleFields(parseJsoncObject(decoded.text, path), options.agent)
    return fields.candidate ? [{ path, fields }] : []
  })
  if (candidates.length === 0) throw localEditError(options.agent, "no matching local role source")
  if (candidates.length !== 1) throw localEditError(options.agent, "ambiguous or split local role sources")

  const candidate = candidates[0]!
  const mergedModel = configuredGlobalModel(options.currentConfig, options.agent)
  const mergedVariant = configuredGlobalVariant(options.currentConfig, options.agent)
  if (candidate.fields.model !== mergedModel || candidate.fields.variant !== mergedVariant) {
    throw localEditError(options.agent, "local role source does not match the API config read")
  }
  return candidate.path
}

function commitLocalRoleUpdate(options: {
  configDir: string
  agent: ModelAgent
  currentConfig: GlobalConfig
  configResponseUrl?: string
  updates: readonly JsoncPathUpdate[]
}): GlobalModelSaveResult {
  const path = selectLocalGlobalConfig(options)
  const plan = planUpdateJsoncPaths(path, options.updates)
  if (!plan) throw localEditError(options.agent, "local role source disappeared")

  // Revalidate the exact text used by the plan, rather than trusting an earlier
  // read if the file changed while locality was being established.
  const fields = roleFields(parseJsoncObject(plan.before ?? "", path), options.agent)
  if (
    fields.model !== configuredGlobalModel(options.currentConfig, options.agent) ||
    fields.variant !== configuredGlobalVariant(options.currentConfig, options.agent)
  ) {
    throw localEditError(options.agent, "local role source changed during preflight")
  }

  const committed = commitTextPlans([plan], { backups: true })
  return {
    method: "local-jsonc",
    changed: committed.length > 0,
    backups: committed.flatMap((item) => item.backup ? [item.backup] : []),
  }
}

async function updateGlobalAgent(
  client: Client,
  agent: ModelAgent,
  patch: { model: string; variant?: string },
): Promise<void> {
  const response = await client.global.config.update({
    config: { agent: { [agent]: patch } },
  })
  if (response.error) throw new Error(`Could not save global OpenCode config: ${errorMessage(response.error)}`)
}

export async function saveGlobalAgentModel(options: {
  client: Client
  configDir: string
  agent: ModelAgent
  model: string | null
  /** Undefined preserves legacy model-only calls; null explicitly selects model-default effort. */
  variant?: string | null
  currentConfig: GlobalConfig
  /** URL captured from the same global.config.get response as currentConfig. */
  configResponseUrl?: string
}): Promise<GlobalModelSaveResult> {
  if (options.model !== null) {
    if (options.variant === undefined) {
      // Backward compatibility for existing callers that only set a model.
      await updateGlobalAgent(options.client, options.agent, { model: options.model })
      return { method: "api", changed: true, backups: [] }
    }
    if (options.variant !== null) {
      // Explicit effort saves patch the model and its exact catalog variant together.
      await updateGlobalAgent(options.client, options.agent, {
        model: options.model,
        variant: options.variant,
      })
      return { method: "api", changed: true, backups: [] }
    }

    if (configuredGlobalVariant(options.currentConfig, options.agent) === undefined) {
      await updateGlobalAgent(options.client, options.agent, { model: options.model })
      return { method: "api", changed: true, backups: [] }
    }

    // Deletion cannot be safely mixed with PATCH. Set the selected model and
    // delete the old variant in one local, comment-preserving transaction.
    return commitLocalRoleUpdate({
      ...options,
      updates: [
        { op: "set", path: ["agent", options.agent, "model"], value: options.model },
        { op: "delete", path: ["agent", options.agent, "variant"] },
      ],
    })
  }

  if (typeof options.variant === "string") {
    throw new Error("a variant cannot be saved while inheriting the OpenCode default model")
  }

  const hadModel = configuredGlobalModel(options.currentConfig, options.agent) !== undefined
  const hadVariant = configuredGlobalVariant(options.currentConfig, options.agent) !== undefined
  if (!hadModel && !hadVariant) return { method: "local-jsonc", changed: false, backups: [] }

  return commitLocalRoleUpdate({
    ...options,
    updates: [
      { op: "delete", path: ["agent", options.agent, "model"] },
      { op: "delete", path: ["agent", options.agent, "variant"] },
    ],
  })
}

export function findConfiguredModelFiles(configDir: string, agent: ModelAgent): string[] {
  return globalConfigFiles(configDir).flatMap((file) => {
    if (!existsSync(file)) return []
    const data = parseJsoncObject(readConfigTextFile(file).text, file)
    const agents = data.agent
    if (!agents || typeof agents !== "object" || Array.isArray(agents)) return []
    const role = (agents as Record<string, unknown>)[agent]
    if (!role || typeof role !== "object" || Array.isArray(role)) return []
    return typeof (role as Record<string, unknown>).model === "string" ? [file] : []
  })
}

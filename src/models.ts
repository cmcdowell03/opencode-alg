import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs"
import { basename, dirname } from "node:path"
import type { AgentModelMap, ModelAgent, ModelRef, ProjectModelSettings } from "./types.ts"
import { ALG_MODEL_SETTINGS_VERSION, MODEL_AGENTS } from "./types.ts"
import { atomicWriteFile, ensureDir, quarantineCorruptFile } from "./store.ts"
import { canonicalDirectory, resolveContainedPath } from "./paths.ts"
import {
  AgentModelMapSchema,
  ModelRefSchema,
  ModelVariantSchema,
  ProjectModelSettingsSchema,
} from "./schemas.ts"
import { acquireFilesystemMutex } from "./filesystem-mutex.ts"

const MAX_MODEL_SETTINGS_BYTES = 64 * 1024

export interface ModelSettingsLock {
  path: string
  release(): void
}

export function modelSettingsPath(projectDirectory: string): string {
  return resolveContainedPath(canonicalDirectory(projectDirectory), ".opencode", "alg-models.json")
}

export function modelSettingsLockPath(projectDirectory: string): string {
  return resolveContainedPath(canonicalDirectory(projectDirectory), ".opencode", "alg-models.lock")
}

export function acquireModelSettingsLock(projectDirectory: string): ModelSettingsLock {
  const project = canonicalDirectory(projectDirectory)
  const path = modelSettingsLockPath(project)
  ensureDir(dirname(path))
  try {
    return acquireFilesystemMutex(path, {
      owner: "alg-model-settings",
      leaseMs: 30_000,
      waitMs: 250,
    })
  } catch (error) {
    throw new Error(`model settings are locked by another writer: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function emptyModelSettings(): ProjectModelSettings {
  return {
    schema_version: ALG_MODEL_SETTINGS_VERSION,
    revision: 0,
    models: {},
    updated_at: new Date(0).toISOString(),
  }
}

export function loadModelSettings(
  projectDirectory: string,
  options: { renameCorruptFile?: (source: string, destination: string) => void } = {},
): ProjectModelSettings {
  const path = modelSettingsPath(projectDirectory)
  if (!existsSync(path)) return emptyModelSettings()
  try {
    if (statSync(path).size > MAX_MODEL_SETTINGS_BYTES) throw new Error("model settings are too large")
    return ProjectModelSettingsSchema.parse(JSON.parse(readFileSync(path, "utf8")))
  } catch (error) {
    const result = quarantineCorruptFile(path, options.renameCorruptFile)
    if (result.quarantined && result.path) {
      throw new Error(`ALG model settings are corrupt or incompatible (quarantined as ${basename(result.path)}): ${error instanceof Error ? error.message : String(error)}`)
    }
    throw new Error(`ALG model settings are corrupt or incompatible; corrupt file remains in place and manual action is required (quarantine rename failed: ${result.error ?? "unknown error"}): ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function saveModelSettings(
  projectDirectory: string,
  models: AgentModelMap,
  previousRevision?: number,
): ProjectModelSettings {
  const lock = acquireModelSettingsLock(projectDirectory)
  try {
    const parsedModels = AgentModelMapSchema.parse(models)
    const previous = loadModelSettings(projectDirectory)
    if (previousRevision !== undefined && previous.revision !== previousRevision) {
      throw new Error("ALG model settings changed concurrently")
    }
    const next = ProjectModelSettingsSchema.parse({
      schema_version: ALG_MODEL_SETTINGS_VERSION,
      revision: previous.revision + 1,
      models: parsedModels,
      updated_at: new Date().toISOString(),
    })
    atomicWriteFile(modelSettingsPath(projectDirectory), `${JSON.stringify(next, null, 2)}\n`, true)
    return next
  } finally {
    lock.release()
  }
}

export function setAgentModel(
  projectDirectory: string,
  agent: ModelAgent,
  model: ModelRef | null,
  previousRevision?: number,
): ProjectModelSettings {
  if (!(MODEL_AGENTS as readonly string[]).includes(agent)) throw new Error(`unknown model agent: ${agent}`)
  const current = loadModelSettings(projectDirectory)
  const models = { ...current.models }
  if (model === null) delete models[agent]
  else models[agent] = ModelRefSchema.parse(model)
  return saveModelSettings(projectDirectory, models, previousRevision ?? current.revision)
}

/** Update only the variant on an existing project role selection. */
export function setAgentModelVariant(
  projectDirectory: string,
  agent: ModelAgent,
  variant: string | null,
  previousRevision?: number,
): ProjectModelSettings {
  if (!(MODEL_AGENTS as readonly string[]).includes(agent)) throw new Error(`unknown model agent: ${agent}`)
  const current = loadModelSettings(projectDirectory)
  const selected = current.models[agent]
  if (!selected) throw new Error(`no project model selection exists for ${agent}`)
  const models = { ...current.models }
  models[agent] = ModelRefSchema.parse({
    providerID: selected.providerID,
    modelID: selected.modelID,
    ...(variant === null ? {} : { variant: ModelVariantSchema.parse(variant) }),
  })
  return saveModelSettings(projectDirectory, models, previousRevision ?? current.revision)
}

export function snapshotModels(
  projectDirectory: string,
  configured: AgentModelMap = {},
): AgentModelMap {
  return snapshotEffectiveModels(projectDirectory, configured)
}

export function parseConfiguredModel(value: unknown): ModelRef | undefined {
  if (typeof value !== "string") return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  const parsed = ModelRefSchema.safeParse({
    providerID: value.slice(0, slash),
    modelID: value.slice(slash + 1),
  })
  return parsed.success ? parsed.data : undefined
}

export function configuredAgentModels(config: unknown): AgentModelMap {
  if (!config || typeof config !== "object") return {}
  const source = config as {
    model?: unknown
    agent?: Record<string, { model?: unknown; variant?: unknown } | undefined>
  }
  const fallback = parseConfiguredModel(source.model)
  const models: AgentModelMap = {}
  for (const role of MODEL_AGENTS) {
    const explicit = parseConfiguredModel(source.agent?.[role]?.model)
    if (explicit) {
      const variant = ModelVariantSchema.safeParse(source.agent?.[role]?.variant)
      models[role] = variant.success ? { ...explicit, variant: variant.data } : explicit
    }
    else if (fallback) models[role] = fallback
  }
  return models
}

export function snapshotEffectiveModels(
  projectDirectory: string,
  configured: AgentModelMap,
): AgentModelMap {
  const merged = AgentModelMapSchema.parse({
    ...configured,
    ...loadModelSettings(projectDirectory).models,
  })
  for (const model of Object.values(merged)) Object.freeze(model)
  return Object.freeze(merged)
}

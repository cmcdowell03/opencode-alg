import {
  existsSync,
  readFileSync,
  statSync,
} from "node:fs"
import { basename, dirname } from "node:path"
import type {
  AgentModelMap,
  ModelAgent,
  ModelRef,
  ModelResolution,
  ModelResolutionMap,
  ModelRole,
  ProjectModelSettings,
  RunState,
} from "./types.ts"
import { ALG_MODEL_SETTINGS_VERSION, MODEL_AGENTS, MODEL_ROLES } from "./types.ts"
import { atomicWriteFile, ensureDir, quarantineCorruptFile } from "./store.ts"
import { canonicalDirectory, resolveContainedPath } from "./paths.ts"
import {
  AgentModelMapSchema,
  ModelRefSchema,
  ModelResolutionMapSchema,
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
  const snapshot = modelSnapshotFromResolution(
    snapshotModelResolutions(projectDirectory, undefined, configured),
  )
  for (const model of Object.values(snapshot)) Object.freeze(model)
  return Object.freeze(snapshot)
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
  return modelSnapshotFromResolution(configuredModelResolutions(config))
}

function resolved(model: ModelRef, source: ModelResolution["source"]): ModelResolution {
  return {
    source,
    providerID: model.providerID,
    modelID: model.modelID,
    ...(model.variant ? { variant: model.variant } : {}),
  }
}

function inherited(source: ModelResolution["source"] = "inherited-sdk-default"): ModelResolution {
  return { source }
}

function roleModel(
  source: { agent?: Record<string, { model?: unknown; variant?: unknown } | undefined> },
  names: readonly string[],
): ModelRef | undefined {
  for (const name of names) {
    const explicit = parseConfiguredModel(source.agent?.[name]?.model)
    if (!explicit) continue
    const variant = ModelVariantSchema.safeParse(source.agent?.[name]?.variant)
    return variant.success ? { ...explicit, variant: variant.data } : explicit
  }
  return undefined
}

/** Capture effective model/default provenance from merged OpenCode config. */
export function configuredModelResolutions(config: unknown): ModelResolutionMap {
  const source = (config && typeof config === "object" ? config : {}) as {
    model?: unknown
    agent?: Record<string, { model?: unknown; variant?: unknown } | undefined>
  }
  const fallback = parseConfiguredModel(source.model)
  const resolutions = {} as ModelResolutionMap
  const roleNames: Record<Exclude<ModelRole, "default" | "repair">, readonly string[]> = {
    planner: ["planner", "orchestrator"],
    explorer: ["explorer"],
    researcher: ["researcher"],
    implementer: ["implementer"],
    checker: ["checker"],
  }
  for (const [role, names] of Object.entries(roleNames) as Array<[keyof typeof roleNames, readonly string[]]>) {
    const explicit = roleModel(source, names)
    resolutions[role] = explicit
      ? resolved(explicit, "opencode-role-config")
      : fallback
        ? resolved(fallback, "opencode-top-level-default")
        : inherited()
  }
  // Repair attempts are retries of the implementer node and therefore use the
  // exact same immutable selection rather than claiming a separate SDK agent.
  resolutions.repair = { ...resolutions.implementer }
  resolutions.default = fallback
    ? resolved(fallback, "opencode-top-level-default")
    : inherited()
  return ModelResolutionMapSchema.parse(resolutions)
}

export function modelSnapshotFromResolution(resolutions: ModelResolutionMap): AgentModelMap {
  const models: AgentModelMap = {}
  for (const role of MODEL_AGENTS) {
    const resolution = resolutions[role]
    if (resolution.providerID && resolution.modelID) {
      models[role] = {
        providerID: resolution.providerID,
        modelID: resolution.modelID,
        ...(resolution.variant ? { variant: resolution.variant } : {}),
      }
    }
  }
  return AgentModelMapSchema.parse(models)
}

export function snapshotEffectiveModels(
  projectDirectory: string,
  configured: AgentModelMap,
): AgentModelMap {
  const merged = modelSnapshotFromResolution(
    snapshotModelResolutions(projectDirectory, undefined, configured),
  )
  for (const model of Object.values(merged)) Object.freeze(model)
  return Object.freeze(merged)
}

export function snapshotModelResolutions(
  projectDirectory: string,
  configured?: ModelResolutionMap,
  legacyConfigured: AgentModelMap = {},
): ModelResolutionMap {
  const base = configured
    ? structuredClone(configured)
    : Object.fromEntries(MODEL_ROLES.map((role) => [role, inherited()])) as ModelResolutionMap
  if (!configured) {
    for (const role of MODEL_AGENTS) {
      const model = legacyConfigured[role]
      if (model) base[role] = resolved(model, "legacy-unknown")
    }
    base.repair = { ...base.implementer }
  }
  const projectModels = loadModelSettings(projectDirectory).models
  for (const role of MODEL_AGENTS) {
    const model = projectModels[role]
    if (model) base[role] = resolved(model, "alg-project-override")
  }
  base.repair = { ...base.implementer }
  const parsed = ModelResolutionMapSchema.parse(base)
  for (const resolution of Object.values(parsed)) Object.freeze(resolution)
  return Object.freeze(parsed)
}

/** Old schema-v2 runs did not persist provenance; never invent missing defaults. */
export function modelResolutionsForRun(run: RunState): ModelResolutionMap {
  if (run.model_resolution) return run.model_resolution
  const legacy = Object.fromEntries(MODEL_ROLES.map((role) => [role, inherited("legacy-unknown")])) as ModelResolutionMap
  for (const role of MODEL_AGENTS) {
    const model = run.model_snapshot[role]
    if (model) legacy[role] = resolved(model, "legacy-unknown")
  }
  legacy.repair = { ...legacy.implementer }
  return ModelResolutionMapSchema.parse(legacy)
}

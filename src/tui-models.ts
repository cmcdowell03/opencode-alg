import type {
  TuiDialogSelectOption,
  TuiPlugin,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui"
import { MODEL_AGENTS, type ModelAgent } from "./types.ts"
import {
  configuredGlobalModel,
  configuredGlobalVariant,
  getGlobalConfig,
  saveGlobalAgentModel,
  type GlobalConfigRead,
} from "./global-model-config.ts"

type GlobalConfig = TuiPluginApi["state"]["config"]
type Provider = TuiPluginApi["state"]["provider"][number]

export interface ModelChoice {
  title: string
  value: string
  description: string
  category: string
  variants: string[]
}

const ROLE_TITLES: Record<ModelAgent, string> = {
  explorer: "Explorer",
  researcher: "Researcher",
  implementer: "Implementer",
  checker: "Checker",
}

export function modelCatalog(providers: readonly Provider[]): ModelChoice[] {
  return providers
    .flatMap((provider) => Object.values(provider.models).flatMap((model) => {
      if (model.status === "deprecated") return []
      const providerID = model.providerID || provider.id
      return [{
        title: model.name || model.id,
        value: `${providerID}/${model.id}`,
        description: model.id,
        category: provider.name || provider.id,
        variants: Object.entries(model.variants ?? {})
          .filter(([, settings]) => settings.disabled !== true)
          .map(([variant]) => variant)
          .sort((left, right) => left.localeCompare(right)),
      }]
    }))
    .sort((left, right) =>
      left.category.localeCompare(right.category) || left.title.localeCompare(right.title),
    )
}

export function roleChoices(config: GlobalConfig): TuiDialogSelectOption<ModelAgent>[] {
  return MODEL_AGENTS.map((agent) => ({
    title: ROLE_TITLES[agent],
    value: agent,
    description: `Current global: ${configuredGlobalModel(config, agent) ?? "Inherit OpenCode default"}` +
      ` · Effort: ${configuredGlobalVariant(config, agent) ?? "Default model effort"}`,
    category: "ALG",
  }))
}

function selectionLabel(model: string | null, variant: string | null): string {
  if (model === null) return "Inherit OpenCode default"
  return `${model} · ${variant ?? "Default model effort"}`
}

function successMessage(
  agent: ModelAgent,
  model: string | null,
  variant: string | null,
  method: "api" | "local-jsonc",
): string {
  const value = selectionLabel(model, variant)
  if (method === "api") {
    return `${ROLE_TITLES[agent]} saved globally as ${value}. Active server instances are disposed; quit and restart OpenCode before relying on the change.`
  }
  return `${ROLE_TITLES[agent]} saved globally as ${value}. Quit and restart OpenCode for the change to take effect.`
}

function saveSelection(
  api: TuiPluginApi,
  configRead: GlobalConfigRead,
  agent: ModelAgent,
  model: string | null,
  variant: string | null,
): void {
  void saveGlobalAgentModel({
    client: api.client,
    configDir: api.state.path.config,
    agent,
    model,
    variant,
    currentConfig: configRead.config,
    configResponseUrl: configRead.responseUrl,
  }).then((result) => {
    api.ui.dialog.clear()
    api.ui.toast({
      variant: "success",
      title: "ALG models saved",
      message: successMessage(agent, model, variant, result.method),
      duration: 8_000,
    })
  }).catch((error) => {
    api.ui.toast({
      variant: "error",
      title: "ALG models not saved",
      message: error instanceof Error ? error.message : String(error),
      duration: 8_000,
    })
  })
}

export function showEffortPicker(
  api: TuiPluginApi,
  configRead: GlobalConfigRead,
  agent: ModelAgent,
  model: ModelChoice,
): void {
  const config = configRead.config
  const configuredVariant = configuredGlobalModel(config, agent) === model.value
    ? configuredGlobalVariant(config, agent)
    : undefined
  const current = configuredVariant && model.variants.includes(configuredVariant)
    ? configuredVariant
    : null
  const choices: TuiDialogSelectOption<string | null>[] = [
    {
      title: "Default model effort",
      value: null,
      description: "Remove the global role variant override",
      category: "ALG",
    },
    ...model.variants.map((variant) => ({
      title: variant,
      value: variant,
      description: `Exact variant key for ${model.value}`,
      category: "Model effort",
    })),
  ]
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => api.ui.DialogSelect<string | null>({
    title: `ALG models · ${ROLE_TITLES[agent]} · ${model.value} · choose effort`,
    placeholder: "Search model effort variants",
    options: choices,
    current,
    onSelect(option) {
      saveSelection(api, configRead, agent, model.value, option.value)
    },
  }))
}

export function showModelPicker(api: TuiPluginApi, configRead: GlobalConfigRead, agent: ModelAgent): void {
  const config = configRead.config
  const current = configuredGlobalModel(config, agent) ?? null
  const choices: TuiDialogSelectOption<string | null>[] = [
    {
      title: "Inherit OpenCode default",
      value: null,
      description: "Remove the global role model and effort overrides",
      category: "ALG",
    },
    ...modelCatalog(api.state.provider).map((model) => ({
      title: model.title,
      value: model.value,
      description: model.description,
      category: model.category,
    })),
  ]
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => api.ui.DialogSelect<string | null>({
    title: `ALG models · ${ROLE_TITLES[agent]} · current: ${current ?? "Inherit OpenCode default"}`,
    placeholder: "Search connected models",
    options: choices,
    current,
    onSelect(option) {
      if (option.value === null) {
        saveSelection(api, configRead, agent, null, null)
        return
      }
      const selected = modelCatalog(api.state.provider).find((model) => model.value === option.value)
      if (!selected) {
        api.ui.toast({
          variant: "error",
          title: "ALG models not saved",
          message: `Selected model ${option.value} is no longer available in the runtime catalog.`,
          duration: 8_000,
        })
        return
      }
      if (!selected.variants.length) {
        saveSelection(api, configRead, agent, selected.value, null)
        return
      }
      showEffortPicker(api, configRead, agent, selected)
    },
  }))
}

export async function openAlgModels(api: TuiPluginApi): Promise<void> {
  try {
    const configRead = await getGlobalConfig(api.client)
    api.ui.dialog.setSize("large")
    api.ui.dialog.replace(() => api.ui.DialogSelect<ModelAgent>({
      title: "ALG models · choose a role",
      placeholder: "Search ALG roles",
      options: roleChoices(configRead.config),
      onSelect(option) {
        showModelPicker(api, configRead, option.value)
      },
    }))
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "ALG models unavailable",
      message: error instanceof Error ? error.message : String(error),
      duration: 8_000,
    })
  }
}

export const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "alg.models",
        title: "Choose agent models",
        category: "ALG",
        namespace: "palette",
        slashName: "alg-models",
        run() {
          return openAlgModels(api)
        },
      },
    ],
  })
  try {
    await api.client.app.log({
      service: "opencode-alg",
      level: "info",
      message: "ALG TUI command /alg-models registered",
    })
  } catch {
    // Registration remains usable when optional startup evidence cannot be logged.
  }
}

import type {
  TuiDialogSelectOption,
  TuiPlugin,
  TuiPluginApi,
} from "@opencode-ai/plugin/tui"
import { MODEL_AGENTS, type ModelAgent } from "./types.ts"
import {
  configuredGlobalModel,
  getGlobalConfig,
  saveGlobalAgentModel,
} from "./global-model-config.ts"

type GlobalConfig = TuiPluginApi["state"]["config"]
type Provider = TuiPluginApi["state"]["provider"][number]

export interface ModelChoice {
  title: string
  value: string | null
  description: string
  category: string
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
    description: `Current global: ${configuredGlobalModel(config, agent) ?? "Inherit OpenCode default"}`,
    category: "ALG",
  }))
}

function successMessage(agent: ModelAgent, model: string | null, method: "api" | "local-jsonc"): string {
  const value = model ?? "Inherit OpenCode default"
  if (method === "api") {
    return `${ROLE_TITLES[agent]} saved globally as ${value}. Active server instances are disposed; quit and restart OpenCode before relying on the change.`
  }
  return `${ROLE_TITLES[agent]} saved globally as ${value}. Quit and restart OpenCode for the change to take effect.`
}

export function showModelPicker(api: TuiPluginApi, config: GlobalConfig, agent: ModelAgent): void {
  const current = configuredGlobalModel(config, agent) ?? null
  const choices: ModelChoice[] = [
    {
      title: "Inherit OpenCode default",
      value: null,
      description: "Remove the global role model override",
      category: "ALG",
    },
    ...modelCatalog(api.state.provider),
  ]
  api.ui.dialog.setSize("large")
  api.ui.dialog.replace(() => api.ui.DialogSelect<string | null>({
    title: `ALG models · ${ROLE_TITLES[agent]} · current: ${current ?? "Inherit OpenCode default"}`,
    placeholder: "Search connected models",
    options: choices,
    current,
    onSelect(option) {
      void saveGlobalAgentModel({
        client: api.client,
        configDir: api.state.path.config,
        agent,
        model: option.value,
        currentConfig: config,
      }).then((result) => {
        api.ui.dialog.clear()
        api.ui.toast({
          variant: "success",
          title: "ALG models saved",
          message: successMessage(agent, option.value, result.method),
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
    },
  }))
}

export async function openAlgModels(api: TuiPluginApi): Promise<void> {
  try {
    const config = await getGlobalConfig(api.client)
    api.ui.dialog.setSize("large")
    api.ui.dialog.replace(() => api.ui.DialogSelect<ModelAgent>({
      title: "ALG models · choose a role",
      placeholder: "Search ALG roles",
      options: roleChoices(config),
      onSelect(option) {
        showModelPicker(api, config, option.value)
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

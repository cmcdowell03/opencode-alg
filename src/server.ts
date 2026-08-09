import type { PluginModule } from "@opencode-ai/plugin"
import { server } from "./index.ts"
import { ALG_PLUGIN_ID } from "./types.ts"

export default { id: ALG_PLUGIN_ID, server } satisfies PluginModule

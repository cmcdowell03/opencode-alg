import type { TuiPluginModule } from "@opencode-ai/plugin/tui"
import { tui } from "./tui-models.ts"
import { ALG_PLUGIN_ID } from "./types.ts"

export default { id: ALG_PLUGIN_ID, tui } satisfies TuiPluginModule

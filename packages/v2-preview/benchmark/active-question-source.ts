import { randomUUID } from "node:crypto"
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"

export const sourcePlugin = "alg-active-question-fixture"
export const sourceTool = "fixture_trace_read"
export const paths = {
  logger: "pressure-logger.json",
  mechanical: "mechanical-trace.json",
  inventory: "control-inventory.json",
  calibration: "reference-gauge.json",
} as const

type Options = { directory: string; audit: string }

export default {
  id: sourcePlugin,
  async setup(ctx) {
    const { directory, audit } = ctx.options as Options
    const registration = await ctx.tool.transform(editor => editor.add({
      name: sourceTool,
      description: "Read one local bench record. Available files are the logger, mechanical trace, inventory and reference gauge.",
      input: { type: "object", properties: { path: { type: "string", enum: Object.values(paths) } },
        required: ["path"], additionalProperties: false },
      options: { permission: sourceTool, codemode: false },
      async execute(input) {
        const path = (input as { path?: unknown }).path
        if (!Object.values<string>(paths).some(candidate => candidate === path) || typeof path !== "string")
          throw new Error("Unknown fixture source")
        const receipt = randomUUID()
        const content = await readFile(join(directory, path), "utf8")
        await appendFile(audit, JSON.stringify({ path, receipt }) + "\n")
        return { content: JSON.stringify({ path, receipt, content }) }
      },
    }))
    return () => registration.dispose()
  },
} satisfies Plugin.Plugin

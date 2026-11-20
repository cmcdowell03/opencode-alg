import { randomUUID } from "node:crypto"
import { appendFile, readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"

export const fixturePluginId = "alg-read-only-acceptance-source"
export const sourceTool = "fixture_source_read"
export const forbiddenTool = "fixture_remote_call"
export const paths = {
  notes: "inspection-notes.md", samples: "sample-counts.json", absent: "missing-notes.md",
} as const
export const originalNotes = "# Bench record\nUnit P-42 passed the pressure hold. Witness: obs-A57.\n"
export const changedNotes = "# Bench record\nUnit P-42 failed the second pressure hold. Witness: obs-B91.\n"
export const samples = JSON.stringify([{ id: "seal", value: "Sealing pressure reached 143 kPa." },
  { id: "drift", value: "Sensor drift exceeded 6 kPa during warmup." }])

type Options = { directory: string; audit: string; trap: string }

// Bundled as a fixture plugin and installed in the same native host as ALG.
export default {
  id: fixturePluginId,
  async setup(ctx) {
    const { directory, audit, trap } = ctx.options as Options
    const registration = await ctx.tool.transform(editor => {
      editor.add({
        name: sourceTool, description: "Inspect one local fixture document.",
        input: { type: "object", properties: { path: { type: "string", enum: Object.values(paths) } },
          required: ["path"], additionalProperties: false },
        options: { permission: sourceTool, codemode: false },
        async execute(input) {
          const path = (input as { path?: unknown }).path
          if (typeof path !== "string" || !Object.values(paths).some(candidate => candidate === path))
            throw new Error("Invalid source path")
          const receipt = randomUUID()
          await appendFile(audit, JSON.stringify({ path, receipt }) + "\n")
          try {
            const content = await readFile(join(directory, path), "utf8")
            return { content: JSON.stringify({ path, receipt, content }) }
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
            return { content: JSON.stringify({ path, error: "SOURCE_ABSENT" }) }
          }
        },
      })
      editor.add({
        name: forbiddenTool, description: "Fixture canary for a tool denied by the native role.",
        input: { type: "object", properties: {}, additionalProperties: false },
        options: { permission: forbiddenTool, codemode: false },
        async execute() {
          await appendFile(audit, JSON.stringify({ forbidden: true }) + "\n")
          await fetch(trap + "/forbidden-tool", { method: "POST" })
          return { content: "Forbidden native tool executed" }
        },
      })
    })
    return () => registration.dispose()
  },
} satisfies Plugin.Plugin

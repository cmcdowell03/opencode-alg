import { afterEach, describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parse } from "jsonc-parser"
import { runInstaller } from "../scripts/installer-core.ts"
import { decodeConfigBytes, encodeConfigText } from "../src/config-editor.ts"
import { removeProject, tempProject } from "./helpers.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sandboxes: string[] = []

function sandbox(): string {
  const path = tempProject("alg-installer-")
  sandboxes.push(path)
  return path
}

function backups(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.includes(".alg-backup-")).sort()
}

afterEach(() => {
  for (const path of sandboxes.splice(0)) removeProject(path)
})

describe("shared installer core", () => {
  test("preserves a UTF-8 BOM, comments, tuples, exact backup bytes, and idempotence", () => {
    const configDir = sandbox()
    const rootSpec = pathToFileURL(ROOT).href.replace(/\/$/, "")
    const legacy = pathToFileURL(join(ROOT, "src", "tui.ts")).href
    const tuiPath = join(configDir, "tui.json")
    const text = `{
  // BOM-bearing TUI config
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    ["${legacy}", { "keep": "tuple-options" }], // preserve tuple comment
    ["unrelated-tui", { "nested": true }],
  ],
  "theme": "keep-theme",
}
`
    const beforeBytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, "utf8")])
    writeFileSync(tuiPath, beforeBytes)

    const first = runInstaller({ root: ROOT, configDir, skipAgents: true })
    const tuiResult = first.configs.find((item) => item.path === tuiPath)!
    const afterBytes = readFileSync(tuiPath)
    expect(afterBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    const afterText = decodeConfigBytes(afterBytes, tuiPath).text
    expect(afterText).toContain("// BOM-bearing TUI config")
    expect(afterText).toContain("// preserve tuple comment")
    const data = parse(afterText) as any
    expect(data.theme).toBe("keep-theme")
    expect(data.plugin).toContainEqual([rootSpec, { keep: "tuple-options" }])
    expect(data.plugin).toContainEqual(["unrelated-tui", { nested: true }])
    expect(readFileSync(tuiResult.backup!)).toEqual(beforeBytes)

    const backupNames = backups(configDir)
    const second = runInstaller({ root: ROOT, configDir, skipAgents: true })
    expect(second.configs.every((item) => !item.changed && !item.backup)).toBe(true)
    expect(readFileSync(tuiPath)).toEqual(afterBytes)
    expect(backups(configDir)).toEqual(backupNames)
  })

  test("round-trips supported UTF-16 BOM encodings and fails closed on UTF-32", () => {
    for (const name of ["utf16le", "utf16be"] as const) {
      const configDir = sandbox()
      const tuiPath = join(configDir, "tui.json")
      const text = '{\n  // utf16\n  "plugin": [["other", { "keep": true }]],\n}\n'
      const before = encodeConfigText(text, { name, bom: true })
      writeFileSync(tuiPath, before)
      const result = runInstaller({ root: ROOT, configDir, skipAgents: true })
      const after = readFileSync(tuiPath)
      const decoded = decodeConfigBytes(after, tuiPath)
      expect(decoded.encoding).toEqual({ name, bom: true })
      expect(decoded.text).toContain("// utf16")
      expect((parse(decoded.text) as any).plugin[0]).toEqual(["other", { keep: true }])
      const backup = result.configs.find((item) => item.path === tuiPath)?.backup
      expect(readFileSync(backup!).equals(before)).toBe(true)
    }

    const configDir = sandbox()
    const serverPath = join(configDir, "opencode.jsonc")
    const tuiPath = join(configDir, "tui.json")
    const serverBefore = Buffer.from('{ "plugin": ["keep"] }\n')
    const unsupported = Buffer.from([0xff, 0xfe, 0x00, 0x00, 0x7b, 0x00, 0x00, 0x00])
    writeFileSync(serverPath, serverBefore)
    writeFileSync(tuiPath, unsupported)
    expect(() => runInstaller({ root: ROOT, configDir, skipAgents: true })).toThrow("Unsupported config encoding")
    expect(readFileSync(serverPath)).toEqual(serverBefore)
    expect(readFileSync(tuiPath)).toEqual(unsupported)
    expect(backups(configDir)).toEqual([])
  })

  test("preserves comments, trailing commas, tuples, and unrelated nested fields", () => {
    const configDir = sandbox()
    const rootSpec = pathToFileURL(ROOT).href.replace(/\/$/, "")
    const legacy = pathToFileURL(join(ROOT, "src", "index.ts")).href
    const serverPath = join(configDir, "opencode.jsonc")
    const tuiPath = join(configDir, "tui.json")
    const serverBefore = `{
  // keep top comment
  "$schema": "https://opencode.ai/config.json",
  "provider": { "custom": { "options": { "token": "secret", }, }, },
  "plugin": [
    ["${legacy}", { "setting": true }], // keep tuple and comment
    ["another-plugin", { "nested": { "keep": 42 } }],
  ],
  "agent": { "custom": { "model": "vendor/model" } },
}
`
    const tuiBefore = `{
  // TUI comment
  "$schema": "https://opencode.ai/tui.json",
  "theme": "custom",
  "plugin": [["other-tui", { "keep": true }],],
}
`
    writeFileSync(serverPath, serverBefore)
    writeFileSync(tuiPath, tuiBefore)

    const result = runInstaller({ root: ROOT, configDir, skipAgents: true })

    expect(result.spec).toBe(rootSpec)
    const serverAfter = readFileSync(serverPath, "utf8")
    const tuiAfter = readFileSync(tuiPath, "utf8")
    expect(serverAfter).toContain("// keep top comment")
    expect(serverAfter).toContain("// keep tuple and comment")
    expect(serverAfter).toContain('"token": "secret",')
    expect(serverAfter).toContain(`["${rootSpec}", { "setting": true }]`)
    expect(serverAfter).toContain('["another-plugin", { "nested": { "keep": 42 } }]')
    expect(tuiAfter).toContain("// TUI comment")
    expect((parse(tuiAfter) as any).plugin[0]).toEqual(["other-tui", { keep: true }])
    expect((parse(serverAfter) as any).agent.custom.model).toBe("vendor/model")
    expect((parse(tuiAfter) as any).plugin).toContain(rootSpec)

    const serverBackup = result.configs.find((item) => item.path === serverPath)?.backup
    const tuiBackup = result.configs.find((item) => item.path === tuiPath)?.backup
    expect(serverBackup).toBeTruthy()
    expect(tuiBackup).toBeTruthy()
    expect(readFileSync(serverBackup!, "utf8")).toBe(serverBefore)
    expect(readFileSync(tuiBackup!, "utf8")).toBe(tuiBefore)
  })

  test("rejects malformed JSONC before any config, backup, or agent write", () => {
    const configDir = sandbox()
    const serverPath = join(configDir, "opencode.jsonc")
    const tuiPath = join(configDir, "tui.json")
    const serverBefore = '{ "plugin": ["unrelated"] }\n'
    const malformed = '{ "plugin": [ }\n'
    writeFileSync(serverPath, serverBefore)
    writeFileSync(tuiPath, malformed)

    expect(() => runInstaller({ root: ROOT, configDir })).toThrow("Malformed JSONC")
    expect(readFileSync(serverPath, "utf8")).toBe(serverBefore)
    expect(readFileSync(tuiPath, "utf8")).toBe(malformed)
    expect(backups(configDir)).toEqual([])
    expect(existsSync(join(configDir, "agents"))).toBe(false)
  })

  test("is idempotent and creates no backups or writes on a repeated install", () => {
    const configDir = sandbox()
    const first = runInstaller({ root: ROOT, configDir, skipAgents: true })
    const serverPath = join(configDir, "opencode.jsonc")
    const tuiPath = join(configDir, "tui.json")
    const firstServer = readFileSync(serverPath, "utf8")
    const firstTui = readFileSync(tuiPath, "utf8")
    expect(first.configs.every((item) => item.changed)).toBe(true)
    expect(backups(configDir)).toEqual([])

    const second = runInstaller({ root: ROOT, configDir, skipAgents: true })
    expect(second.configs.every((item) => !item.changed && !item.backup)).toBe(true)
    expect(readFileSync(serverPath, "utf8")).toBe(firstServer)
    expect(readFileSync(tuiPath, "utf8")).toBe(firstTui)
    expect(backups(configDir)).toEqual([])
  })

  test("deduplicates only exact ALG registrations and preserves similarly named plugins", () => {
    const configDir = sandbox()
    const rootSpec = pathToFileURL(ROOT).href.replace(/\/$/, "")
    const legacy = pathToFileURL(join(ROOT, "src", "server.ts")).href
    writeFileSync(join(configDir, "opencode.jsonc"), JSON.stringify({
      plugin: ["my-alg-helper", legacy, [rootSpec, { keep: "options" }], "other"],
    }, null, 2))

    runInstaller({ root: ROOT, configDir, skipAgents: true })
    const data = parse(readFileSync(join(configDir, "opencode.jsonc"), "utf8")) as any
    expect(data.plugin).toContain("my-alg-helper")
    expect(data.plugin).toContain("other")
    const alg = data.plugin.filter((item: unknown) =>
      item === rootSpec || (Array.isArray(item) && item[0] === rootSpec),
    )
    expect(alg).toHaveLength(1)
    expect(alg[0]).toEqual([rootSpec, { keep: "options" }])
  })

  test("does not overwrite custom agents without force and backs up forced updates exactly", () => {
    const configDir = sandbox()
    const agentsDir = join(configDir, "agents")
    mkdirSync(agentsDir)
    const target = join(agentsDir, "explorer.md")
    const custom = "custom explorer\n"
    writeFileSync(target, custom)

    const normal = runInstaller({ root: ROOT, configDir })
    expect(readFileSync(target, "utf8")).toBe(custom)
    expect(normal.agents.find((item) => item.path === target)?.action).toBe("skipped")

    const forced = runInstaller({ root: ROOT, configDir, forceAgents: true })
    const explorer = forced.agents.find((item) => item.path === target)!
    expect(explorer.action).toBe("updated")
    expect(readFileSync(explorer.backup!, "utf8")).toBe(custom)
    expect(readFileSync(target, "utf8")).toBe(readFileSync(join(ROOT, "agents", "explorer.md"), "utf8"))
  })

  test("safe uninstall removes exact registrations while retaining unrelated plugins and custom agents", () => {
    const configDir = sandbox()
    runInstaller({ root: ROOT, configDir })
    const customAgent = join(configDir, "agents", "checker.md")
    writeFileSync(customAgent, "custom checker\n")

    const result = runInstaller({ root: ROOT, configDir, uninstall: true, removeAgents: true })
    for (const name of ["opencode.jsonc", "tui.json"]) {
      const data = parse(readFileSync(join(configDir, name), "utf8")) as any
      expect(data.plugin ?? []).not.toContain(result.spec)
    }
    expect(readFileSync(customAgent, "utf8")).toBe("custom checker\n")
    expect(result.agents.find((item) => item.path === customAgent)?.action).toBe("skipped")
  })

  test("second config write failure rolls back the first config exactly", () => {
    const configDir = sandbox()
    const serverPath = join(configDir, "opencode.jsonc")
    const tuiPath = join(configDir, "tui.json")
    const serverBefore = Buffer.from('{ "plugin": ["server-before"], "keep": 1 }\n')
    const tuiBefore = Buffer.from('{ "plugin": ["tui-before"], "keep": 2 }\n')
    writeFileSync(serverPath, serverBefore)
    writeFileSync(tuiPath, tuiBefore)
    expect(() => runInstaller({
      root: ROOT,
      configDir,
      skipAgents: true,
      faults: {
        beforeConfigWrite(_path, index) {
          if (index === 1) throw new Error("injected second config failure")
        },
      },
    })).toThrow("injected second config failure")
    expect(readFileSync(serverPath)).toEqual(serverBefore)
    expect(readFileSync(tuiPath)).toEqual(tuiBefore)
  })

  test("agent failure after config changes rolls back configs and created agents", () => {
    const configDir = sandbox()
    const serverPath = join(configDir, "opencode.jsonc")
    const tuiPath = join(configDir, "tui.json")
    const serverBefore = Buffer.from('{ "plugin": ["server-before"] }\n')
    const tuiBefore = Buffer.from('{ "plugin": ["tui-before"] }\n')
    writeFileSync(serverPath, serverBefore)
    writeFileSync(tuiPath, tuiBefore)
    expect(() => runInstaller({
      root: ROOT,
      configDir,
      faults: {
        beforeAgentWrite(_path, index) {
          if (index === 1) throw new Error("injected agent failure")
        },
      },
    })).toThrow("injected agent failure")
    expect(readFileSync(serverPath)).toEqual(serverBefore)
    expect(readFileSync(tuiPath)).toEqual(tuiBefore)
    const agentsDir = join(configDir, "agents")
    expect(existsSync(agentsDir) ? readdirSync(agentsDir).filter((name) => name.endsWith(".md")) : []).toEqual([])
  })
})

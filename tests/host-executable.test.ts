import { expect, test } from "bun:test"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveOpenCodeExecutable } from "../scripts/host-executable.ts"
import { tempProject, removeProject } from "./helpers.ts"

test("Windows npm host discovery resolves only the packaged binary, never shell text", () => {
  const root = tempProject("alg host discovery ")
  try {
    writeFileSync(join(root, "opencode.cmd"), "untrusted shell text that must never execute")
    expect(() => resolveOpenCodeExecutable("opencode", { platform: "win32", pathEntries: [root] })).toThrow("no packaged executable")
    const bin = join(root, "node_modules", "opencode-ai", "bin")
    mkdirSync(bin, { recursive: true })
    const executable = join(bin, "opencode.exe")
    writeFileSync(executable, "synthetic binary fixture")
    expect(resolveOpenCodeExecutable("opencode", { platform: "win32", pathEntries: [root] })).toBe(realpathSync.native(executable))
    expect(resolveOpenCodeExecutable(executable, { platform: "win32" })).toBe(realpathSync.native(executable))
    expect(() => resolveOpenCodeExecutable(join(root, "opencode.cmd"), { platform: "win32" })).toThrow("regular executable")
    expect(() => resolveOpenCodeExecutable("./opencode.exe")).toThrow("absolute")
  } finally { removeProject(root) }
})

test("native host discovery preserves the selected PATH entry and rejects missing hosts", () => {
  const root = tempProject("alg native host ")
  try {
    const executable = join(root, "opencode")
    writeFileSync(executable, "synthetic executable")
    expect(resolveOpenCodeExecutable("opencode", { platform: "linux", pathEntries: [root] })).toBe(realpathSync.native(executable))
    expect(() => resolveOpenCodeExecutable("opencode", { platform: "linux", pathEntries: [] })).toThrow("not found")
  } finally { removeProject(root) }
})

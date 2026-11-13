import { existsSync, realpathSync, statSync } from "node:fs"
import { delimiter, isAbsolute, join } from "node:path"

/** Resolve a host without executing npm/shell wrappers on Windows. */
export function resolveOpenCodeExecutable(requested = process.env.OPENCODE_BIN?.trim() || "opencode", options: {
  platform?: NodeJS.Platform; pathEntries?: string[]
} = {}): string {
  const platform = options.platform ?? process.platform
  const regular = (path: string) => { try { return statSync(path).isFile() } catch { return false } }
  const direct = (path: string) => {
    const canonical = realpathSync.native(path)
    if (!regular(canonical) || (platform === "win32" && !/\.exe$/i.test(canonical))) {
      throw new Error("OpenCode must resolve to a regular executable; set OPENCODE_BIN to its absolute binary path")
    }
    return canonical
  }
  if (isAbsolute(requested)) return direct(requested)
  if (requested !== "opencode") throw new Error("OPENCODE_BIN must be an absolute executable path")
  const entries = options.pathEntries ?? (process.env.PATH ?? process.env.Path ?? "").split(delimiter)
  for (const entry of entries) {
    const directory = entry.replace(/^"|"$/g, "")
    if (!directory || !isAbsolute(directory)) continue
    const binary = join(directory, platform === "win32" ? "opencode.exe" : "opencode")
    if (regular(binary)) return direct(binary)
    if (platform === "win32" && ["opencode.cmd", "opencode.ps1", "opencode.bat"].some((name) => existsSync(join(directory, name)))) {
      const packaged = join(directory, "node_modules", "opencode-ai", "bin", "opencode.exe")
      if (regular(packaged)) return direct(packaged)
      throw new Error("OpenCode npm wrapper has no packaged executable; set OPENCODE_BIN to its absolute binary path")
    }
  }
  throw new Error("OpenCode executable was not found on PATH; install OpenCode 1 or set OPENCODE_BIN")
}

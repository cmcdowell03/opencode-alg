import { existsSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, join, relative } from "node:path"

export interface NpmInvocation {
  executable: string
  argsPrefix: string[]
}

export function resolveNpmInvocation(options: {
  platform?: NodeJS.Platform
  pathValue?: string
  pathEntries?: string[]
  filesystem?: {
    exists(path: string): boolean
    isFile(path: string): boolean
    realpath(path: string): string
  }
} = {}): NpmInvocation {
  const filesystem = options.filesystem ?? {
    exists: existsSync,
    isFile: (path: string) => statSync(path).isFile(),
    realpath: (path: string) => realpathSync.native(path),
  }
  const platform = options.platform ?? process.platform
  const pathValue = options.pathValue ?? process.env.PATH ?? process.env.Path ?? ""
  const entries = options.pathEntries ?? (() => {
    if (platform !== "win32") return pathValue.split(":")
    if (pathValue.includes(";")) return pathValue.split(";")
    // Native processes launched from MSYS/Git sh can inherit /c/... colon PATHs.
    return pathValue.split(":").map((entry) => {
      const match = entry.match(/^\/([A-Za-z])\/(.*)$/)
      return match ? `${match[1]}:/${match[2]}` : entry
    })
  })()
  const name = platform === "win32" ? "npm.cmd" : "npm"
  let shim: string | undefined
  for (const raw of entries) {
    if (!raw) continue
    const candidate = join(raw.replace(/^"|"$/g, ""), name)
    if (filesystem.exists(candidate)) { shim = candidate; break }
  }
  if (!shim || !filesystem.isFile(shim)) throw new Error(`Unable to resolve regular ${name} from PATH`)
  const installation = filesystem.realpath(dirname(shim))
  const contained = (candidate: string, label: string): string => {
    const canonical = filesystem.realpath(candidate)
    const fromRoot = relative(installation, canonical)
    if (fromRoot === "" || fromRoot.startsWith("..") || isAbsolute(fromRoot)) throw new Error(`npm ${label} escapes its installation directory`)
    return canonical
  }
  const canonicalShim = contained(shim, "shim")
  if (platform !== "win32") return { executable: canonicalShim, argsPrefix: [] }

  const containedFile = (candidate: string, label: string): string => {
    if (!filesystem.exists(candidate) || !filesystem.isFile(candidate)) throw new Error(`Unable to resolve npm ${label} beside npm.cmd`)
    return contained(candidate, label)
  }
  // npm.cmd is discovery-only. Never parse or execute it.
  return {
    executable: containedFile(join(installation, "node.exe"), "node executable"),
    argsPrefix: [containedFile(join(installation, "node_modules", "npm", "bin", "npm-cli.js"), "CLI")],
  }
}

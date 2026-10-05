import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs"
import { dirname, isAbsolute, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { AlgPluginOptionsSchema } from "./skill-evolution-schemas.ts"
import type { z } from "zod"

export const ALG_CONFIG_OVERRIDE_ENV = "OPENCODE_ALG_CONFIG"
export const ALG_CONFIG_MAX_BYTES = 64 * 1024
export type AlgPluginOptions = z.infer<typeof AlgPluginOptionsSchema>
export type PluginConfigurationSource = "sdk" | "package-sidecar" | "legacy-sidecar" | "override" | "defaults" | "sdk+sidecar"

export interface ResolvedPluginConfiguration {
  options: AlgPluginOptions
  source: PluginConfigurationSource
  sidecar_present: boolean
}

export interface PluginConfigurationEnvironment {
  root?: string
  env?: NodeJS.ProcessEnv
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..")
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOENT" || code === "ENOTDIR"
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left)
  const normalizedRight = resolve(right)
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight
}

function safeFileState(path: string): "missing" | "present" {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ALG configuration sidecar must be a regular, non-symlink file")
    if (!samePath(realpathSync.native(path), path)) throw new Error("ALG configuration sidecar must not traverse a symlink or junction")
    return "present"
  } catch (error) {
    if (missing(error)) return "missing"
    if (error instanceof Error && error.message.startsWith("ALG configuration")) throw error
    throw new Error("ALG configuration sidecar is unsafe or unreadable")
  }
}

function readSidecar(path: string): unknown {
  try {
    const before = lstatSync(path)
    if (!before.isFile() || before.isSymbolicLink() || !samePath(realpathSync.native(path), path)) {
      throw new Error("ALG configuration sidecar must be a regular, non-symlink file")
    }
    if (before.size > ALG_CONFIG_MAX_BYTES) throw new Error(`ALG configuration sidecar exceeds ${ALG_CONFIG_MAX_BYTES} bytes`)
    const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0
    const descriptor = openSync(path, constants.O_RDONLY | noFollow)
    try {
      const opened = fstatSync(descriptor)
      if (!opened.isFile() || opened.size !== before.size || opened.dev !== before.dev || opened.ino !== before.ino) {
        throw new Error("ALG configuration sidecar changed while being read")
      }
      const bytes = readFileSync(descriptor)
      const after = fstatSync(descriptor)
      if (bytes.byteLength !== opened.size || bytes.byteLength > ALG_CONFIG_MAX_BYTES || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) {
        throw new Error("ALG configuration sidecar changed while being read")
      }
      try {
        return JSON.parse(bytes.toString("utf8")) as unknown
      } catch {
        throw new Error("ALG configuration sidecar contains malformed JSON")
      }
    } finally {
      closeSync(descriptor)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("ALG configuration")) throw error
    throw new Error("ALG configuration sidecar is unsafe or unreadable")
  }
}

function sanitizedIssues(error: { issues: readonly { path: PropertyKey[]; code: string }[] }): string {
  // Zod paths can contain attacker supplied unknown-key names; expose only its fixed issue codes.
  const issues = error.issues.slice(0, 8).map((issue) => issue.code)
  return issues.join(",") || "schema:invalid"
}

function parseSidecar(value: unknown): AlgPluginOptions {
  const parsed = AlgPluginOptionsSchema.safeParse(value)
  if (!parsed.success) throw new Error(`ALG configuration sidecar does not match the strict options schema (${sanitizedIssues(parsed.error)})`)
  return parsed.data
}

function parseSdkOptions(value: unknown): AlgPluginOptions {
  const parsed = AlgPluginOptionsSchema.safeParse(value ?? {})
  if (!parsed.success) throw new Error(`ALG SDK options do not match the strict options schema (${sanitizedIssues(parsed.error)})`)
  return parsed.data
}

function chooseSidecar(root: string, env: NodeJS.ProcessEnv): { path?: string; source: PluginConfigurationSource } {
  const override = env[ALG_CONFIG_OVERRIDE_ENV]
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error(`${ALG_CONFIG_OVERRIDE_ENV} must name an absolute path`)
    if (safeFileState(override) === "missing") throw new Error(`${ALG_CONFIG_OVERRIDE_ENV} names a missing configuration file`)
    return { path: resolve(override), source: "override" }
  }

  const packageConfig = join(root, "alg-plugin-config.json")
  const legacyConfig = join(root, "src", "alg-plugin-config.json")
  const packageState = safeFileState(packageConfig)
  const legacyState = safeFileState(legacyConfig)
  if (packageState === "present" && legacyState === "present") {
    throw new Error("ALG configuration is ambiguous: both package-root and legacy src sidecars exist")
  }
  if (packageState === "present") return { path: packageConfig, source: "package-sidecar" }
  if (legacyState === "present") return { path: legacyConfig, source: "legacy-sidecar" }
  return { source: "defaults" }
}

/** Validate SDK and sidecar sections independently; an SDK section replaces its sidecar section whole. */
export function resolvePluginConfiguration(
  sdkOptions: unknown,
  environment: PluginConfigurationEnvironment = {},
): ResolvedPluginConfiguration {
  const sdk = parseSdkOptions(sdkOptions)
  const root = resolve(environment.root ?? packageRoot())
  const env = environment.env ?? process.env
  const selected = chooseSidecar(root, env)
  const sidecar = selected.path ? parseSidecar(readSidecar(selected.path)) : {}
  const sdkSections = [sdk.skillEvolution, sdk.sessionMemory, sdk.environmentMemory].filter((section) => section !== undefined).length
  const sidecarSectionsUsed = (sdk.skillEvolution === undefined && sidecar.skillEvolution !== undefined) ||
    (sdk.sessionMemory === undefined && sidecar.sessionMemory !== undefined) ||
    (sdk.environmentMemory === undefined && sidecar.environmentMemory !== undefined)
  const merged = {
    skillEvolution: sdk.skillEvolution ?? sidecar.skillEvolution,
    sessionMemory: sdk.sessionMemory ?? sidecar.sessionMemory,
    environmentMemory: sdk.environmentMemory ?? sidecar.environmentMemory,
  }
  return {
    options: AlgPluginOptionsSchema.parse(merged),
    source: sdkSections && sidecarSectionsUsed ? "sdk+sidecar" : sdkSections ? "sdk" : selected.source,
    sidecar_present: selected.path !== undefined,
  }
}

/** Offline-safe sidecar validation with sanitized errors for diagnostic output. */
export function inspectPluginConfiguration(environment: PluginConfigurationEnvironment = {}): {
  status: "absent" | "valid" | "invalid"
  source: PluginConfigurationSource
  error?: string
} {
  try {
    const resolved = resolvePluginConfiguration(undefined, environment)
    return { status: resolved.sidecar_present ? "valid" : "absent", source: resolved.source }
  } catch (error) {
    return {
      status: "invalid",
      source: "defaults",
      error: error instanceof Error ? error.message.slice(0, 500) : "ALG configuration is invalid",
    }
  }
}

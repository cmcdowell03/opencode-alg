import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { AlgPluginOptionsSchema } from "../src/skill-evolution-schemas.ts"
import { inspectPluginConfiguration } from "../src/plugin-configuration.ts"
import { computeAlgSourceIdentity } from "../src/source-identity.ts"

export interface OfflineDiagnosticsReport {
  protocol: "alg-offline-diagnostics-v1"
  network_used: false
  git_used: false
  live_opencode_inspected: false
  parser_fixtures: { passed: number; total: number; results: Record<string, boolean> }
  disk_source_identity: { status: "available"; digest: string; files: number; bytes: number } | { status: "unavailable" }
  configuration: ReturnType<typeof inspectPluginConfiguration>
  dependencies: { available: string[]; missing: string[] }
  runtime_imports: { server: boolean; tui: boolean }
}

function parserFixtures(): OfflineDiagnosticsReport["parser_fixtures"] {
  const results = {
    accepts_empty_defaults: AlgPluginOptionsSchema.safeParse({}).success,
    rejects_unknown_root_key: !AlgPluginOptionsSchema.safeParse({ unexpected: "fixture" }).success,
    rejects_invalid_memory_mode: !AlgPluginOptionsSchema.safeParse({ sessionMemory: { mode: "automatic" } }).success,
  }
  return { passed: Object.values(results).filter(Boolean).length, total: Object.keys(results).length, results }
}

function installedVersion(root: string, dependency: string): string | undefined {
  let directory = root
  for (let level = 0; level < 16; level++) {
    try {
      const metadata = JSON.parse(readFileSync(join(directory, "node_modules", ...dependency.split("/"), "package.json"), "utf8")) as {
        name?: unknown; version?: unknown
      }
      if (metadata.name === dependency && typeof metadata.version === "string") return metadata.version
    } catch { /* inspect the next ancestor; never invoke an installer */ }
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

function dependencyAvailability(root: string): OfflineDiagnosticsReport["dependencies"] {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, unknown> }
    const required = Object.keys(pkg.dependencies ?? {}).sort()
    const available: string[] = []
    const missing: string[] = []
    for (const dependency of required) {
      // Package dependencies are pinned exactly; the ESM-only plugin has no
      // CommonJS `require` export, so require.resolve would report a false miss.
      if (installedVersion(root, dependency) === pkg.dependencies?.[dependency]) available.push(dependency)
      else missing.push(dependency)
    }
    return { available, missing }
  } catch {
    return { available: [], missing: ["package-metadata-unavailable"] }
  }
}

async function runtimeImports(root: string, dependenciesReady: boolean): Promise<OfflineDiagnosticsReport["runtime_imports"]> {
  const result = { server: false, tui: false }
  if (!dependenciesReady) return result
  try { await import(pathToFileURL(join(root, "src", "server.ts")).href); result.server = true } catch {}
  try { await import(pathToFileURL(join(root, "src", "tui.ts")).href); result.tui = true } catch {}
  return result
}

export async function collectOfflineDiagnostics(env: NodeJS.ProcessEnv = process.env): Promise<OfflineDiagnosticsReport> {
  // Always inspect the package containing this script, whose modules were
  // imported above. An arbitrary --root would mix checkout parser results
  // with a different package's disk digest.
  const canonicalRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  let disk_source_identity: OfflineDiagnosticsReport["disk_source_identity"]
  try {
    const identity = computeAlgSourceIdentity(canonicalRoot)
    disk_source_identity = { status: "available", digest: identity.digest, files: identity.file_count, bytes: identity.total_bytes }
  } catch {
    disk_source_identity = { status: "unavailable" }
  }
  const dependencies = dependencyAvailability(canonicalRoot)
  return {
    protocol: "alg-offline-diagnostics-v1",
    network_used: false,
    git_used: false,
    live_opencode_inspected: false,
    parser_fixtures: parserFixtures(),
    disk_source_identity,
    configuration: inspectPluginConfiguration({ root: canonicalRoot, env }),
    dependencies,
    runtime_imports: await runtimeImports(canonicalRoot, dependencies.missing.length === 0),
  }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 2) throw new Error("run offline diagnostics from the target package without arguments")
    const report = await collectOfflineDiagnostics()
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.parser_fixtures.passed !== report.parser_fixtures.total || report.disk_source_identity.status !== "available" ||
      report.configuration.status === "invalid" || report.dependencies.missing.length > 0 ||
      !report.runtime_imports.server || !report.runtime_imports.tui) process.exitCode = 1
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "offline diagnostics failed"}\n`)
    process.exitCode = 2
  }
}

import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  commitTextPlans,
  atomicReplace,
  exactBackup,
  planPluginConfig,
  type TextFilePlan,
} from "../src/config-editor.ts"
import {
  canonicalDirectory,
  canonicalRootPath,
  resolveContainedPath,
} from "../src/paths.ts"

export interface InstallerFaults {
  beforeConfigWrite?: (path: string, index: number) => void
  beforeAgentWrite?: (path: string, index: number) => void
}

export interface InstallerOptions {
  root: string
  configDir: string
  skipAgents?: boolean
  forceAgents?: boolean
  uninstall?: boolean
  removeAgents?: boolean
  /** Fault injection for transactional tests. */
  faults?: InstallerFaults
}

export interface InstallerResult {
  spec: string
  configs: Array<{ path: string; changed: boolean; backup?: string }>
  agents: Array<{ path: string; action: "created" | "updated" | "removed" | "unchanged" | "skipped"; backup?: string }>
}

const SERVER_SCHEMA = "https://opencode.ai/config.json"
const TUI_SCHEMA = "https://opencode.ai/tui.json"

function knownSpecs(root: string, desired: string): string[] {
  return [
    desired,
    `${desired}/`,
    pathToFileURL(join(root, "src", "index.ts")).href,
    pathToFileURL(join(root, "src", "server.ts")).href,
    pathToFileURL(join(root, "src", "tui.ts")).href,
    "opencode-alg",
  ]
}

function planConfigs(options: InstallerOptions, desired: string): TextFilePlan[] {
  const known = knownSpecs(options.root, desired)
  return [
    planPluginConfig({
      path: resolveContainedPath(options.configDir, "opencode.jsonc"),
      desiredSpec: desired,
      knownSpecs: known,
      schema: SERVER_SCHEMA,
      uninstall: options.uninstall,
    }),
    planPluginConfig({
      path: resolveContainedPath(options.configDir, "tui.json"),
      desiredSpec: desired,
      knownSpecs: known,
      schema: TUI_SCHEMA,
      uninstall: options.uninstall,
    }),
  ]
}

function bundledAgents(root: string): Array<{ source: string; name: string; bytes: Buffer }> {
  const dir = resolveContainedPath(root, "agents")
  if (!existsSync(dir)) throw new Error(`Missing bundled agents directory: ${dir}`)
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => {
      const source = resolveContainedPath(dir, name)
      return { source, name, bytes: readFileSync(source) }
    })
}

interface AgentPlan {
  path: string
  action: InstallerResult["agents"][number]["action"]
  before?: Buffer
  after?: Buffer
}

function planAgents(
  options: InstallerOptions,
  bundled: ReturnType<typeof bundledAgents>,
): AgentPlan[] {
  if (options.skipAgents) return []
  const result: AgentPlan[] = []

  for (const agent of bundled) {
    const target = resolveContainedPath(options.configDir, "agents", agent.name)
    if (options.uninstall) {
      if (!options.removeAgents || !existsSync(target)) {
        result.push({ path: target, action: "unchanged" })
        continue
      }
      const current = readFileSync(target)
      if (!current.equals(agent.bytes)) {
        result.push({ path: target, action: "skipped" })
        continue
      }
      result.push({ path: target, action: "removed", before: current })
      continue
    }

    if (!existsSync(target)) {
      result.push({ path: target, action: "created", after: agent.bytes })
      continue
    }
    const current = readFileSync(target)
    if (current.equals(agent.bytes)) {
      result.push({ path: target, action: "unchanged" })
      continue
    }
    if (!options.forceAgents) {
      result.push({ path: target, action: "skipped" })
      continue
    }
    result.push({ path: target, action: "updated", before: current, after: agent.bytes })
  }
  return result
}

function commitAgents(
  plans: AgentPlan[],
  faults?: InstallerFaults,
): InstallerResult["agents"] {
  const result: InstallerResult["agents"] = []
  let writeIndex = 0
  for (const plan of plans) {
    if (plan.action === "unchanged" || plan.action === "skipped") {
      result.push({ path: plan.path, action: plan.action })
      continue
    }
    const backup = plan.before ? exactBackup(plan.path) : undefined
    faults?.beforeAgentWrite?.(plan.path, writeIndex++)
    if (plan.action === "removed") rmSync(plan.path, { force: true })
    else atomicReplace(plan.path, plan.after!)
    result.push({ path: plan.path, action: plan.action, backup })
  }
  return result
}

function rollbackPaths(snapshots: Map<string, Buffer | undefined>): void {
  const errors: unknown[] = []
  for (const [path, original] of [...snapshots.entries()].reverse()) {
    try {
      if (original === undefined) rmSync(path, { force: true })
      else atomicReplace(path, original)
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, "installer rollback was incomplete")
}

export function runInstaller(input: InstallerOptions): InstallerResult {
  const options = {
    ...input,
    root: canonicalDirectory(resolve(input.root)),
    configDir: canonicalRootPath(resolve(input.configDir)),
  }
  const packageFile = resolveContainedPath(options.root, "package.json")
  if (!existsSync(packageFile)) throw new Error(`Missing package root: ${packageFile}`)
  const desired = pathToFileURL(options.root).href.replace(/\/$/, "")

  // Parse and validate every existing config before any backup or write.
  const plans = planConfigs(options, desired)
  const agentsToInstall = options.skipAgents ? [] : bundledAgents(options.root)
  const agentPlans = planAgents(options, agentsToInstall)
  const configSnapshots = new Map(
    plans.filter((plan) => plan.changed).map((plan) => [
      plan.path,
      existsSync(plan.path) ? readFileSync(plan.path) : undefined,
    ]),
  )
  const agentSnapshots = new Map(
    agentPlans
      .filter((plan) => plan.action === "created" || plan.action === "updated" || plan.action === "removed")
      .map((plan) => [plan.path, plan.before]),
  )
  const committed = commitTextPlans(plans, {
    backups: true,
    beforeWrite(plan, index) {
      options.faults?.beforeConfigWrite?.(plan.path, index)
    },
  })
  const byPath = new Map(committed.map((item) => [item.path, item.backup]))
  let agents: InstallerResult["agents"]
  try {
    agents = commitAgents(agentPlans, options.faults)
  } catch (error) {
    const rollbackErrors: unknown[] = []
    try {
      rollbackPaths(agentSnapshots)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    try {
      rollbackPaths(configSnapshots)
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError)
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "installer failed and rollback was incomplete")
    }
    throw error
  }
  return {
    spec: desired,
    configs: plans.map((plan) => ({ path: plan.path, changed: plan.changed, backup: byPath.get(plan.path) })),
    agents,
  }
}

interface CliOptions {
  configDir?: string
  skipAgents: boolean
  forceAgents: boolean
  uninstall: boolean
  removeAgents: boolean
}

function parseArgs(args: string[]): CliOptions {
  const out: CliOptions = {
    skipAgents: false,
    forceAgents: false,
    uninstall: false,
    removeAgents: false,
  }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--config-dir") {
      const value = args[++index]
      if (!value) throw new Error("--config-dir requires a value")
      out.configDir = value
    } else if (arg === "--skip-agents") out.skipAgents = true
    else if (arg === "--force-agents" || arg === "--update-agents") out.forceAgents = true
    else if (arg === "--uninstall") out.uninstall = true
    else if (arg === "--remove-agents") out.removeAgents = true
    else if (!arg.startsWith("-") && !out.configDir) out.configDir = arg
    else throw new Error(`Unknown installer argument: ${arg}`)
  }
  if (out.removeAgents && !out.uninstall) throw new Error("--remove-agents requires --uninstall")
  return out
}

function printResult(result: InstallerResult): void {
  for (const config of result.configs) {
    console.log(`${config.changed ? "Updated" : "Unchanged"} ${config.path}`)
    if (config.backup) console.log(`  backup: ${config.backup}`)
  }
  for (const agent of result.agents) {
    console.log(`${agent.action}: ${agent.path}`)
    if (agent.backup) console.log(`  backup: ${agent.backup}`)
  }
  console.log(`ALG package spec: ${result.spec}`)
  console.log("Quit and restart OpenCode for plugin/config changes to take effect.")
}

if (import.meta.main) {
  try {
    const cli = parseArgs(process.argv.slice(2))
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
    const home = process.env.USERPROFILE || process.env.HOME
    if (!cli.configDir && !home) throw new Error("Cannot determine home directory; pass --config-dir")
    const configDir = cli.configDir ?? join(home!, ".config", "opencode")
    printResult(runInstaller({ root, configDir, ...cli }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

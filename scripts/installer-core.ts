import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import {
  commitFileCasPlans,
  encodeConfigText,
  planPluginConfig,
  readStableRegularFile,
  type FileCasPlan,
  type TextFilePlan,
} from "../src/config-editor.ts"
import {
  canonicalDirectory,
  canonicalRootPath,
  resolveContainedPath,
} from "../src/paths.ts"

export interface InstallerFaults {
  afterPlanning?: () => void
  beforeConfigWrite?: (path: string, index: number) => void
  beforeAgentWrite?: (path: string, index: number) => void
  afterFileClaim?: (path: string, kind: "config" | "agent", index: number) => void
  afterFileUnlink?: (path: string, kind: "config" | "agent", index: number) => void
  beforeFilePublish?: (path: string, kind: "config" | "agent", index: number) => void
  afterFilePublish?: (path: string, kind: "config" | "agent", index: number) => void
  beforeRollback?: () => void
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
  expectedIdentity: import("../src/config-editor.ts").FileIdentity | null
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
        result.push({ path: target, action: "unchanged", expectedIdentity: null })
        continue
      }
      const stable = readStableRegularFile(target)
      const current = stable.bytes
      if (!current.equals(agent.bytes)) {
        result.push({ path: target, action: "skipped", before: current, after: current, expectedIdentity: stable.identity })
        continue
      }
      result.push({ path: target, action: "removed", before: current, expectedIdentity: stable.identity })
      continue
    }

    if (!existsSync(target)) {
      result.push({ path: target, action: "created", after: agent.bytes, expectedIdentity: null })
      continue
    }
    const stable = readStableRegularFile(target)
    const current = stable.bytes
    if (current.equals(agent.bytes)) {
      result.push({ path: target, action: "unchanged", before: current, after: current, expectedIdentity: stable.identity })
      continue
    }
    if (!options.forceAgents) {
      result.push({ path: target, action: "skipped", before: current, after: current, expectedIdentity: stable.identity })
      continue
    }
    result.push({ path: target, action: "updated", before: current, after: agent.bytes, expectedIdentity: stable.identity })
  }
  return result
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
  const changedConfigs = plans.filter((plan) => plan.changed)
  const changedAgents = agentPlans.filter((plan) => plan.action === "created" || plan.action === "updated" || plan.action === "removed")
  const filePlans: FileCasPlan[] = [
    ...plans.map((plan) => ({
      path: plan.path,
      before: plan.before === undefined ? undefined : encodeConfigText(plan.before, plan.encoding),
      after: plan.changed ? encodeConfigText(plan.after, plan.encoding) : plan.before === undefined ? undefined : encodeConfigText(plan.before, plan.encoding),
      expectedIdentity: plan.expectedIdentity,
    })),
    ...agentPlans.map((plan) => ({ path: plan.path, before: plan.before, after: plan.after, expectedIdentity: plan.expectedIdentity })),
  ]
  options.faults?.afterPlanning?.()
  const configIndexes = new Map(plans.map((plan, index) => [resolve(plan.path), index]))
  const agentIndexes = new Map(agentPlans.map((plan, index) => [resolve(plan.path), index]))
  const fileKind = (path: string): { kind: "config" | "agent"; index: number } => {
    const canonical = resolve(path)
    const configIndex = configIndexes.get(canonical)
    return configIndex === undefined
      ? { kind: "agent", index: agentIndexes.get(canonical)! }
      : { kind: "config", index: configIndex }
  }
  const committed = commitFileCasPlans(filePlans, {
    backups: true,
    hooks: {
      afterClaim(plan) {
        const item = fileKind(plan.path)
        options.faults?.afterFileClaim?.(plan.path, item.kind, item.index)
      },
      beforeMutation(plan) {
        const item = fileKind(plan.path)
        if (item.kind === "config") options.faults?.beforeConfigWrite?.(plan.path, item.index)
        else options.faults?.beforeAgentWrite?.(plan.path, item.index)
      },
      afterUnlink(plan) {
        const item = fileKind(plan.path)
        options.faults?.afterFileUnlink?.(plan.path, item.kind, item.index)
      },
      beforePublish(plan) {
        const item = fileKind(plan.path)
        options.faults?.beforeFilePublish?.(plan.path, item.kind, item.index)
      },
      afterPublish(plan) {
        const item = fileKind(plan.path)
        options.faults?.afterFilePublish?.(plan.path, item.kind, item.index)
      },
      beforeRollback() {
        options.faults?.beforeRollback?.()
      },
    },
  })
  const byPath = new Map(committed.map((item) => [item.path, item.backup]))
  return {
    spec: desired,
    configs: plans.map((plan) => ({ path: plan.path, changed: plan.changed, backup: byPath.get(plan.path) })),
    agents: agentPlans.map((plan) => ({ path: plan.path, action: plan.action, backup: byPath.get(plan.path) })),
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

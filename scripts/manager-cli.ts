import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  managerErrorMessage,
  runManager,
  serializeManagerJson,
  type AgentPolicy,
  type ManagerCommand,
  type ManagerOptions,
  type ManagerResult,
} from "./manager-core.ts"

const COMMANDS = new Set<ManagerCommand>(["install", "update", "doctor", "rollback", "uninstall"])

function usage(): string {
  return `Usage: alg <install|update|doctor|rollback|uninstall> [options]

Common options:
  --config-dir <absolute>       OpenCode config directory
  --install-root <absolute>     Managed package root (default: config/plugins/opencode-alg)
  --source <clean-git-path>     Resolve from an exact tagged local source
  --remote <url-or-path>        Trusted Git remote
  --tag <vMAJOR.MINOR.PATCH>    Exact stable tag
  --version <MAJOR.MINOR.PATCH> Exact stable version
  --agents <managed|skip|force> Bundled-agent policy (default: managed)
  --enable-capability excel     Explicitly enable the pinned Excel MCP pack
  --disable-capability excel    Explicitly disable the managed Excel MCP pack
  --excel-root <absolute>       Dedicated existing .xlsx staging root
  --dry-run                     Validate and stage without config/agent/receipt writes
  --json                        Emit bounded JSON

Rollback: --generation <version-commit12> (or --tag/--version)
Uninstall: --remove-agents
Doctor: --repair-journal, --ack-restart
`
}

function value(args: readonly string[], index: number, flag: string): string {
  const item = args[index + 1]
  if (!item || item.startsWith("--")) throw new Error(`${flag} requires a value`)
  return item
}

export function parseManagerArgs(args: readonly string[], env = process.env): ManagerOptions {
  if (!args.length || args[0] === "--help" || args[0] === "-h") throw new Error(usage())
  const command = args[0] as ManagerCommand
  if (!COMMANDS.has(command)) throw new Error(`Unknown manager command: ${args[0]}\n${usage()}`)
  const home = env.USERPROFILE || env.HOME
  let configDir = home ? join(home, ".config", "opencode") : undefined
  const options: Partial<ManagerOptions> & { command: ManagerCommand } = { command }
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!
    if (arg === "--config-dir") configDir = resolve(value(args, index++, arg))
    else if (arg === "--install-root") options.installRoot = resolve(value(args, index++, arg))
    else if (arg === "--source") options.source = resolve(value(args, index++, arg))
    else if (arg === "--remote") options.remote = value(args, index++, arg)
    else if (arg === "--tag") options.tag = value(args, index++, arg)
    else if (arg === "--version") options.version = value(args, index++, arg)
    else if (arg === "--generation") options.generation = value(args, index++, arg)
    else if (arg === "--enable-capability") {
      const capability = value(args, index++, arg)
      if (capability !== "excel") throw new Error("--enable-capability supports only excel")
      options.enableCapability = capability
    } else if (arg === "--disable-capability") {
      const capability = value(args, index++, arg)
      if (capability !== "excel") throw new Error("--disable-capability supports only excel")
      options.disableCapability = capability
    } else if (arg === "--excel-root") options.excelRoot = resolve(value(args, index++, arg))
    else if (arg === "--agents" || arg === "--agent-policy") {
      const policy = value(args, index++, arg)
      if (!new Set<AgentPolicy>(["managed", "skip", "force"]).has(policy as AgentPolicy)) {
        throw new Error(`${arg} must be managed, skip, or force`)
      }
      options.agentPolicy = policy as AgentPolicy
    } else if (arg === "--skip-agents") options.agentPolicy = "skip"
    else if (arg === "--force-agents" || arg === "--update-agents") options.agentPolicy = "force"
    else if (arg === "--remove-agents") options.removeAgents = true
    else if (arg === "--repair-journal" || arg === "--repair") options.repairJournal = true
    else if (arg === "--ack-restart") options.ackRestart = true
    else if (arg === "--dry-run") options.dryRun = true
    else if (arg === "--json") options.json = true
    else if (arg === "--help" || arg === "-h") throw new Error(usage())
    else throw new Error(`Unknown manager argument: ${arg}`)
  }
  if (!configDir) throw new Error("Cannot determine a config directory; pass --config-dir")
  return { ...options, command, configDir }
}

function printHuman(result: ManagerResult): void {
  console.log(result.summary)
  if (result.generation) console.log(`Generation: ${result.generation}`)
  if (result.receipt_path) console.log(`Receipt: ${result.receipt_path}`)
  for (const config of result.configs ?? []) {
    console.log(`${config.changed ? "changed" : "unchanged"}: ${config.path}`)
    if (config.backup) console.log(`  backup: ${config.backup}`)
  }
  for (const agent of result.agents ?? []) {
    console.log(`${agent.action}: ${agent.path}`)
    if (agent.backup) console.log(`  backup: ${agent.backup}`)
  }
  for (const issue of result.issues ?? []) console.log(`[${issue.code}] ${issue.message}`)
  if (result.previous_generation) console.log(`Previous rollback generation: ${result.previous_generation}`)
  if (result.restart_required) console.log("Restart pending: quit and restart OpenCode, then attest with doctor --ack-restart.")
}

const isMain = Boolean(import.meta.main) || (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
if (isMain) {
  let json = process.argv.includes("--json")
  try {
    const options = parseManagerArgs(process.argv.slice(2))
    json = Boolean(options.json)
    const result = runManager(options)
    if (json) console.log(serializeManagerJson(result))
    else printHuman(result)
    if (!result.ok) process.exitCode = 1
  } catch (error) {
    const message = managerErrorMessage(error)
    if (json) console.error(serializeManagerJson({ ok: false, error: message }))
    else console.error(message)
    process.exitCode = 1
  }
}

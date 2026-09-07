import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { applyEdits, modify, parse } from "jsonc-parser"
import { captureStableRegularFile, commitFileCasPlans, decodeConfigBytes, encodeConfigText, type FileCasHooks } from "../src/config-editor.ts"

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url))

const MCP_ID = "alg_duckdb"
const HASH = /^[a-f0-9]{64}$/
const ACTIONS = ["enable", "disable", "status", "doctor", "uninstall"] as const
type Action = typeof ACTIONS[number]

function fail(message: string): never {
  throw new Error(message)
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function directDirectory(path: string, label: string): string {
  const absolute = resolve(path)
  if (!existsSync(absolute) || !lstatSync(absolute).isDirectory() || lstatSync(absolute).isSymbolicLink() ||
    !samePath(realpathSync.native(absolute), absolute)) fail(`${label} must be an existing direct directory`)
  return absolute
}

function regularAbsolute(path: string, label: string, permitInterpreterLink = false): string {
  if (!isAbsolute(path) || !existsSync(path)) fail(`${label} must be an existing absolute regular file`)
  const stat = lstatSync(path)
  const resolved = realpathSync.native(path)
  if ((!stat.isFile() && !(permitInterpreterLink && stat.isSymbolicLink())) || !lstatSync(resolved).isFile()) {
    fail(`${label} must be an existing absolute regular file`)
  }
  if (!permitInterpreterLink && (stat.isSymbolicLink() || !samePath(resolved, path))) {
    fail(`${label} must not be redirected`)
  }
  return resolve(path)
}

function parseArgs(argv: string[]): { command: Action; project: string; python?: string; contract?: string } {
  const command = argv[0] as Action | undefined
  if (!command || !ACTIONS.includes(command)) {
    fail("usage: duckdb-project <enable|disable|status|doctor|uninstall> --project PATH [--python PATH --contract PATH]")
  }
  const values = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !["--project", "--python", "--contract"].includes(name) || !value || value.startsWith("--") || values.has(name)) {
      fail("arguments must be unique --project/--python/--contract value pairs")
    }
    values.set(name, value)
  }
  const allowed = command === "enable" ? new Set(["--project", "--python", "--contract"]) : new Set(["--project"])
  if ([...values.keys()].some((name) => !allowed.has(name))) fail(`${command} does not accept Python or contract overrides`)
  if (command === "enable" && (!values.get("--python") || !values.get("--contract"))) {
    fail("enable requires --python and --contract")
  }
  return {
    command,
    project: directDirectory(values.get("--project") ?? process.cwd(), "project"),
    python: values.get("--python"),
    contract: values.get("--contract"),
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(",")}}`
  }
  fail("contract contains a non-JSON value")
}

export function canonicalDuckDbContractHash(contract: unknown): string {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) fail("contract payload must be an object")
  return createHash("sha256").update(Buffer.from("alg-duckdb-contract-v1\0", "utf8"))
    .update(Buffer.from(canonicalJson(contract), "utf8")).digest("hex")
}

export interface ManagedDuckDbEntry {
  type: "local"
  command: [string, string, "--mcp", "--contract", string, "--hash", string]
  enabled: boolean
  environment: Record<string, never>
}

export function managedDuckDbEntry(python: string, wrapper: string, contract: string, hash: string, enabled = true): ManagedDuckDbEntry {
  return { type: "local", command: [python, wrapper, "--mcp", "--contract", contract, "--hash", hash], enabled, environment: {} }
}

/** Structural validation only. Mutation authority additionally requires an exact project receipt. */
export function isManagedDuckDbEntry(value: unknown): value is ManagedDuckDbEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["command", "enabled", "environment", "type"])) return false
  if (entry.type !== "local" || typeof entry.enabled !== "boolean" || JSON.stringify(entry.environment) !== "{}") return false
  const command = entry.command
  return Array.isArray(command) && command.length === 7 && command.every((item) => typeof item === "string") &&
    command[2] === "--mcp" && command[3] === "--contract" && command[5] === "--hash" && HASH.test(command[6] as string) &&
    isAbsolute(command[0] as string) && isAbsolute(command[1] as string) && isAbsolute(command[4] as string) &&
    /capabilities[\\/]duckdb[\\/]wrapper\.py$/.test(command[1] as string)
}

export function updateDuckDbProjectConfig(
  text: string,
  action: "enable" | "disable" | "uninstall",
  entry?: ManagedDuckDbEntry,
  ownedEntry?: ManagedDuckDbEntry,
): string {
  const errors: any[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) ?? {}
  if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    (parsed.mcp !== undefined && (!parsed.mcp || typeof parsed.mcp !== "object" || Array.isArray(parsed.mcp)))) fail("project OpenCode configuration is invalid")
  const current = parsed.mcp?.[MCP_ID]
  if (current !== undefined && (!isManagedDuckDbEntry(current) || !ownedEntry || canonicalJson(current) !== canonicalJson(ownedEntry))) {
    fail("custom or drifted mcp.alg_duckdb entry is preserved; remove it manually after review")
  }
  if (action === "enable" && !entry) fail("managed entry is required")
  if ((action === "disable" || action === "uninstall") && current === undefined) return text
  const replacement = action === "enable" ? entry : action === "disable" ? { ...current, enabled: false } : undefined
  const edits = modify(text, ["mcp", MCP_ID], replacement, {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes("\r\n") ? "\r\n" : "\n" },
  })
  return applyEdits(text, edits)
}

function configurationPath(project: string): string {
  const jsonc = join(project, "opencode.jsonc")
  const json = join(project, "opencode.json")
  if (existsSync(jsonc) && existsSync(json)) fail("project has both opencode.json and opencode.jsonc; resolve ambiguity manually")
  return existsSync(jsonc) ? jsonc : existsSync(json) ? json : jsonc
}

function readConfiguration(path: string) {
  const captured = captureStableRegularFile(path)
  const decoded = captured.exists ? decodeConfigBytes(captured.bytes, path) : {
    text: "{\n  \"$schema\": \"https://opencode.ai/config.json\"\n}\n", encoding: { name: "utf8" as const, bom: false },
  }
  const { text } = decoded
  const errors: any[] = []
  const parsed = parse(text, errors, { allowTrailingComma: true, disallowComments: false }) ?? {}
  if (errors.length || !parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
    (parsed.mcp !== undefined && (!parsed.mcp || typeof parsed.mcp !== "object" || Array.isArray(parsed.mcp)))) fail("project OpenCode configuration is invalid")
  return { text, parsed, captured, encoding: decoded.encoding }
}

function validateEnvelope(path: string): { path: string; hash: string } {
  const contract = regularAbsolute(path, "contract")
  const envelope = JSON.parse(readFileSync(contract, "utf8")) as any
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope) ||
    JSON.stringify(Object.keys(envelope).sort()) !== JSON.stringify(["contract", "contract_sha256", "schema_version"]) ||
    envelope.schema_version !== 1 || !HASH.test(envelope.contract_sha256 ?? "")) fail("contract envelope is invalid")
  const actual = canonicalDuckDbContractHash(envelope.contract)
  if (actual !== envelope.contract_sha256) fail("contract canonical SHA-256 does not match its payload")
  return { path: contract, hash: actual }
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function runDuckDbProject(argv = process.argv.slice(2), hooks?: FileCasHooks): void {
  const args = parseArgs(argv)
  const config = configurationPath(args.project)
  const state = readConfiguration(config)
  const alternateConfig = join(args.project, config.endsWith(".jsonc") ? "opencode.json" : "opencode.jsonc")
  const alternateCapture = captureStableRegularFile(alternateConfig)
  if (alternateCapture.exists) fail("project configuration became ambiguous; files preserved")
  const current = state.parsed.mcp?.[MCP_ID]
  for (const suffix of [".opencode", ".opencode/skills", ".opencode/skills/duckdb-lake"]) {
    const path = join(args.project, suffix)
    try { lstatSync(path) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue
      throw error
    }
    directDirectory(path, "project skill/receipt directory")
  }
  const receiptPath = join(args.project, ".opencode", "alg-duckdb.receipt.json")
  const skillPath = join(args.project, ".opencode", "skills", "duckdb-lake", "SKILL.md")
  const receiptCapture = captureStableRegularFile(receiptPath)
  const skillCapture = captureStableRegularFile(skillPath)
  let receipt: any
  if (receiptCapture.exists) {
    receipt = JSON.parse(receiptCapture.bytes.toString("utf8"))
    if (!receipt || canonicalJson(Object.keys(receipt).sort()) !== canonicalJson(["config", "entry", "project", "python_sha256", "schema_version", "skill_path", "skill_sha256", "wrapper_sha256"]) ||
      receipt.schema_version !== 1 || receipt.project !== args.project || receipt.config !== config ||
      receipt.skill_path !== skillPath || !HASH.test(receipt.skill_sha256 ?? "") ||
      !HASH.test(receipt.wrapper_sha256 ?? "") || !HASH.test(receipt.python_sha256 ?? "") || !isManagedDuckDbEntry(receipt.entry)) {
      fail("invalid DuckDB ownership receipt; files preserved")
    }
  }
  const managed = !!receipt && isManagedDuckDbEntry(current) && canonicalJson(current) === canonicalJson(receipt.entry) &&
    skillCapture.exists && skillCapture.hash === receipt.skill_sha256
  if (args.command === "status") {
    console.log(JSON.stringify({ configured: current !== undefined, managed, enabled: current?.enabled === true }))
    return
  }
  if (args.command === "doctor") {
    if (!managed || !isManagedDuckDbEntry(current)) fail("exact receipt-owned mcp.alg_duckdb and skill are not configured")
    const [python, wrapper, , , contract, , expectedHash] = current.command
    regularAbsolute(python, "configured Python", true)
    regularAbsolute(wrapper, "configured wrapper")
    if (fileHash(wrapper) !== receipt.wrapper_sha256 || fileHash(python) !== receipt.python_sha256) fail("configured runtime bytes have drifted")
    const envelope = validateEnvelope(contract)
    if (envelope.hash !== expectedHash) fail("configured contract hash has drifted")
    console.log(JSON.stringify({ ok: true, configured: true, managed: true, enabled: current.enabled, contract_sha256: expectedHash }))
    return
  }
  let entry: ManagedDuckDbEntry | undefined
  if ((receipt && !managed) || (current !== undefined && !managed) || (!receipt && skillCapture.exists)) {
    fail("custom or drifted DuckDB config/skill ownership is preserved; review manually")
  }
  if (args.command !== "enable" && !receipt && current === undefined) {
    console.log(JSON.stringify({ changed: false, configured: false, enabled: false }))
    return
  }
  const sourceSkillPath = join(PACKAGE_ROOT, ".opencode", "skills", "duckdb-lake", "SKILL.md")
  const sourceSkill = args.command === "enable" ? captureStableRegularFile(sourceSkillPath) : undefined
  if (args.command === "enable") {
    const python = regularAbsolute(args.python!, "python", true)
    for (const interpreter of [python, realpathSync.native(python)]) {
      const insidePackage = relative(realpathSync.native(PACKAGE_ROOT), interpreter)
      if (!insidePackage || (!insidePackage.startsWith("..") && !isAbsolute(insidePackage))) fail("prepared Python environment must be outside the immutable package tree")
    }
    const envelope = validateEnvelope(args.contract!)
    const wrapper = regularAbsolute(join(PACKAGE_ROOT, "capabilities", "duckdb", "wrapper.py"), "wrapper")
    entry = managedDuckDbEntry(python, wrapper, envelope.path, envelope.hash)
    if (!sourceSkill?.exists) fail("packaged DuckDB skill is missing")
  }
  const output = updateDuckDbProjectConfig(state.text, args.command as "enable" | "disable" | "uninstall", entry, receipt?.entry)
  const runtimeReads = entry ? [realpathSync.native(entry.command[0]), entry.command[1], entry.command[4]].map((path) => {
    const captured = captureStableRegularFile(path)
    if (!captured.exists) fail("runtime/contract disappeared before activation")
    return { path, captured }
  }) : []
  if (entry) {
    const envelope = JSON.parse(runtimeReads[2]!.captured.bytes.toString("utf8"))
    if (envelope.contract_sha256 !== entry.command[6] || canonicalDuckDbContractHash(envelope.contract) !== entry.command[6]) {
      fail("contract changed during activation; files preserved")
    }
  }
  const nextEntry = args.command === "enable" ? entry! : { ...receipt?.entry, enabled: false }
  const nextReceipt = args.command === "uninstall" ? undefined : Buffer.from(`${JSON.stringify({
    schema_version: 1, project: args.project, config, entry: nextEntry, skill_path: skillPath,
    skill_sha256: sourceSkill?.exists ? sourceSkill.hash : receipt.skill_sha256,
    wrapper_sha256: entry ? runtimeReads[1]!.captured.hash : receipt.wrapper_sha256,
    python_sha256: entry ? runtimeReads[0]!.captured.hash : receipt.python_sha256,
  }, null, 2)}\n`)
  commitFileCasPlans([
    { path: config, before: state.captured.bytes, expectedIdentity: state.captured.identity,
      after: output === state.text ? state.captured.bytes : encodeConfigText(output, state.encoding) },
    { path: skillPath, before: skillCapture.bytes, expectedIdentity: skillCapture.identity,
      after: args.command === "uninstall" ? undefined : sourceSkill?.bytes ?? skillCapture.bytes },
    { path: receiptPath, before: receiptCapture.bytes, expectedIdentity: receiptCapture.identity, after: nextReceipt },
    { path: alternateConfig, expectedIdentity: null },
    ...runtimeReads.map(({ path, captured }) => ({ path, before: captured.bytes, after: captured.bytes, expectedIdentity: captured.identity })),
    ...(sourceSkill?.exists ? [{ path: sourceSkillPath, before: sourceSkill.bytes, after: sourceSkill.bytes, expectedIdentity: sourceSkill.identity }] : []),
  ], { hooks })
  console.log(JSON.stringify({ changed: output !== state.text, configured: args.command !== "uninstall", enabled: args.command === "enable" }))
}

if (import.meta.main || (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url)))) {
  try {
    runDuckDbProject()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

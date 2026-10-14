import { accessSync, constants, statSync } from "node:fs"
import { delimiter, extname, isAbsolute, join, resolve } from "node:path"
import { canonicalContainedDirectory } from "./paths.ts"
import { safeDiagnosticText } from "./diagnostics.ts"
import { controlledShellEnvironment } from "./shell.ts"
import type { GraphDef, ShellGateDef } from "./types.ts"

export type GateIssue = "command_required" | "command_too_long" | "command_not_text" |
  "prose_or_markdown" | "missing_pipeline_command" | "command_not_found" |
  "posix_command_unavailable" | "complex_command_review" | "implicit_cwd" | "inline_cwd"

export interface GateDiagnostic {
  code: GateIssue
  severity: "error" | "warning"
  /** One-based pipeline/chain position; never an untrusted command or argument. */
  command?: number
}

const CMD_BUILTINS = new Set("assoc break call cd chdir cls color copy date del dir echo endlocal erase exit for ftype goto if md mkdir mklink move path pause popd prompt pushd rd rem ren rename rmdir set setlocal shift start time title type ver verify vol".split(" "))
const SH_BUILTINS = new Set(": . alias bg break builtin cd command continue echo eval exec exit export false fg getopts hash jobs kill printf pwd read readonly return set shift source test times trap true type ulimit umask unalias unset wait".split(" "))
const POSIX_COMMANDS = new Set("tail head grep sed awk xargs chmod which cat ls wc tee cut sort uniq find rm cp mv".split(" "))

/** Read-only, deliberately incomplete shell lint. Complex scripts are reported, not reinterpreted. */
export function inspectGateCommand(cmd: string, options: {
  platform: NodeJS.Platform
  phase: "plan" | "execute"
  commandExists?: (command: string) => boolean
}): GateDiagnostic[] {
  const text = cmd.trim()
  if (!text) return [{ code: "command_required", severity: "error" }]
  if (cmd.length > 8_192) return [{ code: "command_too_long", severity: "error" }]
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(cmd)) return [{ code: "command_not_text", severity: "error" }]
  if (/^(?:```|(?:allowed[ -]+)?tools?(?:[ -]+(?:inventory|permissions?))?\s*:|(?:run|execute)\s+the\s+(?:following|tests|test suite)\b)/i.test(text)) {
    return [{ code: "prose_or_markdown", severity: "error" }]
  }

  const windows = options.platform === "win32"
  const issues: GateDiagnostic[] = []
  const complex = (): GateDiagnostic[] => [{ code: "complex_command_review", severity: "warning" }]
  const segments: string[][] = [[]]
  const operators: string[] = []
  let word = "", started = false, quote = ""
  let hasFallback = false
  const flush = () => { if (started) segments.at(-1)!.push(word); word = ""; started = false }
  // No shell is invoked here. Expansions, redirections, grouping, multiline scripts,
  // and escapes require a real shell grammar, so do not guess at their executables.
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!
    if (quote) {
      if (char === quote) quote = ""
      else {
        if (char === "\\" && !windows && quote === '"') return complex()
        word += char
      }
      continue
    }
    if (char === '"' || (!windows && char === "'")) { quote = char; started = true; continue }
    if ((windows && /[%!^]/.test(char)) || (!windows && /[$`\\#]/.test(char)) || /[()<>\r\n]/.test(char)) return complex()
    if (/\s/.test(char)) { flush(); continue }
    if (char === "|" || char === "&" || (!windows && char === ";")) {
      if (!windows && char === "|" && text[i + 1] === "&") return complex() // bash/zsh stderr pipe
      flush()
      if (!segments.at(-1)!.length) return [{ code: "missing_pipeline_command", severity: "error" }]
      const operator = text[i + 1] === char && char !== ";" ? char + text[++i] : char
      if (operator === "||") hasFallback = true
      if (i === text.length - 1 && (operator === "&" || operator === ";")) break
      operators.push(operator)
      segments.push([])
      if (segments.length > 64) return complex()
      continue
    }
    word += char; started = true
  }
  if (quote) return complex() // cmd.exe permits some unmatched quotes; do not invent a syntax error.
  flush()
  if (!segments.at(-1)!.length) return [{ code: "missing_pipeline_command", severity: "error" }]
  if (hasFallback) return complex() // A missing executable may be intentional in a fallback chain.
  const builtins = windows ? CMD_BUILTINS : SH_BUILTINS
  let lookupSafe = true
  for (const [index, words] of segments.entries()) {
    if (index > 0 && operators[index - 1] !== "|") {
      // An earlier command may install/generate a later command. Checking it
      // against the pre-execution filesystem would reject a valid setup chain.
      issues.push({ code: "complex_command_review", severity: "warning", command: index + 1 })
      lookupSafe = false
    }
    const head = words[0]!.replace(/^@/, "")
    const normalized = windows ? head.toLowerCase() : head
    if (["cd", "chdir", "pushd", "popd"].includes(normalized)) {
      issues.push({ code: "inline_cwd", severity: "warning", command: index + 1 })
      lookupSafe = false // A chain may change drive/directory conditionally. Prefer shell_cwd.
    }
    if (builtins.has(normalized)) {
      if (["set", "setlocal", "endlocal", "path", "export", ".", "source", "builtin", "call", "start", "exec", "eval", "command", "if", "for"].includes(normalized)) {
        issues.push({ code: "complex_command_review", severity: "warning", command: index + 1 })
        lookupSafe = false
      }
      continue
    }
    // Relative/absolute executable paths may be build products. Only PATH-based,
    // literal command names can be checked before the implementation runs.
    if (!/^[A-Za-z0-9_.+-]+$/.test(head) || head.startsWith(".")) {
      issues.push({ code: "complex_command_review", severity: "warning", command: index + 1 })
      continue
    }
    if (lookupSafe && options.commandExists && !options.commandExists(head)) {
      const posix = windows && POSIX_COMMANDS.has(normalized)
      issues.push({ code: posix ? "posix_command_unavailable" : "command_not_found",
        severity: posix || options.phase === "execute" ? "error" : "warning", command: index + 1 })
    }
  }
  return issues
}

/** Match the runner's allowlisted PATH/PATHEXT, without executing discovery commands. */
export function gateCommandExists(command: string, cwd: string, environment: NodeJS.ProcessEnv): boolean {
  const windows = process.platform === "win32"
  const extensions = windows && !extname(command)
    ? (environment.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter((part) => /^\.[A-Za-z0-9]+$/.test(part))
    : [""]
  const directories = [...(windows ? [cwd] : []), ...(environment.PATH ?? "").split(delimiter)]
  for (const directory of directories) {
    const base = directory.replace(/^"(.*)"$/, "$1")
    for (const extension of extensions) {
      const path = join(isAbsolute(base) ? base : resolve(cwd, base || "."), command + extension)
      try {
        if (!statSync(path).isFile()) continue
        if (!windows) accessSync(path, constants.X_OK)
        return true
      } catch { /* Missing or inaccessible command is not available. */ }
    }
  }
  return false
}

export interface GatePreflightReport {
  node_id: string
  shell: "cmd.exe" | "posix-shell"
  cwd: string
  diagnostics: GateDiagnostic[]
}

export function preflightShellGates(graph: GraphDef, options: {
  worktree: string
  directory: string
  phase: "plan" | "execute"
  /** Dry execution and injected shell runners do not use the host's executables. */
  checkExecutables: boolean
}): GatePreflightReport[] {
  const nodes = graph.nodes.filter((node) => node.shell_gate &&
    (node.agent === "shell" || node.loop?.gate === "shell" || node.loop?.gate === "all"))
  if (!nodes.length) return []
  const environment = options.checkExecutables ? controlledShellEnvironment() : undefined
  // DAGs often repeat the same gate. Cache only within this read-only check;
  // the next run/resume must observe PATH/filesystem changes afresh.
  const available = new Map<string, boolean>()
  const commandExists = (command: string, cwd: string): boolean => {
    const key = JSON.stringify([cwd, process.platform === "win32" ? command.toLowerCase() : command])
    if (!available.has(key)) available.set(key, gateCommandExists(command, cwd, environment!))
    return available.get(key)!
  }
  const reports: GatePreflightReport[] = []
  for (const node of nodes) {
    const gate: ShellGateDef = node.shell_gate!
    let cwd: string
    try {
      cwd = canonicalContainedDirectory(options.worktree, gate.cwd ? resolve(options.directory, gate.cwd) : options.directory)
    } catch {
      throw new Error(`Shell gate preflight: node ${node.id}: invalid_cwd. Set shell_cwd (or graph shell_gate.cwd) to an existing directory inside the project; relative paths use the pinned execution directory.`)
    }
    const diagnostics = inspectGateCommand(gate.cmd, { platform: process.platform, phase: options.phase,
      ...(environment ? { commandExists: (command: string) => commandExists(command, cwd) } : {}) })
    if (!gate.cwd) diagnostics.push({ code: "implicit_cwd", severity: "warning" })
    const report: GatePreflightReport = { node_id: node.id, shell: process.platform === "win32" ? "cmd.exe" : "posix-shell", cwd, diagnostics }
    const errors = diagnostics.filter((issue) => issue.severity === "error")
    if (errors.length) {
      throw new Error(safeDiagnosticText(`Shell gate preflight: node ${node.id}; shell=${report.shell}; cwd=${cwd}; ${errors.map((issue) => `${issue.code}${issue.command ? ` at command ${issue.command}` : ""}`).join(", ")}. Correct this gate before starting more child attempts. Supply an executable validation command, not prose or a tool inventory; check the shell, PATH and shell_cwd. For complex validation use a reviewed script.`))
    }
    reports.push(report)
  }
  return reports
}

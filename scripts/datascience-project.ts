import { createHash } from "node:crypto"
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { captureStableRegularFile, commitFileCasPlans, type FileCasHooks } from "../src/config-editor.ts"
import { DATASCIENCE_ASSET_FILES } from "../src/capability-assets.ts"

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url))
const ACTIONS = ["enable", "disable", "status", "doctor", "uninstall"] as const
type Action = typeof ACTIONS[number]
const HASH = /^[a-f0-9]{64}$/

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
  if (!permitInterpreterLink && (stat.isSymbolicLink() || !samePath(resolved, path))) fail(`${label} must not be redirected`)
  return resolve(path)
}

function parseArgs(argv: string[]): { command: Action; project: string; python?: string } {
  const command = argv[0] as Action | undefined
  if (!command || !ACTIONS.includes(command)) {
    fail("usage: datascience-project <enable|disable|status|doctor|uninstall> --project PATH [--python PATH]")
  }
  const values = new Map<string, string>()
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name || !["--project", "--python"].includes(name) || !value || value.startsWith("--") || values.has(name)) {
      fail("arguments must be unique --project/--python value pairs")
    }
    values.set(name, value)
  }
  if (command === "enable") {
    if (!values.get("--python") || values.size !== 2) fail("enable requires --project and --python")
  } else if (values.has("--python") || ![...values.keys()].every((name) => name === "--project")) {
    fail(`${command} does not accept Python overrides`)
  }
  return { command, project: directDirectory(values.get("--project") ?? process.cwd(), "project"), python: values.get("--python") }
}

function fileHash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function outsidePackage(python: string): void {
  for (const interpreter of [python, realpathSync.native(python)]) {
    const insidePackage = relative(realpathSync.native(PACKAGE_ROOT), interpreter)
    if (!insidePackage || (!insidePackage.startsWith("..") && !isAbsolute(insidePackage))) {
      fail("prepared Python environment must be outside the immutable package tree")
    }
  }
}

function receiptShape(value: unknown): value is {
  schema_version: 1; project: string; enabled: boolean; python: string; python_sha256: string
  runner: string; runner_sha256: string; manifest_sha256: string
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const receipt = value as Record<string, unknown>
  return JSON.stringify(Object.keys(receipt).sort()) === JSON.stringify([
    "enabled", "manifest_sha256", "project", "python", "python_sha256", "runner", "runner_sha256", "schema_version",
  ]) && receipt.schema_version === 1 && typeof receipt.enabled === "boolean" &&
    typeof receipt.project === "string" && typeof receipt.python === "string" && typeof receipt.runner === "string" &&
    HASH.test(String(receipt.python_sha256)) && HASH.test(String(receipt.runner_sha256)) && HASH.test(String(receipt.manifest_sha256))
}

export function runDataScienceProject(argv = process.argv.slice(2), hooks?: FileCasHooks): void {
  const args = parseArgs(argv)
  const receiptPath = join(args.project, ".opencode", "alg-datascience.receipt.json")
  const receiptCapture = captureStableRegularFile(receiptPath)
  let receipt: unknown
  if (receiptCapture.exists) {
    receipt = JSON.parse(receiptCapture.bytes.toString("utf8"))
    if (!receiptShape(receipt) || receipt.project !== args.project) fail("invalid Data Science ownership receipt; files preserved")
  }
  if (args.command === "status") {
    console.log(JSON.stringify({ configured: !!receipt, managed: !!receipt, enabled: receiptShape(receipt) && receipt.enabled === true, mcp: false }))
    return
  }
  const runner = join(PACKAGE_ROOT, "capabilities", "datascience", "runner.py")
  const manifest = join(PACKAGE_ROOT, "capabilities", "datascience", "manifest.json")
  if (args.command === "doctor") {
    if (!receiptShape(receipt)) fail("exact receipt-owned Data Science runtime is not configured")
    regularAbsolute(receipt.python, "configured Python", true)
    regularAbsolute(receipt.runner, "configured runner")
    if (fileHash(receipt.python) !== receipt.python_sha256 || fileHash(receipt.runner) !== receipt.runner_sha256) {
      fail("configured runtime bytes have drifted")
    }
    if (fileHash(manifest) !== receipt.manifest_sha256) fail("packaged Data Science manifest has drifted")
    console.log(JSON.stringify({ ok: true, configured: true, managed: true, enabled: receipt.enabled, mcp: false }))
    return
  }
  if (args.command !== "enable" && !receipt) {
    console.log(JSON.stringify({ changed: false, configured: false, enabled: false, mcp: false }))
    return
  }
  let next: Buffer | undefined
  if (args.command === "enable") {
    const python = regularAbsolute(args.python!, "python", true)
    outsidePackage(python)
    regularAbsolute(runner, "runner")
    for (const name of DATASCIENCE_ASSET_FILES) regularAbsolute(join(PACKAGE_ROOT, "capabilities", "datascience", name), name)
    const resolvedPython = realpathSync.native(python)
    const pythonCapture = captureStableRegularFile(resolvedPython)
    const runnerCapture = captureStableRegularFile(runner)
    const manifestCapture = captureStableRegularFile(manifest)
    if (!pythonCapture.exists || !runnerCapture.exists || !manifestCapture.exists) fail("runtime files disappeared before activation")
    next = Buffer.from(`${JSON.stringify({
      schema_version: 1, project: args.project, enabled: true, python, python_sha256: pythonCapture.hash,
      runner, runner_sha256: runnerCapture.hash, manifest_sha256: manifestCapture.hash,
    }, null, 2)}\n`)
    if (fileHash(resolvedPython) !== pythonCapture.hash || fileHash(runner) !== runnerCapture.hash || fileHash(manifest) !== manifestCapture.hash) {
      fail("runtime files changed during activation; files preserved")
    }
    commitFileCasPlans([
      { path: receiptPath, before: receiptCapture.bytes, expectedIdentity: receiptCapture.identity, after: next },
    ], { hooks })
  } else if (args.command === "disable" && receiptShape(receipt)) {
    next = Buffer.from(`${JSON.stringify({ ...receipt, enabled: false }, null, 2)}\n`)
    commitFileCasPlans([{ path: receiptPath, before: receiptCapture.bytes, expectedIdentity: receiptCapture.identity, after: next }], { hooks })
  } else {
    commitFileCasPlans([{ path: receiptPath, before: receiptCapture.bytes, expectedIdentity: receiptCapture.identity, after: undefined }], { hooks })
  }
  console.log(JSON.stringify({
    changed: true, configured: args.command !== "uninstall", enabled: args.command === "enable", mcp: false,
  }))
}

if (import.meta.main || (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url)))) {
  try { runDataScienceProject() } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

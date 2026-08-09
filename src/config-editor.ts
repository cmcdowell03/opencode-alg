import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { randomUUID } from "node:crypto"
import { basename, dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from "jsonc-parser"

export type JsonObject = Record<string, unknown>

export interface TextFilePlan {
  path: string
  before?: string
  after: string
  changed: boolean
  encoding: TextEncoding
}

export interface TextEncoding {
  name: "utf8" | "utf16le" | "utf16be"
  bom: boolean
}

export interface DecodedTextFile {
  text: string
  bytes: Buffer
  encoding: TextEncoding
}

const FORMAT = { insertSpaces: true, tabSize: 2 }
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf])
const UTF16LE_BOM = Buffer.from([0xff, 0xfe])
const UTF16BE_BOM = Buffer.from([0xfe, 0xff])

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix)
}

function decode(bytes: Buffer, label: "utf-8" | "utf-16le" | "utf-16be", path: string): string {
  try {
    return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch (error) {
    throw new Error(`Invalid ${label} encoding in ${path}`, { cause: error })
  }
}

export function decodeConfigBytes(bytes: Buffer, path: string): DecodedTextFile {
  // Check UTF-32 before UTF-16LE because its BOM shares the first two bytes.
  if (
    startsWith(bytes, Buffer.from([0xff, 0xfe, 0x00, 0x00])) ||
    startsWith(bytes, Buffer.from([0x00, 0x00, 0xfe, 0xff]))
  ) {
    throw new Error(`Unsupported config encoding (UTF-32) in ${path}`)
  }
  if (startsWith(bytes, UTF8_BOM)) {
    return {
      text: decode(bytes.subarray(UTF8_BOM.length), "utf-8", path),
      bytes,
      encoding: { name: "utf8", bom: true },
    }
  }
  if (startsWith(bytes, UTF16LE_BOM)) {
    const body = bytes.subarray(UTF16LE_BOM.length)
    if (body.length % 2) throw new Error(`Invalid utf-16le encoding in ${path}`)
    return {
      text: decode(body, "utf-16le", path),
      bytes,
      encoding: { name: "utf16le", bom: true },
    }
  }
  if (startsWith(bytes, UTF16BE_BOM)) {
    const body = bytes.subarray(UTF16BE_BOM.length)
    if (body.length % 2) throw new Error(`Invalid utf-16be encoding in ${path}`)
    return {
      text: decode(body, "utf-16be", path),
      bytes,
      encoding: { name: "utf16be", bom: true },
    }
  }

  // Unmarked JSON/JSONC is UTF-8. NULs are a strong signal for an unsupported
  // unmarked UTF-16/32 file; never guess endianness for a config write.
  if (bytes.includes(0)) throw new Error(`Unsupported unmarked config encoding in ${path}`)
  return {
    text: decode(bytes, "utf-8", path),
    bytes,
    encoding: { name: "utf8", bom: false },
  }
}

export function readConfigTextFile(path: string): DecodedTextFile {
  return decodeConfigBytes(readFileSync(path), path)
}

export function encodeConfigText(text: string, encoding: TextEncoding): Buffer {
  if (encoding.name === "utf8") {
    const body = Buffer.from(text, "utf8")
    return encoding.bom ? Buffer.concat([UTF8_BOM, body]) : body
  }
  const body = Buffer.from(text, "utf16le")
  if (encoding.name === "utf16be") body.swap16()
  const bom = encoding.name === "utf16le" ? UTF16LE_BOM : UTF16BE_BOM
  return encoding.bom ? Buffer.concat([bom, body]) : body
}

function isObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

export function parseJsoncObject(text: string, path: string): JsonObject {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  })
  if (errors.length) {
    const detail = errors
      .slice(0, 3)
      .map((error) => `${printParseErrorCode(error.error)} at offset ${error.offset}`)
      .join(", ")
    throw new Error(`Malformed JSONC in ${path}: ${detail}`)
  }
  if (!isObject(value)) throw new Error(`Expected a JSON object in ${path}`)
  return value
}

function applyValue(text: string, path: Array<string | number>, value: unknown, insert = false): string {
  return applyEdits(
    text,
    modify(text, path, value, {
      formattingOptions: FORMAT,
      isArrayInsertion: insert,
    }),
  )
}

function pluginSpec(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (!Array.isArray(entry) || typeof entry[0] !== "string") return
  return entry[0]
}

function validatePluginList(value: unknown, path: string): unknown[] | undefined {
  if (value === undefined) return
  if (!Array.isArray(value)) throw new Error(`Expected "plugin" to be an array in ${path}`)
  for (const [index, entry] of value.entries()) {
    if (typeof entry === "string") continue
    if (
      Array.isArray(entry) &&
      entry.length === 2 &&
      typeof entry[0] === "string" &&
      isObject(entry[1])
    ) continue
    throw new Error(`Invalid plugin entry at ${path}: plugin[${index}]`)
  }
  return value
}

function normalizedFileSpec(spec: string): string {
  try {
    if (!spec.startsWith("file://")) return spec
    let value = resolve(fileURLToPath(spec)).replaceAll("\\", "/").replace(/\/$/, "")
    if (process.platform === "win32") value = value.toLowerCase()
    return `file://${value}`
  } catch {
    return spec.replace(/\/$/, "")
  }
}

export function planPluginConfig(options: {
  path: string
  desiredSpec: string
  knownSpecs: readonly string[]
  schema: string
  uninstall?: boolean
}): TextFilePlan {
  const existing = existsSync(options.path) ? readConfigTextFile(options.path) : undefined
  const before = existing?.text
  const encoding = existing?.encoding ?? { name: "utf8", bom: false }
  if (before === undefined && options.uninstall) {
    return { path: options.path, after: "", changed: false, encoding }
  }
  const source = before ?? `${JSON.stringify({ $schema: options.schema }, null, 2)}\n`
  const data = parseJsoncObject(source, options.path)
  const plugins = validatePluginList(data.plugin, options.path)
  const known = new Set(options.knownSpecs.map(normalizedFileSpec))
  const matches = (plugins ?? [])
    .map((entry, index) => ({ entry, index, spec: pluginSpec(entry) }))
    .filter((item) => item.spec !== undefined && known.has(normalizedFileSpec(item.spec)))

  let after = source
  if (options.uninstall) {
    for (const match of [...matches].reverse()) {
      after = applyValue(after, ["plugin", match.index], undefined)
    }
  } else if (!plugins) {
    after = applyValue(after, ["plugin"], [options.desiredSpec])
  } else if (!matches.length) {
    after = applyValue(after, ["plugin", plugins.length], options.desiredSpec, true)
  } else {
    // Prefer retaining a tuple so existing ALG plugin options survive migration
    // from a legacy source-file spec to the package-root spec.
    const keeper = matches.find((match) => Array.isArray(match.entry)) ?? matches[0]!
    const removed = matches.filter((match) => match !== keeper)
    for (const match of [...removed].reverse()) {
      after = applyValue(after, ["plugin", match.index], undefined)
    }
    const keeperIndex = keeper.index - removed.filter((match) => match.index < keeper.index).length
    const current = pluginSpec(keeper.entry)!
    if (normalizedFileSpec(current) !== normalizedFileSpec(options.desiredSpec) || current !== options.desiredSpec) {
      const path = Array.isArray(keeper.entry) ? ["plugin", keeperIndex, 0] : ["plugin", keeperIndex]
      after = applyValue(after, path, options.desiredSpec)
    }
  }

  parseJsoncObject(after, options.path)
  return { path: options.path, before, after, changed: after !== before, encoding }
}

export function planDeleteJsoncPath(path: string, keys: Array<string | number>): TextFilePlan | undefined {
  return planDeleteJsoncPaths(path, [keys])
}

/** Plan all structural deletions against one evolving text buffer for a file. */
export function planDeleteJsoncPaths(
  path: string,
  paths: ReadonlyArray<ReadonlyArray<string | number>>,
): TextFilePlan | undefined {
  return planUpdateJsoncPaths(
    path,
    paths.map((keys) => ({ op: "delete" as const, path: keys })),
  )
}

export type JsoncPathUpdate =
  | { op: "set"; path: ReadonlyArray<string | number>; value: unknown }
  | { op: "delete"; path: ReadonlyArray<string | number> }

/** Plan ordered set/delete operations against one evolving text buffer. */
export function planUpdateJsoncPaths(
  path: string,
  updates: readonly JsoncPathUpdate[],
): TextFilePlan | undefined {
  if (!existsSync(path)) return
  const decoded = readConfigTextFile(path)
  const before = decoded.text
  parseJsoncObject(before, path)
  let after = before
  for (const update of updates) {
    after = applyValue(
      after,
      [...update.path],
      update.op === "set" ? update.value : undefined,
    )
  }
  parseJsoncObject(after, path)
  return { path, before, after, changed: after !== before, encoding: decoded.encoding }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function backupPath(path: string, stamp: string): string {
  const base = `${path}.alg-backup-${stamp}`
  if (!existsSync(base)) return base
  for (let index = 1; ; index++) {
    const candidate = `${base}-${index}`
    if (!existsSync(candidate)) return candidate
  }
}

export function atomicReplace(path: string, content: string | Uint8Array): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const temp = resolve(dir, `.${basename(path)}.alg-tmp-${process.pid}-${randomUUID()}`)
  const mode = existsSync(path) ? statSync(path).mode : 0o600
  const fd = openSync(temp, "wx", mode)
  try {
    writeFileSync(fd, content)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(temp, path)
}

export function commitTextPlans(
  plans: readonly TextFilePlan[],
  options: {
    backups?: boolean
    stamp?: string
    beforeWrite?: (plan: TextFilePlan, index: number) => void
    replace?: typeof atomicReplace
  } = {},
): Array<{ path: string; backup?: string }> {
  const changed = plans.filter((plan) => plan.changed)
  if (!changed.length) return []
  const stamp = options.stamp ?? timestamp()
  const backups = new Map<string, string>()
  const originals = new Map(changed.map((plan) => [
    plan.path,
    existsSync(plan.path) ? readFileSync(plan.path) : undefined,
  ]))

  if (options.backups !== false) {
    for (const plan of changed) {
      if (plan.before === undefined) continue
      const backup = backupPath(plan.path, stamp)
      copyFileSync(plan.path, backup)
      backups.set(plan.path, backup)
    }
  }

  try {
    changed.forEach((plan, index) => {
      options.beforeWrite?.(plan, index)
      ;(options.replace ?? atomicReplace)(plan.path, encodeConfigText(plan.after, plan.encoding))
    })
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const plan of [...changed].reverse()) {
      try {
        const original = originals.get(plan.path)
        if (original === undefined) rmSync(plan.path, { force: true })
        else atomicReplace(plan.path, original)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], "config commit failed and rollback was incomplete")
    }
    throw error
  }
  return changed.map((plan) => ({ path: plan.path, backup: backups.get(plan.path) }))
}

export function exactBackup(path: string, stamp = timestamp()): string {
  const backup = backupPath(path, stamp)
  copyFileSync(path, backup)
  return backup
}

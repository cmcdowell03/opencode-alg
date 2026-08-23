import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { createHash, randomUUID } from "node:crypto"
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
  expectedIdentity: FileIdentity | null
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

export interface ManagedMcpPlanResult {
  plan: TextFilePlan
  status: "managed" | "missing" | "custom"
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

export function readStableRegularFile(path: string): { bytes: Buffer; identity: FileIdentity } {
  const before = lstatSync(path, { bigint: true })
  if (!before.isFile() || before.isSymbolicLink() || normalizedPath(realpathSync.native(path)) !== normalizedPath(path)) {
    throw new Error(`Path is redirected or not a direct regular file: ${path}`)
  }
  const bytes = readFileSync(path)
  const after = lstatSync(path, { bigint: true })
  const stable = before.dev === after.dev && before.ino === after.ino && before.size === after.size &&
    before.mode === after.mode && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs
  if (!stable || BigInt(bytes.byteLength) !== before.size) throw new Error(`File changed during stable read: ${path}`)
  return { bytes, identity: { dev: before.dev.toString(), ino: before.ino.toString() } }
}

export function readConfigTextFile(path: string): DecodedTextFile & { identity: FileIdentity } {
  const stable = readStableRegularFile(path)
  return { ...decodeConfigBytes(stable.bytes, path), identity: stable.identity }
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
    return { path: options.path, after: "", changed: false, encoding, expectedIdentity: null }
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
  return { path: options.path, before, after, changed: after !== before, encoding, expectedIdentity: existing?.identity ?? null }
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "undefined"
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right)
}

/** Compose a targeted mcp.alg_excel edit without touching custom entries. */
export function planManagedMcpConfig(options: {
  path: string
  base: TextFilePlan
  desired?: JsonObject
  priorManaged?: JsonObject
}): ManagedMcpPlanResult {
  const source = options.base.after
  const data = parseJsoncObject(source, options.path)
  const mcp = data.mcp
  const mcpObject = isObject(mcp) ? mcp : undefined
  const existing = mcpObject?.alg_excel
  const isPrior = options.priorManaged !== undefined && sameJson(existing, options.priorManaged)
  let after = source
  let status: ManagedMcpPlanResult["status"]

  if (options.desired) {
    if (mcp !== undefined && !mcpObject) {
      throw new Error(`Expected "mcp" to be an object in ${options.path}`)
    }
    if (existing !== undefined && !isPrior) {
      throw new Error(`Custom or malformed mcp.alg_excel blocks managed enable/update in ${options.path}`)
    }
    after = applyValue(after, ["mcp", "alg_excel"], options.desired)
    status = "managed"
  } else if (existing === undefined) {
    status = "missing"
  } else if (isPrior) {
    after = applyValue(after, ["mcp", "alg_excel"], undefined)
    status = "missing"
  } else {
    status = "custom"
  }

  parseJsoncObject(after, options.path)
  return {
    plan: {
      path: options.path,
      before: options.base.before,
      after,
      changed: after !== options.base.before,
      encoding: options.base.encoding,
      expectedIdentity: options.base.expectedIdentity,
    },
    status,
  }
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
  return { path, before, after, changed: after !== before, encoding: decoded.encoding, expectedIdentity: decoded.identity }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-")
}

function backupPath(path: string, stamp: string): string {
  return `${path}.alg-backup-${stamp}-${randomUUID()}`
}

/** Byte compare-and-swap guard for a previously preflighted text plan. */
export function assertTextPlanUnchanged(plan: TextFilePlan): void {
  if (plan.before === undefined) {
    if (plan.expectedIdentity !== null) throw new Error(`Expected-absent plan has a file identity: ${plan.path}`)
    if (existsSync(plan.path)) throw new Error(`Concurrent change detected before creating ${plan.path}`)
    return
  }
  if (plan.expectedIdentity === null) throw new Error(`Expected-existing plan has no file identity: ${plan.path}`)
  if (!existsSync(plan.path)) throw new Error(`Concurrent removal detected before replacing ${plan.path}`)
  if (!sameIdentity(directRegularFileIdentity(plan.path), plan.expectedIdentity)) throw new Error(`Concurrent identity change detected before replacing ${plan.path}`)
  const expected = encodeConfigText(plan.before, plan.encoding)
  if (!readFileSync(plan.path).equals(expected)) {
    throw new Error(`Concurrent byte change detected before replacing ${plan.path}`)
  }
}

export interface FileIdentity {
  dev: string
  ino: string
}

export interface FileCasPlan {
  path: string
  before?: Uint8Array
  after?: Uint8Array
  expectedIdentity: FileIdentity | null
}

export interface FileCasHooks {
  afterClaim?: (plan: FileCasPlan, index: number) => void
  beforeMutation?: (plan: FileCasPlan, index: number) => void
  afterUnlink?: (plan: FileCasPlan, index: number) => void
  beforePublish?: (plan: FileCasPlan, index: number) => void
  afterPublish?: (plan: FileCasPlan, index: number) => void
  beforeRollback?: (plans: readonly FileCasPlan[]) => void
}

interface CasRecord {
  plan: FileCasPlan
  index: number
  before?: Buffer
  after?: Buffer
  beforeIdentity?: FileIdentity
  prepared?: string
  preparedIdentity?: FileIdentity
  claim?: string
  claimIdentity?: FileIdentity
  parentIdentity: FileIdentity
  backup?: string
  mutated: boolean
  mutates: boolean
}

function normalizedPath(path: string): string {
  const value = resolve(path)
  return process.platform === "win32" ? value.toLowerCase() : value
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function directRegularFileIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isFile() || stat.isSymbolicLink() || normalizedPath(realpathSync.native(path)) !== normalizedPath(path)) {
    throw new Error(`Path is redirected or not a direct regular file: ${path}`)
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function directDirectoryIdentity(path: string): FileIdentity {
  const stat = lstatSync(path, { bigint: true })
  if (!stat.isDirectory() || stat.isSymbolicLink() || normalizedPath(realpathSync.native(path)) !== normalizedPath(path)) {
    throw new Error(`Parent is redirected or not a direct directory: ${path}`)
  }
  return { dev: stat.dev.toString(), ino: stat.ino.toString() }
}

function missing(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return true
    throw error
  }
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function assertParent(record: CasRecord): void {
  if (!sameIdentity(directDirectoryIdentity(dirname(record.plan.path)), record.parentIdentity)) {
    throw new Error(`Parent identity changed during file transaction: ${record.plan.path}`)
  }
}

function assertOwnedFile(path: string, identity: FileIdentity, bytes: Buffer, label: string): void {
  if (!sameIdentity(directRegularFileIdentity(path), identity) || !readFileSync(path).equals(bytes)) {
    throw new Error(`${label} bytes or identity changed: ${path}`)
  }
}

function unlinkOwnedFile(path: string, identity: FileIdentity, bytes: Buffer): void {
  if (missing(path)) return
  assertOwnedFile(path, identity, bytes, "Transaction-owned auxiliary")
  unlinkSync(path)
}

function assertPublicBefore(record: CasRecord): void {
  assertParent(record)
  if (record.before === undefined) {
    if (!missing(record.plan.path)) throw new Error(`Concurrent creation detected before publishing ${record.plan.path}`)
    return
  }
  if (missing(record.plan.path) || !record.beforeIdentity) throw new Error(`Concurrent removal detected before replacing ${record.plan.path}`)
  assertOwnedFile(record.plan.path, record.beforeIdentity, record.before, "Preflighted public file")
}

function assertPreparedAndClaim(record: CasRecord): void {
  if (record.after !== undefined) {
    if (!record.prepared || !record.preparedIdentity) throw new Error(`Prepared state is missing: ${record.plan.path}`)
    assertOwnedFile(record.prepared, record.preparedIdentity, record.after, "Prepared file")
  }
  if (record.before !== undefined) {
    if (!record.claim || !record.claimIdentity || !record.beforeIdentity) throw new Error(`Claim state is missing: ${record.plan.path}`)
    assertOwnedFile(record.claim, record.claimIdentity, record.before, "Claimed file")
    if (!sameIdentity(record.claimIdentity, record.beforeIdentity)) throw new Error(`Claim identity differs from preflight: ${record.plan.path}`)
  }
}

function createPrepared(record: CasRecord, transaction: string): void {
  if (record.after === undefined) return
  const mode = record.before === undefined ? 0o600 : statSync(record.plan.path).mode & 0o777
  record.prepared = resolve(dirname(record.plan.path), `.${basename(record.plan.path)}.alg-prepared-${transaction}-${record.index}`)
  const fd = openSync(record.prepared, "wx", mode)
  try {
    writeFileSync(fd, record.after)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  record.preparedIdentity = directRegularFileIdentity(record.prepared)
  assertOwnedFile(record.prepared, record.preparedIdentity, record.after, "Prepared file")
}

function createBackup(record: CasRecord, stamp: string): void {
  if (record.before === undefined || !record.beforeIdentity) return
  for (;;) {
    const candidate = backupPath(record.plan.path, stamp)
    let fd: number | undefined
    try {
      assertOwnedFile(record.plan.path, record.beforeIdentity, record.before, "Preflighted public file before backup")
      fd = openSync(candidate, "wx", statSync(record.plan.path).mode & 0o777)
      writeFileSync(fd, record.before)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      const identity = directRegularFileIdentity(candidate)
      assertOwnedFile(candidate, identity, record.before, "Backup")
      assertOwnedFile(record.plan.path, record.beforeIdentity, record.before, "Preflighted public file after backup")
      record.backup = candidate
      return
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
      throw error
    }
  }
}

function rollbackPreflight(records: readonly CasRecord[]): void {
  for (const record of records) {
    assertParent(record)
    assertPreparedAndClaim(record)
    if (!record.mutated) {
      assertPublicBefore(record)
      continue
    }
    if (record.after === undefined) {
      if (!missing(record.plan.path)) throw new Error(`Third-party file prevents safe rollback: ${record.plan.path}`)
      continue
    }
    if (missing(record.plan.path)) continue
    if (!record.preparedIdentity) throw new Error(`Prepared identity is unavailable for rollback: ${record.plan.path}`)
    assertOwnedFile(record.plan.path, record.preparedIdentity, record.after, "Published file")
  }
}

/**
 * Multi-file no-clobber compare-and-swap. Every existing public file is first
 * hard-linked to a transaction-exact claim; publication uses only
 * create-if-absent hard links. Rollback mutates nothing until the complete
 * public/claim/prepared set has passed one identity-and-byte preflight.
 */
export function commitFileCasPlans(
  plans: readonly FileCasPlan[],
  options: {
    backups?: boolean
    stamp?: string
    hooks?: FileCasHooks
  } = {},
): Array<{ path: string; backup?: string }> {
  if (!plans.length) return []
  const keys = plans.map((plan) => normalizedPath(plan.path))
  if (new Set(keys).size !== keys.length) throw new Error("file transaction contains a duplicate path")
  const transaction = randomUUID()
  const stamp = options.stamp ?? timestamp()
  const records: CasRecord[] = plans.map((plan, index) => {
    const path = resolve(plan.path)
    const parent = dirname(path)
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    const record: CasRecord = {
      plan: { path, before: plan.before, after: plan.after, expectedIdentity: plan.expectedIdentity },
      index,
      before: plan.before === undefined ? undefined : Buffer.from(plan.before),
      after: plan.after === undefined ? undefined : Buffer.from(plan.after),
      parentIdentity: directDirectoryIdentity(parent),
      mutated: false,
      mutates: !((plan.before === undefined && plan.after === undefined) ||
        (plan.before !== undefined && plan.after !== undefined && Buffer.from(plan.before).equals(Buffer.from(plan.after)))),
    }
    if (record.before === undefined) {
      if (plan.expectedIdentity !== null) throw new Error(`Expected-absent file plan has an identity: ${path}`)
      if (!missing(path)) throw new Error(`Concurrent creation detected during preflight: ${path}`)
    } else {
      if (plan.expectedIdentity === null) throw new Error(`Expected-existing file plan has no identity: ${path}`)
      record.beforeIdentity = plan.expectedIdentity
      if (!sameIdentity(directRegularFileIdentity(path), record.beforeIdentity)) throw new Error(`Concurrent identity change detected during preflight: ${path}`)
      assertOwnedFile(path, record.beforeIdentity, record.before, "Preflighted public file")
    }
    return record
  })

  try {
    for (const record of records) if (record.mutates) createPrepared(record, transaction)
    if (options.backups !== false) for (const record of records) if (record.mutates) createBackup(record, stamp)
    for (const record of records) {
      assertParent(record)
      if (!record.mutates) continue
      if (record.before === undefined) {
        if (!missing(record.plan.path)) throw new Error(`Concurrent creation detected before claim phase: ${record.plan.path}`)
      } else {
        record.claim = resolve(dirname(record.plan.path), `.${basename(record.plan.path)}.alg-claim-${transaction}-${record.index}`)
        linkSync(record.plan.path, record.claim)
        record.claimIdentity = directRegularFileIdentity(record.claim)
        assertPreparedAndClaim(record)
      }
      options.hooks?.afterClaim?.(record.plan, record.index)
    }

    // Complete read-set preflight before the first public unlink/create.
    for (const record of records) {
      assertPublicBefore(record)
      assertPreparedAndClaim(record)
    }

    for (const record of records) {
      if (!record.mutates) continue
      // Every public read remains a transaction precondition at each commit
      // fence, including unchanged/custom-skipped/no-action paths.
      for (const candidate of records) assertPublicBefore(candidate)
      options.hooks?.beforeMutation?.(record.plan, record.index)
      assertPublicBefore(record)
      assertPreparedAndClaim(record)
      record.mutated = true
      if (record.before !== undefined) {
        unlinkSync(record.plan.path)
        options.hooks?.afterUnlink?.(record.plan, record.index)
      }
      if (record.after !== undefined) {
        options.hooks?.beforePublish?.(record.plan, record.index)
        if (!missing(record.plan.path)) throw new Error(`Public destination is occupied before no-clobber publish: ${record.plan.path}`)
        linkSync(record.prepared!, record.plan.path)
        options.hooks?.afterPublish?.(record.plan, record.index)
        assertOwnedFile(record.plan.path, record.preparedIdentity!, record.after, "Published file")
      } else if (!missing(record.plan.path)) {
        throw new Error(`Third-party file appeared after managed delete: ${record.plan.path}`)
      }
    }

    for (const record of records) {
      if (record.claim && record.claimIdentity && record.before) unlinkOwnedFile(record.claim, record.claimIdentity, record.before)
      if (record.prepared && record.preparedIdentity && record.after) unlinkOwnedFile(record.prepared, record.preparedIdentity, record.after)
    }
    return records.map((record) => ({ path: record.plan.path, backup: record.backup }))
  } catch (error) {
    const mutated = records.some((record) => record.mutated)
    const rollbackErrors: unknown[] = []
    if (mutated) {
      try {
        options.hooks?.beforeRollback?.(records.map((record) => record.plan))
        rollbackPreflight(records)
        for (const record of [...records].reverse()) {
          if (!record.mutated) continue
          if (record.after !== undefined && !missing(record.plan.path)) {
            assertOwnedFile(record.plan.path, record.preparedIdentity!, record.after, "Published file")
            unlinkSync(record.plan.path)
          }
          if (record.before !== undefined) {
            if (!missing(record.plan.path)) throw new Error(`Rollback destination is occupied: ${record.plan.path}`)
            linkSync(record.claim!, record.plan.path)
          }
        }
        for (const record of records) assertPublicBefore(record)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (!rollbackErrors.length) {
      for (const record of records) {
        try {
          if (record.claim && record.claimIdentity && record.before) unlinkOwnedFile(record.claim, record.claimIdentity, record.before)
          if (record.prepared && record.preparedIdentity && record.after) unlinkOwnedFile(record.prepared, record.preparedIdentity, record.after)
        } catch (cleanupError) {
          rollbackErrors.push(cleanupError)
        }
      }
    }
    if (rollbackErrors.length) throw new AggregateError([error, ...rollbackErrors], "file transaction failed and rollback was incomplete")
    throw error
  }
}

export function commitTextPlans(
  plans: readonly TextFilePlan[],
  options: {
    backups?: boolean
    stamp?: string
    beforeWrite?: (plan: TextFilePlan, index: number) => void
  } = {},
): Array<{ path: string; backup?: string }> {
  if (!plans.length) return []
  const byPath = new Map(plans.map((plan) => [normalizedPath(plan.path), plan]))
  return commitFileCasPlans(plans.map((plan) => ({
    path: plan.path,
    before: plan.before === undefined ? undefined : encodeConfigText(plan.before, plan.encoding),
    after: plan.changed ? encodeConfigText(plan.after, plan.encoding) : plan.before === undefined ? undefined : encodeConfigText(plan.before, plan.encoding),
    expectedIdentity: plan.expectedIdentity,
  })), {
    backups: options.backups,
    stamp: options.stamp,
    hooks: {
      beforeMutation(plan, index) {
        options.beforeWrite?.(byPath.get(normalizedPath(plan.path))!, index)
      },
    },
  })
}

export function exactBackup(path: string, stamp = timestamp()): string {
  const bytes = readFileSync(path)
  const identity = directRegularFileIdentity(path)
  for (;;) {
    const backup = backupPath(path, stamp)
    let fd: number | undefined
    try {
      assertOwnedFile(path, identity, bytes, "Backup source before copy")
      fd = openSync(backup, "wx", statSync(path).mode & 0o777)
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      const backupIdentity = directRegularFileIdentity(backup)
      if (sameIdentity(identity, backupIdentity) || digest(readFileSync(backup)) !== digest(bytes)) throw new Error(`Backup bytes or independence differ from source: ${path}`)
      assertOwnedFile(path, identity, bytes, "Backup source after copy")
      return backup
    } catch (error) {
      if (fd !== undefined) closeSync(fd)
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue
      throw error
    }
  }
}

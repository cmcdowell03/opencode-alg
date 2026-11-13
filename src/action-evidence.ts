import { closeSync, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, opendirSync, openSync, readSync, rmSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { canonicalJson, sha256Json } from "./persistence.ts"
import { runContainedPath } from "./store.ts"
import { redactEvolutionText } from "./skill-evolution-redaction.ts"
import type { RunDataReference } from "./types.ts"

export const ACTION_EVIDENCE_MAX_CALLS = 256
export const ACTION_EVIDENCE_MAX_MANIFEST_BYTES = 512 * 1024
export const ACTION_EVIDENCE_MAX_COMMAND_BYTES = 64 * 1024
export const ACTION_EVIDENCE_MAX_OUTPUT_BYTES = 64 * 1024
export const ACTION_EVIDENCE_MAX_RETAINED_BYTES = 32 * 1024 * 1024
const MAX_RECORD_BYTES = (ACTION_EVIDENCE_MAX_COMMAND_BYTES + ACTION_EVIDENCE_MAX_OUTPUT_BYTES) * 6 + 16 * 1024
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const HASH = /^[a-f0-9]{64}$/

export interface ActionEvidenceIdentity { run_id: string; node_id: string; attempt: number }
export interface ActionEvidenceCall { tool: string; sessionID: string; callID: string; args?: unknown }
export interface ActionEvidenceAfterResult { output?: unknown; metadata?: unknown; title?: unknown }
export interface ActionEvidenceOptions { maxRetainedBytes?: number }
export interface ActionEvidenceRecordReference extends RunDataReference { kind: "intent" | "terminal" | "gap"; ordinal: number }
export interface ActionEvidenceManifest {
  schema_version: 1
  kind: "action_evidence_manifest"
  identity: ActionEvidenceIdentity & { child_session_id: string }
  entries: ActionEvidenceRecordReference[]
  coverage: { observed_calls: number; completed: number; unknown_terminal: number; unsupported_tools: number; capture_gaps: number; complete: false }
}
export type ActionEvidenceRecord = (
  | { schema_version: 1; kind: "intent"; identity: ActionEvidenceIdentity & { child_session_id: string }; call_id_sha256: string; ordinal: number; tool: "bash"; command?: string; cwd?: string; command_redacted: boolean; command_source_truncated: boolean; cwd_redacted: boolean; cwd_source_truncated: boolean }
  | { schema_version: 1; kind: "terminal"; identity: ActionEvidenceIdentity & { child_session_id: string }; intent_sha256: string; call_id_sha256: string; ordinal: number; tool: "bash"; source: "hook" | "history"; tool_status: "completed" | "error"; output?: string; output_redacted: boolean; output_source_truncated: boolean; exit_code?: number; exit_code_status: "reported" | "unavailable" }
  | { schema_version: 1; kind: "gap"; identity: ActionEvidenceIdentity & { child_session_id: string }; ordinal: number; reason: "unsupported_tool" | "call_limit" | "retention_limit"; tool?: "unsupported" }
) & { command?: string; source?: "hook" | "history"; tool_status?: "completed" | "error"; exit_code_status?: "reported" | "unavailable"; exit_code?: number; output?: string }
function hashBytes(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex") }
function safeId(value: unknown, label: string, maximum = 256): string {
  if (typeof value !== "string" || value.length > maximum || !ID.test(value) || value === "." || value === "..") throw new Error(`${label} is invalid`)
  return value
}
function boundedText(value: unknown, maximum: number): { text?: string; redacted: boolean; source_truncated: boolean } {
  if (typeof value !== "string") return { redacted: false, source_truncated: false }
  // Scan only a bounded prefix. A credential that begins inside the retained
  // window is redacted through the end of its token/line before truncation.
  const scan = utf8Prefix(value, maximum + 8 * 1024)
  const decoded = redactEvolutionText(scan)
  const sanitized = redactShellCredentials(decoded)
  let text = sanitized
  let truncated = false
  if (Buffer.byteLength(text, "utf8") > maximum) {
    let low = 0, high = text.length
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maximum) low = mid; else high = mid - 1 }
    text = text.slice(0, low).replace(/[\uD800-\uDBFF]$/, "")
    truncated = true
  }
  return { ...(text ? { text } : {}), redacted: sanitized !== scan, source_truncated: truncated || scan.length !== value.length }
}
function utf8Prefix(value: string, maximum: number): string {
  let low = 0, high = Math.min(value.length, maximum)
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (Buffer.byteLength(value.slice(0, mid), "utf8") <= maximum) low = mid; else high = mid - 1 }
  return value.slice(0, low).replace(/[\uD800-\uDBFF]$/, "")
}
function redactShellCredentials(value: string): string {
  let result = value
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+(?::[^\s/@]*)?@/gi, "$1[REDACTED]@")
    .replace(/((?:--?|\/)(?:password|passwd|token|access[-_]?token|refresh[-_]?token|api[-_]?key|secret|credential|authorization)(?:\s*=\s*|\s+))("[^"\r\n]*"|'[^'\r\n]*'|[^\s;&|]+)/gi, "$1[REDACTED]")
    .replace(/((?:password|passwd|token|access[-_]?token|refresh[-_]?token|api[-_]?key|secret|credential|authorization)\s*[:=]\s*)("[^"\r\n]*"|'[^'\r\n]*'|[^\s,;&|]+)/gi, "$1[REDACTED]")
    .replace(/\b(?:Bearer|Basic|Token)\s+[A-Za-z0-9+/_=.-]+/gi, "[REDACTED]")
    .replace(/-----BEGIN ([A-Z0-9 ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/gi, "[REDACTED]")
    .replace(/\b(?:sk|rk|pk)-(?:live|test|proj)?-?[A-Za-z0-9_-]{16,}\b|\bgh[opusr]_[A-Za-z0-9]{20,}\b|\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED]")
  return result
}
function exactExitCode(metadata: unknown): number | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined
  const row = metadata as Record<string, unknown>
  for (const key of ["exit_code", "exitCode", "exit"]) if (typeof row[key] === "number" && Number.isSafeInteger(row[key])) return row[key] as number
  return undefined
}
function sessionKey(session: string): string { return hashBytes(Buffer.from(session, "utf8")) }

/** Durable hook evidence. Records are immutable; this class never reads or mutates RunState. */
export class ActionEvidenceJournal {
  private readonly bindings = new Map<string, { identity: ActionEvidenceIdentity; project: string; calls: Map<string, ActionEvidenceRecordReference>; ordinal: number; entries: ActionEvidenceRecordReference[]; retained: number; gaps: number; unsupported: number; completed: number }>()
  private readonly maximum: number
  constructor(private readonly projectDirectory: string, options: ActionEvidenceOptions = {}) {
    this.maximum = Math.max(0, Math.min(options.maxRetainedBytes ?? ACTION_EVIDENCE_MAX_RETAINED_BYTES, ACTION_EVIDENCE_MAX_RETAINED_BYTES))
  }

  bind(sessionID: string, identity: ActionEvidenceIdentity): void {
    const session = safeId(sessionID, "sessionID")
    const parsed = { run_id: safeId(identity.run_id, "run_id", 64), node_id: safeId(identity.node_id, "node_id", 64), attempt: identity.attempt }
    if (!Number.isSafeInteger(parsed.attempt) || parsed.attempt < 1 || parsed.attempt > 10_000) throw new Error("attempt is invalid")
    if (this.bindings.has(session)) throw new Error("session is already bound")
    runContainedPath(this.projectDirectory, parsed.run_id, "artifacts", "action-evidence", sessionKey(session))
    this.bindings.set(session, { identity: parsed, project: this.projectDirectory, calls: new Map(), ordinal: 0, entries: [], retained: 0, gaps: 0, unsupported: 0, completed: 0 })
  }

  has(sessionID: string): boolean { return this.bindings.has(sessionID) }
  unbind(sessionID: string): void { this.bindings.delete(safeId(sessionID, "sessionID")) }

  before(call: ActionEvidenceCall & { tool: "bash" }, args: unknown): ActionEvidenceRecordReference
  before(call: ActionEvidenceCall, args: unknown): ActionEvidenceRecordReference | undefined
  before(call: ActionEvidenceCall, args: unknown): ActionEvidenceRecordReference | undefined {
    const b = this.binding(call.sessionID)
    safeId(call.callID, "callID")
    b.ordinal++
    if (b.ordinal > ACTION_EVIDENCE_MAX_CALLS) { b.ordinal = ACTION_EVIDENCE_MAX_CALLS; if (!b.entries.some(entry => entry.kind === "gap" && entry.ordinal === ACTION_EVIDENCE_MAX_CALLS)) this.addGap(b, "call_limit"); return undefined }
    if (call.tool !== "bash") { this.addGap(b, "unsupported_tool", true); b.unsupported++; return undefined }
    const callHash = hashBytes(Buffer.from(call.callID, "utf8"))
    if (b.calls.has(callHash)) throw new Error("duplicate action call id")
    const input = args && typeof args === "object" && !Array.isArray(args) ? args as Record<string, unknown> : {}
    const command = boundedText(input.command, ACTION_EVIDENCE_MAX_COMMAND_BYTES)
    const cwd = boundedText(input.cwd ?? input.directory ?? input.working_directory, ACTION_EVIDENCE_MAX_COMMAND_BYTES)
    const value: ActionEvidenceRecord = { schema_version: 1, kind: "intent", identity: { ...b.identity, child_session_id: call.sessionID }, call_id_sha256: callHash, ordinal: b.ordinal, tool: "bash", ...(command.text ? { command: command.text } : {}), ...(cwd.text ? { cwd: cwd.text } : {}), command_redacted: command.redacted, command_source_truncated: command.source_truncated, cwd_redacted: cwd.redacted, cwd_source_truncated: cwd.source_truncated }
    let ref: ActionEvidenceRecordReference
    try { ref = this.persist(b, value) } catch (error) { b.gaps++; throw error }
    b.calls.set(callHash, ref)
    return ref
  }

  after(call: ActionEvidenceCall, result: ActionEvidenceAfterResult): ActionEvidenceRecordReference | undefined
  after(call: ActionEvidenceCall, args: unknown, result: ActionEvidenceAfterResult): ActionEvidenceRecordReference | undefined
  after(call: ActionEvidenceCall, argsOrResult: unknown, maybeResult?: ActionEvidenceAfterResult): ActionEvidenceRecordReference | undefined {
    const b = this.binding(call.sessionID)
    if (call.tool !== "bash") return undefined
    const callHash = hashBytes(Buffer.from(safeId(call.callID, "callID"), "utf8"))
    const intentRef = b.calls.get(callHash)
    if (!intentRef) throw new Error("action evidence intent is missing; terminal outcome remains unknown")
    const intent = this.readRecord(intentRef, { ...b.identity, child_session_id: call.sessionID })
    if (intent.kind !== "intent") throw new Error("action evidence intent is invalid")
    if (b.entries.some(entry => entry.kind === "terminal" && entry.ordinal === intent.ordinal)) throw new Error("action call already has a terminal record")
    const result = (maybeResult ?? argsOrResult) as ActionEvidenceAfterResult
    const output = boundedText(result?.output, ACTION_EVIDENCE_MAX_OUTPUT_BYTES)
    const exitCode = exactExitCode(result?.metadata)
    const status = result?.metadata && typeof result.metadata === "object" && (result.metadata as Record<string, unknown>).error === true ? "error" : "completed"
    const value: ActionEvidenceRecord = { schema_version: 1, kind: "terminal", identity: { ...b.identity, child_session_id: call.sessionID }, intent_sha256: intentRef.sha256, call_id_sha256: callHash, ordinal: intent.ordinal, tool: "bash", source: "hook", tool_status: status, ...(output.text ? { output: output.text } : {}), output_redacted: output.redacted, output_source_truncated: output.source_truncated || (result?.metadata as any)?.truncated === true, ...(exitCode === undefined ? {} : { exit_code: exitCode }), exit_code_status: exitCode === undefined ? "unavailable" : "reported" }
    try { const ref = this.persist(b, value); b.completed++; return ref }
    catch { b.gaps++; return undefined }
  }

  finish(sessionID: string): RunDataReference {
    const session = safeId(sessionID, "sessionID"), b = this.binding(session)
    const manifest = this.manifest(session, b)
    const text = canonicalJson(manifest), bytes = Buffer.from(text, "utf8")
    if (bytes.byteLength > ACTION_EVIDENCE_MAX_MANIFEST_BYTES) throw new Error("action evidence manifest exceeds byte limit")
    const sha256 = hashBytes(bytes)
    const artifact_path = this.relative(session, b, `manifest-${sha256}.json`)
    this.writeImmutable(this.absolute(session, b, `manifest-${sha256}.json`), bytes, session, b)
    this.unbind(session)
    return { artifact_path, sha256, byte_size: bytes.byteLength }
  }

  recover(identity: ActionEvidenceIdentity, sessionID: string): RunDataReference | undefined {
    const session = safeId(sessionID, "sessionID")
    this.bind(session, identity)
    try {
    const b = this.binding(session), dir = this.directory(session, b)
    if (!existsSync(dir)) { this.unbind(session); return undefined }
    mkdirSync(dir, { recursive: true })
    const names = listRecordNames(dir)
    const records: Array<{ value: ActionEvidenceRecord; ref: ActionEvidenceRecordReference }> = []
    for (const name of names) {
      const path = this.absolute(session, b, name), bytes = readBoundedRegular(path, MAX_RECORD_BYTES), value = parseRecord(bytes)
      if (value.identity.run_id !== b.identity.run_id || value.identity.node_id !== b.identity.node_id || value.identity.attempt !== b.identity.attempt || value.identity.child_session_id !== session) throw new Error("action evidence recovery identity mismatch")
      const kind = value.kind, sha256 = hashBytes(bytes)
      if (name !== `${kind}-${sha256}.json`) throw new Error("action evidence recovery filename mismatch")
      const ref: ActionEvidenceRecordReference = { artifact_path: this.relative(session, b, name), sha256, byte_size: bytes.byteLength, kind, ordinal: value.ordinal }
      records.push({ value, ref }); b.retained += bytes.byteLength
      if (b.retained > this.maximum) throw new Error("recovered action evidence exceeds configured retention limit")
    }
    if (records.length === 0) { this.unbind(session); return undefined }
    records.sort((a, c) => a.value.ordinal - c.value.ordinal || (a.value.kind === "intent" ? -1 : 1))
    b.entries = records.map(item => item.ref)
    b.ordinal = records.reduce((n, item) => Math.max(n, item.value.ordinal), 0)
    b.gaps = records.filter(item => item.value.kind === "gap").length
    b.unsupported = records.filter(item => item.value.kind === "gap" && item.value.reason === "unsupported_tool").length
    b.completed = records.filter(item => item.value.kind === "terminal").length
    for (const item of records) if (item.value.kind === "intent") b.calls.set(item.value.call_id_sha256, item.ref)
    return this.finish(session)
    } catch (error) {
      this.unbind(session)
      throw error
    }
  }

  /** Reconcile only existing intents against same-session hook history; never creates inferred intents. */
  reconcileHistory(sessionID: string, messages: unknown[]): number {
    const session = safeId(sessionID, "sessionID"), b = this.binding(session)
    let added = 0
    for (const raw of messages.slice(0, ACTION_EVIDENCE_MAX_CALLS * 8)) {
      if (!raw || typeof raw !== "object") continue
      const message = raw as Record<string, any>, infoSession = message.info?.sessionID
      for (const part of Array.isArray(message.parts) ? message.parts : []) {
        if (!part || typeof part !== "object" || String(part.tool ?? "").toLowerCase() !== "bash") continue
        const partSession = part.sessionID
        if (infoSession !== session || partSession !== session) continue
        const callID = typeof part.callID === "string" ? part.callID : undefined
        const status = part.state?.status
        if (!callID || (status !== "completed" && status !== "error")) continue
        const key = hashBytes(Buffer.from(callID, "utf8")), intentRef = b.calls.get(key)
        if (!intentRef) continue
        const intent = this.readRecord(intentRef, { ...b.identity, child_session_id: session })
        if (intent.kind !== "intent" || b.entries.some(entry => entry.kind === "terminal" && entry.ordinal === intent.ordinal)) continue
        const state = part.state as Record<string, any>, output = boundedText(status === "error" ? state.error : state.output, ACTION_EVIDENCE_MAX_OUTPUT_BYTES), exitCode = exactExitCode(state.metadata)
        const value: ActionEvidenceRecord = { schema_version: 1, kind: "terminal", identity: { ...b.identity, child_session_id: session }, intent_sha256: intentRef.sha256, call_id_sha256: key, ordinal: intent.ordinal, tool: "bash", source: "history", tool_status: status, ...(output.text ? { output: output.text } : {}), output_redacted: output.redacted, output_source_truncated: output.source_truncated || state.metadata?.truncated === true, ...(exitCode === undefined ? {} : { exit_code: exitCode }), exit_code_status: exitCode === undefined ? "unavailable" : "reported" }
        try { this.persist(b, value); b.completed++; added++ } catch { b.gaps++ }
      }
    }
    return added
  }

  readManifest(reference: RunDataReference, identity: ActionEvidenceIdentity): ActionEvidenceManifest {
    const value = this.readJson(reference, identity, "manifest")
    const m = value as ActionEvidenceManifest
    validateManifestShape(m)
    if (m.entries.length > ACTION_EVIDENCE_MAX_CALLS * 3) throw new Error("action evidence manifest is invalid")
    const session = safeId(m.identity?.child_session_id, "child_session_id")
    this.assertIdentity(m.identity, identity, session)
    for (const entry of m.entries) {
      if (!entry || !["intent", "terminal", "gap"].includes(entry.kind) || !HASH.test(entry.sha256) || !Number.isSafeInteger(entry.byte_size) || entry.byte_size < 1 || entry.byte_size > MAX_RECORD_BYTES || !Number.isSafeInteger(entry.ordinal)) throw new Error("action evidence manifest entry is invalid")
      const record = this.readRecord(entry, { ...identity, child_session_id: session })
      if (record.kind !== entry.kind || record.ordinal !== entry.ordinal) throw new Error("action evidence manifest record linkage mismatch")
    }
    const ordered = [...m.entries].sort((a, b) => a.ordinal - b.ordinal || (a.kind === "intent" ? -1 : a.kind === "terminal" ? 0 : 1))
    if (ordered.some((entry, index) => entry.artifact_path !== m.entries[index]?.artifact_path)) throw new Error("action evidence manifest entries are not chronological")
    const intents = new Map(m.entries.filter(entry => entry.kind === "intent").map(entry => [entry.ordinal, entry.sha256]))
    if (intents.size !== m.entries.filter(entry => entry.kind === "intent").length) throw new Error("action evidence has duplicate intent ordinals")
    const terminals = m.entries.filter(entry => entry.kind === "terminal").map(entry => this.readRecord(entry, { ...identity, child_session_id: session }) as Extract<ActionEvidenceRecord, { kind: "terminal" }>)
    if (terminals.some(record => intents.get(record.ordinal) !== record.intent_sha256 || record.call_id_sha256 !== (this.readRecord(m.entries.find(entry => entry.kind === "intent" && entry.ordinal === record.ordinal)!, { ...identity, child_session_id: session }) as Extract<ActionEvidenceRecord, { kind: "intent" }>).call_id_sha256) || new Set(terminals.map(record => record.ordinal)).size !== terminals.length) throw new Error("action evidence terminal linkage is invalid")
    const gaps = m.entries.filter(entry => entry.kind === "gap")
    const expected = { observed_calls: intents.size, completed: terminals.length, unknown_terminal: Math.max(0, intents.size - terminals.length), unsupported_tools: gaps.filter(entry => (this.readRecord(entry, { ...identity, child_session_id: session }) as Extract<ActionEvidenceRecord, { kind: "gap" }>).reason === "unsupported_tool").length, capture_gaps: gaps.length }
    if (m.coverage.observed_calls !== expected.observed_calls || m.coverage.completed !== expected.completed || m.coverage.unknown_terminal !== expected.unknown_terminal || m.coverage.unsupported_tools < expected.unsupported_tools || m.coverage.capture_gaps < expected.capture_gaps || m.coverage.unsupported_tools > m.coverage.capture_gaps || m.coverage.complete !== false) throw new Error("action evidence coverage does not match records")
    return m
  }

  readRecord(reference: RunDataReference, identity: ActionEvidenceIdentity & { child_session_id: string }): ActionEvidenceRecord {
    const session = safeId(identity.child_session_id, "child_session_id")
    const value = this.readJson(reference, identity, "record") as ActionEvidenceRecord
    validateRecordShape(value)
    this.assertIdentity(value.identity, identity, session)
    if (reference.artifact_path.split("/").at(-1) !== `${value.kind}-${reference.sha256}.json` || value.ordinal < 1 || value.ordinal > ACTION_EVIDENCE_MAX_CALLS) throw new Error("action evidence record reference mismatch")
    return value
  }

  private addGap(b: NonNullable<ReturnType<ActionEvidenceJournal["binding"]>>, reason: "unsupported_tool" | "call_limit" | "retention_limit", unsupportedTool = false): void {
    const ordinal = Math.min(b.ordinal, ACTION_EVIDENCE_MAX_CALLS)
    const value: ActionEvidenceRecord = { schema_version: 1, kind: "gap", identity: { ...b.identity, child_session_id: [...this.bindings].find(([, candidate]) => candidate === b)?.[0] ?? "unknown" }, ordinal, reason, ...(unsupportedTool ? { tool: "unsupported" } : {}) }
    b.gaps++
    try { this.persist(b, value) } catch { /* The manifest coverage counter itself preserves the gap if the byte cap prevents a gap record. */ }
  }

  private persist(b: NonNullable<ReturnType<ActionEvidenceJournal["binding"]>>, value: ActionEvidenceRecord): ActionEvidenceRecordReference {
    const bytes = Buffer.from(canonicalJson(value), "utf8")
    if (b.retained + bytes.byteLength > this.maximum) throw new Error("action evidence retention limit exceeded; capture gap recorded in manifest coverage")
    const sha256 = hashBytes(bytes), name = `${value.kind}-${sha256}.json`, session = value.identity.child_session_id
    this.writeImmutable(this.absolute(session, b, name), bytes, session, b)
    const ref = { artifact_path: this.relative(session, b, name), sha256, byte_size: bytes.byteLength, kind: value.kind, ordinal: value.ordinal } as ActionEvidenceRecordReference
    if (!b.entries.some(item => item.artifact_path === ref.artifact_path)) { b.entries.push(ref); b.retained += bytes.byteLength }
    return ref
  }

  private manifest(session: string, b: NonNullable<ReturnType<ActionEvidenceJournal["binding"]>>): ActionEvidenceManifest {
    const entries = [...b.entries].sort((a, c) => a.ordinal - c.ordinal || (a.kind === "intent" ? -1 : a.kind === "terminal" ? 0 : 1))
    const intents = entries.filter(entry => entry.kind === "intent").length
    return { schema_version: 1, kind: "action_evidence_manifest", identity: { ...b.identity, child_session_id: session }, entries,
      coverage: { observed_calls: intents, completed: b.completed, unknown_terminal: Math.max(0, intents - b.completed), unsupported_tools: b.unsupported, capture_gaps: b.gaps, complete: false } }
  }
  private binding(sessionID: string) { const value = this.bindings.get(sessionID); if (!value) throw new Error("session has no action evidence binding"); return value }
  private directory(session: string, b: NonNullable<ReturnType<ActionEvidenceJournal["binding"]>>) { return runContainedPath(b.project, b.identity.run_id, "artifacts", "action-evidence", sessionKey(session)) }
  private relative(session: string, b: NonNullable<ReturnType<ActionEvidenceJournal["binding"]>>, name: string) { return `.opencode/runs/${b.identity.run_id}/artifacts/action-evidence/${sessionKey(session)}/${name}` }
  private absolute(session: string, b: NonNullable<ReturnType<ActionEvidenceJournal["binding"]>>, name: string) { return runContainedPath(b.project, b.identity.run_id, "artifacts", "action-evidence", sessionKey(session), name) }
  private assertIdentity(actual: any, expected: ActionEvidenceIdentity, session: string) {
    if (!actual || actual.run_id !== expected.run_id || actual.node_id !== expected.node_id || actual.attempt !== expected.attempt || actual.child_session_id !== session) throw new Error("action evidence identity mismatch")
  }
  private validateReferencePath(ref: RunDataReference, identity: ActionEvidenceIdentity, session: string, manifest: boolean) {
    const name = ref.artifact_path.split("/").at(-1) ?? ""
    if (manifest ? !/^manifest-[a-f0-9]{64}\.json$/.test(name) : !/^(?:intent|terminal|gap)-[a-f0-9]{64}\.json$/.test(name)) throw new Error("action evidence reference path is invalid")
    const expected = `.opencode/runs/${identity.run_id}/artifacts/action-evidence/${sessionKey(session)}/${name}`
    if (ref.artifact_path !== expected || !HASH.test(ref.sha256) || !name.includes(ref.sha256)) throw new Error("action evidence reference is forged or cross-session")
    const path = runContainedPath(this.projectDirectory, identity.run_id, "artifacts", "action-evidence", sessionKey(session), name)
    const bytes = readBoundedRegular(path, manifest ? ACTION_EVIDENCE_MAX_MANIFEST_BYTES : MAX_RECORD_BYTES)
    if (bytes.byteLength !== ref.byte_size || hashBytes(bytes) !== ref.sha256) throw new Error("action evidence content integrity mismatch")
  }
  private readJson(reference: RunDataReference, identity: ActionEvidenceIdentity, type: "manifest" | "record"): unknown {
    if (!reference || !Number.isSafeInteger(reference.byte_size) || reference.byte_size < 1 || reference.byte_size > (type === "manifest" ? ACTION_EVIDENCE_MAX_MANIFEST_BYTES : MAX_RECORD_BYTES) || !HASH.test(reference.sha256)) throw new Error("action evidence reference bounds are invalid")
    const session = type === "record" ? (identity as ActionEvidenceIdentity & { child_session_id: string }).child_session_id : undefined
    if (type === "record" && !session) throw new Error("record identity requires child session")
    const name = reference.artifact_path.split("/").at(-1) ?? ""
    const root = `.opencode/runs/${identity.run_id}/artifacts/action-evidence/`
    if (!reference.artifact_path.startsWith(root)) throw new Error("action evidence path is outside run evidence root")
    if (type === "manifest") {
      const match = reference.artifact_path.match(/^\.opencode\/runs\/([^/]+)\/artifacts\/action-evidence\/([a-f0-9]{64})\/manifest-([a-f0-9]{64})\.json$/)
      if (!match || match[1] !== identity.run_id || match[3] !== reference.sha256) throw new Error("action evidence manifest reference is forged")
      const bytes = readBoundedRegular(runContainedPath(this.projectDirectory, identity.run_id, "artifacts", "action-evidence", match[2]!, name), ACTION_EVIDENCE_MAX_MANIFEST_BYTES)
      return verifyJson(bytes, reference)
    }
    this.validateReferencePath(reference, identity, session!, false)
    const bytes = readBoundedRegular(runContainedPath(this.projectDirectory, identity.run_id, "artifacts", "action-evidence", sessionKey(session!), name), MAX_RECORD_BYTES)
    return verifyJson(bytes, reference)
  }
  private writeImmutable(path: string, bytes: Buffer, session: string, b: NonNullable<ReturnType<ActionEvidenceJournal["binding"]>>) {
    mkdirSync(dirname(path), { recursive: true })
    const temporary = this.absolute(session, b, `.action-evidence-${randomUUID()}.tmp`)
    let fd: number | undefined
    let created = false
    try {
      fd = openSync(temporary, "wx", 0o600)
      created = true
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      try { linkSync(temporary, path) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const old = readBoundedRegular(path, Math.max(bytes.byteLength, MAX_RECORD_BYTES))
        if (!old.equals(bytes)) throw new Error("immutable action evidence collision")
      }
    } catch (error) {
      throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
      if (created) { try { rmSync(temporary, { force: true }) } catch {} }
    }
  }
}

/** Stateless read helpers for parent integrations that do not own the hook journal instance. */
export function readActionManifest(projectDirectory: string, reference: RunDataReference, identity: ActionEvidenceIdentity): ActionEvidenceManifest {
  return new ActionEvidenceJournal(projectDirectory).readManifest(reference, identity)
}
export function readActionRecord(projectDirectory: string, reference: ActionEvidenceRecordReference, identity: ActionEvidenceIdentity & { child_session_id: string }): ActionEvidenceRecord {
  return new ActionEvidenceJournal(projectDirectory).readRecord(reference, identity)
}
export function actionEvidenceRecordReferences(manifest: ActionEvidenceManifest): readonly ActionEvidenceRecordReference[] {
  if (manifest.kind !== "action_evidence_manifest" || manifest.schema_version !== 1 || manifest.coverage.complete !== false) throw new Error("unsupported action evidence manifest")
  return manifest.entries
}
export function assertActionEvidenceManifestIdentity(manifest: ActionEvidenceManifest, identity: ActionEvidenceIdentity, childSessionID: string): void {
  if (manifest.kind !== "action_evidence_manifest" || manifest.schema_version !== 1 || manifest.identity.run_id !== identity.run_id || manifest.identity.node_id !== identity.node_id || manifest.identity.attempt !== identity.attempt || manifest.identity.child_session_id !== childSessionID) throw new Error("action evidence manifest identity mismatch")
}

function listRecordNames(path: string): string[] {
  const maximum = ACTION_EVIDENCE_MAX_CALLS * 3 + 1, names: string[] = [], directory = opendirSync(path)
  try {
    while (true) {
      const entry = directory.readSync()
      if (!entry) break
      if (entry.isFile() && /^(?:intent|terminal|gap)-[a-f0-9]{64}\.json$/.test(entry.name)) {
        names.push(entry.name)
        if (names.length > maximum) throw new Error("action evidence recovery file limit exceeded")
      }
    }
  } finally { directory.closeSync() }
  return names.sort()
}
function exactKeys(value: Record<string, unknown>, allowed: string[], required: string[]): boolean {
  const keys = Object.keys(value)
  return keys.every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(value, key))
}
function validateIdentityShape(value: unknown): asserts value is ActionEvidenceIdentity & { child_session_id: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("action evidence identity is invalid")
  const row = value as Record<string, unknown>
  if (!exactKeys(row, ["run_id", "node_id", "attempt", "child_session_id"], ["run_id", "node_id", "attempt", "child_session_id"])) throw new Error("action evidence identity fields are invalid")
  safeId(row.run_id, "run_id", 64); safeId(row.node_id, "node_id", 64); safeId(row.child_session_id, "child_session_id")
  if (!Number.isSafeInteger(row.attempt) || (row.attempt as number) < 1 || (row.attempt as number) > 10_000) throw new Error("action evidence identity attempt is invalid")
}
function validateManifestShape(value: unknown): asserts value is ActionEvidenceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("action evidence manifest is invalid")
  const row = value as Record<string, any>
  if (!exactKeys(row, ["schema_version", "kind", "identity", "entries", "coverage"], ["schema_version", "kind", "identity", "entries", "coverage"]) || row.schema_version !== 1 || row.kind !== "action_evidence_manifest" || !Array.isArray(row.entries) || !row.coverage || typeof row.coverage !== "object" || Array.isArray(row.coverage)) throw new Error("action evidence manifest fields are invalid")
  validateIdentityShape(row.identity)
  if (!exactKeys(row.coverage, ["observed_calls", "completed", "unknown_terminal", "unsupported_tools", "capture_gaps", "complete"], ["observed_calls", "completed", "unknown_terminal", "unsupported_tools", "capture_gaps", "complete"]) || row.coverage.complete !== false) throw new Error("action evidence coverage fields are invalid")
  for (const key of ["observed_calls", "completed", "unknown_terminal", "unsupported_tools", "capture_gaps"]) if (!Number.isSafeInteger(row.coverage[key]) || row.coverage[key] < 0 || row.coverage[key] > ACTION_EVIDENCE_MAX_CALLS * 2) throw new Error("action evidence coverage count is invalid")
  for (const entry of row.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !exactKeys(entry, ["artifact_path", "sha256", "byte_size", "kind", "ordinal"], ["artifact_path", "sha256", "byte_size", "kind", "ordinal"])) throw new Error("action evidence reference fields are invalid")
    if (typeof entry.artifact_path !== "string" || !HASH.test(entry.sha256) || !Number.isSafeInteger(entry.byte_size) || entry.byte_size < 1 || entry.byte_size > MAX_RECORD_BYTES || !["intent", "terminal", "gap"].includes(entry.kind) || !Number.isSafeInteger(entry.ordinal) || entry.ordinal < 1 || entry.ordinal > ACTION_EVIDENCE_MAX_CALLS) throw new Error("action evidence reference bounds are invalid")
  }
}
function validateRecordShape(value: unknown): asserts value is ActionEvidenceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("action evidence record is invalid")
  const row = value as Record<string, any>
  if (row.schema_version !== 1 || !["intent", "terminal", "gap"].includes(row.kind)) throw new Error("action evidence record kind is invalid")
  validateIdentityShape(row.identity)
  if (!Number.isSafeInteger(row.ordinal) || row.ordinal < 1 || row.ordinal > ACTION_EVIDENCE_MAX_CALLS) throw new Error("action evidence record ordinal is invalid")
  if (row.kind === "intent") {
    if (!exactKeys(row, ["schema_version", "kind", "identity", "call_id_sha256", "ordinal", "tool", "command", "cwd", "command_redacted", "command_source_truncated", "cwd_redacted", "cwd_source_truncated"], ["schema_version", "kind", "identity", "call_id_sha256", "ordinal", "tool", "command_redacted", "command_source_truncated", "cwd_redacted", "cwd_source_truncated"]) || row.tool !== "bash" || !HASH.test(row.call_id_sha256)) throw new Error("action evidence intent fields are invalid")
    for (const key of ["command", "cwd"]) if (row[key] !== undefined && (typeof row[key] !== "string" || Buffer.byteLength(row[key], "utf8") > ACTION_EVIDENCE_MAX_COMMAND_BYTES)) throw new Error("action evidence intent text is invalid")
    for (const key of ["command_redacted", "command_source_truncated", "cwd_redacted", "cwd_source_truncated"]) if (typeof row[key] !== "boolean") throw new Error("action evidence intent flags are invalid")
  } else if (row.kind === "terminal") {
    if (!exactKeys(row, ["schema_version", "kind", "identity", "intent_sha256", "call_id_sha256", "ordinal", "tool", "source", "tool_status", "output", "output_redacted", "output_source_truncated", "exit_code", "exit_code_status"], ["schema_version", "kind", "identity", "intent_sha256", "call_id_sha256", "ordinal", "tool", "source", "tool_status", "output_redacted", "output_source_truncated", "exit_code_status"]) || row.tool !== "bash" || !HASH.test(row.intent_sha256) || !HASH.test(row.call_id_sha256) || !["hook", "history"].includes(row.source) || !["completed", "error"].includes(row.tool_status) || !["reported", "unavailable"].includes(row.exit_code_status) || (row.exit_code_status === "reported") !== (row.exit_code !== undefined) || (row.exit_code !== undefined && !Number.isSafeInteger(row.exit_code))) throw new Error("action evidence terminal fields are invalid")
    if (row.output !== undefined && (typeof row.output !== "string" || Buffer.byteLength(row.output, "utf8") > ACTION_EVIDENCE_MAX_OUTPUT_BYTES)) throw new Error("action evidence terminal output is invalid")
    if (typeof row.output_redacted !== "boolean" || typeof row.output_source_truncated !== "boolean") throw new Error("action evidence terminal flags are invalid")
  } else {
    if (!exactKeys(row, ["schema_version", "kind", "identity", "ordinal", "reason", "tool"], ["schema_version", "kind", "identity", "ordinal", "reason"]) || !["unsupported_tool", "call_limit", "retention_limit"].includes(row.reason) || (row.tool !== undefined && (row.reason !== "unsupported_tool" || row.tool !== "unsupported")) || (row.reason === "unsupported_tool" && row.tool !== "unsupported")) throw new Error("action evidence gap fields are invalid")
  }
}
function readBoundedRegular(path: string, maximum: number): Buffer {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) throw new Error("action evidence is not a bounded regular file")
  const fd = openSync(path, "r")
  try {
    const actual = fstatSync(fd).size
    if (actual !== stat.size || actual > maximum) throw new Error("action evidence changed while reading")
    const bytes = Buffer.alloc(actual), read = readSync(fd, bytes, 0, actual, 0)
    if (read !== actual) throw new Error("action evidence short read")
    return bytes
  } finally { closeSync(fd) }
}
function verifyJson(bytes: Buffer, reference: RunDataReference): unknown {
  if (bytes.byteLength !== reference.byte_size || hashBytes(bytes) !== reference.sha256) throw new Error("action evidence byte/hash mismatch")
  const text = bytes.toString("utf8"), value = JSON.parse(text)
  if (canonicalJson(value) !== text || sha256Json(value) !== reference.sha256) throw new Error("action evidence is not canonical JSON")
  return value
}
function parseRecord(bytes: Buffer): ActionEvidenceRecord {
  const value = JSON.parse(bytes.toString("utf8")) as ActionEvidenceRecord
  if (canonicalJson(value) !== bytes.toString("utf8")) throw new Error("action evidence record is not canonical")
  validateRecordShape(value)
  return value
}

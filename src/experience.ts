/** Explicit, project-private experience outbox. No host hook or model call runs here. */
import { createHash } from "node:crypto"
import { existsSync, lstatSync, mkdirSync, opendirSync, realpathSync } from "node:fs"
import { join, relative } from "node:path"
import { z } from "zod"
import { canonicalDirectory, isSafeId } from "./paths.ts"
import { canonicalJson } from "./persistence.ts"
import { atomicWriteFile, listOwnedRunEnvelopeResults, loadCommittedRunProjectionForOwner } from "./store.ts"
import { loadHistoricalIndex } from "./skill-evolution-store.ts"
import { acquireFilesystemMutex } from "./filesystem-mutex.ts"
import { readSkillEvolutionDirectBounded } from "./skill-evolution-store.ts"
import { redactEvidenceText } from "./skill-evolution-evidence.ts"

const Id = z.string().refine(isSafeId, "unsafe ID")
const Hash = z.string().regex(/^[a-f0-9]{64}$/)
const Text = z.string().min(1).max(2000)
export const EXPERIENCE_MAX_OBJECT_BYTES = 32_768
export const EXPERIENCE_MAX_OBJECTS = 10_000
export const EXPERIENCE_INTAKE_MAX_RUNS = 32
export const ExperienceSchema = z.object({
  schema_version: z.literal(1),
  id: Hash,
  project: Hash,
  kind: z.enum(["experience", "source_artifact", "attempt", "observation", "outcome", "dataset", "incident", "hypothesis", "action", "skill_version", "candidate", "evaluation"]),
  source: z.object({ type: Id, id: Id, sha256: Hash }).strict(),
  observed_at: z.iso.datetime({ offset: true }),
  privacy: z.literal("project-private"),
  retention: z.enum(["operational", "evaluation", "archival"]),
  status: z.enum(["observed", "inferred", "success", "failure", "indeterminate", "abstained"]),
  summary: Text,
  skill_version: Hash.nullable(),
  group: Id,
  relations: z.array(z.object({ kind: z.enum(["derived_from", "supports", "refutes", "tests", "produced", "applied", "evaluates", "supersedes"]), id: Hash }).strict()).max(64),
  metrics: z.record(Id, z.number().finite().nullable()).refine((v) => Object.keys(v).length <= 32),
}).strict()
export type Experience = z.infer<typeof ExperienceSchema>
export type ExperienceInput = Omit<Experience, "schema_version" | "id" | "project" | "privacy">
export const ExperienceInputSchema = ExperienceSchema.omit({ schema_version: true, id: true, project: true, privacy: true })

export function experienceHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

export function experienceProject(project: string): string {
  const canonical = canonicalDirectory(project)
  return experienceHash(process.platform === "win32" ? canonical.toLowerCase() : canonical)
}

/** Refuse every redirected component, even redirects that remain inside the project. */
function directory(project: string, parts: string[], create: boolean): string {
  let current = canonicalDirectory(project)
  const components = [".opencode", "experience", ...parts]
  for (const [index, part] of components.entries()) {
    if (index !== 0 && !isSafeId(part)) throw new Error("unsafe experience path")
    current = join(current, part)
    if (!existsSync(current)) {
      if (!create) return join(current, ...components.slice(index + 1))
      try { mkdirSync(current, { mode: 0o700 }) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      }
    }
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(current, realpathSync.native(current)) !== "") {
      throw new Error("experience directory is redirected or not a directory")
    }
  }
  return current
}

function objectPath(project: string, id: string, archived = false): string {
  Hash.parse(id)
  return join(directory(project, [archived ? "archive" : "outbox"], false), `${id}.json`)
}

export function loadExperience(project: string, id: string): Experience {
  let path = objectPath(project, id)
  if (!existsSync(path)) path = objectPath(project, id, true)
  const bytes = readSkillEvolutionDirectBounded(canonicalDirectory(project), path, EXPERIENCE_MAX_OBJECT_BYTES, "experience")
  const archived = objectPath(project, id, true)
  if (path !== archived && existsSync(archived) && !readSkillEvolutionDirectBounded(canonicalDirectory(project), archived, EXPERIENCE_MAX_OBJECT_BYTES, "archived experience").equals(bytes)) {
    throw new Error("archived experience disagrees with outbox")
  }
  const value = ExperienceSchema.parse(JSON.parse(bytes.toString("utf8")))
  const { id: observedId, ...body } = value
  if (value.project !== experienceProject(project) || observedId !== id || experienceHash(body) !== id) {
    throw new Error("experience identity or project mismatch")
  }
  return value
}

export function listExperience(project: string): Experience[] {
  const ids = new Set<string>()
  let scanned = 0
  for (const bucket of ["outbox", "archive"]) {
    const path = directory(project, [bucket], false)
    if (!existsSync(path)) continue
    const entries = opendirSync(path)
    try {
      for (let entry = entries.readSync(); entry; entry = entries.readSync()) {
        if (++scanned > EXPERIENCE_MAX_OBJECTS * 2) throw new Error("experience directory scan exceeds bound")
        if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
        ids.add(entry.name.slice(0, -5))
        if (ids.size > EXPERIENCE_MAX_OBJECTS) throw new Error("experience capacity exceeded; explicit retention review required")
      }
    } finally { entries.closeSync() }
  }
  return [...ids].sort().map((id) => loadExperience(project, id))
}

export function appendExperience(project: string, raw: unknown): Experience {
  // Reject caller-owned identity fields and malformed values before redaction or I/O.
  const input = ExperienceInputSchema.parse(raw)
  const root = directory(project, [], true)
  const lock = acquireFilesystemMutex(join(root, "writer.lock"), { owner: "experience:append", waitMs: 100 })
  try {
    const body = ExperienceSchema.omit({ id: true }).parse({
      ...input, schema_version: 1, project: experienceProject(project), privacy: "project-private",
      summary: redactEvidenceText(input.summary).excerpt.trim(),
    })
    const value = ExperienceSchema.parse({ ...body, id: experienceHash(body) })
    const present = [objectPath(project, value.id), objectPath(project, value.id, true)].some(existsSync)
    if (present) return loadExperience(project, value.id)
    for (const relation of value.relations) loadExperience(project, relation.id)
    if (listExperience(project).length >= EXPERIENCE_MAX_OBJECTS) throw new Error("experience capacity reached; no object was dropped")
    const serialized = `${canonicalJson(value)}\n`
    if (Buffer.byteLength(serialized) > EXPERIENCE_MAX_OBJECT_BYTES) throw new Error("experience exceeds exact-byte bound")
    directory(project, ["outbox"], true)
    lock.assertHeld()
    atomicWriteFile(objectPath(project, value.id), serialized, false, { commitBoundaryFence: () => lock.assertHeld() })
    return value
  } finally { lock.release() }
}

/** Non-destructive archival copy. Capacity remains bounded across both buckets. */
export function archiveExperience(project: string, id: string, confirm: boolean): Experience {
  if (confirm !== true) throw new Error("archive copy requires explicit confirmation")
  const value = loadExperience(project, id)
  return withExperienceOperation(project, "writer", (assertHeld) => {
    const current = loadExperience(project, id)
    if (experienceHash(current) !== experienceHash(value)) throw new Error("experience changed during archive")
    directory(project, ["archive"], true)
    const target = objectPath(project, id, true)
    if (!existsSync(target)) atomicWriteFile(target, `${canonicalJson(current)}\n`, false, { commitBoundaryFence: assertHeld })
    return loadExperience(project, id)
  })
}

/** Import only a bounded, hash-verified local export receipt and its Parquet artifact. */
export function importDatasetExperience(project: string, receiptPath: string, observedAt: string): Experience {
  z.iso.datetime({ offset: true }).parse(observedAt)
  const match = /^\.opencode\/data-science\/artifacts\/([a-f0-9]{64})\.json$/.exec(receiptPath)
  if (!match) throw new Error("dataset receipt must be a project-relative content-addressed artifact")
  const bytes = readSkillEvolutionDirectBounded(canonicalDirectory(project), join(project, receiptPath), 128 * 1024, "dataset receipt")
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  if (sha256 !== match[1]) throw new Error("dataset receipt hash mismatch")
  const Count = z.number().int().min(0).max(100_000)
  const receipt = z.object({
    schema_version: z.literal(1), operation: z.enum(["import", "export"]),
    source_sha256: Hash, request_sha256: Hash, engine_version: z.literal("1.4.0"), arrow_version: z.literal("21.0.0"),
    source_rows: Count, rows: Count, sample_rows: z.literal(0), ok: z.literal(true),
    columns: z.array(z.object({ name: z.string().min(1).max(256), type: z.string().min(1).max(128), nulls: Count, distinct_nonnull: Count,
      mean: z.number().finite().nullable().optional(), population_stddev: z.number().finite().nonnegative().nullable().optional(),
      min: z.number().finite().nullable().optional(), max: z.number().finite().nullable().optional() }).strict()).min(1).max(64),
    checks: z.array(z.object({ column: z.string().min(1).max(256), kind: z.enum(["not_null", "unique"]), passed: z.literal(true) }).strict()).max(64),
    warnings: z.array(z.string().max(2000)).max(16), artifact: z.object({ path: z.string(), sha256: Hash, bytes: z.number().int().min(1).max(64 * 1024 * 1024) }).strict(),
  }).strict().parse(JSON.parse(bytes.toString("utf8")))
  const artifact = /^\.opencode\/data-science\/artifacts\/([a-f0-9]{64})\.parquet$/.exec(receipt.artifact.path)
  if (!artifact || receipt.rows > receipt.source_rows || receipt.columns.some((column) => column.nulls + column.distinct_nonnull > receipt.rows)) throw new Error("invalid dataset artifact or counts")
  const data = readSkillEvolutionDirectBounded(canonicalDirectory(project), join(project, receipt.artifact.path), 64 * 1024 * 1024, "dataset artifact")
  if (data.length !== receipt.artifact.bytes || receipt.artifact.sha256 !== artifact[1] || createHash("sha256").update(data).digest("hex") !== artifact[1]) throw new Error("dataset artifact hash mismatch")
  return appendExperience(project, {
    kind: "dataset", source: { type: "datascience-receipt", id: sha256, sha256 }, observed_at: observedAt,
    retention: "operational", status: "success", summary: "Hash-verified local dataset export; no source values copied.",
    skill_version: null, group: receipt.source_sha256, relations: [],
    metrics: { rows: receipt.rows, columns: receipt.columns.length, checks: receipt.checks.length, model_cost: null },
  })
}

/** Explicit adapter: never copies goals, transcripts, outputs, or absolute paths. */
export function importRunExperience(project: string, runId: string, owner: string): Experience {
  const run = loadCommittedRunProjectionForOwner(project, runId, owner)
  if (!run) throw new Error("run was not found")
  if (run.status !== "done" && run.status !== "failed") throw new Error("only committed terminal runs can be imported")
  const source = { type: "alg-run", id: run.run_id, sha256: experienceHash(run) }
  return appendExperience(project, {
    kind: "outcome", source, observed_at: run.updated_at, retention: "operational",
    status: run.status === "done" ? "success" : "failure", summary: `ALG run ${run.status}`,
    skill_version: null, group: run.run_id, relations: [],
    metrics: { attempts: run.global_attempts, model_cost: null },
  })
}

export function withExperienceOperation<T>(project: string, operation: string, work: (assertHeld: () => void) => T): T {
  if (!isSafeId(operation)) throw new Error("invalid experience operation")
  const lock = acquireFilesystemMutex(join(directory(project, [], true), `${operation}.lock`), { owner: `experience:${operation}`, waitMs: 100 })
  try { lock.assertHeld(); return work(() => lock.assertHeld()) } finally { lock.release() }
}

export function experienceHealth(project: string) {
  const count = listExperience(project).length
  return { objects: count, maximum: EXPERIENCE_MAX_OBJECTS, remaining: EXPERIENCE_MAX_OBJECTS - count,
    capacity_warning: count >= EXPERIENCE_MAX_OBJECTS * 0.8, automatic_intake: false, retention: "explicit-review-required" }
}

/** Rebuildable deterministic JSON interchange for the optional DuckDB catalog. */
export function experienceCatalog(project: string) {
  const records = listExperience(project)
  const rows = records.map((record) => ({ ...record }))
  return { schema_version: 1, project: experienceProject(project), source_count: rows.length, logical_sha256: experienceHash(rows), records: rows }
}

const HISTORICAL_PLAN_ID = /^hist-[a-f0-9]{32}$/

type SealedHistoricalPlan = {
  plan_id: string
  confirmation: string
  state: string
  cancelled: boolean
  updated_at: string
  model_calls: number
  sessions: Array<{
    commitment: string
    message_count: number
    part_count: number
    fragment_count: number
    byte_count: number
    assistant_message_ids: string[]
  }>
}

/** Explicit sealed-plan adapter. Copies commitments and counts only, never transcript bytes. */
export function importHistoricalPlanExperience(project: string, planId: string): Experience[] {
  if (!HISTORICAL_PLAN_ID.test(planId)) throw new Error("historical plan id is invalid")
  const plan = (loadHistoricalIndex(project).plans as SealedHistoricalPlan[]).find((entry) => entry.plan_id === planId)
  if (!plan) throw new Error("historical plan was not found")
  if (plan.state !== "completed" || plan.cancelled) throw new Error("only completed historical plans can be imported")
  const observed = plan.updated_at
  const planRecord = appendExperience(project, {
    kind: "outcome",
    source: { type: "historical-plan", id: plan.plan_id, sha256: plan.confirmation },
    observed_at: observed, retention: "evaluation", status: "success",
    summary: "Completed historical plan imported without transcript bytes.",
    skill_version: null, group: plan.plan_id, relations: [],
    metrics: { sessions: plan.sessions.length, model_calls: plan.model_calls, model_cost: null },
  })
  return [planRecord, ...plan.sessions.map((session) => appendExperience(project, {
    kind: "source_artifact",
    source: { type: "historical-sealed", id: session.commitment, sha256: session.commitment },
    observed_at: observed, retention: "evaluation", status: "observed",
    summary: "Sealed historical snapshot; transcript bytes were not copied.",
    skill_version: null, group: plan.plan_id, relations: [{ kind: "derived_from", id: planRecord.id }],
    metrics: {
      messages: session.message_count, parts: session.part_count, fragments: session.fragment_count,
      bytes: session.byte_count, assistants: session.assistant_message_ids.length, model_cost: null,
    },
  }))]
}

/** Bounded explicit intake of owned terminal runs. Not a message-hook collector. */
export function intakeTerminalRunExperience(project: string, owner: string) {
  if (typeof owner !== "string" || owner.trim() !== owner || owner.length < 1 || owner.length > 256) {
    throw new Error("owner session id is invalid")
  }
  const listing = listOwnedRunEnvelopeResults(project, owner)
  const imported: string[] = []
  const skipped: string[] = []
  const errors: Array<{ run_id: string; error: string }> = []
  for (const envelope of listing.envelopes) {
    if (imported.length >= EXPERIENCE_INTAKE_MAX_RUNS) break
    if (envelope.status !== "done" && envelope.status !== "failed") {
      skipped.push(envelope.run_id)
      continue
    }
    try {
      const record = importRunExperience(project, envelope.run_id, owner)
      imported.push(record.id)
    } catch (error) {
      errors.push({ run_id: envelope.run_id, error: error instanceof Error ? error.message : "intake failed" })
    }
  }
  return {
    imported: imported.length, skipped: skipped.length, errors, scan_truncated: listing.scan_truncated,
    listing_errors: listing.errors.length, automatic_intake: false, remaining_capacity: experienceHealth(project).remaining,
  }
}

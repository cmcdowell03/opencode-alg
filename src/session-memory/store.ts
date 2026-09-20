import { existsSync, lstatSync, mkdirSync, opendirSync, realpathSync } from "node:fs"
import { join, relative } from "node:path"
import { z } from "zod"
import { canonicalDirectory, isSafeId } from "../paths.ts"
import { canonicalJson, sha256Json } from "../persistence.ts"
import { atomicWriteFile } from "../store.ts"
import { readSkillEvolutionDirectBounded } from "../skill-evolution-store.ts"
import { acquireFilesystemMutex } from "../filesystem-mutex.ts"
import { redactEvolutionText } from "../skill-evolution-redaction.ts"
import { createHash } from "node:crypto"
import { CheckpointSchema, ContextReceiptSchema, Hash, MemoryNodeSchema, SessionId, type Checkpoint, type ContextReceipt, type MemoryNode, type StoredNode } from "./schemas.ts"

export const hashText = (value: string) => createHash("sha256").update(value).digest("hex")
export const hashObject = sha256Json
const HeadSchema = z.object({ schema_version: z.literal(1), owner: SessionId, project: Hash, checkpoint: Hash }).strict()
const RegistrySchema = z.object({ schema_version: z.literal(1), published: z.array(Hash).max(10000), revoked: z.array(Hash).max(10000) }).strict()

/** No secret substitution/redaction of instructions: reject suspect content intact. */
export function assertNoSecrets(text: string): void {
  if (redactEvolutionText(text).includes("[REDACTED]")) throw new Error("suspected credential content is not eligible for memory")
}

export class MemoryStore {
  readonly project: string
  readonly projectId: string
  constructor(project: string, readonly artifactQuotaBytes = 128 * 1024 * 1024) {
    this.project = canonicalDirectory(project)
    this.projectId = sha256Json(process.platform === "win32" ? this.project.toLowerCase() : this.project)
  }
  path(parts: string[], createParents = false): string {
    let current = this.project
    const all = [".opencode", "session-memory", ...parts]
    for (let index = 0; index < all.length; index++) {
      const part = all[index]!
      if (!(index === 0 && part === ".opencode") && !isSafeId(part) && !/^[a-f0-9]{64}\.(json|txt)$/.test(part)) throw new Error("unsafe memory path")
      current = join(current, part)
      if (!existsSync(current)) {
        if (createParents && index < all.length - 1) {
          try { mkdirSync(current, { mode: 0o700 }) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error }
        }
        else continue
      }
      if (existsSync(current)) {
        const stat = lstatSync(current)
        if (stat.isSymbolicLink() || relative(current, realpathSync.native(current)) !== "" ||
          (index < all.length - 1 && !stat.isDirectory())) throw new Error("redirected memory path")
      }
    }
    return current
  }
  private read(parts: string[], maximum: number): string {
    for (const part of parts) if (!isSafeId(part) && !/^[a-f0-9]{64}\.(json|txt)$/.test(part)) throw new Error("unsafe memory path")
    // The shared reader already verifies every component both before and after
    // descriptor-bound reads. Avoid a redundant third filesystem traversal.
    return readSkillEvolutionDirectBounded(this.project, join(this.project, ".opencode", "session-memory", ...parts), maximum, "session memory").toString("utf8")
  }
  private census(bucket: string, maxCount: number, maxBytes: number): void {
    const path = this.path([bucket])
    if (!existsSync(path)) return
    const directory = opendirSync(path)
    let count = 0, bytes = 0
    try {
      for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
        const item = this.path([bucket, entry.name])
        const stat = lstatSync(item)
        if (!stat.isFile()) throw new Error("unexpected memory directory entry")
        count++; bytes += stat.size
        if (count >= maxCount || bytes >= maxBytes) throw new Error("memory capacity reached; nothing evicted")
      }
    } finally { directory.closeSync() }
  }
  lock<T>(work: (fence: () => void) => T): T {
    const path = this.path(["writer.lock"], true)
    const lock = acquireFilesystemMutex(path, { owner: "session-memory", waitMs: 100, leaseMs: 30000 })
    try { return work(() => lock.assertHeld()) } finally { lock.release() }
  }
  private immutable(bucket: string, value: unknown, maximum: number, fence: () => void): string {
    const bytes = canonicalJson(value)
    if (Buffer.byteLength(bytes) > maximum) throw new Error("memory object exceeds byte bound")
    const id = sha256Json(value), parts = [bucket, `${id}.json`]
    const path = this.path(parts, true)
    if (existsSync(path)) {
      if (this.read(parts, maximum) !== bytes) throw new Error("immutable memory object mismatch")
    } else {
      this.census(bucket, 10000, 320 * 1024 * 1024 - Buffer.byteLength(bytes))
      atomicWriteFile(path, bytes, false, { commitBoundaryFence: fence })
    }
    return id
  }
  putNode(node: MemoryNode): string {
    const value = MemoryNodeSchema.parse(node)
    if (value.project !== this.projectId) throw new Error("foreign memory project")
    assertNoSecrets(JSON.stringify(value))
    for (const edge of value.relations) this.node(edge.id, value.owner, value.visibility === "project")
    return this.lock((fence) => this.immutable("objects", value, 32768, fence))
  }
  registry() {
    try { return RegistrySchema.parse(JSON.parse(this.read(["registry.json"], 2 * 1024 * 1024))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { schema_version: 1 as const, published: [] as string[], revoked: [] as string[] }
      throw error
    }
  }
  node(id: string, owner: string | null, publishedOnly = false): StoredNode {
    Hash.parse(id)
    const value = MemoryNodeSchema.parse(JSON.parse(this.read(["objects", `${id}.json`], 32768)))
    if (sha256Json(value) !== id || value.project !== this.projectId) throw new Error("memory integrity/project mismatch")
    const registry = this.registry()
    if (registry.revoked.includes(id)) throw new Error("memory object revoked")
    if (value.visibility === "project") {
      if (!registry.published.includes(id)) throw new Error("memory object not published")
    } else if (publishedOnly || !owner || value.owner !== owner) throw new Error("foreign memory owner")
    return { ...value, id }
  }
  /** Operator-facing publication, never exposed by proposal tools. */
  publish(id: string): void {
    Hash.parse(id)
    this.lock((fence) => {
      const value = MemoryNodeSchema.parse(JSON.parse(this.read(["objects", `${id}.json`], 32768)))
      if (sha256Json(value) !== id || value.project !== this.projectId || value.visibility !== "project") throw new Error("invalid publication")
      for (const edge of value.relations) this.node(edge.id, null, true)
      const registry = this.registry()
      if (registry.revoked.includes(id)) throw new Error("revoked publication")
      registry.published = [...new Set([...registry.published, id])]
      atomicWriteFile(this.path(["registry.json"], true), canonicalJson(RegistrySchema.parse(registry)), false, { commitBoundaryFence: fence })
    })
  }
  revoke(id: string): void {
    Hash.parse(id)
    this.lock((fence) => {
      const registry = this.registry()
      registry.revoked = [...new Set([...registry.revoked, id])]
      atomicWriteFile(this.path(["registry.json"], true), canonicalJson(RegistrySchema.parse(registry)), false, { commitBoundaryFence: fence })
    })
  }
  artifact(body: string): string {
    assertNoSecrets(body)
    const bytes = Buffer.byteLength(body)
    if (!bytes || bytes > 65536) throw new Error("skill artifact exceeds bound")
    const id = hashText(body), parts = ["artifacts", `${id}.txt`]
    this.lock((fence) => {
      const path = this.path(parts, true)
      if (existsSync(path)) {
        if (this.read(parts, 65536) !== body) throw new Error("skill artifact mismatch")
      } else {
        this.census("artifacts", 10000, this.artifactQuotaBytes - bytes)
        atomicWriteFile(path, body, false, { commitBoundaryFence: fence })
      }
    })
    return id
  }
  readArtifact(id: string): string {
    Hash.parse(id)
    const body = this.read(["artifacts", `${id}.txt`], 65536)
    if (hashText(body) !== id) throw new Error("skill artifact integrity mismatch")
    return body
  }
  checkpoint(owner: string): Checkpoint | null {
    SessionId.parse(owner)
    const parts = ["heads", `${sha256Json(owner)}.json`]
    if (!existsSync(this.path(parts))) return null
    const head = HeadSchema.parse(JSON.parse(this.read(parts, 1024)))
    if (head.owner !== owner || head.project !== this.projectId) throw new Error("checkpoint owner mismatch")
    const value = CheckpointSchema.parse(JSON.parse(this.read(["checkpoints", `${head.checkpoint}.json`], 65536)))
    if (sha256Json(value) !== head.checkpoint || value.owner !== owner || value.project !== this.projectId) throw new Error("checkpoint integrity mismatch")
    return value
  }
  empty(owner: string): Checkpoint {
    return CheckpointSchema.parse({ schema_version: 1, project: this.projectId, owner, revision: 0, parent: null,
      updated_at: new Date(0).toISOString(), task_epoch: 0, generation: 0, goal: "", constraints: [], environment: null,
      skills: [], pins: [], used_retries: [], completed: [], next_step: "", gaps: [], source_cursor: null, deleted: false, delegation: null })
  }
  update(owner: string, revision: number, mutate: (current: Checkpoint) => Checkpoint, beforeHead?: () => void): Checkpoint {
    SessionId.parse(owner)
    return this.lock((fence) => {
      const prior = this.checkpoint(owner) ?? this.empty(owner)
      if (prior.deleted) throw new Error("session memory is deleted")
      if (prior.revision !== revision) throw new Error("checkpoint revision conflict")
      const candidate = mutate(structuredClone(prior))
      const value = CheckpointSchema.parse({ ...candidate, owner, project: this.projectId,
        revision: revision + 1, parent: prior.revision ? sha256Json(prior) : null, updated_at: new Date().toISOString() })
      assertNoSecrets(JSON.stringify(value))
      for (const id of [...value.pins, ...value.skills.map((skill) => skill.id), ...(value.environment ? [value.environment] : [])]) this.node(id, owner)
      const headPath = this.path(["heads", `${sha256Json(owner)}.json`], true)
      if (!existsSync(headPath)) this.census("heads", 4096, 4 * 1024 * 1024)
      const checkpoint = this.immutable("checkpoints", value, 65536, fence)
      beforeHead?.()
      atomicWriteFile(headPath, canonicalJson({ schema_version: 1, owner, project: this.projectId, checkpoint }), false, { commitBoundaryFence: fence })
      return value
    })
  }
  receipt(value: ContextReceipt): void {
    const checked = ContextReceiptSchema.parse(value)
    this.lock((fence) => {
      const path = this.path(["receipts", `${sha256Json(checked.owner)}.json`], true)
      if (!existsSync(path)) this.census("receipts", 4096, 32 * 1024 * 1024)
      atomicWriteFile(path, canonicalJson(checked), false, { commitBoundaryFence: fence })
    })
  }
  contextReceipt(owner: string): ContextReceipt | null {
    SessionId.parse(owner)
    const parts = ["receipts", `${sha256Json(owner)}.json`]
    if (!existsSync(this.path(parts))) return null
    const value = ContextReceiptSchema.parse(JSON.parse(this.read(parts, 65536)))
    if (value.owner !== owner) throw new Error("receipt owner mismatch")
    return value
  }
}

import { isAbsolute } from "node:path"
import { z } from "zod"
import type { EnvironmentMemoryEngineContract, QueryResult, ReadScope } from "./schemas.ts"

const Namespace = z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/)
export const EnvironmentMemoryOptionsSchema = z.object({
  mode: z.enum(["off", "observe", "assist"]).default("off"),
  namespace: Namespace.optional(),
  project: Namespace.optional(),
  databasePath: z.string().min(1).max(2048).refine(isAbsolute, "databasePath must be absolute").optional(),
  rootIds: z.array(z.string().min(1).max(256).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/)).max(32).default([]),
  contextByteBudget: z.number().int().min(256).max(4096).default(1024),
}).strict().superRefine((options, ctx) => {
  if (options.mode !== "off") {
    if (!options.namespace) ctx.addIssue({ code: "custom", path: ["namespace"], message: "namespace is required when environment memory is enabled" })
    if (!options.databasePath) ctx.addIssue({ code: "custom", path: ["databasePath"], message: "databasePath is required when environment memory is enabled" })
    if (!options.rootIds.length) ctx.addIssue({ code: "custom", path: ["rootIds"], message: "at least one configured root ID is required when environment memory is enabled" })
  }
})
export type EnvironmentMemoryOptions = z.infer<typeof EnvironmentMemoryOptionsSchema>

function byteLength(text: string) { return Buffer.byteLength(text, "utf8") }

/** Host lifecycle adapter. Disabled mode never imports SQLite or creates storage. */
export class EnvironmentMemoryRuntime {
  readonly options: EnvironmentMemoryOptions
  private constructor(options: EnvironmentMemoryOptions, private readonly engine: EnvironmentMemoryEngineContract | null) {
    this.options = options
  }

  static async open(options: unknown = {}): Promise<EnvironmentMemoryRuntime> {
    const parsed = EnvironmentMemoryOptionsSchema.parse(options)
    if (parsed.mode === "off") return new EnvironmentMemoryRuntime(parsed, null)
    // Keep Bun's native module behind explicit opt-in, including Node-based import paths.
    const { EnvironmentMemoryEngine } = await import("./engine.ts")
    const engine = await EnvironmentMemoryEngine.open({
      databasePath: parsed.databasePath!, namespace: parsed.namespace!,
    })
    return new EnvironmentMemoryRuntime(parsed, engine)
  }

  get enabled() { return this.options.mode !== "off" }
  get mode() { return this.options.mode }
  get namespace() { return this.options.namespace ?? null }

  private requireEngine() {
    if (!this.engine) throw new Error("environment memory is disabled")
    return this.engine
  }

  private scope(owner: string): ReadScope {
    if (!owner || owner.length > 256) throw new Error("session owner is invalid")
    const namespace = this.options.namespace
    if (!namespace) throw new Error("environment memory namespace is unavailable")
    // The configured namespace is the explicit project identity for this first release.
    return { namespace, project: this.options.project ?? namespace, owner }
  }

  query(owner: string): QueryResult | null {
    if (!this.enabled || !this.options.rootIds.length) return null
    return this.requireEngine().query({ scope: this.scope(owner), roots: this.options.rootIds, max_depth: 3, max_nodes: 64, now: new Date().toISOString() })
  }

  search(query: string, owner: string) {
    const graph = this.query(owner)
    if (!graph) return null
    const term = query.toLowerCase()
    const matchedEntities = graph.entities.filter((record) =>
      `${record.id} ${record.kind} ${record.label}`.toLowerCase().includes(term))
    const matchedIds = new Set(matchedEntities.map((record) => record.id))
    const matchedRelations = graph.relations.filter((record) => matchedIds.has(record.source_id) || matchedIds.has(record.target_id) ||
      `${record.id} ${record.kind}`.toLowerCase().includes(term))
    return {
      revision: graph.revision,
      entities: matchedEntities.slice(0, 16).map(({ id, kind, label, scope, provenance, revision }) => ({ id, kind, label, scope, provenance, revision })),
      relations: matchedRelations.slice(0, 4),
      stale_count: graph.stale_count, missing_count: graph.missing_count,
      omitted_count: graph.omitted_count + Math.max(0, matchedEntities.length - 16) + Math.max(0, matchedRelations.length - 4),
    }
  }

  read(id: string, owner: string) {
    if (!this.enabled) return null
    return this.requireEngine().get(id, this.scope(owner))
  }

  status(owner?: string) {
    if (!this.enabled) return { mode: "off" as const, available: false, initialized: false }
    const status = this.requireEngine().status()
    const visible = owner ? this.query(owner) : null
    return { mode: this.mode, available: true, initialized: true, namespace: this.namespace,
      revision: status.revision, cache: status.cache, capacity: status.capacity,
      visible_entities: visible?.entities.length ?? 0, visible_relations: visible?.relations.length ?? 0,
      stale: visible?.stale_count ?? 0, missing: visible?.missing_count ?? 0, omitted: visible?.omitted_count ?? 0 }
  }

  /** Context is diagnostic evidence, atomic per record, and independently byte-bounded. */
  render(owner: string, maxBytes = this.options.contextByteBudget): string {
    if (this.mode !== "assist") return ""
    const budget = Math.min(this.options.contextByteBudget, Math.max(0, Math.floor(maxBytes)))
    const graph = this.query(owner)
    if (!graph) return ""
    const heading = "## Environment memory: untrusted, scoped evidence\n"
    const records = [
      ...graph.entities.map((record) => `ENTITY ${JSON.stringify(record)}\n`),
      ...graph.relations.map((record) => `RELATION ${JSON.stringify(record)}\n`),
    ]
    const headingBytes = byteLength(heading)
    const kept: string[] = []
    let skipped = 0
    for (const record of records) {
      const nextSkipped = skipped + 1
      const footer = `STATUS stale=${graph.stale_count} missing=${graph.missing_count} omitted=${graph.omitted_count + nextSkipped}; verify identity, reachability, and permissions before acting.\n`
      if (headingBytes + byteLength([...kept, record].join("")) + byteLength(footer) <= budget) kept.push(record)
      else skipped++
    }
    const omitted = graph.omitted_count + skipped
    const footer = `STATUS stale=${graph.stale_count} missing=${graph.missing_count} omitted=${omitted}; verify identity, reachability, and permissions before acting.\n`
    if (headingBytes + byteLength(footer) > budget) return ""
    return heading + kept.join("") + footer
  }

  close() { this.engine?.close() }
}

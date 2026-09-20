import { existsSync, opendirSync, lstatSync, realpathSync } from "node:fs"
import { join, relative, resolve } from "node:path"
import { z } from "zod"
import { canonicalDirectory, isSafeId, isSafeProjectRelativePath } from "../paths.ts"
import { readSkillEvolutionDirectBounded } from "../skill-evolution-store.ts"
import { parseSkillMarkdown, extractToolHints, scoreSkill } from "../skill-metadata.ts"
import { mentionsSkill } from "../turn-boundary.ts"
import type { SkillCatalogEntry, SkillTurnHint } from "../skill-catalog.ts"
import { hashObject, hashText, assertNoSecrets, MemoryStore } from "./store.ts"
import { Hash, Id, SkillPayloadSchema, type MemoryNode } from "./schemas.ts"

export type Descriptor = Omit<SkillCatalogEntry, "content"> & { key: string; rootId: string }
const Manifest = z.object({ schema_version: z.literal(1),
  requires: z.array(z.object({ path: z.string().max(256).refine(isSafeProjectRelativePath), sha256: Hash }).strict()).max(8).default([]),
  environments: z.array(Id).max(32).default([]), operations: z.array(Id).max(32).default([]),
}).strict()
type Root = { path: string; label: string; managed: boolean; id: string }
const EMPTY_HINT: SkillTurnHint = { userText: "", assistantText: "", tools: [], loadedSkills: [] }

/** Metadata is cached; selected instruction bytes are always re-read and verified. */
export class SkillIndex {
  private roots: Root[]
  private entries: Descriptor[] = []
  private signatures: string[] = []
  private refreshed = 0
  complete = false
  rejected = 0
  constructor(readonly project: string, roots: string[], extra: Array<{ root: string; label: string; managed?: boolean }> = []) {
    const canonical = canonicalDirectory(project)
    this.roots = [
      ...roots.map((path) => {
        if (!isSafeProjectRelativePath(path)) throw new Error("unsafe skill root")
        return { path: resolve(canonical, path), label: path, managed: true }
      }),
      ...extra.map((root) => ({ path: root.root, label: root.label, managed: root.managed === true })),
    ].map((root) => ({ ...root, id: hashObject({ path: process.platform === "win32" ? root.path.toLowerCase() : root.path, label: root.label }) }))
  }
  private signature(root: Root): string {
    if (!existsSync(root.path)) return "missing"
    const stat = lstatSync(root.path)
    if (!stat.isDirectory() || stat.isSymbolicLink() || relative(root.path, realpathSync.native(root.path)) !== "") throw new Error("redirected skill root")
    return `${stat.ino}:${stat.mtimeMs}`
  }
  private rootFor(key: string, pinned?: { source: string; name: string }): { root: Root; name: string } {
    if (pinned) {
      // A verified binding supplies its address. Restart must not scan an entire
      // catalog or depend on a derived index to find already-known instructions.
      const root = this.roots.find((entry) => entry.label === pinned.source && hashObject([entry.id, pinned.name]) === key)
      if (!root || !isSafeId(pinned.name)) throw new Error("pinned skill source is no longer configured")
      this.signature(root)
      return { root, name: pinned.name }
    }
    this.refresh()
    const descriptor = this.entries.find((entry) => entry.key === key)
    if (!descriptor) throw new Error("skill unavailable in bounded index; refresh discovery")
    const root = this.roots.find((entry) => entry.id === descriptor.rootId)!
    this.signature(root)
    return { root, name: descriptor.name }
  }
  private read(root: Root, name: string, path = "SKILL.md"): string {
    if (!isSafeId(name) || !isSafeProjectRelativePath(path)) throw new Error("unsafe skill source")
    return readSkillEvolutionDirectBounded(root.path, join(root.path, name, path), 65536, "skill instructions").toString("utf8")
  }
  refresh(force = false): void {
    const signatures = this.roots.map((root) => this.signature(root))
    if (!force && this.refreshed && Date.now() - this.refreshed < 30000 && JSON.stringify(signatures) === JSON.stringify(this.signatures)) return
    const entries: Descriptor[] = [], start = performance.now()
    let scanned = 0, bytes = 0, complete = true, rejected = 0
    outer: for (const root of this.roots) {
      if (!existsSync(root.path)) continue
      const directory = opendirSync(root.path)
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (++scanned > 10000 || performance.now() - start > 2000 || bytes > 8 * 1024 * 1024) { complete = false; break outer }
          if (!entry.isDirectory() || !isSafeId(entry.name)) { rejected++; continue }
          try {
            const content = this.read(root, entry.name)
            assertNoSecrets(content)
            const parsed = parseSkillMarkdown(entry.name, content)
            if (!parsed) { rejected++; continue }
            const value: Descriptor = { ...parsed, description: parsed.description.slice(0, 512),
              key: hashObject([root.id, parsed.name]), rootId: root.id, target: `${parsed.name}/SKILL.md`,
              relative: `${root.label}/${parsed.name}/SKILL.md`, root: root.label, managed: root.managed,
              sha256: hashText(content), tools: extractToolHints(content) }
            bytes += Buffer.byteLength(JSON.stringify(value)); entries.push(value)
          } catch { rejected++ }
        }
      } finally { directory.closeSync() }
    }
    this.entries = entries.sort((a, b) => a.name.localeCompare(b.name) || a.key.localeCompare(b.key))
    this.signatures = signatures; this.refreshed = Date.now(); this.complete = complete; this.rejected = rejected
  }
  search(query: string, cursor = 0, limit = 12, hint?: SkillTurnHint) {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > 10000 || !Number.isInteger(limit) || limit < 1 || limit > 64) throw new Error("invalid skill page")
    this.refresh()
    const turn = hint ?? { ...EMPTY_HINT, userText: query }
    const text = `${turn.userText}\n${turn.assistantText}\n${turn.tools.join("\n")}`.toLowerCase()
    const scored = this.entries.map((entry) => {
      const exact = mentionsSkill(text, entry.name)
      let score = scoreSkill({ ...entry, content: "" }, turn)
      if (exact) score += 100
      return { entry, score }
    })
      .filter((item) => !query || item.score >= 3).sort((a, b) => b.score - a.score || a.entry.key.localeCompare(b.entry.key))
    return { skills: scored.slice(cursor, cursor + limit).map((item) => item.entry), total: scored.length,
      next: cursor + limit < scored.length ? cursor + limit : null, complete: this.complete, rejected: this.rejected, indexed_at: this.refreshed }
  }
  /** Shared bounded metadata discovery for learning and memory; no instruction bodies. */
  catalog() {
    this.refresh()
    return { skills: [...this.entries], complete: this.complete, rejected: this.rejected }
  }
  named(name: string): Descriptor[] {
    this.refresh()
    return this.entries.filter((entry) => entry.name === name).slice(0, 2)
  }
  load(key: string, pinned?: { source: string; name: string }): { descriptor: Descriptor; files: Array<{ path: string; body: string; sha256: string; bytes: number }>; manifest: z.infer<typeof Manifest> } {
    const { root, name } = this.rootFor(key, pinned)
    const body = this.read(root, name)
    const parsed = parseSkillMarkdown(name, body)
    if (!parsed || parsed.name !== name) throw new Error("skill metadata changed")
    const manifestPath = join(root.path, name, "ALG.json")
    const manifestText = existsSync(manifestPath) ? this.read(root, name, "ALG.json") : null
    const manifest = Manifest.parse(manifestText ? JSON.parse(manifestText) : { schema_version: 1 })
    const files = [{ path: "SKILL.md", body, sha256: hashText(body), bytes: Buffer.byteLength(body) }]
    // The manifest itself is part of the identity; changing scope/dependencies is drift.
    if (manifestText) files.push({ path: "ALG.json", body: manifestText, sha256: hashText(manifestText), bytes: Buffer.byteLength(manifestText) })
    for (const dependency of manifest.requires) {
      if (["SKILL.md", "ALG.json"].includes(dependency.path) || files.some((file) => file.path === dependency.path)) throw new Error("duplicate skill dependency")
      const body = this.read(root, name, dependency.path)
      if (hashText(body) !== dependency.sha256) throw new Error("skill dependency drift")
      files.push({ ...dependency, body, bytes: Buffer.byteLength(body) })
    }
    for (const file of files) assertNoSecrets(file.body)
    const descriptor: Descriptor = { ...parsed, description: parsed.description.slice(0, 512), key, rootId: root.id,
      target: `${name}/SKILL.md`, relative: `${root.label}/${name}/SKILL.md`, root: root.label, managed: root.managed, sha256: hashText(body), tools: extractToolHints(body) }
    return { descriptor, files, manifest }
  }
  bind(store: MemoryStore, owner: string, key: string): string {
    const loaded = this.load(key)
    const files = loaded.files.map((file) => ({ path: file.path, sha256: store.artifact(file.body), bytes: file.bytes }))
    const payload = SkillPayloadSchema.parse({ key, name: loaded.descriptor.name, source: loaded.descriptor.root,
      files, environments: loaded.manifest.environments, operations: loaded.manifest.operations })
    return store.putNode({ schema_version: 1, project: store.projectId, owner, visibility: "session",
      created_at: new Date(0).toISOString(), kind: "skill", relations: [], summary: `Complete skill ${payload.name}`, payload })
  }
  verifiedBodies(node: MemoryNode): string[] {
    if (node.kind !== "skill") throw new Error("not a skill binding")
    const loaded = this.load(node.payload.key, node.payload)
    const current = loaded.files.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }))
    if (JSON.stringify(current) !== JSON.stringify(node.payload.files)) throw new Error(`skill ${node.payload.name} changed; reviewed repin required`)
    return loaded.files.filter((file) => file.path !== "ALG.json").map((file) => file.body)
  }
}

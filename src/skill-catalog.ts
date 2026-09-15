import { createHash } from "node:crypto"
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { isContained, isSafeId, isSafeProjectRelativePath } from "./paths.ts"
import { truncateUtf8, utf8Bytes } from "./limits.ts"
import type { SkillEvolutionOptions, SkillTriggerLabel } from "./skill-evolution-schemas.ts"

export const SKILL_CATALOG_MAX_SKILLS = 32
export const SKILL_CATALOG_MAX_FILE_BYTES = 64 * 1024
export const SKILL_SYSTEM_CONTEXT_MAX_BYTES = 12 * 1024
export const SKILL_COMPACTION_CONTEXT_MAX_BYTES = 4 * 1024
export const SKILL_INJECT_MAX_SKILLS = 3
export const SKILL_INJECT_BODY_MAX_BYTES = 6 * 1024

export interface SkillCatalogEntry {
  name: string
  target: string
  root: string
  relative: string
  sha256: string
  description: string
  managed: boolean
  tools: string[]
  content: string
}

export interface SkillCatalog {
  skills: SkillCatalogEntry[]
  omitted: number
}

export interface SkillTurnHint {
  userText: string
  assistantText: string
  tools: string[]
  loadedSkills: string[]
}

export interface SkillCatalogEvidenceEntry {
  name: string
  target: string
  root: string
  sha256: string
  managed: boolean
  applicable: boolean
  loaded: boolean
  description: string
}

export interface SkillCatalogEvidence {
  skills: SkillCatalogEvidenceEntry[]
  omitted: number
}

const emptyCatalog = (): SkillCatalog => ({ skills: [], omitted: 0 })

function samePath(left: string, right: string): boolean {
  const a = resolve(left)
  const b = resolve(right)
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b
}

function directDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink() && samePath(realpathSync.native(path), path)
  } catch {
    return false
  }
}

function readRegularFileBounded(path: string, maximumBytes: number): Buffer | null {
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) return null
    if (!samePath(realpathSync.native(path), path)) return null
    const bytes = readFileSync(path)
    if (bytes.byteLength !== stat.size) return null
    return bytes
  } catch {
    return null
  }
}

function scalarFrontmatter(block: string, key: string): string | null {
  for (const line of block.split(/\r?\n/)) {
    const match = new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line)
    if (!match) continue
    let value = match[1]!.trim()
    if (!value) return null
    if ((value.startsWith("\"") || value.startsWith("'")) && value.length >= 2 && value.at(-1) === value[0]) {
      value = value.slice(1, -1)
    }
    return value.trim() || null
  }
  return null
}

function parseSkillMarkdown(folder: string, content: string): { name: string; description: string } | null {
  if (!isSafeId(folder) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(folder)) return null
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content)
  const name = (match ? scalarFrontmatter(match[1]!, "name") : null) ?? folder
  if (name !== folder) return null
  const description = (match ? scalarFrontmatter(match[1]!, "description") : null) ??
    (content.match(/^#\s+(.+)$/m)?.[1]?.trim() || `Use the ${folder} project skill when it applies.`)
  if (!description || description.length > 1_024) return null
  return { name, description }
}

function extractToolHints(content: string): string[] {
  const tools = new Set<string>()
  for (const match of content.matchAll(/`([a-z][a-z0-9_]{2,64})`/g)) tools.add(match[1]!)
  for (const match of content.matchAll(/\b(alg_[a-z0-9_]{2,64})\b/g)) tools.add(match[1]!)
  return [...tools].slice(0, 16)
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex")
}

function collectRoot(
  root: string,
  rootLabel: string,
  managed: boolean,
  seenNames: Set<string>,
  seenPaths: Set<string>,
): { skills: SkillCatalogEntry[]; omitted: number } {
  const skills: SkillCatalogEntry[] = []
  let omitted = 0
  if (!directDirectory(root)) return { skills, omitted }
  let entries: Array<{ name: string }>
  try {
    entries = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return { skills, omitted }
  }
  for (const entry of entries) {
    if (skills.length + omitted >= SKILL_CATALOG_MAX_SKILLS) {
      omitted++
      continue
    }
    const folder = join(root, entry.name)
    if (!directDirectory(folder)) {
      omitted++
      continue
    }
    const file = join(folder, "SKILL.md")
    const bytes = readRegularFileBounded(file, SKILL_CATALOG_MAX_FILE_BYTES)
    if (!bytes) {
      omitted++
      continue
    }
    const identity = process.platform === "win32" ? resolve(file).toLowerCase() : resolve(file)
    if (seenPaths.has(identity)) continue
    const parsed = parseSkillMarkdown(entry.name, bytes.toString("utf8"))
    if (!parsed) {
      omitted++
      continue
    }
    if (seenNames.has(parsed.name)) {
      omitted++
      continue
    }
    seenNames.add(parsed.name)
    seenPaths.add(identity)
    const relativePath = isSafeProjectRelativePath(rootLabel)
      ? `${rootLabel}/${parsed.name}/SKILL.md`
      : `${parsed.name}/SKILL.md`
    skills.push({
      name: parsed.name,
      target: `${parsed.name}/SKILL.md`,
      root: rootLabel,
      relative: relativePath,
      sha256: hashBytes(bytes),
      description: parsed.description,
      managed,
      tools: extractToolHints(bytes.toString("utf8")),
      content: bytes.toString("utf8"),
    })
  }
  return { skills, omitted }
}

export function observedConfigSkillRoots(): Array<{ root: string; label: string }> {
  const roots: Array<{ root: string; label: string }> = []
  const seen = new Set<string>()
  const add = (candidate: string, label: string) => {
    try {
      if (!isAbsolute(candidate) || !directDirectory(candidate)) return
      const key = process.platform === "win32" ? resolve(candidate).toLowerCase() : resolve(candidate)
      if (seen.has(key)) return
      seen.add(key)
      roots.push({ root: candidate, label })
    } catch {
      // Observed config roots are optional and must not fail catalog load.
    }
  }
  const xdg = process.env.XDG_CONFIG_HOME
  if (xdg) add(join(xdg, "opencode", "skills"), "opencode-config")
  try {
    add(join(homedir(), ".config", "opencode", "skills"), "opencode-config")
  } catch {
    // homedir can throw in locked-down hosts
  }
  return roots
}

export function loadSkillCatalog(
  projectDirectory: string,
  options: SkillEvolutionOptions,
  extraRoots: ReadonlyArray<{ root: string; label: string; managed?: boolean }> = [],
): SkillCatalog {
  try {
    if (!isAbsolute(projectDirectory) || !existsSync(projectDirectory)) return emptyCatalog()
    const project = realpathSync.native(projectDirectory)
    const seenNames = new Set<string>()
    const seenPaths = new Set<string>()
    const skills: SkillCatalogEntry[] = []
    let omitted = 0
    for (const rootRelative of options.skillRoots) {
      if (!isSafeProjectRelativePath(rootRelative)) continue
      const root = resolve(project, ...rootRelative.split("/"))
      if (!isContained(project, root) || root === project) continue
      const collected = collectRoot(root, rootRelative, true, seenNames, seenPaths)
      skills.push(...collected.skills)
      omitted += collected.omitted
    }
    for (const extra of extraRoots) {
      const collected = collectRoot(extra.root, extra.label, extra.managed === true, seenNames, seenPaths)
      skills.push(...collected.skills)
      omitted += collected.omitted
    }
    return {
      skills: skills.slice(0, SKILL_CATALOG_MAX_SKILLS),
      omitted: omitted + Math.max(0, skills.length - SKILL_CATALOG_MAX_SKILLS),
    }
  } catch {
    return emptyCatalog()
  }
}

const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "when", "only", "use", "using"])

function tokens(value: string): Set<string> {
  return new Set(
    value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !STOP.has(token)),
  )
}

export function scoreSkill(entry: SkillCatalogEntry, hint: SkillTurnHint): number {
  const haystack = `${hint.userText}\n${hint.assistantText}\n${hint.tools.join("\n")}`.toLowerCase()
  let score = 0
  if (haystack.includes(entry.name)) score += 5
  if (hint.loadedSkills.includes(entry.name)) score += 4
  for (const tool of entry.tools) {
    if (hint.tools.includes(tool) || haystack.includes(tool.toLowerCase())) score += 4
  }
  const overlap = [...tokens(entry.description)].filter((token) => tokens(haystack).has(token)).length
  score += Math.min(6, overlap)
  return score
}

export function matchSkills(catalog: SkillCatalog, hint: SkillTurnHint): Array<SkillCatalogEntry & { score: number; applicable: boolean; loaded: boolean }> {
  return catalog.skills
    .map((entry) => {
      const score = scoreSkill(entry, hint)
      return {
        ...entry,
        score,
        applicable: score >= 3,
        loaded: hint.loadedSkills.includes(entry.name),
      }
    })
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name))
}

export function catalogTriggerLabels(catalog: SkillCatalog, hint: SkillTurnHint): SkillTriggerLabel[] {
  const labels: SkillTriggerLabel[] = []
  for (const match of matchSkills(catalog, hint)) {
    if (match.managed && match.applicable && !match.loaded && match.tools.some((tool) => hint.tools.includes(tool))) {
      labels.push("applicable_skill_unused")
      break
    }
  }
  return labels
}

export function catalogEvidenceField(catalog: SkillCatalog, hint: SkillTurnHint): SkillCatalogEvidence | undefined {
  if (!catalog.skills.length && catalog.omitted === 0) return undefined
  const matched = matchSkills(catalog, hint)
  return {
    skills: matched.slice(0, 16).map((entry) => ({
      name: entry.name,
      target: entry.target,
      root: entry.root,
      sha256: entry.sha256,
      managed: entry.managed,
      applicable: entry.applicable,
      loaded: entry.loaded,
      description: entry.description.length <= 240 ? entry.description : `${entry.description.slice(0, 239)}…`,
    })),
    omitted: catalog.omitted + Math.max(0, matched.length - 16),
  }
}

export function isInformativeSkillTurn(
  triggerScore: number,
  triggerLabels: readonly SkillTriggerLabel[],
  minimumTriggerScore: number,
): boolean {
  if (triggerScore >= minimumTriggerScore) return true
  return triggerLabels.some((label) =>
    label === "applicable_skill_unused" ||
    label === "loaded_skill_inadequacy" ||
    label === "explicit_user_correction",
  )
}

function cap(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`
}

export function formatSkillSystemContext(catalog: SkillCatalog, hint?: SkillTurnHint): string {
  if (!catalog.skills.length) return ""
  const matched = hint ? matchSkills(catalog, hint).filter((entry) => entry.applicable) : catalog.skills
  const inject = (matched.length ? matched : catalog.skills).slice(0, SKILL_INJECT_MAX_SKILLS)
  const lines = [
    "## ALG skills",
    "",
    "Follow matching SKILL.md files. If a skill body is included below, obey it for this turn.",
    "Otherwise call the `skill` tool with that skill name before using its related tools.",
    "Do not invent a parallel skill when a catalog entry already covers the work.",
    "",
    "Catalog:",
  ]
  for (const entry of catalog.skills) {
    const tools = entry.tools.length ? `; tools: ${entry.tools.slice(0, 6).join(", ")}` : ""
    const scope = entry.managed ? "managed" : "observed"
    lines.push(`- ${entry.name} [${scope}] ${cap(entry.description, 180)}${tools}`)
  }
  if (catalog.omitted) lines.push(`- (${catalog.omitted} additional skill files omitted)`)
  for (const entry of inject) {
    lines.push("", `### Active skill: ${entry.name}`, "", truncateUtf8(entry.content, SKILL_INJECT_BODY_MAX_BYTES))
  }
  const text = lines.join("\n")
  if (utf8Bytes(text) <= SKILL_SYSTEM_CONTEXT_MAX_BYTES) return text
  return truncateUtf8(text, SKILL_SYSTEM_CONTEXT_MAX_BYTES)
}

export function formatSkillCompactionContext(catalog: SkillCatalog): string {
  if (!catalog.skills.length) return ""
  const lines = [
    "## ALG skills to retain after compaction",
    "",
    "Reload matching skills after compaction. Prefer `skill` plus the named file over ad-hoc tool sequences.",
    "Evolution may revise a managed skill; it must not create a duplicate of a catalog name.",
  ]
  for (const entry of catalog.skills.slice(0, 16)) {
    const tools = entry.tools.length ? ` tools=${entry.tools.slice(0, 4).join(",")}` : ""
    lines.push(`- ${entry.name} [${entry.managed ? "managed" : "observed"}] ${cap(entry.description, 140)}${tools}`)
  }
  const text = lines.join("\n")
  if (utf8Bytes(text) <= SKILL_COMPACTION_CONTEXT_MAX_BYTES) return text
  return truncateUtf8(text, SKILL_COMPACTION_CONTEXT_MAX_BYTES)
}

export function hintFromMessages(messages: Array<{ info?: any; parts?: any[] }>): SkillTurnHint {
  const hint: SkillTurnHint = { userText: "", assistantText: "", tools: [], loadedSkills: [] }
  for (const message of messages) {
    const role = message?.info?.role
    const parts = Array.isArray(message?.parts) ? message.parts : []
    const text = parts
      .filter((part) => part?.type === "text" && part.ignored !== true && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    if (role === "user" && text) hint.userText = text
    if (role === "assistant" && text) hint.assistantText = text
    for (const part of parts) {
      if (part?.type !== "tool") continue
      const name = typeof part.tool === "string" ? part.tool : ""
      if (name) hint.tools.push(name)
      const input = part.state && typeof part.state === "object" ? (part.state as any).input : part.input
      if (name === "skill" && input && typeof input.name === "string" && input.name.trim()) {
        hint.loadedSkills.push(input.name.trim())
      }
    }
  }
  hint.tools = [...new Set(hint.tools)].slice(0, 32)
  hint.loadedSkills = [...new Set(hint.loadedSkills)].slice(0, 16)
  hint.userText = hint.userText.slice(0, 4_000)
  hint.assistantText = hint.assistantText.slice(0, 4_000)
  return hint
}

export function sessionIdFromMessages(messages: Array<{ info?: any }>): string | undefined {
  for (const message of [...messages].reverse()) {
    const id = message?.info?.sessionID ?? message?.info?.sessionId
    if (typeof id === "string" && id) return id
  }
  return undefined
}

export class SkillGuidance {
  private readonly hints = new Map<string, SkillTurnHint>()

  constructor(
    private readonly project: string,
    private readonly options: SkillEvolutionOptions,
    private readonly extraRoots: ReadonlyArray<{ root: string; label: string; managed?: boolean }> = [],
  ) {}

  catalog(): SkillCatalog {
    return loadSkillCatalog(this.project, this.options, this.extraRoots)
  }

  observeChatMessages(messages: Array<{ info?: any; parts?: any[] }>): void {
    const sessionId = sessionIdFromMessages(messages)
    if (!sessionId) return
    this.hints.set(sessionId, hintFromMessages(messages))
  }

  systemContext(sessionId?: string): string {
    try {
      return formatSkillSystemContext(this.catalog(), sessionId ? this.hints.get(sessionId) : undefined)
    } catch {
      return ""
    }
  }

  compactionContext(): string {
    try {
      return formatSkillCompactionContext(this.catalog())
    } catch {
      return ""
    }
  }

  status() {
    const catalog = this.catalog()
    return {
      managed: catalog.skills.filter((skill) => skill.managed).map((skill) => skill.name),
      observed: catalog.skills.filter((skill) => !skill.managed).map((skill) => skill.name),
      omitted: catalog.omitted,
    }
  }
}

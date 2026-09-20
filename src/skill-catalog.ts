import { existsSync, lstatSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { utf8Bytes } from "./limits.ts"
import { isDeletedSkillSession, loadSessionRecovery, sessionRecoveryRelativePath, updateSessionRecovery, type SessionSkillRef } from "./skill-evolution-store.ts"
import type { SkillEvolutionOptions, SkillTriggerLabel } from "./skill-evolution-schemas.ts"
import { SkillIndex } from "./session-memory/skill-index.ts"
import { mentionsSkill } from "./turn-boundary.ts"
import { scoreSkill } from "./skill-metadata.ts"
export { parseSkillMarkdown, extractToolHints, scoreSkill } from "./skill-metadata.ts"

/** Legacy display budget, not a discovery cutoff. */
export const SKILL_CATALOG_MAX_SKILLS = 32
export const SKILL_CATALOG_MAX_FILE_BYTES = 64 * 1024
export const SKILL_SYSTEM_CONTEXT_MAX_BYTES = 12 * 1024
export const SKILL_COMPACTION_CONTEXT_MAX_BYTES = 4 * 1024
export const SKILL_INJECT_MAX_SKILLS = 3
export const SKILL_INJECT_BODY_MAX_BYTES = 6 * 1024
export const APPLICABLE_SKILL_UNUSED_POINTS = 3

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
  /** Metadata-only discovery; read and verify only selected bodies. */
  readContent?: () => string
}

export interface SkillCatalog {
  skills: SkillCatalogEntry[]
  omitted: number
  complete?: boolean
}

export interface SkillTurnHint {
  userMessageId?: string
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
  complete?: boolean
}

const emptyCatalog = (): SkillCatalog => ({ skills: [], omitted: 0, complete: false })

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
    const index = new SkillIndex(project, options.skillRoots, [...extraRoots])
    const skills: SkillCatalogEntry[] = []
    for (const descriptor of index.catalog().skills) {
      skills.push({ ...descriptor, content: "", readContent: () => {
        const loaded = index.load(descriptor.key, { source: descriptor.root, name: descriptor.name })
        if (loaded.descriptor.sha256 !== descriptor.sha256) throw new Error("skill changed during catalog selection")
        return loaded.files.find((file) => file.path === "SKILL.md")!.body
      } })
    }
    return { skills, omitted: index.rejected, complete: index.complete }
  } catch {
    return emptyCatalog()
  }
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
    .sort((left, right) => Number(right.loaded) - Number(left.loaded) ||
      Number(mentionsSkill(hint.userText, right.name)) - Number(mentionsSkill(hint.userText, left.name)) ||
      right.score - left.score || left.name.localeCompare(right.name) || left.root.localeCompare(right.root))
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
    ...(catalog.complete === undefined ? {} : { complete: catalog.complete }),
  }
}

export function isInformativeSkillTurn(
  triggerScore: number,
  triggerLabels: readonly SkillTriggerLabel[],
  minimumTriggerScore: number,
  mode: SkillEvolutionOptions["mode"] = "every-turn",
): boolean {
  const unused = triggerLabels.includes("applicable_skill_unused")
  const auditorScore = mode === "triggered" && unused
    ? Math.max(0, triggerScore - APPLICABLE_SKILL_UNUSED_POINTS)
    : triggerScore
  if (auditorScore >= minimumTriggerScore) return true
  return triggerLabels.some((label) =>
    (mode !== "triggered" && label === "applicable_skill_unused") ||
    label === "loaded_skill_inadequacy" ||
    label === "explicit_user_correction",
  )
}

function cap(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`
}

export function formatSkillSystemContext(catalog: SkillCatalog, hint?: SkillTurnHint, included?: SessionSkillRef[]): string {
  if (!catalog.skills.length) return ""
  const matched = hint ? matchSkills(catalog, hint).filter((entry) => entry.applicable) : []
  const inject = matched.filter((entry) => catalog.skills.filter((other) => other.name === entry.name).length === 1).slice(0, SKILL_INJECT_MAX_SKILLS)
  const lines = [
    "## ALG skills",
    "",
    "Only explicitly marked complete bodies are loaded instructions for this turn.",
    "Catalog entries are discovery metadata, not active instructions. Load a matching omitted body in full with the skill tool before using it.",
    "Do not invent a parallel skill when a catalog entry already covers the work.",
    "",
    "Catalog:",
  ]
  // Reserve space for omission notices and whole bodies. Never clip instructions.
  let listed = 0
  for (const entry of catalog.skills) {
    const tools = entry.tools.length ? `; tools: ${entry.tools.slice(0, 6).join(", ")}` : ""
    const scope = entry.managed ? "managed" : "observed"
    const line = `- ${entry.name} [${scope}] ${cap(entry.description, 180)}${tools}`
    if (utf8Bytes([...lines, line].join("\n")) > 3500) break
    lines.push(line)
    listed++
  }
  const omitted = catalog.omitted + catalog.skills.length - listed
  if (omitted) lines.push(`- catalog omitted: ${omitted}; discover/load matching skills explicitly`)
  if (catalog.complete === false) lines.push("- discovery incomplete: omitted count is a lower bound; do not assume all skills are listed")
  if (matched.length > inject.length) lines.push(`- matching bodies omitted by count limit: ${matched.length - inject.length}`)
  for (const entry of inject) {
    const content = entry.readContent ? entry.readContent() : entry.content
    const source = entry.root + "/" + entry.target
    const metadata = `name=${entry.name} source=${source.length <= 400 ? JSON.stringify(source) : "(path omitted: load by skill name)"} sha256=${entry.sha256} bytes=${utf8Bytes(content)}`
    const body = `\n### Active skill: ${entry.name} (complete body)\n${metadata}\n\n${content}`
    if (utf8Bytes(content) <= SKILL_INJECT_BODY_MAX_BYTES &&
      utf8Bytes([...lines, body].join("\n")) <= SKILL_SYSTEM_CONTEXT_MAX_BYTES - 1800) {
      lines.push(body)
      included?.push({ name: entry.name, root: entry.root, target: entry.target, sha256: entry.sha256 })
    } else {
      lines.push(`- requires_full_load: ${metadata}; body omitted, not loaded`)
    }
  }
  return lines.join("\n")
}

export function formatSkillCompactionContext(catalog: SkillCatalog, active: SessionSkillRef[] = [], pointer?: string, priorOmitted = 0): string {
  if (!active.length && !pointer) return ""
  const lines = [
    "## ALG skills to retain after compaction",
    "",
    "Session-active skill references only; these are not loaded bodies or permission grants.",
    "Reload in full before use. A changed hash requires explicit revision review; never silently substitute it.",
    "Evolution may revise a managed skill; it must not create a duplicate of a catalog name.",
    ...(pointer ? [`- checkpoint: ${pointer}`] : []),
  ]
  let visible = 0
  for (const entry of active) {
    const current = catalog.skills.find((skill) => skill.name === entry.name && skill.root === entry.root && skill.target === entry.target)
    const state = !current ? "missing_or_not_catalogued" : current.sha256 !== entry.sha256 ? "changed" : "reload_required"
    const line = `- ${entry.name} sha256=${entry.sha256} state=${state} source=${JSON.stringify(entry.root + "/" + entry.target)}`
    if (utf8Bytes([...lines, line].join("\n")) > SKILL_COMPACTION_CONTEXT_MAX_BYTES - 200) break
    lines.push(line)
    visible++
  }
  lines.push(`- active references omitted: ${active.length - visible + priorOmitted}; read checkpoint for retained references`)
  return lines.join("\n")
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
    if (role === "user" && text) {
      hint.userText = text
      hint.userMessageId = message.info?.id
    }
    if (role === "assistant" && text) hint.assistantText = text
    for (const part of parts) {
      if (part?.type !== "tool") continue
      const name = typeof part.tool === "string" ? part.tool : ""
      if (name) hint.tools.push(name)
      const input = part.state && typeof part.state === "object" ? (part.state as any).input : part.input
      if (role === "assistant" && name === "skill" && part.state?.status === "completed" && part.state?.metadata?.error !== true && input && typeof input.name === "string" && input.name.trim()) {
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
  private readonly injected = new Map<string, { userMessageId: string; refs: SessionSkillRef[] }>()

  injectedSkillsForTurn(sessionId: string, userMessageId: string): string[] {
    const entry = this.injected.get(sessionId)
    if (entry?.userMessageId !== userMessageId) return []
    const catalog = this.catalog()
    return entry.refs.filter((ref) => catalog.skills.some((skill) => skill.name === ref.name &&
      skill.root === ref.root && skill.target === ref.target && skill.sha256 === ref.sha256)).map((ref) => ref.name)
  }

  constructor(
    private readonly project: string,
    private readonly options: SkillEvolutionOptions,
    private readonly extraRoots: ReadonlyArray<{ root: string; label: string; managed?: boolean }> = [],
  ) {}

  catalog(): SkillCatalog {
    return loadSkillCatalog(this.project, this.options, this.extraRoots)
  }

  observeChatMessages(messages: Array<{ info?: any; parts?: any[] }>): void {
    if (!this.options.enabled) return
    const sessionId = sessionIdFromMessages(messages)
    if (!sessionId) return
    if (messages.some((message) => message.info?.sessionID !== sessionId)) return
    this.hints.set(sessionId, hintFromMessages(messages))
    if (this.hints.size > 256) {
      const oldest = this.hints.keys().next().value!
      this.hints.delete(oldest)
      this.injected.delete(oldest)
    }
  }

  private remember(sessionId: string, entries: SessionSkillRef[]): void {
    if (!entries.length) return
    updateSessionRecovery(this.project, sessionId, (current) => {
      // Historical tool calls do not prove the bytes of a revised skill were read.
      // Keep the first observed identity; drift stays visible until reviewed.
      const merged = [...current.skills]
      for (const entry of entries) {
        if (!merged.some((item) => item.name === entry.name && item.root === entry.root && item.target === entry.target)) merged.push(entry)
      }
      if (merged.length > 32) throw new Error("active skill checkpoint capacity reached; existing references retained")
      return { ...current, skills: merged }
    })
  }

  systemContext(sessionId?: string): string {
    if (!this.options.enabled) return ""
    try {
      if (sessionId && isDeletedSkillSession(this.project, sessionId)) return ""
      const catalog = this.catalog()
      const hint = sessionId ? this.hints.get(sessionId) : undefined
      const recovery = sessionId ? loadSessionRecovery(this.project, sessionId) : null
      const eligible = { ...catalog, skills: catalog.skills.filter((skill) => !recovery?.skills.some((ref) =>
        ref.name === skill.name && (ref.root !== skill.root || ref.target !== skill.target || ref.sha256 !== skill.sha256))) }
      const included: SessionSkillRef[] = []
      const text = formatSkillSystemContext(eligible, hint, included)
      if (sessionId) {
        // A successful skill-tool observation records identity, not a retained body.
        const observed = catalog.skills.filter((skill) => hint?.loadedSkills.includes(skill.name))
        this.remember(sessionId, [...included, ...observed.map(({ name, root, target, sha256 }) => ({ name, root, target, sha256 }))])
      }
      if (sessionId && hint?.userMessageId) this.injected.set(sessionId, { userMessageId: hint.userMessageId, refs: included })
      return [sessionId ? this.compactionContext(sessionId) : "", text].filter(Boolean).join("\n\n")
    } catch {
      if (sessionId) this.injected.delete(sessionId)
      return "ALG session skill checkpoint unavailable; do not assume previous skills are loaded. Reload matching skills in full."
    }
  }

  compactionContext(sessionId?: string): string {
    if (!this.options.enabled) return ""
    try {
      if (!sessionId || isDeletedSkillSession(this.project, sessionId)) return ""
      const recovery = loadSessionRecovery(this.project, sessionId)
      if (!recovery) return ""
      return formatSkillCompactionContext(this.catalog(), recovery?.skills, sessionRecoveryRelativePath(sessionId), recovery?.skills_omitted)
    } catch {
      return "ALG session skill checkpoint unavailable; previous skill identities could not be verified."
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

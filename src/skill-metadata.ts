import { isSafeId } from "./paths.ts"
import { mentionsSkill } from "./turn-boundary.ts"
import type { SkillCatalogEntry, SkillTurnHint } from "./skill-catalog.ts"

export function parseSkillMarkdown(folder: string, content: string): { name: string; description: string } | null {
  if (!isSafeId(folder) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(folder)) return null
  const block = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content)?.[1]
  const scalar = (key: string) => {
    let value = block?.split(/\r?\n/).map((line) => new RegExp(`^${key}\\s*:\\s*(.*)$`).exec(line)).find(Boolean)?.[1]?.trim()
    if (value && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1).trim()
    return value || null
  }
  const name = scalar("name") ?? folder
  const description = scalar("description") ?? (content.match(/^#\s+(.+)$/m)?.[1]?.trim() || `Use the ${folder} project skill when it applies.`)
  return name === folder && description.length <= 1024 ? { name, description } : null
}
export function extractToolHints(content: string): string[] {
  const tools = new Set<string>()
  for (const match of content.matchAll(/`([a-z][a-z0-9_]{2,64})`/g)) tools.add(match[1]!)
  for (const match of content.matchAll(/\b(alg_[a-z0-9_]{2,64})\b/g)) tools.add(match[1]!)
  return [...tools].slice(0, 16)
}
const STOP = new Set(["the", "and", "for", "with", "from", "that", "this", "when", "only", "use", "using"])
const tokens = (value: string) => new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !STOP.has(token)))
export function scoreSkill(entry: SkillCatalogEntry, hint: SkillTurnHint): number {
  const haystack = `${hint.userText}\n${hint.assistantText}\n${hint.tools.join("\n")}`.toLowerCase()
  let score = mentionsSkill(haystack, entry.name) ? 5 : 0
  if (hint.loadedSkills.includes(entry.name)) score += 4
  for (const tool of entry.tools) if (hint.tools.includes(tool) || haystack.includes(tool.toLowerCase())) score += 4
  const words = tokens(haystack)
  return score + Math.min(6, [...tokens(entry.description)].filter((token) => words.has(token)).length)
}

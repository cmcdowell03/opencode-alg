import { deriveAnswer, researchCase, type FabEvidence, type Source } from "./case.ts"
import { summarySignature, textOf, type Completion, type Message, type TurnInput } from "./transport.ts"

export const checkpointPrompt = "Record the next investigation step based on the strongest evidence currently available."
export const pressurePrompt = "Keep the investigation in its present state. Acknowledge receipt of this background material without changing the analysis."
export const applyPrompt = "Acknowledge the archived context and keep the current investigation state."
export const correctionDescription = "Independent checker findings for this investigation"
const publicSources = ["inspection", "route", "dispatch"] as const

export function classify(messages: Message[]) {
  const contents = messages.map(message => textOf(message.content))
  const checker = contents.some(value => value.includes(researchCase.checkerPrompt))
  const root = contents.some(value => [researchCase.prompt, researchCase.revisionPrompt, pressurePrompt, applyPrompt, checkpointPrompt].some(prompt => value.includes(prompt)))
  const phase = checker ? "checker" : contents.slice().reverse().find(value => value.includes(researchCase.revisionPrompt) ||
    value.includes(pressurePrompt) || value.includes(applyPrompt) || value.includes(checkpointPrompt) || value.includes(researchCase.prompt))
  return {
    role: checker ? "checker" : root ? "root" : "other",
    phase: checker ? "checker" : phase?.includes(researchCase.revisionPrompt) ? "revision" :
      phase?.includes(applyPrompt) ? "apply" : phase?.includes(pressurePrompt) ? "pressure" : phase?.includes(checkpointPrompt) ? "checkpoint" : phase ? "initial" : null,
  } as const
}

function lastIndex<T>(items: T[], check: (item: T) => boolean) {
  for (let i = items.length - 1; i >= 0; i--) if (check(items[i]!)) return i
  return -1
}
function textParts(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(textParts)
  if (value && typeof value === "object" && "text" in value) return textParts(value.text)
  return []
}

function objects(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6 || value == null) return []
  if (typeof value === "string") {
    const raw = value.trim().replace(/^```(?:json)?\s*|\s*```$/gi, "")
    try { return objects(JSON.parse(raw), depth + 1) } catch { return [] }
  }
  if (Array.isArray(value)) return value.flatMap(item => objects(item, depth + 1))
  if (typeof value !== "object") return []
  const record = value as Record<string, unknown>
  return [record, ...Object.values(record).flatMap(item => objects(item, depth + 1))]
}

function embeddedObject(content: string, key: string): Record<string, unknown> | undefined {
  const at = content.indexOf('{"' + key + '"')
  if (at < 0) return
  let quoted = false, escaped = false, depth = 0
  for (let i = at; i < content.length; i++) {
    const c = content[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === "{") depth++
    else if (c === "}" && --depth === 0) return objects(content.slice(at, i + 1))[0]
  }
}
function summarize(messages: Message[]) {
  const checkpoints = messages.flatMap(message => textParts(message.content)).flatMap(value => {
    const checkpoint = embeddedObject(value, "phase")
    return checkpoint?.phase === "initial" && Array.isArray(checkpoint.evidenceRefs) ? [checkpoint] : []
  })
  const latest = checkpoints.at(-1)
  return { text: [
    "## Objective", "- Investigate the fab incident.",
    "", "## Requirements", "- Use independently cited source evidence.", "", "## Decisions", latest ? JSON.stringify(latest) : "- No recorded analysis available.",
    "", "## Work State", "### Completed", "- Recorded the observed checkpoint.", "### Active", "- Preserve the state for the next turn.", "### Blocked", "- (none)", "", "## Next Move", "1. Continue from evidence.", "", "## Relevant Files", "- (none)",
  ].join("\n") }
}

/** Single deterministic client policy. It operates only on the current request and its observed tool outputs. */
export function scriptedTurn({ messages, tools, summary }: TurnInput): Completion {
  if (summary) return summarize(messages)
  const { phase } = classify(messages)
  if (!phase) return { text: "Research investigation" }
  if (phase === "checkpoint") {
    const user = lastIndex(messages, message => message.role === "user" && textOf(message.content).includes(checkpointPrompt))
    const history = messages.slice(user + 1).filter(message => message.role === "tool").flatMap(message => objects(message.content))
    const calls = (messages.slice(user + 1).flatMap(message => message.tool_calls ?? [])).filter(call => call.function?.name === "alg_investigation")
    const available = tools.find(tool => tool === "alg_investigation")
    if (!available) return { text: "Review the available inspection and route evidence before acting." }
    const state = history.slice().reverse().find(record => record.ok === true && typeof record.decision_revision === "number")
    if (!calls.length) return { tool: available, args: { action: "create" } }
    if (!state || calls.length !== 1)
      return { text: "Investigation checkpoint turn ended." }
    const cited = messages.some(message => textOf(message.content).includes(correctionDescription))
    return { tool: available, args: { action: "set_next_measurement", expected_decision_revision: state.decision_revision,
      next_action: cited ? "Reassess the route comparison using the independently audited inspection times." :
        "Verify the current inspection-time attribution independently before acting." } }
  }
  if (phase === "pressure" || phase === "apply") return { text: "Background material received.", pressure: phase === "apply" ? 20_000 : messages.some(message => message.role === "user" && textOf(message.content).includes("Packet 80:")) && !messages.some(message => message.role === "user" && textOf(message.content) === pressurePrompt) ? 11_900 : 1100 }
  const server = phase === "checker" ? "audit" : "evidence"
  const mapTool = server + "_map_sources"
  const lookupTool = server + "_lookup_pages"
  if (!tools.includes(mapTool) || !tools.includes(lookupTool)) return { text: JSON.stringify({ status: "unavailable" }), reason: "no_evidence_tool" }
  const user = lastIndex(messages, message => message.role === "user" &&
    textOf(message.content).includes(phase === "checker" ? researchCase.checkerPrompt :
      phase === "revision" ? researchCase.revisionPrompt : researchCase.prompt))
  const seen = messages.slice(Math.max(0, user + 1)).filter(message => message.role === "tool")
    .flatMap(message => objects(message.content))
  const current = messages.slice(Math.max(0, user + 1))
  const skillResult = current.some(message => message.role === "tool" &&
    textOf(message.content).includes("wafer") && textOf(message.content).includes("nextCursor"))
  const invokedSkill = current.some(message =>
    JSON.stringify(message).includes('"name":"skill"') || JSON.stringify(message).includes('"skill":{"'))
  if (tools.includes("skill") && !skillResult && !invokedSkill)
    return { tool: "skill", args: { id: researchCase.skillName } }
  if (invokedSkill && !skillResult) return { text: JSON.stringify({ status: "unavailable" }), reason: "skill_unobserved" }
  if (seen.some(value => value.status === "unavailable" || value.status === "denied" || value.status === "error"))
    return { text: JSON.stringify({ status: "unavailable" }), reason: "evidence_tool_error" }
  if (!seen.some(value => value.op === "map" && value.status === "ok"))
    return { tool: mapTool, args: {} }
  const sources: readonly Source[] = phase === "checker" ? ["clock-audit", "monitor"] : publicSources
  const data: FabEvidence = { inspection: [], route: [], dispatch: [], "clock-audit": [], monitor: [] }
  const refs = new Map<Source, string>()
  const needs = sources.flatMap(source => {
    const pages = seen.filter(value => value.source === source && Array.isArray(value.rows) && typeof value.evidenceRef === "string")
      .sort((a, b) => Number(a.offset) - Number(b.offset))
    const rows: unknown[] = data[source]
    for (const page of pages) {
      if (page.offset !== rows.length) continue
      rows.push(...page.rows as unknown[])
      refs.set(source, page.evidenceRef as string)
    }
    const latest = pages.at(-1)
    if (!latest) return [{ source, limit: 24 }]
    return typeof latest.nextCursor === "string" ? [{ source, limit: 24, cursor: latest.nextCursor }] : []
  })
  if (needs.length) return { tool: lookupTool, args: { pages: needs } }
  if (phase === "checker") return { text: JSON.stringify({ auditRows: data["clock-audit"], evidenceRef: refs.get("clock-audit"), monitorRows: data.monitor, monitorEvidenceRef: refs.get("monitor") }) }
  if (phase === "revision") {
    const correction = messages.flatMap(message => {
      const text = textOf(message.content)
      const values = [...textParts(message.content), text]
      return values.filter(value => value.includes(correctionDescription))
        .flatMap(value => [embeddedObject(value, "auditRows"), embeddedObject(value.replace(/\\"/g, '"'), "auditRows")])
    }).find(value => Array.isArray(value?.auditRows) && typeof value.evidenceRef === "string")
    if (!correction) return { text: JSON.stringify({ status: "unavailable" }), reason: "handoff_unparsed" }
    data["clock-audit"] = correction.auditRows as FabEvidence["clock-audit"]
    refs.set("clock-audit", correction.evidenceRef as string)
    if (Array.isArray(correction.monitorRows) && typeof correction.monitorEvidenceRef === "string") {
      data.monitor = correction.monitorRows as FabEvidence["monitor"]
      refs.set("monitor", correction.monitorEvidenceRef)
    }
  }
  return { text: JSON.stringify(deriveAnswer(data, phase === "revision" ? "revised" : "initial", [...refs.values()])) }
}

export { summarySignature };

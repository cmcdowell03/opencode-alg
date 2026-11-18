import { randomUUID } from "node:crypto"
import { algTool, asObject, parseObject } from "./host.ts"
import type { ProviderTurn } from "./provider.ts"

function strings(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(strings)
  const object = asObject(value)
  return object ? Object.values(object).flatMap(strings) : []
}

function objects(value: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 6) return []
  if (typeof value === "string") {
    const decoded = parseObject(value)
    return decoded ? objects(decoded, depth + 1) : []
  }
  if (Array.isArray(value)) return value.flatMap(item => objects(item, depth + 1))
  const object = asObject(value)
  return object ? [object, ...Object.values(object).flatMap(item => objects(item, depth + 1))] : []
}

export function scenario() {
  const marker = `V2-ACCEPTANCE-${randomUUID()}`
  const actions = new Map<string, { tool?: string; args?: Record<string, unknown>; observe?: (turn: ProviderTurn) => void; handoff?: boolean }>()
  let compact: { expected?: string; sawExpected: boolean } | undefined
  let child: { manifest: string; sawWitness?: string; toolNames?: readonly string[]; release: Promise<void> } | undefined
  let sequence = 0
  return {
    instruction(args?: Record<string, unknown>, observe?: (turn: ProviderTurn) => void, tool = algTool) {
      const id = `${marker}:${++sequence}:`
      actions.set(id, { args, observe, tool })
      return { id, text: `${id} Perform the scripted fixture turn.` }
    },
    handoff(observe: (turn: ProviderTurn) => void) {
      const id = `${marker}:${++sequence}:`
      actions.set(id, { handoff: true, observe })
      return { id, text: `${id} What should I measure next?` }
    },
    compaction(expected?: string) {
      const state = { expected, sawExpected: false }
      compact = state
      return { state, end: () => { compact = undefined } }
    },
    checker(manifest: string) {
      let resume!: () => void
      const state = child = { manifest, release: new Promise<void>(resolve => { resume = resolve }) }
      return { state: state as NonNullable<typeof child>, resume }
    },
    async decide({ messages, tools }: ProviderTurn) {
      if (compact) {
        compact.sawExpected ||= !!compact.expected && messages.some(row => strings(row.content).some(text => text.includes(compact!.expected!)))
        return { text: [
          "## Objective", "- Preserve the synthetic inspection checkpoint.", "",
          "## Requirements", "- Use the authorized evidence page.", "",
          "## Decisions", compact.sawExpected ? `- ${compact.expected}` : "- (none)", "",
          "## Work State", "### Completed", "- Synthetic turn observed.", "### Active", "- (none)", "### Blocked", "- (none)", "",
          "## Next Move", compact.sawExpected ? `1. ${compact.expected}` : "1. Await the next fixture turn.", "",
          "## Relevant Files", "- (none)",
        ].join("\n") }
      }
      let user = -1
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role === "user") { user = i; break }
      const text = strings(messages[user]?.content).join("\n")
      const phase = Array.from(actions.entries()).find(([id]) => text.includes(id))?.[1]
      const current = messages.slice(user + 1)
      const tool = phase?.tool ?? algTool
      const issued = current.some(row => row.tool_calls?.some(call => call.function?.name === tool))
      if (phase) {
        if (!issued) phase.observe?.({ messages, tools })
        if (phase.handoff) {
          const next = projectedMeasurement({ messages, tools })
          return { text: next === undefined ? "No current measurement in the durable projection."
            : JSON.stringify({ nextMeasurement: next }) }
        }
        return phase.args && !issued && tools.includes(tool)
          ? { tool, args: phase.args }
          : { text: phase.args && !issued ? "Fixture tool unavailable." : "Fixture turn observed." }
      }
      const runId = text.match(/action read and runId (v2-checker-[a-f0-9]{48})/)?.[1]
      if (!child || !runId || !tools.includes(algTool)) return { text: "Fixture turn ended." }
      child.toolNames = tools
      const toolResults = current.filter(row => row.role === "tool").flatMap(row => objects(row.content))
      const read = toolResults.find(row => row.ok === true && asObject(row.page) && asObject(row.citation))
      const sent = current.flatMap(row => row.tool_calls ?? []).filter(call => call.function?.name === algTool).length
      if (!issued) return { tool: algTool, args: { action: "read", runId } }
      if (read && sent === 1) {
        const page = asObject(read.page)
        const first = Array.isArray(page?.rows) ? asObject(page.rows[0]) : undefined
        const value = first?.recommendation
        const citation = asObject(read.citation)
        if (typeof value === "string" && page?.digest === child.manifest && citation?.manifest_digest === page.digest) {
          child.sawWitness = value
          return { tool: algTool, args: { action: "result", runId, result: "pass", citation } }
        }
      }
      if (sent === 2 && toolResults.some(row => row.ok === true && asObject(row.worker)?.status === "result_recorded")) {
        await child.release
        return { tool: algTool, args: { action: "read", runId } }
      }
      if (sent === 3 && read && child.sawWitness && toolResults.some(row => row.ok === false && !row.page)) {
        return { text: JSON.stringify({ manifestDigest: asObject(read.page)?.digest, recommendation: child.sawWitness }) }
      }
      return { text: "Fixture checker could not verify the evidence." }
    },
  }
}

export function recoveryText(turn: ProviderTurn) {
  const prefix = "ALG V2 investigation recovery"
  return turn.messages.filter(row => row.role === "system").flatMap(row => strings(row.content))
    .filter(text => text.includes(prefix)).map(text => text.slice(text.indexOf(prefix))).join("\n")
}

function projectedMeasurement(turn: ProviderTurn): string | undefined {
  const recovery = recoveryText(turn)
  const projections = recovery.split("ALG V2 investigation recovery\n").slice(1)
  if (projections.length !== 1) return undefined
  const decision = asObject(parseObject(projections[0]!.split("\n", 1)[0] ?? "")?.decision)
  return typeof decision?.next_action === "string" ? decision.next_action : undefined
}

export function containsStaleSummary(turn: ProviderTurn, stale: string) {
  return turn.messages.some(row => strings(row.content).some(text => text.includes("## Objective") &&
    text.includes("## Decisions") && text.includes(stale)))
}

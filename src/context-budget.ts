import { z } from "zod"

/**
 * How much text ALG may add to a model call, as a share of that model's context window.
 *
 * ALG adds a run summary, skill guidance, working memory and environment facts to the system prompt
 * before each model call, and again to the compaction prompt. Fixed byte limits are wrong at both ends:
 * the same 32 KiB is a quarter of a small local model's window and a rounding error on a large one.
 * A plan sizes everything from the window instead, and shrinks as the window fills.
 *
 * When the window is not known the plan is not dynamic, and every caller keeps its fixed limit.
 */

export const CONTEXT_PARTS = ["run", "skills", "memory", "environment"] as const
export type ContextPart = (typeof CONTEXT_PARTS)[number]

const share = (fallback: number) => z.number().min(0).max(1).default(fallback)

export const ContextBudgetOptionsSchema = z.object({
  /** Share of the model's context window ALG may add to one model call. */
  perCall: z.number().min(0.005).max(0.5).default(0.05),
  /** Share of the window ALG may add to a compaction prompt. */
  compaction: z.number().min(0.005).max(0.5).default(0.05),
  /** ALG never plans to use more than this share of the window that is still free. */
  ofAvailable: z.number().min(0.05).max(1).default(0.5),
  /**
   * How the allowance is divided among the parts in use. These are weights: parts that are switched
   * off are left out, and what a part does not use passes to the parts after it.
   */
  shares: z.object({
    run: share(0.2),
    skills: share(0.35),
    memory: share(0.35),
    environment: share(0.1),
  }).strict().default({ run: 0.2, skills: 0.35, memory: 0.35, environment: 0.1 }),
  /** Estimated bytes of text per model token, used to turn a token share into a byte allowance. */
  bytesPerToken: z.number().min(1).max(8).default(3),
  /** The least ALG plans for, so the essentials still fit when the window is nearly full. */
  floorBytes: z.number().int().min(256).max(65_536).default(1_536),
}).strict()

export type ContextBudgetOptions = z.infer<typeof ContextBudgetOptionsSchema>

export interface ModelWindow {
  /** The model's context window, in tokens. */
  context?: number
  /** The most the model may generate, in tokens. It is reserved out of the window. */
  output?: number
  /** Tokens already in the window, not counting what ALG itself added last time, when known. */
  usedTokens?: number
}

export interface ContextPlanSummary {
  dynamic: boolean
  kind: "call" | "compaction"
  context_tokens: number | null
  used_tokens: number | null
  available_tokens: number | null
  total_bytes: number | null
  limited_by: "share" | "available" | "floor" | "fixed"
  parts: Partial<Record<ContextPart, { allowed_bytes: number; spent_bytes: number }>>
}

export interface ContextPlan {
  /** False when the model's window is unknown. Callers then keep their fixed limits. */
  readonly dynamic: boolean
  /** Everything ALG may add under this plan, in bytes. Undefined when the plan is not dynamic. */
  readonly totalBytes: number | undefined
  /**
   * Bytes the part may use now: its own share plus whatever the parts before it left unused.
   * Undefined when the plan is not dynamic or the part is not in use.
   */
  allow(part: ContextPart): number | undefined
  /** Records what a part used, releasing the rest of its share to the parts after it. */
  spend(part: ContextPart, bytes: number): void
  spentBytes(): number
  describe(): ContextPlanSummary
}

const positive = (value: number | undefined): value is number => value !== undefined && Number.isFinite(value) && value > 0

/**
 * Plans one model call or one compaction. `parts` lists the parts that will be rendered, in priority
 * order; leave out a part that is switched off so its share goes to the others.
 */
export function planContext(
  options: ContextBudgetOptions,
  window: ModelWindow,
  kind: "call" | "compaction",
  parts: readonly ContextPart[] = CONTEXT_PARTS,
): ContextPlan {
  const spent = new Map<ContextPart, number>()
  const active = CONTEXT_PARTS.filter((part) => parts.includes(part))
  if (!positive(window.context)) {
    return {
      dynamic: false,
      totalBytes: undefined,
      allow: () => undefined,
      spend(part, bytes) { spent.set(part, (spent.get(part) ?? 0) + Math.max(0, bytes)) },
      spentBytes: () => [...spent.values()].reduce((sum, bytes) => sum + bytes, 0),
      describe: () => ({ dynamic: false, kind, context_tokens: null, used_tokens: null, available_tokens: null, total_bytes: null,
        limited_by: "fixed", parts: Object.fromEntries([...spent].map(([part, bytes]) => [part, { allowed_bytes: 0, spent_bytes: bytes }])) }),
    }
  }

  const context = window.context
  let tokens = context * (kind === "compaction" ? options.compaction : options.perCall)
  let limitedBy: ContextPlanSummary["limited_by"] = "share"
  let available: number | null = null
  const used = window.usedTokens !== undefined && Number.isFinite(window.usedTokens) && window.usedTokens >= 0 ? window.usedTokens : null
  if (used !== null) {
    // The reply needs room too; never count more than half the window as reserved for it.
    const reply = positive(window.output) ? Math.min(window.output, context / 2) : 0
    available = Math.max(0, context - reply - used)
    const fromAvailable = available * options.ofAvailable
    if (fromAvailable < tokens) { tokens = fromAvailable; limitedBy = "available" }
  }
  let totalBytes = Math.floor(tokens * options.bytesPerToken)
  if (totalBytes < options.floorBytes) { totalBytes = options.floorBytes; limitedBy = "floor" }

  const weight = (part: ContextPart) => options.shares[part]
  const weights = active.reduce((sum, part) => sum + weight(part), 0)
  const base = new Map<ContextPart, number>(active.map((part) =>
    [part, Math.floor(totalBytes * (weights > 0 ? weight(part) / weights : 1 / Math.max(1, active.length)))]))
  const allow = (part: ContextPart): number | undefined => {
    const index = active.indexOf(part)
    if (index < 0) return undefined
    // Only a part that has reported what it used releases the rest of its share.
    let carried = 0
    for (const earlier of active.slice(0, index)) {
      if (spent.has(earlier)) carried += Math.max(0, base.get(earlier)! - spent.get(earlier)!)
    }
    // An earlier part that overspent (the floor of an essential, say) is paid for here.
    const overspent = active.slice(0, index).reduce((sum, earlier) =>
      sum + Math.max(0, (spent.get(earlier) ?? 0) - base.get(earlier)!), 0)
    return Math.max(0, base.get(part)! + carried - overspent - (spent.get(part) ?? 0))
  }
  return {
    dynamic: true,
    totalBytes,
    allow,
    spend(part, bytes) { spent.set(part, (spent.get(part) ?? 0) + Math.max(0, bytes)) },
    spentBytes: () => [...spent.values()].reduce((sum, bytes) => sum + bytes, 0),
    describe: () => ({
      dynamic: true, kind, context_tokens: context, used_tokens: used, available_tokens: available === null ? null : Math.floor(available),
      total_bytes: totalBytes, limited_by: limitedBy,
      parts: Object.fromEntries(active.map((part) => [part, { allowed_bytes: base.get(part)!, spent_bytes: spent.get(part) ?? 0 }])),
    }),
  }
}

interface UsageMessage {
  info?: { role?: unknown; summary?: unknown; tokens?: { input?: unknown; output?: unknown; cache?: { read?: unknown; write?: unknown } } }
  parts?: unknown
}

const count = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0

/**
 * Estimates how many tokens the conversation occupies, from what the host itself measured. The last
 * assistant reply records the size of the prompt that produced it, which already covers everything
 * before it; only what came after is estimated from its length. A compaction summary records the size
 * of the conversation it replaced, so only its own length counts. Undefined when there is nothing to
 * go on.
 */
export function estimateUsedTokens(messages: readonly UsageMessage[], bytesPerToken: number): number | undefined {
  if (!messages.length) return undefined
  let measured = -1
  for (let index = messages.length - 1; index >= 0; index--) {
    const info = messages[index]?.info
    if (info?.role === "assistant" && info.tokens && (count(info.tokens.input) || count(info.tokens.output))) { measured = index; break }
  }
  let tail = 0
  for (const message of messages.slice(measured + 1)) {
    try { tail += Buffer.byteLength(JSON.stringify(message.parts ?? ""), "utf8") } catch { /* an unserializable part is not prompt text */ }
  }
  const tailTokens = Math.ceil(tail / Math.max(1, bytesPerToken))
  if (measured < 0) return tailTokens
  const info = messages[measured]!.info!
  const tokens = info.tokens!
  const prompt = info.summary === true ? 0 : count(tokens.input) + count(tokens.cache?.read) + count(tokens.cache?.write)
  return prompt + count(tokens.output) + tailTokens
}

/**
 * What ALG knows about each session's window between hooks: the model's limits from the last system
 * prompt hook, the conversation size from the last message hook, and how much ALG itself added, which
 * the host's measurement includes and the plan must not count twice.
 */
export class SessionWindows {
  private readonly windows = new Map<string, { context?: number; output?: number; conversationTokens?: number; addedBytes?: number; last?: ContextPlanSummary }>()
  constructor(private readonly options: ContextBudgetOptions, private readonly maximum = 512) {}

  private entry(sessionId: string) {
    let entry = this.windows.get(sessionId)
    if (!entry) {
      if (this.windows.size >= this.maximum) this.windows.delete(this.windows.keys().next().value!)
      entry = {}
      this.windows.set(sessionId, entry)
    }
    return entry
  }

  /** From the message hook: the whole window about to be sent. */
  observeMessages(sessionId: string, messages: readonly UsageMessage[]): void {
    const used = estimateUsedTokens(messages, this.options.bytesPerToken)
    if (used !== undefined) this.entry(sessionId).conversationTokens = used
  }

  /** From the system prompt hook: the limits of the model about to be called. */
  observeModel(sessionId: string, limit: { context?: number; output?: number } | undefined): void {
    if (!limit || !positive(limit.context)) return
    const entry = this.entry(sessionId)
    entry.context = limit.context
    entry.output = positive(limit.output) ? limit.output : undefined
  }

  window(sessionId: string): ModelWindow {
    const entry = this.windows.get(sessionId)
    if (!entry) return {}
    const added = Math.ceil((entry.addedBytes ?? 0) / Math.max(1, this.options.bytesPerToken))
    return {
      context: entry.context,
      output: entry.output,
      usedTokens: entry.conversationTokens === undefined ? undefined : Math.max(0, entry.conversationTokens - added),
    }
  }

  plan(sessionId: string, kind: "call" | "compaction", parts: readonly ContextPart[]): ContextPlan {
    return planContext(this.options, this.window(sessionId), kind, parts)
  }

  /** After a model call's context is assembled: remember what was added and how it was planned. */
  record(sessionId: string, plan: ContextPlan): void {
    const entry = this.entry(sessionId)
    const summary = plan.describe()
    if (summary.kind === "call") entry.addedBytes = plan.spentBytes()
    entry.last = summary
  }

  last(sessionId: string): ContextPlanSummary | null {
    return this.windows.get(sessionId)?.last ?? null
  }

  forget(sessionId: string): void {
    this.windows.delete(sessionId)
  }
}

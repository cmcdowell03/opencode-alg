import { createHash } from "node:crypto"
import type { Plugin } from "@opencode/plugin"
import { visit } from "jsonc-parser"
import { z } from "zod"
import { calculationPolicyDigest, type CalculationPolicy, type ChildAuditOrigin, type VerifiedChildAudit } from "./calculation.ts"
import type { DeliveryHistory } from "./delivery.ts"
import type { ChildEvidenceReader, EvidenceProgress } from "./evidence-journal.ts"
import { canonicalDirectory, InvestigationHost, TOOL } from "./host.ts"

type Context = Plugin.Context
type Session = Awaited<ReturnType<Context["session"]["get"]>>
type Assistant = Extract<DeliveryHistory[number], { type: "assistant" }>
type ToolCall = Extract<Assistant["content"][number], { type: "tool" }>
type Notice = NonNullable<ReturnType<ChildEvidenceReader["notice"]>>
type Locator = Notice & Partial<Pick<ChildAuditOrigin, "sourceProof">>

const nativeName = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)
const key = z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/)
  .refine(name => !["__proto__", "prototype", "constructor"].includes(name))
const token = z.string().min(1).max(256).refine(value => !/[\x00-\x1f\x7f]/.test(value) && !!value.trim())
const timestamp = z.number().int().nonnegative()
const sha256 = z.string().regex(/^[a-f0-9]{64}$/)
const maxRows = 1024
const maxTextBytes = 512 * 1024
const distinct = (names: string[]) => new Set(names).size === names.length

const mappingSchema = z.strictObject({
  pagesKey: key.default("pages"),
  sourceKey: key.default("source"),
  referenceKey: key.default("evidenceRef"),
  rowsKey: key.default("rows"),
  offsetKey: key.default("offset"),
  limitKey: key.default("limit"),
  cursorKey: key.default("cursor"),
  totalRowsKey: key.default("totalRows"),
  nextCursorKey: key.default("nextCursor"),
  coverageKey: key.default("ownerCoverage"),
  answerReferenceKey: key.default("auditRef"),
  answerRowsKey: key.default("auditRows"),
}).refine(m => distinct([m.pagesKey, "status", "op", "queryId"]) &&
  distinct([m.sourceKey, m.limitKey, m.offsetKey, m.cursorKey]) &&
  distinct([m.sourceKey, m.referenceKey, m.rowsKey, m.offsetKey, m.limitKey,
    m.totalRowsKey, m.nextCursorKey, m.coverageKey]) &&
  m.answerReferenceKey !== m.answerRowsKey)

export const childAuditConfigSchema = z.strictObject({
  agent: nativeName,
  tool: nativeName.refine(name => name !== TOOL),
  source: token,
  // A whole-source read can be joined locally. Task-scoped services must
  // attest which owner selection they read, even for a newly created child.
  scope: z.enum(["selected-cohort", "whole-source"]).default("selected-cohort"),
  maxRows: z.number().int().min(1).max(maxRows).default(24),
  mapping: mappingSchema.prefault({}),
})

export type ChildAuditConfig = z.input<typeof childAuditConfigSchema>
type Config = z.output<typeof childAuditConfigSchema>

const noticeSchema = z.strictObject({ childId: token, noticeId: token, noticeTime: timestamp })
const coverageSchema = z.strictObject({
  taskId: token,
  messageId: token,
  callId: token,
  reference: token,
  rowsSha256: sha256,
  rowCount: z.number().int().min(0).max(maxRows),
})
const scalar = z.union([
  z.null(), z.boolean(), z.string().max(4096),
  z.number().refine(value => !Object.is(value, -0) && (!Number.isInteger(value) || Number.isSafeInteger(value))),
])
const rowSchema = z.record(key, scalar).refine(row => Object.keys(row).length > 0 && Object.keys(row).length <= 64)
const rowsSchema = z.array(rowSchema).max(maxRows)

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}

function invalid(): never {
  throw new Error("CHILD_AUDIT_UNVERIFIED")
}

function onlyKeys(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some(name => !keys.includes(name))) invalid()
}

// Detect duplicate decoded names before JSON.parse and bound nesting before walking it.
function parseObject(text: string) {
  if (text.length > maxTextBytes || Buffer.byteLength(text) > maxTextBytes) invalid()
  const containers: (Set<string> | null)[] = []
  const enter = (keys: Set<string> | null) => {
    if (containers.length >= 8) invalid()
    containers.push(keys)
  }
  visit(text, {
    onObjectBegin: () => enter(new Set()),
    onObjectProperty: name => {
      const keys = containers.at(-1)
      if (!keys || keys.has(name)) invalid()
      keys.add(name)
    },
    onObjectEnd: () => { containers.pop() },
    onArrayBegin: () => enter(null),
    onArrayEnd: () => { containers.pop() },
    onError: invalid,
  }, { disallowComments: true, allowTrailingComma: false })
  return record(JSON.parse(text))
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

function normalizedRows(value: unknown, limit: number) {
  if (!Array.isArray(value) || value.length > limit) invalid()
  // The audit represents a set of observed rows. Keep duplicates visible and reject them.
  const rows = rowsSchema.parse(value).map(row => Object.fromEntries(
    Object.keys(row).sort().map(name => [name, row[name]!]),
  ))
  const encoded = rows.map(row => JSON.stringify(row)).sort()
  if (!distinct(encoded)) invalid()
  return { rows, encoded }
}

function readLookup(call: ToolCall, config: Config, expectedCoverage: z.output<typeof coverageSchema>) {
  if (call.executed === true || call.state.status !== "completed" ||
      (call.state.metadata?.truncated !== undefined && call.state.metadata.truncated !== false)) invalid()
  const { mapping: m } = config
  const input = record(call.state.input)
  onlyKeys(input, [m.pagesKey])
  const requests = input[m.pagesKey]
  if (!Array.isArray(requests) || requests.length !== 1) invalid()
  const request = record(requests[0])
  onlyKeys(request, [m.sourceKey, m.cursorKey, m.offsetKey, m.limitKey])
  if (request[m.sourceKey] !== config.source || request[m.cursorKey] != null ||
      (request[m.offsetKey] !== undefined && !Object.is(request[m.offsetKey], 0))) invalid()
  const limit = z.number().int().min(1).max(config.maxRows).parse(request[m.limitKey] ?? config.maxRows)

  const output = call.state.content[0]
  if (call.state.content.length !== 1 || output?.type !== "text") invalid()
  const result = parseObject(output.text)
  onlyKeys(result, ["status", "op", "queryId", m.pagesKey])
  const pages = result[m.pagesKey]
  if (result.status !== "ok" || result.op !== "lookup" || !Array.isArray(pages) || pages.length !== 1) invalid()
  const page = record(pages[0])
  onlyKeys(page, [m.sourceKey, m.offsetKey, m.limitKey, m.nextCursorKey, m.totalRowsKey, m.referenceKey, m.rowsKey, m.coverageKey])
  if (page[m.sourceKey] !== config.source || !Object.is(page[m.offsetKey], 0) || page[m.nextCursorKey] !== null ||
      (page[m.limitKey] !== undefined && page[m.limitKey] !== limit)) invalid()
  const { rows, encoded } = normalizedRows(page[m.rowsKey], limit)
  if (page[m.totalRowsKey] !== rows.length || Object.is(page[m.totalRowsKey], -0)) invalid()
  const reference = token.parse(page[m.referenceKey])
  const queryId = token.optional().parse(result.queryId)
  const coverage = coverageSchema.optional().parse(page[m.coverageKey])
  if (coverage && Object.keys(expectedCoverage).some(name =>
    Reflect.get(expectedCoverage, name) !== Reflect.get(coverage, name))) invalid()
  return { reference, rows, encoded, queryId, coverage, limit }
}

function matchingRule(rules: Session["permissions"], action: string, resource: string) {
  // A nonliteral pattern is a possible override. It cannot establish an exact grant.
  const mayMatch = (pattern: string, value: string) => pattern === value || /[*?[\]\\]/.test(pattern)
  if (!rules) return
  for (let index = rules.length - 1; index >= 0; index--) {
    const rule = rules[index]!
    if (mayMatch(rule.action, action) && mayMatch(rule.resource, resource)) return rule
  }
}

function exactGrant(rule: ReturnType<typeof matchingRule>, action: string, resource: string) {
  return rule?.action === action && rule.resource === resource && rule.effect === "allow"
}

function finished(session: Session, through: number): session is Session & { time: { busy: number; idle: number } } {
  const { created, busy, idle, archived } = session.time
  return session.outcome === "succeeded" && !session.fork && !session.revert && archived === undefined &&
    timestamp.safeParse(created).success && typeof busy === "number" && Number.isSafeInteger(busy) &&
    typeof idle === "number" && Number.isSafeInteger(idle) && created <= busy && busy <= idle && idle <= through
}

function readTranscript(history: DeliveryHistory, child: Session & { time: { busy: number; idle: number } }, config: Config, through: number) {
  if (history.length > 64) invalid()
  const prompt = history[0]
  const last = history.at(-1)
  const idle = last?.type === "idle" ? last : undefined
  const answer = idle ? history.at(-2) : last
  if (prompt?.type !== "user" || prompt.time.created < child.time.created ||
      (idle && (idle.outcome !== "succeeded" || idle.error || idle.time.created > through)) ||
      answer?.type !== "assistant" || answer.finish !== "stop") invalid()

  const ids = new Set<string>()
  let previous = child.time.created
  let parts = 0
  let lookup: { message: Assistant; call: ToolCall; completedAt: number } | undefined
  for (const message of history) {
    if (!token.safeParse(message.id).success || ids.has(message.id) ||
        !timestamp.safeParse(message.time.created).success || message.time.created < previous ||
        message.time.created > through) invalid()
    ids.add(message.id)
    previous = message.time.created
    if (message === prompt || message === idle || message.type === "system" || message.type === "skill") continue
    if (message.type !== "assistant" || message.agent !== config.agent || message.error ||
        message.retry || (message !== answer && message.finish !== "tool-calls")) invalid()
    const completedAt = timestamp.parse(message.time.completed)
    if (completedAt < previous || completedAt > child.time.idle) invalid()
    previous = completedAt
    parts += message.content.length
    if (parts > 128) invalid()
    for (const part of message.content) {
      if (part.type !== "tool") continue
      if (message === answer || !token.safeParse(part.id).success || ids.has(part.id)) invalid()
      ids.add(part.id)
      if (part.name !== config.tool) continue
      if (lookup) invalid()
      const created = timestamp.parse(part.time.created)
      const ran = timestamp.parse(part.time.ran)
      const completed = timestamp.parse(part.time.completed)
      if (created < message.time.created || ran < created || completed < ran || completed > completedAt) invalid()
      lookup = { message, call: part, completedAt: completed }
    }
  }
  const text = answer.content.filter(part => part.type === "text")
  if (!lookup || text.length !== 1 || !text[0]) invalid()
  return { prompt, idle, answer, text: text[0].text, ...lookup }
}

export type ChildAuditProof = {
  sourceMessageId: string
  sourceCallId: string
  sourceCompletedAt: number
  promptId: string
  answerId: string
  terminalId: string | null
  semanticSha256: string
}

type Resolution = VerifiedChildAudit & { proof: ChildAuditProof }
type Reader = Omit<ChildEvidenceReader, "resolve"> & { resolve(notice: Locator, progress: EvidenceProgress): Promise<Resolution | undefined> }

/**
 * Read an OpenCode 2.3.2 child from native state. The caller supplies a locator
 * obtained through notice(), or reuses that locator from its integrity-checked journal.
 */
export function createChildEvidenceReader(ctx: Context, input: ChildAuditConfig, owner: Session, policy: CalculationPolicy): Reader {
  const config = childAuditConfigSchema.parse(input)
  const policyDigest = calculationPolicyDigest(policy)
  const ownerAgent = owner.agent
  if (!ownerAgent || owner.projectID !== ctx.location.project.id || config.agent === ownerAgent || config.tool === policy.owner.tool ||
      [policy.correction.referenceKey, policy.correction.rowsKey].includes("ownerCoverage")) invalid()

  async function resolve(locator: Locator, progress: EvidenceProgress): Promise<Resolution | undefined> {
    try {
      const notice = noticeSchema.parse({ childId: locator.childId, noticeId: locator.noticeId, noticeTime: locator.noticeTime })
      const checkpoint = progress.checkpoint
      const page = checkpoint?.pages.at(-1)
      if (!checkpoint?.selected || checkpoint.conflict || !page ||
          checkpoint.recipeSha256 !== policyDigest || checkpoint.ownerAgent !== ownerAgent ||
          page.evidence.source !== policy.owner.source || page.evidence.tool !== policy.owner.tool ||
          page.evidence.agent !== ownerAgent || notice.childId === owner.id) return
      const { reference, rowsSha256, rowCount, messageId, callId } = page.evidence
      const coverage = coverageSchema.parse({ taskId: checkpoint.task.id, messageId, callId, reference, rowsSha256, rowCount })
      const directory = await canonicalDirectory(ctx.location.directory)
      const host = new InvestigationHost(ctx, directory, ownerAgent!, config.agent)
      await host.owner({ sessionID: owner.id, agent: ownerAgent! })

      async function getChild() {
        const child = await ctx.session.get({ sessionID: notice.childId as Session["id"] })
        if (child.id !== notice.childId || child.parentID !== owner.id || child.agent !== config.agent ||
            !finished(child, notice.noticeTime) || !await host.matchesLocation(child)) invalid()
        return child
      }
      const child = await getChild()
      const transcript = readTranscript(await ctx.session.context({ sessionID: child.id }), child, config, notice.noticeTime)
      const lookup = readLookup(transcript.call, config, coverage)
      if (lookup.reference === reference || (!lookup.coverage && config.scope === "selected-cohort") ||
          (!lookup.coverage && (page.completedAt === undefined || child.time.created <= page.completedAt)) ||
          (page.completedAt !== undefined && transcript.completedAt <= page.completedAt)) return

      const { answerRowsKey, answerReferenceKey } = config.mapping
      const answer = parseObject(transcript.text)
      onlyKeys(answer, [answerReferenceKey, answerRowsKey])
      const report = normalizedRows(answer[answerRowsKey], lookup.limit)
      if (answer[answerReferenceKey] !== lookup.reference || JSON.stringify(report.encoded) !== JSON.stringify(lookup.encoded)) return

      const agent = child.agent!
      const role = await ctx.agent.get({ agentID: agent, location: { directory: ctx.location.directory } })
      if (role.data.id !== agent || role.data.mode !== "subagent" || Reflect.get(role.location, "workspaceID") !== undefined ||
          await canonicalDirectory(role.location.directory) !== directory) return
      for (const [action, resource] of [[config.tool, "*"], ["tool.use", config.tool]] as const) {
        const roleRule = matchingRule(role.data.permissions, action, resource)
        const override = matchingRule(child.permissions, action, resource)
        if (!exactGrant(roleRule, action, resource) || (override && !exactGrant(override, action, resource))) return
        await ctx.permission.assert({ sessionID: child.id, agent, action, resources: [resource] })
      }
      const current = await getChild()
      if (current.time.created !== child.time.created || current.time.busy !== child.time.busy ||
          current.time.idle !== child.time.idle || JSON.stringify(current.permissions) !== JSON.stringify(child.permissions)) return

      const proof: ChildAuditProof = {
        sourceMessageId: transcript.message.id,
        sourceCallId: transcript.call.id,
        sourceCompletedAt: transcript.completedAt,
        promptId: transcript.prompt.id,
        answerId: transcript.answer.id,
        terminalId: transcript.idle?.id ?? null,
        semanticSha256: digest([config.source, lookup.reference, lookup.encoded]),
      }
      const sourceProof = digest(["opencode-child-audit-v1", owner.projectID, directory, owner.id, child.id,
        policyDigest, checkpoint.task.fingerprint, coverage, page.completedAt ?? null, config, child.time.created, child.time.busy,
        child.time.idle, proof, lookup.queryId ?? null, lookup.coverage ?? null, lookup.limit])
      if (locator.sourceProof !== undefined && locator.sourceProof !== sourceProof) return
      return {
        origin: { ...notice, sourceProof },
        proof,
        data: {
          [policy.correction.referenceKey]: lookup.reference,
          [policy.correction.rowsKey]: lookup.rows,
          ownerCoverage: { reference, rowsSha256, rowCount },
        },
      }
    } catch {
      return undefined
    }
  }

  return {
    notice(row) {
      if (row.type !== "synthetic" || row.metadata?.source !== "subagent" ||
          row.metadata?.agent !== config.agent || row.metadata?.state !== "completed") return
      const locator = noticeSchema.safeParse({ childId: row.metadata.childID, noticeId: row.id, noticeTime: row.time.created })
      return locator.success ? locator.data : undefined
    },
    resolve,
  }
}

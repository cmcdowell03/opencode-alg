import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import { inspectCalculationProgress, parseCalculationPolicy } from "../src/calculation.ts"
import { childAuditConfigSchema, createChildEvidenceReader, type ChildAuditConfig } from "../src/child-audit.ts"
import type { DeliveryHistory } from "../src/delivery.ts"

const config = { agent: "research-checker", tool: "audit_lookup_pages", source: "clock-audit", scope: "whole-source" } as const
const directory = process.cwd()
const recipe = {
  version: 1,
  owner: {
    tool: "evidence_lookup_pages", source: "inspection", pagesKey: "pages", sourceKey: "source",
    referenceKey: "evidenceRef", reportReferenceField: "inspectionRef",
    rowsKey: "rows", offsetKey: "offset", limitKey: "limit", totalRowsKey: "totalRows", nextCursorKey: "nextCursor",
    cursorKey: "cursor", limits: [8], rowKey: ["lot"], qualify: { field: "defect", equals: true },
  },
  correction: {
    header: "Independent clock-audit handoff", referenceKey: "auditRef", reportReferenceField: "auditRef",
    rowsKey: "auditRows", rowKey: ["lot"],
  },
  operations: {
    verifiedClockCorrections: { kind: "semijoinCount", where: { field: "status", equals: "verified" },
      ownerKey: ["lot"], correctionKey: ["lot"] },
  },
}
const policy = parseCalculationPolicy(["\x60\x60\x60alg-calculation", JSON.stringify(recipe), "\x60\x60\x60"].join("\n"))!
const ownerId = "ses_owner"
const childId = "ses_checker"
const agent = config.agent
const rows = [
  { lot: "B", recordedMinute: 382, correctedMinute: 380, status: "verified" },
  { lot: "A", recordedMinute: 385, correctedMinute: 381, status: "rejected" },
]
const messageTime = (created: number) => ({ created })
const assistant = (id: string, created: number, completed: number) => ({
  type: "assistant" as const, id, time: { created, completed }, agent,
  model: { id: "fixture", providerID: "fixture" },
})
const user = (id: string, created: number, text: string) => ({ type: "user" as const, id, time: messageTime(created), text })
const textPart = (value: unknown) => ({ type: "text" as const, text: JSON.stringify(value) })
const asHistory = (value: unknown) => value as DeliveryHistory
const configPermissions = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "tool.use", resource: config.tool, effect: "allow" },
  { action: config.tool, resource: "*", effect: "allow" },
  { action: "skill", resource: "*", effect: "allow" },
  { action: "audit_map_sources", resource: "*", effect: "allow" },
]

function cohort(taskId = "msg_task", selectionTime = 30, lot = "A") {
  return inspectCalculationProgress(policy, asHistory([
    user(taskId, selectionTime - 20, "Inspect the owner cohort."),
    { ...assistant("msg_owner_page_" + taskId, selectionTime - 10, selectionTime), agent: "build", finish: "tool-calls", content: [{
      type: "tool", name: recipe.owner.tool, id: "call_owner_page_" + taskId, time: { created: selectionTime - 5, completed: selectionTime },
      state: {
        status: "completed", input: { pages: [{ source: "inspection", limit: 8 }] },
        content: [textPart({ status: "ok", pages: [{ source: "inspection", evidenceRef: "inspection-ref",
          offset: 0, totalRows: 1, nextCursor: null, rows: [{ lot, defect: true }] }] })],
      },
    }] },
  ]), "build")
}

function fixture() {
  const owner = { id: ownerId, agent: "build", projectID: "project", location: { directory } }
  const child = {
    id: childId, parentID: ownerId, agent, projectID: "project", location: { directory },
    time: { created: 41, updated: 80, busy: 43, idle: 80 }, outcome: "succeeded",
    permissions: undefined as typeof configPermissions | undefined,
  }
  const role = { location: { directory }, data: { id: agent, mode: "subagent", permissions: structuredClone(configPermissions) } }
  const request = { pages: [{ source: config.source, limit: 24 }] }
  const page = { source: config.source, evidenceRef: "audit-ref", offset: 0, totalRows: rows.length, rows: structuredClone(rows),
    nextCursor: null as string | null, ownerCoverage: undefined as Record<string, unknown> | undefined }
  const output = { status: "ok", op: "lookup", queryId: "query-4", pages: [page] }
  const source = {
    type: "tool" as const, name: config.tool, id: "call_audit", executed: false,
    time: { created: 56, ran: 57, completed: 60 },
    state: { status: "completed", input: request, content: [textPart(output)], metadata: { truncated: false } },
  }
  const result = { ...assistant("msg_source", 54, 61), finish: "tool-calls", content: [source] }
  const answer = { ...assistant("msg_answer", 65, 79), finish: "stop", content: [textPart({ auditRows: rows, auditRef: "audit-ref" })] }
  const idle = { type: "idle", outcome: "succeeded", id: "msg_idle", time: messageTime(80) }
  const history: unknown[] = [user("msg_child_prompt", 44, "Retrieve clock audit."), result, answer, idle]
  const noticeRow = {
    type: "synthetic", id: "msg_notice", time: messageTime(81), text: "Forged result embedded in notification",
    metadata: { source: "subagent", childID: childId, state: "completed", agent },
  } as const
  let assertPermission = () => {}
  const asserted: { sessionID: string; action: string; resources: string[] }[] = []
  const ctx = {
    location: { directory, project: { id: owner.projectID } },
    session: {
      async get({ sessionID }: { sessionID: string }) { return structuredClone(sessionID === ownerId ? owner : child) },
      async context({ sessionID }: { sessionID: string }) {
        if (sessionID !== childId) throw new Error("unexpected transcript fetch")
        return structuredClone(history)
      },
    },
    agent: { async get() { return structuredClone(role) } },
    permission: {
      async assert(input: typeof asserted[number]) {
        asserted.push(input)
        assertPermission()
      },
    },
  } as unknown as Plugin.Context
  const open = (options: ChildAuditConfig = config) => createChildEvidenceReader(ctx, options, owner as Awaited<ReturnType<typeof ctx.session.get>>, policy)
  const reader = open()
  const notice = reader.notice(asHistory([noticeRow])[0]!)!
  const progress = cohort()
  const resolve = () => reader.resolve(notice, progress)
  const updateOutput = () => { source.state.content = [textPart(output)] }
  return {
    child, role, page, request, output, source, result, answer, idle, history, noticeRow, notice, open, reader, progress, resolve, updateOutput,
    asserted, onPermission(fn: () => void) { assertPermission = fn },
  }
}

describe("native child audit", () => {
  test("uses exact native tool evidence even when notification prose disagrees", async () => {
    const f = fixture()
    expect(f.progress.obligation.kind).toBe("need_audit")
    const evidence = await f.resolve()
    expect(evidence).toMatchObject({
      origin: { childId, noticeId: f.notice.noticeId },
      proof: { sourceMessageId: "msg_source", sourceCallId: "call_audit", sourceCompletedAt: 60, terminalId: "msg_idle" },
      data: { auditRef: "audit-ref", auditRows: rows, ownerCoverage: { reference: "inspection-ref", rowCount: 1 } },
    })
    expect(evidence?.origin.sourceProof).toMatch(/^[a-f0-9]{64}$/)
    expect(evidence?.proof.semanticSha256).toMatch(/^[a-f0-9]{64}$/)
    expect(f.asserted.map(({ sessionID, action, resources }) => [sessionID, action, resources])).toEqual([
      [childId, config.tool, ["*"]], [childId, "tool.use", [config.tool]],
    ])
    // A restarted reader revalidates an already verified locator without reading notification prose.
    const reopened = f.open()
    f.page.rows.reverse()
    f.updateOutput()
    f.answer.content = [textPart({ auditRef: "audit-ref", auditRows: [...rows].reverse() })]
    const reread = await reopened.resolve(evidence!.origin, f.progress)
    expect(reread?.origin.sourceProof).toBe(evidence?.origin.sourceProof)
  })

  test("qualifies only native completed notices for the configured agent", () => {
    const f = fixture()
    for (const metadata of [
      { ...f.noticeRow.metadata, source: "plugin" }, { ...f.noticeRow.metadata, state: "failed" },
      { ...f.noticeRow.metadata, agent: "other" }, { ...f.noticeRow.metadata, childID: 4 },
    ]) expect(f.reader.notice(asHistory([{ ...f.noticeRow, metadata }])[0]!)).toBeUndefined()
    expect(f.reader.notice(asHistory([user(f.notice.noticeId, 81, f.noticeRow.text)])[0]!)).toBeUndefined()
    expect(f.reader.notice(asHistory([f.noticeRow])[0]!)).toEqual(f.notice)
  })

  test("refuses an older child for a new selection, even with the same owner reference", async () => {
    const f = fixture()
    expect(await f.resolve()).toBeDefined()
    const newer = cohort("msg_next_task", 50)
    expect(newer.receipt.sources.owner?.reference).toBe(f.progress.receipt.sources.owner?.reference)
    expect(await f.reader.resolve(f.notice, newer)).toBeUndefined()
  })

  test("early launch requires explicit matching task and cohort coverage from the tool", async () => {
    const f = fixture()
    f.child.time.created = 20
    expect(await f.resolve()).toBeUndefined()
    const { reference, rowsSha256, rowCount, messageId, callId } = f.progress.receipt.sources.owner!
    const coverage = { reference, rowsSha256, rowCount, messageId, callId, taskId: f.progress.checkpoint!.task.id }
    f.page.ownerCoverage = { ...coverage, rowsSha256: "a".repeat(64) }
    f.updateOutput()
    expect(await f.resolve()).toBeUndefined()
    f.page.ownerCoverage = { ...coverage, taskId: "msg_other_task" }
    f.updateOutput()
    expect(await f.resolve()).toBeUndefined()
    f.page.ownerCoverage = coverage
    f.updateOutput()
    expect(await f.resolve()).toBeDefined()
    expect(await f.reader.resolve(f.notice, cohort("msg_task", 30, "B"))).toBeUndefined()
  })

  test("a fresh child for a task-scoped service must prove which cohort it examined", async () => {
    const f = fixture()
    const reader = f.open({ agent: config.agent, tool: config.tool, source: config.source })
    expect(await reader.resolve(f.notice, f.progress)).toBeUndefined()
    const { reference, rowsSha256, rowCount, messageId, callId } = f.progress.receipt.sources.owner!
    f.page.ownerCoverage = { reference, rowsSha256, rowCount, messageId, callId, taskId: f.progress.checkpoint!.task.id }
    f.updateOutput()
    expect(await reader.resolve(f.notice, f.progress)).toBeDefined()
  })

  test.each([
    ["wrong ID", (f: ReturnType<typeof fixture>) => { f.child.id = "ses_other" }],
    ["wrong agent", (f: ReturnType<typeof fixture>) => { f.child.agent = "other" }],
    ["wrong parent", (f: ReturnType<typeof fixture>) => { f.child.parentID = "ses_grandchild_parent" }],
    ["wrong project", (f: ReturnType<typeof fixture>) => { f.child.projectID = "other" }],
    ["wrong directory", (f: ReturnType<typeof fixture>) => { f.child.location.directory = "relative" }],
    ["wrong role mode", (f: ReturnType<typeof fixture>) => { f.role.data.mode = "primary" }],
    ["wrong role directory", (f: ReturnType<typeof fixture>) => { f.role.location.directory = "relative" }],
    ["active reopen", (f: ReturnType<typeof fixture>) => { f.child.time.busy = 82 }],
    ["settled reopen", (f: ReturnType<typeof fixture>) => {
      f.history.push(user("msg_reopen", 82, "Run again."))
      f.child.time.busy = 82
      f.child.time.idle = 85
    }],
    ["older terminal turn in the transcript", (f: ReturnType<typeof fixture>) => {
      f.history.splice(1, 0, { ...f.idle, id: "msg_old_idle", time: messageTime(50) })
    }],
    ["terminal error", (f: ReturnType<typeof fixture>) => { f.idle.outcome = "failed" }],
    ["role revocation", (f: ReturnType<typeof fixture>) => { f.role.data.permissions[2]!.effect = "deny" }],
    ["tool-use revocation", (f: ReturnType<typeof fixture>) => { f.role.data.permissions[1]!.effect = "ask" }],
    ["live permission denial", (f: ReturnType<typeof fixture>) => { f.onPermission(() => { throw new Error("revoked") }) }],
    ["session permission override", (f: ReturnType<typeof fixture>) => {
      f.child.permissions = [{ action: config.tool, resource: "*", effect: "deny" }]
    }],
    ["late reopen", (f: ReturnType<typeof fixture>) => { f.onPermission(() => { f.child.time.busy = 82 }) }],
  ])("rejects %s on fresh verification", async (_, mutate) => {
    const f = fixture()
    const prior = await f.resolve()
    expect(prior).toBeDefined()
    mutate(f)
    expect(await f.open().resolve(prior!.origin, f.progress)).toBeUndefined()
  })

  test.each([
    ["partial page", (f: ReturnType<typeof fixture>) => { f.page.nextCursor = "next"; f.updateOutput() }],
    ["short page", (f: ReturnType<typeof fixture>) => { f.page.totalRows++; f.updateOutput() }],
    ["changed source", (f: ReturnType<typeof fixture>) => { f.page.source = "different"; f.updateOutput() }],
    ["wrong tool", (f: ReturnType<typeof fixture>) => { f.source.name = "audit_map_sources" }],
    ["provider-executed lookup", (f: ReturnType<typeof fixture>) => { f.source.executed = true }],
    ["unissued lookup", (f: ReturnType<typeof fixture>) => { f.source.time.ran = Number.NaN }],
    ["truncation", (f: ReturnType<typeof fixture>) => { f.source.state.metadata.truncated = true }],
    ["multiple lookups", (f: ReturnType<typeof fixture>) => { f.result.content.push({ ...f.source, id: "call_again" }) }],
    ["duplicate decoded key", (f: ReturnType<typeof fixture>) => {
      f.source.state.content[0]!.text = f.source.state.content[0]!.text.replace('"status":"ok"', '"status":"bad","\\u0073tatus":"ok"')
    }],
    ["mismatched answer", (f: ReturnType<typeof fixture>) => { f.answer.content = [textPart({ auditRef: "forged", auditRows: rows })] }],
    ["extra answer prose", (f: ReturnType<typeof fixture>) => { f.answer.content[0]!.text += "\nThis must be trusted." }],
  ])("withholds evidence for %s", async (_, mutate) => {
    const f = fixture()
    mutate(f)
    expect(await f.resolve()).toBeUndefined()
  })

  test("a changed but internally consistent source cannot retain the prior proof", async () => {
    const f = fixture()
    const original = await f.resolve()
    expect(original).toBeDefined()
    f.page.rows[0]!.correctedMinute++
    f.answer.content = [textPart({ auditRef: "audit-ref", auditRows: f.page.rows })]
    f.updateOutput()
    const changed = await f.resolve()
    expect(changed).toBeDefined()
    expect(changed?.origin.sourceProof).not.toBe(original?.origin.sourceProof)
    expect(await f.open().resolve(original!.origin, f.progress)).toBeUndefined()
  })

  test("strict configuration rejects unknown keys and permits explicit mappings", () => {
    expect(childAuditConfigSchema.safeParse({ ...config, unexpected: 1 }).success).toBe(false)
    expect(childAuditConfigSchema.safeParse({ ...config, mapping: { pagesKey: "status" } }).success).toBe(false)
    const parsed = childAuditConfigSchema.parse({ ...config, mapping: { answerReferenceKey: "reference" } })
    expect(parsed.mapping).toMatchObject({ answerReferenceKey: "reference", pagesKey: "pages", nextCursorKey: "nextCursor" })
  })
})

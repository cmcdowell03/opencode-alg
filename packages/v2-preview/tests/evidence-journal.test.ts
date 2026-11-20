import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { V2InvestigationView } from "../core/investigation.ts"
import type { CalculationPolicy } from "../src/calculation.ts"
import type { DeliveryHistory } from "../src/delivery.ts"
import { DeliveryContext } from "../src/delivery-context.ts"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { EvidenceJournal } from "../src/evidence-journal.ts"

type Message = DeliveryHistory[number]
type Assistant = Extract<Message, { type: "assistant" }>
const time = { created: 1, completed: 2 }
const policy: CalculationPolicy = {
  version: 1,
  owner: { tool: "measure", source: "batch", sourceKey: "source", referenceKey: "ref", reportReferenceField: "sampleRef",
    rowsKey: "rows", offsetKey: "offset", limitKey: "limit", exhaustedKey: "done", limits: [1, 2],
    rowKey: ["id"], qualify: { field: "accepted", equals: true, minMatches: 1 } },
  correction: { header: "Audit", rowsKey: "rows", rowKey: ["id"], referenceKey: "ref", reportReferenceField: "auditRef" },
  operations: { total: { kind: "count" } },
  decisionRules: { field: "total", minimum: 2, whenMet: { nextAction: "review", prerequisite: "sample" },
    otherwise: { nextAction: "hold", prerequisite: "audit" } },
}
const task = (text: string): Message => ({ type: "user", id: ("msg_" + text) as Message["id"], text, time })
const cut = (status: "running" | "completed"): Message => ({
  type: "compaction", status, id: "msg_cut" as Message["id"], reason: "manual", summary: "", time,
})
function page(limit: number): Assistant {
  const data = { source: "batch", ref: "batch-a", offset: 0, limit, done: limit === 2,
    rows: [{ id: 1, accepted: false }, { id: 2, accepted: true }].slice(0, limit) }
  return { type: "assistant", agent: "build" as Assistant["agent"], id: ("msg_p" + limit) as Assistant["id"],
    model: { id: "synthetic", providerID: "synthetic" } as Assistant["model"], finish: "stop", time,
    content: [{ type: "tool", name: "measure", id: "call_" + limit, time,
      state: { status: "completed", input: { source: "batch", offset: 0, limit }, content: [{ type: "text", text: JSON.stringify(data) }] } }] }
}
const decision = {
  decision_revision: 2, procedurePin: { id: "batch", path: ".opencode/skills/batch/SKILL.md", sha256: "1".repeat(64), sourceSha256: "2".repeat(64) },
  decision: { next_action: "review; prerequisite=sample" }, work: { status: "reusable", work_key: "work", manifest_digest: "3".repeat(64) },
} as V2InvestigationView

test("restarted search resumes an exact cut; verification requires a matching decision made after the proof", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alg-evidence-"))
  const journal = (owner = "parent") => new EvidenceJournal(dir, "owner-report", [owner, "approved"])
  try {
    const active = [task("Investigate"), page(1)]
    const first = await journal().observe(policy, [...active, cut("running")], "build", true)
    expect(first.obligation).toMatchObject({ kind: "need_page", nextLimit: 2, rowCount: 1 })
    await journal().acknowledged(policy, first, decision)
    const resume = [cut("completed"), task("Continue.")]
    const recovered = await journal().observe(policy, resume, "build")
    expect(recovered.obligation).toEqual(first.obligation)
    expect((await journal("other").observe(policy, resume, "build")).checkpoint).toBeFalsy()
    const complete = await journal().observe(policy, [...resume, page(2)], "build")
    expect(complete.obligation.kind).toBe("verified")
    const context = { messages: [{ role: "user", content: [{ type: "text", text: "Continue." }] }], system: [] } as unknown as SessionContext
    const delivery = new DeliveryContext()
    delivery.projectProgress(context, complete)
    delivery.projectProgress(context, complete)
    expect(context.messages.filter(m => m.content.some(p => p.type === "text" &&
      p.text.startsWith("ALG calculated evidence (source data)")))).toHaveLength(1)
    expect((await journal().report(policy, complete, decision)).status).toBe("provisional")
    await journal().acknowledged(policy, complete, decision)
    expect(await journal().report(policy, complete, decision)).toMatchObject({
      status: "verified", fields: { total: 2, sampleRef: "batch-a", nextAction: "review", prerequisite: "sample" },
    })
    expect((await journal().report(policy, complete, { ...decision, decision_revision: 3 })).status).toBe("provisional")
    expect((await journal().observe(policy, [...resume, task("Different task")], "build")).checkpoint).toBeFalsy()
    await expect(journal().observe(policy, [...active, page(2), cut("running")], "build", true))
      .rejects.toThrow("EVIDENCE_BOUNDARY_CHANGED")
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("compaction before the first lookup preserves a dormant task without directing unrelated work", async () => {
  const dir = await mkdtemp(join(tmpdir(), "alg-before-evidence-"))
  const journal = () => new EvidenceJournal(dir, "owner-report", ["approved"])
  try {
    await journal().observe(policy, [task("Investigate"), cut("running")], "build", true)
    const next = [cut("completed"), task("Continue.")]
    expect((await journal().observe(policy, next, "build")).checkpoint).toBeFalsy()
    expect((await journal().observe(policy, [...next, page(1)], "build")).obligation)
      .toMatchObject({ kind: "need_page", nextLimit: 2 })
  } finally { await rm(dir, { recursive: true, force: true }) }
})

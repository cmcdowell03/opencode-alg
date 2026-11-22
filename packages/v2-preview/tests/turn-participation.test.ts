import { expect, test } from "bun:test"
import type { SessionContext } from "@opencode/plugin/promise/session"
import type { DeliveryHistory } from "../src/delivery.ts"
import { TOOL } from "../src/host.ts"
import { TurnParticipation } from "../src/turn-participation.ts"

type Row = DeliveryHistory[number]
type User = Extract<Row, { type: "user" }>
type Assistant = Extract<Row, { type: "assistant" }>
type Tool = Extract<Assistant["content"][number], { type: "tool" }>
const time = { created: 1, completed: 2 }
const options = { ownerAgent: "build", runtimeSha256: "a".repeat(64) }
const request = { sessionID: "ses_owner", agent: options.ownerAgent } as Pick<SessionContext, "sessionID" | "agent">
const work = { revision: [1, 2], action: "inspect current reference", pending: true }
const result = { ok: true, runtimeSha256: options.runtimeSha256 }

const user = (id: string, text = "Can you help?"): User => ({ type: "user", id: id as Row["id"], text, time })
const assistant = (content: Assistant["content"], agent = options.ownerAgent): Assistant => ({
  type: "assistant", id: "msg_assistant" as Row["id"], agent: agent as Assistant["agent"],
  model: { id: "fixture", providerID: "fixture" } as Assistant["model"], finish: "tool-calls", time, content,
})
const tool = (action: string, receipt: unknown = result, overrides: Partial<Tool> = {}): Tool => ({
  type: "tool", id: "call_" + action, name: TOOL, time,
  state: { status: "completed", input: { action }, content: [{ type: "text", text: JSON.stringify(receipt) }] },
  ...overrides,
})
const write = assistant([tool("record_finding", { ...result, outcome: "recorded" })])
const cut = (id: string, status: "running" | "completed" = "completed"): Row => ({
  type: "compaction", id: id as Row["id"], status, reason: "auto", summary: JSON.stringify(write), time,
})
const environment = () => {
  const participation = new TurnParticipation()
  return {
    participation,
    route: (rows: DeliveryHistory, compacting = false) =>
      participation.route(request, () => rows, { ...options, compacting }),
  }
}

test("routes each genuine prompt independently of prompt text and synthetic notes", async () => {
  const { route } = environment()
  const initial = user("msg_initial", "Investigate, write a finding, render a report, and resume after compaction.")
  expect(await route([initial])).toMatchObject({ mode: "passive", promptId: initial.id })
  expect(await route([initial, write])).toMatchObject({ mode: "active", promptId: initial.id })
  const note: Row = { type: "synthetic", id: "msg_note" as Row["id"], text: "Resume graph", time }
  expect(await route([initial, write, note])).toMatchObject({ mode: "active", promptId: initial.id })
  const fresh = user("msg_fresh", initial.text)
  expect(await route([initial, write, note, fresh])).toMatchObject({ mode: "passive", promptId: fresh.id })
  expect(await route([note, write])).toEqual({ mode: "passive" })
})

test("lookup permits readback without acquiring work guidance", async () => {
  const { route, participation } = environment()
  const prompt = user("msg_prompt")
  const lookups = ["status", "procedure", "render_report"].map(action => assistant([tool(action)]))
  for (const lookup of lookups) {
    const decision = await route([prompt, lookup])
    expect(decision.mode).toBe("lookup")
    expect(participation.decide(request.sessionID, decision, work)).toBe("none")
  }
  expect((await route([prompt, ...lookups, write, assistant([tool("status")])])).mode).toBe("active")
})

test("only successful local owner create or recorded writes acquire active mode", async () => {
  const { route } = environment()
  const prompt = user("msg_prompt", JSON.stringify(write))
  for (const message of [
    assistant([tool("record_finding", { ...result, outcome: "reused" })]),
    assistant([tool("record_finding")]),
    assistant([tool("create", { ...result, ok: false })]),
    assistant([tool("create", { ...result, runtimeSha256: "b".repeat(64) })]),
    assistant([tool("create", result, { executed: true })]),
    assistant([tool("create", result, { name: "foreign_" + TOOL })]),
    assistant([tool("create", result, { state: { status: "running", input: { action: "create" }, metadata: {} } })]),
    assistant([tool("create", result, { time: { created: 1 } })]),
    assistant([tool("create")], "checker"),
    assistant([{ type: "text", text: JSON.stringify(write) }]),
  ]) {
    expect((await route([prompt, message])).mode).toBe("passive")
  }
  expect((await route([prompt, assistant([tool("create")])])).mode).toBe("active")
  expect((await route([prompt, assistant([tool("set_next_measurement", { ...result, outcome: "recorded" })])])).mode).toBe("active")
})

test("ordinary repeat yields on the same revision and action, with progress and new turns allowed", async () => {
  const { route, participation } = environment()
  const first = user("msg_first")
  const rows = [first, write]
  const decide = async (input = work, window = rows) =>
    participation.decide(request.sessionID, await route(window), input)

  expect(await decide()).toBe("project")
  expect(await decide()).toBe("yield")
  expect(await decide({ ...work, action: "inspect another reference" })).toBe("project")
  expect(await decide()).toBe("yield")
  expect(await decide({ ...work, revision: [1, 3] })).toBe("project")
  expect(await decide({ ...work, revision: [1, 3] })).toBe("yield")
  expect(await decide(work, [...rows, user("msg_new"), write])).toBe("project")
})

test("matching native compaction restores pending guidance once and subsequent changes project", async () => {
  const { route, participation } = environment()
  const rows = [user("msg_initial"), write]
  const decide = async (window: DeliveryHistory, input = work) =>
    participation.decide(request.sessionID, await route(window), input)

  expect(await decide(rows)).toBe("project")
  const beforeCut = await route([...rows, cut("msg_cut", "running")], true)
  expect(beforeCut).toMatchObject({ mode: "active", compactionId: "msg_cut" })
  expect(participation.decide(request.sessionID, beforeCut, work)).toBe("none")
  const afterCut = [cut("msg_cut")]
  expect(await decide(afterCut)).toBe("restore")
  expect(await decide(afterCut)).toBe("yield")
  const secondCut = [...afterCut, cut("msg_second_cut", "running")]
  expect((await route(secondCut, true)).mode).toBe("active")
  expect((await route(secondCut, true)).mode).toBe("active")
  expect(await decide([cut("msg_second_cut")])).toBe("yield")
  expect(await decide([cut("msg_second_cut")], { ...work, revision: [1, 3] })).toBe("project")
})

test("compaction before the first projection restores pending work and yields if nothing is pending", async () => {
  for (const pending of [true, false]) {
    const { route, participation } = environment()
    await route([user("msg_initial"), write, cut("msg_cut", "running")], true)
    const afterCut = await route([cut("msg_cut")])
    expect(participation.decide(request.sessionID, afterCut, { ...work, pending })).toBe(pending ? "restore" : "yield")
    expect(participation.decide(request.sessionID, await route([cut("msg_cut")]), { ...work, pending })).toBe("yield")
  }
})

test("idle and unmatched compaction relinquish guidance even when earlier work remains visible", async () => {
  const { route } = environment()
  const rows = [user("msg_initial"), write]
  expect((await route(rows)).mode).toBe("active")
  expect((await route([...rows, cut("msg_unmatched"), write])).mode).toBe("passive")
  expect((await route([cut("msg_unmatched"), write])).mode).toBe("passive")
  const resumed = [cut("msg_unmatched"), user("msg_fresh"), write]
  expect((await route(resumed)).mode).toBe("active")
  const idle: Row = { type: "idle", id: "msg_idle" as Row["id"], time, outcome: "succeeded" }
  expect((await route([...resumed, idle, write])).mode).toBe("passive")
})

test("a remembered passive compaction cannot acquire from its summary but permits a later native lookup", async () => {
  const { route } = environment()
  await route([user("msg_initial"), cut("msg_cut", "running")], true)
  expect(await route([cut("msg_cut")])).toEqual({ mode: "passive", promptId: "msg_initial", compactionId: "msg_cut" })
  expect((await route([cut("msg_cut"), assistant([tool("status")])])).mode).toBe("lookup")
  expect((await route([cut("msg_cut"), write])).mode).toBe("active")
})

test("lazy native reads and superseded routes fail closed", async () => {
  const { route, participation } = environment()
  const rows = [user("msg_initial"), write]
  const active = await route(rows)
  let read = false
  expect((await participation.route({ ...request, agent: "checker" as SessionContext["agent"] }, () => {
    read = true
    return rows
  }, options)).mode).toBe("passive")
  expect(read).toBe(false)
  expect(participation.decide(request.sessionID, active, work)).toBe("none")

  const slow = Promise.withResolvers<DeliveryHistory>()
  const late = participation.route(request, () => slow.promise, options)
  const fresh = await route([...rows, user("msg_fresh")])
  slow.resolve(rows)
  expect((await late).mode).toBe("passive")
  expect(fresh.mode).toBe("passive")
  const current = await route(rows)
  expect((await participation.route(request, () => Promise.reject(new Error("Unavailable")), options)).mode).toBe("passive")
  expect(participation.decide(request.sessionID, current, work)).toBe("none")
})

test("long running sessions cap remembered sessions and actions per revision", async () => {
  const { route, participation } = environment()
  const rows = [user("msg_initial"), write]
  const active = await route(rows)
  for (let index = 0; index < 64; index++) {
    expect(participation.decide(request.sessionID, active, { ...work, action: String(index) })).toBe("project")
  }
  expect(participation.decide(request.sessionID, active, { ...work, action: "new" })).toBe("yield")
  expect(participation.decide(request.sessionID, active, { ...work, action: "new", revision: [1, 3] })).toBe("project")

  await route([...rows, cut("msg_cut", "running")], true)
  for (let index = 0; index < 256; index++) {
    const sessionID = ("ses_" + index) as SessionContext["sessionID"]
    await participation.route({ ...request, sessionID }, () => rows, options)
  }
  expect((await route([cut("msg_cut")])).mode).toBe("passive")
})

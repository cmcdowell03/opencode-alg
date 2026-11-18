import { describe, expect, test } from "bun:test"
import { sendBenchmarkPrompt, type BenchmarkApi } from "../scripts/build-benchmark-transport.ts"

const promptBody = { parts: [{ type: "text", text: "synthetic benchmark prompt" }] }
const oldUser = { info: { id: "user-old", sessionID: "session-1", role: "user", time: { created: 1 } }, parts: [] }
const oldAssistant = { info: { id: "assistant-old", sessionID: "session-1", role: "assistant", parentID: "user-old", time: { created: 2, completed: 3 }, finish: "stop" }, parts: [] }
const newUser = { info: { id: "user-new", sessionID: "session-1", role: "user", time: { created: 10 } }, parts: [] }

describe("OpenCode async prompt transport", () => {
  test("does not accept a summary as the answer or a length stop as successful completion", async () => {
    let polls=0
    const summary={info:{id:"summary",role:"assistant",sessionID:"session-1",parentID:"user-new",summary:true,time:{completed:20},finish:"stop"},parts:[]}
    const clipped={info:{id:"clipped",role:"assistant",sessionID:"session-1",parentID:"user-new",time:{completed:30},finish:"length"},parts:[]}
    const api:BenchmarkApi=async path=>{
      if(path.endsWith("/prompt_async"))return null
      polls++
      return polls===1?[]:polls===2?[newUser,summary]:[newUser,summary,clipped]
    }
    const result=await sendBenchmarkPrompt({api,sessionID:"session-1",body:promptBody,deadline:Date.now()+2000,cancelled:()=>null,pollIntervalMs:1})
    expect(result).toMatchObject({status:"incomplete",finish:"length"})
    expect(polls).toBe(3)
  })

  test("distinguishes a post-dispatch poll error and never resubmits", async () => {
    let polls=0,submissions=0
    const api:BenchmarkApi=async path=>{
      if(path.endsWith("/prompt_async")){submissions++;return null}
      if(++polls===1)return []
      throw Error("synthetic transport loss")
    }
    const result=await sendBenchmarkPrompt({api,sessionID:"session-1",body:promptBody,deadline:Date.now()+2000,cancelled:()=>null})
    expect(result.status).toBe("poll_error")
    expect(submissions).toBe(1)
  })

  test("does not treat prompt_async acknowledgement as completion and reaches deadline with no new root", async () => {
    const calls: Array<{ path: string; body?: unknown; ms?: number }> = []
    const api: BenchmarkApi = async (path, body, ms) => {
      calls.push({ path, body, ms })
      if (path.endsWith("/prompt_async")) return null // OpenCode 204 acknowledgement
      return [oldUser, oldAssistant]
    }
    const deadline = Date.now() + 90
    const result = await sendBenchmarkPrompt({ api, sessionID: "session-1", body: promptBody, deadline, cancelled: () => null, pollIntervalMs: 10 })
    expect(result.status).toBe("deadline")
    expect(calls.filter(call => call.path.endsWith("/prompt_async"))).toHaveLength(1)
    expect(calls.filter(call => call.path.endsWith("/message")).length).toBeGreaterThan(1)
    expect(calls.every(call => call.ms !== undefined && call.ms <= 15_000 && call.ms <= Math.max(0, deadline - Date.now()) + 100)).toBe(true)
  })

  test("ignores old messages and tool-calls intermediary, then accepts reasoning-only completed assistant", async () => {
    let messagePoll = 0
    const calls: Array<{ path: string; body?: unknown; ms?: number }> = []
    const intermediate = {
      info: { id: "assistant-tool", sessionID: "session-1", role: "assistant", parentID: "user-new",
        time: { created: 11, completed: 12 }, finish: "tool-calls" },
      parts: [{ type: "tool", state: { status: "completed" } }],
    }
    const final = {
      info: { id: "assistant-final", sessionID: "session-1", role: "assistant", parentID: "user-new",
        time: { created: 13, completed: 14 }, finish: "stop" },
      parts: [{ type: "reasoning", text: "completed without a text part" }],
    }
    const api: BenchmarkApi = async (path, body, ms) => {
      calls.push({ path, body, ms })
      if (path.endsWith("/prompt_async")) return null
      messagePoll++
      if (messagePoll === 1) return [oldUser, oldAssistant]
      if (messagePoll === 2) return [oldUser, oldAssistant, newUser, intermediate]
      return [oldUser, oldAssistant, newUser, intermediate, final]
    }
    const result = await sendBenchmarkPrompt({ api, sessionID: "session-1", body: promptBody,
      deadline: Date.now() + 2_000, cancelled: () => null, pollIntervalMs: 2 })
    expect(result.status).toBe("completed")
    if (result.status !== "completed") return
    expect(result.userMessageID).toBe("user-new")
    expect(result.assistant.info?.id).toBe("assistant-final")
    expect(result.assistant.parts).toEqual(final.parts)
    expect(messagePoll).toBe(3)
    expect(calls.find(call => call.path.endsWith("/prompt_async"))?.body).toBe(promptBody)
  })

  test("returns matching model errors as terminal failures", async () => {
    const modelError = { name: "ProviderAuthError", data: { message: "synthetic model error" } }
    let polls = 0
    const api: BenchmarkApi = async path => {
      if (path.endsWith("/prompt_async")) return null
      polls++
      if (polls === 1) return [oldUser, oldAssistant]
      return [oldUser, oldAssistant, newUser, {
        info: { id: "assistant-error", sessionID: "session-1", role: "assistant", parentID: "user-new", error: modelError },
        parts: [],
      }]
    }
    const result = await sendBenchmarkPrompt({ api, sessionID: "session-1", body: promptBody,
      deadline: Date.now() + 1_000, cancelled: () => null, pollIntervalMs: 1 })
    expect(result.status).toBe("model_error")
    if (result.status === "model_error") expect(result.error).toEqual(modelError)
  })

  test("stops after cancellation is observed during a poll", async () => {
    let cancelled = false
    let messagePolls = 0
    let dispatched = 0
    const api: BenchmarkApi = async path => {
      if (path.endsWith("/prompt_async")) { dispatched++; return null }
      messagePolls++
      if (messagePolls === 1) return [oldUser, oldAssistant]
      cancelled = true
      return [oldUser, oldAssistant, newUser]
    }
    const result = await sendBenchmarkPrompt({ api, sessionID: "session-1", body: promptBody,
      deadline: Date.now() + 2_000, cancelled: () => cancelled ? "stopReason: operator cancellation" : null, pollIntervalMs: 1 })
    expect(result).toMatchObject({ status: "cancelled", reason: "stopReason: operator cancellation" })
    expect(dispatched).toBe(1)
    expect(messagePolls).toBe(2)
  })
})

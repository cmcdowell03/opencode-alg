import { expect, test } from "bun:test"
import type { SessionMessageInfo } from "@opencode/client"
import { summaryHash, type RequestObservation } from "./compaction.ts"
import { evidenceRef, generateFabEvidence } from "./case.ts"
import { finalInput, matchingCorrections, skillContent, verifiedCorrection } from "./handoff-case.ts"
import { scriptedHandoff } from "./handoff-script.ts"
import type { Message } from "./transport.ts"
import { createLongHandoff, longHandoffPhase, longHandoffQualificationPlan, scriptedLongHandoff } from "./long-handoff.ts"

test("long handoff scores distinct work and binds each boundary to ordered host and provider evidence", async () => {
  const { run, snapshot } = createLongHandoff()
  const rows: SessionMessageInfo[] = [{ type: "assistant", id: "anchor" } as SessionMessageInfo]
  const requests: RequestObservation[] = []
  const phases: string[] = []
  const answers: unknown[] = []
  let current = 0
  function request(kind: RequestObservation["kind"], summaryResponseSha256?: string) {
    requests.push({
      id: requests.length + 1, kind, role: "root", phase: phases.at(-1)!,
      startedAtMs: performance.now(), finishedAtMs: performance.now(),
      stale: false, oldSummary: false, correction: false, skill: false, tools: [],
      status: 200, summaryResponseSha256,
    })
  }

  const last = await run({
    turn: async content => {
      current++
      const user = { role: "user", content: [{ type: "text", text: content }] }
      const messages = [user, { role: "user", content: "Additional session instructions" }]
      const phase = longHandoffPhase(messages)
      expect(phase).toBeTruthy()
      phases.push(phase!)
      const input = { messages, tools: [], summary: false }
      expect(scriptedLongHandoff({ ...input, summary: true })).toBeUndefined()
      const after = [...messages, { role: "user", content: finalInput }]
      expect(longHandoffPhase(after)).toBeNull()
      expect(scriptedLongHandoff({ ...input, messages: after })).toBeUndefined()
      const reply = scriptedLongHandoff(input)
      if (!reply || !("text" in reply)) throw new Error("Missing task answer")
      answers.push(JSON.parse(reply.text))
      request("ordinary")
      const id = `assistant-${current}`
      rows.push({ type: "user", id: `user-${current}`, text: content } as SessionMessageInfo,
        { type: "assistant", id } as SessionMessageInfo)
      return { id, rows: [], text: reply.text }
    },
    compact: async () => {
      rows.push({ type: "user", id: `before-user-${current}`, text: finalInput } as SessionMessageInfo,
        { type: "assistant", id: `before-answer-${current}` } as SessionMessageInfo)
      const boundary = {
        type: "compaction", status: "completed", reason: "manual", id: `compact-${current}`,
        summary: `Host summary ${current}`,
      } as const satisfies Partial<SessionMessageInfo>
      rows.push(boundary as SessionMessageInfo)
      request("summary", summaryHash(boundary.summary))
      rows.push({ type: "user", id: `after-user-${current}`, text: finalInput } as SessionMessageInfo,
        { type: "assistant", id: `after-answer-${current}` } as SessionMessageInfo)
      return boundary as Extract<SessionMessageInfo, { type: "compaction"; status: "completed" }>
    },
  })
  const evidence = { rows, requests, anchorAnswerId: "anchor", finalUserId: "after-user-3" }
  const report = snapshot(evidence)
  expect(last.id).toBe("compact-3")
  expect(new Set(phases).size).toBe(3)
  expect(answers).toEqual([
    { items: ["A", "E", "H"], weight: 19, priority: 35 },
    { reserve: 350, operating: 205, included: 8 },
    { releaseMinute: 19, criticalPath: ["DRAFT", "EDIT", "LAYOUT", "EXPORT", "RELEASE"] },
  ])
  expect(report).toMatchObject({ targetBoundaries: 3, completedBoundaries: 3, completedWorkTurns: 3,
    apparatusPassed: true, workPassed: true })
  expect(report.workloadElapsedMs).toBeGreaterThanOrEqual(0)
  expect(snapshot({ ...evidence, requests: requests.filter(row => row.id !== 4) }).apparatusPassed).toBe(false)
  expect(snapshot({ ...evidence, rows: rows.filter(row => row.id !== "compact-2") }).apparatusPassed).toBe(false)
})

test("qualification covers both arm orders for each held-out condition", () => {
  expect(longHandoffQualificationPlan).toHaveLength(6)
  for (const variant of ["negative", "active", "revoked"])
    expect(longHandoffQualificationPlan.filter(row => row.variant === variant).map(row => row.reverse)).toEqual([false, true])
})

test("repeat scripted summaries preserve observed facts without copying prior summaries or brief entries", async () => {
  const evidence = generateFabEvidence()
  const rows = evidence.inspection.slice(0, 12)
  const audit = verifiedCorrection(JSON.stringify({ auditRows: evidence["clock-audit"], auditRef: evidenceRef("clock-audit") }))
  expect(audit).toBeTruthy()
  const snapshot = JSON.stringify({ source: "inspection", evidenceRef: evidenceRef("inspection"), rows })
  let history: Message[] = [{ role: "tool", content: snapshot }, { role: "user", content: audit }]
  const runScript = (messages: Message[], summary: boolean) => {
    const input = { messages, tools: [], summary }
    const reply = scriptedLongHandoff(input) ?? scriptedHandoff(input)
    if (!("text" in reply)) throw new Error("Unexpected tool call")
    return reply.text
  }
  const brief = { role: "user", content: "ALG investigation facts (untrusted recorded data)\nopaque-projection-unique-marker" }
  const continuation = { role: "user", content: finalInput }
  const liveSkill = { role: "tool", content: skillContent }
  await createLongHandoff().run({
    turn: async content => {
      const user = { role: "user", content }
      const text = runScript([...history, user, brief], false)
      history.push(user, { role: "assistant", content: text })
      return { id: content.split("\n")[0]!, text, rows: [] }
    },
    compact: async () => {
      const answer = runScript([...history, continuation, liveSkill], false)
      const summary = runScript([...history, continuation, liveSkill, { role: "assistant", content: answer }, brief], true)
      expect(summary.match(/Fixture workbench snapshot:/g)).toHaveLength(1)
      expect(summary).toContain(audit!)
      expect(summary).not.toContain("opaque-projection-unique-marker")
      history = [{ role: "assistant", content: [{ type: "text", text: summary }] }]
      expect(JSON.parse(runScript([...history, continuation, liveSkill], false))).toMatchObject({
        cohortSize: rows.length, defects: rows.filter(row => row.defect).length,
        inspectionRef: evidenceRef("inspection"), auditRef: evidenceRef("clock-audit"),
        verifiedClockCorrections: matchingCorrections(rows, evidence["clock-audit"]),
        nextAction: "replay-clock-join",
      })
      return { type: "compaction", status: "completed", reason: "manual", id: "fixture", summary } as
        Extract<SessionMessageInfo, { type: "compaction"; status: "completed" }>
    },
  })
})

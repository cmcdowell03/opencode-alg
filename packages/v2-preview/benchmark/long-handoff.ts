import type { SessionMessageInfo } from "@opencode/client"
import { toolCalls } from "../acceptance/host.ts"
import { sha256 } from "../acceptance/runtime.ts"
import { summaryHash, type RequestObservation } from "./compaction.ts"
import { handoffUserPhase, jsonObject } from "./handoff-case.ts"
import type { Turn } from "./host.ts"
import { textOf, type Completion, type Message, type TurnInput } from "./transport.ts"

type Answer = Record<string, number | string[]>

function task<T>(id: string, instructions: string, rows: T, solve: (rows: T) => Answer) {
  const prompt = [
    `[long-handoff:${id}]`,
    "Complete this separate, self-contained desk task using only the data in this message. Do not call tools.",
    instructions,
    "Return only the requested JSON object.",
    JSON.stringify(rows),
  ].join("\n")
  return { id, prompt, solve: () => solve(rows) }
}

const tasks = [
  task("packing", "Each row is [item ID, weight, priority]. Choose exactly three items weighing at most 19 in total. Maximize total priority, then minimize total weight, then choose the lexicographically first ascending ID list. Return items (IDs in ascending order), weight, and priority.",
    [
      ["A", 3, 4], ["B", 6, 11], ["C", 8, 15], ["D", 4, 6], ["E", 9, 17],
      ["F", 5, 9], ["G", 3, 3], ["H", 7, 14], ["I", 2, 3], ["J", 10, 18],
    ] as const, rows => {
      let best = { items: [] as string[], weight: Infinity, priority: -Infinity }
      for (const [i, a] of rows.entries()) {
        for (const [j, b] of rows.slice(i + 1).entries()) {
          for (const c of rows.slice(i + j + 2)) {
            const weight = a[1] + b[1] + c[1]
            const priority = a[2] + b[2] + c[2]
            if (weight <= 19 && (priority > best.priority || (priority === best.priority && weight < best.weight)))
              best = { items: [a[0], b[0], c[0]], weight, priority }
          }
        }
      }
      return best
    }),
  task("portfolio", "Each row is [record ID, fund, signed amount, status]. Ignore void rows and count an exact duplicate only once. Sum amounts by fund. Return reserve (the Reserve balance), operating (the Operating balance), and included (the number of records used).",
    [
      ["K1", "Reserve", 420, "posted"], ["K2", "Operating", 310, "posted"],
      ["K3", "Reserve", -85, "posted"], ["K4", "Operating", -19, "void"],
      ["K5", "Operating", -76, "posted"], ["K2", "Operating", 310, "posted"],
      ["K6", "Reserve", 44, "posted"], ["K7", "Operating", 12, "posted"],
      ["K3", "Reserve", -85, "posted"], ["K8", "Reserve", -61, "void"],
      ["K9", "Reserve", -29, "posted"], ["K10", "Operating", -41, "posted"],
    ] as const, rows => {
      const answer = { reserve: 0, operating: 0, included: 0 }
      const seen = new Set<string>()
      for (const row of rows) {
        const [, fund, amount, status] = row
        const key = JSON.stringify(row)
        if (status === "void" || seen.has(key)) continue
        seen.add(key)
        answer[fund === "Reserve" ? "reserve" : "operating"] += amount
        answer.included++
      }
      return answer
    }),
  task("publishing", "Each row is [asset ID, duration in minutes, prerequisite IDs]. There are unlimited workers and work starts as soon as every prerequisite finishes. Return releaseMinute (earliest finish of RELEASE) and criticalPath (from the first asset through RELEASE, including both).",
    [
      ["RELEASE", 2, ["INDEX", "EXPORT", "LEGAL"]],
      ["EDIT", 5, ["DRAFT"]], ["EXPORT", 5, ["LAYOUT", "LEGAL"]],
      ["DRAFT", 4, []], ["ART", 7, []], ["LAYOUT", 3, ["EDIT", "ART"]],
      ["LEGAL", 4, ["DRAFT"]], ["INDEX", 3, ["EDIT"]], ["NOTES", 6, ["ART"]],
    ] as const, rows => {
      const assets = new Map<string, readonly [string, number, readonly string[]]>(rows.map(row => [row[0], row]))
      function finish(id: string): { minute: number; path: string[] } {
        const [, duration, prerequisites] = assets.get(id)!
        const critical = prerequisites.map(finish).sort((a, b) => b.minute - a.minute)[0]
        return { minute: duration + (critical?.minute ?? 0), path: [...(critical?.path ?? []), id] }
      }
      const release = finish("RELEASE")
      return { releaseMinute: release.minute, criticalPath: release.path }
    }),
]

function messageText(message: Message) {
  const content = message.content
  return Array.isArray(content) ? content.map(item => item?.type === "text" ? item.text : "").join("\n") : textOf(content)
}

function currentTask(messages: Message[]) {
  for (const message of messages.slice().reverse()) {
    if (message.role !== "user") continue
    const text = messageText(message)
    const entry = tasks.find(item => text.trimStart().startsWith(`[long-handoff:${item.id}]\n`))
    if (entry) return { entry, text }
    if (handoffUserPhase(message)) return null
  }
  return null
}

/** Classify these requests as root traffic before falling back to classifyHandoff. */
export function longHandoffPhase(messages: Message[]) {
  const current = currentTask(messages)
  return current ? `long-handoff:${current.entry.id}` : null
}

/** Delegate summaries and all original handoff turns to the existing script. */
export function scriptedLongHandoff(input: TurnInput): Completion | undefined {
  if (input.summary) return
  const current = currentTask(input.messages)
  if (current && current.text.trim() === current.entry.prompt)
    return { text: JSON.stringify(current.entry.solve()), reason: `long-handoff:${current.entry.id}` }
}

const counterbalanced = [false, true] as const
export const longHandoffQualificationPlan = [
  ...counterbalanced.map(reverse => ({ driver: "benchmark", variant: "negative", reverse } as const)),
  ...(["active", "revoked"] as const).flatMap(variant => counterbalanced.map(reverse =>
    ({ driver: "handoff", variant, extended: true, reverse } as const))),
]

type Boundary = Extract<SessionMessageInfo, { type: "compaction"; status: "completed" }>
type Round = {
  task: typeof tasks[number]
  turnStartedAtMs: number
  turn?: Turn
  turnObservedAtMs?: number
  compactCallbackStartedAtMs?: number
  boundary?: Boundary
  compactCallbackReturnedAtMs?: number
}

function correctAnswer(answer: ReturnType<typeof jsonObject>, expected: Answer) {
  return !!answer && Object.keys(answer).length === Object.keys(expected).length &&
    Object.entries(expected).every(([field, value]) => JSON.stringify(answer[field]) === JSON.stringify(value))
}

/** Use one instance per arm, after the correction and before the neutral continuation. */
export function createLongHandoff() {
  const rounds: Round[] = []

  async function run(hooks: {
    turn: (input: string) => Promise<Turn>
    compact: () => Promise<Boundary>
  }): Promise<Boundary> {
    if (rounds.length) throw new Error("Long handoff already started")
    let latest: Boundary | undefined
    for (const task of tasks) {
      const round: Round = { task, turnStartedAtMs: performance.now() }
      rounds.push(round)
      round.turn = await hooks.turn(task.prompt)
      round.turnObservedAtMs = performance.now()
      round.compactCallbackStartedAtMs = performance.now()
      latest = await hooks.compact()
      round.boundary = latest
      round.compactCallbackReturnedAtMs = performance.now()
    }
    return latest!
  }

  function snapshot(input: {
    rows: readonly SessionMessageInfo[] | null
    requests: readonly RequestObservation[]
    anchorAnswerId: string | undefined
    finalUserId: string | undefined
  }) {
    const rows = input.rows ?? []
    const indexOf = (id: string | undefined, type: SessionMessageInfo["type"]) =>
      rows.findIndex(row => row.id === id && row.type === type)
    const anchor = indexOf(input.anchorAnswerId, "assistant")
    const final = indexOf(input.finalUserId, "user")
    let preceding = anchor

    const steps = rounds.map(round => {
      const { id, prompt } = round.task
      const user = rows.findIndex(row => row.type === "user" && row.text === prompt)
      const answer = indexOf(round.turn?.id, "assistant")
      const boundary = indexOf(round.boundary?.id, "compaction")
      const ordered = preceding >= 0 && preceding < user && user < answer && answer < boundary && boundary < final
      preceding = boundary
      const summarySha256 = round.boundary?.summary ? summaryHash(round.boundary.summary) : null
      const turnRequests = input.requests.filter(request => request.kind === "ordinary" && request.role === "root" &&
        request.phase === `long-handoff:${id}` && request.startedAtMs >= round.turnStartedAtMs &&
        request.finishedAtMs !== null && request.finishedAtMs <= (round.turnObservedAtMs ?? -Infinity))
      const summaryRequests = input.requests.filter(request => request.kind === "summary" && request.role === "root" &&
        request.startedAtMs >= (round.compactCallbackStartedAtMs ?? Infinity) &&
        request.finishedAtMs !== null && request.finishedAtMs <= (round.compactCallbackReturnedAtMs ?? -Infinity))
      const observedAnswer = round.turn ? jsonObject(round.turn.text) : undefined
      const tools = toolCalls(round.turn?.rows ?? []).map(call => call.name)
      return {
        task: id, promptSha256: sha256(prompt), promptBytes: Buffer.byteLength(prompt),
        userId: rows[user]?.id ?? null, answerId: round.turn?.id ?? null, answer: observedAnswer ?? null,
        boundaryId: round.boundary?.id ?? null, summarySha256, tools,
        turnStartedAtMs: round.turnStartedAtMs, turnObservedAtMs: round.turnObservedAtMs ?? null,
        compactCallbackStartedAtMs: round.compactCallbackStartedAtMs ?? null, compactCallbackReturnedAtMs: round.compactCallbackReturnedAtMs ?? null,
        turnRequestIds: turnRequests.map(request => request.id), summaryRequestIds: summaryRequests.map(request => request.id),
        checks: {
          ordered,
          providerTurn: turnRequests.some(request => request.status === 200),
          noToolCalls: !!round.turn && tools.length === 0,
          manualSummary: round.boundary?.reason === "manual" && !!summarySha256 &&
            summaryRequests.length === 1 && summaryRequests[0]?.status === 200 &&
            summaryRequests[0].summaryResponseSha256 === summarySha256,
          answerCorrect: correctAnswer(observedAnswer, round.task.solve()),
        },
      }
    })
    const boundaries = new Set(steps.flatMap(step => step.boundaryId ? [step.boundaryId] : []))
    const observedBoundaries = rows.slice(anchor + 1, final < 0 ? undefined : final)
      .filter(row => row.type === "compaction")
    const shapePassed = steps.length === tasks.length && boundaries.size === tasks.length && anchor >= 0 && final >= 0 &&
      observedBoundaries.length === tasks.length && observedBoundaries.every(row =>
        row.type === "compaction" && row.status === "completed" && row.reason === "manual" && boundaries.has(row.id))
    const startedAtMs = rounds[0]?.turnStartedAtMs ?? null
    const finishedAtMs = rounds.at(-1)?.compactCallbackReturnedAtMs ?? null
    return {
      targetBoundaries: tasks.length,
      completedBoundaries: boundaries.size,
      completedWorkTurns: steps.filter(step => step.answerId).length,
      // Measured only from first intervening turn submission through the last callback return, including any neutral decisions inside it.
      workloadElapsedMs: startedAtMs !== null && finishedAtMs !== null ? finishedAtMs - startedAtMs : null,
      apparatusPassed: shapePassed && steps.every(step =>
        step.checks.ordered && step.checks.providerTurn && step.checks.noToolCalls && step.checks.manualSummary),
      workPassed: steps.length === tasks.length && steps.every(step => step.checks.answerCorrect),
      steps,
    }
  }

  return { run, snapshot }
}

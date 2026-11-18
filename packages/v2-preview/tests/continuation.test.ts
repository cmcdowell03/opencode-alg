import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { join } from "node:path"
import { waitFor } from "../acceptance/runtime.ts"
import { createOwnerContinuation, type OwnerContinuationOptions } from "../src/continuation.ts"

type Owner = Awaited<ReturnType<OwnerContinuationOptions["owner"]>>
type View = ReturnType<OwnerContinuationOptions["primary"]>
type Synthetic = Parameters<OwnerContinuationOptions["session"]["synthetic"]>[0]
type Idle = Parameters<ReturnType<typeof createOwnerContinuation>["onIdle"]>[0]
const ownerID = "ses_owner" as Idle["sessionID"]
const otherID = "ses_other" as Idle["sessionID"]
const work = "a".repeat(64)
const manifest = "b".repeat(64)
const running = { work: { work_key: work, status: "running" } } as const
const result = { work: { work_key: work, status: "result_recorded", manifest_digest: manifest } } as const
const evidence = {
  work_key: work, manifest_digest: manifest,
  read_receipt: "a8124f15-1927-40b2-9de6-a7359b5ea554",
  result: "pass",
} as const
const dirs: string[] = []
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function fixture() {
  const directory = await mkdtemp(join(import.meta.dir, ".continuation-"))
  dirs.push(directory)
  let view: View = null
  let read: OwnerContinuationOptions["checkerEvidence"] = async () => undefined
  let session: Owner = {
    projectID: "project",
    id: ownerID,
    location: { directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    outcome: "succeeded",
    time: { created: 0, updated: 20, busy: 10, idle: 20 },
  }
  let lookup = async () => {}
  let ownerRead = async () => {}
  let failAdmission = false
  let lookups = 0
  const admissions: Synthetic[] = []
  const options: OwnerContinuationOptions = {
    directory,
    project: "project",
    owner: async id => { await ownerRead(); return { ...session, id } },
    primary: () => view,
    reconcile: async () => { lookups++; await lookup() },
    checkerEvidence: owner => read(owner),
    session: {
      async synthetic(input) {
        admissions.push(input)
        if (failAdmission) throw new Error("transport lost after admission")
        return {
          id: input.id!, sessionID: input.sessionID, type: "synthetic",
          time: { created: 20 }, delivery: "queue",
          payload: { text: input.text, metadata: input.metadata },
        }
      },
    },
  }
  return {
    create: (override?: Partial<OwnerContinuationOptions>) => createOwnerContinuation({ ...options, ...override }),
    admissions,
    get lookups() { return lookups },
    view: (next: View) => { view = next },
    checker: (next: OwnerContinuationOptions["checkerEvidence"]) => { read = next },
    lookup: (next: () => Promise<void>) => { lookup = next },
    loseAdmission: () => { failAdmission = true },
    ownerRead: (next: () => Promise<void>) => { ownerRead = next },
    session: (next: Partial<Owner>) => { session = { ...session, ...next } },
    start: (busy: number) => { session = { ...session, time: { ...session.time, busy } } },
  }
}

const idle: Idle = { sessionID: ownerID, background: [] }

test("one qualified checker wake across concurrent notices and restart, scoped to the owner", async () => {
  const f = await fixture()
  f.view(result)
  f.checker(async () => evidence)
  const first = f.create()
  await Promise.all([first.checkerCompleted(ownerID), f.create().checkerCompleted(ownerID)])
  await f.create().checkerCompleted(ownerID)
  await f.create().checkerCompleted(otherID)
  expect(f.admissions.map(({ sessionID, resume }) => ({ sessionID, resume }))).toEqual([
    { sessionID: ownerID, resume: true },
    { sessionID: otherID, resume: true },
  ])
  expect(f.admissions[0]!.id).not.toBe(f.admissions[1]!.id)
  expect(f.lookups).toBe(0)
})

test("unverified, stale, child and foreign notices cannot run the owner", async () => {
  const f = await fixture()
  f.view(result)
  const wake = f.create()
  await wake.checkerCompleted(ownerID)
  f.checker(async () => ({ ...evidence, manifest_digest: "c".repeat(64) }))
  await wake.checkerCompleted(ownerID)
  f.checker(async () => evidence)
  f.session({ parentID: otherID })
  await wake.checkerCompleted(ownerID)
  f.session({ parentID: undefined, projectID: "foreign" as Owner["projectID"] })
  await wake.checkerCompleted(ownerID)
  expect(f.admissions).toEqual([])
})

test("an uncertain synthetic admission remains claimed across restart", async () => {
  const f = await fixture()
  f.view(result)
  f.checker(async () => evidence)
  f.loseAdmission()
  await expect(f.create().checkerCompleted(ownerID)).rejects.toThrow("transport lost")
  await f.create().checkerCompleted(ownerID)
  expect(f.admissions).toHaveLength(1)
})

test("an unchanged or ambiguous lookup has no wake; the next execution can reconcile to new evidence", async () => {
  const f = await fixture()
  f.start(30)
  f.view(running)
  const wake = f.create()
  f.lookup(async () => { f.view({ work: { work_key: work, status: "outcome_unknown" } }) })
  await Promise.all([wake.onIdle(idle), wake.onIdle(idle), f.create().onIdle(idle)])
  await f.create().onIdle(idle)
  expect(f.lookups).toBe(1)
  expect(f.admissions).toEqual([])
  f.start(40)
  f.lookup(async () => { f.view(result) })
  await f.create().onIdle(idle)
  expect(f.lookups).toBe(2)
  expect(f.admissions).toHaveLength(1)
  expect(f.admissions[0]).toMatchObject({ sessionID: ownerID, resume: false, delivery: "queue" })
  f.start(50)
  f.view({ work: { ...result.work, status: "reusable" } })
  await f.create().onIdle(idle)
  expect(f.lookups).toBe(2)
  expect(f.admissions).toHaveLength(1)
})

test("a synchronous result, reserved work, and unrelated background entries do not trigger lookup or a turn", async () => {
  const f = await fixture()
  f.start(30)
  const wake = f.create()
  f.view(result)
  await wake.onIdle(idle)
  f.view({ work: { work_key: work, status: "reserved" } })
  await wake.onIdle({ ...idle, background: [{ kind: "codemode", jobID: "unrelated", sessionID: otherID }] })
  expect(f.admissions).toEqual([])
  expect(f.lookups).toBe(0)
})

test("explicit lookup wakes only for newly settled original work", async () => {
  const f = await fixture()
  const wake = f.create()
  f.view(running)
  await wake.externalReconciled(ownerID, running)
  f.view(result)
  await wake.externalReconciled(ownerID, { work: { ...running.work, work_key: "c".repeat(64) } })
  expect(f.admissions).toEqual([])
  await wake.externalReconciled(ownerID, running)
  await f.create().externalReconciled(ownerID, running)
  expect(f.admissions).toHaveLength(1)
  expect(f.lookups).toBe(0)
})

test("interruption during lookup leaves the owner paused and evidence available on a later eligible wake", async () => {
  const f = await fixture()
  f.start(30)
  f.view(running)
  f.lookup(async () => {
    f.view(result)
    f.session({ outcome: "interrupted", time: { created: 0, updated: 31, busy: 30, idle: 31 } })
  })
  const wake = f.create()
  await wake.onIdle(idle)
  f.checker(async () => evidence)
  await wake.checkerCompleted(ownerID)
  await wake.onIdle(idle)
  expect(f.lookups).toBe(1)
  expect(f.admissions).toEqual([])
  f.session({ outcome: "succeeded" })
  f.start(40)
  await f.create().onIdle(idle)
  expect(f.admissions).toHaveLength(2)
})

test("cancelled and disposed completion callbacks cannot admit a notice", async () => {
  const f = await fixture()
  f.view(result)
  f.checker(async () => evidence)
  const wake = f.create()
  const cancelled = new AbortController()
  f.ownerRead(async () => { cancelled.abort() })
  await wake.checkerCompleted(ownerID, cancelled.signal)
  await wake.externalReconciled(ownerID, running, cancelled.signal)
  f.ownerRead(async () => { wake.dispose() })
  await wake.checkerCompleted(ownerID)
  expect(f.admissions).toEqual([])
})

test("idle returns within its time budget and late evidence waits for the next wake", async () => {
  const f = await fixture()
  const blocked = Promise.withResolvers<void>()
  f.start(30)
  f.view(running)
  f.lookup(() => blocked.promise)
  const wake = f.create()
  await wake.onIdle(idle)
  expect(f.lookups).toBe(1)
  await wake.onIdle(idle)
  expect(f.lookups).toBe(1)
  f.view(result)
  blocked.resolve()
  expect(f.admissions).toEqual([])
  f.start(40)
  await f.create().onIdle(idle)
  expect(f.admissions).toHaveLength(1)
})

test("only a complete research batch wakes once across worker events, idle, and restart", async () => {
  const f = await fixture()
  f.start(30)
  let batch: string | undefined
  const options = { researchBatchEvidence: async () => batch }
  const wake = f.create(options)
  await wake.researchCompleted(ownerID)
  await wake.onIdle(idle)
  expect(f.admissions).toEqual([])

  batch = "c".repeat(64)
  await Promise.all([
    wake.researchCompleted(ownerID),
    f.create(options).researchCompleted(ownerID),
    wake.onIdle(idle),
  ])
  await f.create(options).onIdle(idle)
  expect(f.admissions).toHaveLength(1)
  expect(f.admissions[0]).toMatchObject({ sessionID: ownerID, resume: false, text: expect.stringContaining("research batch") })

  batch = "d".repeat(64)
  f.start(40)
  await f.create(options).onIdle(idle)
  expect(f.admissions).toHaveLength(2)
  expect(f.admissions[1]!.id).not.toBe(f.admissions[0]!.id)
})

test("in-flight research verification cannot synthesize after stop", async () => {
  const f = await fixture()
  const entered = Promise.withResolvers<void>()
  const verified = Promise.withResolvers<string>()
  const wake = f.create({
    researchBatchEvidence: () => { entered.resolve(); return verified.promise },
  })
  const completion = wake.researchCompleted(ownerID)
  await entered.promise
  wake.dispose()
  verified.resolve("c".repeat(64))
  await completion
  await wake.researchCompleted(ownerID)
  expect(f.admissions).toEqual([])
})

test("direct checker delivery and idle recovery share a claim for the same receipt", async () => {
  const f = await fixture()
  f.view(result)
  f.start(30)
  f.checker(async () => evidence)
  const wake = f.create()
  await Promise.all([wake.onIdle(idle), wake.checkerCompleted(ownerID), f.create().checkerCompleted(ownerID)])
  expect(f.admissions).toHaveLength(1)
  expect(f.admissions[0]).toMatchObject({ sessionID: ownerID, resume: false })
})

test("an external job that settles after idle wakes the owner exactly once without another turn", async () => {
  const f = await fixture()
  f.start(30)
  f.view(running)
  const wake = f.create({ watchExternal: true })
  await wake.onIdle(idle)
  expect(f.lookups).toBe(1)
  expect(f.admissions).toEqual([])

  f.session({ time: { created: 0, updated: 31, busy: 30, idle: 31 } })
  f.lookup(async () => { f.view(result) })
  const reloaded = f.create({ watchExternal: true })
  await Promise.all([wake.watchOutstanding(ownerID), reloaded.watchOutstanding(ownerID)])
  await waitFor(async () => f.admissions[0], 3_000, "Quiet owner did not wake")
  await reloaded.externalReconciled(ownerID, running)
  await Bun.sleep(550)
  expect(f.lookups).toBe(2)
  expect(f.admissions).toHaveLength(1)
  expect(f.admissions[0]).toMatchObject({ sessionID: ownerID, resume: true, delivery: "queue" })
  wake.dispose()
  reloaded.dispose()
})

test("watch lookup slots are finite and shared by concurrent instances and reloads", async () => {
  const f = await fixture()
  f.view(running)
  const watch = { watchExternal: true }
  const first = f.create(watch)
  await f.create().watchOutstanding(ownerID) // Opt-in is required.
  await Promise.all([first.watchOutstanding(ownerID), f.create(watch).watchOutstanding(ownerID)])
  await waitFor(async () => f.lookups >= 1 || undefined, 2_000, "No initial watch slot")
  first.dispose()
  const reloaded = f.create(watch)
  await reloaded.watchOutstanding(ownerID)
  await waitFor(async () => f.lookups >= 4 || undefined, 9_000, "No final watch slot")
  await f.create(watch).watchOutstanding(ownerID)
  await Bun.sleep(600)
  expect(f.lookups).toBe(4)
  expect(f.admissions).toEqual([])
  reloaded.dispose()
}, 12_000)

test("cancelling or disposing an in-flight watcher prevents its late result from waking the owner", async () => {
  for (const stop of ["cancel", "dispose"] as const) {
    const f = await fixture()
    f.view(running)
    const settled = Promise.withResolvers<void>()
    f.lookup(async () => {
      await settled.promise
      f.view(result)
    })
    const controller = new AbortController()
    const wake = f.create({ watchExternal: true })
    await wake.watchOutstanding(ownerID, controller.signal)
    await waitFor(async () => f.lookups === 1 || undefined, 2_000, "No in-flight watch lookup")
    if (stop === "cancel") controller.abort()
    else wake.dispose()
    settled.resolve()
    await Bun.sleep(100)
    expect(f.lookups).toBe(1)
    expect(f.admissions).toEqual([])
    wake.dispose()
  }
})

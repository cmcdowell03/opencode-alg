import assert from "node:assert/strict"
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type { SessionMessageInfo } from "@opencode/client"
import { WorkerJournal } from "../src/journal.ts"
import { afterPrompt, asObject, fixtureProject, hostSettings, hostVersion, model, owner, receiptFor,
  requestOptions, startHost, transcript } from "./host.ts"
import { startProvider } from "./provider.ts"
import { runtimeIdentity, waitFor } from "./runtime.ts"
import { scenario } from "./scenario.ts"
import { startFactory } from "./service.ts"

const [hostFlag, hostPath, packageFlag, packagePath, ...extra] = process.argv.slice(2)
if (hostFlag !== "--host" || !hostPath || packageFlag !== "--package" || !packagePath || extra.length) {
  throw new Error("Usage: bun run packages/v2-preview/acceptance/continuation.ts --host <OpenCode 2.3.2 binary> --package <built preview directory>")
}
const binary = await realpath(resolve(hostPath))
const bundle = await realpath(resolve(packagePath))
const root = await mkdtemp(join(tmpdir(), "alg-wake-"))
const controller = scenario()
const releaseResult = Promise.withResolvers<void>()
const releaseCheckerFinish = Promise.withResolvers<void>()
let resultPrepared = false
let resultReleased = false
const provider = startProvider(async turn => {
  const checkerTurn = turn.messages.some(message => message.role === "user" &&
    JSON.stringify(message.content)?.includes("Independently check the recorded synthetic investigation evidence"))
  if (checkerTurn && resultReleased) {
    await releaseCheckerFinish.promise
    return { text: "Fixture checker finished." }
  }
  const choice = await controller.decide(turn)
  if ("tool" in choice && choice.args?.action === "result") {
    resultPrepared = true
    await releaseResult.promise
    resultReleased = true
  }
  return choice
})
const factory = startFactory(join(root, "service"), false)
let host: Awaited<ReturnType<typeof startHost>> | undefined

function checkerNotice(row: SessionMessageInfo) {
  if (row.type !== "synthetic") return false
  const revision = row.metadata?.algV2ContinuationRevision
  return row.text.includes("ALG recorded a verified checker result") &&
    typeof revision === "string" && /^[a-f0-9]{64}$/.test(revision)
}

try {
  const version = await hostVersion(binary, root)
  const runtime = await runtimeIdentity(binary, bundle, version)
  const project = await fixtureProject(root, "project")
  factory.bindProject(project.id)
  const settings = await hostSettings(join(root, "host"), provider.url, bundle, factory.adapter)
  const configPath = settings.env.OPENCODE_CONFIG
  const config = JSON.parse(await readFile(configPath, "utf8"))
  assert.equal(config.plugins.length, 1)
  config.plugins[0].options.continueOnEvidence = true
  await writeFile(configPath, JSON.stringify(config))

  host = await startHost(binary, project.directory, settings)
  const client = host.client
  const session = await client.session.create({
    location: { directory: project.directory }, agent: owner, model,
  }, requestOptions())
  assert.equal(session.projectID, project.id)

  async function turn(action: string) {
    const phase = controller.instruction({ action })
    await client.session.prompt({ sessionID: session.id, text: phase.text, delivery: "queue" }, requestOptions())
    const rows = await afterPrompt(client, session.id, phase.id)
    const receipt = receiptFor(rows, action)
    assert(receipt?.value.ok === true, `Preview action ${action} failed`)
    assert.equal(receipt.value.runtimeSha256, runtime.bundleSha256)
    assert(rows.some(row => row.type === "idle" && row.outcome === "succeeded"))
    return receipt.value
  }

  assert.equal((await turn("diagnostics")).enabled, true)
  const plugins = await client.plugin.list({ location: { directory: project.directory } }, requestOptions())
  assert(plugins.data.some(plugin => plugin.id === "opencode-alg-v2-preview" && plugin.state.status === "active"))
  await turn("create")
  await turn("admit")
  const dispatched = await turn("dispatch")
  const manifest = asObject(dispatched.work)?.manifest_digest
  assert(typeof manifest === "string")
  const checker = controller.checker(manifest)
  const started = await turn("start")
  const workerID = asObject(started.worker)?.workerSessionId
  assert(typeof workerID === "string")
  const worker = await client.session.get({ sessionID: workerID }, requestOptions())
  assert.equal(worker.parentID, session.id)

  // Hold the checker result tool call until the real owner's start turn is durably idle.
  await waitFor(async () => resultPrepared || undefined, 10_000, "Checker did not prepare a cited result")
  const before = await transcript(client, session.id)
  assert.equal(before.at(-1)?.type, "idle")
  assert(!before.some(row => row.type === "synthetic"))
  const journal = new WorkerJournal(project.directory, project.id, session.id)
  assert.equal(await journal.read("result"), undefined)
  assert.equal(checker.state.sawWitness, factory.current)
  releaseResult.resolve()
  checker.resume()

  const result = await waitFor(async () => {
    const receipt = receiptFor(await transcript(client, workerID), "result")
    if (receipt) return receipt
  }, 10_000, "Checked result was not recorded by the installed preview")
  assert.equal(result.value.ok, true)
  assert.equal(result.value.runtimeSha256, runtime.bundleSha256)
  assert.equal(asObject(result.value.worker)?.status, "result_recorded")
  const recorded = await journal.read("result")
  assert.equal(recorded?.result, "pass")
  assert.equal(recorded?.citation.manifest_digest, manifest)

  await waitFor(async () => {
    const rows = await transcript(client, session.id)
    const at = rows.findIndex(checkerNotice)
    if (at >= 0 && rows.slice(at + 1).some(row => row.type === "idle" && row.outcome === "succeeded")) return true
  }, 10_000, "Committed checker result did not wake the quiet owner")
  // Keep ordinary child completion from being the event that wakes the owner.
  assert(!(await transcript(client, workerID)).some(row => row.type === "idle"))
  releaseCheckerFinish.resolve()
  await waitFor(async () => (await transcript(client, workerID))
    .find(row => row.type === "idle" && row.outcome === "succeeded"), 10_000, "Fixture checker did not finish")
  await Bun.sleep(750)
  const after = await transcript(client, session.id)
  assert.equal(after.filter(row => row.type === "user").length, before.filter(row => row.type === "user").length)
  assert.equal(after.filter(checkerNotice).length, 1)
  assert.equal(factory.audit.filter(row => row.name === "submit").length, 1)
  assert.equal(factory.audit.filter(row => row.name === "lookup").length, 0)
  assert.deepEqual(provider.errors, [])
  console.log(JSON.stringify({
    version, bundleSha256: runtime.bundleSha256, checkerResult: recorded?.result,
    previewCheckerNotices: 1, addedUserTurns: 0,
  }))
} finally {
  releaseResult.resolve()
  releaseCheckerFinish.resolve()
  await host?.process.kill()
  provider.stop()
  await factory.stop()
  await rm(root, { recursive: true, force: true })
}

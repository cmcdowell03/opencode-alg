import { mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
import { isDeepStrictEqual } from "node:util"
import { InvestigationHttpPort } from "../../../src/investigation-transport.ts"
import { runContainedPath } from "../../../src/store.ts"
import { fixtureProject, hostVersion, owner, requestOptions, startHost, toolCalls, transcript } from "../acceptance/host.ts"
import { runtimeIdentity, sha256, waitFor } from "../acceptance/runtime.ts"
import { startFactory } from "../acceptance/service.ts"
import { createV2InvestigationBridge } from "../core/investigation.ts"
import { deliverySchema, type DeliveryReceipt } from "../src/delivery.ts"
import { WorkerJournal } from "../src/journal.ts"
import { deliveryGap, observeDelivery, scriptedDelivery } from "./delivery-script.ts"
import { inspectAnswer } from "./handoff-audit.ts"
import { checkerInput, classifyHandoff, correctionHeader, finalInput, initialInput, jsonObject, skillContent, skillName, verifiedCorrection } from "./handoff-case.ts"
import { handoffJob, stageGate } from "./handoff-gate.ts"
import { scriptedHandoff } from "./handoff-script.ts"
import { checkerName, installAlg, observeAlgDecision, observeTurn, pluginId, prepareHost, registerSkill, submitTurn, type Host } from "./host.ts"
import { startTransport } from "./transport.ts"
import { createWorkbench, startWorkbench } from "./workbench.ts"

const cases = ["ready", "superseded", "revoked", "missing-reference"] as const
type Case = typeof cases[number]
const model = { providerID: "paired-benchmark", id: "fixture" }
const prefix = "alg-delivery-acceptance-"

async function run(binary: string, bundle: string, scenario: Case, scratch: string) {
  const version = await hostVersion(binary, join(scratch, "probe"))
  const runtime = await runtimeIdentity(binary, bundle, version)
  const fixture = await fixtureProject(scratch, "project")
  const git = Bun.which("git")!
  const factory = startFactory(join(scratch, "factory"), false)
  const workbench = createWorkbench({ maxAcceptedQueries: 4 })
  const evidence = startWorkbench(workbench)
  const wire: ReturnType<typeof observeDelivery>[] = []
  let continuing = false
  let host: Host | undefined
  const provider = startTransport({
    id: model.id, seed: 101, classify: classifyHandoff, stale: "attribute-as-recorded", correction: correctionHeader,
    skill: () => undefined,
    decide(input) {
      if (continuing) {
        const observed = observeDelivery(input.messages)
        wire.push(observed)
        return scriptedDelivery(input.messages, observed)
      }
      const phase = classifyHandoff(input.messages).phase
      const result = scriptedHandoff(input)
      if (scenario === "missing-reference" && phase === "correction" && !input.summary && "text" in result) {
        const report = jsonObject(result.text)
        if (!report || typeof report.inspectionRef !== "string") throw new Error("Missing-reference fixture did not produce a report")
        // Keep the report complete but remove the link to observed inspection evidence.
        report.inspectionRef = "unverified-inspection-reference"
        return { text: JSON.stringify(report) }
      }
      return result
    },
  })
  provider.releaseSummary()
  try {
    const project = await prepareHost(scratch, { model, providerUrl: provider.url, evidenceUrl: evidence.endpoint,
      checkerUrl: evidence.checkerEndpoint, skill: { name: skillName, content: skillContent }, bundle })
    const env: NodeJS.ProcessEnv = project.settings.env
    env.PATH = dirname(git) + delimiter + env.PATH
    project.config.compaction.auto = false
    await writeFile(project.configPath, JSON.stringify(project.config))
    host = await startHost(binary, project.directory, project.settings)
    const skill = await registerSkill(host, project, skillName)
    await host.process.kill()
    await installAlg(project, bundle, skill, factory)
    const { id, sha256: skillSha256, sourceSha256 } = skill
    const preQueryPolicy = await stageGate(git, project.directory, fixture.id,
      { id, path: project.skillRelative, sha256: skillSha256, sourceSha256 })
    Object.assign((project.config.plugins.at(-1) as { options: object }).options, { approvedJob: handoffJob, preQueryPolicy })
    await writeFile(project.configPath, JSON.stringify(project.config))
    let installed = host = await startHost(binary, project.directory, project.settings)
    const { client } = installed
    const location = { directory: project.directory }
    const root = await client.session.create({ location, model, agent: owner }, requestOptions())
    if (root.projectID !== fixture.id || root.agent !== owner) throw new Error("Owner identity mismatch")
    factory.bindProject(root.projectID)
    const checker = await client.session.create({ location, model, agent: checkerName, parentID: root.id }, requestOptions())
    await waitFor(async () => {
      const plugins = (await client.plugin.list({ location }, requestOptions())).data
      const plugin = plugins.find(row => row.id === pluginId)
      if (plugin?.state.status === "failed") throw new Error("Installed preview failed")
      const servers = (await client.mcp.list({ location }, requestOptions())).data
      if (plugin?.state.status === "active" && servers.length === 2 &&
          servers.every(row => row.status.status === "connected")) return true
    }, 8000, "Installed preview or workbench unavailable")
    async function turn(text: string, session = root.id) {
      const id = await submitTurn(installed, session, text)
      return waitFor(() => observeTurn(installed, session, id), 30_000, "Host response deadline")
    }
    const initial = inspectAnswer((await turn(initialInput)).text, false)
    if (initial.observation !== "strict_object" || initial.mismatchedFields?.length !== 0) throw new Error("Initial decision fixture failed")
    const correction = verifiedCorrection((await turn(checkerInput, checker.id)).text)
    if (!correction) throw new Error("Independent correction fixture failed")
    const correctedTurn = await turn(correction)
    const corrected = inspectAnswer(correctedTurn.text, true)
    if (scenario !== "missing-reference" && (corrected.observation !== "strict_object" || corrected.mismatchedFields?.length !== 0))
      throw new Error("Corrected decision fixture failed")
    const decision = () => observeAlgDecision(factory, project.directory, root.projectID, root.id)
    if (decision()?.revision !== 2) throw new Error("Corrected decision revision was not recorded")

    const prior = new Set((await transcript(client, root.id)).map(row => row.id))
    await client.session.compact({ sessionID: root.id, delivery: "queue" }, requestOptions())
    const compaction = await waitFor(async () => {
      const rows = await transcript(client, root.id)
      const row = rows.find(row => row.type === "compaction" && row.reason === "manual" && !prior.has(row.id))
      if (row?.type === "compaction" && row.status === "failed") throw new Error("Manual compaction failed")
      if (row?.type === "compaction" && row.status === "completed" && rows.at(-1)?.type === "idle") return row
    }, 20_000, "No completed manual compaction")
    let restart: { fromPid: number; toPid: number; receiptPath: string; receiptSha256: string; receipt: DeliveryReceipt } | undefined
    if (scenario === "ready") {
      const journal = new WorkerJournal(project.directory, root.projectID, root.id)
      const receiptPath = runContainedPath(project.directory, journal.runId, "delivery", sha256(compaction.id) + ".json")
      const bytes = await readFile(receiptPath, "utf8")
      const saved = jsonObject(bytes)
      const receipt = deliverySchema.parse(saved?.receipt)
      if (saved?.kind !== "report" || receipt.binding.ownerSessionId !== root.id ||
          receipt.binding.projectId !== root.projectID || receipt.binding.decision_revision !== 2 ||
          receipt.compactionMessageId !== compaction.id || receipt.answerMessageId !== correctedTurn.id ||
          !isDeepStrictEqual(receipt.recordedAnswer, jsonObject(correctedTurn.text)))
        throw new Error("Pre-restart receipt does not match the compacted owner report")
      const fromPid = installed.info.pid
      const stopped = await installed.process.kill()
      if (!stopped.signalled || !installed.process.exited()) throw new Error("Pre-restart host did not stop")
      installed = host = await startHost(binary, project.directory, project.settings)
      const toPid = installed.info.pid
      const resumed = await installed.client.session.get({ sessionID: root.id }, requestOptions())
      const resumedRows = await transcript(installed.client, root.id)
      const resumedCut = resumedRows.slice().reverse().find(row => row.type === "compaction")
      if (fromPid === toPid || resumed.id !== root.id || resumed.projectID !== root.projectID ||
          resumed.agent !== root.agent || resumedCut?.status !== "completed" || resumedCut.id !== compaction.id ||
          resumedCut.summary !== compaction.summary || await readFile(receiptPath, "utf8") !== bytes)
        throw new Error("Restart did not preserve the native owner session, compaction and delivery receipt")
      restart = { fromPid, toPid, receiptPath, receiptSha256: sha256(bytes), receipt }
    }
    if (scenario === "superseded") {
      // Move the live decision head while leaving the compacted owner history intact.
      const port = new InvestigationHttpPort(factory.adapter, root.projectID)
      const bridge = createV2InvestigationBridge({ port, approvedJob: handoffJob })
      await bridge.setNextMeasurement({ directory: project.directory, projectID: root.projectID, sessionID: root.id },
        { expected_decision_revision: 2, next_action: "review-calibration" }, async () => preQueryPolicy.procedure)
      if (decision()?.revision !== 3) throw new Error("Superseding decision was not recorded")
    }
    if (scenario === "revoked") {
      await rename(project.skillFile, join(scratch, "withdrawn-procedure.md"))
      await rename(join(project.directory, ".opencode", "research-procedure.json"), join(scratch, "withdrawn-approval.json"))
      await waitFor(async () => {
        const catalog = await client.skill.list({ location }, requestOptions())
        if (!catalog.data.some(entry => entry.id === skill.id)) return true
      }, 8000, "Host still lists the withdrawn skill")
    }

    const before = workbench.snapshot()
    const factoryOffset = factory.audit.length
    const requestOffset = provider.requests.length
    continuing = true
    const final = await turn(finalInput)
    const requests = provider.requests.slice(requestOffset)
    const calls = toolCalls(final.rows).map(call => call.name)
    const receipts = workbench.snapshot().receipts.slice(before.receipts.length)
    const factoryCalls = factory.audit.length - factoryOffset
    const answer = inspectAnswer(final.text, true)
    const abstention = jsonObject(final.text)
    const priorReceiptUsed = restart && wire.length === 1 &&
      wire[0]?.revision === restart.receipt.binding.decision_revision &&
      isDeepStrictEqual(wire[0]?.values, restart.receipt.recordedAnswer) &&
      sha256(await readFile(restart.receiptPath, "utf8")) === restart.receiptSha256
    const checks = {
      ...(scenario === "ready" && { priorReceiptUsedAfterRestart: priorReceiptUsed === true }),
      bareContinuation: wire.length === 1 && wire.every(row => row.barePrompt >= 0) &&
        requests.length === wire.length && requests.every(row => row.status === 200),
      currentDelivery: scenario === "ready"
        ? wire.every(row => row.projections === 1 && row.statuses.length === 1 && row.noRereads &&
          !row.reportInStatus && row.revision === 2)
        : wire.every(row => row.projections === 0 && row.ready === 0 && deliveryGap(row.statuses) === scenario),
      answer: scenario === "ready"
        ? answer.observation === "strict_object" && answer.mismatchedFields?.length === 0
        : abstention?.abstained === true && abstention.gap === scenario && Object.keys(abstention).length === 2,
      zeroReads: factoryCalls === 0 && calls.length === 0 && receipts.length === 0,
    }
    return { scenario, runtime, passed: Object.values(checks).every(Boolean), checks, answer, final: final.text,
      restart: restart && { fromPid: restart.fromPid, toPid: restart.toPid, sessionId: root.id,
        compactionId: compaction.id, receiptSha256: restart.receiptSha256 },
      continuation: { calls, factoryCalls, redundantToolCalls: calls.length,
        workbenchReceipts: receipts, wire: wire.map(({ values, ...row }) => ({ ...row, fields: Object.keys(values ?? {}) })) } }
  } finally {
    try { if (host && !host.process.exited()) await host.process.kill() }
    finally {
      provider.stop()
      evidence.stop()
      await factory.stop()
    }
  }
}

export async function deliveryAcceptance(args: string[]) {
  const [binary, bundle, selected, ...extra] = args
  if (!binary || !bundle || extra.length || (selected && !cases.includes(selected as Case)))
    throw new Error("Usage: bun packages/v2-preview/benchmark/delivery-acceptance.ts <OpenCode 2.3.2 executable> <staged preview bundle> [ready|superseded|revoked|missing-reference]")
  const parent = await realpath(tmpdir())
  for (const scenario of selected ? [selected as Case] : cases) {
    const scratch = await mkdtemp(join(parent, prefix))
    try {
      const result = await run(await realpath(binary), await realpath(bundle), scenario, scratch)
      console.log(JSON.stringify({ mode: "installed-scripted-delivery", ...result }))
      if (!result.passed) process.exitCode = 1
    } catch (error) {
      console.error(JSON.stringify({ mode: "installed-scripted-delivery", scenario, passed: false, error: String(error) }))
      process.exitCode = 1
    } finally {
      const target = await realpath(scratch)
      if (dirname(target) !== parent || !basename(target).startsWith(prefix)) throw new Error("Fixture path mismatch")
      await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
    }
  }
}

if (import.meta.main) await deliveryAcceptance(process.argv.slice(2))

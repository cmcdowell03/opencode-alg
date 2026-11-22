import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { algTool, asObject, fixtureProject, hostVersion, owner, parseObject, receiptsFor, requestOptions,
  startHost, toolCalls, transcript } from "../acceptance/host.ts"
import { fileDigest, isolate, runtimeIdentity, sha256, waitFor } from "../acceptance/runtime.ts"
import { model, startActiveQuestionProvider, type ResponseStep, type Wire } from "./active-question-provider.ts"
import { paths, sourcePlugin, sourceTool } from "./active-question-source.ts"
import { observeTurn, pluginId, submitTurn, type Host, type Turn } from "./host.ts"
import { wireTextParts } from "./skill-delivery.ts"
import { ledger, watchLedgerOpens } from "./turn-routing-acceptance-ledger.ts"
import { latestTool, object, rows, savedCalculation, scopedFinding, string } from "./turn-routing-acceptance-payload.ts"

const prefix = "alg-turn-routing-"
const modes = ["legacy", "routed", "routed-compact"] as const
type Mode = typeof modes[number]
const approvedName = "pressure-correction"
const approvalPath = ".opencode/bench-procedure.json"
const procedurePath = `.opencode/skills/${approvedName}/SKILL.md`
const procedureWitness = "Verified pressure procedure TR17-P42."
const procedureRule = "Corrected pressure (kPa) = (raw - zeroOffset) * sensitivity."
const summary = "## Objective\nResume the bench session as requested.\n## Decisions\nUse live readback when needed.\n## Work State\nManual checkpoint retained."
const calibrationScope = "P-42 reference calibration"
const inventoryScope = "Bench spare control inventory"
const calibrationId = "saved-reference"
const inventoryId = "saved-controls"
const calibrationWitness = "TR17-ORIGINAL-REFERENCE-7831"
const amendedWitness = "TR17-AMENDED-REFERENCE-8714"
const inventoryWitness = "TR17-ORIGINAL-INVENTORY-2991"
const calibration = JSON.stringify([{ id: "reference", zeroOffset: 13.25, sensitivity: 1.125, witness: calibrationWitness }])
const amended = JSON.stringify([{ id: "reference", zeroOffset: 11.75, sensitivity: 1.25, witness: amendedWitness }])
const inventory = JSON.stringify([{ id: "stock", spareControls: 2, witness: inventoryWitness }])
const prompts = {
  retain: "Keep the bench calibration for P-42 and separately record the spare controls for later.",
  unrelated: 'Count the words between quotes: "cedar birch elm oak".',
  compute: "What should a raw P-42 reading of 165.25 kPa come out to here? Give the result and cite what you used.",
  change: "The reference calibration file was corrected. Check which saved finding needs revisiting.",
}
const alg = (action: string, fields: Record<string, unknown> = {}) => ({ tool: algTool, args: { action, ...fields } })
const read = (path: string) => ({ tool: sourceTool, args: { path } })
const status = (id: unknown) => alg("status", { finding_id: string(id, "Missing finding identifier") })
const userText = (wire: Wire) => wireTextParts(wire.messages.slice().reverse().find(message => message.role === "user")?.content).join("\n")

function wireContext(wire: Wire) {
  const system = wire.messages.filter(message => message.role === "system").flatMap(message => wireTextParts(message.content)).join("\n")
  const frames = wire.messages.flatMap(message => wireTextParts(message.content))
    .filter(part => /^ALG active question(?: delta)? \(untrusted recorded data\)/.test(part)).length
  return { frames, procedureProjected: system.includes(procedureWitness),
    graphGuidance: /ALG recovers the active question|Use the current active question|Revalidate only the affected findings|Stop this investigation loop|Reuse the current decision revision/.test(system) }
}

function fixtureRow(wire: Wire) {
  const output = latestTool(wire)
  const sourcePath = string(output.path, "Missing source path in the tool result")
  const data = string(output.content, "Missing source bytes in the tool result")
  const [row, ...rest] = rows(JSON.parse(data), "Malformed fixture source")
  assert.ok(row && !rest.length)
  return { row, reference: sourcePath + "#" + string(row.id, "Missing source row ID") }
}

function record(id: string, interpretation: string, scope: string, reference: string, revision: unknown) {
  return alg("record_finding", { finding: { id, interpretation, scope, support: [reference], counterevidence: [] },
    expected_decision_revision: revision })
}

function receipt(turn: Turn, action: string, match?: (input: Record<string, unknown>) => boolean) {
  const found = receiptsFor(turn.rows, action).filter(row => !match || match(row.input))
  assert.equal(found.length, 1, `Expected one ${action} receipt`)
  assert.equal(found[0]!.value.ok, true, JSON.stringify(found[0]!.value))
  return found[0]!
}

async function stageSourcePlugin(directory: string) {
  const entry = fileURLToPath(new URL("./active-question-source.ts", import.meta.url))
  const build = await Bun.build({ entrypoints: [entry], target: "bun" })
  assert.ok(build.success && build.outputs.length === 1, "Source fixture build failed")
  await mkdir(directory)
  await writeFile(join(directory, "index.js"), await build.outputs[0]!.text(), { flag: "wx" })
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: sourcePlugin, type: "module", exports: "./index.js" }), { flag: "wx" })
  return pathToFileURL(directory).href
}

async function runArm(binary: string, bundle: string, bundleSha256: string, scratch: string, mode: Mode, sourcePackage: string) {
  const started = performance.now()
  const project = await fixtureProject(scratch, "project")
  const { directory } = project
  const location = { directory }
  const auditFile = join(scratch, "reads.jsonl")
  const configPath = join(scratch, "opencode.json")
  await Promise.all([[paths.calibration, calibration], [paths.inventory, inventory]]
    .map(([path, content]) => writeFile(join(directory, path!), content!, { flag: "wx" })))
  await writeFile(auditFile, "", { flag: "wx" })
  const skillFile = join(directory, procedurePath)
  await mkdir(dirname(skillFile), { recursive: true })
  await writeFile(skillFile, `---\nname: ${approvedName}\ndescription: Correct pressure using the saved P-42 calibration.\n---\n# Procedure\n${procedureWitness}\n${procedureRule}\n`, { flag: "wx" })
  const provider = startActiveQuestionProvider()
  const externalAttempts: string[] = []
  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, fetch(request) {
    externalAttempts.push(request.method)
    return new Response("Fixture forbids nonlocal calls", { status: 403 })
  } })
  const stages: { phase: string; promptId: string; answerId: string; text: string; calls: { id: string; name: string; input: unknown; status: string }[];
    sources: { path: unknown; receipt: unknown }[]; elapsedMs: number }[] = []
  let running: Host | undefined
  async function audit() {
    return (await readFile(auditFile, "utf8")).split(/\r?\n/).filter(Boolean).map(line => {
      const value = object(parseObject(line), "Malformed source audit")
      return { path: value.path, receipt: value.receipt }
    })
  }

  try {
    const env = await isolate(join(scratch, "host"))
    delete env.OPENCODE_DISABLE_FILEWATCHER
    const git = Bun.which("git")
    assert.ok(git)
    env.PATH = dirname(git) + delimiter + env.PATH
    const password = randomBytes(24).toString("hex")
    const proxy = `http://127.0.0.1:${trap.port}`
    const settings = { env: { ...env, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: env.XDG_CONFIG_HOME,
      OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password,
      HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy, ALL_PROXY: proxy },
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } }
    const deny = { action: "*", resource: "*", effect: "deny" }
    const allow = (action: string, resource = "*") => ({ action, resource, effect: "allow" })
    const config = {
      model: `${model.providerID}/${model.id}`, default_agent: owner, update: "disable", share: "disabled",
      snapshots: false, warming: false, compaction: { auto: false, keep: { tokens: 0 } },
      providers: { [model.providerID]: { package: "@opencode/ai/providers/openai-compatible", name: "Local turn routing fixture",
        settings: { baseURL: provider.url }, models: { [model.id]: { name: model.id, type: "chat",
          limit: { context: 32768, output: 1024 }, capabilities: { tools: true } } } } },
      skills: [dirname(dirname(skillFile))], permissions: [deny],
      agents: { [owner]: { mode: "primary", permissions: [deny,
        allow("tool.use", sourceTool), allow(sourceTool), allow("tool.use", algTool), allow(algTool)] } },
      plugins: [{ package: sourcePackage, options: { directory, audit: auditFile } }] as object[],
    }
    await writeFile(configPath, JSON.stringify(config), { flag: "wx" })
    const bootstrap = running = await startHost(binary, directory, settings)
    const skill = await waitFor(async () => {
      const list = (await bootstrap.client.skill.list({ location }, requestOptions())).data
      return list.find(entry => entry.name === approvedName)
    }, 5_000, "Fixture skill unavailable in native OpenCode")
    assert.equal(await realpath(skill.path), await realpath(skillFile))
    assert.ok(skill.content.includes(procedureWitness))
    const approval = { id: skill.id, path: procedurePath, sha256: sha256(skill.content), sourceSha256: await fileDigest(skillFile) }
    await writeFile(join(directory, approvalPath), JSON.stringify(approval), { flag: "wx" })
    assert.ok((await bootstrap.process.kill()).signalled)
    config.plugins.push({ package: pathToFileURL(bundle).href, options: {
      enabled: true, ownerAgent: owner, investigationMode: "read-only", graphLoop: true,
      ...(mode !== "legacy" && { turnRouting: mode }),
      readOnlyEvidenceTools: [sourceTool], readOnlyCacheSourceBytes: true,
      approvedProcedure: approvalPath, approvedProcedureSha256: sha256(JSON.stringify(approval)),
    } })
    await writeFile(configPath, JSON.stringify(config))

    async function start() {
      const host = running = await startHost(binary, directory, settings)
      await waitFor(async () => {
        const plugins = (await host.client.plugin.list({ location }, requestOptions())).data
          .filter(plugin => plugin.id === pluginId || plugin.id === sourcePlugin)
        assert.ok(!plugins.some(plugin => plugin.state.status === "failed"), JSON.stringify(plugins))
        return plugins.length === 2 && plugins.every(plugin => plugin.state.status === "active") ? true : undefined
      }, 12_000, "Installed plugins did not activate")
      assert.deepEqual((await host.client.mcp.list({ location }, requestOptions())).data, [])
      return host
    }
    let host = await start()
    const session = await host.client.session.create({ location, model, agent: owner, title: "Turn routing acceptance" }, requestOptions())
    assert.deepEqual([session.projectID, session.agent, session.parentID ?? null], [project.id, owner, null])

    async function turn(phase: string, prompt: string, ...steps: ResponseStep[]) {
      const at = performance.now()
      const before = provider.requests.length
      const auditBefore = (await audit()).length
      provider.plan(phase, steps)
      const promptId = await submitTurn(host, session.id, prompt)
      const completed = await waitFor(() => {
        provider.assertHealthy()
        return observeTurn(host, session.id, promptId)
      }, 25_000, `No completed native turn: ${phase}`)
      provider.assertDone()
      const observed = provider.requests.slice(before)
      const tools = toolCalls(completed.rows)
      const calls = tools.map(call => {
        assert.equal(call.state.status, "completed", JSON.stringify(call))
        return { id: call.id, name: call.name, input: call.state.input, status: call.state.status }
      })
      const emitted = observed.flatMap(({ completion }) => completion && "tool" in completion ? [completion] : [])
      assert.equal(observed.length, steps.length)
      assert.deepEqual(calls.map(call => [call.name, call.input]), emitted.map(call => [call.tool, call.args]))
      const sources = (await audit()).slice(auditBefore)
      const sourceOutputs = tools.flatMap(call => {
        if (call.name !== sourceTool || call.state.status !== "completed") return []
        const text = call.state.content.find(part => part.type === "text")?.text ?? ""
        const value = object(parseObject(text), "Missing native source output")
        return [{ path: value.path, receipt: value.receipt }]
      })
      assert.deepEqual(sources, sourceOutputs, "Actual reads differ from native source calls")
      stages.push({ phase, promptId, answerId: completed.id, text: completed.text, calls, sources, elapsedMs: Math.round(performance.now() - at) })
      return completed
    }

    let initialRevision: unknown
    let lastFinding: ReturnType<typeof record> | undefined
    let beforeDuplicateRevision: unknown
    let yieldObserved = false
    const retained = await turn("retain", prompts.retain, alg("create"), wire => {
      const result = latestTool(wire)
      assert.equal(result.runtimeSha256, bundleSha256)
      assert.equal(result.decision_revision, 0)
      initialRevision = result.decision_revision
      assert.ok(wireContext(wire).graphGuidance, "Create did not activate graph guidance")
      return read(paths.calibration)
    }, wire => {
      const { row, reference } = fixtureRow(wire)
      assert.ok(typeof row.zeroOffset === "number" && typeof row.sensitivity === "number")
      return record(calibrationId, "The reference row contains the approved bench calibration.", calibrationScope, reference, initialRevision)
    }, read(paths.inventory), wire => {
      const { row, reference } = fixtureRow(wire)
      assert.ok(typeof row.spareControls === "number")
      lastFinding = record(inventoryId, `There are ${row.spareControls} spare controls.`, inventoryScope, reference, initialRevision)
      return lastFinding
    }, wire => {
      const progress = latestTool(wire)
      assert.equal(progress.outcome, "recorded")
      beforeDuplicateRevision = progress.evidence_revision
      assert.ok(wireContext(wire).graphGuidance)
      return lastFinding!
    }, wire => {
      const duplicate = latestTool(wire)
      assert.deepEqual([duplicate.outcome, duplicate.reason, duplicate.evidence_revision], ["reused", "no_progress", beforeDuplicateRevision])
      const context = wireContext(wire)
      yieldObserved = !context.graphGuidance && context.frames === 0
      if (mode !== "legacy") assert.ok(yieldObserved, "The graph repeated guidance after a no-progress write")
      return { text: "Saved the two bench findings." }
    })
    assert.deepEqual(receiptsFor(retained.rows, "record_finding").map(({ value }) => [value.ok, value.finding_status]),
      [[true, "supported"], [true, "supported"], [true, "supported"]])
    const beforeCount = await ledger(directory)
    const observer = await watchLedgerOpens(directory)
    let opens: ReturnType<typeof observer.finish>
    try {
      const unrelated = await turn("unrelated", prompts.unrelated, wire => {
        const quoted = /"([^"]+)"/.exec(userText(wire))
        assert.ok(quoted)
        if (mode !== "legacy") assert.deepEqual(wireContext(wire), { frames: 0, procedureProjected: false, graphGuidance: false })
        return { text: `The count is ${quoted[1]!.trim().split(/\s+/).length}.` }
      })
      assert.equal(unrelated.text, "The count is 4.")
    } finally { opens = observer.finish() }
    const afterCount = await ledger(directory)
    assert.deepEqual(afterCount, beforeCount, "Unrelated turn mutated the persisted investigation")

    const previous = new Set((await transcript(host.client, session.id)).map(row => row.id))
    provider.plan("compaction", [{ text: summary }])
    await host.client.session.compact({ sessionID: session.id, delivery: "queue" }, requestOptions())
    const cut = await waitFor(async () => {
      provider.assertHealthy()
      const log = await transcript(host.client, session.id)
      const row = log.find(row => row.type === "compaction" && !previous.has(row.id))
      if (row?.type !== "compaction") return
      assert.notEqual(row.status, "failed")
      if (row.status === "completed" && log.at(-1)?.type === "idle") return row
    }, 25_000, "Native manual compaction did not finish")
    provider.assertDone()
    assert.deepEqual([cut.reason, cut.summary], ["manual", summary])
    const beforeRestart = await ledger(directory)
    const fromPid = host.info.pid
    assert.ok((await host.process.kill()).signalled && host.process.exited())
    host = await start()
    assert.notEqual(host.info.pid, fromPid)
    const resumed = await host.client.session.get({ sessionID: session.id }, requestOptions())
    assert.deepEqual([resumed.id, resumed.projectID, resumed.agent], [session.id, project.id, owner])
    assert.ok((await transcript(host.client, session.id)).some(row => row.type === "compaction" &&
      row.id === cut.id && row.status === "completed" && row.summary === summary))
    assert.deepEqual(await ledger(directory), beforeRestart, "Restart changed persisted investigation")

    async function compute(phase: "compute" | "repeat") {
      const before = await ledger(directory)
      let catalog: Record<string, unknown>[] = []
      let finding: Record<string, unknown> | undefined
      let snapshot: Record<string, unknown> | undefined
      let computed: ReturnType<typeof savedCalculation> | undefined
      const completed = await turn(phase, prompts.compute, wire => {
        assert.ok(wire.text.includes(summary), "Provider missed native compaction summary")
        if (phase === "compute") {
          assert.ok(!wire.text.includes(inventoryWitness) && !wire.text.includes(calibrationWitness), "Raw source bytes survived into computation")
          if (mode !== "legacy") {
            assert.ok(!wire.text.includes(procedureRule), "Procedure body arrived before a live lookup")
            assert.ok(!wire.text.includes(calibrationId), "Finding ID arrived before catalog discovery")
          }
        }
        return alg("status", mode === "legacy" ? { detail: true } : {})
      }, wire => {
        const result = latestTool(wire)
        assert.equal(result.ok, true, JSON.stringify(result))
        catalog = rows(mode === "legacy" ? asObject(result.evidence)?.findings : result.finding_index, "Saved finding catalog unavailable")
        assert.deepEqual(catalog.map(row => [row.scope, row.status]), [[calibrationScope, "supported"], [inventoryScope, "supported"]])
        const calibration = catalog.find(row => row.scope === calibrationScope)
        assert.equal(calibration?.status, "supported")
        return status(calibration?.id)
      }, wire => {
        finding = scopedFinding(latestTool(wire))
        assert.equal(finding.scope, calibrationScope)
        const support = rows(finding.support, "Missing scoped references")
        return alg("status", { snapshot_refs: support.map(row => string(row.reference, "Missing row reference")) })
      }, wire => {
        snapshot = latestTool(wire)
        return alg("procedure")
      }, wire => {
        computed = savedCalculation(userText(wire), finding!, snapshot!, latestTool(wire))
        assert.equal(computed.procedure.sha256, approval.sha256)
        return { text: computed.text }
      })
      assert.ok(computed)
      assert.equal(completed.text, computed.text)
      assert.deepEqual((await ledger(directory)), before, "Recall mutated the persisted investigation")
      if (mode !== "legacy") for (const request of provider.requests.filter(request => request.phase === phase)) {
        const context = wireContext(request.input)
        assert.equal(context.graphGuidance, false, "Recall activated graph guidance")
        assert.equal(context.frames, 0, "Recall projected the active graph")
      }
      return { ...computed, finding, discoveredIds: catalog.map(row => row.id), answerId: completed.id }
    }

    const computed = await compute("compute")
    const repeated = await compute("repeat")
    const { answerId: firstAnswer, ...first } = computed
    const { answerId: repeatAnswer, ...second } = repeated
    assert.notEqual(firstAnswer, repeatAnswer)
    assert.deepEqual(second, first)
    const changedPath = string(computed.citation.path, "Missing source path for amendment")
    assert.equal(changedPath, paths.calibration)
    const oldSourceSha = string(computed.citation.sha256, "Missing original source digest")
    assert.equal(await fileDigest(join(directory, changedPath)), oldSourceSha)
    await writeFile(join(directory, changedPath), amended)
    const amendedSha = await fileDigest(join(directory, changedPath))
    assert.notEqual(amendedSha, oldSourceSha)
    const otherId = computed.discoveredIds.find(id => id !== computed.finding!.id)
    const reopen: ResponseStep[] = mode === "legacy" ? [read(changedPath)] : [alg("create"), wire => {
      assert.equal(latestTool(wire).decision_revision, initialRevision)
      assert.ok(wireContext(wire).graphGuidance, "Reopening with create did not activate graph guidance")
      return read(changedPath)
    }]
    const amendment = await turn("amend", prompts.change, ...reopen, wire => {
      assert.equal(latestTool(wire).content, amended, "Provider did not receive amended bytes")
      return status(computed.finding!.id)
    }, wire => {
      const reopened = scopedFinding(latestTool(wire))
      assert.equal(reopened.status, "unresolved")
      return status(otherId)
    }, wire => {
      assert.equal(scopedFinding(latestTool(wire)).status, "supported")
      return { text: "Only the reference calibration finding reopened." }
    })
    const reopened = scopedFinding(receipt(amendment, "status", input => input.finding_id === computed.finding!.id).value)
    const unaffected = scopedFinding(receipt(amendment, "status", input => input.finding_id === otherId).value)
    assert.deepEqual(reopened.support, [])
    assert.deepEqual(reopened.invalidatedSources, [{ relation: "support", reference: computed.citation.reference }])
    assert.equal(unaffected.scope, inventoryScope)
    const otherCitation = rows(unaffected.support, "Inventory lost its saved citation")
    const reads = await audit()
    assert.deepEqual(reads.map(row => row.path), [paths.calibration, paths.inventory, paths.calibration])
    assert.deepEqual(otherCitation.map(citation => [citation.path, citation.sha256, citation.receipt]),
      [[paths.inventory, sha256(inventory), reads[1]?.receipt]])
    assert.equal(new Set(reads.map(row => row.receipt)).size, reads.length)
    assert.deepEqual(externalAttempts, [])
    const log = await transcript(host.client, session.id)
    assert.deepEqual(log.filter(row => row.type === "compaction").map(row => row.id), [cut.id])
    const nativeYields = log.filter(row => row.type === "idle" && row.outcome === "succeeded").map(row => row.id)
    assert.equal(nativeYields.length, stages.length + 1)
    const wire = provider.requests.map(request => {
      const schema = request.input.tools.get(algTool)
      const properties = asObject(schema?.properties)
      const actions = asObject(properties?.action)?.enum
      if (schema) assert.ok(Array.isArray(actions) && actions.every(action => typeof action === "string"))
      return { phase: request.phase, summary: request.summary, requestBytes: request.bytes, requestSha256: request.sha256,
        schemaBytes: schema ? Buffer.byteLength(JSON.stringify(schema)) : 0,
        schemaSha256: schema ? sha256(JSON.stringify(schema)) : null,
        schemaActions: schema ? actions as string[] : [], schemaFields: Object.keys(properties ?? {}),
        offeredTools: [...request.input.tools.keys()], ...wireContext(request.input) }
    })
    return { mode, projectID: project.id, sessionID: session.id, approval, elapsedMs: Math.round(performance.now() - started),
      unrelatedLedger: { before: beforeCount, after: afterCount, opens }, compaction: { id: cut.id, reason: cut.reason, summary, fromPid, toPid: host.info.pid },
      nativeYields, yieldObserved, computed, repeated, amendment: { path: changedPath, oldSourceSha, amendedSha, reopened, unaffected },
      externalAttempts: externalAttempts.length, sources: reads, stages, wire }
  } catch (error) {
    console.error(JSON.stringify({ mode, stages, error: String(error), recentWire: provider.requests.slice(-2).map(request => ({
      phase: request.phase, failure: request.failure, completion: request.completion, tools: [...request.input.tools.keys()],
      context: wireContext(request.input), tail: request.input.text.slice(-2600),
    })), hostLog: running?.process.log() }))
    throw error
  } finally {
    try { if (running && !running.process.exited()) await running.process.kill() }
    finally { provider.stop(); trap.stop(true) }
  }
}

async function run(binary: string, bundle: string, scratch: string) {
  const runtime = await runtimeIdentity(binary, bundle, await hostVersion(binary, join(scratch, "version")))
  const sourcePackage = await stageSourcePlugin(join(scratch, "source-plugin"))
  const arms: Awaited<ReturnType<typeof runArm>>[] = []
  for (const mode of modes) arms.push(await runArm(binary, bundle, runtime.bundleSha256, join(scratch, mode), mode, sourcePackage))
  const [legacy, routed, compact] = arms as [typeof arms[number], typeof arms[number], typeof arms[number]]
  const outcomes = (arm: typeof routed) => ({
    answer: arm.computed.text, repeat: arm.repeated.text, citations: [arm.computed.citation.reference, arm.computed.citation.sha256,
      arm.computed.procedure.path, arm.computed.procedure.sha256],
    calls: arm.stages.map(stage => [stage.phase, stage.calls.map(call => [call.name, asObject(call.input)?.action ?? null])]),
    sourceReads: arm.stages.map(stage => [stage.phase, stage.sources.map(read => read.path)]),
    summary: arm.compaction.summary,
  })
  const { calls: _legacyCalls, ...legacyOutcome } = outcomes(legacy)
  const { calls: _routedCalls, ...routedOutcome } = outcomes(routed)
  assert.deepEqual(legacyOutcome, routedOutcome)
  assert.deepEqual(outcomes(compact), outcomes(routed))
  assert.deepEqual(compact.wire.map(row => [row.phase, row.summary]), routed.wire.map(row => [row.phase, row.summary]))
  assert.deepEqual(compact.wire.map(row => row.schemaActions), routed.wire.map(row => row.schemaActions))
  assert.deepEqual(compact.wire.map(row => row.offeredTools), routed.wire.map(row => row.offeredTools))
  const legacyOpens = legacy.unrelatedLedger.opens
  if (legacyOpens.method === "linux-inotify") assert.ok(legacyOpens.openedPaths.some(path => path.endsWith("/investigation/head.json")),
    "The Linux ledger-open probe did not observe the legacy positive control")
  const opens = (arm: typeof routed) => arm.unrelatedLedger.opens.method === "linux-inotify" ?
    arm.unrelatedLedger.opens.openedPaths.length : null
  const routedOpenCounts = [routed, compact].map(arm => ({ mode: arm.mode, count: opens(arm) }))
  const noUnrelatedLedgerOpens = routedOpenCounts.every(row => row.count === null) ? null : routedOpenCounts.every(row => row.count === 0)
  const total = (arm: typeof routed, field: "schemaBytes" | "requestBytes", phase?: string) =>
    arm.wire.filter(row => !phase || row.phase === phase).reduce((sum, row) => sum + row[field], 0)
  const phases = [...new Set(routed.wire.map(row => row.phase))]
  const schema = (arm: typeof routed) => Object.fromEntries(phases.map(phase => [phase, total(arm, "schemaBytes", phase)]))
  assert.ok(total(compact, "schemaBytes") < total(routed, "schemaBytes"), "Compact arm did not reduce matched schema bytes")
  const harness = await Promise.all(["turn-routing-acceptance.ts", "turn-routing-acceptance-payload.ts", "turn-routing-acceptance-ledger.ts", "active-question-provider.ts",
    "active-question-source.ts", "host.ts", "../acceptance/host.ts", "../acceptance/runtime.ts"].map(async path =>
    ({ path, sha256: await fileDigest(fileURLToPath(new URL(path, import.meta.url))) })))
  assert.deepEqual(await runtimeIdentity(binary, bundle, runtime.version), runtime, "Installed bundle or executable changed during acceptance")
  return { passed: noUnrelatedLedgerOpens !== false, driver: "payload-driven local OpenCode provider", runtime, harness, arms,
    comparison: { outcomes: outcomes(routed), totals: arms.map(arm => ({ mode: arm.mode, requests: arm.wire.length,
      schemaBytes: total(arm, "schemaBytes"), requestBytes: total(arm, "requestBytes"), schemaByPhase: schema(arm) })),
    schemaBytesSaved: total(routed, "schemaBytes") - total(compact, "schemaBytes"), noUnrelatedLedgerOpens, routedOpenCounts } }
}

if (import.meta.main) {
  const [exe, staged, ...extra] = process.argv.slice(2)
  const output = extra.length === 2 && extra[0] === "--out" ? extra[1] : undefined
  if (!exe || !staged || (extra.length && !output))
    throw new Error("Usage: bun packages/v2-preview/benchmark/turn-routing-acceptance.ts <OpenCode 2.3.2 executable> <staged bundle> [--out <new JSON file>]")
  const [binary, bundle, parent] = await Promise.all([realpath(exe), realpath(staged), realpath(tmpdir())])
  const scratch = await mkdtemp(join(parent, prefix))
  try {
    const result = await run(binary, bundle, scratch)
    if (output) {
      await writeFile(output, JSON.stringify(result, null, 2) + "\n", { flag: "wx" })
      console.log(JSON.stringify({ passed: result.passed, output, runtime: result.runtime, comparison: result.comparison }))
    } else console.log(JSON.stringify(result))
    if (!result.passed) process.exitCode = 1
  }
  catch (error) {
    console.error(JSON.stringify({ passed: false, error: String(error), stack: error instanceof Error ? error.stack : undefined }))
    process.exitCode = 1
  } finally {
    const target = await realpath(scratch)
    assert.ok(dirname(target) === parent && basename(target).startsWith(prefix), "Fixture cleanup path mismatch")
    await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}

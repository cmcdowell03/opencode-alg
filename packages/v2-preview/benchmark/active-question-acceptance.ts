import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { algTool, asObject, fixtureProject, hostVersion, owner, parseObject, receiptFor, requestOptions,
  startHost, toolCalls, transcript } from "../acceptance/host.ts"
import { fileDigest, isolate, runtimeIdentity, sha256, waitFor } from "../acceptance/runtime.ts"
import { model, startActiveQuestionProvider, summary, type ResponseStep, type Wire } from "./active-question-provider.ts"
import { paths, sourcePlugin, sourceTool } from "./active-question-source.ts"
import { observeTurn, pluginId, submitTurn, type Host, type Turn } from "./host.ts"
import { textOf } from "./transport.ts"

const prefix = "alg-active-question-"
const mode = "installed-active-question-acceptance"
const approvalPath = ".opencode/bench-procedure.json"
const skillName = "pressure-trace-discrimination"
const decoyName = "control-inventory-audit"
const scope = "P-42 pressure hold, single bench trial"
const affectedId = "pressure-signal"
const unrelatedId = "control-inventory"
const ref = {
  logger: paths.logger + "#hold",
  mechanical: paths.mechanical + "#motion",
  inventory: paths.inventory + "#stock",
  calibration: paths.calibration + "#reference",
}
const prompts = {
  create: "Start an investigation of the P-42 pressure discrepancy.",
  investigate: "Compare physical restriction and logger bias using the bench evidence, and track the spare control count independently.",
  initial: "Record the narrow conclusion the current evidence supports and close this checkpoint.",
  amended: "The pressure logger record has been amended. Check what that changes.",
  resume: "Continue the investigation from the checkpoint. Revalidate what changed, then stop once the evidence supports a conclusion.",
  reuse: "What is the current conclusion? Return the already recorded result.",
}

const alg = (action: string, fields: Record<string, unknown> = {}) => ({ tool: algTool, args: { action, ...fields } })
const read = (path: string) => ({ tool: sourceTool, args: { path } })
const record = (revision: number, finding: Record<string, unknown>) => alg("record_finding", {
  finding, expected_decision_revision: revision,
})
const close = (revision: number, action: string, refs: string[], missingEvidence: string[] = []) => alg("set_next_measurement", {
  expected_decision_revision: revision, next_action: action, evidence_refs: refs,
  report_decision: { disposition: missingEvidence.length ? "indeterminate" : "resolved", missingEvidence },
})
const end = { text: "Bench checkpoint recorded." }

function object(value: unknown, label: string) {
  const row = asObject(value)
  assert.ok(row, label)
  return row
}
function rows(value: unknown, label: string) {
  assert.ok(Array.isArray(value), label)
  return value.map(row => object(row, label))
}
function result(turn: Turn, action: string) {
  const receipt = receiptFor(turn.rows, action)
  assert.ok(receipt, `Missing ${action} receipt: ${JSON.stringify(toolCalls(turn.rows))}`)
  assert.equal(receipt.value.ok, true, `Rejected ${action}: ${JSON.stringify(receipt.value)}`)
  return receipt
}
function projection(wire: Wire, state: string) {
  assert.equal(wire.projections.length, 1, "Expected one fresh active-question block in native payload")
  const graph = wire.projections[0]!
  assert.equal(graph.state, state, JSON.stringify(graph))
  return graph
}
function latestTool(wire: Wire) {
  const last = wire.messages.slice().reverse().find(message => message.role === "tool")
  const text = textOf(last?.content)
  return object(parseObject(text), `Expected native tool receipt on wire: ${text.slice(0, 500)}`)
}

async function stageSourcePlugin(directory: string) {
  const entry = fileURLToPath(new URL("./active-question-source.ts", import.meta.url))
  const build = await Bun.build({ entrypoints: [entry], target: "bun" })
  assert.ok(build.success && build.outputs.length === 1, "Fixture source plugin build failed")
  await mkdir(directory)
  await writeFile(join(directory, "index.js"), await build.outputs[0]!.text(), { flag: "wx" })
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: sourcePlugin, type: "module", exports: "./index.js" }), { flag: "wx" })
  return pathToFileURL(directory).href
}

async function run(binary: string, bundle: string, scratch: string) {
  const started = performance.now()
  const runtime = await runtimeIdentity(binary, bundle, await hostVersion(binary, join(scratch, "probe")))
  const project = await fixtureProject(scratch, "project")
  const { directory } = project
  const location = { directory }
  const audit = join(scratch, "reads.jsonl")
  const markers = Object.fromEntries(["initial", "amended", "mechanical", "inventory", "calibration", "approved", "unapproved"]
    .map(key => [key, `${key}-${randomBytes(8).toString("hex")}`]))
  const raw = (id: string, fields: Record<string, unknown>) => JSON.stringify([{ id, ...fields }])
  const original = raw("hold", { indication: "pressure drop", calibration: "assumed current", witness: markers.initial })
  const amended = raw("hold", { indication: "pressure drop", calibration: "expired", witness: markers.amended })
  const mechanical = raw("motion", { observation: "Valve travel normal; restriction remains unconfirmed.", witness: markers.mechanical })
  const inventory = raw("stock", { observation: "Two spare controls present.", witness: markers.inventory })
  const calibration = raw("reference", { observation: "Independent gauge stayed nominal while the logger alone indicated a drop.", witness: markers.calibration })
  const sources = { [paths.logger]: original, [paths.mechanical]: mechanical, [paths.inventory]: inventory, [paths.calibration]: calibration }
  for (const [path, content] of Object.entries(sources)) await writeFile(join(directory, path), content, { flag: "wx" })
  await writeFile(audit, "", { flag: "wx" })

  const skills = join(directory, ".opencode", "skills")
  const skillRelative = `.opencode/skills/${skillName}/SKILL.md`
  const skillFile = join(directory, skillRelative)
  const procedure = `# Procedure\nIf a pressure logger is invalidated, prefer the independent reference gauge.\nRevalidation source: ${paths.calibration}\nDecision rule: rule out a physical pressure drop only if the gauge stayed nominal.\nProcedure witness: ${markers.approved}`
  const stageSkill = async (name: string, description: string, body: string) => {
    const path = join(skills, name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`, { flag: "wx" })
  }
  await stageSkill(skillName, "Distinguish physical restriction from pressure logger bias.", procedure)
  await stageSkill(decoyName, "Audit the bench spare control stock.", `Recount all stock. Witness: ${markers.unapproved}`)

  const packageURL = await stageSourcePlugin(join(scratch, "source-plugin"))
  const provider = startActiveQuestionProvider()
  const attemptedIO: string[] = []
  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, fetch(request) {
    attemptedIO.push(request.method)
    return new Response("Fixture forbids nonlocal calls", { status: 403 })
  } })
  const stages: { phase: string; elapsedMs: number; generations: number; nativeTools: { name: string; id: string; status: string; input?: unknown }[] }[] = []
  let host: Host | undefined
  try {
    const env = await isolate(join(scratch, "host"))
    delete env.OPENCODE_DISABLE_FILEWATCHER
    env.PATH = dirname(Bun.which("git")!) + delimiter + env.PATH
    const configPath = join(scratch, "opencode.json")
    const proxy = `http://127.0.0.1:${trap.port}`
    const password = randomBytes(24).toString("hex")
    const settings = { env: { ...env, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: env.XDG_CONFIG_HOME,
      OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password,
      HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy, ALL_PROXY: proxy },
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } }
    const deny = { action: "*", resource: "*", effect: "deny" }
    const allow = (action: string, resource = "*") => ({ action, resource, effect: "allow" })
    const config = {
      model: `${model.providerID}/${model.id}`, default_agent: owner, update: "disable", share: "disabled",
      snapshots: false, warming: false, compaction: { auto: false, keep: { tokens: 0 } },
      providers: { [model.providerID]: { package: "@opencode/ai/providers/openai-compatible",
        name: "Active question loopback", settings: { baseURL: provider.url },
        models: { [model.id]: { name: model.id, type: "chat", limit: { context: 32768, output: 1024 }, capabilities: { tools: true } } } } },
      skills: [skills], permissions: [deny],
      agents: { [owner]: { mode: "primary", permissions: [deny,
        allow("tool.use", sourceTool), allow(sourceTool), allow("tool.use", algTool), allow(algTool),
        allow("skill.use", skillName)] } },
      plugins: [{ package: packageURL, options: { directory, audit } }] as object[],
    }
    await writeFile(configPath, JSON.stringify(config), { flag: "wx" })
    host = await startHost(binary, directory, settings)
    const bootstrap = host
    const { primary, decoy } = await waitFor(async () => {
      const catalog = (await bootstrap.client.skill.list({ location }, requestOptions())).data
      const primary = catalog.find(skill => skill.name === skillName || skill.id === skillName)
      const decoy = catalog.find(skill => skill.name === decoyName || skill.id === decoyName)
      if (primary && decoy) return { primary, decoy }
    }, 5000, "Both fixture skills must be discovered by the native host")
    assert.equal(await realpath(primary.path), await realpath(skillFile))
    assert.ok(decoy.content.includes(markers.unapproved!) && primary.content.includes(markers.approved!))
    const approved = { id: primary.id, sha256: sha256(primary.content), sourceSha256: sha256(await readFile(skillFile, "utf8")) }
    assert.ok((await host.process.kill()).signalled)
    const approval = JSON.stringify({ id: approved.id, path: skillRelative, sha256: approved.sha256, sourceSha256: approved.sourceSha256 })
    await writeFile(join(directory, approvalPath), approval, { flag: "wx" })
    config.plugins.push({ package: pathToFileURL(bundle).href, options: {
      enabled: true, ownerAgent: owner, investigationMode: "read-only", graphLoop: true, readOnlyEvidenceTools: [sourceTool],
      approvedProcedure: approvalPath, approvedProcedureSha256: sha256(approval),
    } })
    await writeFile(configPath, JSON.stringify(config))

    async function start() {
      const running = host = await startHost(binary, directory, settings)
      await waitFor(async () => {
        const all = (await running.client.plugin.list({ location }, requestOptions())).data
        const candidates = all.filter(plugin => plugin.id === pluginId || plugin.id === sourcePlugin)
        const failed = candidates.find(plugin => plugin.state.status === "failed")
        assert.ok(!failed, `Installed plugin initialization failed: ${JSON.stringify(failed)}`)
        if (candidates.length === 2 && candidates.every(plugin => plugin.state.status === "active")) return true
      }, 12_000, "Installed graph or source plugin inactive")
      assert.deepEqual((await running.client.mcp.list({ location }, requestOptions())).data, [])
      return running
    }
    let running = await start()
    const session = await running.client.session.create({ location, model, agent: owner,
      title: "Installed active question acceptance" }, requestOptions())
    assert.deepEqual([session.projectID, session.agent], [project.id, owner])
    assert.ok(!session.parentID)

    async function turn(phase: string, prompt: string, ...steps: ResponseStep[]) {
      const startTime = performance.now()
      const before = provider.requests.length
      provider.plan(phase, steps)
      const id = await submitTurn(running, session.id, prompt)
      const completed = await waitFor(() => {
        provider.assertHealthy()
        return observeTurn(running, session.id, id)
      }, 25_000, `Native turn did not finish: ${phase}`)
      provider.assertDone()
      const observed = provider.requests.slice(before)
      const nativeTools = toolCalls(completed.rows).map(call => ({ name: call.name, id: call.id, status: call.state.status,
        ...("input" in call.state && { input: call.state.input }) }))
      assert.equal(observed.length, steps.length)
      assert.equal(nativeTools.length, observed.filter(request => request.completion && "tool" in request.completion).length)
      stages.push({ phase, elapsedMs: Math.round(performance.now() - startTime), generations: observed.length, nativeTools })
      return completed
    }

    const created = result(await turn("create", prompts.create, alg("create"), end), "create").value
    assert.equal(created.runtimeSha256, runtime.bundleSha256)
    assert.equal(created.decision_revision, 0)

    const investigation = await turn("investigate", prompts.investigate, read(paths.logger), read(paths.mechanical), read(paths.inventory),
      record(0, { id: unrelatedId, interpretation: "Two spare controls are present.", scope: "Bench inventory", support: [ref.inventory], counterevidence: [] }),
      record(0, { id: affectedId, interpretation: "A physical restriction explains the pressure drop.", scope,
        support: [ref.logger], counterevidence: [ref.mechanical],
        falsifier: "A nominal independent gauge reading during a logger-only drop favors logger bias." }),
      wire => {
        const graph = projection(wire, "investigate")
        assert.equal(object(graph.finding, "Competing explanation missing from graph").id, affectedId)
        assert.ok(JSON.stringify(graph).includes(ref.logger) && JSON.stringify(graph).includes(ref.mechanical), "Competing explanations lost their different evidence")
        return { text: "Logger bias remains a competing explanation for the apparent pressure drop." }
      })
    assert.ok(toolCalls(investigation.rows).every(call => call.state.status === "completed"))

    const gap = "An independent pressure measurement is needed to distinguish a real pressure drop from logger bias."
    const stoppedAtGap = await turn("stop-with-gap", "Stop if the current evidence cannot distinguish the explanations.",
      close(0, "Wait for independent evidence on the pressure discrepancy.", [ref.logger, ref.mechanical], [gap]), wire => {
        const graph = projection(wire, "stop")
        assert.deepEqual([graph.reason, graph.decision_revision, graph.report_available], ["missing_evidence", 1, true])
        const reportDecision = asObject(asObject(latestTool(wire).decision_evidence)?.reportDecision)
        const missing = asObject(reportDecision?.decision)?.missingEvidence
        assert.deepEqual(missing, [gap])
        return { text: `Investigation stopped. ${gap}` }
      })
    const stoppedDecision = result(stoppedAtGap, "set_next_measurement")
    assert.equal(stoppedDecision.value.decision_revision, 1)

    const initial = await turn("initial-closure", prompts.initial,
      record(1, { id: affectedId, interpretation: "The logger indicated a drop during the hold.", scope,
        support: [ref.logger], counterevidence: [] }),
      close(1, "Stop at the scoped logger observation.", [ref.logger, ref.inventory]), wire => {
        assert.equal(projection(wire, "reuse").decision_revision, 2)
        return end
      })
    const initialDecision = result(initial, "set_next_measurement").value
    assert.equal(initialDecision.decision_revision, 2)
    const citation = (value: Record<string, unknown>, reference: string) => {
      const sources = rows(asObject(value.decision_evidence)?.sources, "Decision citations missing")
      return object(sources.find(citation => citation.reference === reference), `Citation missing: ${reference}`)
    }
    const oldLogger = citation(initialDecision, ref.logger)

    await writeFile(join(directory, paths.logger), amended)
    const changed = await turn("observe-change", prompts.amended, read(paths.logger), wire => {
      assert.equal(latestTool(wire).content, amended, "Native wire did not carry the changed bytes")
      const graph = projection(wire, "revalidate")
      assert.deepEqual(graph.affected_findings, [affectedId])
      assert.ok(JSON.stringify(graph).includes(ref.logger), "Revalidation lost the historical reference")
      assert.deepEqual(graph.source_revalidation, [{ path: paths.logger, state: "confirm_once" }])
      return { text: "The old logger citation needs revalidation." }
    })
    assert.equal(toolCalls(changed.rows).length, 1)

    // Manual compaction may retain the latest conversational turn even with a zero token budget.
    // Make that turn tool-free so the recovery branch has to obtain the finding and route from the ledger.
    await turn("checkpoint", "Pause here without any more tool calls.", { text: "Paused at the evidence checkpoint." })
    const cutStart = performance.now()
    const prior = new Set((await transcript(running.client, session.id)).map(row => row.id))
    provider.plan("compaction", [{ text: summary }])
    await running.client.session.compact({ sessionID: session.id, delivery: "queue" }, requestOptions())
    const cut = await waitFor(async () => {
      provider.assertHealthy()
      const log = await transcript(running.client, session.id)
      const boundary = log.find(row => row.type === "compaction" && !prior.has(row.id))
      if (boundary?.type !== "compaction") return
      assert.notEqual(boundary.status, "failed")
      if (boundary.status === "completed" && log.at(-1)?.type === "idle") return boundary
    }, 25_000, "Native compaction did not finish")
    provider.assertDone()
    stages.push({ phase: "compaction", elapsedMs: Math.round(performance.now() - cutStart), generations: 1, nativeTools: [] })
    assert.deepEqual([cut.reason, cut.summary], ["manual", summary])

    const fromPid = running.info.pid
    const stopped = await running.process.kill()
    assert.ok(stopped.signalled && running.process.exited())
    running = await start()
    assert.notEqual(running.info.pid, fromPid)
    const resumed = await running.client.session.get({ sessionID: session.id }, requestOptions())
    assert.deepEqual([resumed.id, resumed.projectID, resumed.agent], [session.id, project.id, owner])
    assert.ok((await transcript(running.client, session.id)).some(row => row.type === "compaction" &&
      row.id === cut.id && row.status === "completed" && row.summary === summary))

    const recovery = await turn("revalidate-and-close", prompts.resume,
      wire => {
        assert.ok(wire.text.includes("Resume from this manual checkpoint."))
        assert.ok(wire.text.includes(`Procedure witness: ${markers.approved}`), "First resumed request omitted approved procedure")
        for (const key of ["initial", "amended", "mechanical", "inventory", "calibration", "unapproved"]) {
          assert.ok(!wire.text.includes(markers[key]!), `Unexpected raw ${key} bytes past compaction`)
        }
        const graph = projection(wire, "revalidate")
        assert.equal(graph.procedure_sha256, approved.sha256)
        assert.deepEqual(graph.affected_findings, [affectedId])
        assert.deepEqual(graph.source_revalidation, [{ path: paths.logger, state: "confirm_once" }])
        const [confirmation] = rows(graph.source_revalidation, "Restart projection omitted source confirmation")
        return read(confirmation!.path as string)
      },
      wire => {
        assert.equal(latestTool(wire).content, amended, "Confirmation did not observe the amended bytes")
        const graph = projection(wire, "revalidate")
        assert.deepEqual(graph.source_revalidation, [{ path: paths.logger, state: "confirmed" }])
        assert.deepEqual(graph.affected_findings, [affectedId])
        const finding = object(graph.finding, "Confirmed source still needs rebinding")
        assert.equal(finding.id, affectedId)
        return alg("status", { finding_id: finding.id })
      },
      wire => {
        const status = latestTool(wire)
        assert.equal(status.decision_authority, "evidence_unavailable")
        const findings = rows(asObject(status.evidence)?.findings, "Targeted status missing finding")
        assert.equal(findings.length, 1)
        assert.deepEqual([findings[0]?.id, findings[0]?.status, findings[0]?.support], [affectedId, "unresolved", []])
        assert.deepEqual(findings[0]?.invalidatedSources, [{ relation: "support", reference: ref.logger }])
        assert.ok(wire.text.includes(`Procedure witness: ${markers.approved}`), "Approved relevant procedure omitted from wire")
        assert.ok(!wire.text.includes(markers.unapproved!), "Unapproved skill body reached provider")
        const source = /Revalidation source: ([a-z-]+\.json)/.exec(wire.text)?.[1]
        assert.equal(source, paths.calibration, "Approved procedure did not route to independent evidence")
        return read(source!)
      },
      wire => {
        const source = latestTool(wire)
        assert.equal(source.path, paths.calibration)
        assert.equal(source.content, calibration, "Independent calibration bytes absent from native payload")
        assert.equal(typeof source.content, "string")
        const measurement = rows(JSON.parse(source.content as string), "Bad calibration data")[0]!
        assert.equal(typeof measurement.observation, "string")
        return record(2, { id: affectedId, interpretation: measurement.observation, scope,
          support: [ref.logger, `${source.path}#${measurement.id}`], counterevidence: [] })
      },
      wire => {
        const update = latestTool(wire)
        assert.equal(update.ok, true)
        assert.deepEqual([update.finding_id, update.finding_status, update.outcome, update.decision_revision], [affectedId, "supported", "recorded", 2])
        return close(2, "Stop after independently revalidating the pressure finding.", [ref.logger, ref.calibration, ref.inventory])
      },
      wire => {
        const graph = projection(wire, "reuse")
        assert.deepEqual([graph.reason, graph.decision_revision], ["current_report", 3])
        return { text: "The pressure finding was independently revalidated. Investigation stopped." }
      })
    const affected = result(recovery, "status").value
    const updated = result(recovery, "record_finding")
    const closure = result(recovery, "set_next_measurement")
    assert.equal(closure.value.decision_revision, 3)
    assert.equal(closure.value.decision_authority, "receipt_bound")
    const currentLogger = citation(closure.value, ref.logger)
    assert.notEqual(currentLogger.id, oldLogger.id, "Confirmed amendment reused the old evidence receipt")
    const retainedCitation = citation(closure.value, ref.inventory)
    assert.deepEqual(retainedCitation, citation(initialDecision, ref.inventory), "Unrelated source citation changed")

    const reuse = await turn("reuse", prompts.reuse, wire => {
      const graph = projection(wire, "reuse")
      assert.deepEqual([graph.reason, graph.decision_revision], ["current_report", 3])
      return alg("render_report", { expected_decision_revision: graph.decision_revision })
    }, wire => {
      const report = latestTool(wire)
      assert.equal(report.report_authority, "owner_recorded")
      const rendered = object(report.report, "Report missing on provider payload")
      assert.equal(rendered.disposition, "resolved")
      const claims = rows(rendered.claims, "Report omitted claims")
      assert.deepEqual(claims.map(claim => claim.evidence), [[ref.inventory], [ref.logger, ref.calibration]])
      assert.equal(claims[0]?.finding, "Two spare controls are present.")
      const material = JSON.parse(calibration)[0] as { observation: string }
      assert.equal(claims[1]?.finding, material.observation)
      return { text: claims.map(claim => claim.finding).join(" ") }
    })
    const reusedReport = result(reuse, "render_report")
    assert.equal(toolCalls(reuse.rows).length, 1)
    assert.equal(reuse.text, "Two spare controls are present. " + (JSON.parse(calibration)[0] as { observation: string }).observation)

    const auditRows = (await readFile(audit, "utf8")).trim().split(/\r?\n/).map(line => object(parseObject(line), "Malformed read audit"))
    const readCalls = (await transcript(running.client, session.id)).flatMap(row => toolCalls([row])).filter(call => call.name === sourceTool)
    const expected = [paths.logger, paths.mechanical, paths.inventory, paths.logger, paths.logger, paths.calibration]
    assert.deepEqual(auditRows.map(row => row.path), expected, "Unexpected native reads or unrelated repeats")
    const unchangedReads = auditRows.filter(row => row.path !== paths.logger)
    const unchangedReadsRepeated = unchangedReads.length - new Set(unchangedReads.map(row => row.path)).size
    assert.equal(new Set(auditRows.map(row => row.receipt)).size, expected.length)
    assert.deepEqual(readCalls.map(call => call.state.status), expected.map(() => "completed"))
    for (const [index, call] of readCalls.entries()) {
      assert.equal(call.state.status, "completed")
      const content = call.state.content.find(part => part.type === "text")?.text
      const output = object(content && parseObject(content), "Malformed native source output")
      assert.deepEqual([output.path, output.receipt], [expected[index], auditRows[index]?.receipt])
    }
    for (const request of provider.requests) {
      assert.ok([...request.input.tools.keys()].every(tool => [algTool, sourceTool, "skill"].includes(tool)), "Unexpected tool offered on provider wire")
      assert.ok(!request.input.text.includes(markers.unapproved!), "Unapproved skill body present in provider history")
    }
    assert.deepEqual(attemptedIO, [], "Host attempted a nonlocal request")
    // The reopening/stop/reuse edges are measured on actual provider requests. Usage tokens in the HTTP fixture are synthetic.
    const wire = provider.requests.map((request, index) => ({ id: index + 1, phase: request.phase, summary: request.summary,
      bytes: request.bytes, sha256: request.sha256, tools: [...request.input.tools.keys()], projection: request.input.projections[0],
      approvedProcedure: request.input.text.includes(markers.approved!), compactionSummary: request.input.text.includes(summary),
      rawSourceWitnesses: ["initial", "amended", "mechanical", "inventory", "calibration"].filter(key => request.input.text.includes(markers[key]!)),
      completion: request.completion }))
    const harness = await Promise.all(["acceptance", "provider", "source"].map(async name => {
      const path = `active-question-${name}.ts`
      return { path, sha256: await fileDigest(fileURLToPath(new URL(path, import.meta.url))) }
    }))
    return { passed: true, mode, runtime, elapsedMs: Math.round(performance.now() - started),
      harness,
      localProvider: { requests: wire.length, bytes: wire.reduce((sum, row) => sum + row.bytes, 0), externalAttempts: attemptedIO.length, mode: "payload-driven scripted loopback" },
      restart: { fromPid, toPid: running.info.pid, projectId: project.id, sessionId: session.id, compactionId: cut.id, reason: cut.reason },
      procedure: { id: approved.id, sha256: approved.sha256, sourceSha256: approved.sourceSha256, decoyId: decoy.id },
      evidence: { stoppedDecision: stoppedDecision.value, amendment: { originalSha256: sha256(original), amendedSha256: sha256(amended), oldLogger, currentLogger },
        affected, updated: updated.value, closure: closure.value, retainedCitation,
        reuse: { reportCallId: reusedReport.id, report: reusedReport.value, finalAnswer: reuse.text },
        reads: auditRows.map((row, index) => ({ ...row, callId: readCalls[index]?.id })),
        unchangedReadsRepeated, reuseSourceReads: toolCalls(reuse.rows).filter(call => call.name === sourceTool).length },
      stages, wire }
  } catch (error) {
    console.error(JSON.stringify({ stages, wire: provider.requests.slice(-3).map(request => ({ phase: request.phase, failure: request.failure,
      completion: request.completion, projections: request.input.projections, tail: request.input.text.slice(-2500), tools: [...request.input.tools.keys()] })),
      hostLog: host?.process.log() }))
    throw error
  } finally {
    try { if (host && !host.process.exited()) await host.process.kill() }
    finally { provider.stop(); trap.stop(true) }
  }
}

if (import.meta.main) {
  const [exe, staged, ...extra] = process.argv.slice(2)
  if (!exe || !staged || extra.length) throw new Error("Usage: bun packages/v2-preview/benchmark/active-question-acceptance.ts <OpenCode 2.3.2 executable> <staged bundle>")
  const [binary, bundle, parent] = await Promise.all([realpath(exe), realpath(staged), realpath(tmpdir())])
  const scratch = await mkdtemp(join(parent, prefix))
  try { console.log(JSON.stringify(await run(binary, bundle, scratch))) }
  catch (error) {
    console.error(JSON.stringify({ mode, passed: false, error: String(error), ...(error instanceof Error && { stack: error.stack }) }))
    process.exitCode = 1
  } finally {
    const target = await realpath(scratch)
    assert.ok(dirname(target) === parent && basename(target).startsWith(prefix), "Fixture cleanup path mismatch")
    await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}

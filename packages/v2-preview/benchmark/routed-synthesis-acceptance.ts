import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { algTool, asObject, fixtureProject, hostVersion, owner, receiptsFor, requestOptions, startHost, toolCalls } from "../acceptance/host.ts"
import { isolate, runtimeIdentity, sha256, waitFor } from "../acceptance/runtime.ts"
import { model, startActiveQuestionProvider, type ResponseStep, type Wire } from "./active-question-provider.ts"
import { paths, sourcePlugin, sourceTool } from "./active-question-source.ts"
import { observeTurn, pluginId, submitTurn, type Host } from "./host.ts"
import { wireTextParts } from "./skill-delivery.ts"
import { ledger } from "./turn-routing-acceptance-ledger.ts"
import { latestTool, object, rows, string } from "./turn-routing-acceptance-payload.ts"

const sourcePath = paths.calibration
const reference = sourcePath + "#reference"
const original = JSON.stringify([{ id: "reference", calibration: 12 }])
const amended = JSON.stringify([{ id: "reference", calibration: 19 }])
const findings = [
  { id: "bench-calibration", interpretation: "The recorded calibration is 12.", scope: "Bench calibration",
    support: [reference], counterevidence: [] },
  { id: "independent-check", interpretation: "The independent calibration check remains open.", scope: "Independent check",
    support: [], counterevidence: [], missingEvidence: "No independent check has been received." },
]
// The installed wire contract is intentionally explicit so a schema regression fails the fixture.
const claims = findings.map(({ id }) => id)
const alg = (action: string, fields: Record<string, unknown> = {}) => ({ tool: algTool, args: { action, ...fields } })
const read = { tool: sourceTool, args: { path: sourcePath } }
const synthesis = (selected = claims, baseline?: Record<string, string>) =>
  alg("status", { synthesis: { claims: selected, ...(baseline && { baseline }) } })

function wireState(wire: Wire) {
  const tool = object(wire.tools.get(algTool), "ALG tool missing from provider request")
  const properties = object(tool.properties, "ALG tool schema missing properties")
  const actions = object(properties.action, "ALG tool schema missing action").enum
  assert.ok(Array.isArray(actions), "ALG tool schema missing action enum")
  const system = wire.messages.filter(message => message.role === "system")
    .flatMap(message => wireTextParts(message.content)).join("\n")
  return { actions, activeProjection: wire.projections.length > 0 ||
    /ALG active question(?: delta)? \(untrusted recorded data\)/.test(system) ||
    /ALG recovers the active question|Use the current active question|Revalidate only the affected findings|Stop this investigation loop|Reuse the current decision revision/.test(system) }
}

function wireSynthesis(wire: Wire) {
  const receipt = latestTool(wire)
  assert.equal(receipt.ok, true)
  return object(receipt.synthesis, "Missing provider-visible synthesis")
}

async function run(binary: string, bundle: string, scratch: string) {
  const runtime = await runtimeIdentity(binary, bundle, await hostVersion(binary, join(scratch, "version")))
  const project = await fixtureProject(scratch, "project")
  const { directory } = project
  const location = { directory }
  const source = join(directory, sourcePath)
  const audit = join(scratch, "reads.jsonl")
  const configPath = join(scratch, "opencode.json")
  const sourcePackage = join(scratch, "source-plugin")
  const build = await Bun.build({ entrypoints: [fileURLToPath(new URL("./active-question-source.ts", import.meta.url))], target: "bun" })
  assert.ok(build.success && build.outputs.length === 1, "Source fixture build failed")
  await mkdir(sourcePackage)
  await Promise.all([
    writeFile(join(sourcePackage, "index.js"), await build.outputs[0]!.text()),
    writeFile(join(sourcePackage, "package.json"), JSON.stringify({ name: sourcePlugin, type: "module", exports: "./index.js" })),
    writeFile(source, original), writeFile(audit, ""),
  ])
  const env = await isolate(join(scratch, "host"))
  delete env.OPENCODE_DISABLE_FILEWATCHER
  const git = Bun.which("git")
  assert.ok(git)
  env.PATH = dirname(git) + delimiter + env.PATH
  const password = randomBytes(24).toString("hex")
  const provider = startActiveQuestionProvider()
  const externalAttempts: string[] = []
  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, fetch(request) {
    externalAttempts.push(request.method)
    return new Response(null, { status: 403 })
  } })
  let running: Host | undefined
  try {
    const proxy = "http://127.0.0.1:" + trap.port
    const settings = { env: { ...env, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: env.XDG_CONFIG_HOME,
      OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password,
      HTTP_PROXY: proxy, http_proxy: proxy, HTTPS_PROXY: proxy, https_proxy: proxy, ALL_PROXY: proxy, all_proxy: proxy },
    headers: { authorization: "Basic " + Buffer.from("opencode:" + password).toString("base64") } }
    const deny = { action: "*", resource: "*", effect: "deny" }
    const allow = (action: string, resource = "*") => ({ action, resource, effect: "allow" })
    await writeFile(configPath, JSON.stringify({
      model: model.providerID + "/" + model.id, default_agent: owner, update: "disable", share: "disabled",
      snapshots: false, warming: false, compaction: { auto: false },
      providers: { [model.providerID]: { package: "@opencode/ai/providers/openai-compatible", name: "Local synthesis fixture",
        settings: { baseURL: provider.url }, models: { [model.id]: { name: model.id, type: "chat",
          limit: { context: 32768, output: 1024 }, capabilities: { tools: true } } } } },
      permissions: [deny], agents: { [owner]: { mode: "primary", permissions: [deny,
        allow("tool.use", sourceTool), allow(sourceTool), allow("tool.use", algTool), allow(algTool)] } },
      plugins: [
        { package: pathToFileURL(sourcePackage).href, options: { directory, audit } },
        { package: pathToFileURL(bundle).href, options: { enabled: true, ownerAgent: owner, investigationMode: "read-only",
          graphLoop: true, turnRouting: "routed-compact", readOnlyEvidenceTools: [sourceTool] } },
      ],
    }))
    async function start() {
      const host = running = await startHost(binary, directory, settings)
      await waitFor(async () => {
        const plugins = (await host.client.plugin.list({ location }, requestOptions())).data
          .filter(plugin => plugin.id === pluginId || plugin.id === sourcePlugin)
        assert.ok(!plugins.some(plugin => plugin.state.status === "failed"), JSON.stringify(plugins))
        return plugins.length === 2 && plugins.every(plugin => plugin.state.status === "active") ? true : undefined
      }, 12_000, "Fixture and installed V2 plugins did not activate")
      assert.deepEqual((await host.client.mcp.list({ location }, requestOptions())).data, [])
      return host
    }
    let host = await start()
    const session = await host.client.session.create({ location, model, agent: owner, title: "Routed status synthesis" }, requestOptions())
    assert.deepEqual([session.projectID, session.agent, session.parentID ?? null], [project.id, owner, null])
    const stages: { phase: string; promptId: string; answerId: string; requests: number; text: string }[] = []
    async function turn(phase: string, prompt: string, ...steps: ResponseStep[]) {
      const before = provider.requests.length
      provider.plan(phase, steps)
      const promptId = await submitTurn(host, session.id, prompt)
      const completed = await waitFor(() => {
        provider.assertHealthy()
        return observeTurn(host, session.id, promptId)
      }, 25_000, "No completed native turn: " + phase)
      provider.assertDone()
      const requests = provider.requests.length - before
      assert.equal(requests, steps.length)
      stages.push({ phase, promptId, answerId: completed.id, requests, text: completed.text })
      return completed
    }

    let revision: unknown
    const saved = await turn("retain", "Investigate the bench calibration and record the independent evidence gap.",
      alg("create"), wire => {
        const created = latestTool(wire)
        assert.deepEqual([created.ok, created.runtimeSha256], [true, runtime.bundleSha256])
        revision = created.decision_revision
        return read
      }, wire => {
        assert.equal(latestTool(wire).content, original)
        return alg("record_finding", { finding: findings[0], expected_decision_revision: revision })
      }, wire => {
        assert.equal(latestTool(wire).finding_status, "supported")
        return alg("record_finding", { finding: findings[1], expected_decision_revision: revision })
      }, wire => {
        assert.equal(latestTool(wire).finding_status, "unresolved")
        return { text: "Findings recorded." }
      })
    assert.deepEqual(receiptsFor(saved.rows, "record_finding").map(row => [row.value.ok, row.value.finding_status]),
      [[true, "supported"], [true, "unresolved"]])

    const single = synthesis([findings[0]!.id])
    const beforeSingleReads = await readFile(audit, "utf8")
    const sufficient = await turn("single-claim", "Reopen the retained investigation and answer only the saved calibration claim with its reference.",
      alg("create"), wire => {
        assert.deepEqual([latestTool(wire).ok, latestTool(wire).decision_revision], [true, revision])
        assert.ok(wireState(wire).actions.includes("record_finding"), "Create did not expose the active compact schema")
        return single
      }, wire => {
        const result = wireSynthesis(wire)
        assert.equal(result.nextMove, "answer-selected")
        assert.equal(result.truncated, false)
        const [claim, ...extraClaims] = rows(result.claims, "Missing selected claim")
        assert.deepEqual(extraClaims, [])
        assert.deepEqual([claim?.id, claim?.state], [findings[0]!.id, "supported-scoped"])
        const [citation] = rows(claim?.support, "Missing selected citation")
        const value = /calibration is (\d+)\./.exec(string(claim?.interpretation, "Missing retained interpretation"))?.[1]
        assert.ok(value, "Missing calibration value in the retained interpretation")
        return { text: `Calibration: ${value} (${string(citation?.reference, "Missing citation reference")}).` }
      })
    assert.equal(sufficient.text, `Calibration: 12 (${reference}).`)
    assert.deepEqual(toolCalls(sufficient.rows).map(call => [call.name, asObject("input" in call.state && call.state.input)?.action]),
      [[algTool, "create"], [algTool, "status"]])
    const singleReceipts = receiptsFor(sufficient.rows, "status")
    assert.equal(singleReceipts.length, 1)
    assert.deepEqual(singleReceipts[0]!.input, single.args)
    assert.equal(await readFile(audit, "utf8"), beforeSingleReads)
    const singleWire = provider.requests.filter(request => request.phase === "single-claim")
    const postSynthesis = wireState(singleWire.at(-1)!.input)
    assert.equal(postSynthesis.activeProjection, false, "Synthesis left the active graph projected")
    assert.ok(!postSynthesis.actions.includes("record_finding"), "Synthesis left record_finding in the compact schema")

    const prompt = "Use status to synthesize the saved bench calibration and independent check claims."
    async function recall(phase: string, expected: string[], baseline?: Record<string, string>, changes?: string[]) {
      const before = await ledger(directory)
      const beforeReads = await readFile(audit, "utf8")
      const call = synthesis(claims, baseline)
      const completed = await turn(phase, prompt, call, wire => {
        const result = wireSynthesis(wire)
        const entries = rows(result.claims, "Missing provider-visible claims")
        if (result.nextMove === "recheck") {
          const { changes } = result
          assert.ok(Array.isArray(changes))
          const reopened = entries.filter((row, index) => row.state === "invalidated" && changes[index] === "changed")
          assert.equal(reopened.length, 1)
          return { text: `Reopened ${string(reopened[0]!.id, "Missing reopened claim ID")}; recheck required.` }
        }
        assert.equal(result.nextMove, "scoped-indeterminate")
        const missing = entries.find(row => row.state === "missing")
        return { text: `Cannot resolve the selected claims. ${string(missing?.missingEvidence, "Missing retained evidence gap")}` }
      })
      assert.equal(completed.text, expected.includes("invalidated")
        ? `Reopened ${findings[0]!.id}; recheck required.`
        : `Cannot resolve the selected claims. ${findings[1]!.missingEvidence}`)
      const receipts = receiptsFor(completed.rows, "status")
      assert.equal(receipts.length, 1)
      const [receipt] = receipts
      assert.deepEqual(receipt!.input, call.args)
      const result = object(receipt!.value.synthesis, "Missing native status synthesis")
      const entries = rows(result.claims, "Missing synthesized claims")
      assert.deepEqual(entries.map(row => [row.id, row.state]), claims.map((id, index) => [id, expected[index]]))
      assert.deepEqual(result.changes, changes)
      assert.equal(result.nextMove, expected.includes("invalidated") ? "recheck" : "scoped-indeterminate")
      assert.equal(result.truncated, false)
      assert.equal(entries[1]!.missingEvidence, findings[1]!.missingEvidence)
      for (const row of entries) assert.match(String(row.signature), /^[a-f0-9]{64}$/)
      const supported = entries[0]!
      if (supported.state === "supported-scoped") {
        assert.deepEqual(rows(supported.support, "Missing live citation").map(row => [row.reference, row.sha256]),
          [[reference, sha256(original)]])
      } else {
        assert.equal(supported.support, undefined)
        assert.deepEqual(supported.invalidated, [{ relation: "support", reference }])
      }
      const requests = provider.requests.filter(request => request.phase === phase)
      assert.ok(requests.every(request => request.input.projections.length === 0), "Status recall projected the active graph")
      assert.deepEqual(await ledger(directory), before, "Status synthesis changed the ledger")
      assert.equal(await readFile(audit, "utf8"), beforeReads, "Status synthesis repeated a source read")
      return result
    }
    const initial = await recall("before-restart", ["supported-scoped", "missing"])
    const beforeRestart = await ledger(directory)
    const fromPid = host.info.pid
    assert.ok((await host.process.kill()).signalled && host.process.exited())
    host = await start()
    assert.notEqual(host.info.pid, fromPid)
    const resumed = await host.client.session.get({ sessionID: session.id }, requestOptions())
    assert.deepEqual([resumed.id, resumed.projectID, resumed.agent], [session.id, project.id, owner])
    assert.deepEqual(await ledger(directory), beforeRestart)
    const resumedSynthesis = await recall("after-restart", ["supported-scoped", "missing"])
    assert.deepEqual(resumedSynthesis, initial)

    await writeFile(source, amended)
    await turn("observe-change", "Resume the bench investigation and read the corrected calibration source.",
      alg("create"), read, wire => {
        assert.equal(latestTool(wire).content, amended)
        // A native status call flushes the observed tool read before the separate recall turn.
        return alg("status", { finding_id: findings[0]!.id })
      }, wire => {
        assert.equal(latestTool(wire).ok, true)
        return { text: "Correction observed." }
      })
    const baseline = Object.fromEntries(rows(initial.claims, "Missing baseline claims")
      .map(row => [String(row.id), String(row.signature)]))
    const changed = await recall("after-observed-change", ["invalidated", "missing"], baseline, ["changed", "unchanged"])
    const sources = (await readFile(audit, "utf8")).trim().split(/\r?\n/).map(line => JSON.parse(line))
    assert.deepEqual(sources.map(row => row.path), [sourcePath, sourcePath])
    assert.equal(new Set(sources.map(row => row.receipt)).size, 2)
    assert.deepEqual(externalAttempts, [])
    assert.deepEqual(await runtimeIdentity(binary, bundle, runtime.version), runtime)
    return { passed: true, runtime, stages, sessionID: session.id, fromPid, toPid: host.info.pid,
      contentSha256: sha256(JSON.stringify({ claims, findings, original, amended })),
      singleClaim: { text: sufficient.text, postSynthesis, result: singleReceipts[0]!.value.synthesis },
      initial, resumed: resumedSynthesis, changed, sources, externalAttempts: externalAttempts.length }
  } catch (error) {
    console.error(JSON.stringify({ error: String(error), hostLog: running?.process.log(),
      lastRequests: provider.requests.slice(-3).map(({ phase, completion, failure }) => ({ phase, completion, failure })) }))
    throw error
  } finally {
    try { if (running && !running.process.exited()) await running.process.kill() }
    finally { provider.stop(); trap.stop(true) }
  }
}

if (import.meta.main) {
  const [exe, staged, flag, output, ...extra] = process.argv.slice(2)
  if (!exe || !staged || flag !== "--out" || !output || extra.length)
    throw new Error("Usage: bun packages/v2-preview/benchmark/routed-synthesis-acceptance.ts <OpenCode 2.3.2 executable> <staged bundle> --out <new JSON file>")
  const [binary, bundle] = await Promise.all([realpath(exe), realpath(staged)])
  const scratch = await mkdtemp(join(await realpath(tmpdir()), "alg-routed-synthesis-"))
  try {
    const report = await run(binary, bundle, scratch)
    await writeFile(output, JSON.stringify(report, null, 2) + "\n", { flag: "wx" })
    console.log(JSON.stringify({ passed: report.passed, runtime: report.runtime, contentSha256: report.contentSha256 }))
  } finally {
    await rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
  }
}

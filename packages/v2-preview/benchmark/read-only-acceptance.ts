import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { algTool, asObject, fixtureProject, hostVersion, owner, parseObject, receiptFor, requestOptions,
  startHost, toolCalls, transcript } from "../acceptance/host.ts"
import { isolate, runtimeIdentity, sha256, waitFor } from "../acceptance/runtime.ts"
import { observeTurn, pluginId, submitTurn, type Host, type Turn } from "./host.ts"
import { endText, model, startReadOnlyProvider, summaryText } from "./read-only-acceptance-provider.ts"
import { nativeReview, reviewAgent, reviewFinding, reviewRules } from "./read-only-acceptance-review.ts"
import { changedNotes, fixturePluginId, forbiddenTool, originalNotes, paths, samples, sourceTool } from "./read-only-acceptance-source.ts"
import { textOf, type Completion } from "./transport.ts"

const scenarios = ["stable", "absent", "changed", "coexisting"] as const
type Scenario = typeof scenarios[number]
const prefix = "alg-read-only-acceptance-"
const seal = paths.samples + "#seal"
const drift = paths.samples + "#drift"
const scope = "Fixture bench P-42"
const positive = "Unit P-42 passed the pressure hold."
const driftFinding = "Sensor drift remains material during warmup."
const nextAction = "Repeat the pressure hold with a calibrated reference sensor."
const renderPrompt = "Render the investigation report."
const unacknowledgedReport = "REPORT_REQUIRES_ACKNOWLEDGED_DISPOSITION"
const remoteActions = ["admit", "dispatch", "reconcile", "start", "read", "result", "revoke"]
const allowedActions = ["create", "status", "set_next_measurement", "procedure", "record_finding", "render_report"]
const deny = { action: "*", resource: "*", effect: "deny" }
const allow = (action: string, resource = "*") => ({ action, resource, effect: "allow" })

const alg = (action: string, fields: Record<string, unknown> = {}): Completion => ({ tool: algTool, args: { action, ...fields } })
const read = (path: string): Completion => ({ tool: sourceTool, args: { path } })
const decide = (revision: number, evidence_refs: string[], resolved = false): Completion =>
  alg("set_next_measurement", { expected_decision_revision: revision, next_action: nextAction, evidence_refs,
    ...(resolved && { report_decision: { disposition: "resolved", missingEvidence: [] } }) })

type Row = Record<string, unknown>
function object(value: unknown, label: string): Row {
  const row = asObject(value)
  assert.ok(row, label)
  return row
}
function rows(value: unknown, label: string): Row[] {
  assert.ok(Array.isArray(value), label)
  return value.map(row => object(row, label))
}
function valueOf(turn: Turn, action: string): Row {
  const receipt = receiptFor(turn.rows, action)
  assert.ok(receipt, `Missing native ${action} receipt: ${JSON.stringify(turn.rows)}`)
  return receipt.value
}
function readOnlyStatus(turn: Turn, revision: number) {
  const status = valueOf(turn, "status")
  assert.equal(status.ok, true)
  assert.equal(status.investigationMode, "read-only")
  assert.equal(status.decision_revision, revision)
  assert.equal(status.work, null)
  return { decision: object(status.decision, "Persisted decision"), evidence: object(status.evidence, "Persisted evidence"),
    decisionEvidence: status.decision_evidence, authority: status.decision_authority }
}

async function stageSources(directory: string) {
  const output = await Bun.build({ entrypoints: [fileURLToPath(new URL("./read-only-acceptance-source.ts", import.meta.url))], target: "bun" })
  assert.ok(output.success && output.outputs.length === 1, "Fixture tool bundle failed")
  await mkdir(directory)
  await writeFile(join(directory, "index.js"), await output.outputs[0]!.text(), { flag: "wx" })
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: fixturePluginId, type: "module", exports: "./index.js",
  }), { flag: "wx" })
  return pathToFileURL(directory).href
}

function checkSchema(requests: ReturnType<typeof startReadOnlyProvider>["requests"]) {
  const offered = new Set<string>()
  for (const request of requests) {
    if (request.summary || request.phase === "native-review") continue
    const names = [...request.tools.keys()]
    assert.ok(names.every(name => [algTool, sourceTool, "skill"].includes(name)), `Unexpected native tools in ${request.phase}: ${names}`)
    const source = object(request.tools.get(sourceTool), "Native source schema missing")
    assert.deepEqual(source.required, ["path"])
    assert.deepEqual(asObject(asObject(source.properties)?.path)?.enum, Object.values(paths))
    assert.equal(source.additionalProperties, false)
    if (request.phase === "permission-denied") {
      assert.ok(!request.tools.has(algTool), "Denied role was offered the ALG tool")
      continue
    }
    const schema = object(request.tools.get(algTool), `Missing ALG schema in ${request.phase}`)
    const fields = object(schema.properties, "Missing ALG input fields")
    const actions = asObject(fields.action)?.enum
    assert.deepEqual(schema.required, ["action"])
    assert.equal(schema.additionalProperties, false)
    assert.ok(Array.isArray(actions) && actions.length > 0 && actions.every(action => allowedActions.includes(action)),
      `Unexpected read-only action schema: ${JSON.stringify(actions)}`)
    actions.forEach(action => offered.add(action))
    for (const field of ["runId", "result", "citation", "refutation"])
      assert.ok(!(field in fields), `Remote-only input leaked in schema: ${field}`)
    if (actions.includes("set_next_measurement")) {
      assert.equal(asObject(fields.expected_decision_revision)?.type, "integer")
      assert.equal(asObject(fields.evidence_refs)?.type, "array")
    }
    if ("tool" in request.completion && request.completion.tool === algTool &&
        !remoteActions.includes(String(request.completion.args.action))) {
      assert.ok(actions.includes(request.completion.args.action),
        `The native request did not offer its exercised action: ${request.completion.args.action}`)
    }
  }
  return [...offered].sort()
}

function checkSourceBindings(status: ReturnType<typeof readOnlyStatus>, sources: readonly { path: string; content: string; refs: string[] }[],
  observed: readonly Turn[]) {
  const evidence = rows(status.evidence.sources, "Source index absent")
  assert.deepEqual(evidence.map(source => source.path).sort(), sources.map(source => source.path).sort())
  for (const expected of sources) {
    const source = evidence.find(row => row.path === expected.path)!
    assert.equal(source.status, "inspected")
    assert.equal(source.sha256, sha256(expected.content))
    const consumed = observed.flatMap(turn => toolCalls(turn.rows)).filter(call => {
      if (call.name !== sourceTool || call.state.status !== "completed") return false
      return call.state.content.some(part => part.type === "text" && parseObject(part.text)?.receipt === source.receipt)
    })
    assert.equal(consumed.length, 1, "Evidence needs a unique completed native read")
    assert.equal(consumed[0]?.id, source.callId)
    const references = rows(source.references, "Reference index absent")
    for (const ref of expected.refs) {
      const receipt = references.find(row => row.reference === ref)
      assert.ok(receipt && receipt.sha256 === source.sha256 && receipt.receipt === source.receipt &&
        receipt.callId === source.callId && typeof receipt.id === "string", `Citation is not read-bound: ${ref}`)
    }
  }
}

type ReportExpectation = { disposition: string; claims: { finding: string; scope: string; evidence: string[] }[]; missingEvidence: string[] }
function checkReport(value: unknown, expected: ReportExpectation) {
  const report = object(typeof value === "string" ? parseObject(value) : value, "Invalid structured report")
  assert.deepEqual(report, expected)
  return report
}

async function verifyCommand(host: Host, sessionID: string, directory: string, revision: number, expected: ReportExpectation) {
  const before = await transcript(host.client, sessionID)
  const ids = new Set(before.map(row => row.id))
  const inbox = () => host.client.session.inbox.list({ sessionID }, requestOptions())
  const priorInbox = new Set((await inbox()).map(item => item.id))
  const catalog = await host.client.command.list({ location: { directory } }, requestOptions())
  assert.ok(catalog.data.some(command => command.name === "alg-report"), "Native report command not registered")
  const diagnostics = async (error: unknown) => {
    const delta = (await transcript(host.client, sessionID)).filter(row => !ids.has(row.id))
    const files = [...new Bun.Glob(".opencode/runs/*/reports/*.json").scanSync({ cwd: directory, dot: true })]
    throw new Error(`Native report command: ${String(error)} ${JSON.stringify({ error, delta, files, inbox: await inbox() })}`)
  }
  await host.client.session.command({ sessionID, name: "alg-report", text: "", delivery: "queue" }, requestOptions()).catch(diagnostics)
  const notice = await waitFor(async () => {
    const queued = (await inbox()).find(item => !priorInbox.has(item.id) && item.type === "synthetic" &&
      asObject(item.payload.metadata?.algReport))
    if (queued?.type === "synthetic") {
      assert.equal(queued.sessionID, sessionID)
      assert.equal(queued.delivery, "queue")
      return { id: queued.id, metadata: queued.payload.metadata, via: "native-inbox" }
    }
    const delta = (await transcript(host.client, sessionID)).filter(row => !ids.has(row.id))
    const delivered = delta.find(row => row.type === "synthetic" && asObject(row.metadata?.algReport))
    if (delivered) return { id: delivered.id, metadata: delivered.metadata, via: "native-transcript" }
  }, 6_000, "No native synthetic report receipt").catch(diagnostics)
  await host.client.experimental.session.wait({ sessionID }, requestOptions()).catch(diagnostics)
  const delta = (await transcript(host.client, sessionID)).filter(row => !ids.has(row.id))
  assert.ok(delta.every(row => row.type === "idle" || row.id === notice.id), "Report command generated a session turn")
  const receipt = object(notice.metadata?.algReport, "Missing native report metadata")
  const { path, sha256: digest } = receipt
  assert.equal(receipt.version, 1)
  assert.equal(receipt.revision, revision)
  assert.equal(receipt.authority, "owner_recorded")
  assert.ok(Number.isSafeInteger(receipt.evidenceRevision), "Native report missing evidence revision")
  assert.ok(typeof path === "string" && /^[\w.-]+(?:\/[\w.-]+)+$/.test(path) &&
    !path.split("/").some(part => part === "." || part === "..") && path.endsWith(".json"))
  const filename = join(directory, path)
  assert.ok((await lstat(filename)).isFile(), "Command report isn't a regular file")
  const resolved = await realpath(filename)
  const fromProject = relative(directory, resolved)
  assert.ok(fromProject && !isAbsolute(fromProject) && !fromProject.split(sep).includes(".."), "Command report escaped the fixture")
  const bytes = await readFile(resolved, "utf8")
  assert.equal(sha256(bytes), digest)
  const report = checkReport(JSON.parse(bytes), expected)
  return { id: notice.id, via: notice.via, path, sha256: digest, revision, evidenceRevision: receipt.evidenceRevision,
    authority: receipt.authority, report }
}

async function verifyCommandRefusal(host: Host, sessionID: string, directory: string) {
  const before = await transcript(host.client, sessionID)
  const inboxBefore = await host.client.session.inbox.list({ sessionID }, requestOptions())
  await assert.rejects(host.client.session.command({ sessionID, name: "alg-report", text: "", delivery: "queue" }, requestOptions()),
    error => asObject(error)?._tag === "CommandExecutionError" && (error as Error).message === unacknowledgedReport)
  await host.client.experimental.session.wait({ sessionID }, requestOptions())
  assert.deepEqual(await transcript(host.client, sessionID), before, "Refused command emitted transcript data")
  assert.deepEqual(await host.client.session.inbox.list({ sessionID }, requestOptions()), inboxBefore,
    "Refused command emitted a native inbox receipt")
  assert.deepEqual([...new Bun.Glob(".opencode/runs/*/reports/*.json").scanSync({ cwd: directory, dot: true })], [],
    "Refused command emitted a report file")
  return unacknowledgedReport
}

async function run(binary: string, bundle: string, scenario: Scenario, scratch: string) {
  const project = await fixtureProject(scratch, "project")
  const runtime = await runtimeIdentity(binary, bundle, await hostVersion(binary, join(scratch, "probe")))
  const directory = project.directory
  const location = { directory }
  const audit = join(scratch, "reads.jsonl")
  await Promise.all([
    writeFile(join(directory, paths.notes), originalNotes, { flag: "wx" }),
    writeFile(join(directory, paths.samples), samples, { flag: "wx" }),
    writeFile(audit, "", { flag: "wx" }),
  ])
  const packageURL = await stageSources(join(scratch, "source-plugin"))
  const provider = startReadOnlyProvider()
  const attemptedIO: { method: string; path: string }[] = []
  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, development: false, fetch(request) {
    attemptedIO.push({ method: request.method, path: new URL(request.url).pathname })
    return new Response("Outbound call denied by fixture", { status: 403 })
  } })
  let host: Host | undefined
  try {
    const trapUrl = `http://127.0.0.1:${trap.port}`
    const pass = randomBytes(24).toString("hex")
    const env = await isolate(join(scratch, "host"))
    const git = Bun.which("git")!
    const configPath = join(scratch, "opencode.json")
    const hostEnv = { ...env,
      PATH: dirname(git) + delimiter + env.PATH, OPENCODE_CONFIG: configPath, OPENCODE_CONFIG_DIR: env.XDG_CONFIG_HOME,
      OPENCODE_SERVER_PASSWORD: pass, OPENCODE_PASSWORD: pass,
      HTTP_PROXY: trapUrl, HTTPS_PROXY: trapUrl, http_proxy: trapUrl, https_proxy: trapUrl,
    }
    const settings = { env: hostEnv, headers: { authorization: "Basic " + Buffer.from("opencode:" + pass).toString("base64") } }
    const config = {
      model: model.providerID + "/" + model.id, default_agent: owner, update: "disable", share: "disabled",
      snapshots: false, warming: false, compaction: { auto: false },
      providers: { [model.providerID]: { package: "@opencode/ai/providers/openai-compatible",
        name: "Read-only acceptance fixture", settings: { baseURL: provider.url },
        models: { [model.id]: { name: model.id, type: "chat", limit: { context: 32768, output: 1024 }, capabilities: { tools: true } } } } },
      plugins: [
        { package: packageURL, options: { directory, audit, trap: trapUrl } },
        { package: pathToFileURL(bundle).href,
          options: { enabled: true, ownerAgent: owner, investigationMode: "read-only", readOnlyEvidenceTools: [sourceTool],
            ...(scenario === "coexisting" && { readOnlyCacheSourceBytes: true, checkerAgent: reviewAgent }) } },
      ],
      permissions: [deny],
      agents: { [owner]: { mode: "primary", permissions: [deny,
        allow("tool.use", sourceTool), allow(sourceTool), allow("tool.use", algTool), allow(algTool)] },
        ...(scenario === "coexisting" && { [reviewAgent]: { mode: "subagent", permissions: reviewRules } }) },
    }
    await writeFile(configPath, JSON.stringify(config), { flag: "wx" })
    async function start() {
      const running = host = await startHost(binary, directory, settings)
      await waitFor(async () => {
        const plugins = (await running.client.plugin.list({ location }, requestOptions())).data
        const targets = plugins.filter(item => item.id === pluginId || item.id === fixturePluginId)
        const failed = targets.find(row => row.state.status === "failed")
        assert.ok(!failed, `Native plugin failed: ${JSON.stringify(failed)}`)
        if (targets.length === 2 && targets.every(row => row.state.status === "active")) return true
      }, 12_000, "Installed preview or source fixture inactive")
      assert.deepEqual((await running.client.mcp.list({ location }, requestOptions())).data, [])
      return running
    }
    let running = await start()
    const session = await running.client.session.create({ location, model, agent: owner,
      title: "Installed read-only acceptance" }, requestOptions())
    assert.equal(session.projectID, project.id)
    assert.equal(session.agent, owner)
    assert.ok(!session.parentID)

    async function turn(phase: string, script: Completion[], prompt: string, id = session.id) {
      provider.plan(phase, [...script, { text: endText }])
      const message = await submitTurn(running, id, prompt)
      const result = await waitFor(() => {
        provider.assertHealthy()
        return observeTurn(running, id, message)
      }, 20_000, `No completed native turn for ${phase}`)
      provider.assertDone()
      assert.equal(result.text, endText)
      if (phase === "create") {
        const request = provider.requests.find(row => row.phase === phase)
        assert.ok(request?.tools.has(algTool), `Create tool missing on native wire: ${JSON.stringify([...request?.tools.keys() ?? []])}`)
      }
      return result
    }

    const created = valueOf(await turn("create", [alg("create")], "Create a read-only investigation."), "create")
    assert.equal(created.ok, true)
    assert.equal(created.runtimeSha256, runtime.bundleSha256)
    assert.equal(created.decision_revision, 0)
    assert.equal(created.investigationMode, "read-only")
    assert.equal(created.work, null)

    if (scenario === "stable") {
      const deniedSession = await running.client.session.create({ location, model, agent: owner, title: "Denied tool control", permissions: [
        { action: "tool.use", resource: algTool, effect: "deny" }, { action: algTool, resource: "*", effect: "deny" },
      ] }, requestOptions())
      const denied = await turn("permission-denied", [alg("status")], "Try the restricted investigation tool.", deniedSession.id)
      assert.ok(!receiptFor(denied.rows, "status")?.value.ok, "Session override failed to deny native ALG")
      const remote = await turn("remote-denied", [{ tool: forbiddenTool, args: {} }, ...remoteActions.map(action => alg(action))],
        "Try to send an external measurement and retrieve its result.")
      for (const action of remoteActions) {
        const receipt = receiptFor(remote.rows, action)?.value
        const call = toolCalls(remote.rows).find(part => "input" in part.state && asObject(part.state.input)?.action === action)
        assert.ok((receipt?.ok === false && receipt.error === "READ_ONLY_ACTION_UNAVAILABLE") || call?.state.status === "error",
          `Remote action escaped native rejection: ${action}`)
      }
      assert.deepEqual(attemptedIO, [], "Remote actions reached the network trap")
    }

    const sourcePath = scenario === "absent" ? paths.absent : paths.notes
    const refs = scenario === "coexisting" ? [paths.notes, seal, drift] : [sourcePath]
    const initial = await turn("inspect", [read(sourcePath), ...(scenario === "coexisting" ? [read(paths.samples)] : [])],
      "Inspect the fixture source data.")
    const sourceResults = toolCalls(initial.rows).filter(call => call.name === sourceTool)
    assert.equal(sourceResults.length, scenario === "coexisting" ? 2 : 1)
    assert.ok(sourceResults.every(call => call.state.status === "completed"))
    if (scenario === "absent") assert.ok(sourceResults.some(call => call.state.status === "completed" &&
      call.state.content.some(part => part.type === "text" && parseObject(part.text)?.error === "SOURCE_ABSENT")))
    const revision = scenario === "absent" ? 0 : 1
    const close = scenario === "coexisting"
    let expectedReport: ReportExpectation | undefined
    if (scenario === "stable" || scenario === "coexisting") {
      const claims: ReportExpectation["claims"] = [{ finding: positive, scope, evidence: [paths.notes] }]
      // Explicit closure selects the first finding for review. Use one JSON row so the scope can be checked exactly.
      if (close) claims.unshift({ finding: driftFinding, scope: scope + " warmup", evidence: [drift] })
      for (const [index, claim] of claims.entries()) {
        const finding = valueOf(await turn("finding", [alg("record_finding", {
          expected_decision_revision: 0, finding: {
            id: close && index === 0 ? reviewFinding : "finding-" + (index + 1),
            interpretation: claim.finding, scope: claim.scope,
            support: claim.evidence, counterevidence: [],
          },
        })], "Record a finding based on the inspected evidence."), "record_finding")
        assert.equal(finding.ok, true)
      }
      expectedReport = { disposition: close ? "resolved" : "indeterminate", claims, missingEvidence: [] }
    }
    const decision = valueOf(await turn("decision", [decide(0, refs, close)], close
      ? "Record the next measurement and acknowledge the resolved report as my decision."
      : "Record the next measurement using the inspected evidence."), "set_next_measurement")
    if (revision) {
      assert.equal(decision.ok, true)
      assert.equal(decision.decision_revision, revision)
      assert.equal(asObject(decision.decision)?.next_action, nextAction)
    } else assert.equal(decision.ok, false, "A missing source grounded a decision")
    if (scenario === "changed") {
      await writeFile(join(directory, paths.notes), changedNotes)
      const changed = await turn("changed-source", [read(paths.notes)], "Inspect the amended fixture document.")
      assert.ok(toolCalls(changed.rows).some(call => call.name === sourceTool && call.state.status === "completed" &&
        call.state.content.some(part => part.type === "text" && parseObject(part.text)?.content === changedNotes)))
      const stale = valueOf(await turn("stale-citation", [decide(1, refs)], "Try to cite the changed document again."),
        "set_next_measurement")
      assert.equal(stale.ok, false, "A changed source grounded a new decision")
    }
    const before = readOnlyStatus(await turn("checkpoint", [alg("status")], "Check the saved investigation decision."), revision)
    if (!revision) assert.deepEqual(rows(before.evidence.sources, "Missing evidence index"), [])
    else assert.equal(before.decision.next_action, nextAction)
    assert.equal(before.authority, scenario === "absent" ? "no_decision" :
      scenario === "changed" ? "evidence_unavailable" : "receipt_bound")
    if (revision) {
      const bound = rows(asObject(before.decisionEvidence)?.sources, "Decision must pin the cited receipts")
      assert.deepEqual(bound.map(source => source.reference), refs)
      assert.ok(bound.every(source => typeof source.id === "string" && /^[a-f0-9]{64}$/.test(source.id)))
      if (scenario !== "changed") {
        const index = rows(before.evidence.sources, "Source index absent").flatMap(source =>
          rows(source.references, "Reference index absent"))
        assert.ok(bound.every(source => index.some(receipt => source.id === receipt.id && source.reference === receipt.reference)),
          "Decision cited a different receipt than the inspected source")
      }
      const reportDecision = asObject(asObject(before.decisionEvidence)?.reportDecision)
      if (close) assert.deepEqual(reportDecision?.decision, { disposition: "resolved", missingEvidence: [] })
      else assert.equal(reportDecision, undefined)
    }

    if (scenario === "changed") {
      const sources = rows(before.evidence.sources, "Changed source index")
      assert.equal(sources.length, 1)
      assert.equal(sources[0]?.path, paths.notes)
      assert.equal(sources[0]?.status, "changed")
      assert.deepEqual(sources[0]?.references, [])
    } else checkSourceBindings(before, scenario === "absent" ? [] : [
      { path: paths.notes, content: originalNotes, refs: [paths.notes] },
      ...(scenario === "coexisting" ? [{ path: paths.samples, content: samples, refs: [seal, drift] }] : []),
    ], [initial])

    const preCut = new Set((await transcript(running.client, session.id)).map(row => row.id))
    provider.plan("compaction", [{ text: summaryText }])
    await running.client.session.compact({ sessionID: session.id, delivery: "queue" }, requestOptions())
    const cut = await waitFor(async () => {
      provider.assertHealthy()
      const log = await transcript(running.client, session.id)
      const boundary = log.find(row => row.type === "compaction" && !preCut.has(row.id))
      if (boundary?.type !== "compaction") return
      assert.notEqual(boundary.status, "failed")
      if (boundary.status === "completed" && log.at(-1)?.type === "idle") return boundary
    }, 20_000, "Native compaction did not complete")
    provider.assertDone()
    assert.equal(cut.reason, "manual")
    assert.equal(cut.summary, summaryText)
    const fromPid = running.info.pid
    const stopped = await running.process.kill()
    assert.ok(stopped.signalled && running.process.exited())
    running = await start()
    assert.notEqual(running.info.pid, fromPid)
    const resumed = await running.client.session.get({ sessionID: session.id }, requestOptions())
    assert.deepEqual([resumed.id, resumed.projectID, resumed.agent], [session.id, session.projectID, owner])
    assert.ok((await transcript(running.client, session.id)).some(row => row.type === "compaction" &&
      row.id === cut.id && row.status === "completed" && row.summary === summaryText))

    const readBytes = await readFile(audit, "utf8")
    const readAttempts = readBytes.trim().split(/\r?\n/).map(line => object(parseObject(line), "Invalid source audit entry"))
    const expectedReads = scenario === "coexisting" ? [paths.notes, paths.samples] :
      scenario === "changed" ? [paths.notes, paths.notes] : [sourcePath]
    assert.deepEqual(readAttempts.map(attempt => attempt.path), expectedReads)
    assert.equal(new Set(readAttempts.map(attempt => attempt.receipt)).size, expectedReads.length)
    const continuation = await turn("after-restart", [alg("status")], "What is the current decision and its evidence?")
    const after = readOnlyStatus(continuation, revision)
    assert.deepEqual(after, before, "Decision or evidence changed across native compaction and restart")
    assert.ok(toolCalls(continuation.rows).every(call => call.name === algTool))
    const resumedRequest = provider.requests.find(row => row.phase === "after-restart")
    assert.ok(resumedRequest)
    const wire = resumedRequest.messages.map(message => textOf(message.content)).join("\n")
    assert.ok(wire.includes("Await a follow-up request."), "Resumed model request missed the actual compaction")
    assert.ok(!wire.includes("obs-A57") && !wire.includes("obs-B91"), "Raw Markdown survived into the resumed request")

    let review: Awaited<ReturnType<typeof nativeReview>> | undefined
    if (close) {
      review = await nativeReview(running, provider, resumed, directory, after.evidence.revision)
      const reviewStatus = valueOf(await turn("review-status", [alg("status")], "Check the recorded scoped review."), "status")
      assert.deepEqual(reviewStatus.checkerReview, { status: "recorded", workerSessionId: review.childId,
        decisionRevision: review.decisionRevision, evidenceRevision: review.evidenceRevision,
        findingId: review.findingId, result: review.result })
      assert.equal(reviewStatus.decision_revision, revision)
      assert.deepEqual(reviewStatus.decision_evidence, after.decisionEvidence)
      assert.equal(await readFile(audit, "utf8"), readBytes, "Native review repeated a source read")
    }

    const report = valueOf(await turn("render-report", [alg("render_report", { expected_decision_revision: revision })],
      renderPrompt), "render_report")
    if (expectedReport) {
      assert.equal(report.ok, true)
      assert.equal(report.decision_revision, revision)
      assert.equal(report.report_authority, close ? "owner_recorded" : "provisional")
      assert.equal(report.provisional_reason, close ? undefined : "closure_decision_unrecorded")
      checkReport(report.report, expectedReport)
      checkReport(report.text, expectedReport)
    } else assert.equal(report.ok, false, "Unavailable evidence should block report rendering")
    assert.equal(await readFile(audit, "utf8"), readBytes, "A source was re-read after restart")

    let command: Awaited<ReturnType<typeof verifyCommand>> | undefined
    let commandRefusal: string | undefined
    const providerRequests = provider.requests.length
    if (close && expectedReport) {
      command = await verifyCommand(running, session.id, directory, revision, expectedReport)
      assert.equal(command.evidenceRevision, report.evidenceRevision)
    } else if (scenario === "stable") {
      commandRefusal = await verifyCommandRefusal(running, session.id, directory)
    }
    provider.assertDone()
    const commandModelRequests = provider.requests.length - providerRequests
    assert.equal(commandModelRequests, 0, "Native report command invoked a model")
    assert.equal(await readFile(audit, "utf8"), readBytes, "Native report command repeated a source read")
    assert.deepEqual(attemptedIO, [], "Unexpected adapter or remote traffic")
    const actions = checkSchema(provider.requests)
    const remoteRequestsRejected = provider.requests.filter(row =>
      row.phase === "remote-denied" && "tool" in row.completion).length
    return { passed: true, scenario, runtime, actions, initialSourceReads: readAttempts.length, repeatedSourceReads: 0,
      remoteCalls: attemptedIO.length, ...(scenario === "stable" && { remoteRequestsRejected, nativePermissionDenial: true }),
      decisionRevision: revision, decisionAuthority: after.authority, decisionEvidence: after.decisionEvidence,
      citations: refs.filter(() => revision > 0 && scenario !== "changed"),
      restart: { fromPid, toPid: running.info.pid, sessionId: session.id, compactionId: cut.id },
      report: report.ok === true ? { authority: report.report_authority, data: report.report } : { refused: report.error },
      ...(review && { review }),
      ...(command || commandRefusal ? { command, commandRefusal, commandModelRequests } : {}) }
  } finally {
    try { if (host && !host.process.exited()) await host.process.kill() }
    finally { provider.stop(); trap.stop(true) }
  }
}

export async function readOnlyAcceptance(args: string[]) {
  const [binary, bundle, selected, ...extra] = args
  if (!binary || !bundle || extra.length || (selected && !scenarios.some(scenario => scenario === selected)))
    throw new Error("Usage: bun packages/v2-preview/benchmark/read-only-acceptance.ts <OpenCode 2.3.2 executable> <staged bundle> [stable|absent|changed|coexisting]")
  const [executable, staged, parent] = await Promise.all([realpath(binary), realpath(bundle), realpath(tmpdir())])
  for (const scenario of selected ? [selected as Scenario] : scenarios) {
    const scratch = await mkdtemp(join(parent, prefix))
    try {
      console.log(JSON.stringify({ mode: "installed-read-only-acceptance", ...await run(executable, staged, scenario, scratch) }))
    } catch (error) {
      console.error(JSON.stringify({ mode: "installed-read-only-acceptance", scenario, passed: false,
        error: error instanceof Error ? error.stack : String(error) }))
      process.exitCode = 1
    } finally {
      const target = await realpath(scratch)
      assert.ok(dirname(target) === parent && basename(target).startsWith(prefix), "Fixture cleanup path mismatch")
      await rm(target, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 })
    }
  }
}

if (import.meta.main) await readOnlyAcceptance(process.argv.slice(2))

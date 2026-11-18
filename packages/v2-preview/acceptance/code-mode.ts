import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterPrompt, hostSettings, hostVersion, model, requestOptions, startHost, toolCalls } from "./host.ts"
import { startProvider } from "./provider.ts"
import { fileDigest } from "./runtime.ts"
import { generateFabEvidence } from "../benchmark/case.ts"
import { createWorkbench, startWorkbench } from "../benchmark/workbench.ts"

const serverName = "lake"
const readTool = "research_workbench"
const hostTool = serverName + "_" + readTool
const agent = "lake-analyst"
const positivePrompt = "CODE_MODE_LAKE_FIXTURE: Return only a bounded inspection and dispatch summary."
const negativePrompt = "CODE_MODE_LAKE_DENIAL: Test the denied fixture operations."
const pageLimit = 8
const maxSummaryBytes = 400
const allow = (action: string, resource = "*") => ({ action, resource, effect: "allow" })
const deny = (action: string, resource = "*") => ({ action, resource, effect: "deny" })
const forbidden = ["scan_unbounded", "write_table"] as const

const rolePolicy = [
  deny("*"), allow("execute"), allow("tool.use", "execute"), allow("mcp.use", serverName),
  allow(hostTool), allow("tool.use", hostTool),
  ...forbidden.flatMap(tool => [deny(serverName + "_" + tool), deny("tool.use", serverName + "_" + tool)]),
]

// The trap tools are advertised by this fixture's MCP server, but have no side effects.
// Workbench discovery, reads, bounds and receipts still run through the original MCP endpoint.
function startLake(endpoint: string) {
  const deniedCalls: string[] = []
  let lists = 0
  const trapTools = forbidden.map(name => ({
    name, description: "Denied synthetic fixture operation",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }))
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, development: false, maxRequestBodySize: 16 * 1024,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/mcp") return new Response(null, { status: 405 })
      const body = await request.json() as { id?: string | number; method?: string; params?: { name?: string } }
      const name = body.params?.name
      if (body.method === "tools/call" && name && forbidden.some(tool => tool === name)) {
        deniedCalls.push(name)
        return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "Fixture policy denied" } })
      }
      const response = await fetch(endpoint, { method: "POST", headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
      }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) })
      if (body.method !== "tools/list" || !response.ok) return response
      const catalog = await response.json() as { result: { tools: unknown[] } }
      catalog.result.tools.push(...trapTools)
      lists++
      return Response.json(catalog)
    },
  })
  return { endpoint: `http://127.0.0.1:${server.port}/mcp`, deniedCalls, get lists() { return lists }, stop: () => server.stop(true) }
}

const unpack = `const unpack = value => {
  if (value?.status) return value;
  if (value?.structuredContent?.status) return value.structuredContent;
  const parts = Array.isArray(value) ? value : value?.content;
  const text = typeof value === "string" ? value : parts?.find(part => part.type === "text")?.text;
  return JSON.parse(text);
};`
const lookup = { op: "lookup", pages: [{ source: "inspection", limit: pageLimit }, { source: "dispatch", limit: pageLimit }] }
const aggregateCode = `
const catalog = unpack(await tools.lake.research_workbench({ op: "map" }));
if (catalog.status !== "ok" || !["inspection", "dispatch"].every(source => catalog.sources.some(entry => entry.source === source))) {
  throw Error("Required fixture sources unavailable");
}
const result = unpack(await tools.lake.research_workbench(${JSON.stringify(lookup)}));
if (result.status !== "ok" || result.pages.length !== 2) throw Error("Read failed");
const inspections = result.pages.find(page => page.source === "inspection");
const dispatch = result.pages.find(page => page.source === "dispatch");
if (inspections.rows.length > ${pageLimit} || dispatch.rows.length > ${pageLimit}) throw Error("Rows exceed limit");
return {
  inspected: inspections.rows.length,
  defects: inspections.rows.filter(row => row.defect).length,
  dispatchCount: dispatch.rows.length,
  evidenceRefs: [inspections.evidenceRef, dispatch.evidenceRef],
  witness: inspections.rows.reduce((sum, row) => sum + row.recordedMinute, 0),
};`
const denialCode = `
const denied = [];
try { await tools.lake.scan_unbounded({}); } catch { denied.push("scan_unbounded"); }
try { await tools.lake.write_table({}); } catch { denied.push("write_table"); }
return { denied };`
const rowValues = /\b(?:W0[1-6]|L7[1-6])\b/
const rowFields = /\b(?:recordedMinute|dispatchedMinute|nextCursor|rows)\b/

function expectedSummary() {
  const fixture = generateFabEvidence()
  const inspections = fixture.inspection.slice(0, pageLimit)
  return {
    inspected: inspections.length,
    defects: inspections.filter(row => row.defect).length,
    dispatchCount: fixture.dispatch.slice(0, pageLimit).length,
    witness: inspections.reduce((sum, row) => sum + row.recordedMinute, 0),
  }
}

async function run(binary: string, scratch: string) {
  await hostVersion(binary, scratch)
  const workbench = createWorkbench({ maxAcceptedQueries: 1 })
  const evidence = startWorkbench(workbench)
  const lake = startLake(evidence.endpoint)
  const observed: { kind: "positive" | "negative"; toolMessages: unknown[]; tools: readonly string[]; rowVisible: boolean }[] = []
  let catalogText = ""
  let directToolNames: readonly string[] = []
  const provider = startProvider(turn => {
    const prompt = turn.messages.filter(message => message.role === "user").at(-1)?.content
    const kind = JSON.stringify(prompt)?.includes(negativePrompt) ? "negative" : "positive"
    const toolMessages = turn.messages.filter(message => message.role === "tool")
    observed.push({ kind, toolMessages, tools: turn.tools, rowVisible: rowValues.test(JSON.stringify(turn.messages)) })
    if (toolMessages.length) return { text: "Fixture complete" }
    catalogText = JSON.stringify(turn.messages)
    directToolNames = turn.tools
    if (!turn.tools.includes("execute")) return { text: "Native execute unavailable" }
    return { tool: "execute", args: { code: kind === "positive" ? unpack + aggregateCode : denialCode } }
  })
  let host: Awaited<ReturnType<typeof startHost>> | undefined
  try {
    const settings = await hostSettings(scratch, provider.url)
    const configPath = settings.env.OPENCODE_CONFIG!
    const config = JSON.parse(await Bun.file(configPath).text())
    Object.assign(config, {
      default_agent: agent, experimental: { full_codemode: true },
      mcp: { servers: { [serverName]: { type: "remote", url: lake.endpoint, oauth: false, codemode: true, protocol: "legacy" } } },
      agents: { [agent]: { mode: "primary", permissions: rolePolicy } },
    })
    await writeFile(configPath, JSON.stringify(config))
    host = await startHost(binary, scratch, settings)
    const location = { directory: scratch }
    for (const prompt of [positivePrompt, negativePrompt]) {
      const session = await host.client.session.create({ location, agent, model, title: "Code Mode fixture" }, requestOptions())
      await host.client.session.prompt({ sessionID: session.id, text: prompt, delivery: "queue" }, requestOptions())
      const turn = await afterPrompt(host.client, session.id, prompt, 25_000)
      const idle = turn.at(-1)
      assert(idle?.type === "idle" && idle.outcome === "succeeded", "Expected a successful durable turn")
      assert(!rowValues.test(JSON.stringify(turn)), "Intermediate row values reached the durable transcript")
      const calls = toolCalls(turn)
      if (calls.length !== 1 || calls[0]?.name !== "execute" || calls[0].state.status !== "completed") {
        throw new Error(JSON.stringify({ reason: "Native execute did not complete", calls, directToolNames,
          catalog: catalogText.slice(-5000), providerErrors: provider.errors }, null, 2))
      }
      const output = calls[0].state.content
      const text = output.length === 1 && output[0]?.type === "text" ? output[0].text : undefined
      assert(text && Buffer.byteLength(text) <= maxSummaryBytes, "Expected one bounded execute result")
      const result = JSON.parse(text)
      const requests = observed.filter(request => request.kind === (prompt === positivePrompt ? "positive" : "negative"))
      const [first, next] = requests
      assert.equal(requests.length, 2, "Expected an initial and a follow-up provider request")
      assert(first && next && first.toolMessages.length === 0)
      assert(!requests.some(request => request.rowVisible), "Intermediate row values reached the provider request")
      assert.equal(next.toolMessages.length, 1)
      assert(JSON.stringify(next.toolMessages).includes(JSON.stringify(text).slice(1, -1)), "Next provider request did not include the exact result")
      assert.doesNotMatch(JSON.stringify(next.toolMessages), rowFields)
      for (const { tools } of requests) {
        for (const name of [...forbidden, hostTool, "bash", "write"]) assert(!tools.includes(name) &&
          !tools.includes(serverName + "_" + name), "Denied or raw tool exposed")
      }
      if (prompt === positivePrompt) {
        const snapshot = workbench.snapshot()
        assert.equal(snapshot.acceptedQueries, 1)
        const [mapped, admitted] = snapshot.receipts
        assert.deepEqual(snapshot.receipts.map(receipt => [receipt.scope, receipt.outcome]), [["root", "mapped"], ["root", "admitted"]])
        assert.equal(mapped?.queryId, null)
        assert.deepEqual(admitted?.pages.map(page => [page.source, page.offset, page.rows]), [
          ["inspection", 0, pageLimit], ["dispatch", 0, pageLimit],
        ])
        assert.deepEqual(result, { ...expectedSummary(), evidenceRefs: admitted?.evidenceRefs })
      } else {
        assert.deepEqual(result, { denied: [...forbidden] })
        assert(lake.lists > 0, "Fixture never advertised the forbidden tools")
        assert.deepEqual(lake.deniedCalls, [], "A forbidden call reached the MCP server")
        assert.equal(workbench.snapshot().calls, 2)
      }
      console.log(JSON.stringify({ probe: prompt === positivePrompt ? "aggregate" : "permission_denial",
        bytes: Buffer.byteLength(text), result, nativeTool: calls[0].name,
        nextProviderToolMessages: next.toolMessages.length, intermediateRowsVisible: false }, null, 2))
    }
    assert.deepEqual(provider.errors, [])
    console.log(JSON.stringify({ verdict: "NATIVE_CODE_MODE_PASSED", version: host.info.version,
      binarySha256: await fileDigest(binary), providerRequests: observed.length,
      forbiddenMcpCalls: lake.deniedCalls.length, workbench: workbench.snapshot() }, null, 2))
  } finally {
    try { await host?.process.kill() } finally {
      provider.stop()
      lake.stop()
      evidence.stop()
    }
  }
}

if (import.meta.main) {
  const [flag, binary, ...rest] = process.argv.slice(2)
  if (flag !== "--host" || !binary || rest.length) throw new Error("Usage: bun packages/v2-preview/acceptance/code-mode.ts --host <native OpenCode 2.3.2>")
  const parent = await realpath(process.env.ALG_CODE_MODE_TMP ?? tmpdir())
  const scratch = await mkdtemp(join(parent, "alg-code-mode-"))
  try { await run(resolve(binary), scratch) } finally {
    if (dirname(await realpath(scratch)) !== parent) throw new Error("Unexpected probe scratch location")
    await rm(scratch, { recursive: true, force: true })
  }
}

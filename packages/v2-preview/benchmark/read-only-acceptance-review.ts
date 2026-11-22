import assert from "node:assert/strict"
import { algTool, asObject, parseObject, receiptFor, requestOptions, toolCalls, transcript } from "../acceptance/host.ts"
import { sha256, waitFor } from "../acceptance/runtime.ts"
import { observeTurn, type Host } from "./host.ts"
import { endText, type startReadOnlyProvider } from "./read-only-acceptance-provider.ts"
import { paths, samples, sourceTool } from "./read-only-acceptance-source.ts"
import { wireTextParts } from "./skill-delivery.ts"

export const reviewTool = "alg_read_only_review"
export const reviewAgent = "fixture-read-only-reviewer"
export const reviewRules = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "tool.use", resource: reviewTool, effect: "allow" },
  { action: reviewTool, resource: "*", effect: "allow" },
] as const
export const reviewFinding = "warmup-drift"
const citation = paths.samples + "#drift"
const verdict = {
  outcome: "supports",
  citations: [citation],
  analysis: "The recorded warmup row supports drift above the stated floor within this fixture run.",
}

export async function nativeReview(host: Host, provider: ReturnType<typeof startReadOnlyProvider>,
  owner: Awaited<ReturnType<Host["client"]["session"]["get"]>>, directory: string, evidenceRevision: unknown,
  citedReceipt: Record<string, unknown>) {
  const { client } = host
  const location = { directory }
  const catalog = await client.command.list({ location }, requestOptions())
  assert.ok(catalog.data.some(command => command.name === "alg-review"), "Native review command not registered")
  const children = () => client.session.list({ parentID: owner.id }, requestOptions())
  assert.deepEqual((await children()).data, [], "Owner already had a checker child before the command")
  const ownerBefore = new Set((await transcript(client, owner.id)).map(row => row.id))
  const providerOffset = provider.requests.length

  // Only the native command creates the child and supplies its prompt.
  provider.plan("native-review", [
    { tool: reviewTool, args: { action: "submit", ...verdict } }, { text: endText },
    { tool: algTool, args: { action: "status" } }, { text: endText },
  ])
  await client.session.command({ sessionID: owner.id, name: "alg-review", text: "", delivery: "queue" }, requestOptions())
  const child = await waitFor(async () => {
    provider.assertHealthy()
    const found = (await children()).data
    assert.ok(found.length <= 1, "Native review started multiple children")
    return found[0]
  }, 10_000, "Native command did not create a child")
  assert.match(child.id, /^ses_algrv_1_[a-f0-9]{32}$/)
  assert.deepEqual([child.parentID, child.projectID, child.agent, child.model],
    [owner.id, owner.projectID, reviewAgent, owner.model])
  assert.deepEqual(child.permissions, reviewRules)

  const { prompt, result } = await waitFor(async () => {
    provider.assertHealthy()
    const prompts = (await transcript(client, child.id)).filter(row => row.type === "user")
    assert.ok(prompts.length <= 1, "Native review admitted multiple child prompts")
    const prompt = prompts[0]
    if (!prompt) return
    const result = await observeTurn(host, child.id, prompt.id)
    if (result) return { prompt, result }
  }, 20_000, "Native checker did not complete").catch(async error => {
    const childRows = await transcript(client, child.id)
    const requests = provider.requests.slice(providerOffset).map(request => [...request.tools.keys()])
    throw new Error(`Native checker: ${String(error)}; ${JSON.stringify({ requests, childRows })}`)
  })
  assert.equal(result.text, endText)
  const binding = child.metadata?.algReadOnlyReview
  assert.ok(typeof binding === "string" && /^[a-f0-9]{64}$/.test(binding))
  assert.equal(prompt.metadata?.algReadOnlyReview, binding)
  const packet = asObject(parseObject(prompt.text.split("\n").at(-1) ?? ""))
  assert.equal(asObject(packet?.selected)?.findingId, reviewFinding)
  assert.equal(packet?.residual, undefined)
  const snapshot = asObject(packet?.snapshot)
  assert.equal(snapshot?.revision, evidenceRevision)
  assert.equal(snapshot?.trust, "untrusted-source-data")
  assert.deepEqual(snapshot?.missing, [])
  assert.ok(Array.isArray(snapshot?.evidence))
  assert.equal(snapshot.evidence.length, 1, "Checker received extra sources or rows")
  const entry = asObject(snapshot.evidence[0])
  assert.equal(entry?.kind, "json-row")
  assert.deepEqual(entry?.data, JSON.parse(samples).find((row: { id: string }) => row.id === "drift"))
  const source = asObject(entry?.source)
  assert.equal(source?.reference, citation)
  assert.equal(source?.sha256, sha256(samples))
  assert.deepEqual(source, citedReceipt, "Checker snapshot was not bound to the original native read")

  const wire = provider.requests.slice(providerOffset)
  assert.equal(wire.slice(0, 2).length, 2)
  for (const request of wire.slice(0, 2)) {
    assert.deepEqual([...request.tools.keys()], [reviewTool])
    const schema = request.tools.get(reviewTool)
    assert.deepEqual(schema?.required, ["action", "outcome", "citations", "analysis"])
    assert.equal(schema?.additionalProperties, false)
    const userText = request.messages.filter(message => message.role === "user").flatMap(message => wireTextParts(message.content))
    assert.deepEqual(userText, [prompt.text])
  }
  const calls = toolCalls(result.rows)
  assert.equal(calls.length, 1)
  const call = calls[0]
  assert.ok(call?.name === reviewTool && call.state.status === "completed", JSON.stringify(calls))
  assert.deepEqual(call.state.input, { action: "submit", ...verdict })
  const text = call.state.content.find(part => part.type === "text")?.text
  assert.deepEqual(parseObject(text ?? ""), { recorded: true, findingId: reviewFinding, outcome: verdict.outcome })
  // OpenCode wakes the owner on completion of its direct child. Read the verdict
  // in that native continuation, without a test-harness owner prompt.
  const status = await waitFor(async () => {
    provider.assertHealthy()
    const delta = (await transcript(client, owner.id)).filter(row => !ownerBefore.has(row.id))
    assert.ok(delta.every(row => row.type !== "user"), "Native review submitted an owner prompt")
    const idle = delta.at(-1)
    if (idle?.type !== "idle") return
    assert.equal(idle.outcome, "succeeded")
    const ownerCalls = toolCalls(delta)
    assert.deepEqual(ownerCalls.map(part => part.name), [algTool], "Native continuation called another owner tool")
    return receiptFor(delta, "status")?.value
  }, 20_000, "Native owner continuation did not read the review verdict")
  provider.assertDone()
  const ownerWire = provider.requests.slice(providerOffset + 2)
  assert.equal(ownerWire.length, 2)
  for (const request of ownerWire) {
    assert.ok(request.tools.has(algTool) && [...request.tools.keys()].every(name => [algTool, sourceTool, "skill"].includes(name)))
    assert.ok(request.messages.some(message => message.role === "user" && wireTextParts(message.content).some(text =>
      text.includes(`<subagent sessionID="${child.id}" state="completed"`))), "Owner continuation missed the native child notice")
  }
  const review = { ...verdict, attribution: "independent-model-review" }
  assert.deepEqual(status.checkerReview, { status: "recorded", workerSessionId: child.id,
    decisionRevision: 1, evidenceRevision, findingId: reviewFinding, result: review })

  return { status, receipt: { launch: "native-command", childId: child.id, promptId: prompt.id, verdictCallId: call.id,
    cachedReferences: [citation], decisionRevision: 1, evidenceRevision, findingId: reviewFinding,
    childModelRequests: 2, ownerContinuationRequests: ownerWire.length, result: review } }
}

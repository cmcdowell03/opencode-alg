import { expect, test } from "bun:test"
import { endText, model, startReadOnlyProvider, summaryText } from "./read-only-acceptance-provider.ts"
import { forbiddenTool } from "./read-only-acceptance-source.ts"

test("the fixture can emit an unadvertised tool call for the real host to reject", async () => {
  const provider = startReadOnlyProvider()
  try {
    const completion = { tool: forbiddenTool, args: {} }
    provider.plan("permission", [completion, { text: endText }])
    const request = () => fetch(provider.url + "/chat/completions", {
      method: "POST", body: JSON.stringify({ model: model.id, messages: [], tools: [], stream: false }),
    })
    const first = await request()
    expect(first.status).toBe(200)
    expect((await first.json()).choices[0].message.tool_calls[0].function.name).toBe(forbiddenTool)
    expect(provider.requests[0]!.tools.has(forbiddenTool)).toBe(false)
    expect((await (await request()).json()).choices[0].message.content).toBe(endText)
    provider.assertDone()
  } finally { provider.stop() }
})

test("the fixture fails if report delivery starts an extra model turn", async () => {
  const provider = startReadOnlyProvider()
  try {
    provider.plan("render-report", [{ text: endText }])
    const request = () => fetch(provider.url + "/chat/completions", {
      method: "POST", body: JSON.stringify({ model: model.id, messages: [], stream: true }),
    })
    expect(await (await request()).text()).toContain(endText)
    provider.assertDone()
    const extra = await request()
    expect(extra.status).toBe(409)
    expect(() => provider.assertDone()).toThrow("Unscheduled model generation")
  } finally { provider.stop() }
})

test("the compaction summary supplies no decision or source witness", () => {
  expect(summaryText).toContain("Refer to the host ledger.")
  expect(summaryText).not.toMatch(/obs-[AB]|inspection-notes|sample-counts|pressure hold/i)
})

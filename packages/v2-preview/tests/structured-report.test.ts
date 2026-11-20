import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import type { CommandDefinition } from "@opencode/plugin/promise/command"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { registerReportCommand, renderInvestigationReport } from "../src/structured-report.ts"

const report = {
  claims: [{ scope: "lot A", finding: "Gauge confirms the excursion", evidence: ["gauge.json#A"] }],
  missingEvidence: [], disposition: "resolved",
}

test("the JSON contract includes only the requested fields, in stable order", () => {
  expect(renderInvestigationReport(report)).toBe('{"disposition":"resolved","claims":[{"finding":"Gauge confirms the excursion","scope":"lot A","evidence":["gauge.json#A"]}],"missingEvidence":[]}')
  for (const invalid of [
    { ...report, disposition: "maybe" }, { ...report, extra: 1 }, { ...report, claims: [] },
    { ...report, missingEvidence: ["shift log"] }, { ...report, claims: [{ ...report.claims[0], evidence: [] }] },
  ]) expect(() => renderInvestigationReport(invalid)).toThrow("REPORT_CONTRACT_INVALID")
  expect(JSON.parse(renderInvestigationReport({ disposition: "indeterminate", claims: [], missingEvidence: ["shift log"] }))).toEqual({
    disposition: "indeterminate", claims: [], missingEvidence: ["shift log"],
  })
})

test("an explicit export publishes the exact bytes, does not wake the model and detects a conflicting receipt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "alg-report-"))
  let command: CommandDefinition | undefined
  type Send = Plugin.Context["session"]["synthetic"]
  const sends: Parameters<Send>[0][] = []
  let authorized = true
  try {
    await registerReportCommand({
      command: { transform: async fn => {
        fn({ add: value => { command = value } })
        return { dispose: async () => {} }
      } },
      session: { synthetic: (async (input: Parameters<Send>[0]) => { sends.push(input) }) as unknown as Send },
    }, directory, async sessionID => {
      expect(String(sessionID)).toBe("ses_owner")
      if (!authorized) throw new Error("OWNER_REQUIRED")
      return { runId: "test-owner", revision: 2, report }
    })
    expect(command?.name).toBe("alg-report")
    const invoke = () => command!.execute({ sessionID: "ses_owner", prompt: { text: "" }, delivery: "queue" } as Parameters<CommandDefinition["execute"]>[0])
    await invoke()
    await invoke()
    expect(sends).toHaveLength(2)
    const sent = sends[0]!
    expect(sent.resume).toBe(false)
    const artifact = sent.metadata?.algReport as { path: string; sha256: string; revision: number }
    const path = join(directory, artifact.path)
    const bytes = await readFile(path)
    expect(artifact.revision).toBe(2)
    expect(bytes.toString()).toBe(renderInvestigationReport(report) + "\n")
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(artifact.sha256)
    await writeFile(path, bytes.toString().trimEnd())
    await expect(invoke()).rejects.toThrow("REPORT_REVISION_CONFLICT")
    authorized = false
    await expect(invoke()).rejects.toThrow("OWNER_REQUIRED")
    expect(sends).toHaveLength(2)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

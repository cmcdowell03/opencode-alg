import { afterEach, expect, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { analyzeRetentionFile } from "../scripts/build-benchmark-retention-cli.ts"
import { tempProject, removeProject } from "./helpers.ts"

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) removeProject(directory) })
function paths() {
  const directory = tempProject("alg-retention-cli-")
  directories.push(directory)
  return { input: join(directory, "input.json"), output: join(directory, "report.json") }
}

test("offline retention preserves unknown measurement and never overwrites evidence", () => {
  const { input, output } = paths()
  writeFileSync(input, JSON.stringify({ schema: "alg-retention-input-v1", events: [
    { eventId: "start", at: 0, taskId: "task", sessionId: "session", type: "task_window", stage: "start" },
    { eventId: "end", at: 1_000, taskId: "task", sessionId: "session", type: "task_window", stage: "end" },
  ], expectedFacts: [] }))
  const receipt = analyzeRetentionFile(input, output)
  expect(receipt.eventCount).toBe(2)
  expect(receipt.taskCount).toBe(1)
  const original = readFileSync(output)
  const report = JSON.parse(original.toString())
  expect(report.tasks[0].compactionRates.successful.perObservedElapsedHour).toBeNull()
  expect(report.tasks[0].facts.lossClaim).toBe("untested")
  expect(report.provenance).toContain("not_independently_authenticated")
  expect(report.inputSha256).toMatch(/^[a-f0-9]{64}$/)
  expect(() => analyzeRetentionFile(input, output)).toThrow()
  expect(readFileSync(output).equals(original)).toBe(true)
})

test("invalid or self-overwriting input produces no measurement receipt", () => {
  const { input, output } = paths()
  writeFileSync(input, JSON.stringify({ schema: "alg-retention-input-v1", events: [], expectedFacts: [], modelSaysPassed: true }))
  expect(() => analyzeRetentionFile(input, output)).toThrow("retention_input_invalid")
  expect(existsSync(output)).toBe(false)
  expect(() => analyzeRetentionFile(input, input)).toThrow("retention_output_must_be_new")
})

test("invalid boundary evidence fails before creating a report", () => {
  const { input, output } = paths()
  writeFileSync(input, JSON.stringify({ schema: "alg-retention-input-v1", events: [], expectedFacts: [], boundaries: {
    schema: "build-benchmark-retention-boundaries/v1", boundaries: [{ bogus: true }], observations: [],
  } }))
  expect(() => analyzeRetentionFile(input, output)).toThrow("retention_boundary_evidence_invalid")
  expect(existsSync(output)).toBe(false)
})

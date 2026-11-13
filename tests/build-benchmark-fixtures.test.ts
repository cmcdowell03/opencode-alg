import { describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { BENCHMARK_CASES, scoreBenchmarkCase, scoreBenchmarkPreparation } from "../scripts/build-benchmark-fixtures.ts"

async function projectFromFixture(index: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "alg-build-benchmark-fixture-"))
  for (const [relative, content] of Object.entries(BENCHMARK_CASES[index]!.files)) {
    const destination = resolve(root, relative)
    await mkdir(join(destination, ".."), { recursive: true })
    await writeFile(destination, content, { flag: "wx" })
  }
  return root
}

async function cleanup(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

const knownGoodCountApi = `"use strict";
function countDistinctWafers(rows, startInclusive, endExclusive) {
  const start = Date.parse(startInclusive);
  const end = Date.parse(endExclusive);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  const ids = new Set();
  for (const row of rows) {
    if (!row || typeof row.wafer_id !== "string" || row.wafer_id.length === 0) continue;
    const at = Date.parse(row.inspected_at);
    if (Number.isFinite(at) && at >= start && at < end) ids.add(row.wafer_id);
  }
  return ids.size;
}
module.exports = { countDistinctWafers };
`
const knownGoodView = `"use strict";
function renderWaferCount(count) { return "Distinct wafers inspected: " + count; }
module.exports = { renderWaferCount };
`

const preparationSections = {
  date: "Reporting date: 2025-04-01 UTC.",
  sources: "Sources: SYS-APR-01 in data/system-export.json (primary export) and MR-APR-01 in data/manual-review.json (supplemental review).",
  calculation: "Plan: apply the UTC date window, count distinct wafer IDs, deduplicate repeated system events, and calculate defects / distinct wafers.",
  fields: "Planned report fields: numerator, denominator, rate, window, sources, conflicts, limitations.",
  conflict: "Conflict: W13 is non-defect in the primary export and flagged in manual review. Preserve the system result and report the disagreement as unresolved.",
  stop: "STOP before producing report.json; compact and restart before phase two.",
}
const stagedPreparation = "# Preparation\n\n" + Object.values(preparationSections).join("\n\n") + "\n"
// Transcribed from the terminal Build and ALG preparation artifacts. Keep these
// local to the test so qualification never edits or depends on execution evidence.
const frozenBuildPreparation = `# Wafer evidence report preparation

## Reporting date and window

- Reporting date: 2025-04-01 (UTC), as stated by both sources.
- Inclusive start: \`2025-04-01T00:00:00Z\`.
- Exclusive end: \`2025-04-02T00:00:00Z\`.
- Timezone: \`UTC\`.

## Sources

- \`data/system-export.json\` — \`SYS-APR-01\`, synthetic system export; primary for the calculation.
- \`data/manual-review.json\` — \`MR-APR-01\`, synthetic manual review sheet; supplemental evidence.

## Calculation plan

Use the system export for the reporting date. Count distinct \`wafer_id\` values for the denominator, and count distinct wafers with a system \`defect: true\` for the numerator. Do not count repeated inspection events as additional wafers or defects. The system records contain W11, W12, W13, and W14: denominator 4. W12 is the only system-defective wafer, despite two matching events: numerator 1. The planned rate is 1 / 4 = 0.25.

## Conflict

W13 has \`system_defect: false\` (system event S-204) and \`manual_defect: true\` (manual review). The disagreement is unresolved and creates uncertainty. Preserve the primary system value in the calculation and disclose both observations in the report. W12 agrees across sources.

## Planned report fields

- \`numerator\`: 1; \`denominator\`: 4; \`rate\`: 0.25.
- \`window\`: \`start\`, \`endExclusive\`, and \`timezone\` using the UTC values above.
- \`sources\`: both source file paths above.
- \`conflicts\`: an entry for W13 with \`wafer_id\`, \`system_defect\`, \`manual_defect\`, and \`status: "unresolved"\`.
- \`limitations\`: include the exact sentence: "Synthetic analysis only; not process validation." Also state that the manual/system disagreement remains unresolved and the calculation follows the system export.

## STOP

Preparation is complete. Stop here; create \`report.json\` only in the subsequent phase after restart.
`
const frozenAlgPreparation = `# Synthetic wafer evidence report preparation
Reporting date: **2025-04-01**. Reporting window: **[2025-04-01T00:00:00Z, 2025-04-02T00:00:00Z)**, inclusive start and exclusive end. The supplied files identify the reporting date but do not provide event timestamps; the plan relies on that date designation rather than independently filtering events by time.

## Sources

- Primary: \`data/system-export.json\`, source ID \`SYS-APR-01\` (synthetic system export).
- Supplemental: \`data/manual-review.json\`, source ID \`MR-APR-01\` (synthetic manual review sheet).

## Calculation plan

Use the primary system export for the reported calculation. Count distinct \`wafer_id\` values, not inspection events: W11, W12, W13 and W14 yield a denominator of **4**. Count distinct system-defective wafers: W12 is the only one, giving a numerator of **1**. Its two defective events, S-202 and S-203, do not add another wafer. The planned rate is **1 / 4 = 25%**.

## Conflict and uncertainty

W13 remains unresolved: system event **S-204** records \`defect=false\`, whereas the supplemental manual review records \`reviewer_defect=true\` and the note **"visual mark; confirm against primary record"**. Preserve both observations without merging or overwriting them. The reported calculation remains the primary system result, 1 / 4 = 25%; the disagreement introduces uncertainty about W13's defect status.

## Planned future report fields

- Reporting date and UTC window, including boundary convention.
- Primary and supplemental source IDs and paths.
- Defective-wafer numerator, distinct-wafer denominator, and rate calculation.
- Unresolved conflict with wafer ID, system event and observation, manual observation and note.
- Explicit uncertainty and limitations.

Synthetic analysis only; not process validation.

## STOP

Preparation only. Stop before creating \`report.json\`; producing the future report is outside this phase.
`
const knownGoodReport = {
  numerator: 1,
  denominator: 4,
  rate: 0.25,
  window: { start: "2025-04-01T00:00:00Z", endExclusive: "2025-04-02T00:00:00Z", timezone: "UTC" },
  sources: ["data/system-export.json", "data/manual-review.json"],
  conflicts: [{ wafer_id: "W13", system_defect: false, manual_defect: true, status: "unresolved" }],
  limitations: ["Synthetic analysis only; not process validation."],
}

describe("Build end-to-end benchmark fixtures and scorer", () => {
  test.each([["Build", frozenBuildPreparation], ["ALG", frozenAlgPreparation]])("accepts terminal %s preparation and rejects missing semantic parts", async (_arm, prep) => {
    const project = await projectFromFixture(1)
    try {
      const variants = [
        prep!.replace(/\bSYS-APR-01\b/, "other-source"),
        prep!.replace(/\bMR-APR-01\b/, "other-source"),
        prep!.replace(/\bW13\b/g, "other-wafer"),
        prep!.replace(/\bunresolved\b/gi, "resolved"),
        prep!.replace(/\b1\s*\/\s*4\b/g, "no division stated"),
        prep!.replace(/## Planned (?:future )?report fields[\s\S]*?(?=\n## STOP)/, "## Planned report fields\n\n- date and source IDs only.\n"),
        prep!.replace(/## Planned (?:future )?report fields[\s\S]*?(?=\n## STOP)/, "## Planned report fields\n\n") +
          "\nThe terms numerator, denominator, rate, window, sources, conflicts, limitations appear outside the plan.\n",
        prep!.replace(/## STOP[\s\S]*$/, "## Next step\n\nCreate report.json now.\n"),
      ]
      await writeFile(join(project, "preparation.md"), prep!)
      expect((await scoreBenchmarkPreparation(project)).passed).toBe(true)
      for (const [index, variant] of variants.entries()) {
        await writeFile(join(project, "preparation.md"), variant)
        const check = (await scoreBenchmarkPreparation(project)).checks.find(check => check.id === "preparation-artifact")
        if (check?.passed) throw new Error(`${_arm} negative variant ${index} was accepted`)
      }
    } finally { await cleanup(project) }
  })

  test("exports two compact, frozen fixtures with the same per-case prompts for every arm", () => {
    expect(BENCHMARK_CASES).toHaveLength(2)
    expect(Object.isFrozen(BENCHMARK_CASES)).toBe(true)
    for (const item of BENCHMARK_CASES) {
      expect(item.criteria.length).toBeGreaterThan(0)
      expect(item.initialPrompt.length).toBeGreaterThan(0)
      expect(Object.keys(item.files).length).toBeLessThanOrEqual(5)
      expect(item.protectedPaths.length).toBeGreaterThan(0)
    }
    expect(BENCHMARK_CASES[1]!.followupPrompt).toBe("Continue the originally requested report using persisted preparation and applicable project procedure; do not repeat preparation.")
    expect(BENCHMARK_CASES[1]!.followupPrompt).not.toContain("W13")
    expect(JSON.stringify(BENCHMARK_CASES[0]!.files)).not.toContain("H-A")
    expect(BENCHMARK_CASES[0]!.files["package.json"]).toContain('"test": "node --test test/wafer-count.test.cjs"')
    expect(BENCHMARK_CASES[0]!.protectedPaths).toContain("package.json")
    expect(BENCHMARK_CASES[0]!.protectedPaths).toContain("test/wafer-count.test.cjs")
    expect(BENCHMARK_CASES[1]!.files[".opencode/skills/wafer-analysis/SKILL.md"]).toContain("name: wafer-analysis")
  })

  test("held-out API and UI tests fail the original bug and pass a known-good repair", async () => {
    const project = await projectFromFixture(0)
    try {
      const original = await scoreBenchmarkCase("wafer-count-commonjs", project)
      expect(original.passed).toBe(false)
      expect(original.metrics.heldOutTestLocation).toBe("outside-project-temporary-directory")
      expect(original.checks.some(check => check.id === "distinct-ids-and-offset-window" && !check.passed)).toBe(true)
      expect(original.checks.some(check => check.id === "protected:data/inspection-records.json" && check.passed)).toBe(true)
      expect(original.metrics.changedSourceFiles).toEqual([])

      await writeFile(join(project, "src/wafer-count.cjs"), knownGoodCountApi)
      await writeFile(join(project, "src/wafer-view.cjs"), knownGoodView)
      const repaired = await scoreBenchmarkCase("wafer-count-commonjs", project)
      expect(repaired.passed).toBe(true)
      expect(repaired.checks.every(check => check.passed)).toBe(true)
      expect(repaired.metrics.changedSourceFiles).toEqual(["src/wafer-count.cjs", "src/wafer-view.cjs"])
    } finally { await cleanup(project) }
  })

  test.each(["src/helper.cjs", "src/helper", "helper.js", "lib/nested/helper.ts"])("rejects a third source edit at %s even when every behavioral check passes", async extraPath => {
    const project = await projectFromFixture(0)
    try {
      await writeFile(join(project, "src/wafer-count.cjs"), knownGoodCountApi)
      await writeFile(join(project, "src/wafer-view.cjs"), knownGoodView)
      await mkdir(join(project, extraPath, ".."), { recursive: true })
      await writeFile(join(project, extraPath), "// Additional implementation file.\n")
      const result = await scoreBenchmarkCase("wafer-count-commonjs", project)
      expect(result.passed).toBe(false)
      expect(result.checks.filter(check => !check.passed).map(check => check.id)).toEqual(["source-file-edit-limit"])
      expect(result.metrics.changedSourceFiles).toEqual([extraPath, "src/wafer-count.cjs", "src/wafer-view.cjs"].sort())
    } finally { await cleanup(project) }
  })

  test("counts final source changes independently of tests, notes and runtime bookkeeping", async () => {
    const project = await projectFromFixture(0)
    try {
      await writeFile(join(project, "src/wafer-count.cjs"), knownGoodCountApi)
      await writeFile(join(project, "src/wafer-view.cjs"), knownGoodView)
      await writeFile(join(project, "README.md"), "Repair notes.\n")
      await writeFile(join(project, "test/additional.test.cjs"), "// Additional test.\n")
      await mkdir(join(project, ".opencode/runs/fixture/artifacts"), { recursive: true })
      await writeFile(join(project, ".opencode/runs/fixture/artifacts/example.js"), "// Recorded example, not project implementation.\n")
      const result = await scoreBenchmarkCase("wafer-count-commonjs", project)
      expect(result.passed).toBe(true)
      expect(result.metrics.changedSourceFiles).toHaveLength(2)
    } finally { await cleanup(project) }
  })

  test.each([
    ["empty", ""],
    ["whitespace", " \r\n\t"],
    ["old keyword-only", "2025-04-01 SYS-APR-01 MR-APR-01 data/system-export.json data/manual-review.json STOP"],
  ])("rejects %s preparation even with an otherwise correct report", async (_name, prep) => {
    const project = await projectFromFixture(1)
    try {
      await writeFile(join(project, "preparation.md"), prep!)
      await writeFile(join(project, "report.json"), JSON.stringify(knownGoodReport))
      const result = await scoreBenchmarkCase("wafer-report-staged", project)
      expect(result.passed).toBe(false)
      expect(result.checks.filter(check => !check.passed).map(check => check.id)).toEqual(["preparation-artifact"])
    } finally { await cleanup(project) }
  })

  const omittedPreparation = [
    ["reporting date", preparationSections.date, ""],
    ["system source ID", "SYS-APR-01", ""],
    ["manual source ID", "MR-APR-01", ""],
    ["system source path", "data/system-export.json", ""],
    ["manual source path", "data/manual-review.json", ""],
    ["calculation plan", preparationSections.calculation, ""],
    ["distinct-wafer calculation", preparationSections.calculation, "Plan: UTC defects / inspection events."],
    ["rate calculation", preparationSections.calculation, "Plan: count distinct wafer IDs in the UTC window."],
    ["conflict", preparationSections.conflict, ""],
    ["conflicting wafer", "W13", ""],
    ["system observation", "non-defect in the primary export and ", ""],
    ["manual observation", " and flagged in manual review", ""],
    ["unresolved conflict", "unresolved", "resolved"],
    ["planned fields", preparationSections.fields, ""],
    ["explicit STOP", preparationSections.stop, ""],
    ...["numerator", "denominator", "rate", "window", "sources", "conflicts", "limitations"].map(field =>
      [`planned field ${field}`, preparationSections.fields, preparationSections.fields.replace(new RegExp(`\\b${field}\\b`), "")]),
  ]
  test.each(omittedPreparation)("rejects preparation omitting %s", async (_name, before, after) => {
    const project = await projectFromFixture(1)
    try {
      await writeFile(join(project, "preparation.md"), stagedPreparation.replace(before!, after!))
      const result = await scoreBenchmarkPreparation(project)
      expect(result.passed).toBe(false)
      expect(result.checks.filter(check => !check.passed).map(check => check.id)).toEqual(["preparation-artifact"])
    } finally { await cleanup(project) }
  })

  test.each([
    ["unlabelled field list", stagedPreparation.replace("Planned report fields: ", "")],
    ["prose", `For 2025-04-01 UTC, use SYS-APR-01 (data/system-export.json) and MR-APR-01 (data/manual-review.json).
Deduplicate unique wafer IDs. Divide defective wafer count by unique wafer count for the UTC day.
W13: system=false; manual=true. The disagreement remains unresolved; retain the primary result.
The report will include numerator, denominator, rate, window, sources, conflicts and limitations.
STOP until continuation; report.json must wait.`],
    ["equivalent uncertainty wording", stagedPreparation.replace("unresolved", "not yet resolved")],
    ["disputed evidence wording", stagedPreparation.replace("unresolved", "remains disputed")],
    ["standalone STOP heading", stagedPreparation.replace(preparationSections.stop, "# STOP\n\nPreparation phase complete; report.json is deferred to continuation.")],
    ["table", stagedPreparation.replace(preparationSections.fields, "Output schema:\n| Field | Type |\n| --- | --- |\n" +
      Object.entries(knownGoodReport).map(([field, value]) => `| ${field} | ${typeof value} |`).join("\n"))],
    ["JSON field plan", stagedPreparation.replace(preparationSections.fields, JSON.stringify({
      numerator: "number", denominator: "number", rate: "number", window: "UTC range", sources: "array", conflicts: "array", limitations: "array",
    }, null, 2))],
  ])("accepts equivalent %s preparation and UTC instant representations", async (_name, prep) => {
    const project = await projectFromFixture(1)
    try {
      await writeFile(join(project, "preparation.md"), prep!)
      await writeFile(join(project, "report.json"), JSON.stringify({ ...knownGoodReport,
        window: { start: "2025-03-31T19:00:00-05:00", endExclusive: "2025-04-01T19:00:00-05:00", timezone: "UTC" },
      }))
      expect((await scoreBenchmarkCase("wafer-report-staged", project)).passed).toBe(true)
    } finally { await cleanup(project) }
  })

  test("staged report scorer checks preparation, arithmetic, provenance, uncertainty, skill rules, and protected inputs", async () => {
    const project = await projectFromFixture(1)
    try {
      const original = await scoreBenchmarkCase("wafer-report-staged", project)
      expect(original.passed).toBe(false)
      expect(original.checks.some(check => check.id === "protected:.opencode/skills/wafer-analysis/SKILL.md" && check.passed)).toBe(true)

      await writeFile(join(project, "preparation.md"), stagedPreparation)
      const phaseOne = await scoreBenchmarkPreparation(project)
      expect(phaseOne.passed).toBe(true)
      await writeFile(join(project, "report.json"), JSON.stringify(knownGoodReport, null, 2))
      const repaired = await scoreBenchmarkCase("wafer-report-staged", project)
      expect(repaired.passed).toBe(true)
      expect(repaired.checks.every(check => check.passed)).toBe(true)

      await writeFile(join(project, "data/system-export.json"), JSON.stringify({ tampered: true }))
      const tampered = await scoreBenchmarkCase("wafer-report-staged", project)
      expect(tampered.passed).toBe(false)
      expect(tampered.checks.some(check => check.id === "protected:data/system-export.json" && !check.passed)).toBe(true)
    } finally { await cleanup(project) }
  })

  test("valid preparation does not relax final report numeric or schema checks", async () => {
    const project = await projectFromFixture(1)
    try {
      await writeFile(join(project, "preparation.md"), frozenAlgPreparation)
      for (const report of [
        { ...knownGoodReport, numerator: 2 },
        { ...knownGoodReport, denominator: "4" },
        { ...knownGoodReport, rate: 25 },
        { ...knownGoodReport, window: { ...knownGoodReport.window, endExclusive: "2025-04-01T23:59:59Z" } },
        { ...knownGoodReport, conflicts: [{ wafer_id: "W13", system_defect: false, manual_defect: true, status: "resolved" }] },
      ]) {
        await writeFile(join(project, "report.json"), JSON.stringify(report))
        const result = await scoreBenchmarkCase("wafer-report-staged", project)
        expect(result.passed).toBe(false)
        expect(result.checks.some(check => !check.passed && check.id !== "preparation-artifact")).toBe(true)
      }
    } finally { await cleanup(project) }
  })

  test("phase one rejects an early report while final scoring accepts the completed report", async () => {
    const project = await projectFromFixture(1)
    try {
      await writeFile(join(project, "preparation.md"), stagedPreparation)
      await writeFile(join(project, "report.json"), JSON.stringify(knownGoodReport))
      const preparation = await scoreBenchmarkPreparation(project)
      expect(preparation.passed).toBe(false)
      expect(preparation.checks.find(check => check.id === "phase-one-report-absent")?.passed).toBe(false)
      expect((await scoreBenchmarkCase("wafer-report-staged", project)).passed).toBe(true)
    } finally { await cleanup(project) }
  })

  test("detects a tampered protected wafer-data file in the code fixture", async () => {
    const project = await projectFromFixture(0)
    try {
      await writeFile(join(project, "data/inspection-records.json"), "{}\n")
      const score = await scoreBenchmarkCase("wafer-count-commonjs", project)
      expect(score.passed).toBe(false)
      expect(score.checks.some(check => check.id === "protected:data/inspection-records.json" && !check.passed)).toBe(true)
    } finally { await cleanup(project) }
  })
})

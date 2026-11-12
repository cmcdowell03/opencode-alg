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

const stagedPreparation = `# Preparation
Reporting date: 2025-04-01 UTC.
Sources: SYS-APR-01 in data/system-export.json (primary export) and MR-APR-01 in data/manual-review.json (supplemental review).
Plan: apply the UTC date window, count distinct wafer IDs, deduplicate repeated system events, and calculate defects / distinct wafers. Planned report fields: numerator, denominator, rate, window, sources, conflicts, limitations.
Conflict: W13 is non-defect in the primary export and flagged in manual review. Preserve the system result and report the disagreement as unresolved.
STOP before producing report.json; compact and restart before phase two.
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

      await writeFile(join(project, "src/wafer-count.cjs"), knownGoodCountApi)
      await writeFile(join(project, "src/wafer-view.cjs"), knownGoodView)
      const repaired = await scoreBenchmarkCase("wafer-count-commonjs", project)
      expect(repaired.passed).toBe(true)
      expect(repaired.checks.every(check => check.passed)).toBe(true)
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

import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

export interface BenchmarkCase {
  id: string
  title: string
  criteria: string[]
  initialPrompt: string
  followupPrompt?: string
  files: Record<string, string>
  protectedPaths: string[]
}

const inspectionSource = JSON.stringify({
  source: "synthetic wafer system export",
  range_utc: { from: "2025-04-01T00:00:00Z", to_exclusive: "2025-04-02T00:00:00Z" },
  inspections: [
    { event_id: "S-101", wafer_id: "W11", inspected_at: "2025-04-01T08:00:00Z", defect: false },
    { event_id: "S-102", wafer_id: "W12", inspected_at: "2025-04-01T09:00:00Z", defect: true },
    { event_id: "S-103", wafer_id: "W12", inspected_at: "2025-04-01T09:05:00Z", defect: true },
    { event_id: "S-104", wafer_id: "W13", inspected_at: "2025-04-01T10:00:00Z", defect: false },
  ],
}, null, 2) + "\n"

const analysisSkill = `---
name: wafer-analysis
description: Analyze supplied synthetic wafer inspection evidence with UTC windows, distinct-wafer counts, source precedence, and explicit conflict reporting.
---

# Wafer analysis skill

Scope: summarize only the supplied synthetic wafer inspection evidence. This skill is not manufacturing validation or process qualification.

Rules:
1. Interpret the requested reporting window in UTC and use an inclusive start and exclusive end. For a date-only request, use midnight UTC at the start of that date through midnight UTC at the start of the following date.
2. Count distinct wafer_id values for the denominator; repeated inspection events do not add wafers.
3. The system export is primary for the reported calculation. Treat manual review as supplemental evidence. If values conflict, preserve the primary result and disclose the specific unresolved conflict; do not silently merge or overwrite records.
4. Show the numerator, distinct-wafer denominator, rate calculation, source file names, and reporting window. State uncertainty explicitly where sources disagree.
5. Use this exact limitations sentence: "Synthetic analysis only; not process validation." Do not claim manufacturing readiness or causal impact from these synthetic records.
`

const systemExport = JSON.stringify({
  source: "synthetic system export",
  source_id: "SYS-APR-01",
  reporting_date_utc: "2025-04-01",
  rows: [
    { event_id: "S-201", wafer_id: "W11", defect: false },
    { event_id: "S-202", wafer_id: "W12", defect: true },
    { event_id: "S-203", wafer_id: "W12", defect: true },
    { event_id: "S-204", wafer_id: "W13", defect: false },
    { event_id: "S-205", wafer_id: "W14", defect: false },
  ],
}, null, 2) + "\n"

const manualReview = JSON.stringify({
  source: "synthetic manual review sheet",
  source_id: "MR-APR-01",
  reporting_date_utc: "2025-04-01",
  rows: [
    { wafer_id: "W12", reviewer_defect: true, note: "matches system" },
    { wafer_id: "W13", reviewer_defect: true, note: "visual mark; confirm against primary record" },
  ],
}, null, 2) + "\n"

const COMMONJS_PACKAGE = JSON.stringify({ private: true, type: "commonjs", scripts: { test: "node --test test/wafer-count.test.cjs" } }, null, 2) + "\n"
const VISIBLE_WAFER_TEST = `"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { countDistinctWafers } = require("../src/wafer-count.cjs");
const { renderWaferCount } = require("../src/wafer-view.cjs");

test("counts distinct wafer IDs in the supplied UTC reporting day", () => {
  const fixture = JSON.parse(readFileSync(path.join(__dirname, "../data/inspection-records.json"), "utf8"));
  const count = countDistinctWafers(fixture.inspections, "2025-04-01T00:00:00Z", "2025-04-02T00:00:00Z");
  assert.equal(count, 3);
});

test("shows the distinct-wafer count in user-facing text", () => {
  assert.equal(renderWaferCount(3), "Distinct wafers inspected: 3");
});
`
const INITIAL_WAFER_COUNT = `"use strict";

function countDistinctWafers(rows, startInclusive, endExclusive) {
  const start = Date.parse(startInclusive);
  const end = Date.parse(endExclusive);
  return rows.filter((row) => {
    const at = Date.parse(row.inspected_at);
    return Number.isFinite(at) && at >= start && at <= end;
  }).length;
}

module.exports = { countDistinctWafers };
`
const INITIAL_WAFER_VIEW = `"use strict";

function renderWaferCount(count) {
  return "Inspections: " + count;
}

module.exports = { renderWaferCount };
`

const BENCHMARK_CASES_INTERNAL: BenchmarkCase[] = [
  {
    id: "wafer-count-commonjs",
    title: "Repair distinct wafer count and UTC window display",
    criteria: [
      "Count each distinct wafer_id at most once when at least one valid inspection timestamp falls in the UTC window [start, end).",
      "Treat the end of the date range as exclusive and compare timestamps by their parsed UTC instant, including offsets.",
      "The user-visible summary must say `Distinct wafers inspected: N` for the computed count.",
      "Keep the implementation CommonJS-compatible, dependency-free, and confined to the existing small API/UI modules.",
    ],
    initialPrompt: "Fix the wafer-count bug in this small CommonJS API/UI. Count distinct wafer IDs with an inclusive UTC start and exclusive UTC end, correctly handling offset timestamps, then show the exact user-visible label `Distinct wafers inspected: N`. Keep the change small (at most two source-file edits), do not add dependencies, and do not change the supplied inspection data.",
    files: {
      "package.json": COMMONJS_PACKAGE,
      "src/wafer-count.cjs": INITIAL_WAFER_COUNT,
      "src/wafer-view.cjs": INITIAL_WAFER_VIEW,
      "test/wafer-count.test.cjs": VISIBLE_WAFER_TEST,
      "data/inspection-records.json": inspectionSource,
    },
    protectedPaths: ["package.json", "test/wafer-count.test.cjs", "data/inspection-records.json"],
  },
  {
    id: "wafer-report-staged",
    title: "Prepare, restart, and report wafer defect evidence",
    criteria: [
      "The initial stage must persist preparation.md with the selected reporting date, source identities, calculation plan, conflict, and an explicit stop before report generation.",
      "After restart, report.json must calculate from distinct system-export wafer IDs: one defective wafer out of four, or 25%.",
      "The report must identify both protected source files and preserve conflicting evidence as explicit uncertainty; manual evidence does not overwrite the primary system result.",
      "Follow .opencode/skills/wafer-analysis/SKILL.md, including UTC window, distinct-wafer denominator, source precedence, conflict disclosure, and no unsupported process-validation claim.",
    ],
    initialPrompt: "Complete a two-phase synthetic wafer evidence report using the applicable wafer-analysis project skill and supplied source files. Final deliverable: report.json with fields numerator (number), denominator (number), rate (number), window ({start, endExclusive, timezone}), sources (array of source file paths), conflicts (array of {wafer_id, system_defect, manual_defect, status}), and limitations (array of scope limits). The conflict entry must expose both source observations and mark the disagreement unresolved; follow the skill's source-priority rule. Use a UTC reporting window, count distinct wafer IDs, and calculate defects divided by distinct wafers. Include the exact standard limitations sentence required by the skill. This first phase is preparation only: write preparation.md with the reporting date, source IDs/paths, calculation plan, conflicts, planned report fields, and an explicit STOP. Do not create report.json in this phase; the run will be compacted and restarted.",
    followupPrompt: "Continue the originally requested report using persisted preparation and applicable project procedure; do not repeat preparation.",
    files: {
      ".opencode/skills/wafer-analysis/SKILL.md": analysisSkill,
      "data/system-export.json": systemExport,
      "data/manual-review.json": manualReview,
    },
    protectedPaths: [
      ".opencode/skills/wafer-analysis/SKILL.md",
      "data/system-export.json",
      "data/manual-review.json",
    ],
  },
]

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

export const BENCHMARK_CASES: readonly BenchmarkCase[] = deepFreeze(BENCHMARK_CASES_INTERNAL)

const HELD_OUT_TEST = String.raw`"use strict";
const path = require("node:path");
const checks = [];
function check(id, fn) {
  try { const result = fn(); checks.push({ id, passed: result === true, detail: result === true ? undefined : String(result) }); }
  catch (error) { checks.push({ id, passed: false, detail: error && error.message ? error.message : String(error) }); }
}
const project = process.argv[2];
check("api-module-loads", () => typeof require(path.join(project, "src/wafer-count.cjs")).countDistinctWafers === "function");
check("ui-module-loads", () => typeof require(path.join(project, "src/wafer-view.cjs")).renderWaferCount === "function");
try {
  const { countDistinctWafers } = require(path.join(project, "src/wafer-count.cjs"));
  const { renderWaferCount } = require(path.join(project, "src/wafer-view.cjs"));
  const rows = [
    { wafer_id: "H-A", inspected_at: "2025-03-31T23:30:00-01:00" },
    { wafer_id: "H-A", inspected_at: "2025-04-01T02:00:00Z" },
    { wafer_id: "H-B", inspected_at: "2025-04-01T23:59:59Z" },
    { wafer_id: "H-C", inspected_at: "2025-04-02T00:00:00Z" },
    { wafer_id: "H-D", inspected_at: "2025-03-31T23:59:59.999Z" },
    { wafer_id: "H-E", inspected_at: "not-a-timestamp" },
  ];
  const count = countDistinctWafers(rows, "2025-04-01T00:00:00Z", "2025-04-02T00:00:00Z");
  check("distinct-ids-and-offset-window", () => count === 2 ? true : "expected 2 distinct wafers, received " + count);
  const visible = String(renderWaferCount(count)).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  check("user-visible-count", () => visible === "Distinct wafers inspected: 2" ? true : "unexpected visible text: " + visible);
} catch (error) {
  checks.push({ id: "held-out-execution", passed: false, detail: error && error.message ? error.message : String(error) });
}
process.stdout.write(JSON.stringify(checks));
`

const PROTECTED_DIGESTS = new Map<string, string>(
  BENCHMARK_CASES.flatMap(benchmark => benchmark.protectedPaths.map(relative => [
    `${benchmark.id}:${relative}`,
    createHash("sha256").update(benchmark.files[relative] ?? "").digest("hex"),
  ] as const)),
)

function nodeExecutable(): string {
  if (process.platform !== "win32") return "node"
  try {
    const matches = execFileSync("where.exe", ["node"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/)
      .map(value => value.trim()).filter(value => /(?:^|[\\/])node\.exe$/i.test(value))
    if (matches[0]) return matches[0]
  } catch { /* use PATH fallback below */ }
  return "node"
}

export interface BenchmarkCheck {
  id: string
  passed: boolean
  detail?: string
}

export interface BenchmarkScore {
  passed: boolean
  checks: BenchmarkCheck[]
  metrics: Record<string, unknown>
}

async function protectedFileChecks(benchmark: BenchmarkCase, projectDir: string): Promise<BenchmarkCheck[]> {
  const checks: BenchmarkCheck[] = []
  for (const relative of benchmark.protectedPaths) {
    const file = resolve(projectDir, relative)
    const expected = PROTECTED_DIGESTS.get(`${benchmark.id}:${relative}`)!
    try {
      const actual = createHash("sha256").update(await readFile(file)).digest("hex")
      checks.push({ id: `protected:${relative}`, passed: actual === expected, ...(actual !== expected ? { detail: "protected fixture content changed" } : {}) })
    } catch (error) {
      checks.push({ id: `protected:${relative}`, passed: false, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  return checks
}

// Prospective oracle correction: score the original two-source-file limit against
// the frozen fixture, not mutable Git state. Historical cohort scores stay frozen.
async function changedSourceFiles(benchmark: BenchmarkCase, projectDir: string): Promise<string[]> {
  const sources = new Map<string, Buffer>()
  const isSource = (path: string) => (path.startsWith("src/") || /\.(?:[cm]?[jt]sx?|css|html)$/i.test(path)) &&
    !/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.(?:test|spec)\.[^/]+$/i.test(path)
  const walk = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      // Runtime receipts, repository metadata and installed dependencies are not
      // implementation edits. Apply the same exclusions to either benchmark arm.
      if ([".git", ".opencode", "node_modules"].includes(entry.name)) continue
      const relative = prefix + entry.name
      if (entry.isSymbolicLink()) throw new Error(`Cannot establish source-edit count through symlink: ${relative}`)
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative + "/")
      else if (entry.isFile() && isSource(relative)) sources.set(relative, await readFile(join(directory, entry.name)))
    }
  }
  await walk(projectDir)
  const paths = new Set([...Object.keys(benchmark.files).filter(isSource), ...sources.keys()])
  return [...paths].filter(path => {
    const before = benchmark.files[path]
    const after = sources.get(path)
    return before === undefined || after === undefined || !after.equals(Buffer.from(before))
  }).sort()
}

async function scoreWaferCount(projectDir: string): Promise<BenchmarkScore> {
  const checks = await protectedFileChecks(BENCHMARK_CASES[0]!, projectDir)
  let sourceEdits: string[] | undefined
  try {
    sourceEdits = await changedSourceFiles(BENCHMARK_CASES[0]!, projectDir)
    checks.push({ id: "source-file-edit-limit", passed: sourceEdits.length <= 2,
      ...(sourceEdits.length > 2 ? { detail: `Expected at most two changed source files; found ${sourceEdits.length}` } : {}) })
  } catch (error) {
    checks.push({ id: "source-file-edit-limit", passed: false, detail: error instanceof Error ? error.message : String(error) })
  }
  try {
    execFileSync(nodeExecutable(), ["--test", "test/wafer-count.test.cjs"], {
      cwd: projectDir, encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024,
    })
    checks.push({ id: "visible-node-tests", passed: true })
  } catch (error) {
    checks.push({ id: "visible-node-tests", passed: false, detail: error instanceof Error ? error.message : String(error) })
  }
  const temp = await mkdtemp(join(tmpdir(), "alg-wafer-heldout-"))
  let heldout: Array<{ id: string; passed: boolean; detail?: string }> = []
  try {
    const script = join(temp, "held-out.cjs")
    await writeFile(script, HELD_OUT_TEST, { flag: "wx" })
    const output = execFileSync(nodeExecutable(), [script, resolve(projectDir)], {
      cwd: temp, encoding: "utf8", timeout: 10_000, windowsHide: true, maxBuffer: 64 * 1024,
    })
    heldout = JSON.parse(output)
  } catch (error) {
    heldout = [{ id: "held-out-execution", passed: false, detail: error instanceof Error ? error.message : String(error) }]
  } finally {
    await rm(temp, { recursive: true, force: true }).catch(() => undefined)
  }
  checks.push(...heldout)
  const countChecks = heldout.filter(check => check.id !== "api-module-loads" && check.id !== "ui-module-loads")
  return {
    passed: checks.every(check => check.passed),
    checks,
    metrics: {
      heldOutTestLocation: "outside-project-temporary-directory",
      heldOutCheckCount: heldout.length,
      heldOutPassed: heldout.filter(check => check.passed).length,
      visibleTestCommand: "npm test",
      visibleTestCount: 2,
      protectedFiles: BENCHMARK_CASES[0]!.protectedPaths.length,
      userVisibleChecks: countChecks.filter(check => check.id === "user-visible-count").length,
      changedSourceFiles: sourceEdits ?? null,
      sourceFileEditLimit: 2,
    },
  }
}

function missingPreparationContent(prep: string): string[] {
  const text = prep.toLowerCase()
  // Accept prose, lists, Markdown tables and inline code. These are bounded
  // content checks, not a semantic verifier or a requirement for final numbers.
  const prose = text.replace(/[_`*#]/g, " ").replace(/\s+/g, " ")
  const near = (left: string, right: string) => new RegExp(`(?:${left}).{0,160}(?:${right})|(?:${right}).{0,160}(?:${left})`).test(prose)
  const fields = ["numerator", "denominator", "rate", "window", "sources", "conflicts", "limitations"]
  const lines = text.split(/\r?\n/)
  const heading = lines.findIndex(line => /^\s*#{1,6}\s+(?:(?:planned|future)\s+)*(?:(?:future|planned)\s+)?(?:report\s+fields|output\s+schema)\b/.test(line))
  const nextHeading = lines.findIndex((line, index) => index > heading && /^\s*#{1,6}\s+/.test(line))
  const headingFields = heading < 0 ? "" : lines.slice(heading + 1, nextHeading < 0 ? undefined : nextHeading).join(" ")
  const inlineFields = text.replace(/[`*#]/g, "").match(
    /(?:\b(?:report(?:\.json)?|output)\s+(?:fields|schema|structure|keys)\b|\b(?:planned\s+)?fields\s*:|\breport(?:\.json)?\s+(?:(?:will|must|should)\s+)?(?:contain\w*|include\w*|with|as)\b)([^\n]*(?:\n(?!\s*\n)[^\n]*)*)/,
  )?.[1] ?? ""
  const reportFields = heading >= 0 ? headingFields : inlineFields || text.split(/\n\s*\n/).find(paragraph =>
    fields.every(field => new RegExp(`\\b${field}\\b`).test(paragraph))) || ""
  const plannedField: Record<string, RegExp> = {
    numerator: /\bnumerator\b/,
    denominator: /\bdenominator\b/,
    rate: /\brate\b/,
    window: /\bwindow\b/,
    sources: /\bsources?\b/,
    conflicts: /\bconflicts?\b/,
    limitations: /\blimitations?\b/,
  }
  const fraction = /\b(?:defects?|defective|numerator)\b[^.!?;]{0,80}(?:\/|\bdivid\w*\b|\bover\b)[^.!?;]{0,80}\b(?:distinct|unique|wafers?|denominator)\b/.test(prose) ||
    /\bdivide\b[^.!?;]{0,60}\b(?:defect\w*|numerator)\b[^.!?;]{0,60}\bby\b[^.!?;]{0,60}\b(?:distinct|unique|wafers?|denominator)\b/.test(prose) ||
    (near("\\b(?:defective|defects?|numerator)\\b", "\\b(?:distinct|unique|denominator)\\b") &&
      /\b(?:rate|calculation)\b[^.!?;]{0,60}\b\d+\s*\/\s*\d+\b/.test(prose))
  const required: Array<[string, boolean]> = [
    ["nonempty preparation", prep.trim().length > 0],
    ["reporting date", /\b2025-04-01\b/.test(text)],
    ["system source ID", /\bsys-apr-01\b/.test(text)],
    ["manual source ID", /\bmr-apr-01\b/.test(text)],
    ["system source path", text.includes("data/system-export.json")],
    ["manual source path", text.includes("data/manual-review.json")],
    ["calculation plan", /\butc\b/.test(prose) &&
      near("\\b(?:distinct|unique|deduplicat\\w*)\\b", "\\bwafer\\w*\\b") &&
      fraction],
    ["conflicting wafer", /\bw13\b/.test(prose)],
    ["system conflict observation", near("\\b(?:system|primary)\\b", "\\b(?:false|non[- ]?defect\\w*|not defective|no defect\\w*|clean)\\b")],
    ["manual conflict observation", near("\\b(?:manual|review)\\b", "\\b(?:true|flagged|defective|positive)\\b")],
    ["unresolved conflict", /\bunresolved\b|\bnot\s+(?:yet\s+)?resolved\b|\b(?:remains?|still)\s+(?:in\s+)?(?:dispute|disputed|uncertain|unreconciled)\b/.test(prose)],
    ...fields.map(field =>
      [`planned field ${field}`, plannedField[field]!.test(reportFields) ||
        new RegExp(`"${field}"\\s*:`).test(heading >= 0 ? reportFields : text)] as [string, boolean]),
    ["explicit STOP", /\bstop\b/.test(text)],
  ]
  return required.filter(([, present]) => !present).map(([name]) => name)
}

async function scorePreparation(projectDir: string, requireNoReport: boolean): Promise<BenchmarkScore> {
  const benchmark = BENCHMARK_CASES[1]!
  const checks = await protectedFileChecks(benchmark, resolve(projectDir))
  let prep = ""
  let readError: string | undefined
  try { prep = await readFile(resolve(projectDir, "preparation.md"), "utf8") }
  catch (error) { readError = error instanceof Error ? error.message : String(error) }
  const missing = missingPreparationContent(prep)
  checks.push({ id: "preparation-artifact", passed: readError === undefined && missing.length === 0,
    ...(readError !== undefined || missing.length ? { detail: readError ?? `Missing preparation content: ${missing.join(", ")}` } : {}) })
  if (requireNoReport) {
    let reportAbsent = false
    try { await readFile(resolve(projectDir, "report.json")) }
    catch (error) { reportAbsent = (error as NodeJS.ErrnoException).code === "ENOENT" }
    checks.push({ id: "phase-one-report-absent", passed: reportAbsent,
      ...(!reportAbsent ? { detail: "report.json must not exist during preparation" } : {}) })
  }
  return { passed: checks.every(check => check.passed), checks, metrics: { protectedFiles: benchmark.protectedPaths.length, preparationBytes: Buffer.byteLength(prep) } }
}

export async function scoreBenchmarkPreparation(projectDir: string): Promise<BenchmarkScore> {
  return scorePreparation(projectDir, true)
}

async function scoreStagedReport(projectDir: string): Promise<BenchmarkScore> {
  const benchmark = BENCHMARK_CASES[1]!
  const preparation = await scorePreparation(projectDir, false)
  const checks = [...preparation.checks]
  let reportText = ""
  let report: unknown
  try {
    reportText = await readFile(resolve(projectDir, "report.json"), "utf8")
    report = JSON.parse(reportText)
  } catch (error) {
    checks.push({ id: "report-json", passed: false, detail: error instanceof Error ? error.message : String(error) })
  }
  if (report !== undefined) {
    const object = report && typeof report === "object" && !Array.isArray(report) ? report as Record<string, unknown> : {}
    const window = object.window && typeof object.window === "object" && !Array.isArray(object.window)
      ? object.window as Record<string, unknown> : {}
    const arithmetic = object.numerator === 1 && object.denominator === 4 && object.rate === 0.25 &&
      Date.parse(String(window.start)) === Date.parse("2025-04-01T00:00:00Z") &&
      Date.parse(String(window.endExclusive)) === Date.parse("2025-04-02T00:00:00Z") && window.timezone === "UTC"
    checks.push({ id: "arithmetic-distinct-wafers", passed: arithmetic,
      ...(!arithmetic ? { detail: "report.json requires numerator=1, denominator=4, rate=0.25, and the exact UTC half-open window" } : {}) })

    const sources = Array.isArray(object.sources) ? object.sources.filter(value => typeof value === "string") as string[] : []
    const provenance = sources.includes("data/system-export.json") && sources.includes("data/manual-review.json")
    checks.push({ id: "source-provenance", passed: provenance, ...(!provenance ? { detail: "report must identify both source file names" } : {}) })

    const conflicts = Array.isArray(object.conflicts) ? object.conflicts : []
    const conflict = conflicts.some(value => value && typeof value === "object" && !Array.isArray(value) &&
      (value as Record<string, unknown>).wafer_id === "W13" &&
      (value as Record<string, unknown>).system_defect === false &&
      (value as Record<string, unknown>).manual_defect === true &&
      (value as Record<string, unknown>).status === "unresolved")
    checks.push({ id: "conflict-and-uncertainty", passed: conflict,
      ...(!conflict ? { detail: "conflicts must record W13 system_defect=false, manual_defect=true, status=unresolved" } : {}) })

    const limitations = Array.isArray(object.limitations) ? object.limitations.filter(value => typeof value === "string").join(" ").toLowerCase() : ""
    const followsSkill = limitations.includes("synthetic analysis only; not process validation.")
    checks.push({ id: "skill-procedure-and-scope", passed: followsSkill,
      ...(!followsSkill ? { detail: "limitations must state that this synthetic report is not process validation or qualification" } : {}) })
  }
  return {
    passed: checks.every(check => check.passed), checks,
    metrics: {
      protectedFiles: benchmark.protectedPaths.length,
      preparationBytes: Number(preparation.metrics.preparationBytes ?? 0),
      reportBytes: Buffer.byteLength(reportText),
      reportParsed: report !== undefined,
    },
  }
}

export async function scoreBenchmarkCase(caseId: string, projectDir: string): Promise<BenchmarkScore> {
  const absolute = resolve(projectDir)
  if (caseId === "wafer-count-commonjs") return scoreWaferCount(absolute)
  if (caseId === "wafer-report-staged") return scoreStagedReport(absolute)
  throw new RangeError(`unknown benchmark case: ${caseId}`)
}

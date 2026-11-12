import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { promisify } from "node:util"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"

const exec = promisify(execFile)
const categories = ["criteria", "phase", "skill", "source", "evidence", "pending_intent", "budget", "next_action"] as const
export type RetentionCategory = typeof categories[number]
export type RetentionCheck = { id: string; category: RetentionCategory; passed: boolean; expectedDigest: string; observedDigest: string | null; basis?: string }
export type RetentionScore = { passed: boolean; checks: RetentionCheck[]; diagnostics: string[] }
export type RetentionPhase = { id: string; prompt: string; outputPath: string }

const sources = {
  "data/wafers.json": JSON.stringify([
    { wafer: "W1", lot: "L1", cohort: "legacy" }, { wafer: "W2", lot: "L2", cohort: "legacy" },
    { wafer: "W3", lot: "L3", cohort: "legacy" }, { wafer: "W4", lot: "L4", cohort: "new" },
    { wafer: "W5", lot: "L5", cohort: "new" }, { wafer: "W6", lot: "L6", cohort: "new" },
  ], null, 2) + "\n",
  "data/readings.json": JSON.stringify([
    { event: "E0", wafer: "W1", at: "2025-01-01T23:59:00Z", defect: 0 },
    { event: "E1", wafer: "W2", at: "2025-01-02T00:15:00Z", defect: 0 },
    { event: "E1", wafer: "W2", at: "2025-01-02T00:15:00Z", defect: 0 },
    { event: "E2", wafer: "W3", at: "2025-01-02T11:00:00Z", defect: 1 },
    { event: "E3", wafer: "W4", at: "2025-01-02T12:00:00Z", defect: 1 },
    { event: "E4", wafer: "W5", at: "2025-01-03T00:00:00Z", defect: 1 },
    { event: "E5", wafer: "W6", at: "2025-01-02T23:45:00Z", defect: 0 },
  ], null, 2) + "\n",
  "data/equipment.json": JSON.stringify([
    { wafer: "W2", tool: "T1" }, { wafer: "W2", tool: "T1-backfill" },
    { wafer: "W3", tool: "T1" }, { wafer: "W4", tool: "T2" }, { wafer: "W4", tool: "T2-audit" }, { wafer: "W6", tool: "T2" },
  ], null, 2) + "\n",
  "data/cached-observation.json": JSON.stringify({ queryId: "cached-q-17", resultId: "cached-r-17", status: "cached", observedAt: "2025-01-03T09:00:00Z", note: "Synthetic maintenance log says tool T2 entered service during the measured window; cached local data, no external query." }, null, 2) + "\n",
}

const criteria = { metric: "defect-rate", grain: "distinct-wafer", windowUtc: { startInclusive: "2025-01-02T00:00:00Z", endExclusive: "2025-01-03T00:00:00Z" } }
const population = (() => {
  const wafers = JSON.parse(sources["data/wafers.json"]), rows = JSON.parse(sources["data/readings.json"]), equipment = JSON.parse(sources["data/equipment.json"])
  const start = Date.parse(criteria.windowUtc.startInclusive), end = Date.parse(criteria.windowUtc.endExclusive)
  const raw = rows.filter((r: any) => Date.parse(r.at) >= start && Date.parse(r.at) < end)
  const unique = [...new Map(raw.map((r: any) => [r.event, r])).values()] as any[]
  const cohort = (name: string) => {
    const ids = [...new Set(unique.filter(r => wafers.find((w: any) => w.wafer === r.wafer)?.cohort === name).map(r => r.wafer))]
    return { wafers: ids.length, defects: ids.filter(id => unique.find(r => r.wafer === id)?.defect === 1).length }
  }
  const legacy = cohort("legacy"), newer = cohort("new")
  return { legacyWafers: legacy.wafers, legacyDefects: legacy.defects, newWafers: newer.wafers, newDefects: newer.defects,
    distinctWafers: new Set(unique.map(r => r.wafer)).size, distinctLots: new Set(unique.map(r => wafers.find((w: any) => w.wafer === r.wafer)?.lot)).size,
    rawWindowRows: raw.length, deduplicatedEvents: unique.length, equipmentJoinedRows: unique.reduce((n, r) => n + equipment.filter((e: any) => e.wafer === r.wafer).length, 0) }
})()
const pending = { queryId: "cached-q-17", resultRef: "data/cached-observation.json", resultId: "cached-r-17", status: "cached" }
const evidenceRefs = Object.keys(sources)
const canonical = (v: any): string => v === null || typeof v !== "object" ? JSON.stringify(v) : Array.isArray(v)
  ? `[${v.map(canonical).join(",")}]` : `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`
const digest = (v: unknown) => createHash("sha256").update(canonical(v)).digest("hex")
const phaseRecord = (i: number) => ({ phase: i, criteria, population, skillVersion: i >= 3 ? "v2" : "v1", pending, evidenceRefs,
  previousPhase: i ? `artifacts/phase-${i - 1}.json` : null, nextAction: i < 6 ? `continue-phase-${i + 1}` : "final-review", claims: ["descriptive association only", "causal effect not established", "process readiness not assessed"] })

const mission = `# Synthetic wafer-yield analysis

Create exactly these required deliverables: scripts/analyze.mjs, tests/analysis.test.mjs, REPORT.md, artifacts/summary.json, and artifacts/phase-0.json through artifacts/phase-6.json. The utility and tests are self-contained except for Node builtins, supplied data files, and tests importing scripts/analyze.mjs; do not add helper files or dependencies. Preserve all supplied raw sources. Use distinct-wafer defect-rate grain, UTC start-inclusive/end-exclusive bounds, deduplicate exact event IDs before analysis, and report equipment join multiplicity separately. Do not infer causality or process readiness. The maintenance observation is local cached input; cite it as an observation and do not claim a live query.

Required summary schema and values: {"population":{"legacyWafers":2,"legacyDefects":1,"newWafers":2,"newDefects":1,"distinctWafers":4,"distinctLots":4,"rawWindowRows":5,"deduplicatedEvents":4,"equipmentJoinedRows":6}}. Each cohort has 2 distinct wafers and 1 defect. Boundary W1 is before the window; W5 is at the excluded endpoint. Source refs: ${evidenceRefs.join(", ")}.

Each phase JSON must include: {"phase":0,"criteria":{"metric":"defect-rate","grain":"distinct-wafer","windowUtc":{"startInclusive":"2025-01-02T00:00:00Z","endExclusive":"2025-01-03T00:00:00Z"}},"population":{"legacyWafers":2,"legacyDefects":1,"newWafers":2,"newDefects":1,"distinctWafers":4,"distinctLots":4,"rawWindowRows":5,"deduplicatedEvents":4,"equipmentJoinedRows":6},"skillVersion":"v1","pending":{"queryId":"cached-q-17","resultRef":"data/cached-observation.json","resultId":"cached-r-17","status":"cached"},"evidenceRefs":[${evidenceRefs.map(x => JSON.stringify(x)).join(",")}],"previousPhase":null,"nextAction":"continue-phase-1","claims":["descriptive association only","causal effect not established","process readiness not assessed"]}. For phase N, set phase=N, previousPhase to artifacts/phase-(N-1).json (null for phase 0), skillVersion to v1 before phase 3 and v2 from phase 3 onward, and nextAction to continue-phase-(N+1), except phase 6 uses final-review. Keep each submitted artifact <=64 KiB.

At phase N, create only artifacts/phase-N.json. Never prefill future phase files; preserve prior phase artifacts unchanged. The discoverable native skill is .opencode/skills/wafer-retention/SKILL.md, with frontmatter name wafer-retention. Phase 3 updates this same file to v2, changing procedure only. The phase record skillVersion must match the submitted skill. The cached observation is not live MCP work.
`

const skillPath = ".opencode/skills/wafer-retention/SKILL.md"
const skillV1 = `---\nname: wafer-retention\ndescription: Analyze the synthetic wafer-yield sources using MISSION.md's fixed grain, UTC window, deduplication, evidence, and descriptive claim limits.\n---\n\n# Wafer retention procedure v1\n1. Parse timestamps as UTC and apply the half-open window.\n2. Deduplicate by event ID, count distinct wafers/lots, and retain raw/joined row counts separately.\n3. Keep claims descriptive; cite supplied sources.\n`
const skillV2 = `${skillV1.replace("procedure v1", "procedure v2")}\n## v2 update (phase 3)\nReconcile the local cached maintenance observation with the window and note timing is confounded with cohort. This procedure update does not change mission criteria or claim limits.\n`
const prompts = [
  "Phase 0 (preparation): inspect the complete mission and inputs. Create the Node analysis utility, meaningful node:test tests, a concise initial report, and artifacts/phase-0.json. Run the tests. Do not defer setup to a later phase.",
  "Phase 1: continue from the durable mission by phase id. Re-run the utility/tests, review the UTC boundary and duplicate handling, update the report, and write artifacts/phase-1.json with the prior output reference.",
  "Phase 2: continue from durable mission by phase id. Audit distinct-wafer denominators against raw and equipment-joined multiplicities; preserve prior phase outputs and write artifacts/phase-2.json.",
  "Phase 3: continue from durable mission by phase id. Apply .opencode/skills/wafer-retention/SKILL.md v2, provided in this phase as a procedure update. Record its version; reconcile the cached observation without changing rules/criteria. Write artifacts/phase-3.json.",
  "Phase 4: continue from durable mission by phase id. Trace evidence refs and the pending cached query/result IDs, distinguish cached evidence from a live query, and write artifacts/phase-4.json.",
  "Phase 5: continue from durable mission by phase id. Check the confounding limitation and keep conclusions descriptive; rerun code/tests and write artifacts/phase-5.json.",
  "Phase 6: continue from durable mission by phase id. Reproduce the summary from preserved raw files, verify tests and the previous-phase chain, and write artifacts/phase-6.json with nextAction final-review.",
]

export function liveRetentionFixture(): { files: Record<string, string>; protectedPaths: string[]; initialPrompt: string; phases: RetentionPhase[]; metadata: Record<string, unknown> } {
  return { files: { "MISSION.md": mission, [skillPath]: skillV1, ...sources },
    protectedPaths: [...Object.keys(sources), "MISSION.md"], initialPrompt: prompts[0]!,
    phases: prompts.map((prompt, i) => ({ id: `phase-${i}`, prompt, outputPath: `artifacts/phase-${i}.json` })),
    metadata: { purpose: "development synthetic retention fixture", executionMode: "current ALG graph through orchestrator",
      requestedCompactions: Array.from({ length: 6 }, (_, i) => ({ beforePhase: i + 1, requested: true })), parentOwnedRestarts: 2,
      stopMonitors: { assistantTurns: 120, elapsedMinutes: 45, reportedComponentTokens: 600000 }, tokenPadding: false } }
}

export function phaseUpdates(index: number): Record<string, string> {
  return index === 3 ? { [skillPath]: skillV2 } : {}
}

export function expectedRetentionChecks(phaseIndex: number): RetentionCheck[] {
  if (!Number.isInteger(phaseIndex) || phaseIndex < 0 || phaseIndex > 6) throw new RangeError("phaseIndex must be 0..6")
  const r = phaseRecord(phaseIndex)
  return [
    ["criteria", "criteria", r.criteria], ["phase", "phase", { phase: r.phase, previousPhase: r.previousPhase }],
    ["skill", "skill", r.skillVersion], ["source-summary", "source", r.population], ["evidence-refs", "evidence", r.evidenceRefs],
    ["pending-query", "pending_intent", r.pending], ["artifact-budget", "budget", { maxBytes: 65536 }], ["next-action", "next_action", { nextAction: r.nextAction, claims: r.claims }],
  ].map(([id, category, value]) => ({ id: id as string, category: category as RetentionCategory, passed: false, expectedDigest: digest(value), observedDigest: null }))
}

export async function scoreRetentionPhase(project: string, phaseIndex: number): Promise<RetentionScore> {
  const gold = expectedRetentionChecks(phaseIndex), diagnostics: string[] = [], base = resolve(project)
  const r = phaseRecord(phaseIndex), limit = 65536
  let record: any = null, summary: any = null, report = "", skill = "", sourceIntact = true, sizeValid = true, lineageValid = true
  const snapshot: Record<string, string> = {}
  const submittedPaths = ["MISSION.md", ".opencode/skills/wafer-retention/SKILL.md", ...Object.keys(sources),
    "scripts/analyze.mjs", "tests/analysis.test.mjs", "REPORT.md", `artifacts/phase-${phaseIndex}.json`, "artifacts/summary.json"]
  const readBounded = async (p: string) => {
    const info = await stat(join(base, p))
    if (info.size > limit) { sizeValid = false; throw new Error(`${p} exceeds 64 KiB`) }
    return readFile(join(base, p), "utf8")
  }
  for (const p of submittedPaths) {
    try { snapshot[p] = await readBounded(p) }
    catch (e) { sizeValid = false; diagnostics.push(`${p}: ${String(e).slice(0, 180)}`) }
  }
  try { record = JSON.parse(snapshot[`artifacts/phase-${phaseIndex}.json`]!) } catch { diagnostics.push("phase artifact missing or invalid JSON") }
  try { summary = JSON.parse(snapshot["artifacts/summary.json"]!) } catch { diagnostics.push("summary artifact missing or invalid JSON") }
  report = snapshot["REPORT.md"] ?? ""
  skill = snapshot[".opencode/skills/wafer-retention/SKILL.md"] ?? ""
  for (const [path, expected] of Object.entries(sources)) if (snapshot[path] !== expected) sourceIntact = false
  if (snapshot["MISSION.md"] !== mission) sourceIntact = false

  for (let i = 0; i < phaseIndex; i++) {
    try {
      const previous = JSON.parse(await readBounded(`artifacts/phase-${i}.json`)), expected = phaseRecord(i)
      if (["phase", "criteria", "population", "skillVersion", "pending", "evidenceRefs", "previousPhase", "nextAction", "claims"].some(k => canonical(previous[k]) !== canonical((expected as any)[k]))) lineageValid = false
    } catch { lineageValid = false }
  }
  for (let i = phaseIndex + 1; i < 7; i++) {
    try { await stat(join(base, `artifacts/phase-${i}.json`)); lineageValid = false; diagnostics.push(`future phase artifact already exists: ${i}`) }
    catch (e: any) { if (e?.code !== "ENOENT") { lineageValid = false; diagnostics.push(`future phase check failed: ${i}`) } }
  }

  let execution = false, tests = false, isolatedSummary: any = null
  let temp = ""
  try {
    temp = await mkdtemp(join(tmpdir(), "alg-live-retention-"))
    for (const [p, content] of Object.entries(snapshot)) { const target = join(temp, p); await mkdir(join(target, ".."), { recursive: true }); await writeFile(target, content) }
    const run = async (args: string[]) => exec("node", args, { cwd: temp, timeout: 10_000, maxBuffer: 256_000 })
    await run(["scripts/analyze.mjs"]); execution = true
    await run(["--test", "tests/analysis.test.mjs"]); tests = true
    for (const p of submittedPaths.filter(p => p !== "artifacts/summary.json"))
      if (await readFile(join(temp, p), "utf8") !== snapshot[p]) throw new Error(`utility/test modified submitted evidence: ${p}`)
    isolatedSummary = JSON.parse(await readFile(join(temp, "artifacts/summary.json"), "utf8"))
  } catch (e) { diagnostics.push(`isolated utility/tests/budget: ${String(e).slice(0, 240)}`) }
  finally { if (temp) await rm(temp, { recursive: true, force: true }) }
  if (canonical(isolatedSummary) !== canonical(summary)) diagnostics.push("submitted summary differs from isolated utility output")
  const observed = [record?.criteria, { phase: record?.phase, previousPhase: record?.previousPhase }, record?.skillVersion,
    summary?.population, record?.evidenceRefs, record?.pending, { maxBytes: 65536 }, { nextAction: record?.nextAction, claims: record?.claims }]
  const comparisons = [r.criteria, { phase: r.phase, previousPhase: r.previousPhase }, r.skillVersion, population, r.evidenceRefs, r.pending, { maxBytes: 65536 }, { nextAction: r.nextAction, claims: r.claims }]
  const checks = gold.map((g, i) => {
    const value = observed[i], expected = comparisons[i]
    let pass = value !== undefined && canonical(value) === canonical(expected)
    if (g.id === "phase") pass = pass && lineageValid
    if (g.id === "skill") pass = pass && record?.skillVersion === r.skillVersion && skill.startsWith(`---\nname: wafer-retention\n`) && skill.includes(`# Wafer retention procedure ${record?.skillVersion}`)
    if (g.id === "artifact-budget") pass = sizeValid
    if (g.id === "source-summary") pass = pass && execution && tests && canonical(isolatedSummary) === canonical(summary)
    if (g.id === "evidence-refs") pass = pass && sourceIntact && report.length > 0 && evidenceRefs.every(ref => report.includes(ref))
    // The mission requires these IDs in the structured record. Requiring a
    // second copy in prose would add an undisclosed criterion.
    const observedDigest = value === undefined ? null : digest(value)
    return { ...g, passed: pass, observedDigest, basis: g.id === "source-summary" ? "independent raw-source gold plus isolated utility and node:test" : undefined }
  })
  return { passed: checks.every(c => c.passed), checks, diagnostics }
}

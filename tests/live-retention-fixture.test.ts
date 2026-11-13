import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expectedRetentionChecks, liveRetentionFixture, phaseUpdates, scoreRetentionPhase } from "../scripts/live-retention-fixture.ts"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))) })
const criteria = { metric: "defect-rate", grain: "distinct-wafer", windowUtc: { startInclusive: "2025-01-02T00:00:00Z", endExclusive: "2025-01-03T00:00:00Z" } }
const population = { legacyWafers: 2, legacyDefects: 1, newWafers: 2, newDefects: 1, distinctWafers: 4, distinctLots: 4, rawWindowRows: 5, deduplicatedEvents: 4, equipmentJoinedRows: 6 }
const pending = { queryId: "cached-q-17", resultRef: "data/cached-observation.json", resultId: "cached-r-17", status: "cached" }
const refs = ["data/wafers.json", "data/readings.json", "data/equipment.json", "data/cached-observation.json"]
const record = (i: number) => ({ phase: i, criteria, population, skillVersion: i >= 3 ? "v2" : "v1", pending, evidenceRefs: refs,
  previousPhase: i ? `artifacts/phase-${i - 1}.json` : null, nextAction: i < 6 ? `continue-phase-${i + 1}` : "final-review",
  claims: ["descriptive association only", "causal effect not established", "process readiness not assessed"] })

const utility = `import { readFile, mkdir, writeFile } from 'node:fs/promises';
export async function analyze(root='.') {
 const read=async p=>JSON.parse(await readFile(root+'/'+p,'utf8'));
 const [wafers,rows,equipment]=await Promise.all(['data/wafers.json','data/readings.json','data/equipment.json'].map(read));
 const start=Date.parse('2025-01-02T00:00:00Z'), end=Date.parse('2025-01-03T00:00:00Z');
 const raw=rows.filter(r=>Date.parse(r.at)>=start&&Date.parse(r.at)<end);
 const unique=[...new Map(raw.map(r=>[r.event,r])).values()];
 const byWafer=new Map(wafers.map(w=>[w.wafer,w]));
 const group=(name)=>{const subset=[...new Set(unique.filter(r=>byWafer.get(r.wafer)?.cohort===name).map(r=>r.wafer))];return {wafers:subset.length,defects:subset.filter(id=>unique.find(r=>r.wafer===id)?.defect===1).length}};
 const joined=unique.reduce((n,r)=>n+equipment.filter(e=>e.wafer===r.wafer).length,0);
 return {population:{legacyWafers:group('legacy').wafers,legacyDefects:group('legacy').defects,newWafers:group('new').wafers,newDefects:group('new').defects,distinctWafers:new Set(unique.map(r=>r.wafer)).size,distinctLots:new Set(unique.map(r=>byWafer.get(r.wafer)?.lot)).size,rawWindowRows:raw.length,deduplicatedEvents:unique.length,equipmentJoinedRows:joined}};
}
if (process.argv[1]?.endsWith('analyze.mjs')) { const result=await analyze(process.cwd()); await mkdir('artifacts',{recursive:true}); await writeFile('artifacts/summary.json',JSON.stringify(result,null,2)+'\\n'); }
`
const childTests = `import {test} from 'node:test'; import assert from 'node:assert/strict'; import {analyze} from '../scripts/analyze.mjs';
test('counts distinct wafers for each cohort',async()=>{const p=(await analyze()).population;assert.equal(p.legacyWafers,2);assert.equal(p.newWafers,2)});
test('uses UTC start-inclusive/end-exclusive boundaries',async()=>assert.equal((await analyze()).population.rawWindowRows,5));
test('deduplicates events before separately counting equipment fanout',async()=>{const p=(await analyze()).population;assert.equal(p.deduplicatedEvents,4);assert.equal(p.equipmentJoinedRows,6)});
`

async function project(phase = 0) {
  const dir = await mkdtemp(join(tmpdir(), "live-retention-")); dirs.push(dir)
  const fixture = liveRetentionFixture()
  const put = async (p: string, data: string) => { const path = join(dir, p); await mkdir(join(path, ".."), { recursive: true }); await writeFile(path, data) }
  for (const [p, data] of Object.entries(fixture.files)) await put(p, data)
  if (phase >= 3) for (const [p, data] of Object.entries(phaseUpdates(3))) await put(p, data)
  await put("scripts/analyze.mjs", utility); await put("tests/analysis.test.mjs", childTests); await put("REPORT.md", `Descriptive association only; no causal effect is established and process readiness is not assessed. Cached refs cached-q-17 and cached-r-17. Evidence: ${refs.join(", ")}.`)
  await put(`artifacts/phase-${phase}.json`, JSON.stringify(record(phase)))
  for (let i = 0; i <= phase; i++) await put(`artifacts/phase-${i}.json`, JSON.stringify(record(i)))
  execFileSync("node", ["scripts/analyze.mjs"], { cwd: dir })
  return { dir, put }
}

describe("bounded live-retention development fixture", () => {
  test("provides a meaningful seven-phase project with visible sources and only a phase-3 skill update", () => {
    const f = liveRetentionFixture()
    expect(f.phases).toHaveLength(7)
    expect(f.phases.map(p => p.id)).toEqual(Array.from({ length: 7 }, (_, i) => `phase-${i}`))
    expect(f.files["data/readings.json"]).toContain("2025-01-02T00:15:00Z")
    expect(f.protectedPaths).toContain("data/readings.json")
    expect(f.metadata).toMatchObject({ parentOwnedRestarts: 2, stopMonitors: { assistantTurns: 120, elapsedMinutes: 45, reportedComponentTokens: 600000 }, tokenPadding: false })
    expect(f.metadata.requestedCompactions).toHaveLength(6)
    expect(phaseUpdates(2)).toEqual({})
    expect(phaseUpdates(3)[".opencode/skills/wafer-retention/SKILL.md"]).toContain("confounded with cohort")
  })

  test("accepts computed outputs, valid alternate property order, source refs, and passing Node tests", async () => {
    const p = await project(0)
    await p.put("artifacts/phase-0.json", JSON.stringify(Object.fromEntries(Object.entries(record(0)).reverse())))
    const result = await scoreRetentionPhase(p.dir, 0)
    if (!result.passed) throw new Error(JSON.stringify({ checks: result.checks.map(c => [c.id, c.passed]), diagnostics: result.diagnostics }))
    expect(result.checks.every(c => c.observedDigest && c.passed)).toBe(true)
  })

  test("rejects changed criteria even when the prose still looks plausible", async () => {
    const p = await project(0); await p.put("artifacts/phase-0.json", JSON.stringify({ ...record(0), criteria: { ...criteria, grain: "reading" } }))
    expect((await scoreRetentionPhase(p.dir, 0)).checks.find(c => c.id === "criteria")?.passed).toBe(false)
  })

  test("rejects a stale skill after the announced v2 update", async () => {
    const p = await project(3)
    const f = liveRetentionFixture(); await p.put(".opencode/skills/wafer-retention/SKILL.md", f.files[".opencode/skills/wafer-retention/SKILL.md"]!)
    const result = await scoreRetentionPhase(p.dir, 3)
    expect(result.checks.find(c => c.id === "skill")?.passed).toBe(false)
  })

  test("accepts the updated v2 skill with unchanged criteria and population", async () => {
    const p = await project(3)
    const result = await scoreRetentionPhase(p.dir, 3)
    expect(result.checks.find(c => c.id === "skill")?.passed).toBe(true)
    expect(result.checks.find(c => c.id === "criteria")?.passed).toBe(true)
    expect(result.checks.find(c => c.id === "source-summary")?.passed).toBe(true)
  })

  test("distinguishes an absent phase artifact from a wrong phase record", async () => {
    const p = await project(1); await rm(join(p.dir, "artifacts/phase-1.json"))
    const result = await scoreRetentionPhase(p.dir, 1)
    expect(result.passed).toBe(false); expect(result.diagnostics).toContain("phase artifact missing or invalid JSON")
    expect(result.checks.find(c => c.id === "artifact-budget")?.passed).toBe(false)
  })

  test("fails evidence integrity if contestant edits a protected raw source", async () => {
    const p = await project(0); await p.put("data/readings.json", "[]\n")
    expect((await scoreRetentionPhase(p.dir, 0)).checks.find(c => c.id === "evidence-refs")?.passed).toBe(false)
  })

  test("checks structured cached IDs and status without requiring prose duplication", async () => {
    const p = await project(0); await p.put("REPORT.md", "Cached local observation. Evidence: " + refs.join(", "))
    expect((await scoreRetentionPhase(p.dir, 0)).passed).toBe(true)
    await p.put("artifacts/phase-0.json", JSON.stringify({ ...record(0), pending: { ...pending, status: "live" } }))
    expect((await scoreRetentionPhase(p.dir, 0)).checks.find(c => c.id === "pending-query")?.passed).toBe(false)
  })

  test("rejects incorrect cached identifiers", async () => {
    const p = await project(0); await p.put("REPORT.md", "I queried the live service. Evidence: " + refs.join(", "))
    await p.put("artifacts/phase-0.json", JSON.stringify({ ...record(0), pending: { ...pending, queryId: "incorrect" } }))
    const result = await scoreRetentionPhase(p.dir, 0)
    expect(result.checks.find(c => c.id === "pending-query")?.passed).toBe(false)
  })

  test("requires a correct previous-phase pointer, including across restart boundaries", async () => {
    const p = await project(5); await p.put("artifacts/phase-5.json", JSON.stringify({ ...record(5), previousPhase: "artifacts/phase-3.json" }))
    expect((await scoreRetentionPhase(p.dir, 5)).checks.find(c => c.id === "phase")?.passed).toBe(false)
  })

  test("reports partial earlier-phase retention loss without masking preserved facts", async () => {
    const p = await project(4); await p.put("artifacts/phase-4.json", JSON.stringify({ ...record(4), pending: { ...pending, resultId: "lost" } }))
    const result = await scoreRetentionPhase(p.dir, 4)
    expect(result.checks.find(c => c.id === "pending-query")?.passed).toBe(false)
    expect(result.checks.find(c => c.id === "criteria")?.passed).toBe(true)
    expect(result.checks.find(c => c.id === "skill")?.passed).toBe(true)
  })

  test("rejects causal or process-readiness claims and does not treat missing artifacts as zero", async () => {
    const p = await project(6); await p.put("REPORT.md", "The intervention caused improvement and proves readiness. Evidence: " + refs.join(", "))
    await p.put("artifacts/phase-6.json", JSON.stringify({ ...record(6), claims: ["intervention caused improvement", "process readiness established"] }))
    const result = await scoreRetentionPhase(p.dir, 6)
    expect(result.checks.find(c => c.id === "next-action")?.passed).toBe(false)
    expect(result.checks.find(c => c.id === "source-summary")?.observedDigest).not.toBeNull()
    expect(await readFile(join(p.dir, "artifacts/phase-6.json"), "utf8")).toContain("final-review")
  })

  test("requires the executable utility and actual node:test suite to pass", async () => {
    const p = await project(0)
    await p.put("scripts/analyze.mjs", utility.replace("const result=await analyze(process.cwd());", "await writeFile('artifacts/phase-0.json','tampered'); const result=await analyze(process.cwd());"))
    const before = await readFile(join(p.dir, "artifacts/phase-0.json"), "utf8")
    const result = await scoreRetentionPhase(p.dir, 0)
    expect(result.passed).toBe(false); expect(result.diagnostics.some(d => d.includes("modified submitted evidence"))).toBe(true)
    expect(await readFile(join(p.dir, "artifacts/phase-0.json"), "utf8")).toBe(before)
  })
})

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const [repoArg, rootArg, outArg] = process.argv.slice(2)
const repo = resolve(repoArg), root = resolve(rootArg), out = resolve(outArg)
if (existsSync(out)) throw Error('Append-only audit output already exists')
const read = (p: string) => JSON.parse(readFileSync(p, 'utf8'))
const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex')
const { collectHardProject, collectHardRunProgress, scoreHardDevelopmentFixture } = await import(pathToFileURL(join(repo, 'scripts/hard-benchmark-cohort.ts')).href)
const raw = read(join(root, 'result.json')), plan = read(join(root, 'plan.json')), fixtures = read(join(root, 'hard-fixtures.json'))
if (!raw.complete || raw.issued !== 12 || raw.results.length !== 12) throw Error('Cohort is not terminal')
const inputs = new Map<string, string>()
const pin = (path: string) => { const digest = hash(path); inputs.set(path, digest); return digest }
for (const name of ['plan.json', 'result.json', 'hard-fixtures.json', 'hard-qualification.json']) pin(join(root, name))
const rows: any[] = []
for (let index = 0; index < plan.cases.length; index++) {
  const fixture = fixtures.find((f: any) => f.contestant.id === plan.cases[index].id)
  if (!fixture) throw Error('Frozen fixture missing')
  for (const arm of ['alg', 'bld']) {
    const name = `${String(index + 1).padStart(2, '0')}-${arm}`, dir = join(root, name), project = join(dir, 'project')
    const resultPath = join(dir, 'result.json'), r = read(resultPath)
    const rawSha = pin(resultPath)
    const collection = collectHardProject(project, fixture)
    for (const entry of collection.manifest) pin(join(project, entry.path))
    const rawCollection = read(join(dir, 'hard-grader-receipt.json')).collection.manifest
    if (JSON.stringify(collection.manifest) !== JSON.stringify(rawCollection)) throw Error(`Changed final project snapshot: ${name}`)
    const eligibleAudit = ['factory-evidence', 'multi-repo-compatibility'].includes(fixture.contestant.family)
    const audit = eligibleAudit ? await scoreHardDevelopmentFixture(fixture, { files: collection.files }) : null
    const diagnostic = collectHardRunProgress(project)
    rows.push({ arm: name, family: fixture.contestant.family, raw_result_sha256: rawSha,
      raw_status: r.status, raw_success: r.scored_task_success, stop_reason: r.stopReason,
      raw_failed_checks: r.independent_score?.checks?.filter((c: any) => !c.passed).map((c: any) => c.id),
      posthoc_artifact_grade: audit, posthoc_changes: fixture.contestant.family === 'factory-evidence' ? 'Equivalent UTC instants, strict UTC/calendar validation retained' : fixture.contestant.family === 'multi-repo-compatibility' ? 'Missing code runner supplied after cohort; original checks unchanged' : 'No rescore',
      runtime_diagnostic: diagnostic, wall_ms: r.wall_ms, turns: r.metrics.assistantTurns.total,
      reported_components: r.metrics.usage.totalReportedTokens, metering_complete: r.metering_complete,
      compactions: r.retention.compactions, fact_loss_claim: r.retention.facts.lossClaim,
      cleanup: r.cleanup, auth_removed: r.auth_copy_removed && !existsSync(join(dir, 'data/opencode/auth.json')),
      source_unchanged: r.source_unchanged, census: r.final_census, database_census: r.databaseCensus })
  }
}
for (const [path, digest] of inputs) if (hash(path) !== digest) throw Error('Audit mutated pinned evidence')
mkdirSync(out, { recursive: true })
const audit = { kind: 'posthoc-development-diagnostic-not-confirmation', raw_source_commit: plan.source_commit,
  auditor_commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim(),
  auditor_sources: ['scripts/hard-benchmark-cohort.ts', 'scripts/hard-benchmark-fixtures.ts'].map(path => ({ path, sha256: hash(join(repo, path)) })),
  issued: raw.issued, completed: raw.completed, stopped: raw.stopped, fatal: raw.fatal,
  global_configuration_unchanged: raw.global_configuration_unchanged, source_unchanged: raw.source_unchanged,
  all_cleanup: rows.every(r => r.cleanup && r.auth_removed), frozen_inputs_unchanged: true,
  interpretation: 'Original scores preserved. Posthoc artifact grades are diagnostic only; they do not repair incomplete telemetry, blocked ALG verification, missing public requirements, or establish superiority. Service cases are not regraded.',
  inputs: [...inputs].map(([path, sha256]) => ({ path, sha256 })), rows }
writeFileSync(join(out, 'audit.json'), JSON.stringify(audit, null, 2) + '\n', { flag: 'wx' })
console.log(JSON.stringify({ issued: raw.issued, completed: raw.completed, stopped: raw.stopped, cleanup: audit.all_cleanup,
  globals_unchanged: audit.global_configuration_unchanged, rows: rows.map(r => ({ arm: r.arm, raw: r.raw_success,
    artifact_posthoc: r.posthoc_artifact_grade?.passed ?? null, runtime: r.runtime_diagnostic,
    failed: r.posthoc_artifact_grade?.checks.filter((c: any) => !c.passed).map((c: any) => c.id) })) }))

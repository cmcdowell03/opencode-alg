import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"
import process from "node:process"
import { EnvironmentMemoryEngine } from "../src/environment-memory/index.ts"
import type { Entity, ReadScope, Relation } from "../src/environment-memory/index.ts"
import { canonicalJson } from "../src/persistence.ts"
import { LocalDirectoryObjectStore } from "../src/environment-memory/object-store.ts"
import { replicateEnvironmentMemory, restoreEnvironmentMemory } from "../src/environment-memory/replication.ts"

const MAX_EVENTS = 10_000_000
const MAX_GRAPH_SIZE = 5_000
const MAX_DURATION_SECONDS = 72 * 60 * 60
const MAX_LATENCY_SAMPLES = 2_000
const namespace = "synthetic-environment-benchmark"
const scope: ReadScope = { namespace, project: "benchmark-project", owner: "benchmark-session" }

interface Config {
  seed: number
  events: number
  graph_size: number
  restart_frequency: number
  duration_seconds: number
  output: string | null
  keep_artifacts: string | null
}

interface LatencySummary {
  p50_ms: number | null
  p95_ms: number | null
  samples: number
  raw_sample_ms: number[]
}

function parsePositive(raw: string, name: string, max: number, allowZero = false): number {
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > max) {
    throw new Error(name + " must be an integer from " + (allowZero ? "0" : "1") + " to " + max)
  }
  return value
}

function parseArgs(argv: string[]): Config {
  const values = new Map<string, string>()
  for (const token of argv) {
    if (!token.startsWith("--") || !token.includes("=")) throw new Error("Arguments must use --name=value")
    const split = token.indexOf("=")
    const key = token.slice(2, split)
    if (values.has(key)) throw new Error("Duplicate option: --" + key)
    values.set(key, token.slice(split + 1))
  }
  const allowed = new Set(["seed", "events", "graph-size", "restart-frequency", "duration-seconds", "output", "keep-artifacts"])
  for (const key of values.keys()) if (!allowed.has(key)) throw new Error("Unknown option: --" + key)
  const seed = parsePositive(values.get("seed") ?? "1", "seed", 0x7fffffff, true)
  const events = parsePositive(values.get("events") ?? "100", "events", MAX_EVENTS)
  const graph_size = parsePositive(values.get("graph-size") ?? "64", "graph-size", MAX_GRAPH_SIZE)
  if (graph_size < 10) throw new Error("graph-size must be at least 10 for the synthetic world fixture")
  const restart_frequency = parsePositive(values.get("restart-frequency") ?? "25", "restart-frequency", MAX_EVENTS, true)
  const duration_seconds = parsePositive(values.get("duration-seconds") ?? "0", "duration-seconds", MAX_DURATION_SECONDS, true)
  return { seed, events, graph_size, restart_frequency, duration_seconds,
    output: values.get("output") ? resolve(values.get("output")!) : null,
    keep_artifacts: values.get("keep-artifacts") ? resolve(values.get("keep-artifacts")!) : null }
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function provenance(sourceRef: string, expires_at: string | null = null) {
  return { source_type: "synthetic" as const, source_ref: sourceRef, classification: "observed" as const,
    observed_at: "2020-01-01T12:00:00.000Z", verified_at: "2020-01-01T12:00:00.000Z", expires_at }
}

function fixtureEntity(id: string, kind: Entity["kind"], label = id): Entity {
  return { id, kind, label, metadata: {}, scope: { ...scope, visibility: "project", owner: null },
    provenance: provenance("fixture:synthetic-world-v1") }
}

function fixtureRelation(id: string, source_id: string, target_id: string, kind: Relation["kind"], principal_ref: string | null = null): Relation {
  return { id, source_id, target_id, kind, scope: { ...scope, visibility: "project", owner: null },
    provenance: provenance("fixture:synthetic-world-v1"),
    conditions: { principal_ref, restrictions: ["synthetic-test-only"], valid_from: null, valid_until: null } }
}

function makeWorld(graphSize: number): { entities: Entity[]; relations: Relation[] } {
  const entities: Entity[] = [
    fixtureEntity("pc-host", "host"), fixtureEntity("app-pod", "pod"), fixtureEntity("gateway", "network"),
    fixtureEntity("data-api", "api"), fixtureEntity("docs-api", "api"), fixtureEntity("repository", "repository"),
    fixtureEntity("deployment", "deployment"), fixtureEntity("database", "database"),
    fixtureEntity("principal-reader", "principal"), fixtureEntity("principal-guest", "principal"),
  ]
  for (let index = entities.length; index < graphSize; index += 1) {
    entities.push(fixtureEntity("resource-" + String(index).padStart(5, "0"), "resource"))
  }
  const relations: Relation[] = [
    fixtureRelation("pod-host", "app-pod", "pc-host", "runs-on"),
    fixtureRelation("pod-gateway", "app-pod", "gateway", "routes-through"),
    fixtureRelation("gateway-data-api-reader", "gateway", "data-api", "reaches", "principal-reader"),
    fixtureRelation("data-api-database-reader", "data-api", "database", "reads-from", "principal-reader"),
    fixtureRelation("gateway-docs-api-guest", "gateway", "docs-api", "reaches", "principal-guest"),
    fixtureRelation("deployment-source", "deployment", "repository", "deployed-from"),
    fixtureRelation("deployment-pod", "deployment", "app-pod", "runs-on"),
    fixtureRelation("reader-database", "principal-reader", "database", "authorized-for", "principal-reader"),
    fixtureRelation("guest-docs", "principal-guest", "docs-api", "authorized-for", "principal-guest"),
  ]
  return { entities, relations }
}

function summarize(values: number[], observations = values.length): LatencySummary {
  if (!values.length) return { p50_ms: null, p95_ms: null, samples: 0, raw_sample_ms: [] }
  const sorted = [...values].sort((a, b) => a - b)
  const quantile = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
  return { p50_ms: quantile(0.5), p95_ms: quantile(0.95), samples: observations, raw_sample_ms: values }
}

function addSample(samples: number[], value: number, seen: number, random: () => number): void {
  if (samples.length < MAX_LATENCY_SAMPLES) samples.push(value)
  else {
    const slot = Math.floor(random() * seen)
    if (slot < MAX_LATENCY_SAMPLES) samples[slot] = value
  }
}

function sourceRevision(): string {
  try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim() }
  catch { return "unavailable" }
}

function workingTreeDirty(): boolean | null {
  try { return execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim().length > 0 }
  catch { return null }
}

function runtimeIdentity() {
  return { bun_version: Bun.version, node_version: process.version, platform: process.platform, arch: process.arch,
    executable: basename(process.execPath) }
}

function directoryBytes(path: string): number {
  let total = 0
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name)
      if (entry.isDirectory()) visit(target)
      else if (entry.isFile()) total += statSync(target).size
    }
  }
  visit(path)
  return total
}

async function run(config: Config) {
  const random = seededRandom(config.seed)
  if (config.keep_artifacts) mkdirSync(config.keep_artifacts, { recursive: true })
  const workspace = mkdtempSync(join(config.keep_artifacts ?? tmpdir(), "alg-env-benchmark-"))
  const databasePath = join(workspace, "source", "memory.sqlite")
  const objectPath = join(workspace, "objects")
  mkdirSync(join(workspace, "source"), { recursive: true })
  const world = makeWorld(config.graph_size)
  let engine = await EnvironmentMemoryEngine.open({ databasePath, namespace, cacheEntries: 128 })
  try {
  let revision = 0
  const setupStarted = performance.now()
  for (const value of world.entities) {
    engine.append({ type: "upsert_entity", entity: value }, { expected_revision: revision, idempotency_key: "fixture:entity:" + value.id })
    revision += 1
  }
  for (const value of world.relations) {
    engine.append({ type: "upsert_relation", relation: value }, { expected_revision: revision, idempotency_key: "fixture:relation:" + value.id })
    revision += 1
  }
  const setupMs = performance.now() - setupStarted

  const commitSamples: number[] = []
  const querySamples: number[] = []
  const recoverySamples: number[] = []
  let commitObservations = 0
  let queryObservations = 0
  let recoveryObservations = 0
  const initialRss = process.memoryUsage().rss
  let rssHighWater = initialRss
  let completedEvents = 0
  let restarts = 0
  const startedAt = performance.now()
  const deadline = config.duration_seconds === 0 ? Number.POSITIVE_INFINITY : startedAt + config.duration_seconds * 1000
  const entityIds = world.entities.map((value) => value.id)
  let workloadElapsedMs = 0

    for (let index = 0; index < config.events && performance.now() < deadline; index += 1) {
      const selected = entityIds[Math.floor(random() * entityIds.length)]!
      const old = engine.get(selected, scope) as Entity | null
      if (!old) throw new Error("benchmark fixture entity disappeared: " + selected)
      const { revision: _revision, ...previous } = old as Entity & { revision: number }
      const updated: Entity = { ...previous, label: "event-" + String(index + 1).padStart(8, "0") }
      const commitStart = performance.now()
      engine.append({ type: "upsert_entity", entity: updated }, { expected_revision: revision, idempotency_key: "benchmark:event:" + (index + 1) })
      commitObservations += 1
      addSample(commitSamples, performance.now() - commitStart, commitObservations, random)
      revision += 1
      completedEvents += 1

      const queryStart = performance.now()
      engine.query({ scope, roots: ["gateway"], max_depth: 6, max_nodes: 256, now: new Date().toISOString() })
      queryObservations += 1
      addSample(querySamples, performance.now() - queryStart, queryObservations, random)

      if ((index & 127) === 0) rssHighWater = Math.max(rssHighWater, process.memoryUsage().rss)
      if (config.restart_frequency > 0 && completedEvents % config.restart_frequency === 0) {
        engine.close()
        const recoveryStart = performance.now()
        engine = await EnvironmentMemoryEngine.open({ databasePath, namespace, cacheEntries: 128 })
        recoveryObservations += 1
        addSample(recoverySamples, performance.now() - recoveryStart, recoveryObservations, random)
        restarts += 1
        const current = engine.status().revision
        if (current !== revision) throw new Error("restart changed the durable revision")
      }
    }
    workloadElapsedMs = performance.now() - startedAt

    const store = await LocalDirectoryObjectStore.open({ directory: objectPath })
    let replicationReceipt: Awaited<ReturnType<typeof replicateEnvironmentMemory>>
    do {
      replicationReceipt = await replicateEnvironmentMemory(engine, store, { eventLimit: 512 })
    } while (replicationReceipt.remote.pending_lag > 0)
    const recoveredPath = join(workspace, "recovered", "memory.sqlite")
    mkdirSync(join(workspace, "recovered"), { recursive: true })
    const destination = await EnvironmentMemoryEngine.open({ databasePath: recoveredPath, namespace })
    try {
      const recoveryStart = performance.now()
      const restoreReceipt = await restoreEnvironmentMemory(destination, store)
      recoveryObservations += 1
      addSample(recoverySamples, performance.now() - recoveryStart, recoveryObservations, random)
      if (restoreReceipt.revision !== engine.status().revision) throw new Error("recovered cursor does not match the source")
      const sourceSnapshot = engine.exportSnapshot()
      const restoredSnapshot = destination.exportSnapshot()
      if (canonicalJson(sourceSnapshot) !== canonicalJson(restoredSnapshot)) throw new Error("recovered snapshot differs from the source")
    } finally { destination.close() }

    const snapshot = engine.exportSnapshot()
    const entityIdsSet = new Set(snapshot.entities.map((value) => value.id))
    const principalIds = new Set(snapshot.entities.filter((value) => value.kind === "principal").map((value) => value.id))
    const invalidRouteClaims = snapshot.relations.filter((value) =>
      value.kind === "reaches" && (!entityIdsSet.has(value.source_id) || !entityIdsSet.has(value.target_id) ||
        (value.conditions.principal_ref !== null && !principalIds.has(value.conditions.principal_ref)))).length
    const invalidPermissionClaims = snapshot.relations.filter((value) =>
      value.kind === "authorized-for" && (value.conditions.principal_ref === null ||
        !principalIds.has(value.conditions.principal_ref) || !entityIdsSet.has(value.target_id))).length
    const status = engine.status()
    rssHighWater = Math.max(rssHighWater, process.memoryUsage().rss)
    const elapsedMs = performance.now() - startedAt
    const report = {
      schema_version: 1,
      measurement_kind: "short synthetic benchmark; not a 24-hour or 72-hour soak",
      source_revision: sourceRevision(),
      working_tree_dirty: workingTreeDirty(),
      runtime: runtimeIdentity(),
      config: { ...config, output: config.output ? basename(config.output) : null, keep_artifacts: Boolean(config.keep_artifacts) },
      workload: { completed_events: completedEvents, setup_operations: world.entities.length + world.relations.length,
        total_committed_revisions: engine.status().revision, restarts, elapsed_ms: elapsedMs, event_workload_elapsed_ms: workloadElapsedMs,
        duration_target_met: config.duration_seconds === 0 ? null : workloadElapsedMs >= config.duration_seconds * 1000,
        stop_reason: completedEvents >= config.events ? "event_limit" : "duration_limit", setup_ms: setupMs },
      latency: { commit: summarize(commitSamples, commitObservations), query: summarize(querySamples, queryObservations), recovery: summarize(recoverySamples, recoveryObservations),
        sampling: { method: "deterministic reservoir sampling", max_samples_per_metric: MAX_LATENCY_SAMPLES } },
      memory: { initial_rss_bytes: initialRss, high_water_rss_bytes: rssHighWater },
      storage: { database_bytes: directoryBytes(join(workspace, "source")), object_store_bytes: directoryBytes(objectPath) },
      cache: { entries: status.cache.entries, capacity: status.cache.capacity, evictions: status.cache.evictions },
      replication: { highest_replicated_revision: replicationReceipt.remote.highest_replicated_revision,
        pending_lag: replicationReceipt.remote.pending_lag, durability: replicationReceipt.remote.durability },
      retained_facts: { entities: status.entities, relations: status.relations },
      invalid_claims: { route: invalidRouteClaims, permission: invalidPermissionClaims },
      artifacts: { retained: Boolean(config.keep_artifacts), directory: config.keep_artifacts },
    }
    if (config.keep_artifacts) {
      report.artifacts = { retained: true, directory: workspace }
      writeFileSync(join(workspace, "benchmark.json"), JSON.stringify(report, null, 2) + "\n")
    }
    const json = JSON.stringify(report, null, 2) + "\n"
    if (config.output) {
      mkdirSync(dirname(config.output), { recursive: true })
      writeFileSync(config.output, json)
    }
    process.stdout.write(json)
  } finally {
    engine.close()
    if (!config.keep_artifacts) rmSync(workspace, { recursive: true, force: true })
  }
}

try {
  await run(parseArgs(process.argv.slice(2)))
} catch (error) {
  process.stderr.write("environment-memory benchmark failed: " + (error instanceof Error ? error.message : String(error)) + "\n")
  process.exitCode = 1
}

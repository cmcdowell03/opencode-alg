/** Synthetic filesystem benchmark. Fixtures contain no real endpoints or model calls. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, statSync } from "node:fs"
import { tmpdir, cpus, platform, release } from "node:os"
import { join } from "node:path"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { MemoryNodeSchema } from "../src/session-memory/schemas.ts"
import { hashObject } from "../src/session-memory/store.ts"
import { canonicalJson } from "../src/persistence.ts"

export function memoryBenchmark(samples = 20) {
  if (!Number.isInteger(samples) || samples < 10 || samples > 100) throw new Error("benchmark sample bound")
  const path = mkdtempSync(join(tmpdir(), "alg-memory-benchmark-"))
  try {
    for (let i = 0; i < 100; i++) {
      const name = `skill-${i}`, dir = join(path, ".opencode", "skills", name)
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Synthetic unique operation ${i}\n---\nUse procedure ${i} completely. Verify current permissions.\n`)
    }
    const make = () => new SessionMemoryRuntime(path, { mode: "assist", fallbackTokens: 4096 }, [".opencode/skills"], [])
    const memory = make()
    memory.beginTask("benchmark-owner", "Use skill-87")
    memory.bindSkill("benchmark-owner", memory.index.search("skill-87").skills[0]!.key)
    const objects = memory.store.path(["objects"])
    // Setup writes canonical schema-checked fixtures directly to avoid timing writer census
    // 1,000 times. Restore still uses production readers and integrity checks.
    let selected = ""
    for (let i = 0; i < 1000; i++) {
      const node = MemoryNodeSchema.parse({ schema_version: 1, project: memory.store.projectId, owner: "benchmark-owner", visibility: "session",
        created_at: new Date(0).toISOString(), relations: [], kind: "proposal", summary: `Synthetic fact ${i}`, payload: { content: `Unverified fixture ${i}` } })
      const id = hashObject(node)
      writeFileSync(join(objects, `${id}.json`), canonicalJson(node))
      if (i === 987) selected = id
    }
    memory.pin("benchmark-owner", selected)
    const warm: number[] = [], cold: number[] = []
    let bytes = 0
    for (let i = 0; i < samples; i++) {
      let start = performance.now()
      const prepared = memory.prepare("benchmark-owner")
      warm.push(performance.now() - start)
      start = performance.now()
      const restored = make().prepare("benchmark-owner")
      cold.push(performance.now() - start)
      if (prepared.blocked || restored.blocked || !restored.text.includes("Use procedure 87 completely")) throw new Error(`benchmark restore failed: ${JSON.stringify({ warm: prepared.receipt?.reasons, cold: restored.receipt?.reasons, skills: memory.current("benchmark-owner").skills.map((entry) => entry.name) })}`)
      bytes = Buffer.byteLength(restored.text)
    }
    const summary = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b)
      return { samples_ms: values, median_ms: sorted[Math.floor(sorted.length / 2)]!, p95_ms: sorted[Math.ceil(sorted.length * .95) - 1]! }
    }
    const measured = { warm: summary(warm), cold: summary(cold) }
    const objectBytes = readdirSync(objects).reduce((sum, name) => sum + statSync(join(objects, name)).size, 0)
    return { fixture: { skills: 100, unrelated_nodes: 1000, selected_nodes: 2, context_bytes: bytes, object_bytes: objectBytes },
      runtime: { bun: Bun.version, platform: platform(), release: release(), cpu: cpus()[0]?.model, logical_cpus: cpus().length },
      ...measured, original_targets: { warm_p95_ms: 100, cold_p95_ms: 500 }, original_targets_met: measured.warm.p95_ms <= 100 && measured.cold.p95_ms <= 500,
      targets: { warm_p95_ms: 500, cold_p95_ms: 500 }, passed: measured.warm.p95_ms <= 500 && measured.cold.p95_ms <= 500,
      interpretation: "Synthetic local filesystem only; setup excluded, production verified reads and receipt writes included." }
  } finally { rmSync(path, { recursive: true, force: true }) }
}
if (import.meta.main) {
  const result = memoryBenchmark()
  console.log(JSON.stringify(result))
  if (!result.passed) process.exitCode = 1
}

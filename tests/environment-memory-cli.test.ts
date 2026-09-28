import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runEnvironmentMemoryCommand } from "../scripts/environment-memory-cli.ts"
import { EnvironmentMemoryEngine } from "../src/environment-memory/engine.ts"

const roots: string[] = []
function directory() { const path = mkdtempSync(join(tmpdir(), "alg-env-cli-")); roots.push(path); return path }
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const scope = { namespace: "cli-fixture", project: "cli-project", visibility: "project" as const, owner: null }
const provenance = { source_type: "synthetic" as const, source_ref: "fixture:cli", classification: "declared" as const,
  observed_at: "2020-01-01T12:00:00.000Z", verified_at: null, expires_at: null }

test("CLI input stays bounded even when a file is already larger than the limit", async () => {
  const root = directory(), input = join(root, "oversized.json"), database = join(root, "memory.sqlite")
  writeFileSync(input, "x".repeat(1024 * 1024 + 1))
  await expect(runEnvironmentMemoryCommand(["import", database, scope.namespace, input])).rejects.toThrow("input exceeds 1048576 bytes")
  const engine = await EnvironmentMemoryEngine.open({ databasePath: database, namespace: scope.namespace })
  try { expect(engine.status().revision).toBe(0) } finally { engine.close() }
})

test("CLI prevalidates structure and reports durable progress on a later semantic failure", async () => {
  const root = directory(), input = join(root, "operations.json"), database = join(root, "memory.sqlite")
  const first = { idempotency_key: "entity-a", operation: { type: "upsert_entity", entity: {
    id: "a", kind: "host", label: "A", metadata: {}, scope, provenance,
  } } }
  const second = { idempotency_key: "dangling", operation: { type: "upsert_relation", relation: {
    id: "bad", source_id: "a", target_id: "missing", kind: "reaches", scope, provenance,
    conditions: { principal_ref: null, restrictions: [], valid_from: null, valid_until: null },
  } } }
  writeFileSync(input, JSON.stringify({ operations: [first, { ...second, operation: { type: "unknown" } }] }))
  await expect(runEnvironmentMemoryCommand(["import", database, scope.namespace, input])).rejects.toThrow()
  const empty = await EnvironmentMemoryEngine.open({ databasePath: database, namespace: scope.namespace })
  try { expect(empty.status().revision).toBe(0) } finally { empty.close() }

  writeFileSync(input, JSON.stringify({ operations: [first, second] }))
  await expect(runEnvironmentMemoryCommand(["import", database, scope.namespace, input]))
    .rejects.toThrow("import stopped after 1 accepted entries at revision 1")
  const committed = await EnvironmentMemoryEngine.open({ databasePath: database, namespace: scope.namespace })
  try { expect(committed.status().revision).toBe(1); expect(committed.get("a", { namespace: scope.namespace, project: scope.project, owner: "reader" })).not.toBeNull() }
  finally { committed.close() }
})

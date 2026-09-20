/** Offline synthetic gate; no live host/provider invocation. */
import { existsSync, realpathSync } from "node:fs"
import { isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import { randomUUID } from "node:crypto"
import { computeReleaseInputIdentity, runReleaseCommand, validatePackedInventory } from "./release-gate.ts"
import { resolveNpmInvocation } from "./npm-invocation.ts"
import { isContained, isFilesystemRoot } from "../src/paths.ts"
import { atomicWriteFile } from "../src/store.ts"
import { hashText } from "../src/session-memory/store.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
export async function runSessionMemoryGate(directory: string) {
  if (!isAbsolute(directory) || !existsSync(directory)) throw new Error("provide an absolute existing external evidence directory")
  const output = realpathSync.native(directory)
  if (isContained(realpathSync.native(root), output) || isFilesystemRoot(output)) throw new Error("evidence must be outside package and not a drive root")
  const source = computeReleaseInputIdentity(root)
  const steps: Array<{ id: string; result: Awaited<ReturnType<typeof runReleaseCommand>> }> = []
  let failure: string | null = null, benchmark: unknown = null
  const step = async (id: string, kind: Parameters<typeof runReleaseCommand>[0], executable: string, args: string[]) => {
    console.error(`session-memory gate: ${id}`)
    const result = await runReleaseCommand(kind, executable, args, root)
    steps.push({ id, result })
    if (result.evidence.exit_code !== 0) throw new Error(`synthetic gate failed: ${id}`)
    return result
  }
  try {
    await step("typecheck", "typecheck", process.execPath, ["run", "typecheck"])
    await step("affected-regressions", "bun_test", process.execPath, ["test", "tests/model-agnostic-recovery.test.ts", "tests/session-memory.test.ts", "tests/session-memory-host.test.ts",
      "tests/skill-catalog.test.ts", "tests/architecture-audit.test.ts", "tests/skill-evolution-runtime.test.ts", "tests/skill-evolution-evidence-schema.test.ts",
      "tests/skill-evolution-store.test.ts", "tests/experience.test.ts", "tests/models-sessions-plugin.test.ts", "tests/duckdb-capability.test.ts",
      "tests/live-verify.test.ts", "tests/release-gate.test.ts", "tests/executor.test.ts", "--timeout", "60000"])
    await step("historical-and-promotion-regressions", "bun_test", process.execPath, ["test", "tests/skill-evolution-historical.test.ts",
      "tests/skill-evolution-foundations.test.ts", "tests/skill-evolution-tools-promotion.test.ts", "--timeout", "60000"])
    const measured = await step("synthetic-performance", "smoke", process.execPath, ["run", "scripts/session-memory-benchmark.ts"])
    benchmark = JSON.parse(measured.stdout)
    const npm = resolveNpmInvocation()
    const packed = await step("package-inventory", "npm_pack", npm.executable, [...npm.argsPrefix, "pack", "--dry-run", "--json", "--ignore-scripts"])
    validatePackedInventory(JSON.parse(packed.stdout)[0].files)
    if (JSON.stringify(source) !== JSON.stringify(computeReleaseInputIdentity(root))) throw new Error("source changed during verification")
  } catch (error) { failure = error instanceof Error ? error.message : "verification failed" }
  const record = { schema_version: 1, kind: "alg-session-memory-synthetic", source, generated_at: new Date().toISOString(),
    passed: failure === null, failure, host_delivery: "NOT_ATTESTED", real_services: "NOT_MEASURED", model_calls: 0, release_approved: false, benchmark, steps }
  const bytes = JSON.stringify(record, null, 2)
  if (Buffer.byteLength(bytes) > 2 * 1024 * 1024) throw new Error("gate evidence exceeds bound")
  const path = join(output, `session-memory-${randomUUID()}.json`)
  atomicWriteFile(path, bytes)
  return { passed: record.passed, failure, path, sha256: hashText(bytes), steps: steps.length, benchmark }
}
if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw new Error("usage: check:session-memory <absolute-existing-external-evidence-directory>")
    const result = await runSessionMemoryGate(process.argv[2]!)
    console.log(JSON.stringify(result))
    if (!result.passed) process.exitCode = 1
  } catch (error) { console.error(error instanceof Error ? error.message : "session memory gate failed"); process.exitCode = 1 }
}

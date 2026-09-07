/** Offline-account acceptance: real local runtimes, synthetic fixtures, no live host or services. */
import { randomUUID, createHash } from "node:crypto"
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { computeReleaseInputIdentity, runReleaseCommand, validatePackedInventory } from "./release-gate.ts"
import { resolveNpmInvocation } from "./npm-invocation.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))
export async function runSyntheticGate(args: string[]) {
  const [duckdbPython, dataSciencePython, requestedEvidence] = args
  if (args.length !== 3 || !duckdbPython || !dataSciencePython || !requestedEvidence || !args.every(isAbsolute)) {
    throw new Error("usage: check:synthetic <prepared-duckdb-python> <prepared-datascience-python> <external-evidence-directory>")
  }
  const canonicalRoot = realpathSync.native(ROOT)
  if (!existsSync(requestedEvidence)) throw new Error("create the external evidence directory explicitly before verification")
  const directory = realpathSync.native(requestedEvidence)
  const rel = relative(canonicalRoot, directory)
  if (!(rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))) throw new Error("evidence must be outside the package")
  const source = computeReleaseInputIdentity(ROOT)
  const steps: Array<{ id: string; result: Awaited<ReturnType<typeof runReleaseCommand>> }> = []
  let failure: string | null = null
  const step = async (id: string, runnerId: Parameters<typeof runReleaseCommand>[0], executable: string, argv: string[]) => {
    console.error(`synthetic gate: ${id}`)
    const result = await runReleaseCommand(runnerId, executable, argv, ROOT, { PYTHONDONTWRITEBYTECODE: "1" })
    steps.push({ id, result })
    if (result.evidence.exit_code !== 0) throw new Error(`synthetic check failed: ${id}`)
    return result
  }
  try {
    await step("typecheck", "typecheck", process.execPath, ["run", "typecheck"])
    await step("duckdb-manifest", "duckdb_manifest", process.execPath, ["run", "check:duckdb-manifest"])
    await step("excel-manifest", "excel_manifest", process.execPath, ["run", "check:excel-manifest"])
    await step("optional-manifests", "excel_manifest", process.execPath, ["run", "check:optional-manifests"])
    await step("duckdb-runtime", "python_tests", duckdbPython, ["-I", "-B", "-c", "import duckdb,sqlglot; assert duckdb.__version__=='1.4.0'; assert sqlglot.__version__=='27.14.0'; print('pinned-runtime-ok')"])
    await step("datascience-runtime", "python_tests", dataSciencePython, ["-I", "-B", "-c", "import duckdb,pyarrow; assert duckdb.__version__=='1.4.0'; assert pyarrow.__version__=='21.0.0'; print('pinned-runtime-ok')"])
    await step("excel-policy-tests", "python_tests", duckdbPython, ["-B", "-m", "unittest", "discover", "-s", "tests/python", "-p", "test_excel_capability.py", "-v"])
    await step("duckdb-tests", "duckdb_python_tests", duckdbPython, ["-B", "-m", "unittest", "discover", "-s", "tests/python", "-p", "test_duckdb*.py", "-v"])
    await step("datascience-tests", "python_tests", dataSciencePython, ["-B", "-m", "unittest", "discover", "-s", "tests/python", "-p", "test_datascience.py", "-v"])
    await step("connector-tests", "python_tests", duckdbPython, ["-B", "-m", "unittest", "discover", "-s", "tests/python", "-p", "test_connectors.py", "-v"])
    await step("bun-tests", "bun_test", process.execPath, ["test", "--timeout", "120000"])
    await step("smoke", "smoke", process.execPath, ["run", "smoke"])
    const npm = resolveNpmInvocation()
    const pack = await step("package-inventory", "npm_pack", npm.executable, [...npm.argsPrefix, "pack", "--dry-run", "--json", "--ignore-scripts"])
    validatePackedInventory(JSON.parse(pack.stdout)[0].files)
    if (JSON.stringify(computeReleaseInputIdentity(ROOT)) !== JSON.stringify(source)) throw new Error("source changed during synthetic verification")
  } catch (error) { failure = error instanceof Error ? error.message : "synthetic verification failed" }
  const record = { schema_version: 1, kind: "alg-synthetic-verification", source, generated_at: new Date().toISOString(),
    live_host_verified: false, remote_services_verified: false, release_approved: false, passed: failure === null, failure, steps }
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`)
  if (bytes.length > 2 * 1024 * 1024) throw new Error("synthetic evidence exceeded bound")
  const path = join(directory, `alg-synthetic-${randomUUID()}.json`)
  writeFileSync(path, bytes, { flag: "wx", mode: 0o600 })
  if (!readFileSync(path).equals(bytes)) throw new Error("synthetic evidence changed during publication")
  return { passed: record.passed, failure, path, sha256: createHash("sha256").update(bytes).digest("hex"), steps: steps.length }
}

if (import.meta.main || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  try {
    const result = await runSyntheticGate(process.argv.slice(2))
    console.log(JSON.stringify(result))
    if (!result.passed) process.exitCode = 1
  } catch (error) { console.error(error instanceof Error ? error.message : "synthetic gate failed"); process.exitCode = 1 }
}

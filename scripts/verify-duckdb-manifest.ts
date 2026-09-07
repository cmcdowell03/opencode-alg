import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DUCKDB_ASSET_FILES } from "../src/capability-assets.ts"

export const DUCKDB_CAPABILITY_FILES = DUCKDB_ASSET_FILES

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function verifyDuckDbManifest(packageRoot: string): {
  manifest_sha256: string
  files: Record<typeof DUCKDB_CAPABILITY_FILES[number], string>
} {
  const directory = resolve(packageRoot, "capabilities", "duckdb")
  const manifestPath = resolve(directory, "manifest.json")
  const bytes = readFileSync(manifestPath)
  const manifest = JSON.parse(bytes.toString("utf8")) as any
  if (manifest?.schema_version !== 1 || manifest?.id !== "alg-duckdb" || manifest?.version !== "0.1.0" ||
    manifest?.runtime?.python !== ">=3.11,<3.14" || manifest?.runtime?.transport !== "stdio" ||
    manifest?.runtime?.prepared_interpreter_only !== true || manifest?.runtime?.extension_auto_install !== false ||
    manifest?.runtime?.extension_auto_load !== false || manifest?.runtime?.extension_inventory !== "empty") {
    throw new Error("DuckDB manifest identity/runtime is invalid")
  }
  if (JSON.stringify(manifest.dependencies) !== JSON.stringify({ duckdb: "1.4.0", sqlglot: "27.14.0", lock: "uv.lock" })) {
    throw new Error("DuckDB manifest dependency identity is invalid")
  }
  if (JSON.stringify(Object.keys(manifest.files_sha256 ?? {}).sort()) !== JSON.stringify([...DUCKDB_CAPABILITY_FILES].sort())) {
    throw new Error("DuckDB manifest file inventory is not the strict shipped set")
  }
  const observed = {} as Record<typeof DUCKDB_CAPABILITY_FILES[number], string>
  for (const name of DUCKDB_CAPABILITY_FILES) {
    observed[name] = sha256(resolve(directory, name))
    if (observed[name] !== manifest.files_sha256[name]) throw new Error(`DuckDB manifest hash drift: ${name}`)
  }
  return { manifest_sha256: createHash("sha256").update(bytes).digest("hex"), files: observed }
}

const isMain = Boolean(import.meta.main) || (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  console.log(JSON.stringify({ ok: true, ...verifyDuckDbManifest(root) }))
}

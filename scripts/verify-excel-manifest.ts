import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const FILES = {
  pyproject: "pyproject.toml",
  lock: "uv.lock",
  policy: "policy.py",
  wrapper: "wrapper.py",
  validator: "workbook.py",
} as const

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

export function verifyExcelManifest(packageRoot: string): {
  manifest_sha256: string
  files: Record<keyof typeof FILES, string>
} {
  const directory = resolve(packageRoot, "capabilities", "excel")
  const manifestPath = resolve(directory, "manifest.json")
  const bytes = readFileSync(manifestPath)
  const manifest = JSON.parse(bytes.toString("utf8")) as any
  if (manifest?.schema_version !== 1 || manifest?.id !== "alg-excel" || manifest?.upstream?.version !== "0.1.8") {
    throw new Error("Excel manifest identity/version is invalid")
  }
  if (JSON.stringify(manifest.files && Object.fromEntries(Object.keys(FILES).map((key) => [key, manifest.files[key]]))) !== JSON.stringify(FILES)) {
    throw new Error("Excel manifest file paths are not the strict shipped set")
  }
  const observed = {} as Record<keyof typeof FILES, string>
  for (const [key, name] of Object.entries(FILES) as Array<[keyof typeof FILES, string]>) {
    observed[key] = sha256(resolve(directory, name))
    if (observed[key] !== manifest.files?.sha256?.[key]) throw new Error(`Excel manifest hash drift: ${key}`)
  }
  return { manifest_sha256: createHash("sha256").update(bytes).digest("hex"), files: observed }
}

const isMain = Boolean(import.meta.main) || (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
if (isMain) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
  console.log(JSON.stringify({ ok: true, ...verifyExcelManifest(root) }))
}

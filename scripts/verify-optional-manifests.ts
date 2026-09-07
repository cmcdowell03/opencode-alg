import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { DATASCIENCE_ASSET_FILES, CONNECTOR_ASSET_FILES } from "../src/capability-assets.ts"

const Hashes = z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
const DataScienceManifest = z.object({
  schema_version: z.literal(1), id: z.literal("alg-datascience"), version: z.literal("0.1.0"),
  runtime: z.object({ python: z.literal(">=3.11,<3.14"), prepared_interpreter_only: z.literal(true), network_access: z.literal(false) }).strict(),
  dependencies: z.object({ duckdb: z.literal("1.4.0"), pyarrow: z.literal("21.0.0"), lock: z.literal("uv.lock") }).strict(),
  files_sha256: Hashes,
}).strict()
const ConnectorManifest = z.object({
  schema_version: z.literal(1), id: z.literal("alg-connectors"), version: z.literal("0.1.0"),
  mode: z.literal("preparation_only"), remote_activation: z.literal(false), engine_version: z.literal("1.4.0"), files_sha256: Hashes,
}).strict()

export function verifyOptionalManifests(root: string) {
  const files = DATASCIENCE_ASSET_FILES
  const path = resolve(root, "capabilities/datascience/manifest.json")
  const raw = readFileSync(path)
  const manifest = DataScienceManifest.parse(JSON.parse(raw.toString("utf8")))
  if (manifest.schema_version !== 1 || manifest.id !== "alg-datascience" || manifest.version !== "0.1.0" ||
      manifest.runtime?.python !== ">=3.11,<3.14" || manifest.runtime?.prepared_interpreter_only !== true || manifest.runtime?.network_access !== false ||
      JSON.stringify(manifest.dependencies) !== JSON.stringify({ duckdb: "1.4.0", pyarrow: "21.0.0", lock: "uv.lock" }) ||
      JSON.stringify(Object.keys(manifest.files_sha256).sort()) !== JSON.stringify([...files].sort())) throw new Error("optional capability manifest identity/inventory mismatch")
  for (const name of files) {
    const hash = createHash("sha256").update(readFileSync(resolve(root, "capabilities/datascience", name))).digest("hex")
    if (manifest.files_sha256[name] !== hash) throw new Error(`data-science manifest drift: ${name}`)
  }
  const connectorRaw = readFileSync(resolve(root, "capabilities/connectors/manifest.json"))
  const connector = ConnectorManifest.parse(JSON.parse(connectorRaw.toString("utf8")))
  if (connector.schema_version !== 1 || connector.id !== "alg-connectors" || connector.version !== "0.1.0" ||
    connector.mode !== "preparation_only" || connector.remote_activation !== false || connector.engine_version !== "1.4.0" ||
    JSON.stringify(Object.keys(connector.files_sha256).sort()) !== JSON.stringify([...CONNECTOR_ASSET_FILES].sort())) throw new Error("connector manifest identity/inventory mismatch")
  for (const name of CONNECTOR_ASSET_FILES) {
    const hash = createHash("sha256").update(readFileSync(resolve(root, "capabilities/connectors", name))).digest("hex")
    if (connector.files_sha256[name] !== hash) throw new Error(`connector manifest drift: ${name}`)
  }
  return { datascience: { manifest_sha256: createHash("sha256").update(raw).digest("hex"), files: files.length },
    connectors: { manifest_sha256: createHash("sha256").update(connectorRaw).digest("hex"), files: CONNECTOR_ASSET_FILES.length } }
}

if (import.meta.main || (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))) {
  console.log(JSON.stringify(verifyOptionalManifests(fileURLToPath(new URL("..", import.meta.url)))))
}

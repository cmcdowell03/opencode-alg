import { expect, test } from "bun:test"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { verifyOptionalManifests } from "../scripts/verify-optional-manifests.ts"
import { DATASCIENCE_ASSET_FILES, CONNECTOR_ASSET_FILES } from "../src/capability-assets.ts"
import { tempProject, removeProject } from "./helpers.ts"

test("optional manifests reject drift, extra metadata and unpinned or activated capability contracts", () => {
  const source = fileURLToPath(new URL("..", import.meta.url))
  const root = tempProject("alg-optional-manifests-")
  try {
    for (const [kind, assets] of [["datascience", DATASCIENCE_ASSET_FILES], ["connectors", CONNECTOR_ASSET_FILES]] as const) {
      const target = join(root, "capabilities", kind)
      mkdirSync(target, { recursive: true })
      for (const asset of [...assets, "manifest.json"]) copyFileSync(join(source, "capabilities", kind, asset), join(target, asset))
    }
    expect(verifyOptionalManifests(root).datascience.files).toBe(6)
    for (const [kind, modify] of [
      ["datascience", (value: any) => { value.runtime.network_access = true }],
      ["datascience", (value: any) => { value.dependencies.pyarrow = ">=21.0.0" }],
      ["datascience", (value: any) => { value.approved = true }],
      ["datascience", (value: any) => { value.files_sha256["extra.py"] = "a".repeat(64) }],
      ["connectors", (value: any) => { value.remote_activation = true }],
      ["connectors", (value: any) => { delete value.files_sha256["adapter.py"] }],
    ] as const) {
      const path = join(root, "capabilities", kind, "manifest.json")
      const prior = readFileSync(path)
      const value = JSON.parse(prior.toString())
      modify(value)
      writeFileSync(path, JSON.stringify(value))
      expect(() => verifyOptionalManifests(root)).toThrow()
      writeFileSync(path, prior)
    }
    const asset = join(root, "capabilities", "datascience", "runner.py")
    writeFileSync(asset, `${readFileSync(asset, "utf8")}\n# synthetic drift\n`)
    expect(() => verifyOptionalManifests(root)).toThrow("data-science manifest drift")
  } finally { removeProject(root) }
})

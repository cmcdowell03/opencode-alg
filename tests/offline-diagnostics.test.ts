import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("offline diagnostics", () => {
  test("rejects a foreign --root instead of mixing local parser code with another package's digest", () => {
    const root = mkdtempSync(join(tmpdir(), "alg-offline-foreign-root-"))
    roots.push(root)
    expect(existsSync(join(root, ".git"))).toBe(false)

    const script = fileURLToPath(new URL("../scripts/offline-diagnostics.ts", import.meta.url))
    const childEnv = { ...process.env }
    delete childEnv.OPENCODE_ALG_CONFIG
    const result = spawnSync(process.execPath, ["--no-install", script, "--root", root], {
      cwd: root,
      encoding: "utf8",
      env: childEnv,
    })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("from the target package without arguments")
  })
})

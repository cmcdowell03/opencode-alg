import { expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { expectedPackedPaths, validatePackedInventory } from "../scripts/release-gate.ts"
import { resolveNpmInvocation } from "../scripts/npm-invocation.ts"
import { tempProject, removeProject } from "./helpers.ts"

const ROOT = fileURLToPath(new URL("..", import.meta.url))

test("publishable npm lock and checkout lock have identical dependency authority", () => {
  const checkout = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"))
  const published = JSON.parse(readFileSync(join(ROOT, "npm-shrinkwrap.json"), "utf8"))
  expect(published).toEqual(checkout)
  expect(expectedPackedPaths()).toContain("npm-shrinkwrap.json")
  expect(expectedPackedPaths()).toContain("bun.lock")
})

test("actual extracted package has the full reviewed inventory and dependency-ready installer entrypoint", () => {
  const directory = tempProject("alg-packed-completion-")
  try {
    const npm = resolveNpmInvocation()
    const packed = spawnSync(npm.executable, [...npm.argsPrefix, "pack", "--json", "--ignore-scripts", "--pack-destination", directory], {
      cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 60_000,
    })
    expect({ status: packed.status, error: packed.error?.message, stderr: packed.stderr }).toMatchObject({ status: 0 })
    const archive = JSON.parse(packed.stdout)[0]
    validatePackedInventory(archive.files)
    expect(archive.files.some((f: { path: string }) => f.path === "npm-shrinkwrap.json")).toBe(true)
    expect(archive.files.some((f: { path: string }) => /(?:experience\/outbox|\.venv|__pycache__)/.test(f.path))).toBe(false)
    const extracted = spawnSync("tar", ["-xf", join(directory, archive.filename), "-C", directory], { encoding: "utf8", windowsHide: true, timeout: 30_000 })
    expect({ status: extracted.status, stderr: extracted.stderr }).toMatchObject({ status: 0 })
    const packageRoot = join(directory, "package")
    for (const path of expectedPackedPaths()) expect(existsSync(join(packageRoot, path)), path).toBe(true)
    // This test verifies dependency-ready packaged execution, not a network install.
    symlinkSync(join(ROOT, "node_modules"), join(packageRoot, "node_modules"), process.platform === "win32" ? "junction" : "dir")
    const config = join(directory, "private-config")
    mkdirSync(config)
    const invocation = spawnSync(process.execPath, [join(packageRoot, "scripts", "installer-core.ts"), "--config-dir", config, "--skip-agents"], {
      cwd: packageRoot, encoding: "utf8", windowsHide: true, timeout: 30_000,
    })
    expect({ status: invocation.status, stderr: invocation.stderr }).toMatchObject({ status: 0 })
    expect(readFileSync(join(config, "opencode.jsonc"), "utf8")).toContain("file:")
    const removed = spawnSync(process.execPath, [join(packageRoot, "scripts", "installer-core.ts"), "--config-dir", config, "--uninstall"], {
      cwd: packageRoot, encoding: "utf8", windowsHide: true, timeout: 30_000,
    })
    expect(removed.status).toBe(0)
    expect(readFileSync(join(config, "opencode.jsonc"), "utf8")).not.toContain("file:")
  } finally { removeProject(resolve(directory)) }
}, 120_000)

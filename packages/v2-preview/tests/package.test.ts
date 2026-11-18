import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

test("the relocated preview loads in a fresh process without a registry or checkout", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "alg-v2-package-"))
  try {
    const prepared = join(scratch, "prepared")
    const cli = fileURLToPath(new URL("../build.ts", import.meta.url))
    const build = () => Bun.spawnSync([process.execPath, "--no-install", cli, prepared], {
      cwd: resolve(import.meta.dir, "../../.."),
    })
    const built = build()
    expect(built.exitCode, built.stderr.toString()).toBe(0)
    const receipt = JSON.parse(built.stdout.toString())
    const repeated = build()
    expect(repeated.exitCode).not.toBe(0)
    expect(repeated.stderr.toString()).toContain("EEXIST")
    const relocated = join(scratch, "relocated with spaces")
    renameSync(prepared, relocated)
    const pkg = JSON.parse(readFileSync(join(relocated, "package.json"), "utf8"))
    expect(pkg.engines.opencode).toBe("2.3.2")
    expect(pkg.dependencies).toBeUndefined()
    const entry = join(relocated, pkg.exports["."])
    expect(createHash("sha256").update(readFileSync(entry)).digest("hex")).toBe(receipt.bundle_sha256)
    const check = `const {default:p}=await import(process.argv[1]); if(!p.id||typeof p.setup!=="function")process.exit(1)`
    const probe = Bun.spawnSync([process.execPath, "--no-install", "-e", check, pathToFileURL(entry).href], {
      cwd: relocated,
      env: { ...process.env, NODE_PATH: "", BUN_INSTALL_CACHE_DIR: join(scratch, "empty-cache") },
    })
    expect(probe.exitCode, probe.stderr.toString()).toBe(0)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 60_000)

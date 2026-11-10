import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, test } from "bun:test"
import { parseManagerArgs } from "../scripts/manager-cli.ts"
import { runManager, type CommandRunner } from "../scripts/manager-core.ts"
import { resolveNpmInvocation } from "../scripts/npm-invocation.ts"
import { prepareDeploymentBundle } from "../scripts/prepare-deployment.ts"
import { currentLibcIdentity, inventoryDeploymentTree, readAndVerifyDeploymentBundle, sealBundleManifest, sha256 } from "../scripts/deployment.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function execute(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.error?.message}`)
  return result.stdout.trim()
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "alg deployment space "))
  roots.push(root)
  const pkg = { name: "opencode-alg", version: "0.4.1" }
  const lock = { name: pkg.name, version: pkg.version, packages: { "": { name: pkg.name, version: pkg.version } } }
  writeFileSync(join(root, "package.json"), JSON.stringify(pkg))
  writeFileSync(join(root, "package-lock.json"), JSON.stringify(lock))
  mkdirSync(join(root, "scripts"))
  writeFileSync(join(root, "scripts", "alg.sh"), "#!/bin/sh\n")
  const tree = inventoryDeploymentTree(root)
  const manifest = sealBundleManifest({
    format: "opencode-alg-deployment-bundle", schema_version: 1,
    package: { name: "opencode-alg", version: pkg.version, release_tag: null, source_commit: "a".repeat(40), source_repository: "https://example.invalid/org/opencode-alg.git", artifact_sha256: sha256(JSON.stringify(tree)) },
    target: { platform: process.platform as "linux" | "win32" | "darwin", arch: process.arch, runtime: process.versions.bun ? "bun" : "node", node_major: process.versions.bun ? null : Number(process.versions.node.split(".")[0]), bun_major: process.versions.bun ? Number(process.versions.bun.split(".")[0]) : null, libc: currentLibcIdentity() },
    dependencies: { manager: "npm", mode: "production-offline-ready", npm_lock_file: "package-lock.json", npm_lock_sha256: sha256(JSON.stringify(lock)), package_lock_sha256: sha256(JSON.stringify(lock)), bun_lock_sha256: null, production_names: [], production_identity: { sha256: "b".repeat(64), files: 0, bytes: 0 }, tree },
    modes: { application: "OpenCode 1", minimum_host: ">=1.18.0 <2.0.0", maximum_host_exclusive: "2.0.0", install: "offline-no-install", trust: "explicit-manifest-sha256-approval" },
  })
  writeFileSync(join(root, "alg-bundle.json"), JSON.stringify(manifest))
  return { root, manifest }
}

describe("offline deployment bundle", () => {
  test("requires approval of the exact manifest identity and validates the package inventory", () => {
    const { root, manifest } = fixture()
    expect(readAndVerifyDeploymentBundle(root, manifest.manifest_sha256).package.release_tag).toBeNull()
    expect(() => readAndVerifyDeploymentBundle(root, "c".repeat(64))).toThrow(/explicitly approved/)
    writeFileSync(join(root, "scripts", "alg.sh"), "tampered\n")
    expect(() => readAndVerifyDeploymentBundle(root, manifest.manifest_sha256)).toThrow(/inventory/)
  })

  test("rejects a bundle targeted at another platform", () => {
    const { root, manifest } = fixture()
    const { manifest_sha256: _oldHash, ...contents } = manifest
    const other = sealBundleManifest({ ...contents, target: { ...manifest.target, platform: process.platform === "win32" ? "linux" : "win32" } } as never)
    writeFileSync(join(root, "alg-bundle.json"), JSON.stringify(other))
    expect(() => readAndVerifyDeploymentBundle(root, other.manifest_sha256)).toThrow(/does not match this runtime/)
  })

  test("rejects a bundle prepared for the other launcher", () => {
    const { root, manifest } = fixture()
    const { manifest_sha256: _oldHash, ...contents } = manifest
    const target = process.versions.bun
      ? { ...manifest.target, runtime: "node" as const, node_major: 22, bun_major: null }
      : { ...manifest.target, runtime: "bun" as const, node_major: null, bun_major: 1 }
    const other = sealBundleManifest({ ...contents, target })
    writeFileSync(join(root, "alg-bundle.json"), JSON.stringify(other))
    expect(() => readAndVerifyDeploymentBundle(root, other.manifest_sha256)).toThrow(/requires the .* launcher/)
  })

  test("deploy CLI requires offline mode and an explicit approved manifest hash", () => {
    const trustedHash = "d".repeat(64)
    expect(() => parseManagerArgs(["deploy", "--offline", "--trust-bundle", trustedHash, "--config-dir", resolve(tmpdir())])).not.toThrow()
    expect(() => parseManagerArgs(["deploy", "--offline", "--config-dir", resolve(tmpdir())])).toThrow(/trust-bundle/)
    expect(() => parseManagerArgs(["deploy", "--trust-bundle", trustedHash, "--config-dir", resolve(tmpdir())])).toThrow(/requires --offline/)
  })

  test("prepares from a real commit and deploys a complete offline bundle transaction", () => {
    const sandbox = mkdtempSync(join(tmpdir(), "alg-deployment-integration-"))
    roots.push(sandbox)
    const source = join(sandbox, "source")
    const output = join(sandbox, "prepared bundle")
    const config = join(sandbox, "config")
    mkdirSync(source)
    for (const name of ["src", "agents", "templates", "scripts", "vendor"]) mkdirSync(join(source, name))
    mkdirSync(join(source, "capabilities"))
    cpSync(join(ROOT, "capabilities", "excel"), join(source, "capabilities", "excel"), { recursive: true })
    for (const name of ["index.ts", "server.ts", "tui.ts"]) writeFileSync(join(source, "src", name), `export const fixture = ${JSON.stringify(name)}\n`)
    for (const name of ["checker", "explorer", "implementer", "orchestrator", "researcher"]) writeFileSync(join(source, "agents", `${name}.md`), `# ${name}\n`)
    writeFileSync(join(source, "templates", "fixture.json"), "{}\n")
    writeFileSync(join(source, "scripts", "fixture.txt"), "bundle script\n")
    const dependencies: Record<string, string> = {}
    const npm = resolveNpmInvocation()
    for (const [name, folder] of [["@modelcontextprotocol/sdk", "sdk"], ["@opencode-ai/plugin", "plugin"], ["jsonc-parser", "jsonc"], ["zod", "zod"]]) {
      const path = join(source, "vendor", folder!)
      mkdirSync(path)
      writeFileSync(join(path, "package.json"), `${JSON.stringify({ name, version: "1.0.0", type: "module", exports: { ".": { import: "./index.js" } } })}\n`)
      writeFileSync(join(path, "index.js"), `export const name = ${JSON.stringify(name)}\n`)
      const tarball = execute(npm.executable, [...npm.argsPrefix, "pack", path, "--pack-destination", join(source, "vendor"), "--offline", "--ignore-scripts", "--json"], source)
      const packed = JSON.parse(tarball) as Array<{ filename: string }>
      dependencies[name!] = `file:vendor/${packed[0]!.filename}`
    }
    const pkg = {
      name: "opencode-alg", version: "0.4.1", type: "module", dependencies,
      files: ["src", "agents", "templates", "scripts", "capabilities/excel", "vendor", "package-lock.json"],
      exports: { ".": "./src/index.ts", "./server": "./src/server.ts", "./tui": "./src/tui.ts" },
      opencode: { server: "./src/server.ts", tui: "./src/tui.ts" },
      opencodeAlg: { durableState: { format: "alg-run-state", currentSchema: 2, compatibleSchemas: [1, 2], compatiblePackageVersions: ["0.4.1"] } },
    }
    writeFileSync(join(source, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)
    writeFileSync(join(source, ".gitignore"), "node_modules/\n")
    writeFileSync(join(source, ".gitattributes"), "* -text\nscripts/fixture.txt text eol=crlf\n")
    execute(npm.executable, [...npm.argsPrefix, "install", "--package-lock-only", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], source)
    execute("git", ["init", "-b", "main"], source)
    execute("git", ["remote", "add", "origin", "https://example.invalid/org/opencode-alg.git"], source)
    execute("git", ["add", "."], source)
    execute("git", ["-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", "old stable fixture"], source)
    execute("git", ["tag", "v0.4.1"], source)
    const old = runManager({ command: "install", configDir: config, source, tag: "v0.4.1" })
    expect(old.ok).toBe(true)
    pkg.version = "0.5.0"
    pkg.opencodeAlg.durableState.compatiblePackageVersions = ["0.4.1", "0.5.0"]
    writeFileSync(join(source, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)
    execute(npm.executable, [...npm.argsPrefix, "install", "--package-lock-only", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"], source)
    execute("git", ["add", "package.json", "package-lock.json"], source)
    execute("git", ["-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", "new candidate fixture"], source)
    const commit = execute("git", ["rev-parse", "HEAD"], source)
    writeFileSync(join(source, "scripts", "fixture.txt"), "bundle script\r\n")
    const liveScript = readFileSync(join(source, "scripts", "fixture.txt"))
    const blobResult = spawnSync("git", ["-C", source, "cat-file", "blob", `${commit}:scripts/fixture.txt`], { encoding: "buffer", shell: false, windowsHide: true, maxBuffer: 1024 * 1024 })
    if (blobResult.error || blobResult.status !== 0 || !Buffer.isBuffer(blobResult.stdout)) throw new Error("Git fixture blob read failed")
    const committedScript = blobResult.stdout
    expect(liveScript).not.toEqual(committedScript)
    execute("git", ["add", "--renormalize", "scripts/fixture.txt"], source)
    expect(execute("git", ["diff", "--cached", "--exit-code"], source)).toBe("")
    expect(execute("git", ["status", "--porcelain=v1", "--untracked-files=all"], source)).toBe("")
    expect(() => prepareDeploymentBundle(source, join(source, "nested bundle"))).toThrow(/outside and separate/)
    expect(() => prepareDeploymentBundle(join(source, "src"), output)).toThrow(/root of its own Git checkout/)
    expect(() => prepareDeploymentBundle("relative-source", output)).toThrow(/must be absolute/)
    const prepared = prepareDeploymentBundle(source, output)
    expect(prepared.sourceCommit).toBe(commit)
    expect(readFileSync(join(output, "scripts", "fixture.txt")).equals(committedScript)).toBe(true)
    expect(existsSync(join(output, ".git"))).toBe(false)
    expect(existsSync(join(output, "node_modules", "@modelcontextprotocol", "sdk", "package.json"))).toBe(true)
    const runner: CommandRunner = { run(request) {
      if (request.command === "opencode" && JSON.stringify(request.args) === JSON.stringify(["--version"])) {
        return { exitCode: 0, stdout: "1.18.3\n", stderr: "" }
      }
      throw new Error(`Offline deploy invoked unexpected command: ${request.command}`)
    } }
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const stableReceipt = readFileSync(receiptPath)
    expect(() => runManager({ command: "deploy", configDir: config, bundleRoot: output, trustBundleHash: "0".repeat(64) }, { runner })).toThrow(/explicitly approved/)
    expect(readFileSync(receiptPath)).toEqual(stableReceipt)
    const installed = runManager({ command: "deploy", configDir: config, bundleRoot: output, trustBundleHash: prepared.manifestSha256 }, { runner })
    expect(installed.ok).toBe(true)
    expect(installed.release_identity).toMatchObject({ source_commit: commit, manifest_sha256: prepared.manifestSha256, artifact_sha256: prepared.artifactSha256 })
    expect(runManager({ command: "deploy", configDir: config, bundleRoot: output, trustBundleHash: prepared.manifestSha256 }, { runner }).changed).toBe(false)
    const candidateReceipt = readFileSync(receiptPath)
    const receipt = JSON.parse(candidateReceipt.toString("utf8"))
    const candidate = receipt.generations.find((generation: { source_kind?: string }) => generation.source_kind === "bundle")
    expect(candidate?.version).toBe("0.5.0")
    expect(receipt.active_generation).toBe(candidate?.id)
    expect(receipt.channel).toBe("candidate")
    expect(existsSync(join(candidate.package_root, ".git"))).toBe(false)
    expect(readAndVerifyDeploymentBundle(candidate.package_root, prepared.manifestSha256).package.source_commit).toBe(commit)
    const serverBeforeRollback = readFileSync(join(config, "opencode.jsonc"))
    expect(() => runManager({ command: "rollback", configDir: config }, { runner })).toThrow(/durable-state compatibility/)
    expect(readFileSync(receiptPath)).toEqual(candidateReceipt)
    expect(readFileSync(join(config, "opencode.jsonc"))).toEqual(serverBeforeRollback)
    writeFileSync(join(candidate.package_root, "scripts", "fixture.txt"), "tampered after deployment\n")
    expect(runManager({ command: "doctor", configDir: config }, { runner }).issues?.map((issue) => issue.code)).toContain("active-release-invalid")
  }, 120_000)
})

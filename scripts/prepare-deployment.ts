import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { computeProductionDependencyIdentity, verifyBundleProductionDependencies } from "./manager-core.ts"
import { currentLibcIdentity, inventoryDeploymentTree, sealBundleManifest, sha256 } from "./deployment.ts"
import { resolveNpmInvocation } from "./npm-invocation.ts"
import { canonicalRootPath } from "../src/paths.ts"

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", shell: false, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${(result.stderr || result.error?.message || "unknown error").trim()}`)
  return (result.stdout ?? "").trim()
}

export function prepareDeploymentBundle(sourceInput: string, outputInput: string): { output: string; manifestSha256: string; sourceCommit: string; artifactSha256: string } {
  if (!process.versions.bun && Number(process.versions.node.split(".")[0]) < 22) throw new Error("Bundle preparation requires Node.js 22 or newer")
  if (!isAbsolute(sourceInput) || !isAbsolute(outputInput)) throw new Error("Bundle source and output paths must be absolute")
  const source = realpathSync.native(resolve(sourceInput))
  const output = canonicalRootPath(resolve(outputInput))
  const insideSource = relative(source, output)
  const insideOutput = relative(output, source)
  const nested = (value: string) => value === "" || (!isAbsolute(value) && value !== ".." && !value.startsWith(`..${sep}`))
  if (!isAbsolute(output) || output === source || nested(insideSource) || nested(insideOutput)) {
    throw new Error("Bundle output must be an absolute directory outside and separate from the source checkout")
  }
  const status = run("git", ["-C", source, "status", "--porcelain=v1", "--untracked-files=all"], source)
  if (status) throw new Error("Preparation requires a clean source checkout")
  if (realpathSync.native(run("git", ["-C", source, "rev-parse", "--show-toplevel"], source)) !== source) {
    throw new Error("Preparation source must be the root of its own Git checkout")
  }
  const commit = run("git", ["-C", source, "rev-parse", "HEAD"], source).toLowerCase()
  if (!/^[a-f0-9]{40,64}$/.test(commit)) throw new Error("Source checkout did not provide a valid immutable commit identity")
  const repository = run("git", ["-C", source, "config", "--get", "remote.origin.url"], source)
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
  if (pkg.name !== "opencode-alg" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Source package identity is invalid")
  if (existsSync(output)) throw new Error(`Bundle output already exists; refusing to overwrite: ${output}`)
  mkdirSync(output, { recursive: true })
  const stage = join(output, ".package-stage")
  mkdirSync(stage)
  try {
    const copyTop = new Set<string>(["package.json", "package-lock.json", "npm-shrinkwrap.json"])
    for (const item of pkg.files ?? []) {
      if (typeof item !== "string") throw new Error("Package files declaration contains a non-string entry")
      const top = item.replace(/^(\.\/)+/, "").split(/[/*]/, 1)[0]
      if (!top || top === "." || top === ".." || /[\\\0]/.test(top)) throw new Error("Package files declaration contains an unsafe path")
      if (top && top !== ".git" && top !== "node_modules") copyTop.add(top)
    }
    const tracked = run("git", ["-C", source, "ls-files", "-z"], source).split("\0").filter(Boolean)
    for (const path of tracked) {
      const top = path.split("/")[0]!
      if (!copyTop.has(top) || top === ".git" || top === "node_modules") continue
      const from = join(source, ...path.split("/"))
      const to = join(stage, ...path.split("/"))
      mkdirSync(join(to, ".."), { recursive: true })
      cpSync(from, to, { preserveTimestamps: true, verbatimSymlinks: true })
    }
    for (const name of ["package.json", "package-lock.json", "npm-shrinkwrap.json"]) {
      if (existsSync(join(source, name)) && !existsSync(join(stage, name))) throw new Error(`Required bundle lock/package file is not tracked: ${name}`)
    }
    const frozenFiles = ["package.json", "package-lock.json", "npm-shrinkwrap.json", "bun.lock"]
      .filter((name) => existsSync(join(stage, name)))
      .map((name) => [name, sha256(readFileSync(join(stage, name)))] as const)
    const npm = resolveNpmInvocation()
    run(npm.executable, [...npm.argsPrefix, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stage)
    for (const [name, expected] of frozenFiles) {
      if (sha256(readFileSync(join(stage, name))) !== expected) throw new Error(`Preparation dependency install modified frozen input ${name}`)
    }
    // Publish the package at the output root; the directory name is descriptive only.
    for (const name of readdirSync(stage)) cpSync(join(stage, name), join(output, name), { recursive: true, preserveTimestamps: true, verbatimSymlinks: true })
    rmSync(stage, { recursive: true, force: true })
    const identity = computeProductionDependencyIdentity(output, Object.keys(pkg.dependencies ?? {}).sort())
    verifyBundleProductionDependencies(output, Object.keys(pkg.dependencies ?? {}).sort())
    const tree = inventoryDeploymentTree(output)
    const artifactSha256 = sha256(JSON.stringify(tree))
    const npmLockFile = existsSync(join(output, "npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : "package-lock.json"
    const manifest = sealBundleManifest({
      format: "opencode-alg-deployment-bundle", schema_version: 1,
      package: { name: "opencode-alg", version: pkg.version, release_tag: null, source_commit: commit, source_repository: repository, artifact_sha256: artifactSha256 },
      target: { platform: process.platform as "linux" | "win32" | "darwin", arch: process.arch, runtime: process.versions.bun ? "bun" : "node", node_major: process.versions.bun ? null : Number(process.versions.node.split(".")[0]), bun_major: process.versions.bun ? Number(process.versions.bun.split(".")[0]) : null, libc: currentLibcIdentity() },
      dependencies: {
        manager: "npm", mode: "production-offline-ready", npm_lock_file: npmLockFile,
        npm_lock_sha256: sha256(readFileSync(join(output, npmLockFile))),
        package_lock_sha256: sha256(readFileSync(join(output, "package-lock.json"))),
        bun_lock_sha256: existsSync(join(output, "bun.lock")) ? sha256(readFileSync(join(output, "bun.lock"))) : null,
        production_names: Object.keys(pkg.dependencies ?? {}).sort(), production_identity: identity, tree,
      },
      modes: { application: "OpenCode 1", minimum_host: pkg.engines?.opencode ?? ">=1.18.0 <2.0.0", maximum_host_exclusive: "2.0.0", install: "offline-no-install", trust: "explicit-manifest-sha256-approval" },
    })
    writeFileSync(join(output, "alg-bundle.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx", mode: 0o644 })
    return { output, manifestSha256: manifest.manifest_sha256, sourceCommit: commit, artifactSha256 }
  } catch (error) {
    // Leave failed evidence in place for inspection; never silently reuse an incomplete package.
    throw error
  }
}

const thisFile = fileURLToPath(import.meta.url)
if (process.argv[1] && resolve(process.argv[1]) === resolve(thisFile)) {
  try {
    const args = process.argv.slice(2)
    const sourceIndex = args.indexOf("--source")
    const outputIndex = args.indexOf("--output")
    if (sourceIndex < 0 || outputIndex < 0 || !args[sourceIndex + 1] || !args[outputIndex + 1]) {
      throw new Error("Usage: bun run scripts/prepare-deployment.ts --source <clean-checkout> --output <new-absolute-directory>")
    }
    const result = prepareDeploymentBundle(args[sourceIndex + 1]!, args[outputIndex + 1]!)
    console.log(JSON.stringify({ ...result, release_tag: null, trust_note: "Review and retain manifestSha256 outside the bundle; checksum alone is not authentication." }, null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

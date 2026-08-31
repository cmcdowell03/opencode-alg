import { afterEach, describe, expect, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import {
  cpSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { parse } from "jsonc-parser"
import {
  MANAGER_JSON_MAX_BYTES,
  SimulatedManagerCrashError,
  computeProductionDependencyIdentity,
  managerErrorMessage,
  runManager,
  serializeManagerJson,
  type CommandRequest,
  type CommandResult,
  type CommandRunner,
} from "../scripts/manager-core.ts"
import { ManagerReceiptSchema } from "../scripts/manager-schema.ts"
import { decodeConfigBytes, encodeConfigText } from "../src/config-editor.ts"
import { removeProject, tempProject } from "./helpers.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sandboxes: string[] = []

function isNpmRequest(request: CommandRequest): boolean {
  return /^npm(?:\.cmd)?$/i.test(request.command) ||
    (request.args.some((arg) => /[\\/]node_modules[\\/]npm[\\/]bin[\\/]npm-cli\.js$/i.test(arg)) && request.args.includes("ci"))
}

class LocalGitRunner implements CommandRunner {
  failDependencies = false
  dependencyError = "injected dependency failure"
  failUv = false
  failUvSync = false
  failExcelCheck = false
  readonly requests: CommandRequest[] = []
  onRequest?: (request: CommandRequest) => void

  run(request: CommandRequest): CommandResult {
    this.requests.push({ ...request, args: [...request.args] })
    this.onRequest?.(request)
    if (request.command === "uv") {
      if (this.failUv) return { exitCode: 19, stdout: "", stderr: "injected uv failure" }
      if (request.args[0] === "--version") return { exitCode: 0, stdout: "uv 0.9.13\n", stderr: "" }
      if (JSON.stringify(request.args) === JSON.stringify(["sync", "--frozen", "--no-dev"])) {
        if (this.failUvSync) return { exitCode: 20, stdout: "", stderr: "injected uv sync failure" }
        const environment = request.env?.UV_PROJECT_ENVIRONMENT
        if (!environment) throw new Error("fake uv requires UV_PROJECT_ENVIRONMENT")
        const executable = process.platform === "win32"
          ? join(environment, "Scripts", "python.exe")
          : join(environment, "bin", "python")
        mkdirSync(dirname(executable), { recursive: true })
        writeFileSync(executable, "fake interpreter\n")
        return { exitCode: 0, stdout: "", stderr: "" }
      }
    }
    if (request.args.length === 2 && request.args[1] === "--check" && request.args[0]?.endsWith("wrapper.py")) {
      if (this.failExcelCheck) return { exitCode: 23, stdout: "", stderr: "injected wrapper check failure" }
      const tools = [
        "apply_formula", "copy_range", "copy_worksheet", "create_chart", "create_pivot_table", "create_table",
        "create_workbook", "create_worksheet", "delete_range", "delete_sheet_columns", "delete_sheet_rows",
        "delete_worksheet", "format_range", "get_data_validation_info", "get_merged_cells", "get_workbook_metadata",
        "insert_columns", "insert_rows", "merge_cells", "read_data_from_excel", "rename_worksheet",
        "unmerge_cells", "validate_excel_range", "validate_formula_syntax", "write_data_to_excel",
      ]
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          distribution: "excel-mcp-server", ok: true,
          path_policy: { ok: true, path_argument_confinement: true },
          remote_transports: false, tool_count: 25, tools, version: "0.1.8",
        }),
        stderr: "",
      }
    }
    if (isNpmRequest(request)) {
      if (this.failDependencies) return { exitCode: 17, stdout: "", stderr: this.dependencyError }
      if (!request.cwd) throw new Error("npm fixture requires cwd")
      for (const dependency of ["@opencode-ai/plugin", "jsonc-parser", "zod"]) {
        const directory = join(request.cwd, "node_modules", ...dependency.split("/"))
        mkdirSync(directory, { recursive: true })
        writeFileSync(join(directory, "package.json"), `${JSON.stringify({ name: dependency, version: "1.0.0" })}\n`)
        writeFileSync(join(directory, "index.js"), `export const dependency = ${JSON.stringify(dependency)}\n`)
      }
      return { exitCode: 0, stdout: "", stderr: "" }
    }
    const child = spawnSync(request.command, [...request.args], {
      cwd: request.cwd,
      env: request.env ? { ...process.env, ...request.env } : process.env,
      shell: false,
      encoding: "utf8",
      windowsHide: true,
    })
    if (child.error) throw child.error
    return { exitCode: child.status ?? 1, stdout: child.stdout ?? "", stderr: child.stderr ?? "" }
  }
}

function git(root: string, ...args: string[]): string {
  const child = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", shell: false, windowsHide: true })
  if (child.status !== 0) throw new Error(child.stderr)
  return child.stdout.trim()
}

function setVersion(root: string, version: string): void {
  for (const name of ["package.json", "package-lock.json"]) {
    const path = join(root, name)
    const value = JSON.parse(readFileSync(path, "utf8")) as any
    value.version = version
    if (name === "package-lock.json") value.packages[""].version = version
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  }
}

function sourceFixture(includeCapabilities = true): string {
  const sandbox = tempProject("alg-manager-source with spaces-")
  sandboxes.push(sandbox)
  const source = join(sandbox, "source checkout")
  mkdirSync(source)
  for (const name of ["src", "agents", "templates", "scripts", ...(includeCapabilities ? ["capabilities"] : [])]) {
    cpSync(join(ROOT, name), join(source, name), { recursive: true })
  }
  for (const name of ["package.json", "package-lock.json", ".gitignore", ".gitattributes", "README.md", "DESIGN.md"]) cpSync(join(ROOT, name), join(source, name))
  setVersion(source, "0.1.0")
  git(source, "init", "-b", "main")
  git(source, "add", ".")
  git(source, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", "v0.1 fixture")
  git(source, "tag", "v0.1.0")
  return source
}

function bareRemoteFixture(): { source: string; remote: string } {
  const source = sourceFixture()
  const remote = join(dirname(source), "bare remote.git")
  const initialized = spawnSync("git", ["init", "--bare", "--initial-branch=main", remote], {
    encoding: "utf8",
    shell: false,
    windowsHide: true,
  })
  if (initialized.status !== 0) throw new Error(initialized.stderr)
  git(source, "remote", "add", "origin", remote)
  git(source, "push", "origin", "main", "--tags")
  return { source, remote }
}

function advanceToV02(source: string): void {
  setVersion(source, "0.2.0")
  const explorer = join(source, "agents", "explorer.md")
  writeFileSync(explorer, `${readFileSync(explorer, "utf8")}\n<!-- v0.2 fixture -->\n`)
  git(source, "add", "package.json", "package-lock.json", "agents/explorer.md")
  git(source, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", "v0.2 fixture")
  git(source, "tag", "v0.2.0")
}

function pushV02(source: string): void {
  advanceToV02(source)
  git(source, "push", "origin", "main", "--tags")
}

function advanceWithLockMismatch(source: string): void {
  const packagePath = join(source, "package.json")
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"))
  pkg.version = "0.2.0"
  writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`)
  git(source, "add", "package.json")
  git(source, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", "mismatched v0.2 fixture")
  git(source, "tag", "v0.2.0")
  git(source, "push", "origin", "main", "--tags")
}

function advanceWithPackageMismatch(source: string): void {
  writeFileSync(join(source, "agents", "explorer.md"), `${readFileSync(join(source, "agents", "explorer.md"), "utf8")}\n<!-- mistagged package -->\n`)
  git(source, "add", "agents/explorer.md")
  git(source, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", "mistagged v0.2 fixture")
  git(source, "tag", "v0.2.0")
  git(source, "push", "origin", "main", "--tags")
}

function advanceNonFastForward(source: string): void {
  git(source, "checkout", "--orphan", "divergent-v02")
  git(source, "reset")
  setVersion(source, "0.2.0")
  writeFileSync(join(source, "agents", "explorer.md"), `${readFileSync(join(source, "agents", "explorer.md"), "utf8")}\n<!-- divergent -->\n`)
  git(source, "add", ".")
  git(source, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", "divergent v0.2 fixture")
  git(source, "tag", "v0.2.0")
  git(source, "push", "origin", "HEAD:main", "--force", "--tags")
}

function receipt(config: string) {
  return ManagerReceiptSchema.parse(JSON.parse(readFileSync(join(config, ".opencode-alg", "receipt.json"), "utf8")))
}

function activeReceiptSpec(config: string): string {
  const state = receipt(config)
  return state.generations.find((item) => item.id === state.active_generation)!.spec
}

function expectedExcelConfig(config: string, excelRoot: string) {
  const state = receipt(config)
  const active = state.generations.find((item) => item.id === state.active_generation)!
  const capability = active.capabilities!.excel
  const directory = join(active.package_root, "capabilities", "excel")
  const env = join(state.install_root, "capability-envs", "excel", capability.lock_hash)
  return {
    type: "local",
    command: [process.platform === "win32" ? join(env, "Scripts", "python.exe") : join(env, "bin", "python"), join(directory, "wrapper.py")],
    cwd: directory,
    environment: { ALG_EXCEL_ROOT: resolve(excelRoot), PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONUTF8: "1" },
    enabled: true,
    timeout: 30_000,
  }
}

afterEach(() => {
  for (const path of sandboxes.splice(0)) removeProject(path)
})

describe("bounded production dependency identity", () => {
  test("detects changed dependency code/version plus added and removed files", () => {
    const root = tempProject("alg-dependency-identity-")
    sandboxes.push(root)
    const pkg = join(root, "node_modules", "dep")
    mkdirSync(pkg, { recursive: true })
    const packagePath = join(pkg, "package.json")
    const codePath = join(pkg, "index.js")
    writeFileSync(packagePath, '{"name":"dep","version":"1.0.0"}\n')
    writeFileSync(codePath, "export const value = 1\n")
    const original = computeProductionDependencyIdentity(root, ["dep"])
    expect(original.files).toBe(2)
    expect(original.bytes).toBeGreaterThan(0)

    writeFileSync(codePath, "export const value = 2\n")
    expect(computeProductionDependencyIdentity(root, ["dep"]).sha256).not.toBe(original.sha256)
    writeFileSync(codePath, "export const value = 1\n")
    writeFileSync(packagePath, '{"name":"dep","version":"2.0.0"}\n')
    expect(computeProductionDependencyIdentity(root, ["dep"]).sha256).not.toBe(original.sha256)
    writeFileSync(packagePath, '{"name":"dep","version":"1.0.0"}\n')
    writeFileSync(join(pkg, "added.js"), "added\n")
    expect(computeProductionDependencyIdentity(root, ["dep"]).sha256).not.toBe(original.sha256)
    rmSync(join(pkg, "added.js"))
    rmSync(codePath)
    expect(computeProductionDependencyIdentity(root, ["dep"]).sha256).not.toBe(original.sha256)
  })

  test("supports an empty production tree and enforces file/tree bounds", () => {
    const empty = tempProject("alg-dependency-empty-")
    const root = tempProject("alg-dependency-bounds-")
    sandboxes.push(empty, root)
    expect(computeProductionDependencyIdentity(empty, [])).toMatchObject({ files: 0, bytes: 0 })
    expect(() => computeProductionDependencyIdentity(empty, ["missing"])).toThrow("dependencies are missing")
    const pkg = join(root, "node_modules", "dep")
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, "one.js"), "12345678")
    writeFileSync(join(pkg, "two.js"), "abcdefgh")
    expect(() => computeProductionDependencyIdentity(root, ["dep"], { maxFileBytes: 4 })).toThrow("file exceeds")
    expect(() => computeProductionDependencyIdentity(root, ["dep"], { maxTotalBytes: 8 })).toThrow("tree exceeds")
    expect(() => computeProductionDependencyIdentity(root, ["dep"], { maxFiles: 1 })).toThrow("exceeds 1 files")
    expect(() => computeProductionDependencyIdentity(root, ["dep"], { maxEntries: 1 })).toThrow("exceeds 1 entries")
  })

  test("rejects a dependency junction/symlink that escapes node_modules", () => {
    const root = tempProject("alg-dependency-link-escape-")
    const outside = tempProject("alg-dependency-link-outside-")
    sandboxes.push(root, outside)
    mkdirSync(join(root, "node_modules"))
    writeFileSync(join(outside, "index.js"), "outside\n")
    symlinkSync(outside, join(root, "node_modules", "dep"), process.platform === "win32" ? "junction" : "dir")
    expect(() => computeProductionDependencyIdentity(root, ["dep"])).toThrow("escapes node_modules")
  })
})

describe("v0.2 side-by-side release manager", () => {
  test("deliberately accepts an old v0.1 generation and receipt with no capability fields", () => {
    const source = sourceFixture(false)
    const config = tempProject("alg-manager-old-no-capability-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const state = receipt(config)
    expect(state.generations[0]?.capabilities).toBeUndefined()
    expect(state.generations[0]?.durable_state.compatible_package_versions).toEqual(["0.1.0", "0.2.0", "0.3.0"])
    expect(runManager({ command: "doctor", configDir: config }, { runner }).capability_status).toMatchObject({
      status: "disabled", enabled: false, manifest: "not-recorded", runtime_check: "not-run",
    })
    expect(runner.requests.some((request) => request.command === "uv" || request.args[1] === "--check")).toBe(false)
  }, 20_000)

  test("custom and skip agent ownership cannot be laundered by exact target bytes; force explicitly adopts", () => {
    const source = sourceFixture()
    const config = tempProject("alg-agent-ownership-laundering-")
    sandboxes.push(config)
    mkdirSync(join(config, "agents"))
    const target = join(config, "agents", "explorer.md")
    cpSync(join(source, "agents", "explorer.md"), target)
    const v1Bytes = readFileSync(target)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source, agentPolicy: "skip" }, { runner })
    expect(receipt(config).agents["explorer.md"]?.disposition).toBe("custom")
    expect(receipt(config).agents["explorer.md"]?.managed_hash).toBeNull()

    advanceToV02(source)
    runManager({ command: "update", configDir: config, source, agentPolicy: "managed" }, { runner })
    expect(readFileSync(target)).toEqual(v1Bytes)
    expect(receipt(config).agents["explorer.md"]?.disposition).toBe("custom")

    // Coincidental equality with the active target still does not transfer ownership.
    const v2Bytes = readFileSync(join(source, "agents", "explorer.md"))
    writeFileSync(target, v2Bytes)
    runManager({ command: "update", configDir: config, source, agentPolicy: "managed" }, { runner })
    expect(receipt(config).agents["explorer.md"]?.disposition).toBe("custom")

    setVersion(source, "0.3.0")
    writeFileSync(join(source, "agents", "explorer.md"), `${v2Bytes.toString("utf8")}\n<!-- v0.3 target -->\n`)
    git(source, "add", "package.json", "package-lock.json", "agents/explorer.md")
    git(source, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", "v0.3 fixture")
    git(source, "tag", "v0.3.0")
    runManager({ command: "update", configDir: config, source, agentPolicy: "managed" }, { runner })
    expect(readFileSync(target)).toEqual(v2Bytes)
    expect(receipt(config).agents["explorer.md"]?.disposition).toBe("custom")

    const forced = runManager({ command: "update", configDir: config, source, agentPolicy: "force" }, { runner })
    expect(readFileSync(target, "utf8")).toContain("v0.3 target")
    expect(receipt(config).agents["explorer.md"]?.disposition).toBe("managed")
    expect(forced.agents?.find((agent) => agent.path === target)?.backup).toBeDefined()

    const skipped = runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, { runner })
    expect(skipped.agents?.find((agent) => agent.path === target)?.action).toBe("ownership-released")
    expect(receipt(config).agents["explorer.md"]?.disposition).toBe("custom")
    expect(receipt(config).agents["explorer.md"]?.managed_hash).toBeNull()
  }, 60_000)

  test("Excel is neutral by default, opt-in install/update preserves root, repeated enable is receipt-idempotent, and disable is explicit", () => {
    const source = sourceFixture()
    const config = tempProject("alg-excel-lifecycle-config-")
    const excelRoot = tempProject("alg-excel-lifecycle-root-")
    sandboxes.push(config, excelRoot)
    const runner = new LocalGitRunner()

    runManager({ command: "install", configDir: config, source }, { runner })
    expect((parse(readFileSync(join(config, "opencode.jsonc"), "utf8")) as any).mcp?.alg_excel).toBeUndefined()
    expect(runner.requests.some((request) => request.command === "uv" || request.args[1] === "--check")).toBe(false)
    runManager({ command: "uninstall", configDir: config }, { runner })

    const enabled = runManager({
      command: "install", configDir: config, source,
      enableCapability: "excel", excelRoot,
    }, { runner })
    expect(enabled.ok).toBe(true)
    let state = receipt(config)
    let active = state.generations.find((generation) => generation.id === state.active_generation)!
    expect(active.capabilities?.excel.enabled).toBe(true)
    expect(active.capabilities?.excel.root).toBe(resolve(excelRoot))
    const managed = active.capabilities!.excel.managed_config!
    const firstEnvironment = active.capabilities!.excel.env_path!
    const firstEnvironmentBytes = readFileSync(managed.command[0])
    expect((parse(readFileSync(join(config, "opencode.jsonc"), "utf8")) as any).mcp.alg_excel).toEqual(managed)
    expect(managed.type).toBe("local")
    expect(managed.command).toHaveLength(2)
    expect(managed.command[1]).toContain(join("capabilities", "excel", "wrapper.py"))
    expect(managed.environment).toEqual({ ALG_EXCEL_ROOT: resolve(excelRoot), PYTHONDONTWRITEBYTECODE: "1", PYTHONNOUSERSITE: "1", PYTHONUTF8: "1" })
    const sync = runner.requests.find((request) => request.command === "uv" && request.args[0] === "sync")!
    expect(sync.args).toEqual(["sync", "--frozen", "--no-dev"])
    expect(sync.env?.UV_PROJECT_ENVIRONMENT).toBe(active.capabilities!.excel.env_path!)

    const receiptBefore = readFileSync(join(config, ".opencode-alg", "receipt.json"))
    const uvBeforeRepeated = runner.requests.filter((request) => request.command === "uv" && request.args[0] === "sync").length
    const repeated = runManager({
      command: "install", configDir: config, source,
      enableCapability: "excel", excelRoot,
    }, { runner })
    expect(repeated.changed).toBe(false)
    expect(readFileSync(join(config, ".opencode-alg", "receipt.json"))).toEqual(receiptBefore)
    expect(runner.requests.filter((request) => request.command === "uv" && request.args[0] === "sync")).toHaveLength(uvBeforeRepeated)

    advanceToV02(source)
    runManager({ command: "update", configDir: config, source }, { runner })
    state = receipt(config)
    active = state.generations.find((generation) => generation.id === state.active_generation)!
    expect(active.version).toBe("0.2.0")
    expect(active.capabilities?.excel.enabled).toBe(true)
    expect(active.capabilities?.excel.root).toBe(resolve(excelRoot))
    expect(active.capabilities?.excel.env_path).not.toBe(firstEnvironment)
    expect(active.capabilities?.excel.env_path).toContain(active.id)
    expect(readFileSync(managed.command[0])).toEqual(firstEnvironmentBytes)
    expect(active.capabilities?.excel.env_hash).toMatch(/^[0-9a-f]{64}$/)

    const uvBeforeDisable = runner.requests.filter((request) => request.command === "uv").length
    runManager({ command: "update", configDir: config, source, disableCapability: "excel" }, { runner })
    expect((parse(readFileSync(join(config, "opencode.jsonc"), "utf8")) as any).mcp?.alg_excel).toBeUndefined()
    expect(receipt(config).generations.find((generation) => generation.id === receipt(config).active_generation)?.capabilities?.excel.enabled).toBe(false)
    expect(runner.requests.filter((request) => request.command === "uv")).toHaveLength(uvBeforeDisable)
  }, 45_000)

  test("rollback restores only the target generation Excel state and uninstall removes only exact managed config", () => {
    const source = sourceFixture()
    const config = tempProject("alg-excel-rollback-config-")
    const excelRoot = tempProject("alg-excel-rollback-root-")
    sandboxes.push(config, excelRoot)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const disabledGeneration = receipt(config).active_generation!
    advanceToV02(source)
    runManager({ command: "update", configDir: config, source, enableCapability: "excel", excelRoot }, { runner })
    const enabledGeneration = receipt(config).active_generation!
    expect(enabledGeneration).not.toBe(disabledGeneration)

    const checksBeforeDisabledRollback = runner.requests.filter((request) => request.args[1] === "--check").length
    runManager({ command: "rollback", configDir: config, generation: disabledGeneration }, { runner })
    expect(receipt(config).active_generation).toBe(disabledGeneration)
    expect((parse(readFileSync(join(config, "opencode.jsonc"), "utf8")) as any).mcp?.alg_excel).toBeUndefined()
    expect(runner.requests.filter((request) => request.args[1] === "--check")).toHaveLength(checksBeforeDisabledRollback)

    runManager({ command: "rollback", configDir: config, generation: enabledGeneration }, { runner })
    expect((parse(readFileSync(join(config, "opencode.jsonc"), "utf8")) as any).mcp.alg_excel.enabled).toBe(true)
    runManager({ command: "uninstall", configDir: config }, { runner })
    expect((parse(readFileSync(join(config, "opencode.jsonc"), "utf8")) as any).mcp?.alg_excel).toBeUndefined()
    expect(receipt(config).installed).toBe(false)

    // A customized key is never removed under stale ownership.
    runManager({ command: "install", configDir: config, source, enableCapability: "excel", excelRoot }, { runner })
    const configPath = join(config, "opencode.jsonc")
    const value = parse(readFileSync(configPath, "utf8")) as any
    value.mcp.alg_excel.timeout = 1234
    writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`)
    const result = runManager({ command: "uninstall", configDir: config }, { runner })
    expect((parse(readFileSync(configPath, "utf8")) as any).mcp.alg_excel.timeout).toBe(1234)
    expect(result.issues).toContainEqual({ code: "excel-config-custom", message: "Custom or drifted mcp.alg_excel was preserved during uninstall." })
  }, 45_000)

  test("Excel uv discovery, frozen sync, and wrapper-check failures produce no live config or receipt writes", () => {
    const source = sourceFixture()
    const excelRoot = tempProject("alg-excel-failure-root-")
    sandboxes.push(excelRoot)
    for (const failure of ["uv", "sync", "check"] as const) {
      const config = tempProject(`alg-excel-${failure}-config-`)
      sandboxes.push(config)
      const configPath = join(config, "opencode.jsonc")
      const before = Buffer.from('{ // unchanged\n "plugin": ["keep"],\n}\n')
      writeFileSync(configPath, before)
      const runner = new LocalGitRunner()
      if (failure === "uv") runner.failUv = true
      if (failure === "sync") runner.failUvSync = true
      if (failure === "check") runner.failExcelCheck = true
      expect(() => runManager({
        command: "install", configDir: config, source,
        enableCapability: "excel", excelRoot,
      }, { runner })).toThrow()
      expect(readFileSync(configPath)).toEqual(before)
      expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
    }
  }, 45_000)

  test("strict Excel manifest hashes and sorted tool inventory fail before activation", () => {
    for (const mutation of ["wrapper-hash", "tools"] as const) {
      const source = sourceFixture()
      setVersion(source, "0.2.0")
      if (mutation === "wrapper-hash") {
        const wrapper = join(source, "capabilities", "excel", "wrapper.py")
        writeFileSync(wrapper, `${readFileSync(wrapper, "utf8")}\n# tampered\n`)
      } else {
        const manifestPath = join(source, "capabilities", "excel", "manifest.json")
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
        manifest.tools.reverse()
        writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      }
      git(source, "add", "package.json", "package-lock.json", "capabilities/excel")
      git(source, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", `invalid Excel ${mutation}`)
      git(source, "tag", "v0.2.0")
      const config = tempProject(`alg-excel-invalid-${mutation}-`)
      const excelRoot = tempProject(`alg-excel-invalid-root-${mutation}-`)
      sandboxes.push(config, excelRoot)
      expect(() => runManager({
        command: "install", configDir: config, source,
        enableCapability: "excel", excelRoot,
      }, { runner: new LocalGitRunner() })).toThrow(mutation === "wrapper-hash" ? "wrapper hash" : "tool inventory")
      expect(existsSync(join(config, "opencode.jsonc"))).toBe(false)
      expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
    }
  }, 45_000)

  test("rehashed malicious pyprojects cannot add dependencies, markers, ranges, extras, groups, or alternate sources", () => {
    const original = readFileSync(join(ROOT, "capabilities", "excel", "pyproject.toml"), "utf8")
    const cases: Record<string, string> = {
      extra: original.replace('  "excel-mcp-server==0.1.8",', '  "excel-mcp-server==0.1.8",\n  "requests==2.32.5",'),
      marker: original.replace("excel-mcp-server==0.1.8", 'excel-mcp-server==0.1.8; python_version >= "3.11"'),
      range: original.replace("excel-mcp-server==0.1.8", "excel-mcp-server>=0.1.8"),
      optional: `${original}\n[project.optional-dependencies]\ndefault = ["requests==2.32.5"]\n`,
      group: `${original}\n[dependency-groups]\ndefault = ["requests==2.32.5"]\n`,
      source: `${original}\n[tool.uv.sources]\nexcel-mcp-server = { git = "https://example.invalid/repo" }\n`,
    }
    for (const [name, malicious] of Object.entries(cases)) {
      const source = sourceFixture()
      setVersion(source, "0.2.0")
      const projectPath = join(source, "capabilities", "excel", "pyproject.toml")
      const manifestPath = join(source, "capabilities", "excel", "manifest.json")
      writeFileSync(projectPath, malicious)
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
      manifest.files.sha256.pyproject = createHash("sha256").update(Buffer.from(malicious, "utf8")).digest("hex")
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      git(source, "add", "package.json", "package-lock.json", "capabilities/excel")
      git(source, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", `malicious pyproject ${name}`)
      git(source, "tag", "v0.2.0")
      const config = tempProject(`alg-excel-malicious-${name}-`)
      const excelRoot = tempProject(`alg-excel-malicious-root-${name}-`)
      sandboxes.push(config, excelRoot)
      expect(() => runManager({ command: "install", configDir: config, source, enableCapability: "excel", excelRoot }, {
        runner: new LocalGitRunner(),
      })).toThrow("pyproject must contain only the exact")
      expect(existsSync(join(config, "opencode.jsonc"))).toBe(false)
      expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
    }
  }, 90_000)

  test("custom alg_excel blocks enable, UTF-16/comments/unrelated MCP survive enable, and receipts contain no ambient secrets", () => {
    const source = sourceFixture()
    const excelRoot = tempProject("alg-excel-encoding-root-")
    sandboxes.push(excelRoot)
    const conflictConfig = tempProject("alg-excel-conflict-")
    sandboxes.push(conflictConfig)
    const conflictPath = join(conflictConfig, "opencode.jsonc")
    const conflict = Buffer.from('{ "mcp": { "alg_excel": { "type": "remote", "url": "https://custom.invalid" } } }\n')
    writeFileSync(conflictPath, conflict)
    expect(() => runManager({
      command: "install", configDir: conflictConfig, source,
      enableCapability: "excel", excelRoot,
    }, { runner: new LocalGitRunner() })).toThrow("Custom or malformed mcp.alg_excel")
    expect(readFileSync(conflictPath)).toEqual(conflict)
    expect(existsSync(join(conflictConfig, ".opencode-alg", "receipt.json"))).toBe(false)

    const config = tempProject("alg-excel-utf16-")
    sandboxes.push(config)
    const configPath = join(config, "opencode.jsonc")
    const text = `{
  // keep Excel neighboring config
  "plugin": ["unrelated"],
  "mcp": { "other": { "type": "local", "command": ["tool", "arg"] }, },
}\n`
    writeFileSync(configPath, encodeConfigText(text, { name: "utf16le", bom: true }))
    const priorSecret = process.env.ALG_MANAGER_TEST_TOKEN
    process.env.ALG_MANAGER_TEST_TOKEN = "must-not-enter-receipt"
    try {
      runManager({ command: "install", configDir: config, source, enableCapability: "excel", excelRoot }, { runner: new LocalGitRunner() })
    } finally {
      if (priorSecret === undefined) delete process.env.ALG_MANAGER_TEST_TOKEN
      else process.env.ALG_MANAGER_TEST_TOKEN = priorSecret
    }
    const decoded = decodeConfigBytes(readFileSync(configPath), configPath)
    expect(decoded.encoding).toEqual({ name: "utf16le", bom: true })
    expect(decoded.text).toContain("keep Excel neighboring config")
    const parsed = parse(decoded.text) as any
    expect(parsed.mcp.other).toEqual({ type: "local", command: ["tool", "arg"] })
    expect(parsed.mcp.alg_excel.enabled).toBe(true)
    expect(readFileSync(join(config, ".opencode-alg", "receipt.json"), "utf8")).not.toContain("must-not-enter-receipt")
  }, 45_000)

  test("exact-looking unowned Excel config stays custom across enable, doctor, and uninstall", () => {
    const source = sourceFixture()
    const config = tempProject("alg-exact-unowned-excel-")
    const excelRoot = tempProject("alg-exact-unowned-excel-root-")
    sandboxes.push(config, excelRoot)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const configPath = join(config, "opencode.jsonc")
    const value = parse(readFileSync(configPath, "utf8")) as any
    value.mcp = { ...(value.mcp ?? {}), alg_excel: expectedExcelConfig(config, excelRoot) }
    writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`)
    const customBytes = readFileSync(configPath)
    const receiptBytes = readFileSync(join(config, ".opencode-alg", "receipt.json"))
    const doctor = runManager({ command: "doctor", configDir: config }, { runner })
    expect(doctor.capability_status?.status).toBe("custom")
    expect(doctor.issues).toContainEqual({ code: "excel-config-custom", message: "A custom mcp.alg_excel entry is present and is not manager-owned." })
    expect(() => runManager({ command: "update", configDir: config, source, enableCapability: "excel", excelRoot }, { runner })).toThrow("Custom or malformed mcp.alg_excel")
    expect(readFileSync(configPath)).toEqual(customBytes)
    expect(readFileSync(join(config, ".opencode-alg", "receipt.json"))).toEqual(receiptBytes)
    const uninstalled = runManager({ command: "uninstall", configDir: config }, { runner })
    expect(uninstalled.issues).toContainEqual({ code: "excel-config-custom", message: "Custom or drifted mcp.alg_excel was preserved during uninstall." })
    expect((parse(readFileSync(configPath, "utf8")) as any).mcp.alg_excel).toEqual(value.mcp.alg_excel)
  }, 45_000)

  test("rollback cannot launder an exact target Excel config without current receipt ownership", () => {
    const source = sourceFixture()
    const config = tempProject("alg-exact-unowned-rollback-")
    const excelRoot = tempProject("alg-exact-unowned-rollback-root-")
    sandboxes.push(config, excelRoot)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source, enableCapability: "excel", excelRoot }, { runner })
    const first = receipt(config)
    const firstGeneration = first.generations.find((item) => item.id === first.active_generation)!
    const firstManaged = structuredClone(firstGeneration.capabilities!.excel.managed_config!)
    advanceToV02(source)
    runManager({ command: "update", configDir: config, source, disableCapability: "excel" }, { runner })
    const configPath = join(config, "opencode.jsonc")
    const value = parse(readFileSync(configPath, "utf8")) as any
    value.mcp = { ...(value.mcp ?? {}), alg_excel: firstManaged }
    writeFileSync(configPath, `${JSON.stringify(value, null, 2)}\n`)
    const configBytes = readFileSync(configPath)
    const receiptBytes = readFileSync(join(config, ".opencode-alg", "receipt.json"))
    expect(() => runManager({ command: "rollback", configDir: config }, { runner })).toThrow("Custom or malformed mcp.alg_excel")
    expect(readFileSync(configPath)).toEqual(configBytes)
    expect(readFileSync(join(config, ".opencode-alg", "receipt.json"))).toEqual(receiptBytes)
  }, 60_000)

  test("doctor checks exact Excel runtime through the injected runner and journal repair rolls capability config back", () => {
    const source = sourceFixture()
    const config = tempProject("alg-excel-doctor-")
    const excelRoot = tempProject("alg-excel-doctor-root-")
    sandboxes.push(config, excelRoot)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source, enableCapability: "excel", excelRoot }, { runner })
    const healthy = runManager({ command: "doctor", configDir: config }, { runner })
    expect(healthy.capability_status).toMatchObject({
      name: "excel", status: "healthy", enabled: true,
      manifest: "ok", lock: "ok", wrapper: "ok", environment: "ok",
      runtime_check: "ok", upstream_version: "0.1.8", tool_count: 25,
    })
    const configPath = join(config, "opencode.jsonc")
    const drifted = parse(readFileSync(configPath, "utf8")) as any
    drifted.mcp.alg_excel.command[1] = "custom-wrapper.py"
    writeFileSync(configPath, `${JSON.stringify(drifted, null, 2)}\n`)
    const doctor = runManager({ command: "doctor", configDir: config }, { runner })
    expect(doctor.capability_status?.status).toBe("drift")
    expect(doctor.capability_status?.runtime_check).toBe("not-run")
    expect(doctor.issues?.some((issue) => issue.code === "excel-config-drift")).toBe(true)

    const crashConfig = tempProject("alg-excel-journal-")
    sandboxes.push(crashConfig)
    const crashPath = join(crashConfig, "opencode.jsonc")
    const before = Buffer.from('{ "plugin": ["before"] }\n')
    writeFileSync(crashPath, before)
    expect(() => runManager({
      command: "install", configDir: crashConfig, source,
      enableCapability: "excel", excelRoot,
    }, {
      runner: new LocalGitRunner(),
      faults: { afterLiveWrite(_path, index) { if (index === 0) throw new SimulatedManagerCrashError("Excel config crash") } },
    })).toThrow("Excel config crash")
    expect(readFileSync(crashPath)).not.toEqual(before)
    runManager({ command: "doctor", configDir: crashConfig, repairJournal: true }, { runner: new LocalGitRunner() })
    expect(readFileSync(crashPath)).toEqual(before)
    expect(readdirSync(join(crashConfig, ".opencode-alg", "transactions"))).toEqual([])
  }, 60_000)

  test("same-generation Excel enable/disable journals prove receipt before/after hashes across every crash boundary", () => {
    const source = sourceFixture()
    const excelRoot = tempProject("alg-excel-same-generation-journal-root-")
    sandboxes.push(excelRoot)
    for (const action of ["enable", "disable"] as const) {
      for (const boundary of ["before-live", "live-before-receipt", "after-receipt"] as const) {
        const config = tempProject(`alg-excel-${action}-${boundary}-`)
        sandboxes.push(config)
        const runner = new LocalGitRunner()
        runManager({
          command: "install", configDir: config, source,
          ...(action === "disable" ? { enableCapability: "excel" as const, excelRoot } : {}),
        }, { runner })
        const receiptPath = join(config, ".opencode-alg", "receipt.json")
        const receiptBefore = readFileSync(receiptPath)
        const configPath = join(config, "opencode.jsonc")
        const configBefore = readFileSync(configPath)
        const faults = boundary === "after-receipt"
          ? { afterReceiptCommit() { throw new SimulatedManagerCrashError(`${action}-${boundary}`) } }
          : {
              afterJournalPhase(phase: "prepared" | "writing" | "files-claimed" | "live-written" | "receipt-linked" | "receipt-claimed" | "receipt-published" | "receipt-committed") {
                if ((boundary === "before-live" && phase === "writing") ||
                  (boundary === "live-before-receipt" && phase === "live-written")) {
                  throw new SimulatedManagerCrashError(`${action}-${boundary}`)
                }
              },
            }
        expect(() => runManager({
          command: "update", configDir: config, source,
          ...(action === "enable"
            ? { enableCapability: "excel" as const, excelRoot }
            : { disableCapability: "excel" as const }),
        }, { runner, faults })).toThrow(`${action}-${boundary}`)
        const journals = readdirSync(join(config, ".opencode-alg", "transactions"))
        expect(journals).toHaveLength(1)
        const journal = JSON.parse(readFileSync(join(config, ".opencode-alg", "transactions", journals[0]!), "utf8"))
        expect(journal.receipt_after_hash).toMatch(/^[a-f0-9]{64}$/)
        expect(journal.receipt_after_hash).not.toBe(journal.receipt_before_hash)

        if (boundary === "after-receipt") {
          expect(readFileSync(receiptPath)).not.toEqual(receiptBefore)
        } else {
          expect(readFileSync(receiptPath)).toEqual(receiptBefore)
        }
        runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })
        expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
        const current = parse(readFileSync(configPath, "utf8")) as any
        const expectedEnabled = boundary === "after-receipt" ? action === "enable" : action === "disable"
        expect(Boolean(current.mcp?.alg_excel)).toBe(expectedEnabled)
        if (boundary !== "after-receipt") {
          expect(readFileSync(configPath)).toEqual(configBefore)
          expect(readFileSync(receiptPath)).toEqual(receiptBefore)
        }
        const again = runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })
        expect(again.pending_journals).toEqual([])
      }
    }
  }, 120_000)

  test("journal repair fails closed when receipt matches neither cryptographic state", () => {
    const source = sourceFixture()
    const config = tempProject("alg-excel-journal-third-state-")
    const excelRoot = tempProject("alg-excel-journal-third-root-")
    sandboxes.push(config, excelRoot)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    expect(() => runManager({ command: "update", configDir: config, source, enableCapability: "excel", excelRoot }, {
      runner,
      faults: { afterJournalPhase(phase) { if (phase === "writing") throw new SimulatedManagerCrashError("third-state") } },
    })).toThrow("third-state")
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    writeFileSync(receiptPath, `${JSON.stringify({ unrelated: true })}\n`)
    expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })).toThrow("neither the cryptographic before-state nor intended after-state")
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
  }, 30_000)

  test("committed journal repair retains the journal when any live file differs from its intended after-state", () => {
    const source = sourceFixture()
    const config = tempProject("alg-committed-journal-live-drift-")
    const excelRoot = tempProject("alg-committed-journal-live-drift-root-")
    sandboxes.push(config, excelRoot)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    expect(() => runManager({ command: "update", configDir: config, source, enableCapability: "excel", excelRoot }, {
      runner,
      faults: { afterReceiptCommit() { throw new SimulatedManagerCrashError("committed-live-drift") } },
    })).toThrow("committed-live-drift")
    const transactionRoot = join(config, ".opencode-alg", "transactions")
    expect(readdirSync(transactionRoot)).toHaveLength(1)
    const configPath = join(config, "opencode.jsonc")
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}\n// drift after committed receipt\n`)
    expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })).toThrow(
      /committed state|prepared auxiliary bytes are ambiguous/,
    )
    expect(readdirSync(transactionRoot)).toHaveLength(1)
  }, 30_000)

  test("installs, updates side-by-side, preserves tuple options/custom agents, rolls back, and uninstalls safely", () => {
    const source = sourceFixture()
    const config = tempProject("alg manager config with spaces-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    const sourceSpec = pathToFileURL(source).href.replace(/\/$/, "")
    writeFileSync(join(config, "opencode.jsonc"), `{
  // preserve server comment
  "plugin": [["${sourceSpec}", { "tuple": true }], "unrelated"],
}\n`)
    writeFileSync(join(config, "tui.json"), `{ "plugin": [["${sourceSpec}/src/tui.ts", { "tui": true }]], }\n`)
    mkdirSync(join(config, "agents"))
    cpSync(join(source, "agents", "explorer.md"), join(config, "agents", "explorer.md"))
    writeFileSync(join(config, "agents", "checker.md"), "custom checker\n")

    const installed = runManager({ command: "install", configDir: config, source }, { runner })
    expect(installed.ok).toBe(true)
    expect(installed.generation?.startsWith("0.1.0-")).toBe(true)
    const first = receipt(config)
    const firstRoot = first.generations[0]!.package_root
    expect(existsSync(firstRoot)).toBe(true)
    expect(firstRoot).toBe(join(first.install_root, "releases", first.generations[0]!.id, "package"))
    expect(first.agents["explorer.md"]?.disposition).toBe("managed")
    expect(first.agents["checker.md"]?.disposition).toBe("custom")
    const server = parse(readFileSync(join(config, "opencode.jsonc"), "utf8")) as any
    expect(server.plugin).toContainEqual([first.generations[0]!.spec, { tuple: true }])
    expect(server.plugin).toContain("unrelated")
    expect(readFileSync(join(config, "opencode.jsonc"), "utf8")).toContain("preserve server comment")
    const firstReceiptBytes = readFileSync(join(config, ".opencode-alg", "receipt.json"))
    expect(runManager({ command: "install", configDir: config, source }, { runner }).changed).toBe(false)
    expect(readFileSync(join(config, ".opencode-alg", "receipt.json"))).toEqual(firstReceiptBytes)

    advanceToV02(source)
    const updated = runManager({ command: "update", configDir: config, source }, { runner })
    expect(updated.generation?.startsWith("0.2.0-")).toBe(true)
    const second = receipt(config)
    expect(second.generations).toHaveLength(2)
    for (const generation of second.generations) {
      expect(generation.production_dependencies?.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(generation.production_dependencies?.files).toBeGreaterThan(0)
      expect(generation.production_dependencies?.bytes).toBeGreaterThan(0)
    }
    expect(existsSync(firstRoot)).toBe(true)
    expect(readFileSync(join(config, "agents", "explorer.md"), "utf8")).toContain("v0.2 fixture")
    expect(readFileSync(join(config, "agents", "checker.md"), "utf8")).toBe("custom checker\n")
    const tui = parse(readFileSync(join(config, "tui.json"), "utf8")) as any
    expect(tui.plugin).toContainEqual([second.generations[1]!.spec, { tui: true }])
    const secondRoot = second.generations[1]!.package_root
    const secondReceiptBytes = readFileSync(join(config, ".opencode-alg", "receipt.json"))
    expect(runManager({ command: "update", configDir: config, source }, { runner }).changed).toBe(false)
    expect(readFileSync(join(config, ".opencode-alg", "receipt.json"))).toEqual(secondReceiptBytes)

    const doctor = runManager({ command: "doctor", configDir: config }, { runner })
    expect(doctor.ok).toBe(true)
    expect(doctor.previous_generation).toBe(first.generations[0]!.id)

    const rolledBack = runManager({ command: "rollback", configDir: config }, { runner })
    expect(rolledBack.generation).toBe(first.generations[0]!.id)
    expect(readFileSync(join(config, "agents", "explorer.md"), "utf8")).not.toContain("v0.2 fixture")
    expect(readFileSync(join(config, "agents", "checker.md"), "utf8")).toBe("custom checker\n")

    runManager({ command: "uninstall", configDir: config, removeAgents: true }, { runner })
    expect(existsSync(join(config, "agents", "explorer.md"))).toBe(false)
    expect(readFileSync(join(config, "agents", "checker.md"), "utf8")).toBe("custom checker\n")
    expect(receipt(config).installed).toBe(false)
    expect(existsSync(firstRoot)).toBe(true)
    expect(existsSync(secondRoot)).toBe(true)
    const uninstalledReceipt = readFileSync(join(config, ".opencode-alg", "receipt.json"))
    expect(runManager({ command: "uninstall", configDir: config, removeAgents: true }, { runner }).changed).toBe(false)
    expect(readFileSync(join(config, ".opencode-alg", "receipt.json"))).toEqual(uninstalledReceipt)
  }, 30_000)

  test("resolves exact v0.1.0 to v0.2.0 tags from a local bare remote with argument-vector dependency install", () => {
    const fixture = bareRemoteFixture()
    const config = tempProject("alg bare config with spaces-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()

    const installed = runManager({ command: "install", configDir: config, remote: fixture.remote, tag: "v0.1.0" }, { runner })
    expect(installed.generation?.startsWith("0.1.0-")).toBe(true)
    pushV02(fixture.source)
    const updated = runManager({ command: "update", configDir: config, tag: "v0.2.0" }, { runner })
    expect(updated.generation?.startsWith("0.2.0-")).toBe(true)
    const state = receipt(config)
    expect(state.generations.map((item) => item.tag)).toEqual(["v0.1.0", "v0.2.0"])
    expect(state.trusted_remote).toBe(pathToFileURL(resolve(fixture.remote)).href)
    const npmRequests = runner.requests.filter(isNpmRequest)
    expect(npmRequests).toHaveLength(2)
    expect(npmRequests.every((item) => JSON.stringify(item.args.slice(-5)) === JSON.stringify([
      "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund",
    ]))).toBe(true)
    expect(runner.requests.every((item) => !item.args.some((arg) => arg.includes("git pull") || arg.includes("git reset")))).toBe(true)
  }, 30_000)

  test("existing-generation update reuse requires the trusted origin and accepts a healthy retained generation", () => {
    const source = sourceFixture()
    const config = tempProject("alg-existing-generation-origin-")
    const otherRemote = tempProject("alg-existing-generation-other-origin-")
    sandboxes.push(config, otherRemote)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    advanceToV02(source)
    runManager({ command: "update", configDir: config, source }, { runner })
    const v02 = receipt(config).generations.find((generation) => generation.version === "0.2.0")!
    runManager({ command: "rollback", configDir: config }, { runner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const serverPath = join(config, "opencode.jsonc")
    const receiptBefore = readFileSync(receiptPath)
    const serverBefore = readFileSync(serverPath)
    const dependencyPath = join(v02.package_root, "node_modules", "zod", "index.js")
    const dependencyBefore = readFileSync(dependencyPath)
    writeFileSync(dependencyPath, "changed dependency bytes\n")
    expect(() => runManager({ command: "update", configDir: config, source }, { runner })).toThrow("does not match")
    expect(readFileSync(receiptPath)).toEqual(receiptBefore)
    expect(readFileSync(serverPath)).toEqual(serverBefore)
    writeFileSync(dependencyPath, dependencyBefore)
    git(v02.package_root, "remote", "set-url", "origin", otherRemote)
    expect(() => runManager({ command: "update", configDir: config, source }, { runner })).toThrow("origin differs")
    expect(readFileSync(receiptPath)).toEqual(receiptBefore)
    expect(readFileSync(serverPath)).toEqual(serverBefore)
    git(v02.package_root, "remote", "set-url", "origin", receipt(config).trusted_remote)
    const reused = runManager({ command: "update", configDir: config, source }, { runner })
    expect(reused.generation).toBe(v02.id)
    expect(receipt(config).active_generation).toBe(v02.id)
  }, 45_000)

  test("rejects package-lock mismatch from a local bare remote before live writes", () => {
    const fixture = bareRemoteFixture()
    advanceWithLockMismatch(fixture.source)
    const config = tempProject("alg-lock-mismatch-")
    sandboxes.push(config)
    const serverPath = join(config, "opencode.jsonc")
    const before = Buffer.from('{ "plugin": ["keep"] }\n')
    writeFileSync(serverPath, before)
    const runner = new LocalGitRunner()
    expect(() => runManager({ command: "install", configDir: config, remote: fixture.remote, tag: "v0.2.0" }, { runner })).toThrow("package-lock root version")
    expect(readFileSync(serverPath)).toEqual(before)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
    expect(runner.requests.some(isNpmRequest)).toBe(false)

    const packageFixture = bareRemoteFixture()
    advanceWithPackageMismatch(packageFixture.source)
    const packageConfig = tempProject("alg-package-mismatch-")
    sandboxes.push(packageConfig)
    expect(() => runManager({ command: "install", configDir: packageConfig, remote: packageFixture.remote, tag: "v0.2.0" }, { runner: new LocalGitRunner() })).toThrow("package.json version/name")
    expect(existsSync(join(packageConfig, "opencode.jsonc"))).toBe(false)
    expect(existsSync(join(packageConfig, ".opencode-alg", "receipt.json"))).toBe(false)
  }, 30_000)

  test("rejects trusted remote mismatch and non-fast-forward stable update", () => {
    const fixture = bareRemoteFixture()
    const otherSandbox = tempProject("alg-other-bare-")
    sandboxes.push(otherSandbox)
    const otherRemote = join(otherSandbox, "other.git")
    const initialized = spawnSync("git", ["init", "--bare", "--initial-branch=main", otherRemote], { encoding: "utf8", shell: false, windowsHide: true })
    expect(initialized.status).toBe(0)
    const config = tempProject("alg-remote-mismatch-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, remote: fixture.remote, tag: "v0.1.0" }, { runner })
    const before = readFileSync(join(config, ".opencode-alg", "receipt.json"))
    expect(() => runManager({ command: "update", configDir: config, remote: otherRemote, tag: "v0.2.0" }, { runner })).toThrow("Trusted remote")
    expect(readFileSync(join(config, ".opencode-alg", "receipt.json"))).toEqual(before)

    advanceNonFastForward(fixture.source)
    expect(() => runManager({ command: "update", configDir: config, tag: "v0.2.0" }, { runner })).toThrow("not a descendant")
    expect(readFileSync(join(config, ".opencode-alg", "receipt.json"))).toEqual(before)
    expect(receipt(config).active_generation?.startsWith("0.1.0-")).toBe(true)
  }, 30_000)

  test("dependency command failure from a bare remote is bounded/redacted and performs no live writes", () => {
    const fixture = bareRemoteFixture()
    const config = tempProject("alg-dependency-failure-")
    sandboxes.push(config)
    const serverPath = join(config, "opencode.jsonc")
    const tuiPath = join(config, "tui.json")
    const server = Buffer.from('{ "plugin": ["server-before"] }\n')
    const tui = Buffer.from('{ "plugin": ["tui-before"] }\n')
    writeFileSync(serverPath, server)
    writeFileSync(tuiPath, tui)
    const runner = new LocalGitRunner()
    runner.failDependencies = true
    runner.dependencyError = `token=super-secret ${"x".repeat(32_000)}`
    let message = ""
    try {
      runManager({ command: "install", configDir: config, remote: fixture.remote, tag: "v0.1.0" }, { runner })
    } catch (error) {
      message = managerErrorMessage(error)
    }
    expect(message).toContain("token=[redacted]")
    expect(message).not.toContain("super-secret")
    expect(Buffer.byteLength(message)).toBeLessThanOrEqual(2_048)
    expect(readFileSync(serverPath)).toEqual(server)
    expect(readFileSync(tuiPath)).toEqual(tui)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
  }, 30_000)

  test("rejects an existing target-generation collision without replacing it", () => {
    const source = sourceFixture()
    const config = tempProject("alg-target-collision-")
    sandboxes.push(config)
    const commit = git(source, "rev-parse", "HEAD")
    const target = join(config, "plugins", "opencode-alg", "releases", `0.1.0-${commit.slice(0, 12)}`)
    mkdirSync(target, { recursive: true })
    const marker = Buffer.from("not a release\n")
    writeFileSync(join(target, "collision.txt"), marker)
    expect(() => runManager({ command: "install", configDir: config, source }, { runner: new LocalGitRunner() })).toThrow()
    expect(readFileSync(join(target, "collision.txt"))).toEqual(marker)
    expect(existsSync(join(config, "opencode.jsonc"))).toBe(false)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
  }, 30_000)

  test("generation reservation is exclusive and cleanup removes only an unchanged empty reservation", () => {
    for (const variant of ["empty", "foreign"] as const) {
      const source = sourceFixture()
      const config = tempProject(`alg-generation-reservation-${variant}-`)
      sandboxes.push(config)
      const commit = git(source, "rev-parse", "HEAD")
      const reservation = join(config, "plugins", "opencode-alg", "releases", `0.1.0-${commit.slice(0, 12)}`)
      const marker = join(reservation, "foreign.txt")
      expect(() => runManager({ command: "install", configDir: config, source }, {
        runner: new LocalGitRunner(),
        faults: { afterGenerationPackageCreated(packagePath) {
          expect(packagePath).toBe(join(reservation, "package"))
          if (variant === "foreign") writeFileSync(marker, "foreign reservation content\n")
          throw new Error(`injected ${variant} generation materialization failure`)
        } },
      })).toThrow(`injected ${variant} generation materialization failure`)
      if (variant === "empty") expect(existsSync(reservation)).toBe(false)
      else expect(readFileSync(marker, "utf8")).toBe("foreign reservation content\n")
      expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
    }
  }, 60_000)

  test("generation materialization preserves a raced destination and its reservation", () => {
    const source = sourceFixture()
    const config = tempProject("alg-generation-destination-race-")
    sandboxes.push(config)
    let destination = ""
    const foreign = Buffer.from("foreign generation destination\n")
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner: new LocalGitRunner(),
      faults: { beforeGenerationEntryCreate(_source, target) {
        if (destination) return
        destination = target
        writeFileSync(target, foreign, { flag: "wx" })
      } },
    })).toThrow(/EEXIST|publication failed|cleanup was incomplete/)
    expect(readFileSync(destination)).toEqual(foreign)
    expect(destination).toContain(`${join("releases", "0.1.0-")}`)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
  }, 45_000)

  test("generation materialization link failure removes only unchanged manager-created paths", () => {
    const source = sourceFixture()
    const config = tempProject("alg-generation-link-failure-")
    sandboxes.push(config)
    const commit = git(source, "rev-parse", "HEAD")
    const reservation = join(config, "plugins", "opencode-alg", "releases", `0.1.0-${commit.slice(0, 12)}`)
    let failed = false
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner: new LocalGitRunner(),
      link(existing, destination) {
        if (!failed && String(destination).startsWith(join(reservation, "package"))) {
          failed = true
          throw Object.assign(new Error("injected generation hard-link failure"), { code: "EIO" })
        }
        linkSync(existing, destination)
      },
    })).toThrow("injected generation hard-link failure")
    expect(failed).toBe(true)
    expect(existsSync(reservation)).toBe(false)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
  }, 45_000)

  test("generation cleanup preserves a same-byte identity replacement and reservation", () => {
    const source = sourceFixture()
    const config = tempProject("alg-generation-identity-replacement-")
    sandboxes.push(config)
    let destination = ""
    let replacement = Buffer.alloc(0)
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner: new LocalGitRunner(),
      faults: { afterGenerationEntryCreate(sourcePath, target) {
        if (destination || !lstatSync(sourcePath).isFile()) return
        destination = target
        replacement = readFileSync(target)
        rmSync(target)
        writeFileSync(target, replacement, { flag: "wx" })
      } },
    })).toThrow(/identity changed|publication failed|cleanup was incomplete/)
    expect(readFileSync(destination)).toEqual(replacement)
    expect(existsSync(dirname(destination))).toBe(true)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
  }, 45_000)

  test("staging cleanup preserves foreign additions and removes a clean validated staging tree", () => {
    const cleanSource = sourceFixture()
    const cleanConfig = tempProject("alg-generation-clean-staging-")
    sandboxes.push(cleanConfig)
    runManager({ command: "install", configDir: cleanConfig, source: cleanSource }, { runner: new LocalGitRunner() })
    expect(readdirSync(join(cleanConfig, "plugins", "opencode-alg", ".staging"))).toEqual([])

    const racedSource = sourceFixture()
    const racedConfig = tempProject("alg-generation-raced-staging-")
    sandboxes.push(racedConfig)
    let foreign = ""
    expect(() => runManager({ command: "install", configDir: racedConfig, source: racedSource }, {
      runner: new LocalGitRunner(),
      faults: { beforeGenerationStagingCleanup(stagingPath) {
        if (foreign) return
        foreign = join(stagingPath, "foreign-after-validation.txt")
        writeFileSync(foreign, "foreign staging bytes\n", { flag: "wx" })
      } },
    })).toThrow(/staging tree changed|cleanup was incomplete/)
    expect(readFileSync(foreign, "utf8")).toBe("foreign staging bytes\n")
    expect(existsSync(join(racedConfig, ".opencode-alg", "receipt.json"))).toBe(false)
  }, 90_000)

  test.each(["git", "npm"] as const)("failed %s staging that adds a foreign file is preserved for inspection", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-foreign-failed-${variant}-staging-`)
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runner.failDependencies = variant === "npm"
    let foreign = ""
    runner.onRequest = (request) => {
      const clone = request.command === "git" && request.args[0] === "clone"
      const npm = isNpmRequest(request)
      if (foreign || variant === "git" && !clone || variant === "npm" && !npm) return
      const stagingPath = clone ? request.args.at(-1)! : request.cwd!
      mkdirSync(stagingPath, { recursive: true })
      foreign = join(stagingPath, `foreign-from-failed-${variant}.txt`)
      writeFileSync(foreign, `foreign ${variant} staging bytes\n`, { flag: "wx" })
    }

    expect(() => runManager({ command: "install", configDir: config, source }, { runner }))
      .toThrow(/staging tree preserved for inspection/)
    expect(foreign).not.toBe("")
    expect(readFileSync(foreign, "utf8")).toBe(`foreign ${variant} staging bytes\n`)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
  }, 60_000)

  test.each(["occupied", "same-byte-replacement"] as const)("private primitive probe preserves %s foreign state", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-private-probe-${variant}-`)
    sandboxes.push(config)
    let retained = ""
    let retainedBytes = Buffer.alloc(0)
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner: new LocalGitRunner(),
      faults: { afterProbeDirectoryCreated(directory) {
        if (retained) return
        retained = variant === "occupied" ? join(directory, "link-target") : join(directory, "source")
        if (variant === "occupied") retainedBytes = Buffer.from("foreign probe target\n")
        else retainedBytes = readFileSync(retained)
        if (variant === "same-byte-replacement") rmSync(retained)
        writeFileSync(retained, retainedBytes, { flag: "wx" })
      } },
    })).toThrow("Private no-clobber primitive probe failed")
    expect(readFileSync(retained)).toEqual(retainedBytes)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
  }, 45_000)

  test("dependency failure and a late injected failure leave config and agents byte-identical", () => {
    const source = sourceFixture()
    const config = tempProject("alg-manager-fault-")
    sandboxes.push(config)
    const serverPath = join(config, "opencode.jsonc")
    const tuiPath = join(config, "tui.json")
    const server = Buffer.from('{ "plugin": ["unrelated"], "keep": 1 }\n')
    const tui = Buffer.from('{ "plugin": ["unrelated-tui"], "keep": 2 }\n')
    writeFileSync(serverPath, server)
    writeFileSync(tuiPath, tui)
    const runner = new LocalGitRunner()
    runner.failDependencies = true
    expect(() => runManager({ command: "install", configDir: config, source }, { runner })).toThrow("dependency failure")
    expect(readFileSync(serverPath)).toEqual(server)
    expect(readFileSync(tuiPath)).toEqual(tui)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)

    runner.failDependencies = false
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner,
      faults: { beforeReceiptCommit() { throw new Error("injected receipt failure") } },
    })).toThrow("injected receipt failure")
    expect(readFileSync(serverPath)).toEqual(server)
    expect(readFileSync(tuiPath)).toEqual(tui)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
  }, 30_000)

  test("rejects dirty/untracked source, tag-version mismatch, and customized managed-agent drift on rollback", () => {
    const source = sourceFixture()
    const config = tempProject("alg-manager-reject-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    writeFileSync(join(source, "untracked.txt"), "dirty")
    expect(() => runManager({ command: "install", configDir: config, source }, { runner })).toThrow("tracked or untracked")
    rmSync(join(source, "untracked.txt"))
    writeFileSync(join(source, "README.md"), "tracked dirty\n")
    expect(() => runManager({ command: "install", configDir: config, source }, { runner })).toThrow("tracked or untracked")
    git(source, "checkout", "--", "README.md")
    expect(() => runManager({ command: "install", configDir: config, source, tag: "v0.1.0", version: "0.2.0" }, { runner })).toThrow("disagree")

    runManager({ command: "install", configDir: config, source }, { runner })
    advanceToV02(source)
    runManager({ command: "update", configDir: config, source }, { runner })
    const explorer = join(config, "agents", "explorer.md")
    writeFileSync(explorer, "locally customized after update\n")
    runManager({ command: "rollback", configDir: config }, { runner })
    expect(readFileSync(explorer, "utf8")).toBe("locally customized after update\n")
    const doctor = runManager({ command: "doctor", configDir: config }, { runner })
    expect(doctor.agent_status?.find((item) => item.name === "explorer.md")?.status).toBe("custom")
  }, 30_000)

  test("rollback revalidates clean Git state, origin, HEAD/tag/commit, package, lock, and runtime digest before live writes", () => {
    const source = sourceFixture()
    const config = tempProject("alg-rollback-revalidation-")
    const otherRemote = tempProject("alg-rollback-other-origin-")
    sandboxes.push(config, otherRemote)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    advanceToV02(source)
    runManager({ command: "update", configDir: config, source }, { runner })
    const state = receipt(config)
    const target = state.generations.find((generation) => generation.version === "0.1.0")!
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const serverPath = join(config, "opencode.jsonc")
    const receiptBefore = readFileSync(receiptPath)
    const serverBefore = readFileSync(serverPath)
    const restore = () => {
      for (const path of ["package.json", "package-lock.json", "src/index.ts"]) {
        git(target.package_root, "update-index", "--no-skip-worktree", path)
      }
      git(target.package_root, "reset", "--hard", target.commit)
      git(target.package_root, "clean", "-fd")
      git(target.package_root, "tag", "-f", target.tag, target.commit)
      git(target.package_root, "remote", "set-url", "origin", state.trusted_remote)
      rmSync(join(target.package_root, "node_modules", "zod", "dependency-drift.js"), { force: true })
    }
    const attempts: Array<[string, () => void]> = [
      ["dirty checkout", () => writeFileSync(join(target.package_root, "untracked.txt"), "dirty\n")],
      ["origin drift", () => git(target.package_root, "remote", "set-url", "origin", otherRemote)],
      ["HEAD drift", () => git(target.package_root, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "--allow-empty", "-m", "unexpected head")],
      ["tag drift", () => {
        git(target.package_root, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "--allow-empty", "-m", "unexpected tag target")
        const wrong = git(target.package_root, "rev-parse", "HEAD")
        git(target.package_root, "tag", "-f", target.tag, wrong)
        git(target.package_root, "reset", "--hard", target.commit)
      }],
      ["package drift hidden from status", () => {
        git(target.package_root, "update-index", "--skip-worktree", "package.json")
        const path = join(target.package_root, "package.json")
        const pkg = JSON.parse(readFileSync(path, "utf8"))
        pkg.version = "9.9.9"
        writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`)
      }],
      ["lock drift hidden from status", () => {
        git(target.package_root, "update-index", "--skip-worktree", "package-lock.json")
        const path = join(target.package_root, "package-lock.json")
        writeFileSync(path, `${readFileSync(path, "utf8")}\n`)
      }],
      ["runtime drift hidden from status", () => {
        git(target.package_root, "update-index", "--skip-worktree", "src/index.ts")
        const path = join(target.package_root, "src", "index.ts")
        writeFileSync(path, `${readFileSync(path, "utf8")}\n// hidden runtime drift\n`)
      }],
      ["production dependency drift", () => {
        writeFileSync(join(target.package_root, "node_modules", "zod", "dependency-drift.js"), "drift\n")
      }],
    ]
    for (const [label, mutate] of attempts) {
      mutate()
      expect(() => runManager({ command: "rollback", configDir: config }, { runner }), label).toThrow()
      expect(readFileSync(receiptPath), label).toEqual(receiptBefore)
      expect(readFileSync(serverPath), label).toEqual(serverBefore)
      restore()
    }
  }, 60_000)

  test("preserves manager-level UTF-8/UTF-16 BOM, comments, trailing commas, and tuple options", () => {
    const source = sourceFixture()
    const config = tempProject("alg-manager-encoding-")
    sandboxes.push(config)
    const sourceSpec = pathToFileURL(source).href.replace(/\/$/, "")
    const serverPath = join(config, "opencode.jsonc")
    const tuiPath = join(config, "tui.json")
    const serverText = `{
  // server BOM comment
  "plugin": [["${sourceSpec}", { "keep": "server" }],],
}\n`
    const tuiText = `{
  // tui UTF16 comment
  "plugin": [["${sourceSpec}/src/tui.ts", { "keep": "tui" }],],
}\n`
    writeFileSync(serverPath, encodeConfigText(serverText, { name: "utf8", bom: true }))
    writeFileSync(tuiPath, encodeConfigText(tuiText, { name: "utf16le", bom: true }))
    runManager({ command: "install", configDir: config, source, agentPolicy: "skip" }, { runner: new LocalGitRunner() })
    const server = decodeConfigBytes(readFileSync(serverPath), serverPath)
    const tui = decodeConfigBytes(readFileSync(tuiPath), tuiPath)
    expect(server.encoding).toEqual({ name: "utf8", bom: true })
    expect(tui.encoding).toEqual({ name: "utf16le", bom: true })
    expect(server.text).toContain("server BOM comment")
    expect(tui.text).toContain("tui UTF16 comment")
    const activeSpec = activeReceiptSpec(config)
    expect((parse(server.text) as any).plugin).toContainEqual([activeSpec, { keep: "server" }])
    expect((parse(tui.text) as any).plugin).toContainEqual([activeSpec, { keep: "tui" }])
  }, 30_000)

  test("forged receipt agent keys fail before uninstall can read or delete outside direct bundled scope", () => {
    const source = sourceFixture()
    const config = tempProject("alg-forged-agent-keys-")
    const outside = join(tempProject("alg-forged-agent-outside-"), "outside.md")
    sandboxes.push(config, dirname(outside))
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const original = JSON.parse(readFileSync(receiptPath, "utf8"))
    const serverBefore = readFileSync(join(config, "opencode.jsonc"))
    const agentBefore = readFileSync(join(config, "agents", "explorer.md"))
    writeFileSync(outside, "outside marker\n")
    const variants = ["sub/custom.md", "sub\\custom.md", "../checker.md", resolve(outside), "unknown.md", "Explorer.md", "%2e%2e.md"]
    for (const key of variants) {
      const forged = structuredClone(original)
      const prior = structuredClone(original.agents["explorer.md"])
      prior.path = key === resolve(outside) ? outside : join(config, "agents", key)
      forged.agents = { [key]: prior }
      const forgedBytes = Buffer.from(`${JSON.stringify(forged, null, 2)}\n`)
      writeFileSync(receiptPath, forgedBytes)
      expect(() => runManager({ command: "uninstall", configDir: config, removeAgents: true }, { runner }), key).toThrow()
      expect(readFileSync(receiptPath), key).toEqual(forgedBytes)
      expect(readFileSync(join(config, "opencode.jsonc")), key).toEqual(serverBefore)
      expect(readFileSync(join(config, "agents", "explorer.md")), key).toEqual(agentBefore)
      expect(readFileSync(outside, "utf8"), key).toBe("outside marker\n")
      expect(readdirSync(join(config, ".opencode-alg", "transactions")), key).toEqual([])
    }
  }, 45_000)

  test("byte-CAS drift is not overwritten and leaves a deterministic recoverable journal", () => {
    const source = sourceFixture()
    const config = tempProject("alg-manager-cas-")
    sandboxes.push(config)
    const serverPath = join(config, "opencode.jsonc")
    const tuiPath = join(config, "tui.json")
    const serverBefore = Buffer.from('{ "plugin": ["before"], "value": 1 }\n')
    const tuiBefore = Buffer.from('{ "plugin": ["before-tui"], "value": 2 }\n')
    const drift = Buffer.from('{ "plugin": ["concurrent"], "value": 99 }\n')
    writeFileSync(serverPath, serverBefore)
    writeFileSync(tuiPath, tuiBefore)
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner: new LocalGitRunner(),
      faults: {
        beforeLiveWrite(path, index) {
          if (index === 0) writeFileSync(path, drift)
        },
      },
    })).toThrow("rollback was incomplete")
    expect(readFileSync(serverPath)).toEqual(drift)
    expect(readFileSync(tuiPath)).toEqual(tuiBefore)
    const pending = runManager({ command: "doctor", configDir: config }, { runner: new LocalGitRunner() })
    expect(pending.issues?.some((issue) => issue.code === "pending-journal")).toBe(true)
    expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner: new LocalGitRunner() })).toThrow(/Third-party live file|claim is unavailable/)
    expect(readFileSync(serverPath)).toEqual(drift)
    writeFileSync(serverPath, serverBefore)
    runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner: new LocalGitRunner() })
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
    expect(readFileSync(serverPath)).toEqual(serverBefore)
  }, 30_000)

  test.each(["config", "agent"] as const)("journal preflight makes zero restorations when a later %s path is third-state", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-journal-preflight-${variant}-`)
    sandboxes.push(config)
    const serverPath = join(config, "opencode.jsonc")
    const tuiPath = join(config, "tui.json")
    const serverBefore = Buffer.from('{ "plugin": ["server-before"] }\n')
    const tuiBefore = Buffer.from('{ "plugin": ["tui-before"] }\n')
    writeFileSync(serverPath, serverBefore)
    writeFileSync(tuiPath, tuiBefore)
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner: new LocalGitRunner(),
      faults: { afterLiveWrite(_path, index) { if (index === 0) throw new SimulatedManagerCrashError("preflight crash") } },
    })).toThrow("preflight crash")
    const serverAfter = readFileSync(serverPath)
    expect(serverAfter).not.toEqual(serverBefore)
    const thirdPath = variant === "config" ? tuiPath : join(config, "agents", "explorer.md")
    mkdirSync(dirname(thirdPath), { recursive: true })
    const third = Buffer.from(`third-state-${variant}\n`)
    writeFileSync(thirdPath, third)
    expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner: new LocalGitRunner() })).toThrow(/Third-party live file|auxiliary bytes are ambiguous/)
    expect(readFileSync(serverPath)).toEqual(serverAfter)
    expect(readFileSync(thirdPath)).toEqual(third)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
  }, 45_000)

  test.each(["missing", "corrupt"] as const)("journal recovery uses identity-bound claims and does not depend on a %s audit backup", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-journal-backup-${variant}-`)
    sandboxes.push(config)
    const serverPath = join(config, "opencode.jsonc")
    const tuiPath = join(config, "tui.json")
    writeFileSync(serverPath, '{ "plugin": ["server-before"] }\n')
    writeFileSync(tuiPath, '{ "plugin": ["tui-before"] }\n')
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner: new LocalGitRunner(),
      faults: { afterLiveWrite(_path, index) { if (index === 1) throw new SimulatedManagerCrashError("backup crash") } },
    })).toThrow("backup crash")
    const serverAfter = readFileSync(serverPath)
    const tuiAfter = readFileSync(tuiPath)
    const transactionRoot = join(config, ".opencode-alg", "transactions")
    const journal = JSON.parse(readFileSync(join(transactionRoot, readdirSync(transactionRoot)[0]!), "utf8"))
    const backup = journal.files.find((file: any) => file.path === serverPath).backup
    if (variant === "missing") rmSync(backup)
    else writeFileSync(backup, "corrupt backup\n")
    runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner: new LocalGitRunner() })
    expect(readFileSync(serverPath, "utf8")).toContain("server-before")
    expect(readFileSync(tuiPath, "utf8")).toContain("tui-before")
    expect(readdirSync(transactionRoot)).toEqual([])
  }, 45_000)

  test("partially restored before/after files remain retryable and recovery is idempotent", () => {
    const source = sourceFixture()
    const config = tempProject("alg-journal-retry-")
    sandboxes.push(config)
    const serverPath = join(config, "opencode.jsonc")
    const tuiPath = join(config, "tui.json")
    const serverBefore = Buffer.from('{ "plugin": ["server-before"] }\n')
    const tuiBefore = Buffer.from('{ "plugin": ["tui-before"] }\n')
    writeFileSync(serverPath, serverBefore)
    writeFileSync(tuiPath, tuiBefore)
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner: new LocalGitRunner(),
      faults: { afterLiveWrite(_path, index) { if (index === 1) throw new SimulatedManagerCrashError("retry crash") } },
    })).toThrow("retry crash")
    let failed = false
    expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, {
      runner: new LocalGitRunner(),
      link(existing, target) {
        if (!failed && String(target) === serverPath) {
          failed = true
          throw new Error("injected recovery no-clobber link failure")
        }
        linkSync(existing, target)
      },
    })).toThrow("injected recovery no-clobber link failure")
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
    runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner: new LocalGitRunner() })
    expect(readFileSync(serverPath)).toEqual(serverBefore)
    expect(readFileSync(tuiPath)).toEqual(tuiBefore)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
    expect(runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner: new LocalGitRunner() }).pending_journals).toEqual([])
  }, 45_000)

  test("receipt derivation CAS rejects a semantically equivalent rewrite before journal creation with zero live writes", () => {
    const source = sourceFixture()
    const config = tempProject("alg-receipt-derived-cas-")
    sandboxes.push(config)
    const initialRunner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner: initialRunner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const serverPath = join(config, "opencode.jsonc")
    const tuiPath = join(config, "tui.json")
    const serverBefore = readFileSync(serverPath)
    const tuiBefore = readFileSync(tuiPath)
    const parsed = JSON.parse(readFileSync(receiptPath, "utf8"))
    const rewritten = Buffer.from(JSON.stringify(parsed))
    const runner = new LocalGitRunner()
    let injected = false
    runner.onRequest = (request) => {
      if (!injected && isNpmRequest(request)) {
        injected = true
        writeFileSync(receiptPath, rewritten)
      }
    }
    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, { runner })).toThrow("derivation baseline")
    expect(readFileSync(receiptPath)).toEqual(rewritten)
    expect(readFileSync(serverPath)).toEqual(serverBefore)
    expect(readFileSync(tuiPath)).toEqual(tuiBefore)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
  }, 45_000)

  test("receipt CAS recheck after prewrite hook prevents every live write and removes the unneeded journal", () => {
    const source = sourceFixture()
    const config = tempProject("alg-receipt-prewrite-cas-")
    const excelRoot = tempProject("alg-receipt-prewrite-excel-")
    sandboxes.push(config, excelRoot)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const serverPath = join(config, "opencode.jsonc")
    const tuiPath = join(config, "tui.json")
    const serverBefore = readFileSync(serverPath)
    const tuiBefore = readFileSync(tuiPath)
    const rewritten = Buffer.from(JSON.stringify(JSON.parse(readFileSync(receiptPath, "utf8"))))
    let injected = false
    expect(() => runManager({ command: "update", configDir: config, source, enableCapability: "excel", excelRoot }, {
      runner,
      faults: { beforeLiveWrite() { if (!injected) { injected = true; writeFileSync(receiptPath, rewritten) } } },
    })).toThrow("derivation baseline")
    expect(readFileSync(receiptPath)).toEqual(rewritten)
    expect(readFileSync(serverPath)).toEqual(serverBefore)
    expect(readFileSync(tuiPath)).toEqual(tuiBefore)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
  }, 45_000)

  test.each(["config", "agent"] as const)("post-write %s mutation cannot commit the receipt and remains fail-closed", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-post-write-${variant}-`)
    sandboxes.push(config)
    const third = Buffer.from(`third-party-${variant}\n`)
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner: new LocalGitRunner(),
      faults: {
        afterLiveWrite(path, index) {
          if ((variant === "config" && index === 0) || (variant === "agent" && index === 2)) writeFileSync(path, third)
        },
      },
    })).toThrow(/rollback was incomplete|after-state/)
    const thirdPath = variant === "config" ? join(config, "opencode.jsonc") : join(config, "agents", "checker.md")
    expect(readFileSync(thirdPath)).toEqual(third)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
  }, 45_000)

  test("post-write valid receipt mutation rolls live files back without stale receipt overwrite", () => {
    const source = sourceFixture()
    const config = tempProject("alg-post-write-receipt-")
    const excelRoot = tempProject("alg-post-write-receipt-excel-")
    sandboxes.push(config, excelRoot)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const serverPath = join(config, "opencode.jsonc")
    const serverBefore = readFileSync(serverPath)
    const rewritten = Buffer.from(JSON.stringify(JSON.parse(readFileSync(receiptPath, "utf8"))))
    let injected = false
    expect(() => runManager({ command: "update", configDir: config, source, enableCapability: "excel", excelRoot }, {
      runner,
      faults: { afterLiveWrite() { if (!injected) { injected = true; writeFileSync(receiptPath, rewritten) } } },
    })).toThrow("derivation baseline")
    expect(readFileSync(receiptPath)).toEqual(rewritten)
    expect(readFileSync(serverPath)).toEqual(serverBefore)
    expect((parse(readFileSync(serverPath, "utf8")) as any).mcp?.alg_excel).toBeUndefined()
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
  }, 45_000)

  test("doctor recovers simulated crashes after config and agent writes", () => {
    for (const crashIndex of [0, 2]) {
      const source = sourceFixture()
      const config = tempProject(`alg-manager-crash-${crashIndex}-`)
      sandboxes.push(config)
      const serverPath = join(config, "opencode.jsonc")
      const tuiPath = join(config, "tui.json")
      const serverBefore = Buffer.from('{ "plugin": ["server-before"] }\n')
      const tuiBefore = Buffer.from('{ "plugin": ["tui-before"] }\n')
      writeFileSync(serverPath, serverBefore)
      writeFileSync(tuiPath, tuiBefore)
      expect(() => runManager({ command: "install", configDir: config, source }, {
        runner: new LocalGitRunner(),
        faults: {
          afterLiveWrite(_path, index) {
            if (index === crashIndex) throw new SimulatedManagerCrashError(`crash after ${index}`)
          },
        },
      })).toThrow(`crash after ${crashIndex}`)
      const pending = runManager({ command: "doctor", configDir: config }, { runner: new LocalGitRunner() })
      expect(pending.issues?.some((issue) => issue.code === "pending-journal")).toBe(true)
      expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
      runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner: new LocalGitRunner() })
      expect(readFileSync(serverPath)).toEqual(serverBefore)
      expect(readFileSync(tuiPath)).toEqual(tuiBefore)
      expect(existsSync(join(config, "agents", "checker.md"))).toBe(false)
      expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
    }
  }, 45_000)

  test("doctor finalizes a receipt-committed crash journal instead of rolling live files back", () => {
    const source = sourceFixture()
    const config = tempProject("alg-manager-receipt-crash-")
    sandboxes.push(config)
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner: new LocalGitRunner(),
      faults: {
        afterReceiptCommit() {
          throw new SimulatedManagerCrashError("crash after receipt commit")
        },
      },
    })).toThrow("crash after receipt commit")
    const committed = receipt(config)
    expect(committed.installed).toBe(true)
    expect((parse(readFileSync(join(config, "opencode.jsonc"), "utf8")) as any).plugin).toContain(committed.server_registration.spec)
    const pending = runManager({ command: "doctor", configDir: config }, { runner: new LocalGitRunner() })
    expect(pending.issues?.some((issue) => issue.code === "pending-journal")).toBe(true)
    const repaired = runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner: new LocalGitRunner() })
    expect(repaired.ok).toBe(true)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
    expect(receipt(config).active_generation).toBe(committed.active_generation)
  }, 30_000)

  test("ordinary journal-phase faults roll every live file back and remove the journal", () => {
    for (const phase of ["writing", "live-written"] as const) {
      const source = sourceFixture()
      const config = tempProject(`alg-manager-phase-${phase}-`)
      sandboxes.push(config)
      const serverPath = join(config, "opencode.jsonc")
      const before = Buffer.from('{ "plugin": ["unchanged"] }\n')
      writeFileSync(serverPath, before)
      expect(() => runManager({ command: "install", configDir: config, source }, {
        runner: new LocalGitRunner(),
        faults: {
          afterJournalPhase(observed) {
            if (observed === phase) throw new Error(`ordinary ${phase} failure`)
          },
        },
      })).toThrow(`ordinary ${phase} failure`)
      expect(readFileSync(serverPath)).toEqual(before)
      expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
      expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
    }
  }, 45_000)

  test("doctor reports release and managed-agent drift and JSON output stays bounded", () => {
    const source = sourceFixture()
    const config = tempProject("alg-manager-doctor-drift-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const healthy = runManager({ command: "doctor", configDir: config }, { runner })
    expect(healthy.ok).toBe(true)
    expect(Buffer.byteLength(serializeManagerJson(healthy))).toBeLessThanOrEqual(MANAGER_JSON_MAX_BYTES)
    const state = receipt(config)
    const activeRoot = state.generations.find((item) => item.id === state.active_generation)!.package_root
    const dependencyDrift = join(activeRoot, "node_modules", "zod", "injected.js")
    writeFileSync(dependencyDrift, "dependency drift\n")
    const dependencyDoctor = runManager({ command: "doctor", configDir: config }, { runner })
    expect(dependencyDoctor.ok).toBe(false)
    expect(dependencyDoctor.issues?.some((issue) => issue.code === "active-release-invalid")).toBe(true)
    rmSync(dependencyDrift)
    expect(runManager({ command: "doctor", configDir: config }, { runner }).ok).toBe(true)
    writeFileSync(join(activeRoot, "src", "index.ts"), "drifted runtime\n")
    writeFileSync(join(config, "agents", "explorer.md"), "drifted agent\n")
    const drifted = runManager({ command: "doctor", configDir: config }, { runner })
    expect(drifted.ok).toBe(false)
    expect(drifted.issues?.some((issue) => issue.code === "active-release-invalid")).toBe(true)
    expect(drifted.issues?.some((issue) => issue.code === "agent-drift")).toBe(true)
    expect(drifted.agent_status?.find((item) => item.name === "explorer.md")?.status).toBe("drift")
    expect(Buffer.byteLength(serializeManagerJson(drifted))).toBeLessThanOrEqual(MANAGER_JSON_MAX_BYTES)
    expect(() => serializeManagerJson({ value: "x".repeat(MANAGER_JSON_MAX_BYTES) })).toThrow("exceeds")
  }, 30_000)

  test("receipt claim/publish races preserve third-party bytes and crash recovery is deterministic", () => {
    const source = sourceFixture()
    const config = tempProject("alg-receipt-claim-races-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const transactionRoot = join(config, ".opencode-alg", "transactions")
    const before = readFileSync(receiptPath)
    const third = Buffer.from('{"third_party":true}\n')

    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
      runner,
      faults: { beforeReceiptCommit(path) { writeFileSync(path, third) } },
    })).toThrow("derivation baseline")
    expect(readFileSync(receiptPath)).toEqual(third)
    expect(readdirSync(transactionRoot)).toEqual([])
    writeFileSync(receiptPath, before)

    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
      runner,
      faults: { afterReceiptClaim(path) { writeFileSync(path, third) } },
    })).toThrow("Third-party receipt was preserved")
    expect(readFileSync(receiptPath)).toEqual(third)
    expect(readdirSync(transactionRoot)).toHaveLength(1)
    rmSync(receiptPath)
    runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })
    expect(readFileSync(receiptPath)).toEqual(before)

    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
      runner,
      faults: { afterReceiptClaim() { throw new SimulatedManagerCrashError("claim crash") } },
    })).toThrow("claim crash")
    expect(existsSync(receiptPath)).toBe(false)
    expect(readdirSync(transactionRoot)).toHaveLength(1)
    runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })
    expect(readFileSync(receiptPath)).toEqual(before)

    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
      runner,
      faults: { afterReceiptPublish() { throw new SimulatedManagerCrashError("publish crash") } },
    })).toThrow("publish crash")
    expect(receipt(config).installed).toBe(true)
    runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })
    expect(readdirSync(transactionRoot)).toEqual([])
  }, 60_000)

  test.each(["different", "same-bytes"] as const)("pre-created %s claim is never overwritten or deleted and blocks recovery", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-precreated-claim-${variant}-`)
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const transactionRoot = join(config, ".opencode-alg", "transactions")
    const before = readFileSync(receiptPath)
    const foreign = variant === "same-bytes" ? before : Buffer.from("foreign claim bytes\n")
    let foreignClaim = ""
    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
      runner,
      faults: {
        afterJournalPhase(phase) {
          if (phase !== "live-written" || foreignClaim) return
          const journalPath = join(transactionRoot, readdirSync(transactionRoot)[0]!)
          foreignClaim = JSON.parse(readFileSync(journalPath, "utf8")).receipt_claim
          writeFileSync(foreignClaim, foreign, { flag: "wx" })
        },
      },
    })).toThrow("already occupied")
    expect(readFileSync(receiptPath)).toEqual(before)
    expect(readFileSync(foreignClaim)).toEqual(foreign)
    const journalPath = join(transactionRoot, readdirSync(transactionRoot)[0]!)
    const journalBeforeRepair = readFileSync(journalPath)
    expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })).toThrow(/auxiliary bytes|claim ownership is ambiguous/)
    expect(readFileSync(foreignClaim)).toEqual(foreign)
    expect(readFileSync(journalPath)).toEqual(journalBeforeRepair)
    rmSync(foreignClaim)
    runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })
    expect(readFileSync(receiptPath)).toEqual(before)
  }, 60_000)

  test("claim hard-link failure rolls back without receipt loss and receipt-linked crash is recoverable", () => {
    const source = sourceFixture()
    const config = tempProject("alg-claim-link-failure-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const before = readFileSync(receiptPath)
    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
      runner,
      link(existing, target) {
        if (String(target).includes(".alg-claim-")) throw new Error("injected claim link failure")
        linkSync(existing, target)
      },
    })).toThrow("injected claim link failure")
    expect(readFileSync(receiptPath)).toEqual(before)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])

    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
      runner,
      faults: { afterJournalPhase(phase) { if (phase === "receipt-linked") throw new SimulatedManagerCrashError("linked crash") } },
    })).toThrow("linked crash")
    expect(readFileSync(receiptPath)).toEqual(before)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
    runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })
    expect(readFileSync(receiptPath)).toEqual(before)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
  }, 60_000)

  test("post-publication claim replacement is preserved and never used for receipt restoration or deletion", () => {
    const source = sourceFixture()
    const config = tempProject("alg-claim-replacement-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const transactionRoot = join(config, ".opencode-alg", "transactions")
    const oldBytes = readFileSync(receiptPath)
    let claimPath = ""
    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
      runner,
      faults: {
        afterReceiptPublish() {
          const journalPath = join(transactionRoot, readdirSync(transactionRoot)[0]!)
          claimPath = JSON.parse(readFileSync(journalPath, "utf8")).receipt_claim
          rmSync(claimPath)
          writeFileSync(claimPath, oldBytes, { flag: "wx" })
        },
      },
    })).toThrow(/identity|auxiliary cleanup was incomplete/)
    expect(readFileSync(claimPath)).toEqual(oldBytes)
    expect(readdirSync(transactionRoot)).toHaveLength(1)
    expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })).toThrow("auxiliary identity differs")
    expect(readFileSync(claimPath)).toEqual(oldBytes)
    rmSync(claimPath)
    runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })
    expect(readdirSync(transactionRoot)).toEqual([])
  }, 60_000)

  test("same-byte receipt-after replacement is third state and cannot trigger restore or cleanup", () => {
    const source = sourceFixture()
    const config = tempProject("alg-receipt-after-identity-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    let replacement = Buffer.alloc(0)
    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
      runner,
      faults: { afterReceiptPublish(path) {
        replacement = readFileSync(path)
        rmSync(path)
        writeFileSync(path, replacement, { flag: "wx" })
      } },
    })).toThrow(/could not be safely restored|identity/)
    expect(readFileSync(receiptPath)).toEqual(replacement)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
    expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })).toThrow("not the recorded prepared identity")
    expect(readFileSync(receiptPath)).toEqual(replacement)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
  }, 60_000)

  test.each(["config", "agent"] as const)("%s replacement between live claim and unlink is preserved", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-live-claim-race-${variant}-`)
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    advanceToV02(source)
    const target = variant === "config" ? join(config, "opencode.jsonc") : join(config, "agents", "explorer.md")
    const third = Buffer.from(`third claim race ${variant}\n`)
    expect(() => runManager({ command: "update", configDir: config, source }, {
      runner,
      faults: { afterLiveClaim(path) { if (path === target) { rmSync(path); writeFileSync(path, third, { flag: "wx" }) } } },
    })).toThrow(/changed before claim unlink|Third-party live file|rollback was incomplete/)
    expect(readFileSync(target)).toEqual(third)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
  }, 60_000)

  test.each(["receipt", "unchanged-config", "exact-target-agent", "skipped-custom-agent"] as const)("%s same-byte identity replacement after derivation fails with zero live writes", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-derivation-identity-${variant}-`)
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    mkdirSync(join(config, "agents"))
    writeFileSync(join(config, "agents", "checker.md"), "custom checker before install\n")
    runManager({ command: "install", configDir: config, source }, { runner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const serverPath = join(config, "opencode.jsonc")
    const tuiPath = join(config, "tui.json")
    const agents = ["checker.md", "explorer.md", "implementer.md", "orchestrator.md", "researcher.md"]
      .map((name) => join(config, "agents", name))
    // Skip releases ownership of the exact managed agents and therefore forces
    // a receipt transaction for the otherwise-active generation. Configs, exact
    // agents, and the already-custom checker remain unchanged read-set plans.
    const target = variant === "receipt"
      ? receiptPath
      : variant === "unchanged-config"
        ? tuiPath
        : join(config, "agents", variant === "exact-target-agent" ? "explorer.md" : "checker.md")
    const expectedKind = variant === "receipt" ? "receipt" : variant === "unchanged-config" ? "config" : "agent"
    const snapshots = new Map([receiptPath, serverPath, tuiPath, ...agents].map((path) => [path, readFileSync(path)]))
    let replaced = false
    let writes = 0
    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
      runner,
      faults: {
        afterPlanning(kind, path) {
          if (replaced || kind !== expectedKind || path !== target) return
          const bytes = readFileSync(path)
          rmSync(path)
          writeFileSync(path, bytes, { flag: "wx" })
          replaced = true
        },
        beforeLiveWrite() { writes++ },
      },
    })).toThrow(/derivation baseline|identity|Concurrent/)
    expect(replaced).toBe(true)
    expect(writes).toBe(0)
    for (const [path, bytes] of snapshots) expect(readFileSync(path), path).toEqual(bytes)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
  }, 90_000)

  test.each(["config", "agent"] as const)("occupied %s claim path is preserved before any public live unlink", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-live-occupied-claim-${variant}-`)
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    advanceToV02(source)
    const target = variant === "config" ? join(config, "opencode.jsonc") : join(config, "agents", "explorer.md")
    const before = readFileSync(target)
    const foreign = Buffer.from(`foreign live claim ${variant}\n`)
    let claim = ""
    expect(() => runManager({ command: "update", configDir: config, source }, {
      runner,
      faults: { afterJournalPhase(phase) {
        if (phase !== "writing" || claim) return
        const root = join(config, ".opencode-alg", "transactions")
        const journal = JSON.parse(readFileSync(join(root, readdirSync(root)[0]!), "utf8"))
        claim = journal.files.find((file: any) => file.path === target).claim
        writeFileSync(claim, foreign, { flag: "wx" })
      } },
    })).toThrow(/EEXIST|ambiguous|rollback was incomplete/)
    expect(readFileSync(target)).toEqual(before)
    expect(readFileSync(claim)).toEqual(foreign)
  }, 60_000)

  test.each(["config", "agent"] as const)("occupied %s public destination before publish is never overwritten", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-live-occupied-public-${variant}-`)
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    advanceToV02(source)
    const target = variant === "config" ? join(config, "opencode.jsonc") : join(config, "agents", "explorer.md")
    const third = Buffer.from(`occupied public ${variant}\n`)
    expect(() => runManager({ command: "update", configDir: config, source }, {
      runner,
      faults: { afterLiveUnlink(path) { if (path === target) writeFileSync(path, third, { flag: "wx" }) } },
    })).toThrow(/EEXIST|Third-party live file|rollback was incomplete/)
    expect(readFileSync(target)).toEqual(third)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
  }, 60_000)

  test.each(["config", "agent"] as const)("%s delete race and recovery link race preserve third-party bytes", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-live-delete-race-${variant}-`)
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const target = variant === "config" ? join(config, "opencode.jsonc") : join(config, "agents", "explorer.md")
    const third = Buffer.from(`delete race ${variant}\n`)
    expect(() => runManager({ command: "uninstall", configDir: config, removeAgents: true }, {
      runner,
      faults: { afterLiveUnlink(path) { if (path === target) writeFileSync(path, third, { flag: "wx" }) } },
    })).toThrow(/committed state|Third-party live file|rollback was incomplete/)
    expect(readFileSync(target)).toEqual(third)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
  }, 60_000)

  test.each(["config", "agent"] as const)("%s recovery create-if-absent race preserves the racer and journal", (variant) => {
    const source = sourceFixture()
    const config = tempProject(`alg-live-recovery-race-${variant}-`)
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    advanceToV02(source)
    const target = variant === "config" ? join(config, "opencode.jsonc") : join(config, "agents", "explorer.md")
    expect(() => runManager({ command: "update", configDir: config, source }, {
      runner,
      faults: { afterLiveWrite(path) { if (path === target) throw new SimulatedManagerCrashError("recovery race fixture") } },
    })).toThrow("recovery race fixture")
    const third = Buffer.from(`recovery racer ${variant}\n`)
    let raced = false
    expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, {
      runner,
      link(existing, destination) {
        if (!raced && String(destination) === target) {
          raced = true
          writeFileSync(target, third, { flag: "wx" })
        }
        linkSync(existing, destination)
      },
    })).toThrow(/EEXIST|link/)
    expect(readFileSync(target)).toEqual(third)
    expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
  }, 60_000)

  test("forged journal agent paths cannot delete custom, nested, unknown, or case-variant files", () => {
    const source = sourceFixture()
    const config = tempProject("alg-forged-journal-agent-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner,
      faults: { afterLiveWrite(_path, index) { if (index === 0) throw new SimulatedManagerCrashError("agent journal fixture") } },
    })).toThrow("agent journal fixture")
    const transactionRoot = join(config, ".opencode-alg", "transactions")
    const journalPath = join(transactionRoot, readdirSync(transactionRoot)[0]!)
    const original = JSON.parse(readFileSync(journalPath, "utf8"))
    for (const relativePath of ["custom.md", join("nested", "custom.md"), "unknown.md", "Checker.md"]) {
      const target = join(config, "agents", relativePath)
      mkdirSync(dirname(target), { recursive: true })
      const custom = Buffer.from(`custom:${relativePath}\n`)
      writeFileSync(target, custom)
      const forged = structuredClone(original)
      forged.files = [{ ...original.files[0], path: target, kind: "agent", before_hash: null, before_identity: null, claim: null, claim_identity: null, after_hash: createHash("sha256").update(custom).digest("hex"), backup: null }]
      writeFileSync(journalPath, `${JSON.stringify(forged, null, 2)}\n`)
      const journalBytes = readFileSync(journalPath)
      expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner }), relativePath).toThrow(/non-bundled agent path|revision does not extend/)
      expect(readFileSync(target), relativePath).toEqual(custom)
      expect(readFileSync(journalPath), relativePath).toEqual(journalBytes)
    }
  }, 60_000)

  test("forged receipt auxiliary prefix collisions and other-transaction paths are never deleted", () => {
    const source = sourceFixture()
    const config = tempProject("alg-forged-journal-aux-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
      runner,
      faults: { afterReceiptClaim() { throw new SimulatedManagerCrashError("aux fixture") } },
    })).toThrow("aux fixture")
    const managerRoot = join(config, ".opencode-alg")
    const transactionRoot = join(managerRoot, "transactions")
    const journalPath = join(transactionRoot, readdirSync(transactionRoot)[0]!)
    const originalBytes = readFileSync(journalPath)
    const original = JSON.parse(originalBytes.toString("utf8"))
    for (const field of ["receipt_backup", "receipt_claim", "receipt_prepared"] as const) {
      const forgedPath = join(managerRoot, `${field}.alg-prefix-${randomUUID()}`)
      const bytes = Buffer.from(`foreign ${field}\n`)
      writeFileSync(forgedPath, bytes)
      const stat = lstatSync(forgedPath, { bigint: true })
      const forged = structuredClone(original)
      forged[field] = forgedPath
      forged[`${field}_identity`] = { dev: stat.dev.toString(), ino: stat.ino.toString() }
      writeFileSync(journalPath, `${JSON.stringify(forged, null, 2)}\n`)
      const journalBytes = readFileSync(journalPath)
      expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner }), field).toThrow(/transaction-exact|backup\/claim paths|revision does not extend/)
      expect(readFileSync(forgedPath), field).toEqual(bytes)
      expect(readFileSync(journalPath), field).toEqual(journalBytes)
    }
    writeFileSync(journalPath, originalBytes)
    runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })
    expect(readdirSync(transactionRoot)).toEqual([])
  }, 60_000)

  test("occupied initial journal publication is no-clobber and preserves foreign bytes", () => {
    const source = sourceFixture()
    const config = tempProject("alg-journal-initial-occupied-")
    sandboxes.push(config)
    const foreign = Buffer.from("foreign initial journal\n")
    let occupied = ""
    expect(() => runManager({ command: "install", configDir: config, source }, {
      runner: new LocalGitRunner(),
      link(existing, target) {
        const candidate = String(target)
        if (!occupied && dirname(candidate) === join(config, ".opencode-alg", "transactions") && /^[0-9a-f-]{36}\.json$/i.test(basename(candidate))) {
          occupied = candidate
          writeFileSync(candidate, foreign, { flag: "wx" })
        }
        linkSync(existing, target)
      },
    })).toThrow("Journal no-clobber publication failed")
    expect(readFileSync(occupied)).toEqual(foreign)
    expect(existsSync(join(config, ".opencode-alg", "receipt.json"))).toBe(false)
    expect(existsSync(join(config, "opencode.jsonc"))).toBe(false)
  }, 45_000)

  test("occupied journal revision and same-byte marker replacement preserve journal evidence", () => {
    for (const variant of ["occupied", "same-byte-replacement"] as const) {
      const source = sourceFixture()
      const config = tempProject(`alg-journal-revision-${variant}-`)
      sandboxes.push(config)
      const runner = new LocalGitRunner()
      runManager({ command: "install", configDir: config, source }, { runner })
      const receiptBefore = readFileSync(join(config, ".opencode-alg", "receipt.json"))
      const serverBefore = readFileSync(join(config, "opencode.jsonc"))
      let foreignPath = ""
      let foreignBytes = Buffer.alloc(0)
      expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
        runner,
        ...(variant === "occupied" ? {
          link(existing: Parameters<typeof linkSync>[0], target: Parameters<typeof linkSync>[1]) {
            const candidate = String(target)
            if (!foreignPath && /[\\/]\.journal-.*\.revision-001\.json$/i.test(candidate)) {
              foreignPath = candidate
              foreignBytes = Buffer.from("foreign revision marker\n")
              writeFileSync(candidate, foreignBytes, { flag: "wx" })
            }
            linkSync(existing, target)
          },
        } : {
          faults: { afterJournalPhase(phase: any) {
            if (phase !== "writing" || foreignPath) return
            const managerRoot = join(config, ".opencode-alg")
            const name = readdirSync(managerRoot).find((item) => /^\.journal-.*\.revision-001\.json$/i.test(item))!
            foreignPath = join(managerRoot, name)
            foreignBytes = readFileSync(foreignPath)
            rmSync(foreignPath)
            writeFileSync(foreignPath, foreignBytes, { flag: "wx" })
          } },
        }),
      })).toThrow(/Journal publication|Journal no-clobber/)
      expect(readFileSync(foreignPath)).toEqual(foreignBytes)
      expect(readFileSync(join(config, ".opencode-alg", "receipt.json"))).toEqual(receiptBefore)
      expect(readFileSync(join(config, "opencode.jsonc"))).toEqual(serverBefore)
      expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
    }
  }, 60_000)

  test("journal cleanup and recovery same-byte replacements are preserved by identity", () => {
    for (const variant of ["commit-cleanup", "recovery-read"] as const) {
      const source = sourceFixture()
      const config = tempProject(`alg-journal-replacement-${variant}-`)
      sandboxes.push(config)
      const runner = new LocalGitRunner()
      runManager({ command: "install", configDir: config, source }, { runner })
      let replacementPath = ""
      let replacementBytes = Buffer.alloc(0)
      if (variant === "commit-cleanup") {
        expect(() => runManager({ command: "update", configDir: config, source, agentPolicy: "skip" }, {
          runner,
          faults: { beforeJournalCleanup(path) {
            if (replacementPath) return
            replacementPath = path
            replacementBytes = readFileSync(path)
            rmSync(path)
            writeFileSync(path, replacementBytes, { flag: "wx" })
          } },
        })).toThrow(/cleanup was incomplete|Journal artifact identity/)
      } else {
        advanceToV02(source)
        expect(() => runManager({ command: "update", configDir: config, source }, {
          runner,
          faults: { afterLiveWrite(_path, index) { if (index === 0) throw new SimulatedManagerCrashError("journal recovery replacement fixture") } },
        })).toThrow("journal recovery replacement fixture")
        const liveBeforeRepair = readFileSync(join(config, "opencode.jsonc"))
        expect(() => runManager({ command: "doctor", configDir: config, repairJournal: true }, {
          runner,
          faults: { afterJournalRead(path) {
            replacementPath = path
            replacementBytes = readFileSync(path)
            rmSync(path)
            writeFileSync(path, replacementBytes, { flag: "wx" })
          } },
        })).toThrow("Journal artifact identity or bytes changed")
        expect(readFileSync(join(config, "opencode.jsonc"))).toEqual(liveBeforeRepair)
      }
      expect(readFileSync(replacementPath)).toEqual(replacementBytes)
      expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
    }
  }, 60_000)

  test("expected-absent and post-publication races never overwrite third-party receipt/config/agent bytes", () => {
    for (const variant of ["absent", "config", "agent"] as const) {
      const source = sourceFixture()
      const config = tempProject(`alg-publish-race-${variant}-`)
      sandboxes.push(config)
      const third = Buffer.from(`third-party-${variant}\n`)
      const receiptPath = join(config, ".opencode-alg", "receipt.json")
      expect(() => runManager({ command: "install", configDir: config, source }, {
        runner: new LocalGitRunner(),
        faults: variant === "absent"
          ? { afterReceiptClaim(path) { writeFileSync(path, third) } }
          : { afterReceiptPublish() {
            const target = variant === "config" ? join(config, "opencode.jsonc") : join(config, "agents", "checker.md")
            writeFileSync(target, third)
          } },
      })).toThrow()
      const target = variant === "absent" ? receiptPath : variant === "config" ? join(config, "opencode.jsonc") : join(config, "agents", "checker.md")
      expect(readFileSync(target)).toEqual(third)
      if (variant === "absent") expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toEqual([])
      else expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
    }
  }, 60_000)

  test("restart acknowledgement uses recoverable claim/publish journals and preserves races", () => {
    for (const boundary of ["claim", "publish", "race"] as const) {
      const source = sourceFixture()
      const config = tempProject(`alg-ack-${boundary}-`)
      sandboxes.push(config)
      const runner = new LocalGitRunner()
      runManager({ command: "install", configDir: config, source }, { runner })
      const receiptPath = join(config, ".opencode-alg", "receipt.json")
      const before = readFileSync(receiptPath)
      const third = Buffer.from('{"ack_racer":true}\n')
      expect(() => runManager({ command: "doctor", configDir: config, ackRestart: true }, {
        runner,
        faults: boundary === "claim"
          ? { afterReceiptClaim() { throw new SimulatedManagerCrashError("ack claim crash") } }
          : boundary === "publish"
            ? { afterReceiptPublish() { throw new SimulatedManagerCrashError("ack publish crash") } }
            : { afterReceiptClaim(path) { writeFileSync(path, third) } },
      })).toThrow()
      expect(readdirSync(join(config, ".opencode-alg", "transactions"))).toHaveLength(1)
      if (boundary === "race") {
        expect(readFileSync(receiptPath)).toEqual(third)
        rmSync(receiptPath)
      }
      runManager({ command: "doctor", configDir: config, repairJournal: true }, { runner })
      if (boundary === "publish") expect(receipt(config).restart_required.pending).toBe(false)
      else expect(readFileSync(receiptPath)).toEqual(before)
    }
  }, 60_000)

  test("Excel root changes stage a fresh environment and failed staging preserves all active bytes", () => {
    const source = sourceFixture()
    const config = tempProject("alg-excel-env-transaction-")
    const rootOne = tempProject("alg-excel-root-one-")
    const rootTwo = tempProject("alg-excel-root-two-")
    sandboxes.push(config, rootOne, rootTwo)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source, enableCapability: "excel", excelRoot: rootOne }, { runner })
    const beforeReceipt = readFileSync(join(config, ".opencode-alg", "receipt.json"))
    const beforeConfig = readFileSync(join(config, "opencode.jsonc"))
    const first = receipt(config).generations.find((item) => item.id === receipt(config).active_generation)!.capabilities!.excel
    const firstInterpreter = first.managed_config!.command[0]
    const firstBytes = readFileSync(firstInterpreter)
    runner.failUvSync = true
    expect(() => runManager({ command: "update", configDir: config, source, enableCapability: "excel", excelRoot: rootTwo }, { runner })).toThrow("injected uv sync failure")
    expect(readFileSync(join(config, ".opencode-alg", "receipt.json"))).toEqual(beforeReceipt)
    expect(readFileSync(join(config, "opencode.jsonc"))).toEqual(beforeConfig)
    expect(readFileSync(firstInterpreter)).toEqual(firstBytes)
    runner.failUvSync = false
    runManager({ command: "update", configDir: config, source, enableCapability: "excel", excelRoot: rootTwo }, { runner })
    const second = receipt(config).generations.find((item) => item.id === receipt(config).active_generation)!.capabilities!.excel
    expect(second.env_path).not.toBe(first.env_path)
    expect(second.root).toBe(resolve(rootTwo))
    expect(readFileSync(firstInterpreter)).toEqual(firstBytes)
  }, 60_000)

  test("same-generation no-op rejects active origin, Git, dependency, environment, and managed-agent drift", () => {
    const source = sourceFixture()
    const config = tempProject("alg-active-noop-drift-")
    const excelRoot = tempProject("alg-active-noop-excel-")
    sandboxes.push(config, excelRoot)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source, enableCapability: "excel", excelRoot }, { runner })
    const state = receipt(config)
    const active = state.generations.find((item) => item.id === state.active_generation)!
    const noOp = () => runManager({ command: "install", configDir: config, source }, { runner })

    const origin = git(active.package_root, "config", "--get", "remote.origin.url")
    git(active.package_root, "remote", "set-url", "origin", "https://example.invalid/racer.git")
    expect(noOp).toThrow("origin")
    git(active.package_root, "remote", "set-url", "origin", origin)

    const packagePath = join(active.package_root, "package.json")
    const packageBytes = readFileSync(packagePath)
    writeFileSync(packagePath, `${packageBytes.toString("utf8")} `)
    expect(noOp).toThrow()
    writeFileSync(packagePath, packageBytes)

    for (const relativePath of ["package-lock.json", join("src", "index.ts")]) {
      const path = join(active.package_root, relativePath)
      const bytes = readFileSync(path)
      writeFileSync(path, Buffer.concat([bytes, Buffer.from("\nactive drift\n")]))
      expect(noOp).toThrow()
      writeFileSync(path, bytes)
    }

    const dependencyPath = join(active.package_root, "node_modules", "zod", "noop-drift.js")
    writeFileSync(dependencyPath, "dependency drift\n")
    expect(noOp).toThrow("identity")
    rmSync(dependencyPath)

    const interpreter = active.capabilities!.excel.managed_config!.command[0]
    const interpreterBytes = readFileSync(interpreter)
    writeFileSync(interpreter, "environment drift\n")
    expect(noOp).toThrow("environment identity")
    writeFileSync(interpreter, interpreterBytes)

    const agentPath = join(config, "agents", "checker.md")
    const agentBytes = readFileSync(agentPath)
    writeFileSync(agentPath, "agent drift\n")
    expect(noOp).toThrow("managed agent")
    writeFileSync(agentPath, agentBytes)
    expect(noOp().changed).toBe(false)
  }, 60_000)

  test("agent directory and direct targets reject junction/symlink redirection before managed I/O", () => {
    const source = sourceFixture()
    const outside = tempProject("alg-agent-redirection-outside-")
    const config = tempProject("alg-agent-redirection-config-")
    sandboxes.push(config, outside)
    writeFileSync(join(outside, "marker"), "outside\n")
    symlinkSync(outside, join(config, "agents"), process.platform === "win32" ? "junction" : "dir")
    expect(() => runManager({ command: "install", configDir: config, source }, { runner: new LocalGitRunner() })).toThrow(/agents directory is redirected|escapes its trusted root/)
    expect(readFileSync(join(outside, "marker"), "utf8")).toBe("outside\n")
    rmSync(join(config, "agents"), { recursive: true, force: true })
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    const target = join(config, "agents", "checker.md")
    const externalFile = join(outside, "external.md")
    writeFileSync(externalFile, "external\n")
    rmSync(target)
    symlinkSync(process.platform === "win32" ? outside : externalFile, target, process.platform === "win32" ? "junction" : "file")
    expect(() => runManager({ command: "install", configDir: config, source }, { runner })).toThrow(/agent target is redirected|escapes its trusted root/)
    expect(readFileSync(externalFile, "utf8")).toBe("external\n")
  }, 60_000)

  test("rollback blocks an unsafe durable-state compatibility declaration before config writes", () => {
    const source = sourceFixture()
    const config = tempProject("alg-manager-unsafe-rollback-")
    sandboxes.push(config)
    const runner = new LocalGitRunner()
    runManager({ command: "install", configDir: config, source }, { runner })
    advanceToV02(source)
    runManager({ command: "update", configDir: config, source }, { runner })
    const receiptPath = join(config, ".opencode-alg", "receipt.json")
    const state = JSON.parse(readFileSync(receiptPath, "utf8"))
    state.generations.find((item: any) => item.version === "0.1.0").durable_state.compatible_package_versions = ["0.1.0"]
    writeFileSync(receiptPath, `${JSON.stringify(state, null, 2)}\n`)
    const serverBefore = readFileSync(join(config, "opencode.jsonc"))
    expect(() => runManager({ command: "rollback", configDir: config }, { runner })).toThrow("durable-state compatibility")
    expect(readFileSync(join(config, "opencode.jsonc"))).toEqual(serverBefore)
  }, 30_000)
})

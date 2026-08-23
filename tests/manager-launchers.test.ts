import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import { parseManagerArgs } from "../scripts/manager-cli.ts"
import { removeProject, tempProject } from "./helpers.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const sandboxes: string[] = []

function sandbox(label: string): string {
  const path = tempProject(label)
  sandboxes.push(path)
  return path
}

function environmentWithPath(paths: string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"))
  const value = [...paths, process.env.PATH ?? process.env.Path ?? ""].join(process.platform === "win32" ? ";" : ":")
  return { ...env, ...extra, [process.platform === "win32" ? "Path" : "PATH"]: value }
}

function environmentWithOnlyPath(paths: string[]): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"))
  return { ...env, [process.platform === "win32" ? "Path" : "PATH"]: paths.join(process.platform === "win32" ? ";" : ":") }
}

function whereExecutable(name: string): string | undefined {
  const command = process.platform === "win32" ? "where.exe" : "which"
  const result = spawnSync(command, [name], { encoding: "utf8", shell: false, windowsHide: true })
  return result.status === 0 ? result.stdout.trim().split(/\r?\n/)[0] : undefined
}

function gitSh(): string | undefined {
  const result = spawnSync("git", ["--exec-path"], { encoding: "utf8", shell: false, windowsHide: true })
  if (result.status !== 0) return
  const candidate = resolve(result.stdout.trim(), "..", "..", "..", "bin", process.platform === "win32" ? "sh.exe" : "sh")
  return existsSync(candidate) ? candidate : process.platform !== "win32" ? "sh" : undefined
}

const PWSH_AVAILABLE = (() => {
  const result = spawnSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], { encoding: "utf8", shell: false, windowsHide: true })
  return !result.error && result.status === 0
})()
const POSIX_SHELL = gitSh()
const NODE_FALLBACK = process.platform === "win32"
  ? { node: whereExecutable("node.exe"), git: whereExecutable("git.exe"), pwsh: whereExecutable("pwsh.exe") }
  : { node: undefined, git: undefined, pwsh: undefined }
const powershellTest = PWSH_AVAILABLE ? test : test.skip
const posixTest = POSIX_SHELL ? test : test.skip
const nodeFallbackTest = process.platform === "win32" && NODE_FALLBACK.node && NODE_FALLBACK.git && NODE_FALLBACK.pwsh ? test : test.skip

function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", shell: false, windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

function setVersion(root: string, version: string): void {
  for (const name of ["package.json", "package-lock.json"]) {
    const path = join(root, name)
    const value = JSON.parse(readFileSync(path, "utf8"))
    value.version = version
    if (name === "package-lock.json") value.packages[""].version = version
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
  }
}

function lifecycleSource(): string {
  const root = sandbox("alg launcher lifecycle source with spaces-")
  const source = join(root, "source checkout")
  mkdirSync(source)
  for (const name of ["src", "agents", "templates", "scripts", "capabilities"]) cpSync(join(ROOT, name), join(source, name), { recursive: true })
  for (const name of ["package.json", "package-lock.json", ".gitignore", ".gitattributes"]) cpSync(join(ROOT, name), join(source, name))
  setVersion(source, "0.1.0")
  const pkg = JSON.parse(readFileSync(join(source, "package.json"), "utf8"))
  pkg.dependencies = {}
  pkg.devDependencies = {}
  writeFileSync(join(source, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`)
  const lock = JSON.parse(readFileSync(join(source, "package-lock.json"), "utf8"))
  lock.packages = { "": { ...lock.packages[""], dependencies: {}, devDependencies: {} } }
  writeFileSync(join(source, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`)
  git(source, "init", "-b", "main")
  git(source, "add", ".")
  git(source, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", "v0.1 launcher")
  git(source, "tag", "v0.1.0")
  return source
}

function advanceLifecycleSource(source: string): void {
  setVersion(source, "0.2.0")
  writeFileSync(join(source, "agents", "explorer.md"), `${readFileSync(join(source, "agents", "explorer.md"), "utf8")}\n<!-- launcher v0.2 -->\n`)
  git(source, "add", "package.json", "package-lock.json", "agents/explorer.md")
  git(source, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", "v0.2 launcher")
  git(source, "tag", "v0.2.0")
}

function lifecycleArgs(config: string, install: string, source: string): string[][] {
  return [
    ["install", "--config-dir", config, "--install-root", install, "--source", source, "--tag", "v0.1.0", "--json"],
    ["update", "--config-dir", config, "--install-root", install, "--source", source, "--tag", "v0.2.0", "--agents", "skip", "--json"],
    ["rollback", "--config-dir", config, "--install-root", install, "--json"],
    ["doctor", "--config-dir", config, "--install-root", install, "--json"],
    ["uninstall", "--config-dir", config, "--install-root", install, "--json"],
  ]
}

function runLifecycle(
  invoke: (args: string[], env: NodeJS.ProcessEnv) => ReturnType<typeof spawnSync>,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const source = lifecycleSource()
  const config = sandbox("alg launcher lifecycle config with spaces-")
  const install = join(sandbox("alg launcher lifecycle install root-"), "managed install with spaces")
  const commands = lifecycleArgs(config, install, source)
  for (let index = 0; index < commands.length; index++) {
    if (index === 1) advanceLifecycleSource(source)
    const result = invoke(commands[index]!, env)
    expect({ status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) }).toMatchObject({ status: 0 })
    expect(result.stderr).toBe("")
    const output = JSON.parse(String(result.stdout).trim())
    expect(output.command).toBe(commands[index]![0])
    expect(Buffer.byteLength(String(result.stdout))).toBeLessThan(256 * 1024)
    const state = JSON.parse(readFileSync(join(config, ".opencode-alg", "receipt.json"), "utf8"))
    for (const generation of state.generations) {
      expect(generation.production_dependencies?.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(generation.production_dependencies?.files).toBe(0)
      expect(generation.production_dependencies?.bytes).toBe(0)
    }
    if (index === 0) {
      expect(state.installed).toBe(true)
      expect(state.generations.find((item: any) => item.id === state.active_generation).version).toBe("0.1.0")
    } else if (index === 1) {
      expect(state.generations).toHaveLength(2)
      expect(state.generations.find((item: any) => item.id === state.active_generation).version).toBe("0.2.0")
    } else if (index === 2 || index === 3) {
      expect(state.generations.find((item: any) => item.id === state.active_generation).version).toBe("0.1.0")
    } else {
      expect(state.installed).toBe(false)
    }
  }
  const receipt = JSON.parse(readFileSync(join(config, ".opencode-alg", "receipt.json"), "utf8"))
  expect(receipt.installed).toBe(false)
  expect(receipt.generations).toHaveLength(2)
}

afterEach(() => {
  for (const path of sandboxes.splice(0)) removeProject(path)
})

describe("manager launchers and parser", () => {
  test("direct launchers require frozen lockfile installs with lifecycle scripts disabled", () => {
    const powershell = readFileSync(join(ROOT, "scripts", "install.ps1"), "utf8")
    const shell = readFileSync(join(ROOT, "scripts", "install.sh"), "utf8")
    for (const text of [powershell, shell]) {
      expect(text).toContain("bun install --frozen-lockfile --ignore-scripts")
      expect(text).toContain("npm ci --ignore-scripts --no-audit --no-fund")
      expect(text).not.toMatch(/npm install(?:\s|$)/)
    }
    expect(powershell).toContain("bun.lock is required")
    expect(shell).toContain("package-lock.json is required")
  })

  powershellTest("PowerShell direct installer executes exact frozen Bun argv on supported Windows", () => {
    const shimRoot = sandbox("alg direct powershell shim-")
    const capture = join(shimRoot, "capture.txt")
    writeFileSync(join(shimRoot, "bun.cmd"), "@echo off\r\necho %*>>\"%ALG_LAUNCH_CAPTURE%\"\r\n")
    const config = join(sandbox("alg direct powershell config-"), "config with spaces")
    const env = environmentWithPath([shimRoot], { ALG_LAUNCH_CAPTURE: capture })
    const result = spawnSync("pwsh", ["-NoProfile", "-File", join(ROOT, "scripts", "install.ps1"), "-ConfigDir", config, "-SkipAgents"], {
      cwd: ROOT, env, encoding: "utf8", shell: false, windowsHide: true,
    })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" })
    const calls = readFileSync(capture, "utf8").trim().split(/\r?\n/)
    expect(calls[0]).toBe("install --frozen-lockfile --ignore-scripts")
    expect(calls[1]).toContain("run scripts/installer-core.ts --config-dir")
    expect(calls[1]).toContain("--skip-agents")
  })

  posixTest("POSIX direct installer executes exact frozen Bun argv", () => {
    const sh = POSIX_SHELL!
    const shimRoot = sandbox("alg direct posix shim-")
    const capture = join(shimRoot, "capture.txt")
    const shim = join(shimRoot, "bun")
    writeFileSync(shim, "#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$ALG_LAUNCH_CAPTURE\"\n")
    chmodSync(shim, 0o755)
    const config = join(sandbox("alg direct posix config-"), "config with spaces")
    const tools = process.platform === "win32" ? [dirname(sh), resolve(dirname(sh), "..", "usr", "bin"), resolve(dirname(sh), "..", "mingw64", "bin")] : []
    const env = environmentWithPath([shimRoot, ...tools], { ALG_LAUNCH_CAPTURE: capture })
    const result = spawnSync(sh, [join(ROOT, "scripts", "install.sh"), config, "--skip-agents"], {
      cwd: ROOT, env, encoding: "utf8", shell: false, windowsHide: true,
    })
    expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" })
    const calls = readFileSync(capture, "utf8").trim().split(/\r?\n/)
    expect(calls[0]).toBe("install --frozen-lockfile --ignore-scripts")
    expect(calls[1]).toContain("run scripts/installer-core.ts --config-dir")
  })

  test("CLI parser forwards spaced roots and all manager policies without shell parsing", () => {
    const config = resolve("fixture with spaces", "config")
    const install = resolve("fixture with spaces", "managed install")
    const source = resolve("fixture with spaces", "source")
    expect(parseManagerArgs([
      "install",
      "--config-dir", config,
      "--install-root", install,
      "--source", source,
      "--tag", "v0.2.0",
      "--agents", "force",
      "--enable-capability", "excel",
      "--excel-root", resolve("fixture with spaces", "excel root"),
      "--dry-run",
      "--json",
    ], {})).toEqual({
      command: "install",
      configDir: config,
      installRoot: install,
      source,
      tag: "v0.2.0",
      agentPolicy: "force",
      enableCapability: "excel",
      excelRoot: resolve("fixture with spaces", "excel root"),
      dryRun: true,
      json: true,
    })
    expect(parseManagerArgs(["doctor", "--config-dir", config, "--source", source], {}).source).toBe(source)
    expect(() => parseManagerArgs(["install", "--agents", "unsafe"], { HOME: config })).toThrow("managed, skip, or force")
    expect(parseManagerArgs(["update", "--config-dir", config, "--disable-capability", "excel"], {})).toMatchObject({
      command: "update", configDir: config, disableCapability: "excel",
    })
    expect(() => parseManagerArgs(["install", "--enable-capability", "word"], { HOME: config })).toThrow("only excel")
  })

  powershellTest("PowerShell launcher forwards GNU-style arguments and emits bounded JSON", () => {
    const config = sandbox("alg powershell launcher with spaces-")
    const result = spawnSync("pwsh", [
      "-NoProfile",
      "-File", join(ROOT, "scripts", "alg.ps1"),
      "doctor", "--config-dir", config, "--json",
    ], { cwd: ROOT, encoding: "utf8", shell: false, windowsHide: true })
    expect(result.status).toBe(1)
    expect(result.stderr).toBe("")
    const output = JSON.parse(result.stdout.trim())
    expect(output.command).toBe("doctor")
    expect(output.issues).toContainEqual({ code: "receipt-missing", message: "No managed install receipt is present." })
    expect(output.receipt_path).toContain(config)
    expect(Buffer.byteLength(result.stdout)).toBeLessThan(256 * 1024)
    expect(existsSync(join(config, ".opencode-alg"))).toBe(false)
  }, 20_000)

  posixTest("POSIX launcher has valid sh syntax and forwards spaced paths where sh is available", () => {
    const sh = POSIX_SHELL!
    const syntax = spawnSync(sh, ["-n", join(ROOT, "scripts", "alg.sh")], { cwd: ROOT, encoding: "utf8", shell: false, windowsHide: true })
    expect(syntax.status).toBe(0)
    expect(syntax.stderr).toBe("")
    const config = sandbox("alg posix launcher with spaces-")
    const result = spawnSync(sh, [join(ROOT, "scripts", "alg.sh"), "doctor", "--config-dir", config, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    })
    expect(result.status).toBe(1)
    expect(result.stderr).toBe("")
    const output = JSON.parse(result.stdout.trim())
    expect(output.command).toBe("doctor")
    expect(output.receipt_path).toContain(config)
    expect(existsSync(join(config, ".opencode-alg"))).toBe(false)
  }, 20_000)

  powershellTest("PowerShell launcher forwards every lifecycle command through an isolated executable shim", () => {
    const shimRoot = sandbox("alg powershell lifecycle shim-")
    writeFileSync(join(shimRoot, "bun.cmd"), "@echo off\r\n(for %%A in (%*) do @echo %%~A)>\"%ALG_LAUNCH_CAPTURE%\"\r\n")
    const config = join(sandbox("alg powershell lifecycle config-"), "config with spaces")
    const install = join(sandbox("alg powershell lifecycle install-"), "install with spaces")
    const source = join(sandbox("alg powershell lifecycle source-"), "source with spaces")
    for (const [index, args] of lifecycleArgs(config, install, source).entries()) {
      const capture = join(shimRoot, `capture-${index}.txt`)
      const env = environmentWithPath([shimRoot], { ALG_LAUNCH_CAPTURE: capture })
      const result = spawnSync("pwsh", ["-NoProfile", "-File", join(ROOT, "scripts", "alg.ps1"), ...args], {
        cwd: ROOT, env, encoding: "utf8", shell: false, windowsHide: true,
      })
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" })
      const forwarded = readFileSync(capture, "utf8").trim().split(/\r?\n/)
      expect(forwarded[0]).toBe("run")
      expect(forwarded.slice(2)).toEqual(args)
    }
  }, 90_000)

  posixTest("POSIX/Git shell launcher forwards every lifecycle command through an isolated executable shim", () => {
    const sh = POSIX_SHELL!
    const shimRoot = sandbox("alg posix lifecycle shim-")
    const shim = join(shimRoot, "bun")
    writeFileSync(shim, "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ALG_LAUNCH_CAPTURE\"\n")
    chmodSync(shim, 0o755)
    const config = join(sandbox("alg posix lifecycle config-"), "config with spaces")
    const install = join(sandbox("alg posix lifecycle install-"), "install with spaces")
    const source = join(sandbox("alg posix lifecycle source-"), "source with spaces")
    const commands = lifecycleArgs(config, install, source)
    const tools = process.platform === "win32" ? [
      dirname(sh), resolve(dirname(sh), "..", "usr", "bin"), resolve(dirname(sh), "..", "mingw64", "bin"),
    ] : []
    for (const [index, args] of commands.entries()) {
      const capture = join(shimRoot, `capture-${index}.txt`)
      const env = environmentWithPath([shimRoot, ...tools], { ALG_LAUNCH_CAPTURE: capture })
      const result = spawnSync(sh, [join(ROOT, "scripts", "alg.sh"), ...args], {
        cwd: ROOT, env, encoding: "utf8", shell: false, windowsHide: true,
      })
      expect({ status: result.status, stderr: result.stderr }).toEqual({ status: 0, stderr: "" })
      const forwarded = readFileSync(capture, "utf8").trim().split(/\r?\n/)
      expect(forwarded[0]).toBe("run")
      expect(forwarded.slice(2)).toEqual(args)
    }
  }, 90_000)

  powershellTest("PowerShell launcher executes real manager lifecycle with exact local tags and zero project dependencies", () => {
    runLifecycle((args, env) => spawnSync("pwsh", ["-NoProfile", "-File", join(ROOT, "scripts", "alg.ps1"), ...args], {
      cwd: ROOT, env, encoding: "utf8", shell: false, windowsHide: true,
    }))
  }, 120_000)

  posixTest("POSIX/Git shell launcher executes real manager lifecycle where available", () => {
    const sh = POSIX_SHELL!
    runLifecycle((args, env) => spawnSync(sh, [join(ROOT, "scripts", "alg.sh"), ...args], {
      cwd: ROOT, env, encoding: "utf8", shell: false, windowsHide: true,
    }))
  }, 120_000)

  nodeFallbackTest("PowerShell Node fallback executes install/update lifecycle with Bun absent", () => {
    const node = NODE_FALLBACK.node!
    const gitExe = NODE_FALLBACK.git!
    const pwsh = NODE_FALLBACK.pwsh!
    const system32 = join(process.env.SystemRoot ?? "C:\\Windows", "System32")
    const env = environmentWithOnlyPath([dirname(node), dirname(gitExe), system32])
    runLifecycle((args, childEnv) => spawnSync(pwsh, ["-NoProfile", "-File", join(ROOT, "scripts", "alg.ps1"), ...args], {
      cwd: ROOT, env: childEnv, encoding: "utf8", shell: false, windowsHide: true,
    }), env)
  }, 120_000)
})

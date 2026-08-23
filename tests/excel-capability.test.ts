import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { cpSync, mkdirSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { computeAlgSourceIdentity } from "../src/source-identity.ts"
import { verifyExcelManifest } from "../scripts/verify-excel-manifest.ts"
import { removeProject, tempProject } from "./helpers.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const CAPABILITY = join(ROOT, "capabilities", "excel")
const temporary: string[] = []

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function git(root: string, ...args: string[]): string {
  const child = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", shell: false, windowsHide: true })
  if (child.status !== 0) throw new Error(child.stderr)
  return child.stdout.trim()
}

afterEach(() => {
  for (const path of temporary.splice(0)) removeProject(path)
})

describe("Excel capability release identity", () => {
  test("repository contains no generated Python caches, virtualenvs, or packed archives", () => {
    const forbidden: string[] = []
    const visit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.name === ".git" || entry.name === "node_modules") continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === "__pycache__" || entry.name === ".venv" || entry.name === "venv") forbidden.push(path)
          else visit(path)
        } else if (/\.(?:py[co]|tgz)$/i.test(entry.name)) forbidden.push(path)
      }
    }
    visit(ROOT)
    expect(forbidden).toEqual([])
  })
  test("manifest binds every executable/lock input and exact sorted upstream tool contract", () => {
    expect(verifyExcelManifest(ROOT).files).toEqual({
      pyproject: hash(join(CAPABILITY, "pyproject.toml")),
      lock: hash(join(CAPABILITY, "uv.lock")),
      policy: hash(join(CAPABILITY, "policy.py")),
      wrapper: hash(join(CAPABILITY, "wrapper.py")),
      validator: hash(join(CAPABILITY, "workbook.py")),
    })
    const manifest = JSON.parse(readFileSync(join(CAPABILITY, "manifest.json"), "utf8")) as any
    expect(manifest.schema_version).toBe(1)
    expect(manifest.upstream).toEqual({
      distribution: "excel-mcp-server",
      version: "0.1.8",
      import: "excel_mcp.server",
      release_commit: "f51340ecd5778952405044b203d3a2d4c8a46833",
      wheel_sha256: "c75668094697152b9d749939c071ea02ac418635c8a11636396bd9797609f5a5",
    })
    expect(manifest.tools).toEqual([...manifest.tools].sort())
    expect(manifest.tools).toHaveLength(25)
    for (const name of ["pyproject", "lock", "policy", "wrapper", "validator"] as const) {
      expect(hash(join(CAPABILITY, manifest.files[name]))).toBe(manifest.files.sha256[name])
    }
    const project = readFileSync(join(CAPABILITY, "pyproject.toml"), "utf8")
    expect(project.match(/excel-mcp-server/g)).toHaveLength(1)
    expect(project).toContain('"excel-mcp-server==0.1.8"')
    const lock = readFileSync(join(CAPABILITY, "uv.lock"), "utf8")
    expect(lock).toContain('name = "excel-mcp-server"')
    expect(lock).toContain('version = "0.1.8"')
    expect(lock).toContain("sha256:c75668094697152b9d749939c071ea02ac418635c8a11636396bd9797609f5a5")
  })

  test("source identity covers the strict capability asset set but not generated Python caches", () => {
    const identity = computeAlgSourceIdentity(ROOT)
    const paths = identity.manifest.map((entry) => entry.path)
    expect(paths.filter((path) => path.startsWith("capabilities/excel/"))).toEqual([
      "capabilities/excel/manifest.json",
      "capabilities/excel/policy.py",
      "capabilities/excel/pyproject.toml",
      "capabilities/excel/uv.lock",
      "capabilities/excel/workbook.py",
      "capabilities/excel/wrapper.py",
    ])
    expect(paths.some((path) => path.includes("__pycache__") || path.endsWith(".pyc"))).toBe(false)
  })

  test("a local Git clone preserves LF-bound hashes and remains clean on every platform", () => {
    const sandbox = tempProject("alg-excel-eol-")
    temporary.push(sandbox)
    const source = join(sandbox, "source")
    const clone = join(sandbox, "clone")
    mkdirSync(source)
    mkdirSync(join(source, "capabilities"))
    cpSync(join(ROOT, "capabilities", "excel"), join(source, "capabilities", "excel"), { recursive: true })
    cpSync(join(ROOT, ".gitattributes"), join(source, ".gitattributes"))
    cpSync(join(ROOT, ".gitignore"), join(source, ".gitignore"))
    git(source, "init", "-b", "main")
    git(source, "add", ".")
    git(source, "-c", "user.name=ALG Test", "-c", "user.email=alg@example.invalid", "commit", "-m", "capability fixture")
    const child = spawnSync("git", ["clone", "--", source, clone], { encoding: "utf8", shell: false, windowsHide: true })
    expect(child.status).toBe(0)
    expect(git(clone, "status", "--porcelain=v1", "--untracked-files=all")).toBe("")
    const manifest = JSON.parse(readFileSync(join(clone, "capabilities", "excel", "manifest.json"), "utf8")) as any
    for (const name of ["pyproject", "lock", "policy", "wrapper", "validator"] as const) {
      const path = join(clone, "capabilities", "excel", manifest.files[name])
      expect(hash(path)).toBe(manifest.files.sha256[name])
      expect(readFileSync(path).includes(Buffer.from("\r\n"))).toBe(false)
    }
  }, 20_000)
})

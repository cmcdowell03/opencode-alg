import { describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"
import {
  canonicalDuckDbContractHash,
  isManagedDuckDbEntry,
  managedDuckDbEntry,
  runDuckDbProject,
  updateDuckDbProjectConfig,
} from "../scripts/duckdb-project.ts"
import { expectedPackedPaths } from "../scripts/release-gate.ts"
import { DUCKDB_CAPABILITY_FILES, verifyDuckDbManifest } from "../scripts/verify-duckdb-manifest.ts"
import { ALG_TOOL_IDS } from "../scripts/live-verify.ts"
import { computeAlgSourceIdentity } from "../src/source-identity.ts"
import { removeProject, tempProject } from "./helpers.ts"

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)))
const CAPABILITY = join(ROOT, "capabilities", "duckdb")

function hash(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function fixturePath(...parts: string[]): string {
  return process.platform === "win32" ? resolve("C:\\private", ...parts) : resolve("/private", ...parts)
}

describe("optional DuckDB capability", () => {
  test("manifest binds the exact pinned runtime and every shipped capability input", () => {
    const observed = verifyDuckDbManifest(ROOT)
    const manifest = JSON.parse(readFileSync(join(CAPABILITY, "manifest.json"), "utf8")) as any
    expect(manifest.dependencies).toEqual({ duckdb: "1.4.0", sqlglot: "27.14.0", lock: "uv.lock" })
    expect(manifest.runtime).toMatchObject({
      prepared_interpreter_only: true,
      extension_auto_install: false,
      extension_auto_load: false,
      extension_inventory: "empty",
    })
    expect(Object.keys(observed.files).sort()).toEqual([...DUCKDB_CAPABILITY_FILES].sort())
    for (const name of DUCKDB_CAPABILITY_FILES) expect(observed.files[name], name).toBe(hash(join(CAPABILITY, name)))

    const project = readFileSync(join(CAPABILITY, "pyproject.toml"), "utf8")
    expect(project).toContain('"duckdb==1.4.0"')
    expect(project).toContain('"sqlglot==27.14.0"')
    const lock = readFileSync(join(CAPABILITY, "uv.lock"), "utf8")
    expect(lock).toContain('name = "duckdb"')
    expect(lock).toContain('version = "1.4.0"')
    expect(lock).toContain('name = "sqlglot"')
    expect(lock).toContain('version = "27.14.0"')
    expect(lock.match(/hash = "sha256:[a-f0-9]{64}"/g)?.length).toBeGreaterThanOrEqual(2)
  })

  test("versioned example hash is canonical and its JSON schema is recursively strict", () => {
    const envelope = JSON.parse(readFileSync(join(CAPABILITY, "contract.example.json"), "utf8")) as any
    expect(envelope.schema_version).toBe(1)
    expect(canonicalDuckDbContractHash(envelope.contract)).toBe(envelope.contract_sha256)
    expect(envelope.contract).toMatchObject({
      capability_version: "0.1.0",
      engine_version: "1.4.0",
      parser_version: "27.14.0",
      extensions: [],
      attachments: [],
    })
    const schema = JSON.parse(readFileSync(join(CAPABILITY, "contract.schema.json"), "utf8")) as any
    expect(schema.additionalProperties).toBe(false)
    expect(schema.properties.contract.additionalProperties).toBe(false)
    expect(schema.properties.contract.properties.settings.additionalProperties).toBe(false)
    expect(schema.properties.contract.properties.attachments.items.additionalProperties).toBe(false)
    expect(schema.properties.contract.properties.policy.additionalProperties).toBe(false)
  })

  test("managed lifecycle is opt-in, comment-preserving, reversible, and drift-safe", () => {
    const entry = managedDuckDbEntry(
      fixturePath("env", process.platform === "win32" ? "python.exe" : "python"),
      fixturePath("package", "capabilities", "duckdb", "wrapper.py"),
      fixturePath("contract.json"),
      "a".repeat(64),
    )
    expect(isManagedDuckDbEntry(entry)).toBe(true)
    const original = `{
  // preserve this comment
  "$schema": "https://opencode.ai/config.json",
  "plugin": [["other-plugin", { "enabled": true }]],
  "mcp": { "other": { "type": "local", "command": ["other"], "enabled": false } }
}
`
    const enabled = updateDuckDbProjectConfig(original, "enable", entry)
    expect(enabled).toContain("preserve this comment")
    expect(parse(enabled).plugin).toEqual([["other-plugin", { enabled: true }]])
    expect(parse(enabled).mcp.other).toEqual({ type: "local", command: ["other"], enabled: false })
    expect(parse(enabled).mcp.alg_duckdb).toEqual(entry)

    expect(() => updateDuckDbProjectConfig(enabled, "disable")).toThrow("preserved")
    const disabled = updateDuckDbProjectConfig(enabled, "disable", undefined, entry)
    expect(parse(disabled).mcp.alg_duckdb.enabled).toBe(false)
    expect(isManagedDuckDbEntry(parse(disabled).mcp.alg_duckdb)).toBe(true)
    const uninstalled = updateDuckDbProjectConfig(disabled, "uninstall", undefined, { ...entry, enabled: false })
    expect(parse(uninstalled).mcp.alg_duckdb).toBeUndefined()
    expect(parse(uninstalled).mcp.other).toBeDefined()

    const custom = '{"mcp":{"alg_duckdb":{"type":"remote","url":"https://example.invalid"}}}\n'
    for (const action of ["enable", "disable", "uninstall"] as const) {
      expect(() => updateDuckDbProjectConfig(custom, action, entry)).toThrow("preserved")
    }
    expect(JSON.parse(readFileSync(join(CAPABILITY, "opencode.disabled.json"), "utf8"))).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: { alg_duckdb: { enabled: false } },
    })
  })

  test("project lifecycle commands persist enable/doctor/disable/status/uninstall without running Python", () => {
    const project = tempProject("alg-duckdb-lifecycle-")
    const python = join(project, process.platform === "win32" ? "python.exe" : "python")
    const contract = join(project, "private-contract.json")
    writeFileSync(python, "prepared interpreter fixture\n")
    writeFileSync(contract, readFileSync(join(CAPABILITY, "contract.example.json")))
    writeFileSync(join(project, "opencode.jsonc"), '{\n  // retained\n  "$schema": "https://opencode.ai/config.json"\n}\n')
    const output: string[] = []
    const logged = spyOn(console, "log").mockImplementation((value) => output.push(String(value)))
    try {
      runDuckDbProject(["enable", "--project", project, "--python", python, "--contract", contract])
      let configured = parse(readFileSync(join(project, "opencode.jsonc"), "utf8"))
      expect(configured.mcp.alg_duckdb.enabled).toBe(true)
      expect(readFileSync(join(project, "opencode.jsonc"), "utf8")).toContain("retained")
      runDuckDbProject(["doctor", "--project", project])
      expect(JSON.parse(output.at(-1)!).ok).toBe(true)
      runDuckDbProject(["disable", "--project", project])
      runDuckDbProject(["status", "--project", project])
      expect(JSON.parse(output.at(-1)!)).toEqual({ configured: true, managed: true, enabled: false })
      runDuckDbProject(["uninstall", "--project", project])
      configured = parse(readFileSync(join(project, "opencode.jsonc"), "utf8"))
      expect(configured.mcp.alg_duckdb).toBeUndefined()
    } finally {
      logged.mockRestore()
      removeProject(project)
    }
  })

  test("source/package inventories include the exact capability, skill, docs, and manager without registry changes", () => {
    const source = computeAlgSourceIdentity(ROOT).manifest.map((entry) => entry.path)
    expect(source.filter((path) => path.startsWith("capabilities/duckdb/"))).toEqual([
      ...DUCKDB_CAPABILITY_FILES,
      "manifest.json",
    ].sort().map((name) => `capabilities/duckdb/${name}`))
    expect(source).toContain(".opencode/skills/duckdb-lake/SKILL.md")
    const packed = expectedPackedPaths(ROOT)
    for (const path of [
      ...DUCKDB_CAPABILITY_FILES.map((name) => `capabilities/duckdb/${name}`),
      "capabilities/duckdb/manifest.json",
      ".opencode/skills/duckdb-lake/SKILL.md",
      "docs/duckdb-query-plane.md",
      "scripts/duckdb-project.ts",
      "scripts/verify-duckdb-manifest.ts",
    ]) expect(packed, path).toContain(path)
    expect(ALG_TOOL_IDS).toHaveLength(15)
    expect(ALG_TOOL_IDS.some((name) => name.includes("duckdb"))).toBe(false)
  })

  test("skill encodes attachment, partition, PII, EXPLAIN, and no-data-movement guidance", () => {
    const skill = readFileSync(join(ROOT, ".opencode", "skills", "duckdb-lake", "SKILL.md"), "utf8")
    for (const phrase of [
      "DuckDB", "asyncpg", "Spark", "ALG_DUCKDB_*", "TYPE DUCKDB, READ_ONLY", "catalog.schema.relation",
      "every `OR` branch", "LIMIT", "EXPLAIN SELECT", "EXPLAIN ANALYZE", "PII", "redacted fixture",
      "bucket", "Do not copy", "experience catalog",
    ]) expect(skill, phrase).toContain(phrase)
    expect(readFileSync(join(ROOT, "package.json"), "utf8")).not.toContain("OpenCode2")
  })
})

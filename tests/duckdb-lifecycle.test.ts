import { describe, expect, spyOn, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runDuckDbProject } from "../scripts/duckdb-project.ts"
import { reportLiveFailure } from "../scripts/check-live.ts"
import { ALG_TOOL_IDS, OPENCODE_ENGINE_REQUIREMENT, verificationPluginConfiguration } from "../scripts/live-verify.ts"
import { tempProject, removeProject } from "./helpers.ts"

function fixture(body: (project: string, enable: (hooks?: Parameters<typeof runDuckDbProject>[1]) => void) => void) {
  const project = tempProject("alg-duckdb-owned-")
  const python = join(project, "python.exe")
  const contract = join(project, "contract.json")
  writeFileSync(python, "synthetic prepared runtime")
  writeFileSync(contract, readFileSync(new URL("../capabilities/duckdb/contract.example.json", import.meta.url)))
  const log = spyOn(console, "log").mockImplementation(() => {})
  try {
    body(project, (hooks) => runDuckDbProject(["enable", "--project", project, "--python", python, "--contract", contract], hooks))
  } finally { log.mockRestore(); removeProject(project) }
}

describe("DuckDB receipt and config transaction", () => {
  test("installs discovery skill and preserves private runtime on uninstall", () => fixture((project, enable) => {
    enable()
    const skill = join(project, ".opencode/skills/duckdb-lake/SKILL.md")
    expect(readFileSync(skill)).toEqual(readFileSync(new URL("../.opencode/skills/duckdb-lake/SKILL.md", import.meta.url)))
    runDuckDbProject(["uninstall", "--project", project])
    expect(existsSync(skill)).toBe(false)
    expect(existsSync(join(project, ".opencode/alg-duckdb.receipt.json"))).toBe(false)
    expect(existsSync(join(project, "python.exe"))).toBe(true)
    expect(existsSync(join(project, "contract.json"))).toBe(true)
  }))

  test("same-shape command drift and changed skill are preserved", () => fixture((project, enable) => {
    enable()
    const config = join(project, "opencode.jsonc")
    const original = readFileSync(config)
    const parsed = JSON.parse(original.toString())
    parsed.mcp.alg_duckdb.command[6] = "f".repeat(64)
    writeFileSync(config, JSON.stringify(parsed))
    expect(() => runDuckDbProject(["uninstall", "--project", project])).toThrow("preserved")
    expect(JSON.parse(readFileSync(config, "utf8")).mcp.alg_duckdb.command[6]).toBe("f".repeat(64))
    writeFileSync(config, original)
    const skill = join(project, ".opencode/skills/duckdb-lake/SKILL.md")
    writeFileSync(skill, "user skill")
    expect(() => enable()).toThrow("preserved")
    expect(readFileSync(skill, "utf8")).toBe("user skill")
  }))

  test("CAS preserves a concurrent unrelated config edit", () => fixture((project, enable) => {
    const config = join(project, "opencode.jsonc")
    writeFileSync(config, "{}\n")
    const concurrent = '{"theme":"user-change"}\n'
    expect(() => enable({ afterClaim(plan) { if (plan.path === config) writeFileSync(config, concurrent) } })).toThrow()
    expect(readFileSync(config, "utf8")).toBe(concurrent)
    expect(existsSync(join(project, ".opencode/alg-duckdb.receipt.json"))).toBe(false)
  }))

  test("mid-transaction failure rolls back config and never claims ownership", () => fixture((project, enable) => {
    const config = join(project, "opencode.jsonc")
    writeFileSync(config, "{}\n")
    expect(() => enable({ beforeMutation(_plan, index) { if (index === 1) throw new Error("injected skill failure") } })).toThrow("injected skill failure")
    expect(readFileSync(config, "utf8")).toBe("{}\n")
    expect(existsSync(join(project, ".opencode/alg-duckdb.receipt.json"))).toBe(false)
  }))

  test("UTF-16 config retains encoding and comments", () => fixture((project, enable) => {
    const config = join(project, "opencode.jsonc")
    writeFileSync(config, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{\r\n // comment\r\n}\r\n', "utf16le")]))
    enable()
    const bytes = readFileSync(config)
    expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]))
    expect(bytes.subarray(2).toString("utf16le")).toContain("// comment")
  }))

  test("missing or corrupt live evidence never replaces the original failure", () => fixture((project) => {
    const path = join(project, "failed-live.json")
    const original = new Error("synthetic original OpenCode failure")
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      for (const corrupt of [false, true]) {
        if (corrupt) writeFileSync(path, "not JSON")
        let caught: unknown
        try { reportLiveFailure(path, "a".repeat(64), original) } catch (error) { caught = error }
        expect(caught).toBe(original)
        const summary = JSON.parse(String(log.mock.calls.at(-1)![0]))
        expect(summary.passed).toBe(false)
        expect(summary.evidence_path).toBe(path)
        expect(summary.original_failure).toBe(original.message)
        expect(summary.evidence_validation_error).toBeTruthy()
      }
    } finally { log.mockRestore() }
  }))

  test("valid failed live evidence reports cleanup without success adjudication", () => fixture((project) => {
    const path = join(project, "failed-live.json")
    const configuration = verificationPluginConfiguration()
    const source = configuration.source
    const snapshot = { sha256: "a".repeat(64), entries: [{
      scope: "synthetic", relative_path: ".", state: "absent", size: null, mtime_ns: null, ctime_ns: null, mode: null, content_hmac_sha256: null,
    }] }
    writeFileSync(path, JSON.stringify({
      schema_version: 2, kind: "opencode-alg-live-verification", generated_at: new Date().toISOString(),
      no_model_calls: true, passed: false, output_path: path, reason: "synthetic version failure",
      temporary_environment_removed: true, declared_engine_requirement: OPENCODE_ENGINE_REQUIREMENT,
      required_alg_tool_ids: ALG_TOOL_IDS,
      plugin_source: {
        package_version: configuration.package_version, canonical_root: source.root, package_spec: source.spec, sha256: source.digest,
        runtime_manifest: { digest: source.digest, entries: source.manifest, file_count: source.file_count, total_bytes: source.total_bytes, bounds: source.bounds },
        entry_points: configuration.entry_points,
        registrations: { server: configuration.server_config.plugin, tui: configuration.tui_config.plugin },
      },
      isolation: {
        project_config_disabled: true, default_plugins_disabled: true, external_skills_disabled: true, isolated_xdg_config: true,
        explicit_server_config: join(project, "opencode.json"), isolated_tui_config: join(project, "tui.json"),
        parent_global_plugin_state_used: false, user_global_config_modified: false,
        global_config_snapshots: {
          algorithm: "ephemeral-key-hmac-sha256-plus-file-metadata",
          allowlisted_relative_paths: [".", "opencode.json", "opencode.jsonc", "tui.json"],
          before: snapshot, after: snapshot, unchanged: true,
        },
      },
      version: {
        executable_path: process.execPath, declared_engine_requirement: OPENCODE_ENGINE_REQUIREMENT, command: [process.execPath, "--version"],
        root_pid: null, stdout: "", stderr: "synthetic version failure", exit_observed: false, exit_code: null, exit_signal: null,
        timeout_ms: 30000, timed_out: false, passed: false, reason: "synthetic version failure",
        parsed: null,
        cleanup: { root_pid: null, cleanup_scope: "root-process", exit_observed: false, exit_code: null, exit_signal: null,
          termination_attempted: false, termination_result: "already-exited", tree_termination_attempted: false,
          tree_termination_result: "not-required", best_effort_kill_attempted: false, passed: true },
      },
    }))
    const original = new Error("synthetic original failure")
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      expect(() => reportLiveFailure(path, source.digest, original)).toThrow(original)
      const summary = JSON.parse(String(log.mock.calls.at(-1)![0]))
      expect(summary.evidence_validation_error).toBeNull()
      expect(summary.passed).toBe(false)
      expect(summary.temporary_environment_removed).toBe(true)
      expect(summary.phase).toBe("version")
      expect(summary.evidence_sha256).toMatch(/^[a-f0-9]{64}$/)
    } finally { log.mockRestore() }
  }))
})

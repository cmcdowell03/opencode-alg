import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
  ReleaseEvidenceSchema,
  RELEASE_COMMAND_IDS,
  boundedReleaseTail,
  computeReleaseInputIdentity,
  redactReleaseText,
  repositoryReleaseArtifacts,
  expectedPackedPaths,
  validateReleaseEvidenceSemantics,
  validatePackedInventory,
  verifyRetainedReleaseEvidence,
  writeReleaseEvidence,
} from "../scripts/release-gate.ts"
import { resolveNpmInvocation } from "../scripts/npm-invocation.ts"
import { verifyExcelManifest } from "../scripts/verify-excel-manifest.ts"
import { sourceIdentityMessage } from "../src/source-identity.ts"
import { ALG_TOOL_IDS, OPENCODE_ENGINE_REQUIREMENT, persistImmutableLiveEvidence, uniqueLiveEvidencePath, verificationPluginConfiguration, validateRetainedLiveEvidence } from "../scripts/live-verify.ts"
import { ALG_TUI_REGISTRATION_SERVICE, ALG_TUI_REGISTRATION_TOKEN } from "../src/tui-registration.ts"
import { algServerStartupMessage } from "../src/types.ts"
import { MANAGER_VERSION } from "../scripts/manager-schema.ts"
import { removeProject, tempProject } from "./helpers.ts"

const temporary: string[] = []
const digest = "a".repeat(64)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function command(id: typeof RELEASE_COMMAND_IDS[number] = "typecheck") {
  const empty = createHash("sha256").update("").digest("hex")
  return {
    id, argv: ["tool", "arg"], cwd: "C:\\fixture", exit_code: 0,
    stdout_bytes: 0, stdout_sha256: empty, stdout: "",
    stderr_bytes: 0, stderr_sha256: empty, stderr: "",
  }
}

function evidence() {
  return {
    schema_version: 5 as const, kind: "opencode-alg-release-gate" as const,
    generated_at: "2026-08-20T00:00:00.000Z", package_version: "0.3.0" as const,
    source: { sha256: digest, files: 1, bytes: 1 }, release_inputs: { sha256: digest, files: 1, bytes: 1 }, commands: RELEASE_COMMAND_IDS.map((id) => command(id)),
    totals: { bun_pass: 1, bun_skip: 0, bun_fail: 0, bun_total: 1, bun_assertions: 1, bun_files: 1, manager_pass: 1, manager_skip: 0, manager_fail: 0, manager_total: 1, manager_assertions: 1, manager_files: 1, python_run: 1, python_skipped: 0, python_ok: true as const },
    excel: { manifest_sha256: digest, lock_sha256: digest, version: "0.1.8" as const, tool_count: 25 as const, eof_stdout_bytes: 0 as const },
    package: {
      entries: 6, packed_bytes: 1, unpacked_bytes: 1,
      files: ["a", "b", "c", "d", "e", "f"].map((path) => ({ path, size: 1, mode: 420 })), inventory_sha256: digest,
      capability_files: ["a", "b", "c", "d", "e", "f"], lock_bytes: 1,
      tgz_created: false as const,
    },
    live: { passed: true as const, evidence_path: "C:\\external\\live.json", evidence_sha256: digest, evidence_bytes: 1, evidence_identity: { dev: "1", ino: "1" }, source_sha256: digest, user_global_config_modified: false as const, global_config_snapshot_sha256: digest, temporary_environment_removed: true as const },
    cleanup: { temporary_excel_environment_removed: true as const, repository_artifacts_absent: true as const, helper_owned_before: 0, helper_owned_after: 0, helper_net_additions: 0 as const },
    passed: true as const,
  }
}

function semanticEvidence(livePath: string) {
  const configuration = verificationPluginConfiguration(ROOT)
  const source = configuration.source
  const snapshotEntries = [".", "opencode.json", "opencode.jsonc", "tui.json"].map((relative_path) => ({
    scope: "fixture", relative_path, state: "absent", size: null, mtime_ns: null, ctime_ns: null, mode: null, content_hmac_sha256: null,
  }))
  const actualSnapshotDigest = createHash("sha256").update(JSON.stringify(snapshotEntries)).digest("hex")
  const serverSource = `INFO service=${ALG_TUI_REGISTRATION_SERVICE} ${sourceIdentityMessage("server", source)}`
  const serverStartup = `timestamp=2026-08-30T08:46:45.371Z level=INFO run=c0d53d8d ` +
    `message=${JSON.stringify(algServerStartupMessage(false))} ` +
    `directory="D:\\\\Docker\\\\model-temp\\\\alg-live-verify-fixture\\\\project" skill_evolution_enabled=false`
  const tuiSource = `INFO service=${ALG_TUI_REGISTRATION_SERVICE} ${sourceIdentityMessage("tui", source)}`
  const cleanup = { root_pid: 1, cleanup_scope: "root-process", exit_observed: true, exit_code: 0, exit_signal: null, termination_attempted: false, termination_result: "already-exited", tree_termination_attempted: false, tree_termination_result: "not-required", best_effort_kill_attempted: false, passed: true }
  const live = {
    schema_version: 2, kind: "opencode-alg-live-verification", generated_at: "2026-08-20T00:00:00.000Z", passed: true, no_model_calls: true, declared_engine_requirement: OPENCODE_ENGINE_REQUIREMENT,
    required_alg_tool_ids: [...ALG_TOOL_IDS],
    plugin_source: {
      package_version: configuration.package_version, canonical_root: source.root, package_spec: source.spec, sha256: source.digest,
      runtime_manifest: { digest: source.digest, entries: source.manifest, file_count: source.file_count, total_bytes: source.total_bytes, bounds: source.bounds },
      entry_points: configuration.entry_points, registrations: { server: configuration.server_config.plugin, tui: configuration.tui_config.plugin },
    },
    output_path: livePath, reason: "fixture passed",
    version: { executable_path: process.execPath, declared_engine_requirement: OPENCODE_ENGINE_REQUIREMENT, command: [process.execPath, "--version"], root_pid: 1, stdout: "1.18.18\n", stderr: "", exit_observed: true, exit_code: 0, exit_signal: null, timeout_ms: 30000, timed_out: false, cleanup, passed: true, parsed: { text: "1.18.18", major: 1, minor: 18, patch: 18 }, reason: "compatible" },
    server: { command: [process.execPath, "serve"], root_pid: 1, endpoint: "http://127.0.0.1:1/experimental/tool/ids", readiness_attempts: 1, raw_http_status: 200, raw_http_body: JSON.stringify(ALG_TOOL_IDS), parsed_alg_ids: [...ALG_TOOL_IDS], source_identity_log: serverSource, stdout_tail: serverStartup, stderr_tail: "", cleanup },
    tui: { command: [process.execPath, ROOT], root_pid: 1, registration_log: `INFO service=${ALG_TUI_REGISTRATION_SERVICE} ${ALG_TUI_REGISTRATION_TOKEN}`, source_identity_log: tuiSource, cleanup },
    temporary_environment_removed: true,
    isolation: {
      project_config_disabled: true, default_plugins_disabled: true, external_skills_disabled: true, isolated_xdg_config: true,
      explicit_server_config: join(ROOT, "fixture-opencode.json"), isolated_tui_config: join(ROOT, "fixture-tui.json"),
      parent_global_plugin_state_used: false, user_global_config_modified: false,
      global_config_snapshots: {
        algorithm: "ephemeral-key-hmac-sha256-plus-file-metadata", allowlisted_relative_paths: [".", "opencode.json", "opencode.jsonc", "tui.json"], unchanged: true,
        before: { sha256: actualSnapshotDigest, entries: snapshotEntries },
        after: { sha256: actualSnapshotDigest, entries: snapshotEntries },
      },
    },
  }
  const liveBytes = Buffer.from(`${JSON.stringify(live)}\n`)
  const livePublication = persistImmutableLiveEvidence(livePath, liveBytes)
  const paths = expectedPackedPaths(ROOT)
  const packedFiles = paths.map((path) => ({ path, size: statSync(join(ROOT, ...path.split("/"))).size, mode: 420 }))
  const inventory = validatePackedInventory(packedFiles, paths)
  const excel = verifyExcelManifest(ROOT)
  const wrapper = join(ROOT, "capabilities", "excel", "wrapper.py")
  const excelRoot = join(ROOT, "capabilities", "excel")
  const npm = resolveNpmInvocation()
  const findExecutable = (names: string[]) => (process.env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")
    .flatMap((directory) => names.map((name) => join(directory.replace(/^"|"$/g, ""), name))).find(existsSync)!
  const python = findExecutable(process.platform === "win32" ? ["python.exe"] : ["python3", "python"])
  const uv = findExecutable(process.platform === "win32" ? ["uv.exe"] : ["uv"])
  const interpreter = join(resolve("C:/tmp/opencode-alg-excel-release-gate-fixture"), "env", process.platform === "win32" ? "Scripts/python.exe" : "bin/python")
  const bunOutput = " 12 pass\n 2 skip\n 0 fail\n 34 expect() calls\nRan 14 tests across 3 files. [1.00s]\n"
  const managerOutput = " 12 pass\n 1 skip\n 0 fail\n 34 expect() calls\nRan 13 tests across 1 file. [1.00s]\n"
  const pythonOutput = "Ran 7 tests in 0.1s\n\nOK (skipped=1)\n"
  const manifestOutput = `${JSON.stringify({ ok: true, ...excel })}\n`
  const wrapperJson = { ok: true, version: "0.1.8", tool_count: 25, tools: ["apply_formula", "copy_range", "copy_worksheet", "create_chart", "create_pivot_table", "create_table", "create_workbook", "create_worksheet", "delete_range", "delete_sheet_columns", "delete_sheet_rows", "delete_worksheet", "format_range", "get_data_validation_info", "get_merged_cells", "get_workbook_metadata", "insert_columns", "insert_rows", "merge_cells", "read_data_from_excel", "rename_worksheet", "unmerge_cells", "validate_excel_range", "validate_formula_syntax", "write_data_to_excel"], remote_transports: false, path_policy: { ok: true, path_argument_confinement: true } }
  const pack = [{ entryCount: packedFiles.length, size: 12345, unpackedSize: packedFiles.reduce((sum, file) => sum + file.size, 0), files: packedFiles }]
  const commands = [
    commandWith("typecheck", [process.execPath, "run", "typecheck"]),
    commandWith("bun_test", [process.execPath, "test", "--timeout", "60000"], ROOT, bunOutput),
    commandWith("manager_tests", [process.execPath, "test", "tests/manager.test.ts", "--timeout", "60000"], ROOT, managerOutput),
    commandWith("smoke", [process.execPath, "run", "smoke"]),
    commandWith("live_verify", [process.execPath, "run", "check:live"]),
    commandWith("excel_manifest", [process.execPath, "run", "check:excel-manifest"], ROOT, manifestOutput),
    commandWith("python_tests", [python, "-m", "unittest", "discover", "-s", "tests/python", "-v"], ROOT, "", pythonOutput),
    commandWith("uv_sync", [uv, "sync", "--frozen", "--no-dev"], excelRoot),
    commandWith("excel_wrapper_check", [interpreter, wrapper, "--check"], ROOT, `${JSON.stringify(wrapperJson)}\n`),
    commandWith("excel_wrapper_eof", [interpreter, wrapper]),
    commandWith("npm_pack", [npm.executable, ...npm.argsPrefix, "pack", "--dry-run", "--json"], ROOT, JSON.stringify(pack)),
  ]
  return ReleaseEvidenceSchema.parse({
    ...evidence(),
    source: { sha256: source.digest, files: source.file_count, bytes: source.total_bytes },
    release_inputs: computeReleaseInputIdentity(ROOT),
    commands,
    totals: { bun_pass: 12, bun_skip: 2, bun_fail: 0, bun_total: 14, bun_assertions: 34, bun_files: 3, manager_pass: 12, manager_skip: 1, manager_fail: 0, manager_total: 13, manager_assertions: 34, manager_files: 1, python_run: 7, python_skipped: 1, python_ok: true },
    excel: { ...evidence().excel, manifest_sha256: excel.manifest_sha256, lock_sha256: excel.files.lock },
    package: {
      ...evidence().package,
      entries: paths.length, packed_bytes: pack[0]!.size, unpacked_bytes: pack[0]!.unpackedSize,
      files: packedFiles,
      inventory_sha256: inventory.sha256,
      capability_files: [
        "capabilities/excel/manifest.json", "capabilities/excel/policy.py", "capabilities/excel/pyproject.toml",
        "capabilities/excel/uv.lock", "capabilities/excel/workbook.py", "capabilities/excel/wrapper.py",
      ],
      lock_bytes: readFileSync(join(excelRoot, "uv.lock")).byteLength,
    },
    live: {
      passed: true,
      evidence_path: livePath,
      evidence_sha256: createHash("sha256").update(liveBytes).digest("hex"),
      evidence_bytes: liveBytes.byteLength,
      evidence_identity: livePublication.identity,
      source_sha256: source.digest,
      user_global_config_modified: false,
      global_config_snapshot_sha256: actualSnapshotDigest,
      temporary_environment_removed: true,
    },
  })
}

function commandWith(id: typeof RELEASE_COMMAND_IDS[number], argv: string[], cwd = ROOT, stdout = "", stderr = "") {
  const stdoutBytes = Buffer.from(stdout)
  const stderrBytes = Buffer.from(stderr)
  return {
    id, argv, cwd, exit_code: 0,
    stdout_bytes: stdoutBytes.byteLength, stdout_sha256: createHash("sha256").update(stdoutBytes).digest("hex"), stdout,
    stderr_bytes: stderrBytes.byteLength, stderr_sha256: createHash("sha256").update(stderrBytes).digest("hex"), stderr,
  }
}

afterEach(() => {
  for (const path of temporary.splice(0)) removeProject(path)
})

describe("bounded release-gate evidence", () => {
  test("v0.3 package, locks, durable compatibility, release evidence, and v0.2 manager identities are deliberate", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"))
    expect(pkg.version).toBe("0.3.0")
    expect(lock.version).toBe("0.3.0")
    expect(lock.packages[""].version).toBe("0.3.0")
    expect(pkg.opencodeAlg.durableState).toEqual({
      format: "alg-run-state",
      currentSchema: 2,
      compatibleSchemas: [1, 2],
      compatiblePackageVersions: ["0.1.0", "0.2.0", "0.3.0"],
    })
    expect(MANAGER_VERSION).toBe("0.2.0")
    expect(ReleaseEvidenceSchema.parse(evidence())).toMatchObject({ schema_version: 5, package_version: "0.3.0" })
    expect(ReleaseEvidenceSchema.safeParse({ ...evidence(), schema_version: 4 }).success).toBe(false)
  })

  test("source identity and npm allowlist automatically include every skill-evolution runtime module", () => {
    const sourcePaths = verificationPluginConfiguration(ROOT).source.manifest.map((entry) => entry.path)
    const packedPaths = expectedPackedPaths(ROOT)
    for (const path of [
      "src/skill-evolution-evidence.ts",
      "src/skill-evolution-historical.ts",
      "src/skill-evolution-runtime.ts",
      "src/skill-evolution-schemas.ts",
      "src/skill-evolution-store.ts",
      "src/skill-evolution-tools.ts",
    ]) {
      expect(sourcePaths).toContain(path)
      expect(packedPaths).toContain(path)
    }
  })

  test("strict schema rejects unknown or contradictory fields", () => {
    expect(ReleaseEvidenceSchema.parse(evidence()).passed).toBe(true)
    expect(ReleaseEvidenceSchema.safeParse({ ...evidence(), secret: "no" }).success).toBe(false)
    expect(ReleaseEvidenceSchema.safeParse({ ...evidence(), passed: false }).success).toBe(false)
    const missingSkip = structuredClone(evidence())
    delete (missingSkip.totals as Partial<typeof missingSkip.totals>).bun_skip
    expect(ReleaseEvidenceSchema.safeParse(missingSkip).success).toBe(false)
  })

  test("release-input identity binds same-length manager script, documentation, and test changes", () => {
    const root = tempProject("alg-release-input-identity-")
    temporary.push(root)
    const packed = ["scripts/manager-core.ts", "docs/operations.md"]
    const controls = [".gitattributes", ".gitignore", ".npmignore", "bun.lock", "package-lock.json", "tsconfig.json"]
    for (const path of [...packed, "tests/fixture.test.ts", ...controls]) {
      mkdirSync(dirname(join(root, path)), { recursive: true })
      writeFileSync(join(root, path), `input:${path}:AAAA\n`)
    }
    const original = computeReleaseInputIdentity(root, packed, controls)
    for (const path of ["scripts/manager-core.ts", "docs/operations.md", "tests/fixture.test.ts"]) {
      const before = readFileSync(join(root, path))
      const after = Buffer.from(before)
      after[after.length - 2] = after[after.length - 2] === 65 ? 66 : 65
      expect(after.byteLength).toBe(before.byteLength)
      writeFileSync(join(root, path), after)
      expect(computeReleaseInputIdentity(root, packed, controls).sha256, path).not.toBe(original.sha256)
      writeFileSync(join(root, path), before)
    }
    expect(computeReleaseInputIdentity(root, packed, controls)).toEqual(original)
  })

  test("redacts credentials and bounds UTF-8 output tails", () => {
    const redacted = redactReleaseText("token=supersecret Authorization: bearer-value password=hunter2")
    expect(redacted).not.toContain("supersecret")
    expect(redacted).not.toContain("hunter2")
    const tail = boundedReleaseTail(`token=secret ${"🙂".repeat(5000)}`, 128)
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(128)
    expect(tail).not.toContain("token=secret")
  })

  test("writes only strict bounded external evidence and artifact scanning detects caches", () => {
    const directory = tempProject("alg-release-evidence-")
    const repository = tempProject("alg-release-artifacts-")
    temporary.push(directory, repository)
    const retained = writeReleaseEvidence(directory, ReleaseEvidenceSchema.parse(evidence()))
    expect(existsSync(retained.path)).toBe(true)
    expect(dirname(retained.path)).toBe(resolve(directory))
    expect(retained.path.split(/[\\/]/).at(-1)).toMatch(/^release-gate-a{16}-[0-9a-f-]{36}\.json$/)
    expect(readFileSync(retained.path).byteLength).toBe(retained.bytes)
    expect(retained.sha256).toBe(createHash("sha256").update(readFileSync(retained.path)).digest("hex"))
    expect(repositoryReleaseArtifacts(repository)).toEqual([])
    mkdirSync(join(repository, "capabilities", "__pycache__"), { recursive: true })
    writeFileSync(join(repository, "capabilities", "__pycache__", "x.pyc"), "cache")
    expect(repositoryReleaseArtifacts(repository)).toEqual([
      join("capabilities", "__pycache__"),
    ])
  })

  test("release evidence UUID collision never overwrites the existing final artifact", () => {
    const directory = tempProject("alg-release-evidence-collision-")
    temporary.push(directory)
    const uuid = "11111111-1111-4111-8111-111111111111"
    const first = writeReleaseEvidence(directory, ReleaseEvidenceSchema.parse(evidence()), { uuid: () => uuid })
    const firstBytes = readFileSync(first.path)
    const changed = ReleaseEvidenceSchema.parse({ ...evidence(), generated_at: "2026-08-20T00:00:01.000Z" })
    expect(() => writeReleaseEvidence(directory, changed, { uuid: () => uuid })).toThrow("no-clobber")
    expect(readFileSync(first.path)).toEqual(firstBytes)
    expect(createHash("sha256").update(readFileSync(first.path)).digest("hex")).toBe(first.sha256)
    expect(readdirSync(directory).filter((name) => name.includes(".tmp-"))).toEqual([])
  })

  test.each(["before-final-check", "after-final-check"] as const)("release evidence same-byte replacement %s is preserved and rejected", (seam) => {
    const directory = tempProject(`alg-release-evidence-replacement-${seam}-`)
    temporary.push(directory)
    let finalPath = ""
    const replace = (temporaryPath: string, path: string) => {
      finalPath = path
      const bytes = readFileSync(temporaryPath)
      rmSync(path)
      writeFileSync(path, bytes, { flag: "wx" })
    }
    expect(() => writeReleaseEvidence(directory, ReleaseEvidenceSchema.parse(evidence()), seam === "before-final-check"
      ? { afterLink: replace }
      : { afterFinalVerified: replace })).toThrow(/identity|no-clobber/)
    expect(existsSync(finalPath)).toBe(true)
    expect(ReleaseEvidenceSchema.parse(JSON.parse(readFileSync(finalPath, "utf8"))).passed).toBe(true)
  })

  test("release evidence preserves a replaced temporary and rejects cleanup", () => {
    const directory = tempProject("alg-release-evidence-temp-replacement-")
    temporary.push(directory)
    const foreign = Buffer.from("foreign release temporary\n")
    let temporaryPath = ""
    let finalPath = ""
    expect(() => writeReleaseEvidence(directory, ReleaseEvidenceSchema.parse(evidence()), {
      afterFinalVerified(temp, final) {
        temporaryPath = temp
        finalPath = final
        rmSync(temp)
        writeFileSync(temp, foreign, { flag: "wx" })
      },
    })).toThrow(/temporary preserved|identity/)
    expect(readFileSync(temporaryPath)).toEqual(foreign)
    expect(existsSync(finalPath)).toBe(true)
  })

  test("strict release verification rejects a same-byte final identity replacement", () => {
    const directory = tempProject("alg-release-evidence-retained-identity-")
    temporary.push(directory)
    const written = writeReleaseEvidence(directory, ReleaseEvidenceSchema.parse(evidence()))
    const bytes = readFileSync(written.path)
    rmSync(written.path)
    writeFileSync(written.path, bytes, { flag: "wx" })
    expect(() => verifyRetainedReleaseEvidence(written.path, written, ROOT)).toThrow("identity differs")
    expect(readFileSync(written.path)).toEqual(bytes)
  })

  test("semantically verifies retained evidence against the current source, package, live proof, path, and hash", () => {
    const directory = tempProject("alg-semantic-release-evidence-")
    temporary.push(directory)
    const livePath = uniqueLiveEvidencePath(directory, verificationPluginConfiguration(ROOT).source.digest, "11111111-1111-4111-8111-111111111111")
    const current = semanticEvidence(livePath)
    expect(validateReleaseEvidenceSemantics(current, ROOT)).toEqual(current)
    const written = writeReleaseEvidence(directory, current)
    const retained = verifyRetainedReleaseEvidence(written.path, written, ROOT)
    expect(retained.path).toBe(written.path)
    expect(retained.sha256).toBe(written.sha256)
    expect(retained.bytes).toBe(written.bytes)
    expect(retained.evidence.source).toEqual(current.source)
    expect(() => verifyRetainedReleaseEvidence(written.path, { sha256: "0".repeat(64) }, ROOT)).toThrow("hash differs")

    const managerWithoutSkipOutput = current.commands[2]!.stdout.replace(" 1 skip\n", "").replace("Ran 13 tests", "Ran 12 tests")
    const managerWithoutSkip = ReleaseEvidenceSchema.parse({
      ...current,
      commands: current.commands.map((item, index) => index === 2
        ? commandWith(item.id, item.argv, item.cwd, managerWithoutSkipOutput, item.stderr)
        : item),
      totals: { ...current.totals, manager_skip: 0, manager_total: 12 },
    })
    expect(validateReleaseEvidenceSemantics(managerWithoutSkip, ROOT)).toEqual(managerWithoutSkip)
  })

  test("semantic verification rejects coherent-looking contradictory or stale evidence", () => {
    const directory = tempProject("alg-adversarial-release-evidence-")
    temporary.push(directory)
    const current = semanticEvidence(uniqueLiveEvidencePath(directory, verificationPluginConfiguration(ROOT).source.digest, "22222222-2222-4222-8222-222222222222"))
    const alterOutput = (index: number, transform: (output: string) => string) => ({
      ...current,
      commands: current.commands.map((item, itemIndex) => itemIndex === index
        ? commandWith(item.id, item.argv, item.cwd, transform(item.stdout), item.stderr)
        : item),
    })
    const cases: Array<[string, unknown]> = [
      ["source", { ...current, source: { ...current.source, sha256: "0".repeat(64) } }],
      ["duplicate command id", { ...current, commands: current.commands.map((item, index) => index === 1 ? { ...item, id: "typecheck" } : item) }],
      ["arbitrary executable", { ...current, commands: current.commands.map((item, index) => index === 0 ? { ...item, argv: ["C:/malicious/bun.exe", "run", "typecheck"] } : item) }],
      ["command", { ...current, commands: current.commands.map((item, index) => index === 0 ? { ...item, argv: [item.argv[0]!, "run", "not-typecheck"] } : item) }],
      ["retained output", { ...current, commands: current.commands.map((item, index) => index === 1 ? { ...item, stderr: `${item.stderr}altered` } : item) }],
      ["totals", { ...current, totals: { ...current.totals, bun_fail: 1 } }],
      ["Bun skip evidence total", { ...current, totals: { ...current.totals, bun_skip: current.totals.bun_skip + 1 } }],
      ["Bun test evidence total", { ...current, totals: { ...current.totals, bun_total: current.totals.bun_total + 1 } }],
      ["manager skip evidence total", { ...current, totals: { ...current.totals, manager_skip: current.totals.manager_skip + 1 } }],
      ["manager test evidence total", { ...current, totals: { ...current.totals, manager_total: current.totals.manager_total + 1 } }],
      ["missing Bun skip output", alterOutput(1, (output) => output.replace(" 2 skip\n", "").replace("Ran 14 tests", "Ran 12 tests"))],
      ["altered Bun skip/total output", alterOutput(1, (output) => output.replace(" 2 skip", " 3 skip").replace("Ran 14 tests", "Ran 15 tests"))],
      ["missing Bun total output", alterOutput(1, (output) => output.replace(/Ran 14 tests across 3 files\.[^\n]*\n/, ""))],
      ["inconsistent Bun total output", alterOutput(1, (output) => output.replace("Ran 14 tests", "Ran 15 tests"))],
      ["missing manager skip output", alterOutput(2, (output) => output.replace(" 1 skip\n", "").replace("Ran 13 tests", "Ran 12 tests"))],
      ["altered manager skip/total output", alterOutput(2, (output) => output.replace(" 1 skip", " 2 skip").replace("Ran 13 tests", "Ran 14 tests"))],
      ["inconsistent manager total output", alterOutput(2, (output) => output.replace("Ran 13 tests", "Ran 14 tests"))],
      ["packed bytes", { ...current, package: { ...current.package, packed_bytes: current.package.packed_bytes + 1 } }],
      ["unpacked bytes", { ...current, package: { ...current.package, unpacked_bytes: current.package.unpacked_bytes + 1 } }],
      ["package mode", { ...current, package: { ...current.package, files: current.package.files.map((file, index) => index === 0 ? { ...file, mode: 493 } : file) } }],
      ["package size", { ...current, package: { ...current.package, files: current.package.files.map((file, index) => index === 0 ? { ...file, size: file.size + 1 } : file) } }],
      ["live source", { ...current, live: { ...current.live, source_sha256: "f".repeat(64) } }],
      ["release inputs", { ...current, release_inputs: { ...current.release_inputs, sha256: "f".repeat(64) } }],
    ]
    for (const [label, candidate] of cases) {
      expect(() => validateReleaseEvidenceSemantics(candidate, ROOT), label).toThrow()
    }
  }, 15_000)

  test("strict live semantics reject minimal, empty, wrong-tool, manifest, and registration evidence", () => {
    const directory = tempProject("alg-adversarial-live-evidence-")
    temporary.push(directory)
    const livePath = uniqueLiveEvidencePath(directory, verificationPluginConfiguration(ROOT).source.digest, "33333333-3333-4333-8333-333333333333")
    semanticEvidence(livePath)
    const current = JSON.parse(readFileSync(livePath, "utf8"))
    expect(() => validateRetainedLiveEvidence(current, ROOT)).not.toThrow()
    const cases = [
      { passed: true, server: { cleanup: { passed: true } }, tui: { cleanup: { passed: true } } },
      { ...structuredClone(current), schema_version: 1 },
      { ...structuredClone(current), kind: "other-live-proof" },
      (() => { const candidate = structuredClone(current); delete candidate.schema_version; return candidate })(),
      { ...structuredClone(current), unknown_critical_field: true },
      { ...structuredClone(current), plugin_source: { ...structuredClone(current.plugin_source), unknown: true } },
      { ...structuredClone(current), isolation: { ...structuredClone(current.isolation), global_config_snapshots: { ...structuredClone(current.isolation.global_config_snapshots), before: { entries: [], sha256: digest }, after: { entries: [], sha256: digest } } } },
      { ...structuredClone(current), required_alg_tool_ids: ["alg_plan"] },
      { ...structuredClone(current), plugin_source: { ...structuredClone(current.plugin_source), runtime_manifest: { ...structuredClone(current.plugin_source.runtime_manifest), entries: [] } } },
      { ...structuredClone(current), plugin_source: { ...structuredClone(current.plugin_source), registrations: { server: ["file:///wrong"], tui: ["file:///wrong"] } } },
      { ...structuredClone(current), no_model_calls: false },
      { ...structuredClone(current), temporary_environment_removed: false },
      { ...structuredClone(current), server: { ...structuredClone(current.server), stdout_tail: "", stderr_tail: "" } },
      { ...structuredClone(current), server: { ...structuredClone(current.server), stdout_tail: current.server.stdout_tail.replace("skill_evolution_enabled=false", "skill_evolution_enabled=true") } },
      { ...structuredClone(current), server: { ...structuredClone(current.server), parsed_alg_ids: ["alg_plan"] } },
      { ...structuredClone(current), server: { ...structuredClone(current.server), source_identity_log: current.server.source_identity_log.replace("entry=server", "entry=tui") } },
      { ...structuredClone(current), server: { ...structuredClone(current.server), cleanup: { ...structuredClone(current.server.cleanup), passed: false } } },
      { ...structuredClone(current), tui: { ...structuredClone(current.tui), cleanup: { ...structuredClone(current.tui.cleanup), passed: false } } },
      { ...structuredClone(current), isolation: { ...structuredClone(current.isolation), project_config_disabled: false } },
      { ...structuredClone(current), isolation: { ...structuredClone(current.isolation), global_config_snapshots: { ...structuredClone(current.isolation.global_config_snapshots), unchanged: false } } },
    ]
    for (const candidate of cases) expect(() => validateRetainedLiveEvidence(candidate, ROOT)).toThrow()
  })

  test("resolves npm by fixed canonical siblings with spaces and never parses a malicious cmd shim", () => {
    const root = tempProject("alg npm resolver with spaces-")
    temporary.push(root)
    const bin = join(root, "Node Install With Spaces")
    const cli = join(bin, "node_modules", "npm", "bin", "npm-cli.js")
    mkdirSync(join(bin, "node_modules", "npm", "bin"), { recursive: true })
    writeFileSync(join(bin, "npm.cmd"), "@echo MALICIOUS-SHIM-MUST-NOT-RUN\r\n")
    writeFileSync(join(bin, "node.exe"), "fixture node")
    writeFileSync(cli, "fixture cli")
    expect(resolveNpmInvocation({ platform: "win32", pathEntries: [bin] })).toEqual({
      executable: join(bin, "node.exe"), argsPrefix: [cli],
    })
    writeFileSync(cli, "")
    expect(resolveNpmInvocation({ platform: "win32", pathEntries: [bin] }).argsPrefix).toEqual([cli])
  })

  test("rejects unresolvable or non-file npm shims and supports a resolved POSIX executable", () => {
    const root = tempProject("alg npm resolver failures-")
    temporary.push(root)
    expect(() => resolveNpmInvocation({ platform: "win32", pathEntries: [root] })).toThrow("Unable to resolve regular npm.cmd")
    mkdirSync(join(root, "npm.cmd"))
    expect(() => resolveNpmInvocation({ platform: "win32", pathEntries: [root] })).toThrow("regular npm.cmd")
    const posix = join(root, "posix")
    mkdirSync(posix)
    const npm = join(posix, "npm")
    writeFileSync(npm, "#!/bin/sh\nexit 0\n")
    chmodSync(npm, 0o755)
    expect(resolveNpmInvocation({ platform: "linux", pathEntries: [posix] })).toEqual({ executable: npm, argsPrefix: [] })
  })

  test("rejects an actual npm CLI directory junction/symlink escape", () => {
    const root = tempProject("alg-npm-junction-escape-")
    temporary.push(root)
    const bin = join(root, "installation")
    const outside = join(root, "outside-npm")
    mkdirSync(join(bin, "node_modules"), { recursive: true })
    mkdirSync(join(outside, "bin"), { recursive: true })
    writeFileSync(join(bin, "npm.cmd"), "@exit /b 0\r\n")
    writeFileSync(join(bin, "node.exe"), "node")
    writeFileSync(join(outside, "bin", "npm-cli.js"), "cli")
    symlinkSync(outside, join(bin, "node_modules", "npm"), process.platform === "win32" ? "junction" : "dir")
    expect(() => resolveNpmInvocation({ platform: "win32", pathEntries: [bin] })).toThrow("CLI escapes")
  })

  test.each(["node executable", "CLI"])("deterministic realpath seam rejects independent %s escape", (escaped) => {
    const root = resolve("C:/fixture/npm-install")
    const outside = resolve(`C:/outside/${escaped === "CLI" ? "npm-cli.js" : "node.exe"}`)
    const canonical = (path: string) => {
      if (escaped === "node executable" && path.endsWith("node.exe")) return outside
      if (escaped === "CLI" && path.endsWith("npm-cli.js")) return outside
      return resolve(path)
    }
    expect(() => resolveNpmInvocation({
      platform: "win32",
      pathEntries: [root],
      filesystem: { exists: () => true, isFile: () => true, realpath: canonical },
    })).toThrow(`${escaped} escapes`)
  })

  test("complete package allowlist rejects extras, missing paths, duplicates, unsafe paths, and bad modes", () => {
    const expected = expectedPackedPaths()
    const files = expected.map((path) => ({ path, mode: 420 }))
    expect(validatePackedInventory(files, expected).paths).toEqual(expected)
    expect(() => validatePackedInventory([...files, { path: "scripts/unexpected.ts", mode: 420 }], expected)).toThrow("complete reviewed allowlist")
    expect(() => validatePackedInventory(files.slice(1), expected)).toThrow("complete reviewed allowlist")
    expect(() => validatePackedInventory([...files, files[0]!], expected)).toThrow("duplicate")
    expect(() => validatePackedInventory([...files.slice(0, -1), { path: "../escape", mode: 420 }], expected)).toThrow("unsafe")
    expect(() => validatePackedInventory(files.map((file, index) => index === 0 ? { ...file, mode: 493 } : file), expected)).toThrow("0644")

    const injectedRoot = tempProject("alg-pack-injected-file-")
    temporary.push(injectedRoot)
    for (const directory of ["src", "templates", "agents", "scripts"]) mkdirSync(join(injectedRoot, directory))
    writeFileSync(join(injectedRoot, "package.json"), "{}\n")
    writeFileSync(join(injectedRoot, "src", "index.ts"), "export {}\n")
    writeFileSync(join(injectedRoot, "templates", "one.json"), "{}\n")
    writeFileSync(join(injectedRoot, "agents", "one.md"), "# one\n")
    writeFileSync(join(injectedRoot, "scripts", "unexpected.ts"), "export const unexpected = true\n")
    const fixtureExpected = expectedPackedPaths(injectedRoot)
    expect(fixtureExpected).not.toContain("scripts/unexpected.ts")
    expect(() => validatePackedInventory([
      ...fixtureExpected.map((path) => ({ path, mode: 420 })),
      { path: "scripts/unexpected.ts", mode: 420 },
    ], fixtureExpected)).toThrow("complete reviewed allowlist")
  })
})

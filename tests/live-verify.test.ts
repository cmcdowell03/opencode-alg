import { describe, expect, test } from "bun:test"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { fileURLToPath } from "node:url"
import {
  ALG_TOOL_IDS,
  assertLoadedCheckoutEvidence,
  assertVerificationPluginConfiguration,
  findTuiRegistrationLine,
  findSourceIdentityLine,
  fetchToolIds,
  OPENCODE_ENGINE_REQUIREMENT,
  parseStableVersion,
  persistImmutableLiveEvidence,
  prepareLiveEvidenceDestination,
  removeTemporaryEnvironment,
  realUserGlobalConfigRoots,
  retainedLiveEvidencePassed,
  runVersionCommand,
  snapshotGlobalOpenCodeConfig,
  liveVerificationPassed,
  stopCapturedProcess,
  ToolReadinessError,
  uniqueLiveEvidencePath,
  type CapturedProcess,
  validateOpenCodeVersion,
  verificationPluginConfiguration,
  verifyRetainedLiveEvidenceArtifact,
  VersionCommandError,
} from "../scripts/live-verify.ts"
import {
  ALG_TUI_REGISTRATION_SERVICE,
  ALG_TUI_REGISTRATION_TOKEN,
} from "../src/tui-registration.ts"
import { computeAlgSourceIdentity, sourceIdentityMessage } from "../src/source-identity.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function runtimeSourceFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "alg-source-identity-test-"))
  for (const directory of ["src/nested", "templates", "agents", "tests", "docs"]) {
    mkdirSync(join(root, directory), { recursive: true })
  }
  const files: Record<string, string> = {
    "package.json": '{"name":"fixture","version":"1.0.0"}\n',
    "src/tools.ts": "export const tools = 1\n",
    "src/store.ts": "export const store = 1\n",
    "src/executor.ts": "export const executor = 1\n",
    "src/nested/runtime.ts": "export const nested = 1\n",
    "templates/coding.json": '{"name":"coding"}\n',
    "agents/checker.md": "# Checker\n",
  }
  for (const [path, contents] of Object.entries(files)) writeFileSync(join(root, path), contents)
  return root
}

describe("complete bounded runtime source identity", () => {
  test("sorts and records every runtime source path with byte counts", () => {
    const root = runtimeSourceFixture()
    try {
      const identity = computeAlgSourceIdentity(root)
      const paths = identity.manifest.map((entry) => entry.path)
      expect(paths).toEqual([...paths].sort())
      expect(paths).toEqual([
        "agents/checker.md",
        "package.json",
        "src/executor.ts",
        "src/nested/runtime.ts",
        "src/store.ts",
        "src/tools.ts",
        "templates/coding.json",
      ])
      expect(identity.file_count).toBe(identity.manifest.length)
      expect(identity.total_bytes).toBe(identity.manifest.reduce((total, entry) => total + entry.bytes, 0))
      expect(identity.digest).toMatch(/^[a-f0-9]{64}$/)
      expect(computeAlgSourceIdentity(root)).toEqual(identity)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("changes for tools, store, executor, templates, agents, and untracked runtime modules", () => {
    const root = runtimeSourceFixture()
    try {
      const original = computeAlgSourceIdentity(root).digest
      for (const path of [
        "package.json",
        "src/tools.ts",
        "src/store.ts",
        "src/executor.ts",
        "templates/coding.json",
        "agents/checker.md",
      ]) {
        const absolute = join(root, path)
        const before = readFileSync(absolute, "utf8")
        writeFileSync(absolute, `${before}changed\n`)
        expect(computeAlgSourceIdentity(root).digest).not.toBe(original)
        writeFileSync(absolute, before)
      }
      writeFileSync(join(root, "src", "untracked-runtime.ts"), "export const untracked = true\n")
      const withUntracked = computeAlgSourceIdentity(root)
      expect(withUntracked.digest).not.toBe(original)
      expect(withUntracked.manifest.map((entry) => entry.path)).toContain("src/untracked-runtime.ts")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("excludes tests, docs, verifier evidence, scripts, and unrelated shipped files", () => {
    const root = runtimeSourceFixture()
    try {
      const original = computeAlgSourceIdentity(root)
      mkdirSync(join(root, "scripts"))
      writeFileSync(join(root, "tests", "runtime.test.ts"), "test only\n")
      writeFileSync(join(root, "docs", "release.md"), "docs only\n")
      writeFileSync(join(root, "scripts", "verify.ts"), "verifier only\n")
      writeFileSync(join(root, "live-verification-evidence.json"), "{}\n")
      writeFileSync(join(root, "README.md"), "readme only\n")
      expect(computeAlgSourceIdentity(root)).toEqual(original)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("fails closed on a source symlink or junction", () => {
    const root = runtimeSourceFixture()
    const target = mkdtempSync(join(tmpdir(), "alg-source-link-target-"))
    try {
      writeFileSync(join(target, "redirected.ts"), "export const redirected = true\n")
      symlinkSync(target, join(root, "src", "redirected"), process.platform === "win32" ? "junction" : "dir")
      expect(() => computeAlgSourceIdentity(root)).toThrow(/symlink or junction/)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  test("fails before reading past per-file, aggregate, or file-count bounds", () => {
    const root = runtimeSourceFixture()
    try {
      expect(() => computeAlgSourceIdentity(root, { maxFileBytes: 8 })).toThrow(/source file exceeds 8 bytes/)
      expect(() => computeAlgSourceIdentity(root, { maxTotalBytes: 16 })).toThrow(/aggregate bytes/)
      expect(() => computeAlgSourceIdentity(root, { maxFiles: 2 })).toThrow(/exceeds 2 files/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("live verifier OpenCode compatibility", () => {
  test("derives the verifier requirement from package metadata", () => {
    const packageJson = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"))
    expect(OPENCODE_ENGINE_REQUIREMENT).toBe(packageJson.engines.opencode)
    expect(OPENCODE_ENGINE_REQUIREMENT).toBe(">=1.18.0")
  })

  test.each(["1.18.0", "1.18.18"])("accepts compatible stable version %s", (version) => {
    expect(validateOpenCodeVersion(version)).toEqual({
      compatible: true,
      requirement: ">=1.18.0",
      parsed: {
        text: version,
        major: 1,
        minor: 18,
        patch: version === "1.18.0" ? 0 : 18,
      },
      reason: `OpenCode ${version} satisfies >=1.18.0`,
    })
  })

  test("rejects a stable version below the declared minimum", () => {
    expect(validateOpenCodeVersion("1.17.99")).toMatchObject({
      compatible: false,
      requirement: ">=1.18.0",
      parsed: { text: "1.17.99", major: 1, minor: 17, patch: 99 },
      reason: "OpenCode 1.17.99 does not satisfy >=1.18.0",
    })
  })

  test.each([
    ["blank", ""],
    ["malformed", "OpenCode 1.18.18"],
    ["prerelease", "1.18.18-beta.1"],
    ["build metadata", "1.18.18+build.1"],
    ["oversized component", "1.18.1000000"],
  ])("rejects unsupported %s output", (_label, output) => {
    expect(parseStableVersion(output)).toBeNull()
    expect(validateOpenCodeVersion(output)).toEqual({
      compatible: false,
      requirement: ">=1.18.0",
      parsed: null,
      reason: "runtime output is not a stable MAJOR.MINOR.PATCH version",
    })
  })
})

describe("real-user global OpenCode config preservation snapshots", () => {
  const key = Buffer.alloc(32, 7)

  test("resolves roots only from the pre-isolation environment and deduplicates HOME/XDG", () => {
    const home = resolve(tmpdir(), "alg-global-root-home")
    expect(realUserGlobalConfigRoots({ HOME: home, XDG_CONFIG_HOME: join(home, ".config") }, "linux")).toEqual([
      { scope: "xdg", path: join(home, ".config", "opencode") },
    ])
    expect(() => realUserGlobalConfigRoots({ HOME: "relative-home" }, "linux")).toThrow("must be absolute")
  })

  test("unchanged metadata and keyed fingerprints compare exactly without retaining contents or absolute paths", () => {
    const base = mkdtempSync(join(tmpdir(), "alg-global-config-unchanged-"))
    const root = join(base, "opencode")
    try {
      mkdirSync(root)
      writeFileSync(join(root, "opencode.json"), '{"token":"must-not-appear"}\n')
      const before = snapshotGlobalOpenCodeConfig([{ scope: "fixture", path: root }], key)
      const after = snapshotGlobalOpenCodeConfig([{ scope: "fixture", path: root }], key)
      expect(after).toEqual(before)
      expect(JSON.stringify(before)).not.toContain("must-not-appear")
      expect(JSON.stringify(before)).not.toContain(base)
      expect(before.entries.find((entry) => entry.relative_path === "opencode.json")?.content_hmac_sha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test.each(["create", "mutate", "delete"] as const)("detects %s of an allowlisted config", (action) => {
    const base = mkdtempSync(join(tmpdir(), `alg-global-config-${action}-`))
    const root = join(base, "opencode")
    try {
      if (action !== "create") {
        mkdirSync(root)
        writeFileSync(join(root, "opencode.jsonc"), '{"value":"before"}\n')
      }
      const before = snapshotGlobalOpenCodeConfig([{ scope: "fixture", path: root }], key)
      if (action === "create") {
        mkdirSync(root)
        writeFileSync(join(root, "opencode.jsonc"), '{"value":"created"}\n')
      } else if (action === "mutate") {
        writeFileSync(join(root, "opencode.jsonc"), '{"value":"mutate"}\n')
      } else {
        rmSync(join(root, "opencode.jsonc"))
      }
      const after = snapshotGlobalOpenCodeConfig([{ scope: "fixture", path: root }], key)
      expect(after).not.toEqual(before)
      expect(after.sha256).not.toBe(before.sha256)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  test("rejects a symlink or junction in an allowlisted config path", () => {
    const base = mkdtempSync(join(tmpdir(), "alg-global-config-link-"))
    const root = join(base, "opencode")
    try {
      const target = join(base, "target")
      mkdirSync(target)
      symlinkSync(target, root, process.platform === "win32" ? "junction" : "dir")
      expect(() => snapshotGlobalOpenCodeConfig([{ scope: "fixture", path: root }], key)).toThrow(/symlink or junction/)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe("live verifier reviewed-checkout binding", () => {
  test("builds isolated server and TUI registrations for the exact current package root and entry points", () => {
    const configuration = verificationPluginConfiguration(ROOT)
    expect(() => assertVerificationPluginConfiguration(configuration, ROOT)).not.toThrow()
    expect(configuration.source.root).toBe(ROOT)
    expect(configuration.source.spec).toMatch(/^file:\/\//)
    expect(configuration.source.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(configuration.server_config).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugin: [configuration.source.spec],
    })
    expect(configuration.tui_config).toEqual({
      $schema: "https://opencode.ai/tui.json",
      plugin: [configuration.source.spec],
    })
    expect(configuration.entry_points).toEqual({
      server: resolve(ROOT, "src", "server.ts"),
      tui: resolve(ROOT, "src", "tui.ts"),
    })
  })

  test("rejects a wrong package spec, checkout identity, or entry point", () => {
    const current = verificationPluginConfiguration(ROOT)
    const cases = [
      { ...structuredClone(current), server_config: { ...current.server_config, plugin: ["file:///stale/global/plugin"] } },
      { ...structuredClone(current), source: { ...current.source, root: resolve(ROOT, "..", "wrong-checkout") } },
      { ...structuredClone(current), source: { ...current.source, digest: "0".repeat(64) } },
      { ...structuredClone(current), entry_points: { ...current.entry_points, tui: resolve(ROOT, "src", "server.ts") } },
    ]
    for (const configuration of cases) {
      expect(() => assertVerificationPluginConfiguration(configuration as any, ROOT)).toThrow(
        "does not bind both entry points to the reviewed package checkout",
      )
    }
  })

  test("stale/global-only tool and TUI evidence cannot satisfy checkout proof", () => {
    const { source } = verificationPluginConfiguration(ROOT)
    const staleOnly = [
      '["alg_plan","alg_run","alg_status"]',
      `INFO service=${ALG_TUI_REGISTRATION_SERVICE} ${ALG_TUI_REGISTRATION_TOKEN}`,
    ].join("\n")
    expect(findTuiRegistrationLine(staleOnly)).toBeDefined()
    expect(findSourceIdentityLine(staleOnly, "server", source)).toBeUndefined()
    expect(() => assertLoadedCheckoutEvidence(staleOnly, staleOnly, source)).toThrow(
      "did not both prove the reviewed checkout source identity",
    )
  })

  test("requires exact current-checkout markers from both server and TUI", () => {
    const { source } = verificationPluginConfiguration(ROOT)
    const server = `INFO service=${ALG_TUI_REGISTRATION_SERVICE} ${sourceIdentityMessage("server", source)}`
    const tui = `INFO service=${ALG_TUI_REGISTRATION_SERVICE} ${sourceIdentityMessage("tui", source)}`
    expect(assertLoadedCheckoutEvidence(server, tui, source)).toEqual({ server, tui })

    const wrong = { ...source, digest: "f".repeat(64) }
    const staleServer = `INFO service=${ALG_TUI_REGISTRATION_SERVICE} ${sourceIdentityMessage("server", wrong)}`
    expect(() => assertLoadedCheckoutEvidence(staleServer, tui, source)).toThrow()
  })
})

describe("server tool registration readiness", () => {
  test("keeps polling after an initial empty 200 until source identity and exact tools are ready", async () => {
    const identity = computeAlgSourceIdentity(ROOT)
    let output = "server listening\n"
    let requests = 0
    const process = captured({ pid: 301, exitCode: null }, output)
    process.stdout = () => output
    const result = await fetchToolIds("http://unit.test/experimental/tool/ids", process, identity, {
      timeoutMs: 100,
      pollIntervalMs: 1,
      requestTimeoutMs: 20,
      request: async () => {
        requests++
        if (requests === 1) return { status: 200, text: async () => "" }
        output += `INFO service=${ALG_TUI_REGISTRATION_SERVICE} ${sourceIdentityMessage("server", identity)}\n`
        return { status: 200, text: async () => JSON.stringify(ALG_TOOL_IDS) }
      },
    })
    expect(result).toMatchObject({ status: 200, ids: [...ALG_TOOL_IDS], attempts: 2 })
    expect(result.sourceIdentityLog).toContain("entry=server")
    expect(requests).toBe(2)
  })

  test("a permanent empty 200 remains a bounded readiness failure with diagnostics", async () => {
    const identity = computeAlgSourceIdentity(ROOT)
    const output = `INFO service=${ALG_TUI_REGISTRATION_SERVICE} ${sourceIdentityMessage("server", identity)}\n`
    let failure: unknown
    try {
      await fetchToolIds(
        "http://unit.test/experimental/tool/ids",
        captured({ pid: 302, exitCode: null }, output, "plugin still loading"),
        identity,
        {
          timeoutMs: 12,
          pollIntervalMs: 1,
          requestTimeoutMs: 5,
          request: async () => ({ status: 200, text: async () => "" }),
        },
      )
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(ToolReadinessError)
    expect((failure as ToolReadinessError).message).toContain("readiness timeout after 12 ms")
    expect((failure as ToolReadinessError).message).toContain("plugin still loading")
    expect((failure as ToolReadinessError).evidence).toMatchObject({
      last_http_status: 200,
      last_http_body: "",
      parsed_alg_ids: [],
      source_identity_log: expect.stringContaining("entry=server"),
    })
    expect((failure as ToolReadinessError).evidence.attempts).toBeGreaterThan(0)
  })
})

describe("retained live evidence destination confinement", () => {
  function destinationFixture(): {
    base: string
    repository: string
    plugin: string
    evidenceRoot: string
    siblingRepository: string
  } {
    const base = mkdtempSync(join(tmpdir(), "alg-evidence-path-test-"))
    const repository = join(base, "OC_Plugins")
    const plugin = join(repository, "plugins", "opencode-alg")
    const evidenceRoot = join(base, "dedicated-evidence")
    const siblingRepository = join(base, "sibling-repository")
    for (const path of [join(repository, ".git"), plugin, evidenceRoot, join(siblingRepository, ".git")]) {
      mkdirSync(path, { recursive: true })
    }
    return { base, repository, plugin, evidenceRoot, siblingRepository }
  }

  test("rejects a lexical path anywhere in the containing repository", () => {
    const fixture = destinationFixture()
    try {
      expect(() => prepareLiveEvidenceDestination(
        join(fixture.repository, "verification-evidence", "live.json"),
        { pluginRoot: fixture.plugin, tempEvidenceRoot: fixture.evidenceRoot, approvedEvidenceRoot: null },
      )).toThrow(/outside the entire containing repository/)
      expect(() => prepareLiveEvidenceDestination(
        join(fixture.repository, "plugins", "sibling-plugin", "live.json"),
        { pluginRoot: fixture.plugin, tempEvidenceRoot: fixture.evidenceRoot, approvedEvidenceRoot: null },
      )).toThrow(/outside the entire containing repository/)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  test("rejects a sibling repository because it is outside the dedicated evidence root", () => {
    const fixture = destinationFixture()
    try {
      expect(() => prepareLiveEvidenceDestination(
        join(fixture.siblingRepository, "live.json"),
        { pluginRoot: fixture.plugin, tempEvidenceRoot: fixture.evidenceRoot, approvedEvidenceRoot: null },
      )).toThrow(/dedicated external evidence root/)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  test("rejects symlink or junction parent redirection into the repository", () => {
    const fixture = destinationFixture()
    try {
      symlinkSync(
        fixture.repository,
        join(fixture.evidenceRoot, "redirect"),
        process.platform === "win32" ? "junction" : "dir",
      )
      expect(() => prepareLiveEvidenceDestination(
        join(fixture.evidenceRoot, "redirect", "live.json"),
        { pluginRoot: fixture.plugin, tempEvidenceRoot: fixture.evidenceRoot, approvedEvidenceRoot: null },
      )).toThrow(/symlink or junction/)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  test("creates and accepts a plain destination under the dedicated external root", () => {
    const fixture = destinationFixture()
    try {
      const destination = join(fixture.evidenceRoot, "nested", "live.json")
      const prepared = prepareLiveEvidenceDestination(destination, {
        pluginRoot: fixture.plugin,
        tempEvidenceRoot: fixture.evidenceRoot,
        approvedEvidenceRoot: null,
      })
      expect(prepared.path).toBe(resolve(destination))
      expect(prepared.repository_root).toBe(resolve(fixture.repository))
      expect(prepared.evidence_root).toBe(resolve(fixture.evidenceRoot))
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  test("unique no-clobber live artifacts preserve the first run and reject deterministic/colliding paths", () => {
    const fixture = destinationFixture()
    try {
      const source = verificationPluginConfiguration(ROOT).source.digest
      const firstPath = uniqueLiveEvidencePath(fixture.evidenceRoot, source, "11111111-1111-4111-8111-111111111111")
      const secondPath = uniqueLiveEvidencePath(fixture.evidenceRoot, source, "22222222-2222-4222-8222-222222222222")
      const firstBytes = Buffer.from("first immutable live run\n")
      const secondBytes = Buffer.from("second immutable live run\n")
      const first = persistImmutableLiveEvidence(firstPath, firstBytes)
      const before = readFileSync(firstPath)
      const second = persistImmutableLiveEvidence(secondPath, secondBytes)
      expect(first.path).not.toBe(second.path)
      expect(existsSync(first.path)).toBe(true)
      expect(existsSync(second.path)).toBe(true)
      expect(readFileSync(first.path)).toEqual(before)
      expect(first.sha256).toBe(createHash("sha256").update(before).digest("hex"))
      expect(() => persistImmutableLiveEvidence(firstPath, Buffer.from("collision\n"))).toThrow("no-clobber")
      expect(readFileSync(firstPath)).toEqual(firstBytes)
      const stale = join(fixture.evidenceRoot, `live-verification-${source.slice(0, 16)}.json`)
      writeFileSync(stale, "{}\n")
      expect(() => verifyRetainedLiveEvidenceArtifact(stale, { source_sha256: source })).toThrow("filename is not unique")
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  test.each(["before-final-check", "after-final-check"] as const)("same-byte final replacement %s is preserved and rejected by identity", (seam) => {
    const fixture = destinationFixture()
    try {
      const source = verificationPluginConfiguration(ROOT).source.digest
      const path = uniqueLiveEvidencePath(fixture.evidenceRoot, source, "33333333-3333-4333-8333-333333333333")
      const bytes = Buffer.from("same bytes, foreign final identity\n")
      const replace = (_temporary: string, final: string) => {
        rmSync(final)
        writeFileSync(final, bytes, { flag: "wx" })
      }
      expect(() => persistImmutableLiveEvidence(path, bytes, seam === "before-final-check"
        ? { afterLink: replace }
        : { afterFinalVerified: replace })).toThrow(/identity|no-clobber/)
      expect(readFileSync(path)).toEqual(bytes)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  test("same-name temporary replacement is preserved and causes publication failure", () => {
    const fixture = destinationFixture()
    try {
      const source = verificationPluginConfiguration(ROOT).source.digest
      const path = uniqueLiveEvidencePath(fixture.evidenceRoot, source, "44444444-4444-4444-8444-444444444444")
      const bytes = Buffer.from("immutable final bytes\n")
      const foreign = Buffer.from("foreign temporary bytes\n")
      let temporary = ""
      expect(() => persistImmutableLiveEvidence(path, bytes, {
        afterFinalVerified(temp) {
          temporary = temp
          rmSync(temp)
          writeFileSync(temp, foreign, { flag: "wx" })
        },
      })).toThrow(/temporary preserved|identity/)
      expect(readFileSync(path)).toEqual(bytes)
      expect(readFileSync(temporary)).toEqual(foreign)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })

  test("retained verification requires the publication identity and rejects a same-byte replacement", () => {
    const fixture = destinationFixture()
    try {
      const source = verificationPluginConfiguration(ROOT).source.digest
      const path = uniqueLiveEvidencePath(fixture.evidenceRoot, source, "55555555-5555-4555-8555-555555555555")
      const bytes = Buffer.from("not semantic live evidence\n")
      const published = persistImmutableLiveEvidence(path, bytes)
      rmSync(path)
      writeFileSync(path, bytes, { flag: "wx" })
      expect(() => verifyRetainedLiveEvidenceArtifact(path, {
        source_sha256: source,
        sha256: published.sha256,
        bytes: published.bytes,
        identity: published.identity,
      })).toThrow("identity differs")
      expect(readFileSync(path)).toEqual(bytes)
    } finally {
      rmSync(fixture.base, { recursive: true, force: true })
    }
  })
})

function captured(child: { pid?: number; exitCode: number | null }, stdout = "", stderr = ""): CapturedProcess {
  return {
    child: child as unknown as CapturedProcess["child"],
    stdout: () => stdout,
    stderr: () => stderr,
    exit: () => ({
      observed: child.exitCode !== null,
      code: typeof child.exitCode === "number" ? child.exitCode : null,
      signal: null,
    }),
  }
}

describe("live verifier cleanup gate", () => {
  test("accepts an already-exited one-shot process without claiming termination", async () => {
    const evidence = await stopCapturedProcess(captured({ pid: 101, exitCode: 0 }))
    expect(evidence).toMatchObject({
      root_pid: 101,
      exit_observed: true,
      exit_code: 0,
      termination_attempted: false,
      termination_result: "already-exited",
      tree_termination_attempted: false,
      passed: true,
    })
  })

  test("requires successful termination and observed root exit", async () => {
    const child = { pid: 102, exitCode: null as number | null, kill: () => true }
    const evidence = await stopCapturedProcess(captured(child), {
      platform: "linux",
      terminationTimeoutMs: 20,
      exitTimeoutMs: 20,
      pollIntervalMs: 1,
      terminateTree: async () => { child.exitCode = 0 },
    })
    expect(evidence).toMatchObject({
      root_pid: 102,
      cleanup_scope: "posix-process-group",
      exit_observed: true,
      tree_termination_attempted: true,
      tree_termination_result: "succeeded",
      termination_result: "succeeded",
      passed: true,
    })
  })

  test("termination failure cannot pass even when best-effort kill observes root exit", async () => {
    const child = {
      pid: 103,
      exitCode: null as number | null,
      kill: () => {
        child.exitCode = 137
        return true
      },
    }
    const evidence = await stopCapturedProcess(captured(child), {
      platform: "linux",
      terminationTimeoutMs: 20,
      exitTimeoutMs: 20,
      pollIntervalMs: 1,
      terminateTree: async () => { throw new Error("injected termination failure") },
    })
    expect(evidence).toMatchObject({
      exit_observed: true,
      tree_termination_result: "failed",
      best_effort_kill_attempted: true,
      passed: false,
    })
    expect(evidence.error).toContain("injected termination failure")
  })

  test("termination timeout remains failed after bounded best-effort cleanup", async () => {
    const child = {
      pid: 104,
      exitCode: null as number | null,
      kill: () => {
        child.exitCode = 137
        return true
      },
    }
    const evidence = await stopCapturedProcess(captured(child), {
      platform: "linux",
      terminationTimeoutMs: 5,
      exitTimeoutMs: 10,
      pollIntervalMs: 1,
      terminateTree: () => new Promise<void>(() => {}),
    })
    expect(evidence).toMatchObject({
      exit_observed: true,
      tree_termination_result: "timed-out",
      termination_result: "timed-out",
      best_effort_kill_attempted: true,
      passed: false,
    })
    expect(evidence.error).toContain("exceeded 5 ms")
  })

  test("deterministic temporary remove failure cannot satisfy the final pass gate", async () => {
    const injected = Object.assign(new Error("injected remove failure"), { code: "EIO" })
    const removal = await removeTemporaryEnvironment("unused-test-path", {
      remove: () => { throw injected },
      exists: () => true,
      timeoutMs: 1,
      sleep: async () => {},
    })
    expect(removal).toEqual({ removed: false, error: "injected remove failure" })
    expect(liveVerificationPassed({
      verificationCompleted: true,
      failure: undefined,
      serverCleanup: { passed: true } as any,
      tuiCleanup: { passed: true } as any,
      temporaryEnvironmentRemoved: removal.removed,
    })).toBe(false)
  })

  test("temporary_environment_removed false fails even after successful process cleanup", () => {
    expect(liveVerificationPassed({
      verificationCompleted: true,
      failure: undefined,
      serverCleanup: { passed: true } as any,
      tuiCleanup: { passed: true } as any,
      temporaryEnvironmentRemoved: false,
    })).toBe(false)
    expect(liveVerificationPassed({
      verificationCompleted: true,
      failure: undefined,
      serverCleanup: { passed: true } as any,
      tuiCleanup: { passed: true } as any,
      temporaryEnvironmentRemoved: true,
    })).toBe(true)
    expect(retainedLiveEvidencePassed({
      passed: true,
      server: { cleanup: { passed: true } },
      tui: { cleanup: { passed: true } },
      temporary_environment_removed: false,
    })).toBe(false)
  })
})

describe("typed version command failure evidence", () => {
  test("timeout retains PID, output, exit observation, and successful termination evidence", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 201,
      exitCode: null as number | null,
      signalCode: null,
      kill: () => true,
    })
    let failure: unknown
    try {
      await runVersionCommand("opencode-test", ROOT, {
        timeoutMs: 5,
        captured: captured(child, "1.18.18\n", "version warning"),
        cleanupOptions: {
          platform: "linux",
          terminationTimeoutMs: 20,
          exitTimeoutMs: 20,
          pollIntervalMs: 1,
          terminateTree: async () => { child.exitCode = 143 },
        },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(VersionCommandError)
    const evidence = (failure as VersionCommandError).evidence
    expect(evidence).toMatchObject({
      command: ["opencode-test", "--version"],
      root_pid: 201,
      stdout: "1.18.18\n",
      stderr: "version warning",
      exit_observed: true,
      exit_code: 143,
      timeout_ms: 5,
      timed_out: true,
      passed: false,
      cleanup: {
        root_pid: 201,
        exit_observed: true,
        termination_attempted: true,
        termination_result: "succeeded",
        tree_termination_attempted: true,
        tree_termination_result: "succeeded",
        best_effort_kill_attempted: false,
        passed: true,
      },
    })
  })

  test("termination failure retains complete failed cleanup and fallback evidence", async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 202,
      exitCode: null as number | null,
      signalCode: null,
      kill: () => {
        child.exitCode = 137
        return true
      },
    })
    let failure: unknown
    try {
      await runVersionCommand("opencode-test", ROOT, {
        timeoutMs: 5,
        captured: captured(child, "partial-version", "cleanup stderr"),
        cleanupOptions: {
          platform: "linux",
          terminationTimeoutMs: 20,
          exitTimeoutMs: 20,
          pollIntervalMs: 1,
          terminateTree: async () => { throw new Error("injected version termination failure") },
        },
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(VersionCommandError)
    const evidence = (failure as VersionCommandError).evidence
    expect(evidence).toMatchObject({
      root_pid: 202,
      stdout: "partial-version",
      stderr: "cleanup stderr",
      exit_observed: true,
      exit_code: 137,
      timed_out: true,
      passed: false,
      cleanup: {
        root_pid: 202,
        exit_observed: true,
        termination_attempted: true,
        termination_result: "failed",
        tree_termination_attempted: true,
        tree_termination_result: "failed",
        best_effort_kill_attempted: true,
        passed: false,
      },
    })
    expect(evidence.cleanup.error).toContain("injected version termination failure")
  })
})

describe("exact live TUI registration evidence", () => {
  const registration = `INFO service=${ALG_TUI_REGISTRATION_SERVICE} ${ALG_TUI_REGISTRATION_TOKEN}`
  const emittedRegistration =
    `timestamp=2026-08-14T00:00:00.000Z level=INFO run=abc message=${JSON.stringify(ALG_TUI_REGISTRATION_TOKEN)}`

  test("accepts one bounded explicit service line carrying both registrations", () => {
    expect(findTuiRegistrationLine(`startup\n${registration}\nready`)).toBe(registration)
  })

  test("accepts the structured ALG TUI service message carrying both registrations", () => {
    expect(findTuiRegistrationLine(`startup\n${emittedRegistration}\nready`)).toBe(emittedRegistration)
  })

  test("accepts an exact structured JSON service/token pair", () => {
    const line = JSON.stringify({
      timestamp: "2026-08-14T00:00:00.000Z",
      service: ALG_TUI_REGISTRATION_SERVICE,
      message: ALG_TUI_REGISTRATION_TOKEN,
    })
    expect(findTuiRegistrationLine(line)).toBe(line)
  })

  test.each([
    ["negated token", `INFO service=opencode-alg not ${ALG_TUI_REGISTRATION_TOKEN}`],
    ["unrelated service", `INFO service=other ${ALG_TUI_REGISTRATION_TOKEN}`],
    ["unrelated JSON service", JSON.stringify({ service: "other", message: ALG_TUI_REGISTRATION_TOKEN })],
    ["extra command", `INFO service=opencode-alg ${ALG_TUI_REGISTRATION_TOKEN},/alg-other`],
    ["models only", "INFO service=opencode-alg OPENCODE_ALG_TUI_REGISTRATION_OK commands=/alg-models"],
    ["runs only", "INFO service=opencode-alg OPENCODE_ALG_TUI_REGISTRATION_OK commands=/alg-runs"],
    ["token embedded in prose", `INFO service=opencode-alg arbitrary prose ${ALG_TUI_REGISTRATION_TOKEN} done`],
    ["token embedded in message prose", `level=INFO message=\"prefix ${ALG_TUI_REGISTRATION_TOKEN} suffix\"`],
    ["unknown log field", `level=INFO unrelated=value message=${JSON.stringify(ALG_TUI_REGISTRATION_TOKEN)}`],
    ["oversized line", `INFO service=opencode-alg ${"x".repeat(4_096)} ${ALG_TUI_REGISTRATION_TOKEN}`],
  ])("rejects %s evidence", (_label, output) => {
    expect(findTuiRegistrationLine(output)).toBeUndefined()
  })
})

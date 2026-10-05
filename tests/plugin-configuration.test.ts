import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ALG_CONFIG_MAX_BYTES, resolvePluginConfiguration } from "../src/plugin-configuration.ts"

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "alg-plugin-config-test-"))
  roots.push(root)
  mkdirSync(join(root, "src"))
  return root
}
function put(path: string, value: unknown): void {
  writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value), "utf8")
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

describe("air-gapped plugin configuration", () => {
  test("uses package sidecar and replaces a whole section supplied by the SDK", () => {
    const root = fixture()
    put(join(root, "alg-plugin-config.json"), { sessionMemory: { mode: "observe", maxContextTokens: 4096 }, skillEvolution: { enabled: true } })
    const result = resolvePluginConfiguration({ sessionMemory: { mode: "off" } }, { root, env: {} })
    expect(result.source).toBe("sdk+sidecar")
    expect(result.options.sessionMemory?.mode).toBe("off")
    expect(result.options.sessionMemory?.maxContextTokens).toBe(8192)
    expect(result.options.skillEvolution?.enabled).toBe(true)
    expect(result.sidecar_present).toBe(true)
  })

  test("uses legacy src sidecar only when package-root sidecar is absent", () => {
    const root = fixture()
    put(join(root, "src", "alg-plugin-config.json"), { sessionMemory: { mode: "observe" } })
    expect(resolvePluginConfiguration(undefined, { root, env: {} }).source).toBe("legacy-sidecar")
    put(join(root, "alg-plugin-config.json"), { sessionMemory: { mode: "off" } })
    expect(() => resolvePluginConfiguration(undefined, { root, env: {} })).toThrow(/ambiguous/)
  })

  test("uses only an absolute explicit override and never loads from cwd", () => {
    const root = fixture()
    const cwdSidecar = join(root, "alg-plugin-config.json")
    const override = join(root, "override.json")
    put(cwdSidecar, { sessionMemory: { mode: "observe" } })
    put(override, { sessionMemory: { mode: "assist" } })
    const withoutOverride = resolvePluginConfiguration(undefined, { root: join(root, "src"), env: {} })
    expect(withoutOverride.source).toBe("defaults")
    const withOverride = resolvePluginConfiguration(undefined, { root, env: { OPENCODE_ALG_CONFIG: override } })
    expect(withOverride.source).toBe("override")
    expect(withOverride.options.sessionMemory?.mode).toBe("assist")
    expect(() => resolvePluginConfiguration(undefined, { root, env: { OPENCODE_ALG_CONFIG: "relative.json" } })).toThrow(/absolute path/)
  })

  test("fails closed and keeps malformed, oversized, and schema-invalid input sanitized", () => {
    const root = fixture()
    const path = join(root, "alg-plugin-config.json")
    put(path, "{ malformed secret-value")
    expect(() => resolvePluginConfiguration(undefined, { root, env: {} })).toThrow(/malformed JSON/)
    put(path, "x".repeat(ALG_CONFIG_MAX_BYTES + 1))
    expect(() => resolvePluginConfiguration(undefined, { root, env: {} })).toThrow(/exceeds 65536 bytes/)
    put(path, { unexpected_secret_value: "do-not-print-this" })
    let message = ""
    try { resolvePluginConfiguration(undefined, { root, env: {} }) } catch (error) { message = (error as Error).message }
    expect(message).toContain("strict options schema")
    expect(message).not.toContain("unexpected_secret_value")
    expect(message).not.toContain("do-not-print-this")
  })

  test("SDK option errors do not print unknown keys or submitted values", () => {
    const root = fixture()
    let message = ""
    try { resolvePluginConfiguration({ "private-submitted-key": "do-not-print-this" }, { root, env: {} }) }
    catch (error) { message = (error as Error).message }
    expect(message).toContain("SDK options do not match")
    expect(message).not.toContain("private-submitted-key")
    expect(message).not.toContain("do-not-print-this")
  })

  test("rejects a symlink sidecar where the host permits creating one", () => {
    const root = fixture()
    const target = join(root, "target.json")
    put(target, { sessionMemory: { mode: "observe" } })
    try { symlinkSync(target, join(root, "alg-plugin-config.json"), "file") }
    catch { return }
    expect(() => resolvePluginConfiguration(undefined, { root, env: {} })).toThrow(/non-symlink/)
  })
})

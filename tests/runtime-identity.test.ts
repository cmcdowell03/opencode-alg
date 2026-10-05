import { describe, expect, test } from "bun:test"
import { captureRuntimeIdentityAtModuleLoad, compareRuntimeIdentity, ALG_RUNTIME_IDENTITY_PROTOCOL } from "../src/runtime-identity.ts"
import { ALG_SOURCE_MANIFEST_MAX_FILE_BYTES } from "../src/source-identity.ts"

describe("deployment runtime identity", () => {
  test("freezes a bounded module-evaluation source observation", () => {
    const identity = captureRuntimeIdentityAtModuleLoad(process.cwd())
    expect(Object.isFrozen(identity)).toBe(true)
    expect(identity.protocol).toBe(ALG_RUNTIME_IDENTITY_PROTOCOL)
    expect(identity.source_manifest_at_module_load).toMatch(/^[a-f0-9]{64}$/)
    expect(ALG_SOURCE_MANIFEST_MAX_FILE_BYTES).toBeGreaterThan(0)
  })

  test("compares frozen module observation to current disk without claiming host loading", () => {
    const atLoad = Object.freeze({ protocol: ALG_RUNTIME_IDENTITY_PROTOCOL, build: "opencode-alg@fixture", source_manifest_at_module_load: "a".repeat(64) })
    expect(compareRuntimeIdentity(atLoad, { digest: "a".repeat(64) }).restart_required).toBe(false)
    const changed = compareRuntimeIdentity(atLoad, { digest: "b".repeat(64) })
    expect(changed.restart_required).toBe(true)
    expect(changed.source_manifest_at_module_load).toBe("a".repeat(64))
    expect(changed.disk_source_manifest_now).toBe("b".repeat(64))
    expect(changed.scope).toContain("not proof of upstream host loading")
    expect(compareRuntimeIdentity(atLoad, null).restart_required).toBeNull()
  })
})

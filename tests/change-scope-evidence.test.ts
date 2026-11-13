import { expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, unlinkSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { platform } from "node:process"
import { join } from "node:path"
import {
  captureChangeScopeBasis,
  ChangeScopeBasisSchema,
  ChangeScopeEvidenceSchema,
  ChangeScopeInputSchema,
  finishChangeScopeEvidence,
} from "../src/change-scope-evidence.ts"

test("explicit excluded roots cannot be certified as an empty unchanged scope", () => {
  for (const root of [".git", "node_modules", ".opencode/runs", "nested/.opencode/runs"]) {
    expect(ChangeScopeInputSchema.safeParse({ roots: [root], allowed_paths: [], max_changed_files: 0 }).success).toBe(false)
    expect(ChangeScopeInputSchema.safeParse({ roots: ["."], allowed_paths: [`${root}/file`], max_changed_files: 1 }).success).toBe(false)
  }
})

test("empty directory trees are bounded independently of file count", () => {
  const root = project()
  try {
    let path = root
    for (let depth = 0; depth < 34; depth++) { path = join(path, "d"); mkdirSync(path) }
    expect(() => captureChangeScopeBasis(root, { roots: ["."], allowed_paths: [], max_changed_files: 0 })).toThrow("limits_exceeded")
  } finally { rmSync(root, { recursive: true, force: true }) }
  const wide = project()
  try {
    for (let i = 0; i < 4097; i++) mkdirSync(join(wide, `d${i}`))
    expect(() => captureChangeScopeBasis(wide, { roots: ["."], allowed_paths: [], max_changed_files: 0 })).toThrow("limits_exceeded")
  } finally { rmSync(wide, { recursive: true, force: true }) }
})

test("a declared nested root cannot bypass an internal symlink ancestor", () => {
  const root = project(), link = join(root, "alias")
  let linked = false
  try {
    mkdirSync(join(root, "src", "child"), { recursive: true })
    symlinkSync(join(root, "src"), link, "junction"); linked = true
    expect(() => captureChangeScopeBasis(root, { roots: ["alias/child"], allowed_paths: [], max_changed_files: 0 })).toThrow("unsafe_entry")
  } finally {
    if (linked) (process.platform === "win32" ? rmdirSync : unlinkSync)(link)
    rmSync(root, { recursive: true, force: true })
  }
})

function project(): string {
  return mkdtempSync(join(tmpdir(), "alg-change-scope-"))
}

function scope(overrides: Record<string, unknown> = {}) {
  return { roots: ["src"], allowed_paths: ["src/allowed.ts"], max_changed_files: 4, ...overrides }
}

test("scope schema bounds and rejects unsafe, duplicate, overlapping, or out-of-root paths", () => {
  expect(ChangeScopeInputSchema.safeParse({ roots: ["."], allowed_paths: [], max_changed_files: 0 }).success).toBe(true)
  expect(ChangeScopeInputSchema.safeParse(scope({ roots: ["src", "src/lib"] })).success).toBe(false)
  expect(ChangeScopeInputSchema.safeParse(scope({ roots: ["Src", "src/lib"] })).success).toBe(platform !== "win32")
  expect(ChangeScopeInputSchema.safeParse(scope({ roots: ["src", "src"] })).success).toBe(false)
  expect(ChangeScopeInputSchema.safeParse(scope({ allowed_paths: ["other/file.ts"] })).success).toBe(false)
  expect(ChangeScopeInputSchema.safeParse(scope({ roots: ["../src"] })).success).toBe(false)
  expect(ChangeScopeInputSchema.safeParse(scope({ roots: ["C:/src"] })).success).toBe(false)
  expect(ChangeScopeInputSchema.safeParse(scope({ roots: Array(9).fill("src") })).success).toBe(false)
  expect(ChangeScopeInputSchema.safeParse(scope({ allowed_paths: Array.from({ length: 65 }, (_, i) => `src/${i}.ts`) })).success).toBe(false)
  expect(ChangeScopeInputSchema.safeParse(scope({ max_changed_files: 65 })).success).toBe(false)
})

test("content comparison reports allowed modifications, additions, and deletions", () => {
  const root = project()
  try {
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "allowed.ts"), "before")
    writeFileSync(join(root, "src", "remove.ts"), "remove me")
    const input = scope({ allowed_paths: ["src/allowed.ts", "src/new.ts", "src/remove.ts"] })
    const basis = captureChangeScopeBasis(root, input)
    writeFileSync(join(root, "src", "allowed.ts"), "after")
    writeFileSync(join(root, "src", "new.ts"), "new")
    rmSync(join(root, "src", "remove.ts"))
    const result = finishChangeScopeEvidence(root, input, basis)
    expect(result.status).toBe("within_scope")
    expect(result.changed).toEqual([
      { path: "src/allowed.ts", kind: "modified" },
      { path: "src/new.ts", kind: "added" },
      { path: "src/remove.ts", kind: "deleted" },
    ])
    expect(result.after_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(result.after_sha256).not.toBe(result.before_sha256)
    expect(ChangeScopeBasisSchema.safeParse(basis).success).toBe(true)
    expect(ChangeScopeEvidenceSchema.safeParse(result).success).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("protected changes and changed-file count overages violate the scope", () => {
  const root = project()
  try {
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "protected.ts"), "before")
    const input = scope({ allowed_paths: [], max_changed_files: 1 })
    const basis = captureChangeScopeBasis(root, input)
    writeFileSync(join(root, "src", "protected.ts"), "after")
    writeFileSync(join(root, "src", "new.ts"), "new")
    const result = finishChangeScopeEvidence(root, input, basis)
    expect(result.status).toBe("violated")
    expect(result.changed).toEqual([
      { path: "src/new.ts", kind: "added" },
      { path: "src/protected.ts", kind: "modified" },
    ])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("fixed exclusions are explicit and changes beneath them are invisible", () => {
  const root = project()
  try {
    mkdirSync(join(root, "src"))
    mkdirSync(join(root, ".git"), { recursive: true })
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true })
    mkdirSync(join(root, ".opencode", "runs", "run-a"), { recursive: true })
    writeFileSync(join(root, "src", "main.ts"), "main")
    writeFileSync(join(root, ".git", "config"), "git")
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "package")
    writeFileSync(join(root, ".opencode", "runs", "run-a", "evidence.json"), "run")
    const input = { roots: ["."], allowed_paths: [], max_changed_files: 0 }
    const basis = captureChangeScopeBasis(root, input)
    expect(basis.exclusions).toEqual([".git", "node_modules", ".opencode/runs"])
    expect(basis.files.map(file => file.path)).toEqual(["src/main.ts"])
    writeFileSync(join(root, ".git", "config"), "changed git")
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "changed package")
    writeFileSync(join(root, ".opencode", "runs", "run-a", "evidence.json"), "changed run")
    expect(finishChangeScopeEvidence(root, input, basis).status).toBe("within_scope")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("a symlink at an excluded directory name is skipped without traversal", () => {
  const root = project()
  const outside = project()
  const link = join(root, "node_modules")
  let linked = false
  try {
    mkdirSync(join(root, "src"))
    writeFileSync(join(outside, "secret.txt"), "secret")
    symlinkSync(outside, link, "junction"); linked = true
    const basis = captureChangeScopeBasis(root, { roots: ["."], allowed_paths: [], max_changed_files: 0 })
    expect(basis.files).toEqual([])
    expect(basis.exclusions).toContain("node_modules")
  } finally {
    if (linked) (process.platform === "win32" ? rmdirSync : unlinkSync)(link)
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("missing roots, symlink entries, and baseline tampering fail closed", () => {
  const root = project()
  const outside = project()
  const escapeLink = join(root, "src", "escape")
  let symlinkMade = false
  try {
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "file.ts"), "content")
    const input = scope({ allowed_paths: [] })
    const basis = captureChangeScopeBasis(root, input)
    expect(finishChangeScopeEvidence(root, input, { ...basis, files: [{ ...basis.files[0]!, sha256: "bad" }] }).failure).toBe("invalid_baseline")
    expect(finishChangeScopeEvidence(root, scope({ roots: ["missing"], allowed_paths: [] }), basis).failure).toBe("scope_mismatch")

    symlinkSync(outside, escapeLink, "junction"); symlinkMade = true
    if (symlinkMade) {
      expect(finishChangeScopeEvidence(root, input, basis)).toMatchObject({ status: "unavailable", failure: "unsafe_entry" })
    }
    expect(() => captureChangeScopeBasis(root, scope({ roots: ["missing"], allowed_paths: [] }))).toThrow("change_scope_missing_root")
  } finally {
    if (symlinkMade) (process.platform === "win32" ? rmdirSync : unlinkSync)(escapeLink)
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test("file count, per-file bytes, and total bytes are bounded", () => {
  const root = project()
  try {
    mkdirSync(join(root, "src"))
    for (let index = 0; index < 257; index++) writeFileSync(join(root, "src", `${index}.txt`), "x")
    expect(() => captureChangeScopeBasis(root, scope({ allowed_paths: [] }))).toThrow("change_scope_limits_exceeded")
    rmSync(join(root, "src"), { recursive: true, force: true })
    mkdirSync(join(root, "src"))
    writeFileSync(join(root, "src", "oversized"), Buffer.alloc(1024 * 1024 + 1))
    expect(() => captureChangeScopeBasis(root, scope({ allowed_paths: [] }))).toThrow("change_scope_limits_exceeded")
    rmSync(join(root, "src", "oversized"))
    for (let index = 0; index < 17; index++) writeFileSync(join(root, "src", `${index}.bin`), Buffer.alloc(1024 * 1024))
    expect(() => captureChangeScopeBasis(root, scope({ allowed_paths: [] }))).toThrow("change_scope_limits_exceeded")
  } finally { rmSync(root, { recursive: true, force: true }) }
})

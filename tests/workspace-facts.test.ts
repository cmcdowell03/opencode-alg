import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { localOrigin, publishEnvironment } from "../src/session-memory/environment.ts"
import { hashObject } from "../src/session-memory/store.ts"
import { detectWorkspaceOperation, resolveWorkspaceFacts } from "../src/workspace-facts.ts"
import { tempProject } from "./helpers.ts"

const projects: string[] = []
afterEach(() => { for (const path of projects.splice(0)) rmSync(path, { recursive: true, force: true }) })

describe("bounded workspace facts", () => {
  test("reads only requested facts from bounded package and Git metadata without executing commands", () => {
    const project = tempProject("alg-workspace-facts-"); projects.push(project)
    mkdirSync(join(project, ".git"), { recursive: true })
    writeFileSync(join(project, ".git", "config"), '[core]\nrepositoryformatversion = 0\n[remote "origin"]\nurl = https://example.test/team/repo.git\n')
    writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n")
    writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { test: "bun test --timeout 60000" } }))
    const memory = new SessionMemoryRuntime(project, { mode: "assist" })
    const facts = resolveWorkspaceFacts({ project, store: memory.store, checkpoint: memory.current("owner"),
      refs: ["repository.identity", "repository.remote", "test.command", "model.claim", "platform"] })
    expect(facts["repository.remote"]).toMatchObject({ state: "known", value: "https://example.test/team/repo.git" })
    expect(facts["repository.identity"]).toMatchObject({ state: "known", value: "https://example.test/team/repo.git#refs/heads/main" })
    expect(facts["test.command"]).toMatchObject({ state: "known", value: "bun test --timeout 60000", source: "package.json:scripts.test" })
    expect(facts.platform).toMatchObject({ state: "known", value: process.platform })
    expect(facts["model.claim"]).toBeUndefined()
  })

  test("keeps ambiguous, malformed and unrequested repository evidence unknown", () => {
    const project = tempProject("alg-workspace-facts-"); projects.push(project)
    mkdirSync(join(project, ".git"), { recursive: true })
    writeFileSync(join(project, ".git", "config"), '[remote "origin"]\nurl = one\nurl = two\n')
    writeFileSync(join(project, "package.json"), JSON.stringify({ scripts: { test: "" } }))
    const memory = new SessionMemoryRuntime(project)
    const facts = resolveWorkspaceFacts({ project, store: memory.store, checkpoint: memory.current("owner"),
      refs: ["repository.remote", "test.command"] })
    expect(Object.keys(facts)).toEqual([])
  })

  test("exposes environment facts only from a selected, current, origin-bound review", () => {
    const project = tempProject("alg-workspace-facts-"); projects.push(project)
    const memory = new SessionMemoryRuntime(project, { mode: "assist" })
    const now = Date.now()
    const environmentId = publishEnvironment(memory.store, { name: "reviewed-test", origin: "workstation",
      origin_fingerprint: localOrigin().id, target: "test-api", kind: "api", namespace: null, tenant: "team",
      principal_ref: "reviewed-reader", protocol: "https", api_version: "v1", client_version: "2",
      endpoint_refs: ["test-endpoint"], route_refs: ["reviewed-route"], tools: ["read"], credential_refs: ["provider-ref"],
      scopes: ["read-only"], verified_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 60_000).toISOString(),
      source_ref: hashObject("reviewed environment fixture") })
    memory.selectEnvironment("owner", environmentId)
    const facts = resolveWorkspaceFacts({ project, store: memory.store, checkpoint: memory.current("owner"),
      refs: ["environment.name", "environment.target", "environment.scopes"] })
    expect(facts["environment.name"]).toMatchObject({ state: "known", value: "reviewed-test", source_revision: hashObject("reviewed environment fixture") })
    expect(facts["environment.target"]?.value).toBe("test-api")
    expect(facts["environment.scopes"]?.value).toBe("read-only")
  })
})

describe("explicit workspace operation detection", () => {
  test.each([
    ["bash", { command: "bun test tests/workspace-facts.test.ts" }, "repo.test"],
    ["terminal", { command: "npm run test" }, "repo.test"],
    ["shell", { command: "git status --short" }, "repo.git"],
    ["pwsh", { command: "git diff --stat" }, "repo.git"],
  ] as const)("recognizes an explicit command %#", (tool, input, expected) => {
    expect(detectWorkspaceOperation(tool, input)).toBe(expected)
  })

  test.each([
    ["bash", { command: "Please run bun test" }],
    ["bash", { command: "bun test && git push" }],
    ["bash", { command: "echo bun test" }],
    ["read", { command: "git status" }],
    ["bash", { command: "git" }],
    ["bash", "bun test"],
  ] as const)("ignores non-unambiguous input %#", (tool, input) => {
    expect(detectWorkspaceOperation(tool, input)).toBeUndefined()
  })
})


test("workspace discovery does not copy credential-bearing metadata into context", () => {
  const project = tempProject("alg-secret-facts-"); projects.push(project)
  mkdirSync(join(project, ".git"), { recursive: true })
  writeFileSync(join(project, ".git", "config"), '[remote "origin"]\nurl = https://user:secret@example.test/repo.git\n')
  writeFileSync(join(project, ".git", "HEAD"), "ref: refs/heads/main\n")
  const memory = new SessionMemoryRuntime(project)
  const facts = resolveWorkspaceFacts({ project, store: memory.store, checkpoint: memory.current("owner"), refs: ["repository.remote", "repository.identity"] })
  expect(facts["repository.remote"]).toBeUndefined()
  expect(facts["repository.identity"]).toBeUndefined()
})

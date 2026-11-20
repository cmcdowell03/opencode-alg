import { afterEach, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import type { Plugin } from "@opencode/plugin"
import type { InvestigationHost } from "../src/host.ts"
import { readCommittedSource, registerTeamSources } from "../src/team-source.ts"

const execute = promisify(execFile)
const scratch: string[] = []
afterEach(async () => { for (const root of scratch.splice(0)) await rm(root, { recursive: true, force: true }) })
const hash = (text: string) => createHash("sha256").update(text).digest("hex")
const text = "One wafer may have multiple passes.\n"

async function checkouts() {
  const root = await realpath(await mkdtemp(join(import.meta.dir, ".sources-")))
  scratch.push(root)
  const reference = join(root, "team")
  const project = join(root, "project")
  await mkdir(reference)
  await mkdir(join(project, ".opencode"), { recursive: true })
  const git = (...args: string[]) => execute("git", ["-c", "core.autocrlf=false", "-c", "commit.gpgsign=false",
    "-c", "core.hooksPath=/dev/null", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", ...args],
    { cwd: reference, windowsHide: true })
  await git("init", "--quiet")
  await writeFile(join(reference, "spec.md"), text)
  await git("add", "--", "spec.md")
  await git("commit", "--quiet", "-m", "fixture")
  return { reference, project, git }
}

test("two partners can cite committed bytes independently of local edits; moved revisions fail closed", async () => {
  const { reference, git } = await checkouts()
  const signal = AbortSignal.timeout(10_000)
  const read = () => readCommittedSource(reference, "spec.md", hash(text), signal)
  const receipt = await read()
  expect(receipt.commit).toBe((await git("rev-parse", "HEAD")).stdout.trim())
  expect(receipt.text).toBe(text)
  await writeFile(join(reference, "spec.md"), "uncommitted replacement")
  expect(await read()).toEqual(receipt)
  await git("add", "--", "spec.md")
  await git("commit", "--quiet", "-m", "revision")
  await expect(read()).rejects.toThrow()
  for (const path of ["../spec.md", ".git/config", "/fake"]) {
    await expect(readCommittedSource(reference, path, hash(text), signal)).rejects.toThrow()
  }
})

test("team source lookup requires the pinned registry, a named reference and both host permissions", async () => {
  const { reference, project } = await checkouts()
  const source = "reference:contracts/spec.md"
  const registry = JSON.stringify({ schema_version: 1, operations: [{ id: "investigate", authoritative_sources: [
    { ref: source, revision: hash(text) },
  ] }] })
  const path = join(project, ".opencode", "ALG.workspace.json")
  await writeFile(path, registry)
  let deny = true
  const actions: string[] = []
  let run!: (input: unknown, call: unknown) => Promise<{ content: string }>
  const ctx = {
    tool: { transform: async (apply: Function) => apply({ get: () => undefined, add: (tool: { execute: typeof run }) => { run = tool.execute } }) },
    reference: { list: async () => ({ location: { directory: project }, data: [{ name: "contracts", path: reference }] }) },
    permission: { assert: async ({ action }: { action: string }) => {
      actions.push(action)
      if (action === "external_directory" && deny) throw new Error("denied")
    } },
  } as unknown as Plugin.Context
  const host = { directory: project, owner: async () => ({ id: "owner" }) } as unknown as InvestigationHost
  await registerTeamSources(ctx, host, hash(registry))
  const lookup = async (source?: string) => JSON.parse((await run({ operation: "investigate", source }, {
    agent: "build", signal: AbortSignal.timeout(5_000),
  })).content)
  expect((await lookup()).sources).toEqual([{ ref: source, revision: hash(text) }])
  expect((await lookup(source)).error).toBe("TEAM_SOURCE_UNAVAILABLE")
  expect(actions).toEqual(["read", "external_directory"])
  deny = false
  expect((await lookup(source)).text).toBe(text)
  expect((await lookup("reference:other/spec.md")).error).toBe("TEAM_SOURCE_UNAVAILABLE")
  await writeFile(path, registry + "\n")
  expect((await lookup(source)).error).toBe("TEAM_SOURCE_UNAVAILABLE")
})

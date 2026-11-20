import { afterEach, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Plugin } from "@opencode/plugin"
import type { InvestigationMcpPort, InvestigationResult, InvestigationWorkInput } from "../../../src/investigation/index.ts"
import { createV2InvestigationBridge } from "../core/investigation.ts"
import { createPreQueryGate, preQueryPolicySchema } from "../src/pre-query.ts"
import { ResearchProcedure } from "../src/procedure.ts"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    // Git writes loose objects read-only, which Bun cannot remove on Windows.
    const objects = join(root, ".git", "objects")
    if (process.platform === "win32" && existsSync(objects)) {
      for (const entry of readdirSync(objects, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) chmodSync(join(entry.parentPath, entry.name), 0o666)
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  }
})
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")
const approvedJob = {
  operation: "fixture.count",
  recipe_version: "fixture-v1",
  parameters: {},
  cohort: "line-a",
  source_dependencies: ["events@v3", "timestamps@v7"],
  preprocessing_revision: "clock-utc@v2",
  query: { fixture: "lined-up-sample" },
  reserved_cost: 1,
} satisfies InvestigationWorkInput

const approvedScope = {
  project_id: "fixture-project",
  operation: approvedJob.operation,
  recipe_version: approvedJob.recipe_version,
  cohort: approvedJob.cohort,
  as_of: null,
  source_dependencies: approvedJob.source_dependencies,
  preprocessing_revision: approvedJob.preprocessing_revision,
}
const sampled = { sampled_rows: 8, max_abs_skew_ms: 0.25, tolerance_ms: 0.5 }
const evidencePath = "evidence/clock-sample.json"
const skillPath = ".opencode/skills/alignment/SKILL.md"
const approvalFile = ".opencode/procedure-approval.json"
type Observer = Parameters<typeof createPreQueryGate>[2]
type Policy = Parameters<typeof createPreQueryGate>[0]

function fixture(evidenceOverrides: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "alg-v2-pre-query-"))
  roots.push(root)
  const directory = realpathSync.native(root)
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  }
  function git(...args: string[]) {
    return execFileSync("git", args, { cwd: directory, env, encoding: "utf8" }).trim()
  }
  git("init", "-q")
  mkdirSync(join(directory, "evidence"))
  const evidence = JSON.stringify({
    schema_version: 1, kind: "clock_alignment_sample", scope: approvedScope, ...sampled, ...evidenceOverrides,
  })
  writeFileSync(join(directory, evidencePath), evidence)
  git("add", "--", evidencePath)
  // Create an isolated fixture commit object without advancing any ref.
  const revision = git("commit-tree", git("write-tree"), "-m", "clock alignment fixture")
  const prerequisite = { kind: "committed_clock_alignment" as const, path: evidencePath, revision, sha256: sha256(evidence) }
  const text = "Use the approved clock alignment procedure."
  const pin = { id: "alignment", path: skillPath, sha256: sha256(text), sourceSha256: sha256(text) }
  const policy = { procedure: pin, prerequisite }
  const approval = JSON.stringify(pin)
  mkdirSync(join(directory, ".opencode", "skills", "alignment"), { recursive: true })
  writeFileSync(join(directory, skillPath), text)
  writeFileSync(join(directory, approvalFile), approval)
  const owner = { projectID: approvedScope.project_id, directory, sessionID: "owner" }
  const skill = { id: pin.id, path: join(directory, skillPath), name: "Alignment", content: text }
  const catalog = { data: [skill], location: { directory } }
  const ctx = {
    location: { directory },
    skill: { reload: async () => {}, list: async () => catalog },
  } as unknown as Plugin.Context
  const procedures = new ResearchProcedure(ctx, directory, approvalFile, sha256(approval))

  const calls = { submit: 0, lookup: 0, validate: 0, read: 0 }
  const result: InvestigationResult = {
    manifest_ref: "fixture:lined-up-sample", digest: sha256("fixture result"),
    observed_at: "2025-01-01T00:00:00.000Z", access_scope: owner.projectID,
    source_versions: approvedJob.source_dependencies, coverage: { sampled: true },
  }
  const state = { loseAcknowledgment: false }
  const port: InvestigationMcpPort = {
    capabilities: {
      server_id: "fixture", server_revision: "1", tool_id: approvedJob.operation, tool_schema_revision: "1",
      principal_id: "fixture-principal", project_id: owner.projectID, effects: ["read"], qualified: true,
      idempotent_submit: true, lookup_by_submission_id: true, response_limit_bytes: 4096,
    },
    async submit() {
      calls.submit++
      if (state.loseAcknowledgment) throw new Error("fixture lost acknowledgment")
      return { kind: "result", result, actual_cost: 1 }
    },
    async lookup() { calls.lookup++; return { kind: "result", result, actual_cost: 1 } },
    async validateResult() { calls.validate++; throw new Error("unexpected external validation") },
    async readResult() { calls.read++; throw new Error("unexpected external read") },
  }

  function bridge(options: { policy?: Policy; job?: InvestigationWorkInput; observe?: Observer; beforeCommit?: () => void } = {}) {
    const preQuery = createPreQueryGate("policy" in options ? options.policy : policy, procedures, options.observe)
    const { beforeCommit } = options
    if (preQuery && beforeCommit) {
      const assertCurrent = preQuery.assertCurrent
      preQuery.assertCurrent = (...args) => {
        beforeCommit()
        assertCurrent(...args)
      }
    }
    return createV2InvestigationBridge({ port, approvedJob: options.job ?? approvedJob, preQuery })
  }
  return { owner, policy, catalog, bridge, calls, result, state, port, git }
}

test("verifies committed scoped evidence and reuses the exact settled manifest offline", async () => {
  const f = fixture()
  // Working tree data has no authority over the pinned committed evidence.
  writeFileSync(join(f.owner.directory, evidencePath), "{}")
  const bridge = f.bridge({
    async observe(sessionId, pin) {
      return sessionId === f.owner.sessionID && pin.sha256 === f.policy.procedure.sha256
    },
  })
  bridge.create(f.owner)
  const admitted = await bridge.admit(f.owner)
  expect(admitted.preQuery).toEqual({
    skill: { pin: f.policy.procedure, availability: "verified", activation: "observed" },
    prerequisite: { status: "satisfied", evidence: {
      revision: f.policy.prerequisite.revision, path: evidencePath,
      sha256: f.policy.prerequisite.sha256, ...sampled,
    } },
    reuse: null,
  })
  const dispatched = await bridge.dispatch(f.owner)
  expect(dispatched.preQuery?.reuse).toBeNull()
  expect(dispatched.work?.manifest_digest).toBe(f.result.digest)
  const reopened = f.bridge({ async observe() { throw new Error("receipt unavailable") } })
  for (const act of [reopened.admit, reopened.dispatch, reopened.reconcile]) {
    const reused = await act(f.owner)
    expect(reused.revision).toBe(dispatched.revision)
    expect(reused.preQuery?.skill.activation).toBe("not_observed")
    expect(reused.preQuery?.reuse).toEqual({
      kind: "settled_manifest", work_key: admitted.work!.work_key, manifest_digest: f.result.digest,
    })
  }
  expect(f.calls).toEqual({ submit: 1, lookup: 0, validate: 0, read: 0 })
})

test.each([
  ["unverified", { sampled_rows: 0 }],
  ["scope_mismatch", { scope: { ...approvedScope, cohort: "line-b" } }],
  ["scope_mismatch", { scope: { ...approvedScope, source_dependencies: ["events@v4"] } }],
  ["tolerance_exceeded", { max_abs_skew_ms: 0.75 }],
] as const)("blocks admission on a prerequisite classified as %s", async (status, evidence) => {
  const f = fixture(evidence)
  const bridge = f.bridge()
  bridge.create(f.owner)
  await expect(bridge.admit(f.owner)).rejects.toMatchObject({
    message: "RESEARCH_PRE_QUERY_PREREQUISITE_UNSATISFIED",
    preQuery: { skill: { availability: "verified", activation: "not_observed" }, prerequisite: { status }, reuse: null },
  })
  expect(bridge.primary(f.owner)?.work).toBeNull()
  await expect(bridge.dispatch(f.owner)).rejects.toThrow()
  expect(f.calls.submit).toBe(0)
})

test("rejects a hash mismatch, an uncommitted path, and a missing coordinate", async () => {
  const f = fixture()
  const { policy } = f
  writeFileSync(join(f.owner.directory, "evidence/uncommitted.json"), "{}")
  const variants = [
    f.bridge({ policy: { ...policy, prerequisite: { ...policy.prerequisite, sha256: sha256("wrong") } } }),
    f.bridge({ policy: { ...policy, prerequisite: {
      ...policy.prerequisite, path: "evidence/uncommitted.json", sha256: sha256("{}"),
    } } }),
    f.bridge({ job: { ...approvedJob, preprocessing_revision: undefined } }),
  ]
  for (const bridge of variants) {
    bridge.create(f.owner)
    await expect(bridge.admit(f.owner)).rejects.toThrow("RESEARCH_PRE_QUERY_PREREQUISITE_UNSATISFIED")
    expect(bridge.primary(f.owner)?.work).toBeNull()
  }
  expect(preQueryPolicySchema.safeParse({ ...policy, prerequisite: { ...policy.prerequisite, revision: "HEAD" } }).success).toBe(false)
  expect(f.calls.submit).toBe(0)
})

test("a missing promised blob fails closed even when local config allows the remote transport", async () => {
  const f = fixture()
  const remote = fixture()
  remote.git("update-ref", "refs/heads/calibration", remote.policy.prerequisite.revision)
  remote.git("config", "uploadpack.allowAnySHA1InWant", "true")
  const oid = f.git("rev-parse", f.policy.prerequisite.revision + ":" + evidencePath)
  expect(remote.git("cat-file", "-t", oid)).toBe("blob")

  f.git("config", "core.repositoryformatversion", "1")
  f.git("config", "extensions.partialClone", "calibration")
  f.git("config", "remote.calibration.promisor", "true")
  f.git("config", "remote.calibration.url", remote.owner.directory)
  f.git("config", "protocol.file.allow", "always")
  const objects = join(f.owner.directory, ".git", "objects")
  const blob = join(objects, oid.slice(0, 2), oid.slice(2))
  if (process.platform === "win32") chmodSync(blob, 0o666)
  rmSync(blob)

  const bridge = f.bridge()
  bridge.create(f.owner)
  await expect(bridge.admit(f.owner)).rejects.toMatchObject({
    message: "RESEARCH_PRE_QUERY_PREREQUISITE_UNSATISFIED",
    preQuery: { skill: { availability: "verified" }, prerequisite: { status: "unverified" }, reuse: null },
  })
  expect(bridge.primary(f.owner)?.work).toBeNull()
  expect(f.calls.submit).toBe(0)
  expect(existsSync(blob)).toBe(false)
  expect(readdirSync(join(objects, "pack"))).toEqual([])
}, 20_000)

test("older reservations need gated admission and a revoked pin blocks dispatch and retries", async () => {
  const f = fixture()
  const legacy = f.bridge({ policy: undefined })
  legacy.create(f.owner)
  const old = await legacy.admit(f.owner)
  const bridge = f.bridge()
  await expect(bridge.dispatch(f.owner)).rejects.toThrow("RESEARCH_PRE_QUERY_POLICY_CHANGED")
  expect((await bridge.admit(f.owner)).work).toEqual(old.work)
  await expect(legacy.dispatch(f.owner)).rejects.toThrow("RESEARCH_PRE_QUERY_POLICY_CHANGED")
  writeFileSync(join(f.owner.directory, approvalFile), "{}")
  for (const act of [bridge.admit, bridge.dispatch, f.bridge().dispatch]) {
    await expect(act(f.owner)).rejects.toMatchObject({
      message: "RESEARCH_PROCEDURE_UNVERIFIED",
      preQuery: { skill: { availability: "unverified" }, prerequisite: { status: "unchecked" }, reuse: null },
    })
  }
  expect(f.calls.submit).toBe(0)
})

test("rejects catalog drift, a conflicting decision pin and a changed policy", async () => {
  const f = fixture()
  const bridge = f.bridge()
  bridge.create(f.owner)
  await bridge.admit(f.owner)
  const { policy } = f
  const changed = f.bridge({ policy: { ...policy, prerequisite: { ...policy.prerequisite, sha256: sha256("replacement") } } })
  await expect(changed.dispatch(f.owner)).rejects.toThrow("RESEARCH_PRE_QUERY_POLICY_CHANGED")
  const skill = f.catalog.data.pop()!
  await expect(bridge.dispatch(f.owner)).rejects.toThrow("RESEARCH_PROCEDURE_UNVERIFIED")
  f.catalog.data.push(skill)
  await bridge.setNextMeasurement(f.owner, { expected_decision_revision: 0, next_action: "Measure." },
    async () => ({ ...policy.procedure, sha256: sha256("different decision pin") }))
  await expect(bridge.dispatch(f.owner)).rejects.toThrow("RESEARCH_PROCEDURE_UNVERIFIED")
  expect(f.calls.submit).toBe(0)
})

test("older settled work, expired results and drifted service identity do not qualify for gated reuse", async () => {
  const older = fixture()
  const legacy = older.bridge({ policy: undefined })
  legacy.create(older.owner)
  await legacy.admit(older.owner)
  await legacy.dispatch(older.owner)
  await expect(older.bridge().admit(older.owner)).rejects.toThrow("RESEARCH_PRE_QUERY_POLICY_CHANGED")

  const f = fixture()
  const bridge = f.bridge()
  bridge.create(f.owner)
  await bridge.admit(f.owner)
  f.result.expires_at = "2000-01-01T00:00:00.000Z"
  await bridge.dispatch(f.owner)
  await expect(bridge.admit(f.owner)).rejects.toThrow("RESEARCH_PRE_QUERY_REUSE_UNVERIFIED")
  await expect(bridge.reconcile(f.owner)).rejects.toThrow("RESEARCH_PRE_QUERY_REUSE_UNVERIFIED")
  f.port.capabilities.principal_id = "changed-principal"
  await expect(bridge.dispatch(f.owner)).rejects.toThrow("RESEARCH_PRE_QUERY_WORK_UNVERIFIED")
  expect(f.calls).toEqual({ submit: 1, lookup: 0, validate: 0, read: 0 })
}, 20_000)

test("can reconcile only the original ambiguous submission after approval withdrawal", async () => {
  const f = fixture()
  const bridge = f.bridge()
  f.state.loseAcknowledgment = true
  bridge.create(f.owner)
  await bridge.admit(f.owner)
  expect((await bridge.dispatch(f.owner)).work?.status).toBe("outcome_unknown")
  rmSync(join(f.owner.directory, approvalFile))
  await expect(f.bridge().dispatch(f.owner)).rejects.toThrow("reconcile the original submission")
  const reconciled = await f.bridge().reconcile(f.owner)
  expect(reconciled.work?.status).toBe("result_recorded")
  expect(reconciled.preQuery).toBeUndefined()
  await expect(f.bridge().dispatch(f.owner)).rejects.toThrow("RESEARCH_PROCEDURE_UNVERIFIED")
  expect(f.calls).toEqual({ submit: 1, lookup: 1, validate: 0, read: 0 })
})

test("rechecks approval before writing a submission intent", async () => {
  const f = fixture()
  const original = f.bridge()
  original.create(f.owner)
  await original.admit(f.owner)

  const bridge = f.bridge({ beforeCommit: () => rmSync(join(f.owner.directory, approvalFile)) })
  await expect(bridge.dispatch(f.owner)).rejects.toThrow("RESEARCH_PROCEDURE_UNVERIFIED")
  expect(bridge.primary(f.owner)?.work?.status).toBe("reserved")
  expect(f.calls.submit).toBe(0)
})
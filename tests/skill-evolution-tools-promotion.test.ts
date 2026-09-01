import { createHash } from "node:crypto"
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { describe, expect, test } from "bun:test"
import { buildSkillEvidence } from "../src/skill-evolution-evidence.ts"
import { createSkillEvolutionRuntime, ALG_SKILL_AUDIT_TITLE_PREFIX } from "../src/skill-evolution-runtime.ts"
import { SkillEvolutionOptionsSchema, type AuditorOutput, type SkillEvolutionOptions } from "../src/skill-evolution-schemas.ts"
import {
  appendSkillCandidateRevision,
  beginSkillAudit,
  configuredSkillTarget,
  createSkillCandidate,
  directFileHash,
  enqueueSkillAudit,
  failSkillAudit,
  findSkillCandidate,
  listSkillTransactions,
  loadCandidateRevision,
  loadSkillCandidates,
  loadSkillLedger,
  markSkillLedgerOutcome,
  persistSkillEvidence,
  promoteSkillCandidate,
  recoverSkillTransactions,
  registerSkillAuditChild,
  rollbackSkillCandidate,
  skillContentHash,
  skillEvolutionRoot,
  skillLedgerKey,
  transactionJournalPath,
  writeSkillTransaction,
  type SkillPublicationHooks,
} from "../src/skill-evolution-store.ts"
import { createSkillEvolutionTools } from "../src/skill-evolution-tools.ts"
import { removeProject, tempProject } from "./helpers.ts"

const options = SkillEvolutionOptionsSchema.parse({ enabled: true, mode: "every-turn", maxAttempts: 3 })

function skillBytes(name: string, marker = "new"): string {
  return `---\nname: ${name}\ndescription: Use when the ${name} project procedure must be repeated.\n---\n\n# ${name}\n\nFollow the verified ${marker} procedure.\n`
}

function turn(id: string) {
  return [
    { info: { id: `user-${id}`, sessionID: `session-${id}`, role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "Please retain this verified procedure." }] },
    { info: { id: `assistant-${id}`, parentID: `user-${id}`, sessionID: `session-${id}`, role: "assistant", mode: "build", providerID: "p", modelID: "m", time: { created: 2, completed: 3 } }, parts: [{ type: "text", text: "The reusable procedure passed." }] },
  ]
}

function provenance(id: string) {
  return {
    session_id: `session-${id}`,
    user_message_id: `user-${id}`,
    assistant_message_id: `assistant-${id}`,
    user_created_at: 1,
    assistant_created_at: 2,
    assistant_completed_at: 3,
  }
}

function makeCandidate(project: string, input: {
  id: string
  kind?: "create" | "replace" | "memory"
  name?: string
  checkerPassed?: boolean
  basis?: string
  content?: string
}): ReturnType<typeof createSkillCandidate> {
  const evidence = buildSkillEvidence(turn(input.id), `session-${input.id}`, `assistant-${input.id}`, options)
  const evidenceRef = persistSkillEvidence(project, evidence)
  let output: AuditorOutput
  if (input.kind === "memory") {
    output = {
      decision: "memory_candidate",
      rationale: "The convention may be reusable.",
      confidence: "medium",
      triggers: evidence.trigger_labels,
      provenance: provenance(input.id),
      memory: { content: "Use the verified convention.", summary: "Verified convention" },
    }
  } else {
    const name = input.name ?? `skill-${input.id}`
    const replace = input.kind === "replace"
    output = {
      decision: replace ? "skill_revision" : "skill_candidate",
      rationale: "The procedure is reusable.",
      confidence: "high",
      triggers: evidence.trigger_labels,
      provenance: provenance(input.id),
      skill: {
        target: `${name}/SKILL.md`,
        operation: replace ? "replace" : "create",
        basis_sha256: replace ? input.basis! : null,
        content: input.content ?? skillBytes(name),
        summary: "Persist the verified procedure.",
      },
    }
  }
  const skill = input.kind !== "memory"
  const passed = input.checkerPassed ?? true
  return createSkillCandidate(
    project,
    skillLedgerKey(`session-${input.id}`, `assistant-${input.id}`),
    output,
    evidenceRef,
    `auditor-${input.id}`,
    skill ? `checker-${input.id}` : null,
    skill ? passed ? { passed: true, findings: [] } : { passed: false, findings: ["Checker rejected this candidate."] } : null,
    options,
  )
}

function targetPath(project: string, name: string, root = ".opencode/skills"): string {
  return configuredSkillTarget(project, root, `${name}/SKILL.md`).target
}

function writeTarget(project: string, name: string, bytes: string, root = ".opencode/skills"): string {
  const path = join(project, ...root.split("/"), name, "SKILL.md")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes, "utf8")
  return path
}

function context(project: string, sessionID = "actor") {
  return {
    sessionID,
    messageID: "message",
    agent: "orchestrator",
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    ask: async () => {},
    metadata: () => {},
  } as any
}

function output(value: unknown): any {
  return JSON.parse((value as { output: string }).output)
}

class AuditSdk {
  readonly sessions = new Map<string, Record<string, any>>()
  readonly messageSets = new Map<string, any[]>()
  prompts = 0
  children = 0

  constructor(readonly project: string) {}

  add(id: string, overrides: Record<string, unknown> = {}) {
    this.sessions.set(id, { id, projectID: "project", directory: this.project, title: "ordinary", ...overrides })
    this.messageSets.set(id, turn(id.replace(/^session-/, "")))
  }

  client() {
    return {
      app: { log: async () => ({ data: true, error: undefined }) },
      session: {
        get: async ({ path }: any) => ({ data: this.sessions.get(path.id), error: undefined }),
        messages: async ({ path }: any) => ({ data: this.messageSets.get(path.id), error: undefined }),
        create: async ({ body }: any) => ({ data: { id: `child-${++this.children}`, title: body.title }, error: undefined }),
        prompt: async ({ body }: any) => {
          this.prompts++
          const prompt = body.parts[0].text as string
          const marker = "UNTRUSTED EVIDENCE JSON:\n"
          const start = prompt.indexOf(marker) + marker.length
          const evidence = JSON.parse(prompt.slice(start, prompt.indexOf("\n\nReturn one strict JSON", start)))
          return { data: { parts: [{ type: "text", text: JSON.stringify({
            decision: "no_change",
            rationale: "No durable improvement is justified.",
            confidence: "high",
            triggers: evidence.trigger_labels,
            provenance: evidence.provenance,
          }) }] }, error: undefined }
        },
      },
    } as never
  }
}

function runtime(project: string, sdk = new AuditSdk(project), configured: Partial<SkillEvolutionOptions> = {}) {
  const active = createSkillEvolutionRuntime({
    client: sdk.client(),
    project: { id: "project" },
    directory: project,
    worktree: project,
  } as never, { options: SkillEvolutionOptionsSchema.parse({ ...options, ...configured }) })
  return { active, sdk, tools: createSkillEvolutionTools(active) }
}

async function waitForRecord(project: string, session: string, message: string, status: string): Promise<void> {
  const key = skillLedgerKey(session, message)
  const deadline = Date.now() + 4_000
  while (Date.now() < deadline) {
    if (loadSkillLedger(project).records.find((record) => record.key === key)?.status === status) return
    await Bun.sleep(5)
  }
  throw new Error(`timed out waiting for ${status}`)
}

describe("skill-evolution user tools", () => {
  test("status keeps compact/full output bounded, filters honestly, reports global totals, and tracks restart need", async () => {
    const project = tempProject("alg-skill-tools-status-")
    try {
      const instance = runtime(project)
      const memory = makeCandidate(project, { id: "memory", kind: "memory" })
      const valid = makeCandidate(project, { id: "valid", name: "valid-skill" })
      makeCandidate(project, { id: "failed", name: "failed-skill", checkerPassed: false })
      const pending = enqueueSkillAudit(project, "ledger-pending", "assistant-pending", options)
      const running = enqueueSkillAudit(project, "ledger-running", "assistant-running", options)
      beginSkillAudit(project, running.record.key, options)
      const failed = enqueueSkillAudit(project, "ledger-failed", "assistant-failed", options)
      beginSkillAudit(project, failed.record.key, options)
      failSkillAudit(project, failed.record.key, "bounded failure")
      const noChange = enqueueSkillAudit(project, "ledger-no-change", "assistant-no-change", options)
      beginSkillAudit(project, noChange.record.key, options)
      markSkillLedgerOutcome(project, noChange.record.key, { status: "no-change", trigger_score: 0, trigger_labels: [] })

      const compact = output(await instance.tools.alg_skill_evolution_status.execute({ state: "validated", limit: 1 }, context(project)))
      expect(compact).toMatchObject({
        detail: "compact",
        restart_required: false,
        ledger: { total: 4, totals: { pending: 1, running: 1, "no-change": 1, candidate: 0, failed: 1 } },
        candidates: { total: 3, matched: 1, shown: 1, omitted: 0 },
      })
      expect(compact.candidates.records[0]).toMatchObject({ candidate_id: valid.candidate_id, checker_findings: [] })
      expect(compact.candidates.records[0].current).toBeUndefined()
      expect(compact.ledger.recent_errors).toHaveLength(1)

      const full = output(await instance.tools.alg_skill_evolution_status.execute({ detail: "full", candidate_id: memory.candidate_id, limit: 1 }, context(project)))
      expect(full.candidates).toMatchObject({ total: 3, matched: 1, shown: 1, omitted: 0 })
      expect(full.candidates.records[0].revisions).toHaveLength(1)
      expect(full.candidates.records[0].current.candidate_id).toBe(memory.candidate_id)

      const promoted = output(await instance.tools.alg_skill_evolution_promote.execute({ candidate_id: valid.candidate_id, confirm: `PROMOTE:${valid.candidate_id}` }, context(project)))
      expect(promoted).toMatchObject({ automatic: false, restart_required: true })
      const after = output(await instance.tools.alg_skill_evolution_status.execute({}, context(project)))
      expect(after.restart_required).toBe(true)
      expect(readFileSync(targetPath(project, "valid-skill"), "utf8")).toBe(skillBytes("valid-skill"))
      instance.active.dispose()
      void pending
    } finally {
      removeProject(project)
    }
  })

  test("manual audit is project-scoped, idempotent, bounded-force, and cannot recurse through private IDs or titles", async () => {
    const project = tempProject("alg-skill-tools-audit-")
    const foreign = tempProject("alg-skill-tools-audit-foreign-")
    try {
      const sdk = new AuditSdk(project)
      sdk.add("session-current")
      sdk.add("session-specified")
      sdk.add("session-foreign", { projectID: "other" })
      sdk.add("session-outside", { directory: foreign })
      sdk.add("session-private", { title: `${ALG_SKILL_AUDIT_TITLE_PREFIX}forged` })
      sdk.add("session-registered")
      registerSkillAuditChild(project, { session_id: "session-registered", parent_id: "session-current", title: `${ALG_SKILL_AUDIT_TITLE_PREFIX}registered`, role: "auditor" })
      const instance = runtime(project, sdk)
      const ctx = context(project, "session-current")

      const first = output(await instance.tools.alg_skill_evolution_audit.execute({ assistant_message_id: "assistant-current" }, ctx))
      expect(first.enqueued).toBe(true)
      await waitForRecord(project, "session-current", "assistant-current", "no-change")
      const duplicate = output(await instance.tools.alg_skill_evolution_audit.execute({ assistant_message_id: "assistant-current" }, ctx))
      expect(duplicate).toMatchObject({ enqueued: false, idempotent: true })
      const forced = output(await instance.tools.alg_skill_evolution_audit.execute({ assistant_message_id: "assistant-current", force: true }, ctx))
      expect(forced.enqueued).toBe(true)
      await waitForRecord(project, "session-current", "assistant-current", "no-change")
      expect(loadSkillLedger(project).records.find((record) => record.session_id === "session-current")).toMatchObject({ attempts: 2, forced_retries: 1 })

      const specified = output(await instance.tools.alg_skill_evolution_audit.execute({ session_id: "session-specified", assistant_message_id: "assistant-specified" }, ctx))
      expect(specified.enqueued).toBe(true)
      await waitForRecord(project, "session-specified", "assistant-specified", "no-change")
      expect(output(await instance.tools.alg_skill_evolution_audit.execute({ session_id: "session-specified", assistant_message_id: "new", force: true }, ctx)).error)
        .toContain("requires an existing")
      for (const id of ["session-foreign", "session-outside", "session-private", "session-registered"]) {
        expect(output(await instance.tools.alg_skill_evolution_audit.execute({ session_id: id }, ctx)).error).toBeString()
      }
      expect(loadSkillLedger(project).records.some((record) => ["session-foreign", "session-outside", "session-private", "session-registered"].includes(record.session_id))).toBe(false)

      const actorChild = context(project, "session-registered")
      expect(output(await instance.tools.alg_skill_evolution_audit.execute({ session_id: "session-current" }, actorChild)).error).toContain("recursion-excluded")
      instance.active.dispose()
    } finally {
      removeProject(project)
      removeProject(foreign)
    }
  })

  test("review revisions preserve actor/reason, and restore cannot manufacture checker approval", async () => {
    const project = tempProject("alg-skill-tools-review-")
    try {
      const approved = makeCandidate(project, { id: "approved", name: "approved-skill" })
      const checkerFailed = makeCandidate(project, { id: "checker-failed", name: "checker-failed", checkerPassed: false })
      const memory = makeCandidate(project, { id: "review-memory", kind: "memory" })
      const instance = runtime(project)
      const ctx = context(project, "review-actor")
      for (const candidate of [approved, checkerFailed, memory]) {
        const rejected = output(await instance.tools.alg_skill_evolution_review.execute({ candidate_id: candidate.candidate_id, action: "reject", reason: "Explicit reviewer rejection." }, ctx))
        expect(rejected.candidate.state).toBe("rejected")
        const rejection = loadCandidateRevision(project, rejected.candidate)
        expect(rejection).toMatchObject({ event: "review_rejected", actor_session_id: "review-actor", reason: "Explicit reviewer rejection." })
        const restored = output(await instance.tools.alg_skill_evolution_review.execute({ candidate_id: candidate.candidate_id, action: "restore", reason: "Restore for another review." }, ctx))
        expect(restored.approval_bypassed_checker).toBe(false)
        expect(restored.candidate.state).toBe(candidate.candidate_id === approved.candidate_id ? "validated" : "proposed")
        const restoration = loadCandidateRevision(project, restored.candidate)
        expect(restoration).toMatchObject({ event: "review_restored", actor_session_id: "review-actor", reason: "Restore for another review." })
      }
      expect(output(await instance.tools.alg_skill_evolution_promote.execute({ candidate_id: checkerFailed.candidate_id, confirm: true }, ctx)).error)
        .toContain("validated")
      instance.active.dispose()
    } finally {
      removeProject(project)
    }
  })
})

describe("skill publication and filesystem containment", () => {
  test("promotion accepts only explicitly confirmed validated skills and never deletes created skills", async () => {
    const project = tempProject("alg-skill-promote-create-")
    try {
      const valid = makeCandidate(project, { id: "create", name: "create-skill" })
      const proposed = makeCandidate(project, { id: "proposed", name: "proposed-skill", checkerPassed: false })
      const memory = makeCandidate(project, { id: "memory-promote", kind: "memory" })
      const instance = runtime(project)
      const ctx = context(project)
      expect(output(await instance.tools.alg_skill_evolution_promote.execute({ candidate_id: valid.candidate_id, confirm: false }, ctx)).error).toContain("confirmation")
      for (const id of [proposed.candidate_id, memory.candidate_id, "no-change-record"]) {
        expect(output(await instance.tools.alg_skill_evolution_promote.execute({ candidate_id: id, confirm: true }, ctx)).error).toBeString()
      }
      const result = output(await instance.tools.alg_skill_evolution_promote.execute({ candidate_id: valid.candidate_id, confirm: true }, ctx))
      expect(result.candidate).toMatchObject({ state: "promoted", current_revision: 2, backup_ref: null })
      const path = targetPath(project, "create-skill")
      expect(readFileSync(path, "utf8")).toBe(skillBytes("create-skill"))
      expect(output(await instance.tools.alg_skill_evolution_rollback.execute({ candidate_id: valid.candidate_id, confirm: true }, ctx)).error).toContain("not deleted")
      expect(existsSync(path)).toBe(true)
      expect(output(await instance.tools.alg_skill_evolution_promote.execute({ candidate_id: valid.candidate_id, confirm: true }, ctx)).error).toContain("validated")
      instance.active.dispose()
    } finally {
      removeProject(project)
    }
  })

  test("create is absent across every configured root; replace binds exact basis identity and publishes an independent backup", () => {
    const project = tempProject("alg-skill-promote-replace-")
    try {
      const twoRoots = SkillEvolutionOptionsSchema.parse({ enabled: true, skillRoots: [".opencode/skills", "project-skills"] })
      const duplicate = makeCandidate(project, { id: "duplicate", name: "duplicate-skill" })
      writeTarget(project, "duplicate-skill", skillBytes("duplicate-skill", "other-root"), "project-skills")
      expect(() => promoteSkillCandidate(project, duplicate.candidate_id, "actor", twoRoots)).toThrow(/every configured skill root/)
      expect(existsSync(targetPath(project, "duplicate-skill"))).toBe(false)

      const original = skillBytes("replace-skill", "original")
      const path = writeTarget(project, "replace-skill", original)
      const before = directFileHash(path)
      const replacement = skillBytes("replace-skill", "replacement")
      const candidate = makeCandidate(project, { id: "replace", kind: "replace", name: "replace-skill", basis: before.sha256, content: replacement })
      const promoted = promoteSkillCandidate(project, candidate.candidate_id, "promoter", options)
      expect(promoted).toMatchObject({ before_sha256: before.sha256, after_sha256: skillContentHash(replacement), restart_required: true })
      expect(readFileSync(path, "utf8")).toBe(replacement)
      expect(promoted.candidate.backup_ref).not.toBeNull()
      const backupPath = join(project, ...promoted.candidate.backup_ref!.path.split("/"))
      expect(readFileSync(backupPath, "utf8")).toBe(original)
      const backup = directFileHash(backupPath)
      expect({ dev: backup.identity.dev, ino: backup.identity.ino }).not.toEqual({ dev: before.identity.dev, ino: before.identity.ino })
      expect(loadCandidateRevision(project, promoted.candidate)).toMatchObject({ event: "promoted", actor_session_id: "promoter" })
    } finally {
      removeProject(project)
    }
  })

  test("absolute/traversal/ADS/device targets and symlink, junction, reparse, or foreign parents fail closed", () => {
    const project = tempProject("alg-skill-paths-")
    const foreign = tempProject("alg-skill-paths-foreign-")
    try {
      for (const target of ["../x/SKILL.md", "/x/SKILL.md", "C:/x/SKILL.md", "con/SKILL.md", "x/SKILL.md:stream"]) {
        expect(() => configuredSkillTarget(project, ".opencode/skills", target)).toThrow()
      }
      mkdirSync(join(project, ".opencode"), { recursive: true })
      const linkedRoot = join(project, ".opencode", "skills")
      symlinkSync(foreign, linkedRoot, process.platform === "win32" ? "junction" : "dir")
      expect(() => configuredSkillTarget(project, ".opencode/skills", "linked-skill/SKILL.md")).toThrow(/symlink|junction|reparse/)
      unlinkSync(linkedRoot)

      const realRoot = join(project, "real-skills")
      mkdirSync(realRoot)
      symlinkSync(realRoot, linkedRoot, process.platform === "win32" ? "junction" : "dir")
      expect(() => configuredSkillTarget(project, ".opencode/skills", "linked-skill/SKILL.md")).toThrow(/symlink|junction|reparse/)
      unlinkSync(linkedRoot)

      mkdirSync(linkedRoot)
      const foreignParent = join(linkedRoot, "foreign-parent")
      symlinkSync(foreign, foreignParent, process.platform === "win32" ? "junction" : "dir")
      expect(() => configuredSkillTarget(project, ".opencode/skills", "foreign-parent/SKILL.md")).toThrow(/symlink|junction|reparse/)
    } finally {
      removeProject(project)
      removeProject(foreign)
    }
  })

  test("no-clobber publication preserves a racing create or replacement and leaves candidate state unchanged", () => {
    const projects = [tempProject("alg-skill-race-create-"), tempProject("alg-skill-race-replace-")]
    try {
      const createProject = projects[0]!
      const create = makeCandidate(createProject, { id: "race-create", name: "race-create" })
      const createPath = join(createProject, ".opencode", "skills", "race-create", "SKILL.md")
      expect(() => promoteSkillCandidate(createProject, create.candidate_id, "actor", options, {
        afterPrepared() { writeFileSync(createPath, "third-party create", "utf8") },
      })).toThrow()
      expect(readFileSync(createPath, "utf8")).toBe("third-party create")
      expect(findSkillCandidate(createProject, create.candidate_id)?.state).toBe("validated")
      expect(recoverSkillTransactions(createProject, options).unresolved[0]).toContain("third state")

      const replaceProject = projects[1]!
      const original = skillBytes("race-replace", "original")
      const replacePath = writeTarget(replaceProject, "race-replace", original)
      const basis = directFileHash(replacePath).sha256
      const replace = makeCandidate(replaceProject, { id: "race-replace", kind: "replace", name: "race-replace", basis })
      expect(() => promoteSkillCandidate(replaceProject, replace.candidate_id, "actor", options, {
        afterClaim() {
          unlinkSync(replacePath)
          writeFileSync(replacePath, "custom drift", "utf8")
        },
      })).toThrow(/changed concurrently/)
      expect(readFileSync(replacePath, "utf8")).toBe("custom drift")
      expect(findSkillCandidate(replaceProject, replace.candidate_id)?.state).toBe("validated")
      expect(recoverSkillTransactions(replaceProject, options).unresolved[0]).toContain("third state")
    } finally {
      for (const project of projects) removeProject(project)
    }
  })
})

describe("skill transaction recovery and rollback", () => {
  test("every publication crash point is journaled and recovers only exact before/file-applied states", () => {
    const phases = ["afterJournal", "afterBackup", "afterPrepared", "afterClaim", "afterUnlink", "afterPublish", "beforeStateCommit", "afterStateCommit"] as const
    for (const phase of phases) {
      const project = tempProject(`alg-skill-crash-${phase}-`)
      try {
        const name = `crash-${phase.toLowerCase()}`
        const original = skillBytes(name, "original")
        const replacement = skillBytes(name, "replacement")
        const path = writeTarget(project, name, original)
        const candidate = makeCandidate(project, { id: phase.toLowerCase(), kind: "replace", name, basis: directFileHash(path).sha256, content: replacement })
        const hooks: SkillPublicationHooks = { [phase]: () => { throw new Error(`crash:${phase}`) } }
        expect(() => promoteSkillCandidate(project, candidate.candidate_id, "crash-actor", options, hooks)).toThrow(`crash:${phase}`)
        expect(listSkillTransactions(project)).toHaveLength(1)
        const report = recoverSkillTransactions(project, options)
        expect(report.unresolved).toEqual([])
        expect(listSkillTransactions(project)).toEqual([])
        const fileApplied = phase === "afterPublish" || phase === "beforeStateCommit" || phase === "afterStateCommit"
        expect(readFileSync(path, "utf8")).toBe(fileApplied ? replacement : original)
        expect(findSkillCandidate(project, candidate.candidate_id)?.state).toBe(fileApplied ? "promoted" : "validated")
      } finally {
        removeProject(project)
      }
    }
  })

  test("startup and status recover file-applied/state-uncommitted transactions and truthfully require restart", async () => {
    const projects = [tempProject("alg-skill-startup-recovery-"), tempProject("alg-skill-status-recovery-")]
    try {
      for (const [index, project] of projects.entries()) {
        const name = `recovery-${index}`
        const original = skillBytes(name, "original")
        const replacement = skillBytes(name, "replacement")
        const path = writeTarget(project, name, original)
        const candidate = makeCandidate(project, { id: `recovery-${index}`, kind: "replace", name, basis: directFileHash(path).sha256, content: replacement })
        expect(() => promoteSkillCandidate(project, candidate.candidate_id, "actor", options, {
          beforeStateCommit() { throw new Error("state commit unavailable") },
        })).toThrow("state commit unavailable")
        expect(findSkillCandidate(project, candidate.candidate_id)?.state).toBe("validated")
        expect(readFileSync(path, "utf8")).toBe(replacement)
        if (index === 0) {
          const instance = runtime(project)
          expect(findSkillCandidate(project, candidate.candidate_id)?.state).toBe("promoted")
          expect(instance.active.status().restart_required).toBe(true)
          instance.active.dispose()
        } else {
          const instance = runtime(project, new AuditSdk(project), { enabled: false })
          ;(instance.active.options as any).enabled = true
          const status = output(await instance.tools.alg_skill_evolution_status.execute({}, context(project)))
          expect(status.doctor.healthy).toBe(true)
          expect(status.restart_required).toBe(true)
          expect(findSkillCandidate(project, candidate.candidate_id)?.state).toBe("promoted")
          instance.active.dispose()
        }
      }
    } finally {
      for (const project of projects) removeProject(project)
    }
  })

  test("malformed/forged journals fail closed on exact path, hash, identity, revision, and third-state checks", () => {
    const mutations: Array<[string, (journal: any, project: string) => void]> = [
      ["target-path", (journal, project) => { journal.target_path = join(project, "foreign", "SKILL.md") }],
      ["swap-path", (journal, project) => { journal.swap_path = join(project, "forged.swap") }],
      ["prepared-path", (journal, project) => { journal.prepared_path = join(project, "forged.prepared") }],
      ["after-hash", (journal) => { journal.expected_after_sha256 = "f".repeat(64) }],
      ["before-identity", (journal) => { journal.observed_before_identity.ino = String(BigInt(journal.observed_before_identity.ino) + 1n) }],
      ["parent-identity", (journal) => { journal.target_parent_identity.ino = String(BigInt(journal.target_parent_identity.ino) + 1n) }],
      ["backup-path", (journal, project) => { journal.backup_path = join(project, "forged-backup.bin") }],
      ["candidate-revision", (journal) => { journal.candidate_revision += 2 }],
    ]
    for (const [label, mutate] of mutations) {
      const project = tempProject(`alg-skill-forged-${label}-`)
      try {
        const name = `forged-${label}`
        const original = skillBytes(name, "original")
        const path = writeTarget(project, name, original)
        const candidate = makeCandidate(project, { id: label, kind: "replace", name, basis: directFileHash(path).sha256 })
        expect(() => promoteSkillCandidate(project, candidate.candidate_id, "actor", options, { afterJournal() { throw new Error("stop") } })).toThrow("stop")
        const journal = listSkillTransactions(project)[0]!
        mutate(journal, project)
        writeFileSync(transactionJournalPath(project, journal.transaction_id), JSON.stringify(journal), "utf8")
        const report = recoverSkillTransactions(project, options)
        expect(report.unresolved).toHaveLength(1)
        expect(readFileSync(path, "utf8")).toBe(original)
        expect(findSkillCandidate(project, candidate.candidate_id)?.state).toBe("validated")
      } finally {
        removeProject(project)
      }
    }

    const malformed = tempProject("alg-skill-malformed-journal-")
    try {
      const directory = join(skillEvolutionRoot(malformed), "transactions")
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, "tx-malformed.json"), "{not-json", "utf8")
      const report = recoverSkillTransactions(malformed, options)
      expect(report).toMatchObject({ pending: 1, file_mutations: 0 })
      expect(report.unresolved[0]).toContain("tx-malformed.json")
    } finally {
      removeProject(malformed)
    }

    const third = tempProject("alg-skill-third-state-")
    try {
      const name = "third-state"
      const path = writeTarget(third, name, skillBytes(name, "original"))
      const candidate = makeCandidate(third, { id: "third-state", kind: "replace", name, basis: directFileHash(path).sha256 })
      expect(() => promoteSkillCandidate(third, candidate.candidate_id, "actor", options, { afterJournal() { throw new Error("stop") } })).toThrow("stop")
      unlinkSync(path)
      writeFileSync(path, "custom third state", "utf8")
      const report = recoverSkillTransactions(third, options)
      expect(report.unresolved[0]).toContain("third state")
      expect(readFileSync(path, "utf8")).toBe("custom third state")
    } finally {
      removeProject(third)
    }
  })

  test("rollback requires confirmation/promoted exact hash, preserves drift, restores exact backup, and appends rolled_back revision", async () => {
    const project = tempProject("alg-skill-rollback-")
    try {
      const name = "rollback-skill"
      const original = skillBytes(name, "original")
      const replacement = skillBytes(name, "replacement")
      const path = writeTarget(project, name, original)
      const candidate = makeCandidate(project, { id: "rollback", kind: "replace", name, basis: directFileHash(path).sha256, content: replacement })
      const promoted = promoteSkillCandidate(project, candidate.candidate_id, "promoter", options)
      const instance = runtime(project)
      const ctx = context(project, "rollback-actor")
      expect(output(await instance.tools.alg_skill_evolution_rollback.execute({ candidate_id: candidate.candidate_id, confirm: false }, ctx)).error).toContain("confirmation")
      writeFileSync(path, "custom drift", "utf8")
      expect(output(await instance.tools.alg_skill_evolution_rollback.execute({ candidate_id: candidate.candidate_id, confirm: true }, ctx)).error).toContain("custom drift")
      expect(readFileSync(path, "utf8")).toBe("custom drift")
      expect(findSkillCandidate(project, candidate.candidate_id)?.state).toBe("promoted")
      writeFileSync(path, replacement, "utf8")
      const rolled = output(await instance.tools.alg_skill_evolution_rollback.execute({ candidate_id: candidate.candidate_id, confirm: `ROLLBACK:${candidate.candidate_id}` }, ctx))
      expect(rolled.candidate).toMatchObject({ state: "rolled_back", current_revision: 3 })
      expect(rolled.after_sha256).toBe(promoted.candidate.backup_ref!.sha256)
      expect(readFileSync(path, "utf8")).toBe(original)
      expect(loadCandidateRevision(project, rolled.candidate)).toMatchObject({
        event: "rolled_back",
        actor_session_id: "rollback-actor",
        reason: "explicit rollback restored the immutable pre-promotion backup",
      })
      expect(output(await instance.tools.alg_skill_evolution_rollback.execute({ candidate_id: candidate.candidate_id, confirm: true }, ctx)).error).toContain("promoted")
      instance.active.dispose()
    } finally {
      removeProject(project)
    }
  })
})

describe("skill mutation serialization", () => {
  test("concurrent promote/review and duplicate rollback serialize; stale loser fails without clobber", async () => {
    const project = tempProject("alg-skill-concurrent-mutations-")
    try {
      const name = "concurrent-skill"
      const original = skillBytes(name, "original")
      const path = writeTarget(project, name, original)
      const candidate = makeCandidate(project, { id: "concurrent", kind: "replace", name, basis: directFileHash(path).sha256 })
      const storeUrl = new URL("../src/skill-evolution-store.ts", import.meta.url).href
      const promoteScript = `import { promoteSkillCandidate } from ${JSON.stringify(storeUrl)}; promoteSkillCandidate(${JSON.stringify(project)}, ${JSON.stringify(candidate.candidate_id)}, "promoter", ${JSON.stringify(options)});`
      const reviewScript = `import { appendSkillCandidateRevision } from ${JSON.stringify(storeUrl)}; appendSkillCandidateRevision(${JSON.stringify(project)}, ${JSON.stringify(candidate.candidate_id)}, 1, { state:"rejected", event:"review_rejected", actorSessionId:"reviewer", reason:"concurrent review", update(){} });`
      const first = [promoteScript, reviewScript].map((script) => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }))
      const firstResults = await Promise.all(first.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })))
      expect(firstResults.filter((result) => result.code === 0)).toHaveLength(1)
      expect(firstResults.filter((result) => result.code !== 0)).toHaveLength(1)
      const afterRace = findSkillCandidate(project, candidate.candidate_id)!
      expect(["promoted", "rejected"]).toContain(afterRace.state)

      if (afterRace.state === "rejected") {
        appendSkillCandidateRevision(project, candidate.candidate_id, afterRace.current_revision, {
          state: "validated", event: "review_restored", actorSessionId: "reviewer", reason: "restore immutable checker approval", update() {},
        })
        promoteSkillCandidate(project, candidate.candidate_id, "promoter", options)
      }
      const rollbackScript = `import { rollbackSkillCandidate } from ${JSON.stringify(storeUrl)}; rollbackSkillCandidate(${JSON.stringify(project)}, ${JSON.stringify(candidate.candidate_id)}, "rollback", ${JSON.stringify(options)});`
      const second = [rollbackScript, rollbackScript].map((script) => Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }))
      const secondResults = await Promise.all(second.map(async (child) => ({ code: await child.exited, stderr: await new Response(child.stderr).text() })))
      expect(secondResults.filter((result) => result.code === 0)).toHaveLength(1)
      expect(secondResults.filter((result) => result.code !== 0)).toHaveLength(1)
      expect(findSkillCandidate(project, candidate.candidate_id)?.state).toBe("rolled_back")
      expect(readFileSync(path, "utf8")).toBe(original)
    } finally {
      removeProject(project)
    }
  }, 30_000)
})

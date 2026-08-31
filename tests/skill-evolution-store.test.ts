import { describe, expect, test } from "bun:test"
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { canonicalJson } from "../src/persistence.ts"
import { buildSkillEvidence } from "../src/skill-evolution-evidence.ts"
import { SkillEvolutionOptionsSchema, type AuditorOutput } from "../src/skill-evolution-schemas.ts"
import {
  appendSkillCandidateRevision,
  beginSkillAudit,
  createSkillCandidate,
  enqueueSkillAudit,
  loadCandidateRevision,
  loadEvidenceReference,
  loadSkillCandidates,
  loadSkillLedger,
  persistSkillEvidence,
  recoverPendingSkillAudits,
  registerSkillAuditChild,
  skillEvolutionRoot,
  skillLedgerKey,
} from "../src/skill-evolution-store.ts"
import { removeProject, tempProject } from "./helpers.ts"

const options = SkillEvolutionOptionsSchema.parse({ enabled: true, maxBacklog: 2, maxAttempts: 2 })

function evidence() {
  return buildSkillEvidence([
    { info: { id: "user", sessionID: "session", role: "user", time: { created: 1 } }, parts: [{ type: "text", text: "Remember this local convention." }] },
    { info: { id: "assistant", parentID: "user", sessionID: "session", role: "assistant", mode: "build", providerID: "p", modelID: "m", time: { created: 2, completed: 3 } }, parts: [{ type: "text", text: "Done." }] },
  ], "session", "assistant", options)
}

function memoryOutput(): AuditorOutput {
  return {
    decision: "memory_candidate",
    rationale: "The convention may be reusable.",
    confidence: "medium",
    triggers: [],
    provenance: {
      session_id: "session",
      user_message_id: "user",
      assistant_message_id: "assistant",
      user_created_at: 1,
      assistant_created_at: 2,
      assistant_completed_at: 3,
    },
    memory: { content: "Use the local convention.", summary: "Local convention" },
  }
}

describe("skill-evolution durable store", () => {
  test("ledger enqueue is exactly-once, bounded, force-retry limited, and restart recovery is durable", () => {
    const project = tempProject("alg-skill-store-")
    try {
      const first = enqueueSkillAudit(project, "session", "assistant", options)
      expect(first).toMatchObject({ enqueued: true, reason: "new", record: { status: "pending", attempts: 0 } })
      expect(enqueueSkillAudit(project, "session", "assistant", options)).toMatchObject({ enqueued: false, reason: "duplicate" })
      const running = beginSkillAudit(project, first.record.key, options)
      expect(running).toMatchObject({ status: "running", attempts: 1 })
      expect(recoverPendingSkillAudits(project, options)).toEqual([expect.objectContaining({ key: first.record.key, status: "pending", attempts: 1 })])
      expect(beginSkillAudit(project, first.record.key, options).attempts).toBe(2)
      expect(recoverPendingSkillAudits(project, options)).toEqual([])
      expect(loadSkillLedger(project).records[0]).toMatchObject({ status: "failed", attempts: 2 })
      expect(enqueueSkillAudit(project, "session", "assistant", options, true)).toMatchObject({ enqueued: false, reason: "duplicate" })
    } finally {
      removeProject(project)
    }
  })

  test("backlog overflow persists a terminal failure instead of dropping an identity", () => {
    const project = tempProject("alg-skill-backlog-")
    const one = SkillEvolutionOptionsSchema.parse({ enabled: true, maxBacklog: 1 })
    try {
      expect(enqueueSkillAudit(project, "s1", "a1", one).enqueued).toBe(true)
      const overflow = enqueueSkillAudit(project, "s2", "a2", one)
      expect(overflow).toMatchObject({ enqueued: false, reason: "overflow", record: { status: "failed" } })
      expect(overflow.record.error).toContain("backlog")
      expect(loadSkillLedger(project).records.map((record) => record.key)).toEqual([
        skillLedgerKey("s1", "a1"),
        skillLedgerKey("s2", "a2"),
      ])
    } finally {
      removeProject(project)
    }
  })

  test("audit-child registry is durable and idempotent", () => {
    const project = tempProject("alg-skill-child-store-")
    try {
      const child = { session_id: "child", parent_id: "parent", title: "alg-private-skill-evolution-audit:one", role: "auditor" as const }
      registerSkillAuditChild(project, child)
      registerSkillAuditChild(project, child)
      expect(loadSkillLedger(project).audit_children).toEqual([expect.objectContaining(child)])
    } finally {
      removeProject(project)
    }
  })

  test("evidence publication is canonical, idempotent, integrity-checked, and no-clobber", () => {
    const project = tempProject("alg-skill-evidence-store-")
    try {
      const value = evidence()
      const first = persistSkillEvidence(project, value)
      const second = persistSkillEvidence(project, value)
      expect(second).toEqual(first)
      const path = join(project, ...first.path.split("/"))
      expect(readFileSync(path, "utf8")).toBe(canonicalJson(value))
      expect(loadEvidenceReference(project, first)).toEqual(value)
      expect(() => loadEvidenceReference(project, { ...first, sha256: "0".repeat(64) })).toThrow(/integrity/)
      const occupied = structuredClone(value)
      occupied.assistant.agent = "other"
      expect(() => persistSkillEvidence(project, occupied)).toThrow(/evidence id does not match/)
    } finally {
      removeProject(project)
    }
  })

  test("evidence loading rejects escaping paths, oversized direct files, and file-symlink replacement when supported", () => {
    const project = tempProject("alg-skill-evidence-read-")
    const external = tempProject("alg-skill-evidence-external-")
    try {
      const value = evidence()
      const reference = persistSkillEvidence(project, value)
      const path = join(project, ...reference.path.split("/"))
      const original = readFileSync(path)
      expect(() => loadEvidenceReference(project, { ...reference, path: "../outside.json" })).toThrow(/invalid evidence reference path/)
      writeFileSync(path, Buffer.alloc(32_769, 0x20))
      expect(() => loadEvidenceReference(project, reference)).toThrow(/exceeds 32768 bytes/)

      writeFileSync(path, original)
      const target = join(external, "evidence.json")
      writeFileSync(target, canonicalJson(value))
      rmSync(path)
      try {
        symlinkSync(target, path, "file")
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EINVAL") return
        throw error
      }
      expect(() => loadEvidenceReference(project, reference)).toThrow(/symlink|redirect|direct regular file/)
    } finally {
      removeProject(project)
      removeProject(external)
    }
  })

  test("candidate creation is idempotent and revision updates enforce CAS and immutable integrity", () => {
    const project = tempProject("alg-skill-candidate-store-")
    try {
      const ref = persistSkillEvidence(project, evidence())
      const key = skillLedgerKey("session", "assistant")
      const first = createSkillCandidate(project, key, memoryOutput(), ref, "auditor-child", null, null, options)
      const duplicate = createSkillCandidate(project, key, memoryOutput(), ref, "other-auditor", null, null, options)
      expect(duplicate).toEqual(first)
      expect(loadCandidateRevision(project, first)).toMatchObject({ candidate_id: first.candidate_id, revision: 1, event: "proposed" })
      const updated = appendSkillCandidateRevision(project, first.candidate_id, 1, {
        state: "rejected",
        event: "review_rejected",
        actorSessionId: "reviewer",
        reason: "Not reusable enough.",
        update() {},
      })
      expect(updated).toMatchObject({ state: "rejected", current_revision: 2 })
      expect(() => appendSkillCandidateRevision(project, first.candidate_id, 1, {
        state: "proposed",
        event: "review_restored",
        actorSessionId: "reviewer",
        reason: "stale write",
        update() {},
      })).toThrow(/changed concurrently/)
      const current = loadCandidateRevision(project, updated)
      expect(current).toMatchObject({ revision: 2, state: "rejected", event: "review_rejected" })
      const revisionPath = join(project, ...updated.revision_refs[1]!.path.split("/"))
      writeFileSync(revisionPath, "{}", "utf8")
      expect(() => loadCandidateRevision(project, updated)).toThrow(/integrity/)
    } finally {
      removeProject(project)
    }
  })

  test("candidate revision loading rejects oversized direct files and file-symlink replacement when supported", () => {
    const project = tempProject("alg-skill-revision-read-")
    const external = tempProject("alg-skill-revision-external-")
    try {
      const ref = persistSkillEvidence(project, evidence())
      const record = createSkillCandidate(project, skillLedgerKey("session", "assistant"), memoryOutput(), ref, "auditor", null, null, options)
      const path = join(project, ...record.revision_refs[0]!.path.split("/"))
      const original = readFileSync(path)
      writeFileSync(path, Buffer.alloc(512 * 1_024 + 1, 0x20))
      expect(() => loadCandidateRevision(project, record)).toThrow(/exceeds 524288 bytes/)

      const target = join(external, "revision.json")
      writeFileSync(target, original)
      rmSync(path)
      try {
        symlinkSync(target, path, "file")
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP" || code === "EINVAL") return
        throw error
      }
      expect(() => loadCandidateRevision(project, record)).toThrow(/symlink|redirect|direct regular file/)
    } finally {
      removeProject(project)
      removeProject(external)
    }
  })

  test("corrupted, malformed, and oversized ledger/index JSON fail closed", () => {
    for (const [name, file, bytes] of [
      ["corrupt-ledger", "ledger.json", "{not-json"],
      ["malformed-ledger", "ledger.json", JSON.stringify({ schema_version: 1, kind: "skill_evolution_ledger", revision: 0, records: [], audit_children: [], updated_at: "not-an-iso" })],
      ["oversize-ledger", "ledger.json", "x".repeat(512 * 1_024 + 1)],
      ["malformed-index", "candidates.json", JSON.stringify({ schema_version: 1, kind: "skill_evolution_candidates", revision: 0, candidates: [], updated_at: "bad" })],
    ] as const) {
      const project = tempProject(`alg-skill-${name}-`)
      try {
        const root = skillEvolutionRoot(project)
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, file), bytes, "utf8")
        expect(() => file === "ledger.json" ? loadSkillLedger(project) : loadSkillCandidates(project)).toThrow()
      } finally {
        removeProject(project)
      }
    }
  })

  test("separate processes serialize concurrent ledger writers without lost records", async () => {
    const project = tempProject("alg-skill-concurrent-store-")
    try {
      const storeUrl = new URL("../src/skill-evolution-store.ts", import.meta.url).href
      const configured = SkillEvolutionOptionsSchema.parse({ enabled: true, maxBacklog: 16 })
      const children = Array.from({ length: 6 }, (_, index) => Bun.spawn([
        process.execPath,
        "-e",
        `import { enqueueSkillAudit } from ${JSON.stringify(storeUrl)}; ` +
          `enqueueSkillAudit(${JSON.stringify(project)}, ${JSON.stringify(`session-${index}`)}, ${JSON.stringify(`assistant-${index}`)}, ${JSON.stringify(configured)});`,
      ], { stdout: "pipe", stderr: "pipe" }))
      const results = await Promise.all(children.map(async (child) => ({
        code: await child.exited,
        stderr: await new Response(child.stderr).text(),
      })))
      expect(results).toEqual(Array.from({ length: 6 }, () => ({ code: 0, stderr: "" })))
      expect(new Set(loadSkillLedger(project).records.map((record) => record.session_id))).toEqual(
        new Set(Array.from({ length: 6 }, (_, index) => `session-${index}`)),
      )
    } finally {
      removeProject(project)
    }
  }, 20_000)
})

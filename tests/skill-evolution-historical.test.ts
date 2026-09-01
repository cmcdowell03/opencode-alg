import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { canonicalJson } from "../src/persistence.ts"
import { buildSkillEvidence } from "../src/skill-evolution-evidence.ts"
import { createSkillEvolutionRuntime as createSkillEvolutionRuntimeBase } from "../src/skill-evolution-runtime.ts"
import { historicalAuditorPrompt, HistoricalToolInputSchema, HistoricalToolResultSchema, normalizeHistoricalMessages } from "../src/skill-evolution-historical.ts"
import { HISTORICAL_CHILD_PROMPT_MAX_BYTES, HISTORICAL_MAX_CANONICAL_SNAPSHOT_BYTES, HISTORICAL_MAX_CHUNK_BYTES, HISTORICAL_SESSION_METADATA_MAX_BYTES, HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES, HistoricalCandidateBindingSchema, HistoricalSnapshotReferenceSchema, historicalAuditorPromptByteUpperBound, historicalSnapshotReferenceByteUpperBound, SkillEvolutionOptionsSchema, type AuditorOutput, type SkillEvolutionOptions } from "../src/skill-evolution-schemas.ts"
import { beginSkillAudit, createSkillCandidate, enqueueSkillAudit, failSkillAudit, findReviewedLiveSkillCandidate, loadCandidateRevision, loadHistoricalImmutable, loadHistoricalIndex, loadSkillLedger, loadSkillCandidates, markSkillLedgerOutcome, persistHistoricalImmutable, persistSkillEvidence, recoverPendingSkillAudits, registerSkillAuditChild, skillLedgerKey, updateHistoricalIndex } from "../src/skill-evolution-store.ts"
import { createSkillEvolutionTools } from "../src/skill-evolution-tools.ts"
import { realUserGlobalConfigRoots } from "../scripts/live-verify.ts"
import { removeProject, tempProject } from "./helpers.ts"

function transcript(sessionId: string, count: number, suffix = ""): any[] {
  return Array.from({ length: count }, (_, index) => {
    const messageId = `message-${index}${suffix}`
    const role = index % 2 ? "assistant" : "user"
    return {
      info: {
        id: messageId, sessionID: sessionId, role,
        time: role === "assistant" ? { created: index, completed: index + 1 } : { created: index },
        ...(role === "assistant" ? { parentID: `message-${index - 1}${suffix}`, mode: "build", providerID: "p", modelID: "m" } : {}),
      },
      parts: [{ id: `part-${index}${suffix}`, sessionID: sessionId, messageID: messageId, type: "text", text: `text ${index} ${suffix}` }],
    }
  })
}

let historicalChildSequence = 0

class HistoricalSdk {
  readonly calls: any[] = []
  readonly creates: any[] = []
  readonly childIds: string[] = []
  readonly prompts: any[] = []
  messageReads = 0
  mutate = false
  candidate = false
  memoryCandidate = false
  forgeSource = false
  failuresRemaining = 0
  createGate?: Promise<void>
  promptGate?: Promise<void>
  promptGateFor?: (prompt: string) => boolean
  constructor(readonly project: string, readonly values: any[], readonly title = "ordinary") {}
  client() {
    return {
      app: { log: async () => ({ data: true, error: undefined }) },
      session: {
        list: async (request: any) => { this.calls.push(["list", request]); return { data: [{ id: "selected", projectID: "project", directory: this.project, title: this.title }], error: undefined } },
        get: async (request: any) => { this.calls.push(["get", request]); return { data: { id: request.path.id, projectID: "project", directory: this.project, title: this.title }, error: undefined } },
        messages: async (request: any) => {
          this.calls.push(["messages", request]); this.messageReads++
          return { data: this.mutate ? transcript(request.path.id, this.values.length, `-${this.messageReads}`) : this.values, error: undefined }
        },
        create: async (request: any) => {
          this.creates.push(request)
          if (this.createGate) await this.createGate
          const id = `historical-child-${++historicalChildSequence}`
          this.childIds.push(id)
          return { data: { id }, error: undefined }
        },
        prompt: async (request: any) => {
          this.prompts.push(request)
          const prompt = request.body.parts[0].text
          if (this.promptGate && (!this.promptGateFor || this.promptGateFor(prompt))) await this.promptGate
          if (this.failuresRemaining-- > 0) return { data: undefined, error: { name: "APIError", message: "interrupted" } }
          const fragment = prompt.includes("UNTRUSTED FRAGMENT JSON:\n")
            ? JSON.parse(prompt.split("UNTRUSTED FRAGMENT JSON:\n")[1]!) : undefined
          const text = prompt.includes("pure checker")
            ? '{"passed":true,"findings":[]}'
            : prompt.includes("UNTRUSTED EVIDENCE JSON:\n")
              ? JSON.stringify(this.candidate ? candidateOutput() : {
                decision: "no_change", rationale: "No reusable project improvement was found.", confidence: "high", triggers: [],
                provenance: JSON.parse(prompt.split("UNTRUSTED EVIDENCE JSON:\n")[1]!.split("\n\nReturn one strict JSON")[0]!).provenance,
              })
            : this.candidate && fragment?.message_id === "message-1"
                ? JSON.stringify({ findings: [{ session_id: "selected", assistant_message_id: "message-1", finding: "A reusable bounded review procedure.", source: {
                  session_id: fragment.session_id, session_commitment: fragment.sealed_session_commitment,
                  transcript_commitment: fragment.transcript_commitment, chunk_sha256: fragment.chunk_sha256,
                  message_index: fragment.message_index, message_id: fragment.message_id, part_index: fragment.part_index,
                  part_id: fragment.part_id, part_type: fragment.part_type, fragment_index: fragment.fragment_index,
                  fragment_count: fragment.fragment_count, byte_offset: fragment.byte_offset, byte_length: fragment.byte_length,
                  fragment_sha256: fragment.sha256,
                }, candidate: this.memoryCandidate ? memoryCandidateOutput() : candidateOutput() }] }).replace(
                  this.forgeSource ? `\"fragment_index\":${fragment.fragment_index}` : "__never__",
                  `\"fragment_index\":${fragment.fragment_index + 1}`,
                )
                : '{"findings":[]}'
          return { data: { parts: [{ type: "text", text }] }, error: undefined }
        },
      },
    } as never
  }
}

function candidateOutput(): Extract<AuditorOutput, { decision: "skill_candidate" }> {
  return { decision: "skill_candidate", rationale: "A reusable procedure was found.", confidence: "high", triggers: [], provenance: { session_id: "selected", user_message_id: "message-0", assistant_message_id: "message-1", user_created_at: 0, assistant_created_at: 1, assistant_completed_at: 2 }, skill: { target: "retrospective-review/SKILL.md", operation: "create", basis_sha256: null, content: "---\nname: retrospective-review\ndescription: Reviews bounded retrospective evidence when reusable project procedures are requested.\n---\n\n# Retrospective review\n\nReview the complete sealed evidence, preserve provenance, and report only reusable project procedures.\n", summary: "Adds a bounded retrospective review procedure." } }
}

function memoryCandidateOutput() {
  const { skill: _skill, ...base } = candidateOutput()
  return { ...base, decision: "memory_candidate", memory: { content: "Remember the bounded local convention.", summary: "Local convention" } }
}

function filesystemSnapshot(path: string): unknown {
  const stat = lstatSync(path, { bigint: true })
  if (stat.isFile()) return { type: "file", mode: stat.mode.toString(), size: stat.size.toString(), mtime: stat.mtimeNs.toString(), bytes: readFileSync(path).toString("base64") }
  return { type: "directory", mode: stat.mode.toString(), mtime: stat.mtimeNs.toString(), entries: Object.fromEntries(readdirSync(path).sort().map((name) => [name, filesystemSnapshot(join(path, name))])) }
}

function filesystemSnapshotExcept(path: string, excluded: Set<string>): unknown {
  if (excluded.has(path)) return { type: "allowed-mutation-root" }
  const stat = lstatSync(path, { bigint: true })
  if (stat.isFile()) return { type: "file", mode: stat.mode.toString(), size: stat.size.toString(), mtime: stat.mtimeNs.toString(), bytes: readFileSync(path).toString("base64") }
  return {
    type: "directory", mode: stat.mode.toString(), mtime: stat.mtimeNs.toString(),
    entries: Object.fromEntries(readdirSync(path).sort().map((name) => {
      const child = join(path, name)
      return [name, filesystemSnapshotExcept(child, excluded)]
    })),
  }
}

function fixedHistoricalResolutions() {
  return Object.fromEntries(["planner", "explorer", "researcher", "implementer", "checker", "repair", "default"].map((role) => [
    role,
    role === "researcher"
      ? { source: "opencode-role-config", providerID: "test-provider", modelID: "test-auditor" }
      : role === "checker"
        ? { source: "opencode-role-config", providerID: "test-provider", modelID: "test-checker" }
        : { source: "inherited-sdk-default" },
  ])) as any
}

function createSkillEvolutionRuntime(input: any, config: any) {
  return createSkillEvolutionRuntimeBase(input, { configuredResolutions: fixedHistoricalResolutions, ...config })
}

function runtime(project: string, sdk: HistoricalSdk, enabled: boolean, overrides: Record<string, unknown> = {}) {
  return createSkillEvolutionRuntime({ client: sdk.client(), project: { id: "project" }, directory: project, worktree: project } as never, {
    options: SkillEvolutionOptionsSchema.parse({ enabled: true, historical: { enabled, maxMessagesPerSession: 150, ...overrides } }),
    configuredResolutions: fixedHistoricalResolutions,
  })
}

function persistReviewedLiveCandidate(project: string, values: any[], options: SkillEvolutionOptions) {
  const queued = enqueueSkillAudit(project, "selected", "message-1", options)
  beginSkillAudit(project, queued.record.key, options)
  const evidence = buildSkillEvidence(values, "selected", "message-1", options)
  const evidenceRef = persistSkillEvidence(project, evidence)
  registerSkillAuditChild(project, { session_id: "live-auditor", parent_id: "selected", title: "alg-private-skill-evolution-audit:test", role: "auditor" })
  registerSkillAuditChild(project, { session_id: "live-checker", parent_id: "selected", title: "alg-private-skill-evolution-check:test", role: "checker" })
  const candidate = createSkillCandidate(
    project, queued.record.key, candidateOutput(), evidenceRef, "live-auditor", "live-checker", { passed: true, findings: [] }, options,
    undefined,
    { session_id: "selected", message_id: "message-1", trigger_score: evidence.trigger_score, trigger_labels: evidence.trigger_labels },
  )
  return { candidate, evidence, evidenceRef, key: queued.record.key }
}

describe("V1-only historical skill evolution", () => {
  test("source uses only the supplied V1 client and strict bounded action unions", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "skill-evolution-historical.ts"), "utf8")
    expect(source).not.toContain("@opencode-ai/sdk/v2")
    expect(source).not.toMatch(/createOpencodeClient|sqlite|\.db\b|database path/i)
    expect(HistoricalToolInputSchema.safeParse({ action: "preview", session_ids: ["one"], extra: true }).success).toBe(false)
    expect(HistoricalToolInputSchema.safeParse({ action: "preview", session_ids: ["one", "one"] }).success).toBe(false)
    expect(HistoricalToolInputSchema.safeParse({ action: "run", plan_id: "hist-" + "a".repeat(32) }).success).toBe(false)
    expect(HistoricalToolInputSchema.safeParse({ action: "discover", plan_id: "hist-" + "a".repeat(32) }).success).toBe(false)
    expect(HistoricalToolInputSchema.safeParse({ action: "preview" }).success).toBe(false)
    expect(HistoricalToolInputSchema.safeParse({ action: "cancel", plan_id: "hist-" + "a".repeat(32), confirmation: "a".repeat(64) }).success).toBe(false)
    expect(HistoricalToolInputSchema.safeParse({ action: "unknown" }).success).toBe(false)
    const discovered = { ok: true, action: "discover", code: "discovered", result: { sessions: [], shown: 0, omitted: 0, rejected: 0, transport_bounded: false, note: "bounded after transport" } }
    expect(HistoricalToolResultSchema.safeParse(discovered).success).toBe(true)
    expect(HistoricalToolResultSchema.safeParse({ ...discovered, result: { ...discovered.result, extra: true } }).success).toBe(false)
    const status = { ok: true, action: "status", code: "previewed", result: {
      plan_id: `hist-${"a".repeat(32)}`, state: "previewed", disposition: "previewed", completeness: "v1_bounded_snapshot",
      sealed_sessions: 1, chunks: { total: 200, completed: 0 }, checkpoints: [], checkpoints_total: 200,
      checkpoints_omitted: 200, checkpoints_truncated: true, attempts: 0, model_calls: 0, input_bytes: 0, elapsed_ms: 0,
      remaining_hard_budgets: { model_calls: 1, input_bytes: 1, time_ms: 1 }, cancelled: false,
    } }
    expect(HistoricalToolResultSchema.safeParse(status).success).toBe(true)
    const { checkpoints_omitted: _omitted, ...silentStatus } = status.result
    expect(HistoricalToolResultSchema.safeParse({ ...status, result: silentStatus }).success).toBe(false)
  })

  test("preview fails before transcript reads when auditor and checker models are not explicit", async () => {
    const project = tempProject("alg-historical-explicit-models-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      const active = createSkillEvolutionRuntimeBase({ client: sdk.client(), project: { id: "project" }, directory: project, worktree: project } as never, {
        options: SkillEvolutionOptionsSchema.parse({ enabled: true, historical: { enabled: true } }),
        configuredResolutions: () => undefined,
      })
      const result = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] })
      expect(result).toMatchObject({ ok: false, code: "unavailable" })
      expect(sdk.calls).toEqual([])
      expect(sdk.creates).toEqual([])
      active.dispose()
    } finally { removeProject(project) }
  })

  test("fails closed without exact current V1 project identity and filters discovery by identity plus canonical containment", async () => {
    const project = tempProject("alg-historical-project-")
    try {
      for (const projectValue of [undefined, { id: "" }, { id: " project " }]) {
        const sdk = new HistoricalSdk(project, transcript("selected", 2))
        const active = createSkillEvolutionRuntime({ client: sdk.client(), project: projectValue, directory: project, worktree: project } as never, {
          options: SkillEvolutionOptionsSchema.parse({ enabled: true, historical: { enabled: true } }),
        })
        expect((await active.historicalInitialize({ action: "discover" })).code).toBe("unavailable")
        expect((await active.historicalInitialize({ action: "preview", session_ids: ["selected"] })).code).toBe("unavailable")
        expect(sdk.calls).toEqual([])
        expect(sdk.creates).toEqual([])
        expect(loadHistoricalIndex(project).plans).toEqual([])
        active.dispose()
      }
      const outside = tempProject("alg-historical-outside-")
      try {
        const sdk = new HistoricalSdk(project, transcript("selected", 2))
        const client = sdk.client() as any
        client.session.list = async () => ({ data: [
          { id: "valid", projectID: "project", directory: project, title: "valid" },
          { id: "foreign", projectID: "other", directory: project, title: "foreign" },
          { id: "outside", projectID: "project", directory: outside, title: "outside" },
          { id: "malformed", projectID: "project", directory: project, title: 1 },
        ], error: undefined })
        const active = createSkillEvolutionRuntime({ client, project: { id: "project" }, directory: project, worktree: project } as never, {
          options: SkillEvolutionOptionsSchema.parse({ enabled: true, historical: { enabled: true } }),
        })
        expect(await active.historicalInitialize({ action: "discover" })).toMatchObject({ ok: true, result: { sessions: [{ id: "valid" }], rejected: 3 } })
        active.dispose()
      } finally { removeProject(outside) }
    } finally { removeProject(project) }
  })

  test("maximum historical chunk configuration is prompt-safe at its exact boundary", () => {
    expect(SkillEvolutionOptionsSchema.safeParse({ historical: { maxChunkBytes: HISTORICAL_MAX_CHUNK_BYTES } }).success).toBe(true)
    expect(SkillEvolutionOptionsSchema.safeParse({ historical: { maxChunkBytes: HISTORICAL_MAX_CHUNK_BYTES + 1 } }).success).toBe(false)
    expect(SkillEvolutionOptionsSchema.safeParse({ historical: { maxChunkBytes: 4_096 } }).success).toBe(true)
    expect(SkillEvolutionOptionsSchema.safeParse({}).success).toBe(true)
    expect(historicalAuditorPromptByteUpperBound(HISTORICAL_MAX_CHUNK_BYTES)).toBeLessThanOrEqual(HISTORICAL_CHILD_PROMPT_MAX_BYTES)
    expect(historicalAuditorPromptByteUpperBound(HISTORICAL_MAX_CHUNK_BYTES + 1)).toBeGreaterThan(HISTORICAL_CHILD_PROMPT_MAX_BYTES)
  })

  test("historical candidate bindings accept large snapshot refs only up to the dedicated finite cap", () => {
    const digest = "a".repeat(64)
    const checkpointRef = { path: `.opencode/skill-evolution/historical-checkpoints/${digest}.json`, sha256: digest, byte_size: 1 }
    const output = candidateOutput()
    const binding = {
      plan_confirmation: digest,
      snapshot_ref: { path: `.opencode/skill-evolution/historical-snapshots/${digest}.json`, sha256: digest, byte_size: 512 * 1024 + 1 },
      session_commitment: digest,
      transcript_commitment: digest,
      ordered_sources: [],
      reduction_ref: checkpointRef,
      reduction_output_sha256: digest,
      auditor_output: output,
      auditor_output_sha256: digest,
      auditor_child_id: "auditor",
      checker_ref: checkpointRef,
      checker_output: { passed: true, findings: [] },
      checker_output_sha256: digest,
      checker_child_id: "checker",
    }
    expect(HistoricalCandidateBindingSchema.safeParse(binding).success).toBe(true)
    expect(HistoricalCandidateBindingSchema.safeParse({
      ...binding, snapshot_ref: { ...binding.snapshot_ref, byte_size: HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES },
    }).success).toBe(true)
    expect(HistoricalCandidateBindingSchema.safeParse({
      ...binding, snapshot_ref: { ...binding.snapshot_ref, byte_size: HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES + 1 },
    }).success).toBe(false)
    expect(HistoricalCandidateBindingSchema.safeParse({
      ...binding, reduction_ref: { ...checkpointRef, byte_size: 512 * 1024 + 1 },
    }).success).toBe(false)
    expect(historicalSnapshotReferenceByteUpperBound(HISTORICAL_MAX_CANONICAL_SNAPSHOT_BYTES)).toBe(HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES)
  })

  test("candidate creation atomically rejects a historical plan cancelled before its store lock", async () => {
    const project = tempProject("alg-historical-candidate-cancel-lock-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      const active = runtime(project, sdk, true)
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const token = preview.result.confirmation as string
      const digest = "b".repeat(64)
      const checkpointRef = { path: `.opencode/skill-evolution/historical-checkpoints/${digest}.json`, sha256: digest, byte_size: 1 }
      updateHistoricalIndex(project, "test-cancel-before-candidate-lock", (index) => {
        const plan = index.plans[0] as any
        plan.state = "cancelled"
        plan.disposition = "cancelled"
        plan.cancelled = true
        plan.reduction_ref = checkpointRef
        plan.checker_ref = checkpointRef
      })
      const output = candidateOutput()
      const binding = HistoricalCandidateBindingSchema.parse({
        plan_confirmation: token,
        snapshot_ref: preview.result.sessions[0].snapshot_ref,
        session_commitment: preview.result.sessions[0].commitment,
        transcript_commitment: digest,
        ordered_sources: [],
        reduction_ref: checkpointRef,
        reduction_output_sha256: digest,
        auditor_output: output,
        auditor_output_sha256: digest,
        auditor_child_id: "historical-auditor",
        checker_ref: checkpointRef,
        checker_output: { passed: true, findings: [] },
        checker_output_sha256: digest,
        checker_child_id: "historical-checker",
      })
      expect(() => createSkillCandidate(
        project,
        skillLedgerKey("selected", "message-1"),
        output,
        { path: `.opencode/skill-evolution/evidence/${digest}.json`, sha256: digest, byte_size: 1 },
        "historical-auditor",
        "historical-checker",
        { passed: true, findings: [] },
        active.options,
        binding,
      )).toThrow("not actively publishable")
      expect(loadSkillCandidates(project).candidates).toEqual([])
      active.dispose()
    } finally { removeProject(project) }
  })

  test("near-cap canonical snapshots and references persist while either over-cap form is rejected", () => {
    const project = tempProject("alg-historical-snapshot-cap-")
    try {
      const empty = canonicalJson({ payload: "" })
      const payload = { payload: "x".repeat(HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES - Buffer.byteLength(empty)) }
      expect(Buffer.byteLength(canonicalJson(payload))).toBe(HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES)
      const reference = persistHistoricalImmutable(project, "snapshot", payload, HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES)
      expect(reference.byte_size).toBe(HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES)
      expect(HistoricalSnapshotReferenceSchema.safeParse(reference).success).toBe(true)
      expect(() => persistHistoricalImmutable(project, "snapshot", { payload: `${payload.payload}x` }, HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES)).toThrow(/exceeds/)
      expect(HistoricalSnapshotReferenceSchema.safeParse({ ...reference, byte_size: HISTORICAL_SNAPSHOT_REFERENCE_MAX_BYTES + 1 }).success).toBe(false)
    } finally { removeProject(project) }
  }, 30_000)

  test("oversized serialized session metadata fails before transcript reads or snapshot persistence", async () => {
    const project = tempProject("alg-historical-metadata-cap-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      const client = sdk.client() as any
      client.session.get = async (request: any) => ({ data: {
        id: request.path.id, projectID: "project", directory: project, title: "ordinary",
        padding: "x".repeat(HISTORICAL_SESSION_METADATA_MAX_BYTES),
      }, error: undefined })
      const active = createSkillEvolutionRuntime({ client, project: { id: "project" }, directory: project, worktree: project } as never, {
        options: SkillEvolutionOptionsSchema.parse({ enabled: true, historical: { enabled: true } }),
      })
      expect((await active.historicalInitialize({ action: "preview", session_ids: ["selected"] })).code).toBe("oversized")
      expect(sdk.messageReads).toBe(0)
      expect(loadHistoricalIndex(project)).toMatchObject({ plans: [], snapshots: [] })
      active.dispose()
    } finally { removeProject(project) }
  })

  test("public historical tool has one required strict request union and forwards every valid variant unchanged", async () => {
    const seen: unknown[] = []
    const tools = createSkillEvolutionTools({ historicalInitialize: async (value: unknown) => {
      seen.push(value)
      return { ok: false, action: (value as any).action, code: "disabled", error: "disabled" }
    } } as never)
    const definition = tools.alg_skill_evolution_historical as any
    expect(Object.keys(definition.args)).toEqual(["request"])
    const schema = definition.args.request
    const plan = "hist-" + "a".repeat(32)
    const token = "b".repeat(64)
    const invalid = [
      { action: "discover", plan_id: plan }, { action: "preview" }, { action: "preview", session_ids: ["x", "x"] },
      { action: "run", plan_id: plan }, { action: "resume", plan_id: plan }, { action: "cancel", plan_id: plan, confirmation: token },
      { action: "unknown" }, { action: "discover", extra: true },
    ]
    for (const request of invalid) expect(schema.safeParse(request).success).toBe(false)
    const valid = [
      { action: "discover" }, { action: "preview", session_ids: ["x"] }, { action: "run", plan_id: plan, confirmation: token },
      { action: "status", plan_id: plan }, { action: "resume", plan_id: plan, confirmation: token }, { action: "cancel", plan_id: plan },
    ]
    for (const request of valid) await definition.execute({ request })
    expect(seen).toEqual(valid)
  })

  test("maxChunkBytes boundary accounts for worst-case base64, metadata, and framing", () => {
    expect(SkillEvolutionOptionsSchema.safeParse({ historical: { maxChunkBytes: HISTORICAL_MAX_CHUNK_BYTES } }).success).toBe(true)
    expect(SkillEvolutionOptionsSchema.safeParse({ historical: { maxChunkBytes: HISTORICAL_MAX_CHUNK_BYTES + 1 } }).success).toBe(false)
    expect(SkillEvolutionOptionsSchema.safeParse({ historical: { maxChunkBytes: 4_096 } }).success).toBe(true)
    expect(SkillEvolutionOptionsSchema.parse({}).historical.maxChunkBytes).toBe(32 * 1024)
    const worst = historicalAuditorPrompt({
      session_id: "\0".repeat(256),
      session_commitment: "f".repeat(64), message_index: 1_999, message_id: "\0".repeat(256), part_index: 9_999_999,
      part_id: "\0".repeat(262), part_type: "step-finish", fragment_index: 511, fragment_count: 512,
      byte_offset: 16 * 1024 * 1024, byte_length: 16 * 1024 * 1024, sha256: "f".repeat(64),
      data_base64: Buffer.alloc(HISTORICAL_MAX_CHUNK_BYTES).toString("base64"),
    })
    expect(Buffer.byteLength(worst)).toBe(historicalAuditorPromptByteUpperBound(HISTORICAL_MAX_CHUNK_BYTES))
    expect(Buffer.byteLength(worst)).toBeLessThanOrEqual(HISTORICAL_CHILD_PROMPT_MAX_BYTES)
    expect(historicalAuditorPromptByteUpperBound(HISTORICAL_MAX_CHUNK_BYTES + 1)).toBeGreaterThan(HISTORICAL_CHILD_PROMPT_MAX_BYTES)
    const empty = normalizeHistoricalMessages([{
      info: { id: "\0".repeat(256), sessionID: "selected", role: "assistant", time: { created: 0, completed: 1 } },
      parts: [],
    }], "selected")
    expect(empty.records[0]!.part_id).toHaveLength(262)
  })

  test("missing or malformed current project identity fails closed before V1 reads or persistence", async () => {
    for (const projectIdentity of [undefined, { id: "" }, { id: " malformed " }, { id: 7 }]) {
      const project = tempProject("alg-historical-project-id-")
      try {
        const sdk = new HistoricalSdk(project, transcript("selected", 2))
        const active = createSkillEvolutionRuntime({ client: sdk.client(), project: projectIdentity, directory: project, worktree: project } as never, {
          options: SkillEvolutionOptionsSchema.parse({ enabled: true, historical: { enabled: true } }),
        })
        expect((await active.historicalInitialize({ action: "discover" })).code).toBe("unavailable")
        expect((await active.historicalInitialize({ action: "preview", session_ids: ["selected"] })).code).toBe("unavailable")
        expect(sdk.calls).toEqual([])
        expect(sdk.creates).toEqual([])
        expect(loadHistoricalIndex(project)).toMatchObject({ plans: [], snapshots: [] })
        active.dispose()
      } finally { removeProject(project) }
    }
  })

  test("all historical actions preserve project skill roots and user/global OpenCode sentinels", async () => {
    const sandbox = tempProject("alg-historical-fs-")
    const project = join(sandbox, "project")
    const home = join(sandbox, "home")
    const xdg = join(sandbox, "xdg")
    const appdata = join(sandbox, "appdata")
    const explicitConfig = join(sandbox, "explicit-config", "opencode.jsonc")
    const explicitConfigDir = join(sandbox, "explicit-config-dir")
    const environment = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "APPDATA", "OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"] as const
    const savedEnvironment = Object.fromEntries(environment.map((key) => [key, process.env[key]]))
    try {
      Object.assign(process.env, {
        HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, APPDATA: appdata,
        OPENCODE_CONFIG: explicitConfig, OPENCODE_CONFIG_DIR: explicitConfigDir,
      })
      mkdirSync(project, { recursive: true })
      const projectSkill = join(project, ".opencode", "skills")
      const configuredSkill = join(project, "project-skills")
      const configuredGlobalRoots = realUserGlobalConfigRoots(process.env, process.platform).map((entry) => entry.path)
      const actualSkillRoots = [
        ...configuredGlobalRoots.map((root) => join(root, "skills")),
        join(home, ".claude", "skills"),
        join(home, ".agents", "skills"),
        join(explicitConfigDir, "skills"),
      ]
      for (const root of [projectSkill, configuredSkill, ...actualSkillRoots]) {
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, "sentinel.txt"), `sentinel:${root}`, "utf8")
      }
      for (const root of [...configuredGlobalRoots, explicitConfigDir]) {
        mkdirSync(root, { recursive: true })
        writeFileSync(join(root, "opencode.json"), '{"sentinel":true}\n', "utf8")
      }
      mkdirSync(join(sandbox, "explicit-config"), { recursive: true })
      writeFileSync(explicitConfig, '{"sentinel":"explicit"}\n', "utf8")
      const protectedPaths = [projectSkill, configuredSkill, ...actualSkillRoots, ...configuredGlobalRoots, explicitConfig, explicitConfigDir]
      const before = protectedPaths.map(filesystemSnapshot)
      const assertProtected = () => expect(protectedPaths.map(filesystemSnapshot)).toEqual(before)
      // Pre-create the sole filesystem mutation root so ancestor metadata is
      // stable, then snapshot every other path in the configured sandbox.
      const allowedStore = join(project, ".opencode", "skill-evolution")
      mkdirSync(allowedStore, { recursive: true })
      const beforeOutsideStore = filesystemSnapshotExcept(sandbox, new Set([allowedStore]))
      const assertOnlyStoreChanged = () => expect(filesystemSnapshotExcept(sandbox, new Set([allowedStore]))).toEqual(beforeOutsideStore)

      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      const active = createSkillEvolutionRuntime({ client: sdk.client(), project: { id: "project" }, directory: project, worktree: project } as never, {
        options: SkillEvolutionOptionsSchema.parse({ enabled: true, skillRoots: [".opencode/skills", "project-skills"], historical: { enabled: true } }),
      })
      expect((await active.historicalInitialize({ action: "discover" })).code).toBe("discovered"); assertProtected(); assertOnlyStoreChanged()
      const cancelledPlan = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any; assertProtected(); assertOnlyStoreChanged()
      expect((await active.historicalInitialize({ action: "status", plan_id: cancelledPlan.result.plan_id })).ok).toBe(true); assertProtected(); assertOnlyStoreChanged()
      expect((await active.historicalInitialize({ action: "run", plan_id: cancelledPlan.result.plan_id, confirmation: "0".repeat(64) })).code).toBe("confirmation_mismatch")
      expect(sdk.creates).toHaveLength(0); assertProtected(); assertOnlyStoreChanged()
      expect((await active.historicalInitialize({ action: "cancel", plan_id: cancelledPlan.result.plan_id })).code).toBe("cancelled")
      expect((await active.historicalInitialize({ action: "resume", plan_id: cancelledPlan.result.plan_id, confirmation: cancelledPlan.result.confirmation })).code).toBe("cancelled")
      expect(sdk.creates).toHaveLength(0); assertProtected(); assertOnlyStoreChanged()

      sdk.values.splice(0, sdk.values.length, ...transcript("selected", 2, "-run"))
      const runPlan = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any; assertProtected(); assertOnlyStoreChanged()
      expect((await active.historicalInitialize({ action: "run", plan_id: runPlan.result.plan_id, confirmation: runPlan.result.confirmation })).code).toBe("completed")
      const created = sdk.creates.length
      expect(created).toBeGreaterThan(0); assertProtected(); assertOnlyStoreChanged()
      expect((await active.historicalInitialize({ action: "status", plan_id: runPlan.result.plan_id })).code).toBe("completed"); assertProtected(); assertOnlyStoreChanged()
      expect((await active.historicalInitialize({ action: "resume", plan_id: runPlan.result.plan_id, confirmation: runPlan.result.confirmation })).code).toBe("completed")
      expect(sdk.creates).toHaveLength(created); assertProtected(); assertOnlyStoreChanged()
      expect(loadSkillLedger(project).audit_children.map((entry) => entry.session_id)).toEqual(sdk.childIds)
      expect(readdirSync(join(project, ".opencode")).sort()).toEqual(["skill-evolution", "skills"])
      active.dispose()
    } finally {
      for (const key of environment) {
        const value = savedEnvironment[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      removeProject(sandbox)
    }
  }, 30_000)

  test("discovery and preview require exact projectID plus canonical containment", async () => {
    const project = tempProject("alg-historical-identity-")
    const outside = tempProject("alg-historical-outside-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      const client = sdk.client() as any
      client.session.list = async () => ({ data: [
        { id: "selected", projectID: "project", directory: project, title: "ok" },
        { id: "foreign", projectID: "other", directory: project, title: "foreign" },
        { id: "outside", projectID: "project", directory: outside, title: "outside" },
        { id: "malformed", directory: project, title: "missing-project" },
      ], error: undefined })
      const active = createSkillEvolutionRuntime({ client, project: { id: "project" }, directory: project, worktree: project } as never, {
        options: SkillEvolutionOptionsSchema.parse({ enabled: true, historical: { enabled: true } }),
      })
      const discovered = await active.historicalInitialize({ action: "discover" }) as any
      expect(discovered.result.sessions.map((entry: any) => entry.id)).toEqual(["selected"])
      expect(discovered.result.rejected).toBe(3)
      client.session.get = async (request: any) => ({ data: { id: request.path.id, projectID: "other", directory: project, title: "ordinary" }, error: undefined })
      expect((await active.historicalInitialize({ action: "preview", session_ids: ["selected"] })).code).toBe("cross_project")
      client.session.get = async (request: any) => ({ data: { id: request.path.id, projectID: "project", directory: outside, title: "ordinary" }, error: undefined })
      expect((await active.historicalInitialize({ action: "preview", session_ids: ["selected"] })).code).toBe("cross_project")
      expect(sdk.messageReads).toBe(0)
      active.dispose()
    } finally { removeProject(project); removeProject(outside) }
  })

  test("normalization preserves declared JSON shapes, rejects bad links, and fragments multibyte bytes losslessly", async () => {
    const sessionId = "selected"
    const values = transcript(sessionId, 2)
    values[1]!.parts.push(
      { id: "reason", sessionID: sessionId, messageID: "message-1", type: "reasoning", text: "🙂".repeat(5_000) },
      { id: "subtask", sessionID: sessionId, messageID: "message-1", type: "subtask", prompt: "delegate", description: "bounded" },
      { id: "file", sessionID: sessionId, messageID: "message-1", type: "file", mime: "text/plain", filename: "x", url: "data:,x", source: { type: "symbol", path: "x.ts", range: { start: 1, end: 2 }, name: "x", kind: 12 } },
      ...(["pending", "running", "completed", "error"] as const).map((status) => ({ id: `tool-${status}`, sessionID: sessionId, messageID: "message-1", type: "tool", tool: "bash", state: { status, input: {}, output: "ok", error: "bad", attachments: [{ mime: "text/plain", url: "data:,x" }] } })),
      { id: "step-start", sessionID: sessionId, messageID: "message-1", type: "step-start", snapshot: "a" },
      { id: "step-finish", sessionID: sessionId, messageID: "message-1", type: "step-finish", reason: "stop", cost: 1, tokens: { input: 1, output: 1 } },
      { id: "snapshot", sessionID: sessionId, messageID: "message-1", type: "snapshot", snapshot: "tree" },
      { id: "patch", sessionID: sessionId, messageID: "message-1", type: "patch", hash: "h", files: ["x"] },
      { id: "agent", sessionID: sessionId, messageID: "message-1", type: "agent", name: "researcher" },
      { id: "retry", sessionID: sessionId, messageID: "message-1", type: "retry", attempt: 1, error: { name: "APIError", message: "retry" }, time: { created: 1 } },
      { id: "compact", sessionID: sessionId, messageID: "message-1", type: "compaction", automatic: true },
    )
    for (const [index, name] of ["ProviderAuthError", "UnknownError", "MessageOutputLengthError", "MessageAbortedError", "APIError"].entries()) {
      values.push({ info: { id: `error-${index}`, sessionID: sessionId, role: "assistant", parentID: "message-0", mode: "build", providerID: "p", modelID: "m", time: { created: 2 + index, completed: 3 + index }, error: { name, data: { message: "declared variant", statusCode: 500, isRetryable: true } } }, parts: [] })
    }
    const normalized = normalizeHistoricalMessages(values, sessionId)
    expect(normalized.messages).toBe(7)
    expect(normalized.parts).toBe(16)
    expect(Buffer.byteLength(normalized.canonical)).toBe(normalized.byte_count)
    expect(normalized.assistant_message_ids).toEqual(["message-1", "error-0", "error-1", "error-2", "error-3", "error-4"])
    const malformed = structuredClone(values)
    malformed[1]!.parts[0]!.messageID = "wrong"
    expect(() => normalizeHistoricalMessages(malformed, sessionId)).toThrow(/identity links/)
  })

  test("disabled by default makes no historical V1 or model calls", async () => {
    const project = tempProject("alg-historical-disabled-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      const active = runtime(project, sdk, false)
      for (const input of [{ action: "discover" }, { action: "preview", session_ids: ["selected"] }]) {
        expect((await active.historicalInitialize(input)).code).toBe("disabled")
      }
      expect(sdk.calls).toHaveLength(0)
      expect(sdk.creates).toHaveLength(0)
      active.dispose()
    } finally { removeProject(project) }
  })

  test("seals all 101+ messages with repeated limit+1 reads, immutable preview, confirmation, run, dedupe, and cancel", async () => {
    const project = tempProject("alg-historical-complete-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 101))
      const active = runtime(project, sdk, true, { maxChunkBytes: 4_096, maxChunksPerSession: 128 })
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] })
      expect(preview).toMatchObject({ ok: true, code: "previewed" })
      const value = (preview as any).result
      expect(value.completeness).toBe("v1_bounded_snapshot")
      expect(value.sessions[0].message_count).toBe(101)
      expect(sdk.calls.filter(([kind]) => kind === "messages").map(([, request]) => request.query.limit)).toEqual([151, 151])
      expect(sdk.creates).toHaveLength(0)

      const indexed = loadHistoricalIndex(project).plans[0] as any
      const immutable = loadHistoricalImmutable(project, indexed.plan_ref, "plan", 512 * 1024) as any
      expect(immutable.selected_session_ids).toEqual(["selected"])
      const mismatch = await active.historicalInitialize({ action: "run", plan_id: value.plan_id, confirmation: "0".repeat(64) })
      expect(mismatch.code).toBe("confirmation_mismatch")
      expect(sdk.creates).toHaveLength(0)
      const completed = await active.historicalInitialize({ action: "run", plan_id: value.plan_id, confirmation: value.confirmation })
      expect(completed.code).toBe("completed")
      const calls = sdk.creates.length
      const duplicate = await active.historicalInitialize({ action: "resume", plan_id: value.plan_id, confirmation: value.confirmation })
      expect(duplicate).toMatchObject({ ok: true, code: "completed" })
      expect(sdk.creates).toHaveLength(calls)

      const samePreview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      expect(samePreview.code).toBe("completed")
      expect(samePreview.result.plan_id).toBe(value.plan_id)
      sdk.values.splice(0, sdk.values.length, ...transcript("selected", 2, "-changed"))
      const secondPreview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      expect(secondPreview.result.sessions[0].predecessor_commitment).toBe(value.sessions[0].commitment)
      const cancelled = await active.historicalInitialize({ action: "cancel", plan_id: secondPreview.result.plan_id })
      expect(cancelled.code).toBe("cancelled")
      expect((await active.historicalInitialize({ action: "resume", plan_id: secondPreview.result.plan_id, confirmation: secondPreview.result.confirmation })).code).toBe("cancelled")

      sdk.values.splice(0, sdk.values.length, ...transcript("selected", 2, "-failed"))
      sdk.failuresRemaining = 2
      const thirdPreview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      expect(thirdPreview.result.sessions[0].predecessor_commitment).toBe(secondPreview.result.sessions[0].commitment)
      expect((await active.historicalInitialize({ action: "run", plan_id: thirdPreview.result.plan_id, confirmation: thirdPreview.result.confirmation })).ok).toBe(false)

      sdk.failuresRemaining = 0
      sdk.values.splice(0, sdk.values.length, ...transcript("selected", 2, "-completed"))
      const fourthPreview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      expect(fourthPreview.result.sessions[0].predecessor_commitment).toBe(thirdPreview.result.sessions[0].commitment)
      const fourthRun = await active.historicalInitialize({ action: "run", plan_id: fourthPreview.result.plan_id, confirmation: fourthPreview.result.confirmation })
      expect(fourthRun.code).toBe("completed")
      const snapshots = loadHistoricalIndex(project).snapshots
      expect(snapshots.map((entry) => entry.commitment)).toEqual([
        value.sessions[0].commitment, secondPreview.result.sessions[0].commitment,
        thirdPreview.result.sessions[0].commitment, fourthPreview.result.sessions[0].commitment,
      ])
      expect(snapshots[0]!.state_history.map((entry) => entry.disposition)).toEqual(["previewed", "queued", "running", "completed", "previewed", "completed"])
      expect(snapshots[1]!.state_history.map((entry) => entry.disposition)).toEqual(["previewed", "cancelled"])
      expect(snapshots[2]!.state_history.map((entry) => entry.disposition)).toEqual(["previewed", "queued", "running", "failed", "resumable"])
      expect(snapshots[3]!.state_history.map((entry) => entry.disposition)).toEqual(["previewed", "queued", "running", "completed"])
      active.dispose()
    } finally { removeProject(project) }
  }, 180_000)

  test("overflow and repeated mutation reject without seal or model call", async () => {
    for (const mode of ["overflow", "unstable"] as const) {
      const project = tempProject(`alg-historical-${mode}-`)
      try {
        const count = mode === "overflow" ? 151 : 2
        const sdk = new HistoricalSdk(project, transcript("selected", count))
        sdk.mutate = mode === "unstable"
        const active = runtime(project, sdk, true, { stabilityRounds: 3 })
        const result = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] })
        expect(result.code).toBe(mode)
        expect(sdk.creates).toHaveLength(0)
        expect(loadHistoricalIndex(project).plans).toEqual([])
        active.dispose()
      } finally { removeProject(project) }
    }
  })

  test("cross-project and private-child selections fail with stable dispositions", async () => {
    for (const mode of ["cross_project", "private_child"] as const) {
      const project = tempProject(`alg-historical-${mode}-`)
      try {
        const sdk = new HistoricalSdk(project, transcript("selected", 2), mode === "private_child" ? "alg-private-skill-evolution-historical:test" : "ordinary")
        const client = sdk.client() as any
        if (mode === "cross_project") client.session.get = async (request: any) => ({ data: { id: request.path.id, projectID: "other", directory: project, title: "ordinary" }, error: undefined })
        const active = createSkillEvolutionRuntime({ client, project: { id: "project" }, directory: project, worktree: project } as never, {
          options: SkillEvolutionOptionsSchema.parse({ enabled: true, historical: { enabled: true } }),
        })
        expect((await active.historicalInitialize({ action: "preview", session_ids: ["selected"] })).code).toBe(mode)
        expect(sdk.creates).toHaveLength(0)
        active.dispose()
      } finally { removeProject(project) }
    }
  })

  test("deterministic local reduction and a fresh checker create a validated but unpromoted candidate", async () => {
    const project = tempProject("alg-historical-candidate-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      sdk.candidate = true
      const active = runtime(project, sdk, true)
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const completed = await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation }) as any
      expect(completed).toMatchObject({ ok: true, code: "completed", result: { reduction: "candidate" } })
      expect(sdk.creates.length).toBe(preview.result.sessions[0].fragment_count + 1)
      expect(sdk.prompts.some((request) => request.body.parts[0].text.includes("retrospective reducer"))).toBe(false)
      expect(sdk.creates.every((request) => request.body.title.startsWith("alg-private-skill-evolution-historical:"))).toBe(true)
      const candidate = active.status().candidates.candidates.find((entry) => entry.candidate_id === completed.result.candidate_id)
      expect(candidate).toMatchObject({ state: "validated", promoted_hash: null, provenance: { session_id: "selected", assistant_message_id: "message-1" } })
      active.dispose()
    } finally { removeProject(project) }
  })

  test("completed verification rejects every security-relevant candidate mirror and initial revision substitution", async () => {
    const project = tempProject("alg-historical-completed-candidate-integrity-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      sdk.candidate = true
      const active = runtime(project, sdk, true)
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      expect((await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })).code).toBe("completed")
      const candidatePath = join(project, ".opencode", "skill-evolution", "candidates.json")
      const originalIndexText = readFileSync(candidatePath, "utf8")
      const originalIndex = JSON.parse(originalIndexText)
      const originalCandidate = loadSkillCandidates(project).candidates[0]!
      const originalRevision = loadCandidateRevision(project, originalCandidate, 1)
      const assertRejected = async () => {
        expect((await active.historicalInitialize({ action: "status", plan_id: preview.result.plan_id })).code).toBe("confirmation_mismatch")
        writeFileSync(candidatePath, originalIndexText, "utf8")
      }

      const candidateMutations: Array<(candidate: any) => void> = [
        (candidate) => { candidate.candidate_id += "x" },
        (candidate) => { candidate.type = "memory"; candidate.target = null },
        (candidate) => { candidate.target = "substituted-target/SKILL.md" },
        (candidate) => { candidate.state = "proposed" },
        (candidate) => { candidate.decision = "skill_revision" },
        (candidate) => { candidate.provenance.assistant_completed_at++ },
        (candidate) => { candidate.evidence_refs = [] },
        (candidate) => { candidate.auditor_child_id = "substituted-auditor" },
        (candidate) => { candidate.checker_child_id = "substituted-checker" },
        (candidate) => { candidate.checker_findings = ["substituted finding"] },
        (candidate) => { candidate.historical_binding.auditor_child_id = "substituted-binding-auditor" },
      ]
      for (const mutate of candidateMutations) {
        const changed = structuredClone(originalIndex)
        mutate(changed.candidates[0])
        writeFileSync(candidatePath, JSON.stringify(changed, null, 2) + "\n", "utf8")
        await assertRejected()
      }

      const substituteRevision = async (mutate: (revision: any) => void, pathName?: string) => {
        const revision = structuredClone(originalRevision)
        mutate(revision)
        const bytes = canonicalJson(revision)
        const digest = createHash("sha256").update(bytes).digest("hex")
        const path = `.opencode/skill-evolution/revisions/${pathName ?? `${revision.candidate_id}-r1-${digest}.json`}`
        writeFileSync(join(project, ...path.split("/")), bytes, "utf8")
        const changed = structuredClone(originalIndex)
        changed.candidates[0].revision_refs = [{ path, sha256: digest, byte_size: Buffer.byteLength(bytes) }]
        writeFileSync(candidatePath, JSON.stringify(changed, null, 2) + "\n", "utf8")
        await assertRejected()
      }
      await substituteRevision((revision) => { revision.created_at = new Date(Date.parse(revision.created_at) + 1_000).toISOString() })
      await substituteRevision((revision) => { revision.actor_session_id = "substituted-checker" })
      await substituteRevision((revision) => { revision.auditor_output.rationale = "Substituted auditor output." })
      await substituteRevision((revision) => { revision.checker_output = { passed: false, findings: ["substituted verdict"] } })
      await substituteRevision((revision) => { revision.promotion = { target: ".opencode/skills/retrospective-review/SKILL.md", before_sha256: null, after_sha256: "f".repeat(64), restart_required: true } })
      await substituteRevision(() => {}, "substituted-initial-revision.json")

      expect((await active.historicalInitialize({ action: "status", plan_id: preview.result.plan_id })).code).toBe("completed")
      active.dispose()
    } finally { removeProject(project) }
  }, 30_000)

  test("interrupted chunk work is resumable from immutable committed checkpoints", async () => {
    const project = tempProject("alg-historical-resume-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      sdk.failuresRemaining = 2
      const active = runtime(project, sdk, true, { maxAttempts: 2 })
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const interrupted = await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })
      expect(interrupted.ok).toBe(false)
      expect((await active.historicalInitialize({ action: "status", plan_id: preview.result.plan_id }) as any).result.state).toBe("resumable")
      const resumed = await active.historicalInitialize({ action: "resume", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })
      expect(resumed.code).toBe("unavailable")
      expect(sdk.creates).toHaveLength(1)
      expect(loadHistoricalIndex(project).plans[0]).toMatchObject({ state: "resumable", next_chunk: 0 })
      active.dispose()
    } finally { removeProject(project) }
  })

  test("durable cancellation during active work prevents the next child call", async () => {
    const project = tempProject("alg-historical-active-cancel-")
    try {
      const values = transcript("selected", 2)
      values[1]!.parts[0]!.text = "x".repeat(12_000)
      const sdk = new HistoricalSdk(project, values)
      let release!: () => void
      sdk.promptGate = new Promise<void>((resolve) => { release = resolve })
      const active = runtime(project, sdk, true, { maxChunkBytes: 4_096 })
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const running = active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })
      while (sdk.prompts.length === 0) await Bun.sleep(5)
      expect((await active.historicalInitialize({ action: "cancel", plan_id: preview.result.plan_id })).code).toBe("cancelled")
      release()
      expect((await running).code).toBe("cancelled")
      expect(sdk.creates).toHaveLength(1)
      const cancelledPlan = loadHistoricalIndex(project).plans[0] as any
      expect(cancelledPlan).toMatchObject({ state: "cancelled", next_chunk: 0 })
      expect(cancelledPlan.checkpoints.some((entry: any) => entry.committed_at)).toBe(false)
      expect((await active.historicalInitialize({ action: "resume", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })).code).toBe("cancelled")
      active.dispose()
    } finally { removeProject(project) }
  })

  test("complete fragment review publishes every identity even when later checker work is cancelled", async () => {
    const project = tempProject("alg-historical-reviewed-cancel-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 4))
      sdk.candidate = true
      let release!: () => void
      const originalPrompt = (sdk.client() as any).session.prompt
      const client = sdk.client() as any
      client.session.prompt = async (request: any) => {
        if (request.body.parts[0].text.includes("pure checker")) await new Promise<void>((resolve) => { release = resolve })
        return originalPrompt(request)
      }
      const active = createSkillEvolutionRuntime({ client, project: { id: "project" }, directory: project, worktree: project } as never, {
        options: SkillEvolutionOptionsSchema.parse({ enabled: true, historical: { enabled: true } }),
      })
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const running = active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })
      while (!release) await Bun.sleep(5)
      expect(loadHistoricalIndex(project).coverage[0]?.assistant_message_ids).toEqual(["message-1", "message-3"])
      expect((await active.historicalInitialize({ action: "cancel", plan_id: preview.result.plan_id })).code).toBe("cancelled")
      release()
      expect((await running).code).toBe("cancelled")
      for (const messageId of ["message-1", "message-3"]) {
        expect(enqueueSkillAudit(project, "selected", messageId, active.options, true)).toMatchObject({ enqueued: false, reason: "historical" })
      }
      active.dispose()
    } finally { removeProject(project) }
  }, 30_000)

  test("persisted hard deadline survives resume and preview input estimate covers encoded auditor prompts", async () => {
    const project = tempProject("alg-historical-deadline-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      sdk.promptGate = new Promise<void>(() => {})
      const active = runtime(project, sdk, true, { maxTimeMs: 1_000, callTimeoutMs: 1_000 })
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const failed = await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })
      expect(failed.ok).toBe(false)
      const calls = sdk.creates.length
      const resumed = await active.historicalInitialize({ action: "resume", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })
      expect(resumed.code).toBe("unavailable")
      expect(sdk.creates).toHaveLength(calls)
      const actualPromptBytes = sdk.prompts.reduce((sum, request) => sum + Buffer.byteLength(request.body.parts[0].text), 0)
      expect(preview.result.estimated.input_bytes).toBeGreaterThanOrEqual(actualPromptBytes)
      const status = await active.historicalInitialize({ action: "status", plan_id: preview.result.plan_id }) as any
      expect(status.result.remaining_hard_budgets.time_ms).toBe(0)
      active.dispose()
    } finally { removeProject(project) }
  }, 10_000)

  test("mutable progress and forged completion cannot skip confirmed chunks", async () => {
    for (const mutation of ["next_chunk", "completed"] as const) {
      const project = tempProject(`alg-historical-tamper-${mutation}-`)
      try {
        const sdk = new HistoricalSdk(project, transcript("selected", 2))
        const active = runtime(project, sdk, true)
        const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
        updateHistoricalIndex(project, "test-tamper", (index) => {
          const plan = index.plans[0] as any
          if (mutation === "next_chunk") plan.next_chunk = 1
          else { plan.state = "completed"; plan.disposition = "completed" }
        })
        const result = await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })
        expect(result.code).toBe("confirmation_mismatch")
        expect(sdk.creates).toHaveLength(0)
        active.dispose()
      } finally { removeProject(project) }
    }
  })

  test("status and idempotent resume fail closed on missing final and reordered chunk evidence", async () => {
    for (const mutation of ["missing-final", "reordered-chunks"] as const) {
      const project = tempProject(`alg-historical-final-tamper-${mutation}-`)
      try {
        const values = transcript("selected", 2)
        values[1]!.parts[0]!.text = "x".repeat(10_000)
        const sdk = new HistoricalSdk(project, values)
        const active = runtime(project, sdk, true, { maxChunkBytes: 4_096 })
        const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
        expect((await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })).code).toBe("completed")
        const calls = sdk.creates.length
        updateHistoricalIndex(project, "test-completion-tamper", (index) => {
          const plan = index.plans[0] as any
          if (mutation === "missing-final") plan.final_ref = undefined
          else {
            const chunks = plan.checkpoints.filter((entry: any) => entry.stage === "chunk")
            ;[chunks[0].output_ref, chunks[1].output_ref] = [chunks[1].output_ref, chunks[0].output_ref]
          }
        })
        expect((await active.historicalInitialize({ action: "status", plan_id: preview.result.plan_id })).ok).toBe(false)
        expect((await active.historicalInitialize({ action: "resume", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })).code).toBe("confirmation_mismatch")
        expect(sdk.creates).toHaveLength(calls)
        active.dispose()
      } finally { removeProject(project) }
    }
  }, 30_000)

  test("status rejects unsafe chunk refs, completed disposition rollback, and trailing issued work", async () => {
    for (const mutation of ["unsafe-ref", "disposition", "trailing-issued"] as const) {
      const project = tempProject(`alg-historical-completed-tamper-${mutation}-`)
      try {
        const sdk = new HistoricalSdk(project, transcript("selected", 2))
        const active = runtime(project, sdk, true)
        const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
        expect((await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })).code).toBe("completed")
        updateHistoricalIndex(project, "test-completed-tamper", (index) => {
          const plan = index.plans[0] as any
          if (mutation === "unsafe-ref") plan.checkpoints.find((entry: any) => entry.stage === "chunk").output_ref.path = "../forged.json"
          if (mutation === "disposition") { plan.state = "resumable"; plan.disposition = "resumable" }
          if (mutation === "trailing-issued") plan.checkpoints.push({
            chunk_sha256: "f".repeat(64), child_session_id: "", issued_at: new Date().toISOString(), attempts: 0, model_calls: 0, input_bytes: 0,
          })
        })
        expect((await active.historicalInitialize({ action: "status", plan_id: preview.result.plan_id })).code).toBe("confirmation_mismatch")
        active.dispose()
      } finally { removeProject(project) }
    }
  }, 30_000)

  test("a reduction checkpoint from another confirmed plan fails closed", async () => {
    const project = tempProject("alg-historical-cross-plan-reduction-")
    try {
      const values = transcript("selected", 2)
      const sdk = new HistoricalSdk(project, values)
      const active = runtime(project, sdk, true)
      const firstPreview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      expect((await active.historicalInitialize({ action: "run", plan_id: firstPreview.result.plan_id, confirmation: firstPreview.result.confirmation })).code).toBe("completed")
      values[1]!.parts[0]!.text = "a second exact snapshot"
      const secondPreview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      expect((await active.historicalInitialize({ action: "run", plan_id: secondPreview.result.plan_id, confirmation: secondPreview.result.confirmation })).code).toBe("completed")
      updateHistoricalIndex(project, "test-cross-plan-reduction", (index) => {
        const first = index.plans.find((entry: any) => entry.plan_id === firstPreview.result.plan_id) as any
        const second = index.plans.find((entry: any) => entry.plan_id === secondPreview.result.plan_id) as any
        second.reduction_ref = first.reduction_ref
        second.checkpoints.find((entry: any) => entry.stage === "reduction").output_ref = first.reduction_ref
      })
      expect((await active.historicalInitialize({ action: "status", plan_id: secondPreview.result.plan_id })).code).toBe("confirmation_mismatch")
      active.dispose()
    } finally { removeProject(project) }
  }, 30_000)

  test("issued progress cannot lose or replace its immutable execution epoch", async () => {
    for (const mutation of ["missing", "replaced"] as const) {
      const project = tempProject(`alg-historical-epoch-tamper-${mutation}-`)
      try {
        const sdk = new HistoricalSdk(project, transcript("selected", 2))
        sdk.failuresRemaining = 1
        const active = runtime(project, sdk, true)
        const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
        expect((await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })).ok).toBe(false)
        const calls = sdk.creates.length
        updateHistoricalIndex(project, "test-epoch-tamper", (index) => {
          const plan = index.plans[0] as any
          if (mutation === "missing") delete plan.execution_epoch_ref
          else plan.execution_epoch_ref = plan.checkpoints[0].output_ref ?? plan.plan_ref
        })
        expect((await active.historicalInitialize({ action: "resume", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })).code).toBe("confirmation_mismatch")
        expect(sdk.creates).toHaveLength(calls)
        active.dispose()
      } finally { removeProject(project) }
    }
  })

  test("historical child prompt keeps the planned model while configuration mutates during create", async () => {
    const project = tempProject("alg-historical-model-race-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      let release!: () => void
      sdk.createGate = new Promise<void>((resolve) => { release = resolve })
      let researcher = { providerID: "planned-provider", modelID: "planned-auditor", variant: "planned-effort" }
      let checker = { providerID: "planned-provider", modelID: "planned-checker", variant: "planned-check" }
      const resolution = () => Object.fromEntries(["planner", "explorer", "researcher", "implementer", "checker", "repair", "default"].map((role) => {
        const model = role === "researcher" ? researcher : role === "checker" ? checker : undefined
        return [role, model ? { source: "opencode-role-config", ...model } : { source: "inherited-sdk-default" }]
      })) as any
      const active = createSkillEvolutionRuntime({ client: sdk.client(), project: { id: "project" }, directory: project, worktree: project } as never, {
        options: SkillEvolutionOptionsSchema.parse({ enabled: true, historical: { enabled: true } }), configuredResolutions: resolution,
      })
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const running = active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })
      while (sdk.creates.length === 0) await Bun.sleep(5)
      researcher = { providerID: "mutated-provider", modelID: "mutated-auditor", variant: "mutated-effort" }
      checker = { providerID: "mutated-provider", modelID: "mutated-checker", variant: "mutated-check" }
      release()
      expect((await running).code).toBe("completed")
      expect(sdk.prompts[0]!.body).toMatchObject({ model: { providerID: "planned-provider", modelID: "planned-auditor" }, variant: "planned-effort" })
      expect(JSON.stringify(sdk.prompts)).not.toContain("mutated-provider")
      active.dispose()
    } finally { removeProject(project) }
  }, 30_000)

  test("changed transcript bytes with reused message IDs produce a distinct historical candidate", async () => {
    const project = tempProject("alg-historical-snapshot-candidate-")
    try {
      const values = transcript("selected", 2)
      const sdk = new HistoricalSdk(project, values)
      sdk.candidate = true
      const active = runtime(project, sdk, true)
      const firstPreview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const first = await active.historicalInitialize({ action: "run", plan_id: firstPreview.result.plan_id, confirmation: firstPreview.result.confirmation }) as any
      const retry = await active.historicalInitialize({ action: "resume", plan_id: firstPreview.result.plan_id, confirmation: firstPreview.result.confirmation }) as any
      expect(retry.result.idempotent).toBe(true)
      expect(retry.result.plan_id).toBe(firstPreview.result.plan_id)
      values[1]!.parts[0]!.text = "changed transcript bytes with the same session and message identities"
      const secondPreview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const second = await active.historicalInitialize({ action: "run", plan_id: secondPreview.result.plan_id, confirmation: secondPreview.result.confirmation }) as any
      expect(second.result.candidate_id).not.toBe(first.result.candidate_id)
      expect(active.status().candidates.candidates.map((candidate) => candidate.candidate_id)).toContainAllValues([first.result.candidate_id, second.result.candidate_id])
      active.dispose()
    } finally { removeProject(project) }
  }, 30_000)

  test("project lease rejects a concurrent resume before another child create", async () => {
    const project = tempProject("alg-historical-concurrent-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      let release!: () => void
      sdk.promptGate = new Promise<void>((resolve) => { release = resolve })
      const first = runtime(project, sdk, true)
      const preview = await first.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const running = first.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })
      while (sdk.prompts.length === 0) await Bun.sleep(5)
      const second = runtime(project, sdk, true)
      expect((await second.historicalInitialize({ action: "resume", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })).code).toBe("resumable")
      expect(sdk.creates).toHaveLength(1)
      release()
      expect((await running).code).toBe("completed")
      first.dispose(); second.dispose()
    } finally { removeProject(project) }
  })

  test("a reused first snapshot records a failed multi-session preview attempt", async () => {
    const project = tempProject("alg-historical-partial-preview-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      const active = runtime(project, sdk, true)
      await active.historicalInitialize({ action: "preview", session_ids: ["selected"] })
      const client = (active as any).plugin.client
      const originalGet = client.session.get
      client.session.get = async (request: any) => request.path.id === "later"
        ? { data: undefined, error: { message: "missing" } }
        : originalGet(request)
      expect((await active.historicalInitialize({ action: "preview", session_ids: ["selected", "later"] })).ok).toBe(false)
      const snapshot = loadHistoricalIndex(project).snapshots[0]!
      expect(snapshot.state_history.at(-1)).toMatchObject({ disposition: "previewed" })
      expect(snapshot.state_history.at(-1)!.plan_id).toStartWith("preview-")
      active.dispose()
    } finally { removeProject(project) }
  })

  test("forged fragment provenance and memory candidates stop before publication/checker", async () => {
    for (const mode of ["forged", "memory"] as const) {
      const project = tempProject(`alg-historical-${mode}-`)
      try {
        const sdk = new HistoricalSdk(project, transcript("selected", 2))
        sdk.candidate = true
        sdk.forgeSource = mode === "forged"
        sdk.memoryCandidate = mode === "memory"
        const active = runtime(project, sdk, true)
        const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
        const result = await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation }) as any
        if (mode === "forged") expect(result.ok).toBe(false)
        else expect(result).toMatchObject({ ok: true, result: { reduction: "no_change" } })
        expect(sdk.prompts.filter((request) => request.body.parts[0].text.includes("pure checker"))).toHaveLength(0)
        expect(active.status().candidates.candidates).toHaveLength(0)
        active.dispose()
      } finally { removeProject(project) }
    }
  })

  test("live-first and historical-first claim order deterministically selects one assistant auditor", async () => {
    const liveFirstProject = tempProject("alg-historical-claim-live-first-")
    const historicalFirstProject = tempProject("alg-historical-claim-historical-first-")
    try {
      const liveSdk = new HistoricalSdk(liveFirstProject, transcript("selected", 2))
      let releaseLive!: () => void
      liveSdk.promptGate = new Promise<void>((resolve) => { releaseLive = resolve })
      liveSdk.promptGateFor = (prompt) => prompt.includes("UNTRUSTED EVIDENCE JSON:\n")
      const liveFirst = createSkillEvolutionRuntime({ client: liveSdk.client(), project: { id: "project" }, directory: liveFirstProject, worktree: liveFirstProject } as never, {
        options: SkillEvolutionOptionsSchema.parse({ enabled: true, mode: "every-turn", historical: { enabled: true } }),
      })
      const livePreview = await liveFirst.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      liveFirst.handleEvent({ type: "message.updated", properties: { info: transcript("selected", 2)[1]!.info } } as any)
      while (!liveSdk.prompts.some((request) => request.body.parts[0].text.includes("UNTRUSTED EVIDENCE JSON:\n"))) await Bun.sleep(5)
      expect((await liveFirst.historicalInitialize({ action: "run", plan_id: livePreview.result.plan_id, confirmation: livePreview.result.confirmation })).code).toBe("resumable")
      expect(liveSdk.prompts.filter((request) => request.body.parts[0].text.includes("retrospective skill auditor"))).toHaveLength(0)
      releaseLive()
      while (loadSkillLedger(liveFirstProject).records[0]?.status !== "no-change") await Bun.sleep(5)
      const resumedLiveFirst = await liveFirst.historicalInitialize({ action: "resume", plan_id: livePreview.result.plan_id, confirmation: livePreview.result.confirmation })
      expect(resumedLiveFirst).toMatchObject({ ok: true, code: "completed" })
      expect(liveSdk.prompts.filter((request) => request.body.parts[0].text.includes("retrospective skill auditor") && request.body.parts[0].text.includes('"message_id":"message-1"'))).toHaveLength(0)

      const historicalSdk = new HistoricalSdk(historicalFirstProject, transcript("selected", 2))
      let releaseHistorical!: () => void
      historicalSdk.createGate = new Promise<void>((resolve) => { releaseHistorical = resolve })
      const historicalFirst = runtime(historicalFirstProject, historicalSdk, true)
      const historicalPreview = await historicalFirst.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const historicalRun = historicalFirst.historicalInitialize({ action: "run", plan_id: historicalPreview.result.plan_id, confirmation: historicalPreview.result.confirmation })
      while (historicalSdk.creates.length === 0) await Bun.sleep(5)
      expect(enqueueSkillAudit(historicalFirstProject, "selected", "message-1", historicalFirst.options, false)).toMatchObject({
        enqueued: false, reason: "historical", record: { status: "failed" },
      })
      releaseHistorical()
      expect((await historicalRun).code).toBe("completed")
      expect(historicalSdk.prompts.filter((request) => request.body.parts[0].text.includes("retrospective skill auditor") && request.body.parts[0].text.includes('"message_id":"message-1"'))).toHaveLength(1)
      expect(loadSkillLedger(historicalFirstProject).records[0]).toMatchObject({ status: "no-change" })
      liveFirst.dispose(); historicalFirst.dispose()
    } finally {
      removeProject(liveFirstProject)
      removeProject(historicalFirstProject)
    }
  }, 30_000)

  test("historical completion while a live auditor create is blocked prevents its prompt and publication", async () => {
    const project = tempProject("alg-historical-live-create-cancel-")
    let releaseLive!: () => void
    try {
      const historicalSdk = new HistoricalSdk(project, transcript("selected", 2))
      historicalSdk.candidate = true
      const historical = runtime(project, historicalSdk, true)
      const preview = await historical.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any

      const liveSdk = new HistoricalSdk(project, transcript("selected", 2))
      liveSdk.candidate = true
      liveSdk.createGate = new Promise<void>((resolve) => { releaseLive = resolve })
      const live = createSkillEvolutionRuntime({ client: liveSdk.client(), project: { id: "project" }, directory: project, worktree: project } as never, {
        options: SkillEvolutionOptionsSchema.parse({ enabled: true, mode: "every-turn", historical: { enabled: true } }),
      })
      live.handleEvent({ type: "message.updated", properties: { info: transcript("selected", 2)[1]!.info } } as any)
      while (liveSdk.creates.length === 0) await Bun.sleep(5)
      expect(liveSdk.prompts).toHaveLength(0)

      failSkillAudit(project, skillLedgerKey("selected", "message-1"), "simulated loss while live session.create is blocked")
      expect((await historical.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })).code).toBe("completed")
      releaseLive()
      await Bun.sleep(50)

      expect(liveSdk.prompts).toHaveLength(0)
      expect(loadSkillCandidates(project).candidates).toHaveLength(1)
      expect(loadSkillCandidates(project).candidates[0]!.candidate_id).toStartWith("se-h-")
      expect(loadSkillLedger(project).records[0]).toMatchObject({ status: "no-change" })
      live.dispose(); historical.dispose()
    } finally {
      releaseLive?.()
      removeProject(project)
    }
  }, 30_000)

  test.each(["missing", "corrupt", "ambiguous"] as const)("a %s reviewed-live candidate behind candidate ledger status fails inconsistent before historical suppression", async (mode) => {
    const project = tempProject(`alg-historical-live-candidate-${mode}-`)
    try {
      const values = transcript("selected", 2)
      const sdk = new HistoricalSdk(project, values)
      sdk.candidate = true
      const active = runtime(project, sdk, true)
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      let candidateCount = 0
      if (mode === "missing") {
        const queued = enqueueSkillAudit(project, "selected", "message-1", active.options)
        const evidence = buildSkillEvidence(values, "selected", "message-1", active.options)
        const evidenceRef = persistSkillEvidence(project, evidence)
        markSkillLedgerOutcome(project, queued.record.key, {
          status: "candidate", trigger_score: evidence.trigger_score, trigger_labels: evidence.trigger_labels,
          evidence_ref: evidenceRef, candidate_id: "missing-live-candidate",
        })
      } else {
        const { candidate } = persistReviewedLiveCandidate(project, values, active.options)
        candidateCount = 1
        if (mode === "corrupt") {
          writeFileSync(join(project, ...candidate.revision_refs[0]!.path.split("/")), "{}", "utf8")
        } else {
          const candidatePath = join(project, ".opencode", "skill-evolution", "candidates.json")
          const index = JSON.parse(readFileSync(candidatePath, "utf8"))
          index.candidates.push(structuredClone(index.candidates[0]))
          writeFileSync(candidatePath, JSON.stringify(index, null, 2) + "\n", "utf8")
          candidateCount = 2
        }
      }
      expect(findReviewedLiveSkillCandidate(project, "selected", "message-1")).toBeNull()

      const result = await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation }) as any
      expect(result).toMatchObject({ ok: false, code: "inconsistent" })
      expect(result.error).toMatch(/candidate|review-backed/)
      expect(sdk.creates).toHaveLength(0)
      expect(loadSkillCandidates(project).candidates).toHaveLength(candidateCount)
      expect(loadSkillCandidates(project).candidates.some((candidate) => candidate.candidate_id.startsWith("se-h-"))).toBe(false)
      expect(loadHistoricalIndex(project).coverage).toEqual([])
      active.dispose()
    } finally { removeProject(project) }
  }, 30_000)

  test("a candidate ledger status appearing after chunk review fails inconsistent before coverage or a second candidate", async () => {
    const project = tempProject("alg-historical-live-candidate-reduction-race-")
    try {
      const values = transcript("selected", 2)
      const sdk = new HistoricalSdk(project, values)
      sdk.candidate = true
      const client = sdk.client() as any
      const originalPrompt = client.session.prompt
      let injected = false
      let key = ""
      let evidence: ReturnType<typeof buildSkillEvidence>
      let evidenceRef: ReturnType<typeof persistSkillEvidence>
      client.session.prompt = async (request: any) => {
        const response = await originalPrompt(request)
        const prompt = request.body.parts[0].text as string
        if (!injected && prompt.includes("UNTRUSTED FRAGMENT JSON:\n") && prompt.includes('"message_id":"message-1"')) {
          injected = true
          markSkillLedgerOutcome(project, key, {
            status: "candidate", trigger_score: evidence.trigger_score, trigger_labels: evidence.trigger_labels,
            evidence_ref: evidenceRef, candidate_id: "missing-live-candidate",
          })
        }
        return response
      }
      const active = createSkillEvolutionRuntime({ client, project: { id: "project" }, directory: project, worktree: project } as never, {
        options: SkillEvolutionOptionsSchema.parse({ enabled: true, historical: { enabled: true } }),
      })
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const queued = enqueueSkillAudit(project, "selected", "message-1", active.options)
      key = queued.record.key
      evidence = buildSkillEvidence(values, "selected", "message-1", active.options)
      evidenceRef = persistSkillEvidence(project, evidence)
      failSkillAudit(project, key, "make the live owner stale before historical takeover")

      const result = await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation }) as any
      expect(injected).toBe(true)
      expect(result).toMatchObject({ ok: false, code: "inconsistent" })
      expect(result.error).toMatch(/candidate|review-backed/)
      expect(sdk.prompts.filter((request) => request.body.parts[0].text.includes("pure checker"))).toHaveLength(0)
      expect(loadSkillCandidates(project).candidates).toEqual([])
      expect(loadHistoricalIndex(project).coverage).toEqual([])
      expect(loadSkillLedger(project).records[0]).toMatchObject({ status: "candidate", candidate_id: "missing-live-candidate" })
      active.dispose()
    } finally { removeProject(project) }
  }, 30_000)

  test.each(["auditor", "checker"] as const)("duplicate registered %s child identity makes reviewed-live binding ambiguous", async (role) => {
    const project = tempProject(`alg-historical-live-duplicate-${role}-`)
    try {
      const values = transcript("selected", 2)
      const sdk = new HistoricalSdk(project, values)
      const active = runtime(project, sdk, true)
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const { candidate } = persistReviewedLiveCandidate(project, values, active.options)
      expect(findReviewedLiveSkillCandidate(project, "selected", "message-1")?.candidate_id).toBe(candidate.candidate_id)
      const ledgerPath = join(project, ".opencode", "skill-evolution", "ledger.json")
      const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"))
      ledger.audit_children.push(structuredClone(ledger.audit_children.find((child: any) => child.role === role)))
      writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8")
      expect(() => loadSkillLedger(project)).toThrow(/unique/)

      const result = await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation }) as any
      expect(result).toMatchObject({ ok: false, code: "inconsistent" })
      expect(sdk.creates).toHaveLength(0)
      const rawCandidates = JSON.parse(readFileSync(join(project, ".opencode", "skill-evolution", "candidates.json"), "utf8"))
      expect(rawCandidates.candidates).toHaveLength(1)
      expect(rawCandidates.candidates[0].candidate_id).toBe(candidate.candidate_id)
      expect(loadHistoricalIndex(project).coverage).toEqual([])
      active.dispose()
    } finally { removeProject(project) }
  }, 30_000)

  test("candidate-index crash recovery lets historical takeover dedupe the exact reviewed live identity", async () => {
    const project = tempProject("alg-historical-live-candidate-crash-")
    try {
      const values = transcript("selected", 2)
      const sdk = new HistoricalSdk(project, values)
      sdk.candidate = true
      const active = runtime(project, sdk, true)
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      const queued = enqueueSkillAudit(project, "selected", "message-1", active.options)
      expect(beginSkillAudit(project, queued.record.key, active.options).status).toBe("running")
      const evidence = buildSkillEvidence(values, "selected", "message-1", active.options)
      const evidenceRef = persistSkillEvidence(project, evidence)
      registerSkillAuditChild(project, { session_id: "live-auditor", parent_id: "selected", title: "alg-private-skill-evolution-audit:crash", role: "auditor" })
      registerSkillAuditChild(project, { session_id: "live-checker", parent_id: "selected", title: "alg-private-skill-evolution-check:crash", role: "checker" })

      expect(() => createSkillCandidate(
        project,
        queued.record.key,
        candidateOutput(),
        evidenceRef,
        "live-auditor",
        "live-checker",
        { passed: true, findings: [] },
        active.options,
        undefined,
        { session_id: "selected", message_id: "message-1", trigger_score: evidence.trigger_score, trigger_labels: evidence.trigger_labels },
        { afterCandidatesSave() { throw new Error("simulated crash after candidates index") } },
      )).toThrow("simulated crash after candidates index")
      expect(loadSkillCandidates(project).candidates).toEqual([expect.objectContaining({ candidate_id: expect.stringMatching(/^se-(?!h-)/) })])
      expect(loadSkillLedger(project).records[0]).toMatchObject({ status: "running" })
      expect(loadSkillLedger(project).records[0]!.candidate_id).toBeUndefined()

      const completed = await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation }) as any
      expect(completed).toMatchObject({ ok: true, code: "completed", result: { reduction: "no_change" } })
      expect(loadSkillCandidates(project).candidates).toHaveLength(1)
      expect(loadSkillCandidates(project).candidates[0]!.candidate_id).toStartWith("se-")
      expect(loadSkillCandidates(project).candidates[0]!.candidate_id).not.toStartWith("se-h-")
      expect(loadSkillLedger(project).records[0]).toMatchObject({ status: "candidate", candidate_id: loadSkillCandidates(project).candidates[0]!.candidate_id })
      expect(recoverPendingSkillAudits(project, active.options)).toEqual([])
      expect(recoverPendingSkillAudits(project, active.options)).toEqual([])
      active.dispose()
    } finally { removeProject(project) }
  }, 30_000)

  test("historical completion during each live external review stage suppresses late publication", async () => {
    for (const stage of ["auditor", "checker"] as const) {
      const project = tempProject(`alg-historical-in-flight-${stage}-`)
      let releaseLive!: () => void
      try {
        const historicalSdk = new HistoricalSdk(project, transcript("selected", 2))
        historicalSdk.candidate = true
        const historical = runtime(project, historicalSdk, true)
        const preview = await historical.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any

        const liveSdk = new HistoricalSdk(project, transcript("selected", 2))
        liveSdk.candidate = true
        liveSdk.promptGate = new Promise<void>((resolve) => { releaseLive = resolve })
        liveSdk.promptGateFor = (prompt) => stage === "auditor"
          ? prompt.includes("UNTRUSTED EVIDENCE JSON:\n")
          : prompt.includes("pure checker")
        const live = createSkillEvolutionRuntime({ client: liveSdk.client(), project: { id: "project" }, directory: project, worktree: project } as never, {
          options: SkillEvolutionOptionsSchema.parse({ enabled: true, mode: "every-turn", historical: { enabled: true } }),
        })
        live.handleEvent({ type: "message.updated", properties: { info: transcript("selected", 2)[1]!.info } } as any)
        const expectedLivePrompts = stage === "auditor" ? 1 : 2
        while (liveSdk.prompts.length < expectedLivePrompts) await Bun.sleep(5)

        failSkillAudit(project, skillLedgerKey("selected", "message-1"), "simulated stale live owner during external review")
        const completed = await historical.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation }) as any
        expect(completed).toMatchObject({ ok: true, code: "completed", result: { reduction: "candidate" } })
        releaseLive()
        await Bun.sleep(50)
        expect(liveSdk.prompts).toHaveLength(expectedLivePrompts)
        expect(loadSkillCandidates(project).candidates).toHaveLength(1)
        expect(loadSkillCandidates(project).candidates[0]!.candidate_id).toStartWith("se-h-")
        expect(loadSkillLedger(project).records[0]).toMatchObject({ status: "no-change" })
        live.dispose(); historical.dispose()
      } finally {
        releaseLive?.()
        removeProject(project)
      }
    }
  }, 30_000)

  test("supported disposition transitions continue beyond the former state-history cap", async () => {
    const project = tempProject("alg-historical-state-history-")
    try {
      const sdk = new HistoricalSdk(project, transcript("selected", 2))
      const active = runtime(project, sdk, true)
      const preview = await active.historicalInitialize({ action: "preview", session_ids: ["selected"] }) as any
      updateHistoricalIndex(project, "test-former-cap", (index) => {
        const snapshot = index.snapshots[0]!
        snapshot.state_history = Array.from({ length: 128 }, (_, position) => ({
          disposition: position === 127 ? "previewed" : position % 2 ? "resumable" : "failed",
          plan_id: preview.result.plan_id,
          at: new Date(position).toISOString(),
        }))
        snapshot.current_disposition = "previewed"
      })
      const completed = await active.historicalInitialize({ action: "run", plan_id: preview.result.plan_id, confirmation: preview.result.confirmation })
      expect(completed.code).toBe("completed")
      const history = loadHistoricalIndex(project).snapshots[0]!.state_history
      expect(history.length).toBeGreaterThan(128)
      expect(new Set(history.map((entry) => entry.disposition))).toEqual(new Set(["previewed", "queued", "running", "failed", "resumable", "completed"]))
      active.dispose()
    } finally { removeProject(project) }
  }, 30_000)
})

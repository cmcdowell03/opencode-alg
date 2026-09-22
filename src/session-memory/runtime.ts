import type { SkillTurnHint } from "../skill-catalog.ts"
import { hintFromMessages, observedConfigSkillRoots } from "../skill-catalog.ts"
import { loadSessionRecovery } from "../skill-evolution-store.ts"
import { MemoryOptionsSchema, MemoryNodeSchema, OperationSchema, RunCitationSchema, SessionId, type Checkpoint, type MemoryOptions, type Operation, type RunCitation } from "./schemas.ts"
import { MemoryStore, hashObject } from "./store.ts"
import { SkillIndex } from "./skill-index.ts"
import { buildContext, type ModelBudget } from "./context.ts"
import { verifyEnvironment, localOrigin } from "./environment.ts"
import { preflight, operationSignature } from "./preflight.ts"
import { verifyResolutionEvidence } from "./experience-adapter.ts"
import { mentionsSkill, isCompletedUserTurn, completedTurn } from "../turn-boundary.ts"
import { redactEvidenceText } from "../skill-evolution-evidence.ts"
import { truncateUtf8 } from "../limits.ts"

export class SessionMemoryRuntime {
  readonly options: MemoryOptions
  readonly store: MemoryStore
  readonly index: SkillIndex
  constructor(project: string, options: unknown = {}, roots = [".opencode/skills"], extra = observedConfigSkillRoots()) {
    this.options = MemoryOptionsSchema.parse(options)
    this.store = new MemoryStore(project, this.options.artifactQuotaBytes)
    this.index = new SkillIndex(this.store.project, roots, extra)
  }
  get enabled() { return this.options.mode !== "off" }
  current(owner: string): Checkpoint { return this.store.checkpoint(owner) ?? this.store.empty(owner) }
  private requireEnabled() { if (!this.enabled) throw new Error("session memory is disabled") }
  update(owner: string, change: (value: Checkpoint) => Checkpoint) {
    this.requireEnabled()
    const current = this.current(owner)
    return this.store.update(owner, current.revision, change)
  }
  beginTask(owner: string, goal: string, constraints: string[] = [], resultAfter = Date.now()) {
    return this.update(owner, (value) => ({ ...value, task_epoch: value.task_epoch + 1, generation: value.generation + 1,
      goal, constraints, skills: [], pins: [], used_retries: [], completed: [], next_step: "", gaps: [], source_cursor: null, result_after: resultAfter }))
  }
  /** Bookmark the first user sentence. Does not start a task or change pins. */
  noteOpening(owner: string, text: string) {
    this.requireEnabled()
    const observed_opening = text.slice(0, 2000)
    if (!observed_opening) return this.current(owner)
    return this.update(owner, (value) => value.observed_opening ? value : { ...value, observed_opening })
  }
  private addGap(owner: string, gap: string) {
    if (!gap || this.current(owner).gaps.includes(gap)) return
    this.update(owner, (value) => ({ ...value, gaps: [...value.gaps.slice(-15), gap] }))
  }
  selectEnvironment(owner: string, id: string | null) {
    const current = this.current(owner)
    verifyEnvironment(this.store, { ...current, environment: id })
    return this.update(owner, (value) => ({ ...value, environment: id, skills: [], pins: [], used_retries: [], generation: value.generation + 1 }))
  }
  bindSkill(owner: string, key: string, repin = false) {
    this.requireEnabled()
    const current = this.current(owner)
    const id = this.index.bind(this.store, owner, key)
    const node = this.store.node(id, owner)
    if (node.kind !== "skill") throw new Error("not a skill")
    const environment = verifyEnvironment(this.store, current)
    if (node.payload.environments.length && (!environment || !node.payload.environments.includes(environment.payload.name))) throw new Error("skill requires a matching reviewed environment")
    const prior = current.skills.find((binding) => binding.key === key)
    if (prior && prior.id !== id && !repin) throw new Error("skill drift requires reviewed repin")
    if (prior?.id === id) return current
    return this.update(owner, (value) => ({ ...value, generation: value.generation + 1,
      gaps: value.gaps.filter((gap) => !gap.startsWith(`skill-source:${node.payload.name}:`)),
      skills: [...value.skills.filter((binding) => binding.key !== key), { id, key, name: node.payload.name, environment: value.environment }] }))
  }
  unbindSkill(owner: string, key: string) {
    return this.update(owner, (value) => ({ ...value, skills: value.skills.filter((binding) => binding.key !== key), generation: value.generation + 1 }))
  }
  /** Import legacy references explicitly; no old body or task applicability is invented. */
  importLegacy(owner: string) {
    this.requireEnabled()
    const legacy = loadSessionRecovery(this.store.project, owner)
    if (!legacy) return this.current(owner)
    for (const ref of legacy.skills) {
      const matches = this.index.search(ref.name, 0, 64).skills.filter((entry) => entry.name === ref.name && entry.root === ref.root && entry.sha256 === ref.sha256)
      if (matches.length !== 1) throw new Error("legacy skill identity cannot be verified")
      this.bindSkill(owner, matches[0]!.key)
    }
    return this.current(owner)
  }
  observe(messages: Array<{ info?: any; parts?: any[] }>) {
    if (!this.enabled || !messages.length) return
    const owner = messages.at(-1)?.info?.sessionID
    if (typeof owner !== "string" || messages.some((message) => message.info?.sessionID !== owner)) throw new Error("mixed/invalid memory session")
    SessionId.parse(owner)
    const latestUser = [...messages].reverse().find((message) => message.info?.role === "user")
    if (latestUser?.parts?.some((part) => part.type === "text" && part.synthetic === true)) return
    const hint = hintFromMessages(messages)
    let current = this.current(owner)
    if (current.deleted) return
    // Only initialize a goal once. New task epochs are explicit, never guessed from a summary.
    if (!current.revision && hint.userText) current = this.noteOpening(owner, hint.userText)
    if (!current.revision) return
    if (current.result_after !== undefined && Number.isSafeInteger(latestUser?.info?.time?.created) && latestUser!.info.time.created < current.result_after) return
    if (current.delegation?.role === "checker") return
    this.captureResult(owner, messages)
    // Preserve actual successful skill loads from this user turn, not every old
    // skill mention in the surviving conversation or user-supplied tool-shaped data.
    let lastUserIndex = -1
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index]?.info?.role === "user") { lastUserIndex = index; break }
    }
    const loaded = hintFromMessages(messages.slice(lastUserIndex + 1).filter((message) => message.info?.role === "assistant")).loadedSkills
    const unambiguous = (name: string) => {
      const exact = this.index.named(name)
      if (!this.index.complete || exact.length !== 1) {
        const gap = `skill-source:${name}: unavailable, ambiguous or incomplete discovery; bind an exact source key after review`
        if (!this.current(owner).gaps.includes(gap)) this.update(owner, (value) => ({ ...value, gaps: [...value.gaps.slice(-15), gap] }))
        return null
      }
      return exact[0]!
    }
    for (const name of loaded) {
      if (this.current(owner).skills.some((binding) => binding.name === name)) continue
      const exact = unambiguous(name)
      if (exact) this.bindSkill(owner, exact.key)
    }
    if (!hint.userText || /^(?:continue|resume|go on)[.!\s]*$/i.test(hint.userText)) return
    // Similarity is discovery only. Only exact names or successful loads activate procedures.
    const cleanHint: SkillTurnHint = { ...hint, assistantText: "", tools: [], loadedSkills: [] }
    const matches = this.index.search(hint.userText, 0, 64, cleanHint)
    for (const entry of matches.skills) {
      if (!mentionsSkill(hint.userText, entry.name)) continue
      if (this.current(owner).skills.some((binding) => binding.name === entry.name)) continue
      const exact = unambiguous(entry.name)
      if (exact) this.bindSkill(owner, exact.key)
    }
  }
  /** Preserve prior answers as claims, never promote prose or generic tool output to verified outcomes. */
  private captureResult(owner: string, messages: Array<{ info?: any; parts?: any[] }>) {
    const latestUser = [...messages].reverse().find((message) => message.info?.role === "user")
    const terminal = [...messages].reverse().find((message) => isCompletedUserTurn(message.info) && message.info.parentID === latestUser?.info?.id)
    if (!terminal || !latestUser?.info?.id || latestUser.parts?.some((part) => part.synthetic === true)) return
    const current = this.current(owner)
    if (current.source_cursor === terminal.info.id) return
    const turn = completedTurn(messages, owner, terminal.info.id)
    const text = (terminal.parts ?? []).filter((part) => part.type === "text" && part.ignored !== true && !part.synthetic && typeof part.text === "string")
      .map((part) => part.text).join("\n")
    if (!text.trim()) return
    if (Buffer.byteLength(text) > 65536) {
      this.update(owner, (value) => ({ ...value, gaps: [...value.gaps.slice(-15), "result capture exceeds 64 KiB; no result was retained"] }))
      return
    }
    // artifact() rejects secret-bearing text before hashing or persistence.
    const artifact = this.store.artifact(text)
    const excerpt = truncateUtf8(text, 2000)
    const tools = turn.parts.filter((part) => part.type === "tool")
    const toolEvidence = tools.length ? this.store.artifact(JSON.stringify(tools.slice(-12).map((part) => ({
      tool: String(part.tool).slice(0, 128), status: part.state?.status,
      input: redactEvidenceText(part.state?.input, 1000),
      output: redactEvidenceText(part.state?.status === "error" ? part.state?.error : part.state?.output, 1000),
    })))) : null
    const id = this.store.putNode({ schema_version: 1, project: this.store.projectId, owner, visibility: "session",
      created_at: new Date(terminal.info.time.completed).toISOString(), kind: "result", summary: "Prior completed answer; correctness unverified",
      relations: [], payload: { validation: "unverified-assistant-claim", task_epoch: current.task_epoch,
        user_message_id: latestUser.info.id, assistant_message_id: terminal.info.id, environment: current.environment,
        session_id: owner, finish: String(terminal.info.finish),
        artifact, excerpt, bytes_omitted: Buffer.byteLength(text) - Buffer.byteLength(excerpt), tool_evidence: toolEvidence, completed: "assistant-turn-only" } })
    const results = current.pins.filter((pin) => this.store.node(pin, owner).kind === "result")
    const keep = new Set(results.slice(-7))
    this.update(owner, (value) => ({ ...value, source_cursor: terminal.info.id,
      pins: [...value.pins.filter((pin) => !results.includes(pin) || keep.has(pin)), id].filter((pin, i, all) => all.indexOf(pin) === i) }))
  }
  prepare(owner: string, model: ModelBudget = {}) {
    this.requireEnabled()
    const checkpoint = this.current(owner)
    if (!checkpoint.revision || checkpoint.deleted) return { text: "", blocked: false, receipt: null }
    const result = buildContext(this.store, this.index, checkpoint, this.options, model)
    this.store.receipt(result.receipt)
    return result
  }
  compact(owner: string) {
    if (!this.enabled || !this.current(owner).revision || this.current(owner).deleted) return ""
    const value = this.update(owner, (current) => ({ ...current, generation: current.generation + 1 }))
    return `ALG durable task checkpoint ${hashObject(value)}; active skills=${value.skills.map((skill) => skill.name).join(", ") || "none"}. Reload from alg_context_status after compact; summaries do not replace complete procedures.`
  }
  delete(owner: string) {
    if (!this.enabled || this.current(owner).deleted) return
    this.update(owner, (value) => ({ ...value, deleted: true, skills: [], pins: [], environment: null, goal: "", constraints: [], completed: [], next_step: "" }))
  }
  status(owner: string) {
    if (!this.enabled) return { mode: "off", initialized: false }
    const checkpoint = this.store.checkpoint(owner)
    return { mode: this.options.mode, initialized: checkpoint !== null, checkpoint, receipt: this.store.contextReceipt(owner), origin: localOrigin(),
      coverage: { host_prompt_delivery: "NOT_ATTESTED", universal_tool_interception: false, supported_adapters: ["alg_run", "alg_resume"],
        adapter_activation: "one active skill declaring alg_execute plus reviewed environment", remote_permissions: "REVALIDATE_AT_ACTION", message_replay: "BEST_EFFORT" } }
  }
  propose(owner: string, content: string) {
    this.requireEnabled()
    if (this.current(owner).deleted) throw new Error("session deleted")
    return this.store.putNode(MemoryNodeSchema.parse({ schema_version: 1, project: this.store.projectId, owner, visibility: "session", created_at: new Date().toISOString(),
      kind: "proposal", summary: "Unverified model-authored proposal", relations: [], payload: { content } }))
  }
  pin(owner: string, id: string) {
    this.store.node(id, owner)
    return this.update(owner, (value) => ({ ...value, pins: [...new Set([...value.pins, id])] }))
  }
  /** Only structured, integrated adapters call this; generic model text is not an outcome. */
  recordAttempt(owner: string, raw: Operation, outcome: "success" | "failure" | "indeterminate", receipt: string, expires: string, citation?: RunCitation) {
    this.requireEnabled()
    const operation = OperationSchema.parse(raw)
    const run_citation = citation ? RunCitationSchema.parse(citation) : undefined
    const state = this.current(owner)
    preflight(this.store, state, { ...operation, purpose: "verify" })
    const id = this.store.putNode({ schema_version: 1, project: this.store.projectId, owner, visibility: "session", created_at: new Date().toISOString(),
      kind: "attempt", summary: `${operation.operation}: ${outcome}`, relations: [], payload: { operation, signature: operationSignature(operation), outcome, receipt, expires_at: expires, ...(run_citation ? { run_citation } : {}) } })
    this.pin(owner, id)
    return id
  }
  resolve(owner: string, operation: Operation, verification: string, nextStep: string, expires: string) {
    this.requireEnabled()
    preflight(this.store, this.current(owner), { ...operation, purpose: "verify" })
    const evidence = verifyResolutionEvidence(this.store, owner, verification)
    const attempts = this.current(owner).pins.map((id) => this.store.node(id, owner))
    const attempt = attempts.find((node) => node.kind === "attempt" && node.payload.signature === operationSignature(operation) && node.payload.receipt === evidence.source.sha256)
    if (!attempt || Date.parse(evidence.observed_at) < Date.parse(attempt.created_at) || Date.parse(evidence.observed_at) > Date.now() || Date.parse(expires) <= Date.now()) throw new Error("verification does not identify a fresh receipt for this attempt")
    const id = this.store.putNode({ schema_version: 1, project: this.store.projectId, owner, visibility: "session", created_at: evidence.observed_at,
      kind: "resolution", summary: "Evidence-backed verified procedure", relations: [{ kind: "supports", id: verification }, { kind: "resolved-by", id: operation.skill }],
      payload: { signature: operationSignature(operation), environment: operation.environment, skill: operation.skill, verification, next_step: nextStep, expires_at: expires } })
    this.pin(owner, id)
    this.update(owner, (value) => ({ ...value, completed: [...new Set([...value.completed, id])].slice(-64), next_step: nextStep }))
    return id
  }
  allowRetry(owner: string, operation: Operation, reason: string, expires: string) {
    this.requireEnabled()
    preflight(this.store, this.current(owner), { ...operation, purpose: "verify" })
    if (Date.parse(expires) <= Date.now() || Date.parse(expires) > Date.now() + 3600000) throw new Error("retry expiry must be within one hour")
    const id = this.store.putNode({ schema_version: 1, project: this.store.projectId, owner, visibility: "session", created_at: new Date().toISOString(),
      kind: "retry", summary: "Operator-reviewed exact retry", relations: [], payload: { signature: operationSignature(operation), reason, expires_at: expires } })
    this.pin(owner, id)
    return id
  }
  async guarded<T>(owner: string, operation: Operation, execute: () => Promise<T>, classify: (result: T) => { outcome: "success" | "failure" | "indeterminate"; receipt: string; run_citation?: RunCitation }, prospectiveShellGateHash?: string): Promise<T> {
    this.requireEnabled()
    if (this.options.mode === "observe") {
      try { this.prepare(owner); preflight(this.store, this.current(owner), operation, prospectiveShellGateHash) } catch { /* advisory only */ }
      const result = await execute()
      try {
        const observed = classify(result)
        this.recordAttempt(owner, operation, observed.outcome, observed.receipt, new Date(Date.now() + 900000).toISOString(), observed.run_citation)
      } catch { /* observation cannot rewrite an action result */ }
      return result
    }
    try { this.prepare(owner) } catch { /* a failed view must not veto the run */ }
    const decision = preflight(this.store, this.current(owner), operation, prospectiveShellGateHash)
    if (decision.gap) try { this.addGap(owner, decision.gap) } catch { /* gap reporting must not veto the run */ }
    if (this.options.mode === "assist" && !decision.allowed) throw new Error(decision.reason)
    if (this.options.mode === "assist" && decision.retry) this.update(owner, (state) => ({ ...state, used_retries: [...state.used_retries, decision.retry!] }))
    // Authorization belongs to execute's adapter, never to the memory decision.
    let result: T
    try { result = await execute() }
    catch (error) {
      // No exception text, command, secret value or its hash enters memory.
      this.recordAttempt(owner, operation, "indeterminate", hashObject({ signature: operationSignature(operation), state: "adapter-threw" }), new Date(Date.now() + 900000).toISOString())
      throw error
    }
    const outcome = classify(result)
    this.recordAttempt(owner, operation, outcome.outcome, outcome.receipt, new Date(Date.now() + 900000).toISOString(), outcome.run_citation)
    return result
  }
  delegate(parent: string, child: string, role: "worker" | "checker") {
    this.requireEnabled()
    if (this.current(child).revision) throw new Error("delegation target already initialized")
    const source = this.current(parent)
    if (!source.revision || source.deleted) return
    const bindings: Checkpoint["skills"] = []
    // Worker may inherit active procedures; checker gets only explicit constraints, no worker/private evidence.
    if (role === "worker") for (const binding of source.skills) {
      const id = this.index.bind(this.store, child, binding.key)
      if (this.store.node(binding.id, parent).kind !== "skill") throw new Error("invalid delegated skill")
      const original = this.store.node(binding.id, parent), copy = this.store.node(id, child)
      if (JSON.stringify(original.payload) !== JSON.stringify(copy.payload)) throw new Error("delegated skill drift")
      bindings.push({ ...binding, id })
    }
    this.update(child, (value) => ({ ...value, goal: source.goal, constraints: source.constraints, environment: source.environment,
      skills: bindings, task_epoch: 1, generation: 1, delegation: { parent_owner: parent, parent_checkpoint: hashObject(source), role } }))
  }
}

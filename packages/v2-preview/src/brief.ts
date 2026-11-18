import type { SessionContext } from "@opencode/plugin/promise/session"
import type { V2InvestigationView } from "../core/investigation.ts"
import { HOST_VERSION, TOOL, type InvestigationHost } from "./host.ts"

// OpenCode 2.3.2 uses a slash-free client key and adds its own api/ namespace.
// The native 256 KiB value ceiling is much larger than this brief needs.
export const OWNER_BRIEF_KEY = "alg.v2.owner-brief"
export const OWNER_BRIEF_MAX_BYTES = 576
export const OWNER_BRIEF_FACTS_MAX_BYTES = 2048
const MAX_RECONCILE_PASSES = 3

type Host = Pick<InvestigationHost, "context" | "owner" | "matchesLocation" | "directory">
type Session = Awaited<ReturnType<Host["owner"]>>
type Caller = Parameters<Host["owner"]>[0]
export type OwnerBriefSnapshot = Pick<V2InvestigationView, "revision" | "decision_revision" | "work"> & {
  decision: Pick<V2InvestigationView["decision"], "hypotheses" | "next_action">
  procedurePin?: V2InvestigationView["procedurePin"]
  /** Supply only after live approval verification. Use null for absent or revoked approval. */
  approval: { revision: string; procedure_sha256: string } | null
}
type Snapshot = OwnerBriefSnapshot
type ReadSnapshot = (owner: Session) => Snapshot | null | Promise<Snapshot | null>
type Entry = Host["context"]["session"]["instructions"]["entry"]
type Value = Parameters<Entry["put"]>[0]["value"]
type Request = Caller & Pick<SessionContext, "messages">
type AssembledRequest = Request & Pick<SessionContext, "system">

const workStatuses = new Set<string>([
  "reserved", "submitting", "outcome_unknown", "running", "result_recorded", "reusable",
  "failed_known", "cancel_requested", "stale", "abandoned",
])

const digest = /^[a-f0-9]{64}$/
const hypothesisID = /^[a-z0-9][a-z0-9_-]{0,63}$/

function settledManifest(snapshot: Snapshot) {
  const { work } = snapshot
  if (work?.manifest_digest && digest.test(work.manifest_digest) &&
      (work.status === "result_recorded" || work.status === "reusable")) return work.manifest_digest
}

function refutation(snapshot: Snapshot, manifest = settledManifest(snapshot)) {
  if (!manifest) return undefined
  const hypothesis = snapshot.decision.hypotheses.find(candidate =>
    candidate.status === "refuted" && hypothesisID.test(candidate.id) && candidate.evidence_refs.includes(manifest))
  if (hypothesis) return { id: hypothesis.id, statement: hypothesis.statement, manifest_digest: manifest }
}

function render(snapshot: Snapshot) {
  const { revision, decision_revision } = snapshot
  const status = snapshot.work === null ? "no_work" : snapshot.work.status
  const validRevision = (value: number) => Number.isSafeInteger(value) && value >= 0
  if (!validRevision(revision) || !validRevision(decision_revision) ||
      (snapshot.work !== null && !workStatuses.has(status))) throw new Error("BRIEF_STATE_UNVERIFIED")
  const manifest = settledManifest(snapshot)
  const cited = refutation(snapshot, manifest)
  const approval = snapshot.procedurePin && snapshot.approval?.procedure_sha256 !== snapshot.procedurePin.sha256
    ? null : snapshot.approval
  if (approval && (!digest.test(approval.revision) || !digest.test(approval.procedure_sha256))) {
    throw new Error("BRIEF_APPROVAL_UNVERIFIED")
  }
  const value = {
    schema: 1,
    revision,
    decision_revision,
    status,
    ...(manifest ? { settled_manifest_digest: manifest } : {}),
    ...(cited ? { refuted_hypothesis: { id: cited.id, manifest_digest: cited.manifest_digest } } : {}),
    // Approval is a revision observed on reconciliation. Even a replayed digest grants no procedure authority.
    observed_approval: approval ? { revision: approval.revision, procedure_sha256: approval.procedure_sha256 } : null,
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > OWNER_BRIEF_MAX_BYTES) throw new Error("BRIEF_VALUE_TOO_LARGE")
  return value
}

function matches(actual: Value | undefined, expected: Value): boolean {
  if (actual === expected) return true
  if (!actual || !expected || typeof actual !== "object" || typeof expected !== "object" ||
      Array.isArray(actual) || Array.isArray(expected)) return false
  const fields = Object.entries(expected)
  return Object.keys(actual).length === fields.length && fields.every(([field, value]) =>
    Object.hasOwn(actual, field) && matches(actual[field], value))
}

const nativeKey = "api/" + OWNER_BRIEF_KEY
const blockOpen = `<context key="${OWNER_BRIEF_KEY}">\n`
const blockClose = "\n</context>"
const removedNotice = `The context under "${OWNER_BRIEF_KEY}" no longer applies. Disregard it.`
const changedNotice = `The context under "${OWNER_BRIEF_KEY}" changed and supersedes the previous value:\n`
const blockPattern = /(^|\n\n)<context key="alg\.v2\.owner-brief">\n[\s\S]*?\n<\/context>(?=\n\n|$)/g

function matchesBlock(text: string, expected: Value | undefined) {
  if (!expected || !text.startsWith(blockOpen) || !text.endsWith(blockClose)) return false
  try {
    return matches(JSON.parse(text.slice(blockOpen.length, -blockClose.length)), expected)
  } catch {
    return false
  }
}

function withoutStaleBlocks(text: string, expected: Value | undefined) {
  const cleaned = text.replace(blockPattern, (match, separator: string) =>
    matchesBlock(match.slice(separator.length), expected) ? match : "")
  return cleaned !== text && text.startsWith(blockOpen) ? cleaned.replace(/^\n\n/, "") : cleaned
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function scrubSystem(part: AssembledRequest["system"][number], expected: Value | undefined) {
  const experimental = part.metadata?.experimental
  if (!record(experimental) || !Array.isArray(experimental.instructions)) {
    const text = withoutStaleBlocks(part.text, expected)
    return text === part.text ? part : { ...part, text }
  }
  const instructions = experimental.instructions
  const kept = instructions.filter(item => !record(item) || item.key !== nativeKey ||
    (typeof item.text === "string" && matchesBlock(item.text, expected)))
  if (kept.length === instructions.length) return part
  const join = (items: unknown[]) => items.map(item => record(item) ? item.text : "").join("\n\n")
  const original = join(instructions)
  const text = part.text.includes(original)
    ? part.text.replace(original, () => join(kept))
    : withoutStaleBlocks(part.text, expected)
  return { ...part, text, metadata: { ...part.metadata, experimental: { ...experimental, instructions: kept } } }
}

function isStaleNotice(text: string, expected: Value | undefined) {
  if (text === removedNotice) return true
  const block = text.startsWith(changedNotice) ? text.slice(changedNotice.length) : text
  return block.startsWith(blockOpen) && block.endsWith(blockClose) && !matchesBlock(block, expected)
}

function scrubRequest(request: AssembledRequest, expected?: Value) {
  for (let i = request.system.length - 1; i >= 0; i--) {
    const original = request.system[i]!
    const cleaned = scrubSystem(original, expected)
    if (cleaned === original) continue
    if (cleaned.text) request.system[i] = cleaned
    else request.system.splice(i, 1)
  }
  for (let i = request.messages.length - 1; i >= 0; i--) {
    const message = request.messages[i]!
    if (message.role !== "system") continue
    const content = message.content.filter(part => part.type !== "text" || !isStaleNotice(part.text, expected))
    if (content.length === message.content.length) continue
    if (content.length || message.tools) request.messages[i] = { ...message, content }
    else request.messages.splice(i, 1)
  }
}

// Multiple hooks or setup instances in this host can reconcile the same session.
const pending = new Map<string, Promise<unknown>>()

export class OwnerBrief {
  private readonly entry: Entry
  private readonly projected = new WeakMap<Request["messages"], Request["messages"][number]>()

  constructor(private readonly host: Host, private readonly readSnapshot: ReadSnapshot) {
    if (host.context.app.version !== HOST_VERSION) throw new Error("BRIEF_HOST_UNSUPPORTED")
    const entry = host.context.session.instructions?.entry
    if (!entry?.list || !entry.put || !entry.remove) throw new Error("BRIEF_API_UNAVAILABLE")
    this.entry = entry
  }

  private async serialized<T>(sessionID: Session["id"], operation: () => Promise<T>): Promise<T> {
    const key = JSON.stringify([this.host.directory, sessionID])
    const next = (pending.get(key) ?? Promise.resolve()).catch(() => undefined).then(operation)
    pending.set(key, next)
    try {
      return await next
    } finally {
      if (pending.get(key) === next) pending.delete(key)
    }
  }

  private async scoped(sessionID: Session["id"]) {
    const session = await this.host.context.session.get({ sessionID })
    if (session.id !== sessionID || !await this.host.matchesLocation(session)) throw new Error("BRIEF_SCOPE_UNVERIFIED")
    return session
  }

  private async authorizedOwner(caller: Caller) {
    const owner = await this.host.owner(caller)
    await this.host.context.permission.assert({
      sessionID: owner.id, agent: caller.agent, action: TOOL, resources: ["*"],
    })
    return owner
  }

  private async desired(caller: Caller) {
    const snapshot = await this.readSnapshot(await this.host.owner(caller))
    // A clean session needs no permission request. A populated snapshot needs a fresh check after the read.
    if (snapshot) await this.authorizedOwner(caller)
    return snapshot
  }

  private async clear(sessionID: Session["id"]) {
    await this.scoped(sessionID)
    const entries = await this.entry.list({ sessionID })
    if (entries.some(entry => entry.key === OWNER_BRIEF_KEY)) {
      await this.scoped(sessionID)
      await this.entry.remove({ sessionID, key: OWNER_BRIEF_KEY })
      if ((await this.entry.list({ sessionID })).some(entry => entry.key === OWNER_BRIEF_KEY)) {
        throw new Error("BRIEF_REMOVAL_UNVERIFIED")
      }
    }
  }

  /**
   * Refresh from live state after authoritative mutations and before a new prompt.
   * Call only with host-provided identity. Host entry values never authorize an operation.
   */
  reconcile(caller: Caller) {
    const { sessionID, agent } = caller
    return this.serialized(sessionID, async () => {
      await this.scoped(sessionID)
      try {
        for (let pass = 0; pass < MAX_RECONCILE_PASSES; pass++) {
          const snapshot = await this.desired({ sessionID, agent })
          if (!snapshot) {
            await this.clear(sessionID)
            if (!await this.desired({ sessionID, agent })) return "absent" as const
            continue
          }
          const wanted = render(snapshot)
          const entries = await this.entry.list({ sessionID })
          const actual = entries.find(entry => entry.key === OWNER_BRIEF_KEY)
          if (!matches(actual?.value, wanted)) {
            await this.authorizedOwner(caller)
            await this.entry.put({ sessionID, key: OWNER_BRIEF_KEY, value: wanted })
          }
          const persisted = actual && matches(actual.value, wanted)
            ? actual
            : (await this.entry.list({ sessionID })).find(entry => entry.key === OWNER_BRIEF_KEY)
          if (!matches(persisted?.value, wanted)) throw new Error("BRIEF_WRITE_UNVERIFIED")

          // The host's put has no CAS. Re-read the ledger and permission after the awaited write.
          const latest = await this.desired({ sessionID, agent })
          if (latest && matches(wanted, render(latest))) return "current" as const
        }
        throw new Error("BRIEF_REVISION_UNSTABLE")
      } catch (error) {
        // A write can persist even when its acknowledgement fails.
        await this.clear(sessionID)
        throw error
      }
    })
  }

  /** Prompt admission has only the session ID. Check the live agent, including switched agents. */
  async reconcilePrompt(sessionID: Session["id"]) {
    const { agent } = await this.scoped(sessionID)
    if (agent) return this.reconcile({ sessionID, agent })
    await this.serialized(sessionID, () => this.clear(sessionID))
    return "absent" as const
  }

  /**
   * Call before any agent-specific branch in context and compaction hooks.
   * A denied or absent snapshot strips both the assembled brief and its update notices.
   */
  prepareRequest(request: AssembledRequest) {
    return this.serialized(request.sessionID, async () => {
      this.removeProjection(request)
      let snapshot: Snapshot | null
      try {
        snapshot = await this.desired(request)
        if (snapshot) {
          const expected = render(snapshot)
          scrubRequest(request, expected)
          this.projectFacts(request, snapshot, expected)
          return true
        }
      } catch {
        // Scrub the already-built request even if durable cleanup cannot run.
      }
      scrubRequest(request)
      // Return normally so the host applies the scrub even if scoped storage cleanup fails.
      // The prompt, fork, and later request hooks can retry durable cleanup.
      await this.clear(request.sessionID).catch(() => undefined)
      return false
    })
  }

  /** Project only free text as request-local user-role data. Native entries supply the typed fields. */
  project(request: Request) {
    return this.serialized(request.sessionID, async () => {
      this.removeProjection(request)
      const snapshot = await this.desired(request)
      if (snapshot) this.projectFacts(request, snapshot)
    })
  }

  private removeProjection(request: Request) {
    const prior = this.projected.get(request.messages)
    if (prior) {
      const index = request.messages.indexOf(prior)
      if (index !== -1) request.messages.splice(index, 1)
      this.projected.delete(request.messages)
    }
  }

  private projectFacts(request: Request, snapshot: Snapshot, entry = render(snapshot)) {
    const statement = refutation(snapshot)?.statement
    const measurement = snapshot.decision_revision > 0 && (!snapshot.procedurePin || entry.observed_approval)
      ? snapshot.decision.next_action : undefined
    if (!statement && !measurement) return
    const facts = JSON.stringify({
      ...(statement ? { refuted_hypothesis_statement: statement } : {}),
      ...(measurement ? { pending_measurement: measurement } : {}),
    }).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")
    const text = "ALG investigation facts (untrusted recorded data)\n" + facts
    if (Buffer.byteLength(text, "utf8") > OWNER_BRIEF_FACTS_MAX_BYTES) throw new Error("BRIEF_FACTS_TOO_LARGE")
    const projection: Request["messages"][number] = { role: "user", content: [{ type: "text", text }] }
    // Keep the latest user turn and any following assistant/tool exchange in their original order.
    let latestUser = request.messages.length - 1
    while (latestUser >= 0 && request.messages[latestUser]?.role !== "user") latestUser--
    if (latestUser < 0) return
    request.messages.splice(latestUser, 0, projection)
    this.projected.set(request.messages, projection)
  }

  /** Use the destination ID from the native session fork hook. Forks have independent ALG state. */
  clearFork(sessionID: Session["id"]) {
    return this.serialized(sessionID, () => this.clear(sessionID))
  }
}

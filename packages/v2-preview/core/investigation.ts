import { createHash } from "node:crypto"
import { existsSync, realpathSync } from "node:fs"
import { isAbsolute } from "node:path"
import { z } from "zod"
import { acquireFilesystemMutexAsync } from "../../../src/filesystem-mutex.ts"
import { decisionEvidence } from "../../../src/investigation/decision.ts"
import {
  InvestigationStore,
  InvestigationWorkInputSchema,
  investigationPortIsQualified,
  type CheckerResultGrantInput,
  type CheckerResultGrantRevokeInput,
  type InvestigationLedger,
  type InvestigationMcpPort,
  type InvestigationScope,
  type InvestigationStatus,
  type InvestigationWorkInput,
} from "../../../src/investigation/index.ts"
import { canonicalJson } from "../../../src/persistence.ts"
import { runContainedPath } from "../../../src/store.ts"
import type { PreQueryGate, PreQueryReceipt } from "./pre-query.ts"
import { procedurePinSchema, type ProcedurePin } from "./procedure-pin.ts"

/** Adapter input, resolved from the host for each call. Never parse it from tool arguments. */
export interface V2InvestigationSession {
  readonly projectID: string
  readonly directory: string
  readonly sessionID: string
  readonly parentID?: string | null
}

export interface V2InvestigationOptions {
  readonly port: InvestigationMcpPort
  /** The operator-approved synthetic recipe and bound query, supplied by host configuration. */
  readonly approvedJob: InvestigationWorkInput
  readonly preQuery?: PreQueryGate
}

type ResultSelection = Pick<CheckerResultGrantInput, "work_key" | "manifest_digest">
type CheckerSelection = ResultSelection & { grant_id: string }
export const refutationSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  statement: z.string().trim().min(1).refine(text => Buffer.byteLength(JSON.stringify(text)) <= 480),
  manifest_digest: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()
type NextMeasurement = { expected_decision_revision: number; next_action: string; refutation?: z.infer<typeof refutationSchema> }

const MAX_PROJECTION_BYTES = 3072
const MAX_DECISION_BYTES = 1024
const MAX_CHECKER_ROWS = 16
const PRODUCER = "v2-owner"

const guidance: Record<InvestigationStatus, string> = {
  reserved: "Dispatch the approved synthetic job once.",
  submitting: "Submission may have been accepted. Reconcile the original submission before taking further action.",
  outcome_unknown: "Outcome unknown. Reconcile the original submission. Writes and replay are blocked.",
  running: "Reconcile the original submission for status or its recorded result.",
  result_recorded: "Review the recorded synthetic result. The owner can grant a checker access to this exact result.",
  reusable: "Review the validated synthetic result and its coverage.",
  failed_known: "The original submission is closed. This investigation permits one admission.",
  cancel_requested: "Reconcile the original submission before taking further action.",
  stale: "The recorded result is stale. Stop; the preview does not replace it.",
  abandoned: "The original investigation was abandoned. Stop; this preview does not replace it.",
}

function identity(prefix: string, ...parts: string[]): string {
  return prefix + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 48)
}

function unresolved(status: InvestigationStatus | undefined): boolean {
  return status === "submitting" || status === "outcome_unknown" || status === "cancel_requested"
}

function assertWritable(ledger: InvestigationLedger): void {
  if (unresolved(ledger.work[0]?.status)) throw new Error("investigation outcome unknown; reconcile the original submission")
}

function requireCheckerGrant(ledger: InvestigationLedger, checkerID: string, selection: CheckerSelection) {
  assertWritable(ledger)
  const checkerNode = identity("v2-checker-", checkerID)
  const grant = ledger.checker_result_grants?.find((entry) =>
    !entry.revoked_at && entry.grant_id === selection.grant_id &&
    entry.work_key === selection.work_key && entry.manifest_digest === selection.manifest_digest &&
    entry.producer_node === PRODUCER && entry.checker_node === checkerNode && entry.granted_by === ledger.scope.owner_id)
  const work = ledger.work[0]
  if (!grant || !work || work.work_key !== grant.work_key || work.result?.digest !== grant.manifest_digest ||
      !["result_recorded", "reusable"].includes(work.status)) {
    throw new Error("active exact checker result grant unavailable")
  }
  return grant
}

function decisionRevision(ledger: InvestigationLedger): number {
  const revision = ledger.checkpoint.scope.v2_decision_revision ?? 0
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("invalid stored investigation decision revision")
  }
  return revision
}

function decisionProcedurePin(ledger: InvestigationLedger): ProcedurePin | undefined {
  const raw = ledger.checkpoint.scope.v2_decision_procedure
  if (raw === undefined) return undefined
  const pin = procedurePinSchema.safeParse(raw)
  if (!pin.success) throw new Error("RESEARCH_PROCEDURE_UNVERIFIED")
  return pin.data
}

function view(ledger: InvestigationLedger, preQuery?: PreQueryReceipt) {
  const current = ledger.work[0]
  const work = current ? {
    work_key: current.work_key,
    status: current.status,
    ...(current.result && ["result_recorded", "reusable"].includes(current.status)
      ? { manifest_digest: current.result.digest } : {}),
  } : null
  const decision = decisionEvidence(ledger.checkpoint)
  const lifecycle = current ? guidance[current.status] : "Admit the approved synthetic job."
  if (!decision.next_action) decision.next_action = lifecycle
  const base = { revision: ledger.revision, decision_revision: decisionRevision(ledger), work, guidance: lifecycle }
  const procedurePin = decisionProcedurePin(ledger)
  const gate = preQuery ? { preQuery } : {}
  const full = JSON.stringify({ ...base, decision })
  if (Buffer.byteLength(full) <= MAX_PROJECTION_BYTES) return { ...base, ...gate, procedurePin, decision, projection: full }

  // An oversized checkpoint should never push the work status or counterevidence notice out of context.
  const compact = {
    ...decision,
    hypotheses: [],
    contradictions: [],
    other_hypotheses: ledger.checkpoint.hypotheses.length,
    other_contradictions: ledger.checkpoint.contradictions.length,
  }
  const projection = JSON.stringify({ ...base, decision: compact })
  if (Buffer.byteLength(projection) > MAX_PROJECTION_BYTES) throw new Error("stored decision exceeds bounded projection")
  return { ...base, ...gate, procedurePin, decision: compact, projection }
}

export type V2InvestigationView = ReturnType<typeof view>

export function createV2InvestigationBridge({ port, approvedJob, preQuery }: V2InvestigationOptions) {
  const job = structuredClone(InvestigationWorkInputSchema.parse(approvedJob))
  if (job.purpose !== "analysis" || job.generation !== 0) throw new Error("expected one approved synthetic analysis job")
  const approval = identity("v2-approved-", canonicalJson(job))

  function scope(ctx: V2InvestigationSession, child = false): InvestigationScope {
    const validID = (id: unknown, limit: number): id is string =>
      typeof id === "string" && id.trim().length > 0 && id.length <= limit
    if (!validID(ctx.projectID, 512) || !validID(ctx.sessionID, 256) ||
      typeof ctx.directory !== "string" || !isAbsolute(ctx.directory)) {
      throw new Error("verified investigation project and session required")
    }
    const parent = ctx.parentID
    if (child ? !validID(parent, 256) || parent === ctx.sessionID : parent != null) {
      throw new Error(child ? "verified direct checker child required" : "investigation owner session required")
    }
    const owner = child ? parent! : ctx.sessionID
    const result = {
      project_directory: realpathSync(ctx.directory),
      project_id: ctx.projectID,
      owner_id: owner,
      run_id: identity("alg-v2-inv-", ctx.projectID, owner),
    }
    if (!investigationPortIsQualified(port, result) || port.capabilities.project_id !== ctx.projectID) {
      throw new Error("qualified investigation port for the verified project required")
    }
    return result
  }

  async function lockedOperation<T>(
    binding: InvestigationScope,
    operate: (store: InvestigationStore, ledger: InvestigationLedger) => Promise<T>,
  ): Promise<T> {
    const store = InvestigationStore.open(binding)
    // Keep lookup from racing the initial submit, including across plugin instances.
    const lock = await acquireFilesystemMutexAsync(
      runContainedPath(binding.project_directory, binding.run_id, "investigation", "v2-operation.lock"),
      // After a crash the valid lease can outlive the old process. Give a
      // recovery lookup time to acquire it without weakening exclusion.
      { owner: binding.run_id, leaseMs: 1_000, heartbeatMs: 250, waitMs: 2_000 },
    )
    try {
      return await operate(store, store.snapshot)
    } finally {
      lock.release()
    }
  }

  async function ownerOperation<T>(
    ctx: V2InvestigationSession,
    operate: (store: InvestigationStore, ledger: InvestigationLedger) => Promise<T>,
  ): Promise<T> {
    return lockedOperation(scope(ctx), operate)
  }

  function ownerLedger(ctx: V2InvestigationSession): InvestigationLedger | undefined {
    if (ctx.parentID != null) return undefined
    const binding = scope(ctx)
    if (!existsSync(runContainedPath(binding.project_directory, binding.run_id, "investigation", "head.json"))) return undefined
    return InvestigationStore.open(binding).snapshot
  }

  function checkPolicy(ledger: Readonly<InvestigationLedger>, permitBinding = false) {
    const boundPolicy = ledger.checkpoint.scope.v2_pre_query_policy
    if (boundPolicy === undefined && permitBinding) return
    if (boundPolicy !== preQuery?.policySha256) {
      throw new Error("RESEARCH_PRE_QUERY_POLICY_CHANGED")
    }
  }

  function evaluated(store: InvestigationStore, ledger: InvestigationLedger) {
    return preQuery?.evaluate(store.scope, job, decisionProcedurePin(ledger))
  }

  function existingView(ledger: InvestigationLedger, receipt: PreQueryReceipt | undefined) {
    if (!receipt) return view(ledger)
    // Reuse only the manifest reference of a settled, exact admission from this ledger.
    // Result pages still use the canonical store's fresh access and validity checks.
    const work = ledger.work[0]!
    const profile = ledger.remote_profile
    const { server_id, server_revision, tool_id, tool_schema_revision, principal_id, project_id } = port.capabilities
    if (ledger.work.length !== 1 || ledger.identity_version !== 2 ||
        !work.authorized_nodes?.includes(PRODUCER) || !work.authorized_nodes.includes(approval) ||
        work.admitted_reservation !== job.reserved_cost ||
        !profile || canonicalJson(profile) !== canonicalJson({
          server_id, server_revision, tool_id, tool_schema_revision, principal_id, project_id,
        })) throw new Error("RESEARCH_PRE_QUERY_WORK_UNVERIFIED")
    if (work.status !== "result_recorded" && work.status !== "reusable") return view(ledger, receipt)
    if (!work.result || work.reserved_cost !== 0 || ledger.budget_breach ||
        (work.result.expires_at && Date.parse(work.result.expires_at) <= Date.now())) {
      throw new Error("RESEARCH_PRE_QUERY_REUSE_UNVERIFIED")
    }
    return view(ledger, {
      ...receipt,
      reuse: { kind: "settled_manifest", work_key: work.work_key, manifest_digest: work.result.digest },
    })
  }

  return {
    create(ctx: V2InvestigationSession): V2InvestigationView {
      const store = InvestigationStore.open(scope(ctx), {
        create: true, costLimit: job.reserved_cost, maxAdmissions: 1,
      })
      return view(store.snapshot)
    },

    primary(ctx: V2InvestigationSession): V2InvestigationView | null {
      const ledger = ownerLedger(ctx)
      return ledger ? view(ledger) : null
    },

    /** Input to the research-role allowlist. This is a dated, settled observation. */
    advisoryEvidence(ctx: V2InvestigationSession) {
      const ledger = ownerLedger(ctx)
      const work = ledger?.work[0]
      if (!ledger || ledger.work.length !== 1 || !work?.result || work.purpose !== "analysis" ||
          !work.authorized_nodes?.includes(approval) || !work.authorized_nodes.includes(PRODUCER) ||
          (work.status !== "result_recorded" && work.status !== "reusable") ||
          (work.result.expires_at && Date.parse(work.result.expires_at) <= Date.now())) return undefined
      return { work_key: work.work_key, manifest_digest: work.result.digest, status: work.status,
        revision: ledger.revision, decision_revision: decisionRevision(ledger), coverage: work.result.coverage }
    },

    admit(ctx: V2InvestigationSession): Promise<V2InvestigationView> {
      return ownerOperation(ctx, async (store, ledger) => {
        assertWritable(ledger)
        const existing = ledger.work[0]
        checkPolicy(ledger, !existing || existing.status === "reserved")
        const receipt = await evaluated(store, ledger)
        if (existing && existing.status !== "reserved") return existingView(ledger, receipt)
        if (existing?.authorized_nodes?.includes(PRODUCER) && !existing.authorized_nodes.includes(approval)) {
          throw new Error("approved investigation job changed")
        }
        // Retry an interrupted admission only if both its identity and its reservation still match.
        if (existing && (existing.admitted_reservation !== job.reserved_cost ||
            canonicalJson(existing.parameters) !== canonicalJson(job.parameters))) {
          throw new Error("approved investigation job changed")
        }
        if (receipt && preQuery && ledger.checkpoint.scope.v2_pre_query_policy === undefined) {
          // Bind before reserving, so interruption cannot turn gated work into ungated work.
          await store.updateCheckpoint({ scope: {
            ...ledger.checkpoint.scope, v2_pre_query_policy: preQuery.policySha256,
          } })
        }
        if (existing?.authorized_nodes?.includes(PRODUCER)) return existingView(store.snapshot, receipt)
        const work = await store.admit(job, port.capabilities)
        await store.authorizeNodes(work.work_key, [PRODUCER, approval], () => {
          if (receipt) preQuery?.assertCurrent(receipt, decisionProcedurePin(store.snapshot))
        })
        return view(store.snapshot, receipt)
      })
    },

    dispatch(ctx: V2InvestigationSession): Promise<V2InvestigationView> {
      return ownerOperation(ctx, async (store, ledger) => {
        assertWritable(ledger)
        checkPolicy(ledger)
        const work = ledger.work[0]
        if (!work) throw new Error("approved investigation job has not been admitted")
        const receipt = await evaluated(store, ledger)
        if (work.status !== "reserved") return existingView(ledger, receipt)
        await store.dispatch(work.work_key, port, (fresh, current) => {
          checkPolicy(current)
          if (!fresh.authorized_nodes?.includes(PRODUCER) || !fresh.authorized_nodes.includes(approval)) {
            throw new Error("approved investigation admission is incomplete or changed")
          }
          if (receipt) preQuery?.assertCurrent(receipt, decisionProcedurePin(current))
        })
        return view(store.snapshot, receipt)
      })
    },

    reconcile(ctx: V2InvestigationSession): Promise<V2InvestigationView> {
      return ownerOperation(ctx, async (store, ledger) => {
        const work = ledger.work[0]
        if (!work) throw new Error("approved investigation job has not been admitted")
        if (work.status === "result_recorded" || work.status === "reusable") {
          checkPolicy(ledger)
          const receipt = await evaluated(store, ledger)
          if (receipt) return existingView(ledger, receipt)
        }
        // Lookup is read-only reconciliation of an already-issued submission ID.
        await store.reconcile(work.work_key, port)
        return view(store.snapshot)
      })
    },

    setNextMeasurement(
      ctx: V2InvestigationSession,
      input: NextMeasurement,
      verifyProcedure?: () => Promise<ProcedurePin | undefined>,
    ): Promise<V2InvestigationView> {
      return ownerOperation(ctx, async (store, ledger) => {
        assertWritable(ledger)
        const revision = decisionRevision(ledger)
        if (input.expected_decision_revision !== revision) throw new Error("stale investigation decision revision")
        const action = input.next_action
        if (typeof action !== "string" || !action.trim() || Buffer.byteLength(JSON.stringify(action)) > MAX_DECISION_BYTES) {
          throw new Error("next measurement exceeds the 1024-byte JSON budget or is empty")
        }
        if (revision === Number.MAX_SAFE_INTEGER) throw new Error("investigation decision revision exhausted")
        const patch: Partial<typeof ledger.checkpoint> = {}
        if (input.refutation !== undefined) {
          const refutation = refutationSchema.parse(input.refutation)
          const work = ledger.work[0]
          if (!work || !["result_recorded", "reusable"].includes(work.status) || work.result?.digest !== refutation.manifest_digest)
            throw new Error("refutation requires the current recorded manifest")
          // A decision records the owner's interpretation of cited evidence. It grants no checker verdict.
          const hypothesis = { id: refutation.id, statement: refutation.statement, status: "refuted" as const,
            evidence_refs: [refutation.manifest_digest], updated_at: new Date().toISOString() }
          patch.hypotheses = [...ledger.checkpoint.hypotheses.filter(item => item.id !== hypothesis.id), hypothesis]
          patch.decision_focus = { hypothesis_ids: [hypothesis.id], contradictions: [] }
        }
        const previousPin = decisionProcedurePin(ledger)
        const pin = await verifyProcedure?.()
        if (!pin && previousPin) throw new Error("RESEARCH_PROCEDURE_UNVERIFIED")
        // The checkpoint head is the sole publication point for the decision and its approval.
        await store.updateCheckpoint({
          ...patch,
          next_action: action,
          scope: {
            ...ledger.checkpoint.scope,
            v2_decision_revision: revision + 1,
            ...(pin ? { v2_decision_procedure: pin } : {}),
          },
        })
        return view(store.snapshot)
      })
    },

    grant(ctx: V2InvestigationSession, checker: V2InvestigationSession, selection: ResultSelection) {
      return ownerOperation(ctx, async (store, ledger) => {
        assertWritable(ledger)
        const binding = scope(checker, true)
        if (binding.project_directory !== store.scope.project_directory ||
            binding.project_id !== store.scope.project_id || binding.owner_id !== store.scope.owner_id) {
          throw new Error("checker must be a direct child of the investigation owner in the verified project")
        }
        return store.grantCheckerResult({
          work_key: selection.work_key,
          manifest_digest: selection.manifest_digest,
          producer_node: PRODUCER,
          checker_node: identity("v2-checker-", checker.sessionID),
        }, store.scope.owner_id)
      })
    },

    revoke(ctx: V2InvestigationSession, selection: Omit<CheckerResultGrantRevokeInput, "producer_node">) {
      return ownerOperation(ctx, async (store, ledger) => {
        assertWritable(ledger)
        return store.revokeCheckerResult({
          work_key: selection.work_key,
          manifest_digest: selection.manifest_digest,
          grant_id: selection.grant_id,
          checker_node: selection.checker_node,
          producer_node: PRODUCER,
        }, store.scope.owner_id)
      })
    },

    async checkerRead(ctx: V2InvestigationSession, selection: CheckerSelection) {
      const binding = scope(ctx, true)
      const store = InvestigationStore.open(binding)
      const grant = requireCheckerGrant(store.snapshot, ctx.sessionID, selection)
      return store.readResultPage(grant.work_key, port, null, MAX_CHECKER_ROWS, grant)
    },

    /** Fence a local, host-verified checker receipt against concurrent revocation. Keep network calls outside publish. */
    async withCheckerGrant<T>(ctx: V2InvestigationSession, selection: CheckerSelection, publish: () => T | Promise<T>): Promise<T> {
      return lockedOperation(scope(ctx, true), async (_store, ledger) => {
        requireCheckerGrant(ledger, ctx.sessionID, selection)
        const expiry = ledger.work[0]?.result?.expires_at
        if (expiry && Date.parse(expiry) <= Date.now()) throw new Error("checker result grant has expired")
        return publish()
      })
    },
  }
}

import { tool } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin"
import type { SkillEvolutionRuntime } from "./skill-evolution-runtime.ts"
import {
  appendSkillCandidateRevision,
  findSkillCandidate,
  loadCandidateRevision,
  loadSkillCandidates,
  loadSkillLedger,
  promoteSkillCandidate,
  recoverSkillTransactions,
  rollbackSkillCandidate,
} from "./skill-evolution-store.ts"

const COMPACT_CANDIDATES = 20
const COMPACT_LEDGER_ERRORS = 8

function ok(title: string, data: unknown) {
  return { title, output: JSON.stringify(data, null, 2), metadata: { alg: true, skill_evolution: true } }
}

function err(error: unknown) {
  return {
    title: "alg skill evolution error",
    output: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }, null, 2),
    metadata: { alg: true, skill_evolution: true, error: true },
  }
}

function actor(context: ToolContext): string {
  if (!context.sessionID) throw new Error("actor session id is required")
  return context.sessionID
}

function confirmation(value: boolean | string, operation: "PROMOTE" | "ROLLBACK", candidateId: string): void {
  if (value === true || value === `${operation}:${candidateId}`) return
  throw new Error(`confirmation must be true or the exact token ${operation}:${candidateId}`)
}

function requireEnabled(runtime: SkillEvolutionRuntime): void {
  if (!runtime.options.enabled) throw new Error("skill evolution is disabled; enable it explicitly in the server plugin tuple")
}

export function createSkillEvolutionTools(runtime: SkillEvolutionRuntime) {
  return {
    alg_skill_evolution_status: tool({
      description: "Inspect opt-in skill-evolution config, queue/ledger totals, recovery health, and bounded candidate details.",
      args: {
        detail: tool.schema.enum(["compact", "full"]).optional(),
        candidate_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/).optional(),
        state: tool.schema.enum(["proposed", "validated", "rejected", "promoted", "rolled_back", "superseded"]).optional(),
        limit: tool.schema.number().int().min(1).max(100).optional(),
      },
      async execute(args) {
        try {
          const recovery = runtime.options.enabled
            ? recoverSkillTransactions(runtime.project, runtime.options)
            : { recovered: [], unresolved: [], pending: 0, file_mutations: 0 }
          if (recovery.file_mutations > 0) runtime.markRestartRequired()
          const ledger = loadSkillLedger(runtime.project)
          const index = loadSkillCandidates(runtime.project)
          let candidates = index.candidates
          if (args.candidate_id) candidates = candidates.filter((candidate) => candidate.candidate_id === args.candidate_id)
          if (args.state) candidates = candidates.filter((candidate) => candidate.state === args.state)
          candidates = [...candidates].sort((left, right) => right.updated_at.localeCompare(left.updated_at))
          const limit = args.limit ?? COMPACT_CANDIDATES
          const visible = candidates.slice(0, limit)
          const detail = args.detail ?? "compact"
          const records = detail === "full"
            ? visible.map((candidate) => ({
                ...candidate,
                current: loadCandidateRevision(runtime.project, candidate),
                ...(args.candidate_id
                  ? { revisions: candidate.revision_refs.map((_, index) => loadCandidateRevision(runtime.project, candidate, index + 1)) }
                  : {}),
              }))
            : visible.map((candidate) => ({
                candidate_id: candidate.candidate_id,
                type: candidate.type,
                decision: candidate.decision,
                state: candidate.state,
                target: candidate.target,
                revision: candidate.current_revision,
                updated_at: candidate.updated_at,
                checker_findings: candidate.checker_findings.slice(0, 3),
                findings_omitted: Math.max(0, candidate.checker_findings.length - 3),
              }))
          const totals = Object.fromEntries(["pending", "running", "no-change", "candidate", "failed"].map((status) => [
            status,
            ledger.records.filter((record) => record.status === status).length,
          ]))
          const errors = ledger.records.filter((record) => record.error).slice(-COMPACT_LEDGER_ERRORS).map((record) => ({
            session_id: record.session_id,
            message_id: record.message_id,
            status: record.status,
            error: record.error,
          }))
          const runtimeState = runtime.status()
          return ok("alg skill evolution status", {
            enabled: runtime.options.enabled,
            detail,
            restart_required: runtimeState.restart_required,
            config: runtime.options,
            queue: {
              concurrency: 1,
              active: runtimeState.queue.active,
              in_memory: runtimeState.queue.in_memory,
              pending: totals.pending,
              running: totals.running,
              max_backlog: runtime.options.maxBacklog,
            },
            ledger: { revision: ledger.revision, total: ledger.records.length, totals, recent_errors: errors },
            candidates: {
              revision: index.revision,
              total: index.candidates.length,
              matched: candidates.length,
              shown: records.length,
              omitted: Math.max(0, candidates.length - records.length),
              records,
            },
            doctor: { recovery, healthy: recovery.unresolved.length === 0 },
            limitations: {
              automatic_promotion: false,
              memory_promotion: false,
              skill_deletion: false,
              sandbox: false,
              restart_required_after_file_mutation: true,
            },
          })
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_skill_evolution_audit: tool({
      description: "Idempotently enqueue a manual audit for an eligible completed assistant message in the current project.",
      args: {
        session_id: tool.schema.string().min(1).max(256).optional(),
        assistant_message_id: tool.schema.string().min(1).max(256).optional(),
        force: tool.schema.boolean().optional().describe("Explicitly retry only a failed or no-change record within its bounded attempt limit."),
      },
      async execute(args, context) {
        try {
          requireEnabled(runtime)
          const result = await runtime.manualAudit({
            actorSessionId: actor(context),
            sessionId: args.session_id,
            messageId: args.assistant_message_id,
            force: args.force,
          })
          return ok("alg skill evolution audit", {
            enqueued: result.enqueued,
            idempotent: !result.enqueued,
            record: result.record,
            ...(result.candidate ? { candidate: result.candidate } : {}),
            note: result.enqueued ? "Audit is queued; inspect alg_skill_evolution_status for the terminal result." : "Existing durable result was retained.",
          })
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_skill_evolution_review: tool({
      description: "Reject or restore a proposed/validated candidate; restoration never bypasses its recorded checker verdict.",
      args: {
        candidate_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        action: tool.schema.enum(["reject", "restore"]),
        reason: tool.schema.string().trim().min(1).max(2_000),
      },
      async execute(args, context) {
        try {
          requireEnabled(runtime)
          const recovery = recoverSkillTransactions(runtime.project, runtime.options)
          if (recovery.unresolved.length) throw new Error(`transaction recovery is unresolved: ${recovery.unresolved[0]}`)
          const candidate = findSkillCandidate(runtime.project, args.candidate_id)
          if (!candidate) throw new Error("skill-evolution candidate not found")
          let next: "rejected" | "validated" | "proposed"
          if (args.action === "reject") {
            if (candidate.state !== "proposed" && candidate.state !== "validated") throw new Error("only proposed or validated candidates can be rejected")
            next = "rejected"
          } else {
            if (candidate.state !== "rejected") throw new Error("only a rejected candidate can be restored")
            const initial = loadCandidateRevision(runtime.project, candidate, 1)
            const immutableApproval = candidate.type === "skill" && Boolean(candidate.checker_child_id) &&
              initial.actor_session_id === candidate.checker_child_id && initial.event === "checker_passed" &&
              initial.state === "validated" && initial.checker_output?.passed === true &&
              initial.checker_output.findings.length === 0 && candidate.checker_findings.length === 0
            next = immutableApproval ? "validated" : "proposed"
          }
          const updated = appendSkillCandidateRevision(runtime.project, candidate.candidate_id, candidate.current_revision, {
            state: next,
            event: args.action === "reject" ? "review_rejected" : "review_restored",
            actorSessionId: actor(context),
            reason: args.reason,
            update() {},
          })
          return ok("alg skill evolution review", { candidate: updated, approval_bypassed_checker: false })
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_skill_evolution_promote: tool({
      description: "Explicitly publish one validated skill candidate with no-clobber identity/hash checks; never auto-promotes.",
      args: {
        candidate_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        confirm: tool.schema.union([tool.schema.boolean(), tool.schema.string().max(96)]),
      },
      async execute(args, context) {
        try {
          requireEnabled(runtime)
          confirmation(args.confirm, "PROMOTE", args.candidate_id)
          const result = promoteSkillCandidate(runtime.project, args.candidate_id, actor(context), runtime.options)
          runtime.markRestartRequired()
          return ok("alg skill evolution promote", {
            ...result,
            automatic: false,
            restart_required: true,
            message: "Promotion is durable. Quit and restart OpenCode before expecting a new session to load the skill.",
          })
        } catch (error) {
          return err(error)
        }
      },
    }),

    alg_skill_evolution_rollback: tool({
      description: "Explicitly restore a promoted replacement only when the current target still equals the promoted hash.",
      args: {
        candidate_id: tool.schema.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
        confirm: tool.schema.union([tool.schema.boolean(), tool.schema.string().max(96)]),
      },
      async execute(args, context) {
        try {
          requireEnabled(runtime)
          confirmation(args.confirm, "ROLLBACK", args.candidate_id)
          const result = rollbackSkillCandidate(runtime.project, args.candidate_id, actor(context), runtime.options)
          runtime.markRestartRequired()
          return ok("alg skill evolution rollback", {
            ...result,
            custom_drift_preserved: true,
            restart_required: true,
            message: "Rollback is durable. Quit and restart OpenCode before relying on reloaded skills.",
          })
        } catch (error) {
          return err(error)
        }
      },
    }),
  }
}

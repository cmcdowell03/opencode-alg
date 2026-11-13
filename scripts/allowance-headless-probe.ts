import { createOpencodeClient } from "@opencode-ai/sdk"
import { createAlgTools } from "../src/tools.ts"
import { hydrateRunFully, loadRunForOwner } from "../src/store.ts"
import { MemoryStore, hashObject } from "../src/session-memory/store.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { CheckpointSchema } from "../src/session-memory/schemas.ts"
import { readSkillEvolutionDirectBounded } from "../src/skill-evolution-store.ts"
import { taskEvidence } from "../src/task-evidence.ts"
import { canonicalDirectory } from "../src/paths.ts"
import { ChangeScopeExclusionsSchema, finishChangeScopeEvidence } from "../src/change-scope-evidence.ts"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"

const MARKER = "ALG_DISPATCH_RECOVERY_PROBE_79A1"
const RECEIPT = "BOUND_SYNTHETIC_DISPATCH_RESULT_79A1"
const PROBE_SCOPE = { roots: ["."], allowed_paths: [], max_changed_files: 0 }
const USER_FILE = ".opencode/headless-user-file.txt"
const unpack = (value: unknown) => JSON.parse((value as { output: string }).output)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const count = z.number().int().nonnegative()
const time = z.iso.datetime({ offset: true })
const BeforeChildSchema = z.object({ baseline_sha256: hash, observed_at: time, owner_checkpoint_revision: count }).strict()
type BeforeChild = z.infer<typeof BeforeChildSchema>
export const ScopeHookEvidenceSchema = z.object({
  passed: z.boolean(), before_child: BeforeChildSchema, child_session_id: z.string().min(1).max(256),
  checkpoint_sha256: hash.nullable(), checkpoint_updated_at: time.nullable(),
  delivery_sha256: hash.nullable(), delivery_created_at: time.nullable(),
  delivery_state: z.enum(["prepared", "emitted", "unknown"]).nullable(),
  delivery_hook: z.enum(["system", "compaction"]).nullable(),
  baseline_retained: z.boolean(), delegated_role_matches: z.boolean(), hook_emitted_after_baseline: z.boolean(),
}).strict()
export const AllowanceScopeEvidenceSchema = z.object({
  passed: z.boolean(), baseline_sha256: hash, exclusion_policy_version: z.literal(2), exclusions: ChangeScopeExclusionsSchema,
  producer_hook: ScopeHookEvidenceSchema, checker_hook: ScopeHookEvidenceSchema,
  final_status: z.enum(["within_scope", "violated", "unavailable"]), changed_count: count,
  checker_evidence_matches: z.boolean(),
}).strict()
export const ScopeViolationEvidenceSchema = z.object({
  passed: z.boolean(), run_id: z.string(), owner: z.string(), task_id: hash, distinct_task: z.boolean(),
  max_dispatches: count, verification_reserve: count, baseline_sha256: hash, baseline_retained: z.boolean(),
  producer_hook: ScopeHookEvidenceSchema, changed_path: z.literal(USER_FILE), scope_status: z.enum(["within_scope", "violated", "unavailable"]),
  changed_count: count, run_status: z.string(), run_phase: z.string(), scope_error_observed: z.boolean(),
  attempts_before: count, attempts_after: count, checker_attempts: count, additional_sdk_creates: count, additional_sdk_prompts: count,
  reserved_before: count, reserved_after: count, ledger_unchanged: z.boolean(),
  host_children_before: z.array(z.string()).max(8), host_children_after: z.array(z.string()).max(8),
  positive_ledger_unchanged: z.boolean(), error: z.string().max(2048).nullable(), scope: z.string().max(512),
}).strict()

/** Read-only observer at the real SDK create boundary, after the executor persisted its baseline. */
export function observeScopeBeforeChild(project: string, runId: string, owner: string): BeforeChild {
  const run = loadRunForOwner(project, runId, owner)
  const basis = run?.task_baseline?.change_scope
  if (!run?.task_baseline || !basis || basis.version !== 2 ||
    hashObject(run.task_contract?.input.change_scope) !== hashObject(PROBE_SCOPE) || !basis.exclusions.includes(".opencode/session-memory"))
    throw Error("Scope probe requires its original root-wide baseline before SDK child creation")
  const checkpoint = new MemoryStore(project).checkpoint(owner)
  if (!checkpoint) throw Error("Scope probe owner checkpoint missing")
  return BeforeChildSchema.parse({ baseline_sha256: hashObject(run.task_baseline), observed_at: new Date().toISOString(),
    owner_checkpoint_revision: checkpoint.revision })
}

/** These are host-written receipts; this probe never calls prepare/settleDelivery itself. */
export function readScopeHookEvidence(project: string, runId: string, owner: string, node: "work" | "check", before: BeforeChild) {
  const run = loadRunForOwner(project, runId, owner)!
  const child = run.nodes[node]!.attempts[0]?.session_id
  if (!child) throw Error("Scope probe child session missing")
  const store = new MemoryStore(project), delivery = store.delivery(child)
  const checkpoint = delivery ? CheckpointSchema.parse(JSON.parse(readSkillEvolutionDirectBounded(project,
    store.path(["checkpoints", `${delivery.value.checkpoint}.json`]), 65536, "scope probe checkpoint").toString("utf8"))) : null
  const baselineRetained = !!run.task_baseline && hashObject(run.task_baseline) === before.baseline_sha256
  const roleMatches = checkpoint?.owner === child && checkpoint.project === store.projectId &&
    hashObject(checkpoint) === delivery?.value.checkpoint && checkpoint.delegation?.parent_owner === owner &&
    checkpoint.delegation.role === (node === "check" ? "checker" : "worker") &&
    checkpoint.revision === delivery?.value.context.revision && checkpoint.generation === delivery.value.context.generation
  const afterBaseline = !!delivery && !!checkpoint && delivery.value.state === "emitted" && delivery.value.hook === "system" &&
    delivery.value.context.state === "prepared" && Date.parse(checkpoint.updated_at) >= Date.parse(before.observed_at) &&
    Date.parse(delivery.value.created_at) >= Date.parse(checkpoint.updated_at)
  return ScopeHookEvidenceSchema.parse({ passed: baselineRetained && roleMatches && afterBaseline, before_child: before,
    child_session_id: child, checkpoint_sha256: delivery?.value.checkpoint ?? null, checkpoint_updated_at: checkpoint?.updated_at ?? null,
    delivery_sha256: delivery?.id ?? null, delivery_created_at: delivery?.value.created_at ?? null,
    delivery_state: delivery?.value.state ?? null, delivery_hook: delivery?.value.hook ?? null,
    baseline_retained: baselineRetained, delegated_role_matches: roleMatches, hook_emitted_after_baseline: afterBaseline })
}

export function allowanceProbeResponse(prompt: string): string | undefined {
  if (!prompt.includes(MARKER)) return undefined
  if (prompt.startsWith("You are a checker in a fresh child session.")) {
    const passed = prompt.includes(RECEIPT)
    return JSON.stringify({ passed, score: passed ? 10 : 0, failures: passed ? [] : ["Synthetic producer result missing"] })
  }
  return JSON.stringify({ answer: RECEIPT, evidence: [], constraints: [], options: [], acceptance_criteria: [MARKER], risks: [] })
}
function context(baseUrl: string, project: string, owner: string) {
  const client = createOpencodeClient({ baseUrl })
  const observations: BeforeChild[] = []
  const dispatches = { prompts: 0 }
  let observedRun: string | undefined
  const create = client.session.create.bind(client.session)
  client.session.create = options => {
    if (!observedRun || options?.body?.parentID !== owner) throw Error("Scope probe unexpected SDK create")
    observations.push(observeScopeBeforeChild(project, observedRun, owner))
    return create(options)
  }
  const prompt = client.session.prompt.bind(client.session)
  client.session.prompt = options => { dispatches.prompts++; return prompt(options) }
  const tools = createAlgTools({ client, directory: project, worktree: project } as any,
    () => ({ researcher: { providerID: "alg-headless", modelID: "deterministic" }, checker: { providerID: "alg-headless", modelID: "deterministic" } }),
    undefined, { taskAllowancePolicy: { max_dispatches: 2, verification_reserve: 1 },
      sessionMemory: new SessionMemoryRuntime(project, { mode: "assist" }, [], []) })
  const call = { sessionID: owner, messageID: "allowance-fixture", agent: "orchestrator", directory: project,
    worktree: project, abort: AbortSignal.timeout(60_000), metadata: () => {}, ask: async () => { throw Error("No permissions expected") } } as any
  return { tools, call, client, observations, dispatches, observeRun: (id: string) => { observedRun = id } }
}
export function allowanceProbePlanArgs(phase = "initial") {
  return { goal: MARKER + ": " + phase, criteria: [MARKER + ": preserve the synthetic producer response for checking"],
    graph_json: JSON.stringify({ name: "headless-allowance", max_global_attempts: 2, max_concurrency: 1, nodes: [
      { id: "work", agent: "researcher", depends_on: [] },
      { id: "check", agent: "checker", depends_on: ["work"], isolated_check: true, inputs: { claimed: "work" } },
    ] }),
    task_contract: { version: 1, kind: "read_only", discovery: "not_required", phase: "complete",
      deliverables: [{ destination: "response", producer_node: "work" }],
      verification: { checker_node: "check", execution: "none" }, preserve_paths: [],
      change_scope: structuredClone(PROBE_SCOPE),
      evidence_plan: [{ criterion: 1, observations: [{ kind: "deliverable", index: 0 }, { kind: "change_scope" }] }] },
  } as const
}
export function allowanceCheckpoint(project: string, owner: string) {
  const state = new MemoryStore(project).checkpoint(owner)?.task_allowance
  if (!state) throw Error("Headless allowance root ledger missing")
  return { task_id: state.reference.task_id, reserved: state.entries.length, entries_sha256: hashObject(state.entries),
    max_dispatches: state.policy.max_dispatches, verification_reserve: state.policy.verification_reserve }
}
export async function startAllowanceHostProbe(baseUrl: string, project: string, owner: string) {
  const { tools, call, client, observations, dispatches, observeRun } = context(baseUrl, project, owner)
  const plan = unpack(await tools.alg_plan.execute(allowanceProbePlanArgs() as any, call))
  if (plan.error) throw Error("Allowance probe planning failed: " + plan.error)
  observeRun(plan.run_id)
  const work = unpack(await tools.alg_run.execute({ run_id: plan.run_id, max_waves: 1 }, call))
  if (work.error) throw Error("Allowance probe execution failed: " + work.error)
  const saved = loadRunForOwner(project, plan.run_id, owner)!
  const first = allowanceCheckpoint(project, owner)
  const child = saved.nodes.work!.attempts[0]?.session_id
  const host = child ? await client.session.get({ path: { id: child }, query: { directory: project } }) : null
  if (saved.status !== "blocked" || saved.global_attempts !== 1 || first.reserved !== 1 || first.max_dispatches !== 2 ||
    first.verification_reserve !== 1 || host?.data?.parentID !== owner || saved.nodes.work!.status !== "done" ||
    saved.nodes.check!.current_attempt !== 0) throw Error("Allowance probe did not reserve one actual child: " +
      JSON.stringify({ status: saved.status, phase: saved.phase, attempts: saved.global_attempts, first,
        parent_verified: host?.data?.parentID === owner, worker_status: saved.nodes.work!.status,
        failures: saved.nodes.work!.last_failures, summary: saved.summary }))
  if (observations.length !== 1 || dispatches.prompts !== 1) throw Error("Scope probe must observe exactly one producer create/prompt")
  const producerHook = readScopeHookEvidence(project, saved.run_id, owner, "work", observations[0]!)
  const scope = finishChangeScopeEvidence(project, PROBE_SCOPE, saved.task_baseline!.change_scope)
  if (!producerHook.passed || scope.status !== "within_scope" || scope.changed.length)
    throw Error("Producer host hooks or clean scope were not observed: " + JSON.stringify({ producerHook, scope }))
  return { run_id: saved.run_id, reference: saved.task_allowance!, first, child_session_id: child!, producer_hook: producerHook }
}
export async function finishAllowanceHostProbe(baseUrl: string, project: string, owner: string,
  before: Awaited<ReturnType<typeof startAllowanceHostProbe>>) {
  const recovered = allowanceCheckpoint(project, owner)
  if (JSON.stringify(recovered) !== JSON.stringify(before.first)) throw Error("Allowance ledger changed across compaction/restarts")
  const { tools, call, client, observations, dispatches, observeRun } = context(baseUrl, project, owner)
  observeRun(before.run_id)
  const result = unpack(await tools.alg_resume.execute({ run_id: before.run_id }, call))
  if (result.error) throw Error("Allowance continuation failed: " + result.error)
  const saved = loadRunForOwner(project, before.run_id, owner)!
  const final = allowanceCheckpoint(project, owner)
  const child = saved.nodes.check!.attempts[0]?.session_id
  const host = child ? await client.session.get({ path: { id: child }, query: { directory: project } }) : null
  if (saved.status !== "done" || final.reserved !== 2 || host?.data?.parentID !== owner)
    throw Error("Allowance checker continuation failed: " + JSON.stringify({ status: saved.status, phase: saved.phase,
      reserved: final.reserved, summary: saved.summary, checker_status: saved.nodes.check!.status,
      failures: saved.nodes.check!.last_failures, parent_verified: host?.data?.parentID === owner,
      writer: writerDiagnostic(project) }))
  if (observations.length !== 1 || dispatches.prompts !== 1) throw Error("Scope probe must observe exactly one fresh checker create/prompt")
  const checkerHook = readScopeHookEvidence(project, saved.run_id, owner, "check", observations[0]!)
  const scope = finishChangeScopeEvidence(project, PROBE_SCOPE, saved.task_baseline!.change_scope)
  const evidence = taskEvidence(hydrateRunFully(saved))!
  const proofMatches = saved.nodes.check!.attempts[0]?.task_evidence_ref?.sha256 === hashObject(evidence)
  const scopeRegression = AllowanceScopeEvidenceSchema.parse({
    passed: before.producer_hook.passed && checkerHook.passed && scope.status === "within_scope" && !scope.changed.length && proofMatches &&
      checkerHook.before_child.baseline_sha256 === before.producer_hook.before_child.baseline_sha256,
    baseline_sha256: hashObject(saved.task_baseline), exclusion_policy_version: saved.task_baseline!.change_scope!.version,
    exclusions: saved.task_baseline!.change_scope!.exclusions, producer_hook: before.producer_hook, checker_hook: checkerHook,
    final_status: scope.status, changed_count: scope.changed.length, checker_evidence_matches: proofMatches,
  })
  const plan = unpack(await tools.alg_plan.execute(allowanceProbePlanArgs("next-phase-after-exhaustion") as any, call))
  if (plan.error) throw Error("Exhaustion probe planning failed: " + plan.error)
  observeRun(plan.run_id)
  const blocked = unpack(await tools.alg_run.execute({ run_id: plan.run_id }, call))
  const retry = loadRunForOwner(project, plan.run_id, owner)!
  const passed = saved.status === "done" && final.reserved === 2 && final.task_id === before.first.task_id &&
    child !== before.child_session_id && host?.data?.parentID === owner && !blocked.error &&
    retry.status === "blocked" && retry.phase === "task-allowance" && retry.global_attempts === 0 &&
    allowanceCheckpoint(project, owner).reserved === 2 && observations.length === 1 && dispatches.prompts === 1 && scopeRegression.passed
  return { passed, run_id: saved.run_id, task_id: final.task_id, reserved_before_compaction: before.first.reserved,
    reserved_after_restarts: recovered.reserved, reserved_after_checker: final.reserved,
    additional_dispatches_after_exhaustion: retry.global_attempts, checker_parent_verified: host?.data?.parentID === owner,
    scope_regression: scopeRegression,
    scope: "Real SDK children and host-hook delivery writes after the original scope baseline, across one root compaction and two restarts; synthetic provider, no model-quality claim." }
}

async function childIds(client: ReturnType<typeof createOpencodeClient>, project: string, owner: string): Promise<string[]> {
  const result = await client.session.children({ path: { id: owner }, query: { directory: project }, signal: AbortSignal.timeout(15000) })
  if (result.error || !Array.isArray(result.data) || result.data.length > 8 || result.data.some(child => child.parentID !== owner))
    throw Error("Scope probe host child census unavailable")
  return result.data.map(child => child.id).sort()
}

/** Separate root session and ledger. The owned project is removed only by the enclosing harness cleanup. */
export async function runScopeViolationHostProbe(baseUrl: string, project: string, positiveProject: string, positiveOwner: string) {
  if (canonicalDirectory(project) === canonicalDirectory(positiveProject)) throw Error("Scope violation probe requires a separate project")
  const client = createOpencodeClient({ baseUrl })
  const positiveBefore = allowanceCheckpoint(positiveProject, positiveOwner)
  mkdirSync(join(project, ".opencode"), { recursive: true })
  writeFileSync(join(project, USER_FILE), "Original user-authored fixture.\n", { flag: "wx" })
  const created = await client.session.create({ query: { directory: project }, body: { title: "Independent unauthorized scope fixture" },
    signal: AbortSignal.timeout(15000) })
  if (created.error || !created.data?.id || created.data.parentID) throw Error("Scope violation probe requires a fresh host root session")
  const owner = created.data.id
  const start = await startAllowanceHostProbe(baseUrl, project, owner)
  const childrenBefore = await childIds(client, project, owner)
  const before = loadRunForOwner(project, start.run_id, owner)!
  const baselineHash = hashObject(before.task_baseline)
  writeFileSync(join(project, USER_FILE), "Unauthorized fixture edit after the producer and before the checker.\n")
  const { tools, call, observations, dispatches, observeRun } = context(baseUrl, project, owner)
  observeRun(start.run_id)
  const result = unpack(await tools.alg_resume.execute({ run_id: start.run_id }, call))
  const after = loadRunForOwner(project, start.run_id, owner)!
  const final = allowanceCheckpoint(project, owner)
  const childrenAfter = await childIds(client, project, owner)
  const observed = finishChangeScopeEvidence(project, PROBE_SCOPE, after.task_baseline!.change_scope)
  const error = typeof result.error === "string" ? result.error : null
  const scopeError = `${error ?? ""}\n${after.summary}`.includes("task_change_scope_unverified")
  const baselineRetained = hashObject(after.task_baseline) === baselineHash
  const ledgerUnchanged = hashObject(final) === hashObject(start.first)
  const positiveUnchanged = hashObject(allowanceCheckpoint(positiveProject, positiveOwner)) === hashObject(positiveBefore)
  const distinctTask = final.task_id !== positiveBefore.task_id && start.reference.root_owner === owner
  return ScopeViolationEvidenceSchema.parse({
    passed: distinctTask && positiveUnchanged && baselineRetained && ledgerUnchanged && start.producer_hook.passed &&
      observed.status === "violated" && observed.changed.length === 1 && observed.changed[0]!.path === USER_FILE &&
      observed.changed[0]!.kind === "modified" && after.status === "blocked" && after.phase === "task-prerequisite" && scopeError &&
      before.global_attempts === 1 && after.global_attempts === 1 && after.nodes.check!.current_attempt === 0 &&
      observations.length === 0 && dispatches.prompts === 0 &&
      final.reserved === 1 && final.max_dispatches === 2 && final.verification_reserve === 1 &&
      hashObject(childrenBefore) === hashObject([start.child_session_id]) && hashObject(childrenAfter) === hashObject(childrenBefore),
    run_id: after.run_id, owner, task_id: final.task_id, distinct_task: distinctTask,
    max_dispatches: final.max_dispatches, verification_reserve: final.verification_reserve,
    baseline_sha256: baselineHash, baseline_retained: baselineRetained, producer_hook: start.producer_hook,
    changed_path: USER_FILE, scope_status: observed.status, changed_count: observed.changed.length,
    run_status: after.status, run_phase: after.phase, scope_error_observed: scopeError,
    attempts_before: before.global_attempts, attempts_after: after.global_attempts, checker_attempts: after.nodes.check!.current_attempt,
    additional_sdk_creates: observations.length, additional_sdk_prompts: dispatches.prompts,
    reserved_before: start.first.reserved, reserved_after: final.reserved,
    ledger_unchanged: ledgerUnchanged, host_children_before: childrenBefore, host_children_after: childrenAfter,
    positive_ledger_unchanged: positiveUnchanged, error: error?.slice(0, 2048) ?? null,
    scope: "Unauthorized user-file modification between real producer and checker waves; independent root/ledger, synthetic provider, no ledger reset or refund.",
  })
}

function writerDiagnostic(project: string) {
  try {
    const bytes = readFileSync(new MemoryStore(project).path(["writer.lock"]))
    if (bytes.length > 4096) return { status: "oversized" }
    const value = JSON.parse(bytes.toString("utf8"))
    let alive: boolean | null = null
    if (Number.isSafeInteger(value.pid)) try { process.kill(value.pid, 0); alive = true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false
    }
    return { pid: value.pid, expires_at: value.expires_at, sampled_at: new Date().toISOString(), alive }
  } catch { return { status: "unavailable" } }
}


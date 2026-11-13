import { createOpencodeClient } from "@opencode-ai/sdk"
import { createAlgTools } from "../src/tools.ts"
import { loadRunForOwner } from "../src/store.ts"
import { MemoryStore, hashObject } from "../src/session-memory/store.ts"
import type { TaskAllowanceReference } from "../src/task-allowance-schema.ts"
import { readFileSync } from "node:fs"

const MARKER = "ALG_DISPATCH_RECOVERY_PROBE_79A1"
const RECEIPT = "BOUND_SYNTHETIC_DISPATCH_RESULT_79A1"
const unpack = (value: unknown) => JSON.parse((value as { output: string }).output)
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
  const tools = createAlgTools({ client, directory: project, worktree: project } as any,
    () => ({ researcher: { providerID: "alg-headless", modelID: "deterministic" }, checker: { providerID: "alg-headless", modelID: "deterministic" } }),
    undefined, { taskAllowancePolicy: { max_dispatches: 2, verification_reserve: 1 } })
  const call = { sessionID: owner, messageID: "allowance-fixture", agent: "orchestrator", directory: project,
    worktree: project, abort: AbortSignal.timeout(60_000), metadata: () => {}, ask: async () => { throw Error("No permissions expected") } } as any
  return { tools, call, client }
}
function planArgs(phase = "initial") {
  return { goal: MARKER + ": " + phase, criteria: [MARKER + ": preserve the synthetic producer response for checking"],
    graph_json: JSON.stringify({ name: "headless-allowance", max_global_attempts: 2, max_concurrency: 1, nodes: [
      { id: "work", agent: "researcher", depends_on: [] },
      { id: "check", agent: "checker", depends_on: ["work"], isolated_check: true, inputs: { claimed: "work" } },
    ] }),
    task_contract: { version: 1, kind: "read_only", discovery: "not_required", phase: "complete",
      deliverables: [{ destination: "response", producer_node: "work" }],
      verification: { checker_node: "check", execution: "none" }, preserve_paths: [],
      evidence_plan: [{ criterion: 1, observations: [{ kind: "deliverable", index: 0 }] }] },
  } as const
}
export function allowanceCheckpoint(project: string, owner: string) {
  const state = new MemoryStore(project).checkpoint(owner)?.task_allowance
  if (!state) throw Error("Headless allowance root ledger missing")
  return { task_id: state.reference.task_id, reserved: state.entries.length, entries_sha256: hashObject(state.entries),
    max_dispatches: state.policy.max_dispatches, verification_reserve: state.policy.verification_reserve }
}
export async function startAllowanceHostProbe(baseUrl: string, project: string, owner: string) {
  const { tools, call, client } = context(baseUrl, project, owner)
  const plan = unpack(await tools.alg_plan.execute(planArgs() as any, call))
  if (plan.error) throw Error("Allowance probe planning failed: " + plan.error)
  const work = unpack(await tools.alg_run.execute({ run_id: plan.run_id, max_waves: 1 }, call))
  if (work.error) throw Error("Allowance probe execution failed: " + work.error)
  const saved = loadRunForOwner(project, plan.run_id, owner)!
  const first = allowanceCheckpoint(project, owner)
  const child = saved.nodes.work!.attempts[0]?.session_id
  const host = child ? await client.session.get({ path: { id: child }, query: { directory: project } }) : null
  if (saved.status !== "blocked" || saved.global_attempts !== 1 || first.reserved !== 1 || first.max_dispatches !== 2 ||
    first.verification_reserve !== 1 || host?.data?.parentID !== owner) throw Error("Allowance probe did not reserve one actual child: " +
      JSON.stringify({ status: saved.status, phase: saved.phase, attempts: saved.global_attempts, first,
        parent_verified: host?.data?.parentID === owner, worker_status: saved.nodes.work!.status,
        failures: saved.nodes.work!.last_failures, summary: saved.summary }))
  return { run_id: saved.run_id, reference: saved.task_allowance!, first, child_session_id: child! }
}
export async function finishAllowanceHostProbe(baseUrl: string, project: string, owner: string,
  before: { run_id: string; reference: TaskAllowanceReference; first: ReturnType<typeof allowanceCheckpoint>; child_session_id: string }) {
  const recovered = allowanceCheckpoint(project, owner)
  if (JSON.stringify(recovered) !== JSON.stringify(before.first)) throw Error("Allowance ledger changed across compaction/restarts")
  const { tools, call, client } = context(baseUrl, project, owner)
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
  const plan = unpack(await tools.alg_plan.execute(planArgs("next-phase-after-exhaustion") as any, call))
  if (plan.error) throw Error("Exhaustion probe planning failed: " + plan.error)
  const blocked = unpack(await tools.alg_run.execute({ run_id: plan.run_id }, call))
  const retry = loadRunForOwner(project, plan.run_id, owner)!
  const passed = saved.status === "done" && final.reserved === 2 && final.task_id === before.first.task_id &&
    child !== before.child_session_id && host?.data?.parentID === owner && !blocked.error &&
    retry.status === "blocked" && retry.phase === "task-allowance" && retry.global_attempts === 0 &&
    allowanceCheckpoint(project, owner).reserved === 2
  return { passed, run_id: saved.run_id, task_id: final.task_id, reserved_before_compaction: before.first.reserved,
    reserved_after_restarts: recovered.reserved, reserved_after_checker: final.reserved,
    additional_dispatches_after_exhaustion: retry.global_attempts, checker_parent_verified: host?.data?.parentID === owner,
    scope: "Real SDK child dispatch with a synthetic provider across one root compaction and two host restarts; no model-quality claim." }
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


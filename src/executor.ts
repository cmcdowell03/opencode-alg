import type { ToolContext } from "@opencode-ai/plugin"
import type { NodeAttempt, NodeDef, RunDataReference, RunState, ShellGateDef } from "./types.ts"
import { assertFilesystemRootAuthorized, canonicalContainedDirectory } from "./paths.ts"
import {
  allTerminal,
  anyFailed,
  descendantsOf,
  readyNodes,
  skipFailedDescendants,
  validateGraph,
  wireInputs,
} from "./graph.ts"
import { canonicalJson, sha256Json } from "./persistence.ts"
import { buildCheckerEvidence, isCheckerEvidencePort } from "./checker-evidence.ts"
import { buildVerificationBasis, validateVerification, effectiveCriteria } from "./verification.ts"
import { assertManagedGraph, graphPolicy } from "./graph-policy.ts"
import { assertTaskState } from "./task-contract.ts"
import { taskEvidence, type TaskEvidence } from "./task-evidence.ts"
import { captureTaskBaseline } from "./task-baseline.ts"
import { parseAndValidate } from "./schemas.ts"
import {
  acquireRunLock,
  writeTaskEvidence,
  loadCommittedRunProjectionForOwner,
  assertProjectFilePathContained,
  assertRunArtifactPathContained,
  hydrateRunForExecution,
  hydrateRunFully,
  linkSession,
  loadRun,
  persistRunFenced,
  type RunLock,
} from "./store.ts"
import { awaitLock } from "./filesystem-mutex.ts"
import {
  buildCheckerPrompt,
  buildWorkerPrompt,
  normalizeFreshResponsePaths,
  runNodeSession,
  type Client,
  type NodePromptOpts,
  type NodePromptResult,
} from "./sessions.ts"
import {
  executeShellGate,
  prepareShellRuntime,
  type ShellExecutionContext,
  type ShellExecutionResult,
} from "./shell.ts"
import {
  boundDiagnosticList,
  formatSdkDiagnostic,
  safeDiagnosticText,
} from "./diagnostics.ts"
import { truncateUtf8, utf8Bytes } from "./limits.ts"
import { preflightShellGates } from "./shell-preflight.ts"
import { gateRecoveryBasis, sameGateRecovery } from "./gate-recovery.ts"
import { capturePreservationBasis, finishPreservationEvidence } from "./preservation-evidence.ts"
import { fromShellGateEvidence } from "./execution-evidence.ts"
import type { TaskAllowanceRuntime } from "./task-allowance.ts"

export const MAX_RUN_SUMMARY_CHARS = 40_000
const MAX_RUN_SUMMARY_BYTES = 40_000
const MAX_SUMMARY_GOAL_SIZE = 2_000
const MAX_SUMMARY_NODES = 64
const MAX_SUMMARY_FAILURE_ENTRIES = 2
const MAX_SUMMARY_FAILURE_SIZE = 256

export interface ExecuteOptions {
  taskAllowance?: TaskAllowanceRuntime
  client: Client
  parentSessionId: string
  directory: string
  worktree: string
  toolContext: Pick<ToolContext, "ask" | "abort">
  maxWaves?: number
  maxConcurrency?: number
  dry?: boolean
  shellGateCmd?: string
  shellGateTimeoutMs?: number
  shellGateCwd?: string
  onEvent?: (message: string) => void
  /** Synchronous, best-effort observer called only after a successful durable save. */
  onProgress?: (run: RunState) => void
  sessionRunner?: (options: NodePromptOpts) => Promise<NodePromptResult>
  shellRunner?: (options: {
    cmd: string
    cwd?: string
    timeoutMs?: number
    context: ShellExecutionContext
    metadata?: Record<string, unknown>
  }) => Promise<ShellExecutionResult>
  /** Test seam for setup admission; production uses the same shell runtime as execution. */
  shellPreparer?: typeof prepareShellRuntime
  /** Test-only fault barrier after atomic sidecar write and before progress fencing. */
  afterSessionSidecar?: () => void
  /** Scoped procedure handoff must succeed before the child prompt is sent. */
  beforeChildPrompt?: (child: string, role: "worker" | "checker", node: NodeDef) => Promise<void>
  /** Admission/checkpoint guard before attempt reservation; failure consumes no model attempt. */
  beforeBatch?: (run: RunState, nodes: readonly NodeDef[]) => Promise<void>
  /** Tool ids hidden from every worker session (for example ALG's own orchestration tools). */
  workerDisabledTools?: readonly string[]
  allowFilesystemRoot?: boolean
  /** Additive test/path-policy seam; cannot disable actual-root detection. */
  treatProjectAsFilesystemRoot?: boolean
  operation?: "run" | "resume"
  /** Internal active lease; callers must not supply this. */
  activeLock?: RunLock
}

function log(options: ExecuteOptions, message: string): void {
  // Observability must never rewrite a committed worker outcome.
  try { options.onEvent?.(message) } catch { /* best-effort observer */ }
}

class PersistenceBoundaryError extends Error {
  constructor(cause: unknown) { super("Run persistence boundary failed", { cause }) }
}

/** The run exactly as its lease last saved it. A save of an unchanged run would commit nothing new. */
const lastSaved = new WeakMap<RunLock, string>()

/** Undefined when the state cannot be serialized; the save then proceeds and reports the real problem. */
function fingerprint(run: RunState): string | undefined {
  try { return JSON.stringify(run) } catch { return undefined }
}

function commit(run: RunState, options: ExecuteOptions, lock: RunLock): void {
  const unsaved = fingerprint(run)
  if (unsaved !== undefined && lastSaved.get(lock) === unsaved) return
  persistRunFenced(run, options.worktree, lock, { coalesceOwnerIndex: true })
  // Saving advances the revision and normalizes the caller's state, so remember the result, not the input.
  const saved = fingerprint(run)
  if (saved === undefined) lastSaved.delete(lock)
  else lastSaved.set(lock, saved)
  try {
    const result: unknown = (options.onProgress as ((run: RunState) => unknown) | undefined)?.(run)
    if (result && (typeof result === "object" || typeof result === "function")) {
      const then = (result as { then?: unknown }).then
      if (typeof then === "function") {
        void Promise.resolve(result).catch(() => {})
      }
    }
  } catch {
    // Observer failures, including thenable inspection, never alter durable execution.
  }
}

/**
 * Commits the run and reports progress. The commit itself is synchronous. If another process holds one
 * of this run's short locks, the wait for it is a timer, so the host keeps running; a save takes its
 * locks before it writes anything, and a sibling node that saved the same state meanwhile makes the
 * repeated attempt a no-op.
 */
async function save(run: RunState, options: ExecuteOptions): Promise<void> {
  const lock = options.activeLock
  if (!lock) throw new Error("execution save requires an active fenced run lock")
  try {
    await awaitLock(() => commit(run, options, lock))
  } catch (error) {
    throw new PersistenceBoundaryError(error)
  }
}

function shellFailure(result: ShellExecutionResult): string {
  const category = result.setup_failed ? "setup_failed" : result.termination_failed ? "termination_unverified" : result.cancelled ? "cancelled"
    : result.timed_out ? "timeout" : "nonzero_exit"
  // Test frameworks often report only on stdout. Empty stderr is not an empty diagnostic.
  // Exit codes alone never establish a planner defect or prove implementation correctness.
  const channel = result.stderr_tail.trim() ? "stderr" : result.stdout_tail.trim() ? "stdout" : "none"
  const detail = channel === "stderr" ? result.stderr_tail : channel === "stdout" ? result.stdout_tail : "No output captured; inspect the gate command, shell and cwd."
  // Redact before further clipping: slicing a long credential value first can
  // remove its identifying key and leave an unrecognizable secret fragment.
  const safeDetail = safeDiagnosticText(detail, 500)
  return safeDiagnosticText(`shell gate failed (exit ${result.exit_code}): [category=${category}; shell=${process.platform === "win32" ? "cmd.exe" : "posix-shell"}; cwd=${safeDiagnosticText(result.cwd, 256)}; output=${channel}] ${safeDetail}`)
}

function effectiveShellGate(run: RunState, definition: NodeDef, options: ExecuteOptions): ShellGateDef | undefined {
  // Match withShellGate and prospectiveShellGateHash: a public override targets
  // the first implementer, never every implementer in a custom DAG.
  return definition.agent === "implementer" && options.shellGateCmd &&
    definition.id === run.graph.nodes.find((node) => node.agent === "implementer")?.id
    ? { ...definition.shell_gate, cmd: options.shellGateCmd,
        ...(options.shellGateTimeoutMs !== undefined ? { timeout_ms: options.shellGateTimeoutMs } : {}),
        ...(options.shellGateCwd !== undefined ? { cwd: options.shellGateCwd } : {}) }
    : definition.shell_gate
}

function gateRecoverySource(run: RunState, definition: NodeDef): NodeAttempt | undefined {
  if (definition.agent !== "implementer") return undefined
  const attempts = run.nodes[definition.id]!.attempts
  const last = attempts.at(-1)
  if (!last) return undefined
  const interrupted = last.status !== "done" && last.reused_output_from !== undefined &&
    (last.outcome === undefined || last.outcome === "sdk_error")
  if (!last.shell_setup_failed && !interrupted) return undefined
  let source = last
  let archivedAttempts: NodeAttempt[] | undefined
  while (source.reused_output_from !== undefined) {
    let prior = attempts.find(attempt => attempt.attempt === source.reused_output_from)
    if (!prior && source.reused_output_from <= (run.nodes[definition.id]!.attempt_history_ref?.attempt_count ?? 0)) {
      // Durable saves normalize the live array to its visible tail. Read the
      // verified committed archive without replacing active sibling/attempt objects.
      if (!archivedAttempts) {
        const committed = loadRun(run.project_directory, run.run_id)
        if (!committed || committed.revision !== run.revision) throw new Error("Gate recovery history changed")
        archivedAttempts = hydrateRunFully(committed).nodes[definition.id]!.attempts
      }
      prior = archivedAttempts.find(attempt => attempt.attempt === source.reused_output_from)
    }
    if (!prior || prior.attempt >= source.attempt) throw new Error("Invalid gate recovery lineage")
    source = prior
  }
  if (source !== last || interrupted) {
    if (!source?.shell_setup_failed || !source.gate_recovery || source.schema_ok !== true) {
      throw new Error("Gate recovery source is unavailable; refusing to rerun implementation")
    }
  }
  return source
}

function sameRecoveryBasis(run: RunState, definition: NodeDef, options: ExecuteOptions, source: NodeAttempt, gate: ShellGateDef): boolean {
  const next = gateRecoveryBasis(options.worktree, options.directory, gate, source.output)
  const prior = source.gate_recovery
  if (sameGateRecovery(prior, next)) return true
  // A same-command setup repair may change only cwd/timeout. Keep the
  // original output/files commitment, even across repeated setup failures.
  return !!run.task_contract && options.operation === "resume" && !!definition.shell_gate &&
    gate.cmd === definition.shell_gate.cmd && options.shellGateCmd === gate.cmd && !!prior && !!next &&
    source.shell_setup_failed === true && source.gate_evidence?.commands.some(command =>
      command.tool === "shell_gate" && command.setup_failed === true && command.gate_ok === false &&
      !command.timed_out && !command.cancelled && !command.termination_failed) === true &&
    next.output_sha256 === prior.output_sha256 && next.files_sha256 === prior.files_sha256
}

function assertAdmittedGateExecution(run: RunState, options: ExecuteOptions): string | undefined {
  if (!run.task_contract) return
  const committed = loadCommittedRunProjectionForOwner(options.worktree, run.run_id, options.parentSessionId)
  if (!committed || committed.revision !== run.revision || committed.task_contract?.contract_sha256 !== run.task_contract.contract_sha256)
    throw new Error("task_contract_locked: committed admission changed before execution")
  const hasOverride = options.shellGateCmd !== undefined || options.shellGateCwd !== undefined || options.shellGateTimeoutMs !== undefined
  const target = committed.graph.nodes.find(node => node.agent === "implementer")
  if (sha256Json(run.graph) !== sha256Json(committed.graph)) {
    // The legacy tool adapter eagerly applies the requested override. Admit
    // only that exact overlay, then restore the immutable graph before work.
    const overlay = structuredClone(committed.graph)
    const node = overlay.nodes.find(item => item.id === target?.id)
    if (!hasOverride || !node || !options.shellGateCmd)
      throw new Error("task_contract_locked: execute the committed graph without rewriting admitted verification")
    node.shell_gate = effectiveShellGate(committed, target!, options)
    node.loop = { max_attempts: node.loop?.max_attempts ?? 1, gate: "all" }
    if (sha256Json(run.graph) !== sha256Json(overlay))
      throw new Error("task_contract_locked: execute the committed graph without rewriting admitted verification")
  }
  run.graph = committed.graph
  if (!hasOverride) return committed.phase
  const state = target && run.nodes[target.id]
  if (options.operation !== "resume" || options.dry || run.mode === "dry" || !target?.shell_gate || !state ||
    (state.status !== "pending" && state.status !== "ready") || state.current_attempt >= (target.loop?.max_attempts ?? 1) ||
    run.global_attempts >= run.graph.max_global_attempts || options.shellGateCmd !== target.shell_gate.cmd ||
    (options.shellGateCwd === undefined && options.shellGateTimeoutMs === undefined) ||
    (options.shellGateTimeoutMs !== undefined && (!Number.isSafeInteger(options.shellGateTimeoutMs) ||
      options.shellGateTimeoutMs < 100 || options.shellGateTimeoutMs > 600_000))) {
    throw new Error("task_contract_locked: admitted gates allow only a same-command cwd or timeout repair on explicit setup resume")
  }
  const source = gateRecoverySource(run, target)
  if (!source?.gate_recovery || !source.gate_evidence?.commands.some(command => command.setup_failed === true))
    throw new Error("task_contract_locked: gate repair requires a durable setup-failure receipt")
  return committed.phase
}

function preflightExecutableNodes(run: RunState, options: ExecuteOptions, batch?: readonly NodeDef[]): boolean {
  if (run.global_attempts >= run.graph.max_global_attempts) return false
  const reachable = new Set<string>()
  const candidates: NodeDef[] = []
  // Graph definitions are topologically ordered. Failed/exhausted branches
  // cannot become ready in this invocation and must not veto independent work.
  for (const node of run.graph.nodes) {
    const state = run.nodes[node.id]!
    if (state.status === "done") { reachable.add(node.id); continue }
    if ((state.status !== "pending" && state.status !== "ready") ||
      state.current_attempt >= (node.loop?.max_attempts ?? 1) ||
      !node.depends_on.every((id) => reachable.has(id))) continue
    reachable.add(node.id)
    if (!batch || batch.some((member) => member.id === node.id)) candidates.push(node)
  }
  if (!candidates.length) return false
  const reports = preflightShellGates({ ...run.graph, nodes: candidates.map((node) => ({
    ...node, shell_gate: effectiveShellGate(run, node, options),
  })) }, { worktree: options.worktree, directory: options.directory, phase: "execute",
    checkExecutables: !(options.dry || run.mode === "dry" || options.shellRunner),
  })
  for (const report of reports) {
    if (report.diagnostics.length) log(options, `shell gate preflight ${report.node_id}: ${report.diagnostics.slice(0, 8).map((issue) => issue.code).join(", ")}`)
  }
  for (const node of candidates) {
    const previous = gateRecoverySource(run, node)
    if (!previous) continue
    const gate = effectiveShellGate(run, node, options)
    if (options.operation !== "resume") throw new Error("Gate setup failed before launch. Repair the environment, then explicitly resume the existing run; do not replan or rewrite the implementation.")
    if (!gate || !sameRecoveryBasis(run, node, options, previous, gate)) {
      throw new Error("Gate-only recovery refused: saved output, declared files or gate changed, or no bounded recovery basis exists. Inspect retained work before starting an explicit new task.")
    }
  }
  return reports.length > 0
}

function dryOutput(definition: NodeDef, run: RunState): unknown {
  switch (definition.agent) {
    case "explorer":
      return { query: run.goal, map: [{ path: "(dry-run)", role: "stub" }], key_hits: [], next: "researcher" }
    case "researcher":
      return {
        answer: `Dry research for: ${run.goal}`,
        evidence: [],
        constraints: ["dry-run constraint"],
        options: [],
        acceptance_criteria: run.criteria.length ? run.criteria : ["Dry criterion: artifact schema valid"],
        risks: [],
      }
    case "implementer":
      return { summary: [`Dry implement: ${run.goal}`], files_touched: [], commands_run: [], risks: [], done: true }
    case "checker":
      if (definition.verification) return { passed: false, failures: ["Dry execution does not verify evidence"], score: 0,
        findings: effectiveCriteria(run.criteria).map((_, i) => ({ criterion_id: `C${i + 1}`, outcome: "unsupported", evidence_ids: [], reason: "Dry execution supplies no verified observations" })) }
      return { passed: true, failures: [], score: 10, notes: "dry-run auto-pass" }
    case "shell":
      return {
        cmd: definition.shell_gate?.cmd ?? "dry",
        exit_code: 0,
        ok: true,
        stdout_tail: "dry",
        stderr_tail: "",
      }
  }
}

/** Reserves the node's next attempt in memory. The caller commits a whole batch of reservations at once. */
function reserveAttempt(
  run: RunState,
  definition: NodeDef,
): NodeAttempt | null {
  const state = run.nodes[definition.id]!
  const localLimit = definition.loop?.max_attempts ?? 1
  if (state.current_attempt >= localLimit) {
    state.status = state.attempts.at(-1)?.status === "done" ? "pending" : "failed"
    state.last_failures = [`Local attempt limit reached (${localLimit})`]
    return null
  }
  if (run.global_attempts >= run.graph.max_global_attempts) {
    // A reopened node still owns its successful historical attempt. Budget
    // exhaustion blocks rescheduling; it cannot retroactively fail that attempt.
    state.status = state.attempts.at(-1)?.status === "done" ? "pending" : "failed"
    state.last_failures = [`Global attempt limit reached (${run.graph.max_global_attempts})`]
    return null
  }

  const attempt: NodeAttempt = {
    attempt: state.current_attempt + 1,
    status: "running",
    started_at: new Date().toISOString(),
    failures: [],
  }
  state.current_attempt += 1
  state.attempts.push(attempt)
  state.status = "running"
  run.global_attempts += 1
  return attempt
}

type StagedTaskEvidence = { value: TaskEvidence; reference: RunDataReference }

async function runOneNode(
  run: RunState,
  definition: NodeDef,
  options: ExecuteOptions,
  attemptRecord: NodeAttempt | null,
  task?: StagedTaskEvidence,
): Promise<void> {
  const state = run.nodes[definition.id]!
  const localLimit = definition.loop?.max_attempts ?? 1
  const gate = definition.loop?.gate ?? "schema"
  const dry = options.dry || run.mode === "dry"
  const sessionRunner = options.sessionRunner ?? runNodeSession
  const shellRunner = options.shellRunner ?? executeShellGate

  if (!attemptRecord) return
    if (options.toolContext.abort.aborted) throw new Error("Execution cancelled before child launch")
    const attempt = attemptRecord.attempt
    log(options, `node ${definition.id} attempt ${attempt}/${localLimit}`)

    const inputs = wireInputs(definition, run)
    const evidence = definition.agent === "checker"
      ? buildCheckerEvidence(definition, run, graphPolicy(run.graph)?.checkerEvidencePorts?.[definition.id], task) : undefined
    if (definition.verification) {
      attemptRecord.verification_basis = buildVerificationBasis(run.criteria, evidence)
      // Persist the basis before any child/model call, including runners that fail before session creation.
      await save(run, options)
    }
    let sessionId: string | undefined
    let rawOutput: unknown
    let error: string | undefined
    let schemaOk = false
    let shellOk: boolean | undefined
    let setupFailed = false
    const previous = gateRecoverySource(run, definition)
    const recoveryGate = effectiveShellGate(run, definition, options)
    const gateOnly = !dry && definition.agent === "implementer" && previous?.shell_setup_failed === true
    const failures: string[] = []
    const retainedFailures: string[] = []

    if (dry) {
      rawOutput = dryOutput(definition, run)
      sessionId = `dry-${definition.id}-a${attempt}`
    } else if (gateOnly) {
      if (!recoveryGate || !sameRecoveryBasis(run, definition, options, previous, recoveryGate)) {
        throw new Error("Gate-only recovery basis changed after admission")
      }
      rawOutput = previous.output
      attemptRecord.execution_evidence = previous.execution_evidence
    } else if (definition.agent === "shell") {
      const shell = definition.shell_gate!
      const result = await shellRunner({
        cmd: shell.cmd,
        cwd: shell.cwd,
        timeoutMs: shell.timeout_ms,
        context: {
          ask: options.toolContext.ask,
          abort: options.toolContext.abort,
          worktree: options.worktree,
          directory: options.directory,
        },
        metadata: { run_id: run.run_id, node_id: definition.id, attempt },
      })
      rawOutput = {
        cmd: shell.cmd,
        exit_code: result.exit_code,
        ok: result.ok,
        stdout_tail: result.stdout_tail,
        stderr_tail: result.stderr_tail,
        ...(result.timed_out ? { timed_out: true } : {}),
        ...(result.cancelled ? { cancelled: true } : {}),
        ...(result.termination_failed ? { termination_failed: true } : {}),
        ...(result.setup_failed ? { setup_failed: true } : {}),
      }
      shellOk = result.ok
      setupFailed = result.setup_failed === true
      attemptRecord.gate_evidence = fromShellGateEvidence(shell.cmd, result, { run_id: run.run_id, node_id: definition.id, attempt })
      if (!result.ok) {
        const failure = shellFailure(result)
        failures.push(failure)
        retainedFailures.push(failure)
      }
    } else {
      const checker = definition.agent === "checker"
      const previousAttempt = state.attempts.at(-2)
      // Routed checker feedback can replace last_failures. Classify only feedback
      // that still matches this node's durable prior attempt; legacy/routed data
      // receives neutral guidance instead of being guessed from diagnostic text.
      const priorOutcome = previousAttempt &&
        previousAttempt.failures.length === state.last_failures.length &&
        previousAttempt.failures.every((failure, index) => failure === state.last_failures[index])
        ? previousAttempt.outcome : undefined
      const prompt = checker
        ? buildCheckerPrompt({
            taskContract: run.task_contract,
            criteria: run.criteria.length ? run.criteria : ["Output must be complete and match the goal."],
            claimed: inputs.claimed ?? Object.fromEntries(Object.entries(inputs).filter(([key]) => !isCheckerEvidencePort(key))),
            evidence,
            verification: definition.verification,
            priorFailures: state.attempts.at(-2)?.outcome === "substantive_rejection" ? [] : state.last_failures,
            priorOutcome,
          })
        : buildWorkerPrompt({
            goal: run.goal,
            runId: run.run_id,
            criteria: run.criteria,
            agent: definition.agent,
            inputs,
            priorFailures: state.last_failures,
            priorOutcome,
            description: definition.description,
            taskContract: run.task_contract,
          })
      const result = await sessionRunner({
        client: options.client,
        parentSessionId: options.parentSessionId,
        agent: definition.agent,
        title: `${run.run_id}/${definition.id}/a${attempt}`,
        userPrompt: prompt,
        directory: options.directory,
        model: run.model_snapshot[definition.agent],
        abort: options.toolContext.abort,
        disabledTools: options.workerDisabledTools,
        ...(definition.agent === "implementer" ? { execution_evidence_identity: {
          run_id: run.run_id, node_id: definition.id, attempt,
        } } : {}),
        onSessionCreated: async (createdSessionId) => {
          try {
            linkSession(run, options.worktree, definition.id, attempt, createdSessionId)
            options.afterSessionSidecar?.()
            attemptRecord.session_id = createdSessionId
            await save(run, options)
            await options.beforeChildPrompt?.(createdSessionId, checker ? "checker" : "worker", definition)
          } catch (error) { throw new PersistenceBoundaryError(error) }
        },
      })
      sessionId = result.session_id || undefined
      attemptRecord.execution_evidence = result.execution_evidence
      if (sessionId && !attemptRecord.session_id) {
        attemptRecord.session_id = sessionId
        await save(run, options)
        try { linkSession(run, options.worktree, definition.id, attempt, sessionId) }
        catch (error) { throw new PersistenceBoundaryError(error) }
      }
      error = result.error ? safeDiagnosticText(result.error) : undefined
      rawOutput = definition.agent === "implementer"
        ? normalizeFreshResponsePaths(result.parsed)
        : result.parsed
      if (result.response_diagnostic) failures.push(safeDiagnosticText(result.response_diagnostic))
      if (rawOutput === null && result.text) failures.push("Could not parse JSON from agent response")
    }

    if (rawOutput !== null && rawOutput !== undefined) {
      const validation = parseAndValidate(definition.agent, rawOutput)
      if (validation.ok) {
        schemaOk = true
        rawOutput = validation.data
        if (definition.verification && attemptRecord.verification_basis) {
          const bindingFailures = validateVerification(rawOutput, attemptRecord.verification_basis)
          if (bindingFailures.length) { schemaOk = false; failures.push(...bindingFailures) }
        }
        if (definition.agent === "implementer" && rawOutput && typeof rawOutput === "object") {
          const filesTouched = (rawOutput as { files_touched?: unknown }).files_touched
          if (Array.isArray(filesTouched)) {
            for (const filePath of filesTouched) {
              if (typeof filePath !== "string") {
                schemaOk = false
                failures.push("schema: files_touched: code=invalid_type expected=string")
                continue
              }
              try {
                assertProjectFilePathContained(options.worktree, filePath)
              } catch {
                schemaOk = false
                failures.push("schema: files_touched: code=path_not_contained expected=project-relative contained path")
              }
            }
          }
          const artifactPath = (rawOutput as { artifact_path?: unknown }).artifact_path
          if (typeof artifactPath === "string") {
            try {
              assertRunArtifactPathContained(options.worktree, run.run_id, artifactPath)
            } catch {
              schemaOk = false
              failures.push("schema: artifact_path: code=path_not_contained expected=current-run artifact path")
            }
          }
        }
      } else {
        failures.push(...validation.failures.map((failure) => safeDiagnosticText(`schema: ${failure}`)))
      }
    } else if (!error) {
      failures.push("No output produced")
    }
    if (error) failures.push(error)

    const shellDefinition = effectiveShellGate(run, definition, options)
    if (
      !dry &&
      definition.agent !== "shell" &&
      shellDefinition &&
      (gate === "shell" || gate === "all") &&
      schemaOk
    ) {
      const result = await shellRunner({
        cmd: shellDefinition.cmd,
        cwd: shellDefinition.cwd,
        timeoutMs: shellDefinition.timeout_ms,
        context: {
          ask: options.toolContext.ask,
          abort: options.toolContext.abort,
          worktree: options.worktree,
          directory: options.directory,
        },
        metadata: { run_id: run.run_id, node_id: definition.id, attempt },
      })
      shellOk = result.ok
      setupFailed = result.setup_failed === true
      attemptRecord.gate_evidence = fromShellGateEvidence(shellDefinition.cmd, result, { run_id: run.run_id, node_id: definition.id, attempt })
      if (!result.ok) {
        const failure = shellFailure(result)
        failures.push(failure)
        retainedFailures.push(failure)
      }
    }

    if (definition.agent === "checker" && schemaOk) {
      const checker = rawOutput as { passed: boolean; failures: string[] }
      if (!checker.passed) failures.push(...checker.failures.map((failure) => safeDiagnosticText(failure)))
    }
    if (definition.agent === "implementer" && schemaOk) {
      const implementation = rawOutput as { done: boolean; blockers?: string[] }
      if (!implementation.done) {
        failures.push(...(implementation.blockers ?? []).map((blocker) =>
          safeDiagnosticText(`implementer incomplete: ${blocker}`)))
      }
    }

    const shellRequired = definition.agent === "shell" || gate === "shell" || gate === "all"
    if (attemptRecord.preservation_evidence) {
      attemptRecord.preservation_evidence = finishPreservationEvidence(options.worktree, attemptRecord.preservation_evidence)
    }
    const passed = failures.length === 0 && schemaOk && (!shellRequired || dry || shellOk === true)
    const shellGateFailed = shellRequired && !dry && shellOk !== true
    const checkerRejected = definition.agent === "checker" && schemaOk &&
      (rawOutput as { passed?: boolean } | undefined)?.passed === false
    const persistedFailures = boundDiagnosticList(failures, { retain: retainedFailures })
    attemptRecord.status = passed ? "done" : "failed"
    attemptRecord.finished_at = new Date().toISOString()
    attemptRecord.output = schemaOk ? rawOutput : undefined
    attemptRecord.failures = persistedFailures
    attemptRecord.score = schemaOk && definition.agent === "checker" && rawOutput && typeof rawOutput === "object"
      ? (rawOutput as { score?: number }).score
      : undefined
    attemptRecord.shell_ok = shellOk
    if (setupFailed) {
      attemptRecord.shell_setup_failed = true
      if (definition.agent === "implementer" && schemaOk && shellDefinition) {
        attemptRecord.gate_recovery ??= gateRecoveryBasis(options.worktree, options.directory, shellDefinition, rawOutput)
      }
    }
    attemptRecord.schema_ok = schemaOk
    attemptRecord.error = error
    attemptRecord.outcome = passed
      ? "passed"
      : error
        ? "sdk_error"
        : !schemaOk
          ? "schema_invalid"
          : shellGateFailed
            ? "gate_failure"
            : checkerRejected
              ? "substantive_rejection"
            : definition.agent === "implementer" && (rawOutput as { done?: boolean } | undefined)?.done === false
              ? "incomplete"
              : "gate_failure"

    state.output = schemaOk ? rawOutput : undefined
    // A node's outcome is committed as soon as it is known, even inside a batch: a slow sibling must not
    // hold back its durability or its progress update.
    if (passed) {
      state.status = "done"
      state.last_failures = []
      if (definition.agent === "researcher" && !run.criteria_locked && run.criteria.length === 0) {
        const criteria = (rawOutput as { acceptance_criteria: string[] }).acceptance_criteria
        run.criteria = [...criteria]
        run.criteria_locked = true
      }
      await save(run, options)
      log(options, `node ${definition.id} DONE`)
      return
    }

    state.last_failures = persistedFailures
    // One attempt per topological wave keeps retry allocation in graph order,
    // independent of parallel completion speed. Only a schema-valid checker
    // rejection carries substantive feedback and waits for routing; invalid
    // checker output and SDK/gate failures retry the node itself.
    const awaitsFeedbackRouting = definition.agent === "checker" && Boolean(definition.feedback_to) &&
      attemptRecord.outcome === "substantive_rejection"
    state.status = !awaitsFeedbackRouting && state.current_attempt < localLimit ? "pending" : "failed"
    await save(run, options)
    log(options, `node ${definition.id} failed attempt ${attempt}: ${persistedFailures.join("; ")}`)
}

async function applyCheckerFeedback(run: RunState, options: ExecuteOptions): Promise<boolean> {
  for (const checker of run.graph.nodes) {
    if (checker.agent !== "checker" || !checker.feedback_to) continue
    const checkState = run.nodes[checker.id]!
    const last = checkState.attempts.at(-1)
    if (checkState.status !== "failed" || !last || last.feedback_applied) continue
    const substantive = last.outcome === "substantive_rejection" ||
      (last.outcome === undefined && last.schema_ok === true &&
        (last.output as { passed?: unknown } | undefined)?.passed === false)
    if (!substantive) continue

    const targetDefinition = run.graph.nodes.find((node) => node.id === checker.feedback_to)!
    const targetState = run.nodes[targetDefinition.id]!
    const checkerLimit = checker.loop?.max_attempts ?? 1
    const targetLimit = targetDefinition.loop?.max_attempts ?? 1
    const invalidated = descendantsOf(run.graph, targetDefinition.id)
    const exhaustedDescendant = run.graph.nodes.some((node) => invalidated.has(node.id) &&
      run.nodes[node.id]!.current_attempt >= (node.loop?.max_attempts ?? 1))
    if (
      exhaustedDescendant ||
      checkState.current_attempt >= checkerLimit ||
      targetState.current_attempt >= targetLimit ||
      run.graph.max_global_attempts - run.global_attempts < 1 + invalidated.size
    ) {
      last.feedback_applied = true
      await save(run, options)
      continue
    }

    last.feedback_applied = true
    targetState.status = "pending"
    targetState.last_failures = boundDiagnosticList(checkState.last_failures)
    for (const descendantId of invalidated) {
      const definition = run.graph.nodes.find((node) => node.id === descendantId)!
      const state = run.nodes[descendantId]!
      if (state.current_attempt < (definition.loop?.max_attempts ?? 1)) state.status = "pending"
    }
    log(options, `checker ${checker.id} routed feedback to ${targetDefinition.id}`)
    await save(run, options)
    return true
  }
  return false
}

function finishGlobalLimit(run: RunState): void {
  if (run.global_attempts < run.graph.max_global_attempts) return
  for (const definition of run.graph.nodes) {
    const state = run.nodes[definition.id]!
    if ((state.status === "pending" || state.status === "ready") &&
      definition.depends_on.every((dependency) => run.nodes[dependency]?.status === "done")) {
      state.status = state.attempts.at(-1)?.status === "done" ? "pending" : "failed"
      state.last_failures = [`Global attempt limit reached (${run.graph.max_global_attempts})`]
    }
  }
  while (skipFailedDescendants(run)) {
    // Topological order makes one pass sufficient, loop keeps this robust to future ordering changes.
  }
}

export function prepareRunForResume(run: RunState): RunState {
  let reopened = false
  for (const definition of run.graph.nodes) {
    const state = run.nodes[definition.id]!
    const limit = definition.loop?.max_attempts ?? 1
    if (state.status === "running") {
      const last = state.attempts.at(-1)
      if (last?.status === "running") {
        // Normal loading retains the immutable detail reference for explicit
        // full responses. This mutation creates a new attempt generation, so
        // the old reference must remain immutable and must not be rehydrated
        // over the interruption verdict below.
        last.detail_ref = undefined
        last.failures_commitment = undefined
        last.failures_omitted = undefined
        last.failure_texts_truncated = undefined
        last.status = "failed"
        last.finished_at = new Date().toISOString()
        last.failures = boundDiagnosticList([
          ...last.failures,
          "Previous execution ended before the attempt completed",
        ])
        last.schema_ok = false
      }
      state.last_failures = ["Previous execution ended before the attempt completed"]
      state.last_failures_ref = undefined
      state.last_failures_commitment = undefined
      state.last_failures_omitted = undefined
      state.last_failure_texts_truncated = undefined
      state.status = state.current_attempt < limit ? "pending" : "failed"
      if (state.status === "pending") reopened = true
    } else if (state.status === "failed" && state.current_attempt < limit) {
      state.status = "pending"
      reopened = true
    } else if (state.status === "skipped") {
      state.status = "pending"
      reopened = true
    }
  }
  if (reopened) {
    run.status = "blocked"
    run.phase = "blocked"
  }
  return run
}

/**
 * Ends a run its owner will not continue. Every unfinished node is marked failed, or skipped when its
 * last attempt had passed, so the run is failed and is no longer offered for recovery. Nothing that
 * already finished is changed, and no attempt history is removed.
 */
export function closeRun(run: RunState, reason: string): RunState {
  if (run.status === "done" || run.status === "failed") throw new Error(`run ${run.run_id} is already ${run.status}`)
  // An attempt recorded as running belongs to an execution that has ended.
  prepareRunForResume(run)
  const note = boundDiagnosticList([safeDiagnosticText(`Run closed by its owner: ${reason}`)])
  let failed = Object.values(run.nodes).some((state) => state.status === "failed")
  for (const definition of run.graph.nodes) {
    const state = run.nodes[definition.id]!
    if (state.status === "done" || state.status === "failed" || state.status === "skipped") continue
    const passedBefore = state.attempts.at(-1)?.status === "done"
    state.status = passedBefore ? "skipped" : "failed"
    state.last_failures = note
    if (!passedBefore) failed = true
  }
  if (!failed) throw new Error(`run ${run.run_id} has no unfinished node that can be marked failed; resume it instead`)
  run.status = "failed"
  run.phase = "failed"
  run.summary = summarize(run)
  return run
}

function invalidateDriftedTaskCheck(run: RunState): string | undefined {
  const checkId = run.task_contract?.input.verification.checker_node
  if (!checkId || run.nodes[checkId]?.status !== "done") return undefined
  const checker = run.nodes[checkId]!
  const observed = taskEvidence(run)!
  const checked = checker.attempts.at(-1)?.task_evidence_ref
  if (!observed.failures.length && checked?.sha256 === sha256Json(observed)) return undefined
  const reason = "task_evidence_changed: declared evidence changed after the checker snapshot; fresh verification is required"
  for (const id of [checkId, ...descendantsOf(run.graph, checkId)]) {
    const node = run.nodes[id]!
    if (node.status !== "done") continue
    node.status = "pending"
    node.last_failures = [reason]
  }
  return observed.failures.length ? `${reason}\n${observed.failures.join("\n")}` : reason
}

function taskDriftExhausted(run: RunState): boolean {
  const checkId = run.task_contract?.input.verification.checker_node
  if (!checkId || run.nodes[checkId]?.status !== "pending" || run.nodes[checkId]?.attempts.at(-1)?.status !== "done") return false
  const affected = new Set([checkId, ...descendantsOf(run.graph, checkId)])
  const pending = run.graph.nodes.filter(node => affected.has(node.id) && run.nodes[node.id]?.status === "pending")
  return run.global_attempts + pending.length > run.graph.max_global_attempts ||
    pending.some(node => run.nodes[node.id]!.current_attempt >= (node.loop?.max_attempts ?? 1))
}

function reopenTaskPrerequisites(run: RunState): { producers: Set<string>; blocked?: string } {
  const evidence = taskEvidence(run)!
  const input = run.task_contract!.input
  const producers = new Set(evidence.deliverables
    .filter(item => item.status === "unavailable" || item.status === "producer_incomplete")
    .map(item => item.producer_node))
  if (evidence.failures.some(f => f.startsWith("task_baseline_missing") || f.startsWith("task_change_scope_unverified")))
    return { producers: new Set(), blocked: "task_baseline_or_scope_unverified: inspect original evidence and restore declared scope; do not rerun a producer to manufacture before-work proof" }
  if (evidence.execution === "unavailable") producers.add(input.verification.execution_node!)
  for (const id of producers) {
    if (run.nodes[id]?.status !== "done") producers.delete(id)
  }
  if (!producers.size) return { producers }
  try {
    for (const item of input.deliverables) {
      if (item.destination === "project_file" && producers.has(item.producer_node))
        assertProjectFilePathContained(run.project_directory, item.path!)
    }
  } catch {
    return { producers, blocked: "task_prerequisite_path_unavailable: restore project containment before reopening a producer" }
  }
  if (evidence.preservation.some(item => item.status !== "unchanged"))
    return { producers, blocked: "task_preservation_unverified: restore protected evidence before reopening a producer" }

  const affected = new Set([...producers, ...[...producers].flatMap(id => [...descendantsOf(run.graph, id)])])
  if (run.global_attempts + affected.size > run.graph.max_global_attempts ||
    run.graph.nodes.some(node => affected.has(node.id) && run.nodes[node.id]!.current_attempt >= (node.loop?.max_attempts ?? 1))) {
    return { producers, blocked: "task_prerequisite_retry_budget_exhausted: producer repair and fresh verification require remaining local and global attempts" }
  }
  const reason = "Host prerequisite repair: supply the missing declared deliverable or native command evidence within the accepted task contract."
  for (const id of affected) {
    const state = run.nodes[id]!
    state.status = "pending"
    if (producers.has(id)) state.last_failures = [reason, ...evidence.failures]
  }
  return { producers }
}

/** Execute topological waves under one exclusive per-run lease. */
export async function executeRun(run: RunState, options: ExecuteOptions): Promise<RunState> {
  assertTaskState(run)
  if (run.task_contract && options.dry && run.mode === "live")
    throw new Error("task_contract_locked: admitted live runs cannot be converted to dry runs")
  if (run.graph_revisions?.length &&
    (options.shellGateCmd !== undefined || options.shellGateCwd !== undefined ||
      options.shellGateTimeoutMs !== undefined || (options.dry === true && run.mode === "live"))) {
    throw new Error("Revised graph execution cannot override its shell gate or live mode")
  }
  const operation = options.operation ?? "run"
  const filesystemRoot = assertFilesystemRootAuthorized(
    options.worktree,
    options.allowFilesystemRoot,
    operation,
    options.treatProjectAsFilesystemRoot === true,
  )
  // Taking the run lock needs its guard, which another process may hold for an instant.
  const lock = await awaitLock(() => acquireRunLock(options.worktree, run.run_id, options.parentSessionId))
  options.activeLock = lock
  let releaseShellRuntime: (() => void) | undefined
  try {
    if (run.owner_session_id !== options.parentSessionId) {
      throw new Error(`session does not own run ${run.run_id}`)
    }
    if (assertManagedGraph(run) && !options.beforeBatch)
      throw new Error("managed investigation requires a reconciliation guard before attempt reservation")
    const hydrated = hydrateRunForExecution(run)
    // Preserve the caller-visible RunState object identity used by existing
    // integrations while replacing its nested state with safely hydrated data.
    Object.assign(run, hydrated)
    if (run.task_allowance) {
      if (!options.taskAllowance) throw new Error("task_allowance_unavailable: bound tasks require their durable dispatch controller")
      await options.taskAllowance.attach(run.owner_session_id, run.task_allowance, options.toolContext.abort)
    }
    run.execution_directory = canonicalContainedDirectory(options.worktree,
      run.execution_directory ?? run.project_directory)
    options.directory = run.execution_directory
    const committedPhase = await awaitLock(() => assertAdmittedGateExecution(run, options))
    const liveTask = !options.dry && run.mode !== "dry" && !!run.task_contract
    if (liveTask && run.task_contract!.input.evidence_plan && !run.task_baseline) {
      // This is before every child, including discovery workers. Planning itself remains read-only.
      if (run.global_attempts > 0) {
        run.status = "blocked"
        run.phase = "task-baseline"
        run.summary = "task_baseline_missing: prior work exists; a late snapshot cannot establish the original state"
        await save(run, options)
        return run
      }
      try { run.task_baseline = captureTaskBaseline(run.project_directory, run.task_contract!) }
      catch {
        run.status = "blocked"
        run.phase = "task-baseline"
        run.summary = "task_baseline_unavailable: required bounded before-work observations could not be collected; no child was dispatched"
        await save(run, options)
        return run
      }
      await save(run, options) // Separate durable boundary: the following reservation cannot precede this commit.
    }
    const initialDrift = liveTask ? invalidateDriftedTaskCheck(run) : undefined
    if (initialDrift || (liveTask && taskDriftExhausted(run))) {
      run.status = "blocked"
      run.phase = "task-evidence"
      run.summary = capCompleteSummary(initialDrift ?? "task_evidence_retry_budget_exhausted: fresh verification requires remaining local and global attempts")
      await save(run, options)
      return run
    }
    const repair = liveTask && operation === "resume" && (committedPhase === "task-prerequisite" || committedPhase === "task-evidence")
      ? reopenTaskPrerequisites(run) : undefined
    if (repair?.blocked) {
      run.status = "blocked"
      run.phase = "task-prerequisite"
      run.summary = repair.blocked
      await save(run, options)
      return run
    }
    // Validate every reachable executable gate before reserving any model work.
    // Errors leave the committed plan/history/counters untouched so the caller can
    // correct the gate and resume. Dry/injected runners still receive structural checks.
    const hasGates = preflightExecutableNodes(run, options)
    if (hasGates && !options.dry && run.mode !== "dry" && (!options.shellRunner || options.shellPreparer)) {
      const prepared = await (options.shellPreparer ?? prepareShellRuntime)({ signal: options.toolContext.abort })
      releaseShellRuntime = prepared.release
      if (!prepared.ok) throw new Error(safeDiagnosticText(`Shell runtime setup failed before reserving model work: ${prepared.stderr_tail || prepared.stdout_tail}`))
    }
    if (filesystemRoot) {
      ;(run.filesystem_root_authorizations ??= []).push({
        operation,
        by_session_id: options.parentSessionId,
        authorized_at: new Date().toISOString(),
        authorized: true,
        path: run.project_directory,
      })
    }
    lock.assertHeld()
    run.status = "running"
    run.phase = "execute"
    if (options.dry) run.mode = "dry"
    await save(run, options)

    const maxWaves = Math.max(1, Math.min(options.maxWaves ?? 128, 1_000))
    // An infrastructure failure stops this node for this invocation, without
    // burning its remaining attempts or preventing independent siblings.
    const setupStopped = new Set<string>()
    const concurrency = Math.max(
      1,
      Math.min(options.maxConcurrency ?? run.graph.max_concurrency, run.graph.max_concurrency, 8),
    )

    let completedWaves = 0
    for (let wave = 0; wave < maxWaves && !allTerminal(run); wave++) {
      if (options.toolContext.abort.aborted) {
        break
      }
      while (skipFailedDescendants(run)) {
        // deterministic terminal propagation
      }
      if (allTerminal(run)) break

      const ready = readyNodes(run).filter(node => !setupStopped.has(node.id))
      if (ready.length === 0) break
      log(options, `wave ${wave + 1}: ${ready.map((node) => node.id).join(", ")}`)

      for (let offset = 0; offset < ready.length; offset += concurrency) {
        if (options.toolContext.abort.aborted) break
        const batch = ready.slice(offset, offset + concurrency)
        let preservation: Array<NodeAttempt["preservation_evidence"]> = []
        let task: StagedTaskEvidence | undefined
        let taskPrerequisiteBlocked = false
        const taskChecker = liveTask ? batch.find(node => node.id === run.task_contract?.input.verification.checker_node) : undefined
        try {
          // Earlier workers may change the environment, or checker feedback may
          // reopen a node that was done at startup. Recheck before reserving it.
          preflightExecutableNodes(run, options, batch)
          await options.beforeBatch?.(run, batch)
          if (taskChecker) {
            const value = taskEvidence(run)!
            if (value.failures.length) {
              taskPrerequisiteBlocked = true
              throw new Error(value.failures.join("; ") + "; restore the evidence or explicitly resume bounded producer repair")
            }
            const current = run.nodes[taskChecker.id]!.current_attempt
            if (current < (taskChecker.loop?.max_attempts ?? 1) && run.global_attempts < run.graph.max_global_attempts)
              task = { value, reference: writeTaskEvidence(run, taskChecker.id, current + 1, value) }
          }
          preservation = batch.map(definition => {
            if (definition.agent !== "implementer" || options.dry || run.mode === "dry") return undefined
            const prior = run.nodes[definition.id]!.attempts.at(-1)
            const paths = wireInputs(definition, run).preserve_paths
            if (prior?.preservation_evidence && JSON.stringify(prior.preservation_evidence.files.map(file => file.path)) !== JSON.stringify(paths)) {
              throw new Error("Preservation path set changed after its original basis was captured")
            }
            return (paths === undefined ? undefined : run.task_baseline?.preservation) ?? prior?.preservation_evidence
              ?? capturePreservationBasis(options.worktree, paths)
          })
        } catch (error) {
          run.status = "blocked"
          run.phase = taskPrerequisiteBlocked ? "task-prerequisite" : "blocked"
          run.summary = capCompleteSummary(summarize(run) + "\nAdmission blocked: " + safeDiagnosticText(error instanceof Error ? error.message : "admission unavailable"))
          await save(run, options)
          throw error
        }
        if (batch.some((definition) => definition.verification) && !run.criteria_locked) {
          // A researcher in this or a later wave cannot replace the criteria
          // after a checker has committed its pre-call verification basis.
          run.criteria = [...effectiveCriteria(run.criteria)]
          run.criteria_locked = true
        }
        // Charge prospective child dispatches under the root checkpoint lock first.
        // A crash between this commit and the run commit leaves conservative charged
        // reservations. Gate-only recovery and dry execution launch no model child.
        if (run.task_allowance && !options.dry && run.mode !== "dry") {
          let available = run.graph.max_global_attempts - run.global_attempts
          const dispatches: Array<{ node: NodeDef; attempt: number }> = []
          for (const definition of batch) {
            const state = run.nodes[definition.id]!
            if (state.current_attempt >= (definition.loop?.max_attempts ?? 1) || available <= 0) continue
            available--
            if (definition.agent !== "shell" && !gateRecoverySource(run, definition)) dispatches.push({ node: definition, attempt: state.current_attempt + 1 })
          }
          try { await options.taskAllowance!.reserve(run, dispatches, options.toolContext.abort) }
          catch (error) {
            run.status = "blocked"
            run.phase = "task-allowance"
            run.summary = capCompleteSummary(safeDiagnosticText(error instanceof Error ? error.message : "task allowance unavailable"))
            await save(run, options)
            return run
          }
        }
        // Explicit preservation paths are hashed before reserving any model work;
        // missing/oversized/non-contained files block admission without spending an attempt.
        const reservations = batch.map((definition, index) => {
          const recovery = gateRecoverySource(run, definition)
          const attempt = reserveAttempt(run, definition)
          if (attempt && preservation[index]) attempt.preservation_evidence = preservation[index]
          if (attempt && task && definition.id === taskChecker?.id) attempt.task_evidence_ref = task.reference
          if (attempt && recovery) {
            attempt.reused_output_from = recovery.attempt
            attempt.gate_recovery = recovery.gate_recovery
            attempt.execution_evidence = recovery.execution_evidence
          }
          return attempt
        })
        // Persist every bounded-batch reservation before any child sidecar can
        // be created, preserving the sidecar -> child-id progress crash fence.
        await save(run, options)
        const settled = await Promise.allSettled(batch.map((definition, index) =>
          runOneNode(run, definition, options, reservations[index]!, definition.id === taskChecker?.id ? task : undefined)))
        settled.forEach((result, i) => {
          if (result.status === "fulfilled") return
          if (result.reason instanceof PersistenceBoundaryError) throw result.reason
          const state = run.nodes[batch[i]!.id]!
          const last = state.attempts.at(-1)
          if (last?.status !== "running") throw result.reason
          const diagnostic = formatSdkDiagnostic("Executor error: ", result.reason)
          state.status = "failed"
          state.last_failures = boundDiagnosticList([diagnostic], { retain: [diagnostic] })
          if (last?.status === "running") {
            last.status = "failed"
            last.finished_at = new Date().toISOString()
            last.failures = boundDiagnosticList([...last.failures, diagnostic], { retain: [diagnostic] })
            last.schema_ok = false
            last.error = diagnostic
            last.outcome = "sdk_error"
            if (state.current_attempt < (batch[i]!.loop?.max_attempts ?? 1)) state.status = "pending"
          } else {
            // An unexpected post-outcome exception is not a new worker failure.
            throw result.reason
          }
        })
        // Each node committed its own outcome. This save only has work to do
        // when an executor error was recorded above; an unchanged run is skipped.
        await save(run, options)
        for (const definition of batch) {
          const last = run.nodes[definition.id]!.attempts.at(-1)
          if ((repair?.producers.has(definition.id) && last?.status !== "done") ||
            last?.shell_setup_failed || (last?.reused_output_from !== undefined &&
            (last.outcome === "sdk_error" || (!!run.task_contract && !!options.shellGateCmd && last.status !== "done")))) setupStopped.add(definition.id)
        }
      }

      await applyCheckerFeedback(run, options)
      const waveDrift = liveTask ? invalidateDriftedTaskCheck(run) : undefined
      if (waveDrift) {
        run.status = "blocked"
        run.phase = "task-evidence"
        run.summary = capCompleteSummary(waveDrift)
        await save(run, options)
        return run
      }
      finishGlobalLimit(run)
      await save(run, options)
      completedWaves++
      if (run.global_attempts >= run.graph.max_global_attempts) break
    }

    while (skipFailedDescendants(run)) {
      // finish descendants rather than leaving a blocked run
    }
    finishGlobalLimit(run)
    if (allTerminal(run)) {
      run.status = anyFailed(run) ? "failed" : "done"
      run.phase = run.status
    } else {
      run.status = "blocked"
      // A synchronous call boundary is not a missing prerequisite. Only mark a
      // normal, actionable pause; cancellation, setup and uncertain SDK outcomes
      // retain the conservative blocker path. Resume still reruns every guard.
      const waveLimit = completedWaves === maxWaves && !options.toolContext.abort.aborted &&
        setupStopped.size === 0 && run.global_attempts < run.graph.max_global_attempts &&
        readyNodes(run).some(node => run.nodes[node.id]!.current_attempt < (node.loop?.max_attempts ?? 1)) &&
        !Object.values(run.nodes).some(node => (node.status === "pending" || node.status === "ready") &&
          node.attempts.at(-1)?.outcome === "sdk_error")
      run.phase = waveLimit ? "wave-limit" : "blocked"
    }
    run.summary = summarize(run)
    const finalDrift = liveTask && run.status !== "failed" ? invalidateDriftedTaskCheck(run) : undefined
    if (finalDrift) {
      run.status = "blocked"
      run.phase = "task-evidence"
      run.summary = capCompleteSummary(finalDrift)
    }
    await save(run, options)
    return run
  } finally {
    releaseShellRuntime?.()
    options.activeLock = undefined
    lock.release()
  }
}

export function summarize(run: RunState): string {
  const goal = boundedSummaryText(run.goal, MAX_SUMMARY_GOAL_SIZE)
  const allNodes = Object.values(run.nodes)
  const nodes = allNodes.slice(0, MAX_SUMMARY_NODES)
  const lines = [
    `run ${run.run_id} — ${run.status}`,
    `goal: ${goal.text}`,
    `mode: ${run.mode}`,
    `global attempts: ${run.global_attempts}/${run.graph.max_global_attempts}`,
    "nodes:",
    ...nodes.map((node) => {
      const bounded = boundedSummaryFailures(node.last_failures)
      return `  - ${node.id} [${node.agent}] ${node.status} attempts=${node.current_attempt}` +
        (bounded.values.length ? ` failures=${JSON.stringify(bounded.values)}` : "") +
        (bounded.omittedEntries ? ` failure_entries_omitted=${bounded.omittedEntries}` : "") +
        (bounded.truncatedTexts ? ` failure_texts_truncated=${bounded.truncatedTexts}` : "")
    }),
  ]
  if (allNodes.length > nodes.length) {
    lines.push(`  - [truncated] ${allNodes.length - nodes.length} additional nodes omitted`)
  }
  return capCompleteSummary(lines.join("\n"))
}

function codePointSafePrefix(value: string, maximumCharacters: number): string {
  let prefix = value.slice(0, Math.max(0, maximumCharacters))
  const final = prefix.charCodeAt(prefix.length - 1)
  if (final >= 0xD800 && final <= 0xDBFF) prefix = prefix.slice(0, -1)
  return prefix
}

function boundedSummaryText(value: string, maximum: number): {
  text: string
  truncated: boolean
  omittedChars: number
  omittedBytes: number
} {
  const bytes = utf8Bytes(value)
  if (value.length <= maximum && bytes <= maximum) {
    return { text: value, truncated: false, omittedChars: 0, omittedBytes: 0 }
  }
  // Fixed reserve makes the count-bearing suffix deterministic without a
  // circular suffix-length calculation.
  const reserve = 96
  let prefix = codePointSafePrefix(value, maximum - reserve)
  prefix = codePointSafePrefix(truncateUtf8(prefix, maximum - reserve), prefix.length)
  const prefixBytes = utf8Bytes(prefix)
  const omittedChars = value.length - prefix.length
  const omittedBytes = bytes - prefixBytes
  return {
    text: `${prefix}…[${omittedChars} chars/${omittedBytes} UTF-8 bytes omitted]`,
    truncated: true,
    omittedChars,
    omittedBytes,
  }
}

function boundedSummaryFailures(failures: readonly string[]): {
  values: string[]
  omittedEntries: number
  truncatedTexts: number
} {
  if (!failures.length) return { values: [], omittedEntries: 0, truncatedTexts: 0 }
  const actualCount = failures.length > MAX_SUMMARY_FAILURE_ENTRIES
    ? MAX_SUMMARY_FAILURE_ENTRIES - 1
    : failures.length
  const selected = failures.slice(0, actualCount).map((failure) =>
    boundedSummaryText(failure, MAX_SUMMARY_FAILURE_SIZE))
  const omittedEntries = failures.length - selected.length
  const values = selected.map((failure) => failure.text)
  if (omittedEntries > 0) values.push(`[truncated] ${omittedEntries} additional failure entries omitted`)
  return {
    values,
    omittedEntries,
    truncatedTexts: selected.filter((failure) => failure.truncated).length,
  }
}

function capCompleteSummary(summary: string): string {
  const bytes = utf8Bytes(summary)
  if (summary.length <= MAX_RUN_SUMMARY_CHARS && bytes <= MAX_RUN_SUMMARY_BYTES) return summary

  const reserve = 192
  let prefix = codePointSafePrefix(summary, MAX_RUN_SUMMARY_CHARS - reserve)
  prefix = codePointSafePrefix(
    truncateUtf8(prefix, MAX_RUN_SUMMARY_BYTES - reserve),
    prefix.length,
  )
  const omittedChars = summary.length - prefix.length
  const omittedBytes = bytes - utf8Bytes(prefix)
  return `${prefix}\n[truncated] ${omittedChars} summary chars/${omittedBytes} UTF-8 bytes omitted`
}

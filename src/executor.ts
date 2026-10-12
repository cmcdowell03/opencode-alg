import type { ToolContext } from "@opencode-ai/plugin"
import type { NodeAttempt, NodeDef, RunState, ShellGateDef } from "./types.ts"
import { assertFilesystemRootAuthorized, canonicalContainedDirectory } from "./paths.ts"
import {
  allTerminal,
  anyFailed,
  descendantsOf,
  readyNodes,
  skipFailedDescendants,
  wireInputs,
} from "./graph.ts"
import { parseAndValidate } from "./schemas.ts"
import {
  acquireRunLock,
  assertProjectFilePathContained,
  assertRunArtifactPathContained,
  hydrateRunForExecution,
  linkSession,
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
  type ShellExecutionContext,
  type ShellExecutionResult,
} from "./shell.ts"
import {
  boundDiagnosticList,
  formatSdkDiagnostic,
  safeDiagnosticText,
} from "./diagnostics.ts"
import { truncateUtf8, utf8Bytes } from "./limits.ts"

export const MAX_RUN_SUMMARY_CHARS = 40_000
const MAX_RUN_SUMMARY_BYTES = 40_000
const MAX_SUMMARY_GOAL_SIZE = 2_000
const MAX_SUMMARY_NODES = 64
const MAX_SUMMARY_FAILURE_ENTRIES = 2
const MAX_SUMMARY_FAILURE_SIZE = 256

export interface ExecuteOptions {
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
  /** Test-only fault barrier after atomic sidecar write and before progress fencing. */
  afterSessionSidecar?: () => void
  /** Scoped procedure handoff must succeed before the child prompt is sent. */
  beforeChildPrompt?: (child: string, role: "worker" | "checker") => Promise<void>
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

function shellFailure(exitCode: number, stderr: string): string {
  return safeDiagnosticText(`shell gate failed (exit ${exitCode}): ${stderr.slice(-500)}`)
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
    state.status = "failed"
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

async function runOneNode(
  run: RunState,
  definition: NodeDef,
  options: ExecuteOptions,
  attemptRecord: NodeAttempt | null,
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
    let sessionId: string | undefined
    let rawOutput: unknown
    let error: string | undefined
    let schemaOk = false
    let shellOk: boolean | undefined
    const failures: string[] = []
    const retainedFailures: string[] = []

    if (dry) {
      rawOutput = dryOutput(definition, run)
      sessionId = `dry-${definition.id}-a${attempt}`
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
      }
      shellOk = result.ok
      if (!result.ok) {
        const failure = shellFailure(result.exit_code, result.stderr_tail)
        failures.push(failure)
        retainedFailures.push(failure)
      }
    } else {
      const checker = definition.agent === "checker"
      const prompt = checker
        ? buildCheckerPrompt({
            criteria: run.criteria.length ? run.criteria : ["Output must be complete and match the goal."],
            claimed: inputs.claimed ?? inputs,
            priorFailures: state.attempts.at(-2)?.outcome === "substantive_rejection" ? [] : state.last_failures,
          })
        : buildWorkerPrompt({
            goal: run.goal,
            runId: run.run_id,
            criteria: run.criteria,
            agent: definition.agent,
            inputs,
            priorFailures: state.last_failures,
            description: definition.description,
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
        onSessionCreated: async (createdSessionId) => {
          try {
            linkSession(run, options.worktree, definition.id, attempt, createdSessionId)
            options.afterSessionSidecar?.()
            attemptRecord.session_id = createdSessionId
            await save(run, options)
            await options.beforeChildPrompt?.(createdSessionId, checker ? "checker" : "worker")
          } catch (error) { throw new PersistenceBoundaryError(error) }
        },
      })
      sessionId = result.session_id || undefined
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

    const shellDefinition: ShellGateDef | undefined =
      definition.agent === "implementer" && options.shellGateCmd
        ? {
            ...definition.shell_gate,
            cmd: options.shellGateCmd,
            ...(options.shellGateTimeoutMs !== undefined
              ? { timeout_ms: options.shellGateTimeoutMs }
              : {}),
          }
        : definition.shell_gate
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
      if (!result.ok) {
        const failure = shellFailure(result.exit_code, result.stderr_tail)
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
      if (definition.agent === "researcher" && run.criteria.length === 0) {
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
        last.status = "failed"
        last.finished_at = new Date().toISOString()
        last.failures = boundDiagnosticList([
          ...last.failures,
          "Previous execution ended before the attempt completed",
        ])
        last.schema_ok = false
      }
      state.last_failures = ["Previous execution ended before the attempt completed"]
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

/** Execute topological waves under one exclusive per-run lease. */
export async function executeRun(run: RunState, options: ExecuteOptions): Promise<RunState> {
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
  try {
    if (run.owner_session_id !== options.parentSessionId) {
      throw new Error(`session does not own run ${run.run_id}`)
    }
    const hydrated = hydrateRunForExecution(run)
    // Preserve the caller-visible RunState object identity used by existing
    // integrations while replacing its nested state with safely hydrated data.
    Object.assign(run, hydrated)
    run.execution_directory = canonicalContainedDirectory(options.worktree,
      run.execution_directory ?? run.project_directory)
    options.directory = run.execution_directory
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
    const concurrency = Math.max(
      1,
      Math.min(options.maxConcurrency ?? run.graph.max_concurrency, run.graph.max_concurrency, 8),
    )

    for (let wave = 0; wave < maxWaves && !allTerminal(run); wave++) {
      if (options.toolContext.abort.aborted) {
        break
      }
      while (skipFailedDescendants(run)) {
        // deterministic terminal propagation
      }
      if (allTerminal(run)) break

      const ready = readyNodes(run)
      if (ready.length === 0) break
      log(options, `wave ${wave + 1}: ${ready.map((node) => node.id).join(", ")}`)

      for (let offset = 0; offset < ready.length; offset += concurrency) {
        if (options.toolContext.abort.aborted) break
        const batch = ready.slice(offset, offset + concurrency)
        const reservations = batch.map((definition) => reserveAttempt(run, definition))
        // Persist every bounded-batch reservation before any child sidecar can
        // be created, preserving the sidecar -> child-id progress crash fence.
        await save(run, options)
        const settled = await Promise.allSettled(batch.map((definition, index) =>
          runOneNode(run, definition, options, reservations[index]!)))
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
      }

      await applyCheckerFeedback(run, options)
      finishGlobalLimit(run)
      await save(run, options)
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
      run.phase = "blocked"
    }
    run.summary = summarize(run)
    await save(run, options)
    return run
  } finally {
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

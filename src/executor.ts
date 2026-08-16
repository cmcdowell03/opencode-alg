import type { ToolContext } from "@opencode-ai/plugin"
import type { NodeAttempt, NodeDef, RunState, ShellGateDef } from "./types.ts"
import { assertFilesystemRootAuthorized } from "./paths.ts"
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
import {
  buildCheckerPrompt,
  buildWorkerPrompt,
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
  allowFilesystemRoot?: boolean
  /** Additive test/path-policy seam; cannot disable actual-root detection. */
  treatProjectAsFilesystemRoot?: boolean
  operation?: "run" | "resume"
  /** Internal active lease; callers must not supply this. */
  activeLock?: RunLock
  /** Internal batch durability: one fenced save follows each settled batch. */
  deferPersistence?: boolean
}

function log(options: ExecuteOptions, message: string): void {
  options.onEvent?.(message)
}

function save(run: RunState, options: ExecuteOptions): void {
  if (options.deferPersistence) return
  if (!options.activeLock) throw new Error("execution save requires an active fenced run lock")
  persistRunFenced(run, options.worktree, options.activeLock)
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

function reserveAttempt(
  run: RunState,
  definition: NodeDef,
  options: ExecuteOptions,
): NodeAttempt | null {
  const state = run.nodes[definition.id]!
  const localLimit = definition.loop?.max_attempts ?? 1
  if (state.current_attempt >= localLimit) {
    state.status = "failed"
    state.last_failures = [`Local attempt limit reached (${localLimit})`]
    save(run, options)
    return null
  }
  if (run.global_attempts >= run.graph.max_global_attempts) {
    state.status = "failed"
    state.last_failures = [`Global attempt limit reached (${run.graph.max_global_attempts})`]
    save(run, options)
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
  save(run, options)
  return attempt
}

async function runOneNode(
  run: RunState,
  definition: NodeDef,
  options: ExecuteOptions,
  reservedAttempt?: NodeAttempt | null,
): Promise<void> {
  const state = run.nodes[definition.id]!
  const localLimit = definition.loop?.max_attempts ?? 1
  const gate = definition.loop?.gate ?? "schema"
  const dry = options.dry || run.mode === "dry"
  const sessionRunner = options.sessionRunner ?? runNodeSession
  const shellRunner = options.shellRunner ?? executeShellGate

  const attemptRecord = reservedAttempt === undefined
    ? reserveAttempt(run, definition, options)
    : reservedAttempt
  if (!attemptRecord) return
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
          })
        : buildWorkerPrompt({
            goal: run.goal,
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
        onSessionCreated: async (createdSessionId) => {
          linkSession(run, options.worktree, definition.id, attempt, createdSessionId)
          options.afterSessionSidecar?.()
          attemptRecord.session_id = createdSessionId
          save(run, { ...options, deferPersistence: false })
        },
      })
      sessionId = result.session_id || undefined
      if (sessionId && !attemptRecord.session_id) {
        attemptRecord.session_id = sessionId
        save(run, { ...options, deferPersistence: false })
        linkSession(run, options.worktree, definition.id, attempt, sessionId)
      }
      error = result.error ? safeDiagnosticText(result.error) : undefined
      rawOutput = result.parsed
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
              try {
                assertProjectFilePathContained(options.worktree, String(filePath))
              } catch (error) {
                schemaOk = false
                failures.push(safeDiagnosticText(`schema: ${error instanceof Error ? error.message : String(error)}`))
              }
            }
          }
          const artifactPath = (rawOutput as { artifact_path?: unknown }).artifact_path
          if (typeof artifactPath === "string") {
            try {
              assertRunArtifactPathContained(options.worktree, run.run_id, artifactPath)
            } catch (error) {
              schemaOk = false
              failures.push(safeDiagnosticText(`schema: ${error instanceof Error ? error.message : String(error)}`))
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
    if (passed) {
      state.status = "done"
      state.last_failures = []
      if (definition.agent === "researcher" && run.criteria.length === 0) {
        const criteria = (rawOutput as { acceptance_criteria: string[] }).acceptance_criteria
        run.criteria = [...criteria]
        run.criteria_locked = true
      }
      save(run, options)
      log(options, `node ${definition.id} DONE`)
      return
    }

    state.status = "failed"
    state.last_failures = persistedFailures
    save(run, options)
    log(options, `node ${definition.id} failed attempt ${attempt}: ${persistedFailures.join("; ")}`)

    // One attempt per topological wave keeps retry allocation in graph order,
    // independent of parallel completion speed.
    if (definition.agent === "checker" && definition.feedback_to) {
      // Only a schema-valid rejection carries substantive feedback. Invalid
      // checker output and SDK/gate failures retry this checker itself.
      if (attemptRecord.outcome !== "substantive_rejection" && state.current_attempt < localLimit) {
        state.status = "pending"
        save(run, options)
      }
      return
    }
    if (state.current_attempt < localLimit) {
      state.status = "pending"
      save(run, options)
    }
}

function applyCheckerFeedback(run: RunState, options: ExecuteOptions): boolean {
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
    if (
      checkState.current_attempt >= checkerLimit ||
      targetState.current_attempt >= targetLimit ||
      run.global_attempts >= run.graph.max_global_attempts
    ) {
      last.feedback_applied = true
      save(run, options)
      continue
    }

    last.feedback_applied = true
    targetState.status = "pending"
    targetState.last_failures = boundDiagnosticList(checkState.last_failures)
    for (const descendantId of descendantsOf(run.graph, targetDefinition.id)) {
      const definition = run.graph.nodes.find((node) => node.id === descendantId)!
      const state = run.nodes[descendantId]!
      if (state.current_attempt < (definition.loop?.max_attempts ?? 1)) state.status = "pending"
    }
    log(options, `checker ${checker.id} routed feedback to ${targetDefinition.id}`)
    save(run, options)
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
      state.status = "failed"
      state.last_failures = [`Global attempt limit reached (${run.graph.max_global_attempts})`]
    }
  }
  while (skipFailedDescendants(run)) {
    // Topological order makes one pass sufficient, loop keeps this robust to future ordering changes.
  }
}

function failPendingOnCancellation(run: RunState): void {
  for (const definition of run.graph.nodes) {
    const state = run.nodes[definition.id]!
    if (state.status === "pending" || state.status === "ready") {
      state.status = "failed"
      state.last_failures = ["Execution cancelled"]
    }
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
  const lock = acquireRunLock(options.worktree, run.run_id, options.parentSessionId)
  options.activeLock = lock
  try {
    if (run.owner_session_id !== options.parentSessionId) {
      throw new Error(`session does not own run ${run.run_id}`)
    }
    const hydrated = hydrateRunForExecution(run)
    // Preserve the caller-visible RunState object identity used by existing
    // integrations while replacing its nested state with safely hydrated data.
    Object.assign(run, hydrated)
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
    save(run, options)

    const maxWaves = Math.max(1, Math.min(options.maxWaves ?? 128, 1_000))
    const concurrency = Math.max(
      1,
      Math.min(options.maxConcurrency ?? run.graph.max_concurrency, run.graph.max_concurrency, 8),
    )

    for (let wave = 0; wave < maxWaves && !allTerminal(run); wave++) {
      if (options.toolContext.abort.aborted) {
        failPendingOnCancellation(run)
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
        const batch = ready.slice(offset, offset + concurrency)
        const batchOptions = { ...options, deferPersistence: true }
        const reservations = batch.map((definition) => reserveAttempt(run, definition, batchOptions))
        // Persist every bounded-batch reservation before any child sidecar can
        // be created, preserving the sidecar -> child-id progress crash fence.
        save(run, options)
        const settled = await Promise.allSettled(batch.map((definition, index) =>
          runOneNode(run, definition, batchOptions, reservations[index])))
        settled.forEach((result, i) => {
          if (result.status === "fulfilled") return
          const state = run.nodes[batch[i]!.id]!
          const diagnostic = formatSdkDiagnostic("Executor error: ", result.reason)
          state.status = "failed"
          state.last_failures = boundDiagnosticList([diagnostic], { retain: [diagnostic] })
          const last = state.attempts.at(-1)
          if (last?.status === "running") {
            last.status = "failed"
            last.finished_at = new Date().toISOString()
            last.failures = boundDiagnosticList([...last.failures, diagnostic], { retain: [diagnostic] })
            last.schema_ok = false
          }
        })
        // The next batch's pre-child reservation fence also commits this
        // batch's settled outcomes. Persist explicitly only for the final
        // batch, avoiding a redundant whole-manifest verification between two
        // adjacent fences while retaining one durable fence after each batch.
        if (offset + concurrency >= ready.length) save(run, options)
      }

      applyCheckerFeedback(run, options)
      finishGlobalLimit(run)
      save(run, options)
    }

    while (skipFailedDescendants(run)) {
      // finish descendants rather than leaving a blocked run
    }
    finishGlobalLimit(run)
    if (allTerminal(run)) {
      run.status = anyFailed(run) ? "failed" : "done"
      run.phase = run.status
    } else if (anyFailed(run)) {
      // Defensive: no failed dependency may leave the run merely blocked.
      while (skipFailedDescendants(run)) {}
      run.status = "failed"
      run.phase = "failed"
    } else {
      run.status = "blocked"
      run.phase = "blocked"
    }
    run.summary = summarize(run)
    save(run, options)
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

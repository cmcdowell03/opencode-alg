/**
 * Offline smoke test — graph validate + dry execute (no OpenCode server).
 * Run: bun run scripts/smoke.ts
 */
import { validateGraph } from "../src/graph.ts"
import { getTemplate, listTemplates } from "../src/templates.ts"
import { parseAndValidate } from "../src/schemas.ts"
import { createRun, loadRun } from "../src/store.ts"
import { executeRun } from "../src/executor.ts"
import { extractJson } from "../src/sessions.ts"
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import { basename, dirname, join, resolve } from "node:path"
import { tmpdir } from "node:os"

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg)
}

const SMOKE_TEMPORARY_PREFIX = "alg-smoke-"
const SMOKE_CLEANUP_TIMEOUT_MS = 10_000
const SMOKE_CLEANUP_RETRY_DELAY_MS = 100
const RETRYABLE_CLEANUP_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"])

interface SmokeTemporaryProjectRemoval {
  removed: boolean
  error?: string
}

interface SmokeTemporaryProject {
  path: string
  initialization_error?: unknown
  remove(): Promise<SmokeTemporaryProjectRemoval>
}

export interface SmokeRunOptions {
  log?: (...values: unknown[]) => void
  afterVerification?: () => void | Promise<void>
  onTemporaryProjectRemoved?: (canonicalPath: string) => void | Promise<void>
}

export interface SmokeRunResult {
  temporary_project: string
  temporary_project_removed: true
}

function normalizedPath(path: string): string {
  const normalized = resolve(path)
  return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 1_000)
}

function isExactSmokeChild(tempRoot: string, candidate: string): boolean {
  const name = basename(candidate)
  return normalizedPath(dirname(candidate)) === normalizedPath(tempRoot) &&
    name.startsWith(SMOKE_TEMPORARY_PREFIX) && name.length > SMOKE_TEMPORARY_PREFIX.length
}

function smokeProjectExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") return false
    throw error
  }
}

/**
 * Return a cleanup closure bound to the exact canonical directory created by
 * this invocation. No caller-supplied path can reach the recursive remover.
 */
function createSmokeTemporaryProject(): SmokeTemporaryProject {
  const canonicalTempRoot = realpathSync.native(resolve(tmpdir()))
  const created = mkdtempSync(join(canonicalTempRoot, SMOKE_TEMPORARY_PREFIX))
  let canonicalProject = resolve(created)
  let initializationError: unknown
  try {
    const resolvedProject = realpathSync.native(created)
    if (!isExactSmokeChild(canonicalTempRoot, resolvedProject)) {
      throw new Error("created smoke project is not an exact direct child of the canonical temporary root")
    }
    canonicalProject = resolvedProject
  } catch (error) {
    // Return the bound handle even when canonicalization fails so runSmoke's
    // finally path still performs bounded cleanup of mkdtemp's exact result.
    initializationError = error
  }

  return {
    path: canonicalProject,
    ...(initializationError === undefined ? {} : { initialization_error: initializationError }),
    remove: async () => {
      const deadline = Date.now() + SMOKE_CLEANUP_TIMEOUT_MS
      while (true) {
        try {
          if (!isExactSmokeChild(canonicalTempRoot, canonicalProject)) {
            throw new Error("smoke cleanup target is not the exact created temporary-root child")
          }
          if (!smokeProjectExists(canonicalProject)) return { removed: true }
          const stat = lstatSync(canonicalProject)
          if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error("smoke cleanup target is no longer the exact created plain directory")
          }
          const currentCanonical = realpathSync.native(canonicalProject)
          if (normalizedPath(currentCanonical) !== normalizedPath(canonicalProject) ||
            !isExactSmokeChild(canonicalTempRoot, currentCanonical)) {
            throw new Error("smoke cleanup target no longer resolves to the exact created canonical directory")
          }
          rmSync(canonicalProject, { recursive: true, force: true })
          if (smokeProjectExists(canonicalProject)) {
            throw Object.assign(new Error("smoke temporary project still exists after removal"), { code: "ENOTEMPTY" })
          }
          return { removed: true }
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === "ENOENT") return { removed: true }
          if (!RETRYABLE_CLEANUP_CODES.has(code ?? "") || Date.now() >= deadline) {
            return { removed: false, error: boundedError(error) }
          }
          await Bun.sleep(SMOKE_CLEANUP_RETRY_DELAY_MS)
        }
      }
    },
  }
}

export async function runSmoke(options: SmokeRunOptions = {}): Promise<SmokeRunResult> {
  const log = options.log ?? console.log
  const temporaryProject = createSmokeTemporaryProject()
  let failed = false
  let failure: unknown
  let removal: SmokeTemporaryProjectRemoval = { removed: false, error: "cleanup did not run" }

  try {
    if (temporaryProject.initialization_error !== undefined) throw temporaryProject.initialization_error
    log("templates:", listTemplates())

    const g = getTemplate("coding-diamond")
    validateGraph(g)
    log("coding-diamond: valid,", g.nodes.length, "nodes")

    const cycle = structuredClone(g)
    cycle.nodes[0]!.depends_on = ["check"]
    let threw = false
    try {
      validateGraph(cycle)
    } catch {
      threw = true
    }
    assert(threw, "expected cycle detection")

    const v = parseAndValidate("checker", {
      passed: true,
      failures: [],
      score: 9,
    })
    assert(v.ok, "checker schema")

    const parsed = extractJson('  ```json\n{"passed":false,"failures":["x"],"score":2}\n```  ')
    assert((parsed as { score: number }).score === 2, "extractJson")

    const run = createRun({
      goal: "Smoke test rate limit",
      criteria: ["schema valid", "dry run completes"],
      graph: getTemplate("coding-diamond"),
      projectDirectory: temporaryProject.path,
      ownerSessionId: "sess-smoke",
      mode: "dry",
    })

    const mockClient = {
      session: {
        create: async () => ({ data: { id: "never" } }),
        prompt: async () => ({ data: { parts: [] } }),
      },
      app: { log: async () => true },
    } as never

    const updated = await executeRun(run, {
      client: mockClient,
      parentSessionId: "sess-smoke",
      directory: temporaryProject.path,
      worktree: temporaryProject.path,
      toolContext: {
        ask: async () => {},
        abort: new AbortController().signal,
      },
      dry: true,
      onEvent: (message) => log(" ", message),
    })

    assert(updated.status === "done", `expected done, got ${updated.status}`)
    assert(updated.nodes.explore!.status === "done", "explore done")
    assert(updated.nodes.check!.status === "done", "check done")

    const reloaded = loadRun(temporaryProject.path, run.run_id)
    assert(reloaded?.status === "done", "persist/load")
    await options.afterVerification?.()
  } catch (error) {
    failed = true
    failure = error
  } finally {
    removal = await temporaryProject.remove()
    if (removal.removed) {
      log("smoke temporary project: removed")
      try {
        await options.onTemporaryProjectRemoved?.(temporaryProject.path)
      } catch (error) {
        if (failed) {
          failure = new AggregateError([failure, error], "smoke verification and cleanup assertion failed")
        } else {
          failed = true
          failure = error
        }
      }
    }
  }

  if (!removal.removed) {
    const cleanupFailure = new Error(`smoke temporary project cleanup failed: ${removal.error ?? "removal was not confirmed"}`)
    if (failed) throw new AggregateError([failure, cleanupFailure], "smoke verification and temporary project cleanup failed")
    throw cleanupFailure
  }
  if (failed) throw failure

  log("SMOKE OK")
  return {
    temporary_project: temporaryProject.path,
    temporary_project_removed: true,
  }
}

if (import.meta.main) await runSmoke()

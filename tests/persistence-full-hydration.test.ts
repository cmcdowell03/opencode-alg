import { describe, expect, test } from "bun:test"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createAlgTools } from "../src/tools.ts"
import { executeRun } from "../src/executor.ts"
import { getTemplate } from "../src/templates.ts"
import {
  canonicalJson,
  attemptDetailPath,
  failureListCommitment,
  nodeFailuresPath,
  nodeOutputReference,
  projectRunState,
  rootAuthorizationsPath,
  sha256Json,
} from "../src/persistence.ts"
import { parseRunState } from "../src/schemas.ts"
import {
  createRun,
  hydrateRunForExecution,
  hydrateRunFully,
  loadRun,
  persistRun,
  runDir,
} from "../src/store.ts"
import { transferRunOwnership } from "../src/ownership.ts"
import { serializedBytes } from "../src/limits.ts"
import type { NodeAttempt, RunDataReference, RunState } from "../src/types.ts"
import { executeContext, inertClient, removeProject, tempProject } from "./helpers.ts"

function context(project: string) {
  return {
    sessionID: "owner",
    messageID: "message",
    agent: "orchestrator",
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    ask: async () => {},
    metadata: () => {},
  } as any
}

function output(result: unknown): any {
  return JSON.parse((result as { output: string }).output)
}

function oneNodeGraph(maxAttempts = 8) {
  return {
    name: "immutable-history",
    max_global_attempts: maxAttempts,
    max_concurrency: 1,
    nodes: [{
      id: "work",
      agent: "implementer" as const,
      depends_on: [],
      loop: { max_attempts: maxAttempts, gate: "schema" as const },
    }],
  }
}

function implementation(label: string, done = true) {
  return done
    ? { summary: [label], files_touched: [], commands_run: [], risks: [], done: true }
    : {
        summary: [label],
        files_touched: [],
        commands_run: [],
        risks: [],
        done: false,
        blockers: [`blocker-${label}`],
      }
}

function referencePath(project: string, reference: RunDataReference): string {
  return join(project, ...reference.artifact_path.split("/"))
}

function references(state: RunState): RunDataReference[] {
  return Object.values(state.nodes).flatMap((node) => [
    node.output_ref,
    node.attempt_history_ref,
    node.last_failures_ref,
    ...node.attempts.flatMap((attempt) => [attempt.output_ref, attempt.detail_ref]),
  ].filter((reference): reference is RunDataReference => Boolean(reference)))
}

function readManifest(project: string, runId: string, backup = false): RunState {
  return parseRunState(JSON.parse(readFileSync(
    join(runDir(project, runId), backup ? "progress.json.bak" : "progress.json"),
    "utf8",
  )))
}

async function completedRun(project: string, runId: string, label: string): Promise<RunState> {
  const run = createRun({
    goal: label,
    criteria: [],
    graph: oneNodeGraph(2),
    projectDirectory: project,
    ownerSessionId: "owner",
    runId,
    mode: "dry",
  })
  const completed = await executeRun(run, { ...executeContext(project), parentSessionId: "owner", dry: true })
  replaceLatestOutput(completed, label)
  persistRun(completed, project)
  return loadRun(project, runId)!
}

function replaceLatestOutput(run: RunState, label: string): void {
  const value = implementation(label)
  const node = run.nodes.work!
  const attempt = node.attempts.at(-1)!
  node.output = value
  attempt.output = value
}

function seedAttempts(project: string, runId: string, count: number, pending: boolean): RunState {
  const run = createRun({
    goal: `seed ${runId}`,
    criteria: ["retain every attempt field"],
    graph: oneNodeGraph(Math.max(count + 1, 8)),
    projectDirectory: project,
    ownerSessionId: "owner",
    runId,
    mode: "dry",
  })
  const timestamp = "2026-08-10T10:00:00.000Z"
  const attempts: NodeAttempt[] = Array.from({ length: count }, (_, index) => {
    const attempt = index + 1
    return {
      attempt,
      status: "failed",
      session_id: `${runId}-child-${attempt}`,
      started_at: timestamp,
      finished_at: `2026-08-10T10:${attempt.toString().padStart(2, "0")}:00.000Z`,
      output: implementation(`${runId}-output-${attempt}`, false),
      failures: [`${runId}-failure-${attempt}`],
      score: undefined,
      shell_ok: attempt % 2 === 0,
      schema_ok: true,
      error: `${runId}-error-${attempt}`,
      feedback_applied: attempt === 1,
      outcome: "sdk_error",
    }
  })
  const node = run.nodes.work!
  node.attempts = attempts
  node.current_attempt = count
  node.output = attempts.at(-1)!.output
  node.last_failures = [`${runId}-failure-${count}`]
  node.status = pending ? "pending" : "failed"
  run.global_attempts = count
  run.status = pending ? "blocked" : "failed"
  run.phase = run.status
  persistRun(run, project)
  return loadRun(project, runId)!
}

describe("transactional immutable persistence", () => {
  test("progress current-rename failure preserves current and prior backup byte-for-byte", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "progress-current-rename-failure", "before")
      const progress = join(runDir(project, run.run_id), "progress.json")
      const backup = `${progress}.bak`
      const currentBefore = readFileSync(progress)
      const backupBefore = readFileSync(backup)
      const revision = readManifest(project, run.run_id).revision
      const candidate = loadRun(project, run.run_id)!
      candidate.criteria = ["must not commit"]

      expect(() => persistRun(candidate, project, {
        beforeProgressCurrentRename() { throw new Error("injected final current rename failure") },
      })).toThrow("injected final current rename failure")
      expect(readFileSync(progress).equals(currentBefore)).toBe(true)
      expect(readFileSync(backup).equals(backupBefore)).toBe(true)
      expect(loadRun(project, run.run_id)?.revision).toBe(revision)
      expect(readdirSync(runDir(project, run.run_id)).some((name) => name.includes("previous.tmp"))).toBe(false)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("post-commit backup-update failure keeps the new current and prior backup exact", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "progress-backup-update-failure", "before")
      const progress = join(runDir(project, run.run_id), "progress.json")
      const backup = `${progress}.bak`
      const currentBefore = readFileSync(progress)
      const backupBefore = readFileSync(backup)
      const revision = readManifest(project, run.run_id).revision
      const candidate = loadRun(project, run.run_id)!
      candidate.criteria = ["authoritative commit succeeds"]

      expect(() => persistRun(candidate, project, {
        beforeProgressBackupRename() { throw new Error("injected post-commit backup update failure") },
      })).not.toThrow()
      const committed = readManifest(project, run.run_id)
      expect(committed.revision).toBe(revision + 1)
      expect(committed.criteria).toEqual(["authoritative commit succeeds"])
      expect(readFileSync(progress).equals(currentBefore)).toBe(false)
      expect(readFileSync(backup).equals(backupBefore)).toBe(true)
      expect(loadRun(project, run.run_id)?.revision).toBe(revision + 1)
      expect(readdirSync(runDir(project, run.run_id)).some((name) => name.includes("previous.tmp"))).toBe(false)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("a pre-progress failure preserves authoritative and backup manifests plus every old sidecar byte", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "precommit-identity", "old-output")
      const directory = runDir(project, run.run_id)
      const progressPath = join(directory, "progress.json")
      const backupPath = `${progressPath}.bak`
      const progressBefore = readFileSync(progressPath)
      const backupBefore = readFileSync(backupPath)
      const manifestBefore = readManifest(project, run.run_id)
      const oldSidecars = new Map(references(manifestBefore).map((reference) => {
        const path = referencePath(project, reference)
        return [path, readFileSync(path)] as const
      }))

      const candidate = loadRun(project, run.run_id)!
      replaceLatestOutput(candidate, "new-output-must-not-commit")
      const callerBefore = structuredClone(candidate)
      expect(() => persistRun(candidate, project, {
        beforeProgressCommit() { throw new Error("injected immediately before progress commit") },
      })).toThrow("injected immediately before progress commit")

      expect(candidate).toEqual(callerBefore)
      expect(readFileSync(progressPath).equals(progressBefore)).toBe(true)
      expect(readFileSync(backupPath).equals(backupBefore)).toBe(true)
      for (const [path, bytes] of oldSidecars) expect(readFileSync(path).equals(bytes), path).toBe(true)
      expect(hydrateRunFully(readManifest(project, run.run_id)).nodes.work!.output)
        .toEqual(implementation("old-output"))
      expect(() => hydrateRunFully(readManifest(project, run.run_id, true))).not.toThrow()
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("sidecar and fixed-mirror failures never advance progress or invalidate old references", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "write-failures", "old")
      const progress = join(runDir(project, run.run_id), "progress.json")
      const before = readFileSync(progress)
      const oldManifest = readManifest(project, run.run_id)

      const sidecarCandidate = loadRun(project, run.run_id)!
      replaceLatestOutput(sidecarCandidate, "sidecar-candidate")
      expect(() => persistRun(sidecarCandidate, project, {
        beforeDerivedWrite(path) {
          if (/-[a-f0-9]{64}\.json$/.test(path)) throw new Error("sidecar write denied")
        },
      })).toThrow("sidecar write denied")
      expect(readFileSync(progress).equals(before)).toBe(true)
      expect(hydrateRunFully(oldManifest).nodes.work!.output).toEqual(implementation("old"))

      const mirrorCandidate = loadRun(project, run.run_id)!
      replaceLatestOutput(mirrorCandidate, "mirror-candidate")
      mirrorCandidate.graph.description = "force graph mirror"
      expect(() => persistRun(mirrorCandidate, project, {
        beforeDerivedWrite(path) {
          if (path.endsWith("graph.json")) throw new Error("mirror write denied")
        },
      })).toThrow("mirror write denied")
      expect(readFileSync(progress).equals(before)).toBe(true)
      expect(hydrateRunFully(oldManifest).nodes.work!.output).toEqual(implementation("old"))
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("successive manifests retain distinct immutable content and each hydrates its own bytes", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "successive-manifests", "generation-a")
      const first = readManifest(project, run.run_id)
      const firstProgressBytes = readFileSync(join(runDir(project, run.run_id), "progress.json"))
      const firstRef = first.nodes.work!.output_ref!
      const firstBytes = readFileSync(referencePath(project, firstRef))

      const secondCandidate = loadRun(project, run.run_id)!
      replaceLatestOutput(secondCandidate, "generation-b")
      persistRun(secondCandidate, project)
      const second = readManifest(project, run.run_id)
      const secondRef = second.nodes.work!.output_ref!

      expect(firstRef.artifact_path).not.toBe(secondRef.artifact_path)
      expect(firstRef.artifact_path).toContain(firstRef.sha256)
      expect(secondRef.artifact_path).toContain(secondRef.sha256)
      expect(readFileSync(referencePath(project, firstRef)).equals(firstBytes)).toBe(true)
      expect(hydrateRunFully(first).nodes.work!.output).toEqual(implementation("generation-a"))
      expect(hydrateRunFully(second).nodes.work!.output).toEqual(implementation("generation-b"))
      expect(readFileSync(join(runDir(project, run.run_id), "progress.json.bak")))
        .toEqual(firstProgressBytes)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("an occupied immutable hash path with mismatched bytes fails closed", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "hash-path-mismatch", "old")
      const candidate = loadRun(project, run.run_id)!
      replaceLatestOutput(candidate, "candidate")
      const expected = nodeOutputReference(run.run_id, "work", candidate.nodes.work!.output)
      const path = referencePath(project, expected)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify({ occupied: "wrong bytes" }), "utf8")
      const progress = join(runDir(project, run.run_id), "progress.json")
      const before = readFileSync(progress)

      expect(() => persistRun(candidate, project)).toThrow(/immutable JSON size mismatch|integrity mismatch/)
      expect(readFileSync(progress).equals(before)).toBe(true)
      expect(readFileSync(path, "utf8")).toBe(JSON.stringify({ occupied: "wrong bytes" }))
      expect(loadRun(project, run.run_id)?.nodes.work!.output).toEqual(implementation("old"))
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("GC preserves current and backup reachability and never removes unknown files", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "gc-reachability", "generation-a")
      const generationA = readManifest(project, run.run_id)
      const candidate = loadRun(project, run.run_id)!
      replaceLatestOutput(candidate, "generation-b")
      persistRun(candidate, project)
      const generationB = readManifest(project, run.run_id)
      const unknown = join(runDir(project, run.run_id), "artifacts", "user-owned-unknown.json")
      writeFileSync(unknown, "USER BYTES", "utf8")

      for (const reference of [...references(generationA), ...references(generationB)]) {
        expect(existsSync(referencePath(project, reference)), reference.artifact_path).toBe(true)
      }
      const unchanged = loadRun(project, run.run_id)!
      unchanged.criteria = ["rotate backup without changing output"]
      persistRun(unchanged, project)
      for (const reference of references(generationB)) {
        expect(existsSync(referencePath(project, reference)), reference.artifact_path).toBe(true)
      }
      expect(existsSync(unknown)).toBe(true)
      expect(readFileSync(unknown, "utf8")).toBe("USER BYTES")
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("a deterministic post-commit GC failure reports success and preserves committed recovery plus all candidates", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "post-commit-gc-failure", "generation-a")
      const directory = runDir(project, run.run_id)
      const progress = join(directory, "progress.json")
      const backup = `${progress}.bak`
      const priorCurrent = readFileSync(progress)
      const candidate = loadRun(project, run.run_id)!
      const priorRevision = candidate.revision
      candidate.criteria = ["the authoritative commit must advance"]
      replaceLatestOutput(candidate, "generation-b")

      const convenienceCandidate = join(directory, "artifacts", "work-attempt-999.json")
      const immutableCandidate = join(directory, "history", `work-attempt-999-detail-${"a".repeat(64)}.json`)
      writeFileSync(convenienceCandidate, "CONVENIENCE", "utf8")
      writeFileSync(immutableCandidate, "IMMUTABLE-LIKE", "utf8")
      let injections = 0
      const saved = persistRun(candidate, project, {
        beforePostCommitGc() {
          injections++
          throw new Error("injected post-commit GC containment failure")
        },
      })

      expect(injections).toBe(1)
      expect(saved).toBe(candidate)
      expect(saved.revision).toBe(priorRevision + 1)
      const committed = readManifest(project, run.run_id)
      expect(committed.revision).toBe(priorRevision + 1)
      expect(committed.criteria).toEqual(["the authoritative commit must advance"])
      expect(readFileSync(backup).equals(priorCurrent)).toBe(true)
      expect(hydrateRunFully(committed).nodes.work!.output).toEqual(implementation("generation-b"))
      expect(() => hydrateRunFully(readManifest(project, run.run_id, true))).not.toThrow()
      expect(loadRun(project, run.run_id)?.revision).toBe(priorRevision + 1)
      expect(saved).toEqual(loadRun(project, run.run_id)!)
      expect(readFileSync(convenienceCandidate, "utf8")).toBe("CONVENIENCE")
      expect(readFileSync(immutableCandidate, "utf8")).toBe("IMMUTABLE-LIKE")
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("immutable node and attempt outputs must already equal their parsed canonical form", async () => {
    const cases = [
      {
        name: "explorer-missing-defaults-node",
        nodeId: "explore",
        target: "node" as const,
        output: { query: "missing defaults", map: [{ path: "src/index.ts", role: "entry" }] },
        expected: /non-canonical/,
      },
      {
        name: "implementer-missing-defaults-attempt",
        nodeId: "implement",
        target: "attempt" as const,
        output: { summary: ["missing defaults"], done: true },
        expected: /non-canonical/,
      },
      {
        name: "checker-transformed-text-attempt",
        nodeId: "check",
        target: "attempt" as const,
        output: { passed: true, failures: [], score: 10, notes: " padded checker note " },
        expected: /violates checker output schema/,
      },
    ]
    for (const item of cases) {
      const project = tempProject()
      try {
        const run = createRun({
          goal: item.name,
          criteria: [],
          graph: getTemplate("coding-diamond"),
          projectDirectory: project,
          ownerSessionId: "owner",
          runId: item.name,
          mode: "dry",
        })
        await executeRun(run, { ...executeContext(project), parentSessionId: "owner", dry: true })
        const directory = runDir(project, run.run_id)
        const raw = JSON.parse(readFileSync(join(directory, "progress.json"), "utf8")) as any
        const attempt = raw.nodes[item.nodeId].attempts.at(-1)
        const reference = item.target === "node" ? raw.nodes[item.nodeId].output_ref : attempt.output_ref
        const sha256 = sha256Json(item.output)
        reference.sha256 = sha256
        reference.byte_size = serializedBytes(item.output)
        reference.artifact_path = item.target === "node"
          ? `.opencode/runs/${run.run_id}/artifacts/${item.nodeId}-output-${sha256}.json`
          : `.opencode/runs/${run.run_id}/artifacts/${item.nodeId}-attempt-${attempt.attempt}-output-${sha256}.json`
        writeFileSync(referencePath(project, reference), canonicalJson(item.output), "utf8")
        writeFileSync(join(directory, "progress.json"), `${canonicalJson(raw)}\n`, "utf8")

        expect(() => loadRun(project, run.run_id), item.name).toThrow(item.expected)
      } finally {
        removeProject(project)
      }
    }
  }, 120_000)

  test("canonical immutable outputs hydrate unchanged and publication canonicalizes accepted defaults", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "canonical-output-publication", "original")
      const candidate = loadRun(project, run.run_id)!
      const acceptedWithDefaults = { summary: ["canonical defaults"], done: true }
      candidate.nodes.work!.output = acceptedWithDefaults
      candidate.nodes.work!.attempts.at(-1)!.output = acceptedWithDefaults
      const originalIdentity = candidate
      const saved = persistRun(candidate, project)

      const manifest = readManifest(project, run.run_id)
      const nodeRef = manifest.nodes.work!.output_ref!
      const attemptRef = manifest.nodes.work!.attempts.at(-1)!.output_ref!
      const canonical = implementation("canonical defaults")
      expect(JSON.parse(readFileSync(referencePath(project, nodeRef), "utf8"))).toEqual(canonical)
      expect(JSON.parse(readFileSync(referencePath(project, attemptRef), "utf8"))).toEqual(canonical)
      const hydrated = loadRun(project, run.run_id)!
      expect(saved).toBe(originalIdentity)
      expect(candidate).toEqual(hydrated)
      expect(hydrated.nodes.work!.output).toEqual(canonical)
      expect(hydrated.nodes.work!.attempts.at(-1)!.output).toEqual(canonical)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("successful save replaces stale references with the canonical committed execution reload in place", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "canonical-copyback-references", "generation-a")
      const candidate = loadRun(project, run.run_id)!
      const originalIdentity = candidate
      const node = candidate.nodes.work!
      const attempt = node.attempts.at(-1)!
      const staleNodeRef = structuredClone(node.output_ref!)
      const staleAttemptRef = structuredClone(attempt.output_ref!)
      const staleDetailRef = structuredClone(attempt.detail_ref!)
      const acceptedWithDefaults = { summary: ["generation-b"], done: true }
      node.output = acceptedWithDefaults
      attempt.output = acceptedWithDefaults

      const saved = persistRun(candidate, project)
      const reloaded = loadRun(project, run.run_id)!

      expect(saved).toBe(originalIdentity)
      expect(candidate).toEqual(reloaded)
      expect(candidate.revision).toBe(reloaded.revision)
      expect(candidate.nodes.work!.output).toEqual(implementation("generation-b"))
      expect(candidate.nodes.work!.attempts.at(-1)!.output).toEqual(implementation("generation-b"))
      expect(candidate.nodes.work!.output_ref).toEqual(readManifest(project, run.run_id).nodes.work!.output_ref)
      expect(candidate.nodes.work!.attempts.at(-1)!.output_ref)
        .toEqual(readManifest(project, run.run_id).nodes.work!.attempts.at(-1)!.output_ref)
      expect(candidate.nodes.work!.attempts.at(-1)!.detail_ref)
        .toEqual(readManifest(project, run.run_id).nodes.work!.attempts.at(-1)!.detail_ref)
      expect(candidate.nodes.work!.output_ref).not.toEqual(staleNodeRef)
      expect(candidate.nodes.work!.attempts.at(-1)!.output_ref).not.toEqual(staleAttemptRef)
      expect(candidate.nodes.work!.attempts.at(-1)!.detail_ref).not.toEqual(staleDetailRef)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("successful save removes configurable hidden string and symbol extensions while retaining identities", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "canonical-copyback-own-keys", "generation-a")
      const candidate = loadRun(project, run.run_id)!
      const node = candidate.nodes.work!
      const attempt = node.attempts.at(-1)!
      const targets = [
        ["run", candidate],
        ["node", node],
        ["attempt", attempt],
      ] as const
      const extensions = targets.map(([label, target]) => {
        const hidden = `caller_hidden_${label}`
        const symbol = Symbol(`caller-symbol-${label}`)
        Object.defineProperty(target, hidden, {
          value: `${label}-hidden`,
          writable: true,
          enumerable: false,
          configurable: true,
        })
        Object.defineProperty(target, symbol, {
          value: `${label}-symbol`,
          writable: true,
          enumerable: false,
          configurable: true,
        })
        return { target, hidden, symbol }
      })
      candidate.criteria = ["copyback removes every extra own key"]

      const saved = persistRun(candidate, project)

      expect(saved).toBe(candidate)
      expect(saved.nodes.work).toBe(node)
      expect(saved.nodes.work!.attempts.at(-1)).toBe(attempt)
      expect(Object.getPrototypeOf(saved)).toBe(Object.prototype)
      expect(Object.getPrototypeOf(saved.nodes.work)).toBe(Object.prototype)
      expect(Object.getPrototypeOf(saved.nodes.work!.attempts.at(-1)!)).toBe(Object.prototype)
      for (const { target, hidden, symbol } of extensions) {
        expect(Reflect.ownKeys(target)).not.toContain(hidden)
        expect(Reflect.ownKeys(target)).not.toContain(symbol)
      }
      expect(candidate).toEqual(loadRun(project, run.run_id)!)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("non-configurable run, node, and attempt extensions fail preflight without caller or authoritative mutation", async () => {
    for (const location of ["run", "node", "attempt"] as const) {
      const project = tempProject(`alg-copyback-nonconfig-${location}-`)
      try {
        const runId = `copyback-nonconfig-${location}`
        const run = await completedRun(project, runId, "authoritative-before")
        const candidate = loadRun(project, run.run_id)!
        candidate.criteria = [`caller-candidate-${location}`]
        const node = candidate.nodes.work!
        const attempt = node.attempts.at(-1)!
        const target = location === "run" ? candidate : location === "node" ? node : attempt
        const extension = `caller_nonconfigurable_${location}`
        Object.defineProperty(target, extension, {
          value: location,
          writable: true,
          enumerable: false,
          configurable: false,
        })
        const callerBefore = structuredClone(candidate)
        const revisionBefore = candidate.revision
        const updatedBefore = candidate.updated_at
        const progress = join(runDir(project, run.run_id), "progress.json")
        const authoritativeBefore = readFileSync(progress)

        expect(() => persistRun(candidate, project), location).toThrow(
          /synchronization preflight failed before commit.*non-configurable extension.*unsupported/,
        )

        expect(candidate, location).toEqual(callerBefore)
        expect(candidate.revision, location).toBe(revisionBefore)
        expect(candidate.updated_at, location).toBe(updatedBefore)
        expect(candidate.nodes.work, location).toBe(node)
        expect(candidate.nodes.work!.attempts.at(-1), location).toBe(attempt)
        expect(Reflect.ownKeys(target), location).toContain(extension)
        expect(readFileSync(progress).equals(authoritativeBefore), location).toBe(true)
        expect(loadRun(project, run.run_id), location).toMatchObject({
          revision: revisionBefore,
          criteria: [],
        })
      } finally {
        removeProject(project)
      }
    }
  }, 120_000)

  test("archived caller attempts are preflighted and configurable extras are stripped from detached identities", () => {
    const project = tempProject()
    try {
      seedAttempts(project, "archived-copyback-configurable", 5, false)
      const candidate = hydrateRunFully(loadRun(project, "archived-copyback-configurable")!)
      const archivedIdentity = candidate.nodes.work!.attempts[0]!
      const symbol = Symbol("archived-caller-extra")
      Object.defineProperty(archivedIdentity, "archived_hidden_extra", {
        value: "remove me",
        writable: true,
        enumerable: false,
        configurable: true,
      })
      Object.defineProperty(archivedIdentity, symbol, {
        value: "remove me too",
        writable: true,
        enumerable: false,
        configurable: true,
      })
      archivedIdentity.output = { summary: ["archived canonicalized"], done: true }

      persistRun(candidate, project)

      expect(candidate.nodes.work!.attempts.map((attempt) => attempt.attempt)).toEqual([2, 3, 4, 5])
      expect(candidate.nodes.work!.attempts).not.toContain(archivedIdentity)
      expect(Reflect.ownKeys(archivedIdentity)).not.toContain("archived_hidden_extra")
      expect(Reflect.ownKeys(archivedIdentity)).not.toContain(symbol)
      expect(archivedIdentity).toEqual(hydrateRunFully(loadRun(project, candidate.run_id)!).nodes.work!.attempts[0]!)
      expect(archivedIdentity.output).toEqual(implementation("archived canonicalized"))
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("a non-configurable archived-attempt extra fails before caller or authoritative mutation", () => {
    const project = tempProject()
    try {
      seedAttempts(project, "archived-copyback-nonconfigurable", 5, false)
      const candidate = hydrateRunFully(loadRun(project, "archived-copyback-nonconfigurable")!)
      const archivedIdentity = candidate.nodes.work!.attempts[0]!
      Object.defineProperty(archivedIdentity, "archived_nonconfigurable_extra", {
        value: "cannot remove",
        writable: true,
        enumerable: false,
        configurable: false,
      })
      const progress = join(runDir(project, candidate.run_id), "progress.json")
      const authoritativeBefore = readFileSync(progress)
      const revisionBefore = candidate.revision

      expect(() => persistRun(candidate, project)).toThrow(
        /synchronization preflight failed before commit.*non-configurable extension.*archived_nonconfigurable_extra/,
      )

      expect(candidate.revision).toBe(revisionBefore)
      expect(candidate.nodes.work!.attempts[0]).toBe(archivedIdentity)
      expect(Reflect.ownKeys(archivedIdentity)).toContain("archived_nonconfigurable_extra")
      expect(readFileSync(progress).equals(authoritativeBefore)).toBe(true)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("non-configurable canonical data properties allow invariant-safe updates and exact fixed values", async () => {
    const project = tempProject()
    try {
      const candidate = await completedRun(project, "copyback-nonconfig-canonical-positive", "before")
      const revisionBefore = candidate.revision
      Object.defineProperty(candidate, "revision", {
        value: revisionBefore,
        writable: true,
        enumerable: true,
        configurable: false,
      })
      Object.defineProperty(candidate, "schema_version", {
        value: 2,
        writable: false,
        enumerable: true,
        configurable: false,
      })
      candidate.criteria = ["safe non-configurable canonical copyback"]

      const saved = persistRun(candidate, project)

      expect(saved).toBe(candidate)
      expect(candidate.revision).toBe(revisionBefore + 1)
      expect(Object.getOwnPropertyDescriptor(candidate, "revision")).toMatchObject({
        writable: true,
        configurable: false,
      })
      expect(Object.getOwnPropertyDescriptor(candidate, "schema_version")).toMatchObject({
        value: 2,
        writable: false,
        configurable: false,
      })
      expect(candidate).toEqual(loadRun(project, candidate.run_id)!)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("incompatible canonical descriptors fail precommit without invoking accessors or changing state", async () => {
    const cases = ["nonwritable-mismatch", "accessor"] as const
    for (const kind of cases) {
      const project = tempProject(`alg-copyback-canonical-${kind}-`)
      try {
        const candidate = await completedRun(project, `copyback-canonical-${kind}`, "before")
        const progress = join(runDir(project, candidate.run_id), "progress.json")
        const authoritativeBefore = readFileSync(progress)
        const revisionBefore = candidate.revision
        let getterCalls = 0
        if (kind === "nonwritable-mismatch") {
          Object.defineProperty(candidate, "revision", {
            value: revisionBefore,
            writable: false,
            enumerable: true,
            configurable: false,
          })
        } else {
          Object.defineProperty(candidate, "criteria", {
            get() {
              getterCalls++
              throw new Error("getter must never execute")
            },
            enumerable: true,
            configurable: false,
          })
        }

        expect(() => persistRun(candidate, project), kind).toThrow(
          kind === "accessor" ? /accessor run\.criteria is unsupported/ : /non-writable non-configurable canonical property "revision"/,
        )
        expect(getterCalls, kind).toBe(0)
        expect(candidate.revision, kind).toBe(revisionBefore)
        expect(readFileSync(progress).equals(authoritativeBefore), kind).toBe(true)
      } finally {
        removeProject(project)
      }
    }
  }, 60_000)

  test("custom prototypes and deterministic proxy trap rejection stay precommit and mutation-free", async () => {
    for (const kind of ["prototype", "proxy"] as const) {
      const project = tempProject(`alg-persistence-boundary-${kind}-`)
      try {
        const candidate = await completedRun(project, `persistence-boundary-${kind}`, "before")
        const progress = join(runDir(project, candidate.run_id), "progress.json")
        const authoritativeBefore = readFileSync(progress)
        const nodeBefore = candidate.nodes.work!
        const revisionBefore = candidate.revision
        if (kind === "prototype") {
          Object.setPrototypeOf(nodeBefore, { callerPrototype: true })
        } else {
          candidate.nodes.work = new Proxy(nodeBefore, {
            ownKeys() { throw new Error("deterministic proxy ownKeys rejection") },
          })
        }

        expect(() => persistRun(candidate, project), kind).toThrow(
          kind === "prototype" ? /unsupported prototype/ : /plain-data validation failed before commit.*ownKeys rejection/,
        )
        expect(candidate.revision, kind).toBe(revisionBefore)
        expect(readFileSync(progress).equals(authoritativeBefore), kind).toBe(true)
        expect(kind === "prototype" ? candidate.nodes.work : nodeBefore).toBe(nodeBefore)
      } finally {
        removeProject(project)
      }
    }
  }, 60_000)

  test("node:util types.isProxy rejects transparent and stateful proxies before any write", async () => {
    for (const kind of ["transparent", "stateful"] as const) {
      const project = tempProject(`alg-persistence-proxy-${kind}-`)
      try {
        const candidate = await completedRun(project, `persistence-proxy-${kind}`, "before")
        const directory = runDir(project, candidate.run_id)
        const progress = join(directory, "progress.json")
        const backup = join(directory, "progress.json.bak")
        const authoritativeBefore = readFileSync(progress)
        const backupBefore = readFileSync(backup)
        const revisionBefore = candidate.revision
        const updatedBefore = candidate.updated_at
        const nodeBefore = candidate.nodes.work!
        let descriptorCalls = 0
        let valueReads = 0
        const handler: ProxyHandler<typeof nodeBefore> = kind === "transparent"
          ? {}
          : {
              ownKeys(target) {
                return Reflect.ownKeys(target)
              },
              getOwnPropertyDescriptor(target, key) {
                descriptorCalls++
                return Reflect.getOwnPropertyDescriptor(target, key)
              },
              get(target, key, receiver) {
                valueReads++
                return Reflect.get(target, key, receiver)
              },
            }
        const proxy = new Proxy(nodeBefore, handler)
        candidate.nodes.work = proxy

        expect(() => persistRun(candidate, project), kind).toThrow(/node:util types\.isProxy guard rejected.*before commit/)

        expect(candidate.revision, kind).toBe(revisionBefore)
        expect(candidate.updated_at, kind).toBe(updatedBefore)
        expect(candidate.nodes.work, kind).toBe(proxy)
        expect(readFileSync(progress).equals(authoritativeBefore), kind).toBe(true)
        expect(readFileSync(backup).equals(backupBefore), kind).toBe(true)
        if (kind === "stateful") {
          expect(descriptorCalls).toBeGreaterThan(0)
          expect(valueReads).toBe(0)
        }
      } finally {
        removeProject(project)
      }
    }
  }, 60_000)

  test("descriptor post-validation catches stateful Proxy mutation without getter or durable write", async () => {
    for (const kind of ["parent-replacement", "accessor-install"] as const) {
      const project = tempProject(`alg-persistence-stateful-${kind}-`)
      try {
        const candidate = await completedRun(project, `persistence-stateful-${kind}`, "before")
        const directory = runDir(project, candidate.run_id)
        const progress = join(directory, "progress.json")
        const backup = join(directory, "progress.json.bak")
        const currentBefore = readFileSync(progress)
        const backupBefore = readFileSync(backup)
        const revisionBefore = candidate.revision
        const updatedBefore = candidate.updated_at
        const nodeBefore = candidate.nodes.work!
        let getterCalls = 0

        let proxy: typeof nodeBefore
        proxy = new Proxy(nodeBefore, kind === "parent-replacement"
          ? {
              getPrototypeOf(target) {
                candidate.nodes.work = { ...target }
                return Reflect.getPrototypeOf(target)
              },
            }
          : {
              ownKeys(target) {
                Object.defineProperty(candidate, "criteria", {
                  get() {
                    getterCalls++
                    throw new Error("stateful proxy-installed getter must never execute")
                  },
                  enumerable: true,
                  configurable: true,
                })
                return Reflect.ownKeys(target)
              },
            })
        candidate.nodes.work = proxy

        expect(() => persistRun(candidate, project), kind).toThrow(/caller graph changed during descriptor validation/)

        expect(getterCalls, kind).toBe(0)
        expect(candidate.revision, kind).toBe(revisionBefore)
        expect(candidate.updated_at, kind).toBe(updatedBefore)
        expect(readFileSync(progress).equals(currentBefore), kind).toBe(true)
        expect(readFileSync(backup).equals(backupBefore), kind).toBe(true)
      } finally {
        removeProject(project)
      }
    }
  }, 60_000)

  test("descriptor snapshot persistence accepts an ordinary graph and preserves canonical identities", async () => {
    const project = tempProject("alg-persistence-descriptor-positive-")
    try {
      const candidate = await completedRun(project, "descriptor-snapshot-positive", "before")
      const node = candidate.nodes.work!
      const attempt = node.attempts.at(-1)!
      const revisionBefore = candidate.revision
      candidate.criteria = ["ordinary descriptor graph"]

      expect(persistRun(candidate, project)).toBe(candidate)
      expect(candidate.revision).toBe(revisionBefore + 1)
      expect(candidate.nodes.work).toBe(node)
      expect(candidate.nodes.work!.attempts.at(-1)).toBe(attempt)
      expect(candidate).toEqual(loadRun(project, candidate.run_id)!)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("cross-path node and attempt aliases fail precommit while ordinary identities persist", async () => {
    for (const kind of ["node", "attempt", "ordinary"] as const) {
      const project = tempProject(`alg-persistence-alias-${kind}-`)
      try {
        const run = createRun({
          goal: `alias ${kind}`,
          criteria: [],
          graph: {
            name: "alias-preflight",
            max_global_attempts: 4,
            max_concurrency: 2,
            nodes: [
              { id: "alpha", agent: "implementer", depends_on: [], loop: { max_attempts: 1, gate: "schema" } },
              { id: "beta", agent: "implementer", depends_on: [], loop: { max_attempts: 1, gate: "schema" } },
            ],
          },
          projectDirectory: project,
          ownerSessionId: "owner",
          runId: `alias-preflight-${kind}`,
          mode: "dry",
        })
        const candidate = await executeRun(run, { ...executeContext(project), parentSessionId: "owner", dry: true })
        const directory = runDir(project, candidate.run_id)
        const progress = join(directory, "progress.json")
        const backup = join(directory, "progress.json.bak")
        const authoritativeBefore = readFileSync(progress)
        const backupBefore = readFileSync(backup)
        const revisionBefore = candidate.revision
        const updatedBefore = candidate.updated_at

        if (kind === "node") {
          candidate.nodes.beta = candidate.nodes.alpha!
        } else if (kind === "attempt") {
          candidate.nodes.beta!.attempts[0] = candidate.nodes.alpha!.attempts[0]!
        } else {
          candidate.criteria = ["normal non-aliased save"]
        }

        if (kind === "ordinary") {
          const saved = persistRun(candidate, project)
          expect(saved).toBe(candidate)
          expect(saved.revision).toBe(revisionBefore + 1)
          expect(saved.nodes.alpha).not.toBe(saved.nodes.beta)
          expect(saved.nodes.alpha!.attempts[0]).not.toBe(saved.nodes.beta!.attempts[0])
        } else {
          expect(() => persistRun(candidate, project), kind).toThrow(
            /synchronization targets must not share object identity.*aliases/,
          )
          expect(candidate.revision, kind).toBe(revisionBefore)
          expect(candidate.updated_at, kind).toBe(updatedBefore)
          expect(readFileSync(progress).equals(authoritativeBefore), kind).toBe(true)
          expect(readFileSync(backup).equals(backupBefore), kind).toBe(true)
          if (kind === "node") expect(candidate.nodes.alpha).toBe(candidate.nodes.beta)
          if (kind === "attempt") {
            expect(candidate.nodes.alpha!.attempts[0]).toBe(candidate.nodes.beta!.attempts[0])
          }
        }
      } finally {
        removeProject(project)
      }
    }
  }, 120_000)

  test("post-save execution state keeps model snapshots immutable and node fields mutable", () => {
    const project = tempProject()
    try {
      const inherited = { source: "inherited-sdk-default" as const }
      const run = createRun({
        goal: "copyback mutability",
        criteria: [],
        graph: oneNodeGraph(1),
        projectDirectory: project,
        ownerSessionId: "owner",
        runId: "copyback-mutability",
        modelSnapshot: {
          implementer: { providerID: "provider", modelID: "model", variant: "effort" },
        },
        modelResolution: {
          planner: inherited,
          explorer: inherited,
          researcher: inherited,
          implementer: {
            source: "alg-project-override",
            providerID: "provider",
            modelID: "model",
            variant: "effort",
          },
          checker: inherited,
          repair: inherited,
          default: inherited,
        },
      })

      const saved = persistRun(run, project)
      expect(saved).toBe(run)
      expect(Object.isFrozen(saved.model_snapshot)).toBe(true)
      expect(Object.values(saved.model_snapshot).every(Object.isFrozen)).toBe(true)
      expect(Object.isFrozen(saved.model_resolution)).toBe(true)
      expect(Object.values(saved.model_resolution!).every(Object.isFrozen)).toBe(true)
      expect(Object.isFrozen(saved.nodes)).toBe(false)
      expect(Object.isFrozen(saved.nodes.work)).toBe(false)
      saved.nodes.work!.last_failures.push("mutable after commit")
      saved.nodes.work!.status = "ready"
      expect(saved.nodes.work).toMatchObject({ status: "ready", last_failures: ["mutable after commit"] })
      expect(() => {
        saved.model_snapshot.implementer!.variant = "changed"
      }).toThrow()
      expect(() => {
        saved.model_resolution!.implementer.variant = "changed"
      }).toThrow()
    } finally {
      removeProject(project)
    }
  })

  test("legacy fixed references load and migrate to immutable paths while fixed backup content remains recoverable", () => {
    const project = tempProject()
    try {
      seedAttempts(project, "legacy-fixed", 5, false)
      const directory = runDir(project, "legacy-fixed")
      const raw = JSON.parse(readFileSync(join(directory, "progress.json"), "utf8")) as any
      const fixedPath = (reference: any, relative: string) => {
        const source = join(project, ...reference.artifact_path.split("/"))
        const destination = join(project, ...relative.split("/"))
        copyFileSync(source, destination)
        reference.artifact_path = relative
      }
      const node = raw.nodes.work
      fixedPath(node.output_ref, `.opencode/runs/legacy-fixed/artifacts/work-output-${node.output_ref.sha256.slice(0, 16)}.json`)
      fixedPath(node.attempt_history_ref, ".opencode/runs/legacy-fixed/history/work-attempts.json")
      fixedPath(node.last_failures_ref, ".opencode/runs/legacy-fixed/history/work-failures.json")
      for (const attempt of node.attempts) {
        fixedPath(attempt.output_ref, `.opencode/runs/legacy-fixed/artifacts/work-attempt-${attempt.attempt}.json`)
        fixedPath(attempt.detail_ref, `.opencode/runs/legacy-fixed/history/work-attempt-${attempt.attempt}.json`)
      }
      writeFileSync(join(directory, "progress.json"), `${JSON.stringify(raw)}\n`, "utf8")

      const legacy = loadRun(project, "legacy-fixed")!
      expect(legacy.nodes.work!.attempts).toHaveLength(4)
      const execution = hydrateRunForExecution(legacy)
      expect(execution.nodes.work!.attempts).toHaveLength(5)
      persistRun(execution, project)
      const migrated = readManifest(project, "legacy-fixed")
      for (const reference of references(migrated)) {
        expect(reference.artifact_path).toContain(reference.sha256)
      }
      expect(() => hydrateRunFully(readManifest(project, "legacy-fixed", true))).not.toThrow()
      expect(existsSync(join(directory, "history", "work-attempts.json"))).toBe(true)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("a transfer-only save recursively migrates nested legacy history while the old manifest still hydrates", () => {
    const project = tempProject()
    try {
      seedAttempts(project, "legacy-transfer-tree", 6, false)
      const directory = runDir(project, "legacy-transfer-tree")
      const progress = join(directory, "progress.json")
      const raw = JSON.parse(readFileSync(progress, "utf8")) as any
      const historyReference = raw.nodes.work.attempt_history_ref
      const historyPath = referencePath(project, historyReference)
      const history = JSON.parse(readFileSync(historyPath, "utf8")) as any
      const makeFixed = (reference: any, relative: string) => {
        const source = referencePath(project, reference)
        const destination = join(project, ...relative.split("/"))
        copyFileSync(source, destination)
        reference.artifact_path = relative
      }
      for (const attempt of history.attempts) {
        makeFixed(
          attempt.output_ref,
          `.opencode/runs/legacy-transfer-tree/artifacts/work-attempt-${attempt.attempt}.json`,
        )
        makeFixed(
          attempt.detail_ref,
          `.opencode/runs/legacy-transfer-tree/history/work-attempt-${attempt.attempt}.json`,
        )
      }
      historyReference.sha256 = sha256Json(history)
      historyReference.byte_size = serializedBytes(history)
      historyReference.artifact_path = ".opencode/runs/legacy-transfer-tree/history/work-attempts.json"
      writeFileSync(join(directory, "history", "work-attempts.json"), canonicalJson(history), "utf8")
      writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")
      const legacyManifest = parseRunState(raw)

      transferRunOwnership(project, "legacy-transfer-tree", "owner", "new-owner")
      const migrated = readManifest(project, "legacy-transfer-tree")
      expect(migrated.owner_session_id).toBe("new-owner")
      for (const reference of references(migrated)) {
        expect(reference.artifact_path.endsWith(`-${reference.sha256}.json`), reference.artifact_path).toBe(true)
      }
      const migratedHistoryRef = migrated.nodes.work!.attempt_history_ref!
      const migratedHistory = JSON.parse(readFileSync(referencePath(project, migratedHistoryRef), "utf8")) as any
      expect(migratedHistory.owner_session_id).toBe("new-owner")
      for (const attempt of migratedHistory.attempts) {
        for (const reference of [attempt.output_ref, attempt.detail_ref]) {
          const immutable = reference.artifact_path.endsWith(`-${reference.sha256}.json`) as boolean
          expect(immutable).toBe(true)
        }
      }
      expect(hydrateRunFully(legacyManifest).nodes.work!.attempts).toHaveLength(6)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("a transfer rebinds and migrates a projected root-authorization archive without breaking legacy recovery", () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "root archive transfer",
        criteria: [],
        graph: oneNodeGraph(),
        projectDirectory: project,
        ownerSessionId: "owner",
        runId: "root-archive-transfer",
      })
      run.filesystem_root_authorizations = Array.from({ length: 70 }, (_, index) => ({
        operation: (["plan", "run", "resume"] as const)[index % 3]!,
        by_session_id: "owner",
        authorized_at: new Date(Date.parse("2026-08-10T10:00:00.000Z") + index * 1_000).toISOString(),
      }))
      persistRun(run, project)
      const progress = join(runDir(project, run.run_id), "progress.json")
      const raw = JSON.parse(readFileSync(progress, "utf8")) as any
      const reference = raw.filesystem_root_authorizations_ref
      const fixedRelative = `.opencode/runs/${run.run_id}/history/filesystem-root-authorizations.json`
      copyFileSync(referencePath(project, reference), join(project, ...fixedRelative.split("/")))
      reference.artifact_path = fixedRelative
      writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")
      const legacy = parseRunState(raw)

      transferRunOwnership(project, run.run_id, "owner", "new-owner")
      const migrated = readManifest(project, run.run_id)
      const migratedReference = migrated.filesystem_root_authorizations_ref!
      expect(migratedReference.artifact_path.endsWith(`-${migratedReference.sha256}.json`)).toBe(true)
      const document = JSON.parse(readFileSync(referencePath(project, migratedReference), "utf8")) as any
      expect(document).toMatchObject({
        kind: "filesystem_root_authorizations",
        run_id: run.run_id,
        owner_session_id: "new-owner",
      })
      expect(document.authorizations).toHaveLength(70)
      expect(hydrateRunFully(migrated).filesystem_root_authorizations).toHaveLength(70)
      expect(hydrateRunFully(legacy).filesystem_root_authorizations).toHaveLength(70)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("concurrent cross-process publication yields one fenced manifest and valid immutable content", async () => {
    const project = tempProject()
    try {
      const run = await completedRun(project, "sidecar-publication-stress", "before-race")
      const storeUrl = new URL("../src/store.ts", import.meta.url).href
      const schemasUrl = new URL("../src/schemas.ts", import.meta.url).href
      const releaseAt = Date.now() + 2_000
      const candidateOutput = implementation("shared-race-output")
      const script = [
        `import { readFileSync } from "node:fs";`,
        `import { hydrateRunFully, persistRun } from ${JSON.stringify(storeUrl)};`,
        `import { parseRunState } from ${JSON.stringify(schemasUrl)};`,
        `const run = hydrateRunFully(parseRunState(JSON.parse(readFileSync(${JSON.stringify(join(runDir(project, run.run_id), "progress.json"))}, "utf8"))));`,
        `const value = ${JSON.stringify(candidateOutput)};`,
        `run.nodes.work.output = value;`,
        `run.nodes.work.attempts.at(-1).output = value;`,
        `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ${releaseAt} - Date.now()));`,
        `try { persistRun(run, ${JSON.stringify(project)}); console.log(JSON.stringify({ saved: true })); }`,
        `catch (error) { console.log(JSON.stringify({ saved: false, error: error instanceof Error ? error.message : String(error) })); }`,
      ].join("\n")
      const children = Array.from({ length: 4 }, () =>
        Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" }))
      const results = await Promise.all(children.map(async (child) => ({
        code: await child.exited,
        stdout: (await new Response(child.stdout).text()).trim(),
        stderr: await new Response(child.stderr).text(),
      })))
      expect(results.map((result) => ({ code: result.code, stderr: result.stderr })))
        .toEqual(Array.from({ length: 4 }, () => ({ code: 0, stderr: "" })))
      const reports = results.map((result) => JSON.parse(result.stdout))
      expect(reports.filter((report) => report.saved)).toHaveLength(1)
      for (const report of reports.filter((candidate) => !candidate.saved)) {
        expect(report.error).toMatch(
          /revision conflict|mutex is held|mutex acquisition timed out|stale-takeover claim is live or unverifiable/,
        )
      }

      const manifest = readManifest(project, run.run_id)
      const full = hydrateRunFully(manifest)
      expect(full.nodes.work!.output).toEqual(candidateOutput)
      for (const reference of references(manifest)) {
        expect(existsSync(referencePath(project, reference)), reference.artifact_path).toBe(true)
      }
    } finally {
      removeProject(project)
    }
  }, 60_000)
})

describe("complete full hydration", () => {
  test("archived projected records are strictly parsed before valid details can hydrate over them", () => {
    const cases = [
      {
        name: "unknown-field",
        mutate: (attempt: any) => { attempt.silently_discarded = "must fail" },
        expected: /unrecognized|unknown|schema mismatch before hydration/i,
      },
      {
        name: "malformed-terminal",
        mutate: (attempt: any) => { delete attempt.finished_at },
        expected: /terminal attempt requires finished_at|schema mismatch before hydration/i,
      },
    ]
    for (const item of cases) {
      const project = tempProject(`alg-strict-archive-${item.name}-`)
      try {
        const runId = `strict-archive-${item.name}`
        seedAttempts(project, runId, 5, false)
        const progress = join(runDir(project, runId), "progress.json")
        const raw = JSON.parse(readFileSync(progress, "utf8")) as any
        const reference = raw.nodes.work.attempt_history_ref
        const history = JSON.parse(readFileSync(referencePath(project, reference), "utf8")) as any
        expect(history.attempts[0].detail_ref).toBeDefined()
        item.mutate(history.attempts[0])
        const hash = sha256Json(history)
        const relative = `.opencode/runs/${runId}/history/work-attempts-${hash}.json`
        writeFileSync(join(project, ...relative.split("/")), canonicalJson(history), "utf8")
        reference.artifact_path = relative
        reference.sha256 = hash
        reference.byte_size = serializedBytes(history)
        writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")

        expect(() => hydrateRunFully(parseRunState(raw)), item.name).toThrow(item.expected)
      } finally {
        removeProject(project)
      }
    }
  }, 60_000)

  test("status, run, and resume full hydrate archived order plus every attempt field while compact stays projected", async () => {
    const project = tempProject()
    try {
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)

      seedAttempts(project, "full-status-history", 6, false)
      const compact = output(await tools.alg_status.execute({ run_id: "full-status-history" }, context(project)))
      expect(compact.nodes.work.attempt_history_ref.attempt_count).toBe(2)
      expect(compact.execution_summary.child_sessions).toBe(6)
      expect(compact.nodes.work.attempt_history).toHaveLength(4)
      expect(compact.nodes.work.attempts_omitted).toBe(2)
      expect(compact.nodes.work.attempt_history.every((attempt: any) =>
        attempt.output === undefined && attempt.output_ref && attempt.detail_ref)).toBe(true)

      const fullStatus = output(await tools.alg_status.execute({
        run_id: "full-status-history",
        detail: "full",
      }, context(project)))
      expect(fullStatus.nodes.work.attempts.map((attempt: any) => attempt.attempt))
        .toEqual([1, 2, 3, 4, 5, 6])
      expect(new Set(fullStatus.nodes.work.attempts.map((attempt: any) => attempt.attempt)).size).toBe(6)
      expect(fullStatus.nodes.work.attempt_history_ref).toBeUndefined()
      for (const [index, attempt] of fullStatus.nodes.work.attempts.entries()) {
        expect(attempt).toMatchObject({
          session_id: `full-status-history-child-${index + 1}`,
          schema_ok: true,
          error: `full-status-history-error-${index + 1}`,
          outcome: "sdk_error",
          output: implementation(`full-status-history-output-${index + 1}`, false),
          output_ref: { sha256: expect.any(String) },
          detail_ref: { sha256: expect.any(String) },
        })
      }

      seedAttempts(project, "full-run-history", 5, true)
      const fullRun = output(await tools.alg_run.execute({
        run_id: "full-run-history",
        dry: true,
        detail: "full",
      }, context(project)))
      expect(fullRun.nodes.work.attempts.map((attempt: any) => attempt.attempt))
        .toEqual([1, 2, 3, 4, 5, 6])
      expect(fullRun.nodes.work.attempts.slice(0, 5).every((attempt: any) =>
        attempt.output_ref && attempt.detail_ref && attempt.output)).toBe(true)

      seedAttempts(project, "full-resume-history", 5, false)
      const fullResume = output(await tools.alg_resume.execute({
        run_id: "full-resume-history",
        dry: true,
        detail: "full",
      }, context(project)))
      expect(fullResume.nodes.work.attempts.map((attempt: any) => attempt.attempt))
        .toEqual([1, 2, 3, 4, 5, 6])
      expect(fullResume.nodes.work.attempts.slice(0, 5).every((attempt: any) =>
        attempt.session_id && attempt.output && attempt.failures.length === 1)).toBe(true)
    } finally {
      removeProject(project)
    }
  }, 120_000)

  test("routing summaries count archived prefixes exactly, expose legacy unknowns, and reject forged metadata", async () => {
    const project = tempProject()
    try {
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)

      seedAttempts(project, "routing-archived-exact", 6, false)
      const exactManifest = readManifest(project, "routing-archived-exact")
      expect(exactManifest.nodes.work!.attempt_history_ref).toMatchObject({
        attempt_count: 2,
        outcome_counts: {
          passed: 0,
          schema_invalid: 0,
          sdk_error: 2,
          substantive_rejection: 0,
          incomplete: 0,
          gate_failure: 0,
          legacy_unknown: 0,
        },
        feedback_applied_count: 1,
      })
      const compact = output(await tools.alg_status.execute({ run_id: "routing-archived-exact" }, context(project)))
      expect(compact.retry_routing).toMatchObject({
        sdk_errors: 6,
        feedback_routes: 1,
        archived_outcomes_unknown: 0,
        archived_feedback_routes_unknown: 0,
        complete: true,
      })
      const full = output(await tools.alg_status.execute({ run_id: "routing-archived-exact", detail: "full" }, context(project)))
      expect(full.retry_routing).toMatchObject({ sdk_errors: 6, feedback_routes: 1, complete: true })

      seedAttempts(project, "routing-archived-legacy", 6, false)
      const legacyProgress = join(runDir(project, "routing-archived-legacy"), "progress.json")
      const legacyRaw = JSON.parse(readFileSync(legacyProgress, "utf8")) as any
      delete legacyRaw.nodes.work.attempt_history_ref.outcome_counts
      delete legacyRaw.nodes.work.attempt_history_ref.feedback_applied_count
      writeFileSync(legacyProgress, `${JSON.stringify(legacyRaw)}\n`, "utf8")
      const legacy = output(await tools.alg_status.execute({ run_id: "routing-archived-legacy" }, context(project)))
      expect(legacy.retry_routing).toMatchObject({
        sdk_errors: 4,
        feedback_routes: 0,
        archived_outcomes_unknown: 2,
        archived_feedback_routes_unknown: 2,
        complete: false,
      })

      seedAttempts(project, "routing-archived-forged", 6, false)
      const forgedProgress = join(runDir(project, "routing-archived-forged"), "progress.json")
      const forgedRaw = JSON.parse(readFileSync(forgedProgress, "utf8")) as any
      const forgedCounts = forgedRaw.nodes.work.attempt_history_ref.outcome_counts
      forgedCounts.sdk_error--
      forgedCounts.passed++
      writeFileSync(forgedProgress, `${JSON.stringify(forgedRaw)}\n`, "utf8")
      expect(() => parseRunState(forgedRaw)).not.toThrow()
      const forged = output(await tools.alg_status.execute({ run_id: "routing-archived-forged" }, context(project)))
      expect(forged.error).toContain("attempt history metadata mismatch")
    } finally {
      removeProject(project)
    }
  }, 120_000)

  test("full status list hydrates every owned run and reports a precise corrupt-run failure", async () => {
    const project = tempProject()
    try {
      seedAttempts(project, "full-list-a", 5, false)
      seedAttempts(project, "full-list-b", 6, false)
      createRun({
        goal: "other owner",
        criteria: [],
        graph: oneNodeGraph(),
        projectDirectory: project,
        ownerSessionId: "other",
        runId: "full-list-other",
      })
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)

      const full = output(await tools.alg_status.execute({ list: true, detail: "full" }, context(project)))
      expect(full.runs.map((run: any) => run.run_id).sort()).toEqual(["full-list-a", "full-list-b"])
      expect(full.runs.find((run: any) => run.run_id === "full-list-a").nodes.work.attempts).toHaveLength(5)
      expect(full.runs.find((run: any) => run.run_id === "full-list-b").nodes.work.attempts).toHaveLength(6)
      expect(full.runs.every((run: any) => run.nodes.work.attempt_history_ref === undefined)).toBe(true)

      const corrupt = readManifest(project, "full-list-b")
      rmSync(referencePath(project, corrupt.nodes.work!.attempt_history_ref!))
      const failed = output(await tools.alg_status.execute({ list: true, detail: "full" }, context(project)))
      expect(failed.error).toContain("full status list failed for run full-list-b")
      expect(failed.error).toContain("missing or inaccessible")
    } finally {
      removeProject(project)
    }
  }, 120_000)

  test("owned listing reports malformed owned state without disclosing malformed other-owner state", async () => {
    const project = tempProject()
    try {
      for (const [runId, owner] of [
        ["owned-list-valid", "owner"],
        ["owned-list-malformed", "owner"],
        ["other-list-malformed", "other-owner"],
      ] as const) {
        createRun({
          goal: runId,
          criteria: [],
          graph: oneNodeGraph(),
          projectDirectory: project,
          ownerSessionId: owner,
          runId,
        })
      }
      const corruptRemainingState = (runId: string): Buffer => {
        const path = join(runDir(project, runId), "progress.json")
        const raw = JSON.parse(readFileSync(path, "utf8")) as any
        raw.criteria = [42]
        const bytes = Buffer.from(`${JSON.stringify(raw)}\n`)
        writeFileSync(path, bytes)
        return bytes
      }
      const malformedOwnedBytes = corruptRemainingState("owned-list-malformed")
      const malformedOtherBytes = corruptRemainingState("other-list-malformed")
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)

      const compact = output(await tools.alg_status.execute({ list: true }, context(project)))
      expect(compact.runs.map((run: any) => run.run_id)).toEqual(["owned-list-valid"])
      expect(compact.total).toBe(2)
      expect(compact.owned_error_count).toBe(1)
      expect(compact.owned_errors).toEqual([expect.objectContaining({ run_id: "owned-list-malformed" })])
      expect(compact.complete).toBe(false)
      expect(JSON.stringify(compact)).not.toContain("other-list-malformed")

      const full = output(await tools.alg_status.execute({ list: true, detail: "full" }, context(project)))
      expect(full.error).toContain("full status list failed for run owned-list-malformed")
      expect(full.error).not.toContain("other-list-malformed")
      expect(readFileSync(join(runDir(project, "owned-list-malformed"), "progress.json"), "utf8"))
        .toBe(malformedOwnedBytes.toString("utf8"))
      expect(readFileSync(join(runDir(project, "other-list-malformed"), "progress.json"), "utf8"))
        .toBe(malformedOtherBytes.toString("utf8"))
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("missing, corrupt, wrong-hash, escaping, and wrong-kind history/output references fail safely and clearly", async () => {
    const cases = ["missing-history", "corrupt-output", "wrong-hash", "escaping", "wrong-kind"] as const
    for (const kind of cases) {
      const project = tempProject(`alg-ref-${kind}-`)
      try {
        seedAttempts(project, `ref-${kind}`, 5, false)
        const runId = `ref-${kind}`
        const directory = runDir(project, runId)
        const progress = join(directory, "progress.json")
        const raw = JSON.parse(readFileSync(progress, "utf8")) as any
        const history = raw.nodes.work.attempt_history_ref
        const nodeOutput = raw.nodes.work.output_ref
        let untouchedOutside: string | undefined
        if (kind === "missing-history") {
          rmSync(join(project, ...history.artifact_path.split("/")))
        } else if (kind === "corrupt-output") {
          writeFileSync(join(project, ...nodeOutput.artifact_path.split("/")), "{corrupt", "utf8")
        } else if (kind === "wrong-hash") {
          const zeroHash = "0".repeat(64)
          const wrongPath = history.artifact_path.replace(history.sha256, zeroHash)
          copyFileSync(join(project, ...history.artifact_path.split("/")), join(project, ...wrongPath.split("/")))
          history.artifact_path = wrongPath
          history.sha256 = zeroHash
          writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")
        } else if (kind === "escaping") {
          untouchedOutside = join(project, "outside-sentinel.json")
          writeFileSync(untouchedOutside, "OUTSIDE", "utf8")
          history.artifact_path = "../outside-sentinel.json"
          writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")
        } else {
          history.artifact_path = `.opencode/runs/${runId}/history/work-failures-${history.sha256}.json`
          writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")
        }

        const tools = createAlgTools({
          client: inertClient(),
          project: { id: "project" },
          directory: project,
          worktree: project,
        } as never)
        const result = output(await tools.alg_status.execute({ run_id: runId, detail: "full" }, context(project)))
        expect(result.error, kind).toBeString()
        if (kind === "missing-history") expect(result.error).toContain("missing or inaccessible")
        if (kind === "corrupt-output") expect(result.error).toMatch(/not valid|size mismatch|integrity mismatch/)
        if (kind === "wrong-hash") expect(result.error).toContain("integrity mismatch")
        if (kind === "escaping") expect(result.error).toMatch(/corrupt or incompatible|safe project-relative path/)
        if (kind === "wrong-kind") expect(result.error).toMatch(/corrupt or incompatible|does not match its run\/node/)
        if (untouchedOutside) expect(readFileSync(untouchedOutside, "utf8")).toBe("OUTSIDE")
      } finally {
        removeProject(project)
      }
    }
  }, 120_000)

  test("a valid same-node failure sidecar cannot be substituted for the projected failure list", () => {
    const project = tempProject()
    try {
      seedAttempts(project, "wrong-valid-failures", 5, false)
      const progress = join(runDir(project, "wrong-valid-failures"), "progress.json")
      const raw = JSON.parse(readFileSync(progress, "utf8")) as any
      const wrongFailures = ["different but valid same-node failure"]
      const hash = sha256Json(wrongFailures)
      const relative = nodeFailuresPath("wrong-valid-failures", "work", hash)
      writeFileSync(join(project, ...relative.split("/")), canonicalJson(wrongFailures), "utf8")
      raw.nodes.work.last_failures_ref = {
        artifact_path: relative,
        sha256: hash,
        byte_size: serializedBytes(wrongFailures),
      }
      writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")
      expect(() => hydrateRunFully(parseRunState(raw))).toThrow("node failure projection mismatch")
    } finally {
      removeProject(project)
    }
  })

  test("attempt detail rejects the exact projection-only failures_commitment field before hydration", () => {
    const project = tempProject()
    try {
      seedAttempts(project, "detail-projection-only", 1, false)
      const progress = join(runDir(project, "detail-projection-only"), "progress.json")
      const raw = JSON.parse(readFileSync(progress, "utf8")) as any
      const projected = raw.nodes.work.attempts[0]
      const detail = JSON.parse(readFileSync(referencePath(project, projected.detail_ref), "utf8")) as any
      expect(detail.failures_commitment).toBeUndefined()
      expect(() => hydrateRunFully(parseRunState(raw))).not.toThrow()

      detail.failures_commitment = failureListCommitment(detail.failures)
      const hash = sha256Json(detail)
      const relative = attemptDetailPath("detail-projection-only", "work", 1, hash)
      writeFileSync(join(project, ...relative.split("/")), canonicalJson(detail), "utf8")
      projected.detail_ref = { artifact_path: relative, sha256: hash, byte_size: serializedBytes(detail) }
      writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")

      expect(() => hydrateRunFully(parseRunState(raw))).toThrow(/attempt detail.*schema mismatch.*failures_commitment|unrecognized key.*failures_commitment/i)
    } finally {
      removeProject(project)
    }
  })

  test("failure sidecars preserve canonical strings and reject padded failure text instead of trimming", () => {
    const project = tempProject()
    try {
      seedAttempts(project, "exact-failure-sidecar", 1, false)
      const progress = join(runDir(project, "exact-failure-sidecar"), "progress.json")
      const raw = JSON.parse(readFileSync(progress, "utf8")) as any
      const canonical = hydrateRunFully(parseRunState(raw))
      expect(canonical.nodes.work!.last_failures).toEqual(["exact-failure-sidecar-failure-1"])

      const padded = [" exact-failure-sidecar-failure-1 "]
      const hash = sha256Json(padded)
      const relative = nodeFailuresPath("exact-failure-sidecar", "work", hash)
      writeFileSync(join(project, ...relative.split("/")), canonicalJson(padded), "utf8")
      raw.nodes.work.last_failures_ref = {
        artifact_path: relative,
        sha256: hash,
        byte_size: serializedBytes(padded),
      }
      writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")
      expect(() => hydrateRunFully(parseRunState(raw))).toThrow("node failure detail is invalid")
    } finally {
      removeProject(project)
    }
  })

  test("root authorization sidecars accept canonical values and reject padded operation/session/path/ID fields", () => {
    const cases = [
      { name: "operation", mutate: (document: any) => { document.authorizations[0].operation = " run " } },
      { name: "session", mutate: (document: any) => { document.authorizations[0].by_session_id = " owner " } },
      { name: "path", mutate: (document: any) => { document.authorizations[0].path += " " } },
      { name: "owner-id", mutate: (document: any) => { document.owner_session_id = " owner " } },
      { name: "run-id", mutate: (document: any) => { document.run_id = ` ${document.run_id} ` } },
    ]
    for (const item of cases) {
      const project = tempProject(`alg-exact-root-${item.name}-`)
      try {
        const runId = `exact-root-${item.name}`
        const run = createRun({
          goal: `exact root ${item.name}`,
          criteria: [],
          graph: oneNodeGraph(),
          projectDirectory: project,
          ownerSessionId: "owner",
          runId,
        })
        run.filesystem_root_authorizations = Array.from({ length: 70 }, (_, index) => ({
          operation: (["plan", "run", "resume"] as const)[index % 3]!,
          by_session_id: "owner",
          authorized_at: new Date(Date.parse("2026-08-10T10:00:00.000Z") + index * 1_000).toISOString(),
          authorized: true as const,
          path: project,
        }))
        persistRun(run, project)
        const progress = join(runDir(project, runId), "progress.json")
        const raw = JSON.parse(readFileSync(progress, "utf8")) as any
        expect(hydrateRunFully(parseRunState(raw)).filesystem_root_authorizations).toHaveLength(70)

        const reference = raw.filesystem_root_authorizations_ref
        const document = JSON.parse(readFileSync(referencePath(project, reference), "utf8")) as any
        item.mutate(document)
        const hash = sha256Json(document)
        const relative = rootAuthorizationsPath(runId, hash)
        writeFileSync(join(project, ...relative.split("/")), canonicalJson(document), "utf8")
        reference.artifact_path = relative
        reference.sha256 = hash
        reference.byte_size = serializedBytes(document)
        writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")
        expect(() => hydrateRunFully(parseRunState(raw)), item.name).toThrow(/authorization history|surrounding whitespace|invalid enum|identity\/kind mismatch/i)
      } finally {
        removeProject(project)
      }
    }
  }, 120_000)

  test("same-prefix/count attempt and node failure suffix substitutions fail their independent commitments", () => {
    for (const target of ["attempt", "node"] as const) {
      const project = tempProject(`alg-failure-commitment-${target}-`)
      try {
        const run = createRun({
          goal: `failure commitment ${target}`,
          criteria: [],
          graph: oneNodeGraph(2),
          projectDirectory: project,
          ownerSessionId: "owner",
          runId: `failure-commitment-${target}`,
          mode: "dry",
        })
        const failures = Array.from({ length: 7 }, (_, index) => `shared-${index}`)
        const timestamp = "2026-08-10T10:00:00.000Z"
        const attempt: NodeAttempt = {
          attempt: 1,
          status: "failed",
          started_at: timestamp,
          finished_at: timestamp,
          failures,
          schema_ok: false,
          outcome: "schema_invalid",
        }
        run.nodes.work!.attempts = [attempt]
        run.nodes.work!.current_attempt = 1
        run.nodes.work!.status = "failed"
        run.nodes.work!.last_failures = failures
        run.global_attempts = 1
        run.status = "failed"
        run.phase = "failed"
        persistRun(run, project)

        const progress = join(runDir(project, run.run_id), "progress.json")
        const raw = JSON.parse(readFileSync(progress, "utf8")) as any
        if (target === "attempt") {
          const projected = raw.nodes.work.attempts[0]
          const original = JSON.parse(readFileSync(referencePath(project, projected.detail_ref), "utf8"))
          original.failures[6] = "different-omitted-suffix"
          const hash = sha256Json(original)
          const relative = attemptDetailPath(run.run_id, "work", 1, hash)
          writeFileSync(join(project, ...relative.split("/")), canonicalJson(original), "utf8")
          projected.detail_ref = { artifact_path: relative, sha256: hash, byte_size: serializedBytes(original) }
        } else {
          const wrong = [...failures]
          wrong[6] = "different-omitted-suffix"
          const hash = sha256Json(wrong)
          const relative = nodeFailuresPath(run.run_id, "work", hash)
          writeFileSync(join(project, ...relative.split("/")), canonicalJson(wrong), "utf8")
          raw.nodes.work.last_failures_ref = {
            artifact_path: relative,
            sha256: hash,
            byte_size: serializedBytes(wrong),
          }
        }
        writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")
        expect(() => loadRun(project, run.run_id), target).toThrow("failure commitment mismatch")
        expect(() => hydrateRunFully(parseRunState(raw)), target).toThrow("failure commitment mismatch")
      } finally {
        removeProject(project)
      }
    }
  }, 60_000)
})

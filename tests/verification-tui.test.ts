import { initNodeStates, validateGraph } from "../src/graph.ts"
import { bindTaskContract } from "../src/task-contract.ts"
import { taskEvidence } from "../src/task-evidence.ts"
import { describe, expect, test } from "bun:test"
import { openAlgRuns } from "../src/tui-runs.ts"
import { buildVerificationBasis } from "../src/verification.ts"
import { canonicalJson, sha256Json } from "../src/persistence.ts"
import { serializedBytes } from "../src/limits.ts"
import { ownerIndexRelativePath } from "../src/owner-index.ts"

function archivedVerifiedAttempt(missingBasis: boolean, compact?: "valid" | "session_mismatch" | "missing_basis") {
  const runId = "verified-archive"
  const criteria = ["required"]
  const basis = buildVerificationBasis(criteria)
  const differentBasis = { ...basis, omitted_entries: 1 }
  const detail = {
    attempt: 1, status: "failed", session_id: "checker-child",
    started_at: "2026-08-09T12:00:00.000Z", finished_at: "2026-08-09T12:00:01.000Z",
    failures: ["malformed checker output"], schema_ok: false, outcome: "schema_invalid",
    verification_basis: differentBasis,
  }
  if (compact === "missing_basis") delete (detail as { verification_basis?: unknown }).verification_basis
  const detailRef = { artifact_path: `.opencode/runs/${runId}/history/check-attempt-1-detail-${sha256Json(detail)}.json`,
    sha256: sha256Json(detail), byte_size: serializedBytes(detail) }
  const attempt = { ...detail, ...(!missingBasis ? { verification_basis: basis } : {}), detail_ref: detailRef }
  if (missingBasis || compact) delete (attempt as { verification_basis?: unknown }).verification_basis
  if (compact === "session_mismatch") attempt.session_id = "forged-child"
  const archive = { schema_version: compact ? 3 : 2, kind: "attempt_history", owner_session_id: "parent",
    run_id: runId, node_id: "check", attempts: [attempt] }
  const archiveRef = { artifact_path: `.opencode/runs/${runId}/history/check-attempts-${sha256Json(archive)}.json`,
    sha256: sha256Json(archive), byte_size: serializedBytes(archive), attempt_count: 1,
    output_count: 0, session_count: 1, failure_entries_omitted: 0, failure_texts_truncated: 0,
    error_bytes_omitted: 0, failure_commitment_count: 0 }
  const progress = { run_id: runId, owner_session_id: "parent", status: "failed", mode: "live", criteria,
    updated_at: "2026-08-09T14:00:00.000Z",
    graph: { name: "verified-archive", nodes: [{ id: "check", agent: "checker", depends_on: [], verification: { version: 1 } }] },
    nodes: { check: { id: "check", agent: "checker", status: "failed", attempts: [],
      attempt_history_ref: archiveRef, current_attempt: 1 } } }
  const index = { schema_version: 1, owner_session_id: "parent", updated_at: "2026-08-09T14:00:00.000Z",
    runs: [{ run_id: runId, updated_at: "2026-08-09T14:00:00.000Z" }] }
  const files = new Map([
    [ownerIndexRelativePath("parent"), JSON.stringify(index)],
    [`.opencode/runs/${runId}/progress.json`, JSON.stringify(progress)],
    [archiveRef.artifact_path, canonicalJson(archive)],
    [detailRef.artifact_path, canonicalJson(detail)],
  ])
  return { files }
}

function tuiApi(files: Map<string, string>) {
  const dialogs: any[] = []
  const toasts: any[] = []
  const navigations: any[] = []
  const api: any = {
    state: { path: { config: "C:/fixture", worktree: "C:/fixture", directory: "C:/fixture", state: "C:/fixture" } },
    client: { file: { read: async ({ path }: { path: string }) => files.has(path)
      ? { data: { type: "text", content: files.get(path) }, error: undefined }
      : { data: undefined, error: { message: "missing fixture" } } } },
    ui: { DialogSelect: (props: any) => { dialogs.push(props) }, toast: (value: any) => { toasts.push(value) },
      dialog: { setSize() {}, replace(render: () => unknown) { render() }, clear() {} } },
    route: { current: { name: "session", params: { sessionID: "parent" } },
      navigate: (...args: any[]) => { navigations.push(args) } },
  }
  return { api, dialogs, toasts, navigations }
}

describe("verified TUI archives", () => {
  test.each(["valid", "session_mismatch", "missing_basis"] as const)("compact v3 archive validates its exact detail before navigation: %s", async kind => {
    const fixture = archivedVerifiedAttempt(false, kind)
    const view = tuiApi(fixture.files)
    await openAlgRuns(view.api)
    view.dialogs.at(-1).onSelect(view.dialogs.at(-1).options[0])
    view.dialogs.at(-1).onSelect(view.dialogs.at(-1).options[0])
    await Bun.sleep(5)
    const attempts = view.dialogs.at(-1)
    const child = attempts.options.find((option: any) => option.value?.kind === "session")
    expect(child).toBeDefined()
    attempts.onSelect(child)
    await Bun.sleep(5)
    if (kind === "valid") {
      expect(view.navigations).toEqual([["session", { sessionID: "checker-child" }]])
    } else {
      expect(view.toasts.at(-1)).toMatchObject({ variant: "error", title: "ALG attempt unavailable",
        message: expect.stringContaining(kind === "session_mismatch" ? "session_id" : "basis") })
      expect(view.navigations).toEqual([])
    }
  })

  test("rejects an archived failed call whose pre-call basis is missing", async () => {
    const fixture = archivedVerifiedAttempt(true)
    const view = tuiApi(fixture.files)
    await openAlgRuns(view.api)
    view.dialogs.at(-1).onSelect(view.dialogs.at(-1).options[0])
    view.dialogs.at(-1).onSelect(view.dialogs.at(-1).options[0])
    await Bun.sleep(5)
    expect(view.toasts.at(-1)).toMatchObject({ variant: "error", title: "ALG archived attempts unavailable" })
    expect(view.navigations).toEqual([])
  })

  test("rejects a detail whose verification basis differs from its archive projection", async () => {
    const fixture = archivedVerifiedAttempt(false)
    const view = tuiApi(fixture.files)
    await openAlgRuns(view.api)
    view.dialogs.at(-1).onSelect(view.dialogs.at(-1).options[0])
    view.dialogs.at(-1).onSelect(view.dialogs.at(-1).options[0])
    await Bun.sleep(5)
    const attempts = view.dialogs.at(-1)
    attempts.onSelect(attempts.options.find((option: any) => option.value?.kind === "session"))
    await Bun.sleep(5)
    expect(view.toasts.at(-1)).toMatchObject({ variant: "error", title: "ALG attempt unavailable",
      message: expect.stringContaining("verification_basis") })
    expect(view.navigations).toEqual([])
  })
})


test.each(["valid", "missing", "tampered", "wrong-contract"] as const)(
  "visible task evidence is checked before navigation even without detail/output references: %s", async variant => {
    const runId = "task-ref", goal = "Report the declared result", criteria = ["Answer the question"]
    const graph = validateGraph({ name: "task-ref", nodes: [
      { id: "research", agent: "researcher", depends_on: [] },
      { id: "check", agent: "checker", depends_on: ["research"], isolated_check: true },
    ] })
    const taskContract = bindTaskContract({
      version: 1, kind: "read_only", discovery: "required", phase: "complete",
      deliverables: [{ destination: "response", producer_node: "research" }],
      verification: { checker_node: "check", execution: "none" }, preserve_paths: [],
      evidence_plan: [{ criterion: 1, observations: [{ kind: "deliverable", index: 0 }] }],
    }, goal, criteria, graph, { session_id: "parent", message_id: "origin" })
    const states = initNodeStates(graph)
    states.research!.status = "done"
    states.research!.output = { answer: "fixture" }
    const taskBaseline = { version: 1 as const, contract_sha256: taskContract.contract_sha256 }
    const observed = taskEvidence({ task_contract: taskContract, task_baseline: taskBaseline, graph, nodes: states, run_id: runId, project_directory: "C:/fixture" })!
    const evidence = variant === "wrong-contract" ? { ...observed, contract_sha256: "0".repeat(64) } : observed
    const sha256 = sha256Json(evidence)
    const reference = { artifact_path: `.opencode/runs/${runId}/artifacts/task-evidence-check-a1-${sha256}.json`,
      sha256, byte_size: serializedBytes(evidence) }
    const date = "2026-08-09T14:00:00.000Z"
    const progress = { run_id: runId, owner_session_id: "parent", status: "done", mode: "live", goal, criteria,
      criteria_locked: true, updated_at: date, graph, task_contract: taskContract, task_baseline: taskBaseline, nodes: {
        research: { id: "research", agent: "researcher", status: "done", attempts: [] },
        check: { id: "check", agent: "checker", status: "done", attempts: [{ attempt: 1, status: "done",
          started_at: date, finished_at: date, session_id: "checker-child", task_evidence_ref: reference, failures: [],
          output: { passed: true, score: 10, failures: [] }, score: 10, schema_ok: true, outcome: "passed" }] },
      } }
    const index = { schema_version: 1, owner_session_id: "parent", updated_at: date, runs: [{ run_id: runId, updated_at: date }] }
    const files = new Map([[ownerIndexRelativePath("parent"), JSON.stringify(index)],
      [`.opencode/runs/${runId}/progress.json`, JSON.stringify(progress)]])
    if (variant !== "missing") files.set(reference.artifact_path, variant === "tampered"
      ? canonicalJson({ ...evidence, requirements_sha256: "0".repeat(64) }) : canonicalJson(evidence))
    const view = tuiApi(files)
    await openAlgRuns(view.api)
    view.dialogs.at(-1).onSelect(view.dialogs.at(-1).options[0])
    const nodes = view.dialogs.at(-1)
    nodes.onSelect(nodes.options.find((option: any) => option.value?.id === "check"))
    const attempts = view.dialogs.at(-1)
    const child = attempts.options.find((option: any) => option.value === "checker-child")
    expect(child).toBeDefined()
    attempts.onSelect(child)
    await Bun.sleep(5)
    if (variant === "valid") {
      expect(view.navigations).toEqual([["session", { sessionID: "checker-child" }]])
    } else {
      expect(view.navigations).toEqual([])
      expect(view.toasts.at(-1)).toMatchObject({ variant: "error", title: "ALG attempt unavailable" })
    }
  },
)

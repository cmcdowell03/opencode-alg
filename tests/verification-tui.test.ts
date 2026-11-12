import { describe, expect, test } from "bun:test"
import { openAlgRuns } from "../src/tui-runs.ts"
import { buildVerificationBasis } from "../src/verification.ts"
import { canonicalJson, sha256Json } from "../src/persistence.ts"
import { serializedBytes } from "../src/limits.ts"
import { ownerIndexRelativePath } from "../src/owner-index.ts"

function archivedVerifiedAttempt(missingBasis: boolean) {
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
  const detailRef = { artifact_path: `.opencode/runs/${runId}/history/check-attempt-1-detail-${sha256Json(detail)}.json`,
    sha256: sha256Json(detail), byte_size: serializedBytes(detail) }
  const attempt = { ...detail, ...(!missingBasis ? { verification_basis: basis } : {}), detail_ref: detailRef }
  if (missingBasis) delete (attempt as { verification_basis?: unknown }).verification_basis
  const archive = { schema_version: 2, kind: "attempt_history", owner_session_id: "parent",
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

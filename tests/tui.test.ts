import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "jsonc-parser"
import tuiModule from "../src/tui.ts"
import serverModule from "../src/server.ts"
import { modelCatalog, openAlgModels, tui } from "../src/tui-models.ts"
import {
  MAX_TUI_ATTEMPT_OPTIONS,
  MAX_TUI_ARCHIVED_ATTEMPT_PAGE_SIZE,
  MAX_TUI_DESCRIPTION_BYTES,
  MAX_TUI_SERIALIZED_DIALOG_BYTES,
  MAX_TUI_TITLE_BYTES,
  MAX_TUI_NODE_OPTIONS,
  openAlgRuns,
} from "../src/tui-runs.ts"
import { canonicalJson, sha256Json } from "../src/persistence.ts"
import { serializedBytes } from "../src/limits.ts"
import { MAX_OWNER_INDEX_ENTRIES, ownerIndexRelativePath } from "../src/owner-index.ts"
import { removeProject, tempProject } from "./helpers.ts"
import { parseAlgToolIds } from "../scripts/live-verify.ts"
import { ALG_TUI_REGISTRATION_TOKEN } from "../src/tui-registration.ts"

const sandboxes: string[] = []
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

function sandbox(): string {
  const path = tempProject("alg-tui-")
  sandboxes.push(path)
  return path
}

function provider(id: string, models: Array<{
  id: string
  name?: string
  status?: string
  variants?: Record<string, { disabled?: boolean }>
}>): any {
  return {
    id,
    name: id.toUpperCase(),
    source: "config",
    env: [],
    options: {},
    models: Object.fromEntries(models.map((model) => [model.id, {
      id: model.id,
      providerID: id,
      name: model.name ?? model.id,
      status: model.status ?? "active",
      variants: model.variants,
    }])),
  }
}

function deepMerge(target: any, patch: any): any {
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      target[key] = deepMerge(target[key] ?? {}, value)
    } else target[key] = value
  }
  return target
}

function ownerIndex(owner: string, runIds: string[]): any {
  return {
    schema_version: 1,
    owner_session_id: owner,
    updated_at: "2026-08-09T16:00:00.000Z",
    runs: runIds.map((run_id, index) => ({
      run_id,
      updated_at: new Date(Date.parse("2026-08-09T16:00:00.000Z") - index * 1_000).toISOString(),
    })),
  }
}

function graphNode(id: string, agent = "implementer"): any {
  return { id, agent, depends_on: [] }
}

function failedAttempt(attempt: number, sessionId?: string): any {
  return {
    attempt,
    status: "failed",
    ...(sessionId ? { session_id: sessionId } : {}),
    started_at: "2026-08-09T12:00:00.000Z",
    finished_at: "2026-08-09T12:00:01.000Z",
    failures: [`legacy failure ${attempt}`],
    schema_ok: false,
  }
}

function planningProgress(runId: string, updatedAt = "2026-08-09T14:00:00.000Z"): any {
  return {
    run_id: runId,
    owner_session_id: "parent",
    status: "planning",
    updated_at: updatedAt,
    graph: { name: "legacy-planning", nodes: [graphNode("work")] },
    nodes: {
      work: { id: "work", agent: "implementer", status: "pending", attempts: [], current_attempt: 0 },
    },
  }
}

function archivedRunFixture(options: {
  runId?: string
  owner?: string
  nodeId?: string
  archived?: number
  visible?: number
  documentPatch?: Record<string, unknown>
}) {
  const runId = options.runId ?? "archived-run"
  const owner = options.owner ?? "parent"
  const nodeId = options.nodeId ?? "work"
  const archived = options.archived ?? 70
  const visible = options.visible ?? 4
  const makeAttempt = (attempt: number) => ({
    attempt,
    status: "failed",
    session_id: `${runId}-${nodeId}-session-${attempt}`,
    started_at: "2026-08-09T12:00:00.000Z",
    finished_at: "2026-08-09T12:00:01.000Z",
    failures: [`failure-${attempt}`],
    schema_ok: false,
    outcome: "schema_invalid",
  })
  const document = {
    schema_version: 2,
    kind: "attempt_history",
    owner_session_id: owner,
    run_id: runId,
    node_id: nodeId,
    attempts: Array.from({ length: archived }, (_, index) => makeAttempt(index + 1)),
    ...options.documentPatch,
  }
  const content = canonicalJson(document)
  const sha256 = sha256Json(document)
  const reference = {
    artifact_path: `.opencode/runs/${runId}/history/${nodeId}-attempts-${sha256}.json`,
    sha256,
    byte_size: serializedBytes(document),
    attempt_count: archived,
    output_count: 0,
    session_count: archived,
    failure_entries_omitted: 0,
    failure_texts_truncated: 0,
    error_bytes_omitted: 0,
    failure_commitment_count: 0,
  }
  const run = {
    run_id: runId,
    owner_session_id: owner,
    status: "failed",
    updated_at: "2026-08-09T14:00:00.000Z",
    graph: { name: "archived-navigation", nodes: [graphNode(nodeId)] },
    nodes: {
      [nodeId]: {
        id: nodeId,
        agent: "implementer",
        status: "failed",
        attempts: Array.from({ length: visible }, (_, index) =>
          makeAttempt(archived + index + 1)),
        attempt_history_ref: reference,
        current_attempt: archived + visible,
      },
    },
  }
  return { runId, owner, nodeId, run, document, content, reference }
}

function refreshArchivedFixture(fixture: ReturnType<typeof archivedRunFixture>): void {
  fixture.content = canonicalJson(fixture.document)
  fixture.reference.sha256 = sha256Json(fixture.document)
  fixture.reference.byte_size = serializedBytes(fixture.document)
  fixture.reference.output_count = (fixture.document.attempts as any[])
    .filter((attempt) => attempt.output_ref !== undefined).length
  fixture.reference.failure_commitment_count = (fixture.document.attempts as any[])
    .filter((attempt) => attempt.failures_commitment !== undefined).length
  fixture.reference.artifact_path =
    `.opencode/runs/${fixture.runId}/history/${fixture.nodeId}-attempts-${fixture.reference.sha256}.json`
}

function refreshLegacyV1FixedArchive(
  fixture: ReturnType<typeof archivedRunFixture>,
  pretty = false,
): void {
  const document = fixture.document as any
  document.schema_version = 1
  delete document.kind
  delete document.owner_session_id
  fixture.content = pretty ? `${JSON.stringify(document, null, 2)}\n` : JSON.stringify(document)
  fixture.reference.artifact_path = `.opencode/runs/${fixture.runId}/history/${fixture.nodeId}-attempts.json`
  // Fixed schema-v1 archives retain a logical JSON size and an unbound legacy
  // digest field. Formatting/newlines do not change the server-compatible size.
  fixture.reference.byte_size = serializedBytes(document)
  fixture.reference.sha256 = "0".repeat(64)
}

function referencedAttemptOutput(runId: string, nodeId: string, attempt: number, output: unknown) {
  const sha256 = sha256Json(output)
  return {
    artifact_path: `.opencode/runs/${runId}/artifacts/${nodeId}-attempt-${attempt}-output-${sha256}.json`,
    sha256,
    byte_size: serializedBytes(output),
  }
}

function legacyNestedFixedFixture(runId: string) {
  const fixture = archivedRunFixture({ runId, archived: 1, visible: 0 })
  const output = {
    summary: ["completed legacy nested archive"],
    files_touched: ["src/legacy.ts"],
    commands_run: [{ cmd: "bun test", outcome: "passed" }],
    risks: [],
    done: true,
  }
  const detail = {
    attempt: 1,
    status: "done",
    session_id: `${runId}-work-session-1`,
    started_at: "2026-08-09T12:00:00.000Z",
    finished_at: "2026-08-09T12:00:01.000Z",
    output,
    failures: [],
    schema_ok: true,
    outcome: "passed",
  }
  const outputPath = `.opencode/runs/${runId}/artifacts/work-attempt-1.json`
  const detailPath = `.opencode/runs/${runId}/history/work-attempt-1.json`
  const outputRef = {
    artifact_path: outputPath,
    sha256: sha256Json(output),
    byte_size: serializedBytes(output),
  }
  const detailRef = {
    artifact_path: detailPath,
    sha256: sha256Json(detail),
    byte_size: serializedBytes(detail),
  }
  ;(fixture.document.attempts as any[])[0] = {
    attempt: detail.attempt,
    status: detail.status,
    session_id: detail.session_id,
    started_at: detail.started_at,
    finished_at: detail.finished_at,
    output_ref: outputRef,
    detail_ref: detailRef,
    failures: [],
    schema_ok: true,
    outcome: "passed",
  }
  fixture.run.status = "done"
  ;(fixture.run.nodes.work as any).status = "done"
  refreshLegacyV1FixedArchive(fixture, true)
  fixture.reference.sha256 = sha256Json(fixture.document)
  fixture.reference.output_count = 1
  return {
    ...fixture,
    output,
    detail,
    outputRef,
    detailRef,
    outputPath,
    detailPath,
    outputContent: `${JSON.stringify(output, null, 2)}\n`,
    detailContent: `${JSON.stringify(detail, null, 2)}\n`,
  }
}

function mockApi(options: {
  configDir?: string
  config?: any
  providers?: any[]
  updateError?: unknown
  getError?: unknown
  /** Null simulates a response whose URL is unavailable. */
  responseUrl?: string | null
} = {}) {
  const config = structuredClone(options.config ?? {})
  const dialogs: any[] = []
  const toasts: any[] = []
  const layers: any[] = []
  const updates: any[] = []
  const logs: any[] = []
  const events: string[] = []
  const configDir = options.configDir ?? sandbox()
  const api: any = {
    keymap: {
      registerLayer(layer: any) {
        events.push("register")
        layers.push(layer)
        return () => {}
      },
    },
    state: {
      provider: options.providers ?? [],
      path: { config: configDir, worktree: configDir, directory: configDir, state: configDir },
    },
    client: {
      app: {
        async log(input: any) {
          events.push("log")
          logs.push(structuredClone(input))
          return { data: true, error: undefined }
        },
      },
      global: {
        config: {
          async get() {
            return options.getError
              ? { data: undefined, error: options.getError, response: { url: "" } }
              : {
                  data: structuredClone(config),
                  error: undefined,
                  response: {
                    url: options.responseUrl === undefined
                      ? "http://127.0.0.1:4096/global/config"
                      : options.responseUrl ?? "",
                  },
                }
          },
          async update(input: any) {
            updates.push(structuredClone(input))
            if (options.updateError) return { data: undefined, error: options.updateError }
            deepMerge(config, input.config)
            return { data: structuredClone(config), error: undefined }
          },
        },
      },
    },
    ui: {
      DialogSelect(props: any) {
        dialogs.push(props)
        return {} as never
      },
      toast(input: any) {
        toasts.push(input)
      },
      dialog: {
        size: "medium",
        depth: 0,
        open: false,
        setSize() {},
        replace(render: () => unknown) {
          render()
        },
        clear() {},
      },
    },
    route: {
      current: { name: "session", params: { sessionID: "parent" } },
      navigate() {},
    },
  }
  return { api, config, dialogs, toasts, layers, updates, logs, events, configDir }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Bun.sleep(5)
}

afterEach(() => {
  for (const path of sandboxes.splice(0)) removeProject(path)
})

describe("OpenCode 1.18.3 ALG TUI model picker", () => {
  test("live verifier parses only ALG IDs from raw endpoint response shapes", () => {
    expect(parseAlgToolIds('["read","alg_plan","alg_run"]')).toEqual(["alg_plan", "alg_run"])
    expect(parseAlgToolIds('{"tools":["alg_status",3,"write"]}')).toEqual(["alg_status"])
    expect(parseAlgToolIds("not-json")).toEqual([])
  })

  test("uses separate server and TUI modules and discovers ALG /alg-models through keymap", async () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"))
    expect(pkg.exports["./server"]).toBe("./src/server.ts")
    expect(pkg.exports["./tui"]).toBe("./src/tui.ts")
    expect(pkg.opencode).toEqual({ server: "./src/server.ts", tui: "./src/tui.ts" })
    expect(tuiModule.id).toBe("opencode-alg")
    expect(typeof tuiModule.tui).toBe("function")
    expect("server" in tuiModule).toBe(false)
    expect(typeof serverModule.server).toBe("function")
    expect("tui" in serverModule).toBe(false)

    const mock = mockApi()
    await tui(mock.api, undefined, {} as never)
    expect(mock.layers).toHaveLength(1)
    expect(mock.events.slice(0, 2)).toEqual(["register", "log"])
    expect(mock.logs).toHaveLength(1)
    expect(mock.logs[0]).toMatchObject({
      service: "opencode-alg",
      level: "info",
      message: ALG_TUI_REGISTRATION_TOKEN,
    })
    const command = mock.layers[0].commands[0]
    expect(command).toMatchObject({
      name: "alg.models",
      title: "Choose agent models",
      category: "ALG",
      namespace: "palette",
      slashName: "alg-models",
    })
    await command.run()
    expect(mock.dialogs[0].options.map((item: any) => item.value)).toEqual([
      "explorer",
      "researcher",
      "implementer",
      "checker",
    ])
    expect(mock.layers[0].commands[1]).toMatchObject({
      name: "alg.runs",
      title: "Browse child run sessions",
      slashName: "alg-runs",
    })
  })

  test("/alg-runs accepts a canonical legacy visible row without outcome metadata and navigates exactly", async () => {
    const mock = mockApi()
    const calls: any[] = []
    const navigations: any[] = []
    const run = {
      run_id: "run-one",
      owner_session_id: "parent",
      status: "failed",
      updated_at: "2026-08-09T12:00:00.000Z",
      graph: { name: "coding-diamond", nodes: [graphNode("explore", "explorer")] },
      model_snapshot: { explorer: { providerID: "p", modelID: "m", variant: "deep" } },
      model_resolution: { explorer: { source: "opencode-role-config", providerID: "p", modelID: "m", variant: "deep" } },
      nodes: {
        explore: {
          id: "explore",
          agent: "explorer",
          status: "failed",
          attempts: [failedAttempt(1, "child-explore-1")],
          current_attempt: 1,
        },
      },
    }
    mock.api.client.file = {
      async read(input: any) {
        calls.push(["read", input])
        return { data: { type: "text", content: JSON.stringify(
          input.path === ownerIndexRelativePath("parent") ? ownerIndex("parent", ["run-one"]) : run,
        ) }, error: undefined }
      },
    }
    mock.api.route.navigate = (name: string, params: any) => navigations.push([name, params])

    await openAlgRuns(mock.api)
    expect(calls).toEqual([
      ["read", { directory: mock.configDir, path: ownerIndexRelativePath("parent") }],
      ["read", { directory: mock.configDir, path: ".opencode/runs/run-one/progress.json" }],
    ])
    const runDialog = mock.dialogs.at(-1)
    expect(runDialog.options[0].title).toContain("run-one")
    runDialog.onSelect(runDialog.options[0])
    const nodeDialog = mock.dialogs.at(-1)
    expect(nodeDialog.options[0].title).toContain("explore · explorer · failed · 1 attempts")
    expect(nodeDialog.options[0].value).toMatchObject({
      id: "explore",
      agent: "explorer",
      status: "failed",
      attempts_total: 1,
      attempts_archived: 0,
      attempts_visible: 1,
    })
    nodeDialog.onSelect(nodeDialog.options[0])
    const attemptDialog = mock.dialogs.at(-1)
    const attemptDescription = attemptDialog.options[0].description
    expect(attemptDialog.options[0]).toMatchObject({
      title: expect.stringContaining("attempt 1 · failed · session child-explore-1"),
      value: "child-explore-1",
      description: expect.stringContaining("p/m · variant deep"),
    })
    expect(attemptDescription).toContain("child session child-explore-1")
    attemptDialog.onSelect(attemptDialog.options[0])
    expect(navigations).toEqual([["session", { sessionID: "child-explore-1" }]])
  })

  test("/alg-runs visibly rejects exact missing, extra, duplicate, and graph/state agent identities", async () => {
    const explorerOutput = {
      query: "canonical query",
      map: [{ path: "src/index.ts", role: "entry" }],
      key_hits: [],
      next: "none",
    }
    const cases = [
      {
        name: "missing-state",
        expected: "graph/node identities do not match exactly",
        mutate(progress: any) { progress.graph.nodes.push(graphNode("missing", "explorer")) },
      },
      {
        name: "extra-state",
        expected: "graph/node identities do not match exactly",
        mutate(progress: any) {
          progress.nodes.extra = { id: "extra", agent: "explorer", status: "pending", attempts: [], current_attempt: 0 }
        },
      },
      {
        name: "duplicate-graph",
        expected: "duplicate node id: work",
        mutate(progress: any) { progress.graph.nodes.push(graphNode("work")) },
      },
      {
        name: "node-id-mismatch",
        expected: "invalid node work",
        mutate(progress: any) { progress.nodes.work.id = "another-id" },
      },
      {
        name: "checker-represented-as-explorer",
        expected: "invalid node work",
        mutate(progress: any) {
          progress.status = "failed"
          progress.graph.nodes[0] = graphNode("work", "checker")
          progress.nodes.work = {
            id: "work",
            agent: "explorer",
            status: "failed",
            current_attempt: 1,
            attempts: [{
              ...failedAttempt(1, "identity-mismatch-session"),
              output: explorerOutput,
              schema_ok: true,
              outcome: "gate_failure",
            }],
          }
        },
      },
    ]
    for (const item of cases) {
      const mock = mockApi()
      const runId = `identity-${item.name}`
      const progress = planningProgress(runId)
      item.mutate(progress)
      mock.api.client.file = {
        read: async ({ path }: any) => path === ownerIndexRelativePath("parent")
          ? { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [runId])) }, error: undefined }
          : { data: { type: "text", content: JSON.stringify(progress) }, error: undefined },
      }

      await openAlgRuns(mock.api)
      expect(mock.dialogs, item.name).toEqual([])
      expect(mock.toasts.at(-1), item.name).toMatchObject({
        variant: "error",
        title: "ALG runs unavailable",
        message: expect.stringContaining(item.expected),
      })
    }
  })

  test("/alg-runs rejects strict graph omissions, unknown keys, and invalid relationships", async () => {
    const cases: Array<{
      name: string
      expected: string
      mutate(progress: any): void
    }> = [
      {
        name: "missing-depends-on",
        expected: "depends_on",
        mutate(progress) { delete progress.graph.nodes[0].depends_on },
      },
      {
        name: "unknown-graph-key",
        expected: "unknown_graph_key",
        mutate(progress) { progress.graph.unknown_graph_key = true },
      },
      {
        name: "unknown-node-key",
        expected: "unknown_node_key",
        mutate(progress) { progress.graph.nodes[0].unknown_node_key = true },
      },
      {
        name: "unknown-dependency",
        expected: "unknown dependency: absent",
        mutate(progress) { progress.graph.nodes[0].depends_on = ["absent"] },
      },
      {
        name: "forward-dependency",
        expected: "dependency later must appear before work",
        mutate(progress) {
          progress.graph.nodes = [
            { ...graphNode("work"), depends_on: ["later"] },
            graphNode("later"),
          ]
          progress.nodes.later = {
            id: "later", agent: "implementer", status: "pending", attempts: [], current_attempt: 0,
          }
        },
      },
      {
        name: "invalid-input",
        expected: "input reference does not exist: absent",
        mutate(progress) { progress.graph.nodes[0].inputs = { source: "absent.answer" } },
      },
      {
        name: "invalid-feedback",
        expected: "feedback_to must name a direct dependency",
        mutate(progress) {
          progress.graph.nodes = [graphNode("work"), {
            ...graphNode("check", "checker"),
            feedback_to: "work",
          }]
          progress.nodes.check = {
            id: "check", agent: "checker", status: "pending", attempts: [], current_attempt: 0,
          }
        },
      },
      {
        name: "missing-shell-relationship",
        expected: "gate all requires shell_gate",
        mutate(progress) {
          progress.graph.nodes[0] = {
            ...graphNode("work", "checker"),
            loop: { max_attempts: 1, gate: "all" },
          }
          progress.nodes.work.agent = "checker"
        },
      },
    ]

    for (const item of cases) {
      const mock = mockApi()
      const runId = `strict-${item.name}`
      const progress = planningProgress(runId)
      item.mutate(progress)
      mock.api.client.file = {
        read: async ({ path }: any) => path === ownerIndexRelativePath("parent")
          ? { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [runId])) }, error: undefined }
          : { data: { type: "text", content: JSON.stringify(progress) }, error: undefined },
      }

      await openAlgRuns(mock.api)
      expect(mock.dialogs, item.name).toEqual([])
      expect(mock.toasts, item.name).toHaveLength(1)
      expect(mock.toasts[0], item.name).toMatchObject({
        variant: "error",
        title: "ALG runs unavailable",
        message: expect.stringContaining(item.expected),
      })
    }
  })

  test("/alg-runs lazily pages every archived attempt with truthful counts and exact session navigation", async () => {
    const mock = mockApi()
    const fixture = archivedRunFixture({ archived: 70, visible: 4 })
    const reads: string[] = []
    const navigations: any[] = []
    mock.api.client.file = {
      read: async ({ path }: any) => {
        reads.push(path)
        if (path === ownerIndexRelativePath("parent")) {
          return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [fixture.runId])) }, error: undefined }
        }
        if (path === `.opencode/runs/${fixture.runId}/progress.json`) {
          return { data: { type: "text", content: JSON.stringify(fixture.run) }, error: undefined }
        }
        if (path === fixture.reference.artifact_path) {
          return { data: { type: "text", content: fixture.content }, error: undefined }
        }
        return { data: undefined, error: { response: { status: 404 }, message: "unexpected read" } }
      },
    }
    mock.api.route.navigate = (name: string, params: any) => navigations.push([name, params])

    await openAlgRuns(mock.api)
    expect(reads).toHaveLength(2)
    const runDialog = mock.dialogs.at(-1)
    expect(runDialog.options[0].description).toContain("74 attempts")
    runDialog.onSelect(runDialog.options[0])
    const nodeDialog = mock.dialogs.at(-1)
    expect(nodeDialog.options[0].title).toContain("74 attempts (70 archived, 4 visible)")
    expect(nodeDialog.options[0].description).toContain("70 archived · 4 visible")
    nodeDialog.onSelect(nodeDialog.options[0])
    await settle()
    expect(reads).toEqual([
      ownerIndexRelativePath("parent"),
      `.opencode/runs/${fixture.runId}/progress.json`,
      fixture.reference.artifact_path,
    ])

    const firstPage = mock.dialogs.at(-1)
    expect(firstPage.title).toContain("page 1/3")
    expect(firstPage.options).toHaveLength(MAX_TUI_ARCHIVED_ATTEMPT_PAGE_SIZE + 1)
    firstPage.onSelect(firstPage.options.at(-1))
    const secondPage = mock.dialogs.at(-1)
    expect(secondPage.title).toContain("page 2/3")
    expect(secondPage.options).toHaveLength(MAX_TUI_ARCHIVED_ATTEMPT_PAGE_SIZE + 2)
    secondPage.onSelect(secondPage.options.at(-1))
    const thirdPage = mock.dialogs.at(-1)
    expect(thirdPage.title).toContain("page 3/3")
    expect(thirdPage.options).toHaveLength(11)
    const finalAttempt = thirdPage.options.find((option: any) => option.title.includes("attempt 74 ·"))
    expect(finalAttempt.value).toEqual({ kind: "session", session_id: "archived-run-work-session-74" })
    thirdPage.onSelect(finalAttempt)
    expect(navigations).toEqual([["session", { sessionID: "archived-run-work-session-74" }]])

    for (const dialog of [runDialog, nodeDialog, firstPage, secondPage, thirdPage]) {
      expect(Buffer.byteLength(JSON.stringify(dialog))).toBeLessThanOrEqual(MAX_TUI_SERIALIZED_DIALOG_BYTES)
      expect(dialog.options.length).toBeLessThanOrEqual(MAX_TUI_ARCHIVED_ATTEMPT_PAGE_SIZE + 2 || MAX_TUI_NODE_OPTIONS)
      for (const option of dialog.options) {
        expect(Buffer.byteLength(option.title)).toBeLessThanOrEqual(MAX_TUI_TITLE_BYTES)
        if (option.description) {
          expect(Buffer.byteLength(option.description)).toBeLessThanOrEqual(MAX_TUI_DESCRIPTION_BYTES)
        }
      }
    }
    expect(reads.filter((path) => path === fixture.reference.artifact_path)).toHaveLength(1)
  })

  test("/alg-runs safely reports missing, corrupt, raw-byte, hash, owner, kind, run, and node archive failures", async () => {
    const cases = ["missing", "corrupt", "raw-byte", "hash", "owner", "kind", "run", "node"] as const
    for (const failure of cases) {
      const mock = mockApi()
      const patch = failure === "owner"
        ? { owner_session_id: "another-parent" }
        : failure === "kind"
          ? { kind: "not-attempt-history" }
          : failure === "run"
            ? { run_id: "another-run" }
            : failure === "node"
              ? { node_id: "another-node" }
              : undefined
      const fixture = archivedRunFixture({ runId: `archive-${failure}`, documentPatch: patch })
      if (failure === "raw-byte") {
        fixture.content = `${JSON.stringify(fixture.document, null, 2)}\n`
      }
      if (failure === "hash") {
        fixture.reference.sha256 = "0".repeat(64)
        fixture.reference.artifact_path = `.opencode/runs/${fixture.runId}/history/work-attempts-${fixture.reference.sha256}.json`
      }
      let archiveReads = 0
      mock.api.client.file = {
        read: async ({ path }: any) => {
          if (path === ownerIndexRelativePath("parent")) {
            return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [fixture.runId])) }, error: undefined }
          }
          if (path === `.opencode/runs/${fixture.runId}/progress.json`) {
            return { data: { type: "text", content: JSON.stringify(fixture.run) }, error: undefined }
          }
          archiveReads++
          if (failure === "missing") {
            return { data: undefined, error: { response: { status: 404 }, message: "archive missing" } }
          }
          return {
            data: { type: "text", content: failure === "corrupt" ? "{corrupt" : fixture.content },
            error: undefined,
          }
        },
      }

      await openAlgRuns(mock.api)
      const runDialog = mock.dialogs.at(-1)
      runDialog.onSelect(runDialog.options[0])
      const nodeDialog = mock.dialogs.at(-1)
      nodeDialog.onSelect(nodeDialog.options[0])
      await settle()
      expect(mock.toasts.at(-1), failure).toMatchObject({
        variant: "error",
        title: "ALG archived attempts unavailable",
      })
      expect(Buffer.byteLength(mock.toasts.at(-1).message)).toBeLessThanOrEqual(1_024)
      expect(archiveReads).toBe(1)
    }
  })

  test("/alg-runs parses a genuine pretty-printed schema-v1 fixed archive and navigates its session", async () => {
    const mock = mockApi()
    const fixture = archivedRunFixture({ runId: "legacy-fixed-navigation", archived: 2, visible: 0 })
    refreshLegacyV1FixedArchive(fixture, true)
    const reads: string[] = []
    const navigations: any[] = []
    mock.api.client.file = {
      read: async ({ path }: any) => {
        reads.push(path)
        if (path === ownerIndexRelativePath("parent")) {
          return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [fixture.runId])) }, error: undefined }
        }
        if (path === `.opencode/runs/${fixture.runId}/progress.json`) {
          return { data: { type: "text", content: JSON.stringify(fixture.run) }, error: undefined }
        }
        if (path === fixture.reference.artifact_path) {
          return { data: { type: "text", content: fixture.content }, error: undefined }
        }
        return { data: undefined, error: { response: { status: 404 }, message: "unexpected read" } }
      },
    }
    mock.api.route.navigate = (name: string, params: any) => navigations.push([name, params])

    await openAlgRuns(mock.api)
    expect(reads).toEqual([
      ownerIndexRelativePath("parent"),
      `.opencode/runs/${fixture.runId}/progress.json`,
    ])
    mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
    mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
    await settle()

    expect(reads.at(-1)).toBe(fixture.reference.artifact_path)
    const integrityWarnings = mock.toasts.filter((item) => item.title === "Weaker legacy archive integrity")
    expect(integrityWarnings).toHaveLength(1)
    expect(integrityWarnings[0]).toMatchObject({
      variant: "warning",
      message: expect.stringContaining("nested sidecars are checked lazily before navigation and no SHA integrity is claimed"),
    })
    const attemptDialog = mock.dialogs.at(-1)
    const attempt = attemptDialog.options.find((option: any) => option.title.includes("attempt 2 ·"))
    attemptDialog.onSelect(attempt)
    expect(navigations).toEqual([["session", { sessionID: "legacy-fixed-navigation-work-session-2" }]])
  })

  test("/alg-runs rejects malformed, missing, wrong-path/run/node, non-strict, and logical-size-invalid schema-v1 archives", async () => {
    for (const failure of [
      "malformed", "missing", "wrong-path", "wrong-run", "wrong-node", "extra-field", "logical-size",
    ] as const) {
      const mock = mockApi()
      const fixture = archivedRunFixture({ runId: `legacy-fixed-${failure}`, archived: 1, visible: 0 })
      refreshLegacyV1FixedArchive(fixture, true)
      if (failure === "wrong-run") fixture.document.run_id = "other-run"
      if (failure === "wrong-node") fixture.document.node_id = "other-node"
      if (failure === "extra-field") (fixture.document as any).kind = "attempt_history"
      if (["wrong-run", "wrong-node", "extra-field"].includes(failure)) {
        fixture.content = `${JSON.stringify(fixture.document, null, 2)}\n`
        fixture.reference.byte_size = serializedBytes(fixture.document)
      }
      if (failure === "wrong-path") {
        fixture.reference.artifact_path = `.opencode/runs/${fixture.runId}/history/other-attempts.json`
      }
      if (failure === "malformed") fixture.content = "{malformed"
      if (failure === "logical-size") fixture.reference.byte_size++
      let archiveReads = 0
      mock.api.client.file = {
        read: async ({ path }: any) => {
          if (path === ownerIndexRelativePath("parent")) {
            return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [fixture.runId])) }, error: undefined }
          }
          if (path === `.opencode/runs/${fixture.runId}/progress.json`) {
            return { data: { type: "text", content: JSON.stringify(fixture.run) }, error: undefined }
          }
          archiveReads++
          if (failure === "missing") {
            return { data: undefined, error: { response: { status: 404 }, message: "legacy archive missing" } }
          }
          return { data: { type: "text", content: fixture.content }, error: undefined }
        },
      }

      await openAlgRuns(mock.api)
      if (failure === "wrong-path") {
        expect(mock.dialogs, failure).toEqual([])
        expect(archiveReads, failure).toBe(0)
        expect(mock.toasts.at(-1), failure).toMatchObject({
          variant: "error",
          title: "ALG runs unavailable",
        })
        continue
      }
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      await settle()
      expect(archiveReads, failure).toBe(1)
      expect(mock.toasts.at(-1), failure).toMatchObject({
        variant: "error",
        title: "ALG archived attempts unavailable",
      })
      expect(mock.toasts.some((item) => item.title === "Weaker legacy archive integrity"), failure).toBe(false)
    }
  })

  test("/alg-runs lazily validates real schema-v1 fixed nested detail/output and deduplicates its weaker warning", async () => {
    const mock = mockApi()
    const fixture = legacyNestedFixedFixture("legacy-nested-success")
    const reads: Array<{ directory: string; path: string }> = []
    const navigations: any[] = []
    mock.api.client.file = {
      read: async (input: any) => {
        reads.push(structuredClone(input))
        if (input.path === ownerIndexRelativePath("parent")) {
          return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [fixture.runId])) }, error: undefined }
        }
        if (input.path === `.opencode/runs/${fixture.runId}/progress.json`) {
          return { data: { type: "text", content: JSON.stringify(fixture.run) }, error: undefined }
        }
        if (input.path === fixture.reference.artifact_path) {
          return { data: { type: "text", content: fixture.content }, error: undefined }
        }
        if (input.path === fixture.detailPath) {
          return { data: { type: "text", content: fixture.detailContent }, error: undefined }
        }
        if (input.path === fixture.outputPath) {
          return { data: { type: "text", content: fixture.outputContent }, error: undefined }
        }
        return { data: undefined, error: { response: { status: 404 }, message: "unexpected path" } }
      },
    }
    mock.api.route.navigate = (...args: any[]) => navigations.push(args)

    await openAlgRuns(mock.api)
    expect(reads.map((item) => item.path)).toEqual([
      ownerIndexRelativePath("parent"),
      `.opencode/runs/${fixture.runId}/progress.json`,
    ])
    const runDialog = mock.dialogs.at(-1)
    runDialog.onSelect(runDialog.options[0])
    const nodeDialog = mock.dialogs.at(-1)
    nodeDialog.onSelect(nodeDialog.options[0])
    await settle()
    expect(reads.map((item) => item.path)).toEqual([
      ownerIndexRelativePath("parent"),
      `.opencode/runs/${fixture.runId}/progress.json`,
      fixture.reference.artifact_path,
    ])

    const attemptDialog = mock.dialogs.at(-1)
    attemptDialog.onSelect(attemptDialog.options.find((option: any) => option.value?.kind === "session"))
    await settle()
    expect(reads.map((item) => item.path)).toEqual([
      ownerIndexRelativePath("parent"),
      `.opencode/runs/${fixture.runId}/progress.json`,
      fixture.reference.artifact_path,
      fixture.detailPath,
      fixture.outputPath,
    ])
    expect(reads.every((item) => item.directory === mock.configDir)).toBe(true)
    expect(navigations).toEqual([["session", { sessionID: `${fixture.runId}-work-session-1` }]])

    // Reopen the same archive and select it again. Sidecars remain invocation-
    // cached and the command emits exactly one weaker-integrity warning.
    runDialog.onSelect(runDialog.options[0])
    mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
    await settle()
    mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options.find((option: any) => option.value?.kind === "session"))
    await settle()
    expect(reads.filter((item) => item.path === fixture.detailPath)).toHaveLength(1)
    expect(reads.filter((item) => item.path === fixture.outputPath)).toHaveLength(1)
    expect(mock.toasts.filter((item) => item.title === "Weaker legacy archive integrity")).toHaveLength(1)
  })

  test("/alg-runs rejects missing/malformed/escaping/wrong-identity/agent/logical-size legacy nested refs", async () => {
    const cases = [
      { name: "missing-detail", stage: "navigation" },
      { name: "malformed-output", stage: "navigation" },
      { name: "escape", stage: "archive" },
      { name: "wrong-node", stage: "archive" },
      { name: "wrong-attempt-path", stage: "archive" },
      { name: "wrong-attempt-detail", stage: "navigation" },
      { name: "wrong-agent-output", stage: "navigation" },
      { name: "logical-size", stage: "navigation" },
    ] as const

    for (const item of cases) {
      const mock = mockApi()
      const fixture = legacyNestedFixedFixture(`legacy-nested-${item.name}`)
      const projected = (fixture.document.attempts as any[])[0]
      let detailContent = fixture.detailContent
      let outputContent = fixture.outputContent
      if (item.name === "escape") projected.output_ref.artifact_path = "../work-attempt-1.json"
      if (item.name === "wrong-node") {
        projected.output_ref.artifact_path = `.opencode/runs/${fixture.runId}/artifacts/other-attempt-1.json`
      }
      if (item.name === "wrong-attempt-path") {
        projected.detail_ref.artifact_path = `.opencode/runs/${fixture.runId}/history/work-attempt-2.json`
      }
      if (item.name === "wrong-attempt-detail") {
        detailContent = JSON.stringify({ ...fixture.detail, attempt: 2 })
      }
      if (item.name === "wrong-agent-output") {
        outputContent = JSON.stringify({ passed: true, failures: [], score: 9 })
        projected.output_ref.byte_size = serializedBytes(JSON.parse(outputContent))
      }
      if (item.name === "logical-size") projected.output_ref.byte_size++
      if (["escape", "wrong-node", "wrong-attempt-path", "wrong-agent-output", "logical-size"].includes(item.name)) {
        fixture.content = `${JSON.stringify(fixture.document, null, 2)}\n`
        fixture.reference.byte_size = serializedBytes(fixture.document)
        fixture.reference.sha256 = sha256Json(fixture.document)
      }

      const reads: string[] = []
      const navigations: any[] = []
      mock.api.route.navigate = (...args: any[]) => navigations.push(args)
      mock.api.client.file = {
        read: async ({ path }: any) => {
          reads.push(path)
          if (path === ownerIndexRelativePath("parent")) {
            return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [fixture.runId])) }, error: undefined }
          }
          if (path === `.opencode/runs/${fixture.runId}/progress.json`) {
            return { data: { type: "text", content: JSON.stringify(fixture.run) }, error: undefined }
          }
          if (path === fixture.reference.artifact_path) {
            return { data: { type: "text", content: fixture.content }, error: undefined }
          }
          if (path === fixture.detailPath) {
            if (item.name === "missing-detail") {
              return { data: undefined, error: { response: { status: 404 }, message: "missing legacy detail" } }
            }
            return { data: { type: "text", content: detailContent }, error: undefined }
          }
          if (path === fixture.outputPath) {
            return {
              data: { type: "text", content: item.name === "malformed-output" ? "{malformed" : outputContent },
              error: undefined,
            }
          }
          return { data: undefined, error: { response: { status: 404 }, message: "unexpected path" } }
        },
      }

      await openAlgRuns(mock.api)
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      await settle()
      if (item.stage === "archive") {
        expect(mock.toasts.at(-1), item.name).toMatchObject({
          variant: "error",
          title: "ALG archived attempts unavailable",
        })
        expect(reads, item.name).not.toContain(fixture.detailPath)
      } else {
        const dialog = mock.dialogs.at(-1)
        dialog.onSelect(dialog.options.find((option: any) => option.value?.kind === "session"))
        await settle()
        expect(mock.toasts.at(-1), item.name).toMatchObject({
          variant: "error",
          title: "ALG attempt unavailable",
        })
      }
      expect(navigations, item.name).toEqual([])
    }
  })

  test("/alg-runs rejects authoritative terminal, schema, output, outcome, score, and reference violations without navigation", async () => {
    const cases = [
      { name: "terminal-timing", mutate: (attempt: any) => { delete attempt.finished_at } },
      { name: "terminal-schema", mutate: (attempt: any) => { delete attempt.schema_ok } },
      {
        name: "arbitrary-output",
        mutate: (attempt: any) => {
          attempt.output = { arbitrary: true }
          attempt.schema_ok = true
          attempt.outcome = "gate_failure"
        },
      },
      { name: "invalid-outcome", mutate: (attempt: any) => { attempt.outcome = "passed" } },
      { name: "invalid-score", mutate: (attempt: any) => { attempt.score = 5 } },
      {
        name: "invalid-reference",
        mutate: (attempt: any) => {
          attempt.output_ref = {
            artifact_path: ".opencode/runs/wrong/artifacts/wrong.json",
            sha256: "0".repeat(64),
            byte_size: 1,
          }
          attempt.schema_ok = true
          attempt.outcome = "gate_failure"
        },
      },
    ]
    for (const item of cases) {
      const mock = mockApi()
      const fixture = archivedRunFixture({ runId: `archive-schema-${item.name}`, archived: 1, visible: 0 })
      item.mutate((fixture.document.attempts as any[])[0])
      fixture.content = canonicalJson(fixture.document)
      fixture.reference.sha256 = sha256Json(fixture.document)
      fixture.reference.byte_size = serializedBytes(fixture.document)
      fixture.reference.artifact_path =
        `.opencode/runs/${fixture.runId}/history/${fixture.nodeId}-attempts-${fixture.reference.sha256}.json`
      const navigations: any[] = []
      mock.api.route.navigate = (...args: any[]) => navigations.push(args)
      mock.api.client.file = {
        read: async ({ path }: any) => {
          if (path === ownerIndexRelativePath("parent")) {
            return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [fixture.runId])) }, error: undefined }
          }
          if (path === `.opencode/runs/${fixture.runId}/progress.json`) {
            return { data: { type: "text", content: JSON.stringify(fixture.run) }, error: undefined }
          }
          return { data: { type: "text", content: fixture.content }, error: undefined }
        },
      }

      await openAlgRuns(mock.api)
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      await settle()
      expect(mock.toasts.at(-1), item.name).toMatchObject({
        variant: "error",
        title: "ALG archived attempts unavailable",
        message: expect.stringContaining("authoritative attempt schema"),
      })
      expect(navigations, item.name).toEqual([])
    }
  })

  test("/alg-runs validates reference-only checker score and substantive outcome before archived navigation", async () => {
    const cases = [
      { name: "score-mismatch", score: 9, outcome: "substantive_rejection", navigates: false },
      { name: "valid", score: 3, outcome: "substantive_rejection", navigates: true },
    ] as const
    for (const item of cases) {
      const mock = mockApi()
      const fixture = archivedRunFixture({ runId: `checker-ref-${item.name}`, archived: 1, visible: 0 })
      const checkerOutput = { passed: false, failures: ["substantive failure"], score: 3 }
      const outputRef = referencedAttemptOutput(fixture.runId, fixture.nodeId, 1, checkerOutput)
      ;(fixture.run.nodes.work as any).agent = "checker"
      ;(fixture.run.graph.nodes[0] as any).agent = "checker"
      ;(fixture.document.attempts as any[])[0] = {
        attempt: 1,
        status: "failed",
        session_id: `${fixture.runId}-checker-session`,
        started_at: "2026-08-09T12:00:00.000Z",
        finished_at: "2026-08-09T12:00:01.000Z",
        output_ref: outputRef,
        failures: ["substantive failure"],
        score: item.score,
        schema_ok: true,
        outcome: item.outcome,
      }
      refreshArchivedFixture(fixture)
      const reads: string[] = []
      const navigations: any[] = []
      mock.api.route.navigate = (...args: any[]) => navigations.push(args)
      mock.api.client.file = {
        read: async ({ path }: any) => {
          reads.push(path)
          if (path === ownerIndexRelativePath("parent")) {
            return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [fixture.runId])) }, error: undefined }
          }
          if (path === `.opencode/runs/${fixture.runId}/progress.json`) {
            return { data: { type: "text", content: JSON.stringify(fixture.run) }, error: undefined }
          }
          if (path === fixture.reference.artifact_path) {
            return { data: { type: "text", content: fixture.content }, error: undefined }
          }
          if (path === outputRef.artifact_path) {
            return { data: { type: "text", content: canonicalJson(checkerOutput) }, error: undefined }
          }
          return { data: undefined, error: { response: { status: 404 }, message: "unexpected path" } }
        },
      }

      await openAlgRuns(mock.api)
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      await settle()
      const attemptDialog = mock.dialogs.at(-1)
      attemptDialog.onSelect(attemptDialog.options.find((option: any) => option.value?.kind === "session"))
      await settle()

      expect(reads.filter((path) => path === outputRef.artifact_path), item.name).toHaveLength(1)
      expect(navigations, item.name).toHaveLength(item.navigates ? 1 : 0)
      if (!item.navigates) {
        expect(mock.toasts.at(-1), item.name).toMatchObject({
          variant: "error",
          title: "ALG attempt unavailable",
        })
      }
    }
  })

  test("/alg-runs rejects ungated/schema-only checker gate_failure and accepts valid shell/all gate_failure", async () => {
    for (const gate of ["ungated", "schema", "shell", "all"] as const) {
      const mock = mockApi()
      const runId = `checker-gate-${gate}`
      const checkerOutput = { passed: true, failures: [], score: 8 }
      const definition: any = graphNode("check", "checker")
      if (gate !== "ungated") definition.loop = { max_attempts: 1, gate }
      if (gate === "shell" || gate === "all") definition.shell_gate = { cmd: "bun test" }
      const progress = {
        run_id: runId,
        owner_session_id: "parent",
        status: "failed",
        mode: "live",
        updated_at: "2026-08-09T14:00:00.000Z",
        graph: { name: `checker-${gate}`, nodes: [definition] },
        nodes: {
          check: {
            id: "check",
            agent: "checker",
            status: "failed",
            current_attempt: 1,
            attempts: [{
              attempt: 1,
              status: "failed",
              session_id: `${runId}-session`,
              started_at: "2026-08-09T12:00:00.000Z",
              finished_at: "2026-08-09T12:00:01.000Z",
              output: checkerOutput,
              failures: ["shell gate failed"],
              score: 8,
              shell_ok: false,
              schema_ok: true,
              outcome: "gate_failure",
            }],
          },
        },
      }
      const navigations: any[] = []
      mock.api.route.navigate = (...args: any[]) => navigations.push(args)
      mock.api.client.file = {
        read: async ({ path }: any) => path === ownerIndexRelativePath("parent")
          ? { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [runId])) }, error: undefined }
          : { data: { type: "text", content: JSON.stringify(progress) }, error: undefined },
      }

      await openAlgRuns(mock.api)
      if (gate === "ungated" || gate === "schema") {
        expect(mock.dialogs, gate).toEqual([])
        expect(mock.toasts.at(-1), gate).toMatchObject({
          variant: "error",
          title: "ALG runs unavailable",
          message: expect.stringContaining("actual live shell/all graph gate"),
        })
      } else {
        mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
        mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
        mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
        expect(navigations, gate).toEqual([["session", { sessionID: `${runId}-session` }]])
      }
    }
  })

  test("/alg-runs enforces inline checker passed, score, and substantive relationships", async () => {
    const cases = [
      {
        name: "score-mismatch",
        output: { passed: false, failures: ["rejected"], score: 3 },
        score: 4,
        status: "failed",
        failures: ["rejected"],
        outcome: "substantive_rejection",
        expected: "checker attempt score must match its output",
      },
      {
        name: "passed-substantive",
        output: { passed: true, failures: [], score: 8 },
        score: 8,
        status: "failed",
        failures: ["forged rejection"],
        outcome: "substantive_rejection",
        expected: "substantive_rejection outcome requires passed=false checker output",
      },
      {
        name: "rejected-passed",
        output: { passed: false, failures: ["rejected"], score: 3 },
        score: 3,
        status: "done",
        failures: [],
        outcome: "passed",
        expected: "passed outcome requires passed=true checker output",
      },
    ] as const
    for (const item of cases) {
      const mock = mockApi()
      const runId = `inline-checker-${item.name}`
      const progress = {
        run_id: runId,
        owner_session_id: "parent",
        status: item.status === "done" ? "done" : "failed",
        mode: "live",
        updated_at: "2026-08-09T14:00:00.000Z",
        graph: { name: "inline-checker", nodes: [graphNode("check", "checker")] },
        nodes: {
          check: {
            id: "check",
            agent: "checker",
            status: item.status,
            current_attempt: 1,
            attempts: [{
              attempt: 1,
              status: item.status,
              session_id: `${runId}-session`,
              started_at: "2026-08-09T12:00:00.000Z",
              finished_at: "2026-08-09T12:00:01.000Z",
              output: item.output,
              failures: item.failures,
              score: item.score,
              schema_ok: true,
              outcome: item.outcome,
            }],
          },
        },
      }
      mock.api.client.file = {
        read: async ({ path }: any) => path === ownerIndexRelativePath("parent")
          ? { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [runId])) }, error: undefined }
          : { data: { type: "text", content: JSON.stringify(progress) }, error: undefined },
      }

      await openAlgRuns(mock.api)
      expect(mock.dialogs, item.name).toEqual([])
      expect(mock.toasts.at(-1), item.name).toMatchObject({
        variant: "error",
        title: "ALG runs unavailable",
        message: expect.stringContaining(item.expected),
      })
    }
  })

  test("/alg-runs enforces referenced checker passed, score, and substantive relationships on navigation", async () => {
    const cases = [
      {
        name: "score-mismatch",
        output: { passed: false, failures: ["rejected"], score: 3 },
        score: 4,
        status: "failed",
        failures: ["rejected"],
        outcome: "substantive_rejection",
      },
      {
        name: "passed-substantive",
        output: { passed: true, failures: [], score: 8 },
        score: 8,
        status: "failed",
        failures: ["forged rejection"],
        outcome: "substantive_rejection",
      },
      {
        name: "rejected-passed",
        output: { passed: false, failures: ["rejected"], score: 3 },
        score: 3,
        status: "done",
        failures: [],
        outcome: "passed",
      },
    ] as const
    for (const item of cases) {
      const mock = mockApi()
      const fixture = archivedRunFixture({ runId: `referenced-checker-${item.name}`, archived: 1, visible: 0 })
      const outputRef = referencedAttemptOutput(fixture.runId, fixture.nodeId, 1, item.output)
      ;(fixture.run.graph.nodes[0] as any).agent = "checker"
      ;(fixture.run.nodes.work as any).agent = "checker"
      ;(fixture.document.attempts as any[])[0] = {
        attempt: 1,
        status: item.status,
        session_id: `${fixture.runId}-session`,
        started_at: "2026-08-09T12:00:00.000Z",
        finished_at: "2026-08-09T12:00:01.000Z",
        output_ref: outputRef,
        failures: item.failures,
        score: item.score,
        schema_ok: true,
        outcome: item.outcome,
      }
      refreshArchivedFixture(fixture)
      const navigations: any[] = []
      mock.api.route.navigate = (...args: any[]) => navigations.push(args)
      mock.api.client.file = {
        read: async ({ path }: any) => {
          if (path === ownerIndexRelativePath("parent")) {
            return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [fixture.runId])) }, error: undefined }
          }
          if (path === `.opencode/runs/${fixture.runId}/progress.json`) {
            return { data: { type: "text", content: JSON.stringify(fixture.run) }, error: undefined }
          }
          if (path === fixture.reference.artifact_path) {
            return { data: { type: "text", content: fixture.content }, error: undefined }
          }
          return { data: { type: "text", content: canonicalJson(item.output) }, error: undefined }
        },
      }

      await openAlgRuns(mock.api)
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      await settle()
      const attemptDialog = mock.dialogs.at(-1)
      const session = attemptDialog.options.find((option: any) => option.value?.kind === "session")
      attemptDialog.onSelect(session)
      await settle()
      expect(navigations, item.name).toEqual([])
      expect(mock.toasts.at(-1), item.name).toMatchObject({ variant: "error", title: "ALG attempt unavailable" })
    }
  })

  test("/alg-runs rejects malformed referenced checker metadata and matching-hash malformed output", async () => {
    for (const kind of ["reference", "content"] as const) {
      const mock = mockApi()
      const fixture = archivedRunFixture({ runId: `checker-malformed-${kind}`, archived: 1, visible: 0 })
      const output = kind === "content"
        ? { arbitrary: true }
        : { passed: false, failures: ["failure"], score: 2 }
      const outputRef: any = referencedAttemptOutput(fixture.runId, fixture.nodeId, 1, output)
      if (kind === "reference") outputRef.unknown = true
      ;(fixture.run.nodes.work as any).agent = "checker"
      ;(fixture.run.graph.nodes[0] as any).agent = "checker"
      ;(fixture.document.attempts as any[])[0] = {
        attempt: 1,
        status: "failed",
        session_id: `${fixture.runId}-session`,
        started_at: "2026-08-09T12:00:00.000Z",
        finished_at: "2026-08-09T12:00:01.000Z",
        output_ref: outputRef,
        failures: ["failure"],
        score: 2,
        schema_ok: true,
        outcome: "substantive_rejection",
      }
      refreshArchivedFixture(fixture)
      const navigations: any[] = []
      mock.api.route.navigate = (...args: any[]) => navigations.push(args)
      mock.api.client.file = {
        read: async ({ path }: any) => {
          if (path === ownerIndexRelativePath("parent")) {
            return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [fixture.runId])) }, error: undefined }
          }
          if (path === `.opencode/runs/${fixture.runId}/progress.json`) {
            return { data: { type: "text", content: JSON.stringify(fixture.run) }, error: undefined }
          }
          if (path === fixture.reference.artifact_path) {
            return { data: { type: "text", content: fixture.content }, error: undefined }
          }
          return { data: { type: "text", content: canonicalJson(output) }, error: undefined }
        },
      }

      await openAlgRuns(mock.api)
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
      await settle()
      if (kind === "content") {
        mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options.find((option: any) => option.value?.kind === "session"))
        await settle()
        expect(mock.toasts.at(-1)).toMatchObject({ title: "ALG attempt unavailable", variant: "error" })
      } else {
        expect(mock.toasts.at(-1)).toMatchObject({ title: "ALG archived attempts unavailable", variant: "error" })
      }
      expect(navigations).toEqual([])
    }
  })

  test("/alg-runs validates visible reference-only checker output before navigation", async () => {
    const mock = mockApi()
    const runId = "visible-checker-reference"
    const checkerOutput = { passed: false, failures: ["visible rejection"], score: 2 }
    const outputRef = referencedAttemptOutput(runId, "check", 1, checkerOutput)
    const progress = {
      run_id: runId,
      owner_session_id: "parent",
      status: "failed",
      mode: "live",
      updated_at: "2026-08-09T14:00:00.000Z",
      graph: { name: "visible-checker", nodes: [{ id: "check", agent: "checker", depends_on: [] }] },
      nodes: {
        check: {
          id: "check",
          agent: "checker",
          status: "failed",
          current_attempt: 1,
          attempts: [{
            attempt: 1,
            status: "failed",
            session_id: "visible-checker-session",
            started_at: "2026-08-09T12:00:00.000Z",
            finished_at: "2026-08-09T12:00:01.000Z",
            output_ref: outputRef,
            failures: ["visible rejection"],
            score: 8,
            schema_ok: true,
            outcome: "substantive_rejection",
          }],
        },
      },
    }
    const navigations: any[] = []
    mock.api.route.navigate = (...args: any[]) => navigations.push(args)
    mock.api.client.file = {
      read: async ({ path }: any) => {
        if (path === ownerIndexRelativePath("parent")) {
          return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [runId])) }, error: undefined }
        }
        if (path === `.opencode/runs/${runId}/progress.json`) {
          return { data: { type: "text", content: JSON.stringify(progress) }, error: undefined }
        }
        return { data: { type: "text", content: canonicalJson(checkerOutput) }, error: undefined }
      },
    }

    await openAlgRuns(mock.api)
    mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
    mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
    mock.dialogs.at(-1).onSelect(mock.dialogs.at(-1).options[0])
    await settle()
    expect(navigations).toEqual([])
    expect(mock.toasts.at(-1)).toMatchObject({ title: "ALG attempt unavailable", variant: "error" })
  })

  test("/alg-runs toasts for no current parent, no owned runs, and SDK errors", async () => {
    const noParent = mockApi()
    noParent.api.route.current = { name: "home" }
    await openAlgRuns(noParent.api)
    expect(noParent.toasts.at(-1)).toMatchObject({ variant: "info", title: "ALG runs unavailable" })

    const empty = mockApi()
    empty.api.client.file = {
      read: async () => ({ data: { type: "text", content: JSON.stringify(ownerIndex("parent", [])) }, error: undefined }),
    }
    await openAlgRuns(empty.api)
    expect(empty.toasts.at(-1)).toMatchObject({ variant: "info", title: "No ALG runs" })

    const failed = mockApi()
    failed.api.client.file = {
      read: async () => ({ data: undefined, error: { response: { status: 503 }, message: "offline index" } }),
    }
    failed.api.client.find = {
      files: async () => ({ data: undefined, error: { response: { status: 503 }, message: "offline" } }),
    }
    await openAlgRuns(failed.api)
    expect(failed.toasts.at(-1)).toMatchObject({ variant: "error", title: "ALG runs unavailable" })
    expect(failed.toasts.at(-1).message).toContain("503")
  })

  test("/alg-runs uses the bounded owner index with thousands of unrelated runs never listed or read", async () => {
    const mock = mockApi()
    const unrelated = Array.from({ length: 2_000 }, (_, index) => `unrelated-${index}`)
    let active = 0
    let maximumActive = 0
    let reads = 0
    let listCalls = 0
    mock.api.client.file = {
      list: async () => {
        listCalls++
        return { data: unrelated.map((name) => ({ name, type: "directory" })), error: undefined }
      },
      read: async ({ path }: any) => {
        if (path === ownerIndexRelativePath("parent")) {
          return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", ["a-current-parent", "b-current-parent-offset"])) }, error: undefined }
        }
        reads++
        active++
        maximumActive = Math.max(maximumActive, active)
        await Promise.resolve()
        active--
        const runId = path.split("/").at(-2)
        const content = runId === "a-current-parent" || runId === "b-current-parent-offset"
          ? planningProgress(
              runId,
              // The offset timestamp is lexically later but chronologically
              // earlier, proving sorting uses the actual instant.
              runId === "a-current-parent"
                ? "2026-08-09T14:00:00.000Z"
                : "2026-08-09T15:00:00.000+02:00",
            )
          : { owner_session_id: "another-parent" }
        return { data: { type: "text", content: JSON.stringify(content) }, error: undefined }
      },
    }

    await openAlgRuns(mock.api)
    expect(listCalls).toBe(0)
    expect(reads).toBe(2)
    expect(maximumActive).toBeLessThanOrEqual(8)
    expect(mock.dialogs.at(-1).options.map((option: any) => option.value.run_id))
      .toEqual(["a-current-parent", "b-current-parent-offset"])
  })

  test("/alg-runs legacy fallback applies finite server limits and caps progress reads despite oversized responses", async () => {
    const mock = mockApi()
    const findCalls: any[] = []
    let search = 0
    let progressReads = 0
    mock.api.client.find = {
      files: async (input: any) => {
        findCalls.push(structuredClone(input))
        const group = search++
        return {
          data: Array.from({ length: 1_000 }, (_, index) =>
            `.opencode/runs/candidate-${group}-${index.toString().padStart(4, "0")}/progress.json`),
          error: undefined,
        }
      },
    }
    mock.api.client.file = {
      read: async ({ path }: any) => {
        if (path === ownerIndexRelativePath("parent")) {
          return { data: undefined, error: { response: { status: 404 }, message: "legacy project" } }
        }
        progressReads++
        return { data: { type: "text", content: JSON.stringify({ owner_session_id: "another-parent" }) }, error: undefined }
      },
    }

    await openAlgRuns(mock.api)
    expect(findCalls).toHaveLength(3)
    expect(findCalls.every((call) =>
      call.directory === mock.configDir &&
      call.type === "file" &&
      typeof call.query === "string" && call.query.includes(".opencode/runs") && call.query.includes("progress.json") &&
      Number.isInteger(call.limit) && call.limit > 0 && call.limit <= MAX_OWNER_INDEX_ENTRIES)).toBe(true)
    expect(findCalls.reduce((sum, call) => sum + call.limit, 0)).toBe(MAX_OWNER_INDEX_ENTRIES)
    expect(progressReads).toBe(MAX_OWNER_INDEX_ENTRIES)
    expect(mock.toasts.map(({ variant, title, message }) => ({ variant, title, message }))).toEqual([
      {
        variant: "warning",
        title: "Using bounded legacy ALG discovery",
        message: `Owner run index is missing; using bounded legacy discovery capped at ${MAX_OWNER_INDEX_ENTRIES} candidate progress files.`,
      },
      {
        variant: "info",
        title: "No ALG runs",
        message: "No recent ALG runs are owned by this parent session.",
      },
    ])
  })

  test("/alg-runs detects a missing owner index from the SDK result response status", async () => {
    const mock = mockApi()
    const findCalls: any[] = []
    mock.api.client.find = {
      files: async (input: any) => {
        findCalls.push(input)
        return { data: [".opencode/runs/response-status-run/progress.json"], error: undefined }
      },
    }
    mock.api.client.file = {
      read: async ({ path }: any) => path === ownerIndexRelativePath("parent")
        ? {
            data: undefined,
            error: { name: "NotFound", message: "ordinary body without status" },
            response: { status: 404 },
          }
        : {
            data: { type: "text", content: JSON.stringify(planningProgress("response-status-run")) },
            error: undefined,
          },
    }

    await openAlgRuns(mock.api)
    expect(findCalls).toHaveLength(3)
    expect(mock.dialogs.at(-1).options[0].value.run_id).toBe("response-status-run")
    expect(mock.toasts.at(-1)).toMatchObject({
      variant: "warning",
      title: "Using bounded legacy ALG discovery",
      message: expect.stringContaining("Owner run index is missing"),
    })
  })

  test("/alg-runs does not classify non-404 SDK response errors as a missing index", async () => {
    const mock = mockApi()
    mock.api.client.find = {
      files: async () => ({ data: [".opencode/runs/non404-run/progress.json"], error: undefined }),
    }
    mock.api.client.file = {
      read: async ({ path }: any) => path === ownerIndexRelativePath("parent")
        ? {
            data: undefined,
            error: { name: "ServiceUnavailable", message: "ordinary body without status" },
            response: { status: 503 },
          }
        : {
            data: { type: "text", content: JSON.stringify(planningProgress("non404-run")) },
            error: undefined,
          },
    }

    await openAlgRuns(mock.api)
    expect(mock.dialogs.at(-1).options[0].value.run_id).toBe("non404-run")
    expect(mock.toasts.at(-1)).toMatchObject({
      variant: "warning",
      title: "Some ALG runs unavailable",
      message: expect.stringContaining("503"),
    })
  })

  test("/alg-runs legacy fallback rejects unrelated, traversal, absolute, and non-progress paths", async () => {
    const mock = mockApi()
    const progressPaths: string[] = []
    mock.api.client.find = {
      files: async () => ({
        data: [
          "../progress.json",
          ".opencode/runs/../progress.json",
          ".opencode/runs/_owners/progress.json",
          ".opencode/runs/valid-owned/artifact.json",
          ".opencode/runs/valid-owned/progress.json/extra",
          "other/.opencode/runs/unrelated/progress.json",
          "C:/project/.opencode/runs/absolute/progress.json",
          ".opencode/runs/valid-owned/progress.json",
        ],
        error: undefined,
      }),
    }
    mock.api.client.file = {
      read: async ({ path }: any) => {
        if (path === ownerIndexRelativePath("parent")) {
          return { data: undefined, error: { response: { status: 404 }, message: "legacy project" } }
        }
        progressPaths.push(path)
        return { data: { type: "text", content: JSON.stringify(planningProgress("valid-owned")) }, error: undefined }
      },
    }

    await openAlgRuns(mock.api)
    expect(progressPaths).toEqual([".opencode/runs/valid-owned/progress.json"])
    expect(mock.dialogs.at(-1).options.map((option: any) => option.value.run_id)).toEqual(["valid-owned"])
    expect(mock.toasts.map(({ variant, title, message }) => ({ variant, title, message }))).toEqual([{
      variant: "warning",
      title: "Using bounded legacy ALG discovery",
      message: `Owner run index is missing; using bounded legacy discovery capped at ${MAX_OWNER_INDEX_ENTRIES} candidate progress files.`,
    }])
  })

  test("/alg-runs legacy fallback sorts its bounded candidate set by actual updated_at before limiting results", async () => {
    const mock = mockApi()
    const ordinary = Array.from({ length: 21 }, (_, index) => `a-old-${index.toString().padStart(2, "0")}`)
    const candidates = [...ordinary, "z-most-recent"]
    let progressReads = 0
    mock.api.client.find = {
      files: async () => ({
        data: candidates.map((runId) => `.opencode/runs/${runId}/progress.json`),
        error: undefined,
      }),
    }
    mock.api.client.file = {
      read: async ({ path }: any) => {
        if (path === ownerIndexRelativePath("parent")) {
          return { data: undefined, error: { response: { status: 404 }, message: "legacy project" } }
        }
        progressReads++
        const runId = path.split("/").at(-2)
        const updatedAt = runId === "z-most-recent"
          ? "2026-08-10T18:00:00.000Z"
          : new Date(Date.parse("2026-08-09T18:00:00.000Z") - Number(runId.slice(-2)) * 1_000).toISOString()
        return { data: { type: "text", content: JSON.stringify(planningProgress(runId, updatedAt)) }, error: undefined }
      },
    }

    await openAlgRuns(mock.api)
    const shown = mock.dialogs.at(-1).options.map((option: any) => option.value.run_id)
    expect(progressReads).toBe(candidates.length)
    expect(shown).toHaveLength(20)
    expect(shown[0]).toBe("z-most-recent")
    expect(shown).not.toContain("a-old-20")
  })

  test("/alg-runs surfaces a malformed index and recovers through the bounded fallback", async () => {
    const mock = mockApi()
    mock.api.client.find = {
      files: async () => ({ data: [".opencode/runs/legacy-owned/progress.json"], error: undefined }),
    }
    mock.api.client.file = {
      read: async ({ path }: any) => {
        if (path === ownerIndexRelativePath("parent")) {
          return { data: { type: "text", content: JSON.stringify({ schema_version: 1, owner_session_id: "parent", runs: "broken" }) }, error: undefined }
        }
        return { data: { type: "text", content: JSON.stringify(planningProgress("legacy-owned")) }, error: undefined }
      },
    }

    await openAlgRuns(mock.api)
    expect(mock.dialogs.at(-1).options[0].value.run_id).toBe("legacy-owned")
    expect(mock.toasts.at(-1)).toMatchObject({
      variant: "warning",
      title: "Some ALG runs unavailable",
      message: expect.stringContaining("Malformed owner run index"),
    })
  })

  test("/alg-runs visibly reports parseable malformed owned progress", async () => {
    const mock = mockApi()
    mock.api.client.file = {
      read: async ({ path }: any) => {
        if (path === ownerIndexRelativePath("parent")) {
          return { data: { type: "text", content: JSON.stringify(ownerIndex("parent", ["good-run", "malformed-run"])) }, error: undefined }
        }
        const runId = path.split("/").at(-2)
        const content = runId === "good-run"
          ? planningProgress(runId)
          : {
              ...planningProgress(runId),
              updated_at: "not-a-timestamp",
            }
        return { data: { type: "text", content: JSON.stringify(content) }, error: undefined }
      },
    }

    await openAlgRuns(mock.api)
    expect(mock.dialogs.at(-1).options).toHaveLength(1)
    expect(mock.toasts.at(-1)).toMatchObject({
      variant: "warning",
      title: "Some ALG runs unavailable",
      message: expect.stringContaining("malformed-run"),
    })
  })

  test("/alg-runs toasts for a run with no attempts and an attempt without a child session", async () => {
    const noAttempts = mockApi()
    noAttempts.api.client.file = {
      read: async ({ path }: any) => ({
        data: { type: "text", content: JSON.stringify({
          ...(path === ownerIndexRelativePath("parent")
            ? ownerIndex("parent", ["empty-run"])
            : {
                ...planningProgress("empty-run"),
              }),
        }) },
        error: undefined,
      }),
    }
    await openAlgRuns(noAttempts.api)
    noAttempts.dialogs.at(-1).onSelect(noAttempts.dialogs.at(-1).options[0])
    expect(noAttempts.toasts.at(-1)).toMatchObject({ variant: "info", title: "No ALG attempts" })

    const unavailable = mockApi()
    unavailable.api.client.file = {
      read: async ({ path }: any) => ({
        data: { type: "text", content: JSON.stringify(path === ownerIndexRelativePath("parent")
          ? ownerIndex("parent", ["unavailable-run"])
          : {
          run_id: "unavailable-run",
          owner_session_id: "parent",
          status: "failed",
          updated_at: "2026-08-09T14:00:00.000Z",
          graph: { name: "legacy-unavailable", nodes: [graphNode("work")] },
          nodes: {
            work: {
              id: "work",
              agent: "implementer",
              status: "failed",
              attempts: [failedAttempt(1)],
              current_attempt: 1,
            },
          },
        }) },
        error: undefined,
      }),
    }
    await openAlgRuns(unavailable.api)
    unavailable.dialogs.at(-1).onSelect(unavailable.dialogs.at(-1).options[0])
    unavailable.dialogs.at(-1).onSelect(unavailable.dialogs.at(-1).options[0])
    const option = unavailable.dialogs.at(-1).options[0]
    expect(option).toMatchObject({ value: null, disabled: true })
    unavailable.dialogs.at(-1).onSelect(option)
    expect(unavailable.toasts.at(-1)).toMatchObject({ variant: "info", title: "Child session unavailable" })
  })

  test("/alg-runs bounds node and attempt dialogs before navigating the selected session", async () => {
    const mock = mockApi()
    const navigations: any[] = []
    const nodeCount = MAX_TUI_NODE_OPTIONS
    const attemptCount = MAX_TUI_ATTEMPT_OPTIONS + 20
    const nodes = Object.fromEntries(Array.from({ length: nodeCount }, (_, nodeIndex) => {
      const id = `node-${nodeIndex.toString().padStart(2, "0")}`
      return [id, {
        id,
        agent: "explorer",
        status: "failed",
        attempts: Array.from({ length: attemptCount }, (_, attemptIndex) =>
          failedAttempt(attemptIndex + 1, `${id}-session-${attemptIndex + 1}`)),
        current_attempt: attemptCount,
      }]
    }))
    const run = {
      run_id: "many-node-attempts",
      owner_session_id: "parent",
      status: "failed",
      updated_at: "2026-08-09T14:00:00.000Z",
      graph: { name: "strict-maximum", nodes: Object.keys(nodes).map((id) => graphNode(id, "explorer")) },
      model_snapshot: {
        explorer: {
          providerID: "provider-".repeat(80),
          modelID: "model-".repeat(100),
          variant: "variant-".repeat(80),
        },
      },
      nodes,
    }
    mock.api.client.file = {
      read: async ({ path }: any) => ({
        data: { type: "text", content: JSON.stringify(
          path === ownerIndexRelativePath("parent")
            ? ownerIndex("parent", [run.run_id])
            : run,
        ) },
        error: undefined,
      }),
    }
    mock.api.route.navigate = (name: string, params: any) => navigations.push([name, params])

    await openAlgRuns(mock.api)
    const runDialog = mock.dialogs.at(-1)
    expect(runDialog.options).toHaveLength(1)
    runDialog.onSelect(runDialog.options[0])
    const nodeDialog = mock.dialogs.at(-1)
    expect(nodeDialog.options).toHaveLength(MAX_TUI_NODE_OPTIONS)
    expect(nodeDialog.options[0].title).toContain(`${attemptCount} attempts`)
    const selectedNode = nodeDialog.options[MAX_TUI_NODE_OPTIONS - 1]
    nodeDialog.onSelect(selectedNode)
    const attemptDialog = mock.dialogs.at(-1)
    expect(attemptDialog.options).toHaveLength(MAX_TUI_ATTEMPT_OPTIONS)
    const selectedAttempt = attemptDialog.options[MAX_TUI_ATTEMPT_OPTIONS - 1]
    expect(selectedAttempt.title).toContain(`session node-63-session-${MAX_TUI_ATTEMPT_OPTIONS}`)
    attemptDialog.onSelect(selectedAttempt)

    expect(mock.dialogs.map((dialog) => dialog.options.length)).toEqual([
      1,
      MAX_TUI_NODE_OPTIONS,
      MAX_TUI_ATTEMPT_OPTIONS,
    ])
    expect(mock.toasts).toEqual(expect.arrayContaining([
      expect.objectContaining({ variant: "warning", title: "Some ALG runs unavailable" }),
      expect.objectContaining({ variant: "warning", title: "ALG attempt list truncated" }),
    ]))
    for (const dialog of [runDialog, nodeDialog, attemptDialog]) {
      expect(dialog.options.length).toBeLessThanOrEqual(
        dialog === attemptDialog ? MAX_TUI_ATTEMPT_OPTIONS : MAX_TUI_NODE_OPTIONS,
      )
      expect(Buffer.byteLength(JSON.stringify(dialog))).toBeLessThanOrEqual(MAX_TUI_SERIALIZED_DIALOG_BYTES)
      for (const option of dialog.options) {
        expect(Buffer.byteLength(option.title)).toBeLessThanOrEqual(MAX_TUI_TITLE_BYTES)
        if (option.description) {
          expect(Buffer.byteLength(option.description)).toBeLessThanOrEqual(MAX_TUI_DESCRIPTION_BYTES)
        }
      }
    }
    expect(navigations).toEqual([["session", { sessionID: `node-63-session-${MAX_TUI_ATTEMPT_OPTIONS}` }]])
  })

  test("/alg-runs rejects a malformed legacy visible row instead of bypassing the authoritative parser", async () => {
    const mock = mockApi()
    const runId = "malformed-legacy-visible"
    const progress = {
      run_id: runId,
      owner_session_id: "parent",
      status: "failed",
      updated_at: "2026-08-09T16:00:00.000Z",
      graph: { name: "malformed-legacy", nodes: [graphNode("work")] },
      nodes: {
        work: {
          id: "work",
          agent: "implementer",
          status: "failed",
          current_attempt: 1,
          // This was formerly accepted by the no-output navigation fallback.
          attempts: [{ attempt: 1, status: "failed", session_id: "must-not-navigate" }],
        },
      },
    }
    mock.api.client.file = {
      read: async ({ path }: any) => path === ownerIndexRelativePath("parent")
        ? { data: { type: "text", content: JSON.stringify(ownerIndex("parent", [runId])) }, error: undefined }
        : { data: { type: "text", content: JSON.stringify(progress) }, error: undefined },
    }
    const navigations: any[] = []
    mock.api.route.navigate = (...args: any[]) => navigations.push(args)

    await openAlgRuns(mock.api)
    expect(mock.toasts).toHaveLength(1)
    expect(mock.toasts[0]).toMatchObject({ variant: "error", title: "ALG runs unavailable" })
    expect(mock.toasts[0].message).toContain("invalid persisted attempt")
    expect(mock.dialogs).toEqual([])
    expect(navigations).toEqual([])
  })

  test("all four roles open a searchable picker and display current global selection", async () => {
    const config = {
      agent: {
        explorer: { model: "p/explore", variant: "deep" },
        researcher: { model: "p/research" },
        implementer: { model: "p/implement" },
        checker: { model: "p/check" },
      },
    }
    const mock = mockApi({ config, providers: [provider("p", [{ id: "model" }])] })
    for (const role of ["explorer", "researcher", "implementer", "checker"]) {
      await openAlgModels(mock.api)
      const roleDialog = mock.dialogs.at(-1)
      expect(roleDialog.options.find((item: any) => item.value === role).description).toContain(config.agent[role as keyof typeof config.agent].model)
      expect(roleDialog.options.find((item: any) => item.value === role).description).toContain(
        role === "explorer" ? "deep" : "Default model effort",
      )
      roleDialog.onSelect(roleDialog.options.find((item: any) => item.value === role))
      const modelDialog = mock.dialogs.at(-1)
      expect(modelDialog.title).toContain(config.agent[role as keyof typeof config.agent].model)
      expect(modelDialog.placeholder).toContain("Search")
      expect(modelDialog.current).toBe(config.agent[role as keyof typeof config.agent].model)
    }
  })

  test("catalog uses connected providers, excludes deprecated models, and includes inherit", async () => {
    const providers = [
      provider("alpha", [
        {
          id: "good",
          name: "Good",
          variants: { zeta: {}, disabled: { disabled: true }, alpha: {} },
        },
        { id: "old", name: "Old", status: "deprecated" },
      ]),
      provider("beta", [{ id: "beta-model" }]),
    ]
    expect(modelCatalog(providers as never).map((item) => item.value)).toEqual([
      "alpha/good",
      "beta/beta-model",
    ])
    expect(modelCatalog(providers as never)[0]!.variants).toEqual(["alpha", "zeta"])
    const mock = mockApi({ providers })
    await openAlgModels(mock.api)
    const roles = mock.dialogs.at(-1)
    roles.onSelect(roles.options[0])
    const choices = mock.dialogs.at(-1).options
    expect(choices[0].value).toBeNull()
    expect(choices[0].title).toBe("Inherit OpenCode default")
    expect(choices.map((item: any) => item.value)).not.toContain("alpha/old")
  })

  test("a catalog model with variants opens a searchable second picker and patches exact effort", async () => {
    const mock = mockApi({
      config: { agent: { explorer: { model: "p/m", variant: "zeta" } } },
      responseUrl: "https://remote.example/global/config",
      providers: [provider("p", [{
        id: "m",
        variants: { zeta: {}, disabled: { disabled: true }, alpha: {} },
      }])],
    })
    await openAlgModels(mock.api)
    const roles = mock.dialogs.at(-1)
    roles.onSelect(roles.options.find((item: any) => item.value === "explorer"))
    const models = mock.dialogs.at(-1)
    models.onSelect(models.options.find((item: any) => item.value === "p/m"))

    expect(mock.updates).toEqual([])
    const efforts = mock.dialogs.at(-1)
    expect(efforts.placeholder).toContain("Search")
    expect(efforts.current).toBe("zeta")
    expect(efforts.options.map((item: any) => item.value)).toEqual([null, "alpha", "zeta"])
    expect(efforts.options[0].title).toBe("Default model effort")
    efforts.onSelect(efforts.options.find((item: any) => item.value === "alpha"))
    await settle()

    expect(mock.updates).toEqual([{
      config: { agent: { explorer: { model: "p/m", variant: "alpha" } } },
    }])
    expect(mock.toasts.at(-1)).toMatchObject({ variant: "success" })
    expect(mock.toasts.at(-1).message).toContain("alpha")
    expect(mock.toasts.at(-1).message).toContain("restart OpenCode")
  })

  test("saves one global role through the official API without changing other config", async () => {
    const mock = mockApi({
      config: {
        username: "keep-me",
        provider: { custom: { options: { keep: true } } },
        agent: {
          explorer: { model: "old/explorer", description: "keep" },
          checker: { model: "old/checker" },
        },
      },
      providers: [provider("new", [{ id: "implementer-model" }])],
      responseUrl: null,
    })
    await openAlgModels(mock.api)
    const roles = mock.dialogs.at(-1)
    roles.onSelect(roles.options.find((item: any) => item.value === "implementer"))
    const models = mock.dialogs.at(-1)
    models.onSelect(models.options.find((item: any) => item.value === "new/implementer-model"))
    await settle()

    expect(mock.updates).toEqual([{ config: { agent: { implementer: { model: "new/implementer-model" } } } }])
    expect(mock.config.username).toBe("keep-me")
    expect(mock.config.provider.custom.options.keep).toBe(true)
    expect(mock.config.agent.explorer).toEqual({ model: "old/explorer", description: "keep" })
    expect(mock.config.agent.checker.model).toBe("old/checker")
    expect(mock.config.agent.implementer.model).toBe("new/implementer-model")
    expect(mock.toasts.at(-1)).toMatchObject({ variant: "success", title: "ALG models saved" })
    expect(mock.toasts.at(-1).message).toContain("restart OpenCode")
  })

  test("inherit structurally clears that role's model and variant in one plan and creates an exact backup", async () => {
    const configDir = sandbox()
    const file = join(configDir, "opencode.jsonc")
    const before = `{
  // preserve this comment
  "username": "keep",
  "agent": {
    "explorer": { "model": "old/explorer", "variant": "deep", "description": "keep description" },
    "checker": { "model": "old/checker" },
  },
}
`
    writeFileSync(file, before)
    const mock = mockApi({
      configDir,
      config: {
        agent: {
          explorer: { model: "old/explorer", variant: "deep" },
          checker: { model: "old/checker" },
        },
      },
    })
    await openAlgModels(mock.api)
    const roles = mock.dialogs.at(-1)
    roles.onSelect(roles.options.find((item: any) => item.value === "explorer"))
    const models = mock.dialogs.at(-1)
    models.onSelect(models.options.find((item: any) => item.value === null))
    await settle()

    const after = readFileSync(file, "utf8")
    const data = parse(after) as any
    expect(after).toContain("// preserve this comment")
    expect(data.username).toBe("keep")
    expect(data.agent.explorer.model).toBeUndefined()
    expect(data.agent.explorer.variant).toBeUndefined()
    expect(data.agent.explorer.description).toBe("keep description")
    expect(data.agent.checker.model).toBe("old/checker")
    const names = readdirSync(configDir).filter((name) => name.startsWith("opencode.jsonc.alg-backup-"))
    expect(names).toHaveLength(1)
    expect(readFileSync(join(configDir, names[0]!), "utf8")).toBe(before)
    expect(mock.updates).toEqual([])
    expect(mock.toasts.at(-1).variant).toBe("success")
    expect(mock.toasts.at(-1).message).toContain("restart OpenCode")
  })

  test("default effort atomically sets a changed model and deletes variant with BOM/comment/exact-backup preservation", async () => {
    const configDir = sandbox()
    const file = join(configDir, "opencode.jsonc")
    const text = `{
  // keep this comment
  "username": "keep",
  "agent": {
    "explorer": { "model": "p/old", "variant": "deep", "description": "keep" },
    "checker": { "model": "p/check", "variant": "other" },
  },
}
`
    const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)])
    writeFileSync(file, before)
    const mock = mockApi({
      configDir,
      config: { agent: { explorer: { model: "p/old", variant: "deep" } } },
      providers: [provider("p", [{ id: "new", variants: { deep: {}, light: {} } }])],
    })
    await openAlgModels(mock.api)
    const roles = mock.dialogs.at(-1)
    roles.onSelect(roles.options.find((item: any) => item.value === "explorer"))
    const models = mock.dialogs.at(-1)
    models.onSelect(models.options.find((item: any) => item.value === "p/new"))
    const efforts = mock.dialogs.at(-1)
    efforts.onSelect(efforts.options.find((item: any) => item.value === null))
    await settle()

    expect(mock.updates).toEqual([])
    const bytes = readFileSync(file)
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    const after = bytes.subarray(3).toString("utf8")
    const data = parse(after) as any
    expect(after).toContain("// keep this comment")
    expect(data.username).toBe("keep")
    expect(data.agent.explorer).toEqual({ model: "p/new", description: "keep" })
    expect(data.agent.checker).toEqual({ model: "p/check", variant: "other" })
    const backups = readdirSync(configDir).filter((name) => name.startsWith("opencode.jsonc.alg-backup-"))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(configDir, backups[0]!))).toEqual(before)
    expect(mock.toasts.at(-1).message).toContain("Default model effort")
  })

  test("non-loopback response rejects a stale exact-match local file without API call or write", async () => {
    const configDir = sandbox()
    const file = join(configDir, "opencode.jsonc")
    const before = `{"agent":{"explorer":{"model":"p/m","variant":"deep"}}}\n`
    writeFileSync(file, before)
    const defaultMock = mockApi({
      configDir,
      config: { agent: { explorer: { model: "p/m", variant: "deep" } } },
      providers: [provider("p", [{ id: "m", variants: { deep: {} } }])],
      responseUrl: "https://remote.example/global/config",
    })
    await openAlgModels(defaultMock.api)
    let dialog = defaultMock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === "explorer"))
    dialog = defaultMock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === "p/m"))
    dialog = defaultMock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === null))
    await settle()
    expect(defaultMock.updates).toEqual([])
    expect(defaultMock.toasts.at(-1)).toMatchObject({ variant: "error" })
    expect(defaultMock.toasts.at(-1).message).toContain("attached/remote")
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(readdirSync(configDir).filter((name) => name.includes("alg-backup"))).toEqual([])
  })

  test("unavailable URL, ambiguous sources, and mismatched local role values fail closed", async () => {
    const cases: Array<{
      name: string
      responseUrl?: string | null
      files: Record<string, string>
      message: string
    }> = [
      {
        name: "unavailable-url",
        responseUrl: null,
        files: { "opencode.jsonc": `{"agent":{"checker":{"model":"p/check","variant":"strict"}}}\n` },
        message: "response URL unavailable",
      },
      {
        name: "ambiguous",
        files: {
          "config.json": `{"agent":{"checker":{"model":"p/check","variant":"strict"}}}\n`,
          "opencode.jsonc": `{"agent":{"checker":{"model":"p/check","variant":"strict"}}}\n`,
        },
        message: "ambiguous or split",
      },
      {
        name: "mismatched",
        files: { "opencode.jsonc": `{"agent":{"checker":{"model":"p/other","variant":"strict"}}}\n` },
        message: "does not match",
      },
    ]
    for (const item of cases) {
      const configDir = sandbox()
      for (const [name, text] of Object.entries(item.files)) writeFileSync(join(configDir, name), text)
      const before = Object.fromEntries(Object.keys(item.files).map((name) => [name, readFileSync(join(configDir, name), "utf8")]))
      const mock = mockApi({
        configDir,
        config: { agent: { checker: { model: "p/check", variant: "strict" } } },
        responseUrl: item.responseUrl,
      })
      await openAlgModels(mock.api)
      let dialog = mock.dialogs.at(-1)
      dialog.onSelect(dialog.options.find((option: any) => option.value === "checker"))
      dialog = mock.dialogs.at(-1)
      dialog.onSelect(dialog.options.find((option: any) => option.value === null))
      await settle()
      expect(mock.updates, item.name).toEqual([])
      expect(mock.toasts.at(-1).message, item.name).toContain(item.message)
      expect(readdirSync(configDir).filter((name) => name.includes("alg-backup")), item.name).toEqual([])
      for (const [name, text] of Object.entries(before)) {
        expect(readFileSync(join(configDir, name), "utf8"), item.name).toBe(text)
      }
    }
  })

  test("save and global-read failures produce error toasts", async () => {
    const saveMock = mockApi({
      providers: [provider("p", [{ id: "m" }])],
      updateError: { message: "denied" },
    })
    await openAlgModels(saveMock.api)
    const roles = saveMock.dialogs.at(-1)
    roles.onSelect(roles.options[0])
    const models = saveMock.dialogs.at(-1)
    models.onSelect(models.options.find((item: any) => item.value === "p/m"))
    await settle()
    expect(saveMock.toasts.at(-1)).toMatchObject({ variant: "error", title: "ALG models not saved" })
    expect(saveMock.toasts.at(-1).message).toContain("denied")

    const readMock = mockApi({ getError: { message: "offline" } })
    await openAlgModels(readMock.api)
    expect(readMock.toasts.at(-1)).toMatchObject({ variant: "error", title: "ALG models unavailable" })
    expect(readMock.toasts.at(-1).message).toContain("offline")
  })

  test("explicit-variant API failure leaves the local source untouched", async () => {
    const configDir = sandbox()
    const file = join(configDir, "opencode.jsonc")
    const before = `{"agent":{"explorer":{"model":"p/m","variant":"deep"}}}\n`
    writeFileSync(file, before)
    const mock = mockApi({
      configDir,
      config: { agent: { explorer: { model: "p/m", variant: "deep" } } },
      providers: [provider("p", [{ id: "m", variants: { deep: {}, light: {} } }])],
      updateError: { message: "write denied" },
    })
    await openAlgModels(mock.api)
    let dialog = mock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === "explorer"))
    dialog = mock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === "p/m"))
    dialog = mock.dialogs.at(-1)
    dialog.onSelect(dialog.options.find((item: any) => item.value === "light"))
    await settle()
    expect(mock.updates).toEqual([{
      config: { agent: { explorer: { model: "p/m", variant: "light" } } },
    }])
    expect(readFileSync(file, "utf8")).toBe(before)
    expect(readdirSync(configDir).filter((name) => name.includes("alg-backup"))).toEqual([])
    expect(mock.toasts.at(-1).message).toContain("write denied")
  })
})

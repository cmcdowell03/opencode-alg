import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { createRun, loadRunForOwner, readNodeArtifactOutput } from "../src/store.ts"
import { executeRun, prepareRunForResume } from "../src/executor.ts"
import { OperationalRuntime } from "../src/operational-runtime.ts"
import { recordInvestigationReview, requireInvestigationReview } from "../src/investigation-review.ts"
import { InvestigationStore, type InvestigationMcpPort, type InvestigationWorkInput } from "../src/investigation/index.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { getTemplate } from "../src/templates.ts"
import type { NodePromptOpts } from "../src/sessions.ts"
import { readSyntheticCatalogPage, syntheticFrontier, syntheticInvestigationCatalog } from "./fixtures/investigation-catalog.ts"
import { executeContext, removeProject } from "./helpers.ts"

const projects: string[] = []
afterEach(() => { for (const path of projects.splice(0)) removeProject(path) })
function project() { const path = realpathSync.native(mkdtempSync(join(import.meta.dir, ".investigation-acceptance-"))); projects.push(path); return path }

const workInput: InvestigationWorkInput = {
  operation: "bounded-read", recipe_version: "synthetic-catalog-v1", parameters: { scope: "line-A/shift-1" },
  query: { source: "synthetic-catalog", families: ["chamber", "material", "inspection-artifact", "insufficient-evidence"] },
  source_dependencies: ["synthetic-catalog:fixture-1"], reserved_cost: 0,
}

function portFor(projectId: string, catalog = syntheticInvestigationCatalog()) {
  const calls = { submit: 0, lookup: 0, read: 0 }
  const capabilities: InvestigationMcpPort["capabilities"] = {
    server_id: "local-synthetic", server_revision: "catalog-v1", tool_id: "bounded-read",
    tool_schema_revision: "a".repeat(64), principal_id: "local-test", project_id: projectId,
    effects: ["read"], idempotent_submit: true, lookup_by_submission_id: true,
    response_limit_bytes: 65_536, qualified: true,
  }
  const result = {
    manifest_ref: "synthetic://catalog/manifest-v1", digest: "b".repeat(64),
    source_versions: ["synthetic-catalog:fixture-1"],
    coverage: { rows: catalog.length, scope: "line-A/shift-1", fixture: true },
    observed_at: "2026-08-17T12:00:00Z", access_scope: "local-synthetic-reader",
  }
  const port: InvestigationMcpPort = {
    capabilities,
    submit: async () => { calls.submit++; return { kind: "result", result, actual_cost: 0 } },
    lookup: async () => { calls.lookup++; return { kind: "unknown", reason: "no pending synthetic jobs" } },
    validateResult: async (_value, work) => ({ valid: true, validity_key: work.validity_key, access_scope: result.access_scope }),
    readResult: async (_value, request) => {
      calls.read++
      const page = readSyntheticCatalogPage(catalog, {
        cursor: request.cursor, max_rows: request.max_rows, scope: "line-A/shift-1",
      })
      return { manifest_ref: result.manifest_ref, digest: result.digest, access_scope: result.access_scope,
        cursor: request.cursor, next_cursor: page.next_cursor, rows: page.rows.map((row) => ({ ...row })), coverage: page.coverage }
    },
  }
  return { port, calls, catalog }
}

describe("V1 Phase One synthetic investigation acceptance", () => {
  test("pages an 11,000-entry catalog with bounded frontier and correctly scoped negative coverage", () => {
    const catalog = syntheticInvestigationCatalog(11_000)
    expect(catalog).toHaveLength(11_000)
    const families = new Set(catalog.map((row) => row.incident_family))
    expect(families).toEqual(new Set(["chamber", "material", "inspection-artifact", "insufficient-evidence"]))

    const first = readSyntheticCatalogPage(catalog, { cursor: null, max_rows: 73, scope: "line-A/shift-1" })
    expect(first.rows).toHaveLength(73)
    expect(first.next_cursor).toBe("73")
    expect(first.coverage).toMatchObject({ scanned: 11_000, scope: "line-A/shift-1", complete: false })
    const next = readSyntheticCatalogPage(catalog, { cursor: first.next_cursor, max_rows: 73, scope: "line-A/shift-1" })
    expect(next.rows[0]?.catalog_id).not.toBe(first.rows[0]?.catalog_id)
    expect(new Set([...first.rows, ...next.rows].map((row) => row.catalog_id)).size).toBe(146)

    const chamberOnly = readSyntheticCatalogPage(catalog, { cursor: null, max_rows: 50,
      scope: "line-A/shift-1", family: "chamber" })
    expect(chamberOnly.rows.every((row) => row.incident_family === "chamber" && row.scope === "line-A/shift-1")).toBe(true)
    expect(chamberOnly.coverage.matched).toBeGreaterThan(0)
    expect(chamberOnly.coverage.scanned).toBe(11_000)
    const absentScope = readSyntheticCatalogPage(catalog, { cursor: null, max_rows: 50, scope: "line-Z/shift-9" })
    expect(absentScope.rows).toEqual([])
    expect(absentScope.coverage).toMatchObject({ matched: 0, scanned: 11_000, scope: "line-Z/shift-9", complete: true })

    const frontier = syntheticFrontier(catalog.filter((row) => row.scope === "line-A/shift-1"), 32)
    expect(frontier).toHaveLength(32)
    expect(frontier.every((row) => row.scope === "line-A/shift-1")).toBe(true)
    expect(() => readSyntheticCatalogPage(catalog, { cursor: null, max_rows: 101, scope: "line-A/shift-1" })).toThrow("bounded")
    expect(() => syntheticFrontier(catalog, 101)).toThrow("bounded")
  })

  test("reuses one managed computation and cached pages across context reconstruction, then resumes the seven-node graph after review", async () => {
    const path = project()
    const memory = new SessionMemoryRuntime(path, { mode: "assist" })
    memory.beginTask("owner", "Explain a synthetic excursion using scoped evidence")
    const run = createRun({ goal: "Explain a synthetic excursion using scoped evidence",
      criteria: ["Preserve source versions, coverage, alternatives, and uncertainty"],
      graph: getTemplate("data-investigation"), projectDirectory: path, ownerSessionId: "owner" })
    const synthetic = portFor(memory.store.projectId)
    const options = { enabled: true, costLimit: 20, perJobReservation: 5 }
    let runtime = new OperationalRuntime(memory, {}, options, () => synthetic.port)
    const managedRun = await runtime.begin(run)

    const first = await runtime.query("owner", workInput)
    expect(first.status).toBe("reusable")
    expect(synthetic.calls.submit).toBe(1)
    const firstPage = await runtime.readResult("owner", first.work_key, null, 20)
    expect(firstPage.evidence_only).toBe(true)
    expect(firstPage.page.rows).toHaveLength(20)
    expect(firstPage.page.coverage).toMatchObject({ scope: "line-A/shift-1", scanned: 11_000 })
    const pageFamilies = new Map(firstPage.page.rows.map((row) => [String(row.incident_family), row]))
    for (const family of ["chamber", "material", "inspection-artifact", "insufficient-evidence"]) {
      expect(pageFamilies.get(family)).toMatchObject({
        source_ref: expect.stringContaining(family), source_version: expect.stringMatching(/^fixture-/),
        scope: "line-A/shift-1",
      })
      expect(JSON.stringify(pageFamilies.get(family)?.uncertainty).length).toBeGreaterThan(2)
    }
    expect(pageFamilies.get("insufficient-evidence")?.coverage).toBe("missing")
    expect(JSON.stringify(pageFamilies.get("insufficient-evidence")?.uncertainty)).toContain("association cannot be evaluated")
    expect(pageFamilies.get("inspection-artifact")?.coverage).toBe("partial")
    expect(JSON.stringify(pageFamilies.get("inspection-artifact")?.uncertainty)).toContain("classification revision differs")
    const nextPage = await runtime.readResult("owner", first.work_key, firstPage.page.next_cursor, 20)
    expect(nextPage.page.rows[0]?.catalog_id).not.toBe(firstPage.page.rows[0]?.catalog_id)
    expect(synthetic.calls.read).toBe(2)

    runtime = new OperationalRuntime(new SessionMemoryRuntime(path, { mode: "assist" }), {}, options, () => synthetic.port)
    const repeated = await runtime.query("owner", workInput)
    expect(repeated).toMatchObject({ work_key: first.work_key, submission_id: first.submission_id, status: "reusable" })
    const cached = await runtime.readResult("owner", first.work_key, null, 20)
    expect(cached.page).toEqual(firstPage.page)
    expect(synthetic.calls).toMatchObject({ submit: 1, read: 2 })
    expect(InvestigationStore.open({ project_directory: path, project_id: memory.store.projectId,
      owner_id: "owner", run_id: run.run_id }).snapshot.work).toHaveLength(1)

    let childSequence = 0
    const outputs: Record<string, unknown> = {}
    const sessionRunner = async (prompt: NodePromptOpts) => {
      const nodeId = prompt.title.split("/").at(-2)!
      const child = `synthetic-child-${++childSequence}`
      await prompt.onSessionCreated?.(child)
      const parsed = nodeId === "discover"
        ? { query: "Synthetic excursion scope", map: [{ path: "synthetic://catalog", role: "scoped fixture catalog" }],
          key_hits: [{ path: "synthetic://catalog", note: "11,000 deterministic local entries" }], next: "researcher" }
        : nodeId === "check"
          ? { passed: true, failures: [], score: 9, notes: "All four synthetic evidence families retain their stated coverage and uncertainty." }
          : { answer: `${nodeId} branch reports scoped synthetic evidence; correlation is not causal proof.`,
            evidence: [{ path: `synthetic://${nodeId}`, finding: `Evidence remains bounded to ${nodeId}.` }],
            constraints: ["Synthetic fixture; no causal accuracy claim"], options: [],
            acceptance_criteria: ["Preserve coverage, uncertainty, and source identity"], risks: ["No production source was queried"] }
      outputs[nodeId] = parsed
      return { session_id: child, text: JSON.stringify(parsed), parsed }
    }
    const common = {
      ...executeContext(path), parentSessionId: "owner", sessionRunner,
      beforeBatch: (current: typeof run, nodes: Parameters<typeof runtime.beforeBatch>[1]) => runtime.beforeBatch(current, nodes),
      beforeChildPrompt: (child: string, _role: "worker" | "checker", node: (typeof run.graph.nodes)[number]) =>
        runtime.child(managedRun, child, node),
    }
    const partial = await executeRun(managedRun, { ...common, maxWaves: 3 })
    expect(partial.nodes.discover?.status).toBe("done")
    expect(partial.nodes.process?.status).toBe("done")
    expect(partial.nodes.equipment?.status).toBe("done")
    expect(partial.nodes.metrology?.status).toBe("done")
    expect(partial.nodes.reconcile?.status).toBe("done")
    expect(partial.nodes.confirm?.status).toBe("pending")
    expect(partial.nodes.check?.status).toBe("pending")
    expect(() => requireInvestigationReview(partial)).toThrow("engineer_review_required")
    recordInvestigationReview(partial, "operator:synthetic-reviewer")

    const reloaded = loadRunForOwner(path, run.run_id, "owner")!
    const completed = await executeRun(prepareRunForResume(reloaded), { ...common, operation: "resume" })
    expect(completed.status).toBe("done")
    expect(completed.graph.nodes.map((node) => node.id)).toEqual([
      "discover", "process", "equipment", "metrology", "reconcile", "confirm", "check",
    ])
    expect(Object.values(completed.nodes).every((node) => node.status === "done" && node.output_ref)).toBe(true)
    for (const id of ["process", "equipment", "metrology", "reconcile", "confirm"])
      expect(readNodeArtifactOutput(completed, id)).toMatchObject({ answer: expect.any(String), evidence: expect.any(Array), risks: expect.any(Array) })
    expect(readNodeArtifactOutput(completed, "discover")).toMatchObject({ query: expect.any(String), map: expect.any(Array) })
    expect(readNodeArtifactOutput(completed, "check")).toMatchObject({ passed: true, score: 9 })
    expect(outputs).toHaveProperty("check")
    expect(synthetic.calls.submit).toBe(1)
    expect(synthetic.calls.lookup).toBe(0)
  }, 120_000)

  test("four incident families preserve evidence provenance and represent missing evidence as uncertainty", () => {
    const rows = syntheticInvestigationCatalog(40)
    const byFamily = new Map(rows.map((row) => [row.incident_family, row]))
    for (const family of ["chamber", "material", "inspection-artifact", "insufficient-evidence"] as const) {
      const row = byFamily.get(family)!
      expect(row.source_ref).toContain(family)
      expect(row.source_version).toMatch(/^fixture-/)
      expect(row.scope).toMatch(/^line-A\//)
      expect(row.uncertainty.length).toBeGreaterThan(0)
      if (family === "insufficient-evidence") {
        expect(row.coverage).toBe("missing")
        expect(row.uncertainty).toContain("association cannot be evaluated")
      }
      if (family === "inspection-artifact") {
        expect(row.coverage).toBe("partial")
        expect(row.uncertainty).toContain("classification revision differs")
      }
    }
    expect(rows.filter((row) => row.coverage === "missing").every((row) => row.uncertainty.length > 0)).toBe(true)
  })
})

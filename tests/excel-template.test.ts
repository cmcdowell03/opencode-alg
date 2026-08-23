import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { validateGraph } from "../src/graph.ts"
import { getTemplate, listTemplates, SPREADSHEET_DIAMOND } from "../src/templates.ts"
import { withShellGate } from "../src/tools.ts"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")

describe("spreadsheet-diamond capability workflow", () => {
  test("shipped JSON and built-in TypeScript definitions remain identical and schema-valid", () => {
    const shipped = JSON.parse(readFileSync(join(ROOT, "templates", "spreadsheet-diamond.json"), "utf8"))
    expect(shipped).toEqual(SPREADSHEET_DIAMOND)
    expect(validateGraph(shipped)).toEqual(SPREADSHEET_DIAMOND)
    expect(listTemplates().map((item) => item.name)).toContain("spreadsheet-diamond")
  })

  test("uses only existing roles, leaves the gate optional, and injects it only on implementer", () => {
    const graph = getTemplate("spreadsheet-diamond")
    expect(new Set(graph.nodes.map((node) => node.agent))).toEqual(new Set(["researcher", "implementer", "checker"]))
    expect(graph.nodes.every((node) => node.shell_gate === undefined)).toBe(true)
    const gated = withShellGate(graph, "python capabilities/excel/workbook.py validate --root fixture --workbook staged.xlsx", 20_000)
    expect(gated.nodes.find((node) => node.agent === "implementer")?.shell_gate).toEqual({
      cmd: "python capabilities/excel/workbook.py validate --root fixture --workbook staged.xlsx",
      timeout_ms: 20_000,
    })
    expect(gated.nodes.filter((node) => node.agent !== "implementer").every((node) => node.shell_gate === undefined)).toBe(true)
  })

  test("embeds the staged-copy, relative-path, no-overwrite, and no-recalculation safety contract", () => {
    const text = JSON.stringify(getTemplate("spreadsheet-diamond")).toLowerCase()
    expect(text).toContain("relative staged .xlsx")
    expect(text).toContain("never overwrite")
    expect(text).toContain("not recalculated")
    expect(text).toContain("alg_excel")
    expect(text).toContain("validator shell gate")
  })
})

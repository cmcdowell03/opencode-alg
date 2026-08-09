import { describe, expect, test } from "bun:test"
import * as fc from "fast-check"
import { basename } from "node:path"
import { getTemplate } from "../src/templates.ts"
import { validateGraph } from "../src/graph.ts"
import { parseRunState } from "../src/schemas.ts"
import {
  assertSafeId,
  canonicalDirectory,
  containedPath,
  isContained,
  isSafeId,
  resolveContainedPath,
} from "../src/paths.ts"
import { createRun } from "../src/store.ts"
import { removeProject, tempProject } from "./helpers.ts"

const PROPERTY_OPTIONS = { seed: 0x0a16_2026, numRuns: 250, endOnFailure: true } as const

describe("deterministic adversarial properties", () => {
  test("safe ids and derived paths agree for arbitrary and reserved strings", () => {
    const project = tempProject()
    try {
      const values = fc.oneof(
        fc.string({ maxLength: 100 }),
        fc.constantFrom("__proto__", "prototype", "constructor", "toString", "CON", "nul.txt", "../escape"),
      )
      fc.assert(fc.property(values, (value) => {
        if (!isSafeId(value)) {
          expect(() => assertSafeId(value)).toThrow()
          return
        }
        expect(assertSafeId(value)).toBe(value)
        const derived = containedPath(project, value)
        expect(isContained(canonicalDirectory(project), derived)).toBe(true)
        expect(basename(derived)).toBe(value)
      }), PROPERTY_OPTIONS)
    } finally {
      removeProject(project)
    }
  })

  test("arbitrary path segments can never produce an escaping accepted path", () => {
    const project = tempProject()
    try {
      fc.assert(fc.property(
        fc.oneof(
          fc.array(fc.string({ maxLength: 40 }), { minLength: 1, maxLength: 6 }),
          fc.constant(["..", "..", "escape"]),
          fc.constant(["C:\\Windows"]),
          fc.constant(["/etc"]),
        ),
        (segments) => {
          try {
            const result = resolveContainedPath(project, ...segments)
            expect(isContained(canonicalDirectory(project), result)).toBe(true)
          } catch (error) {
            expect(error).toBeInstanceOf(Error)
          }
        },
      ), PROPERTY_OPTIONS)
    } finally {
      removeProject(project)
    }
  })

  test("graph id validity and forged done-state outputs hold across generated data", () => {
    const project = tempProject()
    try {
      fc.assert(fc.property(fc.string({ maxLength: 80 }), (id) => {
        const graph = {
          name: "property-graph",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id, agent: "explorer", depends_on: [] }],
        }
        if (isSafeId(id)) expect(() => validateGraph(graph)).not.toThrow()
        else expect(() => validateGraph(graph)).toThrow()
      }), PROPERTY_OPTIONS)

      const run = createRun({
        goal: "state property",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      fc.assert(fc.property(fc.jsonValue(), (arbitraryOutput) => {
        const forged = JSON.parse(JSON.stringify(run))
        forged.status = "running"
        forged.nodes.explore_a.status = "done"
        forged.nodes.explore_a.output = arbitraryOutput
        expect(() => parseRunState(forged)).toThrow()
      }), PROPERTY_OPTIONS)
    } finally {
      removeProject(project)
    }
  })
})

import { describe, expect, test } from "bun:test"
import {
  applyInputBinding,
  applyOutputBinding,
  InvestigationRecipeListSchema,
  InvestigationRecipeSchema,
  normalizeInvestigationRecipe,
  ToolBindingSchema,
} from "../src/investigation-protocol.ts"

describe("investigation protocol bindings", () => {
  test("keeps pass-through behavior when a mapping is absent", () => {
    const request = { query: { limit: 5 } }
    const response = { kind: "result", result: { id: "r1" } }
    expect(applyInputBinding({ request })).toEqual(request)
    expect(applyOutputBinding(response)).toEqual(response)
  })

  test("maps trusted request and host pointers plus explicit constants", () => {
    const binding = ToolBindingSchema.parse({ input: {
      dataset: { kind: "pointer", source: "host", pointer: "/dataset/id" },
      filter: { kind: "pointer", source: "request", pointer: "/filters/0" },
      mode: { kind: "constant", value: "read_only" },
    } })
    expect(applyInputBinding({ request: { filters: ["active"] }, host: { dataset: { id: "trusted-1" } } }, binding))
      .toEqual({ dataset: "trusted-1", filter: "active", mode: "read_only" })
  })

  test("requires paths by default and omits explicitly optional missing paths", () => {
    expect(() => applyInputBinding({ request: {} }, { input: { id: { kind: "pointer", source: "request", pointer: "/id" } } }))
      .toThrow(/required request pointer/)
    expect(applyInputBinding({ request: {} }, { input: {
      id: { kind: "pointer", source: "request", pointer: "/id", required: false },
    } })).toEqual({})
  })

  test("maps response fields and constants into an internal envelope", () => {
    expect(applyOutputBinding({ data: { rows: [1, 2] } }, { output: {
      records: { kind: "pointer", pointer: "/data/rows" },
      source: { kind: "constant", value: "native-tool" },
    } })).toEqual({ records: [1, 2], source: "native-tool" })
    expect(() => applyOutputBinding({}, { output: { result: { kind: "pointer", pointer: "/missing" } } }))
      .toThrow(/required response pointer/)
  })

  test("rejects unsafe pointer grammar, prototype names, and oversized mappings", () => {
    for (const pointer of ["", "name", "/a~2b", "/__proto__/polluted", "/constructor/prototype", `/${"x/".repeat(17)}y`]) {
      expect(ToolBindingSchema.safeParse({ input: { x: { kind: "pointer", source: "request", pointer } } }).success).toBe(false)
    }
    const polluted = JSON.parse('{"input":{"__proto__":{"kind":"constant","value":1}}}')
    expect(ToolBindingSchema.safeParse(polluted).success).toBe(false)
    const unsafeConstant = JSON.parse('{"input":{"x":{"kind":"constant","value":{"constructor":"unsafe"}}}}')
    expect(ToolBindingSchema.safeParse(unsafeConstant).success).toBe(false)
    expect(ToolBindingSchema.safeParse({ input: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [
      `arg${i}`, { kind: "constant", value: i },
    ])) }).success).toBe(false)
  })

  test("does not traverse inherited properties and rejects non-JSON values", () => {
    const request = Object.create({ inherited: "no" }) as Record<string, unknown>
    expect(() => applyInputBinding({ request }, { input: {
      inherited: { kind: "pointer", source: "request", pointer: "/inherited" },
    } })).toThrow(/plain JSON/)
    expect(() => applyOutputBinding({ value: undefined })).toThrow(/plain JSON/)
  })
})

describe("typed finite investigation recipes", () => {
  const recipe = InvestigationRecipeSchema.parse({
    operation: "summarize",
    version: "3",
    base_query: { source: "approved-catalog", fields: ["count"] },
    parameters: [
      { name: "window", type: "enum", values: ["day", "week"], required: true },
      { name: "limit", type: "integer", minimum: 1, maximum: 50 },
      { name: "include_empty", type: "boolean" },
      { name: "as_of", type: "iso_timestamp" },
    ],
  })

  test("normalizes declared typed values under query.parameters with deterministic revision", () => {
    const params = { window: "week", limit: 10, include_empty: false, as_of: "2026-11-10T12:30:00.000Z" }
    const normalized = normalizeInvestigationRecipe(recipe, params)
    expect(normalized).toMatchObject({ operation: "summarize", recipe_version: "3", parameters: params,
      query: { source: "approved-catalog", fields: ["count"], parameters: params } })
    expect(normalized.recipe_revision).toMatch(/^[a-f0-9]{64}$/)
    expect(normalized.recipe_fingerprint).toBe(normalized.recipe_revision)
    expect(normalizeInvestigationRecipe(recipe, params).recipe_revision).toBe(normalized.recipe_revision)
  })

  test("rejects extra/missing parameters, implicit coercion, bounds violations, and ambiguous timestamps", () => {
    expect(() => normalizeInvestigationRecipe(recipe, { window: "week", query: { raw: true } })).toThrow(/undeclared/)
    expect(() => normalizeInvestigationRecipe(recipe, { limit: "10", window: "week" })).toThrow(/invalid integer/)
    expect(() => normalizeInvestigationRecipe(recipe, { limit: 51, window: "week" })).toThrow(/invalid integer/)
    expect(() => normalizeInvestigationRecipe(recipe, { window: "month" })).toThrow(/invalid enum/)
    expect(() => normalizeInvestigationRecipe(recipe, { window: "day", as_of: "2026-11-10T12:30:00" })).toThrow(/invalid iso_timestamp/)
  })

  test("rejects recipe query override fields and duplicate recipe identities", () => {
    expect(InvestigationRecipeSchema.safeParse({ ...recipe, base_query: { parameters: { arbitrary: true } } }).success).toBe(false)
    expect(InvestigationRecipeListSchema.safeParse([recipe, recipe]).success).toBe(false)
  })

  test("changes fingerprint when normalization semantics change", () => {
    const narrowed = InvestigationRecipeSchema.parse({ ...recipe, parameters: [
      { name: "window", type: "enum", values: ["day", "week"], required: true },
      { name: "limit", type: "integer", minimum: 1, maximum: 20 },
      ...recipe.parameters.slice(2),
    ] })
    expect(normalizeInvestigationRecipe(narrowed, { window: "day" }).recipe_revision)
      .not.toBe(normalizeInvestigationRecipe(recipe, { window: "day" }).recipe_revision)
  })
})

test("native response nesting and local validity identity need no server ALG hash", () => {
  const mapped = applyOutputBinding({ payload: { uri: "native://r", checksum: "a".repeat(64) }, accessible: true }, { output: {
    "/result/manifest_ref": { kind: "pointer", pointer: "/payload/uri" },
    "/result/digest": { kind: "pointer", pointer: "/payload/checksum" },
    valid: { kind: "pointer", pointer: "/accessible" },
    validity_key: { kind: "pointer", source: "request", pointer: "/validity_key" },
  } }, { validity_key: "b".repeat(64) })
  expect(mapped).toEqual({ result: { manifest_ref: "native://r", digest: "a".repeat(64) }, valid: true, validity_key: "b".repeat(64) })
  expect(() => applyOutputBinding({}, { output: { "/result/__proto__/bad": { kind: "constant", value: true } } })).toThrow("unsafe")
})

test("equivalent timezone-qualified recipe timestamps normalize to one query", () => {
  const recipe = { operation: "read", version: "1", base_query: { recipe: "window" },
    parameters: [{ name: "at", type: "iso_timestamp" as const, required: true }] }
  const a = normalizeInvestigationRecipe(recipe, { at: "2026-11-10T00:00:00Z" })
  const b = normalizeInvestigationRecipe(recipe, { at: "2026-11-09T18:00:00-06:00" })
  expect(a.query).toEqual(b.query)
})

test("native job states choose reviewed envelopes without guessing unknown states", () => {
  const binding = ToolBindingSchema.parse({ responses: { discriminator: "/state", cases: {
    pending: { kind: { kind: "constant", value: "running" }, external_job_id: { kind: "pointer", pointer: "/job" } },
    done: { kind: { kind: "constant", value: "result" }, result: { kind: "pointer", pointer: "/payload" } },
  } } })
  expect(applyOutputBinding({ state: "pending", job: "j1" }, binding)).toEqual({ kind: "running", external_job_id: "j1" })
  expect(applyOutputBinding({ state: "done", payload: { id: "r1" } }, binding)).toEqual({ kind: "result", result: { id: "r1" } })
  expect(() => applyOutputBinding({ state: "new-unknown-state" }, binding)).toThrow("unmapped")
})

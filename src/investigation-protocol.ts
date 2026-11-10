import { z } from "zod"
import { hashObject } from "./session-memory/store.ts"

/** Limits are intentionally small: bindings and recipes are operator configuration. */
export const INVESTIGATION_PROTOCOL_LIMITS = Object.freeze({
  maxMappings: 64,
  maxPointerBytes: 512,
  maxPointerDepth: 16,
  maxValueDepth: 16,
  maxValueBytes: 65_536,
  maxRecipeParameters: 64,
  maxEnumValues: 128,
})

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"])
const pointerToken = /^(?:[^~/]|~[01]){0,128}$/

function safePointer(pointer: string): boolean {
  if (Buffer.byteLength(pointer, "utf8") > INVESTIGATION_PROTOCOL_LIMITS.maxPointerBytes ||
      !pointer.startsWith("/") || pointer === "/") return false
  const tokens = pointer.slice(1).split("/")
  return tokens.length <= INVESTIGATION_PROTOCOL_LIMITS.maxPointerDepth &&
    tokens.every((token) => pointerToken.test(token) && !forbiddenKeys.has(token.replace(/~1/g, "/").replace(/~0/g, "~")))
}

const PointerSchema = z.string().refine(safePointer, "must be a bounded safe JSON pointer")
const JsonValueSchema: z.ZodType<unknown> = z.unknown().superRefine((value, ctx) => {
  try { assertBoundedJson(value, "configured JSON value") }
  catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid JSON value" }) }
})

const SourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pointer"), source: z.enum(["request", "host"]), pointer: PointerSchema, required: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("constant"), value: JsonValueSchema }).strict(),
])
const ResponseValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pointer"), pointer: PointerSchema, source: z.enum(["response", "request"]).optional(), required: z.boolean().optional() }).strict(),
  z.object({ kind: z.literal("constant"), value: JsonValueSchema }).strict(),
])
function boundedMappingSchema<T extends z.ZodType>(valueSchema: T) {
  return z.preprocess((value, ctx) => {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const key of Object.keys(value)) if (forbiddenKeys.has(key))
        ctx.addIssue({ code: "custom", message: "prototype keys are forbidden" })
    }
    return value
  }, z.record(z.string().min(1).max(128), valueSchema)
    .refine((mapping) => Object.keys(mapping).length <= INVESTIGATION_PROTOCOL_LIMITS.maxMappings, "too many mapped fields"))
}
const MappingSchema = boundedMappingSchema(SourceSchema)
const OutputMappingSchema = boundedMappingSchema(ResponseValueSchema)

/** A missing mapping means the caller passes the original request/response through unchanged. */
export const ToolBindingSchema = z.object({
  input: MappingSchema.optional(),
  output: OutputMappingSchema.optional(),
  responses: z.object({ discriminator: PointerSchema,
    cases: z.record(z.string().min(1).max(64), OutputMappingSchema).refine((cases) =>
      Object.keys(cases).length > 0 && Object.keys(cases).length <= 8 && Object.keys(cases).every((key) => !forbiddenKeys.has(key)),
      "invalid response cases") }).strict().optional(),
}).strict().refine((value) => !(value.output && value.responses), "choose output or discriminated responses")
export type ToolBinding = z.infer<typeof ToolBindingSchema>
export type BindingContext = Readonly<{ request: unknown; host?: unknown }>

function assertBoundedJson(value: unknown, label: string): void {
  const visit = (current: unknown, depth: number): void => {
    if (depth > INVESTIGATION_PROTOCOL_LIMITS.maxValueDepth) throw new Error(`${label} exceeds maximum JSON depth`)
    if (current === null || typeof current === "string" || typeof current === "boolean") return
    if (typeof current === "number" && Number.isFinite(current)) return
    if (Array.isArray(current)) { for (const entry of current) visit(entry, depth + 1); return }
    if (typeof current === "object" && (Object.getPrototypeOf(current) === Object.prototype || Object.getPrototypeOf(current) === null)) {
      for (const [key, entry] of Object.entries(current)) {
        if (forbiddenKeys.has(key)) throw new Error(`${label} contains a forbidden prototype key`)
        visit(entry, depth + 1)
      }
      return
    }
    throw new Error(`${label} must contain only plain JSON values`)
  }
  visit(value, 0)
  let bytes: number
  try { bytes = Buffer.byteLength(JSON.stringify(value), "utf8") }
  catch { throw new Error(`${label} is not valid JSON`) }
  if (bytes > INVESTIGATION_PROTOCOL_LIMITS.maxValueBytes) throw new Error(`${label} exceeds maximum JSON bytes`)
}

function pointerValue(root: unknown, pointer: string): { found: boolean; value?: unknown } {
  let current = root
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replace(/~1/g, "/").replace(/~0/g, "~")
    if (forbiddenKeys.has(token) || current === null || typeof current !== "object") return { found: false }
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return { found: false }
      const index = Number(token)
      if (!Number.isSafeInteger(index) || index >= current.length || !Object.hasOwn(current, index)) return { found: false }
      current = current[index]
    } else {
      if ((Object.getPrototypeOf(current) !== Object.prototype && Object.getPrototypeOf(current) !== null) || !Object.hasOwn(current, token)) return { found: false }
      current = (current as Record<string, unknown>)[token]
    }
  }
  return { found: true, value: current }
}

function resolve(source: z.infer<typeof SourceSchema>, context: BindingContext): { found: boolean; value?: unknown } {
  if (source.kind === "constant") return { found: true, value: source.value }
  assertBoundedJson(context[source.source], `${source.source} binding source`)
  const result = pointerValue(context[source.source], source.pointer)
  if (!result.found && (source.required ?? true)) throw new Error(`required ${source.source} pointer is missing: ${source.pointer}`)
  return result
}

function resolveResponse(source: z.infer<typeof ResponseValueSchema>, response: unknown, request?: unknown): { found: boolean; value?: unknown } {
  if (source.kind === "constant") return { found: true, value: source.value }
  const origin = source.source === "request" ? request : response
  assertBoundedJson(origin, "response binding origin")
  const result = pointerValue(origin, source.pointer)
  if (!result.found && (source.required ?? true)) throw new Error(`required response pointer is missing: ${source.pointer}`)
  return result
}

/** Maps a trusted request/host context to native tool arguments. */
export function applyInputBinding(request: BindingContext, binding?: ToolBinding): Record<string, unknown> {
  const parsedBinding = binding === undefined ? undefined : ToolBindingSchema.parse(binding)
  if (parsedBinding?.input === undefined) {
    const passthrough = request.request
    assertBoundedJson(passthrough, "native tool request")
    if (passthrough === null || typeof passthrough !== "object" || Array.isArray(passthrough))
      throw new Error("native tool request must be a JSON object")
    return structuredClone(passthrough as Record<string, unknown>)
  }
  assertBoundedJson(request.request, "request binding source")
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [nativeName, source] of Object.entries(parsedBinding.input)) {
    const resolved = resolve(source, request)
    if (resolved.found) result[nativeName] = structuredClone(resolved.value)
  }
  assertBoundedJson(result, "bound native tool request")
  return result
}

/** Maps a native response into the internal envelope; an absent mapping passes through. */
export function applyOutputBinding(response: unknown, binding?: ToolBinding, request?: unknown): Record<string, unknown> {
  const parsedBinding = binding === undefined ? undefined : ToolBindingSchema.parse(binding)
  assertBoundedJson(response, "native tool response")
  let mapping = parsedBinding?.output
  if (parsedBinding?.responses) {
    const state = pointerValue(response, parsedBinding.responses.discriminator)
    if (!state.found || typeof state.value !== "string" || !Object.hasOwn(parsedBinding.responses.cases, state.value))
      throw new Error("unmapped native response state")
    mapping = parsedBinding.responses.cases[state.value]
  }
  if (mapping === undefined) {
    if (response === null || typeof response !== "object" || Array.isArray(response))
      throw new Error("native tool response must be a JSON object")
    return structuredClone(response as Record<string, unknown>)
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const [internalKey, source] of Object.entries(mapping)) {
    const resolved = resolveResponse(source, response, request)
    if (!resolved.found) continue
    const tokens = internalKey.startsWith("/") ? (safePointer(internalKey) ? internalKey.slice(1).split("/").map((value) => value.replace(/~1/g, "/").replace(/~0/g, "~")) : []) : [internalKey]
    if (!tokens.length || tokens.some((key) => forbiddenKeys.has(key))) throw new Error("unsafe output target")
    let target = result
    for (const key of tokens.slice(0, -1)) {
      if (!Object.hasOwn(target, key)) target[key] = Object.create(null)
      const child = target[key]
      if (!child || typeof child !== "object" || Array.isArray(child) ||
        Object.getPrototypeOf(child) !== null) throw new Error("overlapping output targets")
      target = child as Record<string, unknown>
    }
    const last = tokens.at(-1)!
    if (Object.hasOwn(target, last)) throw new Error("overlapping output targets")
    target[last] = structuredClone(resolved.value)
  }
  assertBoundedJson(result, "bound internal response")
  return result
}

const CommonParameter = { name: z.string().min(1).max(128).refine((key) => !forbiddenKeys.has(key)), required: z.boolean().default(false) }
const ParameterSchema = z.discriminatedUnion("type", [
  z.object({ ...CommonParameter, type: z.literal("enum"), values: z.array(z.union([z.string().max(512), z.number().finite(), z.boolean()])).min(1).max(INVESTIGATION_PROTOCOL_LIMITS.maxEnumValues) }).strict(),
  z.object({ ...CommonParameter, type: z.literal("string"), min_length: z.number().int().min(0).max(65_536).optional(), max_length: z.number().int().min(0).max(65_536).optional() }).strict(),
  z.object({ ...CommonParameter, type: z.literal("integer"), minimum: z.number().int().optional(), maximum: z.number().int().optional() }).strict(),
  z.object({ ...CommonParameter, type: z.literal("number"), minimum: z.number().finite().optional(), maximum: z.number().finite().optional() }).strict(),
  z.object({ ...CommonParameter, type: z.literal("boolean") }).strict(),
  z.object({ ...CommonParameter, type: z.literal("iso_timestamp") }).strict(),
])

export const InvestigationRecipeSchema = z.object({
  operation: z.string().min(1).max(128),
  version: z.string().min(1).max(128),
  base_query: z.record(z.string().max(128), JsonValueSchema),
  parameters: z.array(ParameterSchema).max(INVESTIGATION_PROTOCOL_LIMITS.maxRecipeParameters),
}).strict().superRefine((recipe, ctx) => {
  const names = new Set<string>()
  for (const parameter of recipe.parameters) {
    if (names.has(parameter.name)) ctx.addIssue({ code: "custom", message: `duplicate parameter: ${parameter.name}`, path: ["parameters"] })
    names.add(parameter.name)
    if ("minimum" in parameter && "maximum" in parameter && parameter.minimum !== undefined && parameter.maximum !== undefined && parameter.minimum > parameter.maximum)
      ctx.addIssue({ code: "custom", message: `invalid bounds for ${parameter.name}`, path: ["parameters"] })
    if ("min_length" in parameter && "max_length" in parameter && parameter.min_length !== undefined && parameter.max_length !== undefined && parameter.min_length > parameter.max_length)
      ctx.addIssue({ code: "custom", message: `invalid length bounds for ${parameter.name}`, path: ["parameters"] })
    if (parameter.type === "enum" && new Set(parameter.values.map((value) => JSON.stringify(value))).size !== parameter.values.length)
      ctx.addIssue({ code: "custom", message: `duplicate enum values for ${parameter.name}`, path: ["parameters"] })
  }
  if (Object.hasOwn(recipe.base_query, "parameters"))
    ctx.addIssue({ code: "custom", message: "base_query cannot define the reserved parameters field", path: ["base_query", "parameters"] })
  try { assertBoundedJson(recipe.base_query, "recipe base_query") }
  catch (error) { ctx.addIssue({ code: "custom", message: error instanceof Error ? error.message : "invalid base_query", path: ["base_query"] }) }
})
export type InvestigationRecipe = z.input<typeof InvestigationRecipeSchema>

export const InvestigationRecipeListSchema = z.array(InvestigationRecipeSchema).max(128)
  .superRefine((recipes, ctx) => {
    const keys = new Set<string>()
    recipes.forEach((recipe, index) => {
      const key = `${recipe.operation}\0${recipe.version}`
      if (keys.has(key)) ctx.addIssue({ code: "custom", message: "duplicate operation/version recipe", path: [index] })
      keys.add(key)
    })
  })

export type NormalizedInvestigationRecipe = Readonly<{
  operation: string
  recipe_version: string
  recipe_revision: string
  recipe_fingerprint: string
  parameters: Readonly<Record<string, unknown>>
  query: Readonly<Record<string, unknown>>
}>

/** Validates operator-declared parameters and constructs the only permitted query shape. */
export function normalizeInvestigationRecipe(
  recipeInput: InvestigationRecipe,
  suppliedParameters: unknown,
): NormalizedInvestigationRecipe {
  const recipe = InvestigationRecipeSchema.parse(recipeInput)
  if (suppliedParameters === null || typeof suppliedParameters !== "object" || Array.isArray(suppliedParameters))
    throw new Error("recipe parameters must be an object")
  assertBoundedJson(suppliedParameters, "recipe parameters")
  const supplied = suppliedParameters as Record<string, unknown>
  const declarations = new Map(recipe.parameters.map((parameter) => [parameter.name, parameter]))
  for (const key of Object.keys(supplied)) if (!declarations.has(key)) throw new Error(`undeclared recipe parameter: ${key}`)

  const normalized: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const parameter of recipe.parameters) {
    const present = Object.hasOwn(supplied, parameter.name)
    if (!present) {
      if (parameter.required) throw new Error(`required recipe parameter is missing: ${parameter.name}`)
      continue
    }
    const value = supplied[parameter.name]
    let valid = false
    switch (parameter.type) {
      case "enum": valid = parameter.values.some((candidate) => Object.is(candidate, value)); break
      case "string": valid = typeof value === "string" && Buffer.byteLength(value, "utf8") <= (parameter.max_length ?? 65_536) && value.length >= (parameter.min_length ?? 0); break
      case "integer": valid = typeof value === "number" && Number.isSafeInteger(value) && (parameter.minimum === undefined || value >= parameter.minimum) && (parameter.maximum === undefined || value <= parameter.maximum); break
      case "number": valid = typeof value === "number" && Number.isFinite(value) && (parameter.minimum === undefined || value >= parameter.minimum) && (parameter.maximum === undefined || value <= parameter.maximum); break
      case "boolean": valid = typeof value === "boolean"; break
      case "iso_timestamp": valid = typeof value === "string" && z.iso.datetime({ offset: true }).safeParse(value).success; break;
    }
    if (!valid) throw new Error(`invalid ${parameter.type} recipe parameter: ${parameter.name}`)
    normalized[parameter.name] = parameter.type === "iso_timestamp" ? new Date(value as string).toISOString() : value
  }
  const fingerprint = hashObject({ schema_version: 1, recipe })
  const query = { ...structuredClone(recipe.base_query), parameters: structuredClone(normalized) }
  assertBoundedJson(query, "normalized recipe query")
  return Object.freeze({ operation: recipe.operation, recipe_version: recipe.version,
    recipe_revision: fingerprint, recipe_fingerprint: fingerprint,
    parameters: Object.freeze(normalized), query: Object.freeze(query) })
}

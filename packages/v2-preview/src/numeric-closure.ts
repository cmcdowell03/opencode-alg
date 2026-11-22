import { createHash } from "node:crypto"
import { parseTree, type Node, type ParseError } from "jsonc-parser"
import { z } from "zod"
import {
  DecimalLiteralSchema, NumericClaimSchema, decimalIdentity, numericSourceReferences, validNumericProgram, verifyNumericClaim,
  type NumericClaim, type NumericStep, type NumericVerification,
} from "../core/numeric-claim.ts"

const digest = z.string().regex(/^[a-f0-9]{64}$/)
const cell = z.strictObject({
  id: digest,
  literal: DecimalLiteralSchema.optional(),
  distinctKey: digest.optional(),
})
const captured = z.array(z.array(cell).min(1).max(16).nullable()).min(1).max(32)

export const RecordedNumericClaimSchema = z.strictObject({
  claim: NumericClaimSchema,
  captured: captured.optional(),
})
type Recorded = z.output<typeof RecordedNumericClaimSchema>
type Cell = z.output<typeof cell>
type Citation = { id: string; reference: string }
type Row = { node: Node; content: string }

function resolve<C extends Citation>(step: NumericStep, support: readonly C[]): C[] | undefined {
  const rows: C[] = []
  for (const reference of numericSourceReferences(step)) {
    const matches = support.filter(row => row.id === reference || row.reference === reference)
    if (matches.length !== 1 || !/\.json#[\w-]+$/.test(matches[0]!.reference)) return
    rows.push(matches[0]!)
  }
  if (new Set(rows.map(row => row.reference)).size === rows.length) return rows
}

function property(node: Node, key: string): Node | undefined {
  if (node.type !== "object") return
  const found = node.children?.filter(entry => entry.children?.[0]?.value === key)
  if (found?.length === 1) return found[0]?.children?.[1]
}

/** Preserve decimal tokens and reject ambiguity in referenced IDs and fields. */
export function parseNumericSource(content: string): ReadonlyMap<string, Row> {
  const errors: ParseError[] = []
  const rows = new Map<string, Row>()
  let root: Node | undefined
  try { root = parseTree(content, errors, { disallowComments: true }) }
  catch { return rows }
  if (errors.length || root?.type !== "array") return rows
  for (const node of root.children ?? []) {
    const id = property(node, "id")
    if (id?.type !== "string" || rows.has(id.value)) return new Map()
    rows.set(id.value, { node, content })
  }
  return rows
}

function selectField(node: Node, field: (string | number)[]): Node | undefined {
  let value: Node | undefined = node
  for (const key of field) {
    if (!value) return
    value = typeof key === "number" && value.type === "array" ? value.children?.[key] :
      typeof key === "string" ? property(value, key) : undefined
  }
  return value
}

function captureCell(step: NumericStep, source: Citation, row: Row | undefined): Cell | undefined {
  if (!row) return
  if (step.op === "count") return { id: source.id }
  if (!("field" in step)) return
  const value = selectField(row.node, step.field)
  if (!value) return
  const literal = value.type === "number" ? row.content.slice(value.offset, value.offset + value.length) : undefined
  if (step.op === "read") {
    if (DecimalLiteralSchema.safeParse(literal).success) return { id: source.id, literal }
  } else if (value.type === "string" || value.type === "boolean" || literal !== undefined) {
    try {
      const scalar = literal === undefined ? JSON.stringify(value.value) : decimalIdentity(literal)
      return { id: source.id, distinctKey: createHash("sha256").update(value.type + "\0" + scalar).digest("hex") }
    } catch {
      return
    }
  }
}

/** Record only primitive operands from host-observed rows. The candidate never supplies source values. */
export function captureNumericClaim<C extends Citation>(claim: NumericClaim, support: readonly C[],
  readRow: (citation: C) => Row | undefined, prior?: Recorded): Recorded {
  if (!validNumericProgram(claim.steps)) return { claim }
  const reusable = JSON.stringify(prior?.claim.steps) === JSON.stringify(claim.steps) ? prior?.captured : undefined
  const cells: z.output<typeof captured> = []
  for (const [index, step] of claim.steps.entries()) {
    if ("inputs" in step) {
      cells.push(null)
      continue
    }
    const rows = resolve(step, support)
    if (!rows) return { claim }
    const previous = reusable?.[index]
    const result: Cell[] = []
    for (const [offset, source] of rows.entries()) {
      const row = readRow(source)
      const priorCell = previous?.[offset]
      const entry = row === undefined && priorCell?.id === source.id ? priorCell : captureCell(step, source, row)
      if (!entry) return { claim }
      result.push(entry)
    }
    cells.push(result)
  }
  return { claim, captured: cells }
}

/** Recompute on every projection, from captured operands bound to currently usable source receipts. */
export function projectNumericClaim(recorded: Recorded, support: readonly Citation[]): NumericVerification {
  const { claim, captured } = recorded
  if (!validNumericProgram(claim.steps)) return { status: "invalid" }
  if (!captured || captured.length !== claim.steps.length) return { status: "unavailable" }
  const amounts = new Map<number, string>()
  const citations = new Set<string>()
  for (const [index, step] of claim.steps.entries()) {
    const cells = captured[index]
    if ("inputs" in step) {
      if (cells !== null) return { status: "invalid" }
      continue
    }
    const rows = resolve(step, support)
    if (!rows || !cells || cells.length !== rows.length || rows.some((row, offset) => row.id !== cells[offset]?.id)) {
      return { status: "unavailable" }
    }
    rows.forEach(row => citations.add(row.reference))
    if (step.op === "read") {
      const operand = cells[0]!
      if (operand.literal === undefined || operand.distinctKey !== undefined) return { status: "invalid" }
      amounts.set(index, operand.literal)
    } else {
      const distinct = step.op === "count_distinct"
      if (cells.some(cell => cell.literal !== undefined || (cell.distinctKey !== undefined) !== distinct)) {
        return { status: "invalid" }
      }
      amounts.set(index, String(distinct ? new Set(cells.map(cell => cell.distinctKey)).size : cells.length))
    }
  }
  return verifyNumericClaim(claim, index => amounts.get(index)!, [...citations])
}

export function numericInterpretation(id: string, result: NumericVerification): string {
  return result.status === "verified" ? `Verified arithmetic for ${id}: ${result.value}` :
    `Arithmetic for ${id} is unverified (${result.status}).`
}

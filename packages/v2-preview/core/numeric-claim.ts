import { z } from "zod"

const reference = z.string().min(1).max(385)
const field = z.array(z.union([z.string().min(1).max(128), z.number().int().min(0).max(4095)])).min(1).max(8)
const index = z.number().int().min(0).max(31)
const references = z.array(reference).min(1).max(16)
const amount = z.number().finite().refine(value => !Number.isInteger(value) || Number.isSafeInteger(value))
const decimalPlaces = z.number().int().min(0).max(12)
export const DecimalLiteralSchema = z.string().max(128).regex(/^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/)

const stepSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("read"), reference, field }),
  z.strictObject({ op: z.literal("count"), references }),
  z.strictObject({ op: z.literal("count_distinct"), references, field }),
  z.strictObject({ op: z.enum(["add", "subtract", "multiply", "divide"]), inputs: z.tuple([index, index]) }),
  z.strictObject({ op: z.literal("abs"), inputs: z.tuple([index]) }),
  z.strictObject({ op: z.enum(["sum", "mean", "min", "max"]), inputs: z.array(index).min(1).max(16) }),
])

/** The last step is the result. Inputs are zero-based indices of earlier steps. */
export const NumericClaimSchema = z.strictObject({
  expected: amount.describe("The quantity asserted by the finding, checked against source data."),
  steps: z.array(stepSchema).min(1).max(32)
    .describe("Zero-based arithmetic steps. Inputs refer to earlier steps. The last step is the claimed result."),
  decimalPlaces: decimalPlaces.optional().describe("Explicit report precision. Omit for exact comparison."),
}).describe("Use for findings that assert a computed quantity. Cite every operand row in the finding's support.")
export type NumericClaim = z.output<typeof NumericClaimSchema>
export type NumericStep = NumericClaim["steps"][number]

export const NumericVerificationSchema = z.union([
  z.strictObject({ status: z.literal("verified"), value: amount, references, decimalPlaces: decimalPlaces.optional() }),
  z.strictObject({ status: z.enum(["mismatch", "unavailable", "invalid"]) }),
])
export type NumericVerification = z.output<typeof NumericVerificationSchema>

type Fraction = Readonly<{ numerator: bigint; denominator: bigint }>

function gcd(left: bigint, right: bigint): bigint {
  while (right !== 0n) [left, right] = [right, left % right]
  return left < 0n ? -left : left
}

function fraction(numerator: bigint, denominator = 1n): Fraction {
  if (!denominator) throw new Error("division by zero")
  const divisor = gcd(numerator, denominator) * (denominator < 0n ? -1n : 1n)
  const result = { numerator: numerator / divisor, denominator: denominator / divisor }
  if (result.numerator.toString().length > 1024 || result.denominator.toString().length > 1024) {
    throw new Error("arithmetic exceeds the precision bound")
  }
  return result
}

function decimal(literal: string): Fraction {
  const [coefficient, exponent = "0"] = DecimalLiteralSchema.parse(literal).toLowerCase().split("e") as [string, string?]
  const fractionDigits = coefficient.split(".")[1]?.length ?? 0
  const scale = Number(exponent) - fractionDigits
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 512) throw new Error("decimal exceeds the precision bound")
  const integer = BigInt(coefficient.replace(".", ""))
  return scale < 0 ? fraction(integer, 10n ** BigInt(-scale)) : fraction(integer * 10n ** BigInt(scale))
}

export function decimalIdentity(literal: string): string {
  const { numerator, denominator } = decimal(literal)
  return `${numerator}/${denominator}`
}

function add(left: Fraction, right: Fraction): Fraction {
  return fraction(left.numerator * right.denominator + right.numerator * left.denominator,
    left.denominator * right.denominator)
}

function compare(left: Fraction, right: Fraction): bigint {
  return left.numerator * right.denominator - right.numerator * left.denominator
}

function rounded(value: Fraction, places: number): Fraction {
  const scale = 10n ** BigInt(places)
  const scaled = value.numerator * scale
  const whole = scaled / value.denominator
  const remainder = scaled % value.denominator
  if (remainder * 2n >= value.denominator) return fraction(whole + 1n, scale)
  if (remainder * -2n >= value.denominator) return fraction(whole - 1n, scale)
  return fraction(whole, scale)
}

function numericValue(value: Fraction): number {
  // The verified result equals a finite decimal, so its reduced denominator
  // divides a power of ten. Build that decimal without binary intermediates.
  let scale = 0
  let power = 1n
  while (power % value.denominator) {
    scale++
    power *= 10n
  }
  return Number(`${value.numerator * (power / value.denominator)}e-${scale}`)
}

export function numericSourceReferences(step: NumericStep): readonly string[] {
  if (step.op === "read") return [step.reference]
  if (step.op === "count" || step.op === "count_distinct") return step.references
  return []
}

export function validNumericProgram(steps: NumericClaim["steps"]): boolean {
  const used = new Set([steps.length - 1])
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]!
    if (!used.has(index)) return false
    if ("inputs" in step) {
      if (step.inputs.some(input => input >= index)) return false
      step.inputs.forEach(input => used.add(input))
    }
  }
  return true
}

function calculate(step: Extract<NumericStep, { inputs: number[] }>, earlier: readonly Fraction[]): Fraction {
  const inputs = step.inputs.map(index => earlier[index]!)
  const left = inputs[0]!
  const right = inputs[1]!
  switch (step.op) {
    case "add": return add(left, right)
    case "subtract": return fraction(compare(left, right), left.denominator * right.denominator)
    case "multiply": return fraction(left.numerator * right.numerator, left.denominator * right.denominator)
    case "divide": return fraction(left.numerator * right.denominator, left.denominator * right.numerator)
    case "abs": return left.numerator < 0n ? { ...left, numerator: -left.numerator } : left
    case "sum": return inputs.reduce(add)
    case "mean": {
      const total = inputs.reduce(add)
      return fraction(total.numerator, total.denominator * BigInt(inputs.length))
    }
    case "min": return inputs.reduce((a, b) => compare(a, b) <= 0n ? a : b)
    case "max": return inputs.reduce((a, b) => compare(a, b) >= 0n ? a : b)
  }
}

/** Evaluate only host-resolved source quantities. Compare exactly unless reporting precision was declared. */
export function verifyNumericClaim(claim: NumericClaim, sourceValue: (index: number) => string,
  cited: string[]): NumericVerification {
  if (!validNumericProgram(claim.steps)) return { status: "invalid" }
  try {
    const values: Fraction[] = []
    for (const [index, step] of claim.steps.entries()) {
      values.push("inputs" in step ? calculate(step, values) : decimal(sourceValue(index)))
    }
    const exact = values.at(-1)!
    const value = claim.decimalPlaces === undefined ? exact : rounded(exact, claim.decimalPlaces)
    if (compare(value, decimal(String(claim.expected))) !== 0n) return { status: "mismatch" }
    return NumericVerificationSchema.parse({ status: "verified", value: numericValue(value), references: cited,
      ...(claim.decimalPlaces !== undefined && { decimalPlaces: claim.decimalPlaces }) })
  } catch {
    return { status: "invalid" }
  }
}

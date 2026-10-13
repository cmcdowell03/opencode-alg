import { describe, expect, test } from "bun:test"
import { extractJsonDetailed } from "../src/sessions.ts"
import { MAX_AGENT_RESPONSE_TEXT_BYTES } from "../src/limits.ts"

const verdict = { passed: true, failures: [], score: 9 }
const json = JSON.stringify(verdict)
const fenced = (body = json) => ["```json", body, "```"].join("\n")

describe("bounded prose-opener recovery", () => {
  for (const prose of [
    "Here is the { opener gate it uses. All checks done.",
    "Here is the [ opener gate it uses. All checks done.",
    "The { character and the { character are mentioned in prose.",
    "The `{`/`[` opener gate is checked.",
  ]) {
    test(`recovers a closed output fence after ${prose}`, () => {
      expect(extractJsonDetailed(`${prose}\n${fenced()}`, "checker"))
        .toEqual({ value: verdict, candidate_count: 1 })
    })
  }

  test("inline, unlabeled, uppercase and CRLF fences retain compatibility", () => {
    for (const block of [
      `\u0060\u0060\u0060json ${json} \u0060\u0060\u0060`,
      ["```", json, "```"].join("\n"),
      ["```JSON", json, "```"].join("\r\n"),
    ]) {
      expect(extractJsonDetailed(`The { opener is discussed.\n${block}`, "checker"))
        .toEqual({ value: verdict, candidate_count: 1 })
    }
  })

  test("recovery preserves ambiguity and role-schema selection across all candidates", () => {
    const prefix = "The { opener is discussed.\n"
    for (const tail of [fenced(), json]) {
      expect(extractJsonDetailed(`${prefix}${fenced()}\n${tail}`, "checker"))
        .toMatchObject({ value: null, reason: "ambiguous", candidate_count: 2 })
    }
    expect(extractJsonDetailed(`${prefix}${fenced('{"step":1}')}\n${fenced()}`, "checker"))
      .toEqual({ value: verdict, candidate_count: 2 })
    expect(extractJsonDetailed(`${prefix}${fenced('{"step":1}')}\n${fenced()}`))
      .toMatchObject({ value: null, reason: "ambiguous", candidate_count: 2 })
  })

  test("a recovered object still goes to schema validation, not coercion", () => {
    const wrong = { ...verdict, passed: "true" }
    expect(extractJsonDetailed(`The { opener is discussed.\n${fenced(JSON.stringify(wrong))}`, "checker"))
      .toEqual({ value: wrong, candidate_count: 1 })
  })

  for (const text of [
    `The { opener is discussed.\n\u0060\u0060\u0060json\n{"passed":true`,
    `The { opener is discussed.\n\u0060\u0060\u0060json\n${json}`, // missing closing fence
    `The { opener is discussed.\n${fenced('{"passed":true')}`,
    `{"wrapper":${json}`,
    `[${json}`,
    `{"wrapper":\n${fenced()}`,
    `[\n${fenced()}`,
    `Broken object {broken:\n${fenced()}`,
    `Broken array [true,\n${fenced()}`,
    `${json} {"unfinished":`,
    `The { opener is discussed.\n${fenced()}\n{"unfinished":`,
    `{broken:}\n${json}\n{"unfinished":`, // earlier invalid_json must not hide fatal truncation
  ]) {
    test(`fails closed on genuine or uncertain truncation: ${JSON.stringify(text)}`, () => {
      expect(extractJsonDetailed(text, "checker")).toMatchObject({ value: null, reason: "truncated" })
    })
  }

  test("never salvages nested verdicts in balanced malformed parents or arrays", () => {
    expect(extractJsonDetailed(`Malformed parent {broken: ${json}}`, "checker"))
      .toMatchObject({ value: null, reason: "invalid_json" })
    expect(extractJsonDetailed(`The { opener is discussed.\n${fenced(`[${json}]`)}`, "checker"))
      .toMatchObject({ value: null, reason: "not_object" })
    expect(extractJsonDetailed(`The { opener is discussed.\n${fenced(`{broken:${json}}`)}`, "checker"))
      .toMatchObject({ value: null, reason: "invalid_json" })
  })

  test("does not rescan arbitrary later raw objects without a fence boundary", () => {
    expect(extractJsonDetailed(`The { opener is discussed.\n${json}`, "checker"))
      .toMatchObject({ value: null, reason: "truncated", candidate_count: 0 })
  })

  test("escaped quotes, brackets and fence-looking text inside JSON strings stay data", () => {
    const output = { ...verdict, notes: 'quoted " and escaped \\ with { [ ] } and ```json in a string' }
    expect(extractJsonDetailed(`The { opener is discussed.\n${fenced(JSON.stringify(output))}`, "checker"))
      .toEqual({ value: output, candidate_count: 1 })
    const wrapper = JSON.stringify({ wrapper: fenced() })
    expect(extractJsonDetailed(wrapper, "checker"))
      .toEqual({ value: { wrapper: fenced() }, candidate_count: 1 })
  })

  test("prose openers consume the shared eight-span budget", () => {
    const prose = "The { opener is discussed. "
    expect(extractJsonDetailed(`${prose.repeat(7)}\n${fenced()}`, "checker"))
      .toEqual({ value: verdict, candidate_count: 1 })
    for (const count of [8, 9, 100]) {
      expect(extractJsonDetailed(`${prose.repeat(count)}\n${fenced()}`, "checker"))
        .toMatchObject({ value: null, reason: "too_many", candidate_count: 0 })
    }
  })

  test("the response size limit is enforced before recovery", () => {
    expect(extractJsonDetailed(`The { opener. ${"x".repeat(MAX_AGENT_RESPONSE_TEXT_BYTES)}\n${fenced()}`, "checker"))
      .toMatchObject({ value: null, reason: "oversized", candidate_count: 0 })
  })
})

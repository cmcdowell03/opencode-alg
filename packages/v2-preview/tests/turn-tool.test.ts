import { describe, expect, test } from "bun:test"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { z } from "zod"
import { activeQuestion } from "../src/active-question.ts"
import { EvidenceFindingSchema, type EvidenceFinding, type EvidenceReadView, type ReviewSourceSnapshot } from "../src/evidence-reads.ts"
import { TOOL } from "../src/host.ts"
import { buildTurnStatus, presentTurnTool, turnRoutingSchema } from "../src/turn-tool.ts"

const registration = {
  type: "object",
  additionalProperties: false,
  required: ["action"],
  properties: {
    action: { type: "string", enum: ["create", "status", "procedure", "diagnostics", "record_finding", "set_next_measurement", "render_report"] },
    finding_id: { type: "string", maxLength: 128 },
    snapshot_refs: { type: "array", minItems: 1, maxItems: 4, items: { type: "string", maxLength: 385 } },
    source_path: { type: "string", maxLength: 256 },
    source_tool: { type: "string", maxLength: 128 },
    reference_offset: { type: "integer", minimum: 0, maximum: 1024 },
    detail: { type: "boolean" },
    expected_decision_revision: { type: "integer", minimum: 0 },
    next_action: { type: "string", maxLength: 1024 },
    finding: z.toJSONSchema(EvidenceFindingSchema),
  },
}

function nativeRequest(): Pick<SessionContext, "tools"> {
  return { tools: {
    [TOOL]: { input: registration, description: "Record findings and render the acknowledged report." },
    read: { input: { type: "object" }, description: "Read a source." },
  } }
}

test("routing is opt-in with only the two supported modes", () => {
  expect(turnRoutingSchema.parse(undefined)).toBeUndefined()
  expect(turnRoutingSchema.parse("routed")).toBe("routed")
  expect(turnRoutingSchema.parse("routed-compact")).toBe("routed-compact")
  expect(turnRoutingSchema.safeParse("compact").success).toBe(false)
})

describe("native turn presentation", () => {
  test("idle keeps optional lookup and initialization, with a thin schema", () => {
    const request = nativeRequest()
    const other = request.tools.read
    expect(presentTurnTool(request, registration, "idle", ["create", "status", "procedure", "record_finding", "render_report"])).toBe(true)
    expect(request.tools.read).toBe(other)
    const tool = request.tools[TOOL]!
    expect(tool.description).toBe("Use status to recall saved project facts; create opens the investigation for work on this turn. Answer self-contained turns directly.")
    expect(tool.input).toEqual({
      type: "object", additionalProperties: false, required: ["action"],
      properties: {
        action: { type: "string", enum: ["create", "status", "procedure"] },
        finding_id: registration.properties.finding_id,
        snapshot_refs: registration.properties.snapshot_refs,
        source_path: registration.properties.source_path,
        source_tool: registration.properties.source_tool,
        reference_offset: registration.properties.reference_offset,
      },
    })
    expect(Buffer.byteLength(JSON.stringify(tool))).toBeLessThan(700)
    expect(registration.properties.action.enum).toContain("record_finding")
    expect((tool.input.properties as Record<string, unknown>).snapshot_refs).not.toBe(registration.properties.snapshot_refs)
  })

  test("lookup exposes create to open editing and supports an explicit detailed status", () => {
    const request = nativeRequest()
    expect(presentTurnTool(request, registration, "lookup", ["create", "status", "procedure", "set_next_measurement"])).toBe(true)
    expect(request.tools[TOOL]?.input).toMatchObject({
      properties: { action: { enum: ["create", "status", "procedure"] }, detail: { type: "boolean" } },
    })
    expect(request.tools[TOOL]?.input.properties).not.toHaveProperty("next_action")
  })

  test.each(["idle", "lookup"] as const)("%s ablation changes only the advertised properties", phase => {
    const lean = nativeRequest()
    const full = nativeRequest()
    const allowed = ["status", "create", "procedure", "record_finding", "render_report"]
    expect(presentTurnTool(lean, registration, phase, allowed)).toBe(true)
    expect(presentTurnTool(full, registration, phase, allowed, false)).toBe(true)
    const { properties: leanProperties, ...leanInput } = lean.tools[TOOL]!.input
    const { properties: fullProperties, ...fullInput } = full.tools[TOOL]!.input
    expect(lean.tools[TOOL]!.description).toBe(full.tools[TOOL]!.description)
    expect(leanInput).toEqual(fullInput)
    expect(fullProperties).toEqual({
      ...registration.properties, action: { type: "string", enum: ["status", "create", "procedure"] },
    })
    expect(leanProperties).toMatchObject({ action: { type: "string", enum: ["status", "create", "procedure"] } })
    expect(Buffer.byteLength(JSON.stringify(leanInput)) + Buffer.byteLength(JSON.stringify(leanProperties)))
      .toBeLessThan(Buffer.byteLength(JSON.stringify(full.tools[TOOL]!.input)) / 2)
  })

  test.each([true, false])("active work delegates to the full presenter (compact=%s)", compact => {
    const request = nativeRequest()
    const original = request.tools[TOOL]
    expect(presentTurnTool(request, registration, "idle", ["status"], compact)).toBe(true)
    expect(request.tools[TOOL]).not.toBe(original)
    expect(presentTurnTool(request, registration, "active", ["status", "record_finding"], compact)).toBe(false)
    expect(request.tools[TOOL]).toBe(original)
  })

  test.each([true, false])("no available actions removes only a matching native tool (compact=%s)", compact => {
    const request = nativeRequest()
    const read = request.tools.read
    expect(presentTurnTool(request, registration, "idle", [], compact)).toBe(true)
    expect(Object.keys(request.tools)).toEqual(["read"])
    expect(request.tools.read).toBe(read)
    request.tools[TOOL] = { input: { type: "object" }, description: "Different registration." }
    expect(presentTurnTool(request, registration, "idle", [], compact)).toBe(false)
    expect(request.tools[TOOL]?.description).toBe("Different registration.")
  })

  test("presentation never creates a missing tool or edits a different registration", () => {
    const request = nativeRequest()
    delete request.tools[TOOL]
    expect(presentTurnTool(request, registration, "idle", ["status", "create"])).toBe(false)
    expect(request.tools[TOOL]).toBeUndefined()
    const foreign = { description: "A different registration", input: { type: "object" } }
    request.tools[TOOL] = foreign
    expect(presentTurnTool(request, registration, "idle", ["status", "create"])).toBe(false)
    expect(request.tools[TOOL]).toBe(foreign)
  })

  test("availability controls create, procedure, and every other visible action", () => {
    const request = nativeRequest()
    expect(presentTurnTool(request, registration, "idle", ["status", "set_next_measurement"])).toBe(true)
    expect(request.tools[TOOL]?.input).toMatchObject({ properties: { action: { enum: ["status"] } } })
    expect(presentTurnTool(request, registration, "lookup", ["procedure"])).toBe(true)
    expect(request.tools[TOOL]?.input.properties).toEqual({ action: { type: "string", enum: ["procedure"] } })
    expect(presentTurnTool(request, registration, "idle", ["render_report", "foreign"])).toBe(true)
    expect(request.tools[TOOL]).toBeUndefined()
    expect(presentTurnTool(request, registration, "active", ["render_report"])).toBe(false)
    expect(request.tools[TOOL]).toBeUndefined()
  })
})

const source = {
  id: "id-1", reference: "observations.json#row-7", path: "observations.json",
  messageId: "msg_read", callId: "call_read", tool: "read", receipt: "receipt-1", sha256: "a".repeat(64),
}
const finding: EvidenceFinding = {
  id: "first", interpretation: "Recorded interpretation for row 7.", scope: "Shift A", status: "supported",
  attribution: "model", support: [source], counterevidence: [],
}
const unrelated: EvidenceFinding = {
  ...finding, id: "second", interpretation: "Unrequested interpretation.", scope: "Shift B", status: "contested",
}
const evidence: EvidenceReadView = {
  revision: 7, findings: [finding, unrelated], sources: [{ ...source, status: "inspected", references: [source] }],
  question: { findingId: unrelated.id, text: "Did Shift B cover the recorded row?" },
}
const view = { decision_revision: 2, decisionSources: undefined, decision: { next_action: "Check the recorded row." } }
const approval = { approval: "verified" } as const
const question = activeQuestion(view, evidence, approval)

describe("on-demand turn status", () => {
  test("uninitialized status names the question without issuing a create directive", () => {
    const empty: EvidenceReadView = { revision: 0, findings: [], sources: [], question: null }
    const result = buildTurnStatus({ revision: undefined, question: activeQuestion(null, empty, approval), evidence: empty })
    expect(result).toMatchObject({
      investigationMode: "read-only", work: null, decision_revision: 0, evidence_revision: 0, finding_index: [],
      active_question: { state: "investigate", reason: "initialize", question: expect.any(String) },
    })
    expect(result.active_question).not.toHaveProperty("next_action")
  })

  test("default status retains current state and question without projecting evidence details", () => {
    const result = buildTurnStatus({ revision: 9, question, evidence })
    expect(result).toEqual({
      investigationMode: "read-only", work: null, revision: 9, decision_revision: 2, evidence_revision: 7,
      active_question: {
        state: "investigate", reason: "next_measurement", approval: "verified", decision_revision: 2,
        evidence_revision: 7, finding_count: 2, source_count: 1, question: evidence.question!.text, finding_id: unrelated.id,
      },
      finding_index: [
        { id: finding.id, scope: finding.scope, status: finding.status },
        { id: unrelated.id, scope: unrelated.scope, status: unrelated.status },
      ],
    })
  })

  test("the default catalog includes all 16 supported findings and omits absent scopes", () => {
    const full: EvidenceReadView = { ...evidence, findings: Array.from({ length: 16 }, (_, index) => ({
      ...finding, id: "finding-" + index, scope: undefined,
    })) }
    const result = buildTurnStatus({ revision: 9, question: activeQuestion(view, full, approval), evidence: full })
    expect(result).toHaveProperty("finding_index", full.findings.map(({ id, status }) => ({ id, status })))
    expect(JSON.stringify(result)).not.toContain(finding.interpretation)
  })

  test("selected finding preserves exact interpretation and row receipts", () => {
    const result = buildTurnStatus({ revision: 9, question, evidence, selection: { finding_id: finding.id } })
    expect(result).toMatchObject({ evidence: { revision: 7, findings: [finding] }, active_question: { finding_id: unrelated.id } })
    expect(result).not.toHaveProperty("finding_index")
    expect(JSON.stringify(result)).not.toContain(unrelated.interpretation)
    expect(() => buildTurnStatus({ revision: 9, question, evidence, selection: { finding_id: "unknown" } }))
      .toThrow("EVIDENCE_READ_UNKNOWN_FINDING")
  })

  test("selected snapshot retains its historical trust label, misses, and cache flag", () => {
    const snapshot: ReviewSourceSnapshot = {
      revision: 7, trust: "untrusted-source-data", missing: ["absent.md"],
      evidence: [{ source, kind: "json-row", data: { id: "row-7" } }],
    }
    const result = buildTurnStatus({ revision: 9, question, evidence, selection: { snapshot, cache_enabled: true } })
    expect(result).toMatchObject({
      active_question: { evidence_revision: 7, question: evidence.question!.text },
      evidence_snapshot: { ...snapshot, cache_enabled: true },
    })
    expect(result).not.toHaveProperty("evidence")
    expect(result).not.toHaveProperty("finding_index")
    expect(() => buildTurnStatus({ revision: 9, question, evidence, selection: {
      snapshot: { ...snapshot, revision: 6 }, cache_enabled: true,
    } })).toThrow("EVIDENCE_REVISION_CHANGED")
  })

  test("mismatched evidence and unavailable approval fail closed for selected data", () => {
    expect(() => buildTurnStatus({ revision: 9, question, evidence: { ...evidence, revision: 8 } }))
      .toThrow("EVIDENCE_REVISION_CHANGED")
    const stopped = activeQuestion(view, evidence, { approval: "unavailable" })
    expect(buildTurnStatus({ revision: 9, question: stopped, evidence }))
      .toMatchObject({ finding_index: [], active_question: { state: "stop", reason: "approval_unavailable" } })
    expect(() => buildTurnStatus({ revision: 9, question: stopped, evidence, selection: { finding_id: finding.id } }))
      .toThrow("RESEARCH_PROCEDURE_UNVERIFIED")
  })
})

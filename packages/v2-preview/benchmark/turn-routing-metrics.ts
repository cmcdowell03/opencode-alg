import type { SessionMessageInfo } from "@opencode/client"
import { asObject, parseObject, receiptsFor, toolCalls } from "../acceptance/host.ts"
import type { NaturalLongCase } from "./natural-long-cases.ts"
import { type measureNaturalLong, type observedReads, type RequestRow } from "./natural-long-metrics.ts"
import { observeSkillDelivery, wireTextParts } from "./skill-delivery.ts"
import type { Message } from "./transport.ts"

type ArmEvidence = {
  fixture: NaturalLongCase
  rootRows: SessionMessageInfo[]
  checkerRows: SessionMessageInfo[]
  requests: readonly RequestRow[]
  inputs: ReadonlyMap<number, Message[]>
  turns: readonly { phase: string; promptId: string }[]
  pin?: { id: string; sha256: string; witness: string }
  metrics: ReturnType<typeof measureNaturalLong>
  bundleSha256: string
  rootReads: ReturnType<typeof observedReads>
}

const graphPrefix = /^ALG active question(?: delta)? \(untrusted recorded data\)\r?\n/

export function measureTurnRouting({ fixture, rootRows, checkerRows, requests, inputs, turns, pin, metrics, bundleSha256, rootReads }: ArmEvidence) {
  const rootRequests = requests.filter(request => request.role === "root" && request.kind === "ordinary")
  const wire = rootRequests.map(request => {
    const messages = inputs.get(request.id) ?? []
    const texts = messages.flatMap(message => wireTextParts(message.content))
    return {
      requestId: request.id, phase: request.phase, responseStatus: request.status,
      schema: request.investigationSchema ?? null,
      graphFrames: texts.filter(text => graphPrefix.test(text)).length,
      skill: observeSkillDelivery(messages, pin),
    }
  })
  const windows = new Map(turns.map(({ phase, promptId }) => {
    const rows = phase === "checker" ? checkerRows : rootRows
    const start = rows.findIndex(row => row.type === "user" && row.id === promptId)
    if (start < 0) return [phase, [] as SessionMessageInfo[]] as const
    const end = rows.findIndex((row, i) => i > start && (row.type === "idle" || row.type === "user"))
    return [phase, rows.slice(start + 1, end < 0 ? undefined : end)] as const
  }))
  const verified = (rows: SessionMessageInfo[], action: string) =>
    receiptsFor(rows, action).filter(row => row.value.ok === true && row.value.runtimeSha256 === bundleSha256)
  const calibrationInput = (input: Record<string, unknown>) => {
    const finding = asObject(input.finding)
    return finding?.scope === fixture.calibration.id && Array.isArray(finding.support) &&
      finding.support.includes(fixture.calibrationRef)
  }
  const supported = verified(windows.get("triage") ?? [], "record_finding")
    .filter(row => row.value.finding_status === "supported" && calibrationInput(row.input))
  const savedIds = new Set(supported.map(row => row.value.finding_id).filter(id => typeof id === "string"))
  const bridgeRows = windows.get("bridge") ?? []
  const statuses = verified(bridgeRows, "status")
  const indexes = statuses.filter(row => row.input.finding_id === undefined && Array.isArray(row.value.finding_index))
  const indicesAt = (rows: typeof indexes) => new Set(rows.flatMap(row => (row.value.finding_index as unknown[]).flatMap(entry => {
    const item = asObject(entry)
    return item?.scope === fixture.calibration.id && item.status === "supported" && typeof item.id === "string" ? [item.id] : []
  })))
  // The exact historical row is valid only when its call, receipt and body hash agree with an observed root read.
  const early = new Set(toolCalls(windows.get("triage") ?? []).map(call => call.id))
  const assistantBatch = new Map(bridgeRows.flatMap((row, index) => toolCalls([row]).map(call => [call.id, index] as const)))
  const bridgeInputs = rootRequests.filter(request => request.phase === "bridge").map(request =>
    (inputs.get(request.id) ?? []).filter(message => message.role === "tool").flatMap(message =>
      wireTextParts(message.content).map(parseObject).filter(value => value?.ok === true && value.runtimeSha256 === bundleSha256)))
  const findingLookups = statuses.flatMap(row => {
    const findings = asObject(row.value.evidence)?.findings
    if (typeof row.input.finding_id !== "string" || !savedIds.has(row.input.finding_id) || !Array.isArray(findings)) return []
    const finding = findings.map(asObject).find(value => value?.id === row.input.finding_id &&
      value?.scope === fixture.calibration.id && value?.status === "supported")
    if (!finding || !Array.isArray(finding.support) || typeof finding.interpretation !== "string") return []
    const { seal, emptyKg, unitKg } = fixture.calibration
    const interpretation = finding.interpretation
    const labeledNumber = (pattern: RegExp) => Number(pattern.exec(interpretation)?.[1])
    const empty = labeledNumber(/(?:emptyKg|(?:certified\s+)?empty(?:\s+carrier)?\s+(?:mass|weight)|\btare)\s*[:=]?\s*(?:is\s+)?(\d+(?:\.\d+)?)/i)
    const unit = labeledNumber(/(?:unitKg|(?:per[-\s]unit|unit)[-\s]+(?:mass|weight))\s*[:=]?\s*(?:is\s+)?(\d+(?:\.\d+)?)/i)
    const caliber = interpretation.includes(seal) && empty === emptyKg && unit === unitKg
    const sourceBound = finding.support.map(asObject).some(ref => ref?.reference === fixture.calibrationRef &&
      rootReads.some(read => early.has(read.callId) && read.path === ref?.path && read.receipt === ref?.receipt && read.sha256 === ref?.sha256 &&
        read.callId === ref?.callId && read.messageId === ref?.messageId))
    const catalogBefore = indexes.some(item => (assistantBatch.get(item.id) ?? Infinity) < (assistantBatch.get(row.id) ?? -1) &&
      indicesAt([item]).has(row.input.finding_id as string) &&
      bridgeInputs.some(values => values.some(value => JSON.stringify(value) === JSON.stringify(item.value)) &&
        !values.some(value => JSON.stringify(value) === JSON.stringify(row.value))))
    return [{ id: row.id, findingId: row.input.finding_id, discoveredInBridge: catalogBefore,
      calibratedInterpretation: caliber, sourceBound }]
  })
  const calls = toolCalls(rootRows).filter(call => call.name === "alg_investigation")
  const actions = [...new Set(calls.flatMap(call => {
    const action = "input" in call.state ? asObject(call.state.input)?.action : undefined
    return typeof action === "string" ? [action] : []
  }))]
  const receiptsByAction = Object.fromEntries(actions.map(action => [action, verified(rootRows, action).length]))
  const staging = wire.filter(row => /^batch-\d+$/.test(row.phase ?? ""))
  const bridge = wire.filter(row => row.phase === "bridge")
  const bridgeSkill = bridge.find(row => row.requestId === metrics.bridge.finalRequestId)?.skill
  const turnCensus = turns.map(({ phase }) => {
    const rows = windows.get(phase) ?? []
    const role = phase === "checker" ? "checker" : "root"
    const provider = requests.filter(row => row.role === role && row.phase === phase)
    const toolActions: Record<string, number> = {}
    for (const call of toolCalls(rows)) {
      const action = call.name === "alg_investigation" && "input" in call.state
        ? asObject(call.state.input)?.action : undefined
      const key = typeof action === "string" ? call.name + "/" + action : call.name
      toolActions[key] = (toolActions[key] ?? 0) + 1
    }
    const usage = provider.flatMap(row => row.usage ? [row.usage.input] : [])
    const schema = provider.flatMap(row => row.investigationSchema ? [row.investigationSchema] : [])
    return { phase, role, toolActions, providerRequests: provider.length,
      schemaBytes: schema.reduce((total, row) => total + row.bytes, 0),
      activeSchemaBytes: schema.filter(row => row.actions?.includes("record_finding"))
        .reduce((total, row) => total + row.bytes, 0),
      observedInputTokenRows: usage.length, peakObservedInputTokens: usage.length ? Math.max(...usage) : null,
      totalObservedInputTokens: usage.length ? usage.reduce((total, row) => total + row, 0) : null,
    }
  })
  return {
    turnCensus, wire, actions, receiptsByAction, algCalls: calls.length, supportedCalibrationWrites: supported.length,
    bridgeCatalogReceipts: indexes.length, bridgeCatalogHasCalibration: indicesAt(indexes).size > 0, findingLookups,
    bridgeVerifiedProcedureReceipts: verified(bridgeRows, "procedure").filter(row => {
      const procedure = asObject(row.value.procedure)
      return !!pin && procedure?.id === pin.id && procedure.sha256 === pin.sha256 && procedure.content === pin.witness
    }).length,
    bridgeSkillBodyRoles: bridgeSkill?.roles ?? [],
    stagingRequestCount: staging.length,
    stagingGraphRequests: staging.filter(row => row.graphFrames > 0).length,
    stagingProcedureProjectionRequests: staging.filter(row => row.skill.projectionRoles.length > 0).length,
    stagingWorkSchemaRequests: staging.filter(row => row.schema?.actions?.includes("record_finding")).length,
    lookupGraphRequests: bridge.filter(row => row.graphFrames > 0).length,
    triageGraphRequests: wire.filter(row => row.phase === "triage" && row.graphFrames > 0).length,
  }
}


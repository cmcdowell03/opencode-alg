import { asObject, parseObject } from "../acceptance/host.ts"
import { scopedTools } from "./discovery-tools.ts"
import { naturalLongSkillName, phaseMarker, type NaturalLongCase } from "./natural-long-cases.ts"
import { naturalLongScript } from "./natural-long-script.ts"
import { wireTextParts } from "./skill-delivery.ts"
import type { Completion, TurnInput } from "./transport.ts"

type Calibration = { seal: string; emptyKg: number; unitKg: number }

function usable(seal: unknown, emptyKg: unknown, unitKg: unknown): Calibration | undefined {
  if (typeof seal === "string" && typeof emptyKg === "number" && Number.isFinite(emptyKg) &&
      typeof unitKg === "number" && Number.isFinite(unitKg) && unitKg > 0) return { seal, emptyKg, unitKg }
}

function sourceCalibration(rows: Record<string, unknown>[], reference: string): Calibration | undefined {
  const [path, id] = reference.split("#")
  for (const value of rows.slice().reverse()) {
    if (value.path !== path || typeof value.receipt !== "string" || typeof value.content !== "string") continue
    try {
      const source: unknown = JSON.parse(value.content)
      if (!Array.isArray(source)) continue
      const row = source.map(asObject).find(row => row?.id === id)
      if (row) return usable(row.calibrationSeal, row.emptyKg, row.unitKg)
    } catch { /* Fail closed on an invalid source result. */ }
  }
}

function graphCalibration(rows: Record<string, unknown>[], reference: string): Calibration | undefined {
  for (const value of rows.slice().reverse()) {
    if (value.ok !== true) continue
    const findings = asObject(value.evidence)?.findings
    if (!Array.isArray(findings)) continue
    for (const item of findings.map(asObject)) {
      if (item?.status !== "supported" || !Array.isArray(item.support) ||
          !item.support.some(ref => asObject(ref)?.reference === reference) || typeof item.interpretation !== "string") continue
      const parsed = /^Certified calibration seal (\S+), emptyKg ([\d.]+), unitKg ([\d.]+)$/.exec(item.interpretation)
      if (parsed) return usable(parsed[1], Number(parsed[2]), Number(parsed[3]))
    }
  }
}

function visibleMethod(input: TurnInput) {
  for (const message of input.messages.slice().reverse()) {
    for (const text of wireTextParts(message.content)) {
      const pinned = message.role === "tool" ? parseObject(text) : undefined
      const approved = pinned?.ok === true && asObject(pinned.procedure)?.id === naturalLongSkillName
        ? asObject(pinned.procedure)?.content : undefined
      const nativeSkill = message.role === "tool" && text.includes('<skill_content name="' + naturalLongSkillName + '"')
      const projected = (message.role === "system" || message.role === "developer") &&
        text.includes("ALG current approved research procedure " + naturalLongSkillName + " (SHA-256 ")
      const content = typeof approved === "string" ? approved : nativeSkill || projected ? text : ""
      const method = /method code "([^"]+)"/.exec(content)?.[1]
      if (method) return method
    }
  }
  return null
}

export function scriptedBridgeAnswer(input: TurnInput, reference: string, requireGraph: boolean) {
  const toolObjects = input.messages.filter(message => message.role === "tool").flatMap(message =>
    wireTextParts(message.content).map(parseObject).filter(row => row !== undefined))
  const calibration = requireGraph ? graphCalibration(toolObjects, reference) : sourceCalibration(toolObjects, reference)
  const latestBridge = input.messages.filter(message => message.role === "user").reverse()
    .flatMap(message => wireTextParts(message.content)).find(text => text.startsWith(phaseMarker("bridge")))
  const gross = / at gross (\d+(?:\.\d+)?) kg\./.exec(latestBridge ?? "")?.[1]
  return { units: gross && calibration ? (Number(gross) - calibration.emptyKg) / calibration.unitKg : null,
    calibrationSeal: calibration?.seal ?? null, method: visibleMethod(input) }
}

export function turnRoutingScript(fixture: NaturalLongCase, phase: () => string, installed: boolean) {
  const baseline = naturalLongScript(fixture, phase, installed)
  let bridgeStep = 0
  let checkerStep = 0
  let triageStep = 0
  const read = (path: string, role: "root" | "checker" = "root") => ({ tool: scopedTools(role).read, args: { path } })
  const alg = (args: Record<string, unknown>) => ({ tool: "alg_investigation", args })
  const skill = { tool: "skill", args: { id: naturalLongSkillName } }
  return (input: TurnInput): Completion => {
    if (input.summary) return baseline(input)
    if (phase() === "checker" && fixture.id !== "willow-yard" && input.tools.includes(scopedTools("checker").read)) {
      const path = [fixture.files.board, fixture.files.count, fixture.files.custody, fixture.incident.input.sources.at(-1)!.path][checkerStep++]
      return path ? read(path, "checker") : { text: "Reviewed the signed count against the custody index and supplemental record." }
    }
    if (phase() !== "bridge" && phase() !== "triage") return baseline(input)
    const saved = input.messages.filter(message => message.role === "tool").flatMap(message =>
      wireTextParts(message.content).map(parseObject).filter(row => row !== undefined))
    if (phase() === "triage") {
      const step = triageStep++
      if (installed && step === 0) return alg({ action: "create" })
      if (step === (installed ? 1 : 0)) return read(fixture.files.registry)
      if (installed && step === 2) {
        const calibration = sourceCalibration(saved, fixture.calibrationRef)
        if (calibration) return alg({ action: "record_finding", expected_decision_revision: 0,
          finding: { id: fixture.id === "willow-yard" ? "carrier-calibration" : fixture.id + "-calibration", scope: fixture.calibration.id, support: [fixture.calibrationRef], counterevidence: [],
            interpretation: `Certified calibration seal ${calibration.seal}, emptyKg ${calibration.emptyKg}, unitKg ${calibration.unitKg}` } })
      }
      if (installed && step === 3) return alg({ action: "status" })
      if (!installed && step === 1) return skill
      return { text: "Calibration checked." }
    }
    const step = bridgeStep++
    const answer = scriptedBridgeAnswer(input, fixture.calibrationRef, installed)
    if (installed && step === 0) return alg({ action: "status" })
    if (installed && step === 1) {
      const catalog = saved.filter(row => row.ok === true)
        .flatMap(row => Array.isArray(row.finding_index) ? row.finding_index.map(asObject) : [])
      const match = catalog.find(row => row?.scope === fixture.calibration.id && row.status === "supported")
      if (typeof match?.id === "string") return alg({ action: "status", finding_id: match.id })
    }
    if (installed && step === 2) return alg({ action: "procedure" })
    if (!installed && step === 0 && answer.units === null) return read(fixture.files.registry)
    if (!installed && step < 3 && answer.method === null) return skill
    return { text: JSON.stringify(answer) }
  }
}


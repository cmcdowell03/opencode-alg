import { asObject, parseObject } from "../acceptance/host.ts"
import { scopedTools, type Scope } from "./discovery-tools.ts"
import { naturalLongSkillName, phaseMarker } from "./natural-long-cases.ts"
import { naturalLongScript } from "./natural-long-script.ts"
import { wireTextParts } from "./skill-delivery.ts"
import { synthesisPairCases, synthesisPairChange } from "./synthesis-pair-cases.ts"
import type { TurnInput } from "./transport.ts"

const calibrationFinding = "bench-pulse-calibration"
const read = (path: string, scope: Scope = "root") => ({ tool: scopedTools(scope).read, args: { path } })
const alg = (args: Record<string, unknown>) => ({ tool: "alg_investigation", args })
const skill = { tool: "skill", args: { id: naturalLongSkillName } }

function toolTexts(messages: TurnInput["messages"]) {
  return messages.filter(message => message.role === "tool").flatMap(message => wireTextParts(message.content))
}

function receipt(texts: string[], path: string) {
  return texts.slice().reverse().map(parseObject).find(row => row?.path === path &&
    typeof row.receipt === "string" && row.receipt.length > 0 && typeof row.content === "string")
}

function sourceRow(content: unknown, id: string) {
  if (typeof content !== "string") return
  try {
    const rows: unknown = JSON.parse(content)
    if (Array.isArray(rows)) return rows.map(asObject).find(row => row?.id === id)
  } catch { /* Invalid source bodies convey no evidence. */ }
}

function calibration(seal: unknown, zeroPulseReading: unknown, pulsesPerMicrometre: unknown) {
  if (typeof seal === "string" && seal.length && typeof zeroPulseReading === "number" &&
      Number.isFinite(zeroPulseReading) && typeof pulsesPerMicrometre === "number" &&
      Number.isFinite(pulsesPerMicrometre) && pulsesPerMicrometre > 0) {
    return { seal, zeroPulseReading, pulsesPerMicrometre }
  }
}

function recordedCalibration(texts: string[], reference: string, scope: string) {
  for (const text of texts) {
    const result = parseObject(text)
    const claims = asObject(result?.synthesis)?.claims
    if (result?.ok !== true || !Array.isArray(claims)) continue
    const claim = claims.map(asObject).find(row => row?.id === calibrationFinding && row.scope === scope &&
      row.state === "supported-scoped" && Array.isArray(row.support) &&
      row.support.some(link => asObject(link)?.reference === reference))
    const values = typeof claim?.interpretation === "string" &&
      /^Certified calibration seal (\S+), zeroPulseReading (-?\d+(?:\.\d+)?), pulsesPerMicrometre (\d+(?:\.\d+)?)$/.exec(claim.interpretation)
    if (values) return calibration(values[1], Number(values[2]), Number(values[3]))
  }
}

export const synthesisPairScript: typeof naturalLongScript = (fixture, phase, installed) => {
  const base = naturalLongScript(fixture, phase, installed)
  const steps = new Map<string, number>()
  const catalogPath = synthesisPairChange.path
  const conditional = fixture.id === synthesisPairCases[1].id
  const { registry } = fixture.files
  const procedureBody = fixture.skill.replace(/^---[\s\S]*?\r?\n---\r?\n/, "").trim()
  const candidate = fixture.fixtureAnswer
  const sources = new Map(fixture.incident.input.sources.map(row => [row.path, row.content]))
  const citedPaths = [...new Set(candidate.claims.flatMap(claim => claim.evidence.map(ref => ref.split("#", 1)[0]!)))]
  const failure = (reason: string) => ({ text: "Scripted qualification failed: " + reason, reason })

  function readCalibration(texts: string[]) {
    const row = sourceRow(receipt(texts, registry)?.content, fixture.calibration.id)
    return calibration(row?.calibrationSeal, row?.zeroPulseReading, row?.pulsesPerMicrometre)
  }

  return input => {
    const current = phase()
    if (input.summary || !["triage", "bridge", "checker", "final"].includes(current)) return base(input)
    const step = steps.get(current) ?? 0
    steps.set(current, step + 1)
    const reversedPromptIndex = input.messages.slice().reverse().findIndex(message => message.role === "user" &&
      wireTextParts(message.content).some(text => text.trimStart().startsWith(phaseMarker(current))))
    const promptIndex = reversedPromptIndex < 0 ? -1 : input.messages.length - 1 - reversedPromptIndex
    const texts = promptIndex < 0 ? [] : toolTexts(input.messages.slice(promptIndex + 1))

    if (current === "triage") {
      if (step === 0) return read(catalogPath)
      if (step === 1) return read(registry)
      const opening = conditional ? synthesisPairChange.before : sources.get(catalogPath)
      const certificate = readCalibration(texts)
      if (!certificate || !opening || receipt(texts, catalogPath)?.content !== opening) return failure("opening-evidence")
      if (installed && step === 2) return alg({ action: "create" })
      if (installed && step === 3) return alg({ action: "record_finding", expected_decision_revision: 0, finding: {
        id: calibrationFinding, scope: fixture.calibration.id, support: [fixture.calibrationRef], counterevidence: [],
        interpretation: `Certified calibration seal ${certificate.seal}, zeroPulseReading ${certificate.zeroPulseReading}, pulsesPerMicrometre ${certificate.pulsesPerMicrometre}`,
      } })
      return { text: "I checked the opening catalog and bench calibration." }
    }

    if (current === "bridge") {
      if (step === 0) return installed ? alg({ action: "status", synthesis: { claims: [calibrationFinding] } }) : read(registry)
      if (step === 1) return installed ? alg({ action: "procedure" }) : skill
      const certificate = installed ? recordedCalibration(texts, fixture.calibrationRef, fixture.calibration.id) : readCalibration(texts)
      const procedure = texts.flatMap(text => {
        const result = parseObject(text)
        const pinned = asObject(result?.procedure)
        if (installed && result?.ok === true && pinned?.id === naturalLongSkillName && typeof pinned.content === "string") {
          return [pinned.content]
        }
        return !installed && text.includes('<skill_content name="' + naturalLongSkillName + '"') ? [text] : []
      }).find(text => text.replace(/\r\n/g, "\n").includes(procedureBody.replace(/\r\n/g, "\n")))
      const method = procedure && /method code "([^"]+)"/.exec(procedure)?.[1]
      const prompt = input.messages[promptIndex]
      const gross = prompt && /returned (\d+(?:\.\d+)?) gross pulses/.exec(wireTextParts(prompt.content).join("\n"))?.[1]
      const units = gross && certificate ? (Number(gross) - certificate.zeroPulseReading) / certificate.pulsesPerMicrometre : null
      if (units !== fixture.bridgeAnswer.units || certificate?.seal !== fixture.bridgeAnswer.calibrationSeal ||
          method !== fixture.bridgeAnswer.method) return failure("bridge-evidence")
      return { text: JSON.stringify({ units, calibrationSeal: certificate.seal, method }) }
    }

    const scope = current === "checker" ? "checker" : "root"
    const path = citedPaths[step]
    if (path) return read(path, scope)
    if (candidate.missingEvidence.length && step === citedPaths.length) {
      return { tool: scopedTools(scope).list, args: {} }
    }
    const missingConfirmed = !candidate.missingEvidence.length || texts.map(parseObject).some(row =>
      Array.isArray(row?.paths) && citedPaths.every(path => row.paths instanceof Array && row.paths.includes(path)) &&
      candidate.missingEvidence.every(path => row.paths instanceof Array && !row.paths.includes(path)))
    const exactCitations = candidate.claims.every(claim => claim.evidence.every(ref => {
      const [path, id] = ref.split("#")
      if (!path || !id) return false
      const content = receipt(texts, path)?.content
      return content === sources.get(path) && !!sourceRow(content, id)
    }))
    if (!exactCitations || !missingConfirmed) return failure("current-source-evidence")
    return { text: current === "checker"
      ? "Independent source review: " + JSON.stringify(candidate)
      : JSON.stringify(candidate) }
  }
}

import { naturalLongSkillName, scriptSummary, type NaturalLongCase } from "./natural-long-cases.ts"
import { scopedTools } from "./discovery-tools.ts"
import { wireTextParts } from "./skill-delivery.ts"
import type { Completion, TurnInput } from "./transport.ts"

export function naturalLongScript(fixture: NaturalLongCase, phase: () => string, installed: boolean) {
  const counts = new Map<string, number>()
  let summaries = 0
  const read = (path: string, role: "root" | "checker" = "root") => ({ tool: scopedTools(role).read, args: { path } })
  const skill = { tool: "skill", args: { id: naturalLongSkillName } }
  const alg = (args: Record<string, unknown>) => ({ tool: "alg_investigation", args })
  return (input: TurnInput): Completion => {
    if (input.summary) return { text: [
      "## Objective", "- Reconcile the dispatch incident.", "",
      "## Requirements", "- Use source row references.", "",
      "## Decisions", "- Dispatch closure has not been assessed.", "",
      "## Work State", "### Completed", "- Staging review in progress, checkpoint " + ++summaries + ".",
      "### Active", "- " + scriptSummary, "### Blocked", "- (none)", "",
      "## Next Move", "1. Check decisive evidence before closure.", "", "## Relevant Files", "- (none)",
    ].join("\n") }
    const step = counts.get(phase()) ?? 0
    counts.set(phase(), step + 1)
    const texts = input.messages.flatMap(message => wireTextParts(message.content))
    switch (phase()) {
      case "triage": {
        const steps = [
          ...installed ? [alg({ action: "create" })] : [],
          read(fixture.files.registry),
          ...installed ? [alg({ action: "record_finding", expected_decision_revision: 0,
            finding: { id: "carrier-calibration", scope: fixture.calibration.id, support: [fixture.calibrationRef],
              counterevidence: [], interpretation: "Certified calibration seal " + fixture.calibration.seal +
                ", emptyKg " + fixture.calibration.emptyKg + ", unitKg " + fixture.calibration.unitKg } }),
            alg({ action: "status" })] : [skill],
        ]
        return steps[step] ?? { text: "Calibration checked." }
      }
      case "bridge": {
        const sealVisible = texts.some(text => text.includes(fixture.bridgeAnswer.calibrationSeal))
        const methodVisible = texts.some(text => text.includes(fixture.bridgeAnswer.method))
        if (!sealVisible && installed && step === 0) return alg({ action: "status", finding_id: "carrier-calibration" })
        if (!sealVisible && step < 2) return read(fixture.files.registry)
        if (!methodVisible && step < 3) return skill
        return { text: JSON.stringify({
          units: sealVisible ? fixture.bridgeAnswer.units : null,
          calibrationSeal: sealVisible ? fixture.bridgeAnswer.calibrationSeal : null,
          method: methodVisible ? fixture.bridgeAnswer.method : null,
        }) }
      }
      case "checker": {
        if (!input.tools.includes(scopedTools("checker").read)) return { text: "Reconciliation is in progress." }
        const path = [fixture.files.board, fixture.files.count, fixture.files.custody][step]
        return path ? read(path, "checker") : { text: "I checked the flagged consignment against the signed count and custody index." }
      }
      case "final": {
        const source = fixture.incident.input.sources[step]
        if (source) return read(source.path)
        return { text: JSON.stringify(fixture.fixtureAnswer) }
      }
      default: {
        const match = /^batch-(\d+)$/.exec(phase())
        if (!match) throw new Error("Script received an unplanned phase")
        const batch = Number(match[1])
        return { text: JSON.stringify(fixture.batches[batch - 1]!.answer),
          // Synthetic usage can qualify host routing but cannot measure actual input tokens.
          pressure: step === 0 && (batch === 2 || batch === 5) ? 8800 : 1200 }
      }
    }
  }
}

export function checkerAdvisory(text: string, reads: readonly { path: string }[]) {
  const paths = [...new Set(reads.map(row => row.path))].sort()
  return paths.length
    ? { note: text.slice(0, 4000), verifiedPaths: paths }
    : { note: null, verifiedPaths: paths }
}


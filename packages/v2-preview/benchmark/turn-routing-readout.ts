import { open, readFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileDigest } from "../acceptance/runtime.ts"

type Arm = {
  trial: string; incident: string; arm: string; historical?: boolean; outcome: string; problem: string | null
  accuracy?: boolean; finalObserved?: boolean; disposition?: string | null; unsupportedClosure?: boolean | null
  bridge?: { correctMethodCode: boolean; correctEarlyCalibrationSeal: boolean; correctConversion: boolean;
    afterObservedAuto: boolean; freshRegistryReadsDuringBridge: number }
  checkerVerifiedReads?: number; duplicateReads?: number
  automaticCompleted?: number; automaticAppliedCount?: number; manual?: number
  routing?: { algCalls: number; supportedCalibrationWrites: number; bridgeVerifiedProcedureReceipts: number;
    bridgeSkillBodyRoles: string[]; stagingGraphRequests: number; lookupGraphRequests: number;
    findingLookups: { discoveredInBridge: boolean; calibratedInterpretation: boolean; sourceBound: boolean }[];
    turnCensus: { phase: string; toolActions: Record<string, number>; schemaBytes: number; activeSchemaBytes: number }[] }
  usage?: { all: { calls: number; observedInputTokenRows: number; totalObservedInputTokens: number | null;
    peakObservedInputTokens: number | null }; root?: { peakObservedInputTokens: number | null } }
}
type Report = {
  mode: string; freezeSha256: string; assigned: number; attempted: number; runtimeUnchanged: boolean
  arms: Arm[]; historicalControls: Arm[]; artifactSha256: Record<string, string>
}

const flag = (value: boolean | null | undefined) => value == null ? "—" : value ? "yes" : "no"
const qty = (value: number | null | undefined) => value?.toLocaleString("en-US") ?? "—"
const armLabel: Record<string, string> = { build: "Build", "build-focused": "Focused Build", "alg-routed-compact": "Routed compact ALG" }
const caseLabel: Record<string, string> = { "willow-yard": "Willow Yard", "birch-siding": "Birch Siding", "larch-depot": "Larch Depot" }
const phaseLabel: Record<string, string> = { triage: "Triage", "batch-1": "Batch 1", "batch-2": "Batch 2",
  "batch-3": "Batch 3", "batch-4": "Batch 4", "batch-5": "Batch 5", "batch-6": "Batch 6",
  bridge: "Bridge", checker: "Checker", final: "Final" }

function issue(value: string | null) { return value && /^[A-Z][A-Z0-9_]+$/.test(value) ? " (`" + value + "`)" : "" }
function line(fields: (string | number)[]) { return "| " + fields.join(" | ") + " |" }

async function verifyTerminal(directory: string, report: Report) {
  const privateDir = join(directory, "private")
  for (const [name, digest] of Object.entries(report.artifactSha256)) {
    if (!/^[a-z0-9.-]+$/.test(name) || await fileDigest(join(privateDir, name)) !== digest)
      throw new Error("Terminal artifact hash mismatch")
  }
  const raw = await readFile(join(privateDir, "events.jsonl"), "utf8")
  const events = raw.trimEnd().split(/\r?\n/).map(line => JSON.parse(line))
  const runStarts = events.filter(event => event.event === "run-start")
  if (runStarts.length !== 1 || runStarts[0].freezeSha256 !== report.freezeSha256 ||
      events.filter(event => event.event === "run-end").length !== 1 ||
      events.filter(event => event.event === "arm-start").length !== report.assigned ||
      events.filter(event => event.event === "arm-end").length !== report.attempted ||
      report.attempted !== report.arms.length || report.assigned !== report.attempted)
    throw new Error("Terminal roster and journal do not reconcile")
  for (const arm of report.arms) {
    if (!report.artifactSha256[arm.trial + ".json"] ||
        events.filter(event => event.event === "arm-start" && event.trial === arm.trial).length !== 1 ||
        events.filter(event => event.event === "arm-end" && event.trial === arm.trial && event.outcome === arm.outcome).length !== 1)
      throw new Error("Missing or ambiguous arm terminal receipt")
  }
  const providerKey = (event: { trial: string; request: { id: number } }) => event.trial + "/" + event.request.id
  const provider = events.filter(event => event.event === "provider")
  const admitted = provider.filter(event => event.transition === "admission").map(providerKey).sort()
  const terminal = provider.filter(event => event.transition === "terminal").map(providerKey).sort()
  const paired = admitted.length === new Set(admitted).size && JSON.stringify(admitted) === JSON.stringify(terminal)
  return { admitted: admitted.length, terminal: terminal.length, paired }
}

export async function writeTurnRoutingReadout(directory: string, output: string) {
  const reportPath = join(directory, "report.json")
  const report: Report = JSON.parse(await readFile(reportPath, "utf8"))
  if (report.mode !== "native-oauth" || !/^[a-f0-9]{64}$/.test(report.freezeSha256))
    throw new Error("Expected terminal native report")
  const journal = await verifyTerminal(directory, report)
  const rows = [...report.historicalControls, ...report.arms]
  type BridgeWire = { phase: string; requestId: number; factInGraph: boolean; factInSummary: boolean;
    factInVerifiedSourcePayload: boolean; graphStatusPresent: boolean; graphBriefPresent: boolean }
  type Request = { phase: string; role: string; kind: string; usage?: { input: number } }
  const evidence = new Map(await Promise.all(report.arms.map(async arm => {
    const receipt: { metrics?: { postBoundaryInputs: BridgeWire[]; bridge: { finalRequestId: number | null } };
      requests?: Request[] } = JSON.parse(await readFile(join(directory, "private", arm.trial + ".json"), "utf8"))
    const wire = receipt.metrics?.postBoundaryInputs.find(row =>
      row.phase === "bridge" && row.requestId === receipt.metrics?.bridge.finalRequestId)
    const statusWitness = wire?.factInGraph === true && wire.graphStatusPresent && !wire.graphBriefPresent
    const labels = [wire?.factInGraph && (statusWitness ? "graph status" : "graph"),
      wire?.factInSummary && "summary", wire?.factInVerifiedSourcePayload && "source"].filter(label => typeof label === "string")
    const requests = receipt.requests?.filter(row => row.role === "root" && row.phase === "final")
    const spend = (kind: string) => {
      const rows = requests?.filter(row => row.kind === kind)
      return { requests: rows?.length, tokens: rows?.every(row => row.usage) ? rows.reduce((sum, row) => sum + row.usage!.input, 0) : undefined }
    }
    return [arm.trial, { sealOnWire: labels.join(", ") || (wire ? "none verified" : "—"),
      statusWitness, summaryFact: wire?.factInSummary, registryFact: wire?.factInVerifiedSourcePayload, ordinary: spend("ordinary"), summary: spend("summary") }] as const
  })))
  const scored = report.arms.filter(arm => arm.accuracy === true).length
  const unsupported = report.arms.filter(arm => arm.unsupportedClosure === true).length
  const unknown = report.arms.filter(arm => arm.unsupportedClosure == null).length
  const out = [
    "# PR17 native Luna turn-routing benchmark", "",
    `Freeze SHA-256 \`${report.freezeSha256}\`. Terminal report SHA-256 \`${await fileDigest(reportPath)}\`.`, "",
    `${report.attempted}/${report.assigned} new arms attempted, ${report.arms.filter(arm => arm.outcome === "complete").length} completed, and ${scored} passed the primary incident grade. Unsupported closure was observed in ${unsupported}, and closure was unscorable in ${unknown}. The staged runtime remained unchanged \`${flag(report.runtimeUnchanged)}\`.`, "",
    `The journal contains one run and ${report.attempted} arm terminal receipts. Provider admissions and terminals number ${journal.admitted} and ${journal.terminal} with exact pairing ${flag(journal.paired)}.`, "",
    "Willow uses two hash-verified historical controls. Birch and Larch are same-run paired comparisons. The primary grade accepts recognized aliases, repeated supported targets, and extra references to existing rows from verified root reads. Blind review is a separate endpoint. The samples and traces describe these runs. Model choices can mediate any treatment effect.", "",
    "## Per-arm results", "",
    "| Case | Arm | Terminal outcome | Incident pass | Disposition | Unsupported closure | Bridge method / seal / units | Duplicate reads | Autos applied / complete | Input total / all peak / root peak | Usage rows |",
    "| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: |",
  ]
  for (const arm of rows) {
    const bridge = arm.bridge, usage = arm.usage?.all
    out.push(line([caseLabel[arm.incident] ?? "Unknown", (armLabel[arm.arm] ?? "Unknown") + (arm.historical ? " (historical)" : ""),
      arm.outcome + issue(arm.problem), flag(arm.accuracy), arm.disposition ?? "—", flag(arm.unsupportedClosure),
      bridge ? [bridge.correctMethodCode, bridge.correctEarlyCalibrationSeal, bridge.correctConversion].map(flag).join(" / ") : "—",
      qty(arm.duplicateReads), qty(arm.automaticAppliedCount) + " / " + qty(arm.automaticCompleted),
      qty(usage?.totalObservedInputTokens) + " / " + qty(usage?.peakObservedInputTokens) + " / " + qty(arm.usage?.root?.peakObservedInputTokens),
      qty(usage?.observedInputTokenRows) + " / " + qty(usage?.calls)]))
  }
  out.push("", "Observed input tokens include cached input. The configured root context was 8,192 tokens. The new arms had " + report.arms.reduce((total, arm) => total + (arm.manual ?? 0), 0) + " observed manual boundaries. A missing final fails primary accuracy and leaves closure unscorable.", "",
    "## Routing and evidence receipts", "",
    "| Case | Arm | ALG calls | Supported early calibration writes | Attested bridge readbacks / prior catalog | Approved procedure receipts | Skill body on bridge wire | Seal on bridge wire | Bridge registry rereads | Graph requests in staging / bridge | Schema bytes / active bytes |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- | --- | ---: | ---: | ---: |")
  for (const arm of report.arms) {
    const route = arm.routing
    const attested = route?.findingLookups.filter(row => row.calibratedInterpretation && row.sourceBound)
    const schema = route?.turnCensus.reduce((sum, row) => sum + row.schemaBytes, 0)
    const active = route?.turnCensus.reduce((sum, row) => sum + row.activeSchemaBytes, 0)
    out.push(line([caseLabel[arm.incident] ?? "Unknown", armLabel[arm.arm] ?? "Unknown", qty(route?.algCalls),
      qty(route?.supportedCalibrationWrites), qty(attested?.length) + " / " + qty(attested?.filter(row => row.discoveredInBridge).length),
      qty(route?.bridgeVerifiedProcedureReceipts), route?.bridgeSkillBodyRoles.join(", ") || "—", evidence.get(arm.trial)?.sealOnWire ?? "—", qty(arm.bridge?.freshRegistryReadsDuringBridge),
      qty(route?.stagingGraphRequests) + " / " + qty(route?.lookupGraphRequests), qty(schema) + " / " + qty(active)]))
  }
  out.push("", "An attested readback matches labeled calibration values and links to the exact prior root-read row. Catalog credit requires a separate earlier response visible on the bridge wire. Active schema bytes count schemas offering a recording action.", "")
  const routed = report.arms.filter(arm => arm.arm === "alg-routed-compact")
  const conversions = routed.filter(arm => arm.bridge?.correctConversion)
  const graphWitnesses = conversions.filter(arm => evidence.get(arm.trial)?.statusWitness).length
  const summaryWitnesses = conversions.filter(arm => evidence.get(arm.trial)?.summaryFact).length
  const registryWitnesses = conversions.filter(arm => evidence.get(arm.trial)?.registryFact).length
  const attested = conversions.filter(arm => arm.routing?.findingLookups.some(row =>
    row.calibratedInterpretation && row.sourceBound && row.discoveredInBridge)).length
  const routedOrdinary = routed.reduce((total, arm) => total + (evidence.get(arm.trial)?.ordinary.tokens ?? 0), 0)
  const routedSummaries = routed.reduce((total, arm) => total + (evidence.get(arm.trial)?.summary.tokens ?? 0), 0)
  out.push(`Routed compact ALG produced correct bridge conversions in ${conversions.length}/${routed.length} arms. A runtime-verified status result carried the seal on the final post-boundary bridge request in ${graphWitnesses}/${conversions.length} correct conversions. The applied summary carried the seal in ${summaryWitnesses}/${conversions.length} and verified registry payload in ${registryWitnesses}/${conversions.length}. The stricter catalog-to-selected-finding attestation held in ${attested}/${conversions.length}.`, "",
    "## Final-turn input spend", "",
    `Ordinary root requests accounted for ${qty(routedOrdinary)} of ${qty(routedOrdinary + routedSummaries)} routed final-turn input tokens (${Math.round(100 * routedOrdinary / (routedOrdinary + routedSummaries))}%). Auto-compaction summaries accounted for the remaining ${qty(routedSummaries)}. Each routed arm issued repeated status lookups and evidence reads during final. The traces establish where the tokens were spent and leave causal attribution between routing and model behavior unresolved.`, "",
    "| Case | Arm | Ordinary requests / input tokens | Summary requests / input tokens | Status calls | Source reads |",
    "| --- | --- | ---: | ---: | ---: | ---: |")
  for (const arm of report.arms) {
    const row = evidence.get(arm.trial)!
    const tools = arm.routing?.turnCensus.find(turn => turn.phase === "final")?.toolActions
    out.push(line([caseLabel[arm.incident] ?? "Unknown", armLabel[arm.arm] ?? "Unknown",
      qty(row.ordinary.requests) + " / " + qty(row.ordinary.tokens),
      qty(row.summary.requests) + " / " + qty(row.summary.tokens),
      qty(tools ? tools["alg_investigation/status"] ?? 0 : undefined),
      qty(tools ? tools.sources_discovery_read ?? 0 : undefined)]))
  }
  out.push("",
    "## Turn-level tool actions and schema bytes", "",
    "Cells show root or checker calls by action and provider schema bytes as total / active. Zero indicates an observed turn without calls or schema. — indicates an unobserved turn.", "",
    line(["Arm", ...Object.values(phaseLabel)]), line(Array(Object.keys(phaseLabel).length + 1).fill("---")))
  for (const arm of report.arms) {
    const cells = Object.keys(phaseLabel).map(phase => {
      const row = arm.routing?.turnCensus.find(item => item.phase === phase)
      if (!row) return "—"
      const actions = Object.entries(row.toolActions).map(([name, count]) => {
        const short = name.replace(/^alg_investigation\//, "").replace(/^(?:sources|audit)_discovery_/, "")
        return /^[a-z_]+$/.test(short) ? short + "×" + count : "other×" + count
      })
      return (actions.join(", ") || "0") + "<br>" + qty(row.schemaBytes) + " / " + qty(row.activeSchemaBytes)
    })
    out.push(line([caseLabel[arm.incident] + " · " + armLabel[arm.arm], ...cells]))
  }
  const file = await open(resolve(output), "wx", 0o600)
  try { await file.writeFile(out.join("\n") + "\n"); await file.sync() }
  finally { await file.close() }
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2)
  if (!input || !output) throw new Error("Expected terminal native output directory and new sanitized Markdown path")
  await writeTurnRoutingReadout(input, output)
}

import type { DiscoveryCase, DiscoveryFinding, DiscoverySource, DiscoveryTarget } from "./discovery-cases.ts"

const prompt = `At depot close, the reconciliation board showed unexpected shortages for several relief-kit consignments. Investigate the available records. Account for every flagged consignment and decide whether the incident can be closed. Separate established causes from gaps that prevent a decision.

Return one JSON object with exactly these fields:
{"disposition":"resolved or indeterminate","claims":[{"finding":"short factual attribution or statement of what cannot be determined","scope":"consignment ID from the records","evidence":["relative/path.json#rowId"]}],"missingEvidence":[]}

Use either "resolved" or "indeterminate" for disposition. Put one material finding per claim. Cite the specific rows establishing the claim, using their id after #. List the relative paths of unavailable evidence needed to finish the investigation in missingEvidence. Continue investigating other consignments when evidence for one is incomplete.`

const method = `# Depot close reconciliation

Every planned unit should generate exactly one reservation-scanner row. Its reservation token identifies the physical unit. Retransmissions of the same token count once. The board uses the raw row count as expected dispatch and the dock total as actual dispatch.

A verified seal and independent unloaded piece count establish the actual unit count. A piece count behind an intact seal is attributable to pick/pack if no release exception exists. The dock gross mass should be corrected by the certified empty carrier mass and divided by the booked unit mass. The dock export records the carrier mass actually deducted. All masses are exact within this exercise.

For an overflow dispatch, the depot count excludes units sent on the overflow truck. Credit those units only if the signed overflow tally confirms that the reserved units reached dispatch. The custody index gives the expected tally path and whether a signed tally was retained. An unavailable tally cannot establish dispatch or loss.
`

type Board = { id: string; consignment: string; scannerRows: number; dockUnits: number; flag: boolean }
type Scan = { id: string; consignment: string; reservation: string }
type Count = { id: string; consignment: string; unloadedUnits: number; seal: "intact"; releaseException: false }
type Weight = { id: string; consignment: string; grossKg: number; deductedCarrierKg: number; unitKg: number; carrier: string }
type Tare = { id: string; carrier: string; emptyKg: number }
type Custody = { id: string; consignment: string; overflowReserved: number; tallyPath: string; retained: boolean }
type Tally = { id: string; consignment: string; releasedUnits: number; signed: true }
type Triage = { id: string; question: string }
type Row = Board | Scan | Count | Weight | Tare | Custody | Tally | Triage

const boardPath = "shift/reconciliation.json"
const scanPath = "shift/reservations.json"
const countPath = "dock/seal-counts.json"
const weightPath = "dock/weight-export.json"
const tarePath = "registry/carriers.json"
const custodyPath = "overflow/custody-index.json"
const triagePath = "shift/open-question.json"
const encode = (path: string, rows: readonly Row[]): DiscoverySource => ({ path, content: JSON.stringify(rows, null, 2) })

function deriveHeldOutOracle(sources: readonly DiscoverySource[]) {
  const files = new Map(sources.map(source => [source.path, source.content]))
  const rows = <T extends Row>(path: string) => (JSON.parse(files.get(path)!) as T[]).map(row => ({ ...row, ref: path + "#" + row.id }))
  const scans = rows<Scan>(scanPath)
  const counts = rows<Count>(countPath)
  const weights = rows<Weight>(weightPath)
  const tares = rows<Tare>(tarePath)
  const custody = rows<Custody>(custodyPath)
  const targets: DiscoveryTarget[] = []
  const missingEvidence: string[] = []
  function one<T>(items: readonly T[], where: (item: T) => boolean) {
    const selected = items.filter(where)
    if (selected.length !== 1) throw new Error("Expected exactly one matching held-out source row")
    return selected[0]!
  }

  for (const board of rows<Board>(boardPath)) {
    const forConsignment = (row: { consignment: string }) => row.consignment === board.consignment
    const scan = scans.filter(forConsignment)
    const uniqueUnits = new Set(scan.map(row => row.reservation)).size
    const count = one(counts, forConsignment)
    const weight = one(weights, forConsignment)
    const tare = one(tares, row => row.carrier === weight.carrier)
    const dockUnits = (weight.grossKg - weight.deductedCarrierKg) / weight.unitKg
    const correctedUnits = (weight.grossKg - tare.emptyKg) / weight.unitKg
    if (count.unloadedUnits !== correctedUnits || scan.length !== board.scannerRows ||
        dockUnits !== board.dockUnits || board.flag !== (scan.length > dockUnits)) {
      throw new Error("Inconsistent held-out evidence for " + board.consignment)
    }
    if (!board.flag) continue
    const target = (finding: DiscoveryFinding, materialDefect: boolean, refs: string[]) => {
      targets.push({ finding, scope: board.consignment, materialDefect, requiredRefs: [board.ref, ...refs].sort() })
    }
    if (scan.length > uniqueUnits) {
      const retried = scan.filter(row => scan.filter(other => row.reservation === other.reservation).length > 1)
      target("duplicate", true, retried.map(row => row.ref))
    }
    if (dockUnits < correctedUnits) target("tare", true, [weight.ref, tare.ref, count.ref])
    const transfer = custody.find(forConsignment)
    if (transfer && (transfer.retained !== files.has(transfer.tallyPath) || transfer.overflowReserved <= 0)) {
      throw new Error("Inconsistent overflow file inventory")
    }
    if (transfer && !transfer.retained && correctedUnits < uniqueUnits &&
        correctedUnits + transfer.overflowReserved >= uniqueUnits) {
      missingEvidence.push(transfer.tallyPath)
      target("coverage", false, [count.ref, transfer.ref])
      continue
    }
    const tally = transfer && one(rows<Tally>(transfer.tallyPath), forConsignment)
    const remaining = uniqueUnits - correctedUnits - (tally?.releasedUnits ?? 0)
    if (remaining < 0) throw new Error("Inconsistent dispatch custody count")
    if (remaining > 0) target("short-pick", true, [count.ref, ...scan.map(row => row.ref), ...(tally ? [tally.ref] : [])])
    if (!targets.some(row => row.scope === board.consignment)) throw new Error("Unaccounted held-out board flag")
  }
  return { targets, missingEvidence: missingEvidence.sort() }
}

type Load = {
  consignment: string
  units: readonly string[]
  unloaded: number
  carrier: string
  emptyKg: number
  deductedKg: number
  unitKg: number
  overflow?: { reserved: number; tallyPath: string; released?: number }
}

function incident(id: string, plans: readonly Load[], triage: Triage): DiscoveryCase {
  const role = (prefix: string, load: Load) => prefix + "-" + load.consignment
  const custody = plans.flatMap(load => load.overflow ? [{
    id: role("transfer", load), consignment: load.consignment, overflowReserved: load.overflow.reserved,
    tallyPath: load.overflow.tallyPath, retained: load.overflow.released !== undefined,
  }] : [])
  const sources = [
    { path: "method.md", content: method },
    encode(boardPath, plans.map(load => {
      const dockUnits = load.unloaded + (load.emptyKg - load.deductedKg) / load.unitKg
      return { id: role("board", load), consignment: load.consignment, scannerRows: load.units.length,
        dockUnits, flag: dockUnits < load.units.length }
    })),
    encode(scanPath, plans.flatMap(load => load.units.map((reservation, index) =>
      ({ id: role("scan", load) + "-" + (index + 1), consignment: load.consignment, reservation })))),
    encode(countPath, plans.map(load => ({ id: role("seal", load), consignment: load.consignment,
      unloadedUnits: load.unloaded, seal: "intact", releaseException: false }))),
    encode(weightPath, plans.map(load => ({ id: role("weigh", load), consignment: load.consignment, carrier: load.carrier,
      grossKg: load.unloaded * load.unitKg + load.emptyKg, deductedCarrierKg: load.deductedKg, unitKg: load.unitKg }))),
    encode(tarePath, plans.map(load => ({ id: "carrier-" + load.carrier, carrier: load.carrier, emptyKg: load.emptyKg }))),
    encode(custodyPath, custody),
    encode(triagePath, [triage]),
    ...plans.flatMap(load => {
      const overflow = load.overflow
      return overflow?.released === undefined ? [] : [encode(overflow.tallyPath, [{
        id: role("release", load), consignment: load.consignment, releasedUnits: overflow.released, signed: true,
      }])]
    }),
  ]
  return { id, input: { prompt, sources }, oracle: deriveHeldOutOracle(sources),
    focus: { path: triagePath, rowId: triage.id, question: triage.question } }
}

export function buildHeldOutDiscoveryCases(): readonly DiscoveryCase[] {
  return [
    incident("depot-pine", [
      { consignment: "DP-214", units: ["91A", "95C", "91A", "93B"], unloaded: 2,
        carrier: "K-11", emptyKg: 10, deductedKg: 10, unitKg: 5 },
      { consignment: "DP-503", units: ["98L", "94P", "90M"], unloaded: 3,
        carrier: "K-28", emptyKg: 12, deductedKg: 16, unitKg: 4 },
      { consignment: "DP-782", units: ["96Y", "99S"], unloaded: 2,
        carrier: "K-43", emptyKg: 6, deductedKg: 6, unitKg: 3 },
    ], { id: "pine-close-4", question: "What accounts for the gap between reserved and unloaded units for DP-214, and can one explanation account for the whole gap?" }),
    incident("depot-elm", [
      { consignment: "DE-169", units: ["3FB", "3QA", "3GL", "3DV"], unloaded: 2,
        carrier: "V-52", emptyKg: 15, deductedKg: 15, unitKg: 5,
        overflow: { reserved: 2, tallyPath: "overflow/east-0618-signed.json" } },
      { consignment: "DE-371", units: ["3MP", "3DC", "3MP"], unloaded: 2,
        carrier: "V-24", emptyKg: 10, deductedKg: 10, unitKg: 2 },
      { consignment: "DE-552", units: ["3YC", "3PH", "3KJ"], unloaded: 3,
        carrier: "V-68", emptyKg: 8, deductedKg: 8, unitKg: 4 },
    ], { id: "elm-close-7", question: "Can the available dispatch records establish whether the remaining DE-169 units reached dispatch, and what record would resolve any uncertainty?" }),
  ]
}

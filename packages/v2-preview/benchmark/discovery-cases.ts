export type DiscoverySource = { path: string; content: string }
export type DiscoveryInput = { prompt: string; sources: readonly DiscoverySource[] }

export type DiscoveryFinding = "clock" | "chamber" | "catalog" | "noise" | "coverage"

export type DiscoveryTarget = {
  finding: DiscoveryFinding
  scope: string
  materialDefect: boolean
  requiredRefs: readonly string[]
}

export type DiscoveryOracle = {
  targets: readonly DiscoveryTarget[]
  missingEvidence: readonly string[]
}
export type DiscoveryCase = { id: string; input: DiscoveryInput; oracle: DiscoveryOracle }

const prompt = `At shift review, the dashboard showed an unexpected rise in out-of-range seal-width readings. Investigate the available records. Explain what accounts for the flags, identify the affected lots, and decide whether this incident can be closed. Use the same standard of evidence for each explanation. Report all material findings and clearly identify anything that remains unresolved.

Return one JSON object with exactly these fields:
{"disposition":"resolved or indeterminate","claims":[{"finding":"short factual attribution or statement of what cannot be determined","scope":"lot ID from the records","evidence":["relative/path.json#rowId"]}],"missingEvidence":[]}

Use either "resolved" or "indeterminate" for disposition. Cite the source rows that establish each claim, using the row's id after #. List the relative paths of any unavailable evidence needed to finish the investigation in missingEvidence. Keep separate findings in separate claims.`

const method = `# Seal-width review procedure

The dashboard selects the station's scheduled profile at the event's recorded minute, then looks up the limits at the catalog revision loaded on the station. Schedule windows are start-inclusive and end-exclusive. For replay, use the reference minute and the revision authorized by release-control. A width on a limit is in range. Minutes are from the start of this shift throughout.

Each event's independent gauge repeats were made on the same sealed sample. The gauge was in calibration for this shift. The instrument trace contains before/after certified check-piece readings taken at the event under the same settings. The certified width is the check piece's reference value. The two check-piece readings and the repeat gauge distinguish transient instrument scatter from actual seal width variation.

Chamber logs cover each held lot before sealing. A paired run uses the same stock, sealer and profile with an independently logged hold in a comparison chamber. Use the qualification limit in the chamber record and the independent gauge results to assess whether the hold explains confirmed width changes.

Station timestamps have discrete offsets according to the clock firmware. Use recorded minute minus the offset. The station capture inventory identifies the independent synchronization file and the minutes it covers. A missing file leaves every offset listed by the inventory possible within that interval.
`

type Row = { id: string }
type Event = Row & { sample: string; lot: string; station: string; recorded: number; revision: string; width: number; flag: boolean }
type Window = Row & { station: string; start: number; end: number; profile: string }
type Limits = Row & { profile: string; revision: string; low: number; high: number }
type Release = Row & { profile: string; revision: string }
type Inventory = Row & { station: string; start: number; end: number; capture: string; available: boolean; possibleOffsets: number[] }
type Marker = Row & { station: string; start: number; end: number; recorded: number; reference: number }
type Check = Row & { sample: string; certified: number; before: number; after: number }
type Repeat = Row & { sample: string; widths: number[] }
type Hold = Row & { lot: string; chamber: string; ceilingC: number; peakC: number; paired: { chamber: string; peakC: number; widths: number[] } }

const paths = {
  events: "dashboard.json", windows: "schedule.json", limits: "catalog.json", releases: "release-control.json",
  inventory: "capture-index.json", markers: "sync-capture.json", checks: "instrument.json",
  repeats: "reference-gauge.json", holds: "hold-log.json",
}

function unique<T>(rows: readonly T[], predicate: (row: T) => boolean, description: string): T {
  const matches = rows.filter(predicate)
  if (matches.length !== 1) throw new Error(`Discovery evidence requires one ${description}, got ${matches.length}`)
  return matches[0]!
}

const inRange = (width: number, bounds: Limits) => bounds.low <= width && width <= bounds.high

/** Replay the original flags and infer the findings from the same source rows supplied to investigators. */
export function deriveDiscoveryOracle(input: DiscoveryInput): DiscoveryOracle {
  const files = new Map(input.sources.map(source => [source.path, source.content]))
  if (files.size !== input.sources.length) throw new Error("Duplicate discovery source")
  function rows<T extends Row>(path: string): (T & { ref: string })[] {
    const content = files.get(path)
    if (content === undefined) throw new Error(`Missing discovery source ${path}`)
    const parsed = JSON.parse(content) as T[]
    const ids = new Set(parsed.map(row => row.id))
    if (ids.size !== parsed.length || parsed.some(row => !/^[\w-]+$/.test(row.id))) {
      throw new Error(`Invalid discovery row IDs in ${path}`)
    }
    return parsed.map(row => ({ ...row, ref: `${path}#${row.id}` }))
  }
  const events = rows<Event>(paths.events)
  const windows = rows<Window>(paths.windows)
  const limits = rows<Limits>(paths.limits)
  const releases = rows<Release>(paths.releases)
  const inventory = rows<Inventory>(paths.inventory)
  const checks = rows<Check>(paths.checks)
  const repeats = rows<Repeat>(paths.repeats)
  const holds = rows<Hold>(paths.holds)
  const targets = new Map<string, { finding: DiscoveryFinding; scope: string; materialDefect: boolean; refs: Set<string> }>()
  const missingEvidence = new Set<string>()

  for (const event of events) {
    const windowAt = (minute: number) => unique(windows, row =>
      row.station === event.station && row.start <= minute && minute < row.end, "scheduled profile")
    const boundsFor = (profile: string, revision: string) => unique(limits, row =>
      row.profile === profile && row.revision === revision, "catalog limits")
    const dashboardWindow = windowAt(event.recorded)
    const dashboardBounds = boundsFor(dashboardWindow.profile, event.revision)
    if (event.flag === inRange(event.width, dashboardBounds)) throw new Error(`Inconsistent dashboard flag: ${event.ref}`)
    if (!event.flag) continue

    const capture = unique(inventory, row =>
      row.station === event.station && row.start <= event.recorded && event.recorded < row.end, "capture inventory interval")
    if (capture.available !== files.has(capture.capture)) throw new Error(`Inconsistent capture availability: ${capture.ref}`)
    const marker = capture.available ? unique(rows<Marker>(capture.capture), row =>
      row.station === event.station && row.start <= event.recorded && event.recorded < row.end, "independent sync marker") : undefined
    const offsets = marker ? [marker.recorded - marker.reference] : capture.possibleOffsets
    if (!offsets.length || offsets.some(offset => !capture.possibleOffsets.includes(offset))) {
      throw new Error(`Invalid synchronization offset: ${capture.ref}`)
    }

    const repeat = unique(repeats, row => row.sample === event.sample, "independent gauge result")
    const instrument = unique(checks, row => row.sample === event.sample, "instrument check")
    const hold = unique(holds, row => row.lot === event.lot, "chamber hold")
    function replay(offset: number) {
      const window = windowAt(event.recorded - offset)
      const release = unique(releases, row => row.profile === window.profile, "authorized revision")
      const bounds = boundsFor(window.profile, release.revision)
      const refs = [event.ref, dashboardWindow.ref, dashboardBounds.ref, capture.ref, window.ref, release.ref, bounds.ref]
      if (marker) refs.push(marker.ref)
      if (!repeat.widths.length || !hold.paired.widths.length) throw new Error("Empty discovery measurement series")
      const repeatInRange = repeat.widths.every(width => inRange(width, bounds))
      const findings: DiscoveryFinding[] = []
      if (inRange(event.width, bounds) && repeatInRange) {
        // Holding the other operand fixed identifies each material change to the join.
        if (window.profile !== dashboardWindow.profile &&
          !inRange(event.width, boundsFor(dashboardWindow.profile, release.revision))) {
          refs.push(boundsFor(dashboardWindow.profile, release.revision).ref)
          findings.push("clock")
        }
        if (event.revision !== release.revision && !inRange(event.width, boundsFor(window.profile, event.revision))) {
          refs.push(boundsFor(window.profile, event.revision).ref)
          findings.push("catalog")
        }
      } else if (repeatInRange && !inRange(event.width, bounds) && inRange(instrument.certified, bounds) &&
        Math.min(instrument.before, instrument.after) < bounds.low && Math.max(instrument.before, instrument.after) > bounds.high) {
        refs.push(instrument.ref)
        findings.push("noise")
      } else if (repeat.widths.every(width => width < bounds.low) && event.width < bounds.low &&
        hold.peakC > hold.ceilingC && hold.paired.chamber !== hold.chamber && hold.paired.peakC <= hold.ceilingC &&
        hold.paired.widths.every(width => inRange(width, bounds))) {
        refs.push(hold.ref)
        findings.push("chamber")
      }
      return { findings, refs: [...refs, repeat.ref] }
    }

    const replays = offsets.map(replay)
    const first = replays[0]!
    const tied = replays.every(row => row.findings.join(",") === first.findings.join(","))
    if (!tied && !marker) missingEvidence.add(capture.capture)
    const findings: DiscoveryFinding[] = !tied && !marker ? ["coverage"] : first.findings
    if (!findings.length) throw new Error(`Fixture has an unaccounted flag: ${event.ref}`)
    for (const finding of findings) {
      const key = `${finding}/${event.lot}`
      const target = targets.get(key) ?? {
        finding, scope: event.lot, materialDefect: finding !== "noise" && finding !== "coverage", refs: new Set<string>(),
      }
      for (const result of replays) for (const ref of result.refs) target.refs.add(ref)
      targets.set(key, target)
    }
  }
  return {
    targets: [...targets.values()].map(({ refs, ...target }) => ({ ...target, requiredRefs: [...refs].sort() })),
    missingEvidence: [...missingEvidence].sort(),
  }
}

function makeInput(options: { offset: number; hotHold?: true; oldRevision?: true; scatter?: true; noCapture?: true }): DiscoveryInput {
  const lots = ["L-184", "L-731", "L-462"] as const
  const windows: Window[] = [
    { id: "w1", station: "S-4", start: 130, end: 148, profile: "P-81" },
    { id: "w2", station: "S-4", start: 148, end: 180, profile: "P-27" },
  ]
  const limits: Limits[] = [
    { id: "c1", profile: "P-81", revision: "18", low: 9.8, high: 10.2 },
    { id: "c2", profile: "P-81", revision: "17", low: 10.3, high: 10.7 },
    { id: "c3", profile: "P-27", revision: "18", low: 11.8, high: 12.2 },
    { id: "c4", profile: "P-27", revision: "17", low: 11.8, high: 12.2 },
  ]
  const releases: Release[] = [
    { id: "u1", profile: "P-81", revision: "18" },
    { id: "u2", profile: "P-27", revision: "18" },
  ]
  const minutes = [143, 144, 155, 156, 160, 163]
  const nominal = [10.02, 9.98, 11.96, 12.03, 11.99, 12.02]
  const displayed = nominal.map((width, index) => {
    if (options.scatter && index < 2) return [9.77, 10.24][index]!
    if (options.hotHold && (index === 2 || index === 3)) return [11.54, 11.61][index - 2]!
    return width
  })
  const events: Event[] = displayed.map((width, index) => {
    const recorded = minutes[index]! + options.offset
    const revision = options.oldRevision && index < 2 ? "17" : "18"
    const profile = recorded < 148 ? "P-81" : "P-27"
    const bounds = unique(limits, row => row.profile === profile && row.revision === revision, "fixture dashboard limits")
    return {
      id: `d${index + 1}`, lot: lots[Math.floor(index / 2)]!, sample: `M-${265 + index}`,
      station: "S-4", recorded, width, revision, flag: !inRange(width, bounds),
    }
  })
  const inventory: Inventory[] = [
    { id: "a1", station: "S-4", start: 130, end: 180, capture: paths.markers, available: !options.noCapture, possibleOffsets: [0, 6] },
  ]
  const markers: Marker[] = [
    { id: "s1", station: "S-4", start: 130, end: 180, recorded: 138 + options.offset, reference: 138 },
  ]
  const repeats: Repeat[] = events.map((event, index) => {
    const center = options.scatter && index < 2 ? nominal[index]! : event.width
    return { id: `r${index + 1}`, sample: event.sample, widths: [center - 0.01, center, center + 0.01].map(n => +n.toFixed(2)) }
  })
  const checks: Check[] = events.map((event, index) => {
    const certified = index < 2 ? 10 : 12
    const noisy = options.scatter && index < 2
    return { id: `i${index + 1}`, sample: event.sample, certified, before: noisy ? 9.76 : certified - 0.01,
      after: noisy ? 10.24 : certified + 0.01 }
  })
  const holds: Hold[] = lots.map((lot, index) => ({
    id: `h${index + 1}`, lot, chamber: index === 1 ? "CH-19" : "CH-22", ceilingC: 42,
    peakC: index === 1 && options.hotHold ? 54 : 40,
    paired: { chamber: "CH-08", peakC: 39, widths: index === 0 ? [10.01, 10.03] : [12.01, 11.98] },
  }))
  const tables: [string, Row[]][] = [
    [paths.events, events], [paths.windows, windows], [paths.limits, limits], [paths.releases, releases],
    [paths.inventory, inventory], [paths.checks, checks], [paths.repeats, repeats], [paths.holds, holds],
  ]
  if (!options.noCapture) tables.push([paths.markers, markers])
  return {
    prompt, sources: [
      { path: "review-procedure.md", content: method },
      ...tables.map(([path, rows]) => ({ path, content: JSON.stringify(rows, null, 2) + "\n" })),
    ].sort((left, right) => left.path.localeCompare(right.path)),
  }
}

export function buildDiscoveryCases(): DiscoveryCase[] {
  const cases: [string, Parameters<typeof makeInput>[0]][] = [
    ["d-8c21", { offset: 6 }],
    ["d-37e4", { offset: 0, scatter: true }],
    ["d-b510", { offset: 6, noCapture: true }],
    ["d-0a6f", { offset: 6, hotHold: true }],
    ["d-e29a", { offset: 0, oldRevision: true }],
  ]
  return cases.map(([id, options]) => {
    const input = makeInput(options)
    return { id, input, oracle: deriveDiscoveryOracle(input) }
  })
}

import { expect, test } from "bun:test"
import { buildDiscoveryCases, deriveDiscoveryOracle, type DiscoveryInput } from "../benchmark/discovery-cases.ts"

function table<T>(input: DiscoveryInput, path: string): T[] {
  return JSON.parse(input.sources.find(source => source.path === path)!.content) as T[]
}

test("discovery presents an identical symptom and only public records", () => {
  const cases = buildDiscoveryCases()
  expect(cases).toEqual(buildDiscoveryCases())
  expect(cases).toHaveLength(5)
  expect(new Set(cases.map(incident => incident.id)).size).toBe(5)
  expect(new Set(cases.map(incident => incident.input.prompt)).size).toBe(1)
  expect(new Set(cases.map(incident => incident.input.sources.find(source => source.path.endsWith(".md"))!.content)).size).toBe(1)
  for (const { id, input, oracle } of cases) {
    expect(id).toMatch(/^d-[0-9a-f]{4}$/)
    expect(Object.keys(input).sort()).toEqual(["prompt", "sources"])
    expect(JSON.stringify(input)).not.toContain(id)
    expect(JSON.stringify(input)).not.toMatch(/materialDefect|requiredRefs|oracle|answer.?key/i)
    const rowRefs = new Set<string>()
    for (const source of input.sources) {
      expect(Object.keys(source).sort()).toEqual(["content", "path"])
      expect(Buffer.byteLength(source.content)).toBeLessThan(16 * 1024)
      if (!source.path.endsWith(".json")) continue
      for (const row of table<{ id: string }>(input, source.path)) {
        const ref = `${source.path}#${row.id}`
        expect(rowRefs.has(ref)).toBe(false)
        rowRefs.add(ref)
      }
    }
    for (const target of oracle.targets) {
      expect(target.requiredRefs.length).toBeGreaterThan(0)
      expect(target.requiredRefs.every(ref => rowRefs.has(ref))).toBe(true)
    }
  }
})

test("an independent row join reproduces flags and distinguishes all five incidents", () => {
  const expected = [
    { findings: ["clock/L-184"], flags: 2, replayFlags: [0], hot: false, scatter: false, old: false },
    { findings: ["noise/L-184"], flags: 2, replayFlags: [2], hot: false, scatter: true, old: false },
    { findings: ["coverage/L-184"], flags: 2, replayFlags: [2, 0], hot: false, scatter: false, old: false },
    { findings: ["clock/L-184", "chamber/L-731"], flags: 4, replayFlags: [2], hot: true, scatter: false, old: false },
    { findings: ["catalog/L-184"], flags: 2, replayFlags: [0], hot: false, scatter: false, old: true },
  ]
  buildDiscoveryCases().forEach(({ input, oracle }, index) => {
    const answer = expected[index]!
    const events = table<{ sample: string; lot: string; recorded: number; width: number; revision: string; flag: boolean }>(input, "dashboard.json")
    const schedule = table<{ start: number; end: number; profile: string }>(input, "schedule.json")
    const catalog = table<{ profile: string; revision: string; low: number; high: number }>(input, "catalog.json")
    const releases = table<{ profile: string; revision: string }>(input, "release-control.json")
    const outOfRange = (minute: number, width: number, revision?: string) => {
      const profile = schedule.find(window => window.start <= minute && minute < window.end)!.profile
      const approved = releases.find(row => row.profile === profile)!.revision
      const { low, high } = catalog.find(row => row.profile === profile && row.revision === (revision ?? approved))!
      return width < low || width > high
    }
    for (const event of events) {
      expect(outOfRange(event.recorded, event.width, event.revision)).toBe(event.flag)
    }
    const flagged = events.filter(event => event.flag)
    expect(flagged).toHaveLength(answer.flags)
    const [capture] = table<{ available: boolean; capture: string; possibleOffsets: number[] }>(input, "capture-index.json")
    const captureExists = input.sources.some(source => source.path === capture!.capture)
    expect(captureExists).toBe(capture!.available)
    const offsets = captureExists ? table<{ recorded: number; reference: number }>(input, capture!.capture)
      .map(row => row.recorded - row.reference) : capture!.possibleOffsets
    const counts = offsets.map(offset => flagged.filter(event => outOfRange(event.recorded - offset, event.width)).length)
    expect(counts).toEqual(answer.replayFlags)
    expect(flagged.some(event => !outOfRange(event.recorded, event.width) && event.revision === "17")).toBe(answer.old)
    const repeats = table<{ sample: string; widths: number[] }>(input, "reference-gauge.json")
    const checks = table<{ sample: string; certified: number; before: number; after: number }>(input, "instrument.json")
    const holds = table<{ lot: string; chamber: string; ceilingC: number; peakC: number;
      paired: { chamber: string; peakC: number; widths: number[] } }>(input, "hold-log.json")
    const hot = flagged.filter(event => {
      const hold = holds.find(row => row.lot === event.lot)!
      const minute = event.recorded - offsets[0]!
      return hold.peakC > hold.ceilingC && hold.paired.chamber !== hold.chamber && hold.paired.peakC <= hold.ceilingC &&
        hold.paired.widths.every(width => !outOfRange(minute, width)) &&
        repeats.find(row => row.sample === event.sample)!.widths.every(width => outOfRange(minute, width))
    })
    expect(new Set(hot.map(event => event.lot))).toEqual(new Set(answer.hot ? ["L-731"] : []))
    const scatter = flagged.filter(event => {
      const minute = event.recorded - offsets[0]!
      const check = checks.find(row => row.sample === event.sample)!
      return outOfRange(minute, event.width) && !outOfRange(minute, check.certified) &&
        outOfRange(minute, check.before) && outOfRange(minute, check.after) &&
        repeats.find(row => row.sample === event.sample)!.widths.every(width => !outOfRange(minute, width))
    })
    expect(new Set(scatter.map(event => event.lot))).toEqual(new Set(answer.scatter ? ["L-184"] : []))
    expect(oracle.targets.map(target => `${target.finding}/${target.scope}`)).toEqual(answer.findings)
    expect(oracle.missingEvidence).toEqual(captureExists ? [] : [capture!.capture])
  })
})

test("the oracle reacts to restoring the decisive record and rejects inconsistent dashboard source rows", () => {
  const [clock, , missing] = buildDiscoveryCases()
  const marker = clock!.input.sources.find(source => source.path === "sync-capture.json")!
  const inventory = clock!.input.sources.find(source => source.path === "capture-index.json")!
  const restored = {
    ...missing!.input,
    sources: [...missing!.input.sources.filter(source => source.path !== inventory.path), inventory, marker],
  }
  expect(deriveDiscoveryOracle(restored)).toEqual(clock!.oracle)
  const corrupt = {
    ...restored,
    sources: restored.sources.map(source => source.path === "dashboard.json" ?
      { ...source, content: source.content.replace('"flag": true', '"flag": false') } : source),
  }
  expect(() => deriveDiscoveryOracle(corrupt)).toThrow("Inconsistent dashboard flag")
})

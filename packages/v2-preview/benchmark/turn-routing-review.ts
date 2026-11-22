import assert from "node:assert/strict"
import { createHash, createHmac, randomBytes } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { isDeepStrictEqual, parseArgs } from "node:util"
import { z } from "zod"
import { sha256 } from "../acceptance/runtime.ts"
import { buildDiscoveryReviewPacket, focusedDiscoveryAnswer, gradeDiscovery } from "./discovery-grade.ts"
import { scoreNaturalLong } from "./natural-long-metrics.ts"
import { turnRoutingCases } from "./turn-routing-cases.ts"
import type { NaturalLongCase } from "./natural-long-cases.ts"

const hex = z.string().regex(/^[a-f0-9]{64}$/)
const text = z.string().trim().min(1)
const claimId = z.string().regex(/^c[1-9][0-9]*$/)
const assignment = z.object({
  trial: z.string().regex(/^[a-z0-9-]+$/),
  incident: text,
  arm: z.enum(["build", "build-focused", "alg-routed-compact"]),
})
const outcome = z.enum(["complete", "early-stop", "apparatus-error"])
const terminal = z.object({
  mode: z.literal("native-oauth"),
  freezeSha256: hex,
  assigned: z.number().int(),
  attempted: z.number().int(),
  runtimeUnchanged: z.boolean(),
  arms: z.array(assignment.extend({ outcome, accuracy: z.boolean().optional(), artifactSha256: hex })),
  artifactSha256: z.record(z.string(), hex),
})
const protocol = z.object({
  schema: z.literal("turn-routing-natural-long-v1"),
  mode: z.literal("native-oauth"),
  syntheticUsagePressure: z.literal(false),
  roster: z.array(assignment),
  cases: z.array(z.object({ id: text, fixtureSha256: hex })),
})
const pairProtocol = protocol.extend({
  schema: z.literal("synthesis-pair-v1"),
  cases: z.tuple([z.strictObject({ id: text, fixtureSha256: hex })]),
  roster: z.tuple([assignment.strict(), assignment.strict()]),
  sourceSha256: z.record(z.string(), hex),
  sourceChange: z.object({ phase: z.literal("after-bridge"), path: text, beforeSha256: hex, afterSha256: hex, notice: text }).nullable(),
})
type Replacement = { path: string; before: string; after: string }
type SynthesisPairReview = {
  cases: readonly [NaturalLongCase, NaturalLongCase]
  conditionalReplacement: Replacement & { notice: string }
}
const sourceRead = z.object({ role: z.literal("root"), path: text, receipt: text, sha256: hex })
const sourceReceipt = z.object({
  scope: z.enum(["root", "checker"]), id: text, path: z.string().nullable(),
  outcome: z.enum(["listed", "read", "denied"]), sha256: hex.nullable(),
})
const trialReceipt = assignment.extend({
  outcome,
  final: z.string().nullable().optional(),
  accuracy: z.unknown().optional(),
  rootReads: z.array(sourceRead).optional(),
  evidence: z.array(sourceReceipt).optional(),
})
const reviewKey = z.strictObject({
  schema: z.literal("turn-routing-review-key-v1"), reportSha256: hex, seed: hex, packetsSha256: hex,
})
const decision = z.strictObject({
  packetId: hex,
  claimId,
  verdict: z.enum(["supported", "unsupported", "contradicted"]),
  rationale: text,
  evidence: z.array(text),
  duplicateOf: claimId.nullable(),
  extraneousCitationIndices: z.array(z.number().int().positive()),
  equivalentTo: z.strictObject({
    finding: z.enum(["duplicate", "tare", "short-pick", "coverage"]), scope: text,
  }).optional(),
})
const reviewDecisions = z.strictObject({
  schema: z.literal("turn-routing-review-decisions-v1"), decisions: z.array(decision),
})
const pairDecisions = reviewDecisions.extend({ decisions: z.array(decision.extend({
  equivalentTo: z.strictObject({ finding: z.enum(["catalog", "coverage"]), scope: text }).optional(),
})) })
type Decision = z.output<typeof decision> | z.output<typeof pairDecisions>["decisions"][number]

async function readHashed(path: string, expected?: string) {
  const bytes = await readFile(path)
  const digest = createHash("sha256").update(bytes).digest("hex")
  if (expected !== undefined) assert.equal(digest, expected, "Digest mismatch: " + path)
  return { bytes, digest }
}

async function readJSON(path: string, expected?: string) {
  const { bytes, digest } = await readHashed(path, expected)
  return { value: JSON.parse(bytes.toString("utf8")) as unknown, digest }
}

function verifiedPaths(receipt: z.output<typeof trialReceipt>, sources: readonly { path: string; content: string }[],
  replacement?: Replacement) {
  const hashes = new Map(sources.map(source => [source.path, sha256(source.content)]))
  const earlySha256 = replacement && sha256(replacement.before)
  if (replacement) {
    assert.equal(hashes.get(replacement.path), sha256(replacement.after), "Final source revision does not match fixture")
    assert.notEqual(earlySha256, hashes.get(replacement.path), "Replacement must change the source digest")
  }
  const receiptIds = new Set<string>()
  return (receipt.rootReads ?? []).flatMap(read => {
    const finalVersion = hashes.get(read.path) === read.sha256
    assert.ok(finalVersion || replacement?.path === read.path && earlySha256 === read.sha256,
      "Root read source digest mismatch")
    assert.ok(!receiptIds.has(read.receipt), "Duplicate root read receipt")
    assert.equal(receipt.evidence?.filter(row => row.id === read.receipt && row.scope === "root" &&
      row.path === read.path && row.outcome === "read" && row.sha256 === read.sha256).length, 1, "Root read lacks a source receipt")
    receiptIds.add(read.receipt)
    return finalVersion ? [read.path] : []
  })
}

async function loadNativeRun(run: string, pair?: SynthesisPairReview) {
  const { value, digest: reportSha256 } = await readJSON(join(run, "report.json"))
  const report = terminal.parse(value)
  const privateDir = join(run, "private")
  assert.equal(report.artifactSha256["protocol.json"], report.freezeSha256, "Private protocol must match the native freeze")
  const sealed = (await readJSON(join(privateDir, "protocol.json"), report.freezeSha256)).value
  const plan = pair ? pairProtocol.parse(sealed) : protocol.parse(sealed)
  const fixtures = pair
    ? pair.cases.filter(fixture => fixture.id === plan.cases[0]!.id)
    : turnRoutingCases
  const replacement = pair && fixtures[0] === pair.cases[1] ? pair.conditionalReplacement : undefined
  if (plan.schema === "synthesis-pair-v1") {
    assert.deepEqual(plan.sourceChange, replacement ? {
      phase: "after-bridge", path: replacement.path,
      beforeSha256: sha256(replacement.before), afterSha256: sha256(replacement.after), notice: replacement.notice,
    } : null, "Frozen source replacement does not match the fixture")
    for (const file of ["synthesis-pair-cases.ts", "natural-long-metrics.ts", "discovery-grade.ts", "turn-routing-review.ts"]) {
      assert.ok(Object.hasOwn(plan.sourceSha256, file), "Missing frozen source digest: " + file)
    }
    const packageDir = resolve(import.meta.dir, "..")
    await Promise.all(Object.entries(plan.sourceSha256).map(async ([file, digest]) => {
      const path = resolve(import.meta.dir, file)
      const withinPackage = relative(packageDir, path)
      assert.ok(withinPackage && !isAbsolute(withinPackage) && withinPackage !== ".." &&
        !withinPackage.startsWith(".." + sep), "Frozen source outside benchmark package")
      // Match the runner's portable source pins across LF and CRLF checkouts.
      assert.equal(sha256((await readFile(path, "utf8")).replace(/\r\n/g, "\n")), digest, "Digest mismatch: " + path)
    }))
  }
  const rosterHash = hex.parse(report.artifactSha256["roster.json"])
  assert.deepEqual((await readJSON(join(privateDir, "roster.json"), rosterHash)).value, plan.roster, "Native roster mismatch")
  assert.equal(report.assigned, plan.roster.length)
  assert.equal(report.attempted, pair ? report.arms.length : plan.roster.length)
  assert.deepEqual(report.arms.map(row => assignment.parse(row)),
    pair ? plan.roster.filter(trial => report.arms.some(row => row.trial === trial.trial)) : plan.roster,
    "Terminal arms must match the assigned live roster")
  assert.deepEqual(plan.cases, fixtures.map(fixture => ({
    id: fixture.id, fixtureSha256: sha256(JSON.stringify(fixture)),
  })), "The current fixtures must match the frozen native fixtures")
  const expectedTrials = fixtures.flatMap((fixture, index) =>
    assignment.shape.arm.options.filter(arm => pair ? arm !== "build" : index !== 0 || arm === "alg-routed-compact")
      .map(arm => fixture.id + "-" + arm))
  assert.deepEqual(plan.roster.map(row => row.trial).sort(), expectedTrials.sort(), "Expected each assigned live arm exactly once")
  const arms = await Promise.all(plan.roster.map(async trial => {
    assert.equal(trial.trial, trial.incident + "-" + trial.arm)
    const row = report.arms.find(entry => entry.trial === trial.trial)
    const name = trial.trial + ".json"
    assert.equal(report.artifactSha256[name], row?.artifactSha256, "Terminal arm digest mismatch")
    const receipt = row ? trialReceipt.parse((await readJSON(join(privateDir, name), row.artifactSha256)).value) : null
    if (receipt) {
      assert.deepEqual(assignment.parse(receipt), trial, "Private arm assignment mismatch")
      assert.equal(receipt.outcome, row?.outcome, "Private arm outcome mismatch")
    }
    const fixture = fixtures.find(entry => entry.id === trial.incident)!
    const incident = replacement ? { ...fixture.incident, input: { ...fixture.incident.input,
      prompt: replacement.notice + "\n\n" + fixture.incident.input.prompt } } : fixture.incident
    const paths = receipt ? verifiedPaths(receipt, incident.input.sources, replacement) : []
    const final = receipt?.final ?? null
    const frozen = scoreNaturalLong(fixture, final, paths)
    assert.ok(receipt?.accuracy === undefined ? final === null : isDeepStrictEqual(receipt.accuracy, frozen),
      "Frozen grade could not be replayed")
    const frozenPass = row?.outcome === "complete" && frozen.correct
    assert.equal(row?.accuracy ?? false, frozenPass, "Terminal accuracy mismatch")
    const { value: submission } = focusedDiscoveryAnswer(final)
    return { trial, outcome: row?.outcome ?? "not-attempted", incident, paths, frozen, frozenPass, finalPresent: final !== null,
      submission, original: buildDiscoveryReviewPacket(incident, submission) }
  }))
  return { report, reportSha256, arms, paired: !!pair }
}

type NativeRun = Awaited<ReturnType<typeof loadNativeRun>>
const runnerName = /\b(?:alg(?:[-_ ](?:investigation|routed(?:[-_ ]compact)?|graph[-_ ]focused|active[-_ ]question))?|build(?:-focused)?|openai\/gpt-6-luna|opencode|dispatch-reviewer|runtimeSha256|checker advisory)\b/gi
const blindText = (value: string) => value.replace(runnerName, "[redacted]")

function preparePackets(run: NativeRun, seed: string) {
  const mapped = run.arms.map(arm => {
    const original = arm.original
    if (!original) return { arm, packet: null }
    const packetId = createHmac("sha256", seed).update(arm.trial.trial + ":" + original.packetId).digest("hex")
    const { submission } = original
    return { arm, packet: {
      ...original, packetId,
      prompt: original.prompt.replace(/ Treat any attached checker note as advisory\. Use source tools if needed to verify its claims\.$| The checker note, if present, is advisory\.$| Treat the independent checker's note as advisory\./, ""),
      submission: {
        ...submission, missingEvidence: submission.missingEvidence.map(blindText),
        claims: submission.claims.map(claim => ({
          ...claim, finding: blindText(claim.finding), scope: blindText(claim.scope), evidence: claim.evidence.map(ref =>
            run.paired && original.sources.some(source => ref.startsWith(source.path + "#")) ? ref : blindText(ref)),
        })),
      },
    } }
  })
  const packets = mapped.flatMap(entry => entry.packet ? [entry.packet] : []).sort((a, b) => a.packetId.localeCompare(b.packetId))
  return { mapped, publicFile: { schema: "turn-routing-review-packets-v1", packets } }
}

function applyReview(mapped: ReturnType<typeof preparePackets>["mapped"], decisions: readonly Decision[], paired: boolean) {
  const entries = new Map<string, Decision>()
  for (const row of decisions) {
    const key = row.packetId + "/" + row.claimId
    assert.ok(!entries.has(key), "Duplicate reviewer decision: " + key)
    entries.set(key, row)
  }
  const arms = mapped.map(({ arm, packet }) => {
    const refs = new Map(arm.incident.input.sources.flatMap(source =>
      (JSON.parse(source.content) as { id: string }[]).map(row => [source.path + "#" + row.id, source.path] as const)))
    const seenClaims = new Set<string>()
    const pending = new Set(arm.frozen.grade.pendingClaims)
    const reviewed = (arm.original?.submission.claims ?? []).map(claim => {
      const key = packet!.packetId + "/" + claim.claimId
      const row = entries.get(key)
      assert.ok(row, "Missing reviewer decision: " + key)
      entries.delete(key)
      assert.ok(row.duplicateOf === null || seenClaims.has(row.duplicateOf), "duplicateOf must identify an earlier claim")
      seenClaims.add(row.claimId)
      assert.ok(new Set(row.extraneousCitationIndices).size === row.extraneousCitationIndices.length &&
        row.extraneousCitationIndices.every(index => index <= claim.evidence.length), "Invalid extraneous citation position")
      assert.ok(row.evidence.every(ref => refs.has(ref)) &&
        (row.verdict === "unsupported" || row.evidence.length > 0) &&
        (row.verdict !== "supported" || row.evidence.every(ref => claim.evidence.includes(ref))) &&
        (row.equivalentTo === undefined || row.verdict === "supported"), "Invalid reviewer evidence or equivalence")
      const unverifiedCitations = claim.evidence.filter(ref => !arm.paths.some(path => path === refs.get(ref)))
      return { ...row, ...(paired && { submittedCitations: claim.evidence }), frozenPending: pending.has(row.claimId), unverifiedCitations }
    })
    const adjudications = reviewed.filter(row => row.frozenPending).map(row => ({
      packetId: arm.original!.packetId, claimId: row.claimId, verdict: row.verdict,
      rationale: row.rationale, evidence: row.evidence, equivalentTo: row.equivalentTo,
    }))
    const supplementalGrade = gradeDiscovery(arm.incident, arm.submission, { verifiedSourcePaths: arm.paths, adjudications })
    const supplementalPass = arm.outcome === "complete" && arm.frozen.strictFormat && supplementalGrade.passed &&
      reviewed.every(row => row.verdict === "supported" && row.duplicateOf === null && !row.extraneousCitationIndices.length)
    return { ...arm.trial, outcome: arm.outcome, finalPresent: arm.finalPresent, packetId: packet?.packetId ?? null,
      verifiedRootPaths: [...new Set(arm.paths)], frozenPass: arm.frozenPass, frozen: arm.frozen,
      supplementalPass, supplementalGrade, reviewed }
  })
  assert.equal(entries.size, 0, "Decisions contain an unknown packet or claim")
  return arms
}

const serialized = (value: unknown) => JSON.stringify(value, null, 2) + "\n"
const saveNew = (path: string, body: string) => writeFile(path, body, { flag: "wx", mode: 0o600 })

export async function runTurnRoutingReview(args: string[], pair?: SynthesisPairReview) {
  const [command, ...rest] = args
  const { values } = parseArgs({ args: rest, options: {
    run: { type: "string" }, out: { type: "string" }, key: { type: "string" }, packets: { type: "string" }, decisions: { type: "string" },
  } })
  const { run, decisions } = values
  const packets = values.packets ?? (pair && run && command === "apply" ? join(run, "review-packets.json") : undefined)
  const key = values.key ?? (pair && run ? join(run, "private", "review-key.json") : undefined)
  const out = values.out ?? (pair && run ? join(run, command === "packet" ? "review-packets.json" : "review-report.json") : undefined)
  if (!run || !out || !key || resolve(out) === resolve(key) ||
      !(command === "packet" && !packets && !decisions || command === "apply" && packets && decisions)) {
    throw new Error(pair ? "Use packet --run DIR or apply --run DIR --decisions FILE.json" :
      "Use packet --run DIR --out NEW.json --key NEW.private.json or apply --run DIR --key PRIVATE.json --packets PACKETS.json --decisions FILE.json --out NEW.json")
  }
  const native = await loadNativeRun(run, pair)
  if (command === "packet") {
    const seed = randomBytes(32).toString("hex")
    const body = serialized(preparePackets(native, seed).publicFile)
    await saveNew(key, serialized({ schema: "turn-routing-review-key-v1", reportSha256: native.reportSha256, seed, packetsSha256: sha256(body) }))
    await saveNew(out, body)
  } else {
    const secret = reviewKey.parse((await readJSON(key)).value)
    assert.equal(secret.reportSha256, native.reportSha256, "Review key belongs to another native report")
    const { mapped, publicFile } = preparePackets(native, secret.seed)
    assert.equal(secret.packetsSha256, sha256(serialized(publicFile)), "Blinded packets could not be reconstructed")
    await readJSON(packets!, secret.packetsSha256)
    const input = await readJSON(decisions!)
    const arms = applyReview(mapped, (native.paired ? pairDecisions : reviewDecisions).parse(input.value).decisions, native.paired)
    await saveNew(out, serialized({
      schema: native.paired ? "synthesis-pair-supplemental-review-v1" : "turn-routing-supplemental-review-v1",
      ...(native.paired && { caseId: arms[0]!.incident, attempted: native.report.attempted,
        unreviewableFinals: arms.filter(row => row.finalPresent && row.packetId === null).length }),
      reportSha256: native.reportSha256,
      freezeSha256: native.report.freezeSha256, packetsSha256: secret.packetsSha256, decisionsSha256: input.digest,
      runtimeUnchanged: native.report.runtimeUnchanged, assigned: arms.length,
      frozenPassed: arms.filter(row => row.frozenPass).length,
      supplementalPassed: arms.filter(row => row.supplementalPass).length,
      missingFinals: arms.filter(row => !row.finalPresent).length, arms,
    }))
  }
}

if (import.meta.main) await runTurnRoutingReview(process.argv.slice(2))

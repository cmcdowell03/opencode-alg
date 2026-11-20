import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildDiscoveryCases } from "../benchmark/discovery-cases.ts"
import { finalizeDiscovery } from "../benchmark/discovery-finalize.ts"
import { buildDiscoveryReviewPacket, gradeDiscovery, parseDiscoverySubmission } from "../benchmark/discovery-grade.ts"

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const instance = buildDiscoveryCases()[0]!
const armOrder = ["build", "alg-ordinary", "alg-adversarial", "build-ordinary", "build-adversarial"]
const comparisons = {
  stockBuildVsAlgOrdinary: [0, 1], stockBuildVsAlgAdversarial: [0, 2], adversarialVsOrdinaryInAlg: [1, 2],
  adversarialVsOrdinaryInBuild: [3, 4], installedAlgWithOrdinaryChecker: [3, 1], installedAlgWithAdversarialChecker: [4, 2],
}
const frozenFiles = [
  "discovery-run.ts", "discovery-cases.ts", "discovery-grade.ts", "discovery-host.ts", "discovery-tools.ts",
  "native-observer.ts", "native-provider.ts", "compaction.ts", "input-usage.ts", "skill-delivery.ts", "host.ts",
  "../acceptance/host.ts", "../acceptance/runtime.ts", "../acceptance/service.ts",
]
const target = instance.oracle.targets[0]!
const refs = [...target.requiredRefs]
const modelAnswer = (finding: string, evidence = refs) => JSON.stringify({
  disposition: "resolved", claims: [{ finding, scope: target.scope, evidence }], missingEvidence: [],
})

async function withReceipt(
  run: (context: Awaited<ReturnType<typeof createReceipt>>) => Promise<void>,
  options?: Parameters<typeof createReceipt>[1],
) {
  const directory = await mkdtemp(join(tmpdir(), "alg-discovery-finalize-test-"))
  try { await run(await createReceipt(directory, options)) }
  finally { await rm(directory, { recursive: true, force: true }) }
}

async function createReceipt(directory: string, options: { unverified?: boolean; shortEvidence?: boolean; budgetFailure?: boolean } = {}) {
  const privateDir = join(directory, "private")
  await Promise.all([mkdir(privateDir), mkdir(join(directory, "blinded"))])
  const artifactSha256: Record<string, string> = {}
  const persist = async (file: string, value: unknown) => {
    const content = JSON.stringify(value, null, 2) + "\n"
    const path = join(directory, file)
    await writeFile(path, content)
    artifactSha256[file] = hash(content)
    return path
  }
  const files = Object.fromEntries(await Promise.all(frozenFiles.map(async file => {
    const content = await readFile(new URL("../benchmark/" + file, import.meta.url), "utf8")
    const lf = content.replace(/\r\n/g, "\n")
    const crlf = lf.replace(/\n/g, "\r\n")
    // Freeze the opposite line-ending representation from the local checkout.
    const alternate = content.includes("\r\n") ? lf : crlf
    expect(hash(alternate.replace(/\r\n/g, "\n"))).toBe(hash(lf))
    return [file, hash(alternate.replace(/\r\n/g, "\n"))]
  })))
  const protocol = {
    schema: "discovery-freeze-v1", sourceDigestMode: "utf8-lf-v1", mode: "native-oauth", model: "example/model",
    host: { version: "2.3.2", binarySha256: "a".repeat(64), packageSha256: "b".repeat(64), bundleSha256: "c".repeat(64) },
    cases: [{ id: instance.id, caseSha256: hash(JSON.stringify(instance)), promptSha256: hash(instance.input.prompt), order: armOrder }],
    files,
  }
  const frozen = await persist("private/protocol.json", protocol)
  const external = join(directory, "frozen.json")
  await writeFile(external, await readFile(frozen))
  const trials = armOrder.map((arm, index) => ({
    trial: "00000000-0000-4000-8000-" + String(index + 1).padStart(12, "0"), case: instance.id, arm,
  }))
  await persist("private/trial-key.json", trials)
  const finals = [
    modelAnswer("clock skew"),
    modelAnswer("The station put these lot readings in the following recipe window", options.shortEvidence ? refs.slice(0, -1) : refs),
    options.budgetFailure ? modelAnswer("clock skew") : "Invalid model report",
  ]
  const journal: object[] = []
  const completed: ((typeof trials)[number] & {
    outcome: string; qualified: boolean; apparatusQualified: boolean; problem: string | null;
    treatment: string; grade: ReturnType<typeof gradeDiscovery>
  })[] = []
  const packets = []
  for (const [index, final] of finals.entries()) {
    const trial = trials[index]!
    const outcome = index < 2 ? "completed" : options.budgetFailure ? "budget-exhausted" : "model-output-failure"
    const qualified = index === 0 || (index === 1 && !options.unverified)
    const apparatusQualified = true
    const problem = outcome === "completed" ? null : "Invalid model answer"
    const treatment = index === 0 ? "control" : "tool-not-used"
    const sources = index === 1 && options.unverified
      ? instance.input.sources.filter(source => source.path !== "sync-capture.json") : instance.input.sources
    const rootReads = sources.map(({ path, content }, offset) => ({
      path, receipt: "read-" + offset, sha256: hash(content),
    }))
    const evidence = rootReads.map(({ path, receipt, sha256 }) => ({ id: receipt, path, sha256, scope: "root", outcome: "read" }))
    const parsed = parseDiscoverySubmission(final)
    const grade = gradeDiscovery(instance, parsed, { verifiedSourcePaths: sources.map(source => source.path) })
    const packet = buildDiscoveryReviewPacket(instance, parsed)
    const summary = { ...trial, outcome, qualified, apparatusQualified, problem, treatment, grade }
    completed.push(summary)
    packets.push(packet)
    journal.push({ trial: trial.trial, event: "arm-start" },
      { trial: trial.trial, event: "arm-end", outcome, qualified, apparatusQualified, problem })
    await persist("private/" + trial.trial + ".json", { ...summary, final, rootReads, evidence })
    await persist("blinded/" + trial.trial + ".json", { trial: trial.trial, packet })
  }
  journal.push({ trial: trials[3]!.trial, event: "arm-start" })
  const events = journal.map(row => JSON.stringify(row)).join("\n") + "\n"
  await writeFile(join(privateDir, "events.jsonl"), events)
  artifactSha256["private/events.jsonl"] = hash(events)
  const report = {
    schema: "discovery-report-v1", mode: "native-oauth", qualified: false, allEvidenceQualified: false, runtimeUnchanged: true,
    interrupted: "Stopped after starting a fourth assigned arm", expected: trials.length, completed, artifactSha256,
    comparisons: Object.fromEntries(Object.entries(comparisons).map(([key, [a, b]]) => {
      const first = completed[a!]!, second = completed[b!]!
      return [key, first && second ? [{
        case: instance.id, baseline: first.trial, treatment: second.trial,
        comparable: !first.grade.reviewRequired && !second.grade.reviewRequired,
        baselinePassed: first.grade.passed, treatmentPassed: second.grade.passed,
        baselineOutcome: first.outcome, treatmentOutcome: second.outcome,
        baselineTreatment: first.treatment, treatmentReceived: second.treatment,
        verifiedLedgerInAssignedAlgArms: false,
      }] : []]
    })),
  }
  // The manifest does not include the report itself.
  const saveReport = () => writeFile(join(privateDir, "report.json"), JSON.stringify(report) + "\n")
  await saveReport()
  const packetId = packets[1]!.packetId
  const decision = {
    packetId, claimId: "c1", verdict: "supported", rationale: "The cited sync and schedule rows establish the wrong window.",
    evidence: packets[1]!.submission.claims[0]!.evidence,
    equivalentTo: { finding: "time alignment", scope: target.scope.toLowerCase() },
  }
  const decisionsPath = join(directory, "decisions.json")
  const setDecisions = (items: unknown[]) => writeFile(decisionsPath, JSON.stringify({ schema: "discovery-adjudication-v1", decisions: items }))
  await setDecisions([decision])
  const output = join(directory, "finalized.json")
  return { directory, privateDir, persist, saveReport, trials, protocol, report, decision, setDecisions,
    args: { privateDir, frozen: external, decisions: decisionsPath, output } }
}

test("finalizes a blind paraphrase and keeps the invalid and interrupted attempts in every rate", async () => {
  await withReceipt(async run => {
    const result = await finalizeDiscovery(run.args)
    expect(result.counts).toEqual({ planned: 5, attempted: 4, committed: 3, withoutCommittedReceipt: 1, notAttempted: 1 })
    expect(result.rawProvisional.overall.counts.pendingClaims).toBe(1)
    expect(result.adjudicated.overall.counts.pendingClaims).toBe(0)
    expect(result.adjudicated.overall.fields.validSubmission).toEqual({ numerator: 2, denominator: 4, rate: 0.5 })
    expect(result.rawProvisional.overall.fields.passed?.numerator).toBe(1)
    expect(result.adjudicated.overall.fields.passed).toEqual({ numerator: 2, denominator: 4, rate: 0.5 })
    expect(result.adjudicated.overall.materialDefectRecall).toEqual({ numerator: 2, denominator: 4, rate: 0.5 })
    expect(result.adjudicated.byArm["alg-adversarial"]?.fields.passed?.denominator).toBe(1)
    expect(result.adjudicated.byArm["build-ordinary"]?.outcomes.uncommitted).toBe(1)
    expect(result.rawProvisional.comparisons.stockBuildVsAlgOrdinary?.comparable.pairs).toBe(0)
    expect(result.adjudicated.comparisons.stockBuildVsAlgOrdinary?.comparable.bothPassed).toBe(1)
    expect(result.adjudicated.comparisons.stockBuildVsAlgAdversarial?.comparable.baselineOnly).toBe(1)
    expect(result.review.applied).toBe(1)
    expect(JSON.parse(await readFile(run.args.output, "utf8"))).toEqual(result)
    await expect(finalizeDiscovery(run.args)).rejects.toThrow("EEXIST")
  })
})

test("review preserves verified-read failures and includes budget failures in native pairs", async () => {
  await withReceipt(async run => {
    const result = await finalizeDiscovery(run.args)
    expect(result.attempts[1]?.rawProvisionalGrade.verifiedEvidence).toBe(false)
    expect(result.attempts[1]?.adjudicatedGrade).toMatchObject({ materialDefectRecall: 1, verifiedEvidence: false, passed: false })
    expect(result.attempts[2]?.rawProvisionalGrade.passed).toBe(true)
    expect(result.attempts[2]?.adjudicatedGrade.passed).toBe(false)
    expect(result.adjudicated.comparisons.stockBuildVsAlgAdversarial?.comparable.baselineOnly).toBe(1)
  }, { unverified: true, budgetFailure: true })
})

test("rejects missing, duplicate, mixed-packet and invalid blind decisions", async () => {
  await withReceipt(async run => {
    await run.setDecisions([])
    await expect(finalizeDiscovery(run.args)).rejects.toThrow("Missing blind decisions")
    await run.setDecisions([run.decision, run.decision])
    await expect(finalizeDiscovery(run.args)).rejects.toThrow("Duplicate blind decision")
    await run.setDecisions([{ ...run.decision, claimId: "c99" }])
    await expect(finalizeDiscovery(run.args)).rejects.toThrow("unknown packet or claim")
    const otherPacket = JSON.parse(await readFile(join(run.directory, "blinded", run.trials[0]!.trial + ".json"), "utf8"))
    await run.setDecisions([{ ...run.decision, packetId: otherPacket.packet.packetId }])
    await expect(finalizeDiscovery(run.args)).rejects.toThrow("Missing blind decisions")
    await run.setDecisions([{ ...run.decision, verdict: "unsupported" }])
    await expect(finalizeDiscovery(run.args)).rejects.toThrow("equivalentTo requires a supported decision")
  })
  await withReceipt(async run => {
    await run.setDecisions([{ ...run.decision, evidence: ["catalog.json#unknown"] }])
    await expect(finalizeDiscovery(run.args)).rejects.toThrow("Invalid decision evidence")
  }, { shortEvidence: true })
})

test("a supported blind review can finalize without equivalence credit when an original anchor is absent", async () => {
  await withReceipt(async run => {
    const decisionBytes = await readFile(run.args.decisions)
    const result = await finalizeDiscovery(run.args)
    expect(result.sha256.decisions["decisions/decisions.json"]).toBe(hash(decisionBytes))
    expect(await readFile(run.args.decisions)).toEqual(decisionBytes)
    expect(result.review.receipts[0]?.equivalentTo).toEqual({ finding: "clock", scope: target.scope })
    expect(result.review.noncreditedEquivalences).toEqual([{
      packetId: run.decision.packetId, claimId: "c1", equivalentTo: { finding: "clock", scope: target.scope },
      reason: "original-citations-incomplete",
    }])
    expect(result.attempts[1]?.rawProvisionalGrade.pendingClaims).toEqual(["c1"])
    expect(result.attempts[1]?.adjudicatedGrade).toMatchObject({
      passed: false, supportedClaims: 1, materialDefectRecall: 0, pendingClaims: [],
      adjudicationErrors: [], claims: [{ claimId: "c1", status: "supported", target: null }],
    })
  }, { shortEvidence: true })
})

test("an equivalence without a frozen target leaves the ordinary support decision intact", async () => {
  await withReceipt(async run => {
    await run.setDecisions([{ ...run.decision, equivalentTo: { ...run.decision.equivalentTo, finding: "chamber conditioning" } }])
    const result = await finalizeDiscovery(run.args)
    expect(result.review.noncreditedEquivalences).toMatchObject([{ reason: "frozen-target-absent" }])
    expect(result.attempts[1]?.adjudicatedGrade).toMatchObject({
      supportedClaims: 1, materialDefectRecall: 0, pendingClaims: [],
    })
  })
})

test("freeze, manifest and reconstructed packet independently detect tampering", async () => {
  await withReceipt(async run => {
    await expect(finalizeDiscovery({ ...run.args, frozen: undefined })).rejects.toThrow("original --frozen")
    const path = join(run.directory, "blinded", run.trials[0]!.trial + ".json")
    await writeFile(path, (await readFile(path, "utf8")) + "\n")
    await expect(finalizeDiscovery(run.args)).rejects.toThrow("artifact digest")
    const name = "blinded/" + run.trials[0]!.trial + ".json"
    const original = JSON.parse(await readFile(path, "utf8"))
    original.packet.prompt += "\nTampered"
    await run.persist(name, original)
    await run.saveReport()
    await expect(finalizeDiscovery(run.args)).rejects.toThrow("Blinded packet differs")
    await writeFile(run.args.frozen, JSON.stringify({ ...run.protocol, model: "edited" }))
    await expect(finalizeDiscovery(run.args)).rejects.toThrow("Independent freeze digest mismatch")
  })
})

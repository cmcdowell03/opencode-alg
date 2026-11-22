import { expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sha256 } from "../acceptance/runtime.ts"
import type { DiscoveryReviewPacket, DiscoverySubmission } from "./discovery-grade.ts"
import { scoreNaturalLong } from "./natural-long-metrics.ts"
import { turnRoutingCases } from "./turn-routing-cases.ts"
import { runTurnRoutingReview } from "./turn-routing-review.ts"

const readJSON = async (file: string) => JSON.parse(await readFile(file, "utf8"))
async function writeJSON(file: string, value: unknown) {
  const body = JSON.stringify(value, null, 2) + "\n"
  await writeFile(file, body)
  return sha256(body)
}

test("supplemental review blinds all parsed claims, preserves native evidence and keeps the live denominator", async () => {
  const directory = await mkdtemp(join(tmpdir(), "turn-review-unit-"))
  const run = join(directory, "synthetic-native-shape")
  const privateDir = join(run, "private")
  try {
    await mkdir(privateDir, { recursive: true })
    const cases = turnRoutingCases.map(fixture => ({ id: fixture.id, fixtureSha256: sha256(JSON.stringify(fixture)) }))
    const roster = turnRoutingCases.flatMap((fixture, index) =>
      (index === 0 ? ["alg-routed-compact"] : ["build", "build-focused", "alg-routed-compact"])
        .map(arm => ({ trial: fixture.id + "-" + arm, incident: fixture.id, arm })))
    const protocolSha = await writeJSON(join(privateDir, "protocol.json"), {
      schema: "turn-routing-natural-long-v1", mode: "native-oauth", syntheticUsagePressure: false, cases, roster,
    })
    const manifest: Record<string, string> = {
      "protocol.json": protocolSha, "roster.json": await writeJSON(join(privateDir, "roster.json"), roster),
    }
    const arms = await Promise.all(roster.map(async (trial, index) => {
      const fixture = turnRoutingCases.find(row => row.id === trial.incident)!
      const { claims, missingEvidence } = fixture.fixtureAnswer
      const answer: DiscoverySubmission = {
        disposition: missingEvidence.length ? "indeterminate" : "resolved",
        claims: claims.map(claim => ({ ...claim, evidence: [...claim.evidence] })),
        missingEvidence: [...missingEvidence],
      }
      if (index === 1) {
        const claim = answer.claims[0]!
        answer.claims.push({ ...claim, evidence: [...claim.evidence, answer.claims[1]!.evidence[0]!] })
      }
      if (index === 2) answer.claims[0]!.finding = "carrier deduction uses the superseded revision"
      if (index === 6) answer.claims[0]!.finding = "alg_investigation OpenCode build-focused duplicate"
      const final = index === 4 ? null : index === 5 ? "could not finish" :
        index === 6 ? "runner trace omitted\n" + JSON.stringify(answer) : JSON.stringify(answer)
      const outcome = index === 4 ? "early-stop" : "complete"
      const rootReads = fixture.incident.input.sources.filter(source => index !== 3 || source.path !== fixture.files.board)
        .map(({ path, content }, i) => ({ role: "root", receipt: "verification-" + i, path, sha256: sha256(content) }))
      const evidence = rootReads.map(({ receipt: id, path, sha256 }) => ({ id, path, sha256, scope: "root", outcome: "read" }))
      const accuracy = scoreNaturalLong(fixture, final, rootReads.map(row => row.path))
      const name = trial.trial + ".json"
      const artifactSha256 = await writeJSON(join(privateDir, name), { ...trial, outcome, final, rootReads, evidence, accuracy })
      manifest[name] = artifactSha256
      return { ...trial, outcome, artifactSha256, accuracy: outcome === "complete" && accuracy.correct }
    }))
    const nativePath = join(run, "report.json")
    const originalSha = await writeJSON(nativePath, {
      mode: "native-oauth", freezeSha256: protocolSha, assigned: roster.length, attempted: roster.length, runtimeUnchanged: true,
      historicalControls: [{ trial: "willow-yard-build", final: "must not leak" }], arms, artifactSha256: manifest,
    })
    const publicFile = join(directory, "packets.json")
    const key = join(directory, "review-key.private.json")
    await runTurnRoutingReview(["packet", "--run", run, "--out", publicFile, "--key", key])
    const publicText = await readFile(publicFile, "utf8")
    expect(publicText).not.toMatch(/alg_investigation|openai|opencode|build-focused|willow-yard-build|runner trace|must not leak|verifiedRootPaths|frozenPass/i)
    expect(publicText).toContain("[redacted]")
    const packets: DiscoveryReviewPacket[] = JSON.parse(publicText).packets
    expect(packets).toHaveLength(5)
    expect(new Set(packets.map(packet => packet.packetId)).size).toBe(packets.length)
    expect(packets.map(packet => packet.packetId)).toEqual(packets.map(packet => packet.packetId).sort())
    expect(packets.every(packet => Object.keys(packet).sort().join() === "packetId,prompt,schema,sources,submission")).toBe(true)

    const decisions = packets.flatMap(packet => packet.submission.claims.map((claim, index) => ({
      packetId: packet.packetId, claimId: claim.claimId, verdict: "supported", rationale: "Synthetic decision for test coverage.",
      evidence: claim.evidence.slice(0, 1), duplicateOf: packet.submission.claims[0]?.scope === "BS-213" &&
        packet.submission.claims.length === 3 && index === 2 ? "c1" : null,
      extraneousCitationIndices: index === 2 && claim.scope === "BS-213" ? [claim.evidence.length] : [],
      ...(claim.finding === "carrier deduction uses the superseded revision" &&
        { equivalentTo: { finding: "tare", scope: claim.scope } }),
    })))
    const decisionsFile = join(directory, "decisions.json")
    const output = join(directory, "supplemental.json")
    const apply = (out = output) => runTurnRoutingReview(
      ["apply", "--run", run, "--key", key, "--packets", publicFile, "--decisions", decisionsFile, "--out", out])
    await writeJSON(decisionsFile, { schema: "turn-routing-review-decisions-v1", decisions: decisions.slice(1) })
    await expect(apply()).rejects.toThrow("Missing reviewer decision")
    await writeJSON(decisionsFile, { schema: "turn-routing-review-decisions-v1", decisions: [...decisions, decisions[0]] })
    await expect(apply()).rejects.toThrow("Duplicate reviewer decision")
    await writeJSON(decisionsFile, { schema: "turn-routing-review-decisions-v1", decisions })
    await writeFile(publicFile, publicText + "\n")
    await expect(apply()).rejects.toThrow("Digest mismatch")
    await writeFile(publicFile, publicText)
    await apply()
    const report = await readJSON(output)
    expect(report).toMatchObject({ assigned: 7, missingFinals: 1, frozenPassed: 2, supplementalPassed: 2 })
    expect(report.arms.map((arm: { supplementalPass: boolean }) => arm.supplementalPass))
      .toEqual([true, false, true, false, false, false, false])
    expect(report.arms[1].reviewed[2]).toMatchObject({ duplicateOf: "c1", extraneousCitationIndices: [5] })
    expect(report.arms[2].reviewed[0]).toMatchObject({ frozenPending: true, verdict: "supported" })
    expect(report.arms[3].supplementalGrade.verifiedEvidence).toBe(false)
    expect(report.arms[4]).toMatchObject({ finalPresent: false, packetId: null, frozenPass: false, supplementalPass: false })
    expect(report.arms[5]).toMatchObject({ finalPresent: true, packetId: null, supplementalPass: false })
    await expect(apply(nativePath)).rejects.toThrow("EEXIST")
    expect(sha256(await readFile(nativePath, "utf8"))).toBe(originalSha)

    const scripted = await readJSON(nativePath)
    await writeJSON(nativePath, { ...scripted, mode: "local-scripted" })
    await expect(runTurnRoutingReview(["packet", "--run", run, "--out", join(directory, "scripted.json"), "--key", key]))
      .rejects.toThrow("native-oauth")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

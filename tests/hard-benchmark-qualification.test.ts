import { describe, expect, test } from "bun:test"
import { createHardBenchmarkFixtures } from "../scripts/hard-benchmark-fixtures.ts"
import {
  HardBenchmarkRunnerUnavailableError,
  hardBenchmarkNegativeArm, hardBenchmarkReferenceArm, hardBenchmarkTamperArm, hardBenchmarkExtraFieldArm,
  qualifyHardBenchmarkCase, qualifyHardBenchmarkDevelopment,
} from "../scripts/hard-benchmark-qualification.ts"

describe("arm-neutral hard benchmark development qualification", () => {
  test("reference solutions pass and negative/tamper/extra-field submissions fail for every frozen fixture", async () => {
    const result = await qualifyHardBenchmarkDevelopment(createHardBenchmarkFixtures())
    expect(result.isolation).toBe("same-user-development-only-not-os-isolated")
    expect(result.caseCount).toBe(24)
    expect(result.acceptedPositive).toBe(6)
    expect(result.rejectedNegativeOrTamper).toBe(12)
    expect(result.rejectedExtraField).toBe(6)
    expect(result.blockedCases).toBe(0)
    expect(result.failedCases).toBe(0)
    expect(result.passed).toBe(true)
    expect(result.results.every(row => row.isolation === result.isolation)).toBe(true)
    expect(result.results.find(row => row.family === "multi-repo-compatibility" && row.case === "positive")?.status).toBe("passed")
  }, 60_000)

  test("arm receives a contestant-only snapshot and no grader-evidence methods", async () => {
    const fixture = createHardBenchmarkFixtures()[0]!
    const result = await qualifyHardBenchmarkCase(fixture, async context => {
      expect("grader" in context.fixture).toBe(false)
      expect(context.service && "evidence" in context.service).toBe(false)
      expect(context.service && "replaceSource" in context.service).toBe(false)
      expect(Object.isFrozen(context.fixture.files)).toBe(true)
      expect(() => { (context.fixture.files as Record<string, string>)["README.md"] = "tampered" }).toThrow()
      return hardBenchmarkReferenceArm(context)
    }, "positive")
    expect(result.passed).toBe(true)
  })

  test("individual negative and tamper controls fail closed", async () => {
    const fixtures = createHardBenchmarkFixtures()
    for (const fixture of fixtures) {
      const negative = await qualifyHardBenchmarkCase(fixture, hardBenchmarkNegativeArm, "negative")
      const tamper = await qualifyHardBenchmarkCase(fixture, hardBenchmarkTamperArm, "tamper")
      const extraField = await qualifyHardBenchmarkCase(fixture, hardBenchmarkExtraFieldArm, "extra-field")
      expect(negative.passed, `${fixture.contestant.id} negative`).toBe(true)
      expect(tamper.passed, `${fixture.contestant.id} tamper`).toBe(true)
      expect(negative.grade.passed).toBe(false)
      expect(tamper.grade.passed).toBe(false)
      expect(extraField.passed, `${fixture.contestant.id} extra-field`).toBe(true)
      expect(extraField.grade.passed).toBe(false)
      const schemaCheck = fixture.contestant.family === "multi-repo-compatibility" ? "validation:schema" : "report:schema"
      expect(extraField.grade.checks.find(check => check.id === schemaCheck)?.passed, fixture.contestant.id).toBe(false)
      const semanticCheck = fixture.contestant.family === "accepted-query-lost-ack" ? "report:denominator"
        : fixture.contestant.family === "partial-investigation-restart" ? "report:particle"
        : fixture.contestant.family === "factory-evidence" ? "report:conclusion" : "validation:eventCount"
      expect(negative.grade.checks.find(check => check.id === semanticCheck)?.passed, fixture.contestant.id).toBe(false)
      expect(tamper.grade.checks.find(check => check.id === "protected:README.md")?.passed, fixture.contestant.id).toBe(false)
    }
  }, 60_000)

  test("only an explicit unavailable runner blocks a positive code qualification", async () => {
    const fixture = createHardBenchmarkFixtures().find(item => item.contestant.family === "multi-repo-compatibility")!
    const unavailable = await qualifyHardBenchmarkCase(fixture, hardBenchmarkReferenceArm, "positive", {
      multiRepoRunner: async () => { throw new HardBenchmarkRunnerUnavailableError("injected runner unavailable") },
    })
    expect(unavailable.status).toBe("blocked")
    expect(unavailable.passed).toBe(false)
    const permissionDenied = await qualifyHardBenchmarkCase(fixture, hardBenchmarkReferenceArm, "positive", {
      multiRepoRunner: async () => { throw Object.assign(new Error("host permission denied"), { code: "EPERM" }) },
    })
    expect(permissionDenied.status).toBe("blocked")
    expect(permissionDenied.passed).toBe(false)
    const broken = await qualifyHardBenchmarkCase(fixture, hardBenchmarkReferenceArm, "positive", {
      multiRepoRunner: async () => { throw new Error("candidate code failed") },
    })
    expect(broken.status).toBe("failed")
    expect(broken.passed).toBe(false)
  })

  test("unavailable execution cannot qualify negative or tamper controls as rejected code", async () => {
    const fixture = createHardBenchmarkFixtures().find(item => item.contestant.family === "multi-repo-compatibility")!
    for (const [testCase, arm] of [["negative", hardBenchmarkNegativeArm], ["tamper", hardBenchmarkTamperArm],
      ["extra-field", hardBenchmarkExtraFieldArm]] as const) {
      const result = await qualifyHardBenchmarkCase(fixture, arm, testCase, { multiRepoRunner: null })
      expect(result.status).toBe("blocked")
      expect(result.passed).toBe(false)
      expect(result.grade.checks).toEqual([{ id: "runner:available", passed: false, detail: "local runner unavailable" }])
    }
  })

  test("equivalent factory stratum order remains valid", async () => {
    const fixture = createHardBenchmarkFixtures().find(item => item.contestant.family === "factory-evidence")!
    const result = await qualifyHardBenchmarkCase(fixture, async context => {
      const good = await hardBenchmarkReferenceArm(context)
      const report = JSON.parse(good.files["report.json"]!)
      expect(report.strata.length).toBeGreaterThan(1)
      report.strata.reverse()
      return { files: { ...good.files, "report.json": JSON.stringify(report) } }
    }, "positive")
    expect(result.status).toBe("passed")
  })

  test("factory reference matches hand-enumerated seed-zero strata and outcomes", async () => {
    const fixtures = createHardBenchmarkFixtures().filter(item => item.contestant.family === "factory-evidence")
    const reports = await Promise.all(fixtures.map(async fixture => {
      const submission = await hardBenchmarkReferenceArm({ fixture: fixture.contestant })
      return JSON.parse(submission.files["report.json"]!)
    }))
    expect(reports.map(report => report.conclusion.kind)).toEqual(["chamber-effect", "confounded", "insufficient"])
    expect(reports[0]!.window).toEqual({ start: "2026-05-01T11:00:00.000Z", endExclusive: "2026-05-01T17:00:00.000Z" })
    expect(reports[0]!.strata.map((cell: any) => [cell.C1.failed, cell.C1.total, cell.C2.failed, cell.C2.total]))
      .toEqual([[9, 12, 2, 12], [7, 10, 1, 10]])
    expect(reports[0]!.comparison).toEqual({ sharedStrata: 2, eligibleStrata: 2, elevatedStrata: 2 })
    expect(reports[1]!.comparison.sharedStrata).toBe(0)
    expect(reports[2]!.comparison).toEqual({ sharedStrata: 1, eligibleStrata: 0, elevatedStrata: 0 })
  })
})

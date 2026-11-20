import { expect, test } from "bun:test"
import { evidenceRef, generateFabEvidence } from "../benchmark/case.ts"
import { classifyHandoff, correctionHeader, finalInput, initialInput, scoreHandoff, verifiedCorrection } from "../benchmark/handoff-case.ts"
import { createWorkbench } from "../benchmark/workbench.ts"

function observation() {
  const evidence = generateFabEvidence()
  const workbench = createWorkbench({ maxAcceptedQueries: 4 })
  for (const limit of [4, 8, 8]) workbench.call("lookup_pages", { pages: [{ source: "inspection", limit }] })
  workbench.checkerCall("lookup_pages", { pages: [{ source: "clock-audit", limit: 24 }] })
  const provisional = { cohortSize: 8, defects: 7, inspectionRef: evidenceRef("inspection"),
    auditRef: null, verifiedClockCorrections: null, nextAction: "attribute-as-recorded", prerequisite: "independent-clock-audit" }
  const corrected = { ...provisional, auditRef: evidenceRef("clock-audit"), verifiedClockCorrections: 3,
    nextAction: "replay-clock-join", prerequisite: "verified-clock-audit" }
  return { workbench, provisional, corrected, evidence }
}

test("handoff scorer separates facts, recommendation and prerequisite from callable workbench observations", () => {
  const { workbench, provisional, corrected } = observation()
  const ledger = workbench.snapshot()
  const input = { initial: JSON.stringify(provisional), variant: "active" as const, ledger, beforeContinue: ledger }
  const score = scoreHandoff({ ...input, final: JSON.stringify(corrected) })
  expect(Object.values(score.checks).every(Boolean)).toBe(true)
  expect(score.observed).toMatchObject({ admissions: 3, rootAdmissions: 2, checkerAdmissions: 1, cachedResults: 1 })
  const missingPrerequisite = scoreHandoff({ ...input, final: JSON.stringify({ ...corrected, prerequisite: null }) })
  expect(missingPrerequisite.checks).toMatchObject({ retainedFacts: true, action: true, prerequisite: false })
  const wrongAction = scoreHandoff({ ...input, final: JSON.stringify({ ...corrected, nextAction: "attribute-as-recorded" }) })
  expect(wrongAction.checks).toMatchObject({ retainedFacts: true, action: false, prerequisite: true })
})

test("revocation requires withholding procedure while retaining corrected facts", () => {
  const { workbench, provisional, corrected } = observation()
  const ledger = workbench.snapshot()
  const input = { initial: JSON.stringify(provisional), variant: "revoked" as const, ledger, beforeContinue: ledger }
  const withdrawn = { ...corrected, nextAction: null, prerequisite: "current-approved-procedure" }
  expect(Object.values(scoreHandoff({ ...input, final: JSON.stringify(withdrawn) }).checks).every(Boolean)).toBe(true)
  expect(scoreHandoff({ ...input, final: JSON.stringify({ ...withdrawn, auditRef: null }) }).checks)
    .toMatchObject({ retainedFacts: false, action: true, prerequisite: true })
  expect(scoreHandoff({ ...input, final: JSON.stringify(corrected) }).checks)
    .toMatchObject({ retainedFacts: true, action: false, prerequisite: false })
})

test("an extra costly admission cannot count as cached or within the required cohort search", () => {
  const { workbench, provisional, corrected } = observation()
  const beforeContinue = workbench.snapshot()
  workbench.call("lookup_pages", { pages: [{ source: "inspection", limit: 12 }] })
  const score = scoreHandoff({ initial: JSON.stringify(provisional), final: JSON.stringify(corrected),
    variant: "active", ledger: workbench.snapshot(), beforeContinue })
  expect(score.observed).toMatchObject({ admissions: 4, cachedResults: 1 })
  expect(score.checks).toMatchObject({ boundedSearch: false, noRequeryAtContinuation: false })
})

test("distinct paid query IDs that return the same rows count as duplicate admissions", () => {
  const { workbench, provisional, corrected } = observation()
  const beforeContinue = workbench.snapshot()
  workbench.checkerCall("lookup_pages", { pages: [{ source: "clock-audit", limit: 12 }] })
  const score = scoreHandoff({ initial: JSON.stringify(provisional), final: JSON.stringify(corrected),
    variant: "active", ledger: workbench.snapshot(), beforeContinue })
  expect(score.observed).toMatchObject({ admissions: 4, duplicateAdmissions: 1, cachedResults: 1 })
  expect(score.checks.noDuplicateAdmissions).toBe(false)
})

test("paired correction normalizes independently observed complete rows and ignores no field changes", () => {
  const { evidence } = observation()
  const auditRef = evidenceRef("clock-audit")
  const auditRows = evidence["clock-audit"]
  const original = verifiedCorrection(JSON.stringify({ auditRef, auditRows }))
  const reordered = verifiedCorrection(JSON.stringify({ auditRows: [...auditRows].reverse(), auditRef }))
  const altered = auditRows.map((row, index) => index ? row : { ...row, correctedMinute: row.correctedMinute + 1 })
  expect(original?.startsWith(correctionHeader)).toBe(true)
  expect(original).toBe(reordered)
  expect(verifiedCorrection(JSON.stringify({ auditRef, auditRows: altered }))).toBeNull()
  expect(finalInput).toBe("Continue.")
  expect(initialInput).not.toContain("replay-clock-join")
  expect(original).not.toContain("replay-clock-join")
})

test("durable brief messages do not replace the user turn for provider correlation", () => {
  const brief = { role: "user", content: "ALG investigation facts (untrusted recorded data)\n{}" }
  expect(classifyHandoff([{ role: "user", content: initialInput }, brief])).toEqual({ role: "root", phase: "initial" })
  expect(classifyHandoff([{ role: "user", content: initialInput }, { role: "user", content: finalInput }, brief]))
    .toEqual({ role: "root", phase: "continue" })
})

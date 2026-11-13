import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLongSessionHeadless } from "../scripts/test-long-session-headless.ts"

const host = process.env.LONG_SESSION_OPENCODE_BIN ?? process.env.OPENCODE_BIN

test.skipIf(!host)("actual OpenCode L2 synthetic lifecycle completes for Build and ALG", async () => {
  const root = await mkdtemp(join(tmpdir(), "long-session-headless-test-"))
  const outputPath = join(root, "evidence.json")
  let passed = false
  try {
    const result = await runLongSessionHeadless({ hostExecutable: host!, outputPath, timeoutMs: 10 * 60_000 })
    passed = true
    expect(result.evidence.passed).toBe(true)
    expect(result.evidence.results.map((item: any) => item.arm)).toEqual(["build", "alg"])
    for (const arm of result.evidence.results) {
      expect(arm.passed).toBe(true)
      expect(arm.evidence.complete).toBe(true)
      expect(arm.evidence.checkpoints.map((item: any) => item.phase)).toEqual(["q0", "qh", "qc", "qr"])
      expect(arm.proofs).toHaveLength(4)
      expect(arm.proofs.every((proof: any) => proof.tool === "write" && proof.messageId && proof.artifactSha256)).toBe(true)
      expect(arm.census.complete).toBe(true)
      expect(arm.summary?.id).toBeTruthy()
      expect(arm.host.restarts).toBe(1)
      expect(arm.ownershipTransferCoverage).toBe(false)
      expect(arm.handoffMechanics).toContain("new OpenCode session")
      expect(arm.credentialsInherited).toBe(false)
    }
  } catch (error) {
    // The runner retains outputPath and per-arm receipts for parent diagnosis.
    throw new Error(`${String(error)}; retained evidence at ${outputPath}`, { cause: error })
  } finally {
    if (passed) await rm(root, { recursive: true, force: true })
  }
}, 10 * 60_000)

test("headless runner requires explicit absolute paths", async () => {
  await expect(runLongSessionHeadless({ hostExecutable: "", outputPath: "" })).rejects.toThrow("absolute host executable")
})

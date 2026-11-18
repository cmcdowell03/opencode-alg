import { longReferenceCheckpoint as executeReference, type LongCase, type LongPhase } from "./build-benchmark-long-fixtures.ts"
import { hardBenchmarkReferenceArm } from "./hard-benchmark-qualification.ts"
import type { HardBenchmarkServiceClient } from "./hard-benchmark-qualification.ts"

/** Trusted reference arm; all benchmark service work uses the supplied public HTTP client. */
export async function longReferenceCheckpoint(
  c: LongCase,
  client: HardBenchmarkServiceClient,
  phase: LongPhase,
  nonce: string,
  previous?: Record<string, string>,
): Promise<Record<string, string>> {
  const files = await executeReference(c, client, previous, phase, nonce)
  const factory = await hardBenchmarkReferenceArm({ fixture: c.factory.contestant })
  if (typeof factory.files["report.json"] !== "string") throw new Error("existing factory reference did not produce report.json")
  files["factory.json"] = factory.files["report.json"]
  return files
}

import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runLiveVerification } from "./live-verify.ts"

const directory = mkdtempSync(join(tmpdir(), "alg-check-live-"))
const evidence = join(directory, "live-verification.json")
try {
  await runLiveVerification(evidence)
  const parsed = JSON.parse(readFileSync(evidence, "utf8"))
  if (parsed.passed !== true) throw new Error("generated live evidence did not pass")
  console.log(`live verification passed: ${parsed.version?.parsed}; ${parsed.server?.parsed_alg_ids?.length} ALG tools; TUI registered`)
} finally {
  rmSync(directory, { recursive: true, force: true })
}

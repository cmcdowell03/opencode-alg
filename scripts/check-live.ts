import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, extname, isAbsolute, resolve } from "node:path"
import { captureStableRegularFile } from "../src/config-editor.ts"
import { safeDiagnosticText } from "../src/diagnostics.ts"
import {
  DEFAULT_LIVE_EVIDENCE_ROOT,
  LIVE_EVIDENCE_LIMIT_BYTES,
  LiveEvidenceSchema,
  retainedLiveEvidencePassed,
  runLiveVerification,
  uniqueLiveEvidencePath,
  verifyRetainedLiveEvidenceArtifact,
  verificationPluginConfiguration,
} from "./live-verify.ts"

export function reportLiveFailure(evidence: string, sourceSha: string, failure: unknown): never {
  let retained: Record<string, unknown> = {}
  let secondary: string | undefined
  try {
    const captured = captureStableRegularFile(evidence)
    if (!captured.exists) throw new Error("live verification did not retain evidence")
    if (captured.bytes.byteLength > LIVE_EVIDENCE_LIMIT_BYTES) throw new Error("retained live evidence exceeds its byte limit")
    const parsed = LiveEvidenceSchema.parse(JSON.parse(captured.bytes.toString("utf8")))
    if (parsed.plugin_source.sha256 !== sourceSha || resolve(parsed.output_path) !== resolve(evidence)) throw new Error("failed live evidence source/path differs")
    retained = {
      evidence_sha256: captured.hash, evidence_bytes: captured.bytes.byteLength, evidence_identity: captured.identity,
      reason: parsed.reason, phase: parsed.tui ? "tui-or-cleanup" : parsed.server ? "server" : "version",
      server_cleanup: parsed.server?.cleanup ?? null, tui_cleanup: parsed.tui?.cleanup ?? null,
      temporary_environment_removed: parsed.temporary_environment_removed, cleanup_failures: parsed.cleanup_failures ?? [],
    }
  } catch (error) {
    secondary = safeDiagnosticText(error instanceof Error ? error.message : String(error)).trim()
  }
  console.log(JSON.stringify({ check: "opencode-alg-live", passed: false, evidence_path: evidence,
    original_failure: safeDiagnosticText(failure instanceof Error ? failure.message : String(failure)).trim(),
    ...retained, evidence_validation_error: secondary ?? null }))
  // Preserve the original object/cause even when evidence is missing or malformed.
  throw failure
}

export async function checkLive(): Promise<void> {
const configuration = verificationPluginConfiguration()
const requested = process.env.OPENCODE_ALG_LIVE_EVIDENCE?.trim()
const requestedRoot = requested ? (extname(requested).toLowerCase() === ".json" ? dirname(resolve(requested)) : resolve(requested)) : DEFAULT_LIVE_EVIDENCE_ROOT
const candidate = uniqueLiveEvidencePath(requestedRoot, configuration.source.digest)
if (requested && !isAbsolute(requested)) {
  throw new Error("OPENCODE_ALG_LIVE_EVIDENCE must be an absolute path in a dedicated external evidence root")
}
const evidence = candidate

let failure: unknown
let publication: Awaited<ReturnType<typeof runLiveVerification>> | undefined
try {
  publication = await runLiveVerification(evidence)
} catch (error) {
  failure = error
}

if (failure !== undefined) reportLiveFailure(evidence, configuration.source.digest, failure)

if (!existsSync(evidence)) throw failure ?? new Error("live verification did not retain evidence")
const bytes = readFileSync(evidence)
if (bytes.byteLength > LIVE_EVIDENCE_LIMIT_BYTES) {
  throw new Error(`retained live evidence exceeds ${LIVE_EVIDENCE_LIMIT_BYTES} bytes`)
}
const parsed = JSON.parse(bytes.toString("utf8"))
const persistedHash = createHash("sha256").update(bytes).digest("hex")
const verified = verifyRetainedLiveEvidenceArtifact(evidence, {
  source_sha256: configuration.source.digest,
  sha256: persistedHash,
  bytes: bytes.byteLength,
  ...(publication ? { identity: publication.identity } : {}),
})
const summary = {
  check: "opencode-alg-live",
  passed: retainedLiveEvidencePassed(parsed),
  evidence_path: evidence,
  evidence_sha256: persistedHash,
  evidence_bytes: bytes.byteLength,
  evidence_identity: verified.identity,
  opencode_version: parsed.version?.parsed?.text ?? null,
  plugin_version: parsed.plugin_source?.package_version ?? null,
  canonical_plugin_root: parsed.plugin_source?.canonical_root ?? null,
  package_spec: parsed.plugin_source?.package_spec ?? null,
  source_sha256: parsed.plugin_source?.sha256 ?? null,
  source_manifest_files: parsed.plugin_source?.runtime_manifest?.file_count ?? null,
  source_manifest_bytes: parsed.plugin_source?.runtime_manifest?.total_bytes ?? null,
  source_manifest_entries: parsed.plugin_source?.runtime_manifest?.entries ?? [],
  server_entry: parsed.plugin_source?.entry_points?.server ?? null,
  tui_entry: parsed.plugin_source?.entry_points?.tui ?? null,
  server_registration: parsed.plugin_source?.registrations?.server ?? null,
  tui_registration: parsed.plugin_source?.registrations?.tui ?? null,
  alg_tool_ids: parsed.server?.parsed_alg_ids ?? [],
  server_source_identity: parsed.server?.source_identity_log ?? null,
  tui_source_identity: parsed.tui?.source_identity_log ?? null,
  tui_registration_log: parsed.tui?.registration_log ?? null,
  server_cleanup_passed: parsed.server?.cleanup?.passed === true,
  tui_cleanup_passed: parsed.tui?.cleanup?.passed === true,
  temporary_environment_removed: parsed.temporary_environment_removed === true,
  user_global_config_modified: parsed.isolation?.user_global_config_modified ?? null,
  global_config_snapshot_sha256: parsed.isolation?.global_config_snapshots?.before?.sha256 ?? null,
  global_config_snapshot_unchanged: parsed.isolation?.global_config_snapshots?.unchanged === true,
  reason: parsed.reason ?? null,
}
console.log(JSON.stringify(summary))
if (failure) throw failure
if (!summary.passed) throw new Error("generated live evidence did not pass")
}

if (import.meta.main) await checkLive()

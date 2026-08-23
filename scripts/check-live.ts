import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, extname, isAbsolute, resolve } from "node:path"
import {
  DEFAULT_LIVE_EVIDENCE_ROOT,
  LIVE_EVIDENCE_LIMIT_BYTES,
  retainedLiveEvidencePassed,
  runLiveVerification,
  uniqueLiveEvidencePath,
  verifyRetainedLiveEvidenceArtifact,
  verificationPluginConfiguration,
} from "./live-verify.ts"

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

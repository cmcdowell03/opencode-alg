import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { computeAlgSourceIdentity, type AlgSourceIdentity } from "./source-identity.ts"

export const ALG_RUNTIME_IDENTITY_PROTOCOL = "alg-runtime-identity-v1" as const
export const ALG_RUNTIME_BUILD_ID = "opencode-alg@0.4.1" as const

export interface AlgRuntimeIdentityAtLoad {
  protocol: typeof ALG_RUNTIME_IDENTITY_PROTOCOL
  build: string
  source_manifest_at_module_load: string
}

function defaultRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..")
}

export function captureRuntimeIdentityAtModuleLoad(root = defaultRoot()): AlgRuntimeIdentityAtLoad {
  const identity = computeAlgSourceIdentity(root)
  let build: string = ALG_RUNTIME_BUILD_ID
  try {
    const pkg = JSON.parse(readFileSync(join(resolve(root), "package.json"), "utf8")) as { name?: unknown; version?: unknown }
    if (pkg.name === "opencode-alg" && typeof pkg.version === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(pkg.version)) {
      build = `opencode-alg@${pkg.version}`
    }
  } catch { /* the bounded source identity is the primary local observation */ }
  return Object.freeze({
    protocol: ALG_RUNTIME_IDENTITY_PROTOCOL,
    build,
    source_manifest_at_module_load: identity.digest,
  })
}

export function compareRuntimeIdentity(
  atLoad: AlgRuntimeIdentityAtLoad,
  disk: Pick<AlgSourceIdentity, "digest"> | null,
) {
  return Object.freeze({
    protocol: atLoad.protocol,
    build: atLoad.build,
    source_manifest_at_module_load: atLoad.source_manifest_at_module_load,
    disk_source_manifest_now: disk?.digest ?? null,
    disk_status: disk ? "available" as const : "unavailable" as const,
    restart_required: disk ? disk.digest !== atLoad.source_manifest_at_module_load : null,
    scope: "Local package source manifest only; not proof of upstream host loading or of arbitrary in-place code changes during startup.",
  })
}

export function inspectRuntimeIdentityNow(atLoad: AlgRuntimeIdentityAtLoad, root = defaultRoot()) {
  try {
    return compareRuntimeIdentity(atLoad, computeAlgSourceIdentity(root))
  } catch {
    return compareRuntimeIdentity(atLoad, null)
  }
}

export function runtimeIdentityStartupMessage(identity: AlgRuntimeIdentityAtLoad): string {
  return `ALG deployment identity protocol=${identity.protocol} build=${identity.build} ` +
    `source_manifest_at_module_load=${identity.source_manifest_at_module_load} ` +
    "scope=local-package-tree-only;not-proof-of-upstream-host-load"
}

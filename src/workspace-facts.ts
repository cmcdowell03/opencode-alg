import { lstatSync } from "node:fs"
import { createHash } from "node:crypto"
import { join } from "node:path"
import type { z } from "zod"
import { resolveContainedPath } from "./paths.ts"
import { readSkillEvolutionDirectBounded } from "./skill-evolution-store.ts"
import { localOrigin, verifyEnvironment } from "./session-memory/environment.ts"
import { EnvironmentSchema, type Checkpoint } from "./session-memory/schemas.ts"
import { assertNoSecrets, type MemoryStore } from "./session-memory/store.ts"
import type { WorkspaceFactEvidence } from "./workspace/index.ts"

const PACKAGE_LIMIT = 128 * 1024
const GIT_CONFIG_LIMIT = 64 * 1024
const HEAD_LIMIT = 4096
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex")
type Environment = z.infer<typeof EnvironmentSchema>

function readRegular(project: string, relative: string, limit: number): Buffer {
  const path = resolveContainedPath(project, relative)
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error("unavailable")
  return readSkillEvolutionDirectBounded(project, path, limit, "workspace fact")
}

function known(value: string, source: string, revision: string, observedAt = new Date().toISOString()): WorkspaceFactEvidence {
  assertNoSecrets(value)
  if (/https?:\/\/[^/\s]*@/i.test(value)) throw new Error("credential-bearing repository reference")
  return { state: "known", value, source, source_revision: revision, observed_at: observedAt }
}

function parseOrigin(config: string): string | undefined {
  let section = ""
  const found: string[] = []
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("#") || line.startsWith(";")) continue
    const heading = /^\[\s*remote\s+"([^"]+)"\s*\]$/i.exec(line)
    if (heading) { section = `remote.${heading[1]!.toLowerCase()}`; continue }
    if (line.startsWith("[")) { section = ""; continue }
    if (section !== "remote.origin") continue
    const pair = /^(url)\s*=\s*(.*?)\s*$/i.exec(line)
    if (pair) found.push(pair[2]!.replace(/^"(.*)"$/, "$1"))
  }
  return found.length === 1 && found[0] ? found[0] : undefined
}

function repositoryFacts(project: string, refs: Set<string>, facts: Record<string, WorkspaceFactEvidence>): void {
  const needRepo = refs.has("repository.identity") || refs.has("repository.remote")
  const needCommand = refs.has("test.command")
  if (needRepo) {
    try {
      const gitDirectory = join(project, ".git")
      const gitStat = lstatSync(gitDirectory)
      // Worktree .git files are intentionally unresolved: following their pointer expands the evidence scope.
      if (gitStat.isDirectory() && !gitStat.isSymbolicLink()) {
        const config = readRegular(project, ".git/config", GIT_CONFIG_LIMIT)
        const remote = parseOrigin(config.toString("utf8"))
        if (remote) {
          const revision = sha256(config)
          if (refs.has("repository.remote")) facts["repository.remote"] = known(remote, ".git/config:remote.origin.url", revision)
          if (refs.has("repository.identity")) {
            let head = ""
            try { head = readRegular(project, ".git/HEAD", HEAD_LIMIT).toString("utf8").trim() } catch { /* identity remains incomplete */ }
            const identityRevision = sha256(Buffer.concat([config, Buffer.from("\0"), Buffer.from(head)]))
            if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(head)) facts["repository.identity"] = known(`${remote}#${head.toLowerCase()}`, ".git/config+.git/HEAD", identityRevision)
            else if (/^ref: refs\/(?:heads|tags)\/[A-Za-z0-9._/-]{1,240}$/.test(head)) facts["repository.identity"] = known(`${remote}#${head.slice(5)}`, ".git/config+.git/HEAD", identityRevision)
          }
        }
      }
    } catch { /* unresolved evidence is intentionally omitted */ }
  }
  if (needCommand) {
    try {
      const bytes = readRegular(project, "package.json", PACKAGE_LIMIT)
      const parsed = JSON.parse(bytes.toString("utf8")) as { scripts?: Record<string, unknown> }
      const command = parsed?.scripts?.test
      if (typeof command === "string" && command.trim() && command.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(command)) {
        facts["test.command"] = known(command, "package.json:scripts.test", sha256(bytes))
      }
    } catch { /* malformed, absent or unsupported manifests stay unknown */ }
  }
}

const environmentFact = (environment: Environment, ref: string): string | undefined => {
  const values: Record<string, string> = {
    "environment.name": environment.name,
    "environment.target": environment.target,
    "environment.kind": environment.kind,
    "environment.namespace": environment.namespace ?? "",
    "environment.tenant": environment.tenant ?? "",
    "environment.principal": environment.principal_ref,
    "environment.protocol": environment.protocol,
    "environment.api_version": environment.api_version,
    "environment.client_version": environment.client_version,
  }
  if (ref === "environment.scopes") return [...environment.scopes].sort().join(",")
  if (ref === "environment.tools") return [...environment.tools].sort().join(",")
  if (ref === "environment.endpoint_refs") return [...environment.endpoint_refs].sort().join(",")
  if (ref === "environment.route_refs") return [...environment.route_refs].sort().join(",")
  return values[ref]
}

/** Resolve only requested, bounded local evidence and an unexpired, origin-bound reviewed environment. */
export function resolveWorkspaceFacts(input: {
  project: string
  store: MemoryStore
  checkpoint: Checkpoint
  refs: Iterable<string>
  now?: number
}): Record<string, WorkspaceFactEvidence> {
  const refs = new Set(input.refs)
  const facts: Record<string, WorkspaceFactEvidence> = Object.create(null) as Record<string, WorkspaceFactEvidence>
  const now = input.now ?? Date.now()
  if (refs.has("platform")) facts.platform = known(process.platform, "host-platform", sha256(process.platform))
  const environmentRefs = [...refs].filter((ref) => ref.startsWith("environment."))
  if (environmentRefs.length) {
    if (input.checkpoint.environment) {
      try {
        const node = input.store.node(input.checkpoint.environment, input.checkpoint.owner)
        if (node.kind !== "environment") {
          for (const ref of environmentRefs) facts[ref] = { state: "conflict", source: "session-memory:environment-binding" }
        } else if (node.payload.origin_fingerprint !== localOrigin().id ||
          Date.parse(node.payload.verified_at) > now || Date.parse(node.payload.expires_at) <= now) {
          for (const ref of environmentRefs) facts[ref] = { state: "stale", source: "session-memory:environment-binding" }
        } else {
          verifyEnvironment(input.store, input.checkpoint, now)
          for (const ref of environmentRefs) {
            const value = environmentFact(node.payload, ref)
            if (value !== undefined) facts[ref] = { ...known(value, "reviewed-environment:" + node.id, node.payload.source_ref, node.payload.verified_at), expires_at: node.payload.expires_at }
          }
        }
      } catch { for (const ref of environmentRefs) facts[ref] = { state: "conflict", source: "session-memory:environment-binding" } }
    }
  }
  repositoryFacts(input.project, refs, facts)
  return facts
}

const CONTROL_OR_COMPOSITION = /[\u0000-\u001f\u007f;&|<>`$(){}]/
const SHELL_TOOLS = new Set(["bash", "sh", "shell", "terminal", "powershell", "pwsh"])

/** Classify explicit shell-tool input only; compound commands and natural-language text are ignored. */
export function detectWorkspaceOperation(toolName: string, input: unknown): "repo.test" | "repo.git" | undefined {
  if (!SHELL_TOOLS.has(toolName.toLowerCase()) || !input || typeof input !== "object" || Array.isArray(input)) return undefined
  const record = input as Record<string, unknown>
  const command = [record.command, record.cmd].find((value) => typeof value === "string")
  if (typeof command !== "string" || !command.trim() || command.length > 4096 || CONTROL_OR_COMPOSITION.test(command)) return undefined
  const tokens = command.trim().split(/\s+/)
  if (tokens.some((token) => /["'\\]/.test(token))) return undefined
  const executable = tokens[0]!.replace(/^.*[\\/]/, "").toLowerCase()
  const args = tokens.slice(1)
  if (executable === "git" && args.length > 0 && /^[a-z][a-z-]*$/i.test(args[0]!)) return "repo.git"
  if (["bun", "npm", "pnpm", "yarn"].includes(executable)) {
    const normalized = args.join(" ").toLowerCase()
    if (/^(?:test|run test|run test(?::[a-z0-9:_-]+)?)$/.test(normalized) ||
      (executable === "bun" && /^test(?:\s+[^\s].*)?$/.test(normalized))) return "repo.test"
  }
  return undefined
}

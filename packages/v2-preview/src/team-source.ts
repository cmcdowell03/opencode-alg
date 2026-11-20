import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { isAbsolute, join } from "node:path"
import { realpath } from "node:fs/promises"
import { promisify } from "node:util"
import type { Plugin } from "@opencode/plugin"
import { z } from "zod"
import { isSafeId, isSafeProjectRelativePath } from "../../../src/paths.ts"
import { readWorkspaceRegistry } from "../../../src/workspace/index.ts"
import type { InvestigationHost } from "./host.ts"

const execute = promisify(execFile)
const maxBytes = 8192
const gitObject = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/
const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex")
const input = z.object({
  operation: z.string().max(80).refine(isSafeId),
  source: z.string().max(160).optional(),
}).strict()

function splitSource(ref: string) {
  const match = /^reference:([a-z0-9][a-z0-9_-]{0,63})\/(.+)$/u.exec(ref)
  return match && isSafeProjectRelativePath(match[2]!) ? { alias: match[1]!, path: match[2]! } : null
}

/** Resolve one immutable Git object. A dirty working copy is a separate source. */
export async function readCommittedSource(root: string, path: string, digest: string, signal: AbortSignal) {
  if (!isAbsolute(root) || !isSafeProjectRelativePath(path) || !/^[a-f0-9]{64}$/.test(digest))
    throw new Error("Invalid source address")
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("GIT_")))
  Object.assign(env, { GIT_NO_LAZY_FETCH: "1", GIT_ALLOW_PROTOCOL: "", GIT_TERMINAL_PROMPT: "0" })
  const git = async (...args: string[]) => (await execute("git", ["--no-replace-objects", "--literal-pathspecs", ...args], {
    cwd: root, signal, timeout: 3000, maxBuffer: maxBytes + 256, encoding: "buffer", windowsHide: true, env,
  })).stdout
  const origin = await git("rev-parse", "--show-prefix", "--verify", "HEAD^{commit}")
  const lines = origin.toString("utf8").trimEnd().split(/\r?\n/)
  if (lines.length !== 2 || lines[0] !== "" || !gitObject.test(lines[1]!)) throw new Error("Reference must name a Git checkout root")
  const commit = lines[1]!
  const entry = (await git("ls-tree", "-z", commit, "--", path)).toString("utf8")
  const header = entry.slice(0, entry.indexOf("\t"))
  const blob = /^100(?:644|755) blob ([a-f0-9]+)$/.exec(header)?.[1]
  if (!blob || !gitObject.test(blob) || entry !== header + "\t" + path + "\0") throw new Error("Source is not a regular Git blob")
  const rawSize = (await git("cat-file", "-s", blob)).toString("ascii").trim()
  if (!/^\d+$/.test(rawSize) || Number(rawSize) > maxBytes) throw new Error("Source exceeds the document limit")
  const bytes = await git("cat-file", "blob", blob)
  if (bytes.length !== Number(rawSize) || sha256(bytes) !== digest || bytes.includes(0)) throw new Error("Source revision unavailable")
  return { commit, blob, sha256: digest, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) }
}

export function registerTeamSources(ctx: Plugin.Context, host: InvestigationHost, registryDigest: string) {
  return ctx.tool.transform(editor => {
    if (editor.get("alg_team_source")) throw new Error("V2_PREVIEW_TOOL_COLLISION")
    editor.add({
      name: "alg_team_source",
      description: "List the operation's pinned team references, or read one exact committed document with its source citation.",
      input: { type: "object", properties: { operation: { type: "string" }, source: { type: "string" } },
        required: ["operation"], additionalProperties: false },
      options: { permission: "alg_team_source", codemode: false },
      async execute(raw, call) {
        try {
          const args = input.parse(raw)
          const owner = await host.owner(call)
          const directory = host.directory
          const registry = readWorkspaceRegistry(directory)
          if (registry.state !== "ready" || registry.sha256 !== registryDigest) throw new Error("Registry drift")
          const operation = registry.registry.operations.find(row => row.id === args.operation)
          if (!operation) throw new Error("Unknown operation")
          const sources = operation.authoritative_sources.filter(row => row.revision && splitSource(row.ref))
          if (args.source === undefined) return { content: JSON.stringify({ operation: args.operation, sources }) }
          const matches = sources.filter(row => row.ref === args.source)
          if (matches.length !== 1) throw new Error("Unknown or ambiguous source")
          const source = matches[0]!
          const address = splitSource(source.ref)!
          const listed = await ctx.reference.list({ location: { directory } })
          const references = listed.data.filter(row => row.name === address.alias && !row.hidden)
          if (await realpath(listed.location.directory) !== directory || references.length !== 1)
            throw new Error("Reference location unavailable")
          const root = await realpath(references[0]!.path)
          const path = join(root, address.path)
          const subject = { sessionID: owner.id, agent: call.agent }
          await ctx.permission.assert({ ...subject, action: "read", resources: [path] })
          // The reference alias grants no filesystem authority of its own.
          await ctx.permission.assert({ ...subject, action: "external_directory", resources: [join(root, "*")] })
          const evidence = await readCommittedSource(root, address.path, source.revision!, call.signal)
          return { content: JSON.stringify({ source: source.ref, ...evidence }) }
        } catch {
          return { content: JSON.stringify({ error: "TEAM_SOURCE_UNAVAILABLE" }) }
        }
      },
    })
  })
}

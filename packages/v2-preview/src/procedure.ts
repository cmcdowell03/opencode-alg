import { createHash } from "node:crypto"
import { isAbsolute, relative, resolve } from "node:path"
import type { Plugin } from "@opencode/plugin"
import { readSkillEvolutionDirectBounded } from "../../../src/skill-evolution-store.ts"
import { projectPathSchema, procedurePinSchema, type ProcedurePin } from "../core/procedure-pin.ts"
import { canonicalDirectory } from "./host.ts"

export type { ProcedurePin } from "../core/procedure-pin.ts"

const maxProcedureBytes = 4096
const maxSourceBytes = 64 * 1024
export const approvalFileSchema = projectPathSchema.refine(path => path.startsWith(".opencode/") && path.endsWith(".json"))
type Procedure = ProcedurePin & { name: string; content: string }

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")

export function pinOfProcedure({ id, path, sha256, sourceSha256 }: Procedure): ProcedurePin {
  return { id, path, sha256, sourceSha256 }
}

function sameProcedure(left: ProcedurePin | undefined, right: ProcedurePin | undefined): boolean {
  if (!left || !right) return left === right
  return left.id === right.id && left.path === right.path &&
    left.sha256 === right.sha256 && left.sourceSha256 === right.sourceSha256
}

export class ResearchProcedure {
  constructor(
    readonly context: Plugin.Context,
    readonly directory: string,
    readonly approvalFile: string | undefined,
    readonly approvalSha256: string | undefined,
  ) {}

  /** Always re-read the pinned files. Decisions, grants, and tool calls also refresh
   * host discovery. Model projection can use the host's current catalog snapshot
   * because it only exposes the exact, independently pinned project bytes. */
  async current(reload = true): Promise<Procedure | undefined> {
    if (!this.approvalFile) return undefined
    const filename = resolve(this.directory, this.approvalFile)
    const read = (path: string, limit: number) =>
      readSkillEvolutionDirectBounded(this.directory, path, limit, "research procedure")
    try {
      // On 2.3.2 a reload can retain the on-disk discovery cache when the watcher is disabled.
      if (/^(?:1|true)$/i.test(process.env.OPENCODE_DISABLE_FILEWATCHER ?? "")) throw new Error()
      const approval = read(filename, 4096)
      if (sha256(approval) !== this.approvalSha256) throw new Error()
      const pin = procedurePinSchema.parse(JSON.parse(approval.toString("utf8")))
      const source = resolve(this.directory, pin.path)
      if (sha256(read(source, maxSourceBytes)) !== pin.sourceSha256) throw new Error()

      if (reload) await this.context.skill.reload()
      const catalog = await this.context.skill.list({ location: { directory: this.context.location.directory } })
      if (await canonicalDirectory(catalog.location.directory) !== this.directory) throw new Error()
      const candidates = catalog.data.filter(skill => skill.id === pin.id)
      const selected = candidates[0]
      if (candidates.length !== 1 || !selected ||
          !selected.name.trim() || selected.name.length > 128 || /[\x00-\x1f\x7f]/.test(selected.name) ||
          !isAbsolute(selected.path) || relative(source, selected.path) !== "" ||
          !selected.content.trim() || Buffer.byteLength(selected.content) > maxProcedureBytes ||
          sha256(selected.content) !== pin.sha256) throw new Error()

      // A reload can yield while the operator changes or withdraws approval.
      if (!approval.equals(read(filename, 4096)) ||
          sha256(read(source, maxSourceBytes)) !== pin.sourceSha256) throw new Error()
      return { ...pin, name: selected.name, content: selected.content }
    } catch {
      throw new Error("RESEARCH_PROCEDURE_UNVERIFIED")
    }
  }

  async require(expected: ProcedurePin | undefined, reload = true): Promise<Procedure | undefined> {
    const current = await this.current(reload)
    if (!sameProcedure(expected, current)) throw new Error("RESEARCH_PROCEDURE_UNVERIFIED")
    return current
  }
}

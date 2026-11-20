import { createHash, randomUUID } from "node:crypto"
import { link, mkdir, open, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { z } from "zod"
import { runContainedPath } from "../../../src/store.ts"
import { procedurePinSchema, type ProcedurePin } from "../core/procedure-pin.ts"

const hash = z.string().regex(/^[a-f0-9]{64}$/)
const workerId = z.string().regex(/^ses_algv2_[a-f0-9]{32}$/)
const promptId = z.string().regex(/^msg_[a-f0-9]{32}$/)
const agent = z.string().regex(/^[\w-]{1,80}$/)
const bindingSchema = z.object({
  version: z.literal(1),
  runId: z.string(),
  ownerSessionId: z.string().min(1).max(256),
  workerSessionId: workerId,
  promptId,
  checkerAgent: agent,
  work_key: hash,
  manifest_digest: hash,
  procedure: procedurePinSchema.optional(),
}).strict()
const grantSchema = z.object({
  grant_id: z.uuid(),
  work_key: hash,
  manifest_digest: hash,
  checker_node: z.string().min(1).max(63),
})
const markerSchema = z.object({ promptId }).strict()
export const verdictSchema = z.enum(["pass", "fail", "inconclusive"])
export const citationSchema = z.object({
  work_key: hash,
  manifest_digest: hash,
  grant_id: z.uuid(),
  page_sha256: hash,
  read_receipt: z.uuid(),
}).strict()
export type Citation = z.infer<typeof citationSchema>
export const citationKeys = Object.keys(citationSchema.shape) as (keyof Citation)[]
export function sameCitation(a: Citation, b: Citation): boolean {
  return citationKeys.every(key => a[key] === b[key])
}
const readSchema = markerSchema.extend({ citation: citationSchema })
const resultSchema = readSchema.extend({ result: verdictSchema })
export type Binding = z.infer<typeof bindingSchema>
export type Grant = z.infer<typeof grantSchema>

const receipts = {
  binding: bindingSchema,
  grant: grantSchema,
  prompt: markerSchema,
  admission: markerSchema,
  read: readSchema,
  result: resultSchema,
}

export async function readReceipt<S extends z.ZodType>(path: string, schema: S, limit = 8192): Promise<z.output<S> | undefined> {
  let file
  try { file = await open(path, "r") }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    throw error
  }
  try {
    const buf = Buffer.alloc(limit + 1)
    let size = 0
    while (size <= limit) {
      const { bytesRead } = await file.read(buf, size, buf.length - size)
      if (!bytesRead) return schema.parse(JSON.parse(buf.toString("utf8", 0, size)))
      size += bytesRead
    }
    throw new Error("WORKER_JOURNAL_INVALID")
  } finally { await file.close() }
}

/** All publishers expose only complete, fsynced receipts and never replace a winner. */
export async function publishReceipt(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), randomUUID() + ".tmp")
  const file = await open(temp, "wx", 0o600)
  try {
    try {
      await file.writeFile(JSON.stringify(value) + "\n")
      await file.sync()
    } finally { await file.close() }
    try { await link(temp, path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
      throw error
    }
    return true
  } finally { await unlink(temp).catch(() => {}) }
}

export class WorkerJournal {
  readonly runId: string

  constructor(
    readonly directory: string,
    project: string,
    readonly ownerSessionId: string,
  ) {
    const key = createHash("sha256").update(JSON.stringify([project, ownerSessionId])).digest("hex")
    this.runId = "v2-checker-" + key.slice(0, 48)
  }

  private path(kind: string) {
    return runContainedPath(this.directory, this.runId, kind + ".json")
  }

  async read<K extends keyof typeof receipts>(kind: K): Promise<z.output<(typeof receipts)[K]> | undefined> {
    const value = await readReceipt(this.path(kind), receipts[kind], 4096)
    if (value === undefined) return undefined
    if (kind === "binding") {
      const binding = value as Binding
      if (binding.runId !== this.runId || binding.ownerSessionId !== this.ownerSessionId) {
        throw new Error("WORKER_JOURNAL_INVALID")
      }
    }
    return value as z.output<(typeof receipts)[K]>
  }

  /**
   * Publish a fully written receipt without replacing an existing one. A crashed dispatch has
   * no reset path. Other plugin instances and restarted processes see the same winning receipt.
   */
  async publish<K extends keyof typeof receipts>(
    kind: K, value: z.input<(typeof receipts)[K]>,
  ): Promise<boolean> {
    return publishReceipt(this.path(kind), receipts[kind].parse(value))
  }

  async reserve(checkerAgent: string, selection: {
    work_key: string
    manifest_digest: string
    procedure?: ProcedurePin
  }): Promise<Binding | undefined> {
    const binding = {
      version: 1 as const,
      runId: this.runId,
      ownerSessionId: this.ownerSessionId,
      workerSessionId: "ses_algv2_" + randomUUID().replaceAll("-", ""),
      promptId: "msg_" + randomUUID().replaceAll("-", ""),
      checkerAgent,
      ...selection,
    }
    return await this.publish("binding", binding) ? binding : undefined
  }
}

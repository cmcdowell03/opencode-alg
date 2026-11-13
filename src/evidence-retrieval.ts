import { closeSync, fstatSync, openSync, readSync } from "node:fs"
import { z } from "zod"
import { canonicalJson, sha256Json } from "./persistence.ts"
import { isSafeId, isSafeProjectRelativePath } from "./paths.ts"
import { runContainedPath } from "./store.ts"
import { retrievedVerificationEvidence, type RetrievedVerificationEvidence } from "./verification.ts"
import type { RunDataReference } from "./types.ts"

const ref = z.object({ artifact_path: z.string().max(1_024).refine(isSafeProjectRelativePath),
  sha256: z.string().regex(/^[a-f0-9]{64}$/), byte_size: z.number().int().positive().max(1024 * 1_024) }).strict()
export const EvidenceSourceSchema = z.object({ run_id: z.string().refine(isSafeId), node_id: z.string().refine(isSafeId),
  attempt: z.number().int().positive(), child_session_id: z.string().min(1).max(256), reference: ref }).strict()
export const EvidenceSourcesSchema = z.object({ version: z.literal(1), journals: z.array(EvidenceSourceSchema).max(64),
  omitted: z.number().int().nonnegative(), unavailable: z.number().int().nonnegative() }).strict()
export type EvidenceSource = z.infer<typeof EvidenceSourceSchema>
export type EvidenceSources = z.infer<typeof EvidenceSourcesSchema>
export interface EvidenceRecord { reference: RunDataReference; node_id: string; attempt: number; kind: string; ordinal?: number }

/** The hash commits to retained bytes, never to truth or remote acceptance. */
export function readEvidenceText(project: string, runId: string, reference: RunDataReference): string {
  ref.parse(reference)
  const prefix = `.opencode/runs/${runId}/artifacts/`
  if (!reference.artifact_path.startsWith(prefix) || !reference.artifact_path.endsWith(`-${reference.sha256}.json`))
    throw new Error("evidence reference is outside the assigned run")
  const path = runContainedPath(project, runId, "artifacts", ...reference.artifact_path.slice(prefix.length).split("/"))
  const descriptor = openSync(path, "r")
  let bytes: Buffer
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size !== reference.byte_size) throw new Error("evidence size unavailable")
    const buffer = Buffer.alloc(reference.byte_size + 1)
    let read = 0
    while (read < buffer.length) {
      const count = readSync(descriptor, buffer, read, buffer.length - read, null)
      if (!count) break
      read += count
    }
    bytes = buffer.subarray(0, read)
  } finally { closeSync(descriptor) }
  const text = bytes.toString("utf8")
  if (bytes.length !== reference.byte_size || !bytes.equals(Buffer.from(text)) ||
      canonicalJson(JSON.parse(text)) !== text || sha256Json(JSON.parse(text)) !== reference.sha256)
    throw new Error("evidence integrity mismatch")
  return text
}

export function evidencePage(project: string, runId: string, reference: RunDataReference, offset = 0) {
  const text = readEvidenceText(project, runId, reference)
  const data = Buffer.from(text)
  if (!Number.isSafeInteger(offset) || offset < 0 || offset >= data.length || (data[offset]! & 0xc0) === 0x80)
    throw new Error("evidence offset is not a valid UTF-8 boundary")
  let end = Math.min(data.length, offset + 8_192)
  while (end < data.length && (data[end]! & 0xc0) === 0x80) end--
  const content = data.subarray(offset, end).toString("utf8")
  const receipt = retrievedVerificationEvidence(reference, offset, content)
  return { receipt, content, next_offset: end < data.length ? end : null,
    scope: "Retained JSON byte fragment; linked-pair hashes bind this captured call. Ordinal is observed before-hook order within the child attempt, not universal absence. Missing pages, redaction/truncation and remote effects remain unestablished." }
}

/** Active checker capability. No owner lookup bypass, arbitrary paths or caller-supplied receipts. */
export class EvidenceRetrieval {
  private grants = new Map<string, { runId: string; records: EvidenceRecord[]; sources: EvidenceSources;
    receipts: RetrievedVerificationEvidence[]; reads: number }>()
  constructor(readonly project: string) {}
  grant(session: string, runId: string, sources: EvidenceSources, records: EvidenceRecord[]): void {
    if (this.grants.has(session) || this.grants.size >= 64) throw new Error("checker evidence grant unavailable")
    this.grants.set(session, { runId, sources: structuredClone(sources), records: structuredClone(records), receipts: [], reads: 0 })
  }
  take(session: string): RetrievedVerificationEvidence[] {
    const grant = this.grants.get(session)
    this.grants.delete(session)
    return grant?.receipts ?? []
  }
  execute(session: string, request: { evidence: "index" | "read"; record_id?: string; offset?: number; run_id?: string }) {
    const grant = this.grants.get(session)
    if (!grant || (request.run_id !== undefined && request.run_id !== grant.runId)) throw new Error("no active checker evidence grant")
    if (request.evidence === "index") {
      const offset = request.offset ?? 0
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > grant.records.length) throw new Error("invalid evidence index offset")
      return { run_id: grant.runId, sources: { omitted: grant.sources.omitted, unavailable: grant.sources.unavailable },
        records: grant.records.slice(offset, offset + 16).map(record => ({ ...record, record_id: record.reference.sha256 })),
        next_offset: offset + 16 < grant.records.length ? offset + 16 : null,
        warning: "Index pointers are not findings; read exact pages. Linked-pair hashes bind one captured call; ordinal is observed before-hook order within the child attempt, not universal absence. Pages do not establish remote effects." }
    }
    const record = grant.records.find(record => record.reference.sha256 === request.record_id)
    if (!record) throw new Error("record is not assigned to this checker")
    if (grant.reads >= 32) throw new Error("checker evidence retrieval allowance exhausted")
    grant.reads++
    const page = evidencePage(this.project, grant.runId, record.reference, request.offset)
    if (!grant.receipts.some(receipt => receipt.id === page.receipt.id)) grant.receipts.push(page.receipt)
    return { ...page, citation_id: page.receipt.id, node_id: record.node_id, attempt: record.attempt }
  }
}

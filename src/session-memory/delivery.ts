import { randomUUID } from "node:crypto"
import { awaitLock } from "../filesystem-mutex.ts"
import { OwnedContext } from "../owned-context.ts"
import { selectWorkingView } from "./context.ts"
import type { SessionMemoryRuntime } from "./runtime.ts"
import type { ContextReceipt } from "./schemas.ts"
import { hashObject, hashText } from "./store.ts"

type Prepare = (receipt: ContextReceipt, text: string) => Promise<void>
type Limit = (bytes: number | undefined) => void
type Published = (record: (bytes: number) => void) => void

/** Evidence of this plugin's hook publication, never of the final provider request. */
export class ContextDelivery {
  private readonly owned = new OwnedContext()
  constructor(private readonly memory: SessionMemoryRuntime) {}

  async replace(owner: string | undefined, hook: "system" | "compaction", target: string[],
    render: (working: string[], prepare: Prepare, limit: Limit, onPublished: Published, recovery: (text: string) => void) => Promise<void>): Promise<void> {
    const pending: Array<{ request: string; ref: string; text: string }> = []
    let recordPublication: ((bytes: number) => void) | undefined
    let publishedBytes = 0
    let recoveryText = ""
    const onPublished: Published = (record) => {
      if (recordPublication) throw new Error("ALG duplicate publication accounting")
      recordPublication = record
    }
    let ceiling: number | undefined
    const limit: Limit = (bytes) => {
      if (bytes === undefined) return
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("ALG invalid context ceiling")
      ceiling = Math.min(ceiling ?? bytes, bytes)
    }
    let preparationFailed = false, published = false
    const prepare: Prepare = async (receipt, text) => {
      if (!owner || this.memory.options.mode !== "assist") return
      try {
        if (pending.length || receipt.context_hash !== hashText(text)) throw new Error("ALG delivery preparation conflict")
        const request = randomUUID()
        const ref = await awaitLock(() => this.memory.store.prepareDelivery(owner, request, hook, receipt))
        pending.push({ request, ref, text })
      } catch (error) {
        preparationFailed = true
        throw error
      }
    }
    try {
      await this.owned.replace(target, async (working) => {
        const foreignLength = working.length
        await render(working, prepare, limit, onPublished, (text) => { recoveryText = text })
        // Hook fallback handling cannot silently turn a failed preparation into
        // an unrecorded emission of trusted instructions.
        if (preparationFailed) throw new Error("ALG delivery preparation unavailable")
        // Count separators and fallback diagnostics too. Foreign contributions
        // remain untouched; their usage belongs to the host capacity estimate.
        const contribution = working.slice(foreignLength).join("\n")
        publishedBytes = Buffer.byteLength(contribution, "utf8")
        if (ceiling !== undefined && publishedBytes > ceiling) {
          throw new Error("ALG needs_context: final contribution exceeds context ceiling")
        }
        const item = pending[0]
        if (!item || !owner) return
        if (item.text && !working.slice(foreignLength).includes(item.text)) throw new Error("ALG prepared context was not published intact")
        await awaitLock(() => {
          const stored = this.memory.store.delivery(owner, item.request)
          const checkpoint = this.memory.current(owner)
          if (!stored || stored.id !== item.ref || stored.value.checkpoint !== hashObject(checkpoint)) {
            throw new Error("ALG delivery checkpoint changed before publication")
          }
          if (stored.value.context.state !== "blocked") {
            selectWorkingView(this.memory.store, this.memory.index, checkpoint, this.memory.options)
          }
        })
      })
      published = true
      // Publication is real even if the subsequent durable receipt write fails.
      recordPublication?.(publishedBytes)
      const item = pending[0]
      if (item && owner) await awaitLock(() => this.memory.store.settleDelivery(owner, item.request, item.ref, { state: "emitted" }))
      if (owner) this.memory.deliveryUnavailable.delete(owner)
    } catch (error) {
      const item = pending[0]
      if (item && owner) {
        try {
          await awaitLock(() => this.memory.store.settleDelivery(owner, item.request, item.ref,
            { state: "unknown", reason: published ? "emission_unconfirmed" : "hook_failed" }))
        } catch { /* A prepared record remains uncertainty, never successful delivery. */ }
      }
      // Delivery telemetry must not disable ordinary host conversation. Remove
      // our old instructions transactionally and retain only bounded recovery.
      if (owner) {
        if (this.memory.deliveryUnavailable.size >= 4096) this.memory.deliveryUnavailable.clear()
        this.memory.deliveryUnavailable.add(owner)
      }
      try {
        const diagnostic = "ALG context unavailable; use alg_context_status. Required procedures must be revalidated before acting."
        let fallback = recoveryText
        if (Buffer.byteLength(fallback) > (ceiling ?? 65536)) fallback = ""
        const combined = [fallback, diagnostic].filter(Boolean).join("\n")
        if (Buffer.byteLength(combined) <= (ceiling ?? 65536)) fallback = combined
        await this.owned.replace(target, async (working) => { if (fallback) working.push(fallback) })
        recordPublication?.(Buffer.byteLength(fallback))
      } catch { /* Concurrent foreign edits remain untouched; never fail the host request for telemetry. */ }
    }
  }
}

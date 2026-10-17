import { randomUUID } from "node:crypto"
import { awaitLock } from "../filesystem-mutex.ts"
import { OwnedContext } from "../owned-context.ts"
import { selectWorkingView } from "./context.ts"
import type { SessionMemoryRuntime } from "./runtime.ts"
import type { ContextReceipt } from "./schemas.ts"
import { hashObject, hashText } from "./store.ts"

type Prepare = (receipt: ContextReceipt, text: string) => Promise<void>

/** Evidence of this plugin's hook publication, never of the final provider request. */
export class ContextDelivery {
  private readonly owned = new OwnedContext()
  constructor(private readonly memory: SessionMemoryRuntime) {}

  async replace(owner: string | undefined, hook: "system" | "compaction", target: string[],
    render: (working: string[], prepare: Prepare) => Promise<void>): Promise<void> {
    const pending: Array<{ request: string; ref: string; text: string }> = []
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
        await render(working, prepare)
        // Hook fallback handling cannot silently turn a failed preparation into
        // an unrecorded emission of trusted instructions.
        if (preparationFailed) throw new Error("ALG delivery preparation unavailable")
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
      const item = pending[0]
      if (item && owner) await awaitLock(() => this.memory.store.settleDelivery(owner, item.request, item.ref, { state: "emitted" }))
    } catch (error) {
      const item = pending[0]
      if (item && owner) {
        try {
          await awaitLock(() => this.memory.store.settleDelivery(owner, item.request, item.ref,
            { state: "unknown", reason: published ? "emission_unconfirmed" : "hook_failed" }))
        } catch { /* A prepared record remains uncertainty, never successful delivery. */ }
      }
      throw error
    }
  }
}

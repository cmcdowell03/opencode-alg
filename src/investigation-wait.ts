import type { InvestigationStore, InvestigationMcpPort } from "./investigation/index.ts"

const pending = new Set(["submitting", "running", "outcome_unknown", "cancel_requested"])
/** Runs inside the host's existing tool/executor lifetime, without asking the model to poll. */
export async function waitForInvestigation(store: InvestigationStore, port: InvestigationMcpPort,
  options: { waitMs: number; pollIntervalMs: number; signal?: AbortSignal; workKey?: string },
  clock: { now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void> } = {
    now: () => performance.now(),
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); reject(new Error("investigation wait aborted")) }
      const timer = setTimeout(() => { signal?.removeEventListener("abort", cancel); resolve() }, ms)
      if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true })
    }),
  }) {
  if (!Number.isSafeInteger(options.waitMs) || options.waitMs < 0 || options.waitMs > 900_000 ||
    !Number.isSafeInteger(options.pollIntervalMs) || options.pollIntervalMs < 1 || options.pollIntervalMs > 60_000)
    throw new Error("invalid investigation wait bounds")
  const deadline = clock.now() + options.waitMs
  let lookedUp = false
  for (;;) {
    if (options.signal?.aborted) throw new Error("investigation wait aborted")
    const snapshot = store.snapshot
    if (options.workKey !== undefined && !snapshot.work.some((entry) => entry.work_key === options.workKey)) throw new Error("unknown work key")
    const work = snapshot.work.filter((entry) => pending.has(entry.status) && (options.workKey === undefined || entry.work_key === options.workKey))
    if (!work.length) return { ready: true, blocked: [] }
    for (const entry of work) {
      if (options.signal?.aborted) throw new Error("investigation wait aborted")
      if (lookedUp && clock.now() >= deadline) break
      await store.reconcile(entry.work_key, port)
      lookedUp = true
      if (options.signal?.aborted) throw new Error("investigation wait aborted")
    }
    const remaining = store.snapshot.work.filter((entry) => pending.has(entry.status) && (options.workKey === undefined || entry.work_key === options.workKey))
    if (!remaining.length) return { ready: true, blocked: [] }
    // A transport/lookup ambiguity isn't a long-running job. Do not spin against it.
    if (remaining.some((entry) => entry.status === "outcome_unknown" || entry.status === "submitting") || clock.now() >= deadline)
      return { ready: false, blocked: remaining.map(({ work_key, status }) => ({ work_key, status })) }
    await clock.sleep(Math.min(options.pollIntervalMs, Math.max(0, deadline - clock.now())), options.signal)
  }
}

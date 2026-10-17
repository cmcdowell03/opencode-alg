/** Tracks only chunks this plugin actually appended to a particular host array. */
export class OwnedContext {
  private readonly previous = new WeakMap<string[], { snapshot: string[]; start: number; count: number }>()
  private readonly active = new WeakSet<string[]>()

  async replace(target: string[], render: (working: string[]) => Promise<void>): Promise<void> {
    if (this.active.has(target)) throw new Error("ALG context delivery conflict: concurrent hook")
    this.active.add(target)
    try {
      const prior = this.previous.get(target)
      const startsWith = (value: string[], prefix: string[]) =>
        value.length >= prefix.length && prefix.every((text, index) => value[index] === text)
      // Later plugins may append anything, including identical text. Never search
      // for a matching body and delete it: only our recorded slots are ours.
      if (prior && !startsWith(target, prior.snapshot)) throw new Error("ALG context delivery conflict: owned slots changed")
      const snapshot = [...target]
      const base = [...snapshot]
      if (prior) base.splice(prior.start, prior.count)
      const working = [...base]
      await render(working)
      if (!startsWith(working, base) || !startsWith(target, snapshot)) {
        throw new Error("ALG context delivery conflict: foreign context changed")
      }
      const foreignAppend = target.slice(snapshot.length)
      const owned = working.slice(base.length)
      const start = base.length + foreignAppend.length
      target.splice(0, target.length, ...base, ...foreignAppend, ...owned)
      if (owned.length) this.previous.set(target, { snapshot: [...target], start, count: owned.length })
      else this.previous.delete(target)
    } finally {
      this.active.delete(target)
    }
  }
}

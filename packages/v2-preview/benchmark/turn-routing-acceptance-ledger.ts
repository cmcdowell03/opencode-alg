import assert from "node:assert/strict"
import { constants } from "node:fs"
import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileDigest, sha256 } from "../acceptance/runtime.ts"

async function ledgerFiles(directory: string, path = ".opencode/runs"): Promise<string[]> {
  const files: string[] = []
  const entries = await readdir(join(directory, path), { withFileTypes: true })
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const key = path + "/" + entry.name
    if (entry.isDirectory()) files.push(...await ledgerFiles(directory, key))
    else if (entry.isFile()) files.push(key)
    else assert.fail(`Unexpected ledger path ${key}`)
  }
  return files
}

export async function ledger(directory: string) {
  const paths = await ledgerFiles(directory)
  assert.ok(paths.some(path => path.endsWith("/journal.json") && path.includes("/source-evidence/")), "Source ledger was never created")
  const files = await Promise.all(paths.map(async path => [path, await fileDigest(join(directory, path))]))
  return { files: paths.length, sha256: sha256(JSON.stringify(files)) }
}

/** Observe file opens during the unrelated turn, excluding the harness's hash reads. */
export async function watchLedgerOpens(directory: string) {
  if (process.platform !== "linux") return { finish: () => ({ method: "unmeasured" as const }) }
  const { dlopen, ptr } = await import("bun:ffi")
  const library = dlopen("libc.so.6", {
    inotify_init1: { args: ["i32"], returns: "i32" },
    inotify_add_watch: { args: ["i32", "ptr", "u32"], returns: "i32" },
    read: { args: ["i32", "ptr", "u64"], returns: "i64" },
    close: { args: ["i32"], returns: "i32" },
  })
  const native = library.symbols
  // Default inotify_event records start with wd/mask/cookie/len, all 32-bit.
  const openMask = 0x20
  const overflowMask = 0x4000
  const paths = new Map<number, string>()
  const fd = native.inotify_init1(constants.O_NONBLOCK | 0x80000) // IN_CLOEXEC
  function close() {
    if (fd >= 0) native.close(fd)
    library.close()
  }
  try {
    assert.ok(fd >= 0, "Could not initialize Linux inotify")
    for (const path of await ledgerFiles(directory)) {
      const watch = native.inotify_add_watch(fd, ptr(Buffer.from(join(directory, path) + "\0")), openMask)
      assert.ok(watch >= 0 && !paths.has(watch), `Could not track ledger inode: ${path}`)
      paths.set(watch, path)
    }
    assert.ok([...paths.values()].some(path => path.endsWith("/investigation/head.json")))
  } catch (error) {
    close()
    throw error
  }
  return {
    finish() {
      const opened = new Set<string>()
      const events = Buffer.alloc(16384)
      try {
        let bytes: number
        while ((bytes = Number(native.read(fd, ptr(events), events.length))) > 0) {
          for (let offset = 0; offset < bytes;) {
            const mask = events.readUInt32LE(offset + 4)
            assert.equal(mask & overflowMask, 0, "Linux inotify queue overflowed")
            if (mask & openMask) {
              const path = paths.get(events.readInt32LE(offset))
              assert.ok(path, "Unknown ledger watch")
              opened.add(path)
            }
            offset += 16 + events.readUInt32LE(offset + 12)
          }
        }
        return { method: "linux-inotify" as const, watchedFiles: paths.size, openedPaths: [...opened].sort() }
      } finally { close() }
    },
  }
}

import { appendFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, rmdirSync, symlinkSync, truncateSync, writeFileSync } from "node:fs"
import { open } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import { join, basename } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, expect, test } from "bun:test"
import { inventoryDeploymentTree, inventoryDeploymentTreeAsync, type AsyncInventoryOptions, type InventoryReadHandle } from "../scripts/deployment.ts"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(count = 12) {
  const root = mkdtempSync(join(tmpdir(), "alg-async-"))
  roots.push(root)
  mkdirSync(join(root, "empty"))
  for (let i = 0; i < count; i++) writeFileSync(join(root, `${i.toString().padStart(2, "0")}.bin`), Buffer.alloc(70_003 + i, i))
  return root
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
function observedOpen(wrap?: (handle: InventoryReadHandle, path: string) => InventoryReadHandle) {
  const stats = { opened: 0, closed: 0, live: 0, peak: 0, largestBuffer: 0, flags: [] as number[] }
  const opener: NonNullable<AsyncInventoryOptions["open"]> = async (path, flags) => {
    const file = await open(path, flags)
    stats.opened++; stats.live++; stats.peak = Math.max(stats.peak, stats.live); stats.flags.push(flags)
    const handle: InventoryReadHandle = {
      stat: () => file.stat({ bigint: true }),
      read: async (buffer, length, position) => {
        stats.largestBuffer = Math.max(stats.largestBuffer, buffer.length)
        return (await file.read(buffer, 0, length, position)).bytesRead
      },
      close: async () => { try { await file.close() } finally { stats.closed++; stats.live-- } },
    }
    return wrap ? wrap(handle, path) : handle
  }
  return { opener, stats }
}

test("bounded asynchronous readers retain exact ordering, partial-read bytes and empty files", async () => {
  const root = fixture()
  writeFileSync(join(root, "zero"), "")
  writeFileSync(join(root, "alg-bundle.json"), "excluded manifest")
  const completed: string[] = []
  const io = observedOpen((handle, path) => ({ ...handle,
    read: async (buffer, length, position) => {
      if (position === 0) await delay(basename(path) === "00.bin" ? 35 : 1)
      return handle.read(buffer, Math.min(length, 4093), position)
    },
    close: async () => { await handle.close(); completed.push(basename(path)) },
  }))
  expect(await inventoryDeploymentTreeAsync(root, true, { open: io.opener })).toEqual(inventoryDeploymentTree(root, true))
  expect(completed[0]).not.toBe("00.bin")
  expect(io.stats.peak).toBe(4)
  expect(io.stats.largestBuffer).toBe(64 * 1024)
  expect(io.stats.opened).toBe(13)
  expect(io.stats.closed).toBe(io.stats.opened)
  expect(io.stats.live).toBe(0)
})

test("rejects escaping links and redirected root before opening files", async () => {
  const root = fixture(1), outside = fixture(1)
  symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir")
  const io = observedOpen()
  await expect(inventoryDeploymentTreeAsync(root, false, { open: io.opener })).rejects.toThrow(/escapes/)
  await expect(inventoryDeploymentTreeAsync(join(root, "escape"), false, { open: io.opener })).rejects.toThrow(/direct directory/)
  expect(io.stats.opened).toBe(0)
})

test.skipIf(process.platform === "win32")("records contained links exactly and rejects file-to-link replacement", async () => {
  const root = fixture(2)
  symlinkSync("00.bin", join(root, "link"))
  expect(await inventoryDeploymentTreeAsync(root)).toEqual(inventoryDeploymentTree(root))
  let changed = false
  const io = observedOpen((handle, path) => ({ ...handle,
    read: async (...args) => {
      if (!changed) { changed = true; renameSync(path, `${path}.saved`); symlinkSync("01.bin", path) }
      return handle.read(...args)
    },
  }))
  await expect(inventoryDeploymentTreeAsync(root, false, { open: io.opener })).rejects.toThrow(/changed|redirected/)
  expect(io.stats.live).toBe(0)
})

for (const mutation of ["tamper", "grow", "truncate", "replace", "extra", "remove"] as const) {
  test(`rejects ${mutation} during awaited reads and closes all handles`, async () => {
    const root = fixture(2)
    let changed = false
    const io = observedOpen((handle, path) => ({ ...handle,
      read: async (...args) => {
        const count = await handle.read(...args)
        if (!changed && basename(path) === "00.bin") {
          changed = true
          if (mutation === "tamper") writeFileSync(path, Buffer.alloc(Number(lstatSync(path).size), 7))
          if (mutation === "grow") appendFileSync(path, "growth")
          if (mutation === "truncate") truncateSync(path, 1)
          if (mutation === "extra") writeFileSync(join(root, "new-file"), "unexpected")
          if (mutation === "remove") rmdirSync(join(root, "empty"))
        }
        return count
      },
      close: async () => {
        await handle.close()
        if (mutation === "replace" && basename(path) === "00.bin") {
          const bytes = readFileSync(path)
          renameSync(path, `${path}.saved`)
          writeFileSync(path, bytes)
        }
      },
    }))
    await expect(inventoryDeploymentTreeAsync(root, false, { open: io.opener })).rejects.toThrow(/changed|grew|ENOENT/)
    expect(changed).toBe(true)
    expect(io.stats.live).toBe(0)
    expect(io.stats.closed).toBe(io.stats.opened)
  })
}

test("first read failure stops scheduling, drains started workers and closes every descriptor", async () => {
  const root = fixture()
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const io = observedOpen((handle, path) => {
    if (io.stats.opened === 4) release()
    return { ...handle,
      stat: async () => { await ready; return handle.stat() },
      read: async (...args) => {
        if (basename(path) === "00.bin") throw new Error("injected read failure")
        await delay(10)
        return handle.read(...args)
      },
    }
  })
  await expect(inventoryDeploymentTreeAsync(root, false, { open: io.opener })).rejects.toThrow("injected read failure")
  expect(io.stats.opened).toBe(4)
  expect(io.stats.closed).toBe(4)
  expect(io.stats.live).toBe(0)
})

test("open and close errors fail closed after other workers drain", async () => {
  for (const stage of ["open", "close"]) {
    const root = fixture()
    const io = observedOpen(handle => ({ ...handle, close: async () => { await handle.close(); if (stage === "close") throw new Error("injected close") } }))
    const opener: NonNullable<AsyncInventoryOptions["open"]> = async (path, flags) => {
      if (stage === "open" && basename(path) === "00.bin") throw new Error("injected open")
      return io.opener(path, flags)
    }
    await expect(inventoryDeploymentTreeAsync(root, false, { open: opener })).rejects.toThrow(`injected ${stage}`)
    expect(io.stats.closed).toBe(io.stats.opened)
    expect(io.stats.live).toBe(0)
  }
})

test.skipIf(process.platform === "win32")("a file replaced by a FIFO before open fails without blocking", async () => {
  const root = fixture(1)
  const io = observedOpen()
  await expect(inventoryDeploymentTreeAsync(root, false, { open: async (path, flags) => {
    rmSync(path)
    const result = spawnSync("mkfifo", [path], { encoding: "utf8", timeout: 1000 })
    if (result.status !== 0) throw new Error(`FIFO fixture failed: ${result.stderr}`)
    return io.opener(path, flags)
  } })).rejects.toThrow(/changed before read/)
  expect(io.stats.opened).toBe(1)
  expect(io.stats.closed).toBe(1)
}, 5000)

test("shared traversal retains size and ambiguous-name bounds; concurrency cannot be unbounded", async () => {
  const root = fixture(1)
  truncateSync(join(root, "00.bin"), 64 * 1024 * 1024 + 1)
  const io = observedOpen()
  expect(() => inventoryDeploymentTree(root)).toThrow(/bounds/)
  await expect(inventoryDeploymentTreeAsync(root, false, { open: io.opener })).rejects.toThrow(/bounds/)
  expect(io.stats.opened).toBe(0)
  for (const concurrency of [0, 9, 1.5, Infinity]) await expect(inventoryDeploymentTreeAsync(root, false, { concurrency })).rejects.toThrow(/concurrency/)
  const ambiguous = fixture(0)
  writeFileSync(join(ambiguous, "é"), "one")
  writeFileSync(join(ambiguous, "e\u0301"), "two")
  expect(() => inventoryDeploymentTree(ambiguous)).toThrow(/ambiguous/)
  await expect(inventoryDeploymentTreeAsync(ambiguous)).rejects.toThrow(/ambiguous/)
})

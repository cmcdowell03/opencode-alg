import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { hostname } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import {
  acquireFilesystemMutex,
  FilesystemMutexRecordSchema,
} from "../src/filesystem-mutex.ts"
import { removeProject, tempProject } from "./helpers.ts"

function record(path: string, pid: number, expiresOffsetMs: number) {
  const now = Date.now()
  return {
    version: 1,
    owner: "crashed-writer",
    token: randomUUID(),
    pid,
    host: hostname(),
    resource: path,
    acquired_at: new Date(now - 2_000).toISOString(),
    expires_at: new Date(now + expiresOffsetMs).toISOString(),
  }
}

describe("restart-safe short filesystem mutexes", () => {
  test("automatic heartbeat protects a long critical section beyond the short lease", async () => {
    const project = tempProject("alg-mutex-heartbeat-")
    try {
      const path = join(project, "heartbeat.lock")
      const held = acquireFilesystemMutex(path, {
        owner: "long-critical-section",
        leaseMs: 120,
        heartbeatMs: 30,
      })
      const initialExpiry = JSON.parse(readFileSync(path, "utf8")).expires_at
      await Bun.sleep(360)
      const renewedExpiry = JSON.parse(readFileSync(path, "utf8")).expires_at
      expect(Date.parse(renewedExpiry)).toBeGreaterThan(Date.parse(initialExpiry))
      expect(() => acquireFilesystemMutex(path, {
        owner: "stale-competitor",
        leaseMs: 120,
        isPidAlive: () => false,
      })).toThrow(/held by a live, unexpired/)
      expect(readdirSync(project).some((name) => name.includes("stale-"))).toBe(false)
      held.release()
      expect(existsSync(path)).toBe(false)
    } finally {
      removeProject(project)
    }
  })

  test("execution guard, mirror, and model locks recover only expired proven-dead owners", () => {
    const project = tempProject("alg-mutex-")
    try {
      const run = join(project, ".opencode", "runs", "run")
      mkdirSync(run, { recursive: true })
      const paths = [
        join(run, "execution.lock.guard"),
        join(run, "mirror.lock"),
        join(project, ".opencode", "alg-models.lock"),
      ]
      for (const path of paths) {
        const stale = FilesystemMutexRecordSchema.parse(record(path, 999_999_999, -1_000))
        writeFileSync(path, `${JSON.stringify(stale, null, 2)}\n`, "utf8")
        const lock = acquireFilesystemMutex(path, {
          owner: "restart",
          leaseMs: 1_000,
          isPidAlive: () => false,
        })
        const current = FilesystemMutexRecordSchema.parse(JSON.parse(readFileSync(path, "utf8")))
        expect(current).toMatchObject({
          owner: "restart",
          pid: process.pid,
          host: hostname(),
          resource: path,
        })
        expect(Date.parse(current.expires_at)).toBeGreaterThan(Date.parse(current.acquired_at))
        expect(readdirSync(join(path, "..")).some((name) => name.startsWith(`${path.split(/[\\/]/).at(-1)}.stale-`))).toBe(true)
        lock.release()
        expect(existsSync(path)).toBe(false)
      }
    } finally {
      removeProject(project)
    }
  })

  test("expired live owners and malformed or remote owners fail closed", () => {
    const project = tempProject("alg-mutex-deny-")
    try {
      const path = join(project, "mutex.lock")
      const live = FilesystemMutexRecordSchema.parse(record(path, process.pid, -1_000))
      writeFileSync(path, `${JSON.stringify(live)}\n`, "utf8")
      expect(() => acquireFilesystemMutex(path, {
        owner: "competitor",
        isPidAlive: () => true,
      })).toThrow(/live, unexpired, remote, or unverifiable/)
      expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(live.token)

      writeFileSync(path, "{malformed", "utf8")
      expect(() => acquireFilesystemMutex(path, { owner: "competitor" }))
        .toThrow(/malformed or unverifiable.*failing closed/)
      expect(readFileSync(path, "utf8")).toBe("{malformed")

      const remote = { ...record(path, 999_999_999, -1_000), host: "other-host.invalid" }
      writeFileSync(path, `${JSON.stringify(remote)}\n`, "utf8")
      expect(() => acquireFilesystemMutex(path, {
        owner: "competitor",
        isPidAlive: () => false,
      })).toThrow(/remote, or unverifiable/)
      expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(remote.token)
    } finally {
      removeProject(project)
    }
  })

  test("renew CAS cannot overwrite a replacement installed at the commit gap", () => {
    const project = tempProject("alg-mutex-renew-cas-")
    try {
      const path = join(project, "mutex.lock")
      const replacement = FilesystemMutexRecordSchema.parse(record(path, process.pid, 5_000))
      const held = acquireFilesystemMutex(path, {
        owner: "original",
        leaseMs: 1_000,
        heartbeatMs: 900,
        beforeRenewCommit() {
          writeFileSync(path, `${JSON.stringify(replacement, null, 2)}\n`, "utf8")
        },
      })
      expect(() => held.renew()).toThrow(/token changed before renew commit/)
      expect(FilesystemMutexRecordSchema.parse(JSON.parse(readFileSync(path, "utf8"))).token)
        .toBe(replacement.token)
      held.release()
      expect(FilesystemMutexRecordSchema.parse(JSON.parse(readFileSync(path, "utf8"))).token)
        .toBe(replacement.token)
    } finally {
      removeProject(project)
    }
  })

  test("release CAS cannot delete a replacement installed at the remove gap", () => {
    const project = tempProject("alg-mutex-release-cas-")
    try {
      const path = join(project, "mutex.lock")
      const replacement = FilesystemMutexRecordSchema.parse(record(path, process.pid, 5_000))
      const held = acquireFilesystemMutex(path, {
        owner: "original",
        leaseMs: 1_000,
        heartbeatMs: 900,
        beforeReleaseRemove() {
          writeFileSync(path, `${JSON.stringify(replacement, null, 2)}\n`, "utf8")
        },
      })
      held.release()
      expect(existsSync(path)).toBe(true)
      expect(FilesystemMutexRecordSchema.parse(JSON.parse(readFileSync(path, "utf8"))).token)
        .toBe(replacement.token)
    } finally {
      removeProject(project)
    }
  })
})

import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { runSmoke } from "../scripts/smoke.ts"

describe("offline smoke temporary project cleanup", () => {
  test("removes the exact smoke project after a successful full dry verification", async () => {
    let temporaryProject = ""
    const result = await runSmoke({
      log: () => {},
      onTemporaryProjectRemoved: (path) => {
        temporaryProject = path
        expect(existsSync(path)).toBe(false)
      },
    })

    expect(temporaryProject).not.toBe("")
    expect(result).toEqual({
      temporary_project: temporaryProject,
      temporary_project_removed: true,
    })
    expect(existsSync(temporaryProject)).toBe(false)
  }, 60_000)

  test("removes the exact smoke project when an injected post-verification failure is thrown", async () => {
    let temporaryProject = ""
    const failure = new Error("injected smoke failure after full verification")

    await expect(runSmoke({
      log: () => {},
      afterVerification: () => { throw failure },
      onTemporaryProjectRemoved: (path) => {
        temporaryProject = path
        expect(existsSync(path)).toBe(false)
      },
    })).rejects.toBe(failure)

    expect(temporaryProject).not.toBe("")
    expect(existsSync(temporaryProject)).toBe(false)
  }, 60_000)
})

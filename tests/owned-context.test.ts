import { expect, test } from "bun:test"
import { OwnedContext } from "../src/owned-context.ts"

test("replaces only recorded ALG slots and preserves identical foreign text", async () => {
  const writer = new OwnedContext(), shared = ["host", "same skill text"]
  await writer.replace(shared, async (working) => { working.push("same skill text", "old") })
  shared.push("same skill text")
  await writer.replace(shared, async (working) => {
    expect(working).toEqual(["host", "same skill text", "same skill text"])
    working.push("new")
  })
  expect(shared).toEqual(["host", "same skill text", "same skill text", "new"])
  await writer.replace(shared, async () => {})
  expect(shared).toEqual(["host", "same skill text", "same skill text"])
})

test("a failed preparation leaves the shared array and previous ownership intact", async () => {
  const writer = new OwnedContext(), shared = ["host"]
  await writer.replace(shared, async (working) => { working.push("old") })
  await expect(writer.replace(shared, async (working) => { working.push("partial"); throw new Error("failed") })).rejects.toThrow("failed")
  expect(shared).toEqual(["host", "old"])
  await writer.replace(shared, async (working) => { working.push("new") })
  expect(shared).toEqual(["host", "new"])
})

test("foreign appends during preparation survive, but conflicting edits are not guessed away", async () => {
  const writer = new OwnedContext(), shared = ["host"]
  await writer.replace(shared, async (working) => { shared.push("foreign"); working.push("ALG") })
  expect(shared).toEqual(["host", "foreign", "ALG"])
  shared.unshift("inserted")
  await expect(writer.replace(shared, async (working) => { working.push("new") })).rejects.toThrow("owned slots changed")
  expect(shared).toEqual(["inserted", "host", "foreign", "ALG"])
  const fresh = ["host"]
  await expect(writer.replace(fresh, async (working) => { fresh[0] = "changed"; working.push("ALG") })).rejects.toThrow("foreign context changed")
  expect(fresh).toEqual(["changed"])
})

test("concurrent hooks cannot both publish to the same array", async () => {
  const writer = new OwnedContext(), shared = ["host"]
  let release!: () => void
  const pending = writer.replace(shared, async (working) => {
    await new Promise<void>((resolve) => { release = resolve })
    working.push("ALG")
  })
  await expect(writer.replace(shared, async () => {})).rejects.toThrow("concurrent hook")
  release()
  await pending
  expect(shared).toEqual(["host", "ALG"])
})

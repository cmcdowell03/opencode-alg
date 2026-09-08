import { describe, expect, spyOn, test } from "bun:test"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { runDataScienceProject } from "../scripts/datascience-project.ts"
import { tempProject, removeProject } from "./helpers.ts"

describe("Data Science receipt lifecycle", () => {
  test("enable is receipt-owned, default-off MCP, and uninstall preserves the prepared interpreter", () => {
    const project = tempProject("alg-datascience-owned-")
    const python = join(project, "python.exe")
    writeFileSync(python, "synthetic prepared runtime")
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      runDataScienceProject(["status", "--project", project])
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ configured: false, enabled: false, mcp: false })
      runDataScienceProject(["enable", "--project", project, "--python", python])
      const receiptPath = join(project, ".opencode", "alg-datascience.receipt.json")
      const receipt = JSON.parse(readFileSync(receiptPath, "utf8"))
      expect(receipt).toMatchObject({ schema_version: 1, project, enabled: true, python })
      expect("mcp" in receipt).toBe(false)
      expect(existsSync(join(project, "opencode.json"))).toBe(false)
      expect(existsSync(join(project, "opencode.jsonc"))).toBe(false)
      runDataScienceProject(["doctor", "--project", project])
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0])).mcp).toBe(false)
      runDataScienceProject(["disable", "--project", project])
      expect(JSON.parse(readFileSync(receiptPath, "utf8")).enabled).toBe(false)
      runDataScienceProject(["uninstall", "--project", project])
      expect(existsSync(receiptPath)).toBe(false)
      expect(existsSync(python)).toBe(true)
    } finally { log.mockRestore(); removeProject(project) }
  })

  test("rejects interpreters inside the package tree and preserves a corrupt receipt", () => {
    const project = tempProject("alg-datascience-reject-")
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      const packed = join(import.meta.dir, "..", "capabilities", "datascience", "runner.py")
      expect(() => runDataScienceProject(["enable", "--project", project, "--python", packed])).toThrow("outside")
      const receiptPath = join(project, ".opencode", "alg-datascience.receipt.json")
      expect(existsSync(receiptPath)).toBe(false)
      writeFileSync(join(project, "python.exe"), "synthetic")
      runDataScienceProject(["enable", "--project", project, "--python", join(project, "python.exe")])
      writeFileSync(receiptPath, "{\"tampered\":true}\n")
      expect(() => runDataScienceProject(["uninstall", "--project", project])).toThrow("preserved")
      expect(readFileSync(receiptPath, "utf8")).toBe("{\"tampered\":true}\n")
    } finally { log.mockRestore(); removeProject(project) }
  })
})

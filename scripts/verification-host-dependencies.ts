import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs"
import { join } from "node:path"

/** Test-only bootstrap of a new isolated config directory from the exact tested package. */
export function seedVerificationHostDependencies(directory: string, packageRoot: string): void {
  mkdirSync(directory, { recursive: true })
  for (const name of ["package.json", "package-lock.json", "node_modules"])
    if (existsSync(join(directory, name))) throw new Error("verification dependency destination must be fresh")
  const pkg = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"))
  const lock = JSON.parse(readFileSync(join(packageRoot, "package-lock.json"), "utf8"))
  const installed = JSON.parse(readFileSync(join(packageRoot, "node_modules", "@opencode-ai", "plugin", "package.json"), "utf8"))
  if (pkg.dependencies?.["@opencode-ai/plugin"] !== installed.version ||
      lock.packages?.[""].dependencies?.["@opencode-ai/plugin"] !== installed.version)
    throw new Error("verification host SDK differs from the tested dependency lock")
  copyFileSync(join(packageRoot, "package.json"), join(directory, "package.json"), constants.COPYFILE_EXCL)
  copyFileSync(join(packageRoot, "package-lock.json"), join(directory, "package-lock.json"), constants.COPYFILE_EXCL)
  symlinkSync(join(packageRoot, "node_modules"), join(directory, "node_modules"), process.platform === "win32" ? "junction" : "dir")
}

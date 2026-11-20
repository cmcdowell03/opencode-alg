import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

export const nativeLimits = {
  calls: 24,
  requestBytes: 192 * 1024,
  responseBytes: 384 * 1024,
  armRequestBytes: 1024 * 1024,
  armResponseBytes: 4 * 1024 * 1024,
  outputTokens: 1024,
  outputDeltaBytes: 4096,
  armOutputTokens: 12_000,
  requestMs: 45_000,
  armMs: 300_000,
} as const

export function nativeModel(value: string) {
  const id = /^openai\/([a-z0-9][a-z0-9._-]{0,95})$/i.exec(value)?.[1]
  if (!id || !value.startsWith("openai/")) throw new Error("Native benchmark requires an explicit openai/ model ID")
  return { providerID: "openai" as const, id }
}

export function nativeProviderConfig(context: number, id: string) {
  nativeModel("openai/" + id)
  if (!Number.isSafeInteger(context) || context < 8192 || context > 32768)
    throw new Error("Invalid native benchmark compaction context window")
  return {
    openai: {
      settings: { transport: "http", encoding: "none", compaction: { type: "summary" },
        timeout: nativeLimits.requestMs, headerTimeout: nativeLimits.requestMs, chunkTimeout: nativeLimits.requestMs },
      models: { [id]: { settings: { compaction: { type: "summary" }, encoding: "none" },
        limit: { context, output: nativeLimits.outputTokens } } },
    },
  }
}

function inside(parent: string, target: string) {
  const path = relative(parent, target)
  return !!path && !isAbsolute(path) && path !== ".." && !path.startsWith(".." + sep)
}

export function accessOnlyCredential(value: unknown, now = Date.now()) {
  const row = value && typeof value === "object" && "openai" in value ? value.openai : undefined
  if (!row || typeof row !== "object" || !("type" in row) || row.type !== "oauth" ||
      !("access" in row) || typeof row.access !== "string" || !/^[!-~]{1,16384}$/.test(row.access) ||
      !("expires" in row) || typeof row.expires !== "number" || !Number.isSafeInteger(row.expires) ||
      row.expires <= now + 15 * 60_000)
    throw new Error("Native OpenAI OAuth unavailable or too close to expiry")
  const accountId = "accountId" in row ? row.accountId : undefined
  if (accountId !== undefined && (typeof accountId !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(accountId)))
    throw new Error("Native OpenAI account selector invalid")
  return { openai: { type: "oauth", access: row.access, expires: row.expires, refresh: "",
    ...(accountId === undefined ? {} : { accountId }) } }
}

export async function stageNativeCredential(env: NodeJS.ProcessEnv,
  authPath = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "opencode", "auth.json")) {
  if (!env.XDG_DATA_HOME || !env.OPENCODE_DB || !isAbsolute(env.OPENCODE_DB))
    throw new Error("Native benchmark requires isolated temp data and DB paths")
  const temp = await realpath(tmpdir())
  const repo = await realpath(fileURLToPath(new URL("../../../", import.meta.url)))
  const data = await realpath(env.XDG_DATA_HOME)
  const dbDir = await realpath(dirname(env.OPENCODE_DB))
  if (!inside(temp, data) || data === repo || inside(repo, data) || dbDir !== data || !inside(data, env.OPENCODE_DB))
    throw new Error("Native credential staging requires per-user OS temp")
  const db = await lstat(env.OPENCODE_DB).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error
  })
  if (db && (!db.isFile() || db.nlink !== 1)) throw new Error("Native benchmark DB must be private")
  const directory = join(data, "opencode")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (await realpath(directory) !== directory)
    throw new Error("Native benchmark credential directory must be private")
  let value: unknown
  try {
    value = JSON.parse(await readFile(authPath, "utf8"))
  } catch {
    throw new Error("Native OpenAI host sign-in unavailable")
  }
  await writeFile(join(directory, "auth.json"), JSON.stringify(accessOnlyCredential(value)), { flag: "wx", mode: 0o600 })
}

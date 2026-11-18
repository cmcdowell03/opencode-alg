import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdir, readdir } from "node:fs/promises"
import { arch, hostname, platform, release } from "node:os"
import { join, resolve } from "node:path"

export const PIN = "2.3.2"
export const sha256 = (text: string) => createHash("sha256").update(text).digest("hex")

export async function fileDigest(path: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest("hex")
}

async function bundleManifest(root: string, prefix = ""): Promise<[string, string][]> {
  const files: [string, string][] = []
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const key = prefix ? `${prefix}/${name}` : name
    const path = join(root, key)
    const entry = await lstat(path)
    if (entry.isDirectory()) files.push(...await bundleManifest(root, key))
    else if (entry.isFile()) files.push([key, await fileDigest(path)])
    else throw new Error(`Non-regular bundle entry: ${key}`)
  }
  return files
}

export async function runtimeIdentity(binary: string, bundle: string, version: string) {
  const manifest = await bundleManifest(bundle)
  if (!manifest.some(([name]) => name === "package.json") || !manifest.some(([name]) => name === "dist/index.js"))
    throw new Error("Expected a staged preview package with package.json and dist/index.js")
  return {
    version, binarySha256: await fileDigest(binary), packageSha256: sha256(JSON.stringify(manifest)),
    bundleSha256: manifest.find(([name]) => name === "dist/index.js")![1],
    manifestFiles: manifest.length, host: { platform: platform(), arch: arch(), release: release(), hostname: hostname() },
  }
}

export async function isolate(root: string): Promise<NodeJS.ProcessEnv> {
  const home = join(root, "home"), temp = join(root, "temp")
  const dirs = {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"), XDG_CACHE_HOME: join(root, "cache"), XDG_RUNTIME_DIR: join(root, "runtime"),
    TMPDIR: temp, TMP: temp, TEMP: temp,
  }
  await Promise.all(Object.values(dirs).map(path => mkdir(path, { recursive: true, mode: 0o700 })))
  const env: NodeJS.ProcessEnv = {
    ...dirs,
    OPENCODE_DB: join(root, "data", "opencode.db"),
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_PROJECT_CONFIG: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_DISABLE_FILEWATCHER: "1", OPENCODE_DISABLE_FREE_MODELS: "1",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "isolated.gitconfig"),
    OPENCODE_DISABLE_TERMINAL_TITLE: "1", OPENCODE_DISABLE_SHARE: "1",
    NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost",
    PATH: platform() === "win32"
      ? join(process.env.SystemRoot ?? "C:/Windows", "System32") : "/usr/bin:/bin",
  }
  if (platform() === "win32") {
    env.SystemRoot = process.env.SystemRoot ?? "C:/Windows"
    env.ComSpec = join(env.SystemRoot, "System32", "cmd.exe")
    env.HOMEDRIVE = resolve(home).slice(0, 2)
    env.HOMEPATH = resolve(home).slice(2)
  }
  return env
}

export function launch(binary: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const child = spawn(binary, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
  let log = ""
  const capture = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-4096) }
  child.stdout.on("data", capture)
  child.stderr.on("data", capture)
  let exited = false
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>(resolve => {
    child.once("error", (error: NodeJS.ErrnoException) => { exited = true; resolve({ code: null, signal: null, error: error.code ?? error.name }) })
    child.once("close", (code, signal) => { exited = true; resolve({ code, signal }) })
  })
  return {
    pid: child.pid, done, log: () => log, exited: () => exited,
    kill: async () => {
      const signalled = !exited && child.kill("SIGKILL")
      const result = await withTimeout(done, 5_000, "Host did not exit after kill")
      return { signalled, ...result }
    },
  }
}

export async function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    })])
  } finally {
    clearTimeout(timer)
  }
}

export async function waitFor<T>(observe: () => Promise<T | undefined>, ms: number, message: string): Promise<T> {
  const end = performance.now() + ms
  do {
    const result = await observe()
    if (result !== undefined) return result
    await Bun.sleep(100)
  } while (performance.now() < end)
  throw new Error(message)
}

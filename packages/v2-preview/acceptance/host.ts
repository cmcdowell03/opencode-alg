import { randomBytes, randomUUID } from "node:crypto"
import { mkdir, realpath, writeFile } from "node:fs/promises"
import { delimiter, dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { OpenCode, type SessionMessageInfo } from "@opencode/client"
import type { InvestigationAdapter } from "../../../src/operational-options.ts"
import { approvedJob } from "./service.ts"
import { isolate, launch, PIN, waitFor, withTimeout } from "./runtime.ts"

export const model = { id: "fixture", providerID: "fixture-local" }
export const owner = "build"
export const checker = "alg-investigation-checker"
export const algTool = "alg_investigation"
export const checkerRules = [
  { action: "*", resource: "*", effect: "deny" },
  { action: algTool, resource: "*", effect: "allow" },
] as const
type Client = ReturnType<typeof OpenCode.make>

export async function fixtureProject(root: string, name: string) {
  const directory = join(root, name)
  await mkdir(directory, { recursive: true })
  const git = Bun.which("git")
  if (!git) throw new Error("Git is required for isolated fixture project identity")
  const env = await isolate(join(root, `${name}-git-env`))
  const process = launch(git, ["init", "--quiet"], directory, env)
  const result = await withTimeout(process.done, 5_000, "Fixture git init timed out").catch(async error => {
    await process.kill()
    throw error
  })
  if (result.code !== 0) throw new Error("Fixture git init failed")
  // OpenCode 2.3.2 reads this cached project identity from the common Git directory.
  const id = randomUUID().replaceAll("-", "")
  await writeFile(join(directory, ".git", "opencode"), id + "\n", { flag: "wx" })
  return { directory: await realpath(directory), id }
}

export async function hostVersion(binary: string, isolatedRoot: string) {
  const env = await isolate(isolatedRoot)
  const process = launch(binary, ["--version"], isolatedRoot, env)
  const result = await withTimeout(process.done, 12_000, "OpenCode --version timed out").catch(async error => {
    await process.kill()
    throw error
  })
  if (result.code !== 0 || !process.log().split(/\r?\n/).some(line => /^(?:opencode )?v?2\.3\.2$/.test(line.trim())))
    throw new Error(`Expected native OpenCode ${PIN} from --version`)
  return PIN
}

export async function hostSettings(root: string, provider: string, bundle?: string, adapter?: InvestigationAdapter) {
  const env = await isolate(root)
  const git = Bun.which("git")
  if (git) env.PATH = [dirname(git), env.PATH].join(delimiter)
  const password = randomBytes(24).toString("hex")
  const config = {
    model: `${model.providerID}/${model.id}`, default_agent: owner, update: "disable", share: "disabled",
    snapshots: false, warming: false, compaction: { auto: false },
    providers: {
      [model.providerID]: {
        package: "@opencode/ai/providers/openai-compatible", name: "Loopback acceptance fixture",
        settings: { baseURL: provider }, models: { [model.id]: { name: "Fixture", type: "chat",
          limit: { context: 32768, output: 1024 }, capabilities: { tools: true } } },
      },
    },
    permissions: [{ action: "*", resource: "*", effect: "deny" }],
    agents: {
      [owner]: { mode: "primary", permissions: bundle ? checkerRules : [{ action: "*", resource: "*", effect: "deny" }] },
      ...(bundle && { [checker]: { mode: "subagent", permissions: checkerRules } }),
    },
    plugins: bundle ? [{
      package: pathToFileURL(bundle).href,
      options: { enabled: true, ownerAgent: owner, checkerAgent: checker, adapter, approvedJob },
    }] : [],
  }
  const path = join(root, "opencode.json")
  await writeFile(path, JSON.stringify(config))
  return { env: { ...env, OPENCODE_CONFIG: path, OPENCODE_CONFIG_DIR: env.XDG_CONFIG_HOME,
    OPENCODE_SERVER_PASSWORD: password, OPENCODE_PASSWORD: password },
    headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` } }
}

export async function startHost(binary: string, project: string, settings: Awaited<ReturnType<typeof hostSettings>>) {
  const reserve = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } })
  const port = reserve.port
  reserve.stop(true)
  const process = launch(binary, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], project, settings.env)
  const endpoint = `http://127.0.0.1:${port}`
  const clientFor = (directory: string): Client => OpenCode.make({ baseUrl: endpoint, headers: {
    ...settings.headers, "x-opencode-directory": encodeURIComponent(directory),
  } })
  const client = clientFor(project)
  try {
    const info = await waitFor(async () => {
      if (process.exited()) throw new Error("OpenCode serve exited during startup")
      const observed = await client.server.info({ signal: AbortSignal.timeout(500) }).catch(() => undefined)
      if (!observed) return undefined
      if (observed.version !== PIN || observed.pid !== process.pid) throw new Error("OpenCode HTTP runtime identity mismatch")
      return observed
    }, 20_000, "OpenCode serve did not reach readiness")
    return { process, info, client, clientFor }
  } catch (error) {
    await process.kill()
    throw error
  }
}

export function requestOptions(ms = 10_000) { return { signal: AbortSignal.timeout(ms) } }

export async function transcript(client: Client, sessionID: string) {
  const rows: SessionMessageInfo[] = []
  const ids = new Set<string>(), cursors = new Set<string>()
  let cursor: string | undefined
  for (let i = 0; i < 4; i++) {
    const page = await client.message.list({ sessionID, limit: 64, ...(cursor ? { cursor } : { order: "asc" }) }, requestOptions())
    for (const row of page.data) {
      if (ids.has(row.id)) throw new Error("Host transcript cursor repeated a message")
      ids.add(row.id)
      rows.push(row)
    }
    if (page.data.length < 64 || !page.cursor.next) return rows
    cursor = page.cursor.next
    if (cursors.has(cursor)) throw new Error("Host transcript cursor did not progress")
    cursors.add(cursor)
  }
  throw new Error("Fixture transcript exceeded page bound")
}

export async function afterPrompt(client: Client, sessionID: string, marker: string, ms = 20_000) {
  return waitFor(async () => {
    const rows = await transcript(client, sessionID)
    const index = rows.findIndex(row => row.type === "user" && row.text.includes(marker))
    if (index < 0) return undefined
    const turn = rows.slice(index + 1)
    const idle = turn.findIndex(row => row.type === "idle")
    return idle < 0 ? undefined : turn.slice(0, idle + 1)
  }, ms, "No durable idle marker after fixture prompt")
}

export function toolCalls(messages: readonly SessionMessageInfo[]) {
  return messages.flatMap(message => message.type === "assistant"
    ? message.content.filter(item => item.type === "tool") : [])
}

export function receiptsFor(messages: readonly SessionMessageInfo[], action: string) {
  const calls = toolCalls(messages).filter(call => call.name === algTool &&
    "input" in call.state && asObject(call.state.input)?.action === action)
  return calls.flatMap(call => {
    if (call.state.status !== "completed") return []
    const text = call.state.content.find(part => part.type === "text")?.text
    const value = text && parseObject(text)
    const input = asObject(call.state.input)
    return value && input ? [{ value, input, id: call.id }] : []
  })
}

export function receiptFor(messages: readonly SessionMessageInfo[], action: string) {
  const receipts = receiptsFor(messages, action)
  return receipts.length === 1 ? receipts[0] : undefined
}

export function parseObject(text: string): Record<string, unknown> | undefined {
  try { return asObject(JSON.parse(text)) } catch { return undefined }
}
export function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

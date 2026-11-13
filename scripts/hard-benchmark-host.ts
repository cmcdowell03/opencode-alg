import {
  HardBenchmarkService, LostAcknowledgementError, SourceUnavailableError, StaleSourceError, type RawQuery,
} from "./hard-benchmark-service.ts"
import type { HardBenchmarkServiceClient } from "./hard-benchmark-qualification.ts"

export const HARD_BENCHMARK_HOST_LIMITS = Object.freeze({ requestBytes: 64 * 1024, responseBytes: 128 * 1024 })
const routes = new Set(["/submit", "/lookup", "/status", "/manifest", "/readPage", "/sourceStatus", "/currentRevision", "/ledger"])
type Arguments = Record<string, unknown>
type PublicError = { code: string; name: string; message: string; idempotencyKey?: string; sourceId?: string;
  expected?: string; current?: string; revision?: string }

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}

const publicValidationMessages = new Set([
  "Body must be a JSON object.", "Missing or unsupported operation arguments.",
  "Invalid cursor.", "Invalid limit.", "Invalid consistency.",
  "invalid query identity", "filter must be an object of scalar values",
  "invalid filter field or value", "select must contain top-level field names",
  "result exceeds service limits; narrow the query", "page limit must be 1..100",
  "invalid page consistency", "invalid result cursor",
])
function isPublicArgumentError(error: unknown): error is TypeError | RangeError {
  return (error instanceof TypeError || error instanceof RangeError) &&
    (publicValidationMessages.has(error.message) || /^Invalid (?:sourceId|idempotencyKey|jobId)\.$/.test(error.message) ||
      /^unknown (?:source|job): /.test(error.message))
}

function errorResponse(error: unknown): { status: number; error: PublicError } {
  if (error instanceof HttpError) return { status: error.status, error: { name: "HttpError", code: error.code, message: error.message } }
  if (error instanceof LostAcknowledgementError) return { status: 503,
    error: { name: error.name, code: error.code, message: error.message, idempotencyKey: error.idempotencyKey } }
  if (error instanceof StaleSourceError) return { status: 409,
    error: { name: error.name, code: error.code, message: error.message, sourceId: error.sourceId, expected: error.expected, current: error.current } }
  if (error instanceof SourceUnavailableError) return { status: 503,
    error: { name: error.name, code: error.code, message: error.message, sourceId: error.sourceId, revision: error.revision } }
  if (error instanceof RangeError && error.message === "accepted work budget exceeded") return { status: 429,
    error: { name: error.name, code: "WORK_BUDGET_EXCEEDED", message: error.message } }
  if (error instanceof Error && error.message === "idempotency key reused for different query") return { status: 409,
    error: { name: error.name, code: "IDEMPOTENCY_CONFLICT", message: error.message } }
  if (isPublicArgumentError(error)) return { status: 400,
    error: { name: "HttpError", code: "INVALID_ARGUMENT", message: "Invalid public operation arguments." } }
  // Unexpected failures can contain database paths or other host-only information.
  return { status: 500, error: { name: "Error", code: "INTERNAL_ERROR", message: "Service operation failed." } }
}

function reply(status: number, envelope: unknown): Response {
  let body = JSON.stringify(envelope)
  if (Buffer.byteLength(body) > HARD_BENCHMARK_HOST_LIMITS.responseBytes) {
    status = 500
    body = JSON.stringify({ ok: false, error: { name: "HttpError", code: "RESPONSE_TOO_LARGE", message: "Service response exceeds the byte limit." } })
  }
  return new Response(body, { status, headers: { "content-type": "application/json; charset=utf-8", "content-length": String(Buffer.byteLength(body)),
    "cache-control": "no-store", "x-content-type-options": "nosniff", ...(status === 405 ? { allow: "POST" } : {}),
    ...(status >= 400 ? { connection: "close" } : {}) } })
}

async function readArguments(request: Request): Promise<Arguments> {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("content-type") ?? "") || request.headers.has("content-encoding")) {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Use uncompressed application/json with UTF-8 encoding.")
  }
  const length = request.headers.get("content-length")
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > HARD_BENCHMARK_HOST_LIMITS.requestBytes)) {
    throw new HttpError(413, "REQUEST_TOO_LARGE", "Request exceeds the byte limit.")
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = request.body?.getReader()
  if (reader) {
    let timeout: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new HttpError(408, "REQUEST_TIMEOUT", "Request body timed out.")), 5_000)
    })
    try {
      while (true) {
        const chunk = await Promise.race([reader.read(), deadline])
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > HARD_BENCHMARK_HOST_LIMITS.requestBytes) throw new HttpError(413, "REQUEST_TOO_LARGE", "Request exceeds the byte limit.")
        chunks.push(chunk.value)
      }
    } finally {
      clearTimeout(timeout)
      void reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }
  let value: unknown
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size))) }
  catch { throw new HttpError(400, "INVALID_JSON", "Body must be valid UTF-8 JSON.") }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Body must be a JSON object.")
  return value as Arguments
}

function fields(args: Arguments, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(args, key)) || Object.keys(args).some(key => !required.includes(key) && !optional.includes(key))) {
    throw new TypeError("Missing or unsupported operation arguments.")
  }
}
function name(args: Arguments, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || !value.length || value.length > 128 || value.trim() !== value) throw new TypeError(`Invalid ${key}.`)
  return value
}

function dispatch(service: HardBenchmarkService, path: string, args: Arguments): Promise<unknown> {
  switch (path) {
    case "/submit":
      fields(args, ["sourceId", "idempotencyKey"], ["expectedRevision", "filter", "select"])
      // The existing service validates query identity, filter values and projection bounds.
      return service.submit(args as unknown as RawQuery)
    case "/lookup": fields(args, ["idempotencyKey"]); return service.lookup(name(args, "idempotencyKey"))
    case "/status": fields(args, ["jobId"]); return service.status(name(args, "jobId"))
    case "/manifest": fields(args, ["jobId"]); return service.manifest(name(args, "jobId"))
    case "/sourceStatus": fields(args, ["sourceId"]); return service.sourceStatus(name(args, "sourceId"))
    case "/currentRevision": fields(args, ["sourceId"]); return service.currentRevision(name(args, "sourceId"))
    case "/ledger": fields(args, []); return service.ledger()
    case "/readPage": {
      fields(args, ["jobId", "limit"], ["cursor", "consistency"])
      if (args.cursor !== undefined && (typeof args.cursor !== "string" || args.cursor.length > 256)) throw new TypeError("Invalid cursor.")
      if (typeof args.limit !== "number") throw new TypeError("Invalid limit.")
      if (args.consistency !== undefined && args.consistency !== "current" && args.consistency !== "snapshot") throw new TypeError("Invalid consistency.")
      return service.readPage(name(args, "jobId"), args.cursor as string | undefined, args.limit, args.consistency)
    }
    default: throw new HttpError(404, "NOT_FOUND", "Unknown operation.")
  }
}

/** SAME USER DEVELOPMENT ONLY. Each arm needs its own service state and host; this is not an OS isolation boundary. */
export async function startHardBenchmarkHost(service: HardBenchmarkService): Promise<{ url: string; stop: () => Promise<void> }> {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0, development: false, idleTimeout: 5,
    // Stream admission below enforces the smaller public JSON limit before any service call.
    fetch: async request => {
      try {
        const url = new URL(request.url), path = url.pathname
        if (url.search) throw new HttpError(404, "NOT_FOUND", "Unknown operation.")
        if (!routes.has(path)) throw new HttpError(404, "NOT_FOUND", "Unknown operation.")
        if (request.method !== "POST") throw new HttpError(405, "METHOD_NOT_ALLOWED", "Use POST for this operation.")
        const args = await readArguments(request)
        return reply(200, { ok: true, value: (await dispatch(service, path, args)) ?? null })
      } catch (error) {
        const failure = errorResponse(error)
        return reply(failure.status, { ok: false, error: failure.error })
      }
    },
    error: () => reply(500, { ok: false, error: { name: "Error", code: "INTERNAL_ERROR", message: "Service operation failed." } }),
  })
  let stopped: Promise<void> | undefined
  return { url: `http://127.0.0.1:${server.port}`, stop: () => stopped ??= server.stop(true) }
}

function baseUrl(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port || parsed.username || parsed.password ||
    parsed.search || parsed.hash || parsed.pathname !== "/") throw new TypeError("Expected an ephemeral IPv4 loopback host URL.")
  return parsed.origin
}

/** Fetch-only proxy, compatible with the public reference arm. No service handle or grader path crosses this interface. */
export function createHardBenchmarkHttpClient(url: string): HardBenchmarkServiceClient {
  const base = baseUrl(url)
  async function call<T>(path: string, args: unknown): Promise<T> {
    const body = JSON.stringify(args)
    if (Buffer.byteLength(body) > HARD_BENCHMARK_HOST_LIMITS.requestBytes) throw new HttpError(413, "REQUEST_TOO_LARGE", "Request exceeds the byte limit.")
    const response = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body,
      credentials: "omit", redirect: "error", signal: AbortSignal.timeout(10_000) })
    const reader = response.body?.getReader()
    if (!reader) throw new Error("Missing service response")
    const chunks: Uint8Array[] = []
    let bytes = 0
    try {
      while (true) {
        const chunk = await reader.read()
        if (chunk.done) break
        bytes += chunk.value.byteLength
        if (bytes > HARD_BENCHMARK_HOST_LIMITS.responseBytes) { await reader.cancel(); throw new Error("Service response exceeds the byte limit") }
        chunks.push(chunk.value)
      }
    } finally { reader.releaseLock() }
    const envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as
      { ok: true; value: T | null } | { ok: false; error: PublicError }
    if (response.ok && envelope.ok === true && Object.hasOwn(envelope, "value")) return (envelope.value === null ? undefined : envelope.value) as T
    if (envelope.ok !== false || !envelope.error || typeof envelope.error.code !== "string") throw new Error("Invalid service response")
    const error = envelope.error
    if (error.code === "ACK_LOST_AFTER_ACCEPTANCE" && typeof error.idempotencyKey === "string") throw new LostAcknowledgementError(error.idempotencyKey)
    if (error.code === "SOURCE_REVISION_CHANGED" && typeof error.sourceId === "string" && typeof error.expected === "string" && typeof error.current === "string") {
      throw new StaleSourceError(error.sourceId, error.expected, error.current)
    }
    if (error.code === "SOURCE_UNAVAILABLE" && typeof error.sourceId === "string" && typeof error.revision === "string") throw new SourceUnavailableError(error.sourceId, error.revision)
    throw Object.assign(new Error(error.message), { name: error.name, code: error.code, status: response.status })
  }
  return Object.freeze({
    submit: query => call("/submit", query), lookup: idempotencyKey => call("/lookup", { idempotencyKey }),
    status: jobId => call("/status", { jobId }), manifest: jobId => call("/manifest", { jobId }),
    readPage: (jobId, cursor, limit, consistency) => call("/readPage", { jobId, cursor, limit, consistency }),
    sourceStatus: sourceId => call("/sourceStatus", { sourceId }), currentRevision: sourceId => call("/currentRevision", { sourceId }),
    ledger: () => call("/ledger", {}),
  } satisfies HardBenchmarkServiceClient)
}

/** Inject this text into either arm's task context; it contains only public protocol information. */
export function hardBenchmarkHostUsage(url: string): string {
  const base = baseUrl(url)
  return `SAME USER DEVELOPMENT ONLY: loopback is not an OS isolation boundary from an unrestricted same-user shell.
Service URL: ${base} (ephemeral; one service state and endpoint per arm; no credentials).
Use Node fetch to POST application/json to these exact paths:
/submit {idempotencyKey,sourceId,expectedRevision?,filter?,select?}; /lookup {idempotencyKey}; /status {jobId}; /manifest {jobId}
/readPage {jobId,cursor?,limit,consistency?}; /sourceStatus {sourceId}; /currentRevision {sourceId}; /ledger {}
readPage limit is 1..100; follow nextCursor until absent. Consistency defaults to current; snapshot explicitly reads historical evidence.
Success: {ok:true,value:...}; absent lookup/status/source/manifest is value:null. Failure: {ok:false,error:{code,name,message,...}} with a non-2xx status.
ACK_LOST_AFTER_ACCEPTANCE means work was committed: lookup your ORIGINAL caller key. Replay of the same query/key does not charge a second computation; a new key spends work. SOURCE_REVISION_CHANGED forbids current reuse; SOURCE_UNAVAILABLE remains unavailable.
Requests <=${HARD_BENCHMARK_HOST_LIMITS.requestBytes} UTF-8 bytes; responses <=${HARD_BENCHMARK_HOST_LIMITS.responseBytes} bytes. No evidence, refresh or admin routes exist.
Example (replace YOUR_CALLER_KEY):
node -e "fetch('${base}/lookup',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idempotencyKey:'YOUR_CALLER_KEY'})}).then(async r=>console.log(r.status,await r.text()))"`
}

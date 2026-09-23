import { closeSync, openSync, readSync } from "node:fs"
import { canonicalJson } from "../src/persistence.ts"
import { safeDiagnosticText } from "../src/diagnostics.ts"
import { EnvironmentMemoryEngine } from "../src/environment-memory/engine.ts"
import { AppendOptionsSchema, OperationSchema, SnapshotSchema } from "../src/environment-memory/schemas.ts"
import { LocalDirectoryObjectStore, openS3ObjectStore } from "../src/environment-memory/object-store.ts"
import { replicateEnvironmentMemory, restoreEnvironmentMemory } from "../src/environment-memory/replication.ts"

const MAX_IMPORT_BYTES = 1024 * 1024
const USAGE = `Environment memory CLI (all paths and scopes are explicit)

  bun run environment-memory init <database> <namespace>
  bun run environment-memory status <database> <namespace>
  bun run environment-memory import <database> <namespace> <operations.json>
  bun run environment-memory query <database> <namespace> <project> <owner> <root-id...>
  bun run environment-memory snapshot <database> <namespace> > snapshot.json
  bun run environment-memory restore <database> <namespace> <snapshot.json>
  bun run environment-memory replicate <database> <namespace> local <directory>
  bun run environment-memory replicate <database> <namespace> s3 <bucket> <region> <prefix>
  bun run environment-memory restore-remote <database> <namespace> local <directory>
  bun run environment-memory restore-remote <database> <namespace> s3 <bucket> <region> <prefix>

Import JSON: {"operations":[{"idempotency_key":"reviewed-import-1","operation":{...}}]}
S3 uses the AWS SDK's standard external credential provider chain. Secret values are not accepted as arguments or persisted.`

function requireArgs(args: string[], count: number, command: string) {
  if (args.length !== count) throw new Error(`invalid arguments for ${command}; run with --help`)
}

function readJson(path: string, maxBytes: number): unknown {
  const handle = openSync(path, "r")
  try {
    const bytes = Buffer.allocUnsafe(maxBytes + 1)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(handle, bytes, length, bytes.length - length, null)
      if (count === 0) break
      length += count
    }
    if (length > maxBytes) throw new Error(`input exceeds ${maxBytes} bytes`)
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)))
  } finally { closeSync(handle) }
}

async function openStore(kind: string, args: string[]) {
  if (kind === "local") {
    requireArgs(args, 1, "local object store")
    return LocalDirectoryObjectStore.open({ directory: args[0]! })
  }
  if (kind === "s3") {
    requireArgs(args, 3, "S3 object store")
    return openS3ObjectStore({ bucket: args[0]!, region: args[1]!, prefix: args[2] === "-" ? "" : args[2]! })
  }
  throw new Error("store type must be local or s3")
}

export async function runEnvironmentMemoryCommand(argv: string[]): Promise<string> {
  const [command, ...args] = argv
  if (!command || command === "--help" || command === "-h") return USAGE
  if (command === "init" || command === "status" || command === "snapshot") {
    requireArgs(args, 2, command)
    const engine = await EnvironmentMemoryEngine.open({ databasePath: args[0]!, namespace: args[1]! })
    try {
      if (command === "init" || command === "status") return canonicalJson(engine.status())
      return canonicalJson(engine.exportSnapshot())
    } finally { engine.close() }
  }
  if (command === "import") {
    requireArgs(args, 3, command)
    const request = readJson(args[2]!, MAX_IMPORT_BYTES) as { operations?: unknown }
    if (!request || typeof request !== "object" || !Array.isArray(request.operations) || request.operations.length < 1 || request.operations.length > 512 ||
        Object.keys(request).some((key) => key !== "operations")) throw new Error("import must contain 1-512 reviewed operation entries")
    const entries = request.operations.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => !["operation", "idempotency_key"].includes(key)) ||
          typeof (item as { idempotency_key?: unknown }).idempotency_key !== "string") throw new Error("import operation entry is malformed")
      const entry = item as { operation: unknown; idempotency_key: string }
      const key = AppendOptionsSchema.parse({ expected_revision: 0, idempotency_key: entry.idempotency_key }).idempotency_key
      return { operation: OperationSchema.parse(entry.operation), idempotency_key: key }
    })
    const engine = await EnvironmentMemoryEngine.open({ databasePath: args[0]!, namespace: args[1]! })
    try {
      const committed = []
      for (const entry of entries) {
        try {
          const expected_revision = engine.status().revision
          committed.push(engine.append(entry.operation, { expected_revision, idempotency_key: entry.idempotency_key }))
        } catch (cause) {
          throw new Error(`import stopped after ${committed.length} accepted entries at revision ${engine.status().revision}`, { cause })
        }
      }
      return canonicalJson({ committed, status: engine.status() })
    } finally { engine.close() }
  }
  if (command === "query") {
    if (args.length < 5) throw new Error("query requires a database, namespace, project, owner, and at least one root ID")
    const engine = await EnvironmentMemoryEngine.open({ databasePath: args[0]!, namespace: args[1]! })
    try {
      return canonicalJson(engine.query({ scope: { namespace: args[1]!, project: args[2]!, owner: args[3]! }, roots: args.slice(4), max_depth: 3, max_nodes: 64 }))
    } finally { engine.close() }
  }
  if (command === "restore") {
    requireArgs(args, 3, command)
    const snapshot = SnapshotSchema.parse(readJson(args[2]!, 16 * 1024 * 1024))
    const engine = await EnvironmentMemoryEngine.open({ databasePath: args[0]!, namespace: args[1]! })
    try { return canonicalJson(engine.restoreSnapshot(snapshot)) }
    finally { engine.close() }
  }
  if (command === "replicate" || command === "restore-remote") {
    if (args.length < 4) throw new Error(`${command} requires database, namespace, store kind, and store configuration`)
    const [databasePath, namespace, kind, ...storeArgs] = args
    const engine = await EnvironmentMemoryEngine.open({ databasePath: databasePath!, namespace: namespace! })
    try {
      const store = await openStore(kind!, storeArgs)
      const result = command === "replicate"
        ? await replicateEnvironmentMemory(engine, store)
        : await restoreEnvironmentMemory(engine, store)
      return canonicalJson(result)
    } finally { engine.close() }
  }
  throw new Error(`unknown command '${command}'; run with --help`)
}

if (import.meta.main) {
  try { process.stdout.write(`${await runEnvironmentMemoryCommand(process.argv.slice(2))}\n`) }
  catch (error) {
    process.stderr.write(`${safeDiagnosticText(error instanceof Error ? error.message : "environment memory command failed")}\n`)
    process.exitCode = 1
  }
}

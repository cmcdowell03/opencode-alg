/** Explicit local-operator workflow. Filesystem/host permissions are the authority boundary. */
import { isAbsolute, dirname } from "node:path"
import { z } from "zod"
import { readSkillEvolutionDirectBounded } from "../src/skill-evolution-store.ts"
import { SessionMemoryRuntime } from "../src/session-memory/runtime.ts"
import { publishEnvironment } from "../src/session-memory/environment.ts"
import { importEvidence, importIncidentVerification } from "../src/session-memory/experience-adapter.ts"
import { OperationSchema, CheckpointSchema, Hash } from "../src/session-memory/schemas.ts"
import { AlgPluginOptionsSchema, parseSkillEvolutionOptions } from "../src/skill-evolution-schemas.ts"
import { safeDiagnosticText } from "../src/diagnostics.ts"

export function runMemoryCommand(args: string[]) {
  const parsedArgs = [...args]
  let options: ReturnType<typeof AlgPluginOptionsSchema.parse> = {}
  if (parsedArgs[0] === "--options") {
    const optionPath = parsedArgs[1]
    if (!optionPath || !isAbsolute(optionPath)) throw new Error("options must be an absolute direct JSON file")
    options = AlgPluginOptionsSchema.parse(JSON.parse(readSkillEvolutionDirectBounded(dirname(optionPath), optionPath, 32768, "memory options").toString("utf8")))
    parsedArgs.splice(0, 2)
  }
  const [command, project, owner, ...rest] = parsedArgs
  if (!command || !project || !isAbsolute(project) || !owner) throw new Error("usage: memory [--options <absolute-options-json>] <status|search|task|bind|repin|unbind|environment-publish|environment-select|environment-clear|pin|unpin|import-evidence|import-incident|import-legacy|progress|resolve|retry|revoke|delete|refresh> <absolute-project> <session-id> [value]")
  // Operator review is explicit even if automatic injection is off in host config.
  const runtime = new SessionMemoryRuntime(project, { ...options.sessionMemory, mode: "assist" }, parseSkillEvolutionOptions(options).skillRoots)
  const request = () => {
    if (rest.length !== 1 || !isAbsolute(rest[0]!)) throw new Error("provide exactly one absolute reviewed JSON request path")
    const bytes = readSkillEvolutionDirectBounded(dirname(rest[0]!), rest[0]!, 32768, "reviewed memory request")
    return JSON.parse(bytes.toString("utf8"))
  }
  const value = () => { if (rest.length !== 1) throw new Error("exactly one argument required"); return rest[0]! }
  const noArgs = () => { if (rest.length) throw new Error("unexpected arguments") }
  if (command === "status") { noArgs(); return runtime.status(owner) }
  if (command === "search") return runtime.index.search(value())
  if (command === "task") { const input = CheckpointSchema.pick({ goal: true, constraints: true }).parse(request()); return runtime.beginTask(owner, input.goal, input.constraints) }
  if (command === "bind" || command === "repin") return runtime.bindSkill(owner, value(), command === "repin")
  if (command === "unbind") return runtime.unbindSkill(owner, value())
  if (command === "environment-publish") return { id: publishEnvironment(runtime.store, request()) }
  if (command === "environment-select") return runtime.selectEnvironment(owner, value())
  if (command === "environment-clear") { noArgs(); return runtime.selectEnvironment(owner, null) }
  if (command === "pin") return runtime.pin(owner, value())
  if (command === "unpin") { const id = value(); return runtime.update(owner, (state) => ({ ...state, pins: state.pins.filter((pin) => pin !== id) })) }
  if (command === "import-evidence") return { id: importEvidence(runtime.store, owner, value()) }
  if (command === "import-incident") return { id: importIncidentVerification(runtime.store, owner, value()) }
  if (command === "import-legacy") { noArgs(); return runtime.importLegacy(owner) }
  if (command === "refresh") { noArgs(); runtime.index.refresh(true); return runtime.index.search("") }
  if (command === "progress") { const input = CheckpointSchema.pick({ completed: true, next_step: true }).parse(request()); return runtime.update(owner, (state) => ({ ...state, completed: input.completed, next_step: input.next_step })) }
  if (command === "resolve") {
    const input = z.object({ operation: OperationSchema, verification: Hash, next_step: z.string().min(1).max(2000), expires_at: z.iso.datetime({ offset: true }) }).strict().parse(request())
    return { id: runtime.resolve(owner, input.operation, input.verification, input.next_step, input.expires_at) }
  }
  if (command === "retry") {
    const input = z.object({ operation: OperationSchema, reason: z.string().min(1).max(2000), expires_at: z.iso.datetime({ offset: true }) }).strict().parse(request())
    return { id: runtime.allowRetry(owner, input.operation, input.reason, input.expires_at) }
  }
  if (command === "revoke") { runtime.store.revoke(value()); return { revoked: true } }
  if (command === "delete") { noArgs(); runtime.delete(owner); return { deleted: true } }
  throw new Error("unknown memory command")
}
if (import.meta.main) {
  try { console.log(JSON.stringify(runMemoryCommand(process.argv.slice(2)))) }
  catch (error) { console.error(JSON.stringify({ error: safeDiagnosticText(error instanceof Error ? error.message : "memory command failed") })); process.exitCode = 1 }
}

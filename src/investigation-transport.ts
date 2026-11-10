import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"
import { InvestigationAdapterSchema, type InvestigationAdapter } from "./operational-options.ts"
import { hashObject, assertNoSecrets } from "./session-memory/store.ts"
import { InvestigationResultSchema, InvestigationTransportError, type InvestigationMcpPort, type InvestigationMcpCapabilities,
  type InvestigationReconciliation, type InvestigationSubmission, type InvestigationResult, type InvestigationWork } from "./investigation/index.ts"

const SubmissionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("running"), external_job_id: z.string().min(1).max(512) }).strict(),
  z.object({ kind: z.literal("result"), result: InvestigationResultSchema, actual_cost: z.number().finite().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal("failed_known"), failure: z.string().max(512), actual_cost: z.number().finite().nonnegative().optional() }).strict(),
])
const LookupSchema = z.union([SubmissionSchema,
  z.object({ kind: z.literal("not_found"), proves_not_accepted: z.literal(true) }).strict(),
  z.object({ kind: z.literal("unknown"), reason: z.string().max(512) }).strict(),
])
const ValiditySchema = z.object({ valid: z.boolean(), validity_key: z.string().regex(/^[a-f0-9]{64}$/),
  access_scope: z.string().min(1).max(512) }).strict()

/** A configured service contract, not discovery of arbitrary MCP tool semantics. */
export class InvestigationHttpPort implements InvestigationMcpPort {
  readonly profile: InvestigationAdapter
  readonly capabilities: InvestigationMcpCapabilities
  constructor(profile: unknown, projectId: string, private readonly env: NodeJS.ProcessEnv = process.env) {
    this.profile = InvestigationAdapterSchema.parse(profile)
    this.capabilities = {
      server_id: this.profile.serverId, server_revision: this.profile.serverRevision,
      tool_id: this.profile.submit.name, tool_schema_revision: this.profile.submit.schemaHash,
      principal_id: this.profile.principalId, project_id: projectId, effects: ["read"],
      idempotent_submit: true, lookup_by_submission_id: true, response_limit_bytes: this.profile.responseLimitBytes, qualified: true,
    }
  }

  private async connection<T>(action: (client: Client, beforeCall: () => void) => Promise<T>): Promise<T> {
    if (Date.parse(this.profile.expiresAt) <= Date.now()) throw new InvestigationTransportError("profile_expired", "not_submitted")
    const token = this.profile.tokenEnv ? this.env[this.profile.tokenEnv] : undefined
    if (this.profile.tokenEnv && !token) throw new InvestigationTransportError("credential_unavailable", "not_submitted")
    const boundedFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
      if (new URL(String(url)).href !== new URL(this.profile.endpoint).href) throw new Error("MCP endpoint changed")
      const signal = init?.signal
        ? AbortSignal.any([init.signal, AbortSignal.timeout(this.profile.timeoutMs)])
        : AbortSignal.timeout(this.profile.timeoutMs)
      const response = await fetch(url, { ...init, signal, redirect: "error" })
      if (!response.body) return response
      const maximum = this.profile.responseLimitBytes
      let bytes = 0
      const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          bytes += chunk.byteLength
          if (bytes > maximum) throw new Error("MCP response exceeds configured byte limit")
          controller.enqueue(chunk)
        },
      }))
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    }
    const client = new Client({ name: "opencode-alg-investigation", version: "1.0.0" }, { capabilities: {} })
    const transport = new StreamableHTTPClientTransport(new URL(this.profile.endpoint), {
      fetch: boundedFetch,
      requestInit: { redirect: "error", ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}) },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000, maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    })
    let dispatched = false
    try {
      await client.connect(transport, { timeout: this.profile.timeoutMs })
      const server = client.getServerVersion()
      if (server?.name !== this.profile.mcpServerName || server.version !== this.profile.mcpServerVersion)
        throw new Error("MCP server identity differs from qualified profile")
      // Bound discovery rather than walking an unbounded tool catalog; an unseen schema is unqualified.
      const listed = await client.listTools({}, { timeout: this.profile.timeoutMs })
      if (listed.nextCursor || listed.tools.length > 128) throw new Error("MCP tool qualification coverage is incomplete")
      for (const required of [this.profile.submit, this.profile.lookup, this.profile.validateResult, this.profile.cancel].filter((value) => value !== undefined)) {
        const matches = listed.tools.filter((tool) => tool.name === required.name)
        if (matches.length !== 1 || hashObject({ inputSchema: matches[0]!.inputSchema, outputSchema: matches[0]!.outputSchema ?? null }) !== required.schemaHash) {
          throw new Error("MCP tool schema differs from qualified profile")
        }
      }
      return await action(client, () => { dispatched = true })
    } catch {
      // Never return server text, credential values or SDK diagnostics into model context.
      throw new InvestigationTransportError(dispatched ? "remote_outcome_unknown" : "qualification_failed",
        dispatched ? "possibly_submitted" : "not_submitted")
    } finally { await client.close().catch(() => {}) }
  }

  async qualify(): Promise<void> { await this.connection(async () => {}) }
  private parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new InvestigationTransportError("response_invalid", "possibly_submitted")
    return parsed.data
  }
  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const body = JSON.stringify(args)
      if (Buffer.byteLength(body) > 32_768) throw new Error("request bound")
      assertNoSecrets(body)
    } catch { throw new InvestigationTransportError("request_invalid", "not_submitted") }
    return this.connection(async (client, beforeCall) => {
      beforeCall()
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: this.profile.timeoutMs })
      if (response.isError) throw new Error("MCP tool error")
      let value: unknown = response.structuredContent
      if (value === undefined) {
        const parts = response.content
        if (!Array.isArray(parts) || parts.length !== 1 || parts[0]?.type !== "text" || typeof parts[0].text !== "string") {
          throw new Error("MCP result must have one structured envelope")
        }
        value = JSON.parse(parts[0].text)
      }
      const encoded = JSON.stringify(value)
      if (!encoded || Buffer.byteLength(encoded) > this.profile.responseLimitBytes) throw new Error("MCP result exceeds bound")
      assertNoSecrets(encoded)
      return value
    })
  }
  async submit(request: Parameters<InvestigationMcpPort["submit"]>[0]): Promise<InvestigationSubmission> {
    if (!this.profile.operations.includes(request.operation)) throw new InvestigationTransportError("operation_not_allowed", "not_submitted")
    // These are operator-qualified server-enforced limits. HTTP timeout only bounds our wait.
    return this.parse(SubmissionSchema, await this.call(this.profile.submit.name, {
      ...request, project_id: this.capabilities.project_id, principal_id: this.capabilities.principal_id,
      execution_limits: {
        max_duration_ms: this.profile.executionLimits.maxDurationMs,
        max_bytes_scanned: this.profile.executionLimits.maxBytesScanned,
        max_result_bytes: this.profile.executionLimits.maxResultBytes,
        max_cost: this.profile.executionLimits.maxCost,
      },
    }))
  }
  async lookup(submissionId: string): Promise<InvestigationReconciliation> {
    return this.parse(LookupSchema, await this.call(this.profile.lookup.name, { submission_id: submissionId }))
  }
  async validateResult(result: InvestigationResult, work: InvestigationWork) {
    return this.parse(ValiditySchema, await this.call(this.profile.validateResult.name, {
      manifest_ref: result.manifest_ref, digest: result.digest, work_key: work.work_key,
      validity_key: work.validity_key, source_dependencies: work.source_dependencies,
    }))
  }
  async cancel(jobId: string): Promise<void> {
    if (!this.profile.cancel) throw new Error("MCP cancellation is not qualified")
    await this.call(this.profile.cancel.name, { external_job_id: jobId })
  }
}

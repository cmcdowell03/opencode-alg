import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join, parse as parsePath } from "node:path"
import { createAlgTools } from "../src/tools.ts"
import { executeRun } from "../src/executor.ts"
import {
  formatSdkError,
  MAX_SDK_DIAGNOSTIC_BYTES,
  safeDiagnosticText,
} from "../src/diagnostics.ts"
import {
  configuredModelResolutions,
  modelResolutionsForRun,
  saveModelSettings,
  snapshotModelResolutions,
} from "../src/models.ts"
import {
  assertFilesystemRootAuthorized,
  isFilesystemRoot,
} from "../src/paths.ts"
import { parseRunState } from "../src/schemas.ts"
import { createRun, loadRun, MAX_STATE_BYTES, persistRun, runDir } from "../src/store.ts"
import { getTemplate } from "../src/templates.ts"
import { runNodeSession } from "../src/sessions.ts"
import { executeContext, inertClient, removeProject, tempProject } from "./helpers.ts"

function context(project: string) {
  return {
    sessionID: "owner",
    messageID: "message",
    agent: "orchestrator",
    directory: project,
    worktree: project,
    abort: new AbortController().signal,
    ask: async () => {},
    metadata: () => {},
  } as any
}

function output(result: unknown): any {
  return JSON.parse((result as { output: string }).output)
}

describe("reliability and observability hardening", () => {
  test("portable root detection rejects each mutating call unless that call opts in", () => {
    for (const root of ["/", "C:\\", "c:/", "\\\\server\\share\\"]) {
      expect(isFilesystemRoot(root), root).toBe(true)
      for (const operation of ["plan", "run", "resume"] as const) {
        expect(() => assertFilesystemRootAuthorized(root, false, operation)).toThrow(/scoped project directory/)
        expect(assertFilesystemRootAuthorized(root, true, operation)).toBe(true)
      }
    }
    expect(isFilesystemRoot("C:\\repo")).toBe(false)
    expect(isFilesystemRoot("/repo")).toBe(false)
    // A plan approval is intentionally not stateful authorization for run.
    expect(assertFilesystemRootAuthorized("C:\\", true, "plan")).toBe(true)
    expect(() => assertFilesystemRootAuthorized("C:\\", undefined, "run")).toThrow(/this call only/)
  })

  test("plan/run/resume tools reject the host root before lookup and require opt-in on each call", async () => {
    const project = tempProject()
    try {
      const root = parsePath(project).root
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: root,
        worktree: root,
      } as never)
      const rootContext = context(root)
      const rejectedPlan = output(await tools.alg_plan.execute({ goal: "root default" }, rootContext))
      const rejectedRun = output(await tools.alg_run.execute({ run_id: "missing-root-run" }, rootContext))
      const rejectedResume = output(await tools.alg_resume.execute({ run_id: "missing-root-run" }, rootContext))
      expect(rejectedPlan.error).toContain("filesystem root")
      expect(rejectedRun.error).toContain("filesystem root")
      expect(rejectedResume.error).toContain("filesystem root")
      expect(rejectedRun.error).not.toContain("No owned run")

      const optedInPlan = output(await tools.alg_plan.execute({
        goal: "root opt in reaches validation",
        allow_filesystem_root: true,
        graph_json: "{}",
      }, rootContext))
      expect(optedInPlan.error).not.toContain("filesystem root")
      expect(optedInPlan.error).toContain("nodes")
      expect(output(await tools.alg_run.execute({ run_id: "missing-root-run" }, rootContext)).error)
        .toContain("filesystem root")
      expect(output(await tools.alg_run.execute({
        run_id: "missing-root-run",
        allow_filesystem_root: true,
      }, rootContext)).error).toContain("No owned run")
      expect(output(await tools.alg_resume.execute({
        run_id: "missing-root-run",
        allow_filesystem_root: true,
      }, rootContext)).error).toContain("No owned run")
    } finally {
      removeProject(project)
    }
  })

  test("tool handlers reject before mutation and generate persisted per-call root authorization audits", async () => {
    const project = tempProject("alg-root-tools-")
    try {
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never, undefined, undefined, {
        // Pure path-policy injection gives the real handlers an isolated
        // backing directory instead of writing to / or a Windows drive root.
        additionalFilesystemRoot: (path) => path === project,
      })
      const toolContext = context(project)
      const graph = JSON.stringify({
        name: "root-tool-audit",
        nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
      })

      expect(existsSync(join(project, ".opencode"))).toBe(false)
      expect(output(await tools.alg_plan.execute({ goal: "reject root" }, toolContext)).error)
        .toContain("filesystem root")
      expect(output(await tools.alg_run.execute({ run_id: "missing-root" }, toolContext)).error)
        .toContain("filesystem root")
      expect(output(await tools.alg_resume.execute({ run_id: "missing-root" }, toolContext)).error)
        .toContain("filesystem root")
      expect(existsSync(join(project, ".opencode"))).toBe(false)

      const planned = output(await tools.alg_plan.execute({
        goal: "authorized root audit",
        graph_json: graph,
        mode: "dry",
        allow_filesystem_root: true,
      }, toolContext))
      const runId = planned.run_id
      const afterPlan = loadRun(project, runId)!
      expect(afterPlan.filesystem_root_authorizations).toHaveLength(1)
      const planRevision = afterPlan.revision

      expect(output(await tools.alg_run.execute({ run_id: runId }, toolContext)).error)
        .toContain("filesystem root")
      expect(loadRun(project, runId)?.revision).toBe(planRevision)
      const ran = output(await tools.alg_run.execute({
        run_id: runId,
        dry: true,
        allow_filesystem_root: true,
      }, toolContext))
      expect(ran.status).toBe("done")
      const afterRun = loadRun(project, runId)!
      expect(afterRun.filesystem_root_authorizations).toHaveLength(2)
      const runRevision = afterRun.revision

      expect(output(await tools.alg_resume.execute({ run_id: runId }, toolContext)).error)
        .toContain("filesystem root")
      expect(loadRun(project, runId)?.revision).toBe(runRevision)
      const resumed = output(await tools.alg_resume.execute({
        run_id: runId,
        dry: true,
        allow_filesystem_root: true,
      }, toolContext))
      expect(resumed.status).toBe("done")

      const persisted = loadRun(project, runId)!
      expect(persisted.filesystem_root_authorizations?.map((entry) => entry.operation))
        .toEqual(["plan", "run", "resume"])
      for (const entry of persisted.filesystem_root_authorizations ?? []) {
        expect(entry).toMatchObject({
          authorized: true,
          path: project,
          by_session_id: "owner",
        })
        expect(Number.isFinite(Date.parse(entry.authorized_at))).toBe(true)
      }
      const compactStatus = output(await tools.alg_status.execute({ run_id: runId }, toolContext))
      const fullStatus = output(await tools.alg_status.execute({ run_id: runId, detail: "full" }, toolContext))
      expect(compactStatus.root_authorization).toMatchObject({
        filesystem_root: true,
        explicit_per_call: true,
        authorization_count: 3,
      })
      expect(compactStatus.root_authorization.authorizations).toEqual(persisted.filesystem_root_authorizations)
      expect(fullStatus.filesystem_root_authorizations).toEqual(persisted.filesystem_root_authorizations)
      expect(fullStatus.root_authorization.authorizations).toEqual(persisted.filesystem_root_authorizations)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("built-in explorer nodes have one finite retry", () => {
    const coding = getTemplate("coding-diamond")
    const research = getTemplate("research-diamond")
    expect(coding.nodes.find((node) => node.agent === "explorer")?.loop?.max_attempts).toBe(2)
    expect(research.nodes.filter((node) => node.agent === "explorer").map((node) => node.loop?.max_attempts))
      .toEqual([2, 2])
    expect(coding.max_global_attempts).toBe(14)
    expect(research.max_global_attempts).toBe(8)
  })

  test("explorer strict-output rejection consumes and retries only the explorer", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "map",
        criteria: [],
        graph: {
          name: "explorer-retry",
          max_global_attempts: 2,
          max_concurrency: 1,
          nodes: [{ id: "explore", agent: "explorer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } }],
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      let calls = 0
      const completed = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async () => ({
          session_id: `explore-${++calls}`,
          text: "",
          parsed: calls === 1
            ? { $schema: "unexpected", query: "q", map: [{ path: "x", role: "r" }], key_hits: [], next: "none" }
            : { query: "q", map: [{ path: "x", role: "r" }], key_hits: [], next: "none" },
        }),
      })
      expect(completed.status).toBe("done")
      expect(completed.nodes.explore!.attempts.map((attempt) => attempt.outcome))
        .toEqual(["schema_invalid", "passed"])
      expect(completed.nodes.explore!.attempts.map((attempt) => attempt.session_id))
        .toEqual(["explore-1", "explore-2"])
    } finally {
      removeProject(project)
    }
  })

  test("more than 100 schema issues persist deterministically and retry only their node", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "bound schema diagnostics",
        criteria: [],
        graph: {
          name: "many-schema-issues",
          max_global_attempts: 2,
          max_concurrency: 1,
          nodes: [{ id: "explore", agent: "explorer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } }],
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      let calls = 0
      const completed = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async () => ({
          session_id: `many-issues-${++calls}`,
          text: "",
          parsed: calls === 1
            ? {
                query: "invalid",
                map: Array.from({ length: 150 }, () => ({ path: "", role: "" })),
                key_hits: [],
                next: "none",
              }
            : { query: "valid", map: [{ path: "src", role: "source" }], key_hits: [], next: "none" },
        }),
      })
      const persisted = loadRun(project, completed.run_id)!
      expect(persisted.status).toBe("done")
      expect(persisted.global_attempts).toBe(2)
      expect(persisted.nodes.explore!.attempts.map((attempt) => attempt.outcome))
        .toEqual(["schema_invalid", "passed"])
      expect(persisted.nodes.explore!.attempts[0]!.failures).toHaveLength(100)
      expect(persisted.nodes.explore!.attempts[0]!.failures.at(-1)).toMatch(/\[truncated\] \d+ additional schema issues omitted/)
      expect(persisted.nodes.explore!.attempts[0]!.failures[0]).toContain("schema: map.0.path")
      expect(calls).toBe(2)
    } finally {
      removeProject(project)
    }
  })

  test("schema-contradictory checker retries itself without reopening worker", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "checker routing",
        criteria: ["pass"],
        graph: {
          name: "checker-self-retry",
          max_global_attempts: 4,
          max_concurrency: 1,
          nodes: [
            { id: "work", agent: "implementer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } },
            {
              id: "check",
              agent: "checker",
              depends_on: ["work"],
              inputs: { claimed: "work" },
              feedback_to: "work",
              isolated_check: true,
              loop: { max_attempts: 2, gate: "schema" },
            },
          ],
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      let workers = 0
      let checkers = 0
      const completed = await executeRun(run, {
        ...executeContext(project),
        sessionRunner: async (options) => {
          if (options.agent === "implementer") {
            workers++
            return { session_id: `work-${workers}`, text: "", parsed: { summary: ["done"], files_touched: [], commands_run: [], risks: [], done: true } }
          }
          checkers++
          return {
            session_id: `check-${checkers}`,
            text: "",
            parsed: checkers === 1
              ? { passed: true, failures: [], score: 6 }
              : { passed: true, failures: [], score: 10 },
          }
        },
      })
      expect(completed.status).toBe("done")
      expect(workers).toBe(1)
      expect(checkers).toBe(2)
      expect(completed.nodes.check!.attempts.map((attempt) => attempt.outcome))
        .toEqual(["schema_invalid", "passed"])
      expect(completed.nodes.check!.attempts[0]!.feedback_applied).toBeUndefined()
      expect(completed.global_attempts).toBe(3)
    } finally {
      removeProject(project)
    }
  })

  test("SDK diagnostics retain safe nested detail while redacting and bounding hostile values", () => {
    const nested: any = {
      response: {
        status: 429,
        data: {
          code: "rate_limited",
          message: "retry later",
          request_id: "req-123",
          authorization: "Bearer top-secret",
          prompt: "private prompt",
          detail: "x".repeat(10_000),
        },
        headers: { cookie: "session=secret" },
      },
      apiKey: "api-secret",
    }
    nested.response.cause = nested.response
    const diagnostic = formatSdkError(nested)
    expect(diagnostic).toContain("429")
    expect(diagnostic).toContain("rate_limited")
    expect(diagnostic).toContain("req-123")
    expect(diagnostic).toContain("[REDACTED]")
    expect(diagnostic).toContain("[Circular]")
    expect(diagnostic).not.toContain("top-secret")
    expect(diagnostic).not.toContain("private prompt")
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(MAX_SDK_DIAGNOSTIC_BYTES)

    const caused = new Error("outer", { cause: { code: "inner-code", password: "nope" } })
    expect(formatSdkError(caused)).toContain("inner-code")
    expect(formatSdkError(caused)).not.toContain("nope")
    expect(formatSdkError("primitive failure")).toContain("primitive failure")
    expect(formatSdkError(17)).toContain("17")
    expect(formatSdkError({})).not.toBe("{}")
  })

  test("request-like unknown fields stay opaque while exact SDK wrappers remain useful", () => {
    const sentinel = "UNIQUE-REQUEST-SECRET-7f7f7f"
    const diagnostic = formatSdkError({
      name: "SdkRequestError",
      status: 422,
      payload: { code: "payload_code", message: "safe payload message", arbitrary: sentinel },
      body: { request_id: "req-body", privateValue: sentinel },
      request: { statusCode: 409, inputValue: sentinel },
      input: { correlation_id: "corr-input", nestedSecret: sentinel },
      data: { code: "safe-data-code", userText: sentinel },
      user_payload: { requestId: "req-user-payload", arbitrary: sentinel },
      requestBody: { correlationId: "corr-request-body", message: [{ role: "user", content: sentinel }] },
      request_payload: { status: 400, arbitrary: sentinel },
      promptContent: sentinel,
      inputData: { code: "input-data-code", arbitrary: sentinel },
      prompt: sentinel,
      content: sentinel,
      messages: [{ role: "user", content: sentinel }],
      message: [{ content: sentinel }],
      cause: { name: "SafeCause", status: 503, password: sentinel },
    })
    expect(diagnostic).not.toContain(sentinel)
    expect(diagnostic).toContain("SdkRequestError")
    expect(diagnostic).toContain("422")
    expect(diagnostic).toContain("req-body")
    expect(diagnostic).toContain("safe-data-code")
    expect(diagnostic).toContain("SafeCause")
    expect(diagnostic).toContain("503")
    expect(diagnostic).toContain("[REDACTED]")
    for (const opaqueDescendant of [
      "payload_code",
      "safe payload message",
      "corr-input",
      "req-user-payload",
      "corr-request-body",
      "input-data-code",
    ]) expect(diagnostic).not.toContain(opaqueDescendant)

    const inline = formatSdkError(new Error(
      `Authorization: Basic ${sentinel}; Bearer ${sentinel}; token ${sentinel}`,
    ))
    expect(inline).not.toContain(sentinel)
    expect(inline).toContain("[REDACTED]")
  })

  test("diagnostics redact composite content keys and every quoted or unquoted authorization form", () => {
    const sentinels = [
      "SENTINEL-USER-DATA-01",
      "SENTINEL-USER-PAYLOAD-02",
      "SENTINEL-REQUEST-BODY-03",
      "SENTINEL-RESPONSE-CONTENT-04",
      "SENTINEL-INPUT-MESSAGE-05",
      "SENTINEL-USER-CONTENT-06",
      "SENTINEL-REQUEST-DATA-07",
      "SENTINEL-RESPONSE-BODY-08",
      "SENTINEL-PROMPT-DATA-09",
      "SENTINEL-MESSAGE-OBJECT-10",
      "SENTINEL-MESSAGE-DATA-11",
    ]
    const diagnostic = formatSdkError({
      "UsEr-DaTa": { arbitrary: sentinels[0], status: 418, code: "safe-user-data-code" },
      USER_PAYLOAD: { arbitrary: sentinels[1], requestId: "safe-user-payload-request" },
      requestBody: { arbitrary: sentinels[2], correlationId: "safe-request-body-correlation" },
      responseContent: { arbitrary: sentinels[3], message: "safe response message", STATUS_CODE: 429 },
      input_message: sentinels[4],
      userContent: sentinels[5],
      request_data: sentinels[6],
      Response_Body: sentinels[7],
      prompt_data: sentinels[8],
      message: [{ role: "user", content: sentinels[9] }],
      messageData: sentinels[10],
    })
    for (const sentinel of sentinels) expect(diagnostic).not.toContain(sentinel)
    for (const opaqueDescendant of [
      "safe-user-data-code",
      "safe-user-payload-request",
      "safe-request-body-correlation",
      "safe response message",
      "429",
    ]) expect(diagnostic).not.toContain(opaqueDescendant)
    expect(diagnostic).toContain("[REDACTED]")
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(MAX_SDK_DIAGNOSTIC_BYTES)

    const authorizationSentinels = [
      "AUTH-QUOTED-BEARER-11",
      "AUTH-QUOTED-BASIC-12",
      "AUTH-QUOTED-TOKEN-13",
      "AUTH-UNQUOTED-BEARER-14",
      "AUTH-UNQUOTED-BASIC-15",
      "AUTH-UNQUOTED-TOKEN-16",
      "AUTH-QUOTED-RAW-17",
    ]
    const authorization = formatSdkError(new Error([
      `Authorization: "Bearer ${authorizationSentinels[0]}"`,
      `Authorization='Basic ${authorizationSentinels[1]}'`,
      `Proxy-Authorization: "token ${authorizationSentinels[2]}"`,
      `Authorization: Bearer ${authorizationSentinels[3]}`,
      `Basic ${authorizationSentinels[4]}`,
      `token ${authorizationSentinels[5]}`,
      `Authorization: "${authorizationSentinels[6]}"`,
    ].join("; ")))
    for (const sentinel of authorizationSentinels) expect(authorization).not.toContain(sentinel)
    expect(authorization).toContain("[REDACTED]")
    expect(Buffer.byteLength(authorization)).toBeLessThanOrEqual(MAX_SDK_DIAGNOSTIC_BYTES)
  })

  test("inline diagnostics redact entire quoted credential values and retain safe surroundings", () => {
    const cases = [
      { source: `safe-before {"token":"TOKEN-SENTINEL"} safe-after`, secret: "TOKEN-SENTINEL" },
      { source: `safe-before {'api_key':'SENTINEL'} safe-after`, secret: "SENTINEL" },
      { source: `safe-before {"Authorization" : "Bearer AUTH-SENTINEL with spaces"} safe-after`, secret: "AUTH-SENTINEL" },
      { source: `safe-before {'COOKIE'='COOKIE-SENTINEL; second=value'} safe-after`, secret: "COOKIE-SENTINEL" },
      { source: `safe-before {"user_password": "PASSWORD-SENTINEL, still private"} safe-after`, secret: "PASSWORD-SENTINEL" },
      { source: `safe-before {'client-secret' : 'SECRET-SENTINEL with spaces'} safe-after`, secret: "SECRET-SENTINEL" },
      { source: `safe-before {"access_token":"ACCESS-TOKEN-SENTINEL"} safe-after`, secret: "ACCESS-TOKEN-SENTINEL" },
    ]

    for (const { source, secret } of cases) {
      const diagnostic = safeDiagnosticText(source)
      expect(diagnostic).toStartWith("safe-before ")
      expect(diagnostic).toEndWith(" safe-after")
      expect(diagnostic).toContain("[REDACTED]")
      expect(diagnostic).not.toContain(secret)
      expect(diagnostic).not.toContain("still private")
      expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(MAX_SDK_DIAGNOSTIC_BYTES)
    }
  })

  test("escaped JSON credential assignments are fully redacted in text and SDK diagnostics", () => {
    const cases = [
      { source: String.raw`{\"token\":\"TOKEN-SENTINEL\"}`, secrets: ["TOKEN-SENTINEL"] },
      { source: String.raw`{\"token\":\"prefix \\\"LEAK\\\" suffix\"}`, secrets: ["prefix", "LEAK", "suffix"] },
      { source: String.raw`{\"Authorization\":\"Bearer AUTHORIZATION-SENTINEL with spaces\"}`, secrets: ["AUTHORIZATION-SENTINEL", "with spaces"] },
      { source: String.raw`{\"api_key\":\"API-KEY-SENTINEL private suffix\"}`, secrets: ["API-KEY-SENTINEL", "private suffix"] },
      { source: String.raw`{\"password\":\"PASSWORD-SENTINEL, private suffix\"}`, secrets: ["PASSWORD-SENTINEL", "private suffix"] },
      { source: String.raw`{\"cookie\":\"COOKIE-SENTINEL; private=value\"}`, secrets: ["COOKIE-SENTINEL", "private=value"] },
      { source: String.raw`{\"client_secret\":\"SECRET-SENTINEL private suffix\"}`, secrets: ["SECRET-SENTINEL", "private suffix"] },
    ]

    for (const { source, secrets } of cases) {
      const textDiagnostic = safeDiagnosticText(source)
      const sdkDiagnostic = formatSdkError(source)
      expect(textDiagnostic).toContain("[REDACTED]")
      expect(sdkDiagnostic).toContain("[REDACTED]")
      for (const secret of secrets) {
        expect(textDiagnostic).not.toContain(secret)
        expect(sdkDiagnostic).not.toContain(secret)
      }
    }
  })

  test("assignment redaction fails closed across bare, quoted, escaped, comma, space, and authorization values", () => {
    const cases = [
      { source: "safe-before token=BARE-SECRET private suffix", secrets: ["BARE-SECRET", "private suffix"] },
      { source: 'safe-before {"token":"QUOTED-SECRET, private suffix"} safe-after', secrets: ["QUOTED-SECRET", "private suffix"] },
      { source: String.raw`safe-before {\"api_key\":\"ESCAPED-SECRET, private suffix\"} safe-after`, secrets: ["ESCAPED-SECRET", "private suffix"] },
      { source: String.raw`safe-before {\"password\":\"inner \\\"NESTED-SECRET\\\" suffix\"} safe-after`, secrets: ["inner", "NESTED-SECRET", "suffix"] },
      { source: "safe-before Authorization: Basic BASIC-SECRET with spaces, and commas", secrets: ["BASIC-SECRET", "with spaces", "and commas"] },
      { source: "safe-before Proxy-Authorization='Bearer BEARER-SECRET with spaces' safe-after", secrets: ["BEARER-SECRET", "with spaces"] },
      { source: 'safe-before token "SCHEME-TOKEN-SECRET with spaces" safe-after', secrets: ["SCHEME-TOKEN-SECRET", "with spaces"] },
    ]

    for (const { source, secrets } of cases) {
      const diagnostic = safeDiagnosticText(source)
      expect(diagnostic).toStartWith("safe-before ")
      expect(diagnostic).toContain("[REDACTED]")
      for (const secret of secrets) expect(diagnostic).not.toContain(secret)
      expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(MAX_SDK_DIAGNOSTIC_BYTES)
    }
  })

  test("approved scalar messages redact complete private-content assignments across serialization layers", () => {
    const cases = [
      `safe-before {"prompt":"PROMPT-SECRET"} status=429 safe-after`,
      "safe-before content=CONTENT-SECRET with spaces, and commas status=429",
      "safe-before messages='MESSAGES-SECRET, private suffix' code=rate_limited safe-after",
      String.raw`safe-before {\"payload\":\"PAYLOAD-SECRET with spaces\",\"request_id\":\"req-safe\"} safe-after`,
      String.raw`safe-before {\\"requestBody\\":\\"prefix \\\\"NESTED-SECRET\\\\" suffix\\",\\"status\\":429} safe-after`,
      "safe-before user_content=USER-CONTENT-SECRET correlation_id=corr-safe",
      "safe-before responseContent=RESPONSE-CONTENT-SECRET requestId=req-safe",
      "safe-before input=INPUT-SECRET error_code=safe-code",
      "safe-before body=BODY-SECRET statusCode=503",
    ]
    for (const source of cases) {
      const text = safeDiagnosticText(source)
      const sdk = formatSdkError(new Error(source))
      for (const sentinel of [
        "PROMPT-SECRET",
        "CONTENT-SECRET",
        "MESSAGES-SECRET",
        "PAYLOAD-SECRET",
        "NESTED-SECRET",
        "USER-CONTENT-SECRET",
        "RESPONSE-CONTENT-SECRET",
        "INPUT-SECRET",
        "BODY-SECRET",
        "private suffix",
      ]) {
        expect(text).not.toContain(sentinel)
        expect(sdk).not.toContain(sentinel)
      }
      expect(text).toContain("safe-before")
      expect(text).toContain("[REDACTED]")
    }
    expect(safeDiagnosticText(cases[0]!)).toContain("status=429 safe-after")
    expect(safeDiagnosticText(cases[1]!)).toContain("status=429")
    expect(safeDiagnosticText(cases[3]!)).toContain("request_id")
    expect(safeDiagnosticText(cases[5]!)).toContain("correlation_id=corr-safe")
    expect(safeDiagnosticText("ordinary safe message status=429 requestId=req-safe"))
      .toBe("ordinary safe message status=429 requestId=req-safe")
  })

  test("unknown request-content containers never expose recognized descendants", () => {
    const exactBypass = formatSdkError({
      user_response_content: { status: { arbitrary: "CONTENT-SENTINEL" } },
    })
    expect(exactBypass).not.toContain("CONTENT-SENTINEL")

    const diagnostic = formatSdkError({
      user_response_content: {
        status: { arbitrary: "STATUS-CONTENT-SENTINEL" },
        code: ["CODE-CONTENT-SENTINEL"],
        message: { arbitrary: "MESSAGE-CONTENT-SENTINEL" },
        requestId: { arbitrary: "REQUEST-CONTENT-SENTINEL" },
        correlation_id: ["CORRELATION-CONTENT-SENTINEL"],
        statusCode: 207,
        request_id: "safe-request-id",
        correlationId: "safe-correlation-id",
        name: "SafeDiagnosticName",
      },
    })
    for (const sentinel of [
      "STATUS-CONTENT-SENTINEL",
      "CODE-CONTENT-SENTINEL",
      "MESSAGE-CONTENT-SENTINEL",
      "REQUEST-CONTENT-SENTINEL",
      "CORRELATION-CONTENT-SENTINEL",
    ]) expect(diagnostic).not.toContain(sentinel)
    expect(diagnostic).toContain("[REDACTED]")
    expect(JSON.parse(diagnostic)).toEqual({ _redacted: "[REDACTED]" })
    for (const opaqueDescendant of [
      "207",
      "safe-request-id",
      "safe-correlation-id",
      "SafeDiagnosticName",
    ]) expect(diagnostic).not.toContain(opaqueDescendant)
  })

  test("diagnostic scalar fields reject structured values at every nesting level", () => {
    const topLevelSentinels = [
      "STATUS-SENTINEL",
      "CODE-SENTINEL",
      "REQUEST-ID-SENTINEL",
      "CORRELATION-ID-SENTINEL",
      "MESSAGE-SENTINEL",
    ]
    const topLevel = formatSdkError({
      status: { arbitrary: topLevelSentinels[0] },
      code: [topLevelSentinels[1]],
      requestId: { arbitrary: topLevelSentinels[2] },
      correlationId: [topLevelSentinels[3]],
      message: { arbitrary: topLevelSentinels[4] },
    })
    expect(JSON.parse(topLevel)).toEqual({
      message: "[REDACTED]",
      code: "[REDACTED: 1 items]",
      status: "[REDACTED]",
      requestId: "[REDACTED]",
      correlationId: "[REDACTED: 1 items]",
    })
    for (const sentinel of topLevelSentinels) expect(topLevel).not.toContain(sentinel)

    const nestedSentinels = [
      "RESPONSE-STATUS-SENTINEL",
      "RESPONSE-CODE-SENTINEL",
      "RESPONSE-REQUEST-ID-SENTINEL",
      "RESPONSE-CORRELATION-ID-SENTINEL",
      "RESPONSE-MESSAGE-SENTINEL",
      "ERROR-STATUS-SENTINEL",
      "ERROR-CODE-SENTINEL",
      "ERROR-REQUEST-ID-SENTINEL",
      "ERROR-CORRELATION-ID-SENTINEL",
      "ERROR-MESSAGE-SENTINEL",
    ]
    const nested = formatSdkError({
      response: {
        status: { arbitrary: nestedSentinels[0] },
        code: [nestedSentinels[1]],
        requestId: { arbitrary: nestedSentinels[2] },
        correlationId: [nestedSentinels[3]],
        message: { arbitrary: nestedSentinels[4] },
      },
      error: {
        status: { arbitrary: nestedSentinels[5] },
        code: [nestedSentinels[6]],
        requestId: { arbitrary: nestedSentinels[7] },
        correlationId: [nestedSentinels[8]],
        message: { arbitrary: nestedSentinels[9] },
      },
    })
    expect(JSON.parse(nested)).toEqual({
      error: {
        message: "[REDACTED]",
        code: "[REDACTED: 1 items]",
        status: "[REDACTED]",
        requestId: "[REDACTED]",
        correlationId: "[REDACTED: 1 items]",
      },
      response: {
        message: "[REDACTED]",
        code: "[REDACTED: 1 items]",
        status: "[REDACTED]",
        requestId: "[REDACTED]",
        correlationId: "[REDACTED: 1 items]",
      },
    })
    for (const sentinel of nestedSentinels) expect(nested).not.toContain(sentinel)

    const safeScalars = formatSdkError({
      name: "SafeTopLevelError",
      message: "safe top-level message",
      status: 207,
      code: "safe-top-level-code",
      requestId: "safe-top-level-request",
      correlationId: "safe-top-level-correlation",
      response: {
        message: "safe response message",
        status: 429,
        code: "safe-response-code",
        requestId: "safe-response-request",
        correlationId: "safe-response-correlation",
      },
      error: {
        message: "safe nested error message",
        status: 503,
        code: "safe-error-code",
        requestId: "safe-error-request",
        correlationId: "safe-error-correlation",
      },
    })
    for (const scalar of [
      "SafeTopLevelError",
      "safe top-level message",
      "207",
      "safe-top-level-code",
      "safe-top-level-request",
      "safe-top-level-correlation",
      "safe response message",
      "429",
      "safe-response-code",
      "safe-response-request",
      "safe-response-correlation",
      "safe nested error message",
      "503",
      "safe-error-code",
      "safe-error-request",
      "safe-error-correlation",
    ]) expect(safeScalars).toContain(scalar)

    const ordinaryError = new Error("safe Error.message")
    Object.assign(ordinaryError, {
      status: 500,
      code: "safe Error.code",
      requestId: "safe Error.requestId",
      correlationId: "safe Error.correlationId",
    })
    const ordinaryDiagnostic = formatSdkError(ordinaryError)
    for (const scalar of [
      "Error",
      "safe Error.message",
      "500",
      "safe Error.code",
      "safe Error.requestId",
      "safe Error.correlationId",
    ]) expect(ordinaryDiagnostic).toContain(scalar)
  })

  test("unknown top-level scalar, object, array, and type fields stay opaque", () => {
    const sentinels = [
      "TOP-LEVEL-SCALAR-SENTINEL",
      "TOP-LEVEL-OBJECT-SENTINEL",
      "TOP-LEVEL-ARRAY-SCALAR-SENTINEL",
      "TOP-LEVEL-ARRAY-OBJECT-SENTINEL",
      "TOP-LEVEL-TYPE-SENTINEL",
    ]
    const diagnostic = formatSdkError({
      name: "SafeTopLevelName",
      arbitraryScalar: sentinels[0],
      arbitraryObject: { message: sentinels[1], requestId: "opaque-object-request" },
      arbitraryArray: [sentinels[2], { code: sentinels[3] }],
      type: sentinels[4],
      response: {
        error: {
          message: "safe response error message",
          code: "safe-response-error-code",
          requestId: "safe-response-error-request",
          arbitrarySibling: "RESPONSE-ERROR-SIBLING-SENTINEL",
        },
      },
    })

    for (const sentinel of [...sentinels, "RESPONSE-ERROR-SIBLING-SENTINEL"])
      expect(diagnostic).not.toContain(sentinel)
    expect(diagnostic).not.toContain("opaque-object-request")
    expect(JSON.parse(diagnostic)).toEqual({
      name: "SafeTopLevelName",
      response: {
        error: {
          message: "safe response error message",
          code: "safe-response-error-code",
          requestId: "safe-response-error-request",
        },
      },
    })
  })

  test("approved diagnostic containers allowlist fields and never emit arbitrary values", () => {
    expect(formatSdkError({ error: { arbitrary: "NESTED-SENTINEL" } }))
      .not.toContain("NESTED-SENTINEL")
    expect(formatSdkError({ cause: { arbitrary: "CAUSE-NESTED-SENTINEL" } }))
      .not.toContain("CAUSE-NESTED-SENTINEL")

    for (const container of ["error", "cause", "response"] as const) {
      const scalarSentinel = `${container.toUpperCase()}-ARBITRARY-SCALAR-SENTINEL`
      const objectSentinel = `${container.toUpperCase()}-ARBITRARY-OBJECT-SENTINEL`
      const arrayScalarSentinel = `${container.toUpperCase()}-ARBITRARY-ARRAY-SCALAR-SENTINEL`
      const arrayObjectSentinel = `${container.toUpperCase()}-ARBITRARY-ARRAY-OBJECT-SENTINEL`
      const typeSentinel = `${container.toUpperCase()}-TYPE-SENTINEL`
      const diagnostic = formatSdkError({
        [container]: {
          message: `safe ${container} message`,
          status: 409,
          requestId: `safe-${container}-request`,
          type: typeSentinel,
          arbitraryScalar: scalarSentinel,
          arbitraryObject: {
            value: objectSentinel,
            nested: { request_id: `safe-${container}-object-request` },
          },
          arbitraryArray: [
            arrayScalarSentinel,
            { value: arrayObjectSentinel },
            { code: `safe-${container}-array-code` },
          ],
        },
      })

      for (const sentinel of [
        scalarSentinel,
        objectSentinel,
        arrayScalarSentinel,
        arrayObjectSentinel,
        typeSentinel,
      ]) expect(diagnostic).not.toContain(sentinel)
      expect(JSON.parse(diagnostic)).toEqual({
        [container]: {
          message: `safe ${container} message`,
          status: 409,
          requestId: `safe-${container}-request`,
        },
      })
    }

    const unknownWrapper = formatSdkError({
      sdkWrapper: { message: "UNKNOWN-SDK-WRAPPER-MESSAGE", code: "UNKNOWN-SDK-WRAPPER-CODE" },
    })
    expect(unknownWrapper).not.toContain("UNKNOWN-SDK-WRAPPER-MESSAGE")
    expect(unknownWrapper).not.toContain("UNKNOWN-SDK-WRAPPER-CODE")
  })

  test("approved container arrays and exact SDK wrappers use restricted semantics", () => {
    const arrayDiagnostic = formatSdkError({
      error: [
        "APPROVED-ARRAY-SCALAR-SENTINEL",
        { code: "safe-array-code", arbitrary: "APPROVED-ARRAY-SIBLING-SENTINEL" },
        { arbitraryObject: { requestId: "APPROVED-ARRAY-DESCENDANT-SENTINEL" } },
      ],
    })
    for (const sentinel of [
      "APPROVED-ARRAY-SCALAR-SENTINEL",
      "APPROVED-ARRAY-SIBLING-SENTINEL",
      "APPROVED-ARRAY-DESCENDANT-SENTINEL",
    ]) expect(arrayDiagnostic).not.toContain(sentinel)
    expect(JSON.parse(arrayDiagnostic)).toEqual({
      error: ["[REDACTED]", { code: "safe-array-code" }, "[REDACTED]"],
    })

    const namedError = formatSdkError({
      name: "BadRequest",
      data: {
        message: "safe named error message",
        statusCode: 400,
        request_id: "safe-named-error-request",
        providerID: "UNKNOWN-DATA-SIBLING-SENTINEL",
      },
    })
    expect(namedError).not.toContain("UNKNOWN-DATA-SIBLING-SENTINEL")
    expect(JSON.parse(namedError)).toEqual({
      name: "BadRequest",
      data: {
        message: "safe named error message",
        statusCode: 400,
        request_id: "safe-named-error-request",
      },
    })

    const wrapped = new Error("safe outer message", {
      cause: {
        status: 502,
        body: {
          error: { code: "safe-wrapped-code", correlationId: "safe-wrapped-correlation" },
          arbitrary: "UNKNOWN-BODY-SIBLING-SENTINEL",
        },
      },
    })
    const wrappedDiagnostic = formatSdkError(wrapped)
    expect(wrappedDiagnostic).not.toContain("UNKNOWN-BODY-SIBLING-SENTINEL")
    expect(JSON.parse(wrappedDiagnostic)).toEqual({
      name: "Error",
      message: "safe outer message",
      cause: {
        status: 502,
        body: {
          error: { code: "safe-wrapped-code", correlationId: "safe-wrapped-correlation" },
        },
      },
    })
  })

  test("three-component request content containers are opaque non-content markers", () => {
    const sentinels = [
      "SENTINEL-USER-RESPONSE-CONTENT",
      "SENTINEL-REQUEST-USER-PAYLOAD",
      "SENTINEL-RESPONSE-REQUEST-BODY",
      "SENTINEL-USER-RESPONSE-MESSAGES",
      "SENTINEL-REQUEST-RESPONSE-DATA",
    ]
    const diagnostic = formatSdkError({
      user_response_content: {
        message: "safe three-component message",
        status: 207,
        code: "safe-three-component-code",
        requestId: "safe-three-component-request",
        correlationId: "safe-three-component-correlation",
        arbitrary: sentinels[0],
      },
      request_user_payload_archive: { arbitrary: sentinels[1] },
      responseRequestBodyEnvelope: { arbitrary: sentinels[2] },
      USER_RESPONSE_MESSAGES: [{ content: sentinels[3] }],
      request_response_data: { arbitrary: sentinels[4] },
    })

    for (const sentinel of sentinels) expect(diagnostic).not.toContain(sentinel)
    for (const opaqueDescendant of [
      "safe three-component message",
      "207",
      "safe-three-component-code",
      "safe-three-component-request",
      "safe-three-component-correlation",
    ]) expect(diagnostic).not.toContain(opaqueDescendant)
    expect(JSON.parse(diagnostic)).toEqual({ _redacted: "[REDACTED]" })
    expect(formatSdkError(new Error("safe Error.message remains visible")))
      .toContain("safe Error.message remains visible")
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(MAX_SDK_DIAGNOSTIC_BYTES)
  })

  test("alg_status compact list reports a shortened goal even when no runs are omitted", async () => {
    const project = tempProject()
    try {
      const goal = `one long goal ${"g".repeat(200)}`
      createRun({
        goal,
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
        runId: "one-long-goal",
      })
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)

      const compact = output(await tools.alg_status.execute({ list: true }, context(project)))
      expect(compact).toMatchObject({
        total: 1,
        shown: 1,
        omitted: 0,
        truncated_fields: 1,
        goals_truncated: 1,
        truncated: true,
      })
      expect(compact.runs[0].goal).toHaveLength(120)

      const full = output(await tools.alg_status.execute({ list: true, detail: "full" }, context(project)))
      expect(full).toMatchObject({
        total: 1,
        shown: 1,
        omitted: 0,
        truncated_fields: 0,
        goals_truncated: 0,
        truncated: false,
      })
      expect(full.runs[0].goal).toBe(goal)
    } finally {
      removeProject(project)
    }
  })

  test("alg_status list reports accurate run and field truncation counts and honors full completeness", async () => {
    const project = tempProject()
    try {
      const owned = Array.from({ length: 25 }, (_, index) => createRun({
        goal: `owned run ${index} ${"g".repeat(200)}`,
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
        runId: `owned-${index.toString().padStart(2, "0")}`,
      }))
      createRun({
        goal: "other owner run",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "other-owner",
        runId: "other-owner-run",
      })
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)

      const compact = output(await tools.alg_status.execute({ list: true }, context(project)))
      expect(compact).toMatchObject({
        total: 25,
        shown: 20,
        omitted: 5,
        truncated_fields: 20,
        goals_truncated: 20,
        truncated: true,
      })
      expect(compact.runs).toHaveLength(20)
      expect(compact.runs.every((run: any) => run.goal.length === 120)).toBe(true)
      expect(compact.runs.every((run: any) => Object.keys(run).sort().join(",") === "goal,run_id,status,updated_at")).toBe(true)
      expect(compact.runs.map((run: any) => run.run_id)).not.toContain("other-owner-run")

      const full = output(await tools.alg_status.execute({ list: true, detail: "full" }, context(project)))
      expect(full).toMatchObject({
        total: 25,
        shown: 25,
        omitted: 0,
        truncated_fields: 0,
        goals_truncated: 0,
        truncated: false,
      })
      expect(full.runs).toHaveLength(25)
      expect(full.runs.map((run: any) => run.run_id).sort()).toEqual(owned.map((run) => run.run_id).sort())
      expect(full.runs.every((run: any) =>
        run.owner_session_id === "owner" &&
        run.schema_version === 2 &&
        Number.isInteger(run.revision) &&
        typeof run.project_directory === "string" &&
        typeof run.path === "string")).toBe(true)
      expect(full.runs.map((run: any) => run.run_id)).not.toContain("other-owner-run")
      expect(full.runs.some((run: any) => run.goal.length > 120)).toBe(true)
    } finally {
      removeProject(project)
    }
  })

  test("maximum prefixed SDK diagnostic persists within schema limits without leaking sentinels", async () => {
    const project = tempProject()
    const sentinel = "MAX-DIAGNOSTIC-SECRET-c64d"
    try {
      const run = createRun({
        goal: "persist maximum diagnostic",
        criteria: [],
        graph: {
          name: "maximum-diagnostic",
          max_global_attempts: 2,
          max_concurrency: 1,
          nodes: [{ id: "explore", agent: "explorer", depends_on: [], loop: { max_attempts: 2, gate: "schema" } }],
        },
        projectDirectory: project,
        ownerSessionId: "session-owner",
      })
      let creates = 0
      const noisyError = {
        status: 429,
        code: "rate_limited_maximum",
        requestId: "req-max-persisted",
        correlationId: "corr-max-persisted",
        message: `retry later Authorization: Basic ${sentinel} ${"m".repeat(10_000)}`,
        user_payload: { content: sentinel },
        requestBody: { message: [{ role: "user", content: sentinel }] },
        request_payload: { arbitrary: sentinel },
        promptContent: sentinel,
        inputData: { arbitrary: sentinel },
        ...Object.fromEntries(Array.from({ length: 24 }, (_, index) =>
          [`safeDetail${index.toString().padStart(2, "0")}`, `${index}-${"x".repeat(500)}`])),
      }
      const completed = await executeRun(run, {
        ...executeContext(project),
        client: {
          session: {
            create: async () => {
              creates++
              return creates === 1
                ? { data: undefined, error: noisyError }
                : { data: { id: "diagnostic-retry-child" }, error: undefined }
            },
            prompt: async () => ({
              data: { parts: [{ type: "text", text: JSON.stringify({
                query: "valid retry",
                map: [{ path: "src", role: "source" }],
                key_hits: [],
                next: "none",
              }) }] },
              error: undefined,
            }),
          },
        } as never,
      })
      const persisted = loadRun(project, completed.run_id)!
      const first = persisted.nodes.explore!.attempts[0]!
      expect(first.outcome).toBe("sdk_error")
      expect(first.error).toStartWith("session.create failed: ")
      expect(first.error).toContain("rate_limited_maximum")
      expect(first.error).toContain("req-max-persisted")
      expect(first.error).toContain("429")
      expect(Buffer.byteLength(first.error!, "utf8")).toBeLessThanOrEqual(2_000)
      expect(first.error!.length).toBeLessThanOrEqual(2_000)
      expect(JSON.stringify(persisted)).not.toContain(sentinel)
      expect(first.failures).toEqual([first.error!])
      expect(persisted.nodes.explore!.attempts.map((attempt) => attempt.outcome))
        .toEqual(["sdk_error", "passed"])
    } finally {
      removeProject(project)
    }
  })

  test("session SDK response errors and primitive throws use safe useful diagnostics", async () => {
    const project = tempProject()
    try {
      const nested = await runNodeSession({
        client: {
          session: {
            create: async () => ({ data: { id: "child" }, error: undefined }),
            prompt: async () => ({
              data: undefined,
              error: { response: { status: 502, data: { code: "upstream", request_id: "req-sdk", authorization: "secret" } } },
            }),
          },
        } as never,
        parentSessionId: "parent",
        agent: "explorer",
        title: "diagnostic",
        userPrompt: "map",
        directory: project,
      })
      expect(nested.error).toContain("session.prompt failed")
      expect(nested.error).toContain("502")
      expect(nested.error).toContain("upstream")
      expect(nested.error).toContain("req-sdk")
      expect(nested.error).not.toContain('"authorization":"secret"')

      const primitive = await runNodeSession({
        client: { session: { create: async () => { throw "primitive SDK throw" } } } as never,
        parentSessionId: "parent",
        agent: "explorer",
        title: "diagnostic",
        userPrompt: "map",
        directory: project,
      })
      expect(primitive.error).toContain("primitive SDK throw")
    } finally {
      removeProject(project)
    }
  })

  test("model resolution records precedence, defaults, repair identity, and old-run fallback", () => {
    const project = tempProject()
    try {
      const configured = configuredModelResolutions({
        model: "top/default",
        agent: {
          orchestrator: { model: "role/planner", variant: "deep" },
          explorer: { model: "role/explorer" },
          implementer: { model: "role/implement", variant: "careful" },
        },
      })
      expect(configured.planner).toEqual({ source: "opencode-role-config", providerID: "role", modelID: "planner", variant: "deep" })
      expect(configured.researcher.source).toBe("opencode-top-level-default")
      expect(configured.default).toMatchObject({ source: "opencode-top-level-default", providerID: "top", modelID: "default" })
      expect(configured.repair).toEqual(configured.implementer)

      const inherited = configuredModelResolutions({})
      expect(inherited.default).toEqual({ source: "inherited-sdk-default" })
      expect(inherited.checker.providerID).toBeUndefined()

      const run = createRun({
        goal: "legacy",
        criteria: [],
        graph: getTemplate("research-diamond"),
        projectDirectory: project,
        ownerSessionId: "owner",
        modelSnapshot: { explorer: { providerID: "legacy", modelID: "known" } },
      })
      const old = JSON.parse(JSON.stringify(run))
      delete old.model_resolution
      const parsed = parseRunState(old)
      expect(modelResolutionsForRun(parsed).explorer).toEqual({ source: "legacy-unknown", providerID: "legacy", modelID: "known" })
      expect(modelResolutionsForRun(parsed).default).toEqual({ source: "legacy-unknown" })

      saveModelSettings(project, { explorer: { providerID: "project", modelID: "override", variant: "strict" } })
      const snapshotted = snapshotModelResolutions(project, configured)
      expect(snapshotted.explorer).toEqual({ source: "alg-project-override", providerID: "project", modelID: "override", variant: "strict" })
    } finally {
      removeProject(project)
    }
  })

  test("compact status remains projected while full status and artifact hydrate complete typed detail", async () => {
    const project = tempProject()
    try {
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)
      const goal = `bounded-${"g".repeat(10_000)}`
      const compactPlanResult = await tools.alg_plan.execute({
        goal,
        criteria: ["c".repeat(1_500)],
        mode: "dry",
        graph_json: JSON.stringify({
          name: "compact",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        }),
      }, context(project))
      const compactPlan = output(compactPlanResult)
      expect(compactPlan.goal).toBeUndefined()
      expect(compactPlan.criteria).toBeUndefined()
      expect(compactPlan.model_resolution.default.source).toBe("inherited-sdk-default")
      expect(Buffer.byteLength((compactPlanResult as any).output)).toBeLessThan(20_000)

      const fullPlanResult = await tools.alg_plan.execute({
        goal,
        criteria: ["c".repeat(1_500)],
        mode: "dry",
        detail: "full",
        graph_json: JSON.stringify({
          name: "compact-full",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        }),
      }, context(project))
      expect(output(fullPlanResult).goal).toBe(goal)
      expect(Buffer.byteLength((fullPlanResult as any).output)).toBeGreaterThan(Buffer.byteLength((compactPlanResult as any).output))

      const runId = compactPlan.run_id
      await tools.alg_run.execute({ run_id: runId, dry: true }, context(project))
      const completed = loadRun(project, runId)!
      const largeOutput = {
        summary: Array.from({ length: 100 }, (_, index) => `${index}-${"x".repeat(1_800)}`),
        files_touched: [],
        commands_run: [],
        risks: [],
        done: true,
      }
      completed.nodes.work!.output = largeOutput
      completed.nodes.work!.status = "done"
      completed.nodes.work!.last_failures = []
      completed.nodes.work!.attempts[0] = {
        ...completed.nodes.work!.attempts[0]!,
        status: "done",
        output: largeOutput,
        failures: [],
        schema_ok: true,
        outcome: "passed",
        error: undefined,
      }
      completed.status = "done"
      completed.phase = "done"
      persistRun(completed, project)

      const compactStatusResult = await tools.alg_status.execute({ run_id: runId }, context(project))
      const fullStatusResult = await tools.alg_status.execute({ run_id: runId, detail: "full" }, context(project))
      expect((compactStatusResult as any).output).not.toContain("x".repeat(1_000))
      expect(Buffer.byteLength((compactStatusResult as any).output)).toBeLessThan(30_000)
      expect((fullStatusResult as any).output).toContain("x".repeat(1_000))
      expect(output(fullStatusResult).nodes.work.output).toEqual(largeOutput)
      expect(output(fullStatusResult).nodes.work.output_ref.byte_size).toBeGreaterThan(150_000)

      const compactArtifactResult = await tools.alg_artifact.execute({ run_id: runId, node_id: "work" }, context(project))
      const compactArtifact = output(compactArtifactResult)
      expect(compactArtifact.output).toBeUndefined()
      expect(compactArtifact.preview_truncated).toBe(true)
      expect(Buffer.byteLength(compactArtifact.preview)).toBeLessThanOrEqual(2_100)
      const fullArtifact = output(await tools.alg_artifact.execute({ run_id: runId, node_id: "work", detail: "full" }, context(project)))
      expect(fullArtifact.output).toEqual(largeOutput)
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("full run and resume retain bounded projected timing, outcome, and reference history", async () => {
    const project = tempProject()
    try {
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)
      const graph = JSON.stringify({
        name: "full-attempts",
        max_global_attempts: 2,
        max_concurrency: 1,
        nodes: [{
          id: "work",
          agent: "implementer",
          depends_on: [],
          loop: { max_attempts: 2, gate: "schema" },
        }],
      })

      const plannedRun = output(await tools.alg_plan.execute({ goal: "full run", graph_json: graph, mode: "dry" }, context(project)))
      const fullRun = output(await tools.alg_run.execute({
        run_id: plannedRun.run_id,
        dry: true,
        detail: "full",
      }, context(project)))
      expect(fullRun.nodes.work.attempts).toHaveLength(1)
      expect(fullRun.nodes.work.attempts[0]).toMatchObject({
        attempt: 1,
        status: "done",
        schema_ok: true,
        outcome: "passed",
        output_ref: { byte_size: expect.any(Number) },
      })
      expect(fullRun.nodes.work.attempts[0].started_at).toBeString()
      expect(fullRun.nodes.work.attempts[0].finished_at).toBeString()

      const plannedResume = output(await tools.alg_plan.execute({ goal: "full resume", graph_json: graph, mode: "dry" }, context(project)))
      const interrupted = loadRun(project, plannedResume.run_id)!
      const startedAt = "2026-08-09T10:00:00.000Z"
      const finishedAt = "2026-08-09T10:01:00.000Z"
      interrupted.status = "failed"
      interrupted.phase = "failed"
      interrupted.global_attempts = 1
      interrupted.nodes.work!.status = "failed"
      interrupted.nodes.work!.current_attempt = 1
      interrupted.nodes.work!.last_failures = ["first attempt SDK failure"]
      interrupted.nodes.work!.attempts = [{
        attempt: 1,
        status: "failed",
        session_id: "child-before-resume",
        started_at: startedAt,
        finished_at: finishedAt,
        failures: ["first attempt SDK failure"],
        schema_ok: false,
        error: "safe diagnostic detail",
        outcome: "sdk_error",
      }]
      persistRun(interrupted, project)

      const fullResume = output(await tools.alg_resume.execute({
        run_id: plannedResume.run_id,
        dry: true,
        detail: "full",
      }, context(project)))
      expect(fullResume.error).toBeUndefined()
      expect(fullResume.nodes.work.attempts).toHaveLength(2)
      expect(fullResume.nodes.work.attempts[0]).toMatchObject({
        attempt: 1,
        status: "failed",
        session_id: "child-before-resume",
        started_at: startedAt,
        finished_at: finishedAt,
        failures: ["first attempt SDK failure"],
        schema_ok: false,
        error: "safe diagnostic detail",
        outcome: "sdk_error",
      })
      expect(fullResume.nodes.work.attempts[1]).toMatchObject({
        attempt: 2,
        status: "done",
        schema_ok: true,
        output_ref: { byte_size: expect.any(Number) },
      })
    } finally {
      removeProject(project)
    }
  }, 60_000)

  test("maximum incomplete outputs compact every save while complete typed artifacts survive reload", async () => {
    const project = tempProject()
    try {
      const blockers = Array.from({ length: 100 }, (_, index) =>
        `blocker-${index.toString().padStart(3, "0")}-${"b".repeat(1_870)}`)
      const largeOutput = {
        summary: Array.from({ length: 25 }, (_, index) =>
          `summary-${index.toString().padStart(2, "0")}-${"s".repeat(1_870)}`),
        files_touched: [],
        commands_run: [],
        risks: [],
        done: false,
        blockers,
      }
      const outputBytes = Buffer.byteLength(JSON.stringify(largeOutput))
      expect(outputBytes).toBeGreaterThan(220 * 1024)
      expect(outputBytes).toBeLessThanOrEqual(256 * 1024)
      const run = createRun({
        goal: "project several maximum incomplete outputs",
        criteria: ["remain bounded and preserve complete artifacts"],
        graph: {
          name: "maximum-incomplete-history",
          max_global_attempts: 3,
          max_concurrency: 1,
          nodes: [{
            id: "work",
            agent: "implementer",
            depends_on: [],
            loop: { max_attempts: 3, gate: "schema" },
          }],
        },
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      const intermediateSizes: number[] = []
      let calls = 0
      const completed = await executeRun(run, {
        ...executeContext(project),
        parentSessionId: "owner",
        sessionRunner: async () => {
          if (calls > 0) {
            intermediateSizes.push(statSync(join(runDir(project, run.run_id), "progress.json")).size)
          }
          calls++
          return {
            session_id: `child-${calls}`,
            text: "",
            parsed: structuredClone(largeOutput),
          }
        },
      })
      const directory = runDir(project, run.run_id)
      const progressPath = join(directory, "progress.json")
      const finalSize = statSync(progressPath).size
      expect(calls).toBe(3)
      expect([...intermediateSizes, finalSize].every((size) => size < MAX_STATE_BYTES)).toBe(true)
      const projected = JSON.parse(readFileSync(progressPath, "utf8"))
      expect(projected.nodes.work.output).toBeUndefined()
      expect(projected.nodes.work.attempts).toHaveLength(3)
      expect(projected.nodes.work.attempts.every((attempt: any) =>
        attempt.output === undefined && attempt.output_ref && attempt.detail_ref)).toBe(true)
      expect(projected.state_projection.failure_entries_omitted).toBeGreaterThanOrEqual(3 * 99)

      const reloaded = loadRun(project, run.run_id)!
      expect(reloaded.status).toBe("failed")
      expect(reloaded.nodes.work!.attempts).toHaveLength(3)
      expect(reloaded.nodes.work!.attempts.every((attempt) =>
        JSON.stringify(attempt.output) === JSON.stringify(largeOutput))).toBe(true)
      expect(reloaded.nodes.work!.attempts.every((attempt) => attempt.failures.length === 100)).toBe(true)
      const artifactNames = readdirSync(join(directory, "artifacts"))
      for (const attempt of [1, 2, 3]) {
        const name = `work-attempt-${attempt}.json`
        expect(artifactNames).toContain(name)
        expect(JSON.parse(readFileSync(join(directory, "artifacts", name), "utf8"))).toEqual(largeOutput)
      }

      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)
      const fullArtifact = output(await tools.alg_artifact.execute({
        run_id: run.run_id,
        node_id: "work",
        detail: "full",
      }, context(project)))
      expect(fullArtifact.output).toEqual(largeOutput)
      const compactStatus = await tools.alg_status.execute({ run_id: run.run_id }, context(project))
      const fullStatus = await tools.alg_status.execute({ run_id: run.run_id, detail: "full" }, context(project))
      expect(Buffer.byteLength((compactStatus as any).output)).toBeLessThan(64 * 1024)
      expect((fullStatus as any).output).toContain("b".repeat(1_000))
      expect(output(fullStatus).nodes.work.attempts.every((attempt: any) =>
        JSON.stringify(attempt.output) === JSON.stringify(largeOutput))).toBe(true)
      expect(output(fullStatus).nodes.work.attempts[0].output_ref.byte_size).toBe(outputBytes)
    } finally {
      removeProject(project)
    }
  }, 120_000)

  test("legacy inline-output progress reloads and migrates without losing full artifact access", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "legacy inline output",
        criteria: [],
        graph: {
          name: "legacy-inline",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "owner",
        mode: "dry",
      })
      await executeRun(run, { ...executeContext(project), parentSessionId: "owner", dry: true })
      const hydrated = loadRun(project, run.run_id)!
      const expected = structuredClone(hydrated.nodes.work!.output)
      const legacy = structuredClone(hydrated) as any
      delete legacy.state_projection
      delete legacy.filesystem_root_authorizations_omitted
      for (const node of Object.values(legacy.nodes) as any[]) {
        delete node.output_ref
        delete node.attempt_history_ref
        delete node.last_failures_ref
        delete node.last_failures_omitted
        delete node.last_failure_texts_truncated
        for (const attempt of node.attempts) {
          delete attempt.output_ref
          delete attempt.detail_ref
          delete attempt.failures_omitted
          delete attempt.failure_texts_truncated
          delete attempt.error_bytes_omitted
        }
      }
      const directory = runDir(project, run.run_id)
      rmSync(join(directory, "artifacts"), { recursive: true, force: true })
      writeFileSync(join(directory, "progress.json"), `${JSON.stringify(legacy, null, 2)}\n`, "utf8")
      expect(statSync(join(directory, "progress.json")).size).toBeLessThan(MAX_STATE_BYTES)

      const reloaded = loadRun(project, run.run_id)!
      expect(reloaded.nodes.work!.output).toEqual(expected)
      expect(existsSync(join(directory, "artifacts", "work.json"))).toBe(true)
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)
      expect(output(await tools.alg_artifact.execute({
        run_id: run.run_id,
        node_id: "work",
        detail: "full",
      }, context(project))).output).toEqual(expected)

      persistRun(reloaded, project)
      const migrated = JSON.parse(readFileSync(join(directory, "progress.json"), "utf8"))
      expect(migrated.nodes.work.output).toBeUndefined()
      expect(migrated.nodes.work.output_ref).toBeDefined()
      expect(statSync(join(directory, "progress.json")).size).toBeLessThan(MAX_STATE_BYTES)
    } finally {
      removeProject(project)
    }
  }, 15_000)

  test("compact plan/run/status apply aggregate node, attempt, session, event, and byte bounds", async () => {
    const project = tempProject()
    try {
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)
      const nodeIds = Array.from({ length: 64 }, (_, index) =>
        `node-${index.toString().padStart(2, "0")}-${"i".repeat(54)}`)
      const nodes = nodeIds.map((id, index) => ({
        id,
        agent: "implementer",
        depends_on: index === 0 ? [] : [nodeIds[index - 1]],
        loop: { max_attempts: 2, gate: "schema" },
      }))
      const plannedResult = await tools.alg_plan.execute({
        goal: `aggregate-${"g".repeat(10_000)}`,
        mode: "dry",
        graph_json: JSON.stringify({
          name: "maximum-compact-graph",
          max_global_attempts: 128,
          max_concurrency: 8,
          nodes,
        }),
      }, context(project))
      const planned = output(plannedResult)
      expect(Object.keys(planned.nodes)).toHaveLength(24)
      expect(planned.truncation.nodes_omitted).toBe(40)
      expect(Buffer.byteLength((plannedResult as any).output)).toBeLessThanOrEqual(64 * 1_024)

      const compactRunResult = await tools.alg_run.execute({
        run_id: planned.run_id,
        dry: true,
        max_waves: 1,
      }, context(project))
      const compactRun = output(compactRunResult)
      expect(Object.keys(compactRun.nodes)).toHaveLength(24)
      expect(compactRun.truncation.nodes_omitted).toBe(40)
      expect(compactRun.truncation.attempts_omitted).toBe(0)
      expect(compactRun.execution_summary.wave_count).toBe(1)
      expect(Buffer.byteLength((compactRunResult as any).output)).toBeLessThanOrEqual(64 * 1_024)

      const run = loadRun(project, planned.run_id)!
      const timestamp = "2026-08-09T12:00:00.000Z"
      for (const node of Object.values(run.nodes)) {
        const longSession = `${node.id}-${"s".repeat(180)}`
        const failure = `${node.id}-${"f".repeat(1_900)}`
        node.status = "failed"
        node.current_attempt = 2
        node.output = undefined
        node.last_failures = [failure]
        node.attempts = [1, 2].map((attempt) => ({
          attempt,
          status: "failed" as const,
          session_id: `${longSession}-${attempt}`,
          started_at: timestamp,
          finished_at: timestamp,
          failures: [failure],
          schema_ok: false,
          error: `diagnostic-${"e".repeat(1_900)}`,
          outcome: "sdk_error" as const,
        }))
      }
      run.global_attempts = 128
      run.status = "failed"
      run.phase = "failed"
      run.summary = "persisted-wave-summary-" + "m".repeat(49_000)
      persistRun(run, project)

      const compactStatusResult = await tools.alg_status.execute({ run_id: run.run_id }, context(project))
      const compactStatus = output(compactStatusResult)
      expect(Object.keys(compactStatus.nodes)).toHaveLength(24)
      expect(compactStatus.truncation).toMatchObject({
        nodes_omitted: 40,
        attempts_omitted: 96,
        sessions_omitted: 96,
        aggregate_byte_limit: 64 * 1_024,
      })
      expect(compactStatus.execution_summary.persisted_summary).toContain("persisted-wave-summary")
      expect(compactStatus.execution_summary.persisted_summary_truncated).toBe(true)
      expect((compactStatusResult as any).output).not.toContain("m".repeat(2_000))
      expect(Buffer.byteLength((compactStatusResult as any).output)).toBeLessThanOrEqual(64 * 1_024)
    } finally {
      removeProject(project)
    }
  // This deliberately publishes 128 immutable attempt-detail sidecars and
  // their bounded mirrors on durable filesystems; keep every assertion and
  // allow the publication workload to complete under Windows/OneDrive fsync.
  }, 120_000)

  test("persisted root authorization audit remains visible in compact and full status", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "audit visibility",
        criteria: [],
        graph: {
          name: "audit",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "owner",
      })
      run.filesystem_root_authorizations = [
        { operation: "plan", by_session_id: "owner", authorized_at: "2026-08-09T08:00:00.000Z" },
        { operation: "run", by_session_id: "owner", authorized_at: "2026-08-09T08:01:00.000Z" },
        { operation: "resume", by_session_id: "owner", authorized_at: "2026-08-09T08:02:00.000Z" },
      ]
      persistRun(run, project)
      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)
      const compact = output(await tools.alg_status.execute({ run_id: run.run_id }, context(project)))
      const full = output(await tools.alg_status.execute({ run_id: run.run_id, detail: "full" }, context(project)))
      expect(compact.root_authorization.authorizations.map((entry: any) => entry.operation))
        .toEqual(["plan", "run", "resume"])
      expect(full.filesystem_root_authorizations).toEqual(run.filesystem_root_authorizations)
      expect(full.root_authorization.authorizations).toEqual(run.filesystem_root_authorizations)
    } finally {
      removeProject(project)
    }
  })

  test("projected root authorization history is immutable, fully hydratable, aggregated, legacy-honest, and fail-closed", async () => {
    const project = tempProject()
    try {
      const makeRun = (runId: string) => createRun({
        goal: `authorization projection ${runId}`,
        criteria: [],
        graph: {
          name: "authorization-projection",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer" as const, depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "owner",
        runId,
      })
      const authorizations = Array.from({ length: 70 }, (_, index) => ({
        operation: (["plan", "run", "resume"] as const)[index % 3]!,
        by_session_id: "owner",
        authorized_at: new Date(Date.parse("2026-08-09T08:00:00.000Z") + index * 1_000).toISOString(),
      }))
      const run = makeRun("authorization-archive")
      run.filesystem_root_authorizations = authorizations
      persistRun(run, project)
      const rawPath = join(runDir(project, run.run_id), "progress.json")
      const raw = JSON.parse(readFileSync(rawPath, "utf8")) as any
      const reference = raw.filesystem_root_authorizations_ref
      expect(reference.artifact_path.endsWith(`-${reference.sha256}.json`)).toBe(true)
      expect(raw.filesystem_root_authorizations).toHaveLength(64)
      expect(raw.filesystem_root_authorizations_omitted).toBe(6)

      const tools = createAlgTools({
        client: inertClient(),
        project: { id: "project" },
        directory: project,
        worktree: project,
      } as never)
      const compact = output(await tools.alg_status.execute({ run_id: run.run_id }, context(project)))
      expect(compact.root_authorization).toMatchObject({
        authorization_count: 70,
        authorizations_retained: 64,
        authorizations_omitted: 6,
        authorizations_displayed: 8,
        operation_counts: { plan: 24, run: 23, resume: 23 },
        operation_counts_complete: true,
        operation_counts_unknown: 0,
      })
      const full = output(await tools.alg_status.execute({ run_id: run.run_id, detail: "full" }, context(project)))
      expect(full.filesystem_root_authorizations).toEqual(authorizations)
      expect(full.root_authorization.authorizations).toEqual(authorizations)

      const legacy = structuredClone(raw)
      delete legacy.filesystem_root_authorizations_ref
      writeFileSync(rawPath, `${JSON.stringify(legacy)}\n`, "utf8")
      const legacyFull = output(await tools.alg_status.execute({ run_id: run.run_id, detail: "full" }, context(project)))
      expect(legacyFull.filesystem_root_authorizations).toHaveLength(64)
      expect(legacyFull.root_authorization).toMatchObject({
        authorization_count: 70,
        authorizations_retained: 64,
        authorizations_omitted: 6,
        operation_counts_complete: false,
        operation_counts_unknown: 6,
      })

      const corrupt = makeRun("authorization-corrupt")
      corrupt.filesystem_root_authorizations = authorizations
      persistRun(corrupt, project)
      const corruptRaw = JSON.parse(readFileSync(join(runDir(project, corrupt.run_id), "progress.json"), "utf8")) as any
      rmSync(join(project, ...corruptRaw.filesystem_root_authorizations_ref.artifact_path.split("/")))
      const failed = output(await tools.alg_status.execute({ run_id: corrupt.run_id, detail: "full" }, context(project)))
      expect(failed.error).toContain("missing or inaccessible")
    } finally {
      removeProject(project)
    }
  }, 15_000)

  test("compact root verification rejects a forged per-operation distribution with the same total", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "forged root distribution",
        criteria: [],
        graph: {
          name: "forged-root-distribution",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "owner",
        runId: "forged-root-distribution",
      })
      run.filesystem_root_authorizations = Array.from({ length: 70 }, (_, index) => ({
        operation: (["plan", "run", "resume"] as const)[index % 3]!,
        by_session_id: "owner",
        authorized_at: new Date(Date.parse("2026-08-09T08:00:00.000Z") + index * 1_000).toISOString(),
      }))
      persistRun(run, project)
      const progress = join(runDir(project, run.run_id), "progress.json")
      const raw = JSON.parse(readFileSync(progress, "utf8")) as any
      expect(raw.filesystem_root_authorizations_ref.operation_counts)
        .toEqual({ plan: 24, run: 23, resume: 23 })
      raw.filesystem_root_authorizations_ref.operation_counts = { plan: 25, run: 22, resume: 23 }
      writeFileSync(progress, `${JSON.stringify(raw)}\n`, "utf8")

      const tools = createAlgTools({
        client: inertClient(), project: { id: "project" }, directory: project, worktree: project,
      } as never)
      const compact = output(await tools.alg_status.execute({ run_id: run.run_id }, context(project)))
      expect(compact.error).toContain("filesystem root authorization history aggregate mismatch")
    } finally {
      removeProject(project)
    }
  }, 15_000)

  test("compact run and resume use one committed root projection above 64 approvals", async () => {
    const project = tempProject("alg-root-compact-consistency-")
    try {
      const run = createRun({
        goal: "compact root consistency",
        criteria: [],
        graph: {
          name: "compact-root-consistency",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "owner",
        runId: "compact-root-consistency",
        mode: "dry",
      })
      run.filesystem_root_authorizations = Array.from({ length: 64 }, (_, index) => ({
        operation: "plan" as const,
        by_session_id: "owner",
        authorized_at: new Date(Date.parse("2026-08-09T08:00:00.000Z") + index * 1_000).toISOString(),
      }))
      persistRun(run, project)
      const tools = createAlgTools({
        client: inertClient(), project: { id: "project" }, directory: project, worktree: project,
      } as never, undefined, undefined, { additionalFilesystemRoot: (path) => path === project })

      const ran = output(await tools.alg_run.execute({
        run_id: run.run_id,
        dry: true,
        allow_filesystem_root: true,
      }, context(project)))
      expect(ran.root_authorization).toMatchObject({
        authorization_count: 65,
        authorizations_retained: 64,
        authorizations_omitted: 1,
        authorizations_displayed: 8,
        authorizations_display_omitted: 56,
        operation_counts: { plan: 64, run: 1, resume: 0 },
        operation_counts_complete: true,
        operation_counts_unknown: 0,
      })
      expect(ran.state_projection.root_authorizations_omitted).toBe(1)

      const resumed = output(await tools.alg_resume.execute({
        run_id: run.run_id,
        dry: true,
        allow_filesystem_root: true,
      }, context(project)))
      expect(resumed.root_authorization).toMatchObject({
        authorization_count: 66,
        authorizations_retained: 64,
        authorizations_omitted: 2,
        authorizations_displayed: 8,
        authorizations_display_omitted: 56,
        operation_counts: { plan: 64, run: 1, resume: 1 },
        operation_counts_complete: true,
        operation_counts_unknown: 0,
      })
      expect(resumed.state_projection.root_authorizations_omitted).toBe(2)
    } finally {
      removeProject(project)
    }
  }, 30_000)

  test("legacy failure commitments report weaker verification and migrate on save", async () => {
    const project = tempProject()
    try {
      const run = createRun({
        goal: "legacy failure commitment",
        criteria: [],
        graph: {
          name: "legacy-failure-commitment",
          max_global_attempts: 1,
          max_concurrency: 1,
          nodes: [{ id: "work", agent: "implementer", depends_on: [] }],
        },
        projectDirectory: project,
        ownerSessionId: "owner",
        runId: "legacy-failure-commitment",
      })
      const progress = join(runDir(project, run.run_id), "progress.json")
      const legacy = JSON.parse(readFileSync(progress, "utf8")) as any
      delete legacy.nodes.work.last_failures_commitment
      writeFileSync(progress, `${JSON.stringify(legacy)}\n`, "utf8")
      const tools = createAlgTools({
        client: inertClient(), project: { id: "project" }, directory: project, worktree: project,
      } as never)

      const compact = output(await tools.alg_status.execute({ run_id: run.run_id }, context(project)))
      expect(compact.failure_verification).toMatchObject({
        algorithm: "sha256",
        projections: 1,
        committed: 0,
        legacy_uncommitted: 1,
        complete: false,
      })
      expect(compact.failure_verification.note).toContain("weaker compatibility verification")
      const full = output(await tools.alg_status.execute({ run_id: run.run_id, detail: "full" }, context(project)))
      expect(full.failure_verification.complete).toBe(false)

      const loaded = loadRun(project, run.run_id)!
      persistRun(loaded, project)
      const migrated = parseRunState(JSON.parse(readFileSync(progress, "utf8")))
      expect(migrated.nodes.work!.last_failures_commitment).toMatchObject({
        algorithm: "sha256",
        entry_count: 0,
      })
    } finally {
      removeProject(project)
    }
  }, 15_000)
})

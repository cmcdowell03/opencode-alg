import type { Plugin } from "@opencode/plugin"
import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { relative, sep } from "node:path"
import { z } from "zod"
import { runContainedPath } from "../../../src/store.ts"
import { publishReceipt } from "./journal.ts"

// The caller binds the decision to observed reads. Shape validation alone cannot
// establish that a cited row supports an interpretation.
const text = z.string().max(2048).refine(value => value.trim().length > 0)
const reference = z.string().min(1).max(1024)
const reportSchema = z.strictObject({
  disposition: z.enum(["resolved", "indeterminate"]),
  claims: z.array(z.strictObject({
    finding: text,
    scope: text,
    evidence: z.array(reference).min(1).max(64),
  })).max(64),
  missingEvidence: z.array(reference).max(64),
})

export function renderInvestigationReport(report: unknown): string {
  const parsed = reportSchema.safeParse(report)
  if (!parsed.success || (parsed.data.disposition === "resolved" &&
      (!parsed.data.claims.length || parsed.data.missingEvidence.length))) {
    throw new Error("REPORT_CONTRACT_INVALID")
  }
  const json = JSON.stringify(parsed.data)
  if (Buffer.byteLength(json) > 65536) throw new Error("REPORT_TOO_LARGE")
  return json
}

type SessionID = Parameters<Plugin.Context["session"]["synthetic"]>[0]["sessionID"]
type Current = { runId: string; revision: number; report: unknown }

/** An explicit user command delivers the acknowledged revision without a generation. */
export function registerReportCommand(
  ctx: { command: Pick<Plugin.Context["command"], "transform">; session: Pick<Plugin.Context["session"], "synthetic"> },
  directory: string,
  readCurrent: (sessionID: SessionID) => Promise<Current>,
) {
  return ctx.command.transform(editor => editor.add({
    name: "alg-report",
    description: "Export the current acknowledged investigation decision as JSON",
    async execute({ sessionID }) {
      const current = await readCurrent(sessionID)
      if (!Number.isSafeInteger(current.revision) || current.revision < 1) throw new Error("REPORT_REVISION_INVALID")
      const json = renderInvestigationReport(current.report)
      const bytes = Buffer.from(json + "\n")
      const digest = createHash("sha256").update(bytes).digest("hex")
      const path = runContainedPath(directory, current.runId, "reports", "decision-" + current.revision + ".json")
      const created = await publishReceipt(path, JSON.parse(json))
      if (!created) {
        const file = await open(path, "r")
        try {
          if ((await file.stat()).size !== bytes.length || !(await file.readFile()).equals(bytes)) {
            throw new Error("REPORT_REVISION_CONFLICT")
          }
        } finally { await file.close() }
      }
      const reportPath = relative(directory, path).split(sep).join("/")
      // Keep the report in a native receipt and a directly readable file. The
      // model-facing message contains only a host-generated path and digest.
      await ctx.session.synthetic({
        sessionID, delivery: "queue", resume: false,
        text: "ALG exported the acknowledged investigation report to " + reportPath + " (SHA-256 " + digest + ").",
        description: "Investigation report · " + reportPath,
        metadata: { algReport: { version: 1, revision: current.revision, path: reportPath, sha256: digest } },
      })
    },
  }))
}

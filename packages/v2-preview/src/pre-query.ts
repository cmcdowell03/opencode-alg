import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { realpath } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { promisify, TextDecoder } from "node:util"
import { z } from "zod"
import { canonicalJson } from "../../../src/persistence.ts"
import { readSkillEvolutionDirectBounded } from "../../../src/skill-evolution-store.ts"
import { projectPathSchema, procedureDigestSchema, procedurePinSchema, type ProcedurePin } from "../core/procedure-pin.ts"
import { PreQueryBlockedError, type PreQueryGate, type PreQueryReceipt } from "../core/pre-query.ts"
import type { ResearchProcedure } from "./procedure.ts"

export { PreQueryBlockedError } from "../core/pre-query.ts"

const revisionSchema = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/)
export const preQueryPolicySchema = z.object({
  procedure: procedurePinSchema,
  prerequisite: z.object({
    kind: z.literal("committed_clock_alignment"),
    revision: revisionSchema,
    path: projectPathSchema.refine(path => /^[A-Za-z0-9._/-]+\.json$/.test(path)),
    sha256: procedureDigestSchema,
  }).strict(),
}).strict()

const scopeSchema = z.object({
  project_id: z.string().min(1).max(512),
  operation: z.string().min(1).max(128),
  recipe_version: z.string().min(1).max(128),
  cohort: z.string().min(1).max(512),
  as_of: z.string().min(1).max(128).nullable(),
  source_dependencies: z.array(z.string().min(1).max(512)).min(1).max(128),
  preprocessing_revision: z.string().min(1).max(128),
}).strict()

const evidenceSchema = z.object({
  schema_version: z.literal(1),
  kind: z.literal("clock_alignment_sample"),
  scope: scopeSchema,
  sampled_rows: z.number().int().positive(),
  max_abs_skew_ms: z.number().finite().nonnegative(),
  tolerance_ms: z.number().finite().nonnegative(),
}).strict()

const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex")
const exec = promisify(execFile)
const maxEvidenceBytes = 16 * 1024

function gitEnv() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key))),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_LAZY_FETCH: "1",
  }
}

async function readCommittedEvidence(directory: string, pin: z.output<typeof preQueryPolicySchema>["prerequisite"]) {
  const git = async (...args: string[]) => (await exec("git",
    ["--no-replace-objects", "--no-lazy-fetch", "--no-optional-locks", ...args], {
      cwd: directory, env: gitEnv(), windowsHide: true, encoding: "buffer",
      timeout: 2_000, maxBuffer: maxEvidenceBytes,
    })).stdout

  const root = (await git("rev-parse", "--show-toplevel")).toString("utf8").trimEnd()
  if (relative(directory, await realpath(root)) !== "" ||
      (await git("cat-file", "-t", pin.revision)).toString("ascii").trim() !== "commit") throw new Error()
  const entry = (await git("ls-tree", "-z", "--full-tree", pin.revision, "--", ":(literal)" + pin.path)).toString("utf8")
  const match = /^100(?:644|755) blob ([0-9a-f]+)\t([^\0]+)\0$/.exec(entry)
  if (!match?.[1] || match[2] !== pin.path) throw new Error()
  const bytes = await git("cat-file", "blob", match[1])
  if (sha256(bytes) !== pin.sha256) throw new Error()
  return evidenceSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)))
}

type Policy = z.input<typeof preQueryPolicySchema>
type ObservedActivation = (sessionId: string, pin: Readonly<ProcedurePin>) => boolean | Promise<boolean>

/** An operator pins the procedure and a committed sample attestation together. */
export function createPreQueryGate(
  input: Policy | undefined,
  procedures: ResearchProcedure,
  observedActivation?: ObservedActivation,
): PreQueryGate | undefined {
  if (!input) return undefined
  const policy = preQueryPolicySchema.parse(input)
  const { procedure, prerequisite } = policy
  const procedureIdentity = canonicalJson(procedure)
  const policySha256 = sha256(canonicalJson(policy))

  function verifyLocalApproval(decisionPin: ProcedurePin | undefined) {
    if ((decisionPin && canonicalJson(decisionPin) !== procedureIdentity) ||
        !procedures.approvalFile || /^(?:1|true)$/i.test(process.env.OPENCODE_DISABLE_FILEWATCHER ?? "")) throw new Error()
    const read = (path: string, maximum: number) =>
      readSkillEvolutionDirectBounded(procedures.directory, resolve(procedures.directory, path), maximum, "research procedure")
    const approval = read(procedures.approvalFile, 4096)
    if (sha256(approval) !== procedures.approvalSha256 ||
        canonicalJson(procedurePinSchema.parse(JSON.parse(approval.toString("utf8")))) !== procedureIdentity ||
        sha256(read(procedure.path, 64 * 1024)) !== procedure.sourceSha256) throw new Error()
  }

  function assertCurrent(receipt: PreQueryReceipt, decisionPin: ProcedurePin | undefined) {
    try {
      verifyLocalApproval(decisionPin)
    } catch {
      throw new PreQueryBlockedError({
        ...receipt, skill: { ...receipt.skill, availability: "unverified" },
        prerequisite: { status: "unchecked" }, reuse: null,
      })
    }
  }

  const dependencies = (items: string[]) => [...new Set(items)].sort()
  return {
    policySha256,
    async evaluate(binding, job, decisionPin) {
      let activation: PreQueryReceipt["skill"]["activation"] = "not_observed"
      try {
        if (await observedActivation?.(binding.owner_id, structuredClone(procedure))) activation = "observed"
      } catch {
        // An unavailable observation must not be inferred from skill availability.
      }
      const receipt: PreQueryReceipt = {
        skill: {
          pin: structuredClone(procedure),
          availability: "unverified",
          activation,
        },
        prerequisite: { status: "unchecked" },
        reuse: null,
      }
      try {
        if (relative(binding.project_directory, procedures.directory) !== "") throw new Error()
        verifyLocalApproval(decisionPin)
        await procedures.require(procedure)
      } catch {
        throw new PreQueryBlockedError(receipt)
      }
      receipt.skill.availability = "verified"
      try {
        const evidence = await readCommittedEvidence(binding.project_directory, prerequisite)
        const expected = scopeSchema.safeParse({
          project_id: binding.project_id, operation: job.operation, recipe_version: job.recipe_version,
          cohort: job.cohort, as_of: job.as_of ?? null, source_dependencies: dependencies(job.source_dependencies),
          preprocessing_revision: job.preprocessing_revision,
        })
        const actual = { ...evidence.scope, source_dependencies: dependencies(evidence.scope.source_dependencies) }
        if (!expected.success || canonicalJson(expected.data) !== canonicalJson(actual)) {
          receipt.prerequisite = { status: "scope_mismatch" }
        } else if (evidence.max_abs_skew_ms > evidence.tolerance_ms) {
          receipt.prerequisite = { status: "tolerance_exceeded" }
        } else {
          const { revision, path, sha256 } = prerequisite
          const { sampled_rows, max_abs_skew_ms, tolerance_ms } = evidence
          receipt.prerequisite = { status: "satisfied", evidence: {
            revision, path, sha256, sampled_rows, max_abs_skew_ms, tolerance_ms,
          } }
        }
      } catch {
        receipt.prerequisite = { status: "unverified" }
      }
      assertCurrent(receipt, decisionPin)
      if (receipt.prerequisite.status !== "satisfied") throw new PreQueryBlockedError(receipt)
      return receipt
    },
    assertCurrent,
  }
}

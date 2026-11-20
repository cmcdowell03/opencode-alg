import { approvedJob } from "../acceptance/service.ts"
import { sha256, withTimeout } from "../acceptance/runtime.ts"
import type { ProcedurePin } from "../core/procedure-pin.ts"

export const handoffJob = {
  ...approvedJob, cohort: "fab-clock-calibration", preprocessing_revision: "clock-normalized-v1",
}

export async function stageGate(git: string, project: string, projectId: string, procedure: ProcedurePin) {
  async function object(args: string[], stdin: string) {
    const child = Bun.spawn([git, ...args], { cwd: project, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" })
    const capture = Promise.all([child.exited, new Response(child.stdout).text()])
    const [code, text] = await withTimeout(capture, 5000, "Git fixture object deadline").catch(error => {
      child.kill()
      throw error
    })
    const hash = text.trim()
    if (code !== 0 || !/^[a-f0-9]{40}$/.test(hash)) throw new Error("Could not write isolated pre-query fixture object")
    return hash
  }

  const path = "clock-alignment.json"
  const body = JSON.stringify({
    schema_version: 1, kind: "clock_alignment_sample",
    scope: {
      project_id: projectId, operation: handoffJob.operation, recipe_version: handoffJob.recipe_version,
      cohort: handoffJob.cohort, as_of: null, source_dependencies: handoffJob.source_dependencies,
      preprocessing_revision: handoffJob.preprocessing_revision,
    },
    sampled_rows: 8, max_abs_skew_ms: 3, tolerance_ms: 5,
  })
  // Create immutable fixture objects without updating a ref or committing in the checkout.
  const blob = await object(["hash-object", "-w", "--stdin"], body)
  const tree = await object(["mktree"], `100644 blob ${blob}\t${path}\n`)
  const signer = "Handoff Fixture <local@example.invalid> 1700000000 +0000"
  const revision = await object(["hash-object", "-w", "-t", "commit", "--stdin"],
    `tree ${tree}\nauthor ${signer}\ncommitter ${signer}\n\nSynthetic local clock-alignment attestation\n`)
  return { procedure, prerequisite: { kind: "committed_clock_alignment", revision, path, sha256: sha256(body) } }
}

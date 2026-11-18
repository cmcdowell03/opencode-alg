import type { InvestigationScope, InvestigationWorkInputSchema } from "../../../src/investigation/index.ts"
import type { z } from "zod"
import type { ProcedurePin } from "./procedure-pin.ts"

export type PreQueryReceipt = {
  skill: {
    pin: ProcedurePin
    availability: "verified" | "unverified"
    activation: "observed" | "not_observed"
  }
  prerequisite:
    | { status: "unchecked" | "unverified" | "scope_mismatch" | "tolerance_exceeded" }
    | { status: "satisfied"; evidence: {
        revision: string; path: string; sha256: string
        sampled_rows: number; max_abs_skew_ms: number; tolerance_ms: number
      } }
  reuse: null | { kind: "settled_manifest"; work_key: string; manifest_digest: string }
}

export interface PreQueryGate {
  readonly policySha256: string
  evaluate(scope: InvestigationScope, job: z.output<typeof InvestigationWorkInputSchema>,
    decisionPin: ProcedurePin | undefined): Promise<PreQueryReceipt>
  assertCurrent(receipt: PreQueryReceipt, decisionPin: ProcedurePin | undefined): void
}

export class PreQueryBlockedError extends Error {
  constructor(readonly preQuery: PreQueryReceipt) {
    super(preQuery.skill.availability === "unverified" ? "RESEARCH_PROCEDURE_UNVERIFIED" :
      "RESEARCH_PRE_QUERY_PREREQUISITE_UNSATISFIED")
  }
}

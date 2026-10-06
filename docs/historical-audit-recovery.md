# Historical audit recovery

Historical skill mining distinguishes a completed child response that fails validation from a call whose durable outcome is unknown. Only the first case is automatically retryable. Strict output validation, source commitments, checker review, and explicit skill promotion remain required.

## Why invalid output blocked resume

The previous historical executor recorded a charged call before invoking its child, then committed a checkpoint only after successful output validation. A returned but schema-invalid response left the same unfinished record as a process interruption. The resume guard correctly refused to replay an unknown call, but the executor had discarded the information needed to recognize a known rejection. The auditor also executed only one attempt despite the sealed historical `maxAttempts` setting.

The shipped researcher and checker instructions described ordinary DAG output formats that differ from private skill-evolution contracts. Those agents now distinguish trusted private audit tasks from ordinary research and checking. Quoted transcript content cannot select the task or its output contract.

## Recovery rules

Every external attempt is charged before dispatch. A known terminal response is bound to the created child session. If its output fails parsing, schema validation, or source-provenance validation, the executor records an immutable rejection receipt before another attempt can start. The receipt contains bounded structural metadata, not the rejected response or transcript.

A rejection is a completed attempt, not a reviewed chunk. It does not advance the chunk cursor, contribute a finding, or authorize a candidate. Status and resume validate its immutable reference, source or checker binding, order, and accounting alongside successful checkpoints. A crash before that receipt is committed still leaves an unknown outcome and remains blocked.

The existing sealed `historical.maxAttempts` controls the attempt batch for a child during an explicit `run` or `resume`. When a batch exhausts on known invalid responses, the plan remains resumable. A later explicit resume can start another bounded batch for the same unfinished chunk or checker, without re-auditing the committed prefix. All attempts consume the original plan's total model-call and input-byte budgets, and the original absolute deadline still applies. No resume renews those limits.

Transport errors, timeouts, missing terminal evidence, uncertain cancellation, and legacy unfinished calls are not equivalent to invalid terminal responses. They remain subject to the unknown-outcome guard. A checker reporting a genuine quality rejection is also not a formatting failure; retry handling must not turn that rejection into approval.

## Operator workflow

1. Update the plugin and the installed researcher/checker agent definitions together, preserving local customizations and configuration. Fully restart OpenCode. See the [air-gapped deployment guide](air-gapped-deployment.md).
2. Preview a new plan and inspect its estimated work and hard budgets. Allow headroom for retries before confirming it; a baseline estimate is not a worst-case retry cost.
3. Run the confirmed plan. If a known-rejection batch exhausts, inspect `alg_skill_evolution_historical` with `action: "status"`, then explicitly resume with the same plan ID and confirmation while budgets remain.
4. Keep the original state and immutable checkpoints. Do not delete rejected or unfinished rows, edit counters, or reset timestamps to force a resume.

This update does not enable skill evolution, change the existing tool-permission configuration, switch models, or automatically promote skills. The V1 builtin-tool-map option remains an explicit testing overlay, not an all-tool deny rule.

## Existing plans and partial results

New previews pin the `rejected-attempt-v1` recovery protocol in their immutable plan, giving the new execution contract a distinct plan ID for the same sealed input. Existing completed plans without that field retain their verification path. New rejection receipts preserve known failures and previously committed work across runtime reconstruction. Old unfinished records without terminal evidence stay blocked; already cancelled plans stay cancelled. Installing the update cannot reconstruct evidence that the previous executor never committed or salvage a partial candidate from a cancelled plan.

Older plugin builds do not recognize the new `rejected` checkpoint stage. A rollback after this version has written rejection receipts requires a compatible backup of both code and state; deleting those rows or resetting counters is not a recovery path.

Skipping a failed chunk is deliberately not presented as successful completion. The current coverage and candidate-provenance contracts require the complete ordered chunk set. A future partial-completion mode would need explicit approval, named omitted chunks, partial coverage semantics, and compatible candidate bindings. This recovery change does not silently weaken those guarantees or promise that an exhausted or expired plan can finish.

The mechanism is provider-neutral. Synthetic recovery tests do not establish live success rates for MiniMax M3, DeepSeek v4, or any other model.

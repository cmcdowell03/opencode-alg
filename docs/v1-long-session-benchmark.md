# V1 paired session continuity benchmark

The `long-session` workload extends the existing Build/ALG runner. It records live, externally graded obligations before and after controller handoff, requested compaction, and restart. It does not add a production store, change model routing, or implement OpenCode V2.

## Protocol

Two synthetic incidents each have four continuity cells: H0C0, H0C1, H1C0, H1C1. H selects a new controller; C selects one requested compaction. Every cell pairs native Build and ALG using the same model, evidence, service, permissions and cumulative limits. The eight pairs are issued together before execution; failed or unstarted arms stay in the result. Within an incident the data are identical across cells. Seeded scheduling alternates arm order.

The useful initial task combines factory evidence discovery in an 11,000-entry catalog with recovery of an accepted remote query or a partially completed investigation containing stale/unavailable evidence. The public mission specifies current source checks, complete bounded result reads, cumulative accepted-work limits and output contracts. Subsequent prompts contain only the mission/workspace pointer and a new phase/nonce. They do not repeat the answers or the obligations being tested.

| Checkpoint | Intervention before independent grading |
| --- | --- |
| Q0 | Initial task, before any requested transition |
| QH | New controller in H1; matched same-controller continuation in H0 |
| QC | Requested summary in C1; matched continuation in C0 |
| QR | Host restart, after QC has been graded |

ALG handoff uses the existing `alg_transfer` tool and exactly owned run discovery, including its target-session checks and allowance binding. Unsupported transfers remain failures. Build receives the same workspace and task pointer through a new native session. Time, observed turns, reported usage components and accepted service work are never reset. Native auto-compaction and pruning remain enabled in every cell; there is no reduced context capacity or artificial padding to manufacture a long session.

## Evidence and limits

`live-obligations.json` persists the external freeze before each intervention and updates after each checkpoint. Its provisional boundary census is qualified against the final stopped-host database in `live-obligations-final.json` and `result.json`. Evidence is private to the evaluator, outside the contestant workspace. A bounded service observer records real public operations and reply envelopes; recorder failure or overflow invalidates coverage. The observer caps operations at 10,000 and the runner caps its private trace at 64 MiB. Missing telemetry cannot become a pass.

The grader reuses existing independent task scorers and service accounting. It additionally checks the current phase nonce and fresh service activity in each sequence-delimited window. A retained report alone is not proof of a new lookup or source validation. Accepted computations and work units are distinct from attempted or idempotent submissions. Fresh source verification is required work, not a duplicate computation.

A regression requires an independently correct **latest** pre-transition behavior and an independently wrong post-transition behavior for the same truth digest. Incorrect and unknown pre-states remain separate. Missing follow-up after a completed summary stays exposed and contributes to the descriptive lower/upper bounds. A phase nonce is a new obligation epoch, not a forgotten fact. Another native compaction during a post-window makes that single-transition comparison unknown rather than assigning the combined effect to the requested boundary.

The result contains all-issued task outcomes, checkpoint/exposure counts, arm-specific eligibility, common pre-correct eligibility, exclusive eligibility and regression/missingness counts by transition. The primary comparison is task success across all issued pairs. Common-eligible rates are conditional on prior behavior, not a causal estimate. Failures are retained even if a later checkpoint recovers.

Passive host telemetry still reports observed native/requested summaries, session/child turns, elapsed time, usage and tool calls. Pruning visibility, hidden context contents, the exact loss mechanism, complete provider billing, and active-time coverage remain unknown where the host cannot establish them. Declaring a procedure version is not proof of loading or trusting a skill. An accurate report is not proof of a causal factory diagnosis.

This is a same-user development benchmark, not an OS-isolated confirmation study. A completed short run qualifies only its measured boundaries; it does not demonstrate multi-hour reliability or ALG superiority. Do not pool obligations as independent experiments or drop failed arms to improve a rate.

## Local execution

First qualify the exact fixture, service, reference and grader sources locally:

```text
bun scripts/build-benchmark-long-qualification.ts <new-qualification.json>
bun scripts/build-benchmark.ts <non-secret-config.json>
```

The configuration uses `workload: "long-session"`, an existing host executable, provider/model configuration, an optional local auth-file **path**, a new output directory, the qualification receipt path in `hardQualification`, `orderSeed`, and explicit `hardLimits`. Never put credentials in the configuration or publish private message logs. `suiteMs` must accommodate all sixteen `trialMs` envelopes. A useful proposed development envelope is 30 minutes, 256 observed assistant turns, 2,000,000 reported usage components and 4,096 output tokens per arm, with a ten-hour suite ceiling. These are maximums, not a duration target, and polling can overshoot observed counters.

The receipt is source-bound and fail-closed: changed fixture/runner/grader/metric sources, missing controls or an inconsistent grade require new local qualification. `preflightOnly: true` checks host registration and configured model availability without issuing model work. It is not proof that OAuth refresh, paid generation or account quota will work. A provider preflight failure is recorded before issuing a new paid cohort; do not knowingly issue sixteen arms into an unavailable provider or selectively replay failed arms.

Local deterministic host checks and scorer tests qualify apparatus only. Actual model-run results must be published separately with exact source identity, all issued outcomes, observed duration, compaction exposure and cleanup. Historical L1 results remain unchanged.

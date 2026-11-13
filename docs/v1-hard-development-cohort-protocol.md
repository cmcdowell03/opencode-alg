# V1 hard development comparison

This is the next development measurement for PR #14, not independent confirmation
or a promise that ALG wins. The earlier short-budget controls remain unchanged.
The goal is to find failures on meaningful tasks with enough effort to solve them,
then improve the model-agnostic runtime from those failures.

## Admission and frozen scope

Use all six fixtures returned by `createHardBenchmarkFixtures`: accepted-query
lost acknowledgement, API/client integration, true factory effect, confounded
factory association, insufficient factory evidence, and partial-investigation
service restart. Keep their original criteria, protected inputs and graders.
Neither a service restart nor child replacement counts as model compaction.

Before any model generation, require local positive, negative and tamper
qualification for all six fixtures, plus public HTTP qualification for both
service fixtures. Persist the computed receipt and bind its source hashes in the
runner. Also require the candidate's local runtime/package checks and actual V1
headless child recovery checks on Windows and Linux. Record exact runtime,
harness, fixture, service, qualification, host and model identities before issuance.

Use one fixed model and host for all twelve arms. The first cohort selects
`openai/gpt-6.1-terra` on the locally available Windows V1 host. This is an
evaluation choice only; no runtime branch, prompt exception or retry policy may
depend on that name. Provider authentication is copied only to temporary isolated
test configuration and removed at exit; credential values are not evidence.

## Equal headroom and ordering

Both arms have the same prospective envelope:

| Measure | Limit |
| --- | ---: |
| Active arm deadline | 30 minutes |
| Observed assistant turns, root plus descendants | 256 |
| Cumulative reported usage components | 2,000,000 |
| Configured output limit per generation | 4,096 tokens |
| Whole cohort deadline, including setup and cleanup | 7 hours |
| Case and initial-arm order seed | 20261113 |

The runner deterministically orders all six cases and alternates Build/ALG arm
order. No case selection, adaptive extra attempts, arm-specific top-up or silent
restart is permitted after issuance. Natural compaction is enabled at the same
catalog context capacity for both arms; no artificial context reduction or
requested compaction is added to this L1 cohort. ALG's durable dispatch limit is
an additional product constraint, not a claim that Build has an identical ledger.

Turn and usage-component cutoffs are observed by polling and may overshoot. The
component sum includes cache/reasoning fields and is not billed tokens. Actual
invoice cost and complete provider-side admission are not established. Publish
observed usage, missingness, late work and cleanup separately from quality.

## Decision and interpretation

Primary outcome is independently verified task completion against every required
criterion. Report paired wins/losses/ties, each failed criterion, mechanical
failures, accepted/duplicate service work, duration, observed usage and intervention.
Keep every issued arm, including timeout, auth failure and runner failure, in the
operational denominator. Unknown grades remain unknown, never passes or exclusions.
Substantive checker rejection and host/extraction failures are separate categories.

The public service interface is identical for both arms and exposes no grading or
administrative route. Its durable state and the scorer remain outside the task
workspace. However, an unrestricted shell under the same OS user is not isolated
from those files: this cohort is explicitly development-only and cannot establish
a holdout or adversarial security boundary. A later superiority claim requires
fresh independent confirmation with qualified isolation and repeated-testing rules.

Report observed natural compaction separately from linked completed summaries and
verified continuation. Zero observed boundaries provides no information-loss
estimate. This cohort does not replace paired long-session retention testing with
pre-boundary obligations and independently scored post-boundary behavior.

After the terminal result, classify concrete losses and choose the next repair.
Do not weaken the fixture or reinterpret the primary outcome to obtain a win.

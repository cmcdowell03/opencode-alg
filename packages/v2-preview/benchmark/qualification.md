# OpenCode 2 preview qualification

Freeze the benchmark source, runtime digest and these criteria before the live
comparison. Run local scripted controls first on Windows and Linux. Both arms
use the same host, model, procedure, input and scoped source tools. ALG also
has a governed calibration job. Record that work separately from the common
evidence searches.

## Decision rules

1. **Preview mechanics.** Require passing V2 tests and type checking, real host
   summary delivery, scoped evidence access and active and revoked handoffs.
   Exercise a near miss where the causal claim must be withheld and an extended
   workload spanning multiple actual compactions. A scripted response qualifies
   the harness and supplies no estimate of model performance.
2. **Live preview workflow.** Use one active Luna pair, ALG first, at the existing
   request, token and time caps. Require a delivered independent correction,
   one accepted calibration computation, reuse of its settled manifest, the
   corrected cited refutation in durable state across compaction, and an accurate
   post-compaction decision without an additional expensive search. Require the
   final package's digest in the receipt. Retain denials, retries, abstentions,
   incomplete arms and all usage. A failed or incomplete live workflow keeps
   the preview in draft. Build's own success or failure does not decide this gate.
3. **Comparative performance.** The primary endpoint is an evidence-supported
   final decision, including abstention when the evidence cannot establish a
   cause. Report unsupported claims, eligible obligations lost or contradicted per
   compaction, accepted and duplicate searches, tokens and elapsed time. Keep
   observations of summary exposure, brief projection and data reads distinct
   from conclusions about what caused the answer.

## Scope of a superiority claim

The tuned calibration incident is a regression case. Crossing its release gate
could establish that the workflow runs end to end. To claim an advantage over
Build, freeze new, unseen incidents, oracle evidence and scoring before opening
either arm's results. Include causal positives, plausible near misses, authority
withdrawal and longer investigations with independent intervening work.
Counterbalance arm order within each class. Repeat runs of the same incident
measure variability and count as one incident for inference.

Publish disagreements and ties as well as overall accuracy. For a directional
claim, require a positive paired accuracy difference with a prespecified 95%
confidence interval excluding zero on independent held-out incidents, and zero
unauthorized actions or duplicate expensive submissions by ALG. Size that live
study for a meaningful improvement before allocating calls. A single paid pair
and deterministic transport exercises cannot meet that criterion.

The offline evaluator accepts independently assessed paired receipts and a
separately published study plan:

```sh
bun packages/v2-preview/benchmark/superiority.ts evidence.json plan.json PUBLISHED_PLAN_SHA256 PUBLICATION_UTC
```

The study owner verifies the plan's publication time, the provenance of the
receipts and the independence of the incident groups. The evaluator checks the
supplied identities, timing, matched controls, coverage and outcomes. It uses
conservative simultaneous binomial bounds on paired wins and losses within
each prespecified case-class and arm-order stratum, then combines the strata
using their planned weights. A missing arm, an indeterminate outcome or a
reused incident prevents a superiority claim.

## Input efficiency comparison

Use the archived preview.3 ALG-first Luna handoff as the historical baseline.
Run the old and new package with the same active scripted handoff on each
platform. Compare aggregate serialized request bytes with the Build control,
the complete decision and authority checks, and the number of accepted jobs
and evidence searches. Run the existing local matrix, including withdrawal and
extended handoffs, on the candidate.

After local qualification, one ALG-first native pair under the existing caps
can measure actual provider input, cache reads, output, requests and elapsed
time. Publish failed and incomplete attempts. Assess the correct standalone
decision, grounded retention and independent workflow evidence alongside usage.
The paired Build arm measures run-to-run variation. A comparison with one
historical run cannot isolate which change caused a difference.

## Post-compaction report delivery

Run the installed scripted delivery checks on Windows and Linux.

```sh
bun packages/v2-preview/benchmark/delivery-acceptance.ts <opencode-2.3.2-binary> <absolute-staged-bundle-path>
```

The ready case restarts the host after compaction. The first bare continuation
must return all seven fields in one request with zero tool calls. The three
remaining cases independently supersede the decision, withdraw approval and
remove a required reference. Each must withhold the stale answer and identify
the reason. The scripted responder can only see the on-wire handoff.

### Deterministic calculation delivery

Both handoff arms receive the identical full synthetic skill, including the
operator-authored calculation recipe as compact JSON. It specifies bounded
candidate selection, counted fields and the independently audited join without
embedding answers. The initial per-arm wire witness records when the full skill body was
seen. The historical skill bytes and pin hashes differ because they predate
the recipe. The recipe binds the original page response's offset, total row
count and next cursor to the native tool request's limit. Source responses,
references and query budgets stay fixed. The existing independent oracle and
native grader still score the report.

Run the calculation cases separately from the existing four delivery scenarios
and frozen qualification matrix, against the staged package with the local
scripted transport.

```sh
bun packages/v2-preview/benchmark/delivery-acceptance.ts <opencode-2.3.2-binary> <absolute-staged-bundle-path> calculation-mismatch
bun packages/v2-preview/benchmark/delivery-acceptance.ts <opencode-2.3.2-binary> <absolute-staged-bundle-path> calculation-missing
```

The mismatch case plants a reported correction count of 4 and requires the
conflict notice and the host-calculated count of 3 in a separate user-role
source-data projection. The missing calculation case removes `totalRows` from
responses for the selected inspection window, including its replay, while
keeping the source rows, reported values and references intact. It requires the
missing-calculation notice and abstention. Both check that bare continuation
projects no stale report and makes zero tool or source calls.

Retain the existing local qualification matrix and native grading criteria.
After the local gates pass, run one capped ALG-first Luna/Build pair on the
same incident. Compare continuation and whole-run input, cache reads, output,
calls, accepted searches and the independent answer grade against preview.4.
Report partial arms and failed gates explicitly.

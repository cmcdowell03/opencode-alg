# L2 continuity development results — 2026-11-13

The live obligation collector and paired schedule ran on real OpenCode V1 with `openai/gpt-6-luna`. **This cohort does not demonstrate ALG superiority or a reliable semantic information-loss rate.** Build passed one entire case; ALG passed none. All original results, failures and unknown observations are retained.

The paid candidate was frozen at `addb744d420375337cbf9d05e09408b26e23e395` before issuance. The follow-up fixes in this PR were made afterward and have separate local qualification; these model results do not establish their effectiveness.

## All-issued outcomes

Eight paired cases combine two synthetic service/factory incidents with independent handoff and requested-compaction factors. Every case includes a host restart. The service, initial data, permissions, model and cumulative limits are matched. Windows OpenCode was **1.19.5**; native catalog context capacity was retained, with a 4,096-token output limit. Each arm had a 30-minute, 256-observed-turn and 2,000,000-reported-component ceiling. Limits were not increased and no arm was replayed.

| Observed measure | Build | ALG |
| --- | ---: | ---: |
| Issued arms | 8 | 8 |
| Whole-task passes, including all checkpoints | 1 | 0 |
| Initial independent checkpoint passes | 3 | 1 |
| Completed host lifecycles | 8 | 3 |
| Stopped at cumulative usage limit | 0 | 5 |
| Observed assistant turns, including children/summaries | 318 | 506 |
| Reported usage components, including cache | 9,220,155 | 13,193,258 |
| Sum of observed arm duration, minutes | 37.54 | 68.52 |
| Individual arm duration, minutes | 3.48–6.71 | 1.44–13.58 |
| Successful requested summaries / assigned arms | 4/4 | 3/4 |
| Observed native automatic compactions | 0 | 0 |
| New-controller handoffs | 4 | 3 |
| Production owned-run transfer receipts | 0 | 2 |
| Completed host restart transitions | 8 | 4 |

Reported usage components are not invoice tokens or dollar cost. Stops are outcomes under this envelope, not proof that additional effort could not solve the task. Requested summary rates are **1.258/100 observed turns** for Build and **0.593/100** for ALG, but reflect the assigned schedule, not a natural compaction frequency. Active-time coverage remains unproven. These short arms do not demonstrate multi-hour reliability. The actual-model cohort ran on Windows; local deterministic Linux checks are a separate mechanics claim.

All 16 arms have complete final compaction censuses, successful cleanup, removed temporary auth copies and unchanged source/global configuration. The final read-only process check found **zero of 28 recorded host PIDs present**. All service-stop receipts passed. No Grok, Gemma, GitHub runners, V2 work or global configuration changes were used.

## What the retention measurements establish

The external collector froze obligations before interventions and independently graded subsequent artifacts and service operations. The original report has 78 common pre-correct obligation observations: Build retained 74 with four unknown follow-ups; ALG retained 32 with 46 unknown follow-ups. Neither recorded a known-correct → known-wrong regression in that subset. The corresponding descriptive missingness ranges are 0–5.13% and 0–58.97%; these are **not confidence intervals, independent trials, causal effects or a zero-loss result**.

These original counts are diagnostic, not acceptance evidence. The run exposed a scorer defect where an empty accepted-job list could satisfy lookup/read predicates, plus overly conservative empty-trace classification. Their post-study fixes do not retrospectively replace any observation. The obligation-level projection in `summary.json` separates substantive report/source checks from easier accounting and trace checks. The only ALG arm with a fully correct initial checkpoint stopped during the next control continuation, before its requested compaction. Consequently this cohort supplies no successful-task ALG baseline through compaction from which to estimate semantic loss.

A completed summary is recorded even if later work fails. A wrong or extended checkpoint makes freshness-sensitive report checks unknown; an unchanged file is not proof that the current phase verified it. Repeated instructions also limit the claim: the task-specific follow-up is a mission pointer and phase/nonce, but both arms receive the common permissions and HTTP API guide again. Declaring procedure version 2 is not proof of loading, approving or correctly applying a skill. Hidden context contents and pruning are unmeasured.

## Findings and forward fixes

1. **Delivery phase versus domain phase:** `01-alg` treated the requested checkpoint label as conflicting with ALG's `complete` delivery scope. Shared worker/checker/compaction guidance now distinguishes them while preserving preparation limits and permissions.
2. **Template routing:** `07-alg` selected the specialized managed investigation template, received its fixed-template rejection, and stopped the whole task without dispatch. Guidance now scopes that template to its configured workflow; it grants no permission to bypass managed-service or host guards.
3. **Scorer integrity:** expected key/source/revision identities are now required before crediting lookup/read retention. A complete contiguous trace can prove that required calls were omitted; a missing prefix or incomplete observer remains unknown.
4. **Durable public contracts:** future missions store the exact checkpoint schema so a new controller can retrieve it. Extra job metadata belongs in notes. Future partial-restart contracts explicitly require numeric rates. The original fraction wording was underspecified; historical fraction-string rejections remain recorded and qualified.
5. **Execution receipt adequacy remains unresolved:** the last ALG arm's initial artifacts passed the independent grader, but its internal checker rejected truncated command evidence and insufficient proof of the original submission/recovery. The next repair should preserve bounded, verifiable action provenance across retries and checker handoff, with redaction and completeness indicators. Do not relax verification or trust a model's claim that an action happened.

Before another frozen paid comparison, qualify the repaired collector, exercise complete command/action references plus explicit evidence-loss negatives, and keep correct artifact output separate from completed internal verification. Increase headroom only in a newly declared envelope where justified; never extend or relabel this cohort. A sustained L3 workload and independent confirmation remain outstanding.

## Evidence and local qualification

Post-study code `fd0b77441471dfbb17b0ab47f99716914eef27ed` passed **367 tests, one opt-in skip, zero failures and 2,565 assertions on each platform**, plus typecheck. The skipped lifecycle was run explicitly: Windows 1.19.5 and native WSL 1.18.35 both completed Build/ALG four-write, handoff, summary and restart checks with cleanup and unchanged global configuration. Each platform also passed 80 HTTP scorer controls. This includes package checks and the existing 5,100-transaction context-delivery stress test; it is still an affected-test gate, not the full suite. Sol's final review was static and did not independently execute these tests.

Failed setup attempts remain published. One sandboxed typecheck could not read its cwd and one lifecycle invocation supplied a relative output path; both failed before their intended checks began. A subsequent Windows Build lifecycle passed but the ALG `--version` probe exceeded its 15-second startup timeout. Cleanup passed. One sequential check of the unchanged candidate then passed both arms. **The timeout's cause is unestablished and the earlier receipt is not relabeled as a pass.** No paid model calls were repeated.

- `cohort-plan.json`: frozen source/protocol identities and issued schedule.
- `cohort-result.json`: original terminal outcomes, counters and conditional comparison projection.
- `live-obligations-final.json`: original external freezes, observations and final census qualification.
- `summary.json`: per-arm outcomes, obligation-level counts and transition checks derived from original terminal receipts.
- `receipt-manifest.json`: hashes of original sources, including hash-only private message/service evidence. Credentials and raw private transcripts are not published.
- `preflight-history.json`: the original 14/16 setup pass and two failures remain unchanged; the repaired zero-generation preflight passed all 16 before this cohort.
- `local-followup-gate.json`: exact post-study code identity, local test receipts and their scope. No paid replay validates those fixes.

Historical local gates are kept separately: `b974cb2` had 188 Windows affected/package passes and an explicitly exercised opt-in headless check; `addb744` had 82 additional Windows process/cleanup regression passes and 188 native Linux focused passes. Both platforms passed deterministic Build/ALG headless lifecycle and 80 HTTP qualification rows. Groups overlap and must not be summed. Windows uses OpenCode 1.19.5 and WSL uses 1.18.35. These are not a new full-suite or release-acceptance result; PR #14 stays draft and unmerged.

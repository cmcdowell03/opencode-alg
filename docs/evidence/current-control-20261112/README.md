# Current ALG versus Build controls — 12 November 2026

This development cohort used commit `01d5bb3`, the 0.5.7 runtime, Windows
OpenCode 1.19.5 and `openai/gpt-6.1-terra`. Two tasks and two arms were issued
before generation. The limits were unchanged across arms: eight minutes,
40 observed assistant turns, 200,000 cumulative reported usage components and
4,096 output tokens per call. Cumulative cutoffs are polled and may overshoot.
Reported components include cached input; they are not invoice costs.

| Task / arm | Artifact | Workflow result | Seconds | Turns | Reported components |
| --- | --- | --- | ---: | ---: | ---: |
| Coding / Build | Independent checks pass | Completed | 41.299 | 6 | 42,045 |
| Coding / ALG | Independent checks pass | Usage cutoff; checker rejected twice | 121.848 | 20 | 201,589 |
| Report preparation / ALG | Valid on subsequent offline audit | Apparatus stopped before continuation | 109.013 | 17 | 197,042 |
| Report preparation / Build | Valid on subsequent offline audit | Apparatus stopped before continuation | 29.264 | 5 | 32,531 |

The coding result still favors Build: ALG used 2.95 times the elapsed time and
4.79 times the reported components without reaching accepted completion. ALG
correctly selected `coding-compact`. Both implementations passed the independent
coding oracle, but the ALG checkers rejected incomplete edit-scope and operating-
restriction evidence. The second checker also cited an omitted command. The
host had supplied successful test-gate and protected-file receipts; that does
not prove the scope of all other changes or universal absence of other actions.
The correct repair is more useful bounded evidence, not waiving hard criteria.

ALG's report preparation used `coding-diamond` and all four children completed.
Both report preparations were wrongly rejected by the benchmark's text scorer:
it mishandled a blank line after a planned-fields heading and numeric division
following labeled numerator/denominator explanations. Both original failed
receipts are preserved. Offline rechecking is an apparatus correction, not a
completed report, restart or compaction result. Neither continuation ran.

All four raw receipts also have `config_integrity_failed`. An exact-byte
reconstruction proves that the only configuration difference is addition of
`$schema: https://opencode.ai/config.json`: deleting just that field and applying
the original serializer reproduces each original hash. Future trials seed that
metadata before hashing. The original eligibility flags are not rewritten.
Physical oracle/service isolation remains unqualified; this cohort supports
development diagnosis, not a confirmatory superiority claim.

All four stopped-host database censuses match collected session/message IDs;
all captured hosts stopped and all temporary auth copies were removed. Runtime
source and user-global configuration remained unchanged during the cohort.
Full local histories remain in the source evidence directory named by the
manifest. Published files exclude authentication and host databases.

The resulting candidate repairs output projection before dropping command
metadata, retains exact original criteria once per worker prompt, and clarifies
criterion-specific evidence collection and repair. Preparation scoring and
configuration seeding are separate harness fixes. These changes do not implement
the planned production shared task allowance or qualify the hard synthetic
service. Their behavioral effect requires a new frozen development cohort;
the current results are not relabeled as results for the changed candidate.

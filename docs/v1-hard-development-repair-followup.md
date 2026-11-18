# Prospective repair follow-up

Run one new full development cohort after the 0.5.11 scope, grading and census
repairs pass local qualification. Keep the first cohort and diagnostic audit
immutable. This is a repair evaluation on known problem families, not fresh
holdout confirmation or a retrospective correction of the original leaderboard.

Use all six fixtures and twelve Build/ALG arms, `openai/gpt-6.1-terra`, the same
Windows V1 host, and order seed **20261114**. Each arm gets 30 minutes, 256
observed assistant turns, 2,000,000 reported usage components and a configured
4,096-token output limit. The suite cap is seven hours. Configure natural
compaction at 128,000 context tokens with no forced compaction in this cohort.
Do not select cases, top up an arm, rerun a failed arm, or edit runtime/harness
inputs after issuance. Persist every issued outcome and partial census.

The public report contract is now explicit and the timestamp/code-runner
repairs apply equally to both arms. These changes prevent a direct attribution
of score changes exclusively to the plugin. Compare arms within this new
cohort, publish internal ALG completion separately from external artifact
correctness, and classify remaining failures without removing them from the
denominator. Report method changes beside any comparison with the first run.

Admission requires the shared live/qualification scorer's 18 direct cases and
six HTTP cases, all twelve no-generation preflight arms, corrected package
identity checks, the Linux local gate, and actual Windows/Linux scope-hook,
negative-drift, compaction and restart acceptance. Bind runtime, harness,
fixture, grader, host and qualification hashes before generation.

The primary outcome remains independently verified completion of all original
criteria. Secondary observations include internal checker completion, blocked
phases, mechanical failures, duplicated accepted work, elapsed time, reported
usage and coverage. This remains same-user development rather than OS-isolated
confirmation. Zero observed compactions cannot establish an information-loss
rate; long-session retention testing remains a separate required stage.

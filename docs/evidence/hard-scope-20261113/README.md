# Frozen repair-follow-up cohort

These are the unchanged results issued from `aff2469` on Windows OpenCode
1.19.5 with `openai/gpt-6.1-terra`, all six fixtures and twelve arms, seed
20261114. The prospective protocol is
[repair follow-up](../../v1-hard-development-repair-followup.md).

| Recorded outcome, all six issued tasks per arm | Build | ALG |
| --- | ---: | ---: |
| Root completed without an operational stop | 4 | 4 |
| Final artifact passed its frozen grader | 4 | 4 |
| Frozen scored-task-success flag | 4 | 3 |
| Artifact passed and ALG graph finished | N/A | 2 |
| Reported usage components (not invoice tokens) | 525,331 | 1,708,693 |

The flags measure different things. One ALG artifact passed after its graph
failed during a provider usage-limit incident. Another passed while its checker
repair remained pending at a two-wave boundary. Neither is verified ALG
completion. Conversely, the first ALG factory report failed only because it
included two explanatory fields: the public contract had not disclosed the
grader's closed-object rule. This is an apparatus defect, not established
semantic checker failure; its raw score is preserved rather than replaced.

The final two pairs were operationally incomplete. Three arms contain HTTP 429
usage-limit responses; the last ALG arm timed out before root-session creation.
There was no top-up or replay. These data do not establish ALG superiority.

All twelve arms report successful cleanup, temporary auth removal, unchanged
source, and reconciliation against the stopped host's message IDs. A separate
filesystem check found no remaining auth copies. All eleven started sessions
have complete host compaction censuses with zero markers; the unstarted arm
has no retention observation. There were no scored obligation probes, so no
information-loss rate is available. Native pruning is not proven absent.

[analysis.json](analysis.json) is a derived, inspectable summary.
[result.json](result.json), [plan.json](plan.json) and the original
[qualification receipt](hard-qualification.json) retain their original bytes.
[manifest.json](manifest.json) binds them and selected locally retained
transcripts/fixtures. Raw messages, provider headers, auth and configuration
copies are not uploaded. The collector projects only fixed error categories
and status codes.

Subsequent fixes and local tests are separate evidence; they do not revise this
cohort or prove that a model will follow the new continuation guidance.

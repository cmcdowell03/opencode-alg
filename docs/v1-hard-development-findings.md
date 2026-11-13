# Hard development cohort: measured failures and repairs

The first expanded comparison used commit `7764686`, OpenCode 1.19.5 on
Windows, and `openai/gpt-6.1-terra`. All six cases and twelve arms were issued
before generation. Eleven arms completed; one ALG arm stopped on a telemetry
timeout. Source and user-global configuration stayed unchanged, and every arm
stopped its owned services and removed its temporary authentication copy.

This cohort does **not** establish ALG superiority. It exposed production
defects and defects in the measurement apparatus. The original results remain
immutable under `implementation-evidence/hard-d50-terra`; the separate
`hard-d50-terra-posthoc/audit.json` records its source hashes and verifies that
the frozen result and project files were unchanged by the diagnostic audit.

## What the cases establish

| Case | Preserved observation | Interpretation |
| --- | --- | --- |
| Three factory evidence cases | Both arms failed only the timestamp-window check. The posthoc audit accepts all six artifacts. | `Z` timestamps without fractional seconds denoted the same UTC instants as `.000Z`. String equality created false negatives. |
| Partial investigation after service restart | ALG passed every original check; Build failed `report:particle`. | A concrete paired ALG win on this case, not general superiority or proof that adversarial review caused the win. |
| Accepted query with lost acknowledgement | ALG made no service request; Build completed the service sequence and returned a textual summary. Both failed the file-based report checks. | ALG selected a researcher without Node execution capability. The public input omitted the required filename; that Build grading failure is not a demonstrated model error. Future fixtures explicitly publish the artifact contract for both arms. |
| API/client compatibility | Both failed only the two execution checks. Both pass actual code execution in the posthoc audit. | The live runner omitted the code-runner dependency supplied by qualification. Those original failures establish no code defect. |

ALG's own durable run states were four `blocked`, one `failed`, and one `done`.
The four blocked runs had produced valid artifacts but counted the plugin's own
session-memory changes against the user's project edit scope. The checker never
ran on those artifacts. Correcting an external score cannot turn an internally
blocked run into successful end-to-end verification.

The successful restart case used a second implementer/checker cycle. The first
checker requested complete source evidence because retained tool output was
truncated; it did not demonstrate that the initial answer was wrong. This is
evidence of verification overhead and recovery, not a causal estimate of the
value of adversarial checking.

## Mechanical repairs

1. Pin explicit runtime-store exclusions in **new** change-scope baselines.
   Keep skills, configuration, unknown `.opencode` content and explicitly
   observed/protected paths in scope. Older baselines retain their original
   interpretation and hashes; never rewrite history to erase a violation.
2. Compare valid UTC instants rather than timestamp spelling. Reject invalid
   dates, shifted endpoints and non-UTC offsets; preserve every other check.
3. Supply the bounded development code runner to the live scoring path and
   distinguish an unavailable apparatus from executed code that fails.
4. Recognize the runtime's `_cards` namespace in diagnostic collection without
   accepting arbitrary unknown directories or mixing private runtime files
   into contestant artifacts.
5. Give multi-session census collection bounded overall and per-request
   deadlines with attributable failures. A partial census remains partial;
   cleanup or database ID reconciliation alone does not prove quiescence.

The fixes are model agnostic. No permissions are widened to make a benchmark
pass. A research graph's lack of shell access is a capability-planning issue;
it is not justification for giving all researchers unrestricted execution.
Orchestrator guidance now makes that route distinction explicit; this is not
automatic semantic discovery of every tool a task will need.

The fixed default host-store namespaces are covered. An optional
environment-memory database at an arbitrary configured project-local path is
still observable; place it outside the measured scope or account for its exact
database/sidecar writes. New v2 baselines require the 0.5.11 reader. The older
0.5.10 loader rejects and can quarantine them; downgrade is unsupported.

## Compaction and resource interpretation

Eleven arms had a complete host census with zero compaction markers. The
telemetry-stopped arm had an incomplete census and zero **observed** markers,
which is a lower bound, not a measured zero. None had pre/post-boundary
obligation probes, so information loss remains untested. A service restart is
not model compaction. These short cases cannot substitute for long-session
retention acceptance.

Observed cumulative usage components were 2,413,679 for ALG and 906,052 for
Build across the six tasks. ALG's total includes one incomplete census. These
are reported components, including cached input, not invoice tokens or equal
coverage cost estimates. Extra effort is acceptable when it produces a verified
solution; effort spent on mechanical blockers is not a capability improvement.

## Next admission boundary

Before another paid cohort, qualify the **same** scoring dependencies used by
the live runner, make every required deliverable public, and pass the scope
regression through actual V1 hooks on both Windows and Linux. Preserve the first
cohort and its posthoc interpretation separately. A new run needs a new frozen
plan and must retain every issued arm, including operational failures.

Only then assess whether the repaired ALG workflow completes its checks and
improves verified task completion. Independent confirmation still needs fresh
cases, a qualified isolation boundary, and repeated-comparison rules. Long
session measurement additionally needs observed compaction boundaries and
independently scored obligations before and after each boundary.

## Repair follow-up: completed, not a superiority result

The prospectively frozen `aff2469` comparison issued all twelve arms. Eight
completed; four stopped. The unchanged scores, safe provider-error projection,
cleanup, coverage and usage are in
[the follow-up evidence](evidence/hard-scope-20261113/README.md).
No runtime-store scope blocker recurred in the five ALG graphs that started.
Build has four recorded task successes versus ALG's three; only two ALG
artifacts also have a completed internal graph. These distinctions must not
be collapsed into a favorable leaderboard.

The first ALG factory report adds two explanatory fields. All substantive
checks pass, but the public contract never forbade extra fields. The future
contract now explicitly lists output fields and closed nested shapes; added
extra-field controls run through the shared scorer. Original evidence stays
unchanged. A review of all four fixture families also disclosed the existing
64 KiB output/source bounds, code-runner time/stdout limits, and restart-report
precision/sorting. The accepted-query grader already allows a sufficient
projection; the restart fixture's exact job scope describes preseeded host work,
not a hidden choice the model must guess. Neither predicate was loosened.

The accepted-query ALG artifact passes, but the orchestrator stops after two
waves, with the producer and checker pending and two global attempts remaining.
The executor previously returned the same `blocked` phase for this ordinary
call boundary and a prerequisite failure; its next-action text said to resolve
a prerequisite. The repair emits `phase=wave-limit` only when completed waves
reach the call limit, usable attempts remain, and no cancellation, setup stop
or pending SDK uncertainty exists. Guidance resumes the same owned run without
refilling budgets. Every ordinary permission, task, evidence and allowance guard
still runs on resume.

This does not certify that the observed checker rejection was wrong. It lacked
complete native command evidence, and the admitted review criterion also sought
proof of operating restrictions throughout execution. Snapshot-based scope
evidence cannot establish that stronger claim. Better criterion/evidence
alignment remains a separate design issue; do not weaken checking to manufacture
a win.

The last pairs include three HTTP 429 usage-limit arms and one startup timeout.
One ALG arm produced a passing artifact before provider failure; it remains a
stopped, internally failed run. No extra paid run is used to replace these
outcomes.

Completed-summary exposure is now recorded independently of continuation
completion/correctness. Missing and ambiguous scores remain explicit; legacy
recovery fields retain their historical meaning. None of this cohort's eleven
started arms had a compaction marker or obligation probes. The long-session
stage must still establish pre-transition correctness, current truth, linked
summary exposure and post-transition behavior, and report pruning/census
unknowns. Passing recorder tests is not a retention result.

# Verification repair follow-up — negative development result

Frozen candidate: `3cc57c1`, ALG 0.5.7, Windows OpenCode 1.19.5,
`openai/gpt-6.1-terra`. The two tasks, arm ordering and resource limits match
the [preceding control](../current-control-20261112/README.md). The candidate
changes command-evidence projection and worker guidance; the harness separately
fixes preparation parsing and seeds host configuration metadata before hashing.
No paid trial was repeated without a candidate change, and no limit was raised.

| Task / arm | Independent artifact | Workflow | Seconds | Turns | Reported components |
| --- | --- | --- | ---: | ---: | ---: |
| Coding / Build | Pass | Completed | 37.284 | 6 | 42,366 |
| Coding / ALG | Pass | Usage cutoff | 113.062 | 19 | 217,952 |
| Staged report / ALG | No final report | Usage cutoff | 136.969 | 20 | 206,070 |
| Staged report / Build | Pass | Completed after compaction/restart | 73.140 | 11 | 74,810 |

**Build completes 2/2 tasks; ALG completes 0/2 within the frozen allowance.**
The coding control uses about 3.03 times Build's elapsed time and 5.14 times
its reported usage components. The sum includes cache and reasoning fields;
it is not billed tokens or dollars. Each cell is one development trial, not a
population estimate or causal estimate of the repair's effect. Neither cohort
qualifies as an isolated, blinded superiority experiment.

The coding graph uses `coding-compact`. Its checker rejects broader preservation
and edit-scope evidence. The repair worker then reports that it cannot establish
a missing before-work baseline. Correct code therefore remains stranded. This
is a planning/evidence-coverage problem that the command projection repair alone
does not solve; removing the criterion would not be a valid fix.

The report graph uses `coding-diamond`, leaves `preserve_paths` empty, and spends
its allowance repairing preservation/policy evidence. It also loses explicit
user-request details during delegation: the parent receives the final field
definitions, but its criteria say only "required schema". The resulting
preparation states that the authoritative schema has not been located. This is
information loss before compaction, not evidence of compaction damage.

The preparation proposes an event-based numerator. The fixture explicitly
specifies a distinct-wafer denominator but does not specify numerator grain
with the same precision. That ambiguity must be clarified prospectively before
using numerator choice as comparative evidence. It does not erase the recorded
usage stop, missing final report or omitted explicit field definitions. Original
prompts, grades and artifacts are preserved.

Build's report has one accepted requested compaction, a new persisted marker,
a linked terminal summary, one restart and an independently passing completed
continuation. ALG never reaches that boundary. This supplies no comparative
compaction-loss estimate and no natural-compaction rate for a long session.

All four source/configuration checks and stopped-host ID censuses pass. Captured
hosts stop, temporary auth copies are removed and global configuration is
unchanged. The original external 200,000-component cutoff overshoots by 17,952
and 6,070 in the two ALG arms; those values remain in the receipts. Isolation
remains explicitly unqualified. No Gemma, GitHub runner, V2 work or merge occurred.

Local qualification for this frozen repair: typecheck and **140 tests / 550
assertions** pass on Windows and native Linux; all four no-model headless
preflights pass. The logs and raw result files are hashed in the manifest. These
are focused checks, not a new complete release/deployment gate.

The follow-up 0.5.8 candidate captures bounded current-user-turn text from the
host and binds it to the existing task contract for worker/checker handoff and
resume. Its mechanical qualification is recorded separately; these model trials
do not evaluate it. Before further comparative claims, address evidence coverage
at admission, shared dispatch allowance, hard-service/oracle qualification and
completed paired long-session exposure. No superiority claim is supported.

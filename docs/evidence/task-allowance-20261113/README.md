# V1 task-allowance and benchmark qualification

Candidate **0.5.10**: runtime implementation `2fa970d`, Windows benchmark setup
repair `d50ce31`, final test fixture `5a2e8a6`. The [summary](summary.json) and
[75-payload byte manifest](manifest.json) retain local evidence, including failures.
This page records deterministic qualification and preflight, not paid model quality.

New live phases share a host-owned root checkpoint allowance. Reservations commit
before attempts and child creation, persist across compaction/restart/transfer,
and cannot be replenished by replanning. Checkers have a protected reserve.
The unit is an ALG child reservation; root planning, compaction calls and provider
invoice usage remain outside this enforcement. Same-session unrelated tasks do
not automatically obtain a fresh allowance; explicit continuation uses the
existing transfer route. This is the first P3 accounting boundary, not all of P3.

## Measured checks

| Check | Pass | Skip | Fail | Assertions |
| --- | ---: | ---: | ---: | ---: |
| Native Linux full `bun run check`, final candidate | 1,437 | 16 | 0 | 16,041 |
| Windows initial runtime matrix | 100 | 1 | 0 | 840 |
| Windows final lease/cancellation/replay checks | 36 | 0 | 0 | 158 |
| Windows package/manager checks | 114 | 1 | 0 | 1,094 |
| Windows corrected executor fixture | 12 | 0 | 0 | 74 |
| Reviewed benchmark suites | 42 | 0 | 0 | 417 |
| Windows long-path regression and cohort checks | 13 | 0 | 0 | 170 |

These sets overlap; do not sum them. A full Windows suite was not repeated.
Linux's full gate also includes typecheck, extracted-package inventory and runtime
imports, smoke, real server/TUI registration and optional capability manifests.
Windows server/TUI registration independently passed on the same runtime identity.

Windows OpenCode **1.19.5** and native Linux **1.18.35** each passed the real-host
headless probe with a synthetic provider: one requested root compaction, two host
restarts, reservation count **1 → 1 → 2**, verified checker parentage, and **zero**
new child attempts after exhaustion. The installed host pinned the original
contract and 2/1 test policy before the helper invoked actual SDK children.
Cleanup and user-global configuration preservation passed. This is not a
multi-hour soak, natural-compaction loss rate, or real-model task-quality result.

All **136 runtime files** are equal after LF normalization. Raw Windows and Linux
identities differ and are retained. Different host versions/filesystems do not
support a platform performance comparison. No new offline transfer bundle or
real datalake-mcp environment was accepted by these checks.

## Failures retained and corrected

- Initial headless fixtures declared response-only work incorrectly and omitted
  the researcher from their isolated host installation. These are failed fixtures.
- The actual restart probe then exposed a stopped process's unexpired checkpoint
  lease. The old 250 ms wait blocked continuation. The repair waits cancellably
  for up to 35 seconds under unchanged lease/owner rules, without replaying a
  possibly committed mutation. A captured dead PID with remaining lease time
  established the failure; no early lock deletion was used.
- The first Linux full gate failed one old test that omitted the controller after
  planning a bound task. Its passing headless receipt does not turn that gate into
  a pass. The final full gate uses the corrected fixture and also verifies that a
  shell gate is not charged as a child.
- The first hard preflight hit Windows Git path limits in four ALG workspaces.
  Short equal-length arm directories and repository-local long-path support fix
  setup for both arms. The later twelve-arm preflight passed. No model generation
  occurred in either preflight; these are not competitive wins or losses.
- Stale qualification identity, early type/fixture errors and an invalid verifier
  evidence destination are preserved separately from the final successful checks.

## Development benchmark readiness

All six positive reference solutions passed; all twelve incorrect/tampered direct
submissions were rejected. The two service fixtures also passed six public HTTP
reference/negative/tamper cases. Qualification binds fixture, grader, service,
HTTP, runner and qualification sources. The same bounded service interface is
available to Build and ALG; private ALG progress is collected separately from
grader inputs for mechanical failure attribution.

The [prospective protocol](../../v1-hard-development-cohort-protocol.md) fixes all
six tasks, order seed, model and equal 30-minute/256-turn/2M-component headroom.
It is same-user development, not OS-isolated confirmation. The earlier paid
Build 2/2, ALG 0/2 controls remain unchanged. No superiority claim follows from
these mechanical checks. All work here is V1, local, model agnostic, without
GitHub runners, Gemma, user-global edits or merge.

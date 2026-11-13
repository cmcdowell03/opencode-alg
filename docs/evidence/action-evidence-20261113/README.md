# V1 durable action evidence acceptance

Runtime and test candidate: `23fffd886122266101889d6599cb3432af67a848`, ALG
0.5.11. Actual-host harness follow-up:
`d3776b0b918413c74f2014f49169ac02f86fc7cb`. That follow-up changes only the
harness's dispatch accounting; it does not change plugin runtime code. The
PR remains draft and unmerged.

| Check | Measured result |
| --- | --- |
| Native Ubuntu full suite | 1,550 passed, 17 skipped, zero failed; 17,100 assertions, 129 files; 538.61 seconds |
| Immutable Windows affected suite | 71 passed, one platform skip, zero failed; 661 assertions, seven files; 85.95 seconds |
| Typecheck | Passed on both platforms |
| Package validation | Actual extraction, reviewed inventory and dependency-ready entrypoint tests passed within the suite/affected gate |
| Actual Windows host | OpenCode 1.19.5; headless acceptance passed |
| Actual native Linux host | OpenCode 1.18.35 in WSL Ubuntu; headless acceptance passed |
| Runtime identity | 138 runtime files equal after CRLF-to-LF normalization; raw platform identities retained |

The Windows affected suite includes all four action-evidence test files,
context-budget, package-completion and release-gate tests. Groups overlap;
they must not be added to the full-suite count. WSL tests run on the native
Linux filesystem, not the Windows checkout. No GitHub runners or paid models
were used.

Each actual host completed ten harmless native `bash` calls. The first command
was 3,260 bytes and preceded nine later calls, exceeding the old prompt
preview's useful coverage. The host captured ten intents and ten terminal
observations. It observed the first command's exact retained hash, expected
output marker and reported exit code zero.

The fixture stopped after the producer, requested one real parent summary,
verified its linked completed marker, then continued the same run with
`alg_resume`. Only the fresh checker ran. It fetched the evidence index and
the original intent/terminal pages, and cited the two exact registered page
IDs. The journal hash was identical before compaction, after compaction,
after resume and after a server restart. Producer/checker attempts stayed
**one/one**. Restart issued no additional model work.

Provider-emitted tool IDs and persisted attempt identities distinguish the
two actual parent dispatches (`alg_run`, `alg_resume`) from the two native
task-visibility cards. Cards cannot count as additional execution or excuse
an unexpected provider-emitted call. All final host/provider processes stopped,
temporary host environments were removed, no credentials were inherited and
real-user global configuration snapshots remained unchanged.

Windows runtime digest:
`889cce5d8275a92740b8b8905b1be7c67d6f8b9c507080909d8aa4c164b74114`.
Linux runtime digest:
`178ef053125650a036f03f741d0c6525d17c9a0062f52c1ae9f5668c6b7c63f8`.
[runtime-identity.json](runtime-identity.json) records the normalized per-file
comparison. [windows.json](windows.json) and [linux.json](linux.json) retain
structured measurements without command/output transcripts. Full local logs
and receipts remain private; their hashes are recorded separately.

## Preserved development failures

- The first restricted Windows test could not perform the required atomic
  hardlink/rename operations. Tests were rerun with local filesystem access;
  atomic publication was retained, not weakened for the sandbox.
- The first affected gate exposed projected `evidence_unavailable` archive
  handling and the changed no-replay behavior. The corrections passed the
  affected tests and final Linux suite.
- The first full Linux gate at `884c947` had 1,543 passes, 17 skips and seven
  failures: package support inventory, five Bash launcher checks involving
  CRLF, and a tight context-summary budget. The package inventory is explicit;
  shell LF checkout attributes and compact summary guidance repair the other
  failures. No historical gate is relabeled green.
- The 256-call capture-limit fixture exceeded its five-second test default
  under concurrent Windows I/O. Its timeout is now 30 seconds; capture limits
  and assertions are unchanged. The final affected/full tests passed.
- The first host harness lacked ordinal metadata/parser handling and hit its
  request timeout. The initial compaction harness then counted native task
  cards as extra dispatch. Both `23fffd8` host receipts remain failed even
  though their graphs completed. `d3776b0` adds explicit emitted-call/card
  accounting and passes on both hosts. The `23fffd8` combined Linux gate
  therefore remains failed: its full suite and typecheck passed, its old
  headless assertion did not.
- One invocation supplied a relative receipt path and was rejected before
  host startup. The tool transcript retains that argument error; no host
  receipt or model work was created by that invocation.
- An overlapping Windows affected run had 58 passes, one skip and three
  release-identity failures caused by another test's temporary files in the
  same checkout. The immutable, serial affected gate above passed. Release
  inventory validation was not relaxed to ignore those files.

The earlier broad Windows development run began before the final fixes and
used a changing checkout. It finished with **1,557 passes, seven skips and two
failures** (17,202 assertions, 2,949.78 seconds): the summary-budget and package
inventory issues above. Both corrected cases passed the immutable final gates.
Its terminal result is recorded in [test-results.json](test-results.json) and
is not final-commit full acceptance. A fresh package check after the final
documentation additions also passed (two tests, 243 assertions).
Failed host workspaces from the compaction harness are retained locally for
inspection; successful temporary host workspaces were removed. The earliest
host harness removed its failed temporary workspace, a limitation of that
receipt. Original failure receipts and logs remain preserved.

## What this does and does not establish

This qualifies bounded V1 capture, integrity checks, scoped retrieval,
checker-only evidence recovery, and persistence through a real host summary
and restart. Unit/runtime tests also cover unknown crash outcomes, matching
history reconciliation, earlier attempts, redaction versus truncation,
retention limits, forged/corrupted references, unrelated-run denial,
revoked read capabilities and archive reload.

The provider is deterministic, the summary deliberately contains no command
evidence, and the driver explicitly continues the run. This is not a real
model autonomously recovering context, a multi-hour soak, a semantic
information-loss estimate, a remote exactly-once guarantee or a superiority
result against Build. The prior paid L2 comparison remains unchanged. These
source-checkout host runs and extracted-package tests do not qualify a newly
built offline installation bundle, a new TUI deployment or the air-gapped
datalake-mcp service. No V2 work, global configuration edits, Grok or Gemma
calls occurred.

[manifest.json](manifest.json) binds the structured evidence payloads.
Subsequent documentation/evidence commits do not replace the tested code and
harness identities above.

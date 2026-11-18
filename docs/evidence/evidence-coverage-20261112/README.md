# V1 verification-coverage qualification

Candidate **0.5.9**, runtime commit `9acacd78da4bb564ce503a7388926b7e1a21f042`,
following implementation `032c8109f0832eacc984cf60197d64967f73fb82`.
Local PowerShell/Windows and native Ubuntu/Bash only. No GitHub runner, Gemma,
user-global configuration edit, V2 implementation, merge, or new paid OpenCode
comparison. [Summary](summary.json) and [byte manifest](manifest.json) bind the
raw receipts retained alongside this page.

## What changed

New plans declare observations for every original criterion. Before the first
ALG child, the existing transactional run store commits protected-file hashes
and optional bounded directory inventories. Retry and restart reuse this basis.
Checker admission observes scope changes; scope failure blocks automatic
producer reopening. Post-check content drift invalidates proof even if the
changed-path count stays the same. Tests exercise real temporary-file changes,
not just model claims.

Real-host qualification exposed another defect: effective V1 read rules contain
scoped defaults followed by the checker's explicit read-all allowance. The old
predicate rejected that final uniform allowance. The correction respects rule
ordering and Windows case matching, while later scoped/unknown rules remain
unqualified. Tests cover allow, ask, deny, later restrictions and case matching.
No host permission or user config was changed.

## Checks and their exact scope

| Check | Runtime | Pass / skip / fail | Assertions |
| --- | --- | --- | --- |
| Windows integration, 26 files | `032c810` | 351 / 1 / 0 | 7,247 |
| Windows permission follow-up, three files | permission-order repair before final casing fix | 36 / 0 / 0 | 232 |
| Windows final casing/scope delta, two files | `9acacd7` | 25 / 0 / 0 | 111 |
| Native Linux full `bun run check` | `9acacd7` | 1386 / 16 / 0 | 15,582 |

These rows overlap; do not sum them as distinct tests. The Windows integration
matrix covers admission, execution, recovery, persistence/hydration, checker
evidence, TUI, investigation hooks, schemas and release metadata. The specific
deployment compatibility check also passed (one test/four assertions), and
offline smoke passed. The expensive full Windows deployment suite was not
repeated. Linux's full check includes typechecking, extracted-package and
installer tests, smoke, real server/TUI registration and optional manifests.

Final real hosts were Windows OpenCode **1.19.5** and native Linux **1.18.35**.
Both matched source runtime identities and passed server/TUI registration, headless
tool/permission checks, one requested compaction and two restarts, unchanged
contract/source digests, reuse of the same investigation result, fresh checker
child lineage, process cleanup and temporary-environment removal. Neither
inherited credentials or modified real-user global configuration.

The headless provider and MCP are local deterministic fixtures. Its contract
probe plans a read-only investigation; it does not execute the new scoped file
mutation through a real model. The baseline/content-change regressions run
through the executor with injected deterministic child responses. These are
different evidence layers, not interchangeable claims of model performance.

## Runtime identity

- Windows raw digest: `9f515dbb8866d1b4f6974beef347087fe9cc9625c8206c55e5e4b30188aa2d5d`.
- Linux raw digest: `34834d5c81ad65f90bf71d7081525a97a517e42387f34a6fb14803d52c60377b`.
- All **134 runtime files** match after CRLF/LF normalization;
  67 have different raw bytes. The archived native Linux
  checkout preserves executable modes. Different host versions and filesystems
  mean timing is not an OS performance comparison.

Final receipts are `evidence-coverage-windows-headless-9acacd7.json`,
`evidence-coverage-windows-live-9acacd7.json`,
`evidence-coverage-linux-headless-corrected.json` and
`evidence-coverage-linux-live-corrected.json`. Intermediate successful receipts
are retained with their own runtime identities and are not relabeled final.

## Failed invocations remain evidence

- The first focused Windows run found test-junction cleanup errors, an invalid
  research fixture and a missing compaction pointer. A subsequent boundary test
  reproduced a real internal-symlink false negative; lexical entry checks fixed
  it. Both failures and corrected receipts are retained.
- The first broader Windows integration run had 334 passes and 14 failures
  after the new read-permission boundary exposed incomplete synthetic agent
  fixtures. Corrected fixture permissions preserved explicit denial cases;
  the affected 140-test run and final 351-test matrix passed.
- The first Linux full gate had 1,385 passes, 16 skips and one invalid
  case-sensitivity fixture. Its allowed file was outside both declared roots.
  Correcting the fixture preserved the validator; the final full gate above
  supersedes that failed receipt, not its history.
- A relative Windows evidence path was rejected before host launch. Two
  Windows host invocations and the initial Linux host invocation then exposed
  the real effective-read-rule rejection. The diagnostic rule sequence and
  failed receipts remain; final hosts pass after the production correction.
- Earlier worker sandbox probes encountered Windows `EPERM` and were not
  treated as qualification. Authorized local host/process checks ran with the
  necessary filesystem/process access.
- Evidence assembly initially addressed a summary field instead of the raw
  registration receipt's `plugin_source.sha256` field. Correcting that collector
  lookup allowed exact identity comparisons; no host receipt was changed or
  host run repeated for this reporting error.

## Limits and the next gate

Coverage is planner-declared, not semantic intent certification. The before
state begins at ALG child execution, not the beginning of the conversation or
earlier root-agent edits. Scope excludes named directories and external/global
settings; it does not provide an atomic snapshot or detect all transient writes
and concurrent interference. A bounded sample omits paths explicitly rather
than claiming complete prompt coverage. Exact relevant-command matching and
general observation-only repair remain unfinished.

This is not a long-session loss-rate estimate or proof ALG beats Build. The
[earlier paid comparison](../evidence-repair-20261112/README.md) remains Build
2/2, ALG 0/2 at its original limits. Next qualify the hard-task service/oracle
boundary and durable allowance, then freeze matched, realistic available
headroom and measure independently verified completion. Preserve those earlier
losses and report actual usage separately from capability.

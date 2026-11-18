# Current-user source handoff — V1 mechanical qualification

Runtime commit `871868c8cd41a6eb01fedfb961abff1296440786`, candidate **0.5.8**.
The host looks up the calling message and its exact user parent, captures bounded
literal text when credential heuristics permit it, and binds the snapshot into
the existing immutable task contract. Workers/checkers receive the source;
compaction retains a retrieval pointer. This repairs a delegation omission seen
in the [preceding paid controls](../evidence-repair-20261112/README.md).

## Completed local checks

| Check | Windows / PowerShell | Native Ubuntu / Bash |
| --- | --- | --- |
| OpenCode | 1.19.5 | 1.18.35 |
| Full `bun run check` | Exit 0 | Exit 0 |
| Tests | 1,378 pass / 6 platform skips / 0 fail | 1,368 pass / 16 platform skips / 0 fail |
| Assertions | 15,831 | 15,487 |
| Test-phase elapsed | 2,521.13 seconds | 483.44 seconds |
| Real-host synthetic integration | Pass | Pass |
| Requested compactions / host restarts | 1 / 2 | 1 / 2 |

The full checks include typecheck, an extracted npm package with dependency-ready
installer execution, smoke, server/TUI registration and optional manifests. The
headless integration verifies actual host message capture, unchanged contract and
user-text digests before/after compaction and both restarts, investigation reuse,
fresh checker child lineage, effective host permission checks and cleanup. Both
hosts report no inherited credentials and unchanged real-user configuration.

All **132 runtime files** agree after CRLF-to-LF normalization. Raw source
identities remain distinct and are recorded in the identity files and host
receipts. The Linux source came from a clean Git archive on the native filesystem;
dependencies were reused locally. Different host versions and filesystem layouts
make the elapsed times descriptive, not a controlled OS performance comparison.

The 5,100-transaction delivery-journal test retained **16,493 bytes** on both
platforms. These are persistence transactions, not model compactions or a
long-session memory measurement. Timing observations remain in the full logs.

## Retained failures and receipt limits

The first focused pass found a stale package-lock version on both platforms and
three package-mode failures when Linux operated on the Windows-mounted checkout.
The lock was corrected; native-filesystem qualification passed. Those earlier
failed logs are retained and are not described as successful gates.

The first Linux full-check registration receipt was subsequently unavailable in
WSL `/tmp`; its verified result/hash remain in the full log. An attempt to select
a different evidence root was rejected before host verification. A final,
registration-only repeat used the approved temporary root and copied its verified
receipt out before the WSL process ended. Both follow-up logs and the final raw
receipt are retained. The headless receipts were written directly to durable
external storage before cleanup. No paid tests were repeated for this repair.

## Prospective benchmark clarification and limits

The next wafer-report fixture explicitly defines its numerator as distinct wafers
with at least one primary-system defective observation. The denominator remains
all distinct primary-system wafers. The oracle and expected answer are unchanged;
prior prompts, grades and outcomes remain immutable. The exact prospective file
SHA-256 is `5ed92deeda6c4dd52c4edf1f905ed7f627f0d4c3c04b2d4a5b2dd8356208500b`.
Its existing **45 tests / 120 assertions** pass on each platform. It was tested in
a separate copy while the full frozen-runtime gates ran, then copied byte-exactly
into the branch. It is not part of a new paid cohort.

This capture covers the current host user turn, not earlier conversation or
attachments. Sensitive, oversized and unavailable text is explicitly declined;
credential detection is heuristic, not a DLP guarantee. A snapshot does not
certify a planner's interpretation or supply a missing before-work baseline.

The provider and service in these host checks are local synthetic fixtures. The
latest paid cohort remains **Build 2/2 completed, ALG 0/2 within allowance** on the
preceding candidate. No paid superiority result, completed paired long-session
loss rate, new offline-bundle acceptance or real air-gapped service qualification
is claimed for 0.5.8. Shared dispatch allowance and admission-time verification
coverage remain unfinished. All checks were local; no GitHub runners, Gemma,
V2 implementation, global configuration edits or merge.

Raw payload hashes: [manifest](manifest.json). Computed platform summary:
[summary](summary.json). Evidence is local provenance, not external attestation.

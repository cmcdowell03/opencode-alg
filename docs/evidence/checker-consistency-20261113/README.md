# Checker consistency and deployment qualification

The frozen `7a32708` runtime implements model-agnostic consistency checks for
bounded, host-verifiable assertions and pins the actual submitted dependency.
Ordinary resume preserves a substantive rejection; explicit feedback can repair
the producer before a fresh review. Sol's independent static review found no
remaining core blocker before the integrated gate.

The native Windows integrated gate passed **210 tests, one POSIX-only skip,
3,147 assertions**, plus TypeScript checking. The independent scorer passed
**80 synthetic HTTP controls** at the frozen checkout. All sixteen benchmark
configurations passed preflight without generation. These overlapping controls
are not additional real-model successes or a complete Windows suite.

## Real-model V4 result: admission failed

The complete two-case diagnostic ran once, using real `openai/gpt-6-luna`
checkers with deterministic local producer/controller roles. It lasted 97.232
seconds and issued three checker attempts. No larger comparison was admitted.

| Case | Attempts | Final outcome | Independent diagnosis |
| --- | ---: | --- | --- |
| Valid action | 2 | Invalid output, exhausted | First aggregate contradicted its supported finding; second mechanical verdict contradicted exact host action facts. The runtime correctly rejected both. |
| Known defect | 1 | Valid substantive rejection | Correctly rejected reported exit 1 against required exit 0. An additional valid manifest read/citation violated the frozen diagnostic's exact recipe. |

Both original diagnostic grades remain failed. Independent inspection verified
the negative case's citations; its combined missing/forged failure wording does
not establish a forged or missing record. The future V5 apparatus distinguishes
that qualification failure from verdict correctness and permits one bounded
manifest read. It is not a retrospective regrade or a real-model V5 result.

Each case executed ten producer calls, retained the original journal through a
completed requested parent summary and one server restart, and avoided producer
replay. Compaction exposure and evidence preservation are observed separately
from successful continuation: the failed end-to-end grades do not qualify
semantic recovery. This short diagnostic is not a long-session information-loss
estimate, a checker error-rate estimate, or evidence of ALG superiority.

Hosts and local providers stopped, temporary auth copies were removed, and
source/global configuration checks passed. Failed workspaces and private raw
histories remain preserved. Public evidence contains selected measurements and
receipt hashes, not credentials or raw model conversations.

Final deployment qualification and future-harness controls are recorded
separately with their exact candidate identities. Earlier V3 and paid cohort
outcomes remain unchanged. PR #14 stays draft and unmerged; all checks are local.

## Final 0.5.12 package and supplementary lifecycle qualification

Package candidate `f14bb1489773800c78dce62684d688aa94c32321` passed both fresh
installation and update from the approved `c23269c4aad0a8aff29f8a397604ad093e3fe7c0`
0.5.11 baseline on Windows PowerShell and native WSL Linux. This candidate repairs
the two stale release-version fields in npm-shrinkwrap metadata. The measured
runtime digest remains
`a2ea71bb3d694468dc039debff5ac8f9b78fdc0c4e90496b52da0335128a0c3f`,
the same runtime measured at `7a32708`.

Each platform prepared one archive and used that identical archive for update
and fresh-install acceptance. Exact manifests and byte inventories were verified
across extracted, relocated and installed roots. Six actual server/TUI receipt
pairs (baseline once and candidate twice per platform) registered the expected
21 tools and recorded the expected runtime identities. The six version probes
exited zero; isolated configuration snapshots, custom settings/agents, doctor,
exact redeploy no-op and recorded process cleanup checks passed. Windows used
OpenCode 1.19.5; Linux used 1.18.35. Cleanup scope is Windows root-process and Linux
POSIX process-group coverage, not an independent census of every descendant.

| Recorded stage (seconds) | Windows PowerShell | Native WSL Linux |
| --- | ---: | ---: |
| Stock package preparation | 227.947 | 5.656 |
| Baseline 0.5.11 deploy | 584.563 | 6.537 |
| Candidate update deploy | 402.606 | 7.372 |
| Candidate fresh deploy | 402.188 | 9.491 |
| Exact redeploy no-op after update | 16.531 | 2.230 |
| Exact redeploy no-op after fresh install | 17.136 | 2.268 |

These are descriptive stage timings on one Windows host and its WSL environment,
not a platform benchmark or a causal speedup estimate. Full preparation/archive
timings and exact runtime, manifest, archive and production-dependency identities
are in [package-acceptance.json](package-acceptance.json); original private receipt
hashes are in [package-manifest.json](package-manifest.json).

The corrected candidate's single full Linux suite passed **1,637 tests, 17 skips,
zero failures, 17,714 assertions** in **521.417 seconds**; its typecheck passed.
The skips were **11 Windows-only, five PowerShell-unavailable and one opt-in L2
host lifecycle**. This is not a full Windows-suite claim. Earlier attempts remain
separate in the package record:

- The superseded `74add17` Linux full suite had **1,636 pass / 17 skip / 1 fail**:
  release-version metadata disagreed with the npm lock authority.
- The `74add17` Windows package attempt was explicitly stopped as superseded
  before any server/TUI acceptance stage.
- The broad Windows manager check was explicitly interrupted after 408.755
  seconds and is not a passing suite.
- The earlier partial Linux engineering fixture omitted `bun.lock`; its manager
  subset had **95 pass / 6 skip / 1 fail**. Those six skips were five
  PowerShell-unavailable tests and one Windows-only Node fallback.

Separate zero-paid local-provider CLI runs then exercised actual Build and ALG
host lifecycles on each platform. Every arm recorded q0/qh/qc/qr checkpoints,
four host writes, an observed summary, a distinct session handoff, one restart,
completed message census and cleanup, and unchanged recorded global configuration.
The Linux CLI took **24.953 seconds**. The retained Windows exit receipt reports
exit zero but no elapsed duration; that value remains unknown. Windows also has
no separate post-CLI source snapshot in these receipts.

These CLI runs did **not** execute or retroactively pass the skipped unit wrapper.
The original CLI exposed a stale descriptive-wording assertion in that wrapper.
A separate test-only correction now checks observed session identities and leaves
the success flag unset until every assertion passes, preserving failure evidence.
Four saved-receipt controls passed **19 assertions**, and the final test-only
TypeScript check passed. Failure-retention placement was reviewed statically.
These controls do not change the historical 17 skips or qualify a new package.

[Supplementary lifecycle evidence](supplementary-headless.json) and its
[receipt manifest](supplementary-headless-manifest.json) retain those boundaries.
Raw file SHA-256 values are authoritative for file identity; the CLI's legacy
reported digest uses JSON serialization of a Node Buffer and is labelled
separately. This is mechanical host lifecycle evidence, not semantic retention,
task accuracy or ownership transfer. V4 remains failed, V5 remains unissued, and
no sixteen-arm comparison was admitted. The release remains draft and unmerged.

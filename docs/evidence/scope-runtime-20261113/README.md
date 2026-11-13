# 0.5.11 scope and deployment qualification

Final code/package candidate: `73370efe5bd88d55a7bb5a2b37567130bd5139c3`.
`manifest.json` binds 33 copied payloads, including failed attempts; `summary.json`
contains the computed final result. The collector asserts the final gate,
actual-hook proofs, cleanup, preflight and cross-platform runtime identities.

- Native Linux full `bun run check`: **1,475 passed, 16 platform skips, zero
  failures; 16,405 assertions**. Typecheck, package extraction, smoke, actual V1
  server/TUI registration and optional manifests passed.
- Actual Windows **1.19.5** and Linux **1.18.35**: host memory hooks write after
  baseline capture, the fresh checker completes, and unauthorized user-file
  drift blocks checking with zero additional SDK creates/prompts or reservations.
  Each host also passed one requested compaction and two restarts, retained the
  allowance and investigation result, and cleaned up its temporary environment.
- All **136 runtime files** match after line-ending normalization. Windows's
  headless receipt was produced at `4a9d5b1`; later changes repaired package
  metadata and installer bounds, leaving this runtime byte-identical.
- Windows focused regressions initially reported **141 passed, one skip, one
  failure**. The stale npm lock version was fixed and its exact regression
  passed. New probe calibration passed **14 tests**; final package extraction
  passed **two tests/239 assertions**; the compatibility activation boundaries
  passed **three tests/12 assertions**. Sets overlap and are not a full Windows
  suite. Reviewer-only test output is not substituted for these retained logs.
- Shared hard-case qualification: **18 direct and six HTTP cases**. All **12
  no-generation preflight arms** passed with cleanup and unchanged global
  configuration. These establish apparatus readiness, not model solve rate.

The initial Linux `4a9d5b1` gate **failed**: 1,399 passed, 16 skipped and 74 failed.
Stale lock metadata, the 16-version compatibility ceiling and two unexcluded
development documents caused the deployment failures. Its later actual-host
probe passed, but the gate remained failed. Both that receipt and the Windows
failure are preserved; neither is relabelled as a pass. The corrected gate is a
separate invocation. All 17 historical compatibility declarations are retained
within a shared limit of 64, and the npm package matches 209 reviewed paths.

These synthetic-provider host checks verify mechanics. They do not establish
model-quality retention, a natural-compaction loss rate, remote datalake
acceptance, superiority to Build or a newly prepared offline transfer bundle.
Old scope baselines retain their policy; v2 baselines need the 0.5.11 reader.

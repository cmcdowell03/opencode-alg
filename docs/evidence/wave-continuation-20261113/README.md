# Wave continuation and exposure qualification

Exact code candidate: `5500ad6afad56b5ccc3bfdd0b90c568b3413a56d`, ALG
0.5.11. This is local focused and actual-host qualification, not a new full
suite or a paid comparison. No provider credentials or paid models were used
by the headless checks.

| Check | Measured result |
| --- | --- |
| Final Windows focused regressions | 60 passes, 0 failures, 477 assertions |
| Native Linux focused regressions | 123 passes, 0 failures, 789 assertions |
| Typecheck | Windows and Linux pass |
| Windows extracted package | 2 passes, 239 assertions; reviewed inventory retained |
| Future hard-case apparatus | 24 direct and 8 HTTP controls pass, including extra-field rejection |
| Actual Windows OpenCode 1.19.5 | Headless acceptance passes |
| Actual Linux OpenCode 1.18.35 | Headless acceptance passes |
| Runtime source comparison | All 136 files equal after LF normalization |

Both actual hosts persisted `phase=wave-limit` and the same-run continuation
guidance after one producer attempt. After one requested root compaction and
two restarts, the fresh checker completed. The dispatch ledger remained
**1 → 1 → 2**; an exhausted subsequent phase dispatched **zero** additional
children. Actual memory-hook writes remained in the excluded runtime scope;
independent user-file drift blocked checking before any new SDK child or
reservation. Each host reported process/provider/MCP cleanup, temporary
environment removal, no inherited credentials and unchanged real-user config.

Windows runtime SHA-256:
`72e64f65111713a33a3e82ff1e51ef28bf9a264e34eaad4ec25cb38357d91f59`.
Linux runtime SHA-256:
`98562295c5f797805e70c57b9cb3b785fbc290e6f5008600458aee05669983ed`.
Different raw identities reflect line endings; the per-file comparison is
retained in both identity receipts.

These checks demonstrate mechanics with a deterministic local provider. They
do not demonstrate a real model choosing to resume, improved task success, or
information retention through long sessions. The separate
[paid cohort](../hard-scope-20261113/README.md) remains unchanged.

Preserved development failures are not passes:

- The initial wave test compared JSON property order after a durable reload;
  object contents and immutable references were equal. The assertion now
  compares complete objects. Its 38-pass/1-failure log remains present.
- An initial typecheck found a widened string in the literal wave-pause
  receipt. The recorder now validates the literal; the final typecheck passes.
- The first WSL archive setup could not resolve a Windows worktree pointer.
  No tests started. The same commit was archived through the primary checkout
  into a new native directory; the unused first directory remains untouched.

The initial 71-test measurement log predates final public-contract disclosures
and overlaps final checks; counts are not added together. The prior full-suite
gate remains tied to `73370ef`, not relabeled as this candidate.
[manifest.json](manifest.json) binds 19 exact payloads, including the local
collector and Bash recipe. Only subsequent documentation/evidence changes are
outside the tested code identity.

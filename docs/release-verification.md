# Release verification procedure

This document defines the release gate and retained evidence contract. It does
not record a particular run's test totals, source/evidence hashes, timestamps,
or local paths; those values are volatile and belong in ignored task state.

## Runtime-source identity

The verification digest is a deterministic, project-relative manifest of:

- `package.json`;
- every regular, non-symlink `src/**/*.ts` file, including untracked files;
- every shipped `templates/*.json` file; and
- every bundled `agents/*.md` file.

Tests, docs, scripts, retained evidence, and unrelated package files are not
server/TUI runtime inputs and are excluded. Entries are sorted by normalized
forward-slash path. SHA-256 framing includes each UTF-8 path, its byte length,
and its exact file bytes. Collection fails closed on symlinks/junctions,
non-regular matching files, path redirection, mutation during reads, more than
256 files, a file over 1 MiB, or more than 8 MiB in aggregate.

With the verification-only environment opt-in, the loaded server and loaded
TUI independently collect this manifest from their own package root. Each must
match the reviewed digest before emitting its exact entry/root/digest/count/
byte marker. Normal startup neither scans the package nor emits the marker.

## Evidence destination

`bun run check:live` retains one JSON file under the dedicated
`opencode-alg-verification-evidence` directory below the operating system's
temporary directory. `OPENCODE_ALG_LIVE_EVIDENCE` may select an absolute file,
but it must remain under that dedicated root. On Windows, the approved
`D:\Docker\model-temp\opencode-alg-verification-evidence` root is also
accepted when available; it is an optional host-specific location, not a
portable requirement.

This retained JSON is external release evidence. It is distinct from the
`alg-live-verify-*` isolated project tree, which the live verifier removes in
its final cleanup path. The dry smoke likewise removes its exact created
`alg-smoke-*` project tree after success or failure. Neither temporary project
tree is intentionally retained, and prefix cleanup must not touch the dedicated
`opencode-alg-verification-evidence` directory or any unrelated temporary file.

The verifier rejects the entire containing Git repository, sibling repository
paths, and all other arbitrary destinations. It creates missing destination
parents one component at a time, rejects symlinks/junctions, and realpaths
every existing component before writing. Evidence is bounded to 512 KiB.

## Required procedure

Run from the package root without installing, publishing, committing, pushing,
or changing user/global OpenCode configuration:

1. Run focused runtime-source/live and destination-confinement tests.
2. Run strict typecheck.
3. Run `bun run check:live` twice and review both summaries.
4. Run publication/owner concurrency stress and the relevant path tests.
5. Run complete `bun run check` (typecheck, all tests, dry smoke, live proof).
6. Run `git diff --check`; review status/debug artifacts and orphan processes;
   safely enumerate only direct temporary-root children matching exact
   `alg-live-verify-*` or `alg-smoke-*` prefixes and confirm that none remain.
7. Capture the final retained evidence and review its bounded content/hash.
8. Update ignored task state with the exact final totals, runtime, engine range,
   SDK pin, runtime-source digest, evidence path/hash, and completion timestamp.
   Do not run live verification afterward unless task state is updated again.

Expected Windows-only fixture limitations, if any, must be reported rather
than silently converted to success.

## Pass and evidence contract

`passed` is assigned only after all compatibility, registration, raw tool-ID,
and loaded-checkout checks pass; server and TUI process cleanup is confirmed;
and temporary-environment removal succeeds. A cleanup exception or
`temporary_environment_removed:false` forces both retained `passed:false` and
`check:live` failure while still retaining bounded failure evidence when the
destination remains writable.

Retained evidence and the printed summary identify:

- generation time, no-model-call claim, declared engine requirement, runtime
  executable/version, and plugin version;
- canonical package root/spec and exact server/TUI entry points/registrations;
- runtime-manifest digest, sorted `{path, bytes}` entries, file count, aggregate
  bytes, and enforced bounds;
- exact server and TUI source-identity markers;
- raw tool endpoint status/body, parsed ALG tool IDs, and exact TUI registration;
- server readiness attempt count; transient empty/partial responses are polled
  until both the exact ALG tool set and expected source marker are present, while
  process exit or the hard overall timeout fails with the last response and logs;
- isolated config/project paths and confirmation that user/global config was
  not modified;
- process root PIDs, bounded output tails, termination attempts/results, and
  cleanup pass state;
- `temporary_environment_removed`, final `passed`, and a bounded reason/failure;
  and
- retained evidence path, byte size, and independently calculated SHA-256 in
  the `check:live` summary.

Any hash, test total, duration, or evidence path shown outside ignored task
state is non-authoritative unless it was produced by the current invocation.

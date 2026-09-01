# Release verification procedure

This document defines the release gate and retained evidence contract. It does
not record a particular run's test totals, source/evidence hashes, timestamps,
or local paths; those values are volatile and belong in ignored task state.

## Runtime-source identity

The verification digest is a deterministic, project-relative manifest of:

- `package.json`;
- every regular, non-symlink `src/**/*.ts` file, including untracked files;
- every shipped `templates/*.json` file; and
- every bundled `agents/*.md` file; and
- exactly `capabilities/excel/{manifest.json,policy.py,pyproject.toml,uv.lock,workbook.py,wrapper.py}`.

Tests, docs, scripts, retained evidence, and unrelated package files are not
server/TUI runtime inputs and are excluded. Manager and installer scripts are
explicitly on-demand release support: Git tag/full-commit resolution plus
staged package, package-lock, export, dependency, and runtime-manifest checks
bind what they activate, while they are not loaded by either plugin entry point.
Generated Python caches are excluded. `.gitattributes` fixes the strict Excel
text assets to LF so manifest hashes are reproducible in Windows local clones;
verification requires a clean clone and exact manifest hashes.

For package v0.3.0, the `src/**/*.ts` rule necessarily includes all six
skill-evolution runtime modules: `skill-evolution-evidence.ts`,
`skill-evolution-historical.ts`, `skill-evolution-runtime.ts`, `skill-evolution-schemas.ts`,
`skill-evolution-store.ts`, and `skill-evolution-tools.ts`. They are not a
parallel hand-maintained exception list; omitting any matching regular source
file changes/fails source identity and the reviewed npm allowlist.
Entries are sorted by normalized
forward-slash path. SHA-256 framing includes each UTF-8 path, its byte length,
and its exact file bytes. Collection fails closed on symlinks/junctions,
non-regular matching files, path redirection, mutation during reads, more than
256 files, a file over 1 MiB, or more than 8 MiB in aggregate.

## Full release-input identity

The runtime-source identity above intentionally remains unchanged and narrow: it
proves the code/assets loaded by live server and TUI entries. The aggregate gate
also computes a separate bounded `release_inputs` identity over every reviewed
npm-packed path, every allowlisted file below `tests/`, and release controls
`.gitattributes`, `.gitignore`, `.npmignore`, `bun.lock`, `package-lock.json`, and
`tsconfig.json` (with `package.json` already packed). Sorted framing includes path,
regular-file type, mode, size, and exact content. Symlinks, redirected/unsupported
types, caches, unsafe paths, more than 512 files, files over 2 MiB, aggregate data
over 16 MiB, and mutation during reading fail closed.

The gate measures this identity immediately before its command sequence and again
after all commands and npm package checks; exact equality is required. Release
evidence records its digest/count/bytes, semantic verification recomputes it from
the current checkout, and the retained filename is
`release-gate-<release-input-prefix>-<uuid>.json`. Thus same-length changes to a
manager script, document, or test invalidate retained evidence without changing
the narrower runtime-source/live digest.

Final release evidence uses the same immutable publication shape as live evidence:
a same-directory exclusive temporary is measured by device/inode immediately
after its exclusive write, then hard-linked create-if-absent to the UUID final
name. The final must have that exact identity and bytes/hash. The temporary is
removed only while its recorded identity/content remain unchanged, and the final
is rechecked afterward. A UUID collision, same-byte final replacement, or
same-name temporary replacement fails while preserving foreign state.

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

Before creating the isolated child HOME/XDG environment, the verifier resolves
the real-user XDG/HOME OpenCode config root and, on Windows, the APPDATA root;
duplicate roots are collapsed. It snapshots only each root directory and the
allowlisted `opencode.json`, `opencode.jsonc`, and `tui.json` files. The same
paths are measured after process and temporary-tree cleanup. Evidence contains
state/type, size, mode, nanosecond timestamps, and keyed content fingerprints.
The HMAC key is randomly generated per invocation and is not retained, so the
JSON contains neither config contents, absolute config paths, nor reusable raw
content hashes. Any endpoint difference, redirection, unexpected type, oversized
file, or snapshot failure makes the live result fail. This proves equality of
the two measured endpoints for the explicit allowlist; it does not continuously
observe the interval or cover other files under those roots.

## Required procedure

Run from the package root without installing, publishing, committing, pushing,
or changing user/global OpenCode configuration:

The reproducible aggregate command is:

```text
bun run release:gate -- --evidence-dir <absolute-external-directory>
```

The mandatory destination must be outside the repository. One strict package-
v0.3.0 release JSON (maximum 512 KiB) uses schema 5 and records eleven unique
command IDs in required order,
argument vectors, executable identities/relationships, exit status, and complete
redacted stdout/stderr under per-command and aggregate byte limits. Sizes and
digests cover those exact retained UTF-8 strings. It records parsed totals, the
complete sorted npm `{path,size,mode}` inventory/digest, source and
release-input identities, Excel hashes, cleanup, and global-config proof.
Release evidence schema v5 requires `package_version:"0.3.0"` and runs
`bun test tests/manager.test.ts --timeout 60000` as exact `manager_tests`
evidence in addition to the full suite, parses and binds
its pass/skip/fail/test/assertion/file totals, and verifies then references the separately retained live
evidence by path/hash/size/device-inode identity instead of duplicating it.
Each live artifact uses `live-verification-<source-prefix>-<random-uuid>.json`
and the same identity-bound temporary plus no-clobber hard-link publication. The
live CLI records final device/inode identity; aggregate and later strict semantic
verification require it, so even a same-byte replacement fails. A later live
check creates a different file and cannot replace release-referenced evidence.
The referenced live JSON remains strict schema v2 with kind
`opencode-alg-live-verification`; unknown or malformed critical fields fail shape
validation before semantic checks. Release schema 5 does not renumber the live
contract. The manager/receipt protocol likewise remains `0.2.0` and is checked
separately from the package version.
Schema v5 also records strictly marked Windows helper counts before and after
the commands and requires zero net additions. Cleanup is limited to additions
to that TEMP snapshot whose strict owner is proven dead or PID-reused;
preexisting, malformed, unmarked, live, or ambiguous directories are preserved.
Local hashes prove byte consistency, not authenticity against coherent rewriting.

Shape validation alone is not a pass. A separate semantic pass before and after
retention binds command IDs, argv0 families/relationships, arguments/cwds,
retained-output sizes/hashes, and Bun/Python totals parsed from that output. It
parses manifest/wrapper/npm JSON, checks exact wrapper tools/policy/EOF, and
binds complete npm metadata and totals to the current allowlist and file sizes.
The referenced live JSON is strictly validated against the current root/source,
runtime manifest/bounds, registrations, tools, compatible version, isolation,
nonempty config snapshots, and cleanup before its SHA-256/source/snapshot digest
is cross-bound. The release artifact is written under an exact
`release-gate-<release-input-prefix>-<uuid>.json` path, reread, and checked for exact
device/inode identity/bytes/size/hash and current semantics before that metadata
is returned. Recorded
npm packed-byte totals are cross-bound to retained npm output (while unpacked
bytes also equal summed file sizes); this is still a local command record, not
a cryptographic signature.

1. Run focused runtime-source/live and destination-confinement tests, including
   exact 15-tool startup registration with skill evolution disabled in the
   isolated live configuration and automatic inclusion of all six new runtime
   modules.
2. Run strict typecheck.
3. Run Python capability policy/utility tests with available Python `>=3.10`.
4. In a temporary lock environment only, run `uv sync --frozen --no-dev` and
   wrapper `--check`; require `excel-mcp-server==0.1.8`, all exact 25 tools, and
   rooted-policy success. Do not start the long-running MCP.
5. Recompute manifest hashes, inspect `uv.lock` for the authoritative wheel
   SHA-256, and clone a local fixture to prove LF hash stability/clean status.
6. Run `bun run check:live` twice and review both summaries.
7. Run publication/owner concurrency stress and relevant path/manager tests.
8. Run complete `bun run check` (typecheck, all tests, dry smoke, live proof).
9. Run `git diff --check`; review status/debug artifacts and orphan processes;
   safely enumerate only direct temporary-root children matching exact
   `alg-live-verify-*` or `alg-smoke-*` prefixes and confirm that none remain.
10. Capture the final retained evidence and review its bounded content/hash.
11. Update ignored task state with the exact final totals, runtime, engine range,
   SDK pin, runtime-source digest, evidence path/hash, and completion timestamp.
   A later live verification must leave the release-referenced unique artifact
   byte-identical; verify that invariant when another check is run.

Expected Windows-only fixture limitations, if any, must be reported rather
than silently converted to success.

## Pass and evidence contract

`passed` is assigned only after all compatibility, registration, raw tool-ID,
and loaded-checkout checks pass; server and TUI process cleanup is confirmed;
temporary-environment removal succeeds; and the measured global-config
allowlist has equal before/after snapshots. A cleanup/snapshot exception or
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
- the exact ordered server IDs `alg_templates`, `alg_models`, `alg_criteria`,
  `alg_plan`, `alg_run`, `alg_status`, `alg_resume`, `alg_artifact`,
  `alg_transfer`, `alg_skill_evolution_status`,
  `alg_skill_evolution_audit`, `alg_skill_evolution_historical`, `alg_skill_evolution_review`,
  `alg_skill_evolution_promote`, and `alg_skill_evolution_rollback`, plus the
  exact startup marker proving `skill_evolution=disabled` for the no-model live
  run;
- server readiness attempt count; transient empty/partial responses are polled
  until the exact ALG tool set, expected source marker, and exact disabled-
  feature startup marker are present, while
  process exit or the hard overall timeout fails with the last response and logs;
- isolated config/project paths plus the allowlist, before/after metadata and
  ephemeral-key HMAC snapshots, and their equality result (not config contents
  or a claim about non-allowlisted paths);
- process root PIDs, bounded output tails, termination attempts/results, and
  cleanup pass state;
- `temporary_environment_removed`, final `passed`, and a bounded reason/failure;
  and
- retained evidence path, byte size, and independently calculated SHA-256 in
  the `check:live` summary.

Any hash, test total, duration, or evidence path shown outside ignored task
state is non-authoritative unless it was produced by the current invocation.

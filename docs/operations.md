# ALG operations checklist

- Runtime support follows `package.json` `engines.opencode` (`>=1.18.0`) for stable OpenCode releases; live verification is currently exercised with `1.18.18`. The compiled SDK/plugin dependency is separately pinned at `1.18.3` and does not raise the runtime floor.

## Registration

- Register one package-root `file:///.../alg` spec in `opencode.jsonc` and the same spec in `tui.json`.
- Do not register `src/index.ts`, `src/server.ts`, or `src/tui.ts` directly.
- Keep server `{ id, server }` and TUI `{ id, tui }` entry modules separate.
- Quit and restart OpenCode after changing registration, bundled/installed agent files, plugin code, or global models.

## Models

- `/alg-models` edits global `agent.<role>.model` and optional `agent.<role>.variant` for explorer/researcher/implementer/checker. Choose a model, then choose **Default model effort** or one exact, non-disabled key dynamically read from that model's runtime `variants` catalog; there is no universal effort enum.
- Project tool examples: full set `alg_models agent=checker provider_id=p model_id=m variant=exact-key`; variant-only update `agent=checker variant=other`; effort reset `agent=checker clear_variant=true`; full inheritance `agent=checker clear=true`. Add the current `revision` for CAS. Variant-only/reset requires an existing project role model; full set without `variant` selects model-default effort.
- Snapshot precedence at plan creation: complete project `alg_models` selection, merged explicit `agent.<role>.model` plus its role `variant`, then merged top-level model-only `model`. A role variant never follows a top-level fallback.
- Model specs split at the first slash. Runs freeze model + optional variant together, so later settings do not affect any role retry in an existing run. Prompts use model-only `{providerID, modelID}` in `body.model` and separate top-level `body.variant`; unset fields are omitted.
- Explicit global effort PATCHes model and variant together; model-default effort uses a model-only PATCH when no variant exists. If a variant must be removed, Default effort locally sets the selected model and deletes variant in one JSONC transaction; Inherit locally deletes model and variant together. Local deletion requires a loopback API response URL and exactly one local role source matching that API read; unavailable/non-loopback URLs and zero, ambiguous, split, or mismatched sources fail closed. Successful edits preserve comments/encoding and create exact backups.
- Quit and restart OpenCode after every global model/effort save before relying on the change.

## Runs

- Only the owner session may operate a run; use `alg_transfer` for audited handoff.
- Transfer proves caller ownership before probing the target, validates the target through `session.get` in the current project/directory scope, then locks and rechecks ownership while committing.
- Pass criteria directly to `alg_plan`; `alg_criteria` only edits an owned `planning` run and never stages a second run.
- Attempts include the first invocation and never reset on resume.
- Filesystem roots (`/`, drive roots, and UNC share roots) require `allow_filesystem_root=true` separately on plan, run, and resume. Each root approval persists operation, `authorized:true`, canonical path, actor, and time; an earlier approval never carries forward. Above 64 entries, progress keeps a 64-entry tail and an owner-bound immutable complete-history reference with exact total and per-operation counts. Compact load verifies containment/hash/size/kind/owner/run, the ordered tail, total, and computed operation distribution, then discards archive entries; full detail restores every entry in order. Legacy omitted-only histories remain loadable and report their unknown operation distribution explicitly.
- Plan/run/resume/status/artifact responses default to `detail=compact`. Full run/resume/status recursively verifies and hydrates every archived attempt, detail/output/failure reference, failure projection, and root-authorization reference, including complete typed output, failures, authorizations, sessions, timing, outcome, score, shell/schema/error, and feedback fields; explicit full output can be much larger than progress. Full status-list hydrates every exactly-owned run or reports the precise run that failed. Request `alg_artifact detail=full` for complete current typed node content. Compact run/resume/status reload one committed projection for summaries and `state_projection`; bounded verification may read complete sidecars but discards archive entries from the response. Compact list mode returns at most 20 summaries; compact plan/run/status JSON is capped at 64 KiB and artifact previews at 2 KiB.
- `alg_run` and `alg_resume` are synchronous wave calls, not live streams. Bound work with `max_waves`, then use status/resume and `/alg-runs` between calls.
- `done:false` implementer output requires blockers and remains an incomplete failed attempt.
- Implementer file metadata is normalized project-relative and realpath-contained by the project; artifact paths are realpath-bound under `.opencode/runs/<current-run-id>/artifacts/**`.
- Aggregate output, graph, worker/checker prompt, projected progress, and per-sidecar byte caps reject impossible states before writes. Every progress save stays below 5 MiB with reserved headroom. Every new attempt/node failure projection carries a ref-independent canonical complete-list SHA-256/count commitment; legacy uncommitted projections remain readable, report weaker verification, and migrate on save. Every save, including non-execution transfer, first verifies and recursively materializes retained legacy trees, exclusively publishes full-SHA-256 immutable children and then parent attempt/authorization archives, prepares independent non-authoritative fixed mirrors, commits progress, and finally runs bounded GC evaluation. No newly committed manifest retains a directly or recursively reachable fixed legacy reference. Current replacement occurs before backup rotation: current-rename failure preserves current and backup bytes, while post-commit backup failure preserves the committed current and prior backup without reporting a false failed commit. GC recursively proves current/backup reachability and leaves unknown files untouched; physical deletion is currently deferred because no durable ledger can prove ownership of an unreferenced hash-shaped name. Existing immutable or projection mismatches fail closed. Legacy manifests remain readable and migrate without invalidating backup recovery.
- Post-commit GC is non-authoritative and conservative: containment/opendir/realpath/permission/candidate errors retain files and never report an already committed progress save as failed.
- Caller `RunState` passed to persistence must remain plugin-produced plain data: ordinary objects/arrays with supported prototypes and own data properties. Descriptor-only recursive validation rejects accessors, custom prototypes, cycles, enumerable symbol data, and cross-path reuse of independently synchronized run/node/attempt identities without invoking getters. It deliberately permits read-only sharing below those mutable roots. After the descriptor snapshot, Node-compatible `node:util` `types.isProxy` explicitly rejects every captured Proxy, while descriptor post-validation catches stateful trap mutation. `structuredClone` operates only on the materialized plain snapshot to supply detached cloneability/data isolation, not Proxy detection. All checks occur before preparation, locks, or writes.
- Successful save copyback preserves the caller's run, retained node, and visible retained-attempt identities, removes extra configurable own keys (including hidden strings and symbols), and synchronizes every archived/replaced caller attempt identity to its matching fully hydrated committed attempt before detaching it from the visible tail. Non-configurable extra keys fail synchronization preflight. A non-configurable canonical data property is accepted only when it is writable for the exact required assignment, or when its non-writable value is already exact; accessors and incompatible fixed values fail precommit. The complete delete/set/define plan is descriptor-prevalidated immediately before authoritative rename and applied without postcommit inspection, getters, or splice. An impossible prevalidated mutation failure after rename receives `CommittedStateSynchronizationError` with `committed=true` and canonical `committed_state`, so an advanced manifest is never reported as uncommitted.
- Integrity-checked immutable sidecar strings are non-transforming on read. Padded failures, operations, sessions, paths, IDs, and timestamps fail rather than trim; full attempt details reject projection-only refs, commitments, and omission metadata.
- Attempt archive references persist and verify exact outcome plus feedback-route counts. Compact routing adds archive metadata to the visible tail once; legacy refs without counts explicitly report unknown archived outcomes/routes.
- Integrity threat model: SHA-256 references/counts detect collisions, stale or mismatched objects, and partial writes, and hydration fails closed under accidental corruption or uncoordinated mutation. They do not authenticate state against a principal that can coherently rewrite authoritative manifests, referenced objects, hashes, and counts. That authenticity requires an external trusted signing key or append-only ledger and is out of scope; do not describe local references as tamper-proof or cryptographically authentic.
- Checkers use fresh children without explicit worker transcript forwarding; SDK project/system/tool/filesystem context still applies.
- Schema-invalid output retries its originating node. Schema-invalid checkers retry themselves; only schema-valid checker rejection routes substantive feedback to the worker/researcher.
- `/alg-runs` uses public project-relative SDK file APIs and directly reads `.opencode/runs/_owners/<sha256-session-id>.json`, a non-authoritative owner projection capped at 64 entries/32 KiB and atomically refreshed on create/save/transfer. Compact discovery does not read archives until node selection. It revalidates owner and authoritative timestamps from progress reads capped below 5 MiB and reports total/archived/visible attempts truthfully. After node selection it performs at most one bounded archive read, validates every record with the shared authoritative persisted-attempt parser, merges archive plus tail without duplicates, and exposes every attempt in pages of 32 plus previous/next controls. Immutable schema-v2 archives receive exact full-SHA path, raw-size/hash, owner/run/node/kind/schema/count, and nested-reference checks. Legacy fixed archives—including genuine schema-v1 documents without `kind` or `owner_session_id`—receive exact contained run/node path, bounded read, strict schema and contained run/node identity, canonical logical-size/count and nested-reference checks, but no SHA verification; one bounded warning identifies their weaker integrity. Before navigation, reference-only attempt output is read on demand through the same public API, bounded and cached for the command, and checked for immutable path/hash/size plus strict agent schema, score, outcome, and run/node/attempt relationships. It materializes at most 64 nodes/100 archived attempts per node, caps every rendered title/description/ID and toast, and retains the exact validated session ID separately for navigation. Missing/corrupt/schema-invalid/mismatched archives or outputs fail visibly without navigation; missing/malformed owner indexes use at most 64 bounded legacy candidates.
- `/alg-runs` parses graph identities first and rejects missing/extra/duplicate/mismatched graph/state IDs or agents. Every visible and archived row uses the strict shared attempt parser; legacy compatibility is explicit, not a permissive no-output bypass.
- Schema-v1 fixed archives may contain fixed nested `artifacts/<node>-attempt-<n>.json` output and `history/<node>-attempt-<n>.json` detail references. The TUI permits only those exact contained run/node/attempt/kind paths, reads them lazily through public project-relative SDK calls, applies finite store-equivalent formatted JSON bounds and canonical logical-size semantics, parses full detail identity/projection plus strict agent output, and emits one invocation-deduplicated warning without claiming SHA integrity. Immutable nested references retain exact full-SHA path, raw byte/size/hash, kind, owner/archive, run, node, and attempt checks.
- Status listing minimally identifies ownership before parsing remaining state. Malformed exact-owner candidates are counted/reported (and make full listing fail with the run ID); parseable malformed other-owner bodies are not parsed or disclosed.
- Model resolution records planner/explorer/researcher/implementer/checker/repair/default with source provenance. Unknown SDK defaults and legacy runs remain explicitly unknown.
- SDK diagnostics are bounded, circular-safe, and statefully redact headers, credentials, prompts, content/messages/payload/body/input assignments, and escaped/nested serialized variants while retaining unrelated safe status/code/message/request IDs.
- Review every shell command and rely on OpenCode `bash` permission prompts/patterns.
- Timeout/cancel attempts tree termination and verifies the POSIX group or prepared Windows Job. Ordinary POSIX shell-leader exit also checks and terminates a surviving detached process group before returning. `termination_failed` remains explicit when privileged or other unconfirmed cases prevent containment proof; descendants may remain.
- Windows commands launch only after a private per-process native helper has configured the Job and its prepared watcher is control-ready; timeout starts at command-ready. The bundled helper is compiled once in a random private temporary directory and never loaded from a predictable shared cache.
- Each v13 PID/UUID helper directory has an exclusive strict bounded owner
  marker with random token, PID, OS process-start identity/time, creation time,
  and helper name. Concurrent/nearby commands lease one compile; compiler,
  launcher, watcher, and terminator children delay bounded idle deletion.
  Cleanup rechecks directory/marker identity and exact contents, retries Windows
  locks, and never recursively deletes replacements. The startup janitor touches
  only old, strictly marked grammar-valid directories whose owner is proven dead
  or PID-reused; malformed, unmarked, live-owner, legacy predictable, foreign,
  and ambiguous state is preserved. The former predictable Job-control DLL
  fallback is not used. Schema-v4 release verification snapshots helpers before
  tests, cleans only net additions, and requires zero net owned artifacts.
- Resume interrupted work; inspect stale lock and corrupt quarantine files rather than deleting unknown state.
- Quarantine is claimed only after a confirmed rename; rename failure is reported honestly with the corrupt file left in place for manual action.

## Installer

- Default install creates missing agents and skips custom agents.
- Config edits add no permission grants; copied bundled agent files intentionally carry role permissions, including bash/edit for orchestrator/implementer.
- Explicit update/force backs up each custom agent before replacement.
- Changed configs and removed exact bundled agents get adjacent timestamped exact backups.
- UTF-8 BOM and BOM-marked UTF-16LE/UTF-16BE are preserved; unsupported encodings fail closed.
- Malformed JSONC causes no installer writes; repeated install is idempotent.
- Later config/agent commit failures roll all earlier live files back to exact preflight bytes; backups may remain for audit.
- Existing project/config path components are realpath-checked; symlink/junction escapes fail closed.

## Versioned release manager

- Use `scripts/alg.ps1` or `scripts/alg.sh`; both invoke the shared TypeScript
  CLI. Existing `install.*` launchers remain the direct, non-receipted path.
- The direct installer is non-journaled and crash-limited, but config and agent
  writes/deletes use one full-preflight transaction with independent backups,
  prepared files, hard-link claims, identity-checked unlink, create-if-absent
  publication, and complete rollback preflight. Detected foreign publication,
  deletion, or rollback races preserve third-party bytes and fail closed.
- Resolve only exact stable tags. Local source must be clean and exactly tagged;
  remote updates must match the receipt's trusted remote and descend from the
  active commit.
- The default receipt/lock/journal root is `<config>/.opencode-alg`; releases are
  `<config>/plugins/opencode-alg/releases/<version>-<commit12>/package` with temporary
  clones under `.staging/<transaction>`.
- Publication exclusively creates the parent generation reservation and
  `package` child, records their identities, and materializes a bounded snapshot
  of same-filesystem staging. Directories use exclusive creation, regular files
  use create-if-absent hard links, and only contained safe symlinks are recreated;
  modes are preserved. Count/depth/file/aggregate bounds and type/junction/
  reparse/escape checks apply. Git validation runs with optional index locking
  disabled. Staging cleanup performs a whole-tree preflight and immediate
  per-entry identity checks. Failure removes only unchanged manager-created
  entries bottom-up; foreign additions/replacements preserve the reservation.
  Occupied final reservations are never replaced. An exact valid package child
  may be reused.
- Dependency installation is staged-only npm frozen/no-script mode. Never run
  pull/reset/dependency installation in a registered or active package root.
- Each new generation receipt separately binds the package-lock digest and a
  bounded same-install identity for every production `node_modules` directory,
  file byte/mode, and contained link target. This detects added/removed/changed
  installed code and link escapes during reuse, doctor, rollback, and activation;
  it is neither cross-machine reproducibility nor npm-registry authenticity.
- Receipt commits last after byte-CAS config/agent publication. The manager
  first prepares every changed config/agent in its own directory and probes
  hard-link/create-if-absent support. For each expected-existing public file it
  exclusively hard-links a transaction-exact claim, records hash plus device/inode,
  verifies public/claim identity, then unlinks the public name and hard-links the
  prepared bytes create-if-absent. Expected-absent files skip the claim; intended
  deletes retain the claim until receipt finalization. No managed transaction
  uses rename-overwrite or unchecked removal on a public config/agent path.
  Recovery applies the same before/after/absent/third-state identity protocol.
  The immutable journal also records a prepared receipt, and the manager exclusively hard-links the old receipt to the exact
  transaction-derived claim path. The `receipt-linked` phase records device/inode
  identity before the public old name is removed under repeated hash/identity
  checks. A pre-existing, third-party, or mismatched claim is preserved with the
  journal rather than overwritten or discarded. Receipt backup/claim/prepared
  paths must exactly match the validated transaction ID and are deleted only
  after regular-file, non-symlink, hash, and identity checks. Journal agent paths
  are restricted to the exact five bundled names directly under the canonical
  agents root. Journals support
  deterministic doctor reporting and verified safe rollback; no cross-file
  atomicity or power-loss guarantee is claimed.
- The receipt CAS baseline is the exact raw byte hash (or absence) read before
  planning. It is not refreshed at commit time. The manager rechecks it before
  journal/live publication and immediately before receipt replacement, and
  re-hashes every journal file after all live-write hooks return. Concurrent
  receipt formatting/state or third-state config/agent changes cannot be
  overwritten or followed by a stale receipt commit.
- Rollback revalidates the retained generation before any config/agent write:
  clean tracked/untracked Git state, trusted `origin`, exact HEAD/tag/receipt
  commit, package/lock identity, installed dependency identity, runtime digest, agents,
  and strict capability assets. A committed stale journal is removed only when
  the receipt has its intended after-hash and every listed live file still has
  its intended after-hash; drift retains the journal for manual inspection.
  Receipt-before repair preflights every file and required claim/prepared
  auxiliary before its first restoration, so a later third-state file or bad auxiliary causes zero writes;
  interrupted restoration remains retryable from exact before/after states.
- Run `doctor` read-only after changes. Use `doctor --repair-journal` only after
  reviewing a pending journal. `doctor --ack-restart` is user attestation, not
  restart detection; the attestation itself is a durable receipt-only
  claim/publish journal and is repaired by the same command path after a crash.
- See [`upgrades.md`](upgrades.md) for flags, agent ownership, rollback durable-
  state checks, dry-run I/O, and uninstall behavior.
- A non-cooperating process can race between the final identity check and the
  following unlink because portable filesystems expose no atomic compare-and-unlink.
  This narrow instruction-window limitation is not described as isolation.
  Hard-link create-if-absent publication cannot overwrite an occupied destination;
  every detected race/ambiguity preserves the third-party name and journal.
- Journals are append-only create-only data/anchor hard-link pairs. Numbered
  revisions bind the previous revision SHA-256; phase and claim-identity updates
  never replace prior paths. Reads require contiguous revisions, immutable field
  agreement, pair bytes, and device/inode identity. Cleanup rechecks every exact
  artifact identity. Same-byte replacement, occupation, incomplete pairs, or
  cleanup races preserve evidence. Receipt-after state requires the recorded
  prepared-receipt identity, not only matching bytes.
- The primitive hard-link probe runs inside an exclusive private directory at
  the relevant filesystem locations. Cleanup requires exact directory/file
  identity and content; foreign collision or replacement is preserved.

## Excel capability

- Excel is opt-in. Default manager/direct installation must have no
  `mcp.alg_excel` and start no Python process. Enable only with
  `--enable-capability excel --excel-root <canonical-absolute-existing-dir>`;
  ordinary update preserves prior enabled state/root and explicit
  `--disable-capability excel` removes only exact manager-owned config.
- Exact JSON equality with the desired Excel MCP entry is not ownership. Without
  an exact active-receipt `managed_config`, a pre-existing `mcp.alg_excel` is
  custom and blocks enable/update/rollback; doctor reports and uninstall
  preserves it. The manager has no implicit adoption path.
- Verify `uv` is available. Enable uses only `uv sync --frozen --no-dev` and a
  fresh `<generation>/<lock-digest>/<activation-uuid>` environment below the
  managed install root, followed by the
  short wrapper `--check`. Never substitute unpinned `uvx`.
- `doctor` is read-only: enabled state runs only bounded `--check`, while
  disabled state starts no Python. Review `disabled/healthy/missing/custom/drift`
  plus manifest/lock/wrapper/environment/runtime/version/tool-count fields.
- Stage, do not edit originals:
  `python capabilities/excel/workbook.py stage --root <root> --source <absolute-source.xlsx> --destination <relative-copy.xlsx>`.
  Existing destinations require explicit `--overwrite`; source bytes are never
  modified/deleted. Give MCP tools only the relative destination.
- Validate afterward with
  `python capabilities/excel/workbook.py validate --root <root> --workbook <relative-copy.xlsx>`.
  Treat formula/external-link findings and bounds as failures. openpyxl stores
  formulas but does not calculate them; never report recalculation or verified
  freshness. LibreOffice recalculation is out of scope for v0.2.
- The wrapper rejects absolute/traversal/NUL/non-`.xlsx`/alternate-stream and
  symlink/junction/reparse escapes and uses stdio only. This confines workbook
  path arguments; it is not an OS sandbox and ambient process permissions remain.
- For graph work, call
  `alg_plan(template="spreadsheet-diamond", shell_gate="python capabilities/excel/workbook.py validate ...")`.
  The template keeps its gate optional until plan time and ends with a fresh
  checker.
- Quit and restart OpenCode after enable, preserved update, disable, rollback,
  or uninstall. No automatic capability environment/release cleanup occurs.

## Live release proof

- Run the aggregate gate as
  `bun run release:gate -- --evidence-dir <absolute-external-directory>`.
  The destination is mandatory/outside the repository. Argument-vector
  subprocesses run typecheck, all Bun tests, smoke, isolated live verification,
  Excel manifest and no-bytecode Python tests, frozen temporary-external uv
  sync, wrapper check/EOF probe, and npm pack dry-run.
- Its strict JSON is capped at 512 KiB. It records complete redacted stdout and
  stderr under per-command and aggregate retention limits; byte counts and
  SHA-256 cover those exact retained UTF-8 strings. Ten unique command IDs are
  required in exact order, with argv/cwd/exit status and executable-family/
  relationship checks. It records parsed totals, source/manifest/lock/live-
  evidence hashes, and the complete sorted npm `{path,size,mode}` inventory,
  measured global-config snapshot result, and cleanup. It verifies and references the
  separately retained live evidence by immutable unique path/hash/size/device-
  inode identity rather
  than duplicating it. Live filenames contain the source prefix and a random
  UUID; no-clobber publication never replaces an earlier artifact. Release
  live schema v2 requires exact kind/schema and rejects unknown critical fields;
  release evidence schema v4 requires the referenced live identity and the
  separate exact `manager_tests` command/totals. Hashes provide
  byte integrity, not authenticity against coherent local rewriting.
- Runtime-source identity remains the narrow server/TUI loaded-code proof. A
  separate bounded `release_inputs` identity frames path/type/mode/size/content
  for every reviewed packed file, every allowlisted test source, and release
  controls including both locks, TypeScript config, and npm/Git attributes. It is
  measured immediately before commands and after package checks; any change
  fails the gate. Retained semantic verification recomputes it, and release
  filenames use its prefix.
- Before constructing the isolated child environment, live verification resolves
  real-user XDG/HOME (and Windows APPDATA) OpenCode roots. It snapshots only each
  root plus `opencode.json`, `opencode.jsonc`, and `tui.json`, then repeats the
  snapshot after process and temporary-tree cleanup. Entries contain file type,
  size, mode, nanosecond timestamps, and content HMACs under a random key that is
  never retained; config contents, absolute paths, and reusable raw content
  hashes are not evidence fields. Creation, deletion, metadata/content change,
  redirection, unexpected types, or an unmeasurable post-snapshot fails the live
  gate. This is an endpoint comparison of that explicit allowlist, not continuous
  monitoring or a claim about other files below the global config roots.
- Before returning success, the aggregate gate first applies its strict shape
  schema and then a separate semantic verifier. The latter cross-checks command
  IDs/executables/arguments/cwds, retained-output hashes and parsed Bun/Python
  totals, current runtime-source identity, complete npm metadata/totals/current
  file sizes, manifest/wrapper JSON, and the referenced live file's existence,
  hash, current source/manifest/registration/tool/version/isolation/snapshot/
  cleanup semantics.
  It writes a same-directory exclusive temporary, records its device/inode,
  hard-links it create-if-absent to a release-input-prefixed UUID filename, and
  requires final identity plus bytes/hash/type to match. It removes the temporary
  only while its identity/content remain unchanged, then rechecks the final. It
  rereads the exact file, verifies its recorded identity/bytes/hash/size and
  semantics, and returns that exact metadata. Same-byte replacement fails. This
  local semantic consistency check is not provenance, signature, or protection
  against a party that can coherently rewrite the checkout and all evidence.
- Strict live semantics reject a minimal object carrying only pass and cleanup
  booleans. Exact package root/spec, runtime manifest and bounds, entrypoints,
  registrations, nine ALG IDs, compatible engine/runtime evidence, server/TUI
  markers and cleanup, isolation booleans, and nonempty equal/digested global
  snapshots are all required against the current checkout.
- The complete allowlist combines runtime source identity with an explicit
  reviewed docs/manager/installer/release-script list. The gate rejects every
  extra, missing, duplicate, unsafe, or non-0644 packed path—not merely a count
  or Excel subset. It also fails on repository Python caches/venvs/tgz,
  pre-handshake wrapper stdout, or unconfirmed cleanup.

- `bun run check:live` creates isolated HOME/XDG/config/project directories, disables parent project/default plugin discovery and external skills, and explicitly registers this checkout's canonical package-root `file://` spec in separate server `opencode.json` and TUI `tui.json` files. Its own code does not intentionally edit user/global config; the measured allowlist comparison above is required before it may report that those files were unchanged.
- The verifier deterministically hashes `package.json`, every regular non-symlink `src/**/*.ts` file (including untracked modules), shipped `templates/*.json`, bundled `agents/*.md`, and the six strict `capabilities/excel` manifest/policy/project/lock/validator/wrapper files. Sorted normalized paths and exact bytes are bounded to 256 files, 1 MiB per file, and 8 MiB aggregate; symlink/junction traversal and mutation during collection fail closed. Tests/docs/scripts/evidence/generated Python caches are excluded because runtime entry points do not consume them. With a verification-only environment opt-in, both loaded entries independently recompute the digest from their own source root, fail on mismatch, and log an exact root/digest/entry/count/bytes marker. No source scan or marker is added to normal user output.
- Tool IDs or a TUI registration token from a stale/global-only plugin cannot pass without both current-checkout markers. Evidence records the canonical root/spec/version, exact entry points and registrations, manifest paths/count/bytes/digest, raw tool IDs, exact TUI token, process cleanup, and temporary-environment removal.
- Server readiness polls through transient startup responses (including an empty HTTP 200) until the expected server source marker and exact ALG tool-ID set are both present. Process exit fails immediately; a hard overall timeout retains the last HTTP status/body/IDs, request error, source-marker state, and bounded process output. An empty or partial 200 never passes and plugin load diagnostics remain visible.
- The dry smoke and live verifier create `alg-smoke-*` and `alg-live-verify-*` project trees as direct children of the canonical temporary root. Each invocation removes only its exact created canonical tree in a `finally` path; Windows `EBUSY`/`EPERM`/`EACCES`/`ENOTEMPTY` removal failures receive bounded retries, and unconfirmed removal fails the invocation. These temporary project trees are not retained evidence.
- Confirmed server cleanup, TUI cleanup, and temporary-environment removal are mandatory live pass criteria. Separately, bounded release evidence (maximum 512 KiB) is retained only under the dedicated `opencode-alg-verification-evidence` root below the system temporary directory, or on Windows under the optional approved `D:\Docker\model-temp\opencode-alg-verification-evidence` root. An absolute `OPENCODE_ALG_LIVE_EVIDENCE` selects a parent/root under one of those roots. Each retained file is `live-verification-<source-prefix>-<random-uuid>.json`, published from a same-directory identity-recorded temporary file with create-if-absent hard-link semantics and never reused. Temporary unlink and final acceptance both require exact recorded identity/content. Every existing destination parent is realpath-checked; symlink/junction redirection, the entire containing repository, sibling repositories, and arbitrary external paths are rejected. `check:live` prints the retained evidence-file path, device/inode, evidence/source digests, and cleanup state. The retained evidence root is not a temporary project tree and must not be removed during `alg-smoke-*`/`alg-live-verify-*` cleanup. The OS-temp location is the portable default; the `D:` location is host-specific and optional.

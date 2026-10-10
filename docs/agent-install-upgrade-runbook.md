# Agent runbook: install or upgrade ALG on a machine with existing state

This runbook is written for an agent operating on a user's machine. Follow it top
to bottom. Every step names the command, what success looks like, and when to
stop. It covers development-snapshot installs, which is how long-running
machines are usually set up. Tagged, manager-owned releases use
[upgrades.md](upgrades.md) instead; step 2 tells you which applies.

The helper `scripts/snapshot-upgrade.ts` implements each step. Only `backup`,
`install`, and `repoint` write anything, and none of them deletes or overwrites
existing data.

## Ground rules

- Get the user's explicit approval before step 7 (the config edit). Everything
  before it is read-only or writes only new files.
- Stop and report on any failed check. Do not improvise around a failure.
- Never delete ALG state, old snapshots, or backups. Never edit state files by hand.
- Do not run `scripts/install.ps1`, `scripts/install.sh`, or `alg` manager
  commands on a snapshot-registered machine. The installer does not recognise a
  snapshot registration and appends a second ALG entry without its options; the
  manager refuses once the config no longer matches its receipt.
- Do not enable new opt-in features (`environmentMemory`, `sessionMemory`, S3)
  during the upgrade. Each one adds configuration or on-disk data an older
  build cannot read, which removes the rollback path. Enable them afterwards,
  one at a time, if the user asks.
- Do not run historical skill review (`alg_skill_evolution_historical`) as part
  of an upgrade. See "After the upgrade".

## Prerequisites

`git`, `bun` (1.3+), `npm`, and `opencode` on PATH, and a checkout of the ALG
repository at the target commit with dependencies installed:

```bash
git clone https://github.com/cmcdowell03/opencode-alg.git alg-src
cd alg-src
git checkout <target-commit>
bun install --frozen-lockfile
```

Run every `bun scripts/snapshot-upgrade.ts …` command from this checkout. The
helper reads the OpenCode config from `OPENCODE_CONFIG_DIR`, defaulting to
`~/.config/opencode` on every platform, and OpenCode's database from
`~/.local/share/opencode/opencode.db`.

## 1. Inventory (read-only)

```bash
bun scripts/snapshot-upgrade.ts inventory > inventory.json
```

Check:

- `opencode_running` must be `false`. If it is `true`, ask the user to quit every
  OpenCode window and server, then rerun. Do not kill OpenCode yourself; the
  user may have unsaved work.
- `registrations` lists every ALG plugin entry in `opencode.jsonc`/`opencode.json`
  and `tui.json`, with its options. Record the current spec exactly.
- `state_roots` lists every directory holding ALG state, with file counts per store.
  Expect a drive root (`C:\` or `/`) when sessions were started outside a git
  repository: OpenCode's global project has worktree `/`, and ALG binds its
  state there.
- `development_snapshots` lists the installed snapshots.

## 2. Choose the path

| Current registration (from step 1) | Path |
|---|---|
| None | Fresh install: skip steps 3, 6 and the baseline in step 4; in step 7 add an entry instead of repointing (ask the user which options they want). |
| `…/opencode-alg/development/<id>/package` or a checkout path | This runbook. |
| `…/plugins/opencode-alg/releases/<version>-<commit>/package` and `managed_receipt: true` | Tagged release: use the manager as described in [upgrades.md](upgrades.md). |
| More than one ALG entry, or an entry you cannot classify | Stop and ask the user. |

## 3. Back up (writes only a new directory)

```bash
bun scripts/snapshot-upgrade.ts backup ~/.local/share/opencode-alg/backups/<UTC-timestamp>-pre-upgrade
```

This copies the config files and every store of every state root, writes
`MANIFEST.json` with a SHA-256 per file, and re-reads the copies. Success:
`"verified": true`. The command refuses to reuse an existing directory.

## 4. Build the package from an exact commit

Capture a baseline of the currently loaded plugin first:

```bash
bun scripts/snapshot-upgrade.ts verify baseline.json
```

Then build:

```bash
bun scripts/snapshot-upgrade.ts pack . <target-commit> <out-dir>
```

`pack` checks out the commit into a temporary worktree, so uncommitted changes
never ship, runs `npm pack`, and validates the tarball against the reviewed
inventory in `scripts/release-gate.ts`. Record `tarball_sha256` and `files`.
Packing the same commit twice produces the same SHA-256; if it does not, stop.

## 5. Install the snapshot (writes only a new directory)

```bash
bun scripts/snapshot-upgrade.ts install <out-dir>/opencode-alg-<version>.tgz "$(git rev-parse <target-commit>)"
```

Pass the full commit SHA; it is recorded as given.

This extracts the package to
`~/.local/share/opencode-alg/development/<yyyymmdd>-<sha12>/package`, runs
`npm ci --omit=dev --ignore-scripts` from the shipped `npm-shrinkwrap.json`, and
writes `snapshot.json` (commit, tarball hash, date) beside `package/`. Record
the returned `spec`. `@opentui/*` are installed even with `--omit=dev` because
`@opencode-ai/plugin` declares them as optional peers; the S3 SDK is not
installed (it is an optional peer of ALG, needed only for S3 replication).

## 6. Check that the new build reads existing state (read-only)

```bash
bun scripts/snapshot-upgrade.ts parse-state <package_root from step 5>
```

This parses every run, skill-evolution evidence file, and ledger in every state
root with the new build's own schemas. Success: `"ok": true`. Any failure means
the new build would not read that data; stop and report the listed files.

## 7. Repoint the configuration (needs the user's approval)

```bash
bun scripts/snapshot-upgrade.ts repoint <backup-dir> "<old spec>" "<new spec>"
```

It changes only the plugin spec string, in every config file that registers it
(normally `opencode.jsonc` and `tui.json`). It refuses unless each file is
byte-identical to its copy in the backup, the old spec occurs exactly once, and
the edit leaves the plugin options and all other configuration unchanged. Files
are replaced atomically; a UTF-8 BOM and comments are preserved. Success lists
the changed files.

## 8. Verify

```bash
bun scripts/snapshot-upgrade.ts verify after.json
bun scripts/snapshot-upgrade.ts check-backup <backup-dir>
```

`verify` starts a throwaway `opencode serve` on an OS-assigned port in an
isolated temporary git project (so ALG binds to that folder, not to real state),
asks it which tools loaded, and stops it. The server's output is kept in
`<out>.serve.log`; if the server exits or never becomes ready, the error quotes
its last lines. Compare with `baseline.json`:

- `alg_tools` is identical, unless the release notes say the tool set changed.
- `alg_registrations` shows the new spec with the same options.
- `alg_schema_sha256` changes when the new build changed any tool schema; this
  is the proof that the new code, not a cached copy, is loaded. If it is
  unchanged, the upgrade may still be correct (no schema changes), so state that
  in the report instead of claiming proof, and use the optional live smoke test
  below or a check against a changed source file in the installed package.

`check-backup` must report `changed` containing only the edited config files,
`missing: []`, and `added: 0`. Anything else means something wrote to ALG state
during the upgrade; report it.

Finally, ask the user to start OpenCode normally. The server log line
`alg plugin loaded skill_evolution=… tools=19 …` confirms the plugin loaded.

### Optional live smoke test (uses model calls)

Only with the user's consent, since it costs model usage. Create a throwaway git
project so ALG writes its state there, give it a small failing test, and run:

```bash
opencode run --dir <project> -m <provider/model> "Fix the bug so 'node test.js' passes. Use alg_plan with the coding-diamond template, then alg_run until done, failed, or blocked, then report alg_status."
```

Expect the run to finish `done` and the test to pass. In the terminal UI, each
worker should show as a subagent card under the `alg_run` call while it runs;
if the cards are unwanted, set `"subagentCards": "off"` in the plugin options
and restart OpenCode. Then start
`opencode serve` in that project once, request
`/experimental/tool/ids?directory=<project>`, and confirm that any skill audit
left `running` by the previous exit completes (skill evolution only).

## 9. Report

Report the old and new spec, the snapshot id, commit, tarball SHA-256, backup
path, the step 8 comparison, and any skipped step with its reason. Keep the old
snapshot directory: it is the rollback target.

## Rollback

Before the new build writes anything (right after the upgrade), rollback is
exact: restore `config/opencode.jsonc` and `config/tui.json` from the backup, or
run `repoint` with the specs swapped against a fresh backup.

After the new build has run, check what it wrote with
`check-backup <backup-dir>` and weigh these known incompatibilities:

- **Skill-evolution evidence.** Newer builds record `provenance.finish`; older
  builds reject it, and an older build that meets such evidence while auditing
  marks the audit permanently failed. Restore the backup's `skill-evolution`
  store together with the config. Do not hand-edit the field out: evidence ids and
  candidate revision references are content hashes.
- **`environmentMemory` in the plugin options.** Builds without environment memory
  reject the option (even `{"mode":"off"}`) and ALG fails to load. Remove the
  key when rolling back.
- **`contextBudget` in the plugin options.** Builds without dynamic context budgets
  reject the option and ALG fails to load. Remove the key when rolling back.
- **`subagentCards` in the plugin options.** Builds without native subagent cards
  reject the option and ALG fails to load. Remove the key when rolling back. The
  cards themselves need no rollback step: they are ordinary `task` parts in the
  parent transcript and an older build ignores them.
- **Session memory**, if it was enabled: an older build cannot read checkpoints a
  newer one wrote and reports recovery as blocked. Restore the backup's
  `session-memory` store.
- Anything created after the upgrade (runs, candidates) is lost when a store is
  restored from backup. Tell the user before restoring.

## After the upgrade

- Nothing re-reviews history automatically. Do not start
  `alg_skill_evolution_historical` on a long history: in the current design each
  model call sees one base64 message part, a real model cannot reproduce the
  provenance a candidate needs, plans cannot resume past a failed call, and
  reviewed turns are marked covered so later audits skip them. On a history of a
  few hundred sessions it would issue thousands of model calls.
- The skill catalog rebuilds itself from `SKILL.md` files; promotion never
  overwrites a user edit.
- ALG state is bound to the absolute project path. Moving or renaming a project
  directory orphans its runs and session memory; an upgrade does not change that.

## Known pitfalls

| Symptom | Cause |
|---|---|
| Two ALG entries after running `install.ps1` | The installer only recognises registrations under its own root. |
| `Managed registration is missing or ambiguous` from `alg` | The config was changed outside the manager; its receipt no longer matches. |
| `owner … Too big` when planning a run | Mutex owner strings embed the lock path; project paths near 150+ characters exceed the 256-character limit. |
| Runs or memory missing after moving a project | State is bound to the absolute path. |
| Legacy `.opencode/runs/<id>/state.json` runs never appear | That v0.1 layout is not read by any current build. |

## Verification record

This procedure was executed on 2026-09-28 on Windows 11 with OpenCode 1.18.31,
upgrading snapshot `20260920-4b81773d5a7f` (commit `dc55386`) to
`20260928-749ef3c337a7` (commit `47c7765`) over 16 runs, 148 ledger records, and
132 evidence files in `C:\.opencode`. Packing was reproducible; the new build
parsed all existing state; after the repoint OpenCode loaded the same 19 ALG
tools with the options unchanged and the new `alg_memory_read` schema; and the
backup manifest showed only the two config files changed.

It was executed again the same day with the helper, from `20260928-749ef3c337a7`
to `20260928-c0752f863e53` (commit `37f93de`), over 1,438 backed-up files. Tool
schemas were unchanged, so the proof came from the live smoke test: every node
passed on its first attempt, and an audit interrupted by `opencode run` exiting
completed on the next startup. One `verify` run failed transiently; the helper
now uses an OS-assigned port and reports the server's output.

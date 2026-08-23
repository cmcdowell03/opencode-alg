# Versioned install, update, and rollback

v0.2.0 adds an opt-in release manager. The existing `scripts/install.ps1` and
`scripts/install.sh` remain the compatible direct-install interface; they do
not silently migrate an installation into managed layout.

## Managed layout

For the default config directory, the manager owns only these bounded roots:

```text
<config>/.opencode-alg/
  receipt.json
  manager.lock
  transactions/<uuid>.json
<config>/plugins/opencode-alg/
  releases/<version>-<commit12>/
    package/
  .staging/<transaction>/
  capability-envs/excel/<generation-id>/<uv-lock-sha256>/<activation-uuid>/
```

Both configs contain the immutable release package-root `file://` URL. There is
no `current` symlink, junction, mutable pointer, `git pull`, or `git reset`.
Old releases are retained. Receipt history is bounded to 16 generations, so an
older unreferenced directory can remain on disk without being rollback-eligible;
the manager never performs automatic release cleanup.

The strict external receipt records canonical roots, trusted remote and stable
channel, active and retained generation identity, full Git commit, package-root
spec, runtime and lock digests, dependency manager, registrations, per-agent
managed/custom/missing hashes, durable-state compatibility, timestamps, and
restart attestation. Each generation also records optional Excel enabled state,
 canonical workbook root, strict asset/config/environment hashes and counts,
 activation-specific environment path, and exact managed MCP config. Old/no-capability receipts remain compatible
and mean disabled. The receipt contains no credentials or inherited environment.

## Commands

PowerShell and POSIX launchers call the same TypeScript CLI:

```powershell
.\scripts\alg.ps1 install --source C:\reviewed\opencode-alg --tag v0.2.0
.\scripts\alg.ps1 update --tag v0.2.1
.\scripts\alg.ps1 doctor
.\scripts\alg.ps1 rollback
.\scripts\alg.ps1 uninstall --remove-agents
```

```sh
./scripts/alg.sh install --source /reviewed/opencode-alg --tag v0.2.0
./scripts/alg.sh update --tag v0.2.1
./scripts/alg.sh doctor
./scripts/alg.sh rollback
./scripts/alg.sh uninstall --remove-agents
```

Use `--config-dir` and `--install-root` for isolated roots, `--remote` to pin an
initial trusted remote, `--version` as the `MAJOR.MINOR.PATCH` spelling of a
stable tag, `--generation` to select a retained rollback generation, `--json`
for bounded structured output, and `--dry-run` to stage/validate without live
config, agent, or receipt writes. Dry-run can create and remove manager staging
directories and obtains the manager mutex; it is not a zero-I/O promise.

Agent policy is `--agents managed|skip|force`. `managed` installs missing files,
updates receipt-managed exact old bytes, and adopts an exact verified previous
bundle. Customized files are skipped. `force` is the only policy that replaces
custom bytes and creates an exact adjacent backup. Rollback never permits
force: it replaces only files that still match the active managed hash.
Uninstall removes agents only with `--remove-agents`, and then only exact
receipt-managed bytes.

The compatible `install.*` launchers remain non-receipted and crash-limited, but
require a matching lock and disable lifecycle scripts (`bun install
--frozen-lockfile --ignore-scripts` or `npm ci --ignore-scripts --no-audit
--no-fund`); they never use mutable `npm install`. Their shared direct installer
uses the same no-clobber file primitives for both
configs and agents: complete preflight, independent exclusive backups, prepared
files, hard-link claims, identity-checked unlink, create-if-absent publication,
and all-file rollback preflight. It preserves comments/encodings/idempotence and
never rename-overwrites or unchecked-deletes a detected third-party race.

Receipt, config, and agent planning uses stable stat-before/read/stat-after
sampling and records device/inode with exact bytes (or expected absence). Every
later preflight and claim requires both. A same-byte inode replacement after
derivation is never adopted or unlinked and fails before public writes.

## Opt-in Excel lifecycle

The direct installer and default managed install are Excel-neutral: they add no
MCP entry and start no Python process. Explicit enable requires an existing
canonical absolute dedicated root:

```text
alg install ... --enable-capability excel --excel-root <absolute-directory>
alg update ... --enable-capability excel --excel-root <absolute-directory>
alg update ... --disable-capability excel
```

An update without capability flags preserves the active generation's state and
root. `--excel-root` without `--enable-capability` is accepted only while
preserving an already-enabled pack, where it explicitly changes that root.
Enable/disable are mutually exclusive and invalid for doctor, rollback, or
uninstall. Rollback restores only the target generation's stored state and
never enables a target where capability metadata is absent/disabled. Uninstall
removes only an exact receipt-managed entry.

Enable validates `capabilities/excel/manifest.json`, every listed hash, exact
sorted 25-tool inventory, Python `>=3.10,<4`, distribution
`excel-mcp-server==0.1.8`, upstream release commit, and wheel hash. It requires
`uv`, runs argument-vector `uv sync --frozen --no-dev` in a fresh
`<generation>/<lock-digest>/<activation-uuid>` external environment, records its
bounded byte/path/link identity, then invokes the exact interpreter and target wrapper
with `--check`. No unpinned `uvx` is used. Sync/check failure may leave an
unregistered environment or promoted release, but publishes no MCP config or
receipt. Environments/releases are not automatically cleaned up.

The managed entry is local stdio, enabled, bounded-timeout, and contains no
secret. Remote transports are disabled/not used. Mutation targets only
`mcp.alg_excel`; comments, BOM/UTF-16, trailing commas, unrelated MCP entries,
and plugin tuples remain. A custom/malformed entry blocks enable/update.
Disable, rollback-to-disabled, and uninstall preserve custom drift with an
explicit issue rather than claiming removal.

Doctor never launches a long-running MCP. Enabled state checks config,
manifest, lock, wrapper, environment/interpreter, root, upstream version, tool
count, and bounded wrapper `--check`. Disabled state reports without starting
Python. Missing, custom, and drift states are distinct and bounded/redacted.

The rooted `.xlsx` policy is path-argument confinement, **not an OS sandbox**;
the process retains ambient permissions. Stage source workbooks with
`workbook.py stage`, operate only on relative in-root copies, and run the
read-only `workbook.py validate` afterward. openpyxl does not calculate
formulas, the validator never claims recalculation/freshness, and optional
LibreOffice recalculation is out of scope for v0.2.

## Resolution and staging

Only exact stable `vMAJOR.MINOR.PATCH` tags are accepted. A local source must be
an existing clean Git worktree, including no untracked files, with `HEAD` at the
exact tag. Remote work is cloned into `.staging`; dependency installation never
runs in the registered or active package root. Package version, tag, and both
package-lock root versions must agree. Stable update requires the target commit
to descend from the active commit and its version to increase.

The manager runs child processes with an executable plus argument vector, not a
shell command string. It uses:

```text
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

and verifies that the lockfile did not change. Bun dependency installation is
not enabled in v0.2 because no tested no-lifecycle-script frozen mode is relied
on. Required exports, OpenCode entry points, runtime source manifest, bundled
agents, strict capability assets, and lock hash are checked before config writes.
After staged npm installation, the manager also computes a bounded deterministic
identity of the complete production `node_modules`: sorted relative paths,
regular-file bytes/sizes/modes, directories, and contained symlink targets
(including `.bin`) are framed into SHA-256 with file/byte counts. Unsupported
types, ambiguous paths, oversized files/trees, and junction/reparse/symlink
escapes fail closed. The receipt binds that identity separately from the lock
digest. This detects drift for a retained installation; it is not promised to be
reproducible across operating systems/filesystems and does not authenticate npm
registry responses or package authors. Promotion exclusively creates the final
generation directory as an identity-recorded reservation and exclusively creates
its `package` child. A bounded snapshot of the same-filesystem staging tree is
materialized with exclusive directories, create-if-absent hard links for regular
files, and only safe contained symlinks; modes and every created identity are
recorded. Unsupported types, junction/reparse/escape, occupied destinations, and
count/depth/file/aggregate bound violations fail closed. Git revalidation disables
optional index locking so it does not replace a hard-linked index. Staging is
removed only after whole-tree and immediate per-entry identity checks. Failure
removes unchanged manager-created entries bottom-up; foreign additions or
replacements preserve the reservation. Neither final path is a rename
destination.
Reusing an existing generation additionally requires its normalized `origin` to
equal the staged/trusted remote.

## Transaction and recovery boundaries

The manager preflights both JSONC files and all agent actions, takes exact
backups, records a bounded external journal, compares preflight bytes again
before every claim. Each changed live file has transaction-exact same-directory
claim/prepared paths and recorded before/claim/prepared identities. Expected old
bytes are hard-linked create-if-absent to the claim, repeatedly identity-checked,
then the public name is unlinked and complete prepared bytes are hard-linked only
to an absent destination. Intended deletion retains its old claim through receipt
publication. Config tuple options, comments, trailing commas, unrelated fields,
UTF-8 BOM, and BOM-marked UTF-16 are preserved. The receipt commits last.
Ordinary process failures roll earlier live files back when their bytes still
match the transaction's planned output.

Receipt publication is compare-and-swap against the raw receipt bytes (or
absence) from which the planned after-receipt was derived—not a newly sampled
baseline. The manager checks that derivation hash before journal creation,
before each live write after test hooks, after all live writes, after the
live-written journal phase, and immediately before receipt replacement. It also
requires every journal file to have its exact after-hash after all write hooks
return. A valid but differently formatted or otherwise concurrently replaced
receipt therefore cannot be overwritten. Concurrent third-state config/agent
bytes prevent receipt commit and make rollback preflight fail closed without
partially restoring other files.

Before any live write, an exclusively created identity-recorded private directory
probes the hard-link create-if-absent primitive without touching public or
foreign names; cleanup verifies every child and directory identity. The prepared after-receipt and old-receipt claim are
derived exactly from the transaction ID and named in the journal with file
identities. The old receipt is hard-linked create-if-absent to its claim; a
`receipt-linked` journal phase persists that identity, then repeated identity/hash
checks precede unlinking the public old name. No rename can replace an occupied
claim. The prepared receipt is hard-linked only while the public path is absent. An ordinary
post-claim failure restores a verified old claim only with create-if-absent. If a
third party has created the path, or the claim does not match the expected hash,
all third-party bytes and the claim/journal are retained for explicit inspection.
`doctor --ack-restart` is implemented as the same journaled receipt-only
transaction, so claim/publish crashes use the same deterministic recovery.
Journal recovery accepts agent paths only when their exact key is one of the five
bundled names and the path is its canonical direct child. Receipt auxiliary paths
must be the exact backup/claim/prepared names for that journal transaction; prefix
matches, other transaction IDs, symlinks, and identity mismatches fail before any
recovery write or deletion.

Config/agent rollback and journal repair use those claims and prepared identities,
not rename-overwrite, unchecked deletion, or audit backups. A third-party public,
claim, or prepared state remains untouched with the journal. Portable filesystems
do not offer atomic compare-device/inode/hash-and-unlink, so an arbitrary writer
can still race in the final instruction window after the manager's strongest
immediate pre-unlink checks. The protocol does not claim writer isolation; its
create-if-absent publication never overwrites a destination observed occupied.

This is coordinated per-file publication, **not cross-file atomicity** and not
a power-loss guarantee. `doctor` is read-only by default and reports a pending
journal deterministically. `doctor --repair-journal` removes a committed stale
journal only when the receipt matches its intended after-hash and every listed
live file matches its intended after-hash. For receipt-before recovery, every
journal file is first classified as exact before/after/third state and every
claim/prepared identity/path/CAS precondition is validated without writes. Any third
state or missing/corrupt transaction auxiliary therefore leaves all live files and the journal
unchanged. Only after complete preflight are after-state files restored. A
mid-restore ordinary failure can leave a mixture of exact before/after states;
the journal remains and a later repair safely retries. Ambiguous or externally
changed state fails closed for manual inspection.

Journal publication is append-only. The base and every numbered phase/identity
revision are immutable create-only hard-link data/anchor pairs, and each revision
binds the previous bytes by SHA-256. Reads require contiguous revisions, exact
immutable fields, equal pair bytes, and device/inode identity. Cleanup rechecks
those exact identities and never unconditionally removes a journal or marker.
Same-byte replacement, occupied/incomplete markers, and cleanup races preserve
evidence. Receipt-after classification additionally requires the recorded
prepared-receipt identity before acceptance, restoration, or cleanup.

Doctor also checks strict receipt/path identity, active commit/runtime/lock and
dependency identity, exactly one server and TUI registration, agent status,
previous rollback availability, and restart-pending state. The manager never
detects that OpenCode restarted. After actually quitting and restarting, the
user may attest that fact with `doctor --ack-restart`.

## v0.1.0 to v0.2.0

Run managed `install --source <clean-v0.2-checkout>` against the existing config.
Exact direct-installer package-root or entry-file registrations are replaced in
one transaction while tuple options are retained. An exact prior bundled agent
can be adopted; customized agents remain untouched. The old source checkout is
not mutated and the new generation is installed side-by-side. Current ALG run
schema 2 remains compatible with v0.1.0; rollback still validates both retained
generation declarations before switching registrations.

Before a rollback prepares capability/config/agent changes, the retained target
must still be a canonical, completely clean Git checkout with the receipt's
trusted `origin`, exact HEAD/tag/commit, package and package-lock identity,
same-install production dependency identity, runtime-source digest, agents, durable-state
declaration, and strict capability hashes. These checks do not make the manager
a package-signature or remote-authenticity system; they bind rollback to the
locally retained receipt and trusted-remote policy.

`mcp.alg_excel` ownership comes only from the active receipt's exact managed
configuration. An exact-looking pre-existing entry with no such receipt
ownership remains custom: enable/update/rollback cannot adopt or replace it,
uninstall preserves it, and doctor reports it. There is no implicit adoption
flag. Receipt agent keys are restricted to the exact bundled direct filenames;
nested, absolute, encoded, separator-bearing, unknown, or case-ambiguous names
fail before any agent path is read or removed.

Quit and restart OpenCode after every successful install, update, rollback, or
uninstall. Do not use `--ack-restart` as detection; it is only user attestation.

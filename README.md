# opencode-alg

**Agents + Loops + Graphs** for OpenCode stable runtimes satisfying the declared `engines.opencode` range (`>=1.18.0`): a typed DAG executor with durable project state, bounded attempts and payloads, fresh-child checking, model snapshots, and audited run ownership.

**Architecture:** [read the design and implementation guide](DESIGN.md).

The SDK/plugin dependency used to compile this package is pinned at `1.18.3`; that dependency pin is not the runtime compatibility floor. Live verification accepts stable OpenCode versions satisfying the declared engine range and is currently exercised with `1.18.18`.

## Tools

| Tool | Purpose |
|---|---|
| `alg_templates` | List built-in graph templates |
| `alg_models` | View, set, or clear strict project model + effort snapshot sources |
| `alg_criteria` | Update/lock criteria on an already planned run; normally pass criteria to `alg_plan` |
| `alg_plan` | Validate and persist a DAG without executing it; compact by default |
| `alg_run` | Synchronously execute ready-set waves under an exclusive run lease |
| `alg_status` | Compactly inspect an owned run or list runs owned by this session |
| `alg_resume` | Synchronously resume an incomplete owned run without resetting attempts |
| `alg_artifact` | Return bounded artifact metadata/preview, or explicit full content |
| `alg_transfer` | Auditably transfer a run to another OpenCode session |
| `alg_skill_evolution_status` | Inspect opt-in skill-evolution configuration, recovery, ledger, and candidates |
| `alg_skill_evolution_audit` | Idempotently enqueue a manual audit of an eligible completed assistant message |
| `alg_skill_evolution_review` | Explicitly reject or restore a candidate without bypassing checker provenance |
| `alg_skill_evolution_promote` | Explicitly publish one validated skill candidate after confirmation |
| `alg_skill_evolution_rollback` | Explicitly restore a promoted replacement from its verified backup |

These are the exact 14 public server tool IDs, in registration order. The five
`alg_skill_evolution_*` tools are always registered so configuration and status
remain inspectable, but skill evolution is disabled by default and its audit or
mutation operations fail closed until explicitly enabled.

State is project-local:

```text
.opencode/runs/<run_id>/
  criteria.md
  graph.json
  progress.json            # authoritative bounded/projected run state (<5 MiB)
  progress.json.bak        # most recent write backup
  artifacts/<node>.json    # latest-node compatibility mirror
  artifacts/<node>-attempt-<n>.json                 # compatibility mirror
  artifacts/<node>-output-<sha256>.json             # immutable referenced output
  artifacts/<node>-attempt-<n>-output-<sha256>.json # immutable referenced output
  checks/<checker>-attempt-<n>.json
  history/<node>-attempt-<n>-detail-<sha256>.json
  history/<node>-attempts-<sha256>.json
  history/<node>-failures-<sha256>.json
  history/filesystem-root-authorizations-<sha256>.json
  sessions/<node>-a<n>.json
.opencode/runs/_owners/<sha256-session-id>.json  # bounded derived TUI projection
```

`progress.json` remains the authoritative run state and is validated against a 5 MiB store ceiling with 256 KiB write headroom. Complete typed outputs and full attempt/failure details use run-contained, full-SHA-256 content-addressed sidecars. A save derives the projection, exclusively publishes and integrity-checks every new immutable object, prepares fixed convenience mirrors, then replaces `progress.json`; garbage-collection evaluation runs only afterward. A process-observed failure before that replacement leaves current progress and every sidecar reachable from it byte-identical. Progress publication stages the prior current separately, replaces authoritative current first, and only then rotates that staged prior current into `progress.json.bak`: failure of the current rename preserves both prior files exactly, while post-commit backup maintenance failure preserves the new current and prior backup and is not misreported as a failed commit. Post-commit GC is also non-authoritative: containment, directory-read, realpath, permission, or candidate-evaluation errors retain files and cannot turn an already committed save into a reported failure. The rolling backup remains a supported recovery manifest, so bounded GC recursively proves reachability from both current and backup progress and leaves unknown files alone. The current implementation conservatively defers physical deletion because there is no durable ownership ledger that can distinguish an orphaned ALG-shaped name from a user-created file; reachability failure also defers GC. Fixed graph/criteria/current-artifact/check/history files are non-authoritative mirrors; partial mirror writes are repaired from progress on a later load, and paths still reachable from a legacy current/backup manifest are never reused as mirrors.

Mutable caller `RunState` is a plugin-produced plain-data contract. Persistence first traverses ordinary objects/arrays through own data-property descriptors, never getters, and rejects accessors, custom prototypes, cycles, enumerable symbol data, and cross-path reuse of independently synchronized run/node/attempt identities. Sharing below those mutable synchronization roots, such as one output value referenced by its node and latest attempt, is deliberately treated as read-only input. After the descriptor snapshot, Node-compatible `node:util` `types.isProxy` explicitly rejects every captured Proxy; descriptor post-validation detects stateful trap mutation. `structuredClone` runs only on the materialized plain snapshot to prove cloneability and provide detached data isolation—it is not the Proxy detector. All of this occurs before candidate preparation, locks, or writes. Copyback precomputes and invariant-checks every delete/set/define operation immediately before authoritative replacement, including caller attempt identities that become archived. Writable non-configurable canonical data may receive its exact assignment; non-writable canonical data must already be exact. Configurable extras are removed, non-configurable extras/accessors/incompatible fixed values fail precommit, and ordinary supported state performs no inspection or caller callback after the commit boundary.

Persisted immutable failure, attempt-detail, attempt-history, output, and root-authorization strings are parsed without trimming: canonical values load unchanged, while padded failure text, paths, IDs, sessions, operations, and timestamps fail rather than being normalized after their hash check. Full attempt-detail documents reject every projection-only reference, commitment, and omission field. Archived attempt references carry exact passed/schema-invalid/SDK-error/gate-failure/substantive-rejection/incomplete/legacy-unknown and feedback-route counts. Compact routing summaries combine those counts with the visible tail exactly once; legacy archive references without counts remain readable but explicitly report unknown archived outcomes/routes.

Progress stores integrity-bound paths, SHA-256 hashes, logical/immutable byte sizes, exact history counts, and truthful omission/truncation metadata. Every newly projected attempt and node failure list also carries a separate canonical complete-list SHA-256/count commitment, so repointing a valid same-node detail/failure reference to same-prefix/count but different omitted content fails precisely. Legacy projections without commitments remain readable, are reported as weaker compatibility verification in run/status responses, and gain commitments on their next save. Existing immutable objects are reused only after size/hash verification; a mismatch fails closed rather than overwriting the path. Older inline schema-v2 outputs and legacy fixed-path references still load. Before every successful later save—including transfer-only saves—ALG verifies and recursively materializes every retained legacy reference tree, publishes immutable output/detail children before immutable attempt/authorization archives, and only then advances progress. Fixed objects needed by current or backup recovery remain untouched, and both old and new manifests continue to hydrate. Missing, altered, projection-inconsistent, wrong-kind, cross-owner/run/node, or escaping referenced sidecars fail safely and visibly without quarantining otherwise structurally valid progress. These publication steps use fsynced temporary files plus same-directory link/rename operations, but they do not claim filesystem or power-loss guarantees beyond the host filesystem's implementation. The owner projection is a separate non-authoritative, atomically replaced index capped at 64 entries and 32 KiB per parent session; run create/save/transfer refreshes it under an owner-specific mutex. If an older project has no owner projection, `/alg-runs` emits a warning and performs a bounded fallback through server-limited public file searches that favor today/yesterday's timestamped run IDs, validate exact progress paths, and read at most 64 progress files.

**Integrity threat model:** SHA-256 references and independent counts provide content-integrity, collision/staleness/partial-write detection, and fail-closed hydration under accidental corruption or uncoordinated mutation. They do not provide authenticity against a principal able to coherently rewrite authoritative `progress.json` manifests, every referenced object, and all hashes/counts. Authenticity against that adversary would require an external trusted signing key or append-only ledger; that is out of scope. ALG therefore makes no tamper-proof or cryptographic-authenticity claim.

Each live node attempt gets a fresh OpenCode child session. ALG does not explicitly forward worker transcripts to a checker: its prompt payload contains bounded criteria plus bounded claimed output. This is history separation, not a sandbox—OpenCode SDK behavior, configured project/system instructions, tools, and filesystem context still apply. Full child transcripts remain in OpenCode's database.

## Install

### Versioned manager (protocol v0.2.0)

The opt-in manager resolves exact stable Git tags into immutable side-by-side
generations, keeps its strict receipt outside every release, and transactionally
switches both server and TUI registrations. Package v0.3.0 deliberately retains
manager/receipt protocol version `0.2.0`:

```powershell
# Fresh install, or use the update line instead from an older managed generation.
.\scripts\alg.ps1 install --source C:\reviewed\opencode-alg --tag v0.3.0
.\scripts\alg.ps1 update --tag v0.3.0
.\scripts\alg.ps1 doctor
.\scripts\alg.ps1 rollback
```

```sh
# Fresh install, or use the update line instead from an older managed generation.
./scripts/alg.sh install --source /reviewed/opencode-alg --tag v0.3.0
./scripts/alg.sh update --tag v0.3.0
./scripts/alg.sh doctor
./scripts/alg.sh rollback
```

The default roots are `<config>/.opencode-alg/` for receipt/lock/journals and
`<config>/plugins/opencode-alg/releases/<version>-<commit12>/package` for packages.
The generation directory and its `package` child are reserved by exclusive
`mkdir`. A bounded snapshot of same-filesystem staging is materialized below
`package` with exclusive directories, create-if-absent hard links for regular
files, and only contained safe symlinks. Modes and every created identity are
recorded. Validation runs with optional Git index locking disabled; staging is
removed only after a complete identity-bound tree preflight. Failure removes
only unchanged manager-created entries bottom-up. Foreign additions or
replacements preserve the reservation and fail closed. An occupied reservation
is validated for exact reuse or preserved and rejected, never rename-replaced.
Configs point directly at a retained package root; there is no mutable current
pointer and no automatic release deletion. Update never pulls, resets, or
installs dependencies in the active package. Receipts bind a bounded same-install
production `node_modules` byte/path/mode/link identity in addition to the lock
digest; reuse, doctor, rollback, and activation reject drift or link escape. This
is not a cross-machine digest or npm-registry authenticity claim. See [the upgrade and recovery
guide](docs/upgrades.md) for all flags, agent policy, rollback compatibility,
doctor, dry-run, and transaction boundaries.

Transactions bind receipt publication to the exact raw receipt bytes (or
absence) used during planning. Every changed config/agent is first prepared in
its own directory; expected old bytes are exclusively hard-linked to an exact
transaction claim, identity-checked, and only then unlinked before prepared bytes
are hard-linked create-if-absent. Deletes retain the old claim through receipt
finalization. Occupied public/claim paths and third states are never overwritten
or manager-deleted, and recovery uses the same identity-bound protocol. Before
live writes the manager probes the required same-directory hard-link primitive
inside an exclusive private directory. Receipt publication journals a verified claim of the
old receipt by exclusively hard-linking it to a transaction-exact claim path,
records its file identity in a `receipt-linked` phase, rechecks bytes/identity,
and only then removes the public old name. It links a prepared receipt only into
an absent path; occupied, ambiguous, or third-party state is preserved for repair
rather than overwritten or deleted. Backup/claim/prepared paths derive exactly
from the journal transaction ID. Restart acknowledgement uses the same
receipt-only journal. Receipt and journal agent keys/paths are limited to the five bundled direct
filenames. An exact-looking `mcp.alg_excel` entry is not adopted unless the
active receipt already owns that exact managed configuration.

Manager journals are immutable create-only data/anchor hard-link pairs. Every
phase or learned claim identity appends a numbered revision bound to the prior
revision hash; updates never rename-overwrite the base. Reads and cleanup require
exact paired bytes plus recorded device/inode identity. Primitive probes run only
inside exclusive identity-recorded private directories. Receipt-after state also
requires the prepared receipt identity, not merely equal bytes.

No portable filesystem API atomically compares device/inode/hash and unlinks a
name. The manager performs the strongest repeated checks available immediately
before unlink, but cannot eliminate a final instruction-window race from an
arbitrary non-cooperating writer. Create-if-absent publication itself never
overwrites an occupied name; detected ambiguity preserves bytes and the journal.

### Opt-in Excel capability pack

Excel is **off by default**. The direct installer is Excel-neutral, and managed
install/update creates no Excel process or `mcp.alg_excel` entry unless the user
explicitly enables the pack (or an update preserves an already enabled receipt):

```powershell
.\scripts\alg.ps1 install --source C:\reviewed\opencode-alg --tag v0.3.0 `
  --enable-capability excel --excel-root C:\work\alg-excel-staged
.\scripts\alg.ps1 update
.\scripts\alg.ps1 update --disable-capability excel
```

```sh
./scripts/alg.sh install --source /reviewed/opencode-alg --tag v0.3.0 \
  --enable-capability excel --excel-root /work/alg-excel-staged
./scripts/alg.sh update
./scripts/alg.sh update --disable-capability excel
```

The pack pins `excel-mcp-server==0.1.8` (upstream release commit
`f51340ecd5778952405044b203d3a2d4c8a46833`) in a complete `uv.lock`. Enable
uses argument-vector `uv sync --frozen --no-dev` in a lock-digest-keyed
environment below the managed install root, runs the wrapper's bounded
`--check`, then transactionally owns only `mcp.alg_excel`. It never uses
unpinned `uvx`; remote MCP transports are disabled and not exposed.

The wrapper accepts only relative, in-root, case-insensitive `.xlsx` workbook
arguments and rejects absolute/traversal/NUL/alternate-stream/non-workbook and
symlink/junction/reparse escapes. This is **MCP workbook path-argument
confinement, not an OS sandbox**: the subprocess retains the ambient permissions
of the OpenCode process. Work on staged copies, never originals:

```sh
python capabilities/excel/workbook.py stage \
  --root /work/alg-excel-staged --source /incoming/source.xlsx \
  --destination jobs/source-copy.xlsx
python capabilities/excel/workbook.py validate \
  --root /work/alg-excel-staged --workbook jobs/source-copy.xlsx
```

`stage` never modifies/deletes its source and requires `--overwrite` before
replacing an existing destination. `validate` is read-only and bounded; it
checks ZIP/OpenXML structure, sheets/dimensions, formulas, obvious dangerous or
external functions, and detectable external relationships. openpyxl stores but
does not calculate formulas, so validation reports calculation freshness as
unverified and never says formulas were recalculated. LibreOffice recalculation
is out of scope for Excel capability pack v0.2.

Use the deterministic validator as the optional shell gate for the built-in
spreadsheet workflow:

```text
alg_plan template="spreadsheet-diamond" goal="Update the staged workbook" \
  shell_gate="python capabilities/excel/workbook.py validate --root /work/alg-excel-staged --workbook jobs/source-copy.xlsx"
```

The template uses only researcher/implementer/checker roles, directs agents to
relative staged `.xlsx` copies through `alg_excel`, and finishes with a fresh
checker. Quit and restart OpenCode after enable, preserved update, disable,
rollback, or uninstall.

### Compatible direct installer

Put the whole package at any stable location (commonly `~/.config/opencode/plugins/alg`), then run one launcher from the package root:

```powershell
.\scripts\install.ps1
# alternate config root and explicit bundled-agent update:
.\scripts\install.ps1 -ConfigDir D:\sandbox\opencode -UpdateAgents
```

```sh
./scripts/install.sh
# alternate config root and explicit bundled-agent update:
./scripts/install.sh /tmp/opencode --update-agents
```

The launchers install dependencies only from a present lock: Bun uses `install --frozen-lockfile --ignore-scripts`, while npm uses `ci --ignore-scripts --no-audit --no-fund`; lock mismatch fails and lifecycle scripts never run. They then invoke the same TypeScript installer core. The core registers the **package-root URL** in both `opencode.jsonc` and `tui.json`; OpenCode resolves `./server` and `./tui` from `package.json` separately. Config and agent changes share a full-preflight, prepared-file, hard-link-claim transaction. Planning captures stable bytes plus device/inode (or absence); same-byte replacement before commit is third state and causes zero writes. Existing public names are identity-checked immediately before unlink, publication is create-if-absent, and rollback first validates every public/claim/prepared state. A non-cooperating racer is preserved and causes failure rather than rename-overwrite or unchecked deletion. The direct path remains non-journaled and therefore crash-limited. The TUI module defaults to `{ id, tui }` and the server module defaults to `{ id, server }`—they are never combined.

Manual registration uses the same package-root spec in each file:

```jsonc
// ~/.config/opencode/opencode.jsonc
{ "plugin": ["file:///absolute/path/to/plugins/alg"] }
```

```jsonc
// ~/.config/opencode/tui.json
{ "plugin": ["file:///absolute/path/to/plugins/alg"] }
```

On Windows use `file:///C:/...`, with forward slashes. The installer does **not** add permission grants to `opencode.jsonc`, set `default_agent`, providers, or arbitrary inline agent settings. It does copy missing bundled agent files; those files intentionally contain role-specific permissions, including `bash`/`edit` for orchestrator and implementer. Customized files are skipped unless `-UpdateAgents` / `--update-agents` (or the force alias) is explicit.

**Quit and restart OpenCode after every install, update, uninstall, agent/config edit, or global model save.** Config and plugin modules are loaded at startup.

## Opt-in skill evolution (v0.3.0)

Skill evolution is a project-local candidate workflow, not automatic
self-modification. A plain string plugin registration keeps it disabled. Enable
it only in the **server** `opencode.jsonc` registration by changing that entry to
a plugin tuple; the TUI registration can remain the package-root string:

```jsonc
{
  "plugin": [
    [
      "file:///absolute/path/to/plugins/alg",
      {
        "skillEvolution": {
          "enabled": true,
          "mode": "triggered",
          "skillRoots": [".opencode/skills"],
          "minimumTriggerScore": 3,
          "maxEvidenceBytes": 16384,
          "maxBacklog": 32,
          "maxAttempts": 2
        }
      }
    ]
  ]
}
```

The options object is strict; unknown fields fail plugin startup rather than
being ignored. Defaults and accepted bounds are:

| Option | Default | Accepted value |
|---|---:|---|
| `enabled` | `false` | boolean; the only activation switch |
| `mode` | `"triggered"` | `"triggered"` or `"every-turn"` |
| `skillRoots` | `[".opencode/skills"]` | 1–8 unique normalized project-relative roots, never the evolution store |
| `auditorAgent` | `"researcher"` | fixed to `"researcher"` in v0.3.0 |
| `checkerAgent` | `"checker"` | fixed to `"checker"` in v0.3.0 |
| `maxEvidenceBytes` | `16384` | 2,048–32,768 bytes |
| `maxCandidateContentBytes` | `65536` | 1,024–65,536 bytes |
| `maxCandidates` | `100` | 1–500 |
| `maxLedgerRecords` | `1024` | 16–4,096; capacity exhaustion fails rather than discarding dedupe records |
| `maxBacklog` | `32` | 1–128; overflow is persisted as a failed record |
| `queueConcurrency` | `1` | fixed to `1` in v0.3.0 |
| `minimumTriggerScore` | `3` | 1–10, used only by automatic `triggered` intake |
| `maxAttempts` | `2` | 1–3 total audit attempts, including interrupted startup recovery and forced retry |

Quit and restart OpenCode after changing the tuple. The manager/direct installer
preserves an existing ALG tuple while replacing its package-root spec; neither
installer enables this option on the user's behalf.

### Candidate workflow

When enabled, ALG listens only for a successful, non-summary, completed
assistant `message.updated` event. It durably deduplicates the exact
session/message pair, builds bounded redacted evidence from that assistant and
its direct parent user message, and serializes a per-project queue. In
`triggered` mode, evidence below `minimumTriggerScore` becomes `no-change`
without a model call. `every-turn` audits every eligible completion. Private
auditor/checker children are durably registered and recursion-excluded.

An eligible audit creates a fresh no-tools `researcher` child. `no_change` ends
the record; a memory proposal is retained as a non-promotable candidate; a skill
create/revision proposal receives a second fresh no-tools `checker` child. Only
a strict passing checker verdict produces `validated`. Model output is still
nondeterministic, and prompt/tool restrictions are guardrails rather than an OS
sandbox.

Typical explicit workflow:

```text
# queue the latest eligible completion in this session (or provide both IDs)
alg_skill_evolution_audit
alg_skill_evolution_audit session_id="..." assistant_message_id="..."

# inspect a bounded list, then one candidate with all immutable revisions
alg_skill_evolution_status state="validated" limit=20
alg_skill_evolution_status candidate_id="se-..." detail="full"

# optional human disposition; restore preserves the original checker result
alg_skill_evolution_review candidate_id="se-..." action="reject" reason="..."
alg_skill_evolution_review candidate_id="se-..." action="restore" reason="..."

# explicit publication; true is accepted, but the token is easier to audit
alg_skill_evolution_promote candidate_id="se-..." confirm="PROMOTE:se-..."

# replacement candidates only, and only while the public file still has the promoted hash
alg_skill_evolution_rollback candidate_id="se-..." confirm="ROLLBACK:se-..."
```

Promotion is never automatic. It accepts only a validated skill, rechecks strict
`SKILL.md` frontmatter/content, project-root containment, configured roots,
create absence or replace basis, and immutable checker provenance. Created
skills are never deleted by rollback; v0.3.0 rollback restores only an exact
pre-promotion replacement backup. Memory candidates cannot be promoted.
Promotion, rollback, or startup/status recovery that mutates a skill file sets
`restart_required`; quit and restart OpenCode before expecting new sessions to
load the resulting skill.

### Cost, privacy, and durability limits

- Disabled mode performs no event intake and no auditor/checker model calls.
  Status, review, promote, and rollback themselves make no model calls.
- A qualifying/forced/every-turn audit costs one auditor call; a skill proposal
  costs one additional checker call. Manual audit bypasses the trigger threshold,
  and `force=true` can retry only an existing failed/no-change identity within
  `maxAttempts`. Duplicate events do not normally call a model again, but a crash
  during a running audit may cause one bounded recovery attempt, so model calls
  are not an exactly-once external effect.
- Evidence is bounded, path/credential/obvious-secret redacted, and treats quoted
  content as untrusted data, but this is not a complete DLP or confidentiality
  guarantee. Do not feed secrets into conversations expecting redaction to make
  them safe.
- Project state lives under `.opencode/skill-evolution/`: bounded ledger and
  candidate indexes plus immutable evidence, revision, backup, and transaction
  objects. Local hashes/identities detect drift and partial or stale state; they
  do not authenticate against a principal able to rewrite the project coherently.
- Each runtime's project queue is single-concurrency and bounded; the durable
  begin transition prevents duplicate processing of the same key across runtime
  instances, but distinct records can run in separate OpenCode server processes.
  Audit failures are retained rather than silently retried in a loop. Unresolved transaction or
  third-state/custom drift is preserved and reported by
  `alg_skill_evolution_status`; do not delete its journal or auxiliary files
  until the conflict is understood.

## `/alg-models` TUI workflow

Open the command palette under **ALG → Choose agent models**, or enter `/alg-models`:

1. Choose exactly `explorer`, `researcher`, `implementer`, or `checker`.
2. Review the current global model and effort.
3. Search models exposed by the connected/configured `api.state.provider` catalog. Deprecated models are omitted.
4. Pick a model or **Inherit OpenCode default**. Inherit removes both global role fields.
5. If that runtime model has variants, search a second picker containing **Default model effort** plus only that model's sorted, non-disabled `variants` keys. Models without variants save default effort immediately.

Effort is OpenCode's public `variant` field, not a provider-independent low/medium/high enum. Variant IDs are model-specific exact catalog keys. Selecting an explicit effort uses the official global config PATCH API represented by the package's pinned `1.18.3` SDK/plugin dependency to write `agent.<role>.model` and `agent.<role>.variant` together; model-default effort also uses a model-only PATCH when no role variant currently exists. Because that API deep-merges and cannot delete an optional property, **Default model effort** with an existing variant instead sets the selected model and deletes `variant` in one local JSONC transaction; **Inherit** locally deletes both fields in one transaction. Local edits require the API read's actual response URL to be loopback and exactly one local config source whose role fields exactly match that read. Zero, ambiguous, split, mismatched, URL-less, or non-loopback sources fail closed with server-side editing instructions. Successful edits preserve comments, encoding/BOM, unrelated config, and exact adjacent backups.

## `/alg-runs` child-session workflow

Schema-v1 fixed attempt archives may retain store-compatible fixed nested references at `artifacts/<node>-attempt-<n>.json` and `history/<node>-attempt-<n>.json`. `/alg-runs` accepts those references only under their exact project-relative run/node/attempt/kind paths. It reads the archive only after node selection and reads nested detail/output only after attempt selection through the public SDK file API. Fixed JSON receives finite store-equivalent formatted-read bounds, canonical logical-size checks, strict detail identity/projection checks, and strict agent-output validation. Fixed names do not bind a digest, so the TUI makes no SHA-integrity claim and emits one bounded, invocation-deduplicated weaker-legacy warning. Full-SHA nested references continue to require exact kind/path identity, canonical bytes, raw byte size, and raw/canonical SHA validation.

Graph definitions are parsed before navigation, and graph IDs/agents must match node-state keys/IDs/agents exactly. Every visible and archived attempt row passes the same strict persisted-attempt parser; compatible legacy rows use explicit optional-field compatibility, never a no-output fallback.

Open **ALG → Browse child run sessions** or enter `/alg-runs` from a parent session. The TUI uses OpenCode's public project-relative file APIs, so attached and server-backed TUIs do not assume direct access to the server's disk. Normal discovery directly reads the current parent's bounded owner projection, validates ownership again from each selected `progress.json`, sorts by the authoritative `updated_at` instant, and lists at most the 20 most recent runs. Compact discovery does not read attempt archives until a node is selected. Node rows report total, archived, and inline-visible attempts separately. Selecting an archived node performs one bounded project-relative sidecar read and validates each record through the shared authoritative persisted-attempt parser before deterministically merging archive plus tail without duplicates. Immutable schema-v2 archives receive exact full-SHA path, raw-byte size/hash, owner/run/node/kind/schema/count, and nested-reference checks. Legacy fixed archives—including genuine schema-v1 documents without `kind` or `owner_session_id`—receive exact contained run/node path, bounded read, strict schema and contained run/node identity, canonical logical-size/count, nested-reference checks, and an explicit weaker-integrity warning; their path has no SHA binding. Attempts are exposed in pages of at most 32 plus bounded previous/next controls, so every valid archived child session remains reachable without one oversized dialog. Before route navigation, a selected reference-only attempt output is read on demand through the same public API, bounded and cached for that command invocation, and checked for immutable path/hash/size, strict agent schema, score, outcome, and run/node/attempt identity. Progress/archive/output reads, node/attempt arrays, dialog option counts, and every rendered title/description/ID preview are independently bounded; one bounded warning reports discovery truncation counts. A child session display ID is only a preview. Navigation uses a separately retained exact, untruncated ID and is disabled unless that ID satisfies the SDK/session bound. Missing, corrupt, schema-invalid, or mismatched archives/outputs and unavailable session IDs produce bounded visible toasts without navigation.

ALG continues to create isolated SDK child sessions; `/alg-runs` is only a navigator and does not replace those sessions with parent task cards or copy their reasoning into the parent transcript.

Project-scoped selections can be managed directly (use the returned `revision` for optional compare-and-swap):

```text
# complete selection; omit variant for model-default effort
alg_models agent="implementer" provider_id="openai" model_id="gpt-5" variant="high"
# update only effort on that existing project role model
alg_models agent="implementer" variant="medium" revision=1
# preserve the project model but return it to model-default effort
alg_models agent="implementer" clear_variant=true revision=2
# remove the complete project role selection and inherit merged global/default config
alg_models agent="implementer" clear=true revision=3
```

`variant` and `clear_variant` require an existing project role model when used without `provider_id`/`model_id`. A complete model set replaces the complete project role selection, so omitting `variant` intentionally removes any prior project variant. At startup the server captures merged OpenCode config. Model/effort precedence frozen into each new run is:

1. complete project ALG role selection from `alg_models`;
2. merged OpenCode `agent.<role>.model` plus that role's `agent.<role>.variant`;
3. merged OpenCode top-level `model` as model-only fallback.

Every new run also persists `model_resolution` for `planner`, `explorer`, `researcher`, `implementer`, `checker`, `repair`, and `default`. Each entry reports effective provider/model/variant when known and one source: `alg-project-override`, `opencode-role-config`, `opencode-top-level-default`, `inherited-sdk-default`, or `legacy-unknown`. Repair is the implementer retry path and therefore reports the same immutable resolution. Unknown inherited SDK defaults remain unknown—ALG does not invent provider/model IDs. Old schema-v2 runs without provenance still load and are reported as `legacy-unknown`.

The role variant is captured only when that same role has an explicit valid role model; it never attaches to a top-level fallback. Project selection overrides the role selection as a unit. Provider/model values split at the first slash, so model IDs may themselves contain slashes. Each new run copies model and optional variant into its immutable `model_snapshot`; later project/global changes cannot rewrite an existing run, and every role attempt/retry uses its snapshot. Prompts send only `{ providerID, modelID }` under `body.model`, with effort separately as top-level `body.variant`; absent values are omitted. Clear the project choice before planning when inheritance is desired. **Quit and restart OpenCode after every global model/effort change**, whether API- or local-edit-backed, before relying on it.

## Typical use

```text
alg_plan goal="Add rate limiting" template="coding-diamond"
  criteria=[...] shell_gate="bun test"
alg_run run_id="..." max_waves=2
alg_status run_id="..."
```

For a no-model smoke path, use `alg_plan mode=dry` then `alg_run dry=true`.

`alg_plan`, `alg_run`, `alg_resume`, `alg_status`, and `alg_artifact` use `detail="compact"` by default. Full plan detail includes full goals/criteria/graph definitions plus the complete newly persisted run. Full run/resume/status detail recursively integrity-checks and hydrates every archived attempt, detail/output/failure reference, typed output, session, timing, verdict, outcome, score, shell/schema result, error, and feedback field in deterministic attempt order. It can therefore be much larger than `progress.json`; callers explicitly opt into that cost. `alg_status list=true detail="full"` fully hydrates every exactly-owned run and fails the request with the precise run ID if any one cannot be fully verified. `alg_artifact detail="full"` continues to return the complete current typed node output from integrity-checked storage. Compact run/resume/status reload one committed projected representation for every summary and `state_projection`; bounded reference verification may read complete sidecars internally, but archive/root entries are discarded rather than returned. Compact list mode returns at most 20 summaries plus total/shown/omitted metadata. Compact plans and run/status responses have a 64 KiB aggregate JSON budget: at most 24 node summaries, 32 total attempt summaries, 32 total session summaries, 24 call events, bounded UTF-8 text, and explicit omitted/truncated counts. Compact artifacts include metadata, available fields, byte size, artifact path, bounded failures, and a 2 KiB preview.

An `alg_run`/`alg_resume` invocation is synchronous and cannot live-stream token or node progress into its still-running parent call. Use `max_waves` to bound a call, then `alg_status`, `/alg-runs`, and `alg_resume` for post-wave visibility and continuation.

### Filesystem-root safety

Planning, running, and resuming at `/`, a Windows drive root such as `C:\`, or a UNC share root is rejected by default with a scoped-directory error. Intentional machine-wide audits must pass `allow_filesystem_root=true` on **each** mutating call. Every accepted root call is appended to `filesystem_root_authorizations` with operation, `authorized:true`, canonical path, actor session, and timestamp and is surfaced in plan/status/run output. Above 64 entries, progress retains a 64-entry tail plus an immutable owner-bound complete-history reference with exact total and plan/run/resume counts. Compact load verifies the bounded archive's containment, size/hash, kind/owner/run, ordered tail, total, and computed operation distribution, then discards archive entries; full detail restores every entry in order. Transfer-only saves rebind the archive to the new audited owner. Older runs with only `filesystem_root_authorizations_omitted` remain compatible and explicitly report the unknown legacy operation distribution rather than inventing counts. A plan approval never authorizes a later run, and a run approval never authorizes resume. Ordinary project directories require no opt-in.

Pass user criteria directly to `alg_plan`. `alg_criteria` never creates a staging run: it only edits an owned run while it is still `planning`. Locked criteria require `lock=false` to replace them and leave them unlocked; a later call with the default lock behavior can lock the replacement.

### Templates and attempt semantics

- `coding-diamond`: explore (up to 2) → research (up to 2) → implement (up to 5) → fresh-child checker (up to 5), with schema-valid substantive checker failures routed to its direct implementer dependency when both still have capacity; global cap 14.
- `research-diamond`: two explorers in parallel (up to 2 each) → research (up to 2) → fresh-child checker (up to 2), with schema-valid substantive feedback to its direct research dependency; global cap 8.
- `spreadsheet-diamond`: staged-copy research (up to 2) → `alg_excel` implementer plus caller-supplied deterministic validator shell gate (up to 4) → fresh-child checker (up to 4); formulas are explicitly not recalculated; global cap 10.

`loop.max_attempts` includes the first attempt; it is not “retries after first.” Every reserved node attempt increments `global_attempts`, including schema failures, shell denials/failures, checker rejections, and interrupted attempts. The local and graph-global caps are both hard. Each node receives at most one attempt per graph-ordered wave, so parallel completion speed cannot choose who receives a scarce retry. `alg_resume` preserves counters and history; an attempt left `running` by interruption becomes failed and is retryable only when unused capacity remains. Dry attempts also consume attempt counters but make no model calls.

Schema-invalid explorer/worker/researcher output consumes that node's own attempt and retries that same node while capacity remains. A checker contradiction or other schema-invalid checker result likewise consumes/retries the checker; it never reopens the worker. Only a schema-valid checker rejection with concrete failures enters the bounded repair-feedback route. Agent outputs have serialized aggregate byte caps (in addition to field/count bounds), graphs have an aggregate persistence budget, and every save externalizes complete outputs/details before validating the projected aggregate with headroom below the 5 MiB store ceiling. Resume safely hydrates referenced dependency/checker output and archived metadata; fresh in-memory execution retains complete values for routing. An implementer may report `done:false` only with explicit `blockers` and optional `artifact_path`; this is retained as structured failed-attempt evidence and never completes the node. `files_touched` entries must be normalized project-relative paths and every existing component is realpath-checked under the project root. `artifact_path` is restricted and realpath-bound to `.opencode/runs/<current-run-id>/artifacts/**`.

## Ownership and transfer

A run belongs to the session that created it. Run/status/resume/artifact operations resolve only exactly owned runs, and list hides other sessions' runs. Discovery reads a bounded minimal owner discriminator before parsing remaining state: malformed exact-owner candidates become bounded compact errors or a precise full-list failure, while parseable other-owner bodies are neither parsed nor disclosed. A corrupt `progress.json` is quarantined through owner-facing tools only after that envelope confirms the requesting session is the owner; another session cannot trigger quarantine or derived-file changes. Use:

```text
alg_transfer run_id="..." new_owner_session_id="..."
```

Only the current owner can transfer. Before committing, the tool asks the SDK for the target session using the current directory and verifies observable project/directory scope. The transfer then reloads under the run lease and appends an audit record (`from`, `to`, actor, timestamp); after transfer, the prior owner no longer controls the run. A run also has an exclusive execution lease, so two sessions cannot execute it concurrently.

## Shell trust and permissions

Shell gates execute the literal command supplied to `alg_plan`, `alg_run`, `alg_resume`, or a custom graph. Treat graphs and commands as code: review them before execution. ALG requests OpenCode's public `bash` permission for each command; deny/ask/allow behavior remains controlled by your OpenCode permission policy. The installer never grants shell permission in `opencode.jsonc`; copied orchestrator/implementer agent files intentionally declare their own role permissions.

The runtime confines `cwd` to the project root, supplies only a small environment allowlist, and caps command length/output tails/timeouts. On timeout or cancellation ALG attempts process-tree termination and verifies that the POSIX process group or the snapshotted/refreshed Windows descendant set is gone. If verification cannot confirm containment, the shell result explicitly reports `termination_failed`; descendants may remain, so containment is not guaranteed. These are guardrails, not a sandbox. Do not approve untrusted commands, and use narrow OpenCode permission patterns rather than blanket `bash: allow` when possible.

## Recovery

- **Interrupted run:** call `alg_status`, then `alg_resume`. Attempt history is retained.
- **Active lock:** wait for the holder. ALG never deletes a lock it cannot prove expired. An expired valid lock is renamed to `execution.lock.stale-...` before takeover; malformed/unverifiable locks fail closed for manual inspection.
- **Corrupt run state:** invalid/oversized/incompatible `progress.json` is not executed. Exact-owner access reports it as quarantined only after the rename succeeds; if rename fails, ALG explicitly reports that the corrupt file remains in place and manual action is required. A structurally valid progress file whose referenced sidecar is missing, altered, inaccessible, wrong-kind, cross-run, or escaping is not quarantined: it fails closed as a derived-file reconciliation error. Inspect `progress.json.bak` and its complete reachable immutable set, restore only a validated exact project/run match, or start a new run. Do not delete content-addressed files merely because current progress does not reference them; the backup may still do so.
- **Corrupt project model settings:** `.opencode/alg-models.json` is reported as quarantined only after a confirmed rename. Rename failure leaves it in place and is reported as requiring manual recovery.
- **Path containment failure:** every existing component below trusted project/config roots is realpath-checked; symlink/junction escapes are rejected while contained nonexistent suffixes remain creatable. Windows `$Extend/$Deleted` race results are accepted only after `lstat` proves the original component missing with `ENOENT`/`ENOTDIR`; access denial and unknown errors fail closed.
- **Blocked/failed attempts:** limits do not reset. Increase limits only by creating a new validated graph/run; do not hand-edit durable state.
- **SDK failures:** ALG emits deterministic bounded diagnostics containing safe message/code/status/request or correlation IDs and nested response detail when available. Authorization, tokens, API keys, cookies, secrets, passwords, prompts, content/messages/payload/body/input assignments (including escaped serialized forms), and headers are redacted; circular and oversized values are safely bounded.

## Safe update, backups, and uninstall

The versioned manager workflow is documented separately in
[`docs/upgrades.md`](docs/upgrades.md). The commands below are the retained
direct-installer interface and do not create or consume a managed receipt.

The installer detects UTF-8 (with or without BOM) and BOM-marked UTF-16LE/UTF-16BE, parses both configs and preflights agent operations before any live write, and preserves the original encoding/BOM, comments, trailing commas, unrelated fields, and plugin tuples. Unsupported or invalid encodings fail closed rather than being guessed. It edits only exact ALG registrations, then validates again. Existing changed configs receive byte-exact timestamped adjacent backups (`*.alg-backup-<timestamp>`), followed by same-directory atomic replacement. Config and agent commits are transactional: a later write/copy/remove failure restores every earlier live file to exact original bytes and removes newly created files; audit backups may remain. Malformed input fails without config, backup, or agent writes. Repeated install is idempotent and creates no new backup.

Customized agent files are never overwritten by default. Explicit update/force backs up every changed agent before replacement. Review backups before deleting them.

```powershell
# registration only; leaves agent files
.\scripts\install.ps1 -Uninstall -SkipAgents
# remove only bundled agents that still exactly match this package; custom files stay
.\scripts\install.ps1 -Uninstall -RemoveAgents
```

```sh
./scripts/install.sh --uninstall --skip-agents
./scripts/install.sh --uninstall --remove-agents
```

Uninstall backs up changed configs. `--remove-agents` backs up exact bundled files before removal and skips customized files. Restart OpenCode afterward.

## Development checks

```sh
bun install
bun run test:tui
bun run test:installer
bun run check
# mandatory external destination; no release evidence is written in the repo
bun run release:gate -- --evidence-dir D:\Docker\model-temp\opencode-alg-release-evidence
```

The aggregate release gate uses argument-vector subprocesses for typecheck, all
Bun tests, smoke, isolated live verification, Excel manifest/Python/frozen-uv
checks, wrapper EOF stdout proof, and npm pack dry-run against a complete
reviewed path allowlist. Its mandatory absolute
external evidence directory receives one strict bounded redacted JSON document
that references the separately retained live evidence by immutable unique
path/hash/size/device-inode identity. Strict live artifacts remain schema v2 and
kind `opencode-alg-live-verification`; package v0.3.0 release evidence is strict
schema v5, requires that live identity, requires the exact 14 tool IDs with skill
evolution disabled in the isolated live proof, and separately runs/binds the
complete manager suite under manager protocol v0.2.0. It retains
complete redacted stdout/stderr within strict per-command/aggregate limits and
recomputes byte counts/SHA-256 over those exact strings. A separate semantic
pass binds ordered command IDs and executable families, parsed test/manifest/
wrapper/npm results, complete current package metadata, strict current-root
live semantics, and a separate bounded full release-input identity. That second
identity covers every reviewed packed file, all test sources, and lock/config
controls with path/type/mode/size/content framing before and after all commands;
the runtime-source digest remains the narrower live plugin proof. Release
filenames use the release-input prefix. Local hashes provide integrity, not authenticity against
coherent rewriting of all local files.

`bun run check` performs strict TypeScript checking, all hardened tests, the no-model dry smoke run, and bounded live OpenCode version/server/raw tool-ID/TUI-registration verification. Smoke and live verification create separate `alg-smoke-*` and `alg-live-verify-*` temporary project trees and remove their exact created trees on both success and failure; these project trees are not release evidence and are never intentionally retained. Live verification disables parent project/default plugin discovery, uses isolated HOME/XDG state plus explicit temporary server and TUI configs that each register this checkout's canonical package-root `file://` spec, and requires server/TUI markers for a complete bounded runtime manifest (`package.json`, all `src/**/*.ts`, shipped templates/agents, and the strict Excel manifest/policy/project/lock/validator/wrapper assets). Normal startup does not compute or log that marker. Server/TUI process cleanup and temporary-environment removal are mandatory pass criteria. Separately, `check:live` retains one bounded evidence JSON only under the dedicated external `opencode-alg-verification-evidence` root below the OS temporary directory (or an approved absolute `OPENCODE_ALG_LIVE_EVIDENCE` there). Every run uses an immutable `live-verification-<source-prefix>-<random-uuid>.json` name and no-clobber publication. The exclusive temporary identity is recorded after write; final and temporary must remain the same hard-linked file through exact byte/hash checks, and temporary cleanup requires that identity again. `check:live` prints final device/inode identity with exact path/size/hash, source manifest identity, registrations, and cleanup results. Strict later verification rejects even a same-byte identity replacement. Later checks cannot replace earlier release-referenced artifacts. See [`docs/operations.md`](docs/operations.md) and [`docs/release-verification.md`](docs/release-verification.md).

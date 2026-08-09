# opencode-alg

**Agents + Loops + Graphs** for OpenCode 1.18.3+: a typed DAG executor with durable project state, bounded attempts and payloads, fresh-child checking, model snapshots, and audited run ownership.

## Tools

| Tool | Purpose |
|---|---|
| `alg_templates` | List built-in graph templates |
| `alg_models` | View, set, or clear strict project model + effort snapshot sources |
| `alg_criteria` | Update/lock criteria on an already planned run; normally pass criteria to `alg_plan` |
| `alg_plan` | Validate and persist a DAG without executing it |
| `alg_run` | Execute ready-set waves under an exclusive run lease |
| `alg_status` | Inspect an owned run or list runs owned by this session |
| `alg_resume` | Resume an incomplete owned run without resetting attempts |
| `alg_artifact` | Read one typed node artifact from an owned run |
| `alg_transfer` | Auditably transfer a run to another OpenCode session |

State is project-local:

```text
.opencode/runs/<run_id>/
  criteria.md
  graph.json
  progress.json            # authoritative validated run state
  progress.json.bak        # most recent write backup
  artifacts/<node>.json
  checks/<checker>-attempt-<n>.json
  sessions/<node>-a<n>.json
```

Each live node attempt gets a fresh OpenCode child session. ALG does not explicitly forward worker transcripts to a checker: its prompt payload contains bounded criteria plus bounded claimed output. This is history separation, not a sandbox—OpenCode SDK behavior, configured project/system instructions, tools, and filesystem context still apply. Full child transcripts remain in OpenCode's database.

## Install

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

The launchers only install this package's dependencies and invoke the same TypeScript installer core. The core registers the **package-root URL** in both `opencode.jsonc` and `tui.json`; OpenCode resolves `./server` and `./tui` from `package.json` separately. The TUI module defaults to `{ id, tui }` and the server module defaults to `{ id, server }`—they are never combined.

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

## `/alg-models` TUI workflow

Open the command palette under **ALG → Choose agent models**, or enter `/alg-models`:

1. Choose exactly `explorer`, `researcher`, `implementer`, or `checker`.
2. Review the current global model and effort.
3. Search models exposed by the connected/configured `api.state.provider` catalog. Deprecated models are omitted.
4. Pick a model or **Inherit OpenCode default**. Inherit removes both global role fields.
5. If that runtime model has variants, search a second picker containing **Default model effort** plus only that model's sorted, non-disabled `variants` keys. Models without variants save default effort immediately.

Effort is OpenCode's public `variant` field, not a provider-independent low/medium/high enum. Variant IDs are model-specific exact catalog keys. Selecting an explicit effort uses OpenCode 1.18.3's official global config PATCH API to write `agent.<role>.model` and `agent.<role>.variant` together; model-default effort also uses a model-only PATCH when no role variant currently exists. Because that API deep-merges and cannot delete an optional property, **Default model effort** with an existing variant instead sets the selected model and deletes `variant` in one local JSONC transaction; **Inherit** locally deletes both fields in one transaction. Local edits require the API read's actual response URL to be loopback and exactly one local config source whose role fields exactly match that read. Zero, ambiguous, split, mismatched, URL-less, or non-loopback sources fail closed with server-side editing instructions. Successful edits preserve comments, encoding/BOM, unrelated config, and exact adjacent backups.

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

The role variant is captured only when that same role has an explicit valid role model; it never attaches to a top-level fallback. Project selection overrides the role selection as a unit. Provider/model values split at the first slash, so model IDs may themselves contain slashes. Each new run copies model and optional variant into its immutable `model_snapshot`; later project/global changes cannot rewrite an existing run, and every role attempt/retry uses its snapshot. Prompts send only `{ providerID, modelID }` under `body.model`, with effort separately as top-level `body.variant`; absent values are omitted. Clear the project choice before planning when inheritance is desired. **Quit and restart OpenCode after every global model/effort change**, whether API- or local-edit-backed, before relying on it.

## Typical use

```text
alg_plan goal="Add rate limiting" template="coding-diamond"
  criteria=[...] shell_gate="bun test"
alg_run run_id="..."
alg_status run_id="..."
```

For a no-model smoke path, use `alg_plan mode=dry` then `alg_run dry=true`.

Pass user criteria directly to `alg_plan`. `alg_criteria` never creates a staging run: it only edits an owned run while it is still `planning`. Locked criteria require `lock=false` to replace them and leave them unlocked; a later call with the default lock behavior can lock the replacement.

### Templates and attempt semantics

- `coding-diamond`: explore (1) → research (up to 2) → implement (up to 5) → fresh-child checker (up to 5), with checker failures routed to its direct implementer dependency when both still have capacity; global cap 13.
- `research-diamond`: two explorers in parallel (1 each) → research (up to 2) → fresh-child checker (up to 2), with feedback to its direct research dependency; global cap 6.

`loop.max_attempts` includes the first attempt; it is not “retries after first.” Every reserved node attempt increments `global_attempts`, including schema failures, shell denials/failures, checker rejections, and interrupted attempts. The local and graph-global caps are both hard. Each node receives at most one attempt per graph-ordered wave, so parallel completion speed cannot choose who receives a scarce retry. `alg_resume` preserves counters and history; an attempt left `running` by interruption becomes failed and is retryable only when unused capacity remains. Dry attempts also consume attempt counters but make no model calls.

Agent outputs have serialized aggregate byte caps (in addition to field/count bounds), and worker/checker prompts are capped well below the 5 MiB state ceiling. Oversized dependency aggregation, checker claims, responses, or outputs fail the attempt before prompting or persistence. An implementer may report `done:false` only with explicit `blockers` and optional `artifact_path`; this is retained as structured failed-attempt evidence and never completes the node. `files_touched` entries must be normalized project-relative paths and every existing component is realpath-checked under the project root. `artifact_path` is restricted and realpath-bound to `.opencode/runs/<current-run-id>/artifacts/**`; absolute, traversal, escaping symlink/junction, control-character, and prototype-segment paths are rejected.

## Ownership and transfer

A run belongs to the session that created it. Run/status/resume/artifact operations resolve only exactly owned runs, and list hides other sessions' runs. Discovery reads only a bounded ownership envelope before any full parse or mirror repair. A corrupt `progress.json` is quarantined through owner-facing tools only after that envelope confirms the requesting session is the owner; another session cannot trigger quarantine or derived-file changes. Use:

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
- **Corrupt run state:** invalid/oversized/incompatible `progress.json` is not executed. Exact-owner access reports it as quarantined only after the rename succeeds; if rename fails, ALG explicitly reports that the corrupt file remains in place and manual action is required. An unverifiable ownership envelope also fails closed in place without non-owner side effects. Inspect `progress.json.bak`, restore only a validated exact project/run match, or start a new run.
- **Corrupt project model settings:** `.opencode/alg-models.json` is reported as quarantined only after a confirmed rename. Rename failure leaves it in place and is reported as requiring manual recovery.
- **Path containment failure:** every existing component below trusted project/config roots is realpath-checked; symlink/junction escapes are rejected while contained nonexistent suffixes remain creatable.
- **Blocked/failed attempts:** limits do not reset. Increase limits only by creating a new validated graph/run; do not hand-edit durable state.

## Safe update, backups, and uninstall

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
```

`bun run check` performs strict TypeScript checking, all hardened tests, the no-model dry smoke run, and bounded live OpenCode version/server/raw tool-ID/TUI-registration verification using temporary generated evidence. See [`docs/operations.md`](docs/operations.md) for the concise operations checklist.

# ALG operations checklist

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
- `done:false` implementer output requires blockers and remains an incomplete failed attempt.
- Implementer file metadata is normalized project-relative and realpath-contained by the project; artifact paths are realpath-bound under `.opencode/runs/<current-run-id>/artifacts/**`.
- Aggregate output and worker/checker prompt byte caps reject oversized dependency/claim payloads before prompt/persistence.
- Checkers use fresh children without explicit worker transcript forwarding; SDK project/system/tool/filesystem context still applies.
- Review every shell command and rely on OpenCode `bash` permission prompts/patterns.
- Timeout/cancel attempts tree termination and verifies the POSIX group or prepared Windows Job. Ordinary POSIX shell-leader exit also checks and terminates a surviving detached process group before returning. `termination_failed` remains explicit when privileged or other unconfirmed cases prevent containment proof; descendants may remain.
- Windows commands launch only after a private per-process native helper has configured the Job and its prepared watcher is control-ready; timeout starts at command-ready. The bundled helper is compiled once in a random private temporary directory and never loaded from a predictable shared cache.
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

# Changelog

## Unreleased

- Worker attempts started by `alg_run` and `alg_resume` now appear in the parent
  transcript as native OpenCode subagent cards: running, completed, and failed
  states, parallel nodes side by side, a card per retry, and click-through to the
  child session. The cards are a display of saved run state and cannot change an
  outcome. A host that refuses them switches them off for that call; the new
  `subagentCards: "off"` plugin option disables them. Each card adds one short
  `task` call (node, attempt, agent, one-line result) to the parent model's
  history, never the worker prompt or transcript. Builds before this option
  reject it as an unknown key, so remove it before rolling back.
- Cancelling `alg_run` or `alg_resume` now aborts every running child session
  before the tool returns. Previously only the request was dropped and the
  children kept running.
- Worker sessions no longer receive ALG's own tools, which removes their
  definitions from every worker request and prevents a worker from starting a
  nested run. The four memory tools stay available to workers when session
  memory is enabled.
- Removes the automatic live sidebar panel. `/alg-live` and `/alg-runs` remain.
- A node's outcome is saved as soon as it finishes instead of when its whole
  batch settles, so a slow sibling no longer delays durability, progress, or the
  card of a finished node. A failed attempt that will be retried is saved once,
  already rescheduled, and an unchanged run is no longer saved again.
- Saves are cheaper. One save inspects each directory once instead of once per
  file, verifies each immutable object once, confirms short lock files by file
  identity instead of reading them back, and a running run rewrites its owner
  projection only when its status changes or another writer touched it. With
  instant synthetic workers on the development machine, a four-node run went
  from 18 saves in about 4.5 s to 14 saves in about 1.3 s. Real runs are
  dominated by model time; the gain is shorter pauses of the OpenCode process.
- The hook that runs before every model request no longer scans every run
  directory. It reuses the last scan until the runs directory or the session's
  owner projection changes, and skips worker sessions entirely: about 0.3 ms per
  request regardless of history, against about 280 ms with 200 runs on disk.
- Lock waits that could never succeed no longer block: acquiring a lock the
  same thread already holds reports contention at once, and refreshing the
  non-authoritative owner projection waits for other writers for at most 0.5 s
  in total instead of up to 25 s. Waits for another process stay bounded
  synchronous waits (0.25 s for run locks, 1 s for the skill-evolution store).
- Adds model-independent graph-run visibility through bounded durable progress
  metadata and `/alg-live`, while retaining `/alg-runs` for
  attempt history. UI observation does not copy child transcripts into the parent
  context or change execution, permission, retry, or persistence authority.
  See `docs/live-run-visibility.md` for the design and synthetic-test boundary.
- Worker prompts no longer show the JSON Schema `$schema` marker, and an echoed
  top-level `$schema` key no longer fails output validation. Live models copied it
  and lost an attempt; a node with one attempt failed the run.
- A live skill audit interrupted by plugin shutdown (every `opencode run` exit, or
  quitting mid-audit) stays recoverable: startup recovery requeues it within
  `maxAttempts` instead of the turn being recorded as permanently failed.
- Adds a default-off environment memory engine for reviewed, scoped machine,
  route, endpoint, API, repository, deployment, database, and principal facts.
  Bun's native SQLite store commits revisioned observations transactionally;
  bounded context and the existing read-only memory tools expose scoped results
  without changing the 19-tool registry. No automatic discovery or credentials
  are stored. See `docs/environment-memory.md`.
- Adds explicit import, query, snapshot, restore, local/S3 replication commands
  and a deterministic synthetic benchmark. Local SQLite commitment and remote
  manifest publication are reported as distinct durability levels; synthetic
  transport tests do not claim live S3 validation. `@aws-sdk/client-s3` is an
  optional peer dependency, so default installs do not include it.
- System and compaction hooks share one durable-fact selection. Assist compaction
  no longer appends a separate run summary, skill-evolution paragraph, or checkpoint
  sentence. The first user sentence is stored as an observed opening, not a task goal.
  An assist-mode retry blocks only while the cited committed run is still that failure,
  comparing the shell gate this call will run, including a command not yet persisted.
- Assist compaction completes the pending learning-evidence snapshot before building
  its working view. Required skills that do not fit the context budget still stop
  guarded execution. Context receipts distinguish eligible candidates from items
  actually rendered and count evidence omitted for the budget.
- Adds opt-in session memory independent of learning: exact skill/dependency
  bindings, durable checkpoints, bounded graph context, reviewed environments,
  single-use retries and scoped child handoff. Four memory tools expand the exact
  registry to 19. See `docs/session-memory.md` for synthetic-tested boundaries.

- Repairs compaction continuity: whole skill bodies or explicit full-load pointers,
  no unmatched-skill activation, durable session-owned skill hashes with drift
  warnings, and per-turn accounting for complete system injections.
- Validates source ownership/exclusions before evidence reads and publication.
  Captures stable host envelopes at ordinary turn boundaries and persists explicit
  evidence-coverage gaps, including failed terminal rows. Later system context
  reloads recovery state independently of the host summary.
- Budgets ALG-owned context only; existing other-plugin chunks remain exact.
  See `docs/session-continuity.md` for implemented boundaries and proposed
  session-scoped knowledge-graph retrieval.
- Snapshots live skill-evolution evidence at enqueue and on
  `experimental.session.compacting`, then prefers that snapshot after host
  compact. Live message reads use `100 + 1` overflow detection and classify
  `overflow` / `compacted_or_unavailable`. The compacting hook injects bounded
  skill-evolution pointers and logs hook failures.
- Fails closed at live intake when V1 model calls are blocked, so DESIGN-style
  enablement without `allowBuiltinToolMap` no longer writes failed ledger
  identities. Manual audit surfaces the same `tool_permissions` limitation.
- Excludes `alg:` executor children from automatic intake, persists
  `session.deleted` and cancels queued rows, and documents that `summary:true`
  recaps are historical-only.
- Accepts auditor `confidence` only as `low|medium|high` or the documented
  numeric ranges; substring matches such as `highly uncertain` fail closed.
- Documents status as inspect-only; transaction repair remains startup and the
  mutating review/promote/rollback tools.
- Skill evolution reads existing `SKILL.md` files from configured roots (and
  observes OpenCode config skills for use). Evidence includes that catalog.
  Auditors prefer `no_change` or `skill_revision` over duplicate creates.
- Matching complete skill bodies enter system context; session-active identity
  pointers enter compaction only
  when `skillEvolution.enabled` is true. `applicable_skill_unused` still labels
  evidence; it does not spawn an auditor in `triggered` mode (humans /
  `every-turn` only).
- `skipUninformativeAudits` defaults true: `every-turn` still records, but skips
  auditor model calls on uninformative turns.
- `compactSession` snapshots share one `session.messages` fetch per session and
  the compacting hook is time-bounded below the child-call timeout. Joined
  ALG-owned context is capped, not the shared `output.context` of other plugins.

## 0.4.1

Package identity is `0.4.1`. Release evidence schema 6 binds `package_version:"0.4.1"`. Historical `v0.4.0` remains at tag `7cc2f21` and must not be moved.

- Rejects DuckDB star projections except `COUNT(*)`. MCP query results return only `{ok, columns, rows, truncated}` (plus `error`/`cancelled`).
- Marks skill-evolution audits for sessions outside the current project as `no-change` instead of `failed`.
- Coerces auditor `confidence` numbers, nulls, and non-enum strings to `low`/`medium`/`high` so schema-valid otherwise jobs are not failed.

## 0.4.0

Package identity is `0.4.0`. Release evidence schema 6 binds `package_version:"0.4.0"`. Historical `v0.3.0` remains schema 5 at tag `e16ca58` and must not be moved.

- Repairs execution diagnostics, terminal/persistence boundaries, expression parsing,
  initial execution-directory binding, privacy redaction, exact-byte bounds and
  cross-process evolution fencing. Private evolution model calls now fail closed
  on the pinned V1 SDK's missing all-tool permission contract; existing candidate
  management remains available. This is a documented breaking safety restriction.
- Hardens the optional local DuckDB policy, worker supervision and project-owned
  installation. Adds synthetic-only connector preparation, pinned local Data
  Science, explicit experience intake, incident evidence and paired evaluation.
- Adds immutable dataset-receipt intake, non-destructive archival copies and a
  rebuildable derived catalog. No automatic background collector or remote driver
  activation is claimed.
- Repairs frozen npm package installation, Node entrypoint dispatch, Windows
  shell PATH bounds, version range checks and failure-preserving verification.
- Adds a source-bound synthetic gate. See `docs/implementation-status.md` for
  incomplete implementation and deployment/host/platform acceptance gates.

## 0.3.0

- Adds disabled-by-default, project-local skill evolution behind the strict
  server plugin-tuple `skillEvolution` option. Triggered and every-turn modes,
  configured project-relative skill roots, evidence/content/candidate/ledger/
  backlog/attempt bounds, fixed single concurrency, and strict unknown-option
  rejection make activation and cost explicit.
- Adds successful-completed-assistant event intake with durable
  session/message-key deduplication, bounded backlog failure, recursion exclusion
  for private children, serialized processing, and bounded interrupted-audit
  recovery. Dedupe does not claim exactly-once external model calls.
- Adds exact-turn evidence selection, deterministic trigger labels/scores,
  bounded UTF-8 excerpts/tool summaries and omission accounting, plus
  credential/obvious-secret/local-path redaction. Evidence is treated as
  untrusted prompt data; redaction is not a DLP guarantee.
- Adds a fresh no-tools researcher auditor with strict provenance/trigger/
  candidate output and, for skill proposals, a separate fresh no-tools checker
  whose pass/finding fields must agree. Memory candidates remain review-only and
  checker rejection cannot be bypassed by restore.
- Adds a separate `.opencode/skill-evolution/` store with strict bounded ledger
  and candidate indexes, cross-process revision-CAS mutation, immutable evidence
  and candidate revisions, independent replacement backups, content hashes, and
  direct-path/identity containment checks.
- Adds `alg_skill_evolution_status`, `alg_skill_evolution_audit`,
  `alg_skill_evolution_historical`, `alg_skill_evolution_review`,
  `alg_skill_evolution_promote`, and `alg_skill_evolution_rollback`, bringing the
  exact public server contract to 15
  ordered tool IDs. Disabled status remains inspectable; audit and mutation fail
  closed until explicit opt-in.
- Adds explicit confirmed promotion for immutable-checker-approved skills only.
  Create/replace basis checks, strict `SKILL.md` validation, create-only
  transaction journals, independent backups, hard-link claims, repeated
  byte/hash/device-inode checks, and create-if-absent publication preserve
  detected custom or third-party drift.
- Adds bounded startup/status transaction recovery and explicit replacement-only
  rollback. Recovery restores exact interrupted before-state or commits an exact
  already-applied state; ambiguous journals remain unresolved. Created skills
  are never deleted by rollback, and every skill-file mutation requires an
  OpenCode restart before relying on reloaded content.
- Updates package and lock metadata to `0.3.0`, keeps ALG run schema 2 compatible
  with package generations 0.1.0–0.3.0, advances strict release evidence to
  schema 5, retains strict live evidence schema 2, and keeps the versioned
  manager/receipt protocol at `0.2.0`.
- Extends source-bound live/release proof to the six skill-evolution runtime
  modules, including `skill-evolution-historical.ts`, and the exact 15-tool
  startup marker while isolated live verification keeps skill evolution disabled
  and makes no model calls.

## 0.2.0

- Adds the side-by-side, receipt-backed Git release manager and transactional
  `install`, `update`, `doctor`, `rollback`, and `uninstall` workflows.
- Upgrade-manager release notes are a placeholder until the v0.2.0 release is
  cut and its final verification evidence is recorded outside the repository.
- Declares the current schema-v2 ALG run state compatible with retained v0.1.0
  generations; rollback still checks the durable-state declaration before any
  live write.
- Adds an explicitly opt-in Excel capability pinned to
  `excel-mcp-server==0.1.8`, a complete frozen `uv.lock`, strict 25-tool wrapper
  self-check, relative `.xlsx` path confinement, and deterministic staged-copy
  validation. The direct installer remains Excel-neutral.
- Adds generation-specific Excel receipt/config ownership, transactional
  enable/preserve/disable/rollback/uninstall behavior, read-only doctor status,
  and lock-digest-keyed external Python environments.
- Adds `spreadsheet-diamond`. Formula calculation and optional LibreOffice
  recalculation remain out of scope for v0.2.

## 0.1.0

- Baseline ALG server/TUI package with typed DAG execution, durable runs,
  bundled agents, source-bound live verification, and the direct transactional
  installer.

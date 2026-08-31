# Changelog

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
  `alg_skill_evolution_review`, `alg_skill_evolution_promote`, and
  `alg_skill_evolution_rollback`, bringing the exact public server contract to 14
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
- Extends source-bound live/release proof to the new runtime modules and exact
  14-tool startup marker while isolated live verification keeps skill evolution
  disabled and makes no model calls.

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

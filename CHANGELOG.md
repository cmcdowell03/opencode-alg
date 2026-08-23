# Changelog

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

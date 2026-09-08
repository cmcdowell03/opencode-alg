# Completion-plan implementation status

This is an engineering checkpoint, not a release or deployment approval. Verification uses synthetic data and local prepared runtimes only. Existing user changes and historical receipts are preserved. No active OpenCode configuration, remote service, release tag, or production data is changed by this work.

| Milestone | Implemented scope | Remaining acceptance or implementation |
| --- | --- | --- |
| M0: reproducibility | Runtime/source asset inventory, private-state ignore rules, frozen package dependencies, extracted-package installation fixture, separate retained synthetic gate | A new release and historical-version/platform matrix are not certified |
| M1: execution and learning | Canonical diagnostics, terminal transitions, error propagation, execution-directory capture, byte bounds, versioned redaction, shared live/historical fencing, read-only health, bounded SDK calls, evidence-backed checker prompts | The installed V1 SDK cannot express the required all-tool session permission rule; private evolution model calls fail closed. No live learning-host acceptance |
| M2: local DuckDB | Conservative SQL validation, measured extension state, cancellation-aware bounded workers, project ownership/config transactions, skill installation, pinned external environment | POSIX, live host MCP/skill discovery, hard OS RSS and crash-remnant cleanup acceptance remain unmeasured |
| M3: connectors | Versioned endpoint/credential-reference/extension contracts, bounded synthetic replica materialization, read-only query preparation, shared FastAPI query plane | Remote activation intentionally unavailable. Real drivers, deployed read-only roles, pushdown/resource/concurrency evidence and approved extension preparation remain incomplete |
| M4: experience | Immutable bounded project-local objects, explicit committed-run and hash-verified dataset intake, sealed historical-plan adapter, bounded explicit terminal-run intake, non-destructive archival dedupe, deterministic catalog snapshot, capacity reporting | Automatic background/message-hook intake is not implemented; archival copies do not reset capacity, and local hashes are not independent source authentication |
| M5: Data Science | Pinned DuckDB/PyArrow subprocess, local CSV/Parquet operations, privacy exclusions, quality checks, descriptive profiles, confirmed immutable exports, receipt-owned interpreter lifecycle without MCP | Managed MCP lifecycle and installed-host discovery remain incomplete; no hard process-memory guarantee |
| M6: troubleshooting | Revision-fenced incident history, supporting/refuting evidence, remediation confirmation, verification-linked resolution, explicit reopen/block states | No automatic repair execution or independently authenticated approval; broader operational runbook acceptance remains |
| M7: catalog/evaluation | Rebuildable derived DuckDB catalog with logical checksums; paired version/model/environment-bound outcome evaluation and leakage guards | Versioned multi-lesson historical extraction, automated replay-task execution and demonstrated downstream effectiveness remain incomplete |

## Synthetic verification

Run the settled source serially with two explicitly prepared interpreters and an existing evidence directory outside the package:

```powershell
bun run scripts/synthetic-gate.ts <absolute-duckdb-python> <absolute-datascience-python> <absolute-evidence-directory>
```

The gate checks exact runtime pins, type checking, asset manifests, local Python suites, the complete Bun suite, smoke tests and the actual npm package inventory. It binds the evidence to the source identity before and after execution and retains failed attempts as failures. It does not execute `check:live`, contact model providers, load remote connectors, or declare a release approved. Optional Python suites explicitly require their prepared environments; an ambient Python discovery skip is not acceptance evidence.

The existing `release:gate` and `check:live` remain separate host/release workflows. A legacy release-gate success alone does not certify new optional capability runtime behavior. Do not interpret focused tests from intermediate source states or interrupted full-suite runs as settled-source acceptance.

## Next completion sequence

1. Settled-source synthetic verification receipt is retained outside the package (`alg-synthetic-e46c3000-ee5d-400c-8438-97712d0a7ca4.json`). It is not live-host or release approval.
2. Add a supported all-tool permission transport for evolution and verify it against an isolated host before restoring private model calls.
3. Complete managed Data Science MCP lifecycle; bounded explicit historical/run intake already exists.
4. Implement versioned multi-lesson reduction and a synthetic replay runner without reinterpreting old review receipts.
5. Implement remote driver adapters against disposable services and synthetic data; deployed endpoint acceptance remains a separate operator step.
6. Run the independent Windows/POSIX, supported-host and resource-bound acceptance matrix before any broader release claim.

Core ALG install does not wait on items 2–6. Those are optional capability and learning-loop work.

Feature documentation: [local DuckDB](duckdb-query-plane.md), [connector preparation](connectors.md), and [experience/Data Science](experience-and-data-science.md).

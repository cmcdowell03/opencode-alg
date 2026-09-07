# Explicit experience, troubleshooting, and data science

These are optional local operations, not implicit transcript memory. Normal ALG startup and message hooks do not launch them. Existing run JSON remains authoritative. No new core ALG tools are registered. No real PostgreSQL or cloud acceptance is implied by synthetic tests.

## Experience records

Run `bun run experience -- <command> <absolute-project> [arguments]` from a checkout (or invoke the packaged `scripts/experience-cli.ts` using a dependency-ready Bun runtime).

Commands:

- `health`: read-only capacity report; does not initialize an empty store.
- `record <absolute-request.json>`: append a validated project-private object.
- `import-run <run-id> <owner-session-id>`: import a committed terminal ALG outcome, with no goal/transcript/output copying. Unknown model cost remains null.
- `import-historical <plan-id>`: import a completed historical plan's sealed commitments and counts. Transcript, fragment, and assistant-message bytes are not copied.
- `intake-runs <owner-session-id>`: import at most 32 owned terminal runs in one explicit invocation. This is not a message-hook collector.
- `import-dataset <project-relative-receipt-path> <ISO-observed-time>`: validate a content-addressed Data Science export receipt and its Parquet hash/size, then append a dataset record without source values. Reuse the observed time for an idempotent retry.
- `archive-copy <object-id> --confirm`: make a verified non-destructive archival copy. It does not delete the outbox object, reset capacity, or count the same object twice.
- `catalog`: export a deterministic, schema-versioned snapshot to stdout.
- `catalog-build <absolute-prepared-python>`: build a derived DuckDB artifact from the verified source snapshot.
- `incident <absolute-request.json>`: append a revision-fenced incident transition.
- `incident-history <incident-id>`: inspect the immutable incident timeline.
- `evaluate <absolute-request.json>`: evaluate paired, version-linked task outcomes without automatically publishing a skill.

Records live in `.opencode/experience/outbox/` under their content hashes. Records contain source identity/hash, project scope, observed time, retention class, status, redacted bounded summary, related skill version, group, typed relations, and finite/null metrics. Unknown facts are not encoded as successful or zero. The current implementation is explicitly invoked, not an automatic background collector.

Example record request (replace the synthetic source hash with the actual source hash):

```json
{
  "kind": "observation",
  "source": {"type": "diagnostic", "id": "synthetic-fixture", "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
  "observed_at": "2026-09-04T00:00:00Z",
  "retention": "operational",
  "status": "observed",
  "summary": "The synthetic shell failure included a trailing newline.",
  "skill_version": null,
  "group": "incident-1",
  "relations": [],
  "metrics": {"model_cost": null}
}
```

Do not put credentials into identifiers, summaries, or source files. Redaction is defense in depth, not a guarantee that arbitrary sensitive business data is recognizable. Local hashes protect integrity, not against an actor who controls all source records. The initial bounds are 32 KiB/object and 10,000 source objects; capacity is reported and never silently evicted. Catalog build accepts at most an 8 MiB verified snapshot per invocation. These bounds are explicit stop conditions, not infinite retention.

## Troubleshooting authority

The remediation-planned request requires a `remediation` object with three distinct object IDs: `action`, `rollback`, and `verification`. Each must reference an inferred `action` record in the incident's group, with source type `action-proposal`, `rollback-proposal`, or `verification-proposal`, respectively. These become durable plan evidence. A phrase mentioning rollback in a summary is insufficient. Resolved outcomes must belong to that incident and cannot be dated after the resolution.

An incident records competing evidence without executing shell commands. States progress through opened, triaged, investigating, cause-identified, remediation-planned, remediating, verifying, and resolved. Blocked/reopened routes preserve prior history. Every transition requires the expected current revision. Cause identification requires an observed diagnostic; remediation requires confirmation of the exact plan record; resolution requires fresh successful verification linked to that remediation. A confirmed invocation is not independently authenticated human approval. Performing an actual repair remains a separate authorized operation.

## Outcome-based evaluation

The `record` CLI rejects managed incident, evaluation and dataset kinds; use their typed commands. Evaluation follows bounded transitive evidence lineage for leakage checks, requires actual skill-version records for applied provenance, and rejects negative model costs or outcomes dated after evaluation.

An evaluation identifies baseline/candidate skill hashes, model/environment identity, training records, and paired outcome record IDs. Each outcome must link to the applied skill and evaluation environment. Training/evaluation leakage, duplicate task pairs, mismatched versions, and absent provenance fail closed. Regressions or unresolved outcomes prevent review eligibility. Eligibility does not publish anything, establish universal benefit, or replace the existing explicit promotion and rollback workflow.

## Pinned local data science

Prepare a dedicated environment outside the immutable package directory, for example in an operator-selected cache:

```powershell
$env:UV_PROJECT_ENVIRONMENT = 'D:/alg-environments/datascience'
uv sync --frozen --no-dev --project capabilities/datascience
bun run data-science -- 'D:/alg-environments/datascience/Scripts/python.exe' 'D:/my-project' 'D:/requests/profile.json'
```

Runtime is exactly DuckDB 1.4.0 and PyArrow 21.0.0. The CLI never installs dependencies. A dedicated subprocess, stripped of ambient database/cloud credentials, has a 30-second deadline. The parent reports generic rejected-operation diagnostics so Arrow errors cannot leak source values. This local entrypoint is not a managed MCP installation. Optional receipt-owned enable/disable/doctor/uninstall is available via `bun run datascience -- <command> --project <absolute-project> [--python <absolute-prepared-python>]`. Enable never writes `mcp.*` and never starts a server.

Preview/profile/validate request:

```json
{
  "operation": "preview",
  "source": "data/example.csv",
  "exclude_columns": ["email"],
  "select_columns": ["id", "amount"],
  "checks": [{"column": "id", "kind": "unique"}]
}
```

Use an explicit `exclude_columns` list; `[]` declares that the input has been reviewed as non-sensitive. Exclusion occurs before filters, statistics, and exports. Only CSV/Parquet scalar datasets are supported. Operations return schema, row/null/distinct counts and descriptive numeric statistics, not raw sample values. Optional `filter` is a typed `{ "column": "id", "equals": 2 }` equality. There is no arbitrary SQL/Python surface.

For `import` or `export`, additionally provide `confirm:true` and `expected_source_sha256` from preview. A changed source or failed quality check prevents writing. Outputs are immutable content-addressed Parquet and JSON receipts under `.opencode/data-science/artifacts/`, with atomic no-overwrite publication. Repeating an identical request is idempotent. If interrupted between data and receipt publication, the content-addressed data remains recoverable by rerunning the same request; it is not automatically removed.

Limits: 8 MiB encoded input, 64 MiB decoded data, 100,000 rows, 64 scalar columns. Parquet metadata is checked before decode. These are application bounds, not a hard process-RSS guarantee. The initial statistical surface is descriptive; it does not claim causal, population-risk, or ML validity.

## Rebuildable DuckDB catalog

Use `experience catalog-build <absolute-project> <prepared-python>`. The catalog has one bounded writer, parameterized inserts, disabled external access, and no user SQL. It preserves source identity and a logical-row checksum separately from physical DuckDB file hashes. Deleting a derived catalog does not remove source objects. A leftover writer lock blocks a new build for explicit operator inspection; it is not assumed stale from time alone.

## Verification boundary

Synthetic tests exercise local filesystem isolation, record integrity, revisions, evaluation constraints, profiles, quality checks, and Parquet round trips. Supported-V1 host integration, multi-platform execution, hard OS memory limits, deployed connector pushdown/resource bounds, sustained background intake, and demonstrated skill effectiveness require their own acceptance evidence. They must not be inferred from unit-test pass counts.

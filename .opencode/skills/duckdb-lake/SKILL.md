---
name: duckdb-lake
description: Use ONLY for project-local DuckDB lake queries through the optional alg_duckdb MCP, or when choosing DuckDB versus asyncpg or Spark for operational analysis.
---

# DuckDB lake query rules

- Use **DuckDB** for bounded analytical joins over reviewed read-only local DuckDB replicas or staged redacted fixtures. Use **asyncpg** for indexed, transactional PostgreSQL requests and service concurrency. Use **Spark** only for reviewed distributed jobs whose partition-pruned input cannot fit the DuckDB resource contract.
- Query only through `alg_duckdb_query`. Trusted initialization resolves each replica from its contract `source_env`: a dedicated `ALG_DUCKDB_*` variable containing an absolute local DuckDB replica path. It attaches only the declared catalog alias with fixed `TYPE DUCKDB, READ_ONLY`. Never emit `ATTACH`, endpoints, DSNs, credentials, settings, or extension commands.
- Always spell a physical source as the contract's exact `catalog.schema.relation`, give every protected source its own alias, and qualify each protected partition column with that alias. Supply every required partition predicate in the same query block and on every `OR` branch. Outer CTE filters do not satisfy an inner protected scan. `LIMIT` caps output; it does not limit scanning.
- Start with plain `EXPLAIN SELECT ...` to inspect the bounded plan. Use `EXPLAIN ANALYZE SELECT ...` only after the plan and partition predicates are reviewed; ANALYZE executes under the same timeout and resource policy as SELECT.
- Sample PII only from a synthetic or explicitly approved, staged, redacted fixture. Direct sensitive-column references are rejected; `SELECT *` output is name-redacted as a second line of defense. Never put canaries, credentials, or operational rows in prompts, logs, fixtures, or shared artifacts.
- Never perform S3, HTTP, Iceberg, Parquet, CSV, glob, bucket, or arbitrary filesystem scans. Table/replacement scans and URLs are prohibited. Do not copy, export, import, materialize, upload, or otherwise move operational data.
- External operational replicas are query sources only. They are separate from, and must never become, an ALG experience catalog.

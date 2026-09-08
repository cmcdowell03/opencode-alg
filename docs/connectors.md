# Connector preparation contract (M3)

This module prepares PostgreSQL and Iceberg/S3 selections and rehearses their transfer with synthetic data. It does **not** activate remote connectors. `activate_remote()` always raises `DeploymentRequired`, including when passed an approval flag. No remote driver is registered, no extension is installed or loaded, and no real service or model is called by these tests.

## Shipped files and dependencies

- `capabilities/connectors/__init__.py`: public preparation and rehearsal exports.
- `capabilities/connectors/contract.py`: strict versioned contract validation and initialization templates.
- `capabilities/connectors/adapter.py`: synthetic connection protocol and bounded local replica materialization.
- `docs/connectors.md`: this contract and deployment boundary.

`tests/python/test_connectors.py` is test-only. There are no bundled extension binaries, credentials, connector-specific manifests, or new dependency installers. Validation uses Python's standard library. Synthetic materialization uses the already prepared DuckDB 1.4.0 environment; tests also use sqlglot 27.14.0 and the existing repaired local DuckDB policy. Packaging is integrated separately.

## Version 1 input

The root object has exactly these fields; unknown and missing fields fail closed:

| Field | Contract |
| --- | --- |
| `schema_version` | Integer `1`; Boolean values are rejected. |
| `mode` | Exactly `preparation_only`. |
| `kind` | `postgres` or `iceberg_s3`. |
| `engine` | Exact `name: duckdb`, `version: 1.4.0`, and DuckDB platform identity, such as `windows_amd64`. |
| `extensions` | Ordered prepared files: `postgres`, or `httpfs` then `iceberg`. |
| `endpoint` | Kind-specific exact endpoint described below. |
| `credential_refs` | Kind-specific private environment variable names, never values. |
| `relations` | Between 1 and 32 explicitly curated relations. |
| `limits` | `max_days` 1–366, `max_rows` 1–100,000, `max_bytes` 1–67,108,864. |

Each extension object contains exactly `name`, `path`, `sha256`, `engine_version`, and `platform`. The absolute direct regular file must be named `<name>.duckdb_extension`; redirects, missing files, files above 256 MiB, mismatched SHA-256, and engine/platform drift fail. The implementation hashes the actual file bytes without loading them. Matching synthetic bytes prove only identity checking, **not** executable ABI compatibility or extension signature/provenance.

`prepare()` additionally requires a separately supplied reviewed `expected_sha256`, actual `runtime_version` and `runtime_platform`, exact `approved_endpoints`, an explicitly supplied private environment mapping, `relation_id`, `start`, and `end`. The reviewed digest is domain-separated SHA-256 over canonical contract JSON, obtained with `contract_hash()`. Production review must supply the digest and endpoint allowlist independently of untrusted request JSON; calculating them from a request and immediately approving them is not an authorization boundary. `load_json()` rejects duplicate keys, nonfinite numbers, non-object roots, and inputs exceeding 128 KiB.

### PostgreSQL

`endpoint` contains `host`, `port`, `database`, `schema`, `sslmode`, and `connect_timeout_seconds`. Only explicit DNS hostnames, plain lowercase database/schema identifiers, ports 1–65535, `sslmode: verify-full`, and connection timeouts 1–30 seconds are accepted. URLs, credentials embedded in hosts, wildcard hosts, paths, IP literals, and arbitrary libpq options are rejected. The separately approved endpoint spelling is `postgresql://<host>:<port>/<database>`; the reviewed contract digest also binds the schema and remaining fields.

`credential_refs` has exactly `username_env` and `password_env`. Each value is an `ALG_CONNECTOR_`-prefixed environment variable name. Bindings must exist, be distinct, nonempty, bounded, and free of control characters. There is no implicit credential discovery or persistence.

Initialization templates disable automatic extension installation/loading, identify the exact prepared file, describe a temporary named secret, and describe a schema-scoped `ATTACH ... (TYPE postgres, READ_ONLY, ..., SECRET alg_source)` with explicit TLS and connection timeout settings. DuckDB supports read-only PostgreSQL attachments and named secrets; its documentation cautions against including passwords in connection strings. [DuckDB 1.4 PostgreSQL documentation](https://duckdb.org/docs/lts/core_extensions/postgres)

### Iceberg/S3

`endpoint` contains `host`, `port`, `region`, `bucket`, `prefix`, `use_ssl`, and `url_style`. Version 1 requires port `443`, `use_ssl: true`, `url_style: path`, an exact DNS endpoint, region, bucket, and slash-terminated directory prefix. The separately approved endpoint spelling is `https://<host>:443/<bucket>/<prefix>`.

`credential_refs` has exactly `key_id_env`, `secret_env`, and `session_token_env`; this preparation version requires explicit temporary-credential bindings and does not use credential chains. Initialization describes a temporary S3 secret with explicit endpoint, SSL, path addressing, region, and prefix scope. These parameters follow the [DuckDB 1.4 S3 configuration interface](https://duckdb.org/docs/lts/core_extensions/httpfs/s3api).

Each curated source must be an exact `s3://` metadata JSON object under that prefix, with a declared `metadata_sha256`. Wildcards, traversal, encoded paths, query strings, arbitrary URLs, table-folder guessing, and REST catalog activation are unsupported. The selection uses `iceberg_scan` with `allow_moved_paths = false`. Exact metadata-file scanning is documented by [DuckDB 1.4 Iceberg](https://duckdb.org/docs/lts/core_extensions/iceberg/overview). The remote metadata digest is a **declared pin**, not verified by preparation or synthetic tests. Metadata can refer to additional data files; their locations and redirects still require deployment verification.

### Curated selection

Every relation contains exactly `id`, `source`, `columns`, `date_column`, `available_start`, and `available_end`; Iceberg additionally requires `metadata_sha256`. PostgreSQL `source` is one plain table/view name within the frozen endpoint schema. Each column has `name` and `type`, chosen from `DATE`, `VARCHAR`, `BIGINT`, `DOUBLE`, and `BOOLEAN`. Duplicate names and structured types fail. Only these reviewed columns are selected; privacy approval of the curated projection remains the reviewer's responsibility.

The date column must be a selected `DATE`. Requests use strict `YYYY-MM-DD`, a positive half-open interval `[start, end)`, the configured maximum duration, and the relation's declared availability interval. Generated SQL has an explicit column projection, both date bounds as parameters, and a `LIMIT max_rows + 1` overflow sentinel. It accepts no caller-supplied SQL, arbitrary expressions, joins, filters, or source overrides.

## Synthetic adapter and local policy handoff

`PreparedSelection` is a frozen value with the contract digest, extension hashes, credential **references**, selected columns, date window, SQL, and initialization templates. `${env:NAME}` tokens in those templates are deliberately unbound and are **not executable SQL**. No implementation here substitutes secrets into SQL. A future deployment adapter must verify the engine's private binding behavior before implementing that step.

`materialize_synthetic(plan, connection, destination)` accepts a supplied fixture connection implementing `initialize_preview(statements)` and `execute_selection(sql, parameters)`. The first records templates only; the second returns a DB-API cursor over synthetic/local fixture data. This trusted Python protocol is an integration seam, not a security sandbox or evidence that an arbitrary supplied connection is local. There is no production implementation of that protocol.

The adapter creates a new local DuckDB file with external access and automatic extension installation/loading disabled. It verifies exact output column order, scalar types, finite doubles, date-window membership, row count, and total canonical JSON row bytes. It fetches bounded batches, rejects overflow rather than publishing a silently truncated selection, and checks cancellation between operations. Staging is discarded on failure. Publication uses atomic create-if-absent semantics and never overwrites an existing destination. A cleanup failure is reported explicitly, including whether publication already occurred.

Successful output is one table at `main.<relation_id>` and a `SYNTHETIC_REPLICA_ONLY` receipt with measured rows/logical bytes and an ordered row digest. Row order is source-dependent; the digest describes observed order rather than claiming deterministic remote ordering. `max_bytes` bounds logical output, not database file size, source scans, driver allocation, or network transfer. Fetch cancellation is cooperative and cannot preempt a blocked driver call.

An integration owner can register the resulting completed local file as a read-only attachment in a separately reviewed existing DuckDB contract. Its allowlisted relation is then `<attachment>.main.<relation_id>`, with the date column retained for local partition-policy checks. This module does not edit or automatically activate the DuckDB worker, contract, or policy. Synthetic tests exercise that local policy/read-only attachment handoff using real installed DuckDB and sqlglot modules.

## Tests and evidence limits

Run with the already prepared capability interpreter, without dependency installation:

```text
<prepared-python> -B tests/python/test_connectors.py -v
```

Fixtures contain invented credentials, `.invalid` endpoints, dummy extension bytes, and in-memory local source data. PostgreSQL-shaped selection SQL runs against a local fixture catalog. For Iceberg, the fixture records the proposed scan SQL and explicitly substitutes its local table; it does not execute `iceberg_scan` or load an extension. Receipts keep remote pushdown, remote resource limits, and extension ABI as `NOT_MEASURED`, and remote metadata hashes as `NOT_VERIFIED`.

## Required deployment gate

Do not connect this preparation path to real endpoints until a separately reviewed integration provides:

1. Independently approved contract/endpoint identities; trusted extension acquisition, signatures, exact platform/engine compatibility, successful ABI load tests, and replacement/TOCTOU protection through load time.
2. Verified TLS trust and endpoint resolution, credential isolation and rotation, a server-enforced read-only PostgreSQL role or narrowly scoped S3 permissions, and tested prevention of credential leakage through driver errors/logging.
3. Iceberg metadata digest verification, snapshot consistency, and allowlisting of every referenced metadata/data object, redirect, and actual network destination; prefix spelling alone is insufficient.
4. Controlled-service tests of partition pruning/pushdown and observed server/object-store work, connection/concurrency admission, deadlines, cancellation/kill behavior, output bounds, and cleanup across independent processes.
5. Source schema/type/privacy review, local replica publication/retention ownership, and equivalent approved contract behavior across the intended FastAPI/OpenCode consumers.

The synthetic implementation establishes preparation and local transfer behavior only. It does not complete operational M3, prove cheap remote scans, or authorize production activation.

# Optional DuckDB developer query plane (rollout 1–3)

Stable OpenCode v1 (`engines.opencode >=1.18.0`) remains the supported daily driver. OpenCode2 is not imported, installed, configured, tested, or required. This operational query plane is not an ALG core tool and is absent from the exact 15-tool ALG registry. It is also separate from any future experience catalog.

The capability is disabled by default. Package install/update, normal OpenCode startup, and `status`/`doctor` do not install Python packages, download or load extensions, open DuckDB, attach replicas, or contact a network. `capabilities/duckdb/opencode.disabled.json` is a schema-declared reference only; it is not loaded by the package.

## Prepare once, then opt in

Preparation is the only dependency download phase. Put the environment outside the immutable checkout or installed package. From a reviewed checkout, for example on POSIX:

```sh
cd capabilities/duckdb
UV_PROJECT_ENVIRONMENT=/absolute/private/alg-duckdb-env uv sync --frozen --no-dev
```

`pyproject.toml` pins DuckDB `1.4.0` and sqlglot `27.14.0` with `==`; `uv.lock` pins the complete artifact inventory and hashes. Normal query startup invokes that prepared interpreter and the local `wrapper.py` directly. It never invokes `uv`, `uvx`, `pip`, npm, `INSTALL`, or an extension loader. Contract v1 requires an exactly empty extension inventory and verifies automatic extension installation/loading and unsigned extensions are disabled.

Copy `contract.example.json` to an ignored/private path. The committed example has no attachment, endpoint, path, DSN, username, or credential. For each deployment replica, add a strict attachment like:

```json
{
  "alias": "repo",
  "source_env": "ALG_DUCKDB_REPO_REPLICA",
  "format": "duckdb",
  "read_only": true
}
```

Set that environment variable to an existing absolute, direct regular DuckDB replica file. V1 does not accept URLs or DSNs as attachment values. Add only exact three-part relations such as `repo.analytics.events` to `allowed_relations`. Map a protected relation to **all** partition columns that every alias must constrain directly in its own query block and on every `OR` path.

Recompute `contract_sha256` as SHA-256 over `b"alg-duckdb-contract-v1\0" + canonical_json(contract)`, where canonical JSON is UTF-8, sorted-key, compact JSON. Then run the runtime preflight explicitly:

```sh
/absolute/prepared/python capabilities/duckdb/wrapper.py --preflight --contract /private/contract.json --hash HASH
bun run duckdb -- enable --project /project --python /absolute/prepared/python --contract /private/contract.json
```

Preflight runs in a disposable child and verifies the exact contract hash, engine/parser versions, empty extension inventory, attachment aliases/read-only opens, and effective memory/thread/temp/security settings. Enable itself is offline: it checks regular files and the canonical contract hash, then transactionally publishes `mcp.alg_duckdb`, the packaged skill at `.opencode/skills/duckdb-lake/SKILL.md`, and `.opencode/alg-duckdb.receipt.json` in the target project. The receipt binds the exact entry, skill hash, wrapper hash, and interpreter hash. JSONC comments, encoding, and unrelated entries are preserved. Existing same-shape entries without a matching receipt are custom, and are never adopted automatically. Config, receipt, and skill publication use the shared identity-and-byte compare-and-swap with rollback; concurrent changes fail closed. Backups may remain for manual recovery.

On PowerShell, set `$env:UV_PROJECT_ENVIRONMENT='C:/private/alg-duckdb-env'` before `uv sync --frozen --no-dev`. Pass the environment's absolute `Scripts/python.exe` to enable. The lifecycle rejects interpreters located inside the package tree. It does not create or delete environments, and offline doctor does not establish dependency or runtime compatibility; the explicit preflight remains required.

The server ID is `alg_duckdb` and the raw MCP tool name is `query`, giving the intended OpenCode name `alg_duckdb_query`. Synthetic lifecycle tests establish target skill installation and ownership, not supported-V1 host registration.

Quit and restart OpenCode after enable. Agent/plugin/skill/config files are loaded only at startup.

## Status, doctor, disable, and uninstall

```sh
bun run duckdb -- status --project /project
bun run duckdb -- doctor --project /project
bun run duckdb -- disable --project /project
bun run duckdb -- uninstall --project /project
```

- `status` reads project config, ownership receipt, and installed skill, and reports configured/managed/enabled state without opening the configured interpreter, wrapper, or data source.
- `doctor` additionally checks regular files, the receipt's wrapper/interpreter hashes, and the canonical contract hash. Use explicit wrapper `--preflight` when runtime/attachment verification is wanted.
- `disable` retains the reviewed entry but sets `enabled:false`; restart OpenCode afterward.
- `uninstall` removes the exact receipt-owned config entry, skill file, and receipt together. It preserves custom/drifted entries and skills for manual review; empty directories and backups may remain.

After uninstall, remove the external prepared environment, private contract, staged replica, and any crash-left temp directory yourself, and unset `ALG_DUCKDB_*` variables. No lifecycle command removes private data or credentials.

The CLI can also be invoked with a dependency-ready Node/tsx installation using its script path; it does not bootstrap package dependencies. Extracted-package lifecycle and immutable historical manager rollback tests remain separate integration work.

## Verification evidence

The current successful release format is schema 6 with sixteen command IDs declared in `RELEASE_COMMAND_IDS`. Command semantics and deadlines are keyed by ID. A failed aggregate run retains a separate bounded `release-failed-*.json` record with release-input identity, command diagnostics, deadline/exit/signal information, and cleanup errors; it is never accepted as successful release evidence. Command timeouts and output overflow attempt process-tree termination and report unconfirmed cleanup. The live-check wrapper reports its original runtime error and evidence location even when failure-artifact validation also fails.

Lifecycle and command-supervision regression tests use synthetic local fixtures. They do not establish live OpenCode interoperability, external-service access, prepared-environment dependency identity, or full release readiness. The aggregate gate includes live verification and must not be run under a synthetic-only verification policy.

## SQL and execution boundary

The tool accepts exactly one parser/AST-validated `SELECT`, `WITH ... SELECT`, plain `EXPLAIN SELECT`, or separately classified `EXPLAIN ANALYZE SELECT`. SHOW/DESCRIBE and every unreviewed AST/function node fail closed. Physical relations require exact `catalog.schema.relation` qualification. CTEs, nested subqueries, joins, quoted identifiers, self-joins, and OR predicates are checked by scope; every required partition column must have an alias-qualified literal predicate on every OR branch. `LIMIT` is output control only.

Writes, DDL, ATTACH/DETACH, COPY/EXPORT/IMPORT, INSTALL/LOAD, PRAGMA/SET, secrets/settings, query-evaluation functions, URLs, arbitrary table/replacement/filesystem/network functions, recursive CTEs, multiple statements, and unknown syntax are rejected recursively. Direct references to configured sensitive columns are rejected; star results are also redacted by output name.

Every accepted statement—including plain EXPLAIN—is reparsed by DuckDB and run in a disposable child with a minimal environment. The parent enforces wall-clock timeout and process-tree cancellation. DuckDB enforces contract memory, thread, temporary-directory, and temporary-size settings. Rows, total serialized characters, worker bytes, diagnostics, and MCP request bytes are bounded; declared environment values and credential-shaped diagnostics are redacted. Plain EXPLAIN does not execute the underlying SELECT. EXPLAIN ANALYZE has the same execution classification and controls as SELECT.

`DuckDBQueryAdapter(contract_path, expected_hash)` is the independent library/FastAPI entrypoint and offers `execute`, `execute_async`, and process-backed `compatibility`. OpenCode and FastAPI load and verify the same versioned contract bytes/hash but never share a DuckDB process or connection.

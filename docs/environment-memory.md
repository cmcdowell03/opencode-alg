# Environment memory

Environment memory is an optional, local evidence graph for reviewed environment
facts: machines, pods, networks, routes, APIs, repositories, deployments,
databases, datasets, principals, and credential-provider references. It keeps
observations and their scope/provenance so a later task can recover a bounded
view after restart or compaction. It does not discover or connect to
environments automatically.

## Enablement

It is off by default. Add the strict `environmentMemory` object to the ALG server
plugin options and restart OpenCode:

```jsonc
{
  "plugin": [["opencode-alg", {
    "environmentMemory": {
      "mode": "assist",
      "namespace": "demo-environment",
      "project": "demo-project",
      "databasePath": "C:/projects/demo/.opencode/environment-memory/demo.sqlite",
      "rootIds": ["workstation"],
      "contextByteBudget": 1024
    }
  }]]
}
```

The database path must be absolute. An enabled mode requires an explicit
namespace, database path, and at least one root ID. `project` selects the
project scope and defaults to OpenCode's current project ID when omitted.
Unknown option names fail configuration validation.

| Mode | Behavior |
|---|---|
| `off` (default) | Does not open SQLite or create environment-memory storage. |
| `observe` | Exposes scoped diagnostics through the existing read-only memory/status tools; adds no environment facts to model context. |
| `assist` | Also appends a byte-bounded, visibly untrusted view of configured roots to task and compaction context. |

The existing `sessionMemory` and skill-evolution options remain separate. This
feature does not add tool IDs; `alg_memory_search`, `alg_memory_read`, and
`alg_context_status` expose bounded environment-memory results when explicitly
enabled. The exact public tool registry remains unchanged.

## Import reviewed facts

Create a strict JSON file containing reviewed structured operations. The example
below uses synthetic names and values; use references, never credential values,
tokens, bearer URLs, or environment dumps.

```json
{
  "operations": [
    {
      "idempotency_key": "demo-host-v1",
      "operation": {
        "type": "upsert_entity",
        "entity": {
          "id": "workstation",
          "kind": "host",
          "label": "Synthetic workstation",
          "metadata": {"platform": "synthetic"},
          "scope": {"namespace": "demo-environment", "project": "demo-project", "visibility": "project", "owner": null},
          "provenance": {"source_type": "operator", "source_ref": "review:demo-001", "classification": "declared", "observed_at": "2020-01-01T00:00:00Z", "verified_at": null, "expires_at": null}
        }
      }
    },
    {
      "idempotency_key": "demo-api-v1",
      "operation": {
        "type": "upsert_entity",
        "entity": {
          "id": "catalog-api",
          "kind": "api",
          "label": "Synthetic catalog API",
          "metadata": {"protocol": "https", "credential_provider_ref": "demo-secret-provider"},
          "scope": {"namespace": "demo-environment", "project": "demo-project", "visibility": "project", "owner": null},
          "provenance": {"source_type": "operator", "source_ref": "review:demo-001", "classification": "declared", "observed_at": "2020-01-01T00:00:00Z", "verified_at": null, "expires_at": null}
        }
      }
    },
    {
      "idempotency_key": "demo-route-v1",
      "operation": {
        "type": "upsert_relation",
        "relation": {
          "id": "workstation-reaches-catalog",
          "source_id": "workstation",
          "target_id": "catalog-api",
          "kind": "reaches",
          "scope": {"namespace": "demo-environment", "project": "demo-project", "visibility": "project", "owner": null},
          "provenance": {"source_type": "operator", "source_ref": "review:demo-001", "classification": "observed", "observed_at": "2020-01-01T00:00:00Z", "verified_at": "2020-01-01T00:00:00Z", "expires_at": "2030-01-01T00:00:00Z"},
          "conditions": {"principal_ref": "demo-reader", "restrictions": ["read-only"], "valid_from": null, "valid_until": null}
        }
      }
    }
  ]
}
```

Run explicit local operations from the project directory:

```powershell
bun run environment-memory init D:/projects/demo/.opencode/environment-memory/demo.sqlite demo-environment
bun run environment-memory import D:/projects/demo/.opencode/environment-memory/demo.sqlite demo-environment D:/review/environment-ops.json
bun run environment-memory status D:/projects/demo/.opencode/environment-memory/demo.sqlite demo-environment
bun run environment-memory query D:/projects/demo/.opencode/environment-memory/demo.sqlite demo-environment demo-project ses_example workstation
bun run environment-memory snapshot D:/projects/demo/.opencode/environment-memory/demo.sqlite demo-environment > D:/review/environment-snapshot.json
```

Imports are limited to 1 MiB and 512 operations. Each entry has an explicit
idempotency key. The engine validates each operation and commits it with an
expected revision; a conflict stops the import with an error, leaving earlier
successful entries committed and safe to retry by key. The CLI does not scan
machines, routes, endpoints, source trees, or credentials.

## Scope, freshness, and authority

Every record names its namespace and project and is either project-visible or
session-private to one owner. Reads and traversal filter by both. Keep namespace
and project identifiers stable for the intended sharing boundary; a path or
hostname is not a portable identity. Provenance records source reference,
classification (`declared`, `observed`, `inferred`, or `unknown`), observation
time, optional verification time, and optional expiry. Expired facts are omitted
from reads; query results expose stale, missing, and omitted counts.

Reachability, authentication, and authorization are different relation kinds.
A `reaches` edge does not mean a caller authenticated; `authenticates-as` does
not mean that principal has a needed privilege; `authorized-for` is still stored
evidence and never grants permission. Relation context preserves the principal
reference and restrictions. Host tools and their permission checks remain the
action boundary. Suspected credential content is rejected; keep only
credential-provider references.

Revocation appends an immutable event and removes the record from the current
projection. Existing snapshots or stale context are not permission sources;
query again to obtain the current view. An idempotency key cannot be reused for a
different operation. Use a new explicit observation and key when updating a
fact.

## Local durability and replication

The embedded SQLite database is authoritative for local reads. WAL mode and
`synchronous=FULL` make a successful local transaction a SQLite commit on the
chosen filesystem. Store it on durable local storage; a commit on an ephemeral
pod disk does not survive loss of that disk. Do not place a mutable SQLite file
on an S3 mount. One logical writer per namespace is supported. Concurrent local
connections serialize through SQLite and expected-revision checks; independent
writable replicas are not merged automatically.

Optional replication stores content-addressed canonical snapshots and event
batches, then advances a conditional manifest. The manifest is the remote commit
point. Receipts distinguish local commitment from the highest remotely
replicated revision and pending lag. Uploaded but unreferenced objects do not
count as committed replication. Snapshot restore requires an empty destination;
snapshots preserve live/revoked identities and committed idempotency receipts so
restore cannot reuse old IDs or retry keys. Remote restore verifies all
referenced hashes and the journal chain before atomically restoring and replaying.
Hashes detect corruption, but do not authenticate the publisher.

Local-directory replication is useful for synthetic recovery checks:

```powershell
bun run environment-memory replicate D:/projects/demo/.opencode/environment-memory/demo.sqlite demo-environment local D:/backup/demo-environment
bun run environment-memory restore-remote D:/recovery/demo.sqlite demo-environment local D:/backup/demo-environment
```

S3 can be selected explicitly with a bucket, region, and prefix. The AWS SDK
uses its standard external credential provider chain; secrets are not CLI
arguments or stored in memory:

```powershell
bun run environment-memory replicate D:/projects/demo/.opencode/environment-memory/demo.sqlite demo-environment s3 example-bucket us-east-1 alg/demo-environment
```

The repository's synthetic tests use local storage and injected transports; no
live bucket or production S3 behavior is implied by those results.

## Capacity and measurement

The core bounds individual records to 64 KiB, snapshots to 16 MiB, event batches
to 512, graph traversal to depth 8, and query output to 256 entities. Defaults
are depth 3, 64 query nodes, and 512 LRU entries (maximum 8,192). Capacity
errors are explicit. Committed evidence is not silently evicted; the current
version has no history-retention or compaction policy, and the SQLite file can
continue to grow.

Run the deterministic synthetic harness with bounded settings:

```powershell
bun run environment-memory:benchmark --seed=7 --events=1000 --graph-size=256 --restart-frequency=100
```

It reports the local source revision and configured run, operation/query/recovery
latencies, memory/storage observations, replication lag, and invalid route or
permission claims. A short run is only a short synthetic measurement, not a
24-hour/72-hour endurance result. Longer runs must be executed for their actual
duration before making such claims.

Embeddings/LanceDB, Parquet/Arrow, Rust acceleration, multiple writable replicas,
and automatic environment discovery are deferred. Consider optimizations only
after a reproducible retrieval evaluation, archive-scale need, or profile shows
a material bottleneck.
